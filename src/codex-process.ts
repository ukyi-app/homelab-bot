import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { readdir, readFile } from 'node:fs/promises';
import { createInterface } from 'node:readline';
import { TASK_MARKER } from './codex-config.js';
import type { CodexLauncher, LaunchResult, LaunchSpec } from './codex.js';

// 작업마다 새 프로세스 그룹으로 띄우고, 그룹과 작업 표식으로 남은 프로세스를 찾는다.
// 한계: 환경을 지우고 새 세션으로 빠져나간 자식은 찾지 못한다. cgroup의 cgroup.procs 확인은 T16b 실측 뒤다.
export class ProcessGroupLauncher implements CodexLauncher {
  private readonly groups = new Map<string, number>();
  constructor(private readonly command: readonly [string, ...string[]] = ['codex'],
    private readonly options: { graceMs?: number; proc?: string } = {}) {}
  async run(spec: LaunchSpec, signal: AbortSignal): Promise<LaunchResult> {
    // env는 호출자가 만든 허용 목록 그대로다. 작업자 프로세스 환경을 섞지 않는다.
    const child = spawn(this.command[0], [...this.command.slice(1), ...spec.args],
      { cwd: spec.cwd, env: spec.env, detached: true, stdio: ['pipe', 'pipe', 'ignore'] });
    if (child.pid) this.groups.set(spec.job, child.pid);
    const exited = new Promise<LaunchResult['exit']>(resolve => {
      child.once('exit', (code, sig) => resolve({ code, signal: sig }));
      child.once('error', () => resolve(null));
    });
    const lines: string[] = [];
    const reader = createInterface({ input: child.stdout });
    reader.on('line', line => lines.push(line));
    const closed = once(reader, 'close');
    child.stdin.on('error', () => {});
    child.stdin.end(spec.stdin);
    const abort = () => { void this.terminate(spec.job); };
    signal.addEventListener('abort', abort, { once: true });
    if (signal.aborted) abort();
    try {
      const exit = await exited;
      // 배경 자식이 stdout을 물고 있으면 close가 오지 않는다. 종료 뒤에는 잠깐만 기다린다.
      await Promise.race([closed, new Promise(resolve => setTimeout(resolve, 200))]);
      return { lines, exit };
    } finally {
      signal.removeEventListener('abort', abort);
      child.stdout.destroy();
    }
  }
  async terminate(job: string): Promise<void> {
    const grace = this.options.graceMs ?? 2000;
    const pgid = this.groups.get(job);
    for (const sig of ['SIGTERM', 'SIGKILL'] as const) {
      if (pgid) { try { process.kill(-pgid, sig); } catch { /* 이미 없는 그룹 */ } }
      for (const pid of await this.members(job) ?? []) { try { process.kill(pid, sig); } catch { /* 이미 끝남 */ } }
      const until = Date.now() + grace;
      while (Date.now() < until) {
        if ((await this.members(job))?.length === 0) return;
        await new Promise(resolve => setTimeout(resolve, 25));
      }
    }
  }
  async survivors(job: string): Promise<number | null> {
    return (await this.members(job))?.length ?? null;
  }
  private async members(job: string): Promise<number[] | null> {
    const proc = this.options.proc ?? '/proc';
    const pgid = this.groups.get(job);
    let entries: string[];
    try { entries = await readdir(proc); } catch { return null; }
    const found: number[] = [];
    for (const entry of entries) {
      if (!/^\d+$/.test(entry) || Number(entry) === process.pid) continue;
      let stat: string;
      try { stat = await readFile(`${proc}/${entry}/stat`, 'utf8'); } catch { continue; }
      // comm에 공백·괄호가 올 수 있어 마지막 ')' 뒤를 나눈다: state ppid pgrp ...
      const fields = stat.slice(stat.lastIndexOf(')') + 2).split(' ');
      if (fields[0] === 'Z' || fields[0] === 'X') continue;
      if (pgid && Number(fields[2]) === pgid) { found.push(Number(entry)); continue; }
      try {
        if ((await readFile(`${proc}/${entry}/environ`, 'utf8')).split('\0').includes(`${TASK_MARKER}=${job}`)) found.push(Number(entry));
      } catch { /* 다른 사용자 프로세스는 읽을 수 없고 이 작업 것도 아니다. */ }
    }
    return found;
  }
}
