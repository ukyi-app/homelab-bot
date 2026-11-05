// 제어 명령 결과(Store.control·reviewControl의 반환값)를 스레드에 게시할 짧은 한국어 문장으로 바꾼다.
// JSON.stringify 그대로면 /list가 {"ref":...,"data":[...]}로 보인다(S16). 작업 ID는 /cancel·/retry의
// target에 그대로 넣어야 하므로 줄이지 않는다.
const LIST_LIMIT = 20;
type Row = Record<string, unknown>;
const isObject = (value: unknown): value is Row => typeof value === 'object' && value !== null && !Array.isArray(value);
const str = (value: unknown) => typeof value === 'string' ? value : value === null || value === undefined ? '' : JSON.stringify(value);

function jobLine(job: Row, reasonOnly = false): string {
  const reason = str(job.wait_reason);
  if (reasonOnly) return `- \`${str(job.id)}\` ${reason || '사유 없음'}`;
  return `- \`${str(job.id)}\` ${str(job.state)}${reason ? `(${reason})` : ''}`;
}
// 오래된 것부터 쌓인 목록이라 최근 것만 남긴다. 몇 건을 뺐는지는 머리줄에 적는다.
function jobList(label: string, jobs: Row[], reasonOnly = false): string[] {
  if (!jobs.length) return [`${label}: 없음`];
  const shown = jobs.slice(-LIST_LIMIT);
  return [`${label} ${jobs.length}건${shown.length < jobs.length ? `(최근 ${shown.length}건만 표시)` : ''}`,
    ...shown.map(job => jobLine(job, reasonOnly))];
}

// 작업 레인 새 접수가 닫힌 이유와 다음 행동. execution_lanes.closed_reason 세 값이다.
export function taskLaneClosedText(reason: string): string {
  if (reason === 'unknown') return '작업 레인이 닫혀 있습니다(unknown). 종료를 확인하지 못한 작업이 있습니다. 작업자 프로세스 0개를 확인한 뒤 /task-release target:<job-id>로 해제하세요. 대화·리뷰는 계속 동작합니다.';
  if (reason === 'cleanup_pending') return '작업 레인이 닫혀 있습니다(cleanup_pending). 끝난 작업의 세션 공간을 지웠는지 확인하지 못했습니다. 봇이 계속 다시 시도하고, 지워지면 저절로 열립니다.';
  if (reason === 'retention_full') return '작업 레인이 닫혀 있습니다(retention_full). 보존 세션 8개가 찼습니다. 대기 중인 작업을 /answer·/resume-model로 끝내거나 /task-cancel로 멈추면 다시 열립니다.';
  return `작업 레인이 닫혀 있습니다(${reason}).`;
}

export function controlText(command: string, result: unknown): string {
  if (Array.isArray(result) && result.every(isObject)) return jobList('작업', result).join('\n');
  if (!isObject(result)) return JSON.stringify(result);
  const status = typeof result.status === 'string' ? result.status : '';
  // 빈 /list는 실패가 아니라 안내라 머리말을 붙이지 않는다.
  if (result.ok === false && status) return command === 'list' ? status : `실패: ${status}`;
  if ((command === 'stop' || command === 'resume') && typeof result.active === 'boolean') {
    return result.active ? '이 스레드의 후속 메시지 수집을 재개했습니다.' : '이 스레드의 후속 메시지 수집을 중지했습니다. 다시 받으려면 /resume.';
  }
  if (command === 'model-status' && Array.isArray(result.waiting)) {
    return [`모델 호출: ${result.paused ? '정지' : '정상'}`, `비상 중지: ${result.emergency ? '켜짐' : '아님'}`,
      `실행 중이거나 종료 미확인 작업: ${result.executionPending ? '있음' : '없음'}`,
      ...jobList('한도·인증 대기', result.waiting.filter(isObject), true), ...(status ? [status] : [])].join('\n');
  }
  if (Array.isArray(result.jobs)) return [...jobList('리뷰 작업', result.jobs.filter(isObject)), ...(status ? [status] : [])].join('\n');
  // 모르는 모양은 버리지 않고 JSON으로 남긴다(새 제어 결과를 더하고 여기를 빠뜨려도 답이 비지 않게).
  return status || JSON.stringify(result);
}
