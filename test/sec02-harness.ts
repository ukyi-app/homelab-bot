import { spawn, spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { mkdir, readdir, readlink, rm } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { FakeMessagesApi, RefusingProxy } from './sec02-fake-api.js';
import { Sec02Layout, caseTable, fallbackSocketDir, fallbackTable, namesTable, scopeTable, unlistedTable } from './sec02-fixture.js';
import type { Row, Sec02Step } from './sec02-fixture.js';
import { ProcessTracker, SEC02_LIMITS, runTurn } from './sec02-turn.js';
import type { TurnReport, Variant } from './sec02-turn.js';

export { SEC02_LIMITS } from './sec02-turn.js';
export type { TurnReport, Variant } from './sec02-turn.js';

// SEC-02 1단계 하네스. 고정 CLI를 작업 레인의 실제 argv·settings·env로 띄우고 가짜 Messages API로 도구 호출을 고정한다.
// 진짜 토큰·모델·외부 호출이 없다. 네트워크 없는 컨테이너 안에서만 돈다. 음성 대조가 deny를 풀고 clean()이 루트 아래를 전부 지우기 때문에
// 운영 파드나 실제 자격이 있는 환경에서는 실행하지 않는다. 운영 파드는 sec02-pod이고 이 파일은 그쪽 배포 묶음에 들어가지 않는다.

// enforced_*와 long_tmpdir는 운영 argv·settings 그대로이고 사례표나 경로 길이만 다르다. 나머지는 이 합성 환경에서만 쓰는 대조군이다.
// unguarded는 검사기가 노출을 잡는지(거짓 통과 방지), no_*는 도구마다 어느 설정이 막는지를 가른다.
// legacy_*는 쓰기 허용을 도구 이름으로 되돌리고 실제 소켓 자리 가림을 뺀다. 같은 사례가 뚫리는 것으로 검사기가 위반을 잡음을 보인다.
export const VARIANTS: readonly Variant[] = ['enforced', 'enforced_scope', 'enforced_names', 'long_tmpdir', 'unlisted_tools', 'unguarded', 'no_permission_deny', 'no_sandbox_filesystem', 'no_deny_rules', 'no_block_outside', 'no_scrub', 'legacy_unscoped', 'legacy_scope'];
// 재개까지 도는 변형. 도구 호출 상한은 변형 하나의 시작·재개 합계다.
export const RESUMED_VARIANTS: readonly Variant[] = ['enforced', 'enforced_scope'];
const LEGACY_ALLOW: readonly Variant[] = ['unguarded', 'legacy_unscoped', 'legacy_scope'];
function stepsFor(variant: Variant, layout: Sec02Layout): Sec02Step[] {
  switch (variant) {
    case 'enforced_scope': return scopeTable(layout);
    case 'enforced_names': return namesTable(layout);
    case 'long_tmpdir': return fallbackTable(layout);
    case 'unlisted_tools': return unlistedTable(layout);
    case 'legacy_scope': return [...scopeTable(layout), ...namesTable(layout)];
    default: return caseTable(layout);
  }
}
// TMPDIR 아래 소켓 경로가 CLI 한도(103바이트)를 넘도록 길게 만든 상태 루트 이름.
const LONG_ROOT_NAME = 'l'.repeat(40);
export interface Sec02Report {
  schema: 'sec02-report-v1';
  environment: { network: 'none'; uid: number; cli: string | null; bwrap: string | null; socat: string | null; node: string };
  limits: typeof SEC02_LIMITS;
  turns: TurnReport[];
  cleanup: { listeners_closed: boolean; tracked_groups_alive: number; processes_left: number };
  total_ms: number; aborted: 'total_time' | 'report_size' | null;
}
export interface RunnerConfig { root: string; credentialDir: string; cli: string; variants?: readonly Variant[] }

// 결과 상한 안에 들도록 행을 고정 열 순서의 배열로 보낸다. 필드는 case_id/tool/attempted/outcome/error_code/bytes 그대로다.
type EncodedRow = [string, Row['tool'], boolean, Row['outcome'], Row['error_code'], number | null];
export function encodeReport(report: Sec02Report): string {
  return JSON.stringify({ ...report, turns: report.turns.map(turn => ({ ...turn, rows: turn.rows.map((row): EncodedRow => [row.case_id, row.tool, row.attempted, row.outcome, row.error_code, row.bytes]) })) });
}
export function decodeReport(text: string): Sec02Report {
  const raw = JSON.parse(text) as Omit<Sec02Report, 'turns'> & { turns: (Omit<TurnReport, 'rows'> & { rows: EncodedRow[] })[] };
  return { ...raw, turns: raw.turns.map(turn => ({ ...turn,
    rows: turn.rows.map(([case_id, tool, attempted, outcome, error_code, bytes]): Row => ({ case_id, tool, attempted, outcome, error_code, bytes })) })) };
}

export function variantSettings(variant: Variant, production: string): string {
  const settings = JSON.parse(production) as { sandbox: Record<string, unknown>; permissions: Record<string, unknown> };
  switch (variant) {
    case 'enforced': return production;
    case 'unguarded': return JSON.stringify({ ...settings, sandbox: { enabled: false }, permissions: {} });
    case 'no_permission_deny': return JSON.stringify({ ...settings, permissions: {} });
    case 'no_sandbox_filesystem': return JSON.stringify({ ...settings, sandbox: { ...settings.sandbox, filesystem: {} } });
    case 'no_deny_rules': return JSON.stringify({ ...settings, sandbox: { ...settings.sandbox, filesystem: {} }, permissions: {} });
    case 'no_block_outside': {
      const { blockReadsOutsideWorkingDirectories: _dropped, ...permissions } = settings.permissions;
      return JSON.stringify({ ...settings, permissions });
    }
    case 'legacy_unscoped':
    case 'legacy_scope': {
      const realSocket = /\/cc-socks(\/|$)/;
      const keep = (list: unknown) => (list as string[]).filter(item => !realSocket.test(item));
      const filesystem = settings.sandbox.filesystem as Record<string, unknown>;
      return JSON.stringify({ ...settings, sandbox: { ...settings.sandbox, filesystem: { denyRead: keep(filesystem.denyRead), denyWrite: keep(filesystem.denyWrite) } },
        permissions: { ...settings.permissions, deny: keep(settings.permissions.deny) } });
    }
    default: return production;
  }
}
// 쓰기 허용을 경로 없는 도구 이름으로 되돌린 인자. 운영 argv가 아니라 대조군 전용이다.
export function unscopedAllowArgs(args: readonly string[]): string[] {
  const start = args.indexOf('--allowedTools');
  const next = args.findIndex((arg, index) => index > start && arg.startsWith('--'));
  return [...args.slice(0, start + 1), 'Bash', 'Read', 'Edit', 'Write', ...args.slice(next)];
}
// 대조군이 푸는 것을 CLI argv·env에 적용한다. 운영 설정 변형은 아무것도 바꾸지 않는다.
function adjustFor(variant: Variant): (args: string[], env: Record<string, string>) => void {
  return (args, env) => {
    if (LEGACY_ALLOW.includes(variant)) args.splice(0, args.length, ...unscopedAllowArgs(args));
    args[args.indexOf('--settings') + 1] = variantSettings(variant, args[args.indexOf('--settings') + 1]!);
    if (variant === 'unguarded' || variant === 'no_scrub') delete env.CLAUDE_CODE_SUBPROCESS_ENV_SCRUB;
  };
}

function versionOf(command: string, args: readonly string[], pattern: RegExp, env: NodeJS.ProcessEnv): string | null {
  const result = spawnSync(command, args, { encoding: 'utf8', timeout: 10_000, env });
  return pattern.exec(result.stdout ?? '')?.[1] ?? null;
}
const SYSTEM_PATH = '/usr/local/bin:/usr/bin:/bin';

class Runner {
  readonly turns: TurnReport[] = [];
  private readonly tracker = new ProcessTracker();
  constructor(private readonly config: RunnerConfig) {}

  // 대조군마다 새 세대를 만든다. 이전 대조군이 바꾼 것이 이어지지 않게 루트 아래를 지운다. 루트와 자격 디렉터리는 컨테이너의 tmpfs다.
  private async clean(): Promise<void> {
    for (const dir of [this.config.root, this.config.credentialDir]) {
      for (const name of await readdir(dir).catch(() => [] as string[])) await rm(join(dir, name), { recursive: true, force: true });
    }
    // long_tmpdir에서 CLI가 만드는 자리. 남으면 다음 변형의 fallback 사례 코드가 달라진다.
    await rm(fallbackSocketDir(), { recursive: true, force: true });
  }

  async run(): Promise<Sec02Report> {
    const started = Date.now();
    const deadline = started + SEC02_LIMITS.totalMs;
    const environment: Sec02Report['environment'] = { network: 'none', uid: process.getuid?.() ?? -1,
      cli: versionOf(this.config.cli, ['--version'], /^(\d+\.\d+\.\d+)/, { PATH: SYSTEM_PATH, HOME: '/tmp', DISABLE_UPDATES: '1', CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1' }),
      bwrap: versionOf('bwrap', ['--version'], /bubblewrap (\S+)/, { PATH: SYSTEM_PATH }),
      socat: versionOf('socat', ['-V'], /socat version (\S+)/, { PATH: SYSTEM_PATH }),
      node: process.version };
    let aborted: Sec02Report['aborted'] = null;
    let listenersClosed = true;
    for (const variant of this.config.variants ?? VARIANTS) {
      if (Date.now() >= deadline) { aborted = 'total_time'; break; }
      await this.clean();
      const root = variant === 'long_tmpdir' ? join(this.config.root, LONG_ROOT_NAME) : this.config.root;
      await mkdir(root, { recursive: true, mode: 0o700 });
      const layout = new Sec02Layout({ root, credentialDir: this.config.credentialDir });
      await layout.build();
      const api = new FakeMessagesApi({ token: layout.token, onViolation: () => this.tracker.stopTurns() });
      const proxy = new RefusingProxy();
      const ports = { api: await api.listen(), proxy: await proxy.listen() };
      const sandbox = () => ({ credentialDir: this.config.credentialDir, controlDir: layout.sessions.controlDir, others: layout.others });
      const common = { variant, deadline, layout, api, proxy, ports, cli: this.config.cli, tracker: this.tracker, adjust: adjustFor(variant),
        inheritDirFd: this.config.credentialDir, fallbackSocket: variant === 'long_tmpdir' };
      try {
        this.turns.push(await runTurn({ ...common, operation: 'start', dirs: layout.session.dirs, sandbox: sandbox(), steps: stepsFor(variant, layout) }));
        if (RESUMED_VARIANTS.includes(variant)) {
          // 재개는 운영과 같이 세션 기록과 대화 파일을 확인한 뒤에만 연다.
          await layout.recordTurn(1);
          const { session } = await layout.openResume();
          this.turns.push(await runTurn({ ...common, operation: 'resume', dirs: session.dirs, sandbox: sandbox(), steps: stepsFor(variant, layout) }));
        }
      } finally {
        await this.tracker.stopSentinel();
        await api.close();
        await proxy.close();
        listenersClosed &&= !api.listening && !proxy.listening;
      }
    }
    await this.clean();
    const report: Sec02Report = { schema: 'sec02-report-v1', environment, limits: SEC02_LIMITS, turns: this.turns,
      cleanup: { listeners_closed: listenersClosed, tracked_groups_alive: this.tracker.alive(), processes_left: await this.processesLeft() },
      total_ms: Date.now() - started, aborted };
    if (Buffer.byteLength(encodeReport(report)) > SEC02_LIMITS.reportBytes) report.aborted = 'report_size';
    return report;
  }
  // 컨테이너의 PID namespace 전체를 센다. 러너와 init만 남아야 한다. 좀비는 exe를 읽지 못해 세지 않는다.
  private async processesLeft(): Promise<number> {
    let left = 0;
    for (const name of await readdir('/proc')) {
      if (!/^\d+$/.test(name)) continue;
      const pid = Number(name);
      if (pid === process.pid || pid === 1) continue;
      if (await readlink(`/proc/${pid}/exe`).catch(() => '')) left++;
    }
    return left;
  }
}

export async function runBoundary(config: RunnerConfig): Promise<Sec02Report> {
  return new Runner(config).run();
}

// 시험 쪽. 러너를 네트워크 없는 컨테이너로 띄우고 마지막 줄의 결과만 받는다.
export const REPORT_MARKER = 'SEC02_REPORT ';
const CONTAINER_ROOT = '/worker-state';
const CONTAINER_CREDENTIAL = '/run/worker-credential';
const CONTAINER_REPO = '/sec02';
export interface Sec02Plan { image: string; repo: string }

// 돌릴 수 없으면 사유 문자열을 돌려준다. 시험은 이 사유로 skip하고 통과로 세지 않는다.
// 호스트에서 직접 돌리지 않는다. 이 호스트의 AppArmor는 바깥 bwrap 안의 중첩 bwrap을 막아 네트워크를 끊을 수 없고, 호스트 샌드박스에는 운영에 없는 쓰기 마운트가 있다 [실측].
export function sec02Plan(env: NodeJS.ProcessEnv = process.env, repo = resolve('.')): Sec02Plan | string {
  const image = env.SEC02_IMAGE;
  if (!image) return 'SEC02_IMAGE 없음: 저장소 Dockerfile로 만든 런타임 이미지를 주면 네트워크 없는 컨테이너에서 돈다(VERIFICATION "SEC-02 1단계")';
  if (spawnSync('podman', ['image', 'exists', image], { timeout: 20_000 }).status !== 0) return 'SEC02_IMAGE 이미지 또는 podman을 찾지 못했다';
  return { image, repo };
}

// 네트워크 없음, uid 10001, 읽기 전용 루트, /proc 가림 해제(운영 procMount: Unmasked). 중첩 bwrap 때문에 AppArmor·seccomp 프로필은 푼다.
export function containerArgs(plan: Sec02Plan, name: string, variants?: readonly Variant[]): string[] {
  const config: RunnerConfig = { root: CONTAINER_ROOT, credentialDir: CONTAINER_CREDENTIAL, cli: '/usr/local/bin/claude', ...(variants ? { variants } : {}) };
  return ['run', '--rm', '--pull=never', '--name', name, '--network', 'none', '--init', '--user', '10001:10001', '--read-only',
    '--security-opt', 'apparmor=unconfined', '--security-opt', 'seccomp=unconfined', '--security-opt', 'unmask=ALL',
    '--tmpfs', '/tmp:rw,size=64m,mode=1777', '--tmpfs', `${CONTAINER_ROOT}:rw,size=32m,mode=0700,U`, '--tmpfs', `${CONTAINER_CREDENTIAL}:rw,size=1m,mode=0700,U`,
    '-v', `${join(plan.repo, 'dist')}:${CONTAINER_REPO}/dist:ro`, '-v', `${join(plan.repo, 'node_modules')}:${CONTAINER_REPO}/node_modules:ro`, '-v', `${join(plan.repo, 'package.json')}:${CONTAINER_REPO}/package.json:ro`,
    '--entrypoint', 'node', '--workdir', CONTAINER_REPO, plan.image, `${CONTAINER_REPO}/dist/test/sec02-run.js`, JSON.stringify(config)];
}

export async function launchRunner(plan: Sec02Plan, variants?: readonly Variant[]): Promise<Sec02Report> {
  const name = `sec02-${randomBytes(4).toString('hex')}`;
  return new Promise<Sec02Report>((done, fail) => {
    const child = spawn('podman', containerArgs(plan, name, variants), { stdio: ['ignore', 'pipe', 'ignore'] });
    let stdout = '';
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => { stdout += chunk; });
    const watchdog = setTimeout(() => {
      spawnSync('podman', ['rm', '-f', name], { timeout: 30_000 });
      fail(new Error('sec02_runner_timeout'));
    }, SEC02_LIMITS.totalMs + 2 * SEC02_LIMITS.turnMs);
    child.once('error', () => { clearTimeout(watchdog); fail(new Error('sec02_runner_spawn')); });
    child.once('close', () => {
      clearTimeout(watchdog);
      const line = stdout.split('\n').reverse().find(item => item.startsWith(REPORT_MARKER));
      if (!line) { fail(new Error('sec02_no_report')); return; }
      done(decodeReport(line.slice(REPORT_MARKER.length)));
    });
  });
}
