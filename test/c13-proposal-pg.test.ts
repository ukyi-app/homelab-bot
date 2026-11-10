import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { Postgres, migrate } from '../src/database.js';
import type { Database } from '../src/database.js';
import { PROPOSAL_TEXT } from '../src/proposals.js';
import { Store } from '../src/store.js';
import { harness, PROJECT } from './c13-proposal-fixture.js';

// C13 실행 확인 버튼의 중복 클릭. 실제 PostgreSQL 두 연결에서 첫 클릭이 제안 행을 잡고 멈춘 사이 둘째 클릭이 들어온다.
// PGlite는 transaction을 직렬화해 행 잠금 대기를 만들 수 없다. HOMELAB_TEST_PG_SOCKET이 없으면 건너뛴다.
const socket = process.env.HOMELAB_TEST_PG_SOCKET;
const skip = socket ? false : 'HOMELAB_TEST_PG_SOCKET 없음(로컬 PostgreSQL 필요)';
const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
// 일치하는 질의가 돌아온 직후 한 번 멈춘다(revoke-dispatch-pg와 같은 방식).
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

test('실제 PostgreSQL: 같은 "할게요"를 두 연결에서 겹쳐 눌러도 작업은 한 번만 시작되고 둘째는 이미 처리됨으로 답한다', { skip }, async () => {
  const admin = new pg.Pool({ host: socket, user: 'postgres', database: 'postgres', max: 1 });
  const name = `c13_${randomUUID().replaceAll('-', '').slice(0, 12)}`;
  await admin.query(`CREATE DATABASE ${name}`);
  const pool = new pg.Pool({ host: socket, user: 'postgres', database: name, max: 8 });
  try {
    const db = new Postgres(pool);
    await migrate(db);
    const h = await harness(db);
    await db.query("INSERT INTO controls VALUES ('scheduler','false') ON CONFLICT DO NOTHING");
    h.reply({ action: 'task', target: PROJECT, content: null });
    await h.say('100000000000000010', '실패하는 시험을 고쳐 줘');
    await h.turn();
    const [yes] = h.buttons().ids;
    // 첫 클릭: 대화 행·제안 행을 잡은 채 멈춘다.
    const paused = pausing(db, sql => sql.startsWith('SELECT * FROM proposals WHERE id=$1 FOR UPDATE'));
    const first = h.press(yes!, h.f.policy.owner, h.ingressOn(new Store(paused.db, h.f.now, true)));
    await paused.paused;
    // 둘째 클릭: 다른 연결에서 같은 버튼. 첫 트랜잭션이 끝날 때까지 기다린다.
    const second = h.press(yes!);
    await sleep(200);
    paused.release();
    await Promise.all([first, second]);
    const jobs = await h.taskJobs();
    assert.equal(jobs.length, 1);
    const answers = h.callbacks.map(callback => callback.body.data.content).sort();
    assert.deepEqual(answers, [PROPOSAL_TEXT.taskStarted(PROJECT, jobs[0]!.id), PROPOSAL_TEXT.settled].sort());
    assert.ok(h.callbacks.every(callback => callback.body.type === 7));
    const row = (await db.query<{ state: string; result_job: string }>('SELECT state,result_job FROM proposals')).rows[0]!;
    assert.deepEqual([row.state, row.result_job], ['confirmed', jobs[0]!.id]);
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
