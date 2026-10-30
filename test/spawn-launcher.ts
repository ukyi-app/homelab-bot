import { spawn } from 'node:child_process';
import type { ChildProcess } from 'node:child_process';
import { once } from 'node:events';
import { createInterface } from 'node:readline';
import { LaunchFailed } from '../src/process-launcher.js';
import type { LaunchResult, LaunchSpec, ProcessLauncher } from '../src/process-launcher.js';

// 실제 프로세스를 띄우지만 /proc 전체를 훑지 않는 launcher. 정리는 자식 하나만 본다.
// ProcessGroupLauncher의 /proc 검사는 codex-bridge 시험이 맡는다. 여기서 쓰면 병렬로 도는 다른 시험 파일의
// 같은 UID 프로세스(예: non-dumpable 시험 자식)를 의심해 판정이 흔들릴 수 있다.
export class SpawnLauncher implements ProcessLauncher {
  specs: LaunchSpec[] = [];
  // 중단 신호를 받은 job. 신호를 받는 즉시(동기) 남긴다.
  aborted: string[] = [];
  left: number | null = 0;
  private readonly children = new Map<string, { child: ChildProcess; exited: Promise<unknown> }>();
  constructor(private readonly bin: string) {}
  async run(spec: LaunchSpec, signal: AbortSignal, onLine: (line: string) => void): Promise<LaunchResult> {
    this.specs.push(spec);
    if (signal.aborted) throw new LaunchFailed();
    const child = spawn(this.bin, spec.args, { cwd: spec.cwd, env: spec.env, stdio: ['pipe', 'pipe', 'ignore'] });
    const exited = new Promise<LaunchResult['exit']>(done => child.once('exit', (code, sig) => done({ code, signal: sig })));
    this.children.set(spec.job, { child, exited });
    const kill = () => { this.aborted.push(spec.job); child.kill('SIGKILL'); };
    signal.addEventListener('abort', kill, { once: true });
    const lines = createInterface({ input: child.stdout! });
    const closed = once(lines, 'close').catch(() => {});
    lines.on('line', onLine);
    child.stdin!.end(spec.stdin);
    try {
      const exit = await exited;
      await closed;
      return { exit };
    } finally { signal.removeEventListener('abort', kill); }
  }
  async terminate(job: string) {
    const entry = this.children.get(job);
    if (entry && entry.child.exitCode === null && entry.child.signalCode === null) { entry.child.kill('SIGKILL'); await entry.exited; }
  }
  async survivors(_job: string) { return this.left; }
}
