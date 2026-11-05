import { after, before, beforeEach, test } from 'node:test';
import type { TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { DEFAULTS, Denied } from '../src/contracts.js';
import { Postgres, migrate } from '../src/database.js';
import { Store } from '../src/store.js';
import { taskQuestionId } from '../src/task-contracts.js';
import { fixture, localDatabase, thread } from './helpers.js';
import { ABSENT, allRows, answer, answerOnAbort, control, lane, laneRow, rejectStart, reply, task, until } from './task-lane-fixture.js';
import type { Fixture, Script } from './task-lane-fixture.js';

// 종료 로그는 DB가 실제로 도달한 상태만 말한다. 전이가 막히면 task_job_finished 대신 task_settle_transition_skipped가 남는다.
// 사례마다 DB·로그·세션·outbox·세션 공간 정리를 함께 본다. 다중 연결 경합은 test/task-lane-pg.test.ts가 본다.
let database: Awaited<ReturnType<typeof localDatabase>>;
let f: Fixture;
before(async () => { database = await localDatabase(); });
const RESET = `TRUNCATE events,conversations,jobs,results,outbox,schedules,denied_actors,controls,audit,incidents,codex_sessions,codex_questions RESTART IDENTITY CASCADE;
  UPDATE execution_lanes SET closed_reason=NULL,closed_at=NULL`;
beforeEach(async () => {
  await database.pg.exec(RESET);
  f = await fixture(database.db);
});
after(async () => { await database.pg.close(); });
const db = () => database.db;
const FINISHED = 'task_job_finished';
const SKIPPED = 'task_settle_transition_skipped';

type Logged = [string, Record<string, unknown> | undefined];
function harness(options: Parameters<typeof lane>[1] = {}) {
  const events: Logged[] = [];
  const local = lane(f, { monitorMs: 3_600_000, log: (event, detail) => { events.push([event, detail]); }, ...options });
  return { ...local, events, ends: () => events.filter(([event]) => event === FINISHED || event === SKIPPED) };
}
type Harness = ReturnType<typeof harness>;
// 작업자 응답을 붙잡아 둔다. deliver 전에 lease·취소·철회를 만들고, 응답이 오면 settle이 돈다.
async function heldTurn(local: Harness, script: Script, id = 'task') {
  let deliver!: () => void;
  const held = new Promise<void>(resolve => { deliver = resolve; });
  local.worker.scripts.push(async (request, worker) => { await held; return script(request, worker); });
  const job = await task(f, db(), id);
  const running = local.runtime.tickTask();
  await until(() => local.worker.executes.length === 1);
  return { job, running, deliver };
}
const lapse = () => { f.advance(DEFAULTS.leaseMs + 1); f.policy.confirmedAt = f.now(); };
const jobRow = async (id: string) => (await db().query<{ state: string; wait_reason: string | null }>('SELECT state,wait_reason FROM jobs WHERE id=$1', [id])).rows[0]!;
const sessionRow = async () => (await allRows(db(), 'codex_sessions'))[0]!;
const outboxKeys = async (prefix: string) => (await db().query<{ idempotency_key: string }>('SELECT idempotency_key FROM outbox')).rows
  .map(row => row.idempotency_key).filter(key => key.startsWith(prefix));
const notices = { cancelled: () => outboxKeys('task-cancelled:'), blocked: () => outboxKeys('task-blocked:'), failure: () => outboxKeys('failure:'), result: () => outboxKeys('result:'), wait: () => outboxKeys('task-wait:'), question: () => outboxKeys('task-question:') };
const finished = (job: string, state: string, reason: string | null): Logged => [FINISHED, { job, state, reason }];
const skipped = (job: string, intended: string, state: string | null, reason: string | null): Logged => [SKIPPED, { job, intended, actual_state: state, actual_reason: reason }];
// 불변식: settle 한 번에 끝 기록 하나이고, 그 값은 settle 직후의 DB와 같다. 호출자는 lease·expire를 더 건드리기 전에 부른다.
async function assertEndMatchesDatabase(local: Harness, job: string) {
  const row = await jobRow(job);
  const ends = local.ends();
  assert.equal(ends.length, 1, `끝 기록은 하나여야 한다: ${JSON.stringify(ends)}`);
  const [event, detail] = ends[0]!;
  const logged = event === FINISHED ? { state: detail!.state, wait_reason: detail!.reason } : { state: detail!.actual_state, wait_reason: detail!.actual_reason };
  assert.deepEqual(logged, row, `${event}의 값이 DB와 다르다`);
}
// 막힌 전이의 뒤처리: lease가 끝나면 expire가 unknown으로 두고 안내는 unknownNotices가 한 번 넣고, 해제 전까지 레인이 닫힌다. 해제는 그대로 된다.
async function assertRecoversThroughRelease(local: Harness, job: string) {
  local.worker.stopped = true;
  lapse();
  await f.store.expire();
  await local.bridge.sweep();
  await local.bridge.sweep();
  assert.equal((await jobRow(job)).state, 'unknown');
  assert.equal((await notices.blocked()).length, 1);
  assert.equal((await notices.cancelled()).length, 0);
  assert.equal((await laneRow(db())).closed_reason, 'unknown');
  const released = await local.bridge.release('fixture-owner', thread, job);
  assert.equal(released.ok, true, released.status);
  assert.equal((await jobRow(job)).state, 'cancelled');
  assert.equal((await sessionRow()).state, 'cancelled');
  assert.equal(local.worker.finalizes.length, 1, '세션 공간은 해제 뒤에 지운다');
  assert.equal((await notices.cancelled()).length, 0, '해제 결과는 TaskCommands.release가 게시한다');
  assert.equal((await laneRow(db())).closed_reason, null);
}
// 판단과 전이 사이에 lease가 끝나는 경계. 호출 직전에 시계를 넘긴다.
function lapseBefore(t: TestContext, method: 'fail' | 'finish' | 'waitForUser') {
  const original = Store.prototype[method] as (...args: unknown[]) => Promise<unknown>;
  t.mock.method(Store.prototype, method, function (this: Store, ...args: unknown[]) { lapse(); return original.apply(this, args); } as never);
}
// expire가 이미 unknown으로 둔 행. 다른 인스턴스의 시계가 앞서면 이 인스턴스에서는 lease가 아직 남아 있어 만료 판단(leaseLost)을 지나간다.
const markUnknownWithLiveLease = (job: string) => db().query("UPDATE jobs SET state='unknown',wait_reason='lease_expired' WHERE id=$1", [job]);

const STOPS = ['cancel', 'revoked'] as const;
const LEASES = ['유효', '끝남(expire 전)', 'expire 후'] as const;
for (const stop of STOPS) for (const lease of LEASES) for (const confirmed of [true, false]) {
  test(`${stop} × lease ${lease} × 소멸 ${confirmed ? '확인' : '미확인'}: 로그·세션·outbox가 DB와 맞다`, async () => {
    // 취소는 감시가 봐야 stop='cancel'이 된다. 안 보면 expire 뒤에는 lease 상실 분기로 간다. 철회는 결과 확정 전 재확인이 잡는다.
    const local = harness(stop === 'cancel' ? { monitorMs: 5, stopWaitMs: 10_000 } : {});
    local.worker.stopped = confirmed;
    const { job, running, deliver } = await heldTurn(local, confirmed ? reply.failed('api_error') : reply.unknown());
    const authorize = f.gate.authorize.bind(f.gate);
    if (stop === 'cancel') { await control(f, 'cancel', job.id); await until(() => local.worker.cancels.length === 1); }
    else f.gate.authorize = async () => { throw new Denied(); };
    if (lease !== '유효') lapse();
    if (lease === 'expire 후') await f.store.expire();
    deliver();
    await running;
    f.gate.authorize = authorize;

    await assertEndMatchesDatabase(local, job.id);
    const reason = stop === 'cancel' ? 'stop_confirmation' : 'authorization_revoked';
    const intended = confirmed ? 'cancelled' : 'unknown';
    if (lease === '유효') {
      assert.deepEqual(await jobRow(job.id), { state: intended, wait_reason: reason });
      assert.deepEqual(local.ends(), [finished(job.id, intended, reason)]);
      assert.equal((await sessionRow()).state, intended);
      assert.equal(local.worker.finalizes.length, confirmed ? 1 : 0);
      assert.equal((await notices.cancelled()).length, stop === 'cancel' && confirmed ? 1 : 0);
      assert.equal((await notices.blocked()).length, stop === 'cancel' && !confirmed ? 1 : 0);
      return;
    }
    const actual = lease === 'expire 후' ? { state: 'unknown', wait_reason: 'lease_expired' } : { state: stop === 'cancel' ? 'cancel_requested' : 'running', wait_reason: null };
    assert.deepEqual(await jobRow(job.id), actual);
    assert.deepEqual(local.ends(), [skipped(job.id, intended, actual.state, actual.wait_reason)]);
    assert.equal((await sessionRow()).state, 'unknown', 'job이 끝나지 않았으면 세션도 끝내지 않는다');
    assert.equal(local.worker.finalizes.length, 0, 'job이 끝나지 않았으면 세션 공간을 지우지 않는다');
    assert.equal((await notices.cancelled()).length, 0, 'DB가 cancelled가 아니면 취소 완료 안내가 없다');
    assert.equal((await notices.blocked()).length, 0, 'unknown 안내는 unknownNotices 경로가 넣는다');
    assert.equal((await laneRow(db())).closed_reason, 'unknown');
    await assertRecoversThroughRelease(local, job.id);
  });
}

test('R1 재현 순서: 감시가 취소를 보고 멈춘 뒤 응답 전에 expire가 돌면 로그는 cancelled가 아니다', async () => {
  const local = harness({ monitorMs: 5 });
  const job = await task(f, db());
  local.worker.scripts.push(answerOnAbort(async (request, worker) => {
    lapse();
    await f.store.expire();
    return reply.failed('api_error')(request, worker);
  }));
  const running = local.runtime.tickTask();
  await until(() => local.worker.executes.length === 1);
  await control(f, 'cancel', job.id);
  await running;
  await assertEndMatchesDatabase(local, job.id);
  assert.deepEqual(await jobRow(job.id), { state: 'unknown', wait_reason: 'lease_expired' });
  assert.deepEqual(local.ends(), [skipped(job.id, 'cancelled', 'unknown', 'lease_expired')]);
  assert.equal((await sessionRow()).state, 'unknown');
  assert.equal((await notices.cancelled()).length, 0);
  assert.equal(local.worker.finalizes.length, 0);
});

test('lease 상실 분기: 끝남(expire 전)과 expire 후 모두 task_lease를 DB 값처럼 적지 않고, 안내는 unknownNotices로 간다', async () => {
  for (const expired of [false, true]) {
    await database.pg.exec(RESET);
    f = await fixture(database.db);
    const local = harness();
    const { job, running, deliver } = await heldTurn(local, reply.completed());
    lapse();
    if (expired) await f.store.expire();
    deliver();
    await running;
    await assertEndMatchesDatabase(local, job.id);
    const actual = expired ? { state: 'unknown', wait_reason: 'lease_expired' } : { state: 'running', wait_reason: null };
    assert.deepEqual(local.ends(), [skipped(job.id, 'unknown', actual.state, actual.wait_reason)]);
    assert.equal((await sessionRow()).state, 'unknown');
    assert.equal((await notices.blocked()).length, 0);
    assert.equal((await notices.result()).length, 0);
    await assertRecoversThroughRelease(local, job.id);
  }
});

// fail()과 대기·완료 분기는 lease 판단을 지난 뒤에 전이한다. 판단 뒤 lease가 끝나거나, 이미 unknown인 행이면 전이가 막힌다.
const BRANCHES: { name: string; script: () => Script; intended: string; rolledBack?: boolean; outbox: () => Promise<string[]> }[] = [
  { name: 'fail(응답 failed)', script: () => reply.failed('api_error'), intended: 'failed', outbox: notices.failure },
  { name: 'fail(작업자 거부)', script: () => rejectStart, intended: 'failed', outbox: notices.failure },
  { name: '모델 한도 대기', script: () => reply.limited(), intended: 'waiting_user', outbox: notices.wait },
  { name: '질문 대기', script: () => reply.question(), intended: 'waiting_user', outbox: notices.question },
  // 완료는 stale_result로 트랜잭션을 되돌리고 fallback으로 간다. 세션은 running으로 남고 해제가 그 상태를 받는다.
  { name: '완료', script: () => reply.completed(), intended: 'unknown', rolledBack: true, outbox: notices.result },
];
for (const branch of BRANCHES) {
  test(`${branch.name} × 이미 unknown인 행(lease 유효): 전이가 막히면 그 끝을 적지 않고 안내·세션 정리가 없다`, async () => {
    const local = harness();
    const { job, running, deliver } = await heldTurn(local, branch.script());
    await markUnknownWithLiveLease(job.id);
    deliver();
    await running;
    await assertEndMatchesDatabase(local, job.id);
    assert.deepEqual(await jobRow(job.id), { state: 'unknown', wait_reason: 'lease_expired' });
    assert.deepEqual(local.ends(), [skipped(job.id, branch.intended, 'unknown', 'lease_expired')]);
    assert.equal((await sessionRow()).state, branch.rolledBack ? 'running' : 'unknown');
    assert.equal(local.worker.finalizes.length, 0);
    assert.deepEqual(await branch.outbox(), []);
    assert.equal((await allRows(db(), 'results')).length, 0);
    assert.equal((await allRows(db(), 'codex_questions')).length, 0);
    await local.bridge.sweep();
    assert.equal((await notices.blocked()).length, 1);
    assert.equal((await laneRow(db())).closed_reason, 'unknown');
  });
}

test('fail × 판단 뒤 lease 만료: 로그는 failed가 아니고 실패 안내가 없으며 세션을 지우지 않는다', async t => {
  const local = harness();
  const { job, running, deliver } = await heldTurn(local, reply.failed('api_error'));
  lapseBefore(t, 'fail');
  deliver();
  await running;
  t.mock.restoreAll();
  await assertEndMatchesDatabase(local, job.id);
  assert.deepEqual(await jobRow(job.id), { state: 'running', wait_reason: null });
  assert.deepEqual(local.ends(), [skipped(job.id, 'failed', 'running', null)]);
  assert.equal((await sessionRow()).state, 'unknown');
  assert.deepEqual(await notices.failure(), []);
  assert.equal(local.worker.finalizes.length, 0);
  await assertRecoversThroughRelease(local, job.id);
});

test('한도 대기 × 판단 뒤 lease 만료: 대기 안내 없이 세션을 cancelled로 닫지 않는다', async t => {
  const local = harness();
  const { job, running, deliver } = await heldTurn(local, reply.limited());
  lapseBefore(t, 'waitForUser');
  deliver();
  await running;
  t.mock.restoreAll();
  await assertEndMatchesDatabase(local, job.id);
  assert.deepEqual(local.ends(), [skipped(job.id, 'waiting_user', 'running', null)]);
  assert.equal((await sessionRow()).state, 'unknown');
  assert.deepEqual(await notices.wait(), []);
  assert.equal(local.worker.finalizes.length, 0);
});

test('완료 × 판단 뒤 lease 만료: 대화가 멈췄으면 finish가 조용히 막혀도 running을 끝으로 적지 않는다', async t => {
  const local = harness();
  const { job, running, deliver } = await heldTurn(local, reply.completed());
  await db().query('UPDATE conversations SET active=false WHERE id=$1', [job.conversation_id]);
  lapseBefore(t, 'finish');
  deliver();
  await running;
  t.mock.restoreAll();
  await assertEndMatchesDatabase(local, job.id);
  assert.deepEqual(local.ends(), [skipped(job.id, 'succeeded', 'running', null)]);
  assert.equal((await sessionRow()).state, 'unknown');
  assert.equal(local.worker.finalizes.length, 0);
});

test('구독 중지로 끝난 턴: 완료·질문 모두 superseded와 그 사유를 DB 그대로 적고 세션을 닫는다', async () => {
  for (const script of [reply.completed(), reply.question()]) {
    await database.pg.exec(RESET);
    f = await fixture(database.db);
    const local = harness();
    const { job, running, deliver } = await heldTurn(local, script);
    await db().query('UPDATE conversations SET active=false WHERE id=$1', [job.conversation_id]);
    deliver();
    await running;
    await assertEndMatchesDatabase(local, job.id);
    assert.deepEqual(local.ends(), [finished(job.id, 'superseded', 'subscription_stopped')]);
    assert.equal((await sessionRow()).state, 'cancelled');
    assert.equal(local.worker.finalizes.length, 1);
  }
});

test('재개 전 포기 × 판단 뒤 lease 만료: 로그는 failed가 아니고 세션·질문을 닫지 않는다', async t => {
  const local = harness();
  local.worker.scripts.push(reply.question());
  const job = await task(f, db());
  await local.runtime.tickTask();
  const question = taskQuestionId(job.id, (await sessionRow()).claude_session_id as string, 1);
  await answer(local.bridge, question, '답', 'answer-log');
  local.worker.statusOverride = ABSENT;
  lapseBefore(t, 'fail');
  await local.runtime.tickTask();
  t.mock.restoreAll();
  await assertEndMatchesDatabase(local, job.id);
  assert.deepEqual(local.ends(), [skipped(job.id, 'failed', 'running', null)]);
  assert.equal((await sessionRow()).state, 'waiting_answer');
  assert.equal((await allRows(db(), 'codex_questions'))[0]!.state, 'answered');
  assert.deepEqual(await notices.failure(), []);
});

test('재개 전 포기 × 상태 확인 중 /cancel: DB가 cancelled면 failed로 적지 않고 취소 안내만 간다', async () => {
  const local = harness();
  local.worker.scripts.push(reply.question());
  const job = await task(f, db());
  await local.runtime.tickTask();
  const question = taskQuestionId(job.id, (await sessionRow()).claude_session_id as string, 1);
  await answer(local.bridge, question, '답', 'answer-log');
  local.worker.statusOverride = ABSENT;
  local.worker.onControl = async endpoint => {
    if (endpoint !== '/v1/task/status') return;
    local.worker.onControl = undefined;
    await control(f, 'cancel', job.id);
  };
  await local.runtime.tickTask();
  await assertEndMatchesDatabase(local, job.id);
  assert.deepEqual(local.ends(), [finished(job.id, 'cancelled', 'task_session_missing')]);
  assert.equal((await notices.cancelled()).length, 1);
  assert.deepEqual(await notices.failure(), []);
});

// settle 트랜잭션 안에서 터지는 기록 오류. 작업자가 응답을 준 뒤에만 터뜨린다. 턴 시작도 같은 메서드를 부른다.
function failSettleRecord(t: TestContext) {
  const armed = { value: false };
  const original = Store.prototype.syncTaskLane;
  t.mock.method(Store.prototype, 'syncTaskLane', function (this: Store, ...args: Parameters<Store['syncTaskLane']>) {
    if (armed.value) throw new Error('settle_record_failed');
    return original.apply(this, args);
  } as never);
  return armed;
}

test('settle 오류 + fallback 성공: unknown/record_failed를 적고 되돌린 끝과 안내는 남지 않는다', async t => {
  const local = harness();
  const armed = failSettleRecord(t);
  const { job, running, deliver } = await heldTurn(local, reply.completed());
  armed.value = true;
  deliver();
  await running;
  t.mock.restoreAll();
  await assertEndMatchesDatabase(local, job.id);
  assert.deepEqual(await jobRow(job.id), { state: 'unknown', wait_reason: 'record_failed' });
  assert.deepEqual(local.ends(), [finished(job.id, 'unknown', 'record_failed')]);
  assert.equal((await allRows(db(), 'results')).length, 0);
  assert.deepEqual(await notices.result(), []);
  assert.equal((await sessionRow()).state, 'running');
  assert.equal(local.worker.finalizes.length, 0);
  await assertRecoversThroughRelease(local, job.id);
});

test('settle 오류 + fallback 성공: 취소 확정이 되돌려졌으면 cancelled 로그·취소 안내가 남지 않는다', async t => {
  const local = harness();
  const armed = failSettleRecord(t);
  const { job, running, deliver } = await heldTurn(local, reply.failed('api_error'));
  await control(f, 'cancel', job.id);
  armed.value = true;
  deliver();
  await running;
  t.mock.restoreAll();
  await assertEndMatchesDatabase(local, job.id);
  assert.deepEqual(local.ends(), [finished(job.id, 'unknown', 'record_failed')]);
  assert.deepEqual(await notices.cancelled(), []);
  assert.equal(local.worker.finalizes.length, 0);
});

test('settle 오류 + fallback 전이 막힘: lease가 끝났으면 record_failed라고 적지 않는다(expire 전/후)', async t => {
  for (const expired of [false, true]) {
    await database.pg.exec(RESET);
    f = await fixture(database.db);
    const local = harness();
    const armed = failSettleRecord(t);
    const { job, running, deliver } = await heldTurn(local, reply.completed());
    lapse();
    if (expired) await f.store.expire();
    armed.value = true;
    deliver();
    await running;
    t.mock.restoreAll();
    await assertEndMatchesDatabase(local, job.id);
    const actual = expired ? { state: 'unknown', wait_reason: 'lease_expired' } : { state: 'running', wait_reason: null };
    assert.deepEqual(await jobRow(job.id), actual);
    assert.deepEqual(local.ends(), [skipped(job.id, 'unknown', actual.state, actual.wait_reason)]);
    assert.equal((await sessionRow()).state, 'running', 'settle이 되돌려져 세션은 그대로다');
    assert.deepEqual(await notices.blocked(), []);
    await assertRecoversThroughRelease(local, job.id);
  }
});

test('settle 오류 + fallback도 실패: DB 값을 모르면 상태를 지어내지 않고, lease가 끝난 뒤 expire·안내로 이어진다', async t => {
  const local = harness();
  const armed = failSettleRecord(t);
  const { job, running, deliver } = await heldTurn(local, reply.completed());
  t.mock.method(Store.prototype, 'transition', async () => { throw new Error('fallback_failed'); });
  armed.value = true;
  deliver();
  await running;
  t.mock.restoreAll();
  assert.deepEqual(await jobRow(job.id), { state: 'running', wait_reason: null });
  assert.deepEqual(local.ends(), [skipped(job.id, 'unknown', null, null)]);
  assert.equal(local.events.some(([event]) => event === FINISHED), false);
  assert.deepEqual(await notices.blocked(), []);
  await assertRecoversThroughRelease(local, job.id);
});

// 실제 PostgreSQL 다중 연결. settle과 expire가 어느 쪽이 먼저 잠그든 cancelled로 적지 않고 교착 없이 unknown으로 모인다. 소켓이 없으면 건너뛴다(test/task-lane-pg.test.ts와 같은 방식).
const socket = process.env.HOMELAB_TEST_PG_SOCKET;
const skip = socket ? false : 'HOMELAB_TEST_PG_SOCKET 없음(로컬 PostgreSQL 필요)';
test('실제 PostgreSQL: settle과 expire가 겹쳐도 로그는 cancelled가 아니고 취소 안내 없이 unknown으로 끝난다', { skip, timeout: 120_000 }, async () => {
  const admin = new pg.Pool({ host: socket, user: 'postgres', database: 'postgres', max: 1 });
  const name = `t18b10_${randomUUID().replaceAll('-', '').slice(0, 12)}`;
  await admin.query(`CREATE DATABASE ${name}`);
  const pool = new pg.Pool({ host: socket, user: 'postgres', database: name, max: 12 });
  try {
    const real = new Postgres(pool);
    await migrate(real);
    const local = await fixture(real);
    await real.query("INSERT INTO controls VALUES ('scheduler','false') ON CONFLICT DO NOTHING");
    for (let round = 0; round < 8; round++) {
      const events: Logged[] = [];
      const setup = lane(local, { monitorMs: 3_600_000, log: (event, detail) => { events.push([event, detail]); } });
      let deliver!: () => void;
      const held = new Promise<void>(resolve => { deliver = resolve; });
      setup.worker.scripts.push(async (request, worker) => { await held; return reply.failed('api_error')(request, worker); });
      const job = await task(local, real, `pg-${round}`);
      const running = setup.runtime.tickTask();
      await until(() => setup.worker.executes.length === 1);
      await local.store.control('fixture-owner', job.conversation_id, 'cancel', job.id);
      local.advance(DEFAULTS.leaseMs + 1); local.policy.confirmedAt = local.now();
      deliver();
      const results = await Promise.allSettled([running, local.store.expire(), local.store.expire()]);
      for (const result of results) assert.equal(result.status, 'fulfilled', result.status === 'rejected' ? String(result.reason) : '');
      await local.store.expire();
      await setup.bridge.sweep();
      const row = (await real.query<{ state: string; wait_reason: string }>('SELECT state,wait_reason FROM jobs WHERE id=$1', [job.id])).rows[0]!;
      assert.deepEqual({ ...row }, { state: 'unknown', wait_reason: 'lease_expired' });
      const ends = events.filter(([event]) => event === FINISHED || event === SKIPPED);
      assert.equal(ends.length, 1);
      assert.equal(ends[0]![0], SKIPPED);
      assert.ok(ends[0]![1]!.actual_state === 'unknown' || ends[0]![1]!.actual_state === 'cancel_requested', String(ends[0]![1]!.actual_state));
      assert.equal((await real.query('SELECT 1 FROM outbox WHERE idempotency_key=$1', [`task-cancelled:${job.id}`])).rows.length, 0);
      assert.equal((await real.query('SELECT 1 FROM outbox WHERE idempotency_key=$1', [`task-blocked:${job.id}`])).rows.length, 1);
      assert.equal((await real.query<{ state: string }>('SELECT state FROM codex_sessions WHERE job_id=$1', [job.id])).rows[0]!.state, 'unknown');
      assert.equal(setup.worker.finalizes.length, 0);
      const released = await setup.bridge.release('fixture-owner', job.target, job.id);
      assert.equal(released.ok, true, released.status);
    }
  } finally {
    await pool.end();
    for (let attempt = 0; ; attempt++) {
      try { await admin.query(`DROP DATABASE ${name}`); break; } catch (error) {
        if (attempt >= 50 || !/being accessed by other users/.test((error as Error).message)) throw error;
        await new Promise(resolve => setTimeout(resolve, 100));
      }
    }
    await admin.end();
  }
});
