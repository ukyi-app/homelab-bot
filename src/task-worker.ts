import { randomUUID } from 'node:crypto';
import type { KeyObject } from 'node:crypto';
import { link, lstat, mkdir, readFile, readdir, rename, rm, statfs, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { z } from 'zod';
import { Denied } from './contracts.js';
import type { Clock } from './contracts.js';
import { TASK_CAPABILITY, TaskWorkerIdentitySchema, TaskWorkerVerifier } from './task-contracts.js';
import type { TaskCancelRequest, TaskCancelResponse, TaskFinalizeRequest, TaskFinalizeResponse, TaskOperation, TaskRequest, TaskResponse, TaskStatusRequest,
  TaskStatusResponse, TaskWorkerIdentity } from './task-contracts.js';
import { TaskSessions } from './task-workspace.js';
import { FileNonceStore } from './worker-state.js';
import type { NonceOutcome } from './worker-state.js';

// 작업 레인 작업자의 라우트 뒤쪽. 서명·nonce·lease·fence·직렬 슬롯·세대·identity를 runTaskTurn 앞에서 막는다(runTaskTurn은 하지 않는다).
// 프로세스 정리는 파드 전체를 향하므로(직렬 1 파드의 kill(-1)) 다른 실행이 도는 동안에는 정리를 부르지 않고, 정리가 도는 동안에는 실행을 받지 않는다.
//
// 가용성 규칙(H1): 작업 파드가 Ready가 아니면 Argo CD root가 sandbox wave에서 멈춰 뒤 단계 플랫폼 적용까지 막힌다.
// 그래서 볼륨이 차거나 nonce를 못 써도 프로세스를 끝내지 않고 Ready도 내리지 않는다. 작업 수락만 닫고(503), /v1/task/intake로 알리고, 원인이 풀리면 저절로 연다.
// /readyz가 보는 것은 HTTP 서버 생존과 기동 검사(이미지·CLI 버전·PID 기준 상태)뿐이다. 기동 검사는 이미지를 바꿔야 풀리는 문제라 재시작해도 같다.

export const INTAKE_PROBE_MS = 30_000;
// 세션을 하나 더 시작할 수 없는 여유. 정확한 상한은 TaskSessions가 압축본을 보고 다시 잰다.
export const INTAKE_MIN_FREE_BYTES = 32 * 1024 * 1024;
// 취소 응답 안에 끝내야 한다. PodPidSpace 정리(유예 1.5초 + KILL 2초) 안쪽이고 게시 서버 제어 호출 상한보다 짧다.
const STOP_WAIT_MS = 4000;
// 이 시간이 지나면 그때 발급된 capability는 모두 만료다. 세션 공간도 없으면 그 기록은 더 막을 것이 없다.
const RECEIPT_TTL_MS = 3_600_000;

export class TaskRouteError extends Error {
  constructor(readonly status: 400 | 401 | 403 | 409 | 503, code: string) { super(code); }
}

export class TaskIntake {
  private readonly dynamic = new Set<string>();
  constructor(private readonly startup: readonly string[], private readonly log: (fields: Record<string, unknown>) => void = () => {}) {}
  // 기동 검사가 통과했는지. /readyz가 본다.
  get startupClean(): boolean { return this.startup.length === 0; }
  get open(): boolean { return this.startup.length === 0 && this.dynamic.size === 0; }
  get reasons(): string[] { return [...this.startup, ...this.dynamic]; }
  close(reason: string): void {
    if (this.dynamic.has(reason)) return;
    this.dynamic.add(reason);
    this.log({ level: 'error', event: 'task_intake_closed', reason });
  }
  recover(reason: string): void {
    if (this.dynamic.delete(reason)) this.log({ level: 'info', event: 'task_intake_recovered', reason });
  }
}

const GenerationReceiptSchema = z.strictObject({ lease: z.string(), turn: z.number().int().nonnegative(), fenced: z.boolean(), finalized: z.boolean(), cleanupPending: z.boolean() });
const JobReceiptSchema = z.strictObject({ highest: z.number().int().positive(), touched: z.number().int(), generations: z.record(z.string(), GenerationReceiptSchema) });
type GenerationReceipt = z.infer<typeof GenerationReceiptSchema>;
type JobReceipt = z.infer<typeof JobReceiptSchema>;
const JOB_FILE = /^[0-9a-f-]{36}\.json$/;
// 실행 영수증. nonce는 재생 방지이고 실행 멱등은 이것이 맡는다. 재시작 뒤에도 취소된 세대의 늦은 시작과 지난 턴을 거부한다.
// 메모리가 기준이고 파일은 재시작용 사본이다. 파일을 못 쓰면 실행은 받지 않지만 이미 정해진 fence는 메모리에 남긴다.
export class TaskReceipts {
  private readonly jobs = new Map<string, JobReceipt>();
  private queue: Promise<unknown> = Promise.resolve();
  constructor(private readonly dir: string, private readonly now: Clock) {}
  async load(): Promise<void> {
    await mkdir(this.dir, { recursive: true, mode: 0o700 });
    for (const name of await readdir(this.dir)) {
      if (!JOB_FILE.test(name)) continue;
      this.jobs.set(name.slice(0, -5), JobReceiptSchema.parse(JSON.parse(await readFile(join(this.dir, name), 'utf8'))));
    }
  }
  job(job: string): JobReceipt | undefined { return this.jobs.get(job); }
  generation(job: string, generation: number): GenerationReceipt | undefined { return this.jobs.get(job)?.generations[String(generation)]; }
  private async persist(job: string, record: JobReceipt): Promise<void> {
    const path = join(this.dir, `${job}.json`);
    const temporary = `${path}.${randomUUID()}.tmp`;
    try {
      await writeFile(temporary, JSON.stringify(record), { mode: 0o600 });
      await rename(temporary, path);
    } catch (error) { await rm(temporary, { force: true }).catch(() => {}); throw error; }
  }
  // 기록은 한 줄로 쓴다. 실행 전 기록과 취소 기록이 겹치면 늦게 끝난 쪽이 fence를 덮는다.
  private serial<T>(step: () => Promise<T>): Promise<T> {
    const run = this.queue.then(step, step);
    this.queue = run.catch(() => {});
    return run;
  }
  private next(job: string, generation: number, change: Partial<GenerationReceipt>): JobReceipt {
    const record = this.jobs.get(job);
    const key = String(generation);
    const current = record?.generations[key] ?? { lease: '', turn: 0, fenced: false, finalized: false, cleanupPending: false };
    return { highest: Math.max(record?.highest ?? generation, generation), touched: this.now(),
      generations: { ...record?.generations, [key]: { ...current, ...change } } };
  }
  // 실행 전 기록. 파일에 남겼을 때만 메모리를 바꾼다. 실패한 시도가 뒤의 정상 요청을 막으면 안 된다.
  begin(job: string, generation: number, lease: string, turn: number): Promise<boolean> {
    return this.serial(async () => {
      const record = this.next(job, generation, { lease, turn });
      try { await this.persist(job, record); } catch { return false; }
      this.jobs.set(job, record);
      return true;
    });
  }
  // 이미 일어난 사실(취소·삭제)의 기록. 파일을 못 써도 이 프로세스는 기억한다. 못 썼으면 false다.
  note(job: string, generation: number, change: Partial<GenerationReceipt>): Promise<boolean> {
    return this.serial(async () => {
      const record = this.next(job, generation, change);
      this.jobs.set(job, record);
      try { await this.persist(job, record); return true; } catch { return false; }
    });
  }
  // 오래됐고 세션 공간도 없는 기록을 지운다. 지워진 세대의 status는 absent이고, 게시 서버는 같은 저장소의 absent를 소멸 증명으로 쓴다.
  async prune(hasSpace: (job: string) => Promise<boolean>): Promise<void> {
    await this.serial(async () => {
      for (const [job, record] of [...this.jobs]) {
        if (this.now() - record.touched <= RECEIPT_TTL_MS || await hasSpace(job)) continue;
        await rm(join(this.dir, `${job}.json`), { force: true });
        this.jobs.delete(job);
      }
    });
  }
}

// nonce 소비. 실행은 영속 기록이 되어야만 받는다. 제어(취소·상태·정리)는 기록을 못 쓰면 메모리로 받는다.
// 볼륨이 찼을 때 정리 요청까지 막으면 공간을 비울 길이 없어 레인이 스스로 풀리지 못한다.
// 대가: 볼륨 장애와 컨테이너 재시작이 겹치면 수명 30초 안의 제어 capability를 다시 쓸 수 있다. 제어 요청은 본문 digest에 묶여 같은 일을 또 할 뿐이다(취소·상태는 멱등, 정리는 이미 지운 세대를 다시 지움).
export class TaskNonces {
  private readonly memory = new Map<string, number>();
  failures = 0;
  constructor(private readonly store: FileNonceStore, private readonly intake: TaskIntake, private readonly now: Clock) {}
  private note(outcome: NonceOutcome): NonceOutcome {
    if (outcome === 'failed') { this.failures++; this.intake.close('nonce_write_failed'); }
    return outcome;
  }
  private remembered(nonce: string): boolean {
    const now = this.now();
    for (const [key, at] of this.memory) if (now - at > TASK_CAPABILITY.nonceRetentionMs) this.memory.delete(key);
    return this.memory.has(nonce);
  }
  execute = async (nonce: string): Promise<boolean> => !this.remembered(nonce) && this.note(await this.store.record(nonce)) === 'fresh';
  control = async (nonce: string): Promise<boolean> => {
    if (this.remembered(nonce)) return false;
    const outcome = this.note(await this.store.record(nonce));
    if (outcome === 'reused') return false;
    if (outcome === 'failed') this.memory.set(nonce, this.now());
    return true;
  };
}

interface ActiveTurn { job: string; lease: string; generation: number; turn: number; controller: AbortController; done: Promise<boolean> }
export interface TaskTurnContext { worker: TaskWorkerIdentity; sessions: TaskSessions }
export interface TaskWorkerOptions {
  root: string; nonceDir: string; publicKey: KeyObject; homes: readonly string[];
  // 기동 검사에서 나온 사유. 하나라도 있으면 수락하지 않고 /readyz도 503이다.
  startup: readonly string[];
  runTurn(context: TaskTurnContext, request: TaskRequest, signal: AbortSignal): Promise<TaskResponse>;
  // RunControl.stop. 작업자 쪽 파드 전체 정리와 소멸 확인이다.
  stop(job: string): Promise<boolean>;
  survivors(job: string): Promise<number | null>;
  accepting(): boolean;
  credentialReady(): Promise<boolean>;
  log?: (fields: Record<string, unknown>) => void;
  now?: Clock;
  probeMs?: number;
  // 시험이 볼륨 장애를 넣는 자리.
  nonceIo?: ConstructorParameters<typeof FileNonceStore>[2];
  probeVolume?: () => Promise<void>;
  freeBytes?: () => Promise<number>;
}
const WORKER_FILE = 'storage-id';
// 저장소 ID는 볼륨에 남아 파드가 바뀌어도 같고, 볼륨이 바뀌면 달라진다. 게시 서버가 세션 소재를 이 값으로 대조한다.
async function storageId(controlDir: string): Promise<string> {
  await mkdir(controlDir, { recursive: true, mode: 0o700 });
  const path = join(controlDir, WORKER_FILE);
  const read = async () => TaskWorkerIdentitySchema.shape.storage.parse((await readFile(path, 'utf8')).trim());
  try { return await read(); } catch (error) { if ((error as { code?: string }).code !== 'ENOENT') throw error; }
  const temporary = `${path}.${randomUUID()}`;
  try {
    await writeFile(temporary, randomUUID(), { mode: 0o600, flag: 'wx' });
    // link는 이름이 있으면 실패해 "없을 때만"이 설치 순간에 지켜진다.
    await link(temporary, path).catch((error: { code?: string }) => { if (error.code !== 'EEXIST') throw error; });
  } finally { await rm(temporary, { force: true }).catch(() => {}); }
  return read();
}

export class TaskWorkerService {
  readonly intake: TaskIntake;
  private readonly now: Clock;
  private readonly log: (fields: Record<string, unknown>) => void;
  private readonly instance = randomUUID();
  private readonly controlDir: string;
  private readonly nonceStore: FileNonceStore;
  private readonly nonces: TaskNonces;
  private readonly executeVerifier: TaskWorkerVerifier;
  private readonly controlVerifier: TaskWorkerVerifier;
  private readonly receipts: TaskReceipts;
  // 볼륨을 처음 읽기 전에는 없다. 그동안 모든 끝점이 503이다. identity를 지어내면 게시 서버가 세션을 잃은 것으로 읽는다.
  private state: { worker: TaskWorkerIdentity; sessions: TaskSessions } | undefined;
  private turn: ActiveTurn | undefined;
  private sweeps = 0;
  private sweepChain: Promise<unknown> = Promise.resolve();
  // 소멸을 확인하지 못한 job. 비어야 실행을 받는다.
  private readonly unconfirmed = new Set<string>();
  private probing: Promise<void> | undefined;
  private timer: ReturnType<typeof setInterval> | undefined;
  constructor(private readonly options: TaskWorkerOptions) {
    this.now = options.now ?? Date.now;
    this.log = options.log ?? (() => {});
    this.intake = new TaskIntake(options.startup, this.log);
    this.controlDir = join(options.root, '.homelab-worker');
    this.nonceStore = new FileNonceStore(options.nonceDir, this.now, options.nonceIo);
    this.nonces = new TaskNonces(this.nonceStore, this.intake, this.now);
    this.executeVerifier = new TaskWorkerVerifier(options.publicKey, this.nonces.execute, this.now);
    this.controlVerifier = new TaskWorkerVerifier(options.publicKey, this.nonces.control, this.now);
    this.receipts = new TaskReceipts(join(this.controlDir, 'receipts'), this.now);
  }
  // 기동 때 한 번, 그 뒤로 주기마다. 어떤 실패도 던지지 않는다.
  async start(): Promise<void> {
    await this.probe();
    this.timer = setInterval(() => { void this.probe(); }, this.options.probeMs ?? INTAKE_PROBE_MS);
    this.timer.unref();
  }
  probe(): Promise<void> {
    this.probing ??= this.probeNow().catch(() => { this.intake.close('volume_unwritable'); }).finally(() => { this.probing = undefined; });
    return this.probing;
  }
  private async probeNow(): Promise<void> {
    if (!this.state) await this.establish();
    await this.check('volume_unwritable', async () => {
      await this.nonceStore.open();
      if (this.options.probeVolume) { await this.options.probeVolume(); return; }
      const probe = join(this.options.nonceDir, `.probe-${randomUUID()}`);
      try { await writeFile(probe, Buffer.alloc(4096), { mode: 0o600 }); } finally { await rm(probe, { force: true }).catch(() => {}); }
    });
    await this.check('volume_low', async () => {
      const free = this.options.freeBytes ? await this.options.freeBytes() : await statfs(this.options.root).then(info => info.bavail * info.bsize);
      if (free < INTAKE_MIN_FREE_BYTES) throw new Error('volume_low');
    });
    // 볼륨이 쓸 수 있으면 앞선 기록 실패는 원인이 풀린 것이다.
    if (!this.intake.reasons.includes('volume_unwritable')) { this.intake.recover('nonce_write_failed'); this.intake.recover('receipt_write_failed'); }
    await this.check('credential_unavailable', async () => { if (!await this.options.credentialReady()) throw new Error('credential'); });
    // 없음을 확인하지 못하면 공간이 있는 것으로 본다.
    await this.receipts.prune(job => lstat(join(this.options.root, 'tasks', job)).then(() => true, (error: { code?: string }) => error.code !== 'ENOENT')).catch(() => {});
  }
  private async check(reason: string, step: () => Promise<void>): Promise<void> {
    try { await step(); this.intake.recover(reason); } catch { this.intake.close(reason); }
  }
  private async establish(): Promise<void> {
    await this.check('state_unavailable', async () => {
      const storage = await storageId(this.controlDir);
      await this.receipts.load();
      const sessions = new TaskSessions(this.options.root, { storage, homes: this.options.homes });
      this.state = { worker: { instance: this.instance, storage }, sessions };
    });
  }
  private ready(): { worker: TaskWorkerIdentity; sessions: TaskSessions } {
    if (!this.state) throw new TaskRouteError(503, 'state_unavailable');
    return this.state;
  }
  private assertWorker(expected: TaskWorkerIdentity | null, worker: TaskWorkerIdentity): void {
    if (expected && (expected.instance !== worker.instance || expected.storage !== worker.storage)) throw new TaskRouteError(409, 'worker_mismatch');
  }
  private async verify(operation: TaskOperation, token: string, body: { version: 1; job: string; lease: string; generation: number }): Promise<void> {
    const failures = this.nonces.failures;
    try { await (operation === 'task_execute' ? this.executeVerifier : this.controlVerifier).check(token, operation, body); }
    catch (error) {
      if (operation === 'task_execute' && this.nonces.failures > failures) throw new TaskRouteError(503, 'nonce_write_failed');
      if (error instanceof Denied) throw new TaskRouteError(403, 'denied');
      throw error;
    }
  }
  // 정리는 줄을 세운다. 도는 동안 실행을 받지 않는다(턴 준비 중의 git이 함께 죽는다).
  private sweep(job: string): Promise<boolean> {
    this.sweeps++;
    const run = this.sweepChain.then(() => this.options.stop(job)).catch(() => false).then(stopped => {
      if (stopped) this.unconfirmed.delete(job);
      return stopped;
    }).finally(() => { this.sweeps--; });
    this.sweepChain = run;
    return run;
  }
  async execute(request: TaskRequest, token: string): Promise<TaskResponse> {
    if (!this.options.accepting()) throw new TaskRouteError(403, 'worker_closing');
    if (!this.intake.open) throw new TaskRouteError(503, 'intake_closed');
    const context = this.ready();
    await this.verify('task_execute', token, request);
    this.assertWorker(request.operation === 'resume' ? request.expectedWorker : null, context.worker);
    if (this.turn || this.sweeps || this.unconfirmed.size) throw new TaskRouteError(409, 'busy');
    const job = this.receipts.job(request.job);
    const receipt = this.receipts.generation(request.job, request.generation);
    if (job && request.generation < job.highest) throw new TaskRouteError(409, 'generation_stale');
    if (receipt && (request.operation === 'start' || receipt.fenced || receipt.finalized || request.turn <= receipt.turn)) throw new TaskRouteError(409, 'fenced');
    // 슬롯은 위 검사와 같은 틱에 잡는다. 아래 await 사이에 다른 요청이 끼어들지 못한다.
    let finish!: (stopped: boolean) => void;
    const active: ActiveTurn = { job: request.job, lease: request.lease, generation: request.generation, turn: request.turn,
      controller: new AbortController(), done: new Promise<boolean>(resolve => { finish = resolve; }) };
    this.turn = active;
    try {
      if (!await this.receipts.begin(request.job, request.generation, request.lease, request.turn)) {
        this.intake.close('receipt_write_failed');
        finish(true);
        throw new TaskRouteError(503, 'receipt_write_failed');
      }
      const response = await this.options.runTurn(context, request, active.controller.signal);
      if (response.status === 'unknown') this.unconfirmed.add(request.job);
      if (response.status === 'failed' && response.reason === 'storage_full') void this.probe();
      finish(response.stopped);
      return response;
    } catch (error) {
      if (error instanceof TaskRouteError) throw error;
      // 깨진 실행은 프로세스가 멈췄다는 증거가 아니다.
      this.unconfirmed.add(request.job);
      finish(false);
      return { version: 1, job: request.job, lease: request.lease, generation: request.generation, sessionId: request.sessionId, turn: request.turn,
        worker: context.worker, usage: { toolCalls: null, model: null }, status: 'unknown', stopped: false, sessionRetained: true, cleanupPending: false };
    } finally { if (this.turn === active) this.turn = undefined; }
  }
  // 옛 lease의 취소는 지금 세대를 막지 않는다. 그 턴은 이미 끝났고 뒤 턴이 새 lease로 돌 수 있다.
  private async fence(request: TaskCancelRequest): Promise<void> {
    const receipt = this.receipts.generation(request.job, request.generation);
    if (receipt && receipt.lease !== request.lease) return;
    if (!await this.receipts.note(request.job, request.generation, { lease: request.lease, fenced: true })) this.intake.close('receipt_write_failed');
  }
  async cancel(request: TaskCancelRequest, token: string): Promise<TaskCancelResponse> {
    const { worker, sessions } = this.ready();
    await this.verify('task_cancel', token, request);
    this.assertWorker(request.expectedWorker, worker);
    const active = this.turn;
    let stopped: boolean;
    if (active?.job === request.job && active.generation === request.generation && active.lease === request.lease) {
      // 멈춤을 기록 뒤로 미루지 않는다. 볼륨이 느릴 때 취소까지 느려진다.
      active.controller.abort();
      await this.fence(request);
      let wait: ReturnType<typeof setTimeout> | undefined;
      const settled = await Promise.race([active.done, new Promise<'late'>(resolve => { wait = setTimeout(() => resolve('late'), STOP_WAIT_MS); })]);
      clearTimeout(wait);
      stopped = settled === 'late' ? false : settled || await this.sweep(request.job);
    } else if (active) {
      // 다른 실행이 돌고 있다. 직렬 1이고 소멸을 확인하지 못한 job이 있으면 실행을 받지 않으므로 이 세대의 프로세스는 없다. 여기서 정리하면 그 실행을 죽인다.
      await this.fence(request);
      stopped = !this.unconfirmed.has(request.job);
    } else {
      // 기록을 기다리기 전에 정리 자리를 잡는다. 그 사이에 든 실행을 정리가 죽이지 않게 한다.
      const sweeping = this.sweep(request.job);
      await this.fence(request);
      stopped = await sweeping;
    }
    const sessionRetained = !stopped || await sessions.exists(request.job, request.generation);
    return { version: 1, job: request.job, lease: request.lease, generation: request.generation, sessionId: request.sessionId, worker,
      stopped, cleaned: stopped, cleanupPending: false, sessionRetained };
  }
  async status(request: TaskStatusRequest, token: string): Promise<TaskStatusResponse> {
    const { worker, sessions } = this.ready();
    await this.verify('task_status', token, request);
    this.assertWorker(request.expectedWorker, worker);
    const shape = { version: 1 as const, job: request.job, lease: request.lease, generation: request.generation, sessionId: request.sessionId, worker };
    const sessionExists = await sessions.exists(request.job, request.generation);
    const receipt = this.receipts.generation(request.job, request.generation);
    const turn = receipt?.turn ? receipt.turn : null;
    const active = this.turn;
    if (active?.job === request.job && active.generation === request.generation) return { ...shape, state: 'running', turn: active.turn, sessionExists, stopped: false };
    // 다른 실행이 돌면 파드에 프로세스가 있는 것이 정상이라 셀 수 없다. 직렬 1이 근거다.
    const gone = !this.unconfirmed.has(request.job) && (!!active || !!this.sweeps || await this.options.survivors(request.job).catch(() => null) === 0);
    if (!gone) return { ...shape, state: 'unknown', turn, sessionExists, stopped: false };
    if (receipt?.cleanupPending) return { ...shape, state: 'cleanup_pending', turn, sessionExists, stopped: true };
    if (sessionExists) return { ...shape, state: 'waiting', turn, sessionExists, stopped: true };
    return { ...shape, state: receipt?.finalized ? 'finalized' : 'absent', turn, sessionExists: false, stopped: true };
  }
  async finalize(request: TaskFinalizeRequest, token: string): Promise<TaskFinalizeResponse> {
    const { worker, sessions } = this.ready();
    await this.verify('task_finalize', token, request);
    this.assertWorker(request.expectedWorker, worker);
    const shape = { version: 1 as const, job: request.job, lease: request.lease, generation: request.generation, sessionId: request.sessionId, worker };
    const active = this.turn;
    if (active?.job === request.job && active.generation === request.generation) return { ...shape, stopped: false, cleaned: false, cleanupPending: false, sessionRetained: true };
    const removed = await sessions.finalize(request.job, request.generation,
      async () => active ? !this.unconfirmed.has(request.job) : this.sweep(request.job));
    if (removed.stopped && !await this.receipts.note(request.job, request.generation,
      { fenced: true, finalized: removed.cleaned, cleanupPending: !removed.cleaned })) this.intake.close('receipt_write_failed');
    return { ...shape, stopped: removed.stopped, cleaned: removed.cleaned, cleanupPending: removed.stopped && !removed.cleaned, sessionRetained: !removed.cleaned };
  }
  // 종료 신호. 준비 중인 턴까지 멈추고 그 응답이 나가길 기다린다.
  async shutdown(): Promise<void> {
    if (this.timer) clearInterval(this.timer);
    this.turn?.controller.abort();
    await this.turn?.done;
  }
}
