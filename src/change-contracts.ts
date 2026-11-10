import { createHash, randomBytes } from 'node:crypto';
import { z } from 'zod';

// T19 CHANGE_PR의 계약이다. 아직 어떤 진입점에도 조립되지 않았다. 이 파일은 네트워크·DB·실행기를 모르는 값과 순수 함수, port 선언만 둔다.
// B1(artifact·검증)·B2(미게시 리뷰)·B3(writer·게시)·B4(배포 읽기)가 서로 기다리지 않고 이 계약에 맞춰 구현한다.

// ---- 단계와 전이 ----

export const CHANGE_PHASES = ['requested', 'admitted', 'authoring', 'snapshot_ready', 'verifying', 'reviewing',
  'awaiting_publish_approval', 'approved', 'publishing', 'proposed', 'amending', 'merged', 'observing_deploy',
  'superseded', 'blocked', 'cancelled', 'failed'] as const;
export type ChangePhase = typeof CHANGE_PHASES[number];
export const TERMINAL_CHANGE_PHASES = ['superseded', 'blocked', 'cancelled', 'failed'] as const;
export type TerminalChangePhase = typeof TERMINAL_CHANGE_PHASES[number];
export const ChangePhaseSchema = z.enum(CHANGE_PHASES);

const STOP = TERMINAL_CHANGE_PHASES;
// migrations/017의 change_phase_transition_allowed와 같은 표다. 시험이 모든 쌍을 대조한다.
// proposed에서 failed가 없는 이유: 이미 공개된 PR은 내부 오류로 사라지지 않는다. 닫힘 없이 병합되지 않은 PR은 cancelled(closed_unmerged)다.
// merged 이후에는 superseded·cancelled가 없다. 병합은 되돌릴 수 없어 관측 실패만 남는다.
// 성공의 끝은 끝 상태가 아니라 observing_deploy에 남은 배포 관측이다(DEPLOYMENT_SETTLED_STATES).
export const CHANGE_PHASE_TRANSITIONS: Readonly<Record<ChangePhase, readonly ChangePhase[]>> = Object.freeze({
  requested: ['admitted', 'blocked', 'cancelled', 'failed'],
  admitted: ['authoring', 'blocked', 'cancelled', 'failed'],
  authoring: ['snapshot_ready', ...STOP],
  snapshot_ready: ['verifying', ...STOP],
  verifying: ['reviewing', ...STOP],
  // reviewing → authoring은 같은 generation의 게시 전 고치기 차례다. 전용 메서드(ChangeStore.startSelfFix)로만 간다.
  reviewing: ['awaiting_publish_approval', 'authoring', ...STOP],
  awaiting_publish_approval: ['approved', ...STOP],
  approved: ['publishing', ...STOP],
  publishing: ['proposed', ...STOP],
  // proposed ↔ amending은 게시 뒤 수정 차례(C27)다. 전용 메서드(ChangeStore.startAmendment·finishAmendment)로만 간다.
  // amending에서도 failed가 없다. 차례가 실패하면 커밋 없이 proposed로 돌아오고, 차례 effect를 해소하지 못하면 blocked다.
  proposed: ['merged', 'amending', 'superseded', 'blocked', 'cancelled'],
  amending: ['proposed', 'merged', 'blocked', 'cancelled'],
  merged: ['observing_deploy', 'blocked', 'failed'],
  observing_deploy: ['blocked', 'failed'],
  superseded: [], blocked: [], cancelled: [], failed: [],
});
export const canTransition = (from: ChangePhase, to: ChangePhase): boolean => CHANGE_PHASE_TRANSITIONS[from].includes(to);
export const isTerminalPhase = (phase: ChangePhase): phase is TerminalChangePhase => (TERMINAL_CHANGE_PHASES as readonly ChangePhase[]).includes(phase);
// 게시 전 고치기 차례 상한(사용자 2026-11-09의 기본값). migrations/026의 fix_round CHECK와 같은 값이고 시험이 대조한다.
export const CHANGE_SELF_FIX = Object.freeze({ maxRounds: 2 });
// 게시 뒤 수정 차례 상한(사용자 2026-11-09 "한 PR에 수정은 최대 10번"). 대기열에 든 요청과 실패한 차례도 센다.
// migrations/027의 change_amendments.round CHECK와 같은 값이고 시험이 대조한다.
export const CHANGE_AMENDMENT = Object.freeze({ maxRounds: 10 });
// 전이 표 밖의 유일한 재시작이다. 새 generation은 admission부터 다시 받는다. blocked·failed는 사람이 볼 일이라 자동으로 다시 열지 않는다.
export const GENERATION_RESTART = Object.freeze({ from: 'superseded', to: 'requested' } as const);
export const MAX_GENERATION = 999;
// 사유는 코드만 받는다. 자유문이면 내부 문구가 상태 응답·공개 경로로 샌다.
export const REASON_CODE = /^[a-z][a-z0-9_]{0,63}$/;
export const ReasonCodeSchema = z.string().regex(REASON_CODE);

// ---- 출처 label ----

// 뒤로 갈수록 제한적이다. unknown은 아직 사람이 분류하지 않은 값이고 private는 비공개로 확인된 값이라 private가 이긴다.
export const PROVENANCE_LABELS = ['public', 'approved_public_summary', 'unknown', 'private'] as const;
export type ProvenanceLabel = typeof PROVENANCE_LABELS[number];
export const ProvenanceLabelSchema = z.enum(PROVENANCE_LABELS);
const labelRank = (label: ProvenanceLabel) => PROVENANCE_LABELS.indexOf(label);
// 결과 label은 입력 중 가장 제한적인 값이다. 입력이 하나도 없으면 출처를 모르는 것이므로 unknown이다.
export function propagateLabel(inputs: readonly ProvenanceLabel[]): ProvenanceLabel {
  if (!inputs.length) return 'unknown';
  return inputs.reduce((worst, label) => labelRank(label) > labelRank(worst) ? label : worst);
}
// 모델·작성자가 신고한 값을 합칠 때 쓴다. 신고로는 올릴 수만 있고 낮출 수 없다.
export const raiseLabel = (current: ProvenanceLabel, claimed: ProvenanceLabel): ProvenanceLabel => propagateLabel([current, claimed]);
export const labelIsLowering = (from: ProvenanceLabel, to: ProvenanceLabel): boolean => labelRank(to) < labelRank(from);
export const labelAllowsAuthorInput = (label: ProvenanceLabel): boolean => label === 'public' || label === 'approved_public_summary';

// ---- 공통 형식 ----

export const GIT_SHA = /^[0-9a-f]{40}$/;
export const SHA256_HEX = /^[0-9a-f]{64}$/;
export const GitShaSchema = z.string().regex(GIT_SHA);
export const Sha256Schema = z.string().regex(SHA256_HEX);
export const RevisionSchema = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._:/@+-]{0,127}$/);
const OpaqueRefSchema = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/);
// 검증은 ID로만 받는다. ID의 argv·cwd·한도·toolchain은 B1의 registry가 정한다. 공백·셸 문자가 없어 사용자 문자열이 여기로 들어올 수 없다.
export const COMMAND_ID = /^[a-z0-9][a-z0-9-]{0,63}$/;
export const CommandIdSchema = z.string().regex(COMMAND_ID);
export const RepoIdSchema = z.number().int().positive().max(Number.MAX_SAFE_INTEGER);
export const GenerationSchema = z.number().int().min(1).max(MAX_GENERATION);
export const BranchNameSchema = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._/-]{0,127}$/)
  .refine(name => !name.startsWith('refs/') && !name.includes('..') && !name.includes('//') && !name.endsWith('/') && !name.endsWith('.lock'));
const MILLIS = z.number().int().nonnegative();

export interface ChangeKey { changeId: string; generation: number }
// 게시 뒤 수정 차례의 키(C27). generation을 올리지 않고 차례 번호를 하나 더 둔다. 브랜치·승인 대상은 그 generation의 것 그대로다.
export interface AmendmentKey extends ChangeKey { round: number }

// ---- 고정 직렬화와 digest ----

// 필드 순서에 흔들리지 않는 직렬화다. 배열 순서는 의미로 보존한다. 표현이 둘이 될 수 있는 값은 거부한다(Date, undefined 생략, NaN→null).
export function canonicalJson(value: unknown): string {
  const unsupported = () => new Error('canonical_json_unsupported');
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return JSON.stringify(value);
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw unsupported();
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (typeof value === 'object') {
    const proto = Object.getPrototypeOf(value) as unknown;
    if (proto !== Object.prototype && proto !== null) throw unsupported();
    const object = value as Record<string, unknown>;
    return `{${Object.keys(object).sort().map(key => `${JSON.stringify(key)}:${canonicalJson(object[key])}`).join(',')}}`;
  }
  throw unsupported();
}
// domain이 달라 한 종류의 digest를 다른 종류로 재사용할 수 없다.
const domainDigest = (domain: string, value: unknown) => createHash('sha256').update(`homelab-bot/${domain}\n${canonicalJson(value)}`).digest('hex');
export const sha256Hex = (bytes: Uint8Array): string => createHash('sha256').update(bytes).digest('hex');
export const gitBlobSha = (bytes: Uint8Array): string => createHash('sha1').update(`blob ${bytes.byteLength}\0`).update(bytes).digest('hex');
const compareText = (a: string, b: string) => a < b ? -1 : a > b ? 1 : 0;

// ---- 브랜치 ----

export const CHANGE_ID = /^[0-9a-f]{32}$/;
export const ChangeIdSchema = z.string().regex(CHANGE_ID);
const BRANCH = /^bot\/change\/([0-9a-f]{32})\/g([1-9][0-9]{0,2})$/;
// 무작위 값이라 Discord ID·제목이 브랜치 이름으로 공개되지 않는다.
export const newChangeId = (): string => randomBytes(16).toString('hex');
export function changeBranchName(changeId: string, generation: number): string {
  if (!CHANGE_ID.test(changeId) || !Number.isInteger(generation) || generation < 1 || generation > MAX_GENERATION) throw new Error('change_branch_invalid');
  return `bot/change/${changeId}/g${generation}`;
}
export const changeBranchRef = (changeId: string, generation: number): string => `refs/heads/${changeBranchName(changeId, generation)}`;
export function parseChangeBranch(name: string): ChangeKey | null {
  const match = BRANCH.exec(name);
  return match ? { changeId: match[1]!, generation: Number(match[2]) } : null;
}

// ---- 공개 brief ----

const PublicLine = (max: number) => z.string().min(1).max(max).regex(/^[^\p{Cc}]+$/u);
// 개행·탭 외의 제어 문자는 받지 않는다.
const PublicText = (max: number) => z.string().min(1).max(max).regex(/^(?:[^\p{Cc}]|[\n\t])+$/u);
export const ChangeBriefSchema = z.strictObject({
  summary: PublicText(4000), goal: PublicText(4000),
  acceptanceCriteria: z.array(PublicText(1000)).min(1).max(32),
  repoId: RepoIdSchema, baseBranch: BranchNameSchema,
  // 빈 허용 목록·빈 검증 목록은 정책이 없는 것과 같아 받지 않는다.
  allowedPaths: z.array(z.string().min(1).max(512)).min(1).max(64),
  deniedPaths: z.array(z.string().min(1).max(512)).max(64),
  verificationCommandIds: z.array(CommandIdSchema).min(1).max(8),
  label: ProvenanceLabelSchema,
});
export type ChangeBrief = z.infer<typeof ChangeBriefSchema>;
export const briefDigest = (brief: ChangeBrief): string => domainDigest('change-brief/v1', brief);

// ---- 증거 묶음 ----

export const EvidenceBundleSchema = z.strictObject({
  repoId: RepoIdSchema, generation: GenerationSchema,
  baseCommit: GitShaSchema, baseTree: GitShaSchema, resultTree: GitShaSchema, artifactDigest: Sha256Schema,
  policyRevision: RevisionSchema, verifierRevision: RevisionSchema,
});
export type EvidenceBundle = z.infer<typeof EvidenceBundleSchema>;
export const evidenceBundleDigest = (bundle: EvidenceBundle): string => domainDigest('change-evidence/v1', bundle);
// 수정 차례의 증거 묶음. 묶음 8개 필드는 처음 게시와 같은 모양이고(baseCommit은 차례를 시작할 때 읽은 PR head) 차례 번호를 함께 묶는다.
// domain이 달라 처음 게시의 묶음 digest·승인 digest 재료로 쓰이지 못한다.
export const amendmentEvidenceDigest = (round: number, bundle: EvidenceBundle): string => domainDigest('change-amendment-evidence/v1', { round, bundle });
// 수정 요청 확인 때 센 PR 리뷰·리뷰 댓글·대화 댓글 ID 묶음(`review:<id>`·`review_comment:<id>`·`comment:<id>`). 순서와 무관하다.
export const AMENDMENT_MATERIAL_ID = /^(review|review_comment|comment):[1-9][0-9]{0,15}$/;
export const amendmentMaterialsDigest = (ids: readonly string[]): string => domainDigest('change-amendment-materials/v1', [...new Set(ids)].sort(compareText));

// ---- artifact ----

// 넘으면 차단한다. 잘라서 통과시키지 않는다. 파일 수 두 값은 [제안]이고 실측 뒤 조정한다.
export const ARTIFACT_LIMITS = Object.freeze({
  changedContentBytes: 1024 * 1024,
  httpBodyBytes: 2 * 1024 * 1024,
  changedFiles: 256,
  manifestEntries: 5000,
  pathBytes: 512,
});
export const MANIFEST_CHANGE_KINDS = ['added', 'modified', 'deleted', 'mode_changed', 'unchanged'] as const;
export type ManifestChangeKind = typeof MANIFEST_CHANGE_KINDS[number];
// 일반 blob만 받는다. T0에 symlink·gitlink가 있는 저장소는 변경 대상이 아니어도 manifest를 만들 수 없어 시작부터 닫힌다.
export const MANIFEST_MODES = ['100644', '100755'] as const;
export const ChangePathSchema = z.string().refine(path => {
  if (!path || Buffer.byteLength(path) > ARTIFACT_LIMITS.pathBytes || path.includes('\\') || /\p{Cc}/u.test(path)) return false;
  return path.split('/').every(segment => segment && segment !== '.' && segment !== '..' && segment.toLowerCase() !== '.git');
}, 'change_path_invalid');
// deleted 항목은 지워진 T0 leaf를 설명하고, 그 외 항목은 T1 leaf를 설명한다. rename은 deleted+added로 나타난다.
export const ArtifactManifestEntrySchema = z.strictObject({
  path: ChangePathSchema, mode: z.enum(MANIFEST_MODES), changeKind: z.enum(MANIFEST_CHANGE_KINDS),
  blobSha: GitShaSchema, sha256: Sha256Schema, size: z.number().int().nonnegative(),
});
export type ArtifactManifestEntry = z.infer<typeof ArtifactManifestEntrySchema>;
const carriesContent = (kind: ManifestChangeKind) => kind === 'added' || kind === 'modified';
export const ArtifactManifestSchema = z.strictObject({
  version: z.literal(1), baseCommit: GitShaSchema, baseTree: GitShaSchema, resultTree: GitShaSchema,
  // patch는 표시용이지만 리뷰가 읽으므로 A에 묶는다.
  patchSha256: Sha256Schema,
  entries: z.array(ArtifactManifestEntrySchema).min(1).max(ARTIFACT_LIMITS.manifestEntries),
}).superRefine((manifest, context) => {
  const problem = (message: string) => context.addIssue({ code: 'custom', message });
  // deleted는 T0에만, added는 T1에만 있다. 한 트리 안에서만 파일·디렉터리가 부딪힌다. 그래서 파일을 지우고 그 자리를 디렉터리로 바꾸는 변경은 받는다.
  const inBase = new Set(manifest.entries.filter(entry => entry.changeKind !== 'added').map(entry => entry.path));
  const inResult = new Set(manifest.entries.filter(entry => entry.changeKind !== 'deleted').map(entry => entry.path));
  let previous: string | null = null;
  let changed = 0;
  let contentBytes = 0;
  for (const entry of manifest.entries) {
    if (previous !== null && Buffer.compare(Buffer.from(previous), Buffer.from(entry.path)) >= 0) problem('manifest_order');
    previous = entry.path;
    const segments = entry.path.split('/');
    for (let depth = 1; depth < segments.length; depth++) {
      const ancestor = segments.slice(0, depth).join('/');
      if ((entry.changeKind !== 'added' && inBase.has(ancestor)) || (entry.changeKind !== 'deleted' && inResult.has(ancestor))) problem('manifest_file_directory_conflict');
    }
    if (entry.changeKind !== 'unchanged') changed++;
    if (carriesContent(entry.changeKind)) contentBytes += entry.size;
  }
  if (!changed) problem('manifest_no_changes');
  if (changed > ARTIFACT_LIMITS.changedFiles) problem('manifest_too_many_changes');
  if (contentBytes > ARTIFACT_LIMITS.changedContentBytes) problem('manifest_content_too_large');
});
export type ArtifactManifest = z.infer<typeof ArtifactManifestSchema>;
export const artifactDigest = (manifest: ArtifactManifest): string => domainDigest('change-artifact/v1', manifest);
export interface ArtifactFile { path: string; content: Uint8Array }
export interface ArtifactBundle { manifest: ArtifactManifest; files: ArtifactFile[]; patch: string }
export type ArtifactFilesResult = { ok: true; changedBytes: number }
  | { ok: false; reason: 'file_duplicate' | 'file_unexpected' | 'file_missing' | 'content_mismatch' | 'binary_content'; path: string };
const isText = (bytes: Uint8Array) => {
  if (bytes.includes(0)) return false;
  try { new TextDecoder('utf-8', { fatal: true }).decode(bytes); return true; } catch { return false; }
};
// 바이트가 manifest와 정확히 같은지 본다. V1은 텍스트 변경만 받는다.
export function validateArtifactFiles(manifest: ArtifactManifest, files: readonly ArtifactFile[]): ArtifactFilesResult {
  const required = new Map(manifest.entries.filter(entry => carriesContent(entry.changeKind)).map(entry => [entry.path, entry]));
  const seen = new Set<string>();
  let changedBytes = 0;
  for (const file of files) {
    if (seen.has(file.path)) return { ok: false, reason: 'file_duplicate', path: file.path };
    seen.add(file.path);
    const entry = required.get(file.path);
    if (!entry) return { ok: false, reason: 'file_unexpected', path: file.path };
    if (file.content.byteLength !== entry.size || sha256Hex(file.content) !== entry.sha256 || gitBlobSha(file.content) !== entry.blobSha) {
      return { ok: false, reason: 'content_mismatch', path: file.path };
    }
    if (!isText(file.content)) return { ok: false, reason: 'binary_content', path: file.path };
    changedBytes += file.content.byteLength;
  }
  for (const path of required.keys()) if (!seen.has(path)) return { ok: false, reason: 'file_missing', path };
  return { ok: true, changedBytes };
}

// ---- 시험·리뷰 receipt ----

export const VERIFICATION_STATUSES = ['passed', 'failed', 'timed_out', 'not_run', 'source_changed', 'unknown'] as const;
export type VerificationStatus = typeof VERIFICATION_STATUSES[number];
// 로그 원문 자리는 없다. raw 출력은 공개 경로로 가면 안 되고, 민감정보가 나온 로그는 저장도 하지 않아 digest만 남는다.
export const VerificationReceiptSchema = z.strictObject({
  runId: OpaqueRefSchema, commandId: CommandIdSchema, runnerRevision: RevisionSchema, imageRevision: RevisionSchema,
  bundle: EvidenceBundleSchema, exitCode: z.number().int().nullable(), timedOut: z.boolean(), logDigest: Sha256Schema.nullable(),
  status: z.enum(VERIFICATION_STATUSES),
}).superRefine((receipt, context) => {
  const problem = (message: string) => context.addIssue({ code: 'custom', message });
  if (receipt.status === 'passed' && (receipt.exitCode !== 0 || receipt.timedOut || receipt.logDigest === null)) problem('verification_passed_inconsistent');
  if (receipt.status === 'failed' && (receipt.exitCode === null || receipt.exitCode === 0 || receipt.timedOut)) problem('verification_failed_inconsistent');
  if (receipt.status === 'timed_out' && !receipt.timedOut) problem('verification_timeout_inconsistent');
  if (receipt.status !== 'timed_out' && receipt.timedOut) problem('verification_timeout_inconsistent');
  if (receipt.status === 'not_run' && (receipt.exitCode !== null || receipt.logDigest !== null)) problem('verification_not_run_inconsistent');
});
export type VerificationReceipt = z.infer<typeof VerificationReceiptSchema>;
export const verificationReceiptDigest = (receipt: VerificationReceipt): string => domainDigest('change-verification/v1', receipt);

export const REVIEW_VERDICTS = ['pass', 'pass_with_warnings', 'blocked'] as const;
export const REVIEW_COVERAGES = ['complete', 'incomplete'] as const;
export const REVIEW_RISK_CATEGORIES = ['correctness', 'test_weakening', 'protected_path', 'indirect_ci', 'data_exposure', 'other'] as const;
// 리뷰 자유문 자리는 없다. 공개 경로에 자동 복사되지 않게 고정 코드와 digest만 받는다. 원문을 어디에 둘지는 B2가 정한다.
export const ReviewReceiptSchema = z.strictObject({
  instructionRevision: RevisionSchema, sessionId: z.uuid(), jobId: OpaqueRefSchema, bundle: EvidenceBundleSchema,
  coverage: z.enum(REVIEW_COVERAGES), verdict: z.enum(REVIEW_VERDICTS),
  risks: z.array(z.strictObject({ priority: z.enum(['P0', 'P1', 'P2', 'P3']), category: z.enum(REVIEW_RISK_CATEGORIES), code: ReasonCodeSchema })).max(64),
  findingsDigest: Sha256Schema,
}).superRefine((receipt, context) => {
  if (receipt.verdict === 'blocked') return;
  const problem = (message: string) => context.addIssue({ code: 'custom', message });
  if (receipt.coverage !== 'complete') problem('review_pass_needs_full_coverage');
  if (receipt.risks.some(risk => risk.priority === 'P0' || risk.priority === 'P1' || risk.category === 'data_exposure')) problem('review_pass_with_high_risk');
  if ((receipt.verdict === 'pass') !== (receipt.risks.length === 0)) problem('review_verdict_risk_mismatch');
});
export type ReviewReceipt = z.infer<typeof ReviewReceiptSchema>;
export const reviewReceiptDigest = (receipt: ReviewReceipt): string => domainDigest('change-review/v1', receipt);

// ---- 공개 metadata와 승인 digest ----

// 신원·시각을 서버가 고정해 재시도해도 같은 commit SHA가 나온다. 이메일은 GitHub noreply만 받아 개인 주소가 commit에 실리지 못한다.
const PublicIdentitySchema = z.strictObject({
  name: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._[\]-]{0,63}$/),
  email: z.string().regex(/^[A-Za-z0-9+._[\]-]{1,128}@users\.noreply\.github\.com$/),
  date: z.string().regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/),
});
export const PublicMetadataSchema = z.strictObject({
  title: PublicLine(256), body: PublicText(16000), commitMessage: PublicText(4000),
  author: PublicIdentitySchema, committer: PublicIdentitySchema, draft: z.boolean(),
});
export type PublicMetadata = z.infer<typeof PublicMetadataSchema>;

const hasUniqueCommands = (items: readonly { commandId: string }[]) => new Set(items.map(item => item.commandId)).size === items.length;
// 승인이 가리키는 정확한 대상이다. 통과한 결과만 이 모양을 만들 수 있다(실패 결과의 Draft 예외는 V1에 없다).
export const ApprovalSubjectSchema = z.strictObject({
  changeId: ChangeIdSchema, bundle: EvidenceBundleSchema, baseBranch: BranchNameSchema, branch: z.string(),
  verifications: z.array(z.strictObject({ commandId: CommandIdSchema, status: z.literal('passed'), receiptDigest: Sha256Schema })).min(1).refine(hasUniqueCommands, 'verification_command_duplicate'),
  review: z.strictObject({ receiptDigest: Sha256Schema, coverage: z.literal('complete'), verdict: z.enum(['pass', 'pass_with_warnings']) }),
  publication: PublicMetadataSchema,
  // 승인 시점의 CI 형태. 계산과 비교는 B3이 한다.
  ciFingerprint: Sha256Schema,
}).superRefine((subject, context) => {
  const parsed = parseChangeBranch(subject.branch);
  if (!parsed || parsed.changeId !== subject.changeId || parsed.generation !== subject.bundle.generation) context.addIssue({ code: 'custom', message: 'approval_branch_mismatch' });
});
export type ApprovalSubject = z.infer<typeof ApprovalSubjectSchema>;
// 시험 나열 순서는 의미가 없어 정렬해서 묶는다.
export const approvalDigest = (subject: ApprovalSubject): string => domainDigest('change-approval/v1', {
  ...subject, verifications: [...subject.verifications].sort((a, b) => compareText(a.commandId, b.commandId)),
});

// ---- 게시 effect ----

export const EFFECT_STAGES = ['blob', 'tree', 'commit', 'ref', 'pull'] as const;
export type EffectStage = typeof EFFECT_STAGES[number];
export const nextEffectStage = (stage: EffectStage): EffectStage | null => EFFECT_STAGES[EFFECT_STAGES.indexOf(stage) + 1] ?? null;
export const previousEffectStage = (stage: EffectStage): EffectStage | null => EFFECT_STAGES[EFFECT_STAGES.indexOf(stage) - 1] ?? null;
export const EFFECT_STATES = ['pending', 'sending', 'confirmed', 'unknown', 'blocked'] as const;
export type EffectState = typeof EFFECT_STATES[number];
// migrations/017의 change_effect_transition_allowed와 같은 표다. sending→pending은 연결 전 실패처럼 확실히 안 나간 경우만 쓴다.
// unknown→pending은 없다. 보냈는지 모르는 요청을 다시 보내면 중복이 생기므로 대조로만 끝낸다.
export const EFFECT_TRANSITIONS: Readonly<Record<EffectState, readonly EffectState[]>> = Object.freeze({
  pending: ['sending', 'blocked'], sending: ['pending', 'confirmed', 'unknown', 'blocked'],
  unknown: ['confirmed', 'blocked'], confirmed: [], blocked: [],
});
export const canTransitionEffect = (from: EffectState, to: EffectState): boolean => EFFECT_TRANSITIONS[from].includes(to);
// 지나면 blocked와 사람 해소로 넘어간다. 값은 T17 unknown 대조 기한과 같다.
export const UNKNOWN_RECONCILE_MS = 86_400_000;
export const EFFECT_LEASE_MS = 30_000;
export const EFFECT_RESOLUTIONS = ['not_published', 'published_recorded'] as const;
export type EffectResolution = typeof EFFECT_RESOLUTIONS[number];

const ChangeRefSchema = z.string().refine(ref => ref.startsWith('refs/heads/') && parseChangeBranch(ref.slice('refs/heads/'.length)) !== null, 'change_ref_invalid');
const ChangeBranchSchema = z.string().refine(name => parseChangeBranch(name) !== null, 'change_branch_invalid');
// 삭제·mode 변경만 있는 generation은 올릴 내용이 없어 빈 목록이다. 게시자는 요청 없이 이 stage를 확정하고 tree로 넘어간다.
const ShaListSchema = z.array(GitShaSchema).max(ARTIFACT_LIMITS.changedFiles);
// stage마다 응답을 대조할 값이다. intent와 함께 네트워크 호출 전에 저장한다.
export const EffectExpectedSchema = z.discriminatedUnion('stage', [
  z.strictObject({ stage: z.literal('blob'), shas: ShaListSchema }),
  z.strictObject({ stage: z.literal('tree'), baseTree: GitShaSchema, treeSha: GitShaSchema }),
  z.strictObject({ stage: z.literal('commit'), treeSha: GitShaSchema, parent: GitShaSchema, commitSha: GitShaSchema }),
  z.strictObject({ stage: z.literal('ref'), ref: ChangeRefSchema, sha: GitShaSchema }),
  z.strictObject({ stage: z.literal('pull'), headBranch: ChangeBranchSchema, baseBranch: BranchNameSchema, headSha: GitShaSchema, marker: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/) }),
]);
export type EffectExpected = z.infer<typeof EffectExpectedSchema>;
export const EffectResultSchema = z.discriminatedUnion('stage', [
  z.strictObject({ stage: z.literal('blob'), shas: ShaListSchema }),
  z.strictObject({ stage: z.literal('tree'), treeSha: GitShaSchema }),
  z.strictObject({ stage: z.literal('commit'), commitSha: GitShaSchema, treeSha: GitShaSchema, parents: z.array(GitShaSchema) }),
  z.strictObject({ stage: z.literal('ref'), ref: ChangeRefSchema, sha: GitShaSchema }),
  z.strictObject({ stage: z.literal('pull'), number: z.number().int().positive(), headBranch: ChangeBranchSchema, baseBranch: BranchNameSchema, headSha: GitShaSchema }),
]);
export type EffectResult = z.infer<typeof EffectResultSchema>;
export function effectResultMatches(expected: EffectExpected, result: EffectResult): boolean {
  if (expected.stage === 'blob' && result.stage === 'blob') {
    const found = new Set(result.shas);
    return found.size === new Set(expected.shas).size && expected.shas.every(sha => found.has(sha));
  }
  if (expected.stage === 'tree' && result.stage === 'tree') return expected.treeSha === result.treeSha;
  if (expected.stage === 'commit' && result.stage === 'commit') {
    return expected.commitSha === result.commitSha && expected.treeSha === result.treeSha && result.parents.length === 1 && result.parents[0] === expected.parent;
  }
  if (expected.stage === 'ref' && result.stage === 'ref') return expected.ref === result.ref && expected.sha === result.sha;
  if (expected.stage === 'pull' && result.stage === 'pull') {
    return expected.headBranch === result.headBranch && expected.baseBranch === result.baseBranch && expected.headSha === result.headSha;
  }
  return false;
}
// intent에 저장하는 요청 digest다. 재시도가 처음 요청과 같은 내용인지 대조한다.
export const effectRequestDigest = (stage: EffectStage, request: unknown): string => domainDigest(`change-effect/${stage}/v1`, request);

// ---- 배포 관측 ----

export const DEPLOYMENT_STATES = ['pending', 'unknown', 'observed', 'not_applicable', 'blocked'] as const;
export type DeploymentState = typeof DEPLOYMENT_STATES[number];
// 더 조회하지 않아도 되는 상태다. pending·unknown은 관측 창 안에서 계속 읽는다.
export const DEPLOYMENT_SETTLED_STATES = ['observed', 'not_applicable', 'blocked'] as const;
const ImageDigestSchema = z.string().regex(/^sha256:[0-9a-f]{64}$/);
// H(PR head)·M(병합)·K(배포 설정 commit)·D(이미지 digest)는 따로 둔다. squash·rebase가 있어 H와 M의 관계를 가정하지 않는다.
export const DeploymentObservationSchema = z.strictObject({
  state: z.enum(DEPLOYMENT_STATES), headSha: GitShaSchema, mergeCommit: GitShaSchema,
  configCommit: GitShaSchema.nullable(), imageDigest: ImageDigestSchema.nullable(),
  argoObservedAt: MILLIS.nullable(), workloadObservedAt: MILLIS.nullable(), observedAt: MILLIS,
  reason: ReasonCodeSchema.nullable(),
}).superRefine((observation, context) => {
  const problem = (message: string) => context.addIssue({ code: 'custom', message });
  if (observation.state === 'observed') {
    if (observation.configCommit === null || observation.imageDigest === null || observation.argoObservedAt === null || observation.workloadObservedAt === null) problem('deployment_observed_incomplete');
    if (observation.reason !== null) problem('deployment_observed_reason');
  }
  // 근거 코드 없이 해당 없음·막힘으로 닫으면 미등록 서비스가 배포 없음으로 보인다.
  if ((observation.state === 'not_applicable' || observation.state === 'blocked') && observation.reason === null) problem('deployment_reason_required');
});
export type DeploymentObservation = z.infer<typeof DeploymentObservationSchema>;

// ---- 병렬 PR이 구현할 port ----

export interface ChangeTarget { key: ChangeKey; repoId: number }

// 저장소 안 위치. 줄을 모르면 null이다. 경로는 ChangePathSchema를 지난 값이다.
export interface ChangeLocation { path: string; line: number | null }
// 확인할 것·남은 위험 한 항목. 작성 모델이 쓴 글이라 증거(승인 digest 재료)가 아니고, 공개 경로로 내기 전에 공개 검사를 거친다.
export interface ChangeNote { text: string; location?: ChangeLocation }
// 수정 차례의 자료 블록 한 항목. PR 리뷰·리뷰 댓글·대화 댓글이고, 작성 모델에는 자료로만 들어간다. 탈퇴한 계정이면 authorId가 null이다.
export const REVIEW_MATERIAL_KINDS = ['review', 'review_comment', 'comment'] as const;
export const AUTHOR_ASSOCIATIONS = ['COLLABORATOR', 'CONTRIBUTOR', 'FIRST_TIMER', 'FIRST_TIME_CONTRIBUTOR', 'MANNEQUIN', 'MEMBER', 'NONE', 'OWNER'] as const;
export interface ReviewMaterial {
  kind: typeof REVIEW_MATERIAL_KINDS[number]; authorId: number | null; association: typeof AUTHOR_ASSOCIATIONS[number];
  location: ChangeLocation | null; body: string;
}
// 수정 차례 입력. owner의 Discord 말이 지시이고, 그 PR의 리뷰·댓글은 자료다. head는 PR 브랜치 head이고 작성의 base가 된다.
// 자료는 오래된 것부터 적는다. 상한을 넘으면 앞에서부터 빠진다(task-contracts boundAmendmentMaterials).
export interface ChangeAmendmentInput { pullNumber: number; head: string; instruction: string; materials: readonly ReviewMaterial[] }
// 게시 전 고치기 차례의 자료 한 항목. 앞 차례 자체 리뷰의 P0·P1 발견이고 작성 모델에는 자료로만 들어간다. 지시는 고정 문구다.
// 모델이 쓴 리뷰 문장이라 비공개 표(change_review_findings)에서 오고 공개 경로로 내지 않는다. 위치를 모르면 location이 null이다.
export interface SelfFixFinding { priority: 'P0' | 'P1'; code: string; title: string; detail: string; evidence: string; location: ChangeLocation | null }

// B1. 작업자 v2 계약. 응답을 잃으면 같은 receipt로 fetchResult만 한다. 모델을 다시 돌리지 않는다.
// options·checks·risks는 변경 작성 판(task-contracts CHANGE_INSTRUCTIONS_REVISION) 요청에만 있다.
export type AuthorResult =
  | { kind: 'running' }
  | { kind: 'needs_input'; question: string; options?: readonly string[] }
  | { kind: 'snapshot'; artifact: ArtifactBundle; transportBytes: number; checks?: readonly ChangeNote[]; risks?: readonly ChangeNote[] }
  | { kind: 'unknown' | 'failed' | 'cancelled'; code: string };
export interface ChangeAuthorPort {
  // 옛 작업자면 false다. CHANGE만 닫히고 기존 /task는 그대로 돈다.
  supportsV2(): Promise<boolean>;
  // 게시 전 고치기 차례의 작성 요청을 보낼 수 있는지. false면 호출자는 고치지 않고 지금처럼 review_blocked로 닫는다.
  supportsSelfFix(): Promise<boolean>;
  // selfFix는 게시 전 고치기 차례에만 있다. base는 그 generation의 B·T0 그대로다.
  start(input: { target: ChangeTarget; baseCommit: string; baseTree: string; policyRevision: string; brief: ChangeBrief; amendment?: ChangeAmendmentInput;
    selfFix?: { round: number; findings: readonly SelfFixFinding[] } }): Promise<{ receiptId: string }>;
  // 호출 전에 ChangePrivateInputs.record로 답변의 label을 기록한다. label_blocked면 부르지 않는다. 입력 label은 작업자 쪽 재확인용이다.
  resume(input: { receiptId: string; answer: string; label: ProvenanceLabel }): Promise<void>;
  cancel(receiptId: string): Promise<void>;
  fetchResult(receiptId: string): Promise<AuthorResult>;
  // save가 끝난 뒤에만 부른다. 그 전에 작업자의 결과를 지우면 복구할 수 없다.
  finalize(receiptId: string): Promise<void>;
}
// B1. 게시 서버 쪽 영속 저장이다. 구현은 ChangeStore 위의 어댑터로 충분하다. 저장 실패면 작업자 결과를 지우지 않는다.
export type ArtifactSaveResult = { ok: true; artifactDigest: string } | { ok: false; reason: string };
export interface ChangeArtifactPort {
  save(key: ChangeKey, artifact: ArtifactBundle, transportBytes: number): Promise<ArtifactSaveResult>;
  load(key: ChangeKey): Promise<(ArtifactBundle & { artifactDigest: string }) | null>;
}
// B1. 무자격 시험 실행기. commandId는 registry 키이고 argv를 받지 않는다. 실행하지 못한 경우도 status='not_run' receipt로 돌려준다.
export interface ChangeVerificationPort {
  run(input: { key: ChangeKey; bundle: EvidenceBundle; commandId: string }): Promise<VerificationReceipt>;
  fetchReceipt(input: { key: ChangeKey; commandId: string }): Promise<VerificationReceipt | null>;
}
// B2. 작성 세션과 다른 새 세션의 미게시 리뷰. author 세션 ID·대화·설명은 입력에 없다.
export interface ChangeReviewPort {
  review(input: { key: ChangeKey; bundle: EvidenceBundle; brief: ChangeBrief; manifest: ArtifactManifest; patch: string; verifications: readonly VerificationReceipt[] }): Promise<ReviewReceipt>;
  fetchReceipt(key: ChangeKey): Promise<ReviewReceipt | null>;
}
// B3. 호출 결과를 넷으로 나눈다. unknown은 대조로만 끝낸다. 토큰·URL·method는 입출력에 없고 writer 안에서만 산다.
export type WriterOutcome<T> =
  | { kind: 'confirmed'; value: T }
  | { kind: 'not_sent'; code: string }
  | { kind: 'rejected'; status: number; code: string }
  | { kind: 'unknown'; code: string };
export interface WriterCommitMetadata { message: string; author: PublicMetadata['author']; committer: PublicMetadata['committer'] }
export interface WriterPullSnapshot { number: number; state: 'open' | 'closed'; merged: boolean; headBranch: string; headSha: string; baseBranch: string; authorId: number; title: string; body: string; repoId: number }
export interface ChangeWriterPort {
  // 각 stage의 effect로 기록한 뒤 부른다. 파일별 검증을 마친 바이트만 넘긴다.
  createBlobs(input: { target: ChangeTarget; files: readonly (ArtifactFile & { blobSha: string })[] }): Promise<WriterOutcome<{ shas: string[] }>>;
  createTree(input: { target: ChangeTarget; baseTree: string; entries: readonly { path: string; mode: '100644' | '100755'; blobSha: string | null }[] }): Promise<WriterOutcome<{ treeSha: string }>>;
  createCommit(input: { target: ChangeTarget; treeSha: string; parent: string; metadata: WriterCommitMetadata }): Promise<WriterOutcome<{ commitSha: string; treeSha: string; parents: string[] }>>;
  createRef(input: { target: ChangeTarget; branch: string; sha: string }): Promise<WriterOutcome<{ ref: string; sha: string }>>;
  createPull(input: { target: ChangeTarget; branch: string; baseBranch: string; title: string; body: string; draft: boolean }): Promise<WriterOutcome<WriterPullSnapshot>>;
  // 대조와 신선도 검사. 정확한 이름·SHA만 받는다. prefix 검색은 없다.
  readBranchHead(input: { target: ChangeTarget; branch: string }): Promise<{ sha: string } | null>;
  readCommit(input: { target: ChangeTarget; sha: string }): Promise<{ treeSha: string; parents: string[] } | null>;
  readBlobExists(input: { target: ChangeTarget; sha: string }): Promise<boolean>;
  // truncated 응답을 쓰지 않는다. 끝까지 읽지 못하면 complete=false이고 호출자가 차단한다. 없으면 null이다.
  readTreeLeaves(input: { target: ChangeTarget; sha: string }): Promise<{ complete: boolean; leaves: { path: string; mode: string; blobSha: string }[] } | null>;
  findPulls(input: { target: ChangeTarget; headBranch: string; baseBranch: string }): Promise<WriterPullSnapshot[]>;
}
// B4. 사람이 병합한 뒤의 읽기 전용 경로다. writer와 다른 자격을 쓴다.
export type MergeReading = { state: 'open' } | { state: 'closed_unmerged' } | { state: 'merged'; prNumber: number; headSha: string; mergeCommit: string };
export interface ChangeDeploymentPort {
  readMerge(input: { target: ChangeTarget; prNumber: number }): Promise<MergeReading>;
  observe(input: { target: ChangeTarget; headSha: string; mergeCommit: string }): Promise<DeploymentObservation>;
}
