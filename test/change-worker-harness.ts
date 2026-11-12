import { generateKeyPairSync, randomUUID } from 'node:crypto';
import { chmod, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { gitBlobSha } from '../src/change-contracts.js';
import { gitTreeSha } from '../src/change-artifact.js';
import { IsolatedVerifier } from '../src/change-verifier.js';
import type { VerifierOptions } from '../src/change-verifier.js';
import { MethodEnvCredential, StaticEnvCredential } from '../src/credentials.js';
import { runChangeTurn } from '../src/executor-claude-task.js';
import { ProcessGroupLauncher } from '../src/process-launcher.js';
import type { ArchiveFetcher } from '../src/review-input.js';
import { RunControl } from '../src/run-control.js';
import { TASK_V2_ENDPOINTS, TASK_INSTRUCTIONS_REVISION, TaskWorkerSigner } from '../src/task-contracts.js';
import type { BaselineLeaf, TaskV2Endpoint } from '../src/task-contracts.js';
import { HttpTaskV2Worker, taskWorkerServer } from '../src/task-http.js';
import { TaskWorkerService } from '../src/task-worker.js';
import { LIMITS, SHA, archive } from './task-fixtures.js';
import type { TarItem } from './task-fixtures.js';
import { COMPLETED, FAKE_CLAUDE, FakeCleanup } from './task-worker-harness.js';
import type { Step } from './task-worker-harness.js';

// CHANGE v2 작업자 시험 도구. 실제 TaskWorkerService·라우트·ProcessGroupLauncher·runChangeTurn으로 띄우고 claude 자리에 가짜 실행 파일을 둔다. 조립(worker-main)은 B5 몫이라 여기서 직접 짠다.
// 값은 모두 합성이다. 자격은 합성 토큰이고 모델·외부 네트워크가 없다.
export const FIXTURE_TOKEN = 'sk-ant-oat01-fixture-token-ABCDEFGHIJKLMNOPQRSTUVWXYZ-0123456789';
export const BASE_ITEMS: TarItem[] = [{ name: 'README.md', data: '# fixture\n' }, { name: 'src/app.txt', data: 'one\n' }, { name: 'src/run.sh', data: '#!/bin/sh\n', mode: 0o755 }, { name: 'src/old.txt', data: 'old\n' }];
export const leavesOf = (items: readonly TarItem[]): BaselineLeaf[] => items.filter(item => (item.type ?? '0') === '0')
  .map(item => ({ path: item.name, mode: (item.mode ?? 0o644) & 0o100 ? '100755' : '100644', blobSha: gitBlobSha(Buffer.from(item.data ?? '')) }));
export const baseTreeOf = (items: readonly TarItem[]) => gitTreeSha(leavesOf(items));
const LANE_LIMITS = { ...LIMITS };

export interface ChangeWorkerFixture {
  base: string; root: string; url: string; port: HttpTaskV2Worker; cleanup: FakeCleanup; signer: TaskWorkerSigner; service: TaskWorkerService; running: Server;
  archiveUrls: string[];
  script(steps: Step[]): Promise<void>;
  calls(): Promise<{ args: string[]; cwd: string; input: string; session: string; resume: boolean }[]>;
  // 시험이 꺼진 사이에 볼륨을 망가뜨리는 자리가 between이다.
  restart(between?: () => Promise<void>): Promise<void>;
  close(): Promise<void>;
  start(overrides?: Record<string, unknown>): any;
  raw(endpoint: string, body: unknown, token?: string): Promise<{ status: number; json: any }>;
  signed(endpoint: TaskV2Endpoint, body: unknown): Promise<{ status: number; json: any }>;
}
export async function changeWorkerFixture(options: { items?: TarItem[]; currentItems?: () => TarItem[]; verifier?: Partial<VerifierOptions>; change?: boolean;
  // 게시 서버 서명 시계. 두 요청을 같은 밀리초에 서명시키는 시험이 쓴다.
  signerNow?: () => number;
  // 두 방식과 계정 묶음을 함께 설치한 운영 자격 조립(방식 선택 시험, DECISIONS "C39"). 묶음·API 키 파일은 시험이 쓴다.
  methods?: boolean; } = {}): Promise<ChangeWorkerFixture> {
  const base = await realpath(await mkdtemp(join(tmpdir(), 't19-b1-')));
  const fake = join(base, 'fake');
  const credential = join(base, 'credential');
  const root = join(base, 'state');
  for (const dir of [fake, credential, root]) await mkdir(dir, { recursive: true });
  const credentialFile = join(credential, 'CLAUDE_CODE_OAUTH_TOKEN');
  await writeFile(credentialFile, `${FIXTURE_TOKEN}\n`);
  await writeFile(join(fake, 'claude.cjs'), FAKE_CLAUDE);
  const bin = join(fake, 'claude');
  await writeFile(bin, `#!/bin/sh\nexec "${process.execPath}" "${join(fake, 'claude.cjs')}" "$@"\n`);
  await chmod(bin, 0o755);
  await writeFile(join(fake, 'version.txt'), '2.1.308 (Claude Code)\n');
  await writeFile(join(fake, 'script.json'), JSON.stringify([COMPLETED]));
  const keys = generateKeyPairSync('ed25519');
  const signer = new TaskWorkerSigner(keys.privateKey, options.signerNow);
  const cleanup = new FakeCleanup(join(fake, 'pids'));
  const items = options.items ?? BASE_ITEMS;
  const archiveUrls: string[] = [];
  const fetchArchive: ArchiveFetcher = async url => { archiveUrls.push(url); return archive(options.currentItems?.() ?? items); };
  const boot = async (): Promise<{ service: TaskWorkerService; running: Server; url: string; close: () => Promise<void> }> => {
    const credentialStore = options.methods
      ? new MethodEnvCredential({ subscription: credentialFile, api: join(credential, 'ANTHROPIC_API_KEY') }, join(credential, 'CLAUDE_AUTH_METHOD'), [],
        join(credential, 'CLAUDE_ACCOUNT_BUNDLE'))
      : new StaticEnvCredential(credentialFile, []);
    const launcher = new ProcessGroupLauncher([bin], { cleanup });
    const control = new RunControl(credentialStore, launcher, { homes: [] });
    const verifier = new IsolatedVerifier({ imageRevision: 'fixture-image', cleanup, secrets: () => credentialStore.secrets(), ...options.verifier });
    const service = new TaskWorkerService({ root, nonceDir: join(root, '.homelab-worker', 'nonces'), publicKey: keys.publicKey, homes: [], startup: [], log: () => {},
      runTurn: async () => { throw new Error('v1_not_used'); },
      ...(options.change === false ? {} : { change: { verifier, runTurn: ({ worker, sessions }, request, signal) => runChangeTurn({ control, sessions, fetchArchive, worker, model: 'claude-opus-5-5', auth: 'subscription-token', credentialDir: credential }, request, signal) } }),
      stop: job => control.stop(job), survivors: job => launcher.survivors(job), accepting: () => control.accepting(), credentialReady: () => credentialStore.ready() });
    const running = taskWorkerServer(service, { lanes: { task: true } }, () => {});
    await service.start();
    await new Promise<void>(resolve => running.listen(0, '127.0.0.1', resolve));
    return { service, running, url: `http://127.0.0.1:${(running.address() as AddressInfo).port}`,
      close: async () => { await Promise.all([control.shutdown(), service.shutdown()]); running.closeAllConnections(); await new Promise(resolve => running.close(resolve)); } };
  };
  let instance = await boot();
  const fixture: ChangeWorkerFixture = {
    base, root, url: instance.url, port: new HttpTaskV2Worker(instance.url, signer, fetch), cleanup, signer, service: instance.service, running: instance.running, archiveUrls,
    script: steps => writeFile(join(fake, 'script.json'), JSON.stringify(steps)),
    calls: async () => (await readFile(join(fake, 'calls.jsonl'), 'utf8').catch(() => '')).split('\n').filter(Boolean).map(line => JSON.parse(line)),
    async restart(between) {
      await instance.close();
      await between?.();
      instance = await boot();
      Object.assign(fixture, { url: instance.url, service: instance.service, running: instance.running, port: new HttpTaskV2Worker(instance.url, signer, fetch) });
    },
    async close() { await instance.close().catch(() => {}); await rm(base, { recursive: true, force: true }); },
    start: (overrides = {}) => ({ version: 2, lane: 'task', job: randomUUID(), lease: randomUUID(), generation: 1, policyRevision: 'policy-1', instructions: TASK_INSTRUCTIONS_REVISION,
      sessionId: randomUUID(), repository: 'fixture/repo', base: SHA, project: { id: 'fixture', revision: 'r1', allowedPaths: ['src', 'README.md'], forbiddenPaths: ['src/secret'], verifyCommands: ['smoke-unit'] },
      timeoutMs: 60_000, runBudgetRemainingMs: 120_000, toolCalls: 4, limits: { ...LANE_LIMITS }, operation: 'start', turn: 1,
      baseline: { repoId: 4242, changeGeneration: 1, baseTree: baseTreeOf(items), leaves: leavesOf(items) }, untrusted: { request: '고쳐라' }, ...overrides }),
    async raw(endpoint, body, token) {
      const response = await fetch(`${fixture.url}${endpoint}`, { method: 'POST', headers: { 'content-type': 'application/json', ...(token ? { authorization: `Capability ${token}` } : {}) }, body: JSON.stringify(body) });
      return { status: response.status, json: await response.json().catch(() => null) };
    },
    signed(endpoint, body) {
      const parsed = TASK_V2_ENDPOINTS[endpoint].request.parse(body) as { version: 2; job: string; lease: string; generation: number };
      return fixture.raw(endpoint, parsed, signer.issue(TASK_V2_ENDPOINTS[endpoint].operation, parsed));
    },
  };
  return fixture;
}
export const identity = (request: { job: string; lease: string; generation: number; sessionId: string }) => ({ version: 2 as const, job: request.job, lease: request.lease, generation: request.generation, sessionId: request.sessionId });
// 턴이 끝나 결과가 저장될 때까지 재조회한다.
export async function settledResult(fixture: ChangeWorkerFixture, request: { job: string; lease: string; generation: number; sessionId: string }): Promise<any> {
  for (let attempt = 0; attempt < 400; attempt++) {
    const reply = await fixture.signed('/v2/task/result', { ...identity(request), expectedWorker: null });
    if (reply.status !== 200) throw new Error(`result_status_${reply.status}`);
    if (reply.json.status !== 'running') return reply.json;
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  throw new Error('result_timeout');
}
