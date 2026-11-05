import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ClaudeChatAdapter, STRUCTURED_OUTPUT_TOOL } from '../src/executor-claude.js';
import type { AdapterRun, ChatAdapter, ChatRun, ExecutorCapabilities, Observation } from '../src/executor.js';
import type { LaunchResult, LaunchSpec, ProcessLauncher } from '../src/process-launcher.js';
import { RunControl } from '../src/run-control.js';
import type { RunReport } from '../src/run-control.js';

const SECRET = 'fixture-secret-value-0123456789';
const run = (): ChatRun => ({ job: 'j', model: 'fixture-model', schema: {}, credential: { value: SECRET, secrets: [SECRET] },
  dirs: { root: '/nonexistent', home: '/nonexistent/h', config: '/nonexistent/c', workspace: '/nonexistent/w', run: '/nonexistent/r', tmp: '/nonexistent/t' } });
const assistant = (...blocks: unknown[]) => JSON.stringify({ type: 'assistant', message: { model: 'fixture-model', content: blocks } });
const use = (id: string | undefined, name = 'Bash') => ({ type: 'tool_use', id, name });

test('T18 B1 Claude 관측: 한 assistant 메시지의 도구 호출을 모두 낸다', async () => {
  const plan = await new ClaudeChatAdapter('subscription-token').start(run());
  const seen = plan.observe(assistant({ type: 'text', text: '본문' }, use('a'), use('b', 'Read'), { type: 'server_tool_use', id: 'c', name: 'web' },
    { type: 'mcp_tool_use', id: 'd', name: 'x' }, use('out', STRUCTURED_OUTPUT_TOOL)));
  assert.deepEqual(seen.tools, ['a', 'b', 'c', 'd']);
  assert.doesNotMatch(seen.line, /본문/);
  assert.deepEqual(plan.observe(assistant({ type: 'text', text: 'x' })).tools, []);
  assert.deepEqual(plan.observe(JSON.stringify({ type: 'result' })).tools, []);
  assert.deepEqual(plan.observe('not json').tools, []);
  // 출력 전달용 도구만 있으면 도구 호출이 아니다.
  assert.deepEqual(plan.observe(assistant(use('out', STRUCTURED_OUTPUT_TOOL))).tools, []);
});
test('T18 B1 Claude 관측: ID 없는 호출은 이름이 같아도 하나로 합치지 않는다', async () => {
  const plan = await new ClaudeChatAdapter('subscription-token').start(run());
  const first = plan.observe(assistant(use(undefined), use(undefined), use('')));
  assert.equal(new Set(first.tools).size, 3);
  const second = plan.observe(assistant(use(undefined)));
  assert.equal(new Set([...first.tools, ...second.tools]).size, 4);
});
test('T18 B1 Claude 관측: 줄인 줄을 다시 봐도 호출을 모두 낸다', async () => {
  const plan = await new ClaudeChatAdapter('subscription-token').start(run());
  const compact = plan.observe(assistant(use('a'), use('b'))).line;
  assert.deepEqual(plan.observe(compact).tools, ['a', 'b']);
});

class OneShotLauncher implements ProcessLauncher {
  aborted = false;
  constructor(private readonly lines: string[]) {}
  async run(_spec: LaunchSpec, signal: AbortSignal, onLine: (line: string) => void): Promise<LaunchResult> {
    for (const line of this.lines) onLine(line);
    this.aborted = signal.aborted;
    return { exit: { code: 0, signal: null } };
  }
  async terminate(): Promise<void> {}
  async survivors(): Promise<number | null> { return 0; }
}
// 공통 실행 제어가 관측값을 어떻게 세는지만 본다. 줄 하나가 곧 그 줄의 호출 ID 목록이다.
function adapter(tools: ExecutorCapabilities['tools']): ChatAdapter {
  const capabilities: ExecutorCapabilities = { executor: 'claude', cliVersion: '0', lanes: { chat: true, task: false, review: false },
    structuredOutput: 'native-schema', tools, sessionPersistence: 'off', modelPinned: true, credential: 'env-static', evidence: 'fake-cli' };
  return { capabilities, envNames: ['FIXTURE_TOKEN'], credentialEnv: 'FIXTURE_TOKEN', versionEnv: () => ({}), parseVersion: () => null,
    start: async (chat: ChatRun): Promise<AdapterRun> => ({ args: [], env: { FIXTURE_TOKEN: chat.credential.value! },
      observe: (line: string): Observation => ({ line: '{}', tools: line ? line.split(',') : [], violation: null }),
      finish: async () => ({ kind: 'output', value: {} }), cleanup: async () => {} }) };
}
async function execute(tools: ExecutorCapabilities['tools'], budget: number, lines: string[]): Promise<RunReport> {
  const base = await mkdtemp(join(tmpdir(), 'homelab-task-observation-'));
  try {
    const credential = { kind: 'env-static' as const, open: async () => 'present' as const, ready: async () => true,
      forRun: async () => ({ value: SECRET, secrets: [SECRET] }), secrets: async () => [SECRET] };
    const control = new RunControl(credential, new OneShotLauncher(lines), { tmp: base, homes: [] });
    return await control.run({ adapter: adapter(tools), lane: 'chat', job: 'j', model: 'm', prefix: 'homelab-chat-', timeoutMs: 60_000,
      toolCalls: budget, schema: {}, prompt: 'p', limits: { lineBytes: 1000, outputBytes: 1000, events: 100 } }, new AbortController().signal);
  } finally { await rm(base, { recursive: true, force: true }); }
}
test('T18 B1 예산: 한 줄에 여러 호출이 와도 모두 세어 초과하면 멈춘다', async () => {
  assert.equal((await execute('sandboxed-task', 2, ['a,b,c'])).exceeded, 'tool_budget_exceeded');
  assert.equal((await execute('sandboxed-task', 3, ['a,b,c'])).exceeded, undefined);
  assert.equal((await execute('sandboxed-task', 3, ['a,b', 'c,d'])).exceeded, 'tool_budget_exceeded');
});
test('T18 B1 예산: 같은 호출을 다시 알리는 줄은 한 번만 센다', async () => {
  assert.equal((await execute('sandboxed-task', 2, ['a,b', 'a', 'b,a'])).exceeded, undefined);
  assert.equal((await execute('sandboxed-task', 2, ['a,b', 'a', 'c'])).exceeded, 'tool_budget_exceeded');
});
test('T18 B1 예산: 무도구 실행은 호출 하나로 멈추고, 호출이 없으면 멈추지 않는다', async () => {
  assert.equal((await execute('none', 8, ['a'])).exceeded, 'tool_budget_exceeded');
  assert.equal((await execute('none', 8, ['', ''])).exceeded, undefined);
});
