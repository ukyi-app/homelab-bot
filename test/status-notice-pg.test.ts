import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { DEFAULTS } from '../src/contracts.js';
import { Postgres, migrate } from '../src/database.js';
import type { Database } from '../src/database.js';
import { Store } from '../src/store.js';
import { event, fixture } from './helpers.js';

// impl-sched S4 실제 PostgreSQL: 상태 안내 삽입(outbox 외래 키 → 대화 행 KEY SHARE)이 제어 경로
// (대화 행 FOR UPDATE → scheduler 행 → job 행)와 반대 순서로 잠그지 않는지 본다. 뒤집히면 교착(40P01)이나 잠금 시간 초과(55P03)다.
const socket = process.env.HOMELAB_TEST_PG_SOCKET;
const skip = socket ? false : 'HOMELAB_TEST_PG_SOCKET 없음(로컬 PostgreSQL 필요)';
const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
function pausing(db: Database, match: (sql: string) => boolean) {
  let armed = true;
  let reached!: () => void;
  let release!: () => void;
  const paused = new Promise<void>(resolve => { reached = resolve; });
  const gate = new Promise<void>(resolve => { release = resolve; });
  const wrap = (inner: Database): Database => ({
    query: async <T>(sql: string, params?: unknown[]) => {
      const result = await inner.query<T>(sql, params);
      if (armed && match(sql)) { armed = false; reached(); await gate; }
      return result;
    },
    transaction: (fn, deadline) => inner.transaction(tx => fn(wrap(tx)), deadline),
  });
  return { db: wrap(db), paused, release: () => release() };
}
async function setup() {
  const admin = new pg.Pool({ host: socket, user: 'postgres', database: 'postgres', max: 1 });
  const name = `notice_${randomUUID().replaceAll('-', '').slice(0, 12)}`;
  await admin.query(`CREATE DATABASE ${name}`);
  const pool = new pg.Pool({ host: socket, user: 'postgres', database: name, max: 6 });
  const db = new Postgres(pool);
  await migrate(db);
  const f = await fixture(db);
  return { db, f, close: async () => {
    await pool.end();
    for (let attempt = 0; ; attempt++) {
      try { await admin.query(`DROP DATABASE ${name}`); break; } catch (error) {
        if (attempt >= 50 || !/being accessed by other users/.test((error as Error).message)) throw error;
        await sleep(100);
      }
    }
    await admin.end();
  } };
}
async function running(f: Awaited<ReturnType<typeof fixture>>) {
  await f.ingress.receive(event('chat')); f.advance(DEFAULTS.debounceMs);
  return (await f.store.claim())!;
}
const conversationLock = (sql: string) => /FROM conversations WHERE id=\$1 FOR UPDATE/.test(sql);

test('S4 실제 PostgreSQL: /cancel이 대화 행을 쥔 사이 lease 만료 unknown 안내도 교착 없이 끝남', { skip }, async () => {
  const { db, f, close } = await setup();
  try {
    const job = await running(f);
    f.advance(DEFAULTS.leaseMs + 1);
    const held = pausing(db, conversationLock);
    const cancel = new Store(held.db, f.now).control(f.policy.owner, job.conversation_id, 'cancel', job.id);
    await held.paused;
    const expiring = new Store(db, f.now).expire();
    await sleep(300);
    held.release();
    const results = await Promise.allSettled([cancel, expiring]);
    for (const result of results) assert.equal(result.status, 'fulfilled', result.status === 'rejected' ? String(result.reason) : '');
  } finally { await close(); }
});

test('S4 실제 PostgreSQL: /model-status가 대화 행을 쥔 사이 waiting_user 안내도 교착 없이 끝남', { skip }, async () => {
  const { db, f, close } = await setup();
  try {
    const job = await running(f);
    const held = pausing(db, conversationLock);
    const status = new Store(held.db, f.now).control(f.policy.owner, job.conversation_id, 'model-status');
    await held.paused;
    const waiting = new Store(db, f.now).waitForUser(job, 'model_limit');
    await sleep(300);
    held.release();
    const results = await Promise.allSettled([status, waiting]);
    for (const result of results) assert.equal(result.status, 'fulfilled', result.status === 'rejected' ? String(result.reason) : '');
    assert.equal((await db.query<{ count: string }>("SELECT count(*) FROM outbox WHERE idempotency_key LIKE 'waiting:%'")).rows[0]!.count, '1');
  } finally { await close(); }
});

test('S4 실제 PostgreSQL: /cancel이 대화 행을 쥔 사이 runtime의 unknown 기록도 교착 없이 끝남', { skip }, async () => {
  const { db, f, close } = await setup();
  try {
    const job = await running(f);
    const held = pausing(db, conversationLock);
    const cancel = new Store(held.db, f.now).control(f.policy.owner, job.conversation_id, 'cancel', job.id);
    await held.paused;
    const marking = new Store(db, f.now).transition(job, 'unknown', 'worker_disconnected');
    await sleep(300);
    held.release();
    const results = await Promise.allSettled([cancel, marking]);
    for (const result of results) assert.equal(result.status, 'fulfilled', result.status === 'rejected' ? String(result.reason) : '');
  } finally { await close(); }
});
