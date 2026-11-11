import { createHash, randomUUID } from 'node:crypto';
import { TEMPLATES } from './catalog.js';
import { AMENDMENT_REQUEST_TEXT, parseChangeRequest } from './change-commands.js';
import { CHANGE_AMENDMENT } from './change-contracts.js';
import type { ChangeCommandHandler } from './change-commands.js';
import { ownerText } from './chat-context.js';
import { ChatSuperseded, chatJobCurrent } from './chat-currency.js';
import { chatReplyRisk } from './chat-format.js';
import { Denied } from './contracts.js';
import type { Job, Proposal, Scope } from './contracts.js';
import { controlText, taskLaneClosedText } from './control-format.js';
import type { ExternalTaskCommandHandler } from './external-task-commands.js';
import { CommandInputError, parseIds, parseKind } from './memory-commands.js';
import type { MemoryCommandHandler } from './memory-commands.js';
import type { Policy, PolicyGate } from './policy.js';
import { pullReferences, pullTarget, REVIEW_REQUEST_TEXT, reviewRequestsOf, samePull } from './review-request.js';
import { LaneClosed } from './store.js';
import type { OutboxButton, Store } from './store.js';
import type { TaskCommandHandler } from './task-commands.js';
import { taskProject } from './task-policy.js';
import { sessionAttachHandler } from './session-key-proposal.js';
import { enqueueRunResult, expirePending, PROPOSAL_INTERRUPTED_TEXT, RUN_PENDING } from './proposal-retention.js';

// 제안과 실행 확인(COLLEAGUE_SPEC §4.3). 모델은 제안만 하고, 서버가 동작 표에 대조한다. 읽기 요청은 바로 '/'와 같은 경로로 답하고,
// 실행 요청은 제안을 저장한 뒤 owner가 "할게요"를 눌러야 '/'와 같은 경로로 실행한다. 동료 기능 스위치가 꺼져 있으면 부르지 않는다.
export const PROPOSAL_TTL_MS = 24 * 60 * 60 * 1000;
// 버튼 custom_id 이름. 허용 목록 표는 discord-protocol.ts BUTTONS다.
export const PROPOSAL_BUTTONS = Object.freeze({ yes: 'proposal-yes', no: 'proposal-no' } as const);
const PREVIEW_CHARS = 100;

export const PROPOSAL_TEXT = Object.freeze({
  yes: '할게요',
  no: '아니에요',
  taskQuestion: (project: string, preview: string) => `${project} 저장소에서 이 작업을 시작할까요?\n> ${preview}`,
  taskQuestionWithheld: (project: string) => `${project} 저장소에서 방금 말한 작업을 시작할까요?\n> 밖에 보이면 안 되는 내용이 섞여 있어 말한 내용은 싣지 않았어요.`,
  taskStarted: (project: string, job: string) => `${project} 저장소에서 작업을 시작했어요. 작업 ID는 \`${job}\`예요.`,
  declined: '알겠어요, 하지 않을게요.',
  expired: '24시간이 지나서 이 제안은 끝났어요. 필요하면 다시 말해 주세요.',
  settled: '이미 처리한 제안이에요.',
  changed: '제안한 뒤로 내용이 바뀌어서 실행하지 않았어요. 다시 말해 주세요.',
  missing: '이 대화에서 찾을 수 없는 제안이에요.',
  stopped: '이 대화는 구독이 꺼져 있어서 실행하지 않았어요. 구독을 다시 켠 뒤 다시 말해 주세요.',
  notOwner: '제안을 받은 사람만 누를 수 있어요.',
  unavailable: '지금은 이 일을 할 수 없어요. 잠시 뒤 다시 말해 주세요.',
  // 말로 한 변경 요청의 실행 확인(DECISIONS "동료 봇 전환" 15). 저장소는 변경 정책 대조를 지난 이름이다.
  changeQuestion: (repository: string) => `${repository}에 이 변경 PR을 준비할까요?`,
  changeCancelQuestion: (change: string) => `변경 \`${change}\`을 취소할까요?`,
  cancelQuestion: (job: string) => `작업 \`${job}\`을 취소할까요?`,
  taskCancelQuestion: (job: string) => `작업 \`${job}\`을 취소할까요?`,
  retryQuestion: (job: string) => `작업 \`${job}\`을 다시 시도할까요?`,
  reviewResumeQuestion: (job: string) => `리뷰 작업 \`${job}\`을 이어서 할까요?`,
  reviewCancelQuestion: (job: string) => `리뷰 작업 \`${job}\`을 취소할까요?`,
  // 기억 저장·정정은 저장될 글을 한 글자도 줄이지 않고 그대로 싣는다. owner가 본 값만 저장된다.
  memorySaveQuestion: (kind: string, statement: string) => `이 내용을 ${kind} 기억으로 저장할까요?\n${quoted(statement)}`,
  memoryCorrectQuestion: (ids: string, statement: string) => `기억 ${ids}을 이 내용으로 정정할까요?\n${quoted(statement)}`,
  memoryExcludeQuestion: (key: string) => `출처 \`${key}\`을 기억에서 제외할까요? 이 출처의 기억은 검색·브리핑에서 빠지고 새로 저장하지 않아요.`,
  memoryDeleteQuestion: (id: string) => `기억 \`${id}\`을 지울까요?`,
  detachQuestion: (connection: string) => `세션 연결 \`${connection}\`을 해제할까요?`,
  // 커밋 뒤 처리기가 실패했을 때. 처리됐는지 모를 수 있어 확인을 권한다.
  failed: '처리하지 못했어요(일시 오류). 상태를 확인해 달라고 한 뒤 필요하면 다시 말해 주세요.',
  readWithheld: '결과에 밖에 보이면 안 되는 내용이 섞여 있어 여기에는 싣지 않았어요.',
  // 확인한 실행이 끝났다는 기록 없이 게시 서버가 멈췄을 때 재시작 뒤 주기 정리가 남기는 안내(proposal-retention.ts).
  interrupted: PROPOSAL_INTERRUPTED_TEXT,
  // 실행 결과가 공개 검사에 걸렸을 때 스레드 일반 글(지연 결과 글·응답 실패 안내)에 대신 싣는다. 값과 '/' 이름이 없어 스위치 두 판에 같다.
  resultWithheld: '확인한 요청은 끝났지만 결과에 밖에 보이면 안 되는 내용이 섞여 있어 여기에는 싣지 않았어요. 필요하면 상태를 확인해 달라고 해 주세요.',
});
// 실행 결과를 스레드 일반 글(지연 결과 글·버튼 응답 실패 안내)로 낼 때의 본문. 버튼 응답은 본인 전용이라 처리기 결과에 채널 ID 같은
// 값이 들어 있을 수 있다. 모델 답과 같은 공개 검사(chatReplyRisk)를 지나지 못하면 값 없는 고정 안내로 바꾼다. 정책을 모르면 닫는다.
export function publicRunResult(content: string, policy: Policy | undefined): string {
  return chatReplyRisk(content, policy) === null ? content : PROPOSAL_TEXT.resultWithheld;
}
// 저장될 글을 줄마다 인용 표시로 싣는다. 내용은 바꾸지 않는다.
function quoted(text: string): string {
  return text.split('\n').map(line => `> ${line}`).join('\n');
}

// 명세 §4.3 동작 표의 종류. admin(관리 기능)·none(구독 끄기·켜기, 급한 질문)은 말로 하지 않으므로 처리기를 달지 않고 늘 버린다.
export type ActionKind = 'read' | 'run' | 'question' | 'publish' | 'admin' | 'none';
// 수신(DiscordIngress)이 가진 '/' 처리기. 대화 성공 분기(Runtime)는 이 처리기를 받지 않으므로 수신이 같은 Store에 묶어 둔다.
// 묶이지 않은 처리기의 동작은 "연결 안 됨"으로 버린다('/' 명령도 처리기가 없으면 닫힌다).
export interface ProposalHandlers {
  tasks?: TaskCommandHandler; memory?: MemoryCommandHandler; external?: ExternalTaskCommandHandler; changes?: ChangeCommandHandler;
}
const boundHandlers = new WeakMap<Store, ProposalHandlers>();
export function bindProposalHandlers(store: Store, handlers: ProposalHandlers): void { boundHandlers.set(store, handlers); }
interface ReadContext { store: Store; job: Job; proposal: Proposal; policy: Policy; handlers: ProposalHandlers }
// 결과를 일반 답으로 싣지 않는 경우. queued는 다른 레인(read)이 결과를 게시한다. 나머지는 제안을 버린다.
interface ReadSkip { skip: 'queued' | 'not_connected' | 'target_denied' | 'superseded' }
interface ReadHandler { kind: 'read'; run(context: ReadContext): Promise<string | ReadSkip> }
// digest 재료. 버튼을 누를 때 저장된 참조로 다시 만들어 제안 때의 digest와 대조한다.
interface Values { target: string | null; content: string | null }
// 확인 글 대신 거절 한 줄로 답하는 경우(C27 수정 요청: 병합·닫힌 PR, 상한). 대상이 보이지 않으면 거절하지 않고 버린다.
interface Refusal { refusal: string }
interface Prepared extends Values {
  // 모델이 고른 값(C14 기억 진술)만 value에 둔다. owner 원문은 sourceEvent 참조로만 둔다.
  value: string | null; sourceEvent: string | null;
  // question은 원문 미리보기를 싣고, plainQuestion은 서버가 대조한 값(저장소 등)만 싣는다. question이 공개 검사에 걸리면 plainQuestion을 쓴다.
  question: string; plainQuestion: string;
}
// externalConnected: R08 연결 명령을 조립했는가(EXTERNAL_TASK_EVENTS_ENABLED). 꺼져 있으면 세션 연결 제안을 버린다.
interface PrepareContext {
  store: Store; job: Job; proposal: Proposal; policy: Policy; tasksConnected: boolean; externalConnected: boolean; handlers: ProposalHandlers;
}
export interface ProposalRow {
  id: string; conversation_id: string; owner_id: string; scope: Scope; action: string; target: string | null;
  value: string | null; source_event: string | null; digest: string; source_job: string; state: string;
  expires_at: string; message_key: string;
}
// policy: 버튼을 누른 때 수신이 인가한 정책(말로 하는 리뷰 제어의 장소 판단에 쓴다).
export interface ExecuteContext extends ProposalHandlers { revision: string; policy?: Policy }
// later: 자기 DB 연결을 쓰는 처리기(기억·변경·세션 연결)는 버튼 트랜잭션이 커밋된 뒤에 부른다. 그 트랜잭션은 대화·제안 행을
// 잠그고 있고, 처리기가 읽는 행(원 메시지 등)도 다른 연결에서 봐야 한다. '/' 기억·변경 명령처럼 한 번 잡은 뒤 실행하고 다시 하지 않는다.
interface Executed { state: 'confirmed' | 'refused'; content: string; reason?: string; job?: string; later?: () => Promise<string> }
interface RunHandler {
  kind: 'run';
  // 제안 때 허용 대상 대조와 값 준비. undefined면 그 제안을 버린다(대화 답만 나간다). Refusal이면 확인 글 없이 그 한 줄을 일반 답으로 단다.
  prepare(context: PrepareContext): Promise<Prepared | Refusal | undefined>;
  // 버튼 때 저장된 값·참조로 지금 값을 다시 만든다. 원문이 비었으면 undefined.
  current(store: Store, row: ProposalRow): Promise<Values | undefined>;
  // '/' 처리기와 같은 경로로 실행한다. 호출자의 트랜잭션 안이다.
  execute(store: Store, row: ProposalRow, values: Values, context: ExecuteContext): Promise<Executed>;
}
// confirm: false인 실행 줄은 확인 글·버튼 없이 읽기 요청과 같은 경로(인가 → 처리기 → 결과를 일반 답으로)로 바로 처리한다.
// 그런 줄의 처리기는 ReadHandler 모양이다. 나머지 줄은 이 칸을 두지 않는다.
export interface ActionRow { kind: ActionKind; command: string; confirm?: false; handler?: ReadHandler | RunHandler }

// owner 원문(멘션 표기 제거). 7일 정리로 비웠으면 없다.
async function sourceText(store: Store, event: string | null): Promise<string | undefined> {
  if (!event) return;
  const row = (await store.db.query<{ payload: Record<string, unknown>; text_purged_at: string | null }>(
    'SELECT payload,text_purged_at FROM events WHERE id=$1', [event])).rows[0];
  if (!row || row.text_purged_at !== null) return;
  const text = ownerText(row.payload).trim();
  return text || undefined;
}
const preview = (text: string) => {
  const flat = Array.from(text.replace(/\s+/g, ' ').trim());
  return flat.length > PREVIEW_CHARS ? `${flat.slice(0, PREVIEW_CHARS).join('')}…` : flat.join('');
};

// 작업 목록: '/list'와 같은 Store.control 경로(owner·대화 대조 포함)와 같은 렌더.
const listHandler: ReadHandler = {
  kind: 'read',
  run: async ({ store, job }) => controlText('list', await store.control(job.owner_id, job.conversation_id, 'list'), store.colleague),
};

// 작업 시작: 내용은 owner 원문이고 모델은 저장소(작업 정책의 프로젝트 ID)만 고른다. 저장소는 '/task'와 같은 정책으로 대조한다.
const taskHandler: RunHandler = {
  kind: 'run',
  async prepare({ store, job, proposal, policy, tasksConnected }) {
    if (!tasksConnected || !proposal.target || !taskProject(policy, proposal.target)) return;
    const content = await sourceText(store, job.event_id);
    if (!content) return;
    return { target: proposal.target, content, value: null, sourceEvent: job.event_id,
      question: PROPOSAL_TEXT.taskQuestion(proposal.target, preview(content)), plainQuestion: PROPOSAL_TEXT.taskQuestionWithheld(proposal.target) };
  },
  async current(store, row) {
    const content = await sourceText(store, row.source_event);
    return content === undefined ? undefined : { target: row.target, content };
  },
  async execute(store, row, values, { tasks, revision }) {
    if (!tasks || !values.target || !values.content) return { state: 'refused', reason: 'task_unavailable', content: PROPOSAL_TEXT.unavailable };
    // '/task'의 접수 검사(작업 정책·레인 닫힘·작업자 intake)와 같은 함수다.
    const refusal = await tasks.admit(store, values.target);
    if (refusal) return { state: 'refused', reason: 'task_refused', content: refusal };
    // '/task'와 같은 모양의 입력을 새 이벤트로 둔다. 작업 레인은 job의 이벤트에서 원문(text)과 프로젝트(target)를 읽는다.
    const id = randomUUID();
    await store.db.query(`INSERT INTO events(id,provider,delivery_id,semantic_key,actor_id,scope,conversation_id,received_at,payload)
      VALUES ($1,'proposal',$2,$3,$4,$5,$6,$7,$8)`, [id, row.id, `proposal:${row.id}`, row.owner_id, JSON.stringify(row.scope),
      row.conversation_id, store.now(), JSON.stringify({ text: values.content, command: 'task', target: values.target, kind: 'command', revision })]);
    try {
      const job = await store.accept(id, 'task', revision);
      return { state: 'confirmed', job, content: PROPOSAL_TEXT.taskStarted(values.target, job) };
    } catch (error) {
      // admit 뒤에 레인이 닫힌 경합. SQL 오류가 아니라 트랜잭션은 그대로 쓸 수 있다. 받지 않은 입력은 남기지 않는다.
      if (!(error instanceof LaneClosed)) throw error;
      await store.db.query('DELETE FROM events WHERE id=$1', [id]);
      return { state: 'refused', reason: 'task_lane_closed', content: taskLaneClosedText(error.reason, store.colleague) };
    }
  },
};

// ---- C14 나머지 동작. 읽기는 '/'와 같은 처리기의 결과를 일반 답으로 싣고, 실행은 '/'와 같은 처리기를 버튼 뒤에 부른다. ----
const skip = (why: ReadSkip['skip']): ReadSkip => ({ skip: why });
// 처리기 응답 문구가 아니라 대상 ID 자리에 쓰는 모양만 본다(SQL·custom_id 밖 값이 확인 글에 실리지 않게).
const ID = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/;
// 이 대화에서 owner가 볼 수 있는 job. '/cancel'·'/retry'·'/task-cancel'이 대조하는 owner·대화와 같다.
async function visibleJob(store: Store, job: Job, target: string, type?: string): Promise<boolean> {
  if (!ID.test(target)) return false;
  return (await store.db.query('SELECT 1 FROM jobs WHERE id=$1 AND owner_id=$2 AND conversation_id=$3 AND ($4::text IS NULL OR type=$4)',
    [target, job.owner_id, job.conversation_id, type ?? null])).rows.length > 0;
}
// 말로 하는 리뷰 재개·취소·상태의 장소(DECISIONS "동료 봇 전환" 13): owner가 허용 채널(대화·알림)이나 그 아래 스레드에서 말했다.
// '/' 리뷰 제어는 이 판단을 쓰지 않고 지금처럼 알림 채널 본문만 받는다(discord.ts 수신).
export function spokenReviewAllowed(scope: Scope, actor: string, policy: Policy): boolean {
  const allowed = [policy.conversationChannel, policy.notificationChannel];
  if (actor !== policy.owner) return false;
  if (scope.kind === 'channel') return scope.parent === null && allowed.includes(scope.channel);
  return scope.kind === 'thread' && scope.parent !== null && allowed.includes(scope.parent);
}
// 원 메시지의 Discord ID. 기억의 대화 출처(memory.ts)와 변경 요청의 입력 이벤트 키가 이 값이라, 근거 판정이 '/'와 같이 "owner 대화"가 된다.
async function deliveryOf(store: Store, event: string | null): Promise<string | undefined> {
  if (!event) return;
  return (await store.db.query<{ delivery_id: string }>("SELECT delivery_id FROM events WHERE id=$1 AND provider='discord'", [event])).rows[0]?.delivery_id;
}

const taskStatusHandler: ReadHandler = {
  kind: 'read',
  async run({ job, proposal, handlers }) {
    if (!handlers.tasks) return skip('not_connected');
    if (!proposal.target || !ID.test(proposal.target)) return skip('target_denied');
    // '/task-status'와 같은 처리기다. 타인 작업·다른 대화의 작업은 Denied라 제안을 버린다.
    try { return await handlers.tasks.status(job.owner_id, job.target, proposal.target); } catch (error) {
      if (error instanceof Denied) return skip('target_denied');
      throw error;
    }
  },
};
const changeStatusHandler: ReadHandler = {
  kind: 'read',
  async run({ job, proposal, handlers }) {
    if (!handlers.changes) return skip('not_connected');
    if (!proposal.target) return skip('target_denied');
    const reply = await handlers.changes.handle({ id: job.event_id, actor: job.owner_id, scope: job.target, command: 'change-status', text: '', target: proposal.target });
    return reply.outcome === 'not_visible' ? skip('target_denied') : reply.content;
  },
};
const reviewStatusHandler: ReadHandler = {
  kind: 'read',
  run: async ({ store, job, policy }) => controlText('review-status', await store.control(job.owner_id, job.conversation_id, 'review-status', undefined, undefined,
    { review: spokenReviewAllowed(job.target, job.owner_id, policy) }), store.colleague),
};
// 읽기 템플릿: 모델은 템플릿 ID만 고르고 서버가 카탈로그에 대조한다. '/read'와 같은 모양의 입력(대상 서비스, 본문 템플릿 ID)으로
// read 레인에 접수하므로 정책 인가·5초 예산·결과 게시가 '/read'와 같다. 결과는 read 레인이 이 대화에 일반 글로 게시한다.
const readHandler: ReadHandler = {
  kind: 'read',
  async run({ store, job, proposal }) {
    const template = TEMPLATES.find(item => item.id === proposal.target);
    if (!template) return skip('target_denied');
    await store.atomic(async tx => {
      const id = randomUUID();
      const inserted = await tx.db.query(`INSERT INTO events(id,provider,delivery_id,semantic_key,actor_id,scope,conversation_id,received_at,payload)
        VALUES ($1,'proposal',$2,$3,$4,$5,$6,$7,$8) ON CONFLICT (semantic_key) DO NOTHING RETURNING id`, [id, job.id, `proposal-read:${job.id}`, job.owner_id,
        JSON.stringify(job.target), job.conversation_id, tx.now(), JSON.stringify({ text: template.id, command: 'read', target: template.service, kind: 'command',
          revision: job.revision.policy })]);
      if (!inserted.rows.length) return;
      await tx.accept(id, 'read', job.revision.policy);
    });
    return skip('queued');
  },
};
const memorySearchHandler: ReadHandler = {
  kind: 'read',
  async run({ store, job, proposal, handlers }) {
    if (!handlers.memory) return skip('not_connected');
    if (!proposal.content?.trim()) return skip('target_denied');
    const id = await deliveryOf(store, job.event_id);
    if (!id) return skip('target_denied');
    // 결과는 스레드 일반 글이다. 출처 ID를 먼저 빼고 진술은 consider의 공개 검사가 본다.
    return (await handlers.memory.handle({ id, actor: job.owner_id, scope: job.target, command: 'memory-search', text: proposal.content,
      threadReply: true })).content;
  },
};
const attachListHandler: ReadHandler = {
  kind: 'read',
  async run({ job, handlers, policy }) {
    if (!handlers.external) return skip('not_connected');
    // 목록은 키를 싣지 않아 본인 전용 응답(deliver)을 쓰지 않는다. 대신 일반 글이라, 확인 글에서 숨겼던 세션 ID가 여기서 다시
    // 보이지 않게 같은 공개 검사로 세션 ID를 거른다.
    const reply = await handlers.external.handle({ actor: job.owner_id, scope: job.target, command: 'attach-list', text: '',
      publicCheck: text => chatReplyRisk(text, policy) === null }, async () => false);
    return reply.content ?? skip('target_denied');
  },
};

const fixedQuestion = (target: string, question: string, extra: Partial<Prepared> = {}): Prepared =>
  ({ target, content: null, value: null, sourceEvent: null, question, plainQuestion: question, ...extra });
const targetOnly = async (_store: Store, row: ProposalRow): Promise<Values> => ({ target: row.target, content: null });
// 대화 작업 제어('/cancel'·'/retry'). '/'처럼 버튼 트랜잭션 안에서 Store.control을 부른다(같은 잠금 순서: 대화 행 → 스케줄러 행).
const controlHandler = (command: 'cancel' | 'retry', question: (job: string) => string): RunHandler => ({
  kind: 'run',
  async prepare({ store, job, proposal }) {
    if (!proposal.target || !await visibleJob(store, job, proposal.target)) return;
    return fixedQuestion(proposal.target, question(proposal.target));
  },
  current: targetOnly,
  async execute(store, row, values) {
    const result = await store.control(row.owner_id, row.conversation_id, command, values.target!, row.id);
    return controlled(command, result, store.colleague);
  },
});
const controlled = (command: string, result: unknown, colleague: boolean): Executed => ({
  state: (result as { ok?: boolean } | null)?.ok === false ? 'refused' : 'confirmed',
  ...((result as { ok?: boolean } | null)?.ok === false ? { reason: 'control_refused' } : {}),
  content: controlText(command, result, colleague),
});
const taskCancelHandler: RunHandler = {
  kind: 'run',
  async prepare({ store, job, proposal, handlers }) {
    if (!handlers.tasks || !proposal.target || !await visibleJob(store, job, proposal.target, 'task')) return;
    return fixedQuestion(proposal.target, PROPOSAL_TEXT.taskCancelQuestion(proposal.target));
  },
  current: targetOnly,
  async execute(store, row, values, { tasks }) {
    if (!tasks) return { state: 'refused', reason: 'task_unavailable', content: PROPOSAL_TEXT.unavailable };
    return controlled('task-cancel', await tasks.cancelIn(store, row.owner_id, row.conversation_id, values.target!, row.id), store.colleague);
  },
};
// 리뷰 재개·취소. 리뷰 작업은 대화가 없어 대상은 리뷰 job이면 되고, 권한은 '/'의 별도 리뷰 권한 자리에 말로 하는 장소 판단을 넣는다.
const reviewHandler = (command: 'review-resume' | 'review-cancel', question: (job: string) => string): RunHandler => ({
  kind: 'run',
  async prepare({ store, job, proposal, policy }) {
    if (!proposal.target || !ID.test(proposal.target) || !spokenReviewAllowed(job.target, job.owner_id, policy)) return;
    if (!(await store.db.query("SELECT 1 FROM jobs WHERE id=$1 AND type='review'", [proposal.target])).rows.length) return;
    return fixedQuestion(proposal.target, question(proposal.target));
  },
  current: targetOnly,
  async execute(store, row, values, { policy }) {
    const allowed = !!policy && spokenReviewAllowed(row.scope, row.owner_id, policy);
    return controlled(command, await store.control(row.owner_id, row.conversation_id, command, values.target!, row.id, { review: allowed }), store.colleague);
  },
});
// 커밋 뒤에 부를 처리기 실행. 실패는 고정 문구로 바꾸고 오류 원문은 싣지 않는다(호출자가 사유 코드로 남긴다).
const later = (run: () => Promise<string>): Executed => ({ state: 'confirmed', content: '', later: run });
const memoryKind = (target: string | null): string | undefined => {
  try { return parseKind(target ?? undefined); } catch (error) { if (error instanceof CommandInputError) return; throw error; }
};
const memoryIds = (target: string | null): string[] | undefined => {
  try { return parseIds(target ?? undefined); } catch (error) { if (error instanceof CommandInputError) return; throw error; }
};
// 기억 저장·정정: 내용은 모델이 골라낸 글이라 value에 두고 확인 글에 그대로 싣는다. 버튼 때 digest가 같은 그 글만 '/'와 같은 처리기로 저장한다.
// 확인 글이 공개 검사에 걸리면 내용을 숨긴 채 저장을 물을 수 없으므로 버린다(plainQuestion도 같은 글).
const memoryWriteHandler = (command: 'memory-save' | 'memory-correct'): RunHandler => ({
  kind: 'run',
  async prepare({ job, proposal, handlers }) {
    const statement = proposal.content;
    if (!handlers.memory || !statement?.trim()) return;
    let question: string;
    if (command === 'memory-save') {
      const kind = memoryKind(proposal.target);
      if (!kind) return;
      question = PROPOSAL_TEXT.memorySaveQuestion(kind, statement);
    } else {
      const ids = memoryIds(proposal.target);
      if (!ids) return;
      question = PROPOSAL_TEXT.memoryCorrectQuestion(ids.map(id => `\`${id}\``).join(', '), statement);
    }
    return { target: proposal.target, content: statement, value: statement, sourceEvent: job.event_id, question, plainQuestion: question };
  },
  current: async (_store, row) => ({ target: row.target, content: row.value }),
  async execute(store, row, values, { memory }) {
    const id = await deliveryOf(store, row.source_event);
    if (!memory || !id) return { state: 'refused', reason: 'memory_unavailable', content: PROPOSAL_TEXT.unavailable };
    return later(async () => (await memory.handle({ id, actor: row.owner_id, scope: row.scope, command, text: values.content!, target: values.target ?? undefined })).content);
  },
});
const memoryTargetHandler = (command: 'memory-exclude' | 'memory-delete'): RunHandler => ({
  kind: 'run',
  async prepare({ job, proposal, handlers }) {
    const target = proposal.target?.trim();
    if (!handlers.memory || !target) return;
    if (command === 'memory-delete') {
      if (memoryIds(target)?.length !== 1) return;
      return fixedQuestion(target, PROPOSAL_TEXT.memoryDeleteQuestion(target), { sourceEvent: job.event_id });
    }
    // memory.ts exclude가 받는 출처 키 모양만 받는다(here는 이 스레드).
    if (target !== 'here' && !/^(conversation|job|document|external|channel):.{1,200}$/s.test(target)) return;
    return fixedQuestion(target, PROPOSAL_TEXT.memoryExcludeQuestion(target), { sourceEvent: job.event_id });
  },
  current: targetOnly,
  async execute(store, row, values, { memory }) {
    const id = await deliveryOf(store, row.source_event);
    if (!memory || !id) return { state: 'refused', reason: 'memory_unavailable', content: PROPOSAL_TEXT.unavailable };
    return later(async () => (await memory.handle({ id, actor: row.owner_id, scope: row.scope, command, text: '', target: values.target! })).content);
  },
});
const detachHandler: RunHandler = {
  kind: 'run',
  async prepare({ store, job, proposal, handlers }) {
    // '/detach'는 owner의 연결이면 받는다. 말로 할 때는 이 대화에서 볼 수 있는(이 스레드에 연결한) 열린 연결만 받는다.
    if (!handlers.external || !proposal.target || !ID.test(proposal.target)) return;
    if (!(await store.db.query(`SELECT 1 FROM external_task_connections WHERE id=$1 AND owner_id=$2 AND conversation_id=$3 AND revoked_at IS NULL`,
      [proposal.target, job.owner_id, job.conversation_id])).rows.length) return;
    return fixedQuestion(proposal.target, PROPOSAL_TEXT.detachQuestion(proposal.target));
  },
  current: targetOnly,
  async execute(_store, row, values, { external }) {
    if (!external) return { state: 'refused', reason: 'external_unavailable', content: PROPOSAL_TEXT.unavailable };
    return later(async () => (await external.handle({ actor: row.owner_id, scope: row.scope, command: 'detach', text: '', target: values.target! }, async () => false)).content ?? '');
  },
};
// 말로 한 변경 요청을 '/change'의 text 서식으로 옮긴다. 요약은 owner 원문 그대로이고, 인수 조건은 서버 고정 문구, 출처는
// DECISIONS "동료 봇 전환" 15의 공개 표시(label=public)다. 접수 때 공개 검사(scanBrief)와 출처 label 규칙은 '/change' 그대로다.
export const SPOKEN_CHANGE_ACCEPTANCE = '요약에 적힌 owner의 요청이 반영돼 있다';
export const spokenChangeText = (text: string) => `${text} | accept=${SPOKEN_CHANGE_ACCEPTANCE} | label=public`;
const changeHandler: RunHandler = {
  kind: 'run',
  async prepare({ store, job, proposal, policy, handlers }) {
    // '/change'와 같은 장소(대화 채널의 스레드)와 같은 저장소 정책 대조다.
    if (!handlers.changes || job.target.kind !== 'thread' || job.target.parent !== policy.conversationChannel) return;
    const repository = policy.change?.repositories.find(item => item.fullName === proposal.target || String(item.repoId) === proposal.target);
    if (!repository) return;
    const content = await sourceText(store, job.event_id);
    if (!content || !spokenAsIs(content)) return;
    const question = PROPOSAL_TEXT.changeQuestion(repository.fullName);
    return { target: repository.fullName, content, value: null, sourceEvent: job.event_id, question, plainQuestion: question };
  },
  async current(store, row) {
    const content = await sourceText(store, row.source_event);
    return content === undefined ? undefined : { target: row.target, content };
  },
  async execute(store, row, values, { changes }) {
    const id = await deliveryOf(store, row.source_event);
    if (!changes || !id || !values.content) return { state: 'refused', reason: 'change_unavailable', content: PROPOSAL_TEXT.unavailable };
    return later(async () => (await changes.handle({ id, actor: row.owner_id, scope: row.scope, command: 'change', text: spokenChangeText(values.content!), target: values.target! })).content);
  },
};
// '/change' 서식으로 옮겨도 요약이 owner 원문과 같아야 받는다(" | "·"goal=" 같은 서식 글자, 길이·제어 문자에 걸리면 버린다).
function spokenAsIs(text: string): boolean {
  const parsed = parseChangeRequest(spokenChangeText(text));
  return parsed.ok && parsed.value.summary === text && parsed.value.label === 'public';
}
const changeCancelHandler: RunHandler = {
  kind: 'run',
  async prepare({ job, proposal, handlers }) {
    if (!handlers.changes || !proposal.target) return;
    // 볼 수 있는지는 '/change-status'와 같은 처리기로 본다(읽기만 한다). 요청한 스레드의 owner에게만 보인다.
    const seen = await handlers.changes.handle({ id: job.event_id, actor: job.owner_id, scope: job.target, command: 'change-status', text: '', target: proposal.target });
    if (seen.outcome === 'not_visible') return;
    return fixedQuestion(proposal.target, PROPOSAL_TEXT.changeCancelQuestion(proposal.target));
  },
  current: targetOnly,
  async execute(_store, row, values, { changes }) {
    if (!changes) return { state: 'refused', reason: 'change_unavailable', content: PROPOSAL_TEXT.unavailable };
    return later(async () => (await changes.handle({ id: row.id, actor: row.owner_id, scope: row.scope, command: 'change-cancel', text: '', target: values.target! })).content);
  },
};

// 변경 PR 수정(C27, DECISIONS "동료 봇 전환" 16). 대상은 이 스레드에서 owner가 낸 변경(변경 ID나 PR 번호)이고 그 PR이 열려 있어야 한다.
// 지시는 owner 원문(멘션 표기 제거)이고, 확인 때 읽은 PR 리뷰·댓글 ID 묶음과 그 글의 digest, PR head를 값으로 묶는다. 버튼 때 원문이 바뀌거나 지워졌으면 실행하지 않는다.
// 리뷰·댓글 본문은 값에 넣지 않는다. 차례를 시작할 때 다시 읽은 글이 이 digest와 다르면 런타임이 작성 전에 닫는다.
// 병합·닫힌 PR과 상한에 닿은 변경은 확인 글 없이 거절 한 줄로 답한다. 남의 변경은 존재를 알리지 않고 버린다.
interface AmendValue { changeId: string; generation: number; pullNumber: number; head: string; materials: string[]; materialsDigest: string }
const amendContent = (instruction: string, value: AmendValue) => JSON.stringify([instruction, value.changeId, value.generation, value.pullNumber, value.head, [...value.materials].sort(), value.materialsDigest]);
const parseAmendValue = (raw: string | null): AmendValue | undefined => {
  try { return raw ? JSON.parse(raw) as AmendValue : undefined; } catch { return undefined; }
};
const changeAmendHandler: RunHandler = {
  kind: 'run',
  async prepare({ store, job, proposal, policy, handlers }) {
    const amendment = handlers.changes?.amendment;
    // '/change'와 같은 장소(대화 채널의 스레드)다.
    if (!amendment || !proposal.target || job.target.kind !== 'thread' || job.target.parent !== policy.conversationChannel) return;
    const instruction = await sourceText(store, job.event_id);
    if (!instruction) return;
    const found = await amendment.prepare({ actor: job.owner_id, scope: job.target, target: proposal.target, instruction });
    if (!found.ok) {
      if (found.reason === 'not_visible') return;
      return { refusal: found.reason === 'limit' ? AMENDMENT_REQUEST_TEXT.limit(CHANGE_AMENDMENT.maxRounds) : AMENDMENT_REQUEST_TEXT[found.reason] };
    }
    const value: AmendValue = { changeId: found.changeId, generation: found.generation, pullNumber: found.pullNumber, head: found.head, materials: found.materials, materialsDigest: found.materialsDigest };
    const question = AMENDMENT_REQUEST_TEXT.question(found.repository, found.pullNumber, found.materials.length);
    return { target: found.changeId, content: amendContent(instruction, value), value: JSON.stringify(value), sourceEvent: job.event_id, question, plainQuestion: question };
  },
  async current(store, row) {
    const instruction = await sourceText(store, row.source_event);
    const value = parseAmendValue(row.value);
    return instruction === undefined || !value ? undefined : { target: row.target, content: amendContent(instruction, value) };
  },
  async execute(_store, row, values, { changes }) {
    const value = parseAmendValue(row.value);
    const instruction = values.content ? (JSON.parse(values.content) as [string])[0] : undefined;
    if (!changes?.amendment || !value || !instruction) return { state: 'refused', reason: 'change_unavailable', content: PROPOSAL_TEXT.unavailable };
    const amendment = changes.amendment;
    // 확인 이벤트는 제안 ID로 정한다. 같은 제안은 한 번만 눌리므로 같은 요청이 두 번 들어가지 않는다.
    return later(async () => (await amendment.request({ id: `proposal:${row.id}`, actor: row.owner_id, scope: row.scope, ...value, instruction })).content);
  },
};

// PR 리뷰 요청(C30, DECISIONS "동료 봇 전환" 18). 확인 버튼이 없으므로 모델이 고른 대상(저장소·PR 번호)은 owner 원문에 그 PR이
// 링크나 <소유자>/<저장소>#<번호>로 적혀 있을 때만 쓴다. 맥락 자료(이전 대화·봇 글)가 대상을 바꾸지 못하게 한다.
// 원문에 없으면 리뷰하지 않고 그 이유를 답한다(모델 답이 "리뷰할게요"라고 했어도 아무 일이 없는 것처럼 보이지 않게).
const reviewRequestHandler: ReadHandler = {
  kind: 'read',
  async run({ store, job, proposal }) {
    const port = reviewRequestsOf(store);
    if (!port) return skip('not_connected');
    const target = proposal.target ? pullTarget(proposal.target) : undefined;
    const text = await sourceText(store, job.event_id);
    if (!target || !text || !pullReferences(text).some(ref => samePull(ref, target))) return REVIEW_REQUEST_TEXT.notInText;
    // 대상 조회(GitHub) 동안 같은 대화에 새 말이 오면 접수 트랜잭션이 대화 행을 잠그고 다시 봐서 리뷰를 만들지 않는다.
    let result: Awaited<ReturnType<typeof port.request>>;
    try { result = await port.request({ repository: `${target.owner}/${target.repo}`, pr: target.number, key: job.id }); } catch (error) {
      if (error instanceof ChatSuperseded) return skip('superseded');
      throw error;
    }
    if (result.outcome === 'refused') return REVIEW_REQUEST_TEXT.refused[result.reason];
    return REVIEW_REQUEST_TEXT[result.outcome](result.repository, result.pr);
  },
};

// 동작 표. 키는 작업자 계약의 제안 동작 ID(contracts.ts PROPOSAL_ACTIONS, '/' 이름의 하이픈을 밑줄로)이고,
// 계약에 없는 줄(작업 질문·게시 승인·관리 기능·없음)은 종류를 적어 두기만 한다. 처리기가 없는 줄은 "연결 안 됨"이라 버린다.
// 뒤 티켓(C14~C17)은 줄에 처리기를 달거나 줄을 더한다.
export const ACTIONS: Readonly<Record<string, ActionRow>> = Object.freeze({
  list: { kind: 'read', command: 'list', handler: listHandler },
  task_status: { kind: 'read', command: 'task-status', handler: taskStatusHandler },
  change_status: { kind: 'read', command: 'change-status', handler: changeStatusHandler },
  review_status: { kind: 'read', command: 'review-status', handler: reviewStatusHandler },
  read: { kind: 'read', command: 'read', handler: readHandler },
  memory_search: { kind: 'read', command: 'memory-search', handler: memorySearchHandler },
  attach_list: { kind: 'read', command: 'attach-list', handler: attachListHandler },
  task: { kind: 'run', command: 'task', handler: taskHandler },
  cancel: { kind: 'run', command: 'cancel', handler: controlHandler('cancel', PROPOSAL_TEXT.cancelQuestion) },
  task_cancel: { kind: 'run', command: 'task-cancel', handler: taskCancelHandler },
  retry: { kind: 'run', command: 'retry', handler: controlHandler('retry', PROPOSAL_TEXT.retryQuestion) },
  memory_save: { kind: 'run', command: 'memory-save', handler: memoryWriteHandler('memory-save') },
  memory_correct: { kind: 'run', command: 'memory-correct', handler: memoryWriteHandler('memory-correct') },
  memory_exclude: { kind: 'run', command: 'memory-exclude', handler: memoryTargetHandler('memory-exclude') },
  memory_delete: { kind: 'run', command: 'memory-delete', handler: memoryTargetHandler('memory-delete') },
  attach: { kind: 'run', command: 'attach', handler: sessionAttachHandler },
  detach: { kind: 'run', command: 'detach', handler: detachHandler },
  change: { kind: 'run', command: 'change', handler: changeHandler },
  change_cancel: { kind: 'run', command: 'change-cancel', handler: changeCancelHandler },
  review_resume: { kind: 'run', command: 'review-resume', handler: reviewHandler('review-resume', PROPOSAL_TEXT.reviewResumeQuestion) },
  review_cancel: { kind: 'run', command: 'review-cancel', handler: reviewHandler('review-cancel', PROPOSAL_TEXT.reviewCancelQuestion) },
  answer: { kind: 'question', command: 'answer' },
  change_publish: { kind: 'publish', command: 'change-publish' },
  emergency_stop: { kind: 'admin', command: 'emergency-stop' },
  resume_model: { kind: 'admin', command: 'resume-model' },
  revoke: { kind: 'admin', command: 'revoke' },
  model_status: { kind: 'admin', command: 'model-status' },
  task_release: { kind: 'admin', command: 'task-release' },
  stop: { kind: 'none', command: 'stop' },
  resume: { kind: 'none', command: 'resume' },
  urgent: { kind: 'none', command: 'urgent' },
  // '/'가 없는 실행. PR 댓글 리뷰 명령과 같은 명시 트리거로 바로 접수한다(명세 §4.3 "리뷰 요청", 확인 없음).
  review_request: { kind: 'run', command: 'review-request', confirm: false, handler: reviewRequestHandler },
  // '/'가 없는 실행. 실행 확인 버튼을 거친다(명세 §4.3 "수정 요청").
  change_amend: { kind: 'run', command: 'change-amend', handler: changeAmendHandler },
});
// 확인 없이 바로 처리하는 처리기는 읽기 줄이거나 confirm: false인 실행 줄에만 붙는다. 어긋난 줄은 연결 안 된 것으로 본다.
const connected = (action: string): ReadHandler | RunHandler | undefined => {
  const row = Object.hasOwn(ACTIONS, action) ? ACTIONS[action] : undefined;
  if (!row || row.kind === 'admin' || row.kind === 'none' || !row.handler) return;
  const immediate = row.handler.kind === 'read';
  return immediate === (row.kind === 'read' || (row.kind === 'run' && row.confirm === false)) ? row.handler : undefined;
};

export function proposalDigest(action: string, values: Values): string {
  return createHash('sha256').update(JSON.stringify([action, values.target, values.content])).digest('hex');
}
export const proposalButtons = (id: string): OutboxButton[] => [
  { id: `${PROPOSAL_BUTTONS.yes}:${id}`, label: PROPOSAL_TEXT.yes, style: 'primary' },
  { id: `${PROPOSAL_BUTTONS.no}:${id}`, label: PROPOSAL_TEXT.no, style: 'secondary' },
];

// 대화 성공 분기(runtime.ts)가 결과를 확정한 뒤 부른다. 제안을 버려도 대화 답은 이미 나가 있다.
export class ProposalDesk {
  constructor(private readonly store: Store, private readonly gate: PolicyGate, private readonly tasksConnected: boolean,
    private readonly externalConnected = false) {}
  async consider(job: Job, proposal: Proposal, policy: Policy): Promise<'read' | 'proposed' | 'dropped'> {
    // 버린 제안은 동작과 사유만 남긴다(값은 남기지 않는다).
    const drop = async (reason: string) => { await this.store.audit('proposal_dropped', job.id, { action: proposal.action, reason }); return 'dropped' as const; };
    const handler = connected(proposal.action);
    if (!handler) return drop('not_connected');
    if (!await current(this.store, job)) return drop('superseded');
    const handlers = boundHandlers.get(this.store) ?? {};
    if (handler.kind === 'read') {
      // '/' 읽기 명령의 수신과 같은 인가(현재 정책 owner·허용 채널·거부 목록) 뒤 같은 처리기를 부른다.
      await this.gate.authorize(job.owner_id, job.target);
      const result = await handler.run({ store: this.store, job, proposal, policy, handlers });
      if (typeof result !== 'string') return result.skip === 'queued' ? 'read' : drop(result.skip);
      // '/' 읽기 명령은 본인 전용 응답이지만 여기 결과는 스레드의 일반 글이다. 모델 답과 같은 공개 검사를 지나지 못하면 결과 대신 고정 안내를 단다.
      const content = chatReplyRisk(result, policy) === null ? result : PROPOSAL_TEXT.readWithheld;
      await this.store.enqueue({ key: `result:${job.id}:read`, job: job.id, conversation: job.conversation_id, actor: job.owner_id,
        scope: job.target, revision: job.revision.policy,
        payload: { kind: 'message', channel: job.target.channel, content, classification: 'safe_summary', after: `result:${job.id}` } });
      return 'read';
    }
    const prepared = await handler.prepare({ store: this.store, job, proposal, policy, tasksConnected: this.tasksConnected,
      externalConnected: this.externalConnected, handlers });
    if (!prepared) return drop('target_denied');
    if ('refusal' in prepared) {
      await this.store.audit('proposal_dropped', job.id, { action: proposal.action, reason: 'refused' });
      await this.store.enqueue({ key: `result:${job.id}:read`, job: job.id, conversation: job.conversation_id, actor: job.owner_id, scope: job.target, revision: job.revision.policy,
        payload: { kind: 'message', channel: job.target.channel, content: prepared.refusal, classification: 'safe_summary', after: `result:${job.id}` } });
      return 'read';
    }
    // 확인 글은 owner 원문을 싣고 모델 답의 공개 검사(chatReplyRisk)를 거치지 않으므로 같은 정책으로 따로 본다.
    // 걸리면 원문 없는 고정 문구로 되묻고, 그것도 걸리면(정책을 못 읽음 등) 버린다. 사유 코드만 남기고 값은 남기지 않는다.
    const question = chatReplyRisk(prepared.question, policy) === null ? prepared.question
      : chatReplyRisk(prepared.plainQuestion, policy) === null ? prepared.plainQuestion : undefined;
    if (question === undefined) return drop('public_check');
    const id = randomUUID();
    // 확인 글은 대화 답(result:<job>) 뒤에 나가게 같은 접두의 키를 쓴다. 게시 순서는 created_at·message_key 순이다.
    const key = `result:${job.id}:proposal`;
    const made = await this.store.atomic(async store => {
      // 버튼 처리와 같은 잠금 순서(대화 행 → 제안 행)다. 새 요청 접수(Store.accept)도 이 행을 잡으므로,
      // 잠근 뒤 같은 연결로 최신성을 다시 봐야 위 검사와 이 사이에 접수된 새 메시지를 놓치지 않는다.
      await store.db.query('SELECT id FROM conversations WHERE id=$1 FOR UPDATE', [job.conversation_id]);
      if (!await current(store, job)) return 'superseded';
      await expirePending(store.db, store.now());
      const inserted = await store.db.query(`INSERT INTO proposals(id,conversation_id,owner_id,scope,action,target,value,source_event,digest,
        source_job,message_key,created_at,expires_at) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)
        ON CONFLICT (source_job) DO NOTHING RETURNING id`, [id, job.conversation_id, job.owner_id, JSON.stringify(job.target),
        proposal.action, prepared.target, prepared.value, prepared.sourceEvent, proposalDigest(proposal.action, prepared), job.id, key,
        store.now(), store.now() + PROPOSAL_TTL_MS]);
      if (!inserted.rows.length) return 'duplicate';
      await store.enqueue({ key, job: job.id, conversation: job.conversation_id, actor: job.owner_id, scope: job.target,
        revision: job.revision.policy, payload: { kind: 'message', channel: job.target.channel, content: question,
          classification: 'safe_summary', buttons: proposalButtons(id), after: `result:${job.id}` } });
      return 'proposed';
    });
    if (made === 'superseded') return drop('superseded');
    return made === 'proposed' ? 'proposed' : 'dropped';
  }
}

// 결과가 succeeded로 확정됐고, 그 뒤 같은 대화에 새 대화 요청이 오지 않았다. 새 메시지가 대화를 대체했으면 제안을 만들지 않는다
// (다음 대화 차례가 같은 기록을 보고 다시 판단한다).
const current = (store: Store, job: Job): Promise<boolean> => chatJobCurrent(store.db, job.id);


export interface PressInput { proposal: string; answer: 'yes' | 'no'; actor: string; scope: Scope; event: string; context: ExecuteContext }
// update: 응답으로 그 글의 버튼을 없앤다(처리·거절·만료·이미 처리됨). false면 본인만 보는 응답이고 버튼은 남는다.
// later: 있으면 호출자가 트랜잭션 커밋 뒤에 부르고, 그 결과 문장이 content 대신 응답이 된다(제안은 이미 confirmed다).
// resultPending: 같은 트랜잭션이 결과 글(proposal-retention.ts enqueueRunResult)을 남겼다. 응답이 전해지면 호출자가 거둔다.
export interface PressOutcome { content: string; update: boolean; later?: () => Promise<string>; resultPending?: true }
// 버튼 하나의 처리. 호출자(수신)의 트랜잭션 안에서 부른다. 대화 행 → 제안 행 순서로 잠그고, 상태 전이는 state='pending' 조건부라
// 같은 제안을 두 번 눌러도 한 번만 실행된다. 실행은 '/' 처리기와 같은 경로라 권한·정책 검사가 같다.
export async function pressProposal(store: Store, input: PressInput): Promise<PressOutcome> {
  const conversation = await store.ownedConversation(input.scope, input.actor, true);
  const row = (await store.db.query<ProposalRow>('SELECT * FROM proposals WHERE id=$1 FOR UPDATE', [input.proposal])).rows[0];
  if (!row || row.conversation_id !== conversation.id) return { content: PROPOSAL_TEXT.missing, update: true };
  if (row.owner_id !== input.actor) return { content: PROPOSAL_TEXT.notOwner, update: false };
  if (row.state !== 'pending') return { content: PROPOSAL_TEXT.settled, update: true };
  // keep: 커밋 뒤 실행(later)의 입력이라 실행이 끝날 때까지 value·source_event를 남긴다.
  const settle = async (state: string, reason: string | null, job: string | null = null, keep = false) => {
    const changed = await store.db.query(`UPDATE proposals SET state=$2,reason=$3,result_job=$4,value=CASE WHEN $7::boolean THEN value END,
      source_event=CASE WHEN $7::boolean THEN source_event END,settled_at=$5,settled_by=$6
      WHERE id=$1 AND state='pending' RETURNING id`, [row.id, state, reason, job, store.now(), input.event, keep]);
    if (!changed.rows.length) throw new Error('proposal_state_changed');
    await store.audit('proposal_settled', row.id, { action: row.action, state, reason, job });
  };
  if (store.now() >= Number(row.expires_at)) { await settle('expired', 'expired'); return { content: PROPOSAL_TEXT.expired, update: true }; }
  if (input.answer === 'no') { await settle('declined', null); return { content: PROPOSAL_TEXT.declined, update: true }; }
  // "할게요"를 이 트랜잭션에서 끝낸 결과(접수·거절)는 커밋 뒤 실행(later)의 완료 기록과 같은 결과 글로 남긴다. 커밋 뒤 버튼
  // 응답 전에 멈춰도 그 스레드에 결과가 남는다. 만료·"아니에요"는 실행을 시도하지 않아 남기지 않는다.
  const answered = async (content: string, state: string, reason: string | null, job: string | null = null): Promise<PressOutcome> => {
    await settle(state, reason, job);
    await enqueueRunResult(store, { proposal: row.id, conversation: row.conversation_id, owner: row.owner_id, scope: row.scope,
      publicNotice: publicRunResult(content, input.context.policy), revision: input.context.revision });
    return { content, update: true, resultPending: true };
  };
  // 구독이 꺼진 대화의 작업은 claim이 집지 않는다. '/task'와 달리 버튼은 owner가 끈 구독을 다시 켜지 않고 실행을 거절한다.
  if (!conversation.active) return answered(PROPOSAL_TEXT.stopped, 'refused', 'subscription_stopped');
  const handler = connected(row.action);
  if (handler?.kind !== 'run') return answered(PROPOSAL_TEXT.unavailable, 'refused', 'not_connected');
  const values = await handler.current(store, row);
  if (!values || proposalDigest(row.action, values) !== row.digest) return answered(PROPOSAL_TEXT.changed, 'refused', 'digest_changed');
  const executed = await handler.execute(store, row, values, input.context);
  if (!executed.later) return answered(executed.content, executed.state, executed.reason ?? null, executed.job ?? null);
  await settle(executed.state, RUN_PENDING, executed.job ?? null, true);
  return { content: executed.content, update: true, later: executed.later };
}
