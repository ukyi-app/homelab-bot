import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import { access, lstat, readFile, readdir, realpath, rmdir, statfs } from 'node:fs/promises';
import { basename, dirname, isAbsolute, join, normalize, resolve, sep } from 'node:path';
import { removeTree } from '../src/task-workspace.js';
import { CODE_EXPECT, ENFORCED_EXPECT, NAMES_EXPECT, SCOPE_EXPECT, UNLISTED_EXPECT } from './sec02-expect.js';
import { FakeMessagesApi, RefusingProxy } from './sec02-fake-api.js';
import type { ToolStep } from './sec02-fake-api.js';
import { Sec02Layout, caseTable, fallbackSocketDir, namesTable, scopeTable, unlistedTable } from './sec02-fixture.js';
import type { ErrorCode, Outcome, Row, Sec02Step, ToolName } from './sec02-fixture.js';
import { ProcessTracker, SEC02_LIMITS, runTurn } from './sec02-turn.js';
import type { TurnReport } from './sec02-turn.js';

// SEC-02 2단계: 운영 worker-task 파드 안에서 kubectl exec로 한 번 도는 실행기(VERIFICATION "SEC-02 2단계 실행안").
// 실제 자격·제어 마운트가 있는 곳이다. 그래서 1단계 하네스를 부르지 않는다. 대조군 설정, 루트 전체 삭제(clean), 합성 자격 쓰기, 자격 디렉터리 fd 상속은 이 묶음에 없다.
// 자격 파일은 Bash에서 open만 하고 바로 닫는다. 파일 도구로 실제 자격·제어 경로를 겨누는 사례는 돌리지 않는다. 지우는 것은 manifest에 올린 정확한 경로뿐이다.

export const POD_PATHS = Object.freeze({ root: '/worker-state', credentialDir: '/run/worker-credential', cli: '/usr/local/bin/claude', tmp: '/tmp', proc: '/proc' });
export type PodPaths = { root: string; credentialDir: string; cli: string; tmp: string; proc: string };
export const POD_LIMITS = Object.freeze({ ...SEC02_LIMITS, testDirBytes: 32 * 1024 * 1024, freeBytes: 32 * 1024 * 1024, settleMs: 5_000 });
const EXPECTED_VERSIONS = Object.freeze({ cli: '2.1.308', bwrap: '0.12.0', socat: '1.8.0.3' });
export const POD_UID = 10001;

// 운영 argv·settings 그대로인 변형만. 대조군 이름은 이 타입에도 목록에도 없고, 대조군을 만드는 코드도 이 묶음에 없다.
export type PodVariant = 'enforced' | 'enforced_scope' | 'enforced_names' | 'unlisted_tools';
export const POD_VARIANTS: readonly PodVariant[] = Object.freeze(['enforced', 'enforced_scope', 'enforced_names', 'unlisted_tools']);
export function assertPodVariant(name: string): asserts name is PodVariant {
  if (!(POD_VARIANTS as readonly string[]).includes(name)) throw new Error('variant_not_allowed_in_pod');
}
// long_tmpdir는 상태 루트를 실제 자리에서 옮겨야 재현되어 돌리지 않는다. 운영 설정과 다른 others가 되고 실제 경로 구조 조건에도 어긋난다. 1단계 근거로 연결한다.
export const POD_SKIPPED_VARIANTS = Object.freeze({ long_tmpdir: 'non_production_root' });

// 한 턴에서 실제로 부르는 사례. 나머지는 사유를 달아 not_run으로 싣는다. 합계는 구조화 출력을 더해 TOOL 64회 안이다.
// 운영 파드에서 새로 볼 수 있는 것은 OS 경계(Bash)다. 파일 도구 판정은 CLI 경로 규칙이라 환경에 덜 묶여 재개와 쓰기 경계에서 대표만 고른다.
const ENFORCED_START = ['probe.env_proc', 'probe.cred_control', 'probe.others_outside', 'probe.escape', 'proc.read_self_environ', 'proc.read_other_environ', 'proc.read_symlink_environ',
  'others.read_config', 'others.read_workspace', 'positive.read', 'outside.read', 'others.edit_workspace', 'outside.edit', 'positive.edit',
  'others.write_config_new', 'others.write_workspace_new', 'outside.write_new', 'outside.write_existing', 'outside.write_symlink_dir', 'positive.write_new'];
const ENFORCED_RESUME = ['probe.env_proc', 'probe.cred_control', 'probe.others_outside', 'probe.escape', 'proc.read_symlink_environ', 'others.read_workspace', 'positive.read', 'outside.read',
  'others.edit_workspace', 'positive.edit', 'others.write_workspace_new', 'outside.write_new', 'positive.write_new'];
const SCOPE_START = ['scope.write_tasks_name', 'scope.write_state_root', 'scope.write_generation', 'scope.write_home', 'scope.write_tmp', 'scope.write_system_tmp', 'scope.write_sibling_prefix',
  'scope.write_dotdot', 'scope.write_relative', 'scope.write_proc_root', 'scope.edit_new', 'own.read_config', 'own.edit_config', 'own.write_config_new', 'own.read_run', 'own.write_run_new',
  'socket.read_own', 'socket.write_new', 'socket.write_fallback_new', 'probe.socket_inventory', 'positive.write_dotfile'];
const NAMES_START = ['names.write_claude', 'names.write_git', 'names.write_github'];
const UNLISTED_START = ['unlisted.notebook_edit', 'unlisted.multi_edit'];
export interface PodTurn { variant: PodVariant; phase: 'start' | 'resume'; keep: readonly string[] }
export const POD_TURNS: readonly PodTurn[] = Object.freeze([
  { variant: 'enforced', phase: 'start', keep: ENFORCED_START }, { variant: 'enforced', phase: 'resume', keep: ENFORCED_RESUME },
  { variant: 'enforced_scope', phase: 'start', keep: SCOPE_START },
  { variant: 'enforced_names', phase: 'start', keep: NAMES_START },
  { variant: 'unlisted_tools', phase: 'start', keep: UNLISTED_START },
]);
// 구조화 출력이 턴마다 한 번 더 든다.
export const plannedCalls = (turns: readonly PodTurn[]): number => turns.reduce((sum, turn) => sum + turn.keep.length + 1, 0);

// 실제 자격·제어 경로를 파일 도구로 겨누거나 그 자리에 파일을 둬야 하는 사례. 어떤 경우에도 호출하지 않는다.
const REAL_CREDENTIAL_CASES = ['cred.read', 'cred.read_symlink', 'cred.read_proc_root', 'cred.read_proc_fd', 'scope.write_cred_new'];
const REAL_CONTROL_CASES = ['control.read', 'control.read_symlink', 'control.edit', 'control.edit_symlink', 'control.write_new', 'control.write_symlink_dir', 'control.write_proc_root'];
// 사례표가 실제 마운트에서 뺀 Bash 사례. 그 자리에 합성 canary를 두지 않으므로 ENOENT를 차단으로 셀 수 없다.
const REAL_CONTROL_BASH_CASES = ['control.bash_read', 'control.bash_symlink', 'control.bash_proc_root', 'control.bash_write'];
const REFUSED_CASES: ReadonlyMap<string, ErrorCode> = new Map<string, ErrorCode>([
  ...REAL_CREDENTIAL_CASES.map((name): [string, ErrorCode] => [name, 'real_credential_target']),
  ...REAL_CONTROL_CASES.map((name): [string, ErrorCode] => [name, 'real_control_target']),
]);
const TABLES: Readonly<Record<PodVariant, (layout: Sec02Layout) => Sec02Step[]>> = { enforced: caseTable, enforced_scope: scopeTable, enforced_names: namesTable, unlisted_tools: unlistedTable };
const notRun = (case_id: string, tool: ToolName, error_code: ErrorCode): Row => ({ case_id, tool, attempted: false, outcome: 'not_run', error_code, bytes: null });

export interface SelectedTurn { steps: Sec02Step[]; notRun: Row[] }
export function selectSteps(turn: PodTurn, layout: Sec02Layout): SelectedTurn {
  assertPodVariant(turn.variant);
  const table = TABLES[turn.variant](layout);
  const known = new Set(table.map(step => step.name));
  if (turn.keep.some(name => !known.has(name) || REFUSED_CASES.has(name))) throw new Error('plan_mismatch');
  const rows: Row[] = [];
  const steps: Sec02Step[] = [];
  for (const step of table) {
    const refused = REFUSED_CASES.get(step.name);
    if (refused) rows.push(notRun(step.name, step.tool, refused));
    else if (turn.keep.includes(step.name)) steps.push(step);
    else rows.push(notRun(step.name, step.tool, 'call_budget'));
  }
  if (turn.variant === 'enforced') rows.push(...REAL_CONTROL_BASH_CASES.map(name => notRun(name, 'Bash', 'real_control_target')));
  return { steps, notRun: rows };
}

// 가장 긴 존재하는 앞부분까지 심링크를 푼다. 없는 파일을 만드는 쓰기도 실제로 닿을 자리로 잰다.
async function resolveLoosely(path: string): Promise<string> {
  let current = path;
  let rest = '';
  for (;;) {
    const found = await realpath(current).catch(() => null);
    if (found) return join(found, rest);
    const parent = dirname(current);
    if (parent === current) return path;
    rest = join(basename(current), rest);
    current = parent;
  }
}
const under = (path: string, parent: string) => path === parent || path.startsWith(`${parent}${sep}`);
// 호출 전 대상 점검용 자리표시 값. 프로세스 번호는 대상 판정과 무관하다.
export const PLAN_CONTEXT = Object.freeze({ cliPid: 1, sentinelPid: 1, apiPort: 1 });
// 사례표에 실수가 있어도 실제 자격·제어 경로로 나가는 호출은 없다. Bash는 open과 항목 확인만 그 경로를 부를 수 있다.
export async function stepTargetsReal(step: ToolStep, real: { credentialDir: string; controlDir: string; workspace: string }): Promise<boolean> {
  const hidden = [real.credentialDir, real.controlDir];
  if (step.tool === 'Bash') {
    const command = String(step.input.command ?? '');
    return command.split('\n').some(line => hidden.some(dir => line.includes(dir)) && !/^(sec02_open|sec02_seen) [a-z0-9_.]+ '[^'\n;&|]*'$/.test(line));
  }
  const raw = step.input.file_path ?? step.input.notebook_path;
  if (typeof raw !== 'string') return true;
  if (/^\/proc\/[^/]+\/fd(\/|$)/.test(raw)) return true;
  const stripped = raw.replace(/^\/proc\/[^/]+\/root(?=\/)/, '');
  const lexical = isAbsolute(stripped) ? normalize(stripped) : resolve(real.workspace, stripped);
  const actual = await resolveLoosely(lexical);
  return hidden.some(dir => under(lexical, dir) || under(actual, dir));
}

// 와일드카드 없이 정확한 경로만 지운다. 올릴 때 경로가 비어 있어야 한다(실행 전에 없던 것). 보호 경로와 그 상위·하위는 올릴 수 없다.
// emptyOnly는 다른 작업의 부모 자리(tasks)다. 없던 것을 실행기가 만들었을 때만 올리고, 비었을 때만 지운다.
export interface ManifestPolicy { roots: readonly string[]; protect: readonly string[]; emptyOnly: readonly string[] }
type ManifestEntry = { path: string; kind: 'tree' | 'empty_dir' };
export class PodManifest {
  readonly entries: ManifestEntry[] = [];
  constructor(private readonly policy: ManifestPolicy) {}
  private check(path: string, kind: ManifestEntry['kind']): void {
    if (!isAbsolute(path) || normalize(path) !== path || /[*?[\]{}\\\n]/.test(path)) throw new Error('manifest_path_invalid');
    if (!this.policy.roots.some(root => path.startsWith(`${root}${sep}`))) throw new Error('manifest_outside_roots');
    if (this.policy.protect.some(dir => under(path, dir))) throw new Error('manifest_protected');
    if (kind === 'tree' && this.policy.protect.some(dir => under(dir, path))) throw new Error('manifest_protected');
    if (kind === 'tree' && this.policy.emptyOnly.includes(path)) throw new Error('manifest_protected');
  }
  async claim(path: string, kind: ManifestEntry['kind'] = 'tree'): Promise<void> {
    this.check(path, kind);
    const taken = await lstat(path).then(() => true, (error: { code?: string }) => error.code !== 'ENOENT');
    if (taken) throw new Error('manifest_path_exists');
    this.entries.push({ path, kind });
  }
  // 실행 전 목록에 없던 것을 확인한 CLI 잔여물. claim과 달리 이미 있다.
  adopt(path: string, before: ReadonlySet<string>): void {
    this.check(path, 'tree');
    if (before.has(path)) throw new Error('manifest_path_exists');
    this.entries.push({ path, kind: 'tree' });
  }
  // 올린 반대 순서로 지운다. 부모 자리(empty_dir)는 비었을 때만 지운다. 판정은 실제 부재다.
  async remove(): Promise<{ deleted: number; left: number }> {
    let deleted = 0;
    let left = 0;
    for (const { path, kind } of [...this.entries].reverse()) {
      const existed = await lstat(path).then(() => true, () => false);
      if (!existed) continue;
      if (kind === 'tree' ? await removeTree(path) : await rmdir(path).then(() => true, () => false)) deleted++;
      else left++;
    }
    this.entries.length = 0;
    return { deleted, left };
  }
  async bytes(limit: number): Promise<number> {
    let total = 0;
    const walk = async (path: string): Promise<void> => {
      if (total > limit) return;
      const info = await lstat(path).catch(() => null);
      if (!info) return;
      total += info.size;
      if (info.isDirectory()) for (const name of await readdir(path).catch(() => [] as string[])) await walk(join(path, name));
    };
    for (const { path, kind } of this.entries) if (kind === 'tree') await walk(path);
    return total;
  }
}

// CLI가 $TMPDIR 밖에 남기는 이름 [실측: 로컬 리허설, VERIFICATION B6]. 실행 전 목록에 없고 이 이름일 때만 지운다. 그 밖의 새 이름은 지우지 않고 세어 보고한다.
// /tmp/cc-socks-<uid>는 경계가 뚫렸거나 TMPDIR가 길 때만 생겨 변형별 manifest가 맡는다.
const CLI_RESIDUE = /^inline-comments-buffer\.jsonl$/;

// 값 없는 메타데이터. 자유 문자열은 싣지 않고 정해진 어휘로 바꾼다.
export interface PodEnvironmentInfo {
  mode: PodMode; execution_path: 'direct_exec_not_tasklane'; source_sha: string | null; image_digest: string | null; pod_uid: string | null;
  uid: number; cli: string | null; bwrap: string | null; socat: string | null; node: string;
  pid1: 'expected' | 'unexpected'; worker_processes: number;
  apparmor: 'homelab-sandbox-worker-v1' | 'unconfined' | 'other' | 'unknown'; seccomp_mode: number | null; no_new_privs: boolean | null; cap_eff_zero: boolean | null;
  uid_map_identity: boolean | null; proc_masked_mounts: number | null; root_read_only: boolean | null; credential_read_only: boolean | null;
  state_fstype: 'ext4' | 'tmpfs' | 'other' | 'unknown'; credential_present: boolean; control_dir_present: boolean; retained_generations: number | null;
}
export type PodMode = 'pod' | 'rehearsal';
export interface PodConfig { mode: PodMode; source_sha?: string; image_digest?: string; pod_uid?: string; src_digest?: string }
export function parsePodConfig(text: string): PodConfig {
  const raw = JSON.parse(text) as Record<string, unknown>;
  const allowed = new Set(['mode', 'source_sha', 'image_digest', 'pod_uid', 'src_digest']);
  // 변형·경로를 고르는 인자가 없다. 모르는 키는 오타이거나 그런 시도라 받지 않는다.
  if (typeof raw !== 'object' || raw === null || Object.keys(raw).some(key => !allowed.has(key))) throw new Error('config_invalid');
  if (raw.mode !== 'pod' && raw.mode !== 'rehearsal') throw new Error('config_invalid');
  const shaped = (value: unknown, pattern: RegExp) => { if (value !== undefined && (typeof value !== 'string' || !pattern.test(value))) throw new Error('config_invalid'); };
  shaped(raw.source_sha, /^[0-9a-f]{40}$/);
  shaped(raw.image_digest, /^sha256:[0-9a-f]{64}$/);
  shaped(raw.pod_uid, /^[0-9a-f-]{36}$/);
  shaped(raw.src_digest, /^[0-9a-f]{64}$/);
  return raw as unknown as PodConfig;
}

// 운영 파드에서 PID 1은 pause고, 리허설의 podman pod에서는 catatonit이다.
const expectedPid1 = (mode: PodMode) => mode === 'pod' ? 'pause' : 'catatonit';

export interface PodDeps {
  paths: PodPaths; config: PodConfig; uid: number; pid: number; srcDir: string;
  versions: () => { cli: string | null; bwrap: string | null; socat: string | null };
  freeBytes: (path: string) => Promise<number>;
}
const SYSTEM_PATH = '/usr/local/bin:/usr/bin:/bin';
function versionOf(command: string, args: readonly string[], pattern: RegExp, env: NodeJS.ProcessEnv): string | null {
  const result = spawnSync(command, args, { encoding: 'utf8', timeout: 10_000, env });
  return pattern.exec(result.stdout ?? '')?.[1] ?? null;
}
export function defaultDeps(config: PodConfig, srcDir: string, paths: PodPaths = POD_PATHS): PodDeps {
  return { paths, config, uid: process.getuid?.() ?? -1, pid: process.pid, srcDir,
    // 이미지 빌드가 같은 env로 /tmp에 아무것도 남지 않음을 확인한다(Dockerfile).
    versions: () => ({ cli: versionOf(paths.cli, ['--version'], /^(\d+\.\d+\.\d+)/, { PATH: SYSTEM_PATH, HOME: paths.tmp, CLAUDE_CONFIG_DIR: paths.tmp, TMPDIR: paths.tmp, DISABLE_UPDATES: '1',
      CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1', DISABLE_TELEMETRY: '1', DISABLE_ERROR_REPORTING: '1' }),
    bwrap: versionOf('bwrap', ['--version'], /bubblewrap (\S+)/, { PATH: SYSTEM_PATH }),
    socat: versionOf('socat', ['-V'], /socat version (\S+)/, { PATH: SYSTEM_PATH }) }),
    freeBytes: path => statfs(path).then(info => info.bavail * info.bsize) };
}

export interface PodScan { complete: boolean; pid1: boolean; workers: number; extra: number }
// 파드 PID 공간을 읽기만 한다. 상주 작업자에게 닿는 신호는 어디서도 보내지 않는다.
export async function scanPod(proc: string, selfPid: number, pid1Name: string): Promise<PodScan> {
  const scan: PodScan = { complete: true, pid1: false, workers: 0, extra: 0 };
  const chain = new Set<number>([selfPid]);
  const statusOf = (pid: number) => readFile(join(proc, String(pid), 'status'), 'utf8');
  let cursor = selfPid;
  for (let hop = 0; hop < 64; hop++) {
    const parent = Number(/^PPid:\s+(\d+)/m.exec(await statusOf(cursor).catch(() => ''))?.[1] ?? 0);
    if (parent <= 0) break;
    chain.add(parent);
    cursor = parent;
  }
  let names: string[];
  try { names = await readdir(proc); } catch { return { ...scan, complete: false }; }
  for (const name of names) {
    if (!/^\d+$/.test(name)) continue;
    const pid = Number(name);
    let status: string;
    try { status = await statusOf(pid); }
    catch (error) { if ((error as { code?: string }).code !== 'ENOENT' && (error as { code?: string }).code !== 'ESRCH') scan.complete = false; continue; }
    if (pid === 1) { scan.pid1 = /^Name:\s+(\S+)/m.exec(status)?.[1] === pid1Name; continue; }
    if (chain.has(pid)) continue;
    // 좀비는 도는 코드가 없다. PID 1이 회수한다.
    if (/^State:\s+[ZXx]/m.test(status)) continue;
    const cmdline = await readFile(join(proc, name, 'cmdline'), 'latin1').catch(() => '');
    if (cmdline === 'node\0dist/src/worker-main.js\0') scan.workers++;
    else scan.extra++;
  }
  return scan;
}
const scanClean = (scan: PodScan) => scan.complete && scan.pid1 && scan.workers === 1 && scan.extra === 0;

// 한 줄 해시. 이미지의 dist/src와 묶음을 만든 곳의 컴파일 결과가 같은지 본다. 다르면 다른 소스를 재는 것이다.
export async function digestTree(dir: string): Promise<string> {
  const hash = createHash('sha256');
  const walk = async (rel: string): Promise<void> => {
    const entries = (await readdir(join(dir, rel), { withFileTypes: true })).sort((a, b) => a.name < b.name ? -1 : a.name > b.name ? 1 : 0);
    for (const entry of entries) {
      const path = rel ? `${rel}/${entry.name}` : entry.name;
      if (entry.isDirectory()) await walk(path);
      else if (entry.isFile() && entry.name.endsWith('.js')) {
        hash.update(`${path}\0`);
        hash.update(await readFile(join(dir, path)));
        hash.update('\0');
      }
    }
  };
  await walk('');
  return hash.digest('hex');
}

function mountOf(mountinfo: string, target: string): { readOnly: boolean; fstype: string } | null {
  for (const line of mountinfo.split('\n').reverse()) {
    const [left, right] = line.split(' - ');
    const fields = left?.split(' ');
    if (!fields || !right || fields[4] !== target) continue;
    return { readOnly: (fields[5] ?? '').split(',').includes('ro'), fstype: right.split(' ')[0] ?? '' };
  }
  return null;
}
async function collectEnvironment(deps: PodDeps, versions: ReturnType<PodDeps['versions']>, scan: PodScan, retained: number | null): Promise<PodEnvironmentInfo> {
  const { proc, root, credentialDir } = deps.paths;
  const readText = (name: string) => readFile(join(proc, name), 'utf8').catch(() => null);
  const status = await readFile(join(proc, String(deps.pid), 'status'), 'utf8').catch(() => '');
  const number = (pattern: RegExp) => { const found = pattern.exec(status)?.[1]; return found === undefined ? null : Number(found); };
  const attr = await readText('self/attr/current');
  const mountinfo = await readText('self/mountinfo');
  const uidMap = await readText('self/uid_map');
  const stateMount = mountinfo ? mountOf(mountinfo, root) : null;
  const credentialFile = join(credentialDir, 'CLAUDE_CODE_OAUTH_TOKEN');
  const capEff = /^CapEff:\s+([0-9a-f]+)/m.exec(status)?.[1];
  return { mode: deps.config.mode, execution_path: 'direct_exec_not_tasklane', source_sha: deps.config.source_sha ?? null, image_digest: deps.config.image_digest ?? null, pod_uid: deps.config.pod_uid ?? null,
    uid: deps.uid, ...versions, node: process.version, pid1: scan.pid1 ? 'expected' : 'unexpected', worker_processes: scan.workers,
    // 이 호스트의 userns 파드는 라벨이 겹쳐 붙어 이름이 그대로 나오지 않을 수 있다(homelab 프로필 주석).
    // 리허설의 podman은 푼 프로필을 `crun (unconfined)`로 보인다 [실측].
    apparmor: attr === null ? 'unknown' : attr.includes('homelab-sandbox-worker-v1') ? 'homelab-sandbox-worker-v1' : /^unconfined|\(unconfined\)/.test(attr.trim()) ? 'unconfined' : 'other',
    seccomp_mode: number(/^Seccomp:\s+(\d+)/m), no_new_privs: number(/^NoNewPrivs:\s+(\d+)/m) === null ? null : number(/^NoNewPrivs:\s+(\d+)/m) === 1,
    cap_eff_zero: capEff === undefined ? null : /^0+$/.test(capEff),
    uid_map_identity: uidMap === null ? null : /^\s*0\s+0\s+4294967295\s*$/.test(uidMap),
    proc_masked_mounts: mountinfo === null ? null : mountinfo.split('\n').filter(line => line.split(' ')[4]?.startsWith('/proc/')).length,
    root_read_only: mountinfo ? mountOf(mountinfo, '/')?.readOnly ?? null : null,
    credential_read_only: mountinfo ? mountOf(mountinfo, credentialDir)?.readOnly ?? null : null,
    state_fstype: !stateMount ? 'unknown' : stateMount.fstype === 'ext4' || stateMount.fstype === 'tmpfs' ? stateMount.fstype : 'other',
    // 열지 않는다. 읽을 수 있는 권한인지만 본다. 샌드박스 안의 ENOENT가 원래 없는 파일 때문이 아님을 보이는 양성 대조다.
    credential_present: await access(credentialFile, constants.R_OK).then(() => true, () => false),
    control_dir_present: await lstat(join(root, '.homelab-worker')).then(info => info.isDirectory(), () => false),
    retained_generations: retained };
}

export type PrecheckFailure = 'uid' | 'cap_eff' | 'proc_unreadable' | 'pid1' | 'worker' | 'extra_process' | 'state_root' | 'control_dir' | 'credential' | 'tasks_listing' | 'path_taken'
  | 'disk_tmp' | 'disk_state' | 'cli_version' | 'bwrap_version' | 'socat_version' | 'bundle_mismatch' | 'plan_over_budget' | 'layout' | 'tmp_changed';
export type PodRowVerdict = 'match' | 'mismatch' | 'not_run';
export interface PodReport {
  schema: 'sec02-pod-report-v1';
  verdict: 'pass' | 'violation' | 'incomplete' | 'precheck_failed';
  environment: PodEnvironmentInfo | null;
  precheck: { ok: boolean; failed: PrecheckFailure[] };
  differences: readonly string[]; skipped_variants: typeof POD_SKIPPED_VARIANTS; limits: typeof POD_LIMITS;
  turns: TurnReport[]; mismatches: string[]; planned_tool_calls: number; tool_calls: number;
  cleanup: { deleted: number; left_paths: number; unknown_new_paths: number; listeners_closed: boolean; children_alive: number; pod_processes_clean: boolean | null; retained_same: boolean | null };
  total_ms: number; aborted: 'total_time' | 'report_size' | 'test_dir_size' | 'signal' | 'setup_failed' | null;
}
// 1단계 대비 차이. 이 밖의 argv·settings·env는 운영 조립 값 그대로다.
export const POD_DIFFERENCES = Object.freeze(['synthetic_oauth_token_env', 'loopback_fake_api_base_url', 'refusing_https_proxy', 'max_retries_0', 'api_timeout_5000', 'synthetic_archive_no_fetch',
  'synthetic_other_generations', 'session_room_check_skipped', 'max_sessions_plus_3', 'direct_exec_not_tasklane', 'no_inherited_credential_fd', 'tool_calls_selected_64']);

const POD_EXPECT: Readonly<Record<string, readonly Outcome[]>> = { ...ENFORCED_EXPECT, ...SCOPE_EXPECT, ...NAMES_EXPECT, ...UNLISTED_EXPECT,
  // 실제 디렉터리 항목 확인은 errno로 막혀도 된다. 내용을 보지 않는다.
  'cred.bash_list': ['masked', 'denied'], 'control.bash_list': ['masked', 'denied'] };
export const rowVerdict = (row: Row): PodRowVerdict => {
  if (row.outcome === 'not_run' && row.error_code !== null && (['real_credential_target', 'real_control_target', 'call_budget'] as readonly ErrorCode[]).includes(row.error_code)) return 'not_run';
  const expected = POD_EXPECT[row.case_id];
  if (!expected?.includes(row.outcome)) return 'mismatch';
  const code = CODE_EXPECT[row.case_id];
  return code && row.error_code !== code ? 'mismatch' : 'match';
};

// 판정. 경계가 뚫린 것(violation)과 재지 못한 것(incomplete)을 가른다. 어느 쪽도 pass가 아니다.
export function judgePodRun(report: Omit<PodReport, 'verdict' | 'mismatches' | 'schema'>): Pick<PodReport, 'verdict' | 'mismatches'> {
  if (!report.precheck.ok) return { verdict: 'precheck_failed', mismatches: [] };
  const mismatches: string[] = [];
  let breached = false;
  const seen = new Set<string>();
  for (const turn of report.turns) {
    const where = `${turn.variant}/${turn.phase}`;
    const note = (condition: boolean, code: string) => { if (!condition) mismatches.push(`${where}:${code}`); };
    seen.add(where);
    for (const row of turn.rows) {
      if (rowVerdict(row) !== 'mismatch') continue;
      mismatches.push(`${where}:${row.case_id}`);
      if (row.outcome === 'allowed') breached = true;
    }
    note(turn.status === 'finished', 'status');
    note(turn.exit_code === 0, 'exit');
    note(turn.init_seen && turn.session_matched, 'session');
    note(turn.tool_calls === turn.planned_tool_calls, 'tool_calls');
    note(Object.keys(turn.api_violations).length === 0, 'api_violation');
    note(turn.auth_mismatch === 0 && turn.api_key_headers === 0, 'auth');
    note(turn.rejected_requests === 0, 'rejected_request');
    note(turn.proxy_refused === 0, 'proxy_contact');
    if (turn.variant === 'unlisted_tools') {
      note(turn.outcome_kind === 'failed' && turn.outcome_reason === 'policy_violation', 'adapter_verdict');
      note(turn.policy_violations === 2, 'policy_violations');
    } else {
      note(turn.outcome_kind === 'output', 'adapter_verdict');
      note(turn.policy_violations === 0, 'policy_violations');
    }
    // 대상이 실제로 있었는지 바깥에서 본 양성 대조. 없으면 0건이 차단의 증거가 아니다.
    if (turn.variant === 'enforced') {
      note((turn.counts['proc.environ_readable'] ?? 0) > 0, 'positive_environ_readable');
      note(turn.counts['socket.own_exists_outside'] === 1, 'positive_socket_exists');
      note(turn.counts['socket.init_path_matches'] === 1, 'positive_socket_path');
    }
    if (turn.variant === 'enforced_scope') note(turn.counts['socket.visible_other'] === 2, 'relay_socket_count');
  }
  for (const turn of POD_TURNS) if (!seen.has(`${turn.variant}/${turn.phase}`)) mismatches.push(`${turn.variant}/${turn.phase}:not_run`);
  const env = report.environment;
  const requireEnv = (condition: boolean, code: string) => { if (!condition) mismatches.push(`environment:${code}`); };
  if (env) {
    requireEnv(env.credential_present, 'credential_present');
    requireEnv(env.control_dir_present, 'control_dir_present');
    requireEnv(env.cap_eff_zero === true, 'cap_eff');
    requireEnv(env.proc_masked_mounts === 0, 'proc_mount');
    requireEnv(env.root_read_only === true, 'root_read_only');
    requireEnv(env.credential_read_only === true, 'credential_read_only');
    requireEnv(env.state_fstype === 'ext4', 'state_fstype');
    if (env.mode === 'pod') {
      requireEnv(env.apparmor === 'homelab-sandbox-worker-v1', 'apparmor');
      requireEnv(env.seccomp_mode === 2, 'seccomp');
      requireEnv(env.uid_map_identity === false, 'host_users');
      requireEnv(env.source_sha !== null, 'source_sha');
    }
  }
  const { cleanup } = report;
  if (cleanup.left_paths || cleanup.unknown_new_paths || !cleanup.listeners_closed || cleanup.children_alive || cleanup.pod_processes_clean !== true || cleanup.retained_same !== true) mismatches.push('cleanup:unclean');
  if (report.aborted) mismatches.push(`aborted:${report.aborted}`);
  if (breached) return { verdict: 'violation', mismatches };
  return { verdict: mismatches.length ? 'incomplete' : 'pass', mismatches };
}

type EncodedPodRow = [string, Row['tool'], boolean, Row['outcome'], Row['error_code'], number | null, PodRowVerdict];
export function encodePodReport(report: PodReport): string {
  return JSON.stringify({ ...report, turns: report.turns.map(turn => ({ ...turn, rows: turn.rows.map((row): EncodedPodRow => [row.case_id, row.tool, row.attempted, row.outcome, row.error_code, row.bytes, rowVerdict(row)]) })) });
}

export class PodRunner {
  private readonly tracker = new ProcessTracker();
  private manifest: PodManifest | null = null;
  private aborted: PodReport['aborted'] = null;
  private toolCalls = 0;
  private totals = { deleted: 0, left: 0 };
  constructor(private readonly deps: PodDeps, private readonly turns: readonly PodTurn[] = POD_TURNS) {}

  private policy(): ManifestPolicy {
    const { root, tmp, credentialDir } = this.deps.paths;
    // 사례표의 /tmp 자리는 고정 이름이다. 운영에서는 tmp와 같다.
    return { roots: [root, tmp, dirname(fallbackSocketDir())], protect: [credentialDir, join(root, '.homelab-worker')], emptyOnly: [join(root, 'tasks')] };
  }
  // 신호·watchdog이 부른다. 자기 그룹만 멈추고, 도는 턴이 끝나면 run이 정리까지 간다.
  requestAbort(reason: 'signal' | 'total_time'): void {
    this.aborted ??= reason;
    this.tracker.stopTurns();
  }
  // run이 끝내지 못할 때의 마지막 수단. 자기 그룹을 끝내고 소멸이 확인되면 올려 둔 경로만 지운다.
  async emergency(): Promise<void> {
    this.tracker.killAll();
    if (await this.tracker.settle(POD_LIMITS.killGraceMs) === 0) await this.manifest?.remove();
  }

  private async precheck(layouts: readonly Sec02Layout[], tmpBefore: ReadonlySet<string>): Promise<{ failed: PrecheckFailure[]; environment: PodEnvironmentInfo | null }> {
    const { paths, config, uid, pid } = this.deps;
    const failed: PrecheckFailure[] = [];
    const pid1Name = expectedPid1(config.mode);
    if (plannedCalls(this.turns) > POD_LIMITS.toolCalls) failed.push('plan_over_budget');
    if (uid !== POD_UID) failed.push('uid');
    const scanFailures = (scan: PodScan) => {
      const found: PrecheckFailure[] = [];
      if (!scan.complete) found.push('proc_unreadable');
      if (!scan.pid1) found.push('pid1');
      if (scan.workers !== 1) found.push('worker');
      if (scan.extra) found.push('extra_process');
      return found;
    };
    // kubectl cp의 tar가 끝나는 중일 수 있다. 시험 프로세스를 띄우기 전이라 잠깐 기다려 다시 본다.
    let scan = await scanPod(paths.proc, pid, pid1Name);
    for (let attempt = 0; attempt < 3 && !scanClean(scan); attempt++) {
      await new Promise(ready => setTimeout(ready, 1000));
      scan = await scanPod(paths.proc, pid, pid1Name);
    }
    const status = await readFile(join(paths.proc, String(pid), 'status'), 'utf8').catch(() => '');
    if (!/^CapEff:\s+0+$/m.test(status)) failed.push('cap_eff');
    const stateRootInfo = await lstat(paths.root).catch(() => null);
    if (!stateRootInfo?.isDirectory()) failed.push('state_root');
    if (!await lstat(join(paths.root, '.homelab-worker')).then(info => info.isDirectory(), () => false)) failed.push('control_dir');
    if (!await access(join(paths.credentialDir, 'CLAUDE_CODE_OAUTH_TOKEN'), constants.R_OK).then(() => true, () => false)) failed.push('credential');
    if (await this.deps.freeBytes(paths.tmp).catch(() => 0) < POD_LIMITS.freeBytes) failed.push('disk_tmp');
    if (await this.deps.freeBytes(paths.root).catch(() => 0) < POD_LIMITS.freeBytes) failed.push('disk_state');
    if (config.src_digest && await digestTree(this.deps.srcDir).catch(() => '') !== config.src_digest) failed.push('bundle_mismatch');
    let retained: number | null = null;
    try { retained = layouts[0] ? await layouts[0].sessions.retained() : null; } catch { failed.push('tasks_listing'); }
    const taken = async (path: string) => lstat(path).then(() => true, (error: { code?: string }) => error.code !== 'ENOENT');
    for (const layout of layouts) {
      for (const path of layout.ownedPaths()) if (await taken(path)) { failed.push('path_taken'); break; }
    }
    // 앞의 문제가 있으면 CLI조차 띄우지 않는다. 버전 확인도 자식 프로세스다.
    const blocked = failed.length > 0 || !scanClean(scan);
    const versions = blocked ? { cli: null, bwrap: null, socat: null } : this.deps.versions();
    if (!blocked) {
      if (versions.cli !== EXPECTED_VERSIONS.cli) failed.push('cli_version');
      if (versions.bwrap !== EXPECTED_VERSIONS.bwrap) failed.push('bwrap_version');
      if (versions.socat !== EXPECTED_VERSIONS.socat) failed.push('socat_version');
      scan = await scanPod(paths.proc, pid, pid1Name);
    }
    failed.push(...scanFailures(scan));
    if ((await this.newNames(paths.tmp, tmpBefore)).length) failed.push('tmp_changed');
    return { failed: [...new Set(failed)], environment: await collectEnvironment(this.deps, versions, scan, retained) };
  }
  private async newNames(dir: string, before: ReadonlySet<string>): Promise<string[]> {
    return (await readdir(dir).catch(() => [] as string[])).map(name => join(dir, name)).filter(path => !before.has(path));
  }
  private async listing(dir: string): Promise<Set<string>> {
    return new Set((await readdir(dir).catch(() => [] as string[])).map(name => join(dir, name)));
  }

  private async runVariant(variant: PodVariant, layout: Sec02Layout, deadline: number, reports: TurnReport[], closed: { listeners: boolean }): Promise<void> {
    const { paths } = this.deps;
    const manifest = new PodManifest(this.policy());
    this.manifest = manifest;
    const tasks = join(paths.root, 'tasks');
    if (!await lstat(tasks).then(() => true, () => false)) await manifest.claim(tasks, 'empty_dir');
    for (const path of layout.ownedPaths()) await manifest.claim(path);
    const fallback = fallbackSocketDir();
    // 경계가 뚫렸을 때만 생기는 자리다. 이미 있으면 그 안의 시험 파일 이름만 올린다.
    // 다른 tmp로 도는 단위 시험에서는 올리지 않는다. 개발 기계의 이 자리는 다른 CLI 세션의 소켓일 수 있다.
    if (dirname(fallback) === paths.tmp) {
      if (await lstat(fallback).then(() => true, () => false)) await manifest.claim(join(fallback, 'sec02-write-new'));
      else await manifest.claim(fallback);
    }
    const remaining = POD_LIMITS.toolCalls - this.toolCalls;
    const api = new FakeMessagesApi({ token: layout.token, budget: remaining, onViolation: () => this.tracker.stopTurns() });
    const proxy = new RefusingProxy();
    try {
      const ports = { api: await api.listen(), proxy: await proxy.listen() };
      await layout.build();
      const real = { credentialDir: paths.credentialDir, controlDir: layout.sessions.controlDir };
      for (const turn of this.turns.filter(item => item.variant === variant)) {
        if (this.aborted || Date.now() >= deadline) { this.aborted ??= 'total_time'; break; }
        let dirs = layout.session.dirs;
        if (turn.phase === 'resume') {
          // 재개는 운영과 같이 세션 기록과 대화 파일을 확인한 뒤에만 연다.
          await layout.recordTurn(1);
          dirs = (await layout.openResume()).session.dirs;
        }
        const selected = selectSteps(turn, layout);
        const steps: Sec02Step[] = [];
        const refused: Row[] = [];
        for (const step of selected.steps) {
          if (await stepTargetsReal(step.build(PLAN_CONTEXT), { ...real, workspace: dirs.workspace })) refused.push(notRun(step.name, step.tool, 'unsafe_target'));
          else steps.push(step);
        }
        const report = await runTurn({ variant, operation: turn.phase, dirs, sandbox: { credentialDir: paths.credentialDir, controlDir: layout.sessions.controlDir, others: layout.others },
          deadline, layout, api, proxy, ports, steps, cli: paths.cli, tracker: this.tracker,
          afterStep: async () => {
            if (await manifest.bytes(POD_LIMITS.testDirBytes) > POD_LIMITS.testDirBytes) { this.aborted ??= 'test_dir_size'; this.tracker.stopTurns(); }
          } });
        report.planned_tool_calls = selected.steps.length + 1;
        report.rows.push(...refused, ...selected.notRun);
        reports.push(report);
        this.toolCalls += report.tool_calls;
      }
    } finally {
      await this.tracker.stopSentinel();
      await api.close();
      await proxy.close();
      closed.listeners &&= !api.listening && !proxy.listening;
      // 순서가 계약이다: listener 닫힘 → 자기 자식 소멸 확인 → 그 뒤에만 manifest 삭제. 살아 있는 프로세스가 쓰는 공간은 지우지 않는다.
      this.tracker.stopTurns();
      let alive = await this.tracker.settle(POD_LIMITS.killGraceMs);
      if (alive) { this.tracker.killAll(); alive = await this.tracker.settle(POD_LIMITS.killGraceMs); }
      if (alive) this.totals.left += manifest.entries.length;
      else {
        const removed = await manifest.remove();
        this.totals.deleted += removed.deleted;
        this.totals.left += removed.left;
      }
      this.manifest = null;
    }
  }

  async run(): Promise<PodReport> {
    const started = Date.now();
    const deadline = started + POD_LIMITS.totalMs;
    const { paths, config, pid } = this.deps;
    const reports: TurnReport[] = [];
    const closed = { listeners: true };
    const tmpBefore = await this.listing(paths.tmp);
    const stateBefore = await this.listing(paths.root);
    const variants = POD_VARIANTS.filter(variant => this.turns.some(turn => turn.variant === variant));
    let failedLayout = false;
    const layouts = new Map<PodVariant, Sec02Layout>();
    try {
      // 생성자는 파일을 만들지 않는다. 경로 대조에 UUID가 필요해 먼저 만든다.
      for (const variant of variants) layouts.set(variant, new Sec02Layout({ root: paths.root, credentialDir: paths.credentialDir, realMounts: true }));
    } catch { failedLayout = true; }
    const pre = failedLayout ? { failed: ['layout'] as PrecheckFailure[], environment: null } : await this.precheck([...layouts.values()], tmpBefore);
    const base = { environment: pre.environment, precheck: { ok: pre.failed.length === 0, failed: pre.failed }, differences: POD_DIFFERENCES, skipped_variants: POD_SKIPPED_VARIANTS, limits: POD_LIMITS,
      planned_tool_calls: plannedCalls(this.turns) };
    if (pre.failed.length) {
      const empty = { ...base, turns: [], tool_calls: 0, total_ms: Date.now() - started, aborted: null,
        cleanup: { deleted: 0, left_paths: 0, unknown_new_paths: 0, listeners_closed: true, children_alive: 0, pod_processes_clean: null, retained_same: null } };
      return { schema: 'sec02-pod-report-v1', ...empty, ...judgePodRun(empty) };
    }
    const anyLayout = [...layouts.values()][0]!;
    const retainedBefore = await anyLayout.sessions.others(anyLayout.job, 1).catch(() => null);
    const hardStop = setTimeout(() => this.requestAbort('total_time'), POD_LIMITS.totalMs);
    for (const variant of variants) {
      if (this.aborted || Date.now() >= deadline) { this.aborted ??= 'total_time'; break; }
      try { await this.runVariant(variant, layouts.get(variant)!, deadline, reports, closed); }
      catch { this.aborted ??= 'setup_failed'; }
    }
    clearTimeout(hardStop);
    const children = await this.tracker.settle(POD_LIMITS.settleMs);
    // 실행 전에 없던 CLI 잔여물만 지운다. 모르는 이름은 지우지 않고 세어 보고한다.
    const residue = new PodManifest(this.policy());
    let unknown = 0;
    for (const dir of [paths.tmp, paths.root]) {
      const before = dir === paths.tmp ? tmpBefore : stateBefore;
      for (const path of await this.newNames(dir, before)) {
        const name = path.slice(dir.length + 1);
        if (dir === paths.tmp && CLI_RESIDUE.test(name)) residue.adopt(path, before);
        else if (dir === paths.root && name === 'tasks') continue;
        else unknown++;
      }
    }
    if (!children) {
      const removed = await residue.remove();
      this.totals.deleted += removed.deleted;
      this.totals.left += removed.left;
    }
    const retainedAfter = await anyLayout.sessions.others(anyLayout.job, 1).catch(() => null);
    // bwrap·socat가 그룹 밖으로 나갔으면 PID 1 회수까지 시간이 걸린다. 끝낼 수단은 쓰지 않고 기다려 본 뒤 그대로 보고한다.
    let finalScan = await scanPod(paths.proc, pid, expectedPid1(config.mode));
    const settleUntil = Date.now() + POD_LIMITS.settleMs;
    while (!scanClean(finalScan) && Date.now() < settleUntil) {
      await new Promise(ready => setTimeout(ready, 200));
      finalScan = await scanPod(paths.proc, pid, expectedPid1(config.mode));
    }
    const body = { ...base, turns: reports, tool_calls: this.toolCalls, total_ms: Date.now() - started, aborted: this.aborted,
      cleanup: { deleted: this.totals.deleted, left_paths: this.totals.left, unknown_new_paths: unknown, listeners_closed: closed.listeners, children_alive: children,
        pod_processes_clean: scanClean(finalScan), retained_same: retainedBefore !== null && retainedAfter !== null && JSON.stringify(retainedBefore) === JSON.stringify(retainedAfter) } };
    const report: PodReport = { schema: 'sec02-pod-report-v1', ...body, ...judgePodRun(body) };
    if (Buffer.byteLength(encodePodReport(report)) > POD_LIMITS.reportBytes) {
      const shrunk = { ...body, aborted: 'report_size' as const, turns: reports.map(turn => ({ ...turn, rows: [], counts: {} })) };
      return { schema: 'sec02-pod-report-v1', ...shrunk, verdict: report.verdict === 'violation' ? 'violation' : 'incomplete', mismatches: [...report.mismatches.slice(0, 64), 'aborted:report_size'] };
    }
    return report;
  }
}
export const POD_REPORT_MARKER = 'SEC02_POD_REPORT ';
