import { after, before, beforeEach, test } from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULTS } from '../src/contracts.js';
import { localDatabase, fixture, event, thread, service, template } from './helpers.js';

// impl-sched S1: /read는 모델 슬롯과 다른 레인에서 claim·실행한다. 모델 실행·unknown·waiting_user·비상 중지에 막히지 않지만
// 대화 단위 장벽(구독 중지·gap·권한 철회)은 그대로 지킨다. read 동시 실행은 1개, 모델 동시 실행도 1개다.
let database: Awaited<ReturnType<typeof localDatabase>>;
let f: Awaited<ReturnType<typeof fixture>>;
before(async () => { database = await localDatabase(); });
beforeEach(async () => {
  await database.pg.exec('TRUNCATE events,conversations,jobs,results,outbox,schedules,denied_actors,controls,audit,incidents RESTART IDENTITY CASCADE');
  f = await fixture(database.db);
});
after(async () => { await database.pg.close(); });
async function rows(table: string) { return (await database.db.query<Record<string, any>>(`SELECT * FROM ${table}`)).rows; }
const read = (id: string) => f.ingress.receive(event(id, { kind: 'command', command: 'read', target: service.id, text: template.id }));
async function chat(id = 'chat') { await f.ingress.receive(event(id)); f.advance(DEFAULTS.debounceMs); }
const job = async (type: string) => (await rows('jobs')).find(j => j.type === type)!;
const answer = { facts: [], hypotheses: [], unknowns: [], checks: [] };

test('S1 모델 실행 중에도 read는 별도 레인에서 끝나고 결과를 게시 대기열에 넣음', async () => {
  await chat();
  let started!: () => void; let release!: () => void;
  const running = new Promise<void>(resolve => { started = resolve; });
  const held = new Promise<void>(resolve => { release = resolve; });
  f.setRun(async () => { started(); await held; return { status: 'succeeded', stopped: true, answer }; });
  const model = f.runtime.tick(); await running;
  await read('read-1');
  assert.equal(await f.runtime.tickRead(), true);
  const done = await job('read');
  assert.equal(done.state, 'succeeded'); assert.equal(f.queries.length, 1);
  assert.ok((await rows('outbox')).some(o => o.idempotency_key === `result:${done.id}`));
  // 모델은 여전히 1개만 돈다.
  assert.equal(await f.store.claim(), undefined);
  release(); await model;
  assert.equal((await job('chat')).state, 'succeeded');
});

for (const blocker of ['unknown', 'waiting_user', 'emergency-stop'] as const) test(`S1 ${blocker} 중에도 read 성공, 모델 claim은 계속 막힘`, async () => {
  await chat();
  if (blocker === 'emergency-stop') await f.store.control(f.policy.owner, f.store.scopeId(thread), 'emergency-stop');
  else {
    await database.db.query(`UPDATE jobs SET state=$1,wait_reason='fixture',attempt=1,lease_token=gen_random_uuid()::text`, [blocker]);
    if (blocker === 'waiting_user') await database.db.query(`INSERT INTO controls VALUES ('scheduler','true') ON CONFLICT (key) DO UPDATE SET value='true'`);
  }
  await chat('chat-2');
  await read('read-1');
  assert.equal(await f.runtime.tickRead(), true);
  assert.equal((await job('read')).state, 'succeeded');
  assert.equal(await f.runtime.tick(), false);
  assert.equal(f.requests.length, 0);
});

test('S1 모델 claim은 read를 고르지 않고, 실행 중 read도 모델을 막지 않음', async () => {
  await read('read-1');
  assert.equal(await f.store.claim(), undefined, '모델 claim이 read를 집었다');
  const claimed = (await f.store.claimRead())!;
  assert.equal(claimed.type, 'read'); assert.equal(claimed.state, 'running');
  await chat();
  const model = (await f.store.claim())!;
  assert.equal(model.type, 'chat');
  assert.equal(await f.store.claim(), undefined);
});

test('S1 read 동시 실행은 1개', async () => {
  const other = { ...thread, channel: 'fixture-thread-2' };
  await read('read-1');
  await f.ingress.receive(event('read-2', { scope: other, kind: 'command', command: 'read', target: service.id, text: template.id }));
  assert.ok(await f.store.claimRead());
  assert.equal(await f.store.claimRead(), undefined);
});

test('S1 /stop·gap은 read claim을 막고, 권한 철회는 조회 없이 취소', async () => {
  await read('read-1');
  await database.db.query('UPDATE conversations SET gap=true');
  assert.equal(await f.store.claimRead(), undefined);
  await database.db.query('UPDATE conversations SET gap=false');
  await f.store.control(f.policy.owner, f.store.scopeId(thread), 'stop');
  assert.equal(await f.store.claimRead(), undefined);
  await f.store.control(f.policy.owner, f.store.scopeId(thread), 'resume');
  await database.db.query(`INSERT INTO denied_actors(actor_id,created_at) VALUES ($1,$2)`, [f.policy.owner, f.now()]);
  assert.equal(await f.runtime.tickRead(), true);
  const row = await job('read');
  assert.equal(row.state, 'cancelled'); assert.equal(row.wait_reason, 'authorization_revoked');
  assert.equal(f.queries.length, 0);
});

test('S1 read lease 만료는 unknown이 아니라 failed + 안내 1개, 늦은 결과는 거부, 모델 claim은 막지 않음', async () => {
  await read('read-1');
  const claimed = (await f.store.claimRead())!;
  f.advance(DEFAULTS.leaseMs + 1);
  await f.store.expire(); await f.store.expire();
  const row = await job('read');
  assert.equal(row.state, 'failed'); assert.equal(row.wait_reason, 'lease_expired');
  const notices = (await rows('outbox')).filter(o => o.idempotency_key.startsWith('read-expired:'));
  assert.equal(notices.length, 1); assert.match(notices[0]!.payload.content, /\/read로 다시 요청/);
  assert.deepEqual(notices[0]!.payload.channel, thread.channel);
  await assert.rejects(f.store.finish(claimed, {}, {}, 'late', thread), /stale_result/);
  await chat();
  assert.equal((await f.store.claim())?.type, 'chat');
});

test('S1 구버전이 남긴 unknown read도 모델을 막지 않고 failed로 정리', async () => {
  await read('read-1');
  await database.db.query(`UPDATE jobs SET state='unknown',wait_reason='lease_expired',attempt=1`);
  await f.store.expire();
  assert.equal((await job('read')).state, 'failed');
  await chat();
  assert.equal((await f.store.claim())?.type, 'chat');
});

test('S1 비상 중지는 실행 중 read를 취소 요청으로 바꾸지 않음', async () => {
  await read('read-1');
  await f.store.claimRead();
  await f.store.control(f.policy.owner, f.store.scopeId(thread), 'emergency-stop');
  assert.equal((await job('read')).state, 'running');
});

test('S1 대기열 몫: 모델 계열이 상한(100-10)에 닿아도 read는 100까지 들어옴', async () => {
  const other = { ...thread, channel: 'fixture-thread-2' };
  for (let i = 0; i < DEFAULTS.maxQueue - 10; i++) {
    const saved = await f.store.save(event(`task-${i}`, { kind: 'command', command: 'task', scope: other }), f.policy.revision, false);
    await f.store.accept(saved.id, 'task', f.policy.revision);
  }
  const extra = await f.store.save(event('task-extra', { kind: 'command', command: 'task', scope: other }), f.policy.revision, false);
  await assert.rejects(f.store.accept(extra.id, 'task', f.policy.revision), /queue_full/);
  for (let i = 0; i < 10; i++) await read(`read-${i}`);
  assert.equal((await rows('jobs')).filter(j => j.type === 'read' && j.state === 'queued').length, 10);
  await assert.rejects(read('read-over'), /queue_full/);
});
