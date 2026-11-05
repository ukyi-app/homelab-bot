import { readFile, readdir } from 'node:fs/promises';
import type { ProcessCleanup } from './process-launcher.js';

// 작업 레인 전용 파드의 프로세스 정리(사용자 2026-11-05, DECISIONS "T18 할 일 6 정리 방식").
// 전제: 이 파드는 작업 전용이고 작업은 직렬 1이다. 파드 PID 공간에서 작업자 자신과 init 말고는 전부 그 작업의 것으로 본다.
// 대화·리뷰 파드에서 켜면 다른 레인의 실행을 죽인다. 그래서 record()는 명시 옵션을 요구하고, 기준 밖 프로세스가 이미 있으면 거부한다.
//
// 끝내는 수단은 kill(-1)이다. 커널이 호출자와 그 PID namespace의 init을 뺀 모든 프로세스(아래 PID namespace 포함)에
// tasklist 잠금 아래 한 번에 신호를 보내므로 fork가 끼어들 틈이 없고, 번호로 하나씩 보내지 않아 PID 재사용 경쟁도 없다.
//
// 소멸 확인은 /proc/<pid>/status로 한다. environ·ns/pid와 달리 ptrace 검사가 없어 non-dumpable이나 샌드박스 안 프로세스도 읽힌다.
// NSpid 칸이 둘 이상이면 아래 PID namespace의 프로세스다. 프로세스가 자기 환경을 지워도, 새 세션으로 빠져나가도 이 목록에서 숨지 못한다.

export class ContainmentUnavailable extends Error {
  constructor(readonly code: 'not_task_pod' | 'proc_unreadable' | 'foreign_proc' | 'baseline_not_clean') { super(code); }
}

// 시험이 가짜 /proc을 주입하는 자리. 진짜 신호와 함께 주입해야 한다(record가 확인한다).
export interface ProcReader {
  pids(): Promise<number[]>;
  status(pid: number): Promise<string>;
  // 스레드 그룹 안 스레드 ID 목록과 각 스레드의 State 줄. 좀비처럼 보이는 리더를 가른다.
  threads(pid: number): Promise<number[]>;
  threadStatus(pid: number, thread: number): Promise<string>;
}
export const procFsReader = (proc = '/proc'): ProcReader => ({
  async pids() { return (await readdir(proc)).filter(name => /^\d+$/.test(name)).map(Number); },
  status: pid => readFile(`${proc}/${pid}/status`, 'utf8'),
  async threads(pid) { return (await readdir(`${proc}/${pid}/task`)).filter(name => /^\d+$/.test(name)).map(Number); },
  threadStatus: (pid, thread) => readFile(`${proc}/${pid}/task/${thread}/status`, 'utf8'),
});

export interface PodPidScan {
  // 기준 밖의 살아 있는 프로세스. nested는 아래 PID namespace 소속이다.
  sameNamespace: number[]; nested: number[];
  // 읽지 못한 항목이 하나라도 있으면 false다. 0개라는 말을 할 수 없다.
  complete: boolean;
  // 목록에 있었는데 읽을 때 사라졌다. fork와 exit를 빠르게 되풀이하는 프로세스는 언제 읽어도 이렇게 보인다. 끝났다는 증거가 아니다.
  raced: boolean;
}
export interface PodPidOptions {
  // 명시 옵션. 작업 전용 파드 조립만 true를 넘긴다.
  dedicatedTaskPod: true;
  self?: number;
  reader?: ProcReader;
  // 대상은 항상 -1이다. 시험은 가짜로 바꾼다.
  kill?: (pid: number, signal: 'SIGTERM' | 'SIGKILL') => void;
  // TERM 유예와 KILL 반복 시간. 합은 RunControl의 취소 대기(4초)와 정지 여유(5초) 안에 들어가야 한다.
  graceMs?: number; killMs?: number;
  pollMs?: number;
  // 깨끗한 검사를 몇 번 연달아 봐야 확인으로 치는지.
  confirmScans?: number;
}
const DEFAULTS = { graceMs: 1500, killMs: 2000, pollMs: 25, confirmScans: 3 } as const;
const VANISHED = new Set(['ENOENT', 'ESRCH']);
const code = (error: unknown) => (error as { code?: string } | null)?.code;
const stateOf = (status: string) => /^State:\s+(\S)/m.exec(status)?.[1] ?? null;
const sleep = (ms: number) => new Promise<void>(resolve => { setTimeout(resolve, ms); });

export class PodPidSpace implements ProcessCleanup {
  private sweeping: Promise<void> | undefined;
  private constructor(private readonly self: number, private readonly reader: ProcReader,
    private readonly kill: (pid: number, signal: 'SIGTERM' | 'SIGKILL') => void,
    private readonly timing: { graceMs: number; killMs: number; pollMs: number; confirmScans: number }) {}

  // 기동 때 한 번, 작업자가 자식을 띄우기 전이나 띄운 자식이 끝난 뒤에 부른다. 기준 상태는 작업자 자신과 PID 1이다.
  // 그 밖의 프로세스가 보이면 거부한다. 개발 기계나 다른 레인 파드에서 잘못 켜도 kill(-1)이 나가지 않게 하는 마지막 보루다.
  static async record(options: PodPidOptions): Promise<PodPidSpace> {
    if (options.dedicatedTaskPod !== true) throw new ContainmentUnavailable('not_task_pod');
    if ((options.reader === undefined) !== (options.kill === undefined)) throw new ContainmentUnavailable('not_task_pod');
    const space = new PodPidSpace(options.self ?? process.pid, options.reader ?? procFsReader(), options.kill ?? ((pid, signal) => { process.kill(pid, signal); }), {
      graceMs: options.graceMs ?? DEFAULTS.graceMs, killMs: options.killMs ?? DEFAULTS.killMs,
      pollMs: options.pollMs ?? DEFAULTS.pollMs, confirmScans: options.confirmScans ?? DEFAULTS.confirmScans });
    if (!await space.ownProc()) throw new ContainmentUnavailable('foreign_proc');
    const scan = await space.scan();
    if (!scan.complete) throw new ContainmentUnavailable('proc_unreadable');
    if (scan.sameNamespace.length || scan.nested.length) throw new ContainmentUnavailable('baseline_not_clean');
    return space;
  }

  // /proc이 작업자 자신의 PID namespace 것인지. 바깥 namespace의 /proc이면 NSpid가 둘 이상이고 번호도 다르다.
  private async ownProc(): Promise<boolean> {
    try { return /^NSpid:\s+(\d+)\s*$/m.exec(await this.reader.status(this.self))?.[1] === String(this.self); }
    catch { return false; }
  }

  async scan(): Promise<PodPidScan> {
    const result: PodPidScan = { sameNamespace: [], nested: [], complete: true, raced: false };
    if (!await this.ownProc()) result.complete = false;
    let pids: number[];
    try { pids = await this.reader.pids(); } catch { return { ...result, complete: false }; }
    for (const pid of pids) {
      if (pid === this.self || pid === 1) continue;
      let status: string;
      try { status = await this.reader.status(pid); }
      catch (error) {
        if (VANISHED.has(code(error) ?? '')) result.raced = true;
        else result.complete = false;
        continue;
      }
      const state = stateOf(status);
      const namespaces = /^NSpid:\s+(.+)$/m.exec(status)?.[1]?.trim().split(/\s+/);
      if (!state || !namespaces) { result.complete = false; continue; }
      const alive = await this.alive(pid, state);
      if (alive === null) { result.complete = false; continue; }
      if (alive) (namespaces.length > 1 ? result.nested : result.sameNamespace).push(pid);
    }
    return result;
  }

  // 좀비는 도는 코드가 없다. 작업자가 PID 1이면 고아 좀비를 회수하지 않아 남아 있을 수 있어 세지 않는다.
  // 단, 리더 스레드만 끝난 프로세스도 Z로 보인다. 다른 스레드가 살아 있으면 코드가 돌고 있는 것이다.
  private async alive(pid: number, state: string): Promise<boolean | null> {
    if (state === 'X' || state === 'x') return false;
    if (state !== 'Z') return true;
    try {
      for (const thread of await this.reader.threads(pid)) {
        try {
          const threadState = stateOf(await this.reader.threadStatus(pid, thread));
          if (threadState === null) return null;
          if (threadState !== 'Z' && threadState !== 'X' && threadState !== 'x') return true;
        } catch (error) { if (!VANISHED.has(code(error) ?? '')) return null; }
      }
      return false;
    } catch (error) { return VANISHED.has(code(error) ?? '') ? false : null; }
  }

  // 대상이 없을 때의 ESRCH는 정상이다. 권한 오류 등은 삼키되 결론은 뒤의 검사가 낸다(신호가 닿지 않은 프로세스는 검사에 남는다).
  private signal(signal: 'SIGTERM' | 'SIGKILL'): void {
    try { this.kill(-1, signal); } catch { /* 위 주석 */ }
  }

  // 검사가 깨끗해 보여도 신호를 생략하지 않는다. /proc 검사는 원자적이지 않아 번호를 옮겨 다니는 프로세스를 못 볼 수 있고,
  // 원자적인 것은 kill(-1)뿐이다. 그래서 TERM·KILL을 언제나 한 번씩은 보낸다. 대상이 없으면 ESRCH로 아무 일도 없다.
  private async sweep(): Promise<void> {
    this.signal('SIGTERM');
    const graceUntil = Date.now() + this.timing.graceMs;
    while (Date.now() < graceUntil) {
      if (await this.survivors('') === 0) break;
      await sleep(this.timing.pollMs);
    }
    const killUntil = Date.now() + this.timing.killMs;
    do {
      this.signal('SIGKILL');
      if (await this.survivors('') === 0) return;
      await sleep(this.timing.pollMs);
    } while (Date.now() < killUntil);
  }

  // 작업 구분이 없다. 직렬 1 파드에서 정리는 언제나 파드 전체를 기준 상태로 되돌리는 일이다.
  // 겹쳐 불러도 한 번만 돈다(중단 처리와 실행 뒤 정리가 함께 부른다).
  terminate(_job: string): Promise<void> {
    this.sweeping ??= this.sweep().finally(() => { this.sweeping = undefined; });
    return this.sweeping;
  }
  // 도는 동안 띄우는 프로세스는 곧바로 신호를 맞거나 확인을 흐린다. launcher는 이 값이 true면 띄우지 않는다.
  busy(): boolean { return this.sweeping !== undefined; }

  // 0은 확인했다는 뜻이다. 보이면 그 수, 읽지 못했거나 사라지는 항목이 멈추지 않으면 null이다. 둘 다 위층에서 unknown이 된다.
  async survivors(_job: string): Promise<number | null> {
    let clean = 0;
    for (let attempt = 0; attempt < this.timing.confirmScans * 4; attempt++) {
      const scan = await this.scan();
      const seen = scan.sameNamespace.length + scan.nested.length;
      if (seen) return seen;
      if (!scan.complete) return null;
      clean = scan.raced ? 0 : clean + 1;
      if (clean >= this.timing.confirmScans) return 0;
      await sleep(this.timing.pollMs);
    }
    return null;
  }
}
