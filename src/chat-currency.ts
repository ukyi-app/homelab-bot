import type { Database } from './database.js';

// 대화 작업의 결과가 아직 그 대화의 최신 말에 대한 것인가. 그 뒤 같은 대화에 새 대화 요청이 왔으면 옛 말에서 읽은 제안을 실행하지 않는다
// (다음 대화 차례가 같은 기록을 보고 다시 판단한다).
export async function chatJobCurrent(db: Database, job: string): Promise<boolean> {
  const row = (await db.query<{ current: boolean }>(`SELECT j.state='succeeded' AND NOT EXISTS (SELECT 1 FROM jobs n
    JOIN events ne ON ne.id=n.event_id WHERE n.conversation_id=j.conversation_id AND n.type='chat' AND n.id<>j.id
      AND ne.event_order>(SELECT event_order FROM events WHERE id=j.event_id)) AS current FROM jobs j WHERE j.id=$1`, [job])).rows[0];
  return row?.current === true;
}

// 확인 없이 바로 실행하는 제안이 네트워크 조회 뒤에 쓰기 직전 다시 본다. 호출자의 트랜잭션 안에서 부른다.
// 새 요청 접수(Store.accept)가 대화 행을 잡으므로, 그 행을 잠근 뒤 같은 연결로 봐야 조회 중에 접수된 새 말을 놓치지 않는다.
export async function lockedChatJobCurrent(db: Database, job: string): Promise<boolean> {
  const conversation = (await db.query<{ conversation_id: string }>('SELECT conversation_id FROM jobs WHERE id=$1', [job])).rows[0]?.conversation_id;
  if (conversation === undefined) return false;
  await db.query('SELECT id FROM conversations WHERE id=$1 FOR UPDATE', [conversation]);
  return chatJobCurrent(db, job);
}

// 바로 실행하던 제안의 대화가 그사이 새 말로 대체됐다. 받는 쪽(제안 처리)은 답을 달지 않고 제안을 버린다.
export class ChatSuperseded extends Error {
  constructor() { super('chat_superseded'); }
}
