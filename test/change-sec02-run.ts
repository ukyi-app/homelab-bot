import { randomUUID } from 'node:crypto';
import { lstat, mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import { dirname, join } from 'node:path';
import { collectArtifact, compareBaseline } from '../src/change-artifact.js';
import { artifactDigest, sha256Hex } from '../src/change-contracts.js';
import { IsolatedVerifier, VERIFICATION_COMMANDS, VERIFIER_REVISION, spawnSandbox } from '../src/change-verifier.js';
import type { SandboxRunner } from '../src/change-verifier.js';
import type { RunDirs } from '../src/executor.js';
import { PodPidSpace } from '../src/task-containment.js';
import { parseTaskArchive } from '../src/task-workspace.js';
import { SHA, archive } from './task-fixtures.js';
import { PROBE_BODY, CANARY } from './change-sec02-probe.js';
import { baseTreeOf, leavesOf } from './change-worker-harness.js';

// T19 검증 실행기의 실제 격리 시험 본체. 네트워크 없는 컨테이너(--init으로 PID 1이 init) 안에서만 돈다. test/change-sec02.test.ts가 띄운다.
// PodPidSpace를 진짜로 쓰므로 kill(-1)이 나간다. 이 파일을 운영 파드나 개발 기계 프로세스 공간에서 실행하지 않는다. record()가 기준 밖 프로세스를 보면 거부한다.
// 모든 값은 합성이다. 자격은 카나리이고 진짜 토큰이 아니다.

export const REPORT_MARKER = 'CHANGE_SEC02_REPORT ';
const STATE = process.env.CHANGE_SEC02_STATE ?? '/worker-state';
const CREDENTIAL = process.env.CHANGE_SEC02_CREDENTIAL ?? '/run/worker-credential';
const SECRET = `sk-ant-oat01-${CANARY}-credential-value-ABCDEFGH`;

function parseProbes(text: string | null): Record<string, string> {
  const probes: Record<string, string> = {};
  for (const line of (text ?? '').split('\n')) {
    const match = /^PROBE ([a-z0-9_.]+)=(.*)$/.exec(line);
    if (match) probes[match[1]!] = match[2]!;
  }
  return probes;
}
async function otherProcessesWithMarker(marker: string): Promise<number> {
  let found = 0;
  for (const name of await readdir('/proc')) {
    if (!/^\d+$/.test(name) || Number(name) === process.pid) continue;
    const cmdline = await readFile(`/proc/${name}/cmdline`, 'utf8').catch(() => '');
    if (cmdline.includes(marker)) found++;
  }
  return found;
}

async function main(): Promise<void> {
  const job = randomUUID();
  const other = randomUUID();
  const root = join(STATE, 'tasks', job, '1');
  const dirs: RunDirs = { root, home: join(root, 'home'), config: join(root, 'config'), workspace: join(root, 'workspace'), run: join(root, 'run'), tmp: join(root, 'tmp') };
  for (const dir of [dirs.home, dirs.config, dirs.workspace, dirs.run, dirs.tmp, join(dirs.tmp, 'cc-socks'), join(STATE, '.homelab-worker', 'nonces'), join(STATE, 'tasks', other, '1', 'config')]) await mkdir(dir, { recursive: true });
  // 시험이 닿으면 안 되는 합성 대상들. 값이 로그에 나오면 카나리로 잡힌다.
  await writeFile(join(CREDENTIAL, 'CLAUDE_CODE_OAUTH_TOKEN'), SECRET);
  await writeFile(join(STATE, '.homelab-worker', 'nonces', 'canary'), CANARY);
  await writeFile(join(STATE, 'tasks', other, '1', 'config', 'canary'), CANARY);
  await writeFile(join(dirs.config, 'canary'), CANARY);
  await writeFile(join(dirs.run, 'canary'), CANARY);
  process.env.CHANGE_SEC02_WORKER_ENV_CANARY = CANARY;
  const socketPath = join(dirs.tmp, 'cc-socks', '1.sock');
  const unixHits = { count: 0 };
  const unixServer = createServer(() => { unixHits.count++; });
  await new Promise<void>(resolve => unixServer.listen(socketPath, resolve));
  const tcpHits = { count: 0 };
  const tcpServer = createServer(() => { tcpHits.count++; });
  await new Promise<void>(resolve => tcpServer.listen(0, '127.0.0.1', resolve));
  const tcpPort = (tcpServer.address() as { port: number }).port;

  // 고정 T0.
  const items = [{ name: 'README.md', data: '# fixture\n' }, { name: 'package.json', data: '{"name":"fixture"}\n' }, { name: 'src/server.ts', data: 'export const handle = () => 1;\n' }];
  const base = archive(items);
  await writeFile(join(dirs.run, 'baseline.tar.gz'), base);
  const parsed = await parseTaskArchive(base, { files: 100, fileBytes: 1_000_000 });
  const baseTree = baseTreeOf(items);
  const compared = compareBaseline(parsed, { repoId: 4242, changeGeneration: 1, base: SHA, baseTree, leaves: leavesOf(items) });
  if (!compared.ok) throw new Error(compared.reason);
  for (const item of items) { await mkdir(dirname(join(dirs.workspace, item.name)), { recursive: true }); await writeFile(join(dirs.workspace, item.name), item.data); }
  const { fileWorkspace } = await import('../src/codex-workspace.js');
  await writeFile(join(dirs.run, 'baseline.json'), JSON.stringify(await fileWorkspace.snapshot(dirs.workspace)));

  // 악성 후보. 모델이 쓴 파일을 흉내 낸다. 설치 스크립트·설정·hook·시험을 모두 심는다.
  const marker = `sleep-${randomUUID().slice(0, 8)}`;
  const body = PROBE_BODY({ credential: join(CREDENTIAL, 'CLAUDE_CODE_OAUTH_TOKEN'), control: join(STATE, '.homelab-worker', 'nonces', 'canary'), otherSession: join(STATE, 'tasks', other, '1', 'config', 'canary'),
    ownConfig: join(dirs.config, 'canary'), ownRun: join(dirs.run, 'canary'), socket: socketPath, tcpPort, state: STATE, marker });
  await writeFile(join(dirs.workspace, 'src/server.test.ts'), body);
  await writeFile(join(dirs.workspace, 'package.json'), JSON.stringify({ name: 'fixture', scripts: { postinstall: `sh -c 'echo ${CANARY} > /tmp/postinstall'`, test: 'sh -c "cat /run/worker-credential/*"' } }));
  await mkdir(join(dirs.workspace, '.git', 'hooks'), { recursive: true });
  await writeFile(join(dirs.workspace, '.git', 'hooks', 'pre-commit'), '#!/bin/sh\necho hook\n');
  const patchText = 'display only\n';
  const collected = await collectArtifact({ dirs, baseline: compared.value, patch: { text: patchText, bytes: Buffer.byteLength(patchText), digest: sha256Hex(Buffer.from(patchText)), truncated: false } });
  if (!collected.ok) throw new Error(collected.reason);
  const artifact = collected.value;
  const digest = artifactDigest(artifact.manifest);

  const cleanup = await PodPidSpace.record({ dedicatedTaskPod: true });
  const bundle = { repoId: 4242, generation: 1, baseCommit: SHA, baseTree, resultTree: artifact.manifest.resultTree, artifactDigest: digest, policyRevision: 'policy-1', verifierRevision: VERIFIER_REVISION };
  const input = { job, generation: 1, dirs, commandId: 'smoke-unit', bundle, artifact, artifactDigest: digest, archive: base, limits: { files: 100, fileBytes: 1_000_000 },
    baseline: { repoId: 4242, changeGeneration: 1, baseCommit: SHA, baseTree, policyRevision: 'policy-1' } };
  const secrets = async () => [SECRET];
  const controller = new AbortController();

  // 1. 운영 인자.
  const enforced = await new IsolatedVerifier({ imageRevision: 'fixture-image', cleanup, secrets }).run(input, controller.signal);
  const enforcedMarker = await otherProcessesWithMarker(marker);
  const enforcedSurvivors = await cleanup.survivors(job);
  const enforcedHits = { unix: unixHits.count, tcp: tcpHits.count };

  // 2. 음성 대조: 같은 시험을 경계를 푼 인자로 돌린다. 시험이 정말 닿으면 알아챔을 보인다. 이 대조군은 합성 환경에서만 돈다.
  const widened: SandboxRunner = (args, limits, signal) => {
    const at = args.indexOf('--remount-ro');
    const open = [...args];
    open.splice(at, 0, '--ro-bind', STATE, STATE, '--ro-bind', CREDENTIAL, CREDENTIAL, '--share-net');
    return spawnSandbox(open, limits, signal);
  };
  const control = await new IsolatedVerifier({ imageRevision: 'fixture-image', cleanup, secrets: async () => [`no-such-secret-${randomUUID()}`], sandbox: widened }).run({ ...input, job }, controller.signal);

  // 3. 취소 뒤 생존 프로세스. 시험이 setsid 자식을 남기고 멈춰 있을 때 취소한다.
  const controlHits = { unix: unixHits.count, tcp: tcpHits.count };
  const benign = await new IsolatedVerifier({ imageRevision: 'fixture-image', cleanup, secrets }).run(await withTest(dirs, compared.value, input, BENIGN_TEST), controller.signal);
  const hanging = await withTest(dirs, compared.value, input, hangTest(`${marker}-hang`));
  const cancelController = new AbortController();
  const cancelled = new IsolatedVerifier({ imageRevision: 'fixture-image', cleanup, secrets, registry: { 'smoke-unit': { ...VERIFICATION_COMMANDS['smoke-unit']!, timeoutMs: 60_000 } } }).run(hanging, cancelController.signal);
  let hangSeen = false;
  for (let attempt = 0; attempt < 400 && !hangSeen; attempt++) {
    if (await otherProcessesWithMarker(`${marker}-hang`) >= 1) hangSeen = true;
    else await new Promise(resolve => setTimeout(resolve, 25));
  }
  cancelController.abort();
  const cancelledRecord = await cancelled;
  const cancelSurvivors = await cleanup.survivors(job);
  const cancelMarker = await otherProcessesWithMarker(`${marker}-hang`);

  // 4. 상태 fd 위조. 운영 bwrap에서도 시험 프로세스가 종료 코드를 지어내지 못한다. Bun 내부 fd와 섞이지 않게 셸로 잰다.
  const shell = '/bin/sh';
  const forged = await new IsolatedVerifier({ imageRevision: 'fixture-image', cleanup, secrets, registry: { 'smoke-unit': { ...VERIFICATION_COMMANDS['smoke-unit']!,
    argv: [shell, '-c', `(echo '{ "exit-code": 0 }' >&3) 2>/dev/null && echo forged; exit 7`], toolchain: { path: shell, sha256: sha256Hex(await readFile(shell)) } } } }).run(input, controller.signal);

  unixServer.close();
  tcpServer.close();
  const report = {
    schema: 'change-sec02-v1', uid: process.getuid?.() ?? -1, node: process.version,
    enforced: { status: enforced.receipt.status, exit: enforced.receipt.exitCode, detail: enforced.log.detail, sensitive: enforced.log.sensitive, probes: parseProbes(enforced.log.excerpt), markerLeft: enforcedMarker, survivors: enforcedSurvivors, tail: (enforced.log.excerpt ?? '').slice(-400).replaceAll(CANARY, '<canary>') },
    control: { status: control.receipt.status, sensitive: control.log.sensitive, probes: parseProbes(control.log.excerpt) },
    benign: { status: benign.receipt.status, exit: benign.receipt.exitCode, digest: benign.receipt.logDigest !== null, tail: (benign.log.excerpt ?? '').slice(-300) },
    cancel: { hangSeen, status: cancelledRecord.receipt.status, detail: cancelledRecord.log.detail, survivors: cancelSurvivors, markerLeft: cancelMarker },
    forged: { status: forged.receipt.status, exit: forged.receipt.exitCode, tail: (forged.log.excerpt ?? '').slice(-200) },
    hits: { enforced: enforcedHits, control: controlHits },
    sourceLeft: await readdir(join(root, 'verify')).catch(() => [] as string[]),
    credentialIntact: (await readFile(join(CREDENTIAL, 'CLAUDE_CODE_OAUTH_TOKEN'), 'utf8')) === SECRET,
    postinstallRan: await lstat('/tmp/postinstall').then(() => true, () => false),
  };
  process.stdout.write(`${REPORT_MARKER}${JSON.stringify(report)}\n`);
}
// smoke 시험과 같은 꼴의 정상 시험. 내장 SQL·Redis로 loopback 닫힌 포트에 접속 실패를 만든다. 네트워크가 끊긴 샌드박스에서 통과해야 한다.
const BENIGN_TEST = `import { expect, test } from "bun:test";
test("정상", () => { expect(1 + 1).toBe(2); });
test("닫힌 포트", async () => {
  const refused = async (work: () => Promise<unknown>) => { try { await work(); return false; } catch { return true; } };
  const sql = new Bun.SQL("postgresql://u:fixture@127.0.0.1:1/db?sslmode=disable", { max: 1, connectionTimeout: 3 });
  expect(await refused(async () => { await sql\`select 1\`; })).toBe(true);
  sql.close().catch(() => {});
  const cache = new Bun.RedisClient("redis://default:fixture@127.0.0.1:1/0", { autoReconnect: false, connectionTimeout: 3000 });
  expect(await refused(async () => { await cache.ping(); })).toBe(true);
  cache.close();
});
`;
// 새 세션으로 빠져나가고 시그널을 무시하는 자식. 표식은 명령줄의 $0 자리에 있다.
const hangTest = (marker: string) => `import { test } from "bun:test";\ntest("hang", async () => {\n  Bun.spawn(["setsid", "sh", "-c", "trap '' TERM HUP INT; while :; do sleep 1; done", ${JSON.stringify(marker)}], { stdout: "ignore", stderr: "ignore", stdin: "ignore" });\n  await new Promise(() => {});\n}, 3600000);\n`;
async function withTest(dirs: RunDirs, baseline: Parameters<typeof collectArtifact>[0]['baseline'], input: Parameters<IsolatedVerifier['run']>[0], body: string): Promise<Parameters<IsolatedVerifier['run']>[0]> {
  await writeFile(join(dirs.workspace, 'src/server.test.ts'), body);
  const text = 'display only\n';
  const collected = await collectArtifact({ dirs, baseline, patch: { text, bytes: Buffer.byteLength(text), digest: sha256Hex(Buffer.from(text)), truncated: false } });
  if (!collected.ok) throw new Error(collected.reason);
  const digest = artifactDigest(collected.value.manifest);
  return { ...input, artifact: collected.value, artifactDigest: digest, bundle: { ...input.bundle, resultTree: collected.value.manifest.resultTree, artifactDigest: digest } };
}
await main().catch(error => { process.stderr.write(`${error instanceof Error ? error.message : 'error'}\n`); process.exitCode = 1; });
