import { z } from 'zod';
import { Denied, DiscordRejected, DiscordUnauthorized, RateLimited } from './contracts.js';
import type { Clock, EventInput } from './contracts.js';
import { gatewayMessage, hasMarker } from './discord.js';
import type { AckOutcome, DiscordIngress, DiscordRest, GatewayFrame } from './discord.js';
import { PROPOSAL_BUTTONS } from './proposals.js';

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
  referenced_message: z.object({ id: z.string(), author: z.object({ id: z.string() }) }).nullable().optional() });
const IdSchema = z.object({ id: z.string() });
const SourceSchema = z.object({ id: z.string(), thread: z.object({ id: z.string() }).nullable().optional() });
const InteractionSchema = z.object({ id: z.string(), token: z.string(), type: z.union([z.literal(2), z.literal(3)]),
  channel_id: z.string(), guild_id: z.string().optional(),
  user: z.object({ id: z.string() }).optional(), member: z.object({ user: z.object({ id: z.string() }) }).optional(),
  data: z.object({ name: z.string().optional(), custom_id: z.string().optional(),
    options: z.array(z.object({ name: z.string(), value: z.string() })).optional() }),
});
// 버튼 custom_id 허용 목록. custom_id는 `이름` 또는 `이름:대상`이고 parts는 ':'로 나눈 칸 수다(정확히 그 수만 받는다).
// route는 수신(DiscordIngress.receive)의 처리 분기다: control은 '/' 제어와 같은 경로, proposal은 실행 확인(src/proposals.ts).
// 뒤 티켓은 줄만 더한다. 게시자도 이 표로 보낼 버튼을 대조한다. Discord custom_id 상한은 100자다.
export const BUTTONS = Object.freeze([
  { name: 'list', parts: 1, route: 'control' },
  { name: 'stop', parts: 1, route: 'control' },
  { name: 'resume', parts: 1, route: 'control' },
  { name: 'cancel', parts: 2, route: 'control' },
  { name: PROPOSAL_BUTTONS.yes, parts: 2, route: 'proposal' },
  { name: PROPOSAL_BUTTONS.no, parts: 2, route: 'proposal' },
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
  private readonly interactions = new Map<string, { token: string; expires: number }>();
  constructor(private readonly api: DiscordApi, private readonly botId: string, private readonly now: Clock = Date.now) {}
  private async channel(id: string, options?: DiscordRequestOptions) {
    const c = ChannelSchema.parse(await this.api.request('GET', `/channels/${part(id)}`, undefined, options));
    if (c.id !== id) throw new Denied();
    return { type: c.type, parent_id: c.parent_id ?? undefined, guild_id: c.guild_id };
  }
  async gateway(type: 'MESSAGE_CREATE' | 'INTERACTION_CREATE', raw: unknown, ingress: Pick<DiscordIngress, 'receive'>): Promise<void> {
    const receivedAt = this.now();
    if (type === 'MESSAGE_CREATE') {
      const frame = MessageSchema.parse(raw);
      if (frame.author.bot || frame.webhook_id) return;
      await ingress.receive(await gatewayMessage(frame, this.botId, id => this.channel(id, DISPATCH)));
      return;
    }
    const interaction = InteractionSchema.parse(raw);
    const actor = interaction.member?.user.id ?? interaction.user?.id;
    if (!actor) throw new Denied();
    const frame: GatewayFrame = { id: interaction.id, channel_id: interaction.channel_id,
      guild_id: interaction.guild_id, author: { id: actor } };
    const normalized = await gatewayMessage(frame, this.botId, id => this.channel(id, DISPATCH));
    const options = new Map(interaction.data.options?.map(o => [o.name, o.value]));
    const button = interaction.type === 3 ? parseButton(interaction.data.custom_id) : undefined;
    if (interaction.type === 3 && !button) throw new Denied();
    const custom = button?.parts;
    const input: EventInput = { ...normalized, kind: interaction.type === 2 ? 'command' : 'button',
      command: interaction.type === 2 ? interaction.data.name : custom![0],
      urgent: interaction.type === 2 && interaction.data.name === 'urgent',
      text: options.get('text') ?? '', target: options.get('target') ?? options.get('project') ?? options.get('question') ?? custom?.[1] };
    this.interactions.set(input.id, { token: interaction.token, expires: receivedAt + 2500 });
    try { await ingress.receive(input); } finally { this.interactions.delete(input.id); }
  }
  async acknowledge(event: EventInput, content: string, options: Parameters<DiscordRest['acknowledge']>[2]): Promise<AckOutcome | void> {
    if (event.kind !== 'message') {
      const interaction = this.interactions.get(event.id);
      if (!interaction || this.now() >= interaction.expires) throw new Error('interaction_expired');
      const { update, ...rest } = options;
      // update는 버튼이 달린 글 자체를 바꾸고 버튼을 없앤다(UPDATE_MESSAGE 7). 글은 공개 그대로라 EPHEMERAL을 붙이지 않는다.
      const body = update && event.kind === 'button' ? { type: 7, data: { content, allowed_mentions: rest.allowed_mentions, components: [] } }
        // 그 밖의 상호작용 응답은 늘 본인만 보는 메시지(EPHEMERAL 64)다. 호출자가 준 플래그(미리보기 끄기)는 더하기만 한다.
        : { type: 4, data: { content, ...rest, flags: 64 | (rest.flags ?? 0) } };
      await this.api.request('POST', `/interactions/${part(event.id)}/${part(interaction.token)}/callback`, body, { expiresAt: interaction.expires });
      return;
    }
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
