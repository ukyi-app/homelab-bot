import { Denied } from './contracts.js';
import type { Scope } from './contracts.js';
import { AlreadyAttached, EXTERNAL_LINK_TTL_MS, EXTERNAL_TASK_ID } from './external-task-links.js';
import type { ExternalTaskExecutor, ExternalTaskLinks, IssuedLink } from './external-task-links.js';
import { kstTime } from './external-task-receiver.js';
import { errorInfo } from './log.js';
import type { Log } from './log.js';

// R08 연결 명령과 연결 수명 사이. 개인 seed가 평문이 되는 곳은 seedMessage 하나뿐이고, 그 글은 deliver로만 나간다.
// 반환값·로그·감사에는 seed가 실리지 않는다. 그래서 전달에 실패해도 그 글을 다시 보낼 수 없고, 키를 폐기한다.
export type ExternalTaskCommand = 'attach' | 'detach' | 'attach-list';
export interface ExternalCommandRequest { actor: string; scope: Scope; command: ExternalTaskCommand; text: string; target?: string }
// content가 없으면 deliver로 이미 답했다는 뜻이다.
export interface ExternalCommandReply { content?: string; outcome: string }
export interface ExternalTaskCommandHandler {
  // deliver: 키가 든 글을 본인에게만 전한다. 다시 보낼 수 없으므로 성공 여부를 돌려받아 폐기를 정한다.
  handle(request: ExternalCommandRequest, deliver: (content: string) => Promise<boolean>): Promise<ExternalCommandReply>;
}
const ATTACH_USAGE = '/attach target:<세션 ID> text:<claude 또는 codex> 로 쓰세요. 내용 요약에 동의하면 text 뒤에 summary=on을 붙입니다. 세션 ID는 영문·숫자·. _ : - 만 쓸 수 있습니다(경로 불가).';
const THREAD_ONLY = '세션 연결은 대화 스레드에서만 쓸 수 있습니다. /chat으로 스레드를 연 뒤 그 스레드에서 실행하세요.';
const NOT_ATTACHABLE = '이 스레드에는 연결할 수 없습니다. 본인의 활성 스레드에서 실행하세요(/resume으로 다시 켤 수 있습니다).';
const ALREADY_ATTACHED = '이 스레드에 이미 연결된 세션입니다. 키를 잃었다면 /attach-list로 연결 ID를 확인해 /detach 한 뒤 다시 /attach 하세요.';
const NOT_VISIBLE = '볼 수 있는 연결이 아닙니다.';
const DELIVERY_FAILED = '연결 키를 전하지 못해 그 연결을 폐기했습니다. 키가 잠깐 보였어도 쓸 수 없습니다. 다시 /attach 하세요.';
const REVOKE_UNCONFIRMED = '연결 키를 전하지 못했고 폐기도 확인하지 못했습니다. /attach-list에서 연결 ID를 확인해 /detach 하세요.';

function parseAttach(text: string): { executor: ExternalTaskExecutor; summaryConsent: boolean } | undefined {
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
    let link: IssuedLink;
    try {
      link = await this.links.attach({ owner: request.actor, scope: request.scope, externalTaskId: request.target, ...parsed });
    } catch (error) {
      if (error instanceof AlreadyAttached) return { content: ALREADY_ATTACHED, outcome: 'already_attached' };
      if (error instanceof Denied) return { content: NOT_ATTACHABLE, outcome: 'denied' };
      throw error;
    }
    if (await deliver(seedMessage(link, this.environment))) return { outcome: 'attached' };
    // 전해졌는지 모르는 키는 누가 쥐고 있는지 모른다. 쓰이기 전에 닫는다.
    try {
      await this.links.revoke(link.connectionId, request.actor, 'delivery_failed');
      return { content: DELIVERY_FAILED, outcome: 'delivery_failed' };
    } catch (error) {
      this.log('external_task_revoke_failed', errorInfo(error));
      return { content: REVOKE_UNCONFIRMED, outcome: 'delivery_failed_unrevoked' };
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
    const lines = items.map(item => `\`${item.connectionId}\` ${item.executor} \`${item.externalTaskId}\` · ${STATE_TEXT[item.state]}${item.revokedReason ? `(${item.revokedReason})` : ''}`
      + ` · 요약 ${item.summaryConsent ? '동의' : '없음'} · 만료 ${kstTime(item.expiresAt)} · 마지막 알림 ${item.lastEventAt === null ? '없음' : kstTime(item.lastEventAt)}`);
    return { content: ['읽기 전용 연결입니다. 사람 세션의 자기 보고만 받고 봇이 결과를 확인하지 않습니다.', ...lines, ...(more ? ['(더 있음. 최근 10건만 표시)'] : [])].join('\n'), outcome: 'listed' };
  }
}
