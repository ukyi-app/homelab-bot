import { generateKeyPairSync } from 'node:crypto';
import type { PublisherConfig } from '../src/config.js';
import { DiscordRejected } from '../src/contracts.js';
import type { Database } from '../src/database.js';
import type { DiscordApi } from '../src/discord-protocol.js';
import { startPublisher } from '../src/main.js';
import type { Publisher } from '../src/main.js';
import { loadRuntimePolicy } from '../src/policy.js';
import { FakeGateway, until } from './fake-gateway.js';

// 입력 중 신호(typing) 진입점 시험용 기동 도우미. Discord REST는 메모리 대역, Gateway는 loopback 가짜 서버다.
// 그 밖 HTTP(Kubernetes·Grafana·작업자·healthchecks)는 닿지 않는 주소다(이 시험들은 그 경로를 쓰지 않는다).
export const GUILD = 'fixture-guild', CHAT = 'fixture-chat', NOTIFY = 'fixture-notifications', OWNER = 'fixture-owner';
export const THREAD = 'fixture-thread';
export class SignalRest implements DiscordApi {
  calls: { method: string; path: string; body?: unknown }[] = [];
  typing: (channel: string) => Promise<void> = async () => {};
  private next = 0;
  private channels = new Map<string, { id: string; type: number; guild_id: string; parent_id?: string }>([
    [CHAT, { id: CHAT, type: 0, guild_id: GUILD }], [NOTIFY, { id: NOTIFY, type: 0, guild_id: GUILD }],
    [THREAD, { id: THREAD, type: 11, guild_id: GUILD, parent_id: CHAT }]]);
  async request(method: 'GET' | 'POST' | 'PUT', path: string, body?: unknown): Promise<unknown> {
    this.calls.push({ method, path, body });
    let m: RegExpMatchArray | null;
    if (method === 'GET' && (m = path.match(/^\/channels\/([^/?]+)$/))) {
      const channel = this.channels.get(decodeURIComponent(m[1]!));
      if (!channel) throw new DiscordRejected(404);
      return channel;
    }
    if (method === 'POST' && (m = path.match(/^\/channels\/([^/]+)\/typing$/))) { await this.typing(decodeURIComponent(m[1]!)); return undefined; }
    if (method === 'POST' && /^\/channels\/[^/]+\/messages$/.test(path)) return { id: `fixture-message-${++this.next}` };
    if (method === 'GET' && /^\/channels\/[^/]+\/messages\?/.test(path)) return [];
    if (method === 'POST' && path.startsWith('/interactions/')) return undefined;
    if (path.startsWith('/applications/fixture-app/')) return method === 'PUT' ? body : [];
    throw new Error(`unexpected_${method}_${path}`);
  }
  typingCalls(channel = THREAD): number { return this.calls.filter(c => c.method === 'POST' && c.path === `/channels/${channel}/typing`).length; }
}
export async function bootSignal(options: { db: Database; rest: SignalRest; gw: FakeGateway; now?: () => number;
  logs?: { event: string; detail?: Record<string, unknown> }[] }): Promise<Publisher> {
  const unreachable = 'http://127.0.0.1:9';
  const config: PublisherConfig = {
    databaseUrl: 'postgresql://unused', discordToken: 'fixture-discord-token',
    policy: loadRuntimePolicy(JSON.stringify({ revision: 'fixture-v1', owner: OWNER, guild: GUILD, conversationChannel: CHAT,
      notificationChannel: NOTIFY, dmEnabled: false, services: ['homelab-bot'] }), Date.now()),
    grafana: { url: unreachable, token: 'fixture-grafana-token' }, kubernetes: { url: unreachable }, workerUrl: `${unreachable}/`,
    healthchecksUrl: `${unreachable}/ping`, workerKey: generateKeyPairSync('ed25519').privateKey, githubWebhookSecret: 'fixture-webhook-secret-value',
  };
  const publisher = await startPublisher(config, { db: options.db, now: options.now, discord: options.rest,
    gatewayUrl: async () => ({ url: options.gw.url }), allowGatewayUrl: url => url.hostname === '127.0.0.1',
    serviceAccount: { tokenFile: '/nonexistent/fixture-token', caFile: null }, ports: { app: 0, alerts: 0 }, idleMs: 20,
    identifySpacingMs: 250, recoveryBackoff: () => 200, registerDelaysMs: [0], heartbeatEveryMs: 60_000, stopTimeoutMs: 3000,
    log: (event, detail) => { options.logs?.push({ event, detail }); } });
  await until(() => options.rest.calls.some(c => c.path.startsWith('/applications/fixture-app/')));
  return publisher;
}
export async function waitFor(check: () => Promise<boolean> | boolean, timeoutMs = 4000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) { if (await check()) return true; await new Promise(resolve => setTimeout(resolve, 10)); }
  return check();
}
