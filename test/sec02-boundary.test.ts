import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, realpath, rm } from 'node:fs/promises';
import { connect } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { FakeMessagesApi, RefusingProxy, TOOL_CALL_BUDGET } from './sec02-fake-api.js';
import type { TurnScript } from './sec02-fake-api.js';
import { ERROR_CODES, Sec02Layout, caseTable, classifyToolError, fallbackTable, judgeProbe, namesTable, scopeTable, unlistedTable } from './sec02-fixture.js';
import type { Outcome, Row } from './sec02-fixture.js';
import { ENFORCED_EXPECT, SCOPE_EXPECT, SCOPE_RULE_DENIED } from './sec02-expect.js';
import { RESUMED_VARIANTS, SEC02_LIMITS, VARIANTS, containerArgs, decodeReport, encodeReport, launchRunner, sec02Plan, unscopedAllowArgs, variantSettings } from './sec02-harness.js';
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
    ['<tool_use_error>Error: No such tool available: NotebookEdit</tool_use_error>', 'tool_unavailable'],
    ['Claude requested permissions to edit /x/.bashrc which is a sensitive file.', 'sensitive_file'],
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
  const scope = scopeTable(layout);
  // 변형마다 API 예산이 따로다. 시작·재개를 합쳐 상한 안이어야 한다.
  for (const table of [steps, scope]) assert.ok((table.length + 1) * 2 <= TOOL_CALL_BUDGET, `호출 ${(table.length + 1) * 2}회`);
  for (const table of [namesTable(layout), unlistedTable(layout), fallbackTable(layout), [...scope, ...namesTable(layout)]]) assert.ok(table.length + 1 <= TOOL_CALL_BUDGET);
  const names = [steps, scope, namesTable(layout), unlistedTable(layout), fallbackTable(layout)].flat().map(step => step.name);
  assert.equal(new Set(names).size, names.length);
  assert.equal(layout.others.length, 2, '다른 job과 같은 job의 다른 세대');
  assert.ok(layout.token.includes('sec02-synthetic'));
  assert.notEqual(new Sec02Layout({ root: join(scratch, 'state'), credentialDir: join(scratch, 'cred') }).token, layout.token, '실행마다 새 값');
});

test('대조군 설정: enforced는 운영 설정 그대로이고 나머지만 푼다. legacy는 실제 소켓 자리 가림과 쓰기 경로 제한만 뺀다', () => {
  const production = JSON.stringify({ sandbox: { enabled: true, filesystem: { denyRead: ['/a'] } }, permissions: { deny: ['Read(//a/**)'], blockReadsOutsideWorkingDirectories: true } });
  for (const variant of ['enforced', 'enforced_scope', 'enforced_names', 'long_tmpdir', 'unlisted_tools'] as const) assert.equal(variantSettings(variant, production), production, variant);
  const sockets = ['/t/cc-socks', '/tmp/cc-socks-1'];
  const withSockets = JSON.stringify({ sandbox: { enabled: true, filesystem: { denyRead: sockets, denyWrite: sockets } }, permissions: { deny: sockets.map(path => `Read(/${path}/**)`), blockReadsOutsideWorkingDirectories: true } });
  const legacy = JSON.parse(variantSettings('legacy_unscoped', withSockets)) as { sandbox: { filesystem: Record<string, string[]> }; permissions: { deny: string[] } };
  assert.deepEqual(legacy.sandbox.filesystem, { denyRead: ['/tmp/cc-socks-1'], denyWrite: ['/tmp/cc-socks-1'] });
  assert.deepEqual(legacy.permissions.deny, ['Read(//tmp/cc-socks-1/**)']);
  assert.deepEqual(JSON.parse(variantSettings('unguarded', production)), { sandbox: { enabled: false }, permissions: {} });
  assert.deepEqual(JSON.parse(variantSettings('no_permission_deny', production)).sandbox.filesystem, { denyRead: ['/a'] });
  assert.deepEqual(JSON.parse(variantSettings('no_permission_deny', production)).permissions, {});
  assert.deepEqual(JSON.parse(variantSettings('no_sandbox_filesystem', production)).sandbox.filesystem, {});
  assert.deepEqual(JSON.parse(variantSettings('no_block_outside', production)).permissions, { deny: ['Read(//a/**)'] });
  assert.deepEqual(unscopedAllowArgs(['-p', '--allowedTools', 'Bash', 'Read', 'Edit(//w/x/**)', '--permission-mode', 'default']),
    ['-p', '--allowedTools', 'Bash', 'Read', 'Edit', 'Write', '--permission-mode', 'default']);
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

const codeOf = (turn: TurnReport, id: string) => turn.rows.find(row => row.case_id === id)?.error_code;
const violationVariants: readonly Variant[] = ['unlisted_tools'];

test('실행 조건: 고정 CLI가 계획한 호출을 모두 실행했고 상한 안에서 끝났으며 합성 인증만 왔고 남은 것이 없다', { skip, ...limit }, async () => {
  const result = await report();
  assert.equal(result.aborted, null);
  assert.equal(result.environment.cli, '2.1.308');
  assert.equal(result.environment.uid, 10001);
  assert.ok(result.environment.bwrap && result.environment.socat, '샌드박스 도구 버전');
  assert.ok(result.total_ms <= SEC02_LIMITS.totalMs);
  assert.ok(Buffer.byteLength(encodeReport(result)) <= SEC02_LIMITS.reportBytes);
  assert.deepEqual(result.turns.map(turn => `${turn.variant}/${turn.phase}`), VARIANTS.flatMap(variant => RESUMED_VARIANTS.includes(variant) ? [`${variant}/start`, `${variant}/resume`] : [`${variant}/start`]));
  for (const turn of result.turns) {
    const where = `${turn.variant}/${turn.phase}`;
    assert.equal(turn.status, 'finished', where);
    assert.equal(turn.exit_code, 0, where);
    assert.ok(turn.init_seen && turn.session_matched, `${where}: 같은 세션 UUID`);
    // 목록 밖 도구를 일부러 부른 변형은 판정이 위반으로 끝나야 한다. 아래 따로 본다.
    if (!violationVariants.includes(turn.variant)) {
      assert.equal(turn.outcome_kind, 'output', where);
      assert.equal(turn.policy_violations, 0, `${where}: 실제 어댑터 판정`);
    }
    assert.equal(turn.tool_calls, turn.planned_tool_calls, where);
    assert.ok(turn.duration_ms <= SEC02_LIMITS.turnMs, where);
    assert.deepEqual(turn.api_violations, {}, where);
    assert.deepEqual([turn.auth_mismatch, turn.api_key_headers], [0, 0], `${where}: 합성 토큰만`);
    assert.equal(turn.rows.some(row => row.outcome === 'not_run' || row.attempted === false), false, where);
  }
  for (const variant of RESUMED_VARIANTS) assert.ok(turnOf(result, variant, 'start').tool_calls + turnOf(result, variant, 'resume').tool_calls <= TOOL_CALL_BUDGET, variant);
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

test('운영 설정(시작·재개): 사례별 기대값 전부', { skip, ...limit }, async () => {
  const result = await report();
  const seen = new Set<string>();
  const mismatches: string[] = [];
  for (const phase of ['start', 'resume'] as const) {
    const turn = turnOf(result, 'enforced', phase);
    for (const row of turn.rows) {
      seen.add(row.case_id);
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

test('경계: 작업 공간 밖에 Write 도구로 새 파일을 만들 수 없다. 먼저 읽기 검사가 아니라 권한 규칙이 막는다(⑥)', { skip, ...limit }, async () => {
  const result = await report();
  for (const phase of ['start', 'resume'] as const) {
    const turn = turnOf(result, 'enforced', phase);
    assert.equal(outcomeOf(turn, 'outside.write_new'), 'denied', phase);
    assert.equal(codeOf(turn, 'outside.write_new'), 'permission_denied', phase);
  }
});
test('경계: 샌드박스 Bash가 CLI 메시징 소켓에 닿을 수 없다. 대상 소켓은 실제로 있다', { skip, ...limit }, async () => {
  const result = await report();
  for (const phase of ['start', 'resume'] as const) {
    const turn = turnOf(result, 'enforced', phase);
    assert.equal(outcomeOf(turn, 'socket.bash_real_dir'), 'masked', phase);
    assert.equal(outcomeOf(turn, 'socket.bash_connect_own'), 'masked', phase);
    assert.equal(codeOf(turn, 'socket.bash_connect_own'), 'ENOENT', phase);
    assert.equal(turn.counts['socket.own_exists_outside'], 1, phase);
    assert.equal(turn.counts['socket.init_path_matches'], 1, phase);
  }
});

test('쓰기 허용의 경계(시작·재개): 경로를 비틀어도 작업 공간 밖은 거부되고 안은 된다', { skip, ...limit }, async () => {
  const result = await report();
  const mismatches: string[] = [];
  for (const phase of ['start', 'resume'] as const) {
    const turn = turnOf(result, 'enforced_scope', phase);
    assert.deepEqual(turn.rows.map(row => row.case_id).sort(), Object.keys(SCOPE_EXPECT).sort(), phase);
    for (const row of turn.rows) if (!SCOPE_EXPECT[row.case_id]!.includes(row.outcome)) mismatches.push(`${phase} ${row.case_id}: ${row.outcome}/${String(row.error_code)}`);
    // 먼저 읽기 검사가 앞에서 막은 것을 규칙의 증거로 세지 않는다.
    for (const id of SCOPE_RULE_DENIED) if (codeOf(turn, id) !== 'permission_denied') mismatches.push(`${phase} ${id}: 규칙이 아니라 ${String(codeOf(turn, id))}`);
    assert.equal(turn.counts['socket.visible_messaging'], 0, `${phase}: 샌드박스에 보이는 메시징 소켓`);
    assert.equal(turn.counts['socket.visible_other'], 2, `${phase}: 샌드박스 자신의 중계 소켓(claude-http, srt-mux) 말고 더 생기면 다시 본다`);
  }
  assert.deepEqual(mismatches, []);
});

test('보호 이름: 쓰기 허용을 좁혀도 작업 공간 안에서 쓸 수 있는 자리가 옛 규칙과 같다', { skip, ...limit }, async () => {
  const result = await report();
  const names = ['git', 'claude', 'github', 'gitignore', 'bashrc', 'mcp'].map(name => `names.write_${name}`);
  const before = turnOf(result, 'legacy_scope');
  const after = turnOf(result, 'enforced_names');
  for (const id of names) assert.deepEqual([outcomeOf(after, id), codeOf(after, id)], [outcomeOf(before, id), codeOf(before, id)], id);
  for (const id of ['names.write_github', 'names.write_gitignore']) assert.equal(outcomeOf(after, id), 'allowed', id);
  for (const id of ['names.write_git', 'names.write_bashrc', 'names.write_mcp']) assert.equal(codeOf(after, id), 'sensitive_file', id);
  assert.equal(codeOf(after, 'names.write_claude'), 'permission_denied');
});

test('목록 밖 쓰기 도구: 고정 CLI가 실행하지 않고 어댑터 판정이 위반으로 끝낸다', { skip, ...limit }, async () => {
  const turn = turnOf(await report(), 'unlisted_tools');
  for (const id of ['unlisted.notebook_edit', 'unlisted.multi_edit']) assert.deepEqual([outcomeOf(turn, id), codeOf(turn, id)], ['denied', 'tool_unavailable'], id);
  assert.equal(turn.policy_violations, 2);
  assert.deepEqual([turn.outcome_kind, turn.outcome_reason], ['failed', 'policy_violation']);
});

test('긴 TMPDIR: 소켓이 fallback 자리로 옮겨 가면 Bash는 닫혀 있고 파일 도구는 거부된다. 그 자리를 가리지 않는 근거다', { skip, ...limit }, async () => {
  const turn = turnOf(await report(), 'long_tmpdir');
  assert.equal(turn.counts['socket.own_exists_outside'], 1, '소켓이 fallback 자리에 실제로 있다');
  assert.equal(turn.counts['socket.init_path_matches'], 1);
  // 이 순서가 바뀌어 Bash가 살아나면 fallback 소켓에 닿는다. 그때는 가림을 되살려야 한다.
  for (const id of ['fallback.bash_dir', 'fallback.bash_connect_own', 'fallback.bash_positive_read']) assert.deepEqual([outcomeOf(turn, id), codeOf(turn, id)], ['error', 'tool_error'], id);
  assert.deepEqual([outcomeOf(turn, 'fallback.read_own'), codeOf(turn, 'fallback.read_own')], ['denied', 'outside_cwd_blocked']);
  assert.deepEqual([outcomeOf(turn, 'fallback.write_new'), codeOf(turn, 'fallback.write_new')], ['denied', 'permission_denied']);
  assert.equal(outcomeOf(turn, 'fallback.positive_write'), 'allowed', '파일 도구는 그대로 돈다');
});

test('음성 대조: deny·샌드박스·scrub을 모두 풀면 검사기가 노출과 변경을 잡는다(거짓 통과 없음)', { skip, ...limit }, async () => {
  const result = await report();
  const turn = turnOf(result, 'unguarded');
  for (const id of ['proc.token_exposure', 'proc.other_task_exposure', 'env.messaging_token_name', 'cred.bash_open', 'cred.bash_symlink', 'cred.bash_proc_root', 'cred.bash_proc_fd', 'cred.read', 'cred.read_symlink', 'cred.read_proc_root', 'cred.read_proc_fd',
    'proc.read_symlink_environ', 'control.bash_read', 'control.bash_write', 'control.read', 'control.edit', 'control.write_new', 'control.write_proc_root', 'own.bash_read_config',
    'others.bash_read_config', 'others.bash_read_workspace', 'others.bash_write_config', 'others.read_config', 'others.read_workspace', 'others.edit_workspace', 'others.write_config_new', 'others.write_workspace_new',
    'outside.bash_write_new', 'outside.bash_write_existing', 'outside.bash_write_symlink', 'outside.read', 'outside.edit', 'outside.write_new', 'socket.bash_real_dir', 'socket.bash_connect_own', 'net.loopback_api', 'escape.cred_open', 'escape.outside_write']) {
    assert.equal(outcomeOf(turn, id), 'allowed', id);
  }
  assert.ok((turn.counts['proc.token_exposure'] ?? 0) >= 1);
  assert.ok((turn.counts['proc.other_task_exposure'] ?? 0) >= 1);
  const read = turn.rows.find(row => row.case_id === 'cred.read');
  assert.ok(read?.bytes && read.bytes > 0, '합성 자격 길이');
});

test('경계 구분: 파일 도구는 CLI 권한 규칙이, Bash는 샌드박스가 막는다', { skip, ...limit }, async () => {
  const result = await report();
  // permissions를 빼면 샌드박스는 그대로인데 Read가 뚫린다. 파일 도구는 OS 샌드박스 밖이다. 쓰기는 작업 공간 허용 규칙이 따로 막아 두 겹이다.
  const noDeny = turnOf(result, 'no_permission_deny');
  for (const id of ['cred.read', 'control.read', 'others.read_workspace']) assert.equal(outcomeOf(noDeny, id), 'allowed', id);
  for (const id of ['control.edit', 'control.write_new', 'others.edit_workspace', 'others.write_config_new', 'outside.edit', 'outside.write_new']) assert.deepEqual([outcomeOf(noDeny, id), codeOf(noDeny, id)], ['denied', 'permission_denied'], id);
  for (const id of ['cred.bash_open', 'control.bash_read', 'others.bash_read_workspace']) assert.notEqual(outcomeOf(noDeny, id), 'allowed', id);
  // sandbox.filesystem만 빼도 Bash는 가려진다. CLI가 Read deny 규칙을 샌드박스에도 합친다.
  const noFilesystem = turnOf(result, 'no_sandbox_filesystem');
  for (const id of ['cred.bash_open', 'control.bash_read', 'others.bash_read_workspace', 'cred.read']) assert.notEqual(outcomeOf(noFilesystem, id), 'allowed', id);
  // 둘 다 빼면 샌드박스는 켜져 있어도 Bash가 읽는다. 쓰기는 샌드박스 기본값이 막는다.
  const noRules = turnOf(result, 'no_deny_rules');
  for (const id of ['cred.bash_open', 'control.bash_read', 'others.bash_read_workspace', 'cred.read']) assert.equal(outcomeOf(noRules, id), 'allowed', id);
  for (const id of ['outside.bash_write_new', 'control.bash_write', 'others.bash_write_workspace']) assert.equal(outcomeOf(noRules, id), 'denied', id);
  assert.equal(outcomeOf(noRules, 'proc.token_exposure'), 'masked', 'PID namespace는 deny 규칙과 무관하다');
  // blockReadsOutsideWorkingDirectories가 /proc/self/environ 심링크 별칭과 작업 공간 밖 Read의 유일한 경계다. Edit는 먼저 읽기가 풀려도 쓰기 허용 규칙이 막는다.
  const noBlock = turnOf(result, 'no_block_outside');
  for (const id of ['proc.read_symlink_environ', 'outside.read']) assert.equal(outcomeOf(noBlock, id), 'allowed', id);
  assert.deepEqual([outcomeOf(noBlock, 'outside.edit'), codeOf(noBlock, 'outside.edit')], ['denied', 'permission_denied']);
  assert.equal(outcomeOf(noBlock, 'cred.read'), 'denied');
  // Bash 판정은 이 설정 유무로 달라지지 않는다.
  const bashRows = (turn: TurnReport) => turn.rows.filter(row => row.tool === 'Bash').map(row => [row.case_id, row.outcome, row.error_code]);
  assert.deepEqual(bashRows(noBlock), bashRows(turnOf(result, 'enforced')));
  // scrub을 빼면 메시징 토큰 이름이 Bash에 보인다. OAuth 토큰과 /proc 노출은 샌드박스·CLI가 따로 막는다.
  const noScrub = turnOf(result, 'no_scrub');
  assert.equal(outcomeOf(noScrub, 'env.messaging_token_name'), 'allowed');
  assert.equal(outcomeOf(noScrub, 'env.oauth_name'), 'masked');
  assert.equal(outcomeOf(noScrub, 'proc.token_exposure'), 'masked');
});

test('음성 대조: 옛 쓰기 허용과 옛 소켓 가림으로 되돌리면 같은 사례가 뚫린다. 달라지는 것은 그 행뿐이다', { skip, ...limit }, async () => {
  const result = await report();
  const legacy = turnOf(result, 'legacy_unscoped');
  const enforced = turnOf(result, 'enforced');
  for (const id of ['outside.write_new', 'socket.bash_real_dir', 'socket.bash_connect_own']) assert.equal(outcomeOf(legacy, id), 'allowed', id);
  const changed = legacy.rows.filter((row, index) => row.outcome !== enforced.rows[index]!.outcome).map(row => row.case_id).sort();
  assert.deepEqual(changed, ['outside.write_new', 'socket.bash_connect_own', 'socket.bash_real_dir']);
  const scope = turnOf(result, 'legacy_scope');
  for (const id of ['scope.write_tasks_name', 'scope.write_state_root', 'scope.write_generation', 'scope.write_home', 'scope.write_tmp', 'scope.write_system_tmp', 'scope.write_sibling_prefix',
    'scope.write_dotdot', 'scope.write_relative', 'scope.write_proc_root', 'scope.edit_new', 'socket.write_new', 'socket.write_fallback_new', 'socket.visible_messaging']) assert.equal(outcomeOf(scope, id), 'allowed', id);
  assert.equal(scope.counts['socket.visible_messaging'], 1);
});

test('양성 대조: 허용 작업 파일 읽기·쓰기는 운영 설정의 시작·재개에서 그대로 된다', { skip, ...limit }, async () => {
  const result = await report();
  for (const phase of ['start', 'resume'] as const) {
    const turn = turnOf(result, 'enforced', phase);
    for (const id of ['positive.bash_read', 'positive.bash_write', 'positive.read', 'positive.edit', 'positive.write_new']) assert.equal(outcomeOf(turn, id), 'allowed', `${phase} ${id}`);
    const scope = turnOf(result, 'enforced_scope', phase);
    for (const id of ['positive.write_dotfile', 'positive.write_new_dirs', 'positive.edit_new_file', 'positive.write_overwrite']) assert.equal(outcomeOf(scope, id), 'allowed', `${phase} ${id}`);
  }
});
