import { pathToFileURL } from 'node:url';
import pg from 'pg';
import { databasePoolConfig } from './config.js';
import { migrate } from './database.js';
import type { Database, QueryResult } from './database.js';
import { errorInfo, jsonLog } from './log.js';

// 마이그레이션 진입점. 차트 migration.command: ["node", "dist/src/migrate-main.js"]. Sync hook Job이 매 sync마다 돈다(D-22).
// Job에는 앱의 env가 모두 들어오지만 DATABASE_URL만 쓴다. 다른 키가 없어도 돈다.
const LOCK = 'homelab-bot:migrate';
export async function runMigrations(pool: pg.Pool): Promise<number[]> {
  // 세션 advisory lock은 같은 연결에서만 풀린다. 연결 하나를 잡고 그 위에서 끝까지 돈다.
  const client = await pool.connect();
  try {
    // 기존 파드가 쓰는 표를 ALTER할 때 잠금을 오래 기다리며 그 파드를 막지 않게 짧게 실패한다(Job이 다시 돈다).
    await client.query("SET lock_timeout = '5s'");
    await client.query("SET statement_timeout = '60s'");
    await client.query('SELECT pg_advisory_lock(hashtext($1))', [LOCK]);
    try {
      const db: Database = {
        query: async <T>(sql: string, params: unknown[] = []) => await client.query(sql, params) as unknown as QueryResult<T>,
        transaction: () => { throw new Error('nested_transaction'); },
      };
      return await migrate(db);
    } finally { await client.query('SELECT pg_advisory_unlock(hashtext($1))', [LOCK]).catch(() => {}); }
  } finally { client.release(); }
}
async function main(): Promise<void> {
  const url = process.env.DATABASE_URL?.trim();
  if (!url) { jsonLog('config_invalid', { problems: ['DATABASE_URL(missing)'] }); process.exitCode = 1; return; }
  const pool = new pg.Pool(databasePoolConfig(url, { max: 1, statement_timeout: 60_000 }));
  pool.on('error', error => jsonLog('database_pool_error', errorInfo(error)));
  try {
    const applied = await runMigrations(pool);
    jsonLog('migrations_applied', { versions: applied });
  } catch (error) {
    jsonLog('migrations_failed', errorInfo(error));
    process.exitCode = 1;
  } finally { await pool.end().catch(() => {}); }
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) void main();
