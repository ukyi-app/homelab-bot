// olive-control/v2(후보)의 현관 쪽 독립 검증기: 공통부와 정지 묶음. 연결·저장소·Discord 없이 바이트와 값만 다룬다.
// 입력·이벤트, 출력, 후보 내용 묶음의 본문은 아직 해석하지 않는다(verify가 Unsupported로 돌려준다).
export { CanonicalError, canonicalJson, digestOf, MAX_DEPTH } from './olive-control-canonical.js';
export type { CanonicalFault } from './olive-control-canonical.js';
export { afterHandshake, freshIds, parseHeader, REJECT_REASONS, seal, SealError, verify } from './olive-control-envelope.js';
export type {
  AwaitedRequest, Envelope, HandshakeState, Header, Job, NonceLedger, Rejected, RejectReason, SealInput, Unsupported, Verified,
  VerifyContext, VerifyOutcome,
} from './olive-control-envelope.js';
export { COMMON_FORBIDDEN_FIELD_NAMES, normalizeFieldName, SUPERVISOR_FORBIDDEN_FIELD_NAMES } from './olive-control-forbidden.js';
export { GENERATION_RULES, generationValueFault } from './olive-control-generations.js';
export type { GenerationAuthority, GenerationRule, GenerationRules, Generations } from './olive-control-generations.js';
export {
  CLOCK_SKEW_MS, CONTRACT, MAX_MESSAGE_BYTES, MESSAGE_TTL_MAX_MS, MESSAGE_TTL_MS, NONCE_RETENTION_MS,
} from './olive-control-limits.js';
export { NonceBook } from './olive-control-nonces.js';
export { stopRecordReply } from './olive-control-stop.js';
export type { ReleaseCommitResult, ReleasePrepareResult, StopLedgerRead, StopRecord, StopRecordBody } from './olive-control-stop.js';
export { ACTIONS, EFFECTS_DURING_POLICY_MISMATCH, EFFECTS_WITHOUT_GENERATIONS, PARTIES } from './olive-control-table.js';
export type { ActionClass, ActionSpec, Bundle, Party } from './olive-control-table.js';
export type { JobStatus } from './olive-control-common.js';
