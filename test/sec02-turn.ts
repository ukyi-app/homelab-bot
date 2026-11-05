import { spawn } from 'node:child_process';
import { closeSync, constants, openSync } from 'node:fs';
import { lstat } from 'node:fs/promises';
import { join } from 'node:path';
import { TASK_OUTPUT_JSON_SCHEMA } from '../src/codex-events.js';
import { ClaudeTaskAdapter } from '../src/executor-claude-task.js';
import type { ClaudeTaskOperation, ClaudeTaskTurn } from '../src/executor-claude-task.js';
import { assertLaunchSafe, baseEnvironment } from '../src/run-control.js';
import type { RunDirs } from '../src/executor.js';
import { TOOL_CALL_BUDGET } from './sec02-fake-api.js';
import type { ApiStats, FakeMessagesApi, RefusingProxy, ToolOutcome, TurnScript } from './sec02-fake-api.js';
import { SYNTHETIC_MODEL_ID, fallbackSocketDir } from './sec02-fixture.js';
import type { ProbeContext, Row, Sec02Layout, Sec02Step } from './sec02-fixture.js';

// 고정 CLI 한 턴. 합성 환경 하네스(sec02-harness)와 운영 파드 실행기(sec02-pod)가 함께 쓴다.
// 이 파일은 운영 파드에 들어간다. 설정을 푸는 코드는 여기 두지 않는다. 푸는 일은 하네스가 adjust로만 하고 운영 실행기는 adjust를 넘기지 않는다.
export const SEC02_LIMITS = Object.freeze({ totalMs: 300_000, turnMs: 90_000, bashMs: 5_000, retries: 0, toolCalls: TOOL_CALL_BUDGET, apiRequestBytes: 8 * 1024 * 1024, reportBytes: 64 * 1024, killGraceMs: 5_000 });

export type Variant = 'enforced' | 'enforced_scope' | 'enforced_names' | 'long_tmpdir' | 'unlisted_tools' | 'unguarded' | 'no_permission_deny' | 'no_sandbox_filesystem' | 'no_deny_rules' | 'no_block_outside' | 'no_scrub' | 'legacy_unscoped' | 'legacy_scope';
export interface TurnReport {
  variant: Variant; phase: ClaudeTaskOperation; status: 'finished' | 'timeout' | 'launch_failed' | 'not_run';
  exit_code: number | null; signal: string | null; outcome_kind: string | null; outcome_reason: string | null;
  init_seen: boolean; session_matched: boolean; policy_violations: number;
  tool_calls: number; planned_tool_calls: number; api_requests: number; aux_requests: number; rejected_requests: number; auth_mismatch: number; api_key_headers: number;
  api_violations: ApiStats['violations']; proxy_refused: number; proxy_non_loopback: number; duration_ms: number; rows: Row[]; counts: Record<string, number>;
}

const groupAlive = (pgid: number) => { try { process.kill(-pgid, 0); return true; } catch { return false; } };
async function waitGone(pgid: number, ms: number): Promise<boolean> {
  const end = Date.now() + ms;
  while (groupAlive(pgid) && Date.now() < end) await new Promise(ready => setTimeout(ready, 50));
  return !groupAlive(pgid);
}
const signalGroup = (pgid: number, signal: NodeJS.Signals) => { try { process.kill(-pgid, signal); } catch { /* 이미 끝났다. */ } };
export const notRunRows = (steps: readonly Sec02Step[]): Row[] => steps.map(step => ({ case_id: step.name, tool: step.tool, attempted: false, outcome: 'not_run', error_code: null, bytes: null }));

// 자기가 띄운 프로세스 그룹만 안다. 파드 전체를 향하는 신호(kill(-1), sweep 부류)는 상주 작업자를 죽이므로 쓰지 않는다.
export class ProcessTracker {
  private readonly groups = new Set<number>();
  private sentinel: ReturnType<typeof spawn> | null = null;
  add(pgid: number): void { this.groups.add(pgid); }
  // 다른 작업 환경을 흉내 내는 프로세스. /proc 검사의 대상이다. 합성 값만 env에 있다.
  startSentinel(layout: Sec02Layout): number {
    if (this.sentinel?.pid) return this.sentinel.pid;
    const child = spawn('/bin/sleep', ['600'], { stdio: 'ignore', detached: true,
      env: { PATH: '/usr/bin:/bin', CLAUDE_CODE_OAUTH_TOKEN: layout.token, SEC02_OTHER_TASK: layout.otherTaskEnv } });
    child.on('error', () => {});
    if (!child.pid) throw new Error('sentinel_failed');
    this.sentinel = child;
    this.groups.add(child.pid);
    return child.pid;
  }
  async stopSentinel(): Promise<void> {
    const pid = this.sentinel?.pid;
    if (!pid) return;
    signalGroup(pid, 'SIGKILL');
    if (await waitGone(pid, SEC02_LIMITS.killGraceMs)) this.groups.delete(pid);
    this.sentinel = null;
  }
  // 위반·중단 때 도는 턴만 멈춘다. sentinel은 턴과 무관하게 stopSentinel이 끝낸다.
  stopTurns(): void { for (const pgid of this.groups) if (pgid !== this.sentinel?.pid) signalGroup(pgid, 'SIGTERM'); }
  killAll(): void { for (const pgid of this.groups) signalGroup(pgid, 'SIGKILL'); }
  // 신호를 보낸 뒤 그룹이 실제로 사라졌는지 본다. 남은 수를 돌려준다.
  async settle(ms: number): Promise<number> {
    const end = Date.now() + ms;
    for (;;) {
      for (const pgid of [...this.groups]) if (!groupAlive(pgid)) this.groups.delete(pgid);
      if (!this.groups.size || Date.now() >= end) return this.groups.size;
      await new Promise(ready => setTimeout(ready, 50));
    }
  }
  alive(): number { return [...this.groups].filter(groupAlive).length; }
}

export interface TurnInput {
  variant: Variant; operation: ClaudeTaskOperation; dirs: RunDirs; sandbox: ClaudeTaskTurn['sandbox']; deadline: number;
  layout: Sec02Layout; api: FakeMessagesApi; proxy: RefusingProxy; ports: { api: number; proxy: number }; steps: readonly Sec02Step[]; cli: string; tracker: ProcessTracker;
  // 합성 환경 대조군 전용. 운영 파드 실행기는 넘기지 않는다.
  adjust?: (args: string[], env: Record<string, string>) => void;
  // 합성 환경 전용. 이 디렉터리 핸들을 CLI의 fd 9로 물려준다. 운영 실행에는 없는 조건이고 운영 파드 실행기는 넘기지 않는다.
  inheritDirFd?: string;
  // 소켓 자리가 TMPDIR 밖으로 옮겨 간 변형인지.
  fallbackSocket?: boolean;
  afterStep?: () => Promise<void>;
}

export async function runTurn(input: TurnInput): Promise<TurnReport> {
  const { variant, operation, dirs, sandbox, layout, api, proxy, ports, steps, tracker } = input;
  const started = Date.now();
  const rows: Row[] = [];
  const counts: Record<string, number> = {};
  const before = { ...api.stats };
  const proxyBefore = { ...proxy.stats };
  let cursor = 0;
  let current: Sec02Step | null = null;
  let socketPathMatches = false;
  const socketFile = (pid: number) => join(input.fallbackSocket ? fallbackSocketDir() : join(dirs.tmp, 'cc-socks'), `${pid}.sock`);
  const context: ProbeContext = { cliPid: 0, sentinelPid: tracker.startSentinel(layout), apiPort: ports.api };
  const script: TurnScript = {
    structured: { status: 'completed', summary: 'sec02', question: '' },
    next: () => {
      current = steps[cursor++] ?? null;
      return current ? current.build(context) : null;
    },
    onResult: async (outcome: ToolOutcome) => {
      if (!current) return;
      const judged = await current.judge(outcome);
      rows.push(...judged.rows);
      Object.assign(counts, judged.counts);
      // 샌드박스 안 소켓 사례의 결과가 소켓 부재 때문이 아님을 바깥에서 확인한다. init이 알린 경로와 같은 자리다 [실측].
      if (current.name === 'probe.cred_control' || current.name === 'probe.fallback') {
        const socket = await lstat(socketFile(context.cliPid)).catch(() => null);
        counts['socket.own_exists_outside'] = socket?.isSocket() ? 1 : 0;
        counts['socket.init_path_matches'] = socketPathMatches ? 1 : 0;
      }
      await input.afterStep?.();
    },
  };
  await layout.restore();
  api.startTurn(`${variant}_${operation}`, script);

  const adapter = new ClaudeTaskAdapter('subscription-token', { operation, sessionId: layout.sessionId, sandbox });
  const credential = { value: layout.token, secrets: [layout.token] };
  const plan = await adapter.start({ job: layout.job, model: SYNTHETIC_MODEL_ID, dirs, credential, schema: TASK_OUTPUT_JSON_SCHEMA });
  const base = { ...plan.env, ...baseEnvironment(dirs, layout.job, { https: `http://127.0.0.1:${ports.proxy}`, noProxy: '127.0.0.1,localhost' }) };
  await assertLaunchSafe(adapter, plan, base, credential, null);
  const args = [...plan.args];
  const env: Record<string, string> = { ...base, ANTHROPIC_BASE_URL: `http://127.0.0.1:${ports.api}`, CLAUDE_CODE_MAX_RETRIES: '0', API_TIMEOUT_MS: '5000' };
  input.adjust?.(args, env);

  const report: TurnReport = { variant, phase: operation, status: 'finished', exit_code: null, signal: null, outcome_kind: null, outcome_reason: null, init_seen: false, session_matched: false,
    policy_violations: 0, tool_calls: 0, planned_tool_calls: steps.length + 1, api_requests: 0, aux_requests: 0, rejected_requests: 0, auth_mismatch: 0, api_key_headers: 0, api_violations: {},
    proxy_refused: 0, proxy_non_loopback: 0, duration_ms: 0, rows, counts };
  const stdio: ('pipe' | 'ignore' | number)[] = ['pipe', 'pipe', 'ignore'];
  const inherited = input.inheritDirFd ? openSync(input.inheritDirFd, constants.O_RDONLY | constants.O_DIRECTORY) : null;
  if (inherited !== null) stdio.push('ignore', 'ignore', 'ignore', 'ignore', 'ignore', 'ignore', inherited);
  let child: ReturnType<typeof spawn>;
  try { child = spawn(input.cli, args, { cwd: dirs.workspace, env, detached: true, stdio }); }
  catch { report.status = 'launch_failed'; return report; }
  finally { if (inherited !== null) closeSync(inherited); }
  child.on('error', () => {});
  const pgid = child.pid;
  if (!pgid) { report.status = 'launch_failed'; return report; }
  context.cliPid = pgid;
  tracker.add(pgid);
  // 원문 줄은 메모리에서 판정만 하고 버린다. 합성 값이라도 결과로 옮기지 않는다.
  const lines: string[] = [];
  let partial = '';
  const take = (line: string) => {
    if (!line) return;
    const seen = plan.observe(line);
    lines.push(seen.line);
    if (seen.violation) report.policy_violations++;
    // 줄이 깨지면 판정이 '<malformed>'로 준다. 여기서 던지면 정리 없이 실행기가 죽는다.
    let parsed: { type?: string; subtype?: string; session_id?: string };
    try { parsed = JSON.parse(seen.line) as typeof parsed; } catch { return; }
    if (parsed.type === 'system' && parsed.subtype === 'init') {
      report.init_seen = true;
      report.session_matched = parsed.session_id === layout.sessionId;
      const raw = JSON.parse(line) as { messaging_socket_path?: unknown };
      socketPathMatches = raw.messaging_socket_path === socketFile(pgid);
    }
  };
  child.stdout!.setEncoding('utf8');
  child.stdout!.on('data', (chunk: string) => {
    const parts = (partial + chunk).split('\n');
    partial = parts.pop() ?? '';
    for (const line of parts) take(line);
  });
  child.stdin!.on('error', () => {});
  child.stdin!.end('sec02 probe');
  const budgetMs = Math.max(0, Math.min(SEC02_LIMITS.turnMs, input.deadline - Date.now()));
  let timedOut = false;
  let killTimer: NodeJS.Timeout | undefined;
  const exit = await new Promise<{ code: number | null; signal: string | null }>(done => {
    const stopTimer = setTimeout(() => {
      timedOut = true;
      signalGroup(pgid, 'SIGTERM');
      killTimer = setTimeout(() => signalGroup(pgid, 'SIGKILL'), SEC02_LIMITS.killGraceMs);
    }, budgetMs);
    // 턴이 끝난 뒤 타이머가 남으면 재사용된 번호의 그룹에 신호가 갈 수 있다.
    const finish = (status: { code: number | null; signal: string | null }) => { clearTimeout(stopTimer); done(status); };
    child.once('close', (code, signal) => finish({ code, signal }));
    child.once('error', () => finish({ code: null, signal: null }));
  });
  take(partial);
  // 부모 그룹이 안 끝나면 유예 뒤 KILL한다. close는 stdout이 닫혀야 오므로 여기까지 왔으면 대개 이미 끝났다.
  if (!await waitGone(pgid, SEC02_LIMITS.killGraceMs)) signalGroup(pgid, 'SIGKILL');
  if (killTimer) clearTimeout(killTimer);
  if (await waitGone(pgid, SEC02_LIMITS.killGraceMs)) await tracker.settle(0);
  Object.assign(report, { exit_code: exit.code, signal: exit.signal, status: timedOut ? 'timeout' : 'finished' });
  const outcome = await plan.finish(lines, exit);
  report.outcome_kind = outcome.kind;
  report.outcome_reason = outcome.kind === 'failed' ? outcome.reason : null;
  rows.push(...notRunRows(steps.slice(cursor)));
  Object.assign(report, { tool_calls: api.stats.toolCalls - before.toolCalls, api_requests: api.stats.requests - before.requests, aux_requests: api.stats.auxRequests - before.auxRequests,
    rejected_requests: api.stats.rejected - before.rejected, auth_mismatch: api.stats.authMismatch - before.authMismatch, api_key_headers: api.stats.apiKeyHeaders - before.apiKeyHeaders,
    api_violations: { ...api.stats.violations }, proxy_refused: proxy.stats.refused - proxyBefore.refused, proxy_non_loopback: proxy.stats.nonLoopback - proxyBefore.nonLoopback, duration_ms: Date.now() - started });
  return report;
}
