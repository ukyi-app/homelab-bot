import type { AdapterRun, ChatAdapter, ChatRun, EngineOutcome, ExecutorCapabilities, ExitStatus, Observation } from './executor.js';

// Claude Code CLI 대화 어댑터(D-14 변경, 사용자 2026-10-30: Claude Code CLI, 구독 장기 토큰, 첫 모델 Opus 5.5).
// 이 파일은 argv·env 이름·출력 해석·CLI 오류 분류만 한다. 실행·정리·검증은 공통부(chat-lane)다.
// 플래그 근거 [실측: 고정 바이너리 2.1.308 `claude --help`, 모델 호출 없음]. 이벤트 모양 근거는 같은 바이너리에 든
// SDK 메시지 스키마(정적 읽기)와 공식 headless 문서다 [가정: 실제 출력 대조는 첫 승인 대화 S12].
// - `-p` + stdin 프롬프트. 프롬프트는 argv에 두지 않는다(프로세스 목록에 남지 않고, `--`로 시작해도 플래그가 아니다).
// - `--output-format stream-json --verbose`: 첫 `system/init` 이벤트로 도구·MCP·모델·자격 출처를 실행마다 확인하고,
//   assistant 메시지의 `error` 종류로 한도·인증을 가른다. 마지막 `result`의 `structured_output`만 답으로 쓴다.
// - `--tools ""`(내장 도구 전부 끔), `--strict-mcp-config --mcp-config {"mcpServers":{}}`(MCP 없음),
//   `--permission-mode dontAsk`(승인이 필요한 것은 거부), `--disable-slash-commands`, `--safe-mode`(CLAUDE.md·skills·
//   plugins·hooks·MCP·사용자 명령 등 사용자 지정 전부 끔, 인증·모델 선택은 그대로).
// - `--no-session-persistence`: 세션을 디스크에 남기지 않는다. 그래도 HOME·CLAUDE_CONFIG_DIR·TMPDIR은 실행마다 새 임시
//   디렉터리이고 공통부가 실행 뒤 통째로 지운다(플래그가 모든 파일 쓰기를 막는다는 보증은 아니다).
// - `--bare`는 쓰지 않는다: bare는 CLAUDE_CODE_OAUTH_TOKEN을 읽지 않는다 [확인: --help "OAuth and keychain are never read"].
// - `--fallback-model`을 쓰지 않는다. 한도·인증 때 다른 모델·계정·실행기로 넘어가지 않는다(D-14 조건 2).
export const CLAUDE_CLI_VERSION = '2.1.308';
export const CLAUDE_CHAT_CAPABILITIES: ExecutorCapabilities = Object.freeze({
  executor: 'claude', cliVersion: CLAUDE_CLI_VERSION, lanes: Object.freeze({ chat: true, task: false }),
  structuredOutput: 'native-schema', tools: 'none', sessionPersistence: 'off', modelPinned: true,
  credential: 'env-static', evidence: 'fake-cli',
} as const);
// 출력 전달용 내부 도구. 작업 도구가 아니라 구조화 출력 프로토콜이라 도구 예산에서 뺀다 [확인: 바이너리의 도구 이름].
export const STRUCTURED_OUTPUT_TOOL = 'StructuredOutput';
// 비밀이 아닌 고정 env. 부가 통신(텔레메트리·오류 보고·업데이트·피드백)과 claude.ai connector를 끈다.
export const CLAUDE_FIXED_ENV: Readonly<Record<string, string>> = Object.freeze({
  CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1', DISABLE_TELEMETRY: '1', DISABLE_ERROR_REPORTING: '1',
  DISABLE_FEEDBACK_COMMAND: '1', CLAUDE_CODE_DISABLE_FEEDBACK_SURVEY: '1', ENABLE_CLAUDEAI_MCP_SERVERS: 'false',
  DISABLE_UPDATES: '1',
});
// 인증 방식별 자격 변수와 init 이벤트의 apiKeySource 기대값. 지금은 구독 장기 토큰 하나만 있다(사용자 결정).
// API 키 방식을 더하려면 `ANTHROPIC_API_KEY`·apiKeySource `ANTHROPIC_API_KEY`·`--bare` 검토와 프로필 항목이 함께 필요하다.
// `-p`에서는 API 키가 OAuth 토큰보다 우선하므로 [확인: 공식 인증 문서] 한 실행에 자격 변수는 하나만 넣는다.
export const CLAUDE_AUTH = Object.freeze({
  'subscription-token': Object.freeze({ env: 'CLAUDE_CODE_OAUTH_TOKEN', apiKeySource: 'none' }),
} as const);
export type ClaudeAuth = keyof typeof CLAUDE_AUTH;
// 넘기지 않는 플래그(시험이 확인한다). 도구·권한을 넓히거나, 세션을 잇거나, 자격·설정을 다른 곳에서 읽거나, 폴백한다.
export const CLAUDE_FORBIDDEN_FLAGS: readonly string[] = Object.freeze(['--bare', '--dangerously-skip-permissions',
  '--allow-dangerously-skip-permissions', '--fallback-model', '--resume', '-r', '--continue', '-c', '--fork-session',
  '--session-id', '--add-dir', '--allowedTools', '--allowed-tools', '--plugin-dir', '--plugin-url', '--agents', '--agent',
  '--settings', '--setting-sources', '--debug', '-d', '--debug-file', '--bg', '--background', '--remote-control', '--chrome',
  '--ide', '--file', '--worktree', '-w', '--cloud', '--teleport', '--from-pr', '--betas', '--system-prompt']);

export function claudeArgs(model: string, schema: object): string[] {
  return ['-p', '--output-format', 'stream-json', '--verbose',
    '--json-schema', JSON.stringify(schema), '--model', model,
    '--tools', '', '--strict-mcp-config', '--mcp-config', '{"mcpServers":{}}',
    '--no-session-persistence', '--permission-mode', 'dontAsk', '--disable-slash-commands', '--safe-mode'];
}

// 판정에 쓰는 필드만 남긴 이벤트. 모델 본문(text·thinking), 도구 입력, 결과 텍스트(result)는 버린다.
interface Compact {
  type?: unknown; subtype?: unknown;
  tools?: unknown; mcp_servers?: unknown; model?: unknown; apiKeySource?: unknown; claude_code_version?: unknown;
  error?: unknown; api_error_status?: unknown; api_error?: unknown; tool_uses?: { id: unknown; name: unknown }[];
  is_error?: unknown; structured_output?: unknown; num_turns?: unknown;
}
const record = (value: unknown): Record<string, unknown> | null =>
  typeof value === 'object' && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : null;
export function compactClaudeEvent(line: string): Compact | null {
  let raw: unknown;
  try { raw = JSON.parse(line); } catch { return null; }
  const event = record(raw);
  if (!event) return null;
  const compact: Compact = { type: event.type, subtype: event.subtype };
  if (event.type === 'system' && event.subtype === 'init') {
    Object.assign(compact, { tools: event.tools, model: event.model, apiKeySource: event.apiKeySource,
      claude_code_version: event.claude_code_version,
      mcp_servers: Array.isArray(event.mcp_servers)
        ? event.mcp_servers.map(server => typeof server === 'string' ? server : record(server)?.name ?? null) : event.mcp_servers });
  } else if (event.type === 'assistant') {
    const content = record(event.message)?.content;
    // tool_use·server_tool_use·mcp_tool_use 등 이름이 tool_use로 끝나는 블록은 모두 도구 호출로 센다.
    // 이미 줄인 줄(tool_uses)을 다시 줄여도 같은 결과다. 판정은 원문 줄과 줄인 줄 어느 쪽에도 쓸 수 있다.
    const uses = Array.isArray(event.tool_uses) ? event.tool_uses.map(u => ({ id: record(u)?.id, name: record(u)?.name }))
      : Array.isArray(content) ? content.flatMap(block => {
        const b = record(block);
        return b && typeof b.type === 'string' && b.type.endsWith('tool_use') ? [{ id: b.id, name: b.name }] : [];
      }) : [];
    Object.assign(compact, { error: event.error, api_error_status: event.api_error_status, tool_uses: uses });
  } else if (event.type === 'result') {
    Object.assign(compact, { is_error: event.is_error, api_error_status: event.api_error_status, api_error: event.api_error,
      structured_output: event.structured_output, num_turns: event.num_turns });
  }
  return compact;
}

export interface ClaudeExpectation { model: string; apiKeySource: string; version: string }
// 실행마다 첫 init 이벤트로 확인하는 정책. 하나라도 다르면 그 실행은 정책 위반으로 멈추고 실패다.
// 도구는 출력 전달용 StructuredOutput만, MCP 서버 0개, 요청한 모델 그대로(별칭·폴백 아님), 선택한 자격 방식, 고정 버전.
export function initViolation(init: Compact, expect: ClaudeExpectation): string | null {
  if (!Array.isArray(init.tools) || init.tools.some(tool => tool !== STRUCTURED_OUTPUT_TOOL)) return 'tools_enabled';
  if (!Array.isArray(init.mcp_servers) || init.mcp_servers.length > 0) return 'mcp_enabled';
  if (init.model !== expect.model) return 'model_mismatch';
  if (init.apiKeySource !== expect.apiKeySource) return 'credential_source_mismatch';
  if (init.claude_code_version !== expect.version) return 'version_mismatch';
  return null;
}

// 한도·인증 분류. 근거는 CLI가 낸 구조화 필드뿐이다(assistant `error` 종류, HTTP 상태). 모델 답이나 결과 텍스트에
// "401"·"rate limit"이 있어도 보지 않는다. 종류 이름은 2.1.308 바이너리의 SDK 스키마 enum이다 [가정: 실제 값 S12].
const AUTH_KINDS = new Set(['authentication_failed', 'oauth_org_not_allowed', 'account_on_hold', 'verification_required']);
// billing_error는 사람이 결제·한도를 확인해야 한다. 자동 재시도하지 않게 한도 대기로 둔다.
const LIMIT_KINDS = new Set(['rate_limit', 'billing_error']);
export function classifyClaudeError(kind: unknown, status: unknown): EngineOutcome | null {
  if (typeof kind === 'string' && AUTH_KINDS.has(kind)) return { kind: 'auth_expired' };
  if (typeof kind === 'string' && LIMIT_KINDS.has(kind)) return { kind: 'limited' };
  // overloaded·server_error 등 다른 종류는 대기가 아니다. 종류를 모를 때만 HTTP 상태를 본다.
  if (typeof kind === 'string' && kind !== 'unknown') return null;
  if (status === 401 || status === 403) return { kind: 'auth_expired' };
  if (status === 429 || status === 402) return { kind: 'limited' };
  return null;
}

const failed = (reason: string): EngineOutcome => ({ kind: 'failed', reason });
// stream-json 해석. 순서: 흐름 무결성(init 하나, result 최대 하나) → init 정책 → 오류 결과(한도·인증 대기 또는 실패)
// → 종료 코드 → structured_output. `subtype: success`만으로 성공을 확정하지 않는다(is_error=false와 구조화 출력이 있어야 한다).
export function interpretClaudeStream(lines: readonly string[], exit: ExitStatus, expect: ClaudeExpectation): EngineOutcome {
  const events: Compact[] = [];
  for (const line of lines) {
    if (!line.trim()) continue;
    const parsed = compactClaudeEvent(line);
    if (!parsed) return failed('invalid_stream');
    events.push(parsed);
  }
  const inits = events.filter(e => e.type === 'system' && e.subtype === 'init');
  if (inits.length !== 1) return failed('invalid_stream');
  if (initViolation(inits[0]!, expect)) return failed('policy_violation');
  const results = events.filter(e => e.type === 'result');
  if (results.length > 1) return failed('invalid_stream');
  const apiErrors = events.filter(e => e.type === 'assistant' && e.error !== undefined);
  const lastError = apiErrors.at(-1);
  const result = results[0];
  if (!result) return classifyClaudeError(lastError?.error, lastError?.api_error_status) ?? failed('no_result');
  if (result.is_error !== false || result.subtype !== 'success') {
    return classifyClaudeError(lastError?.error, result.api_error_status ?? lastError?.api_error_status)
      ?? failed(result.subtype === 'success' ? 'api_error' : 'execution_error');
  }
  if (exit.code !== 0) return failed('exit_nonzero');
  if (result.structured_output === undefined || result.structured_output === null) return failed('no_structured_output');
  return { kind: 'output', value: result.structured_output };
}

export class ClaudeChatAdapter implements ChatAdapter {
  readonly capabilities = CLAUDE_CHAT_CAPABILITIES;
  readonly envNames: readonly string[];
  readonly credentialEnv: string;
  private readonly apiKeySource: string;
  constructor(auth: ClaudeAuth) {
    this.credentialEnv = CLAUDE_AUTH[auth].env;
    this.apiKeySource = CLAUDE_AUTH[auth].apiKeySource;
    this.envNames = Object.freeze(['CLAUDE_CONFIG_DIR', this.credentialEnv, ...Object.keys(CLAUDE_FIXED_ENV)]);
  }
  // `--version`은 빈 임시 디렉터리를 HOME·CLAUDE_CONFIG_DIR로 준다. 자격은 넘기지 않는다.
  versionEnv(scratch: string): Record<string, string> { return { CLAUDE_CONFIG_DIR: scratch, ...CLAUDE_FIXED_ENV }; }
  parseVersion(stdout: string): string | null { return /^(\d+\.\d+\.\d+) \(Claude Code\)\s*$/m.exec(stdout)?.[1] ?? null; }
  async start(run: ChatRun): Promise<AdapterRun> {
    if (run.credential.value === undefined) throw new Error('credential_missing');
    const expect: ClaudeExpectation = { model: run.model, apiKeySource: this.apiKeySource, version: this.capabilities.cliVersion };
    let initChecked = false;
    return {
      args: claudeArgs(run.model, run.schema),
      // 자격은 이 실행의 자식 env 한 변수에만 둔다. 설정 파일·argv에는 넣지 않는다(공통부가 실행 전에 확인한다).
      env: { CLAUDE_CONFIG_DIR: run.dirs.config, ...CLAUDE_FIXED_ENV, [this.credentialEnv]: run.credential.value },
      observe(line: string): Observation {
        const compact = compactClaudeEvent(line);
        if (!compact) return { line: '<malformed>', tool: null, violation: null };
        let violation: string | null = null;
        if (compact.type === 'system' && compact.subtype === 'init' && !initChecked) {
          initChecked = true;
          violation = initViolation(compact, expect);
        }
        const use = compact.tool_uses?.find(u => u.name !== STRUCTURED_OUTPUT_TOOL);
        const tool = use ? (typeof use.id === 'string' && use.id ? use.id : `unnamed-${String(use.name)}`) : null;
        return { line: JSON.stringify(compact), tool, violation };
      },
      finish: async (lines, exit) => interpretClaudeStream(lines, exit, expect),
      // 실행 잔여물(HOME·CLAUDE_CONFIG_DIR·TMPDIR)은 모두 실행 디렉터리 안이라 공통부가 통째로 지운다.
      cleanup: async () => {},
    };
  }
}
