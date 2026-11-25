import { z } from 'zod';
import { Denied } from '../src/contracts.js';
import type { Clock, EventInput } from '../src/contracts.js';
import { gatewayMessage } from '../src/discord.js';
import type { AckOutcome, DiscordRest } from '../src/discord.js';
import { DISCORD_DISPATCH_REST_TIMEOUT_MS, DiscordProtocol, parseButton } from '../src/discord-protocol.js';
import type { DiscordApi } from '../src/discord-protocol.js';
import { ALL_COMMANDS } from '../src/discord.js';
import { commandIngress } from '../src/main.js';
import type { CommandHandlers } from '../src/main.js';

// 옛 '/' 명령·버튼 상호작용의 해석과 응답(callback) 고정물. 운영 프로토콜(DiscordProtocol)은 상호작용을 받지 않는다(D-02, F-7).
// src에 남은 옛 수신 처리기(DiscordIngress의 명령·버튼 분기와 그 뒤 처리기)를 시험할 때만 쓴다. 상호작용 전송 자체의 동작은
// 이 고정물로 시험하지 않는다. 메시지는 운영 프로토콜 그대로다.
const InteractionSchema = z.object({ id: z.string(), token: z.string(), type: z.union([z.literal(2), z.literal(3)]),
  channel_id: z.string(), guild_id: z.string().optional(),
  user: z.object({ id: z.string() }).optional(), member: z.object({ user: z.object({ id: z.string() }) }).optional(),
  data: z.object({ name: z.string().optional(), custom_id: z.string().optional(),
    options: z.array(z.object({ name: z.string(), value: z.string() })).optional() }),
});
const ChannelSchema = z.object({ id: z.string(), type: z.number(), parent_id: z.string().nullable().optional(), guild_id: z.string().optional() });
const part = encodeURIComponent;
export class LegacyInteractionProtocol extends DiscordProtocol {
  private readonly interactions = new Map<string, { token: string; expires: number }>();
  constructor(private readonly legacyApi: DiscordApi, private readonly legacyBot: string, private readonly legacyNow: Clock = Date.now) {
    super(legacyApi, legacyBot, legacyNow);
  }
  override async gateway(type: 'MESSAGE_CREATE' | 'INTERACTION_CREATE', raw: unknown, ingress: { receive(input: EventInput): Promise<unknown> }): Promise<void> {
    if (type === 'MESSAGE_CREATE') return super.gateway(type, raw, ingress);
    const receivedAt = this.legacyNow();
    const interaction = InteractionSchema.parse(raw);
    const actor = interaction.member?.user.id ?? interaction.user?.id;
    if (!actor) throw new Denied();
    const normalized = await gatewayMessage({ id: interaction.id, channel_id: interaction.channel_id, guild_id: interaction.guild_id, author: { id: actor } },
      this.legacyBot, async id => {
        const c = ChannelSchema.parse(await this.legacyApi.request('GET', `/channels/${part(id)}`, undefined, { timeoutMs: DISCORD_DISPATCH_REST_TIMEOUT_MS }));
        if (c.id !== id) throw new Denied();
        return { type: c.type, parent_id: c.parent_id ?? undefined, guild_id: c.guild_id };
      });
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
  override async acknowledge(event: EventInput, content: string, options: Parameters<DiscordRest['acknowledge']>[2]): Promise<AckOutcome | void> {
    if (event.kind === 'message') return super.acknowledge(event, content, options);
    const interaction = this.interactions.get(event.id);
    if (!interaction || this.legacyNow() >= interaction.expires) throw new Error('interaction_expired');
    const { update, ...rest } = options;
    const body = update && event.kind === 'button' ? { type: 7, data: { content, allowed_mentions: rest.allowed_mentions, components: [] } }
      : { type: 4, data: { content, ...rest, flags: 64 | (rest.flags ?? 0) } };
    await this.legacyApi.request('POST', `/interactions/${part(event.id)}/${part(interaction.token)}/callback`, body, { expiresAt: interaction.expires });
  }
}

// 운영 조립이 만든 처리기 묶음(Publisher.handlers)을 운영과 같은 조립 함수(commandIngress)로 옛 수신에 묶어 옛 상호작용 하나를 넣는다.
// 응답(callback)은 같은 가짜 Discord(api)로, 처리기 로그는 조립된 로그로 간다. 거부(Denied)는 옛 Gateway 처리처럼 삼킨다.
export async function sendToHandlers(api: DiscordApi, handlers: CommandHandlers | undefined, raw: unknown): Promise<void> {
  if (!handlers) throw new Error('handlers_not_ready');
  const protocol = new LegacyInteractionProtocol(api, 'fixture-bot');
  try { await protocol.gateway('INTERACTION_CREATE', raw, commandIngress(handlers, protocol, ALL_COMMANDS)); }
  catch (error) { if (!(error instanceof Denied)) throw error; }
}
