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
export async function migrate(db: Database): Promise<void> {
  await db.query(await readFile(new URL('../../migrations/001_foundation.sql', import.meta.url), 'utf8'));
  await db.query(await readFile(new URL('../../migrations/002_denial_revision.sql', import.meta.url), 'utf8'));
  await db.query(await readFile(new URL('../../migrations/003_recovery_controls.sql', import.meta.url), 'utf8'));
  await db.query(await readFile(new URL('../../migrations/004_delivery_services.sql', import.meta.url), 'utf8'));
  await db.query(await readFile(new URL('../../migrations/005_delivery_order.sql', import.meta.url), 'utf8'));
  await db.query(await readFile(new URL('../../migrations/006_alert_services.sql', import.meta.url), 'utf8'));
  await db.query(await readFile(new URL('../../migrations/007_execution_boundaries.sql', import.meta.url), 'utf8'));
  await db.query(await readFile(new URL('../../migrations/008_pr_review.sql', import.meta.url), 'utf8'));
  await db.query(await readFile(new URL('../../migrations/010_memory_briefing.sql', import.meta.url), 'utf8'));
}
