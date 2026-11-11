import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { Postgres, migrate } from '../src/database.js';
import { recordAccount, switchAccount } from '../src/model-accounts.js';
import { Store } from '../src/store.js';
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

// 새 데이터베이스 하나를 만들어 fn에 주고 끝나면 지운다.
async function freshDatabase(prefix: string, fn: (db: Postgres) => Promise<void>): Promise<void> {
  const admin = new pg.Pool({ host: socket, user: 'postgres', database: 'postgres', max: 1 });
  const name = `${prefix}_${randomUUID().replaceAll('-', '').slice(0, 12)}`;
  await admin.query(`CREATE DATABASE ${name}`);
  const pool = new pg.Pool({ host: socket, user: 'postgres', database: name, max: 4 });
  try {
    const db = new Postgres(pool);
    await migrate(db);
    await fn(db);
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
}

test('AC-16·21 전환 커밋과 겹쳐 도착한 옛 실행의 결제 멈춤은 새 계정을 세우지 않고 1분 뒤 재개 대상이 된다', { skip }, async () => {
  await freshDatabase('c36race', async db => {
    const f = await fixture(db);
    await recordAccount(db, 'main', 'subscription', f.now());
    await recordAccount(db, 'spare', 'subscription', f.now());
    await f.store.atomic(s => switchAccount(s, 'main', 'subscription', 'cli', 'cli'));
    f.advance(10);
    // 옛 계정 main의 자격으로 도는 실행. 대화가 없는 리뷰 작업이라 대기 안내가 없다.
    await db.query(`INSERT INTO events(id,provider,delivery_id,semantic_key,actor_id,scope,received_at,payload)
      VALUES ('race','github','race','race','fixture-owner','{}',0,'{}')`);
    await db.query(`INSERT INTO jobs(id,event_id,type,owner_id,target,revision,budget,state,attempt,priority,available_at,created_at,started_at,lease_token,lease_until)
      VALUES ('race','race','review','fixture-owner','{}','{}','{}','running',1,20,0,$1,$1,$2,$3)`, [f.now() - 5, randomUUID(), f.now() + 3_600_000]);
    const job = (await db.query('SELECT * FROM jobs WHERE id=$1', ['race'])).rows[0] as Parameters<typeof f.store.waitForUser>[0];
    let release!: () => void;
    const held = new Promise<void>(resolve => { release = resolve; });
    let switched!: () => void;
    const locked = new Promise<void>(resolve => { switched = resolve; });
    const switching = f.store.atomic(async s => {
      f.advance(1);
      const outcome = await switchAccount(s, 'spare', 'subscription', 'cli', 'cli');
      switched();
      await held;
      return outcome;
    });
    await locked;
    // 전환이 커밋되기 전에 옛 실행이 결제 멈춤으로 끝난다. scheduler 행에서 전환을 기다린 뒤 전환된 계정을 본다.
    const waiting = f.store.waitForUser(job, 'model_limit', { rateLimit: { stop: { cause: 'billing' } } });
    await sleep(300);
    release();
    assert.equal((await switching).result, 'switched');
    await waiting;
    const pause = (await db.query<{ kind: string; retry_at: string | null }>("SELECT kind,retry_at FROM model_pauses WHERE job_id='race'")).rows;
    assert.deepEqual(pause.map(row => [row.kind, Number(row.retry_at)]), [['rate_limit', f.now() + 60_000]]);
    f.advance(60_000);
    assert.equal(await f.store.resumeDue(), 1);
    assert.equal((await db.query<{ value: boolean }>("SELECT value FROM controls WHERE key='scheduler'")).rows[0]!.value, false);
  });
});

test('AC-16 게시 서버 둘의 재개 예약 루프가 겹쳐도 상한인 대기열 뒤의 멈춤 작업을 한 번씩만 재개하고 scheduler를 푼다', { skip }, async () => {
  await freshDatabase('c36queue', async db => {
    const f = await fixture(db);
    const paused = ['paused-1', 'paused-2'];
    const fillers = Array.from({ length: 89 }, (_, i) => `filler-${i + 1}`);
    await db.query(`INSERT INTO events(id,provider,delivery_id,semantic_key,actor_id,scope,received_at,payload)
      SELECT id,'discord',id,id,'fixture-owner','{}',0,'{}' FROM unnest($1::text[]) id`, [[...paused, ...fillers]]);
    await db.query(`INSERT INTO jobs(id,event_id,type,owner_id,target,revision,budget,state,wait_reason,attempt,priority,available_at,created_at,finished_at)
      SELECT id,id,'chat','fixture-owner','{}','{}','{}','waiting_user','model_limit',0,10,0,$2,$2 FROM unnest($1::text[]) id`, [paused, f.now()]);
    await db.query(`INSERT INTO model_pauses(job_id,kind,retry_at,paused_at) SELECT id,'rate_limit',$2,$2 FROM unnest($1::text[]) id`, [paused, f.now()]);
    await db.query(`INSERT INTO jobs(id,event_id,type,owner_id,target,revision,budget,state,attempt,priority,available_at,created_at)
      SELECT id,id,'task','fixture-owner','{}','{}','{}','queued',0,10,0,$2 FROM unnest($1::text[]) id`, [fillers, f.now()]);
    await db.query(`INSERT INTO controls VALUES ('scheduler','true'),('scheduler_emergency','false') ON CONFLICT (key) DO UPDATE SET value=EXCLUDED.value`);
    const other = new Store(db, f.now);
    const counts = await Promise.all([f.store.resumeDue(), other.resumeDue()]);
    assert.equal(counts[0]! + counts[1]!, 2);
    assert.deepEqual((await db.query<{ state: string }>('SELECT state FROM jobs WHERE id=ANY($1::text[])', [paused])).rows.map(row => row.state), ['queued', 'queued']);
    assert.equal((await db.query<{ value: boolean }>("SELECT value FROM controls WHERE key='scheduler'")).rows[0]!.value, false);
    assert.equal((await db.query("SELECT 1 FROM audit WHERE kind='model_wait_resumed'")).rows.length, 2);
  });
});
