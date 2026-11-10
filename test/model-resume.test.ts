import { after, before, beforeEach, test } from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULTS } from '../src/contracts.js';
import type { RateLimitInfo } from '../src/contracts.js';
import { parseAdminArgs, runAdmin } from '../src/admin.js';
import { Store } from '../src/store.js';
import { localDatabase, fixture, event } from './helpers.js';

// AC-16 한도 재개(COLLEAGUE_SPEC §4.7). 경계 S1: 수신 → 저장(PGlite) → runtime → 가짜 작업자. 시계는 fixture의 업무 시계다.
// 재개 예약 루프 한 바퀴는 Store.resumeDue()다(main.ts가 주기로 부른다).
let database: Awaited<ReturnType<typeof localDatabase>>;
let f: Awaited<ReturnType<typeof fixture>>;
before(async () => { database = await localDatabase(); });
beforeEach(async () => {
  await database.pg.exec('TRUNCATE events,conversations,jobs,results,outbox,schedules,denied_actors,controls,audit,incidents,model_pauses,model_limit_state RESTART IDENTITY CASCADE');
  f = await fixture(database.db);
});
after(async () => { await database.pg.close(); });
const MINUTE = 60_000;
async function rows(table: string) { return (await database.db.query<Record<string, any>>(`SELECT * FROM ${table}`)).rows; }
async function queued(id = 'chat') { await f.ingress.receive(event(id)); f.advance(DEFAULTS.debounceMs); }
const job = async () => (await rows('jobs'))[0]!;
const scheduler = async () => (await rows('controls')).find(row => row.key === 'scheduler')?.value;
const answered = async () => ({ status: 'succeeded' as const, stopped: true as const, rateLimit: null,
  output: { reply: '이어서 답했어요.', proposal: null, ack_only: false } });
const limited = (rateLimit: RateLimitInfo | null) => async () => ({ status: 'limited' as const, stopped: true as const, rateLimit });
// 업무 시계(ms)에서 초 단위 resetsAt을 만든다. 작업자는 unix 초를 준다.
const secondsFromNow = (ms: number) => Math.floor((f.now() + ms) / 1000);

test('AC-16 한도와 풀리는 시각이 오면 그 시각 1분 뒤에 같은 작업자로 저절로 이어서 하고, 그 전에는 재개하지 않는다', async () => {
  await queued();
  const resetsAt = secondsFromNow(60 * MINUTE);
  f.setRun(limited({ event: { status: 'rejected', resetsAt, rateLimitType: 'five_hour', utilization: 1 }, stop: { cause: 'rate_limit', resetsAt } }));
  await f.runtime.tick();
  assert.equal((await job()).state, 'waiting_user');
  assert.equal(await scheduler(), true);

  f.advance(resetsAt * 1000 + MINUTE - 1 - f.now());
  assert.equal(await f.store.resumeDue(), 0);
  assert.equal((await job()).state, 'waiting_user');
  f.advance(1);
  assert.equal(await f.store.resumeDue(), 1);
  assert.equal((await job()).state, 'queued');
  assert.equal(await scheduler(), false);

  f.setRun(answered);
  assert.equal(await f.runtime.tick(), true);
  assert.equal((await job()).state, 'succeeded');
  assert.equal(f.requests.length, 2);
  assert.equal(f.requests[1]!.job, f.requests[0]!.job);
  const resumed = (await rows('audit')).filter(row => row.kind === 'model_wait_resumed');
  assert.deepEqual(resumed.map(row => row.detail.actor), ['auto_resume']);
});

test('AC-16 풀리는 시각을 모르는 한도는 30분마다 다시 시도하고, 시도 한도를 넘는 횟수만큼 멈춰도 계속 다시 시도한다', async () => {
  await queued();
  // 옛 작업자(한도 칸 없음)와 같은 응답이다.
  f.setRun(limited(null));
  await f.runtime.tick();
  for (let round = 1; round <= DEFAULTS.maxRetries + 2; round++) {
    assert.equal((await job()).state, 'waiting_user', `round ${round}`);
    f.advance(30 * MINUTE - 1);
    assert.equal(await f.store.resumeDue(), 0, `round ${round} early`);
    f.advance(1);
    assert.equal(await f.store.resumeDue(), 1, `round ${round} due`);
    await f.runtime.tick();
  }
  assert.equal((await job()).state, 'waiting_user');
  // 같은 멈춤이라 대기 안내(자리 비움, C20)는 처음 한 번뿐이다.
  assert.equal((await rows('outbox')).filter(row => row.idempotency_key.startsWith('away:')).length, 1);
  f.setRun(answered);
  f.advance(30 * MINUTE);
  assert.equal(await f.store.resumeDue(), 1);
  await f.runtime.tick();
  assert.equal((await job()).state, 'succeeded');
  assert.equal(f.requests.length, DEFAULTS.maxRetries + 4);
});

test('AC-16 인증 만료는 30분 뒤 저절로, 관리 진입점 재개와 /resume-model은 그 자리에서 바로 이어서 한다', async () => {
  await queued();
  f.setRun(async () => ({ status: 'auth_expired' as const, stopped: true as const, rateLimit: null }));
  await f.runtime.tick();
  const id = (await job()).id as string;
  f.advance(30 * MINUTE);
  assert.equal(await f.store.resumeDue(), 1);
  await f.runtime.tick();
  assert.equal((await job()).state, 'waiting_user');

  // 계정 전환 뒤 owner가 관리 진입점으로 풀면 다음 30분을 기다리지 않는다. 그 뒤 예약 루프가 같은 작업을 또 재개하지 않는다.
  f.advance(MINUTE);
  assert.equal((await runAdmin(f.store, parseAdminArgs(['resume', 'job', id]))).report.result, 'resumed');
  assert.equal((await job()).state, 'queued');
  f.advance(30 * MINUTE);
  assert.equal(await f.store.resumeDue(), 0);
  await f.runtime.tick();
  assert.equal((await job()).state, 'waiting_user');

  f.advance(MINUTE);
  await f.ingress.receive(event('slash-resume', { kind: 'command', command: 'resume-model', target: id }));
  assert.equal((await job()).state, 'queued');
  assert.equal(await scheduler(), false);
  const actors = (await rows('audit')).filter(row => row.kind === 'model_wait_resumed').map(row => row.detail.actor);
  assert.deepEqual(actors, ['auto_resume', 'cli', 'fixture-owner']);
});

test('AC-16 결제 멈춤은 하루가 지나도 저절로 재개하지 않고, 관리 진입점으로만 푼다', async () => {
  await queued();
  f.setRun(limited({ stop: { cause: 'billing' } }));
  await f.runtime.tick();
  const id = (await job()).id as string;
  for (let hour = 0; hour < 24; hour++) {
    f.advance(60 * MINUTE);
    assert.equal(await f.store.resumeDue(), 0);
  }
  assert.equal((await job()).state, 'waiting_user');
  assert.equal(await scheduler(), true);
  assert.equal((await runAdmin(f.store, parseAdminArgs(['resume', 'job', id]))).report.result, 'resumed');
  assert.equal((await job()).state, 'queued');
});

test('AC-16 비상 정지 중에는 재개 시각이 지나도 어떤 작업도 재개하지 않고, 정지를 풀면 다음 바퀴에 이어서 한다', async () => {
  await queued();
  f.setRun(limited({ stop: { cause: 'rate_limit', resetsAt: secondsFromNow(10 * MINUTE) } }));
  await f.runtime.tick();
  await runAdmin(f.store, parseAdminArgs(['emergency-stop']));
  f.advance(2 * 60 * MINUTE);
  assert.equal(await f.store.resumeDue(), 0);
  assert.equal((await job()).state, 'waiting_user');
  assert.equal((await runAdmin(f.store, parseAdminArgs(['resume', 'emergency-stop']))).report.result, 'released');
  assert.equal(await f.store.resumeDue(), 1);
  assert.equal((await job()).state, 'queued');
});

test('AC-16 게시 서버가 다시 떠도 멈춤 기록이 남아 같은 시각에 재개한다', async () => {
  await queued();
  const resetsAt = secondsFromNow(90 * MINUTE);
  f.setRun(limited({ stop: { cause: 'rate_limit', resetsAt } }));
  await f.runtime.tick();
  const restarted = new Store(database.db, f.now);
  f.advance(resetsAt * 1000 + MINUTE - 1 - f.now());
  assert.equal(await restarted.resumeDue(), 0);
  f.advance(1);
  assert.equal(await restarted.resumeDue(), 1);
});

test('AC-16 배포 전 판이 남긴 기록 없는 한도·인증 대기는 처음 본 때부터 30분 뒤에 재개한다', async () => {
  await queued('legacy-limit');
  await queued('legacy-auth');
  // 이 기록을 쓰기 전의 판처럼 멈춤 기록 없이 대기에 둔다. 시도 한도에 닿은 대기도 이 멈춤은 시도로 세지 않는다.
  await database.db.query(`UPDATE jobs SET state='waiting_user',wait_reason=CASE WHEN event_id='legacy-limit' THEN 'model_limit' ELSE 'auth_expired' END,
    attempt=$1,finished_at=$2`, [DEFAULTS.maxRetries + 1, f.now()]);
  // 운영 DB에는 비상 정지 행이 이미 있다(없으면 원인 모를 옛 중지로 보고 비상 정지로 채운다).
  await database.db.query(`INSERT INTO controls VALUES ('scheduler','true'),('scheduler_emergency','false')
    ON CONFLICT (key) DO UPDATE SET value=EXCLUDED.value`);
  f.advance(24 * 60 * MINUTE);
  assert.equal(await f.store.resumeDue(), 0);
  f.advance(30 * MINUTE - 1);
  assert.equal(await f.store.resumeDue(), 0);
  f.advance(1);
  assert.equal(await f.store.resumeDue(), 2);
  assert.deepEqual((await rows('jobs')).map(row => row.state), ['queued', 'queued']);
  assert.equal(await scheduler(), false);
});
