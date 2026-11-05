import { createHash, createPublicKey, verify } from 'node:crypto';
import type { KeyObject } from 'node:crypto';
import { createServer } from 'node:http';
import type { IncomingMessage, Server, ServerResponse } from 'node:http';
import type { Duplex } from 'node:stream';
import { z } from 'zod';
import { Denied, PolicyUnavailable } from './contracts.js';
import type { Scope } from './contracts.js';
import type { Database, TransactionDeadline } from './database.js';
import { EXTERNAL_TASK_ID, connectionRow, outboxKey } from './external-task-links.js';
import type { ExternalConnection, ExternalTaskLinks } from './external-task-links.js';
import { errorInfo } from './log.js';
import type { Log } from './log.js';
import type { Store } from './store.js';

// R08 수신 처리(ARCHITECTURE §15). 경로·포트·노출 방식과 무관하다. 이 모듈은 listen하지 않고 main.ts에 연결되어 있지도 않다.
export const EXTERNAL_TASK_PATH = '/external-task-events';
export const FIXED_SUMMARY = '턴 완료';
export const RECEIVER_LIMITS = Object.freeze({
  bodyBytes: 4096, headerBytes: 8192, headerTimeoutMs: 5000, bodyTimeoutMs: 5000, concurrent: 8, maxConnections: 32,
  globalPerSecond: 10, globalBurst: 20,
  connectionPerMinute: 30, connectionBurst: 5, connectionPerHour: 300,
  unpostedPerConnection: 100, unpostedTotal: 1000,
  sentAtSkewMs: 300_000, occurredFutureMs: 300_000, occurredPastMs: 24 * 3_600_000,
  summaryCodePoints: 500, summaryBytes: 2000, externalIdBytes: 128,
  // DB를 함께 쓰는 GitHub·Discord 처리를 굶기지 않게 R08이 동시에 쓰는 DB 작업 수를 따로 묶는다.
  // 기한이 지나 응답을 닫아도 슬롯을 쥔 작업은 DB가 돌려줄 때까지 남고 HTTP 동시 수에서는 빠진다. 대기까지 합쳐 동시 8과 같게 둔다.
  dbSlots: 2, dbQueue: 6, processingTimeoutMs: 5000, transactionMs: 2000,
});
export type ReceiverLimits = { readonly [K in keyof typeof RECEIVER_LIMITS]: number };

// 서명 입력. 한 줄에 한 값이고 각 값은 형식 검사로 개행을 포함할 수 없어 필드 경계가 모호해지지 않는다.
// 본문은 파싱·재직렬화 없이 받은 바이트의 해시로만 묶는다.
export function signatureInput(input: { environment: string; method: string; path: string; connectionId: string; keyId: string; sentAt: string; bodySha256: string }): Buffer {
  return Buffer.from(['R08-v1', input.environment, input.method, input.path, input.connectionId, input.keyId, input.sentAt, input.bodySha256].join('\n'), 'utf8');
}
export const sha256Hex = (body: Uint8Array) => createHash('sha256').update(body).digest('hex');
export const ENVIRONMENT_ID = /^[a-z0-9][a-z0-9-]{0,62}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const KEY_ID = /^[A-Za-z0-9_-]{16}$/;
const SENT_AT = /^[1-9][0-9]{0,15}$/;
// Ed25519 서명 64바이트의 base64url은 86자다.
const SIGNATURE = /^[A-Za-z0-9_-]{86}$/;
// 없는 연결도 같은 검증 경로를 거치게 하는 값이다. 응답 시간으로 연결 존재 여부를 가리기 어렵게 한다. 비밀이 아니다.
const DUMMY_KEY = createPublicKey({ key: { kty: 'OKP', crv: 'Ed25519', x: '11qYAYKxCrfVS_7TyWQHOg7hcvPaplMlrwIaaPcHURo' }, format: 'jwk' });

const EventSchema = z.strictObject({
  version: z.literal(1),
  connection_id: z.string().regex(UUID),
  event_id: z.string().regex(/^[A-Za-z0-9_-]{16,64}$/),
  external_task_id: z.string().regex(EXTERNAL_TASK_ID),
  type: z.literal('turn_complete'),
  occurred_at: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
  summary: z.string().min(1),
});
// 길이 제한이 비밀을 지우지는 않는다. helper가 이미 고른 값이어도 다른 클라이언트에 대비해 서버에서 한 번 더 거른다.
// 같은 표가 tools/r08-helper/lib.mjs에 있고 시험이 두 쪽의 판정을 대조한다.
const SUSPECT_SUMMARY = [
  /(^|[\s"'`(=:,])(~[/\\]|\/(Users|home|root|etc|var|tmp|opt|private|mnt|srv|usr|run|proc|sys)([/\\\s]|$))/,
  /(^|[\s"'`(=:,])[A-Za-z]:[\\/]/, /\\\\[A-Za-z0-9._-]+\\/, /file:\/\//i, /:\/\/[^\s/@]+:[^\s/@]+@/,
  /\bsk-[A-Za-z0-9_-]{10,}/, /\bgh[pousr]_[A-Za-z0-9]{10,}/, /\bgithub_pat_/i, /\bxox[abprs]-/, /\bAKIA[0-9A-Z]{12,}/, /\bAIza[0-9A-Za-z_-]{20,}/,
  /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/, /-----BEGIN [A-Z ]*(PRIVATE KEY|CERTIFICATE)/, /\bbearer\s+[A-Za-z0-9._~+/=-]{8,}/i,
  /\b(password|passwd|pwd|secret|token|api[_-]?key|credential)s?\s*[:=]\s*\S/i, /(비밀번호|암호|토큰|시크릿)\s*[:=]\s*\S/,
  /[A-Za-z0-9+/_=-]{40,}/,
];
export const suspectSummary = (text: string) => SUSPECT_SUMMARY.some(pattern => pattern.test(text));
// Cs: JSON escape로만 들어올 수 있는 짝 없는 서로게이트.
const CONTROL = /[\p{Cc}\p{Cf}\p{Cs}]/u;

export const OUTCOMES = ['accepted', 'duplicate', 'not_found', 'method_not_allowed', 'unsupported_media', 'body_too_large', 'body_timeout',
  'header_too_large', 'header_timeout', 'malformed_http', 'aborted', 'bad_headers', 'clock_skew', 'unauthorized', 'invalid_body',
  'occurred_at_window', 'external_task_mismatch', 'summary_consent_required', 'summary_rejected', 'scope_denied', 'event_conflict',
  'rate_limited_global', 'rate_limited_connection', 'backlog_connection', 'backlog_total', 'overloaded', 'unavailable'] as const;
export type ExternalOutcome = typeof OUTCOMES[number];
export interface Reply { status: number; outcome: ExternalOutcome; retryAfter?: number }
// 응답 본문에는 고정 코드만 싣는다. unauthorized는 미등록·폐기·만료·위조를 구별해 주지 않는다.
// 중복은 첫 수락과 같은 응답이라 재전송과 ACK 유실이 구별되지 않아도 된다.
const replyBody = (reply: Reply): { error?: string; status?: string } =>
  reply.status < 300 ? { status: 'accepted' } : { error: reply.outcome };

export class TokenBucket {
  private tokens: number;
  private at: number;
  constructor(private readonly capacity: number, private readonly perSecond: number, now: number) { this.tokens = capacity; this.at = now; }
  private refill(now: number): void {
    this.tokens = Math.min(this.capacity, this.tokens + Math.max(0, now - this.at) / 1000 * this.perSecond);
    this.at = now;
  }
  // 토큰이 생길 때까지 남은 초. 0이면 지금 있다.
  wait(now: number): number {
    this.refill(now);
    return this.tokens >= 1 ? 0 : Math.max(1, Math.ceil((1 - this.tokens) / this.perSecond));
  }
  take(): void { this.tokens -= 1; }
  get full(): boolean { return this.tokens >= this.capacity; }
}
class ConnectionLimit {
  readonly minute: TokenBucket;
  readonly hour: TokenBucket;
  constructor(limits: ReceiverLimits, now: number) {
    this.minute = new TokenBucket(limits.connectionBurst, limits.connectionPerMinute / 60, now);
    this.hour = new TokenBucket(limits.connectionPerHour, limits.connectionPerHour / 3600, now);
  }
  // 두 버킷이 모두 있을 때만 하나씩 쓴다. 분 버킷에 막힌 요청이 시간 버킷을 깎지 않게 한다.
  admit(now: number): number {
    const wait = Math.max(this.minute.wait(now), this.hour.wait(now));
    if (!wait) { this.minute.take(); this.hour.take(); }
    return wait;
  }
}
export class SlotsFull extends Error { constructor() { super('external_slots_full'); } }
export class ProcessingExpired extends Error { constructor() { super('external_processing_expired'); } }
// 기한이 지난 대기 작업은 줄에서 빠진다. 슬롯은 작업이 실제로 끝나야 돌아오므로 busy가 DB에 남은 작업 수의 진짜 상한이다.
export class Slots {
  private busyCount = 0;
  private readonly waiting = new Set<() => void>();
  constructor(private readonly size: number, private readonly queue: number) {}
  get busy(): number { return this.busyCount; }
  get queued(): number { return this.waiting.size; }
  async run<T>(signal: AbortSignal, fn: () => Promise<T>): Promise<T> {
    signal.throwIfAborted();
    if (this.busyCount < this.size) this.busyCount++;
    else {
      if (this.waiting.size >= this.queue) throw new SlotsFull();
      await new Promise<void>((resolve, reject) => {
        const expire = () => { this.waiting.delete(grant); reject(signal.reason as Error); };
        const grant = () => { signal.removeEventListener('abort', expire); resolve(); };
        this.waiting.add(grant);
        signal.addEventListener('abort', expire, { once: true });
      });
    }
    try {
      // 슬롯을 넘겨받은 직후에 기한이 지났을 수 있다.
      signal.throwIfAborted();
      return await fn();
    } finally {
      const [next] = this.waiting;
      if (next) { this.waiting.delete(next); next(); } else this.busyCount--;
    }
  }
}
export interface ProcessingBudget { signal: AbortSignal; expiresAt: number }
const pad = (value: number) => String(value).padStart(2, '0');
// 서버 TZ와 무관하게 KST로 적는다. Asia/Seoul은 DST가 없다.
export function kstTime(ms: number): string {
  const kst = new Date(ms + 9 * 3_600_000);
  return `${kst.getUTCFullYear()}-${pad(kst.getUTCMonth() + 1)}-${pad(kst.getUTCDate())} ${pad(kst.getUTCHours())}:${pad(kst.getUTCMinutes())}:${pad(kst.getUTCSeconds())} KST`;
}
function delayText(ms: number): string {
  const seconds = Math.max(0, Math.round(ms / 1000));
  if (seconds < 60) return `${seconds}초`;
  const minutes = Math.floor(seconds / 60);
  return minutes < 60 ? `${minutes}분 ${seconds % 60}초` : `${Math.floor(minutes / 60)}시간 ${minutes % 60}분`;
}
// 게시자의 sendMessage 본문에는 flags 칸이 없다. 그래서 링크 미리보기는 내용 쪽에서 막는다. 사용자 값을 모두 코드 스팬에 넣으면
// Discord가 링크·마크다운·멘션으로 해석하지 않고, 이 밖에는 고정 문구와 시각뿐이다. 멘션은 게시자의 allowed_mentions.parse=[]가 한 번 더 막는다.
const codeSpan = (text: string) => `\`${text.replaceAll('`', "'")}\``;
export function formatNotice(input: { executor: string; externalTaskId: string; summary: string; occurredAt: number; receivedAt: number }): string {
  return [
    `사람 세션이 턴을 끝냈다고 알림 (${input.executor} ${codeSpan(input.externalTaskId)})`,
    `발생 ${kstTime(input.occurredAt)} · 수신 ${kstTime(input.receivedAt)} · 지연 ${delayText(input.receivedAt - input.occurredAt)}`,
    `요약: ${codeSpan(input.summary)}`,
    '봇이 결과를 확인한 것은 아닙니다.',
  ].join('\n');
}

export interface ExternalReceiverOptions {
  store: Store;
  links: Pick<ExternalTaskLinks, 'enforceRestoreFence'>;
  // PolicyGate.authorize와 같은 뜻이다. 거부면 Denied, 정책을 못 읽으면 PolicyUnavailable을 던진다.
  // db는 처리 기한이 걸린 트랜잭션이다. gate.withDatabase(db)로 넘겨야 DB가 느릴 때 이 조회도 기한 안에서 끊긴다.
  authorize: (owner: string, scope: Scope, db: Database) => Promise<{ revision: string }>;
  environment: string;
  log?: Log;
  limits?: Partial<ReceiverLimits>;
}
const headerText = (value: string | string[] | undefined): string | undefined => typeof value === 'string' ? value : undefined;

export class ExternalTaskReceiver {
  readonly limits: ReceiverLimits;
  private readonly store: Store;
  private readonly global: TokenBucket;
  private readonly perConnection = new Map<string, ConnectionLimit>();
  private readonly slots: Slots;
  private readonly counts = new Map<ExternalOutcome, number>(OUTCOMES.map(name => [name, 0]));
  private latencyMs = 0;
  private latencyCount = 0;
  private inFlight = 0;
  constructor(private readonly options: ExternalReceiverOptions) {
    if (!ENVIRONMENT_ID.test(options.environment)) throw new Error('external_environment_invalid');
    this.limits = Object.freeze({ ...RECEIVER_LIMITS, ...options.limits });
    this.store = options.store;
    this.global = new TokenBucket(this.limits.globalBurst, this.limits.globalPerSecond, this.store.now());
    this.slots = new Slots(this.limits.dbSlots, this.limits.dbQueue);
  }
  // 수신의 DB 단계마다 쓰는 기한이다. 각 단계는 transactionMs 안에서, 전체는 처리 기한 안에서 끝난다.
  private deadline(budget?: ProcessingBudget): TransactionDeadline {
    const expiresAt = this.store.now() + this.limits.transactionMs;
    return { expiresAt: budget ? Math.min(expiresAt, budget.expiresAt) : expiresAt, now: this.store.now };
  }
  count(outcome: ExternalOutcome): void { this.counts.set(outcome, (this.counts.get(outcome) ?? 0) + 1); }
  // 전용 포트에는 /metrics를 두지 않는다. 8080의 /metrics를 조립하는 쪽(B5)이 이 값을 덧붙인다.
  // 라벨은 고정 이름뿐이고 본문·인증 헤더·연결 ID는 넣지 않는다.
  async metrics(): Promise<string> {
    const { total } = await this.store.atomic(async store =>
      (await store.db.query<{ total: string }>("SELECT count(*)::text AS total FROM external_task_events WHERE post_state='pending'")).rows[0]!, this.deadline());
    return `${[
      ...OUTCOMES.map(name => `homelab_bot_external_task_requests{outcome="${name}"} ${this.counts.get(name) ?? 0}`),
      `homelab_bot_external_task_latency_seconds_sum ${this.latencyMs / 1000}`,
      `homelab_bot_external_task_latency_seconds_count ${this.latencyCount}`,
      `homelab_bot_external_task_in_flight ${this.inFlight}`,
      `homelab_bot_external_task_db_busy ${this.slots.busy}`,
      `homelab_bot_external_task_db_waiting ${this.slots.queued}`,
      `homelab_bot_external_task_unposted ${Number(total)}`,
    ].join('\n')}\n`;
  }
  private limited(outcome: ExternalOutcome, status: number, retryAfter: number): Reply { return { status, outcome, retryAfter: Math.max(1, Math.ceil(retryAfter)) }; }
  private connectionLimit(id: string, now: number): ConnectionLimit {
    let limit = this.perConnection.get(id);
    if (!limit) {
      // 검증된 연결만 여기 들어와 크기가 활성 연결 수로 묶인다. 그래도 오래 도는 프로세스에서 쌓이지 않게 다 찬 버킷을 비운다.
      if (this.perConnection.size >= 1024) {
        for (const [key, value] of this.perConnection) {
          value.minute.wait(now); value.hour.wait(now);
          if (value.minute.full && value.hour.full) this.perConnection.delete(key);
        }
      }
      limit = new ConnectionLimit(this.limits, now);
      this.perConnection.set(id, limit);
    }
    return limit;
  }
  // HTTP와 무관한 판정. 서명 뒤에만 연결별 제한·본문 파싱을 해서, 남의 connection_id로 그 연결의 quota를 깎을 수 없다.
  // budget이 지나면 다음 DB 단계로 가지 않는다. 이미 503을 받은 요청이 DB를 더 쓰거나 뒤늦게 저장되지 않게 한다.
  async receive(headers: Record<string, string | string[] | undefined>, raw: Buffer, budget?: ProcessingBudget): Promise<Reply> {
    const connectionId = headerText(headers['x-r08-connection-id']);
    const keyId = headerText(headers['x-r08-key-id']);
    const sentAt = headerText(headers['x-r08-sent-at']);
    const signature = headerText(headers['x-r08-signature']);
    if (!connectionId || !UUID.test(connectionId) || !keyId || !KEY_ID.test(keyId) || !sentAt || !SENT_AT.test(sentAt) || !signature || !SIGNATURE.test(signature)) {
      return { status: 400, outcome: 'bad_headers' };
    }
    const now = this.store.now();
    if (Math.abs(now - Number(sentAt)) > this.limits.sentAtSkewMs) return { status: 422, outcome: 'clock_skew' };
    await this.options.links.enforceRestoreFence(this.deadline(budget));
    budget?.signal.throwIfAborted();
    const found = await this.store.atomic(async store =>
      (await store.db.query<ExternalConnection>('SELECT * FROM external_task_connections WHERE id=$1', [connectionId])).rows[0], this.deadline(budget));
    budget?.signal.throwIfAborted();
    const row = found ? connectionRow(found) : undefined;
    const bodySha256 = sha256Hex(raw);
    const input = signatureInput({ environment: this.options.environment, method: 'POST', path: EXTERNAL_TASK_PATH, connectionId, keyId, sentAt, bodySha256 });
    let key: KeyObject = DUMMY_KEY;
    if (row) key = createPublicKey({ key: { kty: 'OKP', crv: 'Ed25519', x: row.public_key }, format: 'jwk' });
    const valid = verify(null, input, key, Buffer.from(signature, 'base64url'));
    if (!row || !valid || row.key_id !== keyId || row.revoked_at !== null || row.expires_at <= now) return { status: 401, outcome: 'unauthorized' };

    const wait = this.connectionLimit(connectionId, now).admit(now);
    if (wait) return this.limited('rate_limited_connection', 429, wait);

    const event = this.parse(raw);
    if (!event || event.connection_id !== connectionId) return { status: 400, outcome: 'invalid_body' };
    if (event.occurred_at > now + this.limits.occurredFutureMs || event.occurred_at < now - this.limits.occurredPastMs) return { status: 422, outcome: 'occurred_at_window' };
    if (event.external_task_id !== row.external_task_id) return { status: 403, outcome: 'external_task_mismatch' };
    if ([...event.summary].length > this.limits.summaryCodePoints || Buffer.byteLength(event.summary, 'utf8') > this.limits.summaryBytes
      || CONTROL.test(event.summary)) return { status: 422, outcome: 'summary_rejected' };
    if (event.summary !== FIXED_SUMMARY) {
      if (!row.summary_consent) return { status: 403, outcome: 'summary_consent_required' };
      if (suspectSummary(event.summary)) return { status: 422, outcome: 'summary_rejected' };
    }
    let revision: string;
    try {
      revision = (await this.store.atomic(store => this.options.authorize(row.owner_id, row.scope, store.db), this.deadline(budget))).revision;
    } catch (error) {
      if (error instanceof Denied) return { status: 403, outcome: 'scope_denied' };
      if (error instanceof PolicyUnavailable) return this.limited('unavailable', 503, 30);
      throw error;
    }
    budget?.signal.throwIfAborted();
    return this.store.atomic(store => this.accept(store, row, event, bodySha256, revision), this.deadline(budget));
  }
  private parse(raw: Buffer): z.infer<typeof EventSchema> | undefined {
    try {
      // fatal: 잘못된 UTF-8을 U+FFFD로 바꿔 삼키지 않는다.
      const text = new TextDecoder('utf-8', { fatal: true }).decode(raw);
      const parsed = EventSchema.safeParse(JSON.parse(text));
      return parsed.success ? parsed.data : undefined;
    } catch { return undefined; }
  }
  // 수락과 outbox 생성을 한 트랜잭션으로 한다. 연결 행을 잠가 폐기·재발급·동의 변경과 직렬화한다. 잠근 뒤 상태와 시각을 다시 본다.
  // FOR NO KEY UPDATE: 그쪽의 FOR UPDATE와는 부딪히고, 게시 행을 잡을 때의 KEY SHARE와는 부딪히지 않아 수신이 게시를 미루지 않는다.
  private async accept(store: Store, seen: ExternalConnection, event: z.infer<typeof EventSchema>, bodySha256: string, revision: string): Promise<Reply> {
    const locked = (await store.db.query<ExternalConnection>('SELECT * FROM external_task_connections WHERE id=$1 FOR NO KEY UPDATE', [seen.id])).rows[0];
    const now = store.now();
    const row = locked ? connectionRow(locked) : undefined;
    if (!row || row.key_id !== seen.key_id || row.revoked_at !== null || row.expires_at <= now) return { status: 401, outcome: 'unauthorized' };
    const existing = (await store.db.query<{ body_sha256: string }>('SELECT body_sha256 FROM external_task_events WHERE connection_id=$1 AND event_id=$2',
      [row.id, event.event_id])).rows[0];
    if (existing) return existing.body_sha256 === bodySha256 ? { status: 202, outcome: 'duplicate' } : { status: 409, outcome: 'event_conflict' };
    if (event.summary !== FIXED_SUMMARY && !row.summary_consent) return { status: 403, outcome: 'summary_consent_required' };
    const conversation = (await store.db.query<{ owner_id: string; active: boolean }>('SELECT owner_id,active FROM conversations WHERE id=$1 FOR KEY SHARE', [row.conversation_id])).rows[0];
    if (!conversation || conversation.owner_id !== row.owner_id || !conversation.active) return { status: 403, outcome: 'scope_denied' };
    // 전체 상한은 서로 다른 연결끼리 경합하므로 세기와 삽입을 하나로 묶는다. 연결 행 다음에 잡으므로 이 순서만 지키면 교착이 없다.
    await store.db.query("SELECT pg_advisory_xact_lock(hashtext('external_task_unposted'))");
    const counts = (await store.db.query<{ mine: string; total: string }>(`SELECT count(*) FILTER (WHERE connection_id=$1)::text AS mine, count(*)::text AS total
      FROM external_task_events WHERE post_state='pending'`, [row.id])).rows[0]!;
    if (Number(counts.total) >= this.limits.unpostedTotal) return this.limited('backlog_total', 503, 30);
    if (Number(counts.mine) >= this.limits.unpostedPerConnection) return this.limited('backlog_connection', 429, 30);
    const key = outboxKey(row.id, event.event_id);
    await store.db.query(`INSERT INTO external_task_events(connection_id,event_id,body_sha256,accepted_key_id,occurred_at,received_at,outbox_key)
      VALUES ($1,$2,$3,$4,$5,$6,$7)`, [row.id, event.event_id, bodySha256, row.key_id, event.occurred_at, now, key]);
    await store.enqueue({ key, conversation: row.conversation_id, actor: row.owner_id, scope: row.scope, revision,
      payload: { kind: 'message', channel: row.scope.channel, classification: 'safe_summary',
        content: formatNotice({ executor: row.executor, externalTaskId: row.external_task_id, summary: event.summary, occurredAt: event.occurred_at, receivedAt: now }) } });
    await store.db.query('UPDATE external_task_connections SET last_event_at=$2 WHERE id=$1', [row.id, now]);
    return { status: 202, outcome: 'accepted' };
  }
  // 모든 응답이 connection: close라 Node가 응답 뒤 소켓을 닫는다. 다 읽지 않은 본문이 남은 소켓도 여기서 끝난다.
  private send(res: ServerResponse, reply: Reply, started: number): void {
    this.count(reply.outcome);
    this.latencyMs += Math.max(0, this.store.now() - started);
    this.latencyCount++;
    if (res.headersSent || res.destroyed) return;
    const headers: Record<string, string> = { 'content-type': 'application/json', connection: 'close' };
    if (reply.retryAfter) headers['retry-after'] = String(reply.retryAfter);
    if (reply.status === 405) headers.allow = 'POST';
    res.writeHead(reply.status, headers);
    res.end(JSON.stringify(replyBody(reply)));
  }
  async handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const started = this.store.now();
    const wait = this.global.wait(started);
    if (wait) { this.send(res, this.limited('rate_limited_global', 429, wait), started); return; }
    this.global.take();
    if (this.inFlight >= this.limits.concurrent) { this.send(res, this.limited('overloaded', 503, 1), started); return; }
    this.inFlight++;
    res.once('close', () => { this.inFlight--; });
    // req.url은 정규화되지 않은 원문이다. 완전 일치만 받아 query·후행 slash·하위 경로·인코딩 변형·absolute-form을 함께 걸러낸다.
    if (req.url !== EXTERNAL_TASK_PATH) { this.send(res, { status: 404, outcome: 'not_found' }, started); return; }
    if (req.method !== 'POST') { this.send(res, { status: 405, outcome: 'method_not_allowed' }, started); return; }
    const contentType = headerText(req.headers['content-type'])?.toLowerCase();
    const encoding = req.headers['transfer-encoding'];
    if (req.headers['content-encoding'] !== undefined || (encoding !== undefined && encoding.toLowerCase() !== 'chunked')
      || (contentType !== 'application/json' && contentType !== 'application/json; charset=utf-8')) {
      this.send(res, { status: 415, outcome: 'unsupported_media' }, started);
      return;
    }
    const declared = req.headers['content-length'];
    if (declared !== undefined && Number(declared) > this.limits.bodyBytes) {
      this.send(res, this.limited('body_too_large', 413, 60), started);
      return;
    }
    const body = await this.read(req);
    if (body === 'aborted') { this.count('aborted'); return; }
    if (body === 'too_large') { this.send(res, this.limited('body_too_large', 413, 60), started); return; }
    if (body === 'timeout') { this.send(res, { status: 408, outcome: 'body_timeout' }, started); return; }
    this.send(res, await this.settled(req, body), started);
  }
  // 실패 원인이 무엇이든 본문이나 헤더 값을 응답·로그에 싣지 않는다.
  private async settled(req: IncomingMessage, body: Buffer): Promise<Reply> {
    const expired = this.limited('unavailable', 503, 5);
    const controller = new AbortController();
    const budget: ProcessingBudget = { signal: controller.signal, expiresAt: this.store.now() + this.limits.processingTimeoutMs };
    const timeout = new Promise<Reply>(resolve => { controller.signal.addEventListener('abort', () => resolve(expired), { once: true }); });
    const timer = setTimeout(() => controller.abort(new ProcessingExpired()), this.limits.processingTimeoutMs);
    try {
      return await Promise.race([timeout, this.slots.run(controller.signal, () => this.receive(req.headers, body, budget)).catch(error => {
        if (error instanceof SlotsFull) return this.limited('overloaded', 503, 5);
        if (error instanceof ProcessingExpired) return expired;
        this.options.log?.('external_task_error', errorInfo(error));
        return expired;
      })]);
    } finally { clearTimeout(timer); }
  }
  // 선언한 길이가 아니라 실제로 받은 바이트로 센다. chunked에는 선언이 없다.
  private read(req: IncomingMessage): Promise<Buffer | 'too_large' | 'timeout' | 'aborted'> {
    return new Promise(resolve => {
      const chunks: Buffer[] = [];
      let size = 0;
      let finished = false;
      const done = (value: Buffer | 'too_large' | 'timeout' | 'aborted') => {
        if (finished) return;
        finished = true;
        clearTimeout(timer);
        req.removeListener('data', onData);
        req.removeListener('end', onEnd);
        req.removeListener('error', onAbort);
        req.removeListener('close', onClose);
        resolve(value);
      };
      const timer = setTimeout(() => done('timeout'), this.limits.bodyTimeoutMs);
      const onData = (chunk: Buffer) => {
        size += chunk.length;
        if (size > this.limits.bodyBytes) { chunks.length = 0; done('too_large'); return; }
        chunks.push(chunk);
      };
      const onEnd = () => done(Buffer.concat(chunks));
      const onAbort = () => done('aborted');
      const onClose = () => { if (!req.complete) done('aborted'); };
      req.on('data', onData);
      req.once('end', onEnd);
      req.once('error', onAbort);
      req.once('close', onClose);
    });
  }
}

// 전용 포트용 HTTP 서버. listen은 조립하는 쪽(B5)이 한다. 이 서버에는 다른 경로가 없다.
// connectionsCheckingInterval: Node 기본 30초면 5초 시간 제한이 그만큼 늦게 걸린다.
export function externalTaskServer(receiver: ExternalTaskReceiver): Server {
  const { limits } = receiver;
  const server = createServer({ maxHeaderSize: limits.headerBytes, connectionsCheckingInterval: 1000 }, (req, res) => {
    void receiver.handle(req, res).catch(() => { if (!res.headersSent) res.writeHead(503, { connection: 'close' }); res.end(); });
  });
  server.headersTimeout = limits.headerTimeoutMs;
  // 헤더+본문 전체의 바깥 상한이다. 본문 제한은 handle 안의 타이머가 먼저 건다.
  server.requestTimeout = limits.headerTimeoutMs + limits.bodyTimeoutMs;
  server.keepAliveTimeout = 1000;
  // 헤더를 천천히 보내는 소켓은 handle에 들어오기 전이라 동시 처리 수로 묶이지 않는다. 소켓 수로 묶는다.
  server.maxConnections = limits.maxConnections;
  server.on('clientError', (error: NodeJS.ErrnoException, socket: Duplex) => {
    const reply: Reply = error.code === 'HPE_HEADER_OVERFLOW' ? { status: 431, outcome: 'header_too_large' }
      : error.code === 'ERR_HTTP_REQUEST_TIMEOUT' ? { status: 408, outcome: 'header_timeout' }
        : { status: 400, outcome: 'malformed_http' };
    receiver.count(reply.outcome);
    // http 서버 소켓은 half-open을 허용한다. end만 하면 상대가 FIN을 보내지 않는 동안 maxConnections 자리를 계속 차지한다.
    if (socket.writable) socket.end(`HTTP/1.1 ${reply.status} ${reply.outcome}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`, () => socket.destroy());
    else socket.destroy();
  });
  return server;
}
