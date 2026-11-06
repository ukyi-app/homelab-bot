import { test } from 'node:test';
import assert from 'node:assert/strict';
import { renderPublication, scanPublicPayload } from '../src/change-publication.js';
import type { PublicPayload } from '../src/change-publication.js';
import { ChangePrivateInputs } from '../src/change-store.js';
import { REPO, publishEnv } from './change-github-fake.js';
import type { PublishEnv } from './change-github-fake.js';
import { CONVERSATION, OWNER, fixtureBrief, fixtureBundle, fixtureMetadata, ok } from './change-store-fixture.js';
import { localDatabase } from './helpers.js';

// DATA-01. canary는 모두 합성이다. 진짜 토큰·호스트·ID를 쓰지 않는다.
const MARKER = 'fixture-private-canary-7f3a';
const POLICY = { internalMarkers: [MARKER, 'fixture-corp-host'] };
const TOKEN = `ghs_${'A1b2C3d4'.repeat(4)}`;
const KEY = { changeId: '0123456789abcdef0123456789abcdef', generation: 1 };
const payload = (overrides: Partial<PublicPayload> = {}): PublicPayload => ({
  paths: ['src/a.ts'], files: [{ path: 'src/a.ts', content: Buffer.from('export const a = 1;\n') }], publication: fixtureMetadata(),
  branch: `bot/change/${KEY.changeId}/g1`, marker: `homelab-bot-change:${KEY.changeId}:g1`, ...overrides,
});
const blocked = (overrides: Partial<PublicPayload>, reason: string) => {
  const result = scanPublicPayload(payload(overrides), POLICY);
  assert.deepEqual(result, { ok: false, reason });
};
const inFile = (text: string) => ({ files: [{ path: 'src/a.ts', content: Buffer.from(text) }] });
const inBody = (body: string) => ({ publication: { ...fixtureMetadata(), body } });

test('T19 B3 DATA-01: 깨끗한 공개 payload는 지난다', () => {
  assert.deepEqual(scanPublicPayload(payload(), POLICY), { ok: true });
});

test('T19 B3 DATA-01: 비밀·내부 표식이 파일·경로·문구 어디에 있든 마스킹 없이 전체를 막는다', () => {
  const secrets = [TOKEN, `github_pat_${'x1'.repeat(15)}`, `sk-${'y2'.repeat(15)}`, '-----BEGIN RSA PRIVATE KEY-----', ['fixture-node', 'fixture-tail', 'ts', 'net'].join('.'), [100, 72, 1, 2].join('.'), '"refresh_token": "x"'];
  for (const secret of secrets) {
    blocked(inFile(`const value = ${JSON.stringify(secret)};\n`), 'secret_detected');
    blocked(inBody(`본문 ${secret}`), 'secret_detected');
    blocked({ publication: { ...fixtureMetadata(), commitMessage: `메시지 ${secret}` } }, 'secret_detected');
    blocked({ publication: { ...fixtureMetadata(), title: `제목 ${secret}`.slice(0, 200) } }, 'secret_detected');
  }
  blocked({ paths: [`src/${TOKEN}.ts`] }, 'secret_detected');
  blocked(inFile(`// ${MARKER}\n`), 'internal_marker');
  blocked(inBody(`연결 ${MARKER.toUpperCase()}`), 'internal_marker');
  blocked({ paths: [`docs/${MARKER}.md`] }, 'internal_marker');
  blocked({ publication: { ...fixtureMetadata(), commitMessage: MARKER } }, 'internal_marker');
});

test('T19 B3 DATA-01: 분할·인코딩한 값도 막는다', () => {
  const half = Math.floor(TOKEN.length / 2);
  blocked(inFile(`const t = "${TOKEN.slice(0, half)}" + "${TOKEN.slice(half)}";\n`), 'secret_detected');
  blocked(inFile(`const t = [\n  "${TOKEN.slice(0, half)}",\n  "${TOKEN.slice(half)}",\n];\n`), 'secret_detected');
  blocked(inFile(`const m = "fixture-private" + "-canary-7f3a";\n`), 'internal_marker');
  blocked(inFile(`const m = "${MARKER.split('').join(' ')}";\n`), 'internal_marker');
  // 두 파일에 나눈 조각도 이어 본다.
  blocked({ files: [
    { path: 'src/a.ts', content: Buffer.from('fixture-private-') }, { path: 'src/b.ts', content: Buffer.from('canary-7f3a') },
  ] }, 'internal_marker');
  blocked(inFile(Buffer.from(MARKER).toString('base64')), 'internal_marker');
  blocked(inFile(Buffer.from(MARKER).toString('hex')), 'internal_marker');
  blocked(inFile(encodeURIComponent(`${MARKER}@`).replaceAll('-', '%2D')), 'internal_marker');
  // 무력화용 폭 없는 문자로 숨겨도 본다.
  blocked(inBody(`fixture${String.fromCodePoint(0x200b)}-private-canary-7f3a`), 'internal_marker');
});

test('T19 B3 DATA-01: 공개 metadata·경로에는 사용자·내부 식별자를 못 싣는다', () => {
  for (const value of ['123456789012345678', 'person@example.org', '/home/fixture/x', '/Users/fixture/x', '10.1.2.3', '192.168.1.2', '172.16.5.6']) {
    blocked(inBody(`값 ${value}`), 'metadata_sensitive');
    blocked({ publication: { ...fixtureMetadata(), commitMessage: `값 ${value}` } }, 'metadata_sensitive');
  }
  blocked({ paths: ['docs/123456789012345678.md'] }, 'metadata_sensitive');
  blocked({ branch: 'bot/change/123456789012345678/g1' }, 'metadata_sensitive');
  // 코드 안의 긴 숫자·사설 IP는 파일 내용이라 metadata 규칙이 아니다.
  assert.deepEqual(scanPublicPayload(payload(inFile('const limit = 123456789012345678;\nconst ip = "10.1.2.3";\n')), POLICY), { ok: true });
  // 고정 bot 신원의 noreply 주소는 막지 않는다.
  assert.deepEqual(scanPublicPayload(payload(), POLICY), { ok: true });
});

test('T19 B3 DATA-01: 실패 값에 감지한 값을 담지 않는다', () => {
  const result = scanPublicPayload(payload(inFile(`${TOKEN} ${MARKER}`)), POLICY);
  assert.ok(!JSON.stringify(result).includes(TOKEN));
  assert.ok(!JSON.stringify(result).includes(MARKER));
});

const withEnv = async (work: (env: PublishEnv) => Promise<void>) => {
  const { db, pg } = await localDatabase();
  try { await work(await publishEnv(db)); } finally { await pg.close(); }
};
const nothingSent = (env: PublishEnv) => {
  assert.equal(env.github.tokenPosts, 0);
  assert.equal(env.github.mutations().length, 0);
};

test('T19 B3 DATA-01: 파일·경로의 canary는 첫 blob 전에 전체를 막고 GitHub 쓰기가 0회다', async () => {
  for (const [changes, reason] of [
    [[{ path: 'src/a.ts', kind: 'modified', content: '안전한 줄\n' }, { path: 'src/z.ts', kind: 'added', content: `// fixture-corp-host\n` }], 'internal_marker'],
    [[{ path: 'src/z.ts', kind: 'added', content: `const t = "${TOKEN.slice(0, 10)}" + "${TOKEN.slice(10)}";\n` }], 'secret_detected'],
    [[{ path: 'docs/123456789012345678.md', kind: 'added', content: '본문\n' }], 'metadata_sensitive'],
    [[{ path: 'src/fixture-corp-host.ts', kind: 'added', content: '본문\n' }], 'internal_marker'],
  ] as const) {
    await withEnv(async env => {
      const key = await env.approve(changes as never);
      assert.deepEqual(await env.publisher.publish(key), { kind: 'blocked', reason });
      nothingSent(env);
    });
  }
});

test('T19 B3 DATA-01: 승인 뒤 비공개 답변이 들어오면 label이 올라가 게시되지 않고 낮출 수 없다', async () => {
  for (const label of ['private', 'unknown'] as const) {
    await withEnv(async env => {
      const key = await env.approve();
      const inputs = new ChangePrivateInputs(env.db, () => env.clock.now);
      const recorded = await inputs.record({ ...key, eventId: `fixture-answer-${label}`, label, text: `${MARKER} 비공개 답변` });
      assert.equal(recorded.ok, false);
      const before = env.github.sent.length;
      assert.deepEqual(await env.publisher.publish(key), { kind: 'stopped', phase: 'blocked' });
      assert.equal(env.github.sent.length, before, '읽기도 나가지 않는다');
      nothingSent(env);
      assert.equal(ok(await env.store.get(key.changeId)).label, label);
      // 코드를 거치지 않고 낮추는 쓰기도 DB가 막는다.
      await assert.rejects(env.db.query(`UPDATE change_requests SET label='public' WHERE id=$1`, [key.changeId]), /label_lowered/);
    });
  }
});

test('T19 B3 DATA-01: private·unknown 입력은 시작부터 막혀 작업·게시로 가지 않는다', async () => {
  await withEnv(async env => {
    for (const label of ['private', 'unknown'] as const) {
      const request = ok(await env.store.createRequest({ eventId: `fixture-private-${label}`, ownerId: OWNER, conversationId: CONVERSATION, scope: { guild: 'fixture-guild', channel: 'fixture-thread', parent: 'fixture-chat', kind: 'thread' },
        repoId: REPO.id, baseBranch: 'main', label, input: { text: `${MARKER} 요청` } }));
      // brief가 public이라고 신고해도 낮아지지 않는다.
      const admitted = await env.store.admit({ changeId: request.id, generation: 1, brief: fixtureBrief({ label: 'public', repoId: REPO.id }), policyRevision: 'fixture-policy-1' });
      assert.equal(admitted.ok, false);
      assert.equal(ok(await env.store.get(request.id)).phase, 'blocked');
      assert.deepEqual(await env.publisher.publish({ changeId: request.id, generation: 1 }), { kind: 'stopped', phase: 'blocked' });
    }
    assert.equal(env.github.sent.length, 0);
  });
});

test('T19 B3 DATA-01: 게시되는 commit·PR의 문구는 승인 때 고정한 값 그대로다', async () => {
  await withEnv(async env => {
    const key = await env.approve();
    const { publication } = ok(await env.store.approvalSubject(key)).subject;
    assert.equal((await env.publisher.publish(key)).kind, 'proposed');
    const commit = env.github.mutations(/git\/commits/)[0]!.body as Record<string, unknown>;
    assert.equal(commit.message, publication.commitMessage);
    assert.deepEqual(commit.author, publication.author);
    const pull = env.github.mutations(/\/pulls$/)[0]!.body as Record<string, unknown>;
    assert.equal(pull.title, publication.title);
    assert.equal(pull.body, publication.body);
    for (const item of env.github.mutations()) {
      assert.ok(!JSON.stringify(item.body).includes('공개 요청문'), '요청 원문이 공개 경로로 가지 않는다');
    }
  });
});

test('T19 B3 DATA-01: 승인 준비는 저장된 리뷰와 다른 receipt를 받지 않는다', async () => {
  await withEnv(async env => {
    const key = await env.newRequest();
    const review = await env.driveToReview(key, [{ path: 'src/a.ts', kind: 'modified', content: '수정\n' }]);
    const forged = await env.publisher.prepareApproval(key, { review: { ...review, findingsDigest: 'c'.repeat(64) }, at: 1 });
    assert.deepEqual(forged, { ok: false, reason: 'review_mismatch' });
    assert.equal(ok(await env.store.get(key.changeId)).phase, 'reviewing');
  });
});

test('T19 B3 DATA-01: 렌더러가 만든 문구도 같은 검사를 지나고 마스킹하지 않는다', () => {
  const base = { key: KEY, label: 'public' as const, bundle: fixtureBundle(), branch: `bot/change/${KEY.changeId}/g1`,
    verifications: [{ commandId: 'smoke-unit', status: 'passed' as const }], review: { verdict: 'pass' as const, risks: [] },
    identity: { name: 'fixture-writer[bot]', email: 'fixture-writer[bot]@users.noreply.github.com' }, at: Date.UTC(2026, 0, 2) };
  assert.deepEqual(renderPublication({ ...base, brief: fixtureBrief({ goal: `연결 ${TOKEN}` }) }, POLICY), { ok: false, reason: 'secret_detected' });
  assert.deepEqual(renderPublication({ ...base, brief: fixtureBrief({ goal: `연결 ${MARKER}` }) }, POLICY), { ok: false, reason: 'internal_marker' });
  assert.deepEqual(renderPublication({ ...base, brief: fixtureBrief({ acceptanceCriteria: ['123456789012345678 사용자에게 알림'] }) }, POLICY), { ok: false, reason: 'metadata_sensitive' });
  assert.equal(renderPublication({ ...base, brief: fixtureBrief() }, POLICY).ok, true);
});
