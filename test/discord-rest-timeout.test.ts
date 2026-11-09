import { after, before, beforeEach, test } from 'node:test';
import assert from 'node:assert/strict';
import { DiscordRejected, DiscordUnauthorized, RateLimited } from '../src/contracts.js';
import { DiscordIngress, ackFailureReason } from '../src/discord.js';
import { DISCORD_DISPATCH_REST_TIMEOUT_MS, DISCORD_REST_TIMEOUT_MS, DiscordProtocol, discordHttpApi } from '../src/discord-protocol.js';
import type { DiscordApi, DiscordRequestOptions } from '../src/discord-protocol.js';
import { event, fixture, localDatabase, thread } from './helpers.js';

// S16: REST 제한은 경로마다 다르다. 상호작용 callback은 그 상호작용 기한까지, 나머지 REST는 5초,
// Gateway dispatch 안의 REST(채널 조회·👀 리액션)는 뒤 이벤트를 막지 않게 짧은 제한을 둔다.

// signal을 지키는 가짜 fetch: delayMs 뒤 204, 그 전에 signal이 끊기면 그 사유로 실패한다.
function slowSend(delayMs: number): typeof fetch {
  return (async (_url: string, init: RequestInit) => new Promise<Response>((resolve, reject) => {
    const timer = setTimeout(() => resolve(new Response(null, { status: 204 })), delayMs);
    init.signal?.addEventListener('abort', () => { clearTimeout(timer); reject(init.signal!.reason); }, { once: true });
  })) as typeof fetch;
}

test('discordHttpApi: 상호작용 callback은 1초를 넘겨도 기한 안이면 성공한다', async () => {
  const api = discordHttpApi('fixture-token', slowSend(1200));
  assert.equal(await api.request('POST', '/interactions/1/t/callback', {}, { expiresAt: Date.now() + 2500 }), undefined);
});

test('discordHttpApi: 상호작용 callback이 기한을 넘기면 시간 초과로 실패한다', async () => {
  const api = discordHttpApi('fixture-token', slowSend(1200));
  await assert.rejects(api.request('POST', '/interactions/1/t/callback', {}, { expiresAt: Date.now() + 300 }),
    (error: unknown) => (error as { name?: string }).name === 'TimeoutError');
});

test('discordHttpApi: 기한 없는 요청은 5초, timeoutMs를 주면 그 값, 기한은 남은 시간(상한 없음)', async t => {
  const timeouts: number[] = [];
  t.mock.method(AbortSignal, 'timeout', (ms: number) => { timeouts.push(ms); return new AbortController().signal; });
  let time = 1_000_000;
  const api = discordHttpApi('fixture-token', async () => new Response(null, { status: 204 }), () => time);
  await api.request('GET', '/channels/1');
  await api.request('PUT', '/channels/1/messages/2/reactions/x/@me', undefined, { timeoutMs: 1000 });
  await api.request('POST', '/interactions/1/t/callback', {}, { expiresAt: time + 2500 });
  assert.equal(DISCORD_REST_TIMEOUT_MS, 5000);
  assert.deepEqual(timeouts, [5000, 1000, 2500]);
  time += 2500;
  await assert.rejects(api.request('POST', '/interactions/1/t/callback', {}, { expiresAt: time }), /interaction_expired/);
});

test('protocol: Gateway dispatch 안의 채널 조회·리액션은 짧은 제한, history·게시는 기본 제한', async () => {
  const seen: { method: string; path: string; options?: DiscordRequestOptions }[] = [];
  const api: DiscordApi = { async request(method, path, _body, options) {
    seen.push({ method, path, options });
    if (method === 'GET' && path.startsWith('/channels/fixture-thread/messages')) return [];
    if (method === 'GET') return { id: thread.channel, type: 11, parent_id: thread.parent, guild_id: thread.guild };
    return method === 'PUT' ? undefined : { id: '1' };
  } };
  const protocol = new DiscordProtocol(api, 'fixture-bot');
  await protocol.gateway('MESSAGE_CREATE', { id: '7001', channel_id: thread.channel, guild_id: thread.guild,
    author: { id: 'fixture-owner' }, content: 'x' }, { receive: async () => undefined });
  await protocol.acknowledge(event('7001'), 'x', { allowed_mentions: { parse: [] } });
  const dispatch = seen.splice(0);
  assert.deepEqual(dispatch.map(s => s.options), [{ timeoutMs: DISCORD_DISPATCH_REST_TIMEOUT_MS }, { timeoutMs: DISCORD_DISPATCH_REST_TIMEOUT_MS }]);
  await protocol.history(thread.channel, null, 100);
  await protocol.sendMessage(thread.channel, { content: 'x', nonce: 'n', enforce_nonce: true, allowed_mentions: { parse: [] } });
  // 반응 상태 동기화(⏳·지우기)는 게시 루프에서 돈다. dispatch 밖이라 기본 제한이다.
  await protocol.addReaction(thread.channel, '7001', '⏳');
  await protocol.removeOwnReaction(thread.channel, '7001', '👀');
  assert.deepEqual(seen.map(s => s.options), [undefined, undefined, undefined, undefined, undefined]);
});

test('ackFailureReason: 원문 없이 원인만 분류한다', () => {
  assert.equal(ackFailureReason(new DOMException('The operation was aborted due to timeout', 'TimeoutError')), 'timeout');
  assert.equal(ackFailureReason(new Error('interaction_expired')), 'expired');
  assert.equal(ackFailureReason(new RateLimited(1500)), 'rate_limited');
  assert.equal(ackFailureReason(new DiscordRejected(404)), 'rejected:404');
  assert.equal(ackFailureReason(new DiscordUnauthorized()), 'unauthorized');
  assert.equal(ackFailureReason(new Error('discord_global_pause')), 'paused');
  assert.equal(ackFailureReason(new Error('discord_request_failed')), 'http_error');
  assert.equal(ackFailureReason(new Error('secret token in message')), 'error');
  assert.equal(ackFailureReason('raw'), 'error');
});

let database: Awaited<ReturnType<typeof localDatabase>>;
let f: Awaited<ReturnType<typeof fixture>>;
before(async () => { database = await localDatabase(); });
beforeEach(async () => {
  await database.pg.exec('TRUNCATE events,conversations,jobs,results,outbox,schedules,denied_actors,controls,audit,incidents RESTART IDENTITY CASCADE');
  f = await fixture(database.db);
});
after(async () => { await database.pg.close(); });
const audits = async () => (await database.db.query<{ kind: string; detail: unknown }>("SELECT kind,detail FROM audit WHERE kind='ack_uncertain'")).rows;

for (const [name, error, reason] of [
  ['timeout', new DOMException('aborted', 'TimeoutError'), 'timeout'],
  ['expired', new Error('interaction_expired'), 'expired'],
  ['429', new RateLimited(2000), 'rate_limited'],
  ['404', new DiscordRejected(404), 'rejected:404'],
] as const) test(`수신: 상호작용 ACK 실패(${name})는 ack_uncertain detail에 reason을 남긴다`, async () => {
  f.rest.acknowledge = async () => { throw error; };
  await f.ingress.receive(event(`ack-${name}`, { kind: 'command', command: 'chat' }));
  assert.deepEqual((await audits()).map(a => a.detail), [{ processing: 'durable', reason }]);
});

test('수신: 실제 protocol에서 기한이 지난 상호작용은 callback 없이 reason=expired', async () => {
  let callbacks = 0;
  const protocol = new DiscordProtocol({ async request(method, path) {
    if (path.endsWith('/callback')) { callbacks++; return undefined; }
    if (method === 'GET') return { id: thread.channel, type: 11, parent_id: thread.parent, guild_id: thread.guild };
    throw new Error('unexpected');
  } }, 'fixture-bot', f.now);
  const save = f.store.save.bind(f.store);
  f.store.save = async (...args) => { const result = await save(...args); f.advance(1400); return result; };
  const ingress = new DiscordIngress(f.store, f.gate, protocol);
  // 저장은 inbox 마감(1500ms) 안에 끝나고, ACK 직전 확인이 늦어져 상호작용 기한(2500ms)을 넘긴다.
  const pause = f.store.discordPauseUntil.bind(f.store);
  f.store.discordPauseUntil = async channel => { const result = await pause(channel); f.advance(1200); return result; };
  await protocol.gateway('INTERACTION_CREATE', { id: 'fixture-late', token: 'fixture-ephemeral-token', type: 2, channel_id: thread.channel,
    guild_id: thread.guild, member: { user: { id: f.policy.owner } }, data: { name: 'chat' } }, ingress);
  assert.equal(callbacks, 0);
  assert.deepEqual((await audits()).map(a => a.detail), [{ processing: 'durable', reason: 'expired' }]);
});
