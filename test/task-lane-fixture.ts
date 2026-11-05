import { randomUUID } from 'node:crypto';
import { ClaudeTaskBridge } from '../src/claude-task-bridge.js';
import type { ClaudeTaskBridgeOptions, TaskPlan } from '../src/claude-task-bridge.js';
import type { Database } from '../src/database.js';
import { Runtime } from '../src/runtime.js';
import { TaskWorkerRejected } from '../src/task-bridge.js';
import type { TaskEndpointRequest, TaskEndpointResponse, TaskWorkerPort } from '../src/task-bridge.js';
import { TASK_ENDPOINTS } from '../src/task-contracts.js';
import type { TaskCancelResponse, TaskEndpoint, TaskFinalizeResponse, TaskRequest, TaskResponse, TaskStatusResponse, TaskWorkerIdentity } from '../src/task-contracts.js';
import { DEFAULTS } from '../src/contracts.js';
import { CodexBridge } from '../src/codex.js';
import { event, fixture, thread } from './helpers.js';

export type Fixture = Awaited<ReturnType<typeof fixture>>;
const usage = (toolCalls: number | null = 1) => ({ toolCalls, model: null });
const base = (request: TaskRequest, worker: TaskWorkerIdentity, toolCalls: number | null = 1) => ({ version: 1 as const, job: request.job, lease: request.lease,
  generation: request.generation, sessionId: request.sessionId, turn: request.turn, worker, usage: usage(toolCalls) });
export const reply = {
  completed: (summary = '끝냈습니다.') => (r: TaskRequest, w: TaskWorkerIdentity): TaskResponse => ({ ...base(r, w), status: 'completed', stopped: true, sessionRetained: true, cleanupPending: false,
    summary, changes: { total: 0, items: [] }, patch: { text: '', bytes: 0, digest: 'a'.repeat(64), truncated: false }, verification: [] }),
  question: (question = '어느 브랜치 기준으로 고칠까요?') => (r: TaskRequest, w: TaskWorkerIdentity): TaskResponse => ({ ...base(r, w), status: 'needs_input', stopped: true, sessionRetained: true, cleanupPending: false, question }),
  limited: (status: 'limited' | 'auth_expired' = 'limited', cleanupPending = false) => (r: TaskRequest, w: TaskWorkerIdentity): TaskResponse => ({ ...base(r, w), status, stopped: true, sessionRetained: true, cleanupPending }),
  failed: (reason: 'session_missing' | 'api_error' | 'cleanup_pending' = 'api_error', cleanupPending = false) => (r: TaskRequest, w: TaskWorkerIdentity): TaskResponse => ({ ...base(r, w), status: 'failed', stopped: true, sessionRetained: true, cleanupPending, reason }),
  unknown: () => (r: TaskRequest, w: TaskWorkerIdentity): TaskResponse => ({ ...base(r, w), status: 'unknown', stopped: false, sessionRetained: true, cleanupPending: false }),
};
export type Script = (request: TaskRequest, worker: TaskWorkerIdentity, signal?: AbortSignal) => unknown;
// 계약 스키마로 요청을 검사하는 가짜 작업자. 세션 상태는 게시 서버가 받은 응답에 맞춰 스스로 기억한다.
export class FakeTaskWorker implements TaskWorkerPort {
  identity: TaskWorkerIdentity = { instance: randomUUID(), storage: randomUUID() };
  scripts: Script[] = [];
  executes: TaskRequest[] = [];
  cancels: TaskEndpointRequest<'/v1/task/cancel'>[] = [];
  finalizes: TaskEndpointRequest<'/v1/task/finalize'>[] = [];
  statuses: TaskEndpointRequest<'/v1/task/status'>[] = [];
  stopped = true;
  finalizeCleans = true;
  statusFails = false;
  statusOverride: Partial<TaskStatusResponse> | undefined;
  cancelOverride: Partial<TaskCancelResponse> | undefined;
  finalizeOverride: Partial<TaskFinalizeResponse> | undefined;
  // 제어 호출이 작업자에 닿은 시점에 끼어든다. DB 트랜잭션 밖 네트워크 구간의 경합을 만든다.
  onControl: ((endpoint: TaskEndpoint) => void | Promise<void>) | undefined;
  private readonly sessions = new Map<string, 'waiting' | 'finalized'>();
  private readonly turns = new Map<string, number>();
  async call<E extends TaskEndpoint>(endpoint: E, body: TaskEndpointRequest<E>, signal?: AbortSignal): Promise<TaskEndpointResponse<E>> {
    TASK_ENDPOINTS[endpoint].request.parse(body);
    return await this.handle(endpoint, body, signal) as TaskEndpointResponse<E>;
  }
  private async handle(endpoint: TaskEndpoint, body: unknown, signal?: AbortSignal): Promise<unknown> {
    if (endpoint === '/v1/task') {
      const request = body as TaskRequest;
      this.executes.push(request);
      const script = this.scripts.shift() ?? reply.completed();
      const answer = await script(request, this.identity, signal);
      this.sessions.set(request.sessionId, 'waiting');
      this.turns.set(request.sessionId, request.turn);
      return answer;
    }
    await this.onControl?.(endpoint);
    const control = body as { job: string; lease: string; generation: number; sessionId: string };
    const shape = { version: 1 as const, job: control.job, lease: control.lease, generation: control.generation, sessionId: control.sessionId, worker: this.identity };
    if (endpoint === '/v1/task/cancel') {
      this.cancels.push(body as TaskEndpointRequest<'/v1/task/cancel'>);
      if (this.stopped) this.sessions.set(control.sessionId, 'waiting');
      return { ...shape, stopped: this.stopped, cleaned: false, cleanupPending: false, sessionRetained: true, ...this.cancelOverride };
    }
    if (endpoint === '/v1/task/status') {
      this.statuses.push(body as TaskEndpointRequest<'/v1/task/status'>);
      if (this.statusFails) throw new Error('worker_down');
      const known = this.sessions.get(control.sessionId);
      const state = known ?? 'running';
      return { ...shape, state, turn: this.turns.get(control.sessionId) ?? null, sessionExists: state === 'waiting' || state === 'running', stopped: state !== 'running', ...this.statusOverride };
    }
    this.finalizes.push(body as TaskEndpointRequest<'/v1/task/finalize'>);
    if (this.finalizeCleans) this.sessions.set(control.sessionId, 'finalized');
    return { ...shape, stopped: true, cleaned: this.finalizeCleans, cleanupPending: !this.finalizeCleans, sessionRetained: !this.finalizeCleans, ...this.finalizeOverride };
  }
}
export const rejectStart: Script = () => { throw new TaskWorkerRejected(); };
export const OTHER_STORAGE = '00000000-0000-4000-8000-00000000f00d';
// 이 저장소가 이 세대를 본 적이 없다는 응답. 다른 저장소가 답하면 옛 세션의 소멸 증명이 아니다.
export const ABSENT: Partial<TaskStatusResponse> = { state: 'absent', turn: null, sessionExists: false, stopped: true };
// 보존 세션 하나를 정리 대기(cleanup_pending)로 둔 뒤 작업자 PVC를 교체한다. 정리 전 교체를 재현한다.
export async function retainedThenStorageReplaced(local: ReturnType<typeof lane>, f: Fixture, db: Database) {
  local.worker.statusFails = true;
  const job = await task(f, db);
  await local.runtime.tickTask();
  const old = local.worker.identity;
  local.worker.statusFails = false;
  local.worker.identity = { instance: randomUUID(), storage: OTHER_STORAGE };
  local.worker.statusOverride = ABSENT;
  return { job, old };
}
export const hang: Script = (_request, _worker, signal) => new Promise((_resolve, reject) => {
  signal?.addEventListener('abort', () => reject(new Error('aborted')), { once: true });
});
// 중단 신호를 받으면 그제서야 script의 응답으로 끝나는 실행. 취소 요청과 실행 응답이 겹치는 경우를 만든다.
export const answerOnAbort = (script: Script): Script => (request, worker, signal) => new Promise(resolve => {
  signal?.addEventListener('abort', () => resolve(script(request, worker, signal)), { once: true });
});
export const PLAN: TaskPlan = { repository: 'fixture-owner/fixture-repo', base: 'b'.repeat(40),
  project: { id: 'fixture', revision: 'r1', allowedPaths: ['src'], forbiddenPaths: [], verifyCommands: [] },
  limits: { archiveBytes: 1000, files: 10, fileBytes: 100, patchBytes: 100, lineBytes: 100, outputBytes: 100, events: 10 } };

export function lane(f: Fixture, options: Partial<ClaudeTaskBridgeOptions> = {}, plan: TaskPlan = PLAN) {
  const worker = new FakeTaskWorker();
  const bridge = new ClaudeTaskBridge(f.store, f.gate, worker, { plan: async () => plan }, { monitorMs: 5, stopWaitMs: 50, ...options });
  const runtime = new Runtime(f.store, f.gate, f.worker, f.signer, f.reader, bridge, { taskLoop: true });
  return { worker, bridge, runtime };
}
export async function allRows(db: Database, table: string) { return (await db.query<Record<string, any>>(`SELECT * FROM ${table}`)).rows; }
export async function jobs(db: Database) {
  return (await db.query<Record<string, any>>('SELECT j.* FROM jobs j JOIN events e ON e.id=j.event_id ORDER BY e.event_order')).rows;
}
export async function laneRow(db: Database) {
  return (await db.query<{ closed_reason: string | null; closed_at: string | null }>("SELECT closed_reason,closed_at FROM execution_lanes WHERE lane='task'")).rows[0]!;
}
export async function task(f: Fixture, db: Database, id = 'task', text = '실패하는 시험을 고쳐줘') {
  await f.ingress.receive(event(id, { kind: 'command', command: 'task', text }));
  return (await jobs(db)).at(-1)!;
}
// 작업자 응답을 붙잡아 둔 채 lease가 끝나 다른 루프의 expire가 job을 unknown으로 바꾼 상태. deliver를 부르면 원래 응답이 도착한다.
export async function expiredWhileWaiting(f: Fixture, db: Database, script: Script) {
  const local = lane(f, { monitorMs: 3_600_000 });
  let deliver!: () => void;
  const held = new Promise<void>(resolve => { deliver = resolve; });
  local.worker.scripts.push(async (request, worker) => { await held; return script(request, worker); });
  const job = await task(f, db);
  const running = local.runtime.tickTask();
  await until(() => local.worker.executes.length === 1);
  f.advance(DEFAULTS.leaseMs + 1); f.policy.confirmedAt = f.now();
  await f.store.expire();
  return { ...local, job, running, deliver };
}
// 013 전이나 Codex 프로필 때 남은 unknown 작업. executor 기본값이 codex다.
export async function codexSession(f: Fixture, db: Database, sessionState = 'unknown', jobState = 'unknown', id = 'codex-task') {
  const job = await task(f, db, id);
  const claimed = (await f.store.claim('task'))!;
  await db.query(`INSERT INTO codex_sessions(job_id,thread_id,turn,tool_calls,host,capabilities,state,created_at,updated_at)
    VALUES ($1,'codex-thread',1,0,'worker','{}',$2,$3,$3)`, [job.id, sessionState, f.now()]);
  await db.query('UPDATE jobs SET state=$2 WHERE id=$1', [job.id, jobState]);
  return { job, claimed };
}
export function codexBridge(f: Fixture, stopped = true) {
  const confirms: string[] = [];
  const adapter = { capabilities: () => ({}), execute: async () => { throw new Error('codex_execute_not_expected'); },
    confirmStop: async (job: string) => { confirms.push(job); return { stopped }; } };
  return { bridge: new CodexBridge(f.store, f.gate, adapter as never), confirms };
}
export const answer = (bridge: ClaudeTaskBridge, question: string, text: string, eventId: string, scope = thread, actor = 'fixture-owner') =>
  bridge.answer({ question, actor, scope, text, event: eventId });
export const conversationId = (f: Fixture) => f.store.scopeId(thread);
export const control = (f: Fixture, action: string, target?: string) => f.store.control('fixture-owner', conversationId(f), action, target) as Promise<{ ok?: boolean; status?: string; paused?: boolean }>;
// 상태를 기다린다. 끝내 안 오면 시험이 멈추지 않고 실패한다.
export const until = async (condition: () => boolean | Promise<boolean>) => {
  const deadline = Date.now() + 10_000;
  while (!await condition()) {
    if (Date.now() > deadline) throw new Error('until_timeout');
    await new Promise(resolve => setImmediate(resolve));
  }
};
