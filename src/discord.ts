import { createHash, randomUUID } from 'node:crypto';
import { z } from 'zod';
import { DEFAULTS, Denied, DiscordRejected, DiscordUnauthorized, HistoryGap, PolicyUnavailable, RateLimited, ScopeSchema } from './contracts.js';
import type { EventInput, Scope } from './contracts.js';
import { errorInfo, jsonLog } from './log.js';
import type { Log } from './log.js';
import type { PolicyGate } from './policy.js';
import type { Delivery, Store } from './store.js';

// 일반 메시지 수신 표시가 리액션 대신 텍스트로 대체됐을 때의 거부 상태(권한 점검 신호).
export interface AckOutcome { fallback: 403 | 404 }
export interface DiscordRest {
  acknowledge(event: EventInput, content: string, options: { allowed_mentions: { parse: never[] } }): Promise<AckOutcome | void>;
  createThread(channel: string, body: { name: string; type: 11; auto_archive_duration: 1440 }): Promise<{ id: string }>;
  sendMessage(channel: string, body: { content: string; nonce: string; enforce_nonce: true; allowed_mentions: { parse: never[] } }): Promise<{ id: string }>;
  findDelivery(channel: string, marker: string, kind: 'message' | 'thread'): Promise<{ id: string } | undefined>;
  history(channel: string, after: string | null, limit: 100): Promise<EventInput[]>;
}
const noMentions = { allowed_mentions: { parse: [] as never[] } };
const controls = new Set(['stop', 'resume', 'list', 'cancel', 'retry', 'emergency-stop', 'resume-model', 'model-status', 'revoke',
  'review-status', 'review-resume', 'review-cancel']);
// 수신이 아는 명령 전체. 배포 진입점은 단계에 맞춰 더 좁은 목록(FOUNDATION_COMMANDS)을 넘긴다.
export type RecoveryOutcome = 'done' | 'budget' | 'skipped';
export const ALL_COMMANDS: ReadonlySet<string> = new Set(['chat', 'urgent', 'task', 'read', ...controls]);
const EventSchema = z.strictObject({
  id: z.string().min(1), actor: z.string().min(1), scope: ScopeSchema,
  text: z.string().max(DEFAULTS.maxInputChars), kind: z.enum(['message', 'command', 'button']),
  bot: z.boolean().optional(), webhook: z.boolean().optional(), mention: z.boolean().optional(),
  command: z.string().optional(), target: z.string().optional(), urgent: z.boolean().optional(),
});
export class DiscordIngress {
  constructor(private readonly store: Store, private readonly gate: PolicyGate,
    private readonly rest: DiscordRest, public readonly messageContent = true,
    private readonly commands: ReadonlySet<string> = ALL_COMMANDS, private readonly log: Log = jsonLog) {}
  async receive(input: EventInput, recovered = false, recovery?: { token: string; epoch: number }): Promise<string | undefined> {
    const event = EventSchema.parse(input);
    if (event.bot || event.webhook) return;
    // 이 단계에서 열지 않은 명령·버튼은 저장·권한 확인 전에 닫는다(T16b: task·review-*는 FOUNDATION 밖).
    if (event.kind !== 'message' && !this.commands.has(event.command ?? '')) throw new Denied();
    const p = await this.gate.authorize(event.actor, event.scope);
    if (!this.messageContent && event.kind === 'message') return;
    const conversation = await this.store.conversation(event.scope);
    const explicit = event.mention || event.kind === 'command';
    const isControl = event.kind !== 'message' && controls.has(event.command ?? '');
    if (event.scope.kind === 'channel' && !explicit) return;
    if (conversation && event.scope.kind !== 'channel' && conversation.owner_id !== event.actor) throw new Denied();
    if (event.kind === 'button' && !conversation) throw new Denied();
    if (event.scope.kind === 'channel' && event.scope.channel !== p.conversationChannel && !isControl) throw new Denied();
    if ((!conversation || !conversation.active) && !explicit && !isControl) return;
    // Unsupported commands cannot acquire model or control authority.
    if (event.kind !== 'message' && !['chat', 'urgent', 'task', 'read', ...controls].includes(event.command ?? '')) throw new Denied();
    if (['cancel', 'retry', 'resume-model', 'revoke', 'read', 'review-resume', 'review-cancel'].includes(event.command ?? '') && !event.target) throw new Denied();
    if (event.command === 'read' && !event.text.trim()) throw new Denied();
    const started = this.store.now();
    const saved = await this.store.save(event, p.revision, !!explicit && (!isControl || event.command === 'resume'));
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
      event.text = inbox.payload.text; event.command = inbox.payload.command;
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
      if (inbox.buffered) await store.db.query("UPDATE events SET event_order=nextval('events_event_order_seq') WHERE id=$1", [saved.id]);
      if (event.scope.kind === 'channel') await store.db.query('UPDATE conversations SET active=false WHERE id=$1', [conversationId]);
      if (inbox.payload.activate && event.command !== 'resume') await store.activate(subscription, event.id);
      if (durableControl) {
        const result = event.command === 'revoke'
          ? await gate.revoke(event.actor, event.scope, event.target!)
          : await store.control(event.actor, conversationId, event.command!, event.target, event.id,
            // T17 리뷰 작업 제어의 별도 권한: 현재 정책의 owner가 알림 채널(부모 없는 채널)에서 보낸 명령만.
            { review: event.scope.kind === 'channel' && event.scope.parent === null && event.scope.channel === current.notificationChannel
              && event.actor === current.owner });
        if (event.command !== 'revoke') await store.enqueue({ key: `control:${saved.id}`, actor: event.actor,
          scope: event.scope, revision: current.revision, payload: { kind: 'message', channel: event.scope.channel,
            content: JSON.stringify(result), classification: 'safe_summary' } });
      } else if (event.scope.kind === 'channel') {
        await store.enqueue({ key: `thread:${saved.id}`, conversation: conversationId,
          actor: event.actor, scope: event.scope, revision: current.revision,
          payload: { kind: 'thread', channel: event.scope.channel, content: saved.id, classification: 'safe_summary' } });
      } else {
        await store.accept(saved.id, event.command === 'task' ? 'task' : event.command === 'read' ? 'read' : 'chat', current.revision, event.urgent || event.command === 'urgent');
        if ((!recovered || inbox.buffered) && event.kind === 'message') await store.checkpoint(conversationId, event.id, inbox.buffered);
      }
      if (!recovered && store.now() - started > DEFAULTS.inboxTimeoutMs) throw new Error('inbox_deadline');
      await store.db.query('UPDATE events SET accepted=true WHERE id=$1', [saved.id]);
      await store.db.query('UPDATE events SET buffered=false WHERE id=$1', [saved.id]);
      return true;
    }, recovered ? undefined : { expiresAt: started + DEFAULTS.inboxTimeoutMs, now: this.store.now });
    if (routed && !recovered) await this.acknowledge(event, saved.id);
    return saved.id;
  }
  // 처리는 이미 영속됐다. 여기서 나는 오류(ACK 실패를 기록하는 DB 쓰기 포함)는 수신 결과를 바꾸지 않는다.
  // 메시지 이벤트에서 던지면 main의 guard()가 그 대화에 history gap 장벽을 세운다.
  private async acknowledge(event: EventInput, id: string): Promise<void> {
    let outcome: AckOutcome | void;
    try {
      try {
        await this.gate.authorize(event.actor, event.scope);
        await this.store.ownedConversation(event.scope, event.actor);
        const pause = await this.store.discordPauseUntil(event.scope.channel);
        if (pause > this.store.now()) throw new Error('discord_global_pause');
        // 일반 메시지는 👀 리액션이고 이 문구는 권한 거부 때의 대체 텍스트로만 쓰인다.
        outcome = await this.rest.acknowledge(event,
          this.messageContent ? '수신·처리 기록 저장됨. 처리·대기 상태는 별도로 안내합니다.' : '명령/버튼 모드: 수신·처리 기록 저장됨.', noMentions);
      } catch (error) {
        if (error instanceof RateLimited) await this.store.recordRateLimit(error, event.scope.channel);
        await this.store.atomic(async store => {
          await store.audit('ack_uncertain', id, { processing: 'durable' });
          if (event.kind !== 'message') {
            await store.db.query(`UPDATE events SET payload=payload || '{"ackUncertain":true}'::jsonb WHERE id=$1`, [id]);
            await store.ackNotice(id);
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
  async deliver(): Promise<boolean> {
    const row = await this.store.claimDelivery();
    if (!row) return false;
    let dispatched = false;
    let remoteId: string | null = null;
    try {
      await this.authorized(row);
      const pause = await this.store.discordPauseUntil(row.payload.channel);
      if (pause > this.store.now()) { await this.store.pauseDelivery(row, 'discord_global_pause'); return true; }
      const marker = deliveryMarker(row);
      if (row.payload.kind === 'message' && row.payload.content.length > 1900) throw new Denied();
      if (!await this.store.dispatchDelivery(row)) return true;
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
        } else await store.accept(row.payload.content, event.payload.command === 'task' ? 'task' : event.payload.command === 'read' ? 'read' : 'chat', row.policy_revision,
          event.payload.urgent || event.payload.command === 'urgent');
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
    scope: { kind, guild: frame.guild_id ?? null, channel: frame.channel_id, parent: channel.parent_id ?? null },
    text: frame.content ?? '', kind: 'message', mention: frame.mentions?.some(m => m.id === botId) };
}
