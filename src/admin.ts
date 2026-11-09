import type { Store } from './store.js';
import type { ExecutionLaneClosedReason } from './task-contracts.js';

// 관리 기능 진입점의 명령 처리(명세 §4.8, DECISIONS "동료 봇 전환" 3). owner가 클러스터 접근 권한으로 `homelab bot`을 실행하면
// CLI가 게시 서버 파드 안에서 admin-main을 부른다. 권한의 근거는 클러스터 접근이지 Discord owner ID가 아니다.
// 모델·작업자를 부르지 않고 기존 Store.control 경로만 쓴다. 출력은 고정 결과 이름과 상태 값뿐이다(저장소의 안내 문구는 '/' 이름을 담아 싣지 않는다).
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
  | { name: 'release'; job: string };

export type AdminState = { emergency: boolean; paused: boolean; executionPending: boolean; taskLaneClosed: ExecutionLaneClosedReason | null };
export type AdminResult = 'stopped' | 'already_stopped' | 'released' | 'not_stopped' | 'running_jobs' | 'status' | 'unsupported' | 'usage' | 'failed';
export type AdminReport = { schema: typeof ADMIN_SCHEMA; command: string; result: AdminResult; state?: AdminState };

export class AdminUsage extends Error {
  constructor() { super('admin_usage'); }
}

// 입력은 고정 명령 단어와 형식 검사를 거친 ID뿐이다. 그 밖은 사용법 오류로 아무것도 하지 않는다.
export function parseAdminArgs(argv: readonly string[]): AdminCommand {
  const [name, a, b, ...rest] = argv;
  if (rest.length) throw new AdminUsage();
  if (name === 'emergency-stop' && a === undefined) return { name };
  if (name === 'status' && a === undefined) return { name };
  if (name === 'resume' && a === 'emergency-stop' && b === undefined) return { name, target: 'emergency-stop' };
  if (name === 'resume' && a === 'job' && b !== undefined && UUID.test(b)) return { name, target: 'job', job: b };
  if (name === 'block' && a !== undefined && b === undefined && SNOWFLAKE.test(a)) return { name, user: a };
  if (name === 'release' && a !== undefined && b === undefined && UUID.test(a)) return { name, job: a };
  throw new AdminUsage();
}

const label = (command: AdminCommand) => command.name === 'resume' ? `resume ${command.target}` : command.name;
type ModelStatus = { paused: boolean; emergency: boolean; executionPending: boolean; taskLaneClosed: ExecutionLaneClosedReason | null };
const stateOf = (status: ModelStatus): AdminState =>
  ({ emergency: status.emergency, paused: status.paused, executionPending: status.executionPending, taskLaneClosed: status.taskLaneClosed });

export async function runAdmin(store: Store, command: AdminCommand): Promise<{ code: number; report: AdminReport }> {
  const report = (result: AdminResult, state?: AdminState): AdminReport => ({ schema: ADMIN_SCHEMA, command: label(command), result, ...(state ? { state } : {}) });
  // 차단·unknown 해제·멈춘 작업 재개는 기존 함수가 Discord owner 행위자와 대화를 요구해 CLI 행위자로 부를 수 없다.
  // 시그니처를 바꾸지 않고 막아 둔다(DECISIONS "C05 관리 CLI"). 그동안 '/revoke'·'/task-release'·'/resume-model'이 예비다.
  if (command.name === 'block' || command.name === 'release' || (command.name === 'resume' && command.target === 'job'))
    return { code: ADMIN_EXIT.unsupported, report: report('unsupported') };
  // 상태 확인과 바꾸기를 한 트랜잭션에서 한다. Store.atomic은 안쪽 control의 atomic을 같은 트랜잭션으로 합친다.
  return store.atomic(async s => {
    const status = () => s.control(ADMIN_ACTOR, ADMIN_CONVERSATION, 'model-status') as Promise<ModelStatus>;
    const before = await status();
    const audit = (result: AdminResult) => s.audit('admin_command', label(command), { actor: ADMIN_ACTOR, result });
    if (command.name === 'status') return { code: ADMIN_EXIT.ok, report: report('status', stateOf(before)) };
    if (command.name === 'emergency-stop') {
      await s.control(ADMIN_ACTOR, ADMIN_CONVERSATION, 'emergency-stop');
      const result = before.emergency ? 'already_stopped' : 'stopped';
      await audit(result);
      return { code: ADMIN_EXIT.ok, report: report(result, stateOf(await status())) };
    }
    // 비상 정지가 없으면 바꾸지 않는다. '/resume-model target:emergency-stop'은 이때도 다른 대기의 일시 중지를 풀지만,
    // 관리 기능의 재실행은 상태를 바꾸지 않아야 한다(재실행 안전).
    if (!before.emergency) return { code: ADMIN_EXIT.ok, report: report('not_stopped', stateOf(before)) };
    const resumed = await s.control(ADMIN_ACTOR, ADMIN_CONVERSATION, 'resume-model', 'emergency-stop') as { ok: boolean };
    const result = resumed.ok ? 'released' : 'running_jobs';
    await audit(result);
    return { code: resumed.ok ? ADMIN_EXIT.ok : ADMIN_EXIT.refused, report: report(result, stateOf(await status())) };
  });
}
