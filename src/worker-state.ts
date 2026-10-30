import { randomUUID } from 'node:crypto';
import { constants, existsSync, realpathSync } from 'node:fs';
import type { FileHandle } from 'node:fs/promises';
import { link, lstat, mkdir, open, readdir, readlink, realpath, rm, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { DEFAULTS } from './contracts.js';
import type { Clock } from './contracts.js';

// 작업자 영속 공간(PVC)의 상태: 모델 자격 시드 복사(D-14 조건 4)와 capability nonce 저장소(D3).

// 기동 실패 사유. 값(시드 내용, 토큰)은 담지 않는다. 진입점은 이 code만 로그에 남긴다.
export class WorkerStartError extends Error {
  constructor(public readonly code: string) { super(code); }
}
const SEED_LIMIT = 1024 * 1024;
const NOFOLLOW_NEW = constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW;

// 경로가 사람 홈 자체나 그 아래 `.codex*`(심링크로 가리키는 경우 포함)면 거부한다.
// 개인 auth.json을 시드로 복사하거나 개인 Codex 홈에 쓰지 않는다(D-14 조건 1). 홈을 열거하지 않고 경로 모양만 본다.
export function assertNotPersonal(name: string, path: string, homes: readonly string[]): void {
  let existing = resolve(path);
  while (!existsSync(existing) && dirname(existing) !== existing) existing = dirname(existing);
  const candidates = new Set([resolve(path)]);
  try { candidates.add(join(realpathSync(existing), relative(existing, resolve(path)))); } catch { /* 모양 검사만 */ }
  for (const home of homes) {
    const bases = new Set([resolve(home)]);
    try { bases.add(realpathSync(home)); } catch { /* 홈이 없으면 문자열 비교만 */ }
    for (const base of bases) for (const candidate of candidates) {
      const rel = relative(base, candidate);
      if (rel === '' || (!rel.startsWith('..') && !isAbsolute(rel) && rel.split(sep)[0]!.startsWith('.codex'))) {
        throw new WorkerStartError(`config_invalid:${name}`);
      }
    }
  }
}
export function humanHomes(): string[] {
  // 파드에서 passwd에 없는 UID면 HOME이 없을 수 있다. 그때는 경로 모양 검사만 한다.
  try { return [homedir()]; } catch { return []; }
}

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

async function readSeed(path: string, homes: readonly string[]): Promise<Buffer> {
  // Secret 볼륨 파일은 kubelet이 만든 심링크(..data/키)라 링크를 따라간다. 대신 최종 대상을 먼저 해석해
  // 개인 Codex 홈(.codex*)이면 읽지 않는다(디렉터리만 보면 파일 자체의 심링크로 개인 auth.json을 복사할 수 있었다, r1 P1).
  let real: string;
  try { real = await realpath(path); }
  catch (error) { throw new WorkerStartError((error as { code?: string }).code === 'ENOENT' ? 'seed_missing' : 'seed_unreadable'); }
  try { assertNotPersonal('WORKER_SEED_KEY', real, homes); } catch { throw new WorkerStartError('seed_personal_path'); }
  let handle: FileHandle;
  try { handle = await open(real, constants.O_RDONLY | constants.O_NONBLOCK); }
  catch (error) { throw new WorkerStartError((error as { code?: string }).code === 'ENOENT' ? 'seed_missing' : 'seed_unreadable'); }
  try {
    // 검사한 경로와 실제로 연 파일이 같은지 본다. 그 사이 경로 구성 요소가 심링크로 바뀌었으면 읽지 않는다.
    if (await readlink(`/proc/self/fd/${handle.fd}`) !== real) throw new WorkerStartError('seed_unreadable');
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
// 원자성: 같은 디렉터리의 임시 파일(0600)에 쓰고 fsync한 뒤 link로 설치한다. link는 이름이 이미 있으면 EEXIST로
// 실패하므로 "없을 때만"이 설치 순간에 지켜진다(rename은 덮어써서, 확인 뒤 생긴 갱신본·동시 기동의 설치를 잃었다, r1 P1).
// 중간에 죽어도 반쯤 쓴 auth.json은 없다. 남는 것은 임시 이름뿐이다.
// options.homes: 사람 홈 목록(개인 Codex 홈 검사). options.beforeInstall: 시험이 설치 직전 경합을 끼워 넣는 자리.
export interface SeedOptions { homes?: readonly string[]; beforeInstall?: () => Promise<void> }
export async function seedAuth(codexHome: string, seedFile: string, options: SeedOptions = {}): Promise<'seeded' | 'kept'> {
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
  const seed = await readSeed(seedFile, options.homes ?? humanHomes());
  if (!plausibleAuth(seed.toString('utf8'))) throw new WorkerStartError('seed_invalid');
  const temporary = join(codexHome, `.auth.json.seed-${randomUUID()}`);
  let installed = false;
  try {
    const handle = await open(temporary, NOFOLLOW_NEW, 0o600);
    try {
      await handle.writeFile(seed);
      // umask와 무관하게 0600으로 둔다.
      await handle.chmod(0o600);
      await handle.sync();
    } finally { await handle.close(); }
    await options.beforeInstall?.();
    try { await link(temporary, target); installed = true; }
    catch (error) { if ((error as { code?: string }).code !== 'EEXIST') throw error; }
  } catch {
    throw new WorkerStartError('seed_write_failed');
  } finally { await rm(temporary, { force: true }).catch(() => {}); }
  if (!installed) {
    // 확인 뒤 다른 쓰기 주체(먼저 뜬 작업자, 그 작업자의 codex 갱신)가 만들었다. 그것을 보존한다.
    let existing;
    try { existing = await lstat(target); } catch { throw new WorkerStartError('auth_unreadable'); }
    if (!existing.isFile()) throw new WorkerStartError('auth_not_regular');
    return 'kept';
  }
  // 설치한 이름을 디스크에 남긴다. 실패해도 파일은 이미 제자리다.
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
  // io: 시험이 기록 중 I/O 오류를 넣는 자리. 기본은 node:fs/promises open이다.
  constructor(private readonly dir: string, private readonly now: Clock = Date.now, private readonly io: { open: typeof open } = { open }) {
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
    try { handle = await this.io.open(join(this.dir, nonce), NOFOLLOW_NEW, 0o600); }
    // EEXIST는 재사용이고, 그 밖의 오류도 기록을 남겼는지 모르니 거부한다(fail-closed).
    catch { return false; }
    // 기록 과정의 I/O 오류는 이번 사용을 거부한다(fail-closed, r1 P2). 남은 표식은 지우지 않는다: 같은 nonce의 재사용은
    // 계속 거부되고, 다음 prune이 실제 mtime으로 정리한다.
    // 보장 범위: 프로세스·파드 재시작 뒤에도 남는다(페이지 캐시). fsync는 하지 않는다. 페이지 캐시를 잃는 사고(노드 정전)는
    // 복구에 capability 수명(31초)보다 오래 걸려, 그때는 기록이 없어도 검증기가 만료로 거부한다.
    let recorded = false;
    try { await handle.utimes(now / 1000, now / 1000); recorded = true; } catch { /* 거부 */ }
    try { await handle.close(); } catch { recorded = false; }
    return recorded;
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
