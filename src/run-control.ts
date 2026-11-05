import type { Dirent } from 'node:fs';
import { lstat, mkdir, mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { assertWorkerRoot } from './codex-config.js';
import type { RunCredential, WorkerCredential } from './credentials.js';
import type { AdapterRun, ChatAdapter, EngineOutcome, ExecutorCapabilities, ExitStatus, PolicyViolation, RunDirs } from './executor.js';
import { LaunchFailed, TASK_MARKER } from './process-launcher.js';
import type { LaunchResult, ProcessLauncher } from './process-launcher.js';

// 대화·리뷰 레인이 함께 쓰는 공통 실행 제어. 실행기·레인과 무관한 것을 모두 여기서 한다:
// 기한·취소·종료, 프로세스 그룹 정리와 소멸 확인, 실행마다 빈 임시 공간, 자식 env 허용 목록(작업자 env 비상속), 자격 유출 검사,
// 도구 예산·정책 위반 즉시 중단. 프롬프트·출력 스키마·결과 분류·반사 검사는 레인 몫이고, 어댑터(executor-*)는 argv·env 이름·
// 설정 파일·출력 해석·CLI 오류 분류만 한다. 한 작업자의 모든 레인이 인스턴스 하나를 공유해야 잔여물·생존 불명 차단이 레인을 넘어 걸린다.

export type RunLane = keyof ExecutorCapabilities['lanes'];
export interface RunLimits { lineBytes: number; outputBytes: number; events: number }
// 실행 공간 이름의 레인별 앞부분. 재시작 뒤 잔여물을 찾는 기준이다.
export const RUN_PREFIX = Object.freeze({ chat: 'homelab-chat-', review: 'homelab-review-' } as const);
// 작업자가 스스로 멈추는 여유. 게시 서버는 같은 timeoutMs에서 포기하고 unknown으로 두므로, 그보다 먼저 끝내고
// 정리(SIGTERM 2초 + SIGKILL 2초)까지 마쳐야 failed로 확정된다.
export const RUN_STOP_MARGIN_MS = 5000;
// 취소 응답 안에 끝내야 한다(게시 서버 cancel 5초, 서버 requestTimeout 5초).
const STOP_WAIT_MS = 4000;
// 자식 env의 공통 기본 이름. 어댑터는 이 이름을 바꾸지 못하고 자기 envNames만 더한다.
export const BASE_ENV_NAMES: readonly string[] = Object.freeze(['PATH', 'HOME', 'LANG', 'TMPDIR', TASK_MARKER, 'HTTPS_PROXY', 'NO_PROXY']);
// 유출 검사에서 읽는 실행 디렉터리 파일의 상한(실행 전이라 어댑터가 쓴 설정·스키마뿐이다).
const SCAN_LIMIT = { files: 64, bytes: 1024 * 1024 };

export function runDeadline(timeoutMs: number): number {
  return Math.max(Math.ceil(timeoutMs / 2), timeoutMs - RUN_STOP_MARGIN_MS);
}
export function baseEnvironment(dirs: RunDirs, job: string, proxy?: { https: string; noProxy: string }): Record<string, string> {
  const env: Record<string, string> = { PATH: '/usr/local/bin:/usr/bin:/bin', HOME: dirs.home, LANG: 'C.UTF-8',
    TMPDIR: dirs.tmp, [TASK_MARKER]: job };
  if (proxy) Object.assign(env, { HTTPS_PROXY: proxy.https, NO_PROXY: proxy.noProxy });
  return env;
}

// 실행 전 마지막 검사. 자격 값은 어댑터가 정한 env 변수 하나에만 있어야 한다: argv·다른 env 값·실행 디렉터리
// 파일(어댑터가 쓴 설정)에 있으면 띄우지 않는다. env 이름은 공통 기본 + 어댑터 선언 목록 밖이면 거부한다.
export async function assertLaunchSafe(adapter: ChatAdapter, plan: AdapterRun, env: Record<string, string>,
  credential: RunCredential, root: string): Promise<void> {
  for (const name of Object.keys(plan.env)) {
    if (BASE_ENV_NAMES.includes(name) || !adapter.envNames.includes(name)) throw new Error('env_not_allowed');
  }
  if (credential.value !== undefined) {
    if (!adapter.credentialEnv || plan.env[adapter.credentialEnv] !== credential.value) throw new Error('credential_env_missing');
  }
  // 반사 검사에 쓸 비밀이 없으면 띄우지 않는다. 자격을 못 읽은 채 검사 없이 실행하지 않는다.
  if (!credential.secrets.length) throw new Error('credential_secrets_missing');
  const secrets = credential.secrets.filter(secret => secret.length >= 16);
  const leaks = (text: string) => secrets.some(secret => text.includes(secret));
  if (plan.args.some(leaks)) throw new Error('credential_in_argv');
  for (const [name, value] of Object.entries(env)) {
    if (name !== adapter.credentialEnv && leaks(value)) throw new Error('credential_in_env');
  }
  let files = 0;
  const walk = async (dir: string): Promise<void> => {
    let entries: Dirent[];
    try { entries = await readdir(dir, { withFileTypes: true }); } catch { throw new Error('scan_failed'); }
    for (const entry of entries) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) { await walk(path); continue; }
      if (++files > SCAN_LIMIT.files) throw new Error('scan_failed');
      // 실행 전 디렉터리에는 어댑터가 만든 일반 파일만 있다. 그 밖(심링크 등)은 거부한다.
      if (!entry.isFile()) throw new Error('scan_failed');
      const content = await readFile(path);
      if (content.length > SCAN_LIMIT.bytes || leaks(content.toString('utf8'))) throw new Error('credential_in_file');
    }
  };
  if (secrets.length) await walk(root);
}

// 레인이 결과로 분류할 재료. 판정 순서가 계약이다: 소멸 확인 → 집행한 상한·정책 위반·중단 → 실행기 결과 → 레인 스키마 → 반사 검사.
export interface RunReport {
  exit: LaunchResult['exit'];
  survivors: number | null;
  aborted: boolean;
  launchFailed?: boolean;
  exceeded?: 'tool_budget_exceeded' | 'output_limit_exceeded' | 'policy_violation';
  // 어댑터 해석 결과. 소멸을 확인하지 못했거나, 답을 내보낼 수 없으면(기록 정리 실패·자격 재확인 실패) 없다.
  outcome?: EngineOutcome;
  secrets?: readonly string[];
  // 띄우기 전에 거절한 사유(launchFailed와 함께, 남은 프로세스 없음).
  refused?: 'lane_closed' | 'busy' | 'survivors_unconfirmed' | 'cleanup_pending' | 'prepare_failed' | 'aborted';
  // 실행은 끝났지만 임시 공간을 지우지 못했다. 답을 내보내지 않는다.
  cleanupFailed?: boolean;
  credentialRecheckFailed?: boolean;
}
export interface RunSpec {
  adapter: ChatAdapter;
  lane: RunLane;
  job: string;
  model: string;
  // 실행 공간 이름 앞부분(RUN_PREFIX).
  prefix: string;
  timeoutMs: number;
  // 도구를 끈 실행기(tools 'none')는 값과 무관하게 예산 0이다.
  toolCalls: number;
  // CLI에 넘길 출력 스키마.
  schema: object;
  // stdin으로만 넘긴다. argv·파일에 두지 않는다.
  prompt: string;
  limits: RunLimits;
}
// 정책 위반으로 멈춘 실행의 종류. 결과 reason은 policy_violation 한 단어라 원인을 가르는 곳은 이 사건뿐이다.
export interface RunViolationEvent { event: 'run_policy_violation'; lane: RunLane; kind: PolicyViolation }
export type RunEvent = { event: 'cleanup_failed' | 'cleanup_recovered' } | RunViolationEvent;
export interface RunControlOptions {
  // 실행마다 임시 디렉터리를 만드는 곳. 파드에서는 emptyDir(/tmp)이다.
  tmp?: string; homes?: string[]; proxy?: { https: string; noProxy: string };
  // 값 없는 운영 사건(실행 기록 정리 실패·복구, 정책 위반 종류). 경로·내용·job ID는 싣지 않는다.
  onEvent?: (event: RunEvent) => void;
}
interface Active { job: string; controller: AbortController; done: Promise<void> }
// 한 실행이 남긴 것. 프로세스 소멸을 확인한 뒤에만 지운다.
interface RunState { base?: string; plan?: AdapterRun; survivors: number | null }
// 소멸을 확인했지만 지우지 못한 실행의 기록(실행 디렉터리, 어댑터 고유 잔여물).
interface Residue { root?: string; plan?: AdapterRun }
const refused = (reason: NonNullable<RunReport['refused']>): RunReport =>
  ({ exit: null, survivors: 0, aborted: false, launchFailed: true, refused: reason });

export class RunControl {
  private readonly tmp: string;
  readonly proxy: { https: string; noProxy: string } | undefined;
  private active: Active | undefined;
  // 종료가 시작되면 true. 그 뒤에 들어온 실행은 띄우지 않는다.
  private closed = false;
  // 실행 뒤 기록을 지우지 못한 실행들. 남아 있는 동안 새 실행을 띄우지 않고 readiness도 닫는다.
  private readonly residues: Residue[] = [];
  // 소멸을 확인하지 못한 실행. stop이 0개를 확인하기 전에는 어느 레인도 새 실행을 띄우지 않는다.
  private readonly unconfirmed = new Set<string>();
  private scrubbing: Promise<boolean> | undefined;
  constructor(private readonly credential: WorkerCredential, private readonly launcher: ProcessLauncher,
    private readonly options: RunControlOptions) {
    // 실행 디렉터리 루트가 사람 홈이나 개인 CLI 홈(~/.codex*·~/.claude*)이면 거부한다(D-14 조건 1).
    this.tmp = assertWorkerRoot(options.tmp ?? tmpdir(), options.homes);
    this.proxy = options.proxy;
  }
  // readiness: 앞 실행의 기록이 모두 지워졌고, 선택한 자격이 쓸 수 있는 모양으로 있어야 한다. 모델을 부르지 않는다.
  // 지우지 못한 기록은 확인할 때마다 다시 지워 본다(원인이 풀리면 자동으로 돌아온다).
  async ready(): Promise<boolean> { return await this.clean() && await this.credential.ready(); }
  accepting(): boolean { return !this.closed; }
  async run(spec: RunSpec, signal: AbortSignal): Promise<RunReport> {
    // 종료가 시작된 뒤 들어온 실행(본문 수신·서명 확인이 늦게 끝난 요청)은 띄우지 않는다. 띄운 적이 없으니 failed다.
    if (!spec.adapter.capabilities.lanes[spec.lane] || this.closed) return refused('lane_closed');
    // 직렬 잠금은 위층(SerialWorker·ReviewWorker)이 지지만, 레인을 넘어 겹치지 않는 마지막 보루는 띄우는 이 자리다.
    if (this.active) return refused('busy');
    if (this.unconfirmed.size) return refused('survivors_unconfirmed');
    const controller = new AbortController();
    const forward = () => controller.abort();
    signal.addEventListener('abort', forward, { once: true });
    if (signal.aborted) controller.abort();
    const deadline = setTimeout(() => controller.abort(), runDeadline(spec.timeoutMs));
    let finish!: () => void;
    const active: Active = { job: spec.job, controller, done: new Promise<void>(resolve => { finish = resolve; }) };
    this.active = active;
    try { return await this.execute(spec, controller.signal); }
    finally {
      clearTimeout(deadline);
      signal.removeEventListener('abort', forward);
      if (this.active === active) this.active = undefined;
      finish();
    }
  }
  // 위층이 바쁜 작업과 같은 job일 때만 부른다. 실행 중이면 멈추고 정리가 끝나기를 잠깐 기다린다.
  // 이미 끝났지만 남은 프로세스 때문에 unknown으로 막힌 작업이면 다시 정리하고 0개일 때만 풀린다.
  async stop(job: string): Promise<boolean> {
    const active = this.active;
    if (active?.job === job) {
      active.controller.abort();
      const settled = await Promise.race([active.done.then(() => true),
        new Promise<boolean>(resolve => { setTimeout(() => resolve(false), STOP_WAIT_MS).unref(); })]);
      if (!settled) return false;
    } else await this.launcher.terminate(job).catch(() => {});
    const confirmed = await this.launcher.survivors(job).catch(() => null) === 0;
    if (confirmed) this.unconfirmed.delete(job);
    return confirmed;
  }
  // 종료 신호 때 새 실행을 닫고(동기, 첫 await 전), 실행 중인 모델 CLI를 멈추고 정리를 기다린다.
  async shutdown(): Promise<void> {
    this.closed = true;
    const active = this.active;
    if (!active) return;
    active.controller.abort();
    await active.done;
  }
  // 기동 때 한 번: 이전 프로세스가 지우지 못하고 죽은 실행 공간을 찾아 지운다. 컨테이너가 새로 떠서 그 프로세스는 없다.
  // 지우지 못하면 일반 잔여물과 같이 새 실행을 막는다. 재시작 뒤 공간을 물려받지 않는다.
  async sweep(): Promise<boolean> {
    if (this.active) return false;
    let names: string[];
    try { names = await readdir(this.tmp); } catch { return false; }
    for (const name of names) {
      if (Object.values(RUN_PREFIX).some(prefix => name.startsWith(prefix))) this.residues.push({ root: join(this.tmp, name) });
    }
    return this.clean();
  }
  private async execute(spec: RunSpec, signal: AbortSignal): Promise<RunReport> {
    // 앞 실행의 기록이 남아 있으면 새 실행을 띄우지 않는다. 띄운 적이 없으니 failed다.
    if (!await this.clean()) return refused('cleanup_pending');
    const state: RunState = { survivors: null };
    let report: RunReport;
    try { report = await this.attempt(spec, signal, state); }
    catch (error) { this.unconfirmed.add(spec.job); await this.release(state); throw error; }
    if (state.survivors !== 0) this.unconfirmed.add(spec.job);
    // 기록 정리는 결과를 확정하기 전에 확인한다. 지우지 못했으면 답을 내보내지 않는다(실행 뒤 기록 제거 계약).
    // 프로세스 소멸은 확인했으므로 unknown이 아니라 failed다. 한도·인증·실패 결과는 내보낼 답이 없어 그대로 둔다.
    if (await this.release(state)) return report;
    const { outcome, ...rest } = report;
    return { ...rest, cleanupFailed: true, ...(outcome && outcome.kind !== 'output' ? { outcome } : {}) };
  }
  // 이 실행의 잔여물을 정리한다. 소멸을 확인하지 못했으면 살아 있는 프로세스가 쓰는 중일 수 있어 지우지 않는다
  // (그 실행은 unknown이고 위층과 unconfirmed가 막는다). 지우지 못하면 잔여물로 남기고 false다.
  private async release(state: RunState): Promise<boolean> {
    if (state.survivors !== 0) { await state.plan?.cleanup(false).catch(() => {}); return true; }
    if (!state.base && !state.plan) return true;
    const residue: Residue = { ...(state.base ? { root: state.base } : {}), ...(state.plan ? { plan: state.plan } : {}) };
    if (await this.scrub(residue)) return true;
    this.residues.push(residue);
    this.options.onEvent?.({ event: 'cleanup_failed' });
    return false;
  }
  // 어댑터 고유 잔여물(Codex 세션 디렉터리 등)과 실행 디렉터리를 지우고, 실행 디렉터리가 정말 없어졌는지 본다.
  private async scrub(residue: Residue): Promise<boolean> {
    try {
      await residue.plan?.cleanup(true);
      if (residue.root) {
        await rm(residue.root, { recursive: true, force: true });
        const remains = await lstat(residue.root).then(() => true, (error: { code?: string }) => error.code !== 'ENOENT');
        if (remains) return false;
      }
      return true;
    } catch { return false; }
  }
  // 앞서 지우지 못한 기록을 다시 지운다. 모두 지웠으면 true. readiness와 새 실행이 함께 불러도 한 번만 돈다.
  // 진행 표시는 끝난 뒤 비동기로 지운다(동기로 끝나는 경우에도 끝난 약속이 남지 않게).
  private clean(): Promise<boolean> {
    if (!this.scrubbing) this.scrubbing = this.cleanNow().finally(() => { this.scrubbing = undefined; });
    return this.scrubbing;
  }
  private async cleanNow(): Promise<boolean> {
    if (!this.residues.length) return true;
    for (const residue of [...this.residues]) {
      if (await this.scrub(residue)) this.residues.splice(this.residues.indexOf(residue), 1);
    }
    if (this.residues.length) return false;
    this.options.onEvent?.({ event: 'cleanup_recovered' });
    return true;
  }
  private async attempt(spec: RunSpec, signal: AbortSignal, state: RunState): Promise<RunReport> {
    const adapter = spec.adapter;
    let env: Record<string, string>;
    let credential: RunCredential;
    let plan: AdapterRun;
    let base: string;
    try {
      base = state.base = await mkdtemp(join(this.tmp, spec.prefix));
      const dirs: RunDirs = { root: base, home: join(base, 'home'), config: join(base, 'config'),
        workspace: join(base, 'workspace'), run: join(base, 'run'), tmp: join(base, 'tmp') };
      for (const dir of [dirs.home, dirs.config, dirs.workspace, dirs.run, dirs.tmp]) await mkdir(dir, { mode: 0o700 });
      credential = await this.credential.forRun();
      plan = state.plan = await adapter.start({ job: spec.job, model: spec.model, dirs, credential, schema: spec.schema });
      // 작업자 프로세스 env를 읽거나 병합하지 않는다. 작업자 env에는 다른 자격·공개 키·플랫폼 값이 있을 수 있다.
      env = { ...plan.env, ...baseEnvironment(dirs, spec.job, this.options.proxy) };
      await assertLaunchSafe(adapter, plan, env, credential, base);
    } catch {
      // 프로세스를 띄우기 전 실패다. 남은 프로세스가 없으니 unknown이 아니다.
      state.survivors = 0;
      return refused('prepare_failed');
    }
    const limits = spec.limits;
    // 도구를 끈 실행기는 예산 0이다. 도구 호출이 하나라도 보이면 멈춘다.
    const budget = adapter.capabilities.tools === 'none' ? 0 : spec.toolCalls;
    const lines: string[] = [];
    const tools = new Set<string>();
    let exceeded: RunReport['exceeded'];
    const inner = new AbortController();
    const forward = () => inner.abort();
    signal.addEventListener('abort', forward, { once: true });
    const stop = (reason: NonNullable<RunReport['exceeded']>) => { exceeded ??= reason; inner.abort(); };
    const violated = (kind: PolicyViolation) => this.options.onEvent?.({ event: 'run_policy_violation', lane: spec.lane, kind });
    const onLine = (line: string) => {
      if (exceeded) return;
      if (lines.length >= limits.events) { stop('output_limit_exceeded'); return; }
      const seen = plan.observe(line);
      lines.push(seen.line);
      // 소멸 확인 전에 남긴다. 프로세스가 안 죽어 결과가 unknown이 되어도 종류는 보인다. 위 exceeded 검사로 실행당 한 번이다.
      if (seen.violation) { stop('policy_violation'); violated(seen.violation); return; }
      for (const tool of seen.tools) tools.add(tool);
      if (tools.size > budget) stop('tool_budget_exceeded');
    };
    let result: LaunchResult = { exit: null };
    let launchFailed = false;
    try {
      // 준비하는 동안 중단·종료가 시작됐으면 띄우지 않는다. 이 확인과 launcher의 spawn 사이에는 await가 없다.
      if (signal.aborted || this.closed) { state.survivors = 0; return refused('aborted'); }
      result = await this.launcher.run({ job: spec.job, args: [...plan.args], cwd: join(base, 'workspace'), env,
        stdin: spec.prompt, limits: { lineBytes: limits.lineBytes, outputBytes: limits.outputBytes } }, inner.signal, onLine);
      if (result.overflow) exceeded ??= 'output_limit_exceeded';
    } catch (error) { launchFailed = error instanceof LaunchFailed; }
    finally { signal.removeEventListener('abort', forward); }
    await this.launcher.terminate(spec.job).catch(() => {});
    const survivors = state.survivors = await this.launcher.survivors(spec.job).catch(() => null);
    const report: RunReport = { exit: result.exit, survivors, aborted: signal.aborted, launchFailed, exceeded };
    // 남은 프로세스가 있거나 모르면 결과 파일을 읽지 않는다. 살아 있는 프로세스가 바꿔치기할 수 있다.
    if (survivors !== 0 || !result.exit || exceeded || signal.aborted) return report;
    const outcome = await plan.finish(lines, result.exit as ExitStatus).catch((): EngineOutcome => ({ kind: 'failed', reason: 'finish_failed' }));
    // 실행 중에 이미 멈췄다면(exceeded) 위에서 돌아가 여기 오지 않으니 두 번 나가지 않는다.
    if (outcome.kind === 'failed' && outcome.violation) violated(outcome.violation);
    // 실행 뒤 자격을 다시 읽지 못하면(회전 파일 갱신본 포함) 반사 검사를 할 수 없어 답을 내보내지 않는다.
    let after: string[];
    try { after = await this.credential.secrets(); } catch { return { ...report, credentialRecheckFailed: true }; }
    return { ...report, outcome, secrets: [...credential.secrets, ...after] };
  }
}
