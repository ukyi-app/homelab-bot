import { after, before, beforeEach, test } from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULTS } from '../src/contracts.js';
import { Runtime } from '../src/runtime.js';
import type { RuntimeOptions } from '../src/runtime.js';
import type { WorkerResult } from '../src/worker.js';
import { localDatabase, fixture, event } from './helpers.js';

// fix-a F2·F3. 작업자의 cancel은 자기가 잡고 있는 job일 때만 stopped:true를 주고, 첫 확인 뒤 job을 놓는다.
// F2: 드레인 기한이 되면 DB 검사(monitor·재인가·상태 조회)를 기다리지 않고 그 자리에서 cancel을 보낸다.
// F3: 확인된 멈춤 뒤의 상태 쓰기가 일시 DB 오류로 실패해도 cancel을 다시 묻지 않고(두 번째는 false다) unknown으로 적지 않는다.
let database: Awaited<ReturnType<typeof localDatabase>>;
let f: Awaited<ReturnType<typeof fixture>>;
before(async () => { database = await localDatabase(); });
beforeEach(async () => {
  await database.pg.exec('TRUNCATE events,conversations,jobs,results,outbox,schedules,denied_actors,controls,audit,incidents RESTART IDENTITY CASCADE');
  f = await fixture(database.db);
});
after(async () => { await database.pg.close(); });
const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
async function rows(table: string) { return (await database.db.query<Record<string, any>>(`SELECT * FROM ${table}`)).rows; }
async function queued() { await f.ingress.receive(event('chat')); f.advance(DEFAULTS.debounceMs); }
const logs: { event: string; detail?: Record<string, unknown> }[] = [];
function runtime(shutdown?: AbortController, drainMs = 50) {
  logs.length = 0;
  // log는 수정 전 RuntimeOptions에 없다. 리터럴 초과 속성 검사를 피해 수정 전 코드에서도 컴파일되게 한다.
  const options: RuntimeOptions = { shutdown: shutdown?.signal, drainMs, ...{ log: (e: string, d?: Record<string, unknown>) => { logs.push({ event: e, detail: d }); } } };
  return new Runtime(f.store, f.gate, f.worker, f.signer, f.reader, undefined, options);
}
function holding() {
  let started!: () => void;
  const running = new Promise<void>(resolve => { started = resolve; });
  f.setRun(async () => { started(); return new Promise<WorkerResult>(() => {}); });
  return running;
}
// 작업자 cancel: 처음 한 번만 멈춤을 확인하고(job을 놓는다) 이후는 false. 도착 시각을 남긴다.
function cancelOnce() {
  const at: number[] = [];
  f.worker.cancel = async () => { at.push(Date.now()); return { stopped: at.length === 1 }; };
  return at;
}
// 한 번만 던지는 DB 쓰기 오류.
function failOnce<K extends 'fail' | 'requeueAfterShutdown'>(name: K, times = 1) {
  const original = f.store[name].bind(f.store) as (...args: unknown[]) => Promise<unknown>;
  let left = times;
  (f.store as any)[name] = async (...args: unknown[]) => {
    if (left-- > 0) throw new Error('db_blip');
    return original(...args);
  };
}

for (const slow of ['reauthorize', 'monitor'] as const) {
  test(`F2 드레인 기한에 cancel이 바로 나감(${slow} 지연 중) → 확인된 chat은 queued`, async () => {
    await queued();
    const stop = new AbortController();
    const running = holding();
    const cancels = cancelOnce();
    // monitor는 1초마다 돈다. monitor 지연은 드레인(1.1초)이 monitor 실행 중에 오도록 맞춘다.
    const drainMs = slow === 'monitor' ? 1100 : 50;
    let slowed = false;
    if (slow === 'reauthorize') {
      const authorize = f.gate.authorize.bind(f.gate);
      f.gate.authorize = async (...args: Parameters<typeof authorize>) => { if (slowed) await sleep(1500); return authorize(...args); };
    } else {
      const heartbeat = f.store.heartbeat.bind(f.store);
      f.store.heartbeat = async job => { if (slowed) await sleep(1500); return heartbeat(job); };
    }
    const tick = runtime(stop, drainMs).tick();
    await running;
    slowed = true;
    const signalled = Date.now();
    stop.abort();
    await tick;
    assert.equal(cancels.length, 1, 'cancel은 한 번');
    const delay = cancels[0]! - signalled;
    assert.ok(delay < drainMs + 400, `cancel이 드레인 뒤 ${delay - drainMs}ms 늦게 나감`);
    const job = (await rows('jobs'))[0]!;
    assert.equal(job.state, 'queued'); assert.equal(job.wait_reason, 'publisher_shutdown');
  });
}

test('F3 첫 cancel 확인 → fail 1회 DB 오류 → 복구: cancel 다시 안 묻고 failed(stop_confirmation)', async () => {
  await queued();
  f.setRun(async () => ({ status: 'unknown', stopped: false }));
  const cancels = cancelOnce();
  failOnce('fail');
  await runtime().tick();
  const job = (await rows('jobs'))[0]!;
  assert.equal(cancels.length, 1, 'cancel을 다시 물음');
  assert.equal(job.state, 'failed'); assert.equal(job.wait_reason, 'stop_confirmation');
  assert.ok((await rows('outbox')).some(o => o.idempotency_key === `failure:${job.id}:1`));
});

test('F3 드레인 종료: 확인 뒤 되돌리기 1회 DB 오류 → 복구: cancel 다시 안 묻고 queued', async () => {
  await queued();
  const stop = new AbortController();
  const running = holding();
  const cancels = cancelOnce();
  failOnce('requeueAfterShutdown');
  const tick = runtime(stop).tick();
  await running;
  stop.abort();
  await tick;
  const job = (await rows('jobs'))[0]!;
  assert.equal(cancels.length, 1, 'cancel을 다시 물음');
  assert.equal(job.state, 'queued'); assert.equal(job.wait_reason, 'publisher_shutdown'); assert.equal(job.attempt, 1);
});

test('F3 확인 뒤 상태 쓰기가 끝내 실패해도 unknown으로 적지 않고 로그·감사를 남김', async () => {
  await queued();
  f.setRun(async () => ({ status: 'unknown', stopped: false }));
  const cancels = cancelOnce();
  failOnce('fail', 100);
  await runtime().tick();
  const job = (await rows('jobs'))[0]!;
  assert.equal(cancels.length, 1, 'cancel을 다시 물음');
  assert.notEqual(job.state, 'unknown');
  assert.equal(job.state, 'running', 'lease가 끝나면 expire가 처리한다');
  assert.ok(logs.some(l => l.event === 'stop_confirmed_write_failed' && l.detail?.job === job.id));
  assert.ok((await rows('audit')).some(a => a.kind === 'stop_confirmed_write_failed' && a.subject === job.id));
});

// rev-a2 후속. 실행 대기가 stopped:false(불확실 응답·예외)로 끝나면 DB 후처리를 기다리지 않고 그 자리에서 공유 cancel을 보낸다.
// cancel은 한 실행에 한 번이다. false·오류도 결과로 다시 쓰고, catch도 같은 판정(드레인이면 shutdownOutcome)을 거친다.
function cancelSequence(answers: (boolean | 'error')[]) {
  const at: number[] = [];
  f.worker.cancel = async () => {
    const answer = answers[at.length] ?? false;
    at.push(Date.now());
    if (answer === 'error') throw new Error('cancel_http');
    return { stopped: answer };
  };
  return at;
}
for (const outcome of ['unknown_response', 'execute_error'] as const) {
  test(`F2 후속: 드레인 전에 실행 대기가 끝나면(${outcome}) DB 후처리가 느려도 cancel이 바로 나감`, async () => {
    await queued();
    const stop = new AbortController();
    const cancels = cancelOnce();
    let slowed = false;
    let finished = 0;
    if (outcome === 'unknown_response') {
      // 종료 신호 뒤 50ms에 불확실 응답, 이후 재인가가 1.5초 느리다.
      f.setRun(async () => { await sleep(50); slowed = true; finished = Date.now(); return { status: 'unknown', stopped: false }; });
      const authorize = f.gate.authorize.bind(f.gate);
      f.gate.authorize = async (...args: Parameters<typeof authorize>) => { if (slowed) await sleep(1500); return authorize(...args); };
    } else {
      // 1초에 시작한 monitor가 1.5초 걸리는 동안(1.1초) execute가 예외로 끝난다.
      f.setRun(async () => { await sleep(1100); finished = Date.now(); throw new Error('worker_connection_lost'); });
      const heartbeat = f.store.heartbeat.bind(f.store);
      f.store.heartbeat = async job => { await sleep(1500); return heartbeat(job); };
    }
    const tick = runtime(stop, 5000).tick();
    await sleep(10);
    stop.abort();
    await tick;
    assert.equal(cancels.length, 1, 'cancel은 한 번');
    const delay = cancels[0]! - finished;
    assert.ok(delay < 300, `cancel이 실행 대기 종료 뒤 ${delay}ms 늦게 나감`);
    const job = (await rows('jobs'))[0]!;
    // 드레인 전에 끝난 불확실 실행은 일반 불확실 판정 그대로다(확인되면 failed).
    assert.equal(job.state, 'failed'); assert.equal(job.wait_reason, 'stop_confirmation');
  });
}
for (const first of [false, 'error'] as const) {
  test(`F2 후속: 드레인 cancel ${first === false ? 'false' : '오류'} + 후처리 DB 오류 → cancel 1번, unknown(publisher_shutdown)`, async () => {
    await queued();
    const stop = new AbortController();
    const running = holding();
    // 두 번째 cancel이 있었다면 확인했을 것이다. 한 번만 보내야 한다.
    const cancels = cancelSequence([first, true]);
    let broken = false;
    const authorize = f.gate.authorize.bind(f.gate);
    f.gate.authorize = async (...args: Parameters<typeof authorize>) => { if (broken) throw new Error('db_blip'); return authorize(...args); };
    const tick = runtime(stop).tick();
    await running;
    broken = true;
    stop.abort();
    await tick;
    assert.equal(cancels.length, 1, 'cancel을 다시 보냄');
    const job = (await rows('jobs'))[0]!;
    assert.equal(job.state, 'unknown'); assert.equal(job.wait_reason, 'publisher_shutdown');
  });
}
test('F2 후속: 드레인 cancel 확인 + 후처리 DB 오류 → cancel 1번, chat은 queued(shutdownOutcome)', async () => {
  await queued();
  const stop = new AbortController();
  const running = holding();
  const cancels = cancelSequence([true]);
  let broken = false;
  const authorize = f.gate.authorize.bind(f.gate);
  f.gate.authorize = async (...args: Parameters<typeof authorize>) => { if (broken) throw new Error('db_blip'); return authorize(...args); };
  const tick = runtime(stop).tick();
  await running;
  broken = true;
  stop.abort();
  await tick;
  assert.equal(cancels.length, 1);
  const job = (await rows('jobs'))[0]!;
  assert.equal(job.state, 'queued'); assert.equal(job.wait_reason, 'publisher_shutdown');
});
