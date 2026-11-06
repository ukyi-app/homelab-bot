import { after, afterEach, before, beforeEach, test } from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync } from 'node:crypto';
import { once } from 'node:events';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { COMMAND_DEFINITIONS, EXTERNAL_TASK_COMMANDS, EXTERNAL_TASK_COMMAND_DEFINITIONS, FOUNDATION_COMMANDS, TASK_COMMANDS, commandDefinitions } from '../src/commands.js';
import type { PublisherConfig } from '../src/config.js';
import { ConfigError, EXTERNAL_TASK_KEYS, loadPublisherConfig } from '../src/config.js';
import { Denied } from '../src/contracts.js';
import type { Scope } from '../src/contracts.js';
import type { Database } from '../src/database.js';
import { ALL_COMMANDS, DiscordIngress, EXTERNAL_ACK_NOTICE } from '../src/discord.js';
import { ExternalTaskCommands } from '../src/external-task-commands.js';
import type { ExternalTaskCommandHandler } from '../src/external-task-commands.js';
import { EXTERNAL_LINK_TTL_MS, ExternalTaskLinks, OneTimeSeed } from '../src/external-task-links.js';
import { EXTERNAL_TASK_PATH, ExternalTaskReceiver, FIXED_SUMMARY } from '../src/external-task-receiver.js';
import { PORTS } from '../src/http.js';
import { startPublisher } from '../src/main.js';
import type { Publisher, PublisherDeps } from '../src/main.js';
import { Store } from '../src/store.js';
import { ENVIRONMENT, SESSION, eventBody, raw, request, seedConversation, signedHeaders } from './external-task-fixture.js';
import type { Sender } from './external-task-fixture.js';
import { FakeGateway } from './fake-gateway.js';
import { event, fixture, localDatabase, thread } from './helpers.js';
import { CHAT, GUILD, NOTIFY, OWNER, Rest, Trace, publisherConfig, waitFor } from './t20-harness.js';

// R08 조립. 실제 Discord·Tailscale에는 닿지 않는다. [합성] 세션 ID·이벤트는 공식 문서의 필드로 만든 값이다.
// 가짜 비밀 값. 응답에 나가는 곳 말고 어디에도 나타나면 안 된다. 기록 수집기가 잡는지 확인하려고 찾기 쉬운 값을 쓴다.
const FAKE_SEED = 'FAKE-R08-SEED-do-not-leak-0123456789abcdefghij';
const THREAD = 'fixture-r08-thread';
const SCOPE: Scope = { guild: GUILD, channel: THREAD, parent: CHAT, kind: 'thread' };
const CHANNEL: Scope = { guild: 'fixture-guild', channel: 'fixture-chat', parent: null, kind: 'channel' };

const publisherEnv = (overrides: Record<string, string> = {}): Record<string, string> => ({
  DATABASE_URL: 'postgresql://fixture@pg.fixture:5432/fixture', DISCORD_BOT_TOKEN: 'fixture-discord-token-value',
  RUNTIME_POLICIES: JSON.stringify({ revision: 'fixture-v1', owner: OWNER, guild: GUILD, conversationChannel: CHAT, notificationChannel: NOTIFY, dmEnabled: false, services: [] }),
  GRAFANA_READER_TOKEN: 'fixture-grafana-token-value', HEALTHCHECKS_PING_URL: 'https://hc-ping.example/fixture',
  WORKER_CONTROL_PRIVATE_KEY: generateKeyPairSync('ed25519').privateKey.export({ type: 'pkcs8', format: 'pem' }).toString(),
  GITHUB_REVIEW_WEBHOOK_SECRET: 'fixture-webhook-secret-value', WORKER_URL: 'http://worker.sandbox:8080/',
  GRAFANA_URL: 'http://grafana.observability:3000', KUBERNETES_API_URL: 'https://kubernetes.default.svc', ...overrides });
const problems = (env: Record<string, string>) => { try { loadPublisherConfig(publisherEnv(env), 1); return []; } catch (error) { return [...(error as ConfigError).problems]; } };

test('R08 조립 설정: 없거나 false면 꺼짐, true·false 밖이면 기동 오류, 켰는데 환경이 없거나 틀리면 기동 오류, 값은 오류에 없음', () => {
  assert.equal(PORTS.externalEvents, 8082);
  assert.deepEqual([...EXTERNAL_TASK_KEYS], ['EXTERNAL_TASK_EVENTS_ENABLED', 'EXTERNAL_TASK_ENVIRONMENT', 'EXTERNAL_TASK_RESTORE_EPOCH']);
  assert.equal(loadPublisherConfig(publisherEnv(), 1).externalTask, null);
  assert.equal(loadPublisherConfig(publisherEnv({ EXTERNAL_TASK_EVENTS_ENABLED: 'false' }), 1).externalTask, null);
  assert.equal(loadPublisherConfig(publisherEnv({ EXTERNAL_TASK_ENVIRONMENT: 'prod' }), 1).externalTask, null, '환경만 있으면 켜지지 않는다');
  assert.deepEqual(loadPublisherConfig(publisherEnv({ EXTERNAL_TASK_EVENTS_ENABLED: 'true', EXTERNAL_TASK_ENVIRONMENT: 'prod' }), 1).externalTask, { environment: 'prod' });
  assert.deepEqual(loadPublisherConfig(publisherEnv({ EXTERNAL_TASK_EVENTS_ENABLED: 'true', EXTERNAL_TASK_ENVIRONMENT: 'prod', EXTERNAL_TASK_RESTORE_EPOCH: '2026-11-06' }), 1).externalTask,
    { environment: 'prod', restoreEpoch: '2026-11-06' });
  for (const value of ['', 'TRUE', 'True', '1', 'yes', 'on', ' true']) assert.deepEqual(problems({ EXTERNAL_TASK_EVENTS_ENABLED: value }), ['EXTERNAL_TASK_EVENTS_ENABLED(invalid)'], JSON.stringify(value));
  assert.deepEqual(problems({ EXTERNAL_TASK_EVENTS_ENABLED: 'true' }), ['EXTERNAL_TASK_ENVIRONMENT(missing)']);
  for (const value of ['', 'Prod', 'a b', '-prod', 'prod_1', 'x'.repeat(64), 'secret/host.example']) {
    assert.deepEqual(problems({ EXTERNAL_TASK_EVENTS_ENABLED: 'true', EXTERNAL_TASK_ENVIRONMENT: value }), ['EXTERNAL_TASK_ENVIRONMENT(invalid)'], value);
    // 꺼져 있어도 형식 위반은 기동 오류다.
    assert.deepEqual(problems({ EXTERNAL_TASK_ENVIRONMENT: value }), ['EXTERNAL_TASK_ENVIRONMENT(invalid)'], value);
  }
  assert.deepEqual(problems({ EXTERNAL_TASK_RESTORE_EPOCH: 'a b' }), ['EXTERNAL_TASK_RESTORE_EPOCH(invalid)']);
});

test('R08 조립 명령: 켰을 때만 세 명령, 작업 레인과 독립, Discord 한도 안, 옵션은 수신이 읽는 이름', () => {
  assert.equal(commandDefinitions(false), COMMAND_DEFINITIONS);
  assert.deepEqual([...EXTERNAL_TASK_COMMANDS], ['attach', 'detach', 'attach-list']);
  assert.deepEqual(commandDefinitions(false, false, false, true).map(c => c.name), [...FOUNDATION_COMMANDS, ...EXTERNAL_TASK_COMMANDS]);
  assert.deepEqual(commandDefinitions(false, false, true, false).map(c => c.name), [...FOUNDATION_COMMANDS, ...TASK_COMMANDS]);
  for (const definition of EXTERNAL_TASK_COMMAND_DEFINITIONS) {
    assert.ok(definition.description.length <= 100, definition.name);
    assert.ok(ALL_COMMANDS.has(definition.name), definition.name);
    for (const option of definition.options) assert.ok(option.description.length <= 100, option.name);
  }
  const options = (name: string) => EXTERNAL_TASK_COMMAND_DEFINITIONS.find(c => c.name === name)!.options.map(o => [o.name, o.max_length]);
  assert.deepEqual(options('attach'), [['target', 128], ['text', 40]]);
  assert.deepEqual(options('detach'), [['target', 36]]);
  assert.deepEqual(options('attach-list'), []);
});

// 게시 서버 진입점 시험. 실제 포트는 0으로 받아 8082를 쓰지 않는다.
class R08Rest extends Rest {
  guild: { name: string }[] = [];
  callbacks: { path: string; body: { type: number; data: { content: string; flags: number; allowed_mentions: { parse: unknown[] } } } }[] = [];
  failCallback: ((content: string) => Error) | undefined;
  override async request(method: 'GET' | 'POST' | 'PUT', path: string, body?: unknown): Promise<unknown> {
    if (path === `/applications/fixture-app/guilds/${GUILD}/commands`) {
      if (method === 'PUT') this.guild = body as { name: string }[];
      return this.guild;
    }
    if (method === 'GET' && path === `/channels/${THREAD}`) return { id: THREAD, type: 11, guild_id: GUILD, parent_id: CHAT };
    if (method === 'POST' && path.startsWith('/interactions/')) {
      const content = (body as R08Rest['callbacks'][number]['body']).data.content;
      if (this.failCallback) throw this.failCallback(content);
      this.callbacks.push({ path, body: body as R08Rest['callbacks'][number]['body'] });
      return undefined;
    }
    return super.request(method, path, body);
  }
  names() { return this.guild.map(c => c.name).sort(); }
}
let database: Awaited<ReturnType<typeof localDatabase>>;
let gw: FakeGateway;
let rest: R08Rest;
let publisher: Publisher | undefined;
let logs: { event: string; detail?: Record<string, unknown> }[];
before(async () => { database = await localDatabase(); });
after(async () => { await database.pg.close(); });
beforeEach(async () => {
  const tables = (await database.pg.query<{ tablename: string }>(
    "SELECT tablename FROM pg_tables WHERE schemaname='public' AND tablename NOT IN ('schema_migrations','execution_lanes','external_task_link_fence')")).rows.map(r => r.tablename);
  await database.pg.exec(`TRUNCATE ${tables.join(',')} RESTART IDENTITY CASCADE`);
  await database.pg.exec(`UPDATE external_task_link_fence SET token=NULL,fenced_at=NULL`);
  gw = new FakeGateway(); gw.options.identifyIntervalMs = 250; await gw.start();
  rest = new R08Rest(new Trace()); logs = [];
});
afterEach(async () => {
  await publisher?.stop(); publisher = undefined;
  await gw.close();
});
const boot = async (extra: Partial<PublisherConfig>, deps: Partial<PublisherDeps> = {}) => {
  publisher = await startPublisher(publisherConfig(extra), { db: database.db, discord: rest, send: async () => new Response('OK'),
    gatewayUrl: async () => ({ url: gw.url }), allowGatewayUrl: url => url.hostname === '127.0.0.1', serviceAccount: { tokenFile: '/nonexistent', caFile: null },
    ports: { app: 0, alerts: 0, externalEvents: 0 }, idleMs: 20, identifySpacingMs: 250, registerDelaysMs: [0, 20, 20], heartbeatEveryMs: 60_000, stopTimeoutMs: 3000,
    log: (name, detail) => logs.push({ event: name, detail }), ...deps });
  return publisher;
};
const ON: Partial<PublisherConfig> = { externalTask: { environment: ENVIRONMENT } };
const seedThread = async () => seedConversation(database.db, new Store(database.db), Date.now(), SCOPE);
const registered = () => waitFor(() => rest.guild.length > 0);
const settle = (ms = 150) => new Promise(resolve => setTimeout(resolve, ms));
let interactions = 9000;
function command(name: string, channel: string, options: Record<string, string> = {}) {
  const id = String(++interactions);
  gw.dispatch(gw.latest, interactions, 'INTERACTION_CREATE', { id, token: `fixture-token-${id}`, type: 2, channel_id: channel, guild_id: GUILD,
    member: { user: { id: OWNER } }, data: { name, options: Object.entries(options).map(([key, value]) => ({ name: key, value })) } });
  return id;
}
const reply = async (id: string) => {
  await waitFor(() => rest.callbacks.some(c => c.path.startsWith(`/interactions/${id}/`)));
  return rest.callbacks.find(c => c.path.startsWith(`/interactions/${id}/`))!;
};
const rows = async <T = Record<string, unknown>>(sql: string, params: unknown[] = []) => (await database.db.query<T>(sql, params)).rows;
const dumpTables = async (db: Database) => {
  const tables = (await db.query<{ tablename: string }>("SELECT tablename FROM pg_tables WHERE schemaname='public'")).rows.map(row => row.tablename);
  return JSON.stringify(await Promise.all(tables.map(async table => [table, (await db.query(`SELECT * FROM ${table}`)).rows])));
};
const field = (content: string, name: string) => new RegExp(`^${name}: \`([^\`]+)\`$`, 'm').exec(content)?.[1];
const senderFrom = (content: string): Sender => ({ connectionId: field(content, 'connection_id')!, keyId: field(content, 'key_id')!, seed: field(content, 'seed')!, externalTaskId: field(content, 'external_task_id')! });
const post = (port: number, who: Sender, body = eventBody(who, Date.now())) => fetch(`http://127.0.0.1:${port}${EXTERNAL_TASK_PATH}`, {
  method: 'POST', headers: signedHeaders(who, body, Date.now()), body });

test('R08 조립 꺼짐: 리스너·명령·지표·보관 정리가 없고 /attach는 수신에서 닫힘', async () => {
  await seedThread();
  const p = await boot({}, { externalPurgeMs: 10 });
  await registered();
  assert.deepEqual(rest.names(), [...FOUNDATION_COMMANDS].sort());
  assert.deepEqual(Object.keys(p.ports).sort(), ['alerts', 'app']);
  assert.deepEqual(logs.filter(l => l.event === 'external_task_gate').map(l => l.detail), [{ state: 'closed', reason: 'switch_off' }]);
  command('attach', THREAD, { target: SESSION, text: 'claude' });
  command('detach', THREAD, { target: 'x' });
  command('attach-list', THREAD);
  await settle();
  assert.equal((await rows('SELECT id FROM events')).length, 0);
  assert.equal((await rows('SELECT id FROM external_task_connections')).length, 0);
  assert.deepEqual(rest.callbacks, []);
  assert.doesNotMatch(await (await fetch(`http://127.0.0.1:${p.ports.app}/metrics`)).text(), /external_task/);
  assert.equal(logs.some(l => l.event.startsWith('external_task_') && l.event !== 'external_task_gate'), false);
});

test('R08 조립 켜짐: /attach → 8082 수신 → Discord 게시 → 해제 뒤 거절, 8080·8081에는 경로가 없고 8082에는 다른 경로가 없음', async () => {
  await seedThread();
  const p = await boot(ON);
  await registered();
  assert.deepEqual(rest.names(), [...FOUNDATION_COMMANDS, ...EXTERNAL_TASK_COMMANDS].sort(), '작업 레인이 꺼져 있어도 연결 명령은 열린다');
  const port = p.ports.externalEvents!;
  assert.ok(port > 0);

  const attached = await reply(command('attach', THREAD, { target: SESSION, text: 'claude' }));
  // 상호작용 응답으로만, 본인에게만, 멘션·미리보기 없이 나간다.
  assert.equal(attached.body.type, 4);
  assert.equal(attached.body.data.flags & 64, 64);
  assert.deepEqual(attached.body.data.allowed_mentions.parse, []);
  assert.equal(field(attached.body.data.content, 'environment'), ENVIRONMENT);
  assert.equal(field(attached.body.data.content, 'summary_consent'), 'false');
  assert.equal(rest.sent.length, 0);
  const who = senderFrom(attached.body.data.content);
  assert.equal(who.externalTaskId, SESSION);

  const body = eventBody(who, Date.now());
  // 8080·8081은 유효하게 서명한 요청에도 404이고 아무것도 저장하지 않는다.
  for (const other of [p.ports.app, p.ports.alerts]) {
    assert.equal((await fetch(`http://127.0.0.1:${other}${EXTERNAL_TASK_PATH}`, { method: 'POST', headers: signedHeaders(who, body, Date.now()), body })).status, 404);
  }
  assert.equal((await rows('SELECT event_id FROM external_task_events')).length, 0);
  // 8082에는 이 경로 하나뿐이다.
  for (const [method, path] of [['GET', '/metrics'], ['GET', '/readyz'], ['POST', '/github'], ['POST', '/alerts'], ['POST', `${EXTERNAL_TASK_PATH}/`], ['POST', `${EXTERNAL_TASK_PATH}?x=1`]] as const) {
    const { status } = await raw({ address: () => ({ port }) } as never, request(method, path, {}));
    assert.equal(status, 404, `${method} ${path}`);
  }

  const accepted = await fetch(`http://127.0.0.1:${port}${EXTERNAL_TASK_PATH}`, { method: 'POST', headers: signedHeaders(who, body, Date.now()), body });
  assert.equal(accepted.status, 202);
  await waitFor(() => rest.sent.some(m => m.channel === THREAD));
  const posted = rest.sent.find(m => m.channel === THREAD)!.content;
  assert.match(posted, /사람 세션이 턴을 끝냈다고 알림/);
  assert.match(posted, new RegExp(FIXED_SUMMARY));
  assert.match(posted, /봇이 결과를 확인한 것은 아닙니다/);

  const metrics = () => fetch(`http://127.0.0.1:${p.ports.app}/metrics`).then(response => response.text());
  assert.match(await metrics(), /homelab_bot_external_task_requests\{outcome="accepted"\} 1/);
  // 메시지를 보낸 뒤 게시 확정이 커밋된다.
  await waitFor(async () => /homelab_bot_external_task_unposted 0/.test(await metrics()));

  const listed = (await reply(command('attach-list', THREAD))).body.data.content;
  assert.ok(listed.includes(who.connectionId));
  assert.match(listed, /활성/);

  const detached = (await reply(command('detach', THREAD, { target: who.connectionId }))).body.data.content;
  assert.match(detached, /해제했습니다/);
  assert.equal((await post(port, who)).status, 401);

  await p.stop();
  await assert.rejects(fetch(`http://127.0.0.1:${port}${EXTERNAL_TASK_PATH}`, { method: 'POST' }), '멈춘 뒤에는 포트가 닫힌다');
});

test('R08 조립 포트: 시험이 포트를 주지 않으면 실제 8082에서 받음', async t => {
  const probe = createServer();
  probe.on('error', () => {});
  probe.listen(PORTS.externalEvents);
  const free = await Promise.race([once(probe, 'listening').then(() => true), once(probe, 'error').then(() => false)]);
  if (!free) { t.skip('이 기계에서 8082를 이미 쓰고 있음'); return; }
  await new Promise(resolve => probe.close(resolve));
  const p = await boot(ON, { ports: { app: 0, alerts: 0 } });
  assert.equal(p.ports.externalEvents, 8082);
  const { status } = await raw({ address: () => ({ port: 8082 }) } as never, request('GET', '/metrics', {}));
  assert.equal(status, 404);
});

test('R08 seed 비노출(실행 경로): 응답 말고는 DB 전체·로그·채널·지표·목록 어디에도 없음', async () => {
  await seedThread();
  const p = await boot(ON);
  await registered();
  const content = (await reply(command('attach', THREAD, { target: SESSION, text: 'claude' }))).body.data.content;
  const who = senderFrom(content);
  assert.match(who.seed, /^[A-Za-z0-9_-]{43}$/);
  assert.equal((await post(p.ports.externalEvents!, who)).status, 202);
  await waitFor(() => rest.sent.length === 1);
  const list = (await reply(command('attach-list', THREAD))).body.data.content;
  const dump = await dumpTables(database.db);
  // 수집기가 실제로 그 행을 보고 있다는 대조.
  assert.ok(dump.includes(who.connectionId) && dump.includes(who.keyId));
  const collected = { dump, logs: JSON.stringify(logs), sent: JSON.stringify(rest.sent), list,
    metrics: await (await fetch(`http://127.0.0.1:${p.ports.app}/metrics`)).text() };
  for (const [name, text] of Object.entries(collected)) assert.equal(text.includes(who.seed), false, name);
  // 이벤트에는 세션 ID만 남고 실행기 선택 글은 없다.
  const [saved] = await rows<{ payload: { text: string; target: string; command: string } }>(`SELECT payload FROM events WHERE payload->>'command'='attach'`);
  assert.deepEqual([saved!.payload.text, saved!.payload.target], ['', SESSION]);
});

test('R08 전달 실패(실행 경로): 상호작용 응답이 실패하면 키를 폐기하고 채널에는 고정 안내만', async () => {
  await seedThread();
  await boot(ON);
  await registered();
  let seed = '';
  // 전송 계층 오류에 요청 본문이 실리는 최악의 경우를 만든다.
  rest.failCallback = content => { seed = field(content, 'seed') ?? seed; return new Error(`callback failed: ${content}`); };
  command('attach', THREAD, { target: SESSION, text: 'claude' });
  await waitFor(async () => (await rows<{ revoked_reason: string | null }>('SELECT revoked_reason FROM external_task_connections'))[0]?.revoked_reason === 'delivery_failed');
  await waitFor(() => rest.sent.some(m => m.content.includes(EXTERNAL_ACK_NOTICE)));
  assert.match(seed, /^[A-Za-z0-9_-]{43}$/);
  for (const [name, text] of Object.entries({ dump: await dumpTables(database.db), logs: JSON.stringify(logs), sent: JSON.stringify(rest.sent) })) {
    assert.equal(text.includes(seed), false, name);
  }
  // 닫혔으니 같은 세션을 바로 다시 연결할 수 있다.
  rest.failCallback = undefined;
  const again = (await reply(command('attach', THREAD, { target: SESSION, text: 'claude' }))).body.data.content;
  assert.ok(field(again, 'seed'));
});

test('R08 복원 장벽: 게시자보다 먼저 울타리를 세워 restoreEpoch가 바뀌면 미게시 행을 내보내지 않음', async () => {
  const store = new Store(database.db);
  await seedThread();
  const links = new ExternalTaskLinks(store);
  const link = await links.attach({ owner: OWNER, scope: SCOPE, externalTaskId: SESSION, executor: 'claude' });
  const who: Sender = { connectionId: link.connectionId, keyId: link.keyId, seed: link.seed.reveal(), externalTaskId: SESSION };
  const receiver = new ExternalTaskReceiver({ store, links, environment: ENVIRONMENT, authorize: async () => ({ revision: 'fixture-v1' }) });
  const body = eventBody(who, Date.now());
  assert.equal((await receiver.receive(signedHeaders(who, body, Date.now()), Buffer.from(body))).outcome, 'accepted');
  // timeline은 그대로이고 epoch만 바뀐 pg_dump 복원이다. 게시 트리거는 이것을 보지 못한다.
  await boot({ externalTask: { environment: ENVIRONMENT, restoreEpoch: 'restored-1' } });
  await registered();
  await waitFor(() => logs.some(l => l.event === 'publisher_started'));
  await settle(200);
  assert.deepEqual(logs.find(l => l.event === 'external_task_fence')!.detail, { fenced: 1 });
  assert.equal(rest.sent.length, 0);
  assert.deepEqual((await rows('SELECT state FROM outbox')).map(row => row.state), ['blocked']);
  assert.deepEqual((await rows('SELECT revoked_reason FROM external_task_connections')).map(row => row.revoked_reason), ['restore_fence']);
});

test('R08 복원 장벽: 울타리를 세우지 못한 동안에는 게시자를 열지 않고, 세우면 연다', async () => {
  await seedThread();
  await new Store(database.db).enqueue({ key: 'fixture-pending', actor: OWNER, scope: SCOPE, revision: 'fixture-v1',
    payload: { kind: 'message', channel: THREAD, content: '대기 중인 글', classification: 'safe_summary' } });
  let failing = true;
  const flaky: Database = { query: (sql, params) => database.db.query(sql, params), transaction: (fn, deadline) => database.db.transaction(tx => fn({
    transaction: tx.transaction,
    query: async (sql: string, params?: unknown[]) => {
      if (failing && sql.includes('external_task_link_fence')) throw new Error('fixture_fence_down');
      return tx.query(sql, params);
    },
  } as Database), deadline) };
  await boot(ON, { db: flaky });
  await registered();
  await waitFor(() => logs.some(l => l.event === 'external_task_fence_failed'));
  await settle(200);
  assert.equal(rest.sent.length, 0);
  failing = false;
  await waitFor(() => rest.sent.some(m => m.content.includes('대기 중인 글')), 5000);
  assert.deepEqual(logs.find(l => l.event === 'external_task_fence')!.detail, { fenced: 0 });
});

test('R08 조립 포트 충돌: 8082 자리가 막히면 기동 실패하고 앞서 연 수신 포트를 닫음', async () => {
  const blocker = createServer();
  blocker.listen(0); await once(blocker, 'listening');
  const probe = createServer();
  probe.listen(0); await once(probe, 'listening');
  const appPort = (probe.address() as AddressInfo).port;
  await new Promise(resolve => probe.close(resolve));
  try {
    await assert.rejects(boot(ON, { ports: { app: appPort, alerts: 0, externalEvents: (blocker.address() as AddressInfo).port } }), { code: 'EADDRINUSE' });
    const again = createServer();
    again.listen(appPort); await once(again, 'listening');
    await new Promise(resolve => again.close(resolve));
  } finally { await new Promise(resolve => blocker.close(resolve)); }
});

test('R08 보관 정리: 켜지면 주기적으로 지움', async () => {
  await seedThread();
  const store = new Store(database.db);
  const links = new ExternalTaskLinks(store);
  const link = await links.attach({ owner: OWNER, scope: SCOPE, externalTaskId: SESSION, executor: 'claude' });
  await database.db.query(`UPDATE external_task_connections SET revoked_at=1,revoked_reason='detach' WHERE id=$1`, [link.connectionId]);
  await boot(ON, { externalPurgeMs: 20 });
  await waitFor(async () => (await rows('SELECT id FROM external_task_connections')).length === 0);
  assert.deepEqual(logs.find(l => l.event === 'external_task_purged')!.detail, { events: 0, connections: 1 });
});

// 수신 경로만. 처리기를 실제 ExternalTaskCommands로 조립하고 업무 시계를 직접 움직인다.
async function wired(wrap: (links: ExternalTaskLinks) => ConstructorParameters<typeof ExternalTaskCommands>[0] = links => links) {
  const { db, pg } = await localDatabase();
  const f = await fixture(db);
  await seedConversation(db, f.store, f.now());
  const links = new ExternalTaskLinks(f.store);
  const logged: string[] = [];
  const log = (name: string, detail?: Record<string, unknown>) => { logged.push(JSON.stringify({ name, ...detail })); };
  const handler: ExternalTaskCommandHandler = new ExternalTaskCommands(wrap(links), ENVIRONMENT, log);
  const acks: { id: string; content: string; flags: number | undefined }[] = [];
  f.rest.acknowledge = async (e, content, options) => { acks.push({ id: e.id, content, flags: options.flags }); };
  const ingress = new DiscordIngress(f.store, f.gate, f.rest, true, ALL_COMMANDS, log, undefined, undefined, handler);
  const receiver = new ExternalTaskReceiver({ store: f.store, links, environment: ENVIRONMENT, authorize: (owner, scope, tx) => f.gate.withDatabase(tx).authorize(owner, scope) });
  const issue = async (id: string, text = 'claude', target = SESSION) => {
    await ingress.receive(event(id, { kind: 'command', command: 'attach', target, text }));
    return senderFrom(acks.find(a => a.id === id)!.content);
  };
  const send = async (who: Sender, overrides: Record<string, unknown> = {}) => {
    const body = eventBody(who, f.now(), overrides);
    return receiver.receive(signedHeaders(who, body, f.now()), Buffer.from(body));
  };
  return { db, f, links, logged, acks, ingress, receiver, issue, send, close: () => pg.close() };
}

test('R08 seed 비노출(가짜 비밀): 성공 경로에서 응답에만 있고 outbox·감사·이벤트·로그 수집기에 없음', async () => {
  const ctx = await wired(links => ({ attach: async input => ({ ...await links.attach(input), seed: new OneTimeSeed(FAKE_SEED) }),
    detach: links.detach.bind(links), list: links.list.bind(links), revoke: links.revoke.bind(links) }));
  try {
    await ctx.ingress.receive(event('a1', { kind: 'command', command: 'attach', target: SESSION, text: 'claude' }));
    assert.equal(ctx.acks.length, 1);
    assert.ok(ctx.acks[0]!.content.includes(FAKE_SEED), '대조: 응답에는 있다');
    assert.equal(ctx.acks[0]!.flags, 4, '미리보기를 끈다');
    const dump = await dumpTables(ctx.db);
    assert.ok(dump.includes('external_task_attached'), '대조: 감사 행을 보고 있다');
    assert.equal(dump.includes(FAKE_SEED), false);
    assert.equal(ctx.logged.join('\n').includes(FAKE_SEED), false);
    assert.ok(ctx.logged.join('\n').includes('"outcome":"attached"'), '대조: 로그 수집기가 돈다');
  } finally { await ctx.close(); }
});

for (const [name, failure] of [
  ['본문을 담은 오류', (content: string) => new Error(`transport failed: ${content}`)],
  ['코드 형식 오류', () => new Error('ack_lost')],
] as [string, (content: string) => Error][]) {
  test(`R08 seed 비노출(가짜 비밀): 전달 실패(${name})면 폐기하고 어디에도 남지 않음, 재발급 없이 다시 attach`, async () => {
    const ctx = await wired(links => ({ attach: async input => ({ ...await links.attach(input), seed: new OneTimeSeed(FAKE_SEED) }),
      detach: links.detach.bind(links), list: links.list.bind(links), revoke: links.revoke.bind(links) }));
    try {
      const working = ctx.f.rest.acknowledge;
      const seen: string[] = [];
      ctx.f.rest.acknowledge = async (_e, content) => { seen.push(content); throw failure(content); };
      await ctx.ingress.receive(event('a1', { kind: 'command', command: 'attach', target: SESSION, text: 'claude' }));
      assert.ok(seen[0]!.includes(FAKE_SEED), '대조: 첫 시도에는 있었다');
      assert.equal(seen.slice(1).some(text => text.includes(FAKE_SEED)), false, '실패 안내에는 없다');
      const [row] = (await ctx.db.query<{ revoked_reason: string }>('SELECT revoked_reason FROM external_task_connections')).rows;
      assert.equal(row!.revoked_reason, 'delivery_failed');
      const dump = await dumpTables(ctx.db);
      assert.ok(dump.includes('ack_uncertain'), '대조: 실패 기록을 보고 있다');
      assert.equal(dump.includes(FAKE_SEED), false);
      assert.equal(ctx.logged.join('\n').includes(FAKE_SEED), false);
      const notices = (await ctx.db.query<{ payload: { content: string } }>('SELECT payload FROM outbox')).rows.map(r => r.payload.content);
      assert.deepEqual(notices, [EXTERNAL_ACK_NOTICE]);
      assert.ok(ctx.logged.join('\n').includes('"outcome":"delivery_failed"'));
      ctx.f.rest.acknowledge = working;
      await ctx.ingress.receive(event('a2', { kind: 'command', command: 'attach', target: SESSION, text: 'claude' }));
      assert.equal((await ctx.db.query('SELECT id FROM external_task_connections WHERE revoked_at IS NULL')).rows.length, 1);
    } finally { await ctx.close(); }
  });
}

test('R08 전달 실패: 폐기까지 실패해도 seed는 남지 않고 해제 방법을 안내함', async () => {
  const ctx = await wired(links => ({ attach: async input => ({ ...await links.attach(input), seed: new OneTimeSeed(FAKE_SEED) }),
    detach: links.detach.bind(links), list: links.list.bind(links), revoke: async () => { throw new Error('fixture_db_down'); } }));
  try {
    const seen: string[] = [];
    ctx.f.rest.acknowledge = async (_e, content) => { seen.push(content); if (content.includes(FAKE_SEED)) throw new Error(content); };
    await ctx.ingress.receive(event('a1', { kind: 'command', command: 'attach', target: SESSION, text: 'claude' }));
    assert.match(seen.at(-1)!, /폐기도 확인하지 못했습니다.*\/detach/);
    assert.ok(ctx.logged.join('\n').includes('external_task_revoke_failed'));
    assert.equal(ctx.logged.join('\n').includes(FAKE_SEED), false);
    assert.equal((await dumpTables(ctx.db)).includes(FAKE_SEED), false);
  } finally { await ctx.close(); }
});

test('R08 명령 권한: owner만, 자기 활성 스레드에서만, 스위치가 꺼지면 처리기가 없어 닫힘', async () => {
  const ctx = await wired();
  try {
    const attach = (id: string, options = {}) => ctx.ingress.receive(event(id, { kind: 'command', command: 'attach', target: SESSION, text: 'claude', ...options }));
    const connections = async () => (await ctx.db.query('SELECT id FROM external_task_connections')).rows.length;
    // 정책 owner가 아니면 저장 전에 거부다.
    for (const command of EXTERNAL_TASK_COMMANDS) await assert.rejects(ctx.ingress.receive(event(`o-${command}`, { actor: 'other-user', kind: 'command', command, target: 'x', text: 'claude' })), Denied, command);
    assert.equal((await ctx.db.query('SELECT id FROM events')).rows.length, 0);
    // 남의 스레드.
    const foreign: Scope = { ...thread, channel: 'fixture-foreign' };
    await ctx.db.query(`INSERT INTO conversations(id,owner_id,scope,channel_id,created_at) VALUES ($1,'someone-else',$2,$3,1)`, [ctx.f.store.scopeId(foreign), JSON.stringify(foreign), foreign.channel]);
    await assert.rejects(attach('f1', { scope: foreign }), Denied);
    // 처리기가 없는 수신(스위치 꺼짐)은 정책 owner여도 닫힌다.
    for (const command of EXTERNAL_TASK_COMMANDS) await assert.rejects(ctx.f.ingress.receive(event(`n-${command}`, { kind: 'command', command, target: 'x', text: 'claude' })), Denied, command);
    // 버튼으로는 열리지 않는다.
    await assert.rejects(ctx.ingress.receive(event('b1', { kind: 'button', command: 'attach', target: SESSION })), Denied);
    // 채널에서는 안내만, 키를 만들지 않는다.
    await attach('c1', { scope: CHANNEL });
    assert.match(ctx.acks.find(a => a.id === 'c1')!.content, /스레드에서만/);
    await ctx.ingress.receive(event('c2', { kind: 'command', command: 'attach-list', scope: CHANNEL }));
    assert.match(ctx.acks.find(a => a.id === 'c2')!.content, /스레드에서만/);
    // 비활성 스레드.
    await ctx.db.query('UPDATE conversations SET active=false WHERE id=$1', [ctx.f.store.scopeId(thread)]);
    await attach('i1');
    assert.match(ctx.acks.find(a => a.id === 'i1')!.content, /연결할 수 없습니다/);
    await ctx.db.query('UPDATE conversations SET active=true WHERE id=$1', [ctx.f.store.scopeId(thread)]);
    assert.equal(await connections(), 0);
    // 잘못된 입력은 서식 안내뿐이다.
    for (const [id, options] of [['u1', { text: '' }], ['u2', { text: 'gemini' }], ['u3', { text: 'claude summary=off' }], ['u4', { text: 'claude summary=on extra' }], ['u5', { target: '/Users/fixture/x' }], ['u6', { target: undefined }]] as const) {
      await attach(id, options);
      assert.match(ctx.acks.find(a => a.id === id)!.content, /\/attach target:/, id);
    }
    assert.equal(await connections(), 0);

    const who = await ctx.issue('ok');
    // 같은 상호작용 재전달은 다시 처리하지 않는다.
    await ctx.ingress.receive(event('ok', { kind: 'command', command: 'attach', target: SESSION, text: 'claude' }));
    assert.equal(ctx.acks.filter(a => a.id === 'ok').length, 1);
    assert.equal(await connections(), 1);
    // 같은 세션 재연결은 거절하고 키를 내지 않는다.
    await attach('dup');
    const duplicate = ctx.acks.find(a => a.id === 'dup')!.content;
    assert.match(duplicate, /이미 연결된/);
    assert.equal(field(duplicate, 'seed'), undefined);
    // 없는 연결·타인 연결은 구별해 주지 않는다. 처리기에 다른 actor가 들어와도 닫히지 않는다.
    const handler = new ExternalTaskCommands(ctx.links, ENVIRONMENT, () => {});
    const stranger = await handler.handle({ actor: 'other-user', scope: thread, command: 'detach', text: '', target: who.connectionId }, async () => true);
    const missing = await handler.handle({ actor: OWNER, scope: thread, command: 'detach', text: '', target: 'missing' }, async () => true);
    assert.deepEqual([stranger.content, stranger.outcome], [missing.content, missing.outcome]);
    assert.equal((await ctx.db.query<{ revoked_at: string | null }>('SELECT revoked_at FROM external_task_connections')).rows[0]!.revoked_at, null);
    assert.deepEqual((await handler.handle({ actor: 'other-user', scope: thread, command: 'attach-list', text: '' }, async () => true)).outcome, 'empty');
    // 목록은 이 대화의 연결만 보여 준다.
    const other: Scope = { ...thread, channel: 'fixture-other-owned' };
    await seedConversation(ctx.db, ctx.f.store, ctx.f.now(), other);
    await ctx.ingress.receive(event('l1', { kind: 'command', command: 'attach-list', scope: other }));
    assert.match(ctx.acks.find(a => a.id === 'l1')!.content, /연결한 세션이 없습니다/);
    await ctx.ingress.receive(event('l2', { kind: 'command', command: 'attach-list' }));
    const list = ctx.acks.find(a => a.id === 'l2')!.content;
    assert.ok(list.includes(who.connectionId) && list.includes(SESSION));
    assert.match(list, /마지막 알림 없음/);
    assert.match(list, /읽기 전용/);
    // 잘라낸 목록임을 알린다.
    for (let i = 0; i < 10; i++) await ctx.issue(`m${i}`, 'codex', `session-${i}`);
    await ctx.ingress.receive(event('l3', { kind: 'command', command: 'attach-list' }));
    assert.match(ctx.acks.find(a => a.id === 'l3')!.content, /더 있음/);
  } finally { await ctx.close(); }
});

test('R08 연결 수명: 해제하면 수신과 미게시 행을 막음', async () => {
  const ctx = await wired();
  try {
    const who = await ctx.issue('a1');
    assert.equal((await ctx.send(who)).outcome, 'accepted');
    await ctx.ingress.receive(event('d1', { kind: 'command', command: 'detach', target: who.connectionId }));
    assert.match(ctx.acks.find(a => a.id === 'd1')!.content, /미게시 알림 1건을 막았습니다/);
    assert.equal((await ctx.send(who)).status, 401);
    assert.equal(await ctx.f.publisher.deliver(), false);
    assert.equal(ctx.f.rest.messages.length, 0);
    await ctx.ingress.receive(event('l1', { kind: 'command', command: 'attach-list' }));
    assert.match(ctx.acks.find(a => a.id === 'l1')!.content, /닫힘\(detach\)/);
    // 해제 뒤에는 같은 세션을 새 키로 다시 연결한다. 이전 키는 계속 거절된다.
    const again = await ctx.issue('a2');
    assert.notEqual(again.connectionId, who.connectionId);
    assert.notEqual(again.seed, who.seed);
    assert.equal((await ctx.send(again)).outcome, 'accepted');
    assert.equal((await ctx.send(who)).status, 401);
  } finally { await ctx.close(); }
});

test('R08 연결 수명: 30일 뒤 수신을 거절함. 만료 전에 받은 미게시 행은 나감(B4 결정)', async () => {
  const ctx = await wired();
  try {
    const who = await ctx.issue('a1');
    assert.equal((await ctx.send(who)).outcome, 'accepted');
    ctx.f.advance(EXTERNAL_LINK_TTL_MS - 1000);
    assert.equal((await ctx.send(who)).outcome, 'accepted');
    ctx.f.advance(1000);
    const late = await ctx.send(who);
    assert.deepEqual([late.status, late.outcome], [401, 'unauthorized']);
    assert.equal(await ctx.f.publisher.deliver(), true);
    assert.equal(ctx.f.rest.messages.length, 1);
    await ctx.ingress.receive(event('l1', { kind: 'command', command: 'attach-list' }));
    assert.match(ctx.acks.find(a => a.id === 'l1')!.content, /· 만료 · /);
    // 만료된 연결은 자리를 막지 않는다.
    assert.ok((await ctx.issue('a2')).seed);
  } finally { await ctx.close(); }
});

for (const [name, withdraw] of [
  ['거부 목록 등록', (ctx: Awaited<ReturnType<typeof wired>>) => ctx.f.gate.revoke(OWNER, thread, OWNER)],
  ['정책 owner 교체', async (ctx: Awaited<ReturnType<typeof wired>>) => { ctx.f.policy.owner = 'next-owner'; }],
] as [string, (ctx: Awaited<ReturnType<typeof wired>>) => Promise<unknown>][]) {
  test(`R08 연결 수명: owner 철회(${name})면 수신을 거절하고 미게시 행이 나가지 않음`, async () => {
    const ctx = await wired();
    try {
      const who = await ctx.issue('a1');
      assert.equal((await ctx.send(who)).outcome, 'accepted');
      await withdraw(ctx);
      const denied = await ctx.send(who);
      assert.deepEqual([denied.status, denied.outcome], [403, 'scope_denied']);
      assert.equal(await ctx.f.publisher.deliver(), true);
      assert.equal(ctx.f.rest.messages.length, 0);
      assert.deepEqual((await ctx.db.query('SELECT state FROM outbox')).rows.map(row => (row as { state: string }).state), ['blocked']);
      assert.deepEqual((await ctx.db.query('SELECT post_state FROM external_task_events')).rows.map(row => (row as { post_state: string }).post_state), ['blocked']);
    } finally { await ctx.close(); }
  });
}

test('R08 게시: 고정 문구가 기본, 연결별 동의 때만 정제 요약, 멘션·링크 해석 없음', async () => {
  const ctx = await wired();
  try {
    const plain = await ctx.issue('a1');
    const refused = await ctx.send(plain, { summary: '빌드 끝남' });
    assert.deepEqual([refused.status, refused.outcome], [403, 'summary_consent_required']);
    assert.equal((await ctx.send(plain)).outcome, 'accepted');
    const consented = await ctx.issue('a2', 'codex summary=on', 'session-consented');
    assert.equal(field(ctx.acks.find(a => a.id === 'a2')!.content, 'summary_consent'), 'true');
    assert.equal((await ctx.send(consented, { summary: '빌드 끝남 @everyone https://example.test' })).outcome, 'accepted');
    assert.equal((await ctx.send(consented, { summary: '토큰: abcdef' })).outcome, 'summary_rejected');
    while (await ctx.f.publisher.deliver());
    // 업무 시계가 멈춰 있어 게시 순서는 정해져 있지 않다.
    const posted = ctx.f.rest.messages.map(message => message.body.content);
    assert.equal(posted.length, 2);
    assert.ok(posted.some(content => content.includes(`요약: \`${FIXED_SUMMARY}\``)));
    assert.ok(posted.some(content => content.includes('요약: `빌드 끝남 @everyone https://example.test`')));
    for (const message of ctx.f.rest.messages) assert.deepEqual(message.body.allowed_mentions.parse, []);
    // 수신은 봇 작업을 만들지 않는다.
    assert.equal((await ctx.db.query('SELECT id FROM jobs')).rows.length, 0);
  } finally { await ctx.close(); }
});
