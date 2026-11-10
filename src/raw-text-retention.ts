import type { Database } from './database.js';
import { JOB_FINAL, sessionHeld } from './task-bridge.js';

// 정리 경로가 따로 없던 원문 칸 네 개의 7일 보존(DECISIONS T31). 다섯 번째 칸 change_requests.brief는
// CHANGE 원문과 같은 건·같은 기준 시각이라 purgeExpiredChangeContent가 같은 트랜잭션에서 지운다.
// 모두 행은 남기고 원문만 비운 뒤 지운 시각과 지우기 전 원문의 SHA-256을 적는다. 시각 기준이라 백업에서 옛 행이 돌아와도 다음 정리가 다시 고른다.
export const RAW_TEXT_RETENTION_MS = 7 * 86_400_000;
export const RAW_TEXT_PURGE_BATCH = 200;
const ROUNDS = 20;
// 정리 주기. CHANGE·질문 답 보존 정리와 같은 1시간이다.
export const RAW_TEXT_PURGE_EVERY_MS = 3_600_000;
export interface RawTextPurged { events: number; prompts: number; results: number; outbox: number }

// 한 번에 BATCH씩, 한 바퀴에 최대 ROUNDS번 돈다. 복원 직후 밀린 행이 많아도 다음 주기까지 기다리지 않게 하되 한 바퀴가 끝없이 돌지는 않는다.
async function rounds(step: () => Promise<number>): Promise<number> {
  let total = 0;
  for (let round = 0; round < ROUNDS; round++) {
    const purged = await step();
    total += purged;
    if (purged < RAW_TEXT_PURGE_BATCH) break;
  }
  return total;
}
const digestOf = (expression: string) => `encode(sha256(convert_to(${expression},'UTF8')),'hex')`;

// Discord 입력 원문(events.payload.text). 기준 시각은 받은 때(received_at)다. 행·semantic_key·다른 payload 칸은 중복 판정과 기록에 쓰여 남긴다.
// 원문을 다시 읽는 자리는 모두 아래 조건으로 고르지 않는다.
//   - 끝나지 않은 job의 요청: 시작(codex.ts·claude-task-bridge.ts·read-runtime.ts)과 대화 맥락(chat-context.ts)이 읽는다.
//   - 누락 복구 버퍼(buffered): 복구가 원문으로 다시 받는다(discord.ts).
//   - 확정 전 스레드 게시(outbox kind=thread의 content가 이 event ID): 확정 때 원문으로 job을 만들거나 경보 요약을 게시한다.
// 끝난 job을 되살리는 /retry는 원문을 지운 요청을 받지 않는다(store.ts). 그 판정과 이 UPDATE를 scheduler 행 잠금으로 직렬화해
// 정리가 고른 뒤 /retry가 되살리거나, /retry가 본 뒤 정리가 지우는 일이 없게 한다.
// 수신 경로는 event 행을 잠근 뒤 scheduler 행을 잡는다(accept). 여기는 반대 순서라 잠긴 event 행은 기다리지 않고 건너뛴다(다음 주기에 고른다).
export async function purgeExpiredEventText(db: Database, now: number, retentionMs = RAW_TEXT_RETENTION_MS): Promise<number> {
  return rounds(() => db.transaction(async tx => {
    await tx.query(`INSERT INTO controls VALUES ('scheduler','false') ON CONFLICT DO NOTHING`);
    await tx.query(`SELECT 1 FROM controls WHERE key='scheduler' FOR UPDATE`);
    return (await tx.query<{ id: string }>(`UPDATE events e SET payload=jsonb_set(e.payload,'{text}','""'::jsonb),text_purged_at=$2,
        text_sha256=COALESCE(e.text_sha256, ${digestOf(`e.payload->>'text'`)})
      WHERE e.id IN (SELECT e2.id FROM events e2
        WHERE e2.text_purged_at IS NULL AND e2.received_at<=$1 AND jsonb_typeof(e2.payload->'text')='string' AND e2.payload->>'text'<>''
        AND e2.buffered=false
        AND NOT EXISTS (SELECT 1 FROM jobs j WHERE j.event_id=e2.id AND j.state<>ALL($3::text[]))
        AND NOT EXISTS (SELECT 1 FROM outbox o WHERE o.payload->>'kind'='thread' AND o.payload->>'content'=e2.id AND o.state IN ('pending','sending','unknown'))
        ORDER BY e2.received_at,e2.id LIMIT ${RAW_TEXT_PURGE_BATCH} FOR UPDATE OF e2 SKIP LOCKED)
      AND e.text_purged_at IS NULL RETURNING e.id`, [now - retentionMs, now, [...JOB_FINAL]])).rows.length;
  }));
}

// 모델이 낸 질문(codex_questions.prompt)과 변경 질문의 선택지(options, C28). 기준 시각과 예외는 같은 행의 답(purgeExpiredTaskAnswers)과 같다.
// 끝나지 않은 job은 질문을 다시 보여 주고(status), 대기·unknown·정리 전 세션은 재개·마무리가 그 job을 아직 다룬다.
// 선택지는 NULL로 두고 지우기 전 jsonb text 표현의 digest를 options_sha256에 남긴다. 지운 시각은 prompt_purged_at이 함께 말한다.
export async function purgeExpiredQuestionPrompts(db: Database, now: number, retentionMs = RAW_TEXT_RETENTION_MS): Promise<number> {
  return rounds(async () => (await db.query<{ id: string }>(`UPDATE codex_questions q SET prompt='',prompt_purged_at=$2,
      prompt_sha256=COALESCE(q.prompt_sha256, ${digestOf('q.prompt')}),
      options=NULL,options_sha256=COALESCE(q.options_sha256, CASE WHEN q.options IS NULL THEN NULL ELSE ${digestOf('q.options::text')} END)
    WHERE q.id IN (SELECT q2.id FROM codex_questions q2 JOIN jobs j ON j.id=q2.job_id
      WHERE q2.prompt_purged_at IS NULL AND j.state=ANY($3::text[]) AND COALESCE(j.finished_at, q2.created_at)<=$1
      AND NOT ${sessionHeld('q2.job_id')}
      ORDER BY q2.id LIMIT ${RAW_TEXT_PURGE_BATCH})
    AND q.prompt_purged_at IS NULL RETURNING q.id`, [now - retentionMs, now, [...JOB_FINAL]])).rows.length);
}

// 작업 결과(results.result, 모델 출력). 기준 시각은 job이 끝 상태에 든 때다. 예외는 질문과 같다.
// evidence(마무리가 resultDigest를 읽는다)·classification은 남긴다. digest는 jsonb의 text 표현에서 계산한다.
export async function purgeExpiredResults(db: Database, now: number, retentionMs = RAW_TEXT_RETENTION_MS): Promise<number> {
  return rounds(async () => (await db.query<{ job_id: string }>(`UPDATE results r SET result='{}'::jsonb,result_purged_at=$2,
      result_sha256=COALESCE(r.result_sha256, ${digestOf('r.result::text')})
    WHERE r.job_id IN (SELECT r2.job_id FROM results r2 JOIN jobs j ON j.id=r2.job_id
      WHERE r2.result_purged_at IS NULL AND j.state=ANY($3::text[]) AND COALESCE(j.finished_at, r2.created_at)<=$1
      AND NOT ${sessionHeld('r2.job_id')}
      ORDER BY r2.job_id LIMIT ${RAW_TEXT_PURGE_BATCH})
    AND r.result_purged_at IS NULL RETURNING r.job_id`, [now - retentionMs, now, [...JOB_FINAL]])).rows.length);
}

// 게시 본문(outbox.payload.content). 끝 상태(sent, blocked)만 고르고 pending·sending·unknown은 게시·대조가 본문을 읽어 남긴다.
// 기준 시각은 available_at이다. sent로 바꾸는 유일한 자리(deliveryState)가 그 시각을 적어 보낸 시각과 같다. blocked는 막기 전 마지막 예정 시각이다.
// kind=thread의 content는 원문이 아니라 event ID라 고르지 않는다(경보 묶음이 그 값으로 이어 붙인다).
// 상태 칸을 바꾸지 않아 outbox 상태 트리거(UPDATE OF state)는 돌지 않는다.
export async function purgeExpiredOutboxContent(db: Database, now: number, retentionMs = RAW_TEXT_RETENTION_MS): Promise<number> {
  return rounds(async () => (await db.query<{ id: string }>(`UPDATE outbox o SET payload=jsonb_set(o.payload,'{content}','""'::jsonb),content_purged_at=$2,
      content_sha256=COALESCE(o.content_sha256, ${digestOf(`o.payload->>'content'`)})
    WHERE o.id IN (SELECT o2.id FROM outbox o2
      WHERE o2.content_purged_at IS NULL AND o2.state IN ('sent','blocked') AND o2.available_at<=$1
      AND o2.payload->>'kind'<>'thread' AND jsonb_typeof(o2.payload->'content')='string' AND o2.payload->>'content'<>''
      ORDER BY o2.available_at,o2.id LIMIT ${RAW_TEXT_PURGE_BATCH})
    AND o.content_purged_at IS NULL AND o.state IN ('sent','blocked') RETURNING o.id`, [now - retentionMs, now])).rows.length);
}

export async function purgeExpiredRawText(db: Database, now: number, retentionMs = RAW_TEXT_RETENTION_MS): Promise<RawTextPurged> {
  return {
    events: await purgeExpiredEventText(db, now, retentionMs),
    prompts: await purgeExpiredQuestionPrompts(db, now, retentionMs),
    results: await purgeExpiredResults(db, now, retentionMs),
    outbox: await purgeExpiredOutboxContent(db, now, retentionMs),
  };
}
