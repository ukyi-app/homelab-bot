import { z } from 'zod';
import { Denied } from './contracts.js';
import type { Scope } from './contracts.js';
import type { TransactionDeadline } from './database.js';
import { AlreadyAttached, EXTERNAL_LINK_TTL_MS, EXTERNAL_TASK_EXECUTORS, EXTERNAL_TASK_ID } from './external-task-links.js';
import type { ExternalTaskExecutor, ExternalTaskLinks, IssuedLink } from './external-task-links.js';
import { kstTime } from './external-task-receiver.js';
import { errorInfo } from './log.js';
import type { Log } from './log.js';
import type { Store } from './store.js';

// R08 연결 명령과 연결 수명 사이. 개인 seed가 평문이 되는 곳은 seedMessage 하나뿐이고, 그 글은 deliver로만 나간다.
// 반환값·로그·감사에는 seed가 실리지 않는다. 그래서 전달에 실패해도 그 글을 다시 보낼 수 없고, 키를 폐기한다.
export type ExternalTaskCommand = 'attach' | 'detach' | 'attach-list';
export interface ExternalCommandRequest { actor: string; scope: Scope; command: ExternalTaskCommand; text: string; target?: string }
// content가 없으면 deliver로 이미 답했다는 뜻이다.
export interface ExternalCommandReply { content?: string; outcome: string }
// "키 보기" 버튼 한 번. proposal은 custom_id의 제안 ID다. deadline은 제안 행 잠금 대기의 상한(수신 마감)이다.
export interface SessionKeyRequest { store: Store; actor: string; scope: Scope; proposal: string; deadline?: TransactionDeadline }
export interface ExternalTaskCommandHandler {
  // deliver: 키가 든 글을 본인에게만 전한다. 다시 보낼 수 없으므로 성공 여부를 돌려받아 폐기를 정한다.
  handle(request: ExternalCommandRequest, deliver: (content: string) => Promise<boolean>): Promise<ExternalCommandReply>;
  // 동료 기능 스위치가 켜졌을 때만 수신이 부른다. 없으면 "키 보기" 버튼을 닫는다.
  showKey?(request: SessionKeyRequest, deliver: (content: string) => Promise<boolean>): Promise<ExternalCommandReply>;
}
const ATTACH_USAGE = '/attach target:<세션 ID> text:<claude 또는 codex> 로 쓰세요. 내용 요약에 동의하면 text 뒤에 summary=on을 붙입니다. 세션 ID는 영문·숫자·. _ : - 만 쓸 수 있습니다(경로 불가).';
const THREAD_ONLY = '세션 연결은 대화 스레드에서만 쓸 수 있습니다. /chat으로 스레드를 연 뒤 그 스레드에서 실행하세요.';
const NOT_ATTACHABLE = '이 스레드에는 연결할 수 없습니다. 본인의 활성 스레드에서 실행하세요(/resume으로 다시 켤 수 있습니다).';
const ALREADY_ATTACHED = '이 스레드에 이미 연결된 세션입니다. 키를 잃었다면 /attach-list로 연결 ID를 확인해 /detach 한 뒤 다시 /attach 하세요.';
const NOT_VISIBLE = '볼 수 있는 연결이 아닙니다.';
const DELIVERY_FAILED = '연결 키를 전하지 못해 그 연결을 폐기했습니다. 키가 잠깐 보였어도 쓸 수 없습니다. 다시 /attach 하세요.';
const REVOKE_UNCONFIRMED = '연결 키를 전하지 못했고 폐기도 확인하지 못했습니다. /attach-list에서 연결 ID를 확인해 /detach 하세요.';
const SLASH_ISSUE_TEXT = { alreadyAttached: ALREADY_ATTACHED, notAttachable: NOT_ATTACHABLE, deliveryFailed: DELIVERY_FAILED, revokeUnconfirmed: REVOKE_UNCONFIRMED };

// 말로 하는 세션 연결(COLLEAGUE_SPEC §4.3 "세션 연결 키"). 동료 기능 스위치가 켜졌을 때만 나가므로 '/' 이름을 안내하지 않는다.
export const SESSION_KEY_BUTTON = 'session-key';
const consentText = (consent: boolean) => consent ? '턴 요약도 받아요' : '요약 없이 턴 완료만 받아요';
export const SESSION_KEY_TEXT = Object.freeze({
  button: '키 보기',
  question: (externalTaskId: string, executor: ExternalTaskExecutor, consent: boolean) =>
    `이 스레드에 ${executor} 세션 \`${externalTaskId}\`를 연결할까요? ${consentText(consent)}.`,
  questionWithheld: (executor: ExternalTaskExecutor, consent: boolean) =>
    `방금 말한 ${executor} 세션을 이 스레드에 연결할까요? ${consentText(consent)}.\n> 밖에 보이면 안 되는 내용이 섞여 있어 세션 ID는 싣지 않았어요.`,
  // 확인 글을 이 문구로 바꾸는 응답은 공개 글이고 공개 검사를 거치지 않는다. 확인 글에서 숨겼을 수 있는 세션 ID를 싣지 않는다.
  confirmed: (executor: ExternalTaskExecutor) => `${executor} 세션을 이 스레드에 연결하기로 했어요.`,
  ready: '"키 보기"를 누르면 연결 키가 누른 분에게만 한 번 보여요. 키는 다시 볼 수 없어요.',
  shown: '이 연결 키는 이미 보여 드렸어요. 다시 보여 드릴 수 없어요.',
  missing: '이 대화에서 찾을 수 없는 연결이에요.',
  notOwner: '연결을 부탁한 사람만 키를 볼 수 있어요.',
  expired: '24시간이 지나서 이 연결 키는 볼 수 없어요. 필요하면 다시 연결해 달라고 말해 주세요.',
  stopped: '이 대화는 구독이 꺼져 있어서 키를 만들지 않았어요. 구독을 다시 켠 뒤 다시 눌러 주세요.',
  alreadyAttached: '이 스레드에 이미 연결된 세션이에요. 키를 잃었다면 그 연결을 해제해 달라고 한 뒤 다시 연결해 달라고 말해 주세요.',
  notAttachable: '이 스레드에는 연결할 수 없어요. 본인의 활성 스레드에서 다시 말해 주세요.',
  deliveryFailed: '연결 키를 전하지 못해 그 연결을 닫았어요. 키가 잠깐 보였어도 쓸 수 없어요. 다시 연결해 달라고 말해 주세요.',
  revokeUnconfirmed: '연결 키를 전하지 못했고 연결을 닫았는지도 확인하지 못했어요. 세션 연결 목록을 본 뒤 그 연결을 해제해 달라고 말해 주세요.',
  failed: '처리하지 못했어요(일시 오류). 세션 연결 목록에서 결과를 확인해 주세요.',
  ackLost: '세션 연결 키 응답을 전하지 못했어요(상호작용 만료·전송 실패). 결과는 세션 연결 목록에서 확인해 주세요.',
});
// 제안 행의 reason으로 키를 아직 보이지 않았는지를 적는다. 끝 상태(confirmed)는 C13 표의 한 번 전이 그대로이고,
// 키는 key_pending → key_shown 조건부 UPDATE 한 번으로만 만든다(두 번째 누름은 그 UPDATE가 0행이다).
export const KEY_PENDING = 'key_pending';
const KEY_SHOWN = 'key_shown';
export interface AttachSpec { externalTaskId: string; executor: ExternalTaskExecutor; summaryConsent: boolean }
// 끝 상태가 되면 제안 행의 value가 비워지므로 실행기·동의까지 target 한 칸에 둔다. 모두 서버가 형식을 대조한 값이다.
const AttachTarget = z.tuple([z.string().regex(EXTERNAL_TASK_ID), z.enum(EXTERNAL_TASK_EXECUTORS), z.boolean()]);
export const attachTarget = (spec: AttachSpec) => JSON.stringify([spec.externalTaskId, spec.executor, spec.summaryConsent]);
export function readAttachTarget(target: string | null): AttachSpec | undefined {
  if (target === null) return;
  try {
    const parsed = AttachTarget.safeParse(JSON.parse(target));
    if (!parsed.success) return;
    const [externalTaskId, executor, summaryConsent] = parsed.data;
    return { externalTaskId, executor, summaryConsent };
  } catch { return undefined; }
}

// R08 경계상 이 모듈은 proposals.ts를 import하지 않으므로 필요한 칸만 따로 적는다.
interface KeyProposalRow { id: string; conversation_id: string; owner_id: string; action: string; target: string | null; state: string; reason: string | null; expires_at: string | number }

// "키 보기"의 검사와 1회 표시. 대화 행 → 제안 행 순서로 잠근다(실행 확인 버튼과 같은 순서).
// 검사에 걸려 키를 만들지 않은 경우는 표시하지 않아, 원인을 고친 뒤 다시 누를 수 있다.
async function claimKey(store: Store, request: SessionKeyRequest): Promise<AttachSpec | ExternalCommandReply> {
  const conversation = await store.ownedConversation(request.scope, request.actor, true);
  const row = (await store.db.query<KeyProposalRow>('SELECT * FROM proposals WHERE id=$1 FOR UPDATE', [request.proposal])).rows[0];
  const spec = row && readAttachTarget(row.target);
  if (!row || !spec || row.conversation_id !== conversation.id || row.action !== 'attach' || row.state !== 'confirmed') {
    return { content: SESSION_KEY_TEXT.missing, outcome: 'missing' };
  }
  if (row.owner_id !== request.actor) return { content: SESSION_KEY_TEXT.notOwner, outcome: 'not_owner' };
  if (row.reason !== KEY_PENDING) return { content: SESSION_KEY_TEXT.shown, outcome: 'already_shown' };
  if (store.now() >= Number(row.expires_at)) return { content: SESSION_KEY_TEXT.expired, outcome: 'expired' };
  if (!conversation.active) return { content: SESSION_KEY_TEXT.stopped, outcome: 'subscription_stopped' };
  const claimed = await store.db.query(`UPDATE proposals SET reason=$2 WHERE id=$1 AND state='confirmed' AND reason=$3 RETURNING id`,
    [row.id, KEY_SHOWN, KEY_PENDING]);
  if (!claimed.rows.length) return { content: SESSION_KEY_TEXT.shown, outcome: 'already_shown' };
  await store.audit('session_key_claimed', row.id, { executor: spec.executor });
  return spec;
}

export function parseAttach(text: string): { executor: ExternalTaskExecutor; summaryConsent: boolean } | undefined {
  const [executor, consent, ...rest] = text.trim().split(/\s+/);
  if ((executor !== 'claude' && executor !== 'codex') || rest.length || (consent !== undefined && consent !== 'summary=on')) return undefined;
  return { executor, summaryConsent: consent !== undefined };
}
// seed를 꺼내는 유일한 자리. 여기서 만든 글은 호출자가 deliver에만 넘긴다.
function seedMessage(link: IssuedLink, environment: string): string {
  const days = EXTERNAL_LINK_TTL_MS / 86_400_000;
  return ['세션을 연결했습니다. 이 응답은 본인에게만 보이고 **seed는 다시 볼 수 없습니다.**',
    `connection_id: \`${link.connectionId}\``, `key_id: \`${link.keyId}\``, `environment: \`${environment}\``,
    `executor: \`${link.executor}\``, `external_task_id: \`${link.externalTaskId}\``, `summary_consent: \`${link.summaryConsent}\``,
    `만료: ${kstTime(link.expiresAt)} (${days}일)`, `seed: \`${link.seed.reveal()}\``,
    'seed는 Keychain 같은 비밀 저장소에 넣으세요. 명령 인자·셸 이력·설정 파일에 쓰지 마세요. 설치 안내는 저장소의 tools/r08-helper/README.md입니다.',
    '이 키로는 턴 완료 알림만 보낼 수 있습니다. 모델 호출·작업 시작·답·취소·재개 권한은 없습니다.'].join('\n');
}
const STATE_TEXT = { active: '활성', expired: '만료', revoked: '닫힘' } as const;
// Discord 응답 상한은 2,000자이고 목록은 최대 10건, 외부 세션 ID는 128자까지다. 그대로 쓰면 넘어 응답 전체가 거절된다.
// 해제에 쓰는 연결 ID는 그대로 두고 세션 ID만 앞 40자로 줄인다(Claude 세션 UUID 36자는 그대로 보인다). 그러면 최악의 10건도 상한 안이다(시험이 길이를 고정한다).
// 세션 ID는 ASCII만 받아(EXTERNAL_TASK_ID) 문자 수와 length가 같다.
const LIST_TASK_ID_CHARS = 40;
const shortTaskId = (id: string) => id.length > LIST_TASK_ID_CHARS ? `${id.slice(0, LIST_TASK_ID_CHARS)}…` : id;

export class ExternalTaskCommands implements ExternalTaskCommandHandler {
  constructor(private readonly links: Pick<ExternalTaskLinks, 'attach' | 'detach' | 'list' | 'revoke'>, private readonly environment: string, private readonly log: Log) {}
  async handle(request: ExternalCommandRequest, deliver: (content: string) => Promise<boolean>): Promise<ExternalCommandReply> {
    if (request.command === 'attach') return this.attach(request, deliver);
    if (request.command === 'detach') return this.detach(request);
    return this.list(request);
  }
  private async attach(request: ExternalCommandRequest, deliver: (content: string) => Promise<boolean>): Promise<ExternalCommandReply> {
    if (request.scope.kind === 'channel') return { content: THREAD_ONLY, outcome: 'wrong_scope' };
    const parsed = parseAttach(request.text);
    if (!parsed || !request.target || !EXTERNAL_TASK_ID.test(request.target)) return { content: ATTACH_USAGE, outcome: 'usage' };
    return this.issue(request.actor, request.scope, { externalTaskId: request.target, ...parsed }, deliver, SLASH_ISSUE_TEXT);
  }
  // 키는 검사를 통과한 이 상호작용 안에서 만들어 그 응답으로만 보낸다. 상호작용 사이에 키를 보관하지 않는다.
  async showKey(request: SessionKeyRequest, deliver: (content: string) => Promise<boolean>): Promise<ExternalCommandReply> {
    const claimed = await request.store.atomic(store => claimKey(store, request), request.deadline);
    if ('outcome' in claimed) return claimed;
    return this.issue(request.actor, request.scope, claimed, deliver, SESSION_KEY_TEXT);
  }
  private async issue(owner: string, scope: Scope, spec: AttachSpec, deliver: (content: string) => Promise<boolean>,
    text: typeof SLASH_ISSUE_TEXT): Promise<ExternalCommandReply> {
    let link: IssuedLink;
    try {
      link = await this.links.attach({ owner, scope, ...spec });
    } catch (error) {
      if (error instanceof AlreadyAttached) return { content: text.alreadyAttached, outcome: 'already_attached' };
      if (error instanceof Denied) return { content: text.notAttachable, outcome: 'denied' };
      throw error;
    }
    if (await deliver(seedMessage(link, this.environment))) return { outcome: 'attached' };
    // 전해졌는지 모르는 키는 누가 쥐고 있는지 모른다. 쓰이기 전에 닫는다.
    try {
      await this.links.revoke(link.connectionId, owner, 'delivery_failed');
      return { content: text.deliveryFailed, outcome: 'delivery_failed' };
    } catch (error) {
      this.log('external_task_revoke_failed', errorInfo(error));
      return { content: text.revokeUnconfirmed, outcome: 'delivery_failed_unrevoked' };
    }
  }
  private async detach(request: ExternalCommandRequest): Promise<ExternalCommandReply> {
    if (!request.target) return { content: NOT_VISIBLE, outcome: 'usage' };
    try {
      const { blocked } = await this.links.detach(request.target, request.actor);
      return { content: `연결을 해제했습니다. 이 연결의 새 알림은 거절되고, 미게시 알림 ${blocked}건을 막았습니다.`, outcome: 'detached' };
    } catch (error) {
      // 타인 연결과 없는 연결을 구별해 알리지 않는다.
      if (error instanceof Denied) return { content: NOT_VISIBLE, outcome: 'denied' };
      throw error;
    }
  }
  private async list(request: ExternalCommandRequest): Promise<ExternalCommandReply> {
    if (request.scope.kind === 'channel') return { content: THREAD_ONLY, outcome: 'wrong_scope' };
    const { items, more } = await this.links.list(request.actor, request.scope);
    if (!items.length) return { content: '이 스레드에 연결한 세션이 없습니다.', outcome: 'empty' };
    const lines = items.map(item => `\`${item.connectionId}\` ${item.executor} \`${shortTaskId(item.externalTaskId)}\` · ${STATE_TEXT[item.state]}${item.revokedReason ? `(${item.revokedReason})` : ''}`
      + ` · 요약 ${item.summaryConsent ? '동의' : '없음'} · 만료 ${kstTime(item.expiresAt)} · 마지막 알림 ${item.lastEventAt === null ? '없음' : kstTime(item.lastEventAt)}`);
    return { content: ['읽기 전용 연결입니다. 사람 세션의 자기 보고만 받고 봇이 결과를 확인하지 않습니다.', ...lines, ...(more ? ['(더 있음. 활성 연결부터 최근 10건만 표시)'] : [])].join('\n'), outcome: 'listed' };
  }
}
