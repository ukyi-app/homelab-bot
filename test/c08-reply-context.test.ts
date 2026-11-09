import { after, before, beforeEach, test } from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULTS } from '../src/contracts.js';
import { DiscordProtocol } from '../src/discord-protocol.js';
import type { DiscordApi } from '../src/discord-protocol.js';
import { fixture, localDatabase, thread } from './helpers.js';

// C08 (AC-2): 봇 글 답장 참조와 owner 원문의 봇 멘션 표기 제거. 경계는 S1(Gateway 프레임 → 저장 → 작업자 요청의 untrusted)이다.
let database: Awaited<ReturnType<typeof localDatabase>>;
let f: Awaited<ReturnType<typeof fixture>>;
before(async () => { database = await localDatabase(); });
beforeEach(async () => {
  await database.pg.exec('TRUNCATE events,conversations,jobs,results,outbox,schedules,denied_actors,controls,audit,incidents RESTART IDENTITY CASCADE');
  f = await fixture(database.db);
});
after(async () => { await database.pg.close(); });
async function rows(table: string) { return (await database.db.query<Record<string, any>>(`SELECT * FROM ${table}`)).rows; }

const BOT = '900000000000000001';
const GUILD = 'fixture-guild';
type Item = Record<string, unknown> & { from: string; text?: string };
function protocol() {
  const api: DiscordApi = { async request(method, path) {
    if (method === 'GET' && path === `/channels/${thread.channel}`) return { id: thread.channel, type: 11, guild_id: GUILD, parent_id: thread.parent };
    throw new Error(`unexpected ${method} ${path}`);
  } };
  return new DiscordProtocol(api, BOT, f.now);
}
let sequence = 8000n;
function frame(content: string, extra: Record<string, unknown> = {}) {
  return { id: String(sequence++), channel_id: thread.channel, guild_id: GUILD, author: { id: 'fixture-owner' },
    content, mentions: content.includes(BOT) ? [{ id: BOT }] : [], ...extra };
}
// 그 프레임으로 받은 요청이 작업자에게 넘긴 untrusted 기록.
async function untrustedFor(message: ReturnType<typeof frame>): Promise<Item[]> {
  await protocol().gateway('MESSAGE_CREATE', message, f.ingress);
  f.advance(DEFAULTS.debounceMs + 50); await f.runtime.tick();
  return f.requests.at(-1)!.untrusted as Item[];
}

test('owner 원문의 봇 멘션 표기(<@id>·<@!id>)는 모델에 가지 않고, 다른 사람 멘션과 저장된 원문은 그대로다', async () => {
  const text = `<@${BOT}> 이거 <@!${BOT}> 봐 줘요 <@123456789012345678> 말대로`;
  const message = frame(text);
  const items = await untrustedFor(message);
  assert.equal(items.at(-1)!.text, '이거 봐 줘요 <@123456789012345678> 말대로');
  const stored = (await rows('events')).find(e => e.delivery_id === message.id)!;
  assert.equal(stored.payload.text, text);
});
