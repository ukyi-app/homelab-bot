import { after, afterEach, before, beforeEach, test } from 'node:test';
import assert from 'node:assert/strict';
import { AWAY_GRACE_MS, presenceOf, showAway } from '../src/away.js';
import { DEFAULTS } from '../src/contracts.js';
import type { Scope } from '../src/contracts.js';
import { GatewaySession } from '../src/gateway.js';
import type { GatewayOptions, PresenceStatus } from '../src/gateway.js';
import { FakeGateway, until } from './fake-gateway.js';
import type { GatewayPayload } from './fake-gateway.js';
import { event, fixture, localDatabase, thread } from './helpers.js';

// C20 자리 비움(AC-15, AC-14의 💤). 경계 S1: 가짜 Gateway·가짜 Discord REST와 저장소(PGlite).
// 실제 Discord에는 연결하지 않는다.
let gw: FakeGateway;
let session: GatewaySession | undefined;
let database: Awaited<ReturnType<typeof localDatabase>>;
before(async () => { database = await localDatabase(); });
after(async () => { await database.pg.close(); });
let f: Awaited<ReturnType<typeof fixture>>;
beforeEach(async () => {
  gw = new FakeGateway(); gw.options.identifyIntervalMs = 200; await gw.start();
  await database.pg.exec('TRUNCATE events,conversations,jobs,results,outbox,schedules,denied_actors,controls,audit,incidents,model_pauses,model_limit_state RESTART IDENTITY CASCADE');
  f = await fixture(database.db);
});
afterEach(async () => { await session?.stop(200); session = undefined; await gw.close(); });

function startGateway(presence: () => Promise<PresenceStatus>, overrides: Partial<GatewayOptions> = {}) {
  let last = -Infinity;
  session = new GatewaySession({
    token: 'fixture-token', gatewayUrl: async () => ({ url: gw.url }),
    budget: { next: async () => Math.max(Date.now(), last + 300),
      reserve: async () => { last = Math.max(Date.now(), last + 300); return { at: last, deadline: last + 50 }; },
      backoff: () => 10 },
    health: { gateway: () => {} },
    dispatch: async () => {},
    allowUrl: url => url.protocol === 'ws:' && url.hostname === '127.0.0.1', random: () => 0,
    presence,
    ...overrides,
  });
  session.start();
  return session;
}
// 봇이 Gateway로 보낸 상태 바꾸기(op 3)의 status만, 연결마다 받은 순서대로 모은다.
const statuses = (connection = gw.connections.at(-1)) => (connection?.received ?? []).filter((p: GatewayPayload) => p.op === 3)
  .map(p => (p.d as { status: string }).status);
const presencePayloads = () => gw.connections.flatMap(c => c.received.filter(p => p.op === 3));

test('AC-15 Gateway 상태: READY 뒤 그때의 상태를 보내고, 멈춤이면 idle·풀리면 online으로 바꾸며 같은 상태는 다시 보내지 않는다', async () => {
  let paused = false;
  const gateway = startGateway(async () => paused ? 'idle' : 'online');
  await until(() => statuses().length === 1);
  assert.deepEqual(statuses(), ['online']);
  paused = true;
  gateway.setPresence('idle');
  gateway.setPresence('idle');
  await until(() => statuses().length === 2);
  paused = false;
  gateway.setPresence('online');
  await until(() => statuses().length === 3);
  assert.deepEqual(statuses(), ['online', 'idle', 'online']);
  // 문서(Update Presence)의 네 칸을 모두 보낸다. 활동은 두지 않고 afk는 false다.
  for (const payload of presencePayloads()) {
    const d = payload.d as Record<string, unknown>;
    assert.deepEqual(Object.keys(d).sort(), ['activities', 'afk', 'since', 'status']);
    assert.deepEqual(d.activities, []); assert.equal(d.afk, false);
    assert.equal(d.since === null, d.status === 'online');
  }
});

test('AC-15 Gateway 상태: 재연결(RESUME) 뒤와 새 IDENTIFY 뒤에도 그때의 멈춤 상태를 다시 읽어 돌려놓는다', async () => {
  let paused = true;
  startGateway(async () => paused ? 'idle' : 'online');
  await until(() => statuses().length === 1);
  assert.deepEqual(statuses(), ['idle']);
  // RESUME: 끊긴 동안 풀렸으면 online으로 돌아온다.
  paused = false;
  gw.latest.close(4000);
  await until(() => gw.connections.length === 2 && statuses(gw.connections[1]).length === 1);
  assert.ok(gw.connections[1]!.received.some(p => p.op === 6));
  assert.deepEqual(statuses(gw.connections[1]), ['online']);
  // 세션을 잃어 새 IDENTIFY: 그 사이 다시 멈췄으면 idle로 돌아온다.
  paused = true;
  gw.options.resume = 'invalid';
  gw.latest.close(4000);
  await until(() => gw.connections.some((c, i) => i >= 2 && c.received.some(p => p.op === 2)) && statuses(gw.latest).length === 1, 8000);
  assert.deepEqual(statuses(gw.latest), ['idle']);
});

test('AC-15 Gateway 상태: 연결이 없을 때 바꾼 상태는 버리지 않고 다음 연결이 그때 상태를 읽어 보낸다, 읽기 실패는 연결을 막지 않는다', async () => {
  let fail = true;
  const gateway = startGateway(async () => { if (fail) throw new Error('db_down'); return 'idle'; });
  await until(() => gw.connections.some(c => c.received.some(p => p.op === 2)));
  await new Promise(resolve => setTimeout(resolve, 50));
  assert.deepEqual(statuses(), []);
  fail = false;
  gateway.setPresence('idle');
  await until(() => statuses().length === 1);
  assert.deepEqual(statuses(), ['idle']);
});

// ---- 저장소·게시(가짜 Discord REST) ----
const MINUTE = 60_000;
// 명세 §4.5의 문장 그대로다. 원인·시각·'/' 명령이 없어야 한다.
const AWAY_LINE = '지금은 잠깐 자리를 비웠어요. 돌아오면 이어서 할게요.';
const thread2: Scope = { ...thread, channel: 'fixture-thread-2' };
const limited = async () => ({ status: 'limited' as const, stopped: true as const, rateLimit: null });
const answered = async () => ({ status: 'succeeded' as const, stopped: true as const, rateLimit: null,
  output: { reply: '이어서 답했어요.', proposal: null, ack_only: false } });
async function drain() { while (await f.publisher.deliver()); }
async function receive(id: string, scope: Scope = thread) { await f.ingress.receive(event(id, { scope })); }
// 메시지마다 봇이 Discord에 보낸 반응 호출(더하기·지우기)을 순서대로. 👀는 수신 ACK가 달고(acknowledge) 그 뒤는 동기화가 맞춘다.
const reactionsOf = (message: string) => f.rest.reactions.filter(r => r.message === message).map(r => `${r.op} ${r.emoji}`);
const awayLines = async () => (await database.db.query<{ idempotency_key: string; payload: { channel: string; content: string } }>(
  "SELECT idempotency_key,payload FROM outbox WHERE payload->>'content' LIKE '%자리를 비웠어요%' ORDER BY created_at,idempotency_key")).rows;
// 재개 예약 루프가 멈춘 작업을 다시 돌리는 시각까지 간다(시각 모르는 한도는 30분 뒤).
async function resumeLater() { f.advance(30 * MINUTE); f.policy.confirmedAt = f.now(); return f.store.resumeDue(); }

test('AC-14 💤: 멈춤이 시작되면 기다리던 메시지의 👀·⏳를 💤로 바꾸고, 멈춘 동안 받은 메시지도 💤, 답한 뒤 봇 반응만 지운다', async () => {
  await receive('9001');
  await receive('9002', thread2);
  f.advance(DEFAULTS.debounceMs);
  f.setRun(limited);
  // 9001을 집는 순간 9002는 ⏳가 더해지고, 9001이 한도로 멈추면 두 메시지 모두 💤가 된다.
  assert.equal(await f.runtime.tick(), true);
  await receive('9003', thread2);
  await drain();
  assert.deepEqual(reactionsOf('9001'), ['add 💤', 'remove 👀']);
  assert.deepEqual(reactionsOf('9002').filter(r => r !== 'add ⏳' && r !== 'remove ⏳'), ['add 💤', 'remove 👀']);
  assert.deepEqual(reactionsOf('9003'), ['add 💤', 'remove 👀']);
  assert.equal(f.rest.acks.length, 3);

  assert.equal(await resumeLater(), 1);
  f.setRun(answered);
  while (await f.runtime.tick());
  await drain();
  for (const message of ['9001', '9002', '9003']) assert.equal(reactionsOf(message).at(-1), 'remove 💤', message);
  // 지우기는 봇이 단 반응(👀·⏳·💤)뿐이고, 가짜 Discord의 지우기는 봇 자신(@me) 경로 하나뿐이다.
  assert.deepEqual(f.rest.reactions.filter(r => r.op === 'remove' && !['👀', '⏳', '💤'].includes(r.emoji)), []);
  assert.equal((await database.db.query("SELECT 1 FROM controls WHERE key LIKE 'reaction:%'")).rows.length, 0);
});

test('AC-14 💤: 같은 회차 안에서 풀린 동안 받은 메시지도 다시 멈추면 💤가 되고, 안내 줄은 다시 달지 않으며, 바꿀 것이 없으면 반응 호출이 없다', async () => {
  await receive('9201');
  f.advance(DEFAULTS.debounceMs);
  f.setRun(limited);
  await f.runtime.tick();
  await drain();
  // 재개 예약 루프가 다시 돌리기 전, 멈춤 기록이 빈 틈(유예 안이라 회차는 그대로)에 받은 메시지는 👀다.
  assert.equal(await resumeLater(), 1);
  assert.equal(await f.store.syncAway(), false);
  await receive('9202', thread2);
  await drain();
  assert.deepEqual(reactionsOf('9202'), []);
  assert.equal(f.rest.acks.length, 2);
  // 다시 한도로 멈추면 같은 회차지만 기다리는 9202도 💤가 된다.
  await f.runtime.tick();
  assert.equal(await f.store.syncAway(), true);
  await drain();
  assert.deepEqual(reactionsOf('9202').filter(r => r !== 'add ⏳' && r !== 'remove ⏳'), ['add 💤', 'remove 👀']);
  assert.deepEqual(reactionsOf('9201'), ['add 💤', 'remove 👀']);
  assert.deepEqual((await awayLines()).map(row => row.idempotency_key), ['away:fixture-thread:1']);
  // 상태 루프가 계속 돌아도 이미 💤인 메시지에 반응을 다시 보내지 않는다.
  const calls = f.rest.reactions.length;
  for (let i = 0; i < 3; i++) { assert.equal(await f.store.syncAway(), true); await drain(); }
  assert.equal(f.rest.reactions.length, calls);
});

test('AC-15 자리 비움 한 줄: 멈춘 동안 스레드마다 처음 부를 때 한 번, 재시도 사이에도 같은 멈춤이고 새 멈춤이면 다시 한 번', async () => {
  await receive('9101');
  f.advance(DEFAULTS.debounceMs);
  f.setRun(limited);
  await f.runtime.tick();
  // 멈춘 스레드에는 그 자리에서 한 줄. 같은 스레드에서 다시 불러도 더 달지 않는다.
  await receive('9102');
  // 다른 스레드는 처음 부를 때 한 번.
  await receive('9103', thread2);
  await receive('9104', thread2);
  assert.deepEqual((await awayLines()).map(row => [row.idempotency_key, row.payload.channel]).sort(),
    [['away:fixture-thread-2:1', 'fixture-thread-2'], ['away:fixture-thread:1', 'fixture-thread']]);
  // 재개 예약 루프가 다시 돌렸는데 또 한도면 같은 멈춤이다. 그 사이 상태 루프가 멈춤 기록이 빈 틈을 봐도 회차는 그대로다.
  assert.equal(await resumeLater(), 1);
  assert.equal(await f.store.syncAway(), false);
  await f.runtime.tick();
  await receive('9105', thread2);
  assert.equal((await awayLines()).length, 2);

  // 풀리고 유예가 지나면 회차가 닫힌다. 그 뒤 다시 멈추면 새 회차라 다시 한 번 단다.
  assert.equal(await resumeLater(), 1);
  f.setRun(answered);
  while (await f.runtime.tick());
  assert.equal(await f.store.syncAway(), false);
  f.advance(AWAY_GRACE_MS);
  assert.equal(await f.store.syncAway(), false);
  await receive('9106');
  f.advance(DEFAULTS.debounceMs);
  f.setRun(limited);
  await f.runtime.tick();
  await receive('9107', thread2);
  const lines = await awayLines();
  assert.deepEqual(lines.map(row => row.idempotency_key).sort(),
    ['away:fixture-thread-2:1', 'away:fixture-thread-2:2', 'away:fixture-thread:1', 'away:fixture-thread:2']);
  // 원인(한도·인증·결제), 시각, '/' 재개 명령이 없다.
  for (const row of lines) {
    assert.equal(row.payload.content, AWAY_LINE);
    assert.doesNotMatch(row.payload.content, /한도|인증|결제|\d|KST|\/[a-z]/);
  }
  await drain();
  assert.ok(f.rest.messages.filter(m => m.body.content.includes(AWAY_LINE)).every(m => m.body.allowed_mentions.parse.length === 0));
});

test('AC-15 Gateway 상태(저장소 연결): 멈춤 시작 → idle, 재연결 뒤 복원, 풀리면 online, 비상 정지는 자리 비움이 아니다', async () => {
  const gateway = startGateway(async () => presenceOf(await f.store.syncAway()));
  await until(() => statuses().length === 1);
  assert.deepEqual(statuses(), ['online']);
  await receive('9201');
  f.advance(DEFAULTS.debounceMs);
  f.setRun(limited);
  await f.runtime.tick();
  await showAway(f.store, gateway);
  await until(() => statuses().length === 2);
  assert.deepEqual(statuses(), ['online', 'idle']);
  gw.latest.close(4000);
  await until(() => gw.connections.length === 2 && statuses(gw.connections[1]).length === 1);
  assert.deepEqual(statuses(gw.connections[1]), ['idle']);

  assert.equal(await resumeLater(), 1);
  f.setRun(answered);
  await f.runtime.tick();
  await showAway(f.store, gateway);
  await until(() => statuses().length === 2);
  assert.deepEqual(statuses(), ['idle', 'online']);

  await f.store.control(f.policy.owner, f.store.scopeId(thread), 'emergency-stop');
  await showAway(f.store, gateway);
  await new Promise(resolve => setTimeout(resolve, 50));
  assert.deepEqual(statuses(), ['idle', 'online']);
});
