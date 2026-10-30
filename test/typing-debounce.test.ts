import { after, afterEach, before, beforeEach, test } from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULTS } from '../src/contracts.js';
import type { Database } from '../src/database.js';
import type { Publisher } from '../src/main.js';
import { Store } from '../src/store.js';
import { TYPING_BUDGET_MS, typingHints, typingStart } from '../src/typing.js';
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

// 트랜잭션 안 질의까지 감싸 조건에 맞는 SQL을 실패시킨다(typing 처리는 한 트랜잭션 안에서 돈다).
function failing(inner: Database, match: (sql: string) => boolean): Database {
  const wrap = (db: Database): Database => ({
    query: async <T>(sql: string, params?: unknown[]) => { if (match(sql)) throw new Error('fixture_db_down'); return db.query<T>(sql, params); },
    transaction: (fn, deadline) => db.transaction(tx => fn(wrap(tx)), deadline),
  });
  return wrap(inner);
}

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
  const broken = failing(database.db, sql => /UPDATE jobs/.test(sql));
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
  const broken = failing(database.db, sql => fail && /UPDATE jobs/.test(sql));
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

// typing 처리(typingStart 안)의 첫 DB 접근 하나를 붙잡는다. PGlite는 연결이 하나라 트랜잭션 안에서 붙잡으면 다른 질의까지
// 막히므로, 트랜잭션을 시작하기 전(운영의 연결 대기에 해당)에 붙잡는다. 수정 전 코드는 트랜잭션 없이 바로 질의한다.
function stallTyping(inner: Database) {
  let armed = false;
  let reached!: () => void, release!: () => void, done!: () => void;
  const paused = new Promise<void>(resolve => { reached = resolve; });
  const held = new Promise<void>(resolve => { release = resolve; });
  const finished = new Promise<void>(resolve => { done = resolve; });
  let calls = 0;
  const hit = () => {
    if (!/typingStart/.test(new Error().stack ?? '')) return false;
    calls++;
    if (!armed) return false;
    armed = false; reached(); return true;
  };
  const db: Database = {
    query: async <T>(sql: string, params?: unknown[]) => {
      if (!hit()) return inner.query<T>(sql, params);
      await held;
      try { return await inner.query<T>(sql, params); } finally { done(); }
    },
    transaction: async (fn, deadline) => {
      if (!hit()) return inner.transaction(fn, deadline);
      await held;
      try { return await inner.transaction(fn, deadline); } finally { done(); }
    },
  };
  return { db, arm: () => { armed = true; }, paused, release: () => release(), finished, calls: () => calls };
}

test('TYP-11 진입점: typing DB가 느려도 뒤 MESSAGE_CREATE·상호작용은 바로 처리하고, 힌트 뒤에 만든 작업은 늘리지 않음', async () => {
  const slow = stallTyping(database.db);
  const rest = await bootWith(slow.db);
  slow.arm();
  gatewayTyping(2, { channel_id: THREAD, guild_id: GUILD, user_id: OWNER, timestamp: Math.floor(Date.now() / 1000) });
  await slow.paused;
  try {
    gw.dispatch(gw.latest, 3, 'MESSAGE_CREATE', { id: '1000', channel_id: THREAD, guild_id: GUILD, author: { id: OWNER }, content: 'fixture-message' });
    gw.dispatch(gw.latest, 4, 'INTERACTION_CREATE', { id: '9001', token: 'fixture-token-9001', type: 2, channel_id: THREAD, guild_id: GUILD,
      member: { user: { id: OWNER } }, data: { name: 'chat', options: [{ name: 'text', value: 'fixture-command' }] } });
    // 힌트가 붙잡혀 있는 동안 둘 다 처리된다(Gateway 직렬 처리를 막지 않는다).
    // 상호작용 응답 기한(3초)보다 짧게 본다. 수정 전에는 풀어 줄 때까지 영영 막힌다.
    assert.ok(await waitFor(async () => (await jobs()).length >= 1, 2000), 'MESSAGE_CREATE가 typing 뒤에서 막힘');
    assert.ok(await waitFor(() => rest.calls.some(c => c.path.startsWith('/interactions/9001/')), 2000), '상호작용 응답이 typing 뒤에서 막힘');
  } finally { slow.release(); }
  await slow.finished;
  await new Promise(resolve => setTimeout(resolve, 50));
  // 늦게 끝난 힌트는 자기 뒤에 도착한 메시지의 작업을 늘리지 않는다(기본 2초 그대로).
  // /chat이 앞 메시지 작업을 대체하므로 남은 queued 작업(둘 다 힌트 뒤에 생김)을 본다.
  const queued = (await jobs()).filter(job => job.state === 'queued');
  assert.equal(queued.length, 1);
  assert.equal(queued[0]!.available_at, queued[0]!.created_at + DEFAULTS.debounceMs);
  // 붙잡힌 시간도 힌트 기한(1.5초)에 들어가므로, 부하로 늦어지면 UPDATE 없이 기한 초과로 버려질 수 있다(그것도 정상).
  // 받은 시각 조건 자체는 TYP-12가 결정적으로 본다.
  assert.equal(logs.some(l => l.event === 'typing_hint_failed'), false, JSON.stringify(logs));
});

test('TYP-12 늦게 끝난 힌트도 자기 뒤에 만든 작업은 늘리지 않음(받은 시각 기준), 앞의 작업은 받은 시각+8초까지', async () => {
  await f.ingress.receive(event('m1'));
  const receivedAt = f.now();
  f.advance(1000);
  await f.ingress.receive(event('m2', { mention: false }));
  f.advance(1000);
  const before = await jobs();
  assert.equal(await typingStart(f.store, f.gate, typing({ timestamp: Math.floor(receivedAt / 1000) }), log, { receivedAt }), 0);
  assert.deepEqual(await jobs(), before);
  // 대체되지 않은 앞 작업이면 받은 시각 기준으로 늘린다(처리 시각이 아니다).
  await database.db.query("UPDATE jobs SET state='queued' WHERE state='superseded'");
  assert.equal(await typingStart(f.store, f.gate, typing({ timestamp: Math.floor(receivedAt / 1000) }), log, { receivedAt }), 1);
  assert.equal((await jobs())[0]!.available_at, receivedAt + 8000);
});

test('TYP-13 같은 채널 힌트가 처리 중이면 새 힌트는 버림(합치기), 끝나면 다시 받음, 다른 채널은 따로', async () => {
  await f.ingress.receive(event('m1'));
  const slow = stallTyping(database.db);
  const tasks: Promise<void>[] = [];
  const hint = typingHints(new Store(slow.db, f.now), f.gate, log, task => { tasks.push(task); });
  slow.arm();
  hint(typing());
  await slow.paused;
  hint(typing()); hint(typing());
  hint(typing({ channel_id: 'fixture-other-thread' }));
  hint({ guild_id: GUILD });
  assert.equal(tasks.length, 2);
  slow.release();
  await Promise.all(tasks);
  assert.equal(slow.calls(), 2);
  hint(typing());
  await Promise.all(tasks);
  assert.equal(tasks.length, 3);
  assert.deepEqual(logs, []);
});

test('TYP-14 처리 기한(기본 1.5초)을 넘기면 힌트를 버리고 로그만(작업 그대로)', async () => {
  assert.equal(TYPING_BUDGET_MS, 1500);
  await f.ingress.receive(event('m1'));
  const before = await jobs();
  const slow = stallTyping(database.db);
  const tasks: Promise<void>[] = [];
  const hint = typingHints(new Store(slow.db, f.now), f.gate, log, task => { tasks.push(task); }, 50);
  slow.arm();
  hint(typing());
  await slow.paused;
  await new Promise(resolve => setTimeout(resolve, 100));
  slow.release();
  await Promise.all(tasks);
  assert.deepEqual(await jobs(), before);
  assert.deepEqual(logs.map(l => l.event), ['typing_hint_expired']);
});
