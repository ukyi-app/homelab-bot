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
// 검증하고 expect와 맞춘다. node --test는 시험이 0개인 파일도 통과시키므로 재생한 수를 정확한 수로 단언한다(139개 전부, 남김 0).
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
// 본문 해석 단계와 그 뒤의 사유.
const AFTER_BODY_PARSE = new Set(['body_malformed', 'unknown_field', 'reply_mismatch', 'replayed']);
// 입력·이벤트·출력·후보 내용 묶음의 해석기가 판정을 정하는 표본: 그 묶음의 동작이거나 그 효과의 확정 결과를 실은 job_status이고,
// 기대가 통과이거나 본문 해석 뒤의 사유다. 세대 칸 단계(해석 전)의 body_malformed 하나는 공통 검사가 정한다.
const GENERATION_FIELD_STAGE = new Set(['reject/input-cancel-with-stop-generation.json']);
function needsBundleParsers({ rel, fx }: Loaded): boolean {
  const action = String(fx.message.header.action);
  const body = fx.message.body as { action?: string; status?: { state?: string } };
  const late = fx.expect.ok || AFTER_BODY_PARSE.has(fx.expect.reason);
  const bundleAction = !F1_ACTIONS.has(action)
    || (action === 'job_status' && body.status?.state === 'confirmed' && !STOP_EFFECTS.has(String(body.action)));
  return late && bundleAction && !GENERATION_FIELD_STAGE.has(rel);
}

const results = loaded.map((item) => ({ ...item, ...replay(item.fx) }));
const bundled = results.filter(needsBundleParsers);
const accepts = (list: typeof results) => list.filter((result) => result.fx.expect.ok).length;
const matches = (result: (typeof results)[number]): boolean => {
  const { fx, outcome } = result;
  return fx.expect.ok ? outcome.ok : !outcome.ok && outcome.reason === fx.expect.reason;
};

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

test('재생 수: 139개 전부가 expect와 같다(통과 46, 거절 93), 남김 0', () => {
  assert.equal(results.length, 139);
  const mismatched = results.filter((result) => !matches(result)).map((result) => result.rel);
  assert.deepEqual(mismatched, []);
  assert.equal(results.filter((result) => result.outcome.ok).length, 46);
  assert.equal(results.filter((result) => !result.outcome.ok).length, 93);
  // 결과는 통과나 거절 사유 둘뿐이다(해석기 없는 동작의 "받지 않음" 갈래가 없다).
  for (const { rel, outcome } of results) assert.ok(outcome.ok || Object.keys(outcome).join() === 'ok,reason', rel);
});

test('입력·이벤트·출력·후보 내용 묶음의 해석기가 정하는 표본 55개(통과 25, 거절 30), 공통부·정지 묶음 84개(통과 21)', () => {
  assert.equal(bundled.length, 55);
  assert.equal(accepts(bundled), 25);
  const reasons: Record<string, number> = {};
  for (const { fx } of bundled) if (!fx.expect.ok) reasons[fx.expect.reason] = (reasons[fx.expect.reason] ?? 0) + 1;
  assert.deepEqual(reasons, { body_malformed: 20, unknown_field: 7, reply_mismatch: 3 });
  for (const result of bundled) assert.ok(matches(result), result.rel);
  assert.equal(results.length - bundled.length, 84);
  assert.equal(accepts(results) - accepts(bundled), 21);
});

for (const { rel, fx, outcome, consumed } of results) {
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
