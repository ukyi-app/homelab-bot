import { afterEach, before, beforeEach, test } from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync, randomUUID } from 'node:crypto';
import { chmod, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import type { AddressInfo } from 'node:net';
import { join, resolve } from 'node:path';
import { CHAT_REPLY_JSON_SCHEMA, ChatLane, chatPrompt } from '../src/chat-lane.js';
import { SYSTEM_INSTRUCTIONS } from '../src/contracts.js';
import type { Job } from '../src/contracts.js';
import { createExecutor, selectProfile } from '../src/executor-profiles.js';
import type { ExecutionSelection } from '../src/execution-auth.js';
import { SerialWorker, WorkerRequestSchema, WorkerSigner, WorkerVerifier, capabilityDigest, workerRequest, workerRequestV3 } from '../src/worker.js';
import type { WorkerRequestV1, WorkerRequestV3 } from '../src/worker.js';
import { HttpWorker } from '../src/worker-http.js';
import { startWorker, workerConfig } from '../src/worker-main.js';
import { RATE_LIMIT_EVENTS } from './rate-limit-fixture.js';
import { SpawnLauncher } from './spawn-launcher.js';

// C39 실행마다 방식 고르기의 작업자 쪽(AC-34·AC-35 분류·AC-42 판 조합, S2: 작업자 요청 → 가짜 CLI → 응답).
// 모델 호출 없음. 자격 값은 합성이다. 계정 묶음 모양과 지문 계산은 DECISIONS "C39"의 계약 그대로 시험 안에서 따로 만든다.
const TOKEN = 'sk-ant-oat01-fixture-token-ABCDEFGHIJKLMNOPQRSTUVWXYZ-0123456789';
const API_KEY = 'sk-ant-api03-fixture-key-ABCDEFGHIJKLMNOPQRSTUVWXYZ-0123456789';
const MODEL = 'claude-opus-5-5';
const REPLY = { reply: '확인했어요.', proposal: null, ack_only: false };
// 계약의 지문: 값(앞뒤 공백 뗀 UTF-8)의 SHA-256 소문자 hex. Node crypto로 계산하지 않고 `printf '%s' <값> | sha256sum`으로
// 따로 얻은 값을 박는다(구현을 다시 계산하지 않는다).
const fingerprints = {
  token: '9985396575295f03c5721663be755c756073d47e517f1d41f2d7cd26200ce0eb',
  apiKey: '4df03dd919b430eb05b7562f34a740af803661d8c3896c0a6affeec0dc608bf7',
};
const FAKE_CLAUDE = `
const fs = require('node:fs');
const path = require('node:path');
const args = process.argv.slice(2);
if (args[0] === '--version') { process.stdout.write('2.1.308 (Claude Code)\\n'); process.exit(0); }
const mode = JSON.parse(fs.readFileSync(path.join(__dirname, 'mode.json'), 'utf8'));
let input = '';
process.stdin.on('data', d => { input += d; });
process.stdin.on('end', () => {
  fs.writeFileSync(path.join(__dirname, 'seen.json'), JSON.stringify({ env: process.env, input, args }));
  const emit = e => process.stdout.write(JSON.stringify({ session_id: 's', ...e }) + '\\n');
  const model = args[args.indexOf('--model') + 1];
  emit({ type: 'system', subtype: 'init', tools: ['StructuredOutput'], mcp_servers: [], model, skills: [], plugins: [],
    apiKeySource: process.env.ANTHROPIC_API_KEY ? 'ANTHROPIC_API_KEY' : 'none', claude_code_version: '2.1.308' });
  for (const event of mode.events || []) emit(event);
  if (mode.kind === 'error') {
    emit({ type: 'assistant', ...(mode.error === undefined ? {} : { error: mode.error }), api_error_status: mode.status,
      message: { model: '<synthetic>', content: [{ type: 'text', text: 'API Error' }] } });
    emit({ type: 'result', subtype: 'success', is_error: true, api_error_status: mode.status, result: 'API Error' });
    process.stdout.write('', () => process.exit(1)); return;
  }
  emit({ type: 'assistant', message: { model, content: [{ type: 'tool_use', id: 't1', name: 'StructuredOutput', input: mode.answer }] } });
  process.stdout.write(JSON.stringify({ type: 'result', subtype: 'success', is_error: false, structured_output: mode.answer }) + '\\n',
    () => process.exit(0));
});
`;

let base: string;
let dir: string;
let fakeDir: string;
let fakeBin: string;
const keys = generateKeyPairSync('ed25519');
const publicPem = keys.publicKey.export({ type: 'spki', format: 'pem' }).toString();
before(async () => { await mkdir('.local', { recursive: true }); });
beforeEach(async () => {
  base = resolve(await mkdtemp('.local/c39-'));
  dir = join(base, 'credential'); fakeDir = join(base, 'fake');
  for (const d of [dir, fakeDir]) await mkdir(d, { recursive: true });
  await writeFile(join(fakeDir, 'claude.cjs'), FAKE_CLAUDE);
  fakeBin = join(fakeDir, 'claude');
  await writeFile(fakeBin, `#!/bin/sh\nexec "${process.execPath}" "${join(fakeDir, 'claude.cjs')}" "$@"\n`);
  await chmod(fakeBin, 0o755);
  await mode({ kind: 'answer', answer: REPLY });
  await install();
  process.env.TMPDIR = base;
});
afterEach(async () => { delete process.env.TMPDIR; await rm(base, { recursive: true, force: true }).catch(() => {}); });
const mode = (value: unknown) => writeFile(join(fakeDir, 'mode.json'), JSON.stringify(value));
const seenEnv = async () => (JSON.parse(await readFile(join(fakeDir, 'seen.json'), 'utf8')) as { env: Record<string, string> }).env;
const CREDENTIAL_ENVS = ['CLAUDE_CODE_OAUTH_TOKEN', 'ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN'];
const credentialEnvs = (env: Record<string, string>) => Object.keys(env).filter(name => CREDENTIAL_ENVS.includes(name));

// 두 방식이 함께 설치된 Secret 한 판: 두 자격, 방식 표시(옛 요청용), 계정 묶음. null이면 그 파일을 두지 않는다.
interface Files { token?: string | null; apiKey?: string | null; marker?: string | null; bundle?: unknown }
const bundleOf = (over: Record<string, unknown> = {}) => ({ version: 1, account: 'main', revision: 'r7',
  fingerprints: { subscription: fingerprints.token, api: fingerprints.apiKey }, ...over });
async function install(files: Files = {}, target = dir) {
  const values: Record<string, string | null> = {
    CLAUDE_CODE_OAUTH_TOKEN: files.token === undefined ? `${TOKEN}\n` : files.token,
    ANTHROPIC_API_KEY: files.apiKey === undefined ? `${API_KEY}\n` : files.apiKey,
    CLAUDE_AUTH_METHOD: files.marker === undefined ? 'subscription' : files.marker,
    CLAUDE_ACCOUNT_BUNDLE: files.bundle === undefined ? JSON.stringify(bundleOf())
      : files.bundle === null ? null : typeof files.bundle === 'string' ? files.bundle : JSON.stringify(files.bundle),
  };
  for (const [name, value] of Object.entries(values)) {
    await rm(join(target, name), { force: true });
    if (value !== null) await writeFile(join(target, name), value);
  }
}
const selection = (over: Partial<ExecutionSelection> = {}): ExecutionSelection =>
  ({ account: 'main', credentialRevision: 'r7', method: 'subscription', runId: randomUUID(), ...over });
const job = (): Job => ({ id: randomUUID(), lease_token: randomUUID(), type: 'chat', revision: { policy: 'fixture-v1' },
  budget: { timeoutMs: 60_000, toolCalls: 0 } }) as Job;
const v3 = (j: Job, chosen: ExecutionSelection): WorkerRequestV3 =>
  workerRequestV3(j, [{ from: 'owner', text: '상태 알려줘' }], { surface: 'speech', earlierPurged: false }, chosen);
const lane = (launcher: SpawnLauncher) => {
  const executor = createExecutor(selectProfile('claude', 'CLAUDE_CODE_OAUTH_TOKEN', MODEL),
    { credentialFile: join(dir, 'CLAUDE_CODE_OAUTH_TOKEN') }, []);
  return new ChatLane(executor.adapter, executor.credential, launcher, { model: MODEL, tmp: base });
};
const signal = () => new AbortController().signal;

test('C39 옛 판 고정: 대화 v1·v2 요청의 키 순서와 digest가 지금과 같다(새 칸이 옛 판에 끼지 않는다, AC-42)', () => {
  const j = { id: '00000000-0000-4000-8000-000000000001', lease_token: '00000000-0000-4000-8000-000000000002', type: 'chat',
    revision: { policy: 'fixture-v1' }, budget: { timeoutMs: 60_000, toolCalls: 0 } } as Job;
  const v2 = workerRequest(j, [{ from: 'owner', text: '상태 알려줘' }], { surface: 'speech', earlierPurged: false });
  assert.deepEqual(Object.keys(v2), ['version', 'job', 'lease', 'lane', 'policyRevision', 'instructions', 'surface', 'earlierPurged',
    'untrusted', 'timeoutMs', 'toolCalls']);
  // origin/main 55cb3cb에서 같은 본문으로 계산한 값.
  assert.equal(capabilityDigest(v2), '9101496b7191ab8f6f07eaa02462351cd801cdd9e8f6559d747e95a6ba79e7ca');
  const v1: WorkerRequestV1 = { version: 1, job: j.id, lease: j.lease_token, lane: 'chat', policyRevision: 'fixture-v1',
    instructions: SYSTEM_INSTRUCTIONS, untrusted: [{ text: '상태 알려줘' }], timeoutMs: 60_000, toolCalls: 8 };
  assert.equal(capabilityDigest(WorkerRequestSchema.parse(v1)), 'a9f11ad7b4d7dbf22d9d74cab63578f0db4301b615270ac0c1b4a23b6d785b71');
  // 옛 판에 선택 칸을 더한 요청은 받지 않는다(strict).
  assert.equal(WorkerRequestSchema.safeParse({ ...v2, execution: selection() }).success, false);
});

test('C39 새 판 요청: 선택 칸(계정·revision·방식·runId)이 끝에 붙고 digest에 들어가, 방식만 바꿔도 digest가 다르다', () => {
  const j = job(); const chosen = selection();
  const request = v3(j, chosen);
  assert.deepEqual(Object.keys(request), ['version', 'job', 'lease', 'lane', 'policyRevision', 'instructions', 'surface', 'earlierPurged',
    'untrusted', 'timeoutMs', 'toolCalls', 'execution']);
  assert.equal(request.version, 3);
  assert.deepEqual(request.execution, chosen);
  assert.notEqual(capabilityDigest(request), capabilityDigest(v3(j, { ...chosen, method: 'api' })));
  // 선택은 모델에게 가지 않고, 모델 출력 스키마에도 방식 칸이 없다(모델 출력이 방식을 고를 길이 없다).
  const v2 = workerRequest(j, [{ from: 'owner', text: '상태 알려줘' }], { surface: 'speech', earlierPurged: false });
  assert.equal(chatPrompt(request), chatPrompt(v2));
  assert.deepEqual(Object.keys(CHAT_REPLY_JSON_SCHEMA.properties), ['reply', 'proposal', 'ack_only']);
  for (const bad of [{ method: 'both' }, { account: 'Main' }, { credentialRevision: '' }, { runId: 'x' }]) {
    assert.throws(() => v3(j, { ...chosen, ...bad } as ExecutionSelection), JSON.stringify(bad));
  }
});

test('C39 실행 env: 구독 선택에는 구독 토큰만, API 선택에는 API 키만 있고 방식 표시 파일은 새 판 선택을 덮지 않는다(AC-34)', async () => {
  const launcher = new SpawnLauncher(fakeBin);
  const chat = lane(launcher);
  // 방식 표시는 api지만 요청이 구독을 골랐다.
  await install({ marker: 'api' });
  const sub = selection();
  assert.deepEqual(await chat.run(v3(job(), sub), signal()), { status: 'succeeded', stopped: true, output: REPLY, rateLimit: null,
    execution: { ...sub, subscriptionLimit: false } });
  let env = await seenEnv();
  assert.deepEqual(credentialEnvs(env), ['CLAUDE_CODE_OAUTH_TOKEN']);
  assert.equal(env.CLAUDE_CODE_OAUTH_TOKEN, TOKEN);
  for (const value of Object.values(env)) assert.ok(!value.includes(API_KEY));
  await install({ marker: 'subscription' });
  const api = selection({ method: 'api' });
  assert.deepEqual(await chat.run(v3(job(), api), signal()), { status: 'succeeded', stopped: true, output: REPLY, rateLimit: null,
    execution: { ...api, subscriptionLimit: false } });
  env = await seenEnv();
  assert.deepEqual(credentialEnvs(env), ['ANTHROPIC_API_KEY']);
  assert.equal(env.ANTHROPIC_API_KEY, API_KEY);
  for (const value of Object.values(env)) assert.ok(!value.includes(TOKEN));
  // 실행 env에 없는 쪽 자격이 답에 실려도 게시하지 않는다(두 값 모두 반사 검사 대상).
  await mode({ kind: 'answer', answer: { ...REPLY, reply: `토큰은 ${TOKEN}` } });
  const echoed = await chat.run(v3(job(), selection({ method: 'api' })), signal());
  assert.equal(echoed.status, 'failed');
  assert.equal(launcher.specs.length, 3);
});

test('C39 거부: 다른 계정·revision, 묶음 없음·깨짐, 자격 누락·unset, 지문이 다른 섞인 조합은 모델 호출 0건으로 not_run이다(AC-34)', async () => {
  const launcher = new SpawnLauncher(fakeBin);
  const chat = lane(launcher);
  const cases: [string, Files, Partial<ExecutionSelection>, string][] = [
    ['다른 계정', {}, { account: 'other' }, 'bundle_mismatch'],
    ['다른 revision', {}, { credentialRevision: 'r6' }, 'bundle_mismatch'],
    ['묶음 없음', { bundle: null }, {}, 'bundle_missing'],
    ['묶음 깨짐', { bundle: '{"version":1' }, {}, 'bundle_invalid'],
    ['묶음 모르는 칸', { bundle: bundleOf({ extra: true }) }, {}, 'bundle_invalid'],
    ['고른 자격 unset', { apiKey: 'unset' }, { method: 'api' }, 'credential_missing'],
    ['다른 쪽 자격 unset', { apiKey: 'unset' }, {}, 'credential_missing'],
    ['자격 파일 없음', { token: null }, { method: 'api' }, 'credential_missing'],
    // 새 계정의 구독 토큰과 옛 계정의 API 키가 함께 보이는 순간(Infisical 여러 쓰기 도중 ESO가 읽은 조합).
    ['지문이 다른 API 키', { apiKey: 'sk-ant-api03-other-account-key-ABCDEFGHIJKLMNOPQRSTUVWXYZ' }, {}, 'credential_mixed'],
    ['지문이 다른 구독 토큰', { token: 'sk-ant-oat01-other-account-token-ABCDEFGHIJKLMNOPQRSTUV' }, { method: 'api' }, 'credential_mixed'],
  ];
  for (const [label, files, over, refusal] of cases) {
    await install(files);
    const result = await chat.run(v3(job(), selection(over)), signal());
    assert.deepEqual(result, { status: 'not_run', stopped: true, refusal }, label);
    for (const secret of [TOKEN, API_KEY, fingerprints.token]) assert.ok(!JSON.stringify(result).includes(secret), label);
  }
  assert.equal(launcher.specs.length, 0);
  // 옛 요청은 묶음과 무관하게 지금처럼 방식 표시로 돈다(묶음이 없는 지금의 Secret).
  await install({ bundle: null });
  assert.equal((await chat.run(workerRequest(job(), [{ from: 'owner', text: '상태' }], { surface: 'speech', earlierPurged: false }), signal())).status,
    'succeeded');
  assert.deepEqual(credentialEnvs(await seenEnv()), ['CLAUDE_CODE_OAUTH_TOKEN']);
});

test('C39 볼륨 세대: 자격·묶음 파일이 서로 다른 Secret 볼륨 세대를 가리키면 지문이 맞아도 섞인 조합으로 거부한다(AC-34)', async () => {
  // kubelet Secret 볼륨처럼 파일 이름이 ..data 아래 세대 디렉터리의 심링크다.
  const gens = [join(dir, '..2026_11_12_01'), join(dir, '..2026_11_12_02')];
  for (const gen of gens) { await mkdir(gen); await install({}, gen); }
  await install({ token: null, apiKey: null, marker: null, bundle: null });
  await symlink('..2026_11_12_01', join(dir, '..data'));
  for (const name of ['CLAUDE_CODE_OAUTH_TOKEN', 'CLAUDE_AUTH_METHOD', 'CLAUDE_ACCOUNT_BUNDLE']) await symlink(join('..data', name), join(dir, name));
  // 교체 도중: API 키만 새 세대를 본다.
  await symlink(join('..2026_11_12_02', 'ANTHROPIC_API_KEY'), join(dir, 'ANTHROPIC_API_KEY'));
  const launcher = new SpawnLauncher(fakeBin);
  const chat = lane(launcher);
  assert.deepEqual(await chat.run(v3(job(), selection({ method: 'api' })), signal()), { status: 'not_run', stopped: true, refusal: 'credential_mixed' });
  assert.equal(launcher.specs.length, 0);
  // 한 세대로 맞춰지면 돈다.
  await rm(join(dir, 'ANTHROPIC_API_KEY'));
  await symlink(join('..data', 'ANTHROPIC_API_KEY'), join(dir, 'ANTHROPIC_API_KEY'));
  assert.equal((await chat.run(v3(job(), selection({ method: 'api' })), signal())).status, 'succeeded');
});

test('C39 넘어갈 근거 fixture 표: 구독의 한도 실패 모양만 subscriptionLimit이고 경고·성공·인증·과부하·결제·모르는 모양은 아니다(AC-35)', async () => {
  const chat = lane(new SpawnLauncher(fakeBin));
  // [모드, 방식, 기대 상태, 기대 subscriptionLimit]
  const table: [string, Record<string, unknown>, 'subscription' | 'api', string, boolean][] = [
    ['CLI 한도 종류 rate_limit(429) + rejected', { kind: 'error', error: 'rate_limit', status: 429, events: [RATE_LIMIT_EVENTS.rejected] }, 'subscription', 'limited', true],
    ['CLI 한도 종류 rate_limit, 이벤트 없음', { kind: 'error', error: 'rate_limit', status: 429 }, 'subscription', 'limited', true],
    ['종류 없음 + 429 + 같은 실행의 rejected', { kind: 'error', status: 429, events: [RATE_LIMIT_EVENTS.rejected] }, 'subscription', 'limited', true],
    // 분류할 수 없는 구독 오류: 지금처럼 구독 대기(limited)지만 넘어가지 않는다.
    ['종류 없음 + 429, rejected 없음', { kind: 'error', status: 429 }, 'subscription', 'limited', false],
    ['종류 없음 + 429 + 경고만', { kind: 'error', status: 429, events: [RATE_LIMIT_EVENTS.warning] }, 'subscription', 'limited', false],
    ['한도 경고 뒤 성공', { kind: 'answer', answer: REPLY, events: [RATE_LIMIT_EVENTS.warning] }, 'subscription', 'succeeded', false],
    ['rejected가 보였지만 성공(Usage credits)', { kind: 'answer', answer: REPLY, events: [RATE_LIMIT_EVENTS.rejected] }, 'subscription', 'succeeded', false],
    ['인증 실패', { kind: 'error', error: 'authentication_failed', status: 401, events: [RATE_LIMIT_EVENTS.rejected] }, 'subscription', 'auth_expired', false],
    ['과부하', { kind: 'error', error: 'overloaded', status: 529, events: [RATE_LIMIT_EVENTS.rejected] }, 'subscription', 'failed', false],
    ['구독의 결제 오류', { kind: 'error', error: 'billing_error', status: 402 }, 'subscription', 'limited', false],
    // API 방식의 429는 지금처럼 결제로 닫는다(보수 분류 그대로).
    ['API 방식 rate_limit 429', { kind: 'error', error: 'rate_limit', status: 429, events: [RATE_LIMIT_EVENTS.rejected] }, 'api', 'limited', false],
  ];
  for (const [label, fixture, method, status, limit] of table) {
    await mode(fixture);
    const chosen = selection({ method });
    const result = await chat.run(v3(job(), chosen), signal());
    assert.equal(result.status, status, label);
    assert.ok('execution' in result && result.execution, label);
    assert.deepEqual(result.execution, { ...chosen, subscriptionLimit: limit }, label);
    if (label === 'API 방식 rate_limit 429') assert.deepEqual('rateLimit' in result && result.rateLimit?.stop, { cause: 'billing', resetsAt: 1_794_286_800 });
  }
});

test('C39 응답 판: 옛 요청은 옛 응답만 받고 새 칸이 없다, 새 판 unknown에도 실행 칸이 있다(AC-42)', async () => {
  const chat = lane(new SpawnLauncher(fakeBin));
  const old = await chat.run(workerRequest(job(), [{ from: 'owner', text: '상태' }], { surface: 'speech', earlierPurged: false }), signal());
  assert.deepEqual(old, { status: 'succeeded', stopped: true, output: REPLY, rateLimit: null });
  // 실행 결과를 모르면(응답이 깨짐) unknown이지만, 시작했을 수 있는 유일한 방식인 요청 선택을 싣는다.
  const verifier = new WorkerVerifier(keys.publicKey, async () => true);
  const worker = new SerialWorker(verifier, async () => { throw new Error('broken'); }, async () => true);
  const j = job(); const chosen = selection({ method: 'api' }); const request = v3(j, chosen);
  const result = await worker.execute(request, new WorkerSigner(keys.privateKey).issue(j, 'execute', request), signal());
  assert.deepEqual(result, { status: 'unknown', stopped: false, execution: { ...chosen, subscriptionLimit: false } });
});

test('C39 HTTP 끝까지: 서명한 새 판 요청 → 고른 방식 실행 → 새 응답, 변조한 방식은 서명 불일치로 실행 0건, 지원 확인 경로(AC-34·AC-42)', async () => {
  const signer = new WorkerSigner(keys.privateKey);
  const launcher = new SpawnLauncher(fakeBin);
  const worker = await startWorker(workerConfig({ WORKER_EXECUTOR: 'claude', WORKER_MODEL: MODEL, WORKER_CREDENTIAL_DIR: dir,
    WORKER_CREDENTIAL_KEY: 'CLAUDE_CODE_OAUTH_TOKEN', WORKER_NONCE_DIR: join(base, 'state', 'nonces'), WORKER_CONTROL_PUBLIC_KEY: publicPem,
    WORKER_EXECUTOR_BIN: fakeBin }), { port: 0, host: '127.0.0.1', launcher, homes: [] });
  try {
    const origin = `http://127.0.0.1:${(worker.server.address() as AddressInfo).port}/`;
    const client = new HttpWorker(origin, fetch);
    assert.deepEqual(await client.contracts(), { executionSelection: ['chat'] });
    const j = job(); const chosen = selection({ method: 'api' }); const request = v3(j, chosen);
    assert.deepEqual(await client.execute(request, signer.issue(j, 'execute', request), signal()),
      { status: 'succeeded', stopped: true, output: REPLY, rateLimit: null, execution: { ...chosen, subscriptionLimit: false } });
    assert.deepEqual(credentialEnvs(await seenEnv()), ['ANTHROPIC_API_KEY']);
    // 구독으로 서명한 요청의 방식만 api로 바꿔 보낸다.
    const k = job(); const signed = v3(k, selection());
    const tampered: WorkerRequestV3 = { ...signed, execution: { ...signed.execution, method: 'api' } };
    await assert.rejects(client.execute(tampered, signer.issue(k, 'execute', signed), signal()), /worker_rejected/);
    // 묶음과 다른 revision은 서명이 맞아도 실행 안 됨이다.
    const m = job(); const stale = v3(m, selection({ credentialRevision: 'r6' }));
    assert.deepEqual(await client.execute(stale, signer.issue(m, 'execute', stale), signal()), { status: 'not_run', stopped: true, refusal: 'bundle_mismatch' });
    assert.equal(launcher.specs.length, 1);
    // 옛 요청의 응답은 옛 strict 스키마 그대로다.
    const n = job(); const old = workerRequest(n, [{ from: 'owner', text: '상태' }], { surface: 'speech', earlierPurged: false });
    assert.deepEqual(await client.execute(old, signer.issue(n, 'execute', old), signal()), { status: 'succeeded', stopped: true, output: REPLY, rateLimit: null });
  } finally { await worker.close(); }
  // 옛 작업자(지원 확인 경로 없음)는 빈 목록으로 읽는다.
  const legacy = new HttpWorker('http://127.0.0.1:9/', async () => new Response('', { status: 404 }));
  assert.deepEqual(await legacy.contracts(), { executionSelection: [] });
});
