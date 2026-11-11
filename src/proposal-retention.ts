import type { Scope } from './contracts.js';
import type { Database } from './database.js';
import { Store } from './store.js';

// 제안 표(migrations/021_proposals.sql)의 값 보존 계약: 끝 상태가 되면 value·source_event를 비운다. 이 파일은 버튼 입력 없이도
// 그 계약이 지켜지게 하는 정리다. 원문 주기 정리(raw-text-retention.ts)가 시작·1시간마다 스위치와 무관하게 부른다.
// proposals.ts(제안 처리 전체)를 import하지 않는다: 원문 정리 → 기억 명령 → 제안 처리로 import가 돌아 들어온다.

// 확인한 실행이 끝났다는 기록 없이 게시 서버가 멈췄다. 실행됐을 수도 있어 확인을 권한다.
export const PROPOSAL_INTERRUPTED_TEXT = '확인한 요청을 처리하는 중에 제가 멈춰서 처리됐는지 확인하지 못했어요. 상태를 확인해 달라고 한 뒤 필요하면 다시 말해 주세요.';
// 만료된 대기 제안을 끝내고 값을 비운다. 새 제안을 만들 때(proposals.ts)와 주기 정리가 부른다.
export async function expirePending(db: Database, now: number): Promise<number> {
  return (await db.query(`UPDATE proposals SET state='expired',reason='expired',value=NULL,source_event=NULL,settled_at=$1
    WHERE state='pending' AND expires_at<=$1 RETURNING id`, [now])).rows.length;
}

// 커밋 뒤 실행(later)의 의도 표시. "할게요" 트랜잭션이 confirmed와 함께 사유 칸에 적고 실행 입력(value·source_event)을 남긴다.
// 실행이 끝나면 finishProposalRun이 지우고(결과 안내 글을 남긴다), 그 전에 게시 서버가 멈췄으면 settleInterruptedRuns가 실패 안내를 남기고 지운다.
export const RUN_PENDING = 'run_pending';
// 커밋 뒤 실행이 아직 도는 중일 수 있는 시간. 처리기는 DB와 짧은 외부 호출이라 이보다 오래 걸리면 멈춘 것으로 본다.
export const RUN_INTERRUPTED_AFTER_MS = 10 * 60_000;

// 끝난 실행의 결과를 버튼 응답이 전하지 못했을 때 그 스레드에 대신 게시하기까지의 시간. 응답은 이보다 훨씬 빨리 끝난다.
export const RUN_RESULT_NOTICE_AFTER_MS = 10 * 60_000;
const resultKey = (proposal: string) => `proposal:${proposal}`;

// publicNotice: 결과 문장을 스레드 일반 글로 낼 본문. 공개 검사를 지난 결과이거나 값 없는 고정 안내다(proposals.ts publicRunResult).
// 검사가 proposals.ts에 있는 것은 위의 import 고리 때문이다(공개 검사 → 리뷰 정책 → … → 제안 처리).
export interface RunResult { proposal: string; conversation: string; owner: string; scope: Scope; publicNotice: string; revision: string }
// "할게요"로 끝난 실행의 결과를 RUN_RESULT_NOTICE_AFTER_MS 뒤에 그 스레드에 게시할 글로 남긴다. 제안 행을 끝낸 트랜잭션 안에서
// 부른다. 그래서 끝낸 뒤 버튼 응답 전에 멈춰도 결과가 남는다. 응답이 전해지면 호출자가 withdrawRunResult로 지운다.
// 멱등 키는 중단 안내와 같은 proposal:<id>다. 한 제안은 둘 중 한 트랜잭션에서만 끝나므로 둘이 같이 생기지 않는다.
// store는 그 트랜잭션에 묶인 Store여야 한다(enqueue에 같은 연결을 넘긴다. 트랜잭션 연결에서 새 트랜잭션은 열 수 없다).
export async function enqueueRunResult(store: Store, run: RunResult): Promise<void> {
  await store.enqueue({ key: resultKey(run.proposal), conversation: run.conversation, actor: run.owner, scope: run.scope, revision: run.revision,
    payload: { kind: 'message', channel: run.scope.channel, content: run.publicNotice, classification: 'safe_summary' } }, store.db);
  await store.db.query("UPDATE outbox SET available_at=$2 WHERE message_key=$1 AND state='pending'", [resultKey(run.proposal), store.now() + RUN_RESULT_NOTICE_AFTER_MS]);
}

export interface FinishedRun { proposal: string; failed: boolean; publicNotice: string; revision: string; now: number }
// 커밋 뒤 실행이 끝났다(성공이든 처리기 오류든). 값 보존 계약대로 실행 입력을 비운다. 사유는 성공이면 비우고 오류면 run_failed다.
// 같은 트랜잭션에 결과 글(enqueueRunResult)을 남긴다(거절·실패 포함, 성공이면 성공 문장).
// 주기 정리가 먼저 run_interrupted로 끝냈으면 바꾸지 않고(그쪽 안내가 같은 키로 이미 있다) false를 돌려준다.
export async function finishProposalRun(db: Database, run: FinishedRun): Promise<boolean> {
  return db.transaction(async tx => {
    const row = (await tx.query<{ conversation_id: string; owner_id: string; scope: Scope | string }>(
      `UPDATE proposals SET reason=$2,value=NULL,source_event=NULL WHERE id=$1 AND reason=$3 RETURNING conversation_id,owner_id,scope`,
      [run.proposal, run.failed ? 'run_failed' : null, RUN_PENDING])).rows[0];
    if (!row) return false;
    const scope = typeof row.scope === 'string' ? JSON.parse(row.scope) as Scope : row.scope;
    await enqueueRunResult(new Store(tx, () => run.now), { proposal: run.proposal, conversation: row.conversation_id, owner: row.owner_id, scope,
      publicNotice: run.publicNotice, revision: run.revision });
    return true;
  });
}

// 버튼 응답이 전해졌거나 응답 실패 안내가 남았다. 대신 게시할 결과 글은 아직 잡히지 않았을 때만 지운다(blocked로 두면 운영 지표의
// 막힌 게시로 쌓인다). 응답이 RUN_RESULT_NOTICE_AFTER_MS를 넘겨 게시자가 이미 잡았으면 결과가 한 번 더 보일 수 있다.
export async function withdrawRunResult(db: Database, proposal: string): Promise<void> {
  await db.query("DELETE FROM outbox WHERE message_key=$1 AND state='pending'", [resultKey(proposal)]);
}

// 확정했지만 실행이 끝났다는 기록 없이 오래된 제안. 실행됐는지 알 수 없어 다시 실행하지 않고(기억 저장처럼 두 번 하면 둘이 되는
// 처리기가 있다) 그 스레드에 확인을 권하는 안내를 한 번 남기고 실행 입력을 비운다. 행 전이(사유 조건부)와 안내 글(멱등 키
// proposal:<id>)이 한 트랜잭션이라 게시 서버 둘이 같이 돌아도 안내는 하나다.
export async function settleInterruptedRuns(db: Database, now: number): Promise<number> {
  return db.transaction(async tx => {
    const store = new Store(tx, () => now);
    const rows = (await tx.query<{ id: string; conversation_id: string; owner_id: string; scope: Scope | string; revision: string }>(
      `UPDATE proposals p SET reason='run_interrupted',value=NULL,source_event=NULL FROM jobs j
       WHERE j.id=p.source_job AND p.state='confirmed' AND p.reason=$1 AND p.settled_at<=$2
       RETURNING p.id,p.conversation_id,p.owner_id,p.scope,j.revision->>'policy' AS revision`, [RUN_PENDING, now - RUN_INTERRUPTED_AFTER_MS])).rows;
    for (const row of rows) {
      const scope = typeof row.scope === 'string' ? JSON.parse(row.scope) as Scope : row.scope;
      await store.audit('proposal_run_interrupted', row.id, {});
      await store.enqueue({ key: `proposal:${row.id}`, conversation: row.conversation_id, actor: row.owner_id, scope, revision: row.revision,
        payload: { kind: 'message', channel: scope.channel, content: PROPOSAL_INTERRUPTED_TEXT, classification: 'safe_summary' } }, tx);
    }
    return rows.length;
  });
}
