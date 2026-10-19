import { createHash, randomUUID } from 'node:crypto';
import { z } from 'zod';
import type { PolicyGate } from './policy.js';
import type { Store } from './store.js';
import { DEFAULTS } from './contracts.js';
import type { Scope } from './contracts.js';

const AlertSchema = z.object({
  groupKey: z.string().min(1).max(500), status: z.enum(['firing', 'resolved']),
  alerts: z.array(z.object({ fingerprint: z.string().max(100),
    labels: z.object({ service: z.string().max(100).optional(), severity: z.string().max(100).optional() }),
  })).min(1).max(100),
});
export class AlertIngress {
  constructor(private readonly store: Store, private readonly gate: PolicyGate) {}
  async receive(input: unknown): Promise<void> {
    const alert = AlertSchema.parse(input);
    const p = await this.gate.current();
    const scope: Scope = { guild: p.guild, channel: p.notificationChannel, parent: null, kind: 'channel' };
    await this.gate.authorize(p.owner, scope);
    const key = createHash('sha256').update(alert.groupKey).digest('hex');
    const supported = alert.alerts.filter(a => a.labels.service && p.services.includes(a.labels.service)
      && ['info', 'warning', 'critical'].includes(a.labels.severity ?? ''));
    if (supported.length < alert.alerts.length) await this.store.audit('alert_ignored', key,
      { reason: 'unsupported_labels', count: alert.alerts.length - supported.length });
    if (!supported.length) return;
    const fingerprint = createHash('sha256').update(JSON.stringify([alert.status, supported.map(a => a.fingerprint).sort()])).digest('hex');
    await this.store.db.transaction(async tx => {
      await tx.query(`INSERT INTO controls VALUES ('alert_admission','false') ON CONFLICT DO NOTHING`);
      await tx.query(`SELECT * FROM controls WHERE key='alert_admission' FOR UPDATE`);
      // Serialize a group's first thread and repeats without executing a model.
      await tx.query(`INSERT INTO incidents(group_key,status,fingerprint,count,updated_at) VALUES ($1,$2,'',0,$3) ON CONFLICT DO NOTHING`, [key, alert.status, this.store.now()]);
      const old = (await tx.query<{ fingerprint: string; conversation_id: string | null; count: number; delivery_key: string | null }>('SELECT * FROM incidents WHERE group_key=$1 FOR UPDATE', [key])).rows[0]!;
      const previous = (await tx.query<{ state: string }>('SELECT state FROM outbox WHERE idempotency_key=$1', [old.delivery_key])).rows[0];
      // Unknown may already exist remotely; reconcile it rather than create a duplicate thread.
      const pendingThread = (await tx.query<{ payload: { content: string } }>(`SELECT o.payload FROM outbox o
        JOIN events e ON e.id=o.payload->>'content' WHERE e.payload->>'group'=$1
        AND o.payload->>'kind'='thread' AND o.state IN ('pending','sending','unknown')
        ORDER BY e.event_order DESC LIMIT 1`, [key])).rows[0];
      await tx.query('UPDATE incidents SET status=$2,fingerprint=$3,count=count+1,updated_at=$4 WHERE group_key=$1', [key, alert.status, fingerprint, this.store.now()]);
      if (old.fingerprint === fingerprint && (pendingThread || (previous && previous.state !== 'blocked'))) return;
      const content = `경보 ${alert.status}: ${supported.length}건. 원문은 게시하지 않았습니다. 복원 가능 여부는 미확인입니다.`;
      const pending = (await tx.query<{ count: string }>("SELECT count(*) FROM outbox WHERE state IN ('pending','sending')")).rows[0]!;
      if (Number(pending.count) >= DEFAULTS.maxQueue) throw new Error('alert_queue_full');
      if (old.conversation_id) {
        const conversation = (await tx.query<{ scope: Scope }>('SELECT scope FROM conversations WHERE id=$1', [old.conversation_id])).rows[0]!;
        const deliveryKey = `alert:${key}:${fingerprint}:${old.count + 1}`;
        await tx.query('UPDATE incidents SET delivery_key=$2 WHERE group_key=$1', [key, deliveryKey]);
        await this.store.enqueue({ key: deliveryKey, actor: p.owner, scope: conversation.scope,
          conversation: old.conversation_id, revision: p.revision,
          payload: { kind: 'message', channel: conversation.scope.channel, content, classification: 'safe_summary' } }, tx);
        return;
      }
      if (pendingThread) {
        await tx.query('UPDATE events SET payload=$2 WHERE id=$1', [pendingThread.payload.content,
          JSON.stringify({ command: 'alert', group: key, text: content })]);
        return;
      }
      const id = randomUUID();
      const conversationId = this.store.scopeId(scope);
      await tx.query(`INSERT INTO conversations(id,owner_id,scope,channel_id,created_at) VALUES ($1,$2,$3,$4,$5) ON CONFLICT DO NOTHING`,
        [conversationId, p.owner, JSON.stringify(scope), scope.channel, this.store.now()]);
      await tx.query(`INSERT INTO events(id,provider,delivery_id,semantic_key,actor_id,scope,conversation_id,received_at,payload)
        VALUES ($1,'alertmanager',$1,$2,$3,$4,$5,$6,$7)`, [id, `alert:${key}:${fingerprint}:${old.count + 1}`, p.owner,
        JSON.stringify(scope), conversationId, this.store.now(), JSON.stringify({ command: 'alert', group: key, text: content })]);
      const deliveryKey = `incident:${key}:${old.count + 1}`;
      await tx.query('UPDATE incidents SET delivery_key=$2 WHERE group_key=$1', [key, deliveryKey]);
      await this.store.enqueue({ key: deliveryKey, actor: p.owner, scope, conversation: conversationId,
        revision: p.revision, payload: { kind: 'thread', channel: scope.channel, content: id, classification: 'safe_summary' } }, tx);
    });
  }
}
