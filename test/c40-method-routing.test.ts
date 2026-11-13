import { after, before, beforeEach, test } from 'node:test';
import assert from 'node:assert/strict';
import { parseAdminArgs, runAdmin } from '../src/admin.js';
import { DEFAULTS } from '../src/contracts.js';
import type { RateLimitInfo } from '../src/contracts.js';
import type { ExecutionSelection } from '../src/execution-auth.js';
import { MethodRouter, installMethods, methodRoutingView } from '../src/method-routing.js';
import type { MethodPath } from '../src/method-routing.js';
import { recordAccount, switchAccount } from '../src/model-accounts.js';
import { loadRuntimePolicy } from '../src/policy.js';
import { Runtime } from '../src/runtime.js';
import type { WorkerRequest } from '../src/worker.js';
import { localDatabase, fixture, event } from './helpers.js';

// C40 한도 뒤 API 사용의 게시 서버 쪽(COLLEAGUE_SPEC §4.11, AC-32·33·35·36). 경계 S1: 수신 → 저장(PGlite) → runtime → 가짜 작업자.
// 가짜 작업자는 C39의 SerialWorker라 v3 요청의 실행 칸을 요청 선택으로 다시 만든다(넘어갈 근거만 시험이 준다).
let database: Awaited<ReturnType<typeof localDatabase>>;
let f: Awaited<ReturnType<typeof fixture>>;
before(async () => { database = await localDatabase(); });
beforeEach(async () => {
  await database.pg.exec(`TRUNCATE events,conversations,jobs,results,outbox,schedules,denied_actors,controls,audit,incidents,model_pauses,
    model_limit_state,model_accounts,method_routing,method_subscription,method_api,method_runs RESTART IDENTITY CASCADE`);
  f = await fixture(database.db);
});
// 지금 설치와 그 계정·revision의 두 방식 상태(관리 목록 보기).
const view = () => methodRoutingView(database.db);
after(async () => { await database.pg.close(); });
const MINUTE = 60_000;
async function rows(table: string) { return (await database.db.query<Record<string, any>>(`SELECT * FROM ${table}`)).rows; }
const job = async () => (await rows('jobs'))[0]!;
const scheduler = async () => (await rows('controls')).find(row => row.key === 'scheduler')?.value;
const secondsFromNow = (ms: number) => Math.floor((f.now() + ms) / 1000);
let supported = true;
const router = (enabled = true) => new MethodRouter(f.store, { enabled, supported: (_path: MethodPath) => supported });
const runtimeWith = (methods: MethodRouter) => new Runtime(f.store, f.gate, f.worker, f.signer, f.reader, undefined, { methods });
async function queued(id = 'chat') { await f.ingress.receive(event(id)); f.advance(DEFAULTS.debounceMs); }
async function installed(revision = 'rev-1') {
  await recordAccount(f.store.db, 'main', 'subscription', f.now());
  await recordAccount(f.store.db, 'main', 'api', f.now());
  await f.store.atomic(s => switchAccount(s, 'main', 'subscription', 'cli', 'cli'));
  assert.equal((await f.store.atomic(s => installMethods(s, 'main', revision))).result, 'installed');
}
const selection = (request: WorkerRequest): ExecutionSelection | undefined => request.version === 3 ? request.execution : undefined;
const reply = { reply: '이어서 답했어요.', proposal: null, ack_only: false };
const answered = async (request: WorkerRequest) => ({ status: 'succeeded', stopped: true, rateLimit: null, output: reply,
  ...(request.version === 3 ? { execution: { ...request.execution, subscriptionLimit: false } } : {}) }) as never;
const limitInfo = (resetsAt: number): RateLimitInfo => ({ event: { status: 'rejected', resetsAt, rateLimitType: 'five_hour', utilization: 1 },
  stop: { cause: 'rate_limit', resetsAt } });
// 구독 실행의 한도 실패. evidence: 작업자가 허용 목록으로 판정한 넘어갈 근거(subscriptionLimit).
const limited = (rateLimit: RateLimitInfo | null, evidence = true) => async (request: WorkerRequest) => ({ status: 'limited', stopped: true, rateLimit,
  ...(request.version === 3 ? { execution: { ...request.execution, subscriptionLimit: evidence && request.execution.method === 'subscription' } } : {}) }) as never;
const status = (value: 'auth_expired' | 'failed') => async (request: WorkerRequest) => ({ status: value, stopped: true, rateLimit: null,
  ...(request.version === 3 ? { execution: { ...request.execution, subscriptionLimit: false } } : {}) }) as never;
const billing = { stop: { cause: 'billing' as const } };
beforeEach(() => { supported = true; });

test('AC-32 정책에 한도 뒤 API 사용 스위치 칸이 없으면 꺼짐으로 읽고 기동이 실패하지 않는다', () => {
  const base = { revision: 'r', owner: 'o', guild: 'g', conversationChannel: 'c', notificationChannel: 'n', dmEnabled: null, services: [] };
  const off = loadRuntimePolicy(JSON.stringify(base), 1);
  assert.equal(off.apiAfterLimit, undefined);
  assert.equal(loadRuntimePolicy(JSON.stringify({ ...base, apiAfterLimit: true }), 1).apiAfterLimit, true);
  // 동료 기능 스위치와 따로 움직인다.
  assert.equal(loadRuntimePolicy(JSON.stringify({ ...base, apiAfterLimit: true }), 1).colleagueEnabled, undefined);
  assert.throws(() => loadRuntimePolicy(JSON.stringify({ ...base, apiAfterLimit: 'true' }), 1), /runtime_policies_invalid: apiAfterLimit/);
});

test('AC-38 작업 경로 칸(apiAfterLimitTask)은 따로 있고, 없으면 꺼짐으로 읽으며 참·거짓만 받는다', () => {
  const base = { revision: 'r', owner: 'o', guild: 'g', conversationChannel: 'c', notificationChannel: 'n', dmEnabled: null, services: [] };
  assert.equal(loadRuntimePolicy(JSON.stringify({ ...base, apiAfterLimit: true }), 1).apiAfterLimitTask, undefined);
  const both = loadRuntimePolicy(JSON.stringify({ ...base, apiAfterLimit: true, apiAfterLimitTask: true }), 1);
  assert.deepEqual([both.apiAfterLimit, both.apiAfterLimitTask], [true, true]);
  assert.throws(() => loadRuntimePolicy(JSON.stringify({ ...base, apiAfterLimitTask: 'true' }), 1), /runtime_policies_invalid: apiAfterLimitTask/);
});

test('AC-32 스위치가 꺼져 있으면 두 방식이 설치돼 있어도 새 판 요청이 없고 구독 한도는 지금처럼 기다린다', async () => {
  await installed();
  const runtime = runtimeWith(router(false));
  await queued();
  f.setRun(limited(limitInfo(secondsFromNow(60 * MINUTE))));
  await runtime.tick();
  assert.deepEqual(f.requests.map(request => request.version), [2]);
  assert.equal((await job()).state, 'waiting_user');
  assert.equal(await scheduler(), true);
  assert.deepEqual(await rows('method_runs'), []);
});

test('AC-32 스위치가 켜져 있어도 두 방식 설치가 없거나 작업자 지원이 확인되지 않으면 지금 동작이다', async () => {
  const runtime = runtimeWith(router());
  await queued('no-install');
  await runtime.tick();
  await installed();
  supported = false;
  await queued('unsupported');
  await runtime.tick();
  assert.deepEqual(f.requests.map(request => request.version), [2, 2]);
  assert.deepEqual(await rows('method_runs'), []);
});

test('AC-33 구독 한도 실패 뒤 같은 계정·revision의 API 실행이 정확히 한 번 시작되고 일이 이어지며, 그 뒤 새 실행도 API다', async () => {
  await installed();
  const runtime = runtimeWith(router());
  await queued();
  f.setRun(limited(limitInfo(secondsFromNow(60 * MINUTE))));
  await runtime.tick();
  // 구독 한도가 이 일을 멈추지 않는다: 같은 작업이 대기열로 돌아가고 전역 scheduler도 닫히지 않는다.
  assert.equal((await job()).state, 'queued');
  assert.notEqual(await scheduler(), true);
  // 계정 기록에는 그 구독 실행의 마지막 한도 관측이 남는다.
  assert.deepEqual((await rows('model_limit_state')).map(row => row.status), ['rejected']);
  f.setRun(answered);
  await runtime.tick();
  assert.equal((await job()).state, 'succeeded');
  const [first, second] = f.requests.map(selection);
  assert.equal(f.requests.length, 2);
  assert.deepEqual({ ...first!, runId: '' }, { account: 'main', credentialRevision: 'rev-1', method: 'subscription', runId: '' });
  assert.deepEqual({ ...second!, runId: '' }, { account: 'main', credentialRevision: 'rev-1', method: 'api', runId: '' });
  assert.notEqual(first!.runId, second!.runId);
  assert.equal(f.requests[0]!.job, f.requests[1]!.job);
  await queued('next');
  await runtime.tick();
  assert.equal(selection(f.requests[2]!)!.method, 'api');
});

test('AC-35 경고만 본 한도·인증 실패·과부하에서는 API 실행이 없고 지금 규칙대로 기다리거나 실패한다', async () => {
  await installed();
  const runtime = runtimeWith(router());
  const cases = [['warning', limited({ event: { status: 'allowed_warning', resetsAt: secondsFromNow(MINUTE) } }, false), 'waiting_user'],
    ['unclassified', limited(null, false), 'waiting_user'], ['auth', status('auth_expired'), 'waiting_user'], ['overloaded', status('failed'), 'failed']] as const;
  for (const [id, run, expected] of cases) {
    await queued(id);
    f.setRun(run);
    await runtime.tick();
    assert.equal((await rows('jobs')).find(row => row.state !== 'succeeded')!.state, expected, id);
    // 다음 경우를 따로 보려고 끝난 것으로 치우고 scheduler를 연다.
    await database.pg.exec("UPDATE jobs SET state='succeeded'; UPDATE controls SET value='false' WHERE key='scheduler'");
  }
  assert.deepEqual(f.requests.map(request => selection(request)!.method), ['subscription', 'subscription', 'subscription', 'subscription']);
  assert.equal((await view()).subscription!.state, 'available');
});

test('AC-36 API가 막히면 잠그고 API를 다시 부르지 않으며, 구독은 예약 시각 뒤 한 건으로 확인하고 그 성공이 잠금을 풀지 않는다. 재시작 뒤에도 같다', async () => {
  await installed();
  let runtime = runtimeWith(router());
  await queued();
  const resetsAt = secondsFromNow(60 * MINUTE);
  f.setRun(limited(limitInfo(resetsAt)));
  await runtime.tick();
  f.setRun(limited(billing));
  await runtime.tick();
  // 두 방식이 다 막혔다: 모델 멈춤이고 다시 시도는 구독 풀리는 시각 + 1분이다(결제 멈춤처럼 owner를 기다리지 않는다).
  assert.equal((await job()).state, 'waiting_user');
  assert.equal(await scheduler(), true);
  assert.equal((await view()).api!.state, 'billing_blocked');
  // 재시작: 새 router·runtime도 같은 DB 상태를 읽는다.
  runtime = runtimeWith(router());
  f.advance(resetsAt * 1000 + MINUTE - 1 - f.now());
  assert.equal(await f.store.resumeDue(), 0);
  f.advance(1);
  assert.equal(await f.store.resumeDue(), 1);
  f.setRun(answered);
  await runtime.tick();
  assert.equal((await job()).state, 'succeeded');
  assert.deepEqual(f.requests.map(request => selection(request)!.method), ['subscription', 'api', 'subscription']);
  const returned = await view();
  assert.equal(returned.subscription!.state, 'available');
  assert.equal(returned.api!.state, 'billing_blocked');
  // 다음 구독 한도에서는 API로 넘어가지 않고 지금처럼 기다린다.
  await queued('again');
  f.setRun(limited(limitInfo(secondsFromNow(60 * MINUTE))));
  await runtime.tick();
  assert.deepEqual(f.requests.map(request => selection(request)!.method), ['subscription', 'api', 'subscription', 'subscription']);
  assert.equal((await rows('jobs')).find(row => row.state !== 'succeeded')!.state, 'waiting_user');
});

test('AC-36 API로 도는 동안 구독 확인은 풀리는 시각 + 1분 전에는 없고, 그 뒤 실제 작업 하나로만 일어난다', async () => {
  await installed();
  const runtime = runtimeWith(router());
  await queued('first');
  const resetsAt = secondsFromNow(60 * MINUTE);
  f.setRun(limited(limitInfo(resetsAt)));
  await runtime.tick();
  f.setRun(answered);
  await runtime.tick();
  f.advance(resetsAt * 1000 + MINUTE - 1 - DEFAULTS.debounceMs - f.now());
  await queued('before-reset');
  await runtime.tick();
  // 빈 큐에는 확인 호출이 없다: 시각이 지나도 작업이 오기 전에는 요청이 늘지 않는다.
  f.advance(10 * MINUTE);
  assert.equal(await runtime.tick(), false);
  await queued('probe');
  await runtime.tick();
  await queued('after');
  await runtime.tick();
  assert.deepEqual(f.requests.map(request => selection(request)!.method), ['subscription', 'api', 'api', 'subscription', 'subscription']);
  assert.equal((await view()).subscription!.state, 'available');
});

test('AC-36 구독 확인이 다시 한도면 다음 확인 시각만 바뀌고 그 일은 API로 잇는다', async () => {
  await installed();
  const runtime = runtimeWith(router());
  await queued('first');
  f.setRun(limited(limitInfo(secondsFromNow(60 * MINUTE))));
  await runtime.tick();
  f.setRun(answered);
  await runtime.tick();
  f.advance(61 * MINUTE);
  await queued('probe');
  // 풀리는 시각을 모르는 한도: 다음 확인은 30분 뒤다.
  f.setRun(limited(null));
  await runtime.tick();
  const probed = await view();
  assert.equal(probed.subscription!.state, 'limited');
  assert.equal(probed.subscription!.nextProbeAt, f.now() + 30 * MINUTE);
  f.setRun(answered);
  await runtime.tick();
  assert.deepEqual(f.requests.map(request => selection(request)!.method), ['subscription', 'api', 'subscription', 'api']);
  assert.equal((await rows('jobs')).every(row => row.state === 'succeeded'), true);
});

test('AC-42 작업자가 설치 기록과 다른 묶음으로 실행을 거부하면(not_run) 일을 잃지 않고 지금 동작으로 돌아간다', async () => {
  await installed();
  const runtime = runtimeWith(router());
  await queued();
  f.setRun(async () => ({ status: 'not_run', stopped: true, refusal: 'bundle_mismatch' }) as never);
  await runtime.tick();
  assert.equal((await job()).state, 'queued');
  f.setRun(answered);
  await runtime.tick();
  assert.equal((await job()).state, 'succeeded');
  assert.deepEqual(f.requests.map(request => request.version), [3, 2]);
  assert.deepEqual((await rows('method_routing')).map(row => [row.install_state, row.refused_reason]), [['refused', 'bundle_mismatch']]);
});

const admin = (...argv: string[]) => runAdmin(f.store, parseAdminArgs(['account', ...argv]));
test('AC-40 관리 진입점의 자동 사용 설치는 두 방식이 등록된 지금 계정에만 되고, 지금 표시·모델 대기를 바꾸지 않는다', async () => {
  await admin('record', 'main', 'subscription');
  assert.deepEqual([(await admin('auto-install', 'main', 'rev-1')).report.result], ['unknown_account']);
  await admin('record', 'main', 'api');
  assert.equal((await admin('auto-install', 'main', 'rev-1')).report.result, 'not_current');
  await admin('use', 'main', 'subscription');
  // 모델 한도로 기다리는 일이 있어도 설치는 그 대기를 풀지 않는다(계정 전환과 다른 좁은 동작).
  const runtime = runtimeWith(router(false));
  await queued();
  f.setRun(limited(limitInfo(secondsFromNow(60 * MINUTE))));
  await runtime.tick();
  const installed = await admin('auto-install', 'main', 'rev-1');
  assert.deepEqual([installed.code, installed.report.result], [0, 'auto_installed']);
  assert.equal((await job()).state, 'waiting_user');
  assert.deepEqual((await rows('model_accounts')).filter(row => row.current).map(row => [row.name, row.method]), [['main', 'subscription']]);
  const status = (await admin('auto-status')).report.methods!;
  assert.deepEqual({ ...status, subscription: null, api: null }, { installed: true, account: 'main', revision: 'rev-1', state: 'active', refusal: null, current: true,
    subscription: null, api: null });
  assert.equal(status.api!.state, 'eligible');
  assert.throws(() => parseAdminArgs(['account', 'auto-install', 'main', 'bad revision']));
  assert.equal((await admin('auto-off')).report.result, 'auto_disabled');
  assert.equal((await admin('auto-off')).report.result, 'not_installed');
  assert.equal((await admin('auto-status')).report.methods!.state, 'off');
});

test('AC-36 API 잠금은 관리 진입점의 명시적 해제나 새 묶음 revision 설치로만 풀리고, 같은 revision 재설치로는 풀리지 않는다', async () => {
  await installed();
  const runtime = runtimeWith(router());
  await queued();
  f.setRun(limited(limitInfo(secondsFromNow(60 * MINUTE))));
  await runtime.tick();
  f.setRun(limited(billing));
  await runtime.tick();
  const apiState = async () => (await view()).api!.state;
  assert.equal(await apiState(), 'billing_blocked');
  assert.equal((await admin('auto-install', 'main', 'rev-1')).report.result, 'auto_installed');
  assert.equal(await apiState(), 'billing_blocked');
  assert.equal((await admin('api-unlock')).report.result, 'api_unlocked');
  assert.equal(await apiState(), 'eligible');
  assert.equal((await admin('api-unlock')).report.result, 'not_locked');
  // 다시 잠근 뒤 키 교체(새 revision)로 풀린다. 구독 한도·확인 예약은 같은 계정이라 남는다.
  await database.pg.exec("UPDATE method_api SET state='auth_blocked'");
  assert.equal((await admin('auto-install', 'main', 'rev-2')).report.result, 'auto_installed');
  const replaced = await view();
  assert.deepEqual([replaced.api!.state, replaced.revision, replaced.subscription!.state], ['eligible', 'rev-2', 'limited']);
  assert.deepEqual((await rows('audit')).filter(row => row.kind === 'method_route_api_unlocked').map(row => row.detail.by), ['owner', 'revision']);
});

// ---- C40 재검토 보완 ----
// 실행 중인 대화 작업 행 하나(lease가 살아 있다). 다른 실행 자리의 실행을 라우터로 직접 흉내 낼 때 쓴다.
async function runningJob(id: string) {
  const lease = `lease-${id}`;
  await database.db.query(`INSERT INTO events(id,provider,delivery_id,semantic_key,actor_id,scope,received_at,payload)
    VALUES ($1,'discord',$1,$1,'fixture-owner','{}',0,'{}')`, [`event-${id}`]);
  await database.db.query(`INSERT INTO jobs(id,event_id,type,owner_id,target,revision,budget,state,attempt,priority,available_at,created_at,started_at,lease_token,lease_until)
    VALUES ($1,$2,'chat','fixture-owner','{}','{}','{}','running',1,10,0,$3,$3,$4,$5)`, [id, `event-${id}`, f.now(), lease, f.now() + 600_000]);
  return { id, lease_token: lease, budget: { timeoutMs: 60_000, toolCalls: 10 } } as never;
}
const methodsSent = () => f.requests.map(request => selection(request)?.method ?? null);
const jobById = async (id: string) => (await rows('jobs')).find(row => row.id === id)!;

test('AC-36 API를 고른 뒤 보내기 전에 다른 자리의 결제 실패로 API가 잠기면 그 실행은 API로 나가지 않는다', async () => {
  await installed();
  const methods = router();
  // 고른 뒤 보내기 전(두 번째 인가 확인)에 hook을 한 번 돌린다.
  let hook: (() => Promise<void>) | undefined;
  let calls = 0;
  const gate = { authorize: async (...args: Parameters<typeof f.gate.authorize>) => {
    if (hook && ++calls === 2) { const run = hook; hook = undefined; await run(); }
    return f.gate.authorize(...args);
  } };
  const runtime = new Runtime(f.store, gate as never, f.worker, f.signer, f.reader, undefined, { methods });
  await queued('first');
  f.setRun(limited(limitInfo(secondsFromNow(60 * MINUTE))));
  await runtime.tick();
  const first = (await job()).id;
  hook = async () => {
    const other = await runningJob('other');
    const api = await methods.select(other, 'chat') as ExecutionSelection;
    assert.equal(api.method, 'api');
    assert.equal((await methods.settle(other, api, { status: 'limited', rateLimit: billing })).action, 'wait');
    // 그 자리의 일은 따로 끝난 것으로 둔다(대화 실행 자리를 비운다).
    await database.db.query(`UPDATE jobs SET state='failed' WHERE id='other'`);
  };
  f.setRun(answered);
  await runtime.tick();
  assert.equal(hook, undefined);
  assert.equal((await view()).api!.state, 'billing_blocked');
  // 잠금 뒤 새 API 호출은 0건이다. 그 일은 잃지 않고 다시 고른다(두 방식이 다 막혀 구독 확인 시각까지 기다린다).
  await runtime.tick();
  assert.deepEqual(methodsSent(), ['subscription']);
  assert.deepEqual([(await jobById(first)).state, (await jobById(first)).wait_reason], ['waiting_user', 'model_limit']);
});

test('AC-33 배포 종료가 같은 대화를 되돌려도 한 대화의 API 시작은 지금 재시도 규칙의 3번(maxRetries + 1)이 상한이다', async () => {
  await installed();
  await queued();
  f.setRun(limited(limitInfo(secondsFromNow(60 * MINUTE))));
  await runtimeWith(router()).tick();
  for (let round = 1; round <= 5; round++) {
    if ((await job()).state !== 'queued') break;
    const stop = new AbortController();
    let started!: () => void;
    const running = new Promise<void>(resolve => { started = resolve; });
    f.setRun(async () => { started(); return new Promise<never>(() => {}); });
    const tick = new Runtime(f.store, f.gate, f.worker, f.signer, f.reader, undefined, { methods: router(), shutdown: stop.signal, drainMs: 20 }).tick();
    await running;
    stop.abort();
    await tick;
  }
  assert.equal(DEFAULTS.maxRetries + 1, 3);
  assert.deepEqual(methodsSent(), ['subscription', 'api', 'api', 'api']);
  assert.deepEqual([(await job()).state, (await job()).wait_reason], ['failed', 'stop_confirmation']);
});

test('AC-36 API가 잠긴 동안에도 구독 확인은 예약 시각 전 0건이고, 그 뒤 두 실행 자리가 함께 고르면 확인은 한 건이며 나머지는 기다린다', async () => {
  await installed();
  const methods = new MethodRouter(f.store, { enabled: true, task: true, supported: () => true });
  const a = await runningJob('a');
  const resetsAt = secondsFromNow(60 * MINUTE);
  await methods.settle(a, await methods.select(a, 'chat') as ExecutionSelection, { status: 'limited', subscriptionLimit: true, rateLimit: limitInfo(resetsAt) });
  const b = await runningJob('b');
  assert.equal((await methods.settle(b, await methods.select(b, 'chat') as ExecutionSelection, { status: 'limited', rateLimit: billing })).action, 'wait');
  // 잠금 전에 claim돼 준비 중이던 작업 자리가 예약 시각 전에 고른다: 구독으로 나가지 않고 확인 시각까지 기다린다.
  const early = await methods.select(await runningJob('c'), 'task');
  assert.deepEqual(early, { wait: { stop: { cause: 'rate_limit', resetsAt } } });
  f.advance(resetsAt * 1000 + MINUTE - f.now());
  // 재개 예약이 대화·작업 두 자리를 함께 되돌렸다. 먼저 고른 쪽만 구독 확인이다.
  const chat = await methods.select(await runningJob('d'), 'chat') as ExecutionSelection;
  const task = await methods.select(await runningJob('e'), 'task');
  assert.equal(chat.method, 'subscription');
  assert.ok(task !== null && 'wait' in task);
  assert.deepEqual((await rows('method_runs')).filter(row => row.method === 'subscription' && row.probe).map(row => row.job_id), ['d']);
});

test('AC-36 확인된 API 결제 실패가 취소와 겹쳐도 API를 잠그고, 구독 한도 실패가 취소와 겹치면 넘어가지 않는다', async () => {
  await installed();
  const runtime = runtimeWith(router());
  await queued('cancelled-sub');
  const cancelled = (run: (request: WorkerRequest) => Promise<never>) => async (request: WorkerRequest) => {
    await database.db.query(`UPDATE jobs SET state='cancel_requested' WHERE state='running'`);
    return run(request);
  };
  f.setRun(cancelled(limited(limitInfo(secondsFromNow(60 * MINUTE)))));
  await runtime.tick();
  assert.equal((await view()).subscription!.state, 'available');
  await queued('limited');
  f.setRun(limited(limitInfo(secondsFromNow(60 * MINUTE))));
  await runtime.tick();
  f.setRun(cancelled(limited(billing)));
  await runtime.tick();
  assert.deepEqual((await rows('jobs')).map(row => row.state).sort(), ['cancelled', 'cancelled']);
  assert.deepEqual(methodsSent(), ['subscription', 'subscription', 'api']);
  assert.equal((await view()).api!.state, 'billing_blocked');
});

test('AC-37 같은 계정에 새 revision을 설치한 뒤 옛 revision 실행의 한도 경고는 리뷰 미루기를 바꾸지 않고, 지금 revision의 경고는 바꾼다', async () => {
  await installed();
  const runtime = runtimeWith(router());
  const warnedAt = secondsFromNow(5 * 60 * MINUTE);
  const warned = (install?: string) => async (request: WorkerRequest) => {
    if (install) await f.store.atomic(s => installMethods(s, 'main', install));
    return { ...(await answered(request) as object), rateLimit: { event: { status: 'allowed_warning', resetsAt: warnedAt } } } as never;
  };
  await queued('old');
  f.setRun(warned('rev-2'));
  await runtime.tick();
  assert.equal((await job()).state, 'succeeded');
  assert.equal(await f.store.reviewDeferredUntil(), null);
  await queued('current');
  f.setRun(warned());
  await runtime.tick();
  assert.equal(await f.store.reviewDeferredUntil(), warnedAt * 1000);
});

test('AC-36 계정 A의 API 잠금·구독 확인 예약은 B를 설치한 뒤 A의 같은 revision을 다시 설치해도 남고, A는 API를 다시 부르지 않는다', async () => {
  await installed();
  const runtime = runtimeWith(router());
  await queued();
  f.setRun(limited(limitInfo(secondsFromNow(60 * MINUTE))));
  await runtime.tick();
  f.setRun(limited(billing));
  await runtime.tick();
  const before = await view();
  assert.equal(before.api!.state, 'billing_blocked');
  await recordAccount(f.store.db, 'other', 'subscription', f.now());
  await recordAccount(f.store.db, 'other', 'api', f.now());
  await f.store.atomic(s => switchAccount(s, 'other', 'subscription', 'cli', 'cli'));
  assert.equal((await f.store.atomic(s => installMethods(s, 'other', 'rev-b'))).result, 'installed');
  await f.store.atomic(s => switchAccount(s, 'main', 'subscription', 'cli', 'cli'));
  assert.equal((await f.store.atomic(s => installMethods(s, 'main', 'rev-1'))).result, 'installed');
  const after = await view();
  assert.deepEqual([after.account, after.api, after.subscription], ['main', before.api, before.subscription]);
  // 계정 전환이 멈춘 일을 되돌렸다. 구독 확인 시각 전이라 API로도 구독으로도 나가지 않는다.
  f.setRun(answered);
  await runtime.tick();
  assert.deepEqual(methodsSent(), ['subscription', 'api']);
});

for (const gap of [0, 1]) {
  test(`AC-37 owner가 account use로 다른 계정으로 바꾼 뒤(${gap ? '1ms 뒤' : '같은 밀리초'}) 옛 계정의 늦은 API 실패는 새 계정의 scheduler·대기를 바꾸지 않는다`, async () => {
    await installed();
    await recordAccount(f.store.db, 'other', 'subscription', f.now());
    const runtime = runtimeWith(router());
    await queued();
    f.setRun(limited(limitInfo(secondsFromNow(60 * MINUTE))));
    await runtime.tick();
    f.setRun(async request => {
      f.advance(gap);
      await f.store.atomic(s => switchAccount(s, 'other', 'subscription', 'cli', 'cli'));
      return limited(billing)(request);
    });
    await runtime.tick();
    assert.notEqual(await scheduler(), true);
    assert.deepEqual(await rows('model_pauses'), []);
    assert.equal((await job()).state, 'queued');
    // 새 계정에는 자동 사용 설치가 없어 지금 동작(옛 판 요청)으로 잇는다.
    f.setRun(answered);
    await runtime.tick();
    assert.equal((await job()).state, 'succeeded');
    assert.equal(f.requests.at(-1)!.version, 2);
  });
}

test('AC-36 account use B 뒤 도착한 계정 A의 API 결제 실패도 A의 그 revision에 잠금으로 남아, A의 같은 revision을 다시 설치해도 API를 다시 부르지 않는다', async () => {
  await installed();
  await recordAccount(f.store.db, 'other', 'subscription', f.now());
  const runtime = runtimeWith(router());
  await queued();
  f.setRun(limited(limitInfo(secondsFromNow(60 * MINUTE))));
  await runtime.tick();
  f.setRun(async request => {
    await f.store.atomic(s => switchAccount(s, 'other', 'subscription', 'cli', 'cli'));
    return limited(billing)(request);
  });
  await runtime.tick();
  // B(지금 계정)는 멈추지 않는다.
  assert.notEqual(await scheduler(), true);
  assert.deepEqual(await rows('model_pauses'), []);
  assert.deepEqual((await rows('method_api')).map(row => [row.account, row.revision, row.state]), [['main', 'rev-1', 'billing_blocked']]);
  assert.equal((await rows('audit')).filter(row => row.kind === 'method_route_api_locked').length, 1);
  f.setRun(answered);
  await runtime.tick();
  assert.equal((await job()).state, 'succeeded');
  // 구독 확인 시각 전에 owner가 A로 돌아와 같은 묶음을 다시 설치한다. 잠금은 owner 해제나 새 revision으로만 풀린다.
  await f.store.atomic(s => switchAccount(s, 'main', 'subscription', 'cli', 'cli'));
  assert.equal((await f.store.atomic(s => installMethods(s, 'main', 'rev-1'))).result, 'installed');
  assert.equal((await view()).api!.state, 'billing_blocked');
  await queued('again');
  const sent = f.requests.length;
  await runtime.tick();
  assert.equal(f.requests.length, sent);
  assert.deepEqual(methodsSent(), ['subscription', 'api', null]);
});
