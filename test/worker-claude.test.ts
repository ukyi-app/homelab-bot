import { afterEach, before, beforeEach, test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { generateKeyPairSync, randomUUID } from 'node:crypto';
import { chmod, mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises';
import type { AddressInfo } from 'node:net';
import { join, resolve } from 'node:path';
import { CHAT_OUTPUT_JSON_SCHEMA, ChatLane, chatDeadline } from '../src/chat-lane.js';
import type { ChatLaneOptions } from '../src/chat-lane.js';
import { Denied, SYSTEM_INSTRUCTIONS } from '../src/contracts.js';
import type { Job } from '../src/contracts.js';
import { StaticEnvCredential } from '../src/credentials.js';
import type { WorkerCredential } from '../src/credentials.js';
import { CLAUDE_CHAT_CAPABILITIES, CLAUDE_FIXED_ENV, CLAUDE_FORBIDDEN_FLAGS, ClaudeChatAdapter, claudeArgs,
  interpretClaudeStream } from '../src/executor-claude.js';
import type { AdapterRun, ChatRun } from '../src/executor.js';
import { PROFILES, executorVersion, selectProfile } from '../src/executor-profiles.js';
import { SerialWorker, WorkerSigner, WorkerVerifier } from '../src/worker.js';
import type { WorkerRequest } from '../src/worker.js';
import { HttpWorker } from '../src/worker-http.js';
import { WORKER_ENV, startWorker, workerConfig } from '../src/worker-main.js';
import { WorkerStartError } from '../src/worker-state.js';
import { SpawnLauncher } from './spawn-launcher.js';

// Claude 프로필(claude-subscription: Claude Code CLI 2.1.308, 구독 장기 토큰, env-static 자격, D-14 변경 사용자 2026-10-30).
// 모델 호출·로그인 없음: claude 자리에 같은 인자·stdin·env로 도는 가짜 실행 파일을 둔다. 가짜가 내는 stream-json 모양은
// 고정 바이너리에 든 SDK 메시지 스키마와 공식 headless 문서로 합성했다(실제 출력 녹음이 아니다, S12에서 대조).
// 토큰은 합성 값이다. 개인 ~/.claude*는 쓰지 않고 저장소 .local/ 아래 임시 디렉터리만 쓴다.
const TOKEN = 'sk-ant-oat01-fixture-token-ABCDEFGHIJKLMNOPQRSTUVWXYZ-0123456789';
const MODEL = 'claude-opus-5-5';
const ANSWER = { facts: ['작업자 응답'], hypotheses: [], unknowns: ['실측 전'], checks: [] };
// 가짜 claude. 모드는 실행 파일 옆 mode.json으로 받는다(자식 env는 허용 목록이라 env로 넘길 수 없다).
const FAKE_CLAUDE = `
const fs = require('node:fs');
const path = require('node:path');
const args = process.argv.slice(2);
if (args[0] === '--version') {
  fs.writeFileSync(path.join(__dirname, 'version-seen.json'), JSON.stringify({ args, env: process.env }));
  process.stdout.write(fs.readFileSync(path.join(__dirname, 'version.txt'), 'utf8')); process.exit(0);
}
const mode = JSON.parse(fs.readFileSync(path.join(__dirname, 'mode.json'), 'utf8'));
let input = '';
process.stdin.on('data', d => { input += d; });
process.stdin.on('end', () => {
  // 실행 디렉터리(작업 공간의 부모) 아래 파일을 모두 읽어 둔다. 자격이 파일에 있는지 시험이 본다.
  const root = path.dirname(process.cwd());
  const files = {};
  const walk = dir => { for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name); if (e.isDirectory()) walk(p); else files[path.relative(root, p)] = fs.readFileSync(p, 'utf8'); } };
  walk(root);
  // --no-session-persistence를 무시하고 세션·설정·임시 파일을 남기는 경우를 흉내 낸다.
  if (mode.session) {
    const dir = path.join(process.env.CLAUDE_CONFIG_DIR, 'projects', 'workspace');
    fs.mkdirSync(dir, { recursive: true }); fs.writeFileSync(path.join(dir, 'session.jsonl'), '{}\\n');
    fs.writeFileSync(path.join(process.env.HOME, '.claude.json'), '{}');
    fs.writeFileSync(path.join(process.env.TMPDIR, 'scratch'), 'x');
  }
  fs.writeFileSync(path.join(__dirname, 'seen.json'), JSON.stringify({ args, cwd: process.cwd(), entries: fs.readdirSync('.'),
    env: process.env, input, files, root }));
  const emit = e => process.stdout.write(JSON.stringify({ session_id: 'fixture-session', ...e }) + '\\n');
  const model = args[args.indexOf('--model') + 1];
  emit({ type: 'system', subtype: 'init', cwd: process.cwd(), tools: ['StructuredOutput'], mcp_servers: [], model,
    permissionMode: 'dontAsk', apiKeySource: 'none', claude_code_version: '2.1.308', slash_commands: [], output_style: 'default',
    skills: [], plugins: [], uuid: 'u0', ...(mode.init || {}) });
  if (mode.kind === 'hang') { setInterval(() => {}, 1000); return; }
  if (mode.kind === 'tool') {
    emit({ type: 'assistant', parent_tool_use_id: null, uuid: 'u1',
      message: { content: [{ type: 'tool_use', id: 'toolu_bash', name: 'Bash', input: { command: 'cat /etc/hostname' } }] } });
    setInterval(() => {}, 1000); return;
  }
  if (mode.kind === 'error') {
    emit({ type: 'assistant', parent_tool_use_id: null, uuid: 'u1', error: mode.error, api_error_status: mode.status,
      message: { content: [{ type: 'text', text: 'API Error' }] } });
    emit({ type: 'result', subtype: mode.subtype || 'success', is_error: true, api_error_status: mode.status, result: 'API Error',
      num_turns: 1, uuid: 'u2' });
    process.stdout.write('', () => process.exit(1)); return;
  }
  emit({ type: 'assistant', parent_tool_use_id: null, uuid: 'u1', message: { content: [{ type: 'text', text: '모델 본문' },
    { type: 'tool_use', id: 'toolu_out', name: 'StructuredOutput', input: mode.answer }] } });
  emit({ type: 'user', parent_tool_use_id: null, uuid: 'u2',
    message: { content: [{ type: 'tool_result', tool_use_id: 'toolu_out', content: 'Structured output provided successfully' }] } });
  process.stdout.write(JSON.stringify({ type: 'result', subtype: 'success', is_error: false, result: '모델 본문', num_turns: 2,
    structured_output: mode.answer, session_id: 'fixture-session', uuid: 'u3' }) + '\\n', () => process.exit(mode.exit || 0));
});
`;

let base: string;
let tokenDir: string;
let nonceDir: string;
let fakeDir: string;
let fakeBin: string;
const keys = generateKeyPairSync('ed25519');
const publicPem = keys.publicKey.export({ type: 'spki', format: 'pem' }).toString();
before(async () => { await mkdir('.local', { recursive: true }); });
beforeEach(async () => {
  base = resolve(await mkdtemp('.local/worker-claude-'));
  tokenDir = join(base, 'credential'); nonceDir = join(base, 'state', 'nonces'); fakeDir = join(base, 'fake');
  for (const dir of [tokenDir, fakeDir]) await mkdir(dir, { recursive: true });
  // Secret 저장소가 붙이는 끝 줄바꿈까지 흉내 낸다.
  await writeFile(join(tokenDir, 'CLAUDE_CODE_OAUTH_TOKEN'), `${TOKEN}\n`);
  await writeFile(join(fakeDir, 'claude.cjs'), FAKE_CLAUDE);
  // node 경로를 박은 셸 래퍼. 자식 env의 PATH(/usr/local/bin:/usr/bin:/bin)에 node가 없어도 돈다.
  fakeBin = join(fakeDir, 'claude');
  await writeFile(fakeBin, `#!/bin/sh\nexec "${process.execPath}" "${join(fakeDir, 'claude.cjs')}" "$@"\n`);
  await chmod(fakeBin, 0o755);
  await writeFile(join(fakeDir, 'version.txt'), '2.1.308 (Claude Code)\n');
  await mode({ kind: 'answer', answer: ANSWER });
});
// .local은 다른 시험 파일도 함께 쓴다. 이 시험이 만든 디렉터리만 지운다.
afterEach(async () => { await rm(base, { recursive: true, force: true }).catch(() => {}); });
const mode = (value: unknown) => writeFile(join(fakeDir, 'mode.json'), JSON.stringify(value));
interface Seen { args: string[]; cwd: string; entries: string[]; env: Record<string, string>; input: string; files: Record<string, string>; root: string }
const seen = async () => JSON.parse(await readFile(join(fakeDir, 'seen.json'), 'utf8')) as Seen;
const job = (): Job => ({ id: randomUUID(), lease_token: randomUUID() }) as Job;
const chatRequest = (j: Job, overrides: Partial<WorkerRequest> = {}): WorkerRequest => ({ version: 1, job: j.id, lease: j.lease_token,
  lane: 'chat', policyRevision: 'fixture-v1', instructions: SYSTEM_INSTRUCTIONS, untrusted: [{ text: '상태 알려줘' }],
  timeoutMs: 60_000, toolCalls: 8, ...overrides });
const env = (overrides: Record<string, string | undefined> = {}) => ({ WORKER_EXECUTOR: 'claude', WORKER_MODEL: MODEL,
  WORKER_CREDENTIAL_DIR: tokenDir, WORKER_CREDENTIAL_KEY: 'CLAUDE_CODE_OAUTH_TOKEN', WORKER_NONCE_DIR: nonceDir,
  WORKER_CONTROL_PUBLIC_KEY: publicPem, WORKER_EXECUTOR_BIN: fakeBin, ...overrides });
const tokenFile = () => join(tokenDir, 'CLAUDE_CODE_OAUTH_TOKEN');
const credential = (homes: string[] = []) => new StaticEnvCredential(tokenFile(), homes);
const claudeLane = (launcher: SpawnLauncher, options: Partial<ChatLaneOptions> = {}, cred: WorkerCredential = credential(),
  adapter = new ClaudeChatAdapter('subscription-token')) => new ChatLane(adapter, cred, launcher, { model: MODEL, tmp: base, ...options });
const runs = async () => (await readdir(base)).filter(name => name.startsWith('homelab-chat-'));
const code = async (promise: Promise<unknown>) => {
  try { await promise; return 'ok'; } catch (error) { return error instanceof WorkerStartError ? error.code : `other:${String(error)}`; }
};
const configCode = (vars: Record<string, string | undefined>) => code(Promise.resolve().then(() => workerConfig(env(vars))));
const PROXY = { https: 'http://10.43.0.28:3128', noProxy: '127.0.0.1,localhost' };
// 실행이 뜨기를 기다린다. 가짜 시계를 켠 시험에서도 쓰도록 시간이 아니라 횟수로 끊는다(회귀 때 멈추지 않고 실패).
const until = async (check: () => boolean) => {
  for (let i = 0; !check(); i++) {
    if (i > 200_000) throw new Error('timed out waiting');
    await new Promise(resolve => setImmediate(resolve));
  }
};

test('CLD-01 프로필: claude + CLAUDE_CODE_OAUTH_TOKEN + 전체 모델 ID만 받고, 모르는 실행기·자격·모델 조합은 기동 실패', async () => {
  const profile = selectProfile('claude', 'CLAUDE_CODE_OAUTH_TOKEN', MODEL);
  assert.equal(profile.id, 'claude-subscription');
  assert.equal(profile.bin, '/usr/local/bin/claude');
  assert.deepEqual(profile.capabilities, CLAUDE_CHAT_CAPABILITIES);
  // 능력표: 대화 레인만, 도구 없음, 세션 기록 없음, 모델 고정, 정적 자격, 가짜 CLI 근거.
  assert.deepEqual({ ...profile.capabilities, lanes: { ...profile.capabilities.lanes } }, { executor: 'claude', cliVersion: '2.1.308',
    lanes: { chat: true, task: false }, structuredOutput: 'native-schema', tools: 'none', sessionPersistence: 'off', modelPinned: true,
    credential: 'env-static', evidence: 'fake-cli' });
  const config = workerConfig(env());
  assert.equal(config.profile.id, 'claude-subscription');
  assert.equal(config.model, MODEL);
  assert.equal(config.credentialFile, tokenFile());
  // Claude 프로필은 CODEX_HOME이 필요 없다.
  assert.equal(config.codexHome, undefined);
  assert.equal(workerConfig(env({ WORKER_EXECUTOR_BIN: undefined })).executorBin, '/usr/local/bin/claude');
  assert.equal(await configCode({}), 'ok');
  const cases: [Record<string, string | undefined>, string][] = [
    [{ WORKER_EXECUTOR: 'opencode' }, 'config_invalid:WORKER_EXECUTOR'],
    [{ WORKER_EXECUTOR: 'Claude' }, 'config_invalid:WORKER_EXECUTOR'],
    // API 키는 사용자가 고른 인증이 아니고 검증한 프로필도 없다. 구독 토큰으로 몰래 바꾸지 않는다.
    [{ WORKER_CREDENTIAL_KEY: 'ANTHROPIC_API_KEY' }, 'profile_unsupported'],
    [{ WORKER_CREDENTIAL_KEY: 'CODEX_AUTH_JSON' }, 'profile_unsupported'],
    [{ WORKER_EXECUTOR: 'codex', WORKER_MODEL: 'cli-default' }, 'profile_unsupported'],
    [{ WORKER_CREDENTIAL_KEY: 'claude_code_oauth_token' }, 'config_invalid:WORKER_CREDENTIAL_KEY'],
    [{ WORKER_CREDENTIAL_KEY: '../CLAUDE_CODE_OAUTH_TOKEN' }, 'config_invalid:WORKER_CREDENTIAL_KEY'],
    // 별칭·접미어·다른 실행기의 모델은 받지 않는다(실행마다 init 이벤트의 모델과 그대로 대조하기 위해).
    [{ WORKER_MODEL: 'opus' }, 'config_invalid:WORKER_MODEL'],
    [{ WORKER_MODEL: 'claude-opus-5-5[1m]' }, 'config_invalid:WORKER_MODEL'],
    [{ WORKER_MODEL: 'claude-opus-5-5 --fallback-model x' }, 'config_invalid:WORKER_MODEL'],
    [{ WORKER_MODEL: 'cli-default' }, 'config_invalid:WORKER_MODEL'],
    [{ WORKER_MODEL: 'gpt-6.1-sol' }, 'config_invalid:WORKER_MODEL'],
    [{ WORKER_MODEL: '  ' }, 'config_missing:WORKER_MODEL'],
    [{ WORKER_CREDENTIAL_DIR: 'relative' }, 'config_invalid:WORKER_CREDENTIAL_DIR'],
  ];
  for (const [vars, expected] of cases) assert.equal(await configCode(vars), expected, JSON.stringify(vars));
  assert.equal(await code(Promise.resolve().then(() => workerConfig({}))), `config_missing:${WORKER_ENV.join(',')}`);
  // 다른 모델 ID로의 전환은 설정만 바꾸면 된다(같은 프로필).
  assert.equal(workerConfig(env({ WORKER_MODEL: 'claude-sonnet-5-5' })).profile.id, 'claude-subscription');
  // 모든 프로필의 능력표가 프로필의 실행기·자격 방식과 맞고, 작업 레인은 아직 어느 실행기에도 없다.
  for (const p of PROFILES) {
    assert.equal(p.capabilities.executor, p.executor, p.id);
    assert.equal(p.capabilities.credential, p.credential, p.id);
    assert.equal(p.capabilities.lanes.chat, true, p.id);
    assert.equal(p.capabilities.lanes.task, false, p.id);
  }
});

test('CLD-02 argv: -p·stream-json·구조화 스키마·모델 고정·도구 끔·MCP 없음·세션 없음·dontAsk·safe-mode, 금지 플래그·--bare 없음', () => {
  const args = claudeArgs(MODEL, CHAT_OUTPUT_JSON_SCHEMA);
  assert.deepEqual(args, ['-p', '--output-format', 'stream-json', '--verbose', '--json-schema', JSON.stringify(CHAT_OUTPUT_JSON_SCHEMA),
    '--model', MODEL, '--tools', '', '--strict-mcp-config', '--mcp-config', '{"mcpServers":{}}', '--no-session-persistence',
    '--permission-mode', 'dontAsk', '--disable-slash-commands', '--safe-mode']);
  for (const flag of CLAUDE_FORBIDDEN_FLAGS) assert.ok(!args.includes(flag), flag);
  // 위치 인자(프롬프트)가 없다. 프롬프트는 stdin이다.
  assert.equal(args.indexOf('--tools') + 1, args.indexOf(''));
});

test('CLD-03 대화 실행: 빈 작업 공간, stdin 프롬프트, 자식 env 허용 목록, 토큰은 CLAUDE_CODE_OAUTH_TOKEN에만(argv·다른 env·파일·stdin 없음)', async () => {
  const launcher = new SpawnLauncher(fakeBin);
  const lane = claudeLane(launcher, { proxy: PROXY });
  // 작업자 env에 다른 자격·같은 토큰이 있어도 자식에게 넘어가지 않는다.
  const secretEnv = { CLAUDE_CODE_OAUTH_TOKEN: 'worker-env-token-should-not-pass-0123456789', ANTHROPIC_API_KEY: 'sk-ant-api03-fixture-0123456789',
    DISCORD_BOT_TOKEN: 'fixture-discord', CODEX_AUTH_JSON: '{"tokens":{}}', WORKER_CONTROL_PUBLIC_KEY: publicPem, CLAUDE_CONFIG_DIR: '/home/someone/.claude' };
  const saved = { ...process.env };
  Object.assign(process.env, secretEnv);
  let result;
  try { result = await lane.run(chatRequest(job()), new AbortController().signal); }
  finally { for (const name of Object.keys(secretEnv)) { if (saved[name] === undefined) delete process.env[name]; else process.env[name] = saved[name]; } }
  assert.deepEqual(result, { status: 'succeeded', stopped: true, answer: ANSWER });
  const s = await seen();
  assert.deepEqual(s.args, claudeArgs(MODEL, CHAT_OUTPUT_JSON_SCHEMA));
  const names = Object.keys(s.env).filter(name => !['PWD', 'SHLVL', '_'].includes(name)).sort();
  assert.deepEqual(names, ['CLAUDE_CODE_OAUTH_TOKEN', 'CLAUDE_CONFIG_DIR', 'HOME', 'HOMELAB_WORKER_TASK', 'HTTPS_PROXY', 'LANG',
    'NO_PROXY', 'PATH', 'TMPDIR', ...Object.keys(CLAUDE_FIXED_ENV)].sort());
  for (const [name, value] of Object.entries(CLAUDE_FIXED_ENV)) assert.equal(s.env[name], value, name);
  // 토큰은 Secret 파일 값(끝 줄바꿈 제거)이고, 작업자 env의 같은 이름 값이 아니다.
  assert.equal(s.env.CLAUDE_CODE_OAUTH_TOKEN, TOKEN);
  assert.equal(s.env.ANTHROPIC_API_KEY, undefined);
  for (const [name, value] of Object.entries(s.env)) if (name !== 'CLAUDE_CODE_OAUTH_TOKEN') assert.ok(!value.includes(TOKEN), name);
  assert.ok(!s.args.some(arg => arg.includes(TOKEN)));
  assert.ok(!s.input.includes(TOKEN));
  // 실행 전 디렉터리에 어댑터가 쓴 파일이 없다(스키마는 argv, 설정 파일 없음). 있었다면 토큰이 없어야 한다.
  assert.deepEqual(Object.keys(s.files), []);
  // HOME·CLAUDE_CONFIG_DIR·TMPDIR·cwd는 모두 이 실행의 임시 디렉터리 안이고 서로 다르다.
  for (const name of ['HOME', 'CLAUDE_CONFIG_DIR', 'TMPDIR'] as const) assert.ok(s.env[name]!.startsWith(`${s.root}/`), name);
  assert.equal(new Set([s.env.HOME, s.env.CLAUDE_CONFIG_DIR, s.env.TMPDIR, s.cwd]).size, 4);
  assert.deepEqual(s.entries, []);
  assert.ok(s.input.startsWith(SYSTEM_INSTRUCTIONS) && s.input.includes('상태 알려줘'));
  assert.ok(!s.args.some(arg => arg.includes('상태 알려줘')));
  // 실행이 끝나면 실행 디렉터리를 지운다.
  assert.deepEqual(await runs(), []);
});

test('CLD-04 세션 파일 없음: CLI가 플래그를 무시하고 CLAUDE_CONFIG_DIR·HOME·TMPDIR에 써도 실행 뒤 남지 않고, 영속 공간에도 쓰지 않음', async () => {
  await mode({ kind: 'answer', answer: ANSWER, session: true });
  await mkdir(nonceDir, { recursive: true });
  const before = (await readdir(base)).sort();
  const lane = claudeLane(new SpawnLauncher(fakeBin));
  assert.equal((await lane.run(chatRequest(job()), new AbortController().signal)).status, 'succeeded');
  assert.ok((await seen()).args.includes('--no-session-persistence'));
  assert.deepEqual(await runs(), []);
  assert.deepEqual((await readdir(base)).sort(), before);
  assert.deepEqual(await readdir(nonceDir), []);
  assert.deepEqual(await readdir(tokenDir), ['CLAUDE_CODE_OAUTH_TOKEN']);
});

test('CLD-05 결과 해석: structured_output만 답, 한도·인증은 구조화 오류 종류·상태로만, 본문 문구로는 대기시키지 않음', () => {
  const expect = { model: MODEL, apiKeySource: 'none', version: '2.1.308' };
  const init = { type: 'system', subtype: 'init', tools: ['StructuredOutput'], mcp_servers: [], model: MODEL, apiKeySource: 'none',
    claude_code_version: '2.1.308' };
  const ok = { code: 0, signal: null };
  const bad = { code: 1, signal: null };
  const line = (value: unknown) => JSON.stringify(value);
  const assistantError = (error: string | undefined, status?: number) => line({ type: 'assistant', error, api_error_status: status,
    message: { content: [{ type: 'text', text: 'API Error: 401 rate limit' }] } });
  const errorResult = (status?: number, subtype = 'success') => line({ type: 'result', subtype, is_error: true, api_error_status: status, result: 'x' });
  const success = (value: unknown) => line({ type: 'result', subtype: 'success', is_error: false, result: '429 Too Many Requests', structured_output: value });
  const cases: [string[], { code: number | null; signal: string | null }, string, string?][] = [
    [[line(init), success(ANSWER)], ok, 'output'],
    // 모델 답에 "401"·"rate limit"·"Unauthorized"가 있어도 성공 답이다.
    [[line(init), success({ ...ANSWER, facts: ['401 Unauthorized, rate limit 429'] })], ok, 'output'],
    [[line(init), assistantError('rate_limit', 429), errorResult(429)], bad, 'limited'],
    [[line(init), assistantError('billing_error', 402), errorResult(402)], bad, 'limited'],
    [[line(init), assistantError('authentication_failed', 401), errorResult(401)], bad, 'auth_expired'],
    [[line(init), assistantError('oauth_org_not_allowed', 403), errorResult(403)], bad, 'auth_expired'],
    [[line(init), assistantError('account_on_hold'), errorResult()], bad, 'auth_expired'],
    // 종류가 없거나 unknown이면 HTTP 상태로 고른다.
    [[line(init), errorResult(429)], bad, 'limited'],
    [[line(init), assistantError('unknown', 401), errorResult(401)], bad, 'auth_expired'],
    // 과부하·서버 오류·요청 오류는 대기가 아니라 실패다(상태가 429여도 종류가 우선).
    [[line(init), assistantError('overloaded', 529), errorResult(529)], bad, 'failed', 'api_error'],
    [[line(init), assistantError('server_error', 429), errorResult(429)], bad, 'failed', 'api_error'],
    // 결과 없이 끝났어도 마지막 API 오류가 인증이면 인증 대기다.
    [[line(init), assistantError('authentication_failed', 401)], bad, 'auth_expired'],
    // 중간 재시도 뒤 성공한 실행은 성공이다.
    [[line(init), line({ type: 'system', subtype: 'api_retry', error: 'rate_limit', error_status: 429 }), success(ANSWER)], ok, 'output'],
    [[line(init), line({ type: 'result', subtype: 'error_max_structured_output_retries', is_error: true, errors: [] })], bad, 'failed', 'execution_error'],
    [[line(init), line({ type: 'result', subtype: 'success', is_error: false, result: '{}' })], ok, 'failed', 'no_structured_output'],
    [[line(init), line({ type: 'result', subtype: 'success', result: '{}', structured_output: ANSWER })], ok, 'failed', 'api_error'],
    [[line(init), success(ANSWER)], { code: 2, signal: null }, 'failed', 'exit_nonzero'],
    [[line(init), success(ANSWER), success(ANSWER)], ok, 'failed', 'invalid_stream'],
    [[line(init), line(init), success(ANSWER)], ok, 'failed', 'invalid_stream'],
    [[success(ANSWER)], ok, 'failed', 'invalid_stream'],
    [[line(init), 'not json', success(ANSWER)], ok, 'failed', 'invalid_stream'],
    [[line(init)], ok, 'failed', 'no_result'],
    // init 정책: 작업 도구·MCP·다른 모델·API 키 출처·다른 버전이면 답이 있어도 실패다.
    [[line({ ...init, tools: ['Bash', 'StructuredOutput'] }), success(ANSWER)], ok, 'failed', 'policy_violation'],
    [[line({ ...init, tools: undefined }), success(ANSWER)], ok, 'failed', 'policy_violation'],
    [[line({ ...init, mcp_servers: [{ name: 'x', status: 'connected' }] }), success(ANSWER)], ok, 'failed', 'policy_violation'],
    [[line({ ...init, model: 'claude-sonnet-5-5' }), success(ANSWER)], ok, 'failed', 'policy_violation'],
    [[line({ ...init, apiKeySource: 'ANTHROPIC_API_KEY' }), success(ANSWER)], ok, 'failed', 'policy_violation'],
    [[line({ ...init, claude_code_version: '2.1.314' }), success(ANSWER)], ok, 'failed', 'policy_violation'],
  ];
  for (const [lines, exit, kind, reason] of cases) {
    const outcome = interpretClaudeStream(lines, exit, expect);
    assert.equal(outcome.kind, kind, lines.join(' | '));
    if (reason) assert.equal(outcome.kind === 'failed' && outcome.reason, reason, lines.join(' | '));
  }
  assert.deepEqual(interpretClaudeStream([line(init), success(ANSWER)], ok, expect), { kind: 'output', value: ANSWER });
  // 도구 없이 구조화 출력만 낸 init(tools [])도 받는다.
  assert.equal(interpretClaudeStream([line({ ...init, tools: [] }), success(ANSWER)], ok, expect).kind, 'output');
});

test('CLD-06 실제 실행: 한도 → limited, 인증 만료 → auth_expired, 과부하 → failed, 스키마 밖 답 → failed, 작업 레인은 띄우지 않음', async () => {
  const launcher = new SpawnLauncher(fakeBin);
  const lane = claudeLane(launcher);
  assert.deepEqual(await lane.run(chatRequest(job(), { lane: 'task' }), new AbortController().signal), { status: 'failed', stopped: true });
  assert.equal(launcher.specs.length, 0);
  const cases: [unknown, string][] = [
    [{ kind: 'error', error: 'rate_limit', status: 429 }, 'limited'],
    [{ kind: 'error', error: 'authentication_failed', status: 401 }, 'auth_expired'],
    [{ kind: 'error', error: 'overloaded', status: 529 }, 'failed'],
    [{ kind: 'answer', answer: { ...ANSWER, extra: 'x' } }, 'failed'],
    [{ kind: 'answer', answer: { facts: 'x', hypotheses: [], unknowns: [], checks: [] } }, 'failed'],
    // 답에 자격 값이 섞이면 게시하지 않는다(반사 검사, best-effort).
    [{ kind: 'answer', answer: { ...ANSWER, facts: [`토큰은 ${TOKEN}`] } }, 'failed'],
  ];
  for (const [value, expected] of cases) {
    await mode(value);
    assert.equal((await lane.run(chatRequest(job()), new AbortController().signal)).status, expected, JSON.stringify(value));
  }
  assert.deepEqual(await runs(), []);
});

test('CLD-07 정책 위반은 기한을 기다리지 않고 바로 멈춤: init에 작업 도구·MCP·다른 모델, 실행 중 도구 호출', { timeout: 20_000 }, async () => {
  const cases: unknown[] = [
    { kind: 'hang', init: { tools: ['Bash', 'Read', 'StructuredOutput'] } },
    { kind: 'hang', init: { mcp_servers: [{ name: 'claude.ai Gmail', status: 'connected' }] } },
    { kind: 'hang', init: { model: 'claude-haiku-5-5' } },
    { kind: 'hang', init: { apiKeySource: 'ANTHROPIC_API_KEY' } },
    { kind: 'tool' },
  ];
  for (const value of cases) {
    await mode(value);
    const launcher = new SpawnLauncher(fakeBin);
    const lane = claudeLane(launcher);
    const j = job();
    // 기한 60초(작업자 55초)보다 훨씬 먼저 끝나야 한다. 이 시험의 상한은 20초다.
    assert.deepEqual(await lane.run(chatRequest(j), new AbortController().signal), { status: 'failed', stopped: true }, JSON.stringify(value));
    assert.deepEqual(launcher.aborted, [j.id], JSON.stringify(value));
  }
});

test('CLD-08 기한은 게시 서버보다 먼저 멈춰 failed, 취소는 정리 확인 뒤 stopped, 남은 프로세스를 모르면 unknown·새 실행 거부', { timeout: 30_000 }, async t => {
  assert.equal(chatDeadline(60_000), 55_000);
  await mode({ kind: 'hang' });
  const launcher = new SpawnLauncher(fakeBin);
  const lane = claudeLane(launcher);
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const timed = lane.run(chatRequest(job()), new AbortController().signal);
  await until(() => launcher.specs.length >= 1);
  t.mock.timers.tick(54_999);
  assert.equal(launcher.aborted.length, 0);
  t.mock.timers.tick(1);
  assert.equal(launcher.aborted.length, 1);
  assert.deepEqual(await timed, { status: 'failed', stopped: true });
  t.mock.timers.reset();
  let consumed = 0;
  const signer = new WorkerSigner(keys.privateKey);
  const worker = new SerialWorker(new WorkerVerifier(keys.publicKey, async () => { consumed++; return true; }),
    (request, signal) => lane.run(request, signal), request => lane.stop(request));
  const j = job(); const request = chatRequest(j);
  const running = worker.execute(request, signer.issue(j, 'execute', request), new AbortController().signal);
  await until(() => launcher.specs.length >= 2);
  const cancel = { job: j.id, lease: j.lease_token };
  assert.deepEqual(await worker.cancel(cancel, signer.issue(j, 'cancel', cancel)), { stopped: true });
  assert.deepEqual(await running, { status: 'failed', stopped: true });
  await mode({ kind: 'answer', answer: ANSWER });
  launcher.left = null;
  const k = job(); const second = chatRequest(k);
  assert.deepEqual(await worker.execute(second, signer.issue(k, 'execute', second), new AbortController().signal), { status: 'unknown', stopped: false });
  const l = job(); const third = chatRequest(l);
  await assert.rejects(worker.execute(third, signer.issue(l, 'execute', third), new AbortController().signal), /worker_busy/);
  assert.equal(consumed, 4);
});

test('CLD-09 공통부의 자격 유출 검사: 어댑터가 토큰을 argv·다른 env·파일에 두거나 허용 밖 env를 내면 띄우지 않음', async () => {
  type Mutate = (run: ChatRun, plan: AdapterRun) => Promise<Partial<Pick<AdapterRun, 'args' | 'env'>>>;
  class Leaky extends ClaudeChatAdapter {
    constructor(private readonly mutate: Mutate) { super('subscription-token'); }
    override async start(run: ChatRun): Promise<AdapterRun> {
      const plan = await super.start(run);
      return { ...plan, ...await this.mutate(run, plan) };
    }
  }
  const cases: [string, Mutate][] = [
    ['argv', async (_run, plan) => ({ args: [...plan.args, '--append-system-prompt', `key ${TOKEN}`] })],
    ['다른 env 값', async (_run, plan) => ({ env: { ...plan.env, CLAUDE_CONFIG_DIR: TOKEN } })],
    ['설정 파일', async run => { await writeFile(join(run.dirs.config, 'settings.json'), JSON.stringify({ env: { T: TOKEN } })); return {}; }],
    ['허용 밖 env 이름', async (_run, plan) => ({ env: { ...plan.env, ANTHROPIC_API_KEY: 'sk-ant-api03-other' } })],
    ['기본 env 덮기', async (_run, plan) => ({ env: { ...plan.env, HOME: '/home/someone' } })],
    ['자격 변수에 없음', async (_run, plan) => ({ env: { ...plan.env, CLAUDE_CODE_OAUTH_TOKEN: 'something-else-0123456789' } })],
  ];
  for (const [name, mutate] of cases) {
    const launcher = new SpawnLauncher(fakeBin);
    const lane = claudeLane(launcher, {}, credential(), new Leaky(mutate));
    assert.deepEqual(await lane.run(chatRequest(job()), new AbortController().signal), { status: 'failed', stopped: true }, name);
    assert.equal(launcher.specs.length, 0, name);
    // 띄우지 않았으니 남은 프로세스가 없고, 실행 디렉터리(토큰을 쓴 파일 포함)도 지운다.
    assert.deepEqual(await runs(), [], name);
  }
});

test('CLD-10 자격: Secret 파일을 실행마다 다시 읽어 교체가 재시작 없이 다음 실행부터 반영, 모양이 틀리면 값 없이 실패', async () => {
  const launcher = new SpawnLauncher(fakeBin);
  const lane = claudeLane(launcher);
  assert.equal((await lane.run(chatRequest(job()), new AbortController().signal)).status, 'succeeded');
  assert.equal((await seen()).env.CLAUDE_CODE_OAUTH_TOKEN, TOKEN);
  const rotated = `${TOKEN}-rotated`;
  await writeFile(tokenFile(), rotated);
  assert.equal((await lane.run(chatRequest(job()), new AbortController().signal)).status, 'succeeded');
  assert.equal((await seen()).env.CLAUDE_CODE_OAUTH_TOKEN, rotated);
  // 실행 때 자격이 없으면 띄우지 않고 failed다.
  await rm(tokenFile());
  assert.deepEqual(await lane.run(chatRequest(job()), new AbortController().signal), { status: 'failed', stopped: true });
  assert.equal(launcher.specs.length, 2);
  const cases: [string | null, string][] = [
    [null, 'credential_missing'],
    ['', 'credential_invalid'],
    ['short', 'credential_invalid'],
    [`${TOKEN} ${TOKEN}`, 'credential_invalid'],
    [`${TOKEN}\n${TOKEN}`, 'credential_invalid'],
    ['토큰'.repeat(20), 'credential_invalid'],
    ['x'.repeat(20_000), 'credential_invalid'],
  ];
  for (const [content, expected] of cases) {
    await rm(tokenFile(), { force: true });
    if (content !== null) await writeFile(tokenFile(), content);
    let error: unknown;
    try { await credential().open(); } catch (caught) { error = caught; }
    assert.ok(error instanceof WorkerStartError, expected);
    assert.equal(error.code, expected);
    assert.ok(!String(error.message).includes(TOKEN.slice(0, 20)) && !String(error.stack).includes(TOKEN.slice(0, 20)));
  }
  await writeFile(tokenFile(), TOKEN);
  assert.equal(await credential().open(), 'present');
  // 자격 파일·디렉터리를 영속 공간에 복사하지 않는다(되쓰기 없음).
  assert.deepEqual(await readdir(tokenDir), ['CLAUDE_CODE_OAUTH_TOKEN']);
});

test('CLD-11 개인 ~/.claude*: 자격 디렉터리·토큰 파일 심링크·실행 루트가 사람 홈 .claude*를 가리키면 읽기 전에 거부', async () => {
  const human = join(base, 'human');
  await mkdir(join(human, '.claude'), { recursive: true });
  await writeFile(join(human, '.claude', 'CLAUDE_CODE_OAUTH_TOKEN'), 'personal-token-0123456789abcdef');
  await writeFile(join(human, '.claude.json'), '{}');
  const start = (vars: Record<string, string>) => code(startWorker(workerConfig(env(vars)), { port: 0, host: '127.0.0.1', homes: [human] })
    .then(worker => worker.close()));
  assert.equal(await start({ WORKER_CREDENTIAL_DIR: join(human, '.claude') }), 'config_invalid:WORKER_CREDENTIAL_DIR');
  assert.equal(await start({ WORKER_NONCE_DIR: join(human, '.claude-sub', 'nonces') }), 'config_invalid:WORKER_NONCE_DIR');
  // 허용 디렉터리 안 파일이 사람 홈 .claude 아래 토큰을 가리키는 심링크.
  const linked = join(base, 'linked');
  await mkdir(linked);
  await symlink(join(human, '.claude', 'CLAUDE_CODE_OAUTH_TOKEN'), join(linked, 'CLAUDE_CODE_OAUTH_TOKEN'));
  assert.equal(await start({ WORKER_CREDENTIAL_DIR: linked }), 'credential_personal_path');
  // 실행 디렉터리 루트도 개인 Claude 홈이면 거부한다.
  assert.throws(() => claudeLane(new SpawnLauncher(fakeBin), { tmp: join(human, '.claude'), homes: [human] }), Denied);
  await assert.rejects(readdir(join(human, '.claude-sub')));
});

test('CLD-12 기동: claude --version 2.1.308 확인(자격 없이), 다른 버전·모양이면 실패, 토큰 없으면 실패, /readyz는 토큰 파일 기준', async () => {
  const adapter = new ClaudeChatAdapter('subscription-token');
  assert.equal(await executorVersion(adapter, fakeBin), '2.1.308');
  const version = JSON.parse(await readFile(join(fakeDir, 'version-seen.json'), 'utf8')) as { args: string[]; env: Record<string, string> };
  assert.deepEqual(version.args, ['--version']);
  assert.equal(version.env.CLAUDE_CODE_OAUTH_TOKEN, undefined);
  assert.ok(Object.values(version.env).every(value => !value.includes(TOKEN)));
  assert.ok(version.env.CLAUDE_CONFIG_DIR && version.env.CLAUDE_CONFIG_DIR === version.env.HOME);
  const startCode = () => code(startWorker(workerConfig(env()), { port: 0, host: '127.0.0.1' }).then(worker => worker.close()));
  await writeFile(join(fakeDir, 'version.txt'), '2.1.314 (Claude Code)\n');
  assert.equal(await startCode(), 'executor_version_mismatch');
  await writeFile(join(fakeDir, 'version.txt'), 'codex-cli 0.163.0\n');
  assert.equal(await startCode(), 'executor_version_unavailable');
  await writeFile(join(fakeDir, 'version.txt'), '2.1.308 (Claude Code)\n');
  await rm(tokenFile());
  assert.equal(await startCode(), 'credential_missing');
  await writeFile(tokenFile(), TOKEN);
  const worker = await startWorker(workerConfig(env()), { port: 0, host: '127.0.0.1', launcher: new SpawnLauncher(fakeBin) });
  try {
    assert.equal(worker.profile, 'claude-subscription');
    assert.equal(worker.cliVersion, '2.1.308');
    assert.equal(worker.credential, 'present');
    const url = `http://127.0.0.1:${(worker.server.address() as AddressInfo).port}`;
    assert.equal((await fetch(`${url}/readyz`)).status, 200);
    // 토큰 파일이 없어지거나 모양이 틀리면 Ready에서 빠지고, 다시 생기면 돌아온다(ESO 교체).
    await rm(tokenFile());
    assert.equal((await fetch(`${url}/readyz`)).status, 503);
    await writeFile(tokenFile(), 'bad token');
    assert.equal((await fetch(`${url}/readyz`)).status, 503);
    await writeFile(tokenFile(), TOKEN);
    assert.equal((await fetch(`${url}/readyz`)).status, 200);
  } finally { await worker.close(); }
});

test('CLD-13 HTTP 끝까지: 서명한 요청 → Claude 대화 → succeeded, 같은 capability는 작업자 재기동 뒤에도 거부', async () => {
  const signer = new WorkerSigner(keys.privateKey);
  const j = job(); const request = chatRequest(j);
  const token = signer.issue(j, 'execute', request);
  const launcher = new SpawnLauncher(fakeBin);
  const boot = () => startWorker(workerConfig(env({ HTTPS_PROXY: PROXY.https })), { port: 0, host: '127.0.0.1', launcher });
  const client = (worker: Awaited<ReturnType<typeof boot>>) => new HttpWorker(`http://127.0.0.1:${(worker.server.address() as AddressInfo).port}/`, fetch);
  const first = await boot();
  try {
    assert.deepEqual(await client(first).execute(request, token, new AbortController().signal), { status: 'succeeded', stopped: true, answer: ANSWER });
    assert.equal((await seen()).env.HTTPS_PROXY, PROXY.https);
    await assert.rejects(client(first).execute(request, token, new AbortController().signal), /worker_rejected/);
  } finally { await first.close(); }
  const second = await boot();
  try {
    await assert.rejects(client(second).execute(request, token, new AbortController().signal), /worker_rejected/);
    assert.equal(launcher.specs.length, 1);
    await mode({ kind: 'error', error: 'rate_limit', status: 429 });
    const k = job(); const next = chatRequest(k);
    assert.deepEqual(await client(second).execute(next, signer.issue(k, 'execute', next), new AbortController().signal), { status: 'limited', stopped: true });
  } finally { await second.close(); }
});

test('CLD-14 진입점 프로세스: 토큰이 틀리거나 사람 홈 경로면 종료 코드 1과 사유 코드만, 출력에 토큰·공개 키 없음', async () => {
  const entry = resolve('dist/src/worker-main.js');
  const start = (vars: Record<string, string | undefined>) => {
    const child = spawn(process.execPath, [entry], { env: Object.fromEntries(Object.entries({ PATH: process.env.PATH, ...vars })
      .filter((pair): pair is [string, string] => pair[1] !== undefined)), stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    child.stdout.on('data', chunk => { out += chunk; }); child.stderr.on('data', chunk => { out += chunk; });
    // 회귀로 기동이 성공해 버리면 끝나지 않는다. 10초 뒤 끝내고 실패로 본다.
    const exit = new Promise<number | null | 'timeout'>(done => {
      const timer = setTimeout(() => { child.kill('SIGKILL'); done('timeout'); }, 10_000);
      child.once('exit', status => { clearTimeout(timer); done(status); });
    });
    return { output: () => out, exit };
  };
  const cases: [string, Record<string, string | undefined>, string][] = [
    [`${TOKEN} with space`, {}, 'credential_invalid'],
    [TOKEN, { WORKER_CREDENTIAL_KEY: 'ANTHROPIC_API_KEY' }, 'profile_unsupported'],
    [TOKEN, { WORKER_MODEL: 'opus' }, 'config_invalid:WORKER_MODEL'],
  ];
  for (const [content, vars, reason] of cases) {
    await writeFile(tokenFile(), content);
    const run = start(env(vars));
    assert.equal(await run.exit, 1, reason);
    assert.deepEqual(JSON.parse(run.output().trim()), { component: 'worker', level: 'error', event: 'worker_start_failed', reason });
    assert.ok(!run.output().includes(TOKEN.slice(0, 20)) && !run.output().includes('BEGIN PUBLIC KEY'), reason);
  }
});
