import { createHash, randomUUID } from 'node:crypto';
import { z } from 'zod';
import { DEFAULTS, Denied, DiscordRejected, DiscordUnauthorized, HistoryGap, PolicyUnavailable, RateLimited, ScopeSchema } from './contracts.js';
import type { EventInput, Scope } from './contracts.js';
import { controlText, taskLaneClosedText } from './control-format.js';
import { errorInfo, jsonLog } from './log.js';
import type { Log } from './log.js';
import type { ChangeCommand, ChangeCommandHandler } from './change-commands.js';
import type { ExternalTaskCommand, ExternalTaskCommandHandler } from './external-task-commands.js';
import type { MemoryCommand, MemoryCommandHandler } from './memory-commands.js';
import type { PolicyGate } from './policy.js';
import { LaneClosed } from './store.js';
import type { Delivery, Store } from './store.js';
import type { TaskCommandHandler } from './task-commands.js';

// 일반 메시지 수신 표시가 리액션 대신 텍스트로 대체됐을 때의 거부 상태(권한 점검 신호).
export interface AckOutcome { fallback: 403 | 404 }
export interface DiscordRest {
  acknowledge(event: EventInput, content: string, options: { allowed_mentions: { parse: never[] }; flags?: typeof SUPPRESS_EMBEDS }): Promise<AckOutcome | void>;
  createThread(channel: string, body: { name: string; type: 11; auto_archive_duration: 1440 }): Promise<{ id: string }>;
  sendMessage(channel: string, body: { content: string; nonce: string; enforce_nonce: true; allowed_mentions: { parse: never[] } }): Promise<{ id: string }>;
  findDelivery(channel: string, marker: string, kind: 'message' | 'thread'): Promise<{ id: string } | undefined>;
  history(channel: string, after: string | null, limit: 100): Promise<EventInput[]>;
}
const noMentions = { allowed_mentions: { parse: [] as never[] } };
// Discord 메시지 플래그 SUPPRESS_EMBEDS. 기억 명령 응답의 문서 링크(`doc=`)에 미리보기 카드가 붙는다(실연동).
// 기억 응답은 ID·상태를 보는 용도라 끈다. 다른 명령 응답은 그대로 둔다.
export const SUPPRESS_EMBEDS = 4 as const;
const controls = new Set(['stop', 'resume', 'list', 'cancel', 'retry', 'emergency-stop', 'resume-model', 'model-status', 'revoke',
  'review-status', 'review-resume', 'review-cancel', 'answer', 'task-status', 'task-cancel', 'task-release']);
// 작업 레인 제어. 처리기가 없으면(스위치 꺼짐) 닫는다. 조회·해제는 작업자나 다른 연결을 쓸 수 있어 수신 트랜잭션 밖에서 처리한다.
const taskControls = new Set<string>(['answer', 'task-status', 'task-cancel', 'task-release']);
const taskDirect = new Set<string>(['task-status', 'task-release']);
// 수신이 아는 명령 전체. 배포 진입점은 단계에 맞춰 더 좁은 목록(FOUNDATION_COMMANDS)을 넘긴다.
export type RecoveryOutcome = 'done' | 'budget' | 'skipped';
// 기억 명령. 대화 작업·제어와 달리 받은 자리에서 기억 서비스로 처리하고 상호작용 응답으로만 답한다.
const memoryCommands = new Set<string>(['memory-save', 'memory-search', 'memory-correct', 'memory-exclude', 'memory-delete']);
// R08 연결 명령. 처리기가 없으면(스위치 꺼짐) 닫는다. 키가 든 응답을 다루므로 대화 작업·제어 경로를 타지 않는다.
const externalCommands = new Set<string>(['attach', 'detach', 'attach-list']);
// 변경 명령. 처리기가 없으면(스위치 꺼짐) 닫는다. 구독·gap·작업 큐를 거치지 않고 받은 자리에서 처리한다.
const changeCommands = new Set<string>(['change', 'change-status', 'change-cancel', 'change-publish']);
export const ALL_COMMANDS: ReadonlySet<string> = new Set(['chat', 'urgent', 'task', 'read', ...controls, ...memoryCommands, ...externalCommands, ...changeCommands]);
export const CHANGE_ACK_NOTICE = '변경 명령의 응답을 전하지 못했습니다(상호작용 만료·전송 실패). 결과는 이 스레드의 알림과 /change-status로 확인하세요.';
// 기억 명령 응답을 전하지 못했을 때 그 채널에 남기는 안내. 결과(기억 내용)는 싣지 않는다.
export const MEMORY_ACK_NOTICE = '기억 명령의 응답을 전하지 못했습니다(상호작용 만료·전송 실패). 처리됐는지는 /memory-search로 확인하세요.';
export const EXTERNAL_ACK_NOTICE = '세션 연결 명령의 응답을 전하지 못했습니다(상호작용 만료·전송 실패). 결과는 /attach-list로 확인하세요.';
const EventSchema = z.strictObject({
  id: z.string().min(1), actor: z.string().min(1), scope: ScopeSchema,
  text: z.string().max(DEFAULTS.maxInputChars), kind: z.enum(['message', 'command', 'button']),
  bot: z.boolean().optional(), webhook: z.boolean().optional(), mention: z.boolean().optional(),
  command: z.string().optional(), target: z.string().optional(), urgent: z.boolean().optional(),
});
export class DiscordIngress {
  constructor(private readonly store: Store, private readonly gate: PolicyGate,
    private readonly rest: DiscordRest, public readonly messageContent = true,
    private readonly commands: ReadonlySet<string> = ALL_COMMANDS, private readonly log: Log = jsonLog,
    private readonly memory?: MemoryCommandHandler, private readonly tasks?: TaskCommandHandler,
    private readonly external?: ExternalTaskCommandHandler, private readonly changes?: ChangeCommandHandler) {}
  async receive(input: EventInput, recovered = false, recovery?: { token: string; epoch: number }): Promise<string | undefined> {
    const event = EventSchema.parse(input);
    if (event.bot || event.webhook) return;
    // 이 단계에서 열지 않은 명령·버튼은 저장·권한 확인 전에 닫는다(task·review-*는 FOUNDATION 밖).
    if (event.kind !== 'message' && !this.commands.has(event.command ?? '')) throw new Denied();
    if (event.kind !== 'message' && taskControls.has(event.command ?? '') && !this.tasks) throw new Denied();
    if (event.kind !== 'message' && externalCommands.has(event.command ?? '') && !this.external) throw new Denied();
    if (event.kind !== 'message' && changeCommands.has(event.command ?? '') && !this.changes) throw new Denied();
    const p = await this.gate.authorize(event.actor, event.scope);
    if (!this.messageContent && event.kind === 'message') return;
    const conversation = await this.store.conversation(event.scope);
    const explicit = event.mention || event.kind === 'command';
    const isControl = event.kind !== 'message' && controls.has(event.command ?? '');
    const isMemory = event.kind === 'command' && memoryCommands.has(event.command ?? '');
    const isExternal = event.kind === 'command' && externalCommands.has(event.command ?? '');
    const isChange = event.kind === 'command' && changeCommands.has(event.command ?? '');
    if (event.scope.kind === 'channel' && !explicit) return;
    if (conversation && event.scope.kind !== 'channel' && conversation.owner_id !== event.actor) throw new Denied();
    if (event.kind === 'button' && !conversation) throw new Denied();
    // 기억 명령도 제어처럼 알림 채널에서 쓸 수 있다(기억의 접근 채널은 대화·알림 채널 둘이다, memory.ts access).
    // 연결 명령도 채널까지 들어와 "스레드에서 쓰세요"로 답한다. 실패 표시만 보면 왜 안 되는지 알 수 없다.
    if (event.scope.kind === 'channel' && event.scope.channel !== p.conversationChannel && !isControl && !isMemory && !isExternal && !isChange) throw new Denied();
    if ((!conversation || !conversation.active) && !explicit && !isControl) return;
    if (isExternal) return this.externalCommand(event, p.revision, recovered);
    if (isChange) return this.changeCommand(event, p.revision, recovered);
    // Unsupported commands cannot acquire model or control authority.
    if (event.kind !== 'message' && !['chat', 'urgent', 'task', 'read', ...controls, ...memoryCommands].includes(event.command ?? '')) throw new Denied();
    if (isMemory) return this.memoryCommand(event, p.revision, recovered);
    if (['cancel', 'retry', 'resume-model', 'revoke', 'read', 'review-resume', 'review-cancel', ...taskControls].includes(event.command ?? '') && !event.target) throw new Denied();
    if (event.command === 'read' && !event.text.trim()) throw new Denied();
    if (event.command === 'task' && this.tasks && (!event.target || !event.text.trim())) throw new Denied();
    if (event.kind === 'command' && taskDirect.has(event.command ?? '')) return this.taskDirectCommand(event, p.revision, recovered);
    const started = this.store.now();
    // 작업 접수를 막은 안내. 받은 자리면 상호작용 응답으로, 복구 중이면 대화에 게시한다.
    let refused: string | undefined;
    // 처리기가 맡은 답은 events에 원문을 남기지 않고 이 호출의 값으로만 넘긴다. /answer는 버퍼에 들어가지 않아 저장한 원문으로 되살릴 일이 없다.
    const spoken = event.text;
    const sealed = event.kind !== 'message' && event.command === 'answer' && !!event.target && await this.tasks?.sealsAnswer?.(this.store.db, event.target) === true;
    const saved = await this.store.save(sealed ? { ...event, text: '' } : event, p.revision, !!explicit && (!isControl || event.command === 'resume'));
    if (!recovered && this.store.now() - started > DEFAULTS.inboxTimeoutMs) throw new Error('inbox_deadline');
    // Route durably before ACK: a lost response or process exit cannot orphan an acknowledged request.
    const routed = await this.store.atomic(async store => {
      const subscription = await store.ownedConversation(event.scope, event.actor, true);
      if (recovery && (!subscription.active || subscription.recovery_token !== recovery.token
        || subscription.subscription_epoch !== recovery.epoch || Number(subscription.recovery_until) <= store.now())) return false;
      const inbox = (await store.db.query<{ buffered: boolean; accepted: boolean; actor_id: string; scope: Scope; payload: { text: string; command?: string; target?: string; kind: EventInput['kind']; urgent?: boolean; mention?: boolean; activate?: boolean } }>(
        'SELECT * FROM events WHERE id=$1 FOR UPDATE', [saved.id])).rows[0]!;
      if (inbox.accepted || (inbox.buffered && !recovered)) return false;
      // Replay durable input, not a later delivery's content. Scope/actor must agree.
      if (inbox.actor_id !== event.actor || store.scopeId(inbox.scope) !== store.scopeId(event.scope)
        || inbox.scope.parent !== event.scope.parent) throw new Denied();
      event.text = sealed ? spoken : inbox.payload.text; event.command = inbox.payload.command;
      event.target = inbox.payload.target; event.kind = inbox.payload.kind; event.urgent = inbox.payload.urgent; event.mention = inbox.payload.mention;
      const durableControl = event.kind !== 'message' && controls.has(event.command ?? '');
      const gate = this.gate.withDatabase(store.db);
      const current = await gate.authorize(event.actor, event.scope);
      const conversationId = store.scopeId(event.scope);
      const oldMessage = event.kind === 'message' && subscription.activation_after && /^\d+$/.test(event.id)
        && BigInt(event.id) <= BigInt(subscription.activation_after);
      if (oldMessage || (!subscription.active && !inbox.payload.activate && !durableControl)) {
        await store.db.query(`UPDATE events SET buffered=false,payload=payload || '{"ignored":"subscription_boundary"}'::jsonb WHERE id=$1`, [saved.id]);
        return false;
      }
      if (subscription.gap && !recovered && !durableControl) {
        const count = (await store.db.query<{ count: string }>('SELECT count(*) FROM events WHERE conversation_id=$1 AND buffered=true', [conversationId])).rows[0]!;
        if (Number(count.count) >= DEFAULTS.maxQueue) throw new Error('recovery_buffer_full');
        await store.db.query('UPDATE events SET buffered=true WHERE id=$1', [saved.id]);
        return true;
      }
      // 스레드를 만들기 전에 본다. 프로젝트가 없거나 레인이 닫혔으면 빈 스레드를 남기지 않고, 구독도 켜지 않는다.
      const refuse = async (text: string) => {
        await store.db.query(`UPDATE events SET accepted=true,buffered=false,payload=payload || '{"ignored":"task_refused"}'::jsonb WHERE id=$1`, [saved.id]);
        refused = text;
        if (recovered) await store.enqueue({ key: `task-refused:${saved.id}`, actor: event.actor, scope: event.scope, revision: current.revision,
          payload: { kind: 'message', channel: event.scope.channel, content: text, classification: 'safe_summary' } });
        return true;
      };
      if (event.kind === 'command' && event.command === 'task' && this.tasks) {
        const refusal = await this.tasks.admit(store, event.target);
        if (refusal) return refuse(refusal);
      }
      if (inbox.buffered) await store.db.query("UPDATE events SET event_order=nextval('events_event_order_seq') WHERE id=$1", [saved.id]);
      if (event.scope.kind === 'channel') await store.db.query('UPDATE conversations SET active=false WHERE id=$1', [conversationId]);
      if (inbox.payload.activate && event.command !== 'resume') await store.activate(subscription, event.id);
      if (durableControl) {
        const result = event.command === 'revoke'
          ? await gate.revoke(event.actor, event.scope, event.target!)
          // 대화 행을 위에서 잠갔고 답 처리도 이 트랜잭션 안이다. 같은 대화의 /revoke와 직렬화되고, 중복 전달은 inbox.accepted가 막는다.
          : event.command === 'answer'
            ? await this.tasks!.answerIn(store, { question: event.target!, actor: event.actor, scope: event.scope, text: event.text, event: event.id })
            : event.command === 'task-cancel'
              ? await this.tasks!.cancelIn(store, event.actor, conversationId, event.target!, event.id)
              : await store.control(event.actor, conversationId, event.command!, event.target, event.id,
                // 리뷰 작업 제어의 별도 권한: 현재 정책의 owner가 알림 채널(부모 없는 채널)에서 보낸 명령만.
                { review: event.scope.kind === 'channel' && event.scope.parent === null && event.scope.channel === current.notificationChannel
                  && event.actor === current.owner });
        if (event.command !== 'revoke') await store.enqueue({ key: `control:${saved.id}`, actor: event.actor,
          scope: event.scope, revision: current.revision, payload: { kind: 'message', channel: event.scope.channel,
            content: controlText(event.command!, result), classification: 'safe_summary' } });
      } else if (event.scope.kind === 'channel') {
        await store.enqueue({ key: `thread:${saved.id}`, conversation: conversationId,
          actor: event.actor, scope: event.scope, revision: current.revision,
          payload: { kind: 'thread', channel: event.scope.channel, content: saved.id, classification: 'safe_summary' } });
      } else {
        // admit 뒤에 레인이 닫힌 경합. SQL 오류가 아니라 트랜잭션은 그대로 쓸 수 있다.
        try { await store.accept(saved.id, event.command === 'task' ? 'task' : event.command === 'read' ? 'read' : 'chat', current.revision, event.urgent || event.command === 'urgent'); }
        catch (error) {
          if (!(error instanceof LaneClosed) || !this.tasks) throw error;
          return refuse(taskLaneClosedText(error.reason));
        }
        if ((!recovered || inbox.buffered) && event.kind === 'message') await store.checkpoint(conversationId, event.id, inbox.buffered);
      }
      if (!recovered && store.now() - started > DEFAULTS.inboxTimeoutMs) throw new Error('inbox_deadline');
      await store.db.query('UPDATE events SET accepted=true WHERE id=$1', [saved.id]);
      await store.db.query('UPDATE events SET buffered=false WHERE id=$1', [saved.id]);
      return true;
    }, recovered ? undefined : { expiresAt: started + DEFAULTS.inboxTimeoutMs, now: this.store.now });
    if (routed && !recovered) await this.acknowledge(event, saved.id, refused);
    return saved.id;
  }
  // 작업 상태·해제. 수신 트랜잭션을 쥔 채 다른 연결을 쓰거나 작업자를 기다리지 않는다. 처리 방식은 기억 명령과 같다(같은 상호작용은 한 번만 처리한다).
  private async taskDirectCommand(event: z.infer<typeof EventSchema>, revision: string, recovered: boolean): Promise<string | undefined> {
    if (recovered || !this.tasks) throw new Denied();
    const started = this.store.now();
    const saved = await this.store.save(event, revision, false);
    if (!await this.claimOnce(event, saved.id, started)) return saved.id;
    let content: string;
    try {
      content = event.command === 'task-status' ? await this.tasks.status(event.actor, event.scope, event.target!)
        : this.tasks.release({ id: saved.id, actor: event.actor, scope: event.scope, job: event.target!, revision });
    } catch (error) {
      if (!(error instanceof Denied)) this.log('task_command_failed', { command: event.command!, ...errorInfo(error) });
      // 타인 작업과 다른 대화의 작업은 존재 여부도 구별해 알리지 않는다.
      content = error instanceof Denied ? '이 대화에서 볼 수 있는 작업이 아닙니다.' : '처리하지 못했습니다(일시 오류). 다시 시도하세요.';
    }
    await this.acknowledge(event, saved.id, content);
    return saved.id;
  }
  // 같은 상호작용 ID는 events의 accepted를 먼저 잡은 쪽만 처리한다.
  private claimOnce(event: z.infer<typeof EventSchema>, id: string, started: number): Promise<boolean> {
    return this.store.atomic(async store => {
      const inbox = (await store.db.query<{ accepted: boolean; actor_id: string; scope: Scope; payload: { command?: string; target?: string } }>(
        'SELECT accepted,actor_id,scope,payload FROM events WHERE id=$1 FOR UPDATE', [id])).rows[0]!;
      if (inbox.accepted) return false;
      if (inbox.actor_id !== event.actor || store.scopeId(inbox.scope) !== store.scopeId(event.scope) || inbox.scope.parent !== event.scope.parent
        || inbox.payload.command !== event.command || inbox.payload.target !== event.target) throw new Denied();
      await this.gate.withDatabase(store.db).authorize(event.actor, event.scope);
      await store.db.query('UPDATE events SET accepted=true WHERE id=$1', [id]);
      return true;
    }, { expiresAt: started + DEFAULTS.inboxTimeoutMs, now: this.store.now });
  }
  // 기억 명령. 구독·gap·작업 큐를 거치지 않고 받은 자리에서 한 번 처리한 뒤 상호작용 응답으로 답한다.
  // 중복 전달(같은 상호작용 ID)은 events의 accepted를 먼저 잡은 쪽만 처리한다. 잡은 뒤 처리 중에 죽으면 다시 하지 않는다
  // (응답 토큰이 3초라 되살릴 수 없다. 사용자가 새 명령으로 다시 보낸다).
  private async memoryCommand(event: z.infer<typeof EventSchema>, revision: string, recovered: boolean): Promise<string | undefined> {
    // 기억 명령은 history 복구로 들어오지 않는다(상호작용은 메시지 기록에 없다). 처리기가 없으면(원장 꺼짐) 닫는다.
    if (recovered || !this.memory) throw new Denied();
    const started = this.store.now();
    // 진술·검색어(text)는 events에 남기지 않는다. events는 대화 맥락으로 모델에 들어가고(chat-context.ts) 기억 삭제가 지우지 못한다.
    // target(종류·기억 ID·출처 키)만 남긴다. 대화 출처 확인(memory.ts)은 이 행의 actor·accepted·scope를 본다.
    const saved = await this.store.save({ ...event, text: '' }, revision, false);
    if (this.store.now() - started > DEFAULTS.inboxTimeoutMs) throw new Error('inbox_deadline');
    if (!await this.claimOnce(event, saved.id, started)) return saved.id;
    let reply;
    try {
      reply = await this.memory.handle({ id: event.id, actor: event.actor, scope: event.scope,
        command: event.command as MemoryCommand, text: event.text, target: event.target });
    } catch (error) {
      // DB·원장 일시 오류 등. 처리됐는지 모를 수 있어 확인 방법을 알린다. 오류 원문은 남기지 않는다(errorInfo가 코드만 싣는다).
      this.log('memory_command_failed', { command: event.command!, ...errorInfo(error) });
      reply = { content: '처리하지 못했습니다(일시 오류). /memory-search로 결과를 확인한 뒤 다시 시도하세요.', outcome: 'error' };
    }
    // 로그에는 명령과 결과 코드만 남긴다(진술·검색어·기억 내용 없음).
    this.log('memory_command', { command: event.command!, outcome: reply.outcome });
    await this.acknowledge(event, saved.id, reply.content, { revision, notice: MEMORY_ACK_NOTICE });
    return saved.id;
  }
  // 연결 명령. 처리 방식은 기억 명령과 같다(같은 상호작용은 한 번만 처리하고 상호작용 응답으로만 답한다).
  // 실행기 선택(text)은 처리에만 쓰고 events에 두지 않는다. events는 대화 맥락으로 모델에 들어간다.
  private async externalCommand(event: z.infer<typeof EventSchema>, revision: string, recovered: boolean): Promise<string | undefined> {
    if (recovered || !this.external) throw new Denied();
    const started = this.store.now();
    const saved = await this.store.save({ ...event, text: '' }, revision, false);
    if (this.store.now() - started > DEFAULTS.inboxTimeoutMs) throw new Error('inbox_deadline');
    if (!await this.claimOnce(event, saved.id, started)) return saved.id;
    let reply;
    try {
      reply = await this.external.handle({ actor: event.actor, scope: event.scope, command: event.command as ExternalTaskCommand, text: event.text, target: event.target },
        content => this.deliverPrivate(event, saved.id, content));
    } catch (error) {
      this.log('external_task_command_failed', { command: event.command!, ...errorInfo(error) });
      reply = { content: '처리하지 못했습니다(일시 오류). /attach-list로 결과를 확인한 뒤 다시 시도하세요.', outcome: 'error' };
    }
    // 로그에는 명령과 결과 코드만 남긴다(세션 ID·키 ID·seed 없음).
    this.log('external_task_command', { command: event.command!, outcome: reply.outcome });
    if (reply.content !== undefined) await this.acknowledge(event, saved.id, reply.content, { revision, notice: EXTERNAL_ACK_NOTICE });
    return saved.id;
  }
  // 변경 명령. 요청 글은 events에 두지 않는다(대화 맥락으로 모델에 들어간다). 처리기는 DB만 만져 응답 기한 안에 끝난다.
  private async changeCommand(event: z.infer<typeof EventSchema>, revision: string, recovered: boolean): Promise<string | undefined> {
    if (recovered || !this.changes) throw new Denied();
    const started = this.store.now();
    // text와 target 모두 owner가 자유롭게 적는 칸이다. events는 대화 맥락으로 모델에 들어가므로 명령 이름만 남긴다.
    const recorded = { ...event, text: '', target: undefined };
    const saved = await this.store.save(recorded, revision, false);
    if (this.store.now() - started > DEFAULTS.inboxTimeoutMs) throw new Error('inbox_deadline');
    if (!await this.claimOnce(recorded, saved.id, started)) return saved.id;
    let reply;
    try {
      reply = await this.changes.handle({ id: event.id, actor: event.actor, scope: event.scope, command: event.command as ChangeCommand, text: event.text, target: event.target });
    } catch (error) {
      this.log('change_command_failed', { command: event.command!, ...errorInfo(error) });
      reply = { content: '처리하지 못했습니다(일시 오류). /change-status로 상태를 확인한 뒤 다시 시도하세요.', outcome: 'error' };
    }
    this.log('change_command', { command: event.command!, outcome: reply.outcome });
    await this.acknowledge(event, saved.id, reply.content, { revision, notice: CHANGE_ACK_NOTICE });
    return saved.id;
  }
  // 키가 든 응답. acknowledge와 달리 실패를 돌려준다. 호출자가 그 키를 폐기해야 하기 때문이다.
  // 명령 상호작용이라 rest.acknowledge는 EPHEMERAL callback만 쓴다. 메시지 이벤트의 채널 게시 대체 경로로 가지 않는다.
  // 오류는 고정 사유 코드로만 남긴다. 전송 계층 오류에 요청 본문이 실려도 여기서 끊긴다.
  private async deliverPrivate(event: z.infer<typeof EventSchema>, id: string, content: string): Promise<boolean> {
    try {
      await this.beforeReply(event);
      await this.rest.acknowledge(event, content, { ...noMentions, flags: SUPPRESS_EMBEDS });
      return true;
    } catch (error) {
      try {
        if (error instanceof RateLimited) await this.store.recordRateLimit(error, event.scope.channel);
        await this.store.audit('ack_uncertain', id, { processing: 'durable', reason: ackFailureReason(error) });
      } catch (recording) { this.log('ack_failure_unrecorded', { kind: event.kind, ...errorInfo(recording) }); }
      return false;
    }
  }
  // 상호작용 응답·👀·대체 게시 직전의 확인. outbox와 달리 영속 표시가 없으므로 철회 확인(authorize의 denied_actors 조회)을
  // REST 전 마지막 DB 읽기로 둔다. 그 조회 전에 커밋된 /revoke면 보내지 않는다. 그 뒤의 철회는 이미 시작한 요청을 막지 못한다.
  private async beforeReply(event: EventInput): Promise<void> {
    const pause = await this.store.discordPauseUntil(event.scope.channel);
    if (pause > this.store.now()) throw new Error('discord_global_pause');
    await this.store.ownedConversation(event.scope, event.actor);
    await this.gate.authorize(event.actor, event.scope);
  }
  // 처리는 이미 영속됐다. 여기서 나는 오류(ACK 실패를 기록하는 DB 쓰기 포함)는 수신 결과를 바꾸지 않는다.
  // 메시지 이벤트에서 던지면 main의 guard()가 그 대화에 history gap 장벽을 세운다.
  // content: 상호작용 응답 본문(기억·연결 명령은 처리 결과). direct가 있으면 응답 실패 때 결과 대신 그 고정 안내를 채널에 남긴다.
  private async acknowledge(event: EventInput, id: string, content?: string, direct?: { revision: string; notice: string }): Promise<void> {
    let outcome: AckOutcome | void;
    try {
      try {
        await this.beforeReply(event);
        // 일반 메시지는 👀 리액션이고 이 문구는 권한 거부 때의 대체 텍스트로만 쓰인다.
        outcome = await this.rest.acknowledge(event, content
          ?? (this.messageContent ? '수신·처리 기록 저장됨. 처리·대기 상태는 별도로 안내합니다.' : '명령/버튼 모드: 수신·처리 기록 저장됨.'),
        direct ? { ...noMentions, flags: SUPPRESS_EMBEDS } : noMentions);
      } catch (error) {
        if (error instanceof RateLimited) await this.store.recordRateLimit(error, event.scope.channel);
        await this.store.atomic(async store => {
          await store.audit('ack_uncertain', id, { processing: 'durable', reason: ackFailureReason(error) });
          if (event.kind !== 'message') {
            await store.db.query(`UPDATE events SET payload=payload || '{"ackUncertain":true}'::jsonb WHERE id=$1`, [id]);
            // 기억·연결 명령의 결과는 채널에 다시 게시하지 않는다(본인만 볼 응답이었다). 고정 안내만 남긴다.
            if (direct) await store.enqueue({ key: `ack-notice:${id}`, actor: event.actor, scope: event.scope,
              revision: direct.revision,
              payload: { kind: 'message', channel: event.scope.channel, content: direct.notice, classification: 'safe_summary' } });
            else await store.ackNotice(id);
          }
        });
        return;
      }
      if (outcome) await this.store.audit('ack_reaction_fallback', id, { status: outcome.fallback });
    } catch (error) {
      this.log('ack_failure_unrecorded', { kind: event.kind, ...errorInfo(error) });
    }
  }
  // 결과: done(빈틈 없이 따라잡고 gap 해제), budget(쪽 수·30초 복구 한도를 넘어 gap 유지, 수동 처리. 도중 lease 만료 포함),
  // skipped(구독 꺼짐·다른 복구 진행 중·도중에 토큰이나 구독 세대가 바뀜. 이 복구는 손을 뗀다). 일시적인 통신 실패는 예외로 던진다.
  async recover(scope: Scope, actor: string): Promise<RecoveryOutcome> {
    await this.gate.authorize(actor, scope);
    const token = randomUUID();
    const started = this.store.now();
    const conversation = await this.store.atomic(async store => {
      const row = await store.ownedConversation(scope, actor, true);
      if (!row.active || (row.recovery_token && Number(row.recovery_until) > store.now())) return;
      await store.db.query('UPDATE conversations SET gap=true,recovery_token=$2,recovery_until=$3 WHERE id=$1',
        [row.id, token, started + DEFAULTS.recoveryMs]);
      return row;
    });
    if (!conversation) return 'skipped';
    // 토큰·구독 세대가 바뀌었으면(구독 중지, 새 READY 장벽) 이 복구는 끝(stale). 자기 토큰이 그대로인데 시각만 지났으면
    // 30초 복구 한도를 쓴 것(expired)이라 수동 gap(budget)으로 남긴다. 둘을 섞으면 한도 초과가 재시도로 반복된다.
    const check = async (store: Store): Promise<'ok' | 'stale' | 'expired'> => {
      await this.gate.withDatabase(store.db).authorize(actor, scope);
      const row = await store.ownedConversation(scope, actor, true);
      if (!row.active || row.subscription_epoch !== conversation.subscription_epoch || row.recovery_token !== token) return 'stale';
      return Number(row.recovery_until) > store.now() ? 'ok' : 'expired';
    };
    let after = conversation.checkpoint;
    try {
      pages: for (let page = 0; page < DEFAULTS.recoveryPages; page++) {
        await this.gate.authorize(actor, scope);
        if (this.store.now() - started >= DEFAULTS.recoveryMs) break;
        let state = await this.store.atomic(check);
        if (state === 'stale') return 'skipped';
        if (state === 'expired') break;
        const pause = await this.store.discordPauseUntil(scope.channel);
        if (pause > this.store.now()) throw new RateLimited(pause - this.store.now());
        const messages = await this.rest.history(scope.channel, after, 100).catch(async error => {
          if (error instanceof RateLimited) await this.store.recordRateLimit(error, scope.channel);
          throw error;
        });
        state = await this.store.atomic(check);
        if (state === 'stale') return 'skipped';
        if (state === 'expired') break;
        if (messages.length > 100) throw new Error('history_page_overflow');
        messages.sort((a, b) => BigInt(a.id) < BigInt(b.id) ? -1 : 1);
        for (const message of messages) {
          if (message.scope.kind !== scope.kind || message.scope.guild !== scope.guild
            || message.scope.channel !== scope.channel || message.scope.parent !== scope.parent) throw new Denied();
          if (after && BigInt(message.id) <= BigInt(after)) throw new Error('history_not_advancing');
          state = await this.store.atomic(check);
          if (state === 'stale') return 'skipped';
          if (state === 'expired') break pages;
          try { await this.receive(message, true, { token, epoch: conversation.subscription_epoch }); } catch (error) { if (!(error instanceof Denied)) throw error; }
          after = message.id;
        }
        state = await this.store.atomic(async store => {
          const current = await check(store);
          if (current !== 'ok') return current;
          await store.db.query(`UPDATE conversations SET checkpoint=$2 WHERE id=$1 AND $2::text IS NOT NULL
            AND (checkpoint IS NULL OR checkpoint::numeric<$2::numeric)`, [conversation.id, after]);
          return current;
        });
        if (state === 'stale') return 'skipped';
        if (state === 'expired') break;
        if (messages.length < 100) {
          // The same conversation lock decides whether a live event is buffered or routed directly.
          for (let drained = 0; drained <= DEFAULTS.recoveryPages * 100; drained++) {
            if (this.store.now() - started >= DEFAULTS.recoveryMs) break;
            // gap을 푸는 마지막 transaction은 lease 마감 안에서만 commit한다. check() 뒤의 조회·UPDATE 왕복 중에 마감을 넘기면
            // (마감 전달로 다음 질의 전 또는 마지막 확인에서) 되돌려 gap을 남기고 budget으로 끝낸다. 토큰·구독 변경은 그대로 skipped다.
            const lease = { expiresAt: started + DEFAULTS.recoveryMs, now: this.store.now };
            let next;
            try {
              next = await this.store.atomic(async store => {
                const current = await check(store);
                if (current !== 'ok') return { done: true, cleared: false, state: current };
                const event = (await store.db.query<{ delivery_id: string; actor_id: string; scope: Scope; payload: EventInput }>(
                  'SELECT * FROM events WHERE conversation_id=$1 AND buffered=true ORDER BY event_order LIMIT 1', [conversation.id])).rows[0];
                if (event) return { event };
                await store.db.query('UPDATE conversations SET gap=false WHERE id=$1', [conversation.id]);
                if (store.now() >= lease.expiresAt) throw new Error('recovery_expired');
                return { done: true, cleared: true };
              }, lease);
            } catch (error) {
              // 마감을 넘겨 실패했으면(우리 확인·마감 검사·DB의 transaction/statement timeout 무엇이든) 한도 초과다.
              if (this.store.now() >= lease.expiresAt) break pages;
              throw error;
            }
            if (next.done) {
              if (next.cleared) return 'done';
              if (next.state === 'expired') break pages;
              return 'skipped';
            }
            const buffered = next.event!;
            try { await this.receive({ id: buffered.delivery_id, actor: buffered.actor_id, scope: buffered.scope, text: buffered.payload.text,
              kind: buffered.payload.kind, command: buffered.payload.command, target: buffered.payload.target, mention: buffered.payload.mention, urgent: buffered.payload.urgent }, true, { token, epoch: conversation.subscription_epoch }); }
            catch (error) {
              if (!(error instanceof Denied)) throw error;
              await this.store.db.query("UPDATE events SET buffered=false WHERE delivery_id=$1 AND provider='discord'", [buffered.delivery_id]);
            }
          }
          break;
        }
      }
      await this.store.audit('history_gap', conversation.id, { reason: 'recovery_budget' });
      return 'budget';
    } finally {
      await this.store.db.query('UPDATE conversations SET recovery_token=NULL,recovery_until=NULL WHERE id=$1 AND recovery_token=$2', [conversation.id, token]);
    }
  }
}

// ack_uncertain의 원인 분류. 다음 실측에서 시간 초과·기한 만료·429·거부를 가르려는 것이다.
// 오류 메시지 원문은 남기지 않는다(callback 경로에 상호작용 토큰이 들어가므로). 아는 값만 고정 문자열로 바꾼다.
export function ackFailureReason(error: unknown): string {
  if (error instanceof RateLimited) return 'rate_limited';
  if (error instanceof DiscordRejected) return `rejected:${error.status}`;
  if (error instanceof DiscordUnauthorized) return 'unauthorized';
  if (error instanceof Denied) return 'denied';
  if (error instanceof PolicyUnavailable) return 'policy_unavailable';
  // AbortSignal.timeout이 끊은 fetch는 name이 TimeoutError인 DOMException으로 실패한다.
  if ((error as { name?: unknown } | null)?.name === 'TimeoutError') return 'timeout';
  const message = error instanceof Error ? error.message : undefined;
  if (message === 'interaction_expired') return 'expired';
  if (message === 'discord_global_pause') return 'paused';
  if (message === 'discord_request_failed') return 'http_error';
  return 'error';
}
export function deliveryMarker(row: Delivery): string {
  return createHash('sha256').update(row.idempotency_key).digest('hex').slice(0, 24);
}
function jsonBody(content: string): object | undefined {
  try {
    const value: unknown = JSON.parse(content);
    return value !== null && typeof value === 'object' ? value : undefined;
  } catch { return undefined; }
}
// JSON 본문(목록 페이지·제어 결과)은 marker를 JSON 필드로 넣어 메시지 전체가 그대로 파싱되게 한다.
// 일반 문장은 끝 줄에 붙인다. 감싸기는 42자를 더해 본문 상한 1900자에서도 Discord 2000자 안이다.
export function markedContent(content: string, marker: string): string {
  const data = jsonBody(content);
  return data === undefined ? `${content}\n[ref:${marker}]` : JSON.stringify({ ref: marker, data });
}
export function hasMarker(content: string, marker: string): boolean {
  if (content.endsWith(`[ref:${marker}]`)) return true;
  const body = jsonBody(content) as { ref?: unknown; data?: unknown } | undefined;
  return !!body && !Array.isArray(body) && body.ref === marker && 'data' in body;
}
export class DiscordPublisher {
  constructor(private readonly store: Store, private readonly gate: PolicyGate, private readonly rest: DiscordRest) {}
  private async authorized(row: Delivery): Promise<void> {
    // Alert coalescing may have replaced the scope since this delivery was claimed.
    const current = (await this.store.db.query<{ service_ids: string[] }>('SELECT service_ids FROM outbox WHERE id=$1', [row.id])).rows[0];
    if (!current) throw new Denied();
    row.service_ids = current.service_ids;
    const policy = await this.gate.authorize(row.owner_id, row.scope);
    if (!row.service_ids.every(service => policy.services.includes(service))) throw new Denied();
    row.policy_revision = policy.revision;
    await this.store.db.query('UPDATE outbox SET policy_revision=$2 WHERE id=$1', [row.id, policy.revision]);
    if (row.payload.channel !== row.scope.channel || row.payload.classification !== 'safe_summary') throw new Denied();
    if (row.scope.kind !== 'channel') {
      const conversation = await this.store.conversation(row.scope);
      if (conversation && conversation.owner_id !== row.owner_id) throw new Denied();
      if (row.conversation_id && !conversation?.active) throw new Denied();
      if (row.conversation_id && conversation?.gap) throw new HistoryGap();
    }
  }
  // 예약 브리핑 사본은 그 예약이 지금 켜져 있을 때만 보낸다. 예약 끄기가 막지 못한 행(발송 중에 끈 뒤 429로 돌아온 행)을 여기서 막는다.
  // 이 확인 뒤에 끄기가 끝나도 발송 전 sending은 끄기가 blocked로 바꾸고 dispatch 표시가 lost로 실패한다.
  // reconcile(unknown 확인)에는 걸지 않는다. 보냈을 수 있는 행을 blocked로 바꾸면 안 된다.
  private async scheduled(row: Delivery): Promise<void> {
    const copy = (await this.store.db.query<{ enabled: boolean | null }>(`SELECT s.enabled FROM briefing_copies c
      LEFT JOIN schedules s ON s.id=c.schedule_id WHERE c.message_key=$1`, [row.message_key])).rows[0];
    if (copy && !copy.enabled) throw new Denied();
  }
  async deliver(): Promise<boolean> {
    const row = await this.store.claimDelivery();
    if (!row) return false;
    let dispatched = false;
    let remoteId: string | null = null;
    try {
      await this.authorized(row);
      await this.scheduled(row);
      const pause = await this.store.discordPauseUntil(row.payload.channel);
      if (pause > this.store.now()) { await this.store.pauseDelivery(row, 'discord_global_pause'); return true; }
      const marker = deliveryMarker(row);
      if (row.payload.kind === 'message' && row.payload.content.length > 1900) throw new Denied();
      // authorized() 뒤의 대기 사이에 커밋된 /revoke·구독 끄기는 여기서 막힌다(발송 시작 기준점, store.dispatchDelivery).
      const dispatch = await this.store.dispatchDelivery(row);
      if (dispatch === 'gap') throw new HistoryGap();
      if (dispatch === 'blocked') await this.store.audit('delivery_blocked_before_dispatch', row.id, { attempt: row.attempt });
      if (dispatch !== 'dispatched') return true;
      dispatched = true;
      const sent = row.payload.kind === 'thread'
        ? await this.rest.createThread(row.payload.channel, { name: `homelab-${marker}`, type: 11, auto_archive_duration: 1440 })
        : await this.rest.sendMessage(row.payload.channel, { content: markedContent(row.payload.content, marker),
          nonce: marker, enforce_nonce: true, ...noMentions });
      remoteId = sent.id;
      await this.confirm(row, sent.id);
    } catch (error) {
      if (remoteId !== null) await this.store.deliveryState(row, 'unknown', remoteId);
      else if (error instanceof PolicyUnavailable || error instanceof DiscordUnauthorized || error instanceof HistoryGap) {
        await this.store.pauseDelivery(row, error.message);
      } else if (error instanceof DiscordRejected) await this.store.atomic(async store => {
        await store.deliveryState(row, 'blocked');
        await store.audit('discord_delivery_rejected', row.id, { status: error.status });
      });
      else if (error instanceof Denied) await this.store.deliveryState(row, 'blocked');
      else if (error instanceof RateLimited) {
        await this.store.recordRateLimit(error, row.payload.channel);
        await this.store.deliveryState(row, row.attempt > DEFAULTS.maxRetries ? 'blocked' : 'pending', null, Math.max(1000, error.retryAfterMs));
        await this.store.audit('discord_rate_limit', row.id, { attempt: row.attempt, retryAfterMs: error.retryAfterMs, global: error.global, bucket: error.bucket });
      }
      else if (!dispatched) await this.store.pauseDelivery(row, 'before_dispatch');
      else await this.store.deliveryState(row, 'unknown');
    }
    return true;
  }
  async reconcile(): Promise<void> {
    await this.store.retireUnknownDeliveries();
    const pause = (await this.store.db.query<{ value: number }>("SELECT value FROM controls WHERE key='discord_reconcile_after'")).rows[0];
    const searchPaused = !!pause && pause.value > this.store.now();
    // 외부 ID가 없는 행은 available_at이 unknown 진입 시각(24시간 폐기 기준)이라, 검색 간격은 reconcile_after로 따로 본다.
    for (const row of (await this.store.db.query<Delivery>(`SELECT * FROM outbox WHERE state='unknown'
      AND (external_id IS NOT NULL AND available_at<=$1 OR external_id IS NULL AND COALESCE(reconcile_after,0)<=$1)
      ORDER BY (external_id IS NOT NULL) DESC,created_at LIMIT 100`, [this.store.now()])).rows) {
      if (!row.external_id && (searchPaused || await this.store.discordPauseUntil(row.payload.channel) > this.store.now())) continue;
      let searched = false;
      try {
        await this.authorized(row);
        let found: { id: string } | undefined = row.external_id ? { id: row.external_id } : undefined;
        if (!found) {
          searched = true;
          found = await this.rest.findDelivery(row.payload.channel, deliveryMarker(row), row.payload.kind);
        }
        if (found) await this.confirm(row, found.id);
        // A bounded search miss is not proof of absence; keep unknown, never auto-resend.
        else await this.store.deferSearch(row);
      } catch (error) {
        if (error instanceof RateLimited) {
          await this.store.recordRateLimit(error, row.payload.channel);
          // GREATEST의 controls.value는 충돌한 discord_reconcile_after 한 행뿐이고 늘 숫자로만 쓴다(다른 키 값과 무관).
          await this.store.db.query(`INSERT INTO controls VALUES ('discord_reconcile_after',to_jsonb($1::bigint))
            ON CONFLICT (key) DO UPDATE SET value=to_jsonb(GREATEST(controls.value::bigint,$1::bigint))`,
          [this.store.now() + Math.max(1000, error.retryAfterMs)]);
          await this.store.audit('discord_reconcile_rate_limit', row.id, { retryAfterMs: error.retryAfterMs });
          break;
        }
        if (error instanceof Denied) await this.store.deliveryState(row, 'blocked');
        else if (row.external_id) await this.store.deferConfirmation(row);
        else if (searched) await this.store.deferSearch(row);
      }
    }
  }
  private async confirm(row: Delivery, externalId: string): Promise<void> {
    await this.store.atomic(async store => {
      if (row.payload.kind === 'thread') {
        // Same lock order as alert admission; payload coalescing and thread confirmation cannot cross.
        await store.db.query(`INSERT INTO controls VALUES ('alert_admission','false') ON CONFLICT DO NOTHING`);
        await store.db.query(`SELECT * FROM controls WHERE key='alert_admission' FOR UPDATE`);
      }
      const current = (await store.db.query<{ state: string; service_ids: string[] }>(
        'SELECT state,service_ids FROM outbox WHERE id=$1 AND lease_token=$2 FOR UPDATE', [row.id, row.lease_token])).rows[0];
      if (!current || !['sending', 'unknown'].includes(current.state)) return;
      const policy = await this.gate.withDatabase(store.db).authorize(row.owner_id, row.scope);
      if (!current.service_ids.every(service => policy.services.includes(service))) throw new Denied();
      if (row.payload.kind === 'thread') {
        const scope: Scope = { ...row.scope, kind: 'thread', parent: row.scope.channel, channel: externalId };
        const id = store.scopeId(scope);
        await store.db.query(`INSERT INTO conversations(id,owner_id,scope,channel_id,created_at) VALUES ($1,$2,$3,$4,$5)
          ON CONFLICT DO NOTHING`, [id, row.owner_id, JSON.stringify(scope), externalId, store.now()]);
        await store.ownedConversation(scope, row.owner_id, true);
        await store.db.query('UPDATE events SET conversation_id=$2,scope=$3 WHERE id=$1', [row.payload.content, id, JSON.stringify(scope)]);
        const event = (await store.db.query<{ payload: { command?: string; urgent?: boolean; group?: string; text: string } }>(
          'SELECT payload FROM events WHERE id=$1', [row.payload.content])).rows[0]!;
        if (event.payload.command === 'alert') {
          const key = `incident-summary:${row.id}`;
          await store.db.query('UPDATE incidents SET conversation_id=$2,delivery_key=$3 WHERE group_key=$1', [event.payload.group, id, key]);
          await store.db.query('UPDATE events SET accepted=true WHERE id=$1', [row.payload.content]);
          await store.enqueue({ key, actor: row.owner_id, scope, conversation: id, revision: row.policy_revision, services: current.service_ids,
            payload: { kind: 'message', channel: externalId, content: event.payload.text, classification: 'safe_summary' } });
        } else {
          // 스레드를 만드는 사이 작업 레인이 닫혔다. 이미 만든 스레드에 이유를 남긴다. 던지면 이 전달이 unknown으로 남아 되풀이된다.
          try {
            await store.accept(row.payload.content, event.payload.command === 'task' ? 'task' : event.payload.command === 'read' ? 'read' : 'chat', row.policy_revision,
              event.payload.urgent || event.payload.command === 'urgent');
          } catch (error) {
            if (!(error instanceof LaneClosed)) throw error;
            await store.db.query(`UPDATE events SET accepted=true,payload=payload || '{"ignored":"task_refused"}'::jsonb WHERE id=$1`, [row.payload.content]);
            await store.enqueue({ key: `task-refused:${row.id}`, actor: row.owner_id, scope, conversation: id, revision: row.policy_revision, services: current.service_ids,
              payload: { kind: 'message', channel: externalId, content: taskLaneClosedText(error.reason), classification: 'safe_summary' } });
          }
        }
        await store.ackNotice(row.payload.content);
      }
      await store.deliveryState(row, 'sent', externalId);
    });
  }
}

// An injected authenticated Gateway supplies metadata; arbitrary message content never supplies scope.
export interface GatewayFrame {
  id: string; author: { id: string; bot?: boolean }; webhook_id?: string;
  channel_id: string; guild_id?: string; content?: string; mentions?: { id: string }[];
}
export async function gatewayMessage(frame: GatewayFrame, botId: string,
  lookup: (channel: string) => Promise<{ type: number; parent_id?: string; guild_id?: string }>): Promise<EventInput> {
  const channel = await lookup(frame.channel_id);
  const kind = channel.type === 1 ? 'dm' : channel.type === 11 ? 'thread' : channel.type === 0 ? 'channel' : undefined;
  if (!kind || (kind !== 'dm' && (!frame.guild_id || channel.guild_id !== frame.guild_id))) throw new Denied();
  return { id: frame.id, actor: frame.author.id, bot: frame.author.bot, webhook: !!frame.webhook_id,
    // 일반 채널(type 0)의 parent_id는 카테고리다. scope.parent는 스레드의 부모 채널만 뜻한다.
    scope: { kind, guild: frame.guild_id ?? null, channel: frame.channel_id, parent: kind === 'thread' ? channel.parent_id ?? null : null },
    text: frame.content ?? '', kind: 'message', mention: frame.mentions?.some(m => m.id === botId) };
}
