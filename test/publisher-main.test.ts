import { after, afterEach, before, beforeEach, test } from 'node:test';
import assert from 'node:assert/strict';
import { createHmac, generateKeyPairSync } from 'node:crypto';
import { createServer } from 'node:http';
import type { Server } from 'node:http';
import { once } from 'node:events';
import type { AddressInfo } from 'node:net';
import { DiscordRejected } from '../src/contracts.js';
import type { PublisherConfig } from '../src/config.js';
import type { DiscordApi } from '../src/discord-protocol.js';
import { FOUNDATION_COMMANDS } from '../src/commands.js';
import { startPublisher } from '../src/main.js';
import type { Publisher } from '../src/main.js';
import { loadRuntimePolicy } from '../src/policy.js';
import { FakeGateway, until } from './fake-gateway.js';
import { localDatabase } from './helpers.js';

// 게시 서버 진입점 배선 시험(local_integration). 실제 Discord·Grafana·Argo CD·클러스터에는 연결하지 않는다.
// Gateway는 loopback 가짜 서버, Discord REST는 메모리 대역, 그 밖 HTTP(Argo CD·healthchecks·작업자)는 loopback 가짜 서버다.
const GUILD = 'fixture-guild', CHAT = 'fixture-chat', NOTIFY = 'fixture-notifications', OWNER = 'fixture-owner';
const REVIEW = { repositories: [{ id: 101, fullName: 'fixture-org/fixture-repo', installationId: 501, visibility: 'public' }],
  allowedBotAuthorIds: [], commentCommand: null, reviewDrafts: false, rereviewOnBaseMove: null, comparison: 'merge_base',
  reviewSince: 0, internalMarkers: [], input: { maxFiles: 20, maxFileBytes: 100_000, maxDiffBytes: 200_000, maxArchiveBytes: 1_000_000, maxBodyChars: 4000 },
  publish: null, reconcile: { maxPages: 1, maxReviewsPerRun: 1 } };
class FakeRest implements DiscordApi {
  calls: { method: string; path: string; body?: unknown }[] = [];
  channels = new Map<string, { id: string; type: number; guild_id: string; parent_id?: string }>([
    [CHAT, { id: CHAT, type: 0, guild_id: GUILD }], [NOTIFY, { id: NOTIFY, type: 0, guild_id: GUILD }],
    ['fixture-thread', { id: 'fixture-thread', type: 11, guild_id: GUILD, parent_id: CHAT }]]);
  guildCommands: unknown[] = [];
  failCommandReads = 0;
  globalCommands: unknown[] = [{ name: 'task', type: 1, description: '이전 등록' }];
  private next = 0;
  async request(method: 'GET' | 'POST' | 'PUT', path: string, body?: unknown): Promise<unknown> {
    this.calls.push({ method, path, body });
    let m: RegExpMatchArray | null;
    if (method === 'GET' && (m = path.match(/^\/channels\/([^/?]+)$/))) {
      const channel = this.channels.get(decodeURIComponent(m[1]!));
      if (!channel) throw new DiscordRejected(404);
      return channel;
    }
    if (method === 'POST' && path.startsWith('/interactions/')) return undefined;
    if (method === 'POST' && (m = path.match(/^\/channels\/([^/]+)\/threads$/))) {
      const id = `fixture-new-thread-${++this.next}`;
      this.channels.set(id, { id, type: 11, guild_id: GUILD, parent_id: decodeURIComponent(m[1]!) });
      return { id };
    }
    if (method === 'POST' && /^\/channels\/[^/]+\/messages$/.test(path)) return { id: `fixture-message-${++this.next}` };
    if (method === 'GET' && /^\/channels\/[^/]+\/messages\?/.test(path)) return [];
    if (method === 'GET' && /\/threads\/(active|archived\/public)/.test(path)) return { threads: [] };
    if (path === `/applications/fixture-app/guilds/${GUILD}/commands`) {
      if (method === 'GET' && this.failCommandReads > 0) { this.failCommandReads--; throw new Error('discord_request_failed'); }
      if (method === 'PUT') { this.guildCommands = body as unknown[]; return this.guildCommands; }
      return this.guildCommands;
    }
    if (path === '/applications/fixture-app/commands') {
      if (method === 'PUT') { this.globalCommands = body as unknown[]; return this.globalCommands; }
      return this.globalCommands;
    }
    throw new Error(`unexpected_${method}_${path}`);
  }
}
let database: Awaited<ReturnType<typeof localDatabase>>;
let gw: FakeGateway;
let aux: Server;
let auxBase: string;
let auxCalls: string[];
let rest: FakeRest;
let publisher: Publisher | undefined;
before(async () => {
  database = await localDatabase();
  aux = createServer((req, res) => {
    auxCalls.push(`${req.method} ${req.url} ${req.headers.authorization ?? ''}`);
    if (req.url === '/ping') { res.writeHead(200).end('OK'); return; }
    if (req.url === '/api/v1/applications/homelab-bot') {
      res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ metadata: { name: 'homelab-bot' },
        status: { health: { status: 'Healthy' }, sync: { status: 'Synced' } } }));
      return;
    }
    // 작업자 대역: 실행 전 거부(모델 호출 없음).
    res.writeHead(403, { 'content-type': 'application/json' }).end(JSON.stringify({ status: 'rejected', started: false }));
  });
  aux.listen(0, '127.0.0.1'); await once(aux, 'listening');
  auxBase = `http://127.0.0.1:${(aux.address() as AddressInfo).port}`;
});
after(async () => { aux.closeAllConnections(); aux.close(); await database.pg.close(); });
beforeEach(async () => {
  const tables = (await database.pg.query<{ tablename: string }>(
    "SELECT tablename FROM pg_tables WHERE schemaname='public' AND tablename<>'schema_migrations'")).rows.map(r => r.tablename);
  await database.pg.exec(`TRUNCATE ${tables.join(',')} RESTART IDENTITY CASCADE`);
  gw = new FakeGateway(); await gw.start();
  rest = new FakeRest(); auxCalls = [];
});
afterEach(async () => { await publisher?.stop(); publisher = undefined; await gw.close(); });

const SECRET = 'fixture-webhook-secret-value';
async function boot(options: { heartbeatEveryMs?: number; gateway?: boolean } = {}) {
  const config: PublisherConfig = {
    databaseUrl: 'postgresql://unused', discordToken: 'fixture-discord-token',
    policy: loadRuntimePolicy(JSON.stringify({ revision: 'fixture-v1', owner: OWNER, guild: GUILD, conversationChannel: CHAT,
      notificationChannel: NOTIFY, dmEnabled: false, services: ['homelab-bot'], review: REVIEW }), Date.now()),
    grafana: { url: auxBase, token: 'fixture-grafana-token' }, argocd: { url: auxBase, token: 'fixture-argocd-token' },
    kubernetes: { url: auxBase }, workerUrl: `${auxBase}/`, healthchecksUrl: `${auxBase}/ping`,
    workerKey: generateKeyPairSync('ed25519').privateKey, githubWebhookSecret: SECRET,
  };
  publisher = await startPublisher(config, { db: database.db, discord: rest, gatewayUrl: options.gateway === false ? () => new Promise(() => {}) : async () => ({ url: gw.url }),
    allowGatewayUrl: url => url.hostname === '127.0.0.1', serviceAccount: { tokenFile: '/nonexistent', caFile: null },
    ports: { app: 0, alerts: 0 }, idleMs: 20, registerDelaysMs: [0, 20, 20], heartbeatEveryMs: options.heartbeatEveryMs ?? 60_000, stopTimeoutMs: 3000, log: () => {} });
  return publisher;
}
const app = (p: Publisher, path: string, init?: RequestInit) => fetch(`http://127.0.0.1:${p.ports.app}${path}`, init);
const ready = () => until(() => rest.calls.some(c => c.method === 'GET' && c.path.endsWith('/commands')));
const interaction = (id: string, name: string, options: Record<string, string> = {}, channel = CHAT) => ({
  id, token: `fixture-token-${id}`, type: 2, channel_id: channel, guild_id: GUILD, member: { user: { id: OWNER } },
  data: { name, options: Object.entries(options).map(([key, value]) => ({ name: key, value })) } });
const count = async (table: string) => Number((await database.db.query<{ count: string }>(`SELECT count(*) FROM ${table}`)).rows[0]!.count);

test('T16b 진입점 8080: /readyz 200·/metrics, 그 밖 404, /github은 리뷰 정책이 있어도 리뷰 비활성(202 review_disabled)·서명 틀림 401', async () => {
  const p = await boot();
  assert.equal((await app(p, '/readyz')).status, 200);
  assert.match(await (await app(p, '/metrics')).text(), /^homelab_bot_gateway_connected [01]$/m);
  for (const [path, method] of [['/', 'GET'], ['/other', 'POST'], ['/github', 'GET'], ['/github/', 'POST'], ['/alerts', 'POST']]) {
    assert.equal((await app(p, path!, { method })).status, 404, `${method} ${path}`);
  }
  const body = JSON.stringify({ action: 'opened', number: 1 });
  const signature = `sha256=${createHmac('sha256', SECRET).update(body).digest('hex')}`;
  const headers = (sig: string, delivery: string) => ({ 'x-hub-signature-256': sig, 'x-github-delivery': delivery, 'x-github-event': 'pull_request',
    'content-type': 'application/json' });
  assert.equal((await app(p, '/github', { method: 'POST', body, headers: headers(`sha256=${'0'.repeat(64)}`, 'fixture-d1') })).status, 401);
  assert.equal(await count('github_deliveries'), 0);
  assert.equal((await app(p, '/github', { method: 'POST', body, headers: headers(signature, 'fixture-d2') })).status, 202);
  const row = (await database.db.query<{ outcome: string; reason: string }>('SELECT outcome,reason FROM github_deliveries')).rows[0]!;
  assert.deepEqual([row.outcome, row.reason], ['ignored', 'review_disabled']);
  assert.equal(await count('jobs'), 0);
});

test('T16b 진입점 8081: 경보 수신은 Discord 연결 전에도 저장, 그 밖 경로 404', async () => {
  // Gateway 주소 조회가 끝나지 않게 해 Discord가 붙지 않은 상태를 고정한다.
  const p = await boot({ gateway: false });
  const alert = { groupKey: 'fixture-group', status: 'firing', alerts: [{ fingerprint: 'f1', labels: { service: 'homelab-bot', severity: 'warning' } }] };
  const post = (path: string) => fetch(`http://127.0.0.1:${p.ports.alerts}${path}`, { method: 'POST', body: JSON.stringify(alert) });
  assert.equal((await post('/other')).status, 404);
  assert.equal((await post('/alerts')).status, 202);
  assert.equal(await count('incidents'), 1);
  const rows = (await database.db.query<{ state: string; idempotency_key: string }>('SELECT state,idempotency_key FROM outbox')).rows;
  assert.equal(rows.length, 1); assert.equal(rows[0]!.state, 'pending'); assert.match(rows[0]!.idempotency_key, /^incident:/);
  assert.equal(gw.connections.length, 0); assert.equal(rest.calls.length, 0);
});

test('T16b 진입점: READY 뒤 guild 명령을 FOUNDATION 12개로 맞추고 전역 명령은 비움, 같으면 다시 쓰지 않음', async () => {
  const p = await boot();
  await ready();
  await until(() => rest.calls.some(c => c.method === 'PUT' && c.path === '/applications/fixture-app/commands'));
  const names = (rest.guildCommands as { name: string }[]).map(c => c.name).sort();
  assert.deepEqual(names, [...FOUNDATION_COMMANDS].sort());
  for (const closed of ['task', 'review-status', 'review-resume', 'review-cancel']) assert.ok(!(names as string[]).includes(closed));
  assert.deepEqual(rest.globalCommands, []);
  assert.equal(p.gateway.state.connected, true);
  assert.match(await (await app(p, '/metrics')).text(), /^homelab_bot_gateway_connected 1$/m);
  // 새 IDENTIFY(다시 READY): 등록 내용이 같으면 PUT하지 않는다.
  const puts = rest.calls.filter(c => c.method === 'PUT').length;
  gw.latest.send({ op: 9, d: false });
  await until(() => rest.calls.filter(c => c.method === 'GET' && c.path === '/applications/fixture-app/commands').length === 2, 8000);
  assert.equal(rest.calls.filter(c => c.method === 'PUT').length, puts);
});

test('T16b 진입점: 명령 등록이 한 번 실패해도 다음 READY를 기다리지 않고 다시 시도', async () => {
  rest.failCommandReads = 1;
  await boot();
  await until(() => rest.calls.some(c => c.method === 'PUT' && c.path === `/applications/fixture-app/guilds/${GUILD}/commands`));
  assert.equal(rest.calls.filter(c => c.method === 'GET' && c.path === `/applications/fixture-app/guilds/${GUILD}/commands`).length, 2);
  assert.equal(gw.connections.length, 1);
});

test('T16b 진입점: /chat은 저장 뒤 ACK, /task·/review-status는 수신에서 닫혀 저장·ACK 없음', async () => {
  await boot();
  await ready();
  gw.dispatch(gw.latest, 2, 'INTERACTION_CREATE', interaction('9001', 'task', { text: '배포해' }));
  gw.dispatch(gw.latest, 3, 'INTERACTION_CREATE', interaction('9002', 'review-status', {}, NOTIFY));
  gw.dispatch(gw.latest, 4, 'INTERACTION_CREATE', interaction('9003', 'chat', { text: '상태 알려줘' }));
  await until(() => rest.calls.some(c => c.path.startsWith('/interactions/9003/')));
  assert.equal(await count('events'), 1);
  assert.ok(!rest.calls.some(c => c.path.startsWith('/interactions/9001/') || c.path.startsWith('/interactions/9002/')));
  const saved = (await database.db.query<{ payload: { command: string } }>('SELECT payload FROM events')).rows[0]!;
  assert.equal(saved.payload.command, 'chat');
});

test('READ-01 진입점 전체 경로: /read → 스레드 생성 → read 작업 → Argo CD transport → 결과 게시(모델 호출 없음)', async () => {
  await boot();
  await ready();
  gw.dispatch(gw.latest, 2, 'INTERACTION_CREATE', interaction('9101', 'read', { target: 'homelab-bot', text: 'homelab-bot-argocd' }));
  await until(() => rest.calls.some(c => c.method === 'POST' && /^\/channels\/fixture-new-thread-\d+\/messages$/.test(c.path)), 8000);
  const posted = rest.calls.find(c => c.method === 'POST' && /^\/channels\/fixture-new-thread-\d+\/messages$/.test(c.path))!;
  const content = (posted.body as { content: string }).content;
  assert.match(content, /대상: homelab-bot/); assert.match(content, /출처: homelab-bot-argocd/); assert.match(content, /사실: 상태: healthy/);
  assert.deepEqual((posted.body as { allowed_mentions: unknown }).allowed_mentions, { parse: [] });
  assert.ok(auxCalls.includes('GET /api/v1/applications/homelab-bot Bearer fixture-argocd-token'));
  assert.ok(!auxCalls.some(call => call.startsWith('POST /v1/execute')));
});

test('EVENT-03 진입점: 새 IDENTIFY(READY) 뒤 활성 스레드를 checkpoint 다음부터 history로 대조', async () => {
  const scope = { kind: 'thread', guild: GUILD, channel: 'fixture-thread', parent: CHAT };
  await database.db.query(`INSERT INTO conversations(id,owner_id,scope,channel_id,created_at,active,checkpoint)
    VALUES ($1,$2,$3,$4,$5,true,'100')`, [`thread:${GUILD}:fixture-thread`, OWNER, JSON.stringify(scope), 'fixture-thread', Date.now()]);
  await boot();
  await until(() => rest.calls.some(c => c.path === '/channels/fixture-thread/messages?limit=100&after=100'));
  // 빈 페이지면 대조가 끝나 gap과 복구 토큰을 푼다.
  const deadline = Date.now() + 4000;
  let row: { gap: boolean; recovery_token: string | null } | undefined;
  do {
    row = (await database.db.query<{ gap: boolean; recovery_token: string | null }>('SELECT gap,recovery_token FROM conversations')).rows[0];
    if (row && !row.gap && row.recovery_token === null) break;
    await new Promise(resolve => setTimeout(resolve, 10));
  } while (Date.now() < deadline);
  assert.deepEqual(row, { gap: false, recovery_token: null });
});

test('OPS-02 진입점: Gateway 연결·루프가 돌면 healthchecks ping, stop()은 수신기를 닫고 다시 연결하지 않음', async () => {
  const p = await boot({ heartbeatEveryMs: 20 });
  await ready();
  await until(() => auxCalls.some(call => call.startsWith('GET /ping')));
  await p.stop(); publisher = undefined;
  await assert.rejects(fetch(`http://127.0.0.1:${p.ports.app}/readyz`));
  const connections = gw.connections.length;
  await new Promise(resolve => setTimeout(resolve, 100));
  assert.equal(gw.connections.length, connections);
  assert.equal(gw.latest.closeCode, 1000);
});
