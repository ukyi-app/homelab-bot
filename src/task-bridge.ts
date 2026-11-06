import type { z } from 'zod';
import { Denied, PolicyUnavailable } from './contracts.js';
import type { Job, Scope } from './contracts.js';
import { bounded } from './format.js';
import type { PolicyGate } from './policy.js';
import type { Store } from './store.js';
import type { TASK_ENDPOINTS, TaskEndpoint } from './task-contracts.js';

// 실행기와 무관한 게시 서버 쪽 작업 조율: owner·scope 재인가, 질문 중복·만료, outbox, lease 확인, 상태·해제.
// task-contracts를 타입으로만 가져온다. 그 파일이 값을 codex.ts에서 읽어 값으로 가져오면 초기화 순환이 생긴다.

// 작업자 호출 경계. B1 계약의 끝점 표 그대로이고 실제 HTTP·서명은 이 인터페이스 밖에 있다.
export type TaskEndpointRequest<E extends TaskEndpoint> = z.infer<(typeof TASK_ENDPOINTS)[E]['request']>;
export type TaskEndpointResponse<E extends TaskEndpoint> = z.infer<(typeof TASK_ENDPOINTS)[E]['response']>;
export interface TaskWorkerPort {
  call<E extends TaskEndpoint>(endpoint: E, body: TaskEndpointRequest<E>, signal?: AbortSignal): Promise<TaskEndpointResponse<E>>;
}
// 작업자가 시작하지 않았다는 증거(400·401·403·409의 rejected 응답, 연결 전 실패). 그 밖의 예외는 시작 여부를 모르는 것으로 본다.
export class TaskWorkerRejected extends Error {
  constructor() { super('task_worker_rejected'); }
}
// 지금 슬롯이 차서 시작하지 않았다. 결과가 아니라 일시 상태라 receipt로 남기지 않고 다시 부른다.
export class TaskWorkerBusy extends TaskWorkerRejected {}

export interface TaskBridgeOptions { questionTtlMs: number; answerChars: number }
// 실행기마다 다른 안내 문구와 멱등 키·감사 접두사. executor는 이 브리지가 맡는 세션의 codex_sessions.executor 값이다.
export interface TaskBridgeText {
  executor: 'codex' | 'claude';
  prefix: string;
  question: string;
  accepted: string;
  blocked: (job: string) => string;
}
export interface TaskAnswerInput { question: string; actor: string; scope: Scope; text: string; event: string }
export interface TaskAnswerResult { ok: boolean; status: string; duplicate?: boolean }
export interface TaskStatus { state: string; waitReason: string | null; session: boolean; question: { id: string; expiresAt: number } | null }
export const FOREIGN_SESSION_STATUS = '다른 실행기의 세션을 가진 작업입니다. 그 실행기의 경로로만 답하거나 해제할 수 있습니다.';
interface Question {
  id: string; job_id: string; conversation_id: string; thread_id: string; turn: number; responder_id: string;
  state: string; expires_at: number; answer: string | null; answer_event: string | null;
}
export abstract class TaskBridge {
  protected constructor(protected readonly store: Store, protected readonly gate: PolicyGate,
    protected readonly text: TaskBridgeText, protected readonly questions: TaskBridgeOptions) {}
  // 세션은 실행기마다 작업자가 달라 소멸 확인·재개를 대신할 수 없다. 세션이 아직 없으면 어느 실행기의 것도 아니다.
  protected async foreignSession(jobId: string, db = this.store.db): Promise<boolean> {
    return (await db.query('SELECT 1 FROM codex_sessions WHERE job_id=$1 AND executor<>$2', [jobId, this.text.executor])).rows.length > 0;
  }
  // 실행 중 감시. 취소 요청·철회·lease 상실이면 멈출 이유를 돌려준다. 정책을 잠시 못 읽는 것만으로는 멈추지 않는다.
  protected async check(job: Job): Promise<'cancel' | 'revoked' | 'lease' | undefined> {
    const row = (await this.store.db.query<{ state: string }>('SELECT state FROM jobs WHERE id=$1', [job.id])).rows[0];
    if (row?.state === 'cancel_requested') return 'cancel';
    try { await this.gate.authorize(job.owner_id, job.target); }
    catch (error) { if (error instanceof Denied) return 'revoked'; if (!(error instanceof PolicyUnavailable)) throw error; }
    return await this.store.heartbeat(job) ? undefined : 'lease';
  }
  // 띄우지 않고 실패로 끝낼 때 세션·질문도 함께 닫는다. 남겨 두면 /retry가 같은 세션 재개로 읽혀 같은 이유로 다시 실패한다.
  // job을 끝내지 못했으면(lease가 끝남 등) 세션·질문을 그대로 두고 false를 돌려준다. 그 job은 unknown으로 가고 해제가 세션을 받는다.
  protected async abandon(job: Job, reason: string, within: Store = this.store): Promise<boolean> {
    return within.atomic(async store => {
      await store.db.query('SELECT id FROM conversations WHERE id=$1 FOR UPDATE', [job.conversation_id]);
      if (!await store.fail(job, reason)) return false;
      await store.db.query("UPDATE codex_sessions SET state='failed',updated_at=$2 WHERE job_id=$1", [job.id, store.now()]);
      await store.db.query("UPDATE codex_questions SET state='cancelled' WHERE job_id=$1 AND state IN ('open','answered')", [job.id]);
      return true;
    });
  }
  // 질문을 만들고 job을 대기로 둔다. 구독이 멈췄거나 취소 요청이 먼저면 질문 없이 끝낸다. 대기에 들어갔으면 true.
  // within: 호출자의 트랜잭션에 묶을 때 그 Store를 넘긴다.
  protected async ask(job: Job, revision: string, id: string, threadId: string, turn: number, question: string, within: Store = this.store): Promise<boolean> {
    const expires = within.now() + this.questions.questionTtlMs;
    return within.atomic(async store => {
      const conversation = (await store.db.query<{ active: boolean }>('SELECT active FROM conversations WHERE id=$1 FOR UPDATE', [job.conversation_id])).rows[0];
      const state = (await store.db.query<{ state: string }>(`UPDATE jobs SET
        state=CASE WHEN state='cancel_requested' THEN 'cancelled' WHEN $5::boolean THEN 'waiting_user' ELSE 'superseded' END,
        wait_reason=CASE WHEN state='cancel_requested' THEN 'stop_confirmation' WHEN $5::boolean THEN 'clarification' ELSE 'subscription_stopped' END,
        finished_at=CASE WHEN state='cancel_requested' OR NOT $5::boolean THEN $4::bigint ELSE NULL END
        WHERE id=$1 AND lease_token=$2 AND lease_until>$3 AND state IN ('running','verifying','cancel_requested') RETURNING state`,
      [job.id, job.lease_token, store.now(), store.now(), !!conversation?.active])).rows[0]?.state;
      if (state !== 'waiting_user') return false;
      await store.db.query(`INSERT INTO codex_questions(id,job_id,conversation_id,thread_id,turn,kind,responder_id,prompt,state,created_at,expires_at)
        VALUES ($1,$2,$3,$4,$5,'clarification',$6,$7,'open',$8,$9)`,
      [id, job.id, job.conversation_id, threadId, turn, job.owner_id, question, store.now(), expires]);
      await store.enqueue({ key: `${this.text.prefix}-question:${id}`, job: job.id, conversation: job.conversation_id, actor: job.owner_id,
        scope: job.target, revision, payload: { kind: 'message', channel: job.target.channel, classification: 'safe_summary',
          content: [`${this.text.question} (질문 ID: ${id})`, bounded(question, 500),
            `기한: ${new Date(expires).toISOString()}. 이 스레드에서 /answer question:${id} 로 답하세요. 답으로 도구 실행을 승인하거나 권한을 바꿀 수 없습니다.`].join('\n') } });
      return true;
    });
  }
  protected async blocked(job: Job, revision: string, within: Store = this.store): Promise<void> {
    await within.enqueue({ key: `${this.text.prefix}-blocked:${job.id}`, job: job.id, conversation: job.conversation_id, actor: job.owner_id,
      scope: job.target, revision, payload: { kind: 'message', channel: job.target.channel, classification: 'safe_summary',
        content: this.text.blocked(job.id) } });
  }
  async answer(input: TaskAnswerInput): Promise<TaskAnswerResult> {
    // 질문 답도 실행 직전과 같이 최신 정책으로 다시 인가한다(AUTH-02).
    await this.gate.authorize(input.actor, input.scope);
    return this.store.atomic(store => this.answerIn(store, input));
  }
  // 호출자가 연 트랜잭션 안에서 답을 처리한다. 수신 경로가 받은 이벤트 처리와 답 쓰기를 한 번에 확정하는 경계다.
  // store는 Store.atomic이 넘긴 트랜잭션 Store여야 한다. 인가도 그 연결로 해 같은 대화의 /revoke와 대화 행으로 직렬화된다.
  async answerIn(store: Store, input: TaskAnswerInput): Promise<TaskAnswerResult> {
    // 다른 대화의 질문은 아래에서 Denied라 기한이 지나 닫으며 알림을 넣는 대화는 이 대화뿐이다.
    await store.db.query('SELECT id FROM conversations WHERE id=$1 FOR UPDATE', [store.scopeId(input.scope)]);
    await this.gate.withDatabase(store.db).authorize(input.actor, input.scope);
    if (!input.text.trim() || input.text.length > this.questions.answerChars) return { ok: false, status: '답이 비었거나 너무 깁니다.' };
    await store.lockScheduler();
    const q = (await store.db.query<Question & { job_state: string; wait_reason: string | null; owner_id: string }>(`SELECT q.*,
      j.state AS job_state,j.wait_reason,j.owner_id FROM codex_questions q JOIN jobs j ON j.id=q.job_id WHERE q.id=$1 FOR UPDATE`, [input.question])).rows[0];
    if (!q) return { ok: false, status: '질문을 찾을 수 없습니다.' };
    if (q.conversation_id !== store.scopeId(input.scope) || q.responder_id !== input.actor || q.owner_id !== input.actor) throw new Denied();
    if (q.answer_event === input.event) return { ok: true, duplicate: true, status: '이미 받은 답입니다.' };
    if (await this.foreignSession(q.job_id, store.db)) return { ok: false, status: FOREIGN_SESSION_STATUS };
    if (q.state !== 'open') return { ok: false, status: '이미 답했거나 닫힌 질문입니다. 지금 열린 질문의 ID를 확인하세요.' };
    if (store.now() >= Number(q.expires_at)) {
      await this.close(store, q, 'expired');
      return { ok: false, status: '기한이 지난 질문입니다. 작업을 멈췄습니다.' };
    }
    if (q.job_state !== 'waiting_user' || q.wait_reason !== 'clarification') {
      await store.db.query("UPDATE codex_questions SET state='cancelled' WHERE id=$1", [q.id]);
      return { ok: false, status: '작업이 이 질문의 답을 기다리는 상태가 아닙니다.' };
    }
    await store.db.query(`UPDATE codex_questions SET state='answered',answer=$2,answered_by=$3,answer_event=$4,answered_at=$5
      WHERE id=$1`, [q.id, input.text, input.actor, input.event, store.now()]);
    await store.db.query(`UPDATE jobs SET state='queued',wait_reason=NULL,available_at=$2,lease_token=NULL,lease_until=NULL,
      started_at=NULL,finished_at=NULL WHERE id=$1 AND state='waiting_user' AND wait_reason='clarification'`, [q.job_id, store.now()]);
    await store.releaseScheduler();
    await store.audit(`${this.text.prefix}_answer_accepted`, q.id, { actor: input.actor });
    return { ok: true, status: this.text.accepted };
  }
  private async close(store: Store, q: Question, state: 'expired'): Promise<void> {
    await store.db.query('UPDATE codex_questions SET state=$2 WHERE id=$1', [q.id, state]);
    // 무응답을 승인으로 보지 않는다. 프로세스는 턴 종료 때 소멸 확인을 마쳤으므로 cancelled다.
    const job = (await store.db.query<Job>(`UPDATE jobs SET state='cancelled',wait_reason='question_expired',finished_at=$2
      WHERE id=$1 AND state='waiting_user' AND wait_reason='clarification' RETURNING *`, [q.job_id, store.now()])).rows[0];
    if (!job) return;
    await store.db.query("UPDATE codex_sessions SET state='cancelled',updated_at=$2 WHERE job_id=$1", [q.job_id, store.now()]);
    await store.releaseScheduler();
    await store.enqueue({ key: `${this.text.prefix}-expired:${q.id}`, job: job.id, conversation: job.conversation_id, actor: job.owner_id,
      scope: job.target, revision: job.revision.policy, payload: { kind: 'message', channel: job.target.channel,
        classification: 'safe_summary', content: `질문 ${q.id}의 답 기한이 지나 작업을 멈췄습니다(cancelled). 답 없이 진행하지 않습니다. 필요하면 새 작업으로 다시 요청하세요.` } });
  }
  // lease 만료·기록 실패 등 settle 밖에서 생긴 unknown도 알림 없이 두지 않는다. 안내의 해제 방법이 실행기마다 달라 자기 세션의 작업만 알린다.
  protected async unknownNotices(): Promise<number> {
    const silent = (await this.store.db.query<Job>(`SELECT * FROM jobs j WHERE j.type='task' AND j.state='unknown'
      AND NOT EXISTS (SELECT 1 FROM outbox o WHERE o.idempotency_key=$1 || j.id)
      AND NOT EXISTS (SELECT 1 FROM codex_sessions s WHERE s.job_id=j.id AND s.executor<>$2)`, [`${this.text.prefix}-blocked:`, this.text.executor])).rows;
    for (const job of silent) await this.blocked(job, job.revision.policy);
    return silent.length;
  }
  async expireQuestions(): Promise<number> {
    // 매 tick 잠그지 않도록 먼저 잠금 없이 본다. 실제 정리는 잠근 트랜잭션에서 다시 고른다.
    if (!(await this.store.db.query("SELECT 1 FROM codex_questions WHERE state='open' AND expires_at<=$1 LIMIT 1", [this.store.now()])).rows.length) return 0;
    return this.store.atomic(async store => {
      // 대화 행을 스케줄러보다 먼저, 여러 개면 id 순으로 잠근다. 잠근 뒤에 만료된 다른 대화의 질문은 다음 정리로 미룬다.
      const conversations = (await store.db.query<{ id: string }>(`SELECT id FROM conversations WHERE id IN
        (SELECT conversation_id FROM codex_questions WHERE state='open' AND expires_at<=$1) ORDER BY id FOR UPDATE`, [store.now()])).rows.map(row => row.id);
      await store.lockScheduler();
      const rows = (await store.db.query<Question>(`SELECT * FROM codex_questions WHERE state='open' AND expires_at<=$1
        AND conversation_id=ANY($2::text[]) FOR UPDATE`, [store.now(), conversations])).rows;
      for (const q of rows) await this.close(store, q, 'expired');
      return rows.length;
    });
  }
  protected async owned(actor: string, scope: Scope, jobId: string): Promise<Job> {
    await this.gate.authorize(actor, scope);
    const job = (await this.store.db.query<Job>('SELECT * FROM jobs WHERE id=$1', [jobId])).rows[0];
    // 타인 작업과 다른 대화의 작업은 존재 여부도 구별해 알리지 않는다.
    if (!job || job.type !== 'task' || job.owner_id !== actor || job.conversation_id !== this.store.scopeId(scope)) throw new Denied();
    return job;
  }
  async status(actor: string, scope: Scope, jobId: string): Promise<TaskStatus> {
    const job = await this.owned(actor, scope, jobId);
    const session = (await this.store.db.query<{ thread_id: string | null }>('SELECT thread_id FROM codex_sessions WHERE job_id=$1', [jobId])).rows[0];
    const q = job.state === 'waiting_user' ? (await this.store.db.query<Question>("SELECT * FROM codex_questions WHERE job_id=$1 AND state='open'", [jobId])).rows[0] : undefined;
    return { state: job.state, waitReason: (job as Job & { wait_reason: string | null }).wait_reason, session: !!session?.thread_id,
      question: q ? { id: q.id, expiresAt: Number(q.expires_at) } : null };
  }
  // unknown 해제 권한. owner가 바뀌어 남은 막힘은 옛 owner가 풀 수 없다. 그 작업만 현재 정책 owner가 프로세스 0개 확인 뒤 풀 수 있다.
  protected async releasable(actor: string, scope: Scope, jobId: string): Promise<Job> {
    const policy = await this.gate.authorize(actor, scope);
    const job = (await this.store.db.query<Job>('SELECT * FROM jobs WHERE id=$1', [jobId])).rows[0];
    const own = job?.owner_id === actor && job.conversation_id === this.store.scopeId(scope);
    const successor = !!job && job.owner_id !== policy.owner && actor === policy.owner;
    if (!job || job.type !== 'task' || (!own && !successor)) throw new Denied();
    return job;
  }
}
