import { z } from 'zod';
import type { DiscordApi } from './discord-protocol.js';
import type { IdentifySlot } from './health.js';
import { errorInfo } from './log.js';

// Discord Gateway v10 세션(JSON, 압축 없음). Node 24 내장 WebSocket을 쓴다(새 의존성 없음).
// GUILDS(1) | GUILD_MESSAGES(512) | GUILD_MESSAGE_TYPING(2048) | MESSAGE_CONTENT(32768). DM을 끄므로 DIRECT_MESSAGES는 뺀다(T16a 확정).
// TYPING은 입력 중 디바운스 힌트용(개선안 v2 2-3)이다. 비특권 intent라 포털 설정 없이 IDENTIFY 비트만 바꾼다.
export const GATEWAY_INTENTS = 35329;
// 이 코드로 닫히면 다시 연결해도 같은 결과다(토큰·샤드·버전·intent 오류). 사람이 고칠 때까지 멈춘다.
const FATAL_CLOSE = new Set([4004, 4010, 4011, 4012, 4013, 4014]);
// 세션이 무효라 RESUME할 수 없는 close 코드.
const SESSION_LOST_CLOSE = new Set([4007, 4009]);
// 우리가 끊고 RESUME할 때 쓰는 코드. 1000·1001로 닫으면 Discord가 세션을 무효로 만든다.
const RECONNECT_CODE = 4900;

export interface GatewaySocket {
  send(data: string): void;
  close(code?: number, reason?: string): void;
  addEventListener(type: 'open' | 'message' | 'close' | 'error', listener: (event: { data?: unknown; code?: number }) => void): void;
}
export interface GatewayOptions {
  token: string;
  intents?: number;
  // 새 세션(IDENTIFY)마다 부른다. retryAfterMs가 있으면 그만큼 기다린 뒤 다시 묻는다(session_start_limit 소진).
  gatewayUrl: () => Promise<{ url: string; retryAfterMs?: number }>;
  // next: 다음 IDENTIFY 가능 시각(읽기만), reserve: 한 번 예약(일일 예산·간격을 원자적으로, 전송 마감 포함),
  // release: 보내지 않은 예약 풀기. next·reserve는 예산이 없으면 undefined.
  budget: { next(): Promise<number | undefined>; reserve(): Promise<IdentifySlot | undefined>; release?(slot: IdentifySlot): Promise<void>;
    backoff(attempt: number, random?: number): number };
  health: { gateway(connected: boolean): void };
  dispatch: (type: string, data: unknown) => Promise<void>;
  onReady?: (ready: { applicationId: string; userId: string }) => Promise<void> | void;
  log?: (event: string, detail?: Record<string, unknown>) => void;
  connect?: (url: string) => GatewaySocket;
  allowUrl?: (url: URL) => boolean;
  random?: () => number;
  helloTimeoutMs?: number;
  now?: () => number;
}
const Payload = z.object({ op: z.number().int(), d: z.unknown().optional(), s: z.number().int().nullable().optional(),
  t: z.string().nullable().optional() });
const Hello = z.object({ heartbeat_interval: z.number().positive().max(600_000) });
const Ready = z.object({ session_id: z.string().min(1), resume_gateway_url: z.string().min(1),
  user: z.object({ id: z.string().min(1) }), application: z.object({ id: z.string().min(1) }) });
export const discordGatewayHost = (url: URL) => url.protocol === 'wss:' && (url.hostname === 'discord.gg' || url.hostname.endsWith('.discord.gg'));

export class GatewaySession {
  private socket: GatewaySocket | undefined;
  private session: { id: string; resumeUrl: string } | undefined;
  private seq: number | null = null;
  private attempt = 0;
  private acked = true;
  private stopped = false;
  private halted = false;
  private nextDelayMs: number | undefined;
  private timers = new Set<ReturnType<typeof setTimeout>>();
  private events: Promise<void> = Promise.resolve();
  private closed: (() => void) | undefined;
  constructor(private readonly options: GatewayOptions) {}
  get state(): { connected: boolean; halted: boolean; resumable: boolean } {
    return { connected: this.connected, halted: this.halted, resumable: !!this.session && this.seq !== null };
  }
  private connected = false;
  start(): void { void this.open(); }
  async stop(timeoutMs = 2000): Promise<void> {
    this.stopped = true;
    this.clearTimers();
    const socket = this.socket;
    if (socket) {
      const done = new Promise<void>(resolve => { this.closed = resolve; });
      try { socket.close(1000, 'shutdown'); } catch { this.closed?.(); }
      await Promise.race([done, new Promise(resolve => setTimeout(resolve, timeoutMs))]);
    }
    this.setConnected(false);
    await Promise.race([this.events, new Promise(resolve => setTimeout(resolve, timeoutMs))]);
  }
  private log(event: string, detail?: Record<string, unknown>) { this.options.log?.(event, detail); }
  private later(ms: number, fn: () => void) {
    const timer = setTimeout(() => { this.timers.delete(timer); fn(); }, ms);
    this.timers.add(timer);
  }
  // stop()이 타이머를 지우면 끝나지 않고 버려진다(핸들을 잡지 않는다).
  private pause(ms: number): Promise<void> { return new Promise(resolve => this.later(ms, resolve)); }
  private now(): number { return (this.options.now ?? Date.now)(); }
  private clearTimers() { for (const timer of this.timers) clearTimeout(timer); this.timers.clear(); }
  private setConnected(value: boolean) {
    if (this.connected === value) return;
    this.connected = value;
    this.options.health.gateway(value);
  }
  private retry(reason: string) {
    if (this.stopped || this.halted) return;
    const delay = this.nextDelayMs ?? this.options.budget.backoff(this.attempt, (this.options.random ?? Math.random)());
    this.nextDelayMs = undefined;
    this.attempt++;
    this.log('gateway_retry', { reason, delayMs: delay, attempt: this.attempt });
    this.later(delay, () => { void this.open(); });
  }
  private async open(): Promise<void> {
    if (this.stopped || this.halted || this.socket) return;
    let url: string;
    let identify = false;
    try {
      if (this.session && this.seq !== null) url = this.session.resumeUrl;
      else {
        this.session = undefined; this.seq = null;
        const target = await this.options.gatewayUrl();
        if (target.retryAfterMs !== undefined) {
          this.nextDelayMs = Math.max(1000, target.retryAfterMs);
          this.retry('session_start_limit'); return;
        }
        // 예산이 없으면 연결하지 않는다. 5초 간격 안이면 연결 전에 기다린다. 실제 예약은 HELLO 뒤 IDENTIFY 직전에 한다.
        const next = await this.options.budget.next();
        if (next === undefined) {
          this.nextDelayMs = 60_000;
          this.retry('identify_budget'); return;
        }
        if (next > this.now()) await this.pause(next - this.now());
        url = target.url; identify = true;
      }
      const parsed = new URL(url);
      if (!(this.options.allowUrl ?? discordGatewayHost)(parsed)) throw new Error('gateway_url_rejected');
      parsed.searchParams.set('v', '10'); parsed.searchParams.set('encoding', 'json');
      url = parsed.toString();
    } catch (error) {
      this.log('gateway_open_failed', errorInfo(error));
      this.retry('open_failed'); return;
    }
    if (this.stopped) return;
    const socket = (this.options.connect ?? (target => new WebSocket(target) as unknown as GatewaySocket))(url);
    this.socket = socket;
    this.acked = true;
    let hello = false;
    this.later(this.options.helloTimeoutMs ?? 30_000, () => { if (!hello && this.socket === socket) this.drop(socket, 'hello_timeout'); });
    socket.addEventListener('message', event => {
      if (this.socket !== socket) return;
      let payload: z.infer<typeof Payload>;
      try { payload = Payload.parse(JSON.parse(String(event.data))); } catch { this.log('gateway_bad_payload'); return; }
      if (payload.op === 10) hello = true;
      this.handle(socket, payload, identify);
    });
    socket.addEventListener('close', event => { this.onClose(socket, event.code ?? 1006); });
    socket.addEventListener('error', () => { this.log('gateway_socket_error'); });
  }
  private send(socket: GatewaySocket, payload: unknown) {
    try { socket.send(JSON.stringify(payload)); } catch { this.drop(socket, 'send_failed'); }
  }
  private drop(socket: GatewaySocket, reason: string) {
    this.log('gateway_drop', { reason });
    try { socket.close(RECONNECT_CODE, reason); } catch { this.onClose(socket, 1006); }
  }
  private heartbeat(socket: GatewaySocket, interval: number, first: boolean) {
    const delay = first ? Math.floor(interval * (this.options.random ?? Math.random)()) : interval;
    this.later(delay, () => {
      if (this.socket !== socket) return;
      // 직전 heartbeat의 ACK가 없으면 좀비 연결이다. 1000이 아닌 코드로 끊고 RESUME한다.
      if (!this.acked) { this.drop(socket, 'heartbeat_ack_missing'); return; }
      this.acked = false;
      this.send(socket, { op: 1, d: this.seq });
      this.heartbeat(socket, interval, false);
    });
  }
  // IDENTIFY 직전에 예약하고 그 예약의 전송 창(at~deadline) 안에서만 보낸다. 예약 응답이 늦어 창을 놓치면 풀고 다시 예약한다.
  // 그래야 예약 간격이 실제 전송 간격을 보장한다(예약 시각보다 늦게 보낸 IDENTIFY가 다음 예약의 기준을 앞당기지 않음).
  private async identify(socket: GatewaySocket): Promise<void> {
    const release = (slot: IdentifySlot) => this.options.budget.release?.(slot)
      .catch(error => { this.log('identify_release_failed', errorInfo(error)); });
    for (let attempt = 0; attempt < 3; attempt++) {
      let slot: IdentifySlot | undefined;
      try { slot = await this.options.budget.reserve(); }
      catch (error) {
        this.log('identify_reserve_failed', errorInfo(error));
        if (this.socket === socket) this.drop(socket, 'identify_reserve_failed');
        return;
      }
      if (slot === undefined) {
        if (this.socket === socket) { this.nextDelayMs = 60_000; this.drop(socket, 'identify_budget'); }
        return;
      }
      if (this.socket !== socket || this.stopped) { await release(slot); return; }
      if (slot.at > this.now()) await this.pause(slot.at - this.now());
      if (this.socket !== socket || this.stopped) { await release(slot); return; }
      if (this.now() <= slot.deadline) {
        this.send(socket, { op: 2, d: { token: this.options.token, intents: this.options.intents ?? GATEWAY_INTENTS,
          properties: { os: 'linux', browser: 'homelab-bot', device: 'homelab-bot' } } });
        return;
      }
      this.log('identify_slot_missed', { lateMs: this.now() - slot.deadline });
      await release(slot);
    }
    if (this.socket === socket) this.drop(socket, 'identify_slot_missed');
  }
  private handle(socket: GatewaySocket, payload: z.infer<typeof Payload>, identify: boolean) {
    if (typeof payload.s === 'number') this.seq = payload.s;
    switch (payload.op) {
      case 10: {
        const hello = Hello.safeParse(payload.d);
        if (!hello.success) { this.drop(socket, 'bad_hello'); return; }
        this.heartbeat(socket, hello.data.heartbeat_interval, true);
        if (identify) void this.identify(socket);
        else if (this.session) this.send(socket, { op: 6, d: { token: this.options.token, session_id: this.session.id, seq: this.seq } });
        return;
      }
      case 11: this.acked = true; return;
      case 1: this.send(socket, { op: 1, d: this.seq }); return;
      case 7: this.drop(socket, 'server_reconnect'); return;
      case 9: {
        // d=false면 세션을 버리고 1~5초 뒤 새 IDENTIFY(문서 권고), true면 RESUME을 다시 시도한다.
        if (payload.d !== true) { this.session = undefined; this.seq = null; }
        this.nextDelayMs = 1000 + Math.floor(4000 * (this.options.random ?? Math.random)());
        this.drop(socket, 'invalid_session'); return;
      }
      case 0: break;
      default: return;
    }
    if (payload.t === 'READY') {
      const ready = Ready.safeParse(payload.d);
      if (!ready.success) { this.drop(socket, 'bad_ready'); return; }
      this.session = { id: ready.data.session_id, resumeUrl: ready.data.resume_gateway_url };
      this.attempt = 0;
      this.setConnected(true);
      this.log('gateway_ready');
      const info = { applicationId: ready.data.application.id, userId: ready.data.user.id };
      this.events = this.events.then(async () => { await this.options.onReady?.(info); })
        .catch(() => { this.log('gateway_ready_handler_failed'); });
      return;
    }
    if (payload.t === 'RESUMED') { this.attempt = 0; this.setConnected(true); this.log('gateway_resumed'); return; }
    if (!payload.t) return;
    const type = payload.t, data = payload.d;
    // 이벤트는 받은 순서대로 하나씩 처리한다(메시지 checkpoint가 순서에 기댄다). heartbeat는 타이머라 막히지 않는다.
    this.events = this.events.then(() => this.options.dispatch(type, data))
      .catch(error => { this.log('gateway_event_failed', { type, ...errorInfo(error) }); });
  }
  private onClose(socket: GatewaySocket, code: number) {
    if (this.socket !== socket) return;
    this.socket = undefined;
    this.clearTimers();
    this.setConnected(false);
    this.log('gateway_closed', { code });
    if (this.stopped) { this.closed?.(); return; }
    if (FATAL_CLOSE.has(code)) { this.halted = true; this.log('gateway_halted', { code }); return; }
    if (SESSION_LOST_CLOSE.has(code)) { this.session = undefined; this.seq = null; }
    this.retry(`close_${code}`);
  }
}

const GatewayBot = z.object({ url: z.string().min(1),
  session_start_limit: z.object({ remaining: z.number().int(), reset_after: z.number().int().nonnegative() }) });
// GET /gateway/bot. 남은 세션 시작 횟수가 0이면 reset_after만큼 기다리게 한다.
export function discordGatewayUrl(api: DiscordApi): () => Promise<{ url: string; retryAfterMs?: number }> {
  return async () => {
    const bot = GatewayBot.parse(await api.request('GET', '/gateway/bot'));
    if (!discordGatewayHost(new URL(bot.url))) throw new Error('gateway_url_rejected');
    return bot.session_start_limit.remaining < 1 ? { url: bot.url, retryAfterMs: bot.session_start_limit.reset_after } : { url: bot.url };
  };
}
