import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import { PGlite } from '@electric-sql/pglite';
import type { Database } from '../src/database.js';
import { MIGRATIONS, migrate, migrationVersion } from '../src/database.js';
import { Store } from '../src/store.js';
import { thread } from './helpers.js';

// migrate()는 마이그레이션 파일을 매개변수 없는 질의 한 번으로 보낸다(여러 문장, BEGIN·COMMIT 포함).
// PGlite의 query()는 확장 프로토콜이라 여러 문장을 못 받으므로 그때만 exec()로 보낸다.
function migrationDatabase(pg: PGlite): Database {
  const db: Database = {
    query: async <T>(sql: string, params: unknown[] = []) => params.length
      ? pg.query<T>(sql, params)
      : { rows: ((await pg.exec(sql)).at(-1)?.rows ?? []) as T[] },
    transaction: fn => pg.transaction(tx => fn({ query: (sql, params = []) => tx.query(sql, params),
      transaction: () => { throw new Error('nested'); } })),
  };
  return db;
}
const versions = async (db: Database) =>
  (await db.query<{ version: number }>('SELECT version FROM schema_migrations ORDER BY version')).rows.map(r => Number(r.version));
async function pendingAlert(db: Database) {
  // 006 이후에도 범위 없는 경보 키 행이 대기할 수 있다(서비스 없는 제어 결과와 같은 모양). 006이 다시 돌면 이 행이 막힌다.
  await new Store(db, () => 1_800_000_000_000).enqueue({ key: 'alert:fixture-group:fixture-fingerprint:1', actor: 'fixture-owner',
    scope: thread, revision: 'fixture-v1', payload: { kind: 'message', channel: thread.channel, content: '경보', classification: 'safe_summary' } });
}

test('T16b 위험 5 migrate() 재실행은 적용된 버전을 건너뛰어 006이 대기 경보 전달을 다시 막지 않음', async () => {
  const pg = new PGlite();
  try {
    const db = migrationDatabase(pg);
    await migrate(db);
    assert.deepEqual(await versions(db), [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11]);
    await pendingAlert(db);
    await migrate(db);
    await migrate(db);
    const row = (await db.query<{ state: string }>('SELECT state FROM outbox')).rows[0]!;
    assert.equal(row.state, 'pending');
    assert.equal((await db.query("SELECT 1 FROM audit WHERE kind='legacy_alert_scope_missing'")).rows.length, 0);
    assert.deepEqual(await versions(db), [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11]);
  } finally { await pg.close(); }
});

test('T16b MIGRATIONS 목록은 migrations/ 디렉터리와 같고 파일마다 자기 버전을 기록', async () => {
  const files = (await readdir('migrations')).filter(name => name.endsWith('.sql')).sort();
  assert.deepEqual([...MIGRATIONS], files);
  for (const file of files) {
    const sql = await readFile(`migrations/${file}`, 'utf8');
    assert.match(sql, new RegExp(`INSERT INTO schema_migrations VALUES \\(${migrationVersion(file)}\\) ON CONFLICT DO NOTHING;\\s*COMMIT;\\s*$`), file);
  }
});

test('T16b migrate() 반환값은 이번에 적용한 버전, 다시 돌리면 빈 목록', async () => {
  const pg = new PGlite();
  try {
    const db = migrationDatabase(pg);
    assert.deepEqual(await migrate(db), [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11]);
    assert.deepEqual(await migrate(db), []);
  } finally { await pg.close(); }
});

test('T16b 기존 DB 업그레이드: 010까지 적용된 DB에 migrate()는 011만 적용하고 006을 다시 돌리지 않음', async () => {
  const pg = new PGlite();
  try {
    // 진입점 이전 방식(파일을 차례로 실행)으로 010까지 적용한 DB. 각 파일이 자기 버전을 schema_migrations에 남겼다.
    for (const file of ['001_foundation', '002_denial_revision', '003_recovery_controls', '004_delivery_services', '005_delivery_order',
      '006_alert_services', '007_execution_boundaries', '008_pr_review', '009_codex_bridge', '010_memory_briefing']) {
      await pg.exec(await readFile(`migrations/${file}.sql`, 'utf8'));
    }
    const db = migrationDatabase(pg);
    await pendingAlert(db);
    await migrate(db);
    assert.deepEqual(await versions(db), [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11]);
    assert.equal((await db.query("SELECT 1 FROM information_schema.columns WHERE table_name='outbox' AND column_name='reconcile_after'")).rows.length, 1);
    assert.equal((await db.query<{ state: string }>('SELECT state FROM outbox')).rows[0]!.state, 'pending');
    assert.equal((await db.query("SELECT 1 FROM audit WHERE kind='legacy_alert_scope_missing'")).rows.length, 0);
  } finally { await pg.close(); }
});
