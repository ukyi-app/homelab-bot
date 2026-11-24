import { after, afterEach, before, beforeEach, test } from 'node:test';
import assert from 'node:assert/strict';
import { createHmac, generateKeyPairSync } from 'node:crypto';
import { createServer } from 'node:http';
import type { Server } from 'node:http';
import { once } from 'node:events';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DiscordRejected } from '../src/contracts.js';
import type { PublisherConfig } from '../src/config.js';
import type { Database } from '../src/database.js';
import type { DiscordApi } from '../src/discord-protocol.js';
import { FRONT_TEXT } from '../src/front-intake.js';
import { startPublisher } from '../src/main.js';
import type { Publisher } from '../src/main.js';
import { loadRuntimePolicy } from '../src/policy.js';
import { Store } from '../src/store.js';
import { FakeGateway, until } from './fake-gateway.js';
import { localDatabase, wireBody } from './helpers.js';

// 게시 서버 진입점 배선 시험(local_integration). 실제 Discord·Grafana·Argo CD·클러스터에는 연결하지 않는다.
// Gateway는 loopback 가짜 서버, Discord REST는 메모리 대역, 그 밖 HTTP(Kubernetes API·healthchecks·작업자)는 loopback 가짜 서버다.
// SA 토큰은 임시 파일이다(D9: Argo CD 앱 상태도 SA 토큰으로 Kubernetes API의 Application CR을 읽는다).
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
  // 채널 메타데이터 조회를 일시적으로 실패시킬 횟수(채널 ID별).
  failChannelReads = new Map<string, number>();
  // 스레드 history 응답. 기본은 빈 페이지.
  history: (channel: string, after: string) => Promise<unknown[]> = async () => [];
  globalCommands: unknown[] = [{ name: 'task', type: 1, description: '이전 등록' }];
  private next = 0;
  async request(method: 'GET' | 'POST' | 'PUT', path: string, body?: unknown): Promise<unknown> {
    this.calls.push({ method, path, body: wireBody(body) });
    let m: RegExpMatchArray | null;
    if (method === 'GET' && (m = path.match(/^\/channels\/([^/?]+)$/))) {
      const id = decodeURIComponent(m[1]!);
      const failures = this.failChannelReads.get(id) ?? 0;
      if (failures > 0) { this.failChannelReads.set(id, failures - 1); throw new Error('discord_request_failed'); }
      const channel = this.channels.get(id);
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
    if (method === 'GET' && (m = path.match(/^\/channels\/([^/]+)\/messages\?(.*)$/))) {
      return this.history(decodeURIComponent(m[1]!), new URLSearchParams(m[2]).get('after') ?? '0');
    }
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
let serviceAccountDir: string;
let rest: FakeRest;
let publisher: Publisher | undefined;
before(async () => {
  database = await localDatabase();
  serviceAccountDir = await mkdtemp(join(tmpdir(), 'homelab-bot-sa-'));
  await writeFile(join(serviceAccountDir, 'token'), 'fixture-sa-token\n');
  aux = createServer((req, res) => {
    auxCalls.push(`${req.method} ${req.url} ${req.headers.authorization ?? ''}`);
    if (req.url === '/ping') { res.writeHead(200).end('OK'); return; }
    if (req.url === '/apis/argoproj.io/v1alpha1/namespaces/argocd/applications/homelab-bot') {
      res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ apiVersion: 'argoproj.io/v1alpha1', kind: 'Application',
        metadata: { name: 'homelab-bot', namespace: 'argocd' }, status: { health: { status: 'Healthy' }, sync: { status: 'Synced' } } }));
      return;
    }
    // 작업자 대역: 실행 전 거부(모델 호출 없음).
    res.writeHead(403, { 'content-type': 'application/json' }).end(JSON.stringify({ status: 'rejected', started: false }));
  });
  aux.listen(0, '127.0.0.1'); await once(aux, 'listening');
  auxBase = `http://127.0.0.1:${(aux.address() as AddressInfo).port}`;
});
after(async () => {
  aux.closeAllConnections(); aux.close(); await database.pg.close();
  await rm(serviceAccountDir, { recursive: true, force: true });
});
beforeEach(async () => {
  const tables = (await database.pg.query<{ tablename: string }>(
    "SELECT tablename FROM pg_tables WHERE schemaname='public' AND tablename<>'schema_migrations'")).rows.map(r => r.tablename);
  await database.pg.exec(`TRUNCATE ${tables.join(',')} RESTART IDENTITY CASCADE`);
  // 시험 속도를 위해 IDENTIFY 간격을 줄인다(가짜 Gateway 250ms, 진입점 예산 spacing 250ms + 창·여유 500ms). 실제 값은 gateway 시험이 본다.
  gw = new FakeGateway(); gw.options.identifyIntervalMs = 250; await gw.start();
  rest = new FakeRest(); auxCalls = [];
});
afterEach(async () => { await publisher?.stop(); publisher = undefined; await gw.close(); assert.equal(gw.identifyViolations, 0); });

const SECRET = 'fixture-webhook-secret-value';
async function boot(options: { heartbeatEveryMs?: number; gateway?: boolean; ports?: { app: number; alerts: number }; db?: Database;
  now?: () => number; modelResumeTickMs?: number } = {}) {
  const config: PublisherConfig = {
    databaseUrl: 'postgresql://unused', discordToken: 'fixture-discord-token',
    policy: loadRuntimePolicy(JSON.stringify({ revision: 'fixture-v1', owner: OWNER, guild: GUILD, conversationChannel: CHAT,
      notificationChannel: NOTIFY, dmEnabled: false, services: ['homelab-bot'], review: REVIEW }), Date.now()),
    grafana: { url: auxBase, token: 'fixture-grafana-token' }, kubernetes: { url: auxBase }, workerUrl: `${auxBase}/`, healthchecksUrl: `${auxBase}/ping`,
    workerKey: generateKeyPairSync('ed25519').privateKey, githubWebhookSecret: SECRET,
  };
  publisher = await startPublisher(config, { db: options.db ?? database.db, now: options.now, discord: rest, gatewayUrl: options.gateway === false ? () => new Promise(() => {}) : async () => ({ url: gw.url }),
    allowGatewayUrl: url => url.hostname === '127.0.0.1', serviceAccount: { tokenFile: join(serviceAccountDir, 'token'), caFile: null },
    ports: options.ports ?? { app: 0, alerts: 0 }, idleMs: 20, identifySpacingMs: 250, recoveryBackoff: () => 200, registerDelaysMs: [0, 20, 20], heartbeatEveryMs: options.heartbeatEveryMs ?? 60_000, stopTimeoutMs: 3000, log: () => {},
    ...(options.modelResumeTickMs !== undefined ? { modelResumeTickMs: options.modelResumeTickMs } : {}) });
  return publisher;
}
const app = (p: Publisher, path: string, init?: RequestInit) => fetch(`http://127.0.0.1:${p.ports.app}${path}`, init);
const ready = () => until(() => rest.calls.some(c => c.method === 'GET' && c.path.endsWith('/commands')));
const interaction = (id: string, name: string, options: Record<string, string> = {}, channel = CHAT) => ({
  id, token: `fixture-token-${id}`, type: 2, channel_id: channel, guild_id: GUILD, member: { user: { id: OWNER } },
  data: { name, options: Object.entries(options).map(([key, value]) => ({ name: key, value })) } });
const message = (id: string, channel: string) => ({ id, channel_id: channel, guild_id: GUILD, author: { id: OWNER }, content: `fixture-message-${id}` });
async function thread(channel: string, checkpoint: string, order = 0) {
  rest.channels.set(channel, { id: channel, type: 11, guild_id: GUILD, parent_id: CHAT });
  const scope = { kind: 'thread', guild: GUILD, channel, parent: CHAT };
  await database.db.query(`INSERT INTO conversations(id,owner_id,scope,channel_id,created_at,active,checkpoint)
    VALUES ($1,$2,$3,$4,$5,true,$6)`, [`thread:${GUILD}:${channel}`, OWNER, JSON.stringify(scope), channel, 1_700_000_000_000 + order, checkpoint]);
}
async function waitFor(check: () => Promise<boolean>, timeoutMs = 6000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) { if (await check()) return true; await new Promise(resolve => setTimeout(resolve, 20)); }
  return check();
}
const conversation = async (channel: string) => (await database.db.query<{ checkpoint: string | null; gap: boolean; recovery_token: string | null }>(
  'SELECT checkpoint,gap,recovery_token FROM conversations WHERE channel_id=$1', [channel])).rows[0]!;
const event = async (id: string) => (await database.db.query<{ accepted: boolean; buffered: boolean }>(
  "SELECT accepted,buffered FROM events WHERE delivery_id=$1 AND provider='discord'", [id])).rows[0];
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

test('T16b 진입점(O08 F5): READY 뒤 guild·전역 명령을 모두 빈 목록으로 맞추고, 같으면 다시 쓰지 않음', async () => {
  rest.guildCommands = [{ name: 'chat', type: 1, description: '이전 등록' }, { name: 'emergency-stop', type: 1, description: '이전 등록' }];
  const p = await boot();
  await ready();
  await until(() => rest.calls.some(c => c.method === 'PUT' && c.path === '/applications/fixture-app/commands'));
  await until(() => rest.calls.some(c => c.method === 'PUT' && c.path === `/applications/fixture-app/guilds/${GUILD}/commands`));
  assert.deepEqual(rest.calls.filter(c => c.method === 'PUT').map(c => c.body), [[], []]);
  assert.deepEqual(rest.guildCommands, []);
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
  rest.guildCommands = [{ name: 'chat', type: 1, description: '이전 등록' }];
  rest.failCommandReads = 1;
  await boot();
  await until(() => rest.calls.some(c => c.method === 'PUT' && c.path === `/applications/fixture-app/guilds/${GUILD}/commands`));
  assert.equal(rest.calls.filter(c => c.method === 'GET' && c.path === `/applications/fixture-app/guilds/${GUILD}/commands`).length, 2);
  assert.deepEqual(rest.guildCommands, []);
  assert.equal(gw.connections.length, 1);
});


test('O08 F5 진입점: 상호작용은 저장·ACK 없이 닫히고, 관리자 멘션은 현관 고정 안내 답장이며 작업·모델 호출이 없다', async () => {
  await boot();
  await ready();
  gw.dispatch(gw.latest, 2, 'INTERACTION_CREATE', interaction('9001', 'task', { text: '배포해' }));
  gw.dispatch(gw.latest, 3, 'INTERACTION_CREATE', interaction('9002', 'review-status', {}, NOTIFY));
  gw.dispatch(gw.latest, 4, 'INTERACTION_CREATE', interaction('9003', 'chat', { text: '상태 알려줘' }));
  gw.dispatch(gw.latest, 5, 'INTERACTION_CREATE', { ...interaction('9004', 'list'), type: 3, data: { custom_id: 'list' } });
  const mention = (id: string, content: string) => ({ id, type: 0, channel_id: CHAT, guild_id: GUILD, author: { id: OWNER },
    content: `<@fixture-bot> ${content}`, mentions: [{ id: 'fixture-bot' }] });
  gw.dispatch(gw.latest, 6, 'MESSAGE_CREATE', mention('9005', '비상 정지 풀어 줘'));
  gw.dispatch(gw.latest, 7, 'MESSAGE_CREATE', mention('9006', '상태 알려줘'));
  // 전달 글(메시지 참조 FORWARD)은 관리자가 보냈어도 답하지 않는다.
  gw.dispatch(gw.latest, 8, 'MESSAGE_CREATE', { ...mention('9007', '계정 전환해'), message_reference: { type: 1, message_id: '9000', channel_id: CHAT },
    message_snapshots: [{ message: { content: '계정 전환해' } }] });
  const posts = () => rest.calls.filter(c => c.method === 'POST' && c.path === `/channels/${CHAT}/messages`);
  assert.ok(await waitFor(async () => posts().length >= 2, 8000), JSON.stringify(rest.calls.map(c => `${c.method} ${c.path}`)));
  await new Promise(resolve => setTimeout(resolve, 300));
  const bodies = posts().map(c => c.body as { content: string; message_reference?: { message_id: string } });
  assert.equal(bodies.length, 2);
  assert.ok(bodies[0]!.content.startsWith(FRONT_TEXT.adminOnly));
  assert.equal(bodies[0]!.message_reference?.message_id, '9005');
  assert.ok(bodies[1]!.content.startsWith(FRONT_TEXT.unavailable));
  assert.equal(bodies[1]!.message_reference?.message_id, '9006');
  assert.ok(!rest.calls.some(c => c.path.startsWith('/interactions/')));
  assert.equal(await count('events'), 0);
  assert.equal(await count('jobs'), 0);
  assert.ok(!auxCalls.some(call => call.startsWith('POST /v1/execute')), JSON.stringify(auxCalls));
});

test('O08 F5 진입점: READY 뒤 활성 스레드의 history를 받아 오지 않고, 그 스레드의 관리자 글도 모델 레인으로 가지 않는다', async () => {
  await thread('fixture-thread-a', '100');
  let histories = 0;
  rest.history = async () => { histories++; return [message('200', 'fixture-thread-a')]; };
  await boot();
  await ready();
  gw.dispatch(gw.latest, 2, 'MESSAGE_CREATE', message('300', 'fixture-thread-a'));
  assert.ok(await waitFor(async () => rest.calls.some(c => c.method === 'POST' && c.path === '/channels/fixture-thread-a/messages'), 8000));
  await new Promise(resolve => setTimeout(resolve, 300));
  assert.equal(histories, 0);
  assert.ok(!rest.calls.some(c => c.path.startsWith('/channels/fixture-thread-a/messages?')));
  assert.equal(await count('events'), 0);
  assert.equal(await count('jobs'), 0);
  const posted = rest.calls.find(c => c.method === 'POST' && c.path === '/channels/fixture-thread-a/messages')!;
  assert.ok((posted.body as { content: string }).content.startsWith(FRONT_TEXT.unavailable));
});


// 재시작 때 queued 작업이 첫 READY의 복구 장벽보다 먼저 claim되면,
// 중단 중 메시지를 history로 복구하기 전에 이전 입력으로 모델을 부른다.
async function queuedChat(channel: string, id: string) {
  const store = new Store(database.db);
  const saved = await store.save({ id, actor: OWNER, scope: { kind: 'thread', guild: GUILD, channel, parent: CHAT }, text: `fixture-${id}`,
    kind: 'message', mention: false }, 'fixture-v1', false);
  await store.accept(saved.id, 'chat', 'fixture-v1');
  // 오래전에 쌓인 작업: 대기 시간이 이미 지났다.
  await database.db.query('UPDATE jobs SET available_at=0 WHERE event_id=$1', [saved.id]);
  return saved.id;
}
const jobState = async (eventId: string) => (await database.db.query<{ state: string }>('SELECT state FROM jobs WHERE event_id=$1', [eventId])).rows[0]!.state;

test('PR12-2 Gateway가 붙기 전(첫 READY 장벽 전)에는 남아 있던 queued 작업을 claim하지 않음', async () => {
  await thread('fixture-thread-a', '100');
  const old = await queuedChat('fixture-thread-a', '100');
  await boot({ gateway: false });
  await new Promise(resolve => setTimeout(resolve, 400));
  assert.equal(await jobState(old), 'queued');
  assert.ok(!auxCalls.some(call => call.startsWith('POST /v1/execute')), JSON.stringify(auxCalls));
});


// 복구 대기 항목이 없는 RecoveryScheduler.runDue()는 DB 없이 false를 돌려준다.
// 그 루프가 하트비트 생존을 기록하면 DB 장애 중에도 healthchecks에 정상 ping이 나간다.
test('PR12-3 DB가 끊기면 DB에 닿지 못한 루프는 하트비트 생존으로 치지 않아 60초 뒤 ping이 멈춤', async () => {
  let offset = 0;
  const clock = () => Date.now() + offset;
  let down = false;
  const wrap = (inner: Database): Database => ({
    query: async <T>(sql: string, params?: unknown[]) => { if (down) throw new Error('fixture_db_down'); return inner.query<T>(sql, params); },
    transaction: (fn, deadline) => down ? Promise.reject(new Error('fixture_db_down')) : inner.transaction(tx => fn(wrap(tx)), deadline),
  });
  await boot({ db: wrap(database.db), now: clock, heartbeatEveryMs: 20 });
  await ready();
  const pings = () => auxCalls.filter(call => call.startsWith('GET /ping')).length;
  assert.ok(await waitFor(async () => pings() >= 1), '정상일 때 ping');
  down = true;
  await new Promise(resolve => setTimeout(resolve, 100));
  const before = pings();
  // 마지막 ping과 DB에 닿은 마지막 루프 둘 다 60초보다 오래전이 되게 시계를 당긴다(Gateway는 계속 연결).
  offset += 61_000;
  await new Promise(resolve => setTimeout(resolve, 400));
  const after = pings();
  down = false;
  assert.equal(after, before, `DB 장애 중 ping ${after - before}회`);
});

test('P2-5 8081 listen이 실패하면 먼저 연 8080도 닫고 오류를 다시 던짐', async () => {
  const blocker = createServer();
  blocker.listen(0); await once(blocker, 'listening');
  const probe = createServer();
  probe.listen(0); await once(probe, 'listening');
  const appPort = (probe.address() as AddressInfo).port;
  await new Promise(resolve => probe.close(resolve));
  try {
    await assert.rejects(boot({ ports: { app: appPort, alerts: (blocker.address() as AddressInfo).port } }), { code: 'EADDRINUSE' });
    publisher = undefined;
    await assert.rejects(fetch(`http://127.0.0.1:${appPort}/readyz`));
  } finally { blocker.close(); }
});

test('AC-15 진입점: 모델 멈춤 기록이 있으면 연결 뒤 봇 상태가 idle이고, 멈춤이 풀리면 상태 루프가 online으로 바꾼다', async () => {
  const job = 'fixture-paused-review';
  await database.db.query(`INSERT INTO events(id,provider,delivery_id,semantic_key,actor_id,scope,received_at,payload,accepted)
    VALUES ($1,'github',$1,$1,'github-review','{}',$2,'{}',true)`, [`e-${job}`, Date.now()]);
  await database.db.query(`INSERT INTO jobs(id,event_id,conversation_id,type,owner_id,target,revision,budget,priority,available_at,created_at,state,wait_reason)
    VALUES ($1,$2,NULL,'review','github-review','{}','{"policy":"p"}','{"timeoutMs":1,"toolCalls":0}',40,$3,$3,'waiting_user','model_limit')`, [job, `e-${job}`, Date.now()]);
  await database.db.query(`INSERT INTO model_pauses(job_id,kind,retry_at,paused_at) VALUES ($1,'rate_limit',$2,$3)`, [job, Date.now() + 3_600_000, Date.now()]);
  await boot({ modelResumeTickMs: 30 });
  const statuses = () => gw.connections.flatMap(c => c.received.filter(p => p.op === 3).map(p => (p.d as { status: string }).status));
  await until(() => statuses().includes('idle'));
  await database.db.query("UPDATE jobs SET state='cancelled',wait_reason=NULL WHERE id=$1", [job]);
  await until(() => statuses().at(-1) === 'online', 6000);
  assert.deepEqual(statuses(), ['idle', 'online']);
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
