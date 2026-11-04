import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { Postgres, migrate } from '../src/database.js';
import type { Database } from '../src/database.js';
import { MemoryService } from '../src/memory.js';
import type { DeletionEntry, DeletionLedger, DocumentSource } from '../src/memory.js';
import { BriefingScheduler } from '../src/briefing.js';
import type { BriefingConfig, ObservationSource } from '../src/briefing.js';
import { DiscordPublisher } from '../src/discord.js';
import { Store } from '../src/store.js';
import type { Scope } from '../src/contracts.js';
import { fixture } from './helpers.js';

// 실제 PostgreSQL 다중 연결 경합 시험이다. PGlite는 transaction을 직렬화해 이 순서를 만들 수 없다.
// HOMELAB_TEST_PG_SOCKET(유닉스 소켓 디렉터리)이 없으면 건너뛴다. 실행 방법은 VERIFICATION T20 절에 있다.
const socket = process.env.HOMELAB_TEST_PG_SOCKET;
const skip = socket ? false : 'HOMELAB_TEST_PG_SOCKET 없음(로컬 PostgreSQL 필요)';
const notifications: Scope = { guild: 'fixture-guild', channel: 'fixture-notifications', parent: null, kind: 'channel' };
const seoul: BriefingConfig = { time: '08:50', timezone: 'Asia/Seoul' };
const SLOT = Date.UTC(2027, 0, 15, 23, 50);
const SOURCE = 'repo://allowed/race.md';
const STATEMENT = '큐 등록과 겹쳐 저장 제외한 기억';
const documents: DocumentSource = { check: async (_actor, uri) => uri.startsWith('repo://allowed/') ? 'verified' : 'inaccessible' };
class MemoryLedger implements DeletionLedger {
  private readonly list: DeletionEntry[] = [];
  async append(entry: DeletionEntry) { this.list.push(entry); }
  async has(id: string, createdAt: number) { return this.list.some(e => e.memoryId === id && e.createdAt === createdAt); }
  async entries() { return [...this.list]; }
  async durable() { return true; }
}
// 일치하는 질의가 돌아온 직후 한 번 멈춘다. 그 transaction은 열린 채로 다른 연결의 작업을 끼워 넣는다.
function pausing(db: Database, match: (sql: string) => boolean) {
  let armed = true;
  let reached!: () => void;
  let release!: () => void;
  const paused = new Promise<void>(resolve => { reached = resolve; });
  const gate = new Promise<void>(resolve => { release = resolve; });
  const wrap = (inner: Database): Database => ({
    query: async <T>(sql: string, params?: unknown[]) => {
      const result = await inner.query<T>(sql, params);
      if (armed && match(sql)) { armed = false; reached(); await gate; }
      return result;
    },
    transaction: (fn, deadline) => inner.transaction(tx => fn(wrap(tx)), deadline),
  });
  return { db: wrap(db), paused, release: () => release() };
}
const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
async function setup() {
  const admin = new pg.Pool({ host: socket, user: 'postgres', database: 'postgres', max: 1 });
  const name = `t20_${randomUUID().replaceAll('-', '').slice(0, 12)}`;
  await admin.query(`CREATE DATABASE ${name}`);
  const pool = new pg.Pool({ host: socket, user: 'postgres', database: name, max: 6 });
  const db = new Postgres(pool);
  await migrate(db);
  const f = await fixture(db);
  const memory = new MemoryService(db, f.gate, new MemoryLedger(), documents, f.now);
  await memory.open();
  await memory.remember('fixture-owner', notifications, { kind: 'configuration', statement: STATEMENT, access: ['fixture-notifications'],
    classification: 'safe_summary', sources: [{ type: 'document', uri: SOURCE, revision: 'r1' }], observedAt: f.now(), recheckAt: f.now() });
  const move = (ts: number) => { f.advance(ts - f.now()); f.policy.confirmedAt = f.now(); };
  return { db, f, memory, move, close: async () => {
    await pool.end();
    // FORCE로 지우면 풀이 닫은 직후 남은 소켓에 종료 오류가 날아와 시험이 흔들린다. 세션이 빠질 때까지 다시 시도한다.
    for (let attempt = 0; ; attempt++) {
      try { await admin.query(`DROP DATABASE ${name}`); break; } catch (error) {
        if (attempt >= 50 || !/being accessed by other users/.test((error as Error).message)) throw error;
        await sleep(100);
      }
    }
    await admin.end();
  } };
}
async function sentStatements(env: Awaited<ReturnType<typeof setup>>, scheduler: BriefingScheduler) {
  await scheduler.tick();
  for (let i = 0; i < 3; i++) await env.f.publisher.deliver();
  return env.f.rest.messages.filter(m => m.body.content.includes(STATEMENT)).length;
}

test('DATA-02 [rev-t20d P2 PG] 브리핑이 기억을 확인한 뒤 큐 등록 전에 저장 제외가 시작돼도 그 기억을 보내지 않음', { skip }, async () => {
  const env = await setup();
  try {
    const hold = pausing(env.db, sql => sql.includes('FOR SHARE'));
    const scheduler = new BriefingScheduler(new Store(hold.db, env.f.now), env.f.gate, env.memory, [], seoul);
    await scheduler.ensure(); env.move(SLOT);
    const ticking = scheduler.tick();
    await hold.paused;
    const excluding = env.memory.exclude('fixture-owner', notifications, `document:${SOURCE}`);
    // 공통 잠금이 있으면 저장 제외는 여기서 기다렸다가 큐 등록 뒤에 그 사본을 막는다.
    await sleep(200);
    hold.release();
    await Promise.all([ticking, excluding]);
    assert.equal(await sentStatements(env, scheduler), 0);
  } finally { await env.close(); }
});
test('DATA-02 [rev-t20d P2 PG] 저장 제외가 먼저 시작돼 끝나기 전에 브리핑을 큐에 넣으려 해도 그 기억을 보내지 않음', { skip }, async () => {
  const env = await setup();
  try {
    const hold = pausing(env.db, sql => sql.includes('FROM briefing_copies'));
    const excluder = new MemoryService(hold.db, env.f.gate, new MemoryLedger(), documents, env.f.now);
    await excluder.open();
    const scheduler = new BriefingScheduler(env.f.store, env.f.gate, env.memory, [], seoul);
    await scheduler.ensure(); env.move(SLOT);
    const excluding = excluder.exclude('fixture-owner', notifications, `document:${SOURCE}`);
    await hold.paused;
    const ticking = scheduler.tick();
    // 공통 잠금이 있으면 큐 등록은 여기서 기다렸다가 저장 제외를 본 뒤 다시 작성한다.
    await sleep(200);
    hold.release();
    await Promise.all([excluding, ticking]);
    assert.equal(await sentStatements(env, scheduler), 0);
  } finally { await env.close(); }
});

// --- 예약 해제: 예약 끄기와 큐 확정·게시의 실제 다중 연결 경합 ---
const unconfigured: BriefingConfig = { time: null, timezone: 'Asia/Seoul' };
async function delivered(env: Awaited<ReturnType<typeof setup>>) {
  for (let i = 0; i < 3; i++) await env.f.publisher.deliver();
  return env.f.rest.messages.length;
}
test('BRIEF-01 [T20 예약 해제 PG] 큐 확정 transaction이 열린 동안 예약을 끄면 그 회차를 보내지 않음', { skip }, async () => {
  const env = await setup();
  try {
    const hold = pausing(env.db, sql => sql.includes("SET state='enqueued'"));
    const scheduler = new BriefingScheduler(new Store(hold.db, env.f.now), env.f.gate, env.memory, [], seoul);
    await scheduler.ensure(); env.move(SLOT);
    const ticking = scheduler.tick();
    await hold.paused;
    const disabling = new BriefingScheduler(env.f.store, env.f.gate, env.memory, [], unconfigured).ensure();
    // 직렬화가 있으면 예약 끄기는 큐 확정이 끝나기를 기다렸다가 그 사본을 막는다.
    await sleep(200);
    hold.release();
    await Promise.all([ticking, disabling]);
    assert.equal(await delivered(env), 0);
  } finally { await env.close(); }
});
test('BRIEF-01 [T20 예약 해제 PG] 예약 끄기가 끝나기 전에 작성을 마친 회차가 큐에 넣으려 해도 보내지 않음', { skip }, async () => {
  const env = await setup();
  try {
    let arrive!: () => void;
    let proceed!: () => void;
    const arrived = new Promise<void>(resolve => { arrive = resolve; });
    const gate = new Promise<void>(resolve => { proceed = resolve; });
    const waiting: ObservationSource = { id: 'waiting', label: 'waiting', kind: 'backup', read: async () => {
      arrive(); await gate; return { observedAt: env.f.now(), status: 'ok', summary: '백업 정상' };
    } };
    const scheduler = new BriefingScheduler(env.f.store, env.f.gate, env.memory, [waiting], seoul);
    await scheduler.ensure(); env.move(SLOT);
    const ticking = scheduler.tick();
    await arrived;
    const hold = pausing(env.db, sql => sql.includes('SET enabled=false'));
    const disabling = new BriefingScheduler(new Store(hold.db, env.f.now), env.f.gate, env.memory, [], unconfigured).ensure();
    await hold.paused;
    proceed();
    // 직렬화가 있으면 큐 확정은 예약 끄기가 끝나기를 기다렸다가 꺼진 예약을 보고 멈춘다.
    await sleep(200);
    hold.release();
    await Promise.all([ticking, disabling]);
    assert.equal(await delivered(env), 0);
  } finally { await env.close(); }
});
test('BRIEF-01 [T20 예약 해제 PG] 게시자가 잡아 권한을 확인하는 동안 예약을 끄면 발송하지 않음', { skip }, async () => {
  const env = await setup();
  try {
    const scheduler = new BriefingScheduler(env.f.store, env.f.gate, env.memory, [], seoul);
    await scheduler.ensure(); env.move(SLOT);
    assert.equal(await scheduler.tick(), 'enqueued');
    const hold = pausing(env.db, sql => sql.includes('SELECT service_ids FROM outbox'));
    const publisher = new DiscordPublisher(new Store(hold.db, env.f.now), env.f.gate, env.f.rest);
    const delivering = publisher.deliver();
    await hold.paused;
    assert.equal(await new BriefingScheduler(env.f.store, env.f.gate, env.memory, [], unconfigured).ensure(), 'unconfigured');
    hold.release();
    await delivering;
    assert.equal(await delivered(env), 0);
  } finally { await env.close(); }
});
