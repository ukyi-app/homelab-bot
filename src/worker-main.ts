import { execFile } from 'node:child_process';
import { createPublicKey } from 'node:crypto';
import type { KeyObject } from 'node:crypto';
import { realpathSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import type { Server } from 'node:http';
import { tmpdir } from 'node:os';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { once } from 'node:events';
import { pathToFileURL } from 'node:url';
import { promisify } from 'node:util';
import { ChatLane } from './codex-chat.js';
import { assertWorkerRoot } from './codex-config.js';
import { ProcessGroupLauncher } from './codex-process.js';
import { CODEX_CAPABILITIES } from './codex.js';
import type { CodexLauncher } from './codex.js';
import { PORTS } from './http.js';
import { SerialWorker, WorkerVerifier } from './worker.js';
import { workerServer } from './worker-http.js';
import { FileNonceStore, WorkerStartError, assertNotPersonal, humanHomes, seedAuth } from './worker-state.js';

// 작업자 진입점(ns sandbox 상주 파드, D-15). 게시 서버와 같은 이미지이고 sandbox가 command만 이 파일로 바꾼다(D2).
// 기동 순서: env 확인 → codex 버전 확인 → 시드 복사(없을 때만) → nonce 저장소 → 8080 수신.
// 어느 단계든 실패하면 값 없이 사유 코드만 남기고 종료 코드 1로 끝난다.

// 시드는 Secret 볼륨 파일 `<WORKER_SEED_DIR>/<WORKER_SEED_KEY>`다. 키 이름은 Infisical 키 그대로(CODEX_AUTH_JSON).
export const WORKER_ENV = ['CODEX_HOME', 'WORKER_SEED_DIR', 'WORKER_SEED_KEY', 'WORKER_NONCE_DIR', 'WORKER_CONTROL_PUBLIC_KEY'] as const;
export const DEFAULT_CODEX_BIN = '/usr/local/bin/codex';
export interface WorkerConfig {
  codexHome: string; seedFile: string; nonceDir: string; publicKey: KeyObject; codexBin: string;
  proxy?: { https: string; noProxy: string };
}

export function workerConfig(env: Record<string, string | undefined>): WorkerConfig {
  const missing = WORKER_ENV.filter(name => !env[name]?.trim());
  // 이름만 알린다. 값은 어떤 경우에도 로그에 남기지 않는다.
  if (missing.length) throw new WorkerStartError(`config_missing:${missing.join(',')}`);
  const value = (name: typeof WORKER_ENV[number]) => env[name]!.trim();
  const absolute = (name: string, path: string) => {
    if (!isAbsolute(path)) throw new WorkerStartError(`config_invalid:${name}`);
    return resolve(path);
  };
  const codexHome = absolute('CODEX_HOME', value('CODEX_HOME'));
  const seedDir = absolute('WORKER_SEED_DIR', value('WORKER_SEED_DIR'));
  const nonceDir = absolute('WORKER_NONCE_DIR', value('WORKER_NONCE_DIR'));
  if (!/^[A-Za-z0-9_][A-Za-z0-9_.-]*$/.test(value('WORKER_SEED_KEY'))) throw new WorkerStartError('config_invalid:WORKER_SEED_KEY');
  // nonce는 CODEX_HOME 자체가 아닌 별도 디렉터리에 둔다(D3).
  if (nonceDir === codexHome) throw new WorkerStartError('config_invalid:WORKER_NONCE_DIR');
  let publicKey: KeyObject;
  // PEM(SPKI) Ed25519 공개 키. 한 줄로 넣은 값의 `\n`도 받는다. 파싱 오류 메시지는 내지 않는다.
  const pem = value('WORKER_CONTROL_PUBLIC_KEY').replace(/\\n/g, '\n');
  // createPublicKey는 개인 키를 받아도 공개 키를 뽑아 준다. 작업자에는 공개 키만 둔다(D3, 설계 C.8 "모델 자격 하나").
  if (/PRIVATE KEY/.test(pem)) throw new WorkerStartError('config_invalid:WORKER_CONTROL_PUBLIC_KEY');
  try { publicKey = createPublicKey(pem); }
  catch { throw new WorkerStartError('config_invalid:WORKER_CONTROL_PUBLIC_KEY'); }
  if (publicKey.asymmetricKeyType !== 'ed25519') throw new WorkerStartError('config_invalid:WORKER_CONTROL_PUBLIC_KEY');
  const codexBin = absolute('WORKER_CODEX_BIN', env.WORKER_CODEX_BIN?.trim() || DEFAULT_CODEX_BIN);
  // 플랫폼이 넣는 egress 프록시(sandbox values). codex 프로세스에만 넘기고 모델 셸에는 넘기지 않는다.
  const https = env.HTTPS_PROXY?.trim();
  const proxy = https ? { https, noProxy: env.NO_PROXY?.trim() || '127.0.0.1,localhost' } : undefined;
  return { codexHome, seedFile: join(seedDir, value('WORKER_SEED_KEY')), nonceDir, publicKey, codexBin, ...(proxy ? { proxy } : {}) };
}

const run = promisify(execFile);
// `codex --version`만 부른다(모델 호출 없음). 빈 임시 HOME·CODEX_HOME으로 돌려 영속 공간을 건드리지 않는다.
export async function codexVersion(bin: string): Promise<string> {
  const scratch = await mkdtemp(join(tmpdir(), 'homelab-codex-version-'));
  try {
    const { stdout } = await run(bin, ['--version'], { timeout: 15_000, maxBuffer: 64 * 1024,
      env: { PATH: '/usr/local/bin:/usr/bin:/bin', HOME: scratch, CODEX_HOME: scratch, LANG: 'C.UTF-8' } });
    const version = /^codex-cli (\S+)\s*$/m.exec(stdout)?.[1];
    if (!version) throw new Error();
    return version;
  } catch { throw new WorkerStartError('codex_version_unavailable'); }
  finally { await rm(scratch, { recursive: true, force: true }).catch(() => {}); }
}

export interface RunningWorker { server: Server; seed: 'seeded' | 'kept'; close(): Promise<void> }
export async function startWorker(config: WorkerConfig,
  options: { port?: number; host?: string; launcher?: CodexLauncher; homes?: string[] } = {}): Promise<RunningWorker> {
  const homes = options.homes ?? humanHomes();
  let codexHome: string;
  try { codexHome = assertWorkerRoot(config.codexHome, homes); } catch { throw new WorkerStartError('codex_home_unavailable'); }
  assertNotPersonal('WORKER_SEED_DIR', dirname(config.seedFile), homes);
  assertNotPersonal('WORKER_NONCE_DIR', config.nonceDir, homes);
  if (await codexVersion(config.codexBin) !== CODEX_CAPABILITIES.version) throw new WorkerStartError('codex_version_mismatch');
  const seed = await seedAuth(codexHome, config.seedFile, { homes });
  const nonces = new FileNonceStore(config.nonceDir);
  await nonces.open();
  const chat = new ChatLane(codexHome, options.launcher ?? new ProcessGroupLauncher([config.codexBin]),
    { homes, ...(config.proxy ? { proxy: config.proxy } : {}) });
  const verifier = new WorkerVerifier(config.publicKey, nonce => nonces.consume(nonce));
  const worker = new SerialWorker(verifier, (request, signal) => chat.run(request, signal), request => chat.stop(request));
  // 종료가 시작되면 새 실행 요청은 실행 전에 거부한다(취소는 계속 받는다).
  const server = workerServer(worker, () => chat.ready(), () => chat.accepting());
  server.listen(options.port ?? PORTS.worker, options.host);
  await once(server, 'listening');
  return { server, seed, async close() {
    // 먼저 새 실행을 닫는다(동기). 이미 받은 요청이 본문 수신·서명 확인 중이어도 이 뒤에는 codex를 띄우지 않는다(r1 P2).
    // 그다음 새 연결을 받지 않고, 실행 중인 codex를 멈춘 뒤 그 요청의 응답(failed)을 보내고 닫는다.
    // 연결을 먼저 끊으면 게시 서버는 결과를 몰라 unknown으로 둔다.
    const stopping = chat.shutdown();
    const closed = new Promise<void>(resolve => server.close(() => resolve()));
    server.closeIdleConnections();
    await stopping;
    await Promise.race([closed, new Promise(resolve => { setTimeout(resolve, 3000).unref(); })]);
    server.closeAllConnections();
    await closed;
  } };
}

const log = (fields: Record<string, unknown>) => { process.stdout.write(`${JSON.stringify({ component: 'worker', ...fields })}\n`); };

export async function main(env: Record<string, string | undefined> = process.env): Promise<void> {
  let worker: RunningWorker;
  try {
    worker = await startWorker(workerConfig(env));
  } catch (error) {
    // 예상한 사유는 코드만, 그 밖은 오류 종류 이름만 남긴다. 메시지에는 입력 조각이 실릴 수 있다.
    const reason = error instanceof WorkerStartError ? error.code
      : `unexpected:${(error as { code?: unknown }).code ?? (error as Error)?.name ?? 'unknown'}`;
    log({ level: 'error', event: 'worker_start_failed', reason });
    process.exitCode = 1;
    return;
  }
  log({ level: 'info', event: 'worker_started', port: (worker.server.address() as { port?: number } | null)?.port, seed: worker.seed,
    codex: CODEX_CAPABILITIES.version });
  let stopping = false;
  const stop = (signal: string) => {
    if (stopping) return;
    stopping = true;
    log({ level: 'info', event: 'worker_stopping', signal });
    // 정리가 걸려도 kubelet의 유예(기본 30초) 안에 끝낸다.
    const force = setTimeout(() => process.exit(1), 20_000);
    force.unref();
    worker.close().then(() => process.exit(0), () => process.exit(1));
  };
  // 컨테이너에서 node가 PID 1이면 기본 SIGTERM 동작이 없다. 직접 받아 끝낸다.
  process.on('SIGTERM', () => stop('SIGTERM'));
  process.on('SIGINT', () => stop('SIGINT'));
}

const entry = process.argv[1];
if (entry && import.meta.url === pathToFileURL(realpathSync(entry)).href) void main();
