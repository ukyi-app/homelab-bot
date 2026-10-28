import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readdir, readFile, readlink } from 'node:fs/promises';
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
      '-c', 'core.hooksPath=/dev/null', ...args], { cwd: dir, env });
    try { await git('rev-parse', '--verify', '--quiet', 'HEAD'); return; } catch { /* 아직 저장소가 아니다. */ }
    await git('init', '-q');
    await git('add', '--all');
    await git('commit', '-q', '--no-verify', '--allow-empty', '-m', 'baseline');
  },
  async snapshot(dir) {
    const result: Snapshot = {};
    let files = 0;
    let bytes = 0;
    const walk = async (rel: string): Promise<void> => {
      for (const entry of await readdir(join(dir, rel), { withFileTypes: true })) {
        const path = rel ? `${rel}/${entry.name}` : entry.name;
        if (path === '.git') continue;
        if (++files > LIMITS.files) throw new Error('workspace_too_large');
        if (entry.isDirectory()) await walk(path);
        // 심링크는 따라가지 않는다. 작업 공간 밖을 읽게 된다.
        else if (entry.isSymbolicLink()) result[path] = `link:${await readlink(join(dir, path))}`;
        else if (entry.isFile()) {
          const data = await readFile(join(dir, path));
          if ((bytes += data.length) > LIMITS.bytes) throw new Error('workspace_too_large');
          result[path] = createHash('sha256').update(data).digest('hex');
        } else result[path] = 'special';
      }
    };
    try { await walk(''); return result; } catch { return null; }
  },
};
export function changedPaths(before: Snapshot, after: Snapshot): string[] {
  return [...new Set([...Object.keys(before), ...Object.keys(after)])].filter(path => before[path] !== after[path]).sort();
}
