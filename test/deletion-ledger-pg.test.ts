import { after, afterEach, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import pg from 'pg';
import { Postgres, migrate } from '../src/database.js';
import { FileDeletionLedger, LedgerError } from '../src/deletion-ledger.js';
import type { FileLedgerOptions } from '../src/deletion-ledger.js';
import { advisoryLedgerLock, lockClient } from '../src/ledger-lock.js';
import type { LockClient } from '../src/ledger-lock.js';
import { MemoryService } from '../src/memory.js';
import type { DocumentSource } from '../src/memory.js';
import { fixture, thread } from './helpers.js';
import { initLedger } from './ledger-fixture.js';

// 원장의 배타 소유권(세션 advisory lock)과 세대 묶음을 실제 PostgreSQL로 본다. PGlite는 연결이 하나라 배타를 만들 수 없다.
// HOMELAB_TEST_PG_SOCKET(유닉스 소켓 디렉터리)이 없으면 건너뛴다. 실행 방법은 VERIFICATION T20 절에 있다.
const socket = process.env.HOMELAB_TEST_PG_SOCKET;
const skip = socket ? false : 'HOMELAB_TEST_PG_SOCKET 없음(로컬 PostgreSQL 필요)';
const documents: DocumentSource = { check: async () => 'verified' };
const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
const entry = (memoryId: string) => ({ memoryId, createdAt: 1, deletedAt: 2 });
const reason = (expected: string) => (error: unknown) => {
  assert.ok(error instanceof LedgerError, String(error));
  assert.equal(error.reason, expected);
  return true;
};
const ledgers: FileDeletionLedger[] = [];
const dirs: string[] = [];
let admin: pg.Pool | undefined;

async function setup() {
  admin ??= new pg.Pool({ host: socket, user: 'postgres', database: 'postgres', max: 1 });
  const name = `t20_ledger_${randomUUID().replaceAll('-', '').slice(0, 12)}`;
  await admin.query(`CREATE DATABASE ${name}`);
  const pool = new pg.Pool({ host: socket, user: 'postgres', database: name, max: 4 });
  const db = new Postgres(pool);
  await migrate(db);
  const make = (dir: string, extra: Partial<FileLedgerOptions> = {}) => {
    const ledger = new FileDeletionLedger({ dir, db,
      lock: advisoryLedgerLock(lockClient({ host: socket, user: 'postgres', database: name, application_name: 'ledger-lock-test' })), ...extra });
    ledgers.push(ledger);
    return ledger;
  };
  const lockHolders = async () => (await admin!.query<{ pid: number }>(
    "SELECT pid FROM pg_locks l JOIN pg_database d ON d.oid=l.database WHERE l.locktype='advisory' AND l.granted AND d.datname=$1", [name])).rows;
  return { name, pool, db, make, lockHolders, close: async () => {
    for (const ledger of ledgers.splice(0)) await ledger.close().catch(() => {});
    await pool.end();
    for (let attempt = 0; ; attempt++) {
      try { await admin!.query(`DROP DATABASE ${name}`); break; } catch (error) {
        if (attempt >= 50 || !/being accessed by other users/.test((error as Error).message)) throw error;
        await sleep(100);
      }
    }
  } };
}
async function ledgerDir(prefix: string, generation?: string) {
  const made = await initLedger(prefix, generation ? { generation } : {});
  dirs.push(made.dir);
  return made;
}
before(async () => { await mkdir('.local', { recursive: true }); });
afterEach(async () => { for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true }); });
after(async () => { await admin?.end(); });

test('DATA-02 [T20 원장 PG] 두 번째 작성자(다른 연결)는 같은 원장을 열지 못하고, 첫째가 닫힌 뒤에만 열림', { skip }, async () => {
  const env = await setup();
  try {
    const shared = await ledgerDir('ledger-pg-lock');
    // 끊긴 꼬리가 있는 원장. 잠금 없이 열면 이 조각을 잘라낼 수 있다.
    await writeFile(shared.file, `${JSON.stringify(entry('a'))}\n{"memoryId":"torn`);
    const first = env.make(shared.dir);
    await first.open();
    assert.equal((await env.lockHolders()).length, 1);
    const second = env.make(shared.dir);
    await assert.rejects(second.open(), reason('lock_held'));
    assert.deepEqual([second.status().state, second.status().failure?.stage], ['failed', 'lock']);
    assert.match(await readFile(shared.file, 'utf8'), /torn$/);
    // 잠금은 DB 단위다. 다른 디렉터리를 가리켜도 같은 DB의 두 번째 작성자는 거부된다.
    const elsewhere = env.make((await ledgerDir('ledger-pg-other')).dir);
    await assert.rejects(elsewhere.open(), reason('lock_held'));
    await first.append(entry('b'));
    await first.close();
    assert.equal((await env.lockHolders()).length, 0);
    await second.open();
    assert.deepEqual((await second.entries()).map(e => e.memoryId), ['a', 'b']);
  } finally { await env.close(); }
});

test('DATA-02 [T20 원장 PG] 잠금 연결이 끊기면 즉시 fenced, 이후 append·재적용이 실패하고 삭제는 미완료', { skip }, async () => {
  const env = await setup();
  try {
    const { dir } = await ledgerDir('ledger-pg-fence');
    const f = await fixture(env.db);
    const ledger = env.make(dir);
    const memory = new MemoryService(env.db, f.gate, ledger, documents, f.now);
    await memory.open();
    const stored = await memory.remember('fixture-owner', thread, { kind: 'configuration', statement: '잠금 끊김 뒤 지울 기억',
      sources: [{ type: 'document', uri: 'repo://allowed/x.md', revision: 'r1' }], observedAt: f.now(), recheckAt: f.now() + 1000 });
    const [holder] = await env.lockHolders();
    await admin!.query('SELECT pg_terminate_backend($1)', [holder!.pid]);
    for (let i = 0; i < 50 && ledger.status().state !== 'fenced'; i++) await sleep(20);
    assert.deepEqual([ledger.status().state, ledger.status().failure?.reason], ['fenced', 'fenced']);
    await assert.rejects(ledger.append(entry('x')), reason('fenced'));
    assert.equal(await ledger.durable(), false);
    const result = await memory.delete('fixture-owner', thread, stored.id);
    assert.deepEqual([result.status, result.reason], ['pending', 'ledger_unconfirmed']);
    assert.equal(await readFile(`${dir}/deletions.jsonl`, 'utf8'), '');
    // 잠금을 잃은 인스턴스는 다시 열지 않는다. 새 인스턴스(재기동)는 다시 잡을 수 있다.
    await assert.rejects(ledger.open(), reason('fenced'));
    const restarted = env.make(dir);
    await restarted.open();
    assert.equal(restarted.status().state, 'ready');
  } finally { await env.close(); }
});

test('DATA-02 [T20 원장 PG] append 직전 확인: 끊김 이벤트를 받기 전에 써도 잠금 연결이 죽었으면 쓰지 않음', { skip }, async () => {
  const env = await setup();
  try {
    const { dir, file } = await ledgerDir('ledger-pg-verify');
    // 끊김 이벤트(error·end)를 전달하지 않는 연결. 그러면 쓰기 직전의 왕복 확인만이 끊김을 알 수 있다.
    const connect = lockClient({ host: socket, user: 'postgres', database: env.name });
    const silent = async (): Promise<LockClient> => {
      const client = await connect();
      return { query: (sql, params) => client.query(sql, params), on: () => client, end: () => client.end() };
    };
    const ledger = env.make(dir, { lock: advisoryLedgerLock(silent) });
    await ledger.open();
    const [holder] = await env.lockHolders();
    await admin!.query('SELECT pg_terminate_backend($1)', [holder!.pid]);
    await sleep(200);
    assert.equal(ledger.status().state, 'ready');
    await assert.rejects(ledger.append(entry('x')), reason('fenced'));
    assert.equal(ledger.status().state, 'fenced');
    assert.equal(await readFile(file, 'utf8'), '');
  } finally { await env.close(); }
});

test('DATA-02 [T20 원장 PG] 세대: 첫 open이 묶고, 다른 세대는 거부, 운영자가 그 세대를 명시할 때만 바꾸고 감사 기록', { skip }, async () => {
  const env = await setup();
  try {
    const original = await ledgerDir('ledger-pg-gen-a');
    const replaced = await ledgerDir('ledger-pg-gen-b');
    const generation = async () => (await env.pool.query('SELECT generation FROM deletion_ledger_generation')).rows.map(r => r.generation);
    const audits = async () => (await env.pool.query<{ kind: string; detail: unknown }>(
      "SELECT kind,detail FROM audit WHERE subject='deletion_ledger' ORDER BY id")).rows;
    const first = env.make(original.dir);
    await first.open();
    assert.deepEqual(await generation(), [original.generation]);
    await first.close();
    // SSD 교체·재초기화·다른 디스크: 표식 세대가 다르면 열지 않고 묶음도 그대로다.
    const other = env.make(replaced.dir);
    await assert.rejects(other.open(), reason('generation_mismatch'));
    assert.deepEqual([other.status().failure?.stage, (await env.lockHolders()).length], ['generation', 0]);
    await assert.rejects(env.make(replaced.dir, { acceptGeneration: original.generation }).open(), reason('generation_accept_mismatch'));
    assert.deepEqual(await generation(), [original.generation]);
    const accepted = env.make(replaced.dir, { acceptGeneration: replaced.generation });
    await accepted.open();
    assert.deepEqual(await generation(), [replaced.generation]);
    assert.deepEqual(await audits(), [
      { kind: 'memory_ledger_generation_bound', detail: { generation: original.generation } },
      { kind: 'memory_ledger_generation_accepted', detail: { from: original.generation, to: replaced.generation } },
    ]);
    await accepted.close();
    // 옛 디스크로 되돌리면 이번에는 그쪽이 거부된다. 같은 세대의 수용 입력이 남아 있어도 해가 없다.
    await assert.rejects(env.make(original.dir).open(), reason('generation_mismatch'));
    const again = env.make(replaced.dir, { acceptGeneration: replaced.generation });
    await again.open();
    assert.equal((await audits()).length, 2);
  } finally { await env.close(); }
});
