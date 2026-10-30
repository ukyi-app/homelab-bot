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
