import { createServer } from 'node:http';
import type { IncomingMessage } from 'node:http';
import { z } from 'zod';
import { Agent } from 'undici';
import { Denied, WorkerRejected } from './contracts.js';
import { CoverageSchema, ReviewTaskSchema } from './review-input.js';
import type { ReviewTask, ReviewWorker, ReviewWorkerResult } from './review-input.js';
import type { ReviewWorkerClient } from './review.js';
import { CancelRequestSchema } from './worker.js';
import type { CancelRequest } from './worker.js';
import type { WorkerRoute } from './worker-http.js';

// 리뷰 레인의 작업자 HTTP(작업자 포트 8080의 별도 경로). 대화 레인 worker-http.ts와 같은 규칙:
// capability 없으면 시작 전 거부, 깨진 응답은 멈춤의 증거가 아님.
// 인증 없는 POST /v1/review의 401은 게시 서버가 작업자의 리뷰 준비를 판단하는 신호다. 본문을 읽기 전에 답한다.
const ResultSchema = z.discriminatedUnion('status', [
  z.strictObject({ status: z.literal('succeeded'), stopped: z.literal(true), coverage: CoverageSchema,
    positions: z.array(z.strictObject({ path: z.string(), lines: z.array(z.number().int().positive()) })), output: z.unknown() }),
  z.strictObject({ status: z.enum(['limited', 'auth_expired', 'failed']), stopped: z.literal(true), reason: z.string().max(100).optional() }),
  z.strictObject({ status: z.literal('unknown'), stopped: z.literal(false) }),
]);
const Denial = z.strictObject({ status: z.literal('rejected'), started: z.literal(false) });
const MAX_TASK_BYTES = 2_097_152;
// 연결 자체가 안 된 실패는 요청이 작업자에 닿지 않았다는 증거다(worker-http.ts와 같은 분류).
const CONNECTION_FAILURES = new Set(['ECONNREFUSED', 'ENOTFOUND', 'EAI_AGAIN', 'UND_ERR_CONNECT_TIMEOUT']);
function beforeConnection(error: unknown): boolean {
  if (error instanceof AggregateError) return error.errors.length > 0 && error.errors.every(beforeConnection);
  return typeof error === 'object' && error !== null && 'code' in error && typeof error.code === 'string' && CONNECTION_FAILURES.has(error.code);
}
async function raw(request: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > MAX_TASK_BYTES) throw new Error('body_limit');
    chunks.push(Buffer.from(chunk));
  }
  return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}
export class HttpReviewWorker implements ReviewWorkerClient {
  private readonly origin: string;
  constructor(endpoint: string, private readonly send: typeof fetch) {
    const url = new URL(endpoint);
    if (url.protocol !== 'http:' || url.username || url.password || url.pathname !== '/' || url.search || url.hash) throw new Error('invalid_worker_service');
    this.origin = url.origin;
  }
  async review(task: ReviewTask, capability: string, signal: AbortSignal): Promise<ReviewWorkerResult> {
    const body = JSON.stringify(ReviewTaskSchema.parse(task));
    // 긴 리뷰가 undici 기본 300초 응답 대기에 끊기지 않게 작업 예산에 맞춘다(R1-06과 같은 함정).
    const dispatcher = new Agent({ headersTimeout: task.timeoutMs + 30_000, bodyTimeout: task.timeoutMs + 30_000 });
    try {
      const options = { method: 'POST', redirect: 'error' as const, signal, dispatcher,
        headers: { 'content-type': 'application/json', authorization: `Capability ${capability}` }, body };
      let response: Response;
      try { response = await this.send(`${this.origin}/v1/review`, options); }
      catch (error) {
        if (error instanceof Error && beforeConnection(error.cause)) throw new WorkerRejected('worker_unreachable');
        throw error;
      }
      if (!response.ok) {
        if ([400, 401, 403, 409].includes(response.status) && Denial.safeParse(await response.json().catch(() => null)).success) throw new WorkerRejected();
        throw new Error('worker_response_uncertain');
      }
      const result = ResultSchema.safeParse(await response.json());
      if (!result.success) throw new Error('worker_response_uncertain');
      return result.data;
    } finally { await dispatcher.destroy().catch(() => {}); }
  }
  async cancel(request: CancelRequest, capability: string): Promise<{ stopped: boolean }> {
    const response = await this.send(`${this.origin}/v1/review/cancel`, { method: 'POST', redirect: 'error', signal: AbortSignal.timeout(10_000),
      headers: { 'content-type': 'application/json', authorization: `Capability ${capability}` }, body: JSON.stringify(request) });
    if (!response.ok) return { stopped: false };
    return z.strictObject({ stopped: z.boolean() }).parse(await response.json());
  }
}
// accepting이 false면(종료 중) 새 리뷰를 시작 전에 거부한다. 취소는 계속 받는다(worker-http.ts와 같은 규칙).
export function reviewRoutes(worker: Pick<ReviewWorker, 'review' | 'cancel'>, accepting?: () => boolean): ReadonlyMap<string, WorkerRoute> {
  const route: WorkerRoute = async (req, res) => {
    if (req.method !== 'POST') { res.writeHead(404).end(); return; }
    // 종료 중의 응답은 연결을 이어 두지 않는다. keep-alive면 서버 종료가 그 연결을 기다린다.
    const send = (status: number, payload: unknown) => {
      if (accepting && !accepting()) res.shouldKeepAlive = false;
      res.writeHead(status, { 'content-type': 'application/json' }).end(JSON.stringify(payload));
    };
    const reject = (status: number) => send(status, { status: 'rejected', started: false });
    const auth = req.headers.authorization;
    if (!auth?.startsWith('Capability ')) { reject(401); return; }
    let input: unknown;
    try { input = await raw(req); } catch { reject(400); return; }
    try {
      if (req.url === '/v1/review/cancel') {
        send(200, await worker.cancel(CancelRequestSchema.parse(input), auth.slice(11))); return;
      }
      const task = ReviewTaskSchema.parse(input);
      if (accepting && !accepting()) throw new WorkerRejected('worker_closing');
      send(200, await worker.review(task, auth.slice(11), new AbortController().signal));
    } catch (error) {
      if (error instanceof WorkerRejected || error instanceof Denied || error instanceof z.ZodError) reject(403);
      else send(500, { status: 'unknown', stopped: false });
    }
  };
  return new Map([['/v1/review', route], ['/v1/review/cancel', route]]);
}
export function reviewWorkerServer(worker: Pick<ReviewWorker, 'review' | 'cancel'>) {
  const routes = reviewRoutes(worker);
  const server = createServer(async (req, res) => {
    const route = routes.get(req.url ?? '');
    if (route) await route(req, res); else res.writeHead(404).end();
  });
  server.requestTimeout = 5000;
  return server;
}
