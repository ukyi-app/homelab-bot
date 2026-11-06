import { z } from 'zod';
import { ChangeBriefSchema, CommandIdSchema, EvidenceBundleSchema, GenerationSchema, PublicMetadataSchema, ProvenanceLabelSchema, REVIEW_RISK_CATEGORIES, ChangeIdSchema, labelAllowsAuthorInput, propagateLabel } from './change-contracts.js';
import type { ArtifactFile, ChangeBrief, ChangeKey, EvidenceBundle, ProvenanceLabel, PublicMetadata } from './change-contracts.js';

// 공개 제목·본문·commit 메시지를 만드는 유일한 곳이다. 승인 brief와 구조화된 수치·SHA·시험 상태만 받는다.
// raw 로그·대화·리뷰 자유문을 받을 자리가 스키마에 없다. 값이 위험하면 고쳐서 내보내지 않고 전체 공개를 막는다.

const ZWSP = String.fromCodePoint(0x200b);
// 공개 PR에서 알림·역참조·자동 닫기·외부 요청을 일으키는 표기를 끊는다. 내용을 지우지 않고 링크만 되지 않게 한다.
export function neutralizePublicText(text: string): string {
  return text
    .replaceAll('@', `@${ZWSP}`)
    .replace(/#(?=\d)/g, `#${ZWSP}`)
    .replace(/\bGH-(?=\d)/gi, match => `${match.slice(0, 2)}${ZWSP}-`)
    .replaceAll('<', '&lt;')
    .replaceAll('![', `!${ZWSP}[`)
    .replaceAll('://', `:${ZWSP}//`);
}

// 대조용 표식이다. 제목·Discord ID를 넣지 않는다. change ID는 무작위 값이다.
export const publicationMarker = (key: ChangeKey): string => `homelab-bot-change:${key.changeId}:g${key.generation}`;

export const PublicationInputSchema = z.strictObject({
  key: z.strictObject({ changeId: ChangeIdSchema, generation: GenerationSchema }),
  label: ProvenanceLabelSchema, brief: ChangeBriefSchema, bundle: EvidenceBundleSchema, branch: z.string(),
  // V1은 통과한 결과만 게시한다. 실패·미실행 상태를 표현할 자리를 두지 않는다.
  verifications: z.array(z.strictObject({ commandId: CommandIdSchema, status: z.literal('passed') })).min(1),
  // 위험의 코드 문자열은 리뷰어가 쓴 값이라 싣지 않는다. 고정 enum만 공개한다.
  review: z.strictObject({ verdict: z.enum(['pass', 'pass_with_warnings']), risks: z.array(z.strictObject({ priority: z.enum(['P2', 'P3']), category: z.enum(REVIEW_RISK_CATEGORIES) })).max(64) }),
  identity: z.strictObject({ name: z.string(), email: z.string() }),
  at: z.number().int().nonnegative(),
});
export type PublicationInput = z.infer<typeof PublicationInputSchema>;
export type PublicationResult = { ok: true; publication: PublicMetadata; marker: string } | { ok: false; reason: string };

const riskLines = (risks: PublicationInput['review']['risks']) => {
  if (!risks.length) return ['- 남은 위험: 없음'];
  const counts = new Map<string, number>();
  for (const risk of risks) counts.set(`${risk.priority} ${risk.category}`, (counts.get(`${risk.priority} ${risk.category}`) ?? 0) + 1);
  return [...counts.entries()].sort(([a], [b]) => a < b ? -1 : 1).map(([name, count]) => `- 남은 위험: ${name} ${count}건`);
};
function renderBody(input: PublicationInput, brief: ChangeBrief, bundle: EvidenceBundle, label: ProvenanceLabel, marker: string): string {
  return [
    '## 요약', neutralizePublicText(brief.summary), '',
    '## 목표', neutralizePublicText(brief.goal), '',
    '## 인수 조건', ...brief.acceptanceCriteria.map(item => `- ${neutralizePublicText(item)}`), '',
    '## 검증', ...input.verifications.map(item => `- \`${item.commandId}\`: ${item.status}`), '',
    '## 사전 리뷰', `- 판정: ${input.review.verdict}, 범위 complete`, ...riskLines(input.review.risks), '',
    '## 고정 리비전', `- base commit: ${bundle.baseCommit}`, `- base tree: ${bundle.baseTree}`, `- result tree: ${bundle.resultTree}`, `- artifact: ${bundle.artifactDigest}`,
    `- policy: ${bundle.policyRevision}`, `- verifier: ${bundle.verifierRevision}`, `- 출처 label: ${label}`, '',
    '봇이 만든 제안 PR이다. 사람이 검토해 병합한다.', '',
    `<!-- ${marker} -->`,
  ].join('\n');
}
// 같은 입력이면 같은 결과다. 승인 digest와 commit SHA가 여기에 달려 있어 현재 시각을 읽지 않는다. 시각은 호출자가 한 번 정해 넘긴다.
export function renderPublication(raw: PublicationInput, scan: ScanPolicy): PublicationResult {
  const parsed = PublicationInputSchema.safeParse(raw);
  if (!parsed.success) return { ok: false, reason: 'publication_input_invalid' };
  const input = parsed.data;
  // 모델이 낮출 수 없다. 기록된 label과 brief 신고 중 제한적인 값이 이긴다.
  const label = propagateLabel([input.label, input.brief.label]);
  if (!labelAllowsAuthorInput(label)) return { ok: false, reason: 'label_blocked' };
  const marker = publicationMarker(input.key);
  const firstLine = input.brief.summary.split('\n')[0]!.trim();
  const title = neutralizePublicText(firstLine);
  const date = new Date(Math.floor(input.at / 1000) * 1000).toISOString().replace('.000Z', 'Z');
  const identity = { name: input.identity.name, email: input.identity.email, date };
  const commitMessage = `${title}\n\nChange: ${input.key.changeId}/g${input.key.generation}\nBase: ${input.bundle.baseCommit}\nTree: ${input.bundle.resultTree}\nArtifact: ${input.bundle.artifactDigest}\n`;
  const candidate = { title, body: renderBody(input, input.brief, input.bundle, label, marker), commitMessage, author: identity, committer: identity, draft: false };
  // 넘친다고 자르면 승인한 문구와 다른 말이 된다.
  if (title.length > 256 || candidate.body.length > 16000 || commitMessage.length > 4000) return { ok: false, reason: 'publication_too_long' };
  const publication = PublicMetadataSchema.safeParse(candidate);
  if (!publication.success) return { ok: false, reason: 'publication_invalid' };
  const scanned = scanPublicPayload({ paths: [], files: [], publication: publication.data, branch: input.branch, marker }, scan);
  if (!scanned.ok) return { ok: false, reason: scanned.reason };
  return { ok: true, publication: publication.data, marker };
}

// ---- 공개 payload 검사 ----

export interface ScanPolicy { internalMarkers: readonly string[] }
export interface PublicPayload { paths: readonly string[]; files: readonly ArtifactFile[]; publication: PublicMetadata; branch: string; marker: string }
export type ScanResult = { ok: true } | { ok: false; reason: 'secret_detected' | 'internal_marker' | 'metadata_sensitive' };

// 탐지기는 완전성 증거가 아니다. 출처 label 차단이 우선이고 이 검사는 추가 방어다.
const SECRET_PATTERNS = [/\b(?:ghp|gho|ghs|ghu|ghr|github_pat)_[A-Za-z0-9_]{20,}/, /\bsk-[A-Za-z0-9_-]{20,}/, /-----BEGIN [A-Z ]*PRIVATE KEY-----/, /\b[a-z0-9-]+\.ts\.net\b/i,
  /\b100\.(?:6[4-9]|[7-9]\d|1[01]\d|12[0-7])\.\d{1,3}\.\d{1,3}\b/, /\brefresh_token\\?["']\s*:/];
// 공개 metadata·경로·브랜치에만 쓴다. 코드 안의 숫자·사설 IP까지 막으면 평범한 변경이 막힌다.
const METADATA_PATTERNS = [/(?<![0-9a-f])\d{17,20}(?![0-9a-f])/, /[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+\.[A-Za-z0-9.-]+/, /(?:^|[^A-Za-z0-9_])\/(?:home|Users|root)\//,
  /\b10\.\d{1,3}\.\d{1,3}\.\d{1,3}\b/, /\b192\.168\.\d{1,3}\.\d{1,3}\b/, /\b172\.(?:1[6-9]|2\d|3[01])\.\d{1,3}\.\d{1,3}\b/];
const stripInvisible = (text: string) => text.replace(/\p{Cf}/gu, '');
// 문자열 연결로 쪼갠 토큰을 잇는다. 점·콜론은 남겨 호스트·IP 형태를 유지한다.
const joinPieces = (text: string) => text.replace(/["'`+,\s\\]+/g, '');
const alnumOnly = (text: string) => text.replace(/[^\p{L}\p{N}]+/gu, '').toLowerCase();
function markerEncodings(marker: string): string[] {
  const bytes = Buffer.from(marker);
  return [bytes.toString('base64').replace(/=+$/, ''), bytes.toString('base64url').replace(/=+$/, ''), bytes.toString('hex')];
}
function decodeUrlEncoding(text: string): string {
  return text.replace(/%[0-9a-f]{2}/gi, match => String.fromCharCode(Number.parseInt(match.slice(1), 16)));
}
function hasSecret(text: string): boolean {
  const visible = stripInvisible(text);
  return SECRET_PATTERNS.some(pattern => pattern.test(visible) || pattern.test(joinPieces(visible)));
}
function hasMarker(text: string, markers: readonly string[]): boolean {
  const visible = stripInvisible(text);
  const lowered = visible.toLowerCase();
  const decoded = decodeUrlEncoding(visible).toLowerCase();
  const squashed = alnumOnly(visible);
  const decodedSquashed = alnumOnly(decoded);
  return markers.some(marker => {
    const folded = marker.toLowerCase();
    if (lowered.includes(folded) || decoded.includes(folded)) return true;
    const packed = alnumOnly(marker);
    // 너무 짧으면 흔한 단어와 겹친다.
    if (packed.length >= 6 && (squashed.includes(packed) || decodedSquashed.includes(packed))) return true;
    return markerEncodings(marker).some(encoded => visible.includes(encoded) || lowered.includes(encoded.toLowerCase()));
  });
}
export function scanPublicPayload(payload: PublicPayload, policy: ScanPolicy): ScanResult {
  const { publication } = payload;
  // 신원 이메일은 스키마가 noreply로 고정한다. 그래서 여기에는 넣지 않는다.
  const metadata = [publication.title, publication.body, publication.commitMessage, publication.author.name, publication.committer.name, payload.branch, payload.marker];
  const contents = payload.files.map(file => Buffer.from(file.content).toString('utf8'));
  const everything = [...payload.paths, ...metadata, ...contents];
  if (everything.some(hasSecret)) return { ok: false, reason: 'secret_detected' };
  // 파일 경계에 걸쳐 나눈 조각까지 잇는다.
  if (everything.some(text => hasMarker(text, policy.internalMarkers)) || hasMarker(contents.join(''), policy.internalMarkers)) return { ok: false, reason: 'internal_marker' };
  const visible = [...payload.paths, ...metadata].map(stripInvisible);
  if (visible.some(text => METADATA_PATTERNS.some(pattern => pattern.test(text)))) return { ok: false, reason: 'metadata_sensitive' };
  return { ok: true };
}
