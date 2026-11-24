import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash, createPublicKey } from 'node:crypto';
import type { KeyObject } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterHandshake, canonicalJson, digestOf, verify } from '../src/olive-control.js';
import type { AwaitedRequest, Generations, HandshakeState, Party, VerifyContext, VerifyOutcome } from '../src/olive-control.js';

// olive-control/v2(후보) 표본 재생. olive 저장소의 표본 사본(test/fixtures/olive-control-v2/SOURCE.md)을 받는 쪽 문맥 그대로
// 검증하고 expect와 맞춘다. node --test는 시험이 0개인 파일도 통과시키므로 재생한 수와 F1b로 남긴 수를 정확한 수로 단언한다.
const ROOT = fileURLToPath(new URL('../../test/fixtures/olive-control-v2/', import.meta.url));

interface Fixture {
  fixture: string;
  name: string;
  status: string;
  expect: { ok: true; handshake_after: HandshakeState | null } | { ok: false; reason: string };
  keys: Record<string, string>;
  context: {
    now: number;
    expected_recipient: Party;
    own_policy_revision: string;
    handshake: HandshakeState;
    intake_open: boolean;
    generations: Generations;
    awaiting: Record<string, AwaitedRequest>;
    spent_nonces: { sender: Party; nonce: string }[];
  };
  message: { header: Record<string, unknown>; signature: string; body: unknown };
  signing_input: string;
}

interface Loaded {
  rel: string;
  bytes: Buffer;
  fx: Fixture;
}

const loaded: Loaded[] = ['accept', 'reject'].flatMap((kind) =>
  readdirSync(join(ROOT, kind)).filter((name) => name.endsWith('.json')).sort().map((name) => {
    const rel = `${kind}/${name}`;
    const bytes = readFileSync(join(ROOT, rel));
    return { rel, bytes, fx: JSON.parse(bytes.toString('utf8')) as Fixture };
  }));

const other = (party: Party): Party => (party === 'front-door' ? 'supervisor' : 'front-door');

function replay(fx: Fixture): { outcome: VerifyOutcome; consumed: number } {
  const keys = new Map<string, KeyObject>(Object.entries(fx.keys).map(([party, x]) =>
    [party, createPublicKey({ key: { kty: 'OKP', crv: 'Ed25519', x }, format: 'jwk' })]));
  const spent = new Set(fx.context.spent_nonces.map((spentNonce) => `${spentNonce.sender} ${spentNonce.nonce}`));
  let consumed = 0;
  const ctx: VerifyContext = {
    now: fx.context.now,
    expectedRecipient: fx.context.expected_recipient,
    publicKeyFor: (sender) => keys.get(sender),
    handshake: fx.context.handshake,
    intakeOpen: fx.context.intake_open,
    generations: fx.context.generations,
    awaiting: (requestId) => (Object.hasOwn(fx.context.awaiting, requestId) ? fx.context.awaiting[requestId] : undefined),
    nonces: {
      consume(sender, nonce) {
        consumed++;
        const key = `${sender} ${nonce}`;
        if (spent.has(key)) return false;
        spent.add(key);
        return true;
      },
    },
  };
  return { outcome: verify(structuredClone(fx.message), ctx), consumed };
}

// 공통부·정지 묶음의 동작. job_lookup·job_status는 다른 묶음의 작업도 가리킬 수 있다.
const F1_ACTIONS = new Set(['handshake', 'handshake_reply', 'job_lookup', 'job_status', 'stop_record_lookup', 'stop_record',
  'stop_prepare', 'stop_commit', 'release_prepare', 'release_commit']);
const STOP_EFFECTS = new Set(['stop_prepare', 'stop_commit', 'release_prepare', 'release_commit']);
// 본문 해석 단계와 그 뒤의 사유. F1b로 남긴 표본의 기대는 이 가운데 하나이거나 통과여야 한다(공통 단계에서 갈리는 표본은 F1이 재생).
const AFTER_BODY_PARSE = new Set(['body_malformed', 'unknown_field', 'reply_mismatch', 'replayed']);

const results = loaded.map((item) => ({ ...item, ...replay(item.fx) }));
const replayed = results.filter((result) => !('unsupported' in result.outcome));
const remaining = results.filter((result) => 'unsupported' in result.outcome);
const accepts = (list: typeof results) => list.filter((result) => result.fx.expect.ok).length;

test('표본 사본은 SOURCE.md의 목록·SHA-256과 같다(통과 46, 거절 93)', () => {
  const source = readFileSync(join(ROOT, 'SOURCE.md'), 'utf8');
  assert.match(source, /`1ec2ced2bd7a66cab842a61095536053b53e048b`/);
  const listed = new Map([...source.matchAll(/^([0-9a-f]{64}) {2}((?:accept|reject)\/[a-z0-9-]+\.json)$/gm)].map((m) => [m[2]!, m[1]!]));
  assert.equal(listed.size, 139);
  assert.deepEqual([...listed.keys()].sort(), loaded.map((item) => item.rel).sort());
  for (const item of loaded) assert.equal(createHash('sha256').update(item.bytes).digest('hex'), listed.get(item.rel), item.rel);
  assert.equal(loaded.filter((item) => item.rel.startsWith('accept/')).length, 46);
  assert.equal(loaded.filter((item) => item.rel.startsWith('reject/')).length, 93);
});

test('표본의 꼴: 후보 표시, 이름, 받는 쪽은 상대 키 하나만 믿는다', () => {
  for (const { rel, fx } of loaded) {
    assert.equal(fx.fixture, 'olive-control/v2', rel);
    assert.equal(fx.status, 'candidate', rel);
    assert.equal(`${fx.name}.json`, rel);
    assert.deepEqual(Object.keys(fx.keys), [other(fx.context.expected_recipient)], rel);
  }
});

test('독립 정규화가 표본 139개의 서명 입력과 본문 digest를 같은 바이트로 만든다', () => {
  const digestDiffers: string[] = [];
  for (const { rel, fx } of loaded) {
    assert.equal(canonicalJson(fx.message.header), fx.signing_input, rel);
    if (digestOf(fx.message.body) !== fx.message.header.body_digest) digestDiffers.push(rel);
  }
  // 서명 뒤 본문을 바꾼 표본 하나만 digest가 다르다.
  assert.deepEqual(digestDiffers, ['reject/body-changed-after-signing.json']);
});

test('재생 수: F1 84개(통과 21, 거절 63), F1b로 남김 55개(통과 25, 거절 30), 합 139', () => {
  assert.equal(results.length, 139);
  assert.equal(replayed.length, 84);
  assert.equal(accepts(replayed), 21);
  assert.equal(replayed.length - accepts(replayed), 63);
  assert.equal(remaining.length, 55);
  assert.equal(accepts(remaining), 25);
  assert.equal(remaining.length - accepts(remaining), 30);
});

test('공통부·정지 묶음 동작의 표본은 남김 없이 재생된다', () => {
  for (const { rel, fx, outcome } of remaining) {
    const action = String(fx.message.header.action);
    const body = fx.message.body as { action?: string; status?: { state?: string } };
    // F1 동작인데 남은 것은 다른 묶음 효과의 확정 결과(job_status confirmed)뿐이다.
    if (F1_ACTIONS.has(action)) {
      assert.equal(action, 'job_status', rel);
      assert.equal(body.status?.state, 'confirmed', rel);
      assert.equal(STOP_EFFECTS.has(String(body.action)), false, rel);
      assert.deepEqual(outcome, { ok: false, unsupported: body.action }, rel);
    } else {
      assert.deepEqual(outcome, { ok: false, unsupported: action }, rel);
    }
    if (!fx.expect.ok) assert.ok(AFTER_BODY_PARSE.has(fx.expect.reason), `${rel}: ${fx.expect.reason}`);
  }
});

test('F1b로 남긴 표본은 nonce를 쓰지 않는다', () => {
  for (const { rel, consumed } of remaining) assert.equal(consumed, 0, rel);
});

for (const { rel, fx, outcome, consumed } of replayed) {
  test(`재생 ${rel}`, () => {
    if (fx.expect.ok) {
      assert.equal(outcome.ok, true, `${rel}: ${JSON.stringify(outcome)}`);
      if (!outcome.ok) return;
      assert.equal(outcome.action, fx.message.header.action);
      const after = outcome.class === 'handshake' ? afterHandshake(outcome, fx.context.own_policy_revision) : null;
      assert.equal(after, fx.expect.handshake_after);
      assert.equal(consumed, 1);
    } else {
      assert.deepEqual(outcome, { ok: false, reason: fx.expect.reason });
      // nonce는 받아들일 봉투만 쓴다. 이미 쓴 nonce를 묻는 한 번만 예외다.
      assert.equal(consumed, fx.expect.reason === 'replayed' ? 1 : 0);
    }
  });
}
