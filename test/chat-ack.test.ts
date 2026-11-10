import { after, before, beforeEach, test } from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULTS, DiscordRejected, RateLimited } from '../src/contracts.js';
import type { EventInput } from '../src/contracts.js';
import { DiscordIngress } from '../src/discord.js';
import type { DiscordRest } from '../src/discord.js';
import { DiscordProtocol, discordHttpApi } from '../src/discord-protocol.js';
import type { DiscordApi } from '../src/discord-protocol.js';
import { event, fixture, localDatabase, thread } from './helpers.js';

// 개선안 v2 C2: 일반 메시지 수신 표시는 👀 리액션. 권한 거부면 텍스트 ACK로 한 번 대체한다.
type Call = { method: string; path: string; body?: unknown };
const EYES = '/reactions/%F0%9F%91%80/@me';
function fakeApi(fail?: (call: Call) => Error | undefined) {
  const calls: Call[] = [];
  const api: DiscordApi = {
    async request(method, path, body) {
      const call = { method, path, body };
      calls.push(call);
      const error = fail?.(call);
      if (error) throw error;
      if (method === 'GET' && path.startsWith('/channels/')) return { id: thread.channel, type: 11, parent_id: thread.parent, guild_id: thread.guild };
      return method === 'PUT' ? undefined : { id: '1' };
    },
  };
  return { api, calls };
}
const reactions = (calls: Call[]) => calls.filter(c => c.method === 'PUT' && c.path.endsWith(EYES));
const texts = (calls: Call[]) => calls.filter(c => c.method === 'POST' && c.path.endsWith('/messages'));

test('protocol: 일반 메시지는 👀 리액션 한 번, 텍스트 ACK 없음', async () => {
  const { api, calls } = fakeApi();
  await new DiscordProtocol(api, 'fixture-bot').acknowledge(event('5001'), '본문', { allowed_mentions: { parse: [] } });
  assert.deepEqual(calls.map(c => [c.method, c.path]), [['PUT', `/channels/fixture-thread/messages/5001${EYES}`]]);
  assert.equal(calls[0]!.body, undefined);
});

for (const status of [403, 404] as const) test(`protocol: 리액션 ${status} 거부는 텍스트 ACK로 한 번 대체`, async () => {
  const { api, calls } = fakeApi(c => c.method === 'PUT' ? new DiscordRejected(status) : undefined);
  const outcome = await new DiscordProtocol(api, 'fixture-bot').acknowledge(event('5002'), '수신 본문', { allowed_mentions: { parse: [] } });
  assert.equal(reactions(calls).length, 1);
  assert.equal(texts(calls).length, 1);
  assert.deepEqual(texts(calls)[0]!.body, { content: '수신 본문', nonce: '5002', enforce_nonce: true, allowed_mentions: { parse: [] } });
  assert.deepEqual(outcome, { fallback: status });
});

test('protocol: 리액션 429는 대체 게시 없이 그대로 던진다', async () => {
  const { api, calls } = fakeApi(c => c.method === 'PUT' ? new RateLimited(1500) : undefined);
  await assert.rejects(new DiscordProtocol(api, 'fixture-bot').acknowledge(event('5003'), 'x', { allowed_mentions: { parse: [] } }), RateLimited);
  assert.equal(texts(calls).length, 0);
});

test('protocol: 400 같은 다른 거부는 대체하지 않는다', async () => {
  const { api, calls } = fakeApi(c => c.method === 'PUT' ? new DiscordRejected(400) : undefined);
  await assert.rejects(new DiscordProtocol(api, 'fixture-bot').acknowledge(event('5004'), 'x', { allowed_mentions: { parse: [] } }), DiscordRejected);
  assert.equal(texts(calls).length, 0);
});

test('discordHttpApi: 리액션 PUT은 본문 없이 보내고 204 빈 응답을 받는다', async () => {
  const seen: { url: string; method?: string; body?: unknown }[] = [];
  const api = discordHttpApi('fixture-token', (async (url: string, init: RequestInit) => {
    seen.push({ url, method: init.method, body: init.body });
    return new Response(null, { status: 204 });
  }) as typeof fetch);
  assert.equal(await api.request('PUT', `/channels/1/messages/2${EYES}`), undefined);
  assert.deepEqual(seen, [{ url: `https://discord.com/api/v10/channels/1/messages/2${EYES}`, method: 'PUT', body: undefined }]);
});

let database: Awaited<ReturnType<typeof localDatabase>>;
let f: Awaited<ReturnType<typeof fixture>>;
before(async () => { database = await localDatabase(); });
beforeEach(async () => {
  await database.pg.exec('TRUNCATE events,conversations,jobs,results,outbox,schedules,denied_actors,controls,audit,incidents RESTART IDENTITY CASCADE');
  f = await fixture(database.db);
});
after(async () => { await database.pg.close(); });
async function rows(table: string) { return (await database.db.query<Record<string, any>>(`SELECT * FROM ${table}`)).rows; }
// 실제 protocol의 acknowledge를 fixture 수신 경로에 끼운다. history 등 나머지는 MockDiscord 그대로다.
function wire(fail?: (call: Call) => Error | undefined) {
  const { api, calls } = fakeApi(fail);
  const protocol = new DiscordProtocol(api, 'fixture-bot', f.now);
  (f.rest as DiscordRest).acknowledge = (e, content, options) => protocol.acknowledge(e, content, options);
  return { protocol, calls };
}

test('수신: 일반 메시지 → 리액션 1회, 텍스트 없음, 중복 이벤트에는 다시 달지 않음', async () => {
  const { calls } = wire();
  await f.ingress.receive(event('6001'));
  await f.ingress.receive(event('6001'));
  assert.equal(reactions(calls).length, 1);
  assert.equal(texts(calls).length, 0);
  assert.equal((await rows('jobs')).length, 1);
});

test('수신: 권한 거부 대체는 감사에 남는다', async () => {
  const { calls } = wire(c => c.method === 'PUT' ? new DiscordRejected(403) : undefined);
  await f.ingress.receive(event('6002'));
  assert.equal(texts(calls).length, 1);
  const audit = (await rows('audit')).filter(a => a.kind === 'ack_reaction_fallback');
  assert.equal(audit.length, 1); assert.deepEqual(audit[0]!.detail, { status: 403 });
  assert.equal((await rows('audit')).some(a => a.kind === 'ack_uncertain'), false);
});

test('수신: 리액션 429는 채널 rate limit을 기록하고 대체 게시하지 않음', async () => {
  const { calls } = wire(c => c.method === 'PUT' ? new RateLimited(2000) : undefined);
  await f.ingress.receive(event('6003'));
  assert.equal(texts(calls).length, 0);
  assert.ok(await f.store.discordPauseUntil(thread.channel) > f.now());
  assert.equal((await rows('jobs')).length, 1);
});

test('수신: history 복구로 받은 메시지에는 표시하지 않음', async () => {
  const { calls } = wire();
  await f.ingress.receive(event('6010'));
  f.rest.pages = [[event('6011', { text: '복구 1' }), event('6012', { text: '복구 2' })]];
  assert.equal(await f.ingress.recover(thread, f.policy.owner), 'done');
  assert.equal((await rows('events')).length, 3);
  assert.equal(reactions(calls).length, 1);
  assert.equal(texts(calls).length, 0);
});

test('수신: 상호작용 ACK는 ephemeral 콜백 그대로', async () => {
  const { protocol, calls } = wire();
  const ingress = new DiscordIngress(f.store, f.gate, protocol);
  await f.ingress.receive(event('6020'));
  await protocol.gateway('INTERACTION_CREATE', { id: '6021', token: 'fixture-token', type: 2, channel_id: thread.channel,
    guild_id: thread.guild, member: { user: { id: f.policy.owner } }, data: { name: 'list' } }, ingress);
  const callback = calls.find(c => c.path === '/interactions/6021/fixture-token/callback');
  assert.ok(callback);
  assert.equal((callback.body as { type: number; data: { flags: number } }).data.flags, 64);
  assert.equal(reactions(calls).length, 1);
});

// ACK 단계에서 나는 어떤 오류도 이미 영속된 처리 결과를 바꾸거나 receive() 밖으로 나가면 안 된다(main의 guard()가 gap을 세운다).
for (const broken of ['recordRateLimit', 'atomic'] as const) test(`수신: ACK 실패 처리 중 DB 오류(${broken})도 receive() 밖으로 안 나감`, async () => {
  const logs: string[] = [];
  const ingress = new DiscordIngress(f.store, f.gate, f.rest, true, undefined, (name: string) => { logs.push(name); });
  f.rest.acknowledge = async () => { throw new RateLimited(2000); };
  const atomic = f.store.atomic.bind(f.store);
  let routed = false;
  f.store.recordRateLimit = async () => { throw new Error('db_down'); };
  if (broken === 'atomic') {
    f.store.recordRateLimit = async () => {};
    // route transaction은 통과시키고, ACK 실패 감사 transaction부터 실패시킨다.
    f.store.atomic = (async (fn: never, deadline?: never) => {
      if (routed) throw new Error('db_down');
      routed = true; return atomic(fn, deadline);
    }) as typeof f.store.atomic;
  }
  const saved = await ingress.receive(event('6030'));
  assert.ok(saved);
  assert.equal((await rows('jobs')).length, 1);
  assert.equal((await rows('events'))[0]!.accepted, true);
  assert.deepEqual(logs, ['ack_failure_unrecorded']);
  f.advance(DEFAULTS.debounceMs);
  assert.ok(await f.store.claim());
});

test('수신: 대체 감사 쓰기 실패도 receive() 밖으로 안 나감', async () => {
  const logs: string[] = [];
  const ingress = new DiscordIngress(f.store, f.gate, f.rest, true, undefined, (name: string) => { logs.push(name); });
  (f.rest as DiscordRest).acknowledge = async () => ({ fallback: 404 as const });
  const audit = f.store.audit.bind(f.store);
  f.store.audit = (async (kind: string, ...rest: never[]) => {
    if (kind === 'ack_reaction_fallback') throw new Error('db_down');
    return (audit as (...args: unknown[]) => Promise<void>)(kind, ...rest);
  }) as typeof f.store.audit;
  await ingress.receive(event('6040'));
  assert.equal((await rows('jobs')).length, 1);
  assert.deepEqual(logs, ['ack_failure_unrecorded']);
});

test('수신: 명령/버튼 모드 문구는 그대로 텍스트 ACK 대상이 아니다(일반 메시지 무시)', async () => {
  const { calls } = wire();
  const ingress = new DiscordIngress(f.store, f.gate, f.rest, false);
  await ingress.receive(event('6050') as EventInput);
  assert.equal(calls.length, 0);
});

// C11 ack_only(AC-14 👍): 답할 필요가 없는 말에는 글 없이 👀를 거두고 👍만 남긴다. 반응 REST는 실제 protocol 경로로 본다.
const THUMBS = '%F0%9F%91%8D';
function wireReactions() {
  const wired = wire();
  const rest = f.rest as DiscordRest;
  rest.addReaction = (channel, message, emoji) => wired.protocol.addReaction(channel, message, emoji);
  rest.removeOwnReaction = (channel, message, emoji) => wired.protocol.removeOwnReaction(channel, message, emoji);
  return wired.calls;
}
const writes = (calls: Call[]) => calls.filter(c => c.method !== 'GET').map(c => `${c.method} ${c.path}`);
async function drain() { while (await f.publisher.deliver()); }

test('ack_only: 글 없이 👀를 지우고 👍만 단다. 결과는 저장되고 다음 대화 기록의 봇 항목에는 들지 않는다', async () => {
  const calls = wireReactions();
  f.setRun(async () => ({ status: 'succeeded', stopped: true, output: { reply: '', proposal: null, ack_only: true }, rateLimit: null }));
  await f.ingress.receive(event('6101', { text: '고마워' }));
  f.advance(DEFAULTS.debounceMs);
  assert.equal(await f.runtime.tick(), true);
  await drain();
  const base = '/channels/fixture-thread/messages/6101/reactions';
  assert.deepEqual(writes(calls), [`PUT ${base}/%F0%9F%91%80/@me`, `PUT ${base}/${THUMBS}/@me`, `DELETE ${base}/%F0%9F%91%80/@me`]);
  assert.equal(f.rest.messages.length, 0);
  assert.equal((await rows('outbox')).length, 0);
  assert.equal((await rows('jobs'))[0]!.state, 'succeeded');
  assert.deepEqual((await rows('results'))[0]!.result, { reply: '', ack_only: true });
  // 끝 상태라 반응 행을 지우고, 다시 돌아도 더 부르지 않는다.
  assert.equal((await rows('controls')).filter(c => c.key.startsWith('reaction:')).length, 0);
  await drain();
  assert.equal(writes(calls).length, 3);
  f.setRun(async () => ({ status: 'succeeded', stopped: true, output: { reply: '네.', proposal: null, ack_only: false }, rateLimit: null }));
  await f.ingress.receive(event('6102', { text: '다음 질문' }));
  f.advance(DEFAULTS.debounceMs); await f.runtime.tick();
  assert.deepEqual((f.requests.at(-1)!.untrusted as { from: string }[]).map(item => item.from), ['owner', 'owner']);
});

test('ack_only: 디바운스로 밀려난 앞 메시지는 👍 없이 반응만 지운다', async () => {
  const calls = wireReactions();
  f.setRun(async () => ({ status: 'succeeded', stopped: true, output: { reply: '', proposal: null, ack_only: true }, rateLimit: null }));
  await f.ingress.receive(event('6201', { text: '아' }));
  await f.ingress.receive(event('6202', { text: '고마워' }));
  f.advance(DEFAULTS.debounceMs);
  await f.runtime.tick(); await drain();
  const thumbs = writes(calls).filter(line => line.includes(THUMBS));
  assert.deepEqual(thumbs, [`PUT /channels/fixture-thread/messages/6202/reactions/${THUMBS}/@me`]);
  assert.ok(writes(calls).includes('DELETE /channels/fixture-thread/messages/6201/reactions/%F0%9F%91%80/@me'));
});

// 반응을 달 owner 메시지가 없는 요청(/chat 명령)은 👍 대신 짧은 고정 완료 글 하나로 끝을 알린다. 모델 글은 싣지 않는다.
test('ack_only: 반응을 달 수 없는 /chat 명령은 고정 완료 글 하나만 게시한다', async () => {
  // 상호작용 ACK는 MockDiscord 그대로 두고(가짜 상호작용에는 콜백 토큰이 없다) 반응 REST만 실제 protocol로 본다.
  const acknowledge = f.rest.acknowledge;
  const calls = wireReactions();
  (f.rest as DiscordRest).acknowledge = acknowledge;
  f.setRun(async () => ({ status: 'succeeded', stopped: true, output: { reply: '모델 글', proposal: null, ack_only: true }, rateLimit: null }));
  await f.ingress.receive(event('6401', { kind: 'command', command: 'chat', mention: undefined, text: '고마워' }));
  f.advance(DEFAULTS.debounceMs);
  assert.equal(await f.runtime.tick(), true);
  await drain();
  assert.equal(writes(calls).filter(line => line.includes(THUMBS)).length, 0);
  // 게시 글 끝의 대조 표식 줄(-# ref:)은 빼고 본문만 본다.
  assert.deepEqual(f.rest.messages.map(m => m.body.content.split('\n')[0]), ['알겠어요.']);
  assert.equal(f.rest.messages[0]!.body.message_reference, undefined);
  assert.equal((await rows('jobs')).find(j => j.type === 'chat')!.state, 'succeeded');
  assert.deepEqual((await rows('results'))[0]!.result, { reply: '', ack_only: true });
});

// C04에서 넘어온 정리(봇 PR #114 Codex 3차 P2): 실행 중 /stop으로 구독이 꺼진 뒤 성공이 오면 답 없이 superseded로 끝나고,
// 게시 확정 쪽 정리가 오지 않으므로 그 종료와 함께 반응을 지운다.
test('실행 중 /stop → 성공 → 답 없이 superseded, 👀와 반응 행도 정리', async () => {
  const calls = wireReactions();
  let finish!: (value: { status: 'succeeded'; stopped: true; output: { reply: string; proposal: null; ack_only: false }; rateLimit: null }) => void;
  f.setRun(() => new Promise(resolve => { finish = resolve; }));
  await f.ingress.receive(event('6301'));
  f.advance(DEFAULTS.debounceMs);
  const running = f.runtime.tick();
  while (!finish) await new Promise(resolve => setImmediate(resolve));
  await f.ingress.receive(event('6302', { kind: 'command', command: 'stop', mention: undefined, text: '' }));
  finish({ status: 'succeeded', stopped: true, output: { reply: '늦은 답', proposal: null, ack_only: false }, rateLimit: null });
  await running;
  await drain();
  const job = (await rows('jobs')).find(j => j.type === 'chat')!;
  assert.equal(job.state, 'superseded');
  assert.ok(!f.rest.messages.some(m => m.body.content.includes('늦은 답')));
  assert.ok(writes(calls).includes('DELETE /channels/fixture-thread/messages/6301/reactions/%F0%9F%91%80/@me'), writes(calls).join('\n'));
  assert.equal((await rows('controls')).filter(c => c.key.startsWith('reaction:')).length, 0);
});
