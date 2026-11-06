import { randomUUID } from 'node:crypto';
import {
  ARTIFACT_LIMITS, ApprovalSubjectSchema, ArtifactManifestSchema, CHANGE_ID, ChangeBriefSchema, DeploymentObservationSchema, EFFECT_LEASE_MS, EFFECT_STAGES,
  EffectExpectedSchema, EffectResultSchema, EvidenceBundleSchema, GENERATION_RESTART, MAX_GENERATION, ReasonCodeSchema, ReviewReceiptSchema, RevisionSchema, UNKNOWN_RECONCILE_MS,
  VerificationReceiptSchema, approvalDigest, artifactDigest, briefDigest, canTransition, changeBranchName, effectResultMatches, evidenceBundleDigest, isTerminalPhase,
  labelAllowsAuthorInput, newChangeId, previousEffectStage, propagateLabel, raiseLabel, reviewReceiptDigest, sha256Hex, validateArtifactFiles, verificationReceiptDigest,
} from './change-contracts.js';
import type {
  ApprovalSubject, ArtifactBundle, ArtifactFile, ArtifactManifest, ChangeBrief, ChangeKey, ChangePhase, DeploymentObservation, EffectExpected, EffectResolution, EffectResult,
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
  | 'head_mismatch' | 'pull_mismatch' | 'deployment_conflict' | 'deployment_stale' | 'generation_limit' | 'guard_rejected' | 'busy';
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
}
export interface EffectRecord {
  changeId: string; generation: number; stage: EffectStage; state: EffectState; requestDigest: string; expected: EffectExpected; approvalDigest: string; attempt: number;
  availableAt: number; leaseId: string | null; leaseUntil: number | null; result: EffectResult | null; failureCode: string | null; reconcileDeadline: number | null;
  blockedReason: string | null; resolution: string | null; resolvedBy: string | null; resolvedAt: number | null;
}
export type StoredDeployment = DeploymentObservation & { prNumber: number };
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
});
const effectRow = (row: Record<string, unknown>): EffectRecord => ({
  changeId: row.change_id as string, generation: num(row.generation), stage: row.stage as EffectStage, state: row.state as EffectState,
  requestDigest: row.request_digest as string, expected: parseJson<EffectExpected>(row.expected), approvalDigest: row.approval_digest as string, attempt: num(row.attempt),
  availableAt: num(row.available_at), leaseId: row.lease_id as string | null, leaseUntil: optional(row.lease_until), result: row.result === null ? null : parseJson<EffectResult>(row.result),
  failureCode: row.failure_code as string | null, reconcileDeadline: optional(row.reconcile_deadline), blockedReason: row.blocked_reason as string | null,
  resolution: row.resolution as string | null, resolvedBy: row.resolved_by as string | null, resolvedAt: optional(row.resolved_at),
});
const stageOrder = (stage: string) => EFFECT_STAGES.indexOf(stage as EffectStage);
const toBundle = (generation: GenerationRecord): EvidenceBundle | null => {
  const parsed = EvidenceBundleSchema.safeParse({ repoId: generation.repoId, generation: generation.generation, baseCommit: generation.baseCommit, baseTree: generation.baseTree,
    resultTree: generation.resultTree, artifactDigest: generation.artifactDigest, policyRevision: generation.policyRevision, verifierRevision: generation.verifierRevision });
  return parsed.success ? parsed.data : null;
};
const dedicated = new Set<ChangePhase>(['admitted', 'authoring', 'snapshot_ready', 'verifying', 'reviewing', 'awaiting_publish_approval', 'approved', 'merged']);
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
    if (dedicated.has(input.to)) return fail('dedicated_operation');
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
      const job = await tx.query(`SELECT 1 FROM change_child_jobs WHERE job_id=$1 AND change_id=$2 AND generation=$3 AND role='review'`, [receipt.jobId, input.changeId, input.generation]);
      if (!job.rows.length) return fail('job_not_linked');
      const inserted = await tx.query(`INSERT INTO change_reviews(change_id,generation,job_id,session_id,instruction_revision,coverage,verdict,bundle_digest,receipt,receipt_digest,created_at)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) ON CONFLICT DO NOTHING RETURNING job_id`,
      [input.changeId, input.generation, receipt.jobId, receipt.sessionId, receipt.instructionRevision, receipt.coverage, receipt.verdict, evidenceBundleDigest(receipt.bundle), JSON.stringify(receipt), digest, this.now()]);
      if (!inserted.rows.length) return fail('receipt_conflict', { detail: 'concurrent_receipt' });
      return success({ created: true, receiptDigest: digest });
    });
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

  // ---- 병합·배포 ----

  // proposed → merged. 게시한 PR·head가 아니면 옮기지 않는다. 사람이 head를 바꿨다면 호출자가 blocked(head_changed)로 닫는다.
  async recordMerge(input: ChangeKey & { prNumber: number; headSha: string; mergeCommit: string }): Promise<StoreResult<ChangeRequest>> {
    return attempt(this.database, async tx => {
      const locked = await this.lock(tx, input, 'proposed');
      if (!locked.ok) return locked;
      const pull = await this.readEffect(tx, { ...input, stage: 'pull' });
      if (pull?.result?.stage !== 'pull') return fail('pull_mismatch');
      if (pull.result.number !== input.prNumber) return fail('pull_mismatch');
      if (pull.result.headSha !== input.headSha) return fail('head_mismatch');
      const now = this.now();
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

// 요청 원문을 읽는 유일한 경로다. 공개 렌더러·writer·리뷰 입력에 이 객체를 주지 않는다.
export class ChangePrivateInputs {
  constructor(private readonly database: Database, private readonly now: Clock = Date.now) {}
  // 추가 답변도 label을 올린다. 게시 가능하지 않은 label이면 진행 중 change를 닫는다. 답변을 받기 전 author에 넘기지 않는 것은 호출자 몫이고, 닫힌 뒤 게시는 DB CHECK가 막는다.
  async record(input: ChangeKey & { eventId: string; label: ProvenanceLabel; text: string }): Promise<StoreResult<ChangeRequest>> {
    return attempt(this.database, async tx => {
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
    });
  }
  async read(filter: { changeId: string }): Promise<{ eventId: string; generation: number; label: ProvenanceLabel; text: string; textSha256: string; createdAt: number }[]> {
    const rows = (await this.database.query<Record<string, unknown>>('SELECT * FROM change_request_inputs WHERE change_id=$1 ORDER BY created_at,event_id', [filter.changeId])).rows;
    return rows.map(row => ({ eventId: row.event_id as string, generation: num(row.generation), label: row.label as ProvenanceLabel, text: row.text as string, textSha256: row.text_sha256 as string, createdAt: num(row.created_at) }));
  }
}
