import { after, afterEach, before, beforeEach, test } from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULTS } from '../src/contracts.js';
import type { Database } from '../src/database.js';
import type { Publisher } from '../src/main.js';
import { Store } from '../src/store.js';
import { typingStart } from '../src/typing.js';
import { FakeGateway } from './fake-gateway.js';
import { localDatabase, fixture, event } from './helpers.js';
import { GUILD, OWNER, THREAD, SignalRest, bootSignal, waitFor } from './signal-boot.js';

// 입력이 끝나기를 기다리는 디바운스(개선안 v2 2-3). 기본 2초, owner가 입력 중이면 작업 생성 뒤 최대 15초까지 미룬다.
let database: Awaited<ReturnType<typeof localDatabase>>;
let f: Awaited<ReturnType<typeof fixture>>;
let logs: { event: string; detail?: Record<string, unknown> }[];
before(async () => { database = await localDatabase(); });
beforeEach(async () => {
  const tables = (await database.pg.query<{ tablename: string }>(
    "SELECT tablename FROM pg_tables WHERE schemaname='public' AND tablename<>'schema_migrations'")).rows.map(r => r.tablename);
  await database.pg.exec(`TRUNCATE ${tables.join(',')} RESTART IDENTITY CASCADE`);
  f = await fixture(database.db); logs = [];
});
after(async () => { await database.pg.close(); });

const log = (event: string, detail?: Record<string, unknown>) => { logs.push({ event, detail }); };
const typing = (options: Partial<{ channel_id: string; guild_id: string; user_id: string; timestamp: number }> = {}) =>
  ({ channel_id: 'fixture-thread', guild_id: 'fixture-guild', user_id: 'fixture-owner', timestamp: Math.floor(f.now() / 1000), ...options });
const jobs = async () => (await database.db.query<{ id: string; type: string; state: string; priority: number; available_at: string; created_at: string }>(
  'SELECT * FROM jobs ORDER BY created_at,id')).rows.map(row => ({ ...row, available_at: Number(row.available_at), created_at: Number(row.created_at) }));

test('TYP-01 일반 chat 디바운스 기본값은 2초: 1999ms에는 실행 안 함, 2000ms에 실행', async () => {
  assert.equal(DEFAULTS.debounceMs, 2000);
  await f.ingress.receive(event('m1'));
  f.advance(1999); assert.equal(await f.runtime.tick(), false);
  f.advance(1); assert.equal(await f.runtime.tick(), true);
});

test('TYP-02 owner가 입력 중이면 queued chat을 지금+8초로 미루고, 그 전에는 실행하지 않음', async () => {
  await f.ingress.receive(event('m1'));
  const created = f.now();
  f.advance(1000);
  assert.equal(await typingStart(f.store, f.gate, typing(), log), 1);
  assert.equal((await jobs())[0]!.available_at, created + 9000);
  f.advance(7999); assert.equal(await f.runtime.tick(), false);
  f.advance(1); assert.equal(await f.runtime.tick(), true);
});

test('TYP-03 미룸 상한은 작업 생성 + 15초, 이미 더 늦으면 줄이지 않음', async () => {
  await f.ingress.receive(event('m1'));
  const created = f.now();
  f.advance(10_000);
  assert.equal(await typingStart(f.store, f.gate, typing(), log), 1);
  assert.equal((await jobs())[0]!.available_at, created + 15_000);
  f.advance(4000);
  assert.equal(await typingStart(f.store, f.gate, typing(), log), 0);
  assert.equal((await jobs())[0]!.available_at, created + 15_000);
  f.advance(1000); assert.equal(await f.runtime.tick(), true);
});

test('TYP-04 새 메시지가 오면 기존 대체 로직이 앞 작업을 대체하고 새 작업의 15초 상한이 다시 시작', async () => {
  await f.ingress.receive(event('m1'));
  f.advance(1000); await typingStart(f.store, f.gate, typing(), log);
  f.advance(1000); await f.ingress.receive(event('m2', { mention: false }));
  const second = f.now();
  const [first, next] = await jobs();
  assert.equal(first!.state, 'superseded');
  assert.equal(next!.available_at, second + DEFAULTS.debounceMs);
  f.advance(12_000); await typingStart(f.store, f.gate, typing(), log);
  assert.equal((await jobs())[1]!.available_at, second + 15_000);
});

test('TYP-05 owner 아님·다른 guild·guild 없음(DM)·다른 채널·오래된 timestamp는 무시', async () => {
  await f.ingress.receive(event('m1'));
  const before = (await jobs())[0]!.available_at;
  f.advance(500);
  for (const input of [typing({ user_id: 'fixture-intruder' }), typing({ guild_id: 'fixture-other-guild' }),
    { channel_id: 'fixture-thread', user_id: 'fixture-owner', timestamp: Math.floor(f.now() / 1000) },
    typing({ channel_id: 'fixture-other-thread' }), typing({ timestamp: Math.floor((f.now() - 11_000) / 1000) })])
    assert.equal(await typingStart(f.store, f.gate, input, log), 0);
  assert.equal((await jobs())[0]!.available_at, before);
  // 잘못된 모양(필드 누락·숫자 아닌 timestamp)도 오류 없이 무시한다.
  assert.equal(await typingStart(f.store, f.gate, { channel_id: 'fixture-thread' }, log), 0);
  assert.equal(await typingStart(f.store, f.gate, typing({ timestamp: 'x' as unknown as number }), log), 0);
});

test('TYP-06 구독 꺼진(inactive)·gap인 대화, 철회된 owner는 무시', async () => {
  await f.ingress.receive(event('m1'));
  const before = (await jobs())[0]!.available_at;
  await database.db.query('UPDATE conversations SET active=false');
  assert.equal(await typingStart(f.store, f.gate, typing(), log), 0);
  await database.db.query('UPDATE conversations SET active=true,gap=true');
  assert.equal(await typingStart(f.store, f.gate, typing(), log), 0);
  await database.db.query('UPDATE conversations SET gap=false');
  await database.db.query(`INSERT INTO denied_actors(actor_id,created_at) VALUES ('fixture-owner',0)`);
  assert.equal(await typingStart(f.store, f.gate, typing(), log), 0);
  assert.equal((await jobs())[0]!.available_at, before);
});

test('TYP-07 running·/urgent·read·task는 건드리지 않음', async () => {
  await f.ingress.receive(event('u1', { kind: 'command', command: 'urgent' }));
  const urgent = (await jobs())[0]!;
  assert.equal(urgent.priority, 0);
  assert.equal(await typingStart(f.store, f.gate, typing(), log), 0);
  assert.equal((await jobs())[0]!.available_at, urgent.available_at);
  // running chat
  assert.equal(await f.runtime.tick(), true);
  await f.ingress.receive(event('m1'));
  await database.db.query("UPDATE jobs SET state='running' WHERE event_id=(SELECT id FROM events WHERE delivery_id='m1')");
  // read·task(일반 우선순위여도 chat이 아니면 제외)
  for (const [id, type] of [['r1', 'read'], ['t1', 'task']] as const) {
    await f.ingress.receive(event(id, { mention: false }));
    await database.db.query('UPDATE jobs SET type=$1 WHERE event_id=(SELECT id FROM events WHERE delivery_id=$2)', [type, id]);
  }
  const before = await jobs();
  f.advance(100);
  assert.equal(await typingStart(f.store, f.gate, typing(), log), 0);
  assert.deepEqual(await jobs(), before);
});

test('TYP-08 DB·정책 오류는 삼키고 로그만 남김(예외를 밖으로 던지지 않음)', async () => {
  await f.ingress.receive(event('m1'));
  const broken: Database = {
    query: async (sql, params) => { if (/UPDATE jobs/.test(sql)) throw new Error('fixture_db_down'); return database.db.query(sql, params); },
    transaction: (fn, deadline) => database.db.transaction(fn, deadline),
  };
  assert.equal(await typingStart(new Store(broken, f.now), f.gate, typing(), log), 0);
  f.setPolicyUnavailable(true);
  assert.equal(await typingStart(f.store, f.gate, typing(), log), 0);
  assert.deepEqual(logs.map(l => l.event), ['typing_hint_failed', 'typing_hint_failed']);
  assert.equal(logs[0]!.detail?.reason, 'fixture_db_down');
});

// 진입점 배선: TYPING_START는 기존 필터 앞에서 처리하고, 실패해도 history gap 장벽(guard)을 세우지 않는다.
let gw: FakeGateway;
let publisher: Publisher | undefined;
afterEach(async () => { await publisher?.stop(); publisher = undefined; await gw?.close(); });
async function bootWith(db: Database) {
  gw = new FakeGateway(); gw.options.identifyIntervalMs = 250; await gw.start();
  const rest = new SignalRest();
  publisher = await bootSignal({ db, rest, gw, logs });
  await database.db.query(`INSERT INTO conversations(id,owner_id,scope,channel_id,created_at,active)
    VALUES ($1,$2,$3,$4,0,true)`, [`thread:${GUILD}:${THREAD}`, OWNER, JSON.stringify({ kind: 'thread', guild: GUILD, channel: THREAD, parent: 'fixture-chat' }), THREAD]);
  return rest;
}
const gatewayTyping = (s: number, d: Record<string, unknown>) => gw.dispatch(gw.latest, s, 'TYPING_START', d);

test('TYP-09 진입점: Gateway TYPING_START가 queued chat을 미룸', async () => {
  await bootWith(database.db);
  gw.dispatch(gw.latest, 2, 'MESSAGE_CREATE', { id: '1000', channel_id: THREAD, guild_id: GUILD, author: { id: OWNER }, content: 'fixture-message' });
  assert.ok(await waitFor(async () => (await jobs()).length === 1));
  const job = (await jobs())[0]!;
  gatewayTyping(3, { channel_id: THREAD, guild_id: GUILD, user_id: OWNER, timestamp: Math.floor(Date.now() / 1000) });
  assert.ok(await waitFor(async () => (await jobs())[0]!.available_at > job.available_at));
  assert.ok((await jobs())[0]!.available_at <= job.created_at + 15_000);
});

test('TYP-10 진입점: typing 처리 DB 오류는 삼키고 guard를 부르지 않으며 다음 이벤트는 그대로 처리', async () => {
  let fail = false;
  const broken: Database = {
    query: async (sql, params) => { if (fail && /UPDATE jobs/.test(sql)) throw new Error('fixture_db_down'); return database.db.query(sql, params); },
    transaction: (fn, deadline) => database.db.transaction(fn, deadline),
  };
  await bootWith(broken);
  gw.dispatch(gw.latest, 2, 'MESSAGE_CREATE', { id: '1000', channel_id: THREAD, guild_id: GUILD, author: { id: OWNER }, content: 'fixture-message' });
  assert.ok(await waitFor(async () => (await jobs()).length === 1));
  fail = true;
  gatewayTyping(3, { channel_id: THREAD, guild_id: GUILD, user_id: OWNER, timestamp: Math.floor(Date.now() / 1000) });
  // 잘못된 모양도 같은 경로로 버린다.
  gatewayTyping(4, { channel_id: THREAD });
  assert.ok(await waitFor(() => logs.some(l => l.event === 'typing_hint_failed')));
  fail = false;
  gw.dispatch(gw.latest, 5, 'MESSAGE_CREATE', { id: '1001', channel_id: THREAD, guild_id: GUILD, author: { id: OWNER }, content: 'fixture-message-2' });
  assert.ok(await waitFor(async () => (await jobs()).length === 2));
  assert.equal(logs.some(l => l.event === 'recovery_guard' || l.event === 'recovery_guard_failed' || l.event === 'discord_event_failed'), false);
  const gap = (await database.db.query<{ gap: boolean }>('SELECT gap FROM conversations WHERE channel_id=$1', [THREAD])).rows[0]!.gap;
  assert.equal(gap, false);
});
