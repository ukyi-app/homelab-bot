import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { resolve } from 'node:path';
import { sec02Plan } from './sec02-harness.js';
import type { Sec02Plan } from './sec02-harness.js';

// T19 검증 실행기의 SEC-02(local_integration). 운영 이미지의 고정 Bun으로 악성 시험을 돌리고, 합성 자격·다른 세션·소켓·네트워크·생존 프로세스를 잰다.
// 저장소 Dockerfile로 만든 이미지를 SEC02_IMAGE로 줘야 돈다. 없으면 사유와 함께 skip하고 통과로 세지 않는다. 절차는 VERIFICATION "T19 B1 artifact·검증".
// 컨테이너는 SEC-02 1단계와 같은 조건이다: 네트워크 없음, uid 10001, 읽기 전용 루트, AppArmor·seccomp 풀림. 운영 프로필 아래 동작은 재지 못한다.

const REPORT_MARKER = 'CHANGE_SEC02_REPORT ';
const plan = sec02Plan(process.env, resolve('.'));
const skip = typeof plan === 'string' ? plan : false;
interface Report {
  uid: number;
  enforced: { status: string; exit: number | null; detail: string | null; sensitive: boolean; probes: Record<string, string>; markerLeft: number; survivors: number | null; tail: string };
  control: { status: string; sensitive: boolean; probes: Record<string, string> };
  benign: { status: string; exit: number | null; digest: boolean; tail: string };
  cancel: { hangSeen: boolean; status: string; detail: string | null; survivors: number | null; markerLeft: number };
  forged: { status: string; exit: number | null; tail: string };
  hits: { enforced: { unix: number; tcp: number }; control: { unix: number; tcp: number } };
  sourceLeft: string[]; credentialIntact: boolean; postinstallRan: boolean;
}
async function runContainer(image: Sec02Plan): Promise<Report> {
  const name = `change-sec02-${randomBytes(4).toString('hex')}`;
  const repo = image.repo;
  const args = ['run', '--rm', '--pull=never', '--name', name, '--network', 'none', '--init', '--user', '10001:10001', '--read-only',
    '--security-opt', 'apparmor=unconfined', '--security-opt', 'seccomp=unconfined', '--security-opt', 'unmask=ALL',
    '--tmpfs', '/tmp:rw,size=64m,mode=1777', '--tmpfs', '/worker-state:rw,size=128m,mode=0700,U', '--tmpfs', '/run/worker-credential:rw,size=1m,mode=0700,U',
    '-v', `${repo}/dist:/sec02/dist:ro`, '-v', `${repo}/node_modules:/sec02/node_modules:ro`, '-v', `${repo}/package.json:/sec02/package.json:ro`,
    '--entrypoint', 'node', '--workdir', '/sec02', image.image, '/sec02/dist/test/change-sec02-run.js'];
  return new Promise<Report>((done, fail) => {
    const child = spawn('podman', args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8').on('data', (chunk: string) => { stdout += chunk; });
    child.stderr.setEncoding('utf8').on('data', (chunk: string) => { stderr += chunk.slice(0, 2000); });
    const watchdog = setTimeout(() => { spawnSync('podman', ['rm', '-f', name], { timeout: 30_000 }); fail(new Error('change_sec02_timeout')); }, 240_000);
    child.once('close', () => {
      clearTimeout(watchdog);
      const line = stdout.split('\n').reverse().find(item => item.startsWith(REPORT_MARKER));
      if (!line) { fail(new Error(`change_sec02_no_report: ${stderr.slice(0, 800)}`)); return; }
      done(JSON.parse(line.slice(REPORT_MARKER.length)) as Report);
    });
  });
}
let report: Report | undefined;
const measured = async () => { report ??= await runContainer(plan as Sec02Plan); return report; };

test('SEC-02 실제 격리: 고정 Bun이 악성 시험을 돌리고 자격·제어·다른 세션·자기 제어 경로가 안 보인다', { skip }, async () => {
  const { enforced, uid } = await measured();
  assert.equal(uid, 10001);
  assert.equal(enforced.probes.done, 'yes', `시험 끝까지 돌지 않았다: ${enforced.tail}`);
  for (const name of ['read.credential', 'read.control', 'read.other_session', 'read.own_config', 'read.own_run', 'list.state', 'list.app', 'alias.proc1_root', 'alias.proc_self_root']) {
    assert.equal(enforced.probes[name], 'ENOENT', name);
  }
  assert.equal(enforced.probes['proc.environ_canary'], 'absent');
  assert.equal(enforced.probes['env.credential_vars'], 'none');
  assert.equal(enforced.sensitive, false, '로그에 카나리가 없다');
});

test('SEC-02 실제 격리: 네트워크·소켓이 끊겨 있고 작업자 쪽 listener에 닿지 않았다', { skip }, async () => {
  const { enforced, hits } = await measured();
  assert.equal(enforced.probes['net.unix_socket'], 'ENOENT');
  assert.notEqual(enforced.probes['net.tcp_loopback_worker'], 'connected');
  assert.notEqual(enforced.probes['net.tcp_external'], 'connected');
  assert.equal(enforced.probes['net.dns'], 'failed');
  assert.deepEqual(hits.enforced, { unix: 0, tcp: 0 });
});

test('SEC-02 실제 격리: source·시스템 경로에 쓰지 못하고 scratch에만 쓴다. symlink·hardlink로 source를 바꾸지 못한다', { skip }, async () => {
  const { enforced } = await measured();
  for (const name of ['write.source_new', 'write.usr', 'write.root', 'symlink.source', 'mkdir.source', 'chmod.source']) assert.equal(enforced.probes[name], 'EROFS', name);
  // 있는 파일은 잠근 권한이 먼저 답한다. 마운트가 막는지는 chmod.source가 본다.
  assert.equal(enforced.probes['write.source_existing'], 'EACCES');
  assert.equal(enforced.probes['write.state'], 'ENOENT');
  assert.equal(enforced.probes['write.scratch'], 'wrote');
  assert.notEqual(enforced.probes['hardlink.source'], 'created', '다른 마운트로 hardlink를 만들지 못한다');
  // 후보 쪽 시험이 무엇을 하든 source 대조가 그대로다.
  assert.equal(enforced.status, 'passed', `${enforced.status} ${enforced.detail} ${enforced.tail}`);
});

test('SEC-02 실제 격리: 설치 스크립트·package script가 자격에 닿지 못하고 바깥을 바꾸지 못한다', { skip }, async () => {
  const { enforced, postinstallRan, credentialIntact } = await measured();
  assert.equal(enforced.probes['script.leak'], 'clean');
  assert.equal(postinstallRan, false, '바깥 /tmp에 설치 스크립트 흔적이 없다');
  assert.equal(credentialIntact, true);
  assert.notEqual(enforced.probes['install.exit'], undefined);
});

test('SEC-02 실제 격리: 시험이 남긴 setsid 자식이 끝난 뒤 없고 PodPidSpace가 0개를 확인한다', { skip }, async () => {
  const { enforced, sourceLeft } = await measured();
  assert.equal(enforced.markerLeft, 0);
  assert.equal(enforced.survivors, 0);
  assert.deepEqual(sourceLeft, [], 'source를 지웠다');
});

test('SEC-02 실제 격리: 취소하면 살아 있던 시험 프로세스가 사라지고 통과로 세지 않는다', { skip }, async () => {
  const { cancel } = await measured();
  assert.equal(cancel.hangSeen, true, '취소 전에 자식이 살아 있었다');
  assert.equal(cancel.survivors, 0);
  assert.equal(cancel.markerLeft, 0);
  assert.deepEqual([cancel.status, cancel.detail], ['unknown', 'aborted']);
});

test('SEC-02 실제 격리: 시험 프로세스가 bwrap 상태 fd로 종료 코드를 위조하지 못한다', { skip }, async () => {
  const { forged } = await measured();
  assert.deepEqual([forged.status, forged.exit], ['failed', 7], forged.tail);
  assert.doesNotMatch(forged.tail, /forged/);
});

test('SEC-02 실제 격리: smoke와 같은 꼴의 정상 시험이 네트워크 없는 샌드박스에서 통과한다', { skip }, async () => {
  const { benign } = await measured();
  assert.deepEqual([benign.status, benign.exit, benign.digest], ['passed', 0, true], benign.tail);
  assert.match(benign.tail, /2 pass/);
});

test('SEC-02 음성 대조: 경계를 풀면 같은 시험이 자격을 읽고 연결한다. 위 결과가 거짓 통과가 아니다', { skip }, async () => {
  const { control, hits } = await measured();
  for (const name of ['read.credential', 'read.control', 'read.other_session', 'read.own_config', 'read.own_run']) assert.equal(control.probes[name], 'leaked', name);
  assert.equal(control.probes['net.unix_socket'], 'connected');
  assert.equal(control.probes['net.tcp_loopback_worker'], 'connected');
  assert.ok(hits.control.unix > hits.enforced.unix && hits.control.tcp > hits.enforced.tcp, '작업자 쪽 listener가 연결을 받았다');
});

test('SEC-02 계획: 이미지가 없으면 사유를 남기고 통과로 세지 않는다', () => {
  assert.match(sec02Plan({}, '/repo') as string, /SEC02_IMAGE 없음/);
});
