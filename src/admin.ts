import type { PolicyGate } from './policy.js';
import type { Store } from './store.js';
import type { ReleaseOutcome, TaskBridge } from './task-bridge.js';
import type { ExecutionLaneClosedReason } from './task-contracts.js';
import { ACCOUNT_METHODS, ACCOUNT_NAME, listAccounts, recordAccount, switchAccount } from './model-accounts.js';
import type { AccountMethod, AccountView, PausedCounts } from './model-accounts.js';
import { CREDENTIAL_REVISION } from './execution-auth.js';
import { disableMethods, installMethods, methodRoutingView, unlockApi } from './method-routing.js';
import type { MethodRoutingView } from './method-routing.js';

// 관리 기능 진입점의 명령 처리(명세 §4.8, DECISIONS "동료 봇 전환" 3). owner가 클러스터 접근 권한으로 `homelab bot`을 실행하면
// CLI가 게시 서버 파드 안에서 admin-main을 부른다. 권한의 근거는 클러스터 접근이지 Discord owner ID가 아니다.
// 모델을 부르지 않는다. 작업자는 unknown 해제의 소멸 확인에만 부른다. 차단·해제·재개는 '/' 경로와 같은 안전 검사를 거치되
// owner·대화를 대조하지 않는 관리용 메서드(PolicyGate.deny, TaskBridge.adminRelease, Store.adminResumeJob)를 쓴다.
// 출력은 고정 결과 이름과 상태 값뿐이다(저장소의 안내 문구는 '/' 이름을 담아 싣지 않는다).
export const ADMIN_ACTOR = 'cli';
// Store.control의 대화 자리. scopeId(`종류:guild:채널`)와 모양이 달라 실제 대화 행과 겹치지 않는다.
// 대화 행이 없으니 owner 대조를 거치지 않고, 대화에 묶인 값(대기 작업 목록)은 비어 나온다.
export const ADMIN_CONVERSATION = 'admin:cli';
export const ADMIN_SCHEMA = 'homelab-bot-admin/v1';
export const ADMIN_EXIT = { ok: 0, failed: 1, refused: 3, unsupported: 4, usage: 64 } as const;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
// Discord 사용자 ID(snowflake). 차단 대상 형식만 본다.
const SNOWFLAKE = /^[1-9][0-9]{16,19}$/;

export type AdminCommand =
  | { name: 'emergency-stop' }
  | { name: 'resume'; target: 'emergency-stop' }
  | { name: 'resume'; target: 'job'; job: string }
  | { name: 'status' }
  | { name: 'block'; user: string }
  | { name: 'release'; job: string }
  | { name: 'account'; action: 'record' | 'use'; account: string; method: AccountMethod }
  | { name: 'account'; action: 'list' }
  // 한도 뒤 API 사용(C40). auto-install은 homelab CLI(C42)가 두 방식·묶음 반영을 확인한 뒤에만 부른다.
  | { name: 'account'; action: 'auto-install'; account: string; revision: string }
  | { name: 'account'; action: 'auto-off' } | { name: 'account'; action: 'auto-status' } | { name: 'account'; action: 'api-unlock' };

export type AdminState = { emergency: boolean; paused: boolean; executionPending: boolean; taskLaneClosed: ExecutionLaneClosedReason | null };
// homelab CLI(cli/src/core/podops.ts BOT_RESULTS)가 받는 이름과 같아야 한다. 이름을 더하면 그쪽 집합도 넓힌다.
export type AdminResult = 'stopped' | 'already_stopped' | 'released' | 'not_stopped' | 'running_jobs' | 'status' | 'unsupported' | 'usage' | 'failed'
  | 'blocked' | 'already_blocked' | 'not_releasable' | 'resumed' | 'not_waiting' | 'emergency_stopped' | 'queue_full'
  | 'recorded' | 'accounts' | 'switched' | 'unknown_account'
  | 'auto_installed' | 'not_current' | 'auto_disabled' | 'not_installed' | 'auto_status' | 'api_unlocked' | 'not_locked';
// 계정 전환 뒤 해제의 결과. resumed는 다시 큐에 넣은 작업 수, waiting은 아직 모델 멈춤으로 기다리는 수,
// held는 비상 정지로 해제를 못 했으면 그 이유, 아니면 null. 대기열 상한은 해제를 막지 않는다(Store.resumeWaiting).
// 결과 이름 queue_full은 homelab CLI 집합과 맞추려고 AdminResult에 남아 있고 지금은 내지 않는다.
export type AccountSwitch = { resumed: number; waiting: number; held: 'emergency_stopped' | null };
export type AdminReport = { schema: typeof ADMIN_SCHEMA; command: string; result: AdminResult; state?: AdminState;
  accounts?: AccountView[]; paused?: PausedCounts; switch?: AccountSwitch; methods?: MethodRoutingView };

export class AdminUsage extends Error {
  constructor() { super('admin_usage'); }
}

// 입력은 고정 명령 단어와 형식 검사를 거친 ID뿐이다. 그 밖은 사용법 오류로 아무것도 하지 않는다.
export function parseAdminArgs(argv: readonly string[]): AdminCommand {
  const [name, a, b, ...rest] = argv;
  if (name === 'account') return parseAccount(argv.slice(1));
  if (rest.length) throw new AdminUsage();
  if (name === 'emergency-stop' && a === undefined) return { name };
  if (name === 'status' && a === undefined) return { name };
  if (name === 'resume' && a === 'emergency-stop' && b === undefined) return { name, target: 'emergency-stop' };
  if (name === 'resume' && a === 'job' && b !== undefined && UUID.test(b)) return { name, target: 'job', job: b };
  if (name === 'block' && a !== undefined && b === undefined && SNOWFLAKE.test(a)) return { name, user: a };
  if (name === 'release' && a !== undefined && b === undefined && UUID.test(a)) return { name, job: a };
  throw new AdminUsage();
}
// 계정 동작은 `account list`와 `account record|use <이름> subscription|api`뿐이다(api는 API 크레딧 방식).
function parseAccount([action, account, method, ...rest]: readonly string[]): AdminCommand {
  if (action === 'list' && account === undefined) return { name: 'account', action };
  if (action === 'auto-off' && account === undefined) return { name: 'account', action };
  if (action === 'auto-status' && account === undefined) return { name: 'account', action };
  if (action === 'api-unlock' && account === undefined) return { name: 'account', action };
  if (action === 'auto-install' && account !== undefined && ACCOUNT_NAME.test(account) && method !== undefined && CREDENTIAL_REVISION.test(method) && !rest.length)
    return { name: 'account', action, account, revision: method };
  if ((action === 'record' || action === 'use') && account !== undefined && ACCOUNT_NAME.test(account)
    && (ACCOUNT_METHODS as readonly (string | undefined)[]).includes(method) && !rest.length)
    return { name: 'account', action, account, method: method as AccountMethod };
  throw new AdminUsage();
}

const label = (command: AdminCommand) => command.name === 'resume' ? `resume ${command.target}`
  : command.name === 'account' ? `account ${command.action}` : command.name;
type ModelStatus = { paused: boolean; emergency: boolean; executionPending: boolean; taskLaneClosed: ExecutionLaneClosedReason | null };
const stateOf = (status: ModelStatus): AdminState =>
  ({ emergency: status.emergency, paused: status.paused, executionPending: status.executionPending, taskLaneClosed: status.taskLaneClosed });

// 차단·unknown 해제에만 쓰는 의존. 진입점은 이 동작일 때만 정책·작업자 설정을 읽어 만든다.
// 그래서 정책을 읽지 못해도 비상 정지·해제·상태 보기·멈춘 작업 재개는 DATABASE_URL만으로 된다.
export interface AdminPorts {
  gate?: Pick<PolicyGate, 'withDatabase'>;
  // 게시 서버가 조립하는 작업 브리지. 앞에서부터 묻고, 다른 실행기의 세션(foreign)이면 다음 브리지에 넘긴다.
  releasers?: readonly Pick<TaskBridge, 'adminRelease'>[];
}
// 소멸을 확인하지 못했거나 확인 사이 상태가 넘어갔으면 '/task-release'처럼 나중에 다시 시도할 일이다.
const releaseResult = (outcome: ReleaseOutcome): AdminResult =>
  outcome === 'released' ? 'released' : outcome === 'worker_alive' || outcome === 'state_changed' ? 'running_jobs' : 'not_releasable';

export async function runAdmin(store: Store, command: AdminCommand, ports: AdminPorts = {}): Promise<{ code: number; report: AdminReport }> {
  const report = (result: AdminResult, state?: AdminState): AdminReport => ({ schema: ADMIN_SCHEMA, command: label(command), result, ...(state ? { state } : {}) });
  const target = command.name !== 'account' ? {} : command.action === 'record' || command.action === 'use' ? { account: command.account, method: command.method }
    : command.action === 'auto-install' ? { account: command.account, revision: command.revision } : {};
  const audit = (s: Store, result: AdminResult) => s.audit('admin_command', label(command), { actor: ADMIN_ACTOR, result, ...target });
  const status = (s: Store) => s.control(ADMIN_ACTOR, ADMIN_CONVERSATION, 'model-status') as Promise<ModelStatus>;
  if (command.name === 'release') {
    // 작업자 소멸 확인은 HTTP 호출이라 트랜잭션 밖에서 한다. 상태 확인과 바꾸기는 브리지의 해제 CAS가 한 트랜잭션에서 한다.
    if (!ports.releasers?.length) throw new Error('admin_task_lane_unavailable');
    let outcome: ReleaseOutcome = 'foreign';
    for (const releaser of ports.releasers) {
      outcome = await releaser.adminRelease(command.job, ADMIN_ACTOR);
      if (outcome !== 'foreign') break;
    }
    const result = releaseResult(outcome);
    await audit(store, result);
    return { code: result === 'released' ? ADMIN_EXIT.ok : ADMIN_EXIT.refused, report: report(result, stateOf(await status(store))) };
  }
  // 상태 확인과 바꾸기를 한 트랜잭션에서 한다. Store.atomic은 안쪽 control의 atomic을 같은 트랜잭션으로 합친다.
  return store.atomic(async s => {
    if (command.name === 'account') {
      if (command.action === 'list') return { code: ADMIN_EXIT.ok, report: { ...report('accounts'), ...await listAccounts(s.db) } };
      // 한도 뒤 API 사용(C40). 모델 대기·한도 관측·지금 계정 표시는 건드리지 않는 좁은 동작이다(계정 전환 switchAccount를 쓰지 않는다).
      if (command.action === 'auto-status') return { code: ADMIN_EXIT.ok, report: { ...report('auto_status'), methods: await methodRoutingView(s.db) } };
      if (command.action === 'auto-install') {
        const outcome = await installMethods(s, command.account, command.revision);
        const result = outcome.result === 'installed' ? 'auto_installed' : outcome.result;
        await audit(s, result);
        return { code: result === 'auto_installed' ? ADMIN_EXIT.ok : ADMIN_EXIT.refused, report: { ...report(result), methods: await methodRoutingView(s.db) } };
      }
      if (command.action === 'auto-off' || command.action === 'api-unlock') {
        const changed = command.action === 'auto-off' ? await disableMethods(s) : await unlockApi(s);
        const result = command.action === 'auto-off' ? (changed ? 'auto_disabled' : 'not_installed') : (changed ? 'api_unlocked' : 'not_locked');
        await audit(s, result);
        return { code: ADMIN_EXIT.ok, report: { ...report(result), methods: await methodRoutingView(s.db) } };
      }
      if (command.action === 'record') {
        await recordAccount(s.db, command.account, command.method, s.now());
        await audit(s, 'recorded');
        return { code: ADMIN_EXIT.ok, report: report('recorded') };
      }
      const outcome = await switchAccount(s, command.account, command.method, ADMIN_ACTOR, ADMIN_CONVERSATION);
      await audit(s, outcome.result);
      if (outcome.result === 'unknown_account') return { code: ADMIN_EXIT.refused, report: report('unknown_account') };
      const { resumed, waiting, held } = outcome;
      return { code: ADMIN_EXIT.ok, report: { ...report('switched', stateOf(await status(s))), switch: { resumed, waiting, held } } };
    }
    if (command.name === 'block') {
      if (!ports.gate) throw new Error('admin_policy_unavailable');
      const result = await ports.gate.withDatabase(s.db).deny(command.user) ? 'blocked' : 'already_blocked';
      await audit(s, result);
      return { code: ADMIN_EXIT.ok, report: report(result) };
    }
    const before = await status(s);
    if (command.name === 'status') return { code: ADMIN_EXIT.ok, report: report('status', stateOf(before)) };
    if (command.name === 'emergency-stop') {
      await s.control(ADMIN_ACTOR, ADMIN_CONVERSATION, 'emergency-stop');
      const result = before.emergency ? 'already_stopped' : 'stopped';
      await audit(s, result);
      return { code: ADMIN_EXIT.ok, report: report(result, stateOf(await status(s))) };
    }
    if (command.target === 'job') {
      const result = await s.adminResumeJob(command.job, ADMIN_ACTOR);
      await audit(s, result);
      return { code: result === 'resumed' ? ADMIN_EXIT.ok : ADMIN_EXIT.refused, report: report(result, stateOf(await status(s))) };
    }
    // 비상 정지가 없으면 바꾸지 않는다. '/resume-model target:emergency-stop'은 이때도 다른 대기의 일시 중지를 풀지만,
    // 관리 기능의 재실행은 상태를 바꾸지 않아야 한다(재실행 안전).
    if (!before.emergency) return { code: ADMIN_EXIT.ok, report: report('not_stopped', stateOf(before)) };
    const resumed = await s.control(ADMIN_ACTOR, ADMIN_CONVERSATION, 'resume-model', 'emergency-stop') as { ok: boolean };
    const result = resumed.ok ? 'released' : 'running_jobs';
    await audit(s, result);
    return { code: resumed.ok ? ADMIN_EXIT.ok : ADMIN_EXIT.refused, report: report(result, stateOf(await status(s))) };
  });
}
