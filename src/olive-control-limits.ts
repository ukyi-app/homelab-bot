// olive-control/v2(후보)의 판 이름과 시간 상수. 값은 v2 문서의 상한 표와 같다.

export const CONTRACT = 'olive-control/v2';

// 봉투 수명(expires_at - issued_at)의 받는 쪽 상한. 0 초과 이 값 이하만 받는다.
export const MESSAGE_TTL_MAX_MS = 30_000;
// 내는 쪽 기본 수명. MESSAGE_TTL_MAX_MS 이하에서만 바꾼다.
export const MESSAGE_TTL_MS = 30_000;
// 발급 시각이 받는 쪽 시계보다 이만큼까지 앞서도 받는다. 만료 쪽에는 더하지 않는다(만료 시각 정각은 expired).
export const CLOCK_SKEW_MS = 1_000;
// nonce 기록을 지워도 되는 시간. 받아들인 봉투는 받은 때부터 CLOCK_SKEW_MS + MESSAGE_TTL_MAX_MS 안에 만료되므로,
// 이보다 오래된 기록의 재전송은 시한에서 먼저 거절된다.
export const NONCE_RETENTION_MS = 2 * (MESSAGE_TTL_MAX_MS + CLOCK_SKEW_MS);
// 봉투 하나의 바이트 상한. 이 모듈은 집행하지 않는다: 바이트 틀이 JSON 해석 전에 잘라야 한다.
export const MAX_MESSAGE_BYTES = 64 * 1024;

// 후보 내용(candidate_fetch·candidate_chunk)의 받는 쪽 경계. 조각 하나는 base64url로 4/3배가 되어도 봉투 하나(MAX_MESSAGE_BYTES)에
// 드는 가장 큰 2의 거듭제곱이다(48KiB는 base64url만으로 64KiB). 전체와 조각 수는 관리자 결정(2026-11-19): 1MiB, 32조각.
export const CANDIDATE_CHUNK_MAX_BYTES = 32 * 1024;
export const CANDIDATE_MAX_BYTES = 1024 * 1024;
export const CANDIDATE_MAX_CHUNKS = CANDIDATE_MAX_BYTES / CANDIDATE_CHUNK_MAX_BYTES;
