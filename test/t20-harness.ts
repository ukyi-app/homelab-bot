import { generateKeyPairSync } from 'node:crypto';
import { BriefingScheduler } from '../src/briefing.js';
import type { PublisherConfig } from '../src/config.js';
import { DiscordRejected } from '../src/contracts.js';
import type { Scope } from '../src/contracts.js';
import type { Database } from '../src/database.js';
import type { FileDeletionLedger } from '../src/deletion-ledger.js';
import type { DiscordApi } from '../src/discord-protocol.js';
import { startPublisher } from '../src/main.js';
import type { ManagedLedger, Publisher, PublisherDeps } from '../src/main.js';
import { MemoryService } from '../src/memory.js';
import { PolicyGate, loadRuntimePolicy } from '../src/policy.js';
import { Store } from '../src/store.js';
import { FakeGateway } from './fake-gateway.js';

// T20 기동 장벽 시험 도구. 실제 Discord에는 닿지 않는다(loopback 가짜 Gateway + 메모리 REST 대역).
export const GUILD = 'fixture-guild', CHAT = 'fixture-chat', NOTIFY = 'fixture-notifications', OWNER = 'fixture-owner';
export const notify: Scope = { guild: GUILD, channel: NOTIFY, parent: null, kind: 'channel' };

// 모든 사건(진입점 로그·REST 발송·원장 열기)을 한 줄에 순서대로 남긴다. 순서 단언은 이 배열로 한다.
export class Trace {
  readonly events: { name: string; detail?: Record<string, unknown> }[] = [];
  push(name: string, detail?: Record<string, unknown>): void { this.events.push({ name, detail }); }
  index(name: string): number { return this.events.findIndex(e => e.name === name); }
  count(name: string, match: (detail: Record<string, unknown>) => boolean = () => true): number {
    return this.events.filter(e => e.name === name && match(e.detail ?? {})).length;
  }
}

export class Rest implements DiscordApi {
  readonly sent: { channel: string; content: string }[] = [];
  private next = 0;
  constructor(private readonly trace: Trace) {}
  async request(method: 'GET' | 'POST' | 'PUT', path: string, body?: unknown): Promise<unknown> {
    let m: RegExpMatchArray | null;
    if (method === 'GET' && (m = path.match(/^\/channels\/([^/?]+)$/))) {
      const id = decodeURIComponent(m[1]!);
      if (id === CHAT || id === NOTIFY) return { id, type: 0, guild_id: GUILD };
      throw new DiscordRejected(404);
    }
    if (method === 'POST' && (m = path.match(/^\/channels\/([^/]+)\/messages$/))) {
      const content = String((body as { content?: unknown }).content ?? '');
      this.sent.push({ channel: decodeURIComponent(m[1]!), content });
      this.trace.push('discord_send', { content });
      return { id: `fixture-message-${++this.next}` };
    }
    if (method === 'GET' && /\/messages\?/.test(path)) return [];
    if (method === 'GET' && /\/threads\/(active|archived\/public)/.test(path)) return { threads: [] };
    if (path.startsWith('/applications/fixture-app/')) return method === 'PUT' ? body : [];
    if (method === 'POST' && path.startsWith('/interactions/')) return undefined;
    throw new Error(`unexpected_${method}_${path}`);
  }
}

// 원장 열기를 세고, 필요하면 열기를 붙잡아 둔다(장벽 순서 시험). 나머지는 실제 FileDeletionLedger에 그대로 넘긴다.
export class ProbeLedger implements ManagedLedger {
  opens = 0;
  hold: Promise<void> | undefined;
  constructor(readonly inner: FileDeletionLedger, private readonly trace: Trace) {}
  async open(): Promise<void> {
    this.opens++;
    this.trace.push('ledger_open');
    await this.hold;
    return this.inner.open();
  }
  append(...args: Parameters<FileDeletionLedger['append']>) { return this.inner.append(...args); }
  has(...args: Parameters<FileDeletionLedger['has']>) { return this.inner.has(...args); }
  entries() { return this.inner.entries(); }
  durable() { return this.inner.durable(); }
  status() { return this.inner.status(); }
  close() { return this.inner.close(); }
}

export function publisherConfig(extra: Partial<PublisherConfig> = {}): PublisherConfig {
  return {
    databaseUrl: 'postgresql://unused', discordToken: 'fixture-discord-token',
    policy: loadRuntimePolicy(JSON.stringify({ revision: 'fixture-v1', owner: OWNER, guild: GUILD, conversationChannel: CHAT,
      notificationChannel: NOTIFY, dmEnabled: false, services: ['homelab-bot'] }), Date.now()),
    grafana: { url: 'http://127.0.0.1:9', token: 'fixture-grafana-token' }, kubernetes: { url: 'http://127.0.0.1:9' },
    workerUrl: 'http://127.0.0.1:9/', healthchecksUrl: 'http://127.0.0.1:9/ping', workerKey: generateKeyPairSync('ed25519').privateKey,
    githubWebhookSecret: 'fixture-webhook-secret-value', ...extra,
  };
}

export async function boot(db: Database, config: PublisherConfig, trace: Trace, deps: Partial<PublisherDeps> = {}) {
  const gw = new FakeGateway();
  gw.options.identifyIntervalMs = 250;
  await gw.start();
  const rest = new Rest(trace);
  let publisher: Publisher;
  try {
    publisher = await startPublisher(config, { db, discord: rest, gatewayUrl: async () => ({ url: gw.url }),
      allowGatewayUrl: url => url.hostname === '127.0.0.1', serviceAccount: { tokenFile: '/nonexistent', caFile: null },
      ports: { app: 0, alerts: 0 }, idleMs: 20, identifySpacingMs: 250, registerDelaysMs: [0], heartbeatEveryMs: 60_000,
      stopTimeoutMs: 3000, t20Backoff: () => 50, ledgerReopenMs: 100, memoryResumeMs: 100, briefingTickMs: 100,
      log: (event, detail) => trace.push(event, detail), ...deps });
  } catch (error) { await gw.close(); throw error; }
  return { publisher, rest, gw, close: async () => { await publisher.stop(); await gw.close(); } };
}

export const metric = async (publisher: Publisher, name: string): Promise<number | undefined> => {
  const text = await (await fetch(`http://127.0.0.1:${publisher.ports.app}/metrics`)).text();
  const line = text.split('\n').find(l => l.startsWith(`${name} `));
  return line === undefined ? undefined : Number(line.slice(name.length + 1));
};
export const ledgerState = async (publisher: Publisher): Promise<string[]> => {
  const text = await (await fetch(`http://127.0.0.1:${publisher.ports.app}/metrics`)).text();
  return [...text.matchAll(/^homelab_bot_deletion_ledger_state\{state="([a-z]+)"\} 1$/gm)].map(m => m[1]!);
};

export async function waitFor(check: () => boolean | Promise<boolean>, timeoutMs = 8000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!await check()) {
    if (Date.now() > deadline) throw new Error('wait_timeout');
    await new Promise(resolve => setTimeout(resolve, 20));
  }
}

export const pendingAlert = (db: Database, key = 'alert:fixture-group:fixture-fingerprint:1') => new Store(db).enqueue({ key, actor: OWNER,
  scope: notify, revision: 'fixture-v1', payload: { kind: 'message', channel: NOTIFY, content: `fixture-alert ${key}`, classification: 'safe_summary' } });

// 브리핑 시각: 지금보다 10분 전의 UTC 시:분. 오늘 회차는 이미 지났고 12시간 안이다.
export const briefingTime = (now = Date.now()) => new Date(now - 600_000).toISOString().slice(11, 16);
const DAY = 86_400_000;
const closedLedger = { append: async () => { throw new Error('unused'); }, has: async () => false, entries: async () => [], durable: async () => false };
// 기동 전 DB에 큐에 든 브리핑을 만든다. 다른 시계를 쓴 예약기로 ensure·tick해 실제 작성 경로를 거친다.
// daysAgo=0: 오늘 회차(기동 뒤에도 유효). daysAgo=1: 어제 회차(기동 뒤 첫 tick이 막아야 하는 지난 회차).
export async function stageBriefing(db: Database, config: PublisherConfig, time: string, daysAgo: 0 | 1, memoryIds: string[] = []) {
  const now = Date.now();
  let clock = now - (daysAgo + 1) * DAY;
  const store = new Store(db, () => clock);
  // 정책 확인 시각이 기동 시각이라 과거 시계로는 정책을 못 읽는다. 작성용으로만 확인 시각을 앞당긴다.
  const gate = PolicyGate.fixed({ ...config.policy, confirmedAt: 0 }, db, () => clock);
  const memory = new MemoryService(db, gate, closedLedger, { check: async () => 'inaccessible' }, () => clock);
  const scheduler = new BriefingScheduler(store, gate, memory, [], { time, timezone: 'UTC' });
  if (await scheduler.ensure() !== 'enabled') throw new Error('stage_ensure');
  clock = now - daysAgo * DAY - 300_000;
  if (await scheduler.tick() !== 'enqueued') throw new Error('stage_tick');
  const key = (await db.query<{ outbox_key: string }>(
    "SELECT outbox_key FROM briefing_runs WHERE state='enqueued' ORDER BY slot_at DESC LIMIT 1")).rows[0]!.outbox_key;
  // 기억이 든 사본으로 만든다(원장을 못 읽은 기동이 막아야 하는 대상).
  if (memoryIds.length) await db.query('UPDATE briefing_copies SET memory_ids=$2 WHERE message_key=$1', [key, JSON.stringify(memoryIds)]);
  return key;
}
export const outboxState = async (db: Database, key: string) =>
  (await db.query<{ state: string }>('SELECT state FROM outbox WHERE message_key=$1', [key])).rows.map(r => r.state);

// 지정한 SQL만 실패시키는 DB 감싸기. broken이 참인 동안 매번 실패한다(재시도도 실패).
export function breakable(db: Database, match: (sql: string) => boolean, error: () => Error) {
  const state = { broken: true, hits: 0 };
  const wrap = (inner: Database): Database => ({
    query: async <T>(sql: string, params?: unknown[]) => {
      if (state.broken && match(sql)) { state.hits++; throw error(); }
      return inner.query<T>(sql, params);
    },
    transaction: (fn, deadline) => inner.transaction(tx => fn(wrap(tx)), deadline),
  });
  return { db: wrap(db), state };
}
