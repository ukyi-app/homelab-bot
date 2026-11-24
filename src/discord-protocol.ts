import { z } from 'zod';
import { Denied, DiscordRejected, DiscordUnauthorized, RateLimited } from './contracts.js';
import type { Clock, EventInput } from './contracts.js';
import { gatewayMessage, hasMarker } from './discord.js';
import type { AckOutcome, DiscordRest } from './discord.js';
import { PROPOSAL_BUTTONS } from './proposals.js';
import { QUESTION_PICK_BUTTON } from './question-pick.js';
import { PUBLISH_BUTTON } from './change-commands.js';
import { SESSION_KEY_BUTTON } from './external-task-commands.js';
import { CHANGE_CHOICE_BUTTON, CHANGE_DIRECT_BUTTON } from './change-question.js';

// 기한 없는 REST(게시·대조·history 복구·명령 등록·gateway URL·typing)의 전송 제한. 1초 일괄 제한은 재시작 직후
// 복구 GET을 시간 초과로 실패시킨다(S16). 이 호출들은 게시 lease·복구 lease(각 30초)나 별도 루프 안에서 돌아 몇 초를 기다려도
// 계약이 깨지지 않는다. 늘리면 한 요청이 막혔을 때 그 루프의 한 바퀴만 길어진다.
export const DISCORD_REST_TIMEOUT_MS = 5000;
// Gateway dispatch 안에서 부르는 REST(이벤트의 채널 조회, 일반 메시지 👀 리액션과 그 대체 게시)의 제한.
// dispatch는 이벤트를 하나씩 처리하므로 여기서 오래 기다리면 뒤에 밀린 상호작용이 3초 첫 응답 기한을 놓친다.
// 실패해도 메시지는 history gap 장벽으로 메우고, 상호작용은 저장 전이라 사용자가 실패를 본다.
export const DISCORD_DISPATCH_REST_TIMEOUT_MS = 1000;
// expiresAt: 상호작용 callback의 절대 기한. 남은 시간 전체가 제한이다(상한 없음, 기한 자체가 상한).
// timeoutMs: 기한 없는 요청의 짧은 제한. 둘 다 없으면 DISCORD_REST_TIMEOUT_MS.
export interface DiscordRequestOptions { expiresAt?: number; timeoutMs?: number }
export interface DiscordApi {
  request(method: 'GET' | 'POST' | 'PUT' | 'DELETE', path: string, body?: unknown, options?: DiscordRequestOptions): Promise<unknown>;
}
const ChannelSchema = z.object({ id: z.string(), type: z.number(), parent_id: z.string().nullable().optional(), guild_id: z.string().optional() });
const MessageSchema = z.object({ id: z.string(), channel_id: z.string(), guild_id: z.string().optional(),
  author: z.object({ id: z.string(), bot: z.boolean().optional() }), webhook_id: z.string().optional(),
  content: z.string().optional(), mentions: z.array(z.object({ id: z.string() })).optional(),
  // 답장 참조는 ID와 작성자만 읽는다. 본문은 Discord가 준 사본이 아니라 outbox의 게시 확정 본문을 쓴다(ARCHITECTURE §13).
  referenced_message: z.object({ id: z.string(), author: z.object({ id: z.string() }) }).nullable().optional(),
  // 관리자 요청인지 가르는 칸(requestFrame). 값은 읽기만 하고 본문 사본(message_snapshots의 message)은 쓰지 않는다.
  type: z.number().optional(), message_reference: z.object({ type: z.number().optional() }).nullable().optional(),
  message_snapshots: z.array(z.unknown()).nullable().optional() });
// Discord 메시지 종류 DEFAULT 0·REPLY 19만 사람이 쓴 글이다. 고정·스레드 생성·스레드 시작 글 같은 시스템 글은 요청이 아니다.
const REQUEST_TYPES: ReadonlySet<number> = new Set([0, 19]);
// 메시지 참조 종류 FORWARD(1). 전달은 다른 글을 그 시점 사본(message_snapshots)으로 싣는다. type이 없으면 DEFAULT(0, 답장)다.
// 근거: Discord 문서 Message Resource의 Message Reference Types·Message Snapshot Object.
const FORWARD_REFERENCE = 1;
// 사람이 직접 쓴 글만 관리자 요청 후보다. 전달 글은 쓴 사람이 관리자여도 남의 글을 옮긴 자료라 요청으로 보지 않는다.
// 다른 사람 글에 단 답장(참조 type 0)은 요청이다.
export function requestFrame(frame: Pick<z.infer<typeof MessageSchema>, 'type' | 'message_reference' | 'message_snapshots'>): boolean {
  if (frame.type !== undefined && !REQUEST_TYPES.has(frame.type)) return false;
  if (frame.message_reference?.type === FORWARD_REFERENCE) return false;
  return !frame.message_snapshots?.length;
}
const IdSchema = z.object({ id: z.string() });
const SourceSchema = z.object({ id: z.string(), thread: z.object({ id: z.string() }).nullable().optional() });
// 버튼 custom_id 허용 목록. custom_id는 `이름` 또는 `이름:대상`이고 parts는 ':'로 나눈 칸 수다(정확히 그 수만 받는다).
// route는 수신(DiscordIngress.receive)의 처리 분기다: control은 '/' 제어와 같은 경로, proposal은 실행 확인(src/proposals.ts),
// publish는 변경 게시 승인(src/change-commands.ts, '/change-publish'와 같은 승인 경로),
// session-key는 세션 연결 "키 보기"(src/external-task-commands.ts), change-question은 변경 질문의 선택지·"직접 답하기"(src/change-question.ts).
// 뒤 티켓은 줄만 더한다. 게시자도 이 표로 보낼 버튼을 대조한다. Discord custom_id 상한은 100자다.
export const BUTTONS = Object.freeze([
  { name: 'list', parts: 1, route: 'control' },
  { name: 'stop', parts: 1, route: 'control' },
  { name: 'resume', parts: 1, route: 'control' },
  { name: 'cancel', parts: 2, route: 'control' },
  { name: PROPOSAL_BUTTONS.yes, parts: 2, route: 'proposal' },
  { name: PROPOSAL_BUTTONS.no, parts: 2, route: 'proposal' },
  { name: QUESTION_PICK_BUTTON, parts: 2, route: 'question' },
  { name: PUBLISH_BUTTON, parts: 2, route: 'publish' },
  { name: SESSION_KEY_BUTTON, parts: 2, route: 'session-key' },
  { name: CHANGE_CHOICE_BUTTON, parts: 2, route: 'change-question' },
  { name: CHANGE_DIRECT_BUTTON, parts: 2, route: 'change-question' },
] as const);
export type ButtonRoute = typeof BUTTONS[number]['route'];
export const CUSTOM_ID_MAX = 100;
// 표에 있는 버튼이면 그 줄과 나눈 칸을 돌려준다. 빈 칸·상한 초과·칸 수 불일치는 받지 않는다.
export function parseButton(customId: string | undefined): { route: ButtonRoute; parts: string[] } | undefined {
  if (customId === undefined || customId.length > CUSTOM_ID_MAX) return;
  const parts = customId.split(':');
  const row = BUTTONS.find(button => button.name === parts[0]);
  if (!row || parts.length !== row.parts || parts.some(value => !value)) return;
  return { route: row.route, parts };
}
export const buttonAllowed = (customId: string) => parseButton(customId) !== undefined;
export const buttonRoute = (name: string | undefined): ButtonRoute | undefined => BUTTONS.find(button => button.name === name)?.route;
const part = encodeURIComponent;
const ownReaction = (channel: string, message: string, emoji: string) =>
  `/channels/${part(channel)}/messages/${part(message)}/reactions/${part(emoji)}/@me`;
const RECEIVED = '👀';
const DISPATCH = { timeoutMs: DISCORD_DISPATCH_REST_TIMEOUT_MS };
export class DiscordProtocol implements DiscordRest {
  constructor(private readonly api: DiscordApi, private readonly botId: string, private readonly now: Clock = Date.now) {}
  private async channel(id: string, options?: DiscordRequestOptions) {
    const c = ChannelSchema.parse(await this.api.request('GET', `/channels/${part(id)}`, undefined, options));
    if (c.id !== id) throw new Denied();
    return { type: c.type, parent_id: c.parent_id ?? undefined, guild_id: c.guild_id };
  }
  // 현관의 Discord 수신. 메시지만 받고 '/' 명령·버튼 상호작용(INTERACTION_CREATE)은 받지 않는다(D-02, F-7).
  // 상호작용은 내용·토큰을 읽기 전에 닫아 어느 처리기에도 닿지 않고 응답(callback)도 나가지 않는다.
  async gateway(type: 'MESSAGE_CREATE' | 'INTERACTION_CREATE', raw: unknown, intake: { receive(input: EventInput): Promise<unknown> }): Promise<void> {
    if (type !== 'MESSAGE_CREATE') throw new Denied();
    const frame = MessageSchema.parse(raw);
    if (frame.author.bot || frame.webhook_id || !requestFrame(frame)) return;
    await intake.receive(await gatewayMessage(frame, this.botId, id => this.channel(id, DISPATCH)));
  }
  async acknowledge(event: EventInput, content: string, options: Parameters<DiscordRest['acknowledge']>[2]): Promise<AckOutcome | void> {
    // 상호작용 응답 경로는 없다. 상호작용을 받지 않으므로 답할 토큰도 없다.
    if (event.kind !== 'message') throw new Denied();
    // 일반 메시지는 원문에 👀만 단다. 텍스트 ACK는 대화를 덮는다. 같은 봇·메시지·emoji의 PUT은 다시 해도 하나다.
    try {
      await this.api.request('PUT', ownReaction(event.scope.channel, event.id, RECEIVED), undefined, DISPATCH);
      return;
    } catch (error) {
      // 403/404는 채널에 Add Reactions·Read Message History가 없거나 원문이 지워진 경우다. 수신 신호가 아예 없지 않게
      // 기존 텍스트 ACK로 한 번만 대체한다. 429·일시 오류는 그대로 던져 호출자가 rate limit을 기록하게 한다.
      if (!(error instanceof DiscordRejected) || error.status === 400) throw error;
      await this.api.request('POST', `/channels/${part(event.scope.channel)}/messages`,
        { content, nonce: event.id, enforce_nonce: true, ...options }, DISPATCH);
      return { fallback: error.status };
    }
  }
  // 반응 상태 동기화(게시 루프)에서 부른다. dispatch 밖이라 기본 제한이다. 같은 봇·메시지·emoji의 PUT·DELETE는 다시 해도 결과가 같다.
  async addReaction(channel: string, message: string, emoji: string): Promise<void> {
    await this.api.request('PUT', ownReaction(channel, message, emoji));
  }
  // 경로가 늘 @me라 다른 사람의 반응은 지울 수 없다. 남의 반응을 지우는 경로(.../reactions/{emoji}/{user})는 두지 않는다.
  async removeOwnReaction(channel: string, message: string, emoji: string): Promise<void> {
    await this.api.request('DELETE', ownReaction(channel, message, emoji));
  }
  // 메시지에서 연 스레드의 ID는 그 메시지 ID와 같고, 한 메시지에는 스레드를 하나만 열 수 있다
  // (Discord 문서 "Start Thread from Message", ARCHITECTURE §11 확인 기록). 이 경로의 본문에는 type이 없다.
  async createThread(channel: string, body: Parameters<DiscordRest['createThread']>[1], from?: string) {
    if (from === undefined) return IdSchema.parse(await this.api.request('POST', `/channels/${part(channel)}/threads`, body));
    return IdSchema.parse(await this.api.request('POST', `/channels/${part(channel)}/messages/${part(from)}/threads`,
      { name: body.name, auto_archive_duration: body.auto_archive_duration }));
  }
  async sendMessage(channel: string, body: Parameters<DiscordRest['sendMessage']>[1]) {
    return IdSchema.parse(await this.api.request('POST', `/channels/${part(channel)}/messages`, body));
  }
  async findDelivery(channel: string, marker: string, kind: 'message' | 'thread', from?: string): Promise<{ id: string } | undefined> {
    // 메시지에서 여는 스레드는 그 메시지에 이미 스레드가 달렸는지(message.thread)로 대조한다. 원문이 지워졌으면 404가 그대로 올라간다.
    if (kind === 'thread' && from !== undefined) {
      const message = SourceSchema.parse(await this.api.request('GET', `/channels/${part(channel)}/messages/${part(from)}`));
      return message.id === from && message.thread ? { id: message.thread.id } : undefined;
    }
    if (kind === 'thread') {
      const c = await this.channel(channel);
      if (!c.guild_id) throw new Denied();
      const threads = z.object({ threads: z.array(z.object({ id: z.string(), parent_id: z.string(), name: z.string() })) });
      const active = threads.parse(await this.api.request('GET', `/guilds/${part(c.guild_id)}/threads/active`));
      const archived = threads.parse(await this.api.request('GET', `/channels/${part(channel)}/threads/archived/public?limit=100`));
      return [...active.threads, ...archived.threads].find(t => t.parent_id === channel && t.name === `homelab-${marker}`);
    }
    let before = '';
    for (let page = 0; page < 10; page++) {
      const messages = z.array(MessageSchema).parse(await this.api.request('GET', `/channels/${part(channel)}/messages?limit=100${before ? `&before=${part(before)}` : ''}`));
      const found = messages.find(m => m.author.id === this.botId && m.content !== undefined && hasMarker(m.content, marker));
      if (found) return found;
      if (messages.length < 100) return;
      before = messages[messages.length - 1]!.id;
    }
  }
  async history(channel: string, after: string | null, limit: 100): Promise<EventInput[]> {
    const metadata = await this.channel(channel);
    // after selects the nearest newer page; omit it and Discord selects the latest page instead.
    const messages = z.array(MessageSchema).parse(await this.api.request('GET', `/channels/${part(channel)}/messages?limit=${limit}&after=${part(after ?? '0')}`));
    return Promise.all(messages.map(m => gatewayMessage({ ...m, guild_id: metadata.guild_id }, this.botId, async () => metadata)));
  }
}

export function discordHttpApi(token: string, send: typeof fetch, now: Clock = Date.now): DiscordApi {
  let halted = false;
  return { async request(method, path, body, options) {
    if (halted) throw new DiscordUnauthorized();
    if (!path.startsWith('/') || path.includes('..')) throw new Denied();
    let limit = options?.timeoutMs ?? DISCORD_REST_TIMEOUT_MS;
    if (options?.expiresAt !== undefined) {
      limit = Math.floor(options.expiresAt - now());
      if (limit <= 0) throw new Error('interaction_expired');
    }
    const response = await send(`https://discord.com/api/v10${path}`, { method, redirect: 'error',
      headers: { authorization: `Bot ${token}`, 'content-type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(limit) });
    if (response.status === 401) { halted = true; throw new DiscordUnauthorized(); }
    if (response.status === 429) {
      const error = z.object({ retry_after: z.number().finite().nonnegative(), global: z.boolean().optional() }).parse(await response.json());
      throw new RateLimited(Math.ceil(error.retry_after * 1000), error.global === true, response.headers.get('x-ratelimit-bucket') ?? undefined);
    }
    if (response.status === 400 || response.status === 403 || response.status === 404) throw new DiscordRejected(response.status);
    if (!response.ok) throw new Error('discord_request_failed');
    return response.status === 204 ? undefined : response.json();
  } };
}
