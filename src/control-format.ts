import { CHAT_TASK_TEXT as T, jobStateText, waitReasonText } from './chat-task-text.js';
import { publicAlias } from './public-alias.js';

// 제어 명령 결과(Store.control·reviewControl의 반환값)를 스레드에 게시할 짧은 한국어 문장으로 바꾼다.
// JSON.stringify 그대로면 /list가 {"ref":...,"data":[...]}로 보인다(S16).
// 작업 ID(UUID)는 공개 별칭으로만 싣는다(F-4). 모르는 상태 값·결과 모양은 원래 값 대신 고정 문구로 적는다(F-5).
// colleague는 동료 기능 스위치다(chat-task-text.ts). 켜지면 '/' 명령 이름을 안내하지 않는다.
const LIST_LIMIT = 20;
type Row = Record<string, unknown>;
const isObject = (value: unknown): value is Row => typeof value === 'object' && value !== null && !Array.isArray(value);
const str = (value: unknown) => typeof value === 'string' ? value : value === null || value === undefined ? '' : JSON.stringify(value);

// 모델 멈춤·비상 정지·종료를 모르는 작업의 안내(discord.md의 자리 비움·관리 기능 안내 꼴). 필요한 상태와 다음 행동만 싣고
// 원인·시각·작업 목록은 싣지 않는다(원인과 풀리는 시각은 Telegram 운영 알림이 맡는다).
export const CONTROL_TEXT = Object.freeze({
  emergency: '비상 정지 중이에요. 푸는 건 `homelab` CLI에서 해 주세요.',
  waiting: (count: number) => `기다리는 일 ${count}건은 돌아오면 이어서 해요.`,
  executionPending: '끝났는지 확인하지 못한 작업이 있어요. 확인은 `homelab` CLI에서 해 주세요.',
  running: '지금은 멈춘 것이 없어요.',
  unknownState: '확인 필요',
  unknownResult: '처리 결과를 여기서 보여 드릴 수 없어요. `homelab` CLI에서 확인해 주세요.',
});
// 표에 없는 값은 원래 값을 돌려받는다. 그 값은 내부 이름이라 싣지 않는다.
const known = (text: (value: string) => string, value: string) => text(value) === value ? CONTROL_TEXT.unknownState : text(value);

function jobLine(job: Row, reasonOnly = false): string {
  const reason = str(job.wait_reason);
  const alias = `- \`${publicAlias(str(job.id))}\``;
  if (reasonOnly) return `${alias} ${reason ? known(waitReasonText, reason) : '사유 없음'}`;
  return `${alias} ${known(jobStateText, str(job.state))}${reason ? `(${known(waitReasonText, reason)})` : ''}`;
}
// 오래된 것부터 쌓인 목록이라 최근 것만 남긴다. 몇 건을 뺐는지는 머리줄에 적는다.
function jobList(label: string, jobs: Row[], reasonOnly = false): string[] {
  if (!jobs.length) return [`${label}: 없음`];
  const shown = jobs.slice(-LIST_LIMIT);
  return [`${label} ${jobs.length}건${shown.length < jobs.length ? `(최근 ${shown.length}건만 표시)` : ''}`,
    ...shown.map(job => jobLine(job, reasonOnly))];
}
function modelStatusText(result: Row, waiting: number): string {
  const lines: string[] = [];
  if (result.emergency === true) lines.push(CONTROL_TEXT.emergency);
  else if (result.paused === true || waiting) lines.push(T.away);
  if (waiting) lines.push(CONTROL_TEXT.waiting(waiting));
  if (result.executionPending === true) lines.push(CONTROL_TEXT.executionPending);
  return lines.length ? lines.join('\n') : CONTROL_TEXT.running;
}

// 작업 레인 새 접수가 닫힌 이유와 다음 행동. execution_lanes.closed_reason 세 값이다.
export function taskLaneClosedText(reason: string, colleague = false): string {
  if (reason === 'unknown') return T.laneClosedUnknown(colleague);
  if (reason === 'cleanup_pending') return T.laneClosedCleanup;
  if (reason === 'retention_full') return T.laneClosedRetention(colleague);
  return T.laneClosedOther(colleague, reason);
}

export function controlText(command: string, result: unknown, colleague = false): string {
  if (Array.isArray(result) && result.every(isObject)) return jobList('작업', result).join('\n');
  if (!isObject(result)) return CONTROL_TEXT.unknownResult;
  const status = typeof result.status === 'string' ? result.status : '';
  // 빈 /list는 실패가 아니라 안내라 머리말을 붙이지 않는다.
  if (result.ok === false && status) return command === 'list' ? status : T.controlFailed(colleague, status);
  if ((command === 'stop' || command === 'resume') && typeof result.active === 'boolean') {
    return result.active ? T.subscriptionResumed : T.subscriptionStopped(colleague);
  }
  if (command === 'model-status' && Array.isArray(result.waiting)) return modelStatusText(result, result.waiting.filter(isObject).length);
  if (Array.isArray(result.jobs)) return [...jobList('리뷰 작업', result.jobs.filter(isObject)), ...(status ? [status] : [])].join('\n');
  // 모르는 모양은 원래 값(JSON)을 싣지 않는다. 내부 ID·상태 이름이 그대로 나갈 수 있다.
  return status || CONTROL_TEXT.unknownResult;
}
