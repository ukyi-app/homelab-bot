import { z } from 'zod';
import { Denied } from './contracts.js';
import type { Scope } from './contracts.js';
import { errorInfo } from './log.js';
import type { Log } from './log.js';
import type { PolicyGate } from './policy.js';
import type { Store } from './store.js';

// owner가 입력 중이면(Gateway TYPING_START) 아직 실행하지 않은 일반 chat을 조금 더 기다리게 한다(개선안 v2 2-3).
// 한 요청을 여러 메시지로 나눠 보낼 때 첫 메시지만 보고 답하기 시작하지 않게 하려는 힌트다. 실행 허가가 아니다.
// Discord는 "입력 끝" 이벤트를 주지 않는다. 클라이언트가 입력하는 동안 몇 초마다 다시 보내므로 한 번에 8초만 미룬다.
export const TYPING_HOLD_MS = 8000;
// 작업 생성 시각부터의 상한. 새 메시지가 오면 기존 대체 로직이 앞 작업을 superseded로 바꾸고 새 작업의 상한이 다시 시작된다.
// 그래서 owner가 계속 메시지를 보내는 동안에만 늘어나고, 입력만 하고 보내지 않으면 마지막 메시지 기준 15초에 실행된다.
export const TYPING_MAX_WAIT_MS = 15_000;
// 재연결 뒤 늦게 도착한 오래된 힌트는 버린다.
export const TYPING_FRESH_MS = 10_000;
const TypingStart = z.object({ channel_id: z.string().min(1), guild_id: z.string().min(1).optional(),
  user_id: z.string().min(1), timestamp: z.number().int().nonnegative() });

// 처리 전체(연결 대기 뒤 질의·잠금 대기·COMMIT)의 기한. 넘으면 힌트를 버린다. 힌트는 잃어도 되고, 오래 붙잡으면
// 연결 풀과 job 행 잠금을 claim·accept와 다투기만 한다.
export const TYPING_BUDGET_MS = 1500;
const ChannelOnly = z.object({ channel_id: z.string().min(1) });

// Gateway dispatch용 진입점. 기다리지 않고 바로 돌아온다. Gateway는 앞 dispatch가 끝나야 다음 것을 처리하므로,
// 힌트의 DB 왕복을 기다리면 뒤의 MESSAGE_CREATE·INTERACTION_CREATE(3초 응답 기한)가 밀린다.
// 처리는 track(종료 때 stop()이 기다리는 백그라운드 집합)에 넣고, 같은 채널 힌트가 처리 중이면 새 힌트는 버린다(합치기).
// 클라이언트가 입력하는 동안 몇 초마다 다시 보내므로 하나를 버려도 다음 힌트가 이어 받는다.
export function typingHints(store: Store, gate: PolicyGate, log: Log, track: (task: Promise<void>) => void,
  budgetMs = TYPING_BUDGET_MS): (raw: unknown) => void {
  const busy = new Set<string>();
  return raw => {
    const receivedAt = store.now();
    const input = ChannelOnly.safeParse(raw);
    if (!input.success || busy.has(input.data.channel_id)) return;
    const channel = input.data.channel_id;
    busy.add(channel);
    track(typingStart(store, gate, raw, log, { receivedAt, budgetMs }).then(() => {}, () => {})
      .finally(() => busy.delete(channel)));
  };
}

// 미룬 작업 수를 돌려준다. 어떤 오류도 밖으로 던지지 않는다. typing은 잃어도 되는 힌트라 호출자가 history gap 장벽(guard)을
// 세우면 안 된다(메시지 checkpoint와 무관하다). 무시한 경우는 로그를 남기지 않는다(입력할 때마다 오는 이벤트라 소음이다).
// receivedAt은 Gateway에서 받은 시각이다. 처리가 늦게 끝나도 그 시각 기준으로만 판단한다.
export async function typingStart(store: Store, gate: PolicyGate, raw: unknown, log: Log,
  options: { receivedAt?: number; budgetMs?: number } = {}): Promise<number> {
  const expiresAt = Date.now() + (options.budgetMs ?? TYPING_BUDGET_MS);
  try {
    const input = TypingStart.safeParse(raw);
    if (!input.success) return 0;
    const { channel_id: channel, guild_id: guild, user_id: user, timestamp } = input.data;
    const receivedAt = options.receivedAt ?? store.now();
    if (receivedAt - timestamp * 1000 > TYPING_FRESH_MS) return 0;
    // DB에 닿기 전에 값싼 검사부터. DM(guild 없음)은 정책 guild가 아니므로 여기서 끝난다.
    const policy = await gate.current();
    if (user !== policy.owner || guild !== policy.guild) return 0;
    // 기한은 실제 시간이다(store.now는 시험에서 멈춘 시계일 수 있다). 트랜잭션에 statement·transaction·lock timeout이 걸리고
    // 각 질의 전후로 남은 시간을 확인하므로, 연결을 늦게 얻었으면 질의 없이 끝난다.
    return await store.atomic(async tx => {
      const conversation = (await tx.db.query<{ scope: Scope }>(`SELECT scope FROM conversations
        WHERE channel_id=$1 AND owner_id=$2 AND active=true AND gap=false`, [channel, user])).rows[0];
      if (!conversation || conversation.scope.guild !== guild) return 0;
      // 메시지 수신과 같은 권한 판단(부모 채널·철회 목록)을 같은 트랜잭션·기한 안에서 쓴다.
      try { await gate.withDatabase(tx.db).authorize(user, conversation.scope); }
      catch (error) { if (error instanceof Denied) return 0; throw error; }
      // 한 UPDATE로 다시 확인한다(state='queued' CAS). claim이 먼저 잡았으면 행 잠금을 기다린 뒤 조건이 깨져 건너뛰고,
      // 이 UPDATE가 먼저면 claim의 SKIP LOCKED가 건너뛴다. 늦추기만 하고 앞당기지 않는다.
      // created_at<=receivedAt: 힌트 뒤에 도착한 메시지가 만든 작업은 그 입력의 결과라 이 힌트로 늘리지 않는다.
      // 처리가 늦게 끝나 뒤 메시지의 작업이 이미 생겼어도 늘리지 않게 하는 조건이다.
      const changed = await tx.db.query(`UPDATE jobs j
        SET available_at=LEAST(GREATEST(j.available_at,$3::bigint),j.created_at+$4::bigint)
        FROM conversations c
        WHERE c.id=j.conversation_id AND c.channel_id=$1 AND c.owner_id=$2 AND c.active=true AND c.gap=false
          AND j.owner_id=$2 AND j.type='chat' AND j.state='queued' AND j.priority<>0 AND j.created_at<=$5::bigint
          AND j.available_at<LEAST($3::bigint,j.created_at+$4::bigint)
        RETURNING j.id`, [channel, user, receivedAt + TYPING_HOLD_MS, TYPING_MAX_WAIT_MS, receivedAt]);
      return changed.rows.length;
    }, { expiresAt, now: Date.now });
  } catch (error) {
    log(error instanceof Error && error.message === 'inbox_deadline' ? 'typing_hint_expired' : 'typing_hint_failed', errorInfo(error));
    return 0;
  }
}
