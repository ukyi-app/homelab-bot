import { createServer } from 'node:http';
import type { IncomingMessage, Server, ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';

// SEC-02 하네스의 loopback 가짜 Messages API. 고정 CLI가 실제 도구를 실행하도록 정해 둔 순서의 tool_use만 낸다.
// 요청 본문·Authorization은 메모리에서 판정하고 어디에도 쓰지 않는다. upstream 전달·redirect·CONNECT 터널을 구현하지 않는다.
export const API_REQUEST_BYTES = 8 * 1024 * 1024;
export const TOOL_CALL_BUDGET = 64;

export interface ToolStep { tool: string; input: Record<string, unknown> }
export interface ToolOutcome { isError: boolean; text: string }
// 한 턴의 도구 순서. next가 null이면 구조화 출력으로 끝낸다. onResult는 다음 도구를 내기 전에 끝나므로 실제 효과를 바로 잴 수 있다.
export interface TurnScript {
  next(): ToolStep | null;
  onResult(outcome: ToolOutcome): Promise<void>;
  structured: Record<string, unknown>;
}
export type ApiViolation = 'oversize' | 'order' | 'budget' | 'malformed';
export interface ApiStats {
  requests: number; auxRequests: number; rejected: number; authMismatch: number; apiKeyHeaders: number; toolCalls: number;
  violations: Partial<Record<ApiViolation, number>>;
}
type Block = Record<string, unknown>;
type Pending = { id: string; judge: boolean };

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);
const textOf = (content: unknown): string => typeof content === 'string' ? content
  : Array.isArray(content) ? content.map(item => isRecord(item) && typeof item.text === 'string' ? item.text : '').join('\n') : '';

function sendStream(res: ServerResponse, id: string, model: string, blocks: readonly Block[], stop: string): void {
  res.writeHead(200, { 'content-type': 'text/event-stream' });
  const send = (type: string, data: Record<string, unknown>) => res.write(`event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`);
  send('message_start', { message: { id, type: 'message', role: 'assistant', model, content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 1, output_tokens: 1 } } });
  blocks.forEach((block, index) => {
    if (block.type === 'tool_use') {
      send('content_block_start', { index, content_block: { type: 'tool_use', id: block.id, name: block.name, input: {} } });
      send('content_block_delta', { index, delta: { type: 'input_json_delta', partial_json: JSON.stringify(block.input) } });
    } else {
      send('content_block_start', { index, content_block: { type: 'text', text: '' } });
      send('content_block_delta', { index, delta: { type: 'text_delta', text: block.text } });
    }
    send('content_block_stop', { index });
  });
  send('message_delta', { delta: { stop_reason: stop, stop_sequence: null }, usage: { output_tokens: 1 } });
  send('message_stop', {});
  res.end();
}

export class FakeMessagesApi {
  readonly stats: ApiStats = { requests: 0, auxRequests: 0, rejected: 0, authMismatch: 0, apiKeyHeaders: 0, toolCalls: 0, violations: {} };
  private readonly server: Server;
  private script: TurnScript | null = null;
  private state: 'steps' | 'structured' | 'done' = 'done';
  private pending: Pending | null = null;
  private tag = '';
  private serial = 0;
  constructor(private readonly options: { token: string; onViolation?: (violation: ApiViolation) => void; budget?: number; maxBytes?: number }) {
    this.server = createServer((req, res) => { this.handle(req, res).catch(() => { if (!res.headersSent) this.fail(res, 'malformed'); }); });
  }
  async listen(): Promise<number> {
    await new Promise<void>(ready => this.server.listen(0, '127.0.0.1', ready));
    return (this.server.address() as AddressInfo).port;
  }
  async close(): Promise<void> {
    await new Promise<void>(done => { this.server.close(() => done()); this.server.closeAllConnections(); });
  }
  get listening(): boolean { return this.server.listening; }
  startTurn(tag: string, script: TurnScript): void {
    this.tag = tag; this.script = script; this.state = 'steps'; this.pending = null;
  }
  private fail(res: ServerResponse, violation: ApiViolation): void {
    this.stats.violations[violation] = (this.stats.violations[violation] ?? 0) + 1;
    this.options.onViolation?.(violation);
    if (!res.headersSent) res.writeHead(violation === 'oversize' ? 413 : 400, { 'content-type': 'application/json', connection: 'close' });
    res.end(JSON.stringify({ type: 'error', error: { type: 'invalid_request_error', message: 'sec02_harness_stop' } }));
  }
  private async body(req: IncomingMessage): Promise<Buffer | null> {
    const limit = this.options.maxBytes ?? API_REQUEST_BYTES;
    const chunks: Buffer[] = [];
    let size = 0;
    for await (const chunk of req) {
      size += (chunk as Buffer).length;
      if (size > limit) return null;
      chunks.push(chunk as Buffer);
    }
    return Buffer.concat(chunks);
  }
  private async handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    this.stats.requests++;
    const path = (req.url ?? '').split('?')[0];
    const allowed = req.method === 'POST' && (path === '/v1/messages' || path === '/v1/messages/count_tokens');
    if (!allowed) {
      this.stats.rejected++;
      req.resume();
      res.writeHead(404, { 'content-type': 'application/json' }).end(JSON.stringify({ type: 'error', error: { type: 'not_found_error', message: 'sec02' } }));
      return;
    }
    const raw = await this.body(req);
    if (!raw) { this.fail(res, 'oversize'); return; }
    if (req.headers.authorization !== `Bearer ${this.options.token}`) this.stats.authMismatch++;
    if (req.headers['x-api-key'] !== undefined) this.stats.apiKeyHeaders++;
    if (path.endsWith('/count_tokens')) { res.writeHead(200, { 'content-type': 'application/json' }).end('{"input_tokens":1}'); return; }
    let body: Record<string, unknown>;
    try { body = JSON.parse(raw.toString('utf8')) as Record<string, unknown>; }
    catch { this.fail(res, 'malformed'); return; }
    const model = typeof body.model === 'string' ? body.model : 'unknown';
    const hasWorkTools = Array.isArray(body.tools) && body.tools.some(tool => isRecord(tool) && tool.name === 'Bash');
    if (!hasWorkTools) { this.aux(res, body, model); return; }
    await this.main(res, body, model);
  }
  // CLI의 보조 요청(작업 도구가 없는 요청). 도구를 내지 않고 짧은 글만 돌려준다.
  private aux(res: ServerResponse, body: Record<string, unknown>, model: string): void {
    this.stats.auxRequests++;
    const id = `msg_sec02_aux_${++this.serial}`;
    if (body.stream === true) { sendStream(res, id, model, [{ type: 'text', text: 'x' }], 'end_turn'); return; }
    res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ id, type: 'message', role: 'assistant', model,
      content: [{ type: 'text', text: 'x' }], stop_reason: 'end_turn', stop_sequence: null, usage: { input_tokens: 1, output_tokens: 1 } }));
  }
  private async main(res: ServerResponse, body: Record<string, unknown>, model: string): Promise<void> {
    const script = this.script;
    if (!script) { this.fail(res, 'order'); return; }
    const messages = Array.isArray(body.messages) ? body.messages : [];
    // CLI가 tool_result 뒤에 system 역할 메시지(남은 토큰 안내)를 덧붙이므로 마지막 user 메시지를 본다.
    const last: unknown = messages.findLast(item => isRecord(item) && item.role === 'user');
    const content = isRecord(last) && Array.isArray(last.content) ? last.content as unknown[] : [];
    const results = content.filter((item): item is Block => isRecord(item) && item.type === 'tool_result');
    if (this.pending) {
      const pending = this.pending;
      const result = results.find(item => item.tool_use_id === pending.id);
      if (!result) { this.fail(res, 'order'); return; }
      this.pending = null;
      if (pending.judge) await script.onResult({ isError: result.is_error === true, text: textOf(result.content) });
    } else if (results.length) { this.fail(res, 'order'); return; }
    const id = `msg_sec02_${this.tag}_${++this.serial}`;
    if (this.state === 'steps') {
      const step = script.next();
      if (step) { this.tool(res, id, model, step, true); return; }
      this.state = 'structured';
    }
    if (this.state === 'structured') {
      this.state = 'done';
      this.tool(res, id, model, { tool: 'StructuredOutput', input: script.structured }, false);
      return;
    }
    sendStream(res, id, model, [{ type: 'text', text: 'done' }], 'end_turn');
  }
  private tool(res: ServerResponse, id: string, model: string, step: ToolStep, judge: boolean): void {
    if (this.stats.toolCalls >= (this.options.budget ?? TOOL_CALL_BUDGET)) { this.fail(res, 'budget'); return; }
    this.stats.toolCalls++;
    const toolId = `toolu_sec02_${this.tag}_${this.serial}`;
    this.pending = { id: toolId, judge };
    sendStream(res, id, model, [{ type: 'tool_use', id: toolId, name: step.tool, input: step.input }], 'tool_use');
  }
}

// HTTPS_PROXY 종단. 어떤 요청도 전달하지 않고 거부한다. 목적지는 loopback 여부만 세고 기록하지 않는다.
export class RefusingProxy {
  readonly stats = { refused: 0, nonLoopback: 0 };
  private readonly server: Server;
  constructor() {
    this.server = createServer((req, res) => {
      this.note(req.headers.host ?? '');
      req.resume();
      res.writeHead(403, { connection: 'close' }).end();
    });
    this.server.on('connect', (req, socket) => {
      this.note(req.url ?? '');
      socket.on('error', () => {});
      socket.end('HTTP/1.1 403 Forbidden\r\n\r\n');
    });
  }
  private note(target: string): void {
    this.stats.refused++;
    if (!/^(127\.0\.0\.1|localhost|\[::1\])(:\d+)?$/.test(target)) this.stats.nonLoopback++;
  }
  async listen(): Promise<number> {
    await new Promise<void>(ready => this.server.listen(0, '127.0.0.1', ready));
    return (this.server.address() as AddressInfo).port;
  }
  async close(): Promise<void> {
    await new Promise<void>(done => { this.server.close(() => done()); this.server.closeAllConnections(); });
  }
  get listening(): boolean { return this.server.listening; }
}
