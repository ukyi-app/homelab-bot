import { pathToFileURL } from 'node:url';
import pg from 'pg';
import { ADMIN_EXIT, ADMIN_SCHEMA, AdminUsage, parseAdminArgs, runAdmin } from './admin.js';
import type { AdminCommand, AdminPorts, AdminReport } from './admin.js';
import { ClaudeTaskBridge } from './claude-task-bridge.js';
import { databasePoolConfig, loadPublisherConfig } from './config.js';
import type { Clock } from './contracts.js';
import { Postgres } from './database.js';
import { errorInfo } from './log.js';
import { taskPrecondition } from './main.js';
import { PolicyGate, loadRuntimePolicy } from './policy.js';
import { Store } from './store.js';
import { TaskWorkerSigner } from './task-contracts.js';
import { HttpTaskV2Worker, HttpTaskWorker } from './task-http.js';
import { PolicyTaskPlans } from './task-policy.js';

// 관리 기능 진입점. `homelab bot`이 게시 서버 파드에서 `node dist/src/admin-main.js <명령> [ID]`로 부른다(셸을 거치지 않는다).
// 비상 정지·해제·상태 보기·멈춘 작업 재개는 게시 서버 env 중 DATABASE_URL만 쓴다. 정책을 읽지 못하는 때에도 비상 정지가 되어야 해서다.
// 차단과 unknown 해제만 그 동작일 때 정책·작업자 설정을 더 읽는다(adminPorts). Discord·모델 자격은 읽지 않는다.
// stdout에는 결과 JSON 한 줄만 낸다. 오류 원문은 주소·값을 담을 수 있어 stderr에 오류 이름·코드만 남긴다.
export type AdminOpen = (command: AdminCommand) => Promise<{ store: Store; close: () => Promise<void>; ports?: AdminPorts }>;
// jsonLog는 stdout에 쓰므로 여기서는 쓰지 않는다. 호출자는 stdout 첫 줄을 결과로 읽는다.
const errorLog = (event: string, detail: Record<string, unknown>) =>
  process.stderr.write(`${JSON.stringify({ time: new Date().toISOString(), event, ...detail })}\n`);

// 차단은 env RUNTIME_POLICIES만 읽어 거부 행의 revision을 적는다. unknown 해제는 게시 서버와 같은 규칙으로 설정 전체를 읽어
// 작업 레인 스위치·작업자 주소·서명 키로 같은 작업 브리지를 만든다. 읽지 못하면 던져 아무것도 바꾸지 않는다(닫힘).
// 작업 레인이 닫힌 배치는 브리지가 없어 runAdmin이 실패로 답한다. 게시 서버도 그때는 '/task-release'를 받지 않는다.
export function adminPorts(command: AdminCommand, env: Readonly<Record<string, string | undefined>>, store: Store,
  now: Clock = Date.now, send: typeof fetch = fetch): AdminPorts {
  if (command.name === 'block') return { gate: PolicyGate.fixed(loadRuntimePolicy(env.RUNTIME_POLICIES ?? '', now()), store.db, now) };
  if (command.name !== 'release') return {};
  const config = loadPublisherConfig(env, now());
  const lane = taskPrecondition(config);
  if (!lane.open) return {};
  const signer = new TaskWorkerSigner(config.workerKey, now);
  return { releasers: [new ClaudeTaskBridge(store, PolicyGate.fixed(config.policy, store.db, now),
    new HttpTaskWorker(lane.workerUrl, signer, send), new PolicyTaskPlans(store, send), {}, new HttpTaskV2Worker(lane.workerUrl, signer, send))] };
}

export async function executeAdmin(argv: readonly string[], open: AdminOpen, write: (line: string) => void): Promise<number> {
  let command;
  try { command = parseAdminArgs(argv); } catch (error) {
    if (!(error instanceof AdminUsage)) throw error;
    write(JSON.stringify({ schema: ADMIN_SCHEMA, command: '', result: 'usage' } satisfies AdminReport));
    return ADMIN_EXIT.usage;
  }
  let opened: Awaited<ReturnType<AdminOpen>> | undefined;
  try {
    opened = await open(command);
    const { code, report } = await runAdmin(opened.store, command, opened.ports);
    write(JSON.stringify(report));
    return code;
  } catch (error) {
    errorLog('admin_failed', errorInfo(error));
    write(JSON.stringify({ schema: ADMIN_SCHEMA, command: argv[0] ?? '', result: 'failed' } satisfies AdminReport));
    return ADMIN_EXIT.failed;
  } finally { await opened?.close().catch(() => {}); }
}

async function main(): Promise<void> {
  const open: AdminOpen = async command => {
    const url = process.env.DATABASE_URL?.trim();
    if (!url) throw new Error('database_url_missing');
    const pool = new pg.Pool(databasePoolConfig(url, { max: 2, application_name: 'homelab-bot-admin' }));
    pool.on('error', error => errorLog('database_pool_error', errorInfo(error)));
    const store = new Store(new Postgres(pool));
    try { return { store, close: () => pool.end(), ports: adminPorts(command, process.env, store) }; }
    catch (error) { await pool.end().catch(() => {}); throw error; }
  };
  process.exitCode = await executeAdmin(process.argv.slice(2), open, line => process.stdout.write(`${line}\n`));
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) void main();
