import { after, before, beforeEach, test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { resolve } from 'node:path';
import { ClaudeTaskBridge } from '../src/claude-task-bridge.js';
import { DEFAULTS, Denied, PolicyUnavailable } from '../src/contracts.js';
import type { Database } from '../src/database.js';
import { ReviewRuntime } from '../src/review.js';
import { Runtime } from '../src/runtime.js';
import { LaneClosed, Store } from '../src/store.js';
import { TASK_RETENTION, taskQuestionId } from '../src/task-contracts.js';
import { event, fixture, localDatabase, thread } from './helpers.js';
import { ABSENT, FakeTaskWorker, OTHER_STORAGE, PLAN, allRows, answer, answerOnAbort, codexBridge, codexSession, control, conversationId, expiredWhileWaiting, hang, jobs, lane, laneRow, rejectStart, reply, retainedThenStorageReplaced, task, until } from './task-lane-fixture.js';
import type { Fixture } from './task-lane-fixture.js';

// 중립 브리지와 작업 레인 스케줄링. 질문 사례는 test/codex-bridge.test.ts의 TASK-02·AUTH-02와 같은 의미를 Claude 턴으로 본다.
// 다중 연결 경합은 test/task-lane-pg.test.ts다. PGlite는 연결이 하나라 행 잠금 대기를 재현하지 못한다.
let database: Awaited<ReturnType<typeof localDatabase>>;
let f: Fixture;
let setup: ReturnType<typeof lane>;
before(async () => { database = await localDatabase(); });
const RESET = `TRUNCATE events,conversations,jobs,results,outbox,schedules,denied_actors,controls,audit,incidents,codex_sessions,codex_questions RESTART IDENTITY CASCADE;
  UPDATE execution_lanes SET closed_reason=NULL,closed_at=NULL`;
beforeEach(async () => {
  await database.pg.exec(RESET);
  f = await fixture(database.db);
  setup = lane(f);
});
after(async () => { await database.pg.close(); });
const db = () => database.db;
const rows = (table: string) => allRows(db(), table);
const newTask = (id?: string, text?: string) => task(f, db(), id, text);
const session = async () => (await rows('codex_sessions'))[0]!;
const outbox = async () => (await db().query<Record<string, any>>('SELECT * FROM outbox ORDER BY created_at,idempotency_key')).rows;
async function asked(question?: string) {
  setup.worker.scripts.push(reply.question(question));
  const job = await newTask();
  assert.equal(await setup.runtime.tickTask(), true);
  const sid = (await session()).claude_session_id as string;
  return { job, sid, question: taskQuestionId(job.id, sid, 1) };
}
const chat = async (id: string) => { await f.ingress.receive(event(id, { kind: 'command', command: 'urgent', text: '대화' })); };

test('게시 서버 로그: 완료·실패·unknown의 끝을 job·상태·사유 상수로 남기고 내용을 담지 않는다', async () => {
  const REQUEST = '사용자요청표식-비공개';
  const SUMMARY = '모델요약표식-비공개';
  const events: [string, Record<string, unknown> | undefined][] = [];
  const local = lane(f, { log: (event, detail) => { events.push([event, detail]); } });
  const finished = () => events.filter(([event]) => event === 'task_job_finished').map(([, detail]) => detail);

  local.worker.scripts.push(reply.completed(SUMMARY));
  const done = await newTask('log-done', REQUEST);
  await local.runtime.tickTask();
  assert.deepEqual(finished(), [{ job: done.id, state: 'succeeded', reason: null }]);

  events.length = 0;
  local.worker.scripts.push(reply.failed('api_error'));
  const failed = await newTask('log-failed', REQUEST);
  await local.runtime.tickTask();
  assert.deepEqual(finished(), [{ job: failed.id, state: 'failed', reason: 'task_api_error' }]);

  events.length = 0;
  local.worker.scripts.push(reply.unknown());
  local.worker.stopped = false;
  const unknown = await newTask('log-unknown', REQUEST);
  await local.runtime.tickTask();
  assert.deepEqual(finished(), [{ job: unknown.id, state: 'unknown', reason: 'task_unknown' }]);
  const text = JSON.stringify(events);
  assert.equal(text.includes(REQUEST), false);
  assert.equal(text.includes(SUMMARY), false);
});

test('게시 서버 로그: 대기로 들어가는 턴은 끝 기록을 남기지 않고, 재개 전 포기는 사유를 남긴다', async () => {
  const events: [string, Record<string, unknown> | undefined][] = [];
  const local = lane(f, { log: (event, detail) => { events.push([event, detail]); } });
  local.worker.scripts.push(reply.question());
  const job = await newTask();
  await local.runtime.tickTask();
  assert.equal(events.length, 0);
  const question = taskQuestionId(job.id, (await session()).claude_session_id as string, 1);
  await answer(local.bridge, question, '답', 'answer-log');
  local.worker.statusOverride = ABSENT;
  await local.runtime.tickTask();
  assert.deepEqual(events.filter(([event]) => event === 'task_job_finished'), [['task_job_finished', { job: job.id, state: 'failed', reason: 'task_session_missing' }]]);
});

test('게시 서버 로그: dispatch 전 오류는 사유 코드만 남기고 Runtime 분류로 넘긴다', async () => {
  const events: [string, Record<string, unknown> | undefined][] = [];
  const bridge = new ClaudeTaskBridge(f.store, f.gate, setup.worker, { plan: async () => { throw new Error('plan_unavailable'); } }, { monitorMs: 5, stopWaitMs: 50, log: (event, detail) => { events.push([event, detail]); } });
  const runtime = new Runtime(f.store, f.gate, f.worker, f.signer, f.reader, bridge, { taskLoop: true });
  const job = await newTask('log-prepare', '요청본문표식');
  await runtime.tickTask();
  assert.deepEqual(events.filter(([event]) => event === 'task_job_prepare_error'), [['task_job_prepare_error', { job: job.id, error: 'Error', reason: 'plan_unavailable' }]]);
  assert.equal(JSON.stringify(events).includes('요청본문표식'), false);
});

test('TASK-02 질문 중계 → owner 답 → 같은 세션 resume → 완료 → 영속 뒤 세션 정리', async () => {
  const { job, sid, question } = await asked('어느 브랜치 기준으로 고칠까요?');
  const current = (await jobs(db()))[0]!;
  assert.equal(current.state, 'waiting_user'); assert.equal(current.wait_reason, 'clarification');
  const q = (await rows('codex_questions'))[0]!;
  assert.equal(q.id, question); assert.equal(q.thread_id, sid); assert.equal(q.kind, 'clarification'); assert.equal(q.responder_id, 'fixture-owner');
  assert.equal(q.turn, 1); assert.equal(Number(q.expires_at), f.now() + TASK_RETENTION.questionTtlMs);
  assert.equal((await session()).state, 'waiting_answer'); assert.equal((await session()).executor, 'claude');
  await f.publisher.deliver();
  assert.match(f.rest.messages[0]!.body.content, new RegExp(`질문 ID: ${question}[\\s\\S]*어느 브랜치[\\s\\S]*권한을 바꿀 수 없습니다`));
  assert.deepEqual(await answer(setup.bridge, question, 'main 기준', 'answer-1'), { ok: true, status: '답을 받았습니다. 같은 세션을 이어서 실행합니다.' });
  assert.equal((await jobs(db()))[0]!.state, 'queued');
  setup.worker.scripts.push(reply.completed('main 기준으로 고쳤습니다.'));
  assert.equal(await setup.runtime.tickTask(), true);
  const resume = setup.worker.executes[1]!;
  assert.ok(resume.operation === 'resume');
  assert.equal(resume.sessionId, sid); assert.equal(resume.turn, 2); assert.equal(resume.generation, 1);
  assert.equal(resume.resumeReason, 'clarification'); assert.equal(resume.questionId, question); assert.deepEqual(resume.untrusted, { answer: 'main 기준' });
  assert.deepEqual(resume.expectedWorker, setup.worker.identity);
  assert.equal((await jobs(db()))[0]!.state, 'succeeded');
  assert.equal((await session()).turn, 2); assert.equal((await rows('codex_questions'))[0]!.state, 'resumed');
  const finalize = setup.worker.finalizes[0]!;
  assert.equal(finalize.receipt.outcome, 'succeeded');
  assert.equal(finalize.receipt.resultDigest, (await rows('results'))[0]!.evidence.resultDigest);
  assert.equal((await session()).session_retained, false); assert.equal((await session()).cleanup_state, 'cleaned');
  await f.publisher.deliver();
  assert.match(f.rest.messages[1]!.body.content, new RegExp(`작업 완료 \\(작업 ${job.id}\\)[\\s\\S]*main 기준`));
});
test('TASK-02 중복·다른 사람·다른 스레드·없는 질문·지난 턴 질문·빈 답·2000자 초과 거부', async () => {
  const { question } = await asked();
  await assert.rejects(answer(setup.bridge, question, 'main', 'x-1', thread, 'intruder'), Denied);
  await assert.rejects(answer(setup.bridge, question, 'main', 'x-2', { ...thread, channel: 'fixture-other-thread' }), Denied);
  f.policy.owner = 'replacement';
  await assert.rejects(answer(setup.bridge, question, 'main', 'x-6', thread, 'replacement'), Denied);
  f.policy.owner = 'fixture-owner';
  assert.equal((await answer(setup.bridge, 'missing:question:1', 'main', 'x-3')).ok, false);
  assert.equal((await answer(setup.bridge, question, '   ', 'x-4')).ok, false);
  assert.equal((await answer(setup.bridge, question, 'x'.repeat(2001), 'x-5')).ok, false);
  assert.equal((await rows('codex_questions'))[0]!.state, 'open');
  assert.equal((await answer(setup.bridge, question, 'x'.repeat(2000), 'answer-1')).ok, true);
  assert.deepEqual(await answer(setup.bridge, question, 'x'.repeat(2000), 'answer-1'), { ok: true, duplicate: true, status: '이미 받은 답입니다.' });
  assert.equal((await answer(setup.bridge, question, 'develop', 'answer-2')).ok, false);
  assert.equal((await rows('audit')).filter(a => a.kind === 'task_answer_accepted').length, 1);
  setup.worker.scripts.push(reply.question('시험도 고칠까요?'));
  await setup.runtime.tickTask();
  const [first, second] = (await db().query<Record<string, any>>('SELECT * FROM codex_questions ORDER BY turn')).rows;
  assert.equal(first!.state, 'resumed'); assert.equal(second!.state, 'open'); assert.equal(second!.turn, 2);
  assert.equal((await answer(setup.bridge, question, '늦은 답', 'late-1')).ok, false);
  assert.equal((await answer(setup.bridge, second!.id, '네', 'answer-3')).ok, true);
  assert.equal(setup.worker.executes.length, 2);
});
test('TASK-02 기한 1시간(가짜 시계): 지난 답은 거부하고 멈춤, 무응답 자동 진행 없음, 세션은 지운다', async () => {
  const { question } = await asked();
  f.advance(TASK_RETENTION.questionTtlMs - 1); f.policy.confirmedAt = f.now();
  assert.equal(await setup.bridge.expireQuestions(), 0);
  f.advance(1); f.policy.confirmedAt = f.now();
  assert.deepEqual(await answer(setup.bridge, question, 'main', 'late'), { ok: false, status: '기한이 지난 질문입니다. 작업을 멈췄습니다.' });
  const job = (await jobs(db()))[0]!;
  assert.equal(job.state, 'cancelled'); assert.equal(job.wait_reason, 'question_expired');
  assert.equal((await rows('codex_questions'))[0]!.state, 'expired');
  assert.equal((await session()).state, 'cancelled');
  assert.equal(await setup.runtime.tickTask(), false);
  assert.equal(setup.worker.executes.length, 1);
  assert.equal(setup.worker.finalizes[0]!.receipt.outcome, 'cancelled');
  assert.equal((await session()).session_retained, false);
});
test('TASK-02 sweep이 기한 지난 질문을 닫고 알림, 취소된 작업의 질문 답 거부·세션 정리', async () => {
  const { question } = await asked();
  f.advance(TASK_RETENTION.questionTtlMs); f.policy.confirmedAt = f.now();
  await setup.runtime.tickTask();
  assert.equal((await jobs(db()))[0]!.wait_reason, 'question_expired');
  assert.ok((await outbox()).some(row => row.idempotency_key === `task-expired:${question}`));
  assert.equal((await answer(setup.bridge, question, 'main', 'late')).ok, false);
  setup.worker.scripts.push(reply.question('다른 질문'));
  const second = await newTask('task-2');
  await setup.runtime.tickTask();
  const open = (await db().query<Record<string, any>>("SELECT * FROM codex_questions WHERE state='open'")).rows[0]!;
  await control(f, 'cancel', second.id);
  assert.deepEqual(await answer(setup.bridge, open.id, 'main', 'after-cancel'), { ok: false, status: '작업이 이 질문의 답을 기다리는 상태가 아닙니다.' });
  await setup.runtime.tickTask();
  const closed = (await db().query<Record<string, any>>('SELECT * FROM codex_sessions WHERE job_id=$1', [second.id])).rows[0]!;
  assert.equal(closed.state, 'cancelled'); assert.equal(closed.session_retained, false);
  assert.equal(setup.worker.executes.length, 2);
});
test('TASK-02 수신 트랜잭션 경계: answerIn은 호출자 트랜잭션과 함께 되돌려지고 함께 확정된다', async () => {
  const { question } = await asked();
  await assert.rejects(f.store.atomic(async store => {
    assert.equal((await setup.bridge.answerIn(store, { question, actor: 'fixture-owner', scope: thread, text: 'main', event: 'in-1' })).ok, true);
    throw new Error('inbox_deadline');
  }), /inbox_deadline/);
  assert.equal((await rows('codex_questions'))[0]!.state, 'open');
  assert.equal((await jobs(db()))[0]!.state, 'waiting_user');
  const result = await f.store.atomic(store => setup.bridge.answerIn(store, { question, actor: 'fixture-owner', scope: thread, text: 'main', event: 'in-1' }));
  assert.equal(result.ok, true);
  assert.equal((await rows('codex_questions'))[0]!.state, 'answered');
  await f.gate.revoke('fixture-owner', thread, 'fixture-owner');
  await assert.rejects(f.store.atomic(store => setup.bridge.answerIn(store, { question, actor: 'fixture-owner', scope: thread, text: 'main', event: 'in-2' })), Denied);
});
test('AUTH-02 답 직전 owner 교체·철회·정책 확인 불가는 차단, 수락 뒤 철회는 resume 전에 차단', async () => {
  const { question } = await asked();
  f.policy.owner = 'replacement';
  await assert.rejects(answer(setup.bridge, question, 'main', 'a-1'), Denied);
  f.policy.owner = 'fixture-owner';
  f.setPolicyUnavailable(true);
  await assert.rejects(answer(setup.bridge, question, 'main', 'a-2'), PolicyUnavailable);
  f.setPolicyUnavailable(false);
  assert.equal((await rows('codex_questions'))[0]!.state, 'open');
  assert.equal((await answer(setup.bridge, question, 'main', 'a-3')).ok, true);
  await f.gate.revoke('fixture-owner', thread, 'fixture-owner');
  await setup.runtime.tickTask();
  const job = (await jobs(db()))[0]!;
  assert.equal(job.state, 'cancelled'); assert.equal(job.wait_reason, 'authorization_revoked');
  assert.equal(setup.worker.executes.length, 1);
  await setup.runtime.tickTask();
  assert.equal((await session()).state, 'cancelled');
  assert.equal((await rows('codex_questions'))[0]!.state, 'cancelled');
});
test('AUTH-02 재개 dispatch 직전 철회: 계획 조회 중 철회되면 작업자를 부르지 않는다', async () => {
  const { question } = await asked();
  await answer(setup.bridge, question, 'main', 'a-1');
  const late = new ClaudeTaskBridge(f.store, f.gate, setup.worker, { plan: async () => { await f.gate.revoke('fixture-owner', thread, 'fixture-owner'); return PLAN; } }, { monitorMs: 5 });
  await new Runtime(f.store, f.gate, f.worker, f.signer, f.reader, late, { taskLoop: true }).tickTask();
  assert.equal((await jobs(db()))[0]!.wait_reason, 'authorization_revoked');
  assert.equal(setup.worker.executes.length, 1);
});
test('AUTH-02 실행 중 철회는 멈추고 소멸 확인에 따라 cancelled·unknown', async () => {
  for (const stopped of [true, false]) {
    await database.pg.exec(RESET);
    f.policy.owner = 'fixture-owner';
    const local = lane(f);
    local.worker.stopped = stopped;
    local.worker.scripts.push(hang);
    await newTask(`task-${stopped}`);
    const running = local.runtime.tickTask();
    await until(() => local.worker.executes.length === 1);
    f.policy.owner = 'replacement';
    await running;
    const job = (await jobs(db()))[0]!;
    assert.equal(job.state, stopped ? 'cancelled' : 'unknown'); assert.equal(job.wait_reason, 'authorization_revoked');
    assert.equal((await rows('results')).length, 0);
    assert.equal(local.worker.cancels.length, 1);
    assert.equal((await session()).state, stopped ? 'cancelled' : 'unknown');
  }
});
test('AUTH-02 마지막 감시 뒤 철회는 완료·질문·한도 대기로 확정하지 않고 취소', async () => {
  for (const [name, script] of [['completed', reply.completed()], ['question', reply.question()], ['limit', reply.limited()]] as const) {
    await database.pg.exec(RESET);
    f.policy.owner = 'fixture-owner';
    const local = lane(f, { monitorMs: 3_600_000 });
    local.worker.scripts.push((request, worker) => { f.policy.owner = 'replacement'; return script(request, worker); });
    await newTask(`revoke-${name}`);
    await local.runtime.tickTask();
    const job = (await jobs(db()))[0]!;
    assert.equal(job.state, 'cancelled', name); assert.equal(job.wait_reason, 'authorization_revoked', name);
    assert.equal((await rows('results')).length, 0); assert.equal((await rows('codex_questions')).length, 0);
    assert.equal((await rows('controls')).find(row => row.key === 'scheduler')?.value, false, name);
  }
});
test('질문은 유효한 needs_input과 턴 프로세스 0 확인 뒤에만: 깨진 응답·다른 턴은 질문을 만들지 않고 unknown', async () => {
  const forged = [
    (r: never, w: never) => ({ ...reply.question()(r, w), stopped: false }),
    (r: never, w: never) => ({ ...reply.question()(r, w), question: '   ' }),
    (r: never, w: never) => ({ ...reply.question()(r, w), turn: 2 }),
    (r: never, w: never) => ({ ...reply.question()(r, w), lease: '00000000-0000-4000-8000-000000000999' }),
    (r: never, w: never) => ({ ...reply.question()(r, w), cleanupPending: true }),
  ];
  for (const [index, script] of forged.entries()) {
    await database.pg.exec(RESET);
    const local = lane(f);
    local.worker.stopped = false;
    local.worker.scripts.push(script as never);
    await newTask(`forged-${index}`);
    await local.runtime.tickTask();
    assert.equal((await jobs(db()))[0]!.state, 'unknown', String(index));
    assert.equal((await rows('codex_questions')).length, 0, String(index));
    assert.equal((await laneRow(db())).closed_reason, 'unknown', String(index));
  }
  // 소멸은 확인됐지만 응답이 깨졌으면 실패다. 깨진 응답의 글이 질문·결과가 되지 않는다.
  await database.pg.exec(RESET);
  const local = lane(f);
  local.worker.scripts.push(forged[1] as never);
  await newTask('forged-stopped');
  await local.runtime.tickTask();
  assert.equal((await jobs(db()))[0]!.wait_reason, 'task_worker_lost');
  assert.equal((await rows('codex_questions')).length, 0);
});
test('TASK-03 취소는 소멸 확인 뒤에만 cancelled, 못 하면 unknown·레인 닫힘·알림', async () => {
  setup.worker.scripts.push(hang);
  const job = await newTask();
  const running = setup.runtime.tickTask();
  await until(() => setup.worker.executes.length === 1);
  await control(f, 'cancel', job.id);
  await running;
  assert.equal((await jobs(db()))[0]!.state, 'cancelled');
  assert.equal(setup.worker.cancels.length, 1);
  assert.equal((await rows('results')).length, 0);
  const second = lane(f);
  second.worker.stopped = false;
  second.worker.scripts.push(hang);
  const other = await newTask('task-2');
  const blocked = second.runtime.tickTask();
  await until(() => second.worker.executes.length === 1);
  await control(f, 'cancel', other.id);
  await blocked;
  assert.equal((await jobs(db()))[1]!.state, 'unknown');
  assert.equal((await laneRow(db())).closed_reason, 'unknown');
  assert.ok((await outbox()).some(row => row.idempotency_key === `task-blocked:${other.id}`));
});
test('시작 거부는 미시작의 증거: 실패로 끝내고 세션 공간을 묻지 않으며, 끊김은 소멸 확인으로 나눈다', async () => {
  setup.worker.scripts.push(rejectStart);
  const job = await newTask();
  await setup.runtime.tickTask();
  assert.equal((await jobs(db()))[0]!.wait_reason, 'task_worker_rejected');
  assert.equal((await session()).session_retained, false);
  assert.equal(setup.worker.cancels.length, 0); assert.equal(setup.worker.finalizes.length, 0);
  assert.equal((await laneRow(db())).closed_reason, null);
  // /retry는 새 세대·새 세션이다.
  const before = (await session()).claude_session_id;
  await control(f, 'retry', job.id);
  setup.worker.scripts.push(() => { throw new Error('connection_reset'); });
  await setup.runtime.tickTask();
  assert.equal(setup.worker.executes[1]!.generation, 2);
  assert.notEqual(setup.worker.executes[1]!.sessionId, before);
  assert.equal((await jobs(db()))[0]!.wait_reason, 'task_worker_lost');
  assert.equal(setup.worker.cancels.length, 1);
  assert.equal(setup.worker.cancels[0]!.expectedWorker, null);
});

// ---- 레인 ----
test('레인 독립: 작업 실행 중 대화 claim이 되고, 대화 실행 중 작업 claim이 된다. 레인 안은 직렬 1', async () => {
  setup.worker.scripts.push(hang);
  const job = await newTask();
  const running = setup.runtime.tickTask();
  await until(() => setup.worker.executes.length === 1);
  await newTask('task-2');
  assert.equal(await f.store.claim('task'), undefined);
  await chat('chat-1');
  let handled = false;
  f.setRun(async () => { handled = true; return { status: 'succeeded', stopped: true, answer: { facts: [], hypotheses: [], unknowns: [], checks: [] } }; });
  assert.equal(await setup.runtime.tick(), true);
  assert.equal(handled, true);
  assert.equal((await jobs(db())).find(j => j.type === 'chat')!.state, 'succeeded');
  assert.equal((await jobs(db())).find(j => j.id === job.id)!.state, 'running');
  await control(f, 'cancel', job.id);
  await running;
  // 대화가 실행 중이어도 작업은 집힌다.
  await chat('chat-2');
  const claimed = await f.store.claim('interactive');
  assert.equal(claimed?.type, 'chat');
  assert.equal(await f.store.claim('interactive'), undefined);
  const next = await f.store.claim('task');
  assert.equal(next?.type, 'task');
  assert.equal(await f.store.claim('task'), undefined);
  assert.equal(await setup.runtime.tick(), false);
});
test('질문 대기는 슬롯을 놓는다: 다음 작업이 돌고 같은 job은 답 전까지 집히지 않으며 답 뒤에도 슬롯이 비어야 집힌다', async () => {
  const { job, question } = await asked();
  setup.worker.scripts.push(reply.question('둘째 질문'));
  await newTask('task-2');
  assert.equal(await setup.runtime.tickTask(), true);
  assert.equal(setup.worker.executes.length, 2);
  assert.equal(setup.worker.executes[1]!.job !== job.id, true);
  assert.equal(await setup.runtime.tickTask(), false);
  await answer(setup.bridge, question, 'main', 'answer-1');
  setup.worker.scripts.push(hang);
  const running = setup.runtime.tickTask();
  await until(() => setup.worker.executes.length === 3);
  assert.equal(setup.worker.executes[2]!.job, job.id);
  const open = (await db().query<{ id: string }>("SELECT id FROM codex_questions WHERE state='open'")).rows[0]!;
  await answer(setup.bridge, open.id, '네', 'answer-2');
  assert.equal(await f.store.claim('task'), undefined);
  await control(f, 'cancel', job.id);
  await running;
});
test('질문 대기 중에도 chat은 돈다(단일 슬롯 배치와 다른 점)', async () => {
  await asked();
  await chat('chat-1');
  assert.equal(await setup.runtime.tick(), true);
  assert.equal((await jobs(db())).find(j => j.type === 'chat')!.state, 'succeeded');
});
test('작업 인증 대기는 작업 레인만 막는다. 대화는 돌고 scheduler는 켜지지 않으며, /resume-model로 같은 세션을 잇는다', async () => {
  setup.worker.scripts.push(reply.limited('auth_expired'));
  const job = await newTask();
  await setup.runtime.tickTask();
  assert.equal((await jobs(db()))[0]!.wait_reason, 'auth_expired');
  assert.equal((await rows('controls')).find(row => row.key === 'scheduler')!.value, false);
  assert.equal((await session()).state, 'waiting_model'); assert.equal((await session()).wait_reason, 'auth_expired');
  await newTask('task-2');
  assert.equal(await setup.runtime.tickTask(), false);
  await chat('chat-1');
  assert.equal(await setup.runtime.tick(), true);
  assert.equal((await control(f, 'resume-model', job.id)).ok, true);
  setup.worker.scripts.push(reply.completed());
  assert.equal(await setup.runtime.tickTask(), true);
  const resume = setup.worker.executes[1]!;
  assert.ok(resume.operation === 'resume');
  assert.equal(resume.job, job.id); assert.equal(resume.resumeReason, 'auth_expired'); assert.equal(resume.untrusted, undefined);
});
test('계정 한도 대기는 양쪽을 막는다: 작업 쪽 한도가 대화를, 대화 쪽 한도가 작업을 막고 재개하면 풀린다', async () => {
  setup.worker.scripts.push(reply.limited('limited'));
  const job = await newTask();
  await setup.runtime.tickTask();
  assert.equal((await rows('controls')).find(row => row.key === 'scheduler')!.value, true);
  await chat('chat-1');
  assert.equal(await f.store.claim('interactive'), undefined);
  await newTask('task-2');
  assert.equal(await f.store.claim('task'), undefined);
  assert.equal((await control(f, 'resume-model', job.id)).ok, true);
  assert.equal((await rows('controls')).find(row => row.key === 'scheduler')!.value, false);
  const claimedTask = await f.store.claim('task');
  assert.equal(claimedTask?.id, job.id);
  await f.store.transition(claimedTask!, 'cancelled', 'fixture');
  const chatJob = await f.store.claim('interactive');
  assert.equal(chatJob?.type, 'chat');
  // 대화 쪽 한도.
  await f.store.waitForUser(chatJob!, 'model_limit');
  assert.equal(await f.store.claim('task'), undefined);
  await control(f, 'cancel', chatJob!.id);
  assert.equal((await f.store.claim('task'))?.type, 'task');
});
test('대화 레인 인증 대기는 작업 레인을 막지 않는다(토큰이 다르다). scheduler 표시는 지금 그대로', async () => {
  await chat('chat-1');
  const chatJob = await f.store.claim('interactive');
  await f.store.waitForUser(chatJob!, 'auth_expired');
  assert.equal((await rows('controls')).find(row => row.key === 'scheduler')!.value, true);
  await chat('chat-2');
  assert.equal(await f.store.claim('interactive'), undefined);
  await newTask();
  assert.equal((await f.store.claim('task'))?.type, 'task');
});
test('한도로 끊긴 턴이 나르던 답은 /resume-model 뒤 같은 답으로 잇는다', async () => {
  const { job, question } = await asked();
  await answer(setup.bridge, question, 'main', 'answer-1');
  setup.worker.scripts.push(reply.limited('limited'));
  await setup.runtime.tickTask();
  assert.equal((await rows('codex_questions'))[0]!.state, 'answered');
  assert.equal((await control(f, 'resume-model', job.id)).ok, true);
  setup.worker.scripts.push(reply.completed());
  await setup.runtime.tickTask();
  const resume = setup.worker.executes[2]!;
  assert.ok(resume.operation === 'resume');
  assert.equal(resume.turn, 3); assert.equal(resume.resumeReason, 'model_limit'); assert.equal(resume.questionId, question); assert.deepEqual(resume.untrusted, { answer: 'main' });
  assert.equal((await rows('codex_questions'))[0]!.state, 'resumed');
});
test('emergency-stop은 두 레인을 모두 막고 실행 중 작업을 멈추며, 해제 전 답이 와도 돌지 않는다', async () => {
  const { question } = await asked();
  setup.worker.scripts.push(hang);
  await newTask('task-2');
  const running = setup.runtime.tickTask();
  await until(() => setup.worker.executes.length === 2);
  await control(f, 'emergency-stop');
  await running;
  assert.equal((await jobs(db()))[1]!.state, 'cancelled');
  await chat('chat-1');
  await newTask('task-3');
  assert.equal(await f.store.claim('interactive'), undefined);
  assert.equal(await f.store.claim('task'), undefined);
  assert.equal((await answer(setup.bridge, question, 'main', 'answer-1')).ok, true);
  assert.equal(await f.store.claim('task'), undefined);
  assert.equal((await control(f, 'resume-model', 'emergency-stop')).ok, true);
  assert.equal((await f.store.claim('interactive'))?.type, 'chat');
  assert.equal((await f.store.claim('task'))?.type, 'task');
});
test('unknown 뒤 레인 닫힘: 새 접수 거부·대화는 계속·디스크 DB 재시작 뒤 유지·소멸 확인 뒤에만 해제', async () => {
  const dir = resolve(await mkdtemp('.local/task-lane-db-'));
  try {
    const boot = async () => {
      const disk = await localDatabase(dir);
      const g = await fixture(disk.db);
      return { disk, g, ...lane(g) };
    };
    const first = await boot();
    first.worker.scripts.push(reply.unknown());
    await first.g.ingress.receive(event('disk-1', { kind: 'command', command: 'task' }));
    await first.runtime.tickTask();
    const job = (await jobs(first.disk.db))[0]!;
    assert.equal(job.state, 'unknown'); assert.equal(job.wait_reason, 'task_unknown');
    assert.equal((await laneRow(first.disk.db)).closed_reason, 'unknown');
    const identity = first.worker.identity;
    await first.disk.pg.close();
    const second = await boot();
    try {
      assert.equal((await laneRow(second.disk.db)).closed_reason, 'unknown');
      // 수신은 이벤트를 저장하고 접수에서 LaneClosed로 멈춘다. 처리 기록이 남지 않아 다시 보내면 다시 판정한다.
      await assert.rejects(second.g.ingress.receive(event('disk-2', { kind: 'command', command: 'task' })), (error: unknown) => error instanceof LaneClosed && error.reason === 'unknown');
      assert.equal((await jobs(second.disk.db)).length, 1);
      await second.g.ingress.receive(event('disk-chat', { kind: 'command', command: 'urgent', text: '대화' }));
      assert.equal(await second.runtime.tick(), true);
      assert.equal(await second.runtime.tickTask(), false);
      assert.equal(second.worker.executes.length, 0);
      second.worker.identity = identity;
      second.worker.stopped = false;
      assert.equal((await second.bridge.release('fixture-owner', thread, job.id)).ok, false);
      await assert.rejects(second.bridge.release('intruder', thread, job.id), Denied);
      second.worker.stopped = true;
      assert.equal((await second.bridge.release('fixture-owner', thread, job.id)).ok, true);
      assert.equal((await jobs(second.disk.db))[0]!.state, 'cancelled');
      assert.equal((await laneRow(second.disk.db)).closed_reason, null);
      assert.equal(second.worker.finalizes.length, 1);
      assert.equal((await second.bridge.release('fixture-owner', thread, job.id)).ok, false);
    } finally { await second.disk.pg.close(); }
  } finally { await rm(dir, { recursive: true, force: true }); }
});
test('정리 실패는 cleanup_pending으로 새 접수를 닫고, 재시도 간격 뒤 지워지면 다시 연다', async () => {
  setup.worker.finalizeCleans = false;
  await newTask();
  await setup.runtime.tickTask();
  assert.equal((await session()).cleanup_state, 'pending');
  assert.equal((await laneRow(db())).closed_reason, 'cleanup_pending');
  await assert.rejects(newTask('task-2'), LaneClosed);
  const calls = setup.worker.finalizes.length;
  await setup.runtime.tickTask();
  assert.equal(setup.worker.finalizes.length, calls, '재시도 간격 안');
  setup.worker.finalizeCleans = true;
  f.advance(30_000); f.policy.confirmedAt = f.now();
  await setup.runtime.tickTask();
  assert.equal((await session()).cleanup_state, 'cleaned');
  assert.equal((await laneRow(db())).closed_reason, null);
  await newTask('task-3');
  assert.equal(await setup.runtime.tickTask(), true);
});
test('응답의 cleanupPending도 레인을 닫고, 대기 세션은 지우지 않고 막힘만 푼다', async () => {
  setup.worker.scripts.push(reply.limited('auth_expired', true));
  const job = await newTask();
  await setup.runtime.tickTask();
  assert.equal((await session()).cleanup_state, 'pending');
  assert.equal((await laneRow(db())).closed_reason, 'cleanup_pending');
  f.advance(30_000); f.policy.confirmedAt = f.now();
  await setup.bridge.sweep();
  assert.equal((await session()).cleanup_state, 'none');
  assert.equal((await session()).session_retained, true);
  assert.equal((await laneRow(db())).closed_reason, null);
  assert.equal(setup.worker.finalizes.length, 0);
  assert.equal((await jobs(db()))[0]!.id, job.id);
});
test('보존 세션 8개면 retention_full: 새 접수·새 시작을 닫고 보존 중인 세션의 재개는 허용, 지우면 다시 연다', async () => {
  const questions: string[] = [];
  for (let i = 0; i < TASK_RETENTION.maxRetainedSessions; i++) {
    setup.worker.scripts.push(reply.question(`질문 ${i}`));
    await newTask(`retained-${i}`);
    assert.equal(await setup.runtime.tickTask(), true, String(i));
    questions.push((await db().query<{ id: string }>('SELECT id FROM codex_questions ORDER BY created_at DESC,turn DESC,id')).rows.find(row => !questions.includes(row.id))!.id);
    if (i === TASK_RETENTION.maxRetainedSessions - 2) assert.equal((await laneRow(db())).closed_reason, null);
  }
  assert.equal((await laneRow(db())).closed_reason, 'retention_full');
  await assert.rejects(newTask('over'), (error: unknown) => error instanceof LaneClosed && error.reason === 'retention_full');
  // 접수가 닫히기 전에 들어온 새 작업은 칸이 빌 때까지 시작하지 않는다.
  await db().query(`UPDATE execution_lanes SET closed_reason=NULL,closed_at=NULL WHERE lane='task'`);
  await db().query(`UPDATE codex_sessions SET session_retained=false WHERE job_id=(SELECT job_id FROM codex_sessions LIMIT 1)`);
  const queued = await newTask('queued-start');
  await db().query(`UPDATE codex_sessions SET session_retained=true`);
  assert.equal(await setup.runtime.tickTask(), false);
  assert.equal((await laneRow(db())).closed_reason, 'retention_full');
  assert.equal((await answer(setup.bridge, questions[0]!, 'main', 'answer-0')).ok, true);
  setup.worker.scripts.push(reply.completed());
  assert.equal(await setup.runtime.tickTask(), true);
  assert.equal(setup.worker.finalizes.length, 1);
  assert.equal((await laneRow(db())).closed_reason, null);
  setup.worker.scripts.push(reply.completed());
  assert.equal(await setup.runtime.tickTask(), true);
  assert.equal((await jobs(db())).find(j => j.id === queued.id)!.state, 'succeeded');
});
test('모델 대기 24시간(가짜 시계): owner 확인 요청 표시·알림 한 번만, 자동 재개·폐기 없음, 재개하면 지움', async () => {
  setup.worker.scripts.push(reply.limited('limited'));
  const job = await newTask();
  await setup.runtime.tickTask();
  const since = Number((await session()).waiting_since);
  assert.equal(since, f.now());
  f.advance(TASK_RETENTION.modelWaitOwnerConfirmMs - 1); f.policy.confirmedAt = f.now();
  await setup.bridge.sweep();
  assert.equal((await session()).owner_confirm_requested_at, null);
  f.advance(1); f.policy.confirmedAt = f.now();
  await setup.bridge.sweep();
  assert.equal(Number((await session()).owner_confirm_requested_at), f.now());
  const status = await setup.bridge.status('fixture-owner', thread, job.id);
  assert.equal(status.ownerConfirmRequestedAt, f.now()); assert.equal(status.waitingSince, since); assert.equal(status.state, 'waiting_user');
  f.advance(10 * TASK_RETENTION.modelWaitOwnerConfirmMs); f.policy.confirmedAt = f.now();
  await setup.bridge.sweep();
  assert.equal((await outbox()).filter(row => row.idempotency_key.startsWith('task-owner-confirm:')).length, 1);
  const waiting = (await jobs(db()))[0]!;
  assert.equal(waiting.state, 'waiting_user'); assert.equal(waiting.wait_reason, 'model_limit');
  assert.equal((await session()).session_retained, true);
  assert.equal(setup.worker.executes.length, 1); assert.equal(setup.worker.finalizes.length, 0);
  assert.equal(await setup.runtime.tickTask(), false);
  await control(f, 'resume-model', job.id);
  setup.worker.scripts.push(reply.limited('auth_expired'));
  await setup.runtime.tickTask();
  assert.equal((await session()).owner_confirm_requested_at, null);
  assert.equal(Number((await session()).waiting_since), f.now());
});
test('lease 교체: 넘겨받은 뒤 도착한 옛 응답은 어떤 행도 바꾸지 않고, lease가 끝난 응답은 unknown이다', async () => {
  let release!: () => void;
  const held = new Promise<void>(resolve => { release = resolve; });
  setup.worker.scripts.push(async (request, worker) => { await held; return reply.completed('옛 결과')(request, worker); });
  const quiet = lane(f, { monitorMs: 3_600_000 });
  quiet.worker.scripts = setup.worker.scripts;
  const job = await newTask();
  const running = quiet.runtime.tickTask();
  await until(() => quiet.worker.executes.length === 1);
  const lease = '00000000-0000-4000-8000-00000000abcd';
  await db().query('UPDATE jobs SET lease_token=$2 WHERE id=$1', [job.id, lease]);
  await db().query('UPDATE codex_sessions SET worker_lease=$2 WHERE job_id=$1', [job.id, lease]);
  release();
  await running;
  const current = (await jobs(db()))[0]!;
  assert.equal(current.state, 'running'); assert.equal(current.lease_token, lease);
  assert.equal((await rows('results')).length, 0);
  assert.equal((await session()).state, 'running');
  assert.ok((await rows('audit')).some(row => row.kind === 'task_stale_response'));
  // lease 만료 뒤 응답.
  await database.pg.exec(RESET);
  const late = lane(f, { monitorMs: 3_600_000 });
  late.worker.scripts.push((request, worker) => { f.advance(DEFAULTS.leaseMs + 1); f.policy.confirmedAt = f.now(); return reply.completed()(request, worker); });
  await newTask('late');
  await late.runtime.tickTask();
  assert.equal((await rows('results')).length, 0);
  assert.equal((await session()).state, 'unknown');
  await f.store.expire();
  assert.equal((await jobs(db()))[0]!.state, 'unknown');
  assert.equal((await laneRow(db())).closed_reason, 'unknown');
});
test('같은 세션 중복 resume은 하나만 띄운다(같은 lease로 겹친 run)', async () => {
  const { job, question } = await asked();
  await answer(setup.bridge, question, 'main', 'answer-1');
  const claimed = await f.store.claim('task');
  assert.equal(claimed?.id, job.id);
  setup.worker.scripts.push(reply.completed(), reply.completed());
  await Promise.all([setup.bridge.run(claimed!), setup.bridge.run({ ...claimed! })]);
  assert.equal(setup.worker.executes.length, 2);
  assert.equal((await jobs(db()))[0]!.state, 'succeeded');
});
test('같은 세션 중복 resume: 늦은 쪽이 옛 상태로 판단해도 돌고 있는 턴의 job을 되돌리거나 실패시키지 않는다', async () => {
  const variants: [string, () => void][] = [
    ['상태 확인 끊김(되돌림 시도)', () => { setup.worker.statusFails = true; }],
    ['작업자가 running이라고 답함(실패 시도)', () => { setup.worker.statusOverride = { state: 'running', stopped: false, sessionExists: true }; }],
  ];
  for (const [name, arrange] of variants) {
    await database.pg.exec(RESET);
    setup = lane(f);
    const { job, question } = await asked();
    await answer(setup.bridge, question, 'main', 'answer-1');
    const claimed = (await f.store.claim('task'))!;
    let finish!: () => void;
    const held = new Promise<void>(resolve => { finish = resolve; });
    setup.worker.scripts.push(async (request, worker) => { await held; return reply.completed()(request, worker); });
    let first: Promise<void> | undefined;
    // 늦은 쪽은 세션을 읽은 뒤 계획을 기다린다. 그동안 먼저 온 쪽이 턴을 시작해 작업자에 보낸다.
    const late = new ClaudeTaskBridge(f.store, f.gate, setup.worker, { plan: async () => {
      first = setup.bridge.run({ ...claimed });
      await until(() => setup.worker.executes.length === 2);
      arrange();
      return PLAN;
    } }, { monitorMs: 5 });
    await late.run({ ...claimed });
    const running = (await jobs(db()))[0]!;
    assert.equal(running.id, job.id);
    assert.equal(running.state, 'running', name); assert.equal(running.lease_token, claimed.lease_token, name);
    assert.equal((await session()).state, 'running', name);
    setup.worker.statusFails = false; setup.worker.statusOverride = undefined;
    // 턴이 도는 중에 온 run은 세션을 읽자마자 물러난다.
    await late.run({ ...claimed });
    assert.equal((await jobs(db()))[0]!.state, 'running', name);
    finish();
    await first;
    assert.equal((await jobs(db()))[0]!.state, 'succeeded', name);
    assert.equal(setup.worker.executes.length, 2, name);
  }
});
test('재개 전 확인: 세션 유실·저장소 변경은 새 세션으로 바꾸지 않고 실패, 파드만 바뀌면 같은 저장소로 잇고 작업자 단절은 대기', async () => {
  const first = await asked();
  await answer(setup.bridge, first.question, 'main', 'answer-1');
  setup.worker.statusFails = true;
  assert.equal(await setup.runtime.tickTask(), true);
  assert.equal((await jobs(db()))[0]!.state, 'queued');
  assert.equal((await jobs(db()))[0]!.wait_reason, 'task_worker_unavailable');
  setup.worker.statusFails = false;
  const moved = setup.worker.identity;
  setup.worker.identity = { instance: '00000000-0000-4000-8000-00000000beef', storage: moved.storage };
  f.advance(DEFAULTS.retryDelayMs); f.policy.confirmedAt = f.now();
  setup.worker.scripts.push(reply.completed());
  assert.equal(await setup.runtime.tickTask(), true);
  const resume = setup.worker.executes[1]!;
  assert.ok(resume.operation === 'resume');
  assert.equal(resume.expectedWorker.instance, setup.worker.identity.instance);
  assert.equal((await session()).worker_instance, setup.worker.identity.instance);
  // 저장소가 바뀐 경우.
  await database.pg.exec(RESET);
  const local = lane(f);
  local.worker.scripts.push(reply.question());
  const job = await newTask('storage');
  await local.runtime.tickTask();
  const sid = (await session()).claude_session_id;
  await answer(local.bridge, taskQuestionId(job.id, sid, 1), 'main', 'answer-2');
  local.worker.identity = { ...local.worker.identity, storage: '00000000-0000-4000-8000-00000000f00d' };
  await local.runtime.tickTask();
  assert.equal((await jobs(db()))[0]!.wait_reason, 'task_session_missing');
  assert.equal(local.worker.executes.length, 1);
  assert.equal((await rows('codex_questions'))[0]!.state, 'cancelled');
});
// ---- 저장소 identity ----
const nextRetry = () => { f.advance(30_000); f.policy.confirmedAt = f.now(); };
test('정리 전 PVC 교체: 다른 저장소의 absent를 몇 번 받아도 identity·보존 기록·cleanup_pending을 유지하고, 원래 저장소가 답해야 푼다', async () => {
  const { old } = await retainedThenStorageReplaced(setup, f, db());
  assert.equal((await session()).worker_storage, old.storage);
  assert.equal((await session()).cleanup_state, 'pending');
  for (let attempt = 0; attempt < 3; attempt++) {
    nextRetry();
    await setup.bridge.sweep();
    const row = await session();
    assert.equal(row.worker_storage, old.storage, `재시도 ${attempt}`);
    assert.equal(row.worker_instance, old.instance, `재시도 ${attempt}`);
    assert.equal(row.session_retained, true, `재시도 ${attempt}`);
    assert.equal(row.cleanup_state, 'pending', `재시도 ${attempt}`);
    assert.equal((await laneRow(db())).closed_reason, 'cleanup_pending', `재시도 ${attempt}`);
  }
  assert.equal(setup.worker.finalizes.length, 0);
  await assert.rejects(newTask('task-2'), LaneClosed);
  setup.worker.identity = { instance: crypto.randomUUID(), storage: old.storage };
  nextRetry();
  await setup.bridge.sweep();
  assert.equal((await session()).cleanup_state, 'cleaned');
  assert.equal((await session()).session_retained, false);
  assert.equal((await session()).worker_instance, setup.worker.identity.instance, '같은 저장소면 파드 교체는 따라간다');
  assert.equal((await laneRow(db())).closed_reason, null);
});
test('재개 전 저장소 변경으로 실패한 세션도 옛 identity를 유지해 정리를 보류한다', async () => {
  const first = await asked();
  await answer(setup.bridge, first.question, 'main', 'answer-1');
  const old = setup.worker.identity;
  setup.worker.identity = { ...old, storage: OTHER_STORAGE };
  setup.worker.statusOverride = undefined;
  await setup.runtime.tickTask();
  assert.equal((await jobs(db()))[0]!.wait_reason, 'task_session_missing');
  setup.worker.statusOverride = ABSENT;
  for (let attempt = 0; attempt < 2; attempt++) { nextRetry(); await setup.bridge.sweep(); }
  assert.equal((await session()).worker_storage, old.storage);
  assert.equal((await session()).session_retained, true);
  assert.equal((await laneRow(db())).closed_reason, 'cleanup_pending');
});
test('저장소를 모르는 세션은 absent 응답으로 identity를 묶지 않고, 세션이 있다고 답한 저장소에만 묶는다', async () => {
  await newTask();
  setup.worker.finalizeCleans = false;
  await setup.runtime.tickTask();
  await db().query(`UPDATE codex_sessions SET worker_instance=NULL,worker_storage=NULL,cleanup_state='pending',session_retained=true`);
  setup.worker.statusOverride = ABSENT;
  nextRetry();
  await setup.bridge.sweep();
  assert.equal((await session()).worker_storage, null, 'absent는 본 적 없다는 뜻이라 묶지 않는다');
  assert.equal((await session()).cleanup_state, 'pending');
  setup.worker.statusOverride = { state: 'waiting', sessionExists: true, stopped: true };
  nextRetry();
  await setup.bridge.sweep();
  assert.equal((await session()).worker_storage, setup.worker.identity.storage);
  assert.equal((await session()).cleanup_state, 'pending');
  // 이제 다른 저장소의 absent는 증명이 아니다.
  const held = setup.worker.identity.storage;
  setup.worker.identity = { ...setup.worker.identity, storage: OTHER_STORAGE };
  setup.worker.statusOverride = ABSENT;
  nextRetry();
  await setup.bridge.sweep();
  assert.equal((await session()).worker_storage, held);
  assert.equal((await session()).session_retained, true);
});
test('재개 턴 취소에 다른 저장소가 답하면 소멸 증명이 아니다: unknown으로 두고 identity·보존 기록을 덮어쓰지 않는다', async () => {
  const first = await asked();
  await answer(setup.bridge, first.question, 'main', 'answer-1');
  setup.worker.scripts.push(hang);
  const running = setup.runtime.tickTask();
  await until(() => setup.worker.executes.length === 2);
  const old = setup.worker.identity;
  setup.worker.identity = { instance: crypto.randomUUID(), storage: OTHER_STORAGE };
  await control(f, 'cancel', first.job.id);
  await running;
  const row = await session();
  assert.equal(row.state, 'unknown');
  assert.equal(row.worker_storage, old.storage);
  assert.equal(row.worker_instance, old.instance);
  assert.equal(row.session_retained, true);
  assert.equal((await jobs(db()))[0]!.state, 'unknown');
  assert.equal((await laneRow(db())).closed_reason, 'unknown');
});
test('unknown 해제: 다른 저장소의 취소 응답으로는 풀지 않는다', async () => {
  setup.worker.scripts.push(reply.unknown());
  const job = await newTask();
  await setup.runtime.tickTask();
  const old = setup.worker.identity;
  setup.worker.identity = { instance: crypto.randomUUID(), storage: OTHER_STORAGE };
  assert.equal((await setup.bridge.release('fixture-owner', thread, job.id)).ok, false);
  assert.equal((await jobs(db()))[0]!.state, 'unknown');
  assert.equal((await session()).worker_storage, old.storage);
  assert.equal((await laneRow(db())).closed_reason, 'unknown');
});
test('정리 중 경합: finalize가 다른 저장소에서 답하면 지운 것으로 치지 않고, 그 사이 새 세대가 시작했으면 그 세션을 건드리지 않는다', async () => {
  setup.worker.statusFails = true;
  await newTask();
  await setup.runtime.tickTask();
  setup.worker.statusFails = false;
  const old = setup.worker.identity;
  setup.worker.onControl = endpoint => { if (endpoint === '/v1/task/finalize') setup.worker.identity = { instance: crypto.randomUUID(), storage: OTHER_STORAGE }; };
  nextRetry();
  await setup.bridge.sweep();
  assert.equal((await session()).cleanup_state, 'pending');
  assert.equal((await session()).worker_storage, old.storage);
  // 작업자에 묻는 사이 세대가 바뀌면 묻기 전에 읽은 세션의 결론을 새 세대에 쓰지 않는다.
  setup.worker.identity = old;
  const before = await session();
  const fresh = crypto.randomUUID();
  setup.worker.onControl = async endpoint => {
    if (endpoint !== '/v1/task/status') return;
    await db().query(`UPDATE codex_sessions SET generation=generation+1,claude_session_id=$1,thread_id=$1,cleanup_state='none',session_retained=true,state='running'`, [fresh]);
  };
  nextRetry();
  await setup.bridge.sweep();
  const after = await session();
  assert.equal(after.generation, before.generation + 1);
  assert.equal(after.cleanup_state, 'none');
  assert.equal(after.session_retained, true);
});
test('새 세대 시작은 그 사이 보존으로 바뀐 앞 세대의 identity를 지우지 못한다', async () => {
  setup.worker.scripts.push(rejectStart);
  const job = await newTask();
  await setup.runtime.tickTask();
  await control(f, 'retry', job.id);
  const worker = new FakeTaskWorker();
  const racing = new ClaudeTaskBridge(f.store, f.gate, worker, { plan: async () => {
    await db().query(`UPDATE codex_sessions SET worker_storage=$1,worker_instance=$1,session_retained=true`, [OTHER_STORAGE]);
    return PLAN;
  } }, { monitorMs: 5, stopWaitMs: 50 });
  const claimed = (await f.store.claim('task'))!;
  await racing.run(claimed);
  assert.equal(worker.executes.length, 0, '작업자를 부르지 않는다');
  assert.equal((await session()).worker_storage, OTHER_STORAGE);
  assert.equal((await session()).session_retained, true);
});

// ---- 비상 중지 해제와 레인별 unknown ----
const emergencyReleased = async () => control(f, 'resume-model', 'emergency-stop') as Promise<{ ok?: boolean; status?: string; paused?: boolean; taskLane?: { closed: string | null; unknownJobs: string[] } }>;
const unknownTask = async (id = 'task') => {
  setup.worker.scripts.push(reply.unknown());
  const job = await newTask(id);
  await setup.runtime.tickTask();
  assert.equal((await jobs(db())).find(row => row.id === job.id)!.state, 'unknown');
  return job;
};
const unknownChat = async (id = 'chat-u') => {
  await chat(id);
  const job = (await f.store.claim('interactive'))!;
  assert.equal(job.type, 'chat');
  f.advance(DEFAULTS.leaseMs + 1); f.policy.confirmedAt = f.now();
  await f.store.expire();
  assert.equal((await jobs(db())).find(row => row.id === job.id)!.state, 'unknown');
  return job;
};
test('작업 레인 unknown이 있어도 비상 중지를 풀 수 있다: 대화 claim 가능·작업 claim 불가·레인은 닫힌 채, 응답·감사·Discord에 드러난다', async () => {
  const job = await unknownTask();
  await control(f, 'emergency-stop');
  await chat('chat-1');
  assert.equal(await f.store.claim('interactive'), undefined);
  const released = await emergencyReleased();
  assert.equal(released.ok, true);
  assert.equal(released.paused, false);
  assert.deepEqual(released.taskLane, { closed: 'unknown', unknownJobs: [job.id] });
  assert.match(released.status!, /작업 레인은 unknown으로 닫힌 채/);
  assert.ok(released.status!.includes(job.id));
  const audit = (await rows('audit')).find(row => row.kind === 'model_emergency_released')!;
  const detail = typeof audit.detail === 'string' ? JSON.parse(audit.detail) : audit.detail;
  assert.equal(detail.taskLaneClosed, 'unknown');
  assert.deepEqual(detail.taskUnknownJobs, [job.id]);
  assert.equal((await f.store.claim('interactive'))?.type, 'chat');
  assert.equal(await f.store.claim('task'), undefined);
  assert.equal((await laneRow(db())).closed_reason, 'unknown');
  await assert.rejects(newTask('task-2'), (error: unknown) => error instanceof LaneClosed && error.reason === 'unknown');
  assert.equal(setup.worker.executes.length, 1, '다시 실행하지 않는다');
  // /model-status에서도 보인다. /task-release 뒤에는 레인이 다시 열린다.
  const status = await control(f, 'model-status') as { status?: string; taskLaneClosed?: string | null };
  assert.equal(status.taskLaneClosed, 'unknown');
  assert.match(status.status!, /작업 레인은 unknown으로 닫혀/);
  assert.equal((await setup.bridge.release('fixture-owner', thread, job.id)).ok, true);
  assert.equal((await laneRow(db())).closed_reason, null);
});
test('해제 안내는 Discord 제어 응답으로 게시된다', async () => {
  const job = await unknownTask();
  await f.ingress.receive(event('stop-1', { kind: 'command', command: 'emergency-stop' }));
  await f.ingress.receive(event('release-1', { kind: 'command', command: 'resume-model', target: 'emergency-stop' }));
  const posted = (await outbox()).map(row => JSON.stringify(row.payload)).find(text => text.includes('작업 레인은 unknown으로 닫힌 채'));
  assert.ok(posted, '제어 응답에 레인 상태가 있다');
  assert.ok(posted.includes(job.id));
});
test('대화 레인 unknown은 지금처럼 비상 중지 해제를 거부한다', async () => {
  await unknownChat();
  await control(f, 'emergency-stop');
  const refused = await emergencyReleased();
  assert.equal(refused.ok, false);
  assert.match(refused.status!, /종료를 확인하지 못한 작업/);
  assert.equal(await f.store.claim('interactive'), undefined);
  assert.equal((await rows('audit')).filter(row => row.kind === 'model_emergency_released').length, 0);
});
test('두 레인 모두 unknown이면 거부하고, 대화 쪽이 풀리면 해제되며 작업 레인은 닫힌 채다', async () => {
  const taskJob = await unknownTask();
  const chatJob = await unknownChat();
  await control(f, 'emergency-stop');
  assert.equal((await emergencyReleased()).ok, false);
  assert.equal(await f.store.resolveUnknown(chatJob), true);
  const released = await emergencyReleased();
  assert.equal(released.ok, true);
  assert.deepEqual(released.taskLane?.unknownJobs, [taskJob.id]);
  await chat('chat-2');
  assert.equal((await f.store.claim('interactive'))?.type, 'chat');
  assert.equal(await f.store.claim('task'), undefined);
  assert.equal((await laneRow(db())).closed_reason, 'unknown');
});
test('실행 중인 작업은 unknown이 아니므로 지금처럼 해제를 막는다', async () => {
  setup.worker.scripts.push(hang);
  const job = await newTask();
  const running = setup.runtime.tickTask();
  await until(() => setup.worker.executes.length === 1);
  await db().query(`UPDATE controls SET value='true' WHERE key IN ('scheduler','scheduler_emergency')`);
  assert.equal((await emergencyReleased()).ok, false);
  await control(f, 'cancel', job.id);
  await running;
});
test('세션 전에 lease가 끝난 작업 unknown도 레인을 닫고, 닫힘이 기록된 뒤에야 해제된다', async () => {
  const job = await newTask();
  assert.equal((await f.store.claim('task'))?.id, job.id);
  f.advance(DEFAULTS.leaseMs + 1); f.policy.confirmedAt = f.now();
  await f.store.expire();
  assert.equal((await jobs(db()))[0]!.state, 'unknown');
  await control(f, 'emergency-stop');
  // 레인 행이 아직 닫힘을 모르면 새 작업을 받을 수 있어 풀지 않는다.
  assert.equal((await emergencyReleased()).ok, false);
  await setup.bridge.sweep();
  assert.equal((await laneRow(db())).closed_reason, 'unknown');
  assert.equal((await emergencyReleased()).ok, true);
  await chat('chat-1');
  assert.equal((await f.store.claim('interactive'))?.type, 'chat');
  assert.equal(await f.store.claim('task'), undefined);
  assert.equal((await setup.bridge.release('fixture-owner', thread, job.id)).ok, true);
  assert.equal((await laneRow(db())).closed_reason, null);
});
test('task off: 작업 레인이 닫혀 있지 않은 배치의 task unknown은 지금처럼 해제를 거부하고 레인 행을 바꾸지 않는다', async () => {
  const single = new Runtime(f.store, f.gate, f.worker, f.signer, f.reader);
  await newTask();
  const claimed = (await f.store.claim())!;
  assert.equal(claimed.type, 'task');
  f.advance(DEFAULTS.leaseMs + 1); f.policy.confirmedAt = f.now();
  await f.store.expire();
  await control(f, 'emergency-stop');
  assert.equal((await emergencyReleased()).ok, false);
  assert.equal((await laneRow(db())).closed_reason, null);
  assert.equal(await single.tickTask(), false);
});
test('재시작 뒤에도 유지: 비상 중지 해제는 재시작을 넘어 가능하고, 해제 뒤 재시작해도 대화는 돌고 작업 레인은 닫혀 있다', async () => {
  const dir = resolve(await mkdtemp('.local/task-lane-release-'));
  try {
    const boot = async () => {
      const disk = await localDatabase(dir);
      const g = await fixture(disk.db);
      return { disk, g, ...lane(g) };
    };
    const first = await boot();
    first.worker.scripts.push(reply.unknown());
    await first.g.ingress.receive(event('disk-1', { kind: 'command', command: 'task' }));
    await first.runtime.tickTask();
    const job = (await jobs(first.disk.db))[0]!;
    await control(first.g, 'emergency-stop');
    await first.disk.pg.close();
    const second = await boot();
    assert.equal((await laneRow(second.disk.db)).closed_reason, 'unknown');
    assert.equal((await control(second.g, 'resume-model', 'emergency-stop')).ok, true);
    await second.disk.pg.close();
    const third = await boot();
    try {
      assert.equal((await laneRow(third.disk.db)).closed_reason, 'unknown');
      assert.equal((await jobs(third.disk.db))[0]!.id, job.id);
      await assert.rejects(third.g.ingress.receive(event('disk-2', { kind: 'command', command: 'task' })), LaneClosed);
      await third.g.ingress.receive(event('disk-chat', { kind: 'command', command: 'urgent', text: '대화' }));
      assert.equal(await third.runtime.tick(), true);
      assert.equal(await third.runtime.tickTask(), false);
      assert.equal(third.worker.executes.length, 0);
    } finally { await third.disk.pg.close(); }
  } finally { await rm(dir, { recursive: true, force: true }); }
});
test('재개 대조: 저장소·기준·프로젝트·정책 revision이 바뀌면 띄우지 않고 실패', async () => {
  const variants: [string, (plan: typeof PLAN) => typeof PLAN, string][] = [
    ['base', plan => ({ ...plan, base: 'c'.repeat(40) }), 'task_session_mismatch'],
    ['project', plan => ({ ...plan, project: { ...plan.project, revision: 'r2' } }), 'task_session_mismatch'],
    ['policy', plan => plan, 'task_policy_changed'],
  ];
  for (const [name, change, reason] of variants) {
    await database.pg.exec(RESET);
    f.policy.revision = 'fixture-v1';
    const local = lane(f);
    local.worker.scripts.push(reply.question());
    const job = await newTask(name);
    await local.runtime.tickTask();
    const sid = (await session()).claude_session_id;
    await answer(local.bridge, taskQuestionId(job.id, sid, 1), 'main', `answer-${name}`);
    if (name === 'policy') f.policy.revision = 'fixture-v2';
    const changed = new ClaudeTaskBridge(f.store, f.gate, local.worker, { plan: async () => change(PLAN) }, { monitorMs: 5 });
    await new Runtime(f.store, f.gate, f.worker, f.signer, f.reader, changed, { taskLoop: true }).tickTask();
    assert.equal((await jobs(db()))[0]!.wait_reason, reason, name);
    assert.equal(local.worker.executes.length, 1, name);
  }
  f.policy.revision = 'fixture-v1';
});
test('누적 예산: 재개로 실행 시간·도구 호출이 새로 채워지지 않고, 다 쓰면 띄우지 않는다', async () => {
  setup.worker.scripts.push((request, worker) => { f.advance(1000); f.policy.confirmedAt = f.now(); return reply.question()(request, worker); });
  const job = await newTask();
  await setup.runtime.tickTask();
  const row = await session();
  assert.equal(Number(row.run_used_ms), 1000); assert.equal(row.tool_calls, 1);
  const question = taskQuestionId(job.id, row.claude_session_id, 1);
  await answer(setup.bridge, question, 'main', 'answer-1');
  setup.worker.scripts.push(reply.question('다음'));
  await setup.runtime.tickTask();
  const resume = setup.worker.executes[1]!;
  assert.equal(resume.runBudgetRemainingMs, Number(row.run_budget_ms) - 1000);
  assert.equal(resume.toolCalls, DEFAULTS.maxToolCalls - 1);
  const open = (await db().query<{ id: string }>("SELECT id FROM codex_questions WHERE state='open'")).rows[0]!;
  await answer(setup.bridge, open.id, 'main', 'answer-2');
  await db().query('UPDATE codex_sessions SET run_used_ms=run_budget_ms');
  await setup.runtime.tickTask();
  assert.equal((await jobs(db()))[0]!.wait_reason, 'task_run_budget_exhausted');
  assert.equal(setup.worker.executes.length, 2);
  // 사용량을 모르는 세션은 잇지 않는다.
  await database.pg.exec(RESET);
  const local = lane(f);
  local.worker.scripts.push((request, worker) => ({ ...reply.question()(request, worker), usage: { toolCalls: null, model: null } }));
  const unknown = await newTask('usage');
  await local.runtime.tickTask();
  assert.equal((await session()).tool_calls, null);
  await answer(local.bridge, taskQuestionId(unknown.id, (await session()).claude_session_id, 1), 'main', 'answer-3');
  await local.runtime.tickTask();
  assert.equal((await jobs(db()))[0]!.wait_reason, 'task_tool_usage_unknown');
});
test('/retry는 앞 세대를 지운 뒤에만 새 세대를 시작한다', async () => {
  setup.worker.scripts.push(reply.failed());
  setup.worker.finalizeCleans = false;
  const job = await newTask();
  await setup.runtime.tickTask();
  assert.equal((await jobs(db()))[0]!.wait_reason, 'task_api_error');
  assert.equal((await laneRow(db())).closed_reason, 'cleanup_pending');
  await control(f, 'retry', job.id);
  assert.equal(await setup.runtime.tickTask(), false);
  setup.worker.finalizeCleans = true;
  f.advance(30_000); f.policy.confirmedAt = f.now();
  setup.worker.scripts.push(reply.completed());
  assert.equal(await setup.runtime.tickTask(), true);
  assert.equal(setup.worker.executes[1]!.generation, 2);
  assert.equal(setup.worker.finalizes.at(-1)!.generation, 2);
});
test('종료 신호: dispatch 전이면 되돌리고, 실행 중이면 드레인 뒤 취소해 자동 재실행 없이 failed·확인 못 하면 unknown', async () => {
  const stopSignal = new AbortController();
  const worker = new FakeTaskWorker();
  const bridge = new ClaudeTaskBridge(f.store, f.gate, worker, { plan: async () => PLAN }, { monitorMs: 5, stopWaitMs: 50, drainMs: 5, shutdown: stopSignal.signal });
  const runtime = new Runtime(f.store, f.gate, f.worker, f.signer, f.reader, bridge, { taskLoop: true, shutdown: stopSignal.signal });
  worker.scripts.push(hang);
  await newTask();
  const running = runtime.tickTask();
  await until(() => worker.executes.length === 1);
  stopSignal.abort();
  await running;
  const job = (await jobs(db()))[0]!;
  assert.equal(job.state, 'failed'); assert.equal(job.wait_reason, 'task_shutdown');
  assert.equal(worker.cancels.length, 1);
  assert.equal(await runtime.tickTask(), false);
  await database.pg.exec(RESET);
  const second = new AbortController();
  const lost = new FakeTaskWorker();
  lost.stopped = false;
  lost.scripts.push(hang);
  const secondBridge = new ClaudeTaskBridge(f.store, f.gate, lost, { plan: async () => PLAN }, { monitorMs: 5, stopWaitMs: 50, drainMs: 5, shutdown: second.signal });
  const secondRuntime = new Runtime(f.store, f.gate, f.worker, f.signer, f.reader, secondBridge, { taskLoop: true, shutdown: second.signal });
  await newTask('lost');
  const hung = secondRuntime.tickTask();
  await until(() => lost.executes.length === 1);
  second.abort();
  await hung;
  assert.equal((await jobs(db()))[0]!.state, 'unknown'); assert.equal((await jobs(db()))[0]!.wait_reason, 'publisher_shutdown');
  // 신호 뒤 늦게 돌아온 claim은 작업자에 보내지 않고 대기열로 되돌린다.
  const third = new AbortController();
  const idle = new FakeTaskWorker();
  const thirdRuntime = new Runtime(f.store, f.gate, f.worker, f.signer, f.reader, new ClaudeTaskBridge(f.store, f.gate, idle, { plan: async () => { third.abort(); return PLAN; } },
    { monitorMs: 5, shutdown: third.signal }), { taskLoop: true, shutdown: third.signal });
  await database.pg.exec(RESET);
  await newTask('late-claim');
  await thirdRuntime.tickTask();
  assert.equal((await jobs(db()))[0]!.state, 'queued'); assert.equal((await jobs(db()))[0]!.wait_reason, 'publisher_shutdown');
  assert.equal(idle.executes.length, 0);
});
test('task off(기본): tick 하나가 슬롯 하나로 처리하고 tickTask는 아무것도 하지 않으며 레인 행을 건드리지 않는다', async () => {
  const worker = new FakeTaskWorker();
  const bridge = new ClaudeTaskBridge(f.store, f.gate, worker, { plan: async () => PLAN }, { monitorMs: 5 });
  const single = new Runtime(f.store, f.gate, f.worker, f.signer, f.reader, bridge);
  worker.scripts.push(reply.question());
  await newTask();
  assert.equal(await single.tickTask(), false);
  assert.equal(worker.executes.length, 0);
  assert.equal(await single.tick(), true);
  assert.equal(worker.executes.length, 1);
  // 단일 슬롯에서는 질문 대기도 슬롯을 잡는다.
  await chat('chat-1');
  assert.equal(await f.store.claim(), undefined);
  assert.equal(await single.tick(), false);
  // 작업 레인 없이 조립한 Runtime은 tickTask가 없는 것과 같다.
  assert.equal(await f.runtime.tickTask(), false);
});
test('리뷰 claim: lanes를 켜면 작업 레인에 막히지 않고 interactive만 본다. 끄면 지금처럼 모든 작업에 막힌다', async () => {
  const review = (lanes: boolean) => new ReviewRuntime(f.store, null as never, null as never, null as never, null as never, null as never, 1000, { lanes });
  const job = crypto.randomUUID();
  await db().query(`INSERT INTO events(id,provider,delivery_id,semantic_key,actor_id,scope,received_at,payload,accepted)
    VALUES ($1,'github',$1,$1,'github-review','{}',$2,'{}',true)`, [`e-${job}`, f.now()]);
  await db().query(`INSERT INTO jobs(id,event_id,conversation_id,type,owner_id,target,revision,budget,priority,available_at,created_at)
    VALUES ($1,$2,NULL,'review','github-review','{}','{"policy":"p"}','{"timeoutMs":1,"toolCalls":0}',40,$3,$3)`, [job, `e-${job}`, f.now()]);
  setup.worker.scripts.push(hang);
  const taskJob = await newTask();
  const running = setup.runtime.tickTask();
  await until(() => setup.worker.executes.length === 1);
  assert.equal(await review(false).claim(), undefined);
  await newTask('task-2');
  const claimed = await review(true).claim();
  assert.equal(claimed?.id, job);
  // interactive를 잡은 리뷰가 있으면 대화 claim은 막히고 작업 claim은 자기 레인으로만 판단한다.
  await chat('chat-1');
  assert.equal(await f.store.claim('interactive'), undefined);
  await control(f, 'cancel', taskJob.id);
  await running;
  assert.equal(await review(true).claim(), undefined);
  assert.equal((await f.store.claim('task'))?.type, 'task');
});
test('최종 상태 뒤 늦은 응답: 해제까지 끝난 job에 원래 응답이 도착해도 세션·레인·알림을 되돌리지 않는다', async () => {
  for (const [name, script] of [['unknown', reply.unknown()], ['completed', reply.completed('늦은 결과')], ['question', reply.question()], ['limited', reply.limited()]] as const) {
    await database.pg.exec(RESET);
    const local = await expiredWhileWaiting(f, db(), script);
    assert.equal((await jobs(db()))[0]!.state, 'unknown', name);
    const released = await local.bridge.release('fixture-owner', thread, local.job.id);
    assert.equal(released.ok, true, name);
    const before = await session();
    assert.equal(before.state, 'cancelled', name); assert.equal(before.cleanup_state, 'cleaned', name);
    local.deliver();
    await local.running;
    assert.equal((await jobs(db()))[0]!.state, 'cancelled', name);
    const after = await session();
    assert.equal(after.state, 'cancelled', name); assert.equal(after.cleanup_state, 'cleaned', name); assert.equal(after.session_retained, false, name);
    assert.equal((await laneRow(db())).closed_reason, null, name);
    assert.equal((await rows('results')).length, 0, name); assert.equal((await rows('codex_questions')).length, 0, name);
    assert.ok(!(await outbox()).some(row => row.idempotency_key === `task-blocked:${local.job.id}`), name);
    assert.ok((await rows('audit')).some(row => row.kind === 'task_stale_response'), name);
    assert.ok(!(await rows('controls')).some(row => row.key === 'scheduler' && row.value === true), name);
    await newTask(`next-${name}`);
  }
});
test('최종 상태 뒤 늦은 응답: /retry로 같은 lease가 남은 queued job을 옛 응답이 건드리지 못한다', async () => {
  for (const script of [reply.unknown(), reply.completed('옛 결과')]) {
    await database.pg.exec(RESET);
    const local = lane(f, { monitorMs: 3_600_000 });
    let deliver!: () => void;
    const held = new Promise<void>(resolve => { deliver = resolve; });
    local.worker.scripts.push(async (request, worker) => { await held; return script(request, worker); });
    const job = await newTask();
    const running = local.runtime.tickTask();
    await until(() => local.worker.executes.length === 1);
    // 다른 경로가 실패로 끝내고 /retry한 상태. lease_token은 다음 claim 때까지 그대로다.
    await db().query("UPDATE jobs SET state='failed',wait_reason='fixture',finished_at=$2 WHERE id=$1", [job.id, f.now()]);
    assert.equal((await control(f, 'retry', job.id)).status, '확인된 실패 작업만 재시도합니다.');
    const queued = (await jobs(db()))[0]!;
    assert.equal(queued.state, 'queued'); assert.ok(queued.lease_token);
    deliver();
    await running;
    assert.equal((await jobs(db()))[0]!.state, 'queued');
    assert.equal((await rows('results')).length, 0);
    assert.equal((await session()).state, 'running');
    assert.equal((await laneRow(db())).closed_reason, null);
  }
});
test('최종 상태 뒤 늦은 응답: lease가 끝났지만 아직 해제 전이면 지금처럼 unknown을 유지한다', async () => {
  const local = await expiredWhileWaiting(f, db(), reply.completed('늦은 결과'));
  local.deliver();
  await local.running;
  assert.equal((await jobs(db()))[0]!.state, 'unknown');
  assert.equal((await session()).state, 'unknown');
  assert.equal((await laneRow(db())).closed_reason, 'unknown');
  assert.equal((await rows('results')).length, 0);
  assert.equal((await local.bridge.release('fixture-owner', thread, local.job.id)).ok, true);
  assert.equal((await laneRow(db())).closed_reason, null);
});
test('늦은 정리 실패: 다른 인스턴스가 지운 뒤 도착한 실패가 cleaned를 pending으로 되돌리지 않는다', async () => {
  const local = lane(f, { finalizeRetryMs: 0 });
  const other = new ClaudeTaskBridge(f.store, f.gate, local.worker, { plan: async () => PLAN }, { monitorMs: 5, stopWaitMs: 50, finalizeRetryMs: 0 });
  local.worker.statusFails = true;
  await newTask();
  await local.runtime.tickTask();
  assert.equal((await session()).cleanup_state, 'pending');
  local.worker.statusFails = false;
  local.worker.onControl = async endpoint => {
    if (endpoint !== '/v1/task/status') return;
    local.worker.onControl = undefined;
    await other.sweep();
    assert.equal((await session()).cleanup_state, 'cleaned');
    local.worker.statusFails = true;
  };
  await local.bridge.sweep();
  const row = await session();
  assert.equal(row.cleanup_state, 'cleaned'); assert.equal(row.session_retained, false);
  assert.equal((await laneRow(db())).closed_reason, null);
});
test('대기 세션의 늦은 정리 확인은 그 사이 재개된 턴의 막힘 표시를 건드리지 않는다', async () => {
  const local = lane(f, { finalizeRetryMs: 0, monitorMs: 3_600_000 });
  local.worker.scripts.push(reply.limited('auth_expired', true));
  const job = await newTask();
  await local.runtime.tickTask();
  assert.equal((await session()).cleanup_state, 'pending');
  local.worker.onControl = async endpoint => {
    if (endpoint !== '/v1/task/status') return;
    local.worker.onControl = undefined;
    await db().query("UPDATE codex_sessions SET state='running',turn=turn+1 WHERE job_id=$1", [job.id]);
  };
  await local.bridge.sweep();
  assert.equal((await session()).cleanup_state, 'pending');
});
test('늦은 재개 판단: 상태 확인 사이 lease가 끝나 unknown이 된 job의 세션·질문을 닫지 않는다', async () => {
  const { question } = await asked();
  await answer(setup.bridge, question, 'main', 'answer-1');
  setup.worker.onControl = async endpoint => {
    if (endpoint !== '/v1/task/status') return;
    setup.worker.onControl = undefined;
    f.advance(DEFAULTS.leaseMs + 1); f.policy.confirmedAt = f.now();
    await f.store.expire();
  };
  setup.worker.statusOverride = ABSENT;
  await setup.runtime.tickTask();
  assert.equal((await jobs(db()))[0]!.state, 'unknown');
  assert.equal((await session()).state, 'waiting_answer');
  assert.equal((await rows('codex_questions'))[0]!.state, 'answered');
  assert.equal(setup.worker.executes.length, 1);
});
test('취소·실행 결과 합치기: 실행 응답이 unknown이어도 같은 작업자·세대의 취소가 소멸을 확인하면 그 값을 쓴다', async () => {
  const stopHow: Record<string, () => Promise<unknown>> = {
    cancel: async () => { await control(f, 'cancel', (await jobs(db()))[0]!.id); },
    revoked: async () => { f.policy.owner = 'replacement'; },
  };
  for (const [name, stop] of Object.entries(stopHow)) {
    await database.pg.exec(RESET);
    f.policy.owner = 'fixture-owner';
    const local = lane(f);
    local.worker.scripts.push(answerOnAbort(reply.unknown()));
    const job = await newTask(`merge-${name}`);
    const running = local.runtime.tickTask();
    await until(() => local.worker.executes.length === 1);
    await stop();
    await running;
    const current = (await jobs(db()))[0]!;
    assert.equal(current.state, 'cancelled', name);
    assert.equal(current.wait_reason, name === 'cancel' ? 'stop_confirmation' : 'authorization_revoked', name);
    assert.equal((await session()).state, 'cancelled', name);
    assert.equal(local.worker.cancels.length, 1, name);
    assert.deepEqual((await session()).worker_storage, local.worker.identity.storage, name);
    assert.equal((await laneRow(db())).closed_reason, null, name);
    assert.ok(!(await outbox()).some(row => row.idempotency_key === `task-blocked:${job.id}`), name);
  }
  f.policy.owner = 'fixture-owner';
});
test('취소·실행 결과 합치기: 시간 초과·종료도 소멸 확인이면 failed이고, 취소 응답을 기다린 뒤 판정한다', async () => {
  const slow = lane(f, { stopWaitMs: 5000 });
  let answerCancel!: () => void;
  const held = new Promise<void>(resolve => { answerCancel = resolve; });
  let reached = false;
  slow.worker.onControl = async endpoint => { if (endpoint === '/v1/task/cancel') { reached = true; await held; } };
  slow.worker.scripts.push(answerOnAbort(reply.unknown()));
  const first = await newTask('timeout');
  await db().query(`UPDATE jobs SET budget=jsonb_set(budget,'{timeoutMs}','20') WHERE id=$1`, [first.id]);
  const running = slow.runtime.tickTask();
  await until(() => reached);
  // 실행 응답은 이미 왔다. 취소 응답 전에는 어느 쪽으로도 확정하지 않는다.
  await new Promise(resolve => setTimeout(resolve, 30));
  assert.equal((await jobs(db()))[0]!.state, 'running');
  answerCancel();
  await running;
  assert.equal((await jobs(db()))[0]!.state, 'failed'); assert.equal((await jobs(db()))[0]!.wait_reason, 'task_timeout');
  assert.equal((await session()).state, 'failed');
  await database.pg.exec(RESET);
  const stopSignal = new AbortController();
  const worker = new FakeTaskWorker();
  const bridge = new ClaudeTaskBridge(f.store, f.gate, worker, { plan: async () => PLAN }, { monitorMs: 5, stopWaitMs: 50, drainMs: 5, shutdown: stopSignal.signal });
  const runtime = new Runtime(f.store, f.gate, f.worker, f.signer, f.reader, bridge, { taskLoop: true, shutdown: stopSignal.signal });
  worker.scripts.push(answerOnAbort(reply.unknown()));
  await newTask('shutdown');
  const stopping = runtime.tickTask();
  await until(() => worker.executes.length === 1);
  stopSignal.abort();
  await stopping;
  assert.equal((await jobs(db()))[0]!.state, 'failed'); assert.equal((await jobs(db()))[0]!.wait_reason, 'task_shutdown');
});
test('취소·실행 결과 합치기: 소멸을 못 보거나 다른 작업자·세대의 취소면 unknown을 유지하고, 중단이 없으면 취소를 보내지 않는다', async () => {
  const other = { instance: '00000000-0000-4000-8000-00000000beef', storage: OTHER_STORAGE };
  const cases: [string, (worker: FakeTaskWorker) => void][] = [
    ['not_stopped', worker => { worker.stopped = false; }],
    ['other_worker', worker => { worker.cancelOverride = { worker: other }; }],
    ['other_instance', worker => { worker.cancelOverride = { worker: { ...worker.identity, instance: other.instance } }; }],
    ['other_generation', worker => { worker.cancelOverride = { generation: 7 }; }],
    ['other_session', worker => { worker.cancelOverride = { sessionId: other.instance }; }],
    ['other_lease', worker => { worker.cancelOverride = { lease: other.instance }; }],
    ['other_job', worker => { worker.cancelOverride = { job: other.instance }; }],
    ['broken', worker => { worker.onControl = () => { throw new Error('cancel_down'); }; }],
  ];
  for (const [name, arrange] of cases) {
    await database.pg.exec(RESET);
    const local = lane(f);
    arrange(local.worker);
    local.worker.scripts.push(answerOnAbort(reply.unknown()));
    const job = await newTask(`keep-${name}`);
    const running = local.runtime.tickTask();
    await until(() => local.worker.executes.length === 1);
    await control(f, 'cancel', job.id);
    await running;
    assert.equal((await jobs(db()))[0]!.state, 'unknown', name);
    assert.equal((await session()).state, 'unknown', name);
    assert.equal((await laneRow(db())).closed_reason, 'unknown', name);
  }
  await database.pg.exec(RESET);
  const quiet = lane(f);
  quiet.worker.scripts.push(reply.unknown());
  await newTask('no-stop');
  await quiet.runtime.tickTask();
  assert.equal((await jobs(db()))[0]!.state, 'unknown');
  assert.equal(quiet.worker.cancels.length, 0);
});
test('취소·실행 결과 합치기: 응답을 잃은 경로도 다른 세대의 취소 응답을 소멸 증명으로 쓰지 않는다', async () => {
  const local = lane(f);
  local.worker.cancelOverride = { generation: 7 };
  local.worker.scripts.push(hang);
  const job = await newTask();
  const running = local.runtime.tickTask();
  await until(() => local.worker.executes.length === 1);
  await control(f, 'cancel', job.id);
  await running;
  assert.equal((await jobs(db()))[0]!.state, 'unknown');
});
test('제어 응답 대조: 다른 세대·세션·lease의 status·finalize·해제 cancel은 근거로 쓰지 않는다', async () => {
  const id = '00000000-0000-4000-8000-00000000beef';
  // 재개 전 상태 확인. 어긋난 응답은 끊긴 것과 같아 대기열로 되돌리고 재개하지 않는다.
  const { question } = await asked();
  await answer(setup.bridge, question, 'main', 'a-1');
  setup.worker.statusOverride = { generation: 7 };
  await setup.runtime.tickTask();
  assert.equal(setup.worker.executes.length, 1);
  assert.equal((await jobs(db()))[0]!.wait_reason, 'task_worker_unavailable');
  // 정리: 다른 세션의 finalized·finalize 응답으로 지운 것으로 치지 않는다.
  for (const override of [{ sessionId: id, state: 'finalized' as const, sessionExists: false, stopped: true, turn: null }, { lease: id, state: 'absent' as const, sessionExists: false, stopped: true, turn: null }]) {
    await database.pg.exec(RESET);
    const second = lane(f, { finalizeRetryMs: 0 });
    second.worker.statusOverride = override;
    await newTask('echo');
    await second.runtime.tickTask();
    assert.equal((await session()).session_retained, true);
    assert.equal((await session()).cleanup_state, 'pending');
    assert.equal((await laneRow(db())).closed_reason, 'cleanup_pending');
  }
  await database.pg.exec(RESET);
  const finalizing = lane(f, { finalizeRetryMs: 0 });
  finalizing.worker.finalizeOverride = { generation: 7 };
  await newTask('finalize-echo');
  await finalizing.runtime.tickTask();
  assert.equal((await session()).session_retained, true);
  assert.equal((await session()).cleanup_state, 'pending');
  // 해제: 다른 세대의 cancel 응답으로 풀지 않는다.
  await database.pg.exec(RESET);
  const blocked = lane(f);
  blocked.worker.scripts.push(reply.unknown());
  const unknownJob = await newTask('release-echo');
  await blocked.runtime.tickTask();
  blocked.worker.cancelOverride = { generation: 7 };
  assert.equal((await blocked.bridge.release('fixture-owner', thread, unknownJob.id)).ok, false);
  assert.equal((await jobs(db()))[0]!.state, 'unknown');
});
test('해제 CAS: 소멸 확인 사이 새 lease·세대로 넘어간 작업은 옛 확인으로 풀지 않는다', async () => {
  const local = lane(f);
  local.worker.scripts.push(reply.unknown());
  const job = await newTask();
  await local.runtime.tickTask();
  const lease = '00000000-0000-4000-8000-00000000abcd';
  const sid = '00000000-0000-4000-8000-00000000abce';
  local.worker.onControl = async endpoint => {
    if (endpoint !== '/v1/task/cancel') return;
    local.worker.onControl = undefined;
    await db().query('UPDATE jobs SET lease_token=$2 WHERE id=$1', [job.id, lease]);
    await db().query("UPDATE codex_sessions SET state='running',generation=2,claude_session_id=$2,thread_id=$2,worker_lease=$3 WHERE job_id=$1", [job.id, sid, lease]);
  };
  const released = await local.bridge.release('fixture-owner', thread, job.id);
  assert.equal(released.ok, false);
  assert.equal((await jobs(db()))[0]!.state, 'unknown');
  assert.equal((await session()).state, 'running');
  assert.equal((await session()).claude_session_id, sid);
});
test('executor 구분: Claude 해제는 Codex 세션을 실행 전 작업으로 보지 않고 거부하고, Codex 해제 경로는 소멸 확인 뒤 푼다', async () => {
  const { job } = await codexSession(f, db());
  const denied = await setup.bridge.release('fixture-owner', thread, job.id);
  assert.equal(denied.ok, false);
  assert.equal(setup.worker.cancels.length, 0);
  assert.equal((await jobs(db()))[0]!.state, 'unknown');
  const row = await session();
  assert.equal(row.state, 'unknown'); assert.equal(row.executor, 'codex');
  assert.ok(!(await rows('audit')).some(a => a.kind === 'task_unknown_released'));
  const refused = codexBridge(f, false);
  assert.equal((await refused.bridge.release('fixture-owner', thread, job.id)).ok, false);
  assert.equal(refused.confirms.length, 1);
  assert.equal((await jobs(db()))[0]!.state, 'unknown');
  const codex = codexBridge(f);
  assert.equal((await codex.bridge.release('fixture-owner', thread, job.id)).ok, true);
  assert.deepEqual(codex.confirms, [job.id]);
  assert.equal((await jobs(db()))[0]!.state, 'cancelled');
});
test('executor 구분: 세션 상태가 unknown이 아니어도, 질문이 있어도 Codex 세션은 건드리지 않는다', async () => {
  const { job } = await codexSession(f, db(), 'waiting_answer');
  await db().query(`INSERT INTO codex_questions(id,job_id,conversation_id,thread_id,turn,kind,responder_id,prompt,state,created_at,expires_at)
    VALUES ('codex-q',$1,$2,'codex-thread',1,'clarification','fixture-owner','질문','open',$3,$4)`, [job.id, conversationId(f), f.now(), f.now() + 60_000]);
  assert.equal((await setup.bridge.release('fixture-owner', thread, job.id)).ok, false);
  assert.equal((await session()).state, 'waiting_answer');
  assert.equal((await rows('codex_questions'))[0]!.state, 'open');
});
test('executor 구분: Codex 해제 경로는 Claude 세션을 풀지 않는다', async () => {
  const local = lane(f);
  local.worker.scripts.push(reply.unknown());
  const job = await newTask();
  await local.runtime.tickTask();
  const codex = codexBridge(f);
  assert.equal((await codex.bridge.release('fixture-owner', thread, job.id)).ok, false);
  assert.equal(codex.confirms.length, 0);
  assert.equal((await jobs(db()))[0]!.state, 'unknown');
  assert.equal((await session()).state, 'unknown');
});
test('executor 구분: 다른 실행기 세션의 재시도를 덮어쓰지 않고 실패로 끝낸다', async () => {
  const { job } = await codexSession(f, db(), 'failed', 'failed');
  await db().query('UPDATE jobs SET lease_token=NULL,lease_until=NULL WHERE id=$1', [job.id]);
  await control(f, 'retry', job.id);
  await setup.runtime.tickTask();
  assert.equal(setup.worker.executes.length, 0);
  assert.equal((await jobs(db()))[0]!.state, 'failed'); assert.equal((await jobs(db()))[0]!.wait_reason, 'task_session_mismatch');
  const row = await session();
  assert.equal(row.executor, 'codex'); assert.equal(row.thread_id, 'codex-thread'); assert.equal(row.claude_session_id, null);
  // Codex 경로도 Claude 세션을 잇지 않는다. 보존 기록을 덮지 않는다.
  await database.pg.exec(RESET);
  const local = lane(f);
  local.worker.statusFails = true;
  const failed = await newTask('claude-retained');
  local.worker.scripts.push(reply.failed());
  await local.runtime.tickTask();
  const before = await session();
  assert.equal(before.session_retained, true);
  const codex = codexBridge(f);
  await control(f, 'retry', failed.id);
  // 작업 루프를 끈 Codex 배치는 레인 닫힘을 보지 않고 슬롯 하나로 집는다.
  const claimed = (await f.store.claim())!;
  await codex.bridge.run(claimed);
  assert.equal((await jobs(db()))[0]!.state, 'failed'); assert.equal((await jobs(db()))[0]!.wait_reason, 'task_session_mismatch');
  const after = await session();
  assert.equal(after.executor, 'claude'); assert.equal(after.claude_session_id, before.claude_session_id); assert.equal(after.session_retained, true);
});
test('executor 구분: unknown 안내는 자기 실행기 작업에만 넣고, 다른 실행기의 질문에는 답을 받지 않는다', async () => {
  const { job } = await codexSession(f, db());
  await setup.bridge.sweep();
  assert.ok(!(await outbox()).some(row => row.idempotency_key === `task-blocked:${job.id}`));
  assert.equal((await laneRow(db())).closed_reason, null);
  const codex = codexBridge(f);
  await codex.bridge.sweep();
  assert.ok((await outbox()).some(row => row.idempotency_key === `codex-blocked:${job.id}`));
  await database.pg.exec(RESET);
  const waiting = await codexSession(f, db(), 'waiting_answer', 'waiting_user');
  await db().query(`UPDATE jobs SET wait_reason='clarification' WHERE id=$1`, [waiting.job.id]);
  await db().query(`INSERT INTO codex_questions(id,job_id,conversation_id,thread_id,turn,kind,responder_id,prompt,state,created_at,expires_at)
    VALUES ('codex-q',$1,$2,'codex-thread',1,'clarification','fixture-owner','질문','open',$3,$4)`, [waiting.job.id, conversationId(f), f.now(), f.now() + 60_000]);
  assert.equal((await answer(setup.bridge, 'codex-q', 'main', 'foreign-1')).ok, false);
  assert.equal((await rows('codex_questions'))[0]!.state, 'open');
  assert.equal((await jobs(db()))[0]!.state, 'waiting_user');
  assert.equal((await codexBridge(f).bridge.answer({ question: 'codex-q', actor: 'fixture-owner', scope: thread, text: 'main', event: 'own-1' })).ok, true);
  await database.pg.exec(RESET);
  const { question } = await asked();
  assert.equal((await codexBridge(f).bridge.answer({ question, actor: 'fixture-owner', scope: thread, text: 'main', event: 'foreign-2' })).ok, false);
  assert.equal((await rows('codex_questions'))[0]!.state, 'open');
});
test('잠금 순서: 세션·질문을 쓰는 경로가 대화 행 → scheduler 행 → 레인 행 순서를 지킨다', async () => {
  const sequence: string[][] = [];
  const kind = (sql: string) => /FROM conversations\b[\s\S]*FOR UPDATE/.test(sql) ? 'conversation'
    : /FROM controls WHERE key='scheduler' FOR UPDATE/.test(sql) ? 'scheduler'
      : /FROM execution_lanes[\s\S]*FOR UPDATE/.test(sql) ? 'lane'
        : /^\s*(SELECT[\s\S]*FROM jobs[\s\S]*FOR UPDATE|UPDATE jobs|UPDATE codex_sessions|UPDATE codex_questions|INSERT INTO codex_questions|INSERT INTO outbox)/.test(sql) ? 'row' : undefined;
  const recorded: Database = { query: (sql, params) => db().query(sql, params), transaction: (fn, deadline) => db().transaction(tx => {
    const log: string[] = [];
    sequence.push(log);
    return fn({ query: (sql, params) => { const k = kind(sql); if (k) log.push(k); return tx.query(sql, params); }, transaction: inner => tx.transaction(inner) });
  }, deadline) };
  const local = new Store(recorded, f.now);
  const worker = new FakeTaskWorker();
  const bridge = new ClaudeTaskBridge(local, f.gate, worker, { plan: async () => PLAN }, { monitorMs: 5 });
  const runtime = new Runtime(local, f.gate, f.worker, f.signer, f.reader, bridge, { taskLoop: true });
  worker.scripts.push(reply.question());
  const job = await newTask();
  await runtime.tickTask();
  const sid = (await session()).claude_session_id;
  await bridge.answer({ question: taskQuestionId(job.id, sid, 1), actor: 'fixture-owner', scope: thread, text: 'main', event: 'e-1' });
  worker.scripts.push(reply.limited('limited'));
  await runtime.tickTask();
  await local.control('fixture-owner', conversationId(f), 'cancel', job.id);
  await runtime.tickTask();
  const order = ['conversation', 'scheduler', 'lane', 'row'];
  const checked = sequence.filter(log => log.includes('row') && (log.includes('scheduler') || log.includes('lane')));
  assert.ok(checked.length >= 3, String(checked.length));
  for (const log of checked) {
    const first = order.map(name => log.indexOf(name)).filter(index => index >= 0);
    assert.deepEqual(first, [...first].sort((a, b) => a - b), log.join(','));
  }
});
