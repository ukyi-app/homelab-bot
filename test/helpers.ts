import { PGlite } from '@electric-sql/pglite';
import { readFile } from 'node:fs/promises';
import { generateKeyPairSync } from 'node:crypto';
import type { Database } from '../src/database.js';
import { remaining } from '../src/database.js';
import { Store } from '../src/store.js';
import { PolicyGate } from '../src/policy.js';
import type { Policy } from '../src/policy.js';
import { DiscordIngress, DiscordPublisher } from '../src/discord.js';
import type { DiscordRest } from '../src/discord.js';
import type { EventInput, Scope } from '../src/contracts.js';
import { SerialWorker, WorkerSigner, WorkerVerifier } from '../src/worker.js';
import type { WorkerRequest, WorkerResult } from '../src/worker.js';
import { ReadAdapter } from '../src/read.js';
import type { QueryTemplate, Service } from '../src/read.js';
import { Runtime } from '../src/runtime.js';

export async function localDatabase(path?: string): Promise<{ db: Database; pg: PGlite }> {
  const pg = new PGlite(path);
  const db: Database = {
    query: async <T>(sql: string, params: unknown[] = []) => pg.query<T>(sql, params),
    transaction: (fn, deadline) => pg.transaction(async tx => {
      const result = await fn({ query: (sql, params = []) => tx.query(sql, params),
        transaction: () => { throw new Error('nested'); } });
      if (deadline) remaining(deadline);
      return result;
    }),
  };
  await pg.exec(await readFile('migrations/001_foundation.sql', 'utf8'));
  await pg.exec(await readFile('migrations/002_denial_revision.sql', 'utf8'));
  await pg.exec(await readFile('migrations/003_recovery_controls.sql', 'utf8'));
  await pg.exec(await readFile('migrations/004_delivery_services.sql', 'utf8'));
  await pg.exec(await readFile('migrations/005_delivery_order.sql', 'utf8'));
  await pg.exec(await readFile('migrations/006_alert_services.sql', 'utf8'));
  await pg.exec(await readFile('migrations/007_execution_boundaries.sql', 'utf8'));
  await pg.exec(await readFile('migrations/010_memory_briefing.sql', 'utf8'));
  return { db, pg };
}
export const thread: Scope = { guild: 'fixture-guild', channel: 'fixture-thread', parent: 'fixture-chat', kind: 'thread' };
export const event = (id: string, options: Partial<EventInput> = {}): EventInput => ({
  id, actor: 'fixture-owner', scope: thread, kind: 'message', text: '상태 알려줘', mention: true, ...options,
});
export class MockDiscord implements DiscordRest {
  acks: { event: EventInput; options: unknown }[] = [];
  messages: { id: string; channel: string; body: Parameters<DiscordRest['sendMessage']>[1] }[] = [];
  threads: { id: string; channel: string; body: Parameters<DiscordRest['createThread']>[1] }[] = [];
  pages: EventInput[][] = [];
  failAck = false;
  loseResponse = false;
  rateLimit: Error | undefined;
  async acknowledge(e: EventInput, _content: string, options: Parameters<DiscordRest['acknowledge']>[2]) {
    if (this.failAck) throw new Error('ack_lost');
    this.acks.push({ event: e, options });
  }
  async createThread(channel: string, body: Parameters<DiscordRest['createThread']>[1]) {
    const record = { id: `fixture-new-thread-${this.threads.length}`, channel, body };
    this.threads.push(record);
    if (this.loseResponse) { this.loseResponse = false; throw new Error('response_lost'); }
    return record;
  }
  async sendMessage(channel: string, body: Parameters<DiscordRest['sendMessage']>[1]) {
    if (this.rateLimit) { const error = this.rateLimit; this.rateLimit = undefined; throw error; }
    const old = this.messages.find(m => m.body.nonce === body.nonce);
    if (old) return old;
    const record = { id: `fixture-message-${this.messages.length}`, channel, body };
    this.messages.push(record);
    if (this.loseResponse) { this.loseResponse = false; throw new Error('response_lost'); }
    return record;
  }
  async findDelivery(channel: string, marker: string, kind: 'message' | 'thread'): Promise<{ id: string } | undefined> {
    return kind === 'message' ? this.messages.find(m => m.channel === channel && m.body.content.includes(marker))
      : this.threads.find(t => t.channel === channel && t.body.name.includes(marker));
  }
  async history() { return this.pages.shift() ?? []; }
}
export const service: Service = { id: 'fixture-service', repository: 'fixture/service', namespace: 'app-fixture',
  deployment: 'fixture', internalDomain: null, externalDomain: null, documentation: [] };
export const template: QueryTemplate = { id: 'fixture-status', service: service.id, datasource: 'fixture-metrics',
  namespace: service.namespace, kind: 'status', query: 'up{namespace="app-fixture"}', maxWindowSeconds: 300, maxRows: 20, maxBytes: 8192 };
export async function fixture(db: Database) {
  let time = 1_800_000_000_000;
  const now = () => time;
  const policy: Policy = { revision: 'fixture-v1', confirmedAt: time, owner: 'fixture-owner', guild: 'fixture-guild',
    conversationChannel: 'fixture-chat', notificationChannel: 'fixture-notifications', dmEnabled: null, services: [service.id] };
  const gate = new PolicyGate(async () => policy, db, now);
  const store = new Store(db, now);
  const rest = new MockDiscord();
  const ingress = new DiscordIngress(store, gate, rest);
  const publisher = new DiscordPublisher(store, gate, rest);
  const keys = generateKeyPairSync('ed25519');
  const used = new Set<string>();
  const verifier = new WorkerVerifier(keys.publicKey, async nonce => {
    if (used.has(nonce)) return false; used.add(nonce); return true;
  }, now);
  const signer = new WorkerSigner(keys.privateKey, now);
  const requests: WorkerRequest[] = [];
  let run: (request: WorkerRequest) => Promise<WorkerResult> = async () => ({ status: 'succeeded', stopped: true,
    answer: { facts: [], hypotheses: [], unknowns: ['조회 전'], checks: [] } });
  const worker = new SerialWorker(verifier, async request => { requests.push(request); return run(request); }, async () => true);
  const queries: unknown[] = [];
  let observation: unknown = { observedAt: time, rows: [{ status: 'healthy' }] };
  const reader = new ReadAdapter([service], [template], gate, { query: async request => {
    queries.push(request); if (observation instanceof Error) throw observation;
    return new TextEncoder().encode(JSON.stringify(observation));
  } }, now);
  const runtime = new Runtime(store, gate, worker, signer, reader);
  return { now, advance: (ms: number) => { time += ms; }, policy, gate, store, rest, ingress, publisher,
    signer, verifier, keys, worker, requests, reader, queries, runtime,
    setRun: (fn: typeof run) => { run = fn; }, setObservation: (value: unknown) => { observation = value; } };
}
