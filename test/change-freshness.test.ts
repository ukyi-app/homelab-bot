import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ok } from './change-store-fixture.js';
import { REPO, branchOf, publishEnv, reapprove, repositoryPolicy } from './change-github-fake.js';
import type { PublishEnv } from './change-github-fake.js';
import { localDatabase } from './helpers.js';
import { gitCommitSha, gitTreeSha } from '../src/change-policy.js';
import { ChangePublisher } from '../src/change-publisher.js';

// CHANGE-02·03: 승인 뒤 게시 경로의 재검사. 가짜 GitHub만 부른다.
async function setup(options: Parameters<typeof publishEnv>[1] = {}) {
  const { db, pg } = await localDatabase();
  const env = await publishEnv(db, options);
  return { env, close: () => pg.close() };
}
const phaseOf = async (env: PublishEnv, id: string) => ok(await env.store.get(id));
const noWrites = (env: PublishEnv) => {
  assert.equal(env.github.tokenPosts, 0, '토큰을 발급하지 않았다');
  assert.equal(env.github.mutations().length, 0, 'POST가 없다');
};

test('T19 B3 게시: 정상 경로는 blob→tree→commit→ref→PR 순서이고 commit SHA를 먼저 계산한 값과 같다', async () => {
  const { env, close } = await setup();
  try {
    const key = await env.approve();
    const outcome = await env.publisher.publish(key);
    assert.equal(outcome.kind, 'proposed', JSON.stringify(outcome));
    const order = env.github.mutations().map(item => item.path.replace(/^\/repos\/[^/]+\/[^/]+/, ''));
    assert.deepEqual(order, ['/git/blobs', '/git/blobs', '/git/trees', '/git/commits', '/git/refs', '/pulls']);
    assert.equal((await phaseOf(env, key.changeId)).phase, 'proposed');
    const head = env.github.refs.get(`heads/${branchOf(key)}`)!;
    const generation = ok(await env.store.generationRecord(key));
    const subject = ok(await env.store.approvalSubject(key)).subject;
    const { publication } = subject;
    assert.equal(head, gitCommitSha({ treeSha: generation.resultTree!, parents: [generation.baseCommit], message: publication.commitMessage, author: publication.author, committer: publication.committer }));
    assert.deepEqual(env.github.commits.get(head), { tree: generation.resultTree, parents: [generation.baseCommit] });
    assert.equal(gitTreeSha(env.github.leaves(generation.resultTree!)), generation.resultTree);
    assert.equal(env.github.pulls.length, 1);
    assert.equal(env.github.pulls[0]!.body, publication.body);
    assert.equal(env.github.pulls[0]!.title, publication.title);
    assert.ok(outcome.kind === 'proposed' && outcome.prNumber === env.github.pulls[0]!.number && outcome.headSha === head);
    assert.deepEqual(env.github.issued.map(item => item.permissions), [{ contents: 'write' }, { contents: 'read', pull_requests: 'write' }]);
    assert.deepEqual(await env.store.unresolvedEffects({ changeId: key.changeId }), []);
    // 다시 불러도 아무것도 더 보내지 않는다.
    const before = env.github.mutations().length;
    const again = await env.publisher.publish(key);
    assert.equal(again.kind, 'proposed');
    assert.equal(env.github.mutations().length, before);
  } finally { await close(); }
});

test('T19 B3 게시: 삭제·mode만 있는 변경은 blob 요청 없이 간다', async () => {
  const { env, close } = await setup();
  try {
    const key = await env.approve([{ path: 'tests/a.test.ts', kind: 'deleted' }, { path: 'src/a.ts', kind: 'mode_changed', mode: '100755' }]);
    assert.equal((await env.publisher.publish(key)).kind, 'proposed');
    assert.equal(env.github.mutations(/git\/blobs/).length, 0);
    const treeBody = env.github.mutations(/git\/trees/)[0]!.body as { tree: { path: string; mode: string; sha: string | null }[] };
    assert.deepEqual(treeBody.tree.map(entry => [entry.path, entry.mode, entry.sha === null]), [['src/a.ts', '100755', false], ['tests/a.test.ts', '100644', true]]);
  } finally { await close(); }
});

test('T19 B3 게시: 전체 검사가 첫 blob 전에 끝난다. 허용 파일 뒤의 금지 파일이어도 blob POST·토큰 발급 0회', async () => {
  const cases: { name: string; changes: Parameters<PublishEnv['approve']>[0]; reason: string }[] = [
    { name: '허용 뒤 workflow', changes: [{ path: 'README.md', kind: 'modified' }, { path: 'src/a.ts', kind: 'modified' }, { path: 'src/z/.github/x.yaml', kind: 'added' }], reason: 'protected_path' },
    { name: '허용 앞 금지', changes: [{ path: '.github/workflows/new.yaml', kind: 'added' }, { path: 'src/a.ts', kind: 'modified' }], reason: 'protected_path' },
    { name: '허용 뒤 목록 밖', changes: [{ path: 'src/a.ts', kind: 'modified' }, { path: 'zzz.txt', kind: 'added' }], reason: 'path_not_allowed' },
    { name: '보호 파일 이름 변경', changes: [{ path: 'AGENTS.md', kind: 'deleted' }, { path: 'docs/AGENTS-old.md', kind: 'added', content: '# 지침\n' }], reason: 'protected_path' },
    { name: 'mode만 변경한 목록 밖', changes: [{ path: 'package.json', kind: 'mode_changed', mode: '100755' }], reason: 'path_not_allowed' },
  ];
  for (const item of cases) {
    const { env, close } = await setup();
    try {
      const key = await env.approve(item.changes);
      const outcome = await env.publisher.publish(key);
      assert.deepEqual(outcome, { kind: 'blocked', reason: item.reason }, item.name);
      noWrites(env);
      const request = await phaseOf(env, key.changeId);
      assert.equal(request.phase, 'blocked');
      assert.equal(request.phaseReason, item.reason);
    } finally { await close(); }
  }
});

test('T19 B3 게시: 선행 읽기는 자격 없이 끝나고 토큰 발급은 그 뒤다', async () => {
  const { env, close } = await setup();
  try {
    const key = await env.approve();
    assert.equal((await env.publisher.publish(key)).kind, 'proposed');
    const firstToken = env.github.sent.findIndex(item => item.path.includes('access_tokens'));
    assert.ok(firstToken > 0);
    const before = env.github.sent.slice(0, firstToken);
    assert.ok(before.length >= 4, '선행 읽기가 있었다');
    assert.ok(before.every(item => item.method === 'GET' && item.authorization === ''));
    assert.ok(before.some(item => item.path.includes('/git/ref/heads/main')));
    assert.ok(before.some(item => /\/git\/trees\/[0-9a-f]{40}\?recursive=1/.test(item.path)));
    assert.ok(before.some(item => item.path.includes('/contents/.github/workflows/app-build.yaml?ref=app-build-v1.0.1')));
    // 첫 토큰은 첫 mutation을 위한 내용 토큰이다.
    assert.deepEqual(env.github.issued[0]!.permissions, { contents: 'write' });
    assert.match(env.github.sent[firstToken + 1]!.path, /git\/blobs$/);
  } finally { await close(); }
});

test('T19 B3 게시: 승인 뒤 정책·권한이 바뀌면 첫 blob 전에 닫힌다', async () => {
  const scenarios: { name: string; change: (env: PublishEnv) => void; expected: object }[] = [
    { name: '정책 철회', change: env => { env.policy.current = null; }, expected: { kind: 'blocked', reason: 'policy_revoked' } },
    { name: '정책 revision 변경', change: env => { env.policy.current = { ...env.policy.current!, revision: 'fixture-policy-2' }; }, expected: { kind: 'blocked', reason: 'policy_changed' } },
    { name: 'AC-P8 미확인', change: env => { env.policy.current = { ...env.policy.current!, writerAccepted: false }; }, expected: { kind: 'blocked', reason: 'writer_acceptance_missing' } },
    { name: 'base 정책 제거', change: env => { env.policy.current = { ...env.policy.current!, baseBranches: ['other'] }; }, expected: { kind: 'blocked', reason: 'base_branch_not_allowed' } },
    { name: '다른 저장소 정책', change: env => { env.policy.current = { ...env.policy.current!, repoId: REPO.id + 1 }; }, expected: { kind: 'blocked', reason: 'policy_revoked' } },
    { name: '필수 검증 추가', change: env => { env.policy.current = { ...env.policy.current!, requiredCommands: ['smoke-unit', 'other-check'] }; }, expected: { kind: 'blocked', reason: 'required_command_missing' } },
    { name: '신원 변경', change: env => { env.policy.current = { ...env.policy.current!, identity: { name: 'other[bot]', email: 'other[bot]@users.noreply.github.com' } }; }, expected: { kind: 'blocked', reason: 'identity_mismatch' } },
    { name: '내부 표식 추가로 공개 문구 차단', change: env => { env.policy.current = { ...env.policy.current!, internalMarkers: ['공개 목표'] }; }, expected: { kind: 'blocked', reason: 'internal_marker' } },
    { name: 'CI 승인값 변경', change: env => { env.policy.current = { ...env.policy.current!, ci: { ...env.policy.current!.ci, approvedFingerprint: 'e'.repeat(64) } }; }, expected: { kind: 'blocked', reason: 'ci_fingerprint_unapproved' } },
  ];
  for (const item of scenarios) {
    const { env, close } = await setup();
    try {
      const key = await env.approve();
      item.change(env);
      assert.deepEqual(await env.publisher.publish(key), item.expected, item.name);
      noWrites(env);
    } finally { await close(); }
  }
});

test('T19 B3 게시: 신뢰 base의 workflow나 reusable이 움직이면 닫힌다', async () => {
  const { env, close } = await setup();
  try {
    const key = await env.approve();
    env.github.pinned.set('fixture-org/fixture-platform/.github/workflows/app-build.yaml@app-build-v1.0.1', 'on:\n  workflow_call:\njobs: {}\n');
    assert.deepEqual(await env.publisher.publish(key), { kind: 'blocked', reason: 'ci_reusable_moved' });
    noWrites(env);
  } finally { await close(); }
  const second = await setup();
  try {
    const key = await second.env.approve();
    second.env.github.pinned.clear();
    assert.deepEqual(await second.env.publisher.publish(key), { kind: 'blocked', reason: 'ci_reusable_unreadable' });
    noWrites(second.env);
  } finally { await second.close(); }
});

test('T19 B3 게시: 신뢰 base의 tree·workflow를 입증하거나 읽지 못하면 첫 blob 전에 닫힌다', async () => {
  const scenarios: { name: string; arrange: (env: PublishEnv) => void; reason: string }[] = [
    { name: '잘린 tree를 입증 못 함', arrange: env => { const tree = env.base.tree; env.github.truncated.add(tree); env.github.truncated.add(`${tree}:flat`); }, reason: 'base_tree_incomplete' },
    { name: 'commit의 tree가 T0와 다름', arrange: env => { env.github.commits.set(env.base.sha, { tree: 'd'.repeat(40), parents: [] }); }, reason: 'base_tree_mismatch' },
    { name: 'T0를 읽을 수 없음', arrange: env => { env.github.trees.delete(env.base.tree); }, reason: 'base_tree_incomplete' },
    { name: 'commit을 읽을 수 없음', arrange: env => { env.github.commits.delete(env.base.sha); }, reason: 'base_tree_mismatch' },
    { name: '호출부 workflow를 읽을 수 없음', arrange: env => { env.github.blobs.delete(env.base.leaves.find(leaf => leaf.path === '.github/workflows/build.yaml')!.blobSha); }, reason: 'ci_unreadable' },
  ];
  for (const item of scenarios) {
    const { env, close } = await setup();
    try {
      const key = await env.approve();
      item.arrange(env);
      assert.deepEqual(await env.publisher.publish(key), { kind: 'blocked', reason: item.reason }, item.name);
      noWrites(env);
    } finally { await close(); }
  }
});

test('T19 B3 게시: 잘린 tree도 비재귀로 입증되면 게시한다', async () => {
  const { env, close } = await setup();
  try {
    const key = await env.approve();
    env.github.truncated.add(env.base.tree);
    assert.equal((await env.publisher.publish(key)).kind, 'proposed');
  } finally { await close(); }
});

test('T19 B3 최신성: 사람이 PR 제목·본문을 고쳐도 되돌리지 않고 PATCH가 없다', async () => {
  const { env, close } = await setup();
  try {
    const key = await env.approve();
    env.github.fail(/GET .*\/pulls\?state=all/, { status: 503 });
    assert.equal((await env.publisher.publish(key)).kind, 'deferred');
    env.github.pulls[0]!.title = '사람이 고친 제목';
    env.github.pulls[0]!.body = '사람이 고친 본문';
    assert.equal((await env.newPublisher().publish(key)).kind, 'proposed');
    assert.equal(env.github.pulls[0]!.title, '사람이 고친 제목');
    assert.equal(env.github.pulls[0]!.body, '사람이 고친 본문');
    assert.ok(env.github.sent.every(item => item.method === 'GET' || item.method === 'POST'));
  } finally { await close(); }
});

test('T19 B3 게시: 선행 읽기 일시 실패는 공개 효과 없이 미룬다', async () => {
  const { env, close } = await setup();
  try {
    const key = await env.approve();
    env.github.fail(/GET .*\/git\/ref\/heads\/main/, { status: 503 });
    const outcome = await env.publisher.publish(key);
    assert.equal(outcome.kind, 'deferred');
    noWrites(env);
    assert.equal((await phaseOf(env, key.changeId)).phase, 'approved');
    assert.equal((await env.publisher.publish(key)).kind, 'proposed');
  } finally { await close(); }
});

test('T19 B3 최신성: base가 첫 blob 전에 움직이면 superseded이고 새 generation은 새 브랜치에서 처음부터다', async () => {
  const { env, close } = await setup();
  try {
    const key = await env.approve();
    env.github.moveBase();
    assert.deepEqual(await env.publisher.publish(key), { kind: 'superseded', reason: 'base_moved' });
    noWrites(env);
    const request = await phaseOf(env, key.changeId);
    assert.equal(request.phase, 'superseded');
    assert.equal(ok(await env.store.approvalSubject(key)).subject.branch, branchOf(key));
    const failed = await env.store.checkLiveApproval({ ...key, subject: ok(await env.store.approvalSubject(key)).subject });
    assert.equal(failed.ok, false, '승인이 무효가 됐다');
    const next = await reapprove(env, key);
    assert.equal(next.generation, 2);
    assert.notEqual(branchOf(next), branchOf(key));
    assert.equal((await env.publisher.publish(next)).kind, 'proposed');
    assert.ok(env.github.refs.has(`heads/${branchOf(next)}`));
    assert.ok(!env.github.refs.has(`heads/${branchOf(key)}`));
  } finally { await close(); }
});

for (const stage of ['ref', 'pull'] as const) {
  test(`T19 B3 최신성: base가 ${stage} 직전에 움직이면 superseded이고 그 stage를 보내지 않는다`, async () => {
    const { env, close } = await setup();
    try {
      const key = await env.approve();
      // 앞 stage 응답 뒤, 다음 stage 재조회 전에 사람 commit이 들어온 상황이다.
      let moved = false;
      const realConfirm = env.store.confirmEffect.bind(env.store);
      env.store.confirmEffect = async input => {
        const result = await realConfirm(input);
        if (!moved && input.stage === (stage === 'ref' ? 'commit' : 'ref')) { moved = true; env.github.moveBase(); }
        return result;
      };
      assert.deepEqual(await env.publisher.publish(key), { kind: 'superseded', reason: 'base_moved' });
      assert.equal(moved, true);
      if (stage === 'ref') assert.equal(env.github.mutations(/git\/refs/).length, 0);
      assert.equal(env.github.mutations(/\/pulls$/).length, 0);
      assert.equal((await phaseOf(env, key.changeId)).phase, 'superseded');
      assert.deepEqual(await env.store.unresolvedEffects({ changeId: key.changeId }).then(rows => rows.filter(row => row.resolution === null)), []);
      assert.equal(env.github.count(/merges|update-branch|PATCH/), 0);
      assert.ok(env.github.sent.every(item => item.method === 'GET' || item.method === 'POST'));
    } finally { await close(); }
  });
}

test('T19 B3 최신성: PR 직후 base가 움직이면 검증 완료로 보고하지 않고 PR을 닫거나 덮지 않는다', async () => {
  const { env, close } = await setup();
  try {
    const key = await env.approve();
    const realConfirm = env.store.confirmEffect.bind(env.store);
    env.store.confirmEffect = async input => {
      const result = await realConfirm(input);
      if (input.stage === 'pull') env.github.moveBase();
      return result;
    };
    assert.deepEqual(await env.publisher.publish(key), { kind: 'blocked', reason: 'pull_stale_base' });
    assert.equal((await phaseOf(env, key.changeId)).phase, 'blocked');
    assert.equal(env.github.pulls[0]!.state, 'open');
    assert.ok(env.github.sent.every(item => item.method === 'GET' || item.method === 'POST'));
  } finally { await close(); }
});

test('T19 B3 최신성: PR 뒤 사후 검사를 미룬 사이 base가 움직여도 새 PR로 가지 않고 막는다', async () => {
  const { env, close } = await setup();
  try {
    const key = await env.approve();
    env.github.fail(/GET .*\/pulls\?state=all/, { status: 503 });
    const first = await env.publisher.publish(key);
    assert.equal(first.kind, 'deferred');
    assert.equal((await phaseOf(env, key.changeId)).phase, 'publishing');
    env.github.moveBase();
    assert.deepEqual(await env.newPublisher().publish(key), { kind: 'blocked', reason: 'pull_stale_base' });
    assert.equal(env.github.pulls.length, 1);
    assert.equal(env.github.mutations(/\/pulls$/).length, 1);
    assert.equal(env.github.mutations(/git\/blobs/).length, 2, '공개 검사와 stage를 되풀이하지 않는다');
  } finally { await close(); }
});

test('T19 B3 최신성: PR이 사후 검사 전에 닫혔거나 head가 바뀌면 검증 완료로 보고하지 않는다', async () => {
  for (const [name, arrange, reason] of [
    ['닫힘', (env: PublishEnv) => { env.github.pulls[0]!.state = 'closed'; }, 'pull_closed'],
    ['head 이동', (env: PublishEnv) => { env.github.pulls[0]!.head.sha = 'b'.repeat(40); }, 'head_changed'],
    ['사라짐', (env: PublishEnv) => { env.github.pulls.length = 0; }, 'pull_missing'],
  ] as const) {
    const { env, close } = await setup();
    try {
      const key = await env.approve();
      env.github.fail(/GET .*\/pulls\?state=all/, { status: 503 });
      assert.equal((await env.publisher.publish(key)).kind, 'deferred');
      arrange(env);
      assert.deepEqual(await env.newPublisher().publish(key), { kind: 'blocked', reason }, name);
    } finally { await close(); }
  }
});

test('T19 B3 최신성: ref 충돌. 사람이 만든 다른 head면 막고 내 head면 회수한다', async () => {
  const human = await setup();
  try {
    const key = await human.env.approve();
    human.env.github.refs.set(`heads/${branchOf(key)}`, 'a'.repeat(40));
    assert.deepEqual(await human.env.publisher.publish(key), { kind: 'blocked', reason: 'head_changed' });
    assert.equal(human.env.github.mutations().length, 0, '첫 blob 전에 잡는다');
    assert.equal(human.env.github.refs.get(`heads/${branchOf(key)}`), 'a'.repeat(40), '덮어쓰지 않는다');
  } finally { await human.close(); }
  const mine = await setup();
  try {
    const key = await mine.env.approve();
    // 자기 ref가 이미 있다(예: 응답 유실 뒤 DB까지 잃은 경우). 같은 H면 POST 없이 회수한다.
    const generation = ok(await mine.env.store.generationRecord(key));
    const { publication } = ok(await mine.env.store.approvalSubject(key)).subject;
    const expected = gitCommitSha({ treeSha: generation.resultTree!, parents: [generation.baseCommit], message: publication.commitMessage, author: publication.author, committer: publication.committer });
    mine.env.github.refs.set(`heads/${branchOf(key)}`, expected);
    assert.equal((await mine.env.publisher.publish(key)).kind, 'proposed');
    assert.equal(mine.env.github.mutations(/git\/refs/).length, 0);
  } finally { await mine.close(); }
});

test('T19 B3 최신성: 사람이 bot 브랜치에 commit을 올리면 PR 전에 막고 그 commit을 버리지 않는다', async () => {
  const { env, close } = await setup();
  try {
    const key = await env.approve();
    const realConfirm = env.store.confirmEffect.bind(env.store);
    env.store.confirmEffect = async input => {
      const result = await realConfirm(input);
      if (input.stage === 'ref') env.github.refs.set(`heads/${branchOf(key)}`, 'b'.repeat(40));
      return result;
    };
    assert.deepEqual(await env.publisher.publish(key), { kind: 'blocked', reason: 'head_changed' });
    assert.equal(env.github.mutations(/\/pulls$/).length, 0);
    assert.equal(env.github.refs.get(`heads/${branchOf(key)}`), 'b'.repeat(40));
  } finally { await close(); }
});

test('T19 B3 최신성: 응답의 tree·commit·head가 기대와 다르면 즉시 멈춘다', async () => {
  const { env, close } = await setup();
  try {
    const key = await env.approve();
    // 고정한 공개 문구와 다른 commit을 돌려주는 GitHub을 흉내 낸다(예: 서명이 붙어 SHA가 다른 경우).
    const real = env.writerIO.writer.createCommit;
    const publisher = new ChangePublisher({
      store: env.store, preflight: env.writerIO.preflight, policy: async () => env.policy.current, authorize: async () => {}, now: () => env.clock.now, retryMs: 60_000,
      writer: { ...env.writerIO.writer, createCommit: async input => {
        const outcome = await real(input);
        return outcome.kind === 'confirmed' ? { kind: 'confirmed', value: { ...outcome.value, commitSha: 'c'.repeat(40) } } : outcome;
      } },
    });
    assert.deepEqual(await publisher.publish(key), { kind: 'blocked', reason: 'result_mismatch' });
    assert.equal(env.github.mutations(/git\/refs/).length, 0, '다음 stage로 가지 않는다');
    assert.equal((await phaseOf(env, key.changeId)).phase, 'blocked');
  } finally { await close(); }
});

test('T19 B3 게시: 시험·승인·공개 본문이 어긋나면 게시하지 않는다', async () => {
  const { env, close } = await setup();
  try {
    const key = await env.approve();
    // 승인 대상 표를 직접 고치지 못하는 것은 B0 시험이 본다. 여기서는 승인 무효화 뒤의 재시도를 본다.
    ok(await env.store.invalidateEvidence({ ...key, from: 'approved', to: 'blocked', reason: 'content_changed' }));
    const before = env.github.sent.length;
    assert.deepEqual(await env.publisher.publish(key), { kind: 'stopped', phase: 'blocked' });
    assert.equal(env.github.sent.length, before);
    noWrites(env);
  } finally { await close(); }
});

test('T19 B3 게시: 토큰·JWT가 로그·DB·결과에 남지 않는다', async () => {
  const { env, close } = await setup();
  try {
    const key = await env.approve();
    const logs: string[] = [];
    const publisher = new ChangePublisher({ store: env.store, writer: env.writerIO.writer, preflight: env.writerIO.preflight, policy: async () => env.policy.current, authorize: async () => {}, now: () => env.clock.now,
      log: (event, detail) => logs.push(JSON.stringify({ event, detail })) });
    env.github.fail(/POST .*\/git\/refs$/, 'lose_response');
    const outcome = await publisher.publish(key);
    assert.equal(outcome.kind, 'proposed');
    const tables = ['change_delivery_effects', 'change_approval_subjects', 'change_requests', 'audit'];
    const stored = await Promise.all(tables.map(table => env.db.query(`SELECT * FROM ${table}`).then(result => JSON.stringify(result.rows))));
    const secrets = [...env.github.issued.map(item => item.token), ...env.github.sent.filter(item => item.path.includes('access_tokens')).map(item => item.authorization.replace('Bearer ', ''))];
    assert.ok(secrets.length >= 4);
    for (const secret of secrets) {
      for (const text of [...stored, ...logs, JSON.stringify(outcome)]) assert.ok(!text.includes(secret));
    }
  } finally { await close(); }
});

test('T19 B3 승인 준비: 승인되지 않은 CI는 승인 대상을 만들지 않고 fingerprint만 로그에 남긴다', async () => {
  const { env, close } = await setup();
  try {
    const key = await env.newRequest();
    const review = await env.driveToReview(key, [{ path: 'src/a.ts', kind: 'modified', content: '수정\n' }]);
    env.policy.current = { ...env.policy.current!, ci: { ...env.policy.current!.ci, approvedFingerprint: 'e'.repeat(64) } };
    const logs: { event: string; detail?: Record<string, unknown> }[] = [];
    const publisher = new ChangePublisher({ store: env.store, writer: env.writerIO.writer, preflight: env.writerIO.preflight, policy: async () => env.policy.current, authorize: async () => {}, now: () => env.clock.now, log: (event, detail) => logs.push({ event, ...(detail ? { detail } : {}) }) });
    assert.deepEqual(await publisher.prepareApproval(key, { review, at: Date.UTC(2026, 0, 2) }), { ok: false, reason: 'ci_fingerprint_unapproved' });
    assert.equal((await phaseOf(env, key.changeId)).phase, 'reviewing');
    assert.match(String(logs.find(item => item.event === 'change_ci_fingerprint_unapproved')?.detail?.fingerprint), /^[0-9a-f]{64}$/);
    noWrites(env);
  } finally { await close(); }
});

test('T19 B3 게시: repository 정책 스키마가 빈 목록과 잘못된 값을 거부한다', () => {
  assert.throws(() => repositoryPolicy({ allowedPaths: [] }));
  assert.throws(() => repositoryPolicy({ allowedPaths: ['**'] }));
  assert.throws(() => repositoryPolicy({ baseBranches: [] }));
  assert.throws(() => repositoryPolicy({ requiredCommands: [] }));
  assert.throws(() => repositoryPolicy({ internalMarkers: ['abc'] }), '너무 짧은 표식은 오탐과 무력화를 부른다');
  assert.throws(() => repositoryPolicy({ writerBotUserId: 0 }));
});
