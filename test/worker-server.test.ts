import { afterEach, before, beforeEach, test } from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync, randomUUID } from 'node:crypto';
import { connect } from 'node:net';
import { once } from 'node:events';
import type { AddressInfo } from 'node:net';
import { chmod, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { gzipSync } from 'node:zlib';
import { Denied, SYSTEM_INSTRUCTIONS, WorkerRejected } from '../src/contracts.js';
import type { Job } from '../src/contracts.js';
import { HttpReviewWorker, reviewWorkerServer } from '../src/review-http.js';
import { REVIEW_INSTRUCTIONS, ReviewTaskSchema, ReviewWorker } from '../src/review-input.js';
import type { ArchiveFetcher, ReviewTask } from '../src/review-input.js';
import { RUN_PREFIX } from '../src/run-control.js';
import { ExecutionSlot, SerialWorker, WorkerSigner, WorkerVerifier, archiveContract } from '../src/worker.js';
import type { CancelRequest, WorkerRequest, WorkerResult } from '../src/worker.js';
import { HttpWorker } from '../src/worker-http.js';
import { startWorker, workerConfig } from '../src/worker-main.js';
import { SpawnLauncher } from './spawn-launcher.js';

// 작업자 서버 통합(t17-wsrv): 한 서버의 네 경로, 공통 자리·실행 제어, unknown 해제, sweep, 종료 drain, 프록시 없음.
// 모델 호출·네트워크 없음. claude·codex 자리에 가짜 실행 파일을 두고 압축본은 주입한 함수로 준다.
const TOKEN = 'sk-ant-oat01-fixture-token-ABCDEFGHIJKLMNOPQRSTUVWXYZ-0123456789';
const MODEL = 'claude-opus-5-5';
const PROXY = 'http://10.43.0.28:3128';
const CHAT = { facts: ['작업자 응답'], hypotheses: [], unknowns: [], checks: [] };
const OUTPUT = { findings: [], open_questions: [], public_summary: '문제를 찾지 못했습니다.' };
const FAKE_CLAUDE = `
const fs = require('node:fs');
const path = require('node:path');
const args = process.argv.slice(2);
if (args[0] === '--version') { process.stdout.write('2.1.308 (Claude Code)\\n'); process.exit(0); }
const mode = JSON.parse(fs.readFileSync(path.join(__dirname, 'mode.json'), 'utf8'));
let input = '';
process.stdin.on('data', d => { input += d; });
process.stdin.on('end', () => {
  const review = input.startsWith('PR 참고 리뷰어');
  const answer = review ? mode.review : mode.chat;
  const emit = e => process.stdout.write(JSON.stringify({ session_id: 'fixture-session', ...e }) + '\\n');
  const model = args[args.indexOf('--model') + 1];
  emit({ type: 'system', subtype: 'init', cwd: process.cwd(), tools: ['StructuredOutput'], mcp_servers: [], model,
    permissionMode: 'dontAsk', apiKeySource: 'none', claude_code_version: '2.1.308', slash_commands: [], output_style: 'default',
    skills: [], plugins: [], agents: [], uuid: 'u0' });
  if (mode.hang && mode.hang === (review ? 'review' : 'chat')) { setInterval(() => {}, 1000); return; }
  emit({ type: 'assistant', parent_tool_use_id: null, uuid: 'u1', message: { model, content: [{ type: 'tool_use', id: 'toolu_out', name: 'StructuredOutput', input: answer }] } });
  emit({ type: 'user', parent_tool_use_id: null, uuid: 'u2', message: { content: [{ type: 'tool_result', tool_use_id: 'toolu_out', content: 'ok' }] } });
  process.stdout.write(JSON.stringify({ type: 'result', subtype: 'success', is_error: false, result: 'x', num_turns: 2,
    structured_output: answer, session_id: 'fixture-session', uuid: 'u3' }) + '\\n', () => process.exit(0));
});
`;
const FAKE_CODEX = `
if (process.argv[2] === '--version') { process.stdout.write('codex-cli 0.163.0\\n'); process.exit(0); }
process.exit(1);
`;

let base: string;
let credentials: string;
let nonceDir: string;
let fakeBin: string;
let codexBin: string;
let codexHome: string;
const keys = generateKeyPairSync('ed25519');
const publicPem = keys.publicKey.export({ type: 'spki', format: 'pem' }).toString();
const signer = new WorkerSigner(keys.privateKey);
const wrap = async (dir: string, name: string, script: string) => {
  await writeFile(join(dir, `${name}.cjs`), script);
  const bin = join(dir, name);
  await writeFile(bin, `#!/bin/sh\nexec "${process.execPath}" "${join(dir, `${name}.cjs`)}" "$@"\n`);
  await chmod(bin, 0o755);
  return bin;
};
const mode = (value: Record<string, unknown> = {}) => writeFile(join(base, 'fake', 'mode.json'), JSON.stringify({ chat: CHAT, review: OUTPUT, ...value }));
before(async () => { await mkdir('.local', { recursive: true }); });
beforeEach(async () => {
  base = resolve(await mkdtemp('.local/worker-server-'));
  credentials = join(base, 'credential'); nonceDir = join(base, 'state', 'nonces'); codexHome = join(base, 'codex-home');
  for (const dir of [credentials, codexHome, join(base, 'fake')]) await mkdir(dir, { recursive: true });
  await writeFile(join(credentials, 'CLAUDE_CODE_OAUTH_TOKEN'), `${TOKEN}\n`);
  await writeFile(join(credentials, 'CODEX_AUTH_JSON'), JSON.stringify({ auth_mode: 'chatgpt', tokens: { refresh_token: 'fixture-refresh-token-abcdefghijklmnopqrstuvwxyz', access_token: 'x', id_token: 'x', account_id: 'x' } }));
  fakeBin = await wrap(join(base, 'fake'), 'claude', FAKE_CLAUDE);
  codexBin = await wrap(join(base, 'fake'), 'codex', FAKE_CODEX);
  await mode();
  // 기동 sweep이 공용 /tmp에서 병렬로 도는 다른 시험 파일의 실행 공간을 지우지 않게 한다.
  process.env.TMPDIR = base;
});
afterEach(async () => { delete process.env.TMPDIR; await rm(base, { recursive: true, force: true }).catch(() => {}); });

const claude = (overrides: Record<string, string | undefined> = {}) => workerConfig({ WORKER_EXECUTOR: 'claude', WORKER_MODEL: MODEL,
  WORKER_CREDENTIAL_DIR: credentials, WORKER_CREDENTIAL_KEY: 'CLAUDE_CODE_OAUTH_TOKEN', WORKER_NONCE_DIR: nonceDir,
  WORKER_CONTROL_PUBLIC_KEY: publicPem, WORKER_EXECUTOR_BIN: fakeBin, HTTPS_PROXY: PROXY, ...overrides });
const codex = () => workerConfig({ WORKER_EXECUTOR: 'codex', WORKER_MODEL: 'cli-default', WORKER_CREDENTIAL_DIR: credentials,
  WORKER_CREDENTIAL_KEY: 'CODEX_AUTH_JSON', CODEX_HOME: codexHome, WORKER_NONCE_DIR: nonceDir, WORKER_CONTROL_PUBLIC_KEY: publicPem,
  WORKER_EXECUTOR_BIN: codexBin, HTTPS_PROXY: PROXY });
const job = (): Job => ({ id: randomUUID(), lease_token: randomUUID() }) as Job;
const chatRequest = (j: Job): WorkerRequest => ({ version: 1, job: j.id, lease: j.lease_token, lane: 'chat', policyRevision: 'fixture-v1',
  instructions: SYSTEM_INSTRUCTIONS, untrusted: [{ text: '상태 알려줘' }], timeoutMs: 60_000, toolCalls: 8 });
const BASE_SHA = 'a'.repeat(40), HEAD_SHA = 'b'.repeat(40);
const reviewTask = (j: Job): ReviewTask => {
  const contract = archiveContract('ukyi-app/homelab-smoke', BASE_SHA, HEAD_SHA);
  return { version: 1, job: j.id, lease: j.lease_token, lane: 'review', repository: 'ukyi-app/homelab-smoke', base: BASE_SHA, head: HEAD_SHA,
    archives: { base: contract.base, head: contract.head },
    changes: [{ path: 'src/app.ts', previousPath: null, status: 'modified', baseType: 'blob', headType: 'blob' }], truncated: false,
    pullRequest: { title: 't', body: 'b' }, limits: { maxFiles: 10, maxFileBytes: 100_000, maxDiffBytes: 100_000, maxArchiveBytes: 1_000_000, maxBodyChars: 1000 },
    policyRevision: 'rp-x', instructions: REVIEW_INSTRUCTIONS, timeoutMs: 60_000 };
};
function tarGz(files: Record<string, string>): Buffer {
  const header = (name: string, size: number) => {
    const h = Buffer.alloc(512);
    h.write(name, 0, 100); h.write('0000644\0', 100); h.write('0000000\0', 108); h.write('0000000\0', 116);
    h.write(`${size.toString(8).padStart(11, '0')}\0`, 124); h.write('00000000000\0', 136); h.write('        ', 148);
    h.write('0', 156); h.write('ustar\0', 257); h.write('00', 263);
    let sum = 0; for (const b of h) sum += b;
    h.write(`${sum.toString(8).padStart(6, '0')}\0 `, 148);
    return h;
  };
  const blocks: Buffer[] = [];
  for (const [path, content] of Object.entries(files)) {
    const data = Buffer.from(content);
    blocks.push(header(`root/${path}`, data.length), data, Buffer.alloc((512 - (data.length % 512)) % 512));
  }
  blocks.push(Buffer.alloc(1024));
  return gzipSync(Buffer.concat(blocks));
}
const archives: ArchiveFetcher = async url => tarGz({ 'src/app.ts': url.endsWith(BASE_SHA) ? 'a\n' : 'b\n' });
const live = () => new AbortController().signal;
const until = async (ready: () => boolean) => {
  for (let i = 0; i < 400_000 && !ready(); i++) await new Promise(resolve => setImmediate(resolve));
  assert.ok(ready(), 'until');
};
const spaces = async () => (await readdir(base)).filter(name => name.startsWith('homelab-'));
const urlOf = (worker: { server: { address(): unknown } }) => `http://127.0.0.1:${(worker.server.address() as AddressInfo).port}`;
const boot = async (options: { fetchArchive?: ArchiveFetcher; launcher?: SpawnLauncher; config?: ReturnType<typeof claude>; log?: (f: Record<string, unknown>) => void } = {}) => {
  const launcher = options.launcher ?? new SpawnLauncher(fakeBin);
  const logs: Record<string, unknown>[] = [];
  const worker = await startWorker(options.config ?? claude(), { port: 0, host: '127.0.0.1', launcher, homes: [],
    fetchArchive: options.fetchArchive ?? archives, log: fields => { logs.push(fields); options.log?.(fields); } });
  const url = urlOf(worker);
  return { worker, url, launcher, logs, chat: new HttpWorker(`${url}/`, fetch), review: new HttpReviewWorker(url, fetch) };
};
const anonymous = (url: string, path: string, method = 'POST') => fetch(`${url}${path}`, { method, ...(method === 'POST' ? { body: '{}' } : {}) });
const cancelBody = (j: Job): CancelRequest => ({ job: j.id, lease: j.lease_token });
const cancelViaChat = (w: Awaited<ReturnType<typeof boot>>, j: Job) => w.chat.cancel(cancelBody(j), signer.issue(j, 'cancel', cancelBody(j)));
const cancelViaReview = (w: Awaited<ReturnType<typeof boot>>, j: Job) => w.review.cancel(cancelBody(j), signer.issue(j, 'cancel', cancelBody(j)));
const runReview = (w: Awaited<ReturnType<typeof boot>>, j: Job) => { const task = reviewTask(j); return w.review.review(task, signer.issue(j, 'execute', task), live()); };
const runChat = (w: Awaited<ReturnType<typeof boot>>, j: Job) => { const request = chatRequest(j); return w.chat.execute(request, signer.issue(j, 'execute', request), live()); };

test('T17 서버 하나: 8080 한 서버가 네 경로를 받고, 인증 없으면 401, GET은 404, 서명한 요청은 대화·리뷰 모두 실행', async () => {
  const w = await boot();
  try {
    assert.equal(w.worker.reviewClosed, undefined);
    for (const path of ['/v1/execute', '/v1/cancel', '/v1/review', '/v1/review/cancel']) {
      const response = await anonymous(w.url, path);
      assert.equal(response.status, 401, path);
      assert.deepEqual(await response.json(), { status: 'rejected', started: false }, path);
      assert.equal((await anonymous(w.url, path, 'GET')).status, 404, path);
    }
    // 게시 서버의 준비 판단: 인증 없는 POST /v1/review가 401이어야 하고 본문 없이도 그렇다.
    assert.equal((await fetch(`${w.url}/v1/review`, { method: 'POST' })).status, 401);
    assert.equal((await fetch(`${w.url}/readyz`)).status, 200);
    assert.deepEqual(await runChat(w, job()), { status: 'succeeded', stopped: true, answer: CHAT });
    const reviewed = await runReview(w, job());
    assert.equal(reviewed.status, 'succeeded');
    assert.deepEqual(reviewed.status === 'succeeded' && reviewed.positions, [{ path: 'src/app.ts', lines: [1] }]);
    assert.equal(w.launcher.specs.length, 2);
    assert.deepEqual(await spaces(), []);
    // 위조는 시작 전 거부.
    const j = job();
    await assert.rejects(w.review.review(reviewTask(j), 'forged.signature', live()), WorkerRejected);
    assert.equal(w.launcher.specs.length, 2);
  } finally { await w.worker.close(); }
});

test('T17 nonce 공유: 쓴 capability는 다른 경로·재기동 뒤에도 거부', async () => {
  const j = job();
  const task = reviewTask(j);
  const execute = signer.issue(j, 'execute', task);
  const cancel = signer.issue(j, 'cancel', cancelBody(j));
  const first = await boot();
  try {
    assert.equal((await first.review.review(task, execute, live())).status, 'succeeded');
    await assert.rejects(first.review.review(task, execute, live()), WorkerRejected);
    assert.deepEqual(await first.review.cancel(cancelBody(j), cancel), { stopped: true });
    // 같은 cancel capability를 대화 쪽 cancel 경로로 다시 쓰면 거부된다.
    assert.deepEqual(await first.chat.cancel(cancelBody(j), cancel), { stopped: false });
  } finally { await first.worker.close(); }
  const second = await boot();
  try {
    await assert.rejects(second.review.review(task, execute, live()), WorkerRejected);
    assert.equal(second.launcher.specs.length, 0);
  } finally { await second.worker.close(); }
});

test('T17 프로필: lanes.review가 false면 리뷰 경로가 404(인증 없어도), 대화 경로는 그대로', async () => {
  const w = await boot({ config: codex() });
  try {
    assert.equal(w.worker.reviewClosed, 'review_unsupported');
    assert.equal((await anonymous(w.url, '/v1/review')).status, 404);
    assert.equal((await anonymous(w.url, '/v1/review/cancel')).status, 404);
    assert.equal((await anonymous(w.url, '/v1/execute')).status, 401);
    assert.equal((await anonymous(w.url, '/v1/cancel')).status, 401);
    // 예상된 닫힘이라 경고를 남기지 않는다.
    assert.deepEqual(w.logs.filter(l => l.event === 'review_lane_closed'), []);
  } finally { await w.worker.close(); }
});

test('T17 proxy 없음: 리뷰만 닫고(404) 사유를 로그에 남기며 대화는 실행, 넓은 프록시도 같다', async () => {
  const cases: [Record<string, string | undefined>, string][] = [[{ HTTPS_PROXY: undefined }, 'review_proxy_missing'],
    [{ HTTPS_PROXY: 'http://user:pass@10.43.0.28:3128' }, 'review_proxy_invalid'], [{ NO_PROXY: '*' }, 'review_proxy_invalid']];
  for (const [overrides, reason] of cases) {
    const w = await boot({ config: claude(overrides) });
    try {
      assert.equal(w.worker.reviewClosed, reason);
      assert.equal((await anonymous(w.url, '/v1/review')).status, 404);
      assert.equal((await anonymous(w.url, '/v1/review/cancel')).status, 404);
      assert.deepEqual(w.logs.filter(l => l.event === 'review_lane_closed'), [{ level: 'warn', event: 'review_lane_closed', reason }]);
      assert.equal((await fetch(`${w.url}/readyz`)).status, 200);
      assert.deepEqual(await runChat(w, job()), { status: 'succeeded', stopped: true, answer: CHAT });
      for (const line of w.logs) assert.ok(!JSON.stringify(line).includes('pass'), '값을 로그에 남기지 않는다');
    } finally { await w.worker.close(); }
  }
});

test('T17 다운로더 주입: 기본값은 받지 못해 failed이고 모델을 부르지 않으며, 주입하면 그 함수를 조건 그대로 부른다', async () => {
  const launcher = new SpawnLauncher(fakeBin);
  const worker = await startWorker(claude(), { port: 0, host: '127.0.0.1', launcher, homes: [] });
  try {
    const j = job(); const task = reviewTask(j);
    assert.deepEqual(await new HttpReviewWorker(urlOf(worker), fetch).review(task, signer.issue(j, 'execute', task), live()),
      { status: 'failed', stopped: true, reason: 'archive_fetch_failed' });
    assert.equal(launcher.specs.length, 0);
  } finally { await worker.close(); }
  const calls: { url: string; init: Parameters<ArchiveFetcher>[1] }[] = [];
  const w = await boot({ fetchArchive: async (url, init) => { calls.push({ url, init }); return archives(url, init); } });
  try {
    const j = job();
    assert.equal((await runReview(w, j)).status, 'succeeded');
    assert.deepEqual(calls.map(c => c.url), [reviewTask(j).archives.base, reviewTask(j).archives.head]);
    assert.equal(calls[0]!.init.credentials, 'omit'); assert.equal(calls[0]!.init.redirect, 'error');
    assert.equal(calls[0]!.init.maxBytes, 1_000_000);
  } finally { await w.worker.close(); }
});

test('T17 직렬: 대화 실행 중 리뷰 거절, 리뷰(모델 단계) 중 대화 거절, 끝나면 다시 받음', async () => {
  await mode({ hang: 'chat' });
  const w = await boot();
  try {
    const a = job();
    const chat = runChat(w, a);
    await until(() => w.launcher.specs.length === 1);
    await assert.rejects(runReview(w, job()), WorkerRejected);
    assert.equal(w.launcher.specs.length, 1);
    assert.deepEqual(await cancelViaChat(w, a), { stopped: true });
    assert.deepEqual(await chat, { status: 'failed', stopped: true });
    await mode({ hang: 'review' });
    const b = job();
    const review = runReview(w, b);
    await until(() => w.launcher.specs.length === 2);
    await assert.rejects(runChat(w, job()), WorkerRejected);
    assert.equal(w.launcher.specs.length, 2);
    assert.deepEqual(await cancelViaReview(w, b), { stopped: true });
    assert.deepEqual(await review, { status: 'failed', stopped: true, reason: 'aborted' });
    await mode();
    assert.equal((await runChat(w, job())).status, 'succeeded');
  } finally { await w.worker.close(); }
});

test('T17 직렬: 리뷰가 모델을 띄우기 전(압축본 받기)에도 대화를 거절하고, 취소하면 모델을 부르지 않음', async () => {
  let entered!: () => void;
  const reached = new Promise<void>(resolve => { entered = resolve; });
  const w = await boot({ fetchArchive: (_url, init) => new Promise<Uint8Array>((_resolve, reject) => {
    entered();
    init.signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true });
  }) });
  try {
    const a = job();
    const review = runReview(w, a);
    await reached;
    await assert.rejects(runChat(w, job()), WorkerRejected);
    assert.equal(w.launcher.specs.length, 0);
    assert.deepEqual(await cancelViaChat(w, a), { stopped: true });
    assert.deepEqual(await review, { status: 'failed', stopped: true, reason: 'archive_fetch_failed' });
    assert.equal(w.launcher.specs.length, 0);
    assert.equal((await runChat(w, job())).status, 'succeeded');
  } finally { await w.worker.close(); }
});

for (const path of ['대화 cancel', '리뷰 cancel'] as const) test(`T17 unknown 해제(${path} 경로): 소멸 확인 전에는 두 레인을 막고, 확인되면 풀리며 실행 공간도 지운다`, async () => {
  const launcher = new SpawnLauncher(fakeBin);
  launcher.left = 1;
  const w = await boot({ launcher });
  const cancel = path === '대화 cancel' ? cancelViaChat : cancelViaReview;
  try {
    const a = job();
    assert.deepEqual(await runReview(w, a), { status: 'unknown', stopped: false });
    assert.equal((await spaces()).filter(name => name.startsWith(RUN_PREFIX.review)).length, 1);
    await assert.rejects(runChat(w, job()), WorkerRejected);
    await assert.rejects(runReview(w, job()), WorkerRejected);
    assert.equal(launcher.specs.length, 1);
    // 작업자가 표식 프로세스를 아직 보면 멈췄다고 답하지 않는다. 모르면(null)도 같다.
    assert.deepEqual(await cancel(w, a), { stopped: false });
    launcher.left = null;
    assert.deepEqual(await cancel(w, a), { stopped: false });
    await assert.rejects(runChat(w, job()), WorkerRejected);
    assert.equal((await spaces()).length, 1);
    launcher.left = 0;
    assert.deepEqual(await cancel(w, a), { stopped: true });
    assert.deepEqual(await spaces(), []);
    // 게시 서버가 응답을 잃어 다시 물어도 같은 답이다.
    assert.deepEqual(await cancel(w, a), { stopped: true });
    assert.equal((await runChat(w, job())).status, 'succeeded');
    assert.equal(launcher.specs.length, 2);
  } finally { await w.worker.close(); }
});

test('T17 unknown 해제: 다른 job·다른 lease의 cancel은 자리를 풀지 않음', async () => {
  const launcher = new SpawnLauncher(fakeBin);
  launcher.left = 1;
  const w = await boot({ launcher });
  try {
    const a = job();
    assert.deepEqual(await runReview(w, a), { status: 'unknown', stopped: false });
    launcher.left = 0;
    const otherLease = { ...a, lease_token: randomUUID() } as Job;
    assert.deepEqual(await cancelViaChat(w, otherLease), { stopped: false });
    assert.deepEqual(await cancelViaChat(w, job()), { stopped: false });
    await assert.rejects(runChat(w, job()), WorkerRejected);
    assert.deepEqual(await cancelViaChat(w, a), { stopped: true });
  } finally { await w.worker.close(); }
});

test('T17 unknown 해제: 대화 unknown도 같은 자리라 리뷰를 막고, 소멸 확인 뒤 풀림', async () => {
  const launcher = new SpawnLauncher(fakeBin);
  launcher.left = 1;
  const w = await boot({ launcher });
  try {
    const a = job();
    assert.deepEqual(await runChat(w, a), { status: 'unknown', stopped: false });
    await assert.rejects(runReview(w, job()), WorkerRejected);
    launcher.left = 0;
    assert.deepEqual(await cancelViaReview(w, a), { stopped: true });
    assert.deepEqual(await spaces(), []);
    assert.equal((await runReview(w, job())).status, 'succeeded');
  } finally { await w.worker.close(); }
});

test('T17 재시작 뒤 unknown: 잡고 있지 않은 job은 표식 프로세스가 없을 때만 멈췄다고 답함', async () => {
  const launcher = new SpawnLauncher(fakeBin);
  const w = await boot({ launcher });
  try {
    for (const left of [1, null]) {
      launcher.left = left;
      assert.deepEqual(await cancelViaChat(w, job()), { stopped: false }, String(left));
    }
    launcher.left = 0;
    assert.deepEqual(await cancelViaChat(w, job()), { stopped: true });
    // 다른 job이 자리를 쥐고 있으면 그 답을 하지 않는다.
    await mode({ hang: 'chat' });
    const running = job();
    const chat = runChat(w, running);
    await until(() => launcher.specs.length === 1);
    assert.deepEqual(await cancelViaChat(w, job()), { stopped: false });
    assert.deepEqual(await cancelViaChat(w, running), { stopped: true });
    await chat;
  } finally { await w.worker.close(); }
});

test('T17 재시작 뒤 unknown: 멈췄다고 답한 job·lease의 늦은 실행 요청은 시작하지 않음', async () => {
  const w = await boot();
  try {
    const a = job(), b = job();
    assert.deepEqual(await cancelViaChat(w, a), { stopped: true });
    assert.deepEqual(await cancelViaReview(w, b), { stopped: true });
    await assert.rejects(runReview(w, a), WorkerRejected);
    await assert.rejects(runChat(w, b), WorkerRejected);
    assert.equal(w.launcher.specs.length, 0);
    // 같은 job이어도 새 lease면 다른 시도다.
    const retried = { id: a.id, lease_token: randomUUID() } as Job;
    assert.equal((await runChat(w, retried)).status, 'succeeded');
  } finally { await w.worker.close(); }
});

test('T17 ExecutionSlot: 소멸 확인 중에 도착한 실행은 자리를 잡지 못하고, 확인 실패면 다시 받음', async () => {
  let answer!: (value: boolean) => void;
  const slot = new ExecutionSlot({ stop: () => new Promise<boolean>(resolve => { answer = resolve; }), sweep: async () => true });
  const stop = async () => true;
  const cancelling = slot.cancel({ job: 'a', lease: 'l' });
  assert.equal(slot.acquire('a', 'l', stop), undefined);
  answer(false);
  assert.deepEqual(await cancelling, { stopped: false });
  const held = slot.acquire('a', 'l', stop)!;
  assert.ok(held);
  slot.release(held);
  const again = slot.cancel({ job: 'a', lease: 'l' });
  answer(true);
  assert.deepEqual(await again, { stopped: true });
  assert.equal(slot.acquire('a', 'l', stop), undefined);
  // 표식 기록은 상한이 있고 가장 오래된 것부터 잊는다.
  for (let i = 0; i < 256; i++) { const pending = slot.cancel({ job: `f${i}`, lease: 'l' }); answer(true); await pending; }
  assert.ok(slot.acquire('a', 'l', stop));
});

test('T17 ExecutionSlot: 겹친 cancel은 정리를 한 번만 하고, 실행 중 취소에는 sweep을 부르지 않음', async () => {
  const sweeps: string[] = [];
  const slot = new ExecutionSlot({ stop: async () => true, sweep: async () => { sweeps.push('sweep'); return true; } });
  let stops = 0;
  const held = slot.acquire('a', 'l', async () => { stops++; return true; })!;
  slot.lock(held);
  assert.deepEqual(await Promise.all([slot.cancel({ job: 'a', lease: 'l' }), slot.cancel({ job: 'a', lease: 'l' })]), [{ stopped: true }, { stopped: true }]);
  assert.equal(stops, 1); assert.deepEqual(sweeps, ['sweep']);
  const running = slot.acquire('b', 'l', async () => true)!;
  assert.ok(running);
  assert.deepEqual(await slot.cancel({ job: 'b', lease: 'l' }), { stopped: true });
  assert.deepEqual(sweeps, ['sweep']);
});

for (const lane of ['리뷰', '대화'] as const) test(`T17 PR #42 리뷰(${lane}): 실행 중 취소 뒤 unknown으로 끝나고 소멸이 확인되면 실행 공간을 지우고 자리를 푼다`, async () => {
  await mode({ hang: lane === '리뷰' ? 'review' : 'chat' });
  const launcher = new SpawnLauncher(fakeBin);
  // 실행 끝에서는 프로세스가 보여 unknown이 되고, 취소의 소멸 확인 때는 사라졌다.
  const seen = [1];
  launcher.survivors = async () => seen.shift() ?? 0;
  const w = await boot({ launcher });
  try {
    const a = job();
    const running: Promise<unknown> = lane === '리뷰' ? runReview(w, a) : runChat(w, a);
    await until(() => launcher.specs.length === 1);
    assert.deepEqual(await (lane === '리뷰' ? cancelViaReview : cancelViaChat)(w, a), { stopped: true });
    assert.deepEqual(await running, { status: 'unknown', stopped: false });
    assert.deepEqual(await spaces(), []);
    assert.equal((await fetch(`${w.url}/readyz`)).status, 200);
    await mode();
    assert.equal((await runChat(w, job())).status, 'succeeded');
  } finally { await w.worker.close(); }
});

test('T17 PR #42 리뷰: 취소 시작 때 잠금 전이어도 리뷰가 unknown이면 소멸 확인 뒤 sweep하고, sweep이 끝나야 자리를 놓음', async () => {
  const calls: string[] = [];
  let finishSweep!: (cleaned: boolean) => void;
  const slot = new ExecutionSlot({ stop: async () => { calls.push('stop'); return true; },
    sweep: () => new Promise<boolean>(resolve => { calls.push('sweep'); finishSweep = resolve; }) });
  let entered!: () => void;
  const reached = new Promise<void>(resolve => { entered = resolve; });
  const worker = new ReviewWorker({ check: async () => {} } as unknown as WorkerVerifier, archives, (_input, signal) => new Promise(resolve => {
    entered();
    signal.addEventListener('abort', () => resolve({ status: 'unknown' }), { once: true });
  }), 5000, slot);
  const j = job();
  const review = worker.review(reviewTask(j), 'c', live());
  await reached;
  const cancelling = worker.cancel(cancelBody(j), 'c');
  assert.deepEqual(await review, { status: 'unknown', stopped: false });
  await until(() => calls.includes('sweep'));
  assert.deepEqual(calls, ['stop', 'sweep']);
  assert.equal(slot.acquire('next', 'l', async () => true), undefined);
  finishSweep(true);
  assert.deepEqual(await cancelling, { stopped: true });
  assert.ok(slot.acquire('next', 'l', async () => true));
});

test('T17 PR #42 리뷰: 취소를 기다리는 사이 자리를 놓은 실행의 늦은 잠금은 다음 실행 공간을 sweep하지 않음', async () => {
  let sweeps = 0;
  const slot = new ExecutionSlot({ stop: async () => true, sweep: async () => { sweeps++; return true; } });
  let answer!: (stopped: boolean) => void;
  const first = slot.acquire('a', 'l', () => new Promise<boolean>(resolve => { answer = resolve; }))!;
  const cancelling = slot.cancel({ job: 'a', lease: 'l' });
  slot.release(first);
  assert.ok(slot.acquire('b', 'l', async () => true));
  slot.lock(first);
  answer(true);
  assert.deepEqual(await cancelling, { stopped: true });
  assert.equal(sweeps, 0);
  assert.equal(slot.acquire('c', 'l', async () => true), undefined);
});

// confirmGone을 호출 순서대로 하나씩 답하게 해 겹친 취소의 순서를 고정한다.
const gatedSlot = () => {
  const answers: ((stopped: boolean) => void)[] = [];
  return { answers, slot: new ExecutionSlot({ stop: () => new Promise<boolean>(resolve => { answers.push(resolve); }), sweep: async () => true }) };
};
const settle = () => new Promise(resolve => setImmediate(resolve));
const noStop = async () => true;
const cancelled = { job: 'a', lease: 'l' };

test('T17 PR #42 리뷰: 확정한 차단 표식은 같은 job·lease 재취소의 일시 실패로 지워지지 않음', async () => {
  const { answers, slot } = gatedSlot();
  const first = slot.cancel(cancelled);
  answers[0]!(true);
  assert.deepEqual(await first, { stopped: true });
  const again = slot.cancel(cancelled);
  answers[1]!(false);
  // 이번 조회는 실패했으니 답은 그대로 false다. 앞서 확정한 차단만 남는다.
  assert.deepEqual(await again, { stopped: false });
  assert.equal(slot.acquire('a', 'l', noStop), undefined);
  // 다른 lease는 다른 시도라 막지 않는다.
  assert.ok(slot.acquire('a', 'other', noStop));
});

for (const [order, late] of [['성공 뒤 실패', [true, false]], ['실패 뒤 성공', [false, true]]] as const) test(`T17 PR #42 리뷰: 겹친 취소가 돌아온 순서(${order})와 무관하게 차단이 남음`, async () => {
  const { answers, slot } = gatedSlot();
  const results = [slot.cancel(cancelled), slot.cancel(cancelled)];
  assert.equal(answers.length, 2);
  answers[0]!(late[0]);
  await settle();
  assert.equal(slot.acquire('a', 'l', noStop), undefined);
  answers[1]!(late[1]);
  assert.deepEqual(await Promise.all(results), [{ stopped: late[0] }, { stopped: late[1] }]);
  assert.equal(slot.acquire('a', 'l', noStop), undefined);
});

test('T17 PR #42 리뷰: 겹친 취소가 모두 실패하면 먼저 실패한 호출은 뒤 호출의 임시 차단을 풀지 않고, 마지막 실패 뒤에만 다시 받음', async () => {
  const { answers, slot } = gatedSlot();
  const results = [slot.cancel(cancelled), slot.cancel(cancelled)];
  answers[0]!(false);
  await settle();
  assert.equal(slot.acquire('a', 'l', noStop), undefined);
  answers[1]!(false);
  assert.deepEqual(await Promise.all(results), [{ stopped: false }, { stopped: false }]);
  assert.ok(slot.acquire('a', 'l', noStop));
});

const BAD_REPOSITORIES = ['../x', './x', 'x/..', 'x/.', '../..', '/x', 'x/', 'a//b', 'a/b/c', '..', 'a/b\n'];
const GOOD_REPOSITORIES = ['ukyi-app/homelab-smoke', 'ukyi-app/.github', 'a.b/c..d', 'a/..b', 'a/b.'];

test('T17 PR #42 리뷰: archiveContract·ReviewTaskSchema는 owner/repo 꼴만 받고 점 세그먼트·빈 세그먼트를 거부', () => {
  const task = reviewTask(job());
  for (const repository of BAD_REPOSITORIES) {
    assert.throws(() => archiveContract(repository, BASE_SHA, HEAD_SHA), Denied, JSON.stringify(repository));
    assert.equal(ReviewTaskSchema.safeParse({ ...task, repository }).success, false, JSON.stringify(repository));
  }
  // .github처럼 점으로 시작하는 실제 저장소 이름은 계속 받는다.
  for (const repository of GOOD_REPOSITORIES) {
    assert.ok(archiveContract(repository, BASE_SHA, HEAD_SHA), repository);
    assert.equal(ReviewTaskSchema.safeParse({ ...task, repository }).success, true, repository);
  }
});

test('T17 PR #42 리뷰: 저장소가 ../x인 리뷰 요청은 압축본을 받기 전에 거부', async () => {
  let fetched = 0;
  const worker = new ReviewWorker({ check: async () => {} } as unknown as WorkerVerifier,
    async url => { fetched++; return archives(url, { credentials: 'omit', redirect: 'error', maxBytes: 1, signal: live() }); },
    async () => ({ status: 'succeeded', output: OUTPUT }), 50);
  await assert.rejects(worker.review({ ...reviewTask(job()), repository: '../x',
    archives: { base: `https://codeload.github.com/../x/tar.gz/${BASE_SHA}`, head: `https://codeload.github.com/../x/tar.gz/${HEAD_SHA}` } }, 'c', live()), WorkerRejected);
  assert.equal(fetched, 0);
});

test('T17 sweep: 기동 때 이전 프로세스의 실행 공간을 지우고 다른 파일은 두며, 못 지우면 readiness와 새 실행을 막음', async t => {
  for (const prefix of Object.values(RUN_PREFIX)) { await mkdir(join(base, `${prefix}old`, 'config'), { recursive: true }); await writeFile(join(base, `${prefix}old`, 'config', 'session.jsonl'), '{}'); }
  const first = await boot();
  try {
    assert.deepEqual(await spaces(), []);
    assert.ok((await readdir(base)).includes('fake'));
    assert.deepEqual(first.logs.filter(l => l.event === 'worker_sweep_failed'), []);
  } finally { await first.worker.close(); }
  if (process.getuid?.() === 0) { t.skip('root는 쓰기 금지 디렉터리도 지운다'); return; }
  const locked = join(base, `${RUN_PREFIX.review}stuck`, 'config');
  await mkdir(locked, { recursive: true }); await writeFile(join(locked, 'session.jsonl'), '{}'); await chmod(locked, 0o500);
  const second = await boot();
  try {
    assert.deepEqual(second.logs.filter(l => l.event === 'worker_sweep_failed'), [{ level: 'error', event: 'worker_sweep_failed' }]);
    assert.equal((await fetch(`${second.url}/readyz`)).status, 503);
    assert.deepEqual(await runChat(second, job()), { status: 'failed', stopped: true });
    assert.deepEqual(await runReview(second, job()), { status: 'failed', stopped: true, reason: 'cleanup_pending' });
    assert.equal(second.launcher.specs.length, 0);
    await chmod(locked, 0o700);
    assert.equal((await fetch(`${second.url}/readyz`)).status, 200);
    assert.equal((await runReview(second, job())).status, 'succeeded');
  } finally { await chmod(locked, 0o700).catch(() => {}); await second.worker.close(); }
});

test('T17 onEvent: 공유 실행 제어의 정리 사건이 리뷰 실행에서도 값 없이 로그에 남음', async t => {
  if (process.getuid?.() === 0) { t.skip('root는 쓰기 금지 디렉터리도 지운다'); return; }
  const fake = await wrap(join(base, 'fake'), 'claude-lock', FAKE_CLAUDE.replace("const emit =", `
    const lockDir = path.join(process.env.CLAUDE_CONFIG_DIR, 'projects', 'locked');
    fs.mkdirSync(lockDir, { recursive: true }); fs.writeFileSync(path.join(lockDir, 'session.jsonl'), '{}');
    fs.writeFileSync(path.join(__dirname, 'locked-path'), lockDir); fs.chmodSync(lockDir, 0o500);
    const emit =`));
  const w = await boot({ config: claude({ WORKER_EXECUTOR_BIN: fake }), launcher: new SpawnLauncher(fake) });
  try {
    assert.deepEqual(await runReview(w, job()), { status: 'failed', stopped: true, reason: 'cleanup_failed' });
    assert.deepEqual(w.logs.filter(l => l.event === 'cleanup_failed'), [{ level: 'error', event: 'cleanup_failed' }]);
    assert.equal((await fetch(`${w.url}/readyz`)).status, 503);
  } finally {
    await chmod(await readFile(join(base, 'fake', 'locked-path'), 'utf8'), 0o700).catch(() => {});
    assert.equal((await fetch(`${w.url}/readyz`)).status, 200);
    assert.deepEqual(w.logs.filter(l => l.event === 'cleanup_recovered'), [{ level: 'info', event: 'cleanup_recovered' }]);
    await w.worker.close();
  }
});

test('T17 위반 사건: 작업자 로그에 run_policy_violation 한 줄이 값 없이 남고 HTTP 응답 사유는 그대로다', async () => {
  const marker = 'value-marker-must-not-log';
  // 첫 실리뷰와 같은 위반: 리뷰 어댑터만 보는 plugins. 대화 어댑터는 이 필드를 보지 않는다.
  const plugins = await wrap(join(base, 'fake'), 'claude-plugins', FAKE_CLAUDE.replace('plugins: []', `plugins: [{ name: '${marker}', path: 'builtin' }]`));
  const first = await boot({ config: claude({ WORKER_EXECUTOR_BIN: plugins }), launcher: new SpawnLauncher(plugins) });
  const a = job();
  try {
    assert.deepEqual(await runReview(first, a), { status: 'failed', stopped: true, reason: 'policy_violation' });
    assert.deepEqual(first.logs.filter(l => l.event === 'run_policy_violation'),
      [{ level: 'warn', event: 'run_policy_violation', lane: 'review', kind: 'plugins_enabled' }]);
    assert.deepEqual(await runChat(first, job()), { status: 'succeeded', stopped: true, answer: CHAT });
    assert.equal(first.logs.filter(l => l.event === 'run_policy_violation').length, 1);
    const written = JSON.stringify(first.logs);
    assert.ok(!written.includes(marker) && !written.includes(a.id));
  } finally { await first.worker.close(); }
  // 대화·리뷰가 함께 보는 위반: 운영 조립(공유 실행 제어)에서 대화 실행도 같은 로그를 낸다.
  const tools = await wrap(join(base, 'fake'), 'claude-tools', FAKE_CLAUDE.replace("tools: ['StructuredOutput']", `tools: ['StructuredOutput', '${marker}']`));
  const second = await boot({ config: claude({ WORKER_EXECUTOR_BIN: tools }), launcher: new SpawnLauncher(tools) });
  const b = job();
  try {
    assert.deepEqual(await runChat(second, b), { status: 'failed', stopped: true });
    assert.deepEqual(second.logs.filter(l => l.event === 'run_policy_violation'),
      [{ level: 'warn', event: 'run_policy_violation', lane: 'chat', kind: 'tools_enabled' }]);
    const written = JSON.stringify(second.logs);
    assert.ok(!written.includes(marker) && !written.includes(b.id));
  } finally { await second.worker.close(); }
});

test('T17 종료 drain: 모델 실행 중 리뷰는 CLI를 멈추고 failed로 답한 뒤 닫힘', async () => {
  await mode({ hang: 'review' });
  const w = await boot();
  const a = job();
  const review = runReview(w, a);
  await until(() => w.launcher.specs.length === 1);
  await w.worker.close();
  assert.deepEqual(await review, { status: 'failed', stopped: true, reason: 'aborted' });
  assert.deepEqual(w.launcher.aborted, [a.id]);
  assert.deepEqual(await spaces(), []);
});

test('T17 종료 drain: 압축본 받는 중인 리뷰도 멈추고 failed로 답하며 모델을 부르지 않음', async () => {
  let entered!: () => void;
  const reached = new Promise<void>(resolve => { entered = resolve; });
  const w = await boot({ fetchArchive: (_url, init) => new Promise<Uint8Array>((_resolve, reject) => {
    entered();
    init.signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true });
  }) });
  const review = runReview(w, job());
  await reached;
  const started = Date.now();
  await w.worker.close();
  assert.deepEqual(await review, { status: 'failed', stopped: true, reason: 'archive_fetch_failed' });
  assert.equal(w.launcher.specs.length, 0);
  // 연결 정리 상한(3초)까지 기다리지 않는다.
  assert.ok(Date.now() - started < 2500);
});

test('T17 종료 drain: 본문 수신 중인 리뷰 요청은 시작하지 않고 거부(started:false), 연결을 닫음', async () => {
  const w = await boot();
  const j = job(); const task = reviewTask(j);
  const body = JSON.stringify(task);
  const socket = connect((w.worker.server.address() as AddressInfo).port, '127.0.0.1');
  await once(socket, 'connect');
  let response = '';
  socket.setEncoding('utf8');
  socket.on('data', chunk => { response += chunk; });
  const ended = once(socket, 'close');
  const received = once(w.worker.server, 'request');
  socket.write(`POST /v1/review HTTP/1.1\r\nHost: worker\r\nContent-Type: application/json\r\n`
    + `Authorization: Capability ${signer.issue(j, 'execute', task)}\r\nContent-Length: ${Buffer.byteLength(body)}\r\n\r\n${body.slice(0, 1)}`);
  await received;
  const closing = w.worker.close();
  socket.write(body.slice(1));
  await closing;
  await ended;
  assert.equal(w.launcher.specs.length, 0);
  assert.match(response, /^HTTP\/1\.1 403 /);
  assert.ok(response.includes(JSON.stringify({ status: 'rejected', started: false })), response);
  assert.match(response, /\r\nConnection: close\r\n/i);
});

test('T17 종료 drain: 서명 확인 중에 종료가 시작된 리뷰는 압축본을 받지 않음', async () => {
  let reached!: () => void;
  let release!: () => void;
  const atConsume = new Promise<void>(resolve => { reached = resolve; });
  const gate = new Promise<void>(resolve => { release = resolve; });
  let fetched = 0;
  const worker = new ReviewWorker(new WorkerVerifier(keys.publicKey, async () => { reached(); await gate; return true; }),
    async url => { fetched++; return archives(url, { credentials: 'omit', redirect: 'error', maxBytes: 1, signal: live() }); },
    async () => ({ status: 'succeeded', output: OUTPUT }), 50);
  const j = job(); const task = reviewTask(j);
  const running = worker.review(task, signer.issue(j, 'execute', task), live());
  await atConsume;
  await worker.shutdown();
  release();
  await assert.rejects(running, /worker_closing/);
  assert.equal(fetched, 0);
});

test('T17 단독 조립 호환: 실행 제어 없는 ReviewWorker·SerialWorker는 기존 답을 유지하고, reviewWorkerServer도 그대로 동작', async () => {
  const verifier = { check: async () => {} } as unknown as WorkerVerifier;
  const worker = new ReviewWorker(verifier, archives, async () => ({ status: 'unknown' }), 50);
  const task = reviewTask(job());
  const request = { job: task.job, lease: task.lease };
  assert.deepEqual(await worker.review(task, 'c', live()), { status: 'unknown', stopped: false });
  assert.deepEqual(await worker.cancel(request, 'c'), { stopped: false });
  await assert.rejects(worker.review(reviewTask(job()), 'c', live()), WorkerRejected);
  const results: WorkerResult[] = [{ status: 'failed', stopped: true }];
  const serial = new SerialWorker(verifier, async () => results.shift()!, async () => true);
  assert.deepEqual(await serial.cancel({ job: randomUUID(), lease: randomUUID() }, 'c'), { stopped: false });
  const server = reviewWorkerServer(worker);
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  try {
    const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    assert.equal((await anonymous(url, '/v1/review')).status, 401);
    assert.equal((await anonymous(url, '/v1/execute')).status, 404);
  } finally { server.close(); }
});
