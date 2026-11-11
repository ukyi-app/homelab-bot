import { after, before, beforeEach, test } from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULTS, Denied, RateLimited } from '../src/contracts.js';
import type { Proposal } from '../src/contracts.js';
import type { Database } from '../src/database.js';
import { ALL_COMMANDS, DiscordIngress, EXTERNAL_ACK_NOTICE } from '../src/discord.js';
import { CUSTOM_ID_MAX, DiscordProtocol } from '../src/discord-protocol.js';
import { ExternalTaskCommands, SESSION_KEY_TEXT } from '../src/external-task-commands.js';
import { ExternalTaskLinks, OneTimeSeed } from '../src/external-task-links.js';
import { PROPOSAL_TEXT, PROPOSAL_TTL_MS } from '../src/proposals.js';
import { Runtime } from '../src/runtime.js';
import { ENVIRONMENT, SESSION, seedConversation } from './external-task-fixture.js';
import { event, fixture, localDatabase, thread } from './helpers.js';

// C15 세션 연결 키 버튼의 S1 경계. 수신은 Gateway 프레임(메시지·버튼 상호작용) → DiscordProtocol, 게시는 가짜 REST,
// 연결은 실제 ExternalTaskLinks(PGlite)다. 키 값은 찾기 쉬운 가짜 값으로 바꿔 응답 밖 어디에도 없는지 본다.
const BOT = '900000000000000001';
const FAKE_SEED = 'FAKE-C15-SEED-do-not-leak-0123456789abcdefghij';
const REQUEST = '이 세션 봇에 연결해 줘';

let database: Awaited<ReturnType<typeof localDatabase>>;
before(async () => { database = await localDatabase(); });
beforeEach(async () => {
  await database.pg.exec(`TRUNCATE events,conversations,jobs,results,outbox,controls,audit,denied_actors,proposals,external_task_connections
    RESTART IDENTITY CASCADE`);
});
after(async () => { await database.pg.close(); });

interface Options { colleague?: boolean; external?: boolean; revoke?: () => Promise<{ blocked: number }> }
async function harness(db: Database, options: Options = {}) {
  const f = await fixture(db, { colleague: options.colleague ?? true });
  const external = options.external ?? true;
  const links = new ExternalTaskLinks(f.store);
  const logged: string[] = [];
  const log = (name: string, detail?: Record<string, unknown>) => { logged.push(JSON.stringify({ name, ...detail })); };
  let attaches = 0;
  let attachMs = 0;
  const handler = new ExternalTaskCommands({
    attach: async input => { attaches++; f.advance(attachMs); return { ...await links.attach(input), seed: new OneTimeSeed(FAKE_SEED) }; },
    detach: links.detach.bind(links), list: links.list.bind(links), revoke: options.revoke ?? links.revoke.bind(links),
  }, ENVIRONMENT, log);
  const callbacks: { body: { type: number; data: Record<string, unknown> } }[] = [];
  let failCallback: (content: string) => boolean = () => false;
  const protocol = new DiscordProtocol({ request: async (method, path, body) => {
    if (method === 'GET' && path === `/channels/${thread.channel}`) return { id: thread.channel, type: 11, parent_id: thread.parent, guild_id: thread.guild };
    if (method === 'PUT') return undefined;
    if (method === 'POST' && path.endsWith('/callback')) {
      const sent = body as { type: number; data: Record<string, unknown> };
      callbacks.push({ body: sent });
      if (failCallback(String(sent.data.content ?? ''))) throw new Error(`transport failed: ${String(sent.data.content)}`);
      return undefined;
    }
    throw new Error(`unexpected_route ${method} ${path}`);
  } }, BOT, f.now);
  const ingress = new DiscordIngress(f.store, f.gate, protocol, true, ALL_COMMANDS, log, undefined, undefined, external ? handler : undefined);
  // 대화 runtime은 R08 스위치를 조립(main.ts)과 같은 인수로 받는다.
  const runtime = new Runtime(f.store, f.gate, f.worker, f.signer, f.reader, undefined, { externalTask: external });
  let interactions = 0;
  return {
    f, ingress, callbacks, logged, attaches: () => attaches,
    failCallbacks: (predicate: (content: string) => boolean) => { failCallback = predicate; },
    slowAttach: (ms: number) => { attachMs = ms; },
    reply: (proposal: Proposal | null) => f.setRun(async () => ({ status: 'succeeded', stopped: true, rateLimit: null,
      output: { reply: '그 세션을 이 스레드에 이을게요. 아래에서 확인해 주세요.', proposal, ack_only: false } })),
    say: (id: string, text: string) => protocol.gateway('MESSAGE_CREATE', { id, channel_id: thread.channel, guild_id: thread.guild,
      author: { id: f.policy.owner }, content: `<@${BOT}> ${text}`, mentions: [{ id: BOT }] }, ingress),
    turn: async () => {
      f.advance(DEFAULTS.debounceMs + 50);
      await runtime.tick();
      await publish();
    },
    publish,
    press: (customId: string, actor = f.policy.owner) => protocol.gateway('INTERACTION_CREATE', { id: `fixture-interaction-${++interactions}`,
      token: 'fixture-interaction-token', type: 3, channel_id: thread.channel, guild_id: thread.guild, member: { user: { id: actor } },
      data: { custom_id: customId } }, ingress),
    // 마지막으로 게시된 버튼 글. 게시기가 붙이는 `-# ref:` 꼬리 줄은 문구 비교에서 뺀다.
    buttons: () => {
      const last = f.rest.messages.filter(m => m.body.components?.length).at(-1);
      return { content: (last?.body.content ?? '').split('\n-# ref:')[0]!, ids: last?.body.components?.[0]?.components.map(c => c.custom_id) ?? [],
        labels: last?.body.components?.[0]?.components.map(c => c.label) ?? [] };
    },
    connections: async () => (await db.query<{ id: string; revoked_reason: string | null; executor: string; external_task_id: string; summary_consent: boolean }>(
      'SELECT id,revoked_reason,executor,external_task_id,summary_consent FROM external_task_connections ORDER BY created_at')).rows,
  };
  async function publish() { while (await f.publisher.deliver()) { /* 쌓인 게시를 비운다 */ } }
}
type Harness = Awaited<ReturnType<typeof harness>>;
const attachProposal = (content: string | null = 'claude summary=on', target: string | null = SESSION): Proposal => ({ action: 'attach', target, content });

// 실행 확인까지 마친 상태: "할게요"를 누르고 "키 보기" 버튼 글이 게시됐다.
async function confirmed(h: Harness) {
  h.reply(attachProposal());
  await h.say('100000000000000010', REQUEST);
  await h.turn();
  const [yes] = h.buttons().ids;
  await h.press(yes!);
  await h.publish();
  const shown = h.buttons();
  assert.deepEqual(shown.labels, ['키 보기']);
  return shown.ids[0]!;
}
// DB 전체(감사·outbox·events·proposals 포함)를 한 문자열로.
const dumpTables = async (db: Database) => {
  const tables = (await db.query<{ tablename: string }>("SELECT tablename FROM pg_tables WHERE schemaname='public'")).rows.map(row => row.tablename);
  return JSON.stringify(await Promise.all(tables.map(async table => [table, (await db.query(`SELECT * FROM ${table}`)).rows])));
};
const posted = (h: Harness) => JSON.stringify(h.f.rest.messages);

test('C15 세션 연결 제안은 세션 ID·실행기·요약 동의를 그대로 보여 되묻고, "할게요" 전에는 연결이 없다', async () => {
  const h = await harness(database.db);
  h.reply(attachProposal());
  await h.say('100000000000000010', REQUEST);
  await h.turn();
  const shown = h.buttons();
  assert.deepEqual(shown.labels, [PROPOSAL_TEXT.yes, PROPOSAL_TEXT.no]);
  assert.equal(shown.content, SESSION_KEY_TEXT.question(SESSION, 'claude', true));
  assert.deepEqual(await h.connections(), []);
});

test('C15 "할게요"로 확정하면 "키 보기" 버튼 글이 붙고, 키는 아직 만들지 않는다(상호작용 사이에 키를 보관하지 않음)', async () => {
  const h = await harness(database.db);
  const key = await confirmed(h);
  // "할게요" 응답은 확인 글을 결과 한 줄로 바꾸고 버튼을 없앤다.
  const update = h.callbacks.at(-1)!.body;
  assert.equal(update.type, 7);
  assert.deepEqual(update.data.components, []);
  assert.equal(update.data.content, SESSION_KEY_TEXT.confirmed('claude'));
  assert.equal(h.buttons().content, SESSION_KEY_TEXT.ready);
  // custom_id는 이름과 제안 ID만, Discord 상한 안.
  assert.ok(key.length <= CUSTOM_ID_MAX && key.split(':').length === 2, key);
  assert.equal(h.attaches(), 0);
  assert.deepEqual(await h.connections(), []);
});

test('C15 공개 검사에 걸리는 세션 ID는 확인 글에서 숨기고, "할게요" 뒤 바뀐 글과 버튼 글에도 다시 싣지 않는다', async () => {
  const h = await harness(database.db);
  const hidden = '10.20.30.40';
  h.reply(attachProposal('claude', hidden));
  await h.say('100000000000000010', REQUEST);
  await h.turn();
  const asked = h.buttons();
  assert.equal(asked.content, SESSION_KEY_TEXT.questionWithheld('claude', false));
  await h.press(asked.ids[0]!);
  await h.publish();
  const update = h.callbacks.at(-1)!.body;
  assert.equal(update.type, 7);
  assert.equal(update.data.content, 'claude 세션을 이 스레드에 연결하기로 했어요.');
  assert.deepEqual(h.buttons().labels, ['키 보기']);
  assert.ok(!JSON.stringify(h.callbacks).includes(hidden) && !posted(h).includes(hidden));
});

test('C36 F-4 공개 검사에 걸리는 세션 ID는 연결한 뒤 말로 한 세션 연결 목록(일반 답)에도 싣지 않고, 연결 줄은 남긴다', async () => {
  const h = await harness(database.db);
  const hidden = '10.20.30.40';
  h.reply(attachProposal('claude', hidden));
  await h.say('100000000000000010', REQUEST);
  await h.turn();
  await h.press(h.buttons().ids[0]!);
  await h.publish();
  await h.press(h.buttons().ids[0]!);
  const [connection] = await h.connections();
  assert.equal(connection!.external_task_id, hidden, '대조: 숨긴 ID로 연결이 생겼다');
  h.reply({ action: 'attach_list', target: null, content: null });
  await h.say('100000000000000011', '연결한 세션 보여 줘');
  await h.turn();
  const list = h.f.rest.messages.at(-1)!.body.content;
  assert.ok(list.includes(connection!.id), list);
  assert.ok(!posted(h).includes(hidden), list);
  const outbox = JSON.stringify((await database.db.query('SELECT payload FROM outbox')).rows);
  assert.ok(outbox.includes(connection!.id) && !outbox.includes(hidden), 'outbox에도 없다');
});

test('C15 "키 보기"를 누른 owner에게만 보이는 응답으로 키가 한 번 나오고, 공개 글·이벤트·outbox·감사·로그에는 키가 없다', async () => {
  const h = await harness(database.db);
  const key = await confirmed(h);
  await h.press(key);
  const response = h.callbacks.at(-1)!.body;
  // 새 메시지(CHANNEL_MESSAGE_WITH_SOURCE 4)이고 EPHEMERAL(64)이다. 버튼 글을 바꾸지(7) 않는다.
  assert.equal(response.type, 4);
  assert.equal(Number(response.data.flags) & 64, 64);
  assert.ok(String(response.data.content).includes(FAKE_SEED), '대조: 본인만 보는 응답에는 있다');
  const [connection] = await h.connections();
  assert.deepEqual({ executor: connection!.executor, task: connection!.external_task_id, consent: connection!.summary_consent, revoked: connection!.revoked_reason },
    { executor: 'claude', task: SESSION, consent: true, revoked: null });
  await h.publish();
  const dump = await dumpTables(database.db);
  assert.ok(dump.includes('external_task_attached'), '대조: 감사 행을 보고 있다');
  assert.equal(dump.includes(FAKE_SEED), false);
  assert.equal(posted(h).includes(FAKE_SEED), false);
  assert.equal(h.callbacks.filter(c => c.body.type !== 4).some(c => JSON.stringify(c).includes(FAKE_SEED)), false);
  assert.equal(h.logged.join('\n').includes(FAKE_SEED), false);
  assert.ok(h.logged.join('\n').includes('"outcome":"attached"'), '대조: 로그 수집기가 돈다');
});

test('C15 두 번째 "키 보기"는 거부되고 이미 보여 줬다고만 답한다(키를 다시 만들거나 보여 주지 않음)', async () => {
  const h = await harness(database.db);
  const key = await confirmed(h);
  await h.press(key);
  await h.press(key);
  const second = h.callbacks.at(-1)!.body;
  assert.equal(second.type, 4);
  assert.equal(Number(second.data.flags) & 64, 64);
  assert.equal(second.data.content, SESSION_KEY_TEXT.shown);
  assert.equal(h.attaches(), 1);
  assert.equal((await h.connections()).length, 1);
});

for (const [name, fail] of [
  ['전송 실패', (h: Harness) => h.failCallbacks(content => content.includes(FAKE_SEED))],
  // 연결을 만드는 사이 상호작용 마감(진입 + 2500ms)이 지난다.
  ['상호작용 만료', (h: Harness) => h.slowAttach(3000)],
] as [string, (h: Harness) => void][]) {
  test(`C15 키 응답에 실패(${name})하면 그 연결을 폐기하고 고정 안내만 남기며, 다시 눌러도 키를 다시 만들지 않는다`, async () => {
    const h = await harness(database.db);
    const key = await confirmed(h);
    fail(h);
    await h.press(key);
    const [connection] = await h.connections();
    assert.equal(connection!.revoked_reason, 'delivery_failed');
    h.failCallbacks(() => false);
    h.slowAttach(0);
    const dump = await dumpTables(database.db);
    assert.ok(dump.includes('ack_uncertain'), '대조: 실패 기록을 보고 있다');
    assert.equal(dump.includes(FAKE_SEED), false);
    assert.equal(h.logged.join('\n').includes(FAKE_SEED), false);
    assert.ok(h.logged.join('\n').includes('"outcome":"delivery_failed"'));
    await h.press(key);
    assert.equal(h.callbacks.at(-1)!.body.data.content, SESSION_KEY_TEXT.shown);
    assert.equal(h.attaches(), 1);
    await h.publish();
    assert.equal(posted(h).includes(FAKE_SEED), false);
  });
}

test('C15 일시 정지 중이면 키를 보내지 않고 그 연결을 폐기한다', async () => {
  const h = await harness(database.db);
  const key = await confirmed(h);
  await h.f.store.recordRateLimit(new RateLimited(60_000, false), thread.channel);
  const before = h.callbacks.length;
  await h.press(key);
  assert.equal(h.callbacks.slice(before).some(c => JSON.stringify(c).includes(FAKE_SEED)), false);
  const [connection] = await h.connections();
  assert.equal(connection!.revoked_reason, 'delivery_failed');
});

test('C15 키 응답 실패 뒤 폐기까지 실패하면 seed 없이 해제 방법을 안내하고 기존 감사를 남긴다', async () => {
  const h = await harness(database.db, { revoke: async () => { throw new Error('fixture_db_down'); } });
  const key = await confirmed(h);
  h.failCallbacks(content => content.includes(FAKE_SEED));
  await h.press(key);
  assert.equal(h.callbacks.at(-1)!.body.data.content, SESSION_KEY_TEXT.revokeUnconfirmed);
  assert.ok(h.logged.join('\n').includes('external_task_revoke_failed'));
  assert.equal(h.logged.join('\n').includes(FAKE_SEED), false);
  assert.equal((await dumpTables(database.db)).includes(FAKE_SEED), false);
});

test('C15 owner가 아닌 사람의 "키 보기"는 저장 전에 거부되고 키를 만들지 않는다', async () => {
  const h = await harness(database.db);
  const key = await confirmed(h);
  const before = h.callbacks.length;
  await assert.rejects(h.press(key, 'fixture-intruder'), Denied);
  assert.equal(h.callbacks.length, before);
  assert.equal(h.attaches(), 0);
  // owner는 그 뒤에도 볼 수 있다.
  await h.press(key);
  assert.ok(String(h.callbacks.at(-1)!.body.data.content).includes(FAKE_SEED));
});

test('C15 24시간이 지나면 "키 보기"로 키를 만들지 않는다', async () => {
  const h = await harness(database.db);
  const key = await confirmed(h);
  h.f.advance(PROPOSAL_TTL_MS);
  await h.press(key);
  assert.equal(h.callbacks.at(-1)!.body.data.content, SESSION_KEY_TEXT.expired);
  assert.equal(h.attaches(), 0);
});

test('C15 R08 스위치가 꺼져 있으면 세션 연결 제안을 버리고 버튼 글이 없다', async () => {
  const h = await harness(database.db, { external: false });
  h.reply(attachProposal());
  await h.say('100000000000000010', REQUEST);
  await h.turn();
  assert.deepEqual(h.buttons().ids, []);
  const [dropped] = (await database.db.query<{ detail: Record<string, unknown> }>("SELECT detail FROM audit WHERE kind='proposal_dropped'")).rows;
  assert.deepEqual(dropped!.detail, { action: 'attach', reason: 'target_denied' });
});

test('C15 실행기를 알 수 없거나 세션 ID 형식이 틀린 제안은 버린다', async () => {
  for (const proposal of [attachProposal(null), attachProposal('gemini'), attachProposal('claude', '../etc/passwd'), attachProposal('claude', null)]) {
    await database.pg.exec('TRUNCATE events,conversations,jobs,results,outbox,audit,proposals RESTART IDENTITY CASCADE');
    const h = await harness(database.db);
    h.reply(proposal);
    await h.say('100000000000000010', REQUEST);
    await h.turn();
    assert.deepEqual(h.buttons().ids, [], JSON.stringify(proposal));
  }
});

test('C15 동료 기능 스위치가 꺼져 있으면 "키 보기" 버튼을 받지 않고 /attach는 지금처럼 본인만 보는 응답으로 키를 준다', async () => {
  const h = await harness(database.db, { colleague: false });
  await seedConversation(database.db, h.f.store, h.f.now());
  await assert.rejects(h.press('session-key:00000000-0000-4000-8000-000000000000'), Denied);
  const acks: { content: string; flags?: number }[] = [];
  h.f.rest.acknowledge = async (_e, content, options) => { acks.push({ content, flags: options.flags }); };
  const slash = new DiscordIngress(h.f.store, h.f.gate, h.f.rest, true, ALL_COMMANDS, () => {}, undefined, undefined,
    new ExternalTaskCommands(new ExternalTaskLinks(h.f.store), ENVIRONMENT, () => {}));
  await slash.receive(event('slash-attach', { kind: 'command', command: 'attach', target: SESSION, text: 'claude' }));
  assert.match(acks.at(-1)!.content, /^seed: `[^`]+`$/m);
  assert.notEqual(acks.at(-1)!.content, EXTERNAL_ACK_NOTICE);
});
