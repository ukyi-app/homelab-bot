import { pathToFileURL } from 'node:url';
import pg from 'pg';
import { ADMIN_EXIT, ADMIN_SCHEMA, AdminUsage, parseAdminArgs, runAdmin } from './admin.js';
import type { AdminReport } from './admin.js';
import { databasePoolConfig } from './config.js';
import { Postgres } from './database.js';
import { errorInfo, jsonLog } from './log.js';
import { Store } from './store.js';

// 관리 기능 진입점. `homelab bot`이 게시 서버 파드에서 `node dist/src/admin-main.js <명령> [ID]`로 부른다(셸을 거치지 않는다).
// 게시 서버 env 중 DATABASE_URL만 쓴다. 정책(RUNTIME_POLICIES)·Discord·작업자·모델 자격은 읽지 않는다.
// stdout에는 결과 JSON 한 줄만 낸다. 오류 원문은 주소·값을 담을 수 있어 stderr에 오류 이름·코드만 남긴다.
export type AdminOpen = () => Promise<{ store: Store; close: () => Promise<void> }>;

export async function executeAdmin(argv: readonly string[], open: AdminOpen, write: (line: string) => void): Promise<number> {
  let command;
  try { command = parseAdminArgs(argv); } catch (error) {
    if (!(error instanceof AdminUsage)) throw error;
    write(JSON.stringify({ schema: ADMIN_SCHEMA, command: '', result: 'usage' } satisfies AdminReport));
    return ADMIN_EXIT.usage;
  }
  let opened: Awaited<ReturnType<AdminOpen>> | undefined;
  try {
    opened = await open();
    const { code, report } = await runAdmin(opened.store, command);
    write(JSON.stringify(report));
    return code;
  } catch (error) {
    jsonLog('admin_failed', errorInfo(error));
    write(JSON.stringify({ schema: ADMIN_SCHEMA, command: argv[0] ?? '', result: 'failed' } satisfies AdminReport));
    return ADMIN_EXIT.failed;
  } finally { await opened?.close().catch(() => {}); }
}

async function main(): Promise<void> {
  const open: AdminOpen = async () => {
    const url = process.env.DATABASE_URL?.trim();
    if (!url) throw new Error('database_url_missing');
    const pool = new pg.Pool(databasePoolConfig(url, { max: 2, application_name: 'homelab-bot-admin' }));
    pool.on('error', error => jsonLog('database_pool_error', errorInfo(error)));
    return { store: new Store(new Postgres(pool)), close: () => pool.end() };
  };
  process.exitCode = await executeAdmin(process.argv.slice(2), open, line => process.stdout.write(`${line}\n`));
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) void main();
