import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import type { FileHandle } from 'node:fs/promises';
import { lstat, open, readdir, readlink, rm } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { promisify } from 'node:util';

export type Snapshot = Record<string, string>;
export interface CodexWorkspace {
  // `codex exec`의 Git 저장소 요구를 맞춘다(D-15: git init 뒤 한 번 커밋). 비신뢰 코드가 돌기 전에만 git을 쓴다.
  // 핸들을 넘기면 git을 그 고정 디렉터리(/proc/<pid>/fd/N)에서 돌린다. 경로가 그 사이 바뀌어도 따라가지 않는다.
  prepare(dir: string | FileHandle): Promise<void>;
  // 실행 뒤 대조는 git이 아니라 파일 해시로 한다. 작업 공간의 .git/config는 실행 중 바뀌었을 수 있고,
  // 그 위에서 git add를 돌리면 filter·fsmonitor 설정으로 제어 프로세스가 명령을 실행하게 된다.
  // 실행 뒤에는 미리 열어 둔 디렉터리 핸들을 넘긴다. 경로를 넘기면 그 경로의 마지막 요소만 심링크를 거부한다.
  snapshot(dir: string | FileHandle): Promise<Snapshot | null>;
}
const run = promisify(execFile);
const LIMITS = { files: 20_000, bytes: 256 * 1024 * 1024 };
const DIR = constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW;
const FILE = constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK;

// 열린 디렉터리 핸들 아래 이름 하나를 가리키는 경로(openat 대용, Linux /proc 필요). 커널이 그 핸들의 디렉터리에서
// 이름을 찾으므로 디렉터리의 원래 경로나 상위가 나중에 심링크로 바뀌어도 따라가지 않는다. O_NOFOLLOW는 그 이름 자체를 막는다.
export function under(dir: FileHandle, name: string): string {
  if (!name || name === '.' || name === '..' || name.includes('/') || name.includes('\0')) throw new Error('invalid_name');
  return `/proc/self/fd/${dir.fd}/${name}`;
}
export const openDirAt = (dir: FileHandle, name: string) => open(under(dir, name), DIR);
export const openDir = (path: string) => open(path, DIR);

// 실제로 읽은 바이트로 상한을 센다. 크기를 본 뒤 파일이 커져도 maxBytes+1바이트에서 멈춘다(rev r3 N7).
async function readLimited(handle: FileHandle, maxBytes: number): Promise<Buffer | null> {
  const chunks: Buffer[] = [];
  let total = 0;
  const buffer = Buffer.alloc(Math.min(maxBytes + 1, 64 * 1024));
  for (;;) {
    const { bytesRead } = await handle.read(buffer, 0, Math.min(buffer.length, maxBytes + 1 - total), null);
    if (bytesRead === 0) return Buffer.concat(chunks);
    chunks.push(Buffer.from(buffer.subarray(0, bytesRead)));
    if ((total += bytesRead) > maxBytes) return null;
  }
}
export type ReadResult = { status: 'ok'; text: string } | { status: 'missing' | 'too_large' | 'refused' };
// 일반 파일이고 하드링크가 없을 때만 읽는다. 하드링크는 작업 공간 밖 inode일 수 있다(같은 UID면 만들 수 있다).
export async function readOpened(handle: FileHandle, maxBytes: number): Promise<ReadResult> {
  const info = await handle.stat();
  if (!info.isFile() || info.nlink !== 1) return { status: 'refused' };
  if (info.size > maxBytes) return { status: 'too_large' };
  const data = await readLimited(handle, maxBytes);
  return data ? { status: 'ok', text: data.toString('utf8') } : { status: 'too_large' };
}
export async function readAt(dir: FileHandle, name: string, maxBytes: number): Promise<ReadResult> {
  let handle: FileHandle;
  try { handle = await open(under(dir, name), FILE); }
  catch (error) { return { status: (error as { code?: string }).code === 'ENOENT' ? 'missing' : 'refused' }; }
  try { return await readOpened(handle, maxBytes); } catch { return { status: 'refused' }; }
  finally { await handle.close().catch(() => {}); }
}
// 기존 이름을 지우고 새 inode로 만든다. 기존 파일이 하드링크면 O_TRUNC가 바깥 inode를 덮어쓰기 때문이다.
// 지운 뒤 누가 다시 만들어 두면 O_EXCL이 실패하고 준비 실패로 끝난다.
export async function writeAt(dir: FileHandle, name: string, content: string): Promise<void> {
  await rm(under(dir, name), { force: true });
  const handle = await open(under(dir, name), constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
  try { await handle.writeFile(content); } finally { await handle.close(); }
}
export const removeAt = (dir: FileHandle, name: string) => rm(under(dir, name), { force: true });

export const fileWorkspace: CodexWorkspace = {
  async prepare(target) {
    // git 자식 프로세스에서 /proc/self는 자식 자신이라 부모 pid로 핸들을 가리킨다.
    const dir = typeof target === 'string' ? target : `/proc/${process.pid}/fd/${target.fd}`;
    // 위쪽 저장소를 찾아 올라가지 않게 GIT_DIR를 못 박는다. 사용자·시스템 git 설정도 읽지 않는다.
    const env = { PATH: '/usr/local/bin:/usr/bin:/bin', HOME: dir, LANG: 'C.UTF-8', GIT_DIR: join(dir, '.git'), GIT_WORK_TREE: dir,
      GIT_CEILING_DIRECTORIES: dirname(dir), GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null', GIT_TERMINAL_PROMPT: '0' };
    const git = (...args: string[]) => run('git', ['-c', 'user.name=homelab-bot', '-c', 'user.email=homelab-bot@invalid',
      '-c', 'core.hooksPath=/dev/null', '-c', 'core.fsmonitor=false', ...args], { cwd: dir, env });
    // 이미 있는 .git은 누가 썼는지 모른다(압축본에 섞였거나 이전 실행). 그 config로 git을 돌리지 않는다.
    // 작업 공간 원본을 푸는 단계(T16b·T19)는 .git 없이 풀고 git init은 여기서만 한다.
    const existing = typeof target === 'string' ? join(target, '.git') : under(target, '.git');
    if (await lstat(existing).then(() => true, () => false)) throw new Error('workspace_git_exists');
    await git('init', '-q');
    await git('add', '--all');
    await git('commit', '-q', '--no-verify', '--allow-empty', '-m', 'baseline');
  },
  async snapshot(dir) {
    // 루트도 심링크면 열지 않는다. 아래로는 열린 핸들 기준으로 이름 하나씩 연다. 읽는 도중 어떤 항목이 심링크로
    // 바뀌면 O_NOFOLLOW가 열기를 막아 스냅샷 전체가 실패(null)한다. 그 결과 diff를 얻지 못해 작업이 실패로 끝난다.
    let root: FileHandle;
    try { root = typeof dir === 'string' ? await openDir(dir) : dir; } catch { return null; }
    // 파일 이름이 키다. 일반 객체면 루트의 `__proto__` 파일이 상속 setter에 먹혀 기록되지 않는다.
    const result: Snapshot = Object.create(null);
    let files = 0;
    let bytes = 0;
    const walk = async (handle: FileHandle, rel: string): Promise<void> => {
      for (const entry of await readdir(`/proc/self/fd/${handle.fd}`)) {
        const path = rel ? `${rel}/${entry}` : entry;
        if (path === '.git') continue;
        if (++files > LIMITS.files) throw new Error('workspace_too_large');
        const name = under(handle, entry);
        const info = await lstat(name);
        if (info.isSymbolicLink()) { result[path] = `link:${await readlink(name)}`; continue; }
        if (info.isDirectory()) {
          const child = await open(name, DIR);
          try { await walk(child, path); } finally { await child.close().catch(() => {}); }
          continue;
        }
        if (!info.isFile()) { result[path] = 'special'; continue; }
        const file = await open(name, FILE);
        try {
          const stat = await file.stat();
          if (!stat.isFile()) { result[path] = 'special'; continue; }
          // 하드링크는 다른 inode(작업 공간 밖 파일)를 가리킬 수 있어 내용을 읽지 않는다. 링크 수가 바뀌면 변경으로 잡힌다.
          if (stat.nlink !== 1) { result[path] = 'special:hardlink'; continue; }
          const hash = createHash('sha256');
          // 읽은 바이트로 센다. 크기를 본 뒤 커지는 파일도 전체 상한에서 멈춘다(rev r3 N7과 같은 원인).
          for await (const chunk of file.readableWebStream()) {
            if ((bytes += (chunk as Uint8Array).byteLength) > LIMITS.bytes) throw new Error('workspace_too_large');
            hash.update(chunk as Uint8Array);
          }
          // git이 일반 파일 모드에 반영하는 소유자 실행 비트만 기록한다(100755/100644). 그룹·기타 실행 비트는
          // git이 보지 않으므로 세지 않는다. 내용이 같은 chmod u+x도 실제 변경이다(rev r1 R4, r2 N5).
          result[path] = `${hash.digest('hex')}:${stat.mode & 0o100 ? '755' : '644'}`;
        } finally { await file.close().catch(() => {}); }
      }
    };
    try { await walk(root, ''); return result; }
    catch { return null; }
    finally { if (typeof dir === 'string') await root.close().catch(() => {}); }
  },
};
export function changedPaths(before: Snapshot, after: Snapshot): string[] {
  return [...new Set([...Object.keys(before), ...Object.keys(after)])].filter(path => before[path] !== after[path]).sort();
}
