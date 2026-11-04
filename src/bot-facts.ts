import { SERVICES, TEMPLATES } from './catalog.js';
import { COMMAND_DEFINITIONS } from './commands.js';

// 작업자 프롬프트의 신뢰 문맥. 코드에 고정된 공개 값(봇 slash 명령, 서비스 카탈로그)만 쓴다. 대화 기록(untrusted)에서
// 만들지 않는다. 이 문맥이 없으면 모델이 /revoke를 "플랫폼 관리 콘솔 명령"으로, namespace를 서비스 ID로 짐작해 틀린다(S16).
// 작업자 이미지에 들어가므로 바뀐 내용은 작업자를 다시 배포해야 모델에 닿는다.
const usage = (definition: typeof COMMAND_DEFINITIONS[number]) => {
  const options = definition.options.map(option => `${option.name}:<${option.description}>`);
  return `/${[definition.name, ...options].join(' ')}: ${definition.description}`;
};

export function botFacts(): string {
  const services = SERVICES.map(service => {
    const templates = TEMPLATES.filter(template => template.service === service.id).map(template => template.id);
    return `- ${service.id}: namespace ${service.namespace}, deployment ${service.deployment}`
      + (templates.length ? `, /read 질의 템플릿 ${templates.join(', ')}` : '');
  });
  return ['봇 정보(신뢰, 코드 고정값):',
    '- 이 대화는 owner와 이 봇의 대화다. 봇이 구독한 스레드에서는 owner가 멘션 없이 보낸 후속 메시지도 봇에게 한 말이다.',
    '  대화 기록의 owner 메시지는 모두 봇이 받아들여 답하기로 한 요청이다. 멘션하라고 요구하지 않는다.',
    '- 아래는 이 봇 자신의 Discord slash 명령이다. owner가 Discord에서 직접 실행한다(다른 플랫폼 콘솔 명령이 아니다).',
    ...COMMAND_DEFINITIONS.map(definition => `  ${usage(definition)}`),
    '- 등록된 서비스(공개 값). Kubernetes namespace·deployment 이름은 이 값을 쓴다:',
    ...services].join('\n');
}
