// CHANGE 부모와 자식 job의 실패 안내가 같은 복구 행동을 말하게 문구를 한 곳에 둔다. 동료 말투(해요체)로 쓴다.
// 자식 job은 /retry가 받지 않는다(Store.control retry가 change_child_jobs 행을 뺀다). 모델을 다시 부르는 길은 새 요청이나 새 generation뿐이다.
// 첫 인자 colleague는 동료 기능 스위치다. 켜지면 '/' 이름 대신 말로 하는 안내다. 말로는 새 generation을 열 수 없어(제안 동작에 없음)
// 켜짐 판은 같은 내용을 새 변경으로 다시 부탁하라고 한다.
export const changeRestart = (colleague: boolean) => colleague
  ? '자동으로 다시 시작하지 않아요. 필요하면 이 스레드에서 다시 부탁해 주세요.'
  : '자동으로 다시 시작하지 않아요. 필요하면 새 /change로 요청해 주세요.';
export const changeNextGeneration = (colleague: boolean, changeId: string) => colleague
  ? '자동으로 다시 시작하지 않아요. 필요하면 같은 내용을 이 스레드에서 다시 부탁해 주세요(새 변경으로 받아요).'
  : `자동으로 다시 시작하지 않아요. 필요하면 /change project:${changeId} text:next 로 새 generation을 열어 주세요.`;
// 자식이 실패하면 부모는 failed나 blocked로 닫힌다. 두 경우 모두 부모 안내의 꼬리는 changeRestart다.
// 함정: colleague 기본값은 꺼짐 판이다. 부르는 쪽(Store)이 스위치 값을 넘겨야 켜짐 판이 나간다.
export const changeChildFailed = (jobId: string, changeId: string, colleague = false) => `작업 ${jobId}이 실패했어요. 이 작업은 변경 ${changeId}의 일부라 따로 다시 실행하지 않아요. ${colleague
  ? '변경 상태는 물어보면 알려 드릴게요.' : `/change-status target:${changeId}로 상태를 확인해 주세요.`} ${changeRestart(colleague)}`;
