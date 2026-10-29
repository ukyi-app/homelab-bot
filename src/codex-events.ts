import { isAbsolute, normalize, relative, sep } from 'node:path';
import { z } from 'zod';
import { bounded } from './format.js';

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
// 긴 요약·질문은 끝난 작업을 실패로 만들지 않고 게시 전에 잘라 받는다. 상한은 비정상 크기만 거른다.
export const TaskOutputSchema = z.strictObject({
  status: z.enum(['completed', 'needs_input', 'cannot_complete']),
  summary: z.string().max(20_000),
  question: z.string().max(4_000),
}).refine(o => (o.status === 'needs_input') === (o.question.trim().length > 0), 'question_mismatch');
export type TaskOutput = z.infer<typeof TaskOutputSchema>;
// 구조화 출력은 루트 객체·전 필드 required·추가 필드 금지여야 해서 판별 유니온 대신 평평한 모양이다.
// 길이 제한 키워드 지원 여부는 [미확인]이라 스키마에는 설명만 두고 길이는 봇이 자른다.
export const TASK_OUTPUT_JSON_SCHEMA = Object.freeze({
  type: 'object', additionalProperties: false, required: ['status', 'summary', 'question'],
  properties: {
    status: { type: 'string', enum: ['completed', 'needs_input', 'cannot_complete'] },
    summary: { type: 'string', description: '1500자 이하' },
    question: { type: 'string', description: 'needs_input일 때만 채운다(500자 이하). 그 밖에는 빈 문자열.' },
  },
});
// 재개 인자로 쓰므로 '-'로 시작하면 CLI가 플래그로 읽는다. 질문을 받을 때 바로 거른다.
export const THREAD_ID = /^[A-Za-z0-9][A-Za-z0-9-]{0,127}$/;
// 한도·인증 만료의 이벤트 모양은 공식 문서에 없다 [미확인]. 0.163.0 바이너리 문자열의 `usage_limit_reached`와
// 일반 표현으로 고른 [가정]이다. 잘못 고르면 다른 계정으로 넘어가지 않고 사람 확인을 기다리는 쪽(대기)으로 틀린다.
const LIMIT = /usage[_ ]limit|rate[_ ]limit|quota|too many requests|\b429\b/i;
const AUTH = /unauthori[sz]ed|\b401\b|refresh[_ ]token|token (?:has )?expired|log ?in again|re-?authenticat/i;

export interface RunReport {
  lines: string[];
  exit: { code: number | null; signal: string | null } | null;
  output: string | null;
  // 작업 그룹 전체가 사라졌음을 확인했는지. null은 확인 수단 없음.
  survivors: number | null;
  aborted: boolean;
  // 작업 공간 기준 커밋 대비 실제 변경 경로. null은 diff를 얻지 못함.
  changes: string[] | null;
  // Codex 보고 경로를 상대 경로로 맞출 작업 공간 절대 경로.
  workspace?: string;
  // 프로세스가 생기기 전 실패(인자 거부, 실행 파일 없음).
  launchFailed?: boolean;
  // 실행 중 집행한 상한(도구 호출 예산, 출력 크기)을 넘어 작업 그룹을 끝냈다.
  exceeded?: 'tool_budget_exceeded' | 'output_limit_exceeded';
  // -o 최종 메시지 파일이 읽기 상한을 넘었다. 읽지 않고 실패로 끝낸다.
  outputTooLarge?: boolean;
}
// tools: 이번 실행에서 시작한 도구 호출 수. 예산은 작업 단위로 브리지가 합산한다.
export type RunOutcome = (
  | { kind: 'completed'; threadId: string; turns: number; summary: string; changes: string[]; reported: string[]; unconfirmed: string[] }
  | { kind: 'question'; threadId: string; turns: number; summary: string; question: string }
  | { kind: 'waiting'; reason: 'model_limit' | 'auth_expired'; threadId: string | null; turns: number }
  | { kind: 'failed'; reason: string; threadId: string | null; turns: number }
  | { kind: 'unknown'; reason: string; threadId: string | null; turns: number }) & { tools?: number };

// 판정 순서가 계약이다: 소멸 확인 → 흐름 무결성 → 실패 신호 → 종료 코드 → 턴 완료 → 구조화 출력 → 실제 diff.
export function interpretRun(report: RunReport, expectedThread: string | null, secrets: readonly string[] = []): RunOutcome {
  const { events, malformed } = parseStream(report.lines);
  const threads = [...new Set(events.flatMap(e => e.type === 'thread.started' ? [e.thread_id] : []))];
  const threadId = threads[0] ?? expectedThread;
  const turns = events.filter(e => e.type === 'turn.completed').length;
  if (report.launchFailed && report.survivors === 0) return { kind: 'failed', reason: 'launch_failed', threadId: expectedThread, turns: 0 };
  // 종료 코드가 있어도 분리된 자식이 남으면 다음 작업이 인증 파일·egress에 닿을 수 있다.
  if (!report.exit || report.survivors !== 0) return { kind: 'unknown', reason: report.survivors === null ? 'stop_unverifiable' : report.exit ? 'survivors' : 'not_exited', threadId, turns };
  if (report.exceeded) return { kind: 'failed', reason: report.exceeded, threadId, turns };
  if (report.aborted) return { kind: 'failed', reason: 'aborted', threadId, turns };
  // `exec resume`이 thread.started를 다시 내는지는 [미확인]이라 재개 때는 없어도 받는다. 다른 스레드는 거부한다.
  if (expectedThread !== null && threads.some(t => t !== expectedThread)) return { kind: 'failed', reason: 'thread_mismatch', threadId, turns };
  if (malformed > 0 || threads.length > 1) return { kind: 'failed', reason: 'invalid_stream', threadId, turns };
  if (threadId && !THREAD_ID.test(threadId)) return { kind: 'failed', reason: 'invalid_thread', threadId: null, turns };
  const failures = events.flatMap(e => e.type === 'turn.failed' ? [e.error?.message ?? ''] : e.type === 'error' ? [e.message ?? ''] : []);
  const lastTurn = events.filter(e => e.type.startsWith('turn.')).at(-1);
  // 재연결 같은 일시 error 이벤트 뒤 턴이 끝나고 종료 코드 0이면 결과를 버리지 않는다 [미확인: 일시 오류도 error로 내는지, T16b].
  // 세션(thread.started)이 생기기 전 오류도 판정한다. 인증·한도는 세션 전에 날 수 있고, 버리면 대기 대신 실패가 된다(D-14 조건 2).
  if (events.some(e => e.type === 'turn.failed') || (failures.length && (report.exit.code !== 0 || lastTurn?.type !== 'turn.completed'))) {
    const text = failures.join('\n');
    if (LIMIT.test(text)) return { kind: 'waiting', reason: 'model_limit', threadId, turns };
    if (AUTH.test(text)) return { kind: 'waiting', reason: 'auth_expired', threadId, turns };
    return { kind: 'failed', reason: 'turn_failed', threadId, turns };
  }
  if (!threadId) return { kind: 'failed', reason: 'invalid_stream', threadId, turns };
  if (report.exit.code !== 0) return { kind: 'failed', reason: 'exit_nonzero', threadId, turns };
  if (turns === 0 || lastTurn?.type !== 'turn.completed') return { kind: 'failed', reason: 'turn_incomplete', threadId, turns };
  if (report.outputTooLarge) return { kind: 'failed', reason: 'output_too_large', threadId, turns };
  let output: TaskOutput;
  try { output = TaskOutputSchema.parse(JSON.parse(report.output ?? '')); }
  catch { return { kind: 'failed', reason: 'invalid_output', threadId, turns }; }
  if (echoesSecret(`${output.summary}\n${output.question}`, secrets)) return { kind: 'failed', reason: 'secret_echo', threadId, turns };
  if (output.status === 'cannot_complete') return { kind: 'failed', reason: 'model_cannot_complete', threadId, turns };
  const summary = bounded(output.summary, 1500);
  if (output.status === 'needs_input') return { kind: 'question', threadId, turns, summary, question: bounded(output.question, 500) };
  // 완료 근거의 변경 목록은 실제 작업 공간 diff다. 셸로 바꾼 파일은 Codex 보고에 없을 수 있고, 임시로 만들었다
  // 지운 파일은 보고에만 있을 수 있어 보고와 diff가 다른 것은 실패가 아니라 증거로 남긴다.
  // 작업 공간 밖을 바꿨다는 보고는 샌드박스 경계를 넘은 것이라 완료로 보지 않는다.
  if (report.changes === null) return { kind: 'failed', reason: 'diff_unavailable', threadId, turns };
  const raw = events.flatMap(e => e.type === 'item.completed' && e.item.type === 'file_change' && e.item.status !== 'failed'
    && Array.isArray(e.item.changes) ? (e.item.changes as { path?: unknown }[]).flatMap(c => typeof c.path === 'string' ? [c.path] : []) : []);
  // 한 줄 상한 안에도 경로가 수만 개 올 수 있어 중복 제거·대조는 Set으로 한다(배열 includes면 경로 수의 제곱).
  const reported = new Set<string>();
  for (const path of raw) {
    const relative = workspaceRelative(path, report.workspace);
    if (relative === null) return { kind: 'failed', reason: 'change_outside_workspace', threadId, turns };
    reported.add(relative);
  }
  const actual = new Set(report.changes);
  return { kind: 'completed', threadId, turns, summary, changes: report.changes, reported: [...reported],
    unconfirmed: [...reported].filter(path => !actual.has(path)) };
}
// Codex 보고 경로는 절대 경로일 수 있다 [미확인]. 작업 공간 기준 상대 경로로 맞추고 밖이면 null.
function workspaceRelative(path: string, workspace?: string): string | null {
  const rel = isAbsolute(path) ? (workspace ? relative(workspace, path) : '..') : normalize(path);
  return !rel || rel.startsWith('..') || isAbsolute(rel) ? null : rel.split(sep).join('/');
}

// 작업자는 자기 auth.json 값을 안다. 결과·질문에 그 값의 조각이 섞이면 게시하지 않는다.
// best-effort다: base64 같은 변형은 못 잡고, 같은 파드의 비신뢰 코드가 파일을 읽는 것 자체도 막지 못한다(ARCHITECTURE §5.1).
// SEC-02 pass의 근거로 쓰지 않는다.
export function authSecrets(authJson: string): string[] {
  const found: string[] = [];
  const walk = (value: unknown) => {
    if (typeof value === 'string') {
      const parts = value.split('.');
      // JWT 헤더와 payload 앞부분은 같은 발급자 토큰끼리 같아 정상 인용을 오탐한다. 뒷부분과 서명만 본다.
      if (parts.length === 3 && parts.every(part => /^[A-Za-z0-9_-]+$/.test(part))) found.push(parts[1]!.slice(48), parts[2]!);
      else found.push(value);
    }
    else if (Array.isArray(value)) value.forEach(walk);
    else if (typeof value === 'object' && value !== null) Object.values(value).forEach(walk);
  };
  try { walk(JSON.parse(authJson)); } catch { return []; }
  return found.map(squash).filter(value => value.length >= 16);
}
// 띄어 쓰거나 기호를 끼워 넣은 반사도 잡도록 영숫자만 남겨 비교한다.
const squash = (value: string) => value.replace(/[^A-Za-z0-9]/g, '');
export function echoesSecret(text: string, secrets: readonly string[]): boolean {
  const haystack = squash(text);
  for (const secret of secrets.map(squash)) {
    for (let start = 0; start + 16 <= secret.length; start += 4) if (haystack.includes(secret.slice(start, start + 16))) return true;
  }
  return false;
}

// 판정에 쓰는 필드만 남기고 명령 출력·메시지 본문(agent_message 등)은 버린다(rev r1 S3).
// 남긴 필드는 자르지 않는다. 자른 뒤 판정하면 긴 오류 뒤쪽의 인증·한도 표식, 500번째 뒤의 작업 공간 밖 경로,
// 4096자 뒤의 상위 이동이 사라진다(rev r2 N1·N2). 남긴 크기는 launcher의 줄·전체 바이트 상한이 묶는다.
export const TOOL_ITEMS = new Set(['command_execution', 'mcp_tool_call', 'web_search', 'file_change']);
export function compactEvent(line: string): { line: string; tool: string | null } {
  let raw: unknown;
  try { raw = JSON.parse(line); } catch { return { line: '<malformed>', tool: null }; }
  if (typeof raw !== 'object' || raw === null) return { line: '<malformed>', tool: null };
  const event = raw as Record<string, unknown>;
  const item = typeof event.item === 'object' && event.item !== null ? event.item as Record<string, unknown> : undefined;
  const error = typeof event.error === 'object' && event.error !== null ? event.error as Record<string, unknown> : undefined;
  const compact = {
    type: event.type, thread_id: event.thread_id, message: event.message,
    error: error ? { message: error.message } : undefined,
    item: item ? { id: item.id, type: item.type, status: item.status,
      changes: Array.isArray(item.changes) ? item.changes.map(change =>
        ({ path: (change as { path?: unknown } | null)?.path })) : undefined } : undefined,
  };
  const tool = typeof event.type === 'string' && event.type.startsWith('item.') && item && typeof item.id === 'string'
    && typeof item.type === 'string' && TOOL_ITEMS.has(item.type) ? item.id : null;
  return { line: JSON.stringify(compact), tool };
}
