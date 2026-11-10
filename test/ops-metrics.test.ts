import { after, before, beforeEach, test } from 'node:test';
import assert from 'node:assert/strict';
import { Health } from '../src/health.js';
import { TASK_GATE_CLOSED_REASONS } from '../src/ops-metrics.js';
import { Store } from '../src/store.js';
import { recordAccount } from '../src/model-accounts.js';
import { localDatabase } from './helpers.js';

// 운영 지표(개선안 v2 1-3). DB 값을 그대로 읽는 gauge다. 라벨에는 정해진 상태·종류 이름만 들어간다.
const NOW = 1_800_000_000_000;
const OPEN = ['queued', 'running', 'verifying', 'cancel_requested', 'waiting_user', 'unknown'];
const TYPES = ['chat', 'task', 'read', 'review'];
const OUTBOX = ['pending', 'sending', 'unknown', 'blocked'];
const LEDGER = ['closed', 'ready', 'degraded', 'failed', 'fenced', 'disabled'];
const PAUSE_KINDS = ['rate_limit', 'auth_expired', 'billing'];
const ACCOUNT_METHODS = ['subscription', 'api', 'none'];
const T20_SCALARS = ['homelab_bot_memory_deletions_pending', 'homelab_bot_memory_deletion_pending_oldest_seconds', 'homelab_bot_briefing_enabled'];
const ledgerKey = (state: string) => `homelab_bot_deletion_ledger_state{state="${state}"}`;
let database: Awaited<ReturnType<typeof localDatabase>>;
let health: Health;
before(async () => { database = await localDatabase(); });
beforeEach(async () => {
  const tables = (await database.pg.query<{ tablename: string }>(
    "SELECT tablename FROM pg_tables WHERE schemaname='public' AND tablename<>'schema_migrations'")).rows.map(r => r.tablename);
  await database.pg.exec(`TRUNCATE ${tables.join(',')} RESTART IDENTITY CASCADE`);
  health = new Health(new Store(database.db, () => NOW), async () => {});
});
after(async () => { await database.pg.close(); });

function parse(text: string): Map<string, number> {
  const series = new Map<string, number>();
  for (const line of text.split('\n').filter(Boolean)) {
    const m = line.match(/^([a-z_]+(?:\{[^}]*\})?) (-?[0-9.]+)$/);
    assert.ok(m, `형식 밖 줄: ${line}`);
    assert.equal(series.has(m[1]!), false, `중복 계열: ${m[1]}`);
    series.set(m[1]!, Number(m[2]));
  }
  return series;
}
const jobKey = (type: string, state: string) => `homelab_bot_jobs{type="${type}",state="${state}"}`;
let seq = 0;
async function job(type: string, state: string) {
  const id = `fixture-job-${++seq}`;
  await database.db.query(`INSERT INTO events(id,provider,delivery_id,semantic_key,actor_id,scope,received_at,payload)
    VALUES ($1,'discord',$1,$1,'fixture-owner','{}',0,'{}')`, [id]);
  await database.db.query(`INSERT INTO jobs(id,event_id,type,owner_id,target,revision,budget,state,priority,available_at,created_at)
    VALUES ($1,$1,$2,'fixture-owner','{"channel":"fixture-secret-channel"}','{}','{}',$3,10,0,0)`, [id, type, state]);
}
async function outbox(state: string, createdAt = NOW) {
  const id = `fixture-outbox-${++seq}`;
  await database.db.query(`INSERT INTO outbox(id,owner_id,scope,policy_revision,idempotency_key,payload,state,available_at,created_at,message_key,page_index)
    VALUES ($1,'fixture-owner','{}','fixture-v1',$1,'{"content":"fixture-body"}',$2,$3,$3,$1,0)`, [id, state, createdAt]);
}
async function conversation(gap: boolean) {
  const id = `thread:fixture-guild:fixture-conversation-${++seq}`;
  await database.db.query(`INSERT INTO conversations(id,owner_id,scope,channel_id,created_at,gap) VALUES ($1,'fixture-owner','{}',$1,0,$2)`, [id, gap]);
}

test('B5 작업 레인 지표: 켠 배치에서만 나오고, 레인별 대기·실행·unknown·닫힘 사유·정리 실패·보존 수를 낸다', async () => {
  const off = await health.metrics();
  assert.doesNotMatch(off, /homelab_bot_(lane_jobs|task_(?!gate_closed))/);
  health.watchTaskLane(() => ({ workerRouted: true, intakeOpen: false }));
  const lane = (name: string, state: string) => `homelab_bot_lane_jobs{lane="${name}",state="${state}"}`;
  const closed = (reason: string) => `homelab_bot_task_lane_closed{reason="${reason}"}`;
  let m = parse(await health.metrics());
  for (const name of ['interactive', 'task']) for (const state of OPEN) assert.equal(m.get(lane(name, state)), 0);
  for (const reason of ['unknown', 'cleanup_pending', 'retention_full']) assert.equal(m.get(closed(reason)), 0);
  assert.equal(m.get('homelab_bot_task_cleanup_pending'), 0);
  assert.equal(m.get('homelab_bot_task_sessions_retained'), 0);
  assert.deepEqual([m.get('homelab_bot_task_worker_routed'), m.get('homelab_bot_task_worker_intake_open')], [1, 0]);
  await job('task', 'queued'); await job('task', 'unknown'); await job('chat', 'running'); await job('review', 'queued'); await job('read', 'queued');
  await database.db.query(`INSERT INTO codex_sessions(job_id,thread_id,turn,tool_calls,host,repository,capabilities,state,created_at,updated_at,executor,claude_session_id,generation,worker_lease,
    base_sha,policy_revision,project_id,project_revision,turn_timeout_ms,run_budget_ms,session_retained,cleanup_state)
    SELECT id,gen_random_uuid()::text,1,0,'worker-task','fixture/repo','{}','failed',0,0,'claude',gen_random_uuid()::text,1,gen_random_uuid()::text,repeat('a',40),'r','p','r',1,1,true,'pending' FROM jobs WHERE type='task' AND state='queued'`);
  // 이 파일의 beforeEach가 표 전체를 비운다.
  await database.db.query(`INSERT INTO execution_lanes(lane,closed_reason,closed_at) VALUES ('task','unknown',0)`);
  m = parse(await health.metrics());
  assert.equal(m.get(lane('task', 'queued')), 1);
  assert.equal(m.get(lane('task', 'unknown')), 1);
  assert.equal(m.get(lane('interactive', 'running')), 1);
  // 대화와 리뷰가 interactive를 함께 쓰고 read는 어느 레인도 아니다.
  assert.equal(m.get(lane('interactive', 'queued')), 1);
  assert.deepEqual(['unknown', 'cleanup_pending', 'retention_full'].map(reason => m.get(closed(reason))), [1, 0, 0]);
  assert.equal(m.get('homelab_bot_task_cleanup_pending'), 1);
  assert.equal(m.get('homelab_bot_task_sessions_retained'), 1);
});

test('T18 게이트 지표: 작업 레인 조립과 무관하게 사유 전체를 내고 닫힌 사유 줄만 1', async () => {
  const gateKey = (reason: string) => `homelab_bot_task_gate_closed{reason="${reason}"}`;
  const values = async () => { const m = parse(await health.metrics()); return TASK_GATE_CLOSED_REASONS.map(reason => m.get(gateKey(reason))); };
  assert.deepEqual([...TASK_GATE_CLOSED_REASONS], ['switch_off', 'policy_invalid']);
  assert.deepEqual(await values(), [0, 0]);
  for (const [reason, expected] of [['switch_off', [1, 0]], ['policy_invalid', [0, 1]], [null, [0, 0]]] as const) {
    health.watchTaskGate(() => reason);
    assert.deepEqual(await values(), expected, String(reason));
  }
});

test('OPS-M1 빈 DB: 모든 상태×종류·gap·outbox·제어 계열이 0으로 나옴(계열 안정)', async () => {
  const m = parse(await health.metrics());
  for (const type of TYPES) for (const state of OPEN) assert.equal(m.get(jobKey(type, state)), 0, jobKey(type, state));
  for (const state of OUTBOX) assert.equal(m.get(`homelab_bot_outbox{state="${state}"}`), 0);
  for (const name of ['homelab_bot_conversation_gaps', 'homelab_bot_scheduler_paused', 'homelab_bot_emergency_stop', 'homelab_bot_gateway_halted'])
    assert.equal(m.get(name), 0, name);
  // 원장을 켜지 않은 기본은 disabled만 1, 삭제 대기·브리핑은 0.
  for (const state of LEDGER) assert.equal(m.get(ledgerKey(state)), state === 'disabled' ? 1 : 0, state);
  for (const name of T20_SCALARS) assert.equal(m.get(name), 0, name);
  // 기본 3개 + jobs 24 + outbox 4 + gap·paused·emergency·halted 4 + 원장 상태 6·스칼라 3 + 게이트 사유 2
  // + 멈춤 종류별 작업 수·풀리는 시각 3·3, 지금 계정 1, 미룬 리뷰 수 1.
  assert.equal(m.size, 3 + TYPES.length * OPEN.length + OUTBOX.length + 4 + LEDGER.length + T20_SCALARS.length + TASK_GATE_CLOSED_REASONS.length
    + PAUSE_KINDS.length * 2 + 2);
});

test('OPS-M2 작업 상태·종류별 개수, 종결 상태는 내보내지 않음', async () => {
  await job('chat', 'queued'); await job('chat', 'queued'); await job('chat', 'running');
  await job('task', 'waiting_user'); await job('read', 'queued'); await job('review', 'unknown');
  await job('chat', 'cancel_requested'); await job('review', 'verifying');
  for (const state of ['succeeded', 'failed', 'cancelled', 'superseded']) await job('chat', state);
  const m = parse(await health.metrics());
  assert.equal(m.get(jobKey('chat', 'queued')), 2);
  assert.equal(m.get(jobKey('chat', 'running')), 1);
  assert.equal(m.get(jobKey('chat', 'cancel_requested')), 1);
  assert.equal(m.get(jobKey('task', 'waiting_user')), 1);
  assert.equal(m.get(jobKey('read', 'queued')), 1);
  assert.equal(m.get(jobKey('review', 'unknown')), 1);
  assert.equal(m.get(jobKey('review', 'verifying')), 1);
  assert.equal(m.get(jobKey('task', 'queued')), 0);
  assert.equal([...m.keys()].some(key => key.startsWith('homelab_bot_jobs') && /succeeded|failed|cancelled"|superseded/.test(key)), false);
});

test('OPS-M3 gap인 대화 수', async () => {
  await conversation(true); await conversation(true); await conversation(false);
  assert.equal(parse(await health.metrics()).get('homelab_bot_conversation_gaps'), 2);
});

test('OPS-M4 outbox 상태별 개수(sent는 제외)', async () => {
  await outbox('pending'); await outbox('pending'); await outbox('sending'); await outbox('unknown'); await outbox('blocked'); await outbox('sent');
  const m = parse(await health.metrics());
  assert.deepEqual(OUTBOX.map(state => m.get(`homelab_bot_outbox{state="${state}"}`)), [2, 1, 1, 1]);
});

test('OPS-M5 스케줄러 중지·비상 중지는 controls 값(행 없음=0)', async () => {
  await database.db.query(`INSERT INTO controls VALUES ('scheduler','true'),('scheduler_emergency','false')`);
  let m = parse(await health.metrics());
  assert.equal(m.get('homelab_bot_scheduler_paused'), 1); assert.equal(m.get('homelab_bot_emergency_stop'), 0);
  await database.db.query(`UPDATE controls SET value='true' WHERE key='scheduler_emergency'`);
  await database.db.query(`UPDATE controls SET value='false' WHERE key='scheduler'`);
  m = parse(await health.metrics());
  assert.equal(m.get('homelab_bot_scheduler_paused'), 0); assert.equal(m.get('homelab_bot_emergency_stop'), 1);
});

test('OPS-M6 기존 3개 지표 이름·의미 유지(연결, unknown 수, pending/unknown 가장 오래된 초)', async () => {
  await outbox('unknown', NOW - 5000); await outbox('pending', NOW - 2000); await outbox('sending', NOW - 60_000); await outbox('blocked', NOW - 90_000);
  health.gateway(true);
  const m = parse(await health.metrics());
  assert.equal(m.get('homelab_bot_gateway_connected'), 1);
  assert.equal(m.get('homelab_bot_outbox_unknown'), 1);
  // sending·blocked는 보지 않는다.
  assert.equal(m.get('homelab_bot_outbox_oldest_seconds'), 5);
  health.gateway(false);
  assert.equal(parse(await health.metrics()).get('homelab_bot_gateway_connected'), 0);
});

test('OPS-M7 Gateway fatal 정지(halted)는 GatewaySession 상태를 읽어 0/1', async () => {
  let halted = false;
  health.watchGateway(() => ({ halted }));
  assert.equal(parse(await health.metrics()).get('homelab_bot_gateway_halted'), 0);
  halted = true;
  assert.equal(parse(await health.metrics()).get('homelab_bot_gateway_halted'), 1);
});

test('OPS-M8 라벨은 화이트리스트뿐: 모르는 종류·ID·본문·채널이 새 계열이나 라벨로 새지 않음', async () => {
  await job('weird-type', 'queued'); await job('chat', 'queued'); await outbox('pending'); await conversation(true);
  const text = await health.metrics();
  assert.doesNotMatch(text, /fixture|weird/);
  for (const key of parse(text).keys()) {
    const labels = key.match(/\{(.*)\}$/)?.[1];
    if (!labels) continue;
    for (const pair of labels.split(',')) {
      const [name, value] = pair.split('=') as [string, string];
      const allowed: readonly string[] = name === 'type' ? TYPES : name === 'state' ? [...OPEN, ...OUTBOX, ...LEDGER] : name === 'reason' ? TASK_GATE_CLOSED_REASONS
        : name === 'kind' ? PAUSE_KINDS : name === 'method' ? ACCOUNT_METHODS : [];
      assert.ok(allowed.includes(JSON.parse(value)), `허용 밖 라벨: ${pair}`);
    }
  }
  assert.equal(parse(text).get(jobKey('chat', 'queued')), 1);
});

async function deletion(id: string, requestedAt: number, appliedAt: number | null) {
  await database.db.query(`INSERT INTO memory_deletions(memory_id,memory_created_at,requested_by,requested_at,applied_at)
    VALUES ($1,1,'fixture-owner',$2,$3)`, [id, requestedAt, appliedAt]);
}
test('OPS-M9 [T20] 원장 상태는 지금 값만 1(one-hot), 브리핑 0/1, 삭제 대기 수와 가장 오래된 대기 초', async () => {
  let state: { ledger: (typeof LEDGER)[number]; briefingEnabled: boolean } = { ledger: 'closed', briefingEnabled: false };
  health.watchMemory(() => state as never);
  for (const ledger of LEDGER) {
    state = { ledger, briefingEnabled: ledger === 'ready' };
    const m = parse(await health.metrics());
    assert.deepEqual(LEDGER.map(s => m.get(ledgerKey(s))), LEDGER.map(s => s === ledger ? 1 : 0), ledger);
    assert.equal(m.get('homelab_bot_briefing_enabled'), ledger === 'ready' ? 1 : 0);
  }
  // 정리 끝난 삭제(applied_at 있음)는 세지 않는다. 가장 오래된 것은 요청 시각 기준.
  await deletion('fixture-memory-a', NOW - 90_000, null);
  await deletion('fixture-memory-b', NOW - 5000, null);
  await deletion('fixture-memory-c', NOW - 999_000, NOW - 1000);
  const m = parse(await health.metrics());
  assert.equal(m.get('homelab_bot_memory_deletions_pending'), 2);
  assert.equal(m.get('homelab_bot_memory_deletion_pending_oldest_seconds'), 90);
  assert.doesNotMatch(await health.metrics(), /fixture-memory/);
});

// 모델 멈춤 기록(C19 model_pauses)을 쓴 대기 작업. row=false면 멈춤 기록 전의 판이 남긴 대기다.
async function pausedJob(kind: 'rate_limit' | 'auth_expired' | 'billing', resetsAt: number | null,
  options: { type?: string; state?: string; row?: boolean } = {}) {
  await job(options.type ?? 'chat', options.state ?? 'waiting_user');
  const id = `fixture-job-${seq}`;
  await database.db.query('UPDATE jobs SET wait_reason=$2 WHERE id=$1', [id, kind === 'auth_expired' ? 'auth_expired' : 'model_limit']);
  if (options.row !== false) await database.db.query(`INSERT INTO model_pauses(job_id,kind,resets_at,retry_at,paused_at) VALUES ($1,$2,$3,$4,$5)`,
    [id, kind, resetsAt, kind === 'billing' ? null : NOW + 60_000, NOW]);
}
const pausedKey = (kind: string) => `homelab_bot_model_paused_jobs{kind="${kind}"}`;
const resetsKey = (kind: string) => `homelab_bot_model_pause_resets_at_seconds{kind="${kind}"}`;

test('C21 운영 알림 지표: 모델 멈춤이 없으면 종류마다 0, 지금 계정은 C22 전이라 method="none", 미룬 리뷰 0', async () => {
  const m = parse(await health.metrics());
  for (const kind of PAUSE_KINDS) {
    assert.equal(m.get(pausedKey(kind)), 0, kind);
    assert.equal(m.get(resetsKey(kind)), 0, kind);
  }
  assert.equal(m.get('homelab_bot_model_account{method="none"}'), 1);
  assert.equal(m.get('homelab_bot_model_reviews_deferred'), 0);
});

// homelab vmalert HomelabBotModelPaused*가 `max by (account, method) (homelab_bot_model_account)`로 읽고 method가 none이면
// "미등록", api면 "API 크레딧", 그 밖이면 "구독"으로 적는다. 라벨 이름과 값이 그 규칙과 글자 그대로 맞아야 한다.
test('C22 지금 계정 지표: 등록만 하고 고르지 않으면 method="none", 고른 계정이면 account와 method="subscription" 한 줄', async () => {
  await recordAccount(database.db, 'main', 'subscription', NOW);
  await recordAccount(database.db, 'spare', 'subscription', NOW);
  let m = parse(await health.metrics());
  assert.equal(m.get('homelab_bot_model_account{method="none"}'), 1);
  await database.db.query("UPDATE model_accounts SET current=true WHERE name='spare'");
  const text = await health.metrics();
  m = parse(text);
  assert.equal(m.get('homelab_bot_model_account{account="spare",method="subscription"}'), 1);
  assert.deepEqual(text.split('\n').filter(line => line.startsWith('homelab_bot_model_account')),
    ['homelab_bot_model_account{account="spare",method="subscription"} 1']);
});

test('C21 운영 알림 지표: 종류별 대기 작업 수와 가장 늦게 풀리는 시각(Unix 초, 모르면 0), 대기에서 나간 작업의 남은 기록은 세지 않음', async () => {
  await pausedJob('rate_limit', 1_800_003_600_000);
  await pausedJob('rate_limit', 1_800_007_200_000, { type: 'review' });
  await pausedJob('rate_limit', null, { type: 'task' });
  await pausedJob('auth_expired', null);
  // 재개돼 다시 도는 작업에 남은 기록과 끝난 작업의 기록.
  await pausedJob('billing', null, { state: 'running' });
  await pausedJob('rate_limit', 1_900_000_000_000, { state: 'succeeded' });
  let m = parse(await health.metrics());
  assert.deepEqual(PAUSE_KINDS.map(kind => m.get(pausedKey(kind))), [3, 1, 0]);
  assert.deepEqual(PAUSE_KINDS.map(kind => m.get(resetsKey(kind))), [1_800_007_200, 0, 0]);
  await pausedJob('billing', null, { type: 'task' });
  m = parse(await health.metrics());
  assert.equal(m.get(pausedKey('billing')), 1);
  assert.doesNotMatch(await health.metrics(), /fixture/);
});

test('C21 운영 알림 지표: 멈춤 기록 전의 판이 남긴 대기도 wait_reason으로 종류를 정해 센다(비상 정지 중에는 기록이 채워지지 않는다)', async () => {
  await pausedJob('rate_limit', null, { row: false });
  await pausedJob('auth_expired', null, { row: false });
  const m = parse(await health.metrics());
  assert.deepEqual(PAUSE_KINDS.map(kind => m.get(pausedKey(kind))), [1, 1, 0]);
});

test('C21 운영 알림 지표: 리뷰 미루기 기한 안이면 대기열의 PR 리뷰 수, 기한이 지나면 0', async () => {
  await job('review', 'queued'); await job('review', 'queued'); await job('review', 'running'); await job('chat', 'queued');
  await database.db.query(`INSERT INTO model_limit_state(id,status,review_deferred_until) VALUES ('account','allowed_warning',$1)`, [NOW + 60_000]);
  assert.equal(parse(await health.metrics()).get('homelab_bot_model_reviews_deferred'), 2);
  await database.db.query(`UPDATE model_limit_state SET review_deferred_until=$1`, [NOW - 1]);
  assert.equal(parse(await health.metrics()).get('homelab_bot_model_reviews_deferred'), 0);
});
