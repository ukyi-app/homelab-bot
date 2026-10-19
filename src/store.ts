import { randomUUID } from 'node:crypto';
import { DEFAULTS } from './contracts.js';
import type { Clock, EventInput, Job, Scope, State } from './contracts.js';
import type { Database } from './database.js';

export interface Conversation {
  id: string; owner_id: string; scope: Scope; channel_id: string;
  active: boolean; gap: boolean; checkpoint: string | null;
}
export interface Delivery {
  id: string; job_id: string | null; conversation_id: string | null;
  owner_id: string; scope: Scope; policy_revision: string; idempotency_key: string;
  payload: { kind: 'message' | 'thread'; channel: string; content: string; classification: 'safe_summary' };
  state: string; external_id: string | null; lease_token: string; attempt: number;
}
const json = (value: unknown) => JSON.stringify(value);
export class Store {
  constructor(public readonly db: Database, public readonly now: Clock = Date.now) {}
  async atomic<T>(fn: (store: Store) => Promise<T>): Promise<T> {
    return this.db.transaction(tx => fn(new Store({
      query: (sql, params) => tx.query(sql, params), transaction: nested => nested(tx),
    }, this.now)));
  }
  async conversation(scope: Scope): Promise<Conversation | undefined> {
    return (await this.db.query<Conversation>('SELECT * FROM conversations WHERE id=$1', [this.scopeId(scope)])).rows[0];
  }
  scopeId(scope: Scope): string { return `${scope.kind}:${scope.guild ?? 'direct'}:${scope.channel}`; }
  async save(event: EventInput, revision: string, activate: boolean): Promise<{ id: string; duplicate: boolean }> {
    return this.db.transaction(async tx => {
      const key = `discord:${event.id}`;
      const existing = (await tx.query<{ id: string }>('SELECT id FROM events WHERE semantic_key=$1', [key])).rows[0];
      if (existing) return { id: existing.id, duplicate: true };
      const scopeId = this.scopeId(event.scope);
      await tx.query(`INSERT INTO conversations(id,owner_id,scope,channel_id,created_at,active)
        VALUES ($1,$2,$3,$4,$5,$6) ON CONFLICT (id) DO UPDATE SET
        active=CASE WHEN $3::jsonb->>'kind'='channel' THEN false WHEN $6 THEN true ELSE conversations.active END`,
      [scopeId, event.actor, json(event.scope), event.scope.channel, this.now(), activate && event.scope.kind !== 'channel']);
      const id = randomUUID();
      const inserted = await tx.query(`INSERT INTO events(id,provider,delivery_id,semantic_key,actor_id,scope,
        conversation_id,received_at,payload) VALUES ($1,'discord',$2,$3,$4,$5,$6,$7,$8)
        ON CONFLICT DO NOTHING RETURNING id`, [id, event.id, key, event.actor, json(event.scope), scopeId,
        this.now(), json({ text: event.text, command: event.command, target: event.target, kind: event.kind, revision })]);
      if (!inserted.rows.length) {
        const row = (await tx.query<{ id: string }>('SELECT id FROM events WHERE semantic_key=$1', [key])).rows[0]!;
        return { id: row.id, duplicate: true };
      }
      return { id, duplicate: false };
    });
  }
  async accept(id: string, type: 'chat' | 'task', revision: string, urgent = false, debounce = DEFAULTS.debounceMs): Promise<string> {
    return this.db.transaction(async tx => {
      // A common row serializes admission and model claims across publisher instances.
      await tx.query(`INSERT INTO controls VALUES ('scheduler','false') ON CONFLICT DO NOTHING`);
      await tx.query(`SELECT * FROM controls WHERE key='scheduler' FOR UPDATE`);
      const queued = (await tx.query<{ count: string }>("SELECT count(*) FROM jobs WHERE state='queued'")).rows[0]!;
      if (Number(queued.count) >= DEFAULTS.maxQueue) throw new Error('queue_full');
      const event = (await tx.query<{ actor_id: string; scope: Scope; conversation_id: string }>('SELECT * FROM events WHERE id=$1', [id])).rows[0]!;
      const jobId = randomUUID();
      const inserted = await tx.query<{ id: string }>(`INSERT INTO jobs(id,event_id,conversation_id,type,owner_id,target,revision,budget,
        priority,available_at,created_at) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
        ON CONFLICT (event_id) DO NOTHING RETURNING id`, [jobId, id, event.conversation_id, type, event.actor_id,
        json(event.scope), json({ policy: revision }), json({ timeoutMs: type === 'chat' ? DEFAULTS.chatTimeoutMs : DEFAULTS.taskTimeoutMs,
          toolCalls: DEFAULTS.maxToolCalls }), urgent ? 0 : type === 'chat' ? 10 : 30,
        this.now() + (urgent || type === 'task' ? 0 : debounce), this.now()]);
      await tx.query('UPDATE events SET accepted=true WHERE id=$1', [id]);
      if (!inserted.rows.length) return (await tx.query<{ id: string }>('SELECT id FROM jobs WHERE event_id=$1', [id])).rows[0]!.id;
      if (type === 'chat') await tx.query(`UPDATE jobs SET state='superseded' WHERE conversation_id=$1 AND type='chat'
        AND state='queued' AND id<>$2`, [event.conversation_id, jobId]);
      return jobId;
    });
  }
  async claim(): Promise<Job | undefined> {
    return this.db.transaction(async tx => {
      await tx.query(`INSERT INTO controls VALUES ('scheduler','false') ON CONFLICT DO NOTHING`);
      const control = (await tx.query<{ value: boolean }>(`SELECT value FROM controls WHERE key='scheduler' FOR UPDATE`)).rows[0]!;
      if (control.value) return;
      // Unknown hosts may still be executing; they hold the global model slot.
      if ((await tx.query(`SELECT id FROM jobs WHERE state IN ('running','verifying','cancel_requested','unknown') LIMIT 1`)).rows.length) return;
      const row = (await tx.query<Job>(`SELECT j.* FROM jobs j JOIN events e ON e.id=j.event_id
        JOIN conversations c ON c.id=j.conversation_id WHERE j.state='queued' AND e.accepted=true
        AND c.active=true AND c.gap=false AND j.available_at<=$1
        ORDER BY j.priority,j.created_at,e.event_order FOR UPDATE OF j SKIP LOCKED LIMIT 1`, [this.now()])).rows[0];
      if (!row) return;
      return (await tx.query<Job>(`UPDATE jobs SET state='running',attempt=attempt+1,
        lease_token=$2,lease_until=$3,started_at=$4 WHERE id=$1 RETURNING *`,
      [row.id, randomUUID(), this.now() + DEFAULTS.leaseMs, this.now()])).rows[0];
    });
  }
  async heartbeat(job: Job): Promise<boolean> {
    return (await this.db.query(`UPDATE jobs SET lease_until=$3 WHERE id=$1 AND lease_token=$2
      AND lease_until>$4 AND state IN ('running','verifying','cancel_requested') RETURNING id`,
    [job.id, job.lease_token, this.now() + DEFAULTS.leaseMs, this.now()])).rows.length === 1;
  }
  async expire(): Promise<void> {
    await this.db.query(`UPDATE jobs SET state='unknown',wait_reason='lease_expired'
      WHERE state IN ('running','verifying','cancel_requested') AND lease_until<=$1`, [this.now()]);
    await this.db.query(`UPDATE outbox SET state='unknown',available_at=$1 WHERE state='sending' AND lease_until<=$1`, [this.now()]);
    await this.retireUnknownDeliveries();
  }
  async retireUnknownDeliveries(): Promise<void> {
    await this.db.transaction(async tx => {
      const rows = (await tx.query<{ id: string; available_at: string }>(
        "SELECT id,available_at FROM outbox WHERE state='unknown' ORDER BY available_at DESC,id FOR UPDATE")).rows;
      for (const [index, row] of rows.entries()) {
        if (index < DEFAULTS.maxUnknownDeliveries && this.now() - Number(row.available_at) < DEFAULTS.unknownDeliveryMs) continue;
        await tx.query("UPDATE outbox SET state='blocked' WHERE id=$1", [row.id]);
        await tx.query("INSERT INTO audit(kind,subject,detail,created_at) VALUES ('delivery_unresolved_retired',$1,$2,$3)",
          [row.id, json({ reason: index >= DEFAULTS.maxUnknownDeliveries ? 'unknown_capacity' : 'unknown_deadline', resend: false }), this.now()]);
      }
    });
  }
  async defer(job: Job): Promise<void> {
    await this.db.query(`UPDATE jobs SET state='queued',wait_reason='policy_unavailable',attempt=GREATEST(0,attempt-1),
      available_at=$3,lease_token=NULL,lease_until=NULL WHERE id=$1 AND lease_token=$2 AND state='running'`,
    [job.id, job.lease_token, this.now() + DEFAULTS.retryDelayMs]);
  }
  async fail(job: Job, reason: string): Promise<void> {
    await this.atomic(async store => {
      if (!await store.transition(job, 'failed', reason)) return;
      await store.enqueue({ key: `failure:${job.id}:${job.attempt}`, job: job.id, conversation: job.conversation_id,
        actor: job.owner_id, scope: job.target, revision: job.revision.policy,
        payload: { kind: 'message', channel: job.target.channel, content: '작업 실패가 확인됐습니다. /list로 상태를 확인하고 /retry로 재시도할 수 있습니다.', classification: 'safe_summary' } });
    });
  }
  async transition(job: Job, state: State, reason: string | null = null): Promise<boolean> {
    return (await this.db.query(`UPDATE jobs SET state=$3,wait_reason=$4,finished_at=$5
      WHERE id=$1 AND lease_token=$2 AND lease_until>$5 AND state IN ('running','verifying','cancel_requested') RETURNING id`,
    [job.id, job.lease_token, state, reason, this.now()])).rows.length === 1;
  }
  async finish(job: Job, result: unknown, evidence: unknown, content: string, scope: Scope): Promise<void> {
    await this.db.transaction(async tx => {
      const changed = await tx.query(`UPDATE jobs SET state='succeeded',finished_at=$3 WHERE id=$1 AND lease_token=$2
        AND lease_until>$3 AND state='running' RETURNING id`, [job.id, job.lease_token, this.now()]);
      if (!changed.rows.length) throw new Error('stale_result');
      await tx.query('INSERT INTO results VALUES ($1,$2,$3,$4,$5)', [job.id, json(result), json(evidence), 'internal', this.now()]);
      await this.enqueue({ key: `result:${job.id}`, job: job.id, conversation: job.conversation_id,
        actor: job.owner_id, scope, revision: job.revision.policy,
        payload: { kind: 'message', channel: scope.channel, content, classification: 'safe_summary' } }, tx);
    });
  }
  async enqueue(input: { key: string; job?: string; conversation?: string; actor: string; scope: Scope; revision: string; payload: Delivery['payload'] }, tx = this.db): Promise<void> {
    await tx.query(`INSERT INTO outbox(id,job_id,conversation_id,owner_id,scope,policy_revision,idempotency_key,payload,available_at,created_at)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$9) ON CONFLICT (idempotency_key) DO NOTHING`,
    [randomUUID(), input.job ?? null, input.conversation ?? null, input.actor, json(input.scope), input.revision, input.key, json(input.payload), this.now()]);
  }
  async claimDelivery(): Promise<Delivery | undefined> {
    return this.db.transaction(async tx => {
      const row = (await tx.query<Delivery>(`SELECT * FROM outbox WHERE state='pending' AND available_at<=$1
        ORDER BY created_at,id FOR UPDATE SKIP LOCKED LIMIT 1`, [this.now()])).rows[0];
      if (!row) return;
      return (await tx.query<Delivery>(`UPDATE outbox SET state='sending',attempt=attempt+1,
        lease_until=$2,lease_token=$3 WHERE id=$1 RETURNING *`, [row.id, this.now() + DEFAULTS.leaseMs, randomUUID()])).rows[0];
    });
  }
  async deliveryState(row: Delivery, state: string, externalId: string | null = null, delay = 0): Promise<void> {
    await this.db.query(`UPDATE outbox SET state=$3,external_id=$4,available_at=$5,pause_reason=NULL,pause_count=0 WHERE id=$1 AND lease_token=$2`,
      [row.id, row.lease_token, state, externalId, this.now() + delay]);
  }
  async pauseDelivery(row: Delivery, reason: string): Promise<void> {
    await this.atomic(async store => {
      const previous = (await store.db.query<{ pause_reason: string | null; pause_count: number }>(
        "SELECT pause_reason,pause_count FROM outbox WHERE id=$1 AND lease_token=$2 AND state='sending' FOR UPDATE", [row.id, row.lease_token])).rows[0];
      if (!previous) return;
      const count = previous.pause_reason === reason ? Math.min(previous.pause_count + 1, 7) : 1;
      const delay = Math.min(60_000, DEFAULTS.retryDelayMs * 2 ** (count - 1));
      await store.db.query(`UPDATE outbox SET state='pending',attempt=GREATEST(0,attempt-1),
        pause_reason=$3,pause_count=$4,available_at=$5 WHERE id=$1 AND lease_token=$2`,
      [row.id, row.lease_token, reason, count, store.now() + delay]);
      if (previous.pause_reason !== reason) await store.audit('delivery_paused', row.id, { reason });
    });
  }
  async ackNotice(id: string): Promise<void> {
    const event = (await this.db.query<{ actor_id: string; scope: Scope; conversation_id: string;
      payload: { ackUncertain?: boolean; revision: string } }>('SELECT * FROM events WHERE id=$1', [id])).rows[0]!;
    if (!event.payload.ackUncertain) return;
    if (event.scope.kind === 'channel' && (await this.db.query(
      "SELECT id FROM outbox WHERE payload->>'kind'='thread' AND payload->>'content'=$1", [id])).rows.length) return;
    await this.enqueue({ key: `ack-notice:${id}`, actor: event.actor_id, scope: event.scope,
      conversation: event.conversation_id, revision: event.payload.revision,
      payload: { kind: 'message', channel: event.scope.channel, classification: 'safe_summary',
        content: '상호작용 응답이 만료됐거나 확인되지 않았지만 요청 기록은 저장했습니다. 다시 보내기 전에 이 대화의 /list로 처리 상태를 확인하세요.' } });
  }
  async context(conversation: string): Promise<unknown[]> {
    const rows = (await this.db.query<{ payload: unknown }>(`SELECT payload FROM events WHERE conversation_id=$1 AND accepted=true
      ORDER BY event_order DESC LIMIT $2`, [conversation, DEFAULTS.contextMessages])).rows;
    const context: unknown[] = [];
    let bytes = 0;
    for (const row of rows) {
      bytes += Buffer.byteLength(JSON.stringify(row.payload));
      if (bytes > 32768) break;
      context.unshift(row.payload);
    }
    return context;
  }
  async checkpoint(conversation: string, message: string): Promise<void> {
    if (!/^\d+$/.test(message)) return;
    await this.db.query(`UPDATE conversations SET checkpoint=$2 WHERE id=$1 AND gap=false
      AND (checkpoint IS NULL OR checkpoint::numeric<$2::numeric)`, [conversation, message]);
  }
  async active(conversation: string): Promise<boolean> {
    const row = (await this.db.query<Conversation>('SELECT * FROM conversations WHERE id=$1', [conversation])).rows[0];
    return !!row?.active && !row.gap;
  }
  async control(actor: string, conversation: string, action: string, target?: string): Promise<unknown> {
    if (action === 'stop' || action === 'resume') {
      const changed = await this.db.query(`UPDATE conversations SET active=$3 WHERE id=$1 AND owner_id=$2
        AND scope->>'kind'<>'channel' RETURNING id`, [conversation, actor, action === 'resume']);
      if (!changed.rows.length) return { ok: false, status: '구독 제어는 작업을 시작한 스레드 또는 DM에서 실행하세요.' };
      return { active: action === 'resume' };
    }
    if (action === 'list') {
      const jobs = (await this.db.query('SELECT id,state,wait_reason FROM jobs WHERE owner_id=$1 AND conversation_id=$2 ORDER BY created_at', [actor, conversation])).rows;
      return jobs.length ? jobs : { ok: false, status: '현재 대화에 작업이 없습니다. 작업을 시작한 스레드에서 확인하세요.' };
    }
    if (action === 'cancel') {
      const changed = await this.db.query(`UPDATE jobs SET state=CASE WHEN state='queued' THEN 'cancelled' ELSE 'cancel_requested' END
        WHERE id=$1 AND owner_id=$2 AND conversation_id=$3 AND state IN ('queued','running') RETURNING id`, [target, actor, conversation]);
      if (!changed.rows.length) return { ok: false, status: '취소할 작업이 현재 대화에 없거나 취소 가능한 상태가 아닙니다.' };
      return { status: '취소 요청. 실행 중 작업의 종료 확인 전에는 cancelled로 표시하지 않습니다.' };
    }
    if (action === 'retry') {
      const changed = await this.db.query(`UPDATE jobs SET state='queued',available_at=$4,wait_reason=NULL
        WHERE id=$1 AND owner_id=$2 AND conversation_id=$3 AND state='failed' AND attempt<$5 RETURNING id`,
      [target, actor, conversation, this.now(), DEFAULTS.maxRetries + 1]);
      if (!changed.rows.length) return { ok: false, status: '재시도할 작업이 현재 대화에 없거나 상태·재시도 한도가 허용하지 않습니다.' };
      return { status: '확인된 실패 작업만 재시도합니다.' };
    }
    if (action === 'emergency-stop') {
      await this.db.query(`INSERT INTO controls VALUES ('scheduler','true') ON CONFLICT (key) DO UPDATE SET value='true'`);
      await this.db.query(`UPDATE jobs SET state='cancel_requested' WHERE state='running'`);
      return { status: '새 모델 호출 차단, 실행 중 작업 취소 요청' };
    }
    throw new Error('unsupported_control');
  }
  async audit(kind: string, subject: string, detail: unknown): Promise<void> {
    await this.db.query('INSERT INTO audit(kind,subject,detail,created_at) VALUES ($1,$2,$3,$4)', [kind, subject, json(detail), this.now()]);
  }
}
