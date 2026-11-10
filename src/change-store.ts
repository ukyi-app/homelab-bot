import { randomUUID } from 'node:crypto';
import {
  AMENDMENT_MATERIAL_ID, ARTIFACT_LIMITS, ApprovalSubjectSchema, ArtifactManifestSchema, CHANGE_AMENDMENT, CHANGE_ID, CHANGE_SELF_FIX, ChangeBriefSchema, DeploymentObservationSchema, EFFECT_LEASE_MS, EFFECT_STAGES,
  EffectExpectedSchema, EffectResultSchema, EvidenceBundleSchema, GENERATION_RESTART, GIT_SHA, MAX_GENERATION, ReasonCodeSchema, ReviewReceiptSchema, RevisionSchema, UNKNOWN_RECONCILE_MS,
  VerificationReceiptSchema, amendmentMaterialsDigest, approvalDigest, artifactDigest, briefDigest, canTransition, changeBranchName, effectResultMatches, evidenceBundleDigest, isTerminalPhase,
  labelAllowsAuthorInput, newChangeId, previousEffectStage, propagateLabel, raiseLabel, reviewReceiptDigest, sha256Hex, validateArtifactFiles, verificationReceiptDigest,
} from './change-contracts.js';
import type {
  AmendmentKey, ApprovalSubject, ArtifactBundle, ArtifactFile, ArtifactManifest, ChangeBrief, ChangeKey, ChangePhase, DeploymentObservation, EffectExpected, EffectResolution, EffectResult,
  EffectStage, EffectState, EvidenceBundle, ProvenanceLabel, PublicMetadata, ReviewReceipt, TerminalChangePhase, VerificationReceipt,
} from './change-contracts.js';
import type { Clock, Scope } from './contracts.js';
import type { Database } from './database.js';

// T19 CHANGE_PR 저장 계층이다. 네트워크를 부르지 않는다. 호출자는 여기서 intent·claim을 커밋한 뒤 트랜잭션 밖에서 GitHub을 부른다.
// 업무상 실패(경합·조건 불충족)는 값으로 돌려주고, 인프라 오류만 던진다. 트리거가 막은 쓰기도 값이 된다.

export type StoreFailureReason =
  | 'not_found' | 'phase_conflict' | 'transition_not_allowed' | 'dedicated_operation' | 'invalid_input' | 'duplicate_event' | 'label_blocked' | 'owner_mismatch'
  | 'base_mismatch' | 'artifact_invalid' | 'artifact_too_large' | 'artifact_conflict' | 'bundle_mismatch' | 'command_not_allowed' | 'receipt_conflict' | 'verification_incomplete'
  | 'review_incomplete' | 'job_not_found' | 'job_not_linked' | 'job_already_linked' | 'digest_mismatch' | 'approval_missing' | 'unresolved_effects'
  | 'effect_conflict' | 'effect_not_due' | 'predecessor_unconfirmed' | 'branch_mismatch' | 'evidence_mismatch' | 'lease_mismatch' | 'result_mismatch'
  | 'head_mismatch' | 'pull_mismatch' | 'deployment_conflict' | 'deployment_stale' | 'generation_limit' | 'input_purged' | 'guard_rejected' | 'busy'
  | 'self_fix_limit' | 'review_not_blocked' | 'children_active' | 'amendment_limit' | 'amendment_not_running';
export interface StoreFailure {
  ok: false; reason: StoreFailureReason; detail?: string;
  current?: { phase: ChangePhase; generation: number };
  existingId?: string;
  // verification_incomplete일 때 command마다 `<id>:missing|<status>`.
  commands?: string[];
}
export type StoreResult<T> = { ok: true; value: T } | StoreFailure;
const success = <T>(value: T): StoreResult<T> => ({ ok: true, value });
const fail = (reason: StoreFailureReason, extra: Omit<StoreFailure, 'ok' | 'reason'> = {}): StoreFailure => ({ ok: false, reason, ...extra });

export interface ChangeRequest {
  id: string; eventId: string; ownerId: string; conversationId: string; scope: Scope; repoId: number; baseBranch: string; generation: number;
  phase: ChangePhase; phaseReason: string | null; label: ProvenanceLabel; policyRevision: string | null; brief: ChangeBrief | null; briefDigest: string | null;
  createdAt: number; updatedAt: number;
}
export interface GenerationRecord {
  changeId: string; generation: number; repoId: number; baseBranch: string; branch: string; baseCommit: string; baseTree: string; policyRevision: string;
  resultTree: string | null; artifactDigest: string | null; verifierRevision: string | null;
  // 게시 전 고치기 차례 번호. 0은 처음 작성이다. 결과·묶음 칸은 늘 이 차례의 것이다.
  fixRound: number;
}
// n번째 고치기 차례를 연 앞 차례의 막힌 리뷰와 증거 digest. 리뷰 자유문은 없다.
export interface SelfFixRound {
  round: number; reviewJobId: string; reviewReceipt: ReviewReceipt; reviewReceiptDigest: string; artifactDigest: string; resultTree: string; verifierRevision: string;
  verifications: { commandId: string; status: string; receiptDigest: string }[]; createdAt: number;
}
export interface EffectRecord {
  changeId: string; generation: number; stage: EffectStage; state: EffectState; requestDigest: string; expected: EffectExpected; approvalDigest: string; attempt: number;
  availableAt: number; leaseId: string | null; leaseUntil: number | null; result: EffectResult | null; failureCode: string | null; reconcileDeadline: number | null;
  blockedReason: string | null; resolution: string | null; resolvedBy: string | null; resolvedAt: number | null;
}
export type StoredDeployment = DeploymentObservation & { prNumber: number };
// 게시 뒤 수정 차례 하나(C27). 지시 원문은 이 행에 없고 eventId로 ChangePrivateInputs에서 읽는다.
export type AmendmentState = 'queued' | 'running' | 'committed' | 'failed';
export interface AmendmentRound {
  changeId: string; generation: number; round: number; state: AmendmentState; eventId: string; label: ProvenanceLabel; pullNumber: number; confirmedHead: string;
  materials: string[]; materialsDigest: string; baseCommit: string | null; baseTree: string | null; resultTree: string | null; artifactDigest: string | null;
  verifierRevision: string | null; commitSha: string | null; reason: string | null; createdAt: number; startedAt: number | null; finishedAt: number | null;
}
export type EffectKey = ChangeKey & { stage: EffectStage };

const num = (value: unknown) => Number(value);
const optional = (value: unknown) => value === null || value === undefined ? null : Number(value);
const parseJson = <T>(value: unknown): T => (typeof value === 'string' ? JSON.parse(value) : value) as T;
const requestRow = (row: Record<string, unknown>): ChangeRequest => ({
  id: row.id as string, eventId: row.event_id as string, ownerId: row.owner_id as string, conversationId: row.conversation_id as string,
  scope: parseJson<Scope>(row.scope), repoId: num(row.repo_id), baseBranch: row.base_branch as string, generation: num(row.generation),
  phase: row.phase as ChangePhase, phaseReason: row.phase_reason as string | null, label: row.label as ProvenanceLabel, policyRevision: row.policy_revision as string | null,
  brief: row.brief === null ? null : parseJson<ChangeBrief>(row.brief), briefDigest: row.brief_digest as string | null, createdAt: num(row.created_at), updatedAt: num(row.updated_at),
});
const generationRow = (row: Record<string, unknown>): GenerationRecord => ({
  changeId: row.change_id as string, generation: num(row.generation), repoId: num(row.repo_id), baseBranch: row.base_branch as string, branch: row.branch as string,
  baseCommit: row.base_commit as string, baseTree: row.base_tree as string, policyRevision: row.policy_revision as string,
  resultTree: row.result_tree as string | null, artifactDigest: row.artifact_digest as string | null, verifierRevision: row.verifier_revision as string | null,
  fixRound: num(row.fix_round ?? 0),
});
const effectRow = (row: Record<string, unknown>): EffectRecord => ({
  changeId: row.change_id as string, generation: num(row.generation), stage: row.stage as EffectStage, state: row.state as EffectState,
  requestDigest: row.request_digest as string, expected: parseJson<EffectExpected>(row.expected), approvalDigest: row.approval_digest as string, attempt: num(row.attempt),
  availableAt: num(row.available_at), leaseId: row.lease_id as string | null, leaseUntil: optional(row.lease_until), result: row.result === null ? null : parseJson<EffectResult>(row.result),
  failureCode: row.failure_code as string | null, reconcileDeadline: optional(row.reconcile_deadline), blockedReason: row.blocked_reason as string | null,
  resolution: row.resolution as string | null, resolvedBy: row.resolved_by as string | null, resolvedAt: optional(row.resolved_at),
});
const amendmentRow = (row: Record<string, unknown>): AmendmentRound => ({
  changeId: row.change_id as string, generation: num(row.generation), round: num(row.round), state: row.state as AmendmentState, eventId: row.event_id as string,
  label: row.label as ProvenanceLabel, pullNumber: num(row.pull_number), confirmedHead: row.confirmed_head as string, materials: parseJson<string[]>(row.materials),
  materialsDigest: row.materials_digest as string, baseCommit: row.base_commit as string | null, baseTree: row.base_tree as string | null,
  resultTree: row.result_tree as string | null, artifactDigest: row.artifact_digest as string | null, verifierRevision: row.verifier_revision as string | null,
  commitSha: row.commit_sha as string | null, reason: row.reason as string | null, createdAt: num(row.created_at), startedAt: optional(row.started_at), finishedAt: optional(row.finished_at),
});
const stageOrder = (stage: string) => EFFECT_STAGES.indexOf(stage as EffectStage);
const toBundle = (generation: GenerationRecord): EvidenceBundle | null => {
  const parsed = EvidenceBundleSchema.safeParse({ repoId: generation.repoId, generation: generation.generation, baseCommit: generation.baseCommit, baseTree: generation.baseTree,
    resultTree: generation.resultTree, artifactDigest: generation.artifactDigest, policyRevision: generation.policyRevision, verifierRevision: generation.verifierRevision });
  return parsed.success ? parsed.data : null;
};
const dedicated = new Set<ChangePhase>(['admitted', 'authoring', 'snapshot_ready', 'verifying', 'reviewing', 'awaiting_publish_approval', 'approved', 'merged', 'amending']);
const isDatabaseError = (error: unknown): error is Error & { code?: string } => error instanceof Error;
// 트리거 사유 코드 중 호출자가 분기할 값은 같은 이름의 사유로, 나머지는 guard_rejected로 넘긴다.
const GUARD_REASONS: Partial<Record<string, StoreFailureReason>> = {
  predecessor_unconfirmed: 'predecessor_unconfirmed', unresolved_effects: 'unresolved_effects', approval_required: 'approval_missing',
  change_not_publishing: 'phase_conflict', transition_not_allowed: 'transition_not_allowed',
};

// 원문을 만지는 코드가 이 함수와 ChangePrivateInputs뿐이어야 한다. 시험이 소스로 확인한다.
async function insertPrivateInput(tx: Database, input: { changeId: string; generation: number; eventId: string; label: ProvenanceLabel; text: string; now: number }): Promise<boolean> {
  const inserted = await tx.query(`INSERT INTO change_request_inputs(event_id,change_id,generation,label,text,text_sha256,created_at)
    VALUES ($1,$2,$3,$4,$5,$6,$7) ON CONFLICT (event_id) DO NOTHING RETURNING event_id`,
  [input.eventId, input.changeId, input.generation, input.label, input.text, sha256Hex(Buffer.from(input.text)), input.now]);
  return inserted.rows.length === 1;
}
const audit = (tx: Database, kind: string, subject: string, detail: unknown, now: number) =>
  tx.query('INSERT INTO audit(kind,subject,detail,created_at) VALUES ($1,$2,$3,$4)', [kind, subject, JSON.stringify(detail), now]);
// 끝난 change에 살아 있는 승인을 남기지 않는다. 안 나간 effect는 공개된 것이 없어 해소까지 끝낸다. 보낸 effect는 대조로 남는다.
async function settleTerminal(tx: Database, key: ChangeKey, reason: string, now: number): Promise<void> {
  await tx.query(`UPDATE change_approvals SET invalidated_at=$3,invalidated_reason=$4 WHERE change_id=$1 AND generation=$2 AND invalidated_at IS NULL`,
    [key.changeId, key.generation, now, reason]);
  await tx.query(`UPDATE change_delivery_effects SET state='blocked',blocked_reason='abandoned_unsent',resolution='not_sent',resolved_by='system',resolved_at=$3,updated_at=$3
    WHERE change_id=$1 AND generation=$2 AND state='pending'`, [key.changeId, key.generation, now]);
}

// 수정 차례를 남긴 채 부모가 끝나거나 병합될 때 부른다. 부모 UPDATE보다 먼저 불러야 한다: amending에서 나가는 UPDATE는 안 나간 차례 effect가 있으면
// 트리거가 막는다. 이미 ref가 확정된 차례는 그 커밋이 PR에 올라간 것이라 committed로 적는다. 보냈는지 모르는 effect는 대조 대상으로 남아 부모를 막는다.
async function closeAmendments(tx: Database, key: ChangeKey, reason: string, now: number): Promise<void> {
  await tx.query(`UPDATE change_amendment_effects SET state='blocked',blocked_reason='abandoned_unsent',resolution='not_sent',resolved_by='system',resolved_at=$3,updated_at=$3
    WHERE change_id=$1 AND generation=$2 AND state='pending'`, [key.changeId, key.generation, now]);
  await tx.query(`UPDATE change_amendments a SET state='committed',commit_sha=e.result->>'sha',finished_at=$3 FROM change_amendment_effects e
    WHERE a.change_id=$1 AND a.generation=$2 AND a.state='running' AND e.change_id=a.change_id AND e.generation=a.generation AND e.round=a.round AND e.stage='ref' AND e.state='confirmed'`,
  [key.changeId, key.generation, now]);
  await tx.query(`UPDATE change_amendments SET state='failed',reason=$3,finished_at=$4 WHERE change_id=$1 AND generation=$2 AND state IN ('queued','running')`,
    [key.changeId, key.generation, reason, now]);
}

// 트랜잭션을 돌리고, 트리거 거부와 잠금 시한 초과를 값으로 바꾼다. 경합의 손해는 호출자가 다시 판단할 일이지 프로세스 오류가 아니다.
// 함정: work가 실패 값을 돌려줘도 커밋한다. 되돌려야 하는 쓰기는 앞에 두지 않고, 검사를 먼저 끝낸다. label_blocked처럼 닫힘을 남기려는 경우만 쓰기 뒤에 실패를 돌려준다.
async function attempt<T>(db: Database, work: (tx: Database) => Promise<StoreResult<T>>): Promise<StoreResult<T>> {
  try {
    return await db.transaction(work);
  } catch (error) {
    if (isDatabaseError(error)) {
      if (error.code === 'CH001') return fail(GUARD_REASONS[error.message] ?? 'guard_rejected', { detail: error.message });
      if (error.code === '55P03' || error.code === '40P01' || error.code === '57014') return fail('busy', { detail: error.code });
    }
    throw error;
  }
}

export class ChangeStore {
  constructor(readonly database: Database, private readonly now: Clock = Date.now) {}

  // ---- 조회 ----

  async get(changeId: string): Promise<StoreResult<ChangeRequest>> {
    const row = (await this.database.query<Record<string, unknown>>('SELECT * FROM change_requests WHERE id=$1', [changeId])).rows[0];
    return row ? success(requestRow(row)) : fail('not_found');
  }
  async generationRecord(key: ChangeKey): Promise<StoreResult<GenerationRecord>> {
    const row = (await this.database.query<Record<string, unknown>>('SELECT * FROM change_generations WHERE change_id=$1 AND generation=$2', [key.changeId, key.generation])).rows[0];
    return row ? success(generationRow(row)) : fail('not_found');
  }
  // 묶음의 모든 필드가 정해진 뒤에만 값이 있다.
  async evidenceBundle(key: ChangeKey): Promise<StoreResult<EvidenceBundle>> {
    const generation = await this.generationRecord(key);
    if (!generation.ok) return generation;
    const bundle = toBundle(generation.value);
    return bundle ? success(bundle) : fail('not_found', { detail: 'bundle_incomplete' });
  }
  async loadArtifact(key: ChangeKey): Promise<StoreResult<ArtifactBundle & { artifactDigest: string; changedBytes: number; label: ProvenanceLabel }>> {
    const row = (await this.database.query<Record<string, unknown>>('SELECT * FROM change_artifacts WHERE change_id=$1 AND generation=$2', [key.changeId, key.generation])).rows[0];
    if (!row) return fail('not_found');
    const files = (await this.database.query<{ path: string; content: Uint8Array }>('SELECT path,content FROM change_artifact_files WHERE change_id=$1 AND generation=$2 ORDER BY path',
      [key.changeId, key.generation])).rows;
    return success({ manifest: parseJson<ArtifactManifest>(row.manifest), patch: row.patch as string, artifactDigest: row.artifact_digest as string, changedBytes: num(row.changed_bytes),
      label: row.label as ProvenanceLabel, files: files.map(file => ({ path: file.path, content: Buffer.from(file.content) })) });
  }
  async approvalSubject(key: ChangeKey): Promise<StoreResult<{ digest: string; subject: ApprovalSubject }>> {
    const row = (await this.database.query<{ approval_digest: string; subject: unknown }>('SELECT approval_digest,subject FROM change_approval_subjects WHERE change_id=$1 AND generation=$2',
      [key.changeId, key.generation])).rows[0];
    return row ? success({ digest: row.approval_digest, subject: parseJson<ApprovalSubject>(row.subject) }) : fail('not_found');
  }
  async deployment(key: ChangeKey): Promise<StoreResult<StoredDeployment>> {
    const row = (await this.database.query<Record<string, unknown>>('SELECT * FROM change_deployments WHERE change_id=$1 AND generation=$2', [key.changeId, key.generation])).rows[0];
    if (!row) return fail('not_found');
    return success({ state: row.state as StoredDeployment['state'], prNumber: num(row.pr_number), headSha: row.head_sha as string, mergeCommit: row.merge_commit as string,
      configCommit: row.config_commit as string | null, imageDigest: row.image_digest as string | null, argoObservedAt: optional(row.argo_observed_at),
      workloadObservedAt: optional(row.workload_observed_at), observedAt: num(row.observed_at), reason: row.reason as string | null });
  }

  // ---- 접수 ----

  // 원문은 공개 경로가 읽지 않는 표로 간다. label은 입력의 label로 시작하고 이후 내려가지 않는다.
  async createRequest(input: {
    eventId: string; ownerId: string; conversationId: string; scope: Scope; repoId: number; baseBranch: string; label: ProvenanceLabel; input: { text: string };
  }): Promise<StoreResult<ChangeRequest>> {
    const id = newChangeId();
    const now = this.now();
    return attempt(this.database, async tx => {
      const row = (await tx.query<Record<string, unknown>>(`INSERT INTO change_requests(id,event_id,owner_id,conversation_id,scope,repo_id,base_branch,label,created_at,updated_at)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$9) ON CONFLICT (event_id) DO NOTHING RETURNING *`,
      [id, input.eventId, input.ownerId, input.conversationId, JSON.stringify(input.scope), input.repoId, input.baseBranch, input.label, now])).rows[0];
      if (!row) {
        const existing = (await tx.query<{ id: string }>('SELECT id FROM change_requests WHERE event_id=$1', [input.eventId])).rows[0];
        return fail('duplicate_event', existing ? { existingId: existing.id } : {});
      }
      await insertPrivateInput(tx, { changeId: id, generation: 1, eventId: input.eventId, label: input.label, text: input.input.text, now });
      await audit(tx, 'change_created', id, { label: input.label, repoId: input.repoId }, now);
      return success(requestRow(row));
    });
  }

  // requested → admitted. 입력·brief의 label이 게시 가능할 때만 지난다. 아니면 그 자리에서 blocked로 닫아 다시 시도하지 못하게 한다.
  async admit(input: ChangeKey & { brief: ChangeBrief; policyRevision: string }): Promise<StoreResult<ChangeRequest>> {
    const parsed = ChangeBriefSchema.safeParse(input.brief);
    if (!parsed.success) return fail('invalid_input', { detail: parsed.error.issues[0]?.message });
    // 이 값은 증거 묶음으로 복사되고 저장 뒤에는 고칠 수 없다. 묶음이 받지 않을 값을 들이면 이 generation이 검증 단계에서 멈춘다.
    if (!RevisionSchema.safeParse(input.policyRevision).success) return fail('invalid_input', { detail: 'policy_revision' });
    const brief = parsed.data;
    return attempt(this.database, async tx => {
      const locked = await this.lock(tx, input, 'requested');
      if (!locked.ok) return locked;
      const request = locked.value;
      if (brief.repoId !== request.repoId || brief.baseBranch !== request.baseBranch) return fail('invalid_input', { detail: 'brief_target_mismatch' });
      const label = raiseLabel(request.label, brief.label);
      const now = this.now();
      if (!labelAllowsAuthorInput(label)) {
        await tx.query(`UPDATE change_requests SET label=$2,phase='blocked',phase_reason='label_blocked',updated_at=$3 WHERE id=$1`, [request.id, label, now]);
        await audit(tx, 'change_phase', request.id, { generation: request.generation, from: 'requested', to: 'blocked', reason: 'label_blocked' }, now);
        return fail('label_blocked');
      }
      const row = (await tx.query<Record<string, unknown>>(`UPDATE change_requests SET label=$2,phase='admitted',phase_reason=NULL,brief=$3,brief_digest=$4,policy_revision=$5,updated_at=$6
        WHERE id=$1 RETURNING *`, [request.id, label, JSON.stringify({ ...brief, label }), briefDigest({ ...brief, label }), input.policyRevision, now])).rows[0]!;
      await audit(tx, 'change_phase', request.id, { generation: request.generation, from: 'requested', to: 'admitted', reason: null }, now);
      return success(requestRow(row));
    });
  }

  // ---- 일반 전이 ----

  // 낙관적 CAS다. 증거 기록을 함께 해야 하는 단계는 전용 메서드로만 간다.
  async transition(input: ChangeKey & { from: ChangePhase; to: ChangePhase; reason: string | null }): Promise<StoreResult<ChangeRequest>> {
    if (input.reason !== null && !ReasonCodeSchema.safeParse(input.reason).success) return fail('invalid_input', { detail: 'reason_code' });
    if (!canTransition(input.from, input.to)) return fail('transition_not_allowed');
    // 수정 차례에서 proposed로 돌아가는 길은 차례 결과를 함께 적는 finishAmendment 하나다.
    if (dedicated.has(input.to) || (input.from === 'amending' && input.to === 'proposed')) return fail('dedicated_operation');
    return attempt(this.database, async tx => this.move(tx, input));
  }

  // 공개 내용·정책·base가 달라졌을 때 쓴다. 승인과 그에 기댄 시험·리뷰를 함께 무효로 하고 끝 상태로 옮긴다. 다시 쓰려면 새 generation이다.
  async invalidateEvidence(input: ChangeKey & { from: ChangePhase; to: Extract<TerminalChangePhase, 'superseded' | 'blocked'>; reason: string }): Promise<StoreResult<ChangeRequest>> {
    if (!ReasonCodeSchema.safeParse(input.reason).success) return fail('invalid_input', { detail: 'reason_code' });
    if (!canTransition(input.from, input.to)) return fail('transition_not_allowed');
    return attempt(this.database, async tx => {
      const moved = await this.move(tx, input);
      if (!moved.ok) return moved;
      const now = this.now();
      for (const table of ['change_verifications', 'change_reviews']) {
        await tx.query(`UPDATE ${table} SET invalidated_at=$3,invalidated_reason=$4 WHERE change_id=$1 AND generation=$2 AND invalidated_at IS NULL`, [input.changeId, input.generation, now, input.reason]);
      }
      await tx.query(`UPDATE change_approvals SET invalidated_at=$3,invalidated_reason=$4 WHERE change_id=$1 AND generation=$2 AND invalidated_at IS NULL`, [input.changeId, input.generation, now, input.reason]);
      return moved;
    });
  }

  // superseded에서만 연다. 어느 generation이든 미해소 effect가 있으면 열지 않는다. 옛 unknown을 지우고 넘어가는 길이 없다.
  async startNextGeneration(key: ChangeKey): Promise<StoreResult<ChangeRequest>> {
    return attempt(this.database, async tx => {
      const locked = await this.lock(tx, key, GENERATION_RESTART.from);
      if (!locked.ok) return locked;
      if (key.generation >= MAX_GENERATION) return fail('generation_limit');
      if ((await tx.query(`SELECT 1 FROM change_delivery_effects WHERE change_id=$1 AND state<>'confirmed' AND resolution IS NULL LIMIT 1`, [key.changeId])).rows.length) return fail('unresolved_effects');
      // 새 generation의 접수는 요청 원문을 다시 읽는다. 보존 기간이 지나 지웠으면 열어도 request_invalid로 막힐 뿐이라 여기서 사유를 돌려준다.
      if (await ChangePrivateInputs.purgedIn(tx, key.changeId)) return fail('input_purged');
      const now = this.now();
      const row = (await tx.query<Record<string, unknown>>(`UPDATE change_requests SET generation=generation+1,phase=$2,phase_reason=NULL,brief=NULL,brief_digest=NULL,policy_revision=NULL,updated_at=$3
        WHERE id=$1 RETURNING *`, [key.changeId, GENERATION_RESTART.to, now])).rows[0]!;
      await audit(tx, 'change_generation', key.changeId, { from: key.generation, to: key.generation + 1 }, now);
      return success(requestRow(row));
    });
  }

  // ---- 작성·스냅샷 ----

  // admitted → authoring. 이 트랜잭션이 B·T0와 브랜치 이름을 고정한다.
  async pinBase(input: ChangeKey & { baseCommit: string; baseTree: string }): Promise<StoreResult<GenerationRecord>> {
    return attempt(this.database, async tx => {
      const locked = await this.lock(tx, input, 'admitted');
      if (!locked.ok) return locked;
      const request = locked.value;
      const now = this.now();
      const row = (await tx.query<Record<string, unknown>>(`INSERT INTO change_generations(change_id,generation,repo_id,base_branch,branch,base_commit,base_tree,policy_revision,created_at)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING *`,
      [request.id, request.generation, request.repoId, request.baseBranch, changeBranchName(request.id, request.generation), input.baseCommit, input.baseTree, request.policyRevision, now])).rows[0]!;
      await this.step(tx, request, 'authoring', now);
      return success(generationRow(row));
    });
  }

  // authoring → snapshot_ready. 같은 결과를 다시 저장하면 멱등이라 응답 유실 뒤 재시도가 안전하다. 성공한 뒤에야 작업자 결과를 지운다.
  async recordSnapshot(input: ChangeKey & { manifest: ArtifactManifest; files: readonly ArtifactFile[]; patch: string; transportBytes: number }): Promise<StoreResult<{ artifactDigest: string; created: boolean }>> {
    const parsed = ArtifactManifestSchema.safeParse(input.manifest);
    if (!parsed.success) return fail('invalid_input', { detail: parsed.error.issues[0]?.message });
    const manifest = parsed.data;
    if (input.transportBytes > ARTIFACT_LIMITS.httpBodyBytes) return fail('artifact_too_large');
    if (sha256Hex(Buffer.from(input.patch)) !== manifest.patchSha256) return fail('artifact_invalid', { detail: 'patch_mismatch' });
    const files = validateArtifactFiles(manifest, input.files);
    if (!files.ok) return fail('artifact_invalid', { detail: files.reason });
    const digest = artifactDigest(manifest);
    return attempt<{ artifactDigest: string; created: boolean }>(this.database, async tx => {
      const request = await this.read(tx, input.changeId);
      if (!request.ok) return request;
      const existing = (await tx.query<{ artifact_digest: string }>('SELECT artifact_digest FROM change_artifacts WHERE change_id=$1 AND generation=$2', [input.changeId, input.generation])).rows[0];
      if (existing) return existing.artifact_digest === digest ? success({ artifactDigest: digest, created: false }) : fail('artifact_conflict');
      const locked = await this.lock(tx, input, 'authoring');
      if (!locked.ok) return locked;
      const generation = (await tx.query<Record<string, unknown>>('SELECT * FROM change_generations WHERE change_id=$1 AND generation=$2', [input.changeId, input.generation])).rows[0];
      if (!generation) return fail('not_found');
      const record = generationRow(generation);
      if (record.baseCommit !== manifest.baseCommit || record.baseTree !== manifest.baseTree) return fail('base_mismatch');
      const now = this.now();
      await tx.query(`INSERT INTO change_artifacts(change_id,generation,artifact_digest,result_tree,manifest,patch,label,changed_bytes,transport_bytes,created_at)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`, [input.changeId, input.generation, digest, manifest.resultTree, JSON.stringify(manifest), input.patch, locked.value.label, files.changedBytes, input.transportBytes, now]);
      for (const file of input.files) {
        await tx.query('INSERT INTO change_artifact_files(change_id,generation,path,content) VALUES ($1,$2,$3,$4)', [input.changeId, input.generation, file.path, Buffer.from(file.content)]);
      }
      await tx.query('UPDATE change_generations SET result_tree=$3,artifact_digest=$4 WHERE change_id=$1 AND generation=$2', [input.changeId, input.generation, manifest.resultTree, digest]);
      await this.step(tx, locked.value, 'snapshot_ready', now);
      return success({ artifactDigest: digest, created: true });
    });
  }

  // ---- 검증 ----

  // snapshot_ready → verifying. 이 호출 뒤에 증거 묶음이 완성된다.
  async startVerification(input: ChangeKey & { verifierRevision: string }): Promise<StoreResult<EvidenceBundle>> {
    return attempt(this.database, async tx => {
      const locked = await this.lock(tx, input, 'snapshot_ready');
      if (!locked.ok) return locked;
      const row = (await tx.query<Record<string, unknown>>('SELECT * FROM change_generations WHERE change_id=$1 AND generation=$2', [input.changeId, input.generation])).rows[0];
      if (!row) return fail('not_found');
      // 쓰기 전에 묶음 전체를 검사한다. 이 칸은 한 번 쓰면 트리거가 고치지 못하게 막아, 잘못된 값이 커밋되면 이 generation을 진행할 수 없다.
      const bundle = toBundle({ ...generationRow(row), verifierRevision: input.verifierRevision });
      if (!bundle) return fail('invalid_input', { detail: 'bundle_invalid' });
      await tx.query('UPDATE change_generations SET verifier_revision=$3 WHERE change_id=$1 AND generation=$2', [input.changeId, input.generation, input.verifierRevision]);
      await this.step(tx, locked.value, 'verifying', this.now());
      return success(bundle);
    });
  }

  async recordVerification(input: ChangeKey & { receipt: VerificationReceipt }): Promise<StoreResult<{ created: boolean; receiptDigest: string }>> {
    const parsed = VerificationReceiptSchema.safeParse(input.receipt);
    if (!parsed.success) return fail('invalid_input', { detail: parsed.error.issues[0]?.message });
    const receipt = parsed.data;
    const digest = verificationReceiptDigest(receipt);
    return attempt<{ created: boolean; receiptDigest: string }>(this.database, async tx => {
      const request = await this.read(tx, input.changeId, 'FOR SHARE');
      if (!request.ok) return request;
      if (request.value.generation !== input.generation) return this.conflict(request.value);
      const existing = (await tx.query<{ receipt_digest: string }>('SELECT receipt_digest FROM change_verifications WHERE change_id=$1 AND generation=$2 AND command_id=$3',
        [input.changeId, input.generation, receipt.commandId])).rows[0];
      if (existing) return existing.receipt_digest === digest ? success({ created: false, receiptDigest: digest }) : fail('receipt_conflict');
      if (request.value.phase !== 'verifying') return this.conflict(request.value);
      if (!request.value.brief?.verificationCommandIds.includes(receipt.commandId)) return fail('command_not_allowed');
      const bundle = await this.currentBundle(tx, input);
      if (!bundle || evidenceBundleDigest(bundle) !== evidenceBundleDigest(receipt.bundle)) return fail('bundle_mismatch');
      const inserted = await tx.query(`INSERT INTO change_verifications(change_id,generation,command_id,status,exit_code,timed_out,log_digest,runner_revision,image_revision,bundle_digest,receipt,receipt_digest,created_at)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13) ON CONFLICT DO NOTHING RETURNING command_id`,
      [input.changeId, input.generation, receipt.commandId, receipt.status, receipt.exitCode, receipt.timedOut, receipt.logDigest, receipt.runnerRevision, receipt.imageRevision,
        evidenceBundleDigest(receipt.bundle), JSON.stringify(receipt), digest, this.now()]);
      if (!inserted.rows.length) return fail('receipt_conflict', { detail: 'concurrent_receipt' });
      return success({ created: true, receiptDigest: digest });
    });
  }

  // verifying → reviewing. 필수 command 전부가 현재 묶음에서 통과했을 때만 지난다.
  async finishVerification(key: ChangeKey): Promise<StoreResult<ChangeRequest>> {
    return attempt(this.database, async tx => {
      const locked = await this.lock(tx, key, 'verifying');
      if (!locked.ok) return locked;
      const problems = await this.verificationProblems(tx, locked.value);
      if (problems.length) return fail('verification_incomplete', { commands: problems });
      return success(await this.step(tx, locked.value, 'reviewing', this.now()));
    });
  }

  // ---- 리뷰·승인 ----

  // 자식 job을 부모에 묶는다. 다시 불러도 멱등이다. 작성 job과 리뷰 job을 role로 구분한다.
  async linkChildJob(input: ChangeKey & { jobId: string; role: 'author' | 'review' }): Promise<StoreResult<{ created: boolean }>> {
    return attempt<{ created: boolean }>(this.database, async tx => {
      // 부모 행을 잡는다. 보존 정리가 부모를 잠그고 재검사한 뒤 커밋하기 전에 새 자식이 끼어들지 못한다.
      if (!(await tx.query('SELECT 1 FROM change_requests WHERE id=$1 FOR SHARE', [input.changeId])).rows.length) return fail('not_found');
      if (!(await tx.query('SELECT 1 FROM jobs WHERE id=$1', [input.jobId])).rows.length) return fail('job_not_found');
      if (!(await tx.query('SELECT 1 FROM change_generations WHERE change_id=$1 AND generation=$2', [input.changeId, input.generation])).rows.length) return fail('not_found');
      const inserted = await tx.query(`INSERT INTO change_child_jobs(job_id,change_id,generation,role,created_at) VALUES ($1,$2,$3,$4,$5) ON CONFLICT (job_id) DO NOTHING RETURNING job_id`,
        [input.jobId, input.changeId, input.generation, input.role, this.now()]);
      if (inserted.rows.length) return success({ created: true });
      const existing = (await tx.query<{ change_id: string; generation: number; role: string }>('SELECT change_id,generation,role FROM change_child_jobs WHERE job_id=$1', [input.jobId])).rows[0];
      return existing && existing.change_id === input.changeId && num(existing.generation) === input.generation && existing.role === input.role
        ? success({ created: false }) : fail('job_already_linked');
    });
  }

  async recordReview(input: ChangeKey & { receipt: ReviewReceipt }): Promise<StoreResult<{ created: boolean; receiptDigest: string }>> {
    const parsed = ReviewReceiptSchema.safeParse(input.receipt);
    if (!parsed.success) return fail('invalid_input', { detail: parsed.error.issues[0]?.message });
    const receipt = parsed.data;
    const digest = reviewReceiptDigest(receipt);
    return attempt<{ created: boolean; receiptDigest: string }>(this.database, async tx => {
      const request = await this.read(tx, input.changeId, 'FOR SHARE');
      if (!request.ok) return request;
      if (request.value.generation !== input.generation) return this.conflict(request.value);
      const existing = (await tx.query<{ receipt_digest: string }>('SELECT receipt_digest FROM change_reviews WHERE change_id=$1 AND generation=$2', [input.changeId, input.generation])).rows[0];
      if (existing) return existing.receipt_digest === digest ? success({ created: false, receiptDigest: digest }) : fail('receipt_conflict');
      if (request.value.phase !== 'reviewing') return this.conflict(request.value);
      const bundle = await this.currentBundle(tx, input);
      if (!bundle || evidenceBundleDigest(bundle) !== evidenceBundleDigest(receipt.bundle)) return fail('bundle_mismatch');
      // 앞 고치기 차례의 리뷰 job은 지금 차례의 receipt를 남기지 못한다.
      const job = await tx.query(`SELECT 1 FROM change_child_jobs c JOIN change_generations g ON g.change_id=c.change_id AND g.generation=c.generation
        WHERE c.job_id=$1 AND c.change_id=$2 AND c.generation=$3 AND c.role='review' AND c.fix_round=g.fix_round`, [receipt.jobId, input.changeId, input.generation]);
      if (!job.rows.length) return fail('job_not_linked');
      const inserted = await tx.query(`INSERT INTO change_reviews(change_id,generation,job_id,session_id,instruction_revision,coverage,verdict,bundle_digest,receipt,receipt_digest,created_at)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) ON CONFLICT DO NOTHING RETURNING job_id`,
      [input.changeId, input.generation, receipt.jobId, receipt.sessionId, receipt.instructionRevision, receipt.coverage, receipt.verdict, evidenceBundleDigest(receipt.bundle), JSON.stringify(receipt), digest, this.now()]);
      if (!inserted.rows.length) return fail('receipt_conflict', { detail: 'concurrent_receipt' });
      return success({ created: true, receiptDigest: digest });
    });
  }

  // reviewing → authoring. 같은 generation의 게시 전 고치기 차례를 연다. 막힌 리뷰와 그 증거의 digest를 차례 기록으로 옮기고
  // 살아 있는 artifact·시험·리뷰·확인할 것 목록과 묶음 결과 칸을 비운다. 그래서 다음 차례의 승인 대상은 새 증거로만 만들어진다. B·T0·브랜치는 그대로다.
  // 어느 리뷰가 고칠 대상인지(P0·P1)는 호출자가 receipt로 정한다. 여기서는 막힌 완전한 리뷰인지와 상한만 본다.
  async startSelfFix(input: ChangeKey & { reviewJobId: string }): Promise<StoreResult<{ round: number }>> {
    return attempt<{ round: number }>(this.database, async tx => {
      const locked = await this.lock(tx, input, 'reviewing');
      if (!locked.ok) return locked;
      const generation = generationRow((await tx.query<Record<string, unknown>>('SELECT * FROM change_generations WHERE change_id=$1 AND generation=$2 FOR UPDATE', [input.changeId, input.generation])).rows[0]!);
      const review = (await tx.query<{ job_id: string; receipt: unknown; receipt_digest: string; coverage: string; verdict: string; invalidated_at: unknown }>(
        'SELECT job_id,receipt,receipt_digest,coverage,verdict,invalidated_at FROM change_reviews WHERE change_id=$1 AND generation=$2', [input.changeId, input.generation])).rows[0];
      if (!review || review.job_id !== input.reviewJobId || review.invalidated_at !== null || review.verdict !== 'blocked' || review.coverage !== 'complete') return fail('review_not_blocked');
      if (generation.fixRound >= CHANGE_SELF_FIX.maxRounds) return fail('self_fix_limit');
      // 앞 차례의 작성·리뷰 실행이 끝나야 한다. 작업자에 남은 결과를 정리하기 전에 새 작성 job을 열면 같은 차례에 결과가 둘이다.
      const active = await tx.query(`SELECT 1 FROM change_child_jobs c JOIN jobs j ON j.id=c.job_id LEFT JOIN codex_sessions s ON s.job_id=c.job_id
        WHERE c.change_id=$1 AND c.generation=$2 AND (j.state IN ('queued','running','verifying','cancel_requested','waiting_user','unknown')
          OR s.state IN ('running','waiting_answer','waiting_model','unknown')) LIMIT 1`, [input.changeId, input.generation]);
      if (active.rows.length) return fail('children_active');
      const verifications = (await tx.query<{ command_id: string; status: string; receipt_digest: string }>(
        'SELECT command_id,status,receipt_digest FROM change_verifications WHERE change_id=$1 AND generation=$2 ORDER BY command_id', [input.changeId, input.generation])).rows;
      const round = generation.fixRound + 1;
      const now = this.now();
      await tx.query(`INSERT INTO change_fix_rounds(change_id,generation,fix_round,review_job_id,review_receipt,review_receipt_digest,artifact_digest,result_tree,verifier_revision,verifications,created_at)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`, [input.changeId, input.generation, round, review.job_id, JSON.stringify(parseJson(review.receipt)), review.receipt_digest,
        generation.artifactDigest, generation.resultTree, generation.verifierRevision,
        JSON.stringify(verifications.map(row => ({ commandId: row.command_id, status: row.status, receiptDigest: row.receipt_digest }))), now]);
      // 확인할 것·남은 위험(change_notes)도 그 차례 작성 결과라 함께 비운다. 남기면 다음 차례 결과의 목록이 기록되지 않고 고치기 전 목록이 PR 본문에 실린다.
      for (const table of ['change_reviews', 'change_verifications', 'change_notes', 'change_artifact_files', 'change_artifacts']) {
        await tx.query(`DELETE FROM ${table} WHERE change_id=$1 AND generation=$2`, [input.changeId, input.generation]);
      }
      await tx.query('UPDATE change_generations SET fix_round=$3,result_tree=NULL,artifact_digest=NULL,verifier_revision=NULL WHERE change_id=$1 AND generation=$2', [input.changeId, input.generation, round]);
      await this.step(tx, locked.value, 'authoring', now);
      await audit(tx, 'change_self_fix', input.changeId, { generation: input.generation, round, review: review.receipt_digest }, now);
      return success({ round });
    });
  }
  async selfFixRounds(key: ChangeKey): Promise<SelfFixRound[]> {
    const rows = (await this.database.query<Record<string, unknown>>('SELECT * FROM change_fix_rounds WHERE change_id=$1 AND generation=$2 ORDER BY fix_round', [key.changeId, key.generation])).rows;
    return rows.map(row => ({ round: num(row.fix_round), reviewJobId: row.review_job_id as string, reviewReceipt: ReviewReceiptSchema.parse(parseJson(row.review_receipt)),
      reviewReceiptDigest: row.review_receipt_digest as string, artifactDigest: row.artifact_digest as string, resultTree: row.result_tree as string,
      verifierRevision: row.verifier_revision as string, verifications: parseJson(row.verifications), createdAt: num(row.created_at) }));
  }

  // reviewing → awaiting_publish_approval. 승인 대상을 DB의 증거로 직접 만들어 호출자가 다른 묶음을 끼워 넣지 못하게 한다.
  async prepareApproval(input: ChangeKey & { publication: PublicMetadata; ciFingerprint: string }): Promise<StoreResult<{ digest: string; subject: ApprovalSubject }>> {
    return attempt(this.database, async tx => {
      const locked = await this.lock(tx, input, 'reviewing');
      if (!locked.ok) return locked;
      const request = locked.value;
      if (!labelAllowsAuthorInput(request.label)) return fail('label_blocked');
      const problems = await this.verificationProblems(tx, request);
      if (problems.length) return fail('verification_incomplete', { commands: problems });
      const review = (await tx.query<{ receipt_digest: string; coverage: string; verdict: string; invalidated_at: unknown }>(
        'SELECT receipt_digest,coverage,verdict,invalidated_at FROM change_reviews WHERE change_id=$1 AND generation=$2', [input.changeId, input.generation])).rows[0];
      if (!review || review.invalidated_at !== null || review.coverage !== 'complete' || review.verdict === 'blocked') return fail('review_incomplete');
      const generation = generationRow((await tx.query<Record<string, unknown>>('SELECT * FROM change_generations WHERE change_id=$1 AND generation=$2', [input.changeId, input.generation])).rows[0]!);
      const verifications = (await tx.query<{ command_id: string; receipt_digest: string }>(`SELECT command_id,receipt_digest FROM change_verifications
        WHERE change_id=$1 AND generation=$2 AND status='passed' AND invalidated_at IS NULL`, [input.changeId, input.generation])).rows;
      const parsed = ApprovalSubjectSchema.safeParse({ changeId: request.id, bundle: toBundle(generation), baseBranch: request.baseBranch, branch: generation.branch,
        verifications: verifications.map(row => ({ commandId: row.command_id, status: 'passed', receiptDigest: row.receipt_digest })),
        review: { receiptDigest: review.receipt_digest, coverage: review.coverage, verdict: review.verdict },
        publication: input.publication, ciFingerprint: input.ciFingerprint });
      if (!parsed.success) return fail('invalid_input', { detail: parsed.error.issues[0]?.message });
      const subject = parsed.data;
      const digest = approvalDigest(subject);
      const now = this.now();
      await tx.query('INSERT INTO change_approval_subjects(change_id,generation,approval_digest,subject,created_at) VALUES ($1,$2,$3,$4,$5)', [input.changeId, input.generation, digest, JSON.stringify(subject), now]);
      await this.step(tx, request, 'awaiting_publish_approval', now);
      return success({ digest, subject });
    });
  }

  // awaiting_publish_approval → approved. /change-publish가 본 정확한 digest에 대한 승인이다.
  async approve(input: ChangeKey & { approvalDigest: string; eventId: string; actor: string }): Promise<StoreResult<ChangeRequest>> {
    return attempt(this.database, async tx => {
      const request = await this.read(tx, input.changeId, 'FOR UPDATE');
      if (!request.ok) return request;
      if ((await tx.query('SELECT 1 FROM change_approvals WHERE event_id=$1', [input.eventId])).rows.length) return fail('duplicate_event');
      if (request.value.generation !== input.generation || request.value.phase !== 'awaiting_publish_approval') return this.conflict(request.value);
      if (request.value.ownerId !== input.actor) return fail('owner_mismatch');
      const subject = (await tx.query<{ approval_digest: string }>('SELECT approval_digest FROM change_approval_subjects WHERE change_id=$1 AND generation=$2', [input.changeId, input.generation])).rows[0];
      if (subject?.approval_digest !== input.approvalDigest) return fail('digest_mismatch');
      const now = this.now();
      await tx.query('INSERT INTO change_approvals(change_id,generation,approval_digest,event_id,approved_by,approved_at) VALUES ($1,$2,$3,$4,$5,$6)',
        [input.changeId, input.generation, input.approvalDigest, input.eventId, input.actor, now]);
      return success(await this.step(tx, request.value, 'approved', now));
    });
  }

  async hasLiveApproval(key: ChangeKey): Promise<boolean> {
    return (await this.database.query('SELECT 1 FROM change_approvals WHERE change_id=$1 AND generation=$2 AND invalidated_at IS NULL', [key.changeId, key.generation])).rows.length > 0;
  }
  // 게시 직전 재검사. 지금 계산한 대상이 승인한 대상과 같은지 본다.
  async checkLiveApproval(input: ChangeKey & { subject: ApprovalSubject }): Promise<StoreResult<{ digest: string }>> {
    const live = (await this.database.query<{ approval_digest: string }>('SELECT approval_digest FROM change_approvals WHERE change_id=$1 AND generation=$2 AND invalidated_at IS NULL',
      [input.changeId, input.generation])).rows[0];
    if (!live) return fail('approval_missing');
    const digest = approvalDigest(input.subject);
    return digest === live.approval_digest ? success({ digest }) : fail('digest_mismatch');
  }

  // ---- 게시 effect ----

  // 네트워크 호출 전에 커밋한다. 같은 key·같은 digest는 멱등이라 재시작한 게시자가 다시 불러도 된다.
  async recordEffectIntent(input: EffectKey & { requestDigest: string; expected: EffectExpected }): Promise<StoreResult<EffectRecord & { created: boolean }>> {
    const parsed = EffectExpectedSchema.safeParse(input.expected);
    if (!parsed.success || parsed.data.stage !== input.stage) return fail('invalid_input', { detail: 'expected_stage' });
    const expected = parsed.data;
    return attempt<EffectRecord & { created: boolean }>(this.database, async tx => {
      const request = await this.read(tx, input.changeId, 'FOR SHARE');
      if (!request.ok) return request;
      if (request.value.generation !== input.generation) return this.conflict(request.value);
      const existing = await this.readEffect(tx, input);
      if (existing) return existing.requestDigest === input.requestDigest ? success({ ...existing, created: false }) : fail('effect_conflict');
      if (request.value.phase !== 'publishing') return this.conflict(request.value);
      const approval = (await tx.query<{ approval_digest: string }>('SELECT approval_digest FROM change_approvals WHERE change_id=$1 AND generation=$2 AND invalidated_at IS NULL',
        [input.changeId, input.generation])).rows[0];
      if (!approval) return fail('approval_missing');
      const previous = previousEffectStage(input.stage);
      const prior = previous ? await this.readEffect(tx, { ...input, stage: previous }) : null;
      if (previous && prior?.state !== 'confirmed') return fail('predecessor_unconfirmed');
      const evidence = await this.effectMatchesEvidence(tx, input, expected, prior);
      if (!evidence.ok) return evidence;
      const now = this.now();
      const row = (await tx.query<Record<string, unknown>>(`INSERT INTO change_delivery_effects(change_id,generation,stage,approval_digest,request_digest,expected,available_at,created_at,updated_at)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$8) ON CONFLICT DO NOTHING RETURNING *`,
      [input.changeId, input.generation, input.stage, approval.approval_digest, input.requestDigest, JSON.stringify(expected), now, now])).rows[0];
      if (row) return success({ ...effectRow(row), created: true });
      const raced = await this.readEffect(tx, input);
      if (raced) return raced.requestDigest === input.requestDigest ? success({ ...raced, created: false }) : fail('effect_conflict');
      return fail('unresolved_effects');
    });
  }

  // pending → sending. 이 커밋이 전송 권한이다. lease 없는 전송은 없다.
  async claimEffect(key: EffectKey): Promise<StoreResult<EffectRecord & { leaseId: string; leaseUntil: number }>> {
    return attempt(this.database, async tx => {
      const request = await this.read(tx, key.changeId, 'FOR SHARE');
      if (!request.ok) return request;
      const effect = await this.readEffect(tx, key);
      if (!effect) return fail('not_found');
      if (request.value.generation !== key.generation || request.value.phase !== 'publishing') return this.conflict(request.value);
      if (effect.state !== 'pending') return fail('effect_conflict');
      const live = await tx.query('SELECT 1 FROM change_approvals WHERE change_id=$1 AND generation=$2 AND approval_digest=$3 AND invalidated_at IS NULL', [key.changeId, key.generation, effect.approvalDigest]);
      if (!live.rows.length) return fail('approval_missing');
      const now = this.now();
      if (effect.availableAt > now) return fail('effect_not_due');
      const leaseId = randomUUID();
      const leaseUntil = now + EFFECT_LEASE_MS;
      const row = (await tx.query<Record<string, unknown>>(`UPDATE change_delivery_effects SET state='sending',attempt=attempt+1,lease_id=$4,lease_until=$5,updated_at=$6
        WHERE change_id=$1 AND generation=$2 AND stage=$3 AND state='pending' RETURNING *`, [key.changeId, key.generation, key.stage, leaseId, leaseUntil, now])).rows[0];
      if (!row) return fail('effect_conflict');
      return success({ ...effectRow(row), leaseId, leaseUntil });
    });
  }

  async renewEffectLease(input: EffectKey & { leaseId: string }): Promise<StoreResult<{ leaseUntil: number }>> {
    const now = this.now();
    const leaseUntil = now + EFFECT_LEASE_MS;
    const row = (await this.database.query(`UPDATE change_delivery_effects SET lease_until=$5,updated_at=$6
      WHERE change_id=$1 AND generation=$2 AND stage=$3 AND state='sending' AND lease_id=$4 RETURNING stage`, [input.changeId, input.generation, input.stage, input.leaseId, leaseUntil, now])).rows[0];
    return row ? success({ leaseUntil }) : fail('lease_mismatch');
  }

  // 연결 전 실패처럼 확실히 안 나간 경우에만 쓴다. 조금이라도 불명확하면 markEffectUnknown이다.
  // 그사이 부모가 게시 단계를 떠났으면 다시 보낼 일이 없다. pending으로 두면 claim도 만료 처리도 못 건드려 다음 generation이 영영 막히므로 안 나간 것으로 해소한다.
  async releaseUnsentEffect(input: EffectKey & { leaseId: string; retryAt: number }): Promise<StoreResult<EffectRecord>> {
    return attempt(this.database, async tx => {
      const request = await this.read(tx, input.changeId, 'FOR SHARE');
      if (!request.ok) return request;
      const now = this.now();
      const publishing = request.value.generation === input.generation && request.value.phase === 'publishing';
      const row = (publishing
        ? await tx.query<Record<string, unknown>>(`UPDATE change_delivery_effects SET state='pending',lease_id=NULL,lease_until=NULL,available_at=$5,updated_at=$6
            WHERE change_id=$1 AND generation=$2 AND stage=$3 AND state='sending' AND lease_id=$4 RETURNING *`, [input.changeId, input.generation, input.stage, input.leaseId, input.retryAt, now])
        : await tx.query<Record<string, unknown>>(`UPDATE change_delivery_effects SET state='blocked',blocked_reason='abandoned_unsent',resolution='not_sent',resolved_by='system',resolved_at=$5,lease_id=NULL,lease_until=NULL,updated_at=$5
            WHERE change_id=$1 AND generation=$2 AND stage=$3 AND state='sending' AND lease_id=$4 RETURNING *`, [input.changeId, input.generation, input.stage, input.leaseId, now])).rows[0];
      return row ? success(effectRow(row)) : fail('lease_mismatch');
    });
  }

  async markEffectUnknown(input: EffectKey & { leaseId: string; code: string }): Promise<StoreResult<EffectRecord>> {
    if (!ReasonCodeSchema.safeParse(input.code).success) return fail('invalid_input', { detail: 'reason_code' });
    const now = this.now();
    const row = (await this.database.query<Record<string, unknown>>(`UPDATE change_delivery_effects SET state='unknown',lease_id=NULL,lease_until=NULL,failure_code=$5,reconcile_deadline=$6,updated_at=$7
      WHERE change_id=$1 AND generation=$2 AND stage=$3 AND state='sending' AND lease_id=$4 RETURNING *`, [input.changeId, input.generation, input.stage, input.leaseId, input.code, now + UNKNOWN_RECONCILE_MS, now])).rows[0];
    return row ? success(effectRow(row)) : fail('lease_mismatch');
  }

  // 임대가 끝난 전송은 나갔는지 모른다. 게시자가 재시작할 때 이 메서드로 대조 대상으로 옮긴다.
  async expireSendingEffects(): Promise<EffectRecord[]> {
    const now = this.now();
    const rows = (await this.database.query<Record<string, unknown>>(`UPDATE change_delivery_effects SET state='unknown',lease_id=NULL,lease_until=NULL,failure_code='lease_expired',reconcile_deadline=$1,updated_at=$2
      WHERE state='sending' AND lease_until<=$2 RETURNING *`, [now + UNKNOWN_RECONCILE_MS, now])).rows;
    return rows.map(effectRow);
  }

  // leaseId가 null이면 unknown 대조의 확정이다. 응답은 저장한 기대값과 같아야 한다. 다르면 확정하지 않고 호출자가 멈춘다.
  async confirmEffect(input: EffectKey & { leaseId: string | null; result: EffectResult }): Promise<StoreResult<EffectRecord>> {
    const parsed = EffectResultSchema.safeParse(input.result);
    if (!parsed.success) return fail('invalid_input', { detail: 'result_shape' });
    return attempt(this.database, async tx => {
      const effect = await this.readEffect(tx, input);
      if (!effect) return fail('not_found');
      if (effect.state !== 'sending' && effect.state !== 'unknown') return fail('effect_conflict');
      if (effect.state === 'sending' && effect.leaseId !== input.leaseId) return fail('lease_mismatch');
      if (!effectResultMatches(effect.expected, parsed.data)) return fail('result_mismatch');
      const row = (await tx.query<Record<string, unknown>>(`UPDATE change_delivery_effects SET state='confirmed',lease_id=NULL,lease_until=NULL,result=$5,updated_at=$6
        WHERE change_id=$1 AND generation=$2 AND stage=$3 AND state=$4 RETURNING *`, [input.changeId, input.generation, input.stage, effect.state, JSON.stringify(parsed.data), this.now()])).rows[0];
      return row ? success(effectRow(row)) : fail('effect_conflict');
    });
  }

  // 게시 중인 부모도 함께 닫는다. 부모를 먼저 잠가 전이와 잠금 순서를 맞춘다.
  async blockEffect(input: EffectKey & { reason: string }): Promise<StoreResult<EffectRecord>> {
    if (!ReasonCodeSchema.safeParse(input.reason).success) return fail('invalid_input', { detail: 'reason_code' });
    return attempt(this.database, async tx => {
      const request = await this.read(tx, input.changeId, 'FOR UPDATE');
      if (!request.ok) return request;
      const now = this.now();
      const row = (await tx.query<Record<string, unknown>>(`UPDATE change_delivery_effects SET state='blocked',blocked_reason=$4,lease_id=NULL,lease_until=NULL,updated_at=$5
        WHERE change_id=$1 AND generation=$2 AND stage=$3 AND state IN ('pending','sending','unknown') RETURNING *`, [input.changeId, input.generation, input.stage, input.reason, now])).rows[0];
      if (!row) return fail('effect_conflict');
      if (request.value.generation === input.generation && request.value.phase === 'publishing') {
        const moved = await this.move(tx, { changeId: input.changeId, generation: input.generation, from: 'publishing', to: 'blocked', reason: 'effect_blocked' });
        if (!moved.ok) return moved;
      }
      return success(effectRow(row));
    });
  }

  // 대조 기한이 지난 unknown을 사람 해소로 넘긴다. 행을 지우지 않아 게시는 계속 막혀 있다.
  async blockExpiredUnknownEffects(): Promise<EffectRecord[]> {
    const due = (await this.database.query<Record<string, unknown>>(`SELECT * FROM change_delivery_effects WHERE state='unknown' AND reconcile_deadline<=$1 ORDER BY reconcile_deadline`, [this.now()])).rows.map(effectRow);
    const blocked: EffectRecord[] = [];
    for (const effect of due) {
      const result = await this.blockEffect({ changeId: effect.changeId, generation: effect.generation, stage: effect.stage, reason: 'unknown_deadline' });
      if (result.ok) blocked.push(result.value);
    }
    return blocked;
  }

  // 사람이 GitHub을 직접 확인한 뒤의 기록이다. 해소돼도 행은 남고 그 generation의 다음 stage는 열리지 않는다.
  async resolveBlockedEffect(input: EffectKey & { actor: string; resolution: EffectResolution }): Promise<StoreResult<EffectRecord>> {
    return attempt(this.database, async tx => {
      const request = await this.read(tx, input.changeId);
      if (!request.ok) return request;
      const effect = await this.readEffect(tx, input);
      if (!effect) return fail('not_found');
      if (effect.state !== 'blocked' || effect.resolution !== null) return fail('effect_conflict');
      if (request.value.ownerId !== input.actor) return fail('owner_mismatch');
      const now = this.now();
      const row = (await tx.query<Record<string, unknown>>(`UPDATE change_delivery_effects SET resolution=$4,resolved_by=$5,resolved_at=$6,updated_at=$6
        WHERE change_id=$1 AND generation=$2 AND stage=$3 AND state='blocked' AND resolution IS NULL RETURNING *`, [input.changeId, input.generation, input.stage, input.resolution, input.actor, now])).rows[0];
      if (!row) return fail('effect_conflict');
      await audit(tx, 'change_effect_resolved', input.changeId, { generation: input.generation, stage: input.stage, resolution: input.resolution }, now);
      return success(effectRow(row));
    });
  }

  // 미확정 effect 검사. 비어 있지 않으면 새 게시를 시작하지 않는다. changeId 없이 부르면 게시자 재시작 때 대조할 전체 목록이다.
  async unresolvedEffects(filter: { changeId?: string; generation?: number } = {}): Promise<EffectRecord[]> {
    const rows = (await this.database.query<Record<string, unknown>>(`SELECT * FROM change_delivery_effects
      WHERE state<>'confirmed' AND resolution IS NULL AND ($1::text IS NULL OR change_id=$1) AND ($2::integer IS NULL OR generation=$2)`, [filter.changeId ?? null, filter.generation ?? null])).rows;
    return rows.map(effectRow).sort((a, b) => a.generation - b.generation || stageOrder(a.stage) - stageOrder(b.stage));
  }

  // ---- 게시 뒤 수정 차례 (C27) ----

  // 확정된 수정 요청을 대기열에 넣는다. 부모가 proposed거나 다른 차례가 돌고 있을 때만 받는다(병합·닫힘·끝난 change는 거부).
  // 한 generation의 차례는 대기열·실패한 것까지 CHANGE_AMENDMENT.maxRounds번이다. 지시 원문은 공개 경로가 읽지 않는 입력 표에 둔다.
  // 차례를 시작하지는 않는다. 시작은 런타임이 스위치·PR 상태를 본 뒤 startAmendment로 한다.
  async requestAmendment(input: ChangeKey & {
    eventId: string; actor: string; pullNumber: number; head: string; materials: readonly string[]; instruction: string; label: ProvenanceLabel;
  }): Promise<StoreResult<AmendmentRound>> {
    if (!GIT_SHA.test(input.head) || !Number.isInteger(input.pullNumber) || input.pullNumber < 1) return fail('invalid_input', { detail: 'pull' });
    if (input.materials.some(id => !AMENDMENT_MATERIAL_ID.test(id)) || new Set(input.materials).size !== input.materials.length) return fail('invalid_input', { detail: 'materials' });
    if (!input.instruction.trim()) return fail('invalid_input', { detail: 'instruction' });
    if (!labelAllowsAuthorInput(input.label)) return fail('label_blocked');
    return attempt<AmendmentRound>(this.database, async tx => {
      const request = await this.read(tx, input.changeId, 'FOR UPDATE');
      if (!request.ok) return request;
      const existing = (await tx.query<Record<string, unknown>>('SELECT * FROM change_amendments WHERE event_id=$1', [input.eventId])).rows[0];
      if (existing) return fail('duplicate_event', { existingId: `${existing.change_id as string}:${num(existing.round)}` });
      if (request.value.ownerId !== input.actor) return fail('owner_mismatch');
      if (request.value.generation !== input.generation || (request.value.phase !== 'proposed' && request.value.phase !== 'amending')) return this.conflict(request.value);
      const pull = await this.readEffect(tx, { ...input, stage: 'pull' });
      if (pull?.result?.stage !== 'pull' || pull.result.number !== input.pullNumber) return fail('pull_mismatch');
      const last = num((await tx.query<{ n: unknown }>('SELECT COALESCE(max(round),0) AS n FROM change_amendments WHERE change_id=$1 AND generation=$2', [input.changeId, input.generation])).rows[0]!.n);
      if (last >= CHANGE_AMENDMENT.maxRounds) return fail('amendment_limit');
      const now = this.now();
      if (!await insertPrivateInput(tx, { changeId: input.changeId, generation: input.generation, eventId: input.eventId, label: input.label, text: input.instruction, now })) return fail('duplicate_event');
      const row = (await tx.query<Record<string, unknown>>(`INSERT INTO change_amendments(change_id,generation,round,state,event_id,label,pull_number,confirmed_head,materials,materials_digest,created_at)
        VALUES ($1,$2,$3,'queued',$4,$5,$6,$7,$8,$9,$10) RETURNING *`, [input.changeId, input.generation, last + 1, input.eventId, input.label, input.pullNumber, input.head,
        JSON.stringify(input.materials), amendmentMaterialsDigest(input.materials), now])).rows[0]!;
      await audit(tx, 'change_amendment_requested', input.changeId, { generation: input.generation, round: last + 1, materials: input.materials.length }, now);
      return success(amendmentRow(row));
    });
  }

  // proposed → amending. 대기열의 가장 앞 차례를 running으로 바꾼다. 부모를 잠그므로 동시에 불러도 차례는 하나만 시작된다.
  async startAmendment(key: ChangeKey): Promise<StoreResult<AmendmentRound>> {
    return attempt<AmendmentRound>(this.database, async tx => {
      const locked = await this.lock(tx, key, 'proposed');
      if (!locked.ok) return locked;
      const next = (await tx.query<Record<string, unknown>>(`SELECT * FROM change_amendments WHERE change_id=$1 AND generation=$2 AND state='queued' ORDER BY round LIMIT 1`,
        [key.changeId, key.generation])).rows[0];
      if (!next) return fail('not_found');
      const now = this.now();
      const row = (await tx.query<Record<string, unknown>>(`UPDATE change_amendments SET state='running',started_at=$4 WHERE change_id=$1 AND generation=$2 AND round=$3 RETURNING *`,
        [key.changeId, key.generation, num(next.round), now])).rows[0]!;
      await this.step(tx, locked.value, 'amending', now);
      return success(amendmentRow(row));
    });
  }

  // amending → proposed. 차례 결과(커밋 또는 실패 사유)를 적고 돌아간다. 다음 차례는 런타임이 다시 startAmendment로 연다.
  async finishAmendment(input: AmendmentKey & { outcome: { state: 'committed'; commitSha: string } | { state: 'failed'; reason: string } }): Promise<StoreResult<AmendmentRound>> {
    if (input.outcome.state === 'failed' && !ReasonCodeSchema.safeParse(input.outcome.reason).success) return fail('invalid_input', { detail: 'reason_code' });
    if (input.outcome.state === 'committed' && !GIT_SHA.test(input.outcome.commitSha)) return fail('invalid_input', { detail: 'commit' });
    return attempt<AmendmentRound>(this.database, async tx => {
      const locked = await this.lock(tx, input, 'amending');
      if (!locked.ok) return locked;
      const now = this.now();
      const outcome = input.outcome;
      const row = (await tx.query<Record<string, unknown>>(`UPDATE change_amendments SET state=$4,commit_sha=$5,reason=$6,finished_at=$7
        WHERE change_id=$1 AND generation=$2 AND round=$3 AND state='running' RETURNING *`, [input.changeId, input.generation, input.round, outcome.state,
        outcome.state === 'committed' ? outcome.commitSha : null, outcome.state === 'failed' ? outcome.reason : null, now])).rows[0];
      if (!row) return fail('amendment_not_running');
      await this.step(tx, locked.value, 'proposed', now);
      await audit(tx, 'change_amendment_finished', input.changeId, { generation: input.generation, round: input.round, state: outcome.state,
        reason: outcome.state === 'failed' ? outcome.reason : null }, now);
      return success(amendmentRow(row));
    });
  }

  async amendments(key: ChangeKey): Promise<AmendmentRound[]> {
    return (await this.database.query<Record<string, unknown>>('SELECT * FROM change_amendments WHERE change_id=$1 AND generation=$2 ORDER BY round', [key.changeId, key.generation])).rows.map(amendmentRow);
  }
  async amendment(key: AmendmentKey): Promise<StoreResult<AmendmentRound>> {
    const row = (await this.database.query<Record<string, unknown>>('SELECT * FROM change_amendments WHERE change_id=$1 AND generation=$2 AND round=$3',
      [key.changeId, key.generation, key.round])).rows[0];
    return row ? success(amendmentRow(row)) : fail('not_found');
  }
  // 지금 PR 브랜치에 올라가 있어야 하는 head. 마지막으로 ref가 확정된 수정 커밋이고, 없으면 처음 게시의 head다.
  async publishedHeadOf(key: ChangeKey): Promise<string | null> {
    const pull = await this.readEffect(this.database, { ...key, stage: 'pull' });
    return pull?.result?.stage === 'pull' ? this.publishedHead(this.database, key, pull.result.headSha) : null;
  }
  private async publishedHead(tx: Database, key: ChangeKey, pullHead: string): Promise<string> {
    const row = (await tx.query<{ sha: string }>(`SELECT result->>'sha' AS sha FROM change_amendment_effects WHERE change_id=$1 AND generation=$2 AND stage='ref' AND state='confirmed'
      ORDER BY round DESC LIMIT 1`, [key.changeId, key.generation])).rows[0];
    return row?.sha ?? pullHead;
  }

  // ---- 병합·배포 ----

  // proposed → merged. 게시한 PR·head가 아니면 옮기지 않는다. 사람이 head를 바꿨다면 호출자가 blocked(head_changed)로 닫는다.
  // 수정 차례(C27) 중에도 받는다. 게시한 head는 마지막으로 ref가 확정된 수정 커밋이고, 없으면 처음 게시의 head다. 남은 차례는 커밋 없이 닫는다.
  async recordMerge(input: ChangeKey & { prNumber: number; headSha: string; mergeCommit: string }): Promise<StoreResult<ChangeRequest>> {
    return attempt(this.database, async tx => {
      const request = await this.read(tx, input.changeId, 'FOR UPDATE');
      if (!request.ok) return request;
      if (request.value.generation !== input.generation || (request.value.phase !== 'proposed' && request.value.phase !== 'amending')) return this.conflict(request.value);
      const locked = request;
      const pull = await this.readEffect(tx, { ...input, stage: 'pull' });
      if (pull?.result?.stage !== 'pull') return fail('pull_mismatch');
      if (pull.result.number !== input.prNumber) return fail('pull_mismatch');
      if ((await this.publishedHead(tx, input, pull.result.headSha)) !== input.headSha) return fail('head_mismatch');
      const now = this.now();
      await closeAmendments(tx, input, 'pr_merged', now);
      await tx.query(`INSERT INTO change_deployments(change_id,generation,pr_number,head_sha,merge_commit,observed_at,state) VALUES ($1,$2,$3,$4,$5,$6,'pending')`,
        [input.changeId, input.generation, input.prNumber, input.headSha, input.mergeCommit, now]);
      return success(await this.step(tx, locked.value, 'merged', now));
    });
  }

  // 늦게 도착한 옛 관측이 새 관측을 덮지 못한다. H·M이 다르면 다른 사건이라 기록하지 않는다.
  async recordDeployment(input: ChangeKey & { observation: DeploymentObservation }): Promise<StoreResult<StoredDeployment>> {
    const parsed = DeploymentObservationSchema.safeParse(input.observation);
    if (!parsed.success) return fail('invalid_input', { detail: parsed.error.issues[0]?.message });
    const observation = parsed.data;
    return attempt(this.database, async tx => {
      const request = await this.read(tx, input.changeId, 'FOR SHARE');
      if (!request.ok) return request;
      if (request.value.generation !== input.generation || (request.value.phase !== 'merged' && request.value.phase !== 'observing_deploy')) return this.conflict(request.value);
      const current = (await tx.query<{ head_sha: string; merge_commit: string; observed_at: unknown; pr_number: unknown }>('SELECT head_sha,merge_commit,observed_at,pr_number FROM change_deployments WHERE change_id=$1 AND generation=$2 FOR UPDATE',
        [input.changeId, input.generation])).rows[0];
      if (!current) return fail('not_found');
      if (current.head_sha !== observation.headSha || current.merge_commit !== observation.mergeCommit) return fail('deployment_conflict');
      if (observation.observedAt < num(current.observed_at)) return fail('deployment_stale');
      await tx.query(`UPDATE change_deployments SET config_commit=$3,image_digest=$4,argo_observed_at=$5,workload_observed_at=$6,observed_at=$7,state=$8,reason=$9 WHERE change_id=$1 AND generation=$2`,
        [input.changeId, input.generation, observation.configCommit, observation.imageDigest, observation.argoObservedAt, observation.workloadObservedAt, observation.observedAt, observation.state, observation.reason]);
      return success({ ...observation, prNumber: num(current.pr_number) });
    });
  }

  // ---- 내부 ----

  private conflict(request: ChangeRequest): StoreFailure {
    return fail('phase_conflict', { current: { phase: request.phase, generation: request.generation } });
  }
  private async read(tx: Database, changeId: string, lock: '' | 'FOR SHARE' | 'FOR UPDATE' = ''): Promise<StoreResult<ChangeRequest>> {
    if (!CHANGE_ID.test(changeId)) return fail('not_found');
    const row = (await tx.query<Record<string, unknown>>(`SELECT * FROM change_requests WHERE id=$1 ${lock}`, [changeId])).rows[0];
    return row ? success(requestRow(row)) : fail('not_found');
  }
  private async lock(tx: Database, key: ChangeKey, phase: ChangePhase): Promise<StoreResult<ChangeRequest>> {
    const request = await this.read(tx, key.changeId, 'FOR UPDATE');
    if (!request.ok) return request;
    return request.value.generation === key.generation && request.value.phase === phase ? request : this.conflict(request.value);
  }
  // 호출자가 이미 부모를 잠근 상태에서 부른다.
  private async step(tx: Database, request: ChangeRequest, to: ChangePhase, now: number): Promise<ChangeRequest> {
    const row = (await tx.query<Record<string, unknown>>(`UPDATE change_requests SET phase=$2,phase_reason=NULL,updated_at=$3 WHERE id=$1 RETURNING *`, [request.id, to, now])).rows[0]!;
    await audit(tx, 'change_phase', request.id, { generation: request.generation, from: request.phase, to, reason: null }, now);
    return requestRow(row);
  }
  private async move(tx: Database, input: ChangeKey & { from: ChangePhase; to: ChangePhase; reason: string | null }): Promise<StoreResult<ChangeRequest>> {
    const now = this.now();
    // 수정 차례(대기열 포함)가 있을 수 있는 단계에서 끝날 때는 차례를 먼저 닫는다. 쓰기 전에 CAS를 확인해 실패 값으로 커밋되는 쓰기가 없게 한다.
    if (isTerminalPhase(input.to) && (input.from === 'proposed' || input.from === 'amending')) {
      const current = await this.read(tx, input.changeId, 'FOR UPDATE');
      if (!current.ok) return current;
      if (current.value.generation !== input.generation || current.value.phase !== input.from) return this.conflict(current.value);
      await closeAmendments(tx, input, input.reason ?? input.to, now);
    }
    const row = (await tx.query<Record<string, unknown>>(`UPDATE change_requests SET phase=$4,phase_reason=$5,updated_at=$6 WHERE id=$1 AND generation=$2 AND phase=$3 RETURNING *`,
      [input.changeId, input.generation, input.from, input.to, input.reason, now])).rows[0];
    if (!row) {
      const current = await this.read(tx, input.changeId);
      return current.ok ? this.conflict(current.value) : current;
    }
    await audit(tx, 'change_phase', input.changeId, { generation: input.generation, from: input.from, to: input.to, reason: input.reason }, now);
    if (isTerminalPhase(input.to)) await settleTerminal(tx, input, input.reason ?? input.to, now);
    return success(requestRow(row));
  }
  private async currentBundle(tx: Database, key: ChangeKey): Promise<EvidenceBundle | null> {
    const row = (await tx.query<Record<string, unknown>>('SELECT * FROM change_generations WHERE change_id=$1 AND generation=$2', [key.changeId, key.generation])).rows[0];
    return row ? toBundle(generationRow(row)) : null;
  }
  private async verificationProblems(tx: Database, request: ChangeRequest): Promise<string[]> {
    const required = request.brief?.verificationCommandIds ?? [];
    if (!required.length) return ['none:missing'];
    const rows = (await tx.query<{ command_id: string; status: string; invalidated_at: unknown }>('SELECT command_id,status,invalidated_at FROM change_verifications WHERE change_id=$1 AND generation=$2',
      [request.id, request.generation])).rows;
    const byCommand = new Map(rows.map(row => [row.command_id, row]));
    return required.flatMap(command => {
      const row = byCommand.get(command);
      if (!row) return [`${command}:missing`];
      if (row.invalidated_at !== null) return [`${command}:invalidated`];
      return row.status === 'passed' ? [] : [`${command}:${row.status}`];
    });
  }
  private async readEffect(tx: Database, key: EffectKey): Promise<EffectRecord | null> {
    const row = (await tx.query<Record<string, unknown>>('SELECT * FROM change_delivery_effects WHERE change_id=$1 AND generation=$2 AND stage=$3', [key.changeId, key.generation, key.stage])).rows[0];
    return row ? effectRow(row) : null;
  }
  // 기대값이 고정 증거와 같아야 intent를 받는다. 게시자가 승인 안 된 tree·브랜치를 기대값으로 적지 못한다.
  private async effectMatchesEvidence(tx: Database, key: EffectKey, expected: EffectExpected, prior: EffectRecord | null): Promise<StoreResult<null>> {
    const row = (await tx.query<Record<string, unknown>>('SELECT * FROM change_generations WHERE change_id=$1 AND generation=$2', [key.changeId, key.generation])).rows[0];
    if (!row) return fail('not_found');
    const generation = generationRow(row);
    const mismatch = fail('evidence_mismatch', { detail: expected.stage });
    switch (expected.stage) {
      case 'blob': {
        const artifact = (await tx.query<{ manifest: unknown }>('SELECT manifest FROM change_artifacts WHERE change_id=$1 AND generation=$2', [key.changeId, key.generation])).rows[0];
        if (!artifact) return fail('not_found');
        const manifest = parseJson<ArtifactManifest>(artifact.manifest);
        const required = new Set(manifest.entries.filter(entry => entry.changeKind === 'added' || entry.changeKind === 'modified').map(entry => entry.blobSha));
        const given = new Set(expected.shas);
        return given.size === required.size && [...required].every(sha => given.has(sha)) ? success(null) : mismatch;
      }
      case 'tree':
        return expected.baseTree === generation.baseTree && expected.treeSha === generation.resultTree ? success(null) : mismatch;
      case 'commit':
        return expected.treeSha === generation.resultTree && expected.parent === generation.baseCommit ? success(null) : mismatch;
      case 'ref': {
        if (expected.ref !== `refs/heads/${generation.branch}`) return fail('branch_mismatch');
        return prior?.result?.stage === 'commit' && prior.result.commitSha === expected.sha ? success(null) : mismatch;
      }
      case 'pull': {
        if (expected.headBranch !== generation.branch || expected.baseBranch !== generation.baseBranch) return fail('branch_mismatch');
        return prior?.result?.stage === 'ref' && prior.result.sha === expected.headSha ? success(null) : mismatch;
      }
    }
  }
}

// 리뷰 자유문의 비공개 저장. 응답 유실 뒤 같은 결과가 다시 와도 한 행이다. 공개 렌더러·writer에 이 객체를 주지 않는다.
export class ChangeReviewFindings {
  constructor(private readonly database: Database, private readonly now: Clock = Date.now) {}
  async save(entry: { key: ChangeKey; jobId: string; sessionId: string; instructionRevision: string; findingsDigest: string; problems: readonly string[]; output: unknown }): Promise<void> {
    await this.database.query(`INSERT INTO change_review_findings(change_id,generation,job_id,session_id,instruction_revision,findings_digest,problems,output,created_at)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) ON CONFLICT DO NOTHING`, [entry.key.changeId, entry.key.generation, entry.jobId, entry.sessionId, entry.instructionRevision, entry.findingsDigest,
      JSON.stringify(entry.problems), entry.output === null ? null : JSON.stringify(entry.output), this.now()]);
  }
}

// 끝난 지 이만큼 지난 건의 artifact 바이트, 리뷰 원문, 요청 원문(추가 답변 포함), brief의 요청 글(summary·goal·acceptanceCriteria), 확인할 것·남은 위험 목록을 지운다.
export const CHANGE_RETENTION_MS = 7 * 86_400_000;
export const CHANGE_PURGE_BATCH = 20;
// brief는 끝 상태에서도 NULL로 둘 수 없다(observing_deploy의 admission CHECK, brief_digest 불변 트리거, 둘의 짝 CHECK).
// 요청 글 세 칸만 비우고 경로·명령·label과 원래 brief의 digest(brief_digest)는 남긴다. brief를 읽는 경로(작성·검증·리뷰·게시)는 모두 진행 단계라
// 비운 건에 닿지 않는다. 새 generation은 brief를 요청 원문에서 다시 만드는데, 그 원문도 같은 트랜잭션에서 지워 startNextGeneration이 input_purged로 막는다.
const BRIEF_HELD = '(r.brief IS NOT NULL AND r.brief_purged_at IS NULL)';
// 확인할 것·남은 위험(C29)은 공개 검사 전에 저장된 모델 글이라 공개 검사에 걸려 막힌 건에도 남는다. 두 목록만 비우고 원래 목록의 digest를 남긴다.
// change_notes의 UPDATE 거부 트리거가 이 모양(빈 목록, 원래 목록의 digest, 지운 시각)만 받는다. 승인 digest는 PR 본문에 묶여 있어 비워도 그대로다.
const NOTES_HELD = 'EXISTS (SELECT 1 FROM change_notes n WHERE n.change_id=r.id AND n.purged_at IS NULL)';
// receipt·digest·effect 기록과 요청 원문의 text_sha256은 남긴다. 진행 중이거나 미확정 effect·정리 안 끝난 세션이 있는 건은 고르지 않는다. 시각 기준은 끝 상태에 든 때다.
// 정리 안 끝난 세션은 진행 중 상태, cleanup pending, 작업자 공간이 남은 세션(session_retained)이다. 끝 상태 커밋(ClaudeChangeAuthor.finalize)과
// pending 표식(finalizeJob)은 서로 다른 트랜잭션이고 표식은 부모를 잠그지 않는다. 그 사이의 completed·none 세션을 retained가 덮는다.
// retained는 작업자 정리를 확인한 뒤에만 false가 되고, true가 되는 곳은 세션 시작(job running, 이미 제외)뿐이다.
// 백업에서 옛 행이 돌아와도 시각이 그대로라 다음 정리가 다시 고른다.
// $1은 cutoff. 고를 때와 지우기 직전에 같은 조건을 쓴다. 아래에 선언된 ChangePrivateInputs를 읽으므로 모듈 로드 때가 아니라 부를 때 만든다.
const changePurgeDue = () => `FROM change_requests r
    LEFT JOIN change_deployments d ON d.change_id=r.id AND d.generation=r.generation
    LEFT JOIN change_deployment_windows w ON w.change_id=r.id AND w.generation=r.generation
    WHERE ((r.phase IN ('superseded','blocked','cancelled','failed') AND r.updated_at<=$1)
      OR (r.phase='observing_deploy' AND ((d.state IN ('observed','not_applicable','blocked') AND d.observed_at<=$1) OR w.late_reported_at<=$1)))
    AND NOT EXISTS (SELECT 1 FROM change_delivery_effects e WHERE e.change_id=r.id AND e.state<>'confirmed' AND e.resolution IS NULL)
    AND NOT EXISTS (SELECT 1 FROM change_child_jobs c JOIN jobs j ON j.id=c.job_id WHERE c.change_id=r.id AND j.state IN ('queued','running','verifying','cancel_requested','waiting_user','unknown'))
    AND NOT EXISTS (SELECT 1 FROM change_child_jobs c JOIN codex_sessions s ON s.job_id=c.job_id WHERE c.change_id=r.id
      AND (s.state IN ('running','waiting_answer','waiting_model','unknown') OR s.cleanup_state='pending' OR s.session_retained))
    AND (EXISTS (SELECT 1 FROM change_artifacts a WHERE a.change_id=r.id AND a.purged_at IS NULL) OR EXISTS (SELECT 1 FROM change_review_findings f WHERE f.change_id=r.id)
      OR ${ChangePrivateInputs.HELD} OR ${BRIEF_HELD} OR ${NOTES_HELD})`;
// 지운 건수를 돌려준다. 고른 뒤 조건이 깨져 건너뛴 건은 세지 않는다.
export async function purgeExpiredChangeContent(database: Database, now: number, retentionMs = CHANGE_RETENTION_MS): Promise<number> {
  const cutoff = now - retentionMs;
  const due = (await database.query<{ id: string }>(`SELECT r.id ${changePurgeDue()} ORDER BY r.updated_at LIMIT ${CHANGE_PURGE_BATCH}`, [cutoff])).rows;
  let purged = 0;
  for (const row of due) {
    await database.transaction(async tx => {
      // 위 선정은 잠금 밖이라 그사이 새 generation이 열렸다 다시 끝났을 수 있다. phase만 보면 종료 직후의 새 generation까지 지운다.
      // 부모 행을 잠근 뒤 선정 조건 전체를 새로 읽는다. 잠금과 재검사를 한 문장에 두지 않는 이유: FOR UPDATE의 재평가는
      // 잠근 행만 새로 읽고 조인·하위 질의는 옛 스냅숏으로 봐서, 그사이 생긴 자식 job·effect·배포 관측을 놓친다.
      // phase·generation, effect 기록, 배포 관측, 자식 job 연결은 모두 부모 행 잠금(FOR SHARE/UPDATE) 아래에서 바뀌어 재검사와 커밋 사이에 끼어들지 못한다.
      // 자식 job·세션 행과 늦음 표시는 부모 잠금 없이 바뀐다. 재검사를 "고름 → 제외"로 뒤집는 전이가 없어야 한다:
      // job은 끝 상태에서 다시 열리지 않고, 세션이 제외 쪽(진행 중·pending·retained)으로 가는 전이는 이미 제외된 상태(running job,
      // 진행 중이거나 retained인 세션)에서만 일어난다. 늦음 표시는 NULL일 때 지금 시각으로 한 번 적혀 cutoff를 넘지 않는다.
      // 제외 조건에 새 세션 칸을 쓰거나 세션 전이를 더하면 이 전제를 다시 확인한다.
      if (!(await tx.query('SELECT 1 FROM change_requests WHERE id=$1 FOR UPDATE', [row.id])).rows.length) return;
      if (!(await tx.query(`SELECT r.id ${changePurgeDue()} AND r.id=$2`, [cutoff, row.id])).rows.length) return;
      purged++;
      await tx.query('DELETE FROM change_artifact_files WHERE change_id=$1', [row.id]);
      await tx.query(`UPDATE change_artifacts SET patch='',purged_at=$2 WHERE change_id=$1 AND purged_at IS NULL`, [row.id, now]);
      await tx.query('DELETE FROM change_review_findings WHERE change_id=$1', [row.id]);
      await ChangePrivateInputs.purgeIn(tx, row.id, now);
      await tx.query(`UPDATE change_requests SET brief=brief || '{"summary":"","goal":"","acceptanceCriteria":[]}'::jsonb,brief_purged_at=$2
        WHERE id=$1 AND brief IS NOT NULL AND brief_purged_at IS NULL`, [row.id, now]);
      await tx.query(`UPDATE change_notes SET checks='[]'::jsonb,risks='[]'::jsonb,purged_at=$2,
        notes_sha256=encode(sha256(convert_to(jsonb_build_object('checks',checks,'risks',risks)::text,'UTF8')),'hex') WHERE change_id=$1 AND purged_at IS NULL`, [row.id, now]);
      await audit(tx, 'change_content_purged', row.id, { retentionMs }, now);
    });
  }
  return purged;
}
const CHANGE_PURGE_ROUNDS = 20;
// 주기 정리의 진입점. 한 바퀴에 여러 쪽을 고른다. 복원 직후 밀린 건이 많아도 다음 주기(1시간)마다 20건씩만 지우지 않게 한다.
// 쪽이 덜 차면(건너뛴 건 포함) 멈춘다. 남은 건은 다음 주기가 고른다. 끝없는 반복은 횟수로 막는다.
export async function purgeExpiredChangeContentRounds(database: Database, now: number, retentionMs = CHANGE_RETENTION_MS): Promise<number> {
  let total = 0;
  for (let round = 0; round < CHANGE_PURGE_ROUNDS; round++) {
    const purged = await purgeExpiredChangeContent(database, now, retentionMs);
    total += purged;
    if (purged < CHANGE_PURGE_BATCH) break;
  }
  return total;
}

// 요청 원문을 읽는 유일한 경로다. 공개 렌더러·writer·리뷰 입력에 이 객체를 주지 않는다.
export class ChangePrivateInputs {
  // 보존 정리와 재개방 확인이 쓰는 자리. 원문 표를 만지는 SQL을 이 클래스에 모은다. HELD는 change_requests를 r로 부르는 질의 안에 넣는다.
  static readonly HELD = 'EXISTS (SELECT 1 FROM change_request_inputs i WHERE i.change_id=r.id AND i.purged_at IS NULL)';
  // 원문만 비우고 지운 시각을 적는다. text_sha256·label·event_id는 증거라 남긴다. 호출자가 부모 행을 잠근 트랜잭션 안에서 부른다.
  static async purgeIn(tx: Database, changeId: string, now: number): Promise<void> {
    await tx.query(`UPDATE change_request_inputs SET text='',purged_at=$2 WHERE change_id=$1 AND purged_at IS NULL`, [changeId, now]);
  }
  static async purgedIn(tx: Database, changeId: string): Promise<boolean> {
    return (await tx.query('SELECT 1 FROM change_request_inputs WHERE change_id=$1 AND purged_at IS NOT NULL LIMIT 1', [changeId])).rows.length > 0;
  }
  constructor(private readonly database: Database, private readonly now: Clock = Date.now) {}
  // 추가 답변도 label을 올린다. 게시 가능하지 않은 label이면 진행 중 change를 닫는다. 답변을 받기 전 author에 넘기지 않는 것은 호출자 몫이고, 닫힌 뒤 게시는 DB CHECK가 막는다.
  async record(input: ChangeKey & { eventId: string; label: ProvenanceLabel; text: string }): Promise<StoreResult<ChangeRequest>> {
    return attempt(this.database, tx => this.recordIn(tx, input));
  }
  // 호출자가 연 트랜잭션 안에서 부른다. /answer의 수신 처리와 답 쓰기를 한 번에 확정하는 경계다. 트리거 거부는 값이 아니라 예외로 올라가 호출자의 트랜잭션을 되돌린다.
  async recordIn(tx: Database, input: ChangeKey & { eventId: string; label: ProvenanceLabel; text: string }): Promise<StoreResult<ChangeRequest>> {
    const row = (await tx.query<Record<string, unknown>>('SELECT * FROM change_requests WHERE id=$1 FOR UPDATE', [input.changeId])).rows[0];
    if (!row) return fail('not_found');
    const request = requestRow(row);
    if (request.generation !== input.generation || isTerminalPhase(request.phase)) return fail('phase_conflict', { current: { phase: request.phase, generation: request.generation } });
    const now = this.now();
    if (!await insertPrivateInput(tx, { changeId: input.changeId, generation: input.generation, eventId: input.eventId, label: input.label, text: input.text, now })) return fail('duplicate_event');
    const label = propagateLabel([request.label, input.label]);
    if (labelAllowsAuthorInput(label)) {
      const updated = (await tx.query<Record<string, unknown>>('UPDATE change_requests SET label=$2,updated_at=$3 WHERE id=$1 RETURNING *', [input.changeId, label, now])).rows[0]!;
      return success(requestRow(updated));
    }
    await tx.query(`UPDATE change_requests SET label=$2,phase='blocked',phase_reason='label_blocked',updated_at=$3 WHERE id=$1`, [input.changeId, label, now]);
    await settleTerminal(tx, input, 'label_blocked', now);
    await audit(tx, 'change_phase', input.changeId, { generation: input.generation, from: request.phase, to: 'blocked', reason: 'label_blocked' }, now);
    return fail('label_blocked');
  }
  async read(filter: { changeId: string }): Promise<{ eventId: string; generation: number; label: ProvenanceLabel; text: string; textSha256: string; createdAt: number }[]> {
    const rows = (await this.database.query<Record<string, unknown>>('SELECT * FROM change_request_inputs WHERE change_id=$1 ORDER BY created_at,event_id', [filter.changeId])).rows;
    return rows.map(row => ({ eventId: row.event_id as string, generation: num(row.generation), label: row.label as ProvenanceLabel, text: row.text as string, textSha256: row.text_sha256 as string, createdAt: num(row.created_at) }));
  }
}
