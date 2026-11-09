import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { CHANGE_RETENTION_MS, ChangeStore, purgeExpiredChangeContent } from '../src/change-store.js';
import type { ChangeRequest } from '../src/change-store.js';
import type { Database, QueryResult } from '../src/database.js';
import { Postgres } from '../src/database.js';
import { runMigrations } from '../src/migrate-main.js';
import { driveTo, failure, git, hex, insertChildJob, ok, seedConversation } from './change-store-fixture.js';
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

const SCENARIOS: [string, (e: Env) => Promise<void>][] = [
  ['오래된 후보를 고른 뒤 새 generation이 열렸다 다시 끝나면 새 데이터가 남고, 새 종료 + 7일에 지운다', reopenedAndEndedAgain],
  ['observing_deploy 후보를 고른 뒤 배포 관측이 미확정으로 바뀌면 남고, 새 관측 + 7일에 지운다', deploymentObservedAgain],
  ['후보를 고른 뒤 끝나지 않은 자식 job이 생기면 남고, 자식이 끝나면 지운다', childJobAppeared],
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
