import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import { PGlite } from '@electric-sql/pglite';
import { newChangeBranchName, newChangeId } from '../src/change-contracts.js';
import type { ChangeKey, PublicMetadata } from '../src/change-contracts.js';
import { guidanceKey } from '../src/change-guidance.js';
import { PublicReceipts, changeTraceId, publicTraceId, publicationMarker, renderPublication, scanPublicPayload } from '../src/change-publication.js';
import { MIGRATIONS } from '../src/database.js';
import type { Database } from '../src/database.js';
import { createGitHubWriter } from '../src/github-writer.js';
import { guidanceMarker } from '../src/github-review-io.js';
import { DEFAULT_CHANGES, FAKE_APP_KEY, FIXTURE_TIME, FakeGitHub, REPO, publishEnv } from './change-github-fake.js';
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
  assert.match(insert.slice(0, 400), /newChangeBranchName\(\)/, '세대 행의 이름은 새 꼴로만 만든다');
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
