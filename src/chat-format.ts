import type { Answer } from './contracts.js';

// 대화 답의 게시 본문. 항목을 고르거나 자르지 않는다: 스키마가 이미 8/4/8/4개 × 500자로 묶고,
// 서버는 어느 항목이 덜 중요한지 모른다(위험 표시가 없다). 긴 답은 게시 단계의 페이지 분할(1800자)로 나뉜다.
// 섹션 예산과 생략 건수를 쓰는 summaryItems는 read 요약 전용으로 남긴다.
export const EMPTY_ANSWER_NOTICE = '답변 내용을 얻지 못했습니다. 질문을 보완해 다시 요청해 주세요.';
const SECTIONS = [['facts', '사실'], ['hypotheses', '가설'], ['unknowns', '미확인'], ['checks', '권장 확인']] as const;

export function chatAnswerContent(answer: Answer): string {
  const sections = SECTIONS.map(([key, label]) => ({ key, label,
    items: answer[key].map(item => item.trim()).filter(item => item.length > 0) }))
    .filter(section => section.items.length > 0);
  if (!sections.length) return EMPTY_ANSWER_NOTICE;
  const only = sections.length === 1 && sections[0]!.key === 'facts' && sections[0]!.items.length === 1
    ? sections[0]!.items[0]! : undefined;
  // 라벨 없는 한 문장이 JSON 객체·배열로 읽히면 게시 표식이 본문을 JSON으로 다시 감싼다(markedContent).
  if (only !== undefined && !parsesAsJsonObject(only)) return only;
  return sections.map(section => [`${section.label}:`, ...section.items.map(item => `- ${item}`)].join('\n')).join('\n\n');
}
function parsesAsJsonObject(text: string): boolean {
  try {
    const value: unknown = JSON.parse(text);
    return value !== null && typeof value === 'object';
  } catch { return false; }
}
