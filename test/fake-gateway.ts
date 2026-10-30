import { createHash } from 'node:crypto';
import { createServer } from 'node:http';
import type { Server } from 'node:http';
import type { Socket } from 'node:net';
import { once } from 'node:events';
import type { AddressInfo } from 'node:net';

// 시험용 가짜 Discord Gateway. loopback HTTP upgrade 위의 RFC 6455 최소 구현(텍스트·close·ping 프레임)이다.
// 실제 Node 24 WebSocket 클라이언트가 이 서버에 붙는다. 새 의존성(ws 등)을 들이지 않으려고 직접 둔다.
export interface GatewayPayload { op: number; d?: unknown; s?: number | null; t?: string | null }
export class FakeConnection {
  readonly received: GatewayPayload[] = [];
  closeCode: number | undefined;
  ended = false;
  private buffer = Buffer.alloc(0);
  constructor(readonly socket: Socket, readonly path: string, readonly query: URLSearchParams,
    private readonly onPayload: (connection: FakeConnection, payload: GatewayPayload) => void) {
    socket.on('data', chunk => { this.buffer = Buffer.concat([this.buffer, chunk]); this.parse(); });
    socket.on('close', () => { this.ended = true; });
    socket.on('error', () => {});
  }
  private frame(opcode: number, payload: Buffer): Buffer {
    const length = payload.length;
    const header = length < 126 ? Buffer.from([0x80 | opcode, length])
      : length < 65_536 ? Buffer.from([0x80 | opcode, 126, length >> 8, length & 0xff])
        : Buffer.concat([Buffer.from([0x80 | opcode, 127]), (() => { const b = Buffer.alloc(8); b.writeBigUInt64BE(BigInt(length)); return b; })()]);
    return Buffer.concat([header, payload]);
  }
  send(payload: GatewayPayload): void { if (!this.ended) this.socket.write(this.frame(1, Buffer.from(JSON.stringify(payload)))); }
  close(code: number): void {
    if (this.ended) return;
    const body = Buffer.alloc(2); body.writeUInt16BE(code);
    this.socket.write(this.frame(8, body));
    setTimeout(() => this.socket.end(), 20);
  }
  destroy(): void { this.socket.destroy(); }
  private parse(): void {
    for (;;) {
      if (this.buffer.length < 2) return;
      const opcode = this.buffer[0]! & 0x0f;
      let length = this.buffer[1]! & 0x7f;
      let offset = 2;
      if (length === 126) { if (this.buffer.length < 4) return; length = this.buffer.readUInt16BE(2); offset = 4; }
      else if (length === 127) { if (this.buffer.length < 10) return; length = Number(this.buffer.readBigUInt64BE(2)); offset = 10; }
      const masked = (this.buffer[1]! & 0x80) !== 0;
      const maskOffset = offset;
      if (masked) offset += 4;
      if (this.buffer.length < offset + length) return;
      const payload = Buffer.from(this.buffer.subarray(offset, offset + length));
      if (masked) for (let i = 0; i < payload.length; i++) payload[i] = payload[i]! ^ this.buffer[maskOffset + (i % 4)]!;
      this.buffer = this.buffer.subarray(offset + length);
      if (opcode === 1) {
        const value = JSON.parse(payload.toString('utf8')) as GatewayPayload;
        this.received.push(value);
        this.onPayload(this, value);
      } else if (opcode === 8) {
        this.closeCode = payload.length >= 2 ? payload.readUInt16BE(0) : 1005;
        if (!this.ended) { this.socket.write(this.frame(8, payload.subarray(0, 2))); this.socket.end(); }
      } else if (opcode === 9) this.socket.write(this.frame(10, payload));
    }
  }
}
export interface FakeGatewayOptions {
  heartbeatInterval: number;
  ack: boolean;
  // RESUME에 대한 응답: 재생 성공(RESUMED) 또는 세션 무효(op 9 d=false).
  resume: 'resumed' | 'invalid';
  // HELLO 직후 이 코드로 닫는다(치명 오류 흉내).
  closeAfterHello?: number;
}
export class FakeGateway {
  readonly connections: FakeConnection[] = [];
  readonly options: FakeGatewayOptions = { heartbeatInterval: 45_000, ack: true, resume: 'resumed' };
  private server: Server;
  private sessions = 0;
  url = '';
  constructor() {
    this.server = createServer((_req, res) => res.writeHead(404).end());
    this.server.on('upgrade', (req, socket: Socket) => {
      const key = req.headers['sec-websocket-key'];
      if (typeof key !== 'string') { socket.destroy(); return; }
      const accept = createHash('sha1').update(`${key}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`).digest('base64');
      socket.write(`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`);
      const url = new URL(req.url ?? '/', 'http://fake');
      const connection = new FakeConnection(socket, url.pathname, url.searchParams, (c, p) => this.respond(c, p));
      this.connections.push(connection);
      connection.send({ op: 10, d: { heartbeat_interval: this.options.heartbeatInterval }, s: null, t: null });
      if (this.options.closeAfterHello !== undefined) connection.close(this.options.closeAfterHello);
    });
  }
  async start(): Promise<void> {
    this.server.listen(0, '127.0.0.1'); await once(this.server, 'listening');
    this.url = `ws://127.0.0.1:${(this.server.address() as AddressInfo).port}`;
  }
  async close(): Promise<void> {
    for (const connection of this.connections) connection.destroy();
    this.server.close(); this.server.closeAllConnections();
  }
  get latest(): FakeConnection { return this.connections[this.connections.length - 1]!; }
  dispatch(connection: FakeConnection, s: number, t: string, d: unknown): void { connection.send({ op: 0, s, t, d }); }
  private respond(connection: FakeConnection, payload: GatewayPayload): void {
    if (payload.op === 1 && this.options.ack) connection.send({ op: 11 });
    if (payload.op === 2) {
      this.sessions++;
      connection.send({ op: 0, s: 1, t: 'READY', d: { v: 10, session_id: `session-${this.sessions}`,
        resume_gateway_url: `${this.url}/resume`, user: { id: 'fixture-bot' }, application: { id: 'fixture-app' }, guilds: [] } });
    }
    if (payload.op === 6) {
      if (this.options.resume === 'resumed') connection.send({ op: 0, s: ((payload.d as { seq: number }).seq) + 1, t: 'RESUMED', d: {} });
      else connection.send({ op: 9, d: false });
    }
  }
}
export async function until(check: () => boolean, timeoutMs = 4000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!check()) {
    if (Date.now() > deadline) throw new Error('until_timeout');
    await new Promise(resolve => setTimeout(resolve, 5));
  }
}
