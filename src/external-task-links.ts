import { generateKeyPairSync, randomBytes, randomUUID } from 'node:crypto';
import { inspect } from 'node:util';
import { z } from 'zod';
import { Denied } from './contracts.js';
import type { Scope } from './contracts.js';
import type { Database, TransactionDeadline } from './database.js';
import type { Store } from './store.js';

// R08 연결 레코드의 수명(DECISIONS "T18 결정" (1), ARCHITECTURE §15). 사람 세션의 자기 보고를 받는 통로일 뿐이라
// 능력은 읽기 둘만 true다. 이 값을 바꾸면 이벤트가 실행 권한으로 번지므로 시험이 고정한다.
export const EXTERNAL_TASK_CAPABILITIES = Object.freeze({
  read_status: true, read_events: true,
  start_task: false, answer_question: false, request_cancel: false, resume_task: false, read_final_result: false,
});
export const EXTERNAL_TASK_EXECUTORS = ['claude', 'codex'] as const;
export type ExternalTaskExecutor = typeof EXTERNAL_TASK_EXECUTORS[number];
export const EXTERNAL_TASK_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
export const EXTERNAL_LINK_TTL_MS = 30 * 24 * 3_600_000;
// event_id는 sent_at·occurred_at 창이 24시간이라 그 뒤 재생은 시각 검사에서 걸린다. 7일은 그 위의 여유다.
export const EXTERNAL_EVENT_RETENTION_MS = 7 * 24 * 3_600_000;
export const EXTERNAL_CLOSED_RETENTION_MS = 30 * 24 * 3_600_000;
export const outboxKey = (connection: string, event: string) => `external-task:${connection}:${event}`;

export type RevokeReason = 'detach' | 'lost_device' | 'delivery_failed';
export interface ExternalConnection {
  id: string; owner_id: string; conversation_id: string; scope: Scope; external_task_id: string;
  executor: ExternalTaskExecutor; public_key: string; key_id: string; summary_consent: boolean;
  expires_at: number; revoked_at: number | null; revoked_reason: string | null;
  created_at: number; rotated_at: number | null; last_event_at: number | null;
}
const numeric = ['expires_at', 'revoked_at', 'created_at', 'rotated_at', 'last_event_at'] as const;
// bigint 열은 드라이버에 따라 문자열로 온다.
export function connectionRow(row: ExternalConnection): ExternalConnection {
  const copy = { ...row };
  for (const key of numeric) if (copy[key] !== null) (copy as Record<string, unknown>)[key] = Number(copy[key]);
  return copy;
}

// 일회 응답 경계. 값은 reveal()로 한 번만 꺼낼 수 있고, 문자열·JSON·inspect로는 나오지 않는다.
// 그래서 이 객체가 outbox payload·감사 detail·오류 수집·로그에 실수로 실려도 값이 남지 않는다.
export class OneTimeSeed {
  #seed: string | undefined;
  constructor(seed: string) { this.#seed = seed; }
  get revealed(): boolean { return this.#seed === undefined; }
  reveal(): string {
    if (this.#seed === undefined) throw new Error('external_seed_already_revealed');
    const seed = this.#seed;
    this.#seed = undefined;
    return seed;
  }
  toString(): string { return '[redacted]'; }
  toJSON(): string { return '[redacted]'; }
  [inspect.custom](): string { return '[redacted]'; }
}
export interface IssuedLink {
  connectionId: string; keyId: string; externalTaskId: string; executor: ExternalTaskExecutor;
  summaryConsent: boolean; expiresAt: number; seed: OneTimeSeed;
}
export function newKeyPair(): { seed: OneTimeSeed; publicKey: string; keyId: string } {
  const pair = generateKeyPairSync('ed25519');
  const publicKey = pair.publicKey.export({ format: 'jwk' }).x;
  const seed = pair.privateKey.export({ format: 'jwk' }).d;
  if (!publicKey || !seed) throw new Error('external_key_generation_failed');
  return { seed: new OneTimeSeed(seed), publicKey, keyId: randomBytes(12).toString('base64url') };
}
const AttachInput = z.strictObject({
  owner: z.string().min(1), externalTaskId: z.string().regex(EXTERNAL_TASK_ID),
  executor: z.enum(EXTERNAL_TASK_EXECUTORS), summaryConsent: z.boolean().default(false),
});
export class AlreadyAttached extends Error { constructor() { super('external_task_already_attached'); } }
export class ConnectionClosed extends Error { constructor() { super('external_connection_closed'); } }

// 복원 울타리(fence). 복원하면 Postgres timeline이 올라가는데, 이 값은 백업에 든 옛 값과 달라진다.
// timeline은 물리 복원·PITR만 잡으므로 pg_dump 복원에 대비해 운영자가 올리는 restoreEpoch를 함께 비교한다.
// 함정: 장애 조치(promote)도 timeline을 올리므로 그때도 모든 연결이 닫히고 다시 /attach 해야 한다. 안전한 쪽의 오탐이다.
const CURRENT_TIMELINE = "SELECT substr(pg_walfile_name(pg_current_wal_lsn()),1,8) AS timeline";
const RESTORE_EPOCH = /^[A-Za-z0-9._-]{1,64}$/;

export interface ExternalTaskLinksOptions { restoreEpoch?: string }
export class ExternalTaskLinks {
  private readonly restoreEpoch: string;
  constructor(private readonly store: Store, options: ExternalTaskLinksOptions = {}) {
    this.restoreEpoch = options.restoreEpoch ?? '0';
    if (!RESTORE_EPOCH.test(this.restoreEpoch)) throw new Error('external_restore_epoch_invalid');
  }
  private get now(): number { return this.store.now(); }
  // 개인 seed는 여기서만 태어나고 반환값으로만 나간다. 감사에는 식별자만 쓴다. 전달은 호출자(B5)가 ephemeral로 하고,
  // 전달에 실패하면 revoke(...,'delivery_failed')로 닫은 뒤 다시 attach 한다.
  async attach(input: { owner: string; scope: Scope; externalTaskId: string; executor: ExternalTaskExecutor; summaryConsent?: boolean }): Promise<IssuedLink> {
    const { scope, ...rest } = input;
    const parsed = AttachInput.parse(rest);
    if (scope.kind === 'channel') throw new Denied();
    await this.enforceRestoreFence();
    return this.store.atomic(async store => {
      const conversation = await store.ownedConversation(scope, parsed.owner, true);
      if (!conversation.active || conversation.owner_id !== parsed.owner) throw new Denied();
      const now = store.now();
      await store.db.query(`UPDATE external_task_connections SET revoked_at=$1,revoked_reason='expired'
        WHERE owner_id=$2 AND conversation_id=$3 AND executor=$4 AND external_task_id=$5 AND revoked_at IS NULL AND expires_at<=$1`,
      [now, parsed.owner, conversation.id, parsed.executor, parsed.externalTaskId]);
      const key = newKeyPair();
      const id = randomUUID();
      const expiresAt = now + EXTERNAL_LINK_TTL_MS;
      const inserted = await store.db.query(`INSERT INTO external_task_connections(id,owner_id,conversation_id,scope,external_task_id,executor,
        public_key,key_id,summary_consent,expires_at,created_at) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
        ON CONFLICT (owner_id,conversation_id,executor,external_task_id) WHERE revoked_at IS NULL DO NOTHING RETURNING id`,
      [id, parsed.owner, conversation.id, JSON.stringify(scope), parsed.externalTaskId, parsed.executor, key.publicKey, key.keyId,
        parsed.summaryConsent, expiresAt, now]);
      if (!inserted.rows.length) throw new AlreadyAttached();
      await store.audit('external_task_attached', id, { executor: parsed.executor, keyId: key.keyId, summaryConsent: parsed.summaryConsent, expiresAt });
      return { connectionId: id, keyId: key.keyId, externalTaskId: parsed.externalTaskId, executor: parsed.executor,
        summaryConsent: parsed.summaryConsent, expiresAt, seed: key.seed };
    });
  }
  private async owned(store: Store, connectionId: string, owner: string): Promise<ExternalConnection> {
    const row = (await store.db.query<ExternalConnection>('SELECT * FROM external_task_connections WHERE id=$1 FOR UPDATE', [connectionId])).rows[0];
    if (!row || row.owner_id !== owner) throw new Denied();
    return connectionRow(row);
  }
  // 분실·전달 실패에 쓰는 재발급이다. 같은 UPDATE로 이전 키를 덮어써서 새 키가 나오는 순간 이전 키가 곧바로 무효가 된다.
  // 미게시 이벤트는 이전 키로 들어온 것이라 함께 막는다.
  async rotate(connectionId: string, owner: string): Promise<IssuedLink> {
    await this.enforceRestoreFence();
    return this.store.atomic(async store => {
      const row = await this.owned(store, connectionId, owner);
      if (row.revoked_at !== null || row.expires_at <= store.now()) throw new ConnectionClosed();
      const key = newKeyPair();
      const now = store.now();
      const expiresAt = now + EXTERNAL_LINK_TTL_MS;
      await store.db.query(`UPDATE external_task_connections SET public_key=$2,key_id=$3,expires_at=$4,rotated_at=$5 WHERE id=$1`,
        [connectionId, key.publicKey, key.keyId, expiresAt, now]);
      const blocked = await this.blockUnposted(store, [connectionId]);
      await store.audit('external_task_rotated', connectionId, { keyId: key.keyId, previousKeyId: row.key_id, blocked, expiresAt });
      return { connectionId, keyId: key.keyId, externalTaskId: row.external_task_id, executor: row.executor,
        summaryConsent: row.summary_consent, expiresAt, seed: key.seed };
    });
  }
  // 이미 닫힌 연결을 또 닫아도 성공한다. 처음 닫은 사유를 덮어쓰지 않는다.
  async revoke(connectionId: string, owner: string, reason: RevokeReason = 'detach'): Promise<{ blocked: number }> {
    return this.store.atomic(async store => {
      const row = await this.owned(store, connectionId, owner);
      if (row.revoked_at !== null) return { blocked: 0 };
      await store.db.query('UPDATE external_task_connections SET revoked_at=$2,revoked_reason=$3 WHERE id=$1', [connectionId, store.now(), reason]);
      const blocked = await this.blockUnposted(store, [connectionId]);
      await store.audit('external_task_revoked', connectionId, { reason, blocked });
      return { blocked };
    });
  }
  async detach(connectionId: string, owner: string): Promise<{ blocked: number }> { return this.revoke(connectionId, owner, 'detach'); }
  // 동의를 거두면 그 뒤 고정 문구가 아닌 요약은 수신에서 거절된다. 이미 큐에 든 게시 행은 owner가 받기로 했던 것이라 그대로 둔다.
  // 이 트랜잭션이 잡는 연결 행 잠금으로 수신의 수락과 직렬화한다. 철회가 끝난 뒤 새로 저장되는 요약은 없다.
  async setSummaryConsent(connectionId: string, owner: string, consent: boolean): Promise<void> {
    await this.store.atomic(async store => {
      const row = await this.owned(store, connectionId, owner);
      if (row.revoked_at !== null) throw new ConnectionClosed();
      await store.db.query('UPDATE external_task_connections SET summary_consent=$2 WHERE id=$1', [connectionId, consent]);
      await store.audit('external_task_summary_consent', connectionId, { consent });
    });
  }
  // 게시자의 dispatch 표시는 state='sending'을 요구한다. 발송 시작 전 sending까지 blocked로 바꾸면 이 트랜잭션 뒤에는 나갈 수 없다.
  // 이미 발송을 시작한 행은 보냈을 수 있어 그대로 둔다. 그 발송이 실패해 pending으로 돌아오면 migration 016의 claim 트리거가 막는다.
  private async blockUnposted(store: Store, connections: string[]): Promise<number> {
    return (await store.db.query(`UPDATE outbox SET state='blocked' WHERE idempotency_key IN
      (SELECT outbox_key FROM external_task_events WHERE connection_id=ANY($1::text[]) AND post_state='pending')
      AND (state='pending' OR (state='sending' AND dispatch_started=false)) RETURNING id`, [connections])).rows.length;
  }
  // 복원이 감지되면 활성 연결을 모두 닫는다. 복원으로 되살아난 폐기 키와 미게시 행을 구별할 근거가 복원된 DB에는 없기 때문이다.
  // 수신마다 부른다. 값을 읽지 못하면 throw해서 수신이 닫힌다(503).
  // 트랜잭션으로 읽는 이유: 풀의 단발 조회에는 호출자 기한이 걸리지 않아, 잠금에 걸리면 응답이 끝난 뒤에도 DB 작업이 남는다.
  async enforceRestoreFence(deadline?: TransactionDeadline): Promise<{ fenced: number }> {
    const current = async (db: Database) => {
      const { timeline } = (await db.query<{ timeline: string }>(CURRENT_TIMELINE)).rows[0]!;
      return `timeline:${timeline};epoch:${this.restoreEpoch}`;
    };
    const unchanged = await this.store.atomic(async store => {
      const quick = (await store.db.query<{ token: string | null }>('SELECT token FROM external_task_link_fence')).rows[0];
      return quick?.token === await current(store.db);
    }, deadline);
    if (unchanged) return { fenced: 0 };
    return this.store.atomic(async store => {
      const stored = (await store.db.query<{ token: string | null }>('SELECT token FROM external_task_link_fence FOR UPDATE')).rows[0];
      const token = await current(store.db);
      if (stored?.token === token) return { fenced: 0 };
      const rows = (await store.db.query<{ id: string }>(`UPDATE external_task_connections SET revoked_at=$1,revoked_reason='restore_fence'
        WHERE revoked_at IS NULL RETURNING id`, [store.now()])).rows;
      const ids = rows.map(row => row.id);
      const blocked = ids.length ? await this.blockUnposted(store, ids) : 0;
      await store.db.query('UPDATE external_task_link_fence SET token=$1,fenced_at=$2', [token, store.now()]);
      // 첫 실행은 값을 처음 적는 것뿐이라 감사에 남기지 않는다.
      if (stored?.token) await store.audit('external_task_restore_fence', 'all', { fenced: ids.length, blocked });
      return { fenced: ids.length };
    }, deadline);
  }
  // read_status: owner·같은 대화만 본다. "살아 있다"가 아니라 마지막으로 알림을 받은 시각만 말한다.
  async status(connectionId: string, owner: string, scope: Scope) {
    const row = await this.visible(connectionId, owner, scope);
    const now = this.now;
    return { connectionId: row.id, externalTaskId: row.external_task_id, executor: row.executor, summaryConsent: row.summary_consent,
      state: row.revoked_at !== null ? 'revoked' as const : row.expires_at <= now ? 'expired' as const : 'active' as const,
      revokedReason: row.revoked_reason, expiresAt: row.expires_at, lastEventAt: row.last_event_at, capabilities: EXTERNAL_TASK_CAPABILITIES };
  }
  // read_events: 메타데이터만 돌려준다. 요약 원문은 이 표에 없다.
  async events(connectionId: string, owner: string, scope: Scope, limit = 20) {
    await this.visible(connectionId, owner, scope);
    const rows = (await this.store.db.query<{ event_id: string; occurred_at: string; received_at: string; post_state: string }>(
      `SELECT event_id,occurred_at,received_at,post_state FROM external_task_events WHERE connection_id=$1 ORDER BY received_at DESC,event_id LIMIT $2`,
      [connectionId, Math.min(100, Math.max(1, limit))])).rows;
    return rows.map(row => ({ eventId: row.event_id, occurredAt: Number(row.occurred_at), receivedAt: Number(row.received_at), postState: row.post_state }));
  }
  private async visible(connectionId: string, owner: string, scope: Scope): Promise<ExternalConnection> {
    const row = (await this.store.db.query<ExternalConnection>('SELECT * FROM external_task_connections WHERE id=$1', [connectionId])).rows[0];
    if (!row || row.owner_id !== owner || row.conversation_id !== this.store.scopeId(scope)) throw new Denied();
    return connectionRow(row);
  }
  // 게시가 끝난 이벤트만 지운다. 미게시 행은 역압과 폐기 차단이 아직 쓴다.
  async purge(): Promise<{ events: number; connections: number }> {
    const now = this.now;
    const events = (await this.store.db.query(`DELETE FROM external_task_events WHERE post_state<>'pending' AND received_at<$1 RETURNING event_id`,
      [now - EXTERNAL_EVENT_RETENTION_MS])).rows.length;
    const connections = (await this.store.db.query(`DELETE FROM external_task_connections c WHERE
      COALESCE(c.revoked_at,c.expires_at)<$1 AND NOT EXISTS (SELECT 1 FROM external_task_events e WHERE e.connection_id=c.id) RETURNING id`,
    [now - EXTERNAL_CLOSED_RETENTION_MS])).rows.length;
    return { events, connections };
  }
}
