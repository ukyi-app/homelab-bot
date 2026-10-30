import { after, before, beforeEach, test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { DEFAULTS } from '../src/contracts.js';
import type { CancelRequest } from '../src/worker.js';
import { localDatabase, fixture, event } from './helpers.js';

// impl-sched S3·S4: chat unknown은 경과 시간이 아니라 작업자의 종료 확인(cancel stopped:true)으로만 failed가 된다.
// 조사는 작업별 backoff(30초부터 두 배, 상한 10분)로 되풀이하고 새 모델 실행을 자동으로 시작하지 않는다. task는 건드리지 않는다.
// 확인 완료 안내는 같은 트랜잭션에서 멱등 키로 한 번만 넣는다.
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
// 이전 게시 서버가 남긴 unknown chat(lease_token 보존).
async function unknownJob(id = 'chat', options = {}) {
  await queued(id, options);
  const lease = randomUUID();
  await database.db.query(`UPDATE jobs SET state='unknown',wait_reason='lease_expired',attempt=1,lease_token=$1,lease_until=$2
    WHERE event_id=(SELECT id FROM events WHERE delivery_id=$3)`, [lease, f.now(), id]);
  return (await rows('jobs')).find(j => j.lease_token === lease)!;
}
function cancels(answer: (request: CancelRequest) => boolean | Promise<boolean>) {
  const calls: CancelRequest[] = [];
  f.worker.cancel = async request => { calls.push(request); return { stopped: await answer(request) }; };
  return calls;
}

test('S3 작업자가 멈춤을 확인하면 unknown chat은 failed + 안내 1개, 다시 조사하지 않음', async () => {
  const job = await unknownJob();
  const calls = cancels(() => true);
  assert.equal(await f.runtime.tick(), false);
  assert.deepEqual(calls, [{ job: job.id, lease: job.lease_token }]);
  const row = (await rows('jobs'))[0]!;
  assert.equal(row.state, 'failed'); assert.equal(row.wait_reason, 'stop_confirmed_after_unknown'); assert.ok(row.finished_at);
  const sent = await notices('unknown-resolved:');
  assert.equal(sent.length, 1); assert.match(sent[0]!.payload.content, new RegExp(`/retry target:${job.id}`));
  assert.ok((await rows('audit')).some(a => a.kind === 'unknown_stop_confirmed' && a.subject === job.id));
  // 새 모델 실행을 자동으로 시작하지 않는다. /retry로만 다시 돈다.
  assert.equal(f.requests.length, 0);
  f.advance(3_600_000); await f.runtime.tick();
  assert.equal(calls.length, 1); assert.equal((await notices('unknown-resolved:')).length, 1);
  assert.notEqual(((await f.store.control(f.policy.owner, job.conversation_id, 'retry', job.id)) as { ok?: boolean }).ok, false);
});

test('S3 확인하지 못하면 unknown 유지, 작업별 backoff 30초→1분→2분… 상한 10분', async () => {
  await unknownJob();
  const calls = cancels(() => false);
  const probe = async (advance: number) => { f.advance(advance); await f.runtime.tick(); return calls.length; };
  assert.equal(await probe(0), 1);
  assert.equal(await probe(29_999), 1);
  assert.equal(await probe(1), 2);
  assert.equal(await probe(59_999), 2);
  assert.equal(await probe(1), 3);
  assert.equal(await probe(120_000), 4);
  assert.equal(await probe(240_000), 5);
  assert.equal(await probe(480_000), 6);
  // 상한 10분.
  assert.equal(await probe(599_999), 6);
  assert.equal(await probe(1), 7);
  assert.equal(await probe(600_000), 8);
  assert.equal((await rows('jobs'))[0]!.state, 'unknown');
  assert.equal((await notices('unknown-resolved:')).length, 0);
  assert.equal(f.requests.length, 0);
});

test('S3 작업자 오류·응답 실패도 unknown 유지', async () => {
  await unknownJob();
  f.worker.cancel = async () => { throw new Error('worker_unreachable'); };
  await f.runtime.tick();
  assert.equal((await rows('jobs'))[0]!.state, 'unknown');
});

test('S3 확인하는 사이 상태·lease가 바뀌었으면 CAS로 바꾸지 않음', async () => {
  const job = await unknownJob();
  cancels(async () => { await database.db.query('UPDATE jobs SET lease_token=$2 WHERE id=$1', [job.id, randomUUID()]); return true; });
  await f.runtime.tick();
  const row = (await rows('jobs'))[0]!;
  assert.equal(row.state, 'unknown'); assert.equal((await notices('unknown-resolved:')).length, 0);
});

test('S3 task unknown은 조사하지 않음', async () => {
  await unknownJob('task', { kind: 'command', command: 'task' });
  const calls = cancels(() => true);
  await f.runtime.tick();
  assert.equal(calls.length, 0); assert.equal((await rows('jobs'))[0]!.state, 'unknown');
});

test('S3 lease가 새로 바뀐 unknown은 backoff를 처음부터', async () => {
  const job = await unknownJob();
  const calls = cancels(() => false);
  await f.runtime.tick(); f.advance(30_000); await f.runtime.tick(); f.advance(60_000); await f.runtime.tick();
  assert.equal(calls.length, 3);
  await database.db.query('UPDATE jobs SET lease_token=$2 WHERE id=$1', [job.id, randomUUID()]);
  await f.runtime.tick();
  assert.equal(calls.length, 4);
});

for (const kind of ['worker_disconnected', 'runtime_uncertain'] as const) test(`S2 ${kind}: unknown 전에 한 번 cancel, 확인되면 failed(/retry 가능)`, async () => {
  await queued();
  if (kind === 'worker_disconnected') f.setRun(async () => ({ status: 'unknown', stopped: false }));
  else f.worker.execute = async () => { throw new Error('worker_response_uncertain'); };
  const calls = cancels(() => true);
  await f.runtime.tick();
  const job = (await rows('jobs'))[0]!;
  assert.equal(calls.length, 1);
  assert.equal(job.state, 'failed'); assert.equal(job.wait_reason, 'stop_confirmation');
  assert.equal((await notices(`failure:${job.id}:1`)).length, 1);
  assert.equal((await notices('unknown:')).length, 0);
});

for (const kind of ['worker_disconnected', 'runtime_uncertain'] as const) test(`S2 ${kind}: 확인하지 못하면 unknown`, async () => {
  await queued();
  if (kind === 'worker_disconnected') f.setRun(async () => ({ status: 'unknown', stopped: false }));
  else f.worker.execute = async () => { throw new Error('worker_response_uncertain'); };
  const calls = cancels(() => false);
  await f.runtime.tick();
  const job = (await rows('jobs'))[0]!;
  assert.ok(calls.length >= 1);
  assert.equal(job.state, 'unknown'); assert.equal(job.wait_reason, kind);
});

