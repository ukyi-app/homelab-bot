import { spawnSync } from 'node:child_process';
import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { chmod, lstat, mkdir, mkdtemp, readFile, readdir, readlink, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { FakeMessagesApi, RefusingProxy, TOOL_CALL_BUDGET } from './sec02-fake-api.js';
import { Sec02Layout, caseTable } from './sec02-fixture.js';
import type { Row } from './sec02-fixture.js';
import { VARIANTS } from './sec02-harness.js';
import { POD_BUNDLE_FILES, buildPodBundle } from './sec02-pod-bundle.js';
import { PLAN_CONTEXT, POD_LIMITS, POD_REPORT_MARKER, POD_TURNS, POD_UID, POD_VARIANTS, PodManifest, PodRunner, assertPodVariant, digestTree, encodePodReport, judgePodRun, parsePodConfig, plannedCalls, rowVerdict,
  scanPod, selectSteps, stepTargetsReal } from './sec02-pod.js';
import type { ManifestPolicy, PodDeps, PodEnvironmentInfo, PodReport, PodTurn } from './sec02-pod.js';
import { ProcessTracker, runTurn } from './sec02-turn.js';
import type { TurnReport } from './sec02-turn.js';

// SEC-02 2단계 실행기 단위 시험. CLI 없이 돈다. 실제 경계 측정은 파드와 로컬 리허설 몫이다(VERIFICATION "SEC-02 2단계 실행안").
const scratch = await realpath(await mkdtemp(join(tmpdir(), 't18-sec02-pod-')));
after(async () => { await rm(scratch, { recursive: true, force: true }); });
let serial = 0;
const fresh = async (name: string) => { const dir = join(scratch, `${name}-${++serial}`); await mkdir(dir, { recursive: true }); return dir; };
const here = dirname(fileURLToPath(import.meta.url));

async function realLayout() {
  const root = await fresh('state');
  const credentialDir = await fresh('credential');
  await writeFile(join(credentialDir, 'CLAUDE_CODE_OAUTH_TOKEN'), 'real-value-must-not-move', { mode: 0o440 });
  await mkdir(join(root, '.homelab-worker', 'nonces'), { recursive: true });
  await writeFile(join(root, '.homelab-worker', 'nonces', 'keep'), 'nonce');
  const layout = new Sec02Layout({ root, credentialDir, realMounts: true });
  return { root, credentialDir, layout };
}

test('운영 변형: deny를 푸는 대조군을 고를 수 없다. 설정에도 변형 인자가 없고 실행 경로에 adjust·fd 상속이 없다', async () => {
  const controls = VARIANTS.filter(name => !(POD_VARIANTS as readonly string[]).includes(name));
  assert.ok(controls.includes('unguarded') && controls.includes('no_permission_deny') && controls.includes('legacy_scope'));
  for (const name of controls) assert.throws(() => assertPodVariant(name), /variant_not_allowed_in_pod/, name);
  for (const name of POD_VARIANTS) assert.doesNotThrow(() => assertPodVariant(name));
  assert.equal((POD_VARIANTS as readonly string[]).includes('long_tmpdir'), false, '상태 루트를 옮겨야 해 돌리지 않는다');
  const { layout } = await realLayout();
  await layout.build();
  for (const variant of ['unguarded', 'no_block_outside', 'legacy_unscoped']) {
    assert.throws(() => selectSteps({ variant, phase: 'start', keep: [] } as unknown as PodTurn, layout), /variant_not_allowed_in_pod/);
  }
  for (const key of ['variants', 'root', 'credentialDir', 'cli', 'unguarded']) assert.throws(() => parsePodConfig(JSON.stringify({ mode: 'pod', [key]: 'x' })), /config_invalid/, key);
  assert.throws(() => parsePodConfig('{"mode":"other"}'), /config_invalid/);
  assert.throws(() => parsePodConfig('{"mode":"pod","source_sha":"short"}'), /config_invalid/);
  assert.deepEqual(parsePodConfig(`{"mode":"pod","source_sha":"${'a'.repeat(40)}"}`), { mode: 'pod', source_sha: 'a'.repeat(40) });
  const code = await readFile(join(here, 'sec02-pod.js'), 'utf8');
  for (const word of ['adjust', 'inheritDirFd', 'variantSettings', 'unscopedAllowArgs', "readdir(this.config.root"]) assert.equal(code.includes(word), false, word);
});

test('배포 묶음: 하네스와 대조군 코드가 없고 import가 묶음 안과 이미지 dist/src로 닫혀 있다', async () => {
  for (const name of ['sec02-harness.js', 'sec02-run.js', 'sec02-boundary.test.js']) assert.equal(POD_BUNDLE_FILES.includes(name), false, name);
  for (const name of POD_BUNDLE_FILES) {
    const code = await readFile(join(here, name), 'utf8');
    for (const match of code.matchAll(/\bfrom\s+'([^']+)'|\bimport\s+'([^']+)'/g)) {
      const target = match[1] ?? match[2]!;
      if (target.startsWith('node:')) continue;
      if (target.startsWith('./')) assert.ok(POD_BUNDLE_FILES.includes(target.slice(2)), `${name} → ${target}`);
      else if (target.startsWith('../src/')) await lstat(join(here, '..', 'src', target.slice('../src/'.length)));
      else assert.fail(`${name} → ${target}: 묶음은 이미지의 node_modules를 직접 부르지 않는다`);
    }
    for (const word of ['sandbox: { enabled: false }', 'permissions: {}']) assert.equal(code.includes(word), false, `${name}: ${word}`);
  }
  const out = await fresh('bundle');
  const dist = join(here, '..');
  const { dir, srcDigest } = await buildPodBundle(dist, out, '/image/dist/src');
  assert.deepEqual((await readdir(join(dir, 'test'))).sort(), [...POD_BUNDLE_FILES].sort());
  assert.equal(await readlink(join(dir, 'src')), '/image/dist/src');
  assert.equal(JSON.parse(await readFile(join(dir, 'package.json'), 'utf8')).type, 'module');
  assert.equal(srcDigest, await digestTree(join(dist, 'src')));
  assert.match(srcDigest, /^[0-9a-f]{64}$/);
});

test('호출 계획: 합계가 상한 안이고, 실제 자격·제어를 파일 도구로 겨누는 사례는 not_run이다', async () => {
  assert.equal(TOOL_CALL_BUDGET, 64);
  assert.ok(plannedCalls(POD_TURNS) <= POD_LIMITS.toolCalls, `${plannedCalls(POD_TURNS)}회`);
  const { layout, credentialDir, root } = await realLayout();
  await layout.build();
  const real = { credentialDir, controlDir: join(root, '.homelab-worker'), workspace: layout.session.dirs.workspace };
  const allRows: Row[] = [];
  for (const turn of POD_TURNS) {
    const { steps, notRun } = selectSteps(turn, layout);
    assert.deepEqual(steps.map(step => step.name).sort(), [...turn.keep].sort(), `${turn.variant}/${turn.phase}`);
    allRows.push(...notRun);
    for (const row of notRun) { assert.equal(row.attempted, false); assert.equal(row.outcome, 'not_run'); }
    // 고른 사례 전부가 대상 점검을 통과한다. 실패하면 실행기는 호출하지 않고 unsafe_target으로 끝낸다.
    for (const step of steps) assert.equal(await stepTargetsReal(step.build(PLAN_CONTEXT), real), false, step.name);
  }
  const code = (id: string) => allRows.find(row => row.case_id === id)?.error_code;
  for (const id of ['cred.read', 'cred.read_symlink', 'cred.read_proc_root', 'cred.read_proc_fd', 'scope.write_cred_new']) assert.equal(code(id), 'real_credential_target', id);
  for (const id of ['control.read', 'control.read_symlink', 'control.edit', 'control.edit_symlink', 'control.write_new', 'control.write_symlink_dir', 'control.write_proc_root', 'control.bash_read', 'control.bash_symlink', 'control.bash_proc_root', 'control.bash_write']) assert.equal(code(id), 'real_control_target', id);
  assert.equal(code('scope.write_empty_existing'), 'call_budget');
});

test('Bash probe: 실제 자격 경로는 open·항목 확인만 부르고, 파일 내용을 읽는 명령이 그 경로에 없다', async () => {
  const { layout, credentialDir, root } = await realLayout();
  await layout.build();
  const enforced = POD_TURNS.find(turn => turn.variant === 'enforced')!;
  const steps = selectSteps(enforced, layout).steps;
  const commands = steps.filter(step => step.tool === 'Bash').map(step => String(step.build(PLAN_CONTEXT).input.command));
  const lines = commands.flatMap(command => command.split('\n')).filter(line => line.includes(credentialDir) || line.includes(join(root, '.homelab-worker')));
  assert.ok(lines.length >= 7, '자격 open·별칭·제어 항목 확인이 실제로 있다');
  for (const line of lines) assert.match(line, /^(sec02_open|sec02_seen) [a-z0-9_.]+ '/, line);
  assert.ok(lines.some(line => line.startsWith('sec02_open cred.bash_open')));
  assert.ok(lines.some(line => line.startsWith('sec02_open escape.cred_open')));
  assert.ok(lines.some(line => line.startsWith('sec02_seen control.bash_list')));
  // open은 fd를 열었다 subshell과 함께 닫고 read를 하지 않는다. 항목 확인은 있다/없다만 낸다.
  const prelude = commands[0]!;
  assert.match(prelude, /sec02_open\(\)\{ if e=\$\( \( exec 3<"\$2" \) 2>&1 \)/);
  assert.match(prelude, /sec02_seen\(\)\{[^\n]*sec02_line "\$1" present; else sec02_line "\$1" absent;/);
});

test('대상 점검: 실제 자격·제어로 가는 호출은 경로를 비틀어도 잡는다', async () => {
  const { layout, credentialDir, root } = await realLayout();
  await layout.build();
  const controlDir = join(root, '.homelab-worker');
  const workspace = layout.session.dirs.workspace;
  const real = { credentialDir, controlDir, workspace };
  const targets = async (file_path: string) => stepTargetsReal({ tool: 'Read', input: { file_path } }, real);
  assert.equal(await targets(join(credentialDir, 'CLAUDE_CODE_OAUTH_TOKEN')), true);
  assert.equal(await targets(`/proc/self/root${credentialDir}/CLAUDE_CODE_OAUTH_TOKEN`), true);
  assert.equal(await targets(layout.path('link.cred')), true, '작업 공간의 심링크');
  assert.equal(await targets('/proc/self/fd/9/CLAUDE_CODE_OAUTH_TOKEN'), true);
  assert.equal(await targets(join(controlDir, 'nonces', 'new')), true, '없는 파일 쓰기도');
  assert.equal(await targets(`${workspace}/../../../../.homelab-worker/x`), true);
  assert.equal(await targets(join(workspace, 'src/ok.txt')), false);
  assert.equal(await stepTargetsReal({ tool: 'Write', input: {} }, real), true, '대상을 모르면 나가지 않는다');
  assert.equal(await stepTargetsReal({ tool: 'Bash', input: { command: `cat ${credentialDir}/CLAUDE_CODE_OAUTH_TOKEN` } }, real), true);
  assert.equal(await stepTargetsReal({ tool: 'Bash', input: { command: `sec02_open cred.bash_open '${credentialDir}/CLAUDE_CODE_OAUTH_TOKEN'; cat x` } }, real), true, '한 줄에 명령을 덧붙여도');
  assert.equal(await stepTargetsReal({ tool: 'Bash', input: { command: `sec02_open cred.bash_open '${credentialDir}/CLAUDE_CODE_OAUTH_TOKEN'` } }, real), false);
});

test('실제 마운트 fixture: 자격·제어 경로에 아무것도 만들지 않고 합성 canary도 두지 않는다. 보존 폴더를 훑지 않는다', async () => {
  const { layout, credentialDir, root } = await realLayout();
  // 다른 작업의 보존 폴더가 권한 000이어도 시험 세션은 선다. 훑었으면 assertRoom이 EACCES로 실패한다.
  const retained = join(root, 'tasks', '11111111-1111-4111-8111-111111111111', '1');
  await mkdir(join(retained, 'workspace'), { recursive: true });
  await writeFile(join(retained, 'workspace', 'secret-looking'), 'retained');
  await chmod(retained, 0o000);
  try {
    const before = { cred: await readdir(credentialDir), control: await readdir(join(root, '.homelab-worker')) };
    await layout.build();
    assert.deepEqual(await readdir(credentialDir), before.cred);
    assert.deepEqual(await readdir(join(root, '.homelab-worker')), before.control);
    assert.equal(await readFile(join(credentialDir, 'CLAUDE_CODE_OAUTH_TOKEN'), 'utf8'), 'real-value-must-not-move');
    assert.ok(layout.others.includes(retained), '실제 보존 작업도 가림 목록에 든다');
    assert.ok(layout.others.includes(layout.sessions.paths(layout.otherJob, 1).root), '합성 다른 작업도');
    assert.throws(() => layout.canary('control.canary'), /fixture_name/);
    for (const name of ['link.control', 'link.control_edit', 'link.control_dir']) await assert.rejects(lstat(layout.path(name)), name);
    await layout.restore();
    assert.deepEqual(await readdir(credentialDir), before.cred, 'restore도 건드리지 않는다');
  } finally { await chmod(retained, 0o700); }
  assert.equal(await readFile(join(retained, 'workspace', 'secret-looking'), 'utf8'), 'retained');
});

const policy = (root: string, tmp: string, credential: string): ManifestPolicy => ({ roots: [root, tmp], protect: [credential, join(root, '.homelab-worker')], emptyOnly: [join(root, 'tasks')] });

test('manifest: 올린 정확한 경로만 지운다. 보존 작업·제어·자격과 옆 파일은 그대로다', async () => {
  const root = await fresh('m-root');
  const tmp = await fresh('m-tmp');
  const credential = await fresh('m-cred');
  const tasks = join(root, 'tasks');
  const retained = join(tasks, '22222222-2222-4222-8222-222222222222');
  const own = join(tasks, '33333333-3333-4333-8333-333333333333');
  const control = join(root, '.homelab-worker');
  await mkdir(retained, { recursive: true });
  await mkdir(control);
  await writeFile(join(retained, 'keep'), 'keep');
  await writeFile(join(control, 'nonce'), 'n');
  await writeFile(join(credential, 'token'), 't');
  await writeFile(join(root, 'neighbor'), 'n');
  await writeFile(join(tmp, 'neighbor'), 'n');
  const manifest = new PodManifest(policy(root, tmp, credential));
  await manifest.claim(own);
  const stray = join(tasks, 'sec02-not-a-uuid');
  await manifest.claim(stray);
  await mkdir(join(own, '1', 'workspace'), { recursive: true });
  await writeFile(join(own, '1', 'workspace', 'f'), 'x');
  await chmod(join(own, '1'), 0o000);
  await writeFile(stray, 'made by a breach');
  assert.deepEqual(await manifest.remove(), { deleted: 2, left: 0 });
  assert.deepEqual((await readdir(tasks)).sort(), ['22222222-2222-4222-8222-222222222222']);
  assert.equal(await readFile(join(retained, 'keep'), 'utf8'), 'keep');
  assert.equal(await readFile(join(control, 'nonce'), 'utf8'), 'n');
  assert.equal(await readFile(join(credential, 'token'), 'utf8'), 't');
  assert.equal(await readFile(join(root, 'neighbor'), 'utf8'), 'n');
  assert.equal(await readFile(join(tmp, 'neighbor'), 'utf8'), 'n');
});

test('manifest: 이미 있던 경로·와일드카드·보호 경로·루트 밖·상위 경로는 올릴 수 없다', async () => {
  const root = await fresh('n-root');
  const tmp = await fresh('n-tmp');
  const credential = await fresh('n-cred');
  const tasks = join(root, 'tasks');
  const retained = join(tasks, '44444444-4444-4444-8444-444444444444');
  await mkdir(retained, { recursive: true });
  await mkdir(join(root, '.homelab-worker'));
  const manifest = new PodManifest(policy(root, tmp, credential));
  await assert.rejects(manifest.claim(retained), /manifest_path_exists/, '실제 보존 작업');
  await assert.rejects(manifest.claim(join(tasks, '*')), /manifest_path_invalid/);
  await assert.rejects(manifest.claim(`${root}/tasks/../x`), /manifest_path_invalid/);
  await assert.rejects(manifest.claim('relative'), /manifest_path_invalid/);
  await assert.rejects(manifest.claim(join(root, '.homelab-worker', 'new')), /manifest_protected/);
  await assert.rejects(manifest.claim(join(credential, 'new')), /manifest_outside_roots/, '자격은 루트 밖이다');
  await assert.rejects(manifest.claim(root), /manifest_outside_roots/, '상태 루트 자체');
  await assert.rejects(manifest.claim('/etc/passwd'), /manifest_outside_roots/);
  await assert.rejects(manifest.claim(tasks), /manifest_protected/, 'tasks를 통째로 지울 수 없다');
  const insideCredentialPolicy = new PodManifest({ roots: [dirname(credential)], protect: [credential], emptyOnly: [] });
  await assert.rejects(insideCredentialPolicy.claim(join(credential, 'x')), /manifest_protected/);
  await assert.rejects(insideCredentialPolicy.claim(dirname(credential)), /manifest_outside_roots/);
  assert.throws(() => manifest.adopt(join(tmp, 'old'), new Set([join(tmp, 'old')])), /manifest_path_exists/, '실행 전에 있던 잔여물은 지우지 않는다');
  assert.equal(manifest.entries.length, 0);
});

test('manifest: 부모 자리는 비었을 때만 지운다. 파일 상한을 잰다', async () => {
  const root = await fresh('e-root');
  const tmp = await fresh('e-tmp');
  const credential = await fresh('e-cred');
  const tasks = join(root, 'tasks');
  const manifest = new PodManifest(policy(root, tmp, credential));
  await manifest.claim(tasks, 'empty_dir');
  const own = join(tasks, '55555555-5555-4555-8555-555555555555');
  await manifest.claim(own);
  await mkdir(own, { recursive: true });
  await writeFile(join(own, 'big'), Buffer.alloc(4096));
  await writeFile(join(tasks, 'someone-else'), 'x');
  assert.ok(await manifest.bytes(1024 * 1024) >= 4096);
  assert.deepEqual(await manifest.remove(), { deleted: 1, left: 1 });
  assert.deepEqual(await readdir(tasks), ['someone-else']);
});

// /proc 흉내. 실행기가 읽는 파일만 둔다.
async function fakeProc(entries: { pid: number; name: string; cmdline?: string; ppid?: number; state?: string; capEff?: string }[]): Promise<string> {
  const proc = await fresh('proc');
  for (const entry of entries) {
    await mkdir(join(proc, String(entry.pid)));
    await writeFile(join(proc, String(entry.pid), 'status'), `Name:\t${entry.name}\nState:\t${entry.state ?? 'S'} (sleeping)\nPPid:\t${entry.ppid ?? 0}\nCapEff:\t${entry.capEff ?? '0000000000000000'}\nSeccomp:\t2\nNoNewPrivs:\t1\n`);
    await writeFile(join(proc, String(entry.pid), 'cmdline'), entry.cmdline ?? '');
  }
  return proc;
}
const SELF = 700;
const WORKER_LINE = 'node\0dist/src/worker-main.js\0';
const cleanProc = () => fakeProc([{ pid: 1, name: 'pause' }, { pid: 7, name: 'node', cmdline: WORKER_LINE }, { pid: SELF, name: 'node', cmdline: 'node\0/tmp/sec02/test/sec02-pod-run.js\0' }]);

test('프로세스 점검: pause·worker·자기 조상 체인만 허용한다. 좀비는 세지 않는다', async () => {
  assert.deepEqual(await scanPod(await cleanProc(), SELF, 'pause'), { complete: true, pid1: true, workers: 1, extra: 0 });
  const withShell = await fakeProc([{ pid: 1, name: 'pause' }, { pid: 7, name: 'node', cmdline: WORKER_LINE }, { pid: 600, name: 'sh', ppid: 0 }, { pid: SELF, name: 'node', ppid: 600 }]);
  assert.equal((await scanPod(withShell, SELF, 'pause')).extra, 0, '조상 체인');
  const extra = await fakeProc([{ pid: 1, name: 'pause' }, { pid: 7, name: 'node', cmdline: WORKER_LINE }, { pid: 8, name: 'claude', cmdline: 'claude\0-p\0' }, { pid: 9, name: 'x', state: 'Z' }, { pid: SELF, name: 'node' }]);
  assert.deepEqual(await scanPod(extra, SELF, 'pause'), { complete: true, pid1: true, workers: 1, extra: 1 });
  const noPause = await fakeProc([{ pid: 1, name: 'node', cmdline: WORKER_LINE }, { pid: SELF, name: 'node' }]);
  assert.deepEqual(await scanPod(noPause, SELF, 'pause'), { complete: true, pid1: false, workers: 0, extra: 0 });
});

async function precheckDeps(overrides: { uid?: number; proc?: string; versions?: Partial<ReturnType<PodDeps['versions']>>; free?: number; srcDigest?: string; root?: string; noCredential?: boolean; noControl?: boolean; calls?: { versions: number } }) {
  const root = overrides.root ?? await fresh('p-root');
  const tmp = await fresh('p-tmp');
  const credentialDir = await fresh('p-cred');
  const srcDir = await fresh('p-src');
  await writeFile(join(srcDir, 'a.js'), 'x');
  if (!overrides.noCredential) await writeFile(join(credentialDir, 'CLAUDE_CODE_OAUTH_TOKEN'), 'real', { mode: 0o440 });
  if (!overrides.noControl) await mkdir(join(root, '.homelab-worker'), { recursive: true });
  const deps: PodDeps = { paths: { root, tmp, credentialDir, cli: '/nonexistent/claude', proc: overrides.proc ?? await cleanProc() },
    config: { mode: 'pod', ...(overrides.srcDigest ? { src_digest: overrides.srcDigest } : {}) }, uid: overrides.uid ?? POD_UID, pid: SELF, srcDir,
    versions: () => { if (overrides.calls) overrides.calls.versions++; return { cli: '2.1.308', bwrap: '0.12.0', socat: '1.8.0.3', ...overrides.versions }; },
    freeBytes: async () => overrides.free ?? 1024 * 1024 * 1024 };
  return { deps, root, tmp, credentialDir };
}
const snapshot = async (dir: string): Promise<string[]> => {
  const found: string[] = [];
  const walk = async (rel: string): Promise<void> => {
    for (const name of await readdir(join(dir, rel))) { found.push(join(rel, name)); if ((await lstat(join(dir, rel, name))).isDirectory()) await walk(join(rel, name)); }
  };
  await walk('');
  return found.sort();
};

test('사전 점검: 하나라도 어긋나면 precheck_failed이고 아무것도 만들지 않는다. CLI 자식도 앞의 점검이 통과해야 띄운다', async () => {
  const extraProc = () => fakeProc([{ pid: 1, name: 'pause' }, { pid: 7, name: 'node', cmdline: WORKER_LINE }, { pid: 8, name: 'task', cmdline: 'task\0' }, { pid: SELF, name: 'node' }]);
  const cases: { label: string; expected: string; options: () => Promise<Parameters<typeof precheckDeps>[0]>; versionsCalled?: number }[] = [
    { label: 'uid', expected: 'uid', options: async () => ({ uid: 1000 }), versionsCalled: 0 },
    { label: '다른 프로세스', expected: 'extra_process', options: async () => ({ proc: await extraProc() }), versionsCalled: 0 },
    { label: 'pause 없음', expected: 'pid1', options: async () => ({ proc: await fakeProc([{ pid: 1, name: 'init' }, { pid: 7, name: 'node', cmdline: WORKER_LINE }, { pid: SELF, name: 'node' }]) }), versionsCalled: 0 },
    { label: 'worker 없음', expected: 'worker', options: async () => ({ proc: await fakeProc([{ pid: 1, name: 'pause' }, { pid: SELF, name: 'node' }]) }), versionsCalled: 0 },
    { label: 'CapEff', expected: 'cap_eff', options: async () => ({ proc: await fakeProc([{ pid: 1, name: 'pause' }, { pid: 7, name: 'node', cmdline: WORKER_LINE }, { pid: SELF, name: 'node', capEff: '00000000a80425fb' }]) }), versionsCalled: 0 },
    { label: '여유 공간', expected: 'disk_tmp', options: async () => ({ free: 1024 }), versionsCalled: 0 },
    { label: '자격 파일', expected: 'credential', options: async () => ({ noCredential: true }), versionsCalled: 0 },
    { label: '제어 경로', expected: 'control_dir', options: async () => ({ noControl: true }), versionsCalled: 0 },
    { label: 'CLI 버전', expected: 'cli_version', options: async () => ({ versions: { cli: '2.1.309' } }), versionsCalled: 1 },
    { label: 'bwrap 버전', expected: 'bwrap_version', options: async () => ({ versions: { bwrap: '0.11.1' } }), versionsCalled: 1 },
    { label: 'socat 버전', expected: 'socat_version', options: async () => ({ versions: { socat: null } }), versionsCalled: 1 },
    { label: '묶음 불일치', expected: 'bundle_mismatch', options: async () => ({ srcDigest: 'f'.repeat(64) }), versionsCalled: 0 },
  ];
  for (const item of cases) {
    const calls = { versions: 0 };
    const { deps, root, tmp, credentialDir } = await precheckDeps({ ...await item.options(), calls });
    const before = await Promise.all([root, tmp, credentialDir].map(snapshot));
    const report = await new PodRunner(deps).run();
    assert.equal(report.verdict, 'precheck_failed', item.label);
    assert.equal(report.precheck.failed.includes(item.expected as never), true, `${item.label}: ${report.precheck.failed.join(',')}`);
    assert.deepEqual(report.turns, [], item.label);
    assert.deepEqual(await Promise.all([root, tmp, credentialDir].map(snapshot)), before, `${item.label}: 생성 0`);
    assert.equal(report.cleanup.deleted, 0);
    if (item.versionsCalled !== undefined) assert.equal(calls.versions, item.versionsCalled, `${item.label}: 버전 자식`);
  }
});

test('사전 점검: tasks에 UUID 아닌 이름이 있거나 실행기가 쓸 고정 자리가 차 있으면 멈추고 그 자리를 지우지 않는다', async () => {
  const taken = await fresh('t-root');
  await mkdir(join(taken, 'sec02-outside'));
  await writeFile(join(taken, 'sec02-outside', 'someone'), 'x');
  const first = await precheckDeps({ root: taken });
  const report = await new PodRunner(first.deps).run();
  assert.equal(report.verdict, 'precheck_failed');
  assert.ok(report.precheck.failed.includes('path_taken'));
  assert.equal(await readFile(join(taken, 'sec02-outside', 'someone'), 'utf8'), 'x');
  const odd = await fresh('t-root');
  await mkdir(join(odd, 'tasks', 'not-a-uuid'), { recursive: true });
  const second = await new PodRunner((await precheckDeps({ root: odd })).deps).run();
  assert.ok(second.precheck.failed.includes('tasks_listing'));
  assert.deepEqual(await readdir(join(odd, 'tasks')), ['not-a-uuid']);
});

test('사전 점검: 호출 계획이 상한을 넘으면 실행 전에 실패한다', async () => {
  const { deps, root } = await precheckDeps({});
  const huge: PodTurn[] = [{ variant: 'enforced', phase: 'start', keep: Array.from({ length: TOOL_CALL_BUDGET }, (_, index) => `x${index}`) }];
  const before = await snapshot(root);
  const report = await new PodRunner(deps, huge).run();
  assert.equal(report.verdict, 'precheck_failed');
  assert.ok(report.precheck.failed.includes('plan_over_budget'));
  assert.deepEqual(await snapshot(root), before);
});

test('검사기 음성 대조: 샌드박스 없이 돌리면 실제 마운트용 사례가 열림·항목 보임을 잡는다. 자격 값은 출력에 없다', async () => {
  const { layout, credentialDir, root } = await realLayout();
  await layout.build();
  const step = caseTable(layout).find(item => item.name === 'probe.cred_control')!;
  const result = spawnSync('bash', ['-c', String(step.build(PLAN_CONTEXT).input.command)], { encoding: 'utf8', timeout: 20_000, env: { PATH: '/usr/local/bin:/usr/bin:/bin' } });
  assert.equal(result.stdout.includes('real-value-must-not-move'), false);
  const { rows } = await step.judge({ isError: false, text: result.stdout });
  const outcome = (id: string) => rows.find(row => row.case_id === id)?.outcome;
  for (const id of ['cred.bash_open', 'cred.bash_symlink', 'cred.bash_proc_root', 'cred.bash_proc_fd', 'cred.bash_list', 'control.bash_list']) assert.equal(outcome(id), 'allowed', id);
  for (const row of rows) if (row.case_id.startsWith('cred.') || row.case_id.startsWith('control.')) assert.equal(row.bytes, null, `${row.case_id}: 길이를 재지 않는다`);
  assert.equal(rows.some(row => row.case_id === 'control.bash_read' || row.case_id === 'control.bash_write'), false, '합성 canary 사례는 표에서 빠졌다');
  // 비어 있으면 masked로 갈린다. 양성 대조 없이 0건을 차단으로 세지 않기 위한 구분이다.
  await rm(join(credentialDir, 'CLAUDE_CODE_OAUTH_TOKEN'));
  await rm(join(root, '.homelab-worker'), { recursive: true });
  await mkdir(join(root, '.homelab-worker'));
  const empty = spawnSync('bash', ['-c', String(step.build(PLAN_CONTEXT).input.command)], { encoding: 'utf8', timeout: 20_000, env: { PATH: '/usr/local/bin:/usr/bin:/bin' } });
  const masked = (await step.judge({ isError: false, text: empty.stdout })).rows;
  for (const id of ['cred.bash_list', 'control.bash_list']) assert.equal(masked.find(row => row.case_id === id)?.outcome, 'masked', id);
  assert.deepEqual([masked.find(row => row.case_id === 'cred.bash_open')?.outcome, masked.find(row => row.case_id === 'cred.bash_open')?.error_code], ['masked', 'ENOENT']);
});

// CLI 자리에 두는 시험용 실행 파일. 작업 공간과 무관한 임시 폴더에 둔다.
async function fakeCli(body: string): Promise<string> {
  const path = join(await fresh('cli'), 'claude');
  await writeFile(path, `#!/bin/sh\n${body}\n`, { mode: 0o755 });
  return path;
}

test('watchdog: TERM을 무시하는 CLI를 유예 뒤 KILL하고 그룹 소멸을 확인한다', async () => {
  const { layout, credentialDir, root } = await realLayout();
  await layout.build();
  const tracker = new ProcessTracker();
  const api = new FakeMessagesApi({ token: layout.token });
  const proxy = new RefusingProxy();
  const ports = { api: await api.listen(), proxy: await proxy.listen() };
  try {
    const started = Date.now();
    const report = await runTurn({ variant: 'enforced', operation: 'start', dirs: layout.session.dirs, deadline: Date.now() + 200, layout, api, proxy, ports, steps: [], tracker,
      cli: await fakeCli("trap '' TERM\nsleep 100 &\nwait\nsleep 100"), sandbox: { credentialDir, controlDir: join(root, '.homelab-worker'), others: layout.others } });
    assert.equal(report.status, 'timeout');
    const elapsed = Date.now() - started;
    assert.ok(elapsed >= POD_LIMITS.killGraceMs, `${elapsed}ms: 유예를 준다`);
    assert.ok(elapsed < POD_LIMITS.killGraceMs + 8_000, `${elapsed}ms: 소멸 확인 상한`);
    await tracker.stopSentinel();
    assert.equal(tracker.alive(), 0, '자기 그룹이 남지 않는다');
  } finally {
    tracker.killAll();
    await api.close();
    await proxy.close();
  }
});

async function runnerFixture(cli: string) {
  const { deps, root, tmp, credentialDir } = await precheckDeps({});
  deps.paths.cli = cli;
  const retained = join(root, 'tasks', '66666666-6666-4666-8666-666666666666', '1', 'workspace');
  await mkdir(retained, { recursive: true });
  await writeFile(join(retained, 'keep'), 'keep');
  await writeFile(join(root, '.homelab-worker', 'nonce'), 'n');
  return { deps, root, tmp, credentialDir, retained };
}

test('실행기 정리: CLI가 실패해도 pass가 아니고, manifest 경로만 지워 시작 상태로 돌아간다', async () => {
  const { deps, root, tmp, credentialDir, retained } = await runnerFixture(await fakeCli('exit 3'));
  const before = await Promise.all([root, tmp, credentialDir].map(snapshot));
  const report = await new PodRunner(deps).run();
  assert.equal(report.precheck.ok, true);
  assert.equal(report.verdict, 'incomplete');
  assert.ok(report.turns.length >= 1);
  assert.ok(report.mismatches.includes('enforced/start:exit'));
  assert.equal(report.cleanup.left_paths, 0);
  assert.equal(report.cleanup.children_alive, 0);
  assert.equal(report.cleanup.listeners_closed, true);
  assert.equal(report.cleanup.retained_same, true);
  assert.ok(report.cleanup.deleted >= 3, '합성 작업 둘과 바깥 폴더');
  assert.deepEqual(await Promise.all([root, tmp, credentialDir].map(snapshot)), before);
  assert.equal(await readFile(join(retained, 'keep'), 'utf8'), 'keep');
  assert.equal(await readFile(join(root, '.homelab-worker', 'nonce'), 'utf8'), 'n');
  assert.equal(await readFile(join(credentialDir, 'CLAUDE_CODE_OAUTH_TOKEN'), 'utf8'), 'real');
  assert.equal(encodePodReport(report).includes(root), false, '결과에 경로가 없다');
});

test('실행기 정리: 중단 신호에 도는 턴을 끝내고 올린 경로를 지운다. 모르는 새 파일은 지우지 않고 센다', async () => {
  const { deps, root, tmp } = await runnerFixture(await fakeCli('exec sleep 100'));
  const runner = new PodRunner(deps);
  const running = runner.run();
  // 사전 점검과 세션 생성이 끝나 CLI가 돌 때까지 기다린다.
  const end = Date.now() + 15_000;
  while (Date.now() < end && !(await readdir(join(root, 'tasks'))).some(name => name !== '66666666-6666-4666-8666-666666666666')) await new Promise(ready => setTimeout(ready, 20));
  await new Promise(ready => setTimeout(ready, 700));
  await writeFile(join(tmp, 'someone-else'), 'x');
  await writeFile(join(root, 'someone-else'), 'x');
  runner.requestAbort('signal');
  const report = await running;
  assert.equal(report.aborted, 'signal');
  assert.equal(report.verdict, 'incomplete');
  assert.equal(report.cleanup.unknown_new_paths, 2);
  assert.equal(await readFile(join(tmp, 'someone-else'), 'utf8'), 'x');
  assert.equal(await readFile(join(root, 'someone-else'), 'utf8'), 'x');
  assert.deepEqual((await readdir(join(root, 'tasks'))).sort(), ['66666666-6666-4666-8666-666666666666']);
  assert.equal(await lstat(join(root, 'sec02-outside')).then(() => true, () => false), false);
});

const baseEnv: PodEnvironmentInfo = { mode: 'pod', execution_path: 'direct_exec_not_tasklane', source_sha: 'a'.repeat(40), image_digest: null, pod_uid: null, uid: POD_UID, cli: '2.1.308', bwrap: '0.12.0', socat: '1.8.0.3', node: 'v24.22.0',
  pid1: 'expected', worker_processes: 1, apparmor: 'homelab-sandbox-worker-v1', seccomp_mode: 2, no_new_privs: true, cap_eff_zero: true, uid_map_identity: false, proc_masked_mounts: 0, root_read_only: true, credential_read_only: true,
  state_fstype: 'ext4', credential_present: true, control_dir_present: true, retained_generations: 0 };
const cleanupOk = { deleted: 4, left_paths: 0, unknown_new_paths: 0, listeners_closed: true, children_alive: 0, pod_processes_clean: true, retained_same: true };
const allowedRow = (case_id: string): Row => ({ case_id, tool: 'Bash', attempted: true, outcome: 'allowed', error_code: null, bytes: null });
const turnOf = (turn: PodTurn, rows: Row[]): TurnReport => ({ variant: turn.variant, phase: turn.phase, status: 'finished', exit_code: 0, signal: null, outcome_kind: turn.variant === 'unlisted_tools' ? 'failed' : 'output',
  outcome_reason: turn.variant === 'unlisted_tools' ? 'policy_violation' : null, init_seen: true, session_matched: true, policy_violations: turn.variant === 'unlisted_tools' ? 2 : 0, tool_calls: turn.keep.length + 1, planned_tool_calls: turn.keep.length + 1,
  api_requests: 1, aux_requests: 0, rejected_requests: 0, auth_mismatch: 0, api_key_headers: 0, api_violations: {}, proxy_refused: 0, proxy_non_loopback: 0, duration_ms: 1, rows,
  counts: { 'proc.environ_readable': 3, 'socket.own_exists_outside': 1, 'socket.init_path_matches': 1, 'socket.visible_other': 2 } });
const reportBody = (rowsFor: (turn: PodTurn) => Row[] = () => []): Omit<PodReport, 'verdict' | 'mismatches' | 'schema'> => ({ environment: baseEnv, precheck: { ok: true, failed: [] }, differences: [], skipped_variants: { long_tmpdir: 'non_production_root' },
  limits: POD_LIMITS, turns: POD_TURNS.map(turn => turnOf(turn, rowsFor(turn))), planned_tool_calls: plannedCalls(POD_TURNS), tool_calls: plannedCalls(POD_TURNS), cleanup: cleanupOk, total_ms: 1, aborted: null });

test('판정: 전부 맞으면 pass, 뚫리면 violation, 못 재면 incomplete다. not_run 사유 행은 어긋남이 아니다', () => {
  assert.deepEqual(judgePodRun(reportBody()), { verdict: 'pass', mismatches: [] });
  const notRunRow: Row = { case_id: 'cred.read', tool: 'Read', attempted: false, outcome: 'not_run', error_code: 'real_credential_target', bytes: null };
  assert.equal(rowVerdict(notRunRow), 'not_run');
  assert.equal(judgePodRun(reportBody(() => [notRunRow])).verdict, 'pass');
  const breached = judgePodRun(reportBody(turn => turn.variant === 'enforced' ? [allowedRow('cred.bash_open')] : []));
  assert.equal(breached.verdict, 'violation');
  assert.ok(breached.mismatches.includes('enforced/start:cred.bash_open'));
  const positiveFailed = reportBody(turn => turn.variant === 'enforced' ? [{ case_id: 'positive.read', tool: 'Read', attempted: true, outcome: 'error', error_code: 'unknown_error', bytes: null }] : []);
  assert.equal(judgePodRun(positiveFailed).verdict, 'incomplete', '양성 대조 실패는 경계 위반이 아니라 잰 것이 아니다');
  // 먼저 읽기 검사가 앞에서 막으면 규칙의 증거가 아니다.
  assert.equal(rowVerdict({ case_id: 'outside.write_new', tool: 'Write', attempted: true, outcome: 'denied', error_code: 'not_read_first', bytes: null }), 'mismatch');
  assert.equal(rowVerdict({ case_id: 'outside.write_new', tool: 'Write', attempted: true, outcome: 'denied', error_code: 'permission_denied', bytes: null }), 'match');
  assert.equal(rowVerdict({ case_id: 'cred.bash_open', tool: 'Bash', attempted: true, outcome: 'denied', error_code: 'EACCES', bytes: null }), 'match');
  assert.equal(rowVerdict({ case_id: 'cred.bash_open', tool: 'Bash', attempted: true, outcome: 'not_run', error_code: 'probe_missing', bytes: null }), 'mismatch', '돌렸어야 하는 사례');
  assert.equal(rowVerdict({ case_id: 'unknown.case', tool: 'Bash', attempted: true, outcome: 'masked', error_code: null, bytes: null }), 'mismatch');
});

test('판정: 조건이 하나라도 빠지면 pass가 아니다', () => {
  const cases: [string, (body: ReturnType<typeof reportBody>) => void, string][] = [
    ['정리 잔여', body => { body.cleanup = { ...cleanupOk, left_paths: 1 }; }, 'cleanup:unclean'],
    ['모르는 새 경로', body => { body.cleanup = { ...cleanupOk, unknown_new_paths: 1 }; }, 'cleanup:unclean'],
    ['생존 자식', body => { body.cleanup = { ...cleanupOk, children_alive: 1 }; }, 'cleanup:unclean'],
    ['listener', body => { body.cleanup = { ...cleanupOk, listeners_closed: false }; }, 'cleanup:unclean'],
    ['파드 프로세스', body => { body.cleanup = { ...cleanupOk, pod_processes_clean: false }; }, 'cleanup:unclean'],
    ['보존 작업 변화', body => { body.cleanup = { ...cleanupOk, retained_same: false }; }, 'cleanup:unclean'],
    ['중단', body => { body.aborted = 'total_time'; }, 'aborted:total_time'],
    ['턴 빠짐', body => { body.turns = body.turns.filter(turn => turn.phase !== 'resume'); }, 'enforced/resume:not_run'],
    ['호출 수', body => { body.turns[0]!.tool_calls = 1; }, 'enforced/start:tool_calls'],
    ['인증', body => { body.turns[0]!.auth_mismatch = 1; }, 'enforced/start:auth'],
    ['프록시 접촉', body => { body.turns[0]!.proxy_refused = 1; }, 'enforced/start:proxy_contact'],
    ['/proc 양성 대조', body => { body.turns[0]!.counts = { ...body.turns[0]!.counts, 'proc.environ_readable': 0 }; }, 'enforced/start:positive_environ_readable'],
    ['소켓 양성 대조', body => { body.turns[0]!.counts = { ...body.turns[0]!.counts, 'socket.own_exists_outside': 0 }; }, 'enforced/start:positive_socket_exists'],
    ['AppArmor', body => { body.environment = { ...baseEnv, apparmor: 'unconfined' }; }, 'environment:apparmor'],
    ['hostUsers', body => { body.environment = { ...baseEnv, uid_map_identity: true }; }, 'environment:host_users'],
    ['procMount', body => { body.environment = { ...baseEnv, proc_masked_mounts: 5 }; }, 'environment:proc_mount'],
    ['소스 SHA 없음', body => { body.environment = { ...baseEnv, source_sha: null }; }, 'environment:source_sha'],
  ];
  for (const [label, change, code] of cases) {
    const body = reportBody();
    change(body);
    const judged = judgePodRun(body);
    assert.equal(judged.verdict, 'incomplete', label);
    assert.ok(judged.mismatches.includes(code), `${label}: ${judged.mismatches.join(',')}`);
  }
  const body = reportBody();
  body.environment = { ...baseEnv, mode: 'rehearsal', apparmor: 'unconfined', seccomp_mode: 0, uid_map_identity: true, source_sha: null };
  assert.equal(judgePodRun(body).verdict, 'pass', '리허설은 프로필 조건을 보지 않는다');
});

test('결과 형식: 고정 열과 어휘이고 경로·값이 없다', () => {
  const body = reportBody(() => [{ case_id: 'cred.read', tool: 'Read', attempted: false, outcome: 'not_run', error_code: 'real_credential_target', bytes: null }]);
  const report: PodReport = { schema: 'sec02-pod-report-v1', ...body, ...judgePodRun(body) };
  const text = encodePodReport(report);
  assert.ok(POD_REPORT_MARKER.endsWith(' '));
  assert.equal(text.includes('\n'), false, '한 줄');
  for (const pattern of [/worker-state/, /worker-credential/, /\/tmp\//, /\/proc\//, /homelab-worker/, /sk-ant/]) assert.equal(pattern.test(text), false, String(pattern));
  const parsed = JSON.parse(text) as { turns: { rows: unknown[][] }[] };
  assert.deepEqual(parsed.turns[0]!.rows[0], ['cred.read', 'Read', false, 'not_run', 'real_credential_target', null, 'not_run']);
});
