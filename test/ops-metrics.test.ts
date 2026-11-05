import { after, before, beforeEach, test } from 'node:test';
import assert from 'node:assert/strict';
import { Health } from '../src/health.js';
import { Store } from '../src/store.js';
import { localDatabase } from './helpers.js';

// 운영 지표(개선안 v2 1-3). DB 값을 그대로 읽는 gauge다. 라벨에는 정해진 상태·종류 이름만 들어간다.
const NOW = 1_800_000_000_000;
const OPEN = ['queued', 'running', 'verifying', 'cancel_requested', 'waiting_user', 'unknown'];
const TYPES = ['chat', 'task', 'read', 'review'];
const OUTBOX = ['pending', 'sending', 'unknown', 'blocked'];
const LEDGER = ['closed', 'ready', 'degraded', 'failed', 'fenced', 'disabled'];
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
  assert.doesNotMatch(off, /homelab_bot_(lane_jobs|task_)/);
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

test('OPS-M1 빈 DB: 모든 상태×종류·gap·outbox·제어 계열이 0으로 나옴(계열 안정)', async () => {
  const m = parse(await health.metrics());
  for (const type of TYPES) for (const state of OPEN) assert.equal(m.get(jobKey(type, state)), 0, jobKey(type, state));
  for (const state of OUTBOX) assert.equal(m.get(`homelab_bot_outbox{state="${state}"}`), 0);
  for (const name of ['homelab_bot_conversation_gaps', 'homelab_bot_scheduler_paused', 'homelab_bot_emergency_stop', 'homelab_bot_gateway_halted'])
    assert.equal(m.get(name), 0, name);
  // 원장을 켜지 않은 기본은 disabled만 1, 삭제 대기·브리핑은 0.
  for (const state of LEDGER) assert.equal(m.get(ledgerKey(state)), state === 'disabled' ? 1 : 0, state);
  for (const name of T20_SCALARS) assert.equal(m.get(name), 0, name);
  // 기본 3개 + jobs 24 + outbox 4 + gap·paused·emergency·halted 4 + 원장 상태 6·스칼라 3.
  assert.equal(m.size, 3 + TYPES.length * OPEN.length + OUTBOX.length + 4 + LEDGER.length + T20_SCALARS.length);
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
      const allowed = name === 'type' ? TYPES : name === 'state' ? [...OPEN, ...OUTBOX, ...LEDGER] : [];
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
