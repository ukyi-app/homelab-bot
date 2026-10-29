import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { readdir, readFile } from 'node:fs/promises';
import { TASK_MARKER } from './codex-config.js';
import { LaunchFailed } from './codex.js';
import type { CodexLauncher, LaunchResult, LaunchSpec } from './codex.js';

// 작업마다 새 프로세스 그룹으로 띄우고, 그룹과 작업 표식으로 남은 프로세스를 찾는다.
// 한계: 환경을 지우고 새 세션으로 빠져나간 자식은 찾지 못한다. cgroup의 cgroup.procs 확인은 T16b 실측 뒤다.
// 시작 시각을 아직 읽지 못한 그룹. 막 띄운 자식이라 재사용 번호 확인을 건너뛴다.
const PENDING = -1;
export class ProcessGroupLauncher implements CodexLauncher {
  private readonly groups = new Map<string, { pgid: number; since: number }>();
  constructor(private readonly command: readonly [string, ...string[]] = ['codex'],
    private readonly options: { graceMs?: number; proc?: string } = {}) {}
  async run(spec: LaunchSpec, signal: AbortSignal, onLine: (line: string) => void): Promise<LaunchResult> {
    // 이미 중단된 실행은 띄우지 않는다. 기록을 남겨 소멸 확인이 "이 실행으로 생긴 프로세스 없음"을 안다(rev r1 R1).
    if (signal.aborted) { this.groups.set(spec.job, { pgid: 0, since: Number.POSITIVE_INFINITY }); throw new LaunchFailed(); }
    // env는 호출자가 만든 허용 목록 그대로다. 작업자 프로세스 환경을 섞지 않는다.
    const child = spawn(this.command[0], [...this.command.slice(1), ...spec.args],
      { cwd: spec.cwd, env: spec.env, detached: true, stdio: ['pipe', 'pipe', 'ignore'] });
    const exited = new Promise<LaunchResult['exit']>(resolve => {
      child.once('exit', (code, sig) => resolve({ code, signal: sig }));
      child.once('error', () => resolve(null));
    });
    // pid가 없으면 프로세스가 생기지 않았다. 실행 전 실패라 unknown이 아니다. pgid 0은 쓰지 않는다(kill(0)은 자기 그룹이다).
    if (!child.pid) { await exited; this.groups.set(spec.job, { pgid: 0, since: Number.POSITIVE_INFINITY }); throw new LaunchFailed(); }
    // 그룹 기록과 중단 처리는 첫 await 전에 건다. 시작 시각을 읽는 동안 온 중단도 이 그룹을 끝낸다.
    const record = { pgid: child.pid, since: PENDING };
    this.groups.set(spec.job, record);
    const abort = () => { void this.terminate(spec.job); };
    signal.addEventListener('abort', abort, { once: true });
    // 줄을 모아 두지 않는다. 한 줄·전체 바이트 상한을 넘으면 더 읽지 않고 그룹을 끝낸다(rev r1 S3).
    let overflow = false;
    let total = 0;
    let pending: Buffer[] = [];
    let pendingBytes = 0;
    const exceed = () => { overflow = true; pending = []; void this.terminate(spec.job); };
    child.stdout.on('data', (chunk: Buffer) => {
      if (overflow) return;
      if ((total += chunk.length) > spec.limits.outputBytes) { exceed(); return; }
      let start = 0;
      for (let end = chunk.indexOf(10); end !== -1 && !overflow; end = chunk.indexOf(10, start)) {
        const part = chunk.subarray(start, end);
        start = end + 1;
        if (pendingBytes + part.length > spec.limits.lineBytes) { exceed(); return; }
        const line = Buffer.concat([...pending, part]).toString('utf8');
        pending = []; pendingBytes = 0;
        onLine(line);
      }
      const rest = chunk.subarray(start);
      if (pendingBytes + rest.length > spec.limits.lineBytes) { exceed(); return; }
      if (rest.length) { pending.push(rest); pendingBytes += rest.length; }
    });
    const closed = once(child.stdout, 'end').catch(() => {});
    child.stdin.on('error', () => {});
    child.stdin.end(spec.stdin);
    if (signal.aborted) abort();
    const stat = await this.stat(child.pid);
    record.since = stat?.start ?? await this.uptimeTicks();
    try {
      const exit = await exited;
      // 배경 자식이 stdout을 물고 있으면 end가 오지 않는다. 종료 뒤에는 잠깐만 기다린다.
      await Promise.race([closed, new Promise(resolve => setTimeout(resolve, 200))]);
      if (!overflow && pending.length) onLine(Buffer.concat(pending).toString('utf8'));
      return { exit, overflow };
    } finally {
      signal.removeEventListener('abort', abort);
      child.stdout.destroy();
    }
  }
  async terminate(job: string): Promise<void> {
    const grace = this.options.graceMs ?? 2000;
    for (const sig of ['SIGTERM', 'SIGKILL'] as const) {
      const group = await this.group(job);
      if (group) { try { process.kill(-group, sig); } catch { /* 이미 없는 그룹 */ } }
      for (const pid of (await this.members(job)).found) { try { process.kill(pid, sig); } catch { /* 이미 끝남 */ } }
      const until = Date.now() + grace;
      while (Date.now() < until) {
        const scan = await this.members(job);
        if (scan.found.length === 0 && scan.complete) return;
        await new Promise(resolve => setTimeout(resolve, 25));
      }
    }
  }
  async survivors(job: string): Promise<number | null> {
    const scan = await this.members(job);
    // 남은 것이 보이면 그 수, 못 읽는 후보가 있으면 확인 불가다(fail-closed).
    return scan.found.length ? scan.found.length : scan.complete ? 0 : null;
  }
  private async stat(pid: number | string): Promise<{ state: string; pgrp: number; start: number } | null> {
    try {
      const raw = await readFile(`${this.options.proc ?? '/proc'}/${pid}/stat`, 'utf8');
      // comm에 공백·괄호가 올 수 있어 마지막 ')' 뒤를 나눈다: state(3) ppid pgrp ... starttime(22)
      const fields = raw.slice(raw.lastIndexOf(')') + 2).split(' ');
      return { state: fields[0]!, pgrp: Number(fields[2]), start: Number(fields[19]) };
    } catch { return null; }
  }
  // 기록한 그룹이 아직 이 작업 것일 때만 pgid를 돌려준다. 리더 pid가 다른 시작 시각으로 살아 있으면 재사용된 번호다.
  // 리더가 끝났으면 그룹이 남아 있는 동안 그 번호는 재사용되지 않는다(Linux pid 할당 규칙).
  private async group(job: string): Promise<number | null> {
    const record = this.groups.get(job);
    if (!record || record.pgid <= 0) return null;
    const leader = await this.stat(record.pgid);
    return leader && record.since !== PENDING && leader.start !== record.since ? null : record.pgid;
  }
  private async members(job: string): Promise<{ found: number[]; complete: boolean }> {
    const proc = this.options.proc ?? '/proc';
    const record = this.groups.get(job);
    const pgid = await this.group(job);
    const uid = process.getuid?.();
    let entries: string[];
    try { entries = await readdir(proc); } catch { return { found: [], complete: false }; }
    const found: number[] = [];
    let complete = true;
    for (const entry of entries) {
      if (!/^\d+$/.test(entry) || Number(entry) === process.pid) continue;
      const stat = await this.stat(entry);
      if (!stat || stat.state === 'Z' || stat.state === 'X') continue;
      if (pgid && stat.pgrp === pgid) { found.push(Number(entry)); continue; }
      try {
        if ((await readFile(`${proc}/${entry}/environ`, 'utf8')).split('\0').includes(`${TASK_MARKER}=${job}`)) found.push(Number(entry));
      } catch {
        // 같은 UID인데 environ을 못 읽는 프로세스(non-dumpable 등)가 작업 시작 뒤에 생겼다면 이 작업 것일 수 있다.
        // 작업 전부터 있던 프로세스(sshd·systemd 등)는 셈에서 뺀다. 기록이 없으면(재시작 뒤) 모두 의심한다.
        const since = record && record.since !== PENDING ? record.since : 0;
        if (uid !== undefined && stat.start >= since && await this.owner(entry) === uid) complete = false;
      }
    }
    return { found, complete };
  }
  // 자식이 stat을 읽기 전에 끝났을 때의 기준 시각. CLK_TCK=100 [가정]이고, 조금 이르게 잡혀도 더 많이 의심하는 쪽이다.
  private async uptimeTicks(): Promise<number> {
    try { return Math.floor(Number((await readFile(`${this.options.proc ?? '/proc'}/uptime`, 'utf8')).split(' ')[0]) * 100) - 1; }
    catch { return 0; }
  }
  private async owner(pid: string): Promise<number | null> {
    try {
      const status = await readFile(`${this.options.proc ?? '/proc'}/${pid}/status`, 'utf8');
      return Number(/^Uid:\s+(\d+)/m.exec(status)?.[1] ?? NaN);
    } catch { return null; }
  }
}
