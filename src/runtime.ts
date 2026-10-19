import { AnswerSchema, DEFAULTS, Denied, PolicyUnavailable, WorkerRejected } from './contracts.js';
import type { Job } from './contracts.js';
import type { PolicyGate } from './policy.js';
import { readSummary } from './read.js';
import type { ReadAdapter } from './read.js';
import type { Store } from './store.js';
import { workerRequest } from './worker.js';
import type { WorkerClient, WorkerResult, WorkerSigner } from './worker.js';

export class Runtime {
  constructor(private readonly store: Store, private readonly gate: PolicyGate,
    private readonly worker: WorkerClient, private readonly signer: WorkerSigner,
    private readonly reader: ReadAdapter) {}
  async tick(): Promise<boolean> {
    await this.store.expire();
    const job = await this.store.claim();
    if (!job) return false;
    let dispatched = false;
    let stopped = false;
    let waiting = false;
    try {
      const policy = await this.gate.authorize(job.owner_id, job.target);
      if (!await this.dispatchable(job)) return true;
      job.revision.policy = policy.revision;
      await this.store.db.query('UPDATE jobs SET revision=$2 WHERE id=$1 AND lease_token=$3',
        [job.id, JSON.stringify(job.revision), job.lease_token]);
      const event = (await this.store.db.query<{ payload: { text: string; command?: string; target?: string } }>(
        'SELECT payload FROM events WHERE id=$1', [job.event_id])).rows[0]!;
      if (event.payload.command === 'read') {
        if (!await this.dispatchable(job)) return true;
        const result = await this.reader.recent(job.owner_id, job.target, { service: event.payload.target!, template: event.payload.text });
        await this.gate.authorize(job.owner_id, job.target, job.revision.policy);
        if (!await this.store.active(job.conversation_id)) { await this.store.transition(job, 'superseded'); return true; }
        await this.store.finish(job, result, { source: result.source, observedAt: result.observedAt }, readSummary(result), job.target,
          result.status === 'unregistered' ? [] : [result.service]);
        return true;
      }
      const request = workerRequest(job, await this.store.context(job.conversation_id, job.event_id));
      await this.gate.authorize(job.owner_id, job.target);
      if (!await this.dispatchable(job)) return true;
      const abort = new AbortController();
      let timeout: ReturnType<typeof setTimeout> | undefined;
      let monitorError = false;
      let monitorBusy = false;
      const interrupted = new Promise<WorkerResult>(resolve => {
        abort.signal.addEventListener('abort', () => resolve({ status: 'unknown', stopped: false }), { once: true });
      });
      const monitor = setInterval(() => {
        if (monitorBusy) return;
        monitorBusy = true;
        void this.monitor(job).then(stop => { if (stop) abort.abort(); })
          .catch(() => { monitorError = true; abort.abort(); }).finally(() => { monitorBusy = false; });
      }, 1000);
      let result: WorkerResult;
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
      } finally { clearInterval(monitor); clearTimeout(timeout); }
      stopped = result.stopped;
      const current = (await this.store.db.query<{ state: string }>('SELECT state FROM jobs WHERE id=$1', [job.id])).rows[0]!;
      if (current.state === 'cancel_requested' || abort.signal.aborted || monitorError) {
        const confirmation = result.stopped ? { stopped: true }
          : await this.worker.cancel({ job: job.id, lease: job.lease_token },
            this.signer.issue(job, 'cancel', { job: job.id, lease: job.lease_token })).catch(() => ({ stopped: false }));
        stopped = confirmation.stopped;
        if (stopped && current.state !== 'cancel_requested') await this.store.fail(job, 'stop_confirmation');
        else await this.store.transition(job, stopped ? 'cancelled' : 'unknown', 'stop_confirmation');
      } else if (!result.stopped) {
        await this.store.transition(job, 'unknown', 'worker_disconnected');
      } else if (result.status === 'limited' || result.status === 'auth_expired') {
        waiting = true;
        await this.store.waitForUser(job, result.status === 'limited' ? 'model_limit' : 'auth_expired');
      } else if (result.status === 'failed') await this.store.fail(job, 'model_failed');
      else if (result.status === 'succeeded') {
        const answer = AnswerSchema.parse(result.answer);
        try { await this.gate.authorize(job.owner_id, job.target); }
        catch (error) { if (!(error instanceof PolicyUnavailable)) throw error; }
        // Completed results remain durable while the publisher waits for fresh policy.
        if (!await this.store.active(job.conversation_id)) { await this.store.transition(job, 'superseded'); return true; }
        const section = (values: string[]) => values.join('; ').slice(0, 350) || '없음';
        const content = [`사실: ${section(answer.facts)}`, `가설: ${section(answer.hypotheses)}`,
          `미확인: ${section(answer.unknowns)}`, `권장 확인: ${section(answer.checks)}`].join('\n');
        await this.store.finish(job, answer, { source: 'worker', policyRevision: job.revision.policy }, content, job.target);
      }
      await this.store.audit('model_timing', job.id, { queueWaitMs: Number(job.started_at) - Number(job.created_at),
        executionMs: this.store.now() - Number(job.started_at) });
    } catch (error) {
      // An uncommitted limit transition must retain the slot until recovery, not become retryable.
      if (waiting) return true;
      if (error instanceof PolicyUnavailable && !dispatched) await this.store.defer(job);
      else if (error instanceof WorkerRejected) await this.store.fail(job, 'worker_rejected');
      else if (error instanceof Denied && (!dispatched || stopped)) await this.store.transition(job, 'cancelled', 'authorization_revoked');
      else if (!dispatched || stopped) await this.store.fail(job, dispatched ? 'invalid_result' : 'before_dispatch');
      else await this.store.transition(job, 'unknown', 'runtime_uncertain');
    }
    return true;
  }
  private async dispatchable(job: Job): Promise<boolean> {
    const current = (await this.store.db.query<Job>('SELECT * FROM jobs WHERE id=$1', [job.id])).rows[0];
    if (!current || current.lease_token !== job.lease_token || Number(current.lease_until) <= this.store.now()) return false;
    if (current.state === 'cancel_requested') { await this.store.transition(job, 'cancelled', 'cancel_before_dispatch'); return false; }
    if (current.state !== 'running') return false;
    const conversation = await this.store.ownedConversation(job.target, job.owner_id);
    if (!conversation.active) { await this.store.transition(job, 'superseded', 'subscription_stopped'); return false; }
    if (conversation.gap) { await this.store.defer(job, 'history_gap'); return false; }
    return true;
  }
  private async monitor(job: Job): Promise<boolean> {
    const current = (await this.store.db.query<{ state: string }>('SELECT state FROM jobs WHERE id=$1', [job.id])).rows[0]!;
    if (current.state === 'cancel_requested') return true;
    try { await this.gate.authorize(job.owner_id, job.target, job.revision.policy); }
    catch (error) { if (!(error instanceof PolicyUnavailable)) throw error; }
    return !await this.store.heartbeat(job);
  }
}
