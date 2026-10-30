import { after, before, beforeEach, test } from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULTS } from '../src/contracts.js';
import { localDatabase, fixture, event } from './helpers.js';

// impl-sched S4: 상태 알림. chat이 waiting_user·unknown이 될 때 같은 트랜잭션에서 그 대화에 안내를 넣는다.
// 멱등 키는 (job, attempt)라 같은 시도가 다시 같은 상태에 들어가도 하나다. 멘션은 넣지 않는다(owner 멘션은 나중 결정).
let database: Awaited<ReturnType<typeof localDatabase>>;
let f: Awaited<ReturnType<typeof fixture>>;
before(async () => { database = await localDatabase(); });
beforeEach(async () => {
  await database.pg.exec('TRUNCATE events,conversations,jobs,results,outbox,schedules,denied_actors,controls,audit,incidents RESTART IDENTITY CASCADE');
  f = await fixture(database.db);
});
after(async () => { await database.pg.close(); });
async function rows(table: string) { return (await database.db.query<Record<string, any>>(`SELECT * FROM ${table}`)).rows; }
async function queued(id = 'chat', options = {}) { await f.ingress.receive(event(id, options)); f.advance(DEFAULTS.debounceMs); }
const notices = async (prefix: string) => (await rows('outbox')).filter(o => o.idempotency_key.startsWith(prefix));

test('S4 runtime이 unknown을 기록하면 안내 1개(종료 확인을 계속 시도한다는 것, /model-status)', async () => {
  await queued();
  f.setRun(async () => ({ status: 'unknown', stopped: false }));
  f.worker.cancel = async () => ({ stopped: false });
  await f.runtime.tick();
  const job = (await rows('jobs'))[0]!;
  assert.equal(job.state, 'unknown');
  const sent = await notices('unknown:');
  assert.deepEqual(sent.map(o => o.idempotency_key), [`unknown:${job.id}:1`]);
  assert.match(sent[0]!.payload.content, /종료 확인을 계속/); assert.match(sent[0]!.payload.content, /\/model-status/);
});

test('S4 권한 철회로 인한 unknown은 안내하지 않음(철회된 대화에 게시하지 않는다)', async () => {
  await queued();
  const job = (await f.store.claim())!;
  await f.store.transition(job, 'unknown', 'authorization_revoked');
  assert.equal((await rows('jobs'))[0]!.state, 'unknown');
  assert.equal((await notices('unknown:')).length, 0);
});

test('S4 lease 만료 unknown 안내는 expire를 거듭해도 attempt마다 1개', async () => {
  await queued();
  const job = (await f.store.claim())!;
  f.advance(DEFAULTS.leaseMs + 1);
  await f.store.expire();
  assert.equal((await rows('jobs'))[0]!.state, 'unknown');
  await database.db.query("UPDATE jobs SET state='running',lease_until=$2 WHERE id=$1", [job.id, f.now() - 1]);
  await f.store.expire();
  const sent = await notices('unknown:');
  assert.deepEqual(sent.map(o => o.idempotency_key), [`unknown:${job.id}:1`]);
  assert.equal(sent[0]!.payload.channel, job.target.channel);
});

test('S4 task의 unknown·waiting_user는 store가 안내하지 않음(작업 레인이 따로 알린다)', async () => {
  await queued('task', { kind: 'command', command: 'task' });
  await f.store.claim(); f.advance(DEFAULTS.leaseMs + 1); await f.store.expire();
  assert.equal((await rows('jobs'))[0]!.state, 'unknown');
  assert.equal((await notices('unknown:')).length, 0);
});

for (const status of ['limited', 'auth_expired'] as const) test(`S4 ${status} waiting_user 안내 1개(같은 attempt 두 번이어도), 멘션 없음`, async () => {
  await queued();
  f.setRun(async () => ({ status, stopped: true }));
  await f.runtime.tick();
  const job = (await rows('jobs'))[0]!;
  assert.equal(job.state, 'waiting_user');
  // 같은 attempt가 다시 대기에 들어가도(재시작 경합 등) 안내는 하나다.
  await database.db.query(`UPDATE jobs SET state='running',lease_until=$2 WHERE id=$1`, [job.id, f.now() + 1000]);
  await f.store.waitForUser({ ...job, target: job.target, revision: job.revision } as never, status === 'limited' ? 'model_limit' : 'auth_expired');
  const sent = await notices('waiting:');
  assert.deepEqual(sent.map(o => o.idempotency_key), [`waiting:${job.id}:1`]);
  assert.match(sent[0]!.payload.content, new RegExp(`/resume-model target:${job.id}`));
  assert.match(sent[0]!.payload.content, /\/model-status/);
  assert.match(sent[0]!.payload.content, status === 'limited' ? /한도/ : /인증/);
  while (await f.publisher.deliver()) { /* drain */ }
  const message = f.rest.messages.find(m => m.body.content.includes('/resume-model'))!;
  assert.deepEqual(message.body.allowed_mentions, { parse: [] });
  assert.ok(!message.body.content.includes('<@'));
});
