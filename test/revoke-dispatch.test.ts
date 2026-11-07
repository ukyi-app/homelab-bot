import { after, before, beforeEach, test } from 'node:test';
import assert from 'node:assert/strict';
import type { Scope } from '../src/contracts.js';
import { DEFAULTS } from '../src/contracts.js';
import type { DiscordApi } from '../src/discord-protocol.js';
import type { PolicyGate } from '../src/policy.js';
import { typingActivity } from '../src/activity.js';
import { localDatabase, fixture, event, thread } from './helpers.js';

// T26(A02): 권한 확인(authorized) 뒤 발송 시작 전에 커밋된 /revoke·구독 끄기는 Discord REST를 0건으로 막는다.
// 감사 재현과 같이 authorized() 다음의 discordPauseUntil 대기 지점에 철회를 끼운다.
let database: Awaited<ReturnType<typeof localDatabase>>;
let f: Awaited<ReturnType<typeof fixture>>;
before(async () => { database = await localDatabase(); });
beforeEach(async () => {
  const tables = (await database.pg.query<{ tablename: string }>(
    "SELECT tablename FROM pg_tables WHERE schemaname='public' AND tablename<>'schema_migrations'")).rows.map(r => r.tablename);
  await database.pg.exec(`TRUNCATE ${tables.join(',')} RESTART IDENTITY CASCADE`);
  f = await fixture(database.db);
});
after(async () => { await database.pg.close(); });

const chat: Scope = { kind: 'channel', guild: 'fixture-guild', channel: 'fixture-chat', parent: null };
const notifications: Scope = { kind: 'channel', guild: 'fixture-guild', channel: 'fixture-notifications', parent: null };
const otherThread: Scope = { ...thread, channel: 'fixture-thread-2' };
const rows = async (key: string) => (await database.db.query<{ state: string; dispatch_started: boolean; pause_reason: string | null }>(
  'SELECT state,dispatch_started,pause_reason FROM outbox WHERE idempotency_key=$1', [key])).rows[0]!;
const blockedAudits = async () => (await database.db.query("SELECT 1 FROM audit WHERE kind='delivery_blocked_before_dispatch'")).rows.length;
const sent = () => f.rest.messages.length + f.rest.threads.length;
const denied = async () => (await database.db.query('SELECT 1 FROM denied_actors WHERE actor_id=$1', [f.policy.owner])).rows.length === 1;

// 발송 종류별 미발송 행. 대화 답(message), 새 스레드(thread), 켜진 예약의 브리핑 사본(알림 채널 message).
const kinds = {
  message: async () => {
    await f.store.enqueue({ key: 'pending', actor: f.policy.owner, scope: thread, conversation: f.store.scopeId(thread), revision: f.policy.revision,
      payload: { kind: 'message', channel: thread.channel, content: '철회 전 답', classification: 'safe_summary' } });
  },
  thread: async () => {
    await f.store.enqueue({ key: 'pending', actor: f.policy.owner, scope: chat, revision: f.policy.revision,
      payload: { kind: 'thread', channel: chat.channel, content: 'fixture-event', classification: 'safe_summary' } });
  },
  scheduled: async () => {
    await database.db.query(`INSERT INTO schedules(id,owner_id,scope,timezone,next_run,payload,enabled)
      VALUES ('fixture-briefing',$1,$2,'UTC',0,'{"kind":"daily_briefing"}',true)`, [f.policy.owner, JSON.stringify(notifications)]);
    await database.db.query(`INSERT INTO briefing_copies(message_key,schedule_id,slot_date,memory_ids,created_at)
      VALUES ('pending','fixture-briefing','2027-01-15','[]',0)`);
    await f.store.enqueue({ key: 'pending', actor: f.policy.owner, scope: notifications, revision: f.policy.revision,
      payload: { kind: 'message', channel: notifications.channel, content: '예약 브리핑', classification: 'safe_summary' } });
  },
};
// authorized() 다음 첫 discordPauseUntil에서 한 번만 끼운다. 끼운 동작 안의 수신 ACK도 이 함수를 부르므로 먼저 끈다.
function between(action: () => Promise<void>) {
  let armed = true;
  const original = f.store.discordPauseUntil.bind(f.store);
  f.store.discordPauseUntil = async channel => {
    if (armed) { armed = false; await action(); }
    return original(channel);
  };
}
const revokeFrom = (scope: Scope, id: string) => async () => {
  await f.ingress.receive(event(id, { scope, kind: 'command', command: 'revoke', target: f.policy.owner, text: '' }));
  assert.equal(await denied(), true, '철회가 dispatch 전에 커밋됐다');
};

for (const kind of Object.keys(kinds) as (keyof typeof kinds)[]) {
  for (const [label, scope] of [['같은 대화', thread], ['다른 스레드', otherThread], ['알림 채널', notifications]] as const) {
    test(`T26 ${kind}: 인가 뒤 dispatch 전에 ${label}에서 owner 철회가 커밋되면 REST 0, blocked`, async () => {
      await f.ingress.receive(event('seed'));
      if (scope === otherThread) await f.ingress.receive(event('seed-2', { scope: otherThread }));
      await kinds[kind]();
      between(revokeFrom(scope, `revoke-${kind}`));
      assert.equal(await f.publisher.deliver(), true);
      assert.equal(sent(), 0);
      const row = await rows('pending');
      assert.equal(row.state, 'blocked');
      assert.equal(row.dispatch_started, false);
      assert.equal(await blockedAudits(), 1);
      // 다시 돌려도 보내지 않는다.
      await f.publisher.deliver(); await f.publisher.reconcile();
      assert.equal(sent(), 0);
    });
  }
}

test('T26 대조: 철회가 없으면 같은 경로로 한 번 보낸다', async () => {
  await f.ingress.receive(event('seed'));
  await kinds.message();
  between(async () => {});
  await f.publisher.deliver();
  assert.equal(f.rest.messages.length, 1);
  assert.equal((await rows('pending')).state, 'sent');
});

test('T26 인가 뒤 dispatch 전에 구독이 꺼지면 REST 0, blocked', async () => {
  await f.ingress.receive(event('seed'));
  await kinds.message();
  between(async () => { await database.db.query('UPDATE conversations SET active=false WHERE id=$1', [f.store.scopeId(thread)]); });
  await f.publisher.deliver();
  assert.equal(sent(), 0);
  assert.equal((await rows('pending')).state, 'blocked');
});

test('T26 인가 뒤 dispatch 전에 gap이 서면 REST 0, blocked가 아니라 미룬다', async () => {
  await f.ingress.receive(event('seed'));
  await kinds.message();
  between(async () => { await database.db.query('UPDATE conversations SET gap=true WHERE id=$1', [f.store.scopeId(thread)]); });
  await f.publisher.deliver();
  assert.equal(sent(), 0);
  const row = await rows('pending');
  assert.deepEqual([row.state, row.dispatch_started, row.pause_reason], ['pending', false, 'history_gap']);
  assert.equal(await blockedAudits(), 0);
});

test('T26 lease를 잃은 경우는 철회 차단과 구별한다(행을 건드리지 않고 감사도 없음)', async () => {
  await f.ingress.receive(event('seed'));
  await kinds.message();
  between(async () => { f.advance(DEFAULTS.leaseMs + 1); });
  await f.publisher.deliver();
  assert.equal(sent(), 0);
  assert.deepEqual([(await rows('pending')).state, await blockedAudits()], ['sending', 0]);
  await f.store.expire();
  assert.equal((await rows('pending')).state, 'pending');
});

test('T26 철회와 lease 상실이 겹치면 lease 상실로 본다(다음 claim에서 막힘)', async () => {
  await f.ingress.receive(event('seed'));
  await kinds.message();
  between(async () => { await revokeFrom(thread, 'revoke-lease')(); f.advance(DEFAULTS.leaseMs + 1); });
  await f.publisher.deliver();
  assert.deepEqual([(await rows('pending')).state, sent()], ['sending', 0]);
  await f.store.expire();
  f.advance(DEFAULTS.retryDelayMs);
  // 철회 명령의 ACK 실패 안내도 outbox에 있다. 모두 비울 때까지 돌린다.
  while (await f.publisher.deliver());
  assert.deepEqual([(await rows('pending')).state, sent()], ['blocked', 0]);
});

test('T26 상호작용 응답: 응답 직전 확인 전에 커밋된 철회면 응답하지 않음', async () => {
  await f.ingress.receive(event('seed'));
  f.rest.acks.length = 0;
  between(revokeFrom(notifications, 'revoke-ack'));
  await f.ingress.receive(event('status', { kind: 'command', command: 'list', text: '' }));
  assert.equal(f.rest.acks.length, 0);
  assert.equal((await database.db.query("SELECT 1 FROM audit WHERE kind='ack_uncertain' AND detail->>'reason'='denied'")).rows.length >= 1, true);
});

test('T26 typing: 인가 뒤 커밋된 철회면 입력 중 표시를 보내지 않음', async () => {
  await f.ingress.receive(event('m-chat'));
  await database.db.query("UPDATE jobs SET state='running',lease_until=$1 WHERE state='queued'", [f.now() + 60_000]);
  const calls: string[] = [];
  const api: DiscordApi = { request: async (method, path) => { calls.push(`${method} ${path}`); return undefined; } };
  const gate = { authorize: async (...args: Parameters<PolicyGate['authorize']>) => {
    const policy = await f.gate.authorize(...args);
    await database.db.query('INSERT INTO denied_actors(actor_id,created_at) VALUES ($1,$2)', [f.policy.owner, f.now()]);
    return policy;
  } } as unknown as PolicyGate;
  await typingActivity(f.store, gate, api, () => {})();
  assert.deepEqual(calls, []);
});
