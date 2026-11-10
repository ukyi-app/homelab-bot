import type { Database } from './database.js';

// 운영 지표(개선안 v2 1-3). 공유 DB의 현재 값을 그대로 내보내는 gauge다. 누적 counter·histogram이 아니다.
// 함정: RollingUpdate 동안 구·신 게시 서버 두 파드가 같은 값을 내므로 경보 룰은 sum이 아니라 max()로 묶어야 한다.
// 라벨에는 아래 고정 이름만 넣는다(ID·본문·채널·owner 금지). 0인 조합도 내보내 계열이 생겼다 사라지지 않게 한다.
const OPEN_STATES = ['queued', 'running', 'verifying', 'cancel_requested', 'waiting_user', 'unknown'] as const;
const JOB_TYPES = ['chat', 'task', 'read', 'review'] as const;
const OUTBOX_STATES = ['pending', 'sending', 'unknown', 'blocked'] as const;
// 삭제 원장 상태(LedgerState + 원장을 켜지 않은 disabled). 지금 값만 1인 one-hot이다.
export const LEDGER_STATES = ['closed', 'ready', 'degraded', 'failed', 'fenced', 'disabled'] as const;
export type LedgerMetricState = (typeof LEDGER_STATES)[number];
// 프로세스 안의 기억·브리핑 상태. 원장 상태와 이 프로세스의 브리핑 예약 반영 결과는 DB에 없다.
export interface MemoryMetrics { ledger: LedgerMetricState; briefingEnabled: boolean }
export const MEMORY_DISABLED: MemoryMetrics = Object.freeze({ ledger: 'disabled', briefingEnabled: false });
// 게시 서버가 작업자에 물어 안 값. 수락 사유는 라벨에 넣지 않는다(값이 늘 수 있다). 사유는 작업자 로그와 /v1/task/intake에 있다.
export interface TaskLaneMetrics { workerRouted: boolean; intakeOpen: boolean }
// taskPrecondition이 작업 레인을 닫을 때 내는 사유 전체. 레인 계열은 조립할 때만 나오므로 "정책이 틀려 조립 못 함"을
// 경보 룰이 가르려면 이 계열이 스위치·정책과 무관하게 항상 있어야 한다.
export const TASK_GATE_CLOSED_REASONS = ['switch_off', 'policy_invalid'] as const;
export type TaskGateClosedReason = (typeof TASK_GATE_CLOSED_REASONS)[number];
const EXECUTION_LANES = ['interactive', 'task'] as const;
const LANE_REASONS = ['unknown', 'cleanup_pending', 'retention_full'] as const;
const LANE_QUERY = `
  SELECT 'lane' AS kind, execution_lane AS a, state AS b, count(*)::text AS n FROM jobs WHERE execution_lane IS NOT NULL AND state = ANY($1::text[]) GROUP BY execution_lane, state
  UNION ALL SELECT 'closed', closed_reason, '', '0' FROM execution_lanes WHERE lane='task' AND closed_reason IS NOT NULL
  UNION ALL SELECT 'cleanup', '', '', count(*)::text FROM codex_sessions WHERE executor='claude' AND cleanup_state='pending'
  UNION ALL SELECT 'retained', '', '', count(*)::text FROM codex_sessions WHERE executor='claude' AND session_retained`;
// 레인별 대기·실행·unknown은 lane_jobs다. 작업 레인을 켠 배치에서만 낸다.
async function taskLaneLines(db: Database, task: TaskLaneMetrics): Promise<string[]> {
  const rows = (await db.query<{ kind: string; a: string; b: string; n: string }>(LANE_QUERY, [OPEN_STATES])).rows;
  const lanes = new Map(rows.filter(row => row.kind === 'lane').map(row => [`${row.a}/${row.b}`, Number(row.n)]));
  const closed = rows.find(row => row.kind === 'closed')?.a;
  const single = (kind: string) => Number(rows.find(row => row.kind === kind)?.n ?? 0);
  return [
    ...EXECUTION_LANES.flatMap(lane => OPEN_STATES.map(state => `homelab_bot_lane_jobs{lane="${lane}",state="${state}"} ${lanes.get(`${lane}/${state}`) ?? 0}`)),
    ...LANE_REASONS.map(reason => `homelab_bot_task_lane_closed{reason="${reason}"} ${closed === reason ? 1 : 0}`),
    `homelab_bot_task_cleanup_pending ${single('cleanup')}`,
    `homelab_bot_task_sessions_retained ${single('retained')}`,
    `homelab_bot_task_worker_routed ${task.workerRouted ? 1 : 0}`,
    `homelab_bot_task_worker_intake_open ${task.intakeOpen ? 1 : 0}`,
  ];
}

// 한 번의 왕복으로 상수 개수의 집계만 한다. jobs는 jobs_queue(state,...) 인덱스의 state 조건으로 좁힌다.
// outbox·conversations에는 state·gap 인덱스가 없어 표 전체를 읽는다(지금 규모에선 작다. 커지면 부분 인덱스를 더한다).
const QUERY = `
  SELECT 'job' AS kind, type AS a, state AS b, count(*)::text AS n FROM jobs WHERE state = ANY($1::text[]) GROUP BY type, state
  UNION ALL SELECT 'outbox', state, '', count(*)::text FROM outbox WHERE state = ANY($2::text[]) GROUP BY state
  UNION ALL SELECT 'gap', '', '', count(*)::text FROM conversations WHERE gap = true
  UNION ALL SELECT 'control', key, value::text, '0' FROM controls WHERE key IN ('scheduler', 'scheduler_emergency')
  UNION ALL SELECT 'deletion', '', COALESCE(min(requested_at)::text, ''), count(*)::text FROM memory_deletions WHERE applied_at IS NULL
  UNION ALL SELECT 'pause', kind, COALESCE(max(resets_at)::text, ''), count(*)::text FROM (
    SELECT COALESCE(p.kind, CASE WHEN j.wait_reason='auth_expired' THEN 'auth_expired' ELSE 'rate_limit' END) AS kind, p.resets_at
    FROM jobs j LEFT JOIN model_pauses p ON p.job_id=j.id WHERE j.state='waiting_user' AND j.wait_reason IN ('model_limit','auth_expired')) w GROUP BY kind
  UNION ALL SELECT 'deferred', '', '', count(*)::text FROM jobs j WHERE j.type='review' AND j.state='queued'
    AND EXISTS (SELECT 1 FROM model_limit_state s WHERE s.id='account' AND s.review_deferred_until > $3)
    AND NOT EXISTS (SELECT 1 FROM change_child_jobs c WHERE c.job_id=j.id AND c.role='review')`;

// 모델 멈춤(COLLEAGUE_SPEC §4.7 "운영 알림", C19 model_pauses). 종류는 model_pauses.kind의 CHECK 목록과 같다.
export const MODEL_PAUSE_KINDS = ['rate_limit', 'auth_expired', 'billing'] as const;

// 삭제 대기는 DB의 정리 안 끝난 삭제 요청(memory_deletions.applied_at IS NULL)이다. 원장 기록 전(ledger_unconfirmed)과
// 원장 기록 뒤 DB 정리 전(db_purge_pending)을 함께 센다. 복원으로 요청 행이 사라진 원장 재적용 대기는 여기 없다(원장 상태로 본다).
export async function opsMetrics(db: Database, now: number, memory: MemoryMetrics = MEMORY_DISABLED, task?: TaskLaneMetrics,
  gateClosed: TaskGateClosedReason | null = null): Promise<string> {
  const rows = (await db.query<{ kind: string; a: string; b: string; n: string }>(QUERY, [OPEN_STATES, OUTBOX_STATES, now])).rows;
  const jobs = new Map<string, number>();
  const outbox = new Map<string, number>();
  const pauses = new Map<string, { jobs: number; resetsAt: number }>();
  let gaps = 0, paused = 0, emergency = 0, deletions = 0, oldest = 0, deferred = 0;
  for (const row of rows) {
    if (row.kind === 'job') jobs.set(`${row.a}/${row.b}`, Number(row.n));
    else if (row.kind === 'pause') pauses.set(row.a, { jobs: Number(row.n), resetsAt: row.b ? Math.floor(Number(row.b) / 1000) : 0 });
    else if (row.kind === 'deferred') deferred = Number(row.n);
    else if (row.kind === 'deletion') { deletions = Number(row.n); oldest = row.b ? Math.max(0, (now - Number(row.b)) / 1000) : 0; }
    else if (row.kind === 'outbox') outbox.set(row.a, Number(row.n));
    else if (row.kind === 'gap') gaps = Number(row.n);
    else if (row.a === 'scheduler') paused = row.b === 'true' ? 1 : 0;
    else emergency = row.b === 'true' ? 1 : 0;
  }
  // 모르는 작업 종류·상태는 jobs 맵에 있어도 여기서 꺼내지 않으므로 라벨로 새지 않는다.
  const lines = [
    ...JOB_TYPES.flatMap(type => OPEN_STATES.map(state => `homelab_bot_jobs{type="${type}",state="${state}"} ${jobs.get(`${type}/${state}`) ?? 0}`)),
    `homelab_bot_conversation_gaps ${gaps}`,
    ...OUTBOX_STATES.map(state => `homelab_bot_outbox{state="${state}"} ${outbox.get(state) ?? 0}`),
    `homelab_bot_scheduler_paused ${paused}`,
    `homelab_bot_emergency_stop ${emergency}`,
    ...LEDGER_STATES.map(state => `homelab_bot_deletion_ledger_state{state="${state}"} ${memory.ledger === state ? 1 : 0}`),
    `homelab_bot_memory_deletions_pending ${deletions}`,
    `homelab_bot_memory_deletion_pending_oldest_seconds ${oldest}`,
    `homelab_bot_briefing_enabled ${memory.briefingEnabled ? 1 : 0}`,
    ...TASK_GATE_CLOSED_REASONS.map(reason => `homelab_bot_task_gate_closed{reason="${reason}"} ${gateClosed === reason ? 1 : 0}`),
    // 풀리는 시각은 그 종류의 대기 중 가장 늦은 것(Unix 초)이고, 모르면(인증 만료·결제, 시각 없는 한도) 0이다.
    // 계열을 없애지 않고 0으로 두는 것은 경보 룰이 이 값을 경보 값으로 쓰기 때문이다(멈춤 여부는 paused_jobs로 가른다).
    ...MODEL_PAUSE_KINDS.map(kind => `homelab_bot_model_paused_jobs{kind="${kind}"} ${pauses.get(kind)?.jobs ?? 0}`),
    ...MODEL_PAUSE_KINDS.map(kind => `homelab_bot_model_pause_resets_at_seconds{kind="${kind}"} ${pauses.get(kind)?.resetsAt ?? 0}`),
    // 지금 계정. 계정 기록은 C22가 만든다. 그 전에는 계정 라벨 없이 method="none"이다. C22는 이 줄에 account(CLI 이름 규칙을
    // 통과한 짧은 이름)와 method(subscription·api)를 채운다. 라벨 값이 바뀌면 옛 계열은 수집 staleness(5분)로 사라진다.
    'homelab_bot_model_account{method="none"} 1',
    `homelab_bot_model_reviews_deferred ${deferred}`,
    ...(task ? await taskLaneLines(db, task) : []),
  ];
  return `${lines.join('\n')}\n`;
}
