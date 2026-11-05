import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { Postgres } from '../src/database.js';
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

async function database(limits: Partial<ReceiverLimits> = {}) {
  const admin = new pg.Pool({ host: socket, user: 'postgres', database: 'postgres', max: 1 });
  const name = `t18r08_${randomUUID().replaceAll('-', '').slice(0, 12)}`;
  await admin.query(`CREATE DATABASE ${name}`);
  const pool = new pg.Pool({ host: socket, user: 'postgres', database: name, max: 8 });
  await runMigrations(pool);
  const db = new Postgres(pool);
  const store = new Store(db);
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
