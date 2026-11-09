// Claude CLI stream-json의 rate_limit_event 고정 fixture.
// 모양은 로컬 Claude Code 2.1.319 바이너리에 든 SDK 메시지 스키마를 정적으로 읽은 것이다(모델 호출 없음):
//   { type: 'rate_limit_event', rate_limit_info: { status, resetsAt?, rateLimitType?, utilization?, ...그 밖의 칸 }, uuid, session_id }
// status는 allowed·allowed_warning·rejected, resetsAt은 unix 초 정수, utilization은 창 사용 비율(보통 0~1)이다.
// 봇 이미지의 2.1.308 `-p` 구독 모드에서 같은 칸이 오는지는 미확인이다(VERIFICATION "C03 작업자 한도 정보").
// 응답에 새면 안 되는 원문 칸(unifiedWindows·overage·uuid 등)도 함께 넣어 둔다.

// 2026-11-10 05:00 UTC.
export const RESETS_AT = 1_794_286_800;
// 주간 한도가 풀리는 시각(2026-11-13 00:00 UTC).
export const WEEKLY_RESETS_AT = 1_794_528_000;
export const LEAK_MARKER = 'raw-field-must-not-leak';

export const rateLimitEvent = (info: Record<string, unknown>) => ({ type: 'rate_limit_event', rate_limit_info: info, uuid: 'u-rate' });
const extras = { unifiedRateLimitFallbackAvailable: false, isUsingOverage: false, overageStatus: 'rejected',
  overageDisabledReason: LEAK_MARKER, unifiedWindows: { five_hour: { utilization: 0.42, resetsAt: RESETS_AT, status: 'allowed' } } };

export const RATE_LIMIT_EVENTS = Object.freeze({
  allowed: rateLimitEvent({ status: 'allowed', resetsAt: RESETS_AT, rateLimitType: 'five_hour', ...extras }),
  warning: rateLimitEvent({ status: 'allowed_warning', resetsAt: WEEKLY_RESETS_AT, rateLimitType: 'seven_day', utilization: 0.91, ...extras }),
  rejected: rateLimitEvent({ status: 'rejected', resetsAt: RESETS_AT, rateLimitType: 'five_hour', utilization: 1, ...extras }),
});
