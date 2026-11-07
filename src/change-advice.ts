// CHANGE 부모와 자식 job의 실패 안내가 같은 복구 행동을 말하게 문구를 한 곳에 둔다.
// 자식 job은 /retry가 받지 않는다(Store.control retry가 change_child_jobs 행을 뺀다). 모델을 다시 부르는 길은 새 요청이나 새 generation뿐이다.
export const CHANGE_RESTART = '자동으로 다시 시작하지 않습니다. 필요하면 새 /change로 요청하세요.';
export const changeNextGeneration = (changeId: string) =>
  `자동으로 다시 시작하지 않습니다. 필요하면 /change project:${changeId} text:next 로 새 generation을 여세요.`;
// 자식이 실패하면 부모는 failed나 blocked로 닫힌다. 두 경우 모두 부모 안내의 꼬리는 CHANGE_RESTART다.
export const changeChildFailed = (jobId: string, changeId: string) =>
  `작업 ${jobId} 실패가 확인됐습니다. 이 작업은 변경 ${changeId}의 일부라 따로 다시 실행하지 않습니다. /change-status target:${changeId}로 상태를 확인하세요. ${CHANGE_RESTART}`;
