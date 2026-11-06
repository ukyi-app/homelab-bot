import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile, readdir, realpath, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { sha256Hex } from '../src/change-contracts.js';
import { VERIFIER_REVISION, WorkerChangeVerification } from '../src/change-verifier.js';
import type { ChangeVerificationWorker, SandboxRun, SandboxRunner } from '../src/change-verifier.js';
import { TaskWorkerBusy } from '../src/task-bridge.js';
import { changeWorkerFixture, identity, settledResult } from './change-worker-harness.js';
import { SHA } from './task-fixtures.js';
import { COMPLETED } from './task-worker-harness.js';

// 첫 실행의 실패가 재실행의 통과로 가려지면 안 된다. 시작 기록이 있는데 receipt가 없으면 다시 돌리지 않는다.
const shFile = '/bin/sh';
const registry = async () => ({ unit: { argv: [shFile, '-c', 'true'], cwd: '.', timeoutMs: 30_000, outputBytes: 1024 * 1024, scratchBytes: 1024 * 1024, env: {},
  toolchain: { path: shFile, sha256: sha256Hex(await readFile(await realpath(shFile))) } } });
const pass = (): SandboxRun => ({ started: true, exitCode: 0, timedOut: false, overflow: false, aborted: false, log: Buffer.from('ok\n'), logBytes: 3, logDigest: 'a'.repeat(64) });

async function verifying(sandbox: SandboxRunner) {
  const f = await changeWorkerFixture({ verifier: { registry: await registry(), sandbox } });
  await f.script([{ ...COMPLETED, write: { 'src/app.txt': 'two\n' } }]);
  const request = f.start();
  await f.signed('/v2/task', request);
  const result = await settledResult(f, request);
  assert.equal(result.status, 'snapshot');
  const bundle = { repoId: 4242, generation: 1, baseCommit: SHA, baseTree: result.artifact.manifest.baseTree, resultTree: result.artifact.manifest.resultTree, artifactDigest: result.artifactDigest, policyRevision: request.policyRevision, verifierRevision: VERIFIER_REVISION };
  return { f, request, result, bundle, body: { ...identity(request), expectedWorker: result.worker, commandId: 'unit', bundle } };
}

test('7-1 시작 기록: 프로세스를 띄우기 전에 볼륨에 command별 시작을 남긴다', async () => {
  let seen: string[] = [];
  let probe: (() => Promise<string[]>) | undefined;
  const s = await verifying(async () => { seen = await probe!(); return pass(); });
  probe = async () => readdir(join(s.f.root, '.homelab-worker', 'change-results'));
  try {
    assert.equal((await s.f.signed('/v2/task/verify', s.body)).status, 200);
    for (let attempt = 0; attempt < 400 && !seen.length; attempt++) await new Promise(resolve => setTimeout(resolve, 5));
    assert.ok(seen.some(name => name.includes('.verification.unit.started')), `시험 프로세스가 돌 때 시작 기록이 있어야 한다: ${seen.join(',')}`);
  } finally { await s.f.close(); }
});

test('7-1 재시작: 시작 기록만 있고 receipt가 없으면 다시 돌리지 않고 absent로 답한다. port는 unknown으로 닫는다', async () => {
  let ran = 0;
  const s = await verifying((_args, _limits, signal) => { ran++; return new Promise<SandboxRun>(resolve => { signal.addEventListener('abort', () => resolve({ ...pass(), aborted: true, exitCode: null })); }); });
  try {
    assert.equal((await s.f.signed('/v2/task/verify', s.body)).json.status, 'running');
    for (let attempt = 0; attempt < 400 && !ran; attempt++) await new Promise(resolve => setTimeout(resolve, 5));
    assert.equal(ran, 1);
    // 시험 중 죽어 receipt 없이 다시 뜬 작업자다. 정상 종료가 쓴 receipt를 지워 "죽어서 못 쓴" 상태를 만든다. 시작 기록은 남긴다.
    const results = join(s.f.root, '.homelab-worker', 'change-results');
    const before = await readdir(results);
    await s.f.restart(async () => {
      for (const name of await readdir(results)) if (name.includes('.verification.unit.json')) await rm(join(results, name));
    });
    assert.ok(before.some(name => name.includes('.verification.unit.started')));
    const body = { ...s.body, expectedWorker: null };
    const worker = (await s.f.signed('/v2/task/result', { ...identity(s.request), expectedWorker: null })).json.worker;
    const reply = await s.f.signed('/v2/task/verify', { ...body, expectedWorker: worker });
    assert.equal(reply.status, 200);
    assert.equal(reply.json.status, 'absent', '다시 돌리지 않는다');
    assert.equal(ran, 1, '재실행 0회');
    assert.equal((await s.f.signed('/v2/task/verification', { ...identity(s.request), expectedWorker: null, commandId: 'unit' })).json.status, 'absent');
    // 게시 서버 port 쪽 결말은 unknown이다.
    const port = new WorkerChangeVerification({ imageRevision: 'fixture', sleep: async () => {},
      control: async () => ({ job: s.request.job, lease: s.request.lease, generation: 1, sessionId: s.request.sessionId, worker }),
      worker: { verify: async (control, commandId, bundle) => (await s.f.signed('/v2/task/verify', { ...identity(s.request), expectedWorker: control.worker, commandId, bundle })).json, verification: async () => { throw new Error('not_used'); } } as ChangeVerificationWorker });
    assert.equal((await port.run({ key: { changeId: 'a'.repeat(32), generation: 1 }, bundle: s.bundle, commandId: 'unit' })).status, 'unknown');
    assert.equal(ran, 1);
  } finally { await s.f.close(); }
});

test('슬롯 경합: 다른 시험이 도는 중의 시작 요청은 HTTP로 busy라고 답하고 port는 receipt를 만들지 않는다', async () => {
  let ran = 0;
  const s = await verifying((_args, _limits, signal) => { ran++; return new Promise<SandboxRun>(resolve => { signal.addEventListener('abort', () => resolve({ ...pass(), aborted: true, exitCode: null })); }); });
  try {
    assert.equal((await s.f.signed('/v2/task/verify', s.body)).json.status, 'running');
    for (let attempt = 0; attempt < 400 && !ran; attempt++) await new Promise(resolve => setTimeout(resolve, 5));
    const other = { ...s.body, commandId: 'other-command' };
    const raw = await s.f.signed('/v2/task/verify', other);
    assert.deepEqual([raw.status, raw.json], [409, { status: 'busy', started: false }]);
    await assert.rejects(s.f.port.callV2('/v2/task/verify', other), TaskWorkerBusy);
    const port = new WorkerChangeVerification({ imageRevision: 'fixture', sleep: async () => {},
      control: async () => ({ job: s.request.job, lease: s.request.lease, generation: 1, sessionId: s.request.sessionId, worker: s.result.worker }),
      worker: { verify: async (control, commandId, bundle) => (await s.f.port.callV2('/v2/task/verify', { ...identity(s.request), expectedWorker: control.worker, commandId, bundle })).response as never, verification: async () => { throw new Error('not_used'); } } as ChangeVerificationWorker });
    await assert.rejects(port.run({ key: { changeId: 'a'.repeat(32), generation: 1 }, bundle: s.bundle, commandId: 'other-command' }), TaskWorkerBusy);
  } finally { await s.f.close(); }
});

// 두 호출이 모두 여기까지 온 뒤에야 함께 진행한다. 비동기 조회 사이에 끼어드는 순서를 시간에 맡기지 않고 고정한다.
function barrier<T>(results: any, method: string, parties: number): void {
  const original = (results[method] as (...args: unknown[]) => Promise<T>).bind(results);
  let waiting = 0;
  let open!: () => void;
  const opened = new Promise<void>(resolve => { open = resolve; });
  results[method] = async (...args: unknown[]) => {
    const value = await original(...args);
    if (++waiting >= parties) open();
    await opened;
    return value;
  };
}
// 시험 준비가 샌드박스 호출보다 오래 걸릴 수 있어 이미 취소된 신호도 받는다. 그러지 않으면 정리가 영원히 기다린다.
const holding = (counter: { ran: number }): SandboxRunner => (_args, _limits, signal) => {
  counter.ran++;
  const stopped = () => ({ ...pass(), aborted: true, exitCode: null });
  if (signal.aborted) return Promise.resolve(stopped());
  return new Promise<SandboxRun>(resolve => { signal.addEventListener('abort', () => resolve(stopped())); });
};
const serviceOf = (s: Awaited<ReturnType<typeof verifying>>) => s.f.service as any;
// 샌드박스까지 간 뒤에 잰다. 고정 대기는 느린 환경에서 "아직 안 돌았음"과 "1회 돌았음"을 가르지 못한다.
const ranOnce = async (counter: { ran: number }) => {
  for (let attempt = 0; attempt < 6000 && !counter.ran; attempt++) await new Promise(resolve => setTimeout(resolve, 5));
  await settle();
  assert.equal(counter.ran, 1, '샌드박스 실행은 1회');
};
const settle = () => new Promise(resolve => setTimeout(resolve, 60));

test('동시 시작: 같은 command 요청 둘이 함께 와도 시험은 1회이고 둘 다 running이다', async () => {
  const counter = { ran: 0 };
  const s = await verifying(holding(counter));
  try {
    barrier(serviceOf(s).results, 'verificationStarted', 2);
    const first = s.f.signed('/v2/task/verify', s.body);
    // 같은 본문을 같은 밀리초에 서명하면 토큰까지 같아 재사용으로 거부된다. 유효한 요청 둘을 만들려고 발급 시각을 띄운다.
    await new Promise(resolve => setTimeout(resolve, 3));
    const replies = await Promise.all([first, s.f.signed('/v2/task/verify', s.body)]);
    assert.deepEqual(replies.map(reply => [reply.status, reply.json.status]), [[200, 'running'], [200, 'running']]);
    await ranOnce(counter);
  } finally { await s.f.close(); }
});
test('동시 시작: 다른 command 요청 둘이면 하나만 돌고 다른 하나는 busy다', async () => {
  const counter = { ran: 0 };
  const s = await verifying(holding(counter));
  try {
    barrier(serviceOf(s).results, 'verificationStarted', 2);
    const replies = await Promise.all([s.f.signed('/v2/task/verify', s.body), s.f.signed('/v2/task/verify', { ...s.body, commandId: 'other-command' })]);
    assert.deepEqual(replies.map(reply => reply.status).sort(), [200, 409]);
    await ranOnce(counter);
  } finally { await s.f.close(); }
});
test('동시 시작: 조회 사이에 끝난 줄 모르고 슬롯까지 와도 시작 기록의 배타 생성이 다시 돌리지 않는다', async () => {
  const counter = { ran: 0 };
  const s = await verifying(async () => { counter.ran++; return pass(); });
  try {
    const results = serviceOf(s).results;
    assert.equal(await results.writeVerificationStart(s.request.job, 1, 'unit'), true);
    assert.equal(await results.writeVerificationStart(s.request.job, 1, 'unit'), false, '이미 있으면 만들지 않는다');
    // 시작 기록을 읽을 때는 없었고 슬롯을 잡을 때는 있는 순서다.
    results.verificationStarted = async () => false;
    const reply = await s.f.signed('/v2/task/verify', s.body);
    assert.deepEqual([reply.status, reply.json.status], [200, 'absent']);
    await settle();
    assert.equal(counter.ran, 0);
    assert.equal(serviceOf(s).turn, undefined, '슬롯을 놓는다');
  } finally { await s.f.close(); }
});
test('동시 시작: 시작 기록을 읽는 사이 종료가 시작되면 슬롯을 잡지 않는다', async () => {
  const counter = { ran: 0 };
  const s = await verifying(holding(counter));
  try {
    const service = serviceOf(s);
    const original = service.results.verificationStarted.bind(service.results);
    service.results.verificationStarted = async (...args: unknown[]) => { const value = await original(...args); service.options = { ...service.options, accepting: () => false }; return value; };
    const reply = await s.f.signed('/v2/task/verify', s.body);
    assert.equal(reply.status, 403);
    await settle();
    assert.equal(counter.ran, 0);
  } finally { await s.f.close(); }
});
test('경합: 시작 요청이 시작 기록을 읽는 사이 시험이 끝나도 absent가 아니라 done으로 답한다', async () => {
  let finishRun!: () => void;
  const hold = new Promise<void>(resolve => { finishRun = resolve; });
  const s = await verifying(async () => { await hold; return pass(); });
  try {
    assert.equal((await s.f.signed('/v2/task/verify', s.body)).json.status, 'running');
    const service = serviceOf(s);
    const started = service.results.verificationStarted.bind(service.results);
    service.results.verificationStarted = async (...args: unknown[]) => {
      finishRun();
      for (let attempt = 0; attempt < 6000 && service.turn; attempt++) await new Promise(resolve => setTimeout(resolve, 5));
      return started(...args);
    };
    assert.equal((await s.f.signed('/v2/task/verify', s.body)).json.status, 'done');
  } finally { await s.f.close(); }
});
test('경합: 슬롯까지 와서 시작 기록이 이미 있으면 그 사이 쓰인 receipt로 답한다', async () => {
  const counter = { ran: 0 };
  const s = await verifying(async () => { counter.ran++; return pass(); });
  try {
    const service = serviceOf(s);
    assert.equal((await s.f.signed('/v2/task/verify', s.body)).json.status, 'running');
    for (let attempt = 0; attempt < 6000 && service.turn; attempt++) await new Promise(resolve => setTimeout(resolve, 5));
    // 앞선 두 조회가 끝나기 전의 값을 본 요청이다. 슬롯에 도착했을 때는 시작 기록과 receipt가 모두 있다.
    const read = service.results.readVerification.bind(service.results);
    let stale = true;
    service.results.readVerification = async (...args: unknown[]) => { if (stale) { stale = false; return null; } return read(...args); };
    service.results.verificationStarted = async () => false;
    assert.equal((await s.f.signed('/v2/task/verify', s.body)).json.status, 'done');
    assert.equal(counter.ran, 1);
  } finally { await s.f.close(); }
});
test('동시 시작: 턴 시작의 서명을 확인하는 사이 종료가 시작되면 슬롯을 잡지 않는다', async () => {
  const f = await changeWorkerFixture();
  try {
    const service = f.service as any;
    const verify = service.verify.bind(service);
    service.verify = async (...args: unknown[]) => { await verify(...args); service.options = { ...service.options, accepting: () => false }; };
    assert.equal((await f.signed('/v2/task', f.start())).status, 403);
    assert.equal(service.turn, undefined);
    assert.equal((await f.calls()).length, 0);
  } finally { await f.close(); }
});
test('경합: receipt를 읽은 뒤 시험이 끝나도 재조회가 absent로 답하지 않는다. 다음 조회가 done을 받는다', async () => {
  let finishRun!: () => void;
  const hold = new Promise<void>(resolve => { finishRun = resolve; });
  const s = await verifying(async () => { await hold; return pass(); });
  try {
    assert.equal((await s.f.signed('/v2/task/verify', s.body)).json.status, 'running');
    const service = serviceOf(s);
    const original = service.results.readVerification.bind(service.results);
    let staged = false;
    service.results.readVerification = async (...args: unknown[]) => {
      const value = await original(...args);
      if (!staged) {
        staged = true;
        finishRun();
        for (let attempt = 0; attempt < 6000 && service.turn; attempt++) await new Promise(resolve => setTimeout(resolve, 5));
      }
      return value;
    };
    const reply = await s.f.signed('/v2/task/verification', { ...identity(s.request), expectedWorker: null, commandId: 'unit' });
    assert.notEqual(reply.json.status, 'absent', '끝난 시험을 시작만 기록된 것으로 답하면 port가 unknown으로 닫는다');
    assert.equal((await s.f.signed('/v2/task/verification', { ...identity(s.request), expectedWorker: null, commandId: 'unit' })).json.status, 'done');
  } finally { await s.f.close(); }
});
test('경합: 정리가 결과를 읽는 사이 시험이 슬롯을 잡으면 세션을 지우지 않고 파드 정리도 하지 않는다', async () => {
  const counter = { ran: 0 };
  const s = await verifying(holding(counter));
  try {
    const service = serviceOf(s);
    const original = service.results.readResult.bind(service.results);
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    let reached!: () => void;
    const entered = new Promise<void>(resolve => { reached = resolve; });
    let first = true;
    service.results.readResult = async (...args: unknown[]) => {
      const value = await original(...args);
      if (first) { first = false; reached(); await gate; }
      return value;
    };
    const finalize = s.f.signed('/v2/task/finalize', { ...identity(s.request), expectedWorker: s.result.worker, receipt: { outcome: 'saved', artifactDigest: s.result.artifactDigest, persistedAt: 1 } });
    await entered;
    assert.equal((await s.f.signed('/v2/task/verify', s.body)).json.status, 'running');
    for (let attempt = 0; attempt < 6000 && !counter.ran; attempt++) await new Promise(resolve => setTimeout(resolve, 5));
    assert.equal(counter.ran, 1);
    const swept = s.f.cleanup.terminated;
    release();
    const reply = await finalize;
    assert.deepEqual([reply.status, reply.json.stopped, reply.json.cleaned], [200, false, false]);
    assert.equal(s.f.cleanup.terminated, swept, '돌고 있는 시험을 파드 정리가 죽이지 않는다');
    assert.ok(serviceOf(s).turn, '시험이 슬롯을 그대로 쥔다');
  } finally { await s.f.close(); }
});
test('7-1 시작 기록은 receipt와 함께 정리된다. 같은 프로세스에서 끝난 시험은 그대로 done이다', async () => {
  const s = await verifying(async () => pass());
  try {
    await s.f.signed('/v2/task/verify', s.body);
    let done: any;
    for (let attempt = 0; attempt < 400 && done?.status !== 'done'; attempt++) {
      done = (await s.f.signed('/v2/task/verification', { ...identity(s.request), expectedWorker: null, commandId: 'unit' })).json;
      if (done.status !== 'done') await new Promise(resolve => setTimeout(resolve, 5));
    }
    assert.equal(done.status, 'done');
    assert.equal((await s.f.signed('/v2/task/verify', s.body)).json.status, 'done', 'receipt가 시작 기록보다 먼저다');
    await s.f.signed('/v2/task/finalize', { ...identity(s.request), expectedWorker: s.result.worker, receipt: { outcome: 'saved', artifactDigest: s.result.artifactDigest, persistedAt: 1 } });
    const left = await readdir(join(s.f.root, '.homelab-worker', 'change-results'));
    assert.deepEqual(left.filter(name => name.includes(s.request.job)), []);
  } finally { await s.f.close(); }
});
