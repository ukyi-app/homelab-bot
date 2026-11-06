import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { inspect } from 'node:util';
import { changeBranchName, gitBlobSha } from '../src/change-contracts.js';
import type { ChangeTarget, ChangeWriterPort } from '../src/change-contracts.js';
import { Denied } from '../src/contracts.js';
import { assertAllowed } from '../src/github-app.js';
import { createGitHubWriter, writerRouteAllowed } from '../src/github-writer.js';
import type { WriterRepository } from '../src/github-writer.js';
import { FAKE_APP_KEY, FakeGitHub, REPO, BOT_USER } from './change-github-fake.js';

const CHANGE = '0123456789abcdef0123456789abcdef';
const OTHER_CHANGE = 'fedcba9876543210fedcba9876543210';
const TARGET: ChangeTarget = { key: { changeId: CHANGE, generation: 3 }, repoId: REPO.id };
const BRANCH = changeBranchName(CHANGE, 3);
const sha = (seed: string) => seed.repeat(40).slice(0, 40);
const REPOSITORY: WriterRepository = { ...REPO, baseBranches: ['main'] };
const IDENTITY = { name: 'fixture-writer[bot]', email: 'fixture-writer[bot]@users.noreply.github.com', date: '2026-01-02T03:04:05Z' };
const METADATA = { message: '메시지\n', author: IDENTITY, committer: IDENTITY };
const FILE = { path: 'src/a.ts', content: Buffer.from('export {};\n'), blobSha: gitBlobSha(Buffer.from('export {};\n')) };
const TREE_ENTRY = { path: 'src/a.ts', mode: '100644' as const, blobSha: FILE.blobSha };

function setup(lookup: (id: number) => Promise<WriterRepository> = async id => { if (id !== REPO.id) throw new Denied(); return REPOSITORY; }) {
  const github = new FakeGitHub();
  const io = createGitHubWriter({ app: { appId: '12345', privateKey: FAKE_APP_KEY }, repositories: lookup, send: github.send, now: () => github.clock });
  return { github, ...io };
}
function seeded() {
  const s = setup();
  const base = s.github.commitFiles({ 'README.md': '# r\n', 'src/a.ts': 'old\n' });
  s.github.refs.set('heads/main', base.sha);
  return { ...s, base };
}
const asUnknown = (value: unknown) => value as never;
// 0회 전송 단언. 토큰 발급까지 포함해 spy가 비어 있어야 한다.
async function refused(github: FakeGitHub, run: () => Promise<{ kind: string; code?: string }>, code?: string) {
  const before = github.sent.length;
  const outcome = await run();
  assert.equal(outcome.kind, 'not_sent', JSON.stringify(outcome));
  if (code) assert.equal(outcome.code, code);
  assert.equal(github.sent.length, before, 'raw fetch가 없어야 한다');
}

test('T19 B3 writer: 허용 route 표가 정확하다', () => {
  const R = '/repos/fixture-org/fixture-repo';
  for (const [method, path] of [
    ['POST', '/app/installations/900/access_tokens'], ['POST', `${R}/git/blobs`], ['POST', `${R}/git/trees`], ['POST', `${R}/git/commits`], ['POST', `${R}/git/refs`], ['POST', `${R}/pulls`],
    ['GET', `${R}/git/ref/heads/main`], ['GET', `${R}/git/ref/heads/${BRANCH}`], ['GET', `${R}/git/commits/${sha('a')}`], ['GET', `${R}/git/blobs/${sha('a')}`],
    ['GET', `${R}/git/trees/${sha('a')}`], ['GET', `${R}/git/trees/${sha('a')}?recursive=1`], ['GET', `${R}/pulls?state=all&head=fixture-org:${BRANCH}&base=main&per_page=100`],
    ['GET', '/repos/fixture-org/fixture-platform/contents/.github/workflows/app-build.yaml?ref=app-build-v1.0.1'],
  ] as const) assert.equal(writerRouteAllowed(method, path), true, `${method} ${path}`);
});

test('T19 B3 writer: D-24 거부 사례는 route 표에 없다(encoded·method 우회 포함)', () => {
  const R = '/repos/fixture-org/fixture-repo';
  const denied: [string, string][] = [
    ['PUT', `${R}/pulls/1/merge`], ['POST', `${R}/pulls/1/merge`], ['POST', `${R}/merges`], ['POST', `${R}/dispatches`],
    ['POST', `${R}/actions/workflows/build.yaml/dispatches`], ['POST', `${R}/actions/workflows/1/dispatches`], ['PUT', `${R}/pulls/1/update-branch`],
    ['POST', '/graphql'], ['POST', `${R}/pulls/1/reviews`], ['POST', `${R}/pulls/1/requested_reviewers`], ['PATCH', `${R}/pulls/1`], ['PATCH', `${R}/git/refs/heads/${BRANCH}`],
    ['DELETE', `${R}/git/refs/heads/${BRANCH}`], ['POST', `${R}/issues/1/comments`], ['PUT', `${R}/contents/src/a.ts`], ['DELETE', `${R}/contents/src/a.ts`],
    ['POST', `${R}%2Fpulls%2F1%2Fmerge`], ['POST', `${R}/pulls%2F1%2Fmerge`], ['POST', `${R}/git/blobs/../../merges`], ['POST', `${R}/git/blobs/%2e%2e/%2e%2e/merges`], ['POST', `${R}//git/blobs`],
    ['POST', `${R}/git/blobs?x=1`], ['POST', `${R}/git/blobs#x`], ['POST', `/repos/../fixture-org/x/git/blobs`], ['POST', `/repos/fixture-org/../git/blobs`],
    ['GET', `${R}/git/ref/heads/..%2Fmain`], ['GET', `${R}/git/ref/tags/v1`], ['GET', `${R}/git/refs/heads/main`], ['GET', `${R}/git/matching-refs/heads/bot`],
    ['GET', `${R}/pulls?state=open`], ['GET', `${R}/pulls?state=all&head=x:y&base=main&per_page=100&page=2`], ['GET', `${R}/pulls`], ['GET', `${R}/contents/src/a.ts?ref=main`],
    ['HEAD', `${R}/git/blobs`], ['OPTIONS', `${R}/git/blobs`], ['post', `${R}/git/blobs`], ['POST', `${R}/git/refs/heads/${BRANCH}`], ['POST', '/app/installations/abc/access_tokens'], ['POST', '/installation/token'],
    // GraphQL은 병합·auto-merge 뮤테이션의 통로라 경로 자체가 없다.
    ['GET', '/graphql'], ['POST', '/graphql/'], ['POST', '/GRAPHQL'], ['POST', '/api/graphql'], ['POST', '/graphql?query=mutation'], ['POST', `${R}/graphql`],
    ['PUT', `${R}/pulls/1/merge?x=1`], ['POST', `${R}/merge-upstream`], ['POST', `${R}/actions/runs/1/rerun`], ['POST', `${R}/git/tags`], ['POST', `${R}/releases`],
    ['POST', `${R}/git/refs?force=true`], ['PATCH', `${R}/git/refs/heads/main`], ['POST', `${R}/git/blobs/../refs`], ['POST', `${R}/pulls?x=1`],
  ];
  for (const [method, path] of denied) assert.equal(writerRouteAllowed(method, path), false, `${method} ${path}`);
});

test('T19 B3 writer: GraphQL 병합·auto-merge 문구를 실어도 /graphql로 나갈 길이 없다', async () => {
  const { github, writer, base } = seeded();
  const query = 'mutation { mergePullRequest(input: {pullRequestId: "x"}) { clientMutationId } enablePullRequestAutoMerge(input: {pullRequestId: "x"}) { clientMutationId } }';
  const pull = { target: TARGET, branch: BRANCH, baseBranch: 'main', title: 't', body: 'b', draft: false };
  for (const extra of [{ query }, { mutation: query }, { path: '/graphql' }, { operationName: 'mergePullRequest' }]) {
    await refused(github, () => writer.createPull(asUnknown({ ...pull, ...extra })), 'input_invalid');
  }
  github.refs.set(`heads/${BRANCH}`, base.sha);
  // 허용된 필드에 넣으면 그 값은 PR 본문일 뿐이고 요청은 /pulls 하나다.
  assert.equal((await writer.createPull({ ...pull, title: query.slice(0, 200), body: query })).kind, 'confirmed');
  assert.equal(github.count(/graphql|merge/i), 0);
  assert.deepEqual(github.mutations().map(item => `${item.method} ${item.path}`), [`POST /repos/${REPO.fullName}/pulls`]);
});

test('T19 B3 writer: 워크플로·보호 파일은 blob·tree 어느 쪽으로도 나가지 않는다', async () => {
  const { github, writer } = setup();
  for (const path of ['.github/workflows/x.yaml', '.GITHUB/workflows/x.yaml', 'src/.github/x.yaml', 'src/AGENTS.md', 'CODEOWNERS', '.gitmodules', 'src/.env']) {
    await refused(github, () => writer.createBlobs({ target: TARGET, files: [{ ...FILE, path }] }), 'input_invalid');
    await refused(github, () => writer.createTree({ target: TARGET, baseTree: sha('a'), entries: [{ ...TREE_ENTRY, path }] }), 'input_invalid');
  }
  // 허용 파일 뒤에 숨겨도 앞 파일까지 보내지 않는다.
  await refused(github, () => writer.createBlobs({ target: TARGET, files: [FILE, { ...FILE, path: '.github/workflows/x.yaml' }] }), 'input_invalid');
});

test('T19 B3 writer: 변경 내용 상한을 넘으면 자르지 않고 토큰 발급 전에 멈춘다', async () => {
  const { github, writer } = setup();
  const part = (name: string, size: number) => {
    const content = Buffer.alloc(size, 0x61);
    return { path: `src/${name}.txt`, content, blobSha: gitBlobSha(content) };
  };
  await refused(github, () => writer.createBlobs({ target: TARGET, files: [part('one', 1024 * 1024 + 1)] }), 'content_too_large');
  await refused(github, () => writer.createBlobs({ target: TARGET, files: [part('a', 600 * 1024), part('b', 600 * 1024)] }), 'content_too_large');
  const exact = seeded();
  assert.equal((await exact.writer.createBlobs({ target: TARGET, files: [part('c', 1024 * 1024)] })).kind, 'confirmed', '상한과 같으면 받는다');
});

test('T19 B3 writer: 읽기는 401이면 토큰을 한 번 갈아 끼우고 mutation은 갈지 않는다', async () => {
  const { github, writer, base } = seeded();
  assert.deepEqual(await writer.readBranchHead({ target: TARGET, branch: 'main' }), { sha: base.sha });
  assert.equal(github.tokenPosts, 1);
  github.fail(/GET .*\/git\/ref\/heads\/main/, { status: 401 });
  assert.deepEqual(await writer.readBranchHead({ target: TARGET, branch: 'main' }), { sha: base.sha });
  assert.equal(github.tokenPosts, 2, '철회된 토큰을 새로 받았다');
  // 두 번째 401이면 포기한다. 무한 재발급이 없다.
  github.fail(/GET .*\/git\/ref\/heads\/main/, { status: 401 }, 2);
  await assert.rejects(writer.readBranchHead({ target: TARGET, branch: 'main' }), /read_http_401/);
  assert.equal(github.tokenPosts, 3);
});

test('T19 B3 writer: gitlink 행을 버리지 않고 돌려줘 호출자가 닫을 수 있다', async () => {
  const { github, preflight } = seeded();
  const seeded2 = github.commitFiles({ 'src/a.ts': 'a\n', vendor: 'x' }, [], { vendor: '160000' });
  const leaves = await preflight.readTreeLeaves({ target: TARGET, sha: seeded2.tree });
  assert.deepEqual(leaves?.leaves.find(leaf => leaf.path === 'vendor')?.mode, '160000');
  github.truncated.add(seeded2.tree);
  const walked = await preflight.readTreeLeaves({ target: TARGET, sha: seeded2.tree });
  assert.deepEqual(walked?.leaves.find(leaf => leaf.path === 'vendor')?.mode, '160000');
});

test('T19 B3 writer: 코드 구조. fetch는 closure 한 곳이고 범용 API가 없으며 리뷰 allowlist가 늘지 않았다', async () => {
  const source = await readFile(new URL('../../src/github-writer.ts', import.meta.url), 'utf8');
  assert.equal((source.match(/\bsend\(/g) ?? []).length, 1, 'send 호출 지점은 하나다');
  assert.equal((source.match(/\bfetch\(/g) ?? []).length, 0);
  assert.equal((source.match(/globalThis|require\(|node:https|node:http/g) ?? []).length, 0);
  const s = setup();
  assert.deepEqual(Object.keys(s.writer).sort(), ['createBlobs', 'createCommit', 'createPull', 'createRef', 'createTree', 'findPulls', 'readBlobExists', 'readBranchHead', 'readCommit', 'readTreeLeaves']);
  assert.deepEqual(Object.keys(s.preflight).sort(), ['readBlobText', 'readBranchHead', 'readCommit', 'readPinnedWorkflow', 'readTreeLeaves']);
  for (const [method, path] of [['POST', '/repos/o/r/git/blobs'], ['POST', '/repos/o/r/git/refs'], ['POST', '/repos/o/r/pulls'], ['GET', '/repos/o/r/git/ref/heads/main']] as const) {
    assert.throws(() => assertAllowed(method, path), Denied, '리뷰 allowlist에 writer API가 없다');
  }
});

for (const [name, branch] of Object.entries({
  main: 'main', 'deploy 브랜치': 'deploy/app', tag: 'refs/tags/v1', 'refs 접두': `refs/heads/${BRANCH}`, 'botx 접두': `botx/change/${CHANGE}/g3`, 'bot 임의 이름': 'bot/anything',
  '다른 change': changeBranchName(OTHER_CHANGE, 3), '다른 generation': changeBranchName(CHANGE, 4), 'encoded 슬래시': `bot%2Fchange%2F${CHANGE}%2Fg3`, '이중 인코딩': `bot%252Fchange/${CHANGE}/g3`,
  '점 세그먼트': `bot/change/${CHANGE}/../main`, '대문자 G': `bot/change/${CHANGE}/G3`, '빈 값': '', '개행': `${BRANCH}\n`,
})) {
  test(`T19 B3 writer: createRef·createPull이 잘못된 브랜치를 거부한다: ${name}`, async () => {
    const { github, writer } = setup();
    await refused(github, () => writer.createRef({ target: TARGET, branch, sha: sha('a') }), 'branch_not_allowed');
    await refused(github, () => writer.createPull({ target: TARGET, branch, baseBranch: 'main', title: 't', body: 'b', draft: false }), 'branch_not_allowed');
  });
}

test('T19 B3 writer: 추가 필드로 우회하지 못한다(force·merge·issue·state·maintainer)', async () => {
  const { github, writer } = setup();
  const ref = { target: TARGET, branch: BRANCH, sha: sha('a') };
  await refused(github, () => writer.createRef(asUnknown({ ...ref, force: true })), 'input_invalid');
  await refused(github, () => writer.createRef(asUnknown({ ...ref, ref: 'refs/heads/main' })), 'input_invalid');
  await refused(github, () => writer.createRef(asUnknown({ ...ref, url: 'https://evil.example', method: 'DELETE', token: 'x' })), 'input_invalid');
  const pull = { target: TARGET, branch: BRANCH, baseBranch: 'main', title: 't', body: 'b', draft: false };
  for (const extra of [{ issue: 1 }, { maintainer_can_modify: true }, { state: 'closed' }, { head: 'main' }, { merge: true }, { auto_merge: true }]) {
    await refused(github, () => writer.createPull(asUnknown({ ...pull, ...extra })), 'input_invalid');
  }
  await refused(github, () => writer.createPull({ ...pull, baseBranch: 'develop' }), 'base_not_allowed');
  await refused(github, () => writer.createPull({ ...pull, baseBranch: BRANCH }), 'base_not_allowed');
  await refused(github, () => writer.createCommit(asUnknown({ target: TARGET, treeSha: sha('a'), parent: sha('b'), parents: [sha('b'), sha('c')], metadata: METADATA })), 'input_invalid');
  await refused(github, () => writer.createCommit({ target: TARGET, treeSha: sha('a'), parent: 'main', metadata: METADATA }), 'input_invalid');
  await refused(github, () => writer.createCommit({ target: TARGET, treeSha: sha('a'), parent: sha('b'), metadata: { ...METADATA, author: { ...IDENTITY, email: 'person@example.org' } } }), 'input_invalid');
  await refused(github, () => writer.createCommit(asUnknown({ target: TARGET, treeSha: sha('a'), parent: sha('b'), metadata: { ...METADATA, signature: 'x' } })), 'input_invalid');
  await refused(github, () => writer.createTree(asUnknown({ target: TARGET, entries: [TREE_ENTRY] })), 'input_invalid');
  await refused(github, () => writer.createTree({ target: TARGET, baseTree: sha('a'), entries: [] }), 'input_invalid');
  await refused(github, () => writer.createTree(asUnknown({ target: TARGET, baseTree: sha('a'), entries: [{ ...TREE_ENTRY, type: 'tree' }] })), 'input_invalid');
  await refused(github, () => writer.createTree(asUnknown({ target: TARGET, baseTree: sha('a'), entries: [{ ...TREE_ENTRY, mode: '120000' }] })), 'input_invalid');
  await refused(github, () => writer.createTree(asUnknown({ target: TARGET, baseTree: sha('a'), entries: [{ ...TREE_ENTRY, mode: '040000' }] })), 'input_invalid');
  for (const path of ['.github/workflows/x.yaml', 'src/AGENTS.md', '../x', '/x', 'src/.git/config', 'src\\x']) {
    await refused(github, () => writer.createTree({ target: TARGET, baseTree: sha('a'), entries: [{ ...TREE_ENTRY, path }] }), 'input_invalid');
  }
  await refused(github, () => writer.createTree({ target: TARGET, baseTree: sha('a'), entries: [TREE_ENTRY, TREE_ENTRY] }), 'input_invalid');
  await refused(github, () => writer.createBlobs({ target: TARGET, files: [{ ...FILE, blobSha: sha('a') }] }), 'input_invalid');
  await refused(github, () => writer.createBlobs({ target: TARGET, files: [] }), 'input_invalid');
});

test('T19 B3 writer: 다른 저장소·철회된 저장소·이상한 이름은 토큰 발급 전에 닫힌다', async () => {
  const { github, writer } = setup();
  await refused(github, () => writer.createBlobs({ target: { ...TARGET, repoId: 9999 }, files: [FILE] }), 'repository_denied');
  await refused(github, () => writer.createRef({ target: { ...TARGET, repoId: 9999 }, branch: BRANCH, sha: sha('a') }), 'repository_denied');
  for (const fullName of ['fixture-org/../x', 'fixture-org', 'a/b/c', 'fixture-org/%2e%2e', '../x/y', 'fixture-org/x y']) {
    const odd = setup(async () => ({ ...REPOSITORY, fullName }));
    await refused(odd.github, () => odd.writer.createBlobs({ target: TARGET, files: [FILE] }), 'repository_denied');
  }
  const noBase = setup(async () => ({ ...REPOSITORY, baseBranches: [] }));
  await refused(noBase.github, () => noBase.writer.createPull({ target: TARGET, branch: BRANCH, baseBranch: 'main', title: 't', body: 'b', draft: false }), 'base_not_allowed');
});

test('T19 B3 writer: 읽기 입력도 정확한 값만 받고 prefix 검색이 없다', async () => {
  const { github, writer, preflight } = setup();
  for (const branch of ['../main', 'main?x=1', 'a b', 'refs/heads/main', 'bot%2Fx', 'x..y']) {
    await assert.rejects(writer.readBranchHead({ target: TARGET, branch }), /read_input_invalid/);
    await assert.rejects(preflight.readBranchHead({ target: TARGET, branch }), /read_input_invalid/);
  }
  for (const value of ['main', '../x', sha('a').toUpperCase(), `${sha('a')}?recursive=1`]) {
    await assert.rejects(writer.readCommit({ target: TARGET, sha: value }), /read_input_invalid/);
    await assert.rejects(writer.readTreeLeaves({ target: TARGET, sha: value }), /read_input_invalid/);
    await assert.rejects(writer.readBlobExists({ target: TARGET, sha: value }), /read_input_invalid/);
  }
  await assert.rejects(writer.findPulls({ target: TARGET, headBranch: 'main', baseBranch: 'main' }), /read_input_invalid/);
  await assert.rejects(writer.findPulls({ target: TARGET, headBranch: BRANCH, baseBranch: 'other' }), /read_input_invalid/);
  for (const uses of ['evil/x@main', 'fixture-org/fixture-platform/.github/workflows/../../x.yaml@v1', 'o/r/.github/workflows/a.yaml@${{ x }}', 'o/r/src/a.yaml@v1']) {
    await assert.rejects(preflight.readPinnedWorkflow({ uses }), /read_input_invalid/, uses);
  }
  assert.equal(github.sent.length, 0);
});

test('T19 B3 writer: 두 토큰을 정확한 권한·저장소 하나로 발급하고 내용 토큰으로는 PR을 못 만든다', async () => {
  const { github, writer, base } = seeded();
  assert.equal((await writer.createBlobs({ target: TARGET, files: [FILE] })).kind, 'confirmed');
  assert.deepEqual(github.issued.at(-1)?.permissions, { contents: 'write' });
  assert.deepEqual(github.issued.at(-1)?.repositoryIds, [REPO.id]);
  const tree = await writer.createTree({ target: TARGET, baseTree: base.tree, entries: [TREE_ENTRY] });
  assert.equal(tree.kind, 'confirmed');
  assert.equal(github.tokenPosts, 1, '같은 change·generation·scope는 캐시를 쓴다');
  const commit = await writer.createCommit({ target: TARGET, treeSha: (tree as { value: { treeSha: string } }).value.treeSha, parent: base.sha, metadata: METADATA });
  assert.equal(commit.kind, 'confirmed');
  const commitSha = (commit as { value: { commitSha: string } }).value.commitSha;
  assert.equal((await writer.createRef({ target: TARGET, branch: BRANCH, sha: commitSha })).kind, 'confirmed');
  const pull = await writer.createPull({ target: TARGET, branch: BRANCH, baseBranch: 'main', title: '제목', body: '본문', draft: false });
  assert.equal(pull.kind, 'confirmed', JSON.stringify(pull));
  assert.deepEqual(github.issued.at(-1)?.permissions, { contents: 'read', pull_requests: 'write' });
  assert.equal(github.tokenPosts, 2);
  const posted = github.sent.find(item => item.method === 'POST' && item.path.endsWith('/pulls'))!;
  assert.deepEqual(posted.body, { title: '제목', body: '본문', head: BRANCH, base: 'main', draft: false, maintainer_can_modify: false });
  const contentToken = github.issued[0]!.token;
  const prToken = github.issued[1]!.token;
  for (const item of github.mutations()) {
    assert.equal(item.authorization, `Bearer ${item.path.endsWith('/pulls') ? prToken : contentToken}`, item.path);
    assert.equal(item.init.redirect, 'manual');
    assert.equal(new Headers(item.init.headers).get('x-http-method-override'), null);
    assert.ok(new URL(`https://api.github.com${item.path}`).origin === 'https://api.github.com');
  }
  const refBody = github.sent.find(item => item.path.endsWith('/git/refs'))!.body as Record<string, unknown>;
  assert.deepEqual(Object.keys(refBody).sort(), ['ref', 'sha'], 'force 필드 자체가 없다');
  assert.equal(refBody.ref, `refs/heads/${BRANCH}`);
  const commitBody = github.sent.find(item => item.path.endsWith('/git/commits'))!.body as Record<string, unknown>;
  assert.deepEqual(Object.keys(commitBody).sort(), ['author', 'committer', 'message', 'parents', 'tree']);
  assert.deepEqual(commitBody.parents, [base.sha]);
  const treeBody = github.sent.find(item => item.path.endsWith('/git/trees'))!.body as { base_tree: string; tree: { type: string }[] };
  assert.equal(treeBody.base_tree, base.tree);
  assert.deepEqual(treeBody.tree.map(entry => entry.type), ['blob']);
});

test('T19 B3 writer: 토큰 캐시 키에 change·generation·scope가 들어간다', async () => {
  const { github, writer } = seeded();
  await writer.createBlobs({ target: TARGET, files: [FILE] });
  await writer.createBlobs({ target: TARGET, files: [FILE] });
  assert.equal(github.tokenPosts, 1);
  await writer.createBlobs({ target: { ...TARGET, key: { ...TARGET.key, generation: 4 } }, files: [FILE] });
  assert.equal(github.tokenPosts, 2);
  await writer.createBlobs({ target: { ...TARGET, key: { changeId: OTHER_CHANGE, generation: 3 } }, files: [FILE] });
  assert.equal(github.tokenPosts, 3);
  // 만료 5분 전에는 새로 받는다.
  github.clock += 3_600_000 - 299_000;
  await writer.createBlobs({ target: TARGET, files: [FILE] });
  assert.equal(github.tokenPosts, 4);
});

const issuedBody = (id: number, name: string, permissions: Record<string, string>, expires: number) => new Response(JSON.stringify({ token: 'ghs_fixtureRejected', expires_at: new Date(expires).toISOString(), permissions, repositories: [{ id, full_name: name }] }), { status: 201 });
test('T19 B3 writer: 토큰 응답의 저장소·권한·만료를 대조한다. 어긋나면 blob을 보내지 않는다', async () => {
  const cases: [string, (now: number) => Response, string][] = [
    ['다른 저장소 ID', now => issuedBody(1, REPO.fullName, { contents: 'write' }, now + 3_600_000), 'token_repository_mismatch'],
    ['다른 이름', now => issuedBody(REPO.id, 'fixture-org/other', { contents: 'write' }, now + 3_600_000), 'token_repository_mismatch'],
    ['저장소 목록 없음', now => new Response(JSON.stringify({ token: 'ghs_x', expires_at: new Date(now + 3_600_000).toISOString(), permissions: { contents: 'write' } }), { status: 201 }), 'token_repository_mismatch'],
    ['저장소 둘', now => new Response(JSON.stringify({ token: 'ghs_x', expires_at: new Date(now + 3_600_000).toISOString(), permissions: { contents: 'write' }, repositories: [{ id: REPO.id, full_name: REPO.fullName }, { id: 2, full_name: 'a/b' }] }), { status: 201 }), 'token_repository_mismatch'],
    ['추가 권한', now => issuedBody(REPO.id, REPO.fullName, { contents: 'write', pull_requests: 'write' }, now + 3_600_000), 'token_permission_mismatch'],
    ['낮은 권한', now => issuedBody(REPO.id, REPO.fullName, { contents: 'read' }, now + 3_600_000), 'token_permission_mismatch'],
    ['이미 만료', now => issuedBody(REPO.id, REPO.fullName, { contents: 'write' }, now - 1000), 'token_expiry_invalid'],
    ['너무 긴 만료', now => issuedBody(REPO.id, REPO.fullName, { contents: 'write' }, now + 3 * 3_600_000), 'token_expiry_invalid'],
    ['스키마 어긋남', () => new Response('{"token":""}', { status: 201 }), 'token_response_invalid'],
    ['JSON 아님', () => new Response('x', { status: 201 }), 'token_response_invalid'],
    ['발급 거부', () => new Response('{}', { status: 403 }), 'token_http_403'],
  ];
  for (const [name, response, code] of cases) {
    const { github, writer } = setup();
    github.tokenOverride = () => response(github.clock);
    const outcome = await writer.createBlobs({ target: TARGET, files: [FILE] });
    assert.deepEqual(outcome, { kind: 'not_sent', code }, name);
    assert.equal(github.mutations().length, 0, name);
  }
});

test('T19 B3 writer: 토큰·JWT·키가 객체·오류·결과에 드러나지 않는다', async () => {
  const { github, writer, preflight } = seeded();
  await writer.createBlobs({ target: TARGET, files: [FILE] });
  const token = github.issued[0]!.token;
  const exposed = [inspect(writer, { depth: 8, showHidden: true }), inspect(preflight, { depth: 8, showHidden: true }), JSON.stringify(writer)];
  for (const text of exposed) {
    assert.ok(!text.includes(token));
    assert.ok(!text.includes('PRIVATE KEY'));
  }
  github.fail(/git\/trees/, { status: 500 });
  const outcome = await writer.createTree({ target: TARGET, baseTree: sha('a'), entries: [TREE_ENTRY] });
  assert.ok(!JSON.stringify(outcome).includes(token));
});

test('T19 B3 writer: 응답 분류. 연결 전 실패만 미전송이고 불명확한 응답은 unknown이며 mutation을 재전송하지 않는다', async () => {
  const baseTree = sha('a');
  const cases: [string, Parameters<FakeGitHub['fail']>[1], object][] = [
    ['연결 거부', 'refused', { kind: 'not_sent', code: 'connection_refused' }],
    ['연결 끊김', 'reset_before_apply', { kind: 'unknown', code: 'response_lost' }],
    ['응답 유실', 'lose_response', { kind: 'unknown', code: 'response_lost' }],
    ['5xx', { status: 502 }, { kind: 'unknown', code: 'http_5xx' }],
    ['잘못된 JSON', 'invalid_json', { kind: 'unknown', code: 'response_invalid' }],
    ['응답 상한', 'oversize', { kind: 'unknown', code: 'response_too_large' }],
    ['응답 상한(선언)', { status: 200, headers: { 'content-length': String(32 * 1024 * 1024) } }, { kind: 'unknown', code: 'response_too_large' }],
    ['401', { status: 401 }, { kind: 'rejected', status: 401, code: 'http_401' }],
    ['403', { status: 403 }, { kind: 'rejected', status: 403, code: 'http_403' }],
    ['404', { status: 404 }, { kind: 'rejected', status: 404, code: 'http_404' }],
    ['422', { status: 422 }, { kind: 'rejected', status: 422, code: 'http_422' }],
    ['redirect', { status: 307, headers: { location: 'https://evil.example/x' } }, { kind: 'rejected', status: 307, code: 'http_307' }],
    ['한도 초과 403', 'rate_limited', { kind: 'not_sent', code: 'rate_limited' }],
    ['429', { status: 429 }, { kind: 'not_sent', code: 'rate_limited' }],
  ];
  for (const [name, mode, expected] of cases) {
    const { github, writer } = seeded();
    github.trees.set(baseTree, []);
    await writer.createBlobs({ target: TARGET, files: [FILE] });
    github.fail(/POST .*\/git\/trees/, mode);
    assert.deepEqual(await writer.createTree({ target: TARGET, baseTree, entries: [TREE_ENTRY] }), expected, name);
    assert.equal(github.mutations(/git\/trees/).length, 1, `${name}: 재전송하지 않는다`);
  }
});

test('T19 B3 writer: blob은 내용 대조하고 일부 실패를 그대로 알린다', async () => {
  const second = { path: 'src/b.ts', content: Buffer.from('b\n'), blobSha: gitBlobSha(Buffer.from('b\n')) };
  const lost = seeded();
  lost.github.fail(/POST .*\/git\/blobs/, 'lose_response');
  assert.deepEqual(await lost.writer.createBlobs({ target: TARGET, files: [FILE, second] }), { kind: 'unknown', code: 'response_lost' });
  const rejected = seeded();
  await rejected.writer.createBlobs({ target: TARGET, files: [FILE] });
  rejected.github.fail(/POST .*\/git\/blobs/, { status: 422 });
  assert.deepEqual(await rejected.writer.createBlobs({ target: TARGET, files: [second] }), { kind: 'rejected', status: 422, code: 'http_422' });
  const wrong = setup();
  const send = wrong.github.send;
  const odd = createGitHubWriter({ app: { appId: '12345', privateKey: FAKE_APP_KEY }, repositories: async () => REPOSITORY, now: () => wrong.github.clock,
    send: async (input, init) => String(input).endsWith('/git/blobs') ? new Response(JSON.stringify({ sha: sha('e') }), { status: 201 }) : send(input, init) });
  assert.deepEqual(await odd.writer.createBlobs({ target: TARGET, files: [FILE] }), { kind: 'rejected', status: 201, code: 'blob_sha_mismatch' });
  const ok = seeded();
  assert.deepEqual(await ok.writer.createBlobs({ target: TARGET, files: [FILE, second] }), { kind: 'confirmed', value: { shas: [FILE.blobSha, second.blobSha] } });
  const body = ok.github.mutations(/git\/blobs/)[0]!.body as Record<string, unknown>;
  assert.deepEqual(Object.keys(body).sort(), ['content', 'encoding']);
  assert.equal(body.encoding, 'base64');
});

test('T19 B3 writer: 선행 읽기는 자격 없이 나가고 토큰을 발급하지 않는다', async () => {
  const { github, preflight, base } = seeded();
  assert.deepEqual(await preflight.readBranchHead({ target: TARGET, branch: 'main' }), { sha: base.sha });
  assert.equal(await preflight.readBranchHead({ target: TARGET, branch: 'no-such' }), null);
  assert.deepEqual(await preflight.readCommit({ target: TARGET, sha: base.sha }), { treeSha: base.tree, parents: [] });
  const leaves = await preflight.readTreeLeaves({ target: TARGET, sha: base.tree });
  assert.equal(leaves?.complete, true);
  assert.deepEqual(leaves?.leaves.map(leaf => leaf.path).sort(), ['README.md', 'src/a.ts']);
  assert.equal(await preflight.readBlobText(TARGET, gitBlobSha(Buffer.from('# r\n'))), '# r\n');
  github.pinned.set('fixture-org/fixture-platform/.github/workflows/app-build.yaml@app-build-v1.0.1', 'on: workflow_call\n');
  assert.deepEqual(await preflight.readPinnedWorkflow({ uses: 'fixture-org/fixture-platform/.github/workflows/app-build.yaml@app-build-v1.0.1' }), { blobSha: gitBlobSha(Buffer.from('on: workflow_call\n')), text: 'on: workflow_call\n' });
  assert.equal(github.tokenPosts, 0);
  assert.ok(github.sent.every(item => item.method === 'GET' && item.authorization === ''));
});

test('T19 B3 writer: 대조 읽기는 PR 토큰을 쓰고 내용 쓰기 토큰을 만들지 않는다', async () => {
  const { github, writer, base } = seeded();
  assert.deepEqual(await writer.readBranchHead({ target: TARGET, branch: 'main' }), { sha: base.sha });
  assert.equal(await writer.readBlobExists({ target: TARGET, sha: gitBlobSha(Buffer.from('# r\n')) }), true);
  assert.equal(await writer.readBlobExists({ target: TARGET, sha: sha('9') }), false);
  assert.equal(await writer.readCommit({ target: TARGET, sha: sha('9') }), null);
  assert.equal(await writer.readTreeLeaves({ target: TARGET, sha: sha('9') }), null);
  assert.deepEqual(github.issued.map(item => item.permissions), [{ contents: 'read', pull_requests: 'write' }]);
  assert.ok(github.sent.filter(item => item.method === 'GET').every(item => item.authorization === `Bearer ${github.issued[0]!.token}`));
});

test('T19 B3 writer: 읽기 응답을 믿지 않는다', async () => {
  const lying = (body: unknown) => {
    const s = seeded();
    const writerIO = createGitHubWriter({ app: { appId: '12345', privateKey: FAKE_APP_KEY }, repositories: async () => REPOSITORY, now: () => s.github.clock,
      send: async (input, init) => init?.method === 'GET' ? new Response(JSON.stringify(body), { status: 200 }) : s.github.send(input, init) });
    return writerIO;
  };
  await assert.rejects(lying({ ref: 'refs/heads/other', object: { type: 'commit', sha: sha('a') } }).writer.readBranchHead({ target: TARGET, branch: 'main' }), /read_response_invalid/);
  await assert.rejects(lying({ ref: 'refs/heads/main', object: { type: 'tag', sha: sha('a') } }).writer.readBranchHead({ target: TARGET, branch: 'main' }), /read_response_invalid/);
  await assert.rejects(lying({ sha: sha('b'), tree: { sha: sha('c') }, parents: [] }).writer.readCommit({ target: TARGET, sha: sha('a') }), /read_response_invalid/);
  await assert.rejects(lying({ sha: sha('b'), truncated: false, tree: [] }).writer.readTreeLeaves({ target: TARGET, sha: sha('a') }), /read_response_invalid/);
  await assert.rejects(lying({ sha: sha('b'), size: 1, encoding: 'base64', content: '' }).writer.readBlobExists({ target: TARGET, sha: sha('a') }), /read_response_invalid/);
  await assert.rejects(lying({ type: 'file', encoding: 'base64', sha: sha('b'), content: Buffer.from('x').toString('base64') }).preflight.readPinnedWorkflow({ uses: 'o/r/.github/workflows/a.yaml@v1' }), /read_response_invalid/);
});

test('T19 B3 writer: 잘린 tree는 제한된 비재귀 탐색으로 입증하거나 complete=false다', async () => {
  const { github, preflight, base } = seeded();
  github.truncated.add(base.tree);
  const walked = await preflight.readTreeLeaves({ target: TARGET, sha: base.tree });
  assert.equal(walked?.complete, true);
  assert.deepEqual(walked?.leaves.map(leaf => leaf.path).sort(), ['README.md', 'src/a.ts']);
  // 비재귀 응답도 잘리면 완결성을 입증할 수 없다.
  github.truncated.add(`${base.tree}:flat`);
  const cut = await preflight.readTreeLeaves({ target: TARGET, sha: base.tree });
  assert.equal(cut?.complete, false);
  // 탐색 상한을 넘겨도 complete=false다.
  const big: Record<string, string> = {};
  for (let i = 0; i < 80; i++) big[`dir${i}/f.txt`] = `${i}\n`;
  const many = seeded();
  const wide = many.github.commitFiles(big);
  many.github.truncated.add(wide.tree);
  const limited = await many.preflight.readTreeLeaves({ target: TARGET, sha: wide.tree });
  assert.equal(limited?.complete, false);
  assert.ok(many.github.count(/git\/trees/) <= 66);
});

test('T19 B3 writer: findPulls는 정확한 head·base만 돌려주고 상한을 넘으면 실패한다', async () => {
  const { github, writer } = seeded();
  const make = (ref: string, base = 'main', head = REPO.id) => github.addPull({ head: { ref, sha: sha('a'), repo: { id: head } }, base: { ref: base, repo: { id: REPO.id } }, title: '제목', body: null });
  make(BRANCH);
  assert.deepEqual((await writer.findPulls({ target: TARGET, headBranch: BRANCH, baseBranch: 'main' })).map(pull => [pull.headBranch, pull.body, pull.authorId, pull.repoId, pull.merged]), [[BRANCH, '', BOT_USER, REPO.id, false]]);
  const list = github.sent.find(item => item.path.includes('state=all'))!;
  assert.match(list.path, new RegExp(`state=all&head=fixture-org:${BRANCH.replaceAll('/', '/')}&base=main&per_page=100$`));
  // 응답이 섞여 와도(다른 브랜치·포크) 정확한 것만 남긴다.
  const send = github.send;
  const mixed = createGitHubWriter({ app: { appId: '12345', privateKey: FAKE_APP_KEY }, repositories: async () => REPOSITORY, now: () => github.clock, send: async (input, init) => {
    if (String(input).includes('state=all')) {
      const row = (ref: string, baseRef: string, headRepo: number | null, baseRepo: number) => ({ number: 1, state: 'open', merged_at: null, title: 't', body: 'b', user: { id: BOT_USER }, head: { ref, sha: sha('a'), repo: headRepo === null ? null : { id: headRepo } }, base: { ref: baseRef, repo: { id: baseRepo } } });
      return new Response(JSON.stringify([row(`${BRANCH}-x`, 'main', REPO.id, REPO.id), row(BRANCH, 'dev', REPO.id, REPO.id), row(BRANCH, 'main', 5, REPO.id), row(BRANCH, 'main', null, REPO.id), row(BRANCH, 'main', REPO.id, REPO.id)]), { status: 200 });
    }
    return send(input, init);
  } });
  const found = await mixed.writer.findPulls({ target: TARGET, headBranch: BRANCH, baseBranch: 'main' });
  assert.equal(found.length, 1);
  const full = createGitHubWriter({ app: { appId: '12345', privateKey: FAKE_APP_KEY }, repositories: async () => REPOSITORY, now: () => github.clock, send: async (input, init) => {
    if (String(input).includes('state=all')) return new Response(JSON.stringify(Array.from({ length: 100 }, () => ({ number: 1, state: 'open', merged_at: null, title: 't', body: 'b', user: { id: BOT_USER }, head: { ref: BRANCH, sha: sha('a'), repo: { id: REPO.id } }, base: { ref: 'main', repo: { id: REPO.id } } }))), { status: 200 });
    return send(input, init);
  } });
  await assert.rejects(full.writer.findPulls({ target: TARGET, headBranch: BRANCH, baseBranch: 'main' }), /pull_list_incomplete/);
});

test('T19 B3 writer: ChangeWriterPort 형태를 만족한다', () => {
  const { writer } = setup();
  const port: ChangeWriterPort = writer;
  assert.ok(port);
});
