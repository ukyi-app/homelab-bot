import { Denied } from './contracts.js';
import type { EventInput } from './contracts.js';
import type { PolicyGate } from './policy.js';
import type { Store } from './store.js';

// 현관의 말 입구. Discord 메시지 하나를 검사해 관리자 요청인지 가르고, 지금은 고정 안내 한 줄로만 답한다.
// 옛 작업 큐·모델 레인(DiscordIngress → store.accept)으로 넘기지 않는다. 감독으로 넘길 길(v2 연결)이 생기면
// unavailable 자리에서 넘긴다. 원문을 events에 남기지 않아 보존 정리가 맡을 원문도 생기지 않는다.

// discord.md §1·§9의 고정 안내 꼴(해요체 한 문장). 모델을 거치지 않는다.
export const FRONT_TEXT = Object.freeze({
  adminOnly: '그건 `homelab` CLI에서 해 주세요.',
  unavailable: '지금은 부탁을 받을 수 없어요.',
});

// Discord에서 받지 않는 관리 요청(D-09·D-21·D-28): 비상 정지 걸기·풀기, 계정 전환·등록·삭제, 권한 변경, 자동 진단 끄기.
// 명시어 뒤에 동작 낱말이 올 때만 맞는다("비상 정지 상태 알려줘"는 아니다). 놓친 말도 모델로 가지 않고 관리 효과는 CLI에만 있어서,
// 넓게 잡아 오탐을 늘리기보다 명시어만 본다. "멈춰"·"아니"는 비상 정지가 아니라 진행 중인 그 요청의 취소라 넣지 않는다(discord.md §2).
export const ADMIN_REQUESTS = Object.freeze([
  { action: 'emergency_stop', pattern: /비상\s*정지\s*(?:를|을)?\s*(?:걸|켜|해|시작|풀|꺼|끄|끝|멈)/ },
  { action: 'account', pattern: /계정\s*(?:을|를|으로)?\s*(?:전환|바꾸|바꿔|변경|교체|등록|추가|삭제|지우|지워|제거)/ },
  { action: 'permission', pattern: /권한\s*(?:을|를)?\s*(?:변경|바꾸|바꿔|부여|주|줘|올리|올려|빼|회수|추가|삭제|제거|풀)/ },
  { action: 'auto_diagnosis_off', pattern: /자동\s*진단\s*(?:을|를|은|는)?\s*(?:꺼|끄|끔|중지|멈추|멈춰|비활성)/ },
] as const);
export type AdminAction = typeof ADMIN_REQUESTS[number]['action'];
export const adminRequest = (request: string): AdminAction | undefined => ADMIN_REQUESTS.find(row => row.pattern.test(request))?.action;

// Discord 인용: 줄 머리의 `>`는 그 줄만, `>>>`는 그 줄부터 글 끝까지를 인용으로 만든다. 인용은 관리자가 옮겨 온 자료이고
// 요청이 아니다. 요청은 인용 밖 글만이다. 띄어쓰기 없는 `>`(Discord가 인용으로 그리지 않음)도 인용으로 본다:
// 자료로 내리는 쪽은 권한을 줄이기만 한다.
export function splitQuotes(text: string): { request: string; quoted: string[] } {
  const request: string[] = [];
  const quoted: string[] = [];
  let block = false;
  for (const line of text.split('\n')) {
    const marker = /^\s*(>>>|>)\s?(.*)$/.exec(line);
    if (marker?.[1] === '>>>') block = true;
    if (block || marker) quoted.push(marker ? marker[2]! : line);
    else request.push(line);
  }
  return { request: request.join('\n').trim(), quoted };
}
// 봇 자신을 부른 멘션 표기(<@ID>, <@!ID>)는 요청 글이 아니다.
const withoutMention = (text: string, bot?: string) => bot ? text.replaceAll(`<@${bot}>`, '').replaceAll(`<@!${bot}>`, '') : text;

export type FrontOutcome =
  | { outcome: 'ignored' }
  | { outcome: 'admin_refused'; action: AdminAction; request: string; quoted: string[] }
  | { outcome: 'unavailable'; request: string; quoted: string[] };

export class FrontIntake {
  constructor(private readonly store: Store, private readonly gate: PolicyGate) {}
  // 거부(관리자·서버·채널·대화 소유자 불일치)는 Denied로 던진다. 부르지 않은 글은 ignored로 끝내고 답하지 않는다.
  async receive(input: EventInput): Promise<FrontOutcome> {
    // 프로토콜이 상호작용을 이미 닫지만, 다른 호출자가 명령·버튼 모양을 넘겨도 처리기에 닿지 않게 여기서도 닫는다.
    if (input.kind !== 'message') throw new Denied();
    // bot·webhook 글은 관리자 요청이 아니다. 전달 글은 프로토콜(requestFrame)이 프레임에서 거른다.
    if (input.bot || input.webhook) return { outcome: 'ignored' };
    // 관리자·서버·허용 채널(대화·알림 채널과 그 스레드)·거부 목록. 이 검사를 지나기 전에는 글을 읽지 않는다.
    const policy = await this.gate.authorize(input.actor, input.scope);
    const conversation = input.scope.kind === 'channel' ? undefined : await this.store.conversation(input.scope);
    // 대화 소유자: 다른 사람이 맡긴 대화 스레드의 글은 받지 않는다.
    if (conversation && conversation.owner_id !== input.actor) throw new Denied();
    // 부른 글만 받는다. 채널에서는 멘션, 스레드·DM에서는 멘션이나 올리브가 맡고 있는 대화(활성 구독)의 글.
    if (!input.mention && (input.scope.kind === 'channel' || !conversation?.active)) return { outcome: 'ignored' };
    const { request, quoted } = splitQuotes(withoutMention(input.text, input.botUser));
    const action = adminRequest(request);
    await this.store.enqueue({ key: `front:${input.id}`, actor: input.actor, scope: input.scope, revision: policy.revision,
      payload: { kind: 'message', channel: input.scope.channel, content: action ? FRONT_TEXT.adminOnly : FRONT_TEXT.unavailable,
        classification: 'safe_summary', replyTo: input.id } });
    return action ? { outcome: 'admin_refused', action, request, quoted } : { outcome: 'unavailable', request, quoted };
  }
}
