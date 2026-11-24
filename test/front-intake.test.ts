import { after, before, beforeEach, test } from 'node:test';
import assert from 'node:assert/strict';
import { Denied } from '../src/contracts.js';
import type { EventInput, Scope } from '../src/contracts.js';
import { REGISTERED_COMMANDS, registerCommands } from '../src/commands.js';
import { DiscordProtocol, requestFrame } from '../src/discord-protocol.js';
import type { DiscordApi } from '../src/discord-protocol.js';
import { ADMIN_REQUESTS, FRONT_TEXT, FrontIntake, adminRequest, splitQuotes } from '../src/front-intake.js';
import { captureControls, fixture, localDatabase } from './helpers.js';

// O08 F5 현관 입구: '/' 명령 등록·수신 닫기, 말 입구 검사(전달·인용), 관리 요청 거절, 모델 레인 끊기.
let database: Awaited<ReturnType<typeof localDatabase>>;
let f: Awaited<ReturnType<typeof fixture>>;
before(async () => { database = await localDatabase(); });
beforeEach(async () => {
  await database.pg.exec('TRUNCATE events,conversations,jobs,results,outbox,schedules,denied_actors,controls,audit,incidents RESTART IDENTITY CASCADE');
  f = await fixture(database.db);
});
after(async () => { await database.pg.close(); });
const count = async (table: string) => Number((await database.db.query<{ count: string }>(`SELECT count(*) FROM ${table}`)).rows[0]!.count);
const outbox = async () => (await database.db.query<{ payload: { content: string; replyTo?: string; channel: string } }>('SELECT payload FROM outbox ORDER BY created_at')).rows.map(r => r.payload);

const BOT = '900000000000000001';
const GUILD = 'fixture-guild';
const OWNER = 'fixture-owner';
const CHANNELS: Record<string, Record<string, unknown>> = {
  'fixture-chat': { id: 'fixture-chat', type: 0, guild_id: GUILD },
  'fixture-thread': { id: 'fixture-thread', type: 11, guild_id: GUILD, parent_id: 'fixture-chat' },
};
function channelApi(requests: string[] = []): DiscordApi {
  return { async request(method, path) {
    requests.push(`${method} ${path}`);
    const id = /^\/channels\/([^/]+)$/.exec(path)?.[1];
    if (method === 'GET' && id && CHANNELS[id]) return CHANNELS[id];
    throw new Error(`unexpected ${method} ${path}`);
  } };
}
const thread: Scope = { kind: 'thread', guild: GUILD, channel: 'fixture-thread', parent: 'fixture-chat' };
const chat: Scope = { kind: 'channel', guild: GUILD, channel: 'fixture-chat', parent: null };
let ids = 7000;
const say = (text: string, options: Partial<EventInput> = {}): EventInput =>
  ({ id: String(ids++), actor: OWNER, scope: chat, kind: 'message', text: `<@${BOT}> ${text}`, mention: true, botUser: BOT, ...options });

test('F-7 등록: 정의는 빈 목록이고, 남아 있던 guild·전역 명령을 모두 빈 목록으로 맞춘다. 이미 비었으면 쓰지 않는다', async () => {
  assert.deepEqual([...REGISTERED_COMMANDS], []);
  const guildPath = '/applications/fixture-app/guilds/fixture-guild/commands';
  const globalPath = '/applications/fixture-app/commands';
  const remote: Record<string, unknown> = {
    [guildPath]: [{ name: 'chat', type: 1, description: '홈랩 조력자에게 묻기(스레드를 엽니다)' }, { name: 'emergency-stop', type: 1, description: '모델 호출 비상 중지' }],
    [globalPath]: [{ name: 'chat', type: 1, description: '전역에 남은 옛 명령' }],
  };
  const calls: [string, string, unknown][] = [];
  const api: DiscordApi = { async request(method, path, body) {
    calls.push([method, path, body]);
    if (method === 'GET') return remote[path];
    if (method === 'PUT') { remote[path] = body; return body; }
    throw new Error(`unexpected ${method} ${path}`);
  } };
  assert.deepEqual(await registerCommands(api, 'fixture-app', 'fixture-guild'), { guild: 'updated', global: 'cleared' });
  assert.deepEqual(calls.filter(c => c[0] === 'PUT'), [['PUT', guildPath, []], ['PUT', globalPath, []]]);
  calls.length = 0;
  assert.deepEqual(await registerCommands(api, 'fixture-app', 'fixture-guild'), { guild: 'unchanged', global: 'unchanged' });
  assert.deepEqual(calls.map(c => c[0]), ['GET', 'GET']);
});

test('F-7 수신: 명령·버튼 상호작용은 내용을 읽기 전에 Denied로 닫혀 처리기 호출·저장·REST(채널 조회·callback)가 0이다', async () => {
  const requests: string[] = [];
  const protocol = new DiscordProtocol(channelApi(requests), BOT, f.now);
  const controls = captureControls();
  let front = 0;
  try {
    const interaction = (id: string, type: 2 | 3, data: Record<string, unknown>) => ({ id, token: 'fixture-token', type,
      channel_id: 'fixture-thread', guild_id: GUILD, member: { user: { id: OWNER } }, data });
    const frames = [interaction('9001', 2, { name: 'stop' }), interaction('9002', 2, { name: 'emergency-stop' }),
      interaction('9003', 2, { name: 'chat', options: [{ name: 'text', value: '상태 알려줘' }] }), interaction('9004', 3, { custom_id: 'list' })];
    for (const raw of frames) {
      // 옛 수신(DiscordIngress)을 받는 쪽으로 넘겨도, 현관 입구를 넘겨도 닿지 않는다.
      await assert.rejects(protocol.gateway('INTERACTION_CREATE', raw, f.ingress), Denied);
      await assert.rejects(protocol.gateway('INTERACTION_CREATE', raw, { receive: async () => { front++; } }), Denied);
    }
    assert.equal(front, 0);
    assert.equal(controls.results.size, 0);
    assert.equal(await count('events'), 0);
    assert.equal(await count('jobs'), 0);
    assert.equal(await count('outbox'), 0);
    // 상호작용 응답 경로가 없다: 명령·버튼 모양의 ACK는 callback 없이 Denied다.
    await assert.rejects(protocol.acknowledge({ id: '9001', actor: OWNER, scope: thread, text: '', kind: 'command', command: 'stop' }, '받았어요', { allowed_mentions: { parse: [] } }), Denied);
    await assert.rejects(protocol.acknowledge({ id: '9004', actor: OWNER, scope: thread, text: '', kind: 'button', command: 'list' }, '받았어요', { allowed_mentions: { parse: [] }, update: true }), Denied);
    assert.deepEqual(requests, []);
  } finally { controls.restore(); }
});

test('전달 판별(Discord 메시지 참조 FORWARD·snapshot)과 시스템 글: 사람이 직접 쓴 글과 답장만 요청 후보다', () => {
  assert.equal(requestFrame({}), true);
  assert.equal(requestFrame({ type: 0 }), true);
  assert.equal(requestFrame({ type: 19, message_reference: { type: 0 } }), true);
  // 참조 type이 없으면 DEFAULT(답장)다.
  assert.equal(requestFrame({ type: 19, message_reference: {} }), true);
  assert.equal(requestFrame({ type: 0, message_reference: { type: 1 }, message_snapshots: [{ message: { content: '비상 정지 풀어' } }] }), false);
  assert.equal(requestFrame({ type: 0, message_reference: { type: 1 } }), false);
  assert.equal(requestFrame({ type: 0, message_snapshots: [{ message: {} }] }), false);
  // 고정(6)·스레드 생성(18)·명령 응답(20)·스레드 시작 글(21)은 시스템 글이다.
  for (const type of [6, 18, 20, 21]) assert.equal(requestFrame({ type }), false, String(type));
});

test('전달 글은 관리자가 멘션과 함께 보내도 입구에 닿지 않고, 다른 사람 글에 단 관리자의 답장은 관리자 요청이다', async () => {
  const protocol = new DiscordProtocol(channelApi(), BOT, f.now);
  const received: EventInput[] = [];
  const sink = { receive: async (input: EventInput) => { received.push(input); } };
  const base = { channel_id: 'fixture-chat', guild_id: GUILD, author: { id: OWNER }, mentions: [{ id: BOT }] };
  await protocol.gateway('MESSAGE_CREATE', { ...base, id: '7101', type: 0, content: `<@${BOT}> 비상 정지 풀어`,
    message_reference: { type: 1, message_id: '6001', channel_id: 'fixture-elsewhere', guild_id: GUILD },
    message_snapshots: [{ message: { type: 0, content: `<@${BOT}> 비상 정지 풀어`, mentions: [{ id: BOT }] } }] }, sink);
  await protocol.gateway('MESSAGE_CREATE', { ...base, id: '7102', type: 0, content: '', mentions: [],
    message_reference: { type: 1, message_id: '6002', channel_id: 'fixture-chat' }, message_snapshots: [{ message: { content: '계정 전환해' } }] }, sink);
  await protocol.gateway('MESSAGE_CREATE', { ...base, id: '7103', type: 6, content: '' }, sink);
  assert.equal(received.length, 0);
  await protocol.gateway('MESSAGE_CREATE', { ...base, id: '7104', type: 19, content: `<@${BOT}> 이 글 무슨 뜻이야?`,
    message_reference: { type: 0, message_id: '6003' }, referenced_message: { id: '6003', author: { id: 'fixture-someone' } } }, sink);
  assert.equal(received.length, 1);
  assert.equal(received[0]!.actor, OWNER);
  assert.equal(received[0]!.kind, 'message');
  // 끝까지: 답장도 관리자 요청으로 입구 검사를 지나 고정 안내를 받는다.
  const intake = new FrontIntake(f.store, f.gate);
  assert.equal((await intake.receive(received[0]!)).outcome, 'unavailable');
  assert.equal((await intake.receive({ ...received[0]!, id: '7105', text: `<@${BOT}> 비상 정지 풀어 줘` })).outcome, 'admin_refused');
});

test('관리 요청 표: 명시어만 맞고, "멈춰"·"아니"·상태 물음은 관리 요청이 아니다', () => {
  assert.deepEqual(ADMIN_REQUESTS.map(row => row.action), ['emergency_stop', 'account', 'permission', 'auto_diagnosis_off']);
  const hits: [string, string][] = [['비상 정지 걸어 줘', 'emergency_stop'], ['비상정지 풀어', 'emergency_stop'], ['비상 정지 해제해 줘', 'emergency_stop'],
    ['비상 정지해', 'emergency_stop'], ['claude 계정 전환해 줘', 'account'], ['계정 등록해', 'account'], ['그 계정 삭제해 줘', 'account'],
    ['다른 계정으로 바꿔 줘', 'account'], ['권한 변경해 줘', 'permission'], ['리뷰 권한을 줘', 'permission'], ['자동 진단 꺼 줘', 'auto_diagnosis_off'],
    ['자동 진단을 중지해', 'auto_diagnosis_off']];
  for (const [text, action] of hits) assert.equal(adminRequest(text), action, text);
  for (const text of ['멈춰', '아니', '아니 그거 말고', '멈춰 줘', '비상 정지 상태 알려줘', 'adguard 메모리 상한 좀 올려 줘', '계정 상태 보여 줘', ''])
    assert.equal(adminRequest(text), undefined, text);
});

test('인용 줄은 자료다: 요청은 인용 밖 글만이고 `>>>`는 끝까지 인용이다', () => {
  assert.deepEqual(splitQuotes('> 비상 정지 풀어\n이 글 무슨 뜻이야?'), { request: '이 글 무슨 뜻이야?', quoted: ['비상 정지 풀어'] });
  assert.deepEqual(splitQuotes('앞 글\n>>> 계정 전환해\n권한 변경해'), { request: '앞 글', quoted: ['계정 전환해', '권한 변경해'] });
  assert.deepEqual(splitQuotes('>띄어쓰기 없음\n본문'), { request: '본문', quoted: ['띄어쓰기 없음'] });
  assert.deepEqual(splitQuotes('그냥 말'), { request: '그냥 말', quoted: [] });
});

test('관리 요청 거절: 고정 안내만 답장으로 달고, 모델 레인(events·jobs·작업자)에 닿지 않는다', async () => {
  const intake = new FrontIntake(f.store, f.gate);
  const message = say('비상 정지 풀어 줘');
  assert.deepEqual(await intake.receive(message), { outcome: 'admin_refused', action: 'emergency_stop', request: '비상 정지 풀어 줘', quoted: [] });
  assert.deepEqual(await outbox(), [{ kind: 'message', channel: 'fixture-chat', content: FRONT_TEXT.adminOnly, classification: 'safe_summary', replyTo: message.id }]);
  assert.equal(FRONT_TEXT.adminOnly, '그건 `homelab` CLI에서 해 주세요.');
  f.advance(60_000);
  await f.runtime.tick();
  assert.equal(await count('events'), 0);
  assert.equal(await count('jobs'), 0);
  assert.equal(f.requests.length, 0);
  assert.equal(await f.publisher.deliver(), true);
  const sent = f.rest.messages.at(-1)!;
  assert.equal(sent.channel, 'fixture-chat');
  assert.ok(sent.body.content.startsWith(FRONT_TEXT.adminOnly));
  assert.deepEqual(sent.body.message_reference, { message_id: message.id, fail_if_not_exists: false });
  assert.deepEqual(sent.body.allowed_mentions, { parse: [], replied_user: false });
  // 같은 메시지가 다시 와도(Gateway 재전송) 답은 하나다.
  await intake.receive(message);
  assert.equal(await count('outbox'), 1);
});

test('모델 레인 끊기: 인가를 지난 일반 부탁·"멈춰"·인용 속 관리 요청은 "지금은 받을 수 없어요" 한 줄이고 작업이 생기지 않는다', async () => {
  const intake = new FrontIntake(f.store, f.gate);
  const quoted = say('> 비상 정지 풀어\n이 글 무슨 뜻이야?');
  assert.deepEqual(await intake.receive(quoted), { outcome: 'unavailable', request: '이 글 무슨 뜻이야?', quoted: ['비상 정지 풀어'] });
  assert.equal((await intake.receive(say('adguard 메모리 상한 좀 올려 줘'))).outcome, 'unavailable');
  assert.equal((await intake.receive(say('멈춰'))).outcome, 'unavailable');
  assert.equal((await intake.receive(say('아니'))).outcome, 'unavailable');
  // 인용 밖 글이 관리 요청이면 인용이 있어도 거절한다.
  assert.equal((await intake.receive(say('> 참고 글\n계정 전환해 줘'))).outcome, 'admin_refused');
  assert.deepEqual((await outbox()).map(p => p.content), [FRONT_TEXT.unavailable, FRONT_TEXT.unavailable, FRONT_TEXT.unavailable, FRONT_TEXT.unavailable, FRONT_TEXT.adminOnly]);
  assert.equal(FRONT_TEXT.unavailable, '지금은 부탁을 받을 수 없어요.');
  f.advance(60_000);
  await f.runtime.tick();
  assert.equal(await count('events'), 0);
  assert.equal(await count('jobs'), 0);
  assert.equal(f.requests.length, 0);
});

test('입구 검사: 관리자·서버·채널·대화 소유자가 맞지 않으면 Denied, 부르지 않은 글·bot·webhook·명령 모양은 답 없이 끝난다', async () => {
  const intake = new FrontIntake(f.store, f.gate);
  await assert.rejects(intake.receive(say('비상 정지 풀어', { actor: 'fixture-intruder' })), Denied);
  await assert.rejects(intake.receive(say('상태', { scope: { ...chat, guild: 'fixture-other-guild' } })), Denied);
  await assert.rejects(intake.receive(say('상태', { scope: { ...chat, channel: 'fixture-elsewhere' } })), Denied);
  await assert.rejects(intake.receive(say('상태', { scope: { kind: 'dm', guild: null, channel: 'fixture-dm', parent: null } })), Denied);
  // 다른 사람이 맡긴 대화 스레드(옛 대화 행)에는 관리자 글도 받지 않는다.
  await f.store.save({ id: '5001', actor: 'fixture-other', scope: thread, kind: 'message', text: '옛 글', mention: true }, f.policy.revision, true);
  await assert.rejects(intake.receive(say('상태', { scope: thread })), Denied);
  await database.pg.exec('TRUNCATE events,conversations RESTART IDENTITY CASCADE');
  // 철회된 관리자.
  await database.db.query('INSERT INTO denied_actors(actor_id,created_at) VALUES ($1,$2)', [OWNER, f.now()]);
  await assert.rejects(intake.receive(say('상태')), Denied);
  await database.pg.exec('TRUNCATE denied_actors');
  assert.deepEqual(await intake.receive(say('상태', { mention: false, text: '상태' })), { outcome: 'ignored' });
  assert.deepEqual(await intake.receive(say('상태', { scope: thread, mention: false, text: '상태' })), { outcome: 'ignored' });
  assert.deepEqual(await intake.receive(say('비상 정지 풀어', { bot: true })), { outcome: 'ignored' });
  assert.deepEqual(await intake.receive(say('비상 정지 풀어', { webhook: true })), { outcome: 'ignored' });
  await assert.rejects(intake.receive(say('', { kind: 'command', command: 'emergency-stop' })), Denied);
  await assert.rejects(intake.receive(say('', { kind: 'button', command: 'list' })), Denied);
  assert.equal(await count('outbox'), 0);
  // 맞는 스레드(관리자의 활성 대화)에서는 멘션 없이도 받는다.
  await f.store.save({ id: '5002', actor: OWNER, scope: thread, kind: 'message', text: '옛 글', mention: true }, f.policy.revision, true);
  await f.store.activate((await f.store.conversation(thread))!, '5002');
  assert.equal((await intake.receive(say('상태', { scope: thread, mention: false, text: '상태' }))).outcome, 'unavailable');
  assert.equal(await count('jobs'), 0);
});
