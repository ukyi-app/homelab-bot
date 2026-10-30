import { readFile } from 'node:fs/promises';
import pg from 'pg';

export interface QueryResult<T> { rows: T[] }
export interface TransactionDeadline { expiresAt: number; now: () => number }
export function remaining(deadline: TransactionDeadline): number {
  const ms = Math.floor(deadline.expiresAt - deadline.now());
  if (ms <= 0) throw new Error('inbox_deadline');
  return ms;
}
export interface Database {
  query<T = Record<string, unknown>>(sql: string, params?: unknown[]): Promise<QueryResult<T>>;
  transaction<T>(fn: (tx: Database) => Promise<T>, deadline?: TransactionDeadline): Promise<T>;
}
export class Postgres implements Database {
  constructor(private readonly pool: pg.Pool) {}
  async query<T>(sql: string, params: unknown[] = []): Promise<QueryResult<T>> {
    return await this.pool.query(sql, params) as unknown as QueryResult<T>;
  }
  async transaction<T>(fn: (tx: Database) => Promise<T>, deadline?: TransactionDeadline): Promise<T> {
    const client = await this.pool.connect();
    const budget = async () => {
      if (deadline) {
        await client.query(`SET LOCAL statement_timeout = '${Math.min(1500, remaining(deadline))}ms'`);
        remaining(deadline);
      }
    };
    const tx: Database = {
      query: async <R>(sql: string, params: unknown[] = []) => {
        await budget();
        const result = await client.query(sql, params) as unknown as QueryResult<R>;
        if (deadline) remaining(deadline);
        return result;
      },
      transaction: () => { throw new Error('nested_transaction'); },
    };
    try {
      await client.query('BEGIN');
      // PostgreSQL 18 (platform contract) also bounds COMMIT and time between statements.
      if (deadline) await client.query(`SET LOCAL transaction_timeout = '${remaining(deadline)}ms'`);
      await client.query("SET LOCAL statement_timeout = '1500ms'");
      await client.query("SET LOCAL lock_timeout = '1000ms'");
      const value = await fn(tx);
      await budget();
      await client.query('COMMIT');
      return value;
    } catch (error) {
      await client.query('ROLLBACK').catch(() => {});
      throw error;
    } finally { client.release(); }
  }
}
// 파일마다 자기 버전을 같은 transaction 안에서 schema_migrations에 남긴다. 새 파일은 이 목록에도 더한다
// (시험이 디렉터리와 대조한다).
export const MIGRATIONS = Object.freeze(['001_foundation.sql', '002_denial_revision.sql', '003_recovery_controls.sql',
  '004_delivery_services.sql', '005_delivery_order.sql', '006_alert_services.sql', '007_execution_boundaries.sql',
  '008_pr_review.sql', '009_codex_bridge.sql', '010_memory_briefing.sql', '011_reconcile_backoff.sql']);
export const migrationVersion = (file: string) => Number.parseInt(file.slice(0, 3), 10);
export async function appliedMigrations(db: Database): Promise<Set<number>> {
  const table = (await db.query<{ name: string | null }>("SELECT to_regclass('schema_migrations')::text AS name")).rows[0];
  if (!table?.name) return new Set();
  return new Set((await db.query<{ version: number }>('SELECT version FROM schema_migrations')).rows.map(r => Number(r.version)));
}
// 차트의 마이그레이션 Job은 매 sync마다 돈다(D-22). 적용된 버전은 건너뛴다. 006처럼 데이터를 바꾸는 파일이
// 다시 돌면 그 순간 대기 중인 전달을 막는다(T16b 위험 5). 반환값은 이번에 적용한 버전이다.
export async function migrate(db: Database): Promise<number[]> {
  const applied = await appliedMigrations(db);
  const ran: number[] = [];
  for (const file of MIGRATIONS) {
    const version = migrationVersion(file);
    if (applied.has(version)) continue;
    await db.query(await readFile(new URL(`../../migrations/${file}`, import.meta.url), 'utf8'));
    ran.push(version);
  }
  return ran;
}
