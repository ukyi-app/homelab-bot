import { after, before, beforeEach, test } from 'node:test';
import assert from 'node:assert/strict';
import { DiscordProtocol, discordHttpApi } from '../src/discord-protocol.js';
import type { DiscordApi } from '../src/discord-protocol.js';
import { DEFAULTS } from '../src/contracts.js';
import { event, fixture, localDatabase } from './helpers.js';

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
  assert.equal(await f.runtime.tick(), false);
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
