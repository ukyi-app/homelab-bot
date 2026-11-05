import { randomUUID } from 'node:crypto';
import { gzipSync } from 'node:zlib';
import { TASK_INSTRUCTIONS_REVISION, TASK_LIMITS } from '../src/task-contracts.js';
import type { TaskRequest } from '../src/task-contracts.js';

// 작업 레인 시험 공용. 압축본은 일부러 잘못된 꼴도 만들어야 해서 tar 라이브러리 없이 바이트로 짠다.
export interface TarItem {
  name: string;
  // 0 일반, 5 디렉터리, 2 심링크, 1 하드링크, 3 문자 장치, 4 블록 장치, 6 FIFO, g·x pax 헤더.
  type?: string;
  data?: Buffer | string;
  mode?: number;
  link?: string;
  badChecksum?: boolean;
}
const octal = (value: number, width: number) => `${value.toString(8).padStart(width - 1, '0')}\0`;
function header(item: TarItem, size: number): Buffer {
  const block = Buffer.alloc(512);
  block.write(item.name.slice(0, 100), 0, 'utf8');
  block.write(octal(item.mode ?? 0o644, 8), 100, 'latin1');
  block.write(octal(0, 8), 108, 'latin1');
  block.write(octal(0, 8), 116, 'latin1');
  block.write(octal(size, 12), 124, 'latin1');
  block.write(octal(0, 12), 136, 'latin1');
  block.write('        ', 148, 'latin1');
  block.write(item.type ?? '0', 156, 'latin1');
  if (item.link) block.write(item.link.slice(0, 100), 157, 'utf8');
  block.write('ustar\0', 257, 'latin1');
  block.write('00', 263, 'latin1');
  let sum = 0;
  for (const byte of block) sum += byte;
  if (item.badChecksum) sum += 1;
  block.write(`${sum.toString(8).padStart(6, '0')}\0 `, 148, 'latin1');
  return block;
}
// "<전체 길이> <키>=<값>\n". 길이는 자기 자릿수까지 포함한다.
export function paxRecord(key: string, value: string): string {
  const body = ` ${key}=${value}\n`;
  let length = Buffer.byteLength(body);
  while (String(length).length + Buffer.byteLength(body) !== length) length = String(length).length + Buffer.byteLength(body);
  return `${length}${body}`;
}
export function tarBytes(items: readonly TarItem[], options: { end?: boolean } = {}): Buffer {
  const parts: Buffer[] = [];
  for (const item of items) {
    const data = Buffer.from(item.data ?? '');
    parts.push(header(item, data.length), data, Buffer.alloc((512 - data.length % 512) % 512));
  }
  if (options.end !== false) parts.push(Buffer.alloc(1024));
  return Buffer.concat(parts);
}
export const tarGz = (items: readonly TarItem[], options?: { end?: boolean }) => gzipSync(tarBytes(items, options));

export const SHA = 'a'.repeat(40);
export const ROOT = `repo-${SHA}`;
// git archive 꼴: 전역 pax 헤더, 뿌리 디렉터리, 그 아래 항목.
export const archive = (items: readonly TarItem[]) => tarGz([
  { name: 'pax_global_header', type: 'g', data: paxRecord('comment', SHA), mode: 0o666 },
  { name: `${ROOT}/`, type: '5', mode: 0o775 },
  ...items.map(item => ({ ...item, name: `${ROOT}/${item.name}` })),
]);

export const LIMITS = Object.freeze({ archiveBytes: TASK_LIMITS.archiveBytes, files: 100, fileBytes: 200_000, patchBytes: TASK_LIMITS.patchBytes,
  lineBytes: TASK_LIMITS.lineBytes, outputBytes: TASK_LIMITS.outputBytes, events: TASK_LIMITS.events });
export const WORKER = Object.freeze({ instance: randomUUID(), storage: randomUUID() });
export type StartRequest = Extract<TaskRequest, { operation: 'start' }>;
export type ResumeRequest = Extract<TaskRequest, { operation: 'resume' }>;
export function startRequest(overrides: Partial<StartRequest> = {}): StartRequest {
  return { version: 1, lane: 'task', job: randomUUID(), lease: randomUUID(), generation: 1, policyRevision: 'policy-1',
    instructions: TASK_INSTRUCTIONS_REVISION, sessionId: randomUUID(), repository: 'fixture/repo', base: SHA,
    project: { id: 'fixture', revision: 'r1', allowedPaths: ['src', 'README.md'], forbiddenPaths: ['src/secret'], verifyCommands: ['unit'] },
    timeoutMs: 60_000, runBudgetRemainingMs: 120_000, toolCalls: 4, limits: { ...LIMITS },
    operation: 'start', turn: 1, untrusted: { request: '고쳐라' }, ...overrides };
}
export function resumeRequest(start: StartRequest, overrides: Partial<ResumeRequest> = {}): ResumeRequest {
  const { untrusted: _untrusted, operation: _operation, turn: _turn, ...shared } = start;
  return { ...shared, operation: 'resume', turn: 2, expectedWorker: { ...WORKER }, resumeReason: 'model_limit', ...overrides };
}
// 실제 고정 바이너리 2.1.308이 낸 init의 판정 필드(VERIFICATION "T18 할 일 6·작업 레인 실행 부품"). 경로만 뺐다.
export const initEvent = (sessionId: string, overrides: Record<string, unknown> = {}) => ({
  type: 'system', subtype: 'init', session_id: sessionId, tools: ['Bash', 'Edit', 'Read', 'StructuredOutput', 'Write'], mcp_servers: [],
  model: 'claude-opus-5-5', permissionMode: 'default', slash_commands: [], apiKeySource: 'none', claude_code_version: '2.1.308',
  agents: ['claude', 'Explore', 'general-purpose', 'Plan'], skills: [], plugins: [], ...overrides });
