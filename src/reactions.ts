import { DiscordRejected, DiscordUnauthorized, RateLimited } from './contracts.js';
import type { Database } from './database.js';
import type { DiscordRest } from './discord.js';
import { errorInfo, jsonLog } from './log.js';
import type { Log } from './log.js';
import type { Store } from './store.js';

// owner 메시지 하나에 봇이 달아 두는 반응. 상태마다 붙어 있어야 할 봇 반응 전체를 적는다.
// 상태를 더할 때(👍 C11, 💤 C20)는 이 표와 아래 FROM에 이름만 더한다. 동기화는 지금 붙은 것과 비교해 필요한 것만 더하고 지운다.
export const REACTIONS = {
  received: ['👀'],
  waiting: ['👀', '⏳'],
  cleared: [],
  failed: [],
} as const satisfies Record<string, readonly string[]>;
export type ReactionState = keyof typeof REACTIONS;
// 이 상태로 옮길 수 있는 앞 상태. 끝 상태(답 게시·실패 확정)에서는 다시 바뀌지 않는다.
const FROM: Record<ReactionState, readonly ReactionState[]> = {
  received: [],
  waiting: ['received'],
  cleared: ['received', 'waiting'],
  failed: ['received', 'waiting'],
};
const TERMINAL: readonly ReactionState[] = ['cleared', 'failed'];
// 반응 행은 마이그레이션 없이 controls(`reaction:<event id>`)에 둔다. 끝 상태까지 동기화하면 지운다.
const KEY = 'reaction:';
// 동기화 한 바퀴가 행을 쥐는 시간. 다른 게시 서버가 같은 행을 동시에 바꾸지 않게 한다.
const LEASE_MS = 30_000;
// 일시 오류(시간 초과·5xx)는 이 횟수까지 다시 시도하고, 그 뒤에는 감사만 남기고 놓는다(잃어도 되는 표시).
export const REACTION_ATTEMPTS = 5;
const RETRY_MAX_MS = 60_000;

// applied: 붙었다고 확인한 봇 반응. maybe: 더하기 결과를 모르는(시간 초과·응답 유실) 반응이다. 붙었을 수 있으니
// 원하는 상태에서 빠지면 지운다(없는 반응을 지우면 404라 무해하다). 이 필드가 없는 예전 행은 빈 목록으로 읽는다.
interface Row {
  channel: string; message: string; owner: string; state: ReactionState; synced: ReactionState;
  applied: string[]; maybe?: string[]; next: number; attempt: number;
}

// 수신 ACK(👀)를 보낼 일반 메시지. 수신 트랜잭션 안에서 부른다. 👀는 이 직후 dispatch 안에서 단다(protocol.acknowledge).
// 붙었다고 보고 적는다. 실패했어도 나중에 지우는 DELETE는 결과가 같다.
export async function recordReceived(db: Database, event: { id: string; channel: string; message: string; owner: string }): Promise<void> {
  const row: Row = { channel: event.channel, message: event.message, owner: event.owner, state: 'received', synced: 'received',
    applied: [...REACTIONS.received], next: 0, attempt: 0 };
  await db.query('INSERT INTO controls VALUES ($1,$2) ON CONFLICT DO NOTHING', [KEY + event.id, JSON.stringify(row)]);
}

// 반응 상태를 바꾼다(저장만, REST는 동기화가 한다). 호출자의 트랜잭션 안에서 상태 전이와 함께 쓴다.
export async function moveReactions(db: Database, events: readonly string[], to: ReactionState): Promise<void> {
  if (!events.length) return;
  await db.query(`UPDATE controls SET value=jsonb_set(value,'{state}',to_jsonb($2::text))
    WHERE key=ANY($1) AND value->>'state'=ANY($3)`, [events.map(id => KEY + id), to, FROM[to]]);
}

// 작업이 끝났을 때(답 게시 확정·실패 확정) 그 메시지와, 같은 대화에서 그보다 먼저 받은 메시지 중 처리 중인 작업이 없는 것의 반응을 정리한다.
// 밀려난(superseded) 앞 메시지는 이 답의 맥락에 들어 있어 따로 답하지 않으므로 같이 지운다. 앞 메시지가 제 답을 냈는데
// 그 답이 아직 게시 확정 전(pending·sending·unknown)이면 남긴다. 그 답의 마지막 쪽이 sent가 될 때 자기 정리가 지운다.
export async function settleReactions(db: Database, job: string, to: 'cleared' | 'failed'): Promise<void> {
  const events = (await db.query<{ id: string }>(`SELECT e.id FROM jobs j JOIN events target ON target.id=j.event_id
    JOIN events e ON e.conversation_id=target.conversation_id AND e.event_order<=target.event_order
    WHERE j.id=$1 AND EXISTS (SELECT 1 FROM jobs mine WHERE mine.event_id=e.id)
    AND NOT EXISTS (SELECT 1 FROM jobs other WHERE other.event_id=e.id AND other.id<>$1
      AND (other.state IN ('queued','running','verifying','cancel_requested','waiting_user','unknown')
        OR (other.state='succeeded' AND EXISTS (SELECT 1 FROM outbox o WHERE o.message_key='result:'||other.id
          AND o.state IN ('pending','sending','unknown')))))`, [job])).rows;
  await moveReactions(db, events.map(e => e.id), to);
}

// 저장된 반응 상태를 Discord에 맞춘다. 게시 루프가 부르고, 재시작 뒤에도 남은 행을 이어서 맞춘다.
// 반응 오류는 감사·rate limit 기록만 남기고 던지지 않는다. 게시·작업 상태를 바꾸지 않는다.
export class ReactionSync {
  constructor(private readonly store: Store, private readonly rest: DiscordRest, private readonly log: Log = jsonLog) {}
  async sync(limit = 10): Promise<boolean> {
    await this.store.refreshWaiting();
    const now = this.store.now();
    const rows = await this.store.atomic(async store => {
      // 실행기는 WHERE 조건 순서를 보장하지 않는다. 다른 키의 값을 bigint로 바꾸지 않게 형 변환은 CASE 안에서만 한다.
      const due = (await store.db.query<{ key: string; value: Row }>(`SELECT key,value FROM controls WHERE key LIKE 'reaction:%'
        AND value->>'state'<>value->>'synced'
        AND CASE WHEN key LIKE 'reaction:%' AND jsonb_typeof(value->'next')='number' THEN (value->>'next')::bigint<=$1 ELSE false END
        ORDER BY key FOR UPDATE SKIP LOCKED LIMIT $2`, [now, limit])).rows;
      for (const row of due) await store.db.query(`UPDATE controls SET value=jsonb_set(value,'{next}',to_jsonb($2::bigint)) WHERE key=$1`, [row.key, now + LEASE_MS]);
      return due;
    });
    for (const row of rows) {
      try { await this.apply(row.key, row.value); }
      catch (error) { this.log('reaction_sync_failed', errorInfo(error)); }
    }
    return rows.length > 0;
  }
  private async apply(key: string, row: Row): Promise<void> {
    const want: readonly string[] = REACTIONS[row.state] ?? [];
    const have = new Set(row.applied);
    const maybe = new Set(row.maybe ?? []);
    const pause = await this.store.discordPauseUntil(row.channel);
    if (pause > this.store.now()) return this.finish(key, have, maybe, row.synced, pause, row.attempt);
    // 철회된 owner의 메시지에는 새 반응을 달지 않는다. 지우기는 봇 자신의 표시를 거두는 것이라 그대로 한다.
    const revoked = (await this.store.db.query('SELECT 1 FROM denied_actors WHERE actor_id=$1', [row.owner])).rows.length > 0;
    const ops: { op: 'add' | 'remove'; emoji: string }[] = [
      ...(revoked ? [] : want.filter(emoji => !have.has(emoji)).map(emoji => ({ op: 'add' as const, emoji }))),
      ...[...new Set([...have, ...maybe])].filter(emoji => !want.includes(emoji)).map(emoji => ({ op: 'remove' as const, emoji })),
    ];
    const gone = (emoji: string) => { have.delete(emoji); maybe.delete(emoji); };
    for (const { op, emoji } of ops) {
      try {
        if (op === 'add') { await this.rest.addReaction(row.channel, row.message, emoji); have.add(emoji); maybe.delete(emoji); }
        else { await this.rest.removeOwnReaction(row.channel, row.message, emoji); gone(emoji); }
      } catch (error) {
        if (error instanceof DiscordRejected) {
          // 403/404(권한 없음·원문 삭제)는 대체 글 없이 감사만 남기고 이 반응은 놓는다. 대체 글은 수신 👀에만 있다.
          if (op === 'remove') gone(emoji);
          await this.store.audit('reaction_rejected', key.slice(KEY.length), { op, emoji, status: error.status });
          continue;
        }
        if (error instanceof RateLimited) {
          await this.store.recordRateLimit(error, row.channel);
          return this.finish(key, have, maybe, row.synced, this.store.now() + Math.max(1000, error.retryAfterMs), row.attempt);
        }
        if (error instanceof DiscordUnauthorized) return this.finish(key, have, maybe, row.synced, this.store.now() + RETRY_MAX_MS, row.attempt);
        // 시간 초과·5xx·연결 오류의 더하기는 Discord가 처리했을 수 있다. 끝 상태에서 지우도록 남긴다.
        if (op === 'add') maybe.add(emoji);
        const attempt = row.attempt + 1;
        if (attempt < REACTION_ATTEMPTS) {
          return this.finish(key, have, maybe, row.synced, this.store.now() + Math.min(RETRY_MAX_MS, 1000 * 2 ** (attempt - 1)), attempt);
        }
        await this.store.audit('reaction_abandoned', key.slice(KEY.length), { op, emoji, attempts: attempt });
        if (op === 'remove') gone(emoji);
      }
    }
    return this.finish(key, have, maybe, row.state, 0, 0);
  }
  // 상태(state)는 건드리지 않는다. 그 사이 바뀌었으면 synced와 달라 다음 바퀴가 다시 맞춘다.
  private async finish(key: string, have: Set<string>, maybe: Set<string>, synced: ReactionState, next: number, attempt: number): Promise<void> {
    await this.store.atomic(async store => {
      await store.db.query(`UPDATE controls SET value=value || jsonb_build_object('applied',$2::jsonb,'synced',$3::text,'next',$4::bigint,'attempt',$5::int,'maybe',$6::jsonb)
        WHERE key=$1`, [key, JSON.stringify([...have]), synced, next, attempt, JSON.stringify([...maybe])]);
      await store.db.query(`DELETE FROM controls WHERE key=$1 AND value->>'state'=value->>'synced' AND value->>'state'=ANY($2)`, [key, TERMINAL]);
    });
  }
}
