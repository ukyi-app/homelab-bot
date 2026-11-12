import { createServer } from 'node:http';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { Agent } from 'undici';
import { z } from 'zod';
import { body } from './http.js';
import { TaskWorkerBusy, TaskWorkerRejected } from './task-bridge.js';
import type { TaskEndpointRequest, TaskEndpointResponse, TaskWorkerPort } from './task-bridge.js';
import { ARTIFACT_LIMITS } from './change-contracts.js';
import { VERIFIER_REVISION } from './change-verifier.js';
import { TASK_ENDPOINTS, TASK_INSTRUCTIONS_REVISION, TASK_INSTRUCTIONS_REVISIONS, TASK_LIMITS, TASK_V2_CONTRACT, TASK_V2_ENDPOINTS, TaskRejectionSchema } from './task-contracts.js';
import type { TaskEndpoint, TaskInstructionsRevision, TaskRequest, TaskSignedBody, TaskV2Endpoint, TaskWorkerSigner } from './task-contracts.js';
import { TaskRouteError } from './task-worker.js';
import type { TaskWorkerService } from './task-worker.js';
import { beforeConnection } from './worker-http.js';
import type { WorkerRoute } from './worker-http.js';

// 작업 레인의 작업자 HTTP. 기존 /v1/execute·/v1/cancel·/v1/review*와 같은 포트를 쓰지만 작업 모드 작업자에는 이 경로만 있다.

export const TASK_INTAKE_PATH = '/v1/task/intake';
// 제어 호출 상한. 작업자 취소 대기(4초)와 정리보다 길고, 게시 서버 드레인(10초)과 합쳐 전체 종료 기한(20초) 안이다.
const CONTROL_TIMEOUT_MS = 8000;

// 무모델·무서명 상태 응답. 값 없는 사유 상수와 능력표뿐이다. 게시 서버가 이 경로로 "작업 모드 작업자인가"와 "수락 중인가"를 본다.
// 옛 이미지와 대화·리뷰 작업자는 404라, 거기에 실행을 보내 응답 불명으로 레인을 닫는 일을 미리 막는다.
export const TaskIntakeSchema = z.object({ version: z.literal(1), open: z.boolean(), reasons: z.array(z.string().max(64)).max(32),
  capabilities: z.object({ lanes: z.object({ task: z.literal(true) }) }).loose(),
  // v2 계약을 받는 작업자에만 있다. instructions는 v2 요청에 받는 지시문 판 목록이고, 칸이 없는 옛 작업자는 옛 판(TASK_INSTRUCTIONS_REVISION)만 받는다.
  // z.object라 이 칸을 모르는 옛 게시 서버도 칸을 버리고 받는다.
  change: z.object({ contract: z.number().int(), verifierRevision: z.string().max(128), instructions: z.array(z.string().max(64)).max(16).optional() }).optional(),
  // 방식 선택(execution 칸)을 받는 끝점. 계정 묶음을 읽는 작업자에만 있고, 칸이 없으면 어느 끝점도 받지 않는다(DECISIONS "C39").
  executionSelection: z.array(z.string().max(64)).max(16).optional() });
export const TASK_EXECUTION_SELECTION_ENDPOINTS = ['/v1/task', '/v2/task'] as const;
// 이 작업자가 방식 선택을 받는 끝점. 게시 서버는 여기 있는 끝점에만 execution 칸을 싣는다. 확인하지 못하면 빈 목록이다(C40이 쓴다).
export async function taskWorkerExecutionSelection(workerUrl: string, send: typeof fetch, signal: AbortSignal): Promise<readonly string[]> {
  try {
    const response = await send(new URL(TASK_INTAKE_PATH, workerUrl).href, { method: 'GET', redirect: 'error', signal: AbortSignal.any([signal, AbortSignal.timeout(5000)]) });
    if (!response.ok) { await response.body?.cancel().catch(() => {}); return []; }
    const parsed = TaskIntakeSchema.safeParse(await response.json());
    if (!parsed.success) return [];
    const listed = parsed.data.executionSelection ?? [];
    return TASK_EXECUTION_SELECTION_ENDPOINTS.filter(path => listed.includes(path));
  } catch { return []; }
}
export type TaskIntakeStatus = { routed: boolean; open: boolean; reasons: readonly string[] };
export const TASK_INTAKE_UNREACHED: TaskIntakeStatus = Object.freeze({ routed: false, open: false, reasons: [] });
export async function taskWorkerIntake(workerUrl: string, send: typeof fetch, signal: AbortSignal): Promise<TaskIntakeStatus> {
  try {
    const response = await send(new URL(TASK_INTAKE_PATH, workerUrl).href, { method: 'GET', redirect: 'error', signal: AbortSignal.any([signal, AbortSignal.timeout(5000)]) });
    if (!response.ok) { await response.body?.cancel().catch(() => {}); return TASK_INTAKE_UNREACHED; }
    const parsed = TaskIntakeSchema.safeParse(await response.json());
    return parsed.success ? { routed: true, open: parsed.data.open, reasons: parsed.data.reasons } : TASK_INTAKE_UNREACHED;
  } catch { return TASK_INTAKE_UNREACHED; }
}

// 이 작업자가 CHANGE_PR v2 계약을 받는가. 옛 작업자는 칸이 없어 false다. CHANGE만 닫히고 /task는 그대로 돈다. 확인하지 못해도 false다.
export async function taskWorkerChangeContract(workerUrl: string, send: typeof fetch, signal: AbortSignal): Promise<boolean> {
  try {
    const response = await send(new URL(TASK_INTAKE_PATH, workerUrl).href, { method: 'GET', redirect: 'error', signal: AbortSignal.any([signal, AbortSignal.timeout(5000)]) });
    if (!response.ok) { await response.body?.cancel().catch(() => {}); return false; }
    const parsed = TaskIntakeSchema.safeParse(await response.json());
    return parsed.success && parsed.data.change?.contract === TASK_V2_CONTRACT;
  } catch { return false; }
}
// 이 작업자가 v2 요청에 받는 지시문 판. 게시 서버는 여기 있는 판만 보낸다. v2를 받지 않거나 확인하지 못하면 빈 목록이고,
// 판 목록 칸이 없는 옛 작업자는 옛 판만이다. 이 게시 서버가 모르는 판 이름은 뺀다.
export async function taskWorkerChangeInstructions(workerUrl: string, send: typeof fetch, signal: AbortSignal): Promise<readonly TaskInstructionsRevision[]> {
  try {
    const response = await send(new URL(TASK_INTAKE_PATH, workerUrl).href, { method: 'GET', redirect: 'error', signal: AbortSignal.any([signal, AbortSignal.timeout(5000)]) });
    if (!response.ok) { await response.body?.cancel().catch(() => {}); return []; }
    const parsed = TaskIntakeSchema.safeParse(await response.json());
    if (!parsed.success || parsed.data.change?.contract !== TASK_V2_CONTRACT) return [];
    const listed = parsed.data.change.instructions ?? [TASK_INSTRUCTIONS_REVISION];
    return TASK_INSTRUCTIONS_REVISIONS.filter(revision => listed.includes(revision));
  } catch { return []; }
}

// 응답 본문을 상한까지만 읽는다. 잘라서 쓰지 않고 넘으면 실패다. 읽은 바이트 수는 저장 상한 대조에 그대로 쓴다.
async function boundedJson(response: Response, maxBytes: number): Promise<{ response: unknown; bytes: number }> {
  const reader = response.body?.getReader();
  const chunks: Uint8Array[] = [];
  let bytes = 0;
  while (reader) {
    const { done, value } = await reader.read();
    if (done) break;
    bytes += value.byteLength;
    if (bytes > maxBytes) { await reader.cancel().catch(() => {}); throw new Error('task_response_too_large'); }
    chunks.push(value);
  }
  return { response: JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown, bytes };
}
const TaskBusySchema = z.strictObject({ status: z.literal('busy'), started: z.literal(false) });
export type TaskV2EndpointRequest<E extends TaskV2Endpoint> = z.infer<(typeof TASK_V2_ENDPOINTS)[E]['request']>;
export type TaskV2EndpointResponse<E extends TaskV2Endpoint> = z.infer<(typeof TASK_V2_ENDPOINTS)[E]['response']>;
export interface TaskV2WorkerPort {
  // bytes는 실제로 받은 본문 크기다.
  callV2<E extends TaskV2Endpoint>(endpoint: E, input: TaskV2EndpointRequest<E>, signal?: AbortSignal): Promise<{ response: unknown; bytes: number }>;
  supportsChange(signal?: AbortSignal): Promise<boolean>;
  // 받는 지시문 판(taskWorkerChangeInstructions). 선택 메서드라 이 port를 흉내 내는 기존 구현이 그대로 맞는다. 없으면 옛 판만 보낸다.
  changeInstructions?(signal?: AbortSignal): Promise<readonly TaskInstructionsRevision[]>;
}
// v2는 긴 턴을 기다리지 않는다. 모든 호출이 제어 호출 기한 안에 끝난다. 거부 판별은 v1과 같다. 응답 검증은 호출자가 계약 schema로 한다.
export class HttpTaskV2Worker implements TaskV2WorkerPort {
  private readonly origin: string;
  constructor(endpoint: string, private readonly signer: TaskWorkerSigner, private readonly send: typeof fetch) {
    const url = new URL(endpoint);
    if (url.protocol !== 'http:' || url.username || url.password || url.pathname !== '/' || url.search || url.hash) throw new Error('invalid_worker_service');
    this.origin = url.origin;
  }
  supportsChange(signal: AbortSignal = AbortSignal.timeout(CONTROL_TIMEOUT_MS)): Promise<boolean> {
    return taskWorkerChangeContract(this.origin, this.send, signal);
  }
  changeInstructions(signal: AbortSignal = AbortSignal.timeout(CONTROL_TIMEOUT_MS)): Promise<readonly TaskInstructionsRevision[]> {
    return taskWorkerChangeInstructions(this.origin, this.send, signal);
  }
  async callV2<E extends TaskV2Endpoint>(endpoint: E, input: TaskV2EndpointRequest<E>, signal?: AbortSignal): Promise<{ response: unknown; bytes: number }> {
    const spec = TASK_V2_ENDPOINTS[endpoint];
    let payload: string;
    let token: string;
    try {
      const parsed = spec.request.parse(input) as TaskSignedBody;
      payload = JSON.stringify(parsed);
      if (Buffer.byteLength(payload) > TASK_LIMITS.bodyBytes) throw new Error('task_request_too_large');
      token = this.signer.issue(spec.operation, parsed);
    } catch { throw new TaskWorkerRejected(); }
    let response: Response;
    try {
      response = await this.send(`${this.origin}${endpoint}`, { method: 'POST', redirect: 'error',
        headers: { 'content-type': 'application/json', authorization: `Capability ${token}` }, body: payload, signal: signal ?? AbortSignal.timeout(CONTROL_TIMEOUT_MS) });
    } catch (error) {
      if (error instanceof Error && beforeConnection(error.cause)) throw new TaskWorkerRejected();
      throw error;
    }
    if (!response.ok) {
      const refused: unknown = await response.json().catch(() => null);
      if (response.status === 409 && TaskBusySchema.safeParse(refused).success) throw new TaskWorkerBusy();
      if ([400, 401, 403, 409].includes(response.status) && TaskRejectionSchema.safeParse(refused).success) throw new TaskWorkerRejected();
      throw new Error('task_worker_uncertain');
    }
    return boundedJson(response, ARTIFACT_LIMITS.httpBodyBytes);
  }
}

// 게시 서버 쪽 포트. 400·401·403·409 거부와 연결 전 실패만 미시작의 증거다(TaskWorkerRejected).
// 그 밖(503 수락 닫힘 포함, 연결 뒤 끊김·시간 초과·깨진 JSON)은 시작 여부를 모르는 것이다. 재전송하지 않는다. 브리지가 cancel·status로 확인한다.
export class HttpTaskWorker implements TaskWorkerPort {
  private readonly origin: string;
  constructor(endpoint: string, private readonly signer: TaskWorkerSigner, private readonly send: typeof fetch) {
    const url = new URL(endpoint);
    if (url.protocol !== 'http:' || url.username || url.password || url.pathname !== '/' || url.search || url.hash) throw new Error('invalid_worker_service');
    this.origin = url.origin;
  }
  async call<E extends TaskEndpoint>(endpoint: E, input: TaskEndpointRequest<E>, signal?: AbortSignal): Promise<TaskEndpointResponse<E>> {
    const spec = TASK_ENDPOINTS[endpoint];
    let payload: string;
    let token: string;
    let dispatcher: Agent | undefined;
    try {
      // 파싱이 필드 순서를 정한다. 작업자도 같은 schema로 파싱해 digest가 같아진다.
      const parsed = spec.request.parse(input) as TaskEndpointRequest<E> & { version: 1; job: string; lease: string; generation: number };
      payload = JSON.stringify(parsed);
      token = this.signer.issue(spec.operation, parsed);
      // 긴 턴이 undici 기본 300초 응답 대기에 끊기지 않게 턴 기한에 맞춘다.
      if (endpoint === '/v1/task') {
        const { timeoutMs } = parsed as unknown as TaskRequest;
        dispatcher = new Agent({ headersTimeout: timeoutMs + 30_000, bodyTimeout: timeoutMs + 30_000 });
      }
    } catch { throw new TaskWorkerRejected(); }
    try {
      let response: Response;
      try {
        response = await this.send(`${this.origin}${endpoint}`, { method: 'POST', redirect: 'error',
          headers: { 'content-type': 'application/json', authorization: `Capability ${token}` }, body: payload,
          signal: signal ?? AbortSignal.timeout(CONTROL_TIMEOUT_MS), ...(dispatcher ? { dispatcher } : {}) } as RequestInit);
      } catch (error) {
        if (error instanceof Error && beforeConnection(error.cause)) throw new TaskWorkerRejected();
        throw error;
      }
      if (!response.ok) {
        if ([400, 401, 403, 409].includes(response.status) && TaskRejectionSchema.safeParse(await response.json().catch(() => null)).success) throw new TaskWorkerRejected();
        throw new Error('task_worker_uncertain');
      }
      // 응답 검증은 브리지가 계약 schema로 한다. 깨진 응답을 응답 불명으로 다루는 것도 거기다.
      return await response.json() as TaskEndpointResponse<E>;
    } finally { await dispatcher?.destroy().catch(() => {}); }
  }
}

const REJECTED = JSON.stringify({ status: 'rejected', started: false });
const BUSY = JSON.stringify({ status: 'busy', started: false });
// 로그에는 끝점·상태·사유 상수만 남긴다. 요청 본문과 capability는 넘기지 않는다.
export function taskRoutes(service: TaskWorkerService, capabilities: object, log?: (fields: Record<string, unknown>) => void): ReadonlyMap<string, WorkerRoute> {
  const route = (endpoint: TaskEndpoint): WorkerRoute => async (req, res) => {
    const send = (status: number, payload: string) => { if (!res.headersSent) res.writeHead(status, { 'content-type': 'application/json' }).end(payload); };
    const refuse = (status: number, reason: string) => {
      log?.({ level: 'warn', event: 'task_route_rejected', endpoint, status, reason });
      send(status, REJECTED);
    };
    try {
      if (req.method !== 'POST') { res.writeHead(404).end(); return; }
      const auth = req.headers.authorization;
      if (!auth?.startsWith('Capability ')) { refuse(401, 'capability_missing'); return; }
      let input: unknown;
      try { input = await body(req, TASK_LIMITS.bodyBytes); } catch { refuse(400, 'body_invalid'); return; }
      const parsed = TASK_ENDPOINTS[endpoint].request.safeParse(input);
      if (!parsed.success) { refuse(400, 'request_invalid'); return; }
      const token = auth.slice(11);
      const result = endpoint === '/v1/task' ? await service.execute(parsed.data as never, token)
        : endpoint === '/v1/task/cancel' ? await service.cancel(parsed.data as never, token)
          : endpoint === '/v1/task/status' ? await service.status(parsed.data as never, token)
            : await service.finalize(parsed.data as never, token);
      send(200, JSON.stringify(result));
    } catch (error) {
      if (error instanceof TaskRouteError) { refuse(error.status, error.message); return; }
      log?.({ level: 'error', event: 'task_route_failed', endpoint, error: error instanceof Error ? error.name : typeof error });
      // 시작 여부를 모른다. 프로세스가 멈췄다는 증거가 아니다.
      send(500, JSON.stringify({ status: 'unknown', stopped: false }));
    }
  };
  const routeV2 = (endpoint: TaskV2Endpoint): WorkerRoute => async (req, res) => {
    const send = (status: number, payload: string) => { if (!res.headersSent) res.writeHead(status, { 'content-type': 'application/json' }).end(payload); };
    const refuse = (status: number, reason: string) => {
      log?.({ level: 'warn', event: 'task_route_rejected', endpoint, status, reason });
      send(status, REJECTED);
    };
    try {
      if (req.method !== 'POST') { res.writeHead(404).end(); return; }
      const auth = req.headers.authorization;
      if (!auth?.startsWith('Capability ')) { refuse(401, 'capability_missing'); return; }
      let input: unknown;
      try { input = await body(req, TASK_LIMITS.bodyBytes); } catch { refuse(400, 'body_invalid'); return; }
      const parsed = TASK_V2_ENDPOINTS[endpoint].request.safeParse(input);
      if (!parsed.success) { refuse(400, 'request_invalid'); return; }
      const token = auth.slice(11);
      const result = endpoint === '/v2/task' ? await service.changeExecute(parsed.data as never, token)
        : endpoint === '/v2/task/result' ? await service.changeResult(parsed.data as never, token)
          : endpoint === '/v2/task/verify' ? await service.changeVerify(parsed.data as never, token)
            : endpoint === '/v2/task/verification' ? await service.changeVerification(parsed.data as never, token)
              : await service.changeFinalize(parsed.data as never, token);
      send(200, JSON.stringify(result));
    } catch (error) {
      // 슬롯 경합은 시작하지 않았다는 사실 말고 결과가 없다. v2를 부르는 게시 서버만 이 끝점을 쓰므로 옛 게시 서버의 거부 판별과 부딪히지 않는다.
      if (error instanceof TaskRouteError && error.message === 'busy') { send(409, BUSY); return; }
      if (error instanceof TaskRouteError) { refuse(error.status, error.message); return; }
      log?.({ level: 'error', event: 'task_route_failed', endpoint, error: error instanceof Error ? error.name : typeof error });
      send(500, JSON.stringify({ status: 'unknown', stopped: false }));
    }
  };
  const intake: WorkerRoute = async (req, res) => {
    if (req.method !== 'GET') { res.writeHead(404).end(); return; }
    res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ version: 1, open: service.intake.open, reasons: service.intake.reasons, capabilities,
      ...(service.changeEnabled ? { change: { contract: TASK_V2_CONTRACT, verifierRevision: VERIFIER_REVISION, instructions: TASK_INSTRUCTIONS_REVISIONS } } : {}),
      ...(service.executionSelection ? { executionSelection: [...TASK_EXECUTION_SELECTION_ENDPOINTS].filter(path => path === '/v1/task' || service.changeEnabled) } : {}) }));
  };
  return new Map<string, WorkerRoute>([...(Object.keys(TASK_ENDPOINTS) as TaskEndpoint[]).map(endpoint => [endpoint, route(endpoint)] as const),
    ...(service.changeEnabled ? (Object.keys(TASK_V2_ENDPOINTS) as TaskV2Endpoint[]).map(endpoint => [endpoint, routeV2(endpoint)] as const) : []),
    [TASK_INTAKE_PATH, intake]]);
}

// 작업 모드 작업자의 서버. 대화·리뷰 끝점이 없어 경로 자체가 404다.
// 처리기 안의 어떤 오류도 프로세스를 끝내지 않게 여기서 받는다. /readyz는 HTTP 서버 생존과 기동 검사만 본다(task-worker.ts 가용성 규칙).
export function taskWorkerServer(service: TaskWorkerService, capabilities: object, log?: (fields: Record<string, unknown>) => void) {
  const routes = taskRoutes(service, capabilities, log);
  const server = createServer((req: IncomingMessage, res: ServerResponse) => {
    const handle = async () => {
      if (req.method === 'GET' && req.url === '/readyz') { res.writeHead(service.intake.startupClean ? 200 : 503).end(); return; }
      const route = routes.get(req.url ?? '');
      if (route) await route(req, res); else res.writeHead(404).end();
    };
    handle().catch(() => { if (!res.headersSent) res.writeHead(500).end(); else res.destroy(); });
  });
  // 요청을 받는 데만 걸리고 긴 턴의 응답 대기에는 걸리지 않는다. 상한 2MiB가 들어오기에 충분하다.
  server.requestTimeout = 5000;
  return server;
}
