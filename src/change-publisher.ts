import {
  EFFECT_LEASE_MS, EFFECT_STAGES, artifactDigest, effectRequestDigest, evidenceBundleDigest, labelAllowsAuthorInput, propagateLabel, reviewReceiptDigest, sha256Hex,
} from './change-contracts.js';
import type { ApprovalSubject, ChangeKey, ChangeTarget, ChangeWriterPort, EffectExpected, EffectResult, EffectStage, EvidenceBundle, PublicMetadata, ReviewReceipt, WriterCommitMetadata, WriterOutcome, WriterPullSnapshot } from './change-contracts.js';
import { evaluateCi, readCiSnapshot } from './change-ci-policy.js';
import { compilePathPolicy, gitCommitSha, inspectCandidate } from './change-policy.js';
import type { BaseLeaf, ChangeRepositoryPolicy, PublishPlan } from './change-policy.js';
import { publicationMarker, renderPublication, scanPublicPayload } from './change-publication.js';
import type { ChangeRequest, ChangeStore, EffectKey, EffectRecord, GenerationRecord } from './change-store.js';
import { Denied, PolicyUnavailable } from './contracts.js';
import type { ChangePreflightPort } from './github-writer.js';
import type { Log } from './log.js';

// 승인 뒤 게시 흐름이다. 모든 공개 검사를 끝낸 뒤에야 첫 쓰기를 부른다. 쓰기 토큰은 writer가 첫 쓰기 때 발급하므로 검사 전에는 존재하지 않는다.
// effect를 먼저 기록하고 트랜잭션 밖에서 네트워크를 부른다. 보냈는지 모르면 다시 보내지 않고 대조로만 끝낸다. 그래서 중복 대신 unknown이 남을 수 있다.

export type PublishOutcome =
  | { kind: 'proposed'; prNumber: number; headSha: string }
  // 지금은 공개 효과 없이 멈췄다. retryAt 뒤에 다시 부른다.
  | { kind: 'deferred'; reason: string; retryAt: number }
  | { kind: 'superseded'; reason: string }
  | { kind: 'blocked'; reason: string }
  // 대조가 끝나지 않았다. reconcile이 이어 본다. 기한 뒤에는 사람 해소다.
  | { kind: 'unknown'; stage: EffectStage }
  // 다른 게시자가 전송 중이다.
  | { kind: 'busy' }
  // 게시 단계가 아니다. 이미 끝났거나 취소됐다.
  | { kind: 'stopped'; phase: string };

export interface ChangePublisherOptions {
  store: ChangeStore; writer: ChangeWriterPort; preflight: ChangePreflightPort;
  policy: (repoId: number) => Promise<ChangeRepositoryPolicy | null>;
  // 요청자의 지금 권한. 정책 조회는 /revoke의 거부 목록을 보지 않아 따로 물어야 한다. 전송 직전 확인은 writer의 authorizeWrite가 맡고, 이 값은 부모를 닫을지 정한다. 철회면 Denied, 정책을 못 읽으면 PolicyUnavailable을 던진다.
  authorize: (request: Pick<ChangeRequest, 'ownerId' | 'scope'>) => Promise<unknown>;
  now?: () => number; log?: Log; retryMs?: number; leaseRenewMs?: number;
}
export interface ReconcileReport {
  confirmed: EffectKey[]; stillUnknown: EffectKey[]; blocked: EffectKey[];
  resumed: { key: ChangeKey; outcome: PublishOutcome }[];
}

class Stop extends Error {
  constructor(readonly outcome: PublishOutcome) { super('publish_stopped'); }
}
const DEFAULT_RETRY_MS = 60_000;
const MAX_RETRY_MS = 3_600_000;
const MAX_SEND_ATTEMPTS = 8;
// 나중에 다시 하면 풀릴 수 있는 미전송만 재시도한다. 입력·권한·저장소 불일치는 다시 해도 같아서 사람에게 넘긴다.
const TRANSIENT_NOT_SENT = new Set(['connection_refused', 'connection_failed', 'rate_limited', 'policy_unavailable', 'authorization_check_failed', 'token_unavailable', 'token_response_invalid']);
const isTransientNotSent = (code: string) => TRANSIENT_NOT_SENT.has(code) || /^token_http_5\d\d$/.test(code);

interface Plan {
  target: ChangeTarget; key: ChangeKey; generation: GenerationRecord; subject: ApprovalSubject; bundle: EvidenceBundle; policy: ChangeRepositoryPolicy;
  publish: PublishPlan; headSha: string; marker: string; publication: PublicMetadata;
}

export class ChangePublisher {
  private readonly store: ChangeStore;
  private readonly writer: ChangeWriterPort;
  private readonly preflight: ChangePreflightPort;
  private readonly policy: ChangePublisherOptions['policy'];
  private readonly authorize: ChangePublisherOptions['authorize'];
  private readonly now: () => number;
  private readonly log: Log;
  private readonly retryMs: number;
  private readonly leaseRenewMs: number;
  constructor(options: ChangePublisherOptions) {
    this.store = options.store; this.writer = options.writer; this.preflight = options.preflight; this.policy = options.policy; this.authorize = options.authorize;
    this.now = options.now ?? Date.now; this.log = options.log ?? (() => {});
    this.retryMs = options.retryMs ?? DEFAULT_RETRY_MS; this.leaseRenewMs = options.leaseRenewMs ?? Math.floor(EFFECT_LEASE_MS / 3);
  }

  // 같은 key로 몇 번을 불러도 안전하다. 재시작한 게시자도 이것만 다시 부른다.
  async publish(key: ChangeKey): Promise<PublishOutcome> {
    try {
      return await this.run(key);
    } catch (error) {
      if (error instanceof Stop) return error.outcome;
      throw error;
    }
  }

  private async run(key: ChangeKey): Promise<PublishOutcome> {
    const request = this.must(await this.store.get(key.changeId));
    if (request.generation !== key.generation) return { kind: 'stopped', phase: request.phase };
    if (request.phase === 'proposed') {
      const pull = await this.confirmedResult(key, 'pull');
      if (pull?.stage === 'pull') return { kind: 'proposed', prNumber: pull.number, headSha: pull.headSha };
    }
    if (request.phase !== 'approved' && request.phase !== 'publishing') return { kind: 'stopped', phase: request.phase };
    await this.assertAuthorized(key);
    const expired = await this.store.expireSendingEffects();
    if (expired.length) this.log('change_effects_expired', { count: expired.length });
    await this.settlePrevious(key);
    // PR이 이미 있으면 공개 검사를 되풀이하지 않는다. base가 그 뒤에 움직여도 superseded로 새 PR을 부르지 않고 사후 검사가 사람에게 넘긴다.
    const created = await this.confirmedResult(key, 'pull');
    if (created?.stage === 'pull') return this.finish(key, this.must(await this.store.generationRecord(key)), created);
    const plan = await this.gate(key, request.phase);
    if (request.phase === 'approved') {
      const moved = await this.store.transition({ ...key, from: 'approved', to: 'publishing', reason: null });
      // 경합에서 졌으면 이미 다른 게시자가 올렸다. 아래 effect 경로가 하나만 통과시킨다.
      if (!moved.ok && !(moved.reason === 'phase_conflict' && moved.current?.phase === 'publishing')) throw this.storeStop(moved);
    }
    for (const stage of EFFECT_STAGES) await this.runStage(plan, stage);
    const pull = await this.confirmedResult(key, 'pull');
    if (pull?.stage !== 'pull') throw new Stop({ kind: 'unknown', stage: 'pull' });
    return this.finish(key, plan.generation, pull);
  }

  // 게시 입구와 stage마다, 그리고 writer가 쓰기 직전 철회를 돌려줬을 때 부른다. 대조 주기의 재개도 이 길을 지난다. 철회면 부모만 닫고 이미 공개된 객체는 그대로 둔다. 미확정 effect의 읽기 대조는 reconcile이 계속한다.
  private async assertAuthorized(key: ChangeKey): Promise<void> {
    const request = this.must(await this.store.get(key.changeId));
    try {
      await this.authorize(request);
      return;
    } catch (error) {
      if (error instanceof PolicyUnavailable) throw new Stop(this.deferred('policy_unavailable'));
      if (!(error instanceof Denied)) throw error;
    }
    const moved = await this.store.transition({ ...key, from: request.phase, to: 'cancelled', reason: 'authorization_revoked' });
    if (!moved.ok) throw this.storeStop(moved);
    this.log('change_publish_closed', { to: 'cancelled', reason: 'authorization_revoked' });
    throw new Stop({ kind: 'stopped', phase: 'cancelled' });
  }

  // 미확정 effect가 있으면 새 stage로 가지 않는다. 대조 가능한 것은 여기서 대조한다.
  private async settlePrevious(key: ChangeKey): Promise<void> {
    for (const effect of await this.store.unresolvedEffects({ changeId: key.changeId })) {
      if (effect.state === 'pending') continue;
      if (effect.state === 'sending') throw new Stop({ kind: 'busy' });
      if (effect.state === 'blocked') throw new Stop({ kind: 'blocked', reason: effect.blockedReason ?? 'effect_blocked' });
      const verdict = await this.reconcileEffect(effect);
      if (verdict === 'unresolved') throw new Stop({ kind: 'unknown', stage: effect.stage });
      if (verdict === 'blocked') throw new Stop({ kind: 'blocked', reason: (await this.effect({ changeId: effect.changeId, generation: effect.generation }, effect.stage))?.blockedReason ?? 'effect_blocked' });
    }
  }

  // ---- 승인 준비 ----

  // reviewing → awaiting_publish_approval. 공개 문구를 여기서 한 번 고정해 승인 대상에 넣는다. at은 호출자가 정한 고정 시각이고 commit SHA가 여기에 달려 있다.
  async prepareApproval(key: ChangeKey, input: { review: ReviewReceipt; at: number }): Promise<{ ok: true; digest: string; subject: ApprovalSubject } | { ok: false; reason: string }> {
    const request = await this.store.get(key.changeId);
    if (!request.ok) return { ok: false, reason: request.reason };
    const brief = request.value.brief;
    if (request.value.generation !== key.generation || request.value.phase !== 'reviewing' || !brief) return { ok: false, reason: 'phase_conflict' };
    const bundle = await this.store.evidenceBundle(key);
    const generation = await this.store.generationRecord(key);
    if (!bundle.ok || !generation.ok) return { ok: false, reason: 'evidence_missing' };
    const policy = await this.policy(generation.value.repoId);
    if (!policy || policy.repoId !== generation.value.repoId) return { ok: false, reason: 'policy_revoked' };
    if (policy.revision !== bundle.value.policyRevision) return { ok: false, reason: 'policy_changed' };
    // 공개 문구의 위험 표기가 저장된 리뷰와 같아야 한다. 다른 receipt를 끼워 경고를 지우지 못한다.
    const stored = (await this.store.database.query<{ receipt_digest: string }>('SELECT receipt_digest FROM change_reviews WHERE change_id=$1 AND generation=$2', [key.changeId, key.generation])).rows[0];
    if (!stored || stored.receipt_digest !== reviewReceiptDigest(input.review)) return { ok: false, reason: 'review_mismatch' };
    if (input.review.verdict === 'blocked') return { ok: false, reason: 'review_incomplete' };
    const rendered = renderPublication({
      key, label: request.value.label, brief, bundle: bundle.value, branch: generation.value.branch,
      verifications: brief.verificationCommandIds.map(commandId => ({ commandId, status: 'passed' as const })),
      review: { verdict: input.review.verdict, risks: input.review.risks.map(risk => ({ priority: risk.priority as 'P2' | 'P3', category: risk.category })) },
      identity: policy.identity, at: input.at,
    }, { internalMarkers: policy.internalMarkers });
    if (!rendered.ok) return rendered;
    const target: ChangeTarget = { key, repoId: generation.value.repoId };
    let fingerprint: string;
    try {
      const leaves = await this.preflight.readTreeLeaves({ target, sha: generation.value.baseTree });
      if (!leaves?.complete) return { ok: false, reason: 'base_tree_incomplete' };
      const snapshot = await readCiSnapshot(this.preflight, target, leaves.leaves, policy.ci);
      if (!snapshot) return { ok: false, reason: 'ci_unreadable' };
      const ci = evaluateCi(snapshot, policy.ci);
      if (!ci.ok) {
        // 값은 공개 SHA의 해시다. 사람이 승인값을 처음 등록할 때 이 로그를 본다.
        if (ci.fingerprint) this.log('change_ci_fingerprint_unapproved', { fingerprint: ci.fingerprint });
        return { ok: false, reason: ci.reason };
      }
      fingerprint = ci.fingerprint;
    } catch (error) { return { ok: false, reason: this.code(error) }; }
    const prepared = await this.store.prepareApproval({ ...key, publication: rendered.publication, ciFingerprint: fingerprint });
    return prepared.ok ? { ok: true, digest: prepared.value.digest, subject: prepared.value.subject } : { ok: false, reason: prepared.reason };
  }

  // ---- 첫 공개 효과 전의 전체 검사 ----

  private async gate(key: ChangeKey, phase: 'approved' | 'publishing'): Promise<Plan> {
    const block = async (reason: string): Promise<never> => this.invalidate(key, phase, 'blocked', reason);
    const request = this.must(await this.store.get(key.changeId));
    const generation = this.must(await this.store.generationRecord(key));
    const bundle = this.must(await this.store.evidenceBundle(key));
    const approval = this.must(await this.store.approvalSubject(key));
    const subject = approval.subject;
    const artifact = this.must(await this.store.loadArtifact(key));
    const live = await this.store.checkLiveApproval({ ...key, subject });
    if (!live.ok) await block(live.reason === 'approval_missing' ? 'approval_missing' : 'approval_mismatch');

    // 정책·승인 대조는 네트워크 전에 끝낸다.
    const label = propagateLabel([request.label, artifact.label, ...(request.brief ? [request.brief.label] : [])]);
    if (!labelAllowsAuthorInput(label)) await block('label_blocked');
    const brief = request.brief;
    if (!brief) return block('brief_missing');
    const policy = await this.policy(generation.repoId);
    if (!policy || policy.repoId !== generation.repoId) return block('policy_revoked');
    if (policy.revision !== bundle.policyRevision) await block('policy_changed');
    if (!policy.writerAccepted) await block('writer_acceptance_missing');
    if (!policy.baseBranches.includes(generation.baseBranch)) await block('base_branch_not_allowed');
    if (policy.requiredCommands.some(command => !brief.verificationCommandIds.includes(command) || !subject.verifications.some(item => item.commandId === command && item.status === 'passed'))) await block('required_command_missing');
    if (brief.verificationCommandIds.some(command => !subject.verifications.some(item => item.commandId === command && item.status === 'passed'))) await block('required_command_missing');
    const publication = subject.publication;
    if (publication.author.name !== policy.identity.name || publication.author.email !== policy.identity.email
      || publication.committer.name !== policy.identity.name || publication.committer.email !== policy.identity.email) await block('identity_mismatch');
    const marker = publicationMarker(key);
    if (!publication.body.includes(`<!-- ${marker} -->`)) await block('marker_missing');
    if (subject.branch !== generation.branch || subject.baseBranch !== generation.baseBranch) await block('branch_mismatch');
    if (evidenceBundleDigest(subject.bundle) !== evidenceBundleDigest(bundle)) await block('evidence_mismatch');
    const manifest = artifact.manifest;
    if (artifactDigest(manifest) !== bundle.artifactDigest || artifact.artifactDigest !== bundle.artifactDigest || manifest.baseCommit !== bundle.baseCommit
      || manifest.baseTree !== bundle.baseTree || manifest.resultTree !== bundle.resultTree || sha256Hex(Buffer.from(artifact.patch)) !== manifest.patchSha256) await block('artifact_mismatch');
    const repoRules = compilePathPolicy(policy.allowedPaths, policy.deniedPaths);
    const briefRules = compilePathPolicy(brief.allowedPaths, brief.deniedPaths);
    if (!repoRules.ok || !briefRules.ok) return block('policy_missing');

    // 여기부터 GitHub을 읽는다. 자격 없는 읽기라 쓰기 권한이 없다. 일시 실패는 공개 효과 없이 미룬다.
    const target: ChangeTarget = { key, repoId: generation.repoId };
    let head: { sha: string } | null;
    let baseCommit: { treeSha: string; parents: string[] } | null;
    let leaves: { complete: boolean; leaves: BaseLeaf[] } | null;
    try {
      head = await this.preflight.readBranchHead({ target, branch: generation.baseBranch });
      if (head?.sha !== generation.baseCommit) return this.invalidate(key, phase, 'superseded', 'base_moved');
      baseCommit = await this.preflight.readCommit({ target, sha: generation.baseCommit });
      leaves = await this.preflight.readTreeLeaves({ target, sha: generation.baseTree });
    } catch (error) {
      if (error instanceof Stop) throw error;
      throw new Stop(this.deferred(this.code(error)));
    }
    if (!baseCommit || baseCommit.treeSha !== generation.baseTree) return block('base_tree_mismatch');
    if (!leaves) return block('base_tree_incomplete');

    const inspected = inspectCandidate({ base: { sha: generation.baseTree, complete: leaves.complete, leaves: leaves.leaves }, manifest, files: artifact.files, policies: [repoRules.policy, briefRules.policy] });
    if (!inspected.ok) return block(inspected.reason);
    const scanned = scanPublicPayload({ paths: inspected.plan.changedPaths, files: artifact.files, publication, branch: generation.branch, marker }, { internalMarkers: policy.internalMarkers });
    if (!scanned.ok) return block(scanned.reason);

    let snapshot: Awaited<ReturnType<typeof readCiSnapshot>>;
    try { snapshot = await readCiSnapshot(this.preflight, target, leaves.leaves, policy.ci); }
    catch (error) {
      if (error instanceof Error && error.message === 'ci_workflow_mode') return block('ci_workflow_mode');
      throw new Stop(this.deferred(this.code(error)));
    }
    if (!snapshot) return block('ci_unreadable');
    const ci = evaluateCi(snapshot, policy.ci);
    if (!ci.ok) return block(ci.reason);
    if (ci.fingerprint !== subject.ciFingerprint) return block('ci_fingerprint_changed');

    const headSha = gitCommitSha({ treeSha: inspected.plan.resultTree, parents: [generation.baseCommit], message: publication.commitMessage, author: publication.author, committer: publication.committer });
    // 내 영속 기록과 다른 커밋이 이미 브랜치에 있으면 사람 변경이다. 아무것도 올리기 전에 멈춘다.
    let branchHead: { sha: string } | null;
    try { branchHead = await this.preflight.readBranchHead({ target, branch: generation.branch }); }
    catch (error) { throw new Stop(this.deferred(this.code(error))); }
    if (branchHead && branchHead.sha !== headSha) return block('head_changed');
    return { target, key, generation, subject, bundle, policy, publish: inspected.plan, headSha, marker, publication };
  }

  // ---- stage ----

  private async runStage(plan: Plan, stage: EffectStage): Promise<void> {
    const { key } = plan;
    const existing = await this.effect(key, stage);
    if (existing?.state === 'confirmed') return;
    if (existing?.state === 'blocked') throw new Stop({ kind: 'blocked', reason: existing.blockedReason ?? 'effect_blocked' });
    if (existing?.state === 'sending') throw new Stop({ kind: 'busy' });
    if (existing?.state === 'unknown') throw new Stop({ kind: 'unknown', stage });
    await this.assertAuthorized(key);
    await this.freshnessBefore(plan, stage);
    const { requestDigest, expected } = this.intentFor(plan, stage);
    const intent = await this.store.recordEffectIntent({ ...key, stage, requestDigest, expected });
    if (!intent.ok) {
      // 저장한 증거와 어긋나는 intent만 고칠 수 없는 실패다. 나머지는 경합·일시 실패다.
      if (intent.reason === 'evidence_mismatch' || intent.reason === 'branch_mismatch' || intent.reason === 'effect_conflict') throw await this.fatal(plan, intent.reason);
      throw this.storeStop(intent);
    }
    const claim = await this.store.claimEffect({ ...key, stage });
    if (!claim.ok) {
      if (claim.reason === 'effect_not_due') throw new Stop({ kind: 'deferred', reason: 'effect_not_due', retryAt: intent.value.availableAt });
      throw this.storeStop(claim);
    }
    const leaseId = claim.value.leaseId;
    // 내용이 없는 stage는 보낼 것이 없다. 요청 없이 확정한다.
    if (stage === 'blob' && plan.publish.blobs.length === 0) {
      await this.confirm(plan, stage, leaseId, { stage: 'blob', shas: [] });
      return;
    }
    // 내 ref가 이미 있으면(상태를 잃은 복구) 보내지 않고 회수한다. 다른 SHA는 gate·freshness가 이미 막았다.
    if (stage === 'ref' && expected.stage === 'ref') {
      const branchHead = await this.readOrDefer(() => this.writer.readBranchHead({ target: plan.target, branch: plan.generation.branch }), key, stage, leaseId);
      if (branchHead?.sha === expected.sha) {
        await this.confirm(plan, stage, leaseId, { stage: 'ref', ref: expected.ref, sha: expected.sha });
        return;
      }
    }
    const outcome = await this.withRenewal({ ...key, stage }, leaseId, () => this.send(plan, stage));
    await this.applyOutcome(plan, stage, leaseId, claim.value.attempt, outcome);
    await this.assertStillPublishing(key);
  }

  // base는 첫 blob 전, ref 전, PR 직전·직후에 읽는다. 사이의 tree·commit은 공개 브랜치에 닿지 않아 다시 읽지 않는다.
  private async freshnessBefore(plan: Plan, stage: EffectStage): Promise<void> {
    if (stage !== 'ref' && stage !== 'pull') return;
    await this.checkPolicyStill(plan);
    const { target, generation, key } = plan;
    let base: { sha: string } | null;
    let head: { sha: string } | null;
    try {
      base = await this.writer.readBranchHead({ target, branch: generation.baseBranch });
      head = await this.writer.readBranchHead({ target, branch: generation.branch });
    } catch (error) { throw new Stop(this.deferred(this.code(error))); }
    if (base?.sha !== generation.baseCommit) await this.invalidate(key, 'publishing', 'superseded', 'base_moved');
    if (head && head.sha !== plan.headSha) await this.invalidate(key, 'publishing', 'blocked', 'head_changed');
    if (stage === 'pull' && !head) await this.invalidate(key, 'publishing', 'blocked', 'head_missing');
  }
  private async checkPolicyStill(plan: Plan): Promise<void> {
    const current = await this.policy(plan.generation.repoId);
    if (!current || current.repoId !== plan.generation.repoId) await this.invalidate(plan.key, 'publishing', 'blocked', 'policy_revoked');
    else if (current.revision !== plan.bundle.policyRevision) await this.invalidate(plan.key, 'publishing', 'blocked', 'policy_changed');
    else if (!current.writerAccepted) await this.invalidate(plan.key, 'publishing', 'blocked', 'writer_acceptance_missing');
  }

  private intentFor(plan: Plan, stage: EffectStage): { requestDigest: string; expected: EffectExpected } {
    const { generation, publication, publish, headSha, marker } = plan;
    const metadata: WriterCommitMetadata = { message: publication.commitMessage, author: publication.author, committer: publication.committer };
    switch (stage) {
      case 'blob': {
        const shas = [...new Set(publish.blobs.map(blob => blob.blobSha))].sort();
        return { requestDigest: effectRequestDigest(stage, { shas }), expected: { stage, shas } };
      }
      case 'tree':
        return { requestDigest: effectRequestDigest(stage, { baseTree: generation.baseTree, entries: publish.treeEntries }), expected: { stage, baseTree: generation.baseTree, treeSha: publish.resultTree } };
      case 'commit':
        return { requestDigest: effectRequestDigest(stage, { treeSha: publish.resultTree, parent: generation.baseCommit, metadata }), expected: { stage, treeSha: publish.resultTree, parent: generation.baseCommit, commitSha: headSha } };
      case 'ref':
        return { requestDigest: effectRequestDigest(stage, { branch: generation.branch, sha: headSha }), expected: { stage, ref: `refs/heads/${generation.branch}`, sha: headSha } };
      case 'pull':
        return { requestDigest: effectRequestDigest(stage, { branch: generation.branch, baseBranch: generation.baseBranch, title: publication.title, body: publication.body, draft: publication.draft }),
          expected: { stage, headBranch: generation.branch, baseBranch: generation.baseBranch, headSha, marker } };
    }
  }

  private async send(plan: Plan, stage: EffectStage): Promise<WriterOutcome<EffectResult>> {
    const { target, generation, publication, publish, headSha } = plan;
    const wrap = <T>(outcome: WriterOutcome<T>, map: (value: T) => EffectResult): WriterOutcome<EffectResult> => outcome.kind === 'confirmed' ? { kind: 'confirmed', value: map(outcome.value) } : outcome;
    switch (stage) {
      case 'blob':
        return wrap(await this.writer.createBlobs({ target, files: publish.blobs }), value => ({ stage: 'blob', shas: value.shas }));
      case 'tree':
        return wrap(await this.writer.createTree({ target, baseTree: generation.baseTree, entries: publish.treeEntries }), value => ({ stage: 'tree', treeSha: value.treeSha }));
      case 'commit':
        return wrap(await this.writer.createCommit({ target, treeSha: publish.resultTree, parent: generation.baseCommit, metadata: { message: publication.commitMessage, author: publication.author, committer: publication.committer } }),
          value => ({ stage: 'commit', commitSha: value.commitSha, treeSha: value.treeSha, parents: value.parents }));
      case 'ref':
        return wrap(await this.writer.createRef({ target, branch: generation.branch, sha: headSha }), value => ({ stage: 'ref', ref: value.ref, sha: value.sha }));
      case 'pull': {
        const outcome = await this.writer.createPull({ target, branch: generation.branch, baseBranch: generation.baseBranch, title: publication.title, body: publication.body, draft: publication.draft });
        if (outcome.kind !== 'confirmed') return outcome;
        // 만든 직후의 응답도 재조회와 같은 기준으로 본다.
        if (!this.pullMatches(plan.policy, plan.generation, plan.publication, plan.marker, headSha, outcome.value)) return { kind: 'rejected', status: 200, code: 'pull_mismatch' };
        return wrap(outcome, value => ({ stage: 'pull', number: value.number, headBranch: value.headBranch, baseBranch: value.baseBranch, headSha: value.headSha }));
      }
    }
  }

  private async applyOutcome(plan: Plan, stage: EffectStage, leaseId: string, attempt: number, outcome: WriterOutcome<EffectResult>): Promise<void> {
    const { key } = plan;
    switch (outcome.kind) {
      case 'confirmed':
        await this.confirm(plan, stage, leaseId, outcome.value);
        return;
      case 'not_sent': {
        // writer의 쓰기 직전 철회다. effect를 막지 않고 놓아 둔 뒤 입구와 같은 게이트에 맡긴다. 철회가 맞으면 부모가 닫히고, 그사이 권한이 돌아왔으면 이어 간다.
        if (outcome.code === 'authorization_revoked') {
          const retryAt = this.now() + this.retryMs;
          const released = await this.store.releaseUnsentEffect({ ...key, stage, leaseId, retryAt });
          if (!released.ok) throw new Stop({ kind: 'busy' });
          await this.assertAuthorized(key);
          throw new Stop({ kind: 'deferred', reason: outcome.code, retryAt });
        }
        if (!isTransientNotSent(outcome.code)) throw await this.blockStage(key, stage, outcome.code);
        if (attempt >= MAX_SEND_ATTEMPTS) throw await this.blockStage(key, stage, 'send_attempts_exhausted');
        const retryAt = this.now() + Math.min(this.retryMs * 2 ** (attempt - 1), MAX_RETRY_MS);
        const released = await this.store.releaseUnsentEffect({ ...key, stage, leaseId, retryAt });
        if (!released.ok) throw new Stop({ kind: 'busy' });
        throw new Stop({ kind: 'deferred', reason: outcome.code, retryAt });
      }
      case 'unknown':
        await this.markUnknown(key, stage, leaseId, outcome.code);
        await this.reconcileOrStop(plan, stage);
        return;
      case 'rejected': {
        // ref·PR의 422는 "이미 있음"일 수 있다. 다시 보내지 않고 정확한 값을 읽어 본다. 내 것이 아니면 막는다.
        if (outcome.status === 422 && (stage === 'ref' || stage === 'pull')) {
          await this.markUnknown(key, stage, leaseId, 'http_422');
          const effect = (await this.store.unresolvedEffects({ changeId: key.changeId, generation: key.generation })).find(row => row.stage === stage);
          const verdict = effect ? await this.reconcileEffect(effect) : 'unresolved';
          if (verdict === 'confirmed') return;
          if (verdict === 'blocked') throw new Stop({ kind: 'blocked', reason: (await this.effect(key, stage))?.blockedReason ?? 'effect_blocked' });
          throw await this.blockStage(key, stage, 'http_422');
        }
        throw await this.blockStage(key, stage, outcome.code);
      }
    }
  }
  private async markUnknown(key: ChangeKey, stage: EffectStage, leaseId: string, code: string): Promise<void> {
    const marked = await this.store.markEffectUnknown({ ...key, stage, leaseId, code });
    // 임대를 잃었으면 이미 다른 게시자가 대조 대상으로 옮겼다.
    if (!marked.ok && marked.reason !== 'lease_mismatch') throw new Stop({ kind: 'stopped', phase: marked.reason });
  }
  private async reconcileOrStop(plan: Plan, stage: EffectStage): Promise<void> {
    const effect = (await this.store.unresolvedEffects({ changeId: plan.key.changeId, generation: plan.key.generation })).find(row => row.stage === stage);
    if (!effect) {
      if (await this.confirmedResult(plan.key, stage)) return;
      throw new Stop({ kind: 'unknown', stage });
    }
    const verdict = await this.reconcileEffect(effect);
    if (verdict === 'confirmed') return;
    if (verdict === 'blocked') throw new Stop({ kind: 'blocked', reason: (await this.effect(plan.key, stage))?.blockedReason ?? 'effect_blocked' });
    throw new Stop({ kind: 'unknown', stage });
  }
  private async confirm(plan: Plan, stage: EffectStage, leaseId: string, result: EffectResult): Promise<void> {
    const confirmed = await this.store.confirmEffect({ ...plan.key, stage, leaseId, result });
    if (confirmed.ok) return;
    if (confirmed.reason === 'result_mismatch') throw await this.blockStage(plan.key, stage, 'result_mismatch');
    // 응답은 받았지만 기록하지 못했다. 임대가 끝나면 대조로 회수한다. 막으면 공개된 결과를 잃는다.
    throw new Stop({ kind: 'busy' });
  }
  private async blockStage(key: ChangeKey, stage: EffectStage, reason: string): Promise<Stop> {
    const blocked = await this.store.blockEffect({ ...key, stage, reason });
    if (!blocked.ok && blocked.reason !== 'effect_conflict') return this.storeStop(blocked);
    return new Stop({ kind: 'blocked', reason });
  }
  private async assertStillPublishing(key: ChangeKey): Promise<void> {
    const request = this.must(await this.store.get(key.changeId));
    if (request.generation !== key.generation || request.phase !== 'publishing') throw new Stop({ kind: 'stopped', phase: request.phase });
  }
  private async withRenewal<T>(key: EffectKey, leaseId: string, work: () => Promise<T>): Promise<T> {
    const timer = setInterval(() => {
      void this.store.renewEffectLease({ ...key, leaseId }).catch(() => {});
    }, this.leaseRenewMs);
    timer.unref();
    try { return await work(); } finally { clearInterval(timer); }
  }
  private async readOrDefer<T>(read: () => Promise<T>, key: ChangeKey, stage: EffectStage, leaseId: string): Promise<T> {
    try { return await read(); }
    catch (error) {
      const retryAt = this.now() + this.retryMs;
      const released = await this.store.releaseUnsentEffect({ ...key, stage, leaseId, retryAt });
      if (!released.ok) throw new Stop({ kind: 'busy' });
      throw new Stop({ kind: 'deferred', reason: this.code(error), retryAt });
    }
  }

  // ---- 끝 ----

  private async finish(key: ChangeKey, generation: GenerationRecord, pull: Extract<EffectResult, { stage: 'pull' }>): Promise<PublishOutcome> {
    const target: ChangeTarget = { key, repoId: generation.repoId };
    let base: { sha: string } | null;
    let found: WriterPullSnapshot[];
    try {
      base = await this.writer.readBranchHead({ target, branch: generation.baseBranch });
      found = await this.writer.findPulls({ target, headBranch: generation.branch, baseBranch: generation.baseBranch });
    } catch (error) { throw new Stop(this.deferred(this.code(error))); }
    const mine = found.find(item => item.number === pull.number);
    if (!mine) return this.invalidate(key, 'publishing', 'blocked', 'pull_missing');
    if (mine.headSha !== pull.headSha) return this.invalidate(key, 'publishing', 'blocked', 'head_changed');
    if (mine.state !== 'open' || mine.merged) return this.invalidate(key, 'publishing', 'blocked', 'pull_closed');
    // PR을 닫거나 덮지 않는다. 검증한 base와 달라졌다는 사실만 남기고 사람에게 넘긴다.
    if (base?.sha !== generation.baseCommit) return this.invalidate(key, 'publishing', 'blocked', 'pull_stale_base');
    const moved = await this.store.transition({ ...key, from: 'publishing', to: 'proposed', reason: null });
    if (!moved.ok && moved.current?.phase !== 'proposed') return this.storeStop(moved).outcome;
    return { kind: 'proposed', prNumber: pull.number, headSha: pull.headSha };
  }

  // ---- 대조 ----

  // 재시작·주기 실행의 입구다. 만료된 전송을 unknown으로 옮기고, 대조하고, 기한 넘은 unknown을 사람 해소로 넘긴 뒤, 승인·게시 중인 건을 이어 간다.
  // 대조는 읽기뿐이라 권한과 무관하게 돈다. 쓰기로 가는 재개는 publish의 인가를 지난다.
  async reconcile(): Promise<ReconcileReport> {
    const report: ReconcileReport = { confirmed: [], stillUnknown: [], blocked: [], resumed: [] };
    await this.store.expireSendingEffects();
    for (const effect of await this.store.unresolvedEffects()) {
      if (effect.state !== 'unknown') continue;
      const key = { changeId: effect.changeId, generation: effect.generation, stage: effect.stage };
      const verdict = await this.reconcileEffect(effect);
      if (verdict === 'confirmed') report.confirmed.push(key);
      else if (verdict === 'unresolved') report.stillUnknown.push(key);
      // 이미 막힌 effect는 아래 기한 처리에 다시 나오지 않아 여기서 빼면 사람 해소가 필요한 건이 보고서에서 사라진다.
      else report.blocked.push(key);
    }
    for (const effect of await this.store.blockExpiredUnknownEffects()) {
      const key = { changeId: effect.changeId, generation: effect.generation, stage: effect.stage };
      report.blocked.push(key);
      report.stillUnknown = report.stillUnknown.filter(item => !(item.changeId === key.changeId && item.generation === key.generation && item.stage === key.stage));
      this.log('change_effect_unknown_expired', { stage: effect.stage });
    }
    const rows = (await this.store.database.query<{ id: string; generation: number | string }>(`SELECT id,generation FROM change_requests WHERE phase IN ('approved','publishing') ORDER BY updated_at`)).rows;
    for (const row of rows) {
      const key = { changeId: row.id, generation: Number(row.generation) };
      if ((await this.store.unresolvedEffects({ changeId: key.changeId })).some(effect => effect.state === 'unknown' || effect.state === 'sending' || effect.state === 'blocked')) continue;
      // 한 건의 오류가 뒤의 건을 막지 않는다. 다음 주기에 다시 본다.
      try { report.resumed.push({ key, outcome: await this.publish(key) }); }
      catch (error) { this.log('change_publish_resume_failed', { reason: this.code(error) }); }
    }
    return report;
  }

  // 보냈는지 모르는 요청을 GitHub의 정확한 값과 대조한다. 못 찾으면 그대로 unknown이다. 다시 보내지 않는다.
  private async reconcileEffect(effect: EffectRecord): Promise<'confirmed' | 'unresolved' | 'blocked'> {
    const key: ChangeKey = { changeId: effect.changeId, generation: effect.generation };
    const generation = await this.store.generationRecord(key);
    if (!generation.ok) return 'unresolved';
    const target: ChangeTarget = { key, repoId: generation.value.repoId };
    const expected = effect.expected;
    let result: EffectResult | null = null;
    try {
      switch (expected.stage) {
        case 'blob': {
          // 차례로 읽는다. 파일이 많을 때 한꺼번에 읽으면 GitHub 2차 한도에 걸린다.
          let all = true;
          for (const sha of expected.shas) {
            if (!await this.writer.readBlobExists({ target, sha })) { all = false; break; }
          }
          if (all) result = { stage: 'blob', shas: expected.shas };
          break;
        }
        case 'tree':
          if (await this.writer.readTreeLeaves({ target, sha: expected.treeSha })) result = { stage: 'tree', treeSha: expected.treeSha };
          break;
        case 'commit': {
          const commit = await this.writer.readCommit({ target, sha: expected.commitSha });
          if (commit) result = { stage: 'commit', commitSha: expected.commitSha, treeSha: commit.treeSha, parents: commit.parents };
          break;
        }
        case 'ref': {
          const head = await this.writer.readBranchHead({ target, branch: generation.value.branch });
          if (head) {
            if (head.sha !== expected.sha) return this.blockReconciled(effect, 'head_changed');
            result = { stage: 'ref', ref: expected.ref, sha: expected.sha };
          }
          break;
        }
        case 'pull': {
          const found = await this.writer.findPulls({ target, headBranch: expected.headBranch, baseBranch: expected.baseBranch });
          // 여러 건이면 고르지 않고 unknown으로 둔다.
          if (found.length === 1) {
            const subject = await this.store.approvalSubject(key);
            const policy = await this.policy(generation.value.repoId);
            if (!subject.ok || !policy) break;
            if (!this.pullMatches(policy, generation.value, subject.value.subject.publication, expected.marker, expected.headSha, found[0]!)) return this.blockReconciled(effect, 'pull_mismatch');
            const pull = found[0]!;
            result = { stage: 'pull', number: pull.number, headBranch: pull.headBranch, baseBranch: pull.baseBranch, headSha: pull.headSha };
          }
          break;
        }
      }
    } catch (error) {
      this.log('change_effect_reconcile_failed', { stage: effect.stage, reason: this.code(error) });
      return 'unresolved';
    }
    if (!result) return 'unresolved';
    const confirmed = await this.store.confirmEffect({ ...key, stage: effect.stage, leaseId: null, result });
    if (confirmed.ok) return 'confirmed';
    if (confirmed.reason === 'result_mismatch') return this.blockReconciled(effect, 'result_mismatch');
    // 동시에 돈 대조가 먼저 확정했으면 그 결과를 쓴다.
    return (await this.effect(key, effect.stage))?.state === 'confirmed' ? 'confirmed' : 'unresolved';
  }
  private async blockReconciled(effect: EffectRecord, reason: string): Promise<'blocked' | 'unresolved'> {
    const blocked = await this.store.blockEffect({ changeId: effect.changeId, generation: effect.generation, stage: effect.stage, reason });
    return blocked.ok ? 'blocked' : 'unresolved';
  }
  // marker만 믿지 않는다. 저장소·작성자·head·base·제목·본문이 모두 맞아야 내 PR이다.
  private pullMatches(policy: ChangeRepositoryPolicy, generation: GenerationRecord, publication: PublicMetadata, marker: string, headSha: string, pull: WriterPullSnapshot): boolean {
    return pull.repoId === generation.repoId && pull.authorId === policy.writerBotUserId && pull.headBranch === generation.branch && pull.baseBranch === generation.baseBranch
      && pull.headSha === headSha && pull.title === publication.title && pull.body === publication.body && pull.body.includes(`<!-- ${marker} -->`);
  }

  // ---- 공통 ----

  private async invalidate(key: ChangeKey, from: 'approved' | 'publishing', to: 'superseded' | 'blocked', reason: string): Promise<never> {
    const result = await this.store.invalidateEvidence({ ...key, from, to, reason });
    if (!result.ok) {
      // 승인에서 검사하는 동안 다른 게시자가 올렸을 수 있다. 그래도 같은 판정이므로 닫는다.
      if (from === 'approved' && result.reason === 'phase_conflict' && result.current?.phase === 'publishing') return this.invalidate(key, 'publishing', to, reason);
      throw this.storeStop(result);
    }
    this.log('change_publish_closed', { to, reason });
    throw new Stop(to === 'superseded' ? { kind: 'superseded', reason } : { kind: 'blocked', reason });
  }
  private async fatal(plan: Plan, reason: string): Promise<Stop> {
    try { await this.invalidate(plan.key, 'publishing', 'blocked', reason); } catch (error) { if (error instanceof Stop) return error; throw error; }
    return new Stop({ kind: 'blocked', reason });
  }
  private deferred(reason: string): PublishOutcome { return { kind: 'deferred', reason, retryAt: this.now() + this.retryMs }; }
  private code(error: unknown): string {
    return error instanceof Error && /^[a-z][a-z0-9_]{0,63}$/.test(error.message) ? error.message : 'github_read_failed';
  }
  // 저장 계층에 단건 조회가 없어 미확정 목록과 확정 결과를 합쳐 본다.
  private async effect(key: ChangeKey, stage: EffectStage): Promise<(Pick<EffectRecord, 'state' | 'blockedReason'> & Partial<EffectRecord>) | null> {
    const found = (await this.store.unresolvedEffects({ changeId: key.changeId, generation: key.generation })).find(effect => effect.stage === stage);
    if (found) return found;
    return await this.confirmedResult(key, stage) ? { state: 'confirmed', blockedReason: null } : null;
  }
  private async confirmedResult(key: ChangeKey, stage: EffectStage): Promise<EffectResult | null> {
    const row = (await this.store.database.query<{ result: unknown }>(`SELECT result FROM change_delivery_effects WHERE change_id=$1 AND generation=$2 AND stage=$3 AND state='confirmed'`, [key.changeId, key.generation, stage])).rows[0];
    if (!row) return null;
    return (typeof row.result === 'string' ? JSON.parse(row.result) : row.result) as EffectResult;
  }
  // 저장 계층의 실패 값을 멈춤으로 옮긴다. 경합·잠금 시한 초과는 다시 부르면 되고, 끝 상태로 잘못 보고하지 않는다.
  private storeStop(failure: { reason: string; current?: { phase: string } }): Stop {
    if (failure.reason === 'busy' || failure.reason === 'effect_conflict' || failure.reason === 'lease_mismatch' || failure.reason === 'unresolved_effects') return new Stop({ kind: 'busy' });
    return new Stop({ kind: 'stopped', phase: failure.current?.phase ?? failure.reason });
  }
  private must<T>(result: { ok: true; value: T } | { ok: false; reason: string; current?: { phase: string } }): T {
    if (!result.ok) throw this.storeStop(result);
    return result.value;
  }
}
