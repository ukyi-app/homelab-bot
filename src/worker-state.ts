import { randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import type { FileHandle } from 'node:fs/promises';
import { lstat, mkdir, open, readdir, rename, rm, stat } from 'node:fs/promises';
import { isAbsolute, join } from 'node:path';
import { DEFAULTS } from './contracts.js';
import type { Clock } from './contracts.js';

// 작업자 영속 공간(PVC)의 상태: 모델 자격 시드 복사(D-14 조건 4)와 capability nonce 저장소(D3).

// 기동 실패 사유. 값(시드 내용, 토큰)은 담지 않는다. 진입점은 이 code만 로그에 남긴다.
export class WorkerStartError extends Error {
  constructor(public readonly code: string) { super(code); }
}
const SEED_LIMIT = 1024 * 1024;
const NOFOLLOW_NEW = constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW;

// 구독 로그인 auth.json의 최소 모양. tokens.refresh_token이 없으면 갱신할 수 없어 쓸모가 없다.
// 필드 이름은 0.163.0 바이너리 문자열과 `codex login` 결과 모양 [가정: 전체 스키마는 공식 문서에 없음].
function plausibleAuth(text: string): boolean {
  let value: unknown;
  // JSON.parse 오류 메시지에는 입력 일부가 들어간다. 오류를 밖으로 내지 않는다.
  try { value = JSON.parse(text); } catch { return false; }
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const tokens = (value as { tokens?: unknown }).tokens;
  if (typeof tokens !== 'object' || tokens === null) return false;
  const refresh = (tokens as { refresh_token?: unknown }).refresh_token;
  return typeof refresh === 'string' && refresh.trim().length > 0;
}

async function readSeed(path: string): Promise<Buffer> {
  // Secret 볼륨 파일은 kubelet이 만든 심링크(..data/키)라 O_NOFOLLOW로 열지 않는다. 연 뒤 일반 파일인지 본다.
  let handle: FileHandle;
  try { handle = await open(path, constants.O_RDONLY | constants.O_NONBLOCK); }
  catch (error) { throw new WorkerStartError((error as { code?: string }).code === 'ENOENT' ? 'seed_missing' : 'seed_unreadable'); }
  try {
    const info = await handle.stat();
    if (!info.isFile()) throw new WorkerStartError('seed_unreadable');
    if (info.size === 0) throw new WorkerStartError('seed_invalid');
    if (info.size > SEED_LIMIT) throw new WorkerStartError('seed_invalid');
    const data = await handle.readFile();
    if (data.length > SEED_LIMIT) throw new WorkerStartError('seed_invalid');
    return data;
  } catch (error) {
    if (error instanceof WorkerStartError) throw error;
    throw new WorkerStartError('seed_unreadable');
  } finally { await handle.close().catch(() => {}); }
}

// CODEX_HOME/auth.json이 없을 때만 시드를 복사한다. 있으면 내용·권한 모두 손대지 않는다.
// Codex가 갱신한 auth.json을 옛 시드로 덮으면 회전된 갱신 토큰과 어긋나 사람이 다시 시드해야 한다(D-14).
// 원자성: 같은 디렉터리의 임시 파일(0600)에 쓰고 fsync한 뒤 rename한다. 중간에 죽어도 반쯤 쓴 auth.json은 없다.
// rename은 덮어쓰므로 "없을 때만"은 확인 시점 기준이다. 기동 중에는 codex가 돌지 않고 작업자는 replicas 1·Recreate라
// 확인과 rename 사이에 auth.json을 만들 다른 쓰기 주체가 없다.
export async function seedAuth(codexHome: string, seedFile: string): Promise<'seeded' | 'kept'> {
  if (!isAbsolute(codexHome) || !isAbsolute(seedFile)) throw new WorkerStartError('config_invalid');
  try { if (!(await stat(codexHome)).isDirectory()) throw new Error(); }
  catch { throw new WorkerStartError('codex_home_unavailable'); }
  const target = join(codexHome, 'auth.json');
  try {
    const existing = await lstat(target);
    // 심링크·디렉터리는 고치지 않고 멈춘다. 따라가면 영속 공간 밖 파일을 자격으로 쓰게 된다.
    if (!existing.isFile()) throw new WorkerStartError('auth_not_regular');
    return 'kept';
  } catch (error) {
    if (error instanceof WorkerStartError) throw error;
    if ((error as { code?: string }).code !== 'ENOENT') throw new WorkerStartError('auth_unreadable');
  }
  const seed = await readSeed(seedFile);
  if (!plausibleAuth(seed.toString('utf8'))) throw new WorkerStartError('seed_invalid');
  const temporary = join(codexHome, `.auth.json.seed-${randomUUID()}`);
  try {
    const handle = await open(temporary, NOFOLLOW_NEW, 0o600);
    try {
      await handle.writeFile(seed);
      // umask와 무관하게 0600으로 둔다.
      await handle.chmod(0o600);
      await handle.sync();
    } finally { await handle.close(); }
    await rename(temporary, target);
  } catch {
    await rm(temporary, { force: true }).catch(() => {});
    throw new WorkerStartError('seed_write_failed');
  }
  // 이름 바꾸기 자체를 디스크에 남긴다. 실패해도 파일은 이미 제자리다.
  const dir = await open(codexHome, constants.O_RDONLY | constants.O_DIRECTORY).catch(() => null);
  if (dir) { await dir.sync().catch(() => {}); await dir.close().catch(() => {}); }
  return 'seeded';
}

// capability 한 번 쓰기 기록. 프로세스가 다시 떠도(파드 재시작 포함, PVC 유지) 같은 nonce를 거부한다(D3).
// - nonce는 WorkerVerifier가 넘기는 서명 payload의 SHA-256 hex다. 그 모양이 아니면 파일 이름으로 쓰지 않고 거부한다.
// - 이름이 nonce인 빈 파일을 O_EXCL로 만든다. 이미 있으면 재사용이다. 만든 시각은 mtime에 기록한다.
// - 보관 기간: capability 수명 30초 + 시계 오차(capabilitySkewMs)면 검증기가 만료로 거부하므로 그 뒤 기록은 지워도 된다.
//   시계가 조금 뒤로 가도 안전하게 두 배(62초)를 남긴다.
// - 한 프로세스 안의 consume은 차례로 처리한다. 지우기와 만들기가 겹치지 않는다. 디렉터리는 이 작업자만 쓴다(replicas 1).
const NONCE = /^[0-9a-f]{64}$/;
export const NONCE_RETENTION_MS = 2 * (30_000 + DEFAULTS.capabilitySkewMs);
export class FileNonceStore {
  private queue: Promise<unknown> = Promise.resolve();
  private ready: Promise<void> | undefined;
  constructor(private readonly dir: string, private readonly now: Clock = Date.now) {
    if (!isAbsolute(dir)) throw new WorkerStartError('config_invalid');
  }
  // 기동 때 한 번 부른다. 디렉터리를 만들고 쓸 수 있는지 확인한다. 못 쓰면 기동 실패다(모든 요청을 거부하게 된다).
  async open(): Promise<void> {
    this.ready ??= (async () => {
      try {
        await mkdir(this.dir, { recursive: true, mode: 0o700 });
        const info = await lstat(this.dir);
        if (!info.isDirectory()) throw new Error();
        const probe = join(this.dir, `.probe-${randomUUID()}`);
        await (await open(probe, NOFOLLOW_NEW, 0o600)).close();
        await rm(probe, { force: true });
      } catch { this.ready = undefined; throw new WorkerStartError('nonce_store_unavailable'); }
    })();
    return this.ready;
  }
  consume(nonce: string): Promise<boolean> {
    const next = this.queue.then(() => this.consumeNow(nonce));
    this.queue = next.catch(() => {});
    return next;
  }
  private async consumeNow(nonce: string): Promise<boolean> {
    if (!NONCE.test(nonce)) return false;
    await this.open();
    const now = this.now();
    await this.prune(now);
    let handle: FileHandle;
    try { handle = await open(join(this.dir, nonce), NOFOLLOW_NEW, 0o600); }
    // EEXIST는 재사용이고, 그 밖의 오류도 기록을 남겼는지 모르니 거부한다(fail-closed).
    catch { return false; }
    try {
      await handle.utimes(now / 1000, now / 1000);
      // 디렉터리 항목까지 남기지 않아도 된다: 페이지 캐시를 잃는 사고(노드 정전)는 복구에 수명 31초보다 오래 걸린다.
      return true;
    } catch {
      // 시각을 못 남긴 기록은 지우지 않고 둔다. 다음 prune이 실제 mtime으로 판단한다.
      return true;
    } finally { await handle.close().catch(() => {}); }
  }
  private async prune(now: number): Promise<void> {
    let names: string[];
    try { names = await readdir(this.dir); } catch { return; }
    for (const name of names) {
      if (!NONCE.test(name)) continue;
      try {
        const info = await lstat(join(this.dir, name));
        if (now - info.mtimeMs > NONCE_RETENTION_MS) await rm(join(this.dir, name), { force: true });
      } catch { /* 다음 정리에서 다시 본다 */ }
    }
  }
}
