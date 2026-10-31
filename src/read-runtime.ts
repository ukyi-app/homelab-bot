import { Denied, PolicyUnavailable } from './contracts.js';
import type { Job } from './contracts.js';
import type { PolicyGate } from './policy.js';
import { readSummary } from './read.js';
import type { ReadAdapter } from './read.js';
import type { Store } from './store.js';

// claim 뒤 실제 실행 직전의 재확인. lease·취소·구독·gap을 다시 본다(모델·read 공용).
export async function dispatchable(store: Store, job: Job): Promise<boolean> {
  const current = (await store.db.query<Job>('SELECT * FROM jobs WHERE id=$1', [job.id])).rows[0];
  if (!current || current.lease_token !== job.lease_token || Number(current.lease_until) <= store.now()) return false;
  if (current.state === 'cancel_requested') { await store.transition(job, 'cancelled', 'cancel_before_dispatch'); return false; }
  if (current.state !== 'running') return false;
  const conversation = await store.ownedConversation(job.target, job.owner_id);
  if (!conversation.active) { await store.transition(job, 'superseded', 'subscription_stopped'); return false; }
  if (conversation.gap) { await store.defer(job, 'history_gap'); return false; }
  return true;
}

// /read 전용 레인. 모델 호출 없이 승인된 조회 템플릿만 5초 예산으로 읽는다. 모델 runtime 루프와 따로 돌아
// 긴 모델 응답·unknown·waiting_user·비상 중지 중에도 조회가 끝난다. 결과·outbox·정책 재검사는 모델과 같은 durable 경로다.
// 뒤에 요청한 read 답이 앞선 chat 답보다 먼저 게시될 수 있다(대화 안 job 순서를 강제하는 계약은 없다).
export class ReadRuntime {
  constructor(private readonly store: Store, private readonly gate: PolicyGate,
    private readonly reader: ReadAdapter, private readonly shutdown?: AbortSignal) {}
  async tick(): Promise<boolean> {
    if (this.shutdown?.aborted) return false;
    await this.store.expire();
    const job = await this.store.claimRead();
    if (!job) return false;
    await this.run(job);
    return true;
  }
  // 모델 runtime이 read를 받은 경우(구버전 공존 등)에도 이 경로로 처리한다. 오류는 상태로 기록하고 던지지 않는다.
  async run(job: Job): Promise<void> {
    try {
      // 종료 신호 뒤에 늦게 돌아온 claim은 시도 횟수를 쓰지 않고 되돌린다.
      if (this.shutdown?.aborted) { await this.store.defer(job, 'publisher_shutdown'); return; }
      const policy = await this.gate.authorize(job.owner_id, job.target);
      if (!await dispatchable(this.store, job)) return;
      job.revision.policy = policy.revision;
      await this.store.db.query('UPDATE jobs SET revision=$2 WHERE id=$1 AND lease_token=$3',
        [job.id, JSON.stringify(job.revision), job.lease_token]);
      const event = (await this.store.db.query<{ payload: { text: string; target?: string } }>(
        'SELECT payload FROM events WHERE id=$1', [job.event_id])).rows[0]!;
      const result = await this.reader.recent(job.owner_id, job.target, { service: event.payload.target!, template: event.payload.text });
      await this.gate.authorize(job.owner_id, job.target, job.revision.policy);
      if (!await this.store.active(job.conversation_id)) { await this.store.transition(job, 'superseded'); return; }
      await this.store.finish(job, result, { source: result.source, observedAt: result.observedAt }, readSummary(result), job.target,
        result.status === 'unregistered' ? [] : [result.service]);
    } catch (error) {
      // 조회는 외부 쓰기가 없어 어느 단계에서 멈춰도 결과가 확정된다(unknown이 아니다).
      if (error instanceof Denied) await this.store.transition(job, 'cancelled', 'authorization_revoked');
      else if (error instanceof PolicyUnavailable) await this.store.defer(job);
      else await this.store.fail(job, 'before_dispatch');
    }
  }
}
