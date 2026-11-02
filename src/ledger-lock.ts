import pg from 'pg';
import { LedgerError, errnoCode } from './deletion-ledger.js';

// 삭제 원장의 단일 작성자 보장. Recreate 배포만으로는 수동 파드 삭제·종료 중 겹침을 막지 못한다.
export interface LedgerLease {
  // 잠금 연결이 살아 있는지 왕복으로 확인한다. 끊겼으면 fenced 오류를 던진다.
  verify(): Promise<void>;
  release(): Promise<void>;
}
// onLost는 잠금 연결의 error·end에서 한 번 불린다. 그 순간부터 원장 쓰기를 멈춰야 한다.
export type LedgerLockSource = (onLost: (error: unknown) => void) => Promise<LedgerLease>;
export interface LockClient {
  query(sql: string, params?: unknown[]): Promise<{ rows: Record<string, unknown>[] }>;
  on(event: 'error', listener: (error: Error) => void): unknown;
  on(event: 'end', listener: () => void): unknown;
  end(): Promise<void>;
}
// 고정 키('hbledger'의 ASCII). int4 범위 밖이라 hashtext로 만든 다른 advisory lock(migrate, memory-*)과 겹치지 않는다.
export const LEDGER_LOCK_KEY = '7522537965574358386';

// 풀이 아닌 전용 연결을 쓴다. 세션 잠금은 그 연결이 살아 있는 동안만 유효하고, 풀은 연결을 돌려쓰거나 닫는다.
// keepAlive: 조용히 끊긴 네트워크에서도 쉬는 잠금 연결의 끊김이 error·end로 드러나게 한다(쓰기 직전 확인과 별도).
export function lockClient(config: pg.ClientConfig): () => Promise<LockClient> {
  return async () => {
    const client = new pg.Client({ keepAlive: true, ...config });
    // 연결 중 오류가 처리기 없이 올라와 프로세스를 죽이지 않게 한다. 연결 뒤의 처리기는 잠금이 단다.
    client.on('error', () => {});
    try { await client.connect(); } catch (error) { await client.end().catch(() => {}); throw error; }
    return client as unknown as LockClient;
  };
}

export function advisoryLedgerLock(connect: () => Promise<LockClient>, options: { verifyTimeoutMs?: number } = {}): LedgerLockSource {
  const timeout = options.verifyTimeoutMs ?? 5000;
  return async onLost => {
    let client: LockClient;
    try { client = await connect(); } catch (error) { throw new LedgerError('lock_unavailable', 'lock', errnoCode(error)); }
    let released = false;
    let lost = false;
    const lose = (error: unknown) => {
      if (released || lost) return;
      lost = true;
      onLost(error);
      void client.end().catch(() => {});
    };
    client.on('error', error => lose(error));
    client.on('end', () => lose(new Error('lock_connection_ended')));
    let pid: unknown;
    try {
      // 서버의 idle_session_timeout이 쉬는 잠금 연결을 끊어 원장을 멈추지 않게 한다.
      await client.query('SET idle_session_timeout = 0');
      const row = (await client.query('SELECT pg_try_advisory_lock($1::bigint) AS ok, pg_backend_pid() AS pid', [LEDGER_LOCK_KEY])).rows[0];
      // 못 잡으면 다른 프로세스가 원장을 쓰고 있다. 기다리지 않는다(옛 파드가 끝나기 전 새 파드가 같이 쓰는 것을 막는다).
      if (row?.ok !== true) throw new LedgerError('lock_held', 'lock');
      pid = row.pid;
    } catch (error) {
      released = true;
      await client.end().catch(() => {});
      throw error instanceof LedgerError ? error : new LedgerError('lock_unavailable', 'lock', errnoCode(error));
    }
    return {
      verify: async () => {
        if (lost || released) throw new LedgerError('fenced', 'lock');
        let timer: NodeJS.Timeout | undefined;
        try {
          const row = (await Promise.race([client.query('SELECT pg_backend_pid() AS pid'),
            new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error('lock_verify_timeout')), timeout); })])).rows[0];
          // 같은 연결 객체가 같은 세션에 답하면 세션 잠금도 그대로다. 세션 잠금은 그 세션만 풀 수 있다.
          if (row?.pid !== pid) throw new Error('lock_session_changed');
        } catch (error) {
          lose(error);
          throw new LedgerError('fenced', 'lock', errnoCode(error));
        } finally { clearTimeout(timer); }
      },
      release: async () => {
        if (released) return;
        released = true;
        if (!lost) await client.query('SELECT pg_advisory_unlock($1::bigint)', [LEDGER_LOCK_KEY]).catch(() => {});
        await client.end().catch(() => {});
      },
    };
  };
}
