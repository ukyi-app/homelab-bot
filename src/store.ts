import { randomUUID } from 'node:crypto';
import { changeChildFailed } from './change-advice.js';
import { chatContext } from './chat-context.js';
import { DEFAULTS, Denied, RateLimited } from './contracts.js';
import type { Clock, EventInput, Job, Scope, State } from './contracts.js';
import { remaining } from './database.js';
import type { Database, TransactionDeadline } from './database.js';
import { messagePages } from './format.js';
import { moveReactions, settleReactions } from './reactions.js';
import { TASK_RETENTION } from './task-contracts.js';
import type { ExecutionLane, ExecutionLaneClosedReason } from './task-contracts.js';

export interface Conversation {
  id: string; owner_id: string; scope: Scope; channel_id: string;
  active: boolean; gap: boolean; checkpoint: string | null;
  activation_after: string | null; subscription_epoch: number;
  recovery_token: string | null; recovery_until: number | null;
}
export interface Delivery {
  id: string; job_id: string | null; conversation_id: string | null;
  owner_id: string; scope: Scope; policy_revision: string; idempotency_key: string;
  service_ids: string[]; message_key: string; page_index: number;
  payload: { kind: 'message' | 'thread'; channel: string; content: string; classification: 'safe_summary' };
  state: string; external_id: string | null; lease_token: string; attempt: number;
}
// dispatched: 발송을 시작해도 된다. blocked: 철회·대화 거부로 막았다(행은 blocked). gap: 대화가 history gap이라 미룬다.
// lost: lease를 잃었다(행을 건드리지 않았다).
export type DispatchOutcome = 'dispatched' | 'blocked' | 'gap' | 'lost';
const json = (value: unknown) => JSON.stringify(value);
// 전역 상한 중 read 몫. contracts.ts의 DEFAULTS는 공용 계약이라 여기 둔다.
export const READ_QUEUE_RESERVE = 10;
export const MODEL_QUEUE_LIMIT = DEFAULTS.maxQueue - READ_QUEUE_RESERVE;
// unknown chat 조사 간격: 처음 조사 뒤 30초, 이후 두 배씩, 상한 10분.
export const UNKNOWN_PROBE_FIRST_MS = 30_000;
export const UNKNOWN_PROBE_MAX_MS = 600_000;
// 작업 레인을 닫는 unknown job(별칭 j). 세션 행이 없어도 센다. 턴 시작 전에 lease가 끝난 Claude 작업이다. Codex 세션의 task는 뺀다.
const TASK_LANE_UNKNOWN = `(j.execution_lane='task' AND j.state='unknown'
  AND NOT EXISTS (SELECT 1 FROM codex_sessions cs WHERE cs.job_id=j.id AND cs.executor='codex'))`;
// 작업 레인의 새 접수가 닫혀 있다. 호출자(수신 경로)가 사유를 안내한다.
export class LaneClosed extends Error {
  constructor(public readonly reason: ExecutionLaneClosedReason) { super(`lane_closed:${reason}`); }
}
export class Store {
  constructor(public readonly db: Database, public readonly now: Clock = Date.now) {}
  async atomic<T>(fn: (store: Store) => Promise<T>, deadline?: TransactionDeadline): Promise<T> {
    return this.db.transaction(async tx => {
      const scoped: Database = {
        query: async <R>(sql: string, params?: unknown[]) => {
          if (deadline) remaining(deadline);
          const result = await tx.query<R>(sql, params);
          if (deadline) remaining(deadline);
          return result;
        }, transaction: nested => nested(scoped),
      };
      const result = await fn(new Store(scoped, this.now));
      if (deadline) remaining(deadline);
      return result;
    }, deadline);
  }
  async conversation(scope: Scope): Promise<Conversation | undefined> {
    return (await this.db.query<Conversation>('SELECT * FROM conversations WHERE id=$1', [this.scopeId(scope)])).rows[0];
  }
  async ownedConversation(scope: Scope, actor: string, lock = false): Promise<Conversation> {
    const row = (await this.db.query<Conversation>(`SELECT * FROM conversations WHERE id=$1${lock ? ' FOR UPDATE' : ''}`, [this.scopeId(scope)])).rows[0];
    if (!row || (scope.kind !== 'channel' && row.owner_id !== actor)) throw new Denied();
    return row;
  }
  async activate(conversation: Conversation, cursor?: string): Promise<void> {
    if (conversation.scope.kind === 'channel' || conversation.active) return;
    const after = cursor && /^\d+$/.test(cursor) ? cursor
      : conversation.subscription_epoch > 0 ? String(BigInt(Math.max(0, this.now() - 1420070400000)) << 22n) : null;
    await this.db.query(`UPDATE conversations SET active=true,subscription_epoch=subscription_epoch+1,
      activation_after=$2,checkpoint=CASE WHEN $2::text IS NULL THEN checkpoint
        WHEN checkpoint IS NULL OR checkpoint::numeric<$2::numeric THEN $2 ELSE checkpoint END
      WHERE id=$1`, [conversation.id, after]);
  }
  scopeId(scope: Scope): string { return `${scope.kind}:${scope.guild ?? 'direct'}:${scope.channel}`; }
  async save(event: EventInput, revision: string, activate: boolean): Promise<{ id: string; duplicate: boolean }> {
    return this.db.transaction(async tx => {
      const key = `discord:${event.id}`;
      const existing = (await tx.query<{ id: string }>('SELECT id FROM events WHERE semantic_key=$1', [key])).rows[0];
      if (existing) return { id: existing.id, duplicate: true };
      const scopeId = this.scopeId(event.scope);
      await tx.query(`INSERT INTO conversations(id,owner_id,scope,channel_id,created_at,active)
        VALUES ($1,$2,$3,$4,$5,false) ON CONFLICT (id) DO NOTHING`,
      [scopeId, event.actor, json(event.scope), event.scope.channel, this.now()]);
      const conversation = (await tx.query<Conversation>('SELECT * FROM conversations WHERE id=$1 FOR UPDATE', [scopeId])).rows[0]!;
      if (event.scope.kind !== 'channel' && conversation.owner_id !== event.actor) throw new Denied();
      const id = randomUUID();
      const inserted = await tx.query(`INSERT INTO events(id,provider,delivery_id,semantic_key,actor_id,scope,
        conversation_id,received_at,payload) VALUES ($1,'discord',$2,$3,$4,$5,$6,$7,$8)
        ON CONFLICT DO NOTHING RETURNING id`, [id, event.id, key, event.actor, json(event.scope), scopeId,
        this.now(), json({ text: event.text, command: event.command, target: event.target, kind: event.kind,
          urgent: event.urgent, mention: event.mention, activate, revision })]);
      if (!inserted.rows.length) {
        const row = (await tx.query<{ id: string }>('SELECT id FROM events WHERE semantic_key=$1', [key])).rows[0]!;
        return { id: row.id, duplicate: true };
      }
      return { id, duplicate: false };
    });
  }
  async accept(id: string, type: Job['type'], revision: string, urgent = false, debounce = DEFAULTS.debounceMs): Promise<string> {
    return this.db.transaction(async tx => {
      const event = (await tx.query<{ actor_id: string; scope: Scope; conversation_id: string }>('SELECT * FROM events WHERE id=$1', [id])).rows[0]!;
      // 제어 경로와 같은 순서(대화 행 → 스케줄러 행)로 잠근다. jobs 삽입의 외래 키 검사가 대화 행을 잡으므로,
      // 스케줄러를 먼저 쥐면 같은 대화의 /cancel·/model-status(대화 행 → 스케줄러)와 교착한다.
      await tx.query('SELECT id FROM conversations WHERE id=$1 FOR UPDATE', [event.conversation_id]);
      // A common row serializes admission and model claims across publisher instances.
      await tx.query(`INSERT INTO controls VALUES ('scheduler','false') ON CONFLICT DO NOTHING`);
      await tx.query(`SELECT * FROM controls WHERE key='scheduler' FOR UPDATE`);
      const existing = (await tx.query<{ id: string }>('SELECT id FROM jobs WHERE event_id=$1', [id])).rows[0];
      if (existing) return existing.id;
      if (type === 'task') {
        // 기록된 값만 읽는다. 사실이 바뀌는 경로와 작업 루프의 정리가 이 행을 맞춘다. 사이에 끼어든 접수도 claim이 다시 계산해 막는다.
        const closed = (await tx.query<{ closed_reason: ExecutionLaneClosedReason | null }>(`SELECT closed_reason FROM execution_lanes WHERE lane='task' FOR UPDATE`)).rows[0]?.closed_reason;
        if (closed) throw new LaneClosed(closed);
      }
      if (await this.queueFull(type, tx)) throw new Error('queue_full');
      const jobId = randomUUID();
      const inserted = await tx.query<{ id: string }>(`INSERT INTO jobs(id,event_id,conversation_id,type,owner_id,target,revision,budget,
        priority,available_at,created_at) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
        ON CONFLICT (event_id) DO NOTHING RETURNING id`, [jobId, id, event.conversation_id, type, event.actor_id,
        json(event.scope), json({ policy: revision }), json({ timeoutMs: type === 'task' ? DEFAULTS.taskTimeoutMs : DEFAULTS.chatTimeoutMs,
          toolCalls: DEFAULTS.maxToolCalls }), urgent ? 0 : type === 'task' ? 30 : 10,
        this.now() + (urgent || type !== 'chat' ? 0 : debounce), this.now()]);
      await tx.query('UPDATE events SET accepted=true WHERE id=$1', [id]);
      if (!inserted.rows.length) return (await tx.query<{ id: string }>('SELECT id FROM jobs WHERE event_id=$1', [id])).rows[0]!.id;
      if (type === 'chat') await tx.query(`UPDATE jobs SET state='superseded' WHERE conversation_id=$1 AND type='chat'
        AND state='queued' AND priority<>0 AND id<>$2`, [event.conversation_id, jobId]);
      return jobId;
    });
  }
  // lane을 주면 그 레인의 직렬 1을 execution_lanes 행 잠금 아래에서 판정한다. 잠금 순서는 scheduler 행 → 레인 행 → job이다.
  // lane이 없으면 작업 루프가 꺼진 배치의 단일 슬롯이다. 대화·리뷰·작업이 슬롯 하나를 나누고 질문 대기도 슬롯을 잡는다.
  async claim(lane?: ExecutionLane): Promise<Job | undefined> {
    return this.db.transaction(async tx => {
      await tx.query(`INSERT INTO controls VALUES ('scheduler','false') ON CONFLICT DO NOTHING`);
      const control = (await tx.query<{ value: boolean }>(`SELECT value FROM controls WHERE key='scheduler' FOR UPDATE`)).rows[0]!;
      if (lane === 'task' ? await this.taskLaneStopped(tx) : control.value) return;
      let startsClosed = false;
      if (lane) {
        await tx.query('SELECT lane FROM execution_lanes WHERE lane=$1 FOR UPDATE', [lane]);
        if (lane === 'task') {
          const closed = await this.syncTaskLane(tx);
          if (closed && closed !== 'retention_full') return;
          startsClosed = closed === 'retention_full';
        }
        if (await this.laneBusy(lane, tx)) { if (lane === 'interactive') await this.markWaiting(tx); return; }
      } else {
        // Unknown hosts may still be executing; they hold the global model slot.
        // read는 모델을 부르지 않아 슬롯을 잡지도, 슬롯에 막히지도 않는다(claimRead가 따로 고른다).
        if ((await tx.query(`SELECT id FROM jobs WHERE state IN ('running','verifying','cancel_requested','unknown','waiting_user')
          AND type<>'read' LIMIT 1`)).rows.length) { await this.markWaiting(tx); return; }
      }
      // 보존 칸이 찼어도 이미 보존 중인 세션을 잇는 일은 칸을 늘리지 않는다. 막으면 그 세션이 끝나지 못해 칸이 영영 비지 않는다.
      const retained = startsClosed ? `AND EXISTS (SELECT 1 FROM codex_sessions s WHERE s.job_id=j.id AND s.executor='claude'
        AND s.session_retained AND s.state IN ('waiting_answer','waiting_model'))` : '';
      // CHANGE 자식 job은 v1 실행 경로로 가면 세션이 task_session_mismatch로 닫히고 저장 전 결과가 지워진다. change-runtime만 claimChangeAuthor로 집는다.
      const row = (await tx.query<Job>(`SELECT j.* FROM jobs j JOIN events e ON e.id=j.event_id
        JOIN conversations c ON c.id=j.conversation_id WHERE j.state='queued' AND j.type<>'read' AND e.accepted=true
        AND c.active=true AND c.gap=false AND c.owner_id=j.owner_id AND e.actor_id=j.owner_id AND j.available_at<=$1
        AND NOT EXISTS (SELECT 1 FROM change_child_jobs cc WHERE cc.job_id=j.id)
        ${lane ? 'AND j.execution_lane=$2' : ''} ${retained}
        ORDER BY j.priority,j.created_at,e.event_order FOR UPDATE OF j SKIP LOCKED LIMIT 1`, lane ? [this.now(), lane] : [this.now()])).rows[0];
      if (!row) return;
      const claimed = (await tx.query<Job>(`UPDATE jobs SET state='running',attempt=attempt+1,
        lease_token=$2,lease_until=$3,started_at=$4 WHERE id=$1 RETURNING *`,
      [row.id, randomUUID(), this.now() + DEFAULTS.leaseMs, this.now()])).rows[0];
      // 방금 자리를 잡은 일 뒤에 남은 대화도 기다린다. 작업 레인은 대화 자리와 따로라 대화를 기다리게 하지 않는다.
      if (lane !== 'task') await this.markWaiting(tx);
      return claimed;
    });
  }
  // ⏳ 판단. 모델 자리가 차 있는데 지금 집힐 수 있었던(디바운스가 끝난, 받은·활성·gap 아닌) 대화 작업의 메시지를 대기로 바꾼다.
  // 같은 트랜잭션의 job 상태와 저장소 시각(available_at<=now)만 보므로 결정적이다. 비상 중지·한도 정지(scheduler 켜짐)는
  // 자리 비움(💤, C20) 몫이라 여기서 바꾸지 않는다.
  private async markWaiting(tx: Database): Promise<void> {
    const ready = (await tx.query<{ event_id: string }>(`SELECT j.event_id FROM jobs j JOIN events e ON e.id=j.event_id
      JOIN conversations c ON c.id=j.conversation_id WHERE j.state='queued' AND j.type='chat' AND e.accepted=true
      AND c.active=true AND c.gap=false AND j.available_at<=$1`, [this.now()])).rows;
    await moveReactions(tx, ready.map(row => row.event_id), 'waiting');
  }
  // 대화 루프는 실행을 끝까지 기다린 뒤에야 claim을 다시 부르므로, 실행 중에 디바운스가 끝난 메시지는 claim이 보지 못한다.
  // 게시 루프의 반응 동기화가 이것을 불러 그 메시지도 ⏳로 옮긴다. 대화 자리(interactive 레인)가 차 있을 때만이다.
  // 작업 루프를 끈 배치에서 작업이 대화를 막는 경우는 레인 설정을 몰라 여기서 보지 않는다(claim이 볼 때 붙는다).
  async refreshWaiting(): Promise<void> {
    await this.db.transaction(async tx => {
      const stopped = (await tx.query<{ value: boolean }>(`SELECT value FROM controls WHERE key='scheduler'`)).rows[0]?.value;
      if (stopped || !await this.laneBusy('interactive', tx)) return;
      await this.markWaiting(tx);
    });
  }
  // CHANGE 작성 job 하나를 claim과 같은 잠금 순서·같은 슬롯 규칙으로 집는다. 슬롯이 차 있으면 undefined이고 부모는 다음 바퀴에 다시 본다.
  async claimChangeAuthor(jobId: string): Promise<Job | undefined> {
    return this.db.transaction(async tx => {
      await tx.query(`INSERT INTO controls VALUES ('scheduler','false') ON CONFLICT DO NOTHING`);
      await tx.query(`SELECT value FROM controls WHERE key='scheduler' FOR UPDATE`);
      if (await this.taskLaneStopped(tx)) return;
      await tx.query(`SELECT lane FROM execution_lanes WHERE lane='task' FOR UPDATE`);
      const closed = await this.syncTaskLane(tx);
      if (closed && closed !== 'retention_full') return;
      if (await this.laneBusy('task', tx)) return;
      const retained = closed === 'retention_full' ? `AND EXISTS (SELECT 1 FROM codex_sessions s WHERE s.job_id=j.id AND s.executor='claude'
        AND s.session_retained AND s.state IN ('waiting_answer','waiting_model'))` : '';
      const row = (await tx.query<{ id: string }>(`SELECT j.id FROM jobs j JOIN change_child_jobs c ON c.job_id=j.id
        WHERE j.id=$1 AND c.role='author' AND j.state='queued' AND j.available_at<=$2 ${retained} FOR UPDATE OF j SKIP LOCKED`, [jobId, this.now()])).rows[0];
      if (!row) return;
      return (await tx.query<Job>(`UPDATE jobs SET state='running',attempt=attempt+1,lease_token=$2,lease_until=$3,started_at=$4 WHERE id=$1 RETURNING *`,
        [row.id, randomUUID(), this.now() + DEFAULTS.leaseMs, this.now()])).rows[0];
    });
  }
  // 턴을 보내기 전에 lease가 끝난 CHANGE 작성 job을 대기열로 돌린다. 세션이 실행 중이 아니면 작업자에 프로세스가 없다. 그대로 두면 unknown이 레인을 닫는다.
  async requeueChangeAuthor(jobId: string, conversation: string): Promise<boolean> {
    return this.atomic(async store => {
      await store.lockTaskControl(conversation);
      const moved = await store.db.query(`UPDATE jobs SET state='queued',attempt=GREATEST(0,attempt-1),available_at=$2,lease_token=NULL,lease_until=NULL,started_at=NULL,wait_reason='lease_lost_before_dispatch'
        WHERE id=$1 AND state='unknown' AND EXISTS (SELECT 1 FROM change_child_jobs c WHERE c.job_id=jobs.id AND c.role='author')
        AND NOT EXISTS (SELECT 1 FROM codex_sessions s WHERE s.job_id=jobs.id AND s.state IN ('running','unknown')) RETURNING id`, [jobId, store.now()]);
      await store.syncTaskLane();
      return moved.rows.length === 1;
    });
  }
  // 재시작으로 lease만 끝난 CHANGE 작성 job을 같은 lease로 되찾는다. 턴과 시험은 작업자에서 그 lease로 계속 돌고, 결과를 되찾은 뒤에야 정상 경로로 닫을 수 있다.
  // 호출자가 작업자의 답을 먼저 받아 둔다. 세션이 그 lease로 실행 중일 때만 옮겨 해제·다른 실행이 끝낸 job을 되살리지 않는다.
  async reacquireChangeAuthor(job: Pick<Job, 'id' | 'lease_token' | 'conversation_id'>): Promise<boolean> {
    return this.atomic(async store => {
      await store.lockTaskControl(job.conversation_id);
      const moved = await store.db.query(`UPDATE jobs SET state='running',wait_reason=NULL,finished_at=NULL,lease_until=$3
        WHERE id=$1 AND lease_token=$2 AND state='unknown' AND wait_reason='lease_expired'
        AND EXISTS (SELECT 1 FROM change_child_jobs c WHERE c.job_id=jobs.id AND c.role='author')
        AND EXISTS (SELECT 1 FROM codex_sessions s WHERE s.job_id=jobs.id AND s.executor='claude' AND s.state='running' AND s.worker_lease=$2) RETURNING id`, [job.id, job.lease_token, store.now() + DEFAULTS.leaseMs]);
      await store.syncTaskLane();
      return moved.rows.length === 1;
    });
  }
  // 레인의 실행 슬롯을 잡고 있는 job이 있는지. 질문 대기는 프로세스가 없어 슬롯을 놓는다. 같은 job의 동시 턴은 그 job이 queued로
  // 돌아오기 전에 claim될 수 없고 세션 CAS(claude-task-bridge)가 한 번 더 막는다.
  async laneBusy(lane: ExecutionLane, tx = this.db): Promise<boolean> {
    return (await tx.query(`SELECT id FROM jobs WHERE execution_lane=$1 AND (state IN ('running','verifying','cancel_requested','unknown')
      OR (state='waiting_user' AND wait_reason IS DISTINCT FROM 'clarification')) LIMIT 1`, [lane])).rows.length > 0;
  }
  // 작업 레인은 scheduler 값을 그대로 보지 않는다. 대화 레인의 인증 대기도 그 값을 켜지만 작업 레인은 토큰이 달라 막힐 이유가 없다.
  // 공유하는 장벽은 비상 중지와 계정 한도 대기뿐이다.
  private async taskLaneStopped(tx: Database): Promise<boolean> {
    await tx.query(`INSERT INTO controls(key,value) SELECT 'scheduler_emergency',value FROM controls WHERE key='scheduler'
      ON CONFLICT DO NOTHING`);
    const emergency = (await tx.query<{ value: boolean }>("SELECT value FROM controls WHERE key='scheduler_emergency'")).rows[0]!.value;
    return emergency || (await tx.query(`SELECT id FROM jobs WHERE state='waiting_user' AND wait_reason='model_limit' AND type<>'read' LIMIT 1`)).rows.length > 0;
  }
  // 작업 레인의 닫힘 사유를 사실에서 다시 계산해 execution_lanes에 적고 돌려준다. 사실이 모두 DB에 있어 재시작 뒤에도 같은 값이 나온다.
  // 사유가 사라지면 새 접수가 다시 열린다. 부르는 쪽이 레인 행을 먼저 잠근다.
  // Codex 작업의 unknown은 jobs 상태만으로 슬롯을 막고 레인 접수에는 관여하지 않는다. 작업 레인을 돌리는 경로만 부른다.
  async syncTaskLane(tx = this.db): Promise<ExecutionLaneClosedReason | null> {
    const facts = (await tx.query<{ unknown: boolean; cleanup: boolean; retained: string }>(`SELECT
      (EXISTS (SELECT 1 FROM codex_sessions s WHERE s.executor='claude' AND s.state='unknown') OR EXISTS (SELECT 1 FROM jobs j WHERE ${TASK_LANE_UNKNOWN})) AS unknown,
      EXISTS (SELECT 1 FROM codex_sessions WHERE executor='claude' AND cleanup_state='pending') AS cleanup,
      (SELECT count(*) FROM codex_sessions WHERE executor='claude' AND session_retained) AS retained`)).rows[0]!;
    const reason: ExecutionLaneClosedReason | null = facts.unknown ? 'unknown' : facts.cleanup ? 'cleanup_pending'
      : Number(facts.retained) >= TASK_RETENTION.maxRetainedSessions ? 'retention_full' : null;
    await tx.query(`UPDATE execution_lanes SET closed_reason=$1::text,closed_at=CASE WHEN $1::text IS NULL THEN NULL ELSE $2::bigint END
      WHERE lane='task' AND closed_reason IS DISTINCT FROM $1::text`, [reason, this.now()]);
    return reason;
  }
  // 세션·질문을 쓰는 경로의 공통 잠금. 제어 경로와 같은 대화 행 → scheduler 행 → 레인 행 순서다.
  async lockTaskControl(conversation: string): Promise<void> {
    await this.db.query('SELECT id FROM conversations WHERE id=$1 FOR UPDATE', [conversation]);
    await this.lockScheduler();
    await this.db.query(`SELECT lane FROM execution_lanes WHERE lane='task' FOR UPDATE`);
  }
  // read 레인. 모델 슬롯·scheduler 행(대기·비상 중지)·unknown에 막히지 않는다. /emergency-stop은 모델 호출 중지다.
  // 대화 장벽(구독 중지·gap·owner 불일치)은 모델과 같다. 동시 실행은 게시 서버 전체에서 1개이며 read_lane 행으로 직렬화한다.
  // 잠금 순서: read_lane 행만 기다린다. job은 SKIP LOCKED라 기다리지 않고, 대화·scheduler 행은 잡지 않는다.
  async claimRead(): Promise<Job | undefined> {
    return this.db.transaction(async tx => {
      await tx.query(`INSERT INTO controls VALUES ('read_lane','false') ON CONFLICT DO NOTHING`);
      await tx.query(`SELECT key FROM controls WHERE key='read_lane' FOR UPDATE`);
      if ((await tx.query(`SELECT id FROM jobs WHERE type='read' AND state IN ('running','verifying','cancel_requested') LIMIT 1`)).rows.length) return;
      const row = (await tx.query<Job>(`SELECT j.* FROM jobs j JOIN events e ON e.id=j.event_id
        JOIN conversations c ON c.id=j.conversation_id WHERE j.state='queued' AND j.type='read' AND e.accepted=true
        AND c.active=true AND c.gap=false AND c.owner_id=j.owner_id AND e.actor_id=j.owner_id AND j.available_at<=$1
        ORDER BY j.priority,j.created_at,e.event_order FOR UPDATE OF j SKIP LOCKED LIMIT 1`, [this.now()])).rows[0];
      if (!row) return;
      return (await tx.query<Job>(`UPDATE jobs SET state='running',attempt=attempt+1,
        lease_token=$2,lease_until=$3,started_at=$4 WHERE id=$1 RETURNING *`,
      [row.id, randomUUID(), this.now() + DEFAULTS.leaseMs, this.now()])).rows[0];
    });
  }
  // 대기열 상한은 전역 DEFAULTS.maxQueue다. 모델 계열(chat·task·review)은 READ_QUEUE_RESERVE만큼 덜 받아,
  // 모델이 멈춘 채 대기열이 차도 /read는 들어올 수 있다.
  async queueFull(type: Job['type'] | 'review', tx = this.db): Promise<boolean> {
    const total = (await tx.query<{ count: string }>("SELECT count(*) FROM jobs WHERE state='queued'")).rows[0]!;
    if (Number(total.count) >= DEFAULTS.maxQueue) return true;
    if (type === 'read') return false;
    const model = (await tx.query<{ count: string }>("SELECT count(*) FROM jobs WHERE state='queued' AND type<>'read'")).rows[0]!;
    return Number(model.count) >= MODEL_QUEUE_LIMIT;
  }
  async heartbeat(job: Job): Promise<boolean> {
    return (await this.db.query(`UPDATE jobs SET lease_until=$3 WHERE id=$1 AND lease_token=$2
      AND lease_until>$4 AND state IN ('running','verifying','cancel_requested') RETURNING id`,
    [job.id, job.lease_token, this.now() + DEFAULTS.leaseMs, this.now()])).rows.length === 1;
  }
  // 한 번의 만료 처리는 기준 시각 하나를 쓴다. 후보 job을 그 시각으로 먼저 정하고 그 대화 행을 잠근 뒤,
  // 그 ID에 한해서만 만료 조건을 다시 확인해 바꾼다. 선잠금 뒤에 새로 만료된 job까지 UPDATE가 잡으면
  // 잠그지 않은 대화의 안내 INSERT가 같은 대화의 /cancel(대화 행 → job)과 순환한다. 그런 job은 다음 tick이 처리한다.
  async expire(): Promise<void> {
    const now = this.now();
    await this.expireReads(now);
    // 바꾼 행마다 같은 트랜잭션에서 unknown 안내를 넣는다(chat만).
    await this.db.transaction(async tx => {
      const ids = await this.lockExpiring(tx, `state IN ('running','verifying','cancel_requested') AND lease_until<=$1 AND type<>'read'`, now);
      if (!ids.length) return;
      const expired = (await tx.query<Job>(`UPDATE jobs SET state='unknown',wait_reason='lease_expired'
        WHERE id=ANY($2) AND state IN ('running','verifying','cancel_requested') AND lease_until<=$1 AND type<>'read' RETURNING *`, [now, ids])).rows;
      for (const job of expired) await this.unknownNotice(job, tx);
    });
    await this.db.query(`UPDATE outbox SET state=CASE WHEN dispatch_started THEN 'unknown' ELSE 'pending' END,
      attempt=CASE WHEN dispatch_started THEN attempt ELSE GREATEST(0,attempt-1) END,
      available_at=CASE WHEN dispatch_started THEN $1 ELSE $1+$2 END
      WHERE state='sending' AND lease_until<=$1`, [now, DEFAULTS.retryDelayMs]);
    await this.retireUnknownDeliveries();
  }
  // read에는 외부 쓰기가 없어 lease 만료가 불확실성이 아니다. unknown 대신 확정 실패로 끝내고 다시 요청하도록 안내한다.
  // 구버전이 남긴 unknown read도 같은 이유로 정리한다. owner가 /cancel한 것은 cancelled로 끝낸다.
  private async expireReads(now: number): Promise<void> {
    const where = `type='read' AND ((state IN ('running','verifying','cancel_requested') AND lease_until<=$1) OR state='unknown')`;
    await this.db.transaction(async tx => {
      const ids = await this.lockExpiring(tx, where, now);
      if (!ids.length) return;
      const expired = (await tx.query<Job>(`UPDATE jobs SET
        state=CASE WHEN state='cancel_requested' THEN 'cancelled' ELSE 'failed' END,wait_reason='lease_expired',finished_at=$1
        WHERE id=ANY($2) AND ${where} RETURNING *`, [now, ids])).rows;
      for (const job of expired) {
        if (job.state !== 'failed') continue;
        await this.enqueue({ key: `read-expired:${job.id}:${job.attempt}`, job: job.id, conversation: job.conversation_id,
          actor: job.owner_id, scope: job.target, revision: job.revision.policy,
          payload: { kind: 'message', channel: job.target.channel, classification: 'safe_summary',
            content: '조회가 시간 안에 끝나지 않았습니다. /read로 다시 요청하세요.' } }, tx);
      }
    });
  }
  async retireUnknownDeliveries(): Promise<void> {
    await this.db.transaction(async tx => {
      const rows = (await tx.query<{ id: string; available_at: string }>(
        "SELECT id,available_at FROM outbox WHERE state='unknown' AND external_id IS NULL ORDER BY available_at DESC,id FOR UPDATE")).rows;
      for (const [index, row] of rows.entries()) {
        if (index < DEFAULTS.maxUnknownDeliveries && this.now() - Number(row.available_at) < DEFAULTS.unknownDeliveryMs) continue;
        await tx.query("UPDATE outbox SET state='blocked' WHERE id=$1", [row.id]);
        await tx.query("INSERT INTO audit(kind,subject,detail,created_at) VALUES ('delivery_unresolved_retired',$1,$2,$3)",
          [row.id, json({ reason: index >= DEFAULTS.maxUnknownDeliveries ? 'unknown_capacity' : 'unknown_deadline', resend: false }), this.now()]);
      }
    });
  }
  async defer(job: Job, reason = 'policy_unavailable'): Promise<void> {
    await this.db.transaction(async tx => {
      await this.lockConversation(job, tx);
      const state = (await tx.query<{ state: State }>(`UPDATE jobs SET
        state=CASE WHEN state='cancel_requested' THEN 'cancelled' ELSE 'queued' END,
        wait_reason=CASE WHEN state='cancel_requested' THEN 'cancel_before_dispatch' ELSE $5 END,
        finished_at=CASE WHEN state='cancel_requested' THEN $4 ELSE NULL END,attempt=GREATEST(0,attempt-1),
        available_at=$3,lease_token=NULL,lease_until=NULL WHERE id=$1 AND lease_token=$2
        AND lease_until>$4 AND state IN ('running','cancel_requested') RETURNING state`,
      [job.id, job.lease_token, this.now() + DEFAULTS.retryDelayMs, this.now(), reason])).rows[0]?.state;
      if (state === 'cancelled') await this.cancelledNotice(job, 'cancel_before_dispatch', tx);
    });
  }
  // 게시 서버 종료 중 멈춤이 확인된 chat을 대기열로 되돌린다. defer와 달리 시도 횟수는 쓴 것으로 둔다(실제로 실행했다).
  // 그 사이 owner가 /cancel했으면 cancelled로 끝낸다. lease CAS가 실패하면 아무것도 바꾸지 않는다(expire가 처리).
  async requeueAfterShutdown(job: Job): Promise<State | undefined> {
    return (await this.db.query<{ state: State }>(`UPDATE jobs SET
      state=CASE WHEN state='cancel_requested' THEN 'cancelled' ELSE 'queued' END,
      wait_reason=CASE WHEN state='cancel_requested' THEN 'stop_confirmation' ELSE 'publisher_shutdown' END,
      finished_at=CASE WHEN state='cancel_requested' THEN $3 ELSE NULL END,
      available_at=$3,lease_token=NULL,lease_until=NULL WHERE id=$1 AND lease_token=$2
      AND lease_until>$3 AND state IN ('running','cancel_requested') RETURNING state`,
    [job.id, job.lease_token, this.now()])).rows[0]?.state;
  }
  // 도달한 상태를 돌려준다. lease가 끝났거나 이미 다른 상태라 바꾸지 못했으면 undefined다.
  async fail(job: Job, reason: string): Promise<State | undefined> {
    return this.atomic(async store => {
      await store.lockConversation(job);
      const next = await store.complete(job, 'failed', reason);
      if (next !== 'failed') return next;
      // CHANGE 자식은 /retry가 받지 않으므로 부모 안내와 같은 복구 행동을 말한다.
      const change = (await store.db.query<{ change_id: string }>('SELECT change_id FROM change_child_jobs WHERE job_id=$1', [job.id])).rows[0]?.change_id;
      const content = change ? changeChildFailed(job.id, change) : '작업 실패가 확인됐습니다. /list로 상태를 확인하고 /retry로 재시도할 수 있습니다.';
      await store.enqueue({ key: `failure:${job.id}:${job.attempt}`, job: job.id, conversation: job.conversation_id,
        actor: job.owner_id, scope: job.target, revision: job.revision.policy,
        payload: { kind: 'message', channel: job.target.channel, content, classification: 'safe_summary' } });
      // 실패 확정: 위 안내가 실패 한 줄이고, 반응은 같은 트랜잭션에서 지우기로 바꾼다.
      await settleReactions(store.db, job.id, 'failed');
      return next;
    });
  }
  // 호출자가 대화 행을 먼저 잡은 트랜잭션 안에서 부른다. cancelled가 되면 안내를 함께 넣는다.
  private async complete(job: Job, state: State, reason: string | null = null, tx = this.db): Promise<State | undefined> {
    const next = (await tx.query<{ state: State }>(`UPDATE jobs SET
      state=CASE WHEN state='cancel_requested' THEN 'cancelled' ELSE $3 END,wait_reason=$4,finished_at=$5
      WHERE id=$1 AND lease_token=$2 AND lease_until>$5 AND state IN ('running','verifying','cancel_requested') RETURNING state`,
    [job.id, job.lease_token, state, reason, this.now()])).rows[0]?.state;
    if (next === 'cancelled') await this.cancelledNotice(job, reason, tx);
    return next;
  }
  // 작업이 cancelled로 확정되면 그 스레드에 한 번 알린다. cancelled는 끝 상태라(재시도는 failed만 받는다) job마다 키 하나다.
  // 권한 철회로 멈춘 대화에는 안내하지 않는다(게시도 막힌다). 대화·조회의 취소는 지금처럼 알리지 않는다.
  // 모든 cancelled 확정이 여기를 지나므로 봇 반응 지우기도 여기서 한다(대화 메시지만 반응 행이 있다).
  private async cancelledNotice(job: Job, reason: string | null, tx: Database): Promise<void> {
    // 디바운스 안에서 밀려난 앞 메시지도 이 작업이 맡던 것이라, 처리 중인 작업이 없으면 함께 지운다.
    await settleReactions(tx, job.id, 'cleared');
    if (job.type !== 'task' || reason === 'authorization_revoked') return;
    await this.notice(job, `task-cancelled:${job.id}`, `작업 ${job.id} 취소를 완료했습니다(cancelled). 실행 중인 프로세스가 없음을 확인했고 다시 실행하지 않습니다. 필요하면 새 작업으로 요청하세요.`, tx);
  }
  // laneOnly: 그 레인만 막는 대기다. scheduler를 켜지 않고 waiting_user 행이 laneBusy로 자기 레인만 막는다(작업 레인 토큰의 인증 만료).
  async waitForUser(job: Job, reason: string, options: { laneOnly?: boolean } = {}): Promise<void> {
    await this.db.transaction(async tx => {
      await this.lockConversation(job, tx);
      await this.lockScheduler(tx);
      if (await this.complete(job, 'waiting_user', reason, tx) !== 'waiting_user') return;
      if (!options.laneOnly) await tx.query(`UPDATE controls SET value='true' WHERE key='scheduler'`);
      // task는 작업 레인(codex.ts)이 따로 알린다. 여기서는 chat만.
      if (job.type === 'chat') await this.notice(job, `waiting:${job.id}:${job.attempt}`,
        `${reason === 'auth_expired' ? '모델 인증이 만료돼' : '모델 사용 한도에 걸려'} 작업이 멈췄습니다. `
        + `원인을 해소한 뒤 /resume-model target:${job.id}로 재개하세요. 상태는 /model-status로 확인할 수 있습니다.`, tx);
    });
  }
  async transition(job: Job, state: State, reason: string | null = null): Promise<boolean> {
    // Only an uncertain worker may override cancellation with unknown.
    if (state !== 'unknown') return this.db.transaction(async tx => {
      await this.lockConversation(job, tx);
      return (await this.complete(job, state, reason, tx)) !== undefined;
    });
    return this.db.transaction(async tx => {
      await this.lockConversation(job, tx);
      const row = (await tx.query<Job>(`UPDATE jobs SET state=$3,wait_reason=$4,finished_at=$5
        WHERE id=$1 AND lease_token=$2 AND lease_until>$5 AND state IN ('running','verifying','cancel_requested') RETURNING *`,
      [job.id, job.lease_token, state, reason, this.now()])).rows[0];
      // 권한 철회로 멈춘 대화에는 안내하지 않는다(게시도 막힌다).
      if (row && reason !== 'authorization_revoked') await this.unknownNotice(row, tx);
      return !!row;
    });
  }
  // 안내 삽입(outbox 외래 키)은 대화 행 KEY SHARE를 잡는다. job 행이나 scheduler 행을 쥔 뒤에 대화 행을 기다리면
  // 제어 경로(대화 행 FOR UPDATE → scheduler → job)와 교착하므로, 상태를 바꾸기 전에 대화 행부터 잡는다.
  private async lockConversation(job: Job, tx = this.db): Promise<void> {
    if (job.conversation_id) await tx.query('SELECT id FROM conversations WHERE id=$1 FOR KEY SHARE', [job.conversation_id]);
  }
  // 만료 후보 job ID를 정하고 그 대화 행을 id 순서로 잠근다. 돌려준 ID 밖의 job은 이 트랜잭션에서 바꾸지 않는다.
  private async lockExpiring(tx: Database, where: string, now: number): Promise<string[]> {
    const ids = (await tx.query<{ id: string }>(`SELECT id FROM jobs WHERE ${where} ORDER BY id`, [now])).rows.map(row => row.id);
    if (ids.length) await tx.query(`SELECT id FROM conversations WHERE id IN (SELECT conversation_id FROM jobs WHERE id=ANY($1))
      ORDER BY id FOR KEY SHARE`, [ids]);
    return ids;
  }
  private async unknownNotice(job: Job, tx: Database): Promise<void> {
    if (job.type !== 'chat') return;
    await this.notice(job, `unknown:${job.id}:${job.attempt}`, '작업 종료를 확인하지 못해 새 모델 실행을 멈췄습니다. '
      + '봇이 작업자에게 종료 확인을 계속 시도합니다. 상태는 /model-status로 확인하세요.', tx);
  }
  // 상태 알림. 멱등 키로 한 번만 넣고 멘션하지 않는다(게시는 allowed_mentions parse 빈 배열).
  private async notice(job: Job, key: string, content: string, tx: Database): Promise<void> {
    await this.enqueue({ key, job: job.id, conversation: job.conversation_id, actor: job.owner_id, scope: job.target,
      revision: job.revision.policy, payload: { kind: 'message', channel: job.target.channel, content, classification: 'safe_summary' } }, tx);
  }
  async finish(job: Job, result: unknown, evidence: unknown, content: string, scope: Scope, services: string[] = []): Promise<void> {
    await this.db.transaction(async tx => {
      const conversation = (await tx.query<Conversation>('SELECT * FROM conversations WHERE id=$1 FOR UPDATE', [job.conversation_id])).rows[0];
      if (!conversation || conversation.owner_id !== job.owner_id) throw new Denied();
      if (!conversation.active) { await this.complete(job, 'superseded', 'subscription_stopped', tx); return; }
      const state = await this.complete(job, 'succeeded', null, tx);
      if (!state) throw new Error('stale_result');
      if (state === 'cancelled') return;
      await tx.query('INSERT INTO results VALUES ($1,$2,$3,$4,$5)', [job.id, json(result), json(evidence), 'internal', this.now()]);
      await this.enqueue({ key: `result:${job.id}`, job: job.id, conversation: job.conversation_id,
        actor: job.owner_id, scope, revision: job.revision.policy, services,
        payload: { kind: 'message', channel: scope.channel, content, classification: 'safe_summary' } }, tx);
    });
  }
  // chat·review unknown 조사 예약. 다음 조사 시각은 마이그레이션 없이 controls 행(unknown_probe:<job>)에 둔다.
  // 같은 행을 잠그고 시각이 된 것만 다음 시각으로 미뤄 돌려주므로 게시 서버 둘이 같은 job을 동시에 조사하지 않는다.
  // lease가 바뀌었으면(다시 실행된 뒤 다시 unknown) backoff를 처음부터 센다. 경과 시간만으로 상태를 바꾸지 않는다.
  // /review-cancel로 풀지 않는 이유: 제어 명령은 DB 트랜잭션 안이라 작업자에게 물을 수 없고, 확인 없이 풀면 살아 있는 프로세스 옆에서 다음 작업이 돈다.
  // task는 작업 레인 소멸 확인의 한계로 넣지 않는다. review는 도구 없는 단일 프로세스 그룹이고 작업자가 표식으로 소멸을 확인한다.
  async reserveUnknownProbes(limit = 3): Promise<Job[]> {
    return this.db.transaction(async tx => {
      await tx.query(`DELETE FROM controls WHERE key LIKE 'unknown_probe:%' AND NOT EXISTS
        (SELECT 1 FROM jobs WHERE id=substr(controls.key,15) AND type IN ('chat','review') AND state='unknown')`);
      const jobs = (await tx.query<Job>(`SELECT * FROM jobs WHERE type IN ('chat','review') AND state='unknown' AND lease_token IS NOT NULL
        ORDER BY id LIMIT 50`)).rows;
      const due: Job[] = [];
      for (const job of jobs) {
        if (due.length >= limit) break;
        const key = `unknown_probe:${job.id}`;
        await tx.query(`INSERT INTO controls VALUES ($1,$2) ON CONFLICT DO NOTHING`, [key, json({ lease: job.lease_token, count: 0, next: 0 })]);
        const stored = (await tx.query<{ value: { lease: string; count: number; next: number } }>(
          'SELECT value FROM controls WHERE key=$1 FOR UPDATE', [key])).rows[0]!.value;
        const probe = stored.lease === job.lease_token ? stored : { lease: job.lease_token, count: 0, next: 0 };
        if (probe.next > this.now()) continue;
        const count = probe.count + 1;
        await tx.query('UPDATE controls SET value=$2 WHERE key=$1', [key, json({ lease: job.lease_token, count,
          next: this.now() + Math.min(UNKNOWN_PROBE_MAX_MS, UNKNOWN_PROBE_FIRST_MS * 2 ** (count - 1)) })]);
        due.push(job);
      }
      return due;
    });
  }
  // 작업자가 멈춤을 확인한 unknown을 확정 실패로 끝낸다. 관측한 lease일 때만 바꾸고(CAS), 상태·감사·안내를 함께 쓴다.
  // 새 실행은 시작하지 않는다. chat은 owner가 /retry로, review는 리뷰 명령 댓글이나 새 세대로 다시 실행한다.
  async resolveUnknown(job: Job): Promise<boolean> {
    return this.db.transaction(async tx => {
      await this.lockConversation(job, tx);
      const row = (await tx.query<Job>(`UPDATE jobs SET state='failed',wait_reason='stop_confirmed_after_unknown',finished_at=$3
        WHERE id=$1 AND type IN ('chat','review') AND state='unknown' AND lease_token=$2 RETURNING *`, [job.id, job.lease_token, this.now()])).rows[0];
      if (!row) return false;
      await tx.query('DELETE FROM controls WHERE key=$1', [`unknown_probe:${row.id}`]);
      await tx.query('INSERT INTO audit(kind,subject,detail,created_at) VALUES ($1,$2,$3,$4)',
        ['unknown_stop_confirmed', row.id, json({ attempt: row.attempt }), this.now()]);
      // Job['type']에는 review가 없다(리뷰 작업도 같은 표에 둔다).
      if ((row.type as string) === 'review') {
        // 리뷰 job의 target은 GitHub PR이라 게시할 Discord 채널이 없고 알림 채널은 정책에만 있다. 이 자리에서는 안내하지 않는다.
        // 밀려난 세대의 기록은 그대로 둔다.
        await tx.query(`UPDATE pr_reviews SET review_outcome='failed' WHERE job_id=$1 AND superseded_at IS NULL`, [row.id]);
        return true;
      }
      await this.enqueue({ key: `unknown-resolved:${row.id}:${row.attempt}`, job: row.id, conversation: row.conversation_id,
        actor: row.owner_id, scope: row.target, revision: row.revision.policy,
        payload: { kind: 'message', channel: row.target.channel, classification: 'safe_summary',
          content: `이전 작업이 멈춘 것을 확인했습니다. /retry target:${row.id}으로 다시 실행할 수 있습니다.` } }, tx);
      await settleReactions(tx, row.id, 'failed');
      return true;
    });
  }
  async enqueue(input: { key: string; job?: string; conversation?: string; actor: string; scope: Scope; revision: string; services?: string[]; payload: Delivery['payload'] }, tx?: Database): Promise<void> {
    if (!tx) return this.db.transaction(inner => this.enqueue(input, inner));
    const pages = input.payload.kind === 'message' ? messagePages(input.payload.content) : [input.payload.content];
    for (const [index, content] of pages.entries()) await tx.query(`INSERT INTO outbox(id,job_id,conversation_id,owner_id,scope,policy_revision,idempotency_key,payload,available_at,created_at,service_ids,message_key,page_index)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$9,$10,$11,$12) ON CONFLICT (idempotency_key) DO NOTHING`,
    [randomUUID(), input.job ?? null, input.conversation ?? null, input.actor, json(input.scope), input.revision,
      index ? `${input.key}:page:${index + 1}` : input.key, json({ ...input.payload, content }), this.now(), json(input.services ?? []), input.key, index]);
  }
  async discordPauseUntil(channel?: string): Promise<number> {
    const rows = (await this.db.query<{ value: number }>("SELECT value FROM controls WHERE key='discord_global_after' OR key=$1", [`discord_channel_after:${channel ?? ''}`])).rows;
    return Math.max(0, ...rows.map(row => Number(row.value)));
  }
  async recordRateLimit(error: RateLimited, channel?: string): Promise<void> {
    if (!error.global && !channel) throw new Error('rate_limit_resource_required');
    // GREATEST의 controls.value는 충돌한 같은 키(pause 시각) 한 행뿐이고 이 함수만 숫자로 쓴다. 다른 키의 boolean은 닿지 않는다.
    await this.db.query(`INSERT INTO controls VALUES ($2,to_jsonb($1::bigint))
      ON CONFLICT (key) DO UPDATE SET value=to_jsonb(GREATEST(controls.value::bigint,$1::bigint))`,
    [this.now() + Math.max(1000, error.retryAfterMs), error.global ? 'discord_global_after' : `discord_channel_after:${channel}`]);
  }
  async claimDelivery(): Promise<Delivery | undefined> {
    return this.db.transaction(async tx => {
      // 실행기는 WHERE 조건 순서를 보장하지 않아 key 비교 전에 다른 키의 boolean(scheduler 등)을 bigint로 바꾸다 22023이 난다.
      // CASE 안에서만 형 변환하면 숫자가 아닌 값은 평가되지 않는다.
      const row = (await tx.query<Delivery>(`SELECT o.* FROM outbox o WHERE o.state='pending' AND o.available_at<=$1
        AND NOT EXISTS (SELECT 1 FROM controls WHERE key='discord_global_after'
          AND CASE WHEN jsonb_typeof(value)='number' THEN value::bigint>$1 ELSE false END)
        AND NOT EXISTS (SELECT 1 FROM controls WHERE key='discord_channel_after:' || (o.payload->>'channel')
          AND CASE WHEN jsonb_typeof(value)='number' THEN value::bigint>$1 ELSE false END)
        AND (o.page_index=0 OR EXISTS (SELECT 1 FROM outbox predecessor WHERE predecessor.message_key=o.message_key
          AND predecessor.page_index=o.page_index-1 AND predecessor.state='sent'))
        AND NOT EXISTS (SELECT 1 FROM outbox previous WHERE previous.message_key=o.message_key
          AND previous.page_index<o.page_index AND previous.state<>'sent')
        ORDER BY o.created_at,o.message_key,o.page_index FOR UPDATE OF o SKIP LOCKED LIMIT 1`, [this.now()])).rows[0];
      if (!row) return;
      return (await tx.query<Delivery>(`UPDATE outbox SET state='sending',attempt=attempt+1,dispatch_started=false,
        lease_until=$2,lease_token=$3 WHERE id=$1 RETURNING *`, [row.id, this.now() + DEFAULTS.leaseMs, randomUUID()])).rows[0];
    });
  }
  // 발송 시작의 기준점. 이 UPDATE 한 문장이 lease와 함께 최신 철회(denied_actors)·대화 소유자·구독 상태를 보고
  // dispatch_started를 세운다. READ COMMITTED라 이 문장 시작 전에 커밋된 /revoke는 반드시 보인다. 그 뒤에 커밋된 철회는
  // 이미 시작한 발송을 되돌리지 못한다(confirm의 재인가가 unknown으로 남긴다).
  // 조건은 DiscordPublisher.authorized()의 대화 검사와 같다. 대화 id는 Store.scopeId와 같은 식이다.
  // 철회·대화 거부는 같은 문장에서 blocked로 닫는다(우리 lease일 때만). gap은 일시 상태라 sending 그대로 두고 호출자가 미룬다.
  // 행이 없으면 lease를 잃었다(다른 상태로 옮겨졌거나 만료). 예약 끄기는 state를 바꿔 여기서 lost가 된다.
  async dispatchDelivery(row: Pick<Delivery, 'id' | 'lease_token'>): Promise<DispatchOutcome> {
    const result = (await this.db.query<{ reason: 'ok' | 'revoked' | 'conversation' | 'gap' }>(`WITH gate AS (
      SELECT o.id, CASE
        WHEN EXISTS (SELECT 1 FROM denied_actors d WHERE d.actor_id=o.owner_id) THEN 'revoked'
        WHEN o.scope->>'kind'='channel' THEN 'ok'
        WHEN EXISTS (SELECT 1 FROM conversations c WHERE c.id=s.id AND c.owner_id<>o.owner_id) THEN 'conversation'
        WHEN o.conversation_id IS NULL THEN 'ok'
        WHEN NOT EXISTS (SELECT 1 FROM conversations c WHERE c.id=s.id AND c.active) THEN 'conversation'
        WHEN EXISTS (SELECT 1 FROM conversations c WHERE c.id=s.id AND c.gap) THEN 'gap'
        ELSE 'ok' END AS reason
      FROM outbox o CROSS JOIN LATERAL (SELECT (o.scope->>'kind') || ':' || COALESCE(o.scope->>'guild','direct') || ':' || (o.scope->>'channel') AS id) s
      WHERE o.id=$1)
    UPDATE outbox o SET dispatch_started=(gate.reason='ok'),
      state=CASE WHEN gate.reason IN ('revoked','conversation') THEN 'blocked' ELSE o.state END
    FROM gate WHERE o.id=gate.id AND o.lease_token=$2 AND o.state='sending' AND o.lease_until>$3
    RETURNING gate.reason`, [row.id, row.lease_token, this.now()])).rows[0];
    if (!result) return 'lost';
    return result.reason === 'ok' ? 'dispatched' : result.reason === 'gap' ? 'gap' : 'blocked';
  }
  async deliveryState(row: Delivery, state: string, externalId: string | null = null, delay = 0): Promise<void> {
    await this.db.query(`UPDATE outbox SET state=$3,external_id=COALESCE($4,external_id),available_at=$5,pause_reason=NULL,pause_count=0,
      dispatch_started=CASE WHEN $3='pending' THEN false ELSE dispatch_started END
      WHERE id=$1 AND lease_token=$2 AND state IN ('sending','unknown')`,
      [row.id, row.lease_token, state, externalId, this.now() + delay]);
  }
  async deferConfirmation(row: Delivery): Promise<void> {
    await this.atomic(async store => {
      const current = (await store.db.query<{ pause_count: number }>(`SELECT pause_count FROM outbox
        WHERE id=$1 AND lease_token=$2 AND state='unknown' AND external_id IS NOT NULL FOR UPDATE`, [row.id, row.lease_token])).rows[0];
      if (!current) return;
      const count = Math.min(current.pause_count + 1, 7);
      await store.db.query(`UPDATE outbox SET pause_count=$3,pause_reason='local_confirmation',available_at=$4
        WHERE id=$1 AND lease_token=$2`, [row.id, row.lease_token, count, store.now() + Math.min(60_000, DEFAULTS.retryDelayMs * 2 ** (count - 1))]);
    });
  }
  // 외부 ID 없는 unknown의 marker 검색이 못 찾았거나 실패했을 때 다음 검색 시각을 1초부터 두 배씩 상한까지 늦춘다.
  // available_at(unknown 진입 시각)은 건드리지 않아 24시간 폐기 기한은 그대로다.
  async deferSearch(row: Delivery): Promise<void> {
    await this.atomic(async store => {
      const current = (await store.db.query<{ pause_reason: string | null; pause_count: number }>(`SELECT pause_reason,pause_count FROM outbox
        WHERE id=$1 AND lease_token=$2 AND state='unknown' AND external_id IS NULL FOR UPDATE`, [row.id, row.lease_token])).rows[0];
      if (!current) return;
      const count = current.pause_reason === 'marker_not_found' ? Math.min(current.pause_count + 1, 11) : 1;
      await store.db.query(`UPDATE outbox SET pause_reason='marker_not_found',pause_count=$3,reconcile_after=$4
        WHERE id=$1 AND lease_token=$2`, [row.id, row.lease_token, count,
        store.now() + Math.min(DEFAULTS.reconcileSearchMaxMs, DEFAULTS.retryDelayMs * 2 ** (count - 1))]);
    });
  }
  async pauseDelivery(row: Delivery, reason: string): Promise<void> {
    await this.atomic(async store => {
      const previous = (await store.db.query<{ pause_reason: string | null; pause_count: number }>(
        "SELECT pause_reason,pause_count FROM outbox WHERE id=$1 AND lease_token=$2 AND state='sending' FOR UPDATE", [row.id, row.lease_token])).rows[0];
      if (!previous) return;
      const count = previous.pause_reason === reason ? Math.min(previous.pause_count + 1, 7) : 1;
      const delay = Math.min(60_000, DEFAULTS.retryDelayMs * 2 ** (count - 1));
      await store.db.query(`UPDATE outbox SET state='pending',attempt=GREATEST(0,attempt-1),
        pause_reason=$3,pause_count=$4,available_at=$5,dispatch_started=false WHERE id=$1 AND lease_token=$2`,
      [row.id, row.lease_token, reason, count, store.now() + delay]);
      if (previous.pause_reason !== reason) await store.audit('delivery_paused', row.id, { reason });
    });
  }
  async ackNotice(id: string): Promise<void> {
    const event = (await this.db.query<{ actor_id: string; scope: Scope; conversation_id: string;
      payload: { ackUncertain?: boolean; revision: string } }>('SELECT * FROM events WHERE id=$1', [id])).rows[0]!;
    if (!event.payload.ackUncertain) return;
    if (event.scope.kind === 'channel' && (await this.db.query(
      "SELECT id FROM outbox WHERE payload->>'kind'='thread' AND payload->>'content'=$1", [id])).rows.length) return;
    await this.enqueue({ key: `ack-notice:${id}`, actor: event.actor_id, scope: event.scope,
      conversation: event.conversation_id, revision: event.payload.revision,
      payload: { kind: 'message', channel: event.scope.channel, classification: 'safe_summary',
        content: '상호작용 응답이 만료됐거나 확인되지 않았지만 요청 기록은 저장했습니다. 다시 보내기 전에 이 대화의 /list로 처리 상태를 확인하세요.' } });
  }
  async context(conversation: string, event: string): Promise<unknown[]> {
    return chatContext(this.db, conversation, event);
  }
  async checkpoint(conversation: string, message: string, recovering = false): Promise<void> {
    if (!/^\d+$/.test(message)) return;
    await this.db.query(`UPDATE conversations SET checkpoint=$2 WHERE id=$1 AND (gap=false OR $3)
      AND (checkpoint IS NULL OR checkpoint::numeric<$2::numeric)`, [conversation, message, recovering]);
  }
  async active(conversation: string): Promise<boolean> {
    const row = (await this.db.query<Conversation>('SELECT * FROM conversations WHERE id=$1', [conversation])).rows[0];
    return !!row?.active;
  }
  async lockScheduler(tx = this.db): Promise<void> {
    await tx.query(`INSERT INTO controls VALUES ('scheduler','false') ON CONFLICT DO NOTHING`);
    await tx.query(`SELECT * FROM controls WHERE key='scheduler' FOR UPDATE`);
    await tx.query(`INSERT INTO controls(key,value) SELECT 'scheduler_emergency',value FROM controls WHERE key='scheduler'
      ON CONFLICT DO NOTHING`);
  }
  // 비상 중지와 전역 대기가 없으면 정지를 푼다. 질문 대기와 작업 레인의 인증 대기는 scheduler를 켜지 않는 대기라 해제를 막지 않는다.
  async releaseScheduler(): Promise<boolean> {
    await this.db.query(`UPDATE controls SET value='false' WHERE key='scheduler'
      AND NOT EXISTS (SELECT 1 FROM controls WHERE key='scheduler_emergency' AND value='true')
      AND NOT EXISTS (SELECT 1 FROM jobs WHERE state='waiting_user' AND wait_reason IS DISTINCT FROM 'clarification'
        AND NOT (type='task' AND wait_reason='auth_expired'))`);
    return (await this.db.query<{ value: boolean }>("SELECT value FROM controls WHERE key='scheduler'")).rows[0]!.value;
  }
  // options.review는 호출자가 "정책 owner가 알림 채널에서 보낸 명령"임을 확인했을 때만 true다(리뷰 작업 제어).
  async control(actor: string, conversation: string, action: string, target?: string, cursor?: string,
    options: { review?: boolean } = {}): Promise<unknown> {
    if (action.startsWith('review-')) return this.atomic(store => store.reviewControlLocked(actor, action, target, options.review === true));
    return this.atomic(store => store.controlLocked(actor, conversation, action, target, cursor));
  }
  // 리뷰 작업은 대화가 없어 기존 대화 명령으로 재개·포기할 수 없다. 별도 명령과 별도 권한 검사로만 다룬다.
  private async reviewControlLocked(actor: string, action: string, target: string | undefined, allowed: boolean): Promise<unknown> {
    if (!allowed) return { ok: false, status: '리뷰 작업 제어는 owner가 알림 채널에서만 할 수 있습니다.' };
    if (action === 'review-status') {
      const jobs = (await this.db.query(`SELECT id,state,wait_reason,target FROM jobs WHERE type='review'
        AND state IN ('queued','running','verifying','cancel_requested','waiting_user','unknown') ORDER BY created_at LIMIT 20`)).rows;
      return { ok: true, jobs, status: '한도·인증 원인을 사람이 해소한 뒤 /review-resume target:<job-id>, 포기는 /review-cancel target:<job-id>.' };
    }
    if (action !== 'review-resume' && action !== 'review-cancel') throw new Error('unsupported_control');
    await this.lockScheduler();
    if (action === 'review-resume') {
      const emergency = (await this.db.query<{ value: boolean }>("SELECT value FROM controls WHERE key='scheduler_emergency'")).rows[0]!.value;
      if (emergency) return { ok: false, status: '비상 또는 이전 중지가 유지되고 있습니다. /model-status로 확인하세요.' };
      if (await this.queueFull('review')) return { ok: false, status: '대기열이 가득 찼습니다. 불필요한 작업을 취소한 뒤 재개하세요.' };
      const changed = await this.db.query(`UPDATE jobs SET state='queued',available_at=$2,wait_reason=NULL,
        lease_token=NULL,lease_until=NULL,started_at=NULL,finished_at=NULL
        WHERE id=$1 AND type='review' AND state='waiting_user' AND wait_reason IN ('model_limit','auth_expired') AND attempt<$3 RETURNING id`,
      [target, this.now(), DEFAULTS.maxRetries + 1]);
      if (!changed.rows.length) return { ok: false, status: '한도·인증 대기 중인 리뷰 작업이 아니거나 재시도 한도에 도달했습니다. /review-status로 확인하세요.' };
      const paused = await this.releaseScheduler();
      await this.audit('review_wait_resumed', target!, { actor, paused });
      return { ok: true, paused, status: '원인 해소 확인을 기록하고 리뷰 작업을 재개했습니다.' };
    }
    const changed = await this.db.query(`UPDATE jobs SET state=CASE WHEN state IN ('queued','waiting_user') THEN 'cancelled' ELSE 'cancel_requested' END,
      finished_at=CASE WHEN state IN ('queued','waiting_user') THEN $2 ELSE finished_at END
      WHERE id=$1 AND type='review' AND state IN ('queued','running','verifying','waiting_user') RETURNING id`, [target, this.now()]);
    if (!changed.rows.length) {
      const unconfirmed = (await this.db.query(`SELECT id FROM jobs WHERE id=$1 AND type='review' AND state='unknown'`, [target])).rows.length > 0;
      return { ok: false, status: unconfirmed ? '종료를 확인하지 못한 리뷰 작업은 취소로 풀지 않습니다. 봇이 작업자에게 종료 확인을 계속 시도하고, 확인되면 실패로 끝납니다.'
        : '취소할 리뷰 작업이 없거나 취소 가능한 상태가 아닙니다.' };
    }
    const paused = await this.releaseScheduler();
    await this.audit('review_cancelled', target!, { actor, paused });
    return { ok: true, paused, status: '리뷰 작업 취소 요청. 실행 중 작업의 종료 확인 전에는 cancelled로 표시하지 않습니다.' };
  }
  private async controlLocked(actor: string, conversation: string, action: string, target?: string, cursor?: string): Promise<unknown> {
    const current = (await this.db.query<Conversation>('SELECT * FROM conversations WHERE id=$1 FOR UPDATE', [conversation])).rows[0];
    if (current && current.scope.kind !== 'channel' && current.owner_id !== actor) return { ok: false, status: '대화 소유자가 일치하지 않습니다.' };
    if (action === 'stop' || action === 'resume') {
      if (!current || current.scope.kind === 'channel') return { ok: false, status: '구독 제어는 작업을 시작한 스레드 또는 DM에서 실행하세요.' };
      if (action === 'resume') await this.activate(current, cursor);
      else {
        await this.db.query(`UPDATE conversations SET active=false,gap=false,subscription_epoch=subscription_epoch+1,
          recovery_token=NULL,recovery_until=NULL WHERE id=$1`, [conversation]);
        await this.db.query(`UPDATE events SET buffered=false,payload=payload || '{"ignored":"subscription_stopped"}'::jsonb
          WHERE conversation_id=$1 AND buffered=true`, [conversation]);
      }
      return { active: action === 'resume' };
    }
    if (action === 'list') {
      const jobs = (await this.db.query('SELECT id,state,wait_reason FROM jobs WHERE owner_id=$1 AND conversation_id=$2 ORDER BY created_at', [actor, conversation])).rows;
      return jobs.length ? jobs : { ok: false, status: '현재 대화에 작업이 없습니다. 작업을 시작한 스레드에서 확인하세요.' };
    }
    if (['cancel', 'retry', 'emergency-stop', 'resume-model', 'model-status'].includes(action)) await this.lockScheduler();
    if (action === 'model-status') {
      const paused = (await this.db.query<{ value: boolean }>("SELECT value FROM controls WHERE key='scheduler'")).rows[0]!.value;
      const emergency = (await this.db.query<{ value: boolean }>("SELECT value FROM controls WHERE key='scheduler_emergency'")).rows[0]!.value;
      const waiting = (await this.db.query(`SELECT id,wait_reason FROM jobs WHERE owner_id=$1 AND conversation_id=$2
        AND state='waiting_user' ORDER BY created_at LIMIT 5`, [actor, conversation])).rows;
      const executionPending = (await this.db.query("SELECT id FROM jobs WHERE state IN ('running','verifying','cancel_requested','unknown') AND type<>'read' LIMIT 1")).rows.length > 0;
      const taskLaneClosed = (await this.db.query<{ closed_reason: ExecutionLaneClosedReason | null }>(`SELECT closed_reason FROM execution_lanes WHERE lane='task'`)).rows[0]?.closed_reason ?? null;
      const laneNote = taskLaneClosed === 'unknown' ? '작업 레인은 unknown으로 닫혀 있습니다. 작업자 프로세스 0개를 확인한 뒤 /task-release target:<job-id>로 해제하세요. '
        : taskLaneClosed ? `작업 레인의 새 접수가 닫혀 있습니다(${taskLaneClosed}). ` : '';
      return { paused, emergency, waiting, executionPending, taskLaneClosed, status: `${laneNote}한도·인증 원인을 사람이 해소한 뒤 /resume-model target:<job-id>, 포기는 /cancel target:<job-id>. 비상/이전 중지는 /resume-model target:emergency-stop으로 확인하세요.` };
    }
    if (action === 'resume-model') {
      if (target === 'emergency-stop') {
        const closed = (await this.db.query<{ closed_reason: ExecutionLaneClosedReason | null }>(`SELECT closed_reason FROM execution_lanes WHERE lane='task' FOR UPDATE`)).rows[0]?.closed_reason ?? null;
        // 작업 레인의 unknown은 그 레인이 닫혀 있다고 기록된 때만 해제를 막지 않는다. 닫힘 없이 풀면 새 작업을 받는다.
        // 작업 루프를 켜지 않은 배치는 이 행이 닫히지 않아, 슬롯을 함께 쓰는 task unknown이 지금처럼 해제를 막는다.
        if ((await this.db.query(`SELECT j.id FROM jobs j WHERE j.type<>'read' AND (j.state IN ('running','verifying','cancel_requested')
          OR (j.state='unknown' AND NOT ($1::boolean AND ${TASK_LANE_UNKNOWN}))) LIMIT 1`, [closed === 'unknown'])).rows.length)
          return { ok: false, status: '실행 중이거나 종료를 확인하지 못한 작업이 있습니다. 중지 확인 전에는 재개할 수 없습니다.' };
        await this.db.query("UPDATE controls SET value='false' WHERE key='scheduler_emergency'");
        const paused = await this.releaseScheduler();
        const unknownJobs = closed === 'unknown' ? (await this.db.query<{ id: string }>(`SELECT j.id FROM jobs j WHERE ${TASK_LANE_UNKNOWN} ORDER BY j.created_at,j.id LIMIT 5`)).rows.map(row => row.id) : [];
        await this.audit('model_emergency_released', actor, { conversation, paused, taskLaneClosed: closed, taskUnknownJobs: unknownJobs });
        const laneNote = closed === 'unknown'
          ? ` 대화·리뷰는 다시 동작하지만 작업 레인은 unknown으로 닫힌 채입니다(작업 ${unknownJobs.join(', ')}). 작업자 프로세스 0개를 확인한 뒤 /task-release target:<job-id>로 해제하세요.`
          : closed ? ` 작업 레인의 새 접수는 닫힌 채입니다(${closed}).` : '';
        return { ok: true, paused, taskLane: { closed, unknownJobs },
          status: `${paused ? '비상 중지를 해제했습니다. 남은 waiting_user는 해당 대화에서 재개하거나 취소하세요.' : '비상 중지를 해제했습니다.'}${laneNote}` };
      }
      const emergency = (await this.db.query<{ value: boolean }>("SELECT value FROM controls WHERE key='scheduler_emergency'")).rows[0]!.value;
      if (emergency) return { ok: false, status: '비상 또는 이전 중지가 유지되고 있습니다. /model-status로 확인하세요.' };
      if (!current?.active || current.gap) return { ok: false, status: '현재 대화의 구독과 누락 복구를 먼저 확인하세요.' };
      if (await this.queueFull('chat')) return { ok: false, status: '대기열이 가득 찼습니다. 불필요한 작업을 취소한 뒤 재개하세요.' };
      const changed = await this.db.query(`UPDATE jobs SET state='queued',available_at=$4,wait_reason=NULL,
        lease_token=NULL,lease_until=NULL,started_at=NULL,finished_at=NULL
        WHERE id=$1 AND owner_id=$2 AND conversation_id=$3 AND state='waiting_user'
        AND wait_reason IN ('model_limit','auth_expired') AND attempt<$5 RETURNING id`,
      [target, actor, conversation, this.now(), DEFAULTS.maxRetries + 1]);
      if (!changed.rows.length) return { ok: false, status: '현재 대화의 한도·인증 대기 작업이 아니거나 재시도 한도에 도달했습니다. /list로 확인하거나 /cancel로 포기하세요.' };
      const paused = await this.releaseScheduler();
      await this.audit('model_wait_resumed', target!, { actor, conversation, paused });
      return { ok: true, paused, status: '원인 해소 확인을 기록하고 작업을 재개했습니다.' };
    }
    if (action === 'cancel') {
      const changed = await this.db.query<Job>(`UPDATE jobs SET state=CASE WHEN state IN ('queued','waiting_user') THEN 'cancelled' ELSE 'cancel_requested' END,
        finished_at=CASE WHEN state IN ('queued','waiting_user') THEN $4 ELSE finished_at END
        WHERE id=$1 AND owner_id=$2 AND conversation_id=$3 AND state IN ('queued','running','verifying','waiting_user') RETURNING *`, [target, actor, conversation, this.now()]);
      const job = changed.rows[0];
      if (!job) return { ok: false, status: '취소할 작업이 현재 대화에 없거나 취소 가능한 상태가 아닙니다.' };
      if (job.state === 'cancelled') await this.cancelledNotice(job, null, this.db);
      await this.releaseScheduler();
      return { status: '취소 요청. 실행 중 작업의 종료 확인 전에는 cancelled로 표시하지 않습니다.' };
    }
    if (action === 'retry') {
      // accept()·resume-model과 같이 스케줄러 행 잠금 아래에서 세어 동시 재시도도 상한을 넘지 않는다.
      // 상한은 대상의 실제 종류로 센다. read는 모델 몫(90)이 아니라 전체 상한만 보므로 모델이 정체해도 조회를 다시 돌 수 있다.
      const kind = (await this.db.query<{ type: Job['type'] }>('SELECT type FROM jobs WHERE id=$1 AND owner_id=$2 AND conversation_id=$3',
        [target, actor, conversation])).rows[0]?.type ?? 'chat';
      if (await this.queueFull(kind)) return { ok: false, status: '대기열이 가득 찼습니다. 불필요한 작업을 취소한 뒤 재시도하세요.' };
      // CHANGE 자식 job을 다시 돌리지 않는다. 모델을 다시 부르는 길은 새 generation뿐이다.
      // 다시 시작하면 요청 원문(events.payload.text)을 읽는다. 보존 기간이 지나 지웠으면 빈 요청으로 모델을 부르게 되므로 받지 않는다.
      // 원문 정리도 scheduler 행을 잠그고 지우므로 이 판정과 엇갈리지 않는다(raw-text-retention.ts).
      const changed = await this.db.query(`UPDATE jobs SET state='queued',available_at=$4,wait_reason=NULL
        WHERE id=$1 AND owner_id=$2 AND conversation_id=$3 AND state='failed' AND attempt<$5
        AND NOT EXISTS (SELECT 1 FROM change_child_jobs cc WHERE cc.job_id=jobs.id)
        AND NOT EXISTS (SELECT 1 FROM events e WHERE e.id=jobs.event_id AND e.text_purged_at IS NOT NULL) RETURNING id`,
      [target, actor, conversation, this.now(), DEFAULTS.maxRetries + 1]);
      if (!changed.rows.length) {
        const purged = (await this.db.query(`SELECT 1 FROM jobs j JOIN events e ON e.id=j.event_id
          WHERE j.id=$1 AND j.owner_id=$2 AND j.conversation_id=$3 AND e.text_purged_at IS NOT NULL`, [target, actor, conversation])).rows.length > 0;
        if (purged) return { ok: false, status: '보존 기간(7일)이 지나 요청 원문을 지워 재시도할 수 없습니다. 같은 내용을 새로 요청하세요.' };
        return { ok: false, status: '재시도할 작업이 현재 대화에 없거나 상태·재시도 한도가 허용하지 않습니다.' };
      }
      return { status: '확인된 실패 작업만 재시도합니다.' };
    }
    if (action === 'emergency-stop') {
      await this.db.query("UPDATE controls SET value='true' WHERE key='scheduler_emergency'");
      await this.db.query(`INSERT INTO controls VALUES ('scheduler','true') ON CONFLICT (key) DO UPDATE SET value='true'`);
      await this.db.query(`UPDATE jobs SET state='cancel_requested' WHERE state IN ('running','verifying') AND type<>'read'`);
      return { status: '새 모델 호출 차단, 실행 중 작업 취소 요청' };
    }
    throw new Error('unsupported_control');
  }
  async audit(kind: string, subject: string, detail: unknown): Promise<void> {
    await this.db.query('INSERT INTO audit(kind,subject,detail,created_at) VALUES ($1,$2,$3,$4)', [kind, subject, json(detail), this.now()]);
  }
}
