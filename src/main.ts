import { pathToFileURL } from 'node:url';
import { setTimeout as sleep } from 'node:timers/promises';
import type { Server } from 'node:http';
import pg from 'pg';
import { AlertIngress } from './alerts.js';
import { ARGOCD_APPLICATIONS, GRAFANA_DATASOURCES, SERVICES, TEMPLATES } from './catalog.js';
import { FOUNDATION_COMMANDS, registerCommands } from './commands.js';
import { ConfigError, databasePoolConfig, loadPublisherConfig } from './config.js';
import type { PublisherConfig } from './config.js';
import { z } from 'zod';
import { Denied, DiscordRejected, RateLimited } from './contracts.js';
import type { Clock, Scope } from './contracts.js';
import { MIGRATIONS, Postgres, appliedMigrations, migrationVersion } from './database.js';
import { withConnectRetry } from './db-connect.js';
import type { Database } from './database.js';
import { DiscordIngress, DiscordPublisher } from './discord.js';
import { DiscordProtocol, discordHttpApi } from './discord-protocol.js';
import type { DiscordApi } from './discord-protocol.js';
import { GatewaySession, discordGatewayUrl } from './gateway.js';
import type { GatewaySocket } from './gateway.js';
import { GatewayBudget, Health } from './health.js';
import { typingActivity } from './activity.js';
import { typingHints } from './typing.js';
import { PORTS, receivers } from './http.js';
import { errorInfo, jsonLog } from './log.js';
import type { Log } from './log.js';
import { PolicyGate } from './policy.js';
import { ReadAdapter } from './read.js';
import { SERVICE_ACCOUNT, grafanaTransport, kubernetesTransport, routedTransport } from './read-transports.js';
import { GitHubIngress, ReviewDisabled, ReviewPolicySource, ReviewQueue, githubWebhook } from './review.js';
import type { GitHubReader, ReviewContext } from './review.js';
import { RecoveryScheduler } from './recovery.js';
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
const MessageChannel = z.object({ channel_id: z.string().min(1) });
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
  drainMs?: number;
  registerDelaysMs?: readonly number[];
  recoveryBackoff?: (attempt: number) => number;
  identifySpacingMs?: number;
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
    caFile: deps.serviceAccount ? deps.serviceAccount.caFile : SERVICE_ACCOUNT.ca, applications: ARGOCD_APPLICATIONS, send });
  const grafana = grafanaTransport({ base: config.grafana.url, token: config.grafana.token, datasources: GRAFANA_DATASOURCES, send });
  // Argo CD 앱 상태도 Kubernetes API의 Application CR로 읽는다(D9). argocd-server(자체 서명 TLS)에는 닿지 않는다.
  const reader = new ReadAdapter([...SERVICES], [...TEMPLATES], gate, routedTransport({ kubernetes, argocd: kubernetes,
    victoriametrics: grafana, victorialogs: grafana }), now);
  // stop 신호가 곧 runtime의 종료 신호다. 새 claim을 멈추고 실행 중 작업의 드레인·취소 확인을 바로 시작한다.
  const runtime = new Runtime(store, gate, new HttpWorker(config.workerUrl, send), new WorkerSigner(config.workerKey, now), reader,
    undefined, { shutdown: stop.signal, drainMs: deps.drainMs });
  const github = new GitHubIngress(config.githubWebhookSecret, store, new ReviewOff(gate), new ReviewQueue(store, closedReader), closedReader);
  const servers = receivers(health, new AlertIngress(store, gate), { github: githubWebhook(github) });
  let ports: { app: number; alerts: number };
  try {
    ports = { app: await listen(servers.app, deps.ports?.app ?? PORTS.publisher),
      alerts: await listen(servers.alerts, deps.ports?.alerts ?? PORTS.alerts) };
  } catch (error) {
    // 한쪽만 열린 채 남으면 프로세스가 반쪽으로 살아 있다(이벤트 루프를 붙잡음). 연 것을 모두 닫고 다시 던진다.
    await Promise.all([closeServer(servers.app, 1000), closeServer(servers.alerts, 1000)]);
    await kubernetes.close();
    throw error;
  }

  // Discord 쪽은 첫 READY에서 봇 사용자 ID를 받은 뒤 만든다. 그 전에는 수신·게시를 하지 않는다(경보·webhook 수신은 계속).
  const api = deps.discord ?? discordHttpApi(config.discordToken, send, now);
  let discord: { ingress: DiscordIngress; publisher: DiscordPublisher } | undefined;
  let protocol: DiscordProtocol | undefined;
  let runtimeStarted = false;
  const background = new Set<Promise<void>>();
  const track = (task: Promise<void>) => { background.add(task); void task.finally(() => background.delete(task)); };
  const typingHint = typingHints(store, gate, log, track);
  const loops: Promise<void>[] = [];
  // alive: 이 루프의 한 바퀴가 성공했다는 것이 DB에 닿았다는 증거인지. 하트비트 조건(조율 루프가 최근 60초 안에 돎)은
  // 그런 루프로만 잰다. runtime(store.expire)·publisher(claimDelivery)는 늘 DB를 거친다. 복구 루프는 대기 항목이 없으면
  // DB 없이 끝나므로 생존 근거가 아니다(DB 장애 중에도 정상 ping이 나가지 않게, PR #12 재리뷰 4420612644).
  const loop = (name: string, step: () => Promise<boolean>, alive = true) => loops.push((async () => {
    while (!stop.signal.aborted) {
      try {
        const busy = await step();
        if (alive) health.loop();
        if (!busy) await pause(deps.idleMs ?? 500);
      } catch (error) {
        log(`${name}_failed`, errorInfo(error));
        await pause(1000);
      }
    }
  })());
  const recovery = new RecoveryScheduler(store, (scope: Scope, owner: string) => {
    if (!discord) throw new Error('discord_not_ready');
    return discord.ingress.recover(scope, owner);
  }, log, deps.recoveryBackoff);
  // 새 READY의 복구 장벽. live 이벤트는 이 처리 뒤에 차례로 들어오므로(Gateway 이벤트 순서) 장벽이 서기 전에 처리되지 않는다.
  // DB가 잠시 안 되면 장벽이 설 때까지 다시 시도한다(그동안 이벤트는 기다린다).
  const guard = async (channel: string) => {
    for (let attempt = 0; !stop.signal.aborted; attempt++) {
      try { log('recovery_guard', { conversations: await recovery.guard(channel) }); return; }
      catch (error) { log('recovery_guard_failed', errorInfo(error)); await pause(Math.min(30_000, 1000 * 2 ** Math.min(attempt, 5))); }
    }
  };
  const barrier = async () => {
    for (let attempt = 0; !stop.signal.aborted; attempt++) {
      try { log('recovery_barrier', { conversations: await recovery.barrier() }); return; }
      catch (error) { log('recovery_barrier_failed', errorInfo(error)); await pause(Math.min(30_000, 1000 * 2 ** Math.min(attempt, 5))); }
    }
  };
  // REST는 요청마다 1초 제한이라 등록이 한 번 실패할 수 있다. 다음 READY(며칠 뒤일 수도)까지 미루지 않고 몇 번 더 시도한다.
  let registering: string | undefined;
  const register = async (applicationId: string) => {
    if (registering === applicationId) return;
    registering = applicationId;
    try {
      for (const delay of deps.registerDelaysMs ?? [0, 5000, 30_000, 120_000, 300_000]) {
        if (delay) await pause(delay);
        if (stop.signal.aborted) return;
        try { log('commands_registered', await registerCommands(api, applicationId, config.policy.guild)); return; }
        catch (error) {
          log('commands_register_failed', errorInfo(error));
          if (error instanceof RateLimited) await pause(error.retryAfterMs);
        }
      }
    } finally { registering = undefined; }
  };
  const gateway = new GatewaySession({
    token: config.discordToken,
    gatewayUrl: deps.gatewayUrl ?? discordGatewayUrl(api),
    budget: new GatewayBudget(store, { spacingMs: deps.identifySpacingMs }),
    health,
    log,
    connect: deps.connect,
    allowUrl: deps.allowGatewayUrl,
    dispatch: async (type, data) => {
      // 입력 중 힌트. 기다리지 않고(뒤 이벤트를 막지 않게) 백그라운드로 돌린다. 오류를 스스로 삼키므로 guard로 가지 않는다.
      if (type === 'TYPING_START') { typingHint(data); return; }
      if (!discord || (type !== 'MESSAGE_CREATE' && type !== 'INTERACTION_CREATE')) return;
      try { await protocol!.gateway(type, data, discord.ingress); }
      catch (error) {
        // 확정 거부(권한·채널 종류, 잘못된 payload·입력, 채널 403/404)는 다시 해도 같다. 버린다.
        if (error instanceof Denied || error instanceof z.ZodError || error instanceof DiscordRejected) return;
        log('discord_event_failed', { type, ...errorInfo(error) });
        // 일시 장애(DB·REST·429·정책 확인 불가 등). 상호작용은 토큰이 3초라 되살릴 수 없고 checkpoint와도 무관하다.
        // 메시지는 그 대화에 장벽을 세워 history 대조로 메운다. 장벽이 설 때까지 다음 이벤트는 기다린다(순서 유지).
        const channel = MessageChannel.safeParse(data);
        if (type === 'MESSAGE_CREATE' && channel.success) await guard(channel.data.channel_id);
      }
    },
    onReady: async ready => {
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
        loop('recovery', () => recovery.runDue(), false);
        loop('typing', typingActivity(store, gate, api, log), false);
      }
      await barrier();
      // 작업 claim은 첫 장벽이 선 뒤에 시작한다. 재시작 때 남은 queued 작업이 중단 중 메시지를 history로 복구하기 전에
      // 이전 입력으로 모델을 부르지 않게 한다(PR #12 재리뷰 4420612638). 이후 READY의 장벽은 claim의 gap 조건이 막는다.
      // read는 모델 응답을 기다리지 않게 따로 돈다. 늘 DB를 거치므로 생존 근거다.
      if (!runtimeStarted && !stop.signal.aborted) {
        runtimeStarted = true;
        loop('runtime', () => runtime.tick());
        loop('read', () => runtime.tickRead());
      }
      // 명령 등록과 history 대조 자체는 이벤트 처리 순서 밖에서 돈다(대조가 30초까지 걸려도 상호작용 ACK가 밀리지 않게).
      track(register(ready.applicationId));
    },
  });
  health.watchGateway(() => gateway.state);
  const heartbeat = setInterval(() => { health.heartbeat().catch(error => log('heartbeat_failed', errorInfo(error))); },
    deps.heartbeatEveryMs ?? 10_000);
  gateway.start();
  log('publisher_started', { ports, policyRevision: config.policy.revision, services: SERVICES.length });

  let stopped: Promise<void> | undefined;
  return { health, gateway, ports, stop: () => stopped ??= (async () => {
    // 전체 종료 기한 하나(기본 20초, kubelet 유예 30초 안). 단계별 대기를 차례로 더하지 않고 남은 시간을 나눈다.
    // 최악: Gateway 정리(≤4초)·수신 서버(≤5초)는 runtime의 드레인(10초)+cancel(5초)과 동시에 돌아 기한 안에 끝난다.
    const deadline = Date.now() + (deps.stopTimeoutMs ?? 20_000);
    const left = () => Math.max(0, deadline - Date.now());
    stop.abort();
    clearInterval(heartbeat);
    await Promise.all([gateway.stop(Math.min(2000, left())),
      closeServer(servers.app, Math.min(5000, left())), closeServer(servers.alerts, Math.min(5000, left()))]);
    // 진행 중인 한 바퀴(드레인·취소 확인 포함)는 기한까지 기다린다. 넘으면 lease 만료가 unknown으로 남긴다.
    await Promise.race([Promise.all([...loops, ...background]), sleep(left())]);
    await Promise.race([kubernetes.close(), sleep(1000)]);
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
    const applied = await withConnectRetry(() => appliedMigrations(db), {
      onRetry: (attempt, error) => log('database_connect_retry', { attempt: String(attempt), ...errorInfo(error) }) });
    const missing = MIGRATIONS.map(migrationVersion).filter(version => !applied.has(version));
    if (missing.length) { log('schema_not_migrated', { missing }); await pool.end(); process.exitCode = 1; return; }
  } catch (error) { log('database_unavailable', errorInfo(error)); await pool.end().catch(() => {}); process.exitCode = 1; return; }
  let publisher: Publisher;
  try { publisher = await startPublisher(config, { db, log }); }
  catch (error) {
    log('publisher_start_failed', errorInfo(error));
    await pool.end().catch(() => {});
    process.exitCode = 1;
    // 열린 자원은 startPublisher가 닫는다. 그래도 무언가 남아 프로세스가 반쪽으로 살아 있지 않게 5초 뒤 끝낸다.
    setTimeout(() => process.exit(1), 5000).unref();
    return;
  }
  let shutting = false;
  const shutdown = (signal: string) => {
    if (shutting) return;
    shutting = true;
    log('shutdown', { signal });
    // 기한을 넘긴 작업이 연결을 쥐고 있으면 pool.end()가 끝나지 않는다. 오래 기다리지 않는다.
    void publisher.stop().finally(async () => { await Promise.race([pool.end().catch(() => {}), sleep(2000)]); process.exit(0); });
  };
  process.once('SIGTERM', () => shutdown('SIGTERM'));
  process.once('SIGINT', () => shutdown('SIGINT'));
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) void main();
