import { after, before, beforeEach, test } from 'node:test';
import assert from 'node:assert/strict';
import { gzipSync } from 'node:zlib';
import { ReviewWorker } from '../src/review-input.js';
import type { ArchiveFetcher, ReviewerModel } from '../src/review-input.js';
import { GitHubError, RestrictedGitHub, ReviewPolicySource, ReviewPublisher, ReviewQueue, ReviewRequests, ReviewRuntime } from '../src/review.js';
import type { GitHubReader, GitHubTransport, GitHubWrite, ReviewPolicy, ReviewTarget, ReviewTargetReader } from '../src/review.js';
import { bindReviewRequests, REVIEW_REQUEST_TEXT } from '../src/review-request.js';
import { harness } from './c13-proposal-fixture.js';
import type { Harness } from './c13-proposal-fixture.js';
import { localDatabase } from './helpers.js';

// C30 리뷰 요청(COLLEAGUE_SPEC §4.10, AC-30). 경계는 S1이다: Gateway 프레임 → 수신·대화 차례(PGlite) → 제안 대조 → 리뷰 접수 →
// 리뷰 실행(가짜 작업자 모델) → 게시(가짜 GitHub). 리뷰 App 설치 조회와 토큰 범위는 github-review-app 시험이 본다.
const BASE = 'a'.repeat(40), HEAD = 'b'.repeat(40);
const LISTED = { id: 301, fullName: 'ukyi-app/listed-repo', installationId: 701, visibility: 'public' as const };
const OUTSIDE: ReviewTarget = { id: 302, fullName: 'ukyi-app/other-repo', installationId: 701, visibility: 'private' };
const POLICY: ReviewPolicy = { repositories: [LISTED], allowedBotAuthorIds: [], commentCommand: '/fixture-review',
  reviewDrafts: false, rereviewOnBaseMove: false, comparison: 'merge_base', reviewSince: 0, internalMarkers: ['fixture-internal-host'],
  input: { maxFiles: 20, maxFileBytes: 100_000, maxDiffBytes: 200_000, maxArchiveBytes: 1_000_000, maxBodyChars: 4000 },
  publish: { maxFindings: 10, maxInlineComments: 5, maxBodyChars: 20_000 }, reconcile: { maxPages: 1, maxReviewsPerRun: 3 } };
const FINDING = { severity: 'P2', title: '경계 확인', path: 'src/app.ts', line: 2, condition: 'count가 0일 때',
  impact: 'NaN이 나온다', evidence: 'return total / count;', suggestion: 'count 0을 먼저 거부한다' };
const OUTPUT = { findings: [FINDING], open_questions: [], public_summary: '나눗셈 경계를 확인해 주세요.' };

const pull = (repo: { id: number; fullName: string }, o: Record<string, unknown> = {}) => {
  const side = { id: repo.id, full_name: repo.fullName };
  return { number: 7, state: 'open', draft: false, merged: false, title: '평균 계산', body: '본문', user: { id: 42, login: 'fixture-member', type: 'User' },
    author_association: 'MEMBER', updated_at: '2026-11-10T00:00:00Z', head: { sha: HEAD, ref: 'feature', repo: side },
    base: { sha: BASE, ref: 'main', repo: side }, ...o };
};
function tarGz(files: Record<string, string>): Buffer {
  const header = (name: string, size: number, type: string) => {
    const h = Buffer.alloc(512);
    h.write(name, 0, 100); h.write('0000644\0', 100); h.write('0000000\0', 108); h.write('0000000\0', 116);
    h.write(`${size.toString(8).padStart(11, '0')}\0`, 124); h.write('00000000000\0', 136); h.write('        ', 148);
    h.write(type, 156); h.write('ustar\0', 257); h.write('00', 263);
    let sum = 0; for (const b of h) sum += b;
    h.write(`${sum.toString(8).padStart(6, '0')}\0 `, 148);
    return h;
  };
  const pad = (b: Buffer) => Buffer.concat([b, Buffer.alloc((512 - (b.length % 512)) % 512)]);
  const blocks = [header('fixture-sha/', 0, '5')];
  for (const [path, content] of Object.entries(files)) { const data = Buffer.from(content); blocks.push(header(`fixture-sha/${path}`, data.length, '0'), pad(data)); }
  blocks.push(Buffer.alloc(1024));
  return gzipSync(Buffer.concat(blocks));
}

// 리뷰 App이 읽는 GitHub. 저장소마다 PR을 두고, 설치된 저장소만 대상 조회에 답한다. 부른 순서를 남긴다.
class FakeGitHub implements GitHubReader {
  pulls = new Map<string, unknown>();
  installed = new Map<string, ReviewTarget>();
  calls: string[] = [];
  writes: GitHubWrite[] = [];
  private pullOf(repository: string, number: number) {
    const value = this.pulls.get(`${repository.toLowerCase()}#${number}`);
    if (!value) throw new GitHubError(404);
    return structuredClone(value);
  }
  async pullRequest(repository: string, number: number) { this.calls.push(`pull ${repository}#${number}`); return this.pullOf(repository, number); }
  async openPullRequests() { return []; }
  async compare() { return { files: [{ path: 'src/app.ts', previousPath: null, status: 'modified', baseType: 'blob', headType: 'blob' }], truncated: false }; }
  async mergeBase(_repository: string, base: string) { return base; }
  async reviews() { return []; }
  async repository(fullName: string) { this.calls.push(`installation ${fullName}`); return this.installed.get(fullName.toLowerCase()) ?? null; }
  readonly targets: ReviewTargetReader = {
    repository: name => this.repository(name),
    pullRequest: async (target, number) => { this.calls.push(`target-pull ${target.fullName}#${number}`); return this.pullOf(target.fullName, number); },
    mergeBase: async (_target, base) => base,
  };
  transport: GitHubTransport = async request => { this.writes.push(structuredClone(request)); return { id: 9000 + this.writes.length }; };
}

let database: Awaited<ReturnType<typeof localDatabase>>;
before(async () => { database = await localDatabase(); });
beforeEach(async () => {
  await database.pg.exec(`TRUNCATE events,conversations,jobs,results,outbox,controls,audit,denied_actors,codex_sessions,codex_questions,proposals,
    github_deliveries,pr_reviews,review_deliveries,model_limit_state RESTART IDENTITY CASCADE`);
  await database.pg.exec(`UPDATE execution_lanes SET closed_reason=NULL,closed_at=NULL`);
});
after(async () => { await database.pg.close(); });

let seq = 300;
const message = () => `1000000000003${String(++seq).padStart(5, '0')}`;
const body = (content: string) => content.split('\n-# ref:')[0]!;
async function wired(options: { colleague?: boolean; bind?: boolean } = {}) {
  const h = await harness(database.db, options);
  h.f.policy.review = structuredClone(POLICY);
  const gh = new FakeGitHub();
  gh.pulls.set(`${LISTED.fullName}#7`, pull(LISTED));
  const source = new ReviewPolicySource(h.f.gate);
  const queue = new ReviewQueue(h.f.store, gh);
  if (options.bind !== false) bindReviewRequests(h.f.store, new ReviewRequests(h.f.store, source, queue, gh, gh.targets));
  const archives = new Map([[BASE, tarGz({ 'src/app.ts': 'export const average = (total: number) => total;\n' })],
    [HEAD, tarGz({ 'src/app.ts': 'export const average = (total: number, count: number) =>\n  total / count;\n' })]]);
  const fetcher: ArchiveFetcher = async url => {
    const archive = archives.get(url.split('/').at(-1)!);
    if (!archive) throw new Error('fixture_archive_missing');
    return archive;
  };
  const model: ReviewerModel = async () => ({ status: 'succeeded', output: structuredClone(OUTPUT) });
  const runtime = new ReviewRuntime(h.f.store, source, queue, gh, new ReviewWorker(h.f.verifier, fetcher, model, 50), h.f.signer, 5);
  const publisher = new ReviewPublisher(h.f.store, source, gh, new RestrictedGitHub(gh.transport), queue, 5);
  return { h, gh, runtime, publisher,
    // owner 말 한 통과 대화 차례 한 번. 모델 답은 리뷰 요청 제안 하나를 낸다.
    ask: async (text: string, target: string | null) => {
      h.reply({ action: 'review_request', target, content: null }, '그 PR 리뷰해 볼게요.');
      await h.say(message(), text);
      await h.turn();
    },
    reviews: async () => (await database.db.query<{ job_id: string; state: string; repo_full_name: string; trigger: string }>(
      'SELECT p.job_id,j.state,p.repo_full_name,p.trigger FROM pr_reviews p JOIN jobs j ON j.id=p.job_id ORDER BY p.created_at')).rows,
    posted: () => h.f.rest.messages.map(m => body(m.body.content)),
  };
}
const lastPosted = (w: { posted(): string[] }) => w.posted().at(-1);
const noButtons = (h: Harness) => assert.equal(h.buttons().posted.length, 0, '리뷰 요청에는 확인 버튼이 없다');

test('C30 정책 목록의 조직 저장소 PR 리뷰 부탁은 확인 버튼 없이 바로 리뷰 작업을 만들고 "리뷰 시작했어요"를 단다', async () => {
  const w = await wired();
  await w.ask(`이 PR 리뷰해 줘 https://github.com/${LISTED.fullName}/pull/7`, `${LISTED.fullName}#7`);
  noButtons(w.h);
  const reviews = await w.reviews();
  assert.equal(reviews.length, 1);
  assert.deepEqual([reviews[0]!.repo_full_name, reviews[0]!.state, reviews[0]!.trigger], [LISTED.fullName, 'queued', 'comment']);
  assert.equal(lastPosted(w), REVIEW_REQUEST_TEXT.started(LISTED.fullName, 7));
  assert.equal(await w.runtime.tick(), true);
  await w.publisher.deliver();
  assert.equal(w.gh.writes.length, 1);
  assert.equal(w.gh.writes[0]!.body.event, 'COMMENT');
  assert.equal(w.gh.writes[0]!.path, `/repos/${LISTED.fullName}/pulls/7/reviews`);
});

test('C30 정책 목록 밖이지만 리뷰 App이 설치된 조직 저장소 PR도 그 작업 하나로 리뷰하고 COMMENT를 게시한다(짧은 꼴 owner/repo#번호)', async () => {
  const w = await wired();
  w.gh.installed.set(OUTSIDE.fullName, OUTSIDE);
  w.gh.pulls.set(`${OUTSIDE.fullName}#12`, pull(OUTSIDE, { number: 12 }));
  await w.ask(`${OUTSIDE.fullName}#12 리뷰 부탁해요`, `${OUTSIDE.fullName}#12`);
  noButtons(w.h);
  assert.equal(lastPosted(w), REVIEW_REQUEST_TEXT.started(OUTSIDE.fullName, 12));
  assert.deepEqual((await w.reviews()).map(r => [r.repo_full_name, r.state]), [[OUTSIDE.fullName, 'queued']]);
  assert.equal(await w.runtime.tick(), true);
  assert.deepEqual((await w.reviews()).map(r => r.state), ['succeeded']);
  await w.publisher.deliver();
  assert.equal(w.gh.writes.length, 1);
  assert.deepEqual([w.gh.writes[0]!.path, w.gh.writes[0]!.body.event, w.gh.writes[0]!.body.commit_id],
    [`/repos/${OUTSIDE.fullName}/pulls/12/reviews`, 'COMMENT', HEAD]);
  // 정책 목록은 그대로다(자동 리뷰 대상을 넓히지 않는다).
  assert.deepEqual((w.h.f.policy.review as ReviewPolicy).repositories, [LISTED]);
});
