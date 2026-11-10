import { z } from 'zod';
import { ChangeBriefSchema, CommandIdSchema, EvidenceBundleSchema, GenerationSchema, PublicMetadataSchema, ProvenanceLabelSchema, REVIEW_RISK_CATEGORIES, ChangeIdSchema, labelAllowsAuthorInput, propagateLabel } from './change-contracts.js';
import type { ArtifactFile, ChangeBrief, ChangeKey, ChangeNote, EvidenceBundle, ProvenanceLabel, PublicMetadata } from './change-contracts.js';
import { CHANGE_NOTE_LIMITS, ChangeNoteSchema } from './task-contracts.js';

// 공개 제목·본문·commit 메시지와 봇 PR 안내 리뷰 글을 만드는 유일한 곳이다. 승인 brief, 구조화된 수치·SHA·시험 상태,
// 작성 모델의 확인할 것·남은 위험(항목 글과 위치)만 받는다. raw 로그·대화·리뷰 자유문(자체 리뷰 findings 포함)을 받을 자리가 스키마에 없다.
// 값이 위험하면 고쳐서 내보내지 않고 전체 공개를 막는다.

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
  // 작성 모델이 쓴 확인할 것·남은 위험(C25 결과 칸). 공개 경로의 유일한 모델 글이라 무력화한 뒤 본문 전체 검사를 지난다.
  // 칸이 없는 것(옛 판 결과)과 빈 목록은 같은 공개 문구다.
  checks: z.array(ChangeNoteSchema).max(CHANGE_NOTE_LIMITS.items).optional(),
  risks: z.array(ChangeNoteSchema).max(CHANGE_NOTE_LIMITS.items).optional(),
});
export type PublicationInput = z.infer<typeof PublicationInputSchema>;
export type PublicationResult = { ok: true; publication: PublicMetadata; marker: string } | { ok: false; reason: string };

// 모델 글 한 줄. 줄바꿈이 목록 밖으로 나가 머리줄을 만들지 못하게 접는다.
const noteText = (text: string) => neutralizePublicText(text.replace(/\s*[\r\n]+\s*/g, ' ').trim());
// 경로가 코드 칸을 깨거나 줄을 바꾸지 못하게 한다.
const noteCode = (value: string) => `\`${neutralizePublicText(value.replace(/[`\r\n]/g, '?'))}\``;
// 경로는 512바이트까지 올 수 있다. 20개 항목이 모두 최대여도 본문 상한(16,000자) 안에 들도록 표시는 끝 100자만 남긴다(파일 이름 쪽이 남는다).
const NOTE_PATH_SHOWN = 100;
const shownPath = (path: string) => path.length > NOTE_PATH_SHOWN ? `…${path.slice(-NOTE_PATH_SHOWN)}` : path;
const noteWhere = (note: ChangeNote) => note.location ? ` (${noteCode(`${shownPath(note.location.path)}${note.location.line ? `:${note.location.line}` : ''}`)})` : '';
// PR 설명과 미리보기가 같은 줄을 쓴다. 미리보기는 승인 본문에 이 줄이 그대로 있는지로 공개 검사를 지난 글인지 확인한다.
export const noteLine = (note: ChangeNote): string => `- ${noteText(note.text)}${noteWhere(note)}`;
const noteSection = (heading: string, notes: readonly ChangeNote[] | undefined) => notes?.length ? [`## ${heading}`, ...notes.map(noteLine), ''] : [];

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
    ...noteSection('확인할 것', input.checks), ...noteSection('남은 위험', input.risks),
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

// ---- 봇 PR 안내 리뷰 글 ----

const GuidanceNotesSchema = z.array(ChangeNoteSchema).max(CHANGE_NOTE_LIMITS.items);
export interface GuidanceInput {
  checks: readonly ChangeNote[]; risks: readonly ChangeNote[];
  // 파일마다 diff 안 오른쪽 줄. 게시한 artifact patch에서 읽은 값이다(guidanceDiffLines).
  positions: ReadonlyMap<string, ReadonlySet<number>>;
  // 리뷰 정책 publish.maxInlineComments와 같은 값.
  limit: number;
  // 0은 처음 게시, 1부터는 수정 차례.
  round: number;
}
export interface GuidanceComment { path: string; line: number; body: string }
export type GuidanceRender =
  | { ok: true; body: string; comments: GuidanceComment[]; outside: { checks: ChangeNote[]; risks: ChangeNote[] } }
  | { ok: false; reason: 'guidance_input_invalid' | Exclude<ScanResult, { ok: true }>['reason'] };
// 확인할 것·남은 위험 중 위치가 diff 안인 것만 줄 댓글로 만든다. 자체 리뷰 findings는 받을 자리가 없다.
// 밖 목록(diff 밖·위치 없음·상한 초과)은 처음 게시면 PR 설명에, 수정 차례면 C27의 Discord 결과 요약에 있다. 그래서 밖 목록까지 함께 공개 검사를 한다.
export function renderGuidance(input: GuidanceInput, scan: ScanPolicy & { identity: { name: string; email: string } }): GuidanceRender {
  const checks = GuidanceNotesSchema.safeParse(input.checks);
  const risks = GuidanceNotesSchema.safeParse(input.risks);
  if (!checks.success || !risks.success || !Number.isSafeInteger(input.limit) || input.limit < 0 || !Number.isSafeInteger(input.round) || input.round < 0) return { ok: false, reason: 'guidance_input_invalid' };
  const comments: GuidanceComment[] = [];
  const outside = { checks: [] as ChangeNote[], risks: [] as ChangeNote[] };
  for (const [kind, heading, notes] of [['checks', '확인할 것', checks.data], ['risks', '남은 위험', risks.data]] as const) {
    for (const note of notes) {
      const line = note.location?.line;
      if (note.location && line && input.positions.get(note.location.path)?.has(line) && comments.length < input.limit) comments.push({ path: note.location.path, line, body: `**${heading}** ${noteText(note.text)}` });
      else outside[kind].push(note);
    }
  }
  const body = input.round === 0
    ? '확인할 것과 남은 위험 중 바뀐 줄에 있는 것만 줄 댓글로 달았어요. 전체 목록은 PR 설명에 있어요.'
    : `수정 ${input.round}번째의 확인할 것과 남은 위험 중 바뀐 줄에 있는 것만 줄 댓글로 달았어요. 나머지는 Discord 결과 요약에 있어요.`;
  // 경로도 공개된다. 파일 경로 검사는 게시 때 했지만 위치는 모델이 쓴 값이라 다시 본다.
  const everything = [...comments.flatMap(comment => [comment.path, comment.body]), ...[...outside.checks, ...outside.risks].flatMap(note => [noteLine(note), note.location?.path ?? ''])];
  const reason = scanPublicText({ title: 'guidance', body: [body, ...everything].join('\n') }, scan);
  if (reason) return { ok: false, reason };
  return { ok: true, body, comments, outside };
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
// owner의 입력이나 모델의 질문처럼 파일이 없는 글을 공개 문구와 같은 기준으로 본다. 걸린 사유 코드만 돌려주고 값은 돌려주지 않는다.
export function scanPublicText(text: { title: string; body: string }, policy: ScanPolicy & { identity: { name: string; email: string } }): Exclude<ScanResult, { ok: true }>['reason'] | null {
  const identity = { name: policy.identity.name, email: policy.identity.email, date: '2000-01-01T00:00:00Z' };
  const scanned = scanPublicPayload({ paths: [], files: [], branch: 'change', marker: 'change', publication: { title: text.title.slice(0, 256), body: text.body, commitMessage: 'change', author: identity, committer: identity, draft: false } }, { internalMarkers: policy.internalMarkers });
  return scanned.ok ? null : scanned.reason;
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
