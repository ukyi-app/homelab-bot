import { createHash } from 'node:crypto';
import { z } from 'zod';
import { DEFAULTS, Denied, DiscordUnauthorized, PolicyUnavailable, RateLimited, ScopeSchema } from './contracts.js';
import type { EventInput, Scope } from './contracts.js';
import type { PolicyGate } from './policy.js';
import type { Delivery, Store } from './store.js';

export interface DiscordRest {
  acknowledge(event: EventInput, content: string, options: { allowed_mentions: { parse: never[] } }): Promise<void>;
  createThread(channel: string, body: { name: string; type: 11; auto_archive_duration: 1440 }): Promise<{ id: string }>;
  sendMessage(channel: string, body: { content: string; nonce: string; enforce_nonce: true; allowed_mentions: { parse: never[] } }): Promise<{ id: string }>;
  findDelivery(channel: string, marker: string, kind: 'message' | 'thread'): Promise<{ id: string } | undefined>;
  history(channel: string, after: string | null, limit: 100): Promise<EventInput[]>;
}
const noMentions = { allowed_mentions: { parse: [] as never[] } };
const controls = new Set(['stop', 'resume', 'list', 'cancel', 'retry', 'emergency-stop', 'revoke']);
const EventSchema = z.strictObject({
  id: z.string().min(1), actor: z.string().min(1), scope: ScopeSchema,
  text: z.string().max(DEFAULTS.maxInputChars), kind: z.enum(['message', 'command', 'button']),
  bot: z.boolean().optional(), webhook: z.boolean().optional(), mention: z.boolean().optional(),
  command: z.string().optional(), target: z.string().optional(), urgent: z.boolean().optional(),
});
export class DiscordIngress {
  constructor(private readonly store: Store, private readonly gate: PolicyGate,
    private readonly rest: DiscordRest, public readonly messageContent = true) {}
  async receive(input: EventInput, recovered = false): Promise<string | undefined> {
    const event = EventSchema.parse(input);
    if (event.bot || event.webhook) return;
    const p = await this.gate.authorize(event.actor, event.scope);
    if (!this.messageContent && event.kind === 'message') return;
    const conversation = await this.store.conversation(event.scope);
    const explicit = event.mention || event.kind === 'command';
    const isControl = event.kind !== 'message' && controls.has(event.command ?? '');
    if (event.scope.kind === 'channel' && !explicit) return;
    if (event.kind === 'button' && (!conversation || conversation.owner_id !== event.actor)) throw new Denied();
    if (event.scope.kind === 'channel' && event.scope.channel !== p.conversationChannel && !isControl) throw new Denied();
    if ((!conversation || !conversation.active) && !explicit && !isControl) return;
    if (conversation?.gap && !recovered) throw new Error('history_gap');
    // Unsupported commands cannot acquire model or control authority.
    if (event.kind !== 'message' && !['chat', 'urgent', 'task', 'read', ...controls].includes(event.command ?? '')) throw new Denied();
    if (['cancel', 'retry', 'revoke', 'read'].includes(event.command ?? '') && !event.target) throw new Denied();
    if (event.command === 'read' && !event.text.trim()) throw new Denied();
    const started = this.store.now();
    const saved = await this.store.save(event, p.revision, !!explicit && (!isControl || event.command === 'resume'));
    if (saved.duplicate) return saved.id;
    if (!recovered && this.store.now() - started > DEFAULTS.inboxTimeoutMs) throw new Error('inbox_deadline');
    // Route durably before ACK: a lost response or process exit cannot orphan an acknowledged request.
    await this.store.atomic(async store => {
      const gate = this.gate.withDatabase(store.db);
      const current = await gate.authorize(event.actor, event.scope);
      const conversationId = store.scopeId(event.scope);
      if (isControl) {
        const result = event.command === 'revoke'
          ? await gate.revoke(event.actor, event.scope, event.target!)
          : await store.control(event.actor, conversationId, event.command!, event.target);
        if (event.command !== 'revoke') await store.enqueue({ key: `control:${saved.id}`, actor: event.actor,
          scope: event.scope, revision: current.revision, payload: { kind: 'message', channel: event.scope.channel,
            content: JSON.stringify(result), classification: 'safe_summary' } });
      } else if (event.scope.kind === 'channel') {
        await store.enqueue({ key: `thread:${saved.id}`, conversation: conversationId,
          actor: event.actor, scope: event.scope, revision: current.revision,
          payload: { kind: 'thread', channel: event.scope.channel, content: saved.id, classification: 'safe_summary' } });
      } else {
        await store.accept(saved.id, event.command === 'task' ? 'task' : 'chat', current.revision, event.urgent || event.command === 'urgent');
        if (!recovered && event.kind === 'message') await store.checkpoint(conversationId, event.id);
      }
      if (!recovered && store.now() - started > DEFAULTS.inboxTimeoutMs) throw new Error('inbox_deadline');
      await store.db.query('UPDATE events SET accepted=true WHERE id=$1', [saved.id]);
    }, recovered ? undefined : { expiresAt: started + DEFAULTS.inboxTimeoutMs, now: this.store.now });
    if (!recovered) {
      try {
        await this.rest.acknowledge(event,
          this.messageContent ? '수신·처리 기록 저장됨. 처리·대기 상태는 별도로 안내합니다.' : '명령/버튼 모드: 수신·처리 기록 저장됨.', noMentions);
      } catch {
        await this.store.atomic(async store => {
          await store.audit('ack_uncertain', saved.id, { processing: 'durable' });
          if (event.kind !== 'message') {
            await store.db.query(`UPDATE events SET payload=payload || '{"ackUncertain":true}'::jsonb WHERE id=$1`, [saved.id]);
            await store.ackNotice(saved.id);
          }
        });
      }
    }
    return saved.id;
  }
  async recover(scope: Scope, actor: string): Promise<void> {
    await this.gate.authorize(actor, scope);
    const conversation = await this.store.conversation(scope);
    if (!conversation?.active) return;
    await this.store.db.query('UPDATE conversations SET gap=true WHERE id=$1', [conversation.id]);
    let after = conversation.checkpoint;
    const started = this.store.now();
    for (let page = 0; page < DEFAULTS.recoveryPages; page++) {
      await this.gate.authorize(actor, scope);
      if (this.store.now() - started > DEFAULTS.recoveryMs) break;
      const messages = await this.rest.history(scope.channel, after, 100);
      if (messages.length > 100) throw new Error('history_page_overflow');
      // REST pages may arrive newest-first. Snowflakes are strings, never JS numbers.
      messages.sort((a, b) => BigInt(a.id) < BigInt(b.id) ? -1 : 1);
      for (const message of messages) {
        if (message.scope.kind !== scope.kind || message.scope.guild !== scope.guild
          || message.scope.channel !== scope.channel || message.scope.parent !== scope.parent) throw new Denied();
        if (after && BigInt(message.id) <= BigInt(after)) throw new Error('history_not_advancing');
        try { await this.receive(message, true); } catch (error) { if (!(error instanceof Denied)) throw error; }
        after = message.id;
      }
      await this.store.db.query('UPDATE conversations SET checkpoint=$2 WHERE id=$1', [conversation.id, after]);
      if (messages.length < 100) {
        await this.store.db.query('UPDATE conversations SET gap=false WHERE id=$1', [conversation.id]);
        return;
      }
    }
    await this.store.audit('history_gap', conversation.id, { reason: 'recovery_budget' });
  }
}

export function deliveryMarker(row: Delivery): string {
  return createHash('sha256').update(row.idempotency_key).digest('hex').slice(0, 24);
}
export class DiscordPublisher {
  constructor(private readonly store: Store, private readonly gate: PolicyGate, private readonly rest: DiscordRest) {}
  private async authorized(row: Delivery): Promise<void> {
    const policy = await this.gate.authorize(row.owner_id, row.scope);
    if (!row.service_ids.every(service => policy.services.includes(service))) throw new Denied();
    row.policy_revision = policy.revision;
    await this.store.db.query('UPDATE outbox SET policy_revision=$2 WHERE id=$1', [row.id, policy.revision]);
    if (row.payload.channel !== row.scope.channel || row.payload.classification !== 'safe_summary') throw new Denied();
    if (row.scope.kind !== 'channel' && row.conversation_id && !await this.store.active(row.conversation_id)) throw new Denied();
  }
  async deliver(): Promise<boolean> {
    const row = await this.store.claimDelivery();
    if (!row) return false;
    try {
      await this.authorized(row);
      const marker = deliveryMarker(row);
      if (row.payload.kind === 'message' && row.payload.content.length > 1900) throw new Denied();
      const sent = row.payload.kind === 'thread'
        ? await this.rest.createThread(row.payload.channel, { name: `homelab-${marker}`, type: 11, auto_archive_duration: 1440 })
        : await this.rest.sendMessage(row.payload.channel, { content: `${row.payload.content}\n[ref:${marker}]`,
          nonce: marker, enforce_nonce: true, ...noMentions });
      await this.confirm(row, sent.id);
    } catch (error) {
      if (error instanceof PolicyUnavailable || error instanceof DiscordUnauthorized) {
        await this.store.pauseDelivery(row, error.message);
      } else if (error instanceof Denied) await this.store.deliveryState(row, 'blocked');
      else if (error instanceof RateLimited) {
        await this.store.deliveryState(row, row.attempt > DEFAULTS.maxRetries ? 'blocked' : 'pending', null, Math.max(1000, error.retryAfterMs));
        await this.store.audit('discord_rate_limit', row.id, { attempt: row.attempt, retryAfterMs: error.retryAfterMs });
      }
      else await this.store.deliveryState(row, 'unknown');
    }
    return true;
  }
  async reconcile(): Promise<void> {
    await this.store.retireUnknownDeliveries();
    const pause = (await this.store.db.query<{ value: number }>("SELECT value FROM controls WHERE key='discord_reconcile_after'")).rows[0];
    if (pause && pause.value > this.store.now()) return;
    for (const row of (await this.store.db.query<Delivery>("SELECT * FROM outbox WHERE state='unknown' ORDER BY created_at LIMIT 100")).rows) {
      try {
        await this.authorized(row);
        const found = await this.rest.findDelivery(row.payload.channel, deliveryMarker(row), row.payload.kind);
        if (found) await this.confirm(row, found.id);
        // A bounded search miss is not proof of absence; keep unknown, never auto-resend.
      } catch (error) {
        if (error instanceof RateLimited) {
          await this.store.db.query(`INSERT INTO controls VALUES ('discord_reconcile_after',to_jsonb($1::bigint))
            ON CONFLICT (key) DO UPDATE SET value=to_jsonb(GREATEST(controls.value::bigint,$1::bigint))`,
          [this.store.now() + Math.max(1000, error.retryAfterMs)]);
          await this.store.audit('discord_reconcile_rate_limit', row.id, { retryAfterMs: error.retryAfterMs });
          break;
        }
        if (error instanceof Denied) await this.store.deliveryState(row, 'blocked');
      }
    }
  }
  private async confirm(row: Delivery, externalId: string): Promise<void> {
    if (row.payload.kind === 'thread') {
      const scope: Scope = { ...row.scope, kind: 'thread', parent: row.scope.channel, channel: externalId };
      await this.store.db.transaction(async tx => {
        const id = this.store.scopeId(scope);
        await tx.query(`INSERT INTO conversations(id,owner_id,scope,channel_id,created_at) VALUES ($1,$2,$3,$4,$5)
          ON CONFLICT DO NOTHING`, [id, row.owner_id, JSON.stringify(scope), externalId, this.store.now()]);
        await tx.query('UPDATE events SET conversation_id=$2,scope=$3 WHERE id=$1', [row.payload.content, id, JSON.stringify(scope)]);
      });
      const event = (await this.store.db.query<{ payload: { command?: string; urgent?: boolean; group?: string; text: string } }>('SELECT payload FROM events WHERE id=$1', [row.payload.content])).rows[0]!;
      if (event.payload.command === 'alert') {
        await this.store.db.query('UPDATE incidents SET conversation_id=$2 WHERE group_key=$1', [event.payload.group, this.store.scopeId(scope)]);
        await this.store.db.query('UPDATE events SET accepted=true WHERE id=$1', [row.payload.content]);
        await this.store.enqueue({ key: `incident-summary:${row.id}`, actor: row.owner_id, scope,
          conversation: this.store.scopeId(scope), revision: row.policy_revision,
          payload: { kind: 'message', channel: externalId, content: event.payload.text, classification: 'safe_summary' } });
      } else await this.store.accept(row.payload.content, event.payload.command === 'task' ? 'task' : 'chat', row.policy_revision,
        event.payload.urgent || event.payload.command === 'urgent');
      await this.store.ackNotice(row.payload.content);
    }
    await this.store.deliveryState(row, 'sent', externalId);
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
