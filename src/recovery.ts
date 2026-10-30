import { Denied, RateLimited } from './contracts.js';
import type { Scope } from './contracts.js';
import type { RecoveryOutcome } from './discord.js';
import { errorInfo } from './log.js';
import type { Log } from './log.js';
import type { Store } from './store.js';

interface Pending { scope: Scope; owner: string; attempt: number; at: number }
// 새 IDENTIFY(READY) 뒤의 Discord 누락 대조(ARCHITECTURE §7).
// 1) barrier(): live 입력을 처리하기 전에 모든 활성 스레드·DM에 gap(복구 장벽)을 한 문장으로 세운다. 그 뒤 들어온 live
//    메시지는 버퍼에 들어가 checkpoint를 올리지 못하므로, 복구 차례를 기다리는 대화도 단절 중 메시지를 건너뛰지 않는다.
//    작업 claim·게시도 gap 동안 멈춘다.
// 2) runDue(): 대화마다 recover()를 돌린다. 일시적인 실패(시간 초과·429·서버 오류·정책 확인 불가)는 대화별로 지수 백오프
//    (429·영속 pause면 retry_after 이상)로 다시 시도한다. 복구 한도를 넘은 경우(budget)는 수동 처리할 gap으로 남기고 다시 돌리지 않는다.
// 대기 목록은 메모리에 둔다. 프로세스가 다시 뜨면 새 READY가 장벽과 목록을 다시 만든다.
export class RecoveryScheduler {
  private readonly pending = new Map<string, Pending>();
  constructor(private readonly store: Store, private readonly recover: (scope: Scope, owner: string) => Promise<RecoveryOutcome>,
    private readonly log: Log, private readonly backoff = (attempt: number) => Math.min(300_000, 1000 * 2 ** Math.min(attempt, 9))) {}
  get size(): number { return this.pending.size; }
  async barrier(): Promise<number> {
    const rows = (await this.store.db.query<{ id: string; scope: Scope; owner_id: string }>(`UPDATE conversations SET gap=true
      WHERE active=true AND scope->>'kind'<>'channel' RETURNING id,scope,owner_id`)).rows;
    const now = this.store.now();
    for (const row of rows) this.pending.set(row.id, { scope: row.scope, owner: row.owner_id, attempt: 0, at: now });
    return rows.length;
  }
  // 기한이 된 대화 하나를 처리했으면 true. 하나씩 차례로 돌린다(복구 하나가 최대 30초).
  async runDue(): Promise<boolean> {
    const now = this.store.now();
    let due: [string, Pending] | undefined;
    for (const entry of this.pending) if (entry[1].at <= now && (!due || entry[1].at < due[1].at)) due = entry;
    if (!due) return false;
    const [id, entry] = due;
    const retry = (delayMs: number, reason: Record<string, unknown>) => {
      entry.attempt++;
      entry.at = this.store.now() + delayMs;
      this.log('recovery_retry', { attempt: entry.attempt, delayMs, ...reason });
    };
    try {
      const outcome = await this.recover(entry.scope, entry.owner);
      if (outcome === 'done') { this.pending.delete(id); return true; }
      if (outcome === 'budget') {
        this.pending.delete(id);
        this.log('recovery_gap_manual', { reason: 'recovery_budget' });
        return true;
      }
      // skipped: 구독이 꺼졌거나 다른 경로가 이미 풀었으면 끝, 아니면(다른 복구 진행 중·세대 변경) 다시 시도한다.
      const row = await this.store.conversation(entry.scope);
      if (!row?.active || !row.gap) { this.pending.delete(id); return true; }
      retry(this.backoff(entry.attempt), { reason: 'skipped' });
    } catch (error) {
      // 정책이 이 대화를 허용하지 않는다. 정책은 기동 때 고정이라 재시도해도 같다. gap은 그대로 둔다.
      if (error instanceof Denied) { this.pending.delete(id); this.log('recovery_denied'); return true; }
      const delay = Math.max(this.backoff(entry.attempt), error instanceof RateLimited ? error.retryAfterMs : 0);
      retry(delay, errorInfo(error));
    }
    return true;
  }
}
