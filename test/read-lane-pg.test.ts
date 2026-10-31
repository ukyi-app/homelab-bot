import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { Postgres, migrate } from '../src/database.js';
import type { Database } from '../src/database.js';
import { Store } from '../src/store.js';
import type { Scope } from '../src/contracts.js';
import { event, fixture, service, template, thread } from './helpers.js';

// impl-sched S1 실제 PostgreSQL 다중 연결 시험. 게시 서버 둘(구·신 RollingUpdate)이 동시에 read·모델 claim을 해도
// 같은 job을 두 번 잡지 않고, read 동시 1개·모델 동시 1개를 지키며, 제어 명령과 교착하지 않는다.
// HOMELAB_TEST_PG_SOCKET이 없으면 건너뛴다(test/review-9-pg.test.ts와 같은 방식).
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
  const name = `sched_${randomUUID().replaceAll('-', '').slice(0, 12)}`;
  await admin.query(`CREATE DATABASE ${name}`);
  // 게시 서버 둘을 서로 다른 풀로 흉내 낸다.
  const pools = [new pg.Pool({ host: socket, user: 'postgres', database: name, max: 6 }),
    new pg.Pool({ host: socket, user: 'postgres', database: name, max: 6 })];
  const [a, b] = pools.map(pool => new Postgres(pool)) as [Postgres, Postgres];
  await migrate(a);
  const f = await fixture(a);
  return { a, b, f, close: async () => {
    await Promise.all(pools.map(pool => pool.end()));
    for (let attempt = 0; ; attempt++) {
      try { await admin.query(`DROP DATABASE ${name}`); break; } catch (error) {
        if (attempt >= 50 || !/being accessed by other users/.test((error as Error).message)) throw error;
        await sleep(100);
      }
    }
    await admin.end();
  } };
}
const scope = (i: number): Scope => ({ ...thread, channel: `fixture-thread-${i}` });

test('S1 실제 PostgreSQL: 게시 서버 둘이 동시에 read·모델 claim해도 중복 없이 read 1개·모델 1개', { skip }, async () => {
  const { a, b, f, close } = await setup();
  try {
    for (let i = 0; i < 4; i++) {
      await f.ingress.receive(event(`read-${i}`, { scope: scope(i), kind: 'command', command: 'read', target: service.id, text: template.id }));
      await f.ingress.receive(event(`chat-${i}`, { scope: scope(i), urgent: true, kind: 'command', command: 'urgent' }));
    }
    const stores = [new Store(a, f.now), new Store(b, f.now)];
    const claims = await Promise.all(Array.from({ length: 6 }, (_, i) => [stores[i % 2]!.claimRead(), stores[i % 2]!.claim()]).flat());
    const claimed = claims.filter(job => job !== undefined);
    assert.equal(new Set(claimed.map(job => job.id)).size, claimed.length, '같은 job을 두 번 잡음');
    const running = (await a.query<{ type: string }>("SELECT type FROM jobs WHERE state='running'")).rows;
    assert.equal(running.filter(row => row.type === 'read').length, 1);
    assert.equal(running.filter(row => row.type !== 'read').length, 1);
    assert.equal(claimed.length, 2);
  } finally { await close(); }
});

test('S1 실제 PostgreSQL: read claim이 잠금을 쥔 동안 /cancel·/model-status·accept가 교착 없이 끝남', { skip }, async () => {
  const { a, b, f, close } = await setup();
  try {
    await f.ingress.receive(event('read-1', { kind: 'command', command: 'read', target: service.id, text: template.id }));
    const readJob = (await a.query<{ id: string }>("SELECT id FROM jobs WHERE type='read'")).rows[0]!.id;
    const conversation = f.store.scopeId(thread);
    // A: read claim이 read_lane 행과 job 행을 쥔 채 커밋 전에 멈춘다.
    const held = pausing(a, sql => sql.startsWith("UPDATE jobs SET state='running'"));
    const claiming = new Store(held.db, f.now).claimRead();
    await held.paused;
    // B: 같은 대화의 제어 명령(대화 행 → scheduler 행 → job 행)과 새 수락(대화 행 → scheduler 행).
    const other = new Store(b, f.now);
    const saved = await other.save(event('chat-1'), f.policy.revision, true);
    const work = [other.control(f.policy.owner, conversation, 'model-status'), other.control(f.policy.owner, conversation, 'cancel', readJob),
      other.accept(saved.id, 'chat', f.policy.revision)];
    await sleep(300);
    held.release();
    const results = await Promise.allSettled([claiming, ...work]);
    for (const result of results) assert.equal(result.status, 'fulfilled', result.status === 'rejected' ? String(result.reason) : '');
    assert.equal((await a.query<{ state: string }>('SELECT state FROM jobs WHERE id=$1', [readJob])).rows[0]!.state, 'cancel_requested');
  } finally { await close(); }
});

test('S1 실제 PostgreSQL: /cancel이 대화·scheduler 행을 쥔 동안에도 read claim은 기다리지 않음', { skip }, async () => {
  const { a, b, f, close } = await setup();
  try {
    await f.ingress.receive(event('read-1', { kind: 'command', command: 'read', target: service.id, text: template.id }));
    await f.ingress.receive(event('read-2', { scope: scope(2), kind: 'command', command: 'read', target: service.id, text: template.id }));
    const held = pausing(a, sql => sql.startsWith("SELECT * FROM controls WHERE key='scheduler' FOR UPDATE"));
    const status = new Store(held.db, f.now).control(f.policy.owner, f.store.scopeId(thread), 'model-status');
    await held.paused;
    const started = Date.now();
    const claimed = await new Store(b, f.now).claimRead();
    assert.ok(claimed, 'read claim 실패');
    assert.ok(Date.now() - started < 900, '스케줄러 잠금을 기다렸다');
    held.release();
    await status;
  } finally { await close(); }
});
