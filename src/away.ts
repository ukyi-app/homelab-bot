import type { Database } from './database.js';
import type { PresenceStatus } from './gateway.js';

// 자리 비움(COLLEAGUE_SPEC §4.5, GLOSSARY "자리 비움"). 모델 멈춤 동안 Discord에 보이는 봇의 상태·💤·한 줄을 정한다.
// 멈춤인지는 C19 멈춤 기록(model_pauses)과 그 작업의 대기 상태에서 읽는다. 비상 정지는 모델 멈춤이 아니라 보지 않는다.
// 작업 레인 토큰의 인증 만료는 작업 레인만 막고(대화는 계속 답한다) scheduler도 켜지 않으므로 자리 비움이 아니다
// (Store.releaseScheduler와 같은 구분). 작업 레인만 막은 멈춤(멈춤 기록의 lane_only_at이 그 멈춤 시각, 한도 뒤 API 사용에서 다른 경로는
// API·구독으로 도는 동안의 작업 대기)도 자리 비움이 아니다.
const PAUSED = `SELECT 1 FROM model_pauses p JOIN jobs j ON j.id=p.job_id WHERE j.state='waiting_user'
  AND j.wait_reason IN ('model_limit','auth_expired') AND NOT (j.type='task' AND j.wait_reason='auth_expired')
  AND p.lane_only_at IS DISTINCT FROM p.paused_at LIMIT 1`;
// 회차 기록은 마이그레이션 없이 controls 한 행에 둔다. 자리 비움 한 줄의 멱등 키(away:<채널>:<회차>)가 이 회차를 쓴다.
const KEY = 'model_away';
// 멈춤 기록이 이만큼 비어 있어야 회차를 닫는다. 재개 예약 루프가 작업을 다시 돌리는 동안(멈춤 기록을 지우고 곧 다시 멈춤)
// 같은 멈춤이 새 회차가 되어 스레드마다 한 줄이 또 나가지 않게 한다. Gateway 상태는 이 유예 없이 지금 기록을 따른다.
export const AWAY_GRACE_MS = 5 * 60_000;
interface AwayRow { episode: number; active: boolean; clearSince: number | null }

export async function modelPaused(db: Database): Promise<boolean> {
  return (await db.query(PAUSED)).rows.length > 0;
}
export const presenceOf = (paused: boolean): PresenceStatus => paused ? 'idle' : 'online';
// 상태 루프 한 바퀴: 회차를 멈춤 기록에 맞추고 Gateway 상태를 그에 맞춘다(바뀐 때만 보낸다).
export async function showAway(store: { syncAway(): Promise<boolean> }, gateway: { setPresence(status: PresenceStatus): void }): Promise<void> {
  gateway.setPresence(presenceOf(await store.syncAway()));
}

// 회차를 지금 멈춤 기록에 맞춘다. 호출자의 트랜잭션 안에서, scheduler 행을 잠근 뒤에 부른다(잠금 순서 scheduler → model_away).
export async function syncAway(db: Database, now: number): Promise<{ paused: boolean; episode: number }> {
  await db.query(`INSERT INTO controls VALUES ($1,$2) ON CONFLICT DO NOTHING`, [KEY, JSON.stringify({ episode: 0, active: false, clearSince: null })]);
  const row = (await db.query<{ value: AwayRow }>('SELECT value FROM controls WHERE key=$1 FOR UPDATE', [KEY])).rows[0]!.value;
  const paused = await modelPaused(db);
  const next: AwayRow = paused
    ? { episode: row.active ? row.episode : row.episode + 1, active: true, clearSince: null }
    : !row.active ? row
      : row.clearSince !== null && now - row.clearSince >= AWAY_GRACE_MS ? { ...row, active: false, clearSince: null }
        : { ...row, clearSince: row.clearSince ?? now };
  if (JSON.stringify(next) !== JSON.stringify(row)) await db.query('UPDATE controls SET value=$2 WHERE key=$1', [KEY, JSON.stringify(next)]);
  return { paused, episode: next.episode };
}

// 자리 비움 한 줄의 멱등 키. 멈춤 중이면 스레드(채널)와 회차로 묶어 같은 멈춤 동안 같은 스레드에 한 번만 나간다.
// 자리 비움이 아닌 대기(작업 레인 인증 만료)는 호출자의 작업별 키를 그대로 쓴다.
export async function awayKey(db: Database, channel: string, fallback: string): Promise<string> {
  const row = (await db.query<{ value: AwayRow }>('SELECT value FROM controls WHERE key=$1', [KEY])).rows[0]?.value;
  return row?.active && await modelPaused(db) ? `away:${channel}:${row.episode}` : fallback;
}
