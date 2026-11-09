import { after, before, beforeEach, test } from 'node:test';
import assert from 'node:assert/strict';
import { DiscordProtocol, discordHttpApi } from '../src/discord-protocol.js';
import type { DiscordApi } from '../src/discord-protocol.js';
import { DEFAULTS, DiscordRejected, RateLimited } from '../src/contracts.js';
import { DiscordIngress, DiscordPublisher } from '../src/discord.js';
import { REACTION_ATTEMPTS } from '../src/reactions.js';
import { Store } from '../src/store.js';
import { MockDiscord, event, fixture, localDatabase, thread } from './helpers.js';

// C04 반응 수명(AC-14): 받으면 👀, 다른 모델 일 뒤에 기다리면 ⏳, 답이 게시되면 봇 반응을 모두 지운다.
// 실패가 확정되면 지우고 실패 한 줄을 단다. 지우기는 봇 자신의 반응(@me)만이다.
type Call = { method: string; path: string; body?: unknown };
const EYES = '%F0%9F%91%80';
const HOURGLASS = '%E2%8F%B3';
function fakeApi(fail?: (call: Call) => Error | undefined) {
  const calls: Call[] = [];
  const api: DiscordApi = {
    async request(method, path, body) {
      const call = { method, path, body };
      calls.push(call);
      const error = fail?.(call);
      if (error) throw error;
      return method === 'PUT' || method === 'DELETE' ? undefined : { id: '1' };
    },
  };
  return { api, calls };
}

test('protocol: ⏳ 더하기는 봇 자신(@me)의 PUT, 지우기는 봇 자신(@me)의 DELETE', async () => {
  const { api, calls } = fakeApi();
  const protocol = new DiscordProtocol(api, 'fixture-bot');
  await protocol.addReaction('c1', 'm1', '⏳');
  await protocol.removeOwnReaction('c1', 'm1', '👀');
  assert.deepEqual(calls.map(c => [c.method, c.path, c.body]), [
    ['PUT', `/channels/c1/messages/m1/reactions/${HOURGLASS}/@me`, undefined],
    ['DELETE', `/channels/c1/messages/m1/reactions/${EYES}/@me`, undefined],
  ]);
});

test('discordHttpApi: 반응 DELETE는 본문 없이 보내고 204 빈 응답을 받는다', async () => {
  const seen: { url: string; method?: string; body?: unknown }[] = [];
  const api = discordHttpApi('fixture-token', (async (url: string, init: RequestInit) => {
    seen.push({ url, method: init.method, body: init.body });
    return new Response(null, { status: 204 });
  }) as typeof fetch);
  assert.equal(await api.request('DELETE', `/channels/1/messages/2/reactions/${EYES}/@me`), undefined);
  assert.deepEqual(seen, [{ url: `https://discord.com/api/v10/channels/1/messages/2/reactions/${EYES}/@me`, method: 'DELETE', body: undefined }]);
});

let database: Awaited<ReturnType<typeof localDatabase>>;
let f: Awaited<ReturnType<typeof fixture>>;
// 가짜 Discord에 닿은 쓰기를 한 줄로 모은다: ack(👀 수신 표시), post(게시), add/remove(반응).
let log: string[];
before(async () => { database = await localDatabase(); });
beforeEach(async () => {
  await database.pg.exec('TRUNCATE events,conversations,jobs,results,outbox,schedules,denied_actors,controls,audit,incidents RESTART IDENTITY CASCADE');
  f = await fixture(database.db);
  log = [];
  const rest = f.rest;
  const acknowledge = rest.acknowledge.bind(rest);
  const sendMessage = rest.sendMessage.bind(rest);
  const addReaction = rest.addReaction.bind(rest);
  const removeOwnReaction = rest.removeOwnReaction.bind(rest);
  rest.acknowledge = async (e, content, options) => { log.push(`ack ${e.id}`); return acknowledge(e, content, options); };
  rest.sendMessage = async (channel, body) => { log.push(`post ${channel}`); return sendMessage(channel, body); };
  rest.addReaction = async (channel, message, emoji) => { log.push(`add ${channel}/${message} ${emoji}`); return addReaction(channel, message, emoji); };
  rest.removeOwnReaction = async (channel, message, emoji) => { log.push(`remove ${channel}/${message} ${emoji}`); return removeOwnReaction(channel, message, emoji); };
});
after(async () => { await database.pg.close(); });
async function drain() { while (await f.publisher.deliver()); }

test('흐름: 받음 👀 → 답 게시 → 봇 반응 모두 지움(✅ 없음)', async () => {
  await f.ingress.receive(event('8001'));
  f.advance(DEFAULTS.debounceMs);
  assert.equal(await f.runtime.tick(), true);
  await drain();
  assert.deepEqual(log, ['ack 8001', 'post fixture-thread', 'remove fixture-thread/8001 👀']);
  await drain();
  assert.equal(log.length, 3);
});

test('흐름: 실패가 확정되면 반응을 지우고 실패 한 줄을 단다', async () => {
  f.setRun(async () => ({ status: 'failed', stopped: true }));
  await f.ingress.receive(event('8201'));
  f.advance(DEFAULTS.debounceMs);
  assert.equal(await f.runtime.tick(), true);
  await drain();
  assert.deepEqual(log, ['ack 8201', 'post fixture-thread', 'remove fixture-thread/8201 👀']);
  assert.equal(f.rest.messages.length, 1);
  assert.equal((await database.db.query<{ state: string }>('SELECT state FROM jobs')).rows[0]!.state, 'failed');
});

test('흐름: unknown이 멈춤 확인으로 실패 확정되면 반응을 지우고 안내 한 줄을 단다', async () => {
  f.setRun(async () => ({ status: 'unknown', stopped: false }));
  await f.ingress.receive(event('8202'));
  f.advance(DEFAULTS.debounceMs);
  f.worker.cancel = async () => ({ stopped: false });
  assert.equal(await f.runtime.tick(), true);
  await drain();
  assert.equal((await database.db.query<{ state: string }>('SELECT state FROM jobs')).rows[0]!.state, 'unknown');
  assert.deepEqual(log.filter(line => line.startsWith('remove')), [], 'unknown 동안은 지우지 않는다');
  f.worker.cancel = async () => ({ stopped: true });
  assert.equal(await f.runtime.probeUnknown(), 1);
  log.length = 0;
  await drain();
  assert.deepEqual(log, ['post fixture-thread', 'remove fixture-thread/8202 👀']);
});

test('흐름: owner가 대기 중 작업을 /cancel하면 반응을 지운다', async () => {
  await f.ingress.receive(event('8301'));
  const job = (await database.db.query<{ id: string }>('SELECT id FROM jobs')).rows[0]!.id;
  await f.ingress.receive(event('8302', { kind: 'command', command: 'cancel', target: job, mention: undefined, text: '' }));
  assert.equal((await database.db.query<{ state: string }>('SELECT state FROM jobs WHERE id=$1', [job])).rows[0]!.state, 'cancelled');
  await drain();
  assert.deepEqual(log.filter(line => !line.startsWith('post') && !line.startsWith('ack')), ['remove fixture-thread/8301 👀']);
});

test('게시: 답이 unknown인 동안은 지우지 않고, 대조로 sent가 확정되면 지운다', async () => {
  await f.ingress.receive(event('8401'));
  f.advance(DEFAULTS.debounceMs);
  await f.runtime.tick();
  f.rest.loseResponse = true;
  await drain();
  assert.equal((await database.db.query<{ state: string }>('SELECT state FROM outbox')).rows[0]!.state, 'unknown');
  assert.deepEqual(log, ['ack 8401', 'post fixture-thread']);
  await f.publisher.reconcile();
  assert.equal((await database.db.query<{ state: string }>('SELECT state FROM outbox')).rows[0]!.state, 'sent');
  await drain();
  assert.deepEqual(log.slice(2), ['remove fixture-thread/8401 👀']);
});

test('게시: 여러 쪽 답은 마지막 쪽이 sent로 확정된 뒤에 지운다', async () => {
  await f.ingress.receive(event('8402'));
  f.advance(DEFAULTS.debounceMs);
  const job = (await database.db.query<{ id: string }>('SELECT id FROM jobs')).rows[0]!.id;
  const claimed = (await f.store.claim())!;
  assert.equal(claimed.id, job);
  await f.store.finish(claimed, {}, {}, '가'.repeat(3000), claimed.target);
  const pages = (await database.db.query('SELECT id FROM outbox')).rows.length;
  assert.ok(pages >= 2);
  for (let page = 1; page < pages; page++) {
    assert.equal(await f.publisher.deliver(), true);
    assert.equal(log.filter(line => line.startsWith('remove')).length, 0, `${page}쪽 뒤에는 아직 지우지 않는다`);
  }
  await drain();
  assert.deepEqual(log.slice(-1), ['remove fixture-thread/8402 👀']);
});

async function audits(kind: string) {
  return (await database.db.query<{ detail: unknown }>('SELECT detail FROM audit WHERE kind=$1 ORDER BY id', [kind])).rows.map(row => row.detail);
}
async function answer(id: string) {
  await f.ingress.receive(event(id));
  f.advance(DEFAULTS.debounceMs);
  assert.equal(await f.runtime.tick(), true);
}

for (const status of [403, 404] as const) test(`오류: 지우기 ${status}는 감사만 남기고 대체 글을 달지 않으며 다시 시도하지 않는다`, async () => {
  f.rest.removeOwnReaction = async () => { log.push('remove rejected'); throw new DiscordRejected(status); };
  await answer('8501');
  await drain();
  await drain();
  assert.deepEqual(log, ['ack 8501', 'post fixture-thread', 'remove rejected']);
  assert.deepEqual(await audits('reaction_rejected'), [{ op: 'remove', emoji: '👀', status }]);
  assert.deepEqual(await audits('ack_reaction_fallback'), []);
  assert.equal((await database.db.query<{ state: string }>('SELECT state FROM outbox')).rows[0]!.state, 'sent');
});

test('오류: ⏳ 더하기 403은 감사만 남기고 대체 글이 없다', async () => {
  f.rest.addReaction = async () => { log.push('add rejected'); throw new DiscordRejected(403); };
  const release = holdModel();
  await f.ingress.receive(event('8502'));
  f.advance(DEFAULTS.debounceMs);
  const first = f.runtime.tick();
  await until(() => f.requests.length === 1);
  await f.ingress.receive(event('8503'));
  f.advance(DEFAULTS.debounceMs);
  await drain();
  await drain();
  assert.deepEqual(log, ['ack 8502', 'ack 8503', 'add rejected']);
  assert.deepEqual(await audits('reaction_rejected'), [{ op: 'add', emoji: '⏳', status: 403 }]);
  release();
  await first;
});

test('오류: 지우기 429는 채널 rate limit만 기록하고, 풀린 뒤 다시 지운다. 게시 상태는 그대로다', async () => {
  let limited = true;
  const remove = f.rest.removeOwnReaction;
  f.rest.removeOwnReaction = async (channel, message, emoji) => {
    if (limited) { limited = false; log.push('remove limited'); throw new RateLimited(2000); }
    return remove(channel, message, emoji);
  };
  await answer('8504');
  await drain();
  assert.deepEqual(log, ['ack 8504', 'post fixture-thread', 'remove limited']);
  assert.ok(await f.store.discordPauseUntil('fixture-thread') > f.now());
  assert.equal((await database.db.query<{ state: string }>('SELECT state FROM outbox')).rows[0]!.state, 'sent');
  await drain();
  assert.equal(log.length, 3, 'rate limit이 풀리기 전에는 다시 부르지 않는다');
  f.advance(2000);
  await drain();
  assert.deepEqual(log.slice(3), ['remove fixture-thread/8504 👀']);
  assert.deepEqual(await audits('reaction_rejected'), []);
});

test('오류: 반응 REST 일시 오류는 게시를 막지 않고 다시 시도하며, 한도를 넘으면 감사만 남기고 놓는다', async () => {
  f.rest.removeOwnReaction = async () => { log.push('remove failed'); throw new Error('discord_request_failed'); };
  await answer('8505');
  for (let i = 0; i < 10; i++) { await drain(); f.advance(60_000); }
  assert.equal(log.filter(line => line === 'remove failed').length, REACTION_ATTEMPTS);
  assert.deepEqual(await audits('reaction_abandoned'), [{ op: 'remove', emoji: '👀', attempts: REACTION_ATTEMPTS }]);
  assert.equal((await database.db.query<{ state: string }>('SELECT state FROM outbox')).rows[0]!.state, 'sent');
});

test('protocol 흐름: 반응 REST는 모두 @me이고 남의 반응을 지우는 호출은 0이다', async () => {
  const { api, calls } = fakeApi();
  const channelApi: DiscordApi = { async request(method, path, body, options) {
    if (method === 'GET' && path.startsWith('/channels/')) { calls.push({ method, path }); return { id: thread.channel, type: 11, parent_id: thread.parent, guild_id: thread.guild }; }
    return api.request(method, path, body, options);
  } };
  const protocol = new DiscordProtocol(channelApi, 'fixture-bot', f.now);
  const ingress = new DiscordIngress(f.store, f.gate, protocol);
  const publisher = new DiscordPublisher(f.store, f.gate, protocol);
  const release = holdModel();
  await ingress.receive(event('8601'));
  f.advance(DEFAULTS.debounceMs);
  const first = f.runtime.tick();
  await until(() => f.requests.length === 1);
  await ingress.receive(event('8602'));
  f.advance(DEFAULTS.debounceMs);
  while (await publisher.deliver());
  release();
  await first;
  while (await publisher.deliver());
  await f.runtime.tick();
  while (await publisher.deliver());
  const reactionCalls = calls.filter(c => c.path.includes('/reactions/'));
  assert.deepEqual(reactionCalls.map(c => `${c.method} ${c.path}`), [
    `PUT /channels/fixture-thread/messages/8601/reactions/${EYES}/@me`,
    `PUT /channels/fixture-thread/messages/8602/reactions/${EYES}/@me`,
    `PUT /channels/fixture-thread/messages/8602/reactions/${HOURGLASS}/@me`,
    `DELETE /channels/fixture-thread/messages/8601/reactions/${EYES}/@me`,
    `DELETE /channels/fixture-thread/messages/8602/reactions/${EYES}/@me`,
    `DELETE /channels/fixture-thread/messages/8602/reactions/${HOURGLASS}/@me`,
  ]);
  assert.equal(calls.filter(c => c.method === 'DELETE' && !c.path.endsWith('/@me')).length, 0);
});

test('재시작: 지우기 전에 게시 서버가 바뀌어도 저장된 반응 상태로 새 게시 서버가 지운다', async () => {
  f.rest.removeOwnReaction = async () => { log.push('remove timeout'); throw Object.assign(new Error('timeout'), { name: 'TimeoutError' }); };
  await answer('8701');
  await drain();
  assert.deepEqual(log, ['ack 8701', 'post fixture-thread', 'remove timeout']);
  const fresh = new MockDiscord();
  const restarted = new DiscordPublisher(new Store(database.db, f.now), f.gate, fresh);
  f.advance(60_000);
  while (await restarted.deliver());
  assert.deepEqual(fresh.reactions, [{ op: 'remove', channel: 'fixture-thread', message: '8701', emoji: '👀' }]);
  assert.equal(fresh.messages.length, 0, '답을 다시 게시하지 않는다');
  while (await restarted.deliver());
  assert.equal(fresh.reactions.length, 1);
});

test('채널 멘션: 스레드에서 답해도 반응은 채널에 있는 원문 메시지에서 지운다', async () => {
  const channel = { kind: 'channel' as const, guild: 'fixture-guild', channel: 'fixture-chat', parent: null };
  await f.ingress.receive(event('8801', { scope: channel }));
  await drain();
  f.advance(DEFAULTS.debounceMs);
  assert.equal(await f.runtime.tick(), true);
  await drain();
  const replies = f.rest.messages.map(m => m.channel);
  assert.deepEqual(replies, ['fixture-new-thread-0']);
  assert.deepEqual(f.rest.reactions, [{ op: 'remove', channel: 'fixture-chat', message: '8801', emoji: '👀' }]);
});

// 첫 대화 작업이 모델 자리를 쥔 채로 멈춰 있게 한다. release()로 답을 낸다.
function holdModel() {
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  f.setRun(async () => { await gate; return { status: 'succeeded', stopped: true, answer: { facts: [], hypotheses: [], unknowns: ['조회 전'], checks: [] } }; });
  return release;
}
async function until(check: () => boolean) {
  for (let i = 0; i < 200 && !check(); i++) await new Promise(resolve => setImmediate(resolve));
  assert.ok(check());
}

// 운영의 대화 루프는 tick()이 실행을 끝까지 기다린 뒤에야 다음 바퀴를 돈다. 그래서 실행 중에는 tick을 다시 부르지 않고
// 게시 루프(deliver)만 돌게 둔다. ⏳는 그 게시 루프에서 붙어야 한다.
test('흐름: 다른 모델 일 뒤에 기다리면 ⏳를 더하고, 답하면 👀·⏳를 모두 지움', async () => {
  const release = holdModel();
  await f.ingress.receive(event('8101'));
  f.advance(DEFAULTS.debounceMs);
  const first = f.runtime.tick();
  await until(() => f.requests.length === 1);
  await f.ingress.receive(event('8102', { text: '두 번째' }));
  await drain();
  assert.deepEqual(log, ['ack 8101', 'ack 8102'], '디바운스 전에는 아직 대기가 아니다');
  f.advance(DEFAULTS.debounceMs);
  await drain();
  assert.deepEqual(log.slice(2), ['add fixture-thread/8102 ⏳']);
  release();
  await first;
  await drain();
  assert.deepEqual(log.slice(3), ['post fixture-thread', 'remove fixture-thread/8101 👀'], '앞 메시지의 답은 뒤 메시지 반응을 건드리지 않는다');
  assert.equal(await f.runtime.tick(), true);
  await drain();
  assert.deepEqual(log.slice(5).sort(), ['post fixture-thread', 'remove fixture-thread/8102 ⏳', 'remove fixture-thread/8102 👀'].sort());
  assert.equal(log[5], 'post fixture-thread');
});

test('흐름: 디바운스 안에 온 뒤 메시지를 /cancel하면 밀려난 앞 메시지의 반응까지 지운다', async () => {
  await f.ingress.receive(event('9301'));
  await f.ingress.receive(event('9302', { text: '덧붙임' }));
  const states = (await database.db.query<{ state: string }>('SELECT state FROM jobs ORDER BY created_at, id')).rows.map(row => row.state).sort();
  assert.deepEqual(states, ['queued', 'superseded']);
  const job = (await database.db.query<{ id: string }>(`SELECT id FROM jobs WHERE state='queued'`)).rows[0]!.id;
  await f.ingress.receive(event('9303', { kind: 'command', command: 'cancel', target: job, mention: undefined, text: '' }));
  await drain();
  assert.deepEqual(log.filter(line => line.startsWith('remove')).sort(), ['remove fixture-thread/9301 👀', 'remove fixture-thread/9302 👀']);
  assert.equal((await database.db.query(`SELECT key FROM controls WHERE key LIKE 'reaction:%'`)).rows.length, 0, '반응 행이 남지 않는다');
});

test('오류: ⏳ 더하기가 실제로는 붙었는데 응답을 잃어도, 끝 상태에서 ⏳까지 지운다', async () => {
  const add = f.rest.addReaction;
  f.rest.addReaction = async (channel, message, emoji) => {
    await add(channel, message, emoji);
    throw Object.assign(new Error('timeout'), { name: 'TimeoutError' });
  };
  const release = holdModel();
  await f.ingress.receive(event('9201'));
  f.advance(DEFAULTS.debounceMs);
  const first = f.runtime.tick();
  await until(() => f.requests.length === 1);
  await f.ingress.receive(event('9202'));
  f.advance(DEFAULTS.debounceMs);
  await drain();
  assert.deepEqual(log, ['ack 9201', 'ack 9202', 'add fixture-thread/9202 ⏳']);
  release();
  await first;
  await drain();
  assert.equal(await f.runtime.tick(), true);
  f.advance(60_000);
  await drain();
  assert.deepEqual(log.filter(line => line.startsWith('remove')).sort(),
    ['remove fixture-thread/9201 👀', 'remove fixture-thread/9202 ⏳', 'remove fixture-thread/9202 👀']);
});

// 실제 시계로 기다린다. 게시 루프가 반응 동기화를 기다리는 상한은 실제 시간이다.
async function within<T>(work: Promise<T>, ms: number): Promise<T | 'timeout'> {
  let timer!: NodeJS.Timeout;
  const timeout = new Promise<'timeout'>(resolve => { timer = setTimeout(() => resolve('timeout'), ms); });
  try { return await Promise.race([work, timeout]); } finally { clearTimeout(timer); }
}
async function eventually(check: () => boolean, ms = 3000) {
  const end = Date.now() + ms;
  while (!check() && Date.now() < end) await new Promise(resolve => setTimeout(resolve, 10));
  assert.ok(check());
}

test('게시: 반응 REST가 멈춰도 게시 루프는 짧은 상한 뒤 돌아와 다음 답을 게시한다', async () => {
  let unstick!: () => void;
  const stuck = new Promise<void>(resolve => { unstick = resolve; });
  const remove = f.rest.removeOwnReaction;
  f.rest.removeOwnReaction = async (channel, message, emoji) => {
    if (message === '9101') await stuck;
    return remove(channel, message, emoji);
  };
  await answer('9101');
  assert.equal(await within(f.publisher.deliver(), 3000), true, '반응 지우기를 기다리느라 게시 루프가 멈추지 않는다');
  await answer('9102');
  assert.notEqual(await within(drain(), 6000), 'timeout');
  assert.deepEqual(log, ['ack 9101', 'post fixture-thread', 'ack 9102', 'post fixture-thread'], '앞 반응이 끝나기 전에 다음 답이 게시된다');
  unstick();
  await eventually(() => log.includes('remove fixture-thread/9101 👀'));
  await drain();
  assert.deepEqual(log.filter(line => line.startsWith('remove')).sort(), ['remove fixture-thread/9101 👀', 'remove fixture-thread/9102 👀']);
});

test('흐름: 앞 답이 아직 unknown인데 뒤 메시지를 /cancel해도 앞 메시지 반응은 그 답이 sent로 확정될 때까지 남긴다', async () => {
  await answer('9401');
  f.rest.loseResponse = true;
  await drain();
  assert.equal((await database.db.query<{ state: string }>('SELECT state FROM outbox')).rows[0]!.state, 'unknown');
  f.rest.loseResponse = false;
  await f.ingress.receive(event('9402', { text: '하나 더' }));
  const job = (await database.db.query<{ id: string }>(`SELECT id FROM jobs WHERE state='queued'`)).rows[0]!.id;
  await f.ingress.receive(event('9403', { kind: 'command', command: 'cancel', target: job, mention: undefined, text: '' }));
  await drain();
  assert.deepEqual(log.filter(line => line.startsWith('remove')), ['remove fixture-thread/9402 👀'], '게시가 미확정인 앞 답의 👀는 남는다');
  await f.publisher.reconcile();
  await drain();
  assert.deepEqual(log.filter(line => line.startsWith('remove')), ['remove fixture-thread/9402 👀', 'remove fixture-thread/9401 👀']);
});
