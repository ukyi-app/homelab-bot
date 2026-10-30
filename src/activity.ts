import { Denied, PolicyUnavailable, RateLimited } from './contracts.js';
import type { Scope } from './contracts.js';
import type { DiscordApi } from './discord-protocol.js';
import { errorInfo } from './log.js';
import type { Log } from './log.js';
import type { PolicyGate } from './policy.js';
import type { Store } from './store.js';

// 모델이 실제로 실행 중인(running) chat의 채널에 "입력 중" 표시를 보낸다(개선안 v2 2-2 진행 신호).
// Discord 표시 수명이 10초라 8초마다 갱신한다(8초는 제품 선택, API 강제값 아님). 끝나면(running 아님) 다음 주기부터 안 보낸다.
// 표시 갱신일 뿐이라 롤링 업데이트 중 구·신 게시 서버가 둘 다 보내도 해가 없다. 재시작 뒤 지난 신호를 재생하지 않는다.
export const TYPING_REFRESH_MS = 8000;
// 모델 슬롯이 하나라 보통 한 채널이다. 상한은 한 바퀴의 REST 시간(요청당 1초 제한)을 묶으려는 것.
const MAX_CHANNELS = 5;

// loop(name, step, false)에 넘길 한 바퀴. 늘 false(바쁘지 않음)를 돌려주고 어떤 오류도 던지지 않는다.
// 주기는 시도 시각 기준이라 실패해도 다음 주기까지 다시 보내지 않는다(빡빡한 재시도 금지).
export function typingActivity(store: Store, gate: PolicyGate, api: DiscordApi, log: Log,
  everyMs = TYPING_REFRESH_MS): () => Promise<boolean> {
  let last = -Infinity;
  return async () => {
    const now = store.now();
    if (now - last < everyMs) return false;
    last = now;
    let targets: { owner_id: string; target: Scope }[];
    try {
      // 구독이 꺼졌거나 gap인 대화에는 보내지 않는다(조사 2-2: 구독 해제·gap 때 갱신을 끊는다).
      targets = (await store.db.query<{ owner_id: string; target: Scope }>(`SELECT DISTINCT ON (j.target->>'channel') j.owner_id,j.target
        FROM jobs j JOIN conversations c ON c.id=j.conversation_id
        WHERE j.state='running' AND j.type='chat' AND c.active=true AND c.gap=false AND c.owner_id=j.owner_id
        ORDER BY j.target->>'channel',j.started_at LIMIT ${MAX_CHANNELS}`)).rows;
    } catch (error) { log('typing_activity_failed', errorInfo(error)); return false; }
    for (const { owner_id: owner, target } of targets) {
      try {
        if (await store.discordPauseUntil(target.channel) > store.now()) continue;
        await gate.authorize(owner, target);
        await api.request('POST', `/channels/${encodeURIComponent(target.channel)}/typing`);
      } catch (error) {
        // 권한 상실·정책 확인 불가는 보내지 않는 것이 정상 동작이다.
        if (error instanceof Denied || error instanceof PolicyUnavailable) continue;
        log('typing_signal_failed', errorInfo(error));
        if (error instanceof RateLimited) await store.recordRateLimit(error, target.channel).catch(() => {});
      }
    }
    return false;
  };
}
