import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { chmod, mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { RunCredential, WorkerCredential } from '../src/credentials.js';
import { compactTaskEvent, judgeTaskRun, runTaskTurn, taskErrorDetail, taskStreamPolicy } from '../src/executor-claude-task.js';
import type { TaskTurnTrace } from '../src/executor-claude-task.js';
import { compactClaudeEvent, interpretClaudeStream, noteClaudeError, safeIdentifier } from '../src/executor-claude.js';
import type { ClaudeExpectation } from '../src/executor-claude.js';
import { RunControl } from '../src/run-control.js';
import { TaskResponseSchema } from '../src/task-contracts.js';
import type { TaskRequest, TaskResponse } from '../src/task-contracts.js';
import { TaskSessions } from '../src/task-workspace.js';
import type { TaskSession } from '../src/task-workspace.js';
import { SpawnLauncher } from './spawn-launcher.js';
import { WORKER, archive, initEvent, startRequest } from './task-fixtures.js';

// 오류로 끝난 턴의 사유 분류와 task_turn_error_detail. 모델·네트워크 없음: claude 자리에 가짜 실행 파일을 두고 실제 RunControl로 돌린다.
// 필드 이름과 위치는 고정 바이너리 2.1.308의 SDK 스키마를 읽은 것이다. 실제 API 오류 흐름과의 대조는 다음 live 진단에서 한다.
const scratch = await realpath(await mkdtemp(join(tmpdir(), 't18-diag-')));
after(async () => { await rm(scratch, { recursive: true, force: true }); });
const TOKEN = 'sk-ant-oat01-fixture-token-ABCDEFGHIJKLMNOPQRSTUVWXYZ-0123456789';
const FAKE_SECRET = 'sk-ant-api03-reflected-FAKE-SECRET-value';
const MODEL = 'claude-opus-5-5';
const EXPECT: ClaudeExpectation = { model: MODEL, apiKeySource: 'none', version: '2.1.308' };
const OK_EXIT = { code: 0, signal: null };

const FAKE_CLI = (root: string) => `#!${process.execPath}
const fs = require('node:fs');
const path = require('node:path');
const args = process.argv.slice(2);
const flag = name => args[args.indexOf(name) + 1];
const session = args.includes('--session-id') ? flag('--session-id') : flag('--resume');
process.stdin.resume();
process.stdin.on('end', () => {
  const step = JSON.parse(fs.readFileSync(${JSON.stringify(join(root, 'step.json'))}, 'utf8'));
  const projects = path.join(process.env.CLAUDE_CONFIG_DIR, 'projects', 'encoded');
  fs.mkdirSync(projects, { recursive: true });
  fs.appendFileSync(path.join(projects, session + '.jsonl'), '{}\\n');
  if (step.stderr) process.stderr.write(step.stderr);
  const lines = step.lines.map(event => JSON.stringify(JSON.parse(JSON.stringify(event).replaceAll('SESSION', session))));
  let chain = Promise.resolve();
  for (const line of lines) chain = chain.then(() => new Promise(done => process.stdout.write(line + '\\n', done)));
  chain.then(() => { if (step.signal) process.kill(process.pid, step.signal); else process.exit(step.exit ?? 0); });
});
`;
interface Step { lines: unknown[]; exit?: number; signal?: string; stderr?: string }
const GOOD = archive([{ name: 'README.md', data: 'hello\n' }, { name: 'src', type: '5' }, { name: 'src/a.ts', data: 'a\n' }]);
const credential: WorkerCredential = { kind: 'env-static', open: async () => 'present', ready: async () => true,
  forRun: async (): Promise<RunCredential> => ({ value: TOKEN, secrets: [TOKEN] }), secrets: async () => [TOKEN] };
async function run(step: Step, request: TaskRequest = startRequest()) {
  const root = await mkdtemp(join(scratch, 'turn-'));
  const state = join(root, 'state');
  await mkdir(state);
  const bin = join(root, 'claude');
  await writeFile(bin, FAKE_CLI(root));
  await chmod(bin, 0o755);
  await writeFile(join(root, 'step.json'), JSON.stringify(step));
  const control = new RunControl(credential, new SpawnLauncher(bin), { tmp: root, homes: ['/nonexistent-home'] });
  const sessions = new TaskSessions(state, { storage: WORKER.storage, homes: ['/nonexistent-home'] });
  const logs: Record<string, unknown>[] = [];
  const response: TaskResponse = TaskResponseSchema.parse(await runTaskTurn({ control, sessions, fetchArchive: async () => GOOD, worker: WORKER, model: MODEL,
    auth: 'subscription-token', credentialDir: '/run/worker-credential', socketDir: '/tmp/cc-socks-fixture', log: item => { logs.push(item); } }, request, new AbortController().signal));
  return { response, logs, request };
}
const details = (logs: Record<string, unknown>[]) => logs.filter(item => item.event === 'task_turn_error_detail');
const INIT = initEvent('SESSION');
const apiError = (fields: Record<string, unknown>) => ({ type: 'assistant', session_id: 'SESSION', message: { model: '<synthetic>', content: [{ type: 'text', text: 'API Error' }] }, ...fields });
const errorResult = (fields: Record<string, unknown> = {}) => ({ type: 'result', subtype: 'success', is_error: true, session_id: 'SESSION', result: 'API Error', stop_reason: null, ...fields });
const statusOf = (response: TaskResponse) => response.status === 'failed' ? response.reason : response.status;
const NO_API_FIELDS = { assistant_error: null, api_error: null, api_error_status: null, stop_reason: null, api_error_code: null, api_error_origin: null };

test('분류와 진단: HTTP 상태별 오류는 지금 분류 그대로이고 구조화 필드가 이벤트에 남는다', async () => {
  const cases: [string, Step, string, string, Record<string, unknown>][] = [
    ['400', { lines: [INIT, apiError({ error: 'invalid_request', api_error_status: 400, api_error_code: 'bad_field', api_error_origin: 'first_party' }), errorResult({ api_error_status: 400, api_error_code: 'bad_field', api_error_origin: 'first_party' })], exit: 1 },
      'api_error', 'api_error', { assistant_error: 'invalid_request', api_error_status: 400, api_error_code: 'bad_field', api_error_origin: 'first_party' }],
    ['401', { lines: [INIT, apiError({ error: 'authentication_failed', api_error_status: 401 }), errorResult({ api_error_status: 401 })], exit: 1 },
      'auth_expired', 'auth_expired', { assistant_error: 'authentication_failed', api_error_status: 401 }],
    ['429', { lines: [INIT, apiError({ error: 'rate_limit', api_error_status: 429 }), errorResult({ api_error_status: 429 })], exit: 1 },
      'limited', 'limited', { assistant_error: 'rate_limit', api_error_status: 429 }],
    ['500', { lines: [INIT, apiError({ error: 'server_error', api_error_status: 500 }), errorResult({ api_error_status: 500 })], exit: 1 },
      'api_error', 'api_error', { assistant_error: 'server_error', api_error_status: 500 }],
    ['529', { lines: [INIT, apiError({ error: 'overloaded', api_error_status: 529 }), errorResult({ api_error_status: 529 })], exit: 1 },
      'api_error', 'api_error', { assistant_error: 'overloaded', api_error_status: 529 }],
  ];
  for (const [name, step, status, engine, fields] of cases) {
    const { response, logs, request } = await run(step);
    assert.equal(statusOf(response), status, name);
    assert.deepEqual(details(logs), [{ level: 'warn', event: 'task_turn_error_detail', job: request.job, generation: request.generation, turn: request.turn,
      status: response.status, reason: response.status === 'failed' ? response.reason : null, cli_version: '2.1.308', init_confirmed: true, engine_reason: engine,
      result_subtype: 'success', is_error: true, exit_code: 1, exit_signal: null, tools: 0, ...NO_API_FIELDS, ...fields }], name);
  }
});

test('분류와 진단: 연결 종료는 상태 없는 api_error, result 없이 끊기면 no_result, 신호 종료도 남긴다', async () => {
  const closed = await run({ lines: [INIT, apiError({ error: 'unknown', api_error: 'no_response' }), errorResult({ api_error: 'no_response' })], exit: 1 });
  assert.equal(statusOf(closed.response), 'api_error');
  const [detail] = details(closed.logs);
  assert.equal(detail!.api_error, 'no_response');
  assert.equal(detail!.api_error_status, null);
  assert.equal(detail!.assistant_error, 'unknown');

  const cut = await run({ lines: [INIT, apiError({ error: 'server_error' })], signal: 'SIGKILL' });
  assert.equal(statusOf(cut.response), 'no_result');
  const [killed] = details(cut.logs);
  assert.equal(killed!.exit_code, null);
  assert.equal(killed!.exit_signal, 'SIGKILL');
  assert.equal(killed!.result_subtype, null);
  assert.equal(killed!.is_error, null);
  assert.equal(killed!.assistant_error, 'server_error');
});

test('거절: stop_reason·DLP·안전 모니터는 api_error와 갈리고, 계약 사유로 model_cannot_complete를 내며 진단이 model_refusal을 말한다', async () => {
  const cases: [string, Step, Record<string, unknown>][] = [
    ['stop_reason 오류 result', { lines: [INIT, apiError({ message: { model: MODEL, stop_reason: 'refusal', content: [] } }), errorResult({ stop_reason: 'refusal' })], exit: 1 }, { stop_reason: 'refusal' }],
    ['assistant에만 있는 stop_reason', { lines: [INIT, apiError({ message: { model: MODEL, stop_reason: 'refusal', content: [] } }), errorResult()], exit: 1 }, { stop_reason: 'refusal' }],
    ['HTTP 200 거절(is_error 없음, 출력 없음)', { lines: [INIT, errorResult({ is_error: false, stop_reason: 'refusal' })] }, { stop_reason: 'refusal' }],
    ['DLP', { lines: [INIT, apiError({ error: 'invalid_request', api_error: 'dlp_request_denied', api_error_status: 403 }), errorResult({ api_error: 'dlp_request_denied', api_error_status: 403 })], exit: 1 }, { assistant_error: 'invalid_request', api_error: 'dlp_request_denied', api_error_status: 403 }],
    ['안전 모니터', { lines: [INIT, apiError({ error: 'invalid_request', api_error: 'safety_monitor_blocked' }), errorResult({ api_error: 'safety_monitor_blocked' })], exit: 1 }, { assistant_error: 'invalid_request', api_error: 'safety_monitor_blocked' }],
  ];
  for (const [name, step, fields] of cases) {
    const { response, logs } = await run(step);
    assert.equal(statusOf(response), 'model_cannot_complete', name);
    const [detail] = details(logs);
    assert.equal(detail!.engine_reason, 'model_refusal', name);
    assert.equal(detail!.reason, 'model_cannot_complete', name);
    for (const [key, value] of Object.entries(fields)) assert.equal(detail![key], value, `${name} ${key}`);
  }
});

const SESSION = randomUUID();
const judge = (events: readonly unknown[], exit = OK_EXIT) => interpretClaudeStream(events.map(event => JSON.stringify(event)), exit, EXPECT, taskStreamPolicy(SESSION));
const live = (fields: Record<string, unknown>) => ({ type: 'assistant', session_id: SESSION, message: { model: '<synthetic>', content: [] }, ...fields });
const finished = (fields: Record<string, unknown> = {}) => ({ type: 'result', subtype: 'success', is_error: true, session_id: SESSION, ...fields });

test('거절 판정의 경계: 명시한 거절만 model_refusal이고 인증·한도 분류와 정상 출력은 그대로다', () => {
  const init = initEvent(SESSION);
  const refusal = { kind: 'failed', reason: 'model_refusal' };
  assert.deepEqual(judge([init, finished({ stop_reason: 'refusal' })]), refusal);
  assert.deepEqual(judge([init, finished({ subtype: 'error_during_execution', stop_reason: 'refusal' })]), refusal, '실행 오류 result의 거절도 거절이다');
  // HTTP 상태만 보면 403이 인증 만료로 읽혀 재인증을 기다리게 된다.
  assert.deepEqual(judge([init, live({ api_error: 'dlp_request_denied', api_error_status: 403 }), finished({ api_error_status: 403 })]), refusal);
  assert.deepEqual(judge([init, live({ error: 'rate_limit' }), finished()]), { kind: 'limited' });
  assert.deepEqual(judge([init, finished({ api_error_status: 401 })]), { kind: 'auth_expired' });
  assert.deepEqual(judge([init, live({ error: 'server_error', api_error: 'no_response' }), finished()]), { kind: 'failed', reason: 'api_error' });
  assert.deepEqual(judge([init, finished({ stop_reason: 'end_turn' })]), { kind: 'failed', reason: 'api_error' });
  // 모델 글 안의 낱말은 보지 않는다.
  assert.deepEqual(judge([init, live({ message: { model: '<synthetic>', content: [{ type: 'text', text: 'refusal dlp_request_denied' }] } }), finished()]), { kind: 'failed', reason: 'api_error' });
  assert.deepEqual(judge([init, finished({ result: 'refusal', error_details: 'dlp_request_denied' })]), { kind: 'failed', reason: 'api_error' });
  // 출력이 있으면 앞선 거절 흔적으로 뒤집지 않는다. 앞 메시지의 거절도 마지막 stop_reason이 아니면 보지 않는다.
  const output = { status: 'completed', summary: 's', question: '' };
  assert.deepEqual(judge([init, finished({ is_error: false, stop_reason: 'refusal', structured_output: output })]), { kind: 'output', value: output });
  assert.deepEqual(judge([init, live({ message: { model: '<synthetic>', stop_reason: 'refusal', content: [] } }), live({ message: { model: '<synthetic>', stop_reason: 'end_turn', content: [] } }), finished({ is_error: false, structured_output: null })]), { kind: 'failed', reason: 'no_structured_output' });
  assert.deepEqual(judge([init, finished({ is_error: false, stop_reason: 'refusal' })], { code: 1, signal: null }), { kind: 'failed', reason: 'exit_nonzero' });
  // 대화·리뷰도 같은 해석을 쓴다.
  const chatInit = { type: 'system', subtype: 'init', tools: ['StructuredOutput'], mcp_servers: [], model: MODEL, apiKeySource: 'none', claude_code_version: '2.1.308' };
  assert.deepEqual(interpretClaudeStream([chatInit, { type: 'result', subtype: 'success', is_error: true, stop_reason: 'refusal' }].map(event => JSON.stringify(event)), OK_EXIT, EXPECT), refusal);
});

test('판정: model_refusal은 계약 사유표 안의 값으로 나간다', async () => {
  const base = { version: 1 as const, job: randomUUID(), lease: randomUUID(), generation: 1, sessionId: randomUUID(), turn: 1, worker: WORKER, usage: { toolCalls: 0, model: null } };
  const response = await judgeTaskRun({ request: startRequest(), base, cancelled: false, session: {} as TaskSession, sessions: {} as TaskSessions,
    report: { exit: { code: 1, signal: null }, survivors: 0, aborted: false, outcome: { kind: 'failed', reason: 'model_refusal' } } });
  assert.equal(TaskResponseSchema.parse(response).status === 'failed' && response.status === 'failed' && response.reason, 'model_cannot_complete');
});

test('형식 밖 값: 모르는 식별자는 그대로, 그 밖은 unknown, 상태는 100~599 정수만, 없으면 null', async () => {
  const { response, logs } = await run({ lines: [INIT, apiError({ error: 'brand_new_kind', api_error: 'brand_new_api_error', api_error_status: 700, api_error_code: 'Not-An-Identifier', api_error_origin: 'third_party' }),
    errorResult({ subtype: 'brand_new_subtype', is_error: 'yes', stop_reason: 'Stop Reason', api_error: 42, api_error_status: 99.5, api_error_code: 'x'.repeat(65), api_error_origin: 7 })], exit: 1 });
  assert.equal(statusOf(response), 'execution_error');
  const [detail] = details(logs);
  assert.deepEqual({ ...detail, job: 0, generation: 0, turn: 0 }, { level: 'warn', event: 'task_turn_error_detail', job: 0, generation: 0, turn: 0, status: 'failed', reason: 'execution_error',
    cli_version: '2.1.308', init_confirmed: true, engine_reason: 'execution_error', result_subtype: 'brand_new_subtype', is_error: 'unknown', exit_code: 1, exit_signal: null, tools: 0,
    assistant_error: 'brand_new_kind', api_error: 'unknown', api_error_status: 'unknown', stop_reason: 'unknown', api_error_code: 'unknown', api_error_origin: 'unknown' });
  for (const value of ['', 'A', '1a', 'a-b', 'a b', 'a'.repeat(65), 7, {}, [], true]) assert.equal(safeIdentifier(value), 'unknown', JSON.stringify(value));
  for (const value of ['a', 'rate_limit', 'a1_b', 'a'.repeat(64)]) assert.equal(safeIdentifier(value), value);
  for (const value of [undefined, null]) assert.equal(safeIdentifier(value), null);
  const statuses: [unknown, unknown][] = [[100, 100], [599, 599], [99, 'unknown'], [600, 'unknown'], [404.5, 'unknown'], ['404', 'unknown'], [null, null]];
  for (const [input, expected] of statuses) {
    const trace: TaskTurnTrace = { errors: {}, initConfirmed: false, version: undefined, report: null };
    noteClaudeError(trace.errors, compactClaudeEvent(JSON.stringify({ type: 'result', api_error_status: input }))!);
    assert.equal(taskErrorDetail(trace).api_error_status, expected, String(input));
  }
});

test('반사: 오류 문구·본문에 넣은 가짜 비밀과 표식이 진단·전체 로그에 남지 않는다', async () => {
  const MARK = '오류본문표식-비공개';
  const dirty = `${FAKE_SECRET} ${MARK} ${TOKEN}`;
  const { response, logs } = await run({ stderr: `${dirty}\n`, exit: 1, lines: [INIT,
    apiError({ error: dirty, api_error_status: dirty, api_error: dirty, api_error_code: dirty, api_error_origin: dirty, error_details: dirty, errors: [dirty],
      message: { model: '<synthetic>', content: [{ type: 'text', text: dirty }], stop_reason: dirty } }),
    errorResult({ result: dirty, error_details: dirty, errors: [dirty], stop_reason: dirty, api_error: dirty, api_error_status: dirty, api_error_code: dirty, api_error_origin: dirty,
      request: { body: dirty }, response: { body: dirty } })] });
  assert.equal(statusOf(response), 'api_error');
  assert.equal(details(logs).length, 1);
  const text = JSON.stringify(logs);
  for (const mark of [FAKE_SECRET, MARK, TOKEN, 'error_details', 'errors', 'message', 'content']) assert.equal(text.includes(mark), false, mark);
  const [detail] = details(logs);
  for (const key of ['assistant_error', 'api_error', 'api_error_status', 'stop_reason', 'api_error_code', 'api_error_origin']) assert.equal(detail![key], 'unknown', key);
});

test('줄인 줄: 진단 필드를 형식 검사해 남기고, 다시 줄여도 같으며 문구는 줄에 남지 않는다', () => {
  const dirty = `${FAKE_SECRET} 문구`;
  const events = [apiError({ session_id: SESSION, error: 'server_error', api_error: 'no_response', api_error_code: dirty, api_error_origin: 'first_party', message: { model: '<synthetic>', stop_reason: 'refusal', content: [{ type: 'text', text: dirty }] } }),
    errorResult({ session_id: SESSION, api_error: dirty, api_error_code: 'gate_code', api_error_origin: 'first_party', stop_reason: 'refusal', result: dirty, error_details: dirty, errors: [dirty] })];
  const once = events.map(event => JSON.stringify(compactTaskEvent(JSON.stringify(event))));
  assert.deepEqual(once.map(line => JSON.stringify(compactTaskEvent(line))), once);
  assert.equal(once.join('\n').includes(FAKE_SECRET), false);
  const [assistant, result] = once.map(line => JSON.parse(line) as Record<string, unknown>);
  assert.deepEqual([assistant!.api_error, assistant!.api_error_code, assistant!.api_error_origin, assistant!.stop_reason], ['no_response', 'unknown', 'first_party', 'refusal']);
  assert.deepEqual([result!.api_error, result!.api_error_code, result!.api_error_origin, result!.stop_reason], ['unknown', 'gate_code', 'first_party', 'refusal']);
  // 없는 필드는 만들지 않는다. 대화·리뷰 줄의 모양이 늘지 않는다.
  assert.equal('stop_reason' in JSON.parse(JSON.stringify(compactClaudeEvent(JSON.stringify({ type: 'assistant', message: { model: MODEL, content: [] } })))), false);
});

test('이벤트 범위: 완료·질문은 남기지 않고, 정책 위반·실행 전 실패·예외는 남긴다', async () => {
  const good = { type: 'result', subtype: 'success', is_error: false, session_id: 'SESSION', structured_output: { status: 'completed', summary: 's', question: '' } };
  assert.equal(details((await run({ lines: [INIT, good] })).logs).length, 0);
  assert.equal(details((await run({ lines: [INIT, { ...good, structured_output: { status: 'needs_input', summary: 's', question: 'q' } }] })).logs).length, 0);

  const violated = await run({ lines: [initEvent('SESSION', { claude_code_version: '2.1.309' }), good] });
  const [mismatch] = details(violated.logs);
  assert.equal(mismatch!.reason, 'policy_violation');
  assert.equal(mismatch!.init_confirmed, false);
  assert.equal(mismatch!.cli_version, '2.1.309');

  const odd = await run({ lines: [initEvent('SESSION', { claude_code_version: `2.1.308 ${FAKE_SECRET}` }), good] });
  assert.equal(details(odd.logs)[0]!.cli_version, 'unknown');

  const noInit = await run({ lines: [good] });
  assert.deepEqual([details(noInit.logs)[0]!.reason, details(noInit.logs)[0]!.init_confirmed, details(noInit.logs)[0]!.cli_version], ['invalid_stream', false, null]);

  const logs: Record<string, unknown>[] = [];
  const request = startRequest();
  const boom = { sessions: { create: async () => { throw new Error('nope'); }, exists: async () => { throw new Error('nope'); } } as unknown as TaskSessions, control: {} as RunControl, fetchArchive: async () => GOOD, worker: WORKER, model: MODEL,
    auth: 'subscription-token' as const, credentialDir: '/run/worker-credential', log: (item: Record<string, unknown>) => { logs.push(item); } };
  await assert.rejects(runTaskTurn(boom, request, new AbortController().signal));
  assert.deepEqual(details(logs), [{ level: 'warn', event: 'task_turn_error_detail', job: request.job, generation: request.generation, turn: request.turn, status: 'unknown', reason: 'turn_threw',
    cli_version: null, init_confirmed: false, engine_reason: null, result_subtype: null, is_error: null, exit_code: null, exit_signal: null, tools: null, ...NO_API_FIELDS }]);
  assert.equal(JSON.stringify(logs).includes('nope'), false);
});
