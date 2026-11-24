import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { changeBranchName, gitBlobSha } from '../src/change-contracts.js';
import { publicationMarker, PublicReceipts, publicReceiptScan, publicTraceId, renderAmendmentCommit, renderPublication, scanPublicPayload } from '../src/change-publication.js';
import { createGitHubWriter } from '../src/github-writer.js';
import type { PublicationInput } from '../src/change-publication.js';
import { OutboundRefused, sendOutbound } from '../src/outbound.js';
import { outboundOf, RestrictedGitHub, reviewMarker, reviewPublicScan, ReviewPolicySchema } from '../src/review.js';
import type { GitHubTransport, ReviewGuard, ReviewPolicy } from '../src/review.js';
import { FAKE_APP_KEY, FakeGitHub, REPO as WRITER_REPO } from './change-github-fake.js';
import { fixtureBrief, fixtureBundle } from './change-store-fixture.js';

// O08 F7a(AC-06): GitHub 쪽 공개 검사. F-1은 일반 PR 리뷰의 최종 바이트(본문·인라인 댓글·경로),
// F-8은 PR 본문·커밋·리뷰·안내 표식의 내부 ID를 추적 ID로 바꾼 것을 본다. 경로마다 가짜 비밀을 심어 나가는 바이트에 남지 않는지 본다.

const REPO = 'fixture-org/fixture-repo';
const HEAD = 'b'.repeat(40);
const POLICY: ReviewPolicy = ReviewPolicySchema.parse({
  repositories: [{ id: 1, fullName: REPO, installationId: 2, visibility: 'public' }], allowedBotAuthorIds: [], commentCommand: null,
  reviewDrafts: false, rereviewOnBaseMove: null, comparison: 'merge_base', reviewSince: 0, internalMarkers: ['fixture-internal-host'],
  input: { maxFiles: 20, maxFileBytes: 65536, maxDiffBytes: 262144, maxArchiveBytes: 1048576, maxBodyChars: 4000 },
  publish: { maxFindings: 20, maxInlineComments: 10, maxBodyChars: 60000 }, reconcile: { maxPages: 1, maxReviewsPerRun: 1 },
});
const JOB = randomUUID();
const KEY = `github-review:${JOB}:1`;
const ROW = randomUUID();
const REVISION = 'rp-0123456789abcdef';
const TOKEN = `ghp_${'C'.repeat(36)}`;
const INTERNAL = [JOB, KEY, ROW, REVISION];
const expected = { repository: REPO, pr: 7, head: HEAD };
const request = (body: string, comments: { path: string; line: number; side: 'RIGHT'; body: string }[] = []) =>
  ({ method: 'POST', path: `/repos/${REPO}/pulls/7/reviews`, body: { commit_id: HEAD, event: 'COMMENT', body, comments } });
const guard = (scan = reviewPublicScan(POLICY, INTERNAL)): ReviewGuard =>
  ({ policyRevision: REVISION, revision: () => REVISION, ledger: { admit: async () => true }, scan });
// 실제 전송층(github-review-io)과 같게 묶음의 sendOutbound로만 보낸다.
function sealedTransport() {
  const sent: string[] = [];
  const transport: GitHubTransport = async write => {
    const sealed = outboundOf(write);
    if (!sealed) throw new Error('unsealed');
    return await sendOutbound(sealed.payload, sealed.check, { revision: sealed.revision, ledger: sealed.ledger,
      wire: { wire: async (_method, _path, body) => { sent.push(body.bytes); return { id: 1 }; } } }) as { id: number };
  };
  return { sent, github: new RestrictedGitHub(transport) };
}
const clean = `${reviewMarker(KEY)}\n참고용 자동 리뷰예요.`;

test('F7a F-1 AC-06: 리뷰 최종 바이트의 본문·인라인 댓글 본문·인라인 경로에 심은 토큰 꼴·작업 UUID·시도 키·행 ID·정책 판·내부 표식은 전송 0', async () => {
  const plants = [TOKEN, ...INTERNAL, 'fixture-internal-host'];
  for (const planted of plants) {
    for (const where of ['body', 'comment', 'path'] as const) {
      const { sent, github } = sealedTransport();
      const write = where === 'body' ? request(`${clean}\n못 본 파일 \`${planted}\``)
        : request(clean, [{ path: where === 'path' ? `src/${planted}.ts` : 'src/a.ts', line: 1, side: 'RIGHT', body: where === 'comment' ? `근거 ${planted}` : '근거' }]);
      await assert.rejects(github.createReview(write, expected, guard()), (error: unknown) => error instanceof OutboundRefused && error.reason === 'public_check', `${where} ${planted}`);
      assert.deepEqual(sent, [], `${where} ${planted}`);
    }
  }
});

test('F7a F-1 AC-06 대조군: 심지 않은 같은 모양은 한 번 나가고, 나간 바이트에 추적 ID만 있고 시도 키·작업 UUID는 없다', async () => {
  const { sent, github } = sealedTransport();
  await github.createReview(request(clean, [{ path: 'src/a.ts', line: 1, side: 'RIGHT', body: '근거' }]), expected, guard());
  assert.equal(sent.length, 1);
  assert.ok(sent[0]!.includes(publicTraceId('review', KEY)));
  for (const internal of INTERNAL) assert.ok(!sent[0]!.includes(internal), internal);
});

test('F7a F-8: 리뷰 표식은 시도 키의 추적 ID다(같은 키면 같은 ID, 다른 시도면 다른 ID, 키는 표식에 없음)', () => {
  assert.match(reviewMarker(KEY), /^<!-- homelab-bot-review:r[0-9a-f]{24} -->$/);
  assert.equal(reviewMarker(KEY), reviewMarker(KEY));
  assert.notEqual(reviewMarker(KEY), reviewMarker(`github-review:${JOB}:2`));
  assert.ok(!reviewMarker(KEY).includes(JOB));
  // 종류가 다르면 같은 내부 값이어도 ID가 겹치지 않는다.
  assert.notEqual(publicTraceId('review', KEY).slice(1), publicTraceId('guidance', KEY).slice(1));
});

const CHANGE = { changeId: 'fedcba9876543210fedcba9876543210', generation: 3 };
const BUNDLE = fixtureBundle({ generation: 3, policyRevision: 'fixture-policy-77', verifierRevision: 'fixture-verifier-77' });
const publicationInput = (overrides: Partial<PublicationInput> = {}): PublicationInput => ({
  key: CHANGE, label: 'public', brief: fixtureBrief({ summary: '요약 제목', goal: '목표 문장', acceptanceCriteria: ['기준 하나'] }),
  bundle: BUNDLE, branch: `bot/change/${CHANGE.changeId}/g3`, verifications: [{ commandId: 'smoke-unit', status: 'passed' }],
  review: { verdict: 'pass', risks: [] }, identity: { name: 'fixture-writer[bot]', email: 'fixture-writer[bot]@users.noreply.github.com' },
  at: Date.UTC(2026, 0, 2), ...overrides,
});
const SCAN = { internalMarkers: ['fixture-internal-host'] };
const INTERNAL_CHANGE = [CHANGE.changeId, BUNDLE.policyRevision, BUNDLE.verifierRevision, BUNDLE.artifactDigest];

test('F7a F-8: PR 본문·커밋 메시지에는 git 리비전과 추적 ID만, change ID·정책·검증기 판·산출물 digest는 없다', () => {
  const result = renderPublication(publicationInput(), SCAN);
  assert.equal(result.ok, true, JSON.stringify(result));
  const { publication, marker } = result as Extract<typeof result, { ok: true }>;
  const trace = publicTraceId('change', `${CHANGE.changeId}:g3`);
  assert.equal(marker, `homelab-bot-change:${trace}`);
  assert.equal(publicationMarker(CHANGE), marker);
  assert.ok(publication.body.includes(`<!-- ${marker} -->`));
  assert.ok(publication.body.includes(`- 추적 ID: ${trace}`));
  for (const kept of [BUNDLE.baseCommit, BUNDLE.baseTree, BUNDLE.resultTree]) assert.ok(publication.body.includes(kept), kept);
  assert.ok(publication.commitMessage.includes(`\nChange: ${trace}\n`));
  for (const internal of INTERNAL_CHANGE) {
    assert.ok(!publication.body.includes(internal), internal);
    assert.ok(!publication.commitMessage.includes(internal), internal);
  }
  const amendment = renderAmendmentCommit({ key: { ...CHANGE, round: 2 }, pullNumber: 9, identity: publicationInput().identity, at: Date.UTC(2026, 0, 3), bundle: BUNDLE });
  assert.ok(amendment.commitMessage.includes(`\nChange: ${trace}\n`));
  for (const internal of INTERNAL_CHANGE) assert.ok(!amendment.commitMessage.includes(internal), internal);
});

test('F7a F-8 AC-06: 모델 글에 심은 이 PR의 정책 판·검증기 판·산출물 digest는 공개 문구 검사(internal_marker)에 걸린다', () => {
  for (const planted of [BUNDLE.policyRevision, BUNDLE.verifierRevision, BUNDLE.artifactDigest]) {
    const result = renderPublication(publicationInput({ brief: fixtureBrief({ summary: '요약 제목', goal: `목표 ${planted}`, acceptanceCriteria: ['기준 하나'] }) }), SCAN);
    assert.deepEqual(result, { ok: false, reason: 'internal_marker' }, planted);
  }
});

// ---- 훑기: 새 검사 경로(createReview의 최종 바이트 검사 → 묶음 → 전송)의 포트 읽기·호출마다 한 번 던진다 ----

// 발송 한 길(src/outbound.ts strings)과 같은 차례로 문자열을 모은다. 나간 바이트가 검사한 문자열 목록과 같은지 대조한다.
const texts = (value: unknown, out: string[] = []): string[] => {
  if (typeof value === 'string') out.push(value);
  else if (Array.isArray(value)) for (const item of value) texts(item, out);
  else if (value !== null && typeof value === 'object') for (const [key, item] of Object.entries(value)) { out.push(key); texts(item, out); }
  return out;
};
type Point = string;
// 포트 객체를 감싸 속성 읽기와 함수 호출마다 차례 번호를 매긴다. throwAt 차례에서 진짜 읽기·호출 대신 던진다.
function wrap<T extends object>(value: T, path: string, probe: { points: Point[]; throwAt: number }): T {
  return new Proxy(value, {
    get(target, key, receiver) {
      const point = `get ${path}.${String(key)}`;
      if (probe.points.push(point) - 1 === probe.throwAt) throw new Error(`injected ${point}`);
      const inner = Reflect.get(target, key, receiver) as unknown;
      if (typeof inner === 'function') {
        const call = `call ${path}.${String(key)}`;
        return (...args: unknown[]) => {
          if (probe.points.push(call) - 1 === probe.throwAt) throw new Error(`injected ${call}`);
          return (inner as (...a: unknown[]) => unknown).apply(target, args);
        };
      }
      return inner !== null && typeof inner === 'object' ? wrap(inner as object, `${path}.${String(key)}`, probe) : inner;
    },
  });
}
async function sweepRun(body: string, throwAt: number) {
  const probe = { points: [] as Point[], throwAt };
  const approved = new Set<string>();
  const sent: string[] = [];
  const scan = reviewPublicScan(POLICY, INTERNAL);
  const ports = wrap({ policyRevision: REVISION, revision: () => REVISION, ledger: { admit: async () => true },
    scan: (list: readonly string[]) => { const reason = scan(list); if (reason === null) approved.add(JSON.stringify(list)); return reason; } }, 'guard', probe);
  const wire = wrap({ wire: async (_method: string, _path: string, bytes: { bytes: string }) => { sent.push(bytes.bytes); return { id: 1 }; } }, 'wire', probe);
  const transport: GitHubTransport = async write => {
    const sealed = outboundOf(write);
    if (!sealed) throw new Error('unsealed');
    return await sendOutbound(sealed.payload, sealed.check, { revision: sealed.revision, ledger: sealed.ledger, wire }) as { id: number };
  };
  try { await new RestrictedGitHub(transport).createReview(request(body, [{ path: 'src/a.ts', line: 1, side: 'RIGHT', body: '근거' }]), expected, ports); } catch { /* 던지기·거절은 결과로 센다 */ }
  const unscanned = sent.filter(bytes => !approved.has(JSON.stringify(texts(JSON.parse(bytes))))).length;
  return { points: probe.points, sent: sent.length, unscanned };
}
test('F7a 훑기: 리뷰 게시 검사 경로의 포트 읽기·호출마다 던져도 검사하지 않은 바이트가 나간 일 0, 심은 본문은 어느 실행에서도 전송 0', async () => {
  const lines: string[] = [];
  for (const [scenario, body] of [['clean', clean], ['planted', `${clean}\n${TOKEN}`]] as const) {
    const baseline = await sweepRun(body, -1);
    let violations = 0;
    let runs = 0;
    for (let at = 0; at < baseline.points.length; at++) {
      const run = await sweepRun(body, at);
      runs++;
      const bad = run.unscanned > 0 || run.sent > 1 || (scenario === 'planted' && run.sent > 0);
      if (bad) violations++;
      lines.push(`${scenario} | ${baseline.points[at]} | throw | sent=${run.sent} unscanned=${run.unscanned}${bad ? ' | VIOLATION' : ''}`);
    }
    lines.push(`${scenario} summary: points=${baseline.points.length} runs=${runs} baseline_sent=${baseline.sent} violations=${violations}`);
    assert.equal(baseline.unscanned, 0);
    assert.equal(baseline.sent, scenario === 'clean' ? 1 : 0);
    assert.equal(violations, 0);
  }
  for (const line of lines) console.log(`sweep-review ${line}`);
});

// ---- P3-6: 산출물 공개 검사 영수증과 writer 쓰기 바이트의 묶음 ----

const W_KEY = { changeId: 'abcdefabcdefabcdefabcdefabcdef01', generation: 1 };
const W_BRANCH = changeBranchName(W_KEY.changeId, 1);
const W_FILE = Buffer.from('export const a = 1;\n');
const W_IDENTITY = { name: 'fixture-writer[bot]', email: 'fixture-writer[bot]@users.noreply.github.com', date: '2026-01-02T03:04:05Z' };
const W_META = { title: '요약', body: '본문', commitMessage: `요약\n\nChange: ${publicTraceId('change', `${W_KEY.changeId}:g1`)}\n`, author: W_IDENTITY, committer: W_IDENTITY, draft: false };
const PLANTED_FILE = Buffer.from(`const token = "${TOKEN}";\n`);
function scannedReceipt() {
  const result = scanPublicPayload({ paths: ['src/a.ts'], files: [{ path: 'src/a.ts', content: W_FILE }], publication: W_META, branch: W_BRANCH, marker: publicationMarker(W_KEY) }, SCAN);
  assert.equal(result.ok, true, JSON.stringify(result));
  return (result as Extract<typeof result, { ok: true }>).receipt;
}

test('P3-6 영수증: 쓰기 바이트의 문자열이 모두 검사한 글·경로·파일 내용(base64를 풀어)·구조 값일 때만 통과한다', () => {
  const receipt = scannedReceipt();
  const scan = publicReceiptScan(receipt, ['main']);
  const of = (body: unknown) => texts(JSON.parse(JSON.stringify(body)));
  const S = 'a'.repeat(40);
  const passing = [
    { content: W_FILE.toString('base64'), encoding: 'base64' },
    { base_tree: S, tree: [{ path: 'src/a.ts', mode: '100644', type: 'blob', sha: S }, { path: 'src/a.ts', mode: '100644', type: 'blob', sha: null }] },
    { message: W_META.commitMessage, tree: S, parents: [S], author: W_IDENTITY, committer: W_IDENTITY },
    { ref: `refs/heads/${W_BRANCH}`, sha: S },
    { title: W_META.title, body: W_META.body, head: W_BRANCH, base: 'main', draft: false, maintainer_can_modify: false },
    { sha: S, force: false },
  ];
  for (const body of passing) assert.equal(scan(of(body)), null, JSON.stringify(body));
  const refused = [
    { content: PLANTED_FILE.toString('base64'), encoding: 'base64' },
    { content: TOKEN, encoding: 'base64' },
    { base_tree: S, tree: [{ path: `src/${TOKEN}.ts`, mode: '100644', type: 'blob', sha: S }] },
    { message: `${W_META.commitMessage}${TOKEN}`, tree: S, parents: [S], author: W_IDENTITY, committer: W_IDENTITY },
    { message: W_META.commitMessage, tree: S, parents: [S], author: { ...W_IDENTITY, name: JOB }, committer: W_IDENTITY },
    { ref: 'refs/heads/bot/change/other/g1', sha: S },
    { title: W_META.title, body: `${W_META.body} ${JOB}`, head: W_BRANCH, base: 'main', draft: false, maintainer_can_modify: false },
  ];
  for (const body of refused) assert.equal(scan(of(body)), 'unscanned', JSON.stringify(body));
  // 검사 밖 값(base 브랜치)은 writer가 넘긴 값만 받는다.
  assert.equal(publicReceiptScan(receipt)(of(passing[4])), 'unscanned');
  // 영수증이 없거나 이 파일이 내지 않은 영수증은 아무것도 통과시키지 않는다.
  assert.equal(publicReceiptScan(undefined, ['main'])(of(passing[0])), 'unscanned');
  const forged = { texts: new Set(receipt.texts), files: new Set(receipt.files) };
  assert.equal(publicReceiptScan(forged, ['main'])(of(passing[0])), 'unscanned');
  assert.throws(() => new PublicReceipts().record(W_KEY, forged), /public_receipt_unissued/);
});

test('P3-6 writer: 영수증이 없거나 영수증 밖의 blob(가짜 토큰을 심은 파일)은 GitHub에 보내지 않고, 영수증 안의 파일은 보낸다', async () => {
  const github = new FakeGitHub();
  const receipts = new PublicReceipts();
  const io = createGitHubWriter({ app: { appId: '12345', privateKey: FAKE_APP_KEY }, receipts, repositories: async () => ({ ...WRITER_REPO, baseBranches: ['main'] }),
    authorizeWrite: async () => {}, send: github.send, now: () => github.clock });
  const target = { key: W_KEY, repoId: WRITER_REPO.id };
  const blobPosts = () => github.sent.filter(s => s.method === 'POST' && s.path.endsWith('/git/blobs')).length;
  const file = (content: Buffer) => ({ target, files: [{ path: 'src/a.ts', content, blobSha: gitBlobSha(content) }] });
  assert.deepEqual(await io.writer.createBlobs(file(W_FILE)), { kind: 'not_sent', code: 'public_check_unbound' });
  assert.equal(blobPosts(), 0);
  receipts.record(W_KEY, scannedReceipt());
  assert.deepEqual(await io.writer.createBlobs(file(PLANTED_FILE)), { kind: 'not_sent', code: 'public_check_unbound' });
  assert.equal(blobPosts(), 0);
  // 다른 세대의 영수증으로는 나가지 않는다.
  assert.deepEqual(await io.writer.createBlobs({ ...file(W_FILE), target: { key: { ...W_KEY, generation: 2 }, repoId: WRITER_REPO.id } }), { kind: 'not_sent', code: 'public_check_unbound' });
  assert.equal(blobPosts(), 0);
  const sent = await io.writer.createBlobs(file(W_FILE));
  assert.equal(sent.kind, 'confirmed', JSON.stringify(sent));
  assert.equal(blobPosts(), 1);
});

// 훑기: writer 쓰기 경로의 포트(영수증 책·인가·fetch) 읽기·호출마다 한 번 던진다. 영수증 밖 바이트의 blob이 나간 일 0, 많아야 한 번.
async function writerRun(content: Buffer, throwAt: number) {
  const probe = { points: [] as Point[], throwAt };
  const github = new FakeGitHub();
  const receipts = new PublicReceipts();
  receipts.record(W_KEY, scannedReceipt());
  let blobs: string[] = [];
  try {
    const net = wrap({ send: github.send }, 'fetch', probe);
    const ports = wrap({ receipts, authorizeWrite: async () => {} }, 'ports', probe);
    const io = createGitHubWriter({ app: { appId: '12345', privateKey: FAKE_APP_KEY }, receipts: ports.receipts, repositories: async () => ({ ...WRITER_REPO, baseBranches: ['main'] }),
      authorizeWrite: ports.authorizeWrite, send: (input, init) => net.send(input, init), now: () => github.clock });
    await io.writer.createBlobs({ target: { key: W_KEY, repoId: WRITER_REPO.id }, files: [{ path: 'src/a.ts', content, blobSha: gitBlobSha(content) }] });
  } catch { /* 던지기는 결과로 센다 */ }
  blobs = github.sent.filter(s => s.method === 'POST' && s.path.endsWith('/git/blobs')).map(s => (s.body as { content: string }).content);
  const unscanned = blobs.filter(b64 => !Buffer.from(b64, 'base64').equals(W_FILE)).length;
  return { points: probe.points, sent: blobs.length, unscanned };
}
test('F7a 훑기 writer: 영수증 책·인가·fetch의 읽기·호출마다 던져도 영수증 밖 blob이 나간 일 0, 심은 파일은 어느 실행에서도 전송 0', async () => {
  const lines: string[] = [];
  for (const [scenario, content] of [['clean', W_FILE], ['planted', PLANTED_FILE]] as const) {
    const baseline = await writerRun(content, -1);
    let violations = 0;
    for (let at = 0; at < baseline.points.length; at++) {
      const run = await writerRun(content, at);
      const bad = run.unscanned > 0 || run.sent > 1 || (scenario === 'planted' && run.sent > 0);
      if (bad) violations++;
      lines.push(`${scenario} | ${baseline.points[at]} | throw | sent=${run.sent} unscanned=${run.unscanned}${bad ? ' | VIOLATION' : ''}`);
    }
    lines.push(`${scenario} summary: points=${baseline.points.length} runs=${baseline.points.length} baseline_sent=${baseline.sent} violations=${violations}`);
    assert.equal(baseline.unscanned, 0);
    assert.equal(baseline.sent, scenario === 'clean' ? 1 : 0);
    assert.equal(violations, 0);
  }
  for (const line of lines) console.log(`sweep-writer ${line}`);
});
