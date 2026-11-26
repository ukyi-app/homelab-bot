import { after, before, beforeEach, test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readdir, readFile } from 'node:fs/promises';
import { Denied } from '../src/contracts.js';
import type { Scope } from '../src/contracts.js';
import { discordHttpApi } from '../src/discord-protocol.js';
import { GitHubApi } from '../src/github-app.js';
import { checkOutbound, finalPayload, OUTBOUND_RULES_REVISION, OutboundBytes, OutboundRefused, sendOutbound } from '../src/outbound.js';
import type { OutboundCheck, OutboundPayload, OutboundPorts, OutboundTarget } from '../src/outbound.js';
import { fixture, localDatabase, thread } from './helpers.js';

// O08 F6 발송 한 길. 묶음 규칙(바이트·digest·정책 판·목적지), 발송함 대조, 고치기, 전송층의 막음, 정적 허용 목록, 포트 흔들기 훑기.
let database: Awaited<ReturnType<typeof localDatabase>>;
let f: Awaited<ReturnType<typeof fixture>>;
before(async () => { database = await localDatabase(); });
beforeEach(async () => {
  await database.pg.exec('TRUNCATE events,conversations,jobs,results,outbox,schedules,denied_actors,controls,audit,incidents RESTART IDENTITY CASCADE');
  f = await fixture(database.db);
});
after(async () => { await database.pg.close(); });
const sha256 = (text: string) => createHash('sha256').update(text, 'utf8').digest('hex');
const channelScope: Scope = { ...thread, kind: 'channel', channel: 'fixture-chat', parent: null };
const message = (content = '공개 답') => ({ content, nonce: 'n-1', enforce_nonce: true, allowed_mentions: { parse: [] } });
const target: OutboundTarget = { kind: 'discord-message', channel: 'fixture-chat' };
type Wired = { method: string; path: string; bytes: string };
function ports(over: Partial<OutboundPorts> = {}): OutboundPorts & { wired: Wired[] } {
  const wired: Wired[] = [];
  return { wired, revision: () => 'fixture-v1', ledger: { admit: async () => true },
    wire: { wire: async (method, path, body) => { wired.push({ method, path, bytes: body.bytes }); return { id: 'm-1' }; } }, ...over };
}
const refused = (reason: string) => (error: unknown) => error instanceof OutboundRefused && error.reason === reason;
async function enqueue(key: string, content: string, scope: Scope = channelScope) {
  await f.store.enqueue({ key, actor: f.policy.owner, scope, revision: f.policy.revision,
    payload: { kind: 'message', channel: scope.channel, content, classification: 'safe_summary' } });
}
const outbox = async () => (await database.db.query<{ id: string; state: string; external_id: string | null; sent_digest: string | null; lease_token: string }>(
  'SELECT id,state,external_id,sent_digest,lease_token FROM outbox ORDER BY created_at,page_index')).rows;

test('묶음: 검사한 바이트를 그대로, 목적지에서 만든 경로로 보낸다', async () => {
  const payload = finalPayload(target, message());
  const check = checkOutbound(payload, { policyRevision: 'fixture-v1' });
  assert.equal(check.digest, sha256(payload.bytes));
  assert.equal(check.rules, OUTBOUND_RULES_REVISION);
  const p = ports();
  assert.deepEqual(await sendOutbound(payload, check, p), { id: 'm-1' });
  assert.deepEqual(p.wired, [{ method: 'POST', path: '/channels/fixture-chat/messages', bytes: payload.bytes }]);
});

test('묶음: 검사 뒤 payload 한 글자를 바꾸면 보내지 않는다', async () => {
  const payload = finalPayload(target, message('공개 답'));
  const check = checkOutbound(payload, { policyRevision: 'fixture-v1' });
  const changed: OutboundPayload = { target: payload.target, bytes: payload.bytes.replace('공개 답', '공개 닶') };
  const p = ports();
  await assert.rejects(sendOutbound(changed, check, p), refused('payload_changed'));
  assert.deepEqual(p.wired, []);
});

test('묶음: 목적지를 바꾸면 보내지 않는다(채널·스레드 원글·고칠 글·GitHub 경로)', async () => {
  const cases: [OutboundTarget, OutboundTarget, unknown][] = [
    [target, { kind: 'discord-message', channel: 'fixture-other' }, message()],
    [{ kind: 'discord-thread', channel: 'fixture-chat', from: '7301' }, { kind: 'discord-thread', channel: 'fixture-chat', from: '7302' }, { name: '제목', auto_archive_duration: 1440 }],
    [{ kind: 'discord-edit', channel: 'fixture-chat', message: '1' }, { kind: 'discord-edit', channel: 'fixture-chat', message: '2' }, { content: 'x', allowed_mentions: { parse: [] } }],
    [{ kind: 'github', method: 'POST', path: '/repos/o/r/pulls/1/reviews' }, { kind: 'github', method: 'POST', path: '/repos/o/r/pulls/2/reviews' }, { body: 'x' }],
  ];
  for (const [checked, moved, body] of cases) {
    const payload = finalPayload(checked, body);
    const check = checkOutbound(payload, { policyRevision: 'fixture-v1', scan: () => null });
    const p = ports();
    await assert.rejects(sendOutbound({ target: moved, bytes: payload.bytes }, check, p), refused('target_changed'), moved.kind);
    assert.deepEqual(p.wired, [], moved.kind);
  }
});

test('묶음: 이 파일이 만들지 않은 검사 결과, 바뀐 정책 판, 발송함 대조 실패는 보내지 않는다', async () => {
  const payload = finalPayload(target, message());
  const forged: OutboundCheck = { target, digest: sha256(payload.bytes), policyRevision: 'fixture-v1', rules: OUTBOUND_RULES_REVISION };
  const p = ports();
  await assert.rejects(sendOutbound(payload, forged, p), refused('unchecked'));
  const check = checkOutbound(payload, { policyRevision: 'fixture-v1' });
  await assert.rejects(sendOutbound(payload, check, ports({ revision: () => 'fixture-v2' })), refused('policy_changed'));
  await assert.rejects(sendOutbound(payload, check, ports({ ledger: { admit: async () => false } })), refused('outbox_mismatch'));
  assert.ok(Object.isFrozen(check) && Object.isFrozen(check.target));
  assert.deepEqual(p.wired, []);
});

test('검사: 모양(상한·알림·고치기 칸·경로)과 공개 검사 고리가 걸리면 결과를 만들지 않는다', () => {
  const bad: [OutboundTarget, unknown][] = [
    [target, message('가'.repeat(2001))],
    [target, { ...message(), allowed_mentions: { parse: ['everyone'] } }],
    [target, { ...message(), allowed_mentions: { parse: [], users: ['a', 'b'] } }],
    [{ kind: 'discord-edit', channel: 'fixture-chat', message: '1' }, { content: 'x', allowed_mentions: { parse: [] }, components: [] }],
    [{ kind: 'discord-thread', channel: 'fixture-chat', from: '1' }, { name: '제목', type: 11, auto_archive_duration: 1440 }],
    [{ kind: 'discord-message', channel: '../x' }, message()],
    [{ kind: 'github', method: 'POST', path: '/repos/o/../pulls/1/reviews' }, { body: 'x' }],
    [{ kind: 'github', method: 'POST', path: '/graphql' }, { query: 'x' }],
  ];
  // 통과하는 scan을 넘겨, GitHub 사례도 scan이 없어서가 아니라 모양 때문에 걸리는지 본다.
  for (const [where, body] of bad) assert.throws(() => checkOutbound(finalPayload(where, body), { policyRevision: 'fixture-v1', scan: () => null }), refused('shape'), JSON.stringify(where));
  const scan = (texts: readonly string[]) => texts.some(text => text.includes('ghp_')) ? 'secret' : null;
  assert.throws(() => checkOutbound(finalPayload(target, message('토큰 ghp_x')), { policyRevision: 'fixture-v1', scan }), refused('public_check'));
  assert.ok(checkOutbound(finalPayload(target, message('깨끗')), { policyRevision: 'fixture-v1', scan }));
});

test('전송층: Discord·GitHub 쓰기 본문은 발송 한 길의 바이트만 보내고, 그 밖의 본문은 fetch 전에 막는다', async () => {
  const requests: { url: string; body: unknown }[] = [];
  const send = (async (url: string, init: RequestInit) => { requests.push({ url, body: init.body }); return new Response(JSON.stringify({ id: '9' }), { status: 200 }); }) as typeof fetch;
  const api = discordHttpApi('fixture-token', send);
  await assert.rejects(api.request('POST', '/channels/fixture-chat/messages', message()), Denied);
  await assert.rejects(api.request('PATCH', '/channels/fixture-chat/messages/1', { content: 'x' }), Denied);
  const github = new GitHubApi(send);
  await assert.rejects(github.call('POST', '/repos/o/r/pulls/1/reviews', 'fixture-token', { body: 'x' }), Denied);
  assert.deepEqual(requests, []);
  const payload = finalPayload(target, message());
  await sendOutbound(payload, checkOutbound(payload, { policyRevision: 'fixture-v1' }), { revision: () => 'fixture-v1',
    ledger: { admit: async () => true }, wire: { wire: (method, path, body) => api.request(method, path, body) } });
  assert.deepEqual(requests, [{ url: 'https://discord.com/api/v10/channels/fixture-chat/messages', body: payload.bytes }]);
});

test('게시자: 보낸 바이트의 digest를 발송함 행에 남기고, 검사한 그 바이트만 나간다', async () => {
  await enqueue('one', '첫 답');
  assert.equal(await f.publisher.deliver(), true);
  const [row] = await outbox();
  assert.equal(row!.state, 'sent');
  assert.equal(f.rest.wires.length, 1);
  assert.equal(row!.sent_digest, sha256(f.rest.wires[0]!.bytes));
  assert.equal(JSON.parse(f.rest.wires[0]!.bytes).content.split('\n')[0], '첫 답');
});

test('발송함 대조: 같은 목적지·같은 바이트를 다른 행으로, lease를 잃은 행으로, 행과 다른 목적지로 보내지 않는다', async () => {
  await enqueue('a', '가'); await enqueue('b', '나');
  const claimed = (await f.store.claimDelivery())!;
  assert.equal(await f.store.dispatchDelivery(claimed), 'dispatched');
  const digest = 'a'.repeat(64);
  assert.equal(await f.store.admitOutbound(claimed, { kind: 'discord-message', channel: 'fixture-other' }, digest), false);
  assert.equal(await f.store.admitOutbound(claimed, { kind: 'discord-thread', channel: 'fixture-chat' }, digest), false);
  assert.equal(await f.store.admitOutbound(claimed, { kind: 'discord-edit', channel: 'fixture-chat', message: '1' }, digest), false);
  assert.equal(await f.store.admitOutbound({ id: claimed.id, lease_token: 'stolen' }, target, digest), false);
  assert.equal(await f.store.admitOutbound(claimed, target, digest), true);
  await f.store.deliveryState(claimed, 'sent', 'x-1');
  const second = (await f.store.claimDelivery())!;
  assert.equal(await f.store.dispatchDelivery(second), 'dispatched');
  assert.equal(await f.store.admitOutbound(second, target, digest), false);
  assert.equal(await f.store.admitOutbound(second, target, 'b'.repeat(64)), true);
});

test('발송함 대조: 다른 원글에서 여는 같은 제목의 스레드는 바이트가 같아도 각각 나간다', async () => {
  // 두 원글의 글이 같아 두 스레드의 제목, 곧 본문 바이트가 같다.
  for (const [key, from] of [['t1', '7301'], ['t2', '7302']] as const) {
    await database.db.query(`INSERT INTO events(id,provider,delivery_id,semantic_key,actor_id,scope,received_at,payload)
      VALUES ($1,'discord',$1,$1,$2,$3,0,$4)`, [from, f.policy.owner, JSON.stringify(channelScope), JSON.stringify({ text: '같은 제목' })]);
    await f.store.enqueue({ key, actor: f.policy.owner, scope: channelScope, revision: f.policy.revision,
      payload: { kind: 'thread', channel: 'fixture-chat', content: from, classification: 'safe_summary', fromMessage: from } });
  }
  while (await f.publisher.deliver()) { /* 둘 다 보낸다 */ }
  assert.deepEqual(f.rest.threads.map(t => [t.from, t.body.name]), [['7301', '같은 제목'], ['7302', '같은 제목']]);
  assert.equal(new Set(f.rest.wires.map(w => w.bytes)).size, 1);
  const rows = await outbox();
  assert.deepEqual(rows.map(row => row.state), ['sent', 'sent']);
  assert.equal(rows[0]!.sent_digest, rows[1]!.sent_digest);
});

test('발송함 대조: 발송 시작 뒤 lease를 잃으면(다른 게시자가 다시 잡음) 보내지 않는다', async () => {
  await enqueue('lease', '답');
  const authorize = f.gate.authorize.bind(f.gate);
  let calls = 0;
  // 인가는 authorized()에서 한 번, 보내기 직전 정책 판 읽기에서 한 번이다. 두 번째 읽기 동안 다른 게시자가 행을 잡은 것으로 만든다.
  f.gate.authorize = async (...args: Parameters<typeof authorize>) => {
    const policy = await authorize(...args);
    if (++calls === 2) await database.db.query("UPDATE outbox SET lease_token='other-publisher'");
    return policy;
  };
  await f.publisher.deliver();
  assert.equal(f.rest.wires.length, 0);
  assert.equal(f.rest.messages.length, 0);
  assert.equal((await outbox())[0]!.sent_digest, null);
});

test('게시자: 검사 뒤 정책 판이 바뀌면 보내지 않고 다시 잡혀 새 판으로 나간다', async () => {
  await enqueue('policy', '답');
  const authorize = f.gate.authorize.bind(f.gate);
  let calls = 0;
  f.gate.authorize = async (...args: Parameters<typeof authorize>) => {
    const policy = await authorize(...args);
    return ++calls === 2 ? { ...policy, revision: 'fixture-v2' } : policy;
  };
  await f.publisher.deliver();
  assert.equal(f.rest.wires.length, 0);
  assert.deepEqual((await outbox()).map(row => row.state), ['pending']);
  f.advance(60_000);
  await f.publisher.deliver();
  assert.equal(f.rest.wires.length, 1);
  assert.deepEqual((await outbox()).map(row => row.state), ['sent']);
});

test('고치기(PATCH): 같은 채널에 봇이 보낸 글만 고치고, 모르는 글·다른 채널 글은 보내지 않는다', async () => {
  await enqueue('edit', '처음 글');
  await f.publisher.deliver();
  const sent = (await outbox())[0]!;
  await f.publisher.edit({ owner: f.policy.owner, scope: channelScope, message: sent.external_id!, content: '고친 글' });
  assert.deepEqual(f.rest.wires.at(-1)!.method, 'PATCH');
  assert.deepEqual(f.rest.wires.at(-1)!.path, `/channels/fixture-chat/messages/${sent.external_id}`);
  assert.deepEqual(f.rest.edits, [{ channel: 'fixture-chat', message: sent.external_id, body: { content: '고친 글', allowed_mentions: { parse: [] } } }]);
  await assert.rejects(f.publisher.edit({ owner: f.policy.owner, scope: channelScope, message: 'not-ours', content: 'x' }), refused('outbox_mismatch'));
  await assert.rejects(f.publisher.edit({ owner: f.policy.owner, scope: { ...channelScope, channel: 'fixture-notifications' }, message: sent.external_id!, content: 'x' }),
    refused('outbox_mismatch'));
  assert.equal(f.rest.edits.length, 1);
});

// P2-1·P3-1: 전송층 표지는 이 파일 밖에서 만들 수 없고, 만든 method·path와 그 전송 자리 호출 안에서만 열린다.
const okResponse = () => new Response(JSON.stringify({ id: '9' }), { status: 200 });
function forged(bytes: string): unknown[] {
  const out: unknown[] = [Object.create(OutboundBytes.prototype, { bytes: { value: bytes } })];
  try { out.push(Reflect.construct(OutboundBytes, [bytes])); } catch (error) { assert.ok(error instanceof OutboundRefused, 'Reflect.construct는 표지를 만들지 못한다'); }
  return out;
}
test('전송층 표지: Object.create·Reflect.construct로 흉내 낸 본문은 Discord·GitHub 전송층이 fetch 전에 거절한다', async () => {
  const sent: string[] = [];
  const send = (async (url: string | URL | Request) => { sent.push(String(url)); return okResponse(); }) as typeof fetch;
  const api = discordHttpApi('fixture-token', send);
  const github = new GitHubApi(send);
  const everyone = JSON.stringify({ content: '@everyone 위조', allowed_mentions: { parse: ['everyone'] } });
  assert.throws(() => Reflect.construct(OutboundBytes, [everyone]), refused('unchecked'));
  for (const body of forged(everyone)) {
    await assert.rejects(api.request('POST', '/channels/fixture-chat/messages', body), Denied);
    await assert.rejects(api.request('PATCH', '/channels/fixture-chat/messages/1', body), Denied);
    await assert.rejects(github.call('POST', '/repos/fixture-org/fixture-repo/pulls/1/reviews', 'fixture-token', body), Denied);
  }
  assert.deepEqual(sent, []);
});
test('전송층 표지: 한 길이 준 바이트도 다른 경로로는, 전송 자리 호출이 끝난 뒤에는 보내지 못하고, 같은 검사 결과는 한 번만 쓴다', async () => {
  const sent: string[] = [];
  const send = (async (url: string | URL | Request) => { sent.push(String(url)); return okResponse(); }) as typeof fetch;
  const api = discordHttpApi('fixture-token', send);
  const payload = finalPayload(target, message());
  let kept: OutboundBytes | undefined;
  await assert.rejects(sendOutbound(payload, checkOutbound(payload, { policyRevision: 'fixture-v1' }), ports({
    wire: { wire: (method, _path, body) => { kept = body; return api.request(method, '/channels/OTHER-chan/messages', body); } } })), Denied);
  assert.ok(kept);
  await assert.rejects(api.request('POST', '/channels/fixture-chat/messages', kept), Denied);
  assert.deepEqual(sent, []);
  const check = checkOutbound(payload, { policyRevision: 'fixture-v1' });
  const twice = ports({ wire: { wire: async (method, path, body) => { kept = body; return api.request(method, path, body); } } });
  assert.deepEqual(await sendOutbound(payload, check, twice), { id: '9' });
  assert.deepEqual(sent, ['https://discord.com/api/v10/channels/fixture-chat/messages']);
  await assert.rejects(api.request('POST', '/channels/fixture-chat/messages', kept), Denied);
  await assert.rejects(sendOutbound(payload, check, twice), refused('unchecked'));
  assert.equal(sent.length, 1);
  const github = new GitHubApi(send);
  const review = finalPayload({ kind: 'github', method: 'POST', path: '/repos/fixture-org/fixture-repo/pulls/1/reviews' }, { body: 'x' });
  await sendOutbound(review, checkOutbound(review, { policyRevision: 'fixture-v1', scan: () => null }), ports({
    wire: { wire: async (_method, path, body) => { kept = body; return github.call('POST', path, 'fixture-token', body); } } }));
  await assert.rejects(github.call('POST', '/repos/fixture-org/fixture-repo/pulls/1/reviews', 'fixture-token', kept), Denied);
  assert.equal(sent.length, 2);
});
test('검사: GitHub 목적지는 공개 검사(scan) 없이는 모양 거절이다. Discord는 scan 없이도 된다', () => {
  const github: OutboundTarget = { kind: 'github', method: 'POST', path: '/repos/fixture-org/fixture-repo/pulls/1/reviews' };
  assert.throws(() => checkOutbound(finalPayload(github, { body: 'x' }), { policyRevision: 'fixture-v1' }), refused('shape'));
  assert.throws(() => checkOutbound(finalPayload(github, { body: 'x' }), { policyRevision: 'fixture-v1', scan: undefined }), refused('shape'));
  assert.throws(() => checkOutbound(finalPayload(github, { body: 'x' }), { policyRevision: 'fixture-v1', scan: 'skip' as never }), refused('shape'));
  assert.ok(checkOutbound(finalPayload(github, { body: 'x' }), { policyRevision: 'fixture-v1', scan: () => null }));
  assert.ok(checkOutbound(finalPayload(target, message('깨끗')), { policyRevision: 'fixture-v1' }));
});
test('모양: allowed_mentions는 parse(빈 배열)·users(한 명)·replied_user(false)만 받는다', () => {
  for (const mentions of [{ parse: [], roles: ['111'] }, { parse: [], replied_user: true }, { parse: [], users: ['1', '2'] },
    { parse: [], users: [7] }, { parse: [], everyone: true }]) {
    assert.throws(() => checkOutbound(finalPayload(target, { content: '<@&111>', allowed_mentions: mentions }), { policyRevision: 'fixture-v1' }),
      refused('shape'), JSON.stringify(mentions));
  }
  checkOutbound(finalPayload(target, { content: 'x', allowed_mentions: { parse: [], users: ['1'], replied_user: false } }), { policyRevision: 'fixture-v1' });
});

// 정적 시험: src/에서 바깥 쓰기를 부르는 자리를 정확한 문자열로 세어 허용 목록과 정확히 맞춘다.
// 글을 만드는 쓰기(Discord 글·스레드·고치기, GitHub 저장소 쓰기)의 경로·바이트는 outbound.ts만 만들고,
// 나머지 자리는 그 바이트를 넘기기만 하는 전송 자리이거나 글이 없는 쓰기(리액션·typing·명령 동기화·토큰 발급)다.
const NEEDLES = ["request('POST'", "request('PUT'", "request('PATCH'", "request('DELETE'", 'request(method', '.wire(',
  ".call('POST'", 'api.call(', "exchange('POST'", "exchange('PATCH'", 'exchange(method', 'exchange(wireMethod',
  'new OutboundBytes(', 'sendOutbound(', "method: 'POST'", "method: 'PATCH'", 'discord.com/api', 'api.github.com',
  // 표지를 우회하는 꼴과 전송층의 판정 자리.
  'Reflect.construct(', 'OutboundBytes.prototype', 'Object.create(', 'openOutbound(', 'instanceof OutboundBytes'] as const;
const ALLOWED: Record<string, number> = {
  // 발송 한 길 본체: 경로를 만드는 route(POST 넷·PATCH 하나, 꼴 선언 둘), 바이트를 만드는 자리, 전송 자리 호출, 정의와 머리 주석.
  'outbound.ts: .wire(': 1,
  'outbound.ts: new OutboundBytes(': 1,
  // 표지 판정: 정의 하나, 전송층 셋(discordHttpApi·DiscordProtocol.wire, GitHubApi.call, writer exchange). 원형은 얼린다.
  'outbound.ts: openOutbound(': 1,
  'outbound.ts: OutboundBytes.prototype': 1,
  'discord-protocol.ts: openOutbound(': 2,
  'github-app.ts: openOutbound(': 1,
  'github-writer.ts: openOutbound(': 1,
  'outbound.ts: sendOutbound(': 2,
  "outbound.ts: method: 'POST'": 5,
  "outbound.ts: method: 'PATCH'": 1,
  // 발송 한 길을 부르는 자리: Discord 게시·고치기, ACK 대체 글, 리뷰 게시·안내 글, 변경 PR 쓰기.
  'discord.ts: sendOutbound(': 2,
  'discord-protocol.ts: sendOutbound(': 1,
  'github-review-io.ts: sendOutbound(': 2,
  'github-writer.ts: sendOutbound(': 1,
  // 전송 자리: 발송 한 길이 준 OutboundBytes를 넘기기만 한다(그 밖의 본문은 아래 막음이 거절). 꼴 선언 포함.
  'discord.ts: .wire(': 1,
  "discord.ts: method: 'POST'": 1,
  "discord-protocol.ts: method: 'POST'": 1,
  'discord-protocol.ts: request(method': 4,
  "github-review-io.ts: .call('POST'": 2,
  'github-writer.ts: exchange(wireMethod': 1,
  "github-writer.ts: method: 'POST'": 1,
  // 리뷰 요청 객체의 모양(본문은 RestrictedGitHub·finalPayload를 지나 바이트로만 나간다).
  "review.ts: method: 'POST'": 1,
  "github-review-io.ts: method: 'POST'": 2,
  // GitHub 읽기(GET)와 App 토큰 발급(POST /app/...), 그리고 응답 대조용 URL. 저장소 쓰기가 아니다.
  'github-review-io.ts: api.call(': 6,
  'github-review-io.ts: api.github.com': 3,
  "github-app.ts: .call('POST'": 1,
  'github-app.ts: api.call(': 1,
  'github-app.ts: api.github.com': 1,
  "github-writer.ts: exchange('POST'": 1,
  'github-writer.ts: api.github.com': 1,
  'read-transports.ts: api.github.com': 1,
  'task-policy.ts: api.github.com': 1,
  // 글이 없는 Discord 쓰기: 👀·반응(@me), typing, '/' 명령 동기화(F5). 기본 URL은 discordHttpApi 한 곳.
  "discord-protocol.ts: request('PUT'": 2,
  "discord-protocol.ts: request('DELETE'": 1,
  'discord-protocol.ts: discord.com/api': 1,
  "activity.ts: request('POST'": 1,
  "commands.ts: request('PUT'": 2,
  // Discord·GitHub 밖의 내부 HTTP(작업자·리뷰 작업자·관측 조회)와 서명 입력.
  "worker-http.ts: method: 'POST'": 2,
  "task-http.ts: method: 'POST'": 2,
  "review-http.ts: method: 'POST'": 2,
  "change-review.ts: method: 'POST'": 2,
  "change-assembly.ts: method: 'POST'": 1,
  "main.ts: method: 'POST'": 1,
  "read-transports.ts: method: 'POST'": 1,
  "external-task-receiver.ts: method: 'POST'": 1,
  // 원형 없는 사전(Object.create(null)). 바깥 쓰기와 무관하다.
  'change-ci-policy.ts: Object.create(': 1,
  'change-artifact.ts: Object.create(': 2,
  'codex-workspace.ts: Object.create(': 1,
  'task-workspace.ts: Object.create(': 1,
};
test('정적: Discord·GitHub 쓰기 자리는 허용 목록과 정확히 같고, 전송층의 막음이 그대로다', async () => {
  const found: Record<string, number> = {};
  for (const name of (await readdir('src')).sort()) {
    const text = await readFile(`src/${name}`, 'utf8');
    for (const needle of NEEDLES) {
      const count = text.split(needle).length - 1;
      if (count) found[`${name}: ${needle}`] = count;
    }
  }
  assert.deepEqual(found, ALLOWED);
  const guards: [string, string][] = [
    ['discord-protocol.ts', "if ((method === 'POST' || method === 'PATCH') && body !== undefined && sealed === undefined) throw new Denied();"],
    ['discord-protocol.ts', 'if (openOutbound(body, method, path) === undefined) throw new Denied();'],
    ['github-app.ts', "if (method === 'POST' && path.startsWith('/repos/') && sealed === undefined) throw new Denied();"],
    ['github-writer.ts', "if (method !== 'GET' && path.startsWith('/repos/') && sealed === undefined) return { kind: 'not_sent', code: 'route_denied' };"],
  ];
  for (const [name, guard] of guards) assert.equal((await readFile(`src/${name}`, 'utf8')).split(guard).length - 1, 1, name);
});

// 하네스 훑기: 한 길의 포트·payload를 Proxy로 감싸 읽기(get)·호출(call) 지점마다 흔들기 하나를 넣고 새로 돌린다.
// 불변식: 나간 바이트는 늘 검사한 바이트(digest·경로 일치)이고 한 번 이하다. 흔들기가 전송 전에 던졌으면 전송 0이다.
type Perturb = 'throw' | 'mutate';
interface Point { at: number; kind: 'get' | 'call'; path: string }
export async function explore(run: (probe: Probe) => Promise<{ wired: Wired[]; checked: { digest: string; path: string } }>): Promise<{ points: number; runs: number; violations: string[]; labels: string[] }> {
  const base = new Probe();
  const baseline = await run(base).catch(() => undefined);
  const violations: string[] = [];
  if (!baseline || baseline.wired.length !== 1) violations.push(`baseline | wired=${baseline?.wired.length}`);
  let runs = 1;
  for (const point of base.points) for (const perturb of ['throw', 'mutate'] as Perturb[]) {
    if (perturb === 'mutate' && point.kind !== 'get') continue;
    const probe = new Probe({ at: point.at, perturb });
    runs++;
    let result: Awaited<ReturnType<typeof run>> | undefined;
    let threw = false;
    try { result = await run(probe); } catch { threw = true; }
    const wired = result?.wired ?? probe.wired;
    const checked = result?.checked ?? probe.checked;
    const label = `${point.kind} ${point.path} | ${perturb}`;
    if (wired.length > 1) violations.push(`dup | ${label}`);
    for (const sent of wired) {
      if (!checked || sha256(sent.bytes) !== checked.digest || sent.path !== checked.path) violations.push(`bytes | ${label}`);
    }
    if (perturb === 'throw' && probe.firedBeforeWire && wired.length) violations.push(`unknown | ${label}`);
    void threw;
  }
  return { points: base.points.length, runs, violations, labels: base.points.map(point => `${point.at} ${point.kind} ${point.path}`) };
}
class Probe {
  points: Point[] = [];
  wired: Wired[] = [];
  checked: { digest: string; path: string } | undefined;
  firedBeforeWire = false;
  private counter = 0;
  constructor(private readonly target?: { at: number; perturb: Perturb }) {}
  private fire(kind: 'get' | 'call', path: string): Perturb | undefined {
    const at = this.counter++;
    if (!this.target) this.points.push({ at, kind, path });
    if (this.target?.at !== at) return;
    if (!this.wired.length) this.firedBeforeWire = true;
    return this.target.perturb;
  }
  // 객체의 읽기·호출을 센다. mutate는 그 읽기부터 문자열 값의 한 글자를 바꿔 돌려준다(검사와 보내기 사이의 바뀜).
  wrap<T extends object>(path: string, value: T): T {
    const probe = this;
    return new Proxy(value, {
      get(object, key, receiver) {
        const name = `${path}.${String(key)}`;
        const perturb = typeof key === 'string' && key !== 'then' ? probe.fire('get', name) : undefined;
        if (perturb === 'throw') throw new Error(`probe_throw ${name}`);
        const got = Reflect.get(object, key, receiver);
        if (perturb === 'mutate' && typeof got === 'string') return got.slice(0, -1) + (got.endsWith('x') ? 'y' : 'x');
        if (typeof got === 'function') return (...args: unknown[]) => {
          const call = probe.fire('call', name);
          if (call === 'throw') throw new Error(`probe_throw ${name}()`);
          return Reflect.apply(got, object, args);
        };
        if (got !== null && typeof got === 'object' && !Object.isFrozen(got)) return probe.wrap(name, got);
        return got;
      },
    });
  }
}
async function onePath(probe: Probe) {
  const plain = finalPayload(target, message('훑기'));
  const check = checkOutbound(plain, { policyRevision: 'fixture-v1' });
  probe.checked = { digest: check.digest, path: '/channels/fixture-chat/messages' };
  // 얼린 payload 대신 같은 값을 가진 바뀔 수 있는 객체를 감싸, 읽을 때마다 다른 값을 줄 수 있게 한다.
  const payload = probe.wrap('payload', { target: { ...plain.target }, bytes: plain.bytes }) as OutboundPayload;
  const ports = probe.wrap('ports', { revision: () => 'fixture-v1', ledger: { admit: async () => true },
    wire: { wire: async (method: string, path: string, body: OutboundBytes) => { probe.wired.push({ method, path, bytes: body.bytes }); return { id: 'm' }; } } });
  await sendOutbound(payload, check, ports as OutboundPorts);
  return { wired: probe.wired, checked: probe.checked };
}
test('하네스 훑기(한 길): 포트·payload의 읽기·호출마다 던지기·바꾸기를 넣어도 검사와 다른 바이트가 나가지 않는다', async () => {
  const report = await explore(onePath);
  console.log(`sweep one-path ${JSON.stringify({ points: report.points, runs: report.runs, violations: report.violations.length })}`);
  console.log(`sweep one-path points ${JSON.stringify(report.labels)}`);
  for (const line of report.violations) console.log(`violation ${line}`);
  assert.ok(report.points >= 8, String(report.points));
  assert.deepEqual(report.violations, []);
});
test('하네스 훑기(게시자): 발송함·Discord 전송·정책 문의 읽기·호출마다 던지기를 넣어도 나간 바이트는 발송함 digest와 같고 한 번 이하다', async () => {
  const report = await explore(async probe => {
    await database.pg.exec('TRUNCATE outbox,audit,controls RESTART IDENTITY CASCADE');
    await enqueue('sweep', '훑기 답');
    const rest = probe.wrap('rest', { wire: async (method: string, path: string, body: OutboundBytes) => {
      probe.wired.push({ method, path, bytes: body.bytes });
      return f.rest.wire(method as 'POST', path, body);
    } });
    const gate = probe.wrap('gate', { authorize: (...args: Parameters<typeof f.gate.authorize>) => f.gate.authorize(...args),
      withDatabase: (...args: Parameters<typeof f.gate.withDatabase>) => f.gate.withDatabase(...args) });
    const { DiscordPublisher } = await import('../src/discord.js');
    // 발송함(Store)도 감싼다. 메서드는 원래 객체를 this로 불러 내부 상태는 그대로고, 게시자가 읽는 칸·부르는 메서드만 지점이 된다.
    const store = probe.wrap('store', f.store);
    const publisher = new DiscordPublisher(store, gate as never, Object.assign(Object.create(f.rest), { wire: rest.wire }) as never);
    try { await publisher.deliver(); } catch { /* 흔들기로 난 오류는 결과 대조로 본다 */ }
    const row = (await outbox())[0];
    // 발송함에 묶인 digest가 곧 검사한 바이트의 digest다(admitOutbound는 검사 결과의 digest만 받는다).
    probe.checked = row?.sent_digest ? { digest: row.sent_digest, path: '/channels/fixture-chat/messages' } : undefined;
    return { wired: probe.wired, checked: probe.checked ?? { digest: '', path: '' } };
  });
  console.log(`sweep publisher ${JSON.stringify({ points: report.points, runs: report.runs, violations: report.violations.length })}`);
  console.log(`sweep publisher points ${JSON.stringify(report.labels)}`);
  for (const line of report.violations) console.log(`violation ${line}`);
  assert.ok(report.points >= 20, String(report.points));
  assert.deepEqual(report.violations, []);
});
