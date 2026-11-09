import { CHAT_TASK_TEXT as T, jobStateText, waitReasonText } from './chat-task-text.js';

// 제어 명령 결과(Store.control·reviewControl의 반환값)를 스레드에 게시할 짧은 한국어 문장으로 바꾼다.
// JSON.stringify 그대로면 /list가 {"ref":...,"data":[...]}로 보인다(S16). 작업 ID는 /cancel·/retry의
// target에 그대로 넣어야 하므로 줄이지 않는다.
// colleague는 동료 기능 스위치다(chat-task-text.ts). 켜지면 '/' 명령 이름을 안내하지 않는다.
const LIST_LIMIT = 20;
type Row = Record<string, unknown>;
const isObject = (value: unknown): value is Row => typeof value === 'object' && value !== null && !Array.isArray(value);
const str = (value: unknown) => typeof value === 'string' ? value : value === null || value === undefined ? '' : JSON.stringify(value);

function jobLine(job: Row, reasonOnly = false): string {
  const reason = str(job.wait_reason);
  if (reasonOnly) return `- \`${str(job.id)}\` ${reason ? waitReasonText(reason) : '사유 없음'}`;
  return `- \`${str(job.id)}\` ${jobStateText(str(job.state))}${reason ? `(${waitReasonText(reason)})` : ''}`;
}
// 오래된 것부터 쌓인 목록이라 최근 것만 남긴다. 몇 건을 뺐는지는 머리줄에 적는다.
function jobList(label: string, jobs: Row[], reasonOnly = false): string[] {
  if (!jobs.length) return [`${label}: 없음`];
  const shown = jobs.slice(-LIST_LIMIT);
  return [`${label} ${jobs.length}건${shown.length < jobs.length ? `(최근 ${shown.length}건만 표시)` : ''}`,
    ...shown.map(job => jobLine(job, reasonOnly))];
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
  if (!isObject(result)) return JSON.stringify(result);
  const status = typeof result.status === 'string' ? result.status : '';
  // 빈 /list는 실패가 아니라 안내라 머리말을 붙이지 않는다.
  if (result.ok === false && status) return command === 'list' ? status : T.controlFailed(colleague, status);
  if ((command === 'stop' || command === 'resume') && typeof result.active === 'boolean') {
    return result.active ? T.subscriptionResumed : T.subscriptionStopped(colleague);
  }
  if (command === 'model-status' && Array.isArray(result.waiting)) {
    return [`모델 호출: ${result.paused ? '멈춤' : '정상'}`, `비상 정지: ${result.emergency ? '켜짐' : '꺼짐'}`,
      `실행 중이거나 끝났는지 모르는 작업: ${result.executionPending ? '있음' : '없음'}`,
      ...jobList('한도·인증 대기', result.waiting.filter(isObject), true), ...(status ? [status] : [])].join('\n');
  }
  if (Array.isArray(result.jobs)) return [...jobList('리뷰 작업', result.jobs.filter(isObject)), ...(status ? [status] : [])].join('\n');
  // 모르는 모양은 버리지 않고 JSON으로 남긴다(새 제어 결과를 더하고 여기를 빠뜨려도 답이 비지 않게).
  return status || JSON.stringify(result);
}
