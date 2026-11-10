import type { Scope } from './contracts.js';
import { controlText } from './control-format.js';
import { bounded } from './format.js';
import type { OutboxButton, Store } from './store.js';
import type { TaskAnswerInput, TaskAnswerResult } from './task-bridge.js';

// 변경 질문 선택지(C28, COLLEAGUE_SPEC §4.10 "변경 질문 줄이기", 스위치 켜짐에서만). 변경 작성이 진행할 수 없어 물으면
// 질문 글에 선택지 버튼(2~4개)과 "직접 답하기"를 단다. 버튼을 누르거나 owner가 그 스레드에 다음에 보낸 말이 답이다.
// 답은 공개 표시(label=public)로 '/answer'와 같은 처리기(ChangeAnswerGuard.answerIn)에 넘긴다. 공개 검사·출처 기록은 그 처리기 그대로라
// 공개 여부를 따로 묻지 않는다. 처음 게시 전 질문의 답은 뒤의 미리보기 승인 때 owner가 본다.

// 버튼 custom_id 이름. 허용 목록 표는 discord-protocol.ts BUTTONS다. 대상 칸은 질문 ID(':'를 '.'로 바꿈)와 선택지 순번(1부터)뿐이고
// 선택지 글은 싣지 않는다. 서버가 저장된 질문 행에서 그 순번의 글을 읽는다. 질문 ID는 job·세션 UUID와 턴이라 100자 안에 든다.
export const CHANGE_CHOICE_BUTTON = 'change-choice';
export const CHANGE_DIRECT_BUTTON = 'change-direct';

// 버튼 이름은 번호다. 선택지 글은 본문에만 싣는다. 7일 정리(raw-text-retention)는 게시의 본문(payload.content)만 비우므로 버튼 이름에
// 모델 글을 두면 기간 없이 남고, Discord 버튼 이름 상한(80자)이 선택지 상한(100자)보다 짧다.
export const CHANGE_QUESTION_TEXT = Object.freeze({
  choice: (number: number) => `${number}번`,
  direct: '직접 답하기',
  // "직접 답하기"를 누른 owner에게만 보인다. 상태는 바꾸지 않는다(버튼 없이 말해도 같다).
  speak: '이 스레드에 답을 말해 주세요. 다음에 보내는 말이 이 질문의 답이 돼요.',
  chosen: (number: number, status: string) => `${number}번을 답으로 보냈어요. ${status}`,
  missing: '이 대화에서 찾을 수 없는 질문이에요.',
  notOwner: '질문을 받은 사람만 답할 수 있어요.',
  closed: '이미 답했거나 닫힌 질문이에요.',
  purged: '보존 기간이 지나 선택지를 지웠어요. 이 스레드에서 답을 말해 주세요.',
});

const SEPARATOR = '.';
// 질문 ID(`job:세션:턴`)를 custom_id 한 칸에 싣는다. custom_id는 ':'로 칸을 나눈다.
const encode = (question: string) => question.split(':').join(SEPARATOR);
export const changeChoiceId = (question: string, number: number) => `${CHANGE_CHOICE_BUTTON}:${encode(question)}${SEPARATOR}${number}`;
export const changeDirectId = (question: string) => `${CHANGE_DIRECT_BUTTON}:${encode(question)}`;
// 버튼 대상 칸을 질문 ID와 순번으로 되돌린다. 모양이 다르면 undefined다.
function decode(target: string, numbered: boolean): { question: string; number?: number } | undefined {
  const parts = target.split(SEPARATOR);
  if (parts.length !== (numbered ? 4 : 3) || parts.some(part => !part)) return;
  const number = numbered ? Number(parts.pop()) : undefined;
  if (numbered && (!Number.isInteger(number) || number! < 1)) return;
  return { question: parts.join(':'), ...(number !== undefined ? { number } : {}) };
}

// 켜짐 판 질문 글의 본문 줄(머리말 다음)과 버튼. 선택지가 없으면(옛 판 세션) "직접 답하기"만 단다.
export function changeQuestionPost(question: string, prompt: string, options: readonly string[] | null | undefined): { lines: string[]; buttons: OutboxButton[] } {
  const listed = options ?? [];
  return {
    lines: [bounded(prompt, 500), ...listed.map((option, index) => `${index + 1}. ${option}`)],
    buttons: [...listed.map((_, index) => ({ id: changeChoiceId(question, index + 1), label: CHANGE_QUESTION_TEXT.choice(index + 1), style: 'secondary' as const })),
      { id: changeDirectId(question), label: CHANGE_QUESTION_TEXT.direct, style: 'primary' }],
  };
}

// 처리기 중 이 경로가 쓰는 부분. 수신의 TaskCommandHandler(ChangeAnswerGuard로 감싼 것)가 맞는다.
export interface ChangeAnswerHandler {
  answerIn(store: Store, input: TaskAnswerInput): Promise<TaskAnswerResult>;
  sealsAnswer?(db: Store['db'], question: string): Promise<boolean>;
}
// 공개 표시를 붙인 답. 처리기가 label을 떼고 같은 공개 검사를 한다. owner의 말이 'label='로 시작해도 그 뒤 글 전체가 답이다.
export const publicAnswer = (text: string) => `label=public | ${text}`;

export interface ChangeQuestionPress { button: typeof CHANGE_CHOICE_BUTTON | typeof CHANGE_DIRECT_BUTTON; target: string; actor: string; scope: Scope; event: string }
// update: 응답으로 그 질문 글을 바꾸고 버튼을 없앤다. false면 누른 사람만 보는 응답이고 버튼은 남는다.
export interface ChangeQuestionOutcome { content: string; update: boolean }
// 버튼 하나의 처리. 호출자(수신)의 트랜잭션 안에서 부른다(같은 상호작용은 호출자가 한 번만 들여보낸다).
// 응답자·대화·기한·답 기다림 검사와 이벤트 한 번 반영은 answerIn이 질문 행을 잠근 채 한다. 여기서는 그 전에 이 경로의 버튼인지만 가린다.
export async function pressChangeQuestion(store: Store, handler: ChangeAnswerHandler, input: ChangeQuestionPress): Promise<ChangeQuestionOutcome> {
  const target = decode(input.target, input.button === CHANGE_CHOICE_BUTTON);
  if (!target) return { content: CHANGE_QUESTION_TEXT.missing, update: false };
  const row = (await store.db.query<{ conversation_id: string; responder_id: string; state: string; prompt: string; options: string[] | null; prompt_purged_at: string | null }>(
    'SELECT conversation_id,responder_id,state,prompt,options,prompt_purged_at FROM codex_questions WHERE id=$1', [target.question])).rows[0];
  // 다른 스레드의 질문은 있는지도 알리지 않는다.
  if (!row || row.conversation_id !== store.scopeId(input.scope) || await handler.sealsAnswer?.(store.db, target.question) !== true) return { content: CHANGE_QUESTION_TEXT.missing, update: false };
  if (row.responder_id !== input.actor) return { content: CHANGE_QUESTION_TEXT.notOwner, update: false };
  if (row.state !== 'open') return { content: CHANGE_QUESTION_TEXT.closed, update: false };
  if (input.button === CHANGE_DIRECT_BUTTON) return { content: CHANGE_QUESTION_TEXT.speak, update: false };
  const option = row.options?.[target.number! - 1];
  if (!option) return { content: row.prompt_purged_at !== null ? CHANGE_QUESTION_TEXT.purged : CHANGE_QUESTION_TEXT.missing, update: false };
  const result = await handler.answerIn(store, { question: target.question, actor: input.actor, scope: input.scope, text: publicAnswer(option), event: input.event });
  const status = controlText('answer', result, store.colleague);
  if (!result.ok) return { content: status, update: false };
  // 글을 바꾸면 버튼이 사라진다. 질문과 선택지는 그대로 두고 고른 번호를 덧붙인다.
  return { content: [...changeQuestionPost(target.question, row.prompt, row.options).lines, CHANGE_QUESTION_TEXT.chosen(target.number!, status)].join('\n'), update: true };
}
