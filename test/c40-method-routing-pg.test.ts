import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { Postgres, migrate } from '../src/database.js';
import { MethodRouter, installMethods } from '../src/method-routing.js';
import { recordAccount, switchAccount } from '../src/model-accounts.js';
import { fixture } from './helpers.js';

// AC-37 경합과 늦은 결과(COLLEAGUE_SPEC §4.11). 실제 PostgreSQL 두 연결에서 본다(PGlite는 트랜잭션을 직렬화해 겹친 보고를 만들 수 없다).
// 두 게시 서버는 같은 DB를 쓰는 두 MethodRouter로 흉내 낸다. HOMELAB_TEST_PG_SOCKET이 없으면 건너뛴다.
const socket = process.env.HOMELAB_TEST_PG_SOCKET;
const skip = socket ? false : 'HOMELAB_TEST_PG_SOCKET 없음(로컬 PostgreSQL 필요)';
const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

async function freshDatabase(fn: (db: Postgres) => Promise<void>): Promise<void> {
  const admin = new pg.Pool({ host: socket, user: 'postgres', database: 'postgres', max: 1 });
  const name = `c40race_${randomUUID().replaceAll('-', '').slice(0, 12)}`;
  await admin.query(`CREATE DATABASE ${name}`);
  const pool = new pg.Pool({ host: socket, user: 'postgres', database: name, max: 6 });
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

// 실행 중인 작업 행 하나(lease가 살아 있다).
async function running(db: Postgres, id: string, now: number): Promise<{ id: string; lease_token: string; budget: { timeoutMs: number; toolCalls: number } }> {
  const lease = randomUUID();
  await db.query(`INSERT INTO events(id,provider,delivery_id,semantic_key,actor_id,scope,received_at,payload)
    VALUES ($1,'discord',$1,$1,'fixture-owner','{}',0,'{}')`, [id]);
  await db.query(`INSERT INTO jobs(id,event_id,type,owner_id,target,revision,budget,state,attempt,priority,available_at,created_at,started_at,lease_token,lease_until)
    VALUES ($1,$1,'chat','fixture-owner','{}','{}','{}','running',1,10,0,$2,$2,$3,$4)`, [id, now, lease, now + 600_000]);
  return { id, lease_token: lease, budget: { timeoutMs: 60_000, toolCalls: 10 } };
}

test('AC-37 두 게시 서버가 같은 구독 한도를 동시에 보고해도 넘어감 전이는 한 번이고 일마다 API 시도도 한 번이다', { skip }, async () => {
  await freshDatabase(async db => {
    const f = await fixture(db);
    await recordAccount(db, 'main', 'subscription', f.now());
    await recordAccount(db, 'main', 'api', f.now());
    await f.store.atomic(s => switchAccount(s, 'main', 'subscription', 'cli', 'cli'));
    await f.store.atomic(s => installMethods(s, 'main', 'rev-1'));
    const servers = [new MethodRouter(f.store, { enabled: true, supported: () => true }), new MethodRouter(f.store, { enabled: true, supported: () => true })];
    const jobs = [await running(db, 'a', f.now()), await running(db, 'b', f.now())];
    const selections = await Promise.all(jobs.map((job, index) => servers[index]!.select(job, 'chat')));
    assert.deepEqual(selections.map(selection => selection!.method), ['subscription', 'subscription']);
    const resetsAt = Math.floor((f.now() + 3_600_000) / 1000);
    // 다른 연결이 방식 상태 행을 쥔 동안 두 보고가 함께 들어와 기다린다. 잠금 없이 읽으면 둘 다 "쓸 수 있음"을 보고 둘 다 넘긴다.
    let release!: () => void;
    const held = new Promise<void>(resolve => { release = resolve; });
    let locked!: () => void;
    const holding = new Promise<void>(resolve => { locked = resolve; });
    const holder = f.store.atomic(async s => { await s.db.query(`SELECT * FROM method_routing FOR UPDATE`); locked(); await held; });
    await holding;
    const reports = jobs.map((job, index) => servers[index]!.settle(job, selections[index]!,
      { status: 'limited', subscriptionLimit: true, rateLimit: { stop: { cause: 'rate_limit', resetsAt } } }));
    await sleep(300);
    release();
    await holder;
    assert.deepEqual((await Promise.all(reports)).map(outcome => outcome.action), ['requeued', 'requeued']);
    assert.equal((await db.query("SELECT 1 FROM audit WHERE kind='method_route_subscription_limited'")).rows.length, 1);
    assert.deepEqual((await db.query<{ state: string }>('SELECT state FROM jobs ORDER BY id')).rows.map(row => row.state), ['queued', 'queued']);
    // 같은 실행을 두 번 보고해도(재시도) 두 번째는 아무것도 하지 않는다.
    assert.equal((await servers[1]!.settle(jobs[0]!, selections[0]!, { status: 'limited', subscriptionLimit: true })).action, 'default');
    // 다음 실행은 두 서버 모두 API다.
    const next = await running(db, 'c', f.now());
    assert.equal((await servers[1]!.select(next, 'chat'))!.method, 'api');
  });
});

test('AC-37 옛 revision·옛 계정 실행의 늦은 실패는 지금 상태·API 잠금을 바꾸지 않고 그 일만 다시 고르게 한다', { skip }, async () => {
  await freshDatabase(async db => {
    const f = await fixture(db);
    await recordAccount(db, 'main', 'subscription', f.now());
    await recordAccount(db, 'main', 'api', f.now());
    await f.store.atomic(s => switchAccount(s, 'main', 'subscription', 'cli', 'cli'));
    await f.store.atomic(s => installMethods(s, 'main', 'rev-1'));
    const router = new MethodRouter(f.store, { enabled: true, supported: () => true });
    const first = await running(db, 'a', f.now());
    const subscription = (await router.select(first, 'chat'))!;
    await router.settle(first, subscription, { status: 'limited', subscriptionLimit: true });
    // 구독 한도 뒤 API로 고른 실행이 도는 사이 owner가 새 묶음(revision)을 설치했다. 같은 밀리초다.
    const late = await running(db, 'b', f.now());
    const api = (await router.select(late, 'chat'))!;
    assert.equal(api.method, 'api');
    await f.store.atomic(s => installMethods(s, 'main', 'rev-2'));
    assert.equal((await router.settle(late, api, { status: 'limited', rateLimit: { stop: { cause: 'billing' } } })).action, 'requeued');
    const state = (await db.query<{ api_state: string; subscription_state: string; revision: string }>(
      "SELECT api_state,subscription_state,revision FROM method_routing")).rows[0]!;
    assert.deepEqual(state, { api_state: 'eligible', subscription_state: 'limited', revision: 'rev-2' });
    assert.equal((await db.query("SELECT 1 FROM audit WHERE kind='method_route_api_locked'")).rows.length, 0);
    // 지금 revision의 API 결제 실패는 잠근다.
    const current = await running(db, 'c', f.now());
    const fresh = (await router.select(current, 'chat'))!;
    assert.equal(fresh.credentialRevision, 'rev-2');
    assert.equal((await router.settle(current, fresh, { status: 'limited', rateLimit: { stop: { cause: 'billing' } } })).action, 'wait');
    assert.equal((await db.query<{ api_state: string }>('SELECT api_state FROM method_routing')).rows[0]!.api_state, 'billing_blocked');
  });
});
