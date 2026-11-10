import { randomUUID } from 'node:crypto';
import { changeNextGeneration, changeRestart } from './change-advice.js';
import { evaluateCi, readCiSnapshot } from './change-ci-policy.js';
import { amendmentMaterialsDigest, CHANGE_SELF_FIX, isTerminalPhase, labelAllowsAuthorInput, ReasonCodeSchema } from './change-contracts.js';
import { ChangeGuidance, guidanceLimit, notesApproved, readChangeNotes, recordChangeNotes } from './change-guidance.js';
import { noteLine, scanPublicText } from './change-publication.js';
import { ChangeReviewFailed, ChangeReviewRejected, selfFixable } from './change-review.js';
import type { AmendmentKey, ChangeArtifactPort, ChangeDeploymentPort, ChangeKey, ChangeNote, ChangePhase, EvidenceKey, ReviewMaterial, VerificationReceipt, ChangeTarget, ChangeVerificationPort, DeploymentObservation, MergeReading, ProvenanceLabel, ReviewReceipt, TerminalChangePhase } from './change-contracts.js';
import { DEPLOYMENT_POLL, DeploymentTargetError, deploymentPollStep, describeDeployment } from './change-deployment.js';
import { compilePathPolicy, taskPathRules } from './change-policy.js';
import type { ChangeRepositoryPolicy } from './change-policy.js';
import { discussionMaterials, parseChangeRequest, PUBLISH_TEXT, publishButton } from './change-commands.js';
import type { AmendmentDiscussionReader, AmendmentMaterialItem } from './change-commands.js';
import type { ChangePublisher } from './change-publisher.js';
import type { ChangeReviewService } from './change-review.js';
import type { AmendmentRound, ChangePrivateInputs, ChangeRequest, ChangeStore } from './change-store.js';
import { purgeExpiredChangeContentRounds } from './change-store.js';
import type { ChangeAuthorSource, ClaudeChangeAuthor } from './claude-task-bridge.js';
import { DEFAULTS, Denied, PolicyUnavailable } from './contracts.js';
import type { Job } from './contracts.js';
import type { GuidanceReviewPort } from './github-review-io.js';
import type { ChangePreflightPort } from './github-writer.js';
import { errorInfo } from './log.js';
import type { Log } from './log.js';
import type { PolicyGate } from './policy.js';
import type { OutboxButton, Store } from './store.js';
import { TaskWorkerBusy } from './task-bridge.js';
import { DEFAULT_LIMITS } from './task-policy.js';

// 변경 알림의 고정 문구. 동료 말투(해요체, 자기를 "봇"이라 부르지 않음)다. 첫 인자 colleague는 동료 기능 스위치(Store.colleague)이고
// 켜지면 '/' 이름 대신 말로 하는 안내(미리보기는 게시 승인 버튼)를 낸다. 분기는 colleague 하나뿐이어야 시험이 '/' 이름을 검사할 수 있다.
// phase·사유 코드, SHA·경로는 코드 그대로 싣는다.
export const CHANGE_NOTICE_TEXT = Object.freeze({
  mergeUnreadable: (_c: boolean, id: string, pr: number, code: string) =>
    `변경 ${id}: PR #${pr}의 병합 여부를 읽지 못했어요(${code}). 병합돼도 배포를 추적하지 못할 수 있어요. 상태는 proposed로 둬요.`,
  published: (c: boolean, id: string, pr: number | string, repository: string | null) => [
    `변경 ${id}: PR #${pr}을 게시했어요${repository ? ` (${repository})` : ''}. 병합은 사람이 검토해서 해요. 저는 병합하지 않아요.`,
    `이 알림이 전달되지 않아도 게시를 다시 하지 않아요. ${c ? '상태는 물어보면 알려 드릴게요.' : '상태는 /change-status로 볼 수 있어요.'}`].join('\n'),
  untracked: (_c: boolean, pr: number) => ` PR #${pr}은 그대로 있고, 이 뒤로 병합돼도 배포를 추적하지 않아요.`,
  withheld: ' 모델 질문에서 공개하면 안 되는 값을 찾아 질문을 이 스레드에 내보내지 않았어요.',
  selfFixRemaining: (_c: boolean, rounds: number) => `게시 전에 ${rounds}번 고치려고 했는데 자체 리뷰에서 막는 문제가 남아 있어요.`,
  selfReviewBlocked: '자체 리뷰에서 막는 문제가 나와서 게시하지 않았어요.',
  previewHead: (_c: boolean, id: string, generation: number) => `변경 ${id} g${generation} 게시 미리보기예요. 아직 아무것도 공개하지 않았어요.`,
  // 켜짐 판은 같은 글에 단 게시 승인 버튼을 가리킨다(버튼은 여러 쪽 글의 마지막 쪽에 붙는다).
  previewApprove: (c: boolean, id: string, digest: string) => c ? `게시하려면 이 글의 "${PUBLISH_TEXT.label}" 버튼을 눌러 주세요.`
    : `승인하려면 이 스레드에서: /change-publish target:${id} text:${digest}`,
  previewBinding: (c: boolean) => `${c ? '버튼 승인은' : 'digest는'} 위 내용 전체에 묶여 있어요. 승인 전에 base가 움직이면 게시하지 않아요.`,
});

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
// 수정 차례(C27) 결과 알림. 동료 기능 스위치를 켰을 때만 생기는 흐름이라 동료 말투다. 사유는 고정 코드를 말로 옮기고 모르는 코드는 그대로 둔다.
const AMENDMENT_REASON: Readonly<Record<string, string>> = Object.freeze({
  head_changed: '확인한 뒤로 PR 브랜치에 다른 커밋이 올라왔어요. 지금 브랜치를 보고 다시 요청해 주세요',
  pr_merged: 'PR이 병합돼서 커밋하지 않았어요',
  closed_unmerged: 'PR이 닫혀서 커밋하지 않았어요',
  pull_not_open: 'PR이 열려 있지 않아서 커밋하지 않았어요',
  review_blocked: '자체 리뷰에서 막는 문제가 나왔어요',
  review_incomplete: '자체 리뷰가 변경 전체를 보지 못했어요',
  worker_unsupported: '작업자가 아직 수정 요청을 받지 못하는 버전이에요',
  input_purged: '보존 기간이 지나 요청 내용을 지웠어요',
  policy_changed: '그 사이 정책이 바뀌었어요. 새로 변경을 요청해 주세요',
  materials_changed: '확인한 뒤로 반영할 PR 리뷰·댓글이 고쳐지거나 지워졌어요. 지금 글을 보고 다시 부탁해 주세요',
  owner_cancelled: '취소했어요',
});
export const AMENDMENT_TEXT = Object.freeze({
  committed: (pr: number, round: number, files: number, passed: number, total: number, checks: number) =>
    `PR #${pr}에 수정 차례 ${round} 커밋을 올렸어요. 바뀐 파일 ${files}개, 시험 ${passed}/${total} 통과, 확인할 것 ${checks}개예요. 병합은 직접 검토한 뒤 해 주세요.`,
  failed: (pr: number, round: number, reason: string) => `PR #${pr}의 수정 차례 ${round}은 커밋하지 않았어요. ${
    AMENDMENT_REASON[reason] ?? (reason.startsWith('verification_') ? '시험이 통과하지 못했어요' : `사유 코드: ${reason}`)}.`,
  checks: '확인할 것(PR 줄 댓글로 못 단 것):',
  risks: '남은 위험(PR 줄 댓글로 못 단 것):',
});
// 끝난 부모에게 알리는 시효. 재시작 때 지난 건을 몰아 보내지 않는다.
const NOTICE_WINDOW_MS = 7 * 86_400_000;
// amending은 두 바퀴에 모두 있다. 작성·시험(작업자 슬롯)은 laneTick, 병합 감시·리뷰·게시는 publishTick이 맡는다.
const LANE_PHASES = ['requested', 'admitted', 'authoring', 'snapshot_ready', 'verifying', 'amending'] as const;
const PUBLISH_PHASES = ['reviewing', 'approved', 'publishing', 'proposed', 'amending', 'merged', 'observing_deploy'] as const;
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
  const keyOfJob = async (jobId: string): Promise<EvidenceKey | null> => {
    const row = (await db.query<{ change_id: string; generation: number | string; amendment_round: number | string }>(`SELECT change_id,generation,amendment_round FROM change_child_jobs WHERE job_id=$1 AND role='author'`, [jobId])).rows[0];
    if (!row) return null;
    const round = Number(row.amendment_round);
    return { changeId: row.change_id, generation: Number(row.generation), ...(round ? { round } : {}) };
  };
  // 지금 고치기 차례의 작성 job. 수정 차례(C27)면 그 차례의 작성 job이다. 시험 port도 이 값으로 세션을 찾으므로 앞 차례의 세션을 가리키지 않는다.
  const authorJob = async (key: EvidenceKey): Promise<string | null> =>
    (await db.query<{ job_id: string }>(`SELECT c.job_id FROM change_child_jobs c JOIN change_generations g ON g.change_id=c.change_id AND g.generation=c.generation
      WHERE c.change_id=$1 AND c.generation=$2 AND c.role='author' AND c.fix_round=g.fix_round AND c.amendment_round=$3`, [key.changeId, key.generation, key.round ?? 0])).rows[0]?.job_id ?? null;
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
    async questionRisk(jobId, question, options = []) {
      const key = await keyOfJob(jobId);
      const row = key ? (await db.query<{ repo_id: number | string }>('SELECT repo_id FROM change_requests WHERE id=$1', [key.changeId])).rows[0] : undefined;
      const policy = row ? await deps.policy(Number(row.repo_id)) : null;
      // 내부 표식을 볼 수 없으면 공개해도 되는 글이라고 말할 수 없다. 정책을 잠시 못 읽는 예외는 그대로 올라가 다음 바퀴에 다시 본다.
      if (!policy) return 'policy_revoked';
      // 선택지는 질문 글 본문과 버튼으로 함께 나가므로 질문과 같은 검사를 받는다.
      return scanPublicText({ title: question, body: [question, ...options].join('\n') }, policy);
    },
    async plan(input) {
      const jobId = await authorJob({ ...input.target.key, round: input.amendment?.round ?? 0 });
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
  author: Pick<ClaudeChangeAuthor, 'supportsV2' | 'supportsSelfFix' | 'supportsAmendment' | 'start' | 'resume' | 'cancel' | 'fetchResult' | 'finalize' | 'workerFacts' | 'abandon' | 'closeUnstarted'>;
  artifacts: ChangeArtifactPort; verification: ChangeVerificationPort;
  review: Pick<ChangeReviewService, 'submit' | 'fetchReceipt' | 'selfFixFindings' | 'remainingFindings'>;
  publisher: Pick<ChangePublisher, 'prepareApproval' | 'publish' | 'reconcile' | 'publishAmendment' | 'reconcileAmendments'>;
  preflight: ChangePreflightPort; deployment: ChangeDeploymentPort; policy: ChangeRepositoryPolicies;
  // 작업자가 새 실행을 받는 중인지. 닫혀 있는데 claim하면 시작 불명 상태로 레인을 잡는다.
  intakeOpen: () => boolean;
  // 봇 PR 안내 리뷰(리뷰 App, C26 guidance 포트). 없으면 안내 댓글만 달지 않고 게시·병합 추적은 그대로다.
  guidance?: GuidanceReviewPort;
  // 수정 차례(C27)의 자료 읽기(리뷰 App, C26 discussion.read). 없으면 수정 차례를 열지 않는다(확정된 요청은 대기열에 남는다).
  discussion?: AmendmentDiscussionReader;
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
const SELF_FIX_UNAVAILABLE = new Set(['self_fix_findings_missing']);
const FINAL_APPROVAL =/^(label_blocked|review_mismatch|review_incomplete|policy_revoked|policy_changed|publication_|secret_detected|internal_marker|metadata_sensitive|base_tree_incomplete|evidence_missing|ci_(?!unreadable))/;

export class ChangeRuntime {
  private readonly periods: ChangePeriods;
  // 재시도 시각과 연속 실패 수. 잃어도 다음 바퀴가 바로 다시 볼 뿐이라 메모리에 둔다.
  private readonly nextAt = new Map<string, number>();
  private readonly failures = new Map<string, number>();
  private readonly cursors = new Map<string, Cursor>();
  private readonly now: () => number;
  private readonly guidance: ChangeGuidance | null;
  constructor(private readonly deps: ChangeRuntimeDeps) {
    this.periods = { ...CHANGE_PERIODS, ...deps.periods };
    this.now = deps.store.now;
    this.guidance = deps.guidance ? new ChangeGuidance({ db: deps.store.db, changes: deps.changes, port: deps.guidance, policy: deps.policy,
      limit: async () => guidanceLimit(await deps.gate.current()), now: deps.store.now, log: deps.log }) : null;
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
    await this.sendAmendmentNotices();
    return busy;
  }
  // 게시 대조. 응답을 잃은 effect를 정확한 값과 맞추고 기한 넘은 unknown을 사람 해소로 넘긴다. 승인·게시 중인 건도 이어 간다.
  async reconcile() {
    const report = await this.deps.publisher.reconcile();
    await this.deps.publisher.reconcileAmendments();
    return report;
  }
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
  // 작성 job은 고치기 차례마다 하나다. 앞 차례의 job은 끝나 있고 이 차례의 작성이 아니다.
  private async authorChild(request: ChangeRequest): Promise<ChildRow> {
    const read = async () => (await this.db.query<ChildRow>(`SELECT j.id,j.state,j.wait_reason,j.lease_token,j.lease_until,j.conversation_id,j.owner_id,s.state AS session_state,s.generation AS session_generation,s.updated_at AS session_updated_at
      FROM change_child_jobs c JOIN change_generations g ON g.change_id=c.change_id AND g.generation=c.generation JOIN jobs j ON j.id=c.job_id LEFT JOIN codex_sessions s ON s.job_id=j.id AND s.executor='claude'
      WHERE c.change_id=$1 AND c.generation=$2 AND c.role='author' AND c.fix_round=g.fix_round`, [request.id, request.generation])).rows[0];
    const existing = await read();
    if (existing) return existing;
    await this.db.transaction(async tx => {
      const parent = (await tx.query<{ phase: string; generation: number | string }>('SELECT phase,generation FROM change_requests WHERE id=$1 FOR UPDATE', [request.id])).rows[0];
      if (!parent || Number(parent.generation) !== request.generation || parent.phase !== 'authoring') throw new Error('change_parent_moved');
      const round = Number((await tx.query<{ fix_round: number }>('SELECT fix_round FROM change_generations WHERE change_id=$1 AND generation=$2', [request.id, request.generation])).rows[0]?.fix_round ?? 0);
      if ((await tx.query(`SELECT 1 FROM change_child_jobs WHERE change_id=$1 AND generation=$2 AND role='author' AND fix_round=$3`, [request.id, request.generation, round])).rows.length) return;
      if (await this.deps.store.queueFull('task', tx)) throw new Error('queue_full');
      const now = this.now();
      const job = randomUUID(), event = randomUUID();
      const delivery = `change-author:${request.id}:${request.generation}${round ? `:r${round}` : ''}`;
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
      if (JOB_ENDED.has(child.state)) { await this.authorEnded(request, { to: child.state === 'cancelled' ? 'cancelled' : 'failed', reason: child.wait_reason ?? `author_${child.state}` }); return true; }
      return this.startAuthor(request, child);
    }
    if (WAITING_SESSION.has(child.session_state) && (child.state === 'queued' || child.state === 'running')) return this.resumeAuthor(request, child);
    if (WAITING_SESSION.has(child.session_state) && child.state === 'waiting_user') return false;
    return this.pollAuthor(request, child);
  }
  // 고치기 차례의 작성이 실패하면(작업자가 고치기 요청을 받지 않은 경우 포함) 앞 차례 리뷰의 P0·P1이 그대로 남은 것이다.
  // 새 실패 모양 없이 review_blocked로 닫고 실제 사유는 로그에 둔다. 취소와 입력·경계 막힘(label_·task_question_ 등)은 그 사유 그대로다.
  private async authorEnded(request: ChangeRequest, outcome: Outcome): Promise<void> {
    const generation = await this.deps.changes.generationRecord(keyOf(request));
    const round = generation.ok ? generation.value.fixRound : 0;
    if (round > 0 && (outcome.to === 'failed' || SELF_FIX_UNAVAILABLE.has(outcome.reason))) {
      this.deps.log('change_self_fix_failed', { round, reason: safeReason(outcome.reason) });
      await this.close(request, 'authoring', { to: 'blocked', reason: 'review_blocked' });
      return;
    }
    await this.close(request, 'authoring', outcome);
  }
  private async startAuthor(request: ChangeRequest, child: ChildRow): Promise<boolean> {
    if (!request.brief || !request.policyRevision) throw new Error('brief_missing');
    const key = keyOf(request);
    const generation = await this.deps.changes.generationRecord(key);
    if (!generation.ok) throw new Error('generation_missing');
    const round = generation.value.fixRound;
    // 고치기 차례는 그 차례를 연 리뷰의 P0·P1 발견을 자료로 넘긴다. 발견이 없으면 고칠 것을 말할 수 없어 닫는다.
    const findings = round > 0 ? await this.deps.review.selfFixFindings(key, round) : [];
    if (round > 0 && !findings.length) { await this.authorEnded(request, { to: 'blocked', reason: 'self_fix_findings_missing' }); return true; }
    if (child.state === 'queued') {
      if (!this.deps.intakeOpen()) return false;
      if (!await this.deps.store.claimChangeAuthor(child.id)) return false;
    } else if (child.state !== 'running') return false;
    try {
      await this.deps.author.start({ target: this.target(request), baseCommit: generation.value.baseCommit, baseTree: generation.value.baseTree, policyRevision: request.policyRevision, brief: request.brief,
        ...(round > 0 ? { selfFix: { round, findings } } : {}) });
      this.wait(`step:${request.id}`, this.periods.authorPollMs);
      return true;
    } catch (error) {
      const code = error instanceof Error ? error.message : '';
      if (code === 'label_blocked' || code === 'base_tree_incomplete' || code === 'policy_revoked' || code === 'change_brief_too_long') {
        await this.authorEnded(request, { to: 'blocked', reason: code });
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
  // round가 있으면 수정 차례(C27)의 작성이다. 끝나면 부모 대신 그 차례를 닫는다.
  private async authorEnd(request: ChangeRequest, round: AmendmentRound | undefined, outcome: Outcome): Promise<boolean> {
    if (round) return this.failAmendment(request, round, outcome.reason);
    await this.authorEnded(request, outcome);
    return true;
  }
  private async resumeAuthor(request: ChangeRequest, child: ChildRow, round?: AmendmentRound): Promise<boolean> {
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
    if (!labelAllowsAuthorInput(label)) {
      if (round) return this.failAmendment(request, round, 'label_blocked');
      await this.close(request, 'authoring', { to: 'blocked', reason: 'label_blocked' });
      return true;
    }
    try {
      await this.deps.author.resume({ receiptId: receiptOf(child), answer: question?.answer ?? '', label });
      this.wait(`step:${request.id}`, this.periods.authorPollMs);
      return true;
    } catch (error) {
      const code = error instanceof Error ? error.message : '';
      if (code.startsWith('change_') && code !== 'change_turn_stale' && code !== 'change_job_not_claimed') return this.authorEnd(request, round, { to: 'failed', reason: code });
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
  private async pollAuthor(request: ChangeRequest, child: ChildRow, round?: AmendmentRound): Promise<boolean> {
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
          if (round) return this.failAmendment(request, round, 'owner_cancelled');
          await this.close(request, 'authoring', { to: 'cancelled', reason: 'owner_cancelled' });
          return true;
        }
        // 수정 차례의 확인할 것·남은 위험은 그 차례 artifact와 함께 둔다(처음 게시의 목록은 PR 본문에 묶여 있어 덮지 않는다).
        if (round) {
          const saved = await this.deps.artifacts.save({ ...keyOf(request), round: round.round }, result.artifact, result.transportBytes, { checks: result.checks ?? [], risks: result.risks ?? [] });
          if (saved.ok) return true;
          if (saved.reason === 'busy') throw new Error('change_store_busy');
          return saved.reason === 'phase_conflict' ? true : this.failAmendment(request, round, saved.reason);
        }
        // 저장보다 먼저 남긴다. 저장 뒤에 끊기면 phase가 넘어가 이 결과를 다시 읽지 않는다. 같은 결과를 다시 받아도 처음 기록 그대로다.
        if (result.checks?.length || result.risks?.length) await recordChangeNotes(this.db, keyOf(request), { checks: result.checks ?? [], risks: result.risks ?? [] }, this.now);
        const saved = await this.deps.artifacts.save(keyOf(request), result.artifact, result.transportBytes);
        if (saved.ok) return true;
        if (saved.reason === 'busy') throw new Error('change_store_busy');
        // 경합으로 다른 phase가 됐으면 그 경로가 맞다. 받을 수 없는 결과는 막는다. 모델을 다시 돌리지 않는다.
        if (saved.reason !== 'phase_conflict') await this.close(request, 'authoring', { to: 'blocked', reason: saved.reason });
        return true;
      }
      case 'cancelled':
        // 해제로 끝난 턴은 사람이 취소한 것이 아니라 결과를 잃은 것이다.
        return this.authorEnd(request, round, result.code === 'stop_confirmed_after_unknown' ? { to: 'failed', reason: 'task_worker_lost' } : { to: 'cancelled', reason: result.code });
      case 'failed':
        return this.authorEnd(request, round, { to: blockedAuthorCode(result.code) ? 'blocked' : 'failed', reason: result.code });
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
      case 'amending': return this.amendLane(request);
      default: return false;
    }
  }

  // 끝난 부모의 자식과 저장을 마친 세션을 정리한다. 작성·시험이 레인을 쥔 채 남지 않게 한다. 실행 중인 턴은 작업자 취소를 거쳐 소멸을 확인한다.
  // 시험을 기다리는 바퀴와 따로 돈다. 그래야 취소가 시험 시한까지 기다리지 않는다.
  async childrenTick(): Promise<boolean> {
    // 소멸을 확인하지 못한 자식은 사람이 풀 때까지 남는다. 그런 행이 뒤의 정리를 막지 않게 커서로 돈다.
    // 수정 차례(C27)의 자식은 그 차례가 running이고 부모가 amending인 동안만 산다. 결과 저장은 그 차례의 artifact로 본다.
    const rows = await this.page('children', async after => (await this.db.query<ChildRow & { role: string; change_id: string; has_artifact: boolean; phase: string; order_at: string | number }>(`SELECT c.role,c.change_id,r.phase,c.created_at AS order_at,
      CASE WHEN c.amendment_round>0 THEN EXISTS (SELECT 1 FROM change_amendment_artifacts m WHERE m.change_id=c.change_id AND m.generation=c.generation AND m.round=c.amendment_round)
        ELSE EXISTS (SELECT 1 FROM change_artifacts a WHERE a.change_id=c.change_id AND a.generation=c.generation) END AS has_artifact,
      j.id,j.state,j.wait_reason,j.lease_token,j.lease_until,j.conversation_id,j.owner_id,s.state AS session_state,s.generation AS session_generation,s.updated_at AS session_updated_at
      FROM change_child_jobs c JOIN change_requests r ON r.id=c.change_id JOIN jobs j ON j.id=c.job_id LEFT JOIN codex_sessions s ON s.job_id=j.id AND s.executor='claude'
      WHERE (r.generation<>c.generation
        OR (c.amendment_round=0 AND ((c.role='author' AND r.phase NOT IN ('requested','admitted','authoring','snapshot_ready','verifying')) OR (c.role='review' AND r.phase<>'reviewing')))
        OR (c.amendment_round>0 AND NOT (r.phase='amending' AND EXISTS (SELECT 1 FROM change_amendments am WHERE am.change_id=c.change_id AND am.generation=c.generation
          AND am.round=c.amendment_round AND am.state='running'))))
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
    const job = (await this.db.query<{ state: string; wait_reason: string | null; finished_at: string | null }>(`SELECT j.state,j.wait_reason,j.finished_at FROM change_child_jobs c
      JOIN change_generations g ON g.change_id=c.change_id AND g.generation=c.generation JOIN jobs j ON j.id=c.job_id
      WHERE c.change_id=$1 AND c.generation=$2 AND c.role='review' AND c.fix_round=g.fix_round`, [request.id, request.generation])).rows[0];
    if (job) {
      if (!JOB_ENDED.has(job.state)) return false;
      // 멈춤만 확인된 job은 작업자에 결과가 남아 있을 수 있다. fetchReceipt의 null이 작업자 일시 장애일 수 있어 잠시 더 묻는다.
      if (job.wait_reason === 'stop_confirmed_after_unknown' && this.now() - Number(job.finished_at) < 600_000) return false;
      // 같은 차례에서 리뷰를 다시 돌리는 길은 없다. receipt 없이 끝났으면 부모를 닫는다. 고치기 차례는 receipt가 막혔을 때만 연다.
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
      const fixing = await this.selfFix(request, receipt);
      if (fixing !== null) return fixing;
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

  // 게시 전 고치기 차례를 연다. P0·P1이 있는 완전한 리뷰이고 상한 전이며 작성 port가 고치기 요청을 보낼 수 있을 때만이다.
  // null이면 고치지 않는다는 뜻이고 호출자가 지금처럼 닫는다. 차례 시작은 Discord에 알리지 않는다(진행은 기존 입력 중 표시).
  private async selfFix(request: ChangeRequest, receipt: ReviewReceipt): Promise<boolean | null> {
    if (!selfFixable(receipt)) return null;
    const key = keyOf(request);
    const generation = await this.deps.changes.generationRecord(key);
    if (!generation.ok || generation.value.fixRound >= CHANGE_SELF_FIX.maxRounds) return null;
    if (!await this.deps.author.supportsSelfFix()) return null;
    const started = await this.deps.changes.startSelfFix({ ...key, reviewJobId: receipt.jobId });
    if (started.ok) { this.deps.log('change_self_fix_started', { round: started.value.round }); return true; }
    if (started.reason === 'busy') throw new Error('change_store_busy');
    // 앞 차례 작성 결과의 정리(finalize)가 아직이면 정리 바퀴가 끝낼 때까지 기다린다.
    if (started.reason === 'children_active') { this.wait(`step:${request.id}`, this.periods.authorPollMs); return false; }
    if (started.reason === 'phase_conflict') return true;
    this.deps.log('change_self_fix_refused', { reason: started.reason });
    return null;
  }

  // ---- 게시 뒤 수정 차례 (C27) ----

  // proposed에서 열 차례가 기다리는지. 동료 기능 스위치가 꺼져 있거나 자료를 읽을 수 없으면 새 차례를 열지 않는다(돌고 있는 차례는 끝까지 간다).
  private async amendmentWaiting(request: ChangeRequest): Promise<boolean> {
    if (!this.deps.store.colleague || !this.deps.discussion) return false;
    return (await this.db.query(`SELECT 1 FROM change_amendments WHERE change_id=$1 AND generation=$2 AND state='queued' LIMIT 1`, [request.id, request.generation])).rows.length > 0;
  }
  // 부르는 쪽(proposed)이 방금 PR이 열려 있음을 읽은 뒤에만 부른다.
  private async openAmendment(request: ChangeRequest): Promise<boolean> {
    const started = await this.deps.changes.startAmendment(keyOf(request));
    if (started.ok) { this.deps.log('change_amendment_started', { round: started.value.round }); return true; }
    if (started.reason === 'busy') throw new Error('change_store_busy');
    // 기다리는 차례가 있으면 proposed가 바퀴마다 병합 읽기(익명 GitHub, 시간 60회)를 하므로, 열지 못한 채 남으면 읽기 주기로 늦춘다.
    this.deps.log('change_amendment_start_refused', { reason: started.reason });
    this.wait(`step:${request.id}`, this.periods.mergePollMs);
    return false;
  }
  private async runningAmendment(request: ChangeRequest): Promise<AmendmentRound | null> {
    return (await this.deps.changes.amendments(keyOf(request))).find(round => round.state === 'running') ?? null;
  }
  // 차례를 커밋 없이 닫는다. 결과 알림은 sendAmendmentNotices가 owner 호출로 보낸다.
  private async failAmendment(request: ChangeRequest, round: AmendmentRound, reason: string): Promise<boolean> {
    const finished = await this.deps.changes.finishAmendment({ ...keyOf(request), round: round.round, outcome: { state: 'failed', reason: safeReason(reason, 'amendment_failed') } });
    if (!finished.ok && finished.reason === 'busy') throw new Error('change_store_busy');
    if (!finished.ok) this.deps.log('change_amendment_finish_failed', { reason: finished.reason });
    else this.deps.log('change_amendment_failed', { round: round.round, reason: safeReason(reason, 'amendment_failed') });
    return true;
  }
  // 작성·시험 쪽 한 걸음. 작업자 슬롯을 쓰는 일이라 laneTick에서 돈다.
  private async amendLane(request: ChangeRequest): Promise<boolean> {
    const round = await this.runningAmendment(request);
    if (!round) return false;
    if (round.baseCommit === null) return this.pinAmendment(request, round);
    if (round.artifactDigest === null) return this.amendAuthor(request, round);
    const verified = new Map((await this.deps.changes.amendmentVerifications({ ...keyOf(request), round: round.round })).map(item => [item.commandId, item.status]));
    const required = request.brief?.verificationCommandIds ?? [];
    // receipt가 다 있어도 하나라도 통과가 아니면 시험 쪽에서 끝맺는다. 실패 receipt 저장 직후 끊기면 차례를 닫는 일이 여기서만 이어진다.
    if (round.verifierRevision === null || required.some(command => verified.get(command) !== 'passed')) return this.amendVerify(request, round);
    return this.settleAmendAuthor(request, round);
  }
  // 시험이 모두 통과한 차례의 작성 세션 정리. 마지막 통과 receipt 저장 직후 끊기면 amendVerify의 finalize가 빠진다.
  // 정리 바퀴(childrenTick)는 running 차례의 자식을 보지 않으므로 여기서 잇지 않으면 리뷰·게시가 끝날 때까지 작성 job이 작업 레인을 쥔다.
  private async settleAmendAuthor(request: ChangeRequest, round: AmendmentRound): Promise<boolean> {
    const child = await this.amendmentAuthorChild(request, round);
    if (!child.session_generation || child.session_state !== 'running') return false;
    if (child.state === 'cancel_requested') return this.failAmendment(request, round, 'owner_cancelled');
    if (!await this.reacquire(child, false)) return false;
    try { await this.deps.author.finalize(receiptOf(child)); }
    catch (error) { this.deps.log('change_author_finalize_deferred', errorInfo(error)); this.wait(`step:${request.id}`, this.periods.authorPollMs); return false; }
    return true;
  }
  // 차례를 시작하면 PR 브랜치 head를 다시 읽는다. 확인 때의 head이거나, 확인 뒤 head까지가 모두 이 change의 앞선 수정 차례가 올린 커밋이면 그 위에서 쓴다.
  // 차례 커밋은 늘 앞 head를 부모로 하는 fast-forward라, 지금 head가 마지막으로 확정한 수정 커밋(없으면 처음 게시의 head)과 같고 확인 때의 head가
  // 이 change가 올린 커밋 사슬 위에 있으면 그 사이 커밋은 모두 우리 것이다. 그 밖(사람 push 등)은 커밋 없이 head_changed다.
  private async pinAmendment(request: ChangeRequest, round: AmendmentRound): Promise<boolean> {
    const key = keyOf(request);
    const generation = await this.deps.changes.generationRecord(key);
    if (!generation.ok) throw new Error('generation_missing');
    const published = await this.deps.changes.publishedHeadOf(key);
    const pull = await this.pullOf(request);
    const ours = new Set([pull?.headSha, ...(await this.deps.changes.amendments(key)).filter(item => item.state === 'committed').map(item => item.commitSha)].filter(Boolean));
    const head = await this.deps.preflight.readBranchHead({ target: this.target(request), branch: generation.value.branch });
    if (!head || head.sha !== published || !ours.has(round.confirmedHead)) return this.failAmendment(request, round, 'head_changed');
    const commit = await this.deps.preflight.readCommit({ target: this.target(request), sha: head.sha });
    if (!commit) throw new Error('amendment_head_unreadable');
    const pinned = await this.deps.changes.pinAmendmentBase({ ...key, round: round.round, baseCommit: head.sha, baseTree: commit.treeSha });
    if (!pinned.ok && pinned.reason === 'busy') throw new Error('change_store_busy');
    if (!pinned.ok) return this.failAmendment(request, round, pinned.reason);
    return true;
  }
  private async amendmentAuthorChild(request: ChangeRequest, round: AmendmentRound): Promise<ChildRow> {
    const read = async () => (await this.db.query<ChildRow>(`SELECT j.id,j.state,j.wait_reason,j.lease_token,j.lease_until,j.conversation_id,j.owner_id,s.state AS session_state,s.generation AS session_generation,s.updated_at AS session_updated_at
      FROM change_child_jobs c JOIN jobs j ON j.id=c.job_id LEFT JOIN codex_sessions s ON s.job_id=j.id AND s.executor='claude'
      WHERE c.change_id=$1 AND c.generation=$2 AND c.role='author' AND c.amendment_round=$3`, [request.id, request.generation, round.round])).rows[0];
    const existing = await read();
    if (existing) return existing;
    await this.db.transaction(async tx => {
      const parent = (await tx.query<{ phase: string; generation: number | string }>('SELECT phase,generation FROM change_requests WHERE id=$1 FOR UPDATE', [request.id])).rows[0];
      if (!parent || Number(parent.generation) !== request.generation || parent.phase !== 'amending') throw new Error('change_parent_moved');
      if ((await tx.query(`SELECT 1 FROM change_child_jobs WHERE change_id=$1 AND generation=$2 AND role='author' AND amendment_round=$3`, [request.id, request.generation, round.round])).rows.length) return;
      if (await this.deps.store.queueFull('task', tx)) throw new Error('queue_full');
      const now = this.now();
      const job = randomUUID(), event = randomUUID();
      const delivery = `change-author:${request.id}:${request.generation}:a${round.round}`;
      // 작성자 입력은 공개 brief와 차례 입력뿐이다. 이 행에는 원문이 없고 행위자도 owner가 아니라 대화 맥락에 끼지 않는다.
      await tx.query(`INSERT INTO events(id,provider,delivery_id,semantic_key,actor_id,scope,conversation_id,received_at,payload,accepted)
        VALUES ($1,'change',$2,$2,'change-author',$3,$4,$5,$6,true)`, [event, delivery, JSON.stringify(request.scope), request.conversationId, now, JSON.stringify({ command: 'change_author', text: '' })]);
      await tx.query(`INSERT INTO jobs(id,event_id,conversation_id,type,owner_id,target,revision,budget,priority,available_at,created_at)
        VALUES ($1,$2,$3,'task',$4,$5,$6,$7,30,$8,$8)`, [job, event, request.conversationId, request.ownerId, JSON.stringify(request.scope), JSON.stringify({ policy: request.policyRevision }),
        JSON.stringify({ timeoutMs: DEFAULTS.taskTimeoutMs, toolCalls: DEFAULTS.maxToolCalls }), now]);
      await tx.query(`INSERT INTO change_child_jobs(job_id,change_id,generation,role,created_at) VALUES ($1,$2,$3,'author',$4)`, [job, request.id, request.generation, now]);
    });
    return (await read())!;
  }
  private async amendAuthor(request: ChangeRequest, round: AmendmentRound): Promise<boolean> {
    const child = await this.amendmentAuthorChild(request, round);
    if (child.state === 'unknown' && (!child.session_state || WAITING_SESSION.has(child.session_state))) {
      await this.deps.store.requeueChangeAuthor(child.id, child.conversation_id);
      return false;
    }
    if (!child.session_state) {
      if (JOB_ENDED.has(child.state)) return this.failAmendment(request, round, child.wait_reason ?? `author_${child.state}`);
      return this.startAmendAuthor(request, round, child);
    }
    if (WAITING_SESSION.has(child.session_state) && (child.state === 'queued' || child.state === 'running')) return this.resumeAuthor(request, child, round);
    if (WAITING_SESSION.has(child.session_state) && child.state === 'waiting_user') return false;
    return this.pollAuthor(request, child, round);
  }
  private async startAmendAuthor(request: ChangeRequest, round: AmendmentRound, child: ChildRow): Promise<boolean> {
    if (!request.brief || !request.policyRevision || round.baseCommit === null || round.baseTree === null) throw new Error('brief_missing');
    // 작업자가 변경 작성 판을 받지 않으면 수정 차례 칸을 실을 수 없다. 기다려도 같은 답이라 차례를 닫는다.
    if (!await this.deps.author.supportsAmendment()) return this.failAmendment(request, round, 'worker_unsupported');
    const instruction = (await this.deps.inputs.read({ changeId: request.id })).find(row => row.eventId === round.eventId);
    if (!instruction?.text.trim()) return this.failAmendment(request, round, 'input_purged');
    const policy = await this.deps.policy(request.repoId);
    if (!policy) return this.failAmendment(request, round, 'policy_revoked');
    if (policy.revision !== request.policyRevision) return this.failAmendment(request, round, 'policy_changed');
    let items: AmendmentMaterialItem[];
    try {
      const wanted = new Set(round.materials);
      // 확인 때 센 ID 묶음의 글만 쓴다. 그 뒤에 달린 글(앞 차례의 안내 리뷰 포함)은 묶음 밖이라 자료에 들지 않고 다음 차례 몫이다.
      items = discussionMaterials(await this.deps.discussion!({ repository: policy.fullName, pr: round.pullNumber })).filter(item => wanted.has(item.id));
    } catch (error) {
      this.deps.log('change_amendment_materials_failed', errorInfo(error));
      throw error;
    }
    // 묶음 안의 글이 확인 뒤 고쳐지거나 지워졌으면 owner가 보지 않은 피드백이다. 작업 claim·모델 호출 전에 닫아 커밋이 생기지 않게 한다.
    if (amendmentMaterialsDigest(items) !== round.materialsDigest) return this.failAmendment(request, round, 'materials_changed');
    const materials: ReviewMaterial[] = items.map(item => item.material);
    if (child.state === 'queued') {
      if (!this.deps.intakeOpen()) return false;
      if (!await this.deps.store.claimChangeAuthor(child.id)) return false;
    } else if (child.state !== 'running') return false;
    try {
      await this.deps.author.start({ target: this.target(request), baseCommit: round.baseCommit, baseTree: round.baseTree, policyRevision: request.policyRevision, brief: request.brief,
        amendment: { pullNumber: round.pullNumber, head: round.baseCommit, instruction: instruction.text, materials, round: round.round } });
      this.wait(`step:${request.id}`, this.periods.authorPollMs);
      return true;
    } catch (error) {
      const code = error instanceof Error ? error.message : '';
      if (code === 'label_blocked' || code === 'base_tree_incomplete' || code === 'policy_revoked' || code === 'change_brief_too_long') return this.failAmendment(request, round, code);
      const row = (await this.db.query<Job>('SELECT * FROM jobs WHERE id=$1', [child.id])).rows[0];
      if (row && !(await this.sessionState(child.id))) await this.deps.store.defer(row, 'change_start_deferred');
      throw error;
    }
  }
  private async amendVerify(request: ChangeRequest, round: AmendmentRound): Promise<boolean> {
    const key = { ...keyOf(request), round: round.round };
    const author = await this.amendmentAuthorChild(request, round);
    if (author.state === 'cancel_requested') return this.failAmendment(request, round, 'owner_cancelled');
    await this.reacquire(author, false);
    const started = await this.deps.changes.startAmendmentVerification({ ...key, verifierRevision: this.deps.verifierRevision });
    if (!started.ok) {
      if (started.reason === 'busy') throw new Error('change_store_busy');
      return started.reason === 'phase_conflict' ? true : this.failAmendment(request, round, started.reason);
    }
    const required = request.brief?.verificationCommandIds ?? [];
    const statusOf = async () => new Map((await this.deps.changes.amendmentVerifications(key)).map(receipt => [receipt.commandId, receipt.status]));
    let statuses = await statusOf();
    for (const commandId of required) {
      // 저장된 실패가 있으면 뒤 시험을 돌리지 않는다. 재시작 뒤에도 끊기기 전과 같은 결과로 닫는다.
      if (statuses.has(commandId)) { if (statuses.get(commandId) !== 'passed') break; continue; }
      let receipt;
      try { receipt = await this.deps.verification.run({ key, bundle: started.value, commandId }); }
      catch (error) {
        if (error instanceof TaskWorkerBusy) { this.wait(`step:${request.id}`, this.periods.failureBackoffMs); return false; }
        throw error;
      }
      const recorded = await this.deps.changes.recordAmendmentVerification({ ...key, receipt });
      if (!recorded.ok && recorded.reason !== 'receipt_conflict') {
        if (recorded.reason === 'phase_conflict' || recorded.reason === 'amendment_not_running') return true;
        throw new Error(`verification_record_${recorded.reason}`);
      }
      statuses = await statusOf();
      if (statuses.get(commandId) !== 'passed') break;
    }
    const bad = required.map(commandId => statuses.get(commandId)).find(status => status !== 'passed');
    const child = await this.amendmentAuthorChild(request, round).catch(() => null);
    if (child?.state === 'cancel_requested' || child?.state === 'cancelled') return this.failAmendment(request, round, 'owner_cancelled');
    if (child?.session_generation) await this.deps.author.finalize(receiptOf(child)).catch(error => { this.deps.log('change_author_finalize_deferred', errorInfo(error)); });
    if (bad !== undefined) return this.failAmendment(request, round, `verification_${bad ?? 'missing'}`);
    return true;
  }
  // 리뷰·게시 쪽 한 걸음. 수정 중 PR이 병합·닫히면 커밋하지 않고 나간다.
  private async amendPublish(request: ChangeRequest): Promise<boolean> {
    const round = await this.runningAmendment(request);
    if (!round) return false;
    const key = { ...keyOf(request), round: round.round };
    if (this.due(`merge:${request.id}`)) {
      this.wait(`merge:${request.id}`, this.periods.mergePollMs);
      const reading = await this.deps.deployment.readMerge({ target: this.target(request), prNumber: round.pullNumber });
      if (reading.state === 'closed_unmerged') {
        const moved = await this.deps.changes.transition({ ...keyOf(request), from: 'amending', to: 'cancelled', reason: 'closed_unmerged' });
        if (!moved.ok) this.deps.log('change_amendment_close_failed', { reason: moved.reason });
        return true;
      }
      if (reading.state === 'merged') {
        const recorded = await this.deps.changes.recordMerge({ ...keyOf(request), prNumber: reading.prNumber, headSha: reading.headSha, mergeCommit: reading.mergeCommit });
        if (recorded.ok) return true;
        if (recorded.reason === 'head_mismatch') {
          const moved = await this.deps.changes.transition({ ...keyOf(request), from: 'amending', to: 'blocked', reason: 'head_changed' });
          if (!moved.ok) this.deps.log('change_amendment_close_failed', { reason: moved.reason });
          return true;
        }
        this.deps.log('change_amendment_merge_unrecorded', { reason: recorded.reason });
      }
    }
    if (round.artifactDigest === null || round.verifierRevision === null) return false;
    const verifications = await this.deps.changes.amendmentVerifications(key);
    const required = request.brief?.verificationCommandIds ?? [];
    if (required.some(command => verifications.find(item => item.commandId === command)?.status !== 'passed')) return false;
    const receipt = await this.deps.review.fetchReceipt(key);
    if (!receipt) return this.amendReview(request, round, verifications);
    if (receipt.verdict === 'blocked') return this.failAmendment(request, round, receipt.coverage === 'incomplete' ? 'review_incomplete' : 'review_blocked');
    if (!await this.authorized(request)) return true;
    const outcome = await this.deps.publisher.publishAmendment(key, {
      pullOpen: async () => (await this.deps.deployment.readMerge({ target: this.target(request), prNumber: round.pullNumber })).state === 'open' });
    if (outcome.kind !== 'committed' && outcome.kind !== 'failed') this.deps.log('change_amendment_publish', { kind: outcome.kind, ...('reason' in outcome ? { reason: outcome.reason } : { stage: outcome.stage }) });
    switch (outcome.kind) {
      case 'committed': {
        const finished = await this.deps.changes.finishAmendment({ ...key, outcome: { state: 'committed', commitSha: outcome.commitSha } });
        if (!finished.ok && finished.reason === 'busy') throw new Error('change_store_busy');
        this.deps.log('change_amendment_committed', { round: round.round });
        return true;
      }
      case 'failed': return this.failAmendment(request, round, outcome.reason);
      case 'deferred': this.nextAt.set(`step:${request.id}`, outcome.retryAt); return false;
      case 'unknown': this.wait(`step:${request.id}`, 60_000); return false;
      case 'blocked': this.deps.log('change_amendment_blocked', { reason: outcome.reason }); return true;
    }
  }
  private async amendReview(request: ChangeRequest, round: AmendmentRound, verifications: readonly VerificationReceipt[]): Promise<boolean> {
    const key = { ...keyOf(request), round: round.round };
    const job = (await this.db.query<{ state: string; wait_reason: string | null; finished_at: string | null }>(`SELECT j.state,j.wait_reason,j.finished_at FROM change_child_jobs c JOIN jobs j ON j.id=c.job_id
      WHERE c.change_id=$1 AND c.generation=$2 AND c.role='review' AND c.amendment_round=$3`, [request.id, request.generation, round.round])).rows[0];
    if (job) {
      if (!JOB_ENDED.has(job.state)) return false;
      if (job.wait_reason === 'stop_confirmed_after_unknown' && this.now() - Number(job.finished_at) < 600_000) return false;
      return this.failAmendment(request, round, job.wait_reason ?? `review_${job.state}`);
    }
    const bundle = await this.deps.changes.amendmentBundle(key);
    const artifact = await this.deps.changes.loadAmendmentArtifact(key);
    if (!bundle.ok || !artifact.ok || !request.brief) throw new Error('evidence_missing');
    try {
      await this.deps.review.submit({ key, bundle: bundle.value, brief: request.brief, manifest: artifact.value.manifest, patch: artifact.value.patch, verifications });
      return true;
    } catch (error) {
      if (error instanceof ChangeReviewRejected || error instanceof ChangeReviewFailed) {
        if (error.code === 'queue_full') { this.wait(`step:${request.id}`, 60_000); return false; }
        return error.code === 'phase_conflict' ? true : this.failAmendment(request, round, error.code);
      }
      throw error;
    }
  }
  // 끝난 차례의 결과를 owner 호출로 알린다(동료 봇 전환 11의 호출 표에 더한 두 종류: 수정 결과·수정 실패). outbox 키로 한 번만 들어간다.
  // 커밋한 차례는 안내 댓글을 먼저 단다. 안내가 아직이면(미룸·대조 중) 다음 바퀴에 다시 본다. 안내 포트가 없으면 공개 검사를 지난 항목을 모두 요약에 싣는다.
  private async sendAmendmentNotices(): Promise<void> {
    // 안내 댓글 대조(최대 하루)나 정책 조회 실패로 알림을 못 만든 행은 outbox가 없어 계속 앞자리에 남는다. 커서로 돌아 뒤 차례의 알림을 막지 않는다.
    const rows = await this.page('amendment-notices', async after => (await this.db.query<PageRow & { change_id: string; generation: number | string; round: number | string }>(
      `SELECT a.change_id,a.generation,a.round,a.finished_at AS order_at,a.change_id||':'||a.generation||':'||a.round AS id FROM change_amendments a
      WHERE a.state IN ('committed','failed') AND a.finished_at>$1
      AND NOT EXISTS (SELECT 1 FROM outbox o WHERE o.idempotency_key='change-amendment:'||a.change_id||':'||a.generation||':'||a.round)
      AND (a.finished_at,a.change_id||':'||a.generation||':'||a.round)>($2::bigint,$3::text)
      ORDER BY a.finished_at,a.change_id||':'||a.generation||':'||a.round LIMIT $4`, [this.now() - NOTICE_WINDOW_MS, after.at, after.id, STEP_BATCH])).rows);
    for (const row of rows) {
      try { await this.notifyAmendment({ changeId: row.change_id, generation: Number(row.generation), round: Number(row.round) }); }
      catch (error) { this.deps.log('change_amendment_notice_failed', errorInfo(error)); }
    }
  }
  private async notifyAmendment(key: AmendmentKey): Promise<void> {
    const request = await this.deps.changes.get(key.changeId);
    const round = await this.deps.changes.amendment(key);
    if (!request.ok || !round.ok) return;
    const noticeKey = `change-amendment:${key.changeId}:${key.generation}:${key.round}`;
    if (round.value.state === 'failed') {
      await this.send(request.value, noticeKey, AMENDMENT_TEXT.failed(round.value.pullNumber, key.round, round.value.reason ?? 'amendment_failed'), true);
      return;
    }
    const policy = await this.deps.policy(request.value.repoId);
    const artifact = await this.deps.changes.loadAmendmentArtifact(key);
    if (!policy || !artifact.ok || round.value.commitSha === null) throw new Error('amendment_evidence_missing');
    let outside = { checks: artifact.value.checks, risks: artifact.value.risks };
    if (this.guidance) {
      const posted = await this.guidance.post({ key: { changeId: key.changeId, generation: key.generation }, round: key.round, repoId: request.value.repoId, pr: round.value.pullNumber, headSha: round.value.commitSha,
        checks: artifact.value.checks, risks: artifact.value.risks, patch: artifact.value.patch });
      if (posted.state === 'deferred' || posted.state === 'sending' || posted.state === 'unknown') return;
      // outside는 위치·상한으로 나눈 목록이라 실제 게시 여부가 아니다. 줄 댓글이 달리지 않고 끝나면 보내려던 항목도 요약에 실어야 어디에도 안 보이는 일이 없다.
      outside = posted.state === 'posted' ? posted.outside : posted.cleared ?? posted.outside;
    } else {
      const clean = (notes: readonly ChangeNote[]) => notes.filter(note => scanPublicText({ title: note.text, body: note.text }, policy) === null);
      outside = { checks: clean(outside.checks), risks: clean(outside.risks) };
    }
    const verifications = await this.deps.changes.amendmentVerifications(key);
    const changed = artifact.value.manifest.entries.filter(entry => entry.changeKind !== 'unchanged').length;
    const passed = verifications.filter(item => item.status === 'passed').length;
    await this.send(request.value, noticeKey, [AMENDMENT_TEXT.committed(round.value.pullNumber, key.round, changed, passed, verifications.length, artifact.value.checks.length),
      ...(outside.checks.length ? [AMENDMENT_TEXT.checks, ...outside.checks.map(noteLine)] : []), ...(outside.risks.length ? [AMENDMENT_TEXT.risks, ...outside.risks.map(noteLine)] : [])].join('\n'), true);
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
    // 확정된 수정 요청이 기다리면 병합 읽기 주기를 기다리지 않고 지금 읽은 뒤 차례를 연다. 마지막 읽기 뒤 병합·닫힌 PR에 작성 모델·시험을 돌리지 않기 위해서다.
    // 병합 읽기 주기는 따로 센다(merge 슬롯). 읽기에 실패하면 던져 차례를 열지 않고 실패 간격으로 다시 본다.
    const amend = await this.amendmentWaiting(request);
    if (!amend && !this.due(`merge:${request.id}`)) return false;
    this.wait(`merge:${request.id}`, this.periods.mergePollMs);
    const pull = await this.pullOf(request);
    if (!pull) throw new Error('pull_effect_missing');
    await this.guide(request);
    let reading: MergeReading;
    try { reading = await this.deps.deployment.readMerge({ target: this.target(request), prNumber: pull.number }); }
    catch (error) {
      // 기다려도 풀리지 않는 대상 오류다. phase는 유지하되 말없이 멈춰 있지 않게 한 번 알린다.
      if (error instanceof DeploymentTargetError) await this.send(request, `change-merge-unreadable:${request.id}:${request.generation}`,
        CHANGE_NOTICE_TEXT.mergeUnreadable(this.deps.store.colleague, request.id, pull.number, error.code));
      throw error;
    }
    if (reading.state === 'open') return amend ? this.openAmendment(request) : false;
    if (reading.state === 'closed_unmerged') { await this.close(request, 'proposed', { to: 'cancelled', reason: 'closed_unmerged' }); return true; }
    const recorded = await this.deps.changes.recordMerge({ ...keyOf(request), prNumber: reading.prNumber, headSha: reading.headSha, mergeCommit: reading.mergeCommit });
    if (recorded.ok) { this.nextAt.delete(`step:${request.id}`); this.nextAt.delete(`merge:${request.id}`); return true; }
    if (recorded.reason === 'busy') throw new Error('change_store_busy');
    if (recorded.reason === 'head_mismatch') await this.close(request, 'proposed', { to: 'blocked', reason: 'head_changed' });
    else if (recorded.reason === 'pull_mismatch') await this.close(request, 'proposed', { to: 'blocked', reason: 'pull_mismatch' });
    return true;
  }
  // 처음 게시의 안내 댓글. 차례가 끝날 때까지 병합 읽기 주기마다 이어 본다(미룸·응답 유실 대조). 실패는 로그 사유 코드만 남기고 병합 추적을 막지 않는다.
  private async guide(request: ChangeRequest): Promise<void> {
    if (!this.guidance) return;
    const key = keyOf(request);
    try {
      if (await this.guidance.settled(key, 0)) return;
      await this.guidance.afterPublish(key);
    } catch (error) { this.deps.log('change_guidance_failed', errorInfo(error)); }
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
      case 'amending':
        if (!await this.authorized(request)) return true;
        return this.amendPublish(request);
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
    const c = this.deps.store.colleague;
    const key = `change-phase:${request.id}:${request.generation}:${request.phase}`;
    // owner 호출은 게시 승인 요청(미리보기)과 변경 실패 둘만이다. 게시 완료·막힘·취소·대체는 부르지 않는다.
    if (request.phase === 'awaiting_publish_approval') {
      // 게시 승인 버튼은 동료 기능 스위치를 켰을 때만 단다. outbox가 여러 쪽 글의 마지막 쪽에만 버튼을 남긴다.
      await this.send(request, key, await this.preview(request), true, c ? await this.publishButtons(request) : undefined);
      return;
    }
    if (request.phase === 'proposed') {
      const pull = await this.pullOf(request);
      const policy = await this.deps.policy(request.repoId);
      await this.send(request, key, CHANGE_NOTICE_TEXT.published(c, request.id, pull?.number ?? '?', policy?.fullName ?? null));
      return;
    }
    const reason = request.phaseReason ?? request.phase;
    const pull = await this.pullOf(request);
    const tail = request.phase === 'superseded' ? changeNextGeneration(c, request.id) : changeRestart(c);
    const untracked = pull ? CHANGE_NOTICE_TEXT.untracked(c, pull.number) : '';
    const withheld = reason === 'task_question_sensitive' ? CHANGE_NOTICE_TEXT.withheld : '';
    const problems = request.phase === 'blocked' && reason === 'review_blocked' ? await this.remainingProblems(request) : [];
    await this.send(request, key, [`변경 ${request.id} g${request.generation}: ${request.phase}(${reason}).${withheld}${untracked} ${tail}`, ...problems].join('\n'), request.phase === 'failed');
  }
  // 리뷰 막힘으로 닫힌 건의 남은 문제 요지. 리뷰 모델의 글이라 공개 검사를 지난 제목만 싣고, 걸리면 고정 코드로 바꾼다. 조건·근거 원문은 싣지 않는다.
  private async remainingProblems(request: ChangeRequest): Promise<string[]> {
    const key = keyOf(request);
    const findings = await this.deps.review.remainingFindings(key);
    if (!findings.length) return [];
    const generation = await this.deps.changes.generationRecord(key);
    const rounds = generation.ok ? generation.value.fixRound : 0;
    const policy = await this.deps.policy(request.repoId);
    const title = (text: string, code: string) => {
      const line = text.replace(/\s+/g, ' ').trim();
      return policy && scanPublicText({ title: line, body: line }, policy) === null ? line : code;
    };
    return [rounds ? CHANGE_NOTICE_TEXT.selfFixRemaining(this.deps.store.colleague, rounds) : CHANGE_NOTICE_TEXT.selfReviewBlocked,
      ...findings.slice(0, 5).map(finding => `- ${finding.priority} ${title(finding.title, finding.code)}`), ...(findings.length > 5 ? [`- 외 ${findings.length - 5}개`] : [])];
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
  // 요청 스레드에만 보낸다. 고정 코드·SHA·경로와, 승인 본문에 그대로 있는(공개 검사를 지난) 확인할 것·남은 위험 줄만 싣는다. 리뷰 자유문·시험 로그·요청 원문을 싣지 않는다.
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
    const notes = await readChangeNotes(this.db, key);
    if (!notesApproved(subject.publication.body, notes)) throw new Error('preview_evidence_missing');
    const noted = [...(notes.checks.length ? ['확인할 것:', ...notes.checks.map(noteLine)] : []), ...(notes.risks.length ? ['남은 위험:', ...notes.risks.map(noteLine)] : [])];
    const c = this.deps.store.colleague;
    return [CHANGE_NOTICE_TEXT.previewHead(c, request.id, request.generation),
      `제목: ${subject.publication.title}`, `base: ${subject.baseBranch} @ ${subject.bundle.baseCommit}`, `브랜치: ${subject.branch}`, `결과 tree: ${subject.bundle.resultTree}`, `artifact: ${subject.bundle.artifactDigest}`,
      `시험: ${subject.verifications.map(item => `${item.commandId} ${item.status}`).join(', ')}`, `리뷰: ${subject.review.verdict}, 범위 ${subject.review.coverage}`, ...warnings, ...noted,
      `변경 파일 ${changed.length}개:`, ...changed.slice(0, 40).map(entry => `- ${entry.changeKind} ${entry.path}`), ...(changed.length > 40 ? [`- 외 ${changed.length - 40}개`] : []),
      '', CHANGE_NOTICE_TEXT.previewApprove(c, request.id, digest), CHANGE_NOTICE_TEXT.previewBinding(c)].join('\n');
  }
}
