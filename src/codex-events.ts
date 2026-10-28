import { z } from 'zod';

// `codex exec --json` JSONL 이벤트. 문서에 있는 최상위 형태만 판정에 쓴다.
// item 내부는 버전마다 필드가 늘 수 있어 아는 필드만 읽고 나머지는 둔다.
const ItemSchema = z.looseObject({ id: z.string(), type: z.string() });
const EventSchema = z.discriminatedUnion('type', [
  z.looseObject({ type: z.literal('thread.started'), thread_id: z.string().min(1) }),
  z.looseObject({ type: z.literal('turn.started') }),
  z.looseObject({ type: z.literal('turn.completed'), usage: z.looseObject({}).optional() }),
  z.looseObject({ type: z.literal('turn.failed'), error: z.looseObject({ message: z.string().optional() }).optional() }),
  z.looseObject({ type: z.enum(['item.started', 'item.updated', 'item.completed']), item: ItemSchema }),
  z.looseObject({ type: z.literal('error'), message: z.string().optional() }),
]);
export type CodexEvent = z.infer<typeof EventSchema>;

export interface ParsedStream { events: CodexEvent[]; malformed: number; unrecognized: number }
export function parseStream(lines: readonly string[]): ParsedStream {
  const events: CodexEvent[] = [];
  let malformed = 0;
  let unrecognized = 0;
  for (const line of lines) {
    if (!line.trim()) continue;
    let raw: unknown;
    try { raw = JSON.parse(line); } catch { malformed++; continue; }
    const parsed = EventSchema.safeParse(raw);
    if (parsed.success) events.push(parsed.data);
    // 새 버전의 이벤트 종류는 판정에 쓰지 않지만 흐름을 깨진 것으로 보지도 않는다.
    else if (typeof raw === 'object' && raw !== null && typeof (raw as { type?: unknown }).type === 'string'
      && !EventSchema.options.some(option => option.shape.type.safeParse((raw as { type: string }).type).success)) unrecognized++;
    else malformed++;
  }
  return { events, malformed, unrecognized };
}

// --output-schema로 고정한 최종 메시지. 질문·완료는 이 구조로만 인정한다.
// 로그나 agent_message의 "완료"·"질문" 문자열은 판정 근거가 아니다(`01` §6 완료 기준).
export const TaskOutputSchema = z.strictObject({
  status: z.enum(['completed', 'needs_input', 'cannot_complete']),
  summary: z.string().max(1500),
  question: z.string().max(500),
}).refine(o => (o.status === 'needs_input') === (o.question.trim().length > 0), 'question_mismatch');
export type TaskOutput = z.infer<typeof TaskOutputSchema>;
// 구조화 출력은 루트 객체·전 필드 required·추가 필드 금지여야 해서 판별 유니온 대신 평평한 모양이다.
// 길이 제한 키워드 지원 여부는 [미확인]이라 스키마에는 설명만 두고 길이는 봇이 TaskOutputSchema로 검사한다.
export const TASK_OUTPUT_JSON_SCHEMA = Object.freeze({
  type: 'object', additionalProperties: false, required: ['status', 'summary', 'question'],
  properties: {
    status: { type: 'string', enum: ['completed', 'needs_input', 'cannot_complete'] },
    summary: { type: 'string', description: '1500자 이하' },
    question: { type: 'string', description: 'needs_input일 때만 채운다(500자 이하). 그 밖에는 빈 문자열.' },
  },
});

export interface RunReport {
  lines: string[];
  exit: { code: number | null; signal: string | null } | null;
  output: string | null;
  // 작업 그룹 전체가 사라졌음을 확인했는지. null은 확인 수단 없음.
  survivors: number | null;
  aborted: boolean;
}
export type RunOutcome =
  | { kind: 'completed'; threadId: string; turns: number; summary: string; changes: string[] }
  | { kind: 'question'; threadId: string; turns: number; summary: string; question: string }
  | { kind: 'failed'; reason: string; threadId: string | null; turns: number }
  | { kind: 'unknown'; reason: string; threadId: string | null; turns: number };

// 판정 순서가 계약이다: 소멸 확인 → 흐름 무결성 → 실패 신호 → 종료 코드 → 턴 완료 → 구조화 출력.
export function interpretRun(report: RunReport, expectedThread: string | null, secrets: readonly string[] = []): RunOutcome {
  const { events, malformed } = parseStream(report.lines);
  const threads = [...new Set(events.flatMap(e => e.type === 'thread.started' ? [e.thread_id] : []))];
  const threadId = threads[0] ?? expectedThread;
  const turns = events.filter(e => e.type === 'turn.completed').length;
  // 종료 코드가 있어도 분리된 자식이 남으면 다음 작업이 인증 파일·egress에 닿을 수 있다.
  if (!report.exit || report.survivors !== 0) return { kind: 'unknown', reason: report.survivors === null ? 'stop_unverifiable' : report.exit ? 'survivors' : 'not_exited', threadId, turns };
  if (report.aborted) return { kind: 'failed', reason: 'aborted', threadId, turns };
  // `exec resume`이 thread.started를 다시 내는지는 [미확인]이라 재개 때는 없어도 받는다. 다른 스레드는 거부한다.
  if (expectedThread !== null && threads.some(t => t !== expectedThread)) return { kind: 'failed', reason: 'thread_mismatch', threadId, turns };
  if (malformed > 0 || threads.length > 1 || !threadId) return { kind: 'failed', reason: 'invalid_stream', threadId, turns };
  if (events.some(e => e.type === 'turn.failed' || e.type === 'error')) return { kind: 'failed', reason: 'turn_failed', threadId, turns };
  if (report.exit.code !== 0) return { kind: 'failed', reason: 'exit_nonzero', threadId, turns };
  const last = events.filter(e => e.type.startsWith('turn.')).at(-1);
  if (turns === 0 || last?.type !== 'turn.completed') return { kind: 'failed', reason: 'turn_incomplete', threadId, turns };
  let output: TaskOutput;
  try { output = TaskOutputSchema.parse(JSON.parse(report.output ?? '')); }
  catch { return { kind: 'failed', reason: 'invalid_output', threadId, turns }; }
  if (echoesSecret(`${output.summary}\n${output.question}`, secrets)) return { kind: 'failed', reason: 'secret_echo', threadId, turns };
  if (output.status === 'cannot_complete') return { kind: 'failed', reason: 'model_cannot_complete', threadId, turns };
  if (output.status === 'needs_input') return { kind: 'question', threadId, turns, summary: output.summary, question: output.question };
  const changes = [...new Set(events.flatMap(e => e.type === 'item.completed' && e.item.type === 'file_change'
    && Array.isArray(e.item.changes) ? (e.item.changes as { path?: unknown }[]).flatMap(c => typeof c.path === 'string' ? [c.path] : []) : []))];
  return { kind: 'completed', threadId, turns, summary: output.summary, changes };
}

// 작업자는 자기 auth.json 값을 안다. 결과·질문에 그 값의 조각이 섞이면 게시하지 않는다.
// 같은 파드의 비신뢰 코드가 파일을 읽는 것 자체는 막지 못한다(ARCHITECTURE §5.1). 게시 경로만 줄인다.
export function authSecrets(authJson: string): string[] {
  const found: string[] = [];
  const walk = (value: unknown) => {
    if (typeof value === 'string') { if (value.length >= 16) found.push(value); }
    else if (Array.isArray(value)) value.forEach(walk);
    else if (typeof value === 'object' && value !== null) Object.values(value).forEach(walk);
  };
  try { walk(JSON.parse(authJson)); } catch { return []; }
  return found;
}
export function echoesSecret(text: string, secrets: readonly string[]): boolean {
  for (const secret of secrets) {
    const width = Math.min(secret.length, 24);
    for (let start = 0; start + width <= secret.length; start += 8) if (text.includes(secret.slice(start, start + width))) return true;
    if (text.includes(secret.slice(-width))) return true;
  }
  return false;
}
