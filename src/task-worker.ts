import { randomUUID } from 'node:crypto';
import type { KeyObject } from 'node:crypto';
import { link, lstat, mkdir, readFile, readdir, rename, rm, statfs, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { z } from 'zod';
import { Denied } from './contracts.js';
import type { Clock } from './contracts.js';
import { ExecutionSelectionSchema, executionAuth } from './execution-auth.js';
import type { ExecutionSelection } from './execution-auth.js';
import { ChangeResults, decodeArtifact, readBaseline } from './change-artifact.js';
import { VerificationRecordSchema } from './change-verifier.js';
import type { IsolatedVerifier, VerificationInput, VerificationRecord } from './change-verifier.js';
import { TASK_CAPABILITY, TASK_V2_CONTRACT, TaskWorkerIdentitySchema, TaskWorkerVerifier } from './task-contracts.js';
import type { AnyTaskOperation, TaskCancelRequest, TaskCancelResponse, TaskFinalizeRequest, TaskFinalizeResponse, TaskRequest, TaskResponse, TaskSignedBody, TaskStatusRequest,
  TaskStatusResponse, TaskV2Accepted, TaskV2FinalizeRequest, TaskV2FinalizeResponse, TaskV2Request, TaskV2ResultRequest, TaskV2ResultResponse, TaskV2TurnResult, TaskV2VerificationRequest,
  TaskV2VerificationResponse, TaskV2VerifyRequest, TaskWorkerIdentity } from './task-contracts.js';
import { TaskSessions } from './task-workspace.js';
import type { ArchiveLimits } from './task-workspace.js';
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
// 선택이 실린 턴의 unknown에 붙이는 실행 칸. 시작했을 수 있는 실행은 그 선택의 방식뿐이다. 선택이 없으면 옛 모양 그대로다.
const selected = (execution: ExecutionSelection | undefined) => execution ? { execution: executionAuth(execution) } : {};
type JobReceipt = z.infer<typeof JobReceiptSchema>;
const JOB_FILE = /^[0-9a-f-]{36}\.json$/;
// 방식 선택(DECISIONS "C39")이 실린 턴의 선택 기록. 영수증과 같은 디렉터리·수명의 옆 파일이다.
// 영수증 파일에 칸을 더하지 않는 이유: 되돌린 옛 이미지가 영수증을 strict 모양으로 읽어 기동에 실패한다. 옛 이미지는 JOB_FILE 이름만 읽어 이 파일을 건너뛴다.
const SELECTION_FILE = /^([0-9a-f-]{36})\.selection\.json$/;
const SelectionRecordSchema = z.strictObject({ generations: z.record(z.string(), z.strictObject({ turn: z.number().int().positive(), execution: ExecutionSelectionSchema })) });
type SelectionRecord = z.infer<typeof SelectionRecordSchema>;
// 실행 영수증. nonce는 재생 방지이고 실행 멱등은 이것이 맡는다. 재시작 뒤에도 취소된 세대의 늦은 시작과 지난 턴을 거부한다.
// 메모리가 기준이고 파일은 재시작용 사본이다. 파일을 못 쓰면 실행은 받지 않지만 이미 정해진 fence는 메모리에 남긴다.
export class TaskReceipts {
  private readonly jobs = new Map<string, JobReceipt>();
  private readonly selections = new Map<string, SelectionRecord>();
  private queue: Promise<unknown> = Promise.resolve();
  constructor(private readonly dir: string, private readonly now: Clock) {}
  async load(): Promise<void> {
    await mkdir(this.dir, { recursive: true, mode: 0o700 });
    const names = await readdir(this.dir);
    for (const name of names) {
      if (!JOB_FILE.test(name)) continue;
      this.jobs.set(name.slice(0, -5), JobReceiptSchema.parse(JSON.parse(await readFile(join(this.dir, name), 'utf8'))));
    }
    // 선택 기록은 응답에 칸을 붙이는 데만 쓴다. 읽지 못하면 기동을 막지 않고 선택을 모르는 것으로 둔다(칸 없는 unknown).
    for (const name of names) {
      const job = SELECTION_FILE.exec(name)?.[1];
      if (!job || !this.jobs.has(job)) continue;
      const parsed = SelectionRecordSchema.safeParse(await readFile(join(this.dir, name), 'utf8').then(JSON.parse).catch(() => null));
      if (parsed.success) this.selections.set(job, parsed.data);
    }
  }
  job(job: string): JobReceipt | undefined { return this.jobs.get(job); }
  generation(job: string, generation: number): GenerationReceipt | undefined { return this.jobs.get(job)?.generations[String(generation)]; }
  // 그 턴이 실행 전에 남긴 선택. 같은 세대의 다른 턴(칸 없는 턴 포함)의 선택은 돌려주지 않는다.
  selection(job: string, generation: number, turn: number): ExecutionSelection | undefined {
    const entry = this.selections.get(job)?.generations[String(generation)];
    return entry?.turn === turn ? entry.execution : undefined;
  }
  private async persist(job: string, record: JobReceipt): Promise<void> {
    await this.write(join(this.dir, `${job}.json`), record);
  }
  private async write(path: string, record: unknown): Promise<void> {
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
  // 선택이 실린 턴은 선택 기록을 먼저 쓴다. 영수증만 남고 선택이 없으면 재시작 뒤 그 턴의 unknown에 칸을 붙일 수 없다.
  begin(job: string, generation: number, lease: string, turn: number, execution?: ExecutionSelection): Promise<boolean> {
    return this.serial(async () => {
      const record = this.next(job, generation, { lease, turn });
      const current = this.selections.get(job);
      const selected: SelectionRecord | undefined = execution
        ? { generations: { ...current?.generations, [String(generation)]: { turn, execution } } } : undefined;
      try {
        if (selected) await this.write(join(this.dir, `${job}.selection.json`), selected);
        await this.persist(job, record);
      } catch { return false; }
      this.jobs.set(job, record);
      if (selected) this.selections.set(job, selected);
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
        await rm(join(this.dir, `${job}.selection.json`), { force: true });
        this.jobs.delete(job);
        this.selections.delete(job);
      }
      // 영수증 없는 선택 기록(되돌린 옛 이미지가 영수증만 지운 경우)도 지운다.
      for (const name of await readdir(this.dir)) {
        const job = SELECTION_FILE.exec(name)?.[1];
        if (job && !this.jobs.has(job)) await rm(join(this.dir, name), { force: true });
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

interface ActiveTurn { job: string; lease: string; generation: number; turn: number; controller: AbortController; done: Promise<boolean>; verifying?: string }
export interface TaskTurnContext { worker: TaskWorkerIdentity; sessions: TaskSessions }
// v2 실행 부품. 없으면 v2 끝점을 열지 않고 intake도 지원을 말하지 않는다. 게시 서버는 그때 CHANGE만 닫는다.
export interface TaskChangeRuntime {
  runTurn(context: TaskTurnContext, request: TaskV2Request, signal: AbortSignal): Promise<TaskV2TurnResult>;
  verifier: IsolatedVerifier;
}
export interface TaskWorkerOptions {
  root: string; nonceDir: string; publicKey: KeyObject; homes: readonly string[];
  // 기동 검사에서 나온 사유. 하나라도 있으면 수락하지 않고 /readyz도 503이다.
  startup: readonly string[];
  runTurn(context: TaskTurnContext, request: TaskRequest, signal: AbortSignal): Promise<TaskResponse>;
  change?: TaskChangeRuntime;
  // RunControl.stop. 작업자 쪽 파드 전체 정리와 소멸 확인이다.
  stop(job: string): Promise<boolean>;
  survivors(job: string): Promise<number | null>;
  accepting(): boolean;
  credentialReady(): Promise<boolean>;
  // 자격이 계정 묶음을 읽어 방식 선택(execution 칸)을 받는가. true면 작업 접수가 지원을 알린다(DECISIONS "C39").
  // 선택 대조에 실패한 턴은 not_run이고, 접수 영수증이 그 턴 번호를 기록해 같은 턴 번호로는 다시 받지 않는다.
  executionSelection?: boolean;
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
  private readonly results: ChangeResults;
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
    this.results = new ChangeResults(join(this.controlDir, 'change-results'));
  }
  get changeEnabled(): boolean { return this.options.change !== undefined; }
  get executionSelection(): boolean { return this.options.executionSelection === true; }
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
    // 영수증을 읽지 못한 동안에는 모든 결과가 주인 없어 보인다. 저장 ACK 전의 결과를 지우면 복구할 수 없다.
    if (this.state) await this.results.prune(job => this.receipts.job(job) !== undefined).catch(() => {});
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
  private async verify(operation: AnyTaskOperation, token: string, body: TaskSignedBody): Promise<void> {
    const failures = this.nonces.failures;
    // 프로세스를 띄우는 요청만 영속 nonce를 요구한다. 결과 재조회와 정리를 볼륨 장애로 막으면 결과를 회수할 길이 없다.
    const launches = operation === 'task_execute' || operation === 'task_v2_execute' || operation === 'task_v2_verify';
    try { await (launches ? this.executeVerifier : this.controlVerifier).check(token, operation, body); }
    catch (error) {
      if (launches && this.nonces.failures > failures) throw new TaskRouteError(503, 'nonce_write_failed');
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
  // 서명 뒤 실행 슬롯을 잡는 공통 앞부분. 슬롯은 검사와 같은 틱에 잡아 await 사이에 다른 요청이 끼어들지 못한다.
  private async claim(operation: 'task_execute' | 'task_v2_execute', request: TaskRequest | TaskV2Request, token: string) {
    if (!this.options.accepting()) throw new TaskRouteError(403, 'worker_closing');
    if (!this.intake.open) throw new TaskRouteError(503, 'intake_closed');
    const context = this.ready();
    await this.verify(operation, token, request);
    // 서명 확인이 볼륨을 기다리는 사이에 종료가 시작됐으면 shutdown이 이 턴을 보지 못한다.
    if (!this.options.accepting()) throw new TaskRouteError(403, 'worker_closing');
    this.assertWorker(request.operation === 'resume' ? request.expectedWorker : null, context.worker);
    if (this.turn || this.sweeps || this.unconfirmed.size) throw new TaskRouteError(409, 'busy');
    const job = this.receipts.job(request.job);
    const receipt = this.receipts.generation(request.job, request.generation);
    if (job && request.generation < job.highest) throw new TaskRouteError(409, 'generation_stale');
    if (receipt && (request.operation === 'start' || receipt.fenced || receipt.finalized || request.turn <= receipt.turn)) throw new TaskRouteError(409, 'fenced');
    let finish!: (stopped: boolean) => void;
    const active: ActiveTurn = { job: request.job, lease: request.lease, generation: request.generation, turn: request.turn,
      controller: new AbortController(), done: new Promise<boolean>(resolve => { finish = resolve; }) };
    this.turn = active;
    return { context, active, finish };
  }
  async execute(request: TaskRequest, token: string): Promise<TaskResponse> {
    const { context, active, finish } = await this.claim('task_execute', request, token);
    try {
      if (!await this.receipts.begin(request.job, request.generation, request.lease, request.turn, request.execution)) {
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
        worker: context.worker, usage: { toolCalls: null, model: null }, status: 'unknown', stopped: false, sessionRetained: true, cleanupPending: false,
        ...selected(request.execution) };
    } finally { if (this.turn === active) this.turn = undefined; }
  }
  // ---- v2 ----

  private changeRuntime(): TaskChangeRuntime {
    if (!this.options.change) throw new TaskRouteError(503, 'change_unavailable');
    return this.options.change;
  }
  // 턴을 접수만 하고 돌려준다. 응답을 잃어도 /v2/task/result가 같은 값을 준다. 끝난 결과는 프로세스 소멸 판정이 나온 뒤 먼저 저장하고 슬롯을 놓는다.
  async changeExecute(request: TaskV2Request, token: string): Promise<TaskV2Accepted> {
    const change = this.changeRuntime();
    const { context, active, finish } = await this.claim('task_v2_execute', request, token);
    const release = (stopped: boolean) => { finish(stopped); if (this.turn === active) this.turn = undefined; };
    try {
      if (!await this.receipts.begin(request.job, request.generation, request.lease, request.turn, request.execution)) {
        this.intake.close('receipt_write_failed');
        throw new TaskRouteError(503, 'receipt_write_failed');
      }
    } catch (error) { release(true); throw error; }
    void (async () => {
      let result: TaskV2TurnResult;
      let stopped = false;
      try {
        result = await change.runTurn(context, request, active.controller.signal);
        stopped = result.stopped;
        if (!stopped) this.unconfirmed.add(request.job);
        if (result.status === 'failed' && result.reason === 'storage_full') void this.probe();
      } catch {
        // 깨진 실행은 프로세스가 멈췄다는 증거가 아니다.
        this.unconfirmed.add(request.job);
        result = { version: TASK_V2_CONTRACT, job: request.job, lease: request.lease, generation: request.generation, sessionId: request.sessionId, turn: request.turn,
          worker: context.worker, usage: { toolCalls: null, model: null }, status: 'unknown', stopped: false, sessionRetained: true, cleanupPending: false,
          ...selected(request.execution) };
      }
      // 저장하지 못하면 재조회가 unknown을 답한다. 결과 없는 성공으로 넘어가지 않는다.
      await this.results.writeResult(result).catch(() => { this.intake.close('receipt_write_failed'); });
      release(stopped);
    })();
    return { version: TASK_V2_CONTRACT, job: request.job, lease: request.lease, generation: request.generation, sessionId: request.sessionId, worker: context.worker, status: 'accepted', turn: request.turn };
  }
  // lease는 그 턴을 시작한 값이다. 게시 서버가 재시작해 job lease가 바뀌어도 세션 행의 값으로 같은 결과를 받는다.
  private assertLease(job: string, generation: number, lease: string): void {
    const receipt = this.receipts.generation(job, generation);
    if (receipt && receipt.lease !== lease) throw new TaskRouteError(409, 'lease_mismatch');
  }
  async changeResult(request: TaskV2ResultRequest, token: string): Promise<TaskV2ResultResponse> {
    const { worker } = this.ready();
    await this.verify('task_v2_result', token, request);
    this.assertWorker(request.expectedWorker, worker);
    this.assertLease(request.job, request.generation, request.lease);
    const shape = { version: TASK_V2_CONTRACT, job: request.job, lease: request.lease, generation: request.generation, sessionId: request.sessionId, worker };
    const receipt = this.receipts.generation(request.job, request.generation);
    const active = this.turn;
    if (active?.job === request.job && active.generation === request.generation && !active.verifying) return { ...shape, status: 'running', turn: active.turn, stopped: false };
    if (!receipt) return { ...shape, status: 'absent', finalized: false, stopped: !this.unconfirmed.has(request.job) && !active };
    if (receipt.finalized) return { ...shape, status: 'absent', finalized: true, stopped: true };
    const stored = await this.results.readResult(request.job, request.generation).catch(() => null);
    if (stored && stored.turn === receipt.turn && stored.lease === request.lease) return { ...stored, worker };
    // 시작을 기록한 턴의 결과가 없다. 재시작 뒤라면 그 프로세스는 없지만 결과도 없다. 모델을 다시 돌리지 않고 그대로 말한다.
    const gone = !this.unconfirmed.has(request.job) && (!!active || !!this.sweeps || await this.options.survivors(request.job).catch(() => null) === 0);
    return { ...shape, turn: receipt.turn, usage: { toolCalls: null, model: null }, status: 'unknown', stopped: gone, sessionRetained: true, cleanupPending: receipt.cleanupPending,
      ...selected(this.receipts.selection(request.job, request.generation, receipt.turn)) };
  }
  private async storedRecord(job: string, generation: number, commandId: string): Promise<VerificationRecord | null> {
    const raw = await this.results.readVerification(job, generation, commandId).catch(() => null);
    const parsed = VerificationRecordSchema.safeParse(raw);
    return parsed.success ? parsed.data : null;
  }
  private verificationReply(request: { job: string; lease: string; generation: number; sessionId: string; commandId: string }, worker: TaskWorkerIdentity, record: VerificationRecord | null, running: boolean): TaskV2VerificationResponse {
    const shape = { version: TASK_V2_CONTRACT, job: request.job, lease: request.lease, generation: request.generation, sessionId: request.sessionId, worker, commandId: request.commandId };
    if (record) return { ...shape, status: 'done', receipt: record.receipt, log: record.log };
    return { ...shape, status: running ? 'running' : 'absent' };
  }
  // 고정된 결과에서 시험을 돌린다. 턴과 같은 슬롯을 잡아 작성자 프로세스와 겹치지 않고, 취소·상태도 턴과 같게 돈다.
  // 같은 command의 receipt가 있으면 다시 돌리지 않는다. command는 generation당 한 번이다.
  async changeVerify(request: TaskV2VerifyRequest, token: string): Promise<TaskV2VerificationResponse> {
    const change = this.changeRuntime();
    if (!this.options.accepting()) throw new TaskRouteError(403, 'worker_closing');
    const { worker, sessions } = this.ready();
    await this.verify('task_v2_verify', token, request);
    this.assertWorker(request.expectedWorker, worker);
    this.assertLease(request.job, request.generation, request.lease);
    const stored = await this.storedRecord(request.job, request.generation, request.commandId);
    if (stored) return this.verificationReply(request, worker, stored, false);
    const started = await this.results.verificationStarted(request.job, request.generation, request.commandId).catch(() => true);
    // 슬롯은 비동기 조회가 모두 끝난 뒤에 보고 같은 틱에 잡는다. 앞에서 보면 함께 온 요청 둘이 모두 비었다고 읽고 서로의 슬롯을 덮어쓴다.
    if (!this.options.accepting()) throw new TaskRouteError(403, 'worker_closing');
    const holder = this.turn;
    if (holder?.job === request.job && holder.generation === request.generation && holder.verifying === request.commandId) return this.verificationReply(request, worker, null, true);
    // 앞선 실행이 receipt 없이 끊겼다. 다시 돌려 통과하면 첫 실행의 실패가 가려진다. 읽지 못하면 시작 여부를 모르므로 돌리지 않는다.
    // 조회하는 사이에 시험이 끝났을 수 있어 receipt를 다시 본다. receipt는 슬롯을 놓기 전에 쓰므로 슬롯이 빈 뒤의 이 조회는 놓치지 않는다.
    if (started) return this.verificationReply(request, worker, await this.storedRecord(request.job, request.generation, request.commandId), false);
    if (holder || this.sweeps || this.unconfirmed.size) throw new TaskRouteError(409, 'busy');
    const receipt = this.receipts.generation(request.job, request.generation);
    if (!receipt || receipt.fenced || receipt.finalized) throw new TaskRouteError(409, 'fenced');
    let finish!: (stopped: boolean) => void;
    const active: ActiveTurn = { job: request.job, lease: request.lease, generation: request.generation, turn: receipt.turn,
      controller: new AbortController(), done: new Promise<boolean>(resolve => { finish = resolve; }), verifying: request.commandId };
    this.turn = active;
    const release = (stopped: boolean) => { finish(stopped); if (this.turn === active) this.turn = undefined; };
    let input: VerificationInput;
    try {
      const dirs = sessions.paths(request.job, request.generation);
      const result = await this.results.readResult(request.job, request.generation);
      const baseline = await readBaseline(dirs);
      const record = JSON.parse(await readFile(join(dirs.run, 'session.json'), 'utf8')) as { policyRevision: string; base: string; limits: ArchiveLimits };
      const artifact = result?.status === 'snapshot' ? decodeArtifact(result.artifact, result.artifactDigest) : null;
      // changeResult와 같은 기준이다. 시작을 기록한 뒤 턴의 결과가 없으면 앞 턴의 snapshot은 지금 결과가 아니다.
      if (!artifact || result?.status !== 'snapshot' || result.turn !== receipt.turn || !baseline) throw new TaskRouteError(409, 'result_unavailable');
      input = { job: request.job, generation: request.generation, dirs, commandId: request.commandId, bundle: request.bundle, artifact, artifactDigest: result.artifactDigest,
        archive: await readFile(join(dirs.run, 'baseline.tar.gz')), limits: record.limits,
        baseline: { repoId: baseline.repoId, changeGeneration: baseline.changeGeneration, baseCommit: baseline.baseCommit, baseTree: baseline.baseTree, policyRevision: record.policyRevision } };
    } catch (error) {
      release(true);
      if (error instanceof TaskRouteError) throw error;
      throw new TaskRouteError(409, 'result_unavailable');
    }
    let created: boolean;
    try { created = await this.results.writeVerificationStart(request.job, request.generation, request.commandId); }
    catch {
      this.intake.close('receipt_write_failed');
      release(true);
      throw new TaskRouteError(503, 'receipt_write_failed');
    }
    if (!created) {
      release(true);
      return this.verificationReply(request, worker, await this.storedRecord(request.job, request.generation, request.commandId), false);
    }
    void (async () => {
      let stopped = false;
      try {
        const outcome = await change.verifier.run(input, active.controller.signal);
        // 시험 전에 작성자가 남아 있던 경우도 프로세스가 살아 있을 수 있는 상태다. 슬롯을 다음 턴에 내주지 않는다.
        stopped = outcome.log.detail !== 'stop_unconfirmed' && outcome.log.detail !== 'author_not_stopped';
        if (!stopped) this.unconfirmed.add(request.job);
        await this.results.writeVerification(request.job, request.generation, request.commandId, outcome);
      } catch { this.unconfirmed.add(request.job); }
      release(stopped);
    })();
    return this.verificationReply(request, worker, null, true);
  }
  async changeVerification(request: TaskV2VerificationRequest, token: string): Promise<TaskV2VerificationResponse> {
    const { worker } = this.ready();
    await this.verify('task_v2_verification', token, request);
    this.assertWorker(request.expectedWorker, worker);
    this.assertLease(request.job, request.generation, request.lease);
    // 슬롯을 먼저 본다. receipt를 먼저 읽으면 그 사이에 끝난 시험이 "receipt 없음·슬롯 빔"으로 보여 absent가 되고, port가 끝난 시험을 unknown으로 닫는다.
    const active = this.turn;
    const running = active?.job === request.job && active.generation === request.generation && active.verifying === request.commandId;
    return this.verificationReply(request, worker, await this.storedRecord(request.job, request.generation, request.commandId), running);
  }
  // 저장 ACK. saved는 저장한 artifact digest가 이 작업자의 결과와 같을 때만 지운다. 다르면 게시 서버와 작업자가 다른 결과를 보고 있으므로 아무것도 지우지 않는다.
  async changeFinalize(request: TaskV2FinalizeRequest, token: string): Promise<TaskV2FinalizeResponse> {
    const { worker, sessions } = this.ready();
    await this.verify('task_v2_finalize', token, request);
    this.assertWorker(request.expectedWorker, worker);
    const shape = { version: TASK_V2_CONTRACT, job: request.job, lease: request.lease, generation: request.generation, sessionId: request.sessionId, worker };
    const active = this.turn;
    if (active?.job === request.job && active.generation === request.generation) return { ...shape, stopped: false, cleaned: false, cleanupPending: false, sessionRetained: true };
    if (request.receipt.outcome === 'saved') {
      const stored = await this.results.readResult(request.job, request.generation).catch(() => null);
      const gone = this.receipts.generation(request.job, request.generation)?.finalized === true;
      if (!gone && (stored?.status !== 'snapshot' || stored.artifactDigest !== request.receipt.artifactDigest)) throw new TaskRouteError(409, 'digest_mismatch');
    }
    const removed = await this.removeGeneration(request, sessions);
    return { ...shape, stopped: removed.stopped, cleaned: removed.cleaned, cleanupPending: removed.stopped && !removed.cleaned, sessionRetained: !removed.cleaned };
  }
  // 슬롯은 호출자가 결과를 읽은 뒤인 여기서 본다. 그 사이에 시험이 슬롯을 잡았으면 세션을 지우면 안 되고, 파드 정리는 돌던 시험까지 죽인다.
  private async removeGeneration(request: { job: string; generation: number }, sessions: TaskSessions): Promise<{ stopped: boolean; cleaned: boolean }> {
    const active = this.turn;
    if (active?.job === request.job && active.generation === request.generation) return { stopped: false, cleaned: false };
    const removed = await sessions.finalize(request.job, request.generation,
      async () => active ? !this.unconfirmed.has(request.job) : this.sweep(request.job));
    if (removed.stopped && !await this.receipts.note(request.job, request.generation,
      { fenced: true, finalized: removed.cleaned, cleanupPending: !removed.cleaned })) this.intake.close('receipt_write_failed');
    if (removed.cleaned) await this.results.remove(request.job, request.generation).catch(() => {});
    return removed;
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
    // v1 경로의 "성공"은 v1 결과의 영수증이다. 저장 ACK를 받지 못한 v2 결과를 이 길로 지우지 않는다. 실패·취소의 정리는 결과를 버리기로 정한 뒤라 통과한다.
    if (request.receipt.outcome === 'succeeded' && (await this.results.readResult(request.job, request.generation).catch(() => null))?.status === 'snapshot') throw new TaskRouteError(409, 'result_unacknowledged');
    const removed = await this.removeGeneration(request, sessions);
    return { ...shape, stopped: removed.stopped, cleaned: removed.cleaned, cleanupPending: removed.stopped && !removed.cleaned, sessionRetained: !removed.cleaned };
  }
  // 종료 신호. 준비 중인 턴까지 멈추고 그 응답이 나가길 기다린다.
  async shutdown(): Promise<void> {
    if (this.timer) clearInterval(this.timer);
    this.turn?.controller.abort();
    await this.turn?.done;
  }
}
