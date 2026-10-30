import { after, before, beforeEach, test } from 'node:test';
import assert from 'node:assert/strict';
import { Denied, RateLimited } from '../src/contracts.js';
import type { Scope } from '../src/contracts.js';
import type { RecoveryOutcome } from '../src/discord.js';
import { RecoveryScheduler } from '../src/recovery.js';
import { Store } from '../src/store.js';
import { localDatabase } from './helpers.js';

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
