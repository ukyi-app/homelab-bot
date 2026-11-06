import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import pg from 'pg';
import type { Clock } from '../src/contracts.js';
import { Postgres } from '../src/database.js';
import { ExternalTaskCommands } from '../src/external-task-commands.js';
import { ExternalTaskLinks } from '../src/external-task-links.js';
import { externalTaskServer, EXTERNAL_TASK_PATH, ExternalTaskReceiver } from '../src/external-task-receiver.js';
import type { ReceiverLimits } from '../src/external-task-receiver.js';
import { runMigrations } from '../src/migrate-main.js';
import { Store } from '../src/store.js';
import { thread } from './helpers.js';
import { ENVIRONMENT, atomicityScenario, eventBody, listen, raw, request, seedConversation, sender, shut, signedHeaders } from './external-task-fixture.js';

// 실제 PostgreSQL(18) 시험. HOMELAB_TEST_PG_SOCKET(유닉스 소켓 디렉터리)이 없으면 건너뛴다. 실행 방법은 VERIFICATION T20 절과 같다.
const socket = process.env.HOMELAB_TEST_PG_SOCKET;
const skip = socket ? false : 'HOMELAB_TEST_PG_SOCKET 없음(로컬 PostgreSQL 필요)';
const HIGH: Partial<ReceiverLimits> = { globalBurst: 100_000, connectionBurst: 100_000, connectionPerHour: 100_000, concurrent: 64 };

async function database(limits: Partial<ReceiverLimits> = {}, now: Clock = Date.now) {
  const admin = new pg.Pool({ host: socket, user: 'postgres', database: 'postgres', max: 1 });
  const name = `t18r08_${randomUUID().replaceAll('-', '').slice(0, 12)}`;
  await admin.query(`CREATE DATABASE ${name}`);
  const pool = new pg.Pool({ host: socket, user: 'postgres', database: name, max: 8 });
  await runMigrations(pool);
  const db = new Postgres(pool);
  const store = new Store(db, now);
  await seedConversation(db, store, store.now());
  const links = new ExternalTaskLinks(store);
  const receiver = new ExternalTaskReceiver({ store, links, authorize: async () => ({ revision: 'fixture-v1' }), environment: ENVIRONMENT, limits: { ...HIGH, ...limits } });
  const attach = async (id: string, summaryConsent = false) => sender(await links.attach({ owner: 'fixture-owner', scope: thread, externalTaskId: id, executor: 'codex', summaryConsent }));
  const count = async (sql: string, params: unknown[] = []) => Number((await db.query<{ n: string }>(`SELECT count(*)::text AS n FROM ${sql}`, params)).rows[0]!.n);
  return { pool, db, store, links, receiver, attach, count, close: async () => {
    await pool.end();
    // WITH (FORCE)는 쓰지 않는다. pool.end() 직후 닫히는 중인 연결이 FATAL을 받아 다음 시험의 오류로 나타난다.
    for (let attempt = 0; ; attempt++) {
      try { await admin.query(`DROP DATABASE ${name}`); break; } catch (error) {
        if (attempt >= 50 || !/being accessed by other users/.test((error as Error).message)) throw error;
        await new Promise(resolve => setTimeout(resolve, 100));
      }
    }
    await admin.end();
  } };
}
const post = (ctx: Awaited<ReturnType<typeof database>>, who: ReturnType<typeof sender>, body: string) =>
  ctx.receiver.receive(signedHeaders(who, body, ctx.store.now()), Buffer.from(body));
const OWNER = 'fixture-owner';
const until = async (check: () => Promise<boolean>, ms = 3000) => {
  const deadline = Date.now() + ms;
  while (!await check()) {
    assert.ok(Date.now() < deadline, 'until_timeout');
    await new Promise(resolve => setTimeout(resolve, 10));
  }
};
const lockWaiters = (ctx: Awaited<ReturnType<typeof database>>) => ctx.count(`pg_stat_activity WHERE datname=current_database() AND wait_event_type='Lock'`);
// 폐기·재발급·동의 변경이 연결 행을 잠그고 아직 커밋하지 않은 상태다.
async function lockConnection(ctx: Awaited<ReturnType<typeof database>>, id: string) {
  const client = await ctx.pool.connect();
  await client.query('BEGIN');
  await client.query('SELECT 1 FROM external_task_connections WHERE id=$1 FOR UPDATE', [id]);
  return client;
}

test('R08 실제 PostgreSQL: 수락과 outbox 생성은 한 트랜잭션이다', { skip }, async () => {
  const ctx = await database();
  const server = externalTaskServer(ctx.receiver);
  await listen(server);
  try {
    const who = await ctx.attach('atomic-session');
    await atomicityScenario(ctx.db, text => raw(server, request('POST', EXTERNAL_TASK_PATH, signedHeaders(who, text, ctx.store.now()), text)), eventBody(who, ctx.store.now()), who.connectionId);
  } finally { await shut(server); await ctx.close(); }
});

test('R08 실제 PostgreSQL: 같은 event_id를 동시에 보내도 한 번만 수락하고 게시 행은 하나다', { skip }, async () => {
  const ctx = await database();
  try {
    const who = await ctx.attach('race-session');
    const body = eventBody(who, ctx.store.now());
    const replies = await Promise.all(Array.from({ length: 16 }, () => post(ctx, who, body)));
    assert.deepEqual(replies.map(reply => reply.status), Array(16).fill(202));
    assert.equal(replies.filter(reply => reply.outcome === 'accepted').length, 1);
    assert.equal(await ctx.count('outbox'), 1);
    assert.equal(await ctx.count('external_task_events'), 1);
    // 같은 ID의 다른 내용이 동시에 들어와도 먼저 들어온 내용 하나만 남는다.
    const event = JSON.parse(eventBody(who, ctx.store.now())) as Record<string, unknown>;
    const variants = Array.from({ length: 8 }, (_, i) => JSON.stringify({ ...event, occurred_at: ctx.store.now() - i }));
    const mixed = await Promise.all(variants.map(variant => post(ctx, who, variant)));
    assert.equal(mixed.filter(reply => reply.outcome === 'accepted').length, 1);
    assert.equal(mixed.filter(reply => reply.outcome === 'event_conflict').length, 7);
  } finally { await ctx.close(); }
});

test('R08 실제 PostgreSQL: 전체 미게시 상한은 여러 연결이 동시에 들어와도 넘지 않는다', { skip }, async () => {
  const ctx = await database({ unpostedTotal: 5, unpostedPerConnection: 100 });
  try {
    const all = await Promise.all(Array.from({ length: 4 }, (_, i) => ctx.attach(`session-${i}`)));
    const replies = await Promise.all(all.flatMap(who => Array.from({ length: 5 }, () => post(ctx, who, eventBody(who, ctx.store.now())))));
    assert.equal(replies.filter(reply => reply.outcome === 'accepted').length, 5);
    assert.equal(replies.filter(reply => reply.outcome === 'backlog_total').length, 15);
    assert.equal(await ctx.count(`external_task_events WHERE post_state='pending'`), 5);
  } finally { await ctx.close(); }
});

test('R08 실제 PostgreSQL: 폐기와 수신이 겹쳐도 폐기 뒤에 게시 가능한 행이 남지 않는다', { skip }, async () => {
  const ctx = await database();
  try {
    for (let round = 0; round < 5; round++) {
      const who = await ctx.attach(`revoke-${round}`);
      const posts = Array.from({ length: 8 }, () => post(ctx, who, eventBody(who, ctx.store.now())));
      const revoked = ctx.links.detach(who.connectionId, 'fixture-owner');
      const replies = await Promise.all(posts);
      await revoked;
      for (const reply of replies) assert.ok(['accepted', 'unauthorized'].includes(reply.outcome), reply.outcome);
      assert.equal(await ctx.count(`outbox WHERE idempotency_key LIKE $1 AND state='pending'`, [`external-task:${who.connectionId}:%`]), 0);
      assert.equal((await post(ctx, who, eventBody(who, ctx.store.now()))).outcome, 'unauthorized');
    }
  } finally { await ctx.close(); }
});

test('R08 실제 PostgreSQL: 폐기 트랜잭션이 커밋 전이면 게시 행을 잡아도 발송하지 못하고 기다리지 않으며, 커밋 뒤 다시 잡으면 막힌다', { skip }, async () => {
  const ctx = await database();
  try {
    const who = await ctx.attach('claim-locked');
    assert.equal((await post(ctx, who, eventBody(who, ctx.store.now()))).outcome, 'accepted');
    const client = await lockConnection(ctx, who.connectionId);
    try {
      await client.query(`UPDATE external_task_connections SET revoked_at=$2,revoked_reason='detach' WHERE id=$1`, [who.connectionId, ctx.store.now()]);
      const claimed = await ctx.store.claimDelivery();
      assert.ok(claimed);
      assert.equal(claimed.state, 'pending');
      assert.equal(await ctx.store.dispatchDelivery(claimed), false);
      await client.query('COMMIT');
    } finally { await client.query('ROLLBACK').catch(() => {}); client.release(); }
    await ctx.db.query(`UPDATE outbox SET available_at=0`);
    const again = await ctx.store.claimDelivery();
    assert.equal(again?.state, 'blocked');
    assert.equal(await ctx.store.dispatchDelivery(again!), false);
    assert.equal(await ctx.count(`external_task_events WHERE post_state='blocked'`), 1);
  } finally { await ctx.close(); }
});

test('R08 실제 PostgreSQL: 발송 실패로 돌아오는 행과 폐기가 겹쳐도 교착 없이 끝나고 폐기 뒤에는 다시 발송되지 않는다', { skip }, async () => {
  const ctx = await database();
  try {
    for (let round = 0; round < 20; round++) {
      const who = await ctx.attach(`retry-${round}`);
      assert.equal((await post(ctx, who, eventBody(who, ctx.store.now()))).outcome, 'accepted');
      const row = (await ctx.store.claimDelivery())!;
      assert.equal(await ctx.store.dispatchDelivery(row), true);
      const resend = async () => {
        await ctx.store.deliveryState(row, 'pending');
        const again = await ctx.store.claimDelivery();
        return again ? ctx.store.dispatchDelivery(again) : false;
      };
      // 폐기가 끝나기 전에 시작한 발송은 정상 경합이다. 폐기가 끝난 뒤의 재시도만 막혀야 한다.
      await Promise.all([resend(), ctx.links.detach(who.connectionId, OWNER)]);
      const current = (await ctx.db.query<{ state: string; lease_token: string }>('SELECT state,lease_token FROM outbox WHERE id=$1', [row.id])).rows[0]!;
      if (current.state === 'sending') await ctx.store.deliveryState({ ...row, lease_token: current.lease_token }, 'pending');
      await ctx.db.query(`UPDATE outbox SET available_at=0 WHERE state='pending'`);
      const last = await ctx.store.claimDelivery();
      if (last) assert.equal(await ctx.store.dispatchDelivery(last), false);
      assert.equal(await ctx.count(`outbox WHERE id=$1 AND state='blocked'`, [row.id]), 1);
    }
  } finally { await ctx.close(); }
});

test('R08 실제 PostgreSQL: 동의 철회가 잠금을 쥔 동안 들어온 요약은 철회 커밋 뒤 거절된다', { skip }, async () => {
  const ctx = await database();
  try {
    const who = await ctx.attach('consent-race', true);
    const client = await lockConnection(ctx, who.connectionId);
    let settled;
    try {
      await client.query('UPDATE external_task_connections SET summary_consent=false WHERE id=$1', [who.connectionId]);
      settled = post(ctx, who, eventBody(who, ctx.store.now(), { summary: '철회 경합 요약' }));
      await until(async () => await lockWaiters(ctx) === 1);
      await client.query('COMMIT');
    } finally { await client.query('ROLLBACK').catch(() => {}); client.release(); }
    assert.deepEqual(await settled, { status: 403, outcome: 'summary_consent_required' });
    assert.equal(await ctx.count('outbox'), 0);
    assert.equal(await ctx.count('external_task_events'), 0);
    // 실제 API끼리 겹쳐도 오류 없이 둘 중 하나로 끝나고, 철회가 끝난 뒤의 요약은 모두 거절된다.
    for (let round = 0; round < 5; round++) {
      const racer = await ctx.attach(`consent-${round}`, true);
      const posts = Array.from({ length: 6 }, () => post(ctx, racer, eventBody(racer, ctx.store.now(), { summary: '겹친 요약' })));
      await ctx.links.setSummaryConsent(racer.connectionId, OWNER, false);
      for (const reply of await Promise.all(posts)) assert.ok(['accepted', 'summary_consent_required'].includes(reply.outcome), reply.outcome);
      assert.equal((await post(ctx, racer, eventBody(racer, ctx.store.now(), { summary: '철회 뒤 요약' }))).outcome, 'summary_consent_required');
    }
  } finally { await ctx.close(); }
});

test('R08 실제 PostgreSQL: 잠금을 기다리는 사이 만료된 연결은 잠금을 얻은 시각으로 판단해 거절한다', { skip }, async () => {
  let offset = 0;
  const ctx = await database({}, () => Date.now() + offset);
  try {
    const who = await ctx.attach('expiry-race');
    await ctx.db.query('UPDATE external_task_connections SET expires_at=$2 WHERE id=$1', [who.connectionId, ctx.store.now() + 1000]);
    const client = await lockConnection(ctx, who.connectionId);
    let settled;
    try {
      settled = post(ctx, who, eventBody(who, ctx.store.now()));
      await until(async () => await lockWaiters(ctx) === 1);
      offset = 1500;
      await client.query('COMMIT');
    } finally { await client.query('ROLLBACK').catch(() => {}); client.release(); }
    assert.deepEqual(await settled, { status: 401, outcome: 'unauthorized' });
    assert.equal(await ctx.count('outbox'), 0);
  } finally { await ctx.close(); }
});

test('R08 실제 PostgreSQL: 복원 울타리가 잠금에 걸려도 처리 기한에 DB 대기가 끊겨 슬롯을 돌려받고, 잠금이 풀리면 수락한다', { skip }, async () => {
  const ctx = await database({ processingTimeoutMs: 300, dbSlots: 1, dbQueue: 1 });
  const server = externalTaskServer(ctx.receiver);
  await listen(server);
  const client = await ctx.pool.connect();
  const send = async (who: ReturnType<typeof sender>) => {
    const body = eventBody(who, ctx.store.now());
    return raw(server, request('POST', EXTERNAL_TASK_PATH, signedHeaders(who, body, ctx.store.now()), body));
  };
  try {
    const who = await ctx.attach('fence-locked');
    await client.query('BEGIN');
    await client.query('LOCK TABLE external_task_link_fence IN ACCESS EXCLUSIVE MODE');
    assert.equal((await send(who)).status, 503);
    await until(async () => await lockWaiters(ctx) === 0);
    assert.equal((await send(who)).status, 503);
    await until(async () => await lockWaiters(ctx) === 0);
    await client.query('ROLLBACK');
    assert.equal((await send(who)).status, 202);
  } finally {
    await client.query('ROLLBACK').catch(() => {});
    client.release();
    await shut(server);
    await ctx.close();
  }
});

test('R08 실제 PostgreSQL: 기한 트랜잭션이 transaction_timeout으로 세션을 잃어도 프로세스가 죽지 않고 풀이 회복한다', { skip }, async () => {
  const ctx = await database();
  try {
    const deadline = () => ({ expiresAt: Date.now() + 100, now: Date.now });
    for (let round = 0; round < 3; round++) {
      // 문장 사이에서 기한이 지나면 진행 중인 질의가 없어 FATAL이 그대로 클라이언트 error 이벤트가 된다.
      await assert.rejects(ctx.db.transaction(async tx => {
        await tx.query('SELECT 1');
        await new Promise(resolve => setTimeout(resolve, 300));
        await tx.query('SELECT 2');
      }, deadline()));
      // 문장 실행 중에 기한이 지나는 경로다.
      const holder = await ctx.pool.connect();
      try {
        await holder.query('BEGIN');
        await holder.query('LOCK TABLE external_task_link_fence IN ACCESS EXCLUSIVE MODE');
        await Promise.allSettled(Array.from({ length: 4 }, () => ctx.db.transaction(tx => tx.query('SELECT * FROM external_task_link_fence'), deadline())));
      } finally { await holder.query('ROLLBACK'); holder.release(); }
    }
    // 죽은 연결을 풀이 다시 내주지 않는다. 풀 크기보다 많이 돌려 모든 자리를 거치게 한다.
    for (let attempt = 0; attempt < 16; attempt++) assert.equal((await ctx.db.transaction(tx => tx.query<{ one: number }>('SELECT 1 AS one'))).rows[0]!.one, 1);
    const who = await ctx.attach('after-fatal');
    assert.equal((await post(ctx, who, eventBody(who, ctx.store.now()))).outcome, 'accepted');
  } finally { await ctx.close(); }
});

test('R08 실제 PostgreSQL: 동시 /attach는 하나만 키를 내고, 목록·해제가 돌고, seed는 어느 표에도 없다', { skip }, async () => {
  const ctx = await database();
  try {
    const handler = new ExternalTaskCommands(ctx.links, ENVIRONMENT, () => {});
    const delivered: string[] = [];
    const replies = await Promise.all(Array.from({ length: 4 }, () => handler.handle({ actor: OWNER, scope: thread, command: 'attach', text: 'claude', target: 'pg-session' },
      async content => { delivered.push(content); return true; })));
    assert.deepEqual(replies.map(reply => reply.outcome).sort(), ['already_attached', 'already_attached', 'already_attached', 'attached']);
    assert.equal(delivered.length, 1);
    const seed = /^seed: `([^`]+)`$/m.exec(delivered[0]!)![1]!;
    const connectionId = /^connection_id: `([^`]+)`$/m.exec(delivered[0]!)![1]!;
    const list = await handler.handle({ actor: OWNER, scope: thread, command: 'attach-list', text: '' }, async () => true);
    assert.ok(list.content!.includes(connectionId));
    const tables = (await ctx.pool.query<{ tablename: string }>("SELECT tablename FROM pg_tables WHERE schemaname='public'")).rows.map(row => row.tablename);
    const dump = JSON.stringify(await Promise.all(tables.map(async table => (await ctx.pool.query(`SELECT * FROM ${table}`)).rows)));
    assert.ok(dump.includes(connectionId));
    assert.equal(dump.includes(seed), false);
    assert.equal((await handler.handle({ actor: OWNER, scope: thread, command: 'detach', text: '', target: connectionId }, async () => true)).outcome, 'detached');
    assert.equal(await ctx.count('external_task_connections WHERE revoked_at IS NULL'), 0);
  } finally { await ctx.close(); }
});

test('R08 실제 PostgreSQL: 복원 울타리 질의는 일반 역할로 돌고 재발급이 동시 수신과 겹쳐도 새 키만 남는다', { skip }, async () => {
  const ctx = await database();
  try {
    const role = `r08_app_${randomUUID().replaceAll('-', '').slice(0, 8)}`;
    await ctx.pool.query(`CREATE ROLE ${role} NOSUPERUSER`);
    const client = await ctx.pool.connect();
    try {
      await client.query(`SET ROLE ${role}`);
      const { rows } = await client.query<{ timeline: string }>('SELECT substr(pg_walfile_name(pg_current_wal_lsn()),1,8) AS timeline');
      assert.match(rows[0]!.timeline, /^[0-9A-F]{8}$/);
    } finally {
      await client.query('RESET ROLE');
      client.release();
      await ctx.pool.query(`DROP ROLE ${role}`);
    }
    const who = await ctx.attach('rotate-session');
    const posts = Array.from({ length: 6 }, () => post(ctx, who, eventBody(who, ctx.store.now())));
    const after = sender(await ctx.links.rotate(who.connectionId, 'fixture-owner'));
    for (const reply of await Promise.all(posts)) assert.ok(['accepted', 'unauthorized'].includes(reply.outcome), reply.outcome);
    assert.equal((await post(ctx, who, eventBody(who, ctx.store.now()))).outcome, 'unauthorized');
    assert.equal((await post(ctx, after, eventBody(after, ctx.store.now()))).outcome, 'accepted');
    assert.equal(await ctx.count(`outbox WHERE state='pending'`), 1);
  } finally { await ctx.close(); }
});
