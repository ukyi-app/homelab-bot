import { after, before, beforeEach, test } from 'node:test';
import assert from 'node:assert/strict';
import { Denied, DEFAULTS } from '../src/contracts.js';
import type { WorkerResult } from '../src/worker.js';
import { ReadAdapter } from '../src/read.js';
import { Runtime } from '../src/runtime.js';
import { event, fixture, localDatabase, service, template, thread } from './helpers.js';

let database: Awaited<ReturnType<typeof localDatabase>>;
let f: Awaited<ReturnType<typeof fixture>>;
before(async () => { database = await localDatabase(); });
beforeEach(async () => {
  await database.pg.exec('TRUNCATE events,conversations,jobs,results,outbox,schedules,denied_actors,controls,audit,incidents RESTART IDENTITY CASCADE');
  f = await fixture(database.db);
});
after(async () => { await database.pg.close(); });
async function rows(table: string) { return (await database.db.query<Record<string, any>>(`SELECT * FROM ${table}`)).rows; }
async function queue() { await f.ingress.receive(event('fixture-request')); f.advance(DEFAULTS.debounceMs); }
const success: WorkerResult = { status: 'succeeded', stopped: true, answer: { facts: [], hypotheses: [], unknowns: [], checks: [] } };
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(done => { resolve = done; });
  return { promise, resolve };
}
async function assertRevoked(stopped: boolean) {
  const job = (await rows('jobs'))[0]!;
  assert.equal(job.state, stopped ? 'cancelled' : 'unknown');
  assert.equal(job.wait_reason, 'authorization_revoked');
  assert.equal((await rows('outbox')).length, 0); assert.equal((await rows('results')).length, 0);
  assert.equal((await f.store.control('fixture-owner', f.store.scopeId(thread), 'retry', job.id) as { ok: boolean }).ok, false);
  if (!stopped) assert.equal(await f.runtime.tick(), false);
}
for (const reason of ['owner', 'scope', 'revocation']) for (const stopped of [true, false]) {
  test(`4315477925 monitor ${reason} 철회·종료 확인 ${stopped}는 취소/unknown 사유 보존`, async t => {
    t.mock.timers.enable({ apis: ['setInterval'] });
    await queue(); const started = deferred<void>();
    f.setRun(() => { started.resolve(); return new Promise(() => {}); });
    let cancels = 0; const cancel = f.worker.cancel.bind(f.worker);
    f.worker.cancel = async (...args) => { cancels++; return stopped ? cancel(...args) : { stopped: false }; };
    const running = f.runtime.tick(); await started.promise;
    if (reason === 'owner') f.policy.owner = 'fixture-other-owner';
    else if (reason === 'scope') f.policy.conversationChannel = 'fixture-other-channel';
    else await f.gate.revoke(f.policy.owner, thread, f.policy.owner);
    t.mock.timers.tick(1000); await running;
    assert.equal(cancels, 1); assert.equal(f.requests.length, 1); await assertRevoked(stopped);
  });
}
for (const error of [new Denied(), new Error('cancel_transport_lost')]) test(`4315477925 철회 뒤 cancel ${error.message}는 종료를 확정하지 않음`, async t => {
  t.mock.timers.enable({ apis: ['setInterval'] }); await queue(); const started = deferred<void>();
  f.setRun(() => { started.resolve(); return new Promise(() => {}); });
  f.worker.cancel = async () => { throw error; };
  const running = f.runtime.tick(); await started.promise; f.policy.owner = 'fixture-other-owner';
  t.mock.timers.tick(1000); await running; await assertRevoked(false);
});
test('4315477925 monitor가 확인한 철회는 cancel 중 정책 복구 뒤에도 유지', async t => {
  t.mock.timers.enable({ apis: ['setInterval'] }); await queue(); const started = deferred<void>();
  f.setRun(() => { started.resolve(); return new Promise(() => {}); });
  const cancel = f.worker.cancel.bind(f.worker);
  f.worker.cancel = async (...args) => { f.policy.owner = 'fixture-owner'; return cancel(...args); };
  const running = f.runtime.tick(); await started.promise; f.policy.owner = 'fixture-other-owner';
  t.mock.timers.tick(1000); await running; await assertRevoked(true);
});
test('4315477925 취소 상태 기록의 일시 오류도 일반 실패/실패 안내로 바꾸지 않음', async t => {
  t.mock.timers.enable({ apis: ['setInterval'] }); await queue(); const started = deferred<void>();
  f.setRun(() => { started.resolve(); return new Promise(() => {}); });
  const transition = f.store.transition.bind(f.store); let failures = 0;
  f.store.transition = async (...args) => {
    if (args[2] === 'authorization_revoked' && failures++ === 0) throw new Error('temporary_write_failure');
    return transition(...args);
  };
  const running = f.runtime.tick(); await started.promise; f.policy.owner = 'fixture-other-owner';
  t.mock.timers.tick(1000); await running;
  assert.equal(failures, 2); await assertRevoked(true);
});
for (const status of ['succeeded', 'failed', 'limited', 'auth_expired'] as const) {
  test(`4315477925 monitor 이전 ${status} 완료도 현재 철회 우선`, async () => {
    await queue(); f.setRun(async () => {
      f.policy.owner = 'fixture-other-owner'; return status === 'succeeded' ? success : { status, stopped: true };
    });
    await f.runtime.tick(); await assertRevoked(true);
    assert.equal((await rows('controls')).find(c => c.key === 'scheduler')!.value, false);
  });
}
for (const status of ['limited', 'auth_expired'] as const) test(`R7-AUDIT ${status} 확인 결과는 일반 monitor DB 오류보다 우선`, async t => {
  t.mock.timers.enable({ apis: ['setInterval'] }); await queue();
  const started = deferred<void>(); const finished = deferred<WorkerResult>();
  const monitoring = deferred<void>(); const release = deferred<void>();
  f.setRun(() => { started.resolve(); return finished.promise; });
  f.store.heartbeat = async () => { monitoring.resolve(); await release.promise; throw new Error('monitor_db_lost'); };
  const running = f.runtime.tick(); await started.promise; t.mock.timers.tick(1000); await monitoring.promise;
  finished.resolve({ status, stopped: true }); release.resolve(); await running;
  const job = (await rows('jobs'))[0]!;
  assert.equal(job.state, 'waiting_user'); assert.equal(job.wait_reason, status === 'limited' ? 'model_limit' : 'auth_expired');
  // impl-sched S4: waiting_user 안내(waiting:<job>:<attempt>)는 제외하고 센다.
  assert.equal((await rows('outbox')).filter(o => !/^(waiting|unknown):/.test(o.idempotency_key)).length, 0); assert.equal((await rows('controls')).find(c => c.key === 'scheduler')!.value, true);
});
test('4315477925 완료와 교차한 진행 중 monitor의 Denied도 종결 전에 반영', async t => {
  t.mock.timers.enable({ apis: ['setInterval'] }); await queue();
  const started = deferred<void>(); const finished = deferred<WorkerResult>();
  const monitoring = deferred<void>(); const release = deferred<void>();
  f.setRun(() => { started.resolve(); return finished.promise; });
  const authorize = f.gate.authorize.bind(f.gate); let hold = false;
  f.gate.authorize = async (...args) => {
    if (hold) { hold = false; monitoring.resolve(); await release.promise; throw new Denied(); }
    return authorize(...args);
  };
  const running = f.runtime.tick(); await started.promise; hold = true; t.mock.timers.tick(1000); await monitoring.promise;
  finished.resolve(success);
  // Let result handling advance while the policy read remains in flight.
  await new Promise<void>(resolve => setImmediate(resolve));
  release.resolve(); await running; await assertRevoked(true);
});
for (const stopped of [true, false]) test(`R7-AUDIT 일반 monitor DB 오류는 철회와 구분 (stopped=${stopped})`, async t => {
  t.mock.timers.enable({ apis: ['setInterval'] }); await queue(); const started = deferred<void>();
  f.setRun(() => { started.resolve(); return new Promise(() => {}); });
  f.store.heartbeat = async () => { throw new Error('db_connection_lost'); };
  f.worker.cancel = async () => ({ stopped });
  const running = f.runtime.tick(); await started.promise; t.mock.timers.tick(1000); await running;
  const job = (await rows('jobs'))[0]!;
  assert.equal(job.state, stopped ? 'failed' : 'unknown'); assert.equal(job.wait_reason, 'stop_confirmation');
  assert.equal((await rows('outbox')).filter(o => !/^(waiting|unknown):/.test(o.idempotency_key)).length, stopped ? 1 : 0);
});
test('R7-AUDIT 조회 중 서비스 철회도 일반 실패가 아닌 취소로 전파', async () => {
  await f.ingress.receive(event('read', { kind: 'command', command: 'read', target: service.id, text: template.id }));
  let queries = 0;
  const reader = new ReadAdapter([service], [template], f.gate, { query: async () => {
    queries++; f.policy.services = [];
    return new TextEncoder().encode(JSON.stringify({ observedAt: f.now(), rows: [{ status: 'healthy' }] }));
  } }, f.now);
  await new Runtime(f.store, f.gate, f.worker, f.signer, reader).tickRead();
  await assertRevoked(true); assert.equal(queries, 1); assert.equal(f.requests.length, 0);
});

for (const status of ['failed', 'limited', 'auth_expired'] as const) test(`R7-AUDIT ${status} 결과에서 정책 확인 불가는 철회로 오인하지 않음`, async () => {
  await queue(); f.setRun(async () => {
    f.setPolicyUnavailable(true); return { status, stopped: true };
  });
  await f.runtime.tick(); const job = (await rows('jobs'))[0]!;
  assert.equal(job.state, status === 'failed' ? 'failed' : 'waiting_user');
  assert.equal(job.wait_reason, status === 'failed' ? 'model_failed' : status === 'limited' ? 'model_limit' : 'auth_expired');
  assert.equal((await rows('outbox')).filter(o => !/^(waiting|unknown):/.test(o.idempotency_key)).length, status === 'failed' ? 1 : 0);
});
for (const status of ['limited', 'auth_expired'] as const) for (const phase of ['authorization', 'state']) {
  test(`R7-AUDIT ${status} 확인 직후 ${phase} DB 오류도 재시도 가능한 실패를 만들지 않음`, async () => {
    await queue(); let completed = false; let failed = false;
    f.setRun(async () => { completed = true; return { status, stopped: true }; });
    const authorize = f.gate.authorize.bind(f.gate);
    const query = database.db.query.bind(database.db);
    f.gate.authorize = async (...args) => {
      if (phase === 'authorization' && completed && !failed) { failed = true; throw new Error('authorization_db_lost'); }
      return authorize(...args);
    };
    database.db.query = async (sql, params) => {
      if (phase === 'state' && completed && !failed && sql === 'SELECT state FROM jobs WHERE id=$1') {
        failed = true; throw new Error('state_db_lost');
      }
      return query(sql, params);
    };
    try { await f.runtime.tick(); } finally { database.db.query = query; }
    assert.equal(failed, true); assert.equal((await rows('jobs'))[0]!.state, 'running');
    assert.equal((await rows('outbox')).length, 0); assert.equal(await f.runtime.tick(), false);
    f.advance(DEFAULTS.leaseMs + 1); assert.equal(await f.runtime.tick(), false);
    assert.equal((await rows('jobs'))[0]!.state, 'unknown'); assert.equal(f.requests.length, 1);
  });
}
