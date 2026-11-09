import { generateKeyPairSync } from 'node:crypto';
import { chmod, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ProcessCleanup } from '../src/process-launcher.js';
import type { ArchiveFetcher } from '../src/review-input.js';
import { TASK_ENDPOINTS, TaskWorkerSigner } from '../src/task-contracts.js';
import type { TaskEndpoint } from '../src/task-contracts.js';
import { startWorker, workerConfig } from '../src/worker-main.js';
import type { RunningWorker, StartWorkerOptions } from '../src/worker-main.js';
import { archive } from './task-fixtures.js';

// 작업 레인 작업자 시험 도구. 실제 진입점(startWorker)과 실제 ProcessGroupLauncher로 띄우고 claude 자리에 가짜 실행 파일을 둔다.
// 모델·네트워크 없음. 파드 PID 공간 정리만 가짜다. 개발 기계에서 kill(-1)이 나가면 안 된다. 진짜 정리는 task-process-containment.test.ts가 PID namespace 안에서 본다.
const TOKEN = 'sk-ant-oat01-fixture-token-ABCDEFGHIJKLMNOPQRSTUVWXYZ-0123456789';
export const FAKE_CLAUDE = `
const fs = require('node:fs');
const path = require('node:path');
const args = process.argv.slice(2);
if (args[0] === '--version') { process.stdout.write(fs.readFileSync(path.join(__dirname, 'version.txt'), 'utf8')); process.exit(0); }
fs.appendFileSync(path.join(__dirname, 'pids'), process.pid + '\\n');
const script = JSON.parse(fs.readFileSync(path.join(__dirname, 'script.json'), 'utf8'));
let input = '';
process.stdin.on('data', d => { input += d; });
process.stdin.on('end', () => {
  const resume = args.includes('--resume');
  const session = args[args.indexOf(resume ? '--resume' : '--session-id') + 1];
  const model = args[args.indexOf('--model') + 1];
  const calls = path.join(__dirname, 'calls.jsonl');
  const index = fs.existsSync(calls) ? fs.readFileSync(calls, 'utf8').split('\\n').filter(Boolean).length : 0;
  fs.appendFileSync(calls, JSON.stringify({ args, cwd: process.cwd(), input, session, resume, config: process.env.CLAUDE_CONFIG_DIR, token: process.env.CLAUDE_CODE_OAUTH_TOKEN, scrub: process.env.CLAUDE_CODE_SUBPROCESS_ENV_SCRUB }) + '\\n');
  const step = script[Math.min(index, script.length - 1)];
  const dir = path.join(process.env.CLAUDE_CONFIG_DIR, 'projects', 'workspace');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, session + '.jsonl'), '{}\\n');
  for (const [file, data] of Object.entries(step.write ?? {})) { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, data); }
  const emit = e => process.stdout.write(JSON.stringify({ session_id: session, ...e }) + '\\n');
  emit({ type: 'system', subtype: 'init', tools: ['Bash', 'Edit', 'Read', 'StructuredOutput', 'Write'], mcp_servers: [], model, permissionMode: 'default',
    slash_commands: [], apiKeySource: 'none', claude_code_version: '2.1.308', skills: [], plugins: [] });
  if (step.kind === 'hang') { setInterval(() => {}, 1000); return; }
  emit({ type: 'assistant', message: { model, content: [{ type: 'tool_use', id: 'toolu_out', name: 'StructuredOutput', input: step.output }] } });
  process.stdout.write(JSON.stringify({ type: 'result', subtype: 'success', is_error: false, session_id: session, structured_output: step.output,
    usage: { input_tokens: 1, output_tokens: 1 } }) + '\\n', () => process.exit(0));
});
`;
// output은 가짜 CLI가 structured_output으로 그대로 낸다. 변경 작성 판의 칸(options·checks·risks)이나 깨진 모양도 담을 수 있다.
export type Step = { kind?: 'hang'; output?: { status: string; summary: string; question: string } & Record<string, unknown>; write?: Record<string, string> };
export const COMPLETED: Step = { output: { status: 'completed', summary: '끝냈습니다.', question: '' } };
export const QUESTION: Step = { output: { status: 'needs_input', summary: '', question: '어느 파일을 고칠까요?' } };

// 가짜 정리. 가짜 CLI가 적어 둔 PID만 끝낸다. survivors를 덮어 소멸 확인 실패를 만든다.
export class FakeCleanup implements ProcessCleanup {
  terminated = 0;
  override: number | null | undefined;
  constructor(private readonly pidFile: string) {}
  private async pids(): Promise<number[]> {
    return (await readFile(this.pidFile, 'utf8').catch(() => '')).split('\n').filter(Boolean).map(Number);
  }
  async terminate(): Promise<void> {
    this.terminated++;
    for (const pid of await this.pids()) { try { process.kill(pid, 'SIGKILL'); } catch { /* 이미 끝남 */ } }
    for (let attempt = 0; attempt < 200 && (await this.alive()) > 0; attempt++) await new Promise(resolve => setTimeout(resolve, 5));
  }
  private async alive(): Promise<number> {
    let count = 0;
    for (const pid of await this.pids()) { try { process.kill(pid, 0); count++; } catch { /* 없음 */ } }
    return count;
  }
  async survivors(): Promise<number | null> { return this.override !== undefined ? this.override : this.alive(); }
  busy(): boolean { return false; }
}

export interface WorkerFixture {
  base: string; root: string; url: string; running: RunningWorker; cleanup: FakeCleanup; publicPem: string; signer: TaskWorkerSigner;
  fetchArchive: ArchiveFetcher; archiveUrls: string[];
  env: Record<string, string>;
  script(steps: Step[]): Promise<void>;
  calls(): Promise<{ args: string[]; cwd: string; input: string; session: string; resume: boolean; config: string; token: string; scrub: string }[]>;
  restart(options?: Partial<StartWorkerOptions>): Promise<void>;
  post(path: string, body: unknown, token?: string): Promise<{ status: number; json: any }>;
  signed(endpoint: TaskEndpoint, body: unknown, signer?: TaskWorkerSigner): Promise<{ status: number; json: any }>;
  close(): Promise<void>;
}
// 이미지 검사가 통과하는 가짜 루트. 운영 이미지에 있어야 하는 도구 자리만 만든다.
export async function imageRoot(base: string, present = ['usr/bin/bwrap', 'usr/bin/socat', 'usr/bin/git']): Promise<string> {
  const root = join(base, 'image');
  await mkdir(join(root, 'usr', 'bin'), { recursive: true });
  for (const path of present) await writeFile(join(root, path), '');
  return root;
}
export const ARCHIVE = () => archive([{ name: 'src/app.txt', data: 'one\n' }, { name: 'README.md', data: '# fixture\n' }]);

export async function workerFixture(options: { lanes?: string; start?: Partial<StartWorkerOptions> } = {}): Promise<WorkerFixture> {
  const base = await realpath(await mkdtemp(join(tmpdir(), 't18-b5-')));
  const fake = join(base, 'fake');
  const credential = join(base, 'credential');
  const root = join(base, 'state');
  for (const dir of [fake, credential, root]) await mkdir(dir, { recursive: true });
  await writeFile(join(credential, 'CLAUDE_CODE_OAUTH_TOKEN'), `${TOKEN}\n`);
  await writeFile(join(fake, 'claude.cjs'), FAKE_CLAUDE);
  const bin = join(fake, 'claude');
  await writeFile(bin, `#!/bin/sh\nexec "${process.execPath}" "${join(fake, 'claude.cjs')}" "$@"\n`);
  await chmod(bin, 0o755);
  await writeFile(join(fake, 'version.txt'), '2.1.308 (Claude Code)\n');
  await writeFile(join(fake, 'script.json'), JSON.stringify([COMPLETED]));
  const keys = generateKeyPairSync('ed25519');
  const publicPem = keys.publicKey.export({ type: 'spki', format: 'pem' }).toString();
  const signer = new TaskWorkerSigner(keys.privateKey);
  const env: Record<string, string> = { WORKER_EXECUTOR: 'claude', WORKER_MODEL: 'claude-opus-5-5', WORKER_CREDENTIAL_DIR: credential, WORKER_CREDENTIAL_KEY: 'CLAUDE_CODE_OAUTH_TOKEN',
    WORKER_NONCE_DIR: join(root, '.homelab-worker', 'nonces'), WORKER_CONTROL_PUBLIC_KEY: publicPem, WORKER_EXECUTOR_BIN: bin,
    ...(options.lanes === undefined ? { WORKER_LANES: 'task', TASK_STATE_ROOT: root } : options.lanes ? { WORKER_LANES: options.lanes } : {}) };
  const cleanup = new FakeCleanup(join(fake, 'pids'));
  const archiveUrls: string[] = [];
  const fetchArchive: ArchiveFetcher = async url => { archiveUrls.push(url); return ARCHIVE(); };
  const image = await imageRoot(base);
  const boot = async (extra: Partial<StartWorkerOptions> = {}) => startWorker(workerConfig(env), { port: 0, host: '127.0.0.1', homes: [], fetchArchive, cleanup, fsRoot: image,
    log: () => {}, ...options.start, ...extra });
  const fixture: WorkerFixture = {
    base, root, url: '', running: undefined as unknown as RunningWorker, cleanup, publicPem, signer, fetchArchive, archiveUrls, env,
    script: steps => writeFile(join(fake, 'script.json'), JSON.stringify(steps)),
    calls: async () => (await readFile(join(fake, 'calls.jsonl'), 'utf8').catch(() => '')).split('\n').filter(Boolean).map(line => JSON.parse(line)),
    async restart(extra) {
      await fixture.running.close();
      fixture.running = await boot(extra);
      fixture.url = `http://127.0.0.1:${(fixture.running.server.address() as AddressInfo).port}`;
    },
    async post(path, body, token) {
      const response = await fetch(`${fixture.url}${path}`, { method: 'POST', headers: { 'content-type': 'application/json', ...(token ? { authorization: `Capability ${token}` } : {}) }, body: JSON.stringify(body) });
      return { status: response.status, json: await response.json().catch(() => null) };
    },
    signed(endpoint, body, by = signer) {
      const parsed = TASK_ENDPOINTS[endpoint].request.parse(body) as { version: 1; job: string; lease: string; generation: number };
      return fixture.post(endpoint, parsed, by.issue(TASK_ENDPOINTS[endpoint].operation, parsed));
    },
    async close() {
      await fixture.running.close().catch(() => {});
      await chmod(root, 0o700).catch(() => {});
      await rm(base, { recursive: true, force: true });
    },
  };
  fixture.running = await boot();
  fixture.url = `http://127.0.0.1:${(fixture.running.server.address() as AddressInfo).port}`;
  return fixture;
}
