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
