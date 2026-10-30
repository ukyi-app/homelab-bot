import { pathToFileURL } from 'node:url';
import { setTimeout as sleep } from 'node:timers/promises';
import type { Server } from 'node:http';
import pg from 'pg';
import { AlertIngress } from './alerts.js';
import { GRAFANA_DATASOURCES, SERVICES, TEMPLATES } from './catalog.js';
import { FOUNDATION_COMMANDS, registerCommands } from './commands.js';
import { ConfigError, databasePoolConfig, loadPublisherConfig } from './config.js';
import type { PublisherConfig } from './config.js';
import { Denied } from './contracts.js';
import type { Clock, Scope } from './contracts.js';
import { MIGRATIONS, Postgres, appliedMigrations, migrationVersion } from './database.js';
import type { Database } from './database.js';
import { DiscordIngress, DiscordPublisher } from './discord.js';
import { DiscordProtocol, discordHttpApi } from './discord-protocol.js';
import type { DiscordApi } from './discord-protocol.js';
import { GatewaySession, discordGatewayUrl } from './gateway.js';
import type { GatewaySocket } from './gateway.js';
import { GatewayBudget, Health } from './health.js';
import { PORTS, receivers } from './http.js';
import { errorInfo, jsonLog } from './log.js';
import type { Log } from './log.js';
import { PolicyGate } from './policy.js';
import { ReadAdapter } from './read.js';
import { SERVICE_ACCOUNT, argoCdTransport, grafanaTransport, kubernetesTransport, routedTransport } from './read-transports.js';
import { GitHubIngress, ReviewDisabled, ReviewPolicySource, ReviewQueue, githubWebhook } from './review.js';
import type { GitHubReader, ReviewContext } from './review.js';
import { Runtime } from './runtime.js';
import { Store } from './store.js';
import { WorkerSigner } from './worker.js';
import { HttpWorker } from './worker-http.js';

// 게시 서버 진입점(T16b S3). 이미지 기본 CMD는 node dist/src/main.js다. 마이그레이션은 src/migrate-main.ts(차트 migration.command).
// T17(리뷰 큐·게시)·T18(TaskLane)·T20(기억·브리핑 예약)은 연결하지 않는다. /github은 리뷰 비활성으로만 받는다(D6).

// 리뷰 정책이 정책 JSON에 있어도 T16b에서는 리뷰 경로를 열지 않는다. 기본 정책을 못 읽으면 503(PolicyUnavailable)이다.
class ReviewOff extends ReviewPolicySource {
  constructor(private readonly base: PolicyGate) { super(base); }
  override async current(): Promise<ReviewContext> { await this.base.current(); throw new ReviewDisabled(); }
}
const closedReader: GitHubReader = {
  pullRequest: async () => { throw new Error('review_disabled'); },
  openPullRequests: async () => { throw new Error('review_disabled'); },
  compare: async () => { throw new Error('review_disabled'); },
  mergeBase: async () => { throw new Error('review_disabled'); },
  reviews: async () => { throw new Error('review_disabled'); },
};

export interface PublisherDeps {
  db: Database;
  now?: Clock;
  log?: Log;
  send?: typeof fetch;
  discord?: DiscordApi;
  gatewayUrl?: () => Promise<{ url: string; retryAfterMs?: number }>;
  connect?: (url: string) => GatewaySocket;
  allowGatewayUrl?: (url: URL) => boolean;
  serviceAccount?: { tokenFile: string; caFile: string | null };
  ports?: { app: number; alerts: number };
  idleMs?: number;
  heartbeatEveryMs?: number;
  reconcileEveryMs?: number;
  stopTimeoutMs?: number;
}
export interface Publisher {
  health: Health; gateway: GatewaySession; ports: { app: number; alerts: number };
  stop(): Promise<void>;
}
const listen = (server: Server, port: number) => new Promise<number>((resolve, reject) => {
  server.once('error', reject);
  server.listen(port, () => { server.off('error', reject); resolve((server.address() as { port: number }).port); });
});
const closeServer = async (server: Server, timeoutMs: number) => {
  const closed = new Promise<void>(resolve => server.close(() => resolve()));
  server.closeIdleConnections();
  await Promise.race([closed, sleep(timeoutMs)]);
  server.closeAllConnections();
};

export async function startPublisher(config: PublisherConfig, deps: PublisherDeps): Promise<Publisher> {
  const now = deps.now ?? Date.now;
  const log = deps.log ?? jsonLog;
  const send = deps.send ?? fetch;
  const stop = new AbortController();
  const pause = (ms: number) => sleep(ms, undefined, { signal: stop.signal }).catch(() => {});
  const store = new Store(deps.db, now);
  const gate = PolicyGate.fixed(config.policy, deps.db, now);
  const health = new Health(store, async () => {
    // healthchecks.io ping. URL은 비밀(체크 UUID)이라 오류에도 남기지 않는다.
    const response = await send(config.healthchecksUrl, { method: 'GET', redirect: 'error', signal: AbortSignal.timeout(10_000) });
    await response.body?.cancel().catch(() => {});
    if (!response.ok) throw new Error(`heartbeat_http_${response.status}`);
  });
  const kubernetes = kubernetesTransport({ base: config.kubernetes.url, tokenFile: deps.serviceAccount?.tokenFile ?? SERVICE_ACCOUNT.token,
    caFile: deps.serviceAccount ? deps.serviceAccount.caFile : SERVICE_ACCOUNT.ca, send });
  const grafana = grafanaTransport({ base: config.grafana.url, token: config.grafana.token, datasources: GRAFANA_DATASOURCES, send });
  const reader = new ReadAdapter([...SERVICES], [...TEMPLATES], gate, routedTransport({ kubernetes,
    argocd: argoCdTransport({ base: config.argocd.url, token: config.argocd.token, send }),
    victoriametrics: grafana, victorialogs: grafana }), now);
  const runtime = new Runtime(store, gate, new HttpWorker(config.workerUrl, send), new WorkerSigner(config.workerKey, now), reader);
  const github = new GitHubIngress(config.githubWebhookSecret, store, new ReviewOff(gate), new ReviewQueue(store, closedReader), closedReader);
  const servers = receivers(health, new AlertIngress(store, gate), { github: githubWebhook(github) });
  const ports = { app: await listen(servers.app, deps.ports?.app ?? PORTS.publisher),
    alerts: await listen(servers.alerts, deps.ports?.alerts ?? PORTS.alerts) };

  // Discord 쪽은 첫 READY에서 봇 사용자 ID를 받은 뒤 만든다. 그 전에는 수신·게시를 하지 않는다(경보·webhook 수신은 계속).
  const api = deps.discord ?? discordHttpApi(config.discordToken, send, now);
  let discord: { ingress: DiscordIngress; publisher: DiscordPublisher } | undefined;
  let protocol: DiscordProtocol | undefined;
  const background = new Set<Promise<void>>();
  const track = (task: Promise<void>) => { background.add(task); void task.finally(() => background.delete(task)); };
  const loops: Promise<void>[] = [];
  const loop = (name: string, step: () => Promise<boolean>) => loops.push((async () => {
    while (!stop.signal.aborted) {
      try {
        const busy = await step();
        // 하트비트 조건(조율 루프가 최근 60초 안에 돎)은 DB까지 닿는 루프 한 바퀴로 잰다.
        health.loop();
        if (!busy) await pause(deps.idleMs ?? 500);
      } catch (error) {
        log(`${name}_failed`, errorInfo(error));
        await pause(1000);
      }
    }
  })());
  const recoverAll = async () => {
    const rows = (await deps.db.query<{ scope: Scope; owner_id: string }>(`SELECT scope,owner_id FROM conversations
      WHERE active=true AND scope->>'kind'<>'channel' ORDER BY created_at`)).rows;
    for (const row of rows) {
      if (stop.signal.aborted || !discord) return;
      try { await discord.ingress.recover(row.scope, row.owner_id); }
      catch (error) { log('recovery_failed', errorInfo(error)); }
    }
    log('recovery_done', { conversations: rows.length });
  };
  const gateway = new GatewaySession({
    token: config.discordToken,
    gatewayUrl: deps.gatewayUrl ?? discordGatewayUrl(api),
    budget: new GatewayBudget(store),
    health,
    log,
    connect: deps.connect,
    allowUrl: deps.allowGatewayUrl,
    dispatch: async (type, data) => {
      if (!discord || (type !== 'MESSAGE_CREATE' && type !== 'INTERACTION_CREATE')) return;
      try { await protocol!.gateway(type, data, discord.ingress); }
      catch (error) { if (!(error instanceof Denied)) log('discord_event_failed', { type, ...errorInfo(error) }); }
    },
    onReady: ready => {
      if (!discord) {
        protocol = new DiscordProtocol(api, ready.userId, now);
        discord = { ingress: new DiscordIngress(store, gate, protocol, true, new Set(FOUNDATION_COMMANDS)),
          publisher: new DiscordPublisher(store, gate, protocol) };
        const publisher = discord.publisher;
        let reconciled = 0;
        loop('publisher', async () => {
          if (now() - reconciled >= (deps.reconcileEveryMs ?? 30_000)) { reconciled = now(); await publisher.reconcile(); }
          return publisher.deliver();
        });
      }
      // 명령 등록·누락 대조는 이벤트 처리 순서 밖에서 돈다(대조가 30초까지 걸려도 상호작용 ACK가 밀리지 않게).
      track(registerCommands(api, ready.applicationId, config.policy.guild)
        .then(result => log('commands_registered', result), error => log('commands_register_failed', errorInfo(error))));
      track(recoverAll().catch(error => log('recovery_failed', errorInfo(error))));
    },
  });
  loop('runtime', () => runtime.tick());
  const heartbeat = setInterval(() => { health.heartbeat().catch(error => log('heartbeat_failed', errorInfo(error))); },
    deps.heartbeatEveryMs ?? 10_000);
  gateway.start();
  log('publisher_started', { ports, policyRevision: config.policy.revision, services: SERVICES.length });

  let stopped: Promise<void> | undefined;
  return { health, gateway, ports, stop: () => stopped ??= (async () => {
    const limit = deps.stopTimeoutMs ?? 20_000;
    stop.abort();
    clearInterval(heartbeat);
    await gateway.stop();
    await Promise.all([closeServer(servers.app, Math.min(5000, limit)), closeServer(servers.alerts, Math.min(5000, limit))]);
    // 진행 중인 작업 한 바퀴는 끝까지 기다린다(상한 안에서). 넘으면 lease 만료가 unknown으로 남긴다.
    await Promise.race([Promise.all([...loops, ...background]), sleep(limit)]);
    await kubernetes.close();
    log('publisher_stopped');
  })() };
}

async function main(): Promise<void> {
  const log = jsonLog;
  let config: PublisherConfig;
  try { config = loadPublisherConfig(process.env, Date.now()); }
  catch (error) {
    log('config_invalid', { problems: error instanceof ConfigError ? error.problems : ['unknown'] });
    process.exitCode = 1; return;
  }
  const pool = new pg.Pool(databasePoolConfig(config.databaseUrl));
  pool.on('error', error => log('database_pool_error', errorInfo(error)));
  const db = new Postgres(pool);
  try {
    const applied = await appliedMigrations(db);
    const missing = MIGRATIONS.map(migrationVersion).filter(version => !applied.has(version));
    if (missing.length) { log('schema_not_migrated', { missing }); await pool.end(); process.exitCode = 1; return; }
  } catch (error) { log('database_unavailable', errorInfo(error)); await pool.end().catch(() => {}); process.exitCode = 1; return; }
  const publisher = await startPublisher(config, { db, log });
  let shutting = false;
  const shutdown = (signal: string) => {
    if (shutting) return;
    shutting = true;
    log('shutdown', { signal });
    void publisher.stop().finally(async () => { await pool.end().catch(() => {}); process.exit(0); });
  };
  process.once('SIGTERM', () => shutdown('SIGTERM'));
  process.once('SIGINT', () => shutdown('SIGINT'));
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) void main();
