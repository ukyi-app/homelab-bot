import { mkdtemp, readFile, readdir, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ProcessGroupLauncher, LaunchFailed } from '../src/process-launcher.js';
import { PodPidSpace } from '../src/task-containment.js';

// 별도 PID namespace 안에서 도는 실제 프로세스 시험 본체. test/task-process-containment.test.ts가 bwrap으로 감싸 띄운다.
// kill(-1)이 이 namespace 밖에 닿지 않는다. 밖에서 잘못 띄워도 record()가 기준 밖 프로세스를 보고 거부한다.
const PYTHON = '/usr/bin/python3';
const GRACE_MS = 300;
// witness: 번호를 옮겨 다니는 자식은 /proc 검사로 셀 수 없다. 자식이 파일을 늘리는지로 살아 있음을 따로 본다.
export const SCENARIOS: Readonly<Record<string, { script: string; hang?: boolean; python?: boolean; witness?: boolean }>> = {
  clean: { script: 'exit 0' },
  background: { script: 'sleep 300 >/dev/null 2>&1 & sleep 0.1' },
  setsid: { script: 'setsid sleep 300 >/dev/null 2>&1 & sleep 0.1' },
  doublefork: { script: '( ( sleep 300 >/dev/null 2>&1 & ) & ) ; sleep 0.1' },
  // 표식 환경과 프로세스 그룹을 모두 벗어난다. 옛 방식이 찾지 못하는 자식이다.
  envclear: { script: 'setsid env -i /usr/bin/sleep 300 >/dev/null 2>&1 & sleep 0.1' },
  nondumpable: { script: `setsid env -i ${PYTHON} -c 'import ctypes,time; ctypes.CDLL(None).prctl(4,0,0,0,0); time.sleep(300)' >/dev/null 2>&1 & sleep 0.6`, python: true },
  termignore: { script: `setsid sh -c 'trap "" TERM HUP INT; exec sleep 300' >/dev/null 2>&1 & sleep 0.1` },
  nohup: { script: 'nohup sleep 300 >/dev/null 2>&1 & sleep 0.1' },
  // 부모가 끝나도 stdout을 쥐고 있는 자식.
  stdoutholder: { script: 'sleep 300 & sleep 0.1' },
  // 끊임없이 새 자식을 만든다.
  forkrace: { script: `setsid sh -c 'while :; do sleep 0.02 & done' >/dev/null 2>&1 & sleep 0.1` },
  // 한 번에 하나만 살아 있으면서 번호를 옮겨 다닌다. 쉬지 않으면 목록에 잡혀도 읽을 때는 이미 없어 깨끗해 보인다.
  pidhop: { script: `setsid sh -c 'hop() { echo x >> "$WITNESS"; sleep 0.005; hop & exit 0; }; hop' >/dev/null 2>&1 & sleep 0.1`, witness: true },
  tighthop: { script: `setsid ${PYTHON} -c 'import os
fd = os.open(os.environ["WITNESS"], os.O_WRONLY | os.O_APPEND | os.O_CREAT)
while True:
    os.write(fd, b"x")
    if os.fork(): os._exit(0)' >/dev/null 2>&1 & sleep 0.2`, witness: true, python: true },
  // TERM을 받으면 정리 도중에 새 세션 자식을 띄운다.
  latespawn: { script: `setsid sh -c 'trap "setsid sleep 300 >/dev/null 2>&1 &" TERM; while :; do sleep 0.02; done' >/dev/null 2>&1 & sleep 0.1` },
  // 리더 스레드만 끝내 좀비처럼 보이면서 다른 스레드가 계속 돈다.
  zombieleader: { script: `setsid env -i ${PYTHON} -c 'import ctypes,threading,time; threading.Thread(target=time.sleep,args=(300,)).start(); ctypes.CDLL(None).pthread_exit(None)' >/dev/null 2>&1 & sleep 0.6`, python: true },
  // CLI 본체가 끝나지 않아 중단 신호로 멈추는 경우.
  hang: { script: 'while :; do sleep 0.05; done', hang: true },
};

// 정리 코드의 판단과 따로 센다. 판단과 같은 코드로 세면 같은 결함을 함께 놓친다.
async function independentCount(self: number): Promise<{ alive: number; zombieLeaders: number; zombies: number }> {
  let alive = 0;
  let zombieLeaders = 0;
  let zombies = 0;
  for (const name of await readdir('/proc')) {
    if (!/^\d+$/.test(name) || name === '1' || Number(name) === self) continue;
    try {
      const raw = await readFile(`/proc/${name}/stat`, 'utf8');
      const state = raw.slice(raw.lastIndexOf(')') + 2)[0];
      const threads = await readdir(`/proc/${name}/task`);
      if (state === 'Z' && threads.length > 1) { zombieLeaders++; alive++; }
      else if (state === 'Z') zombies++;
      else if (state !== 'X') alive++;
    } catch { /* 그 사이 끝남 */ }
  }
  return { alive, zombieLeaders, zombies };
}
const sleep = (ms: number) => new Promise(resolve => { setTimeout(resolve, ms); });
const sizeOf = (path: string) => stat(path).then(info => info.size, () => 0);
// 파일이 늘고 있으면 자식이 살아 있다.
async function growing(path: string): Promise<boolean> {
  const before = await sizeOf(path);
  await sleep(150);
  return await sizeOf(path) > before;
}

async function main(): Promise<void> {
  const name = process.argv[2]!;
  const scenario = SCENARIOS[name];
  if (!scenario) throw new Error('unknown_scenario');
  const space = await PodPidSpace.record({ dedicatedTaskPod: true, graceMs: GRACE_MS, killMs: 3000 });
  const launcher = new ProcessGroupLauncher(['/bin/sh', '-c', scenario.script], { cleanup: space });
  const controller = new AbortController();
  const witness = join(await mkdtemp(join(tmpdir(), 't18-witness-')), 'witness');
  const env = { PATH: '/usr/bin:/bin', WITNESS: witness };
  const limits = { lineBytes: 1024, outputBytes: 4096 };
  const running = launcher.run({ job: 'job', args: [], cwd: '/', env, stdin: '', limits }, controller.signal, () => {});
  if (scenario.hang) { await sleep(150); controller.abort(); }
  const exit = await running.catch(error => { if (error instanceof LaunchFailed) return null; throw error; });
  const before = await independentCount(process.pid);
  const witnessBefore = scenario.witness ? await growing(witness) : null;
  // 정리 중 늦은 spawn: 정리가 도는 동안 같은 launcher로 띄우면 거부된다.
  const started = Date.now();
  const sweeping = launcher.terminate('job');
  const late = await launcher.run({ job: 'job', args: [], cwd: '/', env, stdin: '', limits }, new AbortController().signal, () => {})
    .then(() => 'spawned', error => error instanceof LaunchFailed ? 'refused' : 'other');
  await sweeping;
  const elapsedMs = Date.now() - started;
  const survivors = await launcher.survivors('job');
  const after = await independentCount(process.pid);
  const witnessAfter = scenario.witness ? await growing(witness) : null;
  process.stdout.write(`${JSON.stringify({ name, pid: process.pid, exited: exit !== null, before, after, survivors, late, elapsedMs, graceMs: GRACE_MS, witnessBefore, witnessAfter })}\n`);
}
main().then(() => { process.exit(0); }, (error: Error) => { process.stdout.write(`${JSON.stringify({ error: error.message })}\n`); process.exit(1); });
