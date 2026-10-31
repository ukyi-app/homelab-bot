import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { DEFAULTS } from '../src/contracts.js';
import { Postgres, migrate } from '../src/database.js';
import type { Database } from '../src/database.js';
import { MODEL_QUEUE_LIMIT, Store } from '../src/store.js';
import type { Scope } from '../src/contracts.js';
import { event, fixture, thread } from './helpers.js';

// 실제 PostgreSQL 다중 연결 잠금 시험이다. PGlite는 transaction을 직렬화해 행 잠금 대기를 만들 수 없다.
// HOMELAB_TEST_PG_SOCKET(유닉스 소켓 디렉터리)이 없으면 건너뛴다. 실행 방법은 VERIFICATION T20 절과 같다.
const socket = process.env.HOMELAB_TEST_PG_SOCKET;
const skip = socket ? false : 'HOMELAB_TEST_PG_SOCKET 없음(로컬 PostgreSQL 필요)';
const other: Scope = { ...thread, channel: 'fixture-thread-2' };
const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
// 일치하는 질의가 돌아온 직후 한 번 멈춘다. 그 transaction은 잠금을 쥔 채 열려 있고, 그동안 다른 연결의 작업을 끼워 넣는다.
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
  const name = `t16b_${randomUUID().replaceAll('-', '').slice(0, 12)}`;
  await admin.query(`CREATE DATABASE ${name}`);
  const pool = new pg.Pool({ host: socket, user: 'postgres', database: name, max: 6 });
  const db = new Postgres(pool);
  await migrate(db);
  const f = await fixture(db);
  await db.query("INSERT INTO controls VALUES ('scheduler','false') ON CONFLICT DO NOTHING");
  return { db, f, close: async () => {
    await pool.end();
    // 풀을 닫은 직후에는 세션이 남아 있을 수 있다. 빠질 때까지 다시 시도한다.
    for (let attempt = 0; ; attempt++) {
      try { await admin.query(`DROP DATABASE ${name}`); break; } catch (error) {
        if (attempt >= 50 || !/being accessed by other users/.test((error as Error).message)) throw error;
        await sleep(100);
      }
    }
    await admin.end();
  } };
}

test('T16a 변경 요청 6 실제 PostgreSQL: /model-status가 대화 행을 잡은 사이 accept()도 잠금 시간 초과 없이 둘 다 끝남', { skip }, async () => {
  const { db, f, close } = await setup();
  try {
    const conversation = f.store.scopeId(thread);
    const saved = await f.store.save(event('pg-accept'), f.policy.revision, true);
    // A: /model-status가 대화 행 FOR UPDATE를 쥔 채 멈춘다. 다음에 스케줄러 행을 기다린다.
    const held = pausing(db, sql => /FROM conversations WHERE id=\$1 FOR UPDATE/.test(sql));
    const status = new Store(held.db, f.now).control(f.policy.owner, conversation, 'model-status');
    await held.paused;
    // B: 수정 전 accept()는 스케줄러를 먼저 쥐고 jobs 외래 키 검사로 대화 행을 기다려 A와 교착했다(55P03).
    const accepting = new Store(db, f.now).accept(saved.id, 'chat', f.policy.revision);
    await sleep(300);
    held.release();
    const [a, b] = await Promise.allSettled([status, accepting]);
    assert.equal(a.status, 'fulfilled', a.status === 'rejected' ? String(a.reason) : '');
    assert.equal(b.status, 'fulfilled', b.status === 'rejected' ? String(b.reason) : '');
    assert.equal((await db.query('SELECT id FROM jobs')).rows.length, 1);
  } finally { await close(); }
});

test('4316750325 실제 PostgreSQL: 서로 다른 대화의 동시 /retry도 queued 상한을 넘지 않음', { skip }, async () => {
  const { db, f, close } = await setup();
  try {
    const failed: string[] = [];
    for (const [id, scope] of [['pg-retry-a', thread], ['pg-retry-b', other]] as const) {
      const saved = await f.store.save(event(id, { kind: 'command', command: 'task', scope }), f.policy.revision, true);
      failed.push(await f.store.accept(saved.id, 'task', f.policy.revision));
    }
    await db.query("UPDATE jobs SET state='failed',attempt=1");
    for (let i = 0; i < MODEL_QUEUE_LIMIT - 1; i++) {
      const saved = await f.store.save(event(`pg-queue-${i}`, { kind: 'command', command: 'task' }), f.policy.revision, false);
      await f.store.accept(saved.id, 'task', f.policy.revision);
    }
    // A: 첫 재시도가 상태를 바꾼 직후 커밋 전에 멈춘다. 수정 뒤에는 스케줄러 행을 쥐고 있어 B가 기다린다.
    const held = pausing(db, sql => sql.startsWith("UPDATE jobs SET state='queued',available_at=$4,wait_reason=NULL"));
    const first = new Store(held.db, f.now).control(f.policy.owner, f.store.scopeId(thread), 'retry', failed[0]) as Promise<{ ok?: boolean }>;
    await held.paused;
    const second = new Store(db, f.now).control(f.policy.owner, f.store.scopeId(other), 'retry', failed[1]) as Promise<{ ok?: boolean }>;
    await sleep(300);
    held.release();
    const results = await Promise.all([first, second]);
    assert.deepEqual(results.map(r => r.ok !== false), [true, false]);
    const queued = (await db.query<{ count: string }>("SELECT count(*) FROM jobs WHERE state='queued'")).rows[0]!;
    assert.equal(Number(queued.count), MODEL_QUEUE_LIMIT);
  } finally { await close(); }
});
