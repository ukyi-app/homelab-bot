import { z } from 'zod';
import { Denied, DiscordUnauthorized, RateLimited } from './contracts.js';
import type { Clock, EventInput } from './contracts.js';
import { gatewayMessage } from './discord.js';
import type { DiscordIngress, DiscordRest, GatewayFrame } from './discord.js';

export interface DiscordApi {
  request(method: 'GET' | 'POST', path: string, body?: unknown): Promise<unknown>;
}
const ChannelSchema = z.object({ id: z.string(), type: z.number(), parent_id: z.string().nullable().optional(), guild_id: z.string().optional() });
const MessageSchema = z.object({ id: z.string(), channel_id: z.string(), guild_id: z.string().optional(),
  author: z.object({ id: z.string(), bot: z.boolean().optional() }), webhook_id: z.string().optional(),
  content: z.string().optional(), mentions: z.array(z.object({ id: z.string() })).optional() });
const IdSchema = z.object({ id: z.string() });
const InteractionSchema = z.object({ id: z.string(), token: z.string(), type: z.union([z.literal(2), z.literal(3)]),
  channel_id: z.string(), guild_id: z.string().optional(),
  user: z.object({ id: z.string() }).optional(), member: z.object({ user: z.object({ id: z.string() }) }).optional(),
  data: z.object({ name: z.string().optional(), custom_id: z.string().optional(),
    options: z.array(z.object({ name: z.string(), value: z.string() })).optional() }),
});
const part = encodeURIComponent;
export class DiscordProtocol implements DiscordRest {
  private readonly interactions = new Map<string, { token: string; expires: number }>();
  constructor(private readonly api: DiscordApi, private readonly botId: string, private readonly now: Clock = Date.now) {}
  private async channel(id: string) {
    const c = ChannelSchema.parse(await this.api.request('GET', `/channels/${part(id)}`));
    if (c.id !== id) throw new Denied();
    return { type: c.type, parent_id: c.parent_id ?? undefined, guild_id: c.guild_id };
  }
  async gateway(type: 'MESSAGE_CREATE' | 'INTERACTION_CREATE', raw: unknown, ingress: DiscordIngress): Promise<void> {
    if (type === 'MESSAGE_CREATE') {
      const frame = MessageSchema.parse(raw);
      if (frame.author.bot || frame.webhook_id) return;
      await ingress.receive(await gatewayMessage(frame, this.botId, id => this.channel(id)));
      return;
    }
    const interaction = InteractionSchema.parse(raw);
    const actor = interaction.member?.user.id ?? interaction.user?.id;
    if (!actor) throw new Denied();
    const frame: GatewayFrame = { id: interaction.id, channel_id: interaction.channel_id,
      guild_id: interaction.guild_id, author: { id: actor } };
    const normalized = await gatewayMessage(frame, this.botId, id => this.channel(id));
    const options = new Map(interaction.data.options?.map(o => [o.name, o.value]));
    const custom = interaction.data.custom_id?.split(':');
    if (interaction.type === 3 && (!custom || custom.length > 2 || !['list', 'stop', 'resume', 'cancel'].includes(custom[0]!))) throw new Denied();
    const input: EventInput = { ...normalized, kind: interaction.type === 2 ? 'command' : 'button',
      command: interaction.type === 2 ? interaction.data.name : custom![0],
      urgent: interaction.type === 2 && interaction.data.name === 'urgent',
      text: options.get('text') ?? '', target: options.get('target') ?? custom?.[1] };
    this.interactions.set(input.id, { token: interaction.token, expires: this.now() + 2500 });
    try { await ingress.receive(input); } finally { this.interactions.delete(input.id); }
  }
  async acknowledge(event: EventInput, content: string, options: Parameters<DiscordRest['acknowledge']>[2]): Promise<void> {
    if (event.kind !== 'message') {
      const interaction = this.interactions.get(event.id);
      if (!interaction || this.now() >= interaction.expires) throw new Error('interaction_expired');
      await this.api.request('POST', `/interactions/${part(event.id)}/${part(interaction.token)}/callback`,
        { type: 4, data: { content, flags: 64, ...options } });
    } else await this.api.request('POST', `/channels/${part(event.scope.channel)}/messages`,
      { content, nonce: event.id, enforce_nonce: true, ...options });
  }
  async createThread(channel: string, body: Parameters<DiscordRest['createThread']>[1]) {
    return IdSchema.parse(await this.api.request('POST', `/channels/${part(channel)}/threads`, body));
  }
  async sendMessage(channel: string, body: Parameters<DiscordRest['sendMessage']>[1]) {
    return IdSchema.parse(await this.api.request('POST', `/channels/${part(channel)}/messages`, body));
  }
  async findDelivery(channel: string, marker: string, kind: 'message' | 'thread'): Promise<{ id: string } | undefined> {
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
      const found = messages.find(m => m.author.id === this.botId && m.content?.endsWith(`[ref:${marker}]`));
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

export function discordHttpApi(token: string, send: typeof fetch): DiscordApi {
  let halted = false;
  return { async request(method, path, body) {
    if (halted) throw new DiscordUnauthorized();
    if (!path.startsWith('/') || path.includes('..')) throw new Denied();
    const response = await send(`https://discord.com/api/v10${path}`, { method, redirect: 'error',
      headers: { authorization: `Bot ${token}`, 'content-type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(1000) });
    if (response.status === 401) { halted = true; throw new DiscordUnauthorized(); }
    if (response.status === 429) {
      const error = z.object({ retry_after: z.number().finite().nonnegative(), global: z.boolean().optional() }).parse(await response.json());
      throw new RateLimited(Math.ceil(error.retry_after * 1000), error.global === true);
    }
    if (!response.ok) throw new Error('discord_request_failed');
    return response.status === 204 ? undefined : response.json();
  } };
}
