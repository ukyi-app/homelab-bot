import { after, before, beforeEach, test } from 'node:test';
import assert from 'node:assert/strict';
import { PUBLISH_TEXT, publishButton } from '../src/change-commands.js';
import { changeDirectId } from '../src/change-question.js';
import { CHANGE_NOTICE_TEXT, previewWithoutButton } from '../src/change-runtime.js';
import { CHAT_TASK_TEXT } from '../src/chat-task-text.js';
import { Denied, RateLimited } from '../src/contracts.js';
import { DiscordPublisher } from '../src/discord.js';
import { CUSTOM_ID_MAX, DiscordProtocol } from '../src/discord-protocol.js';
import { BUTTON_PAGE_SIZE, messagePages } from '../src/format.js';
import { Store } from '../src/store.js';
import { REPO } from './change-github-fake.js';
import { REQUEST_TEXT, THREAD, WRITE_STEP, changeHarness } from './change-assembly-harness.js';
import type { Harness } from './change-assembly-harness.js';
import { OWNER } from './change-store-fixture.js';
import { localDatabase } from './helpers.js';

// C17 게시 승인 버튼(COLLEAGUE_SPEC §4.3 "게시 승인", AC-10). S1 경계: 상호작용 프레임 → DiscordProtocol → 수신 → 변경 승인 경로(PGlite)
// → 게시(가짜 Discord REST·가짜 GitHub). 실제 Discord·GitHub·모델에 닿지 않는다. 값은 모두 합성이다.
let database: Awaited<ReturnType<typeof localDatabase>>;
before(async () => { database = await localDatabase(); });
after(async () => { await database.pg.close(); });
beforeEach(async () => {
  const tables = (await database.pg.query<{ tablename: string }>("SELECT tablename FROM pg_tables WHERE schemaname='public' AND tablename<>'schema_migrations'")).rows.map(row => row.tablename);
  await database.pg.exec(`TRUNCATE ${tables.join(',')} RESTART IDENTITY CASCADE`);
  await database.pg.exec(`INSERT INTO execution_lanes(lane) VALUES ('interactive'), ('task') ON CONFLICT DO NOTHING`);
});
async function withHarness(options: Parameters<typeof changeHarness>[1], run: (h: Harness) => Promise<void>) {
  const h = await changeHarness(database.db, options);
  try { await run(h); } finally { await h.close(); }
}
const toAwaiting = async (h: Harness) => {
  await h.command('100', 'change', { target: REPO.fullName, text: REQUEST_TEXT });
  const change = await h.changeId();
  await h.pump(async () => await h.phase(change) === 'awaiting_publish_approval');
  return change;
};
// 버튼 상호작용은 Gateway INTERACTION_CREATE(type 3) 프레임으로 넣어 custom_id 허용 목록·칸 나눔까지 거친다.
const BOT = '900000000000000001';
const protocol = new DiscordProtocol({ request: async (method, path) => {
  if (method === 'GET' && path === `/channels/${THREAD.channel}`) return { id: THREAD.channel, type: 11, parent_id: THREAD.parent, guild_id: THREAD.guild };
  throw new Error(`unexpected_route ${method} ${path}`);
} }, BOT);
const press = (h: Harness, id: string, customId: string, actor = OWNER) => protocol.gateway('INTERACTION_CREATE', { id, token: 'fixture-interaction-token', type: 3,
  channel_id: THREAD.channel, guild_id: THREAD.guild, member: { user: { id: actor } }, data: { custom_id: customId } }, h.ingress);
// 게시된 미리보기 중 버튼이 달린 글(마지막 쪽)과 그 세대의 승인 digest.
// 앞 세대 버튼 글이 섞이면 그 세대 digest를 잘못 집으므로 버튼 글도 custom_id의 세대 칸으로 거른다.
// 켜짐 판 미리보기 본문에는 '/' 승인 명령(digest)이 없어(C18) 저장된 승인 대상에서 읽는다.
const previewButton = async (h: Harness, generation = 1) => {
  const posted = h.rest.messages.filter(message => message.body.content.includes(`g${generation} 게시 미리보기`)
    || message.body.components?.[0]?.components[0]?.custom_id.includes(`.${generation}.`));
  const withButton = posted.filter(message => message.body.components?.length);
  const subject = await h.changes.approvalSubject({ changeId: await h.changeId(), generation });
  const digest = subject.ok ? subject.value.digest : undefined;
  return { withButton, digest, customId: withButton.at(-1)?.body.components?.[0]?.components[0]?.custom_id };
};
const approvals = async (h: Harness, id: string) => (await h.db.query<{ generation: number; approval_digest: string; event_id: string; approved_by: string }>(
  'SELECT generation,approval_digest,event_id,approved_by FROM change_approvals WHERE change_id=$1 ORDER BY approved_at', [id])).rows;
const lastAck = (h: Harness) => ({ content: h.acknowledgements().at(-1), options: h.rest.acks.at(-1)?.options as { update?: true } | undefined });

test('C17 AC-10: 스위치가 켜져 있으면 미리보기 버튼 하나로 그 미리보기 digest가 승인되고, 기존 게시 경로로 PR이 된다', async () => {
  await withHarness({ colleague: true }, async h => {
    const id = await toAwaiting(h);
    await h.deliver();
    const { withButton, digest, customId } = await previewButton(h);
    assert.equal(withButton.length, 1, '버튼 글은 하나다');
    assert.equal(withButton[0]!.body.components![0]!.components.length, 1);
    assert.equal(withButton[0]!.body.components![0]!.components[0]!.label, PUBLISH_TEXT.label);
    assert.ok(digest);
    assert.equal(customId, `change-publish-ok:${id}.1.${digest.slice(0, 16)}`);
    assert.ok(customId.length <= 100);
    assert.equal(h.env.github.mutations().length, 0, '누르기 전에는 GitHub 쓰기가 없다');

    await press(h, 'fixture-press-1', customId);
    assert.equal(await h.phase(id), 'approved');
    assert.deepEqual(await approvals(h, id), [{ generation: 1, approval_digest: digest, event_id: 'fixture-press-1', approved_by: OWNER }]);
    // 처리한 뒤에는 그 글을 갱신해 버튼을 없앤다. 미리보기 마지막 쪽 본문은 남기고 결과 한 줄을 붙인다.
    const ack = lastAck(h);
    assert.equal(ack.options?.update, true);
    assert.ok(ack.content!.endsWith(PUBLISH_TEXT.approved(id)));
    assert.ok(ack.content!.includes(CHANGE_NOTICE_TEXT.previewBinding(true)));
    assert.ok(!ack.content!.includes('/change-publish'), "켜짐 판 미리보기에는 '/' 승인 명령이 없다");
    await h.pump(async () => await h.phase(id) === 'proposed');
    assert.equal(h.env.github.pulls.length, 1);
  });
});

test('C17: 버튼 승인도 게시 직전 재확인을 거친다. 새 미리보기가 나온 뒤 옛 버튼은 거부되고 상태가 바뀌지 않는다', async () => {
  await withHarness({ colleague: true }, async h => {
    const id = await toAwaiting(h);
    await h.deliver();
    const old = (await previewButton(h)).customId!;
    h.env.github.moveBase();
    await press(h, 'fixture-press-1', old);
    await h.pump(async () => await h.phase(id) === 'superseded');
    assert.equal(h.env.github.mutations().length, 0, 'base가 움직이면 게시하지 않는다');
    await h.f.script([WRITE_STEP]);
    await h.command('101', 'change', { target: id, text: 'next' });
    await h.pump(async () => await h.phase(id) === 'awaiting_publish_approval');
    await h.deliver();

    await press(h, 'fixture-press-2', old);
    assert.equal(await h.phase(id), 'awaiting_publish_approval');
    assert.deepEqual((await approvals(h, id)).filter(row => row.generation === 2), []);
    assert.equal(lastAck(h).content, PUBLISH_TEXT.stale);
    assert.notEqual(lastAck(h).options?.update, true, '거부는 누른 owner에게만 보이는 응답이다');

    const current = await previewButton(h, 2);
    assert.equal(current.customId, `change-publish-ok:${id}.2.${current.digest!.slice(0, 16)}`);
    await press(h, 'fixture-press-3', current.customId!);
    assert.equal(await h.phase(id), 'approved');
  });
});

test('C17: owner가 아닌 사람은 승인하지 못하고, 같은 버튼을 두 번 눌러도 승인은 한 번이다', async () => {
  await withHarness({ colleague: true }, async h => {
    const id = await toAwaiting(h);
    await h.deliver();
    const { customId, digest } = await previewButton(h);
    await assert.rejects(press(h, 'fixture-press-1', customId!, 'fixture-intruder'), Denied);
    assert.equal(await h.phase(id), 'awaiting_publish_approval');
    assert.deepEqual(await approvals(h, id), []);

    await press(h, 'fixture-press-2', customId!);
    const acks = h.rest.acks.length;
    await press(h, 'fixture-press-2', customId!);
    assert.equal(h.rest.acks.length, acks, '같은 상호작용은 한 번만 처리한다');
    await press(h, 'fixture-press-3', customId!);
    assert.equal(lastAck(h).content, PUBLISH_TEXT.settled);
    assert.deepEqual((await approvals(h, id)).map(row => [row.event_id, row.approval_digest]), [['fixture-press-2', digest]]);
  });
});

test('C17: 구독이 꺼진 대화에서는 버튼으로 승인하지 않는다. 스위치가 켜져도 digest 입력 /change-publish 승인은 그대로 된다', async () => {
  await withHarness({ colleague: true }, async h => {
    const id = await toAwaiting(h);
    await h.deliver();
    const { customId, digest } = await previewButton(h);
    await h.command('101', 'stop');
    await press(h, 'fixture-press-1', customId!);
    assert.equal(lastAck(h).content, PUBLISH_TEXT.stopped);
    assert.equal(await h.phase(id), 'awaiting_publish_approval');

    await h.command('102', 'change-publish', { target: id, text: digest! });
    assert.equal(await h.phase(id), 'approved');
    assert.deepEqual((await approvals(h, id)).map(row => row.event_id), ['102']);
  });
});

test("C36 F-11 켜짐에서 저장한 미리보기가 스위치를 끄고 다시 띄운 게시 서버에서 나가면 버튼 없이 '/' 승인 안내로 바뀐다", async () => {
  await withHarness({ colleague: true }, async h => {
    const id = await toAwaiting(h);
    assert.equal((await h.db.query("SELECT 1 FROM outbox WHERE payload ? 'buttons' AND state='pending'")).rows.length, 1, '대조: 버튼 미리보기가 저장됐다');
    const off = new DiscordPublisher(new Store(h.db, h.store.now, false), h.gate, h.rest);
    for (let index = 0; index < 20 && await off.deliver(); index++) { /* 쌓인 게시를 비운다 */ }
    const previews = h.rest.messages.filter(message => message.body.content.includes('게시하려면') || message.body.content.includes('/change-publish'));
    assert.equal(previews.length, 1, JSON.stringify(h.rest.messages.map(m => m.body.content)));
    const shown = previews[0]!.body;
    assert.equal(shown.components?.length ?? 0, 0);
    assert.ok(shown.content.includes(`/change-status target:${id}`), shown.content);
    assert.ok(shown.content.includes(`/change-publish target:${id}`), shown.content);
    assert.ok(shown.content.includes(CHANGE_NOTICE_TEXT.previewBinding(false)), shown.content);
    assert.ok(!shown.content.includes(PUBLISH_TEXT.label), shown.content);
  });
});

// 꺼짐 판 치환은 버튼 안내를 '/' 안내로 바꿔 글을 늘린다. 켜짐 때 저장한 미리보기의 마지막 쪽이 쪽 상한(1800자) 근처여도
// 게시자의 본문 상한(1900자)에 걸려 막히지 않아야 owner가 미리보기 끝과 승인 방법을 받는다.
const SENT_LIMIT = 1900;
// 대조 표식과 첫 쪽의 owner 호출을 뗀 본문.
const unmarked = (content: string) => content.replace(/\n-# ref:[0-9a-f]{24}$/, '').replace(/^<@[^>]+> /, '');
// 앞 쪽은 1800자에 꽉 차고, 고치기 전 규칙(쪽 상한 하나)이면 마지막 쪽이 lastPage자인 켜짐 판 미리보기 글.
const longPreview = (id: string, lastPage: number) => {
  const on = `${CHANGE_NOTICE_TEXT.previewApprove(true, id, '')}\n${CHANGE_NOTICE_TEXT.previewBinding(true)}`;
  let body = '';
  for (let line = 0; body.length < 1800 + lastPage; line++) body += `- ${line % 10}${'가'.repeat(96)}\n`;
  return `${body.slice(0, 1800 + lastPage - on.length - 1).trimEnd().padEnd(1800 + lastPage - on.length - 1, '나')}\n${on}`;
};
for (const lastPage of [1800, 1790]) {
  test(`C36 F-11 켜짐 판 미리보기의 마지막 쪽이 ${lastPage}자여도 꺼진 게시자가 본문 전체와 '/' 승인 안내를 막힘 없이 한 번씩 보낸다(재시도·재시작 포함)`, async () => {
    await withHarness({ colleague: true }, async h => {
      const id = await toAwaiting(h);
      const stored = (await h.db.query<{ id: string; owner_id: string; scope: never; policy_revision: string; conversation_id: string | null; payload: Record<string, unknown> }>(
        "SELECT id,owner_id,scope,policy_revision,conversation_id,payload FROM outbox WHERE payload ? 'buttons'")).rows[0]!;
      await h.db.query('DELETE FROM outbox WHERE id=$1', [stored.id]);
      let shift = 0;
      const offStore = () => new Store(h.db, () => Date.now() + shift, false);
      let off = new DiscordPublisher(offStore(), h.gate, h.rest);
      for (let index = 0; index < 20 && await off.deliver(); index++) { /* 앞서 쌓인 다른 글을 비운다 */ }
      const before = h.rest.messages.length;

      const content = longPreview(id, lastPage);
      const old = messagePages(content);
      assert.deepEqual(old.map(page => page.length), [1800, lastPage], '대조: 쪽 상한 하나로 나누면 마지막 쪽이 상한 근처다');
      assert.ok(previewWithoutButton(old[1]!, id).length > SENT_LIMIT, '대조: 그 마지막 쪽을 꺼짐 판으로 바꾸면 본문 상한을 넘는다');
      await h.store.enqueue({ key: `c36b-long-preview-${lastPage}`, actor: stored.owner_id, scope: stored.scope, revision: stored.policy_revision,
        ...(stored.conversation_id ? { conversation: stored.conversation_id } : {}), payload: { ...stored.payload, content } as never });

      assert.equal(await off.deliver(), true);
      h.rest.rateLimit = new RateLimited(1000, false);
      assert.equal(await off.deliver(), true, '둘째 쪽은 429로 미뤄진다');
      shift += 5000;
      off = new DiscordPublisher(offStore(), h.gate, h.rest);
      for (let index = 0; index < 20 && await off.deliver(); index++) { /* 다시 띄운 게시자가 이어 보낸다 */ }
      off = new DiscordPublisher(offStore(), h.gate, h.rest);
      for (let index = 0; index < 5 && await off.deliver(); index++) { /* 한 번 더 다시 띄워도 보낼 것이 없다 */ }

      const rows = (await h.db.query<{ state: string; page_index: number }>('SELECT state,page_index FROM outbox WHERE message_key=$1 ORDER BY page_index',
        [`c36b-long-preview-${lastPage}`])).rows;
      assert.ok(rows.length > 2 && rows.every(row => row.state === 'sent'), JSON.stringify(rows));
      const sent = h.rest.messages.slice(before);
      assert.equal(sent.length, rows.length, '쪽마다 한 번씩만 나간다');
      assert.ok(sent.every(message => !message.body.components?.length && unmarked(message.body.content).length <= SENT_LIMIT));
      assert.equal(sent.map(message => unmarked(message.body.content)).join(''), previewWithoutButton(content, id), '본문 전체와 꺼짐 판 안내');
      assert.ok(sent.at(-1)!.body.content.includes(`/change-status target:${id}`));
      assert.equal((await h.db.query("SELECT 1 FROM audit WHERE kind='delivery_blocked_colleague_off'")).rows.length, 0);
    });
  });
}

test("C36 묶음 F 미리보기의 버튼 안내 첫 줄의 줄바꿈이 마지막 쪽 상한에 정확히 놓여도, 꺼진 게시자가 보낸 어느 쪽에도 버튼 안내가 없고 '/' 승인 안내는 한 번이다", async () => {
  await withHarness({ colleague: true }, async h => {
    const id = await toAwaiting(h);
    const stored = (await h.db.query<{ id: string; owner_id: string; scope: never; policy_revision: string; conversation_id: string | null; payload: Record<string, unknown> }>(
      "SELECT id,owner_id,scope,policy_revision,conversation_id,payload FROM outbox WHERE payload ? 'buttons'")).rows[0]!;
    await h.db.query('DELETE FROM outbox WHERE id=$1', [stored.id]);
    const off = new DiscordPublisher(new Store(h.db, h.store.now, false), h.gate, h.rest);
    for (let index = 0; index < 20 && await off.deliver(); index++) { /* 앞서 쌓인 다른 글을 비운다 */ }
    const before = h.rest.messages.length;

    const approve = CHANGE_NOTICE_TEXT.previewApprove(true, id, '');
    const head = `${'- 변경 파일 줄\n'.repeat(80)}`.slice(0, BUTTON_PAGE_SIZE - approve.length - 3).padEnd(BUTTON_PAGE_SIZE - approve.length - 3, '나');
    const content = `${head}\n\n${approve}\n${CHANGE_NOTICE_TEXT.previewBinding(true)}`;
    assert.ok(content.length <= 1800);
    assert.equal(content.indexOf('\n', content.indexOf(approve)) + 1, BUTTON_PAGE_SIZE, '대조: 첫 안내 줄의 줄바꿈이 마지막 쪽 상한에 놓인다');
    await h.store.enqueue({ key: 'c36f-split-notice', actor: stored.owner_id, scope: stored.scope, revision: stored.policy_revision,
      ...(stored.conversation_id ? { conversation: stored.conversation_id } : {}), payload: { ...stored.payload, content } as never });
    for (let index = 0; index < 20 && await off.deliver(); index++) { /* 쌓인 게시를 비운다 */ }

    const sent = h.rest.messages.slice(before).map(message => ({ content: unmarked(message.body.content), buttons: message.body.components?.length ?? 0 }));
    assert.ok(sent.length >= 1 && sent.every(page => page.buttons === 0), JSON.stringify(sent));
    for (const page of sent) {
      assert.ok(!page.content.includes(approve), page.content);
      assert.ok(!page.content.includes(CHANGE_NOTICE_TEXT.previewBinding(true)), page.content);
    }
    assert.equal(sent.filter(page => page.content.includes(`/change-status target:${id}`)).length, 1);
    assert.equal(sent.map(page => page.content).join(''), previewWithoutButton(content, id));
    assert.equal((await h.db.query("SELECT 1 FROM audit WHERE kind='delivery_blocked_colleague_off'")).rows.length, 0);
  });
});

test('C36 F-11 버튼 글의 마지막 쪽 상한은 가장 긴 ID의 꺼짐 판 안내를 붙여도 본문 상한 안이다', () => {
  // custom_id(100자 상한)에 들어가는 가장 긴 변경 ID·질문 ID. 안내를 못 찾아 통째로 덧붙일 때가 가장 길다.
  const changeId = 'c'.repeat(CUSTOM_ID_MAX - publishButton('', 1, 'd'.repeat(64)).id.length);
  assert.equal(publishButton(changeId, 1, 'd'.repeat(64)).id.length, CUSTOM_ID_MAX);
  const question = 'q'.repeat(CUSTOM_ID_MAX - changeDirectId('').length);
  const page = 'x'.repeat(BUTTON_PAGE_SIZE);
  assert.ok(previewWithoutButton(page, changeId).length <= SENT_LIMIT);
  assert.ok(`${page}\n${CHAT_TASK_TEXT.changeQuestionFooter(false, question, '질문 기한')}`.length <= SENT_LIMIT);
  assert.deepEqual(messagePages(`${'y'.repeat(1700)}\n${'z'.repeat(1700)}`, BUTTON_PAGE_SIZE).map(page => page.length), [1701, 1500, 200]);
});

test('C17: 스위치가 꺼져 있으면 미리보기에 버튼이 없고, 게시 버튼 상호작용을 받지 않는다', async () => {
  await withHarness({}, async h => {
    const id = await toAwaiting(h);
    await h.deliver();
    const { withButton, digest } = await previewButton(h);
    assert.equal(withButton.length, 0);
    await assert.rejects(press(h, 'fixture-press-1', `change-publish-ok:${id}.1.${digest!.slice(0, 16)}`), Denied);
    assert.equal(await h.phase(id), 'awaiting_publish_approval');
    assert.deepEqual(await approvals(h, id), []);
  });
});
