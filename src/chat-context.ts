import { DEFAULTS } from './contracts.js';
import type { Database } from './database.js';

// 작업자에게 넘기는 untrusted 대화 기록. owner 메시지와, 봇이 owner에게 실제로 게시한 자기 답을 시간 순서로 섞는다.
// 작업자 스키마가 20개를 넘으면 요청을 거부하므로 전체 항목 수를 함께 센다.
export const CONTEXT_BYTES = 32768;
export type ContextItem = ({ from: 'owner' } & Record<string, unknown>) | { from: 'bot'; text: string; partial?: true };
interface BotAnswer { position: bigint; pages: string[]; partial: boolean }
type Entry = { from: 'owner'; item: ContextItem; current: boolean } | { from: 'bot'; answer: BotAnswer };

const snowflake = (value: string | null | undefined) => typeof value === 'string' && /^\d{1,20}$/.test(value);
const bytes = (value: unknown) => Buffer.byteLength(JSON.stringify(value));

export async function chatContext(db: Database, conversation: string, event: string,
  limits = { messages: DEFAULTS.contextMessages, bytes: CONTEXT_BYTES }): Promise<ContextItem[]> {
  const current = (await db.query<{ delivery_id: string; event_order: string }>(`SELECT e.delivery_id,e.event_order FROM events e
    JOIN conversations c ON c.id=e.conversation_id WHERE e.id=$2 AND e.conversation_id=$1 AND e.actor_id=c.owner_id`,
  [conversation, event])).rows[0];
  if (!current) return [];
  const owners = (await db.query<{ id: string; delivery_id: string; payload: Record<string, unknown> }>(`SELECT id,delivery_id,payload
    FROM events WHERE conversation_id=$1 AND accepted=true AND actor_id=(SELECT owner_id FROM conversations WHERE id=$1)
    AND event_order<=$2 ORDER BY event_order DESC LIMIT $3`, [conversation, current.event_order, limits.messages])).rows.reverse();
  const answers = snowflake(current.delivery_id) ? await botAnswers(db, conversation, current.delivery_id, limits.messages) : [];

  // 봇 답은 Discord ID가 자기보다 큰 첫 owner 메시지 앞에 둔다. ID가 숫자가 아닌 owner 메시지(시험·옛 기록)는 기존 순서 자리 그대로다.
  const timeline: Entry[] = [];
  let next = 0;
  for (const row of owners) {
    if (snowflake(row.delivery_id)) {
      while (next < answers.length && answers[next]!.position < BigInt(row.delivery_id)) timeline.push({ from: 'bot', answer: answers[next++]! });
    }
    // 발화자 라벨은 저장된 payload가 덮지 못하게 마지막에도 쓴다(키 순서는 from이 앞).
    timeline.push({ from: 'owner', item: Object.assign({ from: 'owner' as const }, row.payload, { from: 'owner' as const }), current: row.id === event });
  }
  while (next < answers.length) timeline.push({ from: 'bot', answer: answers[next++]! });
  return select(timeline, limits);
}

// 같은 대화·같은 owner의 chat 결과 중 게시가 확정된(sent) 페이지만. 실패 안내·제어 ACK·스레드·경보는 message_key가
// result:<job>이 아니라서, read·task 결과는 job type으로 빠진다. 현재 입력보다 먼저 게시된 페이지만 넣고, 빠진 페이지가 있으면 일부로 표시한다.
async function botAnswers(db: Database, conversation: string, before: string, limit: number): Promise<BotAnswer[]> {
  // AND의 평가 순서는 보장되지 않는다. 숫자가 아닌 외부 ID에 캐스트가 먼저 돌지 않게 CASE 안에서만 바꾼다.
  const rows = (await db.query<{ message_key: string; page_index: number; state: string; external_id: string | null; content: string }>(`
    WITH sent AS (SELECT o.message_key,CASE WHEN o.external_id ~ '^[0-9]{1,20}$' THEN o.external_id::numeric END AS posted
      FROM outbox o JOIN jobs j ON j.id=o.job_id JOIN conversations c ON c.id=j.conversation_id
      WHERE j.conversation_id=$1 AND o.conversation_id=$1 AND j.type='chat' AND o.message_key='result:' || j.id
        AND j.owner_id=c.owner_id AND o.owner_id=c.owner_id AND o.state='sent'),
    answers AS (SELECT message_key FROM sent WHERE posted<$2::numeric
      GROUP BY message_key ORDER BY min(posted) DESC LIMIT $3)
    SELECT message_key,page_index,state,external_id,payload->>'content' AS content FROM outbox
      WHERE message_key IN (SELECT message_key FROM answers) ORDER BY message_key,page_index`,
  [conversation, before, limit])).rows;
  const grouped = new Map<string, typeof rows>();
  for (const row of rows) grouped.set(row.message_key, [...grouped.get(row.message_key) ?? [], row]);
  const result: BotAnswer[] = [];
  for (const pages of grouped.values()) {
    const shown = pages.filter(page => page.state === 'sent' && snowflake(page.external_id) && BigInt(page.external_id!) < BigInt(before));
    if (!shown.length) continue;
    result.push({ position: shown.reduce((min, page) => BigInt(page.external_id!) < min ? BigInt(page.external_id!) : min, BigInt(shown[0]!.external_id!)),
      pages: shown.map(page => page.content), partial: shown.length !== pages.length });
  }
  return result.sort((a, b) => a.position < b.position ? -1 : a.position > b.position ? 1 : 0);
}

// 현재 owner 메시지는 크기와 관계없이 항상 마지막에 넣는다. 다음 자리는 가장 최근 봇 답, 나머지는 최신부터 채우고
// 처음으로 넘치는 항목에서 멈춘다(오래된 기록 사이에 구멍을 내지 않는다). 넘치는 봇 답은 앞 페이지만 일부로 넣는다.
function select(timeline: Entry[], limits: { messages: number; bytes: number }): ContextItem[] {
  const chosen = new Map<number, ContextItem>();
  let used = 2; // 배열 괄호
  const cost = (item: ContextItem) => bytes(item) + (chosen.size ? 1 : 0);
  const room = (item: ContextItem) => chosen.size < limits.messages && used + cost(item) <= limits.bytes;
  const add = (index: number, item: ContextItem) => { used += cost(item); chosen.set(index, item); };
  // 들어가면 true. 봇 답은 통째로 안 들어가면 앞 페이지부터 들어가는 만큼만 넣는다.
  const fit = (index: number): boolean => {
    const entry = timeline[index]!;
    if (entry.from === 'owner') { if (!room(entry.item)) return false; add(index, entry.item); return true; }
    for (let count = entry.answer.pages.length; count > 0; count--) {
      const partial = entry.answer.partial || count < entry.answer.pages.length;
      const item: ContextItem = { from: 'bot', text: entry.answer.pages.slice(0, count).join(''), ...(partial ? { partial: true as const } : {}) };
      if (room(item)) { add(index, item); return count === entry.answer.pages.length; }
    }
    return false;
  };
  const last = timeline.length - 1;
  const pinned = last >= 0 && timeline[last]!.from === 'owner' && timeline[last]!.current ? last : -1;
  if (pinned >= 0) add(pinned, (timeline[pinned] as { item: ContextItem }).item);
  const latestBot = timeline.findLastIndex(entry => entry.from === 'bot');
  if (latestBot >= 0) fit(latestBot);
  for (let index = last; index >= 0; index--) {
    if (chosen.has(index)) continue;
    if (!fit(index)) break;
  }
  return [...chosen.entries()].sort(([a], [b]) => a - b).map(([, item]) => item);
}
