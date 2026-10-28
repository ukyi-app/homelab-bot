import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import { lstat, open, readdir, readlink } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { promisify } from 'node:util';

export type Snapshot = Record<string, string>;
export interface CodexWorkspace {
  // `codex exec`의 Git 저장소 요구를 맞춘다(D-15: git init 뒤 한 번 커밋). 비신뢰 코드가 돌기 전에만 git을 쓴다.
  prepare(dir: string): Promise<void>;
  // 실행 뒤 대조는 git이 아니라 파일 해시로 한다. 작업 공간의 .git/config는 실행 중 바뀌었을 수 있고,
  // 그 위에서 git add를 돌리면 filter·fsmonitor 설정으로 제어 프로세스가 명령을 실행하게 된다.
  snapshot(dir: string): Promise<Snapshot | null>;
}
const run = promisify(execFile);
const LIMITS = { files: 20_000, bytes: 256 * 1024 * 1024 };
export const fileWorkspace: CodexWorkspace = {
  async prepare(dir) {
    // 위쪽 저장소를 찾아 올라가지 않게 GIT_DIR를 못 박는다. 사용자·시스템 git 설정도 읽지 않는다.
    const env = { PATH: '/usr/local/bin:/usr/bin:/bin', HOME: dir, LANG: 'C.UTF-8', GIT_DIR: join(dir, '.git'), GIT_WORK_TREE: dir,
      GIT_CEILING_DIRECTORIES: dirname(dir), GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null', GIT_TERMINAL_PROMPT: '0' };
    const git = (...args: string[]) => run('git', ['-c', 'user.name=homelab-bot', '-c', 'user.email=homelab-bot@invalid',
      '-c', 'core.hooksPath=/dev/null', '-c', 'core.fsmonitor=false', ...args], { cwd: dir, env });
    // 이미 있는 .git은 누가 썼는지 모른다(압축본에 섞였거나 이전 실행). 그 config로 git을 돌리지 않는다.
    // 작업 공간 원본을 푸는 단계(T16b·T19)는 .git 없이 풀고 git init은 여기서만 한다.
    if (await lstat(join(dir, '.git')).then(() => true, () => false)) throw new Error('workspace_git_exists');
    await git('init', '-q');
    await git('add', '--all');
    await git('commit', '-q', '--no-verify', '--allow-empty', '-m', 'baseline');
  },
  async snapshot(dir) {
    const result: Snapshot = {};
    let files = 0;
    let bytes = 0;
    // 심링크를 따라가지 않는다(작업 공간 밖, /dev/zero). 항목 종류는 lstat·fstat으로 다시 보고, 파일은 O_NOFOLLOW·
    // O_NONBLOCK으로 열어 바꿔치기한 FIFO·장치에서 막히지 않게 한다. 남은 프로세스가 있으면 호출자가 이 함수를 부르지 않는다.
    const walk = async (rel: string): Promise<void> => {
      for (const entry of await readdir(join(dir, rel))) {
        const path = rel ? `${rel}/${entry}` : entry;
        if (path === '.git') continue;
        if (++files > LIMITS.files) throw new Error('workspace_too_large');
        const full = join(dir, path);
        const info = await lstat(full);
        if (info.isSymbolicLink()) { result[path] = `link:${await readlink(full)}`; continue; }
        if (info.isDirectory()) { await walk(path); continue; }
        if (!info.isFile()) { result[path] = 'special'; continue; }
        const handle = await open(full, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
        try {
          const stat = await handle.stat();
          if (!stat.isFile()) { result[path] = 'special'; continue; }
          if ((bytes += stat.size) > LIMITS.bytes) throw new Error('workspace_too_large');
          const hash = createHash('sha256');
          for await (const chunk of handle.readableWebStream()) hash.update(chunk as Uint8Array);
          result[path] = hash.digest('hex');
        } finally { await handle.close().catch(() => {}); }
      }
    };
    try { await walk(''); return result; } catch { return null; }
  },
};
export function changedPaths(before: Snapshot, after: Snapshot): string[] {
  return [...new Set([...Object.keys(before), ...Object.keys(after)])].filter(path => before[path] !== after[path]).sort();
}
