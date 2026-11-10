import { randomUUID } from 'node:crypto';
import { CHANGE_RESTART, changeNextGeneration } from './change-advice.js';
import { evaluateCi, readCiSnapshot } from './change-ci-policy.js';
import { isTerminalPhase, labelAllowsAuthorInput, ReasonCodeSchema } from './change-contracts.js';
import { scanPublicText } from './change-publication.js';
import { ChangeReviewFailed, ChangeReviewRejected } from './change-review.js';
import type { ChangeArtifactPort, ChangeDeploymentPort, ChangeKey, ChangePhase, ChangeTarget, ChangeVerificationPort, DeploymentObservation, MergeReading, ProvenanceLabel, ReviewReceipt, TerminalChangePhase } from './change-contracts.js';
import { DEPLOYMENT_POLL, DeploymentTargetError, deploymentPollStep, describeDeployment } from './change-deployment.js';
import { compilePathPolicy, taskPathRules } from './change-policy.js';
import type { ChangeRepositoryPolicy } from './change-policy.js';
import { parseChangeRequest, publishButton } from './change-commands.js';
import type { ChangePublisher } from './change-publisher.js';
import type { ChangeReviewService } from './change-review.js';
import type { ChangePrivateInputs, ChangeRequest, ChangeStore } from './change-store.js';
import { purgeExpiredChangeContentRounds } from './change-store.js';
import type { ChangeAuthorSource, ClaudeChangeAuthor } from './claude-task-bridge.js';
import { DEFAULTS, Denied, PolicyUnavailable } from './contracts.js';
import type { Job } from './contracts.js';
import type { ChangePreflightPort } from './github-writer.js';
import { errorInfo } from './log.js';
import type { Log } from './log.js';
import type { PolicyGate } from './policy.js';
import type { OutboxButton, Store } from './store.js';
import { TaskWorkerBusy } from './task-bridge.js';
import { DEFAULT_LIMITS } from './task-policy.js';

// 부모 change의 phase를 port 호출로 한 걸음씩 밀어 준다. 부모는 슬롯을 잡지 않고 모델 실행만 자식 job이다.
// 프로세스 상태가 없다. 시각·재시도 간격만 메모리에 두고, 재시작하면 DB의 phase에서 이어 간다. 그래서 응답을 잃어도 모델을 다시 돌리는 길이 없다.
// 호출 순서: fetchResult → artifacts.save → verification.run·recordVerification → finalize. finalize 뒤에는 시험할 결과가 작업자에 없다.

export const CHANGE_PERIODS = Object.freeze({
  // 작업자 호출마다 서명 nonce가 볼륨에 남고 lease는 30초다. 몇 초에 한 번이면 lease가 끊기지 않는다.
  authorPollMs: 5000,
  // GitHub 익명 읽기는 IP당 시간 60회다. 사람의 병합을 몇 시간씩 기다리는 건이 그 몫을 다 쓰지 않게 길게 둔다.
  mergePollMs: 300_000,
  // 시작 요청이 닿았는지 모르는 채로 레인을 잡아 둘 수 있는 시간. 작업자는 접수를 바로 답하므로 이 안에 결론이 난다.
  startGraceMs: 120_000,
  reconcileMs: 300_000,
  retentionMs: 3_600_000,
  failureBackoffMs: 5000,
  failureBackoffMaxMs: 600_000,
});
export type ChangePeriods = Record<keyof typeof CHANGE_PERIODS, number>;
// 끝난 부모에게 알리는 시효. 재시작 때 지난 건을 몰아 보내지 않는다.
const NOTICE_WINDOW_MS = 7 * 86_400_000;
const LANE_PHASES = ['requested', 'admitted', 'authoring', 'snapshot_ready', 'verifying'] as const;
const PUBLISH_PHASES = ['reviewing', 'approved', 'publishing', 'proposed', 'merged', 'observing_deploy'] as const;
const NOTICE_PHASES = ['awaiting_publish_approval', 'proposed', 'superseded', 'blocked', 'cancelled', 'failed'] as const;
const STEP_BATCH = 32;
// 다시 할 일이 없는 관측이다. 알림은 따로 고르므로 바퀴에서 빼도 빠지지 않는다.
const OBSERVATION_FINISHED = `r.phase='observing_deploy' AND (
  EXISTS (SELECT 1 FROM change_deployments d WHERE d.change_id=r.id AND d.generation=r.generation AND d.state IN ('observed','not_applicable','blocked'))
  OR EXISTS (SELECT 1 FROM change_deployment_windows w WHERE w.change_id=r.id AND w.generation=r.generation AND w.late_reported_at IS NOT NULL))`;

type Cursor = { at: number; id: string };
type PageRow = { id: string; order_at: string | number };
type Outcome = { to: TerminalChangePhase; reason: string };
const safeReason = (code: string, fallback = 'change_failed') => ReasonCodeSchema.safeParse(code).success ? code : fallback;
const keyOf = (request: Pick<ChangeRequest, 'id' | 'generation'>): ChangeKey => ({ changeId: request.id, generation: request.generation });

export interface ChangeRepositoryPolicies { (repoId: number): Promise<ChangeRepositoryPolicy | null> }
// 증거 묶음의 policy revision은 실행 정책의 revision 하나다. 작성 세션·시험·리뷰·게시가 모두 이 값으로 대조한다. 저장소 절의 revision은 작업 프로젝트 revision으로 쓴다.
export function changeRepositoryPolicies(gate: PolicyGate): ChangeRepositoryPolicies {
  return async repoId => {
    const policy = await gate.current();
    const repository = policy.change?.repositories.find(item => item.repoId === repoId);
    return repository ? { ...repository, revision: policy.revision } : null;
  };
}

// 저장소 정책을 작업 레인 형식으로 내린다. 의미는 taskPathRules가 잇고 최종 판정은 게시 서버가 원래 glob으로 다시 한다.
export function changeTaskProject(policy: ChangeRepositoryPolicy, projectRevision: string) {
  const compiled = compilePathPolicy(policy.allowedPaths, policy.deniedPaths);
  if (!compiled.ok) throw new Error('policy_glob_invalid');
  const rules = taskPathRules(compiled.policy);
  return { id: `change-${policy.repoId}`, revision: projectRevision, allowedPaths: rules.allowedPaths, forbiddenPaths: rules.forbiddenPaths, verifyCommands: [...policy.requiredCommands] };
}

export function changeAuthorSource(deps: { store: Store; gate: PolicyGate; preflight: Pick<ChangePreflightPort, 'readTreeLeaves'>; policy: ChangeRepositoryPolicies }): ChangeAuthorSource {
  const db = deps.store.db;
  const claimed = async (jobId: string): Promise<Job | null> =>
    (await db.query<Job>(`SELECT * FROM jobs WHERE id=$1 AND state='running' AND lease_until>$2`, [jobId, deps.store.now()])).rows[0] ?? null;
  const keyOfJob = async (jobId: string): Promise<ChangeKey | null> => {
    const row = (await db.query<{ change_id: string; generation: number | string }>(`SELECT change_id,generation FROM change_child_jobs WHERE job_id=$1 AND role='author'`, [jobId])).rows[0];
    return row ? { changeId: row.change_id, generation: Number(row.generation) } : null;
  };
  const authorJob = async (key: ChangeKey): Promise<string | null> =>
    (await db.query<{ job_id: string }>(`SELECT job_id FROM change_child_jobs WHERE change_id=$1 AND generation=$2 AND role='author'`, [key.changeId, key.generation])).rows[0]?.job_id ?? null;
  const repoOf = async (changeId: string): Promise<ChangeRepositoryPolicy> => {
    const row = (await db.query<{ repo_id: number | string }>('SELECT repo_id FROM change_requests WHERE id=$1', [changeId])).rows[0];
    const policy = row ? await deps.policy(Number(row.repo_id)) : null;
    if (!policy) throw new Error('policy_revoked');
    return policy;
  };
  const settingsFor = async (policy: ChangeRepositoryPolicy) => {
    const current = await deps.gate.current();
    const own = current.change?.repositories.find(item => item.repoId === policy.repoId);
    return { project: changeTaskProject(policy, own?.revision ?? policy.revision), limits: { ...DEFAULT_LIMITS } };
  };
  return {
    claimed, authorJob, keyOf: keyOfJob,
    async questionRisk(jobId, question) {
      const key = await keyOfJob(jobId);
      const row = key ? (await db.query<{ repo_id: number | string }>('SELECT repo_id FROM change_requests WHERE id=$1', [key.changeId])).rows[0] : undefined;
      const policy = row ? await deps.policy(Number(row.repo_id)) : null;
      // 내부 표식을 볼 수 없으면 공개해도 되는 글이라고 말할 수 없다. 정책을 잠시 못 읽는 예외는 그대로 올라가 다음 바퀴에 다시 본다.
      if (!policy) return 'policy_revoked';
      return scanPublicText({ title: question, body: question }, policy);
    },
    async plan(input) {
      const jobId = await authorJob(input.target.key);
      const job = jobId ? await claimed(jobId) : null;
      if (!job) throw new Error('change_job_not_claimed');
      const policy = await repoOf(input.target.key.changeId);
      const leaves = await deps.preflight.readTreeLeaves({ target: input.target, sha: input.baseTree });
      if (!leaves?.complete) throw new Error('base_tree_incomplete');
      return { job, repository: policy.fullName, ...await settingsFor(policy), baseline: leaves.leaves };
    },
    async settings(jobId) {
      const key = await keyOfJob(jobId);
      if (!key) throw new Error('change_job_not_linked');
      return settingsFor(await repoOf(key.changeId));
    },
  };
}

export interface ChangeRuntimeDeps {
  store: Store; changes: ChangeStore; inputs: Pick<ChangePrivateInputs, 'read'>; gate: PolicyGate;
  author: Pick<ClaudeChangeAuthor, 'supportsV2' | 'start' | 'resume' | 'cancel' | 'fetchResult' | 'finalize' | 'workerFacts' | 'abandon' | 'closeUnstarted'>;
  artifacts: ChangeArtifactPort; verification: ChangeVerificationPort;
  review: Pick<ChangeReviewService, 'submit' | 'fetchReceipt'>;
  publisher: Pick<ChangePublisher, 'prepareApproval' | 'publish' | 'reconcile'>;
  preflight: ChangePreflightPort; deployment: ChangeDeploymentPort; policy: ChangeRepositoryPolicies;
  // 작업자가 새 실행을 받는 중인지. 닫혀 있는데 claim하면 시작 불명 상태로 레인을 잡는다.
  intakeOpen: () => boolean;
  log: Log; verifierRevision: string; periods?: Partial<ChangePeriods>;
}
interface ChildRow {
  id: string; state: string; wait_reason: string | null; lease_token: string | null; lease_until: string | null; conversation_id: string; owner_id: string;
  session_state: string | null; session_generation: number | null; session_updated_at: string | null;
}
const WAITING_SESSION = new Set(['waiting_answer', 'waiting_model']);
const JOB_ENDED = new Set(['succeeded', 'failed', 'cancelled', 'superseded']);
const receiptOf = (child: Pick<ChildRow, 'id' | 'session_generation'>) => `v2:${child.id}:${child.session_generation}`;
// 작업자가 고칠 수 없는 입력·경계 문제를 말한 경우다. 내부 실패(failed)와 구분해 owner가 사유를 읽게 둔다.
const blockedAuthorCode = (code: string) => /^(artifact_|baseline_|label_|task_artifact_|task_baseline_|task_question_)/.test(code);
// prepareApproval이 돌려주는 값 중 다시 해도 같은 것들. 그 밖의 읽기 실패는 다음 바퀴에 다시 본다.
const FINAL_APPROVAL = /^(label_blocked|review_mismatch|review_incomplete|policy_revoked|policy_changed|publication_|secret_detected|internal_marker|metadata_sensitive|base_tree_incomplete|evidence_missing|ci_(?!unreadable))/;

export class ChangeRuntime {
  private readonly periods: ChangePeriods;
  // 재시도 시각과 연속 실패 수. 잃어도 다음 바퀴가 바로 다시 볼 뿐이라 메모리에 둔다.
  private readonly nextAt = new Map<string, number>();
  private readonly failures = new Map<string, number>();
  private readonly cursors = new Map<string, Cursor>();
  private readonly now: () => number;
  constructor(private readonly deps: ChangeRuntimeDeps) {
    this.periods = { ...CHANGE_PERIODS, ...deps.periods };
    this.now = deps.store.now;
  }
  private get db() { return this.deps.store.db; }
  private due(slot: string): boolean { return (this.nextAt.get(slot) ?? 0) <= this.now(); }
  private wait(slot: string, ms: number): void { this.nextAt.set(slot, this.now() + ms); }

  // 작성·검증 쪽 한 바퀴. 작업자 슬롯이 하나라 이 안의 긴 시험 대기가 다른 부모를 늦춰도 잃는 것이 없다.
  async laneTick(): Promise<boolean> {
    let busy = false;
    for (const request of await this.requests(LANE_PHASES)) {
      if (await this.guarded(request, () => this.laneStep(request))) busy = true;
    }
    return busy;
  }
  // 리뷰·게시·병합·배포 쪽 한 바퀴. 승인이나 사람의 병합을 기다리는 부모는 여기서 읽기만 하고 슬롯을 잡지 않는다.
  async publishTick(): Promise<boolean> {
    let busy = false;
    for (const request of await this.requests(PUBLISH_PHASES)) {
      if (await this.guarded(request, () => this.publishStep(request))) busy = true;
    }
    await this.sendNotices();
    return busy;
  }
  // 게시 대조. 응답을 잃은 effect를 정확한 값과 맞추고 기한 넘은 unknown을 사람 해소로 넘긴다. 승인·게시 중인 건도 이어 간다.
  reconcile() { return this.deps.publisher.reconcile(); }
  retention(): Promise<number> { return purgeExpiredChangeContentRounds(this.db, this.now()); }

  // 사람의 병합·답을 기다리거나 일시 오류로 머무는 행은 시각이 그대로라 앞자리를 계속 차지한다. 정렬값과 ID의 커서로 한 쪽씩 돌아 뒤의 행도 차례를 받게 한다.
  // 쪽이 차지 않으면 끝까지 본 것이라 처음으로 돌아간다. 커서를 잃어도 처음부터 다시 볼 뿐이다.
  private async page<T extends PageRow>(name: string, read: (after: Cursor) => Promise<T[]>): Promise<T[]> {
    const rows = await read(this.cursors.get(name) ?? { at: -1, id: '' });
    const last = rows.at(-1);
    if (rows.length < STEP_BATCH || !last) this.cursors.delete(name);
    else this.cursors.set(name, { at: Number(last.order_at), id: last.id });
    return rows;
  }
  private async requests(phases: readonly ChangePhase[]): Promise<ChangeRequest[]> {
    const rows = await this.page(`requests:${phases.join()}`, async after => (await this.db.query<PageRow>(`SELECT r.id,r.updated_at AS order_at FROM change_requests r
      WHERE r.phase=ANY($1::text[]) AND NOT (${OBSERVATION_FINISHED}) AND (r.updated_at,r.id)>($2::bigint,$3::text) ORDER BY r.updated_at,r.id LIMIT $4`, [phases, after.at, after.id, STEP_BATCH])).rows);
    const found: ChangeRequest[] = [];
    for (const row of rows) {
      const request = await this.deps.changes.get(row.id);
      if (request.ok) found.push(request.value);
    }
    return found;
  }
  // 한 부모의 오류가 다른 부모를 막지 않는다. 일시 오류로 부모를 닫지 않고 간격을 늘려 다시 본다.
  private async guarded(request: ChangeRequest, step: () => Promise<boolean>): Promise<boolean> {
    const slot = `step:${request.id}`;
    if (!this.due(slot)) return false;
    try {
      const busy = await step();
      this.failures.delete(slot);
      return busy;
    } catch (error) {
      const count = (this.failures.get(slot) ?? 0) + 1;
      this.failures.set(slot, count);
      this.wait(slot, Math.min(this.periods.failureBackoffMaxMs, this.periods.failureBackoffMs * 2 ** Math.min(count - 1, 10)));
      this.deps.log('change_step_failed', { phase: request.phase, attempt: count, ...errorInfo(error) });
      return false;
    }
  }
  private async close(request: Pick<ChangeRequest, 'id' | 'generation'>, from: ChangePhase, outcome: Outcome): Promise<void> {
    const reason = safeReason(outcome.reason);
    const moved = await this.deps.changes.transition({ ...keyOf(request), from, to: outcome.to, reason });
    if (moved.ok) { this.deps.log('change_closed', { from, to: outcome.to, reason }); return; }
    // 다른 경로가 먼저 옮겼으면 그 결과가 맞다. 잠금 시한 초과는 다시 본다.
    if (moved.reason === 'busy') throw new Error('change_store_busy');
    if (moved.reason !== 'phase_conflict') this.deps.log('change_close_failed', { from, to: outcome.to, reason: moved.reason });
  }
  // 권한이 철회됐으면 새 모델 실행·공개 효과 전에 닫는다. 정책을 못 읽으면 이번 바퀴만 건너뛴다.
  private async authorized(request: ChangeRequest): Promise<boolean> {
    try { await this.deps.gate.authorize(request.ownerId, request.scope); return true; }
    catch (error) {
      if (error instanceof Denied) { await this.close(request, request.phase, { to: 'cancelled', reason: 'authorization_revoked' }); return false; }
      if (error instanceof PolicyUnavailable) return false;
      throw error;
    }
  }
  private target(request: Pick<ChangeRequest, 'id' | 'generation' | 'repoId'>): ChangeTarget { return { key: keyOf(request), repoId: request.repoId }; }

  // ---- 접수 ----

  // 명령이 부르고, 명령 처리 중에 끊겼거나 새 generation을 열었으면 바퀴가 부른다. 입력 원문에서 다시 만들므로 같은 결과다.
  async admit(request: ChangeRequest): Promise<{ ok: true } | { ok: false; reason: string }> {
    const key = keyOf(request);
    const input = (await this.deps.inputs.read({ changeId: request.id })).find(row => row.eventId === request.eventId);
    const parsed = input ? parseChangeRequest(input.text) : null;
    const policy = await this.deps.policy(request.repoId);
    if (!policy) { await this.close(request, 'requested', { to: 'blocked', reason: 'policy_revoked' }); return { ok: false, reason: 'policy_revoked' }; }
    if (!parsed?.ok || !policy.baseBranches.includes(request.baseBranch)) { await this.close(request, 'requested', { to: 'blocked', reason: 'request_invalid' }); return { ok: false, reason: 'request_invalid' }; }
    const brief = { summary: parsed.value.summary, goal: parsed.value.goal, acceptanceCriteria: parsed.value.acceptance, repoId: request.repoId, baseBranch: request.baseBranch,
      allowedPaths: [...policy.allowedPaths], deniedPaths: [...policy.deniedPaths], verificationCommandIds: [...policy.requiredCommands], label: request.label };
    const admitted = await this.deps.changes.admit({ ...key, brief, policyRevision: policy.revision });
    if (admitted.ok) return { ok: true };
    if (admitted.reason === 'invalid_input') await this.close(request, 'requested', { to: 'blocked', reason: 'request_invalid' });
    if (admitted.reason === 'busy') throw new Error('change_store_busy');
    return { ok: false, reason: admitted.reason };
  }
  // B와 T0를 고정한다. CI 형태도 여기서 본다. 승인되지 않은 형태면 모델을 한 번도 부르지 않고 닫아 값을 로그로 알린다.
  private async pin(request: ChangeRequest): Promise<boolean> {
    if (!await this.deps.author.supportsV2()) { this.wait(`step:${request.id}`, 30_000); return false; }
    const policy = await this.deps.policy(request.repoId);
    if (!policy) { await this.close(request, 'admitted', { to: 'blocked', reason: 'policy_revoked' }); return true; }
    const target = this.target(request);
    const head = await this.deps.preflight.readBranchHead({ target, branch: request.baseBranch });
    if (!head) { await this.close(request, 'admitted', { to: 'blocked', reason: 'base_branch_missing' }); return true; }
    const commit = await this.deps.preflight.readCommit({ target, sha: head.sha });
    if (!commit) throw new Error('base_commit_unreadable');
    const leaves = await this.deps.preflight.readTreeLeaves({ target, sha: commit.treeSha });
    if (!leaves) throw new Error('base_tree_unreadable');
    if (!leaves.complete) { await this.close(request, 'admitted', { to: 'blocked', reason: 'base_tree_incomplete' }); return true; }
    const snapshot = await readCiSnapshot(this.deps.preflight, target, leaves.leaves, policy.ci);
    if (!snapshot) throw new Error('ci_unreadable');
    const ci = evaluateCi(snapshot, policy.ci);
    if (!ci.ok) {
      if (ci.fingerprint) this.deps.log('change_ci_fingerprint_unapproved', { fingerprint: ci.fingerprint });
      await this.close(request, 'admitted', { to: 'blocked', reason: ci.reason });
      return true;
    }
    const pinned = await this.deps.changes.pinBase({ ...keyOf(request), baseCommit: head.sha, baseTree: commit.treeSha });
    if (!pinned.ok && pinned.reason === 'busy') throw new Error('change_store_busy');
    return pinned.ok;
  }

  // ---- 작성 ----

  // job과 부모 연결을 한 트랜잭션으로 만든다. 연결 없는 job이 남으면 v1 경로가 집는다.
  private async authorChild(request: ChangeRequest): Promise<ChildRow> {
    const read = async () => (await this.db.query<ChildRow>(`SELECT j.id,j.state,j.wait_reason,j.lease_token,j.lease_until,j.conversation_id,j.owner_id,s.state AS session_state,s.generation AS session_generation,s.updated_at AS session_updated_at
      FROM change_child_jobs c JOIN jobs j ON j.id=c.job_id LEFT JOIN codex_sessions s ON s.job_id=j.id AND s.executor='claude'
      WHERE c.change_id=$1 AND c.generation=$2 AND c.role='author'`, [request.id, request.generation])).rows[0];
    const existing = await read();
    if (existing) return existing;
    await this.db.transaction(async tx => {
      const parent = (await tx.query<{ phase: string; generation: number | string }>('SELECT phase,generation FROM change_requests WHERE id=$1 FOR UPDATE', [request.id])).rows[0];
      if (!parent || Number(parent.generation) !== request.generation || parent.phase !== 'authoring') throw new Error('change_parent_moved');
      if ((await tx.query(`SELECT 1 FROM change_child_jobs WHERE change_id=$1 AND generation=$2 AND role='author'`, [request.id, request.generation])).rows.length) return;
      if (await this.deps.store.queueFull('task', tx)) throw new Error('queue_full');
      const now = this.now();
      const job = randomUUID(), event = randomUUID();
      const delivery = `change-author:${request.id}:${request.generation}`;
      // 작성자 입력은 공개 brief뿐이다. 이 행에는 원문이 없고 행위자도 owner가 아니라 대화 맥락에 끼지 않는다.
      await tx.query(`INSERT INTO events(id,provider,delivery_id,semantic_key,actor_id,scope,conversation_id,received_at,payload,accepted)
        VALUES ($1,'change',$2,$2,'change-author',$3,$4,$5,$6,true)`, [event, delivery, JSON.stringify(request.scope), request.conversationId, now, JSON.stringify({ command: 'change_author', text: '' })]);
      await tx.query(`INSERT INTO jobs(id,event_id,conversation_id,type,owner_id,target,revision,budget,priority,available_at,created_at)
        VALUES ($1,$2,$3,'task',$4,$5,$6,$7,30,$8,$8)`, [job, event, request.conversationId, request.ownerId, JSON.stringify(request.scope), JSON.stringify({ policy: request.policyRevision }),
        JSON.stringify({ timeoutMs: DEFAULTS.taskTimeoutMs, toolCalls: DEFAULTS.maxToolCalls }), now]);
      await tx.query(`INSERT INTO change_child_jobs(job_id,change_id,generation,role,created_at) VALUES ($1,$2,$3,'author',$4)`, [job, request.id, request.generation, now]);
    });
    return (await read())!;
  }
  private async authoring(request: ChangeRequest): Promise<boolean> {
    const child = await this.authorChild(request);
    // 턴을 보내기 전에 lease가 끝났다. 작업자에 프로세스가 없으니 다시 줄을 세운다.
    if (child.state === 'unknown' && (!child.session_state || WAITING_SESSION.has(child.session_state))) {
      await this.deps.store.requeueChangeAuthor(child.id, child.conversation_id);
      return false;
    }
    if (!child.session_state) {
      if (JOB_ENDED.has(child.state)) { await this.close(request, 'authoring', { to: child.state === 'cancelled' ? 'cancelled' : 'failed', reason: child.wait_reason ?? `author_${child.state}` }); return true; }
      return this.startAuthor(request, child);
    }
    if (WAITING_SESSION.has(child.session_state) && (child.state === 'queued' || child.state === 'running')) return this.resumeAuthor(request, child);
    if (WAITING_SESSION.has(child.session_state) && child.state === 'waiting_user') return false;
    return this.pollAuthor(request, child);
  }
  private async startAuthor(request: ChangeRequest, child: ChildRow): Promise<boolean> {
    if (!request.brief || !request.policyRevision) throw new Error('brief_missing');
    const generation = await this.deps.changes.generationRecord(keyOf(request));
    if (!generation.ok) throw new Error('generation_missing');
    if (child.state === 'queued') {
      if (!this.deps.intakeOpen()) return false;
      if (!await this.deps.store.claimChangeAuthor(child.id)) return false;
    } else if (child.state !== 'running') return false;
    try {
      await this.deps.author.start({ target: this.target(request), baseCommit: generation.value.baseCommit, baseTree: generation.value.baseTree, policyRevision: request.policyRevision, brief: request.brief });
      this.wait(`step:${request.id}`, this.periods.authorPollMs);
      return true;
    } catch (error) {
      const code = error instanceof Error ? error.message : '';
      if (code === 'label_blocked' || code === 'base_tree_incomplete' || code === 'policy_revoked' || code === 'change_brief_too_long') {
        await this.close(request, 'authoring', { to: 'blocked', reason: code });
        return true;
      }
      // 턴을 보내지 못했다. 슬롯을 놓고 다음 바퀴에 다시 본다. lease를 쥔 채 GitHub 장애를 기다리면 레인을 막는다.
      const row = (await this.db.query<Job>('SELECT * FROM jobs WHERE id=$1', [child.id])).rows[0];
      if (row && !(await this.sessionState(child.id))) await this.deps.store.defer(row, 'change_start_deferred');
      throw error;
    }
  }
  private async sessionState(jobId: string): Promise<string | null> {
    return (await this.db.query<{ state: string }>(`SELECT state FROM codex_sessions WHERE job_id=$1 AND executor='claude'`, [jobId])).rows[0]?.state ?? null;
  }
  private async resumeAuthor(request: ChangeRequest, child: ChildRow): Promise<boolean> {
    if (child.state === 'queued') {
      if (!this.deps.intakeOpen()) return false;
      if (!await this.deps.store.claimChangeAuthor(child.id)) return false;
    }
    const question = (await this.db.query<{ answer: string | null; answer_event: string | null }>(`SELECT answer,answer_event FROM codex_questions WHERE job_id=$1 AND state='answered' ORDER BY turn DESC LIMIT 1`, [child.id])).rows[0];
    let label: ProvenanceLabel = request.label;
    if (question?.answer_event) {
      const recorded = (await this.deps.inputs.read({ changeId: request.id })).find(row => row.eventId === question.answer_event);
      // 기록이 없는 답은 출처를 모르는 것이다. 작성자에 넘기지 않는다.
      label = recorded?.label ?? 'unknown';
    }
    if (!labelAllowsAuthorInput(label)) { await this.close(request, 'authoring', { to: 'blocked', reason: 'label_blocked' }); return true; }
    try {
      await this.deps.author.resume({ receiptId: receiptOf(child), answer: question?.answer ?? '', label });
      this.wait(`step:${request.id}`, this.periods.authorPollMs);
      return true;
    } catch (error) {
      const code = error instanceof Error ? error.message : '';
      if (code.startsWith('change_') && code !== 'change_turn_stale' && code !== 'change_job_not_claimed') {
        await this.close(request, 'authoring', { to: 'failed', reason: code });
        return true;
      }
      const row = (await this.db.query<Job>('SELECT * FROM jobs WHERE id=$1', [child.id])).rows[0];
      if (row && WAITING_SESSION.has(await this.sessionState(child.id) ?? '')) await this.deps.store.defer(row, 'change_resume_deferred');
      throw error;
    }
  }
  // 재시작으로 lease만 끝난 job을 작업자의 답으로 되찾는다. 되찾은 뒤에는 정상 경로와 같은 처리를 탄다.
  private async reacquire(child: ChildRow, needStopped: boolean): Promise<boolean> {
    if (child.state !== 'unknown') return true;
    if (!child.lease_token || child.wait_reason !== 'lease_expired') return false;
    const facts = await this.deps.author.workerFacts(receiptOf(child)).catch(() => ({ known: false, stopped: false }));
    if (!facts.known || (needStopped && !facts.stopped)) return false;
    return this.deps.store.reacquireChangeAuthor({ id: child.id, lease_token: child.lease_token, conversation_id: child.conversation_id });
  }
  private async pollAuthor(request: ChangeRequest, child: ChildRow): Promise<boolean> {
    const slot = `step:${request.id}`;
    await this.reacquire(child, false);
    const receiptId = receiptOf(child);
    if (child.state === 'cancel_requested') await this.deps.author.cancel(receiptId).catch(error => { this.deps.log('change_author_cancel_failed', errorInfo(error)); });
    const result = await this.deps.author.fetchResult(receiptId);
    switch (result.kind) {
      case 'running':
      case 'needs_input':
        this.wait(slot, this.periods.authorPollMs);
        return false;
      case 'snapshot': {
        if (child.state === 'cancel_requested') {
          await this.deps.author.abandon(receiptId);
          await this.close(request, 'authoring', { to: 'cancelled', reason: 'owner_cancelled' });
          return true;
        }
        const saved = await this.deps.artifacts.save(keyOf(request), result.artifact, result.transportBytes);
        if (saved.ok) return true;
        if (saved.reason === 'busy') throw new Error('change_store_busy');
        // 경합으로 다른 phase가 됐으면 그 경로가 맞다. 받을 수 없는 결과는 막는다. 모델을 다시 돌리지 않는다.
        if (saved.reason !== 'phase_conflict') await this.close(request, 'authoring', { to: 'blocked', reason: saved.reason });
        return true;
      }
      case 'cancelled':
        // 해제로 끝난 턴은 사람이 취소한 것이 아니라 결과를 잃은 것이다.
        await this.close(request, 'authoring', result.code === 'stop_confirmed_after_unknown' ? { to: 'failed', reason: 'task_worker_lost' } : { to: 'cancelled', reason: result.code });
        return true;
      case 'failed':
        await this.close(request, 'authoring', { to: blockedAuthorCode(result.code) ? 'blocked' : 'failed', reason: result.code });
        return true;
      case 'unknown':
        // 시작 요청이 닿았는지 모른다. 다시 보내지 않는다. 기한이 지나면 늦게 닿는 시작까지 막고 닫는다.
        if (result.code === 'start_unconfirmed' && this.now() - Number(child.session_updated_at) >= this.periods.startGraceMs) await this.deps.author.closeUnstarted(receiptId);
        this.wait(slot, this.periods.authorPollMs);
        return false;
    }
  }

  // ---- 검증 ----

  private async verifying(request: ChangeRequest): Promise<boolean> {
    const key = keyOf(request);
    // 비상 중지·/cancel이 자식에 먼저 닿은 경우다. 부모를 닫으면 정리 바퀴가 돌던 시험을 멈춘다.
    const author = await this.authorChild(request);
    if (author.state === 'cancel_requested') {
      await this.close(request, 'verifying', { to: 'cancelled', reason: 'owner_cancelled' });
      return true;
    }
    // 시험 중 재시작으로 lease를 잃었으면 시험이 끝날 때까지 레인이 unknown으로 닫힌다. 시험은 그 lease로 계속 돌고 있어 되찾는다.
    await this.reacquire(author, false);
    const bundle = await this.deps.changes.evidenceBundle(key);
    if (!bundle.ok) throw new Error('bundle_missing');
    const required = request.brief?.verificationCommandIds ?? [];
    const statusOf = async () => new Map((await this.db.query<{ command_id: string; status: string }>('SELECT command_id,status FROM change_verifications WHERE change_id=$1 AND generation=$2', [request.id, request.generation])).rows.map(row => [row.command_id, row.status]));
    let statuses = await statusOf();
    for (const commandId of required) {
      if (statuses.has(commandId)) continue;
      let receipt;
      try { receipt = await this.deps.verification.run({ key, bundle: bundle.value, commandId }); }
      catch (error) {
        if (error instanceof TaskWorkerBusy) { this.wait(`step:${request.id}`, this.periods.failureBackoffMs); return false; }
        throw error;
      }
      const recorded = await this.deps.changes.recordVerification({ ...key, receipt });
      if (!recorded.ok && recorded.reason !== 'receipt_conflict') {
        if (recorded.reason === 'phase_conflict') return true;
        throw new Error(`verification_record_${recorded.reason}`);
      }
      statuses = await statusOf();
      // 앞 시험이 통과하지 못했으면 게시가 막힌다. 뒤 시험을 더 돌리지 않는다.
      if (statuses.get(commandId) !== 'passed') break;
    }
    const bad = required.map(commandId => statuses.get(commandId)).find(status => status !== 'passed');
    // 시험을 기다리는 동안 들어온 자식 /cancel이다. 진입 때 본 값은 낡았다. 부모를 닫지 않으면 자식은 취소됐는데 리뷰·승인이 이어진다.
    const child = await this.authorChild(request).catch(() => null);
    if (child?.state === 'cancel_requested' || child?.state === 'cancelled') {
      await this.close(request, 'verifying', { to: 'cancelled', reason: 'owner_cancelled' });
      return true;
    }
    // 저장·시험이 끝난 결과만 지운다. 실패해도 부모 진행을 막지 않고 closeFinishedChildren이 다시 부른다.
    if (child?.session_generation) await this.deps.author.finalize(receiptOf(child)).catch(error => { this.deps.log('change_author_finalize_deferred', errorInfo(error)); });
    if (bad !== undefined) {
      await this.close(request, 'verifying', { to: 'blocked', reason: `verification_${bad}` });
      return true;
    }
    const finished = await this.deps.changes.finishVerification(key);
    if (!finished.ok && finished.reason === 'busy') throw new Error('change_store_busy');
    return finished.ok;
  }

  private async laneStep(request: ChangeRequest): Promise<boolean> {
    if (request.phase !== 'requested' && !await this.authorized(request)) return true;
    switch (request.phase) {
      case 'requested': return (await this.admit(request)).ok;
      case 'admitted': return this.pin(request);
      case 'authoring': return this.authoring(request);
      case 'snapshot_ready': {
        const started = await this.deps.changes.startVerification({ ...keyOf(request), verifierRevision: this.deps.verifierRevision });
        if (started.ok) return true;
        if (started.reason === 'busy') throw new Error('change_store_busy');
        if (started.reason !== 'phase_conflict') await this.close(request, 'snapshot_ready', { to: 'blocked', reason: started.reason });
        return true;
      }
      case 'verifying': return this.verifying(request);
      default: return false;
    }
  }

  // 끝난 부모의 자식과 저장을 마친 세션을 정리한다. 작성·시험이 레인을 쥔 채 남지 않게 한다. 실행 중인 턴은 작업자 취소를 거쳐 소멸을 확인한다.
  // 시험을 기다리는 바퀴와 따로 돈다. 그래야 취소가 시험 시한까지 기다리지 않는다.
  async childrenTick(): Promise<boolean> {
    // 소멸을 확인하지 못한 자식은 사람이 풀 때까지 남는다. 그런 행이 뒤의 정리를 막지 않게 커서로 돈다.
    const rows = await this.page('children', async after => (await this.db.query<ChildRow & { role: string; change_id: string; has_artifact: boolean; phase: string; order_at: string | number }>(`SELECT c.role,c.change_id,r.phase,c.created_at AS order_at,
      EXISTS (SELECT 1 FROM change_artifacts a WHERE a.change_id=c.change_id AND a.generation=c.generation) AS has_artifact,
      j.id,j.state,j.wait_reason,j.lease_token,j.lease_until,j.conversation_id,j.owner_id,s.state AS session_state,s.generation AS session_generation,s.updated_at AS session_updated_at
      FROM change_child_jobs c JOIN change_requests r ON r.id=c.change_id JOIN jobs j ON j.id=c.job_id LEFT JOIN codex_sessions s ON s.job_id=j.id AND s.executor='claude'
      WHERE (r.generation<>c.generation OR (c.role='author' AND r.phase NOT IN ('requested','admitted','authoring','snapshot_ready','verifying')) OR (c.role='review' AND r.phase<>'reviewing'))
      AND (j.state IN ('queued','running','verifying','cancel_requested','waiting_user','unknown') OR (c.role='author' AND s.state IN ('running','waiting_answer','waiting_model')))
      AND (c.created_at,j.id)>($1::bigint,$2::text) ORDER BY c.created_at,j.id LIMIT $3`, [after.at, after.id, STEP_BATCH])).rows);
    let busy = false;
    for (const row of rows) {
      const slot = `child:${row.id}`;
      if (!this.due(slot)) continue;
      this.wait(slot, this.periods.authorPollMs);
      try {
        if (row.role === 'review') await this.closeReviewChild(row);
        else await this.closeAuthorChild(row);
        busy = true;
      } catch (error) { this.deps.log('change_child_close_failed', { role: row.role, ...errorInfo(error) }); }
    }
    return busy;
  }
  private async closeReviewChild(row: ChildRow): Promise<void> {
    // 리뷰 job의 owner는 사람이 아니라 대화 제어가 닿지 않는다. 리뷰 제어와 같은 경로로 슬롯과 scheduler를 맞춘다.
    await this.deps.store.control(row.owner_id, row.conversation_id, 'review-cancel', row.id, undefined, { review: true });
  }
  private async closeAuthorChild(row: ChildRow & { has_artifact: boolean; phase: string }): Promise<void> {
    if (!row.session_state) {
      // 세션 행이 없으면 작업자에 아무것도 보내지 않았다. 멈출 프로세스가 없어 바로 끝낸다. lease가 끝난 행은 줄로 돌린 뒤 다음 바퀴에 끝낸다.
      if (row.state === 'unknown') { await this.deps.store.requeueChangeAuthor(row.id, row.conversation_id); return; }
      if (row.state === 'running' || row.state === 'cancel_requested') await this.deps.store.transition(row as unknown as Job, 'cancelled', 'change_closed');
      else await this.deps.store.control(row.owner_id, row.conversation_id, 'cancel', row.id);
      return;
    }
    const receiptId = receiptOf(row);
    if (WAITING_SESSION.has(row.session_state)) { await this.deps.author.cancel(receiptId); return; }
    if (row.session_state !== 'running') return;
    // 시험이 끝난 결과라면 저장 ACK로 지운다. 끝 상태가 된 부모는 돌던 시험을 먼저 멈춘다.
    if (row.has_artifact) {
      if (!await this.reacquire(row, true)) return;
      if (isTerminalPhase(row.phase as ChangePhase)) await this.deps.author.cancel(receiptId);
      await this.deps.author.finalize(receiptId);
      return;
    }
    if (!await this.reacquire(row, false)) return;
    if (row.state === 'running' || row.state === 'unknown') await this.deps.store.control(row.owner_id, row.conversation_id, 'cancel', row.id);
    await this.deps.author.cancel(receiptId);
    const result = await this.deps.author.fetchResult(receiptId);
    if (result.kind === 'snapshot') await this.deps.author.abandon(receiptId);
  }

  // ---- 리뷰·승인 ----

  private async reviewing(request: ChangeRequest): Promise<boolean> {
    const key = keyOf(request);
    const stored = await this.deps.review.fetchReceipt(key);
    if (stored) return this.prepare(request, stored);
    const job = (await this.db.query<{ state: string; wait_reason: string | null; finished_at: string | null }>(`SELECT j.state,j.wait_reason,j.finished_at FROM change_child_jobs c JOIN jobs j ON j.id=c.job_id WHERE c.change_id=$1 AND c.generation=$2 AND c.role='review'`, [request.id, request.generation])).rows[0];
    if (job) {
      if (!JOB_ENDED.has(job.state)) return false;
      // 멈춤만 확인된 job은 작업자에 결과가 남아 있을 수 있다. fetchReceipt의 null이 작업자 일시 장애일 수 있어 잠시 더 묻는다.
      if (job.wait_reason === 'stop_confirmed_after_unknown' && this.now() - Number(job.finished_at) < 600_000) return false;
      // 같은 generation에서 리뷰를 다시 돌리는 길은 없다. receipt 없이 끝났으면 부모를 닫는다.
      await this.close(request, 'reviewing', { to: 'failed', reason: job.wait_reason ?? `review_${job.state}` });
      return true;
    }
    const bundle = await this.deps.changes.evidenceBundle(key);
    const artifact = await this.deps.changes.loadArtifact(key);
    if (!bundle.ok || !artifact.ok || !request.brief) throw new Error('evidence_missing');
    const verifications = (await this.db.query<{ receipt: unknown }>('SELECT receipt FROM change_verifications WHERE change_id=$1 AND generation=$2 AND invalidated_at IS NULL ORDER BY command_id', [request.id, request.generation])).rows
      .map(row => (typeof row.receipt === 'string' ? JSON.parse(row.receipt) : row.receipt) as never);
    try {
      await this.deps.review.submit({ key, bundle: bundle.value, brief: request.brief, manifest: artifact.value.manifest, patch: artifact.value.patch, verifications });
      return true;
    } catch (error) {
      if (error instanceof ChangeReviewRejected || error instanceof ChangeReviewFailed) {
        if (error.code === 'queue_full') { this.wait(`step:${request.id}`, 60_000); return false; }
        if (error.code !== 'phase_conflict') await this.close(request, 'reviewing', { to: 'blocked', reason: error.code });
        return true;
      }
      throw error;
    }
  }
  private async prepare(request: ChangeRequest, receipt: ReviewReceipt): Promise<boolean> {
    const key = keyOf(request);
    if (receipt.verdict === 'blocked') {
      await this.close(request, 'reviewing', { to: 'blocked', reason: receipt.coverage === 'incomplete' ? 'review_incomplete' : 'review_blocked' });
      return true;
    }
    const prepared = await this.deps.publisher.prepareApproval(key, { review: receipt, at: this.now() });
    if (prepared.ok) return true;
    if (FINAL_APPROVAL.test(prepared.reason)) {
      const closed = await this.deps.changes.invalidateEvidence({ ...key, from: 'reviewing', to: 'blocked', reason: safeReason(prepared.reason) });
      if (!closed.ok && closed.reason === 'busy') throw new Error('change_store_busy');
      this.deps.log('change_closed', { from: 'reviewing', to: 'blocked', reason: safeReason(prepared.reason) });
      return true;
    }
    if (prepared.reason === 'phase_conflict') return true;
    throw new Error(safeReason(prepared.reason, 'approval_prepare_failed'));
  }

  // ---- 게시·병합·배포 ----

  private async publishing(request: ChangeRequest): Promise<boolean> {
    const outcome = await this.deps.publisher.publish(keyOf(request));
    const slot = `step:${request.id}`;
    switch (outcome.kind) {
      case 'proposed': case 'superseded': case 'blocked': case 'stopped':
        // superseded를 자동으로 다시 열지 않는다. 사유가 base_moved로 틀리게 나올 수 있고 새 generation은 owner의 명시적 요청으로만 연다.
        this.deps.log('change_publish_outcome', { kind: outcome.kind, ...(outcome.kind === 'superseded' || outcome.kind === 'blocked' ? { reason: outcome.reason } : {}) });
        return true;
      case 'deferred':
        this.nextAt.set(slot, outcome.retryAt);
        this.deps.log('change_publish_outcome', { kind: 'deferred', reason: outcome.reason });
        return false;
      case 'unknown':
        // 대조가 끝나지 않았다. 다시 보내지 않고 대조 주기로 넘긴다.
        this.wait(slot, 60_000);
        return false;
      case 'busy':
        this.wait(slot, 5000);
        return false;
    }
  }
  private async pullOf(request: ChangeRequest): Promise<{ number: number; headSha: string } | null> {
    const row = (await this.db.query<{ result: unknown }>(`SELECT result FROM change_delivery_effects WHERE change_id=$1 AND generation=$2 AND stage='pull' AND state='confirmed'`, [request.id, request.generation])).rows[0];
    if (!row) return null;
    const result = (typeof row.result === 'string' ? JSON.parse(row.result) : row.result) as { number: number; headSha: string };
    return { number: result.number, headSha: result.headSha };
  }
  // 조회 실패와 대상 오류는 던져진다. 미병합으로 처리하지 않고 phase를 유지한다.
  private async proposed(request: ChangeRequest): Promise<boolean> {
    this.wait(`step:${request.id}`, this.periods.mergePollMs);
    const pull = await this.pullOf(request);
    if (!pull) throw new Error('pull_effect_missing');
    let reading: MergeReading;
    try { reading = await this.deps.deployment.readMerge({ target: this.target(request), prNumber: pull.number }); }
    catch (error) {
      // 기다려도 풀리지 않는 대상 오류다. phase는 유지하되 말없이 멈춰 있지 않게 한 번 알린다.
      if (error instanceof DeploymentTargetError) await this.send(request, `change-merge-unreadable:${request.id}:${request.generation}`, `변경 ${request.id}: PR #${pull.number}의 병합 여부를 읽지 못합니다(${error.code}). 병합해도 배포를 추적하지 못할 수 있습니다. 상태는 proposed로 둡니다.`);
      throw error;
    }
    if (reading.state === 'open') return false;
    if (reading.state === 'closed_unmerged') { await this.close(request, 'proposed', { to: 'cancelled', reason: 'closed_unmerged' }); return true; }
    const recorded = await this.deps.changes.recordMerge({ ...keyOf(request), prNumber: reading.prNumber, headSha: reading.headSha, mergeCommit: reading.mergeCommit });
    if (recorded.ok) { this.nextAt.delete(`step:${request.id}`); return true; }
    if (recorded.reason === 'busy') throw new Error('change_store_busy');
    if (recorded.reason === 'head_mismatch') await this.close(request, 'proposed', { to: 'blocked', reason: 'head_changed' });
    else if (recorded.reason === 'pull_mismatch') await this.close(request, 'proposed', { to: 'blocked', reason: 'pull_mismatch' });
    return true;
  }
  private async merged(request: ChangeRequest): Promise<boolean> {
    // 창 시작을 먼저 남긴다. recordDeployment가 observed_at을 덮어써 그 값으로는 재시작 뒤 창을 잴 수 없다.
    await this.db.query('INSERT INTO change_deployment_windows(change_id,generation,started_at) VALUES ($1,$2,$3) ON CONFLICT DO NOTHING', [request.id, request.generation, this.now()]);
    const moved = await this.deps.changes.transition({ ...keyOf(request), from: 'merged', to: 'observing_deploy', reason: null });
    if (!moved.ok && moved.reason === 'busy') throw new Error('change_store_busy');
    return moved.ok;
  }
  private async observing(request: ChangeRequest): Promise<boolean> {
    const key = keyOf(request);
    const stored = await this.deps.changes.deployment(key);
    if (!stored.ok) throw new Error('deployment_missing');
    const window = (await this.db.query<{ started_at: string; late_reported_at: string | null }>('SELECT started_at,late_reported_at FROM change_deployment_windows WHERE change_id=$1 AND generation=$2', [request.id, request.generation])).rows[0];
    if (!window) { await this.db.query('INSERT INTO change_deployment_windows(change_id,generation,started_at) VALUES ($1,$2,$3) ON CONFLICT DO NOTHING', [request.id, request.generation, this.now()]); return true; }
    // 끝났거나 늦음을 알린 건은 더 읽지 않는다. 마지막 관측은 저장돼 있어 /change-status가 보여 준다.
    if (window.late_reported_at !== null || ['observed', 'not_applicable', 'blocked'].includes(stored.value.state)) { this.wait(`step:${request.id}`, 3_600_000); return false; }
    this.wait(`step:${request.id}`, DEPLOYMENT_POLL.intervalMs);
    const observation: DeploymentObservation = await this.deps.deployment.observe({ target: this.target(request), headSha: stored.value.headSha, mergeCommit: stored.value.mergeCommit });
    const recorded = await this.deps.changes.recordDeployment({ ...key, observation });
    if (!recorded.ok && recorded.reason !== 'deployment_stale') throw new Error(`deployment_record_${recorded.reason}`);
    if (deploymentPollStep(observation, Number(window.started_at), this.now()) === 'report_late') {
      await this.db.query('UPDATE change_deployment_windows SET late_reported_at=$3 WHERE change_id=$1 AND generation=$2 AND late_reported_at IS NULL', [request.id, request.generation, this.now()]);
    }
    return false;
  }
  private async publishStep(request: ChangeRequest): Promise<boolean> {
    switch (request.phase) {
      case 'reviewing':
        if (!await this.authorized(request)) return true;
        return this.reviewing(request);
      case 'approved': case 'publishing':
        if (!await this.authorized(request)) return true;
        return this.publishing(request);
      case 'proposed': return this.proposed(request);
      case 'merged': return this.merged(request);
      case 'observing_deploy': return this.observing(request);
      default: return false;
    }
  }

  // ---- 알림 ----

  // 알림은 outbox 키로 한 번만 들어간다. 넣기 전에 끊기면 다음 바퀴가 다시 넣고, Discord ACK를 잃어도 게시자가 같은 nonce로 대조한다. 공개 PR과 분리돼 있어 통지 실패가 게시를 되풀이시키지 않는다.
  // 문구를 만들지 못하는 행은 outbox에 들어가지 않아 시효까지 남는다. 그런 행이 뒤의 알림을 막지 않게 커서로 돈다.
  private async sendNotices(): Promise<void> {
    const rows = await this.page('notices', async after => (await this.db.query<PageRow>(`SELECT r.id,r.updated_at AS order_at FROM change_requests r WHERE r.phase=ANY($1::text[]) AND r.updated_at>$2
      AND NOT EXISTS (SELECT 1 FROM outbox o WHERE o.idempotency_key='change-phase:'||r.id||':'||r.generation||':'||r.phase)
      AND (r.updated_at,r.id)>($3::bigint,$4::text) ORDER BY r.updated_at,r.id LIMIT $5`, [NOTICE_PHASES, this.now() - NOTICE_WINDOW_MS, after.at, after.id, STEP_BATCH])).rows);
    for (const row of rows) {
      const request = await this.deps.changes.get(row.id);
      if (!request.ok) continue;
      try { await this.notifyPhase(request.value); }
      catch (error) { this.deps.log('change_notice_failed', errorInfo(error)); }
    }
    const deployments = await this.page('deployment-notices', async after => (await this.db.query<PageRow>(`SELECT r.id,r.updated_at AS order_at FROM change_requests r JOIN change_deployments d ON d.change_id=r.id AND d.generation=r.generation
      LEFT JOIN change_deployment_windows w ON w.change_id=r.id AND w.generation=r.generation
      WHERE r.phase='observing_deploy' AND r.updated_at>$1 AND (d.state IN ('observed','not_applicable','blocked') OR w.late_reported_at IS NOT NULL)
      AND NOT EXISTS (SELECT 1 FROM outbox o WHERE o.idempotency_key='change-deploy:'||r.id||':'||r.generation)
      AND (r.updated_at,r.id)>($2::bigint,$3::text) ORDER BY r.updated_at,r.id LIMIT $4`, [this.now() - NOTICE_WINDOW_MS, after.at, after.id, STEP_BATCH])).rows);
    for (const row of deployments) {
      const request = await this.deps.changes.get(row.id);
      const stored = request.ok ? await this.deps.changes.deployment(keyOf(request.value)) : null;
      if (!request.ok || !stored?.ok) continue;
      const { prNumber: _pr, ...observation } = stored.value;
      await this.send(request.value, `change-deploy:${row.id}:${request.value.generation}`, [`변경 ${row.id}`, describeDeployment(observation)].join('\n')).catch(error => { this.deps.log('change_notice_failed', errorInfo(error)); });
    }
  }
  private async notifyPhase(request: ChangeRequest): Promise<void> {
    const key = `change-phase:${request.id}:${request.generation}:${request.phase}`;
    // owner 호출은 게시 승인 요청(미리보기)과 변경 실패 둘만이다. 게시 완료·막힘·취소·대체는 부르지 않는다.
    if (request.phase === 'awaiting_publish_approval') {
      // 게시 승인 버튼은 동료 기능 스위치를 켰을 때만 단다. outbox가 여러 쪽 글의 마지막 쪽에만 버튼을 남긴다.
      await this.send(request, key, await this.preview(request), true, this.deps.store.colleague ? await this.publishButtons(request) : undefined);
      return;
    }
    if (request.phase === 'proposed') {
      const pull = await this.pullOf(request);
      const policy = await this.deps.policy(request.repoId);
      await this.send(request, key, [`변경 ${request.id}: PR #${pull?.number ?? '?'}을 게시했습니다${policy ? ` (${policy.fullName})` : ''}. 사람이 검토해 병합합니다. 봇은 병합하지 않습니다.`,
        '이 알림의 전달 실패는 게시를 되풀이하지 않습니다. /change-status로 상태를 볼 수 있습니다.'].join('\n'));
      return;
    }
    const reason = request.phaseReason ?? request.phase;
    const pull = await this.pullOf(request);
    const tail = request.phase === 'superseded' ? changeNextGeneration(request.id) : CHANGE_RESTART;
    const untracked = pull ? ` PR #${pull.number}은 그대로 있고, 이 뒤로 병합돼도 배포를 추적하지 않습니다.` : '';
    const withheld = reason === 'task_question_sensitive' ? ' 모델 질문에서 공개하면 안 되는 값을 찾아 질문을 이 스레드에 내보내지 않았습니다.' : '';
    await this.send(request, key, `변경 ${request.id} g${request.generation}: ${request.phase}(${reason}).${withheld}${untracked} ${tail}`, request.phase === 'failed');
  }
  private async send(request: ChangeRequest, key: string, content: string, ownerCall = false, buttons?: OutboxButton[]): Promise<void> {
    const policy = await this.deps.gate.current();
    await this.deps.store.enqueue({ key, conversation: request.conversationId, actor: request.ownerId, scope: request.scope, revision: policy.revision,
      payload: { kind: 'message', channel: request.scope.channel, content, classification: 'safe_summary', ...(ownerCall ? { ownerCall: true as const } : {}),
        ...(buttons?.length ? { buttons } : {}) } });
  }
  private async publishButtons(request: ChangeRequest): Promise<OutboxButton[]> {
    const approval = await this.deps.changes.approvalSubject(keyOf(request));
    if (!approval.ok) throw new Error('preview_evidence_missing');
    return [publishButton(request.id, request.generation, approval.value.digest)];
  }
  // 요청 스레드에만 보낸다. 고정 코드·SHA·경로만 싣고 리뷰 자유문·시험 로그·요청 원문을 싣지 않는다.
  private async preview(request: ChangeRequest): Promise<string> {
    const key = keyOf(request);
    const approval = await this.deps.changes.approvalSubject(key);
    const artifact = await this.deps.changes.loadArtifact(key);
    if (!approval.ok || !artifact.ok) throw new Error('preview_evidence_missing');
    const review = (await this.db.query<{ receipt: unknown }>('SELECT receipt FROM change_reviews WHERE change_id=$1 AND generation=$2', [request.id, request.generation])).rows[0];
    const receipt = review ? (typeof review.receipt === 'string' ? JSON.parse(review.receipt) : review.receipt) as ReviewReceipt : null;
    const { subject, digest } = approval.value;
    const changed = artifact.value.manifest.entries.filter(entry => entry.changeKind !== 'unchanged');
    const warnings = receipt?.risks.map(risk => `- 경고: ${risk.priority} ${risk.category} ${risk.code}`) ?? [];
    return [`변경 ${request.id} g${request.generation} 게시 미리보기. 아직 아무것도 공개하지 않았습니다.`,
      `제목: ${subject.publication.title}`, `base: ${subject.baseBranch} @ ${subject.bundle.baseCommit}`, `브랜치: ${subject.branch}`, `결과 tree: ${subject.bundle.resultTree}`, `artifact: ${subject.bundle.artifactDigest}`,
      `시험: ${subject.verifications.map(item => `${item.commandId} ${item.status}`).join(', ')}`, `리뷰: ${subject.review.verdict}, 범위 ${subject.review.coverage}`, ...warnings,
      `변경 파일 ${changed.length}개:`, ...changed.slice(0, 40).map(entry => `- ${entry.changeKind} ${entry.path}`), ...(changed.length > 40 ? [`- 외 ${changed.length - 40}개`] : []),
      '', `승인하려면 이 스레드에서: /change-publish target:${request.id} text:${digest}`, 'digest는 위 내용 전체에 묶여 있습니다. 승인 전에 base가 움직이면 게시하지 않습니다.'].join('\n');
  }
}
