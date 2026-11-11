import { after, before, beforeEach, test } from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULTS, Denied } from '../src/contracts.js';
import type { Database } from '../src/database.js';
import { DiscordPublisher } from '../src/discord.js';
import { Store } from '../src/store.js';
import { PROPOSAL_BUTTONS, PROPOSAL_TEXT, PROPOSAL_TTL_MS } from '../src/proposals.js';
import { localDatabase, thread } from './helpers.js';
import { BOT, harness, PROJECT } from './c13-proposal-fixture.js';
import type { Harness } from './c13-proposal-fixture.js';

let database: Awaited<ReturnType<typeof localDatabase>>;
before(async () => { database = await localDatabase(); });
beforeEach(async () => {
  await database.pg.exec(`TRUNCATE events,conversations,jobs,results,outbox,controls,audit,denied_actors,codex_sessions,codex_questions,proposals
    RESTART IDENTITY CASCADE`);
  await database.pg.exec(`UPDATE execution_lanes SET closed_reason=NULL,closed_at=NULL`);
});
after(async () => { await database.pg.close(); });

const REQUEST = '실패하는 시험을 고쳐 줘';
const taskProposal = (target = PROJECT) => ({ action: 'task' as const, target, content: '모델이 다시 쓴 작업 내용' });
async function proposed(h: Harness, target = PROJECT) {
  h.reply(taskProposal(target));
  await h.say('100000000000000010', REQUEST);
  await h.turn();
}

test('C13 작업 시작 제안은 저장소와 owner 원문을 한 줄로 되묻는 버튼 글이 되고, 버튼 전에는 작업이 하나도 시작되지 않는다', async () => {
  const h = await harness(database.db);
  await proposed(h);
  const shown = h.buttons();
  assert.equal(shown.posted.length, 1);
  // 버튼 이름은 명세 §4.3 그대로다.
  assert.deepEqual(shown.labels, ['할게요', '아니에요']);
  assert.ok(shown.content.includes(PROJECT));
  assert.ok(shown.content.includes(REQUEST), shown.content);
  // 모델이 다시 쓴 글이 아니라 owner 원문(멘션 표기 제거)이다.
  assert.ok(!shown.content.includes('모델이 다시 쓴'), shown.content);
  assert.ok(!shown.content.includes('<@'), shown.content);
  // custom_id에는 이름과 제안 ID만 싣는다(Discord 상한 100자).
  for (const id of shown.ids) assert.ok(id.length <= 100 && id.split(':').length === 2, id);
  // 대화 답도 그대로 나간다.
  assert.ok(h.f.rest.messages.some(m => m.body.content.startsWith('그 저장소에서 시험을 고쳐 볼게요.')));
  await h.local.runtime.tickTask();
  assert.deepEqual(await h.taskJobs(), []);
  assert.equal(h.local.worker.executes.length, 0);
});

test('C13 "할게요"를 누르면 /task와 같은 경로로 owner 원문 작업이 한 번 접수되고, 그 글의 버튼이 사라지며, 다시 눌러도 두 번 시작되지 않는다', async () => {
  const h = await harness(database.db);
  await proposed(h);
  const [yes] = h.buttons().ids;
  await h.press(yes!);
  const jobs = await h.taskJobs();
  assert.equal(jobs.length, 1);
  // 응답은 그 글을 바꾸고 버튼을 모두 없앤다(UPDATE_MESSAGE).
  assert.equal(h.callbacks.at(-1)!.body.type, 7);
  assert.deepEqual(h.callbacks.at(-1)!.body.data.components, []);
  assert.equal(h.callbacks.at(-1)!.body.data.content, PROPOSAL_TEXT.taskStarted(PROJECT, jobs[0]!.id));
  // 작업 레인은 owner 원문(멘션 표기 제거)과 고른 저장소로 실행한다.
  await h.local.runtime.tickTask();
  assert.equal(h.local.worker.executes.length, 1);
  const request = JSON.stringify(h.local.worker.executes[0]);
  assert.ok(request.includes(REQUEST), request);
  assert.ok(!request.includes('모델이 다시 쓴'), request);
  // 같은 버튼을 다시 누르면 거부되고 버튼만 사라진다.
  await h.press(yes!);
  assert.equal((await h.taskJobs()).length, 1);
  assert.equal(h.callbacks.at(-1)!.body.type, 7);
  assert.equal(h.callbacks.at(-1)!.body.data.content, PROPOSAL_TEXT.settled);
});

test('C13 owner가 아닌 사람이 누르면 저장 전에 거부되고 제안은 그대로 남아 owner가 누를 수 있다', async () => {
  const h = await harness(database.db);
  await proposed(h);
  const [yes] = h.buttons().ids;
  await assert.rejects(h.press(yes!, 'fixture-intruder'), Denied);
  assert.deepEqual(await h.taskJobs(), []);
  assert.equal(h.callbacks.length, 0);
  await h.press(yes!);
  assert.equal((await h.taskJobs()).length, 1);
});

test('C13 24시간이 지난 제안의 버튼은 거부되고 그 글의 버튼이 사라진다', async () => {
  const h = await harness(database.db);
  await proposed(h);
  const [yes] = h.buttons().ids;
  h.f.advance(PROPOSAL_TTL_MS);
  h.f.policy.confirmedAt = h.f.now();
  await h.press(yes!);
  assert.deepEqual(await h.taskJobs(), []);
  assert.equal(h.callbacks.at(-1)!.body.type, 7);
  assert.deepEqual(h.callbacks.at(-1)!.body.data.components, []);
  assert.equal(h.callbacks.at(-1)!.body.data.content, PROPOSAL_TEXT.expired);
});

test('C13 제안 뒤 값이 바뀌면(원문이 비워짐) 버튼은 거부되고 버튼이 사라진다', async () => {
  const h = await harness(database.db);
  await proposed(h);
  const [yes] = h.buttons().ids;
  // 저장된 원문 이벤트가 바뀐 경우. digest가 제안 때와 달라진다.
  await database.db.query(`UPDATE events SET payload=jsonb_set(payload,'{text}','"다른 요청"') WHERE delivery_id='100000000000000010'`);
  await h.press(yes!);
  assert.deepEqual(await h.taskJobs(), []);
  assert.equal(h.callbacks.at(-1)!.body.type, 7);
  assert.equal(h.callbacks.at(-1)!.body.data.content, PROPOSAL_TEXT.changed);
  // 끝난 제안에는 값·원문 참조가 남지 않는다.
  const row = (await database.db.query<{ state: string; value: string | null; source_event: string | null }>('SELECT state,value,source_event FROM proposals')).rows[0]!;
  assert.deepEqual([row.state, row.value, row.source_event], ['refused', null, null]);
});

test('C13 "아니에요"를 누르면 아무것도 시작하지 않고 버튼이 사라지며, 그 뒤 "할게요"도 거부된다', async () => {
  const h = await harness(database.db);
  await proposed(h);
  const [yes, no] = h.buttons().ids;
  await h.press(no!);
  assert.equal(h.callbacks.at(-1)!.body.data.content, PROPOSAL_TEXT.declined);
  assert.deepEqual(h.callbacks.at(-1)!.body.data.components, []);
  await h.press(yes!);
  assert.equal(h.callbacks.at(-1)!.body.data.content, PROPOSAL_TEXT.settled);
  assert.deepEqual(await h.taskJobs(), []);
});

test('C13 스위치가 꺼져 있으면 제안이 있어도 버튼 글이 없고 제안을 저장하지 않으며, 확인 버튼도 받지 않는다', async () => {
  const h = await harness(database.db, { colleague: false });
  await proposed(h);
  assert.equal(h.buttons().posted.length, 0);
  assert.equal(h.f.rest.messages.length, 1);
  assert.equal((await database.db.query('SELECT id FROM proposals')).rows.length, 0);
  await assert.rejects(h.press(`${PROPOSAL_BUTTONS.yes}:00000000-0000-4000-8000-000000000000`), Denied);
  assert.deepEqual(await h.taskJobs(), []);
});

test('C36 F-11 켜짐에서 저장한 실행 확인 글이 스위치를 끄고 다시 띄운 게시 서버에서 나가면, 버튼 글은 게시하지 않고 대화 답만 나간다', async () => {
  const h = await harness(database.db);
  h.reply(taskProposal());
  await h.say('100000000000000010', REQUEST);
  h.f.advance(DEFAULTS.debounceMs + 50);
  await h.local.runtime.tick();
  assert.equal((await database.db.query("SELECT 1 FROM outbox WHERE payload ? 'buttons' AND state='pending'")).rows.length, 1, '대조: 버튼 글이 저장됐다');
  const off = new DiscordPublisher(new Store(database.db, h.f.now, false), h.f.gate, h.f.rest);
  while (await off.deliver()) { /* 쌓인 게시를 비운다 */ }
  assert.equal(h.buttons().posted.length, 0);
  assert.ok(h.f.rest.messages.some(m => m.body.content.startsWith('그 저장소에서 시험을 고쳐 볼게요.')), '대화 답은 나간다');
  assert.ok(!h.f.rest.messages.some(m => m.body.content.includes(REQUEST)), '확인 글(원문 미리보기)도 나가지 않는다');
  assert.deepEqual((await database.db.query<{ state: string }>("SELECT state FROM outbox WHERE payload ? 'buttons'")).rows.map(r => r.state), ['blocked']);
  assert.deepEqual(await h.taskJobs(), []);
});

test('C13 허용 밖 저장소, 연결 안 된 동작, 관리 기능 이름의 제안은 버려지고 대화 답만 나간다', async () => {
  for (const proposal of [taskProposal('not-in-policy'), { action: 'memory_save' as const, target: null, content: '기억해 둬' },
    { action: 'retry' as const, target: 'fixture-job', content: null }]) {
    await database.pg.exec('TRUNCATE events,conversations,jobs,results,outbox,controls,audit,proposals RESTART IDENTITY CASCADE');
    const h = await harness(database.db);
    h.reply(proposal);
    await h.say('100000000000000010', REQUEST);
    await h.turn();
    assert.equal(h.buttons().posted.length, 0, proposal.action);
    assert.equal(h.f.rest.messages.length, 1, proposal.action);
    assert.equal((await database.db.query('SELECT id FROM proposals')).rows.length, 0);
  }
  assert.deepEqual(await (await harness(database.db)).taskJobs(), []);
});

test('C13 작업 목록 제안은 확인 없이 /list와 같은 처리로 실행돼 일반 답으로 달린다', async () => {
  const h = await harness(database.db);
  // 비교 기준: 같은 대화에서 '/list'를 직접 누른 결과.
  h.reply(null, '먼저 말을 걸어요.');
  await h.say('100000000000000005', '안녕');
  await h.turn();
  await h.ingress.receive({ id: 'fixture-list-command', actor: h.f.policy.owner, scope: thread, kind: 'command', command: 'list', text: '' });
  while (await h.f.publisher.deliver()) { /* '/list' 결과 게시 */ }
  const slash = h.f.rest.messages.at(-1)!.body.content.split('\n-# ref:')[0]!;
  h.reply({ action: 'list', target: null, content: null }, '작업 목록이에요.');
  await h.say('100000000000000020', '작업 목록 보여 줘');
  await h.turn();
  assert.equal(h.buttons().posted.length, 0);
  const posted = h.f.rest.messages.slice(-2).map(m => m.body.content.split('\n-# ref:')[0]);
  assert.equal(posted[0], '작업 목록이에요.');
  // 목록 줄 자체는 두 번째 대화 job이 하나 더 있어 '/list' 결과보다 한 줄 길다. 머리줄 모양과 첫 작업 줄이 같은지 본다.
  const lines = posted[1]!.split('\n');
  assert.equal(lines[0], '작업 2건');
  assert.equal(lines[1], slash.split('\n')[1]);
  assert.equal((await database.db.query('SELECT id FROM proposals')).rows.length, 0);
});

test('C13 기록에서 다시 읽은(복구) 메시지도 제안과 버튼 글만 만들고 작업은 시작하지 않는다', async () => {
  const h = await harness(database.db);
  h.reply(null, '먼저 말을 걸어요.');
  await h.say('100000000000000005', '안녕');
  await h.turn();
  h.reply(taskProposal());
  await h.ingress.receive({ id: '100000000000000030', actor: h.f.policy.owner, scope: thread, kind: 'message', text: `<@${BOT}> ${REQUEST}`,
    mention: true, botUser: BOT }, true);
  await h.turn();
  assert.equal(h.buttons().posted.length, 1);
  assert.ok(h.buttons().content.includes(REQUEST));
  await h.local.runtime.tickTask();
  assert.deepEqual(await h.taskJobs(), []);
});

test('C13 실행 중에 새 메시지가 와서 대화를 대체하면 그 대화의 제안은 만들지 않는다', async () => {
  const h = await harness(database.db);
  h.f.setRun(async () => {
    // 모델이 답하는 동안 owner가 다시 말한다.
    await h.say('100000000000000040', '아 잠깐, 다른 걸로 할게');
    return { status: 'succeeded', stopped: true, rateLimit: null, output: { reply: '시작할까요?', proposal: taskProposal(), ack_only: false } };
  });
  await h.say('100000000000000010', REQUEST);
  await h.turn();
  assert.equal(h.buttons().posted.length, 0);
  assert.equal((await database.db.query('SELECT id FROM proposals')).rows.length, 0);
});

// D-23·gitleaks에 걸리지 않게 조각을 이어 만든 GitHub 토큰 모양 값.
const TOKEN = ['ghp', 'C13'.repeat(12)].join('_');

test('C13 owner 원문에 공개 검사에 걸리는 값이 있으면 실행 확인 글은 원문 없이 고정 문구로 되묻고, 그 값은 확인 글·감사·outbox·제안 표 어디에도 없다', async () => {
  const h = await harness(database.db);
  h.reply(taskProposal());
  await h.say('100000000000000010', `${REQUEST} 토큰은 ${TOKEN} 이에요`);
  await h.turn();
  const shown = h.buttons();
  assert.equal(shown.posted.length, 1);
  assert.deepEqual(shown.labels, ['할게요', '아니에요']);
  assert.ok(shown.content.includes(PROJECT), shown.content);
  // 원문 미리보기 자체를 싣지 않는다(걸린 값 앞의 안전한 부분도).
  assert.ok(!shown.content.includes(REQUEST), shown.content);
  for (const message of h.f.rest.messages) assert.ok(!message.body.content.includes(TOKEN), message.body.content);
  for (const table of ['outbox', 'audit', 'proposals']) {
    const dump = JSON.stringify((await database.db.query(`SELECT * FROM ${table}`)).rows);
    assert.ok(!dump.includes(TOKEN), table);
  }
  // 실행은 '/task'처럼 owner 원문 그대로다.
  await h.press(h.buttons().ids[0]!);
  assert.equal((await h.taskJobs()).length, 1);
});

test('C13 제안 뒤 구독을 끈 대화에서 "할게요"를 누르면 작업을 접수하지 않고 버튼이 사라지며, 구독도 다시 켜지 않는다', async () => {
  const h = await harness(database.db);
  await proposed(h);
  const [yes] = h.buttons().ids;
  await h.ingress.receive({ id: 'fixture-stop-command', actor: h.f.policy.owner, scope: thread, kind: 'command', command: 'stop', text: '' });
  await h.press(yes!);
  assert.deepEqual(await h.taskJobs(), []);
  assert.equal(h.callbacks.at(-1)!.body.type, 7);
  assert.deepEqual(h.callbacks.at(-1)!.body.data.components, []);
  assert.equal(h.callbacks.at(-1)!.body.data.content, '이 대화는 구독이 꺼져 있어서 실행하지 않았어요. 구독을 다시 켠 뒤 다시 말해 주세요.');
  const row = (await database.db.query<{ state: string; reason: string }>('SELECT state,reason FROM proposals')).rows[0]!;
  assert.deepEqual([row.state, row.reason], ['refused', 'subscription_stopped']);
  const active = (await database.db.query<{ active: boolean }>('SELECT active FROM conversations')).rows.map(r => r.active);
  assert.deepEqual(active, [false]);
  // 다시 눌러도 이미 처리됨이다.
  await h.press(yes!);
  assert.equal(h.callbacks.at(-1)!.body.data.content, PROPOSAL_TEXT.settled);
  assert.deepEqual(await h.taskJobs(), []);
});

test('C13 최신성 검사를 지난 뒤 제안을 저장하기 전에 새 메시지가 접수돼 대화가 대체되면 제안을 만들지 않는다', async () => {
  // 제안 준비(원문 조회)가 돌아온 직후, 저장 트랜잭션 전에 owner의 새 메시지를 끼워 넣는다.
  let h!: Harness;
  let armed = false;
  const hooked: Database = {
    query: async <T>(sql: string, params?: unknown[]) => {
      const result = await database.db.query<T>(sql, params);
      if (armed && sql.startsWith('SELECT payload,text_purged_at FROM events')) { armed = false; await h.say('100000000000000040', '아 잠깐, 다른 걸로 할게'); }
      return result;
    },
    transaction: (fn, deadline) => database.db.transaction(fn, deadline),
  };
  h = await harness(hooked);
  h.reply(taskProposal());
  await h.say('100000000000000010', REQUEST);
  armed = true;
  await h.turn();
  assert.equal(armed, false, '훅이 불리지 않았다');
  assert.equal(h.buttons().posted.length, 0);
  assert.equal((await database.db.query('SELECT id FROM proposals')).rows.length, 0);
  const dropped = (await database.db.query<{ detail: { reason: string } }>("SELECT detail FROM audit WHERE kind='proposal_dropped'")).rows.map(r => r.detail.reason);
  assert.deepEqual(dropped, ['superseded']);
});
