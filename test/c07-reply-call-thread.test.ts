import { after, before, beforeEach, test } from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULTS } from '../src/contracts.js';
import { DiscordProtocol } from '../src/discord-protocol.js';
import type { DiscordApi } from '../src/discord-protocol.js';
import { event, fixture, localDatabase, thread } from './helpers.js';

// C07 (AC-12): 답장·owner 호출·멘션 스레드 제목·작은 대조 표식. 경계는 S1(게시·대조, 가짜 Discord REST)이다.
let database: Awaited<ReturnType<typeof localDatabase>>;
let f: Awaited<ReturnType<typeof fixture>>;
before(async () => { database = await localDatabase(); });
beforeEach(async () => {
  await database.pg.exec('TRUNCATE events,conversations,jobs,results,outbox,schedules,denied_actors,controls,audit,incidents RESTART IDENTITY CASCADE');
  f = await fixture(database.db);
});
after(async () => { await database.pg.close(); });
async function rows(table: string) { return (await database.db.query<Record<string, any>>(`SELECT * FROM ${table}`)).rows; }
const channel = { ...thread, kind: 'channel' as const, channel: 'fixture-chat', parent: null };
const SMALL_MARKER = /\n-# ref:[0-9a-f]{24}$/;
const notice = (key: string, content: string, extra: { ownerCall?: true } = {}) => f.store.enqueue({ key, actor: 'fixture-owner', scope: thread,
  revision: f.policy.revision, payload: { kind: 'message', channel: thread.channel, content, classification: 'safe_summary', ...extra } });

test('AC-12 대화 답은 owner 메시지에 대한 답장이고 답장 알림을 울리지 않는다', async () => {
  await f.ingress.receive(event('7101')); f.advance(DEFAULTS.debounceMs + 50);
  await f.runtime.tick(); await f.publisher.deliver();
  const body = f.rest.messages[0]!.body;
  assert.deepEqual(body.message_reference, { message_id: '7101', fail_if_not_exists: false });
  assert.deepEqual(body.allowed_mentions, { parse: [], replied_user: false });
});

test('AC-12 대화 실패 안내도 그 owner 메시지에 대한 답장이다', async () => {
  f.setRun(async () => ({ status: 'failed', stopped: true }) as never);
  await f.ingress.receive(event('7102')); f.advance(DEFAULTS.debounceMs + 50);
  await f.runtime.tick(); await f.publisher.deliver();
  assert.equal((await rows('jobs'))[0]!.state, 'failed');
  assert.deepEqual(f.rest.messages[0]!.body.message_reference, { message_id: '7102', fail_if_not_exists: false });
});

test('AC-12 명령으로 받은 대화의 답은 답장이 아니다(답할 owner 메시지가 없다)', async () => {
  await f.ingress.receive(event('7103', { kind: 'command', command: 'chat' })); f.advance(DEFAULTS.debounceMs + 50);
  await f.runtime.tick(); await f.publisher.deliver();
  assert.equal(f.rest.messages[0]!.body.message_reference, undefined);
  assert.deepEqual(f.rest.messages[0]!.body.allowed_mentions, { parse: [] });
});

test('AC-12 owner 호출 표시가 있는 글만 owner 한 사람을 부르고 나머지는 멘션을 막는다', async () => {
  await notice('c07-call', '작업이 끝났어요.', { ownerCall: true });
  await notice('c07-quiet', '상태 안내예요.');
  await f.publisher.deliver(); await f.publisher.deliver();
  const [called, quiet] = f.rest.messages.map(m => m.body);
  assert.deepEqual(called!.allowed_mentions, { parse: [], users: ['fixture-owner'] });
  assert.ok(called!.content.startsWith('<@fixture-owner> 작업이 끝났어요.'));
  assert.deepEqual(quiet!.allowed_mentions, { parse: [] });
  assert.ok(!quiet!.content.includes('<@'));
});

test('AC-12 owner 호출은 여러 쪽 글의 첫 쪽에서만 부른다', async () => {
  await notice('c07-pages', '문장'.repeat(1200), { ownerCall: true });
  while (await f.publisher.deliver()) { /* 모든 쪽 */ }
  assert.ok(f.rest.messages.length >= 2);
  assert.deepEqual(f.rest.messages[0]!.body.allowed_mentions.users, ['fixture-owner']);
  for (const m of f.rest.messages.slice(1)) {
    assert.deepEqual(m.body.allowed_mentions, { parse: [] });
    assert.ok(!m.body.content.startsWith('<@'));
  }
});

test('AC-12 대조 표식은 메시지 끝의 작은 글씨 줄이고 1900자 본문에 owner 호출이 붙어도 2000자 안이다', async () => {
  await notice('c07-long', 'ㄱ'.repeat(1900), { ownerCall: true });
  await f.publisher.deliver();
  const content = f.rest.messages[0]!.body.content;
  assert.match(content, SMALL_MARKER);
  assert.ok(!content.includes('[ref:'));
  assert.ok(content.length <= 2000, `length ${content.length}`);
});

test('AC-12 응답 유실 뒤 대조는 새 표식 글을 찾아 확정하고 재게시하지 않는다', async () => {
  await notice('c07-lost', '안내예요.');
  f.rest.loseResponse = true; await f.publisher.deliver();
  assert.equal((await rows('outbox'))[0]!.state, 'unknown');
  await f.publisher.reconcile(); await f.publisher.deliver();
  assert.equal((await rows('outbox'))[0]!.state, 'sent');
  assert.equal(f.rest.messages.length, 1);
});

// 실제 DiscordProtocol 대조: 봇이 쓴 글만 보고, 새 표식과 배포 전 옛 표식을 모두 찾는다.
function historyApi(messages: { id: string; author: string; content: string }[]) {
  const calls: { method: string; path: string; body?: unknown }[] = [];
  const api: DiscordApi = { async request(method, path, body) {
    calls.push({ method, path, body });
    if (method === 'GET' && path.includes('/messages?')) return messages.map(m => ({ id: m.id, channel_id: thread.channel, author: { id: m.author }, content: m.content }));
    return { id: 'unexpected' };
  } };
  return { api, calls };
}
test('AC-12 대조는 새 표식(작은 글씨)과 옛 표식([ref:]) 글을 모두 찾고 다른 작성자 글은 무시한다', async () => {
  const fresh = 'a'.repeat(24); const old = 'b'.repeat(24); const foreign = 'c'.repeat(24);
  const { api } = historyApi([
    { id: 'new', author: 'fixture-bot', content: `안내예요.\n-# ref:${fresh}` },
    { id: 'old', author: 'fixture-bot', content: `안내예요.\n[ref:${old}]` },
    { id: 'spoof', author: 'fixture-owner', content: `흉내\n-# ref:${foreign}` },
  ]);
  const protocol = new DiscordProtocol(api, 'fixture-bot');
  assert.equal((await protocol.findDelivery(thread.channel, fresh, 'message'))?.id, 'new');
  assert.equal((await protocol.findDelivery(thread.channel, old, 'message'))?.id, 'old');
  assert.equal(await protocol.findDelivery(thread.channel, foreign, 'message'), undefined);
});

test('AC-12 채널 멘션 대화는 owner 메시지에서 스레드를 열고 제목은 멘션·마크업을 뺀 앞 40자다', async () => {
  await f.ingress.receive(event('7201', { scope: channel,
    text: '<@123456789012345678> **서버** 상태가 이상한데 한 번 봐 줄래요? 로그도 같이 확인해 주면 좋겠어요. 급하진 않아요' }));
  await f.publisher.deliver();
  const opened = f.rest.threads[0]!;
  assert.equal(opened.from, '7201');
  assert.equal(opened.body.name, '서버 상태가 이상한데 한 번 봐 줄래요? 로그도 같이 확인해 주면 좋겠어');
  f.advance(DEFAULTS.debounceMs + 50); await f.runtime.tick(); await f.publisher.deliver();
  // 답은 그 메시지에서 연 스레드에 달린다. 스레드가 그 메시지에 묶여 있어 따로 답장하지 않는다.
  assert.equal(f.rest.messages[0]!.channel, '7201');
  assert.equal(f.rest.messages[0]!.body.message_reference, undefined);
});

test('AC-12 멘션만 있는 메시지의 스레드 제목은 고정 문구다', async () => {
  await f.ingress.receive(event('7202', { scope: channel, text: '<@123456789012345678>  ' }));
  await f.publisher.deliver();
  assert.equal(f.rest.threads[0]!.body.name, '새 대화');
});

test('AC-12 스레드 생성 응답 유실 뒤 그 메시지의 스레드로 대조해 두 번 만들지 않는다', async () => {
  await f.ingress.receive(event('7203', { scope: channel, text: '<@123456789012345678> 봐 줘요' }));
  f.rest.loseResponse = true; await f.publisher.deliver();
  assert.equal((await rows('outbox'))[0]!.state, 'unknown');
  await f.publisher.reconcile(); await f.publisher.deliver(); await f.publisher.reconcile();
  assert.equal(f.rest.threads.length, 1);
  assert.equal((await rows('outbox'))[0]!.state, 'sent');
  assert.equal((await rows('jobs')).length, 1);
});

test("AC-12 '/' 명령으로 연 채널 스레드는 지금처럼 표식 이름의 독립 스레드다", async () => {
  await f.ingress.receive(event('7204', { kind: 'command', command: 'chat', scope: channel, text: '상태' }));
  await f.publisher.deliver();
  assert.equal(f.rest.threads[0]!.from, undefined);
  assert.match(f.rest.threads[0]!.body.name, /^homelab-[0-9a-f]{24}$/);
});

test('AC-12 protocol: 메시지에서 스레드를 열고, 대조는 그 메시지에 달린 스레드를 본다', async () => {
  const calls: { method: string; path: string; body?: unknown }[] = [];
  let attached: string | undefined;
  const api: DiscordApi = { async request(method, path, body) {
    calls.push({ method, path, body });
    if (method === 'POST') return { id: '7301' };
    return { id: '7301', channel_id: 'fixture-chat', author: { id: 'fixture-owner' }, content: '', ...(attached ? { thread: { id: attached } } : {}) };
  } };
  const protocol = new DiscordProtocol(api, 'fixture-bot');
  assert.equal(await protocol.findDelivery('fixture-chat', 'd'.repeat(24), 'thread', '7301'), undefined);
  assert.deepEqual((await protocol.createThread('fixture-chat', { name: '제목', type: 11, auto_archive_duration: 1440 }, '7301')).id, '7301');
  attached = '7301';
  assert.equal((await protocol.findDelivery('fixture-chat', 'd'.repeat(24), 'thread', '7301'))?.id, '7301');
  assert.deepEqual(calls.map(c => [c.method, c.path]), [
    ['GET', '/channels/fixture-chat/messages/7301'],
    ['POST', '/channels/fixture-chat/messages/7301/threads'],
    ['GET', '/channels/fixture-chat/messages/7301'],
  ]);
  assert.deepEqual(calls[1]!.body, { name: '제목', auto_archive_duration: 1440 });
});
