import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { PGlite } from '@electric-sql/pglite';
import pg from 'pg';
import { MIGRATIONS, Postgres, migrate, migrationVersion } from '../src/database.js';
import type { Database } from '../src/database.js';
import { runMigrations } from '../src/migrate-main.js';
import { Store } from '../src/store.js';
import { EXECUTION_LANES, EXECUTION_LANE_CLOSED_REASONS, TASK_CLEANUP_STATES, executionLaneOf } from '../src/task-contracts.js';
import { localDatabase } from './helpers.js';

// migrate()는 파일을 매개변수 없는 질의 한 번으로 보낸다. PGlite의 query()는 여러 문장을 못 받아 그때만 exec()로 보낸다.
function migrationDatabase(engine: PGlite): Database {
  return {
    query: async <T>(sql: string, params: unknown[] = []) => params.length
      ? engine.query<T>(sql, params)
      : { rows: ((await engine.exec(sql)).at(-1)?.rows ?? []) as T[] },
    transaction: fn => engine.transaction(tx => fn({ query: (sql, params = []) => tx.query(sql, params),
      transaction: () => { throw new Error('nested'); } })),
  };
}
const NOW = 1_800_000_000_000;
const UPTO_012 = MIGRATIONS.filter(file => file < '013');
// 012 시점 코드가 넣던 모양 그대로의 행.
async function legacyJob(db: Database, type: string) {
  const id = randomUUID();
  await db.query(`INSERT INTO conversations(id,owner_id,scope,channel_id,created_at) VALUES ($1,'owner','{}','channel',$2) ON CONFLICT DO NOTHING`, [`c-${id}`, NOW]);
  await db.query(`INSERT INTO events(id,provider,delivery_id,semantic_key,actor_id,scope,conversation_id,received_at,payload,accepted)
    VALUES ($1,'discord',$1,$1,'owner','{}',$2,$3,'{"text":"x"}',true)`, [`e-${id}`, `c-${id}`, NOW]);
  await db.query(`INSERT INTO jobs(id,event_id,conversation_id,type,owner_id,target,revision,budget,priority,available_at,created_at)
    VALUES ($1,$2,$3,$4,'owner','{}','{"policy":"p"}','{"timeoutMs":1,"toolCalls":1}',50,$5,$5)`, [id, `e-${id}`, `c-${id}`, type, NOW]);
  return id;
}
const legacySession = (db: Database, job: string) => db.query(`INSERT INTO codex_sessions(job_id,thread_id,turn,tool_calls,host,capabilities,state,created_at,updated_at)
  VALUES ($1,'thread-1',2,3,'worker','{"version":"0.163.0"}','waiting_answer',$2,$2)`, [job, NOW]);
const claude = (job: string, overrides: Record<string, unknown> = {}) => ({ job_id: job, thread_id: null, turn: 1, host: 'worker-task', capabilities: '{}', state: 'running',
  created_at: NOW, updated_at: NOW, executor: 'claude', claude_session_id: randomUUID(), generation: 1, worker_lease: randomUUID(), repository: 'fixture-owner/fixture-repo',
  base_sha: 'a'.repeat(40), policy_revision: 'p1', project_id: 'fixture', project_revision: 'r1', turn_timeout_ms: 1_800_000, run_budget_ms: 5_400_000, ...overrides });
const insert = (db: Database, row: Record<string, unknown>) => {
  const keys = Object.keys(row);
  return db.query(`INSERT INTO codex_sessions(${keys.join(',')}) VALUES (${keys.map((_, i) => `$${i + 1}`).join(',')})`, Object.values(row));
};
const session = async (db: Database, job: string) => (await db.query<Record<string, unknown>>('SELECT * FROM codex_sessions WHERE job_id=$1', [job])).rows[0]!;
const lane = async (db: Database, job: string) => (await db.query<{ execution_lane: string | null }>('SELECT execution_lane FROM jobs WHERE id=$1', [job])).rows[0]!.execution_lane;

test('T18 B1 013: 빈 DB에 013까지 적용되고 다시 돌려도 빈 목록', async () => {
  const engine = new PGlite();
  try {
    const db = migrationDatabase(engine);
    assert.ok((await migrate(db)).includes(13));
    assert.deepEqual(await migrate(db), []);
    const lanes = (await db.query<{ lane: string; closed_reason: string | null }>('SELECT lane,closed_reason FROM execution_lanes ORDER BY lane')).rows;
    assert.deepEqual(lanes, EXECUTION_LANES.map(name => ({ lane: name, closed_reason: null })));
  } finally { await engine.close(); }
});
async function upgraded(db: Database, exec: (sql: string) => Promise<unknown>, apply: () => Promise<number[]>) {
  for (const file of UPTO_012) await exec(await readFile(`migrations/${file}`, 'utf8'));
  const jobs = { chat: await legacyJob(db, 'chat'), review: await legacyJob(db, 'review'), task: await legacyJob(db, 'task'), read: await legacyJob(db, 'read') };
  await legacySession(db, jobs.task);
  assert.deepEqual((await apply()).filter(version => version === 13), [13]);
  // 옛 세션은 Codex다. Claude가 재개할 값은 비어 있고, 쓴 도구 수·상태는 그대로다.
  const old = await session(db, jobs.task);
  assert.equal(old.executor, 'codex');
  for (const name of ['claude_session_id', 'generation', 'worker_lease', 'worker_instance', 'worker_storage', 'base_sha', 'policy_revision', 'project_id', 'project_revision',
    'turn_timeout_ms', 'run_budget_ms', 'stopped', 'waiting_since', 'owner_confirm_requested_at']) assert.equal(old[name], null, name);
  assert.equal(old.thread_id, 'thread-1');
  assert.equal(Number(old.turn), 2);
  assert.equal(Number(old.tool_calls), 3);
  assert.equal(old.state, 'waiting_answer');
  assert.equal(Number(old.run_used_ms), 0);
  assert.equal(old.session_retained, false);
  assert.equal(old.cleanup_state, 'none');
  // 있던 job에도 레인이 채워진다.
  assert.equal(await lane(db, jobs.chat), 'interactive');
  assert.equal(await lane(db, jobs.review), 'interactive');
  assert.equal(await lane(db, jobs.task), 'task');
  assert.equal(await lane(db, jobs.read), null);
  // 새 열을 모르는 코드가 넣는 행도 값이 맞다.
  const newTask = await legacyJob(db, 'task');
  await legacySession(db, newTask);
  assert.equal(await lane(db, newTask), executionLaneOf('task'));
  assert.equal((await session(db, newTask)).executor, 'codex');
}
test('T18 B1 013: 012까지 적용된 DB를 올려도 옛 행과 옛 코드의 쓰기가 그대로 동작', async () => {
  const engine = new PGlite();
  try {
    const db = migrationDatabase(engine);
    await upgraded(db, sql => engine.exec(sql), () => migrate(db));
    // 파일을 다시 돌려도 결과가 같다(009와 같은 방식).
    const before = (await db.query('SELECT * FROM codex_sessions ORDER BY job_id')).rows;
    await engine.exec(await readFile('migrations/013_task_lane.sql', 'utf8'));
    assert.deepEqual((await db.query('SELECT * FROM codex_sessions ORDER BY job_id')).rows, before);
    assert.equal((await db.query('SELECT 1 FROM execution_lanes')).rows.length, 2);
  } finally { await engine.close(); }
});
const socket = process.env.HOMELAB_TEST_PG_SOCKET;
test('T18 B1 013 실제 PostgreSQL: 012까지 적용된 DB를 진입점으로 올린다', { skip: socket ? false : 'HOMELAB_TEST_PG_SOCKET 없음(로컬 PostgreSQL 필요)' }, async () => {
  const admin = new pg.Pool({ host: socket, user: 'postgres', database: 'postgres', max: 1 });
  const name = `t18_${randomUUID().replaceAll('-', '').slice(0, 12)}`;
  await admin.query(`CREATE DATABASE ${name}`);
  const pool = new pg.Pool({ host: socket, user: 'postgres', database: name, max: 2 });
  try {
    await upgraded(new Postgres(pool), sql => pool.query(sql), () => runMigrations(pool));
    assert.deepEqual(await runMigrations(pool), []);
  } finally {
    await pool.end();
    await admin.query(`DROP DATABASE ${name} WITH (FORCE)`).catch(() => {});
    await admin.end();
  }
});
test('T18 B1 013: Claude 행은 재개 대조 값이 모두 있어야 하고, 잘못된 값을 거부한다', async () => {
  const { db, pg: engine } = await localDatabase();
  try {
    const job = await legacyJob(db, 'task');
    await assert.rejects(insert(db, { ...claude(job), claude_session_id: null }), /executor_identity/);
    for (const name of ['generation', 'worker_lease', 'repository', 'base_sha', 'policy_revision', 'project_id', 'project_revision', 'turn_timeout_ms', 'run_budget_ms']) {
      await assert.rejects(insert(db, claude(job, { [name]: null })), /executor_identity/, name);
    }
    await assert.rejects(insert(db, claude(job, { executor: 'codex' })), /executor_identity/);
    for (const [name, value] of Object.entries({ executor: 'gemini', claude_session_id: 'NOT-A-UUID', generation: 0, base_sha: 'abc', turn_timeout_ms: 0, run_budget_ms: 0,
      run_used_ms: -1, cleanup_state: 'cgroup_empty' })) {
      await assert.rejects(insert(db, claude(job, { [name]: value })), /check/, name);
    }
    const sessionId = randomUUID();
    await insert(db, claude(job, { claude_session_id: sessionId, session_retained: true, cleanup_state: 'pending', stopped: true, worker_instance: randomUUID(), worker_storage: randomUUID() }));
    const row = await session(db, job);
    assert.equal(row.executor, 'claude');
    assert.equal(row.claude_session_id, sessionId);
    // 한 세션 UUID를 두 job이 나눠 쓸 수 없다.
    await assert.rejects(insert(db, claude(await legacyJob(db, 'task'), { claude_session_id: sessionId })), /codex_sessions_claude_session/);
    // 대기 질문은 009 표를 그대로 쓴다(thread_id 자리에 세션 UUID).
    const conversation = (await db.query<{ conversation_id: string }>('SELECT conversation_id FROM jobs WHERE id=$1', [job])).rows[0]!.conversation_id;
    await db.query(`INSERT INTO codex_questions(id,job_id,conversation_id,thread_id,turn,kind,responder_id,prompt,state,created_at,expires_at)
      VALUES ($1,$2,$3,$4,1,'clarification','owner','질문','open',$5,$6)`, [`${job}:${sessionId}:1`, job, conversation, sessionId, NOW, NOW + 3_600_000]);
  } finally { await engine.close(); }
});
test('T18 B1 013: 계약 상수와 DB 값이 같고, 레인 닫힘은 사유·시각이 함께 있어야 한다', async () => {
  const { db, pg: engine } = await localDatabase();
  try {
    const job = await legacyJob(db, 'task');
    for (const state of TASK_CLEANUP_STATES) {
      await insert(db, claude(job, { cleanup_state: state }));
      await db.query('DELETE FROM codex_sessions WHERE job_id=$1', [job]);
    }
    for (const reason of EXECUTION_LANE_CLOSED_REASONS) await db.query(`UPDATE execution_lanes SET closed_reason=$1,closed_at=$2 WHERE lane='task'`, [reason, NOW]);
    await db.query(`UPDATE execution_lanes SET closed_reason=NULL,closed_at=NULL WHERE lane='task'`);
    await assert.rejects(db.query(`UPDATE execution_lanes SET closed_reason='unknown' WHERE lane='task'`), /check/);
    await assert.rejects(db.query(`UPDATE execution_lanes SET closed_at=1 WHERE lane='task'`), /check/);
    await assert.rejects(db.query(`UPDATE execution_lanes SET closed_reason='operator',closed_at=1 WHERE lane='task'`), /check/);
    await assert.rejects(db.query(`INSERT INTO execution_lanes(lane) VALUES ('chat')`), /check/);
    // 생성 열은 코드가 직접 쓸 수 없다.
    await assert.rejects(db.query(`UPDATE jobs SET execution_lane='interactive' WHERE id=$1`, [job]));
  } finally { await engine.close(); }
});
test('T18 B1 013: 새 열이 있어도 지금 코드의 슬롯·claim은 그대로다', async () => {
  const { db, pg: engine } = await localDatabase();
  try {
    const store = new Store(db, () => NOW);
    const job = await legacyJob(db, 'chat');
    const claimed = await store.claim();
    assert.equal(claimed?.id, job);
    assert.equal(claimed?.state, 'running');
    // 슬롯은 아직 레인으로 나누지 않았다. 작업 job이 대화 실행을 기다린다.
    await legacyJob(db, 'task');
    assert.equal(await store.claim(), undefined);
  } finally { await engine.close(); }
});
