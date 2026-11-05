import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { ClaudeTaskBridge } from '../src/claude-task-bridge.js';
import { Postgres, migrate } from '../src/database.js';
import type { Database } from '../src/database.js';
import { Store } from '../src/store.js';
import { TASK_RETENTION, taskQuestionId } from '../src/task-contracts.js';
import { event, fixture, thread } from './helpers.js';
import { FakeTaskWorker, OTHER_STORAGE, PLAN, allRows, answer, answerOnAbort, codexBridge, codexSession, conversationId, expiredWhileWaiting, hang, jobs, lane, laneRow, reply, retainedThenStorageReplaced, task, until } from './task-lane-fixture.js';
import type { Fixture } from './task-lane-fixture.js';

// 실제 PostgreSQL 다중 연결 경합. PGlite는 transaction을 직렬화해 행 잠금 대기를 만들 수 없다.
// HOMELAB_TEST_PG_SOCKET(유닉스 소켓 디렉터리)이 없으면 건너뛴다(test/review-9-pg.test.ts와 같은 방식).
const socket = process.env.HOMELAB_TEST_PG_SOCKET;
const skip = socket ? false : 'HOMELAB_TEST_PG_SOCKET 없음(로컬 PostgreSQL 필요)';
const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
function pausing(db: Database, match: (sql: string) => boolean) {
  let armed = true;
  let reached!: () => void;
  let release!: () => void;
  const paused = new Promise<void>(resolve => { reached = resolve; });
  const gate = new Promise<void>(resolve => { release = resolve; });
  const wrap = (inner: Database): Database => ({
    query: async <T>(sql: string, params?: unknown[]) => {
      const result = await inner.query<T>(sql, params);
      if (armed && match(sql)) { armed = false; reached(); await gate; }
      return result;
    },
    transaction: (fn, deadline) => inner.transaction(tx => fn(wrap(tx)), deadline),
  });
  return { db: wrap(db), paused, release: () => release() };
}
async function setup() {
  const admin = new pg.Pool({ host: socket, user: 'postgres', database: 'postgres', max: 1 });
  const name = `t18b3_${randomUUID().replaceAll('-', '').slice(0, 12)}`;
  await admin.query(`CREATE DATABASE ${name}`);
  const pool = new pg.Pool({ host: socket, user: 'postgres', database: name, max: 12 });
  const db = new Postgres(pool);
  await migrate(db);
  const f = await fixture(db);
  await db.query("INSERT INTO controls VALUES ('scheduler','false') ON CONFLICT DO NOTHING");
  return { db, f, close: async () => {
    await pool.end();
    // 풀을 닫은 직후에는 세션이 남아 있을 수 있다. 빠질 때까지 다시 시도한다.
    for (let attempt = 0; ; attempt++) {
      try { await admin.query(`DROP DATABASE ${name}`); break; } catch (error) {
        if (attempt >= 50 || !/being accessed by other users/.test((error as Error).message)) throw error;
        await sleep(100);
      }
    }
    await admin.end();
  } };
}
// 게시 서버 인스턴스 하나에 해당하는 Store. 같은 풀이어도 트랜잭션마다 연결이 다르다.
const instance = (db: Database, f: Fixture) => new Store(db, f.now);
const chat = async (f: Fixture, id: string) => f.ingress.receive(event(id, { kind: 'command', command: 'urgent', text: '대화' }));
const settled = (results: PromiseSettledResult<unknown>[]) => results.map(result => {
  assert.equal(result.status, 'fulfilled', result.status === 'rejected' ? String(result.reason) : '');
  return (result as PromiseFulfilledResult<unknown>).value;
});
async function askedOn(f: Fixture, db: Database, id = 'task') {
  const local = lane(f);
  local.worker.scripts.push(reply.question());
  const job = await task(f, db, id);
  assert.equal(await local.runtime.tickTask(), true);
  const sid = (await db.query<{ claude_session_id: string }>('SELECT claude_session_id FROM codex_sessions WHERE job_id=$1', [job.id])).rows[0]!.claude_session_id;
  return { ...local, job, sid, question: taskQuestionId(job.id, sid, 1) };
}

test('실제 PostgreSQL: 여러 인스턴스가 동시에 claim해도 레인당 1개, 레인끼리는 따로 잡는다', { skip }, async () => {
  const { db, f, close } = await setup();
  try {
    for (let i = 0; i < 4; i++) { await task(f, db, `task-${i}`); await chat(f, `chat-${i}`); }
    const attempts = Array.from({ length: 6 }, (_, i) => instance(db, f).claim(i % 2 ? 'task' : 'interactive'));
    const claimed = settled(await Promise.allSettled(attempts)).filter(Boolean) as { type: string }[];
    assert.deepEqual(claimed.map(job => job.type).sort(), ['chat', 'task']);
    const active = (await db.query<{ execution_lane: string; count: string }>(`SELECT execution_lane,count(*) FROM jobs WHERE state='running' GROUP BY execution_lane ORDER BY execution_lane`)).rows;
    assert.deepEqual(active.map(row => [row.execution_lane, Number(row.count)]), [['interactive', 1], ['task', 1]]);
    assert.equal(await instance(db, f).claim('task'), undefined);
    assert.equal(await instance(db, f).claim('interactive'), undefined);
  } finally { await close(); }
});
test('실제 PostgreSQL: 작업 레인 행을 쥔 동안에도 대화 claim은 기다리지 않는다', { skip }, async () => {
  const { db, f, close } = await setup();
  try {
    await task(f, db, 'task-1'); await chat(f, 'chat-1');
    const held = pausing(db, sql => /FROM execution_lanes WHERE lane=\$1 FOR UPDATE/.test(sql));
    const taskClaim = new Store(held.db, f.now).claim('task');
    await held.paused;
    // 작업 claim이 scheduler 행까지 쥐고 있으면 대화 claim이 그 행을 기다린다. 커밋이 끝나면 곧바로 풀린다.
    const interactive = instance(db, f).claim('interactive');
    await sleep(100);
    held.release();
    const [a, b] = await Promise.allSettled([taskClaim, interactive]);
    const [taskJob, chatJob] = settled([a, b]) as [{ type: string }, { type: string }];
    assert.equal(taskJob.type, 'task'); assert.equal(chatJob.type, 'chat');
  } finally { await close(); }
});
test('실제 PostgreSQL: 두 답 경합은 하나만 받고 재개 대기는 하나다', { skip }, async () => {
  const { db, f, close } = await setup();
  try {
    const { bridge, question } = await askedOn(f, db);
    const results = settled(await Promise.allSettled(['a', 'b', 'c', 'd'].map(id => answer(bridge, question, `답 ${id}`, `answer-${id}`)))) as { ok: boolean }[];
    assert.equal(results.filter(result => result.ok).length, 1);
    assert.equal((await jobs(db))[0]!.state, 'queued');
    assert.equal((await allRows(db, 'codex_questions'))[0]!.state, 'answered');
    assert.equal((await allRows(db, 'audit')).filter(row => row.kind === 'task_answer_accepted').length, 1);
    // 같은 이벤트가 동시에 두 번 와도 한 번만 반영한다.
    const again = settled(await Promise.allSettled([1, 2].map(() => answer(bridge, question, '또', (results.findIndex(r => r.ok) >= 0 ? `answer-${['a', 'b', 'c', 'd'][results.findIndex(r => r.ok)]}` : 'x'))))) as { ok: boolean; duplicate?: boolean }[];
    assert.ok(again.every(result => result.ok && result.duplicate));
  } finally { await close(); }
});
test('실제 PostgreSQL: 답·만료 경합은 한쪽으로만 끝나고 잠금 시간 초과가 없다', { skip }, async () => {
  const { db, f, close } = await setup();
  try {
    const { bridge, question, job } = await askedOn(f, db);
    f.advance(TASK_RETENTION.questionTtlMs); f.policy.confirmedAt = f.now();
    const [a, b] = await Promise.allSettled([answer(bridge, question, 'main', 'late'), bridge.expireQuestions()]);
    const [result] = settled([a, b]) as [{ ok: boolean }, number];
    assert.equal(result.ok, false);
    const current = (await jobs(db))[0]!;
    assert.equal(current.id, job.id); assert.equal(current.state, 'cancelled'); assert.equal(current.wait_reason, 'question_expired');
    assert.equal((await allRows(db, 'codex_questions'))[0]!.state, 'expired');
    assert.equal((await db.query("SELECT 1 FROM outbox WHERE idempotency_key LIKE 'task-expired:%'")).rows.length, 1);
  } finally { await close(); }
});
test('실제 PostgreSQL: 답·취소 경합은 어느 쪽이 먼저든 재개가 없거나 답이 거부된다', { skip }, async () => {
  for (let round = 0; round < 4; round++) {
    const { db, f, close } = await setup();
    try {
      const { bridge, question, job, worker, runtime } = await askedOn(f, db);
      const [a, b] = await Promise.allSettled(round % 2
        ? [answer(bridge, question, 'main', 'a-1'), f.store.control('fixture-owner', conversationId(f), 'cancel', job.id)]
        : [f.store.control('fixture-owner', conversationId(f), 'cancel', job.id), answer(bridge, question, 'main', 'a-1')]);
      settled([a, b]);
      assert.equal((await jobs(db))[0]!.state, 'cancelled');
      await runtime.tickTask();
      assert.equal(worker.executes.length, 1, '재개 없음');
      assert.equal((await allRows(db, 'codex_sessions'))[0]!.state, 'cancelled');
      assert.notEqual((await allRows(db, 'codex_questions'))[0]!.state, 'open');
    } finally { await close(); }
  }
});
test('실제 PostgreSQL: 답·비상 중지 경합 뒤 해제 전에는 재개되지 않는다', { skip }, async () => {
  const { db, f, close } = await setup();
  try {
    const { bridge, question, worker, runtime } = await askedOn(f, db);
    const [a, b] = await Promise.allSettled([answer(bridge, question, 'main', 'a-1'), f.store.control('fixture-owner', conversationId(f), 'emergency-stop')]);
    settled([a, b]);
    assert.equal(await runtime.tickTask(), false);
    assert.equal(worker.executes.length, 1);
    assert.equal(await instance(db, f).claim('task'), undefined);
    assert.equal(await instance(db, f).claim('interactive'), undefined);
    const released = await f.store.control('fixture-owner', conversationId(f), 'resume-model', 'emergency-stop') as { ok: boolean };
    assert.equal(released.ok, true);
    worker.scripts.push(reply.completed());
    assert.equal(await runtime.tickTask(), true);
    assert.equal(worker.executes.length, 2);
  } finally { await close(); }
});
test('실제 PostgreSQL: 같은 세션 중복 resume은 인스턴스가 달라도 하나만 작업자에 간다', { skip }, async () => {
  const { db, f, close } = await setup();
  try {
    const { bridge, question, job, worker } = await askedOn(f, db);
    await answer(bridge, question, 'main', 'a-1');
    const claimed = (await instance(db, f).claim('task'))!;
    assert.equal(claimed.id, job.id);
    const other = new ClaudeTaskBridge(instance(db, f), f.gate, worker, { plan: async () => PLAN }, { monitorMs: 5, stopWaitMs: 50 });
    settled(await Promise.allSettled([bridge.run(claimed), other.run({ ...claimed })]));
    assert.equal(worker.executes.length, 2, '첫 턴 + 재개 1번');
    assert.equal((await jobs(db))[0]!.state, 'succeeded');
    assert.equal((await allRows(db, 'codex_sessions'))[0]!.turn, 2);
  } finally { await close(); }
});
test('실제 PostgreSQL: lease 교체 뒤 늦은 응답은 새 실행의 행을 건드리지 못한다', { skip }, async () => {
  const { db, f, close } = await setup();
  try {
    let release!: () => void;
    const held = new Promise<void>(resolve => { release = resolve; });
    const quiet = lane(f, { monitorMs: 3_600_000 });
    quiet.worker.scripts.push(async (request, worker) => { await held; return reply.completed('옛 결과')(request, worker); });
    const job = await task(f, db);
    const running = quiet.runtime.tickTask();
    await until(() => quiet.worker.executes.length === 1);
    const lease = randomUUID();
    await db.query('UPDATE jobs SET lease_token=$2 WHERE id=$1', [job.id, lease]);
    await db.query('UPDATE codex_sessions SET worker_lease=$2 WHERE job_id=$1', [job.id, lease]);
    release();
    await running;
    assert.equal((await allRows(db, 'results')).length, 0);
    assert.equal((await jobs(db))[0]!.lease_token, lease);
    assert.equal((await allRows(db, 'codex_sessions'))[0]!.state, 'running');
  } finally { await close(); }
});
test('실제 PostgreSQL: 턴 확정이 제어 경로·수신 접수와 겹쳐도 잠금 시간 초과 없이 끝난다', { skip }, async () => {
  for (let round = 0; round < 5; round++) {
    const { db, f, close } = await setup();
    try {
      const second = lane(f, { monitorMs: 3_600_000 });
      let finish!: () => void;
      const hold = new Promise<void>(resolve => { finish = resolve; });
      second.worker.scripts.push(async (request, worker) => { await hold; return reply.question()(request, worker); });
      const other = await task(f, db, 'task-2');
      const live = second.runtime.tickTask();
      await until(() => second.worker.executes.length === 1);
      finish();
      const [a, b, c, d] = await Promise.allSettled([live, f.store.control('fixture-owner', conversationId(f), 'model-status'),
        f.store.control('fixture-owner', conversationId(f), 'cancel', other.id), chat(f, `chat-${round}`)]);
      settled([a, b, c, d]);
      assert.ok(['cancelled', 'waiting_user'].includes((await jobs(db)).find(row => row.id === other.id)!.state));
    } finally { await close(); }
  }
});
test('실제 PostgreSQL: 비상 중지와 실행 중 작업·대화가 겹쳐도 두 레인 모두 멈추고 unknown은 레인을 닫되 대화는 막지 않는다', { skip }, async () => {
  const { db, f, close } = await setup();
  try {
    const local = lane(f);
    local.worker.scripts.push(hang);
    local.worker.stopped = false;
    const job = await task(f, db);
    const running = local.runtime.tickTask();
    await until(() => local.worker.executes.length === 1);
    await chat(f, 'chat-1');
    const chatJob = (await instance(db, f).claim('interactive'))!;
    assert.equal(chatJob.type, 'chat');
    await f.store.control('fixture-owner', conversationId(f), 'cancel', job.id);
    await running;
    assert.equal((await jobs(db)).find(row => row.id === job.id)!.state, 'unknown');
    assert.equal((await laneRow(db)).closed_reason, 'unknown');
    await f.store.transition(chatJob, 'failed', 'fixture');
    await chat(f, 'chat-2');
    assert.equal((await instance(db, f).claim('interactive'))?.type, 'chat');
    await f.store.control('fixture-owner', conversationId(f), 'emergency-stop');
    await chat(f, 'chat-3');
    assert.equal(await instance(db, f).claim('interactive'), undefined);
    assert.equal(await instance(db, f).claim('task'), undefined);
  } finally { await close(); }
});
test('실제 PostgreSQL: 정리 전 PVC 교체 뒤 여러 인스턴스가 겹쳐 재시도해도 옛 identity와 보존 기록을 잃지 않는다', { skip }, async () => {
  const { db, f, close } = await setup();
  try {
    const local = lane(f, { finalizeRetryMs: 0 });
    const { old } = await retainedThenStorageReplaced(local, f, db);
    const other = new ClaudeTaskBridge(instance(db, f), f.gate, local.worker, { plan: async () => PLAN }, { monitorMs: 5, stopWaitMs: 50, finalizeRetryMs: 0 });
    for (let round = 0; round < 3; round++) settled(await Promise.allSettled([local.bridge.sweep(), other.sweep()]));
    const row = (await allRows(db, 'codex_sessions'))[0]!;
    assert.equal(row.worker_storage, old.storage);
    assert.notEqual(row.worker_storage, OTHER_STORAGE);
    assert.equal(row.session_retained, true);
    assert.equal(row.cleanup_state, 'pending');
    assert.equal((await laneRow(db)).closed_reason, 'cleanup_pending');
    assert.equal(local.worker.finalizes.length, 0);
  } finally { await close(); }
});
test('실제 PostgreSQL: 작업 레인 unknown이 있을 때 해제·claim·접수가 겹쳐도 대화만 다시 돌고 작업 레인은 닫힌 채다', { skip }, async () => {
  for (let round = 0; round < 4; round++) {
    const { db, f, close } = await setup();
    try {
      const local = lane(f);
      local.worker.scripts.push(reply.unknown());
      const job = await task(f, db);
      await local.runtime.tickTask();
      await f.store.control('fixture-owner', conversationId(f), 'emergency-stop');
      await chat(f, 'chat-1');
      const release = () => instance(db, f).control('fixture-owner', conversationId(f), 'resume-model', 'emergency-stop');
      const results = await Promise.allSettled([release(), instance(db, f).claim('interactive'), instance(db, f).claim('task'), release(),
        instance(db, f).claim('task'), f.store.control('fixture-owner', conversationId(f), 'model-status'), local.bridge.sweep(),
        f.ingress.receive(event(`closed-${round}`, { kind: 'command', command: 'task', scope: thread }))]);
      assert.equal(results[7]!.status, 'rejected', '닫힌 레인의 새 작업');
      const values = settled(results.slice(0, 7));
      // 먼저 풀린 뒤 대화가 집혔으면 나중 해제는 실행 중인 대화 때문에 거부된다.
      assert.ok((values[0] as { ok: boolean }).ok || (values[3] as { ok: boolean }).ok);
      assert.equal(values[2], undefined); assert.equal(values[4], undefined);
      const claimed = values[1] as { type: string } | undefined ?? await instance(db, f).claim('interactive');
      assert.equal(claimed?.type, 'chat');
      assert.equal((await laneRow(db)).closed_reason, 'unknown');
      assert.equal(await instance(db, f).claim('task'), undefined);
      assert.equal(local.worker.executes.length, 1);
      assert.equal((await jobs(db)).find(row => row.id === job.id)!.state, 'unknown');
      assert.equal((await db.query("SELECT 1 FROM jobs WHERE type='task'")).rows.length, 1);
    } finally { await close(); }
  }
});
test('실제 PostgreSQL: 실행 중인 대화가 있으면 작업 레인 unknown만 남을 때까지 해제되지 않고 대화 unknown이면 거부한다', { skip }, async () => {
  const { db, f, close } = await setup();
  try {
    const local = lane(f);
    local.worker.scripts.push(reply.unknown());
    await task(f, db);
    await local.runtime.tickTask();
    await chat(f, 'chat-1');
    const chatJob = (await instance(db, f).claim('interactive'))!;
    await f.store.control('fixture-owner', conversationId(f), 'emergency-stop');
    const attempts = settled(await Promise.allSettled([1, 2, 3].map(() => instance(db, f).control('fixture-owner', conversationId(f), 'resume-model', 'emergency-stop')))) as { ok: boolean }[];
    assert.ok(attempts.every(result => !result.ok));
    f.advance(120_000); f.policy.confirmedAt = f.now();
    await instance(db, f).expire();
    assert.equal((await jobs(db)).find(row => row.id === chatJob.id)!.state, 'unknown');
    assert.equal((await instance(db, f).control('fixture-owner', conversationId(f), 'resume-model', 'emergency-stop') as { ok: boolean }).ok, false);
    assert.equal(await instance(db, f).claim('interactive'), undefined);
  } finally { await close(); }
});
test('실제 PostgreSQL: 해제와 늦은 응답이 어떤 순서로 겹쳐도 해제된 작업이 레인을 다시 닫지 않는다', { skip }, async () => {
  for (let round = 0; round < 8; round++) {
    const { db, f, close } = await setup();
    try {
      const local = await expiredWhileWaiting(f, db, round % 2 ? reply.unknown() : reply.completed('늦은 결과'));
      const [first, second] = round % 4 < 2
        ? [local.bridge.release('fixture-owner', thread, local.job.id), (async () => { local.deliver(); await local.running; })()]
        : [(async () => { local.deliver(); await local.running; })(), local.bridge.release('fixture-owner', thread, local.job.id)];
      const results = settled(await Promise.allSettled([first, second]));
      const released = results.find(value => value) as { ok: boolean };
      assert.equal(released.ok, true);
      assert.equal((await jobs(db))[0]!.state, 'cancelled');
      const row = (await allRows(db, 'codex_sessions'))[0]!;
      assert.equal(row.state, 'cancelled');
      assert.equal(row.session_retained, false);
      assert.equal((await laneRow(db)).closed_reason, null);
      assert.equal((await allRows(db, 'results')).length, 0);
      await local.bridge.sweep();
      assert.equal((await laneRow(db)).closed_reason, null);
    } finally { await close(); }
  }
});
test('실제 PostgreSQL: 해제 뒤 늦은 응답을 두 인스턴스의 sweep과 겹쳐도 세션은 정리된 채다', { skip }, async () => {
  const { db, f, close } = await setup();
  try {
    const local = await expiredWhileWaiting(f, db, reply.unknown());
    assert.equal((await local.bridge.release('fixture-owner', thread, local.job.id)).ok, true);
    const other = new ClaudeTaskBridge(instance(db, f), f.gate, local.worker, { plan: async () => PLAN }, { monitorMs: 5, stopWaitMs: 50, finalizeRetryMs: 0 });
    local.deliver();
    settled(await Promise.allSettled([local.running, other.sweep(), local.bridge.sweep()]));
    const row = (await allRows(db, 'codex_sessions'))[0]!;
    assert.equal(row.state, 'cancelled'); assert.equal(row.cleanup_state, 'cleaned');
    assert.equal((await laneRow(db)).closed_reason, null);
  } finally { await close(); }
});
test('실제 PostgreSQL: 취소·제어·접수가 겹쳐도 unknown 실행 응답과 취소 확인을 합쳐 cancelled로 끝난다', { skip }, async () => {
  for (let round = 0; round < 4; round++) {
    const { db, f, close } = await setup();
    try {
      const local = lane(f);
      local.worker.scripts.push(answerOnAbort(reply.unknown()));
      const job = await task(f, db);
      const running = local.runtime.tickTask();
      await until(() => local.worker.executes.length === 1);
      const results = await Promise.allSettled([running, f.store.control('fixture-owner', conversationId(f), 'cancel', job.id),
        instance(db, f).control('fixture-owner', conversationId(f), 'model-status'), chat(f, `chat-${round}`)]);
      settled(results);
      const current = (await jobs(db)).find(row => row.id === job.id)!;
      assert.equal(current.state, 'cancelled');
      assert.equal((await allRows(db, 'codex_sessions'))[0]!.state, 'cancelled');
      assert.equal((await laneRow(db)).closed_reason, null);
      assert.equal(local.worker.cancels.length, 1);
    } finally { await close(); }
  }
});
test('실제 PostgreSQL: Claude·Codex 해제가 겹쳐도 Codex 세션은 소멸 확인 경로로만 풀린다', { skip }, async () => {
  for (let round = 0; round < 4; round++) {
    const { db, f, close } = await setup();
    try {
      const local = lane(f);
      const { job } = await codexSession(f, db);
      const codex = codexBridge(f);
      const results = settled(await Promise.allSettled(round % 2
        ? [local.bridge.release('fixture-owner', thread, job.id), codex.bridge.release('fixture-owner', thread, job.id)]
        : [codex.bridge.release('fixture-owner', thread, job.id), local.bridge.release('fixture-owner', thread, job.id)])) as { ok: boolean }[];
      assert.equal(results.filter(result => result.ok).length, 1);
      assert.equal(local.worker.cancels.length, 0);
      assert.deepEqual(codex.confirms, [job.id]);
      assert.equal((await jobs(db)).find(row => row.id === job.id)!.state, 'cancelled');
      const row = (await allRows(db, 'codex_sessions'))[0]!;
      assert.equal(row.executor, 'codex'); assert.equal(row.state, 'unknown');
      assert.ok(!(await allRows(db, 'audit')).some(a => a.kind === 'task_unknown_released'));
    } finally { await close(); }
  }
});
test('실제 PostgreSQL: 다른 인스턴스가 지운 뒤 도착한 정리 실패가 cleaned를 되돌리지 않는다', { skip }, async () => {
  const { db, f, close } = await setup();
  try {
    const local = lane(f, { finalizeRetryMs: 0 });
    const other = new ClaudeTaskBridge(instance(db, f), f.gate, local.worker, { plan: async () => PLAN }, { monitorMs: 5, stopWaitMs: 50, finalizeRetryMs: 0 });
    local.worker.statusFails = true;
    await task(f, db);
    await local.runtime.tickTask();
    local.worker.statusFails = false;
    local.worker.onControl = async endpoint => {
      if (endpoint !== '/v1/task/status') return;
      local.worker.onControl = undefined;
      await other.sweep();
      local.worker.statusFails = true;
    };
    await local.bridge.sweep();
    const row = (await allRows(db, 'codex_sessions'))[0]!;
    assert.equal(row.cleanup_state, 'cleaned');
    assert.equal((await laneRow(db)).closed_reason, null);
  } finally { await close(); }
});
test('실제 PostgreSQL: owner 확인 요청 표시 직전 취소된 작업에는 표시도 알림도 남기지 않는다', { skip }, async () => {
  const { db, f, close } = await setup();
  try {
    const local = lane(f);
    local.worker.scripts.push(reply.limited('auth_expired'));
    const job = await task(f, db);
    await local.runtime.tickTask();
    f.advance(TASK_RETENTION.modelWaitOwnerConfirmMs); f.policy.confirmedAt = f.now();
    const held = pausing(db, sql => /s\.waiting_since FROM codex_sessions/.test(sql));
    const paused = new ClaudeTaskBridge(new Store(held.db, f.now), f.gate, local.worker, { plan: async () => PLAN }, { monitorMs: 5, stopWaitMs: 50 });
    const sweeping = paused.sweep();
    await held.paused;
    await f.store.control('fixture-owner', conversationId(f), 'cancel', job.id);
    held.release();
    await sweeping;
    assert.equal((await allRows(db, 'codex_sessions'))[0]!.owner_confirm_requested_at, null);
    assert.equal((await db.query("SELECT 1 FROM outbox WHERE idempotency_key LIKE 'task-owner-confirm:%'")).rows.length, 0);
  } finally { await close(); }
});
test('실제 PostgreSQL: 접수와 레인 닫힘이 겹쳐도 닫힌 뒤 접수되지 않는다', { skip }, async () => {
  const { db, f, close } = await setup();
  try {
    const first = new FakeTaskWorker();
    const bridge = new ClaudeTaskBridge(f.store, f.gate, first, { plan: async () => PLAN }, { monitorMs: 5 });
    first.scripts.push(reply.unknown());
    await task(f, db);
    const claimed = (await instance(db, f).claim('task'))!;
    await bridge.run(claimed);
    assert.equal((await laneRow(db)).closed_reason, 'unknown');
    const results = await Promise.allSettled(['a', 'b'].map(id => f.ingress.receive(event(`closed-${id}`, { kind: 'command', command: 'task', scope: thread }))));
    for (const result of results) assert.equal(result.status, 'rejected');
    assert.equal((await db.query("SELECT 1 FROM jobs WHERE type='task'")).rows.length, 1);
  } finally { await close(); }
});
