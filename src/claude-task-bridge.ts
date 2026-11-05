import { createHash, randomUUID } from 'node:crypto';
import { Denied, PolicyUnavailable, DEFAULTS } from './contracts.js';
import type { Job, Scope } from './contracts.js';
import { bounded } from './format.js';
import type { Policy, PolicyGate } from './policy.js';
import { DRAIN_MS } from './runtime.js';
import type { TaskLane } from './runtime.js';
import type { Store } from './store.js';
import { TaskBridge, TaskWorkerRejected } from './task-bridge.js';
import type { TaskStatus, TaskWorkerPort } from './task-bridge.js';
import { TASK_ENDPOINTS, TASK_INSTRUCTIONS_REVISION, TASK_LIMITS, TASK_RETENTION, taskQuestionId } from './task-contracts.js';
import type { TaskCancelResponse, TaskRequest, TaskResponse, TaskWorkerIdentity } from './task-contracts.js';

// 작업 레인(Claude)의 게시 서버 쪽 턴 조율. 한 run이 /v1/task 한 번, 곧 한 턴이다. 작업자 호출은 TaskWorkerPort로만 한다.
// 결과는 프로세스 소멸 확인을 전제로만 확정하고, 확인을 못 하면 unknown으로 두어 작업 레인의 새 접수를 닫는다.

// 저장소·기준 커밋·프로젝트 정책은 owner의 요청과 현재 정책으로 호출자가 정한다. 재개 때 세션의 고정값과 대조한다.
export interface TaskPlan { repository: string; base: string; project: TaskRequest['project']; limits: TaskRequest['limits'] }
export interface TaskPlanSource { plan(job: Job, policy: Policy, request: string): Promise<TaskPlan> }

export interface ClaudeTaskBridgeOptions {
  monitorMs: number; questionTtlMs: number; answerChars: number; stopWaitMs: number;
  // 정리 실패(cleanup_pending) 재시도 간격. 매 tick 작업자를 부르지 않게 한다.
  finalizeRetryMs: number;
  drainMs: number; shutdown?: AbortSignal;
}
export const CLAUDE_TASK_DEFAULTS: Readonly<ClaudeTaskBridgeOptions> = Object.freeze({ monitorMs: 1000, questionTtlMs: TASK_RETENTION.questionTtlMs,
  answerChars: 2000, stopWaitMs: 15_000, finalizeRetryMs: 30_000, drainMs: DRAIN_MS });

interface SessionRow {
  job_id: string; thread_id: string | null; executor: 'codex' | 'claude'; claude_session_id: string | null; generation: number | null;
  turn: number; tool_calls: number | null; worker_lease: string | null; worker_instance: string | null; worker_storage: string | null;
  repository: string | null; base_sha: string | null; policy_revision: string | null; project_id: string | null; project_revision: string | null;
  run_budget_ms: string | number | null; run_used_ms: string | number; session_retained: boolean; cleanup_state: 'none' | 'pending' | 'cleaned';
  state: string; updated_at: string | number; wait_reason: 'model_limit' | 'auth_expired' | null;
  waiting_since: string | number | null; owner_confirm_requested_at: string | number | null;
  // 턴을 시작할 때만 함께 읽는다. 답했지만 아직 이어 가지 않은 질문이다.
  question_id?: string | null; question_answer?: string | null;
}
type Stop = 'cancel' | 'revoked' | 'lease' | 'timeout' | 'shutdown' | 'monitor';
// 턴의 결말. rejected는 시작하지 않았다는 증거, lost는 응답을 못 받아 시작 여부를 모르는 경우다.
type Turn = { kind: 'response'; response: TaskResponse } | { kind: 'rejected' } | { kind: 'lost' };
type CancelFacts = Pick<TaskCancelResponse, 'stopped' | 'cleanupPending' | 'sessionRetained' | 'worker'>;
interface Facts { stopped: boolean; retained: boolean | null; cleanupPending: boolean; worker: TaskWorkerIdentity | null; tools: number | null }
const TEXT = Object.freeze({
  prefix: 'task', question: '작업 질문', accepted: '답을 받았습니다. 같은 세션을 이어서 실행합니다.',
  blocked: (job: string) => `작업 ${job}의 프로세스 종료를 확인하지 못했습니다(unknown). 다시 실행하지 않고 작업 레인의 새 접수를 닫았습니다. 대화·리뷰는 계속 동작합니다. 작업자 프로세스 0개를 확인한 뒤 /task-release target:${job} 로 해제하세요.`,
});
const digest = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const sameWorker = (expected: TaskWorkerIdentity | null, actual: TaskWorkerIdentity) => !expected
  || (actual.instance === expected.instance && actual.storage === expected.storage);
// 세션의 저장소는 한 번 알면 세대가 끝날 때까지 바뀌지 않는다. 다른 저장소의 답을 적으면 그 저장소의 absent가 옛 세션의 소멸 증명으로 둔갑한다.
// 같은 저장소면 파드 교체만 따라간다. 인자는 text로 캐스팅할 SQL 자리표시자다.
const bindWorker = (instance: string, storage: string) => `worker_instance=CASE WHEN worker_storage IS NULL OR worker_storage=${storage}::text
  THEN COALESCE(${instance}::text,worker_instance) ELSE worker_instance END,worker_storage=COALESCE(worker_storage,${storage}::text)`;

export class ClaudeTaskBridge extends TaskBridge implements TaskLane {
  private readonly options: ClaudeTaskBridgeOptions;
  // 정리 재시도 시각. 잃어도 다음 sweep이 바로 다시 시도할 뿐이라 메모리에 둔다.
  private readonly nextFinalize = new Map<string, number>();
  constructor(store: Store, gate: PolicyGate, private readonly worker: TaskWorkerPort, private readonly plans: TaskPlanSource,
    options: Partial<ClaudeTaskBridgeOptions> = {}) {
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
    } finally { clearInterval(keepalive); }
    await this.dispatch(job, request, revision);
  }
  // 읽어 둔 세션 상태가 그대로일 때만 job을 정리한다. 그 사이 다른 실행이 턴을 시작했으면 그 실행의 job을 건드리지 않는다.
  private async unchanged(job: Job, session: SessionRow | undefined, act: (store: Store) => Promise<unknown>): Promise<void> {
    await this.store.atomic(async store => {
      await store.db.query('SELECT id FROM conversations WHERE id=$1 FOR UPDATE', [job.conversation_id]);
      const now = (await store.db.query<{ state: string; turn: number }>('SELECT state,turn FROM codex_sessions WHERE job_id=$1 FOR UPDATE', [job.id])).rows[0];
      if (session ? now?.state !== session.state || now.turn !== session.turn : !!now) return;
      await act(store);
    });
  }
  private giveUp(job: Job, session: SessionRow | undefined, reason: string): Promise<void> {
    return this.unchanged(job, session, store => this.abandon(job, reason, store));
  }
  // 이번 턴의 요청을 만든다. 띄우지 않기로 했으면 job을 정리하고 undefined.
  private async prepare(job: Job, policy: Policy, session: SessionRow | undefined): Promise<TaskRequest | undefined> {
    const event = (await this.store.db.query<{ payload: { text: string } }>('SELECT payload FROM events WHERE id=$1', [job.event_id])).rows[0]!;
    const plan = await this.plans.plan(job, policy, event.payload.text);
    const waiting = session?.state === 'waiting_answer' || session?.state === 'waiting_model';
    if (session && session.executor !== 'claude' && waiting) { await this.giveUp(job, session, 'task_session_mismatch'); return; }
    if (!waiting) {
      // 앞 세대가 아직 지워지지 않았으면 새 세대를 시작하지 않는다. 보존 칸을 넘기고 옛 공간의 흔적을 잃는다. sweep이 지우면 다시 집힌다.
      if (session?.executor === 'claude' && (session.session_retained || session.cleanup_state === 'pending')) {
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
      status = TASK_ENDPOINTS['/v1/task/status'].response.parse(await this.worker.call('/v1/task/status', this.control(job.id, claude, null)));
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
  // 턴을 세션에 고정한다. 대기→실행 CAS라 같은 세션의 재개가 겹쳐도 하나만 띄운다.
  private async begin(job: Job, request: TaskRequest, session: SessionRow | undefined): Promise<'started' | 'stale' | 'conflict'> {
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
          WHERE codex_sessions.state NOT IN ('running','waiting_answer','waiting_model','unknown')
          AND NOT codex_sessions.session_retained AND codex_sessions.cleanup_state<>'pending' RETURNING job_id`,
        [job.id, request.sessionId, request.repository, JSON.stringify({ version: 1, lane: 'task', tool_approval_relay: false }), now,
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
    try { await this.gate.authorize(job.owner_id, job.target); }
    catch (error) { if (error instanceof Denied) stop = 'revoked'; else if (!(error instanceof PolicyUnavailable)) stop ??= 'monitor'; }
    let terminal = false;
    try { terminal = await this.settle(job, request, revision, turn, facts, stop, this.store.now() - started); }
    catch {
      // 기록 실패는 결과를 모르는 것과 같다. lease가 끝나면 expire()가 unknown으로 둔다.
      await this.store.transition(job, 'unknown', 'record_failed').catch(() => {});
    }
    if (terminal) await this.finalizeJob(job.id).catch(() => {});
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
      return { stopped: r.stopped, retained: r.sessionRetained, cleanupPending: r.cleanupPending, worker: r.worker, tools: r.usage.toolCalls };
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
  // 소멸 확인. 작업자가 답하지 않거나 그 턴을 띄운 작업자가 아니면 확인하지 못한 것이다.
  private async cancelTurn(body: { version: 1; job: string; lease: string; generation: number; sessionId: string; expectedWorker: TaskWorkerIdentity | null }): Promise<CancelFacts | null> {
    let wait: ReturnType<typeof setTimeout> | undefined;
    try {
      return await Promise.race([
        this.worker.call('/v1/task/cancel', TASK_ENDPOINTS['/v1/task/cancel'].request.parse(body)).then(raw => {
          const response = TASK_ENDPOINTS['/v1/task/cancel'].response.parse(raw);
          return sameWorker(body.expectedWorker, response.worker) ? response : null;
        }),
        new Promise<null>(resolve => { wait = setTimeout(() => resolve(null), this.options.stopWaitMs); }),
      ]);
    } catch { return null; } finally { clearTimeout(wait); }
  }
  // 턴 결과를 한 트랜잭션으로 확정한다. 돌려주는 값은 세션을 지울 차례인지다.
  private async settle(job: Job, request: TaskRequest, revision: string, turn: Turn, facts: Facts, stop: Stop | undefined, usedMs: number): Promise<boolean> {
    return this.store.atomic(async store => {
      await store.lockTaskControl(job.conversation_id);
      const row = (await store.db.query<{ state: string; lease_token: string; lease_until: string }>(
        'SELECT state,lease_token,lease_until FROM jobs WHERE id=$1 FOR UPDATE', [job.id])).rows[0]!;
      // 다른 실행이 넘겨받았으면 이 응답은 어떤 행도 바꾸지 못한다. 세션 갱신도 lease로 막힌다.
      if (row.lease_token !== job.lease_token) { await store.audit('task_stale_response', job.id, { generation: request.generation, turn: request.turn }); return false; }
      const session = async (state: string, wait: { reason: 'model_limit' | 'auth_expired' } | null = null) => {
        await store.db.query(`UPDATE codex_sessions SET state=$2,updated_at=$3,run_used_ms=run_used_ms+$4,
          tool_calls=CASE WHEN $5::integer IS NULL OR tool_calls IS NULL THEN NULL ELSE tool_calls+$5::integer END,
          ${bindWorker('$6', '$7')},stopped=$8,
          session_retained=COALESCE($9,session_retained),cleanup_state=CASE WHEN $10::boolean THEN 'pending' ELSE cleanup_state END,
          wait_reason=$11,waiting_since=$12,owner_confirm_requested_at=NULL
          WHERE job_id=$1 AND worker_lease=$13 AND generation=$14 AND claude_session_id=$15`,
        [job.id, state, store.now(), Math.max(0, usedMs), facts.tools, facts.worker?.instance ?? null, facts.worker?.storage ?? null, facts.stopped ? true : null,
          facts.retained, facts.cleanupPending, wait?.reason ?? null, wait ? store.now() : null, request.lease, request.generation, request.sessionId]);
      };
      const end = async (state: string) => { await session(state); await store.syncTaskLane(); };
      const fail = async (reason: string) => { await end('failed'); await store.fail(job, reason); return true; };
      const leaseLost = stop === 'lease' || Number(row.lease_until) <= store.now();
      if (stop === 'revoked') {
        await session(facts.stopped ? 'cancelled' : 'unknown');
        await store.transition(job, facts.stopped ? 'cancelled' : 'unknown', 'authorization_revoked');
        await store.syncTaskLane();
        return facts.stopped;
      }
      if (stop === 'cancel' || row.state === 'cancel_requested') {
        await session(facts.stopped ? 'cancelled' : 'unknown');
        await store.transition(job, facts.stopped ? 'cancelled' : 'unknown', 'stop_confirmation');
        if (!facts.stopped) await this.blocked(job, revision, store);
        await store.syncTaskLane();
        return facts.stopped;
      }
      // lease를 잃었으면 다른 기록이 이 작업을 넘겨받았을 수 있어 종료 확인과 무관하게 unknown이다.
      if (!facts.stopped || leaseLost) {
        await session('unknown');
        await store.transition(job, 'unknown', leaseLost ? 'task_lease' : stop === 'shutdown' ? 'publisher_shutdown'
          : turn.kind === 'response' ? 'task_unknown' : 'task_worker_lost');
        await this.blocked(job, revision, store);
        await store.syncTaskLane();
        return false;
      }
      if (turn.kind === 'rejected') return fail('task_worker_rejected');
      if (stop) return fail(`task_${stop}`);
      if (turn.kind === 'lost') return fail('task_worker_lost');
      const response = turn.response;
      if (response.status === 'failed') return fail(`task_${response.reason}`);
      if (response.status === 'limited' || response.status === 'auth_expired') {
        const reason = response.status === 'limited' ? 'model_limit' : 'auth_expired';
        // 계정 한도는 대화·리뷰도 같은 계정이라 양쪽을 막고, 인증 만료는 레인 토큰의 일이라 작업 레인만 막는다.
        await store.waitForUser(job, reason, { laneOnly: reason === 'auth_expired' });
        const now = (await store.db.query<{ state: string; attempt: number }>('SELECT state,attempt FROM jobs WHERE id=$1', [job.id])).rows[0]!;
        if (now.state !== 'waiting_user') { await end('cancelled'); return true; }
        await session('waiting_model', { reason });
        await store.syncTaskLane();
        // 그 턴이 나르던 답은 처리되지 않았다. /resume-model 뒤 같은 답으로 잇는다.
        if (request.operation === 'resume' && request.questionId) await store.db.query("UPDATE codex_questions SET state='answered' WHERE id=$1 AND state='resumed'", [request.questionId]);
        const resumable = Number(now.attempt) < DEFAULTS.maxRetries + 1;
        await store.enqueue({ key: `task-wait:${job.id}:${job.attempt}`, job: job.id, conversation: job.conversation_id, actor: job.owner_id, scope: job.target, revision,
          payload: { kind: 'message', channel: job.target.channel, classification: 'safe_summary',
            content: `작업 ${job.id}이 ${reason === 'model_limit' ? '모델 사용 한도로 멈췄습니다. 같은 계정을 쓰는 대화·리뷰도 함께 멈춥니다' : '작업 레인 인증 만료로 멈췄습니다. 대화·리뷰는 계속 동작합니다'}. 다른 계정·인증으로 바꾸지 않습니다. `
              + (resumable ? `원인을 해소한 뒤 /resume-model target:${job.id} 로 재개하거나 /cancel 하세요.` : '재시도 한도에 닿아 재개할 수 없습니다. /cancel 뒤 새 작업으로 요청하세요.') } });
        return false;
      }
      if (response.status === 'needs_input') {
        const waiting = await this.ask(job, revision, taskQuestionId(job.id, request.sessionId, request.turn), request.sessionId, request.turn, response.question, store);
        await end(waiting ? 'waiting_answer' : 'cancelled');
        return !waiting;
      }
      if (response.status !== 'completed') throw new Error('unexpected_status');
      const result = { summary: response.summary, changes: response.changes, patch: response.patch, verification: response.verification };
      const resultDigest = digest(result);
      const verified = response.verification.reduce((sum, item) => ({ ...sum, [item.status]: sum[item.status] + 1 }), { passed: 0, failed: 0, not_run: 0 });
      await store.finish(job, result, { source: 'task_worker', sessionId: request.sessionId, generation: request.generation, turns: request.turn,
        worker: response.worker, stopConfirmed: true, diff: 'worker_computed', usage: response.usage, resultDigest },
      [`작업 완료 (작업 ${job.id})`, bounded(response.summary || '요약 없음', TASK_LIMITS.summaryChars),
        `변경 파일(작업자 diff 기준): ${response.changes.total}개`,
        `검증: 통과 ${verified.passed} · 실패 ${verified.failed} · 미실행 ${verified.not_run}`].join('\n'), job.target);
      const after = (await store.db.query<{ state: string }>('SELECT state FROM jobs WHERE id=$1', [job.id])).rows[0]!;
      await end(after.state === 'succeeded' ? 'completed' : 'cancelled');
      return true;
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
          WHERE s.job_id=$1 AND j.id=s.job_id AND s.state IN ('running','waiting_answer','waiting_model') AND j.state IN ('succeeded','failed','cancelled','superseded')`, [row.job_id, store.now()]);
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
        const marked = await store.db.query(`UPDATE codex_sessions SET owner_confirm_requested_at=$2,updated_at=$2 WHERE job_id=$1 AND state='waiting_model'
          AND owner_confirm_requested_at IS NULL AND waiting_since<=$3 RETURNING job_id`, [job.id, store.now(), due]);
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
      const status = TASK_ENDPOINTS['/v1/task/status'].response.parse(await this.worker.call('/v1/task/status', this.control(jobId, session, null)));
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
        // 대기 세션의 정리 완료는 세션을 지우지 않고 막힘만 푼다.
        await store.db.query(`UPDATE codex_sessions SET cleanup_state=$2,updated_at=$3 WHERE job_id=$1 AND cleanup_state='pending' AND generation=$4 AND claude_session_id=$5`,
          [jobId, waitingClean ? 'none' : 'pending', store.now(), session.generation, session.claude_session_id]);
      } else {
        // 작업자에 묻는 사이 새 세대가 시작했으면 이 결론은 그 세션의 것이 아니다.
        await store.db.query(`UPDATE codex_sessions SET cleanup_state=$2,session_retained=CASE WHEN $3::boolean THEN false ELSE session_retained END,
          stopped=CASE WHEN $3::boolean THEN true ELSE stopped END,${bindWorker('$4', '$5')},updated_at=$6 WHERE job_id=$1 AND generation=$7 AND claude_session_id=$8`,
        [jobId, cleaned ? 'cleaned' : 'pending', cleaned, identity?.instance ?? null, identity?.storage ?? null, store.now(), session.generation, session.claude_session_id]);
      }
      await store.syncTaskLane();
    });
    if (cleaned || waitingClean) this.nextFinalize.delete(jobId);
  }
  private async finalizeTurn(job: string, session: SessionRow, worker: TaskWorkerIdentity): Promise<boolean> {
    const outcome = session.state === 'completed' ? 'succeeded' : session.state === 'cancelled' ? 'cancelled' : 'failed';
    const digestRow = outcome === 'succeeded' ? (await this.store.db.query<{ digest: string | null }>(`SELECT evidence->>'resultDigest' AS digest FROM results WHERE job_id=$1`, [job])).rows[0] : undefined;
    const body = TASK_ENDPOINTS['/v1/task/finalize'].request.parse({ ...this.control(job, session, worker), disposition: 'terminal',
      receipt: { outcome, persistedAt: Number(session.updated_at), resultDigest: digestRow?.digest ?? null } });
    const response = TASK_ENDPOINTS['/v1/task/finalize'].response.parse(await this.worker.call('/v1/task/finalize', body));
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
    const session = (await this.store.db.query<SessionRow>(`SELECT * FROM codex_sessions WHERE job_id=$1 AND executor='claude'`, [jobId])).rows[0];
    if (job.state !== 'unknown' && session?.state !== 'unknown') return { ok: false, status: '종료를 확인하지 못한(unknown) 작업이 아닙니다.' };
    // 세션이 없으면 작업자에 보낸 적이 없다.
    const stopped = session ? await this.confirmStopped(jobId, session) : true;
    if (!stopped) return { ok: false, status: '작업자 프로세스가 남아 있거나 확인할 수 없습니다. 작업자 파드를 다시 만든 뒤 확인하세요.' };
    const changed = await this.store.atomic(async store => {
      await store.lockTaskControl(job.conversation_id);
      const row = (await store.db.query(`UPDATE jobs SET state='cancelled',wait_reason='stop_confirmed_after_unknown',finished_at=$2
        WHERE id=$1 AND state='unknown' RETURNING id`, [jobId, store.now()])).rows[0];
      const moved = await store.db.query(`UPDATE codex_sessions SET state='cancelled',stopped=true,updated_at=$2 WHERE job_id=$1 AND state IN ('unknown','running') RETURNING job_id`, [jobId, store.now()]);
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
      const body = TASK_ENDPOINTS['/v1/task/cancel'].request.parse(this.control(job, session, expected));
      const response = TASK_ENDPOINTS['/v1/task/cancel'].response.parse(await this.worker.call('/v1/task/cancel', body));
      return response.stopped && (!session.worker_storage || response.worker.storage === session.worker_storage);
    } catch (error) {
      if (!(error instanceof TaskWorkerRejected) || !session.worker_storage) return false;
    }
    // 파드가 바뀌어 옛 identity의 취소가 거부됐다. 같은 저장소의 새 작업자가 소멸을 말해 주면 그 값을 쓴다.
    try {
      const status = TASK_ENDPOINTS['/v1/task/status'].response.parse(await this.worker.call('/v1/task/status', this.control(job, session, null)));
      return status.stopped && status.worker.storage === session.worker_storage;
    } catch { return false; }
  }
}
