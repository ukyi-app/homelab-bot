import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash, generateKeyPairSync, sign } from 'node:crypto';
import type { KeyObject } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { SyntaxKind } from 'typescript/unstable/ast';
import { createScanner } from 'typescript/unstable/ast/scanner';
import {
  ACTIONS, afterHandshake, CanonicalError, canonicalJson, CLOCK_SKEW_MS, COMMON_FORBIDDEN_FIELD_NAMES, CONTRACT, digestOf,
  EFFECTS_DURING_POLICY_MISMATCH, EFFECTS_WITHOUT_GENERATIONS, freshIds, generationValueFault, MAX_DEPTH, MESSAGE_TTL_MAX_MS,
  NONCE_RETENTION_MS, NonceBook, normalizeFieldName, REJECT_REASONS, seal, SealError, stopRecordReply,
  SUPERVISOR_FORBIDDEN_FIELD_NAMES, verify,
} from '../src/olive-control.js';
import type {
  AwaitedRequest, Envelope, GenerationAuthority, GenerationRule, Party, StopLedgerRead, VerifyContext, VerifyOutcome,
} from '../src/olive-control.js';

// 표본 밖의 경계. 키는 이 파일에서 새로 만든다(표본의 키와 무관). 실제 효과·네트워크·파일 쓰기 없음.
const KEYS: Record<Party, { publicKey: KeyObject; privateKey: KeyObject }> = {
  'front-door': generateKeyPairSync('ed25519'),
  supervisor: generateKeyPairSync('ed25519'),
};
const NOW = 1_800_000_000_000;
const other = (party: Party): Party => (party === 'front-door' ? 'supervisor' : 'front-door');
const uuidOf = (n: number): string => '00000000-0000-4000-8000-' + n.toString(16).padStart(12, '0');
const nonceOf = (n: number): string => n.toString(16).padStart(32, '0');
let counter = 0x100;
const fresh = (): number => ++counter;
const SHA = 'a'.repeat(64);

function context(recipient: Party, over: Partial<VerifyContext> = {}): VerifyContext & { consumed: string[] } {
  const spent = new Set<string>();
  const consumed: string[] = [];
  return {
    now: NOW,
    expectedRecipient: recipient,
    publicKeyFor: (sender) => (sender === recipient ? undefined : KEYS[sender].publicKey),
    handshake: 'agreed',
    intakeOpen: true,
    generations: { stop: { known: true, current: 7, prepared: null }, execution: { known: true, current: 3, prepared: null } },
    awaiting: () => undefined,
    nonces: {
      consume(sender, nonce) {
        consumed.push(sender + ' ' + nonce);
        if (spent.has(sender + ' ' + nonce)) return false;
        spent.add(sender + ' ' + nonce);
        return true;
      },
    },
    consumed,
    ...over,
  };
}

function sealed(sender: Party, action: string, body: unknown, times: { issuedAt?: number; expiresAt?: number } = {}): Envelope {
  const n = fresh();
  return seal({
    sender, recipient: other(sender), action, requestId: uuidOf(n), nonce: nonceOf(n), issuedAt: times.issuedAt ?? NOW - 1_000,
    expiresAt: times.expiresAt, body,
  }, KEYS[sender].privateKey);
}

// seal이 막는 봉투(틀린 시한·머리, 정규화되지 않는 본문)를 만들려고 머리를 직접 서명한다.
function signedRaw(sender: Party, header: Record<string, unknown>, body: unknown, signer: Party = sender): Record<string, unknown> {
  const n = fresh();
  let digest = '0'.repeat(64);
  try {
    digest = digestOf(body);
  } catch {
    // 정규화되지 않는 본문: 받는 쪽은 digest 계산에서 body_malformed로 거절한다.
  }
  const full: Record<string, unknown> = {
    contract: CONTRACT, sender, recipient: other(sender), action: 'handshake', request_id: uuidOf(n), body_digest: digest,
    issued_at: NOW - 1_000, expires_at: NOW + 29_000, nonce: nonceOf(n), ...header,
  };
  let signature = 'A'.repeat(86);
  try {
    signature = sign(null, Buffer.from(canonicalJson(full), 'utf8'), KEYS[signer].privateKey).toString('base64url');
  } catch {
    // 정규화되지 않는 머리: 받는 쪽은 서명 전에 머리 모양에서 거절한다.
  }
  return { header: full, signature, body };
}

const reasonOf = (outcome: VerifyOutcome): string =>
  outcome.ok ? 'ok' : 'reason' in outcome ? outcome.reason : 'unsupported:' + outcome.unsupported;
const sealFault = (fn: () => unknown): string => {
  try {
    fn();
  } catch (error) {
    if (error instanceof SealError) return error.reason;
    throw error;
  }
  return 'sealed';
};
const canonicalFault = (value: unknown): string => {
  try {
    canonicalJson(value);
  } catch (error) {
    if (error instanceof CanonicalError) return error.fault;
    throw error;
  }
  return 'ok';
};
const HANDSHAKE = { policy_revision: 'policy-7' };
const atNone = (over: Partial<VerifyContext> = {}) => context('supervisor', { handshake: 'none', ...over });

// ---- 정규화 ----

test('정규화: 키는 UTF-16 코드 단위 순서다(BMP 밖 문자가 U+E000보다 앞, 대문자가 소문자보다 앞)', () => {
  const emoji = String.fromCodePoint(0x1f600);
  const privateUse = String.fromCharCode(0xe000);
  const value: Record<string, number> = { a: 3, B: 4, aa: 5, '': 6 };
  value[privateUse] = 1;
  value[emoji] = 2;
  assert.equal(canonicalJson(value), '{"":6,"B":4,"a":3,"aa":5,"' + emoji + '":2,"' + privateUse + '":1}');
  // 코드 포인트 순서였다면 U+E000이 U+1F600보다 앞이다.
  assert.ok(0xe000 < 0x1f600);
});

test('정규화: 문자열 이스케이프는 JCS와 같다(BMP의 서로게이트 밖 코드 단위 전부를 JSON.stringify와 대조)', () => {
  for (let unit = 0; unit <= 0xffff; unit++) {
    if (unit >= 0xd800 && unit <= 0xdfff) continue;
    const text = String.fromCharCode(unit);
    assert.equal(canonicalJson(text), JSON.stringify(text), 'U+' + unit.toString(16));
  }
  const BS = String.fromCharCode(92);
  const input = String.fromCharCode(0x00, 0x1f, 0x08, 0x09, 0x0a, 0x0c, 0x0d, 0x22, 0x5c, 0x2f, 0x7f, 0x2028, 0xe9);
  const expected = '"' + BS + 'u0000' + BS + 'u001f' + BS + 'b' + BS + 't' + BS + 'n' + BS + 'f' + BS + 'r' + BS + '"' + BS + BS
    + '/' + String.fromCharCode(0x7f, 0x2028, 0xe9) + '"';
  assert.equal(canonicalJson(input), expected);
  assert.equal(canonicalJson({ [String.fromCharCode(0x0a)]: String.fromCodePoint(0x1f600) }),
    '{"' + BS + 'n":"' + String.fromCodePoint(0x1f600) + '"}');
});

test('정규화: 짝 없는 서로게이트는 값과 키 모두 거절한다', () => {
  assert.equal(canonicalFault(String.fromCharCode(0xd800)), 'lone_surrogate');
  assert.equal(canonicalFault('a' + String.fromCharCode(0xdc00)), 'lone_surrogate');
  assert.equal(canonicalFault('a' + String.fromCharCode(0xd83d)), 'lone_surrogate');
  assert.equal(canonicalFault(String.fromCharCode(0xde00, 0xd83d)), 'lone_surrogate');
  assert.equal(canonicalFault({ [String.fromCharCode(0xdfff)]: 1 }), 'lone_surrogate');
  assert.equal(canonicalFault(String.fromCharCode(0xd83d, 0xde00)), 'ok');
});

test('정규화: 숫자는 안전 정수만, -0은 0', () => {
  assert.equal(canonicalJson(Number.MAX_SAFE_INTEGER), '9007199254740991');
  assert.equal(canonicalJson(-Number.MAX_SAFE_INTEGER), '-9007199254740991');
  assert.equal(canonicalJson(-0), '0');
  assert.equal(canonicalJson([0, -0, 1, -1]), '[0,0,1,-1]');
  for (const bad of [Number.MAX_SAFE_INTEGER + 1, -Number.MAX_SAFE_INTEGER - 1, 1.5, 1e21, 1e-7, Number.NaN, Infinity, -Infinity]) {
    assert.equal(canonicalFault(bad), 'not_safe_integer', String(bad));
  }
  assert.equal(digestOf({ n: -0 }), digestOf({ n: 0 }));
});

test('정규화: 깊이는 맨 위가 0이고 16까지 받는다', () => {
  assert.equal(MAX_DEPTH, 16);
  const nest = (depth: number, wrap: (inner: unknown) => unknown): unknown => {
    let value: unknown = 0;
    for (let i = 0; i < depth; i++) value = wrap(value);
    return value;
  };
  assert.equal(canonicalFault(nest(16, (inner) => [inner])), 'ok');
  assert.equal(canonicalFault(nest(17, (inner) => [inner])), 'too_deep');
  assert.equal(canonicalFault(nest(16, (inner) => ({ a: inner }))), 'ok');
  assert.equal(canonicalFault(nest(17, (inner) => ({ a: inner }))), 'too_deep');
  // 깊이 16의 빈 배열은 안에 값이 없어 받는다.
  let empty: unknown = [];
  for (let i = 0; i < 16; i++) empty = [empty];
  assert.equal(canonicalFault(empty), 'ok');
});

test('정규화: 공백 없음, 평범한 객체가 아닌 값과 빈 칸 배열은 거절', () => {
  assert.equal(canonicalJson({ b: [1, true, null, 'x'], a: {} }), '{"a":{},"b":[1,true,null,"x"]}');
  assert.equal(canonicalJson(Object.assign(Object.create(null) as object, { k: 1 })), '{"k":1}');
  // 빈 칸이 있는 배열: 길이만 늘린다.
  const sparse: unknown[] = [1];
  sparse.length = 2;
  assert.equal(canonicalFault(sparse), 'sparse_array');
  assert.equal(canonicalFault(new Date(0)), 'not_plain_object');
  assert.equal(canonicalFault(new Map()), 'not_plain_object');
  assert.equal(canonicalFault(Object.create({ inherited: 1 }) as object), 'not_plain_object');
  assert.equal(canonicalFault(undefined), 'unsupported_type');
  assert.equal(canonicalFault({ a: undefined }), 'unsupported_type');
  assert.equal(canonicalFault(1n), 'unsupported_type');
});

test('본문 digest는 정규 직렬화의 UTF-8 바이트에 대한 SHA-256(소문자 16진)이다', () => {
  const body = { policy_revision: 'p', note: 'é' + String.fromCodePoint(0x1f600) };
  assert.equal(digestOf(body), createHash('sha256').update(Buffer.from(canonicalJson(body), 'utf8')).digest('hex'));
  assert.match(digestOf(body), /^[0-9a-f]{64}$/);
});

// ---- 시한 ----

test('시한: 수명 30,000ms는 받고 30,001ms·0·음수는 lifetime_invalid', () => {
  assert.equal(MESSAGE_TTL_MAX_MS, 30_000);
  const ok = sealed('front-door', 'handshake', HANDSHAKE, { issuedAt: NOW - 1_000, expiresAt: NOW + 29_000 });
  assert.equal(reasonOf(verify(ok, atNone())), 'ok');
  assert.equal(sealFault(() => sealed('front-door', 'handshake', HANDSHAKE, { issuedAt: NOW - 1_000, expiresAt: NOW + 29_001 })),
    'lifetime_invalid');
  for (const expires of [NOW + 29_001, NOW - 1_000, NOW - 1_001]) {
    const raw = signedRaw('front-door', { issued_at: NOW - 1_000, expires_at: expires }, HANDSHAKE);
    assert.equal(reasonOf(verify(raw, atNone())), 'lifetime_invalid', String(expires - NOW));
  }
});

test('시한: 발급 시각은 받는 쪽 시계보다 1,000ms까지 앞서도 받고 1,001ms면 not_yet_valid', () => {
  assert.equal(CLOCK_SKEW_MS, 1_000);
  const edge = sealed('front-door', 'handshake', HANDSHAKE, { issuedAt: NOW + 1_000 });
  assert.equal(reasonOf(verify(edge, atNone())), 'ok');
  const early = sealed('front-door', 'handshake', HANDSHAKE, { issuedAt: NOW + 1_001 });
  assert.equal(reasonOf(verify(early, atNone())), 'not_yet_valid');
});

test('시한: 만료 1ms 전은 받고 만료 시각 정각은 expired(만료 쪽에는 시계 오차를 더하지 않는다)', () => {
  const before = sealed('front-door', 'handshake', HANDSHAKE, { issuedAt: NOW - 29_999, expiresAt: NOW + 1 });
  assert.equal(reasonOf(verify(before, atNone())), 'ok');
  const at = sealed('front-door', 'handshake', HANDSHAKE, { issuedAt: NOW - 30_000, expiresAt: NOW });
  assert.equal(reasonOf(verify(at, atNone())), 'expired');
});

// ---- 검증 순서 ----

test('검증 순서: 서명은 방향·시한보다 먼저다(틀린 서명의 만료 봉투는 bad_signature)', () => {
  const expiredBadSignature = signedRaw('front-door', { issued_at: NOW - 30_000, expires_at: NOW }, HANDSHAKE, 'supervisor');
  assert.equal(reasonOf(verify(expiredBadSignature, atNone())), 'bad_signature');
  const lifetimeBadSignature = signedRaw('front-door', { expires_at: NOW + 60_000 }, HANDSHAKE, 'supervisor');
  assert.equal(reasonOf(verify(lifetimeBadSignature, atNone())), 'bad_signature');
  const directionBadSignature = signedRaw('front-door', { action: 'stop_record_lookup' }, {}, 'supervisor');
  assert.equal(reasonOf(verify(directionBadSignature, context('supervisor'))), 'bad_signature');
  // 되돌아온 자기 봉투(받는 쪽이 키를 믿지 않음)도 시한보다 먼저다.
  const reflectedExpired = signedRaw('supervisor', { recipient: 'supervisor', issued_at: NOW - 30_000, expires_at: NOW }, {});
  assert.equal(reasonOf(verify(reflectedExpired, context('supervisor'))), 'unknown_sender');
});

test('검증 순서: 방향은 시한보다, 연결은 본문보다, 금지 칸은 모양보다, 세대 칸은 모양보다 먼저다', () => {
  const wrongDirectionExpired = signedRaw('front-door', { action: 'stop_record_lookup', issued_at: NOW - 30_000, expires_at: NOW }, {});
  assert.equal(reasonOf(verify(wrongDirectionExpired, context('supervisor'))), 'wrong_direction');
  const tamperedNoHandshake = sealed('front-door', 'stop_prepare', { job_id: uuidOf(1), stop_generation: 8 }) as unknown as
    Record<string, unknown>;
  tamperedNoHandshake.body = { job_id: uuidOf(1), stop_generation: 9 };
  assert.equal(reasonOf(verify(tamperedNoHandshake, atNone())), 'handshake_required');
  assert.equal(reasonOf(verify(tamperedNoHandshake, context('supervisor'))), 'digest_mismatch');
  const forbiddenAndUnknown = signedRaw('front-door', {}, { policy_revision: 'p', extra: 1, raw_text: 'x' });
  assert.equal(reasonOf(verify(forbiddenAndUnknown, atNone())), 'forbidden_field');
  const missingGenerationAndUnknown = signedRaw('front-door', { action: 'stop_prepare' }, { job_id: uuidOf(2), extra: 1 });
  assert.equal(reasonOf(verify(missingGenerationAndUnknown, context('supervisor'))), 'generation_missing');
  const deepBody = signedRaw('front-door', {}, { policy_revision: 'p', extra: [[[[[[[[[[[[[[[[[0]]]]]]]]]]]]]]]]] });
  assert.equal(reasonOf(verify(deepBody, atNone())), 'body_malformed');
});

test('검증 순서: 거절된 봉투는 nonce를 쓰지 않고, 쓴 nonce보다 다른 사유가 먼저다', () => {
  const ctx = context('supervisor', { handshake: 'policy_mismatch' });
  const release = sealed('front-door', 'release_prepare', { job_id: uuidOf(3), stop_generation: 7 });
  assert.equal(reasonOf(verify(release, ctx)), 'policy_mismatch');
  assert.deepEqual(ctx.consumed, []);
  const stop = sealed('front-door', 'stop_prepare', { job_id: uuidOf(4), stop_generation: 8 });
  assert.equal(reasonOf(verify(stop, ctx)), 'ok');
  assert.equal(ctx.consumed.length, 1);
  assert.equal(reasonOf(verify(stop, ctx)), 'replayed');
  // 같은 nonce가 이미 쓰였어도 연결 단계가 먼저 거절한다.
  assert.equal(reasonOf(verify(stop, { ...ctx, handshake: 'none' })), 'handshake_required');
});

// ---- nonce ----

test('nonce: 기록은 62,000ms 뒤에 지우고, 그때 다시 온 봉투는 시한에서 거절된다', () => {
  assert.equal(NONCE_RETENTION_MS, 62_000);
  let clock = NOW;
  const book = new NonceBook(() => clock);
  // 받는 쪽이 받아들일 수 있는 가장 늦게 만료되는 봉투: 발급이 시계 오차만큼 앞서고 수명이 상한.
  const latest = sealed('front-door', 'handshake', HANDSHAKE, { issuedAt: NOW + 1_000, expiresAt: NOW + 31_000 });
  const at = (time: number): VerifyOutcome => {
    clock = time;
    return verify(latest, { ...atNone(), now: time, nonces: book });
  };
  assert.equal(reasonOf(at(NOW)), 'ok');
  assert.equal(reasonOf(at(NOW + 30_999)), 'replayed');
  assert.equal(reasonOf(at(NOW + 31_000)), 'expired');
  clock = NOW + 61_999;
  book.prune();
  assert.equal(book.size, 1);
  clock = NOW + 62_000;
  book.prune();
  assert.equal(book.size, 0);
  assert.equal(reasonOf(at(NOW + 62_000)), 'expired');
  assert.equal(book.size, 0);
});

test('nonce: 낸 쪽마다 따로 센다', () => {
  const book = new NonceBook(() => NOW);
  assert.equal(book.consume('front-door', nonceOf(1), NOW), true);
  assert.equal(book.consume('front-door', nonceOf(1), NOW), false);
  assert.equal(book.consume('supervisor', nonceOf(1), NOW), true);
  const ids = freshIds();
  assert.match(ids.requestId, /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
  assert.match(ids.nonce, /^[0-9a-f]{32}$/);
});

// ---- 금지 칸 ----

test('금지 칸: 이름은 대소문자·-·_·공백을 지우고 대조하며 어느 깊이(배열 안 포함)든 막는다', () => {
  assert.equal(COMMON_FORBIDDEN_FIELD_NAMES.length, 40);
  assert.equal(SUPERVISOR_FORBIDDEN_FIELD_NAMES.length, 14);
  assert.equal(normalizeFieldName('Web Hook_URL'), 'webhookurl');
  assert.equal(normalizeFieldName('raw' + String.fromCharCode(9) + 'Text'), 'rawtext');
  for (const name of ['Raw-Message', 'RAW_TEXT', 'raw text', 'Api_Key', 'private-key', 'Credentials', 'Transcript', 'ENV']) {
    const raw = signedRaw('front-door', {}, { policy_revision: 'p', [name]: 'x' });
    assert.equal(reasonOf(verify(raw, atNone())), 'forbidden_field', name);
    assert.equal(sealFault(() => sealed('front-door', 'handshake', { policy_revision: 'p', [name]: 'x' })), 'forbidden_field', name);
  }
  const nested = signedRaw('front-door', {}, { policy_revision: 'p', x: [{ deep: [{ 'Original Text': 1 }] }] });
  assert.equal(reasonOf(verify(nested, atNone())), 'forbidden_field');
  // 값은 보지 않는다: 금지 이름이 값으로 오면 모양 단계의 거절이다.
  const asValue = signedRaw('front-door', {}, { policy_revision: 'token' });
  assert.equal(reasonOf(verify(asValue, atNone())), 'ok');
});

test('금지 칸: 승인·목적지·권한 이름은 감독이 낸 본문에서만 막는다', () => {
  const reply = (extra: Record<string, unknown>) => signedRaw('supervisor',
    { action: 'handshake_reply' }, { in_reply_to: uuidOf(9), policy_revision: 'p', ...extra });
  const awaiting = (id: string): AwaitedRequest | undefined => (id === uuidOf(9) ? { action: 'handshake', job: null } : undefined);
  const atFrontDoor = context('front-door', { handshake: 'none', awaiting });
  for (const name of ['approved', 'Channel-ID', 'webhook_url', 'Destinations', 'approvedBy', 'PERMISSION']) {
    assert.equal(reasonOf(verify(reply({ [name]: true }), atFrontDoor)), 'forbidden_field', name);
  }
  assert.equal(reasonOf(verify(reply({}), atFrontDoor)), 'ok');
  // 현관이 낸 본문의 같은 이름은 닫힌 객체의 모르는 칸이다.
  const stop = signedRaw('front-door', { action: 'stop_prepare' }, { job_id: uuidOf(10), stop_generation: 8, approved: true });
  assert.equal(reasonOf(verify(stop, context('supervisor'))), 'unknown_field');
});

// ---- 세대 ----

const known = (current: number, prepared: number | null = null): GenerationAuthority => ({ known: true, current, prepared });
const fits = (rule: GenerationRule, value: number, authority: GenerationAuthority): string =>
  generationValueFault(rule, value, authority) ?? 'ok';

test('세대 규칙 여섯의 경계', () => {
  for (const rule of ['current', 'next', 'newer', 'prepared_newer', 'prepared_current'] as const) {
    assert.equal(fits(rule, 1, { known: false }), 'generation_unknown', rule);
  }
  assert.equal(fits('not_applicable', 99, { known: false }), 'ok');
  // current
  assert.equal(fits('current', 7, known(7)), 'ok');
  assert.equal(fits('current', 6, known(7)), 'generation_mismatch');
  assert.equal(fits('current', 8, known(7)), 'generation_mismatch');
  // next
  assert.equal(fits('next', 4, known(3)), 'ok');
  assert.equal(fits('next', 3, known(3)), 'generation_mismatch');
  assert.equal(fits('next', 5, known(3)), 'generation_mismatch');
  // newer: 지금보다 커야 하고 건너뛴 세대는 받는다. 받아 둔 준비가 있으면 그 이상이어야 한다.
  assert.equal(fits('newer', 8, known(7)), 'ok');
  assert.equal(fits('newer', 12, known(7)), 'ok');
  assert.equal(fits('newer', 7, known(7)), 'generation_mismatch');
  assert.equal(fits('newer', 6, known(7)), 'generation_mismatch');
  assert.equal(fits('newer', 10, known(7, 10)), 'ok');
  assert.equal(fits('newer', 11, known(7, 10)), 'ok');
  assert.equal(fits('newer', 9, known(7, 10)), 'generation_mismatch');
  assert.equal(fits('newer', 8, known(8, 8)), 'generation_mismatch');
  assert.equal(fits('newer', 9, known(8, 8)), 'ok');
  // prepared_newer: 받아 둔 준비와 같고 그 준비가 지금보다 크다(정지 준비).
  assert.equal(fits('prepared_newer', 8, known(7, 8)), 'ok');
  assert.equal(fits('prepared_newer', 9, known(7, 8)), 'generation_mismatch');
  assert.equal(fits('prepared_newer', 7, known(7, 8)), 'generation_mismatch');
  assert.equal(fits('prepared_newer', 8, known(7)), 'generation_mismatch');
  assert.equal(fits('prepared_newer', 8, known(8, 8)), 'generation_mismatch');
  // prepared_current: 받아 둔 준비와 같고 그 준비가 지금과 같다(풀기 준비).
  assert.equal(fits('prepared_current', 8, known(8, 8)), 'ok');
  assert.equal(fits('prepared_current', 8, known(7, 8)), 'generation_mismatch');
  assert.equal(fits('prepared_current', 8, known(8)), 'generation_mismatch');
  assert.equal(fits('prepared_current', 7, known(8, 8)), 'generation_mismatch');
});

test('세대 칸: 요구하는 칸이 없으면 generation_missing, 막는 칸이 있거나 꼴이 틀리면 body_malformed, 칸이 값보다 먼저다', () => {
  const at = context('supervisor', {
    generations: { stop: known(8, 8), execution: known(3) },
  });
  const commit = (body: Record<string, unknown>) => verify(signedRaw('front-door', { action: 'release_commit' }, body), at);
  assert.equal(reasonOf(commit({ job_id: uuidOf(20), stop_generation: 8, execution_generation: 4 })), 'ok');
  assert.equal(reasonOf(commit({ job_id: uuidOf(21), stop_generation: 8 })), 'generation_missing');
  assert.equal(reasonOf(commit({ job_id: uuidOf(22), execution_generation: 4 })), 'generation_missing');
  // 정지 값은 틀렸지만(7) 실행 칸이 없다: 칸 단계가 먼저다.
  assert.equal(reasonOf(commit({ job_id: uuidOf(23), stop_generation: 7 })), 'generation_missing');
  assert.equal(reasonOf(commit({ job_id: uuidOf(24), stop_generation: -1, execution_generation: 4 })), 'body_malformed');
  assert.equal(reasonOf(commit({ job_id: uuidOf(25), stop_generation: '8', execution_generation: 4 })), 'body_malformed');
  // 값 단계는 정지 → 실행 순서다.
  const unknownExecution = context('supervisor', { generations: { stop: known(8, 8), execution: { known: false } } });
  const both = signedRaw('front-door', { action: 'release_commit' }, { job_id: uuidOf(26), stop_generation: 7, execution_generation: 4 });
  assert.equal(reasonOf(verify(both, unknownExecution)), 'generation_mismatch');
  const prepare = signedRaw('front-door', { action: 'stop_prepare' }, { job_id: uuidOf(27), stop_generation: 8, execution_generation: 3 });
  assert.equal(reasonOf(verify(prepare, context('supervisor'))), 'body_malformed');
  assert.equal(sealFault(() => sealed('front-door', 'stop_prepare', { job_id: uuidOf(28) })), 'generation_missing');
  assert.equal(sealFault(() => sealed('front-door', 'stop_prepare', { job_id: uuidOf(28), stop_generation: 8, execution_generation: 3 })),
    'body_malformed');
});

test('준비 칸 하나: 같은 번호라도 정지 준비 뒤 풀기 확정, 풀기 준비 뒤 정지 확정은 generation_mismatch', () => {
  const withStop = (stop: GenerationAuthority) => context('supervisor', { generations: { stop, execution: known(3) } });
  const releaseCommit = sealed('front-door', 'release_commit', { job_id: uuidOf(30), stop_generation: 8, execution_generation: 4 });
  const stopCommit = sealed('front-door', 'stop_commit', { job_id: uuidOf(31), stop_generation: 8 });
  // 지금 7에서 정지 준비 8만 받아 둠
  assert.equal(reasonOf(verify(releaseCommit, withStop(known(7, 8)))), 'generation_mismatch');
  assert.equal(reasonOf(verify(stopCommit, withStop(known(7, 8)))), 'ok');
  // 지금 8에서 풀기 준비 8만 받아 둠
  assert.equal(reasonOf(verify(stopCommit, withStop(known(8, 8)))), 'generation_mismatch');
  assert.equal(reasonOf(verify(releaseCommit, withStop(known(8, 8)))), 'ok');
  // 새 정지 준비 9가 준비 칸을 덮은 뒤 늦게 온 풀기 확정: 정지가 이긴다
  assert.equal(reasonOf(verify(releaseCommit, withStop(known(8, 9)))), 'generation_mismatch');
  // 실행 세대를 이미 올린 뒤의 재전달
  const raised = context('supervisor', { generations: { stop: known(8, 8), execution: known(4) } });
  assert.equal(reasonOf(verify(releaseCommit, raised)), 'generation_mismatch');
});

// ---- 정지 기록 답 ----

test('정지 기록 답: 읽기 실패에서는 답을 만들지 않는다(absent로 바꾸지 않음)', () => {
  const request = uuidOf(40);
  assert.equal(stopRecordReply(request, { state: 'unreadable' }), null);
  assert.deepEqual(stopRecordReply(request, { state: 'absent' }), { in_reply_to: request, record: { state: 'absent' } });
  assert.deepEqual(stopRecordReply(request, { state: 'recorded', generation: 7, stopped: true }),
    { in_reply_to: request, record: { state: 'recorded', generation: 7, stopped: true } });
  assert.deepEqual(stopRecordReply(request, { state: 'recorded', generation: 0, stopped: false }),
    { in_reply_to: request, record: { state: 'recorded', generation: 0, stopped: false } });
  for (const generation of [-1, 1.5, -0, Number.MAX_SAFE_INTEGER + 1, Number.NaN]) {
    assert.equal(stopRecordReply(request, { state: 'recorded', generation, stopped: true }), null, String(generation));
  }
  assert.equal(stopRecordReply(request, { state: 'recorded', generation: 7, stopped: 'yes' } as unknown as StopLedgerRead), null);
  assert.equal(stopRecordReply(request, {} as unknown as StopLedgerRead), null);
  assert.equal(stopRecordReply(request, { state: 'missing' } as unknown as StopLedgerRead), null);
  assert.equal(stopRecordReply('not-a-uuid', { state: 'absent' }), null);
});

test('정지 기록 답: 칸 집합이 갈래와 다른 모순된 행은 읽기 실패와 같이 답하지 않는다', () => {
  const request = uuidOf(41);
  const rows: unknown[] = [
    { state: 'absent', generation: 7, stopped: true },
    { state: 'absent', stopped: false },
    { state: 'recorded', generation: 7, stopped: true, extra: 1 },
    { state: 'recorded', generation: 7 },
    { state: 'unreadable', generation: 7, stopped: true },
    null,
    [],
    'absent',
  ];
  for (const row of rows) {
    assert.equal(stopRecordReply(request, row as StopLedgerRead), null, JSON.stringify(row));
  }
  // 프로토타입이 없는 객체도 평범한 객체로 읽는다(칸 집합만 본다).
  const bare = Object.assign(Object.create(null) as Record<string, unknown>, { state: 'absent' });
  assert.deepEqual(stopRecordReply(request, bare as StopLedgerRead), { in_reply_to: request, record: { state: 'absent' } });
});

test('정지 기록 답: 만든 본문은 감독의 검증을 그대로 지나고, 꼴이 틀린 기록은 거절된다', () => {
  const lookup = sealed('supervisor', 'stop_record_lookup', {});
  const awaiting = (id: string): AwaitedRequest | undefined =>
    (id === lookup.header.request_id ? { action: 'stop_record_lookup', job: null } : undefined);
  // 복원 1단계: 감독은 세대를 모르고 정책도 어긋날 수 있다.
  const atSupervisor = () => context('supervisor', {
    handshake: 'policy_mismatch', intakeOpen: false, awaiting,
    generations: { stop: { known: false }, execution: { known: false } },
  });
  assert.equal(reasonOf(verify(lookup, context('front-door', { handshake: 'policy_mismatch', intakeOpen: false }))), 'ok');
  for (const read of [{ state: 'absent' }, { state: 'recorded', generation: 9, stopped: false }] as const) {
    const body = stopRecordReply(lookup.header.request_id, read);
    assert.ok(body !== null);
    const outcome = verify(sealed('front-door', 'stop_record', body), atSupervisor());
    assert.equal(outcome.ok, true);
    if (outcome.ok) assert.deepEqual(outcome.body, body);
  }
  const reply = (record: unknown) => signedRaw('front-door', { action: 'stop_record' }, { in_reply_to: lookup.header.request_id, record });
  assert.equal(reasonOf(verify(reply({}), atSupervisor())), 'body_malformed');
  assert.equal(reasonOf(verify(reply(null), atSupervisor())), 'body_malformed');
  assert.equal(reasonOf(verify(reply({ state: 'recorded', generation: 7 }), atSupervisor())), 'body_malformed');
  assert.equal(reasonOf(verify(reply({ state: 'recorded', generation: 7, stopped: 1 }), atSupervisor())), 'body_malformed');
  assert.equal(reasonOf(verify(reply({ state: 'absent', generation: 7 }), atSupervisor())), 'unknown_field');
  assert.equal(reasonOf(verify(reply({ state: 'unknown' }), atSupervisor())), 'body_malformed');
});

// ---- 봉투 ----

test('봉투 모양: 세 칸 밖은 unknown_field, 빠진 칸·틀린 머리는 malformed, 판·동작이 먼저다', () => {
  const good = sealed('front-door', 'handshake', HANDSHAKE) as unknown as Record<string, unknown>;
  const header = good.header as Record<string, unknown>;
  const ctx = atNone;
  assert.equal(reasonOf(verify({ ...good, extra: 1 }, ctx())), 'unknown_field');
  assert.equal(reasonOf(verify({ header, signature: good.signature }, ctx())), 'malformed');
  assert.equal(reasonOf(verify([good], ctx())), 'malformed');
  assert.equal(reasonOf(verify({ ...good, header: [header] }, ctx())), 'malformed');
  const { contract: _contract, ...withoutContract } = header;
  assert.equal(reasonOf(verify({ ...good, header: withoutContract }, ctx())), 'contract_mismatch');
  assert.equal(reasonOf(verify({ ...good, header: { ...header, contract: 'olive-control/v1', action: 'nope' } }, ctx())),
    'contract_mismatch');
  assert.equal(reasonOf(verify({ ...good, header: { ...header, action: 'Task-Start' } }, ctx())), 'unknown_action');
  assert.equal(reasonOf(verify({ ...good, header: { ...header, action: 'task_start', nonce: 1 } }, ctx())), 'unknown_action');
  assert.equal(reasonOf(verify({ ...good, header: { ...header, run_generation: 0 } }, ctx())), 'unknown_field');
  assert.equal(reasonOf(verify({ ...good, header: { ...header, request_id: 'ABCDEF00-0000-4000-8000-000000000001' } }, ctx())),
    'malformed');
  assert.equal(reasonOf(verify({ ...good, header: { ...header, nonce: nonceOf(1).slice(1) } }, ctx())), 'malformed');
  assert.equal(reasonOf(verify({ ...good, header: { ...header, issued_at: 0 } }, ctx())), 'malformed');
  assert.equal(reasonOf(verify({ ...good, header: { ...header, sender: 'executor/x' } }, ctx())), 'malformed');
});

test('서명 표기: 86자 base64url 하나만 받는다(같은 바이트의 다른 표기, 패딩, 길이는 bad_signature)', () => {
  const good = sealed('front-door', 'handshake', HANDSHAKE);
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';
  const last = good.signature.at(-1)!;
  const sibling = good.signature.slice(0, -1) + alphabet[alphabet.indexOf(last) ^ 1];
  // 남는 두 비트만 다른 표기라 해석한 바이트가 같다.
  assert.deepEqual(Buffer.from(sibling, 'base64url'), Buffer.from(good.signature, 'base64url'));
  for (const signature of [sibling, good.signature.slice(0, -1), good.signature + '==', good.signature + 'A', 1]) {
    assert.equal(reasonOf(verify({ ...good, signature }, atNone())), 'bad_signature', String(signature));
  }
  assert.equal(reasonOf(verify(good, atNone())), 'ok');
});

test('받는 쪽: 두 키를 모두 믿는 인위적 문맥에서만 wrong_recipient에 닿는다', () => {
  const both = (sender: Party) => KEYS[sender].publicKey;
  const handshake = sealed('front-door', 'handshake', HANDSHAKE);
  assert.equal(reasonOf(verify(handshake, context('front-door', { handshake: 'none', publicKeyFor: both }))), 'wrong_recipient');
  assert.equal(reasonOf(verify(handshake, context('front-door', { handshake: 'none' }))), 'unknown_sender');
  const self = signedRaw('front-door', { recipient: 'front-door' }, HANDSHAKE);
  assert.equal(reasonOf(verify(self, context('front-door', { handshake: 'none', publicKeyFor: both }))), 'wrong_direction');
});

// ---- 연결 ----

test('연결: 인사 상태·정책·접수', () => {
  const lookup = sealed('supervisor', 'stop_record_lookup', {});
  const at = (over: Partial<VerifyContext>) => reasonOf(verify(lookup, context('front-door', over)));
  assert.equal(at({ handshake: 'none' }), 'handshake_required');
  assert.equal(at({ handshake: 'policy_mismatch', intakeOpen: false }), 'ok');
  const stop = sealed('front-door', 'stop_prepare', { job_id: uuidOf(50), stop_generation: 8 });
  assert.equal(reasonOf(verify(stop, context('supervisor', { handshake: 'none' }))), 'handshake_required');
  assert.equal(reasonOf(verify(stop, context('supervisor', { handshake: 'policy_mismatch', intakeOpen: false }))), 'ok');
  for (const action of ['release_prepare', 'release_commit'] as const) {
    const body = action === 'release_prepare'
      ? { job_id: uuidOf(51), stop_generation: 8 } : { job_id: uuidOf(52), stop_generation: 8, execution_generation: 4 };
    const envelope = sealed('front-door', action, body);
    const generations = { stop: known(8, 8), execution: known(3) };
    assert.equal(reasonOf(verify(envelope, context('supervisor', { handshake: 'policy_mismatch', generations }))), 'policy_mismatch');
    assert.equal(reasonOf(verify(envelope, context('supervisor', { intakeOpen: false, generations }))), 'ok', action);
  }
  const reply = sealed('supervisor', 'handshake_reply', { in_reply_to: uuidOf(53), policy_revision: 'p' });
  const awaiting = (): AwaitedRequest => ({ action: 'handshake', job: null });
  assert.equal(reasonOf(verify(reply, context('front-door', { handshake: 'agreed', awaiting }))), 'handshake_repeated');
  assert.equal(reasonOf(verify(reply, context('front-door', { handshake: 'none', awaiting, intakeOpen: false }))), 'ok');
});

// ---- 작업 조회 ----

test('작업 조회: 효과의 답은 기다리는 작업과 셋(job_id·action·request_digest)이 같아야 하고 방향이 맞아야 한다', () => {
  const prepare = sealed('front-door', 'stop_prepare', { job_id: uuidOf(60), stop_generation: 8 });
  const received = verify(prepare, context('supervisor'));
  assert.equal(received.ok, true);
  if (!received.ok) return;
  assert.deepEqual(received.job, { job_id: uuidOf(60), action: 'stop_prepare', request_digest: prepare.header.body_digest });
  const status = (over: Record<string, unknown> = {}) => sealed('supervisor', 'job_status', {
    in_reply_to: prepare.header.request_id, job_id: uuidOf(60), action: 'stop_prepare', request_digest: prepare.header.body_digest,
    status: { state: 'confirmed', result: { outcome: 'prepared' } }, ...over,
  });
  const waiting = (awaited: AwaitedRequest | undefined) => context('front-door', {
    awaiting: (id) => (id === prepare.header.request_id ? awaited : undefined),
  });
  const asSent: AwaitedRequest = { action: 'stop_prepare', job: received.job };
  assert.equal(reasonOf(verify(status(), waiting(asSent))), 'ok');
  assert.equal(reasonOf(verify(status({ request_digest: SHA }), waiting(asSent))), 'reply_mismatch');
  assert.equal(reasonOf(verify(status({ job_id: uuidOf(61) }), waiting(asSent))), 'reply_mismatch');
  assert.equal(reasonOf(verify(status({ action: 'stop_commit', status: { state: 'pending' } }), waiting(asSent))), 'reply_mismatch');
  assert.equal(reasonOf(verify(status(), waiting({ action: 'stop_prepare', job: null }))), 'reply_mismatch');
  assert.equal(reasonOf(verify(status(), waiting({ action: 'handshake', job: received.job }))), 'reply_mismatch');
  assert.equal(reasonOf(verify(status(), waiting(undefined))), 'reply_mismatch');
  assert.equal(reasonOf(verify(status({ status: { state: 'pending' } }), waiting(asSent))), 'ok');
  // seal이 막는 꼴이라 머리를 직접 서명한다.
  const statusRaw = (value: unknown) => signedRaw('supervisor', { action: 'job_status' }, {
    in_reply_to: prepare.header.request_id, job_id: uuidOf(60), action: 'stop_prepare', request_digest: prepare.header.body_digest,
    status: value,
  });
  assert.equal(reasonOf(verify(statusRaw({ state: 'unknown', result: { outcome: 'prepared' } }), waiting(asSent))), 'unknown_field');
  assert.equal(reasonOf(verify(statusRaw({ state: 'done' }), waiting(asSent))), 'body_malformed');
  assert.equal(reasonOf(verify(statusRaw({ state: 'confirmed' }), waiting(asSent))), 'body_malformed');
  // 조회의 방향: 감독은 현관만 내는 효과를 묻지 못하고, 현관은 그 결과를 감독에게 답하지 못한다.
  const lookupBody = { job_id: uuidOf(60), action: 'stop_prepare', request_digest: prepare.header.body_digest };
  assert.equal(sealFault(() => sealed('supervisor', 'job_lookup', lookupBody)), 'body_malformed');
  assert.equal(sealFault(() => sealed('front-door', 'job_status', {
    in_reply_to: uuidOf(62), ...lookupBody, status: { state: 'pending' },
  })), 'body_malformed');
  const lookup = sealed('front-door', 'job_lookup', lookupBody);
  assert.equal(reasonOf(verify(lookup, context('supervisor', { handshake: 'policy_mismatch', intakeOpen: false }))), 'ok');
  const viaLookup = sealed('supervisor', 'job_status', {
    in_reply_to: lookup.header.request_id, ...lookupBody, status: { state: 'confirmed', result: { outcome: 'prepared' } },
  });
  const lookupWaiting = context('front-door', {
    handshake: 'policy_mismatch',
    awaiting: (id) => (id === lookup.header.request_id ? { action: 'job_lookup', job: received.job } : undefined),
  });
  assert.equal(reasonOf(verify(viaLookup, lookupWaiting)), 'ok');
});

test('확정 결과의 꼴: 정지 확정에는 거절이 없고, 풀기 준비는 실행 세대 2 이상을 약속한다', () => {
  const result = (action: string, value: unknown) => {
    const job = { job_id: uuidOf(70), action, request_digest: SHA };
    const envelope = signedRaw('supervisor', { action: 'job_status' },
      { in_reply_to: uuidOf(71), ...job, status: { state: 'confirmed', result: value } });
    return reasonOf(verify(envelope, context('front-door', { awaiting: () => ({ action, job }) })));
  };
  assert.equal(result('stop_prepare', { outcome: 'prepared' }), 'ok');
  assert.equal(result('stop_commit', { outcome: 'stopped' }), 'ok');
  assert.equal(result('stop_commit', { outcome: 'refused' }), 'body_malformed');
  assert.equal(result('release_prepare', { outcome: 'prepared', execution_generation: 2 }), 'ok');
  assert.equal(result('release_prepare', { outcome: 'prepared', execution_generation: 1 }), 'body_malformed');
  assert.equal(result('release_prepare', { outcome: 'prepared' }), 'body_malformed');
  assert.equal(result('release_prepare', { outcome: 'refused' }), 'ok');
  assert.equal(result('release_prepare', { outcome: 'refused', execution_generation: 2 }), 'unknown_field');
  assert.equal(result('release_commit', { outcome: 'released' }), 'ok');
  assert.equal(result('release_commit', { outcome: 'refused' }), 'ok');
  assert.equal(result('release_commit', { outcome: 'not_posted' }), 'body_malformed');
});

test('확정 결과의 꼴: 갈래가 하나인 정지 결과도 모르는 칸이 outcome 값보다 먼저다(verify·seal 같은 사유)', () => {
  const job = (action: string) => ({ job_id: uuidOf(72), action, request_digest: SHA });
  const body = (action: string, value: unknown) => ({ in_reply_to: uuidOf(73), ...job(action), status: { state: 'confirmed', result: value } });
  const viaVerify = (action: string, value: unknown) => reasonOf(verify(signedRaw('supervisor', { action: 'job_status' }, body(action, value)),
    context('front-door', { awaiting: () => ({ action, job: job(action) }) })));
  const viaSeal = (action: string, value: unknown) => sealFault(() => sealed('supervisor', 'job_status', body(action, value)));
  const cases: [string, unknown, string][] = [
    ['stop_commit', { outcome: 'other', note: 1 }, 'unknown_field'],
    ['stop_commit', { note: 1 }, 'unknown_field'],
    ['stop_commit', { outcome: 'stopped', note: 1 }, 'unknown_field'],
    ['stop_commit', { outcome: 'other' }, 'body_malformed'],
    ['stop_commit', {}, 'body_malformed'],
    ['stop_commit', null, 'body_malformed'],
    ['stop_prepare', { outcome: 'other', note: 1 }, 'unknown_field'],
    ['stop_prepare', { note: 1 }, 'unknown_field'],
    ['stop_prepare', { outcome: 'prepared', note: 1 }, 'unknown_field'],
    ['stop_prepare', { outcome: 'stopped' }, 'body_malformed'],
  ];
  for (const [action, value, reason] of cases) {
    assert.equal(viaVerify(action, value), reason, action + ' verify ' + JSON.stringify(value));
    assert.equal(viaSeal(action, value), reason, action + ' seal ' + JSON.stringify(value));
  }
});

// ---- 이 조각 밖의 묶음 ----

test('F1b 묶음의 동작은 공통 검사를 모두 거친 뒤 Unsupported로 받지 않고 nonce를 쓰지 않는다', () => {
  const body = {
    job_id: uuidOf(80), stop_generation: 7, source: 'admin',
    source_ref: { ref: 'raw/' + uuidOf(81), digest: SHA, expires_at: NOW + 1_000 },
  };
  const submit = signedRaw('front-door', { action: 'input_submit' }, body);
  const ctx = context('supervisor');
  assert.deepEqual(verify(submit, ctx), { ok: false, unsupported: 'input_submit' });
  assert.deepEqual(ctx.consumed, []);
  assert.equal(reasonOf(verify(submit, context('supervisor', { intakeOpen: false }))), 'intake_closed');
  assert.equal(reasonOf(verify(submit, context('supervisor', { handshake: 'policy_mismatch' }))), 'policy_mismatch');
  const old = signedRaw('front-door', { action: 'input_submit' }, { ...body, stop_generation: 6 });
  assert.equal(reasonOf(verify(old, context('supervisor'))), 'generation_mismatch');
  assert.equal(sealFault(() => sealed('front-door', 'input_submit', body)), 'unsupported');
  // 다른 묶음 효과의 확정 결과도 해석기가 없다. 확정이 아닌 답은 공통부만으로 받는다.
  const job = { job_id: uuidOf(82), action: 'publication_candidate', request_digest: SHA };
  const answer = (status: unknown) => signedRaw('front-door', { action: 'job_status' }, { in_reply_to: uuidOf(83), ...job, status });
  const waiting = context('supervisor', { awaiting: () => ({ action: 'job_lookup', job }) });
  assert.deepEqual(verify(answer({ state: 'confirmed', result: { outcome: 'not_posted' } }), waiting),
    { ok: false, unsupported: 'publication_candidate' });
  assert.equal(reasonOf(verify(answer({ state: 'unknown' }), waiting)), 'ok');
});

// ---- 동작 표 ----

test('동작 표: 스물넷의 분류·방향·접수·정책·세대가 v2 문서의 전체 동작 표와 같다', () => {
  const NA = 'not_applicable';
  const FD = 'front-door';
  const SV = 'supervisor';
  // [동작, 분류, 보내는 쪽, 접수가 닫혀도, 정책이 어긋나도(인사는 null), 정지 세대, 실행 세대, 이 조각의 본문 해석기]
  const rows: [string, string, string[], boolean, boolean | null, string | null, string | null, boolean][] = [
    ['handshake', 'handshake', [FD], true, null, null, null, true],
    ['handshake_reply', 'handshake', [SV], true, null, null, null, true],
    ['job_lookup', 'query', [FD, SV], true, true, null, null, true],
    ['job_status', 'query', [FD, SV], true, true, null, null, true],
    ['stop_record_lookup', 'query', [SV], true, true, null, null, true],
    ['stop_record', 'query', [FD], true, true, null, null, true],
    ['stop_prepare', 'effect', [FD], true, true, 'newer', NA, true],
    ['stop_commit', 'effect', [FD], true, true, 'prepared_newer', NA, true],
    ['release_prepare', 'effect', [FD], true, false, 'current', NA, true],
    ['release_commit', 'effect', [FD], true, false, 'prepared_current', 'next', true],
    ['input_submit', 'effect', [FD], false, false, 'current', NA, false],
    ['input_cancel', 'effect', [FD], true, false, NA, NA, false],
    ['approval_changed', 'effect', [FD], true, false, 'current', NA, false],
    ['publication_changed', 'effect', [FD], true, false, NA, NA, false],
    ['merge_observed', 'effect', [FD], true, false, NA, NA, false],
    ['source_forgotten', 'effect', [FD], true, false, NA, NA, false],
    ['reply_candidate', 'effect', [SV], false, false, 'current', 'current', false],
    ['approval_card_request', 'effect', [SV], false, false, 'current', 'current', false],
    ['publication_candidate', 'effect', [SV], false, false, 'current', 'current', false],
    ['progress_update', 'effect', [SV], false, false, 'current', 'current', false],
    ['execution_generation_lookup', 'query', [FD], true, true, null, null, false],
    ['execution_generation_reply', 'query', [SV], true, true, null, null, false],
    ['candidate_fetch', 'query', [FD], true, false, null, null, false],
    ['candidate_chunk', 'query', [SV], true, false, null, null, false],
  ];
  assert.equal(ACTIONS.size, 24);
  assert.deepEqual([...ACTIONS.keys()], rows.map((row) => row[0]));
  for (const [name, kind, from, closed, policy, stop, execution, parsed] of rows) {
    const spec = ACTIONS.get(name)!;
    assert.equal(spec.class, kind, name);
    assert.deepEqual([...spec.from], from, name);
    assert.equal(spec.duringClosedIntake, closed, name);
    if (policy !== null) assert.equal(spec.duringPolicyMismatch, policy, name);
    assert.deepEqual(spec.generations === null ? [null, null] : [spec.generations.stop, spec.generations.execution], [stop, execution], name);
    assert.equal(spec.parse !== null, parsed, name);
  }
  assert.deepEqual([...EFFECTS_DURING_POLICY_MISMATCH], ['stop_prepare', 'stop_commit']);
  assert.deepEqual([...EFFECTS_WITHOUT_GENERATIONS], ['input_cancel', 'publication_changed', 'merge_observed', 'source_forgotten']);
  assert.equal(REJECT_REASONS.length, 23);
  assert.deepEqual(ACTIONS.get('handshake_reply')!.answers, ['handshake']);
  assert.deepEqual(ACTIONS.get('stop_record')!.answers, ['stop_record_lookup']);
  assert.equal(ACTIONS.get('job_status')!.answers!.length, 15);
});

test('동작 표: 공개한 표와 그 행·배열·세대 객체는 동결되어 검증이 보는 표를 바꿀 수 없다', () => {
  assert.ok(Object.isFrozen(ACTIONS));
  for (const [name, spec] of ACTIONS) {
    assert.ok(Object.isFrozen(spec), name);
    assert.ok(Object.isFrozen(spec.from), name);
    if (spec.generations !== null) assert.ok(Object.isFrozen(spec.generations), name);
    if (spec.answers !== null) assert.ok(Object.isFrozen(spec.answers), name);
  }
  const table = ACTIONS as unknown as Record<string, unknown>;
  assert.throws(() => Map.prototype.set.call(ACTIONS, 'stop_commit', ACTIONS.get('handshake')), TypeError);
  assert.throws(() => Map.prototype.delete.call(ACTIONS, 'stop_commit'), TypeError);
  assert.throws(() => { table.get = () => undefined; }, TypeError);
  const commit = ACTIONS.get('stop_commit') as unknown as { from: string[]; generations: Record<string, string> };
  assert.throws(() => { commit.from.push('supervisor'); }, TypeError);
  assert.throws(() => { commit.generations.stop = 'not_applicable'; }, TypeError);
  // 시도 뒤에도 검증은 같은 표를 본다: 감독은 여전히 stop_commit을 낼 수 없다.
  assert.deepEqual([...ACTIONS.get('stop_commit')!.from], ['front-door']);
  assert.equal(sealFault(() => sealed('supervisor', 'stop_commit', { job_id: uuidOf(74), stop_generation: 8 })), 'wrong_direction');
});

test('인사 뒤 상태: 정책 revision이 글자 그대로 같을 때만 agreed', () => {
  const at = atNone();
  const handshake = verify(sealed('front-door', 'handshake', { policy_revision: 'policy-7' }), at);
  assert.equal(handshake.ok, true);
  if (!handshake.ok) return;
  assert.equal(afterHandshake(handshake, 'policy-7'), 'agreed');
  assert.equal(afterHandshake(handshake, 'Policy-7'), 'policy_mismatch');
  const record = verify(sealed('supervisor', 'stop_record_lookup', {}), context('front-door'));
  assert.equal(record.ok, true);
  if (record.ok) assert.throws(() => afterHandshake(record, 'policy-7'));
  assert.equal(sealFault(() => sealed('front-door', 'handshake', { policy_revision: '' })), 'body_malformed');
  assert.equal(sealFault(() => sealed('front-door', 'handshake', { policy_revision: 'x'.repeat(65) })), 'body_malformed');
  assert.equal(sealFault(() => sealed('front-door', 'handshake', { policy_revision: 'x'.repeat(64) })), 'sealed');
  assert.equal(sealFault(() => sealed('supervisor', 'handshake', HANDSHAKE)), 'wrong_direction');
  assert.equal(sealFault(() => sealed('front-door', 'nope', HANDSHAKE)), 'unknown_action');
});

// ---- 정적 ----

// import·export의 from 뒤 문자열과 부수 효과 import의 문자열. 인용부호 종류·줄바꿈과 상관없이 TypeScript의 토큰 분석기로 뽑는다.
// 정규식 리터럴과 템플릿 안의 글자가 문자열 토큰으로 읽히지 않게 그 둘은 다시 훑는다.
function moduleSpecifiers(source: string): string[] {
  const valueEnds = new Set<SyntaxKind>([
    SyntaxKind.Identifier, SyntaxKind.NumericLiteral, SyntaxKind.BigIntLiteral, SyntaxKind.StringLiteral,
    SyntaxKind.NoSubstitutionTemplateLiteral, SyntaxKind.TemplateTail, SyntaxKind.RegularExpressionLiteral, SyntaxKind.CloseParenToken,
    SyntaxKind.CloseBracketToken, SyntaxKind.ThisKeyword, SyntaxKind.TrueKeyword, SyntaxKind.FalseKeyword, SyntaxKind.NullKeyword,
    SyntaxKind.PlusPlusToken, SyntaxKind.MinusMinusToken,
  ]);
  const scanner = createScanner(true);
  scanner.setText(source);
  const found: string[] = [];
  // 열린 중괄호마다 템플릿 치환을 닫는 것인지 적는다.
  const braces: boolean[] = [];
  let previous: SyntaxKind = SyntaxKind.Unknown;
  for (let token = scanner.scan(); token !== SyntaxKind.EndOfFile; token = scanner.scan()) {
    if ((token === SyntaxKind.SlashToken || token === SyntaxKind.SlashEqualsToken) && !valueEnds.has(previous)) {
      token = scanner.reScanSlashToken();
    }
    if (token === SyntaxKind.TemplateHead || token === SyntaxKind.OpenBraceToken) {
      braces.push(token === SyntaxKind.TemplateHead);
    } else if (token === SyntaxKind.CloseBraceToken && braces.pop() === true) {
      token = scanner.reScanTemplateToken(false);
      if (token === SyntaxKind.TemplateMiddle) braces.push(true);
    }
    if (token === SyntaxKind.StringLiteral && (previous === SyntaxKind.FromKeyword || previous === SyntaxKind.ImportKeyword)) {
      found.push(scanner.getTokenValue());
    }
    previous = token;
  }
  return found;
}

test('정적: 모듈 지정자는 인용부호 종류와 상관없이 뽑히고, 정규식·템플릿·주석 속 글자는 뽑히지 않는다', () => {
  const source = [
    'import "pg";',
    "import 'node:http';",
    'import type { A } from "./olive-control-a.js";',
    "export { b }\n  from './olive-control-b.js';",
    'export * from "node:fs";',
    'const re = /from \'x\'/g;',
    'const t = `${re} from "y" ${`import "z"`}`;',
    '// import "w";',
    "const k = { from: 'v' };",
  ].join('\n');
  assert.deepEqual(moduleSpecifiers(source), ['pg', 'node:http', './olive-control-a.js', './olive-control-b.js', 'node:fs']);
});

test('정적: src/olive-control*.ts는 node:crypto와 서로만 읽고 환경·시계·네트워크·파일에 닿지 않는다', () => {
  const dir = fileURLToPath(new URL('../../src/', import.meta.url));
  const files = readdirSync(dir).filter((name) => /^olive-control(-[a-z]+)?\.ts$/.test(name)).sort();
  assert.deepEqual(files, ['olive-control-canonical.ts', 'olive-control-common.ts', 'olive-control-envelope.ts',
    'olive-control-forbidden.ts', 'olive-control-generations.ts', 'olive-control-limits.ts', 'olive-control-nonces.ts',
    'olive-control-schema.ts', 'olive-control-stop.ts', 'olive-control-table.ts', 'olive-control.ts']);
  // 분석기가 아무것도 뽑지 못하면 검사가 헛돈다: import가 없는 파일을 정확히 단언한다.
  const withoutImports: string[] = [];
  for (const name of files) {
    const source = readFileSync(join(dir, name), 'utf8');
    const specifiers = moduleSpecifiers(source);
    if (specifiers.length === 0) withoutImports.push(name);
    for (const specifier of specifiers) {
      const local = /^\.\/([a-z-]+)\.js$/.exec(specifier);
      assert.ok(specifier === 'node:crypto' || (local !== null && files.includes(local[1] + '.ts')), name + ': ' + specifier);
    }
    for (const banned of [/\bprocess\b/, /\brequire\s*\(/, /\bimport\s*\(/, /\bDate\.now\b/, /\bnew Date\b/, /\bMath\.random\b/,
      /\bfetch\s*\(/, /\bsetTimeout\b/, /\bsetInterval\b/]) {
      assert.doesNotMatch(source, banned, name);
    }
  }
  assert.deepEqual(withoutImports, ['olive-control-limits.ts', 'olive-control-schema.ts']);
});
