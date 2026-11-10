// 대화·작업·제어 고정 문구. 동료 말투(해요체, 결론부터, 자기를 "봇"이라 부르지 않음)로 쓴다.
// 첫 인자 colleague는 동료 기능 스위치(config.colleagueEnabled === true)다. 켜지면 '/' 명령 이름을 안내하지 않고 말로 하는 안내를,
// 관리 기능(비상 정지 해제·unknown 해제·모델 상태·한도 대기 재개)은 CLI로 한다고만 안내한다. 꺼지면 지금의 '/' 안내를 남긴다.
// 함정: 항목마다 분기가 colleague 하나뿐이어야 한다. 시험이 모든 항목을 같은 인자로 불러 '/' 이름이 없는지 보므로,
// 다른 값으로 갈라지는 문장은 항목을 나눈다.
const CLI = '`homelab bot` CLI';

const JOB_STATES: Readonly<Record<string, string>> = Object.freeze({
  queued: '대기 중', running: '실행 중', waiting_user: '확인 기다림', verifying: '확인 중', succeeded: '완료', failed: '실패',
  cancel_requested: '취소 요청됨', cancelled: '취소됨', unknown: '끝났는지 모름', superseded: '대체됨',
});
const WAIT_REASONS: Readonly<Record<string, string>> = Object.freeze({
  model_limit: '모델 사용 한도', auth_expired: '모델 인증 만료', clarification: '질문 답 기다림', question_expired: '질문 기한 지남',
  stop_confirmation: '멈춤 확인', subscription_stopped: '구독 멈춤',
});
const LANE_REASONS: Readonly<Record<string, string>> = Object.freeze({
  unknown: '끝났는지 확인하지 못한 작업이 있음', cleanup_pending: '끝난 작업의 세션 공간 정리를 확인하는 중', retention_full: '보존 세션 8개가 다 참',
});
// DB·감사의 코드는 그대로 두고 owner가 읽는 자리에서만 푼다. 모르는 코드는 버리지 않고 그대로 보인다.
export const jobStateText = (state: string) => JOB_STATES[state] ?? state;
export const waitReasonText = (reason: string) => WAIT_REASONS[reason] ?? reason;
export const laneReasonText = (reason: string) => LANE_REASONS[reason] ?? reason;

export const CHAT_TASK_TEXT = Object.freeze({
  // 대화·조회·작업 상태 안내(Store)
  readTimeout: (c: boolean) => c ? '조회가 시간 안에 끝나지 않았어요. 다시 조회해 달라고 말해 주세요.'
    : '조회가 시간 안에 끝나지 않았어요. /read로 다시 요청해 주세요.',
  jobFailed: (c: boolean) => c ? '작업이 실패했어요. 작업 목록을 보여 달라고 하면 상태를 볼 수 있고, 다시 해 달라고 하면 다시 시도해요.'
    : '작업이 실패했어요. /list로 상태를 보고 /retry로 다시 시도할 수 있어요.',
  taskCancelled: (_c: boolean, job: string) =>
    `작업 ${job} 취소를 마쳤어요. 실행 중인 프로세스가 없는 걸 확인했고 다시 실행하지 않아요. 필요하면 새 작업으로 요청해 주세요.`,
  modelWaitAuth: (c: boolean, job: string) => `모델 인증이 만료돼 작업이 멈췄어요. ${c
    ? `원인을 해결한 뒤 ${CLI}로 재개하거나 상태를 볼 수 있어요.`
    : `원인을 해결한 뒤 /resume-model target:${job}로 재개해 주세요. 상태는 /model-status로 볼 수 있어요.`}`,
  modelWaitLimit: (c: boolean, job: string) => `모델 사용 한도에 걸려 작업이 멈췄어요. ${c
    ? `원인을 해결한 뒤 ${CLI}로 재개하거나 상태를 볼 수 있어요.`
    : `원인을 해결한 뒤 /resume-model target:${job}로 재개해 주세요. 상태는 /model-status로 볼 수 있어요.`}`,
  unknownWait: (c: boolean) => `작업이 끝났는지 확인하지 못해 새 모델 실행을 멈췄어요. 작업자에게 계속 확인하고 있어요. ${c
    ? `상태는 ${CLI}로 볼 수 있어요.` : '상태는 /model-status로 볼 수 있어요.'}`,
  staleRetry: (c: boolean, job: string) => c ? `이전 작업이 멈춘 걸 확인했어요(작업 ${job}). 다시 해 달라고 하면 다시 실행해요.`
    : `이전 작업이 멈춘 걸 확인했어요. /retry target:${job} 로 다시 실행할 수 있어요.`,
  interactionExpired: (c: boolean) => c ? '요청은 기록해 뒀는데 응답을 전하지 못했어요. 다시 보내기 전에 작업 목록을 보여 달라고 해서 처리 상태를 확인해 주세요.'
    : '요청은 기록해 뒀는데 응답을 전하지 못했어요(상호작용 만료·확인 실패). 다시 보내기 전에 이 대화에서 /list로 처리 상태를 확인해 주세요.',

  // 제어 결과(Store.control·reviewControl의 status)
  reviewControlDenied: '리뷰 작업은 owner가 알림 채널에서만 제어할 수 있어요.',
  reviewStatus: (c: boolean) => c ? '한도·인증 원인을 해결한 뒤 리뷰를 재개하거나 취소해 달라고 말해 주세요.'
    : '한도·인증 원인을 해결한 뒤 /review-resume target:<job-id>로 재개하고, 포기하려면 /review-cancel target:<job-id>를 써 주세요.',
  emergencyHeld: (c: boolean) => `비상 정지나 이전 멈춤이 아직 걸려 있어요. ${c ? `상태는 ${CLI}로 확인해 주세요.` : '/model-status로 확인해 주세요.'}`,
  queueFullResume: '대기열이 가득 찼어요. 필요 없는 작업을 취소한 뒤 재개해 주세요.',
  queueFullRetry: '대기열이 가득 찼어요. 필요 없는 작업을 취소한 뒤 다시 시도해 주세요.',
  reviewNotWaiting: (c: boolean) => `한도·인증으로 기다리는 리뷰 작업이 아니거나 재시도 한도에 닿았어요. ${c
    ? '리뷰 상태를 물어봐 주세요.' : '/review-status로 확인해 주세요.'}`,
  reviewResumed: '원인이 풀린 걸 기록하고 리뷰 작업을 재개했어요.',
  reviewUnknownCancel: '끝났는지 확인하지 못한 리뷰 작업은 취소로 풀지 않아요. 작업자에게 계속 확인하고, 확인되면 실패로 끝내요.',
  reviewNotCancellable: '취소할 리뷰 작업이 없거나 지금은 취소할 수 없는 상태예요.',
  reviewCancelRequested: '리뷰 작업 취소를 요청했어요. 실행 중이면 끝난 걸 확인한 뒤에 취소로 표시해요.',
  ownerMismatch: '이 대화를 시작한 사람만 제어할 수 있어요.',
  subscriptionPlace: '구독 제어는 작업을 시작한 스레드나 DM에서 해 주세요.',
  noJobs: '이 대화에는 작업이 없어요. 작업을 시작한 스레드에서 확인해 주세요.',
  laneUnknownNote: (c: boolean) => `끝났는지 확인하지 못한 작업이 있어 작업 레인이 닫혀 있어요. 작업자 프로세스가 0개인지 확인한 뒤 ${c
    ? `${CLI}로 해제해 주세요. ` : '/task-release target:<job-id>로 해제해 주세요. '}`,
  laneClosedNote: (_c: boolean, reason: string) => `작업 레인이 새 작업을 받지 않고 있어요(${laneReasonText(reason)}). `,
  modelStatus: (c: boolean) => c ? `한도·인증 원인을 해결한 뒤 재개와 비상 정지 해제는 ${CLI}로 해 주세요. 포기하려면 작업을 취소해 달라고 말해 주세요.`
    : '한도·인증 원인을 해결한 뒤 /resume-model target:<job-id>로 재개하고, 포기하려면 /cancel target:<job-id>를 써 주세요. 비상 정지나 이전 멈춤은 /resume-model target:emergency-stop으로 확인해 주세요.',
  executionPending: '실행 중이거나 끝났는지 확인하지 못한 작업이 있어요. 멈춘 걸 확인하기 전에는 재개할 수 없어요.',
  releaseUnknownNote: (c: boolean, jobs: string) => ` 대화와 리뷰는 다시 돌지만, 끝났는지 확인하지 못한 작업(${jobs}) 때문에 작업 레인은 닫힌 채예요. 작업자 프로세스가 0개인지 확인한 뒤 ${c
    ? `${CLI}로 해제해 주세요.` : '/task-release target:<job-id>로 해제해 주세요.'}`,
  releaseClosedNote: (_c: boolean, reason: string) => ` 작업 레인은 아직 새 작업을 받지 않아요(${laneReasonText(reason)}).`,
  emergencyReleased: '비상 정지를 풀었어요.',
  emergencyReleasedWaiting: '비상 정지를 풀었어요. 확인을 기다리던 작업은 그 대화에서 재개하거나 취소해 주세요.',
  subscriptionGap: '이 대화의 구독과 빠진 메시지 복구를 먼저 확인해 주세요.',
  jobNotWaiting: (c: boolean) => `이 대화에서 한도·인증으로 기다리는 작업이 아니거나 재시도 한도에 닿았어요. ${c
    ? '작업 목록을 보여 달라고 하거나 취소해 달라고 말해 주세요.' : '/list로 확인하거나 /cancel로 포기해 주세요.'}`,
  jobResumed: '원인이 풀린 걸 기록하고 작업을 재개했어요.',
  jobNotCancellable: '이 대화에 취소할 작업이 없거나 지금은 취소할 수 없는 상태예요.',
  cancelRequested: '취소를 요청했어요. 실행 중이면 끝난 걸 확인한 뒤에 취소로 표시해요.',
  retryPurged: '보존 기간(7일)이 지나 요청 원문을 지워서 다시 시도할 수 없어요. 같은 내용으로 새로 요청해 주세요.',
  retryRefused: '이 대화에 다시 시도할 작업이 없거나, 상태나 재시도 한도 때문에 다시 시도할 수 없어요.',
  retryAccepted: '실패가 확인된 작업을 다시 시도해요.',
  emergencyStopped: '새 모델 호출을 막고 실행 중인 작업에 취소를 요청했어요.',
  controlFailed: (_c: boolean, status: string) => `처리하지 못했어요. ${status}`,
  subscriptionResumed: '이 스레드의 후속 메시지를 다시 받아요.',
  subscriptionStopped: (c: boolean) => c ? '이 스레드의 후속 메시지를 그만 받아요. 다시 받게 하려면 구독을 다시 켜 주세요.'
    : '이 스레드의 후속 메시지를 그만 받아요. 다시 받으려면 /resume을 써 주세요.',

  // 작업 레인 닫힘(execution_lanes.closed_reason)
  laneClosedUnknown: (c: boolean) => `작업 레인이 닫혀 있어요. 끝났는지 확인하지 못한 작업이 있어서예요. 작업자 프로세스가 0개인지 확인한 뒤 ${c
    ? `${CLI}로 해제해 주세요.` : '/task-release target:<job-id>로 해제해 주세요.'} 대화와 리뷰는 계속돼요.`,
  laneClosedCleanup: '작업 레인이 닫혀 있어요. 끝난 작업의 세션 공간을 지웠는지 아직 확인하지 못했어요. 계속 다시 시도하고, 지워지면 저절로 열려요.',
  laneClosedRetention: (c: boolean) => `작업 레인이 닫혀 있어요. 보존 세션 8개가 다 찼어요. ${c
    ? `기다리는 작업의 질문에 답하거나 ${CLI}로 재개하거나, 작업을 취소해 달라고 하면 다시 열려요.`
    : '기다리는 작업을 /answer·/resume-model로 끝내거나 /task-cancel로 멈추면 다시 열려요.'}`,
  laneClosedOther: (_c: boolean, reason: string) => `작업 레인이 닫혀 있어요(${reason}).`,

  // 작업 접수·취소·해제(TaskCommands)
  projectNotAllowed: (_c: boolean, names: string) => `정책에 없는 프로젝트라 작업을 받지 않았어요.${names ? ` 받는 프로젝트: ${names}` : ''}`,
  intakeClosed: (_c: boolean, reasons: string) => `작업자가 지금 새 작업을 받지 않아서 작업을 받지 않았어요${reasons ? `(${reasons})` : ''}. 대화와 리뷰는 계속돼요.`,
  taskNotHere: (c: boolean) => c ? '이 대화에 취소할 작업이 없어요. 작업을 시작한 스레드에서 작업 목록을 보여 달라고 해 주세요.'
    : '이 대화에 취소할 작업이 없어요. 작업을 시작한 스레드에서 /list로 확인해 주세요.',
  releaseDone: (_c: boolean, job: string, status: string) => `작업 ${job} 해제를 마쳤어요. ${status}`,
  releaseFailed: (_c: boolean, job: string, status: string) => `작업 ${job} 해제에 실패했어요. ${status}`,
  releaseNotFound: '해제할 수 있는 작업을 찾지 못했어요.',
  releaseError: '해제를 확인하지 못했어요(일시 오류). 막힘은 그대로예요. 다시 시도해 주세요.',
  releaseStarted: '작업자 프로세스가 사라졌는지 확인할게요. 결과는 이 대화에 올릴게요.',

  // 작업 질문·답(TaskBridge)
  foreignSession: '다른 실행기의 세션을 가진 작업이에요. 그 실행기 쪽 경로로만 답하거나 해제할 수 있어요.',
  taskQuestion: '작업하다가 여쭤볼 게 생겼어요',
  codexQuestion: 'Codex 작업하다가 여쭤볼 게 생겼어요',
  // 작업 질문. 켜짐 판에서는 수신이 owner의 다음 말을 그 질문의 답으로 받는다(question-pick.ts).
  taskQuestionFooter: (c: boolean, id: string, expires: string) => c
    ? `기한: ${expires}. 이 스레드에서 답을 말해 주세요. 답으로 도구 실행을 승인하거나 권한을 바꿀 수는 없어요.`
    : `기한: ${expires}. 이 스레드에서 /answer question:${id} 로 답해 주세요. 답으로 도구 실행을 승인하거나 권한을 바꿀 수는 없어요.`,
  // 변경 질문. 켜짐 판은 선택지 버튼·"직접 답하기"와 함께 나가고, 수신이 owner의 다음 말을 저장 전에 봉인해 답 경로로 보낸다
  // (change-question.ts, question-pick.ts). 꺼짐 판은 그 경로가 없어 그냥 말한 답이 봉인·label 검사 없이 대화 기록에 들어가므로 /answer를 안내한다.
  changeQuestionFooter: (c: boolean, id: string, expires: string) => c
    ? `기한: ${expires}. 버튼을 누르거나, 이 스레드에서 답을 말해도 돼요. 답으로 도구 실행을 승인하거나 권한을 바꿀 수는 없어요.`
    : `기한: ${expires}. 이 스레드에서 /answer question:${id} 로 답해 주세요. 답으로 도구 실행을 승인하거나 권한을 바꿀 수는 없어요.`,
  answerInvalid: '답이 비었거나 너무 길어요.',
  questionMissing: '질문을 찾지 못했어요.',
  answerDuplicate: '이미 받은 답이에요.',
  questionClosed: '이미 답했거나 닫힌 질문이에요. 지금 열린 질문의 ID를 확인해 주세요.',
  questionExpired: '기한이 지난 질문이라 작업을 멈췄어요.',
  questionNotWaiting: '이 질문의 답을 기다리는 작업이 아니에요.',
  questionExpiredNotice: (_c: boolean, id: string) => `질문 ${id}의 답 기한이 지나 작업을 멈췄어요. 답 없이 진행하지 않아요. 필요하면 새 작업으로 다시 요청해 주세요.`,
  taskAnswerAccepted: '답을 받았어요. 같은 세션으로 이어서 할게요.',
  codexAnswerAccepted: '답을 받았어요. 같은 Codex 세션으로 이어서 할게요.',
  taskBlocked: (c: boolean, job: string) => `작업 ${job}의 프로세스가 끝났는지 확인하지 못해서, 다시 실행하지 않고 작업 레인의 새 접수를 닫았어요. 대화와 리뷰는 계속돼요. 작업자 프로세스가 0개인지 확인한 뒤 ${c
    ? `${CLI}로 해제해 주세요.` : `/task-release target:${job} 로 해제해 주세요.`}`,
  codexBlocked: (c: boolean, job: string) => `작업 ${job}의 Codex 프로세스가 끝났는지 확인하지 못해서, 다시 실행하지 않고 새 모델 실행을 막았어요. 작업자 프로세스가 0개인지 확인한 뒤 ${c
    ? `${CLI}로 해제해 주세요.` : `/codex-release target:${job} 로 해제해 주세요.`}`,

  // 모델 멈춤·완료·해제(ClaudeTaskBridge·CodexBridge). 한도·인증 안내는 말투만 바꾼다(자리 비움은 뒤 티켓).
  taskLimitPaused: (_c: boolean, job: string) => `모델 사용 한도가 차서 작업 ${job}의 실행이 멈췄어요. 같은 계정을 쓰는 대화와 리뷰도 함께 멈춰요.`,
  taskAuthPaused: (_c: boolean, job: string) => `작업 레인 인증이 만료돼 작업 ${job}의 실행이 멈췄어요. 대화와 리뷰는 계속돼요.`,
  codexLimitPaused: (_c: boolean, job: string) => `모델 사용 한도가 차서 작업 ${job}의 실행이 멈췄어요.`,
  codexAuthPaused: (_c: boolean, job: string) => `모델 인증이 만료돼 작업 ${job}의 실행이 멈췄어요.`,
  modelPauseResume: (c: boolean, job: string) => `다른 계정이나 인증으로 바꾸지 않아요. ${c
    ? `원인을 해결한 뒤 ${CLI}로 재개하거나, 작업을 취소해 달라고 말해 주세요.` : `원인을 해결한 뒤 /resume-model target:${job} 로 재개하거나 /cancel 해 주세요.`}`,
  modelPauseFinal: (c: boolean) => `다른 계정이나 인증으로 바꾸지 않아요. 재시도 한도에 닿아 재개할 수 없어요. ${c
    ? '작업을 취소하고 새로 요청해 주세요.' : '/cancel 뒤 새 작업으로 요청해 주세요.'}`,
  questionBlocked: (c: boolean, job: string, risk: string) => `작업 ${job}의 질문이 공개 검사에 걸려서(사유: ${risk}) 질문을 올리지 않고 작업을 멈췄어요. ${c
    ? '요청을 고쳐 새로 요청하거나, 다시 해 달라고 말해 주세요.' : `요청을 고쳐 새 작업으로 요청하거나 /retry target:${job} 로 다시 실행해 주세요.`}`,
  taskCompleted: (_c: boolean, job: string) => `작업을 마쳤어요 (작업 ${job})`,
  codexCompleted: (_c: boolean, job: string) => `Codex 작업을 마쳤어요 (작업 ${job})`,
  summaryBlocked: (_c: boolean, risk: string) => `요약이 공개 검사에 걸려서(사유: ${risk}) 올리지 않았어요. 작업을 마친 건 기록했어요.`,
  modelWaitLong: (c: boolean, job: string) => `작업 ${job}의 모델 대기가 24시간을 넘었어요. 저절로 재개하거나 버리지 않아요. 세션을 계속 보존할지 정해서 ${c
    ? `${CLI}로 재개하거나, 작업을 취소해 달라고 말해 주세요.` : `/resume-model target:${job} 또는 /cancel target:${job} 해 주세요.`}`,
  releaseNotUnknown: '끝났는지 확인하지 못한 작업이 아니에요.',
  releaseWorkerAlive: '작업자 프로세스가 남아 있거나 확인할 수 없어요. 작업자 파드를 다시 만든 뒤 확인해 주세요.',
  releaseStateChanged: (c: boolean) => c ? '상태가 바뀌었어요. 작업 목록을 보여 달라고 해서 확인해 주세요.' : '상태가 바뀌었어요. /list로 확인해 주세요.',
  releaseConfirmed: '작업자 프로세스가 0개인 걸 확인하고 막힘을 풀었어요. 작업은 다시 실행하지 않아요.',
});
