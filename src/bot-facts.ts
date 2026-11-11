import { SERVICES, TEMPLATES } from './catalog.js';
import { COMMAND_DEFINITIONS } from './commands.js';

// 작업자 프롬프트의 신뢰 문맥. 코드에 고정된 공개 값(봇 slash 명령, 서비스 카탈로그)만 쓴다. 대화 기록(untrusted)에서
// 만들지 않는다. 이 문맥이 없으면 모델이 /revoke를 "플랫폼 관리 콘솔 명령"으로, namespace를 서비스 ID로 짐작해 틀린다(S16).
// 작업자 이미지에 들어가므로 바뀐 내용은 작업자를 다시 배포해야 모델에 닿는다.
// surface는 게시 서버가 고른다(C01 스위치가 켜지면 speech). speech에는 '/' 명령 이름을 한 글자도 넣지 않는다:
// 모델이 그 이름을 owner에게 안내하면 스위치를 켠 뜻이 깨진다(명세 §4.1, AC-11).
const usage = (definition: typeof COMMAND_DEFINITIONS[number]) => {
  const options = definition.options.map(option => `${option.name}:<${option.description}>`);
  return `/${[definition.name, ...options].join(' ')}: ${definition.description}`;
};

export const EARLIER_PURGED_NOTE = '- 이 대화의 앞부분 일부는 원문 보존 기간(7일)이 지나 지워져 기록에 없다. 그 부분을 물으면 아는 척하지 말고 기억나지 않는다고 말한다.';

const SPEECH_ACTIONS = [
  '- owner는 명령 없이 말로 부탁한다. 할 수 있는 일은 아래뿐이고, 모두 제안으로만 낸다(제안만 하고 실행되지 않는다):',
  '  읽기 요청(확인 없이 결과를 보여 준다): 이 대화의 작업 목록, 작업·변경·리뷰 상태, 승인된 읽기 템플릿 조회, 기억 검색, 세션 연결 목록',
  '  실행 요청(owner가 확인 버튼을 눌러야 실행된다): 작업 시작·취소, 실패한 작업 다시 시도, 기억 저장·정정·제외·삭제, '
    + '세션 연결·해제, 변경 PR 요청·취소, 리뷰 재개·취소, '
    + '변경 PR 수정(PR 리뷰·댓글을 반영해 이미 올린 변경 PR을 고친다. 대상은 이 스레드에서 낸 변경의 ID나 PR 번호)',
  '  확인 없이 바로 시작하는 요청: PR 리뷰 요청. 대상은 owner 메시지에 적힌 PR 링크나 <소유자>/<저장소>#<번호>이고, 그 메시지에 PR이 없으면 리뷰 요청을 내지 않는다',
  '- 비상 정지·해제, 사용자 차단, 모델 상태 보기 같은 관리 기능은 owner가 Discord 밖 관리 CLI로 한다. 말로 받지 않는다.',
];

export function botFacts(surface: 'slash' | 'speech' = 'slash', earlierPurged = false): string {
  const read = surface === 'slash' ? '/read 질의 템플릿' : '읽기 템플릿';
  const services = SERVICES.map(service => {
    const templates = TEMPLATES.filter(template => template.service === service.id).map(template => template.id);
    return `- ${service.id}: namespace ${service.namespace}, deployment ${service.deployment}`
      + (templates.length ? `, ${read} ${templates.join(', ')}` : '');
  });
  return ['봇 정보(신뢰, 코드 고정값):',
    '- 이 대화는 owner와 이 봇의 대화다. 봇이 구독한 스레드에서는 owner가 멘션 없이 보낸 후속 메시지도 봇에게 한 말이다.',
    '  대화 기록의 owner 메시지는 모두 봇이 받아들여 답하기로 한 요청이다. 멘션하라고 요구하지 않는다.',
    ...(surface === 'slash' ? [
      '- 아래는 이 봇 자신의 Discord slash 명령이다. owner가 Discord에서 직접 실행한다(다른 플랫폼 콘솔 명령이 아니다).',
      ...COMMAND_DEFINITIONS.map(definition => `  ${usage(definition)}`),
    ] : SPEECH_ACTIONS),
    '- 등록된 서비스(공개 값). Kubernetes namespace·deployment 이름은 이 값을 쓴다:',
    ...services,
    ...(earlierPurged ? [EARLIER_PURGED_NOTE] : [])].join('\n');
}
