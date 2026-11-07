import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { Postgres, migrate } from '../src/database.js';
import type { Database } from '../src/database.js';
import type { Scope } from '../src/contracts.js';
import { DiscordPublisher } from '../src/discord.js';
import { Store } from '../src/store.js';
import { event, fixture, thread } from './helpers.js';

// T26(A02) 실제 PostgreSQL 두 연결 경합. 게시자는 한 연결에서 멈춰 있고, 그동안 수신이 다른 연결에서 /revoke를 끝까지 커밋한다.
// 기준점은 dispatchDelivery의 UPDATE 한 문장이다. 그 전에 커밋된 철회는 REST 0, 그 뒤의 철회는 이미 시작한 발송을 막지 못한다.
// HOMELAB_TEST_PG_SOCKET(유닉스 소켓 디렉터리)이 없으면 건너뛴다.
const socket = process.env.HOMELAB_TEST_PG_SOCKET;
const skip = socket ? false : 'HOMELAB_TEST_PG_SOCKET 없음(로컬 PostgreSQL 필요)';
const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
const chat: Scope = { kind: 'channel', guild: 'fixture-guild', channel: 'fixture-chat', parent: null };
const notifications: Scope = { kind: 'channel', guild: 'fixture-guild', channel: 'fixture-notifications', parent: null };

// 일치하는 질의가 돌아온 직후 한 번 멈춘다(review-9-pg와 같은 방식).
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
  const name = `t26_${randomUUID().replaceAll('-', '').slice(0, 12)}`;
  await admin.query(`CREATE DATABASE ${name}`);
  const pool = new pg.Pool({ host: socket, user: 'postgres', database: name, max: 6 });
  const db = new Postgres(pool);
  await migrate(db);
  const f = await fixture(db);
  await db.query("INSERT INTO controls VALUES ('scheduler','false') ON CONFLICT DO NOTHING");
  await f.ingress.receive(event('seed'));
  const kinds = {
    message: () => f.store.enqueue({ key: 'pending', actor: f.policy.owner, scope: thread, conversation: f.store.scopeId(thread), revision: f.policy.revision,
      payload: { kind: 'message', channel: thread.channel, content: '철회 전 답', classification: 'safe_summary' } }),
    thread: () => f.store.enqueue({ key: 'pending', actor: f.policy.owner, scope: chat, revision: f.policy.revision,
      payload: { kind: 'thread', channel: chat.channel, content: 'fixture-event', classification: 'safe_summary' } }),
    scheduled: async () => {
      await db.query(`INSERT INTO schedules(id,owner_id,scope,timezone,next_run,payload,enabled)
        VALUES ('fixture-briefing',$1,$2,'UTC',0,'{"kind":"daily_briefing"}',true)`, [f.policy.owner, JSON.stringify(notifications)]);
      await db.query(`INSERT INTO briefing_copies(message_key,schedule_id,slot_date,memory_ids,created_at)
        VALUES ('pending','fixture-briefing','2027-01-15','[]',0)`);
      await f.store.enqueue({ key: 'pending', actor: f.policy.owner, scope: notifications, revision: f.policy.revision,
        payload: { kind: 'message', channel: notifications.channel, content: '예약 브리핑', classification: 'safe_summary' } });
    },
  };
  // 게시자만 멈추는 연결 묶음을 쓴다. 수신(f.ingress)은 같은 풀의 다른 연결로 돈다.
  const publisherOn = (paused: Database) => new DiscordPublisher(new Store(paused, f.now), f.gate.withDatabase(paused), f.rest);
  const state = async () => (await db.query<{ state: string }>("SELECT state FROM outbox WHERE idempotency_key='pending'")).rows[0]!.state;
  const revoke = async (id: string) => {
    await f.ingress.receive(event(id, { scope: notifications, kind: 'command', command: 'revoke', target: f.policy.owner, text: '' }));
    assert.equal((await db.query('SELECT 1 FROM denied_actors WHERE actor_id=$1', [f.policy.owner])).rows.length, 1);
  };
  return { db, pool, f, kinds, publisherOn, state, revoke, close: async () => {
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

for (const kind of ['message', 'thread', 'scheduled'] as const) {
  test(`T26 실제 PostgreSQL ${kind}: 인가 뒤 다른 연결의 /revoke가 dispatch보다 먼저 커밋되면 REST 0, blocked`, { skip }, async () => {
    const { db, f, kinds, publisherOn, state, revoke, close } = await setup();
    try {
      await kinds[kind]();
      // authorized()의 철회 조회가 통과한 직후 멈춘다.
      const held = pausing(db, sql => /SELECT actor_id FROM denied_actors WHERE actor_id=\$1/.test(sql));
      const delivering = publisherOn(held.db).deliver();
      await held.paused;
      await revoke(`revoke-${kind}`);
      held.release();
      assert.equal(await delivering, true);
      assert.equal(f.rest.messages.length + f.rest.threads.length, 0);
      assert.equal(await state(), 'blocked');
    } finally { await close(); }
  });
}

test('T26 실제 PostgreSQL 한계: dispatch가 먼저면 보낸 뒤 철회돼도 되돌리지 못하고 confirm이 unknown으로 남긴다', { skip }, async () => {
  const { db, f, kinds, publisherOn, state, revoke, close } = await setup();
  try {
    await kinds.message();
    const held = pausing(db, sql => /^WITH gate AS/.test(sql));
    const delivering = publisherOn(held.db).deliver();
    await held.paused;
    await revoke('revoke-after-dispatch');
    held.release();
    await delivering;
    assert.equal(f.rest.messages.length, 1);
    assert.equal(await state(), 'unknown');
  } finally { await close(); }
});

test('T26 실제 PostgreSQL 한계: 커밋 전 철회는 dispatch를 기다리게 하지 않는다(기준점은 커밋)', { skip }, async () => {
  const { db, pool, f, kinds, publisherOn, state, close } = await setup();
  const client = await pool.connect();
  try {
    await kinds.message();
    await client.query('BEGIN');
    await client.query('INSERT INTO denied_actors(actor_id,created_at) VALUES ($1,$2)', [f.policy.owner, f.now()]);
    assert.equal(await publisherOn(db).deliver(), true);
    assert.equal(f.rest.messages.length, 1);
    assert.equal(await state(), 'sent');
    await client.query('COMMIT');
  } finally {
    await client.query('ROLLBACK').catch(() => {});
    client.release();
    await close();
  }
});
