import type { Policy } from './policy.js';
import { taskOutputRisk } from './task-output.js';
import type { TaskOutputRisk } from './task-output.js';

// 대화 답(v2 reply)의 게시 본문. 라벨을 붙이거나 자르지 않는다: 스키마가 12,000자로 묶고,
// 긴 답은 게시 단계의 페이지 분할(1800자)로 나뉜다. 섹션 예산과 생략 건수를 쓰는 summaryItems는 read 요약 전용이다.
export const EMPTY_REPLY_NOTICE = '드릴 답을 만들지 못했어요. 조금 더 자세히 다시 물어봐 주세요.';
// 공개 검사에 걸린 답 대신 나가는 글. 모델 글은 한 글자도 싣지 않는다(사유 코드는 결과 기록에만 남긴다).
export const WITHHELD_REPLY_NOTICE = '밖에 보이면 안 되는 내용이 섞여 있어 이 답은 올리지 않았어요. 질문을 바꿔 다시 물어봐 주세요.';
// 게시 표식은 JSON으로 읽히는 본문을 {ref,data}로 다시 감싼다(markedContent). 그러면 owner가 받는 글이 모델 문장과 달라지므로,
// 그런 답은 코드 블록으로 보낸다.
const FENCE = '```';

export function chatReplyContent(reply: string): string {
  const text = reply.trim();
  if (!text) return EMPTY_REPLY_NOTICE;
  return parsesAsJsonObject(text) ? `${FENCE}json\n${text}\n${FENCE}` : text;
}
function parsesAsJsonObject(text: string): boolean {
  try {
    const value: unknown = JSON.parse(text);
    return value !== null && typeof value === 'object';
  } catch { return false; }
}

// 작업 레인 질문·요약과 같은 공개 검사(scanPublicText, 표식은 taskOutputMarkers). 정책을 모르면 닫는다.
export type ChatReplyRisk = TaskOutputRisk;
export function chatReplyRisk(reply: string, policy: Policy | undefined): ChatReplyRisk | null {
  return taskOutputRisk(reply, policy);
}
