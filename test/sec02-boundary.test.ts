import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, realpath, rm } from 'node:fs/promises';
import { connect } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { FakeMessagesApi, RefusingProxy, TOOL_CALL_BUDGET } from './sec02-fake-api.js';
import type { TurnScript } from './sec02-fake-api.js';
import { ERROR_CODES, Sec02Layout, caseTable, classifyToolError, judgeProbe } from './sec02-fixture.js';
import type { Outcome, Row } from './sec02-fixture.js';
import { SEC02_LIMITS, VARIANTS, containerArgs, decodeReport, encodeReport, launchRunner, scopedAllowArgs, sec02Plan, variantSettings } from './sec02-harness.js';
import type { Sec02Report, TurnReport, Variant } from './sec02-harness.js';

// SEC-02 1단계(VERIFICATION "SEC-02 1단계"). 고정 CLI가 실제 도구를 실행하고 loopback 가짜 API가 호출 순서만 정한다.
// 실제 실행 사례는 환경이 갖춰졌을 때만 돈다. 없으면 사유와 함께 skip하고 통과로 세지 않는다.
const scratch = await realpath(await mkdtemp(join(tmpdir(), 't18-sec02-')));
after(async () => { await rm(scratch, { recursive: true, force: true }); });

// 하네스 단위 시험. CLI 없이 돈다.
const toolScript = (steps: number, results: unknown[] = []): TurnScript => {
  let left = steps;
  return { next: () => left-- > 0 ? { tool: 'Bash', input: { command: 'true' } } : null, onResult: async outcome => { results.push(outcome); }, structured: { status: 'completed', summary: 's', question: '' } };
};
const post = (port: number, body: unknown, path = '/v1/messages?beta=true', token = 'tok') =>
  fetch(`http://127.0.0.1:${port}${path}`, { method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' }, body: JSON.stringify(body) });
const main = (content: unknown = 'go') => ({ model: 'm', stream: true, tools: [{ name: 'Bash' }], messages: [{ role: 'user', content }] });
const toolUseId = (text: string) => /"id":"(toolu_[^"]+)"/.exec(text)?.[1] ?? '';

test('가짜 API: 정해진 순서로 tool_use를 내고 결과를 받은 뒤 구조화 출력으로 끝낸다. system 메시지가 뒤에 붙어도 된다', async t => {
  const results: { isError: boolean; text: string }[] = [];
  const api = new FakeMessagesApi({ token: 'tok' });
  t.after(() => api.close());
  const port = await api.listen();
  api.startTurn('t', toolScript(1, results));
  const first = await (await post(port, main())).text();
  assert.match(first, /"name":"Bash"/);
  const second = await (await post(port, { ...main(), messages: [{ role: 'user', content: [{ type: 'tool_result', tool_use_id: toolUseId(first), is_error: true, content: [{ type: 'text', text: 'denied text' }] }] }, { role: 'system', content: [{ type: 'text', text: 'x' }] }] })).text();
  assert.match(second, /"name":"StructuredOutput"/);
  assert.deepEqual(results, [{ isError: true, text: 'denied text' }]);
  const third = await (await post(port, main([{ type: 'tool_result', tool_use_id: toolUseId(second), content: 'ok' }]))).text();
  assert.match(third, /end_turn/);
  assert.equal(api.stats.toolCalls, 2);
});

test('가짜 API: 순서가 어긋난 요청, 예산 초과, 크기 초과는 멈추고 위반으로 센다. 다른 경로는 404다', async t => {
  const violations: string[] = [];
  const api = new FakeMessagesApi({ token: 'tok', budget: 1, maxBytes: 4096, onViolation: violation => violations.push(violation) });
  t.after(() => api.close());
  const port = await api.listen();
  assert.equal((await post(port, main())).status, 400, '턴이 시작되기 전 요청');
  api.startTurn('t', toolScript(5));
  const first = await (await post(port, main())).text();
  assert.equal((await post(port, main([{ type: 'tool_result', tool_use_id: 'toolu_other', content: 'x' }]))).status, 400, '다른 호출의 결과');
  assert.equal((await post(port, main([{ type: 'tool_result', tool_use_id: toolUseId(first), content: 'x' }]))).status, 400, '예산 초과');
  assert.equal((await post(port, { pad: 'x'.repeat(8192) })).status, 413);
  assert.equal((await post(port, {}, '/api/other')).status, 404);
  assert.equal((await post(port, {}, '/v1/messages/count_tokens')).status, 200);
  assert.deepEqual(violations, ['order', 'order', 'budget', 'oversize']);
  assert.equal(api.stats.rejected, 1);
});

test('가짜 API: 합성 토큰이 아닌 인증은 값 없이 개수만 센다. 응답에도 값이 없다', async t => {
  const api = new FakeMessagesApi({ token: 'tok' });
  t.after(() => api.close());
  const port = await api.listen();
  api.startTurn('t', toolScript(0));
  const response = await post(port, { model: 'm', messages: [] }, '/v1/messages', 'other-secret-value');
  assert.equal(api.stats.authMismatch, 1);
  assert.equal((await response.text()).includes('other-secret-value'), false);
  assert.equal(JSON.stringify(api.stats).includes('other-secret-value'), false);
});

test('프록시 종단: CONNECT와 일반 요청을 전달하지 않고 거부한다', async t => {
  const proxy = new RefusingProxy();
  t.after(() => proxy.close());
  const port = await proxy.listen();
  const reply = await new Promise<string>((done, fail) => {
    const socket = connect(port, '127.0.0.1', () => socket.write('CONNECT api.anthropic.com:443 HTTP/1.1\r\nHost: api.anthropic.com:443\r\n\r\n'));
    let text = '';
    socket.on('data', chunk => { text += chunk.toString(); });
    socket.on('end', () => done(text));
    socket.on('error', fail);
  });
  assert.match(reply, /^HTTP\/1\.1 403/);
  assert.equal((await fetch(`http://127.0.0.1:${port}/x`)).status, 403);
  assert.deepEqual(proxy.stats, { refused: 2, nonLoopback: 1 });
});

test('분류: 고정 CLI 문구를 정해진 코드로 바꾸고, 모르는 문구는 차단으로 세지 않는다', () => {
  const cases: [string, typeof ERROR_CODES[number]][] = [
    ['<tool_use_error>File is in a directory that is denied by your permission settings.</tool_use_error>', 'permission_denied'],
    ['Permission to read /x has been denied.', 'permission_denied'],
    ['<tool_use_error>File is covered by a Read deny rule in your permission settings and cannot be written.</tool_use_error>', 'permission_denied'],
    ["Claude requested permissions to write to /x, but you haven't granted it yet.", 'permission_denied'],
    ['/x is outside /y; the permissions.blockReadsOutsideWorkingDirectories setting blocks reads', 'outside_cwd_blocked'],
    ["<tool_use_error>Cannot read '/proc/self/environ': this device file would block or produce infinite output.</tool_use_error>", 'device_path_blocked'],
    ['Refusing to write /x: it is a symbolic link. Write to the target.', 'symlink_refused'],
    ['<tool_use_error>File has not been read yet. Read it first before writing to it.</tool_use_error>', 'not_read_first'],
    ['File does not exist.', 'ENOENT'],
    ['전혀 모르는 문구', 'unknown_error'],
  ];
  for (const [text, code] of cases) assert.equal(classifyToolError(text), code, text);
});

test('probe 판정: 정해진 줄만 받고, 빠진 사례는 not_run이며, 줄의 다른 글자는 결과에 싣지 않는다', async () => {
  const layout = {} as Sec02Layout;
  const checks = [{ id: 'a.open', kind: 'open', path: '/x' }, { id: 'b.open', kind: 'open', path: '/x' }, { id: 'c.open', kind: 'open', path: '/x' }, { id: 'd.open', kind: 'open', path: '/x' }, { id: 'e.count', kind: 'count' }] as Parameters<typeof judgeProbe>[1];
  const text = ['SEC02|a.open|failed|ENOENT|-|-', 'SEC02|b.open|failed|EACCES|-|-', 'SEC02|c.open|opened|-|-|-', 'SEC02|e.count|count|-|3|-', 'SEC02|d.open|opened|-|-|secret-value', 'free text secret-value'].join('\n');
  const { rows, counts } = await judgeProbe(layout, checks, { isError: false, text });
  assert.deepEqual(rows.map(row => [row.case_id, row.outcome, row.error_code]), [['a.open', 'masked', 'ENOENT'], ['b.open', 'denied', 'EACCES'], ['c.open', 'allowed', null], ['d.open', 'not_run', 'probe_missing'], ['e.count', 'allowed', null]]);
  assert.deepEqual(counts, { 'e.count': 3 });
  assert.equal(JSON.stringify(rows).includes('secret-value'), false);
  const failed = await judgeProbe(layout, checks.slice(0, 1), { isError: true, text: 'Sandbox is required but failed' });
  assert.deepEqual(failed.rows.map(row => [row.outcome, row.error_code]), [['error', 'tool_error']]);
});

test('사례표: 시작·재개를 합친 호출이 상한 안이고 사례 이름이 겹치지 않는다. fixture는 합성 값만 쓴다', async () => {
  await mkdir(join(scratch, 'state'));
  const layout = new Sec02Layout({ root: join(scratch, 'state'), credentialDir: join(scratch, 'cred') });
  await layout.build();
  const steps = caseTable(layout);
  assert.ok((steps.length + 1) * 2 <= TOOL_CALL_BUDGET, `호출 ${(steps.length + 1) * 2}회`);
  assert.equal(new Set(steps.map(step => step.name)).size, steps.length);
  assert.equal(layout.others.length, 2, '다른 job과 같은 job의 다른 세대');
  assert.ok(layout.token.includes('sec02-synthetic'));
  assert.notEqual(new Sec02Layout({ root: join(scratch, 'state'), credentialDir: join(scratch, 'cred') }).token, layout.token, '실행마다 새 값');
});

test('대조군 설정: enforced는 운영 설정 그대로이고 나머지만 푼다. 후보는 쓰기 허용만 좁힌다', () => {
  const production = JSON.stringify({ sandbox: { enabled: true, filesystem: { denyRead: ['/a'] } }, permissions: { deny: ['Read(//a/**)'], blockReadsOutsideWorkingDirectories: true } });
  assert.equal(variantSettings('enforced', production), production);
  assert.equal(variantSettings('candidate_fix', production), production);
  assert.deepEqual(JSON.parse(variantSettings('unguarded', production)), { sandbox: { enabled: false }, permissions: {} });
  assert.deepEqual(JSON.parse(variantSettings('no_permission_deny', production)).sandbox.filesystem, { denyRead: ['/a'] });
  assert.deepEqual(JSON.parse(variantSettings('no_permission_deny', production)).permissions, {});
  assert.deepEqual(JSON.parse(variantSettings('no_sandbox_filesystem', production)).sandbox.filesystem, {});
  assert.deepEqual(JSON.parse(variantSettings('no_block_outside', production)).permissions, { deny: ['Read(//a/**)'] });
  assert.deepEqual(scopedAllowArgs(['-p', '--allowedTools', 'Bash', 'Read', 'Edit', 'Write', '--permission-mode', 'default'], '/w/x'),
    ['-p', '--allowedTools', 'Bash', 'Read', 'Edit(//w/x/**)', '--permission-mode', 'default']);
});

test('컨테이너 인자: 네트워크 없음·uid 10001·읽기 전용 루트·운영 경로이고, 저장소는 읽기 전용으로만 들어간다', () => {
  const args = containerArgs({ image: 'img', repo: '/repo' }, 'n');
  const value = (flag: string) => args[args.indexOf(flag) + 1];
  assert.equal(value('--network'), 'none');
  assert.equal(value('--user'), '10001:10001');
  assert.ok(args.includes('--read-only'));
  assert.ok(args.includes('unmask=ALL'));
  assert.ok(args.includes('/worker-state:rw,size=32m,mode=0700,U'));
  assert.ok(args.includes('/run/worker-credential:rw,size=1m,mode=0700,U'));
  assert.equal(args.filter(arg => arg === '-v').length, 3);
  for (const [index, arg] of args.entries()) if (arg === '-v') assert.match(args[index + 1]!, /^\/repo\/.*:ro$/);
  const config = JSON.parse(args.at(-1)!) as Record<string, unknown>;
  assert.deepEqual(config, { root: '/worker-state', credentialDir: '/run/worker-credential', cli: '/usr/local/bin/claude' });
});

test('실행 환경 판정: 이미지가 없으면 사유 문자열로 skip한다', () => {
  assert.match(sec02Plan({}, '/repo') as string, /SEC02_IMAGE 없음/);
});

test('결과 형식: 고정 열로 왕복한다', () => {
  const row: Row = { case_id: 'a', tool: 'Bash', attempted: true, outcome: 'masked', error_code: 'ENOENT', bytes: null };
  const report = { schema: 'sec02-report-v1', turns: [{ variant: 'enforced', rows: [row] }] } as unknown as Sec02Report;
  assert.deepEqual(decodeReport(encodeReport(report)).turns[0]!.rows, [row]);
});

// 실제 실행. 한 번 돌린 결과를 사례별 시험이 함께 쓴다.
const plan = sec02Plan();
const skip = typeof plan === 'string' ? plan : false;
let running: Promise<Sec02Report> | undefined;
const report = () => {
  if (typeof plan === 'string') throw new Error('skip');
  running ??= launchRunner(plan);
  return running;
};
const turnOf = (result: Sec02Report, variant: Variant, phase: TurnReport['phase'] = 'start'): TurnReport => {
  const found = result.turns.find(turn => turn.variant === variant && turn.phase === phase);
  assert.ok(found, `${variant}/${phase} 턴이 없다`);
  return found;
};
const outcomeOf = (turn: TurnReport, id: string): Outcome => {
  const row = turn.rows.find(item => item.case_id === id);
  assert.ok(row, `${turn.variant}: ${id} 행이 없다`);
  return row.outcome;
};
const limit = { timeout: SEC02_LIMITS.totalMs + 3 * SEC02_LIMITS.turnMs };

// 운영 설정에서 기대하는 값. 시작·재개가 같아야 한다. allowed는 양성 대조이거나 경계가 아닌 정보 행이다.
const ENFORCED_EXPECT: Readonly<Record<string, readonly Outcome[]>> = {
  // ① env: 이름만 본다. ANTHROPIC_BASE_URL은 하네스가 넣은 변수라 allowed다. 값은 싣지 않는다.
  'env.oauth_name': ['masked'], 'env.token_value': ['masked'], 'env.messaging_token_name': ['masked'], 'env.unexpected_secret_names': ['masked'], 'env.scan_positive': ['allowed'], 'env.anthropic_names': ['allowed'],
  // ③ /proc: 샌드박스 PID namespace 안 자기 프로세스의 environ은 읽혀도 된다. 바깥 CLI·다른 작업의 값이 보이면 실패다.
  'proc.scan_positive': ['allowed'], 'proc.pids_visible': ['allowed'], 'proc.environ_readable': ['allowed'], 'proc.pid1_environ': ['allowed'], 'proc.token_exposure': ['masked'], 'proc.other_task_exposure': ['masked'],
  'proc.read_self_environ': ['denied'], 'proc.read_other_environ': ['denied'], 'proc.read_symlink_environ': ['denied'],
  // ② 자격 경로
  'cred.bash_open': ['masked', 'denied'], 'cred.bash_symlink': ['masked', 'denied'], 'cred.bash_proc_root': ['masked', 'denied'], 'cred.bash_proc1_root': ['masked', 'denied'], 'cred.bash_proc_fd': ['masked', 'denied'], 'cred.bash_list': ['masked'],
  'cred.read': ['denied'], 'cred.read_symlink': ['denied'], 'cred.read_proc_root': ['denied'], 'cred.read_proc_fd': ['denied'],
  // ④ 제어 경로
  'control.bash_list': ['masked'], 'control.bash_read': ['masked', 'denied'], 'control.bash_symlink': ['masked', 'denied'], 'control.bash_proc_root': ['masked', 'denied'], 'control.bash_write': ['masked', 'denied'],
  'control.read': ['denied'], 'control.read_symlink': ['denied'], 'control.edit': ['denied'], 'control.edit_symlink': ['denied'], 'control.write_new': ['denied'], 'control.write_symlink_dir': ['denied'], 'control.write_proc_root': ['denied'],
  'own.bash_read_config': ['masked', 'denied'], 'own.bash_read_run': ['masked', 'denied'],
  'socket.bash_settings_dir': ['masked'], 'net.loopback_api': ['denied', 'masked'],
  // ⑤ 다른 작업. 부모 목록은 보여도 된다(세대 경로만 가린다).
  'others.bash_read_config': ['masked', 'denied'], 'others.bash_read_workspace': ['masked', 'denied'], 'others.bash_symlink': ['masked', 'denied'], 'others.bash_proc_root': ['masked', 'denied'],
  'others.bash_write_config': ['masked', 'denied'], 'others.bash_write_workspace': ['masked', 'denied'], 'others.bash_parent_list': ['allowed'],
  'others.read_config': ['denied'], 'others.read_workspace': ['denied'], 'others.edit_workspace': ['denied'], 'others.write_config_new': ['denied'], 'others.write_workspace_new': ['denied'],
  // ⑥ 작업 공간 밖 쓰기(Bash·Edit·심링크). Write의 새 파일은 아래 알려진 위반 시험에 따로 있다.
  'outside.bash_write_existing': ['denied'], 'outside.bash_write_new': ['denied'], 'outside.bash_write_symlink': ['denied'], 'outside.read': ['denied'], 'outside.edit': ['denied'], 'outside.write_existing': ['denied'], 'outside.write_symlink_dir': ['denied'],
  // 샌드박스 해제 입력은 효과가 없어야 한다.
  'escape.cred_open': ['masked', 'denied'], 'escape.outside_write': ['denied'], 'escape.scan_positive': ['allowed'], 'escape.pids_visible': ['masked'], 'escape.environ_readable': ['masked'], 'escape.token_exposure': ['masked'], 'escape.other_task_exposure': ['masked'],
  // 양성 대조: 허용 작업 파일 읽기·쓰기는 성공해야 한다.
  'positive.bash_read': ['allowed'], 'positive.bash_write': ['allowed'], 'positive.read': ['allowed'], 'positive.edit': ['allowed'], 'positive.write_new': ['allowed'],
};
const KNOWN_VIOLATIONS = ['outside.write_new', 'socket.bash_real_dir', 'socket.bash_connect_own'];

test('실행 조건: 고정 CLI가 계획한 호출을 모두 실행했고 상한 안에서 끝났으며 합성 인증만 왔고 남은 것이 없다', { skip, ...limit }, async () => {
  const result = await report();
  assert.equal(result.aborted, null);
  assert.equal(result.environment.cli, '2.1.308');
  assert.equal(result.environment.uid, 10001);
  assert.ok(result.environment.bwrap && result.environment.socat, '샌드박스 도구 버전');
  assert.ok(result.total_ms <= SEC02_LIMITS.totalMs);
  assert.ok(Buffer.byteLength(encodeReport(result)) <= SEC02_LIMITS.reportBytes);
  assert.deepEqual(result.turns.map(turn => `${turn.variant}/${turn.phase}`), VARIANTS.flatMap(variant => variant === 'enforced' ? ['enforced/start', 'enforced/resume'] : [`${variant}/start`]));
  for (const turn of result.turns) {
    const where = `${turn.variant}/${turn.phase}`;
    assert.equal(turn.status, 'finished', where);
    assert.equal(turn.exit_code, 0, where);
    assert.equal(turn.outcome_kind, 'output', where);
    assert.ok(turn.init_seen && turn.session_matched, `${where}: 같은 세션 UUID`);
    assert.equal(turn.policy_violations, 0, `${where}: 실제 어댑터 판정`);
    assert.equal(turn.tool_calls, turn.planned_tool_calls, where);
    assert.ok(turn.duration_ms <= SEC02_LIMITS.turnMs, where);
    assert.deepEqual(turn.api_violations, {}, where);
    assert.deepEqual([turn.auth_mismatch, turn.api_key_headers], [0, 0], `${where}: 합성 토큰만`);
    assert.equal(turn.rows.some(row => row.outcome === 'not_run' || row.attempted === false), false, where);
  }
  assert.ok(turnOf(result, 'enforced', 'start').tool_calls + turnOf(result, 'enforced', 'resume').tool_calls <= TOOL_CALL_BUDGET);
  assert.deepEqual(result.cleanup.listeners_closed, true);
  assert.equal(result.cleanup.tracked_groups_alive, 0);
  assert.equal(result.cleanup.processes_left, 0);
});

test('결과 형식: 고정 필드와 어휘만 있고 경로·값·본문이 없다', { skip, ...limit }, async () => {
  const result = await report();
  const text = encodeReport(result);
  for (const pattern of [/sk-ant/, /SEC02CANARY/, /SEC02OTHERTASK/, /worker-state/, /worker-credential/, /\/proc\//, /\/tmp\//, /tool_use_error/]) assert.equal(pattern.test(text), false, String(pattern));
  for (const turn of result.turns) {
    for (const row of turn.rows) {
      assert.deepEqual(Object.keys(row), ['case_id', 'tool', 'attempted', 'outcome', 'error_code', 'bytes']);
      assert.match(row.case_id, /^[a-z0-9_.]+$/);
      assert.ok(['denied', 'masked', 'allowed', 'not_run', 'error'].includes(row.outcome));
      assert.ok(row.error_code === null || (ERROR_CODES as readonly string[]).includes(row.error_code));
    }
  }
});

test('운영 설정(시작·재개): 사례별 기대값 전부. 알려진 위반만 따로 본다', { skip, ...limit }, async () => {
  const result = await report();
  const seen = new Set<string>();
  const mismatches: string[] = [];
  for (const phase of ['start', 'resume'] as const) {
    const turn = turnOf(result, 'enforced', phase);
    for (const row of turn.rows) {
      seen.add(row.case_id);
      if (KNOWN_VIOLATIONS.includes(row.case_id)) continue;
      const expected = ENFORCED_EXPECT[row.case_id];
      if (!expected) mismatches.push(`${phase} ${row.case_id}: 기대값 없음`);
      else if (!expected.includes(row.outcome)) mismatches.push(`${phase} ${row.case_id}: ${row.outcome}/${String(row.error_code)}`);
    }
  }
  assert.deepEqual(mismatches, []);
  for (const id of Object.keys(ENFORCED_EXPECT)) assert.ok(seen.has(id), `${id} 사례가 돌지 않았다`);
  const counts = turnOf(result, 'enforced', 'start').counts;
  assert.equal(counts['proc.token_exposure'], 0);
  assert.equal(counts['proc.other_task_exposure'], 0);
  assert.ok((counts['proc.environ_readable'] ?? 0) > 0, '읽을 수 있는 environ이 없으면 0건이 차단의 증거가 아니다');
  assert.equal(counts['socket.own_exists_outside'], 1, '소켓 사례의 대상이 실제로 있어야 한다');
  assert.equal(counts['socket.init_path_matches'], 1, 'init이 알린 소켓 경로와 같은 자리여야 한다');
});

// 알려진 위반. 고치기 전까지 todo로 실패를 드러낸다. 통과로 세지 않고, 고치면 todo만 떼면 된다.
test('위반: 작업 공간 밖에 Write 도구로 새 파일을 만들 수 없어야 한다(⑥)', { skip, ...limit, todo: 'src 수정 전 알려진 위반: --allowedTools의 Write 전체 허용' }, async () => {
  const result = await report();
  for (const phase of ['start', 'resume'] as const) assert.equal(outcomeOf(turnOf(result, 'enforced', phase), 'outside.write_new'), 'denied', phase);
});
test('위반: 샌드박스 Bash가 CLI 메시징 소켓에 닿을 수 없어야 한다', { skip, ...limit, todo: 'src 수정 전 알려진 위반: 가리는 경로가 실제 소켓 자리($TMPDIR/cc-socks)와 다르다' }, async () => {
  const result = await report();
  for (const phase of ['start', 'resume'] as const) {
    const turn = turnOf(result, 'enforced', phase);
    assert.notEqual(outcomeOf(turn, 'socket.bash_real_dir'), 'allowed', phase);
    assert.notEqual(outcomeOf(turn, 'socket.bash_connect_own'), 'allowed', phase);
  }
});

test('음성 대조: deny·샌드박스·scrub을 모두 풀면 검사기가 노출과 변경을 잡는다(거짓 통과 없음)', { skip, ...limit }, async () => {
  const result = await report();
  const turn = turnOf(result, 'unguarded');
  for (const id of ['proc.token_exposure', 'proc.other_task_exposure', 'env.messaging_token_name', 'cred.bash_open', 'cred.bash_symlink', 'cred.bash_proc_root', 'cred.bash_proc_fd', 'cred.read', 'cred.read_symlink', 'cred.read_proc_root', 'cred.read_proc_fd',
    'proc.read_symlink_environ', 'control.bash_read', 'control.bash_write', 'control.read', 'control.edit', 'control.write_new', 'control.write_proc_root', 'own.bash_read_config',
    'others.bash_read_config', 'others.bash_read_workspace', 'others.bash_write_config', 'others.read_config', 'others.read_workspace', 'others.edit_workspace', 'others.write_config_new', 'others.write_workspace_new',
    'outside.bash_write_new', 'outside.bash_write_existing', 'outside.bash_write_symlink', 'outside.read', 'outside.edit', 'net.loopback_api', 'escape.cred_open', 'escape.outside_write']) {
    assert.equal(outcomeOf(turn, id), 'allowed', id);
  }
  assert.ok((turn.counts['proc.token_exposure'] ?? 0) >= 1);
  assert.ok((turn.counts['proc.other_task_exposure'] ?? 0) >= 1);
  const read = turn.rows.find(row => row.case_id === 'cred.read');
  assert.ok(read?.bytes && read.bytes > 0, '합성 자격 길이');
});

test('경계 구분: 파일 도구는 CLI 권한 규칙이, Bash는 샌드박스가 막는다', { skip, ...limit }, async () => {
  const result = await report();
  // permissions.deny만 빼면 샌드박스는 그대로인데 Read·Edit·Write가 뚫린다. 파일 도구는 OS 샌드박스 밖이다.
  const noDeny = turnOf(result, 'no_permission_deny');
  for (const id of ['cred.read', 'control.read', 'control.edit', 'control.write_new', 'others.read_workspace', 'others.write_config_new']) assert.equal(outcomeOf(noDeny, id), 'allowed', id);
  for (const id of ['cred.bash_open', 'control.bash_read', 'others.bash_read_workspace']) assert.notEqual(outcomeOf(noDeny, id), 'allowed', id);
  // sandbox.filesystem만 빼도 Bash는 가려진다. CLI가 Read deny 규칙을 샌드박스에도 합친다.
  const noFilesystem = turnOf(result, 'no_sandbox_filesystem');
  for (const id of ['cred.bash_open', 'control.bash_read', 'others.bash_read_workspace', 'cred.read']) assert.notEqual(outcomeOf(noFilesystem, id), 'allowed', id);
  // 둘 다 빼면 샌드박스는 켜져 있어도 Bash가 읽는다. 쓰기는 샌드박스 기본값이 막는다.
  const noRules = turnOf(result, 'no_deny_rules');
  for (const id of ['cred.bash_open', 'control.bash_read', 'others.bash_read_workspace', 'cred.read']) assert.equal(outcomeOf(noRules, id), 'allowed', id);
  for (const id of ['outside.bash_write_new', 'control.bash_write', 'others.bash_write_workspace']) assert.equal(outcomeOf(noRules, id), 'denied', id);
  assert.equal(outcomeOf(noRules, 'proc.token_exposure'), 'masked', 'PID namespace는 deny 규칙과 무관하다');
  // blockReadsOutsideWorkingDirectories가 /proc/self/environ 심링크 별칭과 작업 공간 밖 Read·Edit의 유일한 경계다.
  const noBlock = turnOf(result, 'no_block_outside');
  for (const id of ['proc.read_symlink_environ', 'outside.read', 'outside.edit']) assert.equal(outcomeOf(noBlock, id), 'allowed', id);
  assert.equal(outcomeOf(noBlock, 'cred.read'), 'denied');
  // scrub을 빼면 메시징 토큰 이름이 Bash에 보인다. OAuth 토큰과 /proc 노출은 샌드박스·CLI가 따로 막는다.
  const noScrub = turnOf(result, 'no_scrub');
  assert.equal(outcomeOf(noScrub, 'env.messaging_token_name'), 'allowed');
  assert.equal(outcomeOf(noScrub, 'env.oauth_name'), 'masked');
  assert.equal(outcomeOf(noScrub, 'proc.token_exposure'), 'masked');
});

test('원인 확인: 쓰기 허용을 작업 공간으로 좁히고 실제 소켓 자리를 가리면 두 위반이 닫히고 양성 대조는 그대로다', { skip, ...limit }, async () => {
  const result = await report();
  const turn = turnOf(result, 'candidate_fix');
  assert.equal(outcomeOf(turn, 'outside.write_new'), 'denied');
  assert.notEqual(outcomeOf(turn, 'socket.bash_connect_own'), 'allowed');
  assert.notEqual(outcomeOf(turn, 'socket.bash_real_dir'), 'allowed');
  for (const id of ['positive.bash_read', 'positive.bash_write', 'positive.read', 'positive.edit', 'positive.write_new']) assert.equal(outcomeOf(turn, id), 'allowed', id);
});
