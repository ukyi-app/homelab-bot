import { afterEach, test } from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync, randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { chmod, lstat, mkdir, open, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { TASK_CAPABILITY_AUDIENCE, TASK_ENDPOINTS, TASK_LIMITS, TaskRejectionSchema, TaskResponseSchema, TaskStatusResponseSchema, TaskWorkerSigner } from '../src/task-contracts.js';
import { taskWorkerServer } from '../src/task-http.js';
import { TaskRouteError } from '../src/task-worker.js';
import type { TaskWorkerService } from '../src/task-worker.js';
import { WorkerSigner, capabilityDigest, sealCapability } from '../src/worker.js';
import { WorkerStartError } from '../src/worker-state.js';
import { workerConfig } from '../src/worker-main.js';
import { COMPLETED, QUESTION, imageRoot, workerFixture } from './task-worker-harness.js';
import type { WorkerFixture } from './task-worker-harness.js';
import { resumeRequest, startRequest } from './task-fixtures.js';

// 작업 레인 작업자의 라우트와 가용성. 실제 진입점·HTTP·launcher에 가짜 CLI를 붙인다. 모델·네트워크 없음.
let fixture: WorkerFixture | undefined;
afterEach(async () => { await fixture?.close(); fixture = undefined; });
const rejected = (response: { json: unknown }) => assert.deepEqual(TaskRejectionSchema.parse(response.json), { status: 'rejected', started: false });
const control = (request: { job: string; lease: string; generation: number; sessionId: string }, expectedWorker: unknown = null) =>
  ({ version: 1, job: request.job, lease: request.lease, generation: request.generation, sessionId: request.sessionId, expectedWorker });
const receipt = { outcome: 'failed', persistedAt: 1, resultDigest: null };

test('라우트 로그: 거부와 오류는 끝점·상태·사유 상수만 남기고 본문·capability를 담지 않는다', async () => {
  const logs: Record<string, unknown>[] = [];
  const failures: unknown[] = [new TaskRouteError(409, 'busy'), new Error('요청본문표식')];
  const service = { intake: { startupClean: true, open: true, reasons: [] }, execute: async () => { throw failures.shift(); } } as unknown as TaskWorkerService;
  const server = taskWorkerServer(service, {}, item => logs.push(item));
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  try {
    const url = `http://127.0.0.1:${(server.address() as { port: number }).port}/v1/task`;
    const request = startRequest({ untrusted: { request: '요청본문표식' } });
    const post = (headers: Record<string, string>, payload: string) => fetch(url, { method: 'POST', headers, body: payload });
    const signed = { authorization: 'Capability 토큰표식'.replace('토큰표식', 'capability-mark') };
    assert.equal((await post({}, JSON.stringify(request))).status, 401);
    assert.equal((await post(signed, '{"broken":true}')).status, 400);
    assert.equal((await post(signed, JSON.stringify(request))).status, 409);
    assert.equal((await post(signed, JSON.stringify(request))).status, 500);
    assert.deepEqual(logs, [
      { level: 'warn', event: 'task_route_rejected', endpoint: '/v1/task', status: 401, reason: 'capability_missing' },
      { level: 'warn', event: 'task_route_rejected', endpoint: '/v1/task', status: 400, reason: 'request_invalid' },
      { level: 'warn', event: 'task_route_rejected', endpoint: '/v1/task', status: 409, reason: 'busy' },
      { level: 'error', event: 'task_route_failed', endpoint: '/v1/task', error: 'Error' },
    ]);
  } finally { server.close(); server.closeAllConnections(); }
});

const intake = async (f: WorkerFixture) => (await fetch(`${f.url}/v1/task/intake`)).json() as Promise<{ open: boolean; reasons: string[]; capabilities: Record<string, unknown> }>;
const ready = async (f: WorkerFixture) => (await fetch(`${f.url}/readyz`)).status;
const waitUntil = async (check: () => Promise<boolean> | boolean) => {
  const deadline = Date.now() + 8000;
  while (!await check()) {
    if (Date.now() > deadline) throw new Error('wait_timeout');
    await new Promise(resolve => setTimeout(resolve, 10));
  }
};

test('B5 설정: WORKER_LANES 미설정·chat,review는 대화·리뷰, task는 상태 루트 필수, 오타는 기동 오류', async () => {
  const keys = generateKeyPairSync('ed25519');
  const env = { WORKER_EXECUTOR: 'claude', WORKER_MODEL: 'claude-opus-5-5', WORKER_CREDENTIAL_DIR: '/run/worker-credential', WORKER_CREDENTIAL_KEY: 'CLAUDE_CODE_OAUTH_TOKEN',
    WORKER_NONCE_DIR: '/worker-state/.homelab-worker/nonces', WORKER_CONTROL_PUBLIC_KEY: keys.publicKey.export({ type: 'spki', format: 'pem' }).toString() };
  const code = (extra: Record<string, string>) => { try { workerConfig({ ...env, ...extra }); return 'ok'; } catch (error) { return (error as WorkerStartError).code; } };
  assert.equal(workerConfig(env).task, undefined);
  assert.equal(workerConfig({ ...env, WORKER_LANES: 'chat,review' }).task, undefined);
  assert.deepEqual(workerConfig({ ...env, WORKER_LANES: 'task', TASK_STATE_ROOT: '/worker-state' }).task, { stateRoot: '/worker-state' });
  assert.equal(code({ WORKER_LANES: 'task' }), 'config_missing:TASK_STATE_ROOT');
  assert.equal(code({ WORKER_LANES: 'task', TASK_STATE_ROOT: 'relative' }), 'config_invalid:TASK_STATE_ROOT');
  assert.equal(code({ WORKER_LANES: 'chat' }), 'config_invalid:WORKER_LANES');
  // 샌드박스가 가리는 제어 경로 밖의 nonce는 비신뢰 명령이 지울 수 있다.
  assert.equal(code({ WORKER_LANES: 'task', TASK_STATE_ROOT: '/worker-state', WORKER_NONCE_DIR: '/worker-state/tasks/nonces' }), 'config_invalid:WORKER_NONCE_DIR');
  assert.equal(code({ WORKER_LANES: 'task', TASK_STATE_ROOT: '/worker-state', WORKER_NONCE_DIR: '/worker-state/.homelab-worker-evil' }), 'config_invalid:WORKER_NONCE_DIR');
  // Codex 프로필은 작업 레인 능력이 없다.
  assert.equal(code({ WORKER_LANES: 'task', TASK_STATE_ROOT: '/worker-state', WORKER_EXECUTOR: 'codex', WORKER_CREDENTIAL_KEY: 'CODEX_AUTH_JSON', WORKER_MODEL: 'cli-default', CODEX_HOME: '/codex-home' }), 'profile_unsupported');
});

test('B5 호환(새 작업자 + 옛 게시 서버): WORKER_LANES가 없으면 대화 작업자이고 작업 끝점이 없다', async () => {
  fixture = await workerFixture({ lanes: '' });
  assert.equal(fixture.running.taskIntake, undefined);
  for (const path of ['/v1/task', '/v1/task/cancel', '/v1/task/status', '/v1/task/finalize']) assert.equal((await fixture.post(path, {})).status, 404, path);
  assert.equal((await fetch(`${fixture.url}/v1/task/intake`)).status, 404);
  assert.equal((await fixture.post('/v1/execute', {})).status, 401);
  assert.equal(await ready(fixture), 200);
});

test('B5 작업 모드: 대화·리뷰 끝점을 열지 않고 상태 응답은 능력표를 싣는다', async () => {
  fixture = await workerFixture();
  for (const path of ['/v1/execute', '/v1/cancel', '/v1/review', '/v1/review/cancel']) assert.equal((await fixture.post(path, {})).status, 404, path);
  assert.equal(await ready(fixture), 200);
  const state = await intake(fixture);
  assert.deepEqual([state.open, state.reasons], [true, []]);
  assert.equal(state.capabilities.tools, 'sandboxed-task');
  assert.equal(state.capabilities.sessionPersistence, 'per-job');
  assert.deepEqual(state.capabilities.lanes, { chat: false, task: true, review: false });
  assert.deepEqual(fixture.running.taskIntake!(), []);
  // capability 없으면 본문을 읽기 전에 401.
  for (const path of Object.keys(TASK_ENDPOINTS)) { const response = await fixture.post(path, {}); assert.equal(response.status, 401, path); rejected(response); }
  assert.equal((await fetch(`${fixture.url}/v1/task`)).status, 404);
});

test('B5 서명 거부: 변조·만료·다른 operation·대화 capability·재사용은 시작하지 않고 거부', async () => {
  fixture = await workerFixture();
  const request = startRequest();
  const parsed = TASK_ENDPOINTS['/v1/task'].request.parse(request);
  const keys = generateKeyPairSync('ed25519');
  const expect = async (name: string, token: string, status: number, body: unknown = parsed) => {
    const response = await fixture!.post('/v1/task', body, token);
    assert.equal(response.status, status, name);
    rejected(response);
  };
  // 공격자 키, 저장소 바꿔치기, 다른 끝점의 capability, 대화·리뷰 capability, 수명 초과.
  await expect('다른 키', new TaskWorkerSigner(keys.privateKey).issue('task_execute', parsed), 403);
  const signerKey = (fixture.signer as unknown as { privateKey: Parameters<typeof sealCapability>[1] }).privateKey;
  await expect('저장소 변조', fixture.signer.issue('task_execute', parsed), 403, { ...parsed, repository: 'attacker/repo' });
  await expect('다른 operation', fixture.signer.issue('task_cancel', parsed), 403);
  await expect('대화 capability', new WorkerSigner(signerKey).issue({ id: parsed.job, lease_token: parsed.lease } as never, 'execute', parsed), 403);
  const old = Date.now() - 60_000;
  await expect('만료', sealCapability({ audience: TASK_CAPABILITY_AUDIENCE, operation: 'task_execute', version: 1, job: parsed.job, lease: parsed.lease, generation: parsed.generation,
    digest: capabilityDigest(parsed), issued: old, expires: old + 30_000 }, signerKey), 403);
  await expect('다른 세대', fixture.signer.issue('task_execute', { ...parsed, generation: 2 }), 403);
  // 시작 전 거부: CLI가 뜨지 않았다.
  assert.deepEqual(await fixture.calls(), []);
  // 스키마·상한.
  await expect('스키마', fixture.signer.issue('task_execute', parsed), 400, { ...parsed, repository: '../evil' });
  const big = await fetch(`${fixture.url}/v1/task`, { method: 'POST', headers: { authorization: 'Capability x' }, body: 'x'.repeat(TASK_LIMITS.bodyBytes + 1) });
  assert.equal(big.status, 400);
  // 같은 capability 재사용: 첫 번째만 실행.
  const token = fixture.signer.issue('task_execute', parsed);
  assert.equal((await fixture.post('/v1/task', parsed, token)).status, 200);
  await expect('재사용', token, 403);
  assert.equal((await fixture.calls()).length, 1);
});

test('B5 한 턴: start → 완료 응답에 실제 변경, 저장소 ID는 재시작에도 같고 instance만 바뀜, 압축본 URL은 작업자가 만든다', async () => {
  fixture = await workerFixture();
  await fixture.script([{ ...COMPLETED, write: { 'src/app.txt': 'two\n' } }]);
  const request = startRequest({ project: { id: 'fixture', revision: 'r1', allowedPaths: ['src'], forbiddenPaths: [], verifyCommands: ['unit'] } });
  const response = await fixture.signed('/v1/task', request);
  assert.equal(response.status, 200);
  const body = TaskResponseSchema.parse(response.json);
  assert.equal(body.status, 'completed');
  if (body.status !== 'completed') return;
  assert.deepEqual(body.changes.items.map(item => item.path), ['src/app.txt']);
  assert.deepEqual(body.verification, [{ command: 'unit', status: 'not_run', exitCode: null }]);
  assert.equal(body.stopped, true);
  assert.deepEqual(fixture.archiveUrls, [`https://codeload.github.com/${request.repository}/tar.gz/${request.base}`]);
  const [call] = await fixture.calls();
  assert.ok(call!.args.includes('--session-id'));
  assert.equal(call!.scrub, '1');
  assert.ok(!call!.args.join(' ').includes('fixture-token'), '토큰이 argv에 없다');
  const worker = body.worker;
  await fixture.restart();
  const status = TaskStatusResponseSchema.parse((await fixture.signed('/v1/task/status', control(request))).json);
  assert.equal(status.worker.storage, worker.storage);
  assert.notEqual(status.worker.instance, worker.instance);
  assert.deepEqual([status.state, status.turn, status.sessionExists, status.stopped], ['waiting', 1, true, true]);
});

test('B5 fence: 취소된 세대의 늦은 시작·지난 세대·지난 턴은 재시작 뒤에도 409', async () => {
  fixture = await workerFixture();
  const late = startRequest();
  // 응답을 잃어 취소가 먼저 닿은 경우. 작업자는 이 세대를 본 적이 없다.
  const cancel = await fixture.signed('/v1/task/cancel', control(late));
  assert.deepEqual([cancel.status, cancel.json.stopped, cancel.json.sessionRetained], [200, true, false]);
  const first = await fixture.signed('/v1/task', late);
  assert.equal(first.status, 409); rejected(first);
  await fixture.restart();
  const again = await fixture.signed('/v1/task', late);
  assert.equal(again.status, 409); rejected(again);
  assert.deepEqual(await fixture.calls(), []);
  // 새 세대는 받는다. 그 뒤로 지난 세대는 거부한다. 다시 띄운 작업은 새 세대다.
  await fixture.script([QUESTION]);
  const next = startRequest({ job: late.job, generation: 2 });
  assert.equal((await fixture.signed('/v1/task', next)).status, 200);
  assert.equal((await fixture.signed('/v1/task', startRequest({ job: late.job, generation: 1 }))).status, 409);
  // 같은 세대의 첫 턴을 다시 보내도 거부한다. 재개는 지난 턴 번호를 쓸 수 없다.
  const worker = TaskStatusResponseSchema.parse((await fixture.signed('/v1/task/status', control(next))).json).worker;
  assert.equal((await fixture.signed('/v1/task', { ...next, lease: randomUUID() })).status, 409);
  const resume = resumeRequest(next, { expectedWorker: worker, resumeReason: 'model_limit', lease: randomUUID() });
  await fixture.script([COMPLETED]);
  assert.equal((await fixture.signed('/v1/task', resume)).status, 200);
  assert.equal((await fixture.signed('/v1/task', { ...resume, lease: randomUUID() })).status, 409);
});

test('B5 직렬 슬롯: 실행 중 다른 작업은 409, 다른 작업의 취소는 파드 정리를 부르지 않음, 자기 취소는 멈추고 응답', async () => {
  fixture = await workerFixture();
  await fixture.script([{ kind: 'hang' }]);
  const running = startRequest();
  const turn = fixture.signed('/v1/task', running);
  await waitUntil(async () => (await fixture!.calls()).length === 1);
  const busy = await fixture.signed('/v1/task', startRequest());
  assert.equal(busy.status, 409); rejected(busy);
  const status = TaskStatusResponseSchema.parse((await fixture.signed('/v1/task/status', control(running))).json);
  assert.deepEqual([status.state, status.stopped, status.turn], ['running', false, 1]);
  // 다른 job의 취소·상태·정리: 직렬 1이라 그 job의 프로세스는 없다. 여기서 파드 전체를 정리하면 도는 실행이 죽는다.
  const other = startRequest();
  const before = fixture.cleanup.terminated;
  assert.equal((await fixture.signed('/v1/task/cancel', control(other))).json.stopped, true);
  assert.equal(TaskStatusResponseSchema.parse((await fixture.signed('/v1/task/status', control(other))).json).state, 'absent');
  assert.equal(fixture.cleanup.terminated, before);
  // 옛 lease의 취소는 지금 턴을 건드리지 않는다.
  assert.equal((await fixture.signed('/v1/task/cancel', control({ ...running, lease: randomUUID() }))).json.stopped, true);
  assert.equal(fixture.cleanup.terminated, before);
  // 실행 중 세대의 finalize는 지우지 않는다.
  const worker = status.worker;
  const finalize = await fixture.signed('/v1/task/finalize', { ...control(running, worker), disposition: 'terminal', receipt });
  assert.deepEqual([finalize.json.stopped, finalize.json.cleaned, finalize.json.sessionRetained], [false, false, true]);
  assert.equal((await lstat(join(fixture.root, 'tasks', running.job, '1'))).isDirectory(), true);
  const cancel = await fixture.signed('/v1/task/cancel', control(running, worker));
  assert.deepEqual([cancel.status, cancel.json.stopped, cancel.json.cleaned], [200, true, true]);
  const answer = TaskResponseSchema.parse((await turn).json);
  assert.deepEqual([answer.status, answer.stopped], ['failed', true]);
  assert.equal(answer.status === 'failed' && answer.reason, 'aborted');
});

test('B5 identity 불일치: 재개·취소·정리는 409, 상태는 identity 없이 답함', async () => {
  fixture = await workerFixture();
  await fixture.script([QUESTION]);
  const request = startRequest();
  const worker = TaskResponseSchema.parse((await fixture.signed('/v1/task', request)).json).worker;
  const wrong = [{ ...worker, instance: randomUUID() }, { ...worker, storage: randomUUID() }];
  for (const expectedWorker of wrong) {
    for (const [endpoint, body] of [['/v1/task', resumeRequest(request, { expectedWorker, lease: randomUUID() })],
      ['/v1/task/cancel', control(request, expectedWorker)], ['/v1/task/finalize', { ...control(request, expectedWorker), disposition: 'terminal', receipt }]] as const) {
      const response = await fixture.signed(endpoint, body);
      assert.equal(response.status, 409, endpoint); rejected(response);
    }
  }
  assert.equal(TaskStatusResponseSchema.parse((await fixture.signed('/v1/task/status', control(request))).json).state, 'waiting');
  assert.equal((await fixture.calls()).length, 1);
});

test('B5 소멸 미확인: unknown 뒤 새 실행을 받지 않고, 확인되면 풀린다', async () => {
  fixture = await workerFixture();
  fixture.cleanup.override = 1;
  await fixture.script([COMPLETED]);
  const request = startRequest();
  const answer = TaskResponseSchema.parse((await fixture.signed('/v1/task', request)).json);
  assert.deepEqual([answer.status, answer.stopped, answer.sessionRetained], ['unknown', false, true]);
  assert.equal((await fixture.signed('/v1/task', startRequest())).status, 409);
  const status = TaskStatusResponseSchema.parse((await fixture.signed('/v1/task/status', control(request))).json);
  assert.deepEqual([status.state, status.stopped], ['unknown', false]);
  const stuck = await fixture.signed('/v1/task/cancel', control(request, answer.worker));
  assert.deepEqual([stuck.json.stopped, stuck.json.cleaned, stuck.json.sessionRetained], [false, false, true]);
  // 소멸을 못 봤으면 finalize가 공간을 지우지 않는다.
  const blocked = await fixture.signed('/v1/task/finalize', { ...control(request, answer.worker), disposition: 'terminal', receipt });
  assert.deepEqual([blocked.json.stopped, blocked.json.cleaned], [false, false]);
  assert.equal((await lstat(join(fixture.root, 'tasks', request.job, '1'))).isDirectory(), true);
  fixture.cleanup.override = undefined;
  assert.equal((await fixture.signed('/v1/task/cancel', control(request, answer.worker))).json.stopped, true);
  assert.equal((await fixture.signed('/v1/task', startRequest())).status, 200);
});

test('B5 정리: 세션 공간을 지우고 finalized로 답함, 다른 세대는 그대로, 지운 세대의 늦은 재개는 409', async () => {
  fixture = await workerFixture();
  await fixture.script([QUESTION]);
  const request = startRequest();
  const answer = TaskResponseSchema.parse((await fixture.signed('/v1/task', request)).json);
  const done = await fixture.signed('/v1/task/finalize', { ...control(request, answer.worker), disposition: 'terminal', receipt });
  assert.deepEqual([done.status, done.json.stopped, done.json.cleaned, done.json.sessionRetained, done.json.cleanupPending], [200, true, true, false, false]);
  await assert.rejects(lstat(join(fixture.root, 'tasks', request.job)));
  const status = TaskStatusResponseSchema.parse((await fixture.signed('/v1/task/status', control(request))).json);
  assert.deepEqual([status.state, status.sessionExists, status.stopped], ['finalized', false, true]);
  assert.equal((await fixture.signed('/v1/task', resumeRequest(request, { expectedWorker: answer.worker, lease: randomUUID() }))).status, 409);
  // 다시 지워도 안전하다.
  const again = await fixture.signed('/v1/task/finalize', { ...control(request, answer.worker), disposition: 'terminal', receipt });
  assert.deepEqual([again.json.stopped, again.json.cleaned], [true, true]);
});

test('B5 가용성(nonce 실패): 프로세스·readyz는 그대로, 실행만 503, 제어는 메모리로 받아 공간을 비울 수 있음, 원인이 풀리면 다시 연다', async () => {
  let broken = false;
  let free = Number.MAX_SAFE_INTEGER;
  // ENOSPC는 nonce 파일을 못 만들 때의 실제 오류다.
  const nonceIo = { open: (async (...args: Parameters<typeof open>) => {
    if (broken) throw Object.assign(new Error('no space'), { code: 'ENOSPC' });
    return open(...args);
  }) as typeof open };
  fixture = await workerFixture({ start: { taskProbe: { probeMs: 3_600_000, nonceIo, freeBytes: async () => free, probeVolume: async () => { if (broken) throw new Error('no space'); } } } });
  await fixture.script([QUESTION]);
  const held = startRequest();
  const worker = TaskResponseSchema.parse((await fixture.signed('/v1/task', held)).json).worker;
  broken = true;
  const refused = await fixture.signed('/v1/task', startRequest());
  assert.equal(refused.status, 503); rejected(refused);
  assert.deepEqual((await intake(fixture)).reasons, ['nonce_write_failed']);
  assert.equal(fixture.running.taskIntake!().length, 1);
  assert.equal(await ready(fixture), 200);
  // 닫힌 동안은 서명을 보기 전에 503이다. 실행 중 프로세스는 없고 CLI도 뜨지 않았다.
  const closed = await fixture.signed('/v1/task', startRequest());
  assert.equal(closed.status, 503); rejected(closed);
  assert.equal((await fixture.calls()).length, 1);
  // 제어는 계속 된다. 메모리 기록으로 재사용은 막는다. 정리가 공간을 비운다.
  const parsed = TASK_ENDPOINTS['/v1/task/status'].request.parse(control(held));
  const token = fixture.signer.issue('task_status', parsed);
  assert.equal((await fixture.post('/v1/task/status', parsed, token)).status, 200);
  assert.equal((await fixture.post('/v1/task/status', parsed, token)).status, 403);
  const done = await fixture.signed('/v1/task/finalize', { ...control(held, worker), disposition: 'terminal', receipt });
  assert.deepEqual([done.status, done.json.cleaned], [200, true]);
  // 재시작 없이도 원인이 풀리면 열리고, 볼륨 부족은 따로 보인다.
  broken = false;
  await fixture.restart({ taskProbe: { probeMs: 20, nonceIo, freeBytes: async () => free, probeVolume: async () => { if (broken) throw new Error('no space'); } } });
  assert.deepEqual((await intake(fixture)).reasons, []);
  free = 1;
  await waitUntil(async () => (await intake(fixture!)).reasons.includes('volume_low'));
  assert.equal(await ready(fixture), 200);
  assert.equal((await fixture.signed('/v1/task', startRequest())).status, 503);
  free = Number.MAX_SAFE_INTEGER;
  await waitUntil(async () => (await intake(fixture!)).open);
  await fixture.script([COMPLETED]);
  assert.equal((await fixture.signed('/v1/task', startRequest())).status, 200);
});

test('B5 가용성(자격): 토큰 파일이 사라지면 수락만 닫고 돌아오면 연다', async () => {
  fixture = await workerFixture({ start: { taskProbe: { probeMs: 20 } } });
  const token = join(fixture.env.WORKER_CREDENTIAL_DIR!, 'CLAUDE_CODE_OAUTH_TOKEN');
  await rm(token);
  await waitUntil(async () => (await intake(fixture!)).reasons.includes('credential_unavailable'));
  assert.equal(await ready(fixture), 200);
  assert.equal((await fixture.signed('/v1/task', startRequest())).status, 503);
  await writeFile(token, 'sk-ant-oat01-fixture-token-replaced-0123456789\n');
  await waitUntil(async () => (await intake(fixture!)).open);
});

test('B5 가용성(볼륨을 못 씀): 기동해도 죽지 않고 503, 볼륨이 돌아오면 identity를 세우고 연다', { skip: process.getuid?.() === 0 ? 'root는 권한 시험을 건너뛴다' : false }, async () => {
  fixture = await workerFixture({ start: { taskProbe: { probeMs: 20 } } });
  await fixture.running.close();
  await rm(join(fixture.root, '.homelab-worker'), { recursive: true, force: true });
  await chmod(fixture.root, 0o500);
  await fixture.restart();
  assert.equal(await ready(fixture), 200);
  const state = await intake(fixture);
  assert.equal(state.open, false);
  assert.ok(state.reasons.includes('state_unavailable'), state.reasons.join(','));
  // 저장소 ID를 모르면 제어도 답하지 않는다. 지어낸 identity는 세션을 잃은 것으로 읽힌다.
  for (const endpoint of ['/v1/task/status', '/v1/task/cancel'] as const) {
    const response = await fixture.signed(endpoint, control(startRequest()));
    assert.equal(response.status, 503, endpoint); rejected(response);
  }
  assert.equal((await fixture.signed('/v1/task', startRequest())).status, 503);
  await chmod(fixture.root, 0o700);
  await waitUntil(async () => (await intake(fixture!)).open);
  assert.equal((await fixture.signed('/v1/task', startRequest())).status, 200);
});

test('B5 기동 검사: 이미지 문제면 프로세스는 살아 있고 readyz 503, 실행 503, 소멸은 답하지 못함', async () => {
  fixture = await workerFixture();
  await fixture.restart({ fsRoot: await imageRoot(join(fixture.base, 'partial'), ['usr/bin/git']) });
  assert.equal(await ready(fixture), 503);
  assert.deepEqual((await intake(fixture)).reasons, ['bwrap_missing', 'socat_missing']);
  const response = await fixture.signed('/v1/task', startRequest());
  assert.equal(response.status, 503); rejected(response);
  assert.deepEqual(await fixture.calls(), []);
  // 관리 설정이 있어도 같은 길이다.
  const managed = await imageRoot(join(fixture.base, 'managed'));
  await mkdir(join(managed, 'etc', 'claude-code'), { recursive: true });
  await fixture.restart({ fsRoot: managed });
  assert.deepEqual((await intake(fixture)).reasons, ['managed_settings_present']);
});

test('B5 기동 검사: CLI 버전이 다르면 닫힘, 기준 상태가 깨끗하지 않으면 kill 없이 닫힘', async () => {
  fixture = await workerFixture();
  await writeFile(join(fixture.env.WORKER_EXECUTOR_BIN!, '..', 'version.txt'), '2.1.309 (Claude Code)\n');
  await fixture.restart();
  assert.deepEqual((await intake(fixture)).reasons, ['executor_version_mismatch']);
  assert.equal(await ready(fixture), 503);
  await writeFile(join(fixture.env.WORKER_EXECUTOR_BIN!, '..', 'version.txt'), '2.1.308 (Claude Code)\n');
  // 시험 파드에는 다른 프로세스가 있다. PodPidSpace.record가 거부해 kill(-1)이 나갈 수단 자체가 없다.
  await fixture.restart({ cleanup: undefined });
  const reasons = (await intake(fixture)).reasons;
  assert.ok(reasons.some(reason => reason.startsWith('pid_')), reasons.join(','));
  assert.equal(await ready(fixture), 503);
  const request = startRequest();
  const cancel = await fixture.signed('/v1/task/cancel', control(request));
  assert.deepEqual([cancel.status, cancel.json.stopped], [200, false]);
  const status = TaskStatusResponseSchema.parse((await fixture.signed('/v1/task/status', control(request))).json);
  assert.deepEqual([status.state, status.stopped], ['unknown', false]);
});
