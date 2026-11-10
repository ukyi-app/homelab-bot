import { after, before, beforeEach, test } from 'node:test';
import assert from 'node:assert/strict';
import { PUBLISH_TEXT } from '../src/change-commands.js';
import { Denied } from '../src/contracts.js';
import { DiscordProtocol } from '../src/discord-protocol.js';
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
// 게시된 미리보기 중 버튼이 달린 글(마지막 쪽)과 미리보기 본문에 적힌 승인 digest.
// 앞 세대 버튼 글이 섞이면 그 세대 digest를 잘못 집으므로 버튼 글도 custom_id의 세대 칸으로 거른다.
const previewButton = (h: Harness, generation = 1) => {
  const posted = h.rest.messages.filter(message => message.body.content.includes(`g${generation} 게시 미리보기`)
    || message.body.components?.[0]?.components[0]?.custom_id.includes(`.${generation}.`));
  const withButton = posted.filter(message => message.body.components?.length);
  const digest = /text:([0-9a-f]{64})/.exec(posted.map(message => message.body.content).join(''))?.[1];
  return { withButton, digest, customId: withButton.at(-1)?.body.components?.[0]?.components[0]?.custom_id };
};
const approvals = async (h: Harness, id: string) => (await h.db.query<{ generation: number; approval_digest: string; event_id: string; approved_by: string }>(
  'SELECT generation,approval_digest,event_id,approved_by FROM change_approvals WHERE change_id=$1 ORDER BY approved_at', [id])).rows;
const lastAck = (h: Harness) => ({ content: h.acknowledgements().at(-1), options: h.rest.acks.at(-1)?.options as { update?: true } | undefined });

test('C17 AC-10: 스위치가 켜져 있으면 미리보기 버튼 하나로 그 미리보기 digest가 승인되고, 기존 게시 경로로 PR이 된다', async () => {
  await withHarness({ colleague: true }, async h => {
    const id = await toAwaiting(h);
    await h.deliver();
    const { withButton, digest, customId } = previewButton(h);
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
    assert.ok(ack.content!.includes('digest는 위 내용 전체에 묶여 있습니다.'));
    await h.pump(async () => await h.phase(id) === 'proposed');
    assert.equal(h.env.github.pulls.length, 1);
  });
});

test('C17: 버튼 승인도 게시 직전 재확인을 거친다. 새 미리보기가 나온 뒤 옛 버튼은 거부되고 상태가 바뀌지 않는다', async () => {
  await withHarness({ colleague: true }, async h => {
    const id = await toAwaiting(h);
    await h.deliver();
    const old = previewButton(h).customId!;
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

    const current = previewButton(h, 2);
    assert.equal(current.customId, `change-publish-ok:${id}.2.${current.digest!.slice(0, 16)}`);
    await press(h, 'fixture-press-3', current.customId!);
    assert.equal(await h.phase(id), 'approved');
  });
});

test('C17: owner가 아닌 사람은 승인하지 못하고, 같은 버튼을 두 번 눌러도 승인은 한 번이다', async () => {
  await withHarness({ colleague: true }, async h => {
    const id = await toAwaiting(h);
    await h.deliver();
    const { customId, digest } = previewButton(h);
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
    const { customId, digest } = previewButton(h);
    await h.command('101', 'stop');
    await press(h, 'fixture-press-1', customId!);
    assert.equal(lastAck(h).content, PUBLISH_TEXT.stopped);
    assert.equal(await h.phase(id), 'awaiting_publish_approval');

    await h.command('102', 'change-publish', { target: id, text: digest! });
    assert.equal(await h.phase(id), 'approved');
    assert.deepEqual((await approvals(h, id)).map(row => row.event_id), ['102']);
  });
});

test('C17: 스위치가 꺼져 있으면 미리보기에 버튼이 없고, 게시 버튼 상호작용을 받지 않는다', async () => {
  await withHarness({}, async h => {
    const id = await toAwaiting(h);
    await h.deliver();
    const { withButton, digest } = previewButton(h);
    assert.equal(withButton.length, 0);
    await assert.rejects(press(h, 'fixture-press-1', `change-publish-ok:${id}.1.${digest!.slice(0, 16)}`), Denied);
    assert.equal(await h.phase(id), 'awaiting_publish_approval');
    assert.deepEqual(await approvals(h, id), []);
  });
});
