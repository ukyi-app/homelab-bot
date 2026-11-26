import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import { PGlite } from '@electric-sql/pglite';
import { newChangeBranchName, newChangeId } from '../src/change-contracts.js';
import type { ChangeKey, PublicMetadata } from '../src/change-contracts.js';
import { ChangeGuidance, guidanceKey, recordChangeNotes } from '../src/change-guidance.js';
import type { ChangeNotes } from '../src/change-guidance.js';
import { ChangePublisher } from '../src/change-publisher.js';
import { ChangeRuntime } from '../src/change-runtime.js';
import type { ChangeRuntimeDeps } from '../src/change-runtime.js';
import type { ChangeStore } from '../src/change-store.js';
import { PublicReceipts, changeTraceId, publicTraceId, publicationMarker, renderPublication, scanPublicPayload } from '../src/change-publication.js';
import { MIGRATIONS } from '../src/database.js';
import type { Database } from '../src/database.js';
import { createGitHubWriter } from '../src/github-writer.js';
import { guidanceMarker } from '../src/github-review-io.js';
import { DEFAULT_CHANGES, FAKE_APP_KEY, FIXTURE_TIME, FakeGitHub, REPO, publishEnv } from './change-github-fake.js';
import type { FileChange, PublishEnv } from './change-github-fake.js';
import { OWNER, fixtureBrief, fixtureBundle, newEvent, ok, pinnedBranch, seedConversation } from './change-store-fixture.js';
import { localDatabase } from './helpers.js';

// D-122: 새 변경 브랜치 이름은 무작위 추적 ID 꼴(bot/change/c<24 hex>)이고, 옛 꼴(bot/change/<change ID>/g<세대>)은 찾기·읽기만 한다.
const TRACE = /^bot\/change\/c[0-9a-f]{24}$/;
// change ID와 그 앞부분. 공개 바이트 어디에도 나오면 안 된다.
const pieces = (changeId: string) => [32, 24, 16, 12, 8].map(length => changeId.slice(0, length));

async function rawDatabase(upTo: number): Promise<{ pg: PGlite; db: Database }> {
  const pg = new PGlite();
  const db: Database = { query: async <T>(sql: string, params: unknown[] = []) => pg.query<T>(sql, params), transaction: () => { throw new Error('unused'); } };
  for (const file of MIGRATIONS.filter(name => Number.parseInt(name.slice(0, 3), 10) <= upTo)) await pg.exec(await readFile(`migrations/${file}`, 'utf8'));
  return { pg, db };
}
async function insertRequest(db: Database, id: string) {
  await db.query(`INSERT INTO change_requests(id,event_id,owner_id,conversation_id,scope,repo_id,base_branch,label,created_at,updated_at)
    VALUES ($1,$2,'fixture-owner','fixture-conversation','{}'::jsonb,4242,'main','public',1,1)`, [id, `event-${id}`]);
}
const insertGeneration = (db: Database, id: string, generation: number, branch: string) => db.query(
  `INSERT INTO change_generations(change_id,generation,repo_id,base_branch,branch,base_commit,base_tree,policy_revision,created_at) VALUES ($1,$2,4242,'main',$3,$4,$4,'fixture-policy',1)`,
  [id, generation, branch, 'a'.repeat(40)]);

test('D-122 migration 030: 옛 행은 그대로 지나고 새 꼴 행을 받으며, 그 밖의 꼴은 거절한다', async () => {
  const { pg, db } = await rawDatabase(29);
  try {
    await seedConversation(db);
    const legacy = newChangeId();
    await insertRequest(db, legacy);
    await insertGeneration(db, legacy, 1, `bot/change/${legacy}/g1`);
    // 030 전에는 새 꼴 이름을 받지 못한다(이 migration이 필요한 이유).
    const early = newChangeId();
    await insertRequest(db, early);
    await assert.rejects(insertGeneration(db, early, 1, newChangeBranchName()), /change_generations_branch_shape/);
    await pg.exec(await readFile('migrations/030_change_branch_trace.sql', 'utf8'));
    assert.deepEqual((await db.query<{ branch: string }>('SELECT branch FROM change_generations WHERE change_id=$1', [legacy])).rows.map(row => row.branch), [`bot/change/${legacy}/g1`]);
    assert.deepEqual((await db.query<{ version: number }>('SELECT version FROM schema_migrations WHERE version=30')).rows.length, 1);
    await insertGeneration(db, legacy, 2, `bot/change/${legacy}/g2`);
    await insertGeneration(db, early, 1, newChangeBranchName());
    const other = newChangeId();
    await insertRequest(db, other);
    const trace = '0'.repeat(24);
    for (const bad of [`bot/change/${legacy}/g3`, `bot/change/${other}/g2`, `bot/change/c${trace.slice(1)}`, `bot/change/c${trace}0`, `bot/change/C${trace}`,
      `bot/change/c${'A'.repeat(24)}`, `bot/change/c${trace}/g1`, `bot/change/${trace}`, 'main', `refs/heads/bot/change/c${trace}`, `bot/change/c${trace}\n`]) {
      await assert.rejects(insertGeneration(db, other, 1, bad), /change_generations_branch_shape/, bad);
    }
    // 같은 이름은 두 세대가 함께 쓰지 못한다.
    const taken = (await db.query<{ branch: string }>('SELECT branch FROM change_generations WHERE change_id=$1', [early])).rows[0]!.branch;
    await assert.rejects(insertGeneration(db, other, 1, taken), /duplicate key|unique/i);
    // 다시 돌아도(차트 Job이 매 sync마다 돈다) 같은 결과다.
    await pg.exec(await readFile('migrations/030_change_branch_trace.sql', 'utf8'));
    assert.equal((await db.query<{ count: number }>('SELECT count(*)::int AS count FROM change_generations')).rows[0]!.count, 3);
  } finally { await pg.close(); }
});

test('D-122 정적: src에서 변경 브랜치 이름을 만드는 곳은 newChangeBranchName 하나이고 옛 꼴을 만드는 코드가 없다', async () => {
  const files = (await readdir('src')).filter(name => name.endsWith('.ts'));
  const makers: string[] = [];
  for (const name of files) {
    const text = await readFile(`src/${name}`, 'utf8');
    // 옛 꼴을 만드는 템플릿(bot/change/${…}/g${…})과 문자열 연결.
    assert.doesNotMatch(text, /bot\/change\/\$\{[^}]*\}\/g\$\{/, name);
    assert.doesNotMatch(text, /['"`]bot\/change\/['"`]\s*\+/, name);
    for (const match of text.matchAll(/`bot\/change\//g)) makers.push(`${name}:${text.slice(0, match.index).split('\n').length}`);
  }
  assert.equal(makers.length, 1, makers.join(', '));
  assert.match(makers[0]!, /^change-contracts\.ts:/);
  const store = await readFile('src/change-store.ts', 'utf8');
  const insert = store.slice(store.indexOf('INSERT INTO change_generations'));
  assert.match(insert.slice(0, 400), /newChangeBranchName\(request\.id\)/, '세대 행의 이름은 새 꼴로만 만들고 그 change ID의 앞부분을 품은 이름은 다시 뽑는다');
  const contracts = await readFile('src/change-contracts.ts', 'utf8');
  assert.doesNotMatch(contracts, /export (?:function|const) changeBranchName\b/);
});

test('D-122 새 이름·추적 ID: 이름과 추적 ID·표식·안내 키에서 change ID를 되찾을 수 없고, 추적 ID는 change ID로 계산되지 않는다', () => {
  const key: ChangeKey = { changeId: newChangeId(), generation: 3 };
  const names = Array.from({ length: 16 }, () => newChangeBranchName());
  for (const branch of names) {
    assert.match(branch, TRACE);
    const trace = changeTraceId(key, branch)!;
    assert.equal(`bot/change/${trace}`, branch);
    // 같은 change·세대라도 이름마다 다른 값이라 change ID의 함수가 아니다.
    assert.notEqual(trace, publicTraceId('change', `${key.changeId}:g${key.generation}`));
    const outputs = [branch, trace, publicationMarker(key, branch), guidanceKey(key, branch, 0), guidanceKey(key, branch, 4), guidanceMarker(guidanceKey(key, branch, 1))];
    for (const output of outputs) for (const piece of pieces(key.changeId)) assert.ok(!output.toLowerCase().includes(piece), `${output} ⊃ ${piece}`);
    // 다른 change의 키를 넣어도 같은 추적 ID다(이름 → 키 대응은 DB 행에만 있다).
    assert.equal(changeTraceId({ changeId: newChangeId(), generation: 1 }, branch), trace);
  }
  assert.equal(new Set(names.map(branch => changeTraceId(key, branch))).size, names.length);
});

test('D-122 옛 꼴: 이미 낸 PR 표식·안내 키는 예전 값 그대로라 찾기·회수가 되고, 키가 다른 옛 이름은 받지 않는다', () => {
  const key: ChangeKey = { changeId: newChangeId(), generation: 2 };
  const legacy = `bot/change/${key.changeId}/g2`;
  assert.equal(changeTraceId(key, legacy), publicTraceId('change', `${key.changeId}:g2`));
  assert.equal(publicationMarker(key, legacy), `homelab-bot-change:${publicTraceId('change', `${key.changeId}:g2`)}`);
  assert.equal(guidanceKey(key, legacy, 3), `${key.changeId}:g2:r3`);
  assert.equal(changeTraceId({ ...key, generation: 1 }, legacy), null);
  assert.equal(changeTraceId({ changeId: newChangeId(), generation: 2 }, legacy), null);
  assert.equal(changeTraceId(key, 'main'), null);
  assert.throws(() => publicationMarker({ ...key, generation: 1 }, legacy), /change_branch_invalid/);
  assert.throws(() => guidanceKey({ ...key, generation: 1 }, legacy, 0), /change_branch_invalid/);
});

const IDENTITY = { name: 'fixture-writer[bot]', email: 'fixture-writer[bot]@users.noreply.github.com' };
const publication = (key: ChangeKey, branch: string) => renderPublication({ key, label: 'public', brief: fixtureBrief({ summary: '요약', goal: '목표', acceptanceCriteria: ['기준'] }),
  bundle: fixtureBundle({ generation: key.generation }), branch, verifications: [{ commandId: 'smoke-unit', status: 'passed' }], review: { verdict: 'pass', risks: [] },
  identity: IDENTITY, at: Date.UTC(2026, 0, 2) }, { internalMarkers: ['fixture-internal-host'] });

test('D-122 옛 꼴: 새 공개 글을 만들지 않고, 모델 글에 심은 change ID는 공개 문구 검사에 걸린다', () => {
  const key: ChangeKey = { changeId: newChangeId(), generation: 1 };
  assert.deepEqual(publication(key, `bot/change/${key.changeId}/g1`), { ok: false, reason: 'branch_read_only' });
  assert.deepEqual(publication(key, 'main'), { ok: false, reason: 'publication_input_invalid' });
  const planted = renderPublication({ key, label: 'public', brief: fixtureBrief({ summary: '요약', goal: `목표 ${key.changeId}`, acceptanceCriteria: ['기준'] }),
    bundle: fixtureBundle({ generation: 1 }), branch: newChangeBranchName(), verifications: [{ commandId: 'smoke-unit', status: 'passed' }], review: { verdict: 'pass', risks: [] },
    identity: IDENTITY, at: Date.UTC(2026, 0, 2) }, { internalMarkers: [] });
  assert.deepEqual(planted, { ok: false, reason: 'internal_marker' });
});

test('D-122 writer: 쓰기는 영수증이 본 새 꼴 브랜치에만 하고, 옛 꼴 브랜치는 읽기만 한다', async () => {
  const key: ChangeKey = { changeId: newChangeId(), generation: 1 };
  const target = { key, repoId: REPO.id };
  const github = new FakeGitHub();
  const base = github.commitFiles({ 'README.md': '# 읽어보기\n' }, []);
  github.refs.set('heads/main', base.sha);
  const receipts = new PublicReceipts();
  const io = createGitHubWriter({ app: { appId: '12345', privateKey: FAKE_APP_KEY }, receipts, repositories: async () => ({ ...REPO, baseBranches: ['main'] }), authorizeWrite: async () => {},
    send: github.send, now: () => github.clock });
  const branch = newChangeBranchName();
  const legacy = `bot/change/${key.changeId}/g1`;
  const rendered = publication(key, branch);
  assert.equal(rendered.ok, true);
  const { publication: metadata, marker } = rendered as Extract<typeof rendered, { ok: true }>;
  // 영수증이 없으면 어느 브랜치에도 쓰지 않는다.
  assert.deepEqual(await io.writer.createRef({ target, branch, sha: base.sha }), { kind: 'not_sent', code: 'branch_not_allowed' });
  const scanned = scanPublicPayload({ paths: [], files: [], publication: metadata, branch, marker }, { internalMarkers: [] });
  assert.equal(scanned.ok, true);
  receipts.record(key, (scanned as Extract<typeof scanned, { ok: true }>).receipt);
  for (const other of [legacy, newChangeBranchName()]) {
    assert.deepEqual(await io.writer.createRef({ target, branch: other, sha: base.sha }), { kind: 'not_sent', code: 'branch_not_allowed' }, other);
    assert.deepEqual(await io.writer.createPull({ target, branch: other, baseBranch: 'main', title: metadata.title, body: metadata.body, draft: false }), { kind: 'not_sent', code: 'branch_not_allowed' }, other);
    assert.deepEqual(await io.writer.fastForwardBranch({ target, branch: other, expectedHead: base.sha, sha: 'b'.repeat(40) }), { kind: 'not_sent', code: 'branch_not_allowed' }, other);
  }
  assert.equal(github.mutations().length, 0);
  // 옛 꼴 브랜치의 head와 PR은 그대로 찾는다(회수·멱등 판정).
  github.refs.set(`heads/${legacy}`, base.sha);
  assert.deepEqual(await io.writer.readBranchHead({ target, branch: legacy }), { sha: base.sha });
  github.addPull({ title: 't', body: 'b', head: { ref: legacy, sha: base.sha, repo: { id: REPO.id } }, base: { ref: 'main', repo: { id: REPO.id } } });
  assert.deepEqual((await io.writer.findPulls({ target, headBranch: legacy, baseBranch: 'main' })).map(pull => pull.headBranch), [legacy]);
  // 영수증이 본 새 꼴 브랜치에는 쓴다.
  assert.equal((await io.writer.createRef({ target, branch, sha: base.sha })).kind, 'confirmed');
});

test('D-122 AC-06: 심은 change ID와 그 앞부분이 게시 흐름의 GitHub 바깥 바이트(경로·본문) 어디에도 없다', async () => {
  const { db, pg } = await localDatabase();
  try {
    const env = await publishEnv(db);
    const key = await env.approve();
    assert.equal((await env.publisher.publish(key)).kind, 'proposed');
    const branch = pinnedBranch(key.changeId, key.generation);
    assert.match(branch, TRACE);
    const sent = env.github.mutations();
    assert.ok(sent.length >= 5, '게시 쓰기가 실제로 나갔다');
    const outbound = [branch, ...env.github.sent.map(item => `${item.method} ${item.path} ${JSON.stringify(item.body ?? null)}`)];
    // 본문은 base64 blob도 풀어서 본다.
    const decoded = env.github.sent.flatMap(item => JSON.stringify(item.body ?? null).match(/[A-Za-z0-9+/]{16,}={0,2}/g) ?? []).map(text => Buffer.from(text, 'base64').toString('latin1'));
    for (const text of [...outbound, ...decoded]) for (const piece of pieces(key.changeId)) assert.ok(!text.toLowerCase().includes(piece), `바깥 바이트에 change ID 조각 ${piece}`);
    const pull = env.github.pulls[0]!;
    assert.equal(pull.head.ref, branch);
    assert.ok((pull.body ?? '').includes(`- 추적 ID: ${branch.slice('bot/change/'.length)}`));
    assert.ok((pull.body ?? '').includes(`<!-- homelab-bot-change:${branch.slice('bot/change/'.length)} -->`));
    // 같은 요청을 다시 돌려도 새 쓰기가 없다(멱등).
    const before = env.github.mutations().length;
    assert.equal((await env.publisher.publish(key)).kind, 'proposed');
    assert.equal(env.github.mutations().length, before);
    // 감사 행만 추적 ID → change ID 대응을 갖는다.
    const audit = (await db.query<{ detail: unknown }>("SELECT detail FROM audit WHERE kind='github_public_id' AND subject=$1", [branch.slice('bot/change/'.length)])).rows;
    assert.equal(audit.length, 1);
    assert.equal((typeof audit[0]!.detail === 'string' ? JSON.parse(audit[0]!.detail) : audit[0]!.detail as { changeId: string }).changeId, key.changeId);
  } finally { await pg.close(); }
});

test('D-122 옛 꼴: 030 전에 만든 옛 이름 세대는 새 공개 글을 만들지 않고, 승인만 된 세대는 아무것도 보내지 않고 닫는다', async () => {
  const { db, pg } = await localDatabase();
  try {
    const env = await publishEnv(db);
    const key = await env.newRequest();
    const legacy = `bot/change/${key.changeId}/g${key.generation}`;
    // 030 전의 pinBase처럼 세대 행을 옛 꼴 이름으로 직접 넣는다(세대 행은 만든 뒤 바뀌지 않아 고쳐 쓸 수 없다).
    env.store.pinBase = async input => {
      await db.query(`INSERT INTO change_generations(change_id,generation,repo_id,base_branch,branch,base_commit,base_tree,policy_revision,created_at)
        SELECT id,generation,repo_id,base_branch,$2,$3,$4,policy_revision,$5 FROM change_requests WHERE id=$1`, [input.changeId, legacy, input.baseCommit, input.baseTree, env.clock.now]);
      await db.query("UPDATE change_requests SET phase='authoring',updated_at=$2 WHERE id=$1", [input.changeId, env.clock.now]);
      return env.store.generationRecord(input);
    };
    const review = await env.driveToReview(key, DEFAULT_CHANGES);
    assert.equal(ok(await env.store.generationRecord(key)).branch, legacy);
    assert.deepEqual(await env.publisher.prepareApproval(key, { review, at: FIXTURE_TIME }), { ok: false, reason: 'branch_read_only' });
    // 030 전 코드가 만든 승인 대상을 흉내 낸다: 본문·커밋의 추적 ID와 표식이 옛 값이다.
    const placeholder = newChangeBranchName();
    const rendered = renderPublication({ key, label: 'public', brief: ok(await env.store.get(key.changeId)).brief!, bundle: ok(await env.store.evidenceBundle(key)), branch: placeholder,
      verifications: [{ commandId: 'smoke-unit', status: 'passed' }], review: { verdict: 'pass', risks: [] }, identity: env.policy.current!.identity, at: FIXTURE_TIME }, { internalMarkers: [] });
    assert.equal(rendered.ok, true, JSON.stringify(rendered));
    const publication = JSON.parse(JSON.stringify((rendered as Extract<typeof rendered, { ok: true }>).publication).replaceAll(changeTraceId(key, placeholder)!, changeTraceId(key, legacy)!)) as PublicMetadata;
    assert.ok(publication.body.includes(`<!-- ${publicationMarker(key, legacy)} -->`));
    const prepared = ok(await env.store.prepareApproval({ ...key, publication, ciFingerprint: env.policy.current!.ci.approvedFingerprint! }));
    ok(await env.store.approve({ ...key, approvalDigest: prepared.digest, eventId: newEvent(), actor: OWNER }));
    assert.deepEqual(await env.publisher.publish(key), { kind: 'blocked', reason: 'branch_read_only' });
    assert.equal(env.github.mutations().length, 0);
    assert.equal(ok(await env.store.get(key.changeId)).phase, 'blocked');
  } finally { await pg.close(); }
});

// ---- 030으로 넘어온 옛 꼴 세대(리뷰 재현 입력) ----

// 030 전 코드가 만든 옛 꼴 세대를 흉내 낸다. 세대 행은 만든 뒤 고칠 수 없어 이 store 인스턴스의 pinBase만 한 번 옛 꼴 INSERT로 바꿔 끼운다.
async function legacyReview(env: PublishEnv, key: ChangeKey, changes: FileChange[] = DEFAULT_CHANGES, patch?: string) {
  const legacy = `bot/change/${key.changeId}/g${key.generation}`;
  const store = env.store as ChangeStore & { pinBase: ChangeStore['pinBase'] };
  store.pinBase = async input => {
    await env.db.query(`INSERT INTO change_generations(change_id,generation,repo_id,base_branch,branch,base_commit,base_tree,policy_revision,created_at)
      SELECT id,generation,repo_id,base_branch,$2,$3,$4,policy_revision,$5 FROM change_requests WHERE id=$1`, [input.changeId, legacy, input.baseCommit, input.baseTree, env.clock.now]);
    await env.db.query("UPDATE change_requests SET phase='authoring',updated_at=$2 WHERE id=$1", [input.changeId, env.clock.now]);
    return env.store.generationRecord(input);
  };
  try {
    const review = await env.driveToReview(key, changes, patch === undefined ? {} : { patch });
    assert.equal(ok(await env.store.generationRecord(key)).branch, legacy);
    return { legacy, review };
  } finally { delete (store as Partial<typeof store>).pinBase; }
}
// 030 전 코드가 승인한 옛 꼴 세대: 본문·커밋의 추적 ID와 표식이 옛 값이다.
async function legacyApproved(env: PublishEnv, key: ChangeKey, options: { changes?: FileChange[]; patch?: string; notes?: ChangeNotes } = {}) {
  const { legacy } = await legacyReview(env, key, options.changes, options.patch);
  if (options.notes) assert.equal(await recordChangeNotes(env.db, key, options.notes), 'recorded');
  const placeholder = newChangeBranchName();
  const rendered = renderPublication({ key, label: 'public', brief: ok(await env.store.get(key.changeId)).brief!, bundle: ok(await env.store.evidenceBundle(key)), branch: placeholder,
    verifications: [{ commandId: 'smoke-unit', status: 'passed' }], review: { verdict: 'pass', risks: [] }, identity: env.policy.current!.identity, at: FIXTURE_TIME, ...options.notes }, { internalMarkers: [] });
  assert.equal(rendered.ok, true, JSON.stringify(rendered));
  const publication = JSON.parse(JSON.stringify((rendered as Extract<typeof rendered, { ok: true }>).publication).replaceAll(changeTraceId(key, placeholder)!, changeTraceId(key, legacy)!)) as PublicMetadata;
  const prepared = ok(await env.store.prepareApproval({ ...key, publication, ciFingerprint: env.policy.current!.ci.approvedFingerprint! }));
  ok(await env.store.approve({ ...key, approvalDigest: prepared.digest, eventId: newEvent(), actor: OWNER }));
  return { legacy, publication };
}
type EffectRow = { stage: string; state: string; request_digest: string; expected: unknown; result: unknown };
const json = (value: unknown) => typeof value === 'string' ? JSON.parse(value) as unknown : value;

test('D-122 옛 꼴 재개(029에서 blob 확정·tree 미룸): 030은 tree·commit을 보내지 않고 blocked(branch_read_only)로 닫으며 안 나간 tree는 해소된다', async () => {
  const { db, pg } = await localDatabase();
  try {
    const env = await publishEnv(db);
    // 같은 파일·base의 새 꼴 change로 029가 남겼을 effect 값(blob·tree 요청 digest와 기대값)을 만든다. blob·tree 값은 브랜치 이름과 무관하다.
    const twin = await env.approve();
    env.github.fail(/POST .*\/git\/trees$/, 'refused');
    assert.equal((await env.publisher.publish(twin)).kind, 'deferred');
    const rows = (await db.query<EffectRow>('SELECT stage,state,request_digest,expected,result FROM change_delivery_effects WHERE change_id=$1', [twin.changeId])).rows;
    assert.deepEqual(rows.map(row => `${row.stage}:${row.state}`).sort(), ['blob:confirmed', 'tree:pending']);
    const key = await env.newRequest();
    await legacyApproved(env, key);
    // 029의 게시 흐름처럼 publishing으로 옮기고 blob은 보내 확정, tree는 의도만 남긴다.
    ok(await env.store.transition({ ...key, from: 'approved', to: 'publishing', reason: null }));
    for (const stage of ['blob', 'tree'] as const) {
      const row = rows.find(item => item.stage === stage)!;
      ok(await env.store.recordEffectIntent({ ...key, stage, requestDigest: row.request_digest, expected: json(row.expected) as never }));
      if (row.state !== 'confirmed') continue;
      const claim = ok(await env.store.claimEffect({ ...key, stage }));
      ok(await env.store.confirmEffect({ ...key, stage, leaseId: claim.leaseId, result: json(row.result) as never }));
    }
    env.clock.now += 900_000;
    const before = env.github.mutations().length;
    const outcome = await env.newPublisher().publish(key);
    const writes = env.github.mutations().slice(before).map(item => item.path.split('/').at(-1));
    assert.deepEqual(writes, [], 'old generation should need reads only');
    assert.deepEqual(outcome, { kind: 'blocked', reason: 'branch_read_only' });
    assert.equal(ok(await env.store.get(key.changeId)).phase, 'blocked');
    // 확실히 안 나간 tree는 사람 해소 없이 안 나간 것으로 끝난다(정리·새 세대를 막지 않는다).
    assert.deepEqual(await env.store.unresolvedEffects({ changeId: key.changeId }), []);
    // 다시 불러도 쓰기가 없다.
    await env.newPublisher().publish(key);
    assert.equal(env.github.mutations().length, before);
  } finally { await pg.close(); }
});

test('D-122 옛 꼴 PR 안내(029에서 게시 끝, 안내 전): 새 차례·pending은 보내지 않고 닫고, sending·unknown만 옛 키로 찾아 회수한다', async () => {
  const { db, pg } = await localDatabase();
  try {
    const env = await publishEnv(db);
    const patch = ['diff --git a/src/a.ts b/src/a.ts', '--- a/src/a.ts', '+++ b/src/a.ts', '@@ -1 +1 @@', '-old', '+new', ''].join('\n');
    const notes = { checks: [{ text: '확인', location: { path: 'src/a.ts', line: 1 } }], risks: [] };
    const headSha = 'c'.repeat(40);
    const found: string[] = [];
    let posts = 0;
    const guidance = new ChangeGuidance({ db, changes: env.store, now: () => env.clock.now, policy: async () => env.policy.current, limit: async () => 5,
      port: { post: async () => { posts++; return { kind: 'confirmed', value: { id: 50 } }; }, find: async input => { found.push(input.key); return { id: 51 }; } } });
    for (const state of [null, 'pending', 'sending', 'unknown'] as const) {
      const key = await env.newRequest();
      const { publication } = await legacyApproved(env, key, { patch, notes });
      if (state) await db.query('INSERT INTO change_guidance(change_id,generation,round,head_sha,state,created_at,updated_at) VALUES ($1,$2,0,$3,$4,$5,$5)', [key.changeId, key.generation, headSha, state, env.clock.now]);
      const outcome = await guidance.post({ key, round: 0, repoId: REPO.id, pr: 7, headSha, patch, ...notes, approvedBody: publication.body });
      if (state === null || state === 'pending') assert.deepEqual([outcome.state, outcome.reason], ['skipped', 'branch_read_only'], String(state));
      else {
        assert.deepEqual([outcome.state, outcome.reviewId], ['posted', 51], state);
        assert.equal(found.at(-1), `${key.changeId}:g${key.generation}:r0`, '회수는 이미 낸 옛 표식으로 찾는다');
      }
    }
    assert.equal(posts, 0, 'old proposed guidance should need reads only');
  } finally { await pg.close(); }
});

test('D-122 승인 준비 중인 옛 꼴 세대: 런타임 첫 시도에 blocked(branch_read_only)로 닫고 다시 준비하지 않는다', async () => {
  const { db, pg } = await localDatabase();
  try {
    const env = await publishEnv(db);
    const key = await env.newRequest();
    const { review } = await legacyReview(env, key);
    let prepares = 0;
    const publisher = env.newPublisher();
    const counted = Object.assign(Object.create(publisher) as ChangePublisher, { prepareApproval: (...args: Parameters<ChangePublisher['prepareApproval']>) => { prepares++; return publisher.prepareApproval(...args); } });
    const logs: string[] = [];
    const runtime = new ChangeRuntime({ store: { db, now: () => env.clock.now }, changes: env.store, publisher: counted, gate: { authorize: async () => {} },
      review: { fetchReceipt: async () => review }, log: (event: string, fields: Record<string, unknown> = {}) => logs.push(`${event}/${String(fields.reason ?? fields.message ?? '')}`) } as unknown as ChangeRuntimeDeps);
    const step = runtime as unknown as { guarded(request: unknown, run: () => Promise<boolean>): Promise<boolean>; publishStep(request: unknown): Promise<boolean> };
    for (let tick = 0; tick < 2; tick++) {
      const request = ok(await env.store.get(key.changeId));
      await step.guarded(request, () => step.publishStep(request));
      env.clock.now += 600_000;
    }
    const row = (await db.query<{ phase: string; phase_reason: string | null }>('SELECT phase,phase_reason FROM change_requests WHERE id=$1', [key.changeId])).rows[0]!;
    assert.deepEqual([row.phase, row.phase_reason], ['blocked', 'branch_read_only'], logs.join(','));
    assert.equal(prepares, 1);
  } finally { await pg.close(); }
});

test('D-122 옛 꼴 수정 차례: 남은 stage를 보내지 않고 pending을 해소해 failed로 닫고, 보냈을 수 있는 ref만 읽기로 회수한다', async () => {
  const key = { changeId: newChangeId(), generation: 1, round: 1 };
  const legacy = `bot/change/${key.changeId}/g1`;
  const baseCommit = 'a'.repeat(40);
  const mine = 'd'.repeat(40);
  const generation = { changeId: key.changeId, generation: 1, repoId: REPO.id, baseBranch: 'main', branch: legacy, baseCommit, baseTree: 'b'.repeat(40), policyRevision: 'fixture-policy', resultTree: null, artifactDigest: null, verifierRevision: null, fixRound: 0 };
  const effect = (stage: string, state: string, expected: Record<string, unknown> = {}) => ({ ...key, stage, state, expected: { stage, ...expected }, resolution: null, blockedReason: null, result: null });
  const run = async (effects: ReturnType<typeof effect>[], head: string | null) => {
    const calls: string[] = [];
    const abandoned: string[] = [];
    const confirmed: string[] = [];
    const writer = new Proxy({}, { get: (_target, name) => async () => {
      calls.push(String(name));
      if (name === 'readBranchHead') return head === null ? null : { sha: head };
      return String(name).startsWith('read') ? null : { kind: 'not_sent', code: 'unexpected' };
    } });
    const impl: Record<string, unknown> = {
      expireSendingAmendmentEffects: async () => [], amendmentEffects: async () => effects, generationRecord: async () => ({ ok: true, value: generation }),
      amendment: async () => ({ ok: true, value: { baseCommit } }),
      confirmAmendmentEffect: async (input: { stage: string }) => { confirmed.push(input.stage); return { ok: true, value: {} }; },
      abandonUnsentAmendmentEffect: async (input: { stage: string }) => { abandoned.push(input.stage); return { ok: true, value: {} }; },
    };
    // 옛 꼴에서 쓰기 준비(정책·산출물·공개 검사)로 들어가면 여기서 드러난다.
    const store = new Proxy(impl, { get: (target, name) => name in target ? target[name as string] : () => { throw new Error(`unexpected_store_call:${String(name)}`); } });
    const publisher = new ChangePublisher({ store: store as unknown as ChangeStore, receipts: new PublicReceipts(), writer: writer as never, preflight: writer as never, policy: async () => null, authorize: async () => {} });
    const outcome = await publisher.publishAmendment(key, { pullOpen: async () => true });
    return { outcome, writes: calls.filter(name => !/^(read|find)/.test(name)), abandoned, confirmed };
  };
  // 029에서 blob만 확정하고 tree가 미룬 채 남았다.
  const pendingTree = await run([effect('blob', 'confirmed', { shas: [] }), effect('tree', 'pending', { baseTree: 'b'.repeat(40), treeSha: 'e'.repeat(40) })], baseCommit);
  assert.deepEqual(pendingTree, { outcome: { kind: 'failed', reason: 'branch_read_only' }, writes: [], abandoned: ['tree'], confirmed: [] });
  // fast-forward 응답을 잃었고 브랜치가 이미 내 커밋이다.
  const lostRef = await run([effect('blob', 'confirmed'), effect('tree', 'confirmed'), effect('commit', 'confirmed'), effect('ref', 'unknown', { ref: `refs/heads/${legacy}`, sha: mine })], mine);
  assert.deepEqual(lostRef, { outcome: { kind: 'committed', commitSha: mine }, writes: [], abandoned: [], confirmed: ['ref'] });
  // 아직 base 그대로라 보냈는지 모른다. 실패로 닫지 않고 대조를 기다린다.
  const unknownRef = await run([effect('commit', 'confirmed'), effect('ref', 'unknown', { ref: `refs/heads/${legacy}`, sha: mine })], baseCommit);
  assert.deepEqual(unknownRef, { outcome: { kind: 'unknown', stage: 'ref' }, writes: [], abandoned: [], confirmed: [] });
});

test('D-122 change별 금지 값: 경로·파일 바이트에 change ID 앞 8자가 있으면 영수증을 발급하지 않고 아무것도 보내지 않는다', async () => {
  const { db, pg } = await localDatabase();
  try {
    const env = await publishEnv(db);
    const cases: [string, (prefix: string) => FileChange][] = [
      ['파일 바이트', prefix => ({ path: 'src/trace.ts', kind: 'added', content: `export const t = '${prefix}';\n` })],
      ['경로', prefix => ({ path: `src/${prefix}.ts`, kind: 'added', content: 'export const t = 1;\n' })],
    ];
    for (const [label, planted] of cases) {
      const key = await env.newRequest();
      const review = await env.driveToReview(key, [...DEFAULT_CHANGES, planted(key.changeId.slice(0, 8))]);
      const prepared = await env.publisher.prepareApproval(key, { review, at: FIXTURE_TIME });
      assert.equal(prepared.ok, true, label);
      ok(await env.store.approve({ ...key, approvalDigest: (prepared as { digest: string }).digest, eventId: newEvent(), actor: OWNER }));
      const before = env.github.mutations().length;
      assert.deepEqual(await env.publisher.publish(key), { kind: 'blocked', reason: 'internal_marker' }, label);
      assert.equal(env.github.mutations().length, before, label);
      assert.equal(env.writerIO.receipts.branchOf(key), undefined, label);
    }
  } finally { await pg.close(); }
});

test('D-122 change별 금지 값: 안내 댓글의 글·경로에 change ID 앞 8자가 있으면 보내지 않는다', async () => {
  const { db, pg } = await localDatabase();
  try {
    const env = await publishEnv(db);
    let posts = 0;
    const guidance = new ChangeGuidance({ db, changes: env.store, now: () => env.clock.now, policy: async () => env.policy.current, limit: async () => 5,
      port: { post: async () => { posts++; return { kind: 'confirmed', value: { id: 50 } }; }, find: async () => null } });
    for (const where of ['글', '경로'] as const) {
      const key = await env.newRequest();
      await env.driveToReview(key, DEFAULT_CHANGES);
      const prefix = key.changeId.slice(0, 8);
      const path = where === '경로' ? `src/${prefix}.ts` : 'src/a.ts';
      const patch = [`diff --git a/${path} b/${path}`, `--- a/${path}`, `+++ b/${path}`, '@@ -1 +1 @@', '-old', '+new', ''].join('\n');
      const outcome = await guidance.post({ key, round: 1, repoId: REPO.id, pr: 7, headSha: 'c'.repeat(40), patch,
        checks: [{ text: where === '글' ? `확인 ${prefix}` : '확인', location: { path, line: 1 } }], risks: [] });
      assert.deepEqual([outcome.state, outcome.reason], ['skipped', 'internal_marker'], where);
    }
    assert.equal(posts, 0);
  } finally { await pg.close(); }
});

test('D-122 새 이름: change ID 앞 8자를 품은 추적 ID는 다시 뽑는다(고정 입력)', () => {
  const changeId = '0123456789abcdef0123456789abcdef';
  const draws = (values: string[]) => { const queue = [...values]; return () => queue.shift()!; };
  const independent = 'fedcba98fedcba98fedcba98';
  // 리뷰가 본 기존 고정 입력(change ID 앞 16자를 추적 ID 안에 품음)과, 'c' 머리와 이어 붙어 앞 8자가 되는 값.
  assert.equal(newChangeBranchName(changeId, draws(['89abcdef0123456789abcdef', independent])), `bot/change/c${independent}`);
  assert.equal(newChangeBranchName('c1234567' + '0'.repeat(24), draws(['1234567' + 'f'.repeat(17), independent])), `bot/change/c${independent}`);
  // 정상 독립 값은 한 번에 받는다.
  assert.equal(newChangeBranchName(changeId, draws([independent, '89abcdef0123456789abcdef'])), `bot/change/c${independent}`);
  for (let i = 0; i < 32; i++) {
    const id = newChangeId();
    assert.ok(!newChangeBranchName(id).includes(id.slice(0, 8)));
  }
});
