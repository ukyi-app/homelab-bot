import { after, before, beforeEach, test } from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync } from 'node:crypto';
import { DEFAULTS } from '../src/contracts.js';
import type { PublisherConfig } from '../src/config.js';
import type { DiscordApi } from '../src/discord-protocol.js';
import { startPublisher } from '../src/main.js';
import { loadRuntimePolicy } from '../src/policy.js';
import { Runtime } from '../src/runtime.js';
import { Store } from '../src/store.js';
import type { WorkerResult } from '../src/worker.js';
import { FakeGateway } from './fake-gateway.js';
import { localDatabase, fixture, event } from './helpers.js';

// impl-sched S2: 게시 서버 정상 종료(SIGTERM). 종료 신호를 받으면 dispatch 전 작업은 되돌리고, 실행 중 작업은 드레인 창 안의
// 자연 완료를 기다린 뒤 작업자가 아직 잡고 있을 때 취소·확인한다. 확인된 chat은 다시 대기열로, task는 확정 실패, 확인 실패는 unknown.
let database: Awaited<ReturnType<typeof localDatabase>>;
let f: Awaited<ReturnType<typeof fixture>>;
before(async () => { database = await localDatabase(); });
beforeEach(async () => {
  await database.pg.exec('TRUNCATE events,conversations,jobs,results,outbox,schedules,denied_actors,controls,audit,incidents RESTART IDENTITY CASCADE');
  f = await fixture(database.db);
});
after(async () => { await database.pg.close(); });
async function rows(table: string) { return (await database.db.query<Record<string, any>>(`SELECT * FROM ${table}`)).rows; }
const answer = { facts: ['완료'], hypotheses: [], unknowns: [], checks: [] };
async function queued(id = 'chat', options = {}) { await f.ingress.receive(event(id, options)); f.advance(DEFAULTS.debounceMs); }
function runtime(shutdown: AbortController, drainMs = 50) {
  return new Runtime(f.store, f.gate, f.worker, f.signer, f.reader, undefined, { shutdown: shutdown.signal, drainMs });
}
// 작업자 실행이 시작되면 알린다. hold가 풀리기 전에는 끝나지 않는다.
function holding(result: WorkerResult = { status: 'succeeded', stopped: true, answer }) {
  let started!: () => void; let release!: () => void;
  const running = new Promise<void>(resolve => { started = resolve; });
  const held = new Promise<void>(resolve => { release = resolve; });
  f.setRun(async () => { started(); await held; return result; });
  return { running, release: () => release() };
}
const audits = async () => (await rows('audit')).filter(a => a.kind === 'publisher_shutdown').map(a => a.detail.outcome);

test('S2 드레인 창 안에 끝난 실행은 정상 완료', async () => {
  await queued();
  const stop = new AbortController(); const worker = holding();
  const tick = runtime(stop, 1000).tick(); await worker.running;
  stop.abort(); setTimeout(() => worker.release(), 30);
  await tick;
  const job = (await rows('jobs'))[0]!;
  assert.equal(job.state, 'succeeded'); assert.equal(f.requests.length, 1);
});

test('S2 드레인 초과 → 취소 확인 → chat은 attempt 유지한 채 queued, 새 게시 서버가 다시 실행', async () => {
  await queued();
  const stop = new AbortController(); const worker = holding();
  let cancels = 0; const cancel = f.worker.cancel.bind(f.worker);
  f.worker.cancel = async (request, capability) => { cancels++; return cancel(request, capability); };
  const tick = runtime(stop).tick(); await worker.running;
  stop.abort(); await tick;
  let job = (await rows('jobs'))[0]!;
  assert.equal(cancels, 1);
  assert.equal(job.state, 'queued'); assert.equal(job.attempt, 1); assert.equal(job.wait_reason, 'publisher_shutdown');
  assert.equal(job.lease_token, null); assert.equal(Number(job.available_at), f.now());
  assert.deepEqual(await audits(), ['requeued']);
  assert.equal((await rows('outbox')).filter(o => o.job_id === job.id).length, 0);
  // 새 게시 서버(새 Store/Runtime)가 되돌린 작업을 잡아 끝낸다.
  f.setRun(async () => ({ status: 'succeeded', stopped: true, answer }));
  const next = new Runtime(new Store(database.db, f.now), f.gate, f.worker, f.signer, f.reader);
  assert.equal(await next.tick(), true);
  job = (await rows('jobs'))[0]!;
  assert.equal(job.state, 'succeeded'); assert.equal(job.attempt, 2); assert.equal(f.requests.length, 2);
});

test('S2 재시도 한도에 닿은 chat은 되돌리지 않고 확정 실패', async () => {
  await queued();
  await database.db.query('UPDATE jobs SET attempt=$1', [DEFAULTS.maxRetries]);
  const stop = new AbortController(); const worker = holding();
  const tick = runtime(stop).tick(); await worker.running;
  stop.abort(); await tick;
  const job = (await rows('jobs'))[0]!;
  assert.equal(job.state, 'failed'); assert.equal(job.attempt, DEFAULTS.maxRetries + 1);
  assert.deepEqual(await audits(), ['failed']);
});

test('S2 드레인 초과 → 취소 확인 → task는 확정 실패(자동 재실행 없음)', async () => {
  await queued('task', { kind: 'command', command: 'task' });
  const stop = new AbortController(); const worker = holding();
  const tick = runtime(stop).tick(); await worker.running;
  stop.abort(); await tick;
  const job = (await rows('jobs'))[0]!;
  assert.equal(job.type, 'task'); assert.equal(job.state, 'failed'); assert.equal(job.wait_reason, 'stop_confirmation');
  assert.ok((await rows('outbox')).some(o => o.idempotency_key === `failure:${job.id}:1`));
});

test('S2 종료 중 확인 실패는 unknown(publisher_shutdown)', async () => {
  await queued();
  f.worker.cancel = async () => ({ stopped: false });
  const stop = new AbortController(); const worker = holding();
  const tick = runtime(stop).tick(); await worker.running;
  stop.abort(); await tick;
  const job = (await rows('jobs'))[0]!;
  assert.equal(job.state, 'unknown'); assert.equal(job.wait_reason, 'publisher_shutdown');
  assert.deepEqual(await audits(), ['unknown']);
});

test('S2 드레인 중 owner가 /cancel했으면 확인 뒤 cancelled', async () => {
  await queued();
  const stop = new AbortController(); const worker = holding();
  const tick = runtime(stop, 200).tick(); await worker.running;
  const job = (await rows('jobs'))[0]!;
  stop.abort();
  await f.store.control(f.policy.owner, job.conversation_id, 'cancel', job.id);
  await tick;
  assert.equal((await rows('jobs'))[0]!.state, 'cancelled');
});

test('S2 claim 뒤 dispatch 전에 종료 신호가 오면 attempt를 쓰지 않고 되돌림', async () => {
  await queued();
  const stop = new AbortController();
  const store = new Store(database.db, f.now);
  const claim = store.claim.bind(store);
  store.claim = async () => { const job = await claim(); stop.abort(); return job; };
  await new Runtime(store, f.gate, f.worker, f.signer, f.reader, undefined, { shutdown: stop.signal }).tick();
  const job = (await rows('jobs'))[0]!;
  assert.equal(job.state, 'queued'); assert.equal(job.attempt, 0); assert.equal(job.wait_reason, 'publisher_shutdown');
  assert.equal(f.requests.length, 0);
  assert.deepEqual(await audits(), ['deferred']);
});

test('S2 종료 신호 뒤에는 새 작업을 claim하지 않음', async () => {
  await queued();
  const stop = new AbortController(); stop.abort();
  assert.equal(await runtime(stop).tick(), false);
  assert.equal((await rows('jobs'))[0]!.state, 'queued');
});

// 진입점 수준: stop()은 전체 기한 하나 안에서 끝난다. 작업자 실행이 끝나지 않고 cancel 응답도 늦어도(최악) 기한을 넘지 않는다.
class QuietRest implements DiscordApi {
  async request(method: 'GET' | 'POST' | 'PUT', path: string, body?: unknown): Promise<unknown> {
    if (method === 'PUT') return body;
    if (/\/threads\/(active|archived\/public)/.test(path)) return { threads: [] };
    if (method === 'GET' && /^\/channels\/[^/?]+$/.test(path)) return { id: 'fixture-thread', type: 11, guild_id: 'fixture-guild', parent_id: 'fixture-chat' };
    if (method === 'POST') return { id: 'fixture-message' };
    return [];
  }
}
for (const scenario of ['cancel_confirmed', 'cancel_hangs'] as const) test(`S2 진입점 stop()은 전체 기한 안에 끝남(${scenario})`, async () => {
  await queued();
  const gw = new FakeGateway(); gw.options.identifyIntervalMs = 250; await gw.start();
  let executed!: () => void; const execution = new Promise<void>(resolve => { executed = resolve; });
  let cancelSettled: Promise<void> = Promise.resolve();
  const send: typeof fetch = async (input, init) => {
    const url = String(input);
    if (url.endsWith('/v1/execute')) {
      executed();
      return new Promise<Response>((_, reject) => init?.signal?.addEventListener('abort', () => reject(new Error('aborted')), { once: true }));
    }
    if (url.endsWith('/v1/cancel')) {
      if (scenario === 'cancel_confirmed') return new Response(JSON.stringify({ stopped: true }), { status: 200 });
      // 응답하지 않는다. HttpWorker의 5초 제한까지 매달린다.
      const hanging = new Promise<Response>((_, reject) => init?.signal?.addEventListener('abort', () => reject(new Error('cancel_timeout')), { once: true }));
      cancelSettled = hanging.then(() => {}, () => {});
      return hanging;
    }
    return new Response('OK', { status: 200 });
  };
  const config: PublisherConfig = {
    databaseUrl: 'postgresql://unused', discordToken: 'fixture-discord-token',
    policy: loadRuntimePolicy(JSON.stringify({ revision: 'fixture-v1', owner: 'fixture-owner', guild: 'fixture-guild', conversationChannel: 'fixture-chat',
      notificationChannel: 'fixture-notifications', dmEnabled: false, services: [] }), Date.now()),
    grafana: { url: 'http://127.0.0.1:9', token: 'fixture-grafana-token' }, kubernetes: { url: 'http://127.0.0.1:9' },
    workerUrl: 'http://127.0.0.1:9/', healthchecksUrl: 'http://127.0.0.1:9/ping',
    workerKey: generateKeyPairSync('ed25519').privateKey, githubWebhookSecret: 'fixture-webhook-secret-value',
  };
  const stopTimeoutMs = 1500;
  const publisher = await startPublisher(config, { db: database.db, now: f.now, send, discord: new QuietRest(), gatewayUrl: async () => ({ url: gw.url }),
    allowGatewayUrl: url => url.hostname === '127.0.0.1', serviceAccount: { tokenFile: '/nonexistent', caFile: null },
    ports: { app: 0, alerts: 0 }, idleMs: 20, identifySpacingMs: 250, registerDelaysMs: [0], heartbeatEveryMs: 60_000,
    stopTimeoutMs, drainMs: 300, log: () => {} });
  try {
    await execution;
    const started = Date.now();
    await publisher.stop();
    const elapsed = Date.now() - started;
    assert.ok(elapsed < stopTimeoutMs + 500, `stop()이 ${elapsed}ms 걸림`);
    const job = (await rows('jobs'))[0]!;
    if (scenario === 'cancel_confirmed') {
      assert.equal(job.state, 'queued'); assert.equal(job.wait_reason, 'publisher_shutdown');
    } else assert.equal(job.state, 'running', '기한 안에 확인하지 못하면 lease 만료가 unknown으로 남긴다');
  } finally {
    await cancelSettled;
    await gw.close();
  }
});
