import { after, before, beforeEach, test } from 'node:test';
import assert from 'node:assert/strict';
import { CHAT_TASK_TEXT } from '../src/chat-task-text.js';
import { MethodRouter, installMethods } from '../src/method-routing.js';
import { recordAccount, switchAccount } from '../src/model-accounts.js';
import type { TaskRequest, TaskResponse, TaskWorkerIdentity } from '../src/task-contracts.js';
import { localDatabase, fixture } from './helpers.js';
import { allRows, jobs, lane, reply, task } from './task-lane-fixture.js';
import type { Fixture, Script } from './task-lane-fixture.js';

// C40 한도 뒤 API 사용의 작업 레인(AC-38, C39 넘김). 경계 S1: 수신 → 저장(PGlite) → 작업 레인 runtime → 가짜 작업자(계약 스키마로 요청 검사).
let database: Awaited<ReturnType<typeof localDatabase>>;
let f: Fixture;
before(async () => { database = await localDatabase(); });
beforeEach(async () => {
  await database.pg.exec(`TRUNCATE events,conversations,jobs,results,outbox,schedules,denied_actors,controls,audit,incidents,codex_sessions,codex_questions,
    model_limit_state,model_pauses,model_accounts,method_routing,method_runs RESTART IDENTITY CASCADE;
    UPDATE execution_lanes SET closed_reason=NULL,closed_at=NULL;`);
  f = await fixture(database.db);
});
after(async () => { await database.pg.close(); });

async function autoLane() {
  await recordAccount(database.db, 'main', 'subscription', f.now());
  await recordAccount(database.db, 'main', 'api', f.now());
  await f.store.atomic(s => switchAccount(s, 'main', 'subscription', 'cli', 'cli'));
  await f.store.atomic(s => installMethods(s, 'main', 'rev-1'));
  const local = lane(f);
  local.bridge.useMethods(new MethodRouter(f.store, { enabled: true, supported: () => true }));
  return local;
}
// 작업자 응답에 그 요청 선택의 실행 칸을 붙인다(작업자는 요청 선택으로만 돈다).
const selected = (script: (r: TaskRequest, w: TaskWorkerIdentity) => TaskResponse, subscriptionLimit = false, overrides: Partial<TaskResponse> = {}): Script =>
  (r, w) => ({ ...script(r, w), ...(r.execution ? { execution: { ...r.execution, subscriptionLimit } } : {}), ...overrides });
const resetsAt = () => Math.floor((f.now() + 3_600_000) / 1000);
const subscriptionLimited = (retained = true): Script => (r, w) => selected(reply.limited(), true,
  { rateLimit: { stop: { cause: 'rate_limit', resetsAt: resetsAt() } }, sessionRetained: retained } as Partial<TaskResponse>)(r, w);

test('AC-38 작업 레인의 구독 한도 뒤 같은 작업 공간·세션의 다음 턴이 API --resume으로 이어지고 예산은 새로 채워지지 않는다', async () => {
  const local = await autoLane();
  await task(f, database.db);
  local.worker.scripts = [subscriptionLimited(), selected(reply.completed())];
  await local.runtime.tickTask();
  // 같은 작업이 대기열로 돌아갔고 작업 레인·전역 scheduler 모두 열려 있다.
  assert.equal((await jobs(database.db))[0]!.state, 'queued');
  assert.equal((await allRows(database.db, 'codex_sessions'))[0]!.state, 'waiting_model');
  await local.runtime.tickTask();
  assert.equal((await jobs(database.db))[0]!.state, 'succeeded');
  const [first, second] = local.worker.executes;
  assert.deepEqual([first!.operation, first!.execution?.method], ['start', 'subscription']);
  assert.deepEqual([second!.operation, second!.execution?.method, second!.turn], ['resume', 'api', 2]);
  assert.equal(second!.sessionId, first!.sessionId);
  assert.equal(second!.generation, first!.generation);
  assert.equal(second!.operation === 'resume' && second!.resumeReason, 'model_limit');
  assert.deepEqual([second!.execution!.account, second!.execution!.credentialRevision], ['main', 'rev-1']);
  // 앞 턴이 쓴 도구 1개가 빠진 채로 이어진다(합산).
  assert.equal(second!.toolCalls, first!.toolCalls - 1);
  assert.ok(second!.runBudgetRemainingMs <= first!.runBudgetRemainingMs);
  // 진행 없던 한도 턴은 턴 예산에서 빠진다.
  assert.equal(Number((await allRows(database.db, 'codex_sessions'))[0]!.model_wait_turns), 1);
});

test('AC-38 세션이 남지 않은 첫 턴의 구독 한도는 API로 새로 시작하지 않고 작업을 보존한 채 지금처럼 기다리며, 대화 쪽 scheduler는 닫지 않는다', async () => {
  const local = await autoLane();
  await task(f, database.db);
  local.worker.scripts = [subscriptionLimited(false)];
  await local.runtime.tickTask();
  assert.equal((await jobs(database.db))[0]!.state, 'waiting_user');
  assert.equal(local.worker.executes.length, 1);
  assert.equal(await local.runtime.tickTask(), false);
  assert.equal(local.worker.executes.length, 1);
  // 자리 비움 안내가 남는다(지금 규칙). 다른 경로는 API로 갈 수 있어 전역 scheduler는 열려 있다.
  assert.equal((await allRows(database.db, 'outbox')).filter(row => row.payload.content === CHAT_TASK_TEXT.away).length, 1);
  assert.notEqual((await allRows(database.db, 'controls')).find(row => row.key === 'scheduler')?.value, true);
  assert.deepEqual((await allRows(database.db, 'method_routing')).map(row => row.subscription_state), ['limited']);
});

test('C39 넘김: 작업 턴의 실행 안 됨(not_run)은 첫 턴이면 새 세대로, 재개 턴이면 다음 턴 번호로 선택 없이 다시 보낸다', async () => {
  const notRun = (retained: boolean): Script => (r, w) => ({ version: 1, job: r.job, lease: r.lease, generation: r.generation, sessionId: r.sessionId, turn: r.turn,
    worker: w, usage: { toolCalls: 0, model: null }, status: 'not_run', stopped: true, sessionRetained: retained, cleanupPending: false, refusal: 'bundle_mismatch' });
  let local = await autoLane();
  await task(f, database.db);
  local.worker.scripts = [notRun(false), reply.completed()];
  await local.runtime.tickTask();
  assert.equal((await jobs(database.db))[0]!.state, 'queued');
  await local.runtime.tickTask();
  assert.equal((await jobs(database.db))[0]!.state, 'succeeded');
  const [refused, fresh] = local.worker.executes;
  assert.deepEqual([refused!.operation, refused!.generation, !!refused!.execution], ['start', 1, true]);
  assert.deepEqual([fresh!.operation, fresh!.generation, !!fresh!.execution], ['start', 2, false]);

  await database.pg.exec(`TRUNCATE events,conversations,jobs,outbox,codex_sessions,codex_questions,method_routing,method_runs,model_accounts RESTART IDENTITY CASCADE`);
  f = await fixture(database.db);
  local = await autoLane();
  await task(f, database.db, 'resumed');
  local.worker.scripts = [subscriptionLimited(), notRun(true), reply.completed()];
  for (let round = 0; round < 3; round++) await local.runtime.tickTask();
  assert.equal((await jobs(database.db))[0]!.state, 'succeeded');
  assert.deepEqual(local.worker.executes.map(request => [request.operation, request.turn, request.execution?.method ?? null]),
    [['start', 1, 'subscription'], ['resume', 2, 'api'], ['resume', 3, null]]);
});

test('AC-37 작업 결과의 실행 칸이 보낸 선택과 다르면 결과를 믿지 않고 응답 유실로 다룬다(멈춤 확인 뒤 실패, 결과 없음)', async () => {
  const local = await autoLane();
  await task(f, database.db);
  local.worker.scripts = [(r, w) => ({ ...reply.completed()(r, w), execution: { ...r.execution!, method: 'api', subscriptionLimit: false } })];
  await local.runtime.tickTask();
  const [row] = await jobs(database.db);
  assert.deepEqual([row!.state, row!.wait_reason], ['failed', 'task_worker_lost']);
  assert.equal((await allRows(database.db, 'results')).length, 0);
});
