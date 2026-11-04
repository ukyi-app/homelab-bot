import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createVerify, generateKeyPairSync } from 'node:crypto';
import { inspect } from 'node:util';
import { ConfigError, REVIEW_APP_KEYS, loadPublisherConfig } from '../src/config.js';
import { Denied, PolicyUnavailable } from '../src/contracts.js';
import { GitHubAppAuth, GitHubApi, GitHubTokenError, REFRESH_MARGIN_MS, RESPONSE_LIMIT_BYTES, appJwt } from '../src/github-app.js';
import type { BoundRepository } from '../src/github-app.js';
import { MAX_CHANGES, diffTrees, githubReviewIO, policyRepositories } from '../src/github-review-io.js';
import { GitHubError, ReviewDisabled, RestrictedGitHub } from '../src/review.js';
import type { GitHubWrite, ReviewContext } from '../src/review.js';
import { ReviewTaskSchema } from '../src/review-input.js';

// 네트워크를 쓰지 않는다. 키·토큰·ID는 모두 시험용 가짜다.
const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
const APP = { appId: '12345', privateKey };
const REPO: BoundRepository = { id: 77, fullName: 'fixture-org/fixture-repo', installationId: 900 };
const OTHER: BoundRepository = { id: 78, fullName: 'fixture-org/other-repo', installationId: 900 };
const TOKEN = 'ghs_fixtureInstallationTokenValue0001';
const NOW = 1_800_000_000_000;
const HOUR = 3_600_000;
const sha = (seed: string) => seed.repeat(40).slice(0, 40);
const BASE = sha('a'), HEAD = sha('b'), BASE_TREE = sha('c'), HEAD_TREE = sha('d');

const json = (value: unknown, status = 200, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(value), { status, headers: { 'content-type': 'application/json', ...headers } });
interface Sent { method: string; path: string; authorization: string; body: unknown; init: RequestInit }
type Route = (sent: Sent) => Response | Promise<Response>;
const expiry = (now: number, lifetime = HOUR) => new Date(now + lifetime).toISOString();
const issued = (repo: BoundRepository, permissions: Record<string, string>, now: number, token = TOKEN) => json({ token, expires_at: expiry(now),
  permissions, repository_selection: 'selected', repositories: [{ id: repo.id, full_name: repo.fullName }] }, 201);

// GitHub 흉내. 토큰 발급은 요청받은 저장소·권한을 그대로 돌려주고, 나머지는 routes로 넘긴다.
class Fake {
  sent: Sent[] = [];
  clock = NOW;
  issues = 0;
  token: Route | undefined;
  constructor(private readonly routes: Route = () => { throw new Error('unexpected_request'); }) {}
  readonly send: typeof fetch = async (input, init = {}) => {
    const url = new URL(String(input));
    assert.equal(url.origin, 'https://api.github.com');
    const headers = new Headers(init.headers);
    const sent: Sent = { method: init.method ?? 'GET', path: url.pathname + url.search, authorization: headers.get('authorization') ?? '',
      body: typeof init.body === 'string' ? JSON.parse(init.body) : undefined, init };
    this.sent.push(sent);
    if (/^\/app\/installations\/\d+\/access_tokens$/.test(url.pathname)) {
      this.issues++;
      if (this.token) return this.token(sent);
      const request = sent.body as { repository_ids: number[]; permissions: Record<string, string> };
      const repo = [REPO, OTHER].find(r => r.id === request.repository_ids[0])!;
      return issued(repo, request.permissions, this.clock, `${TOKEN}-${this.issues}`);
    }
    return this.routes(sent);
  };
  get requests() { return this.sent.filter(s => !s.path.startsWith('/app/')); }
  io(repositories = async (name: string) => {
    const repo = [REPO, OTHER].find(r => r.fullName === name);
    if (!repo) throw new Denied();
    return repo;
  }) { return githubReviewIO({ app: APP, repositories, send: this.send, now: () => this.clock }); }
  auth() { return new GitHubAppAuth(APP, new GitHubApi(this.send, () => this.clock), () => this.clock); }
}
const rejectsWith = async (work: Promise<unknown>, status: number) => {
  await assert.rejects(work, (error: unknown) => {
    assert.ok(error instanceof GitHubError, String(error));
    assert.equal(error.status, status);
    return true;
  });
};
const decode = (part: string) => JSON.parse(Buffer.from(part, 'base64url').toString('utf8')) as Record<string, unknown>;

test('App JWT: RS256 서명, iat는 60초 앞, exp는 10분 안, iss는 App ID', () => {
  const jwt = appJwt(APP, NOW);
  const [header, payload, signature] = jwt.split('.') as [string, string, string];
  assert.deepEqual(decode(header), { alg: 'RS256', typ: 'JWT' });
  const claims = decode(payload);
  const seconds = Math.floor(NOW / 1000);
  assert.equal(claims.iat, seconds - 60);
  assert.equal(claims.iss, '12345');
  assert.ok((claims.exp as number) > seconds);
  assert.ok((claims.exp as number) - seconds <= 600);
  assert.ok((claims.exp as number) - (claims.iat as number) <= 600);
  assert.ok(createVerify('RSA-SHA256').update(`${header}.${payload}`).verify(publicKey, signature, 'base64url'));
});

test('토큰 발급 요청: 설치·저장소 하나·최소 권한을 넣고, 읽기와 쓰기 권한을 나눈다', async () => {
  const fake = new Fake(() => json({ id: 1 }));
  const auth = fake.auth();
  await auth.withToken(REPO, 'read', async () => 'ok');
  await auth.withToken(REPO, 'write', async () => 'ok');
  const [read, write] = fake.sent as [Sent, Sent];
  assert.equal(read.method, 'POST');
  assert.equal(read.path, '/app/installations/900/access_tokens');
  assert.deepEqual(read.body, { repository_ids: [77], permissions: { contents: 'read', pull_requests: 'read' } });
  assert.deepEqual(write.body, { repository_ids: [77], permissions: { pull_requests: 'write' } });
  // 설치 토큰이 아니라 App JWT로 발급한다.
  const jwt = read.authorization.replace(/^Bearer /, '');
  assert.equal(decode(jwt.split('.')[1]!).iss, '12345');
  const headers = new Headers(read.init.headers);
  assert.equal(headers.get('accept'), 'application/vnd.github+json');
  assert.ok(headers.get('x-github-api-version'));
  assert.ok(headers.get('user-agent'));
  assert.equal(read.init.redirect, 'manual');
  assert.ok(read.init.signal instanceof AbortSignal);
});

test('토큰 응답 대조: 저장소·권한·만료가 요청과 다르면 쓰지 않는다', async () => {
  const good = { token: TOKEN, expires_at: expiry(NOW), permissions: { contents: 'read', pull_requests: 'read' }, repositories: [{ id: 77, full_name: REPO.fullName }] };
  const cases: [string, unknown, string][] = [
    ['다른 저장소', { ...good, repositories: [{ id: 78, full_name: REPO.fullName }] }, 'token_repository_mismatch'],
    ['다른 이름', { ...good, repositories: [{ id: 77, full_name: OTHER.fullName }] }, 'token_repository_mismatch'],
    ['저장소 둘', { ...good, repositories: [{ id: 77, full_name: REPO.fullName }, { id: 78, full_name: OTHER.fullName }] }, 'token_repository_mismatch'],
    ['저장소 목록 없음(설치 전체 토큰)', { token: TOKEN, expires_at: good.expires_at, permissions: good.permissions }, 'token_repository_mismatch'],
    ['빈 저장소 목록', { ...good, repositories: [] }, 'token_repository_mismatch'],
    ['권한 더 넓음', { ...good, permissions: { ...good.permissions, contents: 'write' } }, 'token_permission_mismatch'],
    ['권한 추가', { ...good, permissions: { ...good.permissions, administration: 'read' } }, 'token_permission_mismatch'],
    ['권한 누락', { ...good, permissions: { contents: 'read' } }, 'token_permission_mismatch'],
    ['metadata 쓰기', { ...good, permissions: { ...good.permissions, metadata: 'write' } }, 'token_permission_mismatch'],
    ['이미 만료', { ...good, expires_at: expiry(NOW, -1000) }, 'token_expiry_invalid'],
    ['만료가 너무 멂', { ...good, expires_at: expiry(NOW, 2 * HOUR) }, 'token_expiry_invalid'],
    ['만료 해석 불가', { ...good, expires_at: 'soon' }, 'token_response_invalid'],
    ['토큰 공백', { ...good, token: 'ghs bad' }, 'token_response_invalid'],
    ['토큰 없음', { ...good, token: undefined }, 'token_response_invalid'],
  ];
  for (const [name, body, reason] of cases) {
    const fake = new Fake(() => json({}));
    fake.token = () => json(body, 201);
    let used = false;
    await assert.rejects(fake.auth().withToken(REPO, 'read', async () => { used = true; }), (error: unknown) => {
      assert.ok(error instanceof GitHubTokenError, name);
      assert.equal(error.message, reason, name);
      return true;
    }, name);
    assert.equal(used, false, name);
  }
  // GitHub이 암묵으로 붙이는 metadata:read 하나만 추가로 받아들인다.
  const fake = new Fake();
  fake.token = () => json({ ...good, permissions: { ...good.permissions, metadata: 'read' } }, 201);
  assert.equal(await fake.auth().withToken(REPO, 'read', async token => token), TOKEN);
});

test('토큰 캐시: 만료 5분 전까지만 쓰고, 저장소·권한별로 나누고, 동시 발급은 하나로 묶는다', async () => {
  const fake = new Fake();
  const auth = fake.auth();
  const take = (repo = REPO, scope: 'read' | 'write' = 'read') => auth.withToken(repo, scope, async token => token);
  assert.equal(REFRESH_MARGIN_MS, 300_000);
  const first = await take();
  assert.equal(await take(), first);
  assert.equal(fake.issues, 1);
  assert.notEqual(await take(REPO, 'write'), first);
  assert.notEqual(await take(OTHER), first);
  assert.equal(fake.issues, 3);
  fake.clock = NOW + HOUR - REFRESH_MARGIN_MS - 1;
  assert.equal(await take(), first);
  assert.equal(fake.issues, 3);
  fake.clock = NOW + HOUR - REFRESH_MARGIN_MS;
  assert.notEqual(await take(), first);
  assert.equal(fake.issues, 4);

  const concurrent = new Fake();
  const shared = concurrent.auth();
  const tokens = await Promise.all([1, 2, 3].map(() => shared.withToken(REPO, 'read', async token => token)));
  assert.equal(concurrent.issues, 1);
  assert.equal(new Set(tokens).size, 1);

  // 실패한 발급은 캐시에 남지 않는다.
  const flaky = new Fake();
  let failures = 1;
  flaky.token = sent => failures-- > 0 ? json({}, 500) : issued(REPO, (sent.body as { permissions: Record<string, string> }).permissions, NOW);
  const auth2 = flaky.auth();
  await rejectsWith(auth2.withToken(REPO, 'read', async () => 'x'), 500);
  assert.equal(await auth2.withToken(REPO, 'read', async token => token), TOKEN);
});

test('토큰 401: 캐시 토큰만 한 번 새로 발급해 다시 보낸다. 새 토큰의 401은 다시 보내지 않고 캐시도 버린다', async () => {
  const fake = new Fake();
  const auth = fake.auth();
  await auth.withToken(REPO, 'read', async () => 'warm');
  const seen: string[] = [];
  const result = await auth.withToken(REPO, 'read', async token => {
    seen.push(token);
    if (seen.length === 1) throw new GitHubError(401);
    return 'second';
  });
  assert.equal(result, 'second');
  assert.equal(seen.length, 2);
  assert.notEqual(seen[0], seen[1]);
  assert.equal(fake.issues, 2);

  const fresh = new Fake();
  const auth2 = fresh.auth();
  let calls = 0;
  await rejectsWith(auth2.withToken(REPO, 'read', async () => { calls++; throw new GitHubError(401); }), 401);
  assert.equal(calls, 1);
  await auth2.withToken(REPO, 'read', async () => 'next');
  assert.equal(fresh.issues, 2);
});

test('GitHubReader 조회: 페이지 크기 100, 고정 경로, 읽기 토큰, 계약 밖 응답 거부', async () => {
  const fake = new Fake(sent => {
    if (sent.path === `/repos/${REPO.fullName}/pulls/5`) return json({ number: 5 });
    if (sent.path.startsWith(`/repos/${REPO.fullName}/pulls?`)) return json([{ number: 1 }]);
    if (sent.path.startsWith(`/repos/${REPO.fullName}/pulls/5/reviews?`)) return json([{ id: 1 }]);
    return json({ not: 'array' });
  });
  const { reader } = fake.io();
  assert.deepEqual(await reader.pullRequest(REPO.fullName, 5), { number: 5 });
  assert.deepEqual(await reader.openPullRequests(REPO.fullName, 3), [{ number: 1 }]);
  assert.deepEqual(await reader.reviews(REPO.fullName, 5, 2), [{ id: 1 }]);
  assert.deepEqual(fake.requests.map(s => [s.method, s.path]), [
    ['GET', `/repos/${REPO.fullName}/pulls/5`],
    ['GET', `/repos/${REPO.fullName}/pulls?state=open&sort=updated&direction=desc&per_page=100&page=3`],
    ['GET', `/repos/${REPO.fullName}/pulls/5/reviews?per_page=100&page=2`],
  ]);
  assert.equal(fake.issues, 1);
  assert.ok(fake.requests.every(s => s.authorization === `Bearer ${TOKEN}-1`));
  const wrong = new Fake(() => json({ not: 'array' }));
  await assert.rejects(wrong.io().reader.openPullRequests(REPO.fullName, 1), /github_invalid_response/);
  await assert.rejects(wrong.io().reader.reviews(REPO.fullName, 5, 1), /github_invalid_response/);
});

test('GitHubReader 오류: 허용 저장소 밖과 잘못된 번호·SHA는 보내지 않는다', async () => {
  const fake = new Fake(() => json({}));
  const { reader } = fake.io();
  await assert.rejects(reader.pullRequest('fixture-org/not-allowed', 1), Denied);
  await assert.rejects(reader.pullRequest(REPO.fullName, 1.5), Denied);
  await assert.rejects(reader.pullRequest(REPO.fullName, 0), Denied);
  await assert.rejects(reader.openPullRequests(REPO.fullName, 0), Denied);
  await assert.rejects(reader.reviews(REPO.fullName, 1, -1), Denied);
  await assert.rejects(reader.compare(REPO.fullName, 'main', HEAD), Denied);
  await assert.rejects(reader.mergeBase(REPO.fullName, BASE, `${HEAD}/../x`), Denied);
  assert.deepEqual(fake.requests, []);
});

test('mergeBase: compare API의 merge_base_commit을 고정 SHA 쌍으로 얻고, 다른 base 응답은 거부', async () => {
  const merge = sha('e');
  let body: unknown = { base_commit: { sha: BASE }, merge_base_commit: { sha: merge } };
  const fake = new Fake(() => json(body));
  const { reader } = fake.io();
  assert.equal(await reader.mergeBase(REPO.fullName, BASE, HEAD), merge);
  assert.equal(fake.requests[0]!.path, `/repos/${REPO.fullName}/compare/${BASE}...${HEAD}?per_page=1`);
  body = { base_commit: { sha: sha('f') }, merge_base_commit: { sha: merge } };
  await assert.rejects(reader.mergeBase(REPO.fullName, BASE, HEAD), /github_invalid_response/);
  body = { base_commit: { sha: BASE }, merge_base_commit: { sha: 'short' } };
  await assert.rejects(reader.mergeBase(REPO.fullName, BASE, HEAD), /github_invalid_response/);
  body = { base_commit: { sha: BASE } };
  await assert.rejects(reader.mergeBase(REPO.fullName, BASE, HEAD), /github_invalid_response/);
});

type Item = { path: string; mode: string; type: 'blob' | 'commit' | 'tree'; sha: string };
const blob = (path: string, seed: string, mode = '100644'): Item => ({ path, mode, type: 'blob', sha: sha(seed) });
const gitlink = (path: string, seed: string): Item => ({ path, mode: '160000', type: 'commit', sha: sha(seed) });
const dir = (path: string, seed = '9'): Item => ({ path, mode: '040000', type: 'tree', sha: sha(seed) });
const tree = (items: Item[], truncated = false, id = BASE_TREE) => ({ sha: id, tree: items, truncated });
const changesFixture = (baseItems: Item[], headItems: Item[], baseTruncated = false, headTruncated = false) => new Fake(sent => {
  if (sent.path === `/repos/${REPO.fullName}/git/commits/${BASE}`) return json({ sha: BASE, tree: { sha: BASE_TREE } });
  if (sent.path === `/repos/${REPO.fullName}/git/commits/${HEAD}`) return json({ sha: HEAD, tree: { sha: HEAD_TREE } });
  if (sent.path === `/repos/${REPO.fullName}/git/trees/${BASE_TREE}?recursive=1`) return json(tree(baseItems, baseTruncated, BASE_TREE));
  if (sent.path === `/repos/${REPO.fullName}/git/trees/${HEAD_TREE}?recursive=1`) return json(tree(headItems, headTruncated, HEAD_TREE));
  return json({}, 404);
});
const compareResult = (value: unknown) => value as { files: Record<string, unknown>[]; truncated: boolean };

test('compare: tree 비교로 추가·삭제·이름 변경·mode 변경·gitlink·종류 변경을 정확히 열거한다', async () => {
  const baseItems = [dir('src'), blob('src/same.ts', '1'), blob('src/edit.ts', '2'), blob('src/gone.ts', '3'), blob('src/old-name.ts', '4'),
    blob('bin/run.sh', '5'), gitlink('vendor/sub', '6'), gitlink('vendor/dropped', '7'), blob('link', '8', '120000'), blob('swap', '1'), blob('thing', '2')];
  const headItems = [dir('src', '0'), blob('src/same.ts', '1'), blob('src/edit.ts', 'a'), blob('src/new-name.ts', '4'), blob('src/added.ts', 'b'),
    blob('bin/run.sh', '5', '100755'), gitlink('vendor/sub', 'c'), gitlink('vendor/fresh', 'd'), blob('link', '8'), gitlink('swap', 'e'),
    dir('thing'), blob('thing/inner.ts', 'f')];
  const fake = changesFixture(baseItems, headItems);
  const result = compareResult(await fake.io().reader.compare(REPO.fullName, BASE, HEAD));
  assert.equal(result.truncated, false);
  const entry = (path: string, previousPath: string | null, status: string, baseType: string | null, headType: string | null,
    baseMode: string | null, headMode: string | null) => ({ path, previousPath, status, baseType, headType, baseMode, headMode });
  assert.deepEqual(result.files, [
    entry('bin/run.sh', null, 'modified', 'blob', 'blob', '100644', '100755'),
    entry('link', null, 'type_changed', 'blob', 'blob', '120000', '100644'),
    entry('src/added.ts', null, 'added', null, 'blob', null, '100644'),
    entry('src/edit.ts', null, 'modified', 'blob', 'blob', '100644', '100644'),
    entry('src/gone.ts', null, 'removed', 'blob', null, '100644', null),
    entry('src/new-name.ts', 'src/old-name.ts', 'renamed', 'blob', 'blob', '100644', '100644'),
    entry('swap', null, 'type_changed', 'blob', 'commit', '100644', '160000'),
    entry('thing', null, 'removed', 'blob', null, '100644', null),
    entry('thing/inner.ts', null, 'added', null, 'blob', null, '100644'),
    entry('vendor/dropped', null, 'removed', 'commit', null, '160000', null),
    entry('vendor/fresh', null, 'added', null, 'commit', null, '160000'),
    entry('vendor/sub', null, 'modified', 'commit', 'commit', '160000', '160000'),
  ]);
  // review.ts가 받는 계약 그대로다.
  assert.ok(ReviewTaskSchema.shape.changes.safeParse(result.files).success);
  // PR files나 compare 목록은 부르지 않는다.
  assert.ok(fake.requests.every(s => s.method === 'GET' && /\/git\/(commits|trees)\//.test(s.path)), JSON.stringify(fake.requests.map(s => s.path)));
});

test('diffTrees: 이름 변경은 같은 blob만 짝짓고 gitlink·링크 종류가 다르면 짝짓지 않는다', () => {
  const result = diffTrees(tree([blob('a', '1'), blob('b', '1'), gitlink('sub', '2'), blob('l', '3', '120000')]),
    tree([blob('c', '1'), blob('d', '1'), blob('e', '1'), gitlink('sub2', '2'), blob('m', '3')]));
  const view = result.files.map(f => [f.path, f.previousPath, f.status]);
  assert.deepEqual(view, [['c', 'a', 'renamed'], ['d', 'b', 'renamed'], ['e', null, 'added'], ['l', null, 'removed'], ['m', null, 'added'],
    ['sub', null, 'removed'], ['sub2', null, 'added']]);
  assert.equal(result.truncated, false);
});

test('diffTrees [PR #38 리뷰 P2]: 같은 내용의 파일 40,000개 이동도 선형 시간에 짝짓는다(이벤트 루프를 막지 않음)', () => {
  const count = 40_000;
  const before = Array.from({ length: count }, (_, i) => blob(`old/${String(i).padStart(5, '0')}`, 'e'));
  const after = Array.from({ length: count }, (_, i) => blob(`new/${String(i).padStart(5, '0')}`, 'e'));
  const started = performance.now();
  const result = diffTrees(tree(before), tree(after));
  const elapsed = performance.now() - started;
  // 배열 복사·shift()로 구현하면 이 크기에서 수십 초가 걸린다. 여유를 크게 두되 O(n²)는 걸러낸다.
  assert.ok(elapsed < 3000, `diffTrees ${Math.round(elapsed)}ms`);
  const renamed = result.files.filter(f => f.status === 'renamed');
  assert.equal(renamed.length, Math.min(count, MAX_CHANGES));
  assert.deepEqual([renamed[0]!.path, renamed[0]!.previousPath], ['new/00000', 'old/00000']);
  assert.equal(result.truncated, count > MAX_CHANGES);
});

test('compare: 같은 tree면 tree를 받지 않고 빈 목록', async () => {
  const fake = new Fake(sent => json({ sha: sent.path.endsWith(BASE) ? BASE : HEAD, tree: { sha: BASE_TREE } }));
  assert.deepEqual(await fake.io().reader.compare(REPO.fullName, BASE, HEAD), { files: [], truncated: false });
  assert.equal(fake.requests.length, 2);
});

test('compare truncated: 잘린 쪽에 없는 경로를 추가·삭제로 지어내지 않고 truncated로 낸다', async () => {
  const both = [blob('edit', '1')], baseOnly = blob('maybe-removed', '2'), headOnly = blob('maybe-added', '3');
  const headCut = compareResult(await changesFixture([...both, baseOnly], [blob('edit', '4'), headOnly], false, true).io().reader.compare(REPO.fullName, BASE, HEAD));
  assert.equal(headCut.truncated, true);
  assert.deepEqual(headCut.files.map(f => [f.path, f.status]), [['edit', 'modified'], ['maybe-added', 'added']]);
  const baseCut = compareResult(await changesFixture([...both, baseOnly], [blob('edit', '4'), headOnly], true, false).io().reader.compare(REPO.fullName, BASE, HEAD));
  assert.equal(baseCut.truncated, true);
  assert.deepEqual(baseCut.files.map(f => [f.path, f.status]), [['edit', 'modified'], ['maybe-removed', 'removed']]);
  const bothCut = compareResult(await changesFixture([...both, baseOnly], [blob('edit', '4'), headOnly], true, true).io().reader.compare(REPO.fullName, BASE, HEAD));
  assert.equal(bothCut.truncated, true);
  assert.deepEqual(bothCut.files.map(f => [f.path, f.status]), [['edit', 'modified']]);
});

test('compare 한도: 변경 5000개 초과와 계약 밖 긴 경로는 잘라 truncated로 낸다', () => {
  const many = Array.from({ length: MAX_CHANGES + 1 }, (_, i) => blob(`f/${String(i).padStart(5, '0')}`, '1'));
  const over = diffTrees(tree([]), tree(many.map((item, i) => ({ ...item, sha: i.toString(16).padStart(40, '0') }))));
  assert.equal(over.truncated, true);
  assert.equal(over.files.length, MAX_CHANGES);
  assert.ok(ReviewTaskSchema.shape.changes.safeParse(over.files).success);
  assert.ok(!ReviewTaskSchema.shape.changes.safeParse([...over.files, over.files[0]]).success, '시험 전제: 계약 상한과 같아야 한다');
  const exact = diffTrees(tree([]), tree(many.slice(0, MAX_CHANGES).map((item, i) => ({ ...item, sha: i.toString(16).padStart(40, '0') }))));
  assert.equal(exact.truncated, false);
  const long = diffTrees(tree([]), tree([blob('x'.repeat(4097), '1'), blob('ok', '2')]));
  assert.equal(long.truncated, true);
  assert.deepEqual(long.files.map(f => f.path), ['ok']);
  assert.ok(ReviewTaskSchema.shape.changes.safeParse(long.files).success);
});

test('compare 실패: 조회 오류는 그대로 올리고 PR files·compare 목록으로 덮지 않는다', async () => {
  const headTree = `/repos/${REPO.fullName}/git/trees/${HEAD_TREE}?recursive=1`;
  for (const [status, expected] of [[404, 404], [422, 422], [502, 502]] as const) {
    const base = changesFixture([], []);
    const fake = new Fake(sent => sent.path === headTree ? json({}, status) : base.send(`https://api.github.com${sent.path}`, sent.init));
    await rejectsWith(fake.io().reader.compare(REPO.fullName, BASE, HEAD), expected);
    assert.ok(fake.requests.every(s => !/\/pulls|\/compare/.test(s.path)));
  }
  // 다른 객체를 돌려주면 그 응답으로 비교하지 않는다.
  const commitMismatch = new Fake(() => json({ sha: sha('e'), tree: { sha: BASE_TREE } }));
  await assert.rejects(commitMismatch.io().reader.compare(REPO.fullName, BASE, HEAD), /github_invalid_response/);
  const treeMismatch = new Fake(sent => sent.path.includes('/git/commits/')
    ? json({ sha: sent.path.endsWith(BASE) ? BASE : HEAD, tree: { sha: sent.path.endsWith(BASE) ? BASE_TREE : HEAD_TREE } })
    : json(tree([], false, sha('e'))));
  await assert.rejects(treeMismatch.io().reader.compare(REPO.fullName, BASE, HEAD), /github_invalid_response/);
  const noFlag = new Fake(sent => sent.path.includes('/git/commits/')
    ? json({ sha: sent.path.endsWith(BASE) ? BASE : HEAD, tree: { sha: sent.path.endsWith(BASE) ? BASE_TREE : HEAD_TREE } })
    : json({ sha: sent.path.includes(BASE_TREE) ? BASE_TREE : HEAD_TREE, tree: [] }));
  await assert.rejects(noFlag.io().reader.compare(REPO.fullName, BASE, HEAD), /github_invalid_response/);
  const badMode = new Fake(sent => sent.path.includes('/git/commits/')
    ? json({ sha: sent.path.endsWith(BASE) ? BASE : HEAD, tree: { sha: sent.path.endsWith(BASE) ? BASE_TREE : HEAD_TREE } })
    : json(tree([{ path: 'a', mode: 'x', type: 'blob', sha: sha('1') }], false, sent.path.includes(BASE_TREE) ? BASE_TREE : HEAD_TREE)));
  await assert.rejects(badMode.io().reader.compare(REPO.fullName, BASE, HEAD), /github_invalid_response/);
});

test('오류 분류: 재시도 힌트, 2차 한도 403은 429로, 연결 실패는 503으로, redirect는 따라가지 않는다', async () => {
  const path = `/repos/${REPO.fullName}/pulls/5`;
  const failing = (response: () => Response | Promise<Response>) => new Fake(() => response()).io().reader.pullRequest(REPO.fullName, 5);
  const expect = async (work: Promise<unknown>, status: number, retryAfterMs: number) => {
    await assert.rejects(work, (error: unknown) => {
      assert.ok(error instanceof GitHubError);
      assert.deepEqual([error.status, error.retryAfterMs], [status, retryAfterMs]);
      return true;
    });
  };
  await expect(failing(() => json({}, 503, { 'retry-after': '7' })), 503, 7000);
  await expect(failing(() => json({}, 429, { 'retry-after': '30' })), 429, 30_000);
  await expect(failing(() => json({}, 429)), 429, 60_000);
  await expect(failing(() => json({}, 403, { 'retry-after': '11' })), 429, 11_000);
  await expect(failing(() => json({}, 403, { 'x-ratelimit-remaining': '0', 'x-ratelimit-reset': String(NOW / 1000 + 120) })), 429, 120_000);
  await expect(failing(() => json({}, 403, { 'x-ratelimit-remaining': '10' })), 403, 0);
  await expect(failing(() => json({}, 429, { 'retry-after': '999999' })), 429, HOUR);
  await expect(failing(() => { throw new TypeError('fetch failed'); }), 503, 0);
  const redirected = new Fake(() => new Response(null, { status: 301, headers: { location: 'https://evil.example/' } }));
  await expect(redirected.io().reader.pullRequest(REPO.fullName, 5), 301, 0);
  assert.deepEqual(redirected.requests.map(s => s.path), [path]);
  assert.equal(redirected.requests[0]!.init.redirect, 'manual');
});

test('응답 크기 상한: 선언·실제 크기 모두 넘으면 해석하지 않는다', async () => {
  const declared = new Fake(() => new Response('{}', { headers: { 'content-length': String(RESPONSE_LIMIT_BYTES + 1) } }));
  await assert.rejects(declared.io().reader.pullRequest(REPO.fullName, 5), /github_response_limit/);
  const streamed = new Fake(() => new Response(new ReadableStream({ start(controller) {
    controller.enqueue(new Uint8Array(RESPONSE_LIMIT_BYTES)); controller.enqueue(new Uint8Array(1)); controller.close();
  } })));
  await assert.rejects(streamed.io().reader.pullRequest(REPO.fullName, 5), /github_response_limit/);
  // 스트림이 끊기면 일시 장애다.
  const broken = new Fake(() => new Response(new ReadableStream({ start(controller) { controller.error(new Error('reset')); } })));
  await rejectsWith(broken.io().reader.pullRequest(REPO.fullName, 5), 503);
});

const write = (overrides: Partial<GitHubWrite> = {}, body: Record<string, unknown> = {}) => ({ method: 'POST',
  path: `/repos/${REPO.fullName}/pulls/5/reviews`, ...overrides,
  body: { commit_id: HEAD, event: 'COMMENT', body: '자동 참고 리뷰', comments: [{ path: 'a.ts', line: 3, side: 'RIGHT', body: '지적' }], ...body } }) as GitHubWrite;

test('GitHubTransport: COMMENT와 commit_id를 그대로 쓰기 토큰으로 게시하고 id를 돌려준다', async () => {
  const fake = new Fake(() => json({ id: 4242, state: 'COMMENTED' }, 200));
  const { transport } = fake.io();
  const github = new RestrictedGitHub(transport);
  const result = await github.createReview(write(), { repository: REPO.fullName, pr: 5, head: HEAD });
  assert.deepEqual(result, { id: 4242 });
  const [issue, post] = fake.sent as [Sent, Sent];
  assert.deepEqual(issue.body, { repository_ids: [77], permissions: { pull_requests: 'write' } });
  assert.equal(post.method, 'POST');
  assert.equal(post.path, `/repos/${REPO.fullName}/pulls/5/reviews`);
  assert.equal(post.authorization, `Bearer ${TOKEN}-1`);
  assert.deepEqual(post.body, write().body);
  assert.equal(new Headers(post.init.headers).get('content-type'), 'application/json');
});

test('GitHubTransport 금지 요청: 토큰 발급도 전송도 하기 전에 거부한다', async () => {
  const bad: [string, unknown][] = [
    ['APPROVE', write({}, { event: 'APPROVE' })],
    ['REQUEST_CHANGES', write({}, { event: 'REQUEST_CHANGES' })],
    ['event 없음(PENDING)', write({}, { event: undefined })],
    ['commit_id 없음', write({}, { commit_id: undefined })],
    ['commit_id SHA 아님', write({}, { commit_id: 'main' })],
    ['본문에 다른 필드', write({}, { merge_method: 'squash' })],
    ['PUT', { ...write(), method: 'PUT' }],
    ['PATCH', { ...write(), method: 'PATCH' }],
    ['DELETE', { ...write(), method: 'DELETE' }],
    ['GET', { ...write(), method: 'GET' }],
    ['merge 경로', write({ path: `/repos/${REPO.fullName}/pulls/5/merge` })],
    ['dismiss 경로', write({ path: `/repos/${REPO.fullName}/pulls/5/reviews/1/dismissals` })],
    ['PR 수정 경로', write({ path: `/repos/${REPO.fullName}/pulls/5` })],
    ['issue 댓글 경로', write({ path: `/repos/${REPO.fullName}/issues/5/comments` })],
    ['점 세그먼트 저장소', write({ path: '/repos/fixture-org/../pulls/5/reviews' })],
    ['점 세그먼트 소유자', write({ path: '/repos/../fixture-repo/pulls/5/reviews' })],
    ['다른 호스트 모양', write({ path: `//evil.example/repos/${REPO.fullName}/pulls/5/reviews` })],
    ['쿼리 붙임', write({ path: `/repos/${REPO.fullName}/pulls/5/reviews?x=1` })],
    ['본문 없음', { method: 'POST', path: `/repos/${REPO.fullName}/pulls/5/reviews` }],
  ];
  for (const [name, request] of bad) {
    const fake = new Fake(() => json({ id: 1 }));
    await assert.rejects(fake.io().transport(request as GitHubWrite), Denied, name);
    assert.deepEqual(fake.sent, [], name);
  }
  // 정책 밖 저장소는 모양 검사를 지나 정책 조회에서 막힌다. 보내지 않고 403(재시도 없음)으로 올린다.
  const outside = new Fake(() => json({ id: 1 }));
  await rejectsWith(outside.io().transport(write({ path: '/repos/fixture-org/not-allowed/pulls/5/reviews' }) as GitHubWrite), 403);
  assert.deepEqual(outside.sent, []);
  // RestrictedGitHub을 거치면 검토 SHA가 다른 요청도 막힌다.
  const fake = new Fake(() => json({ id: 1 }));
  await assert.rejects(new RestrictedGitHub(fake.io().transport).createReview(write(), { repository: REPO.fullName, pr: 5, head: BASE }), Denied);
  assert.deepEqual(fake.sent, []);
});

test('GitHubApi 허용 목록: 정해진 메서드·경로 밖은 인증 값이 있어도 보내지 않는다', async () => {
  let sends = 0;
  const api = new GitHubApi(async () => { sends++; return json({}); }, () => NOW);
  const repo = `/repos/${REPO.fullName}`;
  const forbidden: ['GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE', string][] = [
    ['PUT', `${repo}/pulls/5/merge`], ['POST', `${repo}/merges`], ['DELETE', `${repo}/pulls/5/reviews/1`], ['PATCH', `${repo}/pulls/5`],
    ['POST', `${repo}/pulls/5/reviews/1/events`], ['POST', `${repo}/issues/5/comments`], ['GET', `${repo}/pulls/5/files`], ['GET', `${repo}/contents/a`],
    ['POST', `${repo}/pulls`], ['GET', '/app/installations/900/access_tokens'], ['GET', '/installation/repositories'],
    ['GET', `${repo}/git/trees/main?recursive=1`], ['GET', `${repo}/compare/main...${HEAD}?per_page=1`], ['GET', `/repos/a/../pulls/5`],
    ['POST', `/repos/${REPO.fullName}/pulls/5/reviews?x=1`], ['GET', `${repo}/pulls?state=all&per_page=100&page=1`],
  ];
  for (const [method, path] of forbidden) await assert.rejects(api.call(method as 'GET', path, 'credential'), Denied, `${method} ${path}`);
  assert.equal(sends, 0);
});

test('GitHubTransport 실패 분류: 게시 전 실패는 다시 보낼 수 있게, 게시 시도 뒤 불명은 unknown으로 간다', async () => {
  // 토큰 단계 5xx·연결 실패: 리뷰 POST 전이므로 unknown(재게시 없음)이 아니라 429 재시도로 올린다.
  for (const token of [() => json({}, 502), () => { throw new TypeError('connect'); }] as (() => Response)[]) {
    const fake = new Fake(() => json({ id: 1 }));
    fake.token = token;
    await assert.rejects(fake.io().transport(write()), (error: unknown) => {
      assert.ok(error instanceof GitHubError);
      assert.deepEqual([error.status, error.retryAfterMs], [429, 60_000]);
      return true;
    });
    assert.deepEqual(fake.requests, []);
  }
  // 토큰 단계 거부는 영구 실패로 그대로 간다.
  const denied = new Fake(() => json({ id: 1 }));
  denied.token = () => json({}, 404);
  await rejectsWith(denied.io().transport(write()), 404);
  assert.deepEqual(denied.requests, []);
  // POST 뒤 5xx·연결 실패·깨진 응답은 게시됐을 수 있다. GitHubError(5xx) 또는 일반 오류여야 deliver가 unknown으로 둔다.
  await rejectsWith(new Fake(() => json({}, 502)).io().transport(write()), 502);
  await rejectsWith(new Fake(() => { throw new TypeError('reset'); }).io().transport(write()), 503);
  await assert.rejects(new Fake(() => json({ nope: true })).io().transport(write()), (error: unknown) => !(error instanceof GitHubError));
  // 422·429·403 한도는 게시되지 않은 것이라 그대로 올린다.
  await rejectsWith(new Fake(() => json({}, 422)).io().transport(write()), 422);
  await rejectsWith(new Fake(() => json({}, 429)).io().transport(write()), 429);
});

test('GitHubTransport [PR #38 리뷰 P2]: 게시 직전 정책 조회 실패는 보내기 전 실패로 올린다(unknown으로 잃지 않음)', async () => {
  // deliver는 transport 직전에 dispatched로 표시하고 그 뒤의 일반 예외를 unknown(재게시 없음)으로 본다.
  // 정책 일시 불가·리뷰 꺼짐은 나중에 다시 보낼 수 있게 429, 정책에서 빠진 저장소는 보내지 않고 403(재시도 없음).
  const cases: [string, () => never, number, number][] = [
    ['정책 확인 불가', () => { throw new PolicyUnavailable(); }, 429, 60_000],
    ['리뷰 꺼짐', () => { throw new ReviewDisabled(); }, 429, 60_000],
    ['정책에서 빠진 저장소', () => { throw new Denied(); }, 403, 0],
  ];
  for (const [name, fail, status, retry] of cases) {
    const fake = new Fake(() => json({ id: 1 }));
    await assert.rejects(fake.io(async () => fail()).transport(write()), (error: unknown) => {
      assert.ok(error instanceof GitHubError, name);
      assert.deepEqual([error.status, error.retryAfterMs], [status, retry], name);
      return true;
    });
    assert.deepEqual(fake.sent, [], name);
  }
});

test('비밀 노출 없음: 키·JWT·토큰이 오류 문구·inspect에 나오지 않는다', async () => {
  const pem = privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();
  const keyBody = pem.split('\n')[1]!;
  const scenarios: [string, (fake: Fake) => void, () => Response | Promise<Response>][] = [
    ['토큰 응답 JSON 깨짐', fake => { fake.token = () => new Response(`{"token":"${TOKEN}"`, { status: 201 }); }, () => json({})],
    ['토큰 응답 스키마 틀림', fake => { fake.token = () => json({ token: TOKEN }, 201); }, () => json({})],
    ['토큰 저장소 불일치', fake => { fake.token = () => json({ token: TOKEN, expires_at: expiry(NOW), permissions: { pull_requests: 'read' }, repositories: [] }, 201); }, () => json({})],
    ['토큰 발급 거부 본문', fake => { fake.token = () => json({ message: `bad ${TOKEN} ${keyBody}` }, 401); }, () => json({})],
    ['토큰 발급 연결 실패', fake => { fake.token = () => { throw new TypeError(`connect ${TOKEN}`); }; }, () => json({})],
    ['조회 실패 본문', () => {}, () => json({ message: TOKEN }, 500)],
    ['조회 연결 실패', () => {}, () => { throw new TypeError(`Bearer ${TOKEN}`); }],
    ['조회 JSON 깨짐', () => {}, () => new Response(`<html>${TOKEN}`)],
  ];
  for (const [name, setup, route] of scenarios) {
    const fake = new Fake(() => route());
    setup(fake);
    const { reader, transport } = fake.io();
    for (const work of [reader.pullRequest(REPO.fullName, 5), transport(write())]) {
      await assert.rejects(work, (error: unknown) => {
        const text = `${String(error)} ${inspect(error, { depth: 8, showHidden: true })} ${JSON.stringify(error)}`;
        for (const secret of [TOKEN, keyBody, 'PRIVATE KEY', 'Bearer ']) assert.ok(!text.includes(secret), `${name}: ${secret}`);
        assert.ok(!/eyJ[A-Za-z0-9_-]+\.eyJ/.test(text), `${name}: JWT`);
        return true;
      }, name);
    }
  }
  // 객체를 통째로 찍어도 캐시 토큰과 키가 보이지 않는다.
  const fake = new Fake();
  const auth = fake.auth();
  await auth.withToken(REPO, 'read', async () => 'warm');
  const dump = `${inspect(auth, { depth: 8, showHidden: true })} ${JSON.stringify(auth)}`;
  assert.ok(!dump.includes(TOKEN));
  assert.ok(!dump.includes(keyBody));
});

test('policyRepositories: 현재 정책의 저장소만 바인딩하고 비활성은 그대로 올린다', async () => {
  const context = { review: { repositories: [{ id: 77, fullName: REPO.fullName, installationId: 900, visibility: 'public' }] } } as unknown as ReviewContext;
  let current: () => Promise<ReviewContext> = async () => context;
  const lookup = policyRepositories({ current: () => current() });
  assert.deepEqual(await lookup(REPO.fullName), context.review.repositories[0]);
  await assert.rejects(lookup('fixture-org/not-allowed'), Denied);
  current = async () => { throw new ReviewDisabled(); };
  await assert.rejects(lookup(REPO.fullName), PolicyUnavailable);
  const fake = new Fake(() => json({}));
  await assert.rejects(fake.io(lookup).reader.pullRequest(REPO.fullName, 1), PolicyUnavailable);
  assert.deepEqual(fake.sent, []);
});

// 설정: 게시 서버 기동 입력. 필수 키는 모두 가짜 값이다.
const rsaPem = privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();
const baseEnv = () => ({
  DATABASE_URL: 'postgresql://homelab-bot:fixture-db-password@pg-rw.database.svc:5432/homelab-bot?sslmode=require',
  DISCORD_BOT_TOKEN: 'fixture-discord-token-value',
  RUNTIME_POLICIES: JSON.stringify({ revision: 'fixture-v1', owner: 'fixture-owner-id', guild: 'fixture-guild-id', conversationChannel: 'fixture-chat-id',
    notificationChannel: 'fixture-notify-id', dmEnabled: false, services: ['homelab-bot'], revocationRestores: [] }),
  GRAFANA_READER_TOKEN: 'fixture-grafana-token-value',
  HEALTHCHECKS_PING_URL: 'https://hc-ping.example/fixture-check-uuid',
  WORKER_CONTROL_PRIVATE_KEY: generateKeyPairSync('ed25519').privateKey.export({ type: 'pkcs8', format: 'pem' }).toString(),
  GITHUB_REVIEW_WEBHOOK_SECRET: 'fixture-webhook-secret-value',
  WORKER_URL: 'http://worker.sandbox:8080/',
  GRAFANA_URL: 'http://grafana.observability:3000',
  KUBERNETES_API_URL: 'https://kubernetes.default.svc',
} as Record<string, string | undefined>);
const configProblems = (env: Record<string, string | undefined>) => {
  try { loadPublisherConfig({ ...baseEnv(), ...env }, NOW); return []; } catch (error) {
    assert.ok(error instanceof ConfigError);
    for (const secret of ['PRIVATE KEY', rsaPem.split('\n')[1]!, 'not-a-real-pem']) assert.ok(!error.message.includes(secret), secret);
    return [...error.problems];
  }
};

test('리뷰 App 설정: 둘 다 없으면 비활성, 둘 다 있으면 읽는다(\\n 이스케이프 포함)', () => {
  assert.deepEqual([...REVIEW_APP_KEYS], ['GITHUB_REVIEW_APP_ID', 'GITHUB_REVIEW_APP_PRIVATE_KEY']);
  assert.equal(loadPublisherConfig(baseEnv(), NOW).githubReviewApp, null);
  // GitHub이 내려주는 PEM은 PKCS#1이다.
  const pkcs1 = privateKey.export({ type: 'pkcs1', format: 'pem' }).toString();
  for (const pem of [rsaPem, rsaPem.replaceAll('\n', '\\n'), pkcs1]) {
    const config = loadPublisherConfig({ ...baseEnv(), GITHUB_REVIEW_APP_ID: ' 12345 ', GITHUB_REVIEW_APP_PRIVATE_KEY: pem }, NOW);
    assert.equal(config.githubReviewApp?.appId, '12345');
    assert.equal(config.githubReviewApp?.privateKey.asymmetricKeyType, 'rsa');
    // 설정 객체로 만든 키가 실제 JWT 서명에 쓰인다.
    assert.equal(appJwt(config.githubReviewApp!, NOW).split('.').length, 3);
  }
});

test('리뷰 App 설정: 하나만 있거나 모양이 틀리면 기동 실패, 오류에 값이 없다', () => {
  const weak = generateKeyPairSync('rsa', { modulusLength: 1024 }).privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();
  const ed = generateKeyPairSync('ed25519').privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();
  const publicPem = publicKey.export({ type: 'spki', format: 'pem' }).toString();
  assert.deepEqual(configProblems({ GITHUB_REVIEW_APP_ID: '12345' }), ['GITHUB_REVIEW_APP_PRIVATE_KEY(missing)']);
  assert.deepEqual(configProblems({ GITHUB_REVIEW_APP_PRIVATE_KEY: rsaPem }), ['GITHUB_REVIEW_APP_ID(missing)']);
  for (const id of ['0', '-1', '12a', '1.5', 'Iv1.abc', '  ', '']) {
    assert.deepEqual(configProblems({ GITHUB_REVIEW_APP_ID: id, GITHUB_REVIEW_APP_PRIVATE_KEY: rsaPem }), ['GITHUB_REVIEW_APP_ID(invalid)'], id);
  }
  for (const key of ['not-a-real-pem', '', '  ', weak, ed, publicPem]) {
    assert.deepEqual(configProblems({ GITHUB_REVIEW_APP_ID: '12345', GITHUB_REVIEW_APP_PRIVATE_KEY: key }), ['GITHUB_REVIEW_APP_PRIVATE_KEY(invalid)']);
  }
});
