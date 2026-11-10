import { spawn } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { join } from 'node:path';
import { z } from 'zod';
import { freezeSource, materializeSource, snapshotSource, sourceUnchanged } from './change-artifact.js';
import { CommandIdSchema, EvidenceBundleSchema, VerificationReceiptSchema, evidenceBundleDigest } from './change-contracts.js';
import type { ArtifactBundle, ChangeKey, ChangeVerificationPort, EvidenceKey, EvidenceBundle, VerificationReceipt, VerificationStatus } from './change-contracts.js';
import { classify } from './review.js';
import type { RunDirs } from './executor.js';
import type { ProcessCleanup } from './process-launcher.js';
import type { TaskV2VerificationResponse } from './task-contracts.js';
import { TaskWorkerBusy, TaskWorkerRejected } from './task-bridge.js';
import { SecretScanner, removeTree } from './task-workspace.js';
import type { ArchiveLimits } from './task-workspace.js';

// 자격 없는 격리 시험 실행기. Claude를 감싸는 것이 아니라(T18에서 실패로 결정) 시험 프로세스만 독립 bwrap으로 띄운다.
// 작성자 프로세스가 모두 사라진 뒤 같은 직렬 슬롯에서 돈다. 입력은 command ID 하나이고 argv·cwd·한도·toolchain은 여기 고정 표에서 찾는다.
// bwrap은 빈 루트에서 시작해 허용 목록만 올린다. 가릴 경로를 나열하지 않으므로 자격·nonce·다른 세션·CLI 소켓은 처음부터 없다.

export const VERIFIER_REVISION = 'change-verifier-v1';
// Dockerfile의 고정값과 같다. 시험이 대조한다.
export const VERIFIER_TOOLCHAINS = Object.freeze({
  'bun-1.4.3': { path: '/opt/verifier/bun-1.4.3/bun', sha256: '7ce7d6b654eddeec20afddf2396317fba6dc19ab52788a27e894e1806bf8f24b' },
} as const);
export interface VerificationToolchain { path: string; sha256: string }
export interface VerificationCommand {
  argv: readonly string[]; cwd: string; timeoutMs: number; outputBytes: number; scratchBytes: number;
  env: Readonly<Record<string, string>>; toolchain: VerificationToolchain;
}
const BUN = VERIFIER_TOOLCHAINS['bun-1.4.3'];
export const VERIFICATION_COMMANDS: Readonly<Record<string, VerificationCommand>> = Object.freeze({
  // homelab-smoke의 기존 시험. 설치 없이 네트워크 없는 샌드박스에서 3건이 돈다(VERIFICATION "T19 B1 artifact·검증").
  'smoke-unit': { argv: [BUN.path, 'test', 'src/server.test.ts'], cwd: '.', timeoutMs: 120_000, outputBytes: 1024 * 1024, scratchBytes: 64 * 1024 * 1024,
    env: { NO_COLOR: '1', DO_NOT_TRACK: '1' }, toolchain: BUN },
});
export const VERIFICATION_EXCERPT_BYTES = 64 * 1024;

// 빈 루트에 올리는 목록. 값이 경계다. 넓히면 SEC-02 표를 다시 잰다.
const SYSTEM_RO = ['/usr', '/bin', '/lib', '/lib64', '/etc/ld.so.cache', '/etc/alternatives'];
const SOURCE = '/source';
const SCRATCH = '/scratch';
export function sandboxArgs(input: { source: string; command: VerificationCommand }): string[] {
  const { source, command } = input;
  const env: Record<string, string> = { PATH: '/usr/local/bin:/usr/bin:/bin', HOME: `${SCRATCH}/home`, TMPDIR: `${SCRATCH}/tmp`, LANG: 'C.UTF-8', ...command.env };
  return ['--unshare-all', '--die-with-parent', '--new-session', '--cap-drop', 'ALL', '--hostname', 'verifier', '--clearenv',
    ...Object.entries(env).flatMap(([name, value]) => ['--setenv', name, value]),
    ...SYSTEM_RO.flatMap(path => ['--ro-bind-try', path, path]),
    '--proc', '/proc', '--dev', '/dev',
    '--size', String(command.scratchBytes), '--tmpfs', SCRATCH, '--dir', `${SCRATCH}/home`, '--dir', `${SCRATCH}/tmp`, '--symlink', `${SCRATCH}/tmp`, '/tmp',
    '--ro-bind', source, SOURCE,
    ...(command.toolchain.path.startsWith('/usr/') || command.toolchain.path.startsWith('/bin/') ? [] : ['--ro-bind', command.toolchain.path, command.toolchain.path]),
    // bwrap의 빈 루트와 /dev는 크기 제한 없는 쓰기 가능 tmpfs다. 닫지 않으면 scratch 밖에 쓸 수 있고 상한도 없다.
    '--remount-ro', '/dev', '--remount-ro', '/',
    '--chdir', join(SOURCE, command.cwd),
    '--json-status-fd', '3', '--', ...command.argv];
}

export interface SandboxRun {
  // bwrap 준비(마운트·chdir·namespace)가 끝나고 시험 명령의 exec 직전까지 왔다는 표식이 있는가. 없으면 시험 실패가 아니라 미실행이다.
  started: boolean; exitCode: number | null; timedOut: boolean; overflow: boolean; aborted: boolean;
  log: Buffer; logBytes: number; logDigest: string;
}
export type SandboxRunner = (args: readonly string[], limits: { timeoutMs: number; outputBytes: number }, signal: AbortSignal) => Promise<SandboxRun>;

// 시작 표식. json-status의 child-pid는 bwrap이 clone한 직후에 나와 마운트·chdir 실패 뒤에도 있다. 그래서 bwrap이 준비를 다 마치고 exec한
// 고정 셸이 fd 4에 표식을 쓰고, fd 4를 닫은 뒤 시험 명령으로 exec한다. 시험 코드는 fd 4를 받지 못해 표식을 지우거나 덧쓰지 못한다.
// 남는 틈: 표식 뒤 시험 명령의 exec 자체가 실패하면(ELF 해석기 없음 등) 셸이 126·127로 끝나 failed가 된다. 실행 파일 유무는 표식 전에 본다.
const START_FD = 4;
const START_MARK = 'payload-start';
const START_SHIM = `[ -x "$0" ] || exit 127; printf ${START_MARK} >&${START_FD} || exit 127; exec ${START_FD}>&-; exec "$0" "$@"`;
export function withStartMark(args: readonly string[]): string[] {
  const split = args.indexOf('--');
  // 명령 경계가 없으면 감싸지 않는다. 표식이 없으니 미실행으로 닫힌다.
  if (split < 0 || split === args.length - 1) return [...args];
  return [...args.slice(0, split + 1), '/bin/sh', '-c', START_SHIM, ...args.slice(split + 1)];
}

// 자식 env는 비운다. 작업자 env에 공개 키·프록시·플랫폼 값이 있다. bwrap 안 env는 위 --setenv가 전부다.
export const spawnSandbox: SandboxRunner = (args, limits, signal) => new Promise(resolve => {
  const child = spawn('/usr/bin/bwrap', withStartMark(args), { env: {}, detached: true, stdio: ['ignore', 'pipe', 'pipe', 'pipe', 'pipe'] });
  const hash = createHash('sha256');
  const kept: Buffer[] = [];
  let keptBytes = 0;
  let logBytes = 0;
  let overflow = false;
  let timedOut = false;
  let aborted = false;
  const kill = () => { if (child.pid) { try { process.kill(-child.pid, 'SIGKILL'); } catch { /* 이미 끝남 */ } } };
  const onData = (chunk: Buffer) => {
    if (overflow) return;
    logBytes += chunk.length;
    hash.update(chunk);
    if (logBytes > limits.outputBytes) { overflow = true; kill(); return; }
    kept.push(chunk); keptBytes += chunk.length;
  };
  child.stdout!.on('data', onData);
  child.stderr!.on('data', onData);
  let status = '';
  (child.stdio[3] as NodeJS.ReadableStream).setEncoding('utf8');
  (child.stdio[3] as NodeJS.ReadableStream).on('data', (chunk: string) => { if (status.length < 16_384) status += chunk; });
  let mark = '';
  (child.stdio[START_FD] as NodeJS.ReadableStream).setEncoding('utf8');
  (child.stdio[START_FD] as NodeJS.ReadableStream).on('data', (chunk: string) => { if (mark.length < 64) mark += chunk; });
  const timer = setTimeout(() => { timedOut = true; kill(); }, limits.timeoutMs);
  const onAbort = () => { aborted = true; kill(); };
  signal.addEventListener('abort', onAbort, { once: true });
  if (signal.aborted) onAbort();
  let done = false;
  const finish = (code: number | null) => {
    if (done) return;
    done = true;
    clearTimeout(timer);
    signal.removeEventListener('abort', onAbort);
    const started = mark === START_MARK;
    const reported = /"exit-code"\s*:\s*(-?\d+)/.exec(status)?.[1];
    resolve({ started, exitCode: reported !== undefined ? Number(reported) : code, timedOut, overflow, aborted, log: Buffer.concat(kept, keptBytes), logBytes, logDigest: hash.digest('hex') });
  };
  child.once('error', () => finish(null));
  // 배경 자식이 파이프를 쥐고 있어도 PID namespace와 함께 사라진다. 그래도 종료 뒤에는 잠깐만 기다린다.
  child.once('exit', code => { setTimeout(() => finish(code), 500).unref(); });
  child.once('close', code => finish(code));
});

// 공개 경로로 가지 않는 사본이라도 민감정보가 나오면 저장하지 않는다. 판정 기준은 공개 게시 차단(DATA-01)과 같다.
const logLooksSensitive = (text: string) => classify({ findings: [], open_questions: [], public_summary: text }, { internalMarkers: [] } as unknown as Parameters<typeof classify>[1]) !== 'public';
function excerptOf(log: Buffer): { excerpt: string; truncated: boolean } {
  const truncated = log.byteLength > VERIFICATION_EXCERPT_BYTES;
  let excerpt = log.subarray(0, VERIFICATION_EXCERPT_BYTES).toString('utf8');
  if (truncated) excerpt = excerpt.replace(/�+$/, '');
  return { excerpt, truncated };
}

export interface VerificationLogNote { excerpt: string | null; truncated: boolean; sensitive: boolean; detail: string | null }
export interface VerificationRecord { receipt: VerificationReceipt; log: VerificationLogNote }
export const VerificationRecordSchema = z.strictObject({ receipt: VerificationReceiptSchema,
  log: z.strictObject({ excerpt: z.string().nullable(), truncated: z.boolean(), sensitive: z.boolean(), detail: z.string().nullable() }) });

// 실행 파일이 90MB쯤이라 메모리에 올리지 않고 흘려 잰다. 읽지 못하면 null이다.
async function fileSha256(path: string): Promise<string | null> {
  const hash = createHash('sha256');
  try {
    for await (const chunk of createReadStream(path)) hash.update(chunk as Buffer);
    return hash.digest('hex');
  } catch { return null; }
}

export interface VerifierOptions {
  imageRevision: string;
  cleanup: ProcessCleanup;
  // 작업자 자격의 현재 값. 시험 로그에서 찾으면 경계가 뚫린 것이다.
  secrets(): Promise<readonly string[]>;
  // 시험 주입 자리.
  registry?: Readonly<Record<string, VerificationCommand>>;
  sandbox?: SandboxRunner;
  log?: (fields: Record<string, unknown>) => void;
}
export interface VerificationInput {
  job: string; generation: number; dirs: RunDirs; commandId: string; bundle: EvidenceBundle;
  artifact: ArtifactBundle; artifactDigest: string; archive: Uint8Array; limits: ArchiveLimits;
  baseline: { repoId: number; changeGeneration: number; baseCommit: string; baseTree: string; policyRevision: string };
}
export class IsolatedVerifier {
  private readonly registry: Readonly<Record<string, VerificationCommand>>;
  private readonly sandbox: SandboxRunner;
  constructor(private readonly options: VerifierOptions) {
    this.registry = options.registry ?? VERIFICATION_COMMANDS;
    this.sandbox = options.sandbox ?? spawnSandbox;
  }
  private receipt(input: VerificationInput, runId: string, fields: { status: VerificationStatus; exitCode: number | null; timedOut: boolean; logDigest: string | null }): VerificationReceipt {
    return VerificationReceiptSchema.parse({ runId, commandId: input.commandId, runnerRevision: VERIFIER_REVISION, imageRevision: this.options.imageRevision, bundle: input.bundle, ...fields });
  }
  private notRun(input: VerificationInput, runId: string, detail: string): VerificationRecord {
    return { receipt: this.receipt(input, runId, { status: 'not_run', exitCode: null, timedOut: false, logDigest: null }), log: { excerpt: null, truncated: false, sensitive: false, detail } };
  }
  // 증거 묶음이 이 작업자가 고정한 결과를 가리키는지. 다른 결과의 시험을 이 묶음으로 말하지 못하게 한다.
  private bundleProblem(input: VerificationInput): string | null {
    const { bundle, baseline, artifact } = input;
    const expected: EvidenceBundle = { repoId: baseline.repoId, generation: baseline.changeGeneration, baseCommit: baseline.baseCommit, baseTree: baseline.baseTree,
      resultTree: artifact.manifest.resultTree, artifactDigest: input.artifactDigest, policyRevision: baseline.policyRevision, verifierRevision: VERIFIER_REVISION };
    return evidenceBundleDigest(expected) === evidenceBundleDigest(bundle) ? null : 'bundle_mismatch';
  }
  async run(input: VerificationInput, signal: AbortSignal): Promise<VerificationRecord> {
    const runId = randomUUID();
    const command = Object.hasOwn(this.registry, input.commandId) ? this.registry[input.commandId] : undefined;
    if (!command) return this.notRun(input, runId, 'command_unknown');
    const problem = this.bundleProblem(input);
    if (problem) return this.notRun(input, runId, problem);
    if (await fileSha256(command.toolchain.path) !== command.toolchain.sha256) return this.notRun(input, runId, 'toolchain_mismatch');
    // 작성자 프로세스가 남아 있으면 같은 파드에서 돌리지 않는다.
    await this.options.cleanup.terminate(input.job).catch(() => {});
    if (await this.options.cleanup.survivors(input.job).catch(() => null) !== 0) return this.notRun(input, runId, 'author_not_stopped');
    if (signal.aborted) return this.notRun(input, runId, 'aborted');
    const workdir = join(input.dirs.root, 'verify', runId);
    const source = join(workdir, 'source');
    try {
      const materialized = await materializeSource({ target: source, archive: input.archive, limits: input.limits, artifact: input.artifact });
      if (!materialized.ok) return this.notRun(input, runId, materialized.reason);
      await freezeSource(source);
      const before = await snapshotSource(source);
      if (!before) return this.notRun(input, runId, 'source_unreadable');
      const run = await this.sandbox(sandboxArgs({ source, command }), { timeoutMs: command.timeoutMs, outputBytes: command.outputBytes }, signal);
      await this.options.cleanup.terminate(input.job).catch(() => {});
      const survivors = await this.options.cleanup.survivors(input.job).catch(() => null);
      // 시작 증거가 없어도 소멸을 확인해야 미실행이라고 말할 수 있다. 취소가 bwrap을 죽인 직후일 수 있다.
      if (!run.started && survivors === 0) return this.notRun(input, runId, run.aborted ? 'aborted' : 'sandbox_unavailable');
      return await this.judge(input, runId, run, survivors === 0, sourceUnchanged(before, await snapshotSource(source)));
    } catch { return this.notRun(input, runId, 'verifier_error'); }
    finally { await removeTree(workdir); }
  }
  private async judge(input: VerificationInput, runId: string, run: SandboxRun, stopped: boolean, unchanged: boolean): Promise<VerificationRecord> {
    const secrets = await this.options.secrets().catch(() => [] as readonly string[]);
    const secretsReadable = secrets.length > 0;
    const scanner = new SecretScanner(secrets);
    scanner.push(run.log);
    const leaked = scanner.found();
    const sensitive = leaked || logLooksSensitive(run.log.toString('utf8'));
    const { excerpt, truncated } = excerptOf(run.log);
    const note = (detail: string | null): VerificationLogNote => ({ excerpt: sensitive ? null : excerpt, truncated, sensitive, detail });
    const shape = (status: VerificationStatus, exitCode: number | null, timedOut: boolean, detail: string | null): VerificationRecord =>
      ({ receipt: this.receipt(input, runId, { status, exitCode, timedOut, logDigest: run.logDigest }), log: note(detail) });
    // 앞쪽이 더 나쁜 사실이다. 어떤 시험 결과도 이 셋을 덮지 못한다.
    if (!stopped) return shape('unknown', run.exitCode, false, 'stop_unconfirmed');
    if (!unchanged) return shape('source_changed', run.exitCode, false, 'source_changed');
    // 시험 프로세스에는 자격이 없다. 로그에 있으면 경계가 뚫린 것이므로 통과로 세지 않는다. 비교할 값을 못 읽어도 같다.
    if (leaked) return shape('unknown', run.exitCode, false, 'credential_in_log');
    if (!secretsReadable) return shape('unknown', run.exitCode, false, 'credential_recheck_failed');
    if (run.aborted) return shape('unknown', run.exitCode, false, 'aborted');
    if (run.timedOut) return shape('timed_out', null, true, null);
    if (run.overflow) return shape('unknown', run.exitCode, false, 'output_limit_exceeded');
    if (run.exitCode === null) return shape('unknown', null, false, 'exit_unknown');
    return run.exitCode === 0 ? shape('passed', 0, false, null) : shape('failed', run.exitCode, false, null);
  }
}

// ---- 게시 서버 쪽 port ----

export interface ChangeVerificationControl { job: string; lease: string; generation: number; sessionId: string; worker: { instance: string; storage: string } | null }
export interface ChangeVerificationWorker {
  verify(control: ChangeVerificationControl & { worker: { instance: string; storage: string } }, commandId: string, bundle: EvidenceBundle): Promise<TaskV2VerificationResponse>;
  verification(control: ChangeVerificationControl, commandId: string): Promise<TaskV2VerificationResponse>;
}
export interface WorkerVerificationOptions {
  worker: ChangeVerificationWorker;
  // change generation의 작성 세션. key.round가 있으면 그 수정 차례의 작성 세션이라 receipt도 그 차례 job·세션 키로 작업자에 남는다.
  // 없으면 시험할 결과가 작업자에 없다는 뜻이다.
  control(key: EvidenceKey): Promise<ChangeVerificationControl | null>;
  // 기다리는 동안 자식 job의 lease를 늘린다.
  keepalive?(key: EvidenceKey): Promise<void>;
  imageRevision: string;
  pollMs?: number; waitMs?: number;
  sleep?: (ms: number) => Promise<void>;
}
// 응답을 잃어도 작업자가 저장한 receipt를 다시 받는다. 같은 command를 두 번 돌리지 않는다. 기다림이 끝나면 unknown이다.
export class WorkerChangeVerification implements ChangeVerificationPort {
  private readonly pollMs: number;
  private readonly waitMs: number;
  private readonly sleep: (ms: number) => Promise<void>;
  constructor(private readonly options: WorkerVerificationOptions) {
    this.pollMs = options.pollMs ?? 1000;
    // 표의 가장 긴 시한에 정리·재료 짓기 여유를 더한 값.
    this.waitMs = options.waitMs ?? Math.max(...Object.values(VERIFICATION_COMMANDS).map(command => command.timeoutMs)) + 60_000;
    this.sleep = options.sleep ?? (ms => new Promise(resolve => { setTimeout(resolve, ms); }));
  }
  private local(input: { bundle: EvidenceBundle; commandId: string }, status: 'not_run' | 'unknown'): VerificationReceipt {
    // 모양이 깨진 ID는 receipt에 실을 수 없다. 표에 없는 ID와 같게 다루되 호출자가 준 값을 고쳐 적지 않는다.
    return VerificationReceiptSchema.parse({ runId: randomUUID(), commandId: input.commandId, runnerRevision: VERIFIER_REVISION, imageRevision: this.options.imageRevision,
      bundle: input.bundle, exitCode: null, timedOut: false, logDigest: null, status });
  }
  async run(input: { key: EvidenceKey; bundle: EvidenceBundle; commandId: string }): Promise<VerificationReceipt> {
    if (!CommandIdSchema.safeParse(input.commandId).success || !EvidenceBundleSchema.safeParse(input.bundle).success) throw new Error('verification_input_invalid');
    const control = await this.options.control(input.key);
    if (!control?.worker) return this.local(input, 'not_run');
    const worker = control.worker;
    let reply: TaskV2VerificationResponse | null = null;
    try { reply = await this.options.worker.verify({ ...control, worker }, input.commandId, input.bundle); }
    // 거부는 시작하지 않았다는 증거다. 그 밖은 시작했는지 모르니 아래에서 저장된 값을 본다.
    catch (error) {
      // 슬롯이 잠깐 찬 것은 시험 결과가 아니다. receipt는 command당 하나라 not_run으로 굳히면 이 generation을 살릴 수 없다.
      if (error instanceof TaskWorkerBusy) throw error;
      if (error instanceof TaskWorkerRejected) return this.local(input, 'not_run');
    }
    const deadline = Date.now() + this.waitMs;
    while (reply?.status !== 'done') {
      if (reply?.status === 'absent' || Date.now() >= deadline) return this.local(input, 'unknown');
      await this.options.keepalive?.(input.key).catch(() => {});
      await this.sleep(this.pollMs);
      try { reply = await this.options.worker.verification(control, input.commandId); } catch { reply = null; }
    }
    return reply.receipt;
  }
  async fetchReceipt(input: { key: EvidenceKey; commandId: string }): Promise<VerificationReceipt | null> {
    const control = await this.options.control(input.key);
    if (!control) return null;
    const reply = await this.options.worker.verification(control, input.commandId).catch(() => null);
    return reply?.status === 'done' ? reply.receipt : null;
  }
}
