import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EFFECT_LEASE_MS, UNKNOWN_RECONCILE_MS } from '../src/change-contracts.js';
import type { ChangeKey, EffectStage } from '../src/change-contracts.js';
import { ChangePublisher } from '../src/change-publisher.js';
import { ok } from './change-store-fixture.js';
import { BOT_USER, REPO, branchOf, publishEnv } from './change-github-fake.js';
import type { FaultMode, PublishEnv } from './change-github-fake.js';
import { localDatabase } from './helpers.js';

// EVENT-02: 유실 지점별 복구. 재시작은 새 ChangePublisher로 흉내 낸다. 프로세스 상태는 없고 DB만 남는다.
async function setup() {
  const { db, pg } = await localDatabase();
  const env = await publishEnv(db);
  return { env, db, close: () => pg.close() };
}
const ROUTES: Record<EffectStage, RegExp> = {
  blob: /POST .*\/git\/blobs$/, tree: /POST .*\/git\/trees$/, commit: /POST .*\/git\/commits$/, ref: /POST .*\/git\/refs$/, pull: /POST .*\/pulls$/,
};
const STAGES: EffectStage[] = ['blob', 'tree', 'commit', 'ref', 'pull'];
const effect = async (env: PublishEnv, key: ChangeKey, stage: EffectStage) => (await env.store.unresolvedEffects({ changeId: key.changeId })).find(row => row.stage === stage);
const posts = (env: PublishEnv, stage: EffectStage) => env.github.count(ROUTES[stage]);

for (const stage of STAGES) {
  test(`T19 B3 복구: ${stage} 응답 유실 뒤 대조로 회수하고 재전송·중복이 없다`, async () => {
    const { env, close } = await setup();
    try {
      const key = await env.approve();
      env.github.fail(ROUTES[stage], 'lose_response');
      const first = await env.publisher.publish(key);
      if (stage === 'pull') assert.equal(first.kind, 'proposed', '같은 호출 안의 대조로 회수한다');
      else assert.equal(first.kind, 'proposed', JSON.stringify(first));
      const counts = STAGES.map(item => posts(env, item));
      assert.equal(env.github.pulls.length, 1);
      assert.equal(ok(await env.store.get(key.changeId)).phase, 'proposed');
      assert.deepEqual(counts.slice(1), [1, 1, 1, 1]);
    } finally { await close(); }
  });
  test(`T19 B3 복구: ${stage} 전송 뒤 응답도 객체도 없으면 unknown으로 남고 다시 보내지 않으며 24시간 뒤 사람 해소로 넘어간다`, async () => {
    const { env, close } = await setup();
    try {
      const key = await env.approve();
      env.github.fail(ROUTES[stage], 'reset_before_apply');
      const outcome = await env.publisher.publish(key);
      assert.deepEqual(outcome, { kind: 'unknown', stage });
      const sent = posts(env, stage);
      const row = await effect(env, key, stage);
      assert.equal(row?.state, 'unknown');
      assert.equal(row?.failureCode, 'response_lost');
      // 재시작해도 unknown을 지우고 새로 보내지 않는다.
      for (let i = 0; i < 3; i++) assert.deepEqual(await env.newPublisher().publish(key), { kind: 'unknown', stage });
      assert.equal(posts(env, stage), sent);
      if (stage !== 'pull') assert.equal(posts(env, STAGES[STAGES.indexOf(stage) + 1]!), 0, '다음 stage로 가지 않는다');
      env.clock.now += UNKNOWN_RECONCILE_MS + 1;
      const report = await env.newPublisher().reconcile();
      assert.deepEqual(report.blocked, [{ ...key, stage }]);
      const blocked = await effect(env, key, stage);
      assert.equal(blocked?.state, 'blocked');
      assert.equal(blocked?.blockedReason, 'unknown_deadline');
      assert.equal(ok(await env.store.get(key.changeId)).phase, 'blocked');
      assert.equal(posts(env, stage), sent);
      // 사람 해소 뒤에도 행은 남고 새 게시는 열리지 않는다.
      ok(await env.store.resolveBlockedEffect({ ...key, stage, actor: 'fixture-owner', resolution: 'not_published' }));
      assert.deepEqual(await env.newPublisher().publish(key), { kind: 'stopped', phase: 'blocked' });
      assert.equal(posts(env, stage), sent);
    } finally { await close(); }
  });
  test(`T19 B3 복구: ${stage} 응답을 받은 뒤 DB 기록이 실패해도 재시작 뒤 같은 결과를 회수한다`, async () => {
    const { env, close } = await setup();
    try {
      const key = await env.approve();
      const real = env.store.confirmEffect.bind(env.store);
      let armed = true;
      env.store.confirmEffect = async input => {
        if (armed && input.stage === stage) { armed = false; throw new Error('db_down'); }
        return real(input);
      };
      await assert.rejects(env.publisher.publish(key), /db_down/);
      const sent = posts(env, stage);
      assert.equal((await effect(env, key, stage))?.state, 'sending');
      // 임대가 살아 있으면 다른 게시자가 끼어들지 않는다.
      assert.deepEqual(await env.newPublisher().publish(key), { kind: 'busy' });
      env.clock.now += EFFECT_LEASE_MS + 1;
      const outcome = await env.newPublisher().publish(key);
      assert.equal(outcome.kind, 'proposed', JSON.stringify(outcome));
      assert.equal(posts(env, stage), sent, '다시 보내지 않고 회수한다');
      assert.equal(env.github.pulls.length, 1);
    } finally { await close(); }
  });
  test(`T19 B3 복구: ${stage} 연결 전 실패는 안전하게 미룬 뒤 재시도한다`, async () => {
    const { env, close } = await setup();
    try {
      const key = await env.approve();
      env.github.fail(ROUTES[stage], 'refused');
      const first = await env.publisher.publish(key);
      assert.equal(first.kind, 'deferred');
      assert.equal(first.kind === 'deferred' && first.retryAt, env.clock.now + 60_000);
      assert.equal((await effect(env, key, stage))?.state, 'pending');
      const early = await env.newPublisher().publish(key);
      assert.equal(early.kind, 'deferred', '기한 전에는 보내지 않는다');
      env.clock.now += 60_000;
      assert.equal((await env.newPublisher().publish(key)).kind, 'proposed');
      assert.equal(env.github.pulls.length, 1);
    } finally { await close(); }
  });
  test(`T19 B3 복구: ${stage} 4xx 거부는 그 자리에서 사람 해소로 닫는다`, async () => {
    if (stage === 'ref' || stage === 'pull') return; // 422 회수 시험이 따로 있다.
    const { env, close } = await setup();
    try {
      const key = await env.approve();
      env.github.fail(ROUTES[stage], { status: 403 });
      assert.deepEqual(await env.publisher.publish(key), { kind: 'blocked', reason: 'http_403' });
      assert.equal(ok(await env.store.get(key.changeId)).phase, 'blocked');
      assert.equal(posts(env, stage), 1);
    } finally { await close(); }
  });
}

test('T19 B3 복구: 앞선 대조를 지난 뒤 unknown이 생겨도 그 stage를 보내지 않는다', async () => {
  const { env, close } = await setup();
  try {
    const key = await env.approve();
    env.github.fail(ROUTES.tree, 'reset_before_apply');
    assert.deepEqual(await env.publisher.publish(key), { kind: 'unknown', stage: 'tree' });
    // 대조 시점에는 없었고 stage 직전에 다른 게시자의 임대 만료로 unknown이 된 경합을 흉내 낸다.
    const real = env.store.unresolvedEffects.bind(env.store);
    let first = true;
    env.store.unresolvedEffects = async input => {
      if (first) { first = false; return []; }
      return real(input);
    };
    assert.deepEqual(await env.newPublisher().publish(key), { kind: 'unknown', stage: 'tree' });
    assert.equal(posts(env, 'tree'), 1);
    assert.equal(posts(env, 'commit'), 0);
  } finally { await close(); }
});

test('T19 B3 복구: 미전송 재시도는 간격을 늘리고 횟수를 넘으면 사람 해소로 닫는다', async () => {
  const { env, close } = await setup();
  try {
    const key = await env.approve();
    env.github.fail(ROUTES.tree, 'refused', 100);
    const waits: number[] = [];
    let last = await env.publisher.publish(key);
    for (let i = 0; i < 20 && last.kind === 'deferred'; i++) {
      waits.push(last.retryAt - env.clock.now);
      env.clock.now = last.retryAt;
      last = await env.newPublisher().publish(key);
    }
    assert.deepEqual(last, { kind: 'blocked', reason: 'send_attempts_exhausted' });
    assert.deepEqual(waits, [60_000, 120_000, 240_000, 480_000, 960_000, 1_920_000, 3_600_000]);
    assert.equal(posts(env, 'tree'), 8);
    assert.equal(posts(env, 'commit'), 0);
  } finally { await close(); }
});

test('T19 B3 복구: 재시도해도 소용없는 미전송은 바로 닫는다(토큰 권한·저장소 불일치)', async () => {
  for (const [name, response, reason] of [
    ['권한 불일치', (now: number) => new Response(JSON.stringify({ token: 'ghs_fixtureX', expires_at: new Date(now + 3_600_000).toISOString(), permissions: { contents: 'write', actions: 'write' }, repositories: [{ id: REPO.id, full_name: REPO.fullName }] }), { status: 201 }), 'token_permission_mismatch'],
    ['저장소 불일치', (now: number) => new Response(JSON.stringify({ token: 'ghs_fixtureX', expires_at: new Date(now + 3_600_000).toISOString(), permissions: { contents: 'write' }, repositories: [{ id: 1, full_name: 'other/repo' }] }), { status: 201 }), 'token_repository_mismatch'],
    ['설치 철회', () => new Response('{}', { status: 404 }), 'token_http_404'],
  ] as const) {
    const { env, close } = await setup();
    try {
      const key = await env.approve();
      env.github.tokenOverride = () => response(env.clock.now);
      assert.deepEqual(await env.publisher.publish(key), { kind: 'blocked', reason }, name);
      assert.equal(env.github.mutations().length, 0, name);
      assert.equal(ok(await env.store.get(key.changeId)).phase, 'blocked', name);
    } finally { await close(); }
  }
  // 발급 서버의 일시 오류는 미룬다.
  const { env, close } = await setup();
  try {
    const key = await env.approve();
    env.github.tokenOverride = () => new Response('{}', { status: 503 });
    assert.equal((await env.publisher.publish(key)).kind, 'deferred');
    env.github.tokenOverride = undefined;
    env.clock.now += 60_000;
    assert.equal((await env.newPublisher().publish(key)).kind, 'proposed');
  } finally { await close(); }
});

test('T19 B3 복구: DB 잠금 시한 초과(busy)를 막힘·교체로 오판하지 않는다', async () => {
  const busy = { ok: false as const, reason: 'busy' as const };
  // 확정 기록이 busy면 전송은 성공한 상태다. 막지 않고 임대 만료 뒤 대조로 회수한다.
  const confirm = await setup();
  try {
    const key = await confirm.env.approve();
    const real = confirm.env.store.confirmEffect.bind(confirm.env.store);
    let armed = true;
    confirm.env.store.confirmEffect = async input => {
      if (armed && input.stage === 'tree') { armed = false; return busy; }
      return real(input);
    };
    assert.deepEqual(await confirm.env.publisher.publish(key), { kind: 'busy' });
    assert.equal(ok(await confirm.env.store.get(key.changeId)).phase, 'publishing');
    confirm.env.clock.now += EFFECT_LEASE_MS + 1;
    assert.equal((await confirm.env.newPublisher().publish(key)).kind, 'proposed');
    assert.equal(posts(confirm.env, 'tree'), 1);
  } finally { await confirm.close(); }
  // 무효화 기록이 busy면 아직 닫히지 않았다. superseded라고 보고하지 않는다.
  const invalidate = await setup();
  try {
    const key = await invalidate.env.approve();
    invalidate.env.github.moveBase();
    const real = invalidate.env.store.invalidateEvidence.bind(invalidate.env.store);
    invalidate.env.store.invalidateEvidence = async () => busy;
    assert.deepEqual(await invalidate.env.publisher.publish(key), { kind: 'busy' });
    assert.equal(ok(await invalidate.env.store.get(key.changeId)).phase, 'approved');
    invalidate.env.store.invalidateEvidence = real;
    assert.deepEqual(await invalidate.env.publisher.publish(key), { kind: 'superseded', reason: 'base_moved' });
  } finally { await invalidate.close(); }
  // intent·claim·전이가 busy여도 change를 막지 않고 공개 효과도 없다.
  for (const method of ['recordEffectIntent', 'claimEffect', 'transition'] as const) {
    const s = await setup();
    try {
      const key = await s.env.approve();
      const store = s.env.store as unknown as Record<string, (input: unknown) => Promise<unknown>>;
      const real = store[method]!.bind(s.env.store);
      store[method] = async () => busy;
      assert.deepEqual(await s.env.publisher.publish(key), { kind: 'busy' }, method);
      assert.equal(s.env.github.mutations().length, 0, method);
      assert.equal(ok(await s.env.store.get(key.changeId)).phase === 'blocked', false, method);
      store[method] = real;
      assert.equal((await s.env.newPublisher().publish(key)).kind, 'proposed', method);
    } finally { await s.close(); }
  }
});

test('T19 B3 복구: 게시 시작 직후 전송 전에 프로세스가 죽으면 보수적으로 unknown이다', async () => {
  const { env, close } = await setup();
  try {
    const key = await env.approve();
    // claim 커밋 뒤 전송 직전 죽은 상황: lease만 남는다.
    const real = env.store.claimEffect.bind(env.store);
    env.store.claimEffect = async input => {
      const claim = await real(input);
      if (input.stage === 'tree') throw new Error('process_killed');
      return claim;
    };
    await assert.rejects(env.publisher.publish(key), /process_killed/);
    env.store.claimEffect = real;
    env.clock.now += EFFECT_LEASE_MS + 1;
    const report = await env.newPublisher().reconcile();
    assert.deepEqual(report.stillUnknown, [{ ...key, stage: 'tree' }]);
    assert.equal(posts(env, 'tree'), 0);
    assert.deepEqual(await env.newPublisher().publish(key), { kind: 'unknown', stage: 'tree' });
    assert.equal(posts(env, 'tree'), 0, '보냈는지 모르면 보내지 않는다');
  } finally { await close(); }
});

test('T19 B3 복구: intent만 기록하고 죽으면(전송 안 함) 재시작이 같은 digest로 이어 간다', async () => {
  const { env, close } = await setup();
  try {
    const key = await env.approve();
    const real = env.store.claimEffect.bind(env.store);
    env.store.claimEffect = async input => {
      if (input.stage === 'commit') throw new Error('process_killed');
      return real(input);
    };
    await assert.rejects(env.publisher.publish(key), /process_killed/);
    env.store.claimEffect = real;
    assert.equal((await effect(env, key, 'commit'))?.state, 'pending');
    assert.equal((await env.newPublisher().publish(key)).kind, 'proposed');
    assert.equal(posts(env, 'commit'), 1);
    assert.equal(posts(env, 'tree'), 1);
  } finally { await close(); }
});

test('T19 B3 복구: 시간이 지나 재시작해도 commit SHA가 그대로다(현재 시각을 쓰지 않는다)', async () => {
  const { env, close } = await setup();
  try {
    const key = await env.approve();
    env.github.fail(ROUTES.commit, 'refused');
    await env.publisher.publish(key);
    const expected = (await effect(env, key, 'commit'))!.expected;
    env.clock.now += 3 * 86_400_000;
    assert.equal((await env.newPublisher().publish(key)).kind, 'proposed');
    assert.equal(env.github.refs.get(`heads/${branchOf(key)}`), expected.stage === 'commit' ? expected.commitSha : '');
  } finally { await close(); }
});

test('T19 B3 복구: 임대 만료 뒤 reconcile이 객체를 찾아 확정하고 publish가 이어 간다', async () => {
  const { env, close } = await setup();
  try {
    const key = await env.approve();
    const real = env.store.confirmEffect.bind(env.store);
    env.store.confirmEffect = async input => {
      if (input.stage === 'commit') throw new Error('crash');
      return real(input);
    };
    await assert.rejects(env.publisher.publish(key), /crash/);
    env.store.confirmEffect = real;
    env.clock.now += EFFECT_LEASE_MS + 1;
    const report = await env.newPublisher().reconcile();
    assert.deepEqual(report.confirmed, [{ ...key, stage: 'commit' }]);
    assert.deepEqual(report.stillUnknown, []);
    assert.equal(report.resumed.length, 1);
    assert.equal(report.resumed[0]!.outcome.kind, 'proposed');
    assert.equal(posts(env, 'commit'), 1);
  } finally { await close(); }
});

test('T19 B3 복구: reconcile은 승인 뒤 시작 못 한 건도 이어 가고 끝난 건을 건드리지 않는다', async () => {
  const { env, close } = await setup();
  try {
    const key = await env.approve();
    const done = await env.approve();
    assert.equal((await env.publisher.publish(done)).kind, 'proposed');
    const before = env.github.pulls.length;
    const report = await env.newPublisher().reconcile();
    assert.deepEqual(report.resumed.map(item => item.key.changeId), [key.changeId]);
    assert.equal(report.resumed[0]!.outcome.kind, 'proposed');
    assert.equal(env.github.pulls.length, before + 1);
  } finally { await close(); }
});

test('T19 B3 복구: ref 응답이 422이면 정확한 ref를 읽어 내 H면 회수하고 다르면 막는다', async () => {
  const mine = await setup();
  try {
    const key = await mine.env.approve();
    // 전송 직전 대조로는 안 보였지만 그사이 내 ref가 생겨 POST가 422를 받은 상황이다.
    mine.env.github.fail(ROUTES.ref, { status: 422 });
    const readHead = mine.env.writerIO.writer.readBranchHead;
    let branchReads = 0;
    const writer = { ...mine.env.writerIO.writer, readBranchHead: async (input: Parameters<typeof readHead>[0]) => {
      if (input.branch === branchOf(key) && ++branchReads <= 2) return null;
      return readHead(input);
    } };
    const publisher = new ChangePublisher({ store: mine.env.store, writer, preflight: mine.env.writerIO.preflight, policy: async () => mine.env.policy.current, now: () => mine.env.clock.now, retryMs: 60_000 });
    const claim = mine.env.store.claimEffect.bind(mine.env.store);
    mine.env.store.claimEffect = async input => {
      const claimed = await claim(input);
      if (input.stage === 'ref' && claimed.ok && claimed.value.expected.stage === 'ref') mine.env.github.refs.set(`heads/${branchOf(key)}`, claimed.value.expected.sha);
      return claimed;
    };
    assert.equal((await publisher.publish(key)).kind, 'proposed');
    assert.equal(posts(mine.env, 'ref'), 1);
  } finally { await mine.close(); }
  const other = await setup();
  try {
    const key = await other.env.approve();
    other.env.github.fail(ROUTES.ref, { status: 422 });
    const claim = other.env.store.claimEffect.bind(other.env.store);
    other.env.store.claimEffect = async input => {
      const claimed = await claim(input);
      if (input.stage === 'ref') other.env.github.refs.set(`heads/${branchOf(key)}`, 'a'.repeat(40));
      return claimed;
    };
    assert.deepEqual(await other.env.publisher.publish(key), { kind: 'blocked', reason: 'head_changed' });
    assert.equal(other.env.github.refs.get(`heads/${branchOf(key)}`), 'a'.repeat(40));
  } finally { await other.close(); }
  const empty = await setup();
  try {
    const key = await empty.env.approve();
    empty.env.github.fail(ROUTES.ref, { status: 422 });
    assert.deepEqual(await empty.env.publisher.publish(key), { kind: 'blocked', reason: 'http_422' }, '정확한 ref가 없으면 회수하지 않는다');
  } finally { await empty.close(); }
});

async function pullScenario(arrange: (env: PublishEnv, key: ChangeKey, branch: string) => void, mode: FaultMode = 'reset_before_apply') {
  const s = await setup();
  const key = await s.env.approve();
  s.env.github.fail(ROUTES.pull, mode);
  const claim = s.env.store.claimEffect.bind(s.env.store);
  s.env.store.claimEffect = async input => {
    const claimed = await claim(input);
    if (input.stage === 'pull') arrange(s.env, key, branchOf(key));
    return claimed;
  };
  return { ...s, key };
}
const publicationOf = async (env: PublishEnv, key: ChangeKey) => ok(await env.store.approvalSubject(key)).subject.publication;

test('T19 B3 복구: PR 응답 유실 후보가 하나이고 모든 값이 맞으면 회수한다', async () => {
  const s = await setup();
  try {
    const key = await s.env.approve();
    s.env.github.fail(ROUTES.pull, 'lose_response');
    const outcome = await s.env.publisher.publish(key);
    assert.equal(outcome.kind, 'proposed');
    assert.equal(s.env.github.pulls.length, 1);
    assert.equal(posts(s.env, 'pull'), 1);
    const list = s.env.github.sent.find(item => item.path.includes('state=all'))!;
    assert.match(list.path, new RegExp(`head=fixture-org:${branchOf(key)}&base=main`));
  } finally { await s.close(); }
});

test('T19 B3 복구: PR 대조는 marker만 믿지 않는다. 값이 어긋나면 막고 다시 만들지 않는다', async () => {
  const headFor = (env: PublishEnv, branch: string) => ({ ref: branch, sha: env.github.refs.get(`heads/${branch}`)!, repo: { id: REPO.id } });
  const mismatches: Record<string, (env: PublishEnv, branch: string, publication: Awaited<ReturnType<typeof publicationOf>>) => void> = {
    '다른 작성자': (env, branch, publication) => { env.github.addPull({ title: publication.title, body: publication.body, user: { id: BOT_USER + 1 }, head: headFor(env, branch), base: { ref: 'main', repo: { id: REPO.id } } }); },
    '다른 제목': (env, branch, publication) => { env.github.addPull({ title: '사람이 고친 제목', body: publication.body, head: headFor(env, branch), base: { ref: 'main', repo: { id: REPO.id } } }); },
    '다른 본문(marker 유지)': (env, branch, publication) => { env.github.addPull({ title: publication.title, body: `${publication.body}\n추가`, head: headFor(env, branch), base: { ref: 'main', repo: { id: REPO.id } } }); },
    'marker 없는 본문': (env, branch, publication) => { env.github.addPull({ title: publication.title, body: '본문', head: headFor(env, branch), base: { ref: 'main', repo: { id: REPO.id } } }); },
    '다른 head SHA': (env, branch, publication) => { env.github.addPull({ title: publication.title, body: publication.body, head: { ...headFor(env, branch), sha: 'a'.repeat(40) }, base: { ref: 'main', repo: { id: REPO.id } } }); },
  };
  for (const [name, arrange] of Object.entries(mismatches)) {
    const s = await pullScenario(() => {});
    try {
      const claim = s.env.store.claimEffect.bind(s.env.store);
      const publication = await publicationOf(s.env, s.key);
      s.env.store.claimEffect = async input => {
        const claimed = await claim(input);
        if (input.stage === 'pull') arrange(s.env, branchOf(s.key), publication);
        return claimed;
      };
      assert.deepEqual(await s.env.publisher.publish(s.key), { kind: 'blocked', reason: 'pull_mismatch' }, name);
      assert.equal(s.env.github.pulls.length, 1, name);
      assert.equal(posts(s.env, 'pull'), 1, name);
    } finally { await s.close(); }
  }
});

test('T19 B3 복구: PR 후보가 여럿이면 고르지 않고 unknown으로 남긴다', async () => {
  const s = await pullScenario((env, _key, branch) => {
    for (let i = 0; i < 2; i++) env.github.addPull({ title: 't', body: 'b', head: { ref: branch, sha: env.github.refs.get(`heads/${branch}`)!, repo: { id: REPO.id } }, base: { ref: 'main', repo: { id: REPO.id } } });
  });
  try {
    assert.deepEqual(await s.env.publisher.publish(s.key), { kind: 'unknown', stage: 'pull' });
    assert.equal((await effect(s.env, s.key, 'pull'))?.state, 'unknown');
    assert.equal(posts(s.env, 'pull'), 1);
  } finally { await s.close(); }
});

test('T19 B3 복구: PR POST가 422여도 대조만 하고 다시 보내지 않는다', async () => {
  const s = await pullScenario((env, key, branch) => {
    void key;
    env.github.addPull({ title: '사람 PR', body: '사람 본문', user: { id: BOT_USER + 5 }, head: { ref: branch, sha: env.github.refs.get(`heads/${branch}`)!, repo: { id: REPO.id } }, base: { ref: 'main', repo: { id: REPO.id } } });
  }, { status: 422 });
  try {
    assert.deepEqual(await s.env.publisher.publish(s.key), { kind: 'blocked', reason: 'pull_mismatch' });
    assert.equal(posts(s.env, 'pull'), 1);
  } finally { await s.close(); }
  const none = await pullScenario(() => {}, { status: 422 });
  try {
    assert.deepEqual(await none.env.publisher.publish(none.key), { kind: 'blocked', reason: 'http_422' });
  } finally { await none.close(); }
  // 이미 있는 PR이 저장한 공개 문구까지 정확히 같으면 내 PR이다. 값은 claim 시점에 읽어 넣는다.
  const same = await setup();
  try {
    const key = await same.env.approve();
    const publication = await publicationOf(same.env, key);
    same.env.github.fail(ROUTES.pull, { status: 422 });
    const claim = same.env.store.claimEffect.bind(same.env.store);
    same.env.store.claimEffect = async input => {
      const claimed = await claim(input);
      if (input.stage === 'pull') same.env.github.addPull({ title: publication.title, body: publication.body, head: { ref: branchOf(key), sha: same.env.github.refs.get(`heads/${branchOf(key)}`)!, repo: { id: REPO.id } }, base: { ref: 'main', repo: { id: REPO.id } } });
      return claimed;
    };
    assert.equal((await same.env.publisher.publish(key)).kind, 'proposed');
    assert.equal(posts(same.env, 'pull'), 1);
  } finally { await same.close(); }
});

test('T19 B3 복구: 대조 중 정책이 철회되면 읽지 못하고 unknown으로 남아 기한 뒤 막힌다', async () => {
  const { env, close } = await setup();
  try {
    const key = await env.approve();
    env.github.fail(ROUTES.tree, 'reset_before_apply');
    assert.deepEqual(await env.publisher.publish(key), { kind: 'unknown', stage: 'tree' });
    env.policy.current = null;
    const report = await env.newPublisher().reconcile();
    assert.deepEqual(report.stillUnknown, [{ ...key, stage: 'tree' }]);
    assert.equal(posts(env, 'tree'), 1);
    env.clock.now += UNKNOWN_RECONCILE_MS + 1;
    await env.newPublisher().reconcile();
    assert.equal((await effect(env, key, 'tree'))?.state, 'blocked');
  } finally { await close(); }
});

test('T19 B3 복구: 취소 뒤 새 effect를 시작하지 않고 이미 공개된 객체는 기록만 남긴다', async () => {
  const { env, close } = await setup();
  try {
    const key = await env.approve();
    env.github.fail(ROUTES.commit, 'refused');
    assert.equal((await env.publisher.publish(key)).kind, 'deferred');
    ok(await env.store.transition({ ...key, from: 'publishing', to: 'cancelled', reason: 'user_cancelled' }));
    env.clock.now += 60_000;
    const before = env.github.mutations().length;
    assert.deepEqual(await env.newPublisher().publish(key), { kind: 'stopped', phase: 'cancelled' });
    assert.equal(env.github.mutations().length, before);
    assert.equal(posts(env, 'blob'), 2, '공개된 blob은 그대로다');
  } finally { await close(); }
});

test('T19 B3 복구: 전송 중 취소되면 다음 stage로 가지 않고 응답은 기록한다', async () => {
  const { env, close } = await setup();
  try {
    const key = await env.approve();
    const real = env.store.claimEffect.bind(env.store);
    env.store.claimEffect = async input => {
      const claimed = await real(input);
      if (input.stage === 'tree') ok(await env.store.transition({ ...key, from: 'publishing', to: 'cancelled', reason: 'user_cancelled' }));
      return claimed;
    };
    const outcome = await env.publisher.publish(key);
    assert.deepEqual(outcome, { kind: 'stopped', phase: 'cancelled' });
    assert.equal(posts(env, 'tree'), 1);
    assert.equal(posts(env, 'commit'), 0);
  } finally { await close(); }
});

test('T19 B3 복구: 다른 generation의 미해소 effect가 있으면 새 게시를 시작하지 않는다', async () => {
  const { env, close } = await setup();
  try {
    const key = await env.approve();
    env.github.fail(ROUTES.blob, 'reset_before_apply');
    assert.deepEqual(await env.publisher.publish(key), { kind: 'unknown', stage: 'blob' });
    ok(await env.store.invalidateEvidence({ ...key, from: 'publishing', to: 'superseded', reason: 'base_moved' }));
    const next = await env.store.startNextGeneration(key);
    assert.equal(next.ok, false, '옛 unknown을 지우고 넘어가는 길이 없다');
    assert.equal(!next.ok && next.reason, 'unresolved_effects');
  } finally { await close(); }
});

test('T19 B3 복구: 긴 전송 중에는 임대를 갱신한다', async () => {
  const { env, close } = await setup();
  try {
    const key = await env.approve();
    let renewals = 0;
    const real = env.store.renewEffectLease.bind(env.store);
    env.store.renewEffectLease = async input => { renewals++; return real(input); };
    const publisher = new ChangePublisher({
      store: env.store, preflight: env.writerIO.preflight, policy: async () => env.policy.current, now: () => env.clock.now, retryMs: 60_000, leaseRenewMs: 5,
      writer: { ...env.writerIO.writer, createBlobs: async input => {
        await new Promise(resolve => setTimeout(resolve, 40));
        return env.writerIO.writer.createBlobs(input);
      } },
    });
    assert.equal((await publisher.publish(key)).kind, 'proposed');
    assert.ok(renewals >= 1, String(renewals));
  } finally { await close(); }
});
