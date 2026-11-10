import { randomUUID } from 'node:crypto';
import type { Scope } from './contracts.js';
import { spokenAnswer } from './change-question.js';
import { controlText } from './control-format.js';
import type { Database } from './database.js';
import type { OutboxButton, Store } from './store.js';
import { openTaskQuestions } from './task-bridge.js';
import type { OpenQuestion, TaskAnswerResult } from './task-bridge.js';
import type { TaskCommandHandler } from './task-commands.js';

// 작업 질문 바로 답(COLLEAGUE_SPEC §4.3, 스위치 켜짐에서만). 그 스레드에 owner가 답할 열린 질문이 하나면 owner의 다음 말이
// 모델을 거치지 않고 '/answer'와 같은 처리기(answerIn)로 그 질문의 답이 된다. 둘 이상이면 질문마다 버튼을 단 한 줄 글로
// 어느 질문의 답인지 묻고, 누른 질문에만 그 말을 답으로 붙인다. 답은 도구 승인·권한 변경이 아니라는 규칙은 answerIn 그대로다.

// 버튼 custom_id 이름. 허용 목록 표는 discord-protocol.ts BUTTONS다. 대상 칸은 고르기 행 ID(UUID) 하나다.
export const QUESTION_PICK_BUTTON = 'question-pick';
// 한 글의 버튼은 Discord 한 줄 상한(5개)까지다. 오래된(기한이 먼저 오는) 질문부터 싣는다.
const PICK_MAX = 5;
const PREVIEW_CHARS = 60;
// 고르기 행은 마이그레이션 없이 controls에 둔다. 값에는 ID만 두고 원문은 두지 않는다(말은 events 행, 질문은 codex_questions 행을 참조).
const KEY = `${QUESTION_PICK_BUTTON}:`;

// 질문 앞부분은 본문에만 싣고 버튼 이름은 번호다. 7일 정리(raw-text-retention)는 게시의 본문(payload.content)만 비우므로,
// 버튼 이름에 모델이 쓴 질문 조각을 두면 기간 없이 남는다.
export const QUESTION_PICK_TEXT = Object.freeze({
  prompt: (previews: readonly string[]) => ['열린 질문이 여러 개예요. 방금 말한 게 어느 질문의 답인지 골라 주세요.',
    ...previews.map((preview, index) => `${index + 1}. ${preview}`)].join('\n'),
  button: (index: number) => `${index + 1}번 질문`,
  answered: (status: string, number: number) => `${status} (${number}번 질문)`,
  // 변경 질문이 함께 열려 있어 방금 말을 봉인한 경우. 말은 답으로 쓰지 않았고, 고른 뒤 다시 말하면 그 질문의 답이 된다.
  choose: (previews: readonly string[]) => ['열린 질문이 여러 개라 방금 말은 답으로 쓰지 않았어요. 어느 질문에 답할지 먼저 골라 주세요.',
    ...previews.map((preview, index) => `${index + 1}. ${preview}`)].join('\n'),
  // history gap 중 봉인한 말. 누락 복구가 끝나기 전이라 답으로 쓰지 않았다.
  gap: '연결이 잠깐 끊겨 놓친 말을 확인하는 중이라 방금 말은 답으로 쓰지 않았어요. 잠시 뒤에도 답이 필요하면 다시 말해 주세요.',
  chosen: (number: number) => `${number}번 질문을 골랐어요. 이 스레드에 답을 말해 주세요.`,
  missing: '이미 처리했거나 이 대화에서 찾을 수 없는 선택이에요.',
  notOwner: '질문을 받은 사람만 고를 수 있어요.',
  purged: '보존 기간이 지나 답으로 쓸 말을 지웠어요. 이 스레드에서 다시 말해 주세요.',
});

// 질문 종류. 바로 답을 받는 종류만 DIRECT에 둔다. 변경(CHANGE) 질문의 답은 원문을 events에 두지 않는다(처리기의 sealsAnswer).
// 그래서 그 답이 될 수 있는 말은 수신이 저장 전에 봉인하고(sealsNextMessage), 분류를 적지 않은 답에만 공개 표시를 붙인다(change-question.ts spokenAnswer).
export type QuestionKind = 'task' | 'change';
const DIRECT: ReadonlySet<QuestionKind> = new Set<QuestionKind>(['task', 'change']);
async function questionKind(tasks: TaskCommandHandler, db: Database, question: string): Promise<QuestionKind> {
  return await tasks.sealsAnswer?.(db, question) === true ? 'change' : 'task';
}
// 봉인한 말로 고르기를 연 뒤 owner가 고른 질문. 대화마다 하나이고 값에는 ID만 둔다. 그 질문이 열려 있는 동안 다음 말의 대상이다.
const CHOSEN = 'question-chosen:';
interface DirectQuestion extends OpenQuestion { kind: QuestionKind }
async function directQuestions(store: Store, tasks: TaskCommandHandler, conversation: string, actor: string): Promise<DirectQuestion[]> {
  const open = await openTaskQuestions(store.db, conversation, actor, store.now());
  const direct: DirectQuestion[] = [];
  for (const question of open) {
    const kind = await questionKind(tasks, store.db, question.id);
    if (DIRECT.has(kind)) direct.push({ ...question, kind });
  }
  const chosen = (await store.db.query<{ value: { question: string; owner: string } }>('SELECT value FROM controls WHERE key=$1', [CHOSEN + conversation])).rows[0]?.value;
  const picked = chosen?.owner === actor ? direct.find(question => question.id === chosen.question) : undefined;
  return picked ? [picked] : direct;
}
// 이 질문을 owner의 다음 말의 답 대상으로 적는다(질문 고르기의 봉인한 말, 변경 질문의 "직접 답하기"). 질문 행·작업 상태는 바꾸지 않는다.
// 호출자가 그 질문이 이 사람에게 열려 있는지 본 뒤 트랜잭션 안에서 부른다.
export async function chooseNextAnswer(db: Database, conversation: string, question: string, owner: string): Promise<void> {
  await db.query(`INSERT INTO controls VALUES ($1,$2) ON CONFLICT (key) DO UPDATE SET value=EXCLUDED.value`,
    [CHOSEN + conversation, JSON.stringify({ question, owner })]);
}
// 이 사람이 이 대화에 보낸 다음 말이 변경 질문의 답이 될 수 있는가(답이 되든 고르기로 가든). 수신이 저장 전에 묻고, 참이면 원문을 비워 저장한다.
// 잠그지 않는다. 수신 트랜잭션의 offerAnswer가 같은 사실을 잠근 채 다시 보고, 그사이 바뀐 경우를 맞춘다.
export async function sealsNextMessage(store: Store, tasks: TaskCommandHandler, conversation: string, actor: string): Promise<boolean> {
  return (await directQuestions(store, tasks, conversation, actor)).some(question => question.kind === 'change');
}
const preview = (prompt: string) => {
  const flat = Array.from(prompt.replace(/\s+/g, ' ').trim());
  return flat.length > PREVIEW_CHARS ? `${flat.slice(0, PREVIEW_CHARS).join('')}…` : flat.join('');
};

// sealed: 수신이 지금 이 말을 봉인 대상으로 봤다(sealsNextMessage). 원문은 text로만 온다. 같은 말이 이미 원문과 함께 저장돼 있었으면
// (gap 버퍼에 둔 뒤 질문이 열림) save가 그 행을 덮어쓰지 않아 events에 원문이 남아 있을 수 있다.
export interface OfferInput { event: string; message: string; actor: string; scope: Scope; conversation: string; text: string; revision: string; sealed?: boolean }
// 수신 트랜잭션 안에서 부른다(대화 행을 잠근 뒤, 같은 이벤트는 inbox.accepted가 한 번만 들여보낸다).
// undefined면 바로 답 대상이 아니라 호출자가 지금처럼 대화로 처리한다. 'answered'·'picking'이면 대화 작업을 만들지 않는다.
export async function offerAnswer(store: Store, tasks: TaskCommandHandler, input: OfferInput): Promise<'answered' | 'picking' | undefined> {
  if (!input.text.trim()) return;
  const questions = await directQuestions(store, tasks, input.conversation, input.actor);
  if (!questions.length) return;
  const change = questions.some(question => question.kind === 'change');
  // 변경 질문의 답이 될 말은 events에 원문을 두지 않는다. sealed여도 비운다: 저장 전 판단 뒤에 질문이 열렸거나, 질문이 열리기 전
  // 원문과 함께 버퍼에 둔 말을 복구하면 행에 원문이 있다. 이미 비었으면 같은 값을 다시 쓸 뿐이다.
  if (change) await store.db.query(`UPDATE events SET payload=jsonb_set(payload,'{text}','""'::jsonb) WHERE id=$1`, [input.event]);
  if (questions.length === 1) {
    const question = questions[0]!;
    const text = question.kind === 'change' ? spokenAnswer(input.text) : input.text;
    const result = await tasks.answerIn(store, { question: question.id, actor: input.actor, scope: input.scope, text, event: input.message });
    if (result.ok) await store.db.query('DELETE FROM controls WHERE key=$1', [CHOSEN + input.conversation]);
    await notify(store, input, `answer:${input.event}`, controlText('answer', result, store.colleague));
    return 'answered';
  }
  // 봉인한 말은 고르기 동안 들고 있을 자리가 없다(events에 두지 않고, 고르기 행에는 ID만 둔다). 그래서 이 말은 답으로 쓰지 않고
  // 어느 질문에 답할지 먼저 고르게 한다. 고르면 그 질문이 다음 말의 대상이 된다(CHOSEN).
  const sealed = change || input.sealed === true;
  // 닫힌 질문을 가리키는 옛 고르기 행은 새 고르기를 만들 때 지운다(누르지 않은 채 질문이 닫힌 경우).
  await store.db.query(`DELETE FROM controls WHERE key LIKE '${KEY}%' AND value->>'conversation'=$1
    AND NOT EXISTS (SELECT 1 FROM codex_questions q WHERE q.id=controls.value->>'question' AND q.state='open')`, [input.conversation]);
  const shown = questions.slice(0, PICK_MAX);
  const buttons: OutboxButton[] = [];
  for (const [index, question] of shown.entries()) {
    const id = randomUUID();
    await store.db.query('INSERT INTO controls VALUES ($1,$2)', [KEY + id, JSON.stringify({ pick: input.event, message: input.message,
      question: question.id, conversation: input.conversation, owner: input.actor, number: index + 1, ...(sealed ? { sealed: true } : {}) })]);
    buttons.push({ id: KEY + id, label: QUESTION_PICK_TEXT.button(index), style: 'secondary' });
  }
  const previews = shown.map(question => preview(question.prompt));
  await notify(store, input, `question-pick:${input.event}`, sealed ? QUESTION_PICK_TEXT.choose(previews) : QUESTION_PICK_TEXT.prompt(previews), buttons);
  return 'picking';
}
// history gap 중에 실시간으로 받은 봉인한 말. 누락 복구가 아직 넣지 않은 앞선 말이 그 질문의 진짜 첫 답일 수 있어 답으로 확정하지 않는다.
// 원문은 이미 비워 저장했고 메모리에도 들지 않는다(재시작해도 잃을 것이 없다). 받은 것으로 닫아 복구의 history 대조가 이 말을
// 다시 처리하지 않게 하고, 다시 말해 달라고 답한다. 수신 트랜잭션 안에서 부른다.
export async function deferInGap(store: Store, input: OfferInput): Promise<void> {
  await store.db.query(`UPDATE events SET accepted=true,buffered=false,payload=payload || '{"ignored":"sealed_in_gap"}'::jsonb WHERE id=$1`, [input.event]);
  await notify(store, input, `answer-gap:${input.event}`, QUESTION_PICK_TEXT.gap);
}
async function notify(store: Store, input: OfferInput, key: string, content: string, buttons?: OutboxButton[]): Promise<void> {
  await store.enqueue({ key, conversation: input.conversation, actor: input.actor, scope: input.scope, revision: input.revision,
    payload: { kind: 'message', channel: input.scope.channel, content, classification: 'safe_summary', replyTo: input.message, ...(buttons ? { buttons } : {}) } });
}

interface PickRow { pick: string; message: string; question: string; conversation: string; owner: string; number: number; sealed?: boolean }
export interface PickInput { button: string; actor: string; scope: Scope }
// update: 응답으로 그 글을 바꾸고 버튼을 없앤다. false면 본인만 보는 응답이고 버튼은 남는다(다른 질문을 고를 수 있다).
export interface PickOutcome { content: string; update: boolean }
// 버튼 하나의 처리. 호출자(수신)의 트랜잭션 안에서 부른다. 대화 행 → 고르기 행 순서로 잠근다. 답 쓰기는 '/answer'와 같은 answerIn이라
// 응답자·대화·기한·답 기다림 검사와 같은 이벤트 한 번 반영이 같다. 답이 붙으면 그 말의 고르기 행을 모두 지워 다른 질문에는 붙지 않는다.
export async function pressQuestionPick(store: Store, tasks: TaskCommandHandler, input: PickInput): Promise<PickOutcome> {
  const conversation = await store.ownedConversation(input.scope, input.actor, true);
  const row = (await store.db.query<{ value: PickRow }>('SELECT value FROM controls WHERE key=$1 FOR UPDATE', [KEY + input.button])).rows[0]?.value;
  // 행 하나가 없는 것은 그 질문만 닫혔다는 뜻일 수 있다(새 고르기가 닫힌 질문의 행만 지운다). 같은 글의 다른 질문은 아직
  // 고를 수 있으니 버튼을 남기고, 글의 버튼은 실제로 답을 붙였거나 그 말 자체를 쓸 수 없을 때만 없앤다.
  if (!row || row.conversation !== conversation.id) return { content: QUESTION_PICK_TEXT.missing, update: false };
  if (row.owner !== input.actor) return { content: QUESTION_PICK_TEXT.notOwner, update: false };
  const settle = () => store.db.query(`DELETE FROM controls WHERE key LIKE '${KEY}%' AND value->>'pick'=$1`, [row.pick]);
  if (row.sealed) {
    // 봉인한 말은 원문이 없어 답으로 붙이지 않는다. 그 질문이 이 사람에게 아직 열려 있으면 다음 말의 대상으로 적는다.
    const open = await openTaskQuestions(store.db, conversation.id, input.actor, store.now());
    if (!open.some(question => question.id === row.question)) return { content: QUESTION_PICK_TEXT.missing, update: false };
    await chooseNextAnswer(store.db, conversation.id, row.question, input.actor);
    await settle();
    return { content: QUESTION_PICK_TEXT.chosen(row.number), update: true };
  }
  // 그 말이 같은 스레드에서 같은 owner가 보낸 것인지 저장된 이벤트로 다시 본다.
  const message = (await store.db.query<{ actor_id: string; conversation_id: string; text: string | null; text_purged_at: string | null }>(
    `SELECT actor_id,conversation_id,payload->>'text' AS text,text_purged_at FROM events WHERE id=$1`, [row.pick])).rows[0];
  if (!message || message.actor_id !== input.actor || message.conversation_id !== conversation.id) return { content: QUESTION_PICK_TEXT.missing, update: true };
  if (message.text_purged_at !== null || !message.text) { await settle(); return { content: QUESTION_PICK_TEXT.purged, update: true }; }
  if (!DIRECT.has(await questionKind(tasks, store.db, row.question))) return { content: QUESTION_PICK_TEXT.missing, update: false };
  const result: TaskAnswerResult = await tasks.answerIn(store, { question: row.question, actor: input.actor, scope: input.scope, text: message.text, event: row.message });
  const status = controlText('answer', result, store.colleague);
  if (!result.ok) return { content: status, update: false };
  await settle();
  return { content: QUESTION_PICK_TEXT.answered(status, row.number), update: true };
}
