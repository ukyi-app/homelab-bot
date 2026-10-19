import { readFile } from 'node:fs/promises';
import pg from 'pg';

export interface QueryResult<T> { rows: T[] }
export interface Database {
  query<T = Record<string, unknown>>(sql: string, params?: unknown[]): Promise<QueryResult<T>>;
  transaction<T>(fn: (tx: Database) => Promise<T>): Promise<T>;
}
export class Postgres implements Database {
  constructor(private readonly pool: pg.Pool) {}
  async query<T>(sql: string, params: unknown[] = []): Promise<QueryResult<T>> {
    return await this.pool.query(sql, params) as unknown as QueryResult<T>;
  }
  async transaction<T>(fn: (tx: Database) => Promise<T>): Promise<T> {
    const client = await this.pool.connect();
    const tx: Database = {
      query: async <R>(sql: string, params: unknown[] = []) =>
        await client.query(sql, params) as unknown as QueryResult<R>,
      transaction: () => { throw new Error('nested_transaction'); },
    };
    try {
      await client.query('BEGIN');
      await client.query("SET LOCAL statement_timeout = '1500ms'");
      await client.query("SET LOCAL lock_timeout = '1000ms'");
      const value = await fn(tx);
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
}
