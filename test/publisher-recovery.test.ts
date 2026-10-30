import { after, before, beforeEach, test } from 'node:test';
import assert from 'node:assert/strict';
import { Denied, RateLimited } from '../src/contracts.js';
import type { EventInput, Scope } from '../src/contracts.js';
import type { Database } from '../src/database.js';
import { DiscordIngress } from '../src/discord.js';
import type { RecoveryOutcome } from '../src/discord.js';
import { RecoveryScheduler } from '../src/recovery.js';
import { Store } from '../src/store.js';
import { fixture, localDatabase, thread } from './helpers.js';

// RecoveryScheduler 단위 시험(가상 시계). 진입점 경로는 test/publisher-main.test.ts의 P1 시험이 본다.
let database: Awaited<ReturnType<typeof localDatabase>>;
let time: number;
let store: Store;
before(async () => { database = await localDatabase(); });
after(async () => { await database.pg.close(); });
beforeEach(async () => {
  await database.pg.exec('TRUNCATE conversations RESTART IDENTITY CASCADE');
  time = 1_800_000_000_000;
  store = new Store(database.db, () => time);
});
const scope = (channel: string, kind: Scope['kind'] = 'thread'): Scope =>
  ({ kind, guild: 'fixture-guild', channel, parent: kind === 'thread' ? 'fixture-chat' : null });
async function conversation(channel: string, options: { kind?: Scope['kind']; active?: boolean } = {}) {
  const s = scope(channel, options.kind);
  await database.db.query(`INSERT INTO conversations(id,owner_id,scope,channel_id,created_at,active,checkpoint) VALUES ($1,'fixture-owner',$2,$3,$4,$5,'100')`,
    [store.scopeId(s), JSON.stringify(s), channel, time, options.active ?? true]);
}
const gap = async (channel: string) => (await database.db.query<{ gap: boolean }>('SELECT gap FROM conversations WHERE channel_id=$1', [channel])).rows[0]!.gap;

test('P1-1 장벽은 활성 스레드·DM에만 gap을 세우고 체크포인트는 그대로(부모 채널·비활성 대화 제외)', async () => {
  await conversation('a'); await conversation('dm', { kind: 'dm' }); await conversation('parent', { kind: 'channel' }); await conversation('off', { active: false });
  const scheduler = new RecoveryScheduler(store, async () => 'done', () => {});
  assert.equal(await scheduler.barrier(), 2);
  assert.deepEqual([await gap('a'), await gap('dm'), await gap('parent'), await gap('off')], [true, true, false, false]);
  assert.deepEqual((await database.db.query<{ checkpoint: string }>('SELECT DISTINCT checkpoint FROM conversations')).rows, [{ checkpoint: '100' }]);
  assert.equal(scheduler.size, 2);
});

test('PR12 guard()는 그 채널의 활성 스레드·DM에만 장벽을 세우고 진행 중 복구 토큰을 지움(다른 대화·부모 채널은 그대로)', async () => {
  await conversation('a'); await conversation('b'); await conversation('parent', { kind: 'channel' }); await conversation('off', { active: false });
  await database.db.query("UPDATE conversations SET recovery_token='old-token',recovery_until=$1 WHERE channel_id='a'", [time + 30_000]);
  const scheduler = new RecoveryScheduler(store, async () => 'done', () => {});
  assert.equal(await scheduler.guard('a'), 1);
  assert.equal(await scheduler.guard('parent'), 0);
  assert.equal(await scheduler.guard('off'), 0);
  assert.deepEqual([await gap('a'), await gap('b'), await gap('parent'), await gap('off')], [true, false, false, false]);
  assert.equal((await database.db.query<{ recovery_token: string | null }>("SELECT recovery_token FROM conversations WHERE channel_id='a'")).rows[0]!.recovery_token, null);
  assert.equal(scheduler.size, 1);
  assert.equal(await scheduler.runDue(), true); assert.equal(scheduler.size, 0);
});

test('P1-2 일시 실패는 대화별 지수 백오프, 429는 retry_after 이상, 한도 초과(budget)·정책 거부는 다시 돌리지 않음', async () => {
  await conversation('a'); await conversation('b'); await conversation('c');
  const plans: Record<string, (RecoveryOutcome | Error)[]> = {
    a: [new Error('fixture_timeout'), new RateLimited(5000), 'done'], b: ['budget'], c: [new Denied()] };
  const calls: string[] = [];
  const logs: string[] = [];
  const scheduler = new RecoveryScheduler(store, async s => {
    calls.push(s.channel);
    const next = plans[s.channel]!.shift()!;
    if (next instanceof Error) throw next;
    return next;
  }, event => logs.push(event), attempt => 1000 * 2 ** attempt);
  await scheduler.barrier();
  while (await scheduler.runDue());
  assert.deepEqual(calls.sort(), ['a', 'b', 'c']);
  assert.ok(logs.includes('recovery_gap_manual') && logs.includes('recovery_denied'));
  assert.equal(scheduler.size, 1);
  time += 999; assert.equal(await scheduler.runDue(), false);
  time += 1; assert.equal(await scheduler.runDue(), true);
  // 두 번째 실패는 429(5초): 백오프 2초보다 길게 기다린다.
  time += 4999; assert.equal(await scheduler.runDue(), false);
  time += 1; assert.equal(await scheduler.runDue(), true);
  assert.equal(scheduler.size, 0);
  assert.deepEqual(calls.filter(c => c === 'a').length, 3);
  // 수동 처리할 gap은 그대로 남는다.
  assert.equal(await gap('b'), true);
});

test('P1-2 skipped는 구독이 살아 있고 gap이면 다시 시도, 구독이 꺼졌거나 gap이 풀렸으면 끝', async () => {
  await conversation('a'); await conversation('b');
  const calls: string[] = [];
  const scheduler = new RecoveryScheduler(store, async s => {
    calls.push(s.channel);
    if (s.channel === 'b') await database.db.query('UPDATE conversations SET active=false WHERE channel_id=$1', ['b']);
    return 'skipped';
  }, () => {}, () => 1000);
  await scheduler.barrier();
  while (await scheduler.runDue());
  assert.equal(scheduler.size, 1);
  await database.db.query('UPDATE conversations SET gap=false WHERE channel_id=$1', ['a']);
  time += 1000; await scheduler.runDue();
  assert.equal(scheduler.size, 0); assert.deepEqual(calls, ['a', 'b', 'a']);
});

// ---- 리뷰 2라운드(rev-pub-r2): 실제 DiscordIngress.recover()와 함께 ----
type HistoryFn = (channel: string, after: string | null) => Promise<EventInput[]>;
const setHistory = (f: Awaited<ReturnType<typeof fixture>>, history: HistoryFn) => { (f.rest as unknown as { history: HistoryFn }).history = history; };
const historyMessage = (id: string): EventInput => ({ id, actor: 'fixture-owner', scope: thread, text: `fixture-${id}`, kind: 'message' });
async function seedThread(f: Awaited<ReturnType<typeof fixture>>) {
  await database.pg.exec('TRUNCATE conversations,audit RESTART IDENTITY CASCADE');
  await database.db.query(`INSERT INTO conversations(id,owner_id,scope,channel_id,created_at,active,checkpoint) VALUES ($1,$2,$3,$4,$5,true,'100')`,
    [f.store.scopeId(thread), f.policy.owner, JSON.stringify(thread), thread.channel, f.now()]);
}
const threadRow = async () => (await database.db.query<{ checkpoint: string; gap: boolean; recovery_token: string | null }>(
  'SELECT checkpoint,gap,recovery_token FROM conversations')).rows[0]!;
const historyGaps = async () => Number((await database.db.query<{ count: string }>("SELECT count(*) FROM audit WHERE kind='history_gap'")).rows[0]!.count);
// 일치하는 질의가 돌아온 뒤 한 번 멈춘다(그 사이에 새 READY를 끼워 넣는다).
function holdingDatabase(match: (sql: string) => boolean) {
  let armed = true;
  let reached!: () => void;
  let release!: () => void;
  const atHold = new Promise<void>(resolve => { reached = resolve; });
  const gate = new Promise<void>(resolve => { release = resolve; });
  const wrap = (inner: Database): Database => ({
    query: async <T>(sql: string, params?: unknown[]) => {
      const result = await inner.query<T>(sql, params);
      if (armed && match(sql)) { armed = false; reached(); await gate; }
      return result;
    },
    transaction: (fn, deadline) => inner.transaction(tx => fn(wrap(tx)), deadline),
  });
  return { db: wrap(database.db), atHold, release: () => release() };
}

test('R2-1 마지막 정리 중 새 READY: 이전 복구가 새 장벽의 대기 항목을 지우지 못하고 새 세대 복구가 다시 돈다', async () => {
  const f = await fixture(database.db);
  await seedThread(f);
  const held = holdingDatabase(sql => sql.startsWith('UPDATE conversations SET recovery_token=NULL'));
  const store = new Store(held.db, f.now);
  const ingress = new DiscordIngress(store, f.gate.withDatabase(held.db), f.rest);
  const scheduler = new RecoveryScheduler(store, (s, o) => ingress.recover(s, o), () => {}, () => 1);
  await scheduler.barrier();
  const old = scheduler.runDue();
  await held.atHold;
  await scheduler.barrier();
  held.release(); await old;
  assert.equal(scheduler.size, 1, '새 READY의 대기 항목이 남아야 함');
  assert.equal((await threadRow()).gap, true);
  f.advance(1);
  assert.equal(await scheduler.runDue(), true);
  assert.deepEqual(await threadRow(), { checkpoint: '100', gap: false, recovery_token: null });
  assert.equal(scheduler.size, 0);
});

test('R2-1 history 처리 중 새 READY: 이전 스냅샷으로 새 장벽을 풀지 않고, 새 세대가 단절 중 메시지를 다시 읽음', async () => {
  const f = await fixture(database.db);
  await seedThread(f);
  let release!: () => void;
  let reached!: () => void;
  const atHistory = new Promise<void>(resolve => { reached = resolve; });
  const held = new Promise<void>(resolve => { release = resolve; });
  const calls: (string | null)[] = [];
  setHistory(f, async (_channel, after) => {
    calls.push(after);
    if (calls.length === 1) { reached(); await held; return []; }
    // 이전 응답 스냅샷 뒤, 단절 중에 메시지 200이 생겼다.
    return [historyMessage('200')].filter(m => BigInt(m.id) > BigInt(after ?? '0'));
  });
  const scheduler = new RecoveryScheduler(f.store, (s, o) => f.ingress.recover(s, o), () => {}, () => 1);
  await scheduler.barrier();
  const old = scheduler.runDue();
  await atHistory;
  await scheduler.barrier();
  release(); await old;
  assert.equal((await threadRow()).gap, true, '이전 복구가 새 장벽을 풀면 안 됨');
  f.advance(1);
  while (await scheduler.runDue()) f.advance(1);
  assert.deepEqual(calls, ['100', '100']);
  const saved = (await database.db.query<{ accepted: boolean }>("SELECT accepted FROM events WHERE delivery_id='200'")).rows[0];
  assert.equal(saved?.accepted, true);
  assert.deepEqual(await threadRow(), { checkpoint: '200', gap: false, recovery_token: null });
  // 이후 live 300은 정상 처리된다.
  await f.ingress.receive({ id: '300', actor: f.policy.owner, scope: thread, text: 'live 300', kind: 'message' });
  assert.equal((await threadRow()).checkpoint, '300');
});

test('R2-2 history 페이지 처리 중 30초 복구 한도를 넘기면 skipped가 아니라 budget(수동 gap·감사), 다시 돌지 않음', async () => {
  const f = await fixture(database.db);
  await seedThread(f);
  const authorize = f.gate.authorize.bind(f.gate);
  // 외부 인가 왕복마다 400ms(가상 시계). REST 하나가 30초 걸리는 가정이 아니다.
  f.gate.authorize = async (...args: Parameters<typeof authorize>) => { const policy = await authorize(...args); f.advance(400); return policy; };
  let calls = 0;
  setHistory(f, async (_channel, after) => {
    calls++;
    return Array.from({ length: 80 }, (_, i) => historyMessage(String(101 + i))).filter(m => BigInt(m.id) > BigInt(after ?? '0'));
  });
  const outcomes: string[] = [];
  const scheduler = new RecoveryScheduler(f.store, async (s, o) => { const r = await f.ingress.recover(s, o); outcomes.push(r); return r; }, () => {}, () => 1);
  await scheduler.barrier();
  for (let i = 0; i < 3; i++) { await scheduler.runDue(); f.advance(1); }
  assert.deepEqual(outcomes, ['budget']);
  assert.equal(calls, 1);
  assert.equal(await historyGaps(), 1);
  const row = await threadRow();
  assert.equal(row.gap, true); assert.equal(row.recovery_token, null);
});

test('R2-2 마지막 checkpoint 갱신에서 30초를 넘겨도 budget', async () => {
  const f = await fixture(database.db);
  await seedThread(f);
  setHistory(f, async () => [historyMessage('101'), historyMessage('102'), historyMessage('103')]);
  const receive = f.ingress.receive.bind(f.ingress);
  // 마지막 메시지 처리 직후 한도를 넘긴다. 다음 확인은 checkpoint 갱신 transaction 안의 valid()다.
  f.ingress.receive = async (...args: Parameters<typeof receive>) => {
    const result = await receive(...args);
    if (args[0].id === '103' && args[1]) f.advance(30_001);
    return result;
  };
  assert.equal(await f.ingress.recover(thread, f.policy.owner), 'budget');
  assert.equal(await historyGaps(), 1);
  assert.equal((await threadRow()).gap, true);
});

test('R2-2 버퍼 처리 중 30초를 넘겨도 budget', async () => {
  const f = await fixture(database.db);
  await seedThread(f);
  // 장벽 뒤 live 메시지 둘이 버퍼에 들어가 있다.
  await database.db.query('UPDATE conversations SET gap=true');
  for (const id of ['201', '202']) await f.ingress.receive({ id, actor: f.policy.owner, scope: thread, text: `live ${id}`, kind: 'message' });
  assert.equal(Number((await database.db.query<{ count: string }>('SELECT count(*) FROM events WHERE buffered=true')).rows[0]!.count), 2);
  setHistory(f, async () => []);
  // 첫 버퍼를 처리한 뒤, 다음 버퍼를 꺼내는 transaction의 대화 행 잠금 시점에 한도를 넘긴다.
  let armed = false;
  const wrap = (inner: Database): Database => ({
    query: async <T>(sql: string, params?: unknown[]) => {
      const result = await inner.query<T>(sql, params);
      if (armed && sql.startsWith('SELECT * FROM conversations WHERE id=$1 FOR UPDATE')) { armed = false; f.advance(30_001); }
      return result;
    },
    transaction: (fn, deadline) => inner.transaction(tx => fn(wrap(tx)), deadline),
  });
  const db = wrap(database.db);
  const ingress = new DiscordIngress(new Store(db, f.now), f.gate.withDatabase(db), f.rest);
  const receive = ingress.receive.bind(ingress);
  ingress.receive = async (...args: Parameters<typeof receive>) => {
    const result = await receive(...args);
    if (args[0].id === '201' && args[1]) armed = true;
    return result;
  };
  assert.equal(await ingress.recover(thread, f.policy.owner), 'budget');
  assert.equal(await historyGaps(), 1);
  assert.equal((await threadRow()).gap, true);
});

// ---- 리뷰 3라운드(rev-pub-r3): gap을 푸는 마지막 transaction의 check() 뒤 DB 왕복 경계 ----
// 지정한 질의의 응답이 돌아온 직후 시계를 당긴다. 마지막 check()는 이미 통과한 뒤다.
function advancingDatabase(f: Awaited<ReturnType<typeof fixture>>, match: (sql: string) => boolean, ms: () => number) {
  let fired = false;
  const wrap = (inner: Database): Database => ({
    query: async <T>(sql: string, params?: unknown[]) => {
      const result = await inner.query<T>(sql, params);
      if (!fired && match(sql)) { fired = true; f.advance(ms()); }
      return result;
    },
    transaction: (fn, deadline) => inner.transaction(tx => fn(wrap(tx)), deadline),
  });
  return { db: wrap(database.db), fired: () => fired };
}
const emptyBufferSelect = (sql: string) => sql.startsWith('SELECT * FROM events WHERE conversation_id=$1 AND buffered=true');
const gapRelease = (sql: string) => sql.startsWith('UPDATE conversations SET gap=false WHERE id=$1');

test('R3-1 리뷰어 재현: 인가 왕복 누적 + 마지막 빈 버퍼 조회 응답에서 30초를 넘기면 done이 아니라 budget', async () => {
  const f = await fixture(database.db);
  await seedThread(f);
  const authorize = f.gate.authorize.bind(f.gate);
  f.gate.authorize = async (...args: Parameters<typeof authorize>) => { const policy = await authorize(...args); f.advance(365); return policy; };
  setHistory(f, async () => Array.from({ length: 80 }, (_, i) => historyMessage(String(101 + i))));
  const advancing = advancingDatabase(f, emptyBufferSelect, () => 500);
  const store = new Store(advancing.db, f.now);
  const ingress = new DiscordIngress(store, f.gate, f.rest);
  const outcomes: string[] = [];
  const scheduler = new RecoveryScheduler(store, async (s, o) => { const r = await ingress.recover(s, o); outcomes.push(r); return r; }, () => {});
  await scheduler.barrier();
  await scheduler.runDue();
  assert.equal(advancing.fired(), true);
  assert.deepEqual(outcomes, ['budget']);
  assert.equal(scheduler.size, 0);
  assert.equal(await historyGaps(), 1);
  // 처리한 메시지의 checkpoint는 남고, gap 해제만 되돌린다.
  assert.deepEqual(await threadRow(), { checkpoint: '180', gap: true, recovery_token: null });
});

for (const [name, match] of [['빈 버퍼 조회 응답', emptyBufferSelect], ['gap 해제 UPDATE 응답', gapRelease]] as const) {
  test(`R3-1 마지막 check() 뒤 ${name}에서 30초를 넘기면 gap 해제를 되돌리고 budget`, async () => {
    const f = await fixture(database.db);
    await seedThread(f);
    setHistory(f, async () => [historyMessage('101')]);
    const started = f.now();
    // recover()의 lease는 시작 시각(이 시험은 인가 지연 없음) + 30초다. 응답 직후 그 경계를 1ms 넘긴다.
    const advancing = advancingDatabase(f, match, () => started + 30_001 - f.now());
    const ingress = new DiscordIngress(new Store(advancing.db, f.now), f.gate.withDatabase(advancing.db), f.rest);
    assert.equal(await ingress.recover(thread, f.policy.owner), 'budget');
    assert.equal(advancing.fired(), true);
    assert.equal(await historyGaps(), 1);
    assert.deepEqual(await threadRow(), { checkpoint: '101', gap: true, recovery_token: null });
  });
}

test('R3-1 경계 안에서 끝나면 그대로 done(마지막 왕복이 lease 1ms 전)', async () => {
  const f = await fixture(database.db);
  await seedThread(f);
  setHistory(f, async () => [historyMessage('101')]);
  const started = f.now();
  const advancing = advancingDatabase(f, gapRelease, () => started + 29_999 - f.now());
  const ingress = new DiscordIngress(new Store(advancing.db, f.now), f.gate.withDatabase(advancing.db), f.rest);
  assert.equal(await ingress.recover(thread, f.policy.owner), 'done');
  assert.equal(await historyGaps(), 0);
  assert.deepEqual(await threadRow(), { checkpoint: '101', gap: false, recovery_token: null });
});
