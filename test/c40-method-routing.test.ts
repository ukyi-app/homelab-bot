import { after, before, beforeEach, test } from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULTS } from '../src/contracts.js';
import type { RateLimitInfo } from '../src/contracts.js';
import type { ExecutionSelection } from '../src/execution-auth.js';
import { MethodRouter, installMethods } from '../src/method-routing.js';
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
    model_limit_state,model_accounts,method_routing,method_runs RESTART IDENTITY CASCADE`);
  f = await fixture(database.db);
});
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
  assert.deepEqual((await rows('method_routing')).map(row => row.subscription_state), ['available']);
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
  assert.deepEqual((await rows('method_routing')).map(row => row.api_state), ['billing_blocked']);
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
  const [state] = await rows('method_routing');
  assert.equal(state!.subscription_state, 'available');
  assert.equal(state!.api_state, 'billing_blocked');
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
  assert.equal((await rows('method_routing'))[0]!.subscription_state, 'available');
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
  const [state] = await rows('method_routing');
  assert.equal(state!.subscription_state, 'limited');
  assert.equal(Number(state!.subscription_next_probe_at), f.now() + 30 * MINUTE);
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
