import { RateLimitEventSchema } from './contracts.js';
import type { LimitCause, RateLimitEvent, RateLimitInfo } from './contracts.js';
import type { AdapterRun, ChatAdapter, ChatRun, EngineOutcome, ExecutorCapabilities, ExitStatus, Observation, PolicyViolation } from './executor.js';

// Claude Code CLI 대화 어댑터(D-14, 사용자 결정: Claude Code CLI, 구독 장기 토큰, 첫 모델 Opus 5.5).
// 이 파일은 argv·env 이름·출력 해석·CLI 오류 분류만 한다. 실행·정리는 공통부(run-control), 결과 검증은 레인(chat-lane·review-lane)이다.
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
// - Opus 5.5의 내용 기반 자동 모델 전환(refusal fallback)은 `--fallback-model`과 별개로 기본 켜져 있다. env로 끄고,
//   그래도 전환 이벤트나 다른 모델의 응답이 보이면 정책 위반으로 즉시 멈춘다. 모델 고정은 사용자 결정이다.
export const CLAUDE_CLI_VERSION = '2.1.308';
export const CLAUDE_CHAT_CAPABILITIES: ExecutorCapabilities = Object.freeze({
  executor: 'claude', cliVersion: CLAUDE_CLI_VERSION, lanes: Object.freeze({ chat: true, task: false, review: true }),
  structuredOutput: 'native-schema', tools: 'none', sessionPersistence: 'off', modelPinned: true,
  credential: 'env-static', evidence: 'fake-cli',
} as const);
// 출력 전달용 내부 도구. 작업 도구가 아니라 구조화 출력 프로토콜이라 도구 예산에서 뺀다 [확인: 바이너리의 도구 이름].
export const STRUCTURED_OUTPUT_TOOL = 'StructuredOutput';
// 비밀이 아닌 고정 env. 부가 통신(텔레메트리·오류 보고·업데이트·피드백)과 claude.ai connector, 자동 모델 전환을 끈다.
// CLAUDE_CODE_DISABLE_REFUSAL_FALLBACK [확인: 공식 env 문서, 2.1.308 바이너리의 전환 조건이 이 값을 본다].
export const CLAUDE_FIXED_ENV: Readonly<Record<string, string>> = Object.freeze({
  CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1', DISABLE_TELEMETRY: '1', DISABLE_ERROR_REPORTING: '1',
  DISABLE_FEEDBACK_COMMAND: '1', CLAUDE_CODE_DISABLE_FEEDBACK_SURVEY: '1', ENABLE_CLAUDEAI_MCP_SERVERS: 'false',
  DISABLE_UPDATES: '1', CLAUDE_CODE_DISABLE_REFUSAL_FALLBACK: '1',
});
// API 오류를 알리려고 CLI가 만드는 assistant 메시지의 모델 표식. 모델이 쓴 답이 아니다 [확인: 2.1.308 바이너리].
export const SYNTHETIC_MODEL = '<synthetic>';
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
export interface Compact {
  type?: unknown; subtype?: unknown;
  tools?: unknown; mcp_servers?: unknown; model?: unknown; apiKeySource?: unknown; claude_code_version?: unknown;
  error?: unknown; api_error_status?: unknown; api_error?: unknown; api_error_code?: unknown; api_error_origin?: unknown;
  stop_reason?: unknown; tool_uses?: { id: unknown; name: unknown }[];
  is_error?: unknown; structured_output?: unknown; num_turns?: unknown;
  original_model?: unknown; fallback_model?: unknown;
  rate_limit_info?: RateLimitEvent;
}
const record = (value: unknown): Record<string, unknown> | null =>
  typeof value === 'object' && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : null;
// 진단에 남겨도 되는 문자열 모양. CLI enum과 서버 error_code가 쓰는 식별자 형식이다 [확인: 2.1.308 바이너리의 api_error_code 설명].
// 모양이 어긋나면 값을 버리고 unknown으로 둔다. 오류 문구가 이 필드로 들어와도 줄과 로그에 남지 않는다.
const IDENTIFIER = /^[a-z][a-z0-9_]{0,63}$/;
export const safeIdentifier = (value: unknown): string | null => value === undefined || value === null ? null
  : typeof value === 'string' && IDENTIFIER.test(value) ? value : 'unknown';
const keptIdentifier = (value: unknown) => value === undefined ? undefined : safeIdentifier(value);
// rate_limit_event에서 상태·풀리는 시각·종류·사용률 네 칸만 모양을 검사해 남긴다. 상태를 모르면 이벤트가 없는 것으로 보고,
// 다른 칸은 깨진 것만 버린다(종류가 늘어도 시각은 남는다). 원문의 나머지 칸(overage·창별 값 등)은 줄과 응답에 남기지 않는다.
// 이미 줄인 값을 다시 줄여도 같다.
const RATE_LIMIT_FIELDS = RateLimitEventSchema.shape;
function rateLimitEventOf(value: unknown): RateLimitEvent | null {
  const info = record(value);
  const status = RATE_LIMIT_FIELDS.status.safeParse(info?.status);
  if (!info || !status.success) return null;
  const kept: RateLimitEvent = { status: status.data };
  for (const key of ['resetsAt', 'rateLimitType', 'utilization'] as const) {
    const field = RATE_LIMIT_FIELDS[key].safeParse(info[key]);
    if (field.success && field.data !== undefined) Object.assign(kept, { [key]: field.data });
  }
  return kept;
}
const errorKinds = (event: Record<string, unknown>) => ({ api_error: keptIdentifier(event.api_error),
  api_error_code: keptIdentifier(event.api_error_code), api_error_origin: keptIdentifier(event.api_error_origin) });
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
    // 응답한 모델(API 응답의 message.model). 줄인 줄에는 model로 남는다.
    const model = record(event.message)?.model ?? event.model;
    Object.assign(compact, { model, error: event.error, api_error_status: event.api_error_status, ...errorKinds(event),
      stop_reason: keptIdentifier(record(event.message)?.stop_reason ?? event.stop_reason), tool_uses: uses });
  } else if (event.type === 'rate_limit_event') {
    const info = rateLimitEventOf(event.rate_limit_info);
    if (info) compact.rate_limit_info = info;
  } else if (event.type === 'system' && event.subtype === 'model_refusal_fallback') {
    Object.assign(compact, { original_model: event.original_model, fallback_model: event.fallback_model });
  } else if (event.type === 'result') {
    Object.assign(compact, { is_error: event.is_error, api_error_status: event.api_error_status, ...errorKinds(event),
      stop_reason: keptIdentifier(event.stop_reason), structured_output: event.structured_output, num_turns: event.num_turns });
  }
  return compact;
}

export interface ClaudeExpectation { model: string; apiKeySource: string; version: string }
// 실행마다 첫 init 이벤트로 확인하는 정책. 하나라도 다르면 그 실행은 정책 위반으로 멈추고 실패다.
// 도구는 출력 전달용 StructuredOutput만, MCP 서버 0개, 요청한 모델 그대로(별칭·폴백 아님), 선택한 자격 방식, 고정 버전.
export function initViolation(init: Compact, expect: ClaudeExpectation): PolicyViolation | null {
  if (!Array.isArray(init.tools) || init.tools.some(tool => tool !== STRUCTURED_OUTPUT_TOOL)) return 'tools_enabled';
  if (!Array.isArray(init.mcp_servers) || init.mcp_servers.length > 0) return 'mcp_enabled';
  if (init.model !== expect.model) return 'model_mismatch';
  if (init.apiKeySource !== expect.apiKeySource) return 'credential_source_mismatch';
  if (init.claude_code_version !== expect.version) return 'version_mismatch';
  return null;
}

// init 뒤 이벤트의 모델 정책. 자동 모델 전환 이벤트는 그 자체로 위반이다(env로 껐는데 왔다). assistant 메시지는
// 요청한 모델(날짜가 붙은 같은 ID 포함)이나 CLI 합성 오류 메시지여야 한다. 모델이 없거나 다르면 위반이다.
export function modelViolation(event: Compact, expect: ClaudeExpectation): PolicyViolation | null {
  if (event.type === 'system' && event.subtype === 'model_refusal_fallback') return 'model_fallback';
  if (event.type !== 'assistant') return null;
  const model = event.model;
  if (model === SYNTHETIC_MODEL || model === expect.model) return null;
  return typeof model === 'string' && model.startsWith(`${expect.model}-`) && /^\d{8}$/.test(model.slice(expect.model.length + 1))
    ? null : 'model_mismatch';
}

// 한도·인증 분류. 근거는 CLI가 낸 구조화 필드뿐이다(assistant `error` 종류, HTTP 상태). 모델 답이나 결과 텍스트에
// "401"·"rate limit"이 있어도 보지 않는다. 종류 이름은 2.1.308 바이너리의 SDK 스키마 enum이다 [가정: 실제 값 S12].
const AUTH_KINDS = new Set(['authentication_failed', 'oauth_org_not_allowed', 'account_on_hold', 'verification_required']);
// billing_error는 사람이 결제·한도를 확인해야 한다. 자동 재시도하지 않게 한도 대기로 두고, 원인을 billing으로 갈라
// 게시 서버가 저절로 재개하지 않게 한다. 402는 Messages API의 billing_error 상태다.
const LIMIT_KINDS = new Map<string, LimitCause>([['rate_limit', 'rate_limit'], ['billing_error', 'billing']]);
const LIMIT_STATUSES = new Map<unknown, LimitCause>([[429, 'rate_limit'], [402, 'billing']]);
const limited = (cause: LimitCause): EngineOutcome => ({ kind: 'limited', rateLimit: { stop: { cause } } });
export function classifyClaudeError(kind: unknown, status: unknown): EngineOutcome | null {
  if (typeof kind === 'string' && AUTH_KINDS.has(kind)) return { kind: 'auth_expired' };
  const byKind = typeof kind === 'string' ? LIMIT_KINDS.get(kind) : undefined;
  if (byKind) return limited(byKind);
  // overloaded·server_error 등 다른 종류는 대기가 아니다. 종류를 모를 때만 HTTP 상태를 본다.
  if (typeof kind === 'string' && kind !== 'unknown') return null;
  if (status === 401 || status === 403) return { kind: 'auth_expired' };
  const byStatus = LIMIT_STATUSES.get(status);
  return byStatus ? limited(byStatus) : null;
}

// 오류 판정과 진단이 함께 보는 이벤트. 값은 result에 있으면 그것을, 없으면 마지막 assistant의 것을 쓴다.
// error는 종류가 정해진 오류에만 온다. 세부 필드는 그것 없이 올 수 있어 따로 기억한다 [확인: 2.1.308 바이너리의 SDK 스키마].
export interface ClaudeErrorSeen { assistantError?: Compact; assistantDetail?: Compact; assistantStop?: Compact; result?: Compact }
export function noteClaudeError(seen: ClaudeErrorSeen, event: Compact): void {
  if (event.type === 'result') seen.result = event;
  if (event.type !== 'assistant') return;
  if (event.error !== undefined) seen.assistantError = event;
  if ([event.api_error, event.api_error_status, event.api_error_code, event.api_error_origin].some(value => value !== undefined && value !== null)) seen.assistantDetail = event;
  if (event.stop_reason !== undefined && event.stop_reason !== null) seen.assistantStop = event;
}
export const seenStopReason = (seen: ClaudeErrorSeen) => seen.result?.stop_reason ?? seen.assistantStop?.stop_reason;
export const seenApiError = (seen: ClaudeErrorSeen) => seen.result?.api_error ?? seen.assistantDetail?.api_error;
// 거절은 일시 오류와 달리 같은 요청을 되풀이해도 소용없어 api_error와 가른다. stop_reason은 Messages API의 거절이고,
// api_error의 두 값은 조직 DLP와 안전 모니터 차단이다 [확인: 2.1.308 바이너리의 SDK 스키마]. 인증·한도의 HTTP 상태 추정보다 앞선다.
export const MODEL_REFUSAL = 'model_refusal';
const REFUSAL_API_ERRORS = new Set<unknown>(['dlp_request_denied', 'safety_monitor_blocked']);
const refused = (seen: ClaudeErrorSeen) => seenStopReason(seen) === 'refusal' || REFUSAL_API_ERRORS.has(seenApiError(seen));

// 흐름 해석에서 레인마다 다른 부분. 대화·리뷰는 무도구 정책이고, 작업 레인은 자기 정책을 넘긴다(executor-claude-task).
export interface ClaudeStreamPolicy {
  compact(line: string): Compact | null;
  init(init: Compact, expect: ClaudeExpectation): PolicyViolation | null;
  event(event: Compact, expect: ClaudeExpectation): PolicyViolation | null;
}
const NO_TOOL_STREAM: ClaudeStreamPolicy = { compact: compactClaudeEvent, init: initViolation, event: modelViolation };

const failed = (reason: string): EngineOutcome => ({ kind: 'failed', reason });
// stream-json 해석. 순서: 흐름 무결성(init 하나, result 최대 하나) → init 정책 → 오류 결과(한도·인증 대기 또는 실패)
// → 종료 코드 → structured_output. `subtype: success`만으로 성공을 확정하지 않는다(is_error=false와 구조화 출력이 있어야 한다).
// 어떤 결과든 그 실행에서 본 한도 정보를 함께 싣는다.
export function interpretClaudeStream(lines: readonly string[], exit: ExitStatus, expect: ClaudeExpectation,
  policy: ClaudeStreamPolicy = NO_TOOL_STREAM): EngineOutcome {
  const events: Compact[] = [];
  let broken = false;
  for (const line of lines) {
    if (!line.trim()) continue;
    const parsed = policy.compact(line);
    if (!parsed) { broken = true; break; }
    events.push(parsed);
  }
  return withRateLimit(broken ? failed('invalid_stream') : judgeClaudeStream(events, exit, expect, policy), events);
}
// event는 마지막 rate_limit_event다. 한도 대기면 원인에 같은 실행의 마지막 rejected가 알린 풀리는 시각을 붙인다.
// 경고(allowed_warning)의 시각은 멈춤의 시각이 아니라 붙이지 않는다. 시각을 모르면 게시 서버가 30분 재시도로 내려앉는다.
function withRateLimit(outcome: EngineOutcome, events: readonly Compact[]): EngineOutcome {
  const seen = events.flatMap(e => e.type === 'rate_limit_event' && e.rate_limit_info ? [e.rate_limit_info] : []);
  const event = seen.at(-1);
  const cause = outcome.kind === 'limited' ? outcome.rateLimit?.stop?.cause : undefined;
  const resetsAt = seen.filter(e => e.status === 'rejected').at(-1)?.resetsAt;
  const info: RateLimitInfo = { ...(event ? { event } : {}),
    ...(cause ? { stop: { cause, ...(resetsAt !== undefined ? { resetsAt } : {}) } } : {}) };
  return info.event || info.stop ? { ...outcome, rateLimit: info } : outcome;
}
function judgeClaudeStream(events: readonly Compact[], exit: ExitStatus, expect: ClaudeExpectation, policy: ClaudeStreamPolicy): EngineOutcome {
  const inits = events.filter(e => e.type === 'system' && e.subtype === 'init');
  if (inits.length !== 1) return failed('invalid_stream');
  // 실행 중 관측(observe)을 지나친 위반의 마지막 보루. 종류를 실어 보내 공통부가 로그로 남긴다. 판정 순서는 init → 모델이다.
  const violation = policy.init(inits[0]!, expect) ?? events.map(event => policy.event(event, expect)).find(kind => kind !== null);
  if (violation) return { kind: 'failed', reason: 'policy_violation', violation };
  const results = events.filter(e => e.type === 'result');
  if (results.length > 1) return failed('invalid_stream');
  const seen: ClaudeErrorSeen = {};
  for (const event of events) noteClaudeError(seen, event);
  const lastError = seen.assistantError;
  const result = results[0];
  if (!result) return classifyClaudeError(lastError?.error, lastError?.api_error_status) ?? failed('no_result');
  if (result.is_error !== false || result.subtype !== 'success') {
    if (refused(seen)) return failed(MODEL_REFUSAL);
    return classifyClaudeError(lastError?.error, result.api_error_status ?? lastError?.api_error_status)
      ?? failed(result.subtype === 'success' ? 'api_error' : 'execution_error');
  }
  if (exit.code !== 0) return failed('exit_nonzero');
  if (result.structured_output === undefined || result.structured_output === null) return failed(refused(seen) ? MODEL_REFUSAL : 'no_structured_output');
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
    // ID가 없는 호출은 서로 합치지 않는다. 같은 호출을 두 번 세어도 예산 쪽으로 틀리지만, 합치면 초과를 놓친다.
    let unnamed = 0;
    return {
      args: claudeArgs(run.model, run.schema),
      // 자격은 이 실행의 자식 env 한 변수에만 둔다. 설정 파일·argv에는 넣지 않는다(공통부가 실행 전에 확인한다).
      env: { CLAUDE_CONFIG_DIR: run.dirs.config, ...CLAUDE_FIXED_ENV, [this.credentialEnv]: run.credential.value },
      observe(line: string): Observation {
        const compact = compactClaudeEvent(line);
        if (!compact) return { line: '<malformed>', tools: [], violation: null };
        let violation: PolicyViolation | null = null;
        if (compact.type === 'system' && compact.subtype === 'init' && !initChecked) {
          initChecked = true;
          violation = initViolation(compact, expect);
        }
        violation ??= modelViolation(compact, expect);
        const tools = (compact.tool_uses ?? []).filter(use => use.name !== STRUCTURED_OUTPUT_TOOL)
          .map(use => typeof use.id === 'string' && use.id ? use.id : `unnamed-${++unnamed}`);
        return { line: JSON.stringify(compact), tools, violation };
      },
      finish: async (lines, exit) => interpretClaudeStream(lines, exit, expect),
      // 실행 잔여물(HOME·CLAUDE_CONFIG_DIR·TMPDIR)은 모두 실행 디렉터리 안이라 공통부가 통째로 지운다.
      cleanup: async () => {},
    };
  }
}

// 리뷰 레인 무도구 경계(사용자 결정, DECISIONS "T18 결정"의 T17 진입 조건). argv·env·출력 해석은 대화와 같고, 대화보다 더 본다:
// init의 skills·plugins가 비어 있어야 하고, hook 실행과 도구가 돌 때만 나오는 이벤트가 보이면 멈춘다. 이벤트 이름과 init 필드는
// 2.1.308 바이너리의 SDK 스키마를 정적으로 읽은 것이다 [가정: 실제 출력 대조는 S7]. init의 agents·slash_commands는 CLI 내장 목록이
// 올 수 있고 도구가 없으면 쓸 길이 없어 보지 않는다. 판정은 원문 줄로 한다(줄인 줄에는 이 필드들이 없다).
const TOOL_ACTIVITY_TYPES = new Set(['tool_progress', 'tool_use_summary']);
export function noToolBoundaryViolation(line: string): PolicyViolation | null {
  let raw: unknown;
  try { raw = JSON.parse(line); } catch { return null; }
  const event = record(raw);
  if (!event) return null;
  if (typeof event.type === 'string' && TOOL_ACTIVITY_TYPES.has(event.type)) return 'tool_activity';
  if (event.type !== 'system' || typeof event.subtype !== 'string') return null;
  if (event.subtype.startsWith('hook_')) return 'hooks_enabled';
  if (event.subtype.startsWith('task_') || event.subtype === 'permission_denied') return 'tool_activity';
  if (event.subtype !== 'init') return null;
  if (!Array.isArray(event.skills) || event.skills.length > 0) return 'skills_enabled';
  if (!Array.isArray(event.plugins) || event.plugins.length > 0) return 'plugins_enabled';
  return null;
}
// `--safe-mode`도 CLI 내장 플러그인은 켠 채 둔다(2.1.308 --help: "built-in tools and plugins … work normally").
// init plugins에 이 두 이름이 있으면 plugins_enabled로 막힌다 [실측: 작업자 파드, 가짜 토큰 init].
// 그래서 이 둘만 끄는 고정 인라인 JSON을 `--settings`로 넘긴다(같은 실측에서 init plugins가 []). 파일·다른 출처를 읽는
// `--settings`는 금지다(CLAUDE_FORBIDDEN_FLAGS, 시험이 값까지 확인). 새 CLI가 다른 내장 플러그인을 더하면 위 init
// 검사가 그대로 막는다(fail-closed).
export const REVIEW_DISABLED_BUILTIN_PLUGINS: readonly string[] = Object.freeze(['cc-plugin-agents-md@builtin', 'cc-plugin-plugin-authoring@builtin']);
export const REVIEW_SETTINGS = JSON.stringify({ enabledPlugins: Object.fromEntries(REVIEW_DISABLED_BUILTIN_PLUGINS.map(name => [name, false])) });
export class ClaudeReviewAdapter extends ClaudeChatAdapter {
  override async start(run: ChatRun): Promise<AdapterRun> {
    const plan = await super.start(run);
    return { ...plan,
      // 없으면 hook 이벤트가 흐름에 나오지 않아 위 검사가 볼 수 없다 [확인: 2.1.308 --help].
      args: [...plan.args, '--include-hook-events', '--settings', REVIEW_SETTINGS],
      observe(line: string): Observation {
        const seen = plan.observe(line);
        return seen.violation ? seen : { ...seen, violation: noToolBoundaryViolation(line) };
      } };
  }
}
