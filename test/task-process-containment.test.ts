import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { ProcessGroupLauncher } from '../src/process-launcher.js';
import { ContainmentUnavailable, PodPidSpace } from '../src/task-containment.js';
import type { ProcReader } from '../src/task-containment.js';

// 작업 레인 정리 방식의 시험(PLAN §5.3, 사용자 결정 2026-11-05). 두 층으로 나눈다.
// - 가짜 /proc: 판정 규칙. 실제로 만들 수 없는 상황(다른 PID namespace만 남음, 읽기 권한 오류, I/O 오류)을 여기서 본다.
// - 실제 프로세스: bwrap으로 만든 별도 PID namespace 안에서 회피 자식을 띄운다. 이 시험 프로세스의 PID 공간은 건드리지 않는다.
//   bwrap이나 user namespace가 없는 환경은 skip하고 사유를 남긴다. skip은 통과로 세지 않는다.

interface FakeProcess { state?: string; nspid?: number[]; threads?: Record<number, string>; survivesTerm?: boolean; survivesKill?: boolean; statusError?: string }
const SELF = 7;
class FakeProc implements ProcReader {
  processes = new Map<number, FakeProcess>();
  listError: string | undefined;
  // targets: 그 신호를 맞은 시점의 기준 밖 프로세스 수.
  signals: { pid: number; signal: string; targets: number }[] = [];
  killError: string | undefined;
  // 신호를 맞을 때 새로 생기는 프로세스(fork 경쟁 흉내).
  onSignal: ((signal: string) => void) | undefined;
  constructor(extra: Record<number, FakeProcess> = {}) {
    this.processes.set(1, {}); this.processes.set(SELF, {});
    for (const [pid, process] of Object.entries(extra)) this.processes.set(Number(pid), process);
  }
  async pids() {
    if (this.listError) throw Object.assign(new Error('list'), { code: this.listError });
    return [...this.processes.keys()];
  }
  async status(pid: number) {
    const entry = this.processes.get(pid);
    if (!entry) throw Object.assign(new Error('gone'), { code: 'ENOENT' });
    if (entry.statusError) throw Object.assign(new Error('read'), { code: entry.statusError });
    return `Name:\tx\nState:\t${entry.state ?? 'S'} (x)\nNSpid:\t${(entry.nspid ?? [pid]).join('\t')}\n`;
  }
  async threads(pid: number) { return Object.keys(this.processes.get(pid)?.threads ?? { [pid]: 'Z' }).map(Number); }
  async threadStatus(pid: number, thread: number) { return `State:\t${this.processes.get(pid)?.threads?.[thread] ?? 'Z'} (x)\n`; }
  kill = (pid: number, signal: 'SIGTERM' | 'SIGKILL') => {
    this.signals.push({ pid, signal, targets: [...this.processes.keys()].filter(target => target !== 1 && target !== SELF).length });
    if (this.killError) throw Object.assign(new Error('kill'), { code: this.killError });
    this.onSignal?.(signal);
    for (const [target, entry] of this.processes) {
      if (target === 1 || target === SELF) continue;
      if (signal === 'SIGTERM' ? !entry.survivesTerm && !entry.survivesKill : !entry.survivesKill) this.processes.delete(target);
    }
  };
}
const space = (proc: FakeProc) => PodPidSpace.record({ dedicatedTaskPod: true, self: SELF, reader: proc, kill: proc.kill, graceMs: 20, killMs: 40, pollMs: 1 });
// 기준을 깨끗하게 기록한 뒤 프로세스를 심는다. 기록 때 이미 있으면 record가 거부하는 것은 따로 본다.
async function recorded(extra: Record<number, FakeProcess>, proc = new FakeProc()) {
  const pod = await space(proc);
  for (const [pid, process] of Object.entries(extra)) proc.processes.set(Number(pid), process);
  return { pod, proc };
}

test('기준 기록: 명시 옵션 없이는 켜지지 않고, 기준 밖 프로세스가 있으면 거부해 kill(-1)이 나갈 수 없다', async () => {
  await assert.rejects(PodPidSpace.record({ dedicatedTaskPod: false as unknown as true, self: SELF, reader: new FakeProc(), kill: () => {} }),
    (error: ContainmentUnavailable) => error.code === 'not_task_pod');
  // 가짜 리더에 진짜 신호를 섞지 못한다.
  await assert.rejects(PodPidSpace.record({ dedicatedTaskPod: true, self: SELF, reader: new FakeProc() }),
    (error: ContainmentUnavailable) => error.code === 'not_task_pod');
  const busy = new FakeProc({ 40: {} });
  await assert.rejects(space(busy), (error: ContainmentUnavailable) => error.code === 'baseline_not_clean');
  assert.deepEqual(busy.signals, []);
  const nested = new FakeProc({ 41: { nspid: [41, 1] } });
  await assert.rejects(space(nested), (error: ContainmentUnavailable) => error.code === 'baseline_not_clean');
  const unreadable = new FakeProc({ 42: { statusError: 'EACCES' } });
  await assert.rejects(space(unreadable), (error: ContainmentUnavailable) => error.code === 'proc_unreadable');
  // 다른 PID namespace의 /proc을 보고 있으면 자기 칸이 맞지 않는다.
  const foreign = new FakeProc();
  foreign.processes.set(SELF, { nspid: [900, SELF] });
  await assert.rejects(space(foreign), (error: ContainmentUnavailable) => error.code === 'foreign_proc');
});

test('정리 대상은 언제나 kill(-1)이다(번호로 보내지 않아 PID 재사용 경쟁이 없다)', async () => {
  const { pod, proc } = await recorded({ 50: { survivesTerm: true }, 51: {} });
  await pod.terminate('job');
  assert.ok(proc.signals.length > 0);
  assert.ok(proc.signals.every(signal => signal.pid === -1));
});

test('TERM으로 끝나는 프로세스는 KILL을 맞지 않고, TERM을 무시하면 유예 뒤 KILL을 맞는다', async () => {
  const polite = await recorded({ 50: {} });
  await polite.pod.terminate('job');
  assert.deepEqual(polite.proc.signals.map(signal => [signal.signal, signal.targets]), [['SIGTERM', 1], ['SIGKILL', 0]]);
  assert.equal(await polite.pod.survivors('job'), 0);
  const stubborn = await recorded({ 50: { survivesTerm: true } });
  const started = Date.now();
  await stubborn.pod.terminate('job');
  assert.ok(Date.now() - started >= 20, '유예를 기다리지 않았다');
  assert.deepEqual(stubborn.proc.signals.map(signal => [signal.signal, signal.targets]), [['SIGTERM', 1], ['SIGKILL', 1]]);
  assert.equal(await stubborn.pod.survivors('job'), 0);
});

test('검사가 깨끗해도 TERM·KILL을 한 번씩은 보낸다(검사에 안 잡히는 프로세스는 원자적인 kill(-1)만 맞힌다)', async () => {
  const { pod, proc } = await recorded({});
  await pod.terminate('job');
  assert.deepEqual(proc.signals.map(signal => signal.signal), ['SIGTERM', 'SIGKILL']);
  assert.equal(await pod.survivors('job'), 0);
});

test('번호를 옮겨 다니는 프로세스: 목록에 잡혀도 읽으면 사라져 있는 동안은 0이라고 말하지 않는다', async () => {
  // 언제 읽어도 사라져 있다. 깨끗함으로 치면 살아 있는데 stopped:true가 된다.
  const hopping = await recorded({ 90: { statusError: 'ESRCH', survivesKill: true } });
  assert.equal(await hopping.pod.survivors('job'), null);
  await hopping.pod.terminate('job');
  assert.ok(hopping.proc.signals.some(signal => signal.signal === 'SIGKILL'));
  assert.equal(await hopping.pod.survivors('job'), null);
  // KILL을 맞으면 사라진다.
  const killed = await recorded({ 91: { statusError: 'ESRCH', survivesTerm: true } });
  await killed.pod.terminate('job');
  assert.equal(await killed.pod.survivors('job'), 0);
});

test('다른 PID namespace 프로세스가 남으면 같은 namespace가 비어도 0이 아니다', async () => {
  const { pod } = await recorded({ 60: { nspid: [60, 2], survivesKill: true } });
  await pod.terminate('job');
  const scan = await pod.scan();
  assert.deepEqual(scan.nested, [60]);
  assert.deepEqual(scan.sameNamespace, []);
  assert.equal(await pod.survivors('job'), 1);
});

test('KILL에도 남으면 시간 안에 포기하고 남은 수를 보고한다(시간 초과 → unknown 재료)', async () => {
  const { pod, proc } = await recorded({ 61: { survivesKill: true } });
  const started = Date.now();
  await pod.terminate('job');
  assert.ok(Date.now() - started < 2000);
  assert.ok(proc.signals.some(signal => signal.signal === 'SIGKILL'));
  assert.equal(await pod.survivors('job'), 1);
});

test('권한 오류·I/O 실패는 0으로 세지 않는다', async () => {
  const eacces = await recorded({ 70: { statusError: 'EACCES', survivesKill: true } });
  await eacces.pod.terminate('job');
  assert.equal(await eacces.pod.survivors('job'), null);
  const eio = await recorded({ 71: { statusError: 'EIO', survivesKill: true } });
  assert.equal(await eio.pod.survivors('job'), null);
  const listing = await recorded({});
  listing.proc.listError = 'EIO';
  assert.equal(await listing.pod.survivors('job'), null);
  // 신호 권한이 없어 안 끝난 프로세스는 검사에 그대로 남는다.
  const denied = await recorded({ 72: {} });
  denied.proc.killError = 'EPERM';
  await denied.pod.terminate('job');
  assert.equal(await denied.pod.survivors('job'), 1);
  // /proc을 쓸 수 없게 된 경우.
  const lost = await recorded({});
  lost.proc.processes.set(SELF, { statusError: 'EIO' });
  assert.equal(await lost.pod.survivors('job'), null);
});

test('좀비는 세지 않지만 리더만 끝난 프로세스의 산 스레드는 센다', async () => {
  const zombie = await recorded({ 80: { state: 'Z' } });
  assert.equal(await zombie.pod.survivors('job'), 0);
  const leader = await recorded({ 81: { state: 'Z', threads: { 81: 'Z', 82: 'S' } } });
  assert.equal(await leader.pod.survivors('job'), 1);
  await leader.pod.terminate('job');
  assert.equal(await leader.pod.survivors('job'), 0);
});

test('한 번 사라지고 다시 안 나타나면 끝난 것이다(읽기 실패가 아니다)', async () => {
  const { pod, proc } = await recorded({ 90: { statusError: 'ESRCH' } });
  const original = proc.status.bind(proc);
  proc.status = async pid => {
    if (pid === 90) { proc.processes.delete(90); throw Object.assign(new Error('gone'), { code: 'ESRCH' }); }
    return original(pid);
  };
  assert.equal(await pod.survivors('job'), 0);
});

test('fork 경쟁: 신호 직후 새 프로세스가 생겨도 연속으로 깨끗해질 때까지 0을 말하지 않는다', async () => {
  const { pod, proc } = await recorded({ 100: {} });
  let spawned = 0;
  // 깨끗한 검사 사이에 나타난다. 한 번의 검사로 끝냈다면 이 프로세스들을 놓친다.
  proc.onSignal = () => { if (spawned++ < 3) setTimeout(() => proc.processes.set(200 + spawned, { survivesTerm: true }), 0); };
  await pod.terminate('job');
  assert.ok(spawned >= 3);
  assert.equal(await pod.survivors('job'), 0);
});

test('겹친 정리는 한 번만 돌고, 도는 동안 launcher는 새 프로세스를 띄우지 않는다', async () => {
  const { pod, proc } = await recorded({ 110: { survivesTerm: true } });
  const launcher = new ProcessGroupLauncher(['/bin/false'], { cleanup: pod });
  const first = launcher.terminate('job');
  const second = launcher.terminate('job');
  assert.equal(pod.busy(), true);
  await assert.rejects(launcher.run({ job: 'job', args: [], cwd: '/', env: {}, stdin: '', limits: { lineBytes: 10, outputBytes: 10 } },
    new AbortController().signal, () => {}));
  await Promise.all([first, second]);
  assert.equal(pod.busy(), false);
  assert.equal(proc.signals.filter(signal => signal.signal === 'SIGTERM').length, 1);
});

// 실제 프로세스. 바깥에서는 네트워크·자격이 필요 없고, 안에서는 kill(-1)이 그 namespace에서 끝난다.
const HARNESS = fileURLToPath(new URL('./task-containment-harness.js', import.meta.url));
const BWRAP = '/usr/bin/bwrap';
const wrap = (...command: string[]) => [BWRAP, '--unshare-pid', '--unshare-user', '--new-session', '--die-with-parent', '--dev-bind', '/', '/', '--proc', '/proc', '--', ...command];
function namespaceProblem(): string | false {
  if (!existsSync(BWRAP)) return 'bwrap 없음(/usr/bin/bwrap): 실제 프로세스 시험을 돌릴 PID namespace를 만들 수 없다. 운영 이미지에서 다시 돈다';
  const probe = spawnSync(wrap('/bin/sh', '-c', 'echo $$')[0]!, wrap('/bin/sh', '-c', 'echo $$').slice(1), { encoding: 'utf8', timeout: 10_000 });
  if (probe.status !== 0 || probe.stdout.trim() !== '2') return `bwrap PID namespace 생성 실패(status ${String(probe.status)}): 이 환경은 비특권 user namespace를 막는다. 운영 이미지에서 다시 돈다`;
  return false;
}
const unavailable = namespaceProblem();
const hasPython = existsSync('/usr/bin/python3');
interface Counted { alive: number; zombieLeaders: number; zombies: number }
interface HarnessResult { error?: string; pid: number; exited: boolean; before: Counted; after: Counted; survivors: number | null; late: string; elapsedMs: number; graceMs: number; witnessBefore: boolean | null; witnessAfter: boolean | null }
function runScenario(name: string, options: readonly string[] = []): HarnessResult {
  const command = wrap(process.execPath, HARNESS, name);
  command.splice(1, 0, ...options);
  const result = spawnSync(command[0]!, command.slice(1), { encoding: 'utf8', timeout: 60_000 });
  assert.equal(result.status, 0, `${name}: ${result.stdout}${result.stderr}`);
  return JSON.parse(result.stdout) as HarnessResult;
}
// 번호를 옮겨 다니는 자식은 검사로 셀 수 없어 살아 있음을 파일로 본다. 정리 전에 늘다가 정리 뒤 멈춰야 한다.
for (const name of ['pidhop', 'tighthop']) {
  const skip = unavailable || (name === 'tighthop' && !hasPython ? 'python3 없음: 쉬지 않는 fork 연쇄를 만들 수 없다' : false);
  test(`실제 프로세스 ${name}: 검사에 안 잡혀도 kill(-1)이 끝낸다`, { skip }, () => {
    const result = runScenario(name);
    assert.equal(result.witnessBefore, true, '정리 전에 자식이 돌고 있어야 시험이 뜻을 가진다');
    assert.equal(result.witnessAfter, false, '정리 뒤에도 자식이 돈다');
    assert.equal(result.survivors, 0);
    assert.equal(result.after.alive, 0);
  });
}
// 운영 파드에서는 작업자가 PID 1이다(--as-pid-1). kill(-1)이 자기만 빼고 모두에 닿고, 회수되지 않은 고아 좀비가 남아도 0으로 확인된다.
test('실제 프로세스: 작업자가 PID 1이어도 회피 자식을 끝내고, 좀비는 세지 않는다', { skip: unavailable }, () => {
  const result = runScenario('envclear', ['--as-pid-1']);
  assert.equal(result.pid, 1);
  assert.ok(result.before.alive > 0);
  assert.equal(result.survivors, 0);
  assert.equal(result.after.alive, 0);
  assert.ok(result.after.zombies > 0, 'Node PID 1이 고아를 회수하지 않는다는 기록이다. 달라지면 DECISIONS의 남는 위험을 고친다');
});
const MUST_LEAVE_SOMETHING = ['background', 'setsid', 'doublefork', 'envclear', 'nondumpable', 'termignore', 'nohup', 'stdoutholder', 'forkrace', 'latespawn', 'zombieleader'];
for (const name of MUST_LEAVE_SOMETHING) {
  const python = name === 'nondumpable' || name === 'zombieleader';
  const skip = unavailable || (python && !hasPython ? 'python3 없음: non-dumpable·리더 종료 자식을 만들 수 없다' : false);
  test(`실제 프로세스 ${name}: 회피 자식이 남아 있다가 정리 뒤 0개로 확인된다`, { skip }, () => {
    const result = runScenario(name);
    assert.ok(result.before.alive > 0, `${name}: 시험이 뜻을 가지려면 정리 전에 살아 있는 자식이 있어야 한다`);
    assert.equal(result.survivors, 0, name);
    assert.equal(result.after.alive, 0, name);
    assert.equal(result.late, 'refused', name);
    if (name === 'zombieleader') assert.ok(result.before.zombieLeaders > 0, '리더만 끝난 상태를 만들지 못했다');
    if (name === 'termignore') assert.ok(result.elapsedMs >= result.graceMs, 'TERM 유예를 지키지 않았다');
  });
}
test('실제 프로세스 hang: 끝나지 않는 CLI도 중단 뒤 0개로 확인된다', { skip: unavailable }, () => {
  const result = runScenario('hang');
  assert.equal(result.exited, true);
  assert.equal(result.survivors, 0);
  assert.equal(result.after.alive, 0);
});
test('실제 프로세스 clean: 남은 것이 없으면 유예를 기다리지 않는다', { skip: unavailable }, () => {
  const result = runScenario('clean');
  assert.equal(result.survivors, 0);
  assert.equal(result.before.alive, 0);
  assert.ok(result.elapsedMs < result.graceMs, `유예를 기다렸다: ${result.elapsedMs}ms`);
});
test('음성 대조: 옛 방식(프로세스 그룹·표식)은 envclear 자식을 찾지 못한다. 새 방식이 다른 것을 해결했음을 시험 쪽에서 확인한다', { skip: unavailable }, () => {
  const script = 'setsid env -i /usr/bin/sleep 300 >/dev/null 2>&1 & sleep 0.1; exit 0';
  const probe = `
    import('${new URL('../src/process-launcher.js', import.meta.url).href}').then(async ({ ProcessGroupLauncher }) => {
      const launcher = new ProcessGroupLauncher(['/bin/sh', '-c', ${JSON.stringify(script)}], { graceMs: 100 });
      await launcher.run({ job: 'job', args: [], cwd: '/', env: { PATH: '/usr/bin:/bin' }, stdin: '', limits: { lineBytes: 10, outputBytes: 10 } }, new AbortController().signal, () => {});
      await launcher.terminate('job');
      const survivors = await launcher.survivors('job');
      const { readdirSync, readFileSync } = await import('node:fs');
      const sleepers = readdirSync('/proc').filter(name => /^\\d+$/.test(name)).filter(name => { try { return readFileSync('/proc/' + name + '/comm', 'utf8').trim() === 'sleep'; } catch { return false; } }).length;
      process.stdout.write(JSON.stringify({ survivors, sleepers }));
      process.exit(0);
    });`;
  const command = wrap(process.execPath, '-e', probe);
  const result = spawnSync(command[0]!, command.slice(1), { encoding: 'utf8', timeout: 30_000 });
  assert.equal(result.status, 0, result.stderr);
  const seen = JSON.parse(result.stdout) as { survivors: number | null; sleepers: number };
  assert.equal(seen.survivors, 0);
  assert.equal(seen.sleepers, 1);
});
