import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { Postgres, migrate } from '../src/database.js';
import { recordAccount, switchAccount } from '../src/model-accounts.js';
import { fixture } from './helpers.js';

// C22 넘김(C23 할 일 4a): 계정 전환과 겹친 옛 실행의 한도 관측. 실제 PostgreSQL 두 연결에서 본다(PGlite는 트랜잭션을 직렬화해
// 전환이 커밋 전인 순간에 다른 연결의 관측을 끼울 수 없다). HOMELAB_TEST_PG_SOCKET이 없으면 건너뛴다.
const socket = process.env.HOMELAB_TEST_PG_SOCKET;
const skip = socket ? false : 'HOMELAB_TEST_PG_SOCKET 없음(로컬 PostgreSQL 필요)';
const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

test('C23 4a 전환 커밋과 겹친 옛 실행의 한도 관측은 새 계정의 사용률·리뷰 미루기로 남지 않는다', { skip }, async () => {
  const admin = new pg.Pool({ host: socket, user: 'postgres', database: 'postgres', max: 1 });
  const name = `c23race_${randomUUID().replaceAll('-', '').slice(0, 12)}`;
  await admin.query(`CREATE DATABASE ${name}`);
  const pool = new pg.Pool({ host: socket, user: 'postgres', database: name, max: 4 });
  try {
    const db = new Postgres(pool);
    await migrate(db);
    const f = await fixture(db);
    await recordAccount(db, 'main', 'subscription', f.now());
    await recordAccount(db, 'spare', 'api', f.now());
    await f.store.atomic(s => switchAccount(s, 'main', 'subscription', 'cli', 'cli'));
    // main이 지금 계정이 된 뒤, spare로 바꾸기 전에 시작한 실행(옛 계정 main의 자격으로 돈다).
    f.advance(10);
    await db.query(`INSERT INTO events(id,provider,delivery_id,semantic_key,actor_id,scope,received_at,payload)
      VALUES ('race','discord','race','race','fixture-owner','{}',0,'{}')`);
    await db.query(`INSERT INTO jobs(id,event_id,type,owner_id,target,revision,budget,state,attempt,priority,available_at,created_at,started_at)
      VALUES ('race','race','chat','fixture-owner','{}','{}','{}','running',1,10,0,$1,$1)`, [f.now() - 5]);
    const resetsAt = Math.floor((f.now() + 3_600_000) / 1000);
    let release!: () => void;
    const held = new Promise<void>(resolve => { release = resolve; });
    let switched!: () => void;
    const locked = new Promise<void>(resolve => { switched = resolve; });
    // 전환 트랜잭션: 바꾼 뒤 커밋 전에 멈춘다.
    const switching = f.store.atomic(async s => {
      f.advance(1);
      const outcome = await switchAccount(s, 'spare', 'api', 'cli', 'cli');
      switched();
      await held;
      return outcome;
    });
    await locked;
    // 그 사이 옛 실행이 한도 경고와 함께 끝나 관측을 적는다(트랜잭션 밖 호출, 대화·리뷰·작업 레인의 settle과 같은 자리).
    const observing = f.store.observeRateLimit({ event: { status: 'allowed_warning', rateLimitType: 'five_hour', utilization: 0.97, resetsAt } }, 'race');
    await sleep(300);
    release();
    assert.equal((await switching).result, 'switched');
    await observing;
    assert.deepEqual((await db.query("SELECT utilization FROM model_limit_state WHERE id='account'")).rows, []);
    assert.equal(await f.store.reviewDeferredUntil(), null);
    // 전환 뒤 시작한 실행의 관측은 그대로 적힌다.
    await db.query("UPDATE jobs SET started_at=$1 WHERE id='race'", [f.now() + 1]);
    await f.store.observeRateLimit({ event: { status: 'allowed_warning', rateLimitType: 'five_hour', utilization: 0.5, resetsAt } }, 'race');
    assert.deepEqual((await db.query<{ utilization: number }>("SELECT utilization FROM model_limit_state WHERE id='account'")).rows.map(r => Number(r.utilization)), [0.5]);
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
