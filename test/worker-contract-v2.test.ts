import { afterEach, before, beforeEach, test } from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync, randomUUID } from 'node:crypto';
import { chmod, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import type { AddressInfo } from 'node:net';
import { join, resolve } from 'node:path';
import { CHAT_OUTPUT_JSON_SCHEMA, CHAT_REPLY_JSON_SCHEMA } from '../src/chat-lane.js';
import { SYSTEM_INSTRUCTIONS, SYSTEM_INSTRUCTIONS_V2, WorkerRejected } from '../src/contracts.js';
import type { Job } from '../src/contracts.js';
import { WorkerSigner } from '../src/worker.js';
import type { WorkerRequestV1, WorkerRequestV2 } from '../src/worker.js';
import { HttpWorker } from '../src/worker-http.js';
import { startWorker, workerConfig } from '../src/worker-main.js';
import { SpawnLauncher } from './spawn-launcher.js';

// C02 작업자 대화 계약 v2(명세 §4.2, AC-3·AC-4·AC-5·AC-11). 경계는 S2다: 게시 서버 쪽 HttpWorker → 작업자 HTTP →
// 가짜 Claude CLI(고정 stream-json) → 응답. 모델 호출·네트워크 없음.
const TOKEN = 'sk-ant-oat01-fixture-token-ABCDEFGHIJKLMNOPQRSTUVWXYZ-0123456789';
const MODEL = 'claude-opus-5-5';
const V1_ANSWER = { facts: ['작업자 응답'], hypotheses: [], unknowns: [], checks: [] };
const FAKE_CLAUDE = `
const fs = require('node:fs');
const path = require('node:path');
const args = process.argv.slice(2);
if (args[0] === '--version') { process.stdout.write('2.1.308 (Claude Code)\\n'); process.exit(0); }
const mode = JSON.parse(fs.readFileSync(path.join(__dirname, 'mode.json'), 'utf8'));
let input = '';
process.stdin.on('data', d => { input += d; });
process.stdin.on('end', () => {
  const answer = input.startsWith('PR 참고 리뷰어') ? mode.review : mode.chat;
  const emit = e => process.stdout.write(JSON.stringify({ session_id: 'fixture-session', ...e }) + '\\n');
  const model = args[args.indexOf('--model') + 1];
  emit({ type: 'system', subtype: 'init', cwd: process.cwd(), tools: ['StructuredOutput'], mcp_servers: [], model,
    permissionMode: 'dontAsk', apiKeySource: 'none', claude_code_version: '2.1.308', slash_commands: [], output_style: 'default',
    skills: [], plugins: [], agents: [], uuid: 'u0' });
  emit({ type: 'assistant', parent_tool_use_id: null, uuid: 'u1', message: { model, content: [{ type: 'tool_use', id: 'toolu_out', name: 'StructuredOutput', input: answer }] } });
  emit({ type: 'user', parent_tool_use_id: null, uuid: 'u2', message: { content: [{ type: 'tool_result', tool_use_id: 'toolu_out', content: 'ok' }] } });
  process.stdout.write(JSON.stringify({ type: 'result', subtype: 'success', is_error: false, result: 'x', num_turns: 2,
    structured_output: answer, session_id: 'fixture-session', uuid: 'u3' }) + '\\n', () => process.exit(0));
});
`;

let base: string;
let fakeBin: string;
const keys = generateKeyPairSync('ed25519');
const publicPem = keys.publicKey.export({ type: 'spki', format: 'pem' }).toString();
const signer = new WorkerSigner(keys.privateKey);
const mode = (chat: unknown, review: unknown = null) => writeFile(join(base, 'fake', 'mode.json'), JSON.stringify({ chat, review }));
before(async () => { await mkdir('.local', { recursive: true }); });
beforeEach(async () => {
  base = resolve(await mkdtemp('.local/worker-contract-v2-'));
  for (const dir of ['credential', 'fake']) await mkdir(join(base, dir), { recursive: true });
  await writeFile(join(base, 'credential', 'CLAUDE_CODE_OAUTH_TOKEN'), `${TOKEN}\n`);
  await writeFile(join(base, 'fake', 'claude.cjs'), FAKE_CLAUDE);
  fakeBin = join(base, 'fake', 'claude');
  await writeFile(fakeBin, `#!/bin/sh\nexec "${process.execPath}" "${join(base, 'fake', 'claude.cjs')}" "$@"\n`);
  await chmod(fakeBin, 0o755);
  await mode(V1_ANSWER);
  // 기동 sweep이 공용 /tmp에서 병렬로 도는 다른 시험 파일의 실행 공간을 지우지 않게 한다.
  process.env.TMPDIR = base;
});
afterEach(async () => { delete process.env.TMPDIR; await rm(base, { recursive: true, force: true }).catch(() => {}); });

const config = () => workerConfig({ WORKER_EXECUTOR: 'claude', WORKER_MODEL: MODEL, WORKER_CREDENTIAL_DIR: join(base, 'credential'),
  WORKER_CREDENTIAL_KEY: 'CLAUDE_CODE_OAUTH_TOKEN', WORKER_NONCE_DIR: join(base, 'state', 'nonces'),
  WORKER_CONTROL_PUBLIC_KEY: publicPem, WORKER_EXECUTOR_BIN: fakeBin, HTTPS_PROXY: 'http://10.43.0.28:3128' });
const boot = async () => {
  const launcher = new SpawnLauncher(fakeBin);
  const worker = await startWorker(config(), { port: 0, host: '127.0.0.1', launcher, homes: [], log: () => {} });
  const url = `http://127.0.0.1:${(worker.server.address() as AddressInfo).port}`;
  return { worker, url, launcher, chat: new HttpWorker(`${url}/`, fetch) };
};
type Booted = Awaited<ReturnType<typeof boot>>;
const job = (): Job => ({ id: randomUUID(), lease_token: randomUUID() }) as Job;
const v1 = (j: Job, overrides: Partial<WorkerRequestV1> = {}): WorkerRequestV1 => ({ version: 1, job: j.id, lease: j.lease_token,
  lane: 'chat', policyRevision: 'fixture-v1', instructions: SYSTEM_INSTRUCTIONS, untrusted: [{ from: 'owner', text: '상태 알려줘' }],
  timeoutMs: 60_000, toolCalls: 8, ...overrides });
const v2 = (j: Job, overrides: Partial<WorkerRequestV2> = {}): WorkerRequestV2 => ({ version: 2, job: j.id, lease: j.lease_token,
  lane: 'chat', policyRevision: 'fixture-v1', instructions: SYSTEM_INSTRUCTIONS_V2, surface: 'slash', earlierPurged: false,
  untrusted: [{ from: 'owner', text: '상태 알려줘' }], timeoutMs: 60_000, toolCalls: 8, ...overrides });
const send = <R extends WorkerRequestV1 | WorkerRequestV2>(w: Booted, request: R) =>
  w.chat.execute(request, signer.issue({ id: request.job, lease_token: request.lease } as Job, 'execute', request), new AbortController().signal);

test('C02 v2 요청: reply·proposal·ack_only 모양으로 성공하고 한도 칸은 비어 있다(AC-3 S2)', async () => {
  const w = await boot();
  try {
    const outputs = [
      { reply: '배포는 정상이에요. 마지막 동기화는 5분 전이에요.', proposal: null, ack_only: false },
      { reply: '작업 목록을 볼게요.', proposal: { action: 'list', target: null, content: null }, ack_only: false },
      { reply: '', proposal: null, ack_only: true },
    ];
    for (const output of outputs) {
      await mode(output);
      assert.deepEqual(await send(w, v2(job())), { status: 'succeeded', stopped: true, output, rateLimit: null });
    }
    // 실행기에는 v2 지시문과 v2 출력 스키마가 간다.
    const spec = w.launcher.specs.at(-1)!;
    assert.ok(spec.stdin.startsWith(SYSTEM_INSTRUCTIONS_V2));
    assert.equal(spec.args[spec.args.indexOf('--json-schema') + 1], JSON.stringify(CHAT_REPLY_JSON_SCHEMA));
  } finally { await w.worker.close(); }
});

test('C02 v1 서버 + v2 작업자: v1 요청은 지시문·출력 스키마·답 모양이 그대로다(AC-4)', async () => {
  const w = await boot();
  try {
    assert.deepEqual(await send(w, v1(job())), { status: 'succeeded', stopped: true, answer: V1_ANSWER });
    const spec = w.launcher.specs.at(-1)!;
    assert.ok(spec.stdin.startsWith(SYSTEM_INSTRUCTIONS));
    assert.equal(spec.args[spec.args.indexOf('--json-schema') + 1], JSON.stringify(CHAT_OUTPUT_JSON_SCHEMA));
    // v1 요청에 v2 답 모양이 오면 성공이 아니다.
    await mode({ reply: '안녕하세요', proposal: null, ack_only: false });
    assert.deepEqual(await send(w, v1(job())), { status: 'failed', stopped: true });
  } finally { await w.worker.close(); }
});

void WorkerRejected;
