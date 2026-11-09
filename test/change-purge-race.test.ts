import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { CHANGE_RETENTION_MS, ChangeStore, purgeExpiredChangeContent } from '../src/change-store.js';
import type { ChangeRequest } from '../src/change-store.js';
import { ClaudeChangeAuthor, ClaudeTaskBridge } from '../src/claude-task-bridge.js';
import type { ChangeAuthorDeps, TaskPlanSource } from '../src/claude-task-bridge.js';
import type { Job } from '../src/contracts.js';
import type { Database, QueryResult } from '../src/database.js';
import { Postgres } from '../src/database.js';
import { runMigrations } from '../src/migrate-main.js';
import type { PolicyGate } from '../src/policy.js';
import { Store } from '../src/store.js';
import type { TaskWorkerPort } from '../src/task-bridge.js';
import type { TaskV2Request } from '../src/task-contracts.js';
import { CONVERSATION, driveTo, failure, fixtureManifest, fixtureManifestFiles, fixturePatch, git, hex, insertChildJob, ok, seedConversation } from './change-store-fixture.js';
import { localDatabase } from './helpers.js';

// CHANGE 보존 정리의 선정과 삭제 사이 경합(A09, DECISIONS T31). 선정은 잠금 밖이라 그사이 합법적인 상태 전이를 끼워 넣고,
// 정리가 부모 잠금 뒤 선정 조건 전체를 다시 봐서 새로 시작된 보존 기간의 데이터를 남기는지 본다.
const DAY = 86_400_000;
const T = 1_800_000_000_000;

interface Env { purgeDb: Database; ownerDb: Database; store: ChangeStore; clock: { now: number }; close: () => Promise<void> }

// 정리의 후보 선정 질의가 돌아온 직후, 부모를 잠그기 전에 between을 한 번 끼운다.
function pauseAfterSelect(db: Database, between: () => Promise<void>): Database {
  let fired = false;
  return {
    transaction: (fn, deadline) => db.transaction(fn, deadline),
    query: async <T>(sql: string, params?: unknown[]): Promise<QueryResult<T>> => {
      const result = await db.query<T>(sql, params);
      if (!fired && sql.startsWith('SELECT r.id FROM change_requests r')) { fired = true; await between(); }
      return result;
    },
  };
}
// 정리 트랜잭션이 부모를 잠그고 조건을 다시 본 직후(지우기 전)에 during을 한 번 끼운다.
function pauseInsideLock(db: Database, during: () => Promise<void>): Database {
  let fired = false;
  return {
    query: (sql, params) => db.query(sql, params),
    transaction: (fn, deadline) => db.transaction(tx => fn({
      transaction: tx.transaction,
      query: async <T>(sql: string, params?: unknown[]): Promise<QueryResult<T>> => {
        const result = await tx.query<T>(sql, params);
        if (!fired && sql.includes('AND r.id=$2')) { fired = true; await during(); }
        return result;
      },
    }), deadline),
  };
}

async function held(db: Database, id: string) {
  const artifacts = (await db.query<{ generation: number; purged_at: string | null }>('SELECT generation,purged_at FROM change_artifacts WHERE change_id=$1 ORDER BY generation', [id])).rows;
  const inputs = (await db.query<{ purged_at: string | null }>('SELECT purged_at FROM change_request_inputs WHERE change_id=$1', [id])).rows;
  const brief = (await db.query<{ brief_purged_at: string | null }>('SELECT brief_purged_at FROM change_requests WHERE id=$1', [id])).rows[0]!;
  return {
    artifacts: artifacts.map(row => ({ generation: Number(row.generation), purged: row.purged_at !== null })),
    inputsPurged: inputs.length > 0 && inputs.every(row => row.purged_at !== null),
    inputsHeld: inputs.length > 0 && inputs.every(row => row.purged_at === null),
    briefPurged: brief.brief_purged_at !== null,
  };
}
async function assertHeld(db: Database, id: string, generations: number) {
  const state = await held(db, id);
  assert.deepEqual(state.artifacts, Array.from({ length: generations }, (_, i) => ({ generation: i + 1, purged: false })));
  assert.equal(state.inputsHeld, true, '요청 원문이 남는다');
  assert.equal(state.briefPurged, false, 'brief가 남는다');
}
async function assertPurged(db: Database, id: string) {
  const state = await held(db, id);
  assert.ok(state.artifacts.length > 0 && state.artifacts.every(row => row.purged), 'artifact를 비운다');
  assert.equal(state.inputsPurged, true, '요청 원문을 비운다');
  assert.equal(state.briefPurged, true, 'brief를 비운다');
}
async function superseded(e: Env): Promise<ChangeRequest> {
  const r = await driveTo(e.store, 'snapshot_ready');
  ok(await e.store.transition({ changeId: r.id, generation: 1, from: 'snapshot_ready', to: 'superseded', reason: 'base_moved' }));
  return r;
}

// ---- 시나리오. PGlite와 실제 PostgreSQL 두 연결이 같은 순서를 돈다. ----

async function reopenedAndEndedAgain(e: Env) {
  e.clock.now = T;
  const r = await superseded(e);
  e.clock.now = T + 8 * DAY;
  const purged = await purgeExpiredChangeContent(pauseAfterSelect(e.purgeDb, async () => {
    const next = ok(await e.store.startNextGeneration({ changeId: r.id, generation: 1 }));
    await driveTo(e.store, 'snapshot_ready', next, 2);
    ok(await e.store.transition({ changeId: r.id, generation: 2, from: 'snapshot_ready', to: 'superseded', reason: 'base_moved' }));
  }), e.clock.now);
  const endedAgain = e.clock.now;
  assert.equal(purged, 0, '고른 뒤 새로 끝난 건은 지우지 않는다');
  const current = ok(await e.store.get(r.id));
  assert.equal(current.generation, 2);
  assert.equal(current.phase, 'superseded');
  await assertHeld(e.ownerDb, r.id, 2);

  assert.equal(await purgeExpiredChangeContent(e.purgeDb, endedAgain + CHANGE_RETENTION_MS - 1), 0, '새 종료 + 7일 1ms 전');
  await assertHeld(e.ownerDb, r.id, 2);
  assert.equal(await purgeExpiredChangeContent(e.purgeDb, endedAgain + CHANGE_RETENTION_MS), 1, '새 종료 + 7일');
  await assertPurged(e.ownerDb, r.id);
  e.clock.now = endedAgain + CHANGE_RETENTION_MS;
  failure(await e.store.startNextGeneration({ changeId: r.id, generation: 2 }), 'input_purged');
}

const observation = (state: 'observed' | 'unknown', at: number) => state === 'observed'
  ? { state, headSha: git('h'), mergeCommit: git('m'), configCommit: git('k'), imageDigest: `sha256:${hex('d')}`, argoObservedAt: at, workloadObservedAt: at, observedAt: at, reason: null }
  : { state, headSha: git('h'), mergeCommit: git('m'), configCommit: null, imageDigest: null, argoObservedAt: null, workloadObservedAt: null, observedAt: at, reason: null };

async function deploymentObservedAgain(e: Env) {
  e.clock.now = T;
  const r = await driveTo(e.store, 'observing_deploy');
  ok(await e.store.recordDeployment({ changeId: r.id, generation: 1, observation: observation('observed', T) }));
  e.clock.now = T + 8 * DAY;
  // 고른 뒤 더 새 관측이 들어와 배포가 다시 미확정이 된다.
  const purged = await purgeExpiredChangeContent(pauseAfterSelect(e.purgeDb, async () => {
    ok(await e.store.recordDeployment({ changeId: r.id, generation: 1, observation: observation('unknown', e.clock.now) }));
  }), e.clock.now);
  assert.equal(purged, 0, '배포 관측이 바뀐 건은 지우지 않는다');
  await assertHeld(e.ownerDb, r.id, 1);
  assert.equal(await purgeExpiredChangeContent(e.purgeDb, T + 30 * DAY), 0, '미확정 배포는 기간이 지나도 고르지 않는다');

  const observedAgain = T + 9 * DAY;
  ok(await e.store.recordDeployment({ changeId: r.id, generation: 1, observation: observation('observed', observedAgain) }));
  assert.equal(await purgeExpiredChangeContent(e.purgeDb, observedAgain + CHANGE_RETENTION_MS - 1), 0, '새 관측 + 7일 1ms 전');
  await assertHeld(e.ownerDb, r.id, 1);
  assert.equal(await purgeExpiredChangeContent(e.purgeDb, observedAgain + CHANGE_RETENTION_MS), 1, '새 관측 + 7일');
  await assertPurged(e.ownerDb, r.id);
}

async function childJobAppeared(e: Env) {
  e.clock.now = T;
  const r = await superseded(e);
  e.clock.now = T + 8 * DAY;
  const child = `race-child-${randomUUID()}`;
  const purged = await purgeExpiredChangeContent(pauseAfterSelect(e.purgeDb, async () => {
    await insertChildJob(e.ownerDb, child);
    await e.ownerDb.query(`UPDATE jobs SET state='queued',finished_at=NULL WHERE id=$1`, [child]);
    ok(await e.store.linkChildJob({ changeId: r.id, generation: 1, jobId: child, role: 'author' }));
  }), e.clock.now);
  assert.equal(purged, 0, '고른 뒤 끝나지 않은 자식 job이 생긴 건은 지우지 않는다');
  await assertHeld(e.ownerDb, r.id, 1);

  await e.ownerDb.query(`UPDATE jobs SET state='succeeded',finished_at=$2 WHERE id=$1`, [child, e.clock.now]);
  assert.equal(await purgeExpiredChangeContent(e.purgeDb, e.clock.now), 1, '자식이 끝나면 원래 기준 시각으로 지운다');
  await assertPurged(e.ownerDb, r.id);
}

interface Session { state: string; cleanup_state: string; session_retained: boolean }
const sessionOf = async (db: Database, job: string) =>
  (await db.query<Session>('SELECT state,cleanup_state,session_retained FROM codex_sessions WHERE job_id=$1', [job])).rows[0];
const WORKER = { instance: '11111111-1111-4111-8111-111111111111', storage: '22222222-2222-4222-8222-222222222222' };
type WorkerAnswer = 'unavailable' | 'finalized';
interface FinalizingAuthor { change: ChangeRequest; job: string; answer: (reply: WorkerAnswer) => Promise<void> }

// 작성 자식을 실제 ClaudeChangeAuthor.finalize로 끝내되, finalizeJob이 작업자에 status를 묻는 데서 세운다.
// 이때 세션은 completed로 커밋됐고 cleanup_state는 아직 none, 작업자 공간은 남아 session_retained=true다.
// answer가 작업자 답을 정한다: unavailable이면 finalizeJob이 부모 잠금 없이 pending을 쓰고, finalized면 cleaned·retained false를 쓴다.
// 부모는 T에 superseded로 끝났고 finalize는 T+8일에 돈다. 같은 흐름이 프로세스 중단으로 끊기면 세션은 이 상태로 sweep까지 남는다.
async function finalizingAuthor(e: Env): Promise<FinalizingAuthor> {
  e.clock.now = T;
  const change = await driveTo(e.store, 'authoring');
  const job = randomUUID(), lease = randomUUID(), sessionId = randomUUID();
  await insertChildJob(e.ownerDb, job, 'task');
  await e.ownerDb.query(`UPDATE jobs SET state='running',finished_at=NULL,conversation_id=$2,lease_token=$3,lease_until=$4,started_at=$5 WHERE id=$1`,
    [job, CONVERSATION, lease, T + 30 * DAY, T]);
  ok(await e.store.linkChildJob({ changeId: change.id, generation: 1, jobId: job, role: 'author' }));

  let asked!: () => void, reply!: (value: WorkerAnswer) => void;
  const statusAsked = new Promise<void>(resolve => { asked = resolve; });
  const replied = new Promise<WorkerAnswer>(resolve => { reply = resolve; });
  const worker = {
    call: async (endpoint: string, body: { job: string; lease: string; generation: number; sessionId: string }) => {
      if (endpoint !== '/v1/task/status') throw new Error(`unexpected_endpoint:${endpoint}`);
      asked();
      if (await replied === 'unavailable') throw new Error('fixture_worker_unavailable');
      return { version: 1, job: body.job, lease: body.lease, generation: body.generation, sessionId: body.sessionId, worker: WORKER,
        state: 'finalized', turn: 1, sessionExists: false, stopped: true };
    },
  } as unknown as TaskWorkerPort;
  const store = new Store(e.ownerDb, () => e.clock.now);
  const bridge = new ClaudeTaskBridge(store, {} as PolicyGate, worker, {} as TaskPlanSource, { log: () => {} });
  const row = (await e.ownerDb.query<Job>('SELECT * FROM jobs WHERE id=$1', [job])).rows[0]!;
  const begun = await bridge.beginChangeTurn(row, { operation: 'start', sessionId, generation: 1, lease, repository: 'ukyi-app/homelab-smoke', base: git('b'),
    policyRevision: 'fixture-policy-1', project: { id: 'fixture-project', revision: 'fixture-project-1' }, timeoutMs: 1000, runBudgetRemainingMs: 1000 } as TaskV2Request, undefined);
  assert.equal(begun, 'started');
  ok(await e.store.recordSnapshot({ changeId: change.id, generation: 1, manifest: fixtureManifest(), files: fixtureManifestFiles(), patch: fixturePatch(), transportBytes: 4096 }));
  ok(await e.store.transition({ changeId: change.id, generation: 1, from: 'snapshot_ready', to: 'superseded', reason: 'base_moved' }));

  e.clock.now = T + 8 * DAY;
  const author = new ClaudeChangeAuthor({ store, bridge, source: { keyOf: async () => ({ changeId: change.id, generation: 1 }) },
    artifacts: { load: async (key: { changeId: string; generation: number }) => ok(await e.store.loadArtifact(key)) } } as unknown as ChangeAuthorDeps);
  const finalizing = author.finalize(`v2:${job}:1`);
  await statusAsked;
  assert.deepEqual(await sessionOf(e.ownerDb, job), { state: 'completed', cleanup_state: 'none', session_retained: true });
  assert.equal((await e.ownerDb.query<{ state: string }>('SELECT state FROM jobs WHERE id=$1', [job])).rows[0]!.state, 'succeeded');
  return { change, job, answer: async value => { reply(value); await finalizing; } };
}

async function retainedSessionHeld(e: Env) {
  const f = await finalizingAuthor(e);
  assert.equal(await purgeExpiredChangeContent(e.purgeDb, e.clock.now), 0, '작업자 공간을 아직 안 지운 세션이 있는 건은 고르지 않는다');
  await assertHeld(e.ownerDb, f.change.id, 1);

  await f.answer('finalized');
  assert.deepEqual(await sessionOf(e.ownerDb, f.job), { state: 'completed', cleanup_state: 'cleaned', session_retained: false });
  assert.equal(await purgeExpiredChangeContent(e.purgeDb, T + CHANGE_RETENTION_MS - 1), 0, '종료 + 7일 1ms 전');
  await assertHeld(e.ownerDb, f.change.id, 1);
  assert.equal(await purgeExpiredChangeContent(e.purgeDb, T + CHANGE_RETENTION_MS), 1, '정리가 확인되면 원래 종료 시각 + 7일에 지운다');
  await assertPurged(e.ownerDb, f.change.id);
}

const SCENARIOS: [string, (e: Env) => Promise<void>][] = [
  ['오래된 후보를 고른 뒤 새 generation이 열렸다 다시 끝나면 새 데이터가 남고, 새 종료 + 7일에 지운다', reopenedAndEndedAgain],
  ['observing_deploy 후보를 고른 뒤 배포 관측이 미확정으로 바뀌면 남고, 새 관측 + 7일에 지운다', deploymentObservedAgain],
  ['후보를 고른 뒤 끝나지 않은 자식 job이 생기면 남고, 자식이 끝나면 지운다', childJobAppeared],
  ['작성 세션이 completed로 끝났지만 작업자 공간을 아직 안 지웠으면 남고, 정리가 확인되면 원래 종료 + 7일에 지운다', retainedSessionHeld],
];

async function localEnv(): Promise<Env> {
  const { db, pg: engine } = await localDatabase();
  await seedConversation(db);
  const clock = { now: T };
  return { purgeDb: db, ownerDb: db, clock, store: new ChangeStore(db, () => clock.now), close: () => engine.close() };
}
for (const [name, scenario] of SCENARIOS) {
  test(`정리 경합(PGlite): ${name}`, async () => {
    const e = await localEnv();
    try { await scenario(e); } finally { await e.close(); }
  });
}

// ---- 실제 PostgreSQL: 정리와 owner가 서로 다른 연결 ----

const socket = process.env.HOMELAB_TEST_PG_SOCKET;
const skip = socket ? false : 'HOMELAB_TEST_PG_SOCKET 없음(로컬 PostgreSQL 필요)';
async function pgEnv(): Promise<Env> {
  const admin = new pg.Pool({ host: socket, user: 'postgres', database: 'postgres', max: 1 });
  const name = `t32_${randomUUID().replaceAll('-', '').slice(0, 12)}`;
  await admin.query(`CREATE DATABASE ${name}`);
  const purgePool = new pg.Pool({ host: socket, user: 'postgres', database: name, max: 1 });
  const ownerPool = new pg.Pool({ host: socket, user: 'postgres', database: name, max: 2 });
  await runMigrations(ownerPool);
  const ownerDb = new Postgres(ownerPool);
  await seedConversation(ownerDb);
  const clock = { now: T };
  return {
    purgeDb: new Postgres(purgePool), ownerDb, clock, store: new ChangeStore(ownerDb, () => clock.now),
    close: async () => { await purgePool.end(); await ownerPool.end(); await admin.query(`DROP DATABASE ${name}`); await admin.end(); },
  };
}
for (const [name, scenario] of SCENARIOS) {
  test(`정리 경합(실제 PostgreSQL 두 연결): ${name}`, { skip }, async () => {
    const e = await pgEnv();
    try { await scenario(e); } finally { await e.close(); }
  });
}

test('정리 경합(실제 PostgreSQL 두 연결): 재검사 뒤 커밋 전에는 다른 연결의 자식 job 연결이 부모 잠금에서 기다린다', { skip }, async () => {
  const e = await pgEnv();
  try {
    e.clock.now = T;
    const r = await superseded(e);
    e.clock.now = T + 8 * DAY;
    const child = `race-child-${randomUUID()}`;
    await insertChildJob(e.ownerDb, child);
    const order: string[] = [];
    let link: Promise<unknown> | undefined;
    const purged = await purgeExpiredChangeContent(pauseInsideLock(e.purgeDb, async () => {
      link = e.store.linkChildJob({ changeId: r.id, generation: 1, jobId: child, role: 'author' }).then(result => { order.push('linked'); return result; });
      await new Promise(resolve => setTimeout(resolve, 200));
      order.push('purge_continues');
    }), e.clock.now);
    order.push('purge_committed');
    ok(await link as Awaited<ReturnType<ChangeStore['linkChildJob']>>);
    assert.equal(purged, 1);
    assert.deepEqual(order, ['purge_continues', 'purge_committed', 'linked']);
    await assertPurged(e.ownerDb, r.id);
  } finally { await e.close(); }
});

// finalizeJob의 pending 쓰기는 execution_lanes만 잠그고 부모는 잠그지 않아 정리의 부모 잠금과 직렬화되지 않는다.
// 정리가 지우지 않는 근거는 그 전부터 세션이 session_retained로 제외돼 있다는 것이다. 후보로 고르지 않으면 재검사 지점에 닿지 않으므로,
// after_recheck에서 끼울 자리가 오지 않으면 정리가 끝난 뒤 pending을 커밋해 같은 끝 상태를 확인한다.
for (const at of ['before_lock', 'after_recheck'] as const) {
  test(`정리 경합(실제 PostgreSQL 두 연결): 작성 세션의 cleanup pending이 ${at === 'before_lock' ? '부모 잠금 전' : '재검사 뒤 커밋 전'}에 커밋돼도 지우지 않는다`, { skip }, async () => {
    const e = await pgEnv();
    try {
      const f = await finalizingAuthor(e);
      let fired = false;
      const commitPending = async () => {
        fired = true;
        await f.answer('unavailable');
        assert.deepEqual(await sessionOf(e.ownerDb, f.job), { state: 'completed', cleanup_state: 'pending', session_retained: true });
      };
      const purgeDb = at === 'before_lock' ? pauseAfterSelect(e.purgeDb, commitPending) : pauseInsideLock(e.purgeDb, commitPending);
      const purged = await purgeExpiredChangeContent(purgeDb, e.clock.now);
      if (!fired) await commitPending();
      assert.equal(purged, 0);
      await assertHeld(e.ownerDb, f.change.id, 1);
      assert.equal(ok(await e.store.startNextGeneration({ changeId: f.change.id, generation: 1 })).generation, 2, '다음 generation이 input_purged로 막히지 않는다');
    } finally { await e.close(); }
  });
}
