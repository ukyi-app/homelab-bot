import { test } from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { connect } from 'node:net';
import type { AddressInfo } from 'node:net';
import { externalTaskServer, EXTERNAL_TASK_PATH, FIXED_SUMMARY, ProcessingExpired, RECEIVER_LIMITS, Slots, SlotsFull, formatNotice, kstTime, signatureInput, suspectSummary } from '../src/external-task-receiver.js';
import { thread } from './helpers.js';
import { SESSION, atomicityScenario, eventBody, listen, raw, rawClient, receiverFixture, request, sender, shut, signedHeaders } from './external-task-fixture.js';

const HOUR = 3_600_000;
const reply = async (ctx: Awaited<ReturnType<typeof receiverFixture>>, who: ReturnType<typeof sender>, overrides: Record<string, unknown> = {}, options: Parameters<typeof signedHeaders>[3] = {}) => {
  const body = eventBody(who, ctx.f.now(), overrides);
  return ctx.receiver.receive(signedHeaders(who, body, ctx.f.now(), options), Buffer.from(body));
};
const otherSeed = () => generateKeyPairSync('ed25519').privateKey.export({ format: 'jwk' }).d!;

test('R08 수신: 서명 입력 바이트는 고정 순서와 구분자다', () => {
  assert.equal(signatureInput({ environment: 'env', method: 'POST', path: '/external-task-events', connectionId: 'c', keyId: 'k', sentAt: '1', bodySha256: 'h' }).toString('utf8'),
    'R08-v1\nenv\nPOST\n/external-task-events\nc\nk\n1\nh');
});

test('R08 수신: 서명이 맞는 등록 연결만 수락하고, 위조·수정·미등록·다른 환경·경로·메서드는 같은 응답으로 거절한다', async () => {
  const ctx = await receiverFixture({ connectionBurst: 100 });
  try {
    const who = await ctx.attach();
    assert.deepEqual(await reply(ctx, who), { status: 202, outcome: 'accepted' });
    const now = ctx.f.now();
    const body = eventBody(who, now);
    const cases: [string, Record<string, string>, string][] = [
      ['다른 개인키', signedHeaders(who, body, now, { seed: otherSeed() }), body],
      ['다른 환경', signedHeaders(who, body, now, { environment: 'other-env' }), body],
      ['다른 경로', signedHeaders(who, body, now, { path: '/external-task-events/' }), body],
      ['다른 메서드', signedHeaders(who, body, now, { method: 'PUT' }), body],
      ['본문 수정', signedHeaders(who, body, now), body.replace(FIXED_SUMMARY, '턴 완 료')],
      ['재직렬화한 본문', signedHeaders(who, body, now), JSON.stringify(JSON.parse(body), null, 1)],
      ['sent_at 수정', { ...signedHeaders(who, body, now), 'x-r08-sent-at': String(now + 1) }, body],
      ['key_id 수정', { ...signedHeaders(who, body, now), 'x-r08-key-id': 'A'.repeat(16) }, body],
      ['미등록 연결', signedHeaders(who, body, now, { connectionId: '11111111-1111-4111-8111-111111111111' }), body],
    ];
    const before = await ctx.count('external_task_events');
    for (const [name, headers, raw] of cases) {
      assert.deepEqual(await ctx.receiver.receive(headers, Buffer.from(raw)), { status: 401, outcome: 'unauthorized' }, name);
    }
    assert.equal(await ctx.count('external_task_events'), before);
    // 다른 연결의 connection_id를 본문에만 쓰는 것은 서명이 맞아도 거절한다.
    assert.equal((await reply(ctx, who, { connection_id: '11111111-1111-4111-8111-111111111111' })).outcome, 'invalid_body');
  } finally { await ctx.close(); }
});

test('R08 수신: 헤더 형식이 틀리면 DB를 보기 전에 거절한다', async () => {
  const ctx = await receiverFixture();
  try {
    const who = await ctx.attach();
    const body = eventBody(who, ctx.f.now());
    const good = signedHeaders(who, body, ctx.f.now());
    for (const [name, value] of [['x-r08-connection-id', 'not-a-uuid'], ['x-r08-key-id', 'short'], ['x-r08-sent-at', '2026-11-05T00:00:00Z'], ['x-r08-sent-at', '01'], ['x-r08-signature', 'AAAA'], ['x-r08-signature', `${good['x-r08-signature']}, ${good['x-r08-signature']}`]] as const) {
      assert.equal((await ctx.receiver.receive({ ...good, [name]: value }, Buffer.from(body))).outcome, 'bad_headers', `${name}=${value}`);
    }
    const { 'x-r08-signature': _omit, ...missing } = good;
    assert.equal((await ctx.receiver.receive(missing, Buffer.from(body))).outcome, 'bad_headers');
  } finally { await ctx.close(); }
});

test('R08 수신: 폐기·만료·다른 외부 ID·현재 owner 불일치·대화 비활성은 닫힌다', async () => {
  const ctx = await receiverFixture({ connectionBurst: 100 });
  try {
    const who = await ctx.attach();
    assert.equal((await reply(ctx, who, { external_task_id: 'other-session' })).outcome, 'external_task_mismatch');
    assert.equal((await reply(ctx, who)).outcome, 'accepted');
    ctx.f.setPolicyUnavailable(true);
    const unavailable = await reply(ctx, who);
    assert.equal(unavailable.status, 503);
    assert.ok(unavailable.retryAfter);
    ctx.f.setPolicyUnavailable(false);
    await ctx.db.query('UPDATE conversations SET active=false');
    assert.equal((await reply(ctx, who)).outcome, 'scope_denied');
    await ctx.db.query('UPDATE conversations SET active=true');
    const { owner } = ctx.f.policy;
    ctx.f.policy.owner = 'someone-else';
    assert.equal((await reply(ctx, who)).outcome, 'scope_denied');
    ctx.f.policy.owner = owner;
    assert.equal((await reply(ctx, who)).outcome, 'accepted');
    // 30일 직전까지 받고 그때부터 닫는다.
    ctx.f.advance(30 * 24 * HOUR - 1);
    assert.equal((await reply(ctx, who)).outcome, 'accepted');
    ctx.f.advance(1);
    assert.deepEqual(await reply(ctx, who), { status: 401, outcome: 'unauthorized' });
    const second = await ctx.attach('second-session');
    assert.equal((await reply(ctx, second)).outcome, 'accepted');
    await ctx.links.detach(second.connectionId, 'fixture-owner');
    assert.deepEqual(await reply(ctx, second), { status: 401, outcome: 'unauthorized' });
  } finally { await ctx.close(); }
});

test('R08 재생: 같은 event_id 같은 내용은 성공만 주고 다시 게시하지 않으며, 다른 내용은 거절한다', async () => {
  const ctx = await receiverFixture({ connectionBurst: 100 });
  try {
    const who = await ctx.attach();
    const body = eventBody(who, ctx.f.now());
    const event = JSON.parse(body) as { event_id: string };
    assert.deepEqual(await ctx.receiver.receive(signedHeaders(who, body, ctx.f.now()), Buffer.from(body)), { status: 202, outcome: 'accepted' });
    // 재시도는 본문을 그대로 두고 새 sent_at으로 다시 서명한다.
    ctx.f.advance(60_000);
    const again = await ctx.receiver.receive(signedHeaders(who, body, ctx.f.now()), Buffer.from(body));
    assert.deepEqual(again, { status: 202, outcome: 'duplicate' });
    assert.equal(await ctx.count('outbox'), 1);
    assert.equal(await ctx.count('external_task_events'), 1);
    const changed = await reply(ctx, who, { event_id: event.event_id, occurred_at: ctx.f.now() });
    assert.deepEqual(changed, { status: 409, outcome: 'event_conflict' });
    assert.equal(await ctx.count('outbox'), 1);
    // 다른 연결은 같은 event_id를 써도 별개다.
    const other = await ctx.attach('second-session');
    assert.equal((await reply(ctx, other, { event_id: event.event_id })).outcome, 'accepted');
    assert.equal(await ctx.count('outbox'), 2);
  } finally { await ctx.close(); }
});

test('R08 시계: sent_at ±5분과 occurred_at 미래 5분·과거 24시간 경계', async () => {
  const ctx = await receiverFixture({ connectionBurst: 100 });
  try {
    const who = await ctx.attach();
    const signedAt = async (sentAt: number, overrides: Record<string, unknown> = {}) => {
      const body = eventBody(who, ctx.f.now(), overrides);
      return (await ctx.receiver.receive(signedHeaders(who, body, sentAt), Buffer.from(body))).outcome;
    };
    const now = ctx.f.now();
    assert.equal(await signedAt(now - 300_000), 'accepted');
    assert.equal(await signedAt(now + 300_000), 'accepted');
    assert.equal(await signedAt(now - 300_001), 'clock_skew');
    assert.equal(await signedAt(now + 300_001), 'clock_skew');
    assert.equal(await signedAt(now, { occurred_at: now + 300_000 }), 'accepted');
    assert.equal(await signedAt(now, { occurred_at: now + 300_001 }), 'occurred_at_window');
    assert.equal(await signedAt(now, { occurred_at: now - 24 * HOUR }), 'accepted');
    assert.equal(await signedAt(now, { occurred_at: now - 24 * HOUR - 1 }), 'occurred_at_window');
  } finally { await ctx.close(); }
});

test('R08 허용 필드: 목록 밖 필드는 모두 거절하고, 클라이언트가 주장한 owner·채널을 쓰지 않는다', async () => {
  const ctx = await receiverFixture({ connectionBurst: 1000 });
  try {
    const who = await ctx.attach();
    // [합성] 공식 문서의 Stop·notify 입력 필드와 금지 항목.
    for (const [name, value] of Object.entries({ cwd: '/fixture', transcript_path: '/fixture/t.jsonl', last_assistant_message: 'x', 'input-messages': ['x'], 'last-assistant-message': 'x',
      tool_output: 'x', token: 'x', path: '/x', owner: 'someone', owner_id: 'someone', channel: 'elsewhere', scope: {}, public_key: 'x', __proto__x: 1 })) {
      assert.equal((await reply(ctx, who, { [name]: value })).outcome, 'invalid_body', name);
    }
    for (const overrides of [{ version: 2 }, { type: 'task_started' }, { type: undefined }, { summary: undefined }, { summary: '' }, { event_id: 'short' }, { event_id: '../../x-aaaaaaaaaaaaaa' },
      { occurred_at: '1800000000000' }, { occurred_at: 1.5 }, { external_task_id: '/home/x/session' }, { external_task_id: 'x'.repeat(129) }]) {
      assert.equal((await reply(ctx, who, overrides)).outcome, 'invalid_body', JSON.stringify(overrides));
    }
    for (const body of ['[]', 'null', '{', '']) {
      assert.equal((await ctx.receiver.receive(signedHeaders(who, body, ctx.f.now()), Buffer.from(body))).status, 400, body);
    }
    const invalidUtf8 = Buffer.concat([Buffer.from(eventBody(who, ctx.f.now(), { summary: 'x' }).slice(0, -2)), Buffer.from([0xff]), Buffer.from('"}')]);
    assert.equal((await ctx.receiver.receive(signedHeaders(who, invalidUtf8, ctx.f.now()), invalidUtf8)).outcome, 'invalid_body');
    assert.equal(await ctx.count('outbox'), 0);
    // 목적지는 연결 레코드다.
    assert.equal((await reply(ctx, who)).outcome, 'accepted');
    const row = (await ctx.db.query<{ owner_id: string; payload: { channel: string }; scope: { channel: string } }>('SELECT owner_id,payload,scope FROM outbox')).rows[0]!;
    assert.equal(row.owner_id, 'fixture-owner');
    assert.equal(row.payload.channel, thread.channel);
    assert.equal(row.scope.channel, thread.channel);
  } finally { await ctx.close(); }
});

test('R08 요약: 기본은 고정 문구만 받고, 동의한 연결만 500자·2,000바이트 안의 정제된 요약을 받는다', async () => {
  const ctx = await receiverFixture({ connectionBurst: 1000 });
  try {
    const plain = await ctx.attach();
    assert.equal((await reply(ctx, plain, { summary: '다 끝났습니다' })).outcome, 'summary_consent_required');
    assert.equal((await reply(ctx, plain)).outcome, 'accepted');
    const consent = await ctx.attach('consent-session', true);
    assert.equal((await reply(ctx, consent, { summary: '가'.repeat(500) })).outcome, 'accepted');
    assert.equal((await reply(ctx, consent, { summary: '가'.repeat(501) })).outcome, 'summary_rejected');
    // 코드 포인트 500개 안이어도 2,000바이트를 넘으면 거절한다. 그림 문자는 4바이트다.
    assert.equal((await reply(ctx, consent, { summary: '😀'.repeat(500) })).outcome, 'accepted');
    assert.equal(Buffer.byteLength('😀'.repeat(501)), 2004);
    assert.equal((await reply(ctx, consent, { summary: '😀'.repeat(501) })).outcome, 'summary_rejected');
    for (const summary of ['줄\n바꿈', '탭\t문자', '제로폭​', '방향‮', '짝없는\ud800', '/Users/fixture/x', '~/.ssh/id', 'sk-abcdefghijklmnop', 'ghp_abcdefghijklmnop', 'token=abc', '비밀번호: abc', 'Bearer abcdefghijkl', 'a'.repeat(40), '-----BEGIN PRIVATE KEY-----']) {
      assert.equal((await reply(ctx, consent, { summary })).outcome, 'summary_rejected', summary);
    }
    assert.equal(suspectSummary('빌드와 시험을 마쳤습니다. 다음은 배포 확인입니다.'), false);
  } finally { await ctx.close(); }
});

test('R08 요약: 처음 읽은 뒤 잠그기 전에 동의가 철회되면 새 요약을 저장하지 않고, 고정 문구와 이미 받은 요약의 재전송은 그대로다', async () => {
  // 권한 확인은 처음 읽은 연결 행과 잠금 사이에 있다. 그 자리에서 철회가 커밋된 상황을 만든다.
  let withdraw = false;
  const ctx = await receiverFixture({ connectionBurst: 100 }, { authorize: async (_owner, _scope, db) => {
    if (withdraw) await db.query('UPDATE external_task_connections SET summary_consent=false');
    return { revision: 'fixture-v1' };
  } });
  const consent = 'UPDATE external_task_connections SET summary_consent=true';
  try {
    const who = await ctx.attach(SESSION, true);
    const accepted = eventBody(who, ctx.f.now(), { summary: '먼저 받은 요약' });
    assert.equal((await ctx.receiver.receive(signedHeaders(who, accepted, ctx.f.now()), Buffer.from(accepted))).outcome, 'accepted');
    withdraw = true;
    assert.deepEqual(await reply(ctx, who, { summary: '철회 뒤 요약' }), { status: 403, outcome: 'summary_consent_required' });
    assert.equal(await ctx.count('outbox'), 1);
    assert.equal(await ctx.count('external_task_events'), 1);
    const dump = JSON.stringify((await ctx.db.query('SELECT payload FROM outbox')).rows);
    assert.equal(dump.includes('철회 뒤 요약'), false);
    await ctx.db.query(consent);
    assert.equal((await ctx.receiver.receive(signedHeaders(who, accepted, ctx.f.now()), Buffer.from(accepted))).outcome, 'duplicate');
    await ctx.db.query(consent);
    assert.equal((await reply(ctx, who)).outcome, 'accepted');
    assert.equal(await ctx.count('outbox'), 2);
  } finally { await ctx.close(); }
});

test('R08 게시: 고정 문구·시각·지연을 쓰고, 멘션과 링크 미리보기가 생기지 않으며, 게시 상태가 따라간다', async () => {
  const ctx = await receiverFixture();
  try {
    const who = await ctx.attach(SESSION, true);
    ctx.f.advance(0);
    const occurred = ctx.f.now() - 90_000;
    assert.equal((await reply(ctx, who, { occurred_at: occurred, summary: '@everyone 봐 주세요 https://example.invalid/x <@123> **굵게** `코드`' })).outcome, 'accepted');
    assert.equal(await ctx.f.publisher.deliver(), true);
    const message = ctx.f.rest.messages[0]!;
    assert.equal(message.channel, thread.channel);
    assert.deepEqual(message.body.allowed_mentions, { parse: [] });
    const { content } = message.body;
    assert.ok(content.startsWith(`사람 세션이 턴을 끝냈다고 알림 (claude \`${SESSION}\`)`));
    assert.ok(content.includes(`발생 ${kstTime(occurred)}`));
    assert.ok(content.includes(`수신 ${kstTime(ctx.f.now())}`));
    assert.ok(content.includes('지연 1분 30초'));
    assert.ok(content.includes('봇이 결과를 확인한 것은 아닙니다.'));
    assert.equal(content.includes('완료했습니다') || content.includes('성공'), false);
    // 코드 스팬 밖에는 링크·멘션·마크다운이 남지 않는다. Discord는 코드 스팬 안을 해석하지 않는다.
    const outside = content.replace(/`[^`]*`/g, '');
    for (const pattern of [/https?:/, /@everyone/, /<@/, /\*\*/]) assert.doesNotMatch(outside, pattern);
    assert.equal((content.match(/`/g) ?? []).length % 2, 0);
    assert.equal((await ctx.db.query<{ post_state: string }>('SELECT post_state FROM external_task_events')).rows[0]!.post_state, 'posted');
    assert.equal(kstTime(Date.UTC(2026, 10, 4, 15, 0, 1)), '2026-11-05 00:00:01 KST');
    assert.equal(formatNotice({ executor: 'codex', externalTaskId: 'x', summary: FIXED_SUMMARY, occurredAt: 1000, receivedAt: 500 }).includes('지연 0초'), true);
  } finally { await ctx.close(); }
});

test('R08 게시: 게시 시점의 권한도 본다. 대화가 닫혔으면 나가지 않고 상태가 blocked로 따라간다', async () => {
  const ctx = await receiverFixture();
  try {
    const who = await ctx.attach();
    assert.equal((await reply(ctx, who)).outcome, 'accepted');
    await ctx.db.query('UPDATE conversations SET active=false');
    assert.equal(await ctx.f.publisher.deliver(), true);
    assert.equal(ctx.f.rest.messages.length, 0);
    assert.equal((await ctx.db.query<{ post_state: string }>('SELECT post_state FROM external_task_events')).rows[0]!.post_state, 'blocked');
  } finally { await ctx.close(); }
});

test('R08 속도: 서명 뒤 연결별 burst 5·분당 30·시간당 300, 위조 요청은 그 연결의 quota를 깎지 못한다', async () => {
  assert.deepEqual([RECEIVER_LIMITS.connectionBurst, RECEIVER_LIMITS.connectionPerMinute, RECEIVER_LIMITS.connectionPerHour], [5, 30, 300]);
  const ctx = await receiverFixture();
  try {
    const who = await ctx.attach();
    for (let i = 0; i < 10; i++) assert.equal((await reply(ctx, who, {}, { seed: otherSeed() })).outcome, 'unauthorized');
    for (let i = 0; i < 5; i++) assert.equal((await reply(ctx, who)).outcome, 'accepted', `burst ${i}`);
    const limited = await reply(ctx, who);
    assert.equal(limited.status, 429);
    assert.equal(limited.outcome, 'rate_limited_connection');
    assert.equal(limited.retryAfter, 2);
    ctx.f.advance(2000);
    assert.equal((await reply(ctx, who)).outcome, 'accepted');
    // 다른 연결은 영향받지 않는다.
    const other = await ctx.attach('second-session');
    assert.equal((await reply(ctx, other)).outcome, 'accepted');
  } finally { await ctx.close(); }
  const hourly = await receiverFixture({ connectionBurst: 100, connectionPerMinute: 6000, connectionPerHour: 3 });
  try {
    const who = await hourly.attach();
    for (let i = 0; i < 3; i++) assert.equal((await reply(hourly, who)).outcome, 'accepted');
    const limited = await reply(hourly, who);
    assert.equal(limited.outcome, 'rate_limited_connection');
    assert.equal(limited.retryAfter, 1200);
  } finally { await hourly.close(); }
});

test('R08 역압: 미게시 연결별·전체 상한에서 429·503과 Retry-After, 중복은 성공, 게시되면 다시 받는다', async () => {
  assert.deepEqual([RECEIVER_LIMITS.unpostedPerConnection, RECEIVER_LIMITS.unpostedTotal], [100, 1000]);
  const ctx = await receiverFixture({ connectionBurst: 1000, unpostedPerConnection: 2, unpostedTotal: 3 });
  try {
    const who = await ctx.attach();
    const first = eventBody(who, ctx.f.now());
    assert.equal((await ctx.receiver.receive(signedHeaders(who, first, ctx.f.now()), Buffer.from(first))).outcome, 'accepted');
    assert.equal((await reply(ctx, who)).outcome, 'accepted');
    const full = await reply(ctx, who);
    assert.deepEqual([full.status, full.outcome, full.retryAfter], [429, 'backlog_connection', 30]);
    // 이미 받은 이벤트의 재전송은 역압 대상이 아니다.
    assert.equal((await ctx.receiver.receive(signedHeaders(who, first, ctx.f.now()), Buffer.from(first))).outcome, 'duplicate');
    const other = await ctx.attach('second-session');
    assert.equal((await reply(ctx, other)).outcome, 'accepted');
    const total = await reply(ctx, other);
    assert.deepEqual([total.status, total.outcome, total.retryAfter], [503, 'backlog_total', 30]);
    assert.equal(await ctx.count('outbox'), 3);
    assert.equal(await ctx.f.publisher.deliver(), true);
    assert.equal((await reply(ctx, other)).outcome, 'accepted');
  } finally { await ctx.close(); }
});

test('R08 HTTP: POST와 정확한 경로 하나만 받는다. 변형·다른 메서드·/metrics·/readyz는 인증 전에 거절한다', async () => {
  const ctx = await receiverFixture({ globalBurst: 1000 });
  const server = externalTaskServer(ctx.receiver);
  await listen(server);
  try {
    const who = await ctx.attach();
    for (const target of [`${EXTERNAL_TASK_PATH}?x=1`, `${EXTERNAL_TASK_PATH}?`, `${EXTERNAL_TASK_PATH}/`, `${EXTERNAL_TASK_PATH}/x`, `/%65xternal-task-events`, `/external%2Dtask%2Devents`,
      `//external-task-events`, `/./external-task-events`, `/x/../external-task-events`, `/EXTERNAL-TASK-EVENTS`, `http://fixture${EXTERNAL_TASK_PATH}`, '/metrics', '/readyz', '/github', '/alerts', '/', '*']) {
      const body = eventBody(who, ctx.f.now());
      const response = await raw(server, request('POST', target, signedHeaders(who, body, ctx.f.now()), body));
      assert.equal(response.status, 404, target);
    }
    for (const method of ['GET', 'PUT', 'DELETE', 'PATCH', 'OPTIONS', 'HEAD', 'TRACE']) {
      const response = await raw(server, request(method, EXTERNAL_TASK_PATH, {}));
      assert.equal(response.status, 405, method);
      assert.match(response.text, /allow: POST/i);
    }
    assert.equal(await ctx.count('external_task_events'), 0);
    // 정상 경로와 Discord로 가는 값이 없는 응답.
    const body = eventBody(who, ctx.f.now());
    const accepted = await raw(server, request('POST', EXTERNAL_TASK_PATH, signedHeaders(who, body, ctx.f.now()), body));
    assert.equal(accepted.status, 202);
    assert.match(accepted.text, /\{"status":"accepted"\}/);
    const duplicate = await raw(server, request('POST', EXTERNAL_TASK_PATH, signedHeaders(who, body, ctx.f.now()), body));
    assert.equal(duplicate.status, 202);
    assert.match(duplicate.text, /\{"status":"accepted"\}/);
  } finally { await shut(server); await ctx.close(); }
});

test('R08 HTTP: 압축·다른 형식·선언 초과 본문·chunked 실제 초과를 거절하고 413에 Retry-After를 준다', async () => {
  assert.equal(RECEIVER_LIMITS.bodyBytes, 4096);
  const ctx = await receiverFixture({ globalBurst: 1000, connectionBurst: 100 });
  const server = externalTaskServer(ctx.receiver);
  await listen(server);
  try {
    const who = await ctx.attach();
    const body = eventBody(who, ctx.f.now());
    const signed = signedHeaders(who, body, ctx.f.now());
    assert.equal((await raw(server, request('POST', EXTERNAL_TASK_PATH, { ...signed, 'Content-Encoding': 'gzip' }, body))).status, 415);
    assert.equal((await raw(server, request('POST', EXTERNAL_TASK_PATH, { ...signed, 'Content-Encoding': 'identity' }, body))).status, 415);
    assert.equal((await raw(server, request('POST', EXTERNAL_TASK_PATH, { ...signed, 'content-type': 'text/plain' }, body))).status, 415);
    const { 'content-type': _type, ...noType } = signed;
    assert.equal((await raw(server, request('POST', EXTERNAL_TASK_PATH, noType, body))).status, 415);
    const declared = await raw(server, `POST ${EXTERNAL_TASK_PATH} HTTP/1.1\r\nHost: fixture\r\ncontent-type: application/json\r\nContent-Length: 4097\r\n\r\n`);
    assert.equal(declared.status, 413);
    assert.match(declared.text, /retry-after: 60/i);
    // 선언 없이 chunked로 실제 바이트가 넘는 경우.
    const chunked = rawClient(server);
    chunked.write(`POST ${EXTERNAL_TASK_PATH} HTTP/1.1\r\nHost: fixture\r\ncontent-type: application/json\r\nTransfer-Encoding: chunked\r\n\r\n`);
    chunked.write(`fa0\r\n${'x'.repeat(4000)}\r\n`);
    await new Promise(resolve => setTimeout(resolve, 30));
    chunked.write(`61\r\n${'x'.repeat(97)}\r\n`);
    const over = await chunked.response();
    assert.equal(over.status, 413);
    assert.match(over.text, /retry-after: 60/i);
    // chunked 자체는 막지 않는다. 합이 상한 안이면 받는다.
    const fine = eventBody(who, ctx.f.now());
    const headers = Object.entries(signedHeaders(who, fine, ctx.f.now())).map(([k, v]) => `${k}: ${v}`).join('\r\n');
    const half = Math.floor(fine.length / 2);
    const encode = (part: string) => `${Buffer.byteLength(part).toString(16)}\r\n${part}\r\n`;
    const ok = await raw(server, `POST ${EXTERNAL_TASK_PATH} HTTP/1.1\r\nHost: fixture\r\nConnection: close\r\nTransfer-Encoding: chunked\r\n${headers}\r\n\r\n${encode(fine.slice(0, half))}${encode(fine.slice(half))}0\r\n\r\n`);
    assert.equal(ok.status, 202);
    const compressedTe = await raw(server, `POST ${EXTERNAL_TASK_PATH} HTTP/1.1\r\nHost: fixture\r\nConnection: close\r\ncontent-type: application/json\r\nTransfer-Encoding: gzip, chunked\r\n\r\n0\r\n\r\n`);
    assert.equal(compressedTe.status, 415);
    assert.equal(await ctx.count('external_task_events'), 1);
  } finally { await shut(server); await ctx.close(); }
});

test('R08 HTTP: 헤더 8 KiB를 넘으면 431, 헤더·본문이 느리면 끊고 동시 처리 수에 포함한다', async () => {
  assert.deepEqual([RECEIVER_LIMITS.headerBytes, RECEIVER_LIMITS.headerTimeoutMs, RECEIVER_LIMITS.bodyTimeoutMs, RECEIVER_LIMITS.concurrent], [8192, 5000, 5000, 8]);
  const ctx = await receiverFixture({ globalBurst: 1000, headerTimeoutMs: 200, bodyTimeoutMs: 200 });
  const server = externalTaskServer(ctx.receiver);
  await listen(server);
  try {
    assert.equal(server.maxConnections, RECEIVER_LIMITS.maxConnections);
    const within = await raw(server, request('POST', EXTERNAL_TASK_PATH, { 'content-type': 'application/json', 'x-fill': 'x'.repeat(7000) }));
    assert.equal(within.status, 400);
    const over = await raw(server, request('POST', EXTERNAL_TASK_PATH, { 'content-type': 'application/json', 'x-fill': 'x'.repeat(8200) }));
    assert.equal(over.status, 431);
    const slowHeader = rawClient(server);
    slowHeader.write(`POST ${EXTERNAL_TASK_PATH} HTTP/1.1\r\nHost: fixture\r\n`);
    const header = await slowHeader.response();
    assert.equal(header.status, 408);
    const slowBody = rawClient(server);
    slowBody.write(`POST ${EXTERNAL_TASK_PATH} HTTP/1.1\r\nHost: fixture\r\ncontent-type: application/json\r\nContent-Length: 100\r\n\r\nabc`);
    const body = await slowBody.response();
    assert.equal(body.status, 408);
    const metrics = await ctx.receiver.metrics();
    assert.match(metrics, /outcome="header_timeout"} 1/);
    assert.match(metrics, /outcome="body_timeout"} 1/);
    assert.match(metrics, /outcome="header_too_large"} 1/);
  } finally { await shut(server); await ctx.close(); }
});

test('R08 HTTP: 동시 처리 상한을 넘으면 503과 Retry-After, 끝나면 다시 받는다', async () => {
  const ctx = await receiverFixture({ globalBurst: 1000, concurrent: 2, bodyTimeoutMs: 2000 });
  const server = externalTaskServer(ctx.receiver);
  await listen(server);
  try {
    const open = [rawClient(server), rawClient(server)];
    for (const client of open) client.write(`POST ${EXTERNAL_TASK_PATH} HTTP/1.1\r\nHost: fixture\r\ncontent-type: application/json\r\nContent-Length: 100\r\n\r\nabc`);
    await new Promise(resolve => setTimeout(resolve, 100));
    const rejected = await raw(server, request('POST', EXTERNAL_TASK_PATH, { 'content-type': 'application/json' }, '{}'));
    assert.equal(rejected.status, 503);
    assert.match(rejected.text, /retry-after: 1/i);
    for (const client of open) client.destroy();
    await new Promise(resolve => setTimeout(resolve, 100));
    assert.match(await ctx.receiver.metrics(), /homelab_bot_external_task_in_flight 0/);
    const after = await raw(server, request('POST', EXTERNAL_TASK_PATH, { 'content-type': 'application/json' }, '{}'));
    assert.equal(after.status, 400);
  } finally { await shut(server); await ctx.close(); }
});

const until = async (check: () => boolean | Promise<boolean>, ms = 2000) => {
  const deadline = Date.now() + ms;
  while (!await check()) {
    assert.ok(Date.now() < deadline, 'until_timeout');
    await new Promise(resolve => setTimeout(resolve, 5));
  }
};
// 첫 DB 단계가 풀어 줄 때까지 멈춘다. 슬롯을 쥔 작업이 DB에 묶인 상황이다.
function stuckFence() {
  let calls = 0;
  let release!: () => void;
  const held = new Promise<void>(resolve => { release = resolve; });
  return { links: { enforceRestoreFence: async () => { calls++; await held; return { fenced: 0 }; } }, calls: () => calls, release: () => release() };
}
const postEvent = (ctx: Awaited<ReturnType<typeof receiverFixture>>, server: Parameters<typeof raw>[0], who: ReturnType<typeof sender>) => {
  const body = eventBody(who, ctx.f.now());
  return raw(server, request('POST', EXTERNAL_TASK_PATH, signedHeaders(who, body, ctx.f.now()), body));
};

test('R08 DB 대기: 대기열이 차면 곧바로 503 overloaded이고, 슬롯이 묶인 채 요청이 계속 와도 대기가 상한을 넘지 않는다', async () => {
  const stuck = stuckFence();
  const ctx = await receiverFixture({ globalBurst: 100_000, connectionBurst: 1000, concurrent: 64, dbSlots: 1, dbQueue: 1, processingTimeoutMs: 200 }, { links: stuck.links });
  const server = externalTaskServer(ctx.receiver);
  await listen(server);
  try {
    const who = await ctx.attach();
    const running = postEvent(ctx, server, who);
    await until(() => stuck.calls() === 1);
    const queued = postEvent(ctx, server, who);
    await until(async () => /external_task_db_waiting 1/.test(await ctx.receiver.metrics()));
    const started = Date.now();
    const full = await postEvent(ctx, server, who);
    assert.equal(full.status, 503);
    assert.match(full.text, /"error":"overloaded"/);
    assert.match(full.text, /retry-after: 5/i);
    assert.ok(Date.now() - started < 150, '대기열이 찼으면 기한까지 기다리지 않는다');
    for (const response of [await running, await queued]) {
      assert.equal(response.status, 503);
      assert.match(response.text, /"error":"unavailable"/);
    }
    // 앞 응답이 닫혀 HTTP 동시 수는 줄었지만 DB 대기는 쌓이지 않는다.
    for (let round = 0; round < 4; round++) {
      const replies = await Promise.all(Array.from({ length: 5 }, () => postEvent(ctx, server, who)));
      assert.deepEqual(replies.map(response => response.status), Array(5).fill(503));
      assert.equal(replies.filter(response => /"error":"overloaded"/.test(response.text)).length, 4);
    }
    const metrics = await ctx.receiver.metrics();
    assert.match(metrics, /homelab_bot_external_task_db_waiting 0/);
    assert.match(metrics, /homelab_bot_external_task_db_busy 1/);
    stuck.release();
    await until(async () => /external_task_db_busy 0/.test(await ctx.receiver.metrics()));
    assert.equal(stuck.calls(), 1);
    assert.equal(await ctx.count('external_task_events'), 0);
    assert.equal((await postEvent(ctx, server, who)).status, 202);
    assert.deepEqual([RECEIVER_LIMITS.dbSlots, RECEIVER_LIMITS.dbQueue], [2, 6]);
  } finally { stuck.release(); await shut(server); await ctx.close(); }
});

test('R08 DB 대기: 기한이 지난 대기 작업은 슬롯이 풀려도 시작하지 않고, 기한이 지난 실행 작업은 다음 단계로 가지 않는다', async () => {
  const stuck = stuckFence();
  const ctx = await receiverFixture({ globalBurst: 100_000, connectionBurst: 1000, concurrent: 64, dbSlots: 1, dbQueue: 100, processingTimeoutMs: 100 }, { links: stuck.links });
  const server = externalTaskServer(ctx.receiver);
  await listen(server);
  try {
    const who = await ctx.attach();
    const replies = await Promise.all(Array.from({ length: 6 }, () => postEvent(ctx, server, who)));
    for (const response of replies) {
      assert.equal(response.status, 503);
      assert.match(response.text, /"error":"unavailable"/);
      assert.match(response.text, /retry-after: 5/i);
    }
    stuck.release();
    await new Promise(resolve => setTimeout(resolve, 100));
    assert.equal(stuck.calls(), 1);
    assert.equal(await ctx.count('external_task_events'), 0);
    assert.equal(await ctx.count('outbox'), 0);
  } finally { stuck.release(); await shut(server); await ctx.close(); }
});

test('R08 DB 대기: 슬롯을 넘겨받은 직후 기한이 지났으면 작업을 시작하지 않고 슬롯을 다음에 넘긴다', async () => {
  const slots = new Slots(1, 2);
  let release!: () => void;
  const first = slots.run(new AbortController().signal, () => new Promise<void>(resolve => { release = resolve; }));
  const late = new AbortController();
  const started: string[] = [];
  const second = slots.run(late.signal, async () => { started.push('late'); });
  const third = slots.run(new AbortController().signal, async () => { started.push('next'); });
  assert.equal(slots.queued, 2);
  await assert.rejects(slots.run(new AbortController().signal, async () => {}), SlotsFull);
  release();
  // 첫 작업의 finally가 슬롯을 넘긴 뒤, 넘겨받은 쪽이 이어 달리기 전에 기한이 지난다.
  while (slots.queued === 2) await Promise.resolve();
  late.abort(new ProcessingExpired());
  await first;
  await assert.rejects(second, ProcessingExpired);
  await third;
  assert.deepEqual(started, ['next']);
  assert.deepEqual([slots.busy, slots.queued], [0, 0]);
  // 줄에서 기다리다 기한이 지나면 곧바로 빠진다.
  const holder = new Slots(1, 1);
  let open!: () => void;
  const held = holder.run(new AbortController().signal, () => new Promise<void>(resolve => { open = resolve; }));
  const waiting = new AbortController();
  const gone = holder.run(waiting.signal, async () => { started.push('gone'); });
  waiting.abort(new ProcessingExpired());
  await assert.rejects(gone, ProcessingExpired);
  assert.equal(holder.queued, 0);
  open();
  await held;
  assert.equal(holder.busy, 0);
  assert.deepEqual(started, ['next']);
});

test('R08 HTTP: 거절한 소켓을 상대가 닫지 않아도 서버가 닫아 소켓 상한 자리를 돌려받는다', async () => {
  const ctx = await receiverFixture({ globalBurst: 1000 });
  const server = externalTaskServer(ctx.receiver);
  await listen(server);
  const open = () => new Promise<number>(resolve => server.getConnections((_error, count) => resolve(count)));
  const port = (server.address() as AddressInfo).port;
  try {
    for (const text of ['NOT HTTP\r\n\r\n', `POST ${EXTERNAL_TASK_PATH} HTTP/1.1\r\nHost: fixture\r\nx-fill: ${'x'.repeat(8200)}\r\n\r\n`, request('POST', '/nope', {})]) {
      // FIN을 받아도 자기 쪽은 닫지 않는 클라이언트다.
      const socket = connect({ port, host: '127.0.0.1', allowHalfOpen: true });
      const answered = new Promise<void>(resolve => { socket.once('end', () => resolve()); });
      socket.on('data', () => {});
      socket.on('error', () => {});
      socket.write(text);
      await answered;
      await until(async () => await open() === 0, 1000);
      socket.destroy();
    }
  } finally { await shut(server); await ctx.close(); }
});

test('R08 HTTP: 전체 token bucket은 초당 10·burst 20이고 초과는 429와 Retry-After다', async () => {
  assert.deepEqual([RECEIVER_LIMITS.globalPerSecond, RECEIVER_LIMITS.globalBurst], [10, 20]);
  const ctx = await receiverFixture();
  const server = externalTaskServer(ctx.receiver);
  await listen(server);
  try {
    for (let i = 0; i < 20; i++) assert.equal((await raw(server, request('GET', '/nope', {}))).status, 404, `burst ${i}`);
    const limited = await raw(server, request('GET', '/nope', {}));
    assert.equal(limited.status, 429);
    assert.match(limited.text, /retry-after: 1/i);
    ctx.f.advance(100);
    assert.equal((await raw(server, request('GET', '/nope', {}))).status, 404);
    assert.equal((await raw(server, request('GET', '/nope', {}))).status, 429);
  } finally { await shut(server); await ctx.close(); }
});

test('R08 원자성: outbox 삽입이 실패하면 이벤트가 남지 않고 503이며, 같은 재시도가 통과하고 로그에 본문이 없다', async () => {
  const lines: string[] = [];
  const ctx = await receiverFixture({ globalBurst: 1000, connectionBurst: 100 }, { log: (event, detail) => { lines.push(JSON.stringify({ event, detail })); } });
  const server = externalTaskServer(ctx.receiver);
  await listen(server);
  try {
    const who = await ctx.attach('atomic-session', true);
    const body = eventBody(who, ctx.f.now(), { summary: 'ATOMIC-MARKER 요약' });
    await atomicityScenario(ctx.db, async text => raw(server, request('POST', EXTERNAL_TASK_PATH, signedHeaders(who, text, ctx.f.now()), text)), body, who.connectionId);
    const log = lines.join('\n');
    assert.match(log, /external_task_error/);
    assert.equal(log.includes('ATOMIC-MARKER') || log.includes(who.connectionId), false);
  } finally { await shut(server); await ctx.close(); }
});

test('R08 관측: 지표에는 고정 라벨과 수만 있고 본문·연결 ID·헤더가 없다', async () => {
  const ctx = await receiverFixture({ globalBurst: 1000 });
  const server = externalTaskServer(ctx.receiver);
  await listen(server);
  try {
    const who = await ctx.attach('metrics-session', true);
    const body = eventBody(who, ctx.f.now(), { summary: 'METRIC-MARKER' });
    const signed = signedHeaders(who, body, ctx.f.now());
    assert.equal((await raw(server, request('POST', EXTERNAL_TASK_PATH, signed, body))).status, 202);
    assert.equal((await raw(server, request('POST', '/nope', signed, body))).status, 404);
    const metrics = await ctx.receiver.metrics();
    assert.match(metrics, /homelab_bot_external_task_requests\{outcome="accepted"\} 1/);
    assert.match(metrics, /homelab_bot_external_task_requests\{outcome="not_found"\} 1/);
    assert.match(metrics, /homelab_bot_external_task_unposted 1/);
    assert.match(metrics, /homelab_bot_external_task_latency_seconds_count 2/);
    for (const value of ['METRIC-MARKER', who.connectionId, who.keyId, 'metrics-session', signed['x-r08-signature']]) assert.equal(metrics.includes(value), false, value);
    for (const line of metrics.trim().split('\n')) assert.match(line, /^homelab_bot_external_task_[a-z_]+(\{outcome="[a-z_]+"\})? [0-9.]+$/);
  } finally { await shut(server); await ctx.close(); }
});

test('R08 경계: 수신 모듈은 main.ts에 연결되지 않았고 모델·작업·제어 코드를 import하지 않는다', async () => {
  const main = await readFile('src/main.ts', 'utf8');
  assert.doesNotMatch(main, /external-task/);
  const source = `${await readFile('src/external-task-receiver.ts', 'utf8')}\n${await readFile('src/external-task-links.ts', 'utf8')}`;
  for (const match of source.matchAll(/from '\.\/([a-z-]+)\.js'/g)) {
    assert.ok(['contracts', 'database', 'external-task-links', 'log', 'store'].includes(match[1]!), match[1]);
  }
});
