import type { Database } from './database.js';

// 운영 지표(개선안 v2 1-3). 공유 DB의 현재 값을 그대로 내보내는 gauge다. 누적 counter·histogram이 아니다.
// 함정: RollingUpdate 동안 구·신 게시 서버 두 파드가 같은 값을 내므로 경보 룰은 sum이 아니라 max()로 묶어야 한다.
// 라벨에는 아래 고정 이름만 넣는다(ID·본문·채널·owner 금지). 0인 조합도 내보내 계열이 생겼다 사라지지 않게 한다.
const OPEN_STATES = ['queued', 'running', 'verifying', 'cancel_requested', 'waiting_user', 'unknown'] as const;
const JOB_TYPES = ['chat', 'task', 'read', 'review'] as const;
const OUTBOX_STATES = ['pending', 'sending', 'unknown', 'blocked'] as const;

// 한 번의 왕복으로 상수 개수의 집계만 한다. jobs는 jobs_queue(state,...) 인덱스의 state 조건으로 좁힌다.
// outbox·conversations에는 state·gap 인덱스가 없어 표 전체를 읽는다(지금 규모에선 작다. 커지면 부분 인덱스를 더한다).
const QUERY = `
  SELECT 'job' AS kind, type AS a, state AS b, count(*)::text AS n FROM jobs WHERE state = ANY($1::text[]) GROUP BY type, state
  UNION ALL SELECT 'outbox', state, '', count(*)::text FROM outbox WHERE state = ANY($2::text[]) GROUP BY state
  UNION ALL SELECT 'gap', '', '', count(*)::text FROM conversations WHERE gap = true
  UNION ALL SELECT 'control', key, value::text, '0' FROM controls WHERE key IN ('scheduler', 'scheduler_emergency')`;

export async function opsMetrics(db: Database): Promise<string> {
  const rows = (await db.query<{ kind: string; a: string; b: string; n: string }>(QUERY, [OPEN_STATES, OUTBOX_STATES])).rows;
  const jobs = new Map<string, number>();
  const outbox = new Map<string, number>();
  let gaps = 0, paused = 0, emergency = 0;
  for (const row of rows) {
    if (row.kind === 'job') jobs.set(`${row.a}/${row.b}`, Number(row.n));
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
  ];
  return `${lines.join('\n')}\n`;
}
