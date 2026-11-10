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
const OUTSIDE: ReviewTarget = { id: 302, fullName: 'ukyi-app/other-repo', installationId: 701, visibility: 'public' };
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
  // PR 조회 중에 일어나는 일(같은 대화의 새 말 등). 한 번만 부른다.
  duringPull?: () => Promise<void>;
  async pullRequest(repository: string, number: number) {
    this.calls.push(`pull ${repository}#${number}`);
    const during = this.duringPull; this.duringPull = undefined;
    await during?.();
    return this.pullOf(repository, number);
  }
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

test('C30 리뷰 App이 없는 조직 저장소와 조직 밖 PR은 못 한다고 답하고 리뷰 작업을 만들지 않는다. 조직 밖은 GitHub에 묻지 않는다', async () => {
  const w = await wired();
  await w.ask('https://github.com/ukyi-app/no-app-repo/pull/3 리뷰해 줘', 'ukyi-app/no-app-repo#3');
  assert.equal(lastPosted(w), REVIEW_REQUEST_TEXT.refused.not_installed);
  assert.deepEqual(w.gh.calls, ['installation ukyi-app/no-app-repo']);
  await w.ask('https://github.com/someone-else/tool/pull/4 리뷰해 줘', 'someone-else/tool#4');
  assert.equal(lastPosted(w), REVIEW_REQUEST_TEXT.refused.outside_organization);
  assert.deepEqual(w.gh.calls, ['installation ukyi-app/no-app-repo'], '조직 밖 PR은 설치·PR 조회를 하지 않는다');
  assert.deepEqual(await w.reviews(), []);
  noButtons(w.h);
});

test('C30 정책 목록 밖 비공개 저장소 PR은 작업자가 압축본을 받을 수 없어 거절하고 리뷰 작업을 만들지 않는다. 목록의 비공개 저장소는 그대로 받는다', async () => {
  const w = await wired();
  const hidden: ReviewTarget = { ...OUTSIDE, fullName: 'ukyi-app/hidden-repo', visibility: 'private' };
  w.gh.installed.set(hidden.fullName, hidden);
  w.gh.pulls.set(`${hidden.fullName}#12`, pull(hidden, { number: 12 }));
  await w.ask(`https://github.com/${hidden.fullName}/pull/12 리뷰해 줘`, `${hidden.fullName}#12`);
  assert.equal(lastPosted(w), REVIEW_REQUEST_TEXT.refused.not_public);
  assert.deepEqual(w.gh.calls, [`installation ${hidden.fullName}`], '거절이 정해지면 PR을 읽지 않는다');
  assert.deepEqual(await w.reviews(), []);
  noButtons(w.h);
  // 정책 목록 저장소는 visibility와 상관없이 지금처럼 접수한다.
  (w.h.f.policy.review as ReviewPolicy).repositories = [{ ...LISTED, visibility: 'private' }];
  await w.ask(`이 PR 리뷰해 줘 https://github.com/${LISTED.fullName}/pull/7`, `${LISTED.fullName}#7`);
  assert.equal(lastPosted(w), REVIEW_REQUEST_TEXT.started(LISTED.fullName, 7));
  assert.deepEqual((await w.reviews()).map(r => r.repo_full_name), [LISTED.fullName]);
});

test('C30 owner 원문에 없는 PR을 모델이 대상으로 고르면(맥락 자료가 고른 대상) 리뷰하지 않고 이유를 답한다', async () => {
  const w = await wired();
  w.gh.installed.set(OUTSIDE.fullName, OUTSIDE);
  w.gh.pulls.set(`${OUTSIDE.fullName}#12`, pull(OUTSIDE, { number: 12 }));
  // 원문에는 다른 PR 링크가 있다. 대상은 원문 밖이다.
  await w.ask(`이 PR 리뷰해 줘 https://github.com/${LISTED.fullName}/pull/7`, `${OUTSIDE.fullName}#12`);
  assert.equal(lastPosted(w), REVIEW_REQUEST_TEXT.notInText);
  // 원문에 PR이 없고 "그거 리뷰해 줘"만 있다.
  await w.ask('아까 그거 리뷰해 줘', `${LISTED.fullName}#7`);
  assert.equal(lastPosted(w), REVIEW_REQUEST_TEXT.notInText);
  assert.deepEqual(await w.reviews(), []);
  assert.deepEqual(w.gh.calls, []);
});

test('C30 GitHub 조회 중에 owner가 같은 대화에서 새 말을 보내면(요청을 고치거나 거둠) 옛 요청의 리뷰 작업을 만들지 않고 답도 달지 않는다', async () => {
  const w = await wired();
  w.gh.duringPull = async () => { await w.h.say(message(), '아니 그 PR 말고 다른 거 볼게요'); };
  await w.ask(`이 PR 리뷰해 줘 https://github.com/${LISTED.fullName}/pull/7`, `${LISTED.fullName}#7`);
  assert.deepEqual(w.gh.calls, [`pull ${LISTED.fullName}#7`], 'GitHub 조회까지는 했다');
  assert.deepEqual(await w.reviews(), [], '옛 요청의 리뷰 작업이 없다');
  assert.ok(!w.posted().includes(REVIEW_REQUEST_TEXT.started(LISTED.fullName, 7)));
  const dropped = (await database.db.query<{ detail: unknown }>("SELECT detail FROM audit WHERE kind='proposal_dropped'")).rows
    .map(row => typeof row.detail === 'string' ? JSON.parse(row.detail) : row.detail);
  assert.deepEqual(dropped, [{ action: 'review_request', reason: 'superseded' }]);
});

test('C30 동료 기능 스위치가 꺼져 있으면 리뷰 요청 제안을 버리고 리뷰 작업이 생기지 않는다', async () => {
  const w = await wired({ colleague: false });
  await w.ask(`이 PR 리뷰해 줘 https://github.com/${LISTED.fullName}/pull/7`, `${LISTED.fullName}#7`);
  assert.deepEqual(await w.reviews(), []);
  assert.deepEqual(w.gh.calls, []);
  assert.ok(!w.posted().includes(REVIEW_REQUEST_TEXT.started(LISTED.fullName, 7)));
});

test('C30 리뷰 경로가 없는 게시 서버(묶인 리뷰 요청 없음)에서는 제안을 연결 안 됨으로 버린다', async () => {
  const w = await wired({ bind: false });
  await w.ask(`이 PR 리뷰해 줘 https://github.com/${LISTED.fullName}/pull/7`, `${LISTED.fullName}#7`);
  assert.deepEqual(await w.reviews(), []);
  const dropped = (await database.db.query<{ detail: unknown }>("SELECT detail FROM audit WHERE kind='proposal_dropped'")).rows
    .map(row => typeof row.detail === 'string' ? JSON.parse(row.detail) : row.detail);
  assert.deepEqual(dropped, [{ action: 'review_request', reason: 'not_connected' }]);
});

test('C30 fork PR·작성자 조건 밖·닫힌 PR은 자동 리뷰와 같은 판단으로 거절하고, draft는 명시 요청이라 리뷰한다', async () => {
  const w = await wired();
  const fork = { id: 999, full_name: 'someone/fork' };
  const cases: [Record<string, unknown>, string][] = [
    [{ head: { sha: HEAD, ref: 'f', repo: fork } }, REVIEW_REQUEST_TEXT.refused.fork],
    [{ head: { sha: HEAD, ref: 'f', repo: null } }, REVIEW_REQUEST_TEXT.refused.fork],
    [{ author_association: 'CONTRIBUTOR' }, REVIEW_REQUEST_TEXT.refused.author],
    [{ user: { id: 77, login: 'fixture-bot[bot]', type: 'Bot' }, author_association: 'NONE' }, REVIEW_REQUEST_TEXT.refused.author],
    [{ state: 'closed' }, REVIEW_REQUEST_TEXT.refused.closed],
    [{ state: 'closed', merged: true }, REVIEW_REQUEST_TEXT.refused.closed],
  ];
  for (const [override, expected] of cases) {
    w.gh.pulls.set(`${LISTED.fullName}#7`, pull(LISTED, override));
    await w.ask(`https://github.com/${LISTED.fullName}/pull/7 리뷰해 줘`, `${LISTED.fullName}#7`);
    assert.equal(lastPosted(w), expected, JSON.stringify(override));
  }
  assert.deepEqual(await w.reviews(), []);
  w.gh.pulls.set(`${LISTED.fullName}#7`, pull(LISTED, { draft: true }));
  await w.ask(`https://github.com/${LISTED.fullName}/pull/7 리뷰해 줘`, `https://github.com/${LISTED.fullName}/pull/7`);
  assert.equal(lastPosted(w), REVIEW_REQUEST_TEXT.started(LISTED.fullName, 7));
  // 같은 커밋으로 다시 부탁하면 새 작업을 만들지 않는다.
  await w.ask(`https://github.com/${LISTED.fullName}/pull/7 리뷰해 줘`, `${LISTED.fullName}#7`);
  assert.equal(lastPosted(w), REVIEW_REQUEST_TEXT.already(LISTED.fullName, 7));
  assert.equal((await w.reviews()).length, 1);
});

test('C30 목록 밖 세대의 대상 기록이 그 행의 설치·저장소와 다르거나 조직 밖이면 실행하지 않고, 게시 직전에도 막는다', async () => {
  for (const tamper of [{ installationId: 999 }, { fullName: 'someone/other-repo' }]) {
    await database.pg.exec('TRUNCATE jobs,events,pr_reviews,review_deliveries,outbox,results,conversations,proposals,audit RESTART IDENTITY CASCADE');
    const w = await wired();
    w.gh.installed.set(OUTSIDE.fullName, OUTSIDE);
    w.gh.pulls.set(`${OUTSIDE.fullName}#12`, pull(OUTSIDE, { number: 12 }));
    await w.ask(`${OUTSIDE.fullName}#12 리뷰 부탁해요`, `${OUTSIDE.fullName}#12`);
    await database.db.query('UPDATE pr_reviews SET request_target=$1', [JSON.stringify({ ...OUTSIDE, ...tamper })]);
    assert.equal(await w.runtime.tick(), true);
    assert.deepEqual((await w.reviews()).map(r => r.state), ['cancelled'], JSON.stringify(tamper));
  }
  // 실행이 끝난 뒤 게시 직전에 기록이 어긋나도 보내지 않는다.
  await database.pg.exec('TRUNCATE jobs,events,pr_reviews,review_deliveries,outbox,results,conversations,proposals,audit RESTART IDENTITY CASCADE');
  const w = await wired();
  w.gh.installed.set(OUTSIDE.fullName, OUTSIDE);
  w.gh.pulls.set(`${OUTSIDE.fullName}#12`, pull(OUTSIDE, { number: 12 }));
  await w.ask(`${OUTSIDE.fullName}#12 리뷰 부탁해요`, `${OUTSIDE.fullName}#12`);
  assert.equal(await w.runtime.tick(), true);
  await database.db.query('UPDATE pr_reviews SET request_target=NULL');
  await w.publisher.deliver();
  assert.equal(w.gh.writes.length, 0);
  const delivery = (await database.db.query<{ state: string; reason: string }>('SELECT state,reason FROM review_deliveries')).rows;
  assert.deepEqual(delivery, [{ state: 'blocked', reason: 'authorization_revoked' }]);
});

test('C30 목록 밖 저장소의 리뷰 요청 세대는 실행 전 head가 바뀌면 닫기만 하고 새 세대를 자동으로 만들지 않는다', async () => {
  const w = await wired();
  w.gh.installed.set(OUTSIDE.fullName, OUTSIDE);
  w.gh.pulls.set(`${OUTSIDE.fullName}#12`, pull(OUTSIDE, { number: 12 }));
  await w.ask(`${OUTSIDE.fullName}#12 리뷰 부탁해요`, `${OUTSIDE.fullName}#12`);
  w.gh.pulls.set(`${OUTSIDE.fullName}#12`, pull(OUTSIDE, { number: 12, head: { sha: 'c'.repeat(40), ref: 'feature', repo: { id: OUTSIDE.id, full_name: OUTSIDE.fullName } },
    updated_at: '2026-11-10T01:00:00Z' }));
  assert.equal(await w.runtime.tick(), true);
  assert.deepEqual((await w.reviews()).map(r => r.state), ['superseded']);
  assert.equal(w.gh.writes.length, 0);
});
