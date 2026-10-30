import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { Postgres, migrate } from '../src/database.js';
import { typingStart } from '../src/typing.js';
import { event, fixture } from './helpers.js';

// fix-b G1 실제 PostgreSQL: 입력 중 힌트가 job 행 잠금을 오래 기다리지 않고 짧은 기한 안에 버려지는지 본다.
const socket = process.env.HOMELAB_TEST_PG_SOCKET;
const skip = socket ? false : 'HOMELAB_TEST_PG_SOCKET 없음(로컬 PostgreSQL 필요)';
const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

test('TYP-PG-01 실제 PostgreSQL: job 행이 잠겨 있으면 1.5초 안에 힌트를 버리고 작업은 그대로, 풀리면 다시 미룸', { skip }, async () => {
  const admin = new pg.Pool({ host: socket, user: 'postgres', database: 'postgres', max: 1 });
  const name = `typing_${randomUUID().replaceAll('-', '').slice(0, 12)}`;
  await admin.query(`CREATE DATABASE ${name}`);
  const pool = new pg.Pool({ host: socket, user: 'postgres', database: name, max: 4 });
  try {
    const db = new Postgres(pool);
    await migrate(db);
    const f = await fixture(db);
    const logs: string[] = [];
    const log = (name: string) => { logs.push(name); };
    await f.ingress.receive(event('m1'));
    f.advance(1000);
    const hint = { channel_id: 'fixture-thread', guild_id: 'fixture-guild', user_id: 'fixture-owner', timestamp: Math.floor(f.now() / 1000) };
    const before = (await db.query<{ available_at: string }>('SELECT available_at FROM jobs')).rows[0]!.available_at;
    // 다른 연결이 job 행을 쥔다(claim·accept가 잡고 있는 상황).
    const holder = await pool.connect();
    try {
      await holder.query('BEGIN');
      await holder.query('SELECT id FROM jobs FOR UPDATE');
      const started = Date.now();
      assert.equal(await typingStart(f.store, f.gate, hint, log), 0);
      const took = Date.now() - started;
      assert.ok(took < 1800, `took ${took}ms`);
      assert.deepEqual(logs, ['typing_hint_failed']);
    } finally { await holder.query('ROLLBACK'); holder.release(); }
    assert.equal((await db.query<{ available_at: string }>('SELECT available_at FROM jobs')).rows[0]!.available_at, before);
    assert.equal(await typingStart(f.store, f.gate, hint, log), 1);
  } finally {
    await pool.end();
    for (let attempt = 0; ; attempt++) {
      try { await admin.query(`DROP DATABASE ${name}`); break; } catch (error) {
        if (attempt >= 50 || !/being accessed by other users/.test((error as Error).message)) throw error;
        await sleep(100);
      }
    }
    await admin.end();
  }
});
