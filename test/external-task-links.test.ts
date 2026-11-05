import { test } from 'node:test';
import assert from 'node:assert/strict';
import { sign, verify, createPublicKey, createPrivateKey } from 'node:crypto';
import { inspect } from 'node:util';
import { Denied } from '../src/contracts.js';
import type { Scope } from '../src/contracts.js';
import { AlreadyAttached, ConnectionClosed, EXTERNAL_EVENT_RETENTION_MS, EXTERNAL_LINK_TTL_MS, EXTERNAL_TASK_CAPABILITIES, ExternalTaskLinks, OneTimeSeed } from '../src/external-task-links.js';
import { Store } from '../src/store.js';
import { thread } from './helpers.js';
import { SESSION, eventBody, receiverFixture, sender, signedHeaders } from './external-task-fixture.js';

const OWNER = 'fixture-owner';
const accept = async (ctx: Awaited<ReturnType<typeof receiverFixture>>, who: ReturnType<typeof sender>) => {
  const body = eventBody(who, ctx.f.now());
  return { body, reply: await ctx.receiver.receive(signedHeaders(who, body, ctx.f.now()), Buffer.from(body)) };
};

test('R08 연결: 일회 seed는 한 번만 꺼낼 수 있고 문자열·JSON·inspect로 나오지 않으며 서버에는 public key만 남는다', async () => {
  const ctx = await receiverFixture();
  try {
    const link = await ctx.links.attach({ owner: OWNER, scope: thread, externalTaskId: SESSION, executor: 'claude' });
    const seen = [String(link.seed), JSON.stringify(link), inspect(link, { depth: 5 }), `${link.seed}`];
    assert.equal(link.seed.revealed, false);
    const seed = link.seed.reveal();
    assert.match(seed, /^[A-Za-z0-9_-]{43}$/);
    assert.equal(link.seed.revealed, true);
    assert.throws(() => link.seed.reveal(), /external_seed_already_revealed/);
    for (const text of seen) assert.equal(text.includes(seed), false);
    // 일회 값이 저장 경계를 넘지 않는다.
    const dump = JSON.stringify([
      (await ctx.db.query('SELECT * FROM external_task_connections')).rows,
      (await ctx.db.query('SELECT * FROM audit')).rows,
      (await ctx.db.query('SELECT * FROM outbox')).rows,
    ]);
    assert.equal(dump.includes(seed), false);
    assert.ok(dump.includes(link.keyId));
    // 돌려준 seed와 저장한 public key가 짝이다.
    const row = (await ctx.db.query<{ public_key: string; expires_at: string; summary_consent: boolean }>('SELECT public_key,expires_at,summary_consent FROM external_task_connections')).rows[0]!;
    const privateKey = createPrivateKey({ key: Buffer.concat([Buffer.from('302e020100300506032b657004220420', 'hex'), Buffer.from(seed, 'base64url')]), format: 'der', type: 'pkcs8' });
    const publicKey = createPublicKey({ key: { kty: 'OKP', crv: 'Ed25519', x: row.public_key }, format: 'jwk' });
    assert.ok(verify(null, Buffer.from('m'), publicKey, sign(null, Buffer.from('m'), privateKey)));
    assert.equal(Number(row.expires_at), ctx.f.now() + EXTERNAL_LINK_TTL_MS);
    assert.equal(EXTERNAL_LINK_TTL_MS, 30 * 24 * 3_600_000);
    assert.equal(row.summary_consent, false);
  } finally { await ctx.close(); }
});

test('R08 연결: OneTimeSeed는 outbox·감사에 실수로 실려도 값이 남지 않는다', () => {
  const seed = new OneTimeSeed('secret-seed-value');
  assert.equal(JSON.stringify({ seed }).includes('secret-seed-value'), false);
  assert.equal(inspect({ seed }).includes('secret-seed-value'), false);
  assert.equal(new Error(`${seed}`).message.includes('secret-seed-value'), false);
});

test('R08 연결: attach는 현재 owner의 활성 대화에서만, 등록 형식의 ID로만 된다', async () => {
  const ctx = await receiverFixture();
  try {
    const attach = (input: { owner?: string; scope?: Scope; externalTaskId?: string; executor?: 'claude' | 'codex' }) =>
      ctx.links.attach({ owner: input.owner ?? OWNER, scope: input.scope ?? thread, externalTaskId: input.externalTaskId ?? SESSION, executor: input.executor ?? 'claude' });
    await assert.rejects(attach({ owner: 'other' }), Denied);
    await assert.rejects(attach({ scope: { ...thread, channel: 'missing' } }), Denied);
    await assert.rejects(attach({ scope: { guild: 'fixture-guild', channel: 'fixture-chat', parent: null, kind: 'channel' } }), Denied);
    for (const externalTaskId of ['/Users/fixture/project', '../x', 'a b', '', 'x'.repeat(129), '~/.claude/x']) await assert.rejects(attach({ externalTaskId }), `ID 거절: ${externalTaskId}`);
    await assert.rejects(attach({ executor: 'other' as 'claude' }));
    await ctx.db.query('UPDATE conversations SET active=false');
    await assert.rejects(attach({}), Denied);
    await ctx.db.query('UPDATE conversations SET active=true');
    assert.equal(await ctx.count('external_task_connections'), 0);
    await attach({});
    await assert.rejects(attach({}), AlreadyAttached);
    await attach({ executor: 'codex' });
    // 만료된 연결은 자리를 막지 않는다.
    ctx.f.advance(EXTERNAL_LINK_TTL_MS);
    await attach({});
    const reasons = (await ctx.db.query<{ revoked_reason: string | null }>("SELECT revoked_reason FROM external_task_connections WHERE executor='claude' ORDER BY created_at")).rows;
    assert.deepEqual(reasons.map(row => row.revoked_reason), ['expired', null]);
  } finally { await ctx.close(); }
});

test('R08 연결: 기기 분실 재발급은 이전 키를 즉시 막고 새 키만 받으며, 이전 키로 들어온 미게시 행을 막는다', async () => {
  const ctx = await receiverFixture();
  try {
    const before = await ctx.attach();
    const first = await accept(ctx, before);
    assert.equal(first.reply.outcome, 'accepted');
    const issued = await ctx.links.rotate(before.connectionId, OWNER);
    const after = sender(issued);
    assert.notEqual(after.seed, before.seed);
    assert.notEqual(after.keyId, before.keyId);
    assert.equal((await accept(ctx, before)).reply.outcome, 'unauthorized');
    // 옛 seed로 새 key_id를 주장해도 서명이 맞지 않는다.
    assert.equal((await accept(ctx, { ...before, keyId: after.keyId })).reply.outcome, 'unauthorized');
    assert.equal((await accept(ctx, after)).reply.outcome, 'accepted');
    const states = (await ctx.db.query<{ state: string }>('SELECT state FROM outbox ORDER BY created_at,id')).rows.map(row => row.state).sort();
    assert.deepEqual(states, ['blocked', 'pending']);
    await assert.rejects(ctx.links.rotate(before.connectionId, 'other'), Denied);
    const audit = JSON.stringify((await ctx.db.query('SELECT detail FROM audit')).rows);
    assert.equal(audit.includes(after.seed) || audit.includes(before.seed), false);
  } finally { await ctx.close(); }
});

test('R08 연결: 해제·전달 실패 폐기는 수신을 막고, 미게시 outbox와 발송 시작 전 sending을 막되 발송 시작한 행은 건드리지 않는다', async () => {
  const ctx = await receiverFixture();
  try {
    const who = await ctx.attach();
    for (let i = 0; i < 3; i++) assert.equal((await accept(ctx, who)).reply.outcome, 'accepted');
    const rows = (await ctx.db.query<{ id: string }>('SELECT id FROM outbox ORDER BY id')).rows;
    await ctx.db.query(`UPDATE outbox SET state='sending',dispatch_started=false,lease_token='a',lease_until=$2 WHERE id=$1`, [rows[0]!.id, ctx.f.now() + 60_000]);
    await ctx.db.query(`UPDATE outbox SET state='sending',dispatch_started=true,lease_token='b',lease_until=$2 WHERE id=$1`, [rows[1]!.id, ctx.f.now() + 60_000]);
    await assert.rejects(ctx.links.detach(who.connectionId, 'other'), Denied);
    assert.deepEqual(await ctx.links.detach(who.connectionId, OWNER), { blocked: 2 });
    const state = async (id: string) => (await ctx.db.query<{ state: string }>('SELECT state FROM outbox WHERE id=$1', [id])).rows[0]!.state;
    assert.equal(await state(rows[0]!.id), 'blocked');
    assert.equal(await state(rows[1]!.id), 'sending');
    assert.equal(await state(rows[2]!.id), 'blocked');
    // 발송 시작 전 sending은 게시자의 dispatch 표시가 실패해 나가지 못한다.
    const stale = { id: rows[0]!.id, lease_token: 'a' } as Parameters<typeof ctx.f.store.dispatchDelivery>[0];
    assert.equal(await ctx.f.store.dispatchDelivery(stale), false);
    assert.equal((await accept(ctx, who)).reply.outcome, 'unauthorized');
    // 두 번 닫아도 처음 사유가 남는다.
    assert.deepEqual(await ctx.links.revoke(who.connectionId, OWNER, 'lost_device'), { blocked: 0 });
    const closed = (await ctx.db.query<{ revoked_reason: string }>('SELECT revoked_reason FROM external_task_connections')).rows[0]!;
    assert.equal(closed.revoked_reason, 'detach');
    await assert.rejects(ctx.links.rotate(who.connectionId, OWNER), ConnectionClosed);
    assert.equal((await ctx.f.publisher.deliver()), false);
    assert.equal(ctx.f.rest.messages.length, 0);
    const states = (await ctx.db.query<{ post_state: string }>('SELECT post_state FROM external_task_events')).rows.map(row => row.post_state).sort();
    assert.deepEqual(states, ['blocked', 'blocked', 'pending']);
  } finally { await ctx.close(); }
});

test('R08 복원 울타리: 복원으로 옛 값이 돌아오면 되살아난 키를 모두 닫고, 미게시 행을 막고, 감사를 남긴다', async () => {
  const ctx = await receiverFixture();
  try {
    const who = await ctx.attach();
    assert.equal((await accept(ctx, who)).reply.outcome, 'accepted');
    const token = (await ctx.db.query<{ token: string }>('SELECT token FROM external_task_link_fence')).rows[0]!.token;
    assert.match(token, /^timeline:[0-9A-F]{8};epoch:0$/);
    assert.equal(await ctx.count('audit WHERE kind=\'external_task_restore_fence\''), 0);
    // 복원된 DB에는 그 백업 시점의 timeline이 들어 있고 서버는 새 timeline에 있다. 이 불일치를 만든다.
    await ctx.db.query(`UPDATE external_task_link_fence SET token='timeline:00000000;epoch:0'`);
    assert.equal((await accept(ctx, who)).reply.outcome, 'unauthorized');
    const row = (await ctx.db.query<{ revoked_reason: string }>('SELECT revoked_reason FROM external_task_connections')).rows[0]!;
    assert.equal(row.revoked_reason, 'restore_fence');
    assert.equal((await ctx.db.query<{ state: string }>('SELECT state FROM outbox')).rows[0]!.state, 'blocked');
    assert.equal(await ctx.count('audit WHERE kind=\'external_task_restore_fence\''), 1);
    assert.equal((await ctx.db.query<{ token: string }>('SELECT token FROM external_task_link_fence')).rows[0]!.token, token);
    assert.deepEqual(await ctx.links.enforceRestoreFence(), { fenced: 0 });
    // 다시 연결하면 정상이다.
    const again = await ctx.attach();
    assert.equal((await accept(ctx, again)).reply.outcome, 'accepted');
    // 논리 복원처럼 timeline이 그대로면 운영자가 올린 epoch가 같은 일을 한다.
    const bumped = new ExternalTaskLinks(ctx.f.store, { restoreEpoch: '2026-11-05' });
    assert.deepEqual(await bumped.enforceRestoreFence(), { fenced: 1 });
    assert.equal(await ctx.count('external_task_connections WHERE revoked_at IS NULL'), 0);
    assert.throws(() => new ExternalTaskLinks(ctx.f.store, { restoreEpoch: 'a b' }), /external_restore_epoch_invalid/);
  } finally { await ctx.close(); }
});

test('R08 복원 울타리: 지금 timeline을 읽지 못하면 throw해서 수신이 닫힌다', async () => {
  const broken = new ExternalTaskLinks(new Store({
    query: async () => { throw new Error('db_down'); }, transaction: async () => { throw new Error('db_down'); },
  }));
  await assert.rejects(broken.enforceRestoreFence(), /db_down/);
});

test('R08 능력: 읽기 둘만 true이고 상태·이벤트는 owner와 같은 대화에만 보이며 요약 원문이 없다', async () => {
  const ctx = await receiverFixture();
  try {
    assert.deepEqual(EXTERNAL_TASK_CAPABILITIES, { read_status: true, read_events: true, start_task: false, answer_question: false,
      request_cancel: false, resume_task: false, read_final_result: false });
    const link = await ctx.links.attach({ owner: OWNER, scope: thread, externalTaskId: SESSION, executor: 'codex', summaryConsent: true });
    const who = sender(link);
    const body = eventBody(who, ctx.f.now(), { summary: '테스트 보고: 빌드 끝남' });
    assert.equal((await ctx.receiver.receive(signedHeaders(who, body, ctx.f.now()), Buffer.from(body))).outcome, 'accepted');
    const status = await ctx.links.status(who.connectionId, OWNER, thread);
    assert.equal(status.state, 'active');
    assert.equal(status.lastEventAt, ctx.f.now());
    assert.equal(status.capabilities.read_events, true);
    const events = await ctx.links.events(who.connectionId, OWNER, thread);
    assert.equal(events.length, 1);
    assert.equal(events[0]!.postState, 'pending');
    assert.equal(JSON.stringify(events).includes('빌드 끝남'), false);
    const raw = JSON.stringify((await ctx.db.query('SELECT * FROM external_task_events')).rows);
    assert.equal(raw.includes('빌드 끝남'), false);
    await assert.rejects(ctx.links.status(who.connectionId, 'other', thread), Denied);
    await assert.rejects(ctx.links.events(who.connectionId, OWNER, { ...thread, channel: 'elsewhere' }), Denied);
    await ctx.links.setSummaryConsent(who.connectionId, OWNER, false);
    const later = eventBody(who, ctx.f.now(), { summary: '테스트 보고' });
    assert.equal((await ctx.receiver.receive(signedHeaders(who, later, ctx.f.now()), Buffer.from(later))).outcome, 'summary_consent_required');
    ctx.f.advance(EXTERNAL_LINK_TTL_MS);
    assert.equal((await ctx.links.status(who.connectionId, OWNER, thread)).state, 'expired');
  } finally { await ctx.close(); }
});

test('R08 보관: 중복 방지 ID는 게시 뒤 최소 7일 남고, 미게시 행은 지우지 않으며, 닫힌 연결은 그 뒤에 지운다', async () => {
  const ctx = await receiverFixture({ connectionBurst: 100 });
  try {
    assert.equal(EXTERNAL_EVENT_RETENTION_MS, 7 * 24 * 3_600_000);
    const who = await ctx.attach();
    const posted = await accept(ctx, who);
    assert.equal(await ctx.f.publisher.deliver(), true);
    assert.equal((await ctx.db.query<{ post_state: string }>('SELECT post_state FROM external_task_events')).rows[0]!.post_state, 'posted');
    assert.equal((await accept(ctx, who)).reply.outcome, 'accepted');
    // 7일 직전: 게시한 행도 남아 재생이 중복으로 잡힌다.
    ctx.f.advance(EXTERNAL_EVENT_RETENTION_MS - 1);
    assert.deepEqual(await ctx.links.purge(), { events: 0, connections: 0 });
    ctx.f.advance(1 + 1);
    assert.deepEqual(await ctx.links.purge(), { events: 1, connections: 0 });
    assert.equal(await ctx.count('external_task_events'), 1);
    // 24시간이 지난 본문은 지워진 뒤에도 시각 창에서 거절된다.
    const replay = await ctx.receiver.receive(signedHeaders(who, posted.body, ctx.f.now()), Buffer.from(posted.body));
    assert.equal(replay.outcome, 'occurred_at_window');
    await ctx.links.detach(who.connectionId, OWNER);
    ctx.f.advance(31 * 24 * 3_600_000);
    assert.deepEqual(await ctx.links.purge(), { events: 1, connections: 1 });
    assert.equal(await ctx.count('external_task_connections'), 0);
  } finally { await ctx.close(); }
});

test('R08 저장: 키 형식과 범위를 DB가 다시 막고, 봇 작업 표에 행을 만들지 않는다', async () => {
  const ctx = await receiverFixture();
  try {
    const who = await ctx.attach();
    assert.equal((await accept(ctx, who)).reply.outcome, 'accepted');
    assert.equal(await ctx.count('jobs'), 0);
    assert.equal(await ctx.count('codex_sessions'), 0);
    assert.equal(await ctx.count('events'), 0);
    await assert.rejects(ctx.db.query(`UPDATE external_task_connections SET public_key='short'`));
    await assert.rejects(ctx.db.query(`UPDATE external_task_connections SET external_task_id='/home/x'`));
    await assert.rejects(ctx.db.query(`UPDATE external_task_connections SET executor='other'`));
    await assert.rejects(ctx.db.query(`UPDATE external_task_connections SET revoked_at=1`));
    await assert.rejects(ctx.db.query(`UPDATE external_task_events SET post_state='other'`));
    const columns = (await ctx.db.query<{ column_name: string }>(`SELECT column_name FROM information_schema.columns WHERE table_name IN ('external_task_connections','external_task_events')`)).rows.map(row => row.column_name);
    for (const name of columns) assert.doesNotMatch(name, /seed|private|summary$|body$/);
  } finally { await ctx.close(); }
});
