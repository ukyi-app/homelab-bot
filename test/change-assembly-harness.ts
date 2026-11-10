import { generateKeyPairSync } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { readFile, realpath } from 'node:fs/promises';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { assembleChange, assembleChangeReview, changeCommandHandler, guardedTaskCommands } from '../src/change-assembly.js';
import { sha256Hex } from '../src/change-contracts.js';
import type { ChangePhase } from '../src/change-contracts.js';
import { ChangeReviewResults, ChangeReviewWorker, changeReviewRoutes } from '../src/change-review.js';
import type { ChangeReviewOutput, ChangeReviewerInput, ChangeReviewerModel } from '../src/change-review.js';
import type { ChangeRuntime, ChangeRuntimeDeps } from '../src/change-runtime.js';
import type { ChangeStore } from '../src/change-store.js';
import { spawnSandbox } from '../src/change-verifier.js';
import type { SandboxRunner } from '../src/change-verifier.js';
import { ClaudeTaskBridge } from '../src/claude-task-bridge.js';
import type { Scope } from '../src/contracts.js';
import type { Database } from '../src/database.js';
import { DiscordIngress, DiscordPublisher } from '../src/discord.js';
import { PolicyGate } from '../src/policy.js';
import type { Policy } from '../src/policy.js';
import { ReviewRuntime } from '../src/review.js';
import { Store } from '../src/store.js';
import { TaskCommands } from '../src/task-commands.js';
import { HttpTaskWorker } from '../src/task-http.js';
import { TASK_INTAKE_UNREACHED } from '../src/task-http.js';
import { WorkerSigner, WorkerVerifier, SerialWorker } from '../src/worker.js';
import { workerServer } from '../src/worker-http.js';
import { DEFAULT_CHANGES, FAKE_APP_KEY, REPO, publishEnv } from './change-github-fake.js';
import type { PublishEnv } from './change-github-fake.js';
import { OWNER } from './change-store-fixture.js';
import { changeWorkerFixture } from './change-worker-harness.js';
import type { ChangeWorkerFixture } from './change-worker-harness.js';
import { MockDiscord } from './helpers.js';
import { archive } from './task-fixtures.js';
import { COMPLETED } from './task-worker-harness.js';
import type { Step } from './task-worker-harness.js';

// CHANGE 전체 연결 시험 도구. 실제 ChangeRuntime·ClaudeTaskBridge·TaskWorkerService·ChangeReviewService·ChangePublisher·저장 계층을 main과 같은 함수로 잇는다.
// 가짜는 셋이다. claude 실행 파일, GitHub HTTP, 리뷰 모델. 값은 모두 합성이다.
export const THREAD: Scope = { guild: 'fixture-guild', channel: 'fixture-thread', parent: 'fixture-chat', kind: 'thread' };
export const OTHER_THREAD: Scope = { guild: 'fixture-guild', channel: 'fixture-thread-2', parent: 'fixture-chat', kind: 'thread' };
const PASS_OUTPUT: ChangeReviewOutput = { goal: 'met', acceptance: [{ index: 0, status: 'met' }], reviewed_paths: ['src/a.ts', 'src/new.ts'], findings: [], summary: '문제를 찾지 못했다.' };
export const WRITE_STEP: Step = { ...COMPLETED, write: Object.fromEntries(DEFAULT_CHANGES.map(change => [change.path, change.content!])) };
export const REQUEST_TEXT = '공개 요약 | goal=공개 목표 | accept=시험 통과 | label=public';
export const bwrapReady = (() => {
  const probe = spawnSync('/usr/bin/bwrap', ['--unshare-all', '--ro-bind', '/usr', '/usr', '--ro-bind-try', '/bin', '/bin', '--ro-bind-try', '/lib', '/lib', '--ro-bind-try', '/lib64', '/lib64', '/bin/sh', '-c', 'exit 0'], { timeout: 10_000 });
  return probe.status === 0;
})();
const shSha = async () => sha256Hex(await readFile(await realpath('/bin/sh')));

export interface Crash { point: string; when: 'before' | 'after' }
export class SimulatedCrash extends Error { constructor(point: string) { super(`simulated_crash:${point}`); } }
export interface HarnessOptions {
  script?: string | ((f: ChangeWorkerFixture) => string); sandbox?: SandboxRunner; steps?: Step[]; reviewReply?: () => Awaited<ReturnType<ChangeReviewerModel>>;
  policyPatch?: (policy: Policy) => Policy; change?: boolean; crash?: Crash;
  // 동료 기능 스위치(Store.colleague). 기본 꺼짐.
  colleague?: boolean;
}
export interface Harness {
  db: Database; env: PublishEnv; f: ChangeWorkerFixture; store: Store; changes: ChangeStore; gate: PolicyGate; policy: { current: Policy }; rest: MockDiscord; ingress: DiscordIngress; discord: DiscordPublisher;
  logs: { event: string; fields: unknown }[]; reviewInputs: ChangeReviewerInput[]; runs: { verify: number }; worker: { taskOpen: boolean; unreachable: boolean };
  runtime: ChangeRuntime; reviewRuntime: ReviewRuntime; bridge: ClaudeTaskBridge;
  command(id: string, command: string, fields?: { target?: string; text?: string; scope?: Scope; actor?: string }): Promise<void>;
  pump(done: () => Promise<boolean>, rounds?: number): Promise<void>;
  phase(id: string): Promise<ChangePhase>;
  changeId(): Promise<string>;
  acknowledgements(): string[];
  deliver(): Promise<void>;
  messages(): string[];
  stop(): void;
  restart(options?: { crash?: Crash; instrument?: (deps: ChangeRuntimeDeps) => ChangeRuntimeDeps }): void;
  close(): Promise<void>;
}
// 지정한 지점에서 한 번 끊는다. before면 호출이 일어나지 않았고 after면 호출은 끝났는데 결과를 잃은 것이다.
function crashing<T extends object>(name: string, port: T, plan: { crash?: Crash; fired: boolean }): T {
  return new Proxy(port, { get(target, property, receiver) {
    const value = Reflect.get(target, property, receiver) as unknown;
    if (typeof value !== 'function') return value;
    const point = `${name}.${String(property)}`;
    return async (...args: unknown[]) => {
      if (plan.crash?.point === point && !plan.fired && plan.crash.when === 'before') { plan.fired = true; throw new SimulatedCrash(point); }
      const result = await (value as (...inner: unknown[]) => unknown).apply(target, args);
      if (plan.crash?.point === point && !plan.fired && plan.crash.when === 'after') { plan.fired = true; throw new SimulatedCrash(point); }
      return result;
    };
  } });
}

export async function changeHarness(db: Database, options: HarnessOptions = {}): Promise<Harness> {
  const items = () => {
    const head = env.github.refs.get('heads/main')!;
    return env.github.leaves(env.github.commits.get(head)!.tree).map(leaf => ({ name: leaf.path, data: env.github.blobs.get(leaf.blobSha)!.toString() }));
  };
  const runs = { verify: 0 };
  const registry = { 'smoke-unit': { argv: ['/bin/sh', '-c', 'cat src/a.ts'], cwd: '.', timeoutMs: 30_000, outputBytes: 1024 * 1024, scratchBytes: 1024 * 1024, env: {}, toolchain: { path: '/bin/sh', sha256: await shSha() } } };
  const pass: SandboxRunner = async () => ({ started: true, exitCode: 0, timedOut: false, overflow: false, aborted: false, log: Buffer.from('ok\n'), logBytes: 3, logDigest: 'a'.repeat(64) });
  const inner = options.sandbox ?? (bwrapReady ? spawnSandbox : pass);
  const env = await publishEnv(db);
  env.github.clock = Date.now();
  const f = await changeWorkerFixture({ currentItems: items, change: options.change, verifier: { registry, sandbox: (args, limits, signal) => { runs.verify++; return inner(args, limits, signal); } } });
  await f.script(options.steps ?? [WRITE_STEP]);
  if (options.script) registry['smoke-unit'].argv = ['/bin/sh', '-c', typeof options.script === 'function' ? options.script(f) : options.script];
  const logs: Harness['logs'] = [];
  const log = (event: string, fields?: unknown) => { logs.push({ event, fields }); };
  const policy: { current: Policy } = { current: { revision: env.policy.current!.revision, confirmedAt: Date.now() - 1000, owner: OWNER, guild: THREAD.guild!, conversationChannel: 'fixture-chat', notificationChannel: 'fixture-notifications',
    dmEnabled: null, services: ['fixture-app'], change: { repositories: [env.policy.current!] } } };
  if (options.policyPatch) policy.current = options.policyPatch(policy.current);
  const gate = new PolicyGate(async () => policy.current, db);
  const store = new Store(db, Date.now, options.colleague === true);
  const keys = generateKeyPairSync('ed25519');
  const used = new Set<string>();
  const signer = new WorkerSigner(keys.privateKey);
  const verifier = new WorkerVerifier(keys.publicKey, async nonce => { if (used.has(nonce)) return false; used.add(nonce); return true; });
  const reviewInputs: ChangeReviewerInput[] = [];
  const model: ChangeReviewerModel = async input => { reviewInputs.push(structuredClone(input)); return options.reviewReply?.() ?? { status: 'succeeded', output: PASS_OUTPUT }; };
  const reviewWorker = new ChangeReviewWorker(verifier, async () => archive(items()), model, new ChangeReviewResults(), 500);
  const reviewServer: Server = workerServer(new SerialWorker(verifier, async () => { throw new Error('chat_not_used'); }, async () => true), async () => true, () => true, changeReviewRoutes(reviewWorker, () => true));
  await new Promise<void>(resolve => reviewServer.listen(0, '127.0.0.1', resolve));
  const reviewUrl = `http://127.0.0.1:${(reviewServer.address() as AddressInfo).port}/`;
  const send: typeof fetch = async (input, init) => {
    env.github.clock = Date.now();
    const url = new URL(String(input));
    // 공개 PR 읽기는 FakeGitHub에 없다. 사람의 병합을 시험이 github.pulls의 값으로 나타낸다.
    const pull = /^\/repos\/fixture-org\/fixture-repo\/pulls\/(\d+)$/.exec(url.pathname);
    if (url.origin === 'https://api.github.com' && pull && (init?.method ?? 'GET') === 'GET') {
      const found = env.github.pulls.find(item => item.number === Number(pull[1]));
      if (!found) return new Response('{}', { status: 404 });
      return Response.json({ number: found.number, state: found.state, merged: found.merged_at !== null, merge_commit_sha: found.merged_at ? 'c'.repeat(40) : null, head: { sha: found.head.sha }, base: { repo: { id: REPO.id, full_name: REPO.fullName } } });
    }
    if (url.origin === 'https://api.github.com') return env.github.send(input, init);
    return fetch(input, init);
  };
  const worker = { taskOpen: true, unreachable: false };
  const reach = () => { if (worker.unreachable) throw new Error('task_worker_uncertain'); };
  const v1 = { call: async (endpoint: never, body: never, signal?: AbortSignal) => { reach(); return new HttpTaskWorker(f.url, f.signer, fetch).call(endpoint, body, signal); } };
  const v2 = { callV2: (async (endpoint: never, body: never, signal?: AbortSignal) => { reach(); return f.port.callV2(endpoint, body, signal); }) as typeof f.port.callV2, supportsChange: (signal?: AbortSignal) => f.port.supportsChange(signal) };
  let shutdown = new AbortController();
  const rest = new MockDiscord();
  const build = (runtimeOptions: { crash?: Crash; instrument?: (deps: ChangeRuntimeDeps) => ChangeRuntimeDeps } = {}) => {
    const plan = { crash: runtimeOptions.crash, fired: false };
    shutdown = new AbortController();
    const bridge = new ClaudeTaskBridge(store, gate, v1 as never, { plan: async () => { throw new Error('v1_plan_not_used'); } }, { log: () => {} }, v2);
    const review = assembleChangeReview({ store, gate, signer, workerUrl: reviewUrl, send: fetch, now: Date.now, shutdown: shutdown.signal, log });
    const assembled = assembleChange({ app: { appId: '12345', privateKey: FAKE_APP_KEY }, store, gate, changes: review.changes, review: review.service, bridge, worker: v2, kubernetes: { get: async () => { throw new Error('kubernetes_not_used'); } }, send, now: Date.now, log, shutdown: shutdown.signal,
      intakeOpen: () => worker.taskOpen, verificationPollMs: 2, periods: { authorPollMs: 0, mergePollMs: 0, failureBackoffMs: 0, failureBackoffMaxMs: 0, startGraceMs: 200 },
      deployTargets: [{ kind: 'app', service: 'fixture-app', repository: REPO.fullName, configRepository: 'fixture-org/config', imageFile: 'apps/fixture-app/image.yaml', imageRepository: 'ghcr.io/fixture-org/fixture-app', namespace: 'app-fixture-app', deployment: 'fixture-app', container: 'app', argoApplication: 'fixture-app', podApp: 'fixture-app' }],
      instrument: deps => {
        const wrapped: ChangeRuntimeDeps = { ...deps, author: crashing('author', deps.author, plan), artifacts: crashing('artifacts', deps.artifacts, plan), verification: crashing('verification', deps.verification, plan), review: crashing('review', deps.review, plan), publisher: crashing('publisher', deps.publisher, plan),
          changes: new Proxy(deps.changes, { get(target, property) {
            const value = Reflect.get(target, property) as unknown;
            if (typeof value !== 'function') return value;
            const point = `changes.${String(property)}`;
            return async (...args: unknown[]) => {
              if (plan.crash?.point === point && !plan.fired && plan.crash.when === 'before') { plan.fired = true; throw new SimulatedCrash(point); }
              const result = await (value as (...inner: unknown[]) => unknown).apply(target, args);
              if (plan.crash?.point === point && !plan.fired && plan.crash.when === 'after') { plan.fired = true; throw new SimulatedCrash(point); }
              return result;
            };
          } }) };
        return runtimeOptions.instrument ? runtimeOptions.instrument(wrapped) : wrapped;
      } });
    const reviewRuntime = new ReviewRuntime(store, null as never, null as never, null as never, null as never, signer, 5, { changeReview: review.service, lanes: true });
    const commands = changeCommandHandler({ store, gate, changes: review.changes, log, closedReason: () => null, runtime: assembled.runtime });
    const tasks = guardedTaskCommands(new TaskCommands(store, gate, bridge, () => TASK_INTAKE_UNREACHED, () => {}, () => {}), assembled.inputs, gate);
    const ingress = new DiscordIngress(store, gate, rest, true, undefined, () => {}, undefined, tasks, undefined, commands);
    return { runtime: assembled.runtime, reviewRuntime, ingress, changes: review.changes, bridge };
  };
  let built = build({ ...(options.crash ? { crash: options.crash } : {}) });
  const discord = new DiscordPublisher(store, gate, rest);
  const harness: Harness = {
    db, env, f, store, changes: built.changes, gate, policy, rest, ingress: built.ingress, discord, logs, reviewInputs, runs, worker, runtime: built.runtime, reviewRuntime: built.reviewRuntime, bridge: built.bridge,
    async command(id, command, fields = {}) {
      await harness.ingress.receive({ id, actor: fields.actor ?? OWNER, scope: fields.scope ?? THREAD, kind: 'command', command, text: fields.text ?? '', ...(fields.target !== undefined ? { target: fields.target } : {}) });
    },
    async pump(done, rounds = 600) {
      for (let round = 0; round < rounds; round++) {
        if (await done()) return;
        await harness.runtime.childrenTick();
        await harness.runtime.laneTick();
        await harness.runtime.publishTick();
        await harness.reviewRuntime.tick();
        await new Promise(resolve => setTimeout(resolve, 3));
      }
      const row = (await db.query<{ phase: string; phase_reason: string | null }>('SELECT phase,phase_reason FROM change_requests ORDER BY created_at DESC LIMIT 1')).rows[0];
      throw new Error(`pump_timeout phase=${row?.phase} reason=${row?.phase_reason} logs=${JSON.stringify(logs.slice(-8))}`);
    },
    phase: async id => (await db.query<{ phase: ChangePhase }>('SELECT phase FROM change_requests WHERE id=$1', [id])).rows[0]!.phase,
    changeId: async () => (await db.query<{ id: string }>('SELECT id FROM change_requests ORDER BY created_at DESC LIMIT 1')).rows[0]!.id,
    acknowledgements: () => [...ackTexts],
    async deliver() { for (let index = 0; index < 20; index++) { if (!await discord.deliver()) break; } },
    messages: () => rest.messages.map(message => message.body.content),
    stop() { shutdown.abort(); },
    restart(next = {}) {
      built = build(next);
      Object.assign(harness, { runtime: built.runtime, reviewRuntime: built.reviewRuntime, ingress: built.ingress, bridge: built.bridge, changes: built.changes });
    },
    async close() {
      shutdown.abort();
      reviewServer.closeAllConnections();
      await new Promise(resolve => reviewServer.close(resolve));
      await f.close();
    },
  };
  const ackTexts: string[] = [];
  const acknowledge = rest.acknowledge.bind(rest);
  rest.acknowledge = async (input, content, ackOptions) => { ackTexts.push(content); return acknowledge(input, content, ackOptions); };
  return harness;
}
