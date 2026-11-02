import { after, afterEach, before, beforeEach, test } from 'node:test';
import assert from 'node:assert/strict';
import { constants } from 'node:fs';
import { lstat, mkdir, open, readFile, rm, unlink, writeFile } from 'node:fs/promises';
import type { FileHandle } from 'node:fs/promises';
import { join } from 'node:path';
import type { LedgerIo } from '../src/deletion-ledger.js';
import { LEDGER_FILE, MARKER_FILE } from '../src/deletion-ledger.js';
import { closeLedgers, faultyIo, freeLock, initLedger, ledgerAt } from './ledger-fixture.js';
import { localDatabase } from './helpers.js';
import { ProbeLedger, Trace, boot, breakable, briefingTime, ledgerState, metric, outboxState, pendingAlert, publisherConfig,
  stageBriefing, waitFor } from './t20-harness.js';

// T20 기동 장벽·루프·종료·지표(B3). 진입점(startPublisher)을 PGlite·가짜 Gateway·메모리 REST로 띄운다.
// 원장은 실제 파일(.local 임시 디렉터리)이고 잠금만 PGlite용 가짜(freeLock)다. 실제 잠금 경합은 t20-startup-pg가 본다.
let database: Awaited<ReturnType<typeof localDatabase>>;
let dirs: string[] = [];
const closers: (() => Promise<void>)[] = [];
before(async () => { database = await localDatabase(); await mkdir('.local', { recursive: true }); });
beforeEach(async () => {
  const tables = (await database.pg.query<{ tablename: string }>(
    "SELECT tablename FROM pg_tables WHERE schemaname='public' AND tablename<>'schema_migrations'")).rows.map(r => r.tablename);
  await database.pg.exec(`TRUNCATE ${tables.join(',')} RESTART IDENTITY CASCADE`);
});
afterEach(async () => {
  for (const close of closers.splice(0).reverse()) await close().catch(() => {});
  await closeLedgers();
  for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true });
});
after(async () => { await database.pg.close(); });

async function ledgerDir(options: { marker?: boolean } = {}) {
  const made = await initLedger('t20-startup');
  dirs.push(made.dir);
  const marker = await readFile(join(made.dir, MARKER_FILE), 'utf8');
  if (options.marker === false) await unlink(join(made.dir, MARKER_FILE));
  return { ...made, marker };
}
async function start(trace: Trace, options: { dir?: string; probe?: ProbeLedger; briefing?: string | null; db?: typeof database.db;
  deps?: Parameters<typeof boot>[3] } = {}) {
  const config = publisherConfig(options.dir ? {
    memory: { ledgerDir: options.dir, acceptGeneration: null },
    briefing: options.briefing ? { time: options.briefing, timezone: 'UTC' } : null } : {});
  const booted = await boot(options.db ?? database.db, config, trace, { ...(options.probe ? { ledger: options.probe } : {}), ...options.deps });
  closers.push(booted.close);
  return booted;
}
const probeAt = (dir: string, trace: Trace, extra: Parameters<typeof ledgerAt>[2] = {}) => new ProbeLedger(ledgerAt(dir, database.db, extra), trace);
const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

test('T20 기동 [원장 꺼짐] MEMORY_LEDGER_DIR이 없으면 원장·기억·브리핑을 만들지 않고 게시자는 지금처럼 바로 돎, 지표 disabled', async () => {
  const trace = new Trace();
  await pendingAlert(database.db);
  const { publisher, rest } = await start(trace);
  await waitFor(() => rest.sent.length === 1);
  for (const name of ['memory_opened', 'memory_closed', 'briefing_ensured', 'briefing_first_tick', 't20_barrier_passed']) assert.equal(trace.index(name), -1, name);
  assert.deepEqual(await ledgerState(publisher), ['disabled']);
  assert.equal(await metric(publisher, 'homelab_bot_briefing_enabled'), 0);
  assert.equal(await metric(publisher, 'homelab_bot_memory_deletions_pending'), 0);
  assert.equal((await database.db.query('SELECT 1 FROM schedules')).rows.length, 0);
  assert.equal((await database.db.query('SELECT 1 FROM deletion_ledger_generation')).rows.length, 0);
});

test('T20 기동 [장벽 순서] 원장 열기 → 재적용 → ensure → 첫 tick이 끝나기 전에는 게시자가 아무것도 보내지 않고, 지난 회차 브리핑은 첫 tick이 막음', async () => {
  const trace = new Trace();
  const time = briefingTime();
  const config = publisherConfig();
  const stale = await stageBriefing(database.db, config, time, 1);
  await pendingAlert(database.db);
  const { dir } = await ledgerDir();
  const probe = probeAt(dir, trace);
  let release!: () => void;
  probe.hold = new Promise(resolve => { release = resolve; });
  const { publisher, rest } = await start(trace, { dir, probe, briefing: time });
  await waitFor(() => trace.index('ledger_open') >= 0);
  // 원장 열기를 붙잡은 동안: READY는 받았지만 게시자(reconcile·deliver)는 열리지 않았다.
  await sleep(400);
  assert.equal(rest.sent.length, 0);
  assert.deepEqual(await outboxState(database.db, stale), ['pending']);
  release();
  await waitFor(() => rest.sent.length >= 2);
  const order = ['ledger_open', 'memory_opened', 'briefing_ensured', 'briefing_first_tick', 't20_barrier_passed', 'discord_send'].map(n => trace.index(n));
  assert.deepEqual([...order].sort((a, b) => a - b), order, `순서: ${order}`);
  // 어제 회차는 보내지 않고 막았다. 오늘 회차(첫 tick이 작성)와 경보만 나갔다.
  assert.deepEqual(await outboxState(database.db, stale), ['blocked']);
  await sleep(300);
  assert.equal(rest.sent.length, 2);
  assert.equal(rest.sent.filter(s => s.content.includes('fixture-alert')).length, 1);
  assert.equal(rest.sent.filter(s => s.content.includes('■')).length, 1, '브리핑은 오늘 회차 하나만');
  const runs = (await database.db.query<{ state: string; reason: string | null }>('SELECT state,reason FROM briefing_runs ORDER BY slot_at')).rows;
  assert.deepEqual(runs.map(r => [r.state, r.reason]), [['missed', 'superseded_by_later_slot'], ['enqueued', null]]);
  assert.deepEqual(await ledgerState(publisher), ['ready']);
  assert.equal(await metric(publisher, 'homelab_bot_briefing_enabled'), 1);
});

test('T20 기동 [원장 열기 실패] 표식이 없으면(missing) 기억은 닫고 기억이 든 대기 브리핑은 막은 뒤 게시 진행, 표식이 생기면 다시 열림', async () => {
  const trace = new Trace();
  const time = briefingTime();
  const config = publisherConfig();
  const withMemory = await stageBriefing(database.db, config, time, 0, ['fixture-memory@1']);
  await pendingAlert(database.db);
  const { dir, marker } = await ledgerDir({ marker: false });
  const probe = probeAt(dir, trace);
  const { publisher, rest } = await start(trace, { dir, probe, briefing: time });
  // 기억이 든 사본은 막고, 그 회차는 기억 없이 다시 작성돼(revision r1) 나간다. 기억 칸은 미확인이다.
  await waitFor(() => rest.sent.length === 2);
  assert.equal(rest.sent.filter(s => s.content.includes('fixture-alert')).length, 1);
  assert.match(rest.sent.find(s => s.content.includes('■'))!.content, /삭제 원장 재적용 전이라 조회하지 않음 · 미확인/);
  assert.deepEqual(await outboxState(database.db, `${withMemory}:r1`), ['sent']);
  const closed = trace.events.find(e => e.name === 'memory_closed')!;
  assert.deepEqual([closed.detail?.reason, closed.detail?.stage], ['deletion_ledger_missing', 'open']);
  assert.deepEqual(await outboxState(database.db, withMemory), ['blocked']);
  assert.ok(trace.index('memory_closed') < trace.index('t20_barrier_passed'));
  assert.ok(trace.index('t20_barrier_passed') < trace.index('discord_send'));
  assert.deepEqual(await ledgerState(publisher), ['failed']);
  // 재시도할 수 있는 열기 실패라 주기마다 다시 연다. 사람이 표식을 만들면 열린다(봇은 만들지 않는다).
  await waitFor(() => probe.opens >= 3);
  await writeFile(join(dir, MARKER_FILE), marker, { mode: 0o600, flag: 'wx' });
  await waitFor(() => trace.index('memory_opened') >= 0);
  assert.deepEqual(await ledgerState(publisher), ['ready']);
  const opens = probe.opens;
  await sleep(400);
  assert.equal(probe.opens, opens, '연 뒤에는 다시 열지 않음');
  assert.equal(rest.sent.length, 2, '막은 브리핑은 다시 열려도 나가지 않음');
  assert.deepEqual(await outboxState(database.db, withMemory), ['blocked']);
});

test('T20 기동 [차단 실패] 원장도 못 읽고 대기 브리핑 차단 transaction도 실패하면 게시자를 열지 않고 재시도, 차단이 되면 열림', async () => {
  const trace = new Trace();
  const time = briefingTime();
  const config = publisherConfig();
  const withMemory = await stageBriefing(database.db, config, time, 0, ['fixture-memory@1']);
  await pendingAlert(database.db);
  const { dir } = await ledgerDir({ marker: false });
  const faulty = breakable(database.db, sql => sql.includes("memory_ids<>'[]'::jsonb"), () => new Error('injected_db_failure'));
  const probe = probeAt(dir, trace);
  const { publisher, rest } = await start(trace, { dir, probe, briefing: time, db: faulty.db });
  await waitFor(() => trace.count('t20_barrier_failed', d => d.step === 'memory_open') >= 3);
  assert.equal(rest.sent.length, 0);
  assert.deepEqual(await outboxState(database.db, withMemory), ['pending']);
  assert.equal(trace.index('t20_barrier_passed'), -1);
  faulty.state.broken = false;
  await waitFor(() => rest.sent.length === 2);
  assert.equal(rest.sent.filter(s => s.content.includes('fixture-alert')).length, 1);
  assert.deepEqual(await outboxState(database.db, withMemory), ['blocked']);
  assert.deepEqual(await outboxState(database.db, `${withMemory}:r1`), ['sent']);
  assert.ok(trace.index('memory_closed') >= 0);
  assert.equal(await metric(publisher, 'homelab_bot_briefing_enabled'), 1);
});

test('T20 기동 [ensure 실패] ensure()가 교착(40P01)으로 throw하면 게시자를 열지 않고 ensure만 다시 시도', async () => {
  const trace = new Trace();
  const time = briefingTime();
  await pendingAlert(database.db);
  const { dir } = await ledgerDir();
  const deadlock = () => Object.assign(new Error('deadlock detected'), { code: '40P01' });
  const faulty = breakable(database.db, sql => sql.startsWith('SELECT enabled FROM schedules WHERE id=$1 FOR UPDATE'), deadlock);
  const probe = probeAt(dir, trace);
  const { publisher, rest } = await start(trace, { dir, probe, briefing: time, db: faulty.db });
  await waitFor(() => trace.count('t20_barrier_failed', d => d.step === 'briefing_ensure' && d.code === '40P01') >= 3);
  assert.equal(rest.sent.length, 0);
  assert.equal(await metric(publisher, 'homelab_bot_briefing_enabled'), 0);
  faulty.state.broken = false;
  await waitFor(() => rest.sent.length >= 1);
  assert.equal(probe.opens, 1, '원장은 한 번만 열고 ensure만 다시 함');
  assert.ok(trace.index('t20_barrier_passed') < trace.index('discord_send'));
  assert.equal(await metric(publisher, 'homelab_bot_briefing_enabled'), 1);
});

test('T20 기동 [브리핑 꺼짐] BRIEFING_* 없이 원장만 켜면 ensure()가 예약을 끄고 남은 사본을 막은 뒤 게시', async () => {
  const trace = new Trace();
  const config = publisherConfig();
  const today = await stageBriefing(database.db, config, briefingTime(), 0);
  await pendingAlert(database.db);
  const { dir } = await ledgerDir();
  const { publisher, rest } = await start(trace, { dir, probe: probeAt(dir, trace), briefing: null });
  await waitFor(() => rest.sent.length === 1);
  assert.match(rest.sent[0]!.content, /fixture-alert/);
  assert.deepEqual(await outboxState(database.db, today), ['blocked']);
  assert.equal(trace.events.find(e => e.name === 'briefing_ensured')?.detail?.result, 'unconfigured');
  assert.equal(await metric(publisher, 'homelab_bot_briefing_enabled'), 0);
  assert.deepEqual(await ledgerState(publisher), ['ready']);
});

test('T20 루프 [fenced·failed] 연 뒤 잠금을 잃거나(fenced) 쓰는 중 fsync가 실패하면(failed) 다시 열지 않음', async () => {
  for (const kind of ['fenced', 'failed'] as const) {
    const trace = new Trace();
    const { dir } = await ledgerDir();
    const lock = freeLock();
    const faults: { fileSync?: string } = {};
    const io = faultyIo(faults);
    const probe = probeAt(dir, trace, { lock: lock.source, io });
    const { publisher, close } = await start(trace, { dir, probe });
    await waitFor(() => trace.index('t20_barrier_passed') >= 0);
    if (kind === 'fenced') lock.lose();
    else { faults.fileSync = 'EIO'; await assert.rejects(probe.append({ memoryId: 'fixture-memory', createdAt: 1, deletedAt: 2 })); }
    assert.equal(probe.status().state, kind);
    await sleep(600);
    assert.equal(probe.opens, 1, kind);
    assert.deepEqual(await ledgerState(publisher), [kind]);
    await close();
    closers.pop();
    await database.db.query('DELETE FROM deletion_ledger_generation');
  }
});

test('T20 종료: stop()은 루프를 멈추고 진행 중 원장 쓰기를 마친 뒤 원장을 닫음(잠금 해제), 그 뒤 쓰기는 거부', async () => {
  const trace = new Trace();
  const { dir, file } = await ledgerDir();
  let released = 0;
  const lock = freeLock();
  // 원장 파일 fsync를 늦춰 stop() 동안 쓰기가 진행 중이게 한다.
  let slow = false;
  const io: LedgerIo = {
    open: async (path, flags) => {
      const handle = await open(path, flags);
      if (!path.endsWith(LEDGER_FILE) || (flags & constants.O_DIRECTORY)) return handle;
      return new Proxy(handle, { get(target, prop) {
        if (prop === 'sync') return async () => { if (slow) await sleep(500); return target.sync(); };
        const value = Reflect.get(target, prop, target);
        return typeof value === 'function' ? value.bind(target) : value;
      } }) as FileHandle;
    },
    lstat: path => lstat(path, { bigint: true }),
    uid: () => process.getuid!(),
  };
  const source: typeof lock.source = async onLost => {
    const lease = await lock.source(onLost);
    return { ...lease, release: async () => { released++; await lease.release(); } };
  };
  const probe = probeAt(dir, trace, { lock: source, io });
  const { publisher } = await start(trace, { dir, probe, briefing: briefingTime() });
  await waitFor(() => trace.index('t20_barrier_passed') >= 0);
  slow = true;
  const writing = probe.append({ memoryId: 'fixture-memory', createdAt: 1, deletedAt: 2 });
  await sleep(50);
  await publisher.stop();
  await writing;
  assert.match(await readFile(file, 'utf8'), /fixture-memory/);
  assert.equal(released, 1);
  assert.equal(probe.status().state, 'closed');
  await assert.rejects(probe.append({ memoryId: 'fixture-memory-2', createdAt: 1, deletedAt: 2 }), /deletion_ledger_(closed|not_open)/);
  assert.ok(trace.index('publisher_stopped') > trace.index('t20_barrier_passed'));
  const opens = probe.opens;
  await sleep(300);
  assert.equal(probe.opens, opens, '종료 뒤 재열기 없음');
});
