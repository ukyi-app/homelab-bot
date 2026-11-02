import { after, afterEach, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdir, readFile, rm } from 'node:fs/promises';
import pg from 'pg';
import { databasePoolConfig } from '../src/config.js';
import { FileDeletionLedger, LEDGER_FILE } from '../src/deletion-ledger.js';
import { Postgres, migrate } from '../src/database.js';
import { advisoryLedgerLock, lockClient } from '../src/ledger-lock.js';
import { initLedger } from './ledger-fixture.js';
import { Trace, boot, ledgerState, pendingAlert, publisherConfig, waitFor } from './t20-harness.js';

// T20 기동 장벽의 원장 잠금 경합을 실제 PostgreSQL로 본다. 진입점이 직접 만드는 원장(전용 연결 advisory lock)을 그대로 쓴다.
// HOMELAB_TEST_PG_SOCKET(유닉스 소켓 디렉터리)이 없으면 건너뛴다. 실행 방법은 VERIFICATION T20 절에 있다.
const socket = process.env.HOMELAB_TEST_PG_SOCKET;
const skip = socket ? false : 'HOMELAB_TEST_PG_SOCKET 없음(로컬 PostgreSQL 필요)';
const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
let admin: pg.Pool | undefined;
const dirs: string[] = [];
before(async () => { await mkdir('.local', { recursive: true }); });
afterEach(async () => { for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true }); });
after(async () => { await admin?.end(); });

async function database() {
  admin ??= new pg.Pool({ host: socket, user: 'postgres', database: 'postgres', max: 1 });
  const name = `t20_boot_${randomUUID().replaceAll('-', '').slice(0, 12)}`;
  await admin.query(`CREATE DATABASE ${name}`);
  // 진입점과 같은 설정 함수로 연결한다(소켓 경로는 host 매개변수). 원장 잠금 연결도 이 URL로 진입점이 만든다.
  const url = `postgresql://postgres@localhost/${name}?host=${encodeURIComponent(socket!)}`;
  const pool = new pg.Pool(databasePoolConfig(url, { max: 5 }));
  const db = new Postgres(pool);
  await migrate(db);
  const lockHolders = async () => (await admin!.query<{ application_name: string }>(`SELECT a.application_name FROM pg_locks l
    JOIN pg_database d ON d.oid=l.database JOIN pg_stat_activity a ON a.pid=l.pid
    WHERE l.locktype='advisory' AND l.granted AND d.datname=$1`, [name])).rows.map(r => r.application_name);
  return { name, url, db, lockHolders, close: async () => {
    await pool.end();
    for (let attempt = 0; ; attempt++) {
      try { await admin!.query(`DROP DATABASE ${name}`); break; } catch (error) {
        if (attempt >= 50 || !/being accessed by other users/.test((error as Error).message)) throw error;
        await sleep(100);
      }
    }
  } };
}

test('T20 기동 [원장 잠금 PG] 다른 프로세스가 잠금을 쥐고 있으면 lock_held로 기억을 닫고 게시는 진행, 놓으면 다시 열어 잡고, 종료 때 놓음', { skip, timeout: 60_000 }, async () => {
  const d = await database();
  try {
    const made = await initLedger('t20-boot-pg');
    dirs.push(made.dir);
    // 옛 파드(Recreate 전 겹침·수동 기동)가 원장을 쥐고 있는 상황.
    const holder = new FileDeletionLedger({ dir: made.dir, db: d.db,
      lock: advisoryLedgerLock(lockClient({ host: socket, user: 'postgres', database: d.name, application_name: 'fixture-old-pod' })) });
    await holder.open();
    await pendingAlert(d.db);
    const trace = new Trace();
    // deps.ledger 없이: 진입점이 config.databaseUrl로 전용 잠금 연결을 만든다(운영과 같은 경로).
    const config = publisherConfig({ databaseUrl: d.url, memory: { ledgerDir: made.dir, acceptGeneration: null }, briefing: null });
    const { publisher, rest, close } = await boot(d.db, config, trace);
    let stopped = false;
    try {
      await waitFor(() => rest.sent.length === 1);
      const closed = trace.events.find(e => e.name === 'memory_closed')!;
      assert.deepEqual([closed.detail?.reason, closed.detail?.stage], ['deletion_ledger_lock_held', 'lock']);
      assert.deepEqual(await ledgerState(publisher), ['failed']);
      assert.deepEqual(await d.lockHolders(), ['fixture-old-pod']);
      // 쥐고 있는 동안은 재열기도 실패한다(빼앗지 않는다).
      await waitFor(() => trace.count('memory_closed') >= 3);
      assert.equal(trace.index('memory_opened'), -1);
      await holder.close();
      await waitFor(() => trace.index('memory_opened') >= 0);
      assert.deepEqual(await ledgerState(publisher), ['ready']);
      assert.deepEqual(await d.lockHolders(), ['homelab-bot-ledger']);
      await close();
      stopped = true;
      // 종료가 잠금을 놓았다. 다음 작성자가 바로 연다.
      assert.deepEqual(await d.lockHolders(), []);
      const next = new FileDeletionLedger({ dir: made.dir, db: d.db,
        lock: advisoryLedgerLock(lockClient({ host: socket, user: 'postgres', database: d.name, application_name: 'fixture-next-pod' })) });
      await next.open();
      await next.append({ memoryId: 'fixture-memory', createdAt: 1, deletedAt: 2 });
      await next.close();
      assert.match(await readFile(`${made.dir}/${LEDGER_FILE}`, 'utf8'), /fixture-memory/);
    } finally {
      if (!stopped) await close();
      await holder.close().catch(() => {});
    }
  } finally { await d.close(); }
});

test('T20 기동 [원장 잠금 PG] 잠금 연결이 끊기면 fenced, 재기동 전까지 다시 열지 않음(게시는 계속)', { skip, timeout: 60_000 }, async () => {
  const d = await database();
  try {
    const made = await initLedger('t20-boot-pg-fence');
    dirs.push(made.dir);
    const trace = new Trace();
    const config = publisherConfig({ databaseUrl: d.url, memory: { ledgerDir: made.dir, acceptGeneration: null }, briefing: null });
    const { publisher, rest, close } = await boot(d.db, config, trace);
    try {
      await waitFor(() => trace.index('memory_opened') >= 0);
      await admin!.query(`SELECT pg_terminate_backend(a.pid) FROM pg_stat_activity a WHERE a.datname=$1 AND a.application_name='homelab-bot-ledger'`, [d.name]);
      await waitFor(async () => (await ledgerState(publisher))[0] === 'fenced');
      const opens = trace.count('memory_opened') + trace.count('memory_closed');
      await sleep(600);
      assert.equal(trace.count('memory_opened') + trace.count('memory_closed'), opens, '재열기 없음');
      assert.deepEqual(await d.lockHolders(), []);
      await pendingAlert(d.db, 'alert:fixture-group:fixture-fingerprint:2');
      await waitFor(() => rest.sent.length === 1);
    } finally { await close(); }
  } finally { await d.close(); }
});
