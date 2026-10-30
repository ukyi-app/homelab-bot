import { chatAnswerContent } from './chat-format.js';
import { AnswerSchema, DEFAULTS, Denied, PolicyUnavailable, WorkerRejected } from './contracts.js';
import type { Job } from './contracts.js';
import type { PolicyGate } from './policy.js';
import type { ReadAdapter } from './read.js';
import { ReadRuntime, dispatchable } from './read-runtime.js';
import type { Store } from './store.js';
import { workerRequest } from './worker.js';
import type { WorkerClient, WorkerResult, WorkerSigner } from './worker.js';
import { errorInfo, jsonLog } from './log.js';
import type { Log } from './log.js';

// T18: 봇 소유 Codex 작업 경로. dispatch 뒤의 오류는 스스로 상태로 기록하고 던지지 않는다.
export interface TaskLane { run(job: Job): Promise<void>; sweep?(): Promise<unknown> }
// shutdown: 게시 서버 종료 신호(SIGTERM). drainMs: 신호 뒤 실행 중 작업의 자연 완료를 기다리는 시간.
// 기본 10초 + cancel 응답 상한 5초가 main.ts의 전체 종료 기한(20초)과 kubelet 유예(30초) 안에 들어간다.
// cancel은 드레인 기한에 바로 나가므로 DB 지연은 cancel이 아니라 그 뒤의 상태 확정만 늦춘다.
export interface RuntimeOptions { shutdown?: AbortSignal; drainMs?: number; log?: Log }
export const DRAIN_MS = 10_000;
// 멈춤이 확인된 뒤의 상태 쓰기 시도 횟수. 간격은 200ms, 400ms로 짧게 둔다(종료 기한 안에 들어가야 한다).
export const STOPPED_WRITE_ATTEMPTS = 3;
const STOPPED_WRITE_DELAY_MS = 200;
export class Runtime {
  private readonly reads: ReadRuntime;
  private readonly shutdown?: AbortSignal;
  private readonly drainMs: number;
  private readonly log: Log;
  constructor(private readonly store: Store, private readonly gate: PolicyGate,
    private readonly worker: WorkerClient, private readonly signer: WorkerSigner,
    reader: ReadAdapter, private readonly tasks?: TaskLane, options: RuntimeOptions = {}) {
    this.shutdown = options.shutdown;
    this.drainMs = options.drainMs ?? DRAIN_MS;
    this.log = options.log ?? jsonLog;
    this.reads = new ReadRuntime(store, gate, reader, options.shutdown);
  }
  // read 레인 한 바퀴. 모델 tick과 다른 루프에서 부른다.
  tickRead(): Promise<boolean> { return this.reads.tick(); }
  async tick(): Promise<boolean> {
    if (this.shutdown?.aborted) return false;
    await this.store.expire();
    // 기한 지난 질문 대기를 먼저 풀어야 슬롯을 잡은 waiting_user가 다음 작업을 막지 않는다.
    await this.tasks?.sweep?.();
    // chat unknown이 있으면 모델 claim은 어차피 막혀 있으므로 여기서 조사해도 모델 실행을 늦추지 않는다.
    await this.probeUnknown();
    const job = await this.store.claim();
    if (!job) return false;
    let dispatched = false;
    let stopped = false;
    let waiting = false;
    let authorizationRevoked = false;
    // 종료 신호 뒤 드레인 창이 지나 이 게시 서버가 실행을 끊었는지.
    let drained = false;
    // 이 실행의 cancel은 한 번만 보낸다. 작업자는 첫 확인 뒤 job을 놓아 두 번째 cancel은 stopped:false이고,
    // 첫 요청이 false·오류였어도 다시 물으면 판정 경로마다 결과가 달라진다. 모든 경로가 이 결과(false 포함)를 다시 쓴다.
    let cancelling: Promise<boolean> | undefined;
    const stopRequest = () => (cancelling ??= this.confirmStop(job));
    // 작업자 cancel이 멈춤을 확인했는지(result.stopped와 구분한다). 확인 결과는 상태 쓰기 전에 남겨,
    // 쓰기가 실패해도 catch가 cancel을 다시 묻지 않게 한다.
    let confirmed = false;
    try {
      // 종료 신호 전에 시작한 claim이 늦게 돌아온 경우. 작업자에 보내기 전이라 시도 횟수를 쓰지 않고 되돌린다.
      if (await this.deferOnShutdown(job)) return true;
      const policy = await this.gate.authorize(job.owner_id, job.target);
      if (!await this.dispatchable(job)) return true;
      job.revision.policy = policy.revision;
      await this.store.db.query('UPDATE jobs SET revision=$2 WHERE id=$1 AND lease_token=$3',
        [job.id, JSON.stringify(job.revision), job.lease_token]);
      const event = (await this.store.db.query<{ payload: { text: string; command?: string; target?: string } }>(
        'SELECT payload FROM events WHERE id=$1', [job.event_id])).rows[0]!;
      // 모델 claim은 read를 고르지 않는다. 구버전 claim 등으로 받으면 read 경로로 처리한다(의미는 같다).
      if (job.type === 'read' || event.payload.command === 'read') { await this.reads.run(job); return true; }
      // 연결하지 않으면 task도 기존 작업자 경로 그대로다.
      if (job.type === 'task' && this.tasks) {
        if (!await this.dispatchable(job)) return true;
        if (await this.deferOnShutdown(job)) return true;
        await this.tasks.run(job);
        return true;
      }
      const request = workerRequest(job, await this.store.context(job.conversation_id, job.event_id));
      await this.gate.authorize(job.owner_id, job.target);
      if (!await this.dispatchable(job)) return true;
      // 여기부터 dispatch까지는 await가 없어 신호가 끼어들 틈이 없다. 이후의 신호는 드레인 타이머가 받는다.
      if (await this.deferOnShutdown(job)) return true;
      const abort = new AbortController();
      let timeout: ReturnType<typeof setTimeout> | undefined;
      let monitorTask: Promise<void> | undefined;
      const interrupted = new Promise<WorkerResult>(resolve => {
        abort.signal.addEventListener('abort', () => resolve({ status: 'unknown', stopped: false }), { once: true });
      });
      const monitor = setInterval(() => {
        if (monitorTask) return;
        monitorTask = this.monitor(job).then(stop => { if (stop) abort.abort(); })
          .catch(error => {
            if (error instanceof Denied) authorizationRevoked = true;
            abort.abort();
          }).finally(() => { monitorTask = undefined; });
      }, 1000);
      let drain: ReturnType<typeof setTimeout> | undefined;
      // cancel은 DB 후처리(진행 중 monitor·재인가·상태 조회)를 기다리지 않고 보낸다. 기다렸다 보내면 DB가 느릴 때
      // (statement timeout 10초) 종료 기한 안에 못 나가 lease 만료로 unknown이 된다. 판정은 아래에서 그 결과를 합친다.
      // 드레인 기한이 되면 그 자리에서 보낸다.
      const onShutdown = () => {
        drain = setTimeout(() => { drained = true; void stopRequest(); abort.abort(); }, this.drainMs);
      };
      this.shutdown?.addEventListener('abort', onShutdown, { once: true });
      let result: WorkerResult | undefined;
      let rejected = false;
      try {
        const capability = this.signer.issue(job, 'execute', request);
        dispatched = true;
        result = await Promise.race([
          this.worker.execute(request, capability, abort.signal),
          interrupted,
          new Promise<WorkerResult>(resolve => {
            timeout = setTimeout(() => { abort.abort(); resolve({ status: 'unknown', stopped: false }); }, job.budget.timeoutMs);
          }),
        ]);
      } catch (error) {
        // 작업자가 거부한 요청은 실행되지 않았으니 물을 것이 없다.
        rejected = error instanceof WorkerRejected;
        throw error;
      } finally {
        clearInterval(monitor); clearTimeout(timeout);
        // 불확실하게 끝났으면(불확실 응답·예외·monitor abort·시간 초과) 어느 판정이든 결국 cancel을 보내므로 지금 보낸다.
        // 드레인 기한은 그 뒤에야 할 일이 없어지므로 이 다음에 정리한다.
        if (dispatched && !rejected && !result?.stopped) void stopRequest();
        clearTimeout(drain);
        this.shutdown?.removeEventListener('abort', onShutdown);
        // An in-flight authorization check must settle before choosing a terminal state.
        await monitorTask;
      }
      stopped = result.stopped;
      waiting = result.stopped && (result.status === 'limited' || result.status === 'auth_expired');
      try { await this.gate.authorize(job.owner_id, job.target); }
      catch (error) {
        if (error instanceof Denied) { authorizationRevoked = true; abort.abort(); }
        else if (!(error instanceof PolicyUnavailable)) throw error;
      }
      const current = (await this.store.db.query<{ state: string }>('SELECT state FROM jobs WHERE id=$1', [job.id])).rows[0]!;
      if (!authorizationRevoked && current.state !== 'cancel_requested' && result.stopped
        && (result.status === 'limited' || result.status === 'auth_expired')) {
        await this.store.waitForUser(job, result.status === 'limited' ? 'model_limit' : 'auth_expired');
      } else if (current.state === 'cancel_requested' || abort.signal.aborted || authorizationRevoked) {
        if (!result.stopped) stopped = confirmed = await stopRequest();
        await this.stopOutcome(job, stopped, { revoked: authorizationRevoked, ownerCancel: current.state === 'cancel_requested',
          drained, unknownReason: 'stop_confirmation' });
      } else if (!result.stopped) {
        // unknown으로 막기 전에, 작업자가 아직 이 job을 잡고 있을 때 멈춤을 확인한다(이미 보낸 요청의 결과).
        stopped = confirmed = await stopRequest();
        await this.stopOutcome(job, stopped, { revoked: false, ownerCancel: false, drained, unknownReason: 'worker_disconnected' });
      } else if (result.status === 'failed') await this.store.fail(job, 'model_failed');
      else if (result.status === 'succeeded') {
        const answer = AnswerSchema.parse(result.answer);
        // Completed results remain durable while the publisher waits for fresh policy.
        if (!await this.store.active(job.conversation_id)) { await this.store.transition(job, 'superseded'); return true; }
        const content = chatAnswerContent(answer);
        await this.store.finish(job, answer, { source: 'worker', policyRevision: job.revision.policy }, content, job.target);
      }
      await this.store.audit('model_timing', job.id, { queueWaitMs: Number(job.started_at) - Number(job.created_at),
        executionMs: this.store.now() - Number(job.started_at) });
    } catch (error) {
      // A known limit retains the slot even if subsequent policy/state reads or writes fail.
      if (waiting && !authorizationRevoked && !(error instanceof Denied)) return true;
      const revoked = authorizationRevoked || error instanceof Denied;
      if (!dispatched || error instanceof WorkerRejected) {
        if (revoked) await this.store.transition(job, 'cancelled', 'authorization_revoked');
        else if (error instanceof PolicyUnavailable && !dispatched) await this.store.defer(job);
        else await this.store.fail(job, dispatched ? 'worker_rejected' : 'before_dispatch');
        return true;
      }
      // 판정 전·중에 실패해도 이미 보낸 cancel의 결과(false 포함)를 쓰고 다시 묻지 않는다.
      if (!stopped) stopped = confirmed = await stopRequest();
      // 작업자가 스스로 멈췄다고 답한 뒤의 실패는 결과 처리 실패다.
      if (stopped && !confirmed && !revoked) await this.store.fail(job, 'invalid_result');
      else await this.stopOutcome(job, stopped, { revoked, ownerCancel: false, drained, unknownReason: 'runtime_uncertain' });
    }
    return true;
  }
  private dispatchable(job: Job): Promise<boolean> { return dispatchable(this.store, job); }
  // 멈춤을 물은 뒤의 최종 상태. 정상 판정과 catch가 같이 쓴다. ownerCancel을 모르는 catch도 저장소의 CASE가
  // cancel_requested를 cancelled로 바꾸므로 의미가 같다.
  // 권한 철회: 확인되면 cancelled, 아니면 unknown. 드레인(owner 취소 아님): shutdownOutcome(확인된 chat은 되돌림).
  // owner 취소: 확인되면 cancelled, 아니면 unknown. 그 밖: 확인되면 failed(stop_confirmation), 아니면 unknown(unknownReason).
  private async stopOutcome(job: Job, stopped: boolean,
    why: { revoked: boolean; ownerCancel: boolean; drained: boolean; unknownReason: string }): Promise<void> {
    const settle = (write: () => Promise<unknown>) => stopped ? this.afterStop(job, write) : write();
    if (why.revoked) await settle(() => this.store.transition(job, stopped ? 'cancelled' : 'unknown', 'authorization_revoked'));
    else if (why.drained && !why.ownerCancel) await this.shutdownOutcome(job, stopped);
    else if (why.ownerCancel) await settle(() => this.store.transition(job, stopped ? 'cancelled' : 'unknown', 'stop_confirmation'));
    else if (stopped) await this.afterStop(job, () => this.store.fail(job, 'stop_confirmation'));
    else await this.store.transition(job, 'unknown', why.unknownReason);
  }
  // 작업자의 cancel은 자기가 지금 잡고 있는 job·lease일 때만 stopped:true를 준다. 그래서 끊기 직전에 확인한다.
  private async confirmStop(job: Job): Promise<boolean> {
    try {
      const body = { job: job.id, lease: job.lease_token };
      return (await this.worker.cancel(body, this.signer.issue(job, 'cancel', body))).stopped;
    } catch { return false; }
  }
  // 이전 실행이 unknown으로 남긴 chat에 새 cancel capability로 멈춤을 묻는다(네트워크는 DB 트랜잭션 밖).
  // 지금 작업자는 그 job을 아직 잡고 있을 때만 stopped:true를 준다. 이미 끝냈거나 재시작한 작업자의 job은 풀리지 않는다.
  // 확인 뒤 쓰기는 afterStop으로 재시도한다. 작업자는 첫 확인 뒤 job을 놓아 다음 조사의 cancel은 stopped:false다.
  async probeUnknown(): Promise<number> {
    if (this.shutdown?.aborted) return 0;
    let resolved = 0;
    for (const job of await this.store.reserveUnknownProbes()) {
      if (this.shutdown?.aborted) break;
      if (!await this.confirmStop(job)) continue;
      if ((await this.afterStop(job, () => this.store.resolveUnknown(job)))?.value) resolved++;
    }
    return resolved;
  }
  private async deferOnShutdown(job: Job): Promise<boolean> {
    if (!this.shutdown?.aborted) return false;
    await this.store.defer(job, 'publisher_shutdown');
    await this.store.audit('publisher_shutdown', job.id, { type: job.type, outcome: 'deferred' });
    return true;
  }
  // 드레인 창을 넘겨 끊은 실행. 멈춤이 확인된 chat은 새 게시 서버가 이어받게 대기열로 되돌린다(시도 횟수는 쓴 것으로 둔다).
  // task·review는 외부 효과가 있을 수 있어 자동 재실행하지 않고 확정 실패로 둔다. 확인 실패는 unknown.
  private async shutdownOutcome(job: Job, stopped: boolean): Promise<void> {
    let outcome: string;
    if (!stopped) { await this.store.transition(job, 'unknown', 'publisher_shutdown'); outcome = 'unknown'; }
    else if (job.type === 'chat' && job.attempt < DEFAULTS.maxRetries + 1) {
      const written = await this.afterStop(job, () => this.store.requeueAfterShutdown(job));
      outcome = !written ? 'write_failed' : written.value === 'queued' ? 'requeued' : written.value ?? 'stale';
    } else outcome = await this.afterStop(job, () => this.store.fail(job, 'stop_confirmation')) ? 'failed' : 'write_failed';
    await this.store.audit('publisher_shutdown', job.id, { type: job.type, attempt: job.attempt, outcome });
  }
  // 작업자가 멈춤을 확인한 뒤의 상태 쓰기. 일시 DB 오류에 cancel을 다시 묻지 않는다. 작업자는 첫 확인 뒤 job을 놓아
  // 두 번째 cancel은 stopped:false이고, 그러면 확인된 멈춤이 풀 수 없는 unknown이 된다. 쓰기는 lease CAS라
  // lease가 끝난 뒤의 재시도는 아무것도 바꾸지 않는다. 끝내 못 쓰면 던지지 않고 로그·감사를 남긴다(그 job은 lease 만료 뒤
  // expire가 unknown으로 둔다. 감사의 stop_confirmed_write_failed가 실제로는 멈췄다는 근거다).
  private async afterStop<T>(job: Job, write: () => Promise<T>): Promise<{ value: T } | undefined> {
    for (let attempt = 1; ; attempt++) {
      try { return { value: await write() }; }
      catch (error) {
        if (attempt >= STOPPED_WRITE_ATTEMPTS) {
          this.log('stop_confirmed_write_failed', { job: job.id, attempts: attempt, ...errorInfo(error) });
          await this.store.audit('stop_confirmed_write_failed', job.id, { type: job.type, attempt: job.attempt }).catch(() => {});
          return undefined;
        }
        await new Promise(resolve => setTimeout(resolve, STOPPED_WRITE_DELAY_MS * attempt));
      }
    }
  }
  private async monitor(job: Job): Promise<boolean> {
    const current = (await this.store.db.query<{ state: string }>('SELECT state FROM jobs WHERE id=$1', [job.id])).rows[0]!;
    if (current.state === 'cancel_requested') return true;
    try { await this.gate.authorize(job.owner_id, job.target, job.revision.policy); }
    catch (error) { if (!(error instanceof PolicyUnavailable)) throw error; }
    return !await this.store.heartbeat(job);
  }
}
