import { createPublicKey } from 'node:crypto';
import type { KeyObject } from 'node:crypto';
import { realpathSync } from 'node:fs';
import type { Server } from 'node:http';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { once } from 'node:events';
import { pathToFileURL } from 'node:url';
import { ChatLane } from './chat-lane.js';
import { createExecutor, executorVersion, selectProfile } from './executor-profiles.js';
import type { ExecutorProfile } from './executor-profiles.js';
import { PORTS } from './http.js';
import { ProcessGroupLauncher } from './process-launcher.js';
import type { ProcessLauncher } from './process-launcher.js';
import { SerialWorker, WorkerVerifier } from './worker.js';
import { workerServer } from './worker-http.js';
import { FileNonceStore, WorkerStartError, assertNotPersonal, humanHomes } from './worker-state.js';

// 작업자 진입점(ns sandbox 상주 파드, D-15). 게시 서버와 같은 이미지이고 sandbox가 command만 이 파일로 바꾼다(D2).
// 기동 순서: env 확인 → 실행기 프로필 선택(실행기·자격 키·모델) → 개인 경로 거부 → 실행기 `--version` 확인 →
// 자격 준비(정적 토큰은 읽기 확인, Codex auth.json은 없을 때만 시드) → nonce 저장소 → 8080 수신.
// 어느 단계든 실패하면 값 없이 사유 코드만 남기고 종료 코드 1로 끝난다.

// 자격은 Secret 볼륨 파일 `<WORKER_CREDENTIAL_DIR>/<WORKER_CREDENTIAL_KEY>`다. 키 이름은 Infisical 키 그대로이고 인증 방식을
// 뜻한다(CLAUDE_CODE_OAUTH_TOKEN: Claude 구독 장기 토큰, CODEX_AUTH_JSON: Codex 구독 auth.json 시드).
export const WORKER_ENV = ['WORKER_EXECUTOR', 'WORKER_MODEL', 'WORKER_CREDENTIAL_DIR', 'WORKER_CREDENTIAL_KEY',
  'WORKER_NONCE_DIR', 'WORKER_CONTROL_PUBLIC_KEY'] as const;
export interface WorkerConfig {
  profile: ExecutorProfile; model: string;
  credentialFile: string; nonceDir: string; publicKey: KeyObject; executorBin: string;
  // file-mutable 자격(Codex)의 영속 홈. 그 프로필에서만 있다.
  codexHome?: string;
  proxy?: { https: string; noProxy: string };
}

export function workerConfig(env: Record<string, string | undefined>): WorkerConfig {
  const missing = WORKER_ENV.filter(name => !env[name]?.trim());
  // 이름만 알린다. 값은 어떤 경우에도 로그에 남기지 않는다.
  if (missing.length) throw new WorkerStartError(`config_missing:${missing.join(',')}`);
  const value = (name: string) => env[name]!.trim();
  const absolute = (name: string, path: string) => {
    if (!isAbsolute(path)) throw new WorkerStartError(`config_invalid:${name}`);
    return resolve(path);
  };
  const profile = selectProfile(value('WORKER_EXECUTOR'), value('WORKER_CREDENTIAL_KEY'), value('WORKER_MODEL'));
  const extra = profile.requiredEnv.filter(name => !env[name]?.trim());
  if (extra.length) throw new WorkerStartError(`config_missing:${extra.join(',')}`);
  const credentialDir = absolute('WORKER_CREDENTIAL_DIR', value('WORKER_CREDENTIAL_DIR'));
  const nonceDir = absolute('WORKER_NONCE_DIR', value('WORKER_NONCE_DIR'));
  const codexHome = profile.requiredEnv.includes('CODEX_HOME') ? absolute('CODEX_HOME', value('CODEX_HOME')) : undefined;
  // nonce는 자격 홈(CODEX_HOME) 자체가 아닌 별도 디렉터리에 둔다(D3).
  if (codexHome && nonceDir === codexHome) throw new WorkerStartError('config_invalid:WORKER_NONCE_DIR');
  let publicKey: KeyObject;
  // PEM(SPKI) Ed25519 공개 키. 한 줄로 넣은 값의 `\n`도 받는다. 파싱 오류 메시지는 내지 않는다.
  const pem = value('WORKER_CONTROL_PUBLIC_KEY').replace(/\\n/g, '\n');
  // createPublicKey는 개인 키를 받아도 공개 키를 뽑아 준다. 작업자에는 공개 키만 둔다(D3, 설계 C.8 "모델 자격 하나").
  if (/PRIVATE KEY/.test(pem)) throw new WorkerStartError('config_invalid:WORKER_CONTROL_PUBLIC_KEY');
  try { publicKey = createPublicKey(pem); }
  catch { throw new WorkerStartError('config_invalid:WORKER_CONTROL_PUBLIC_KEY'); }
  if (publicKey.asymmetricKeyType !== 'ed25519') throw new WorkerStartError('config_invalid:WORKER_CONTROL_PUBLIC_KEY');
  const executorBin = absolute('WORKER_EXECUTOR_BIN', env.WORKER_EXECUTOR_BIN?.trim() || profile.bin);
  // 플랫폼이 넣는 egress 프록시(sandbox values). 모델 CLI 프로세스에만 넘기고 모델 셸에는 넘기지 않는다.
  const https = env.HTTPS_PROXY?.trim();
  const proxy = https ? { https, noProxy: env.NO_PROXY?.trim() || '127.0.0.1,localhost' } : undefined;
  return { profile, model: value('WORKER_MODEL'), credentialFile: join(credentialDir, value('WORKER_CREDENTIAL_KEY')), nonceDir,
    publicKey, executorBin, ...(codexHome ? { codexHome } : {}), ...(proxy ? { proxy } : {}) };
}

export interface RunningWorker {
  server: Server; profile: string; cliVersion: string; credential: 'seeded' | 'kept' | 'present'; close(): Promise<void>;
}
export async function startWorker(config: WorkerConfig,
  options: { port?: number; host?: string; launcher?: ProcessLauncher; homes?: string[] } = {}): Promise<RunningWorker> {
  const homes = options.homes ?? humanHomes();
  assertNotPersonal('WORKER_CREDENTIAL_DIR', dirname(config.credentialFile), homes);
  assertNotPersonal('WORKER_NONCE_DIR', config.nonceDir, homes);
  const { adapter, credential } = createExecutor(config.profile,
    { credentialFile: config.credentialFile, ...(config.codexHome ? { codexHome: config.codexHome } : {}) }, homes);
  const cliVersion = await executorVersion(adapter, config.executorBin);
  if (cliVersion !== adapter.capabilities.cliVersion) throw new WorkerStartError('executor_version_mismatch');
  const state = await credential.open();
  const nonces = new FileNonceStore(config.nonceDir);
  await nonces.open();
  const chat = new ChatLane(adapter, credential, options.launcher ?? new ProcessGroupLauncher([config.executorBin]),
    { model: config.model, homes, ...(config.proxy ? { proxy: config.proxy } : {}) });
  const verifier = new WorkerVerifier(config.publicKey, nonce => nonces.consume(nonce));
  const worker = new SerialWorker(verifier, (request, signal) => chat.run(request, signal), request => chat.stop(request));
  // 종료가 시작되면 새 실행 요청은 실행 전에 거부한다(취소는 계속 받는다).
  const server = workerServer(worker, () => chat.ready(), () => chat.accepting());
  server.listen(options.port ?? PORTS.worker, options.host);
  await once(server, 'listening');
  return { server, profile: config.profile.id, cliVersion, credential: state, async close() {
    // 먼저 새 실행을 닫는다(동기). 이미 받은 요청이 본문 수신·서명 확인 중이어도 이 뒤에는 모델 CLI를 띄우지 않는다(r1 P2).
    // 그다음 새 연결을 받지 않고, 실행 중인 모델 CLI를 멈춘 뒤 그 요청의 응답(failed)을 보내고 닫는다.
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
  let config: WorkerConfig;
  try {
    config = workerConfig(env);
    worker = await startWorker(config);
  } catch (error) {
    // 예상한 사유는 코드만, 그 밖은 오류 종류 이름만 남긴다. 메시지에는 입력 조각이 실릴 수 있다.
    const reason = error instanceof WorkerStartError ? error.code
      : `unexpected:${(error as { code?: unknown }).code ?? (error as Error)?.name ?? 'unknown'}`;
    log({ level: 'error', event: 'worker_start_failed', reason });
    process.exitCode = 1;
    return;
  }
  // 값 없는 식별자만 남긴다: 프로필·실행기 버전·모델 ID·자격 상태(seeded/kept/present).
  log({ level: 'info', event: 'worker_started', port: (worker.server.address() as { port?: number } | null)?.port,
    profile: worker.profile, cli: worker.cliVersion, model: config.model, credential: worker.credential });
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
