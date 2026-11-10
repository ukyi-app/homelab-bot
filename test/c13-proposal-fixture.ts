import { DEFAULTS } from '../src/contracts.js';
import type { Proposal } from '../src/contracts.js';
import type { Database } from '../src/database.js';
import { ALL_COMMANDS, DiscordIngress } from '../src/discord.js';
import { DiscordProtocol } from '../src/discord-protocol.js';
import { TaskCommands } from '../src/task-commands.js';
import { fixture, thread } from './helpers.js';
import { lane } from './task-lane-fixture.js';

// C13 제안·실행 확인 시험의 S1 경계. 수신은 Gateway 프레임(메시지·버튼 상호작용) → DiscordProtocol,
// 게시는 가짜 REST(MockDiscord), 실행은 '/' task와 같은 TaskCommands·작업 레인(가짜 작업자)이다.
export const BOT = '900000000000000001';
export const PROJECT = 'fixture';
export type Harness = Awaited<ReturnType<typeof harness>>;
export async function harness(db: Database, options: { colleague?: boolean } = {}) {
  const f = await fixture(db, { colleague: options.colleague ?? true });
  (f.policy as { task?: unknown }).task = { projects: [{ id: PROJECT, revision: 'r1', repository: 'fixture-org/fixture-repo', branch: 'main',
    allowedPaths: ['src'], forbiddenPaths: [], verifyCommands: [] }] };
  const local = lane(f);
  const handler = new TaskCommands(f.store, f.gate, local.bridge, () => ({ routed: true, open: true, reasons: [] }), () => {}, () => {});
  const callbacks: { path: string; body: { type: number; data: Record<string, unknown> } }[] = [];
  const protocol = new DiscordProtocol({ request: async (method, path, body) => {
    if (method === 'GET' && path === `/channels/${thread.channel}`) return { id: thread.channel, type: 11, parent_id: thread.parent, guild_id: thread.guild };
    if (method === 'PUT') return undefined;
    if (method === 'POST' && path.endsWith('/callback')) { callbacks.push({ path, body: body as never }); return undefined; }
    throw new Error(`unexpected_route ${method} ${path}`);
  } }, BOT, f.now);
  const ingress = new DiscordIngress(f.store, f.gate, protocol, true, ALL_COMMANDS, () => {}, undefined, handler);
  let interactions = 0;
  const reply = (proposal: Proposal | null, text = '그 저장소에서 시험을 고쳐 볼게요. 아래에서 확인해 주세요.') => {
    f.setRun(async () => ({ status: 'succeeded', stopped: true, rateLimit: null, output: { reply: text, proposal, ack_only: false } }));
  };
  return {
    f, local, ingress, protocol, callbacks, reply,
    // owner의 멘션 메시지 한 통(Gateway MESSAGE_CREATE).
    say: (id: string, text: string, author = f.policy.owner) => protocol.gateway('MESSAGE_CREATE', { id, channel_id: thread.channel, guild_id: thread.guild,
      author: { id: author }, content: `<@${BOT}> ${text}`, mentions: [{ id: BOT }] }, ingress),
    // 디바운스를 넘겨 대화 작업 하나를 돌리고, 쌓인 게시를 모두 보낸다.
    turn: async () => {
      f.advance(DEFAULTS.debounceMs + 50);
      await local.runtime.tick();
      while (await f.publisher.deliver()) { /* 쌓인 게시를 비운다 */ }
    },
    // 버튼 상호작용(Gateway INTERACTION_CREATE type 3). 누를 때마다 새 상호작용 ID다.
    press: (customId: string, actor = f.policy.owner) => protocol.gateway('INTERACTION_CREATE', { id: `fixture-interaction-${++interactions}`,
      token: 'fixture-interaction-token', type: 3, channel_id: thread.channel, guild_id: thread.guild, member: { user: { id: actor } },
      data: { custom_id: customId } }, ingress),
    // 마지막으로 게시된 버튼 글과 그 버튼들.
    buttons: () => {
      const posted = f.rest.messages.filter(m => m.body.components?.length);
      const last = posted.at(-1);
      return { posted, content: last?.body.content ?? '', ids: last?.body.components?.[0]?.components.map(c => c.custom_id) ?? [],
        labels: last?.body.components?.[0]?.components.map(c => c.label) ?? [] };
    },
    taskJobs: async () => (await db.query<{ id: string; state: string }>("SELECT id,state FROM jobs WHERE type='task' ORDER BY created_at")).rows,
  };
}
