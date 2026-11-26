// v2 봉투의 받는 쪽 검증(verify)과 내는 쪽 서명(seal). 상태를 갖지 않는다: 연결의 인사 상태, 접수, 세대의 권위 값, 기다리는
// 요청, nonce 기록은 받는 쪽이 검증마다 문맥으로 준다.
import { randomBytes, randomUUID, sign, verify as verifySignature } from 'node:crypto';
import type { KeyObject } from 'node:crypto';
import { CanonicalError, canonicalJson, digestOf } from './olive-control-canonical.js';
import { findForbidden } from './olive-control-forbidden.js';
import { generationFieldFault, generationsFault } from './olive-control-generations.js';
import type { Generations } from './olive-control-generations.js';
import { CLOCK_SKEW_MS, CONTRACT, MESSAGE_TTL_MAX_MS, MESSAGE_TTL_MS } from './olive-control-limits.js';
import { ACTION_NAME, int, isPlainObject, literal, NONCE, object, oneOf, pattern, SchemaError, sha256, UUID,
  uuid } from './olive-control-schema.js';
import { PARTIES, specOf } from './olive-control-table.js';
import type { ActionClass, ActionSpec, ParseContext, Party } from './olive-control-table.js';

export const REJECT_REASONS = [
  'malformed', 'unknown_field', 'contract_mismatch', 'unknown_action', 'unknown_sender', 'bad_signature', 'wrong_direction',
  'wrong_recipient', 'lifetime_invalid', 'not_yet_valid', 'expired', 'handshake_required', 'handshake_repeated', 'policy_mismatch',
  'intake_closed', 'body_malformed', 'digest_mismatch', 'forbidden_field', 'generation_missing', 'generation_unknown',
  'generation_mismatch', 'reply_mismatch', 'replayed',
] as const;
export type RejectReason = (typeof REJECT_REASONS)[number];

// 서명은 이 객체(모든 칸)의 정규 직렬화에 건다. 세대·승인·목적지·권한 칸은 머리에 없다.
export const parseHeader = object({
  contract: literal(CONTRACT),
  sender: oneOf(PARTIES),
  recipient: oneOf(PARTIES),
  action: pattern(ACTION_NAME),
  request_id: uuid,
  body_digest: sha256,
  issued_at: int(1),
  expires_at: int(1),
  nonce: pattern(NONCE),
});
export type Header = ReturnType<typeof parseHeader>;

export interface Envelope {
  header: Header;
  signature: string;
  body: unknown;
}

export type HandshakeState = 'none' | 'agreed' | 'policy_mismatch';

export interface Job {
  job_id: string;
  action: string;
  request_digest: string;
}

// 이 연결에서 실제로 실어 보내고 답을 기다리는 요청. 답을 받아들이면 지우고, 연결이 끝나면 모두 버린다.
// body는 답이 요청 본문의 값을 되풀이하는 동작(candidate_fetch)에만 쓴다: 그 요청에 실어 보낸 본문이다. 없으면 그 답은 reply_mismatch다.
export interface AwaitedRequest {
  action: string;
  job: Job | null;
  body?: unknown;
}

export interface NonceLedger {
  // 처음 보는 (낸 쪽, nonce)면 기록하고 true. 동시에 들어와도 한 번만 true여야 한다.
  consume(sender: Party, nonce: string, expiresAt: number): boolean;
}

export interface VerifyContext {
  now: number;
  expectedRecipient: Party;
  // 받는 쪽이 믿는 상대의 효과 서명 공개 키. 자기 이름에는 undefined를 준다(되돌아온 자기 봉투는 unknown_sender).
  publicKeyFor(sender: Party): KeyObject | undefined;
  handshake: HandshakeState;
  intakeOpen: boolean;
  generations: Generations;
  awaiting(requestId: string): AwaitedRequest | undefined;
  nonces: NonceLedger;
}

export interface Verified {
  ok: true;
  action: string;
  class: ActionClass;
  header: Header;
  body: unknown;
  sender: Party;
  recipient: Party;
  // 효과 요청이면 (job_id, action, request_digest). job_id는 해석 결과가 아니라 서명된 원본 본문에서 읽는다.
  job: Job | null;
}
export interface Rejected {
  ok: false;
  reason: RejectReason;
}
export type VerifyOutcome = Verified | Rejected;

const SIGNATURE = /^[A-Za-z0-9_-]{86}$/;
const signingBytes = (header: Header): Buffer => Buffer.from(canonicalJson(header), 'utf8');
const reject = (reason: RejectReason): Rejected => ({ ok: false, reason });

function schemaReason(error: unknown, malformedAs: RejectReason): RejectReason {
  if (error instanceof SchemaError) return error.fault === 'unknown' ? 'unknown_field' : malformedAs;
  throw error;
}

function parseContext(sender: Party, recipient: Party): ParseContext {
  return {
    sender,
    recipient,
    effect(action) {
      const spec = specOf(action);
      return spec?.class === 'effect' ? { from: spec.from, parseResult: spec.parseResult! } : undefined;
    },
  };
}

function topUuid(body: unknown, field: string): string | null {
  if (!isPlainObject(body)) return null;
  const value = body[field];
  return typeof value === 'string' && UUID.test(value) ? value : null;
}

// 칸 단계(공통 칸 → 세대 칸)와 해석. verify와 seal이 같은 순서로 쓴다.
function bodyFault(spec: ActionSpec, body: unknown): RejectReason | null {
  if (spec.class === 'effect' && topUuid(body, 'job_id') === null) return 'body_malformed';
  if (spec.answers !== null && topUuid(body, 'in_reply_to') === null) return 'body_malformed';
  return spec.generations === null ? null : generationFieldFault(spec.generations, body);
}

// 검증 순서(v2 문서 "검증 순서"):
// 모양(봉투 → 계약 판 → 동작 → 머리) → 서명 → 방향 → 받는 쪽 → 시한 → 연결(인사 → 정책 → 접수)
// → 본문(digest → 금지 칸 → 공통 칸 → 세대(칸 → 권위 값) → 모양) → 답의 대조 → nonce.
// - 서명을 방향·시한보다 먼저 본다: 서명이 맞지 않는 봉투의 칸은 상대가 말한 값이 아니다.
// - 연결을 본문보다 먼저 본다: 인사가 안 된 연결의 요청은 본문이 맞든 틀리든 받지 않으므로 해시와 해석에 일을 쓰지 않는다.
// - 세대를 digest 뒤에 본다: 서명한 쪽이 실은 값만 대조한다.
// - nonce를 맨 끝에 쓴다: 다른 이유로 거절될 봉투가 nonce를 태우지 않는다.
export function verify(raw: unknown, ctx: VerifyContext): VerifyOutcome {
  if (!isPlainObject(raw)) return reject('malformed');
  for (const key of Object.keys(raw)) {
    if (key !== 'header' && key !== 'signature' && key !== 'body') return reject('unknown_field');
  }
  if (!Object.hasOwn(raw, 'header') || !Object.hasOwn(raw, 'signature') || !Object.hasOwn(raw, 'body')) return reject('malformed');
  const rawHeader = raw.header;
  if (!isPlainObject(rawHeader)) return reject('malformed');
  if (rawHeader.contract !== CONTRACT) return reject('contract_mismatch');
  const spec = typeof rawHeader.action === 'string' ? specOf(rawHeader.action) : undefined;
  if (spec === undefined) return reject('unknown_action');
  let header: Header;
  try {
    header = parseHeader(rawHeader, 'header');
  } catch (error) {
    return reject(schemaReason(error, 'malformed'));
  }

  const key = ctx.publicKeyFor(header.sender);
  if (key === undefined) return reject('unknown_sender');
  const signature = raw.signature;
  // base64url 해석기는 남는 비트를 버려 한 서명에 여러 표기가 생긴다. 다시 써서 같은 표기만 받는다.
  if (typeof signature !== 'string' || !SIGNATURE.test(signature)) return reject('bad_signature');
  const signatureBytes = Buffer.from(signature, 'base64url');
  if (signatureBytes.length !== 64 || signatureBytes.toString('base64url') !== signature) return reject('bad_signature');
  if (!verifySignature(null, signingBytes(header), key, signatureBytes)) return reject('bad_signature');

  if (!spec.from.includes(header.sender) || header.recipient === header.sender) return reject('wrong_direction');
  if (header.recipient !== ctx.expectedRecipient) return reject('wrong_recipient');

  const lifetime = header.expires_at - header.issued_at;
  if (lifetime <= 0 || lifetime > MESSAGE_TTL_MAX_MS) return reject('lifetime_invalid');
  if (header.issued_at > ctx.now + CLOCK_SKEW_MS) return reject('not_yet_valid');
  if (header.expires_at <= ctx.now) return reject('expired');

  if (spec.class === 'handshake') {
    if (ctx.handshake !== 'none') return reject('handshake_repeated');
  } else {
    if (ctx.handshake === 'none') return reject('handshake_required');
    if (ctx.handshake === 'policy_mismatch' && !spec.duringPolicyMismatch) return reject('policy_mismatch');
  }
  if (!ctx.intakeOpen && !spec.duringClosedIntake) return reject('intake_closed');

  const body = raw.body;
  let digest: string;
  try {
    digest = digestOf(body);
  } catch (error) {
    if (error instanceof CanonicalError) return reject('body_malformed');
    throw error;
  }
  if (digest !== header.body_digest) return reject('digest_mismatch');
  if (findForbidden(body, header.sender) !== undefined) return reject('forbidden_field');
  const fault = bodyFault(spec, body);
  if (fault !== null) return reject(fault);
  // 효과와 답 동작은 bodyFault를 지났으면 본문이 평범한 객체다(효과는 job_id, 답은 in_reply_to를 읽었다). 아래에서 record를 읽는
  // 자리는 이 둘뿐이다. 인사·조회 요청의 본문은 여기서 객체라는 보장이 없고 해석기가 꼴을 본다.
  const record = body as Record<string, unknown>;
  if (spec.generations !== null) {
    const valueFault = generationsFault(spec.generations, record, ctx.generations);
    if (valueFault !== null) return reject(valueFault);
  }
  let parsed: unknown;
  try {
    parsed = spec.parse(body, parseContext(header.sender, header.recipient));
  } catch (error) {
    return reject(schemaReason(error, 'body_malformed'));
  }

  if (spec.answers !== null) {
    const awaited = ctx.awaiting(record.in_reply_to as string);
    if (awaited === undefined || !spec.answers.includes(awaited.action)) return reject('reply_mismatch');
    // job_status는 기다리는 작업(job_id, action, request_digest), candidate_chunk는 물은 digest·위치를 되풀이해야 한다.
    if (spec.matches !== null && !spec.matches(awaited, record)) return reject('reply_mismatch');
  }

  if (!ctx.nonces.consume(header.sender, header.nonce, header.expires_at)) return reject('replayed');

  const jobId = spec.class === 'effect' ? (record.job_id as string) : null;
  return {
    ok: true, action: spec.name, class: spec.class, header, body: parsed, sender: header.sender, recipient: header.recipient,
    job: jobId === null ? null : { job_id: jobId, action: spec.name, request_digest: header.body_digest },
  };
}

export interface SealInput {
  sender: Party;
  recipient: Party;
  action: string;
  requestId: string;
  nonce: string;
  issuedAt: number;
  // 없으면 issuedAt + MESSAGE_TTL_MS.
  expiresAt?: number;
  body: unknown;
}

export class SealError extends Error {
  constructor(readonly reason: RejectReason) {
    super(`seal: ${reason}`);
  }
}

// 받는 쪽이 모양·방향·수명 범위(0 초과 30초 이하)·본문 때문에 거절할 봉투는 서명하기 전에 막는다. 받는 때의 시계는 모르므로
// 발급 시각을 과거로 주면 받는 쪽에서 이미 만료일 수 있다. 인사 상태·접수·기다리는 요청·세대의 권위 값은 받는 쪽의 상태라 보지
// 않는다(세대는 칸의 있고 없음과 꼴만 본다). 본문은 받은 값 그대로 싣는다: digest가 그 값에 묶이므로 내보낸 뒤
// 바꾸면 받는 쪽에서 digest_mismatch다.
export function seal(input: SealInput, privateKey: KeyObject): Envelope {
  const spec = specOf(input.action);
  if (spec === undefined) throw new SealError('unknown_action');
  let digest: string;
  try {
    digest = digestOf(input.body);
  } catch (error) {
    if (error instanceof CanonicalError) throw new SealError('body_malformed');
    throw error;
  }
  let header: Header;
  try {
    header = parseHeader({
      contract: CONTRACT, sender: input.sender, recipient: input.recipient, action: input.action, request_id: input.requestId,
      body_digest: digest, issued_at: input.issuedAt, expires_at: input.expiresAt ?? input.issuedAt + MESSAGE_TTL_MS,
      nonce: input.nonce,
    }, 'header');
  } catch {
    throw new SealError('malformed');
  }
  const lifetime = header.expires_at - header.issued_at;
  if (lifetime <= 0 || lifetime > MESSAGE_TTL_MAX_MS) throw new SealError('lifetime_invalid');
  if (!spec.from.includes(header.sender) || header.recipient === header.sender) throw new SealError('wrong_direction');
  if (findForbidden(input.body, header.sender) !== undefined) throw new SealError('forbidden_field');
  const fault = bodyFault(spec, input.body);
  if (fault !== null) throw new SealError(fault);
  try {
    spec.parse(input.body, parseContext(header.sender, header.recipient));
  } catch (error) {
    throw new SealError(schemaReason(error, 'body_malformed'));
  }
  return { header, signature: sign(null, signingBytes(header), privateKey).toString('base64url'), body: input.body };
}

// 새 봉투의 요청 ID와 nonce. nonce는 낸 쪽마다 한 번만 쓴다(16바이트 난수).
export function freshIds(): { requestId: string; nonce: string } {
  return { requestId: randomUUID(), nonce: randomBytes(16).toString('hex') };
}

// 받아들인 인사 봉투(handshake, handshake_reply)에서 이 연결의 다음 인사 상태를 고른다. 판은 봉투가 이미 대조했다.
// 정책 revision은 글자 그대로 같아야 agreed다. 상태는 연결마다 한 번만 바뀐다(다시 온 인사는 handshake_repeated).
export function afterHandshake(verified: Verified, ownPolicyRevision: string): 'agreed' | 'policy_mismatch' {
  if (verified.class !== 'handshake') throw new Error('olive-control: not a handshake envelope');
  const theirs = (verified.body as { policy_revision: string }).policy_revision;
  return theirs === ownPolicyRevision ? 'agreed' : 'policy_mismatch';
}
