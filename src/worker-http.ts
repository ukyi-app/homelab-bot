import { createServer } from 'node:http';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { z } from 'zod';
import { Agent } from 'undici';
import { AnswerSchema, ChatReplySchema, RateLimitSlotSchema, WORKER_ACCEPT, WorkerRejected } from './contracts.js';
import { body } from './http.js';
import type { CancelRequest, VersionedWorker, WorkerClient, WorkerRequest, WorkerRequestV1, WorkerRequestV2, WorkerResult,
  WorkerResultV2 } from './worker.js';
import { CancelRequestSchema, WorkerRequestSchema } from './worker.js';

// 게시 서버가 읽는 작업자 응답. 보낸 요청의 판으로 고른다: v1 요청에 v2 모양이 오거나 그 반대면 성공으로 읽지 않는다.
const ResultSchema = z.discriminatedUnion('status', [
  z.strictObject({ status: z.literal('succeeded'), stopped: z.literal(true), answer: AnswerSchema }),
  z.strictObject({ status: z.enum(['limited', 'auth_expired', 'failed']), stopped: z.literal(true) }),
  z.strictObject({ status: z.literal('unknown'), stopped: z.literal(false) }),
]);
const ResultV2Schema = z.discriminatedUnion('status', [
  z.strictObject({ status: z.literal('succeeded'), stopped: z.literal(true), output: ChatReplySchema, rateLimit: RateLimitSlotSchema }),
  z.strictObject({ status: z.enum(['limited', 'auth_expired', 'failed']), stopped: z.literal(true), rateLimit: RateLimitSlotSchema }),
  z.strictObject({ status: z.literal('unknown'), stopped: z.literal(false) }),
]);
const connectionFailures = new Set(['ECONNREFUSED', 'ENOTFOUND', 'EAI_AGAIN', 'UND_ERR_CONNECT_TIMEOUT']);
export function beforeConnection(error: unknown): boolean {
  if (error instanceof AggregateError) return error.errors.length > 0 && error.errors.every(beforeConnection);
  return typeof error === 'object' && error !== null && 'code' in error
    && typeof error.code === 'string' && connectionFailures.has(error.code);
}
export class HttpWorker implements WorkerClient {
  private readonly origin: string;
  constructor(endpoint: string, private readonly send: typeof fetch,
    private readonly transport = (options: { headersTimeout: number; bodyTimeout: number }) => new Agent(options)) {
    const url = new URL(endpoint);
    if (url.protocol !== 'http:' || url.username || url.password || url.pathname !== '/' || url.search || url.hash) throw new Error('invalid_worker_service');
    this.origin = url.origin;
  }
  execute(request: WorkerRequestV1, capability: string, signal: AbortSignal): Promise<WorkerResult>;
  execute(request: WorkerRequestV2, capability: string, signal: AbortSignal): Promise<WorkerResultV2>;
  execute(request: WorkerRequest, capability: string, signal: AbortSignal): Promise<WorkerResult | WorkerResultV2>;
  async execute(request: WorkerRequest, capability: string, signal: AbortSignal): Promise<WorkerResult | WorkerResultV2> {
    let dispatcher: Agent;
    let payload: string;
    try {
      payload = JSON.stringify(WorkerRequestSchema.parse(request));
      dispatcher = this.transport({ headersTimeout: request.timeoutMs + 30_000, bodyTimeout: request.timeoutMs + 30_000 });
    } catch { throw new WorkerRejected('worker_transport_setup'); }
    try {
      const options = { method: 'POST', redirect: 'error' as const,
        headers: { 'content-type': 'application/json', authorization: `Capability ${capability}` },
        body: payload, signal, dispatcher };
      let response: Response;
      try { response = await this.send(`${this.origin}/v1/execute`, options); }
      catch (error) {
        if (error instanceof Error && beforeConnection(error.cause)) throw new WorkerRejected('worker_unreachable');
        throw error;
      }
      if (!response.ok) {
        const denial = z.strictObject({ status: z.literal('rejected'), started: z.literal(false) });
        if ([400, 401, 403, 409].includes(response.status) && denial.safeParse(await response.json()).success) throw new WorkerRejected();
        throw new Error('worker_response_uncertain');
      }
      const raw: unknown = await response.json();
      const result = (request.version === 2 ? ResultV2Schema : ResultSchema).safeParse(raw);
      if (result.success) return result.data;
      if (z.object({ stopped: z.literal(true) }).safeParse(raw).success) {
        return request.version === 2 ? { status: 'failed', stopped: true, rateLimit: null } : { status: 'failed', stopped: true };
      }
      throw new Error('worker_response_uncertain');
    } finally { await dispatcher.destroy().catch(() => {}); }
  }
  async cancel(request: CancelRequest, capability: string): Promise<{ stopped: boolean }> {
    const response = await this.send(`${this.origin}/v1/cancel`, { method: 'POST', redirect: 'error',
      headers: { 'content-type': 'application/json', authorization: `Capability ${capability}` },
      body: JSON.stringify(request), signal: AbortSignal.timeout(5000) });
    if (!response.ok) return { stopped: false };
    return z.strictObject({ stopped: z.boolean() }).parse(await response.json());
  }
}
// ready를 넘기면 GET /readyz를 연다(kubelet readiness, 인증 없음. 응답에 상태 본문을 싣지 않는다).
// accepting이 false를 돌려주면(종료 중) 새 실행 요청을 실행 전에 거부한다(403, started:false). 취소는 계속 받는다.
// routes는 같은 포트에 얹는 다른 레인의 경로다(리뷰). 없는 경로는 404라, 레인을 닫으면 경로 자체가 없다.
export type WorkerRoute = (req: IncomingMessage, res: ServerResponse) => Promise<void>;
export function workerServer(worker: VersionedWorker, ready?: () => Promise<boolean>, accepting?: () => boolean,
  routes?: ReadonlyMap<string, WorkerRoute>) {
  const server = createServer(async (req, res) => {
    if (ready && req.method === 'GET' && req.url === '/readyz') {
      const ok = await ready().catch(() => false);
      res.writeHead(ok ? 200 : 503).end(); return;
    }
    const route = routes?.get(req.url ?? '');
    if (route) { await route(req, res); return; }
    if (req.method !== 'POST' || !['/v1/execute', '/v1/cancel'].includes(req.url ?? '')) { res.writeHead(404).end(); return; }
    const auth = req.headers.authorization;
    if (!auth?.startsWith('Capability ')) {
      res.writeHead(401, { 'content-type': 'application/json' }).end(JSON.stringify({ status: 'rejected', started: false })); return;
    }
    let started = false;
    // 종료 중의 응답은 연결을 이어 두지 않는다. keep-alive면 서버 종료가 그 연결을 기다린다.
    const closing = () => { if (accepting && !accepting()) res.shouldKeepAlive = false; };
    try {
      // 실행 요청만 v2 기록(80KiB)이 들어가게 넓힌다. 취소 등 다른 경로는 기본 상한 그대로다.
      const input = req.url === '/v1/execute' ? await body(req, WORKER_ACCEPT.executeBodyBytes) : await body(req);
      const validated = req.url === '/v1/execute' ? WorkerRequestSchema.parse(input) : CancelRequestSchema.parse(input);
      if (req.url === '/v1/execute' && accepting && !accepting()) throw new WorkerRejected('worker_closing');
      started = true;
      const result = req.url === '/v1/execute'
        ? await worker.execute(validated as WorkerRequest, auth.slice(11), new AbortController().signal)
        : await worker.cancel(validated, auth.slice(11));
      closing();
      res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(result));
    } catch (error) {
      closing();
      const rejected = !started || error instanceof WorkerRejected;
      res.writeHead(rejected ? 403 : 500, { 'content-type': 'application/json' })
        .end(JSON.stringify(rejected ? { status: 'rejected', started: false } : { status: 'unknown', stopped: false }));
    }
  });
  server.requestTimeout = 5000;
  return server;
}
