import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmod, mkdir, mkdtemp, readFile, readdir, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { artifactDigest, evidenceBundleDigest, gitBlobSha, sha256Hex } from '../src/change-contracts.js';
import type { ArtifactBundle, EvidenceBundle } from '../src/change-contracts.js';
import { gitTreeSha } from '../src/change-artifact.js';
import { IsolatedVerifier, VERIFICATION_COMMANDS, VERIFIER_REVISION, VERIFIER_TOOLCHAINS, WorkerChangeVerification, sandboxArgs } from '../src/change-verifier.js';
import type { ChangeVerificationWorker, SandboxRun, VerificationCommand, VerificationInput, VerifierOptions } from '../src/change-verifier.js';
import { TaskWorkerRejected } from '../src/task-bridge.js';
import type { TaskV2VerificationResponse } from '../src/task-contracts.js';
import type { ProcessCleanup } from '../src/process-launcher.js';
import { BASE_ITEMS, changeWorkerFixture, identity, leavesOf, settledResult } from './change-worker-harness.js';
import { LIMITS, SHA, archive } from './task-fixtures.js';
import { COMPLETED } from './task-worker-harness.js';

const scratch = await realpath(await mkdtemp(join(tmpdir(), 't19-verify-')));
after(async () => { await rm(scratch, { recursive: true, force: true }); });
const SECRET = 'sk-ant-oat01-fixture-secret-ABCDEFGHIJKLMNOPQRSTUVWXYZ-98765';
const shFile = '/bin/sh';
const shSha = async () => sha256Hex(await readFile(await realpath(shFile)));
const command = async (script: string, overrides: Partial<VerificationCommand> = {}): Promise<VerificationCommand> => ({ argv: [shFile, '-c', script], cwd: '.', timeoutMs: 30_000, outputBytes: 1024 * 1024, scratchBytes: 1024 * 1024, env: {},
  toolchain: { path: shFile, sha256: await shSha() }, ...overrides });
const quiet: ProcessCleanup = { terminate: async () => {}, survivors: async () => 0, busy: () => false };

// 실제 수집 없이 만든 고정 결과. T0 파일 넷에서 src/app.txt만 바꾸고 src/old.txt를 지운다.
function fixedArtifact(): { artifact: ArtifactBundle; digest: string; baseTree: string } {
  const changed = Buffer.from('two\n');
  const entries = leavesOf(BASE_ITEMS).filter(leaf => leaf.path !== 'src/app.txt').map(leaf => {
    const item = BASE_ITEMS.find(candidate => candidate.name === leaf.path)!;
    const data = Buffer.from(item.data ?? '');
    return { path: leaf.path, mode: leaf.mode as '100644', changeKind: leaf.path === 'src/old.txt' ? 'deleted' as const : 'unchanged' as const, blobSha: gitBlobSha(data), sha256: sha256Hex(data), size: data.byteLength };
  });
  entries.push({ path: 'src/app.txt', mode: '100644', changeKind: 'modified' as 'unchanged', blobSha: gitBlobSha(changed), sha256: sha256Hex(changed), size: changed.byteLength });
  entries.sort((a, b) => Buffer.compare(Buffer.from(a.path), Buffer.from(b.path)));
  const manifest = { version: 1 as const, baseCommit: SHA, baseTree: gitTreeSha(leavesOf(BASE_ITEMS)), resultTree: gitTreeSha(entries.filter(entry => entry.changeKind !== 'deleted')), patchSha256: sha256Hex(Buffer.from('p')), entries };
  return { artifact: { manifest, files: [{ path: 'src/app.txt', content: changed }], patch: 'p' }, digest: artifactDigest(manifest), baseTree: manifest.baseTree };
}
const fixed = fixedArtifact();
const bundleOf = (overrides: Partial<EvidenceBundle> = {}): EvidenceBundle => ({ repoId: 4242, generation: 1, baseCommit: SHA, baseTree: fixed.baseTree, resultTree: fixed.artifact.manifest.resultTree, artifactDigest: fixed.digest,
  policyRevision: 'policy-1', verifierRevision: VERIFIER_REVISION, ...overrides });
let dirCounter = 0;
async function inputFor(commandId: string, overrides: Partial<VerificationInput> = {}): Promise<VerificationInput> {
  const root = join(scratch, `v${++dirCounter}`);
  await mkdir(root, { recursive: true });
  return { job: 'job', generation: 1, dirs: { root, home: join(root, 'home'), config: join(root, 'config'), workspace: join(root, 'workspace'), run: join(root, 'run'), tmp: join(root, 'tmp') },
    commandId, bundle: bundleOf(), artifact: fixed.artifact, artifactDigest: fixed.digest, archive: archive(BASE_ITEMS), limits: { files: LIMITS.files, fileBytes: LIMITS.fileBytes },
    baseline: { repoId: 4242, changeGeneration: 1, baseCommit: SHA, baseTree: fixed.baseTree, policyRevision: 'policy-1' }, ...overrides };
}
const baseRun = (overrides: Partial<SandboxRun> = {}): SandboxRun => ({ started: true, exitCode: 0, timedOut: false, overflow: false, aborted: false, log: Buffer.from('ok\n'), logBytes: 3, logDigest: 'a'.repeat(64), ...overrides });
const verifier = async (run: Partial<SandboxRun> | ((args: readonly string[]) => Promise<SandboxRun>), options: Partial<VerifierOptions> = {}) => new IsolatedVerifier({
  imageRevision: 'fixture-image', cleanup: quiet, secrets: async () => [SECRET], registry: { unit: await command('true') },
  sandbox: typeof run === 'function' ? run : async () => baseRun(run), ...options });
const go = (v: IsolatedVerifier, input: VerificationInput) => v.run(input, new AbortController().signal);

test('registry: smoke-unit은 고정 Bun의 bun test src/server.test.ts이고 셸·후보 script를 거치지 않는다', () => {
  const smoke = VERIFICATION_COMMANDS['smoke-unit']!;
  assert.deepEqual(smoke.argv, ['/opt/verifier/bun-1.4.3/bun', 'test', 'src/server.test.ts']);
  assert.equal(smoke.cwd, '.');
  assert.equal(smoke.toolchain, VERIFIER_TOOLCHAINS['bun-1.4.3']);
  assert.deepEqual(Object.keys(VERIFICATION_COMMANDS), ['smoke-unit']);
  assert.ok(!smoke.argv.some(arg => /sh$|npm|run/.test(arg)));
});

test('고정값: Dockerfile의 경로·해시·이미지 digest가 실행기 표와 같다', async () => {
  const dockerfile = await readFile('Dockerfile', 'utf8');
  const tool = VERIFIER_TOOLCHAINS['bun-1.4.3'];
  assert.ok(dockerfile.includes(tool.path));
  assert.ok(dockerfile.includes(tool.sha256));
  assert.match(dockerfile, /FROM docker\.io\/oven\/bun:1\.4\.3-slim@sha256:[0-9a-f]{64} AS verifier-bun/);
  assert.doesNotMatch(dockerfile, /(curl|wget)\b.*bun/i, '런타임·빌드 다운로드 없이 digest 고정 이미지에서 복사한다');
});

test('샌드박스 인자: 빈 루트에 허용 목록만 올린다. 자격·상태·앱·네트워크 공유가 없다', async () => {
  const args = sandboxArgs({ source: '/worker-state/tasks/x/1/verify/r/source', command: VERIFICATION_COMMANDS['smoke-unit']! });
  for (const flag of ['--unshare-all', '--die-with-parent', '--new-session', '--clearenv']) assert.ok(args.includes(flag), flag);
  for (const flag of ['--share-net', '--dev-bind', '--bind', '--bind-try', '--dev-bind-try']) assert.ok(!args.includes(flag), flag);
  // 쓰기 마운트가 없다. 소스도 읽기 전용이다.
  const roots = args.flatMap((arg, index) => arg === '--ro-bind' || arg === '--ro-bind-try' ? [args[index + 2]!] : []);
  assert.deepEqual(roots.sort(), ['/bin', '/etc/alternatives', '/etc/ld.so.cache', '/lib', '/lib64', '/opt/verifier/bun-1.4.3/bun', '/source', '/usr'].sort());
  assert.ok(!args.some(arg => /worker-credential|homelab-worker|\/app\b|cc-socks/.test(arg)));
  assert.deepEqual(args.slice(args.indexOf('--') + 1), [...VERIFICATION_COMMANDS['smoke-unit']!.argv]);
  const env = args.flatMap((arg, index) => arg === '--setenv' ? [args[index + 1]!] : []);
  assert.deepEqual(env.sort(), ['DO_NOT_TRACK', 'HOME', 'LANG', 'NO_COLOR', 'PATH', 'TMPDIR']);
});

test('판정: 표에 없는 ID·다른 묶음·바뀐 toolchain·남은 작성자·샌드박스 실패는 not_run이고 시험을 돌리지 않는다', async () => {
  let ran = 0;
  const counted = async (overrides: Partial<VerifierOptions> = {}) => verifier(async () => { ran++; return baseRun(); }, overrides);
  const statusOf = async (v: IsolatedVerifier, input: VerificationInput) => { const record = await go(v, input); return [record.receipt.status, record.log.detail]; };
  assert.deepEqual(await statusOf(await counted(), await inputFor('smoke-unit-other')), ['not_run', 'command_unknown']);
  assert.deepEqual(await statusOf(await counted(), await inputFor('constructor')), ['not_run', 'command_unknown'], '객체 기본 속성 이름이 표로 새지 않는다');
  for (const [name, bundle] of Object.entries({ artifactDigest: bundleOf({ artifactDigest: 'b'.repeat(64) }), resultTree: bundleOf({ resultTree: 'c'.repeat(40) }), baseCommit: bundleOf({ baseCommit: 'd'.repeat(40) }),
    policy: bundleOf({ policyRevision: 'policy-2' }), verifier: bundleOf({ verifierRevision: 'other-verifier' }), generation: bundleOf({ generation: 2 }), repo: bundleOf({ repoId: 1 }) })) {
    assert.deepEqual(await statusOf(await counted(), await inputFor('unit', { bundle })), ['not_run', 'bundle_mismatch'], name);
  }
  assert.deepEqual(await statusOf(await counted({ registry: { unit: await command('true', { toolchain: { path: shFile, sha256: 'e'.repeat(64) } }) } }), await inputFor('unit')), ['not_run', 'toolchain_mismatch']);
  assert.deepEqual(await statusOf(await counted({ registry: { unit: await command('true', { toolchain: { path: '/nonexistent/bun', sha256: 'e'.repeat(64) } }) } }), await inputFor('unit')), ['not_run', 'toolchain_mismatch']);
  assert.deepEqual(await statusOf(await counted({ cleanup: { ...quiet, survivors: async () => 1 } }), await inputFor('unit')), ['not_run', 'author_not_stopped']);
  assert.deepEqual(await statusOf(await counted({ cleanup: { ...quiet, survivors: async () => null } }), await inputFor('unit')), ['not_run', 'author_not_stopped']);
  assert.equal(ran, 0);
  assert.deepEqual(await statusOf(await verifier({ started: false, exitCode: 1 }), await inputFor('unit')), ['not_run', 'sandbox_unavailable'], 'bwrap이 띄우지 못하면 시험 실패가 아니다');
  const bad = { ...fixed.artifact, files: [{ path: 'src/app.txt', content: Buffer.from('tampered\n') }] };
  assert.deepEqual(await statusOf(await verifier({}), await inputFor('unit', { artifact: bad })), ['not_run', 'artifact_incomplete'], '고정 바이트와 manifest가 다르면 짓지 않는다');
});

test('판정: 종료 코드·시간 초과·출력 상한을 receipt로 옮긴다', async () => {
  const pass = await go(await verifier({}), await inputFor('unit'));
  assert.deepEqual([pass.receipt.status, pass.receipt.exitCode, pass.receipt.logDigest, pass.receipt.runnerRevision, pass.receipt.imageRevision], ['passed', 0, 'a'.repeat(64), VERIFIER_REVISION, 'fixture-image']);
  assert.equal(evidenceBundleDigest(pass.receipt.bundle), evidenceBundleDigest(bundleOf()));
  assert.equal(pass.log.excerpt, 'ok\n');
  const failed = await go(await verifier({ exitCode: 7 }), await inputFor('unit'));
  assert.deepEqual([failed.receipt.status, failed.receipt.exitCode], ['failed', 7]);
  const timed = await go(await verifier({ timedOut: true, exitCode: null }), await inputFor('unit'));
  assert.deepEqual([timed.receipt.status, timed.receipt.timedOut, timed.receipt.exitCode], ['timed_out', true, null]);
  const overflow = await go(await verifier({ overflow: true, exitCode: null }), await inputFor('unit'));
  assert.deepEqual([overflow.receipt.status, overflow.log.detail], ['unknown', 'output_limit_exceeded']);
  const lost = await go(await verifier({ exitCode: null }), await inputFor('unit'));
  assert.deepEqual([lost.receipt.status, lost.log.detail], ['unknown', 'exit_unknown']);
});

test('판정: source가 바뀌면 시험이 통과해도 source_changed이고, 소멸을 못 보면 unknown이다', async () => {
  const mutate = (change: (source: string) => Promise<void>) => async (args: readonly string[]) => {
    const source = args[args.indexOf('/source') - 1]!;
    await chmod(source, 0o755);
    await chmod(join(source, 'src'), 0o755);
    await change(source);
    return baseRun();
  };
  for (const [name, change] of Object.entries({
    modified: async (source: string) => { await chmod(join(source, 'src/app.txt'), 0o644); await writeFile(join(source, 'src/app.txt'), 'evil\n'); },
    added: (source: string) => writeFile(join(source, 'src/extra'), 'x'),
    removed: (source: string) => rm(join(source, 'src/app.txt'), { force: true }),
    mode: (source: string) => chmod(join(source, 'README.md'), 0o755),
    directory: (source: string) => mkdir(join(source, 'empty')),
    dotgit: (source: string) => mkdir(join(source, '.git')),
  })) {
    const record = await go(await verifier(mutate(change)), await inputFor('unit'));
    assert.equal(record.receipt.status, 'source_changed', name);
  }
  let terminated = 0;
  const alive: ProcessCleanup = { terminate: async () => { terminated++; }, survivors: async () => terminated >= 2 ? 1 : 0, busy: () => false };
  const record = await go(await verifier({}, { cleanup: alive }), await inputFor('unit'));
  assert.deepEqual([record.receipt.status, record.log.detail], ['unknown', 'stop_unconfirmed']);
  assert.equal(terminated, 2, '실행 전후 모두 정리한다');
  terminated = 0;
  const unstarted = await go(await verifier({ started: false, exitCode: null }, { cleanup: alive }), await inputFor('unit'));
  assert.deepEqual([unstarted.receipt.status, unstarted.log.detail], ['unknown', 'stop_unconfirmed'], '시작 증거가 없어도 남은 프로세스가 있으면 미실행으로 치지 않는다');
});

test('로그: 자격이 나오면 통과로 세지 않고 사본을 남기지 않는다. 패턴만 나오면 상태는 두고 사본만 지운다. 공개 필드에 원문이 없다', async () => {
  const leak = await go(await verifier({ log: Buffer.from(`token=${SECRET}\n`) }), await inputFor('unit'));
  assert.deepEqual([leak.receipt.status, leak.log.detail, leak.log.excerpt, leak.log.sensitive], ['unknown', 'credential_in_log', null, true]);
  const split = await go(await verifier({ log: Buffer.from(SECRET.replace(/-/g, ' - ')) }), await inputFor('unit'));
  assert.equal(split.receipt.status, 'unknown', '구분자를 끼워도 잡는다');
  const pattern = await go(await verifier({ log: Buffer.from('ghp_abcdefghijklmnopqrstuvwxyz0123\n') }), await inputFor('unit'));
  assert.deepEqual([pattern.receipt.status, pattern.log.excerpt, pattern.log.sensitive], ['passed', null, true]);
  const internal = await go(await verifier({ log: Buffer.from(`${['node', 'fixture', 'ts', 'net'].join('.')}\n`) }), await inputFor('unit'));
  assert.equal(internal.log.excerpt, null);
  assert.ok(!JSON.stringify(leak.receipt).includes(SECRET));
  const unreadable = await go(await verifier({}, { secrets: async () => { throw new Error('gone'); } }), await inputFor('unit'));
  assert.deepEqual([unreadable.receipt.status, unreadable.log.detail], ['unknown', 'credential_recheck_failed']);
  const big = Buffer.alloc(100 * 1024, 0x61);
  const long = await go(await verifier({ log: big }), await inputFor('unit'));
  assert.deepEqual([long.log.truncated, long.log.excerpt?.length], [true, 64 * 1024], '사본은 제한 길이');
});

test('정리: 끝나면 source를 지운다. 파일 권한으로 잠가 둔 트리도 지운다', async () => {
  const input = await inputFor('unit');
  await go(await verifier({}), input);
  assert.deepEqual(await readdir(join(input.dirs.root, 'verify')), []);
});

// ---- 실제 bwrap ----

const bwrapReason = (() => {
  const probe = spawnSync('/usr/bin/bwrap', ['--unshare-all', '--ro-bind', '/usr', '/usr', '--ro-bind-try', '/bin', '/bin', '--ro-bind-try', '/lib', '/lib', '--ro-bind-try', '/lib64', '/lib64', '/bin/sh', '-c', 'exit 0'], { timeout: 10_000 });
  return probe.status === 0 ? false : 'bwrap으로 namespace를 만들 수 없다(없거나 비특권 user namespace 제한). 격리 실측은 podman 절차와 운영 이미지에서 돈다';
})();
const real = async (script: string, overrides: Partial<VerificationCommand> = {}) => {
  const v = new IsolatedVerifier({ imageRevision: 'fixture-image', cleanup: quiet, secrets: async () => [SECRET], registry: { unit: await command(script, overrides) } });
  return go(v, await inputFor('unit'));
};

test('실제 bwrap: T1 파일이 읽기 전용으로 보이고 지운 파일은 없다. 끝낸 상태가 receipt로 온다', { skip: bwrapReason }, async () => {
  const pass = await real('cat src/app.txt; test ! -e src/old.txt && echo gone; test "$(pwd)" = /source && echo cwd; id -u >/dev/null; exit 0');
  assert.equal(pass.receipt.status, 'passed', JSON.stringify(pass.log));
  assert.equal(pass.log.excerpt, 'two\ngone\ncwd\n');
  const failed = await real('echo bad; exit 7');
  assert.deepEqual([failed.receipt.status, failed.receipt.exitCode], ['failed', 7]);
  const timed = await real('sleep 30', { timeoutMs: 200 });
  assert.deepEqual([timed.receipt.status, timed.receipt.timedOut], ['timed_out', true]);
  const noisy = await real('yes x', { outputBytes: 4096 });
  assert.deepEqual([noisy.receipt.status, noisy.log.detail], ['unknown', 'output_limit_exceeded']);
});

test('실제 bwrap: 시험 프로세스는 bwrap 상태 fd에 쓰지 못해 종료 코드를 위조하지 못한다', { skip: bwrapReason }, async () => {
  const forged = await real(`(echo '{ "exit-code": 0 }' >&3) 2>/dev/null && echo forged; exit 7`);
  assert.deepEqual([forged.receipt.status, forged.receipt.exitCode], ['failed', 7]);
  assert.doesNotMatch(forged.log.excerpt ?? '', /forged/);
});

test('실제 bwrap: source와 시스템 경로에 쓰지 못하고 scratch에만 쓴다. scratch 크기가 묶여 있다', { skip: bwrapReason }, async () => {
  const probe = await real(`
for path in /source/x /source/src/app.txt /usr/x /etc/x /bin/x /x /opt/x /dev/x /dev/shm/x; do if (echo x > "$path") 2>/dev/null; then echo "wrote $path"; fi; done
test -w /dev/null && echo dev-null-ok; head -c 1 /dev/urandom >/dev/null && echo urandom-ok
echo x > /scratch/home/ok && echo scratch-ok; echo x > "$TMPDIR/ok" && echo tmp-ok; echo x > /tmp/ok2 && echo slash-tmp-ok
dd if=/dev/zero of=/scratch/fill bs=1024 count=4096 2>/dev/null; echo dd=$?
env | sort | cut -d= -f1 | tr '\\n' ' '`);
  assert.equal(probe.receipt.status, 'passed', JSON.stringify(probe.log));
  const log = probe.log.excerpt!;
  assert.doesNotMatch(log, /wrote/);
  assert.match(log, /dev-null-ok\nurandom-ok\nscratch-ok\ntmp-ok\nslash-tmp-ok\ndd=1/);
  assert.match(log, /HOME LANG PATH PWD TMPDIR/);
});

// ---- 작업자 HTTP ----

const harnessRegistry = async (script = 'cat src/app.txt') => ({ unit: await command(script) });
test('HTTP: 고정 결과에서 시험을 돌리고 같은 receipt를 다시 준다. 같은 command를 두 번 돌리지 않는다. 정리 뒤에는 없다', async () => {
  let ran = 0;
  const f = await changeWorkerFixture({ verifier: { registry: await harnessRegistry(), sandbox: async () => { ran++; return baseRun(); } } });
  try {
    await f.script([{ ...COMPLETED, write: { 'src/app.txt': 'two\n' } }]);
    const request = f.start();
    await f.signed('/v2/task', request);
    const result = await settledResult(f, request);
    assert.equal(result.status, 'snapshot');
    const bundle = { repoId: 4242, generation: 1, baseCommit: SHA, baseTree: result.artifact.manifest.baseTree, resultTree: result.artifact.manifest.resultTree, artifactDigest: result.artifactDigest, policyRevision: request.policyRevision, verifierRevision: VERIFIER_REVISION };
    const body = { ...identity(request), expectedWorker: result.worker, commandId: 'unit', bundle };
    const accepted = await f.signed('/v2/task/verify', body);
    assert.equal(accepted.status, 200);
    let done: any;
    for (let attempt = 0; attempt < 400 && done?.status !== 'done'; attempt++) {
      done = (await f.signed('/v2/task/verification', { ...identity(request), expectedWorker: null, commandId: 'unit' })).json;
      if (done.status !== 'done') await new Promise(resolve => setTimeout(resolve, 5));
    }
    assert.equal(done.receipt.status, 'passed');
    const again = await f.signed('/v2/task/verify', body);
    assert.deepEqual(again.json.receipt, done.receipt, '응답 유실 뒤 다시 보내도 같은 receipt');
    assert.equal(ran, 1);
    const unknown = await f.signed('/v2/task/verify', { ...body, commandId: 'not-in-table' });
    assert.equal(unknown.status, 200);
    await f.restart();
    assert.deepEqual((await f.signed('/v2/task/verification', { ...identity(request), expectedWorker: null, commandId: 'unit' })).json.receipt, done.receipt, '재시작 뒤에도 같다');
    assert.equal(ran, 1);
    const worker = (await f.signed('/v2/task/result', { ...identity(request), expectedWorker: null })).json.worker;
    assert.equal((await f.signed('/v2/task/finalize', { ...identity(request), expectedWorker: worker, receipt: { outcome: 'saved', artifactDigest: result.artifactDigest, persistedAt: 1 } })).json.cleaned, true);
    const gone = await f.signed('/v2/task/verification', { ...identity(request), expectedWorker: null, commandId: 'unit' });
    assert.equal(gone.json.status, 'absent');
    const refused = await f.signed('/v2/task/verify', { ...body, expectedWorker: worker, commandId: 'unit' });
    assert.equal(refused.status, 409, '정리한 뒤에는 시험할 결과가 없다');
  } finally { await f.close(); }
});

test('HTTP: 시험은 턴과 같은 슬롯이다. 도는 동안 다른 턴·다른 시험을 받지 않고 취소하면 끝난다', async () => {
  let release!: (run: SandboxRun) => void;
  let seenSignal: AbortSignal | undefined;
  const f = await changeWorkerFixture({ verifier: { registry: await harnessRegistry(), sandbox: (_args, _limits, signal) => { seenSignal = signal; return new Promise(resolve => { release = resolve; signal.addEventListener('abort', () => resolve(baseRun({ aborted: true, exitCode: null }))); }); } } });
  try {
    await f.script([{ ...COMPLETED, write: { 'src/app.txt': 'two\n' } }]);
    const request = f.start();
    await f.signed('/v2/task', request);
    const result = await settledResult(f, request);
    const bundle = { repoId: 4242, generation: 1, baseCommit: SHA, baseTree: result.artifact.manifest.baseTree, resultTree: result.artifact.manifest.resultTree, artifactDigest: result.artifactDigest, policyRevision: request.policyRevision, verifierRevision: VERIFIER_REVISION };
    assert.equal((await f.signed('/v2/task/verify', { ...identity(request), expectedWorker: result.worker, commandId: 'unit', bundle })).json.status, 'running');
    for (let attempt = 0; attempt < 400 && !seenSignal; attempt++) await new Promise(resolve => setTimeout(resolve, 5));
    assert.ok(seenSignal);
    const other = f.start();
    assert.equal((await f.signed('/v2/task', other)).status, 409, '다른 턴');
    const running = await f.signed('/v2/task/verify', { ...identity(request), expectedWorker: result.worker, commandId: 'other-id', bundle });
    assert.equal(running.status, 409, '다른 시험');
    assert.equal((await f.signed('/v2/task/result', { ...identity(request), expectedWorker: null })).json.status, 'snapshot', '시험 중에도 결과는 다시 받는다');
    const cancel = await f.service.cancel({ version: 1, job: request.job, lease: request.lease, generation: 1, sessionId: request.sessionId, expectedWorker: result.worker },
      f.signer.issue('task_cancel', { version: 1, job: request.job, lease: request.lease, generation: 1, sessionId: request.sessionId, expectedWorker: result.worker } as never));
    assert.equal(cancel.stopped, true);
    assert.equal(seenSignal.aborted, true);
    release(baseRun());
  } finally { await f.close(); }
});

test('HTTP: 작성자 소멸을 확인하지 못한 시험 뒤에는 슬롯을 내주지 않는다', async () => {
  let ran = 0;
  const f = await changeWorkerFixture({ verifier: { registry: await harnessRegistry(), cleanup: { ...quiet, survivors: async () => 1 }, sandbox: async () => { ran++; return baseRun(); } } });
  try {
    await f.script([{ ...COMPLETED, write: { 'src/app.txt': 'two\n' } }]);
    const request = f.start();
    await f.signed('/v2/task', request);
    const result = await settledResult(f, request);
    const bundle = { repoId: 4242, generation: 1, baseCommit: SHA, baseTree: result.artifact.manifest.baseTree, resultTree: result.artifact.manifest.resultTree, artifactDigest: result.artifactDigest, policyRevision: request.policyRevision, verifierRevision: VERIFIER_REVISION };
    await f.signed('/v2/task/verify', { ...identity(request), expectedWorker: result.worker, commandId: 'unit', bundle });
    let done: any;
    for (let attempt = 0; attempt < 400 && (done?.status !== 'done' || (f.service as unknown as { turn?: unknown }).turn); attempt++) {
      done = (await f.signed('/v2/task/verification', { ...identity(request), expectedWorker: null, commandId: 'unit' })).json;
      await new Promise(resolve => setTimeout(resolve, 5));
    }
    assert.deepEqual([done.receipt.status, done.log.detail, ran], ['not_run', 'author_not_stopped', 0]);
    assert.equal((await f.signed('/v2/task', f.start())).status, 409, '다른 턴을 받지 않는다');
  } finally { await f.close(); }
});

test('HTTP: 시작을 기록한 뒤 턴의 결과가 없으면 앞 턴의 snapshot으로 시험하지 않는다', async () => {
  let ran = 0;
  const f = await changeWorkerFixture({ verifier: { registry: await harnessRegistry(), sandbox: async () => { ran++; return baseRun(); } } });
  try {
    await f.script([{ ...COMPLETED, write: { 'src/app.txt': 'two\n' } }]);
    const request = f.start();
    await f.signed('/v2/task', request);
    const result = await settledResult(f, request);
    const file = join(f.root, '.homelab-worker', 'receipts', `${request.job}.json`);
    await f.restart(async () => {
      const record = JSON.parse(await readFile(file, 'utf8'));
      record.generations['1'].turn = 2;
      await writeFile(file, JSON.stringify(record));
    });
    const worker = (await f.signed('/v2/task/result', { ...identity(request), expectedWorker: null })).json.worker;
    const bundle = { repoId: 4242, generation: 1, baseCommit: SHA, baseTree: result.artifact.manifest.baseTree, resultTree: result.artifact.manifest.resultTree, artifactDigest: result.artifactDigest, policyRevision: request.policyRevision, verifierRevision: VERIFIER_REVISION };
    const refused = await f.signed('/v2/task/verify', { ...identity(request), expectedWorker: worker, commandId: 'unit', bundle });
    assert.equal(refused.status, 409);
    assert.equal(ran, 0);
  } finally { await f.close(); }
});

// ---- 게시 서버 port ----

const fakeReply = (status: 'running' | 'absent' | 'done', receipt?: unknown): TaskV2VerificationResponse => ({ version: 2, job: 'j', lease: 'l', generation: 1, sessionId: 's', worker: { instance: 'i', storage: 's' }, commandId: 'smoke-unit', status,
  ...(status === 'done' ? { receipt, log: { excerpt: null, truncated: false, sensitive: false, detail: null } } : {}) } as TaskV2VerificationResponse);
const portInput = { key: { changeId: 'c'.repeat(32), generation: 1 }, bundle: bundleOf(), commandId: 'smoke-unit' };
const control = { job: 'j', lease: 'l', generation: 1, sessionId: 's', worker: { instance: 'i', storage: 's' } };
const portWith = (worker: Partial<ChangeVerificationWorker>, overrides: Partial<ConstructorParameters<typeof WorkerChangeVerification>[0]> = {}) => new WorkerChangeVerification({
  worker: { verify: async () => fakeReply('running'), verification: async () => fakeReply('running'), ...worker }, control: async () => control, imageRevision: 'fixture-image', pollMs: 1, waitMs: 50, sleep: () => new Promise(resolve => setImmediate(resolve)), ...overrides });
const passedReceipt = { runId: 'r1', commandId: 'smoke-unit', runnerRevision: VERIFIER_REVISION, imageRevision: 'fixture-image', bundle: bundleOf(), exitCode: 0, timedOut: false, logDigest: 'a'.repeat(64), status: 'passed' };

test('검증 port: 응답을 잃어도 저장된 receipt를 받고 다시 시작하지 않는다', async () => {
  let starts = 0;
  let polls = 0;
  const port = portWith({ verify: async () => { starts++; throw new Error('connection reset'); }, verification: async () => (++polls < 3 ? fakeReply('running') : fakeReply('done', passedReceipt)) });
  assert.deepEqual(await port.run(portInput), passedReceipt);
  assert.equal(starts, 1);
  assert.deepEqual(await port.fetchReceipt({ key: portInput.key, commandId: 'smoke-unit' }), passedReceipt);
});

test('검증 port: 세션이 없거나 거부되면 not_run, 기다림이 끝나거나 사라지면 unknown이다. 통과로 지어내지 않는다', async () => {
  const noSession = portWith({}, { control: async () => null });
  assert.equal((await noSession.run(portInput)).status, 'not_run');
  assert.equal(await noSession.fetchReceipt({ key: portInput.key, commandId: 'smoke-unit' }), null);
  assert.equal((await portWith({}, { control: async () => ({ ...control, worker: null }) }).run(portInput)).status, 'not_run', '작업자를 모른다');
  assert.equal((await portWith({ verify: async () => { throw new TaskWorkerRejected(); } }).run(portInput)).status, 'not_run');
  assert.equal((await portWith({ verify: async () => fakeReply('absent') }).run(portInput)).status, 'unknown');
  assert.equal((await portWith({}).run(portInput)).status, 'unknown', '시한');
  const receipt = await portWith({ verify: async () => { throw new TaskWorkerRejected(); } }).run(portInput);
  assert.deepEqual([receipt.exitCode, receipt.logDigest, receipt.timedOut], [null, null, false]);
  await assert.rejects(portWith({}).run({ ...portInput, commandId: 'Bad Id; rm -rf' }), /verification_input_invalid/, '셸 문자열은 ID가 아니다');
});

test('검증 port: 작업 중 keepalive를 부른다', async () => {
  let beats = 0;
  let polls = 0;
  await portWith({ verification: async () => (++polls < 3 ? fakeReply('running') : fakeReply('done', passedReceipt)) }, { keepalive: async () => { beats++; } }).run(portInput);
  assert.ok(beats >= 2);
});
