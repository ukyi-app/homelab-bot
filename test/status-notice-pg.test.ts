import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { DEFAULTS } from '../src/contracts.js';
import { Postgres, migrate } from '../src/database.js';
import type { Database } from '../src/database.js';
import { Store } from '../src/store.js';
import { event, fixture, thread } from './helpers.js';

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

// fix-a F1: 만료 처리 E가 대화 행을 선잠금한 뒤·UPDATE 전에 다른 job J의 lease가 끝나고, 같은 대화의 /cancel C가 대화 행을 잡는다.
// 수정 전에는 E의 UPDATE가 선잠금하지 않은 J를 잡고 안내 INSERT에서 C를 기다리며, C는 J를 기다려 순환한다.
// 수정 뒤에는 E가 선잠금 때 정한 후보에 한해서만 바꾸므로 J는 다음 바퀴가 처리한다.
function expiryHook(db: Database, model: boolean, onLocked: () => Promise<void>): Database {
  let armed = true;
  const wrap = (inner: Database, seen: string[]): Database => ({
    query: async <T>(sql: string, params?: unknown[]) => {
      const result = await inner.query<T>(sql, params);
      seen.push(sql);
      const lane = model ? seen.some(s => s.includes("type<>'read'")) : seen.some(s => s.includes("type='read'"));
      if (armed && lane && /FROM conversations WHERE id IN/.test(sql) && /FOR KEY SHARE/.test(sql)) { armed = false; await onLocked(); }
      return result;
    },
    transaction: (fn, deadline) => inner.transaction(tx => fn(wrap(tx, [])), deadline),
  });
  return wrap(db, []);
}
for (const lane of ['chat', 'read'] as const) {
  test(`fix-a F1 실제 PostgreSQL: ${lane} 만료 선잠금 뒤 lease가 끝난 job과 같은 대화 /cancel이 교착 없이 끝남`, { skip }, async () => {
    const { db, f, close } = await setup();
    try {
      let job;
      if (lane === 'chat') job = await running(f);
      else {
        await f.ingress.receive(event('read-1', { kind: 'command', command: 'read', target: 'fixture-service', text: 'fixture-status' }));
        job = (await f.store.claimRead())!;
      }
      assert.ok(job);
      // 다른 대화의 이미 만료된 job K. 선잠금 대상이 있어야 E가 실제로 대화 행을 잠근다.
      const other = { ...thread, channel: 'fixture-thread-other' };
      await f.ingress.receive(lane === 'chat' ? event('chat-other', { scope: other })
        : event('read-other', { scope: other, kind: 'command', command: 'read', target: 'fixture-service', text: 'fixture-status' }));
      const k = (await db.query<{ id: string }>(`UPDATE jobs SET state='running',attempt=1,lease_token=$2,lease_until=$3,started_at=$3
        WHERE conversation_id=$1 RETURNING id`, [f.store.scopeId(other), randomUUID(), f.now() - 1])).rows[0]!.id;
      const held = pausing(db, conversationLock);
      let cancel: Promise<unknown> | undefined;
      const expiring = new Store(expiryHook(db, lane === 'chat', async () => {
        // 선잠금은 끝났고 J는 아직 유효했다. 이제 lease가 끝나고 C가 대화 행을 잡는다.
        f.advance(DEFAULTS.leaseMs + 1);
        cancel = new Store(held.db, f.now).control(f.policy.owner, job.conversation_id, 'cancel', job.id);
        await held.paused;
        setTimeout(() => held.release(), 300);
      }), f.now).expire();
      const first = await Promise.allSettled([expiring]);
      const results = [...first, ...await Promise.allSettled([cancel!])];
      for (const result of results) assert.equal(result.status, 'fulfilled', result.status === 'rejected' ? String(result.reason) : '');
      assert.equal((await db.query<{ state: string }>('SELECT state FROM jobs WHERE id=$1', [job.id])).rows[0]!.state, 'cancel_requested');
      assert.equal((await db.query<{ state: string }>('SELECT state FROM jobs WHERE id=$1', [k])).rows[0]!.state,
        lane === 'chat' ? 'unknown' : 'failed');
      // 다음 바퀴가 J를 처리한다.
      await new Store(db, f.now).expire();
      assert.equal((await db.query<{ state: string }>('SELECT state FROM jobs WHERE id=$1', [job.id])).rows[0]!.state,
        lane === 'chat' ? 'unknown' : 'cancelled');
    } finally { await close(); }
  });
}
