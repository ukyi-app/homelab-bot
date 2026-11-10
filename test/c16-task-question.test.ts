import { after, before, beforeEach, test } from 'node:test';
import assert from 'node:assert/strict';
import { CHAT_TASK_TEXT as T } from '../src/chat-task-text.js';
import { guardedTaskCommands } from '../src/change-assembly.js';
import { ChangePrivateInputs } from '../src/change-store.js';
import { DEFAULTS } from '../src/contracts.js';
import type { Database } from '../src/database.js';
import { ALL_COMMANDS, DiscordIngress } from '../src/discord.js';
import { DiscordProtocol, buttonAllowed } from '../src/discord-protocol.js';
import { TASK_ANSWER_RETENTION_MS, purgeExpiredTaskAnswers } from '../src/task-bridge.js';
import { TaskCommands } from '../src/task-commands.js';
import { taskQuestionId } from '../src/task-contracts.js';
import { fixture, localDatabase, thread } from './helpers.js';
import { lane, reply } from './task-lane-fixture.js';

// C16 작업 질문 바로 답. S1 경계: 수신은 Gateway 프레임(메시지·버튼 상호작용) → DiscordProtocol, 저장은 PGlite,
// 게시는 가짜 REST(MockDiscord), 작업은 '/' task와 같은 TaskCommands(운영처럼 CHANGE 답 봉인 처리기로 감쌈)·가짜 작업자다.
const BOT = '900000000000000001';
const PROJECT = 'fixture';
// '/task'가 구독을 켤 때 경계로 적는 지금 시각의 snowflake보다 커야 새 메시지로 받는다.
let next = 1_700_000_000_000_000_000n;
const messageId = () => String(++next);

let database: Awaited<ReturnType<typeof localDatabase>>;
before(async () => { database = await localDatabase(); });
after(async () => { await database.pg.close(); });
beforeEach(async () => {
  await database.pg.exec(`TRUNCATE events,conversations,jobs,results,outbox,schedules,denied_actors,controls,audit,incidents,codex_sessions,codex_questions,proposals RESTART IDENTITY CASCADE;
    UPDATE execution_lanes SET closed_reason=NULL,closed_at=NULL`);
});

type Harness = Awaited<ReturnType<typeof harness>>;
async function harness(db: Database, options: { colleague?: boolean } = {}) {
  const f = await fixture(db, { colleague: options.colleague ?? true });
  (f.policy as { task?: unknown }).task = { projects: [{ id: PROJECT, revision: 'r1', repository: 'fixture-org/fixture-repo', branch: 'main',
    allowedPaths: ['src'], forbiddenPaths: [], verifyCommands: [] }] };
  const local = lane(f);
  const handler = guardedTaskCommands(new TaskCommands(f.store, f.gate, local.bridge, () => ({ routed: true, open: true, reasons: [] }), () => {}, () => {}),
    new ChangePrivateInputs(db, f.now), f.gate);
  const callbacks: { body: { type: number; data: Record<string, unknown> } }[] = [];
  const protocol = new DiscordProtocol({ request: async (method, path, body) => {
    if (method === 'GET' && path === `/channels/${thread.channel}`) return { id: thread.channel, type: 11, parent_id: thread.parent, guild_id: thread.guild };
    if (method === 'GET' && path === '/channels/fixture-other-thread') return { id: 'fixture-other-thread', type: 11, parent_id: thread.parent, guild_id: thread.guild };
    if (method === 'PUT') return undefined;
    if (method === 'POST' && path.endsWith('/callback')) { callbacks.push({ body: body as never }); return undefined; }
    throw new Error(`unexpected_route ${method} ${path}`);
  } }, BOT, f.now);
  const ingress = new DiscordIngress(f.store, f.gate, protocol, true, ALL_COMMANDS, () => {}, undefined, handler);
  let interactions = 0;
  const deliver = async () => { while (await f.publisher.deliver()) { /* 쌓인 게시를 비운다 */ } };
  const h = {
    f, local, ingress, callbacks, deliver,
    // '/task' 하나를 접수하고 작업자가 질문을 내게 한 턴을 돌린다. 질문 ID를 돌려준다.
    async asked(question = '어느 브랜치 기준으로 고칠까요?', id = `fixture-task-${++interactions}`) {
      local.worker.scripts.push(reply.question(question));
      await ingress.receive({ id, actor: f.policy.owner, scope: thread, kind: 'command', command: 'task', target: PROJECT, text: '실패하는 시험을 고쳐 줘' });
      const job = (await db.query<{ id: string }>(`SELECT j.id FROM jobs j JOIN events e ON e.id=j.event_id WHERE e.delivery_id=$1`, [id])).rows[0]!.id;
      assert.equal(await local.runtime.tickTask(), true);
      const session = (await db.query<{ claude_session_id: string }>('SELECT claude_session_id FROM codex_sessions WHERE job_id=$1', [job])).rows[0]!;
      return { job, question: taskQuestionId(job, session.claude_session_id, 1) };
    },
    // owner의 일반 메시지(멘션 없음, Gateway MESSAGE_CREATE).
    say: (text: string, options: { id?: string; author?: string; channel?: string; mention?: boolean } = {}) => protocol.gateway('MESSAGE_CREATE', {
      id: options.id ?? messageId(), channel_id: options.channel ?? thread.channel, guild_id: thread.guild, author: { id: options.author ?? f.policy.owner }, content: text,
      ...(options.mention ? { mentions: [{ id: BOT }] } : {}) }, ingress),
    press: (customId: string, actor = f.policy.owner) => protocol.gateway('INTERACTION_CREATE', { id: `fixture-interaction-${++interactions}`,
      token: 'fixture-interaction-token', type: 3, channel_id: thread.channel, guild_id: thread.guild, member: { user: { id: actor } },
      data: { custom_id: customId } }, ingress),
    question: async (id: string) => (await db.query<{ state: string; answer: string | null; answer_event: string | null }>(
      'SELECT state,answer,answer_event FROM codex_questions WHERE id=$1', [id])).rows[0]!,
    chatJobs: async () => (await db.query<{ id: string }>(`SELECT id FROM jobs WHERE type='chat'`)).rows,
    jobState: async (id: string) => (await db.query<{ state: string }>('SELECT state FROM jobs WHERE id=$1', [id])).rows[0]!.state,
    // 디바운스를 넘겨 대화 레인을 한 바퀴 돌린다. 대화 작업이 있으면 모델(가짜 대화 작업자)을 부른다.
    async chatTurn() { f.advance(DEFAULTS.debounceMs + 50); await local.runtime.tick(); },
    texts: () => f.rest.messages.map(m => m.body.content),
  };
  return h;
}

test('C16 열린 작업 질문이 하나면 owner의 다음 말이 모델을 거치지 않고 그 답이 되고 같은 세션으로 이어진다', async () => {
  const h = await harness(database.db);
  const { job, question } = await h.asked();
  await h.deliver();
  // 켜짐 판 질문 글은 질문 ID를 옮겨 적으라고 하지 않고, 답이 승인·권한 변경이 아니라는 문장은 남긴다.
  const asked = h.texts().find(text => text.includes('어느 브랜치'))!;
  assert.match(asked, /이 스레드에서 답을 말해 주세요/);
  assert.doesNotMatch(asked, /\/answer/);
  assert.match(asked, /도구 실행을 승인하거나 권한을 바꿀 수는 없어요/);

  const answerId = messageId();
  await h.say('main 기준으로 해 주세요', { id: answerId });
  assert.deepEqual(await h.question(question), { state: 'answered', answer: 'main 기준으로 해 주세요', answer_event: answerId });
  assert.equal(await h.jobState(job), 'queued');
  // 대화 작업이 생기지 않고 모델도 부르지 않는다.
  await h.chatTurn();
  assert.deepEqual(await h.chatJobs(), []);
  assert.equal(h.f.requests.length, 0);
  // 답 처리 안내는 '/answer'와 같은 동료 말투 문구다.
  await h.deliver();
  assert.equal(h.texts().filter(text => text.startsWith(T.taskAnswerAccepted)).length, 1);
  // 같은 세션으로 그 답을 들고 이어 간다.
  h.local.worker.scripts.push(reply.completed('main 기준으로 고쳤어요.'));
  await h.local.runtime.tickTask();
  assert.equal(h.local.worker.executes.length, 2);
  assert.equal(h.local.worker.executes[1]!.operation, 'resume');
  assert.ok(JSON.stringify(h.local.worker.executes[1]).includes('main 기준으로 해 주세요'));
  assert.equal(await h.jobState(job), 'succeeded');
});

test('C16 열린 작업 질문이 둘이면 질문마다 버튼을 단 글로 묻고, 고른 질문에만 그 말이 답으로 붙고 버튼이 사라진다', async () => {
  const h = await harness(database.db);
  const first = await h.asked('어느 브랜치 기준으로 고칠까요?');
  // 고르기 글은 먼저 만든 질문부터 번호를 매긴다. 가짜 시계가 멈춰 있으면 같은 시각이라 순서가 질문 ID로 갈린다.
  h.f.advance(1000);
  const second = await h.asked('시험 이름을 바꿔도 될까요?');
  await h.deliver();
  const said = messageId();
  await h.say('네, 바꿔도 돼요', { id: said });
  // 고를 때까지 어느 질문에도 답이 붙지 않고 대화 작업도 없다.
  assert.equal((await h.question(first.question)).state, 'open');
  assert.equal((await h.question(second.question)).state, 'open');
  await h.chatTurn();
  assert.deepEqual(await h.chatJobs(), []);
  assert.equal(h.f.requests.length, 0);
  await h.deliver();
  const posted = h.f.rest.messages.filter(m => m.body.components?.length).at(-1)!;
  assert.equal(posted.body.message_reference?.message_id, said);
  assert.match(posted.body.content, /1\. 어느 브랜치 기준으로 고칠까요\?[\s\S]*2\. 시험 이름을 바꿔도 될까요\?/);
  const buttons = posted.body.components![0]!.components;
  assert.deepEqual(buttons.map(b => b.label), ['1번 질문', '2번 질문']);
  // 버튼에는 ID만 둔다.
  for (const button of buttons) assert.ok(button.custom_id.length <= 100 && !button.custom_id.includes('바꿔'), button.custom_id);
  // owner가 아닌 사람은 고를 수 없다.
  await assert.rejects(h.press(buttons[1]!.custom_id, 'fixture-stranger'));
  assert.equal((await h.question(second.question)).state, 'open');

  await h.press(buttons[1]!.custom_id);
  assert.deepEqual(await h.question(second.question), { state: 'answered', answer: '네, 바꿔도 돼요', answer_event: said });
  assert.equal((await h.question(first.question)).state, 'open');
  assert.equal(await h.jobState(second.job), 'queued');
  assert.equal(await h.jobState(first.job), 'waiting_user');
  // 그 글을 결과로 바꾸고 버튼을 모두 없앤다.
  assert.equal(h.callbacks.at(-1)!.body.type, 7);
  assert.deepEqual(h.callbacks.at(-1)!.body.data.components, []);
  assert.ok(String(h.callbacks.at(-1)!.body.data.content).startsWith(T.taskAnswerAccepted));
  // 같은 말을 다른 질문에 다시 붙이지 못한다.
  await h.press(buttons[0]!.custom_id);
  assert.equal((await h.question(first.question)).state, 'open');
  assert.equal(h.callbacks.at(-1)!.body.type, 7);
  assert.doesNotMatch(String(h.callbacks.at(-1)!.body.data.content), new RegExp(T.taskAnswerAccepted));
});

test('C16 고르는 사이 질문의 기한이 지나면 답을 붙이지 않고 이유만 본인에게 답하며 버튼은 그대로 둔다', async () => {
  const h = await harness(database.db);
  const first = await h.asked('어느 브랜치 기준으로 고칠까요?');
  await h.asked('시험 이름을 바꿔도 될까요?');
  await h.say('main 기준이요');
  await h.deliver();
  const buttons = h.f.rest.messages.filter(m => m.body.components?.length).at(-1)!.body.components![0]!.components;
  h.f.advance(60 * 60 * 1000 + 1);
  await h.press(buttons[0]!.custom_id);
  assert.notEqual((await h.question(first.question)).state, 'answered');
  assert.equal(h.callbacks.at(-1)!.body.type, 4);
  assert.match(String(h.callbacks.at(-1)!.body.data.content), new RegExp(T.questionExpired));
});

test('C16 기한이 지난 질문에는 바로 답이 붙지 않고, 그 말은 지금처럼 대화로 받는다', async () => {
  const h = await harness(database.db);
  const { question } = await h.asked();
  h.f.advance(60 * 60 * 1000 + 1);
  await h.say('main 기준이요');
  assert.equal((await h.question(question)).answer, null);
  assert.equal((await h.chatJobs()).length, 1);
});

test('C16 다른 사람의 말은 막히고, 다른 스레드에서 한 owner의 말은 이 스레드 질문의 답이 되지 않는다', async () => {
  const h = await harness(database.db);
  const { question } = await h.asked();
  await assert.rejects(h.say('제가 대신 답할게요', { author: 'fixture-stranger' }));
  assert.equal((await h.question(question)).state, 'open');
  await h.say(`<@${BOT}> main 기준이요`, { channel: 'fixture-other-thread', mention: true });
  assert.equal((await h.question(question)).state, 'open');
  assert.equal((await h.chatJobs()).length, 1);
});

test('C16 같은 메시지가 다시 전달돼도 답은 한 번만 반영되고 안내도 한 번이다', async () => {
  const h = await harness(database.db);
  const { question } = await h.asked();
  const id = messageId();
  await h.say('main 기준이요', { id });
  await h.say('main 기준이요', { id });
  assert.equal((await h.question(question)).answer_event, id);
  await h.deliver();
  assert.equal(h.texts().filter(text => text.startsWith(T.taskAnswerAccepted)).length, 1);
  assert.deepEqual(await h.chatJobs(), []);
});

test('C16 다른 실행기 세션의 질문은 지금처럼 거부를 안내하고, 그 말로 대화 작업을 만들지 않는다', async () => {
  const h = await harness(database.db);
  const { job, question } = await h.asked();
  // 같은 질문을 Codex 세션의 작업 것으로 바꾼다(세션 행의 executor 기본값이 codex다, task-lane-fixture의 codexSession과 같은 모양).
  await database.db.query('DELETE FROM codex_sessions WHERE job_id=$1', [job]);
  await database.db.query(`INSERT INTO codex_sessions(job_id,thread_id,turn,tool_calls,host,capabilities,state,created_at,updated_at)
    VALUES ($1,'codex-thread',1,0,'worker','{}','waiting_answer',$2,$2)`, [job, h.f.now()]);
  await h.say('main 기준이요');
  assert.equal((await h.question(question)).state, 'open');
  assert.deepEqual(await h.chatJobs(), []);
  await h.deliver();
  assert.ok(h.texts().some(text => text.includes(T.foreignSession)));
});

test('C16 스위치 꺼짐: 질문 글은 질문 ID와 /answer를 안내하고, 그냥 한 말은 지금처럼 대화로 받는다', async () => {
  const h = await harness(database.db, { colleague: false });
  const { question } = await h.asked();
  await h.deliver();
  assert.ok(h.texts().some(text => text.includes(`/answer question:${question}`)));
  await h.say('main 기준이요');
  assert.equal((await h.question(question)).state, 'open');
  assert.equal((await h.chatJobs()).length, 1);
});

test('C16 바로 답한 원문도 지금처럼 작업이 끝난 지 7일 뒤 지워진다', async () => {
  const h = await harness(database.db);
  const { job, question } = await h.asked();
  await h.say('main 기준이요');
  h.local.worker.scripts.push(reply.completed());
  await h.local.runtime.tickTask();
  assert.equal(await h.jobState(job), 'succeeded');
  assert.equal(await purgeExpiredTaskAnswers(database.db, h.f.now()), 0);
  h.f.advance(TASK_ANSWER_RETENTION_MS + 1);
  assert.equal(await purgeExpiredTaskAnswers(database.db, h.f.now()), 1);
  assert.equal((await h.question(question)).answer, null);
});

test('C16 질문 고르기 버튼은 허용 목록 표의 이름·두 칸만 받고, 스위치가 꺼져 있으면 받지 않는다', async () => {
  assert.equal(buttonAllowed('question-pick:00000000-0000-4000-8000-000000000001'), true);
  for (const refused of ['question-pick', 'question-pick:a:b', 'question-pick:', `question-pick:${'a'.repeat(100)}`]) assert.equal(buttonAllowed(refused), false, refused);
  const off = await harness(database.db, { colleague: false });
  await off.asked();
  await assert.rejects(off.press('question-pick:00000000-0000-4000-8000-000000000001'));
});

export type { Harness };
