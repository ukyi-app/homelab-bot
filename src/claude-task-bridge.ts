import { createHash, randomUUID } from 'node:crypto';
import { decodeArtifact } from './change-artifact.js';
import { labelAllowsAuthorInput } from './change-contracts.js';
import type { AuthorResult, ChangeArtifactPort, ChangeAuthorPort, ChangeBrief, ChangeKey, ProvenanceLabel } from './change-contracts.js';
import type { ChangeVerificationControl, ChangeVerificationWorker } from './change-verifier.js';
import { Denied, PolicyUnavailable, DEFAULTS } from './contracts.js';
import type { Job, Scope } from './contracts.js';
import { bounded } from './format.js';
import { errorInfo, jsonLog } from './log.js';
import type { Log } from './log.js';
import type { Policy, PolicyGate } from './policy.js';
import { DRAIN_MS } from './runtime.js';
import type { TaskLane } from './runtime.js';
import type { Store } from './store.js';
import { FOREIGN_SESSION_STATUS, TaskBridge, TaskWorkerBusy, TaskWorkerRejected } from './task-bridge.js';
import { taskOutputRisk } from './task-output.js';
import type { TaskOutputRisk } from './task-output.js';
import type { TaskStatus, TaskWorkerPort } from './task-bridge.js';
import type { TaskV2WorkerPort } from './task-http.js';
import { TASK_ENDPOINTS, TASK_INSTRUCTIONS_REVISION, TASK_LIMITS, TASK_RETENTION, TASK_V2_CONTRACT, TASK_V2_ENDPOINTS, TASK_V2_REQUEST_CHARS, taskQuestionId } from './task-contracts.js';
import type { BaselineLeaf, TaskCancelResponse, TaskRequest, TaskResponse, TaskStatusResponse, TaskV2Request, TaskV2TurnResult, TaskV2VerificationResponse, TaskWorkerIdentity } from './task-contracts.js';

// 작업 레인(Claude)의 게시 서버 쪽 턴 조율. 한 run이 /v1/task 한 번, 곧 한 턴이다. 작업자 호출은 TaskWorkerPort로만 한다.
// 결과는 프로세스 소멸 확인을 전제로만 확정하고, 확인을 못 하면 unknown으로 두어 작업 레인의 새 접수를 닫는다.

// 저장소·기준 커밋·프로젝트 정책은 owner의 요청과 현재 정책으로 호출자가 정한다. 재개 때 세션의 고정값과 대조한다.
export interface TaskPlan { repository: string; base: string; project: TaskRequest['project']; limits: TaskRequest['limits'] }
export interface TaskPlanSource { plan(job: Job, policy: Policy, request: string): Promise<TaskPlan> }

// 작업 레인 능력. 값이 불명확하면 지원한다고 적지 않는다. 사람이 연 세션 연결(R08)은 별도 경로이고 이 표에 넣지 않는다.
export const CLAUDE_TASK_LANE_CAPABILITIES = Object.freeze({
  adapter: 'claude-print',
  start_task: true,
  // 모델이 턴을 끝내며 묻는 clarification뿐이다. 답으로 도구를 승인하거나 권한을 바꿀 수 없다.
  answer_question: 'clarification_only',
  request_cancel: true,
  read_status: true,
  read_final_result: true,
  // 작업 전용 파드의 PID 공간 전체를 기준 상태로 되돌린 것을 확인한다(task-containment).
  confirm_stop: 'pod_pid_space',
  resume_task: 'same_job_session_only',
  tool_approval_relay: false,
  attach_task: false,
  // 턴 중간 진행 이벤트를 게시 서버로 보내지 않는다. 계약에 끝점이 없다.
  read_events: false,
} as const);

export interface ClaudeTaskBridgeOptions {
  monitorMs: number; questionTtlMs: number; answerChars: number; stopWaitMs: number;
  // 정리 실패(cleanup_pending) 재시도 간격. 매 tick 작업자를 부르지 않게 한다.
  finalizeRetryMs: number;
  drainMs: number; shutdown?: AbortSignal;
  // job·상태·사유 상수만 남긴다. 사용자 요청·모델 출력·파일 내용·토큰은 넘기지 않는다.
  log: Log;
}
export const CLAUDE_TASK_DEFAULTS: Readonly<ClaudeTaskBridgeOptions> = Object.freeze({ monitorMs: 1000, questionTtlMs: TASK_RETENTION.questionTtlMs,
  answerChars: 2000, stopWaitMs: 15_000, finalizeRetryMs: 30_000, drainMs: DRAIN_MS, log: jsonLog });

interface SessionRow {
  job_id: string; thread_id: string | null; executor: 'codex' | 'claude'; claude_session_id: string | null; generation: number | null;
  turn: number; tool_calls: number | null; worker_lease: string | null; worker_instance: string | null; worker_storage: string | null;
  repository: string | null; base_sha: string | null; policy_revision: string | null; project_id: string | null; project_revision: string | null;
  run_budget_ms: string | number | null; run_used_ms: string | number; session_retained: boolean; cleanup_state: 'none' | 'pending' | 'cleaned';
  state: string; updated_at: string | number; wait_reason: 'model_limit' | 'auth_expired' | null;
  waiting_since: string | number | null; owner_confirm_requested_at: string | number | null;
  capabilities?: unknown;
  // 턴을 시작할 때만 함께 읽는다. 답했지만 아직 이어 가지 않은 질문이다.
  question_id?: string | null; question_answer?: string | null;
}
const parseCapabilities = (session: Pick<SessionRow, 'capabilities'>) =>
  (typeof session.capabilities === 'string' ? JSON.parse(session.capabilities) : session.capabilities) as { version?: number; artifactDigest?: string } | null | undefined;
type Stop = 'cancel' | 'revoked' | 'lease' | 'timeout' | 'shutdown' | 'monitor';
// 턴의 결말. rejected는 시작하지 않았다는 증거, lost는 응답을 못 받아 시작 여부를 모르는 경우다.
// question_blocked는 CHANGE 질문이 공개 검사에 걸린 턴이다. 질문 행과 게시 큐를 지나지 않게 응답을 싣지 않는다.
type Turn = { kind: 'response'; response: TaskResponse } | { kind: 'rejected' } | { kind: 'lost' } | { kind: 'question_blocked' };
type CancelFacts = Pick<TaskCancelResponse, 'stopped' | 'cleanupPending' | 'sessionRetained' | 'worker'>;
// job의 끝 기록. 값은 전이를 시도한 트랜잭션에서 읽은 jobs.state·wait_reason이다. 커밋된 뒤에 로그로 남긴다.
// intended가 있으면 그 전이가 일어나지 않은 것이고, state·reason은 남아 있는 DB 값이다(DB를 읽지 못했으면 null).
type JobEnd = { intended?: undefined; state: string; reason: string | null } | { intended: string; state: string | null; reason: string | null };
// terminal은 세션 공간을 지울 차례인지다.
interface Settled { terminal: boolean; end?: JobEnd }
interface Facts { stopped: boolean; retained: boolean | null; cleanupPending: boolean; worker: TaskWorkerIdentity | null; tools: number | null }
// 끝난 세션을 다시 읽어도 같은 코드가 나와야 부모가 같은 판정으로 닫힌다. 그래서 job의 사유와 fetchResult가 이 값을 함께 쓴다.
const CHANGE_QUESTION_BLOCKED = 'task_question_sensitive';
const TEXT = Object.freeze({
  executor: 'claude' as const, prefix: 'task', question: '작업 질문', accepted: '답을 받았습니다. 같은 세션을 이어서 실행합니다.',
  blocked: (job: string) => `작업 ${job}의 프로세스 종료를 확인하지 못했습니다(unknown). 다시 실행하지 않고 작업 레인의 새 접수를 닫았습니다. 대화·리뷰는 계속 동작합니다. 작업자 프로세스 0개를 확인한 뒤 /task-release target:${job} 로 해제하세요.`,
});
const digest = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const sameWorker = (expected: TaskWorkerIdentity | null, actual: TaskWorkerIdentity) => !expected
  || (actual.instance === expected.instance && actual.storage === expected.storage);
// 세션의 저장소는 한 번 알면 세대가 끝날 때까지 바뀌지 않는다. 다른 저장소의 답을 적으면 그 저장소의 absent가 옛 세션의 소멸 증명으로 둔갑한다.
// 같은 저장소면 파드 교체만 따라간다. 인자는 text로 캐스팅할 SQL 자리표시자다.
const bindWorker = (instance: string, storage: string) => `worker_instance=CASE WHEN worker_storage IS NULL OR worker_storage=${storage}::text
  THEN COALESCE(${instance}::text,worker_instance) ELSE worker_instance END,worker_storage=COALESCE(worker_storage,${storage}::text)`;
interface ControlTarget { job: string; lease: string; generation: number; sessionId: string }
// 제어 응답은 물어본 job·lease·세대·세션의 것일 때만 근거가 된다. 다른 세대의 stopped·finalized를 받으면 이 세대의 소멸 증명으로 둔갑한다.
const echoed = <T extends ControlTarget>(asked: ControlTarget, response: T): T => {
  if (response.job !== asked.job || response.lease !== asked.lease || response.generation !== asked.generation || response.sessionId !== asked.sessionId) throw new Error('task_control_mismatch');
  return response;
};
// 실행이 끝났을 수 있는 job. release는 lease를 바꾸지 않고 /retry도 다음 claim까지 같은 lease를 남겨 lease만으로는 늦은 응답을 가려내지 못한다.
const HELD = new Set(['running', 'verifying', 'cancel_requested']);
const SETTLEABLE = new Set([...HELD, 'unknown']);
const sameSession = (a: SessionRow | undefined, b: SessionRow | undefined) => a?.executor === b?.executor && a?.generation === b?.generation
  && a?.claude_session_id === b?.claude_session_id && a?.worker_lease === b?.worker_lease;

export class ClaudeTaskBridge extends TaskBridge implements TaskLane {
  private readonly options: ClaudeTaskBridgeOptions;
  // 정리 재시도 시각. 잃어도 다음 sweep이 바로 다시 시도할 뿐이라 메모리에 둔다.
  private readonly nextFinalize = new Map<string, number>();
  constructor(store: Store, gate: PolicyGate, private readonly worker: TaskWorkerPort, private readonly plans: TaskPlanSource,
    options: Partial<ClaudeTaskBridgeOptions> = {}, private readonly change?: TaskV2WorkerPort) {
    const merged = { ...CLAUDE_TASK_DEFAULTS, ...options };
    super(store, gate, TEXT, merged);
    this.options = merged;
  }
  // dispatch 전 오류는 던진다(Runtime이 분류한다). dispatch 뒤의 오류는 스스로 상태로 기록하고 던지지 않는다.
  async run(job: Job): Promise<void> {
    if (job.type !== 'task') throw new Denied();
    // 계획 조회가 lease보다 길어질 수 있어 dispatch 전에도 lease를 늘린다.
    const keepalive = setInterval(() => { void this.store.heartbeat(job).catch(() => {}); }, this.options.monitorMs);
    let request: TaskRequest | undefined;
    let session: SessionRow | undefined;
    let revision = job.revision.policy;
    try {
      const policy = await this.gate.authorize(job.owner_id, job.target);
      revision = policy.revision;
      const current = (await this.store.db.query<{ state: string; lease_token: string; lease_until: string }>(
        'SELECT state,lease_token,lease_until FROM jobs WHERE id=$1', [job.id])).rows[0];
      if (!current || current.lease_token !== job.lease_token || Number(current.lease_until) <= this.store.now()) return;
      // 세션과 답한 질문을 한 문장으로 읽는다. 따로 읽으면 다른 실행의 턴 시작이 그 사이에 끼어 "답 없는 대기"로 보인다.
      session = (await this.store.db.query<SessionRow>(`SELECT s.*,q.id AS question_id,q.answer AS question_answer FROM codex_sessions s
        LEFT JOIN codex_questions q ON q.job_id=s.job_id AND q.thread_id=s.claude_session_id AND q.state='answered' WHERE s.job_id=$1`, [job.id])).rows[0];
      // 이 job의 턴이 이미 돌고 있다. 끝을 그 실행이 확정하므로 여기서는 어떤 행도 바꾸지 않는다. 주인이 없으면 lease 만료가 unknown으로 둔다.
      if (session?.state === 'running') return;
      if (current.state === 'cancel_requested') { await this.store.transition(job, 'cancelled', 'cancel_before_dispatch'); return; }
      if (current.state !== 'running') return;
      request = await this.prepare(job, policy, session);
      if (!request) return;
      // 답 수락 뒤 dispatch 전 철회를 여기서 막는다. Denied는 Runtime이 cancelled로 끝내고 sweep이 세션을 닫는다.
      await this.gate.authorize(job.owner_id, job.target);
      if (this.options.shutdown?.aborted) { await this.unchanged(job, session, store => store.defer(job, 'publisher_shutdown')); return; }
      const begun = await this.begin(job, request, session);
      if (begun !== 'started') return;
    } catch (error) {
      // dispatch 전 오류의 끝은 Runtime이 정한다. 여기서는 그 원인만 남긴다.
      this.options.log('task_job_prepare_error', { job: job.id, ...errorInfo(error) });
      throw error;
    } finally { clearInterval(keepalive); }
    await this.dispatch(job, request, revision);
  }
  // task_job_finished는 이 실행이 job을 그 상태로 커밋했다는 뜻이다. 전이가 막히면 다른 이벤트로 남겨 "끝났다"로 읽히지 않게 한다.
  private report(job: string, end: JobEnd): void {
    if (end.intended) this.options.log('task_settle_transition_skipped', { job, intended: end.intended, actual_state: end.state, actual_reason: end.reason });
    else this.options.log('task_job_finished', { job, state: end.state, reason: end.reason });
  }
  private async endOf(store: Store, job: string, intended?: string): Promise<JobEnd> {
    const { state, wait_reason: reason } = (await store.db.query<{ state: string; wait_reason: string | null }>('SELECT state,wait_reason FROM jobs WHERE id=$1', [job])).rows[0]!;
    return intended ? { intended, state, reason } : { state, reason };
  }
  // 이 실행이 아직 job을 쥐고 있고 읽어 둔 세션 상태가 그대로일 때만 job을 정리한다. 그 사이 lease가 끝났거나 다른 실행이 턴을 시작했으면 어떤 행도 건드리지 않는다.
  // act가 돌았으면 그 결과를, 아니면 undefined를 돌려준다.
  private async unchanged<T>(job: Job, session: SessionRow | undefined, act: (store: Store) => Promise<T>): Promise<T | undefined> {
    return this.store.atomic(async store => {
      await store.db.query('SELECT id FROM conversations WHERE id=$1 FOR UPDATE', [job.conversation_id]);
      const held = (await store.db.query<{ state: string; lease_token: string; lease_until: string }>(
        'SELECT state,lease_token,lease_until FROM jobs WHERE id=$1 FOR UPDATE', [job.id])).rows[0];
      if (!held || held.lease_token !== job.lease_token || Number(held.lease_until) <= store.now() || !HELD.has(held.state)) return undefined;
      const now = (await store.db.query<{ state: string; turn: number }>('SELECT state,turn FROM codex_sessions WHERE job_id=$1 FOR UPDATE', [job.id])).rows[0];
      if (session ? now?.state !== session.state || now.turn !== session.turn : !!now) return undefined;
      return act(store);
    });
  }
  // act는 job을 끝냈으면 참을 돌려준다. 그 사이의 /cancel로 failed가 아니라 cancelled가 될 수 있고 lease가 끝나 막힐 수도 있어, 끝은 DB 값으로 적는다.
  private async giveUp(job: Job, session: SessionRow | undefined, reason: string,
    act: (store: Store) => Promise<unknown> = store => this.abandon(job, reason, store)): Promise<void> {
    const end = await this.unchanged(job, session, async store => this.endOf(store, job.id, await act(store) ? undefined : 'failed'));
    if (end) this.report(job.id, end);
  }
  // 이번 턴의 요청을 만든다. 띄우지 않기로 했으면 job을 정리하고 undefined.
  private async prepare(job: Job, policy: Policy, session: SessionRow | undefined): Promise<TaskRequest | undefined> {
    // 다른 실행기의 세션은 잇지도 덮지도 않는다. 행은 그 실행기의 경로가 닫게 둔다.
    if (session && session.executor !== 'claude') {
      await this.giveUp(job, session, 'task_session_mismatch', store => store.fail(job, 'task_session_mismatch'));
      return;
    }
    // CHANGE 작성 세션을 v1로 이으면 artifact 없는 "완료"가 된다. 그 job은 ClaudeChangeAuthor로만 잇는다.
    if (session && parseCapabilities(session)?.version === TASK_V2_CONTRACT) {
      await this.giveUp(job, session, 'task_session_mismatch');
      return;
    }
    const event = (await this.store.db.query<{ payload: { text: string } }>('SELECT payload FROM events WHERE id=$1', [job.event_id])).rows[0]!;
    const plan = await this.plans.plan(job, policy, event.payload.text);
    const waiting = session?.state === 'waiting_answer' || session?.state === 'waiting_model';
    if (!waiting) {
      // 앞 세대가 아직 지워지지 않았으면 새 세대를 시작하지 않는다. 보존 칸을 넘기고 옛 공간의 흔적을 잃는다. sweep이 지우면 다시 집힌다.
      if (session && (session.session_retained || session.cleanup_state === 'pending')) {
        await this.unchanged(job, session, store => store.defer(job, 'task_finalize_pending'));
        return;
      }
      return this.requestFor(job, policy, plan, session, null, event.payload.text);
    }
    const claude = session as SessionRow;
    if (claude.repository !== plan.repository || claude.base_sha !== plan.base || claude.project_id !== plan.project.id
      || claude.project_revision !== plan.project.revision || !claude.claude_session_id || !claude.generation) { await this.giveUp(job, claude, 'task_session_mismatch'); return; }
    if (claude.policy_revision !== policy.revision) { await this.giveUp(job, claude, 'task_policy_changed'); return; }
    if (claude.state === 'waiting_answer' && !claude.question_id) { await this.giveUp(job, claude, 'task_session_mismatch'); return; }
    if (claude.state === 'waiting_model' && !claude.wait_reason) { await this.giveUp(job, claude, 'task_session_mismatch'); return; }
    if (claude.tool_calls === null) { await this.giveUp(job, claude, 'task_tool_usage_unknown'); return; }
    // 재개 전에 세션 공간과 이전 턴 소멸을 작업자에게 확인한다. 파드만 바뀌었으면(같은 저장소) 그 identity로 잇는다.
    let status;
    try {
      status = await this.statusOf(job.id, claude);
    } catch (error) {
      if (error instanceof TaskWorkerRejected) { await this.giveUp(job, claude, 'task_session_mismatch'); return; }
      await this.unchanged(job, claude, store => store.defer(job, 'task_worker_unavailable'));
      return;
    }
    if (status.worker.storage !== claude.worker_storage || status.state !== 'waiting' || !status.sessionExists || !status.stopped
      || (status.turn !== null && status.turn !== claude.turn)) {
      await this.giveUp(job, claude, 'task_session_missing');
      return;
    }
    return this.requestFor(job, policy, plan, claude, status.worker, event.payload.text);
  }
  // worker가 있으면 그 세션을 잇는 재개, 없으면 새 세대의 시작이다.
  private async requestFor(job: Job, policy: Policy, plan: TaskPlan, session: SessionRow | undefined, worker: TaskWorkerIdentity | null,
    text: string): Promise<TaskRequest | undefined> {
    const prior = worker ? session : undefined;
    const turn = prior ? prior.turn + 1 : 1;
    if (turn > TASK_LIMITS.turns) { await this.giveUp(job, session, 'task_turn_limit'); return; }
    const toolCalls = Math.min(job.budget.toolCalls - (prior?.tool_calls ?? 0), TASK_LIMITS.toolCalls);
    if (toolCalls <= 0) { await this.giveUp(job, session, 'task_tool_budget_exceeded'); return; }
    const remaining = prior ? Number(prior.run_budget_ms) - Number(prior.run_used_ms) : TASK_LIMITS.runBudgetMs;
    if (remaining <= 0) { await this.giveUp(job, session, 'task_run_budget_exhausted'); return; }
    const shape = { version: 1 as const, lane: 'task' as const, job: job.id, lease: job.lease_token,
      policyRevision: policy.revision, instructions: TASK_INSTRUCTIONS_REVISION, repository: plan.repository, base: plan.base,
      project: plan.project, limits: plan.limits, toolCalls, runBudgetRemainingMs: remaining,
      timeoutMs: Math.min(job.budget.timeoutMs, TASK_LIMITS.turnTimeoutMs, remaining) };
    return TASK_ENDPOINTS['/v1/task'].request.parse(prior ? {
      ...shape, operation: 'resume', turn, generation: prior.generation, sessionId: prior.claude_session_id,
      expectedWorker: worker, resumeReason: prior.state === 'waiting_answer' ? 'clarification' : prior.wait_reason,
      // 한도·인증으로 끊긴 턴이 답을 나르던 중이었으면 같은 답으로 잇는다.
      ...(prior.question_id ? { questionId: prior.question_id, untrusted: { answer: prior.question_answer } } : {}),
    } : { ...shape, operation: 'start', turn, generation: (session?.generation ?? 0) + 1, sessionId: randomUUID(), untrusted: { request: text } });
  }
  // v2 턴의 저장. 시작·재개의 CAS와 응답 해석을 v1과 한 벌로 쓴다. v2는 응답을 기다리지 않아 결과 확정이 다른 시점에 일어난다.
  beginChangeTurn(job: Job, request: TaskV2Request, session: SessionRow | undefined): Promise<'started' | 'stale' | 'conflict'> {
    return this.begin(job, request, session, { version: TASK_V2_CONTRACT, lane: 'task', tool_approval_relay: false });
  }
  // snapshot 외의 턴 결말을 v1과 같은 규칙으로 확정한다.
  async settleChangeTurn(job: Job, session: SessionRow, result: Exclude<TaskV2TurnResult, { status: 'snapshot' }> | null, stop?: Stop, questionBlocked = false): Promise<Settled> {
    // 이 턴이 나르던 답이다. 한도·인증으로 끝나면 settle이 answered로 되돌려 다음 재개가 같은 답을 잇는다. 앞 턴의 질문도 resumed로 남아 있어 가장 뒤의 것이다.
    const question = session.turn > 1 ? (await this.store.db.query<{ id: string }>(`SELECT id FROM codex_questions WHERE job_id=$1 AND thread_id=$2 AND state='resumed' ORDER BY turn DESC LIMIT 1`, [job.id, session.claude_session_id])).rows[0] : undefined;
    const request = { operation: session.turn > 1 ? 'resume' : 'start', lease: session.worker_lease!, generation: session.generation!, sessionId: session.claude_session_id!, turn: session.turn, ...(question ? { questionId: question.id } : {}) } as unknown as TaskRequest;
    const usedMs = this.store.now() - Number(session.updated_at);
    if (!result) return this.settle(job, request, job.revision.policy, { kind: 'rejected' }, { stopped: true, retained: session.turn > 1, cleanupPending: false, worker: null, tools: 0 }, stop, usedMs);
    const facts: Facts = { stopped: result.stopped, retained: result.sessionRetained, cleanupPending: result.cleanupPending, worker: result.worker, tools: result.usage.toolCalls };
    // 작업자가 시작을 기록한 뒤 결과 없이 재시작하면 v1에 없는 "소멸 확인 + 결과 없음"이 온다. 모델을 다시 돌리지 않고 결과를 잃은 턴으로 닫는다.
    const turn: Turn = questionBlocked ? { kind: 'question_blocked' } : result.status === 'unknown' && result.stopped ? { kind: 'lost' } : { kind: 'response', response: result as unknown as TaskResponse };
    return this.settle(job, request, job.revision.policy, turn, facts, stop, usedMs);
  }
  reportChangeEnd(job: string, settled: Settled): void { if (settled.end) this.report(job, settled.end); }
  finalizeChangeSession(job: string): Promise<void> { return this.finalizeJob(job); }
  // /cancel로 끝난 job의 세션·질문을 sweep을 기다리지 않고 닫고 공간을 지운다.
  async closeChangeSession(job: string): Promise<void> {
    await this.closeAbandoned();
    await this.finalizeJob(job);
  }
  cancelChangeTurn(session: SessionRow, job: string): Promise<CancelFacts | null> {
    const expected = session.worker_instance && session.worker_storage ? { instance: session.worker_instance, storage: session.worker_storage } : null;
    return this.cancelTurn(this.control(job, session, expected));
  }
  statusOfChange(job: string, session: SessionRow): Promise<TaskStatusResponse> { return this.statusOf(job, session); }
  async bindChangeWorker(jobId: string, session: SessionRow, worker: TaskWorkerIdentity): Promise<void> {
    await this.store.db.query(`UPDATE codex_sessions SET ${bindWorker('$2', '$3')},updated_at=updated_at WHERE job_id=$1 AND generation=$4 AND claude_session_id=$5`,
      [jobId, worker.instance, worker.storage, session.generation, session.claude_session_id]);
  }
  // 턴을 세션에 고정한다. 대기→실행 CAS라 같은 세션의 재개가 겹쳐도 하나만 띄운다.
  private async begin(job: Job, request: TaskRequest | TaskV2Request, session: SessionRow | undefined, capabilities: object = { version: 1, lane: 'task', tool_approval_relay: false }): Promise<'started' | 'stale' | 'conflict'> {
    return this.store.atomic(async store => {
      await store.lockTaskControl(job.conversation_id);
      const row = (await store.db.query<{ state: string; lease_token: string; lease_until: string }>(
        'SELECT state,lease_token,lease_until FROM jobs WHERE id=$1 FOR UPDATE', [job.id])).rows[0];
      if (!row || row.lease_token !== job.lease_token || Number(row.lease_until) <= store.now() || row.state !== 'running') return 'stale';
      const now = store.now();
      if (request.operation === 'start') {
        // 기록이 없으면 내보낸 세션을 잃는다. 보존 칸은 응답 전부터 잡아 둔다.
        const written = await store.db.query(`INSERT INTO codex_sessions(job_id,thread_id,turn,tool_calls,host,repository,capabilities,state,created_at,updated_at,
          executor,claude_session_id,generation,worker_lease,base_sha,policy_revision,project_id,project_revision,turn_timeout_ms,run_budget_ms,session_retained)
          VALUES ($1,$2,1,0,'worker-task',$3,$4,'running',$5,$5,'claude',$2,$6,$7,$8,$9,$10,$11,$12,$13,true)
          ON CONFLICT (job_id) DO UPDATE SET thread_id=$2,turn=1,tool_calls=0,host='worker-task',repository=$3,capabilities=$4,state='running',updated_at=$5,
          executor='claude',claude_session_id=$2,generation=$6,worker_lease=$7,base_sha=$8,policy_revision=$9,project_id=$10,project_revision=$11,
          turn_timeout_ms=$12,run_budget_ms=$13,run_used_ms=0,stopped=NULL,session_retained=true,cleanup_state='none',waiting_since=NULL,
          owner_confirm_requested_at=NULL,wait_reason=NULL,worker_instance=NULL,worker_storage=NULL
          WHERE codex_sessions.executor='claude' AND codex_sessions.state NOT IN ('running','waiting_answer','waiting_model','unknown')
          AND NOT codex_sessions.session_retained AND codex_sessions.cleanup_state<>'pending' RETURNING job_id`,
        [job.id, request.sessionId, request.repository, JSON.stringify(capabilities), now,
          request.generation, request.lease, request.base, request.policyRevision, request.project.id, request.project.revision,
          request.timeoutMs, request.runBudgetRemainingMs]);
        if (!written.rows.length) return 'conflict';
      } else {
        const moved = await store.db.query(`UPDATE codex_sessions SET state='running',turn=$2,worker_lease=$3,worker_instance=$4,worker_storage=$5,updated_at=$6,
          stopped=NULL,wait_reason=NULL,waiting_since=NULL,owner_confirm_requested_at=NULL
          WHERE job_id=$1 AND executor='claude' AND claude_session_id=$7 AND generation=$8 AND turn=$9 AND state=$10 AND worker_storage=$5 RETURNING job_id`,
        [job.id, request.turn, request.lease, request.expectedWorker.instance, request.expectedWorker.storage, now, request.sessionId,
          request.generation, session!.turn, session!.state]);
        if (!moved.rows.length) return 'conflict';
        if (request.questionId) {
          const taken = await store.db.query("UPDATE codex_questions SET state='resumed' WHERE id=$1 AND state='answered' RETURNING id", [request.questionId]);
          if (!taken.rows.length) throw new Error('question_not_answered');
        }
      }
      await store.syncTaskLane();
      return 'started';
    });
  }
  private async dispatch(job: Job, request: TaskRequest, revision: string): Promise<void> {
    const started = this.store.now();
    let stop: Stop | undefined;
    const abort = new AbortController();
    // 취소는 한 번만 보낸다. 연결을 끊는 것만으로는 프로세스 소멸을 알 수 없다. 첫 턴은 작업자를 아직 모른다.
    let cancelling: Promise<CancelFacts | null> | undefined;
    const known = request.operation === 'resume' ? request.expectedWorker : null;
    const cancel = () => cancelling ??= this.cancelTurn(this.controlOf(request, known));
    const halt = (reason: Stop) => { stop ??= reason; void cancel(); abort.abort(); };
    let checking: Promise<void> | undefined;
    const monitor = setInterval(() => {
      if (checking) return;
      checking = this.check(job).then(reason => { if (reason) halt(reason); }, () => halt('monitor')).finally(() => { checking = undefined; });
    }, this.options.monitorMs);
    const timeout = setTimeout(() => halt('timeout'), request.timeoutMs);
    let drain: ReturnType<typeof setTimeout> | undefined;
    const onShutdown = () => { drain = setTimeout(() => halt('shutdown'), this.options.drainMs); };
    this.options.shutdown?.addEventListener('abort', onShutdown, { once: true });
    if (this.options.shutdown?.aborted) onShutdown();
    let giveUp: ReturnType<typeof setTimeout> | undefined;
    let turn: Turn;
    try {
      // 어댑터가 동기로 던져도 dispatch 뒤 오류로 다룬다. Runtime의 "실행 전" 분류로 새지 않게 한다.
      const executed = Promise.resolve().then(() => this.worker.call('/v1/task', request, abort.signal)).then(raw => this.read(raw, request), error =>
        ({ kind: error instanceof TaskWorkerRejected ? 'rejected' : 'lost' }) as Turn);
      // 중단 신호 뒤에도 응답이 없으면 기다리지 않는다. 기다리는 동안 lease만 늘리면 막힘을 숨긴다.
      const abandoned = new Promise<Turn>(resolve => abort.signal.addEventListener('abort', () => {
        giveUp = setTimeout(() => resolve({ kind: 'lost' }), this.options.stopWaitMs);
      }, { once: true }));
      turn = await Promise.race([executed, abandoned]);
    } finally {
      clearInterval(monitor); clearTimeout(timeout); clearTimeout(drain); clearTimeout(giveUp);
      this.options.shutdown?.removeEventListener('abort', onShutdown);
      await checking;
    }
    const facts = await this.factsOf(turn, request, turn.kind === 'lost' || stop ? cancel : undefined);
    // 마지막 감시 뒤의 철회를 결과 확정 전에 다시 본다. 철회면 완료·질문·대기보다 취소가 앞선다.
    let policy: Policy | undefined;
    try { policy = await this.gate.authorize(job.owner_id, job.target); }
    catch (error) { if (error instanceof Denied) stop = 'revoked'; else if (!(error instanceof PolicyUnavailable)) stop ??= 'monitor'; }
    // v1 응답은 다시 받을 수 없어 정책을 못 읽었어도 미루지 않고 막는 쪽으로 확정한다.
    const output = this.outputRisk(turn, policy);
    if (output) this.options.log('task_output_blocked', { job: job.id, output: output.kind, reason: output.risk });
    let settled: Settled;
    try { settled = await this.settle(job, request, revision, turn, facts, stop, this.store.now() - started, output?.risk ?? null); }
    catch { settled = { terminal: false, end: await this.recordFailed(job) }; }
    if (settled.end) this.report(job.id, settled.end);
    if (settled.terminal) await this.finalizeJob(job.id).catch(() => {});
  }
  // 모델이 쓴 글 중 Discord로 나가는 것은 질문과 완료 요약뿐이다. 실패 사유는 enum이고 나머지 안내는 고정 문구다.
  private outputRisk(turn: Turn, policy: Policy | undefined): { kind: 'question' | 'summary'; risk: TaskOutputRisk } | null {
    if (turn.kind !== 'response') return null;
    const response = turn.response;
    const text = response.status === 'needs_input' ? response.question : response.status === 'completed' ? response.summary : '';
    const risk = text ? taskOutputRisk(text, policy) : null;
    return risk ? { kind: response.status === 'needs_input' ? 'question' : 'summary', risk } : null;
  }
  // 기록 실패는 결과를 모르는 것과 같다. 이 갱신이 막히거나 DB에 닿지 못해도 lease가 끝나면 expire()가 unknown으로 둔다.
  // 세션은 running으로 남는다. 해제가 그 상태를 받고, 레인은 job의 unknown으로 닫힌다.
  private async recordFailed(job: Job): Promise<JobEnd> {
    try {
      return await this.store.atomic(async store => this.endOf(store, job.id, await store.transition(job, 'unknown', 'record_failed') ? undefined : 'unknown'));
    } catch { return { intended: 'unknown', state: null, reason: null }; }
  }
  // 응답을 계약으로 다시 읽는다. 다른 job·lease·세대·세션·턴의 응답이나 깨진 응답은 시작 여부를 모르는 것과 같다.
  private read(raw: unknown, request: TaskRequest): Turn {
    const parsed = TASK_ENDPOINTS['/v1/task'].response.safeParse(raw);
    if (!parsed.success) return { kind: 'lost' };
    const response = parsed.data;
    if (response.job !== request.job || response.lease !== request.lease || response.generation !== request.generation
      || response.sessionId !== request.sessionId || response.turn !== request.turn
      || !sameWorker(request.operation === 'resume' ? request.expectedWorker : null, response.worker)) return { kind: 'lost' };
    return { kind: 'response', response };
  }
  private async factsOf(turn: Turn, request: TaskRequest, cancel?: () => Promise<CancelFacts | null>): Promise<Facts> {
    if (turn.kind === 'response') {
      const r = turn.response;
      const own: Facts = { stopped: r.stopped, retained: r.sessionRetained, cleanupPending: r.cleanupPending, worker: r.worker, tools: r.usage.toolCalls };
      if (r.stopped) return own;
      // 실행 응답은 소멸을 못 봤어도 이미 보낸 취소가 봤을 수 있다. 첫 턴의 취소는 작업자를 지정하지 못해 그 턴을 띄운 작업자의 답인지 여기서 맞춘다.
      const facts = await cancel?.();
      if (!facts?.stopped || !sameWorker(r.worker, facts.worker)) return own;
      return { ...own, stopped: true, retained: facts.sessionRetained, cleanupPending: r.cleanupPending || facts.cleanupPending };
    }
    // 시작하지 않았으면 새 세션은 없고 재개 세션은 그대로 있다.
    if (turn.kind === 'rejected') return { stopped: true, retained: request.operation === 'resume' ? true : false, cleanupPending: false, worker: null, tools: 0 };
    const facts = await cancel?.();
    // 첫 턴 응답을 잃으면 저장소를 아직 모른다. 세션을 갖고 있다고 답한 작업자일 때만 그 저장소로 적는다.
    return { stopped: facts?.stopped ?? false, retained: facts ? facts.sessionRetained : null, cleanupPending: facts?.cleanupPending ?? false,
      worker: facts?.sessionRetained ? facts.worker : null, tools: null };
  }
  private controlOf(request: TaskRequest, expectedWorker: TaskWorkerIdentity | null) {
    return { version: 1 as const, job: request.job, lease: request.lease, generation: request.generation, sessionId: request.sessionId, expectedWorker };
  }
  // 작업이 끝난 뒤에도 worker_lease가 그 실행을 가리킨다. jobs.lease_token은 비거나 바뀌었을 수 있다.
  private control(job: string, session: SessionRow, expectedWorker: TaskWorkerIdentity | null) {
    return { version: 1 as const, job, lease: session.worker_lease!, generation: session.generation!, sessionId: session.claude_session_id!, expectedWorker };
  }
  private async statusOf(job: string, session: SessionRow): Promise<TaskStatusResponse> {
    const body = this.control(job, session, null);
    return echoed(body, TASK_ENDPOINTS['/v1/task/status'].response.parse(await this.worker.call('/v1/task/status', body)));
  }
  private async cancelOf(body: ControlTarget & { version: 1; expectedWorker: TaskWorkerIdentity | null }): Promise<TaskCancelResponse> {
    return echoed(body, TASK_ENDPOINTS['/v1/task/cancel'].response.parse(await this.worker.call('/v1/task/cancel', TASK_ENDPOINTS['/v1/task/cancel'].request.parse(body))));
  }
  // 소멸 확인. 작업자가 답하지 않거나 그 턴을 띄운 작업자가 아니면 확인하지 못한 것이다.
  private async cancelTurn(body: ControlTarget & { version: 1; expectedWorker: TaskWorkerIdentity | null }): Promise<CancelFacts | null> {
    let wait: ReturnType<typeof setTimeout> | undefined;
    try {
      return await Promise.race([
        this.cancelOf(body).then(response => sameWorker(body.expectedWorker, response.worker) ? response : null),
        new Promise<null>(resolve => { wait = setTimeout(() => resolve(null), this.options.stopWaitMs); }),
      ]);
    } catch { return null; } finally { clearTimeout(wait); }
  }
  // 턴 결과를 한 트랜잭션으로 확정한다. job 행을 잠가 두므로 전이 뒤에 읽은 값이 커밋될 값이다. 끝 기록은 커밋이 돌려준 값만 남아 되돌려진 끝이 로그로 새지 않는다.
  // risk는 응답의 질문·요약이 공개 검사에 걸린 사유다. 질문이면 행·게시 큐를 지나지 않고 실패로, 요약이면 그 줄만 고정 문구로 바꾼다.
  private async settle(job: Job, request: TaskRequest, revision: string, turn: Turn, facts: Facts, stop: Stop | undefined, usedMs: number,
    risk: TaskOutputRisk | null = null): Promise<Settled> {
    return this.store.atomic(async (store): Promise<Settled> => {
      await store.lockTaskControl(job.conversation_id);
      const row = (await store.db.query<{ state: string; lease_token: string; lease_until: string }>(
        'SELECT state,lease_token,lease_until FROM jobs WHERE id=$1 FOR UPDATE', [job.id])).rows[0]!;
      // 다른 실행이 넘겨받았거나 이미 확정됐으면 이 응답은 어떤 행도 바꾸지 못한다. 해제까지 끝난 세션을 unknown으로 덮으면 레인이 다시 닫힌다.
      if (row.lease_token !== job.lease_token || !SETTLEABLE.has(row.state)) { await store.audit('task_stale_response', job.id, { generation: request.generation, turn: request.turn }); return { terminal: false }; }
      const session = async (state: string, wait: { reason: 'model_limit' | 'auth_expired' } | null = null) => {
        await store.db.query(`UPDATE codex_sessions SET state=$2,updated_at=$3,run_used_ms=run_used_ms+$4,
          tool_calls=CASE WHEN $5::integer IS NULL OR tool_calls IS NULL THEN NULL ELSE tool_calls+$5::integer END,
          ${bindWorker('$6', '$7')},stopped=$8,
          session_retained=COALESCE($9,session_retained),cleanup_state=CASE WHEN $10::boolean THEN 'pending' ELSE cleanup_state END,
          wait_reason=$11,waiting_since=$12,owner_confirm_requested_at=NULL
          WHERE job_id=$1 AND state='running' AND worker_lease=$13 AND generation=$14 AND claude_session_id=$15`,
        [job.id, state, store.now(), Math.max(0, usedMs), facts.tools, facts.worker?.instance ?? null, facts.worker?.storage ?? null, facts.stopped ? true : null,
          facts.retained, facts.cleanupPending, wait?.reason ?? null, wait ? store.now() : null, request.lease, request.generation, request.sessionId]);
      };
      const end = async (state: string) => { await session(state); await store.syncTaskLane(); };
      // job이 전이했다. 세션도 끝내고 DB 값을 끝으로 적는다.
      const applied = async (state: string, terminal: boolean): Promise<Settled> => {
        await end(state);
        return { terminal, end: await this.endOf(store, job.id) };
      };
      // 전이가 막혔다. lease가 끝났거나 expire()가 먼저 unknown으로 둔 행이다. 소멸을 확인했어도 job이 끝나지 않았으므로 세션을 unknown으로 두고 공간을 지우지 않는다.
      // 공간은 해제가 지운다. 안내도 넣지 않는다. job이 unknown이 되면 sweep의 unknownNotices가 넣는다.
      const skipped = async (intended: string): Promise<Settled> => {
        await end('unknown');
        return { terminal: false, end: await this.endOf(store, job.id, intended) };
      };
      const fail = async (reason: string) => await store.fail(job, reason) ? applied('failed', true) : skipped('failed');
      const stopWith = async (reason: string, notify: boolean): Promise<Settled> => {
        const state = facts.stopped ? 'cancelled' : 'unknown';
        if (!await store.transition(job, state, reason)) return skipped(state);
        if (notify && !facts.stopped) await this.blocked(job, revision, store);
        return applied(state, facts.stopped);
      };
      const leaseLost = stop === 'lease' || Number(row.lease_until) <= store.now();
      if (stop === 'revoked') return stopWith('authorization_revoked', false);
      if (stop === 'cancel' || row.state === 'cancel_requested') return stopWith('stop_confirmation', true);
      // lease를 잃었으면 다른 기록이 이 작업을 넘겨받았을 수 있어 종료 확인과 무관하게 unknown이다.
      if (!facts.stopped || leaseLost) {
        const reason = leaseLost ? 'task_lease' : stop === 'shutdown' ? 'publisher_shutdown' : turn.kind === 'response' ? 'task_unknown' : 'task_worker_lost';
        if (!await store.transition(job, 'unknown', reason)) return skipped('unknown');
        await this.blocked(job, revision, store);
        return applied('unknown', false);
      }
      if (turn.kind === 'rejected') return fail('task_worker_rejected');
      if (stop) return fail(`task_${stop}`);
      if (turn.kind === 'lost') return fail('task_worker_lost');
      if (turn.kind === 'question_blocked') return fail(CHANGE_QUESTION_BLOCKED);
      const response = turn.response;
      if (response.status === 'failed') return fail(`task_${response.reason}`);
      if (response.status === 'limited' || response.status === 'auth_expired') {
        const reason = response.status === 'limited' ? 'model_limit' : 'auth_expired';
        // 계정 한도는 대화·리뷰도 같은 계정이라 양쪽을 막고, 인증 만료는 레인 토큰의 일이라 작업 레인만 막는다.
        await store.waitForUser(job, reason, { laneOnly: reason === 'auth_expired' });
        const now = (await store.db.query<{ state: string; attempt: number }>('SELECT state,attempt FROM jobs WHERE id=$1', [job.id])).rows[0]!;
        if (now.state !== 'waiting_user') return skipped('waiting_user');
        await session('waiting_model', { reason });
        await store.syncTaskLane();
        // 그 턴이 나르던 답은 처리되지 않았다. /resume-model 뒤 같은 답으로 잇는다.
        if (request.operation === 'resume' && request.questionId) await store.db.query("UPDATE codex_questions SET state='answered' WHERE id=$1 AND state='resumed'", [request.questionId]);
        const resumable = Number(now.attempt) < DEFAULTS.maxRetries + 1;
        await store.enqueue({ key: `task-wait:${job.id}:${job.attempt}`, job: job.id, conversation: job.conversation_id, actor: job.owner_id, scope: job.target, revision,
          payload: { kind: 'message', channel: job.target.channel, classification: 'safe_summary',
            content: `작업 ${job.id}이 ${reason === 'model_limit' ? '모델 사용 한도로 멈췄습니다. 같은 계정을 쓰는 대화·리뷰도 함께 멈춥니다' : '작업 레인 인증 만료로 멈췄습니다. 대화·리뷰는 계속 동작합니다'}. 다른 계정·인증으로 바꾸지 않습니다. `
              + (resumable ? `원인을 해소한 뒤 /resume-model target:${job.id} 로 재개하거나 /cancel 하세요.` : '재시도 한도에 닿아 재개할 수 없습니다. /cancel 뒤 새 작업으로 요청하세요.') } });
        return { terminal: false };
      }
      if (response.status === 'needs_input') {
        // CHANGE 질문이 걸렸을 때와 같이 실패로 닫고 세션 공간을 지운다. 안내에는 사유 코드만 싣는다.
        if (risk) {
          const settled = await fail(CHANGE_QUESTION_BLOCKED);
          if (settled.end && !settled.end.intended && settled.end.state === 'failed') {
            await store.enqueue({ key: `task-question-blocked:${job.id}:${job.attempt}`, job: job.id, conversation: job.conversation_id, actor: job.owner_id,
              scope: job.target, revision, payload: { kind: 'message', channel: job.target.channel, classification: 'safe_summary',
                content: `작업 ${job.id}의 질문이 공개 검사에 걸려(사유: ${risk}) 질문을 보내지 않고 작업을 멈췄습니다(failed). 요청을 고쳐 새 작업으로 요청하거나 /retry target:${job.id} 로 다시 실행하세요.` } });
          }
          return settled;
        }
        if (await this.ask(job, revision, taskQuestionId(job.id, request.sessionId, request.turn), request.sessionId, request.turn, response.question, store)) {
          await end('waiting_answer');
          return { terminal: false };
        }
        // 대기에 못 들어갔다. 구독 중지로 끝났으면(superseded) 세션을 닫고, job이 그대로면 전이가 막힌 것이다.
        const after = (await store.db.query<{ state: string }>('SELECT state FROM jobs WHERE id=$1', [job.id])).rows[0]!;
        return SETTLEABLE.has(after.state) ? skipped('waiting_user') : applied('cancelled', true);
      }
      if (response.status !== 'completed') throw new Error('unexpected_status');
      const result = { summary: response.summary, changes: response.changes, patch: response.patch, verification: response.verification };
      const resultDigest = digest(result);
      const verified = response.verification.reduce((sum, item) => ({ ...sum, [item.status]: sum[item.status] + 1 }), { passed: 0, failed: 0, not_run: 0 });
      await store.finish(job, result, { source: 'task_worker', sessionId: request.sessionId, generation: request.generation, turns: request.turn,
        worker: response.worker, stopConfirmed: true, diff: 'worker_computed', usage: response.usage, resultDigest, ...(risk ? { summaryWithheld: risk } : {}) },
      [`작업 완료 (작업 ${job.id})`,
        risk ? `요약이 공개 검사에 걸려(사유: ${risk}) 보내지 않았습니다. 작업 완료는 기록했습니다.` : bounded(response.summary || '요약 없음', TASK_LIMITS.summaryChars),
        `변경 파일(작업자 diff 기준): ${response.changes.total}개`,
        `검증: 통과 ${verified.passed} · 실패 ${verified.failed} · 미실행 ${verified.not_run}`].join('\n'), job.target);
      // 구독이 멈춘 대화에서 finish는 막혀도 던지지 않는다.
      const after = (await store.db.query<{ state: string }>('SELECT state FROM jobs WHERE id=$1', [job.id])).rows[0]!;
      if (SETTLEABLE.has(after.state)) return skipped('succeeded');
      return applied(after.state === 'succeeded' ? 'completed' : 'cancelled', true);
    });
  }
  // Runtime.tickTask가 claim 전에 부른다. 작업자 호출 실패는 이 바퀴를 깨지 않고 다음 sweep이 다시 시도한다.
  async sweep(): Promise<number> {
    const expired = await this.expireQuestions();
    const notices = await this.unknownNotices();
    const closed = await this.closeAbandoned();
    const confirms = await this.requestOwnerConfirm();
    await this.retryCleanup();
    await this.store.atomic(async store => {
      await store.db.query(`SELECT lane FROM execution_lanes WHERE lane='task' FOR UPDATE`);
      await store.syncTaskLane();
    });
    return expired + notices + closed + confirms;
  }
  // /cancel·철회처럼 세션을 모르는 경로로 끝난 job의 세션·질문을 닫는다. 그래야 세션 공간을 지울 수 있다.
  private async closeAbandoned(): Promise<number> {
    const rows = (await this.store.db.query<{ job_id: string; conversation_id: string }>(`SELECT s.job_id,j.conversation_id FROM codex_sessions s JOIN jobs j ON j.id=s.job_id
      WHERE s.executor='claude' AND s.state IN ('running','waiting_answer','waiting_model')
      AND j.state IN ('succeeded','failed','cancelled','superseded')`)).rows;
    for (const row of rows) {
      await this.store.atomic(async store => {
        await store.lockTaskControl(row.conversation_id);
        await store.db.query(`UPDATE codex_sessions s SET state='cancelled',updated_at=$2,wait_reason=NULL,waiting_since=NULL FROM jobs j
          WHERE s.job_id=$1 AND s.executor='claude' AND j.id=s.job_id AND s.state IN ('running','waiting_answer','waiting_model') AND j.state IN ('succeeded','failed','cancelled','superseded')`, [row.job_id, store.now()]);
        await store.db.query("UPDATE codex_questions SET state='cancelled' WHERE job_id=$1 AND state IN ('open','answered')", [row.job_id]);
      });
    }
    return rows.length;
  }
  // 모델 대기가 24시간을 넘으면 owner 확인을 요청했다고 표시하고 알린다. 자동 재개·폐기는 하지 않는다.
  private async requestOwnerConfirm(): Promise<number> {
    const due = this.store.now() - TASK_RETENTION.modelWaitOwnerConfirmMs;
    const rows = (await this.store.db.query<Job & { waiting_since: string }>(`SELECT j.*,s.waiting_since FROM codex_sessions s JOIN jobs j ON j.id=s.job_id
      WHERE s.executor='claude' AND s.state='waiting_model' AND j.state='waiting_user' AND s.owner_confirm_requested_at IS NULL AND s.waiting_since<=$1`, [due])).rows;
    for (const job of rows) {
      await this.store.atomic(async store => {
        await store.lockTaskControl(job.conversation_id);
        const marked = await store.db.query(`UPDATE codex_sessions SET owner_confirm_requested_at=$2,updated_at=$2 WHERE job_id=$1 AND executor='claude' AND state='waiting_model'
          AND owner_confirm_requested_at IS NULL AND waiting_since<=$3 AND EXISTS (SELECT 1 FROM jobs j WHERE j.id=$1 AND j.state='waiting_user') RETURNING job_id`, [job.id, store.now(), due]);
        if (!marked.rows.length) return;
        await store.audit('task_owner_confirm_requested', job.id, { waitingSince: Number(job.waiting_since) });
        await store.enqueue({ key: `task-owner-confirm:${job.id}:${job.waiting_since}`, job: job.id, conversation: job.conversation_id, actor: job.owner_id, scope: job.target,
          revision: job.revision.policy, payload: { kind: 'message', channel: job.target.channel, classification: 'safe_summary',
            content: `작업 ${job.id}의 모델 대기가 24시간을 넘었습니다. 자동으로 재개하거나 버리지 않습니다. 세션을 계속 보존할지 확인하고 /resume-model target:${job.id} 또는 /cancel target:${job.id} 하세요.` } });
      });
    }
    return rows.length;
  }
  private async retryCleanup(): Promise<void> {
    const rows = (await this.store.db.query<{ job_id: string }>(`SELECT s.job_id FROM codex_sessions s JOIN jobs j ON j.id=s.job_id WHERE s.executor='claude'
      AND (s.cleanup_state='pending' OR (s.session_retained AND s.state IN ('completed','failed','cancelled')))
      AND j.state NOT IN ('running','verifying','cancel_requested','unknown')`)).rows;
    for (const row of rows) {
      if ((this.nextFinalize.get(row.job_id) ?? 0) > this.store.now()) continue;
      await this.finalizeJob(row.job_id).catch(() => {});
    }
  }
  // 최종 상태를 DB에 남긴 뒤에만 세션 공간을 지운다. 지웠는지 확인하지 못하면 cleanup_pending으로 새 접수를 닫고 다시 시도한다.
  private async finalizeJob(jobId: string): Promise<void> {
    const session = (await this.store.db.query<SessionRow>(`SELECT * FROM codex_sessions WHERE job_id=$1 AND executor='claude'`, [jobId])).rows[0];
    if (!session?.claude_session_id || !session.generation || !session.worker_lease) return;
    if (session.state === 'unknown' || session.state === 'running') return;
    // 시작이 거부된 세션처럼 작업자에 남은 것이 없으면 물을 일도 없다.
    if (!session.session_retained && session.cleanup_state !== 'pending') return;
    let cleaned = false;
    let waitingClean = false;
    let identity: TaskWorkerIdentity | null = null;
    try {
      const status = await this.statusOf(jobId, session);
      // 다른 저장소의 absent·finalized는 이 세션의 소멸 증명이 아니다. 답을 적지 않아 다음 재시도도 옛 저장소를 기준으로 본다.
      const sameStorage = !session.worker_storage || status.worker.storage === session.worker_storage;
      // 저장소를 모르면 세션을 봤다고 답한 곳에만 묶는다. absent를 묶으면 다음 재시도의 absent가 소멸 증명이 된다.
      const known = session.worker_storage ? sameStorage : status.state !== 'absent' && status.state !== 'unknown';
      if (known) identity = status.worker;
      if (session.state === 'waiting_answer' || session.state === 'waiting_model') waitingClean = sameStorage && status.state === 'waiting';
      else if (sameStorage && (status.state === 'finalized' || (status.state === 'absent' && !!session.worker_storage))) cleaned = true;
      else if (sameStorage && status.stopped) cleaned = await this.finalizeTurn(jobId, session, status.worker);
    } catch { cleaned = false; }
    this.nextFinalize.set(jobId, this.store.now() + this.options.finalizeRetryMs);
    await this.store.atomic(async store => {
      await store.db.query(`SELECT lane FROM execution_lanes WHERE lane='task' FOR UPDATE`);
      if (session.state === 'waiting_answer' || session.state === 'waiting_model') {
        // 대기 세션의 정리 완료는 세션을 지우지 않고 막힘만 푼다. 묻는 사이 재개됐으면 이 답은 그 턴의 것이 아니다.
        await store.db.query(`UPDATE codex_sessions SET cleanup_state=$2,updated_at=$3 WHERE job_id=$1 AND cleanup_state='pending' AND generation=$4 AND claude_session_id=$5 AND state=$6 AND turn=$7`,
          [jobId, waitingClean ? 'none' : 'pending', store.now(), session.generation, session.claude_session_id, session.state, session.turn]);
      } else {
        // 작업자에 묻는 사이 새 세대가 시작했으면 이 결론은 그 세션의 것이 아니다. 다른 인스턴스가 이미 지웠으면 늦은 실패로 되돌리지 않는다.
        await store.db.query(`UPDATE codex_sessions SET cleanup_state=CASE WHEN $2::boolean OR cleanup_state='cleaned' THEN 'cleaned' ELSE 'pending' END,session_retained=CASE WHEN $2::boolean THEN false ELSE session_retained END,
          stopped=CASE WHEN $2::boolean THEN true ELSE stopped END,${bindWorker('$3', '$4')},updated_at=$5 WHERE job_id=$1 AND generation=$6 AND claude_session_id=$7`,
        [jobId, cleaned, identity?.instance ?? null, identity?.storage ?? null, store.now(), session.generation, session.claude_session_id]);
      }
      await store.syncTaskLane();
    });
    if (cleaned || waitingClean) this.nextFinalize.delete(jobId);
  }
  private async finalizeTurn(job: string, session: SessionRow, worker: TaskWorkerIdentity): Promise<boolean> {
    // v2 세션의 저장 ACK. 저장한 결과가 있으면 그 digest로, 결과 없이 끝났으면 버린다고 말한다. 저장 없이 이 줄에 올 수 있는 행은 completed가 아니다.
    const capabilities = parseCapabilities(session);
    if (capabilities?.version === TASK_V2_CONTRACT) {
      if (!this.change) throw new Error('change_worker_unavailable');
      const saved = session.state === 'completed' && capabilities.artifactDigest ? { outcome: 'saved' as const, artifactDigest: capabilities.artifactDigest } : { outcome: 'discarded' as const };
      const body = TASK_V2_ENDPOINTS['/v2/task/finalize'].request.parse({ ...this.control(job, session, worker), version: TASK_V2_CONTRACT, receipt: { ...saved, persistedAt: Number(session.updated_at) } });
      const { response: raw } = await this.change.callV2('/v2/task/finalize', body);
      const response = echoed(body, TASK_V2_ENDPOINTS['/v2/task/finalize'].response.parse(raw));
      return response.stopped && response.cleaned && response.worker.storage === worker.storage;
    }
    const outcome = session.state === 'completed' ? 'succeeded' : session.state === 'cancelled' ? 'cancelled' : 'failed';
    const digestRow = outcome === 'succeeded' ? (await this.store.db.query<{ digest: string | null }>(`SELECT evidence->>'resultDigest' AS digest FROM results WHERE job_id=$1`, [job])).rows[0] : undefined;
    const body = TASK_ENDPOINTS['/v1/task/finalize'].request.parse({ ...this.control(job, session, worker), disposition: 'terminal',
      receipt: { outcome, persistedAt: Number(session.updated_at), resultDigest: digestRow?.digest ?? null } });
    const response = echoed(body, TASK_ENDPOINTS['/v1/task/finalize'].response.parse(await this.worker.call('/v1/task/finalize', body)));
    return response.stopped && response.cleaned && response.worker.storage === worker.storage;
  }
  // 세션 상태까지 함께 보여 준다. 24시간 owner 확인은 표시일 뿐 상태를 바꾸지 않는다.
  override async status(actor: string, scope: Scope, jobId: string): Promise<TaskStatus & { waitingSince: number | null; ownerConfirmRequestedAt: number | null; cleanup: string | null; generation: number | null }> {
    const base = await super.status(actor, scope, jobId);
    const session = (await this.store.db.query<SessionRow>('SELECT * FROM codex_sessions WHERE job_id=$1', [jobId])).rows[0];
    const number = (value: string | number | null | undefined) => value === null || value === undefined ? null : Number(value);
    return { ...base, waitingSince: number(session?.waiting_since), ownerConfirmRequestedAt: number(session?.owner_confirm_requested_at),
      cleanup: session?.cleanup_state ?? null, generation: session?.generation ?? null };
  }
  // unknown 해제는 작업자의 소멸 확인을 거친다. 세션 공간도 함께 지우고, 지우지 못하면 cleanup_pending으로 레인을 계속 닫는다.
  async release(actor: string, scope: Scope, jobId: string): Promise<{ ok: boolean; status: string }> {
    const job = await this.releasable(actor, scope, jobId);
    const session = (await this.store.db.query<SessionRow>('SELECT * FROM codex_sessions WHERE job_id=$1', [jobId])).rows[0];
    // Codex 세션은 작업자가 달라 여기서 소멸을 확인할 수 없다. CodexBridge.release가 그 작업자에게 묻는다.
    if (session && session.executor !== 'claude') return { ok: false, status: FOREIGN_SESSION_STATUS };
    if (job.state !== 'unknown' && session?.state !== 'unknown') return { ok: false, status: '종료를 확인하지 못한(unknown) 작업이 아닙니다.' };
    // 세션 행이 없으면 어느 작업자에도 보낸 적이 없다. 턴 시작이 dispatch 전에 행을 남긴다.
    const stopped = session ? await this.confirmStopped(jobId, session) : true;
    if (!stopped) return { ok: false, status: '작업자 프로세스가 남아 있거나 확인할 수 없습니다. 작업자 파드를 다시 만든 뒤 확인하세요.' };
    const changed = await this.store.atomic(async store => {
      await store.lockTaskControl(job.conversation_id);
      const held = (await store.db.query<{ lease_token: string | null }>('SELECT lease_token FROM jobs WHERE id=$1 FOR UPDATE', [jobId])).rows[0];
      const current = (await store.db.query<SessionRow>('SELECT * FROM codex_sessions WHERE job_id=$1 FOR UPDATE', [jobId])).rows[0];
      // 확인한 것은 읽어 둔 lease·세대의 소멸뿐이다. 그 사이 넘어갔으면 이 확인으로 풀지 않는다.
      if (held?.lease_token !== job.lease_token || !sameSession(session, current)) return false;
      const row = (await store.db.query(`UPDATE jobs SET state='cancelled',wait_reason='stop_confirmed_after_unknown',finished_at=$2
        WHERE id=$1 AND state='unknown' RETURNING id`, [jobId, store.now()])).rows[0];
      const moved = await store.db.query(`UPDATE codex_sessions SET state='cancelled',stopped=true,updated_at=$2 WHERE job_id=$1 AND executor='claude' AND state IN ('unknown','running') RETURNING job_id`, [jobId, store.now()]);
      if (!row && !moved.rows.length) return false;
      await store.db.query("UPDATE codex_questions SET state='cancelled' WHERE job_id=$1 AND state IN ('open','answered')", [jobId]);
      await store.audit('task_unknown_released', jobId, { actor });
      await store.syncTaskLane();
      return true;
    });
    if (!changed) return { ok: false, status: '상태가 바뀌었습니다. /list로 확인하세요.' };
    await this.finalizeJob(jobId).catch(() => {});
    return { ok: true, status: '작업자 프로세스 0개를 확인하고 막힘을 해제했습니다. 작업은 다시 실행하지 않습니다.' };
  }
  private async confirmStopped(job: string, session: SessionRow): Promise<boolean> {
    const expected = session.worker_instance && session.worker_storage ? { instance: session.worker_instance, storage: session.worker_storage } : null;
    try {
      const response = await this.cancelOf(this.control(job, session, expected));
      return response.stopped && (!session.worker_storage || response.worker.storage === session.worker_storage);
    } catch (error) {
      if (!(error instanceof TaskWorkerRejected) || !session.worker_storage) return false;
    }
    // 파드가 바뀌어 옛 identity의 취소가 거부됐다. 같은 저장소의 새 작업자가 소멸을 말해 주면 그 값을 쓴다.
    try {
      const status = await this.statusOf(job, session);
      return status.stopped && status.worker.storage === session.worker_storage;
    } catch { return false; }
  }
}

// ---- CHANGE_PR 작성 port ----

export const CHANGE_RECEIPT = /^v2:([0-9a-f-]{36}):([1-9]\d*)$/;
const changeReceipt = (job: string, generation: number) => `v2:${job}:${generation}`;
// 공개 brief만 모델에 준다. 사용자 원문(ChangePrivateInputs)을 읽지 않는다.
export function renderChangeBrief(brief: ChangeBrief): string {
  const text = [`요약: ${brief.summary}`, `목표: ${brief.goal}`, '인수 조건:', ...brief.acceptanceCriteria.map(item => `- ${item}`)].join('\n');
  if (text.length > TASK_V2_REQUEST_CHARS) throw new Error('change_brief_too_long');
  return text;
}
export interface ChangeAuthorPlan {
  // 이미 claim되어 running이고 lease를 쥔 자식 job. change_child_jobs에 author로 묶은 뒤 넘긴다.
  job: Job;
  repository: string; project: TaskRequest['project']; limits: TaskRequest['limits'];
  // API로 읽어 완결을 확인한 T0의 잎 전체. 잘린 tree를 넘기지 않는다.
  baseline: readonly BaselineLeaf[];
}
export interface ChangeAuthorSource {
  plan(input: Parameters<ChangeAuthorPort['start']>[0]): Promise<ChangeAuthorPlan>;
  // 재개 턴의 프로젝트 정책과 상한. 세션의 고정값과 대조한다.
  settings(jobId: string): Promise<Pick<ChangeAuthorPlan, 'project' | 'limits'>>;
  // 재개 때 claim된 자식 job. 없으면 슬롯을 잡지 않은 것이라 띄우지 않는다.
  claimed(jobId: string): Promise<Job | null>;
  // change generation의 작성 job.
  authorJob(key: ChangeKey): Promise<string | null>;
  keyOf(jobId: string): Promise<ChangeKey | null>;
  // 모델 질문을 스레드에 내보내면 안 되는 사유 코드. 없으면 null이다.
  questionRisk(jobId: string, question: string): Promise<string | null>;
}
export interface ChangeAuthorDeps { bridge: ClaudeTaskBridge; store: Store; gate: PolicyGate; worker: TaskV2WorkerPort; source: ChangeAuthorSource; artifacts: ChangeArtifactPort }
const TERMINAL_SESSION = new Set(['completed', 'failed', 'cancelled']);
// 작업자 정리(유예 1.5초 + KILL 2초)보다 길게 기다린다. null은 마지막 시도다.
const BUSY_RETRY_MS = [500, 1000, 2000, 4000, null] as const;
// 작업자 v2 경로. 세션 행을 v1과 같은 표에 두어 레인 닫힘·보존 칸·소멸 확인이 같은 규칙으로 돈다. receipt는 job·세션 세대이고 나머지는 그 행에서 읽는다.
// 저장 전에 작업자 결과를 지우지 않는다: 세션은 저장 ACK 전까지 running이라 v1 정리 sweep이 건드리지 않는다.
export class ClaudeChangeAuthor implements ChangeAuthorPort {
  constructor(private readonly deps: ChangeAuthorDeps) {}
  supportsV2(): Promise<boolean> { return this.deps.worker.supportsChange().catch(() => false); }
  private async session(jobId: string, generation?: number): Promise<SessionRow | undefined> {
    const row = (await this.deps.store.db.query<SessionRow>(`SELECT * FROM codex_sessions WHERE job_id=$1 AND executor='claude'`, [jobId])).rows[0];
    return row && (generation === undefined || row.generation === generation) ? row : undefined;
  }
  private parse(receiptId: string): { job: string; generation: number } {
    const match = CHANGE_RECEIPT.exec(receiptId);
    if (!match) throw new Error('change_receipt_invalid');
    return { job: match[1]!, generation: Number(match[2]) };
  }
  private async jobRow(id: string): Promise<Job> { return (await this.deps.store.db.query<Job>('SELECT * FROM jobs WHERE id=$1', [id])).rows[0]!; }
  private async send(job: Job, session: SessionRow | undefined, request: TaskV2Request): Promise<void> {
    const begun = await this.deps.bridge.beginChangeTurn(job, request, session);
    if (begun !== 'started') throw new Error(`change_turn_${begun}`);
    try {
      // 정리 요청이 도는 잠깐 동안 슬롯이 찬다. 시작하지 않았다는 답이라 같은 턴을 다시 보내도 안전하다. 이것으로 턴을 닫으면 일시 경합이 끝 상태가 된다.
      let reply: { response: unknown; bytes: number } | undefined;
      for (const delay of BUSY_RETRY_MS) {
        try { reply = await this.deps.worker.callV2('/v2/task', request); break; }
        catch (error) {
          if (!(error instanceof TaskWorkerBusy) || delay === null) throw error;
          await new Promise(resolve => { setTimeout(resolve, delay); });
        }
      }
      const accepted = TASK_V2_ENDPOINTS['/v2/task'].response.safeParse(reply?.response);
      if (accepted.success && accepted.data.job === request.job && accepted.data.turn === request.turn) {
        await this.deps.bridge.bindChangeWorker(job.id, { generation: request.generation, claude_session_id: request.sessionId } as SessionRow, accepted.data.worker);
      }
    } catch (error) {
      // 시작하지 않았다는 증거면 그 턴을 닫는다. 그 밖은 시작 여부를 모른다. 다시 보내지 않고 fetchResult가 작업자에게 묻는다.
      if (!(error instanceof TaskWorkerRejected)) return;
      const row = await this.session(job.id, request.generation);
      if (row) this.deps.bridge.reportChangeEnd(job.id, await this.deps.bridge.settleChangeTurn(job, row, null));
    }
  }
  async start(input: Parameters<ChangeAuthorPort['start']>[0]): Promise<{ receiptId: string }> {
    if (!labelAllowsAuthorInput(input.brief.label)) throw new Error('label_blocked');
    const plan = await this.deps.source.plan(input);
    const { job } = plan;
    await this.deps.gate.authorize(job.owner_id, job.target);
    const prior = await this.session(job.id);
    if (prior && !TERMINAL_SESSION.has(prior.state)) throw new Error('change_session_active');
    const generation = (prior?.generation ?? 0) + 1;
    const timeoutMs = Math.min(job.budget.timeoutMs, TASK_LIMITS.turnTimeoutMs);
    const request = TASK_V2_ENDPOINTS['/v2/task'].request.parse({ version: TASK_V2_CONTRACT, lane: 'task', job: job.id, lease: job.lease_token, generation, policyRevision: input.policyRevision,
      instructions: TASK_INSTRUCTIONS_REVISION, sessionId: randomUUID(), repository: plan.repository, base: input.baseCommit, project: plan.project, timeoutMs,
      runBudgetRemainingMs: TASK_LIMITS.runBudgetMs, toolCalls: Math.min(job.budget.toolCalls, TASK_LIMITS.toolCalls), limits: plan.limits, operation: 'start', turn: 1,
      baseline: { repoId: input.target.repoId, changeGeneration: input.target.key.generation, baseTree: input.baseTree, leaves: plan.baseline },
      untrusted: { request: renderChangeBrief(input.brief) } });
    await this.send(job, prior, request);
    return { receiptId: changeReceipt(job.id, generation) };
  }
  async resume(input: { receiptId: string; answer: string; label: ProvenanceLabel }): Promise<void> {
    if (!labelAllowsAuthorInput(input.label)) throw new Error('label_blocked');
    const { job: jobId, generation } = this.parse(input.receiptId);
    const session = await this.session(jobId, generation);
    if (!session || (session.state !== 'waiting_answer' && session.state !== 'waiting_model')) throw new Error('change_session_not_waiting');
    const job = await this.deps.source.claimed(jobId);
    if (!job) throw new Error('change_job_not_claimed');
    const policy = await this.deps.gate.authorize(job.owner_id, job.target);
    if (policy.revision !== session.policy_revision) throw new Error('change_policy_changed');
    const status = await this.deps.bridge.statusOfChange(jobId, session);
    if (status.worker.storage !== session.worker_storage || status.state !== 'waiting' || !status.sessionExists || !status.stopped) throw new Error('change_session_missing');
    const question = (await this.deps.store.db.query<{ id: string }>(`SELECT id FROM codex_questions WHERE job_id=$1 AND thread_id=$2 AND state='answered'`, [jobId, session.claude_session_id])).rows[0];
    if (session.state === 'waiting_answer' && !question) throw new Error('change_question_not_answered');
    const remaining = Number(session.run_budget_ms) - Number(session.run_used_ms);
    if (remaining <= 0) throw new Error('change_run_budget_exhausted');
    const toolCalls = Math.min(job.budget.toolCalls - (session.tool_calls ?? 0), TASK_LIMITS.toolCalls);
    if (session.tool_calls === null || toolCalls <= 0) throw new Error('change_tool_budget_exhausted');
    const plan = await this.deps.source.settings(jobId);
    if (plan.project.id !== session.project_id || plan.project.revision !== session.project_revision) throw new Error('change_session_mismatch');
    const request = TASK_V2_ENDPOINTS['/v2/task'].request.parse({ version: TASK_V2_CONTRACT, lane: 'task', job: jobId, lease: job.lease_token, generation, policyRevision: session.policy_revision,
      instructions: TASK_INSTRUCTIONS_REVISION, sessionId: session.claude_session_id, repository: session.repository, base: session.base_sha, project: plan.project,
      timeoutMs: Math.min(job.budget.timeoutMs, TASK_LIMITS.turnTimeoutMs, remaining), runBudgetRemainingMs: remaining, toolCalls, limits: plan.limits,
      operation: 'resume', turn: session.turn + 1, expectedWorker: status.worker, resumeReason: session.state === 'waiting_answer' ? 'clarification' : session.wait_reason,
      ...(question ? { questionId: question.id, untrusted: { answer: input.answer, label: input.label } } : {}) });
    await this.send(job, session, request);
  }
  async cancel(receiptId: string): Promise<void> {
    const { job, generation } = this.parse(receiptId);
    const session = await this.session(job, generation);
    if (!session) return;
    await this.deps.bridge.cancelChangeTurn(session, job);
    // 실행 중인 턴은 fetchResult가 aborted로 닫는다. 대기 세션은 턴이 소멸을 확인하고 이미 끝났고 작업자의 저장 결과가 취소로 바뀌지 않아, 여기서 닫지 않으면 fetchResult가 옛 결과를 계속 준다.
    if (session.state !== 'waiting_answer' && session.state !== 'waiting_model') return;
    const row = await this.jobRow(job);
    await this.deps.store.control(row.owner_id, row.conversation_id, 'cancel', job);
    await this.deps.bridge.closeChangeSession(job);
  }
  private cancelledOrFailed(session: SessionRow, code: string | null): AuthorResult {
    return session.state === 'cancelled' ? { kind: 'cancelled', code: code ?? 'cancelled' } : { kind: 'failed', code: code ?? 'task_failed' };
  }
  async fetchResult(receiptId: string): Promise<AuthorResult> {
    const { job: jobId, generation } = this.parse(receiptId);
    const session = await this.session(jobId, generation);
    if (!session) return { kind: 'unknown', code: 'session_missing' };
    const job = await this.jobRow(jobId);
    if (TERMINAL_SESSION.has(session.state)) return session.state === 'completed' ? { kind: 'failed', code: 'already_finalized' } : this.cancelledOrFailed(session, (job as unknown as { wait_reason: string | null }).wait_reason);
    const expected = session.worker_instance && session.worker_storage ? { instance: session.worker_instance, storage: session.worker_storage } : null;
    const body = { version: TASK_V2_CONTRACT, job: jobId, lease: session.worker_lease!, generation, sessionId: session.claude_session_id!, expectedWorker: expected };
    let raw: { response: unknown; bytes: number };
    // 파드가 바뀌면 instance가 달라 거부된다. 같은 저장소면 같은 결과이므로 저장소를 대조하는 쪽으로 다시 묻는다.
    try { raw = await this.deps.worker.callV2('/v2/task/result', body); }
    catch (error) {
      if (!(error instanceof TaskWorkerRejected) || !expected) return { kind: 'unknown', code: 'worker_unreachable' };
      try { raw = await this.deps.worker.callV2('/v2/task/result', { ...body, expectedWorker: null }); }
      catch { return { kind: 'unknown', code: 'worker_unreachable' }; }
    }
    const parsed = TASK_V2_ENDPOINTS['/v2/task/result'].response.safeParse(raw.response);
    if (!parsed.success || parsed.data.job !== jobId || parsed.data.lease !== session.worker_lease || parsed.data.generation !== generation || parsed.data.sessionId !== session.claude_session_id) {
      return { kind: 'unknown', code: 'response_invalid' };
    }
    const result = parsed.data;
    // 다른 저장소의 답은 이 세션의 사실이 아니다.
    if (session.worker_storage && result.worker.storage !== session.worker_storage) return { kind: 'unknown', code: 'worker_storage_changed' };
    if (result.status === 'running') { await this.deps.store.heartbeat(job).catch(() => {}); return { kind: 'running' }; }
    if (result.status === 'absent') return { kind: 'unknown', code: result.finalized ? 'already_finalized' : 'start_unconfirmed' };
    if (result.turn !== session.turn) return { kind: 'unknown', code: 'turn_mismatch' };
    if (result.status === 'snapshot') {
      const artifact = decodeArtifact(result.artifact, result.artifactDigest);
      if (!artifact) return { kind: 'unknown', code: 'artifact_response_invalid' };
      await this.deps.bridge.bindChangeWorker(jobId, session, result.worker);
      await this.deps.store.heartbeat(job).catch(() => {});
      return { kind: 'snapshot', artifact, transportBytes: raw.bytes };
    }
    const stop = result.status === 'failed' && result.reason === 'aborted' ? 'cancel' as const : undefined;
    // 질문 경로는 스레드로 바로 나간다. 질문 행을 만들기 전에 본다. 정책을 못 읽어 던지면 아무것도 나가지 않고 다음 바퀴에 같은 결과를 다시 본다.
    const risky = result.status === 'needs_input' && await this.deps.source.questionRisk(jobId, result.question) !== null;
    const settled = await this.settled(job, session, result, stop, risky);
    this.deps.bridge.reportChangeEnd(jobId, settled);
    if (risky) return { kind: 'failed', code: CHANGE_QUESTION_BLOCKED };
    if (result.status === 'needs_input') return { kind: 'needs_input', question: result.question };
    if (result.status === 'failed') return stop ? { kind: 'cancelled', code: 'aborted' } : { kind: 'failed', code: result.reason };
    if (result.status === 'unknown') return settled.terminal ? { kind: 'failed', code: 'task_worker_lost' } : { kind: 'unknown', code: 'stop_unconfirmed' };
    return { kind: 'unknown', code: result.status === 'limited' ? 'model_limit' : 'auth_expired' };
  }
  private async settled(job: Job, session: SessionRow, result: Exclude<TaskV2TurnResult, { status: 'snapshot' }>, stop?: 'cancel', questionBlocked = false) {
    const settled = await this.deps.bridge.settleChangeTurn(job, session, result, stop, questionBlocked);
    if (settled.terminal) await this.deps.bridge.finalizeChangeSession(job.id).catch(() => {});
    return settled;
  }
  // 저장을 확인한 뒤에만 작업자 결과를 지운다. 저장한 digest를 세션 행에 먼저 남겨, 정리 응답을 잃어도 sweep이 같은 ACK로 다시 보낸다.
  async finalize(receiptId: string): Promise<void> {
    const { job: jobId, generation } = this.parse(receiptId);
    const session = await this.session(jobId, generation);
    if (!session) throw new Error('session_missing');
    if (session.state === 'completed') { await this.deps.bridge.finalizeChangeSession(jobId); return; }
    const key = await this.deps.source.keyOf(jobId);
    const saved = key ? await this.deps.artifacts.load(key) : null;
    if (!saved) throw new Error('artifact_not_saved');
    const job = await this.jobRow(jobId);
    await this.deps.store.atomic(async store => {
      await store.lockTaskControl(job.conversation_id);
      const moved = await store.db.query(`UPDATE codex_sessions SET state='completed',stopped=true,updated_at=$2,capabilities=$3 WHERE job_id=$1 AND generation=$4 AND claude_session_id=$5 AND state='running' RETURNING job_id`,
        [jobId, store.now(), JSON.stringify({ version: TASK_V2_CONTRACT, lane: 'task', tool_approval_relay: false, artifactDigest: saved.artifactDigest }), generation, session.claude_session_id]);
      if (!moved.rows.length) throw new Error('change_session_conflict');
      // lease가 끝났거나 expire()가 먼저 unknown으로 뒀으면 전이가 막힌다. 세션 완료까지 되돌려 결과를 지우지 않고 다시 부를 수 있게 둔다.
      if (!await store.transition(job, 'succeeded', 'change_author_saved')) throw new Error('change_job_not_settled');
      await store.syncTaskLane();
    });
    await this.deps.bridge.finalizeChangeSession(jobId);
  }
  // 재시작으로 lease를 잃은 job을 되찾기 전에 쓴다. 같은 저장소의 작업자가 이 세션을 안다고 답할 때만 known이다. 닿지 않으면 던진다.
  async workerFacts(receiptId: string): Promise<{ known: boolean; stopped: boolean }> {
    const { job, generation } = this.parse(receiptId);
    const session = await this.session(job, generation);
    if (!session) return { known: false, stopped: false };
    const status = await this.deps.bridge.statusOfChange(job, session);
    const sameStorage = session.worker_storage ? status.worker.storage === session.worker_storage : status.state !== 'absent';
    return { known: sameStorage, stopped: sameStorage && status.stopped };
  }
  // 저장하지 않기로 한 결과를 버린다. 부모가 먼저 끝난 경우다. job을 끝내야 세션을 닫고 공간을 지울 수 있다.
  async abandon(receiptId: string): Promise<boolean> {
    const { job: jobId } = this.parse(receiptId);
    const job = await this.jobRow(jobId);
    if (!await this.deps.store.transition(job, 'cancelled', 'change_closed')) return false;
    await this.deps.bridge.closeChangeSession(jobId);
    return true;
  }
  // 시작 요청이 작업자에 닿았는지 끝내 모를 때 쓴다. 취소로 늦게 닿는 시작까지 막고 소멸을 확인한 뒤에만 그 턴을 닫는다. 다시 보내지 않는다.
  async closeUnstarted(receiptId: string): Promise<boolean> {
    const { job: jobId, generation } = this.parse(receiptId);
    const session = await this.session(jobId, generation);
    if (session?.state !== 'running') return false;
    const facts = await this.deps.bridge.cancelChangeTurn(session, jobId);
    if (!facts?.stopped) return false;
    const settled = await this.deps.bridge.settleChangeTurn(await this.jobRow(jobId), session, null);
    this.deps.bridge.reportChangeEnd(jobId, settled);
    if (settled.terminal) await this.deps.bridge.finalizeChangeSession(jobId).catch(() => {});
    return settled.terminal;
  }
  // 검증 port가 같은 세션을 가리키게 한다.
  async verificationControl(key: ChangeKey): Promise<ChangeVerificationControl | null> {
    const jobId = await this.deps.source.authorJob(key);
    const session = jobId ? await this.session(jobId) : undefined;
    if (!jobId || !session?.worker_lease || !session.claude_session_id || !session.generation) return null;
    return { job: jobId, lease: session.worker_lease, generation: session.generation, sessionId: session.claude_session_id,
      worker: session.worker_instance && session.worker_storage ? { instance: session.worker_instance, storage: session.worker_storage } : null };
  }
  async verificationKeepalive(key: ChangeKey): Promise<void> {
    const jobId = await this.deps.source.authorJob(key);
    if (!jobId) return;
    const job = await this.jobRow(jobId);
    await this.deps.store.heartbeat(job);
    // 시험 중 자식 /cancel은 부모가 verifying이라 정리 바퀴가 멈춰 주지 않는다. 시한까지 기다리지 않게 시험을 여기서 멈춘다.
    if ((job as unknown as { state: string }).state !== 'cancel_requested') return;
    const session = await this.session(jobId);
    if (session) await this.deps.bridge.cancelChangeTurn(session, jobId);
  }
  // WorkerChangeVerification에 넘기는 호출 묶음.
  verificationWorker(): ChangeVerificationWorker {
    const call = async (endpoint: '/v2/task/verify' | '/v2/task/verification', control: ChangeVerificationControl, fields: object): Promise<TaskV2VerificationResponse> => {
      const send = async (expectedWorker: TaskWorkerIdentity | null) => {
        const { response } = await this.deps.worker.callV2(endpoint, { version: TASK_V2_CONTRACT, job: control.job, lease: control.lease, generation: control.generation, sessionId: control.sessionId, expectedWorker, ...fields } as never);
        return TASK_V2_ENDPOINTS[endpoint].response.parse(response);
      };
      // fetchResult와 같다. 파드가 바뀌면 instance가 달라 거부되므로 저장소를 대조하는 쪽으로 다시 묻는다. receipt는 볼륨에 남아 있다.
      let reply: TaskV2VerificationResponse;
      try { reply = await send(control.worker); }
      catch (error) {
        if (!(error instanceof TaskWorkerRejected) || !control.worker) throw error;
        reply = await send(null);
      }
      // 다른 저장소의 답은 이 세션의 사실이 아니다.
      if (control.worker && reply.worker.storage !== control.worker.storage) throw new Error('worker_storage_changed');
      return reply;
    };
    return {
      verify: (control, commandId, bundle) => call('/v2/task/verify', control, { commandId, bundle }),
      verification: (control, commandId) => call('/v2/task/verification', control, { commandId }),
    };
  }
}
