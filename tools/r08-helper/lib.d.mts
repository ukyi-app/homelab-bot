// 시험이 lib.mjs를 타입 검사 아래에서 쓰기 위한 선언이다. 사람 기기에는 없어도 된다.
export interface HelperConnection {
  connection_id: string; key_id: string; external_task_id: string; executor: 'claude' | 'codex';
  key_ref: string; summary_consent?: boolean;
}
export interface HelperConfig { version: 1; endpoint: string; environment: string; connections: HelperConnection[] }
export interface QueueRow {
  connection_id: string; event_id: string; occurred_at: number; body: string; enqueued_at: number;
  attempts: number; next_at: number; path: string; size: number;
}
export interface QueueLimits { events: number; bytes: number; ttlMs: number }
export interface SendLimits { connectMs: number; totalMs: number; backoffBaseMs: number; backoffMaxMs: number; retryAfterMaxMs: number }
export interface PostResponse { status: number; code?: string | undefined; retryAfterMs: number }
export interface Turn { sessionId: string; turnId: string | undefined; message: string | undefined }
export interface QueueStatus { queued: number; bytes: number; oldest_age_seconds: number | null; failures: Record<string, number>; last_failure_at: number | null }
export const FIXED_SUMMARY: string;
export const EVENT_PATH: string;
export const QUEUE_LIMITS: QueueLimits;
export const SEND_LIMITS: SendLimits;
export function helperPaths(env?: Record<string, string | undefined>): { config: string; state: string };
export function parseConfig(text: string): HelperConfig;
export function loadConfig(path: string): Promise<HelperConfig>;
export function suspectSummary(text: string): boolean;
export function sanitizeSummary(text: unknown): string | undefined;
export function eventBody(input: { connection: HelperConnection; eventId: string; occurredAt: number; summary: string }): string;
export function parseClaudeStop(text: string): Turn | null | undefined;
export function parseCodexNotify(text: string): Turn | null | undefined;
export class Queue {
  constructor(dir: string, options?: { now?: () => number; limits?: QueueLimits });
  dir: string; events: string; failures: string;
  ready(): Promise<void>;
  fail(reason: string, eventId?: string): Promise<void>;
  enqueue(input: { connection_id: string; event_id: string; occurred_at: number; body: string }): Promise<'queued' | 'queue_full' | 'failed'>;
  entries(): Promise<QueueRow[]>;
  due(): Promise<QueueRow[]>;
  status(): Promise<QueueStatus>;
  state(): Promise<{ not_before: number }>;
}
export function enqueueTurn(turn: Turn, options: { executor: 'claude' | 'codex'; config: HelperConfig; queue: Queue; now?: () => number }): Promise<string[]>;
export function runHook(options: { executor: 'claude' | 'codex'; input: string | undefined; parse: (text: string) => Turn | null | undefined; env?: Record<string, string | undefined>; now?: () => number }): Promise<string[]>;
export function readLimited(stream: NodeJS.ReadableStream, limit?: number, timeoutMs?: number): Promise<string | undefined>;
export function readSecretRef(ref: string, run?: (file: string, args: string[]) => Promise<string>): Promise<string>;
export function signatureInput(input: { environment: string; connectionId: string; keyId: string; sentAt: string; body: string }): Buffer;
export function signedHeaders(input: { seed: string; environment: string; connectionId: string; keyId: string; sentAt: string; body: string }): Record<string, string>;
export function postEvent(endpoint: string, headers: Record<string, string>, body: string, limits?: SendLimits): Promise<PostResponse>;
export function backoffMs(attempts: number, random?: () => number, limits?: SendLimits): number;
export function sendDue(options: {
  config: HelperConfig; queue: Queue; now?: () => number;
  post?: (endpoint: string, headers: Record<string, string>, body: string) => Promise<PostResponse>;
  readSecret?: (ref: string) => Promise<string>; random?: () => number; log?: (code: string) => void;
}): Promise<{ sent: number; retried: number; failed: number }>;
