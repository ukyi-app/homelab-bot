import { after, before, beforeEach, test } from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULTS, Denied } from '../src/contracts.js';
import { DiscordProtocol } from '../src/discord-protocol.js';
import type { DiscordApi } from '../src/discord-protocol.js';
import { fixture, localDatabase } from './helpers.js';

// C08 (AC-1): 멘션 요청을 받는 자리. 경계는 S1(Gateway 프레임 → 저장 → 게시)이다.
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
// Discord 채널 조회 응답. type 0 일반 채널, 11 공개 스레드, 12 비공개 스레드.
const CHANNELS: Record<string, Record<string, unknown>> = {
  'fixture-chat': { id: 'fixture-chat', type: 0, guild_id: GUILD, parent_id: 'fixture-category' },
  'fixture-notifications': { id: 'fixture-notifications', type: 0, guild_id: GUILD, parent_id: 'fixture-category' },
  'fixture-elsewhere': { id: 'fixture-elsewhere', type: 0, guild_id: GUILD, parent_id: 'fixture-category' },
  // 사람이 만든 공개 스레드. 봇은 이 스레드를 모른다.
  'fixture-human-thread': { id: 'fixture-human-thread', type: 11, guild_id: GUILD, parent_id: 'fixture-chat' },
  'fixture-alert-thread': { id: 'fixture-alert-thread', type: 11, guild_id: GUILD, parent_id: 'fixture-notifications' },
  // 오래 쉬어 보관된 스레드. 메시지가 오면 Discord가 보관을 푼다.
  'fixture-old-thread': { id: 'fixture-old-thread', type: 11, guild_id: GUILD, parent_id: 'fixture-chat',
    thread_metadata: { archived: true, auto_archive_duration: 1440 } },
  'fixture-private-thread': { id: 'fixture-private-thread', type: 12, guild_id: GUILD, parent_id: 'fixture-chat' },
};
function protocol() {
  const api: DiscordApi = { async request(method, path) {
    const id = /^\/channels\/([^/]+)$/.exec(path)?.[1];
    if (method === 'GET' && id && CHANNELS[id]) return CHANNELS[id];
    throw new Error(`unexpected ${method} ${path}`);
  } };
  return new DiscordProtocol(api, BOT, f.now);
}
let sequence = 7000;
function frame(channel: string, options: { author?: string; mention?: boolean; content?: string } = {}) {
  const mention = options.mention ?? true;
  return { id: String(sequence++), channel_id: channel, guild_id: GUILD, author: { id: options.author ?? 'fixture-owner' },
    content: options.content ?? (mention ? `<@${BOT}> 상태 봐 줘요` : '상태 봐 줘요'), mentions: mention ? [{ id: BOT }] : [] };
}
async function send(message: ReturnType<typeof frame>) { await protocol().gateway('MESSAGE_CREATE', message, f.ingress); }
async function answered(message: ReturnType<typeof frame>) {
  f.advance(DEFAULTS.debounceMs + 50); await f.runtime.tick(); await f.publisher.deliver();
  const event = (await rows('events')).find(e => e.delivery_id === message.id)!;
  return (await rows('jobs')).filter(j => j.event_id === event.id && j.state === 'succeeded').length;
}

test('AC-1 대화 채널 부모 멘션은 그 메시지에서 스레드를 열고 답한다', async () => {
  const message = frame('fixture-chat');
  await send(message); await f.publisher.deliver();
  assert.equal(f.rest.threads[0]?.from, message.id);
  assert.equal(await answered(message), 1);
  assert.equal(f.rest.messages.at(-1)!.channel, message.id);
});

test('AC-1 알림 채널 부모 멘션도 그 메시지에서 스레드를 열고 답한다', async () => {
  const message = frame('fixture-notifications');
  await send(message); await f.publisher.deliver();
  assert.equal(f.rest.threads[0]?.from, message.id);
  assert.equal(f.rest.threads[0]?.channel, 'fixture-notifications');
  assert.equal(await answered(message), 1);
  assert.equal(f.rest.messages.at(-1)!.channel, message.id);
});

test('AC-1 봇이 만들지 않은 공개 스레드의 멘션에 답한다(대화·알림 채널 아래)', async () => {
  for (const channel of ['fixture-human-thread', 'fixture-alert-thread']) {
    const message = frame(channel);
    await send(message);
    assert.equal(await answered(message), 1, channel);
    assert.equal(f.rest.messages.at(-1)!.channel, channel);
  }
  assert.equal(f.rest.threads.length, 0);
});

test('AC-1 7일 넘게 쉬어 보관된 스레드의 멘션과, 활성 스레드의 멘션 없는 이어 말하기에 답한다', async () => {
  const first = frame('fixture-old-thread');
  await send(first); assert.equal(await answered(first), 1);
  f.advance(8 * 86_400_000);
  const late = frame('fixture-old-thread');
  await send(late); assert.equal(await answered(late), 1);
  const follow = frame('fixture-old-thread', { mention: false });
  await send(follow); assert.equal(await answered(follow), 1);
});

test('AC-1 채널 부모의 멘션 없는 말은 대화·알림 채널 모두 받지 않는다', async () => {
  for (const channel of ['fixture-chat', 'fixture-notifications']) await send(frame(channel, { mention: false }));
  assert.equal((await rows('events')).length, 0);
});

test('AC-1 비공개 스레드·허용 밖 채널·owner가 아닌 사람은 지금처럼 거부하고 아무것도 남기지 않는다', async () => {
  await assert.rejects(send(frame('fixture-private-thread')), Denied);
  await assert.rejects(send(frame('fixture-elsewhere')), Denied);
  for (const channel of ['fixture-chat', 'fixture-notifications', 'fixture-human-thread']) {
    await assert.rejects(send(frame(channel, { author: 'fixture-stranger' })), Denied, channel);
  }
  assert.equal((await rows('events')).length, 0);
  await f.publisher.deliver();
  assert.equal(f.rest.threads.length + f.rest.messages.length, 0);
});

test('AC-1 거부 목록에 오른 owner는 알림 채널 부모에서 멘션해도 거부한다', async () => {
  await database.db.query('INSERT INTO denied_actors(actor_id,created_at) VALUES ($1,$2)', ['fixture-owner', f.now()]);
  await assert.rejects(send(frame('fixture-notifications')), Denied);
  assert.equal((await rows('events')).length, 0);
});
