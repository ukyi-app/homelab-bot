import { after, before, beforeEach, test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { CHAT_TASK_TEXT } from '../src/chat-task-text.js';
import { DEFAULTS } from '../src/contracts.js';
import type { CancelRequest } from '../src/worker.js';
import { localDatabase, fixture, event } from './helpers.js';

// S3·S4: chat unknown은 경과 시간이 아니라 작업자의 종료 확인(cancel stopped:true)으로만 failed가 된다.
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

// 실제 작업자는 첫 확인 뒤 job을 놓아 두 번째 cancel에 stopped:false다. 확인 직후 쓰기가 일시 실패해도
// 확인 결과를 유지한 채 쓰기만 다시 해야 한다. 아니면 풀 수 없는 unknown이 모델 슬롯을 계속 막는다.
test('S3 확인 뒤 resolveUnknown 일시 DB 오류: cancel 다시 안 묻고 쓰기만 재시도해 failed', async () => {
  const job = await unknownJob();
  let held = true;
  const calls = cancels(() => { const answer = held; held = false; return answer; });
  const original = f.store.resolveUnknown.bind(f.store);
  let failures = 1;
  f.store.resolveUnknown = async (...args: Parameters<typeof original>) => {
    if (failures-- > 0) throw new Error('db_blip');
    return original(...args);
  };
  await f.runtime.tick().catch(() => {});
  f.advance(3_600_000); await f.runtime.tick().catch(() => {});
  assert.equal(calls.length, 1, 'cancel을 다시 물음');
  assert.deepEqual(calls[0], { job: job.id, lease: job.lease_token });
  const row = (await rows('jobs'))[0]!;
  assert.equal(row.state, 'failed'); assert.equal(row.wait_reason, 'stop_confirmed_after_unknown');
  assert.equal((await notices('unknown-resolved:')).length, 1);
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

// 이전 실행이 남긴 unknown review(게시 서버 쪽 ReviewQueue가 넣는 모양 그대로).
async function unknownReview(lease: string | null = randomUUID()) {
  const event = randomUUID(), id = randomUUID();
  await database.db.query(`INSERT INTO events(id,provider,delivery_id,semantic_key,actor_id,scope,conversation_id,received_at,payload,accepted)
    VALUES ($1,'github',$2,$3,'github:1','{"kind":"github","repo":1,"pr":7}',NULL,$4,'{"command":"review"}',true)`, [event, `d-${id}`, `k-${id}`, f.now()]);
  await database.db.query(`INSERT INTO jobs(id,event_id,conversation_id,type,owner_id,target,revision,budget,priority,available_at,created_at,state,wait_reason,attempt,lease_token,lease_until)
    VALUES ($1,$2,NULL,'review','github-review','{"kind":"github","repo":1,"pr":7}','{"policy":"rp-x"}','{"timeoutMs":1000,"toolCalls":0}',40,$3,$3,'unknown','worker_disconnected',1,$4,$3)`,
  [id, event, f.now(), lease]);
  await database.db.query(`INSERT INTO pr_reviews(job_id,generation_key,installation_id,repo_id,repo_full_name,pr_number,head_sha,comparison_revision,
    base_ref,policy_revision,trigger,pr_updated_at,created_at) VALUES ($1,$2,1,1,'o/r',7,'h','c','main','rp-x','opened',$3,$3)`, [id, `g-${id}`, f.now()]);
  return (await rows('jobs')).find(j => j.id === id)!;
}
const review = async (id: string) => (await database.db.query<Record<string, any>>('SELECT * FROM pr_reviews WHERE job_id=$1', [id])).rows[0]!;

test('T17 리뷰 unknown: 작업자가 멈춤을 확인하면 failed로 풀려 전역 슬롯이 비고, 새 실행은 자동으로 시작하지 않음', async () => {
  const job = await unknownReview();
  await queued('next');
  // 풀리기 전에는 대화도 집히지 않는다.
  assert.equal(await f.store.claim(), undefined);
  const calls = cancels(() => true);
  assert.equal(await f.runtime.probeUnknown(), 1);
  assert.deepEqual(calls, [{ job: job.id, lease: job.lease_token }]);
  const row = (await rows('jobs')).find(j => j.id === job.id)!;
  assert.equal(row.state, 'failed'); assert.equal(row.wait_reason, 'stop_confirmed_after_unknown'); assert.ok(row.finished_at);
  assert.equal((await review(job.id)).review_outcome, 'failed');
  assert.ok((await rows('audit')).some(a => a.kind === 'unknown_stop_confirmed' && a.subject === job.id));
  // 리뷰 job에는 Discord 대상이 없어 안내를 넣지 않는다. /retry 문구가 나가면 안 된다.
  assert.equal((await notices('unknown-resolved:')).length, 0);
  assert.equal(f.requests.length, 0);
  assert.equal((await f.store.claim())?.type, 'chat');
  f.advance(3_600_000); await f.runtime.probeUnknown();
  assert.equal(calls.length, 1);
});

test('T17 리뷰 unknown: 확인하지 못하면 경과 시간과 무관하게 슬롯을 잡고, chat과 같은 backoff로 다시 묻는다', async () => {
  const job = await unknownReview();
  const calls = cancels(() => false);
  await f.runtime.probeUnknown();
  f.advance(29_999); await f.runtime.probeUnknown();
  assert.equal(calls.length, 1);
  f.advance(1); await f.runtime.probeUnknown();
  assert.equal(calls.length, 2);
  f.worker.cancel = async () => { throw new Error('worker_unreachable'); };
  f.advance(86_400_000); await f.runtime.probeUnknown();
  assert.equal((await rows('jobs'))[0]!.state, 'unknown');
  assert.equal((await review(job.id)).review_outcome, null);
  await queued('next');
  assert.equal(await f.store.claim(), undefined);
});

test('T17 리뷰 unknown: 확인하는 사이 lease가 바뀌면 바꾸지 않고, 밀려난 세대 기록은 보존하며, lease 없는 행은 묻지 않음', async () => {
  const changed = await unknownReview();
  cancels(async () => { await database.db.query('UPDATE jobs SET lease_token=$2 WHERE id=$1', [changed.id, randomUUID()]); return true; });
  await f.runtime.probeUnknown();
  assert.equal((await rows('jobs'))[0]!.state, 'unknown');
  await database.db.query('TRUNCATE jobs,pr_reviews,events,controls CASCADE');
  const old = await unknownReview();
  await database.db.query(`UPDATE pr_reviews SET review_outcome='superseded',superseded_at=1,superseded_reason='new_head' WHERE job_id=$1`, [old.id]);
  cancels(() => true);
  await f.runtime.probeUnknown();
  assert.equal((await rows('jobs'))[0]!.state, 'failed');
  assert.equal((await review(old.id)).review_outcome, 'superseded');
  await database.db.query('TRUNCATE jobs,pr_reviews,events,controls CASCADE');
  await unknownReview(null);
  const calls = cancels(() => true);
  await f.runtime.probeUnknown();
  assert.equal(calls.length, 0);
});

test('T17 /review-cancel은 unknown을 풀지 않고 이유를 알린다(확인 없이 슬롯을 풀지 않음)', async () => {
  const job = await unknownReview();
  const result = await f.store.control(f.policy.owner, '', 'review-cancel', job.id, undefined, { review: true }) as { ok: boolean; status: string };
  assert.equal(result.ok, false);
  assert.equal(result.status, CHAT_TASK_TEXT.reviewUnknownCancel);
  assert.equal((await rows('jobs'))[0]!.state, 'unknown');
  const none = await f.store.control(f.policy.owner, '', 'review-cancel', randomUUID(), undefined, { review: true }) as { ok: boolean; status: string };
  assert.match(none.status, /취소할 리뷰 작업이 없거나/);
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
  const failure = await notices(`failure:${job.id}:1`);
  assert.equal(failure.length, 1);
  // 일반 작업은 /retry를 그대로 안내하고, 그 /retry는 받아들여진다.
  assert.equal(failure[0]!.payload.content, CHAT_TASK_TEXT.jobFailed(false));
  assert.match(failure[0]!.payload.content, /\/retry/);
  assert.notEqual(((await f.store.control(f.policy.owner, job.conversation_id, 'retry', job.id)) as { ok?: boolean }).ok, false);
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

