import { createHash, randomUUID } from 'node:crypto';
import { ownerText } from './chat-context.js';
import type { Job, Proposal, Scope } from './contracts.js';
import { controlText, taskLaneClosedText } from './control-format.js';
import type { Policy, PolicyGate } from './policy.js';
import { LaneClosed } from './store.js';
import type { OutboxButton, Store } from './store.js';
import type { TaskCommandHandler } from './task-commands.js';
import { taskProject } from './task-policy.js';

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
  taskStarted: (project: string, job: string) => `${project} 저장소에서 작업을 시작했어요. 작업 ID는 \`${job}\`예요.`,
  declined: '알겠어요, 하지 않을게요.',
  expired: '24시간이 지나서 이 제안은 끝났어요. 필요하면 다시 말해 주세요.',
  settled: '이미 처리한 제안이에요.',
  changed: '제안한 뒤로 내용이 바뀌어서 실행하지 않았어요. 다시 말해 주세요.',
  missing: '이 대화에서 찾을 수 없는 제안이에요.',
  notOwner: '제안을 받은 사람만 누를 수 있어요.',
  unavailable: '지금은 이 일을 할 수 없어요. 잠시 뒤 다시 말해 주세요.',
});

// 명세 §4.3 동작 표의 종류. admin(관리 기능)·none(구독 끄기·켜기, 급한 질문)은 말로 하지 않으므로 처리기를 달지 않고 늘 버린다.
export type ActionKind = 'read' | 'run' | 'question' | 'publish' | 'admin' | 'none';
interface ReadContext { store: Store; job: Job }
interface ReadHandler { kind: 'read'; run(context: ReadContext): Promise<string> }
// digest 재료. 버튼을 누를 때 저장된 참조로 다시 만들어 제안 때의 digest와 대조한다.
interface Values { target: string | null; content: string | null }
interface Prepared extends Values {
  // 모델이 고른 값(C14 기억 진술)만 value에 둔다. owner 원문은 sourceEvent 참조로만 둔다.
  value: string | null; sourceEvent: string | null; question: string;
}
interface PrepareContext { store: Store; job: Job; proposal: Proposal; policy: Policy; tasksConnected: boolean }
export interface ProposalRow {
  id: string; conversation_id: string; owner_id: string; scope: Scope; action: string; target: string | null;
  value: string | null; source_event: string | null; digest: string; source_job: string; state: string;
  expires_at: string; message_key: string;
}
export interface ExecuteContext { tasks?: TaskCommandHandler; revision: string }
interface Executed { state: 'confirmed' | 'refused'; content: string; reason?: string; job?: string }
interface RunHandler {
  kind: 'run';
  // 제안 때 허용 대상 대조와 값 준비. undefined면 그 제안을 버린다(대화 답만 나간다).
  prepare(context: PrepareContext): Promise<Prepared | undefined>;
  // 버튼 때 저장된 값·참조로 지금 값을 다시 만든다. 원문이 비었으면 undefined.
  current(store: Store, row: ProposalRow): Promise<Values | undefined>;
  // '/' 처리기와 같은 경로로 실행한다. 호출자의 트랜잭션 안이다.
  execute(store: Store, row: ProposalRow, values: Values, context: ExecuteContext): Promise<Executed>;
}
export interface ActionRow { kind: ActionKind; command: string; handler?: ReadHandler | RunHandler }

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
      question: PROPOSAL_TEXT.taskQuestion(proposal.target, preview(content)) };
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

// 동작 표. 키는 작업자 계약의 제안 동작 ID(contracts.ts PROPOSAL_ACTIONS, '/' 이름의 하이픈을 밑줄로)이고,
// 계약에 없는 줄(작업 질문·게시 승인·관리 기능·없음)은 종류를 적어 두기만 한다. 처리기가 없는 줄은 "연결 안 됨"이라 버린다.
// 뒤 티켓(C14~C17)은 줄에 처리기를 달거나 줄을 더한다.
export const ACTIONS: Readonly<Record<string, ActionRow>> = Object.freeze({
  list: { kind: 'read', command: 'list', handler: listHandler },
  task_status: { kind: 'read', command: 'task-status' },
  change_status: { kind: 'read', command: 'change-status' },
  review_status: { kind: 'read', command: 'review-status' },
  read: { kind: 'read', command: 'read' },
  memory_search: { kind: 'read', command: 'memory-search' },
  attach_list: { kind: 'read', command: 'attach-list' },
  task: { kind: 'run', command: 'task', handler: taskHandler },
  cancel: { kind: 'run', command: 'cancel' },
  task_cancel: { kind: 'run', command: 'task-cancel' },
  retry: { kind: 'run', command: 'retry' },
  memory_save: { kind: 'run', command: 'memory-save' },
  memory_correct: { kind: 'run', command: 'memory-correct' },
  memory_exclude: { kind: 'run', command: 'memory-exclude' },
  memory_delete: { kind: 'run', command: 'memory-delete' },
  attach: { kind: 'run', command: 'attach' },
  detach: { kind: 'run', command: 'detach' },
  change: { kind: 'run', command: 'change' },
  change_cancel: { kind: 'run', command: 'change-cancel' },
  review_resume: { kind: 'run', command: 'review-resume' },
  review_cancel: { kind: 'run', command: 'review-cancel' },
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
});
const connected = (action: string): ReadHandler | RunHandler | undefined => {
  const row = Object.hasOwn(ACTIONS, action) ? ACTIONS[action] : undefined;
  return row && row.kind !== 'admin' && row.kind !== 'none' ? row.handler : undefined;
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
  constructor(private readonly store: Store, private readonly gate: PolicyGate, private readonly tasksConnected: boolean) {}
  async consider(job: Job, proposal: Proposal, policy: Policy): Promise<'read' | 'proposed' | 'dropped'> {
    // 버린 제안은 동작과 사유만 남긴다(값은 남기지 않는다).
    const drop = async (reason: string) => { await this.store.audit('proposal_dropped', job.id, { action: proposal.action, reason }); return 'dropped' as const; };
    const handler = connected(proposal.action);
    if (!handler) return drop('not_connected');
    if (!await this.current(job)) return drop('superseded');
    if (handler.kind === 'read') {
      // '/' 읽기 명령의 수신과 같은 인가(현재 정책 owner·허용 채널·거부 목록) 뒤 같은 처리기를 부른다.
      await this.gate.authorize(job.owner_id, job.target);
      const content = await handler.run({ store: this.store, job });
      await this.store.enqueue({ key: `result:${job.id}:read`, job: job.id, conversation: job.conversation_id, actor: job.owner_id,
        scope: job.target, revision: job.revision.policy,
        payload: { kind: 'message', channel: job.target.channel, content, classification: 'safe_summary' } });
      return 'read';
    }
    const prepared = await handler.prepare({ store: this.store, job, proposal, policy, tasksConnected: this.tasksConnected });
    if (!prepared) return drop('target_denied');
    const id = randomUUID();
    // 확인 글은 대화 답(result:<job>) 뒤에 나가게 같은 접두의 키를 쓴다. 게시 순서는 created_at·message_key 순이다.
    const key = `result:${job.id}:proposal`;
    const made = await this.store.atomic(async store => {
      // 버튼 처리와 같은 잠금 순서(대화 행 → 제안 행)다.
      await store.db.query('SELECT id FROM conversations WHERE id=$1 FOR UPDATE', [job.conversation_id]);
      await expirePending(store);
      const inserted = await store.db.query(`INSERT INTO proposals(id,conversation_id,owner_id,scope,action,target,value,source_event,digest,
        source_job,message_key,created_at,expires_at) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)
        ON CONFLICT (source_job) DO NOTHING RETURNING id`, [id, job.conversation_id, job.owner_id, JSON.stringify(job.target),
        proposal.action, prepared.target, prepared.value, prepared.sourceEvent, proposalDigest(proposal.action, prepared), job.id, key,
        store.now(), store.now() + PROPOSAL_TTL_MS]);
      if (!inserted.rows.length) return false;
      await store.enqueue({ key, job: job.id, conversation: job.conversation_id, actor: job.owner_id, scope: job.target,
        revision: job.revision.policy, payload: { kind: 'message', channel: job.target.channel, content: prepared.question,
          classification: 'safe_summary', buttons: proposalButtons(id) } });
      return true;
    });
    return made ? 'proposed' : 'dropped';
  }
  // 결과가 succeeded로 확정됐고, 그 뒤 같은 대화에 새 대화 요청이 오지 않았다. 새 메시지가 대화를 대체했으면 제안을 만들지 않는다
  // (다음 대화 차례가 같은 기록을 보고 다시 판단한다).
  private async current(job: Job): Promise<boolean> {
    const row = (await this.store.db.query<{ current: boolean }>(`SELECT j.state='succeeded' AND NOT EXISTS (SELECT 1 FROM jobs n
      JOIN events ne ON ne.id=n.event_id WHERE n.conversation_id=j.conversation_id AND n.type='chat' AND n.id<>j.id
        AND ne.event_order>(SELECT event_order FROM events WHERE id=j.event_id)) AS current FROM jobs j WHERE j.id=$1`, [job.id])).rows[0];
    return row?.current === true;
  }
}

// 만료된 대기 제안을 끝내고 값을 비운다. 버튼을 누르지 않은 제안의 값이 24시간 넘게 남지 않게 새 제안을 만들 때마다 부른다.
async function expirePending(store: Store): Promise<void> {
  await store.db.query(`UPDATE proposals SET state='expired',reason='expired',value=NULL,source_event=NULL,settled_at=$1
    WHERE state='pending' AND expires_at<=$1`, [store.now()]);
}

export interface PressInput { proposal: string; answer: 'yes' | 'no'; actor: string; scope: Scope; event: string; context: ExecuteContext }
// update: 응답으로 그 글의 버튼을 없앤다(처리·거절·만료·이미 처리됨). false면 본인만 보는 응답이고 버튼은 남는다.
export interface PressOutcome { content: string; update: boolean }
// 버튼 하나의 처리. 호출자(수신)의 트랜잭션 안에서 부른다. 대화 행 → 제안 행 순서로 잠그고, 상태 전이는 state='pending' 조건부라
// 같은 제안을 두 번 눌러도 한 번만 실행된다. 실행은 '/' 처리기와 같은 경로라 권한·정책 검사가 같다.
export async function pressProposal(store: Store, input: PressInput): Promise<PressOutcome> {
  const conversation = await store.ownedConversation(input.scope, input.actor, true);
  const row = (await store.db.query<ProposalRow>('SELECT * FROM proposals WHERE id=$1 FOR UPDATE', [input.proposal])).rows[0];
  if (!row || row.conversation_id !== conversation.id) return { content: PROPOSAL_TEXT.missing, update: true };
  if (row.owner_id !== input.actor) return { content: PROPOSAL_TEXT.notOwner, update: false };
  if (row.state !== 'pending') return { content: PROPOSAL_TEXT.settled, update: true };
  const settle = async (state: string, reason: string | null, job: string | null = null) => {
    const changed = await store.db.query(`UPDATE proposals SET state=$2,reason=$3,result_job=$4,value=NULL,source_event=NULL,settled_at=$5,settled_by=$6
      WHERE id=$1 AND state='pending' RETURNING id`, [row.id, state, reason, job, store.now(), input.event]);
    if (!changed.rows.length) throw new Error('proposal_state_changed');
    await store.audit('proposal_settled', row.id, { action: row.action, state, reason, job });
  };
  if (store.now() >= Number(row.expires_at)) { await settle('expired', 'expired'); return { content: PROPOSAL_TEXT.expired, update: true }; }
  if (input.answer === 'no') { await settle('declined', null); return { content: PROPOSAL_TEXT.declined, update: true }; }
  const handler = connected(row.action);
  if (handler?.kind !== 'run') { await settle('refused', 'not_connected'); return { content: PROPOSAL_TEXT.unavailable, update: true }; }
  const values = await handler.current(store, row);
  if (!values || proposalDigest(row.action, values) !== row.digest) {
    await settle('refused', 'digest_changed');
    return { content: PROPOSAL_TEXT.changed, update: true };
  }
  const executed = await handler.execute(store, row, values, input.context);
  await settle(executed.state, executed.reason ?? null, executed.job ?? null);
  return { content: executed.content, update: true };
}
