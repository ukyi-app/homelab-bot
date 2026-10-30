import { afterEach, before, beforeEach, test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import type { ChildProcess } from 'node:child_process';
import { generateKeyPairSync, randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { chmod, lstat, mkdir, mkdtemp, readFile, readdir, rm, stat, symlink, utimes, writeFile } from 'node:fs/promises';
import type { AddressInfo } from 'node:net';
import { join, resolve } from 'node:path';
import { createInterface } from 'node:readline';
import { Denied, SYSTEM_INSTRUCTIONS } from '../src/contracts.js';
import type { Job } from '../src/contracts.js';
import { CHAT_OUTPUT_JSON_SCHEMA, ChatLane, chatArgs, chatDeadline, interpretChat } from '../src/codex-chat.js';
import type { ChatReport } from '../src/codex-chat.js';
import { FORBIDDEN_FLAGS } from '../src/codex-config.js';
import { LaunchFailed } from '../src/codex.js';
import type { CodexLauncher, LaunchResult, LaunchSpec } from '../src/codex.js';
import { SerialWorker, WorkerSigner, WorkerVerifier } from '../src/worker.js';
import type { WorkerRequest } from '../src/worker.js';
import { HttpWorker } from '../src/worker-http.js';
import { WORKER_ENV, codexVersion, startWorker, workerConfig } from '../src/worker-main.js';
import { FileNonceStore, NONCE_RETENTION_MS, WorkerStartError, seedAuth } from '../src/worker-state.js';

// 작업자 진입점(T16b S4). 모델 호출 없음: codex 자리에 같은 인자·stdin·env로 도는 가짜 실행 파일을 둔다.
// 시드 값은 시험용 가짜다. 개인 ~/.codex*는 쓰지 않고 저장소 .local/ 아래 임시 CODEX_HOME만 쓴다.
const FAKE_TOKEN = 'fixture-refresh-token-abcdefghijklmnopqrstuvwxyz0123';
const SEED = JSON.stringify({ auth_mode: 'chatgpt', OPENAI_API_KEY: null,
  tokens: { id_token: 'fixture-id', access_token: 'fixture-access', refresh_token: FAKE_TOKEN, account_id: 'fixture-account' },
  last_refresh: '2026-10-30T00:00:00Z' });
const ANSWER = { facts: ['작업자 응답'], hypotheses: [], unknowns: ['실측 전'], checks: [] };
// 가짜 codex. 모드는 실행 파일 옆 mode.json으로 받는다(codex env는 허용 목록이라 env로 넘길 수 없다).
const FAKE_CODEX = `
const fs = require('node:fs');
const path = require('node:path');
const args = process.argv.slice(2);
if (args[0] === '--version') { process.stdout.write(fs.readFileSync(path.join(__dirname, 'version.txt'), 'utf8')); process.exit(0); }
const mode = JSON.parse(fs.readFileSync(path.join(__dirname, 'mode.json'), 'utf8'));
let input = '';
process.stdin.on('data', d => { input += d; });
process.stdin.on('end', () => {
  const home = process.env.CODEX_HOME;
  fs.writeFileSync(path.join(__dirname, 'seen.json'), JSON.stringify({ args, cwd: process.cwd(), entries: fs.readdirSync('.'),
    env: process.env, input, config: fs.readFileSync(path.join(home, 'config.toml'), 'utf8'),
    schema: fs.readFileSync(args[args.indexOf('--output-schema') + 1], 'utf8') }));
  // --ephemeral을 무시하고 세션을 남기는 경우를 흉내 낸다.
  if (mode.session) {
    const dir = path.join(home, 'sessions', '2026', '10', '30');
    fs.mkdirSync(dir, { recursive: true }); fs.writeFileSync(path.join(dir, 'rollout-fixture.jsonl'), '{}\\n');
  }
  const emit = e => process.stdout.write(JSON.stringify(e) + '\\n');
  emit({ type: 'thread.started', thread_id: 'chat-thread-1' }); emit({ type: 'turn.started' });
  if (mode.kind === 'hang') { setInterval(() => {}, 1000); return; }
  if (mode.kind === 'limit') { emit({ type: 'turn.failed', error: { message: 'usage_limit_reached' } }); setTimeout(() => process.exit(1), 10); return; }
  if (mode.kind === 'tools') for (let i = 0; i < 9; i++) emit({ type: 'item.started', item: { id: 'tool-' + i, type: 'command_execution' } });
  fs.writeFileSync(args[args.indexOf('-o') + 1], JSON.stringify(mode.answer));
  process.stdout.write(JSON.stringify({ type: 'turn.completed', usage: {} }) + '\\n', () => process.exit(0));
});
`;

// 실제 프로세스를 띄우지만 /proc 전체를 훑지 않는 launcher. 정리는 자식 하나만 본다.
// ProcessGroupLauncher의 /proc 검사는 codex-bridge 시험이 맡는다. 여기서 쓰면 병렬로 도는 다른 시험 파일의
// 같은 UID 프로세스(예: non-dumpable 시험 자식)를 의심해 판정이 흔들릴 수 있다.
class SpawnLauncher implements CodexLauncher {
  specs: LaunchSpec[] = [];
  // 중단 신호를 받은 job. 신호를 받는 즉시(동기) 남긴다.
  aborted: string[] = [];
  left: number | null = 0;
  private readonly children = new Map<string, { child: ChildProcess; exited: Promise<unknown> }>();
  constructor(private readonly bin: string) {}
  async run(spec: LaunchSpec, signal: AbortSignal, onLine: (line: string) => void): Promise<LaunchResult> {
    this.specs.push(spec);
    if (signal.aborted) throw new LaunchFailed();
    const child = spawn(this.bin, spec.args, { cwd: spec.cwd, env: spec.env, stdio: ['pipe', 'pipe', 'ignore'] });
    const exited = new Promise<LaunchResult['exit']>(done => child.once('exit', (code, sig) => done({ code, signal: sig })));
    this.children.set(spec.job, { child, exited });
    const kill = () => { this.aborted.push(spec.job); child.kill('SIGKILL'); };
    signal.addEventListener('abort', kill, { once: true });
    const lines = createInterface({ input: child.stdout! });
    const closed = once(lines, 'close').catch(() => {});
    lines.on('line', onLine);
    child.stdin!.end(spec.stdin);
    try {
      const exit = await exited;
      await closed;
      return { exit };
    } finally { signal.removeEventListener('abort', kill); }
  }
  async terminate(job: string) {
    const entry = this.children.get(job);
    if (entry && entry.child.exitCode === null && entry.child.signalCode === null) { entry.child.kill('SIGKILL'); await entry.exited; }
  }
  async survivors(_job: string) { return this.left; }
}

let base: string;
let codexHome: string;
let seedDir: string;
let nonceDir: string;
let fakeDir: string;
let fakeBin: string;
const keys = generateKeyPairSync('ed25519');
const publicPem = keys.publicKey.export({ type: 'spki', format: 'pem' }).toString();
before(async () => { await mkdir('.local', { recursive: true }); });
beforeEach(async () => {
  base = resolve(await mkdtemp('.local/worker-'));
  codexHome = join(base, 'codex-home'); seedDir = join(base, 'seed'); nonceDir = join(base, 'state', 'nonces'); fakeDir = join(base, 'fake');
  for (const dir of [codexHome, seedDir, fakeDir]) await mkdir(dir, { recursive: true });
  await writeFile(join(seedDir, 'CODEX_AUTH_JSON'), SEED);
  await writeFile(join(fakeDir, 'codex.cjs'), FAKE_CODEX);
  // node 경로를 박은 셸 래퍼. codex env의 PATH(/usr/local/bin:/usr/bin:/bin)에 node가 없어도 돈다.
  fakeBin = join(fakeDir, 'codex');
  await writeFile(fakeBin, `#!/bin/sh\nexec "${process.execPath}" "${join(fakeDir, 'codex.cjs')}" "$@"\n`);
  await chmod(fakeBin, 0o755);
  await writeFile(join(fakeDir, 'version.txt'), 'codex-cli 0.163.0\n');
  await mode({ kind: 'answer', answer: ANSWER });
});
// .local은 다른 시험 파일도 함께 쓴다. 이 시험이 만든 디렉터리만 지운다.
afterEach(async () => { await rm(base, { recursive: true, force: true }).catch(() => {}); });
const mode = (value: unknown) => writeFile(join(fakeDir, 'mode.json'), JSON.stringify(value));
const seen = async () => JSON.parse(await readFile(join(fakeDir, 'seen.json'), 'utf8')) as {
  args: string[]; cwd: string; entries: string[]; env: Record<string, string>; input: string; config: string; schema: string };
const job = (): Job => ({ id: randomUUID(), lease_token: randomUUID() }) as Job;
const chatRequest = (j: Job, overrides: Partial<WorkerRequest> = {}): WorkerRequest => ({ version: 1, job: j.id, lease: j.lease_token,
  lane: 'chat', policyRevision: 'fixture-v1', instructions: SYSTEM_INSTRUCTIONS, untrusted: [{ text: '상태 알려줘' }],
  timeoutMs: 60_000, toolCalls: 8, ...overrides });
const env = (overrides: Record<string, string | undefined> = {}) => ({ CODEX_HOME: codexHome, WORKER_SEED_DIR: seedDir,
  WORKER_SEED_KEY: 'CODEX_AUTH_JSON', WORKER_NONCE_DIR: nonceDir, WORKER_CONTROL_PUBLIC_KEY: publicPem, WORKER_CODEX_BIN: fakeBin, ...overrides });
const code = async (promise: Promise<unknown>) => { try { await promise; return 'ok'; } catch (error) { return error instanceof WorkerStartError ? error.code : `other:${String(error)}`; } };
// 기동이 뜻밖에 성공하면 서버를 닫고 'ok'를 돌려준다. 열린 채 두면 시험 프로세스가 끝나지 않는다.
const startCode = (vars: Record<string, string | undefined> = {}) => code(startWorker(workerConfig(env(vars)), { port: 0, host: '127.0.0.1' })
  .then(worker => worker.close()));
const leftovers = async () => (await readdir(codexHome)).filter(name => name.startsWith('.auth.json'));

test('WRK-01 시드는 CODEX_HOME에 auth.json이 없을 때만 0600으로 복사하고, 있으면 내용·권한을 그대로 둠', async () => {
  assert.equal(await seedAuth(codexHome, join(seedDir, 'CODEX_AUTH_JSON')), 'seeded');
  const target = join(codexHome, 'auth.json');
  assert.equal(await readFile(target, 'utf8'), SEED);
  assert.equal((await stat(target)).mode & 0o777, 0o600);
  assert.deepEqual(await leftovers(), []);
  // Codex가 갱신해 다시 쓴 것처럼 바꾼다. 다음 기동(파드 재생성)은 새 시드가 와도 덮지 않는다.
  const refreshed = SEED.replace('2026-10-30T00:00:00Z', '2026-11-07T00:00:00Z');
  await writeFile(target, refreshed); await chmod(target, 0o640);
  await writeFile(join(seedDir, 'CODEX_AUTH_JSON'), SEED.replace(FAKE_TOKEN, `${FAKE_TOKEN}-reseeded`));
  assert.equal(await seedAuth(codexHome, join(seedDir, 'CODEX_AUTH_JSON')), 'kept');
  assert.equal(await readFile(target, 'utf8'), refreshed);
  assert.equal((await stat(target)).mode & 0o777, 0o640);
});
test('WRK-01 Secret 볼륨 모양(..data 심링크)의 시드도 읽음', async () => {
  const volume = join(base, 'volume');
  await mkdir(join(volume, '..2026_10_30'), { recursive: true });
  await writeFile(join(volume, '..2026_10_30', 'CODEX_AUTH_JSON'), SEED);
  await symlink('..2026_10_30', join(volume, '..data'));
  await symlink(join('..data', 'CODEX_AUTH_JSON'), join(volume, 'CODEX_AUTH_JSON'));
  assert.equal(await seedAuth(codexHome, join(volume, 'CODEX_AUTH_JSON')), 'seeded');
  assert.equal(await readFile(join(codexHome, 'auth.json'), 'utf8'), SEED);
});
test('WRK-02 시드가 없거나 깨졌으면 기동 실패, auth.json을 만들지 않고 오류에 값이 실리지 않음', async () => {
  const seedFile = join(seedDir, 'CODEX_AUTH_JSON');
  const cases: [string, () => Promise<void>, string][] = [
    ['없음', () => rm(seedFile), 'seed_missing'],
    ['빈 파일', () => writeFile(seedFile, ''), 'seed_invalid'],
    ['JSON 아님', () => writeFile(seedFile, `{"tokens":{"refresh_token":"${FAKE_TOKEN}"`), 'seed_invalid'],
    ['갱신 토큰 없음', () => writeFile(seedFile, JSON.stringify({ tokens: { access_token: FAKE_TOKEN } })), 'seed_invalid'],
    ['배열', () => writeFile(seedFile, JSON.stringify([FAKE_TOKEN])), 'seed_invalid'],
    ['디렉터리', async () => { await rm(seedFile); await mkdir(seedFile); }, 'seed_unreadable'],
  ];
  for (const [name, prepare, expected] of cases) {
    await rm(seedFile, { recursive: true, force: true }); await writeFile(seedFile, SEED);
    await prepare();
    let error: unknown;
    try { await seedAuth(codexHome, seedFile); } catch (caught) { error = caught; }
    assert.ok(error instanceof WorkerStartError, name);
    assert.equal(error.code, expected, name);
    assert.ok(!String(error.message).includes(FAKE_TOKEN.slice(0, 16)) && !String(error.stack).includes(FAKE_TOKEN.slice(0, 16)), name);
    await assert.rejects(lstat(join(codexHome, 'auth.json')), name);
    assert.deepEqual(await leftovers(), [], name);
  }
});
test('WRK-02 auth.json이 심링크·디렉터리면 따라가거나 고치지 않고 기동 실패, CODEX_HOME이 없어도 실패', async () => {
  const outside = join(base, 'outside.json');
  await writeFile(outside, 'outside');
  await symlink(outside, join(codexHome, 'auth.json'));
  assert.equal(await code(seedAuth(codexHome, join(seedDir, 'CODEX_AUTH_JSON'))), 'auth_not_regular');
  assert.equal(await readFile(outside, 'utf8'), 'outside');
  assert.ok((await lstat(join(codexHome, 'auth.json'))).isSymbolicLink());
  await rm(join(codexHome, 'auth.json')); await mkdir(join(codexHome, 'auth.json'));
  assert.equal(await code(seedAuth(codexHome, join(seedDir, 'CODEX_AUTH_JSON'))), 'auth_not_regular');
  assert.equal(await code(seedAuth(join(base, 'missing-home'), join(seedDir, 'CODEX_AUTH_JSON'))), 'codex_home_unavailable');
});

test('WRK-03 재기동 뒤에도 쓴 capability를 거부(영속 nonce 디렉터리), 새 capability는 한 번 통과', async () => {
  const signer = new WorkerSigner(keys.privateKey);
  const j = job(); const request = chatRequest(j);
  const token = signer.issue(j, 'execute', request);
  const first = new FileNonceStore(nonceDir); await first.open();
  await new WorkerVerifier(keys.publicKey, nonce => first.consume(nonce)).check(token, 'execute', request);
  await assert.rejects(new WorkerVerifier(keys.publicKey, nonce => first.consume(nonce)).check(token, 'execute', request), Denied);
  // 프로세스 재시작: 메모리 상태 없이 같은 디렉터리만 남는다.
  const restarted = new FileNonceStore(nonceDir); await restarted.open();
  const verifier = new WorkerVerifier(keys.publicKey, nonce => restarted.consume(nonce));
  await assert.rejects(verifier.check(token, 'execute', request), Denied);
  const fresh = signer.issue(j, 'cancel', { job: j.id, lease: j.lease_token });
  await verifier.check(fresh, 'cancel', { job: j.id, lease: j.lease_token });
  await assert.rejects(verifier.check(fresh, 'cancel', { job: j.id, lease: j.lease_token }), Denied);
});
test('WRK-04 nonce 기록은 보관 기간 뒤 지우고, 동시 사용은 하나만 통과, nonce 모양이 아니면 파일을 만들지 않고 거부', async () => {
  let now = 1_800_000_000_000;
  const store = new FileNonceStore(nonceDir, () => now);
  const a = 'a'.repeat(64);
  const b = 'b'.repeat(64);
  assert.equal(await store.consume(a), true);
  now += NONCE_RETENTION_MS;
  assert.equal(await store.consume(a), false);
  assert.equal(await store.consume(b), true);
  now += 1;
  assert.equal(await store.consume('c'.repeat(64)), true);
  assert.deepEqual((await readdir(nonceDir)).sort(), [b, 'c'.repeat(64)]);
  const results = await Promise.all(Array.from({ length: 10 }, () => store.consume('d'.repeat(64))));
  assert.equal(results.filter(Boolean).length, 1);
  for (const bad of ['../escape', 'A'.repeat(64), 'a'.repeat(63), '']) assert.equal(await store.consume(bad), false, bad);
  assert.deepEqual((await readdir(nonceDir)).sort(), [b, 'c'.repeat(64), 'd'.repeat(64)]);
  assert.equal(NONCE_RETENTION_MS >= 31_000, true);
});
test('WRK-04 nonce 디렉터리를 쓸 수 없으면 기동 실패', async () => {
  await writeFile(join(base, 'state'), 'not a directory');
  assert.equal(await code(new FileNonceStore(nonceDir).open()), 'nonce_store_unavailable');
});

test('WRK-05 대화 레인: --ephemeral·--skip-git-repo-check·read-only 설정, 빈 작업 공간, 작업자 env 비상속', async () => {
  await seedAuth(codexHome, join(seedDir, 'CODEX_AUTH_JSON'));
  const launcher = new SpawnLauncher(fakeBin);
  const lane = new ChatLane(codexHome, launcher, { tmp: base, proxy: { https: 'http://10.43.0.28:3128', noProxy: '127.0.0.1,localhost' } });
  const secretEnv = { CODEX_AUTH_JSON: SEED, DISCORD_BOT_TOKEN: 'fixture-discord', WORKER_CONTROL_PUBLIC_KEY: publicPem, OPENAI_API_KEY: 'fixture' };
  const saved = { ...process.env };
  Object.assign(process.env, secretEnv);
  let result;
  try { result = await lane.run(chatRequest(job()), new AbortController().signal); }
  finally { for (const name of Object.keys(secretEnv)) { if (saved[name] === undefined) delete process.env[name]; else process.env[name] = saved[name]; } }
  assert.deepEqual(result, { status: 'succeeded', stopped: true, answer: ANSWER });
  const s = await seen();
  const spec = launcher.specs[0]!;
  assert.deepEqual(s.args, chatArgs(join(spec.cwd, '..', 'run')));
  assert.ok(s.args.includes('--ephemeral') && s.args.includes('--skip-git-repo-check') && s.args.at(-1) === '-');
  for (const flag of FORBIDDEN_FLAGS.filter(flag => flag !== '--ephemeral')) assert.ok(!s.args.includes(flag), flag);
  assert.deepEqual(Object.keys(s.env).filter(name => !['PWD', 'SHLVL', '_'].includes(name)).sort(),
    ['CODEX_HOME', 'HOME', 'HOMELAB_CODEX_TASK', 'HTTPS_PROXY', 'LANG', 'NO_PROXY', 'PATH', 'TMPDIR']);
  assert.equal(s.env.CODEX_HOME, codexHome);
  assert.notEqual(s.env.HOME, codexHome);
  assert.deepEqual(s.entries, []);
  assert.ok(!s.cwd.startsWith(codexHome));
  assert.match(s.config, /^sandbox_mode = "read-only"$/m);
  assert.match(s.config, /^approval_policy = "never"$/m);
  assert.match(s.config, /^inherit = "none"$/m);
  assert.ok(!s.config.includes(codexHome) && !s.config.includes('PROXY'));
  assert.deepEqual(JSON.parse(s.schema), CHAT_OUTPUT_JSON_SCHEMA);
  assert.ok(s.input.startsWith(SYSTEM_INSTRUCTIONS) && s.input.includes('상태 알려줘'));
  // 실행마다 만든 임시 디렉터리는 정리한다.
  assert.deepEqual((await readdir(base)).filter(name => name.startsWith('homelab-chat-')), []);
});
test('WRK-06 대화 레인은 세션 파일을 남기지 않고 auth.json은 그대로 둠', async () => {
  await seedAuth(codexHome, join(seedDir, 'CODEX_AUTH_JSON'));
  await mode({ kind: 'answer', answer: ANSWER, session: true });
  const lane = new ChatLane(codexHome, new SpawnLauncher(fakeBin), { tmp: base });
  assert.equal((await lane.run(chatRequest(job()), new AbortController().signal)).status, 'succeeded');
  assert.ok((await seen()).args.includes('--ephemeral'));
  assert.deepEqual((await readdir(codexHome)).sort(), ['auth.json', 'config.toml']);
  assert.equal(await readFile(join(codexHome, 'auth.json'), 'utf8'), SEED);
});
test('WRK-07 대화 결과 판정: 한도·인증 대기, 스키마 밖·반사·중단은 failed, 긴 답은 잘라 받음, 남은 프로세스는 unknown', () => {
  const good = ['{"type":"thread.started","thread_id":"t"}', '{"type":"turn.started"}', '{"type":"turn.completed"}'];
  const report = (overrides: Partial<ChatReport>): ChatReport => ({ lines: good, exit: { code: 0, signal: null }, survivors: 0,
    aborted: false, output: JSON.stringify(ANSWER), ...overrides });
  const failedTurn = (message: string) => [good[0]!, good[1]!, JSON.stringify({ type: 'turn.failed', error: { message } })];
  const cases: [Partial<ChatReport>, string][] = [
    [{}, 'succeeded'],
    [{ lines: failedTurn('usage_limit_reached'), exit: { code: 1, signal: null } }, 'limited'],
    [{ lines: failedTurn('401 Unauthorized: refresh token expired'), exit: { code: 1, signal: null } }, 'auth_expired'],
    [{ lines: failedTurn('boom'), exit: { code: 1, signal: null } }, 'failed'],
    [{ exit: { code: 1, signal: null } }, 'failed'],
    [{ lines: good.slice(0, 2) }, 'failed'],
    [{ lines: [...good, 'not json'] }, 'failed'],
    [{ output: JSON.stringify({ ...ANSWER, extra: 'x' }) }, 'failed'],
    [{ output: JSON.stringify({ facts: 'x', hypotheses: [], unknowns: [], checks: [] }) }, 'failed'],
    [{ output: null }, 'failed'],
    [{ outputTooLarge: true }, 'failed'],
    [{ output: JSON.stringify({ ...ANSWER, facts: [`토큰 ${FAKE_TOKEN}`] }), secrets: [FAKE_TOKEN] }, 'failed'],
    [{ aborted: true }, 'failed'],
    [{ exceeded: 'tool_budget_exceeded' }, 'failed'],
    [{ launchFailed: true, exit: null }, 'failed'],
    [{ survivors: 1 }, 'unknown'],
    [{ survivors: null }, 'unknown'],
    [{ exit: null }, 'unknown'],
  ];
  for (const [overrides, expected] of cases) assert.equal(interpretChat(report(overrides)).status, expected, JSON.stringify(overrides));
  assert.equal(interpretChat(report({ survivors: 1 })).stopped, false);
  const long = interpretChat(report({ output: JSON.stringify({ facts: Array.from({ length: 12 }, () => '가'.repeat(900)),
    hypotheses: [], unknowns: [], checks: [] }) }));
  assert.equal(long.status, 'succeeded');
  assert.ok(long.status === 'succeeded' && long.answer.facts.length === 8 && long.answer.facts.every(fact => fact.length <= 500));
});
test('WRK-08 작업 레인 요청은 띄우지 않고 failed, 한도 실패는 limited, 도구 예산 초과는 failed', async () => {
  await seedAuth(codexHome, join(seedDir, 'CODEX_AUTH_JSON'));
  const launcher = new SpawnLauncher(fakeBin);
  const lane = new ChatLane(codexHome, launcher, { tmp: base });
  assert.deepEqual(await lane.run(chatRequest(job(), { lane: 'task' }), new AbortController().signal), { status: 'failed', stopped: true });
  assert.equal(launcher.specs.length, 0);
  await mode({ kind: 'limit' });
  assert.deepEqual(await lane.run(chatRequest(job()), new AbortController().signal), { status: 'limited', stopped: true });
  await mode({ kind: 'tools', answer: ANSWER });
  assert.deepEqual(await lane.run(chatRequest(job(), { toolCalls: 2 }), new AbortController().signal), { status: 'failed', stopped: true });
});
test('WRK-09 시간 초과는 게시 서버보다 먼저 멈춰 failed, 취소는 정리 확인 뒤 stopped, 남은 프로세스를 모르면 unknown·새 실행 거부', async t => {
  assert.equal(chatDeadline(60_000), 55_000); assert.equal(chatDeadline(4_000), 2_000);
  await seedAuth(codexHome, join(seedDir, 'CODEX_AUTH_JSON'));
  await mode({ kind: 'hang' });
  const launcher = new SpawnLauncher(fakeBin);
  const lane = new ChatLane(codexHome, launcher, { tmp: base });
  // 작업자 기한은 가짜 시계로 본다. 게시 서버의 60초보다 5초 먼저(55초) 스스로 멈춘다.
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const timed = lane.run(chatRequest(job()), new AbortController().signal);
  while (launcher.specs.length < 1) await new Promise(resolve => setImmediate(resolve));
  t.mock.timers.tick(54_999);
  assert.equal(launcher.aborted.length, 0);
  t.mock.timers.tick(1);
  assert.equal(launcher.aborted.length, 1);
  assert.deepEqual(await timed, { status: 'failed', stopped: true });
  t.mock.timers.reset();
  // SerialWorker 경로: 실행 중 취소 → 정리 확인 → 다음 실행을 받는다.
  let consumed = 0;
  const signer = new WorkerSigner(keys.privateKey);
  const worker = new SerialWorker(new WorkerVerifier(keys.publicKey, async () => { consumed++; return true; }),
    (request, signal) => lane.run(request, signal), request => lane.stop(request));
  const j = job(); const request = chatRequest(j);
  const running = worker.execute(request, signer.issue(j, 'execute', request), new AbortController().signal);
  while (launcher.specs.length < 2) await new Promise(resolve => setImmediate(resolve));
  const cancel = { job: j.id, lease: j.lease_token };
  assert.deepEqual(await worker.cancel(cancel, signer.issue(j, 'cancel', cancel)), { stopped: true });
  assert.deepEqual(await running, { status: 'failed', stopped: true });
  // 남은 프로세스를 확인하지 못하면 unknown이고 작업자는 그 뒤 실행을 받지 않는다.
  await mode({ kind: 'answer', answer: ANSWER });
  launcher.left = null;
  const k = job(); const second = chatRequest(k);
  assert.deepEqual(await worker.execute(second, signer.issue(k, 'execute', second), new AbortController().signal), { status: 'unknown', stopped: false });
  const l = job(); const third = chatRequest(l);
  await assert.rejects(worker.execute(third, signer.issue(l, 'execute', third), new AbortController().signal), /worker_busy/);
  assert.equal(consumed, 4);
});

test('WRK-10 작업자 env는 키 이름만 알리고, 공개 키·경로 모양이 틀리면 기동 실패', async () => {
  assert.equal(await code(Promise.resolve().then(() => workerConfig({}))), `config_missing:${WORKER_ENV.join(',')}`);
  const config = workerConfig(env({ HTTPS_PROXY: 'http://10.43.0.28:3128' }));
  assert.equal(config.seedFile, join(seedDir, 'CODEX_AUTH_JSON'));
  assert.deepEqual(config.proxy, { https: 'http://10.43.0.28:3128', noProxy: '127.0.0.1,localhost' });
  assert.equal(workerConfig(env({ WORKER_CODEX_BIN: undefined })).codexBin, '/usr/local/bin/codex');
  // 한 줄로 넣은 PEM(\n 이스케이프)도 받는다.
  assert.equal(workerConfig(env({ WORKER_CONTROL_PUBLIC_KEY: publicPem.replace(/\n/g, '\\n') })).publicKey.asymmetricKeyType, 'ed25519');
  const rsa = generateKeyPairSync('rsa', { modulusLength: 2048 }).publicKey.export({ type: 'spki', format: 'pem' }).toString();
  const invalid: [Record<string, string>, string][] = [
    [{ WORKER_CONTROL_PUBLIC_KEY: 'not a key' }, 'config_invalid:WORKER_CONTROL_PUBLIC_KEY'],
    [{ WORKER_CONTROL_PUBLIC_KEY: rsa }, 'config_invalid:WORKER_CONTROL_PUBLIC_KEY'],
    [{ WORKER_CONTROL_PUBLIC_KEY: keys.privateKey.export({ type: 'pkcs8', format: 'pem' }).toString() }, 'config_invalid:WORKER_CONTROL_PUBLIC_KEY'],
    [{ CODEX_HOME: 'relative/home' }, 'config_invalid:CODEX_HOME'],
    [{ WORKER_SEED_KEY: '../auth.json' }, 'config_invalid:WORKER_SEED_KEY'],
    [{ WORKER_NONCE_DIR: codexHome }, 'config_invalid:WORKER_NONCE_DIR'],
  ];
  for (const [overrides, expected] of invalid) assert.equal(await code(Promise.resolve().then(() => workerConfig(env(overrides)))), expected);
});
test('WRK-11 readiness: codex 0.163.0 확인·시드 복사 뒤 GET /readyz 200, 다른 버전·시드 없음이면 기동 실패', async () => {
  assert.equal(await codexVersion(fakeBin), '0.163.0');
  await writeFile(join(fakeDir, 'version.txt'), 'codex-cli 0.162.0\n');
  assert.equal(await startCode(), 'codex_version_mismatch');
  await writeFile(join(fakeDir, 'version.txt'), 'something else\n');
  assert.equal(await startCode(), 'codex_version_unavailable');
  await writeFile(join(fakeDir, 'version.txt'), 'codex-cli 0.163.0\n');
  await rm(join(seedDir, 'CODEX_AUTH_JSON'));
  assert.equal(await startCode(), 'seed_missing');
  await assert.rejects(lstat(join(codexHome, 'auth.json')));
  await writeFile(join(seedDir, 'CODEX_AUTH_JSON'), SEED);
  const worker = await startWorker(workerConfig(env()), { port: 0, host: '127.0.0.1', launcher: new SpawnLauncher(fakeBin) });
  try {
    assert.equal(worker.seed, 'seeded');
    const url = `http://127.0.0.1:${(worker.server.address() as AddressInfo).port}`;
    assert.equal((await fetch(`${url}/readyz`)).status, 200);
    assert.equal((await fetch(`${url}/`)).status, 404);
    assert.equal((await fetch(`${url}/readyz`, { method: 'POST' })).status, 404);
    assert.equal((await fetch(`${url}/v1/execute`, { method: 'POST', body: '{}' })).status, 401);
    // 영속 공간의 auth.json을 잃으면 Ready에서 빠진다(사람 재시드 절차).
    await rm(join(codexHome, 'auth.json'));
    assert.equal((await fetch(`${url}/readyz`)).status, 503);
  } finally { await worker.close(); }
});
test('WRK-12 HTTP 끝까지: 서명한 요청으로 대화 실행, 같은 capability는 작업자 재기동 뒤에도 거부', async () => {
  const signer = new WorkerSigner(keys.privateKey);
  const j = job(); const request = chatRequest(j);
  const token = signer.issue(j, 'execute', request);
  const launcher = new SpawnLauncher(fakeBin);
  const boot = () => startWorker(workerConfig(env()), { port: 0, host: '127.0.0.1', launcher });
  const call = async (worker: Awaited<ReturnType<typeof boot>>, capability: string) =>
    new HttpWorker(`http://127.0.0.1:${(worker.server.address() as AddressInfo).port}/`, fetch).execute(request, capability, new AbortController().signal);
  const first = await boot();
  try {
    assert.deepEqual(await call(first, token), { status: 'succeeded', stopped: true, answer: ANSWER });
    await assert.rejects(call(first, token), /worker_rejected/);
  } finally { await first.close(); }
  const second = await boot();
  try {
    assert.equal(second.seed, 'kept');
    await assert.rejects(call(second, token), /worker_rejected/);
    assert.equal(launcher.specs.length, 1);
    const k = job(); const next = chatRequest(k);
    const fresh = await new HttpWorker(`http://127.0.0.1:${(second.server.address() as AddressInfo).port}/`, fetch)
      .execute(next, signer.issue(k, 'execute', next), new AbortController().signal);
    assert.equal(fresh.status, 'succeeded');
  } finally { await second.close(); }
});
test('WRK-13 진입점 프로세스: env 누락·시드 없음은 종료 코드 1과 사유 코드만, 정상 기동 뒤 SIGTERM이면 0', async t => {
  const entry = resolve('dist/src/worker-main.js');
  const start = (vars: Record<string, string | undefined>) => {
    const child = spawn(process.execPath, [entry], { env: Object.fromEntries(Object.entries({ PATH: process.env.PATH, ...vars })
      .filter((pair): pair is [string, string] => pair[1] !== undefined)), stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    child.stdout.on('data', chunk => { out += chunk; }); child.stderr.on('data', chunk => { out += chunk; });
    return { child, output: () => out, exit: new Promise<number | null>(done => child.once('exit', code => done(code))) };
  };
  const missing = start({});
  assert.equal(await missing.exit, 1);
  assert.deepEqual(JSON.parse(missing.output().trim()), { component: 'worker', level: 'error', event: 'worker_start_failed',
    reason: `config_missing:${WORKER_ENV.join(',')}` });
  await rm(join(seedDir, 'CODEX_AUTH_JSON'));
  const noSeed = start(env());
  assert.equal(await noSeed.exit, 1);
  assert.match(noSeed.output(), /"reason":"seed_missing"/);
  assert.ok(!noSeed.output().includes('BEGIN PUBLIC KEY') && !noSeed.output().includes(FAKE_TOKEN.slice(0, 16)));
  await writeFile(join(seedDir, 'CODEX_AUTH_JSON'), `{"tokens":{"refresh_token":"${FAKE_TOKEN}"`);
  const broken = start(env());
  assert.equal(await broken.exit, 1);
  assert.match(broken.output(), /"reason":"seed_invalid"/);
  assert.ok(!broken.output().includes(FAKE_TOKEN.slice(0, 16)));
  await writeFile(join(seedDir, 'CODEX_AUTH_JSON'), SEED);
  // 정상 기동은 작업자 포트 8080을 쓴다. 이 기계에서 이미 쓰고 있으면 이 단계는 건너뛴다(결과에 skip으로 남는다).
  if (await fetch('http://127.0.0.1:8080/').then(() => true, () => false)) { t.skip('8080 사용 중'); return; }
  const running = start(env());
  while (!running.output().includes('worker_started')) {
    if (running.child.exitCode !== null) assert.fail(running.output());
    await new Promise(resolve => setTimeout(resolve, 20));
  }
  assert.match(running.output(), /"seed":"seeded"/);
  assert.equal((await fetch('http://127.0.0.1:8080/readyz')).status, 200);
  running.child.kill('SIGTERM');
  assert.equal(await running.exit, 0);
});
test('WRK-14 시드·nonce 디렉터리가 사람 홈이나 그 아래 .codex*(심링크 포함)면 읽거나 쓰기 전에 기동 실패', async () => {
  const human = join(base, 'human');
  await mkdir(join(human, '.codex'), { recursive: true });
  await writeFile(join(human, '.codex', 'CODEX_AUTH_JSON'), SEED);
  await symlink(join(human, '.codex'), join(base, 'innocent-looking'));
  const cases: [Record<string, string>, string][] = [
    [{ WORKER_SEED_DIR: join(human, '.codex') }, 'config_invalid:WORKER_SEED_DIR'],
    [{ WORKER_SEED_DIR: join(base, 'innocent-looking') }, 'config_invalid:WORKER_SEED_DIR'],
    [{ WORKER_SEED_DIR: human }, 'config_invalid:WORKER_SEED_DIR'],
    [{ WORKER_NONCE_DIR: join(human, '.codex-work', 'nonces') }, 'config_invalid:WORKER_NONCE_DIR'],
    [{ WORKER_NONCE_DIR: join(base, 'innocent-looking', 'nonces') }, 'config_invalid:WORKER_NONCE_DIR'],
  ];
  for (const [overrides, expected] of cases) {
    assert.equal(await code(startWorker(workerConfig(env(overrides)), { port: 0, host: '127.0.0.1', homes: [human] })
      .then(worker => worker.close())), expected, JSON.stringify(overrides));
    await assert.rejects(lstat(join(codexHome, 'auth.json')));
  }
  await assert.rejects(lstat(join(human, '.codex-work')));
  await assert.rejects(lstat(join(human, '.codex', 'nonces')));
});
test('WRK-15 종료 신호 때 실행 중인 대화는 codex를 멈추고 failed로 답한 뒤 닫음(게시 서버가 unknown으로 두지 않게)', async () => {
  await mode({ kind: 'hang' });
  const launcher = new SpawnLauncher(fakeBin);
  const worker = await startWorker(workerConfig(env()), { port: 0, host: '127.0.0.1', launcher });
  const signer = new WorkerSigner(keys.privateKey);
  const j = job(); const request = chatRequest(j);
  const client = new HttpWorker(`http://127.0.0.1:${(worker.server.address() as AddressInfo).port}/`, fetch);
  const running = client.execute(request, signer.issue(j, 'execute', request), new AbortController().signal);
  while (launcher.specs.length < 1) await new Promise(resolve => setImmediate(resolve));
  await worker.close();
  assert.deepEqual(await running, { status: 'failed', stopped: true });
  assert.deepEqual(launcher.aborted, [j.id]);
});
