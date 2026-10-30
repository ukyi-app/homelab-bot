import { after, afterEach, before, beforeEach, test } from 'node:test';
import assert from 'node:assert/strict';
import { GATEWAY_INTENTS, GatewaySession, discordGatewayUrl } from '../src/gateway.js';
import type { GatewayOptions } from '../src/gateway.js';
import { GatewayBudget } from '../src/health.js';
import { Store } from '../src/store.js';
import { FakeGateway, until } from './fake-gateway.js';
import { localDatabase } from './helpers.js';

// 실제 Node 24 WebSocket 클라이언트 + loopback 가짜 Gateway. 실제 Discord에는 연결하지 않는다.
let gw: FakeGateway;
let session: GatewaySession | undefined;
let database: Awaited<ReturnType<typeof localDatabase>>;
before(async () => { database = await localDatabase(); });
after(async () => { await database.pg.close(); });
beforeEach(async () => { gw = new FakeGateway(); await gw.start(); });
afterEach(async () => { await session?.stop(200); session = undefined; await gw.close(); });

function start(overrides: Partial<GatewayOptions> = {}) {
  const record = { events: [] as [string, unknown][], health: [] as boolean[], readies: [] as unknown[], identifies: 0, logs: [] as string[] };
  session = new GatewaySession({
    token: 'fixture-token', gatewayUrl: async () => ({ url: gw.url }),
    budget: { identify: async () => { record.identifies++; return true; }, backoff: () => 10 },
    health: { gateway: connected => record.health.push(connected) },
    dispatch: async (type, data) => { record.events.push([type, data]); },
    onReady: ready => { record.readies.push(ready); },
    log: event => record.logs.push(event),
    allowUrl: url => url.protocol === 'ws:' && url.hostname === '127.0.0.1', random: () => 0,
    ...overrides,
  });
  session.start();
  return record;
}
const ready = async () => until(() => gw.connections.some(c => c.received.some(p => p.op === 2)));

test('EVENT-03 Gateway: HELLO 뒤 IDENTIFY(intents 33281, DM 끔)·heartbeat·READY, 이벤트는 받은 순서대로 처리기에', async () => {
  const record = start();
  await ready();
  const connection = gw.latest;
  assert.equal(connection.query.get('v'), '10'); assert.equal(connection.query.get('encoding'), 'json');
  const identify = connection.received.find(p => p.op === 2)!.d as { token: string; intents: number };
  assert.equal(identify.token, 'fixture-token'); assert.equal(identify.intents, GATEWAY_INTENTS); assert.equal(GATEWAY_INTENTS, 1 | 512 | 32768);
  assert.equal(GATEWAY_INTENTS & 4096, 0);
  await until(() => record.readies.length === 1);
  assert.deepEqual(record.readies, [{ applicationId: 'fixture-app', userId: 'fixture-bot' }]);
  assert.deepEqual(record.health, [true]); assert.equal(record.identifies, 1);
  gw.dispatch(connection, 2, 'MESSAGE_CREATE', { id: 'm-2' });
  gw.dispatch(connection, 3, 'INTERACTION_CREATE', { id: 'i-3' });
  gw.dispatch(connection, 4, 'GUILD_CREATE', { id: 'g' });
  await until(() => record.events.length === 3);
  assert.deepEqual(record.events.map(e => e[0]), ['MESSAGE_CREATE', 'INTERACTION_CREATE', 'GUILD_CREATE']);
  // 첫 heartbeat는 지터 0으로 곧바로, d는 마지막 sequence(null 또는 숫자)다.
  await until(() => connection.received.some(p => p.op === 1));
});

test('EVENT-03 연결이 끊기면 resume_gateway_url로 RESUME(session_id·마지막 seq), IDENTIFY 예산을 쓰지 않음', async () => {
  const record = start();
  await ready(); await until(() => record.readies.length === 1);
  gw.dispatch(gw.latest, 2, 'MESSAGE_CREATE', { id: 'm-2' });
  gw.dispatch(gw.latest, 3, 'MESSAGE_CREATE', { id: 'm-3' });
  await until(() => record.events.length === 2);
  gw.latest.destroy();
  await until(() => gw.connections.length === 2 && gw.latest.received.some(p => p.op === 6));
  assert.equal(gw.latest.path, '/resume');
  assert.deepEqual(gw.latest.received.find(p => p.op === 6)!.d, { token: 'fixture-token', session_id: 'session-1', seq: 3 });
  await until(() => record.health.length === 3);
  assert.deepEqual(record.health, [true, false, true]);
  assert.equal(record.identifies, 1); assert.equal(record.readies.length, 1);
});

test('EVENT-03 RESUME 실패(INVALID_SESSION d=false)면 세션을 버리고 1초 뒤 새 IDENTIFY, READY가 다시 와 누락 대조를 부름', async () => {
  gw.options.resume = 'invalid';
  const record = start();
  await ready(); await until(() => record.readies.length === 1);
  gw.latest.destroy();
  await until(() => gw.connections.length === 2 && gw.latest.received.some(p => p.op === 6));
  const invalidAt = Date.now();
  await until(() => gw.connections.length === 3 && gw.latest.received.some(p => p.op === 2));
  assert.ok(Date.now() - invalidAt >= 900, 'INVALID_SESSION 뒤 1~5초 대기');
  assert.equal(gw.latest.path, '/');
  await until(() => record.readies.length === 2);
  assert.equal(record.identifies, 2);
});

test('EVENT-03 heartbeat ACK가 없으면 좀비 연결로 보고 1000이 아닌 코드로 끊은 뒤 RESUME', async () => {
  gw.options.heartbeatInterval = 60; gw.options.ack = false;
  const record = start();
  await ready(); await until(() => record.readies.length === 1);
  const first = gw.latest;
  await until(() => first.closeCode !== undefined);
  assert.equal(first.closeCode, 4900);
  await until(() => gw.connections.length >= 2 && gw.connections[1]!.received.some(p => p.op === 6));
  assert.ok(record.logs.includes('gateway_drop'));
});

test('EVENT-03 op 7 RECONNECT 요청은 끊고 RESUME', async () => {
  const record = start();
  await ready(); await until(() => record.readies.length === 1);
  gw.latest.send({ op: 7, d: null });
  await until(() => gw.connections.length === 2 && gw.latest.received.some(p => p.op === 6));
  assert.equal(gw.connections[0]!.closeCode, 4900); assert.equal(record.identifies, 1);
});

test('OPS-01 IDENTIFY 예산(24시간 900회)이 다 차면 연결하지 않고 기다림, 연결 지표는 0', async () => {
  await database.pg.exec('TRUNCATE audit,controls RESTART IDENTITY CASCADE');
  const now = 1_800_000_000_000;
  const store = new Store(database.db, () => now);
  await database.pg.query(`INSERT INTO audit(kind,subject,detail,created_at)
    SELECT 'identify','gateway','{}',$1 FROM generate_series(1,900)`, [now - 3_600_000]);
  const budget = new GatewayBudget(store);
  const record = start({ budget: { identify: () => budget.identify(), backoff: () => 10 } });
  await until(() => record.logs.includes('gateway_retry'));
  await new Promise(resolve => setTimeout(resolve, 100));
  assert.equal(gw.connections.length, 0); assert.deepEqual(record.health, []);
  const count = (await database.db.query<{ count: string }>("SELECT count(*) FROM audit WHERE kind='identify'")).rows[0]!;
  assert.equal(Number(count.count), 900);
});

test('OPS-01 세션 시작 한도(session_start_limit.remaining=0)는 reset_after만큼 기다림, Gateway 주소는 discord.gg wss만', async () => {
  const api = (body: unknown) => ({ request: async () => body });
  const limited = discordGatewayUrl(api({ url: 'wss://gateway.discord.gg', session_start_limit: { remaining: 0, reset_after: 120_000, total: 1000 } }));
  assert.deepEqual(await limited(), { url: 'wss://gateway.discord.gg', retryAfterMs: 120_000 });
  const fine = discordGatewayUrl(api({ url: 'wss://gateway.discord.gg', session_start_limit: { remaining: 999, reset_after: 0 } }));
  assert.deepEqual(await fine(), { url: 'wss://gateway.discord.gg' });
  for (const url of ['ws://gateway.discord.gg', 'wss://evil.example', 'wss://discord.gg.evil.example']) {
    await assert.rejects(discordGatewayUrl(api({ url, session_start_limit: { remaining: 1, reset_after: 0 } }))());
  }
  const record = start({ gatewayUrl: async () => ({ url: gw.url, retryAfterMs: 60_000 }) });
  await until(() => record.logs.includes('gateway_retry'));
  assert.equal(gw.connections.length, 0); assert.equal(record.identifies, 0);
});

for (const code of [4004, 4014]) test(`EVENT-03 치명 close 코드 ${code}(인증 실패·intent 불허)는 재연결하지 않고 멈춤`, async () => {
  gw.options.closeAfterHello = code;
  const record = start();
  await until(() => record.logs.includes('gateway_halted'));
  await new Promise(resolve => setTimeout(resolve, 100));
  assert.equal(gw.connections.length, 1); assert.equal(session!.state.halted, true);
});

test('EVENT-03 stop()은 타이머를 정리하고 1000으로 닫은 뒤 다시 연결하지 않음', async () => {
  const record = start();
  await ready(); await until(() => record.readies.length === 1);
  await session!.stop(1000);
  assert.equal(gw.latest.closeCode, 1000);
  await new Promise(resolve => setTimeout(resolve, 100));
  assert.equal(gw.connections.length, 1); assert.deepEqual(record.health, [true, false]);
  session = undefined;
});
