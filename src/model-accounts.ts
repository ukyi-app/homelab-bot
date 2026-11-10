import type { Database } from './database.js';
import type { Store } from './store.js';

// 봇 모델 계정 기록(COLLEAGUE_SPEC §4.8, migration 028). 값은 없다. owner가 `homelab bot account add·use`로만 바꾸고
// 봇은 스스로 바꾸지 않는다(D-14 조건 5). 토큰 값은 Infisical에 있고, 작업자 반영(지문 확인)은 homelab CLI가 끝낸 뒤 여기를 부른다.

// homelab CLI의 계정 이름 규칙과 같다(Infisical 폴더 이름 조각이자 지표 라벨 값이 된다). 길이 1~32.
export const ACCOUNT_NAME = /^[a-z]([a-z0-9-]{0,30}[a-z0-9])?$/;
export const ACCOUNT_METHODS = ['subscription', 'api'] as const;
export type AccountMethod = (typeof ACCOUNT_METHODS)[number];
const PAUSE_KINDS = ['rate_limit', 'auth_expired', 'billing'] as const;

export type AccountLimit = { status: string | null; rateLimitType: string | null; utilization: number | null; resetsAt: string | null; observedAt: string | null };
export type AccountView = { name: string; method: AccountMethod; current: boolean; issuedAt: string | null; expiresAt: string | null; limit: AccountLimit | null };
export type PausedCounts = Record<(typeof PAUSE_KINDS)[number], number>;

// 초 단위 UTC(…Z). CLI가 이 꼴만 받는다.
export const isoSeconds = (ms: number) => new Date(ms).toISOString().replace(/\.\d{3}Z$/, 'Z');
// 구독 장기 토큰은 발급 뒤 1년에 만료된다(D-14 "setup-token이 만드는 1년 토큰"). 달력으로 1년이다(2월 29일 발급은 3월 1일).
export function tokenExpiresAt(issuedAt: number): number {
  const expires = new Date(issuedAt);
  expires.setUTCFullYear(expires.getUTCFullYear() + 1);
  return expires.getTime();
}

type Row = { name: string; method: AccountMethod; issued_at: string | null; current: boolean;
  last_status: string | null; last_rate_limit_type: string | null; last_utilization: number | null; last_resets_at: string | null; last_observed_at: string | null };
const num = (value: string | number | null | undefined) => value === null || value === undefined ? null : Number(value);
const iso = (value: string | number | null | undefined) => { const ms = num(value); return ms === null ? null : isoSeconds(ms); };

// 구독 토큰(레인 둘)을 등록한 시각을 발급일로 둔다. 다시 등록하면(같은 계정의 토큰 교체) 발급일만 새로 한다. 지금 표시는 그대로다.
export async function recordAccount(db: Database, name: string, method: AccountMethod, now: number): Promise<void> {
  await db.query(`INSERT INTO model_accounts(name,method,issued_at,registered_at) VALUES ($1,$2,$3,$4)
    ON CONFLICT (name,method) DO UPDATE SET issued_at=EXCLUDED.issued_at`, [name, method, method === 'subscription' ? now : null, now]);
}

// 목록. 지금 계정의 한도 관측은 model_limit_state(C19)에서, 다른 계정은 그 계정에서 바꿀 때 옮겨 둔 값에서 읽는다.
export async function listAccounts(db: Database): Promise<{ accounts: AccountView[]; paused: PausedCounts }> {
  const rows = (await db.query<Row>('SELECT * FROM model_accounts ORDER BY name,method')).rows;
  const live = (await db.query<{ status: string | null; rate_limit_type: string | null; utilization: number | null; resets_at: string | null; observed_at: string | null }>(
    "SELECT status,rate_limit_type,utilization,resets_at,observed_at FROM model_limit_state WHERE id='account' AND observed_at IS NOT NULL")).rows[0];
  const accounts = rows.map((row): AccountView => {
    const issued = num(row.issued_at);
    const seen = row.current
      ? live && { status: live.status, rateLimitType: live.rate_limit_type, utilization: num(live.utilization), resetsAt: iso(live.resets_at), observedAt: iso(live.observed_at) }
      : row.last_observed_at !== null && { status: row.last_status, rateLimitType: row.last_rate_limit_type, utilization: num(row.last_utilization),
        resetsAt: iso(row.last_resets_at), observedAt: iso(row.last_observed_at) };
    return { name: row.name, method: row.method, current: row.current, issuedAt: issued === null ? null : isoSeconds(issued),
      expiresAt: issued === null || row.method !== 'subscription' ? null : isoSeconds(tokenExpiresAt(issued)), limit: seen || null };
  });
  return { accounts, paused: await pausedCounts(db) };
}

// 모델 멈춤으로 기다리는 작업 수(종류별). 결제 멈춤은 저절로 재개하지 않아 owner가 여기서 본다(C21 넘김).
async function pausedCounts(db: Database): Promise<PausedCounts> {
  const rows = (await db.query<{ kind: string; n: string }>(`SELECT COALESCE(p.kind, CASE WHEN j.wait_reason='auth_expired' THEN 'auth_expired' ELSE 'rate_limit' END) AS kind,
    count(*)::text AS n FROM jobs j LEFT JOIN model_pauses p ON p.job_id=j.id
    WHERE j.state='waiting_user' AND j.wait_reason IN ('model_limit','auth_expired') GROUP BY 1`)).rows;
  const counts = Object.fromEntries(PAUSE_KINDS.map(kind => [kind, 0])) as PausedCounts;
  for (const row of rows) if ((PAUSE_KINDS as readonly string[]).includes(row.kind)) counts[row.kind as keyof PausedCounts] = Number(row.n);
  return counts;
}

export type SwitchOutcome = { result: 'unknown_account' } | { result: 'switched'; resumed: number; waiting: number; held: 'emergency_stopped' | 'queue_full' | null };

// 계정 전환의 봇 쪽 끝(COLLEAGUE_SPEC §4.8 "계정 전환"). homelab CLI가 두 레인 자격을 작업자 키로 옮기고 작업자 볼륨 지문까지
// 확인한 뒤에만 부른다(반영 전 해제 금지는 CLI의 단계 순서가 지킨다). 한 트랜잭션(호출자의 Store.atomic) 안에서 돈다.
// - 지금 표시를 그 계정·방식으로 옮긴다. 계정이 바뀌면 지금 한도 관측(model_limit_state, 리뷰 미루기 기한 포함)은 옛 계정 행으로
//   옮기고 비운다. 새 계정의 한도는 아직 모른다.
// - 모델 멈춤으로 기다리는 작업을 모두 같은 해제 전이(Store.resumeWaiting)로 다시 큐에 넣는다. 결제 멈춤도 넣는다(재시도 시각이
//   없어 예약 루프가 고르지 않는 멈춤이라, 계정을 바꾼 owner의 해제가 유일한 길이다). 같은 계정으로 다시 부르면 해제만 한다.
// - 비상 정지 중이면 해제하지 않는다. 큐가 차면 거기서 멈추고, 남은 한도·인증 대기는 예약 루프가 30분 안에 다시 본다.
export async function switchAccount(store: Store, name: string, method: AccountMethod, actor: string, conversation: string): Promise<SwitchOutcome> {
  const db = store.db;
  const target = (await db.query<{ current: boolean }>('SELECT current FROM model_accounts WHERE name=$1 AND method=$2 FOR UPDATE', [name, method])).rows[0];
  if (!target) return { result: 'unknown_account' };
  if (!target.current) {
    await db.query(`UPDATE model_accounts a SET last_status=s.status,last_rate_limit_type=s.rate_limit_type,last_utilization=s.utilization,
      last_resets_at=s.resets_at,last_observed_at=s.observed_at FROM model_limit_state s WHERE a.current AND s.id='account' AND s.observed_at IS NOT NULL`);
    await db.query("DELETE FROM model_limit_state WHERE id='account'");
    await db.query('UPDATE model_accounts SET current=false WHERE current');
    await db.query('UPDATE model_accounts SET current=true WHERE name=$1 AND method=$2', [name, method]);
  }
  await store.lockScheduler();
  const emergency = (await db.query<{ value: boolean }>("SELECT value FROM controls WHERE key='scheduler_emergency'")).rows[0]?.value === true;
  const waiting = (await db.query<{ id: string; type: string }>(`SELECT id,type FROM jobs WHERE state='waiting_user'
    AND wait_reason IN ('model_limit','auth_expired') ORDER BY created_at,id`)).rows;
  if (emergency) return { result: 'switched', resumed: 0, waiting: waiting.length, held: 'emergency_stopped' };
  let resumed = 0;
  for (const job of waiting) {
    if (await store.queueFull(job.type === 'review' ? 'review' : 'chat'))
      return { result: 'switched', resumed, waiting: waiting.length - resumed, held: 'queue_full' };
    // 리뷰 작업은 '/review-resume'과 같은 리뷰 제어 경로, 그 밖은 관리 기능의 멈춘 작업 재개(C32)다. 둘 다 Store.resumeWaiting이다.
    const ok = job.type === 'review'
      ? (await store.control(actor, conversation, 'review-resume', job.id, undefined, { review: true }) as { ok: boolean }).ok
      : await store.adminResumeJob(job.id, actor) === 'resumed';
    if (ok) resumed++;
  }
  return { result: 'switched', resumed, waiting: waiting.length - resumed, held: null };
}
