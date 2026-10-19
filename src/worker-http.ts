import { createServer } from 'node:http';
import { z } from 'zod';
import { Agent } from 'undici';
import { AnswerSchema, WorkerRejected } from './contracts.js';
import { body } from './http.js';
import type { WorkerClient, WorkerRequest, WorkerResult } from './worker.js';
import { WorkerRequestSchema } from './worker.js';

const ResultSchema = z.discriminatedUnion('status', [
  z.strictObject({ status: z.literal('succeeded'), stopped: z.literal(true), answer: AnswerSchema }),
  z.strictObject({ status: z.enum(['limited', 'auth_expired', 'failed']), stopped: z.literal(true) }),
  z.strictObject({ status: z.literal('unknown'), stopped: z.literal(false) }),
]);
const connectionFailures = new Set(['ECONNREFUSED', 'ENOTFOUND', 'EAI_AGAIN', 'UND_ERR_CONNECT_TIMEOUT']);
function beforeConnection(error: unknown): boolean {
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
  async execute(request: WorkerRequest, capability: string, signal: AbortSignal): Promise<WorkerResult> {
    const dispatcher = this.transport({ headersTimeout: request.timeoutMs + 30_000, bodyTimeout: request.timeoutMs + 30_000 });
    try {
      const options = { method: 'POST', redirect: 'error' as const,
        headers: { 'content-type': 'application/json', authorization: `Capability ${capability}` },
        body: JSON.stringify(request), signal, dispatcher };
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
      const result = ResultSchema.safeParse(raw);
      if (result.success) return result.data;
      if (z.object({ stopped: z.literal(true) }).safeParse(raw).success) return { status: 'failed', stopped: true };
      throw new Error('worker_response_uncertain');
    } finally { await dispatcher.destroy(); }
  }
  async cancel(job: string, capability: string): Promise<{ stopped: boolean }> {
    const response = await this.send(`${this.origin}/v1/cancel`, { method: 'POST', redirect: 'error',
      headers: { 'content-type': 'application/json', authorization: `Capability ${capability}` },
      body: JSON.stringify({ job }), signal: AbortSignal.timeout(5000) });
    if (!response.ok) return { stopped: false };
    return z.strictObject({ stopped: z.boolean() }).parse(await response.json());
  }
}
export function workerServer(worker: WorkerClient) {
  const server = createServer(async (req, res) => {
    if (req.method !== 'POST' || !['/v1/execute', '/v1/cancel'].includes(req.url ?? '')) { res.writeHead(404).end(); return; }
    const auth = req.headers.authorization;
    if (!auth?.startsWith('Capability ')) {
      res.writeHead(401, { 'content-type': 'application/json' }).end(JSON.stringify({ status: 'rejected', started: false })); return;
    }
    let started = false;
    try {
      const input = await body(req);
      const validated = req.url === '/v1/execute' ? WorkerRequestSchema.parse(input) : z.strictObject({ job: z.string().uuid() }).parse(input);
      started = true;
      const result = req.url === '/v1/execute'
        ? await worker.execute(validated as WorkerRequest, auth.slice(11), new AbortController().signal)
        : await worker.cancel(validated.job, auth.slice(11));
      res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(result));
    } catch (error) {
      const rejected = !started || error instanceof WorkerRejected;
      res.writeHead(rejected ? 403 : 500, { 'content-type': 'application/json' })
        .end(JSON.stringify(rejected ? { status: 'rejected', started: false } : { status: 'unknown', stopped: false }));
    }
  });
  server.requestTimeout = 5000;
  return server;
}
