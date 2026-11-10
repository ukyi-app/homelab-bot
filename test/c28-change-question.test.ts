import { after, before, beforeEach, test } from 'node:test';
import assert from 'node:assert/strict';
import { buttonAllowed } from '../src/discord-protocol.js';
import { TASK_INSTRUCTIONS } from '../src/executor-claude-task.js';
import { CHANGE_INSTRUCTIONS_REVISION, TASK_INSTRUCTIONS_REVISION } from '../src/task-contracts.js';
import { REPO } from './change-github-fake.js';
import { OTHER_THREAD, REQUEST_TEXT, THREAD, WRITE_STEP, changeHarness } from './change-assembly-harness.js';
import type { Harness } from './change-assembly-harness.js';
import { OWNER } from './change-store-fixture.js';
import { CHANGE_QUESTION_TEXT, changeChoiceId, changeDirectId } from '../src/change-question.js';
import { localDatabase } from './helpers.js';
import type { Step } from './task-worker-harness.js';

// C28 변경 질문 선택지(COLLEAGUE_SPEC §4.10 "변경 질문 줄이기", AC-25). 경계는 S1(PGlite, 가짜 Discord REST·상호작용)이고
// 작성 모델은 고정 stream-json을 내는 가짜 CLI다. 값은 모두 합성이다.
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

// 변경 작성 판(change-v2)의 출력 모양. 선택지·확인할 것·남은 위험 칸이 늘 있다.
const authored = (fields: Record<string, unknown>) => ({ status: 'completed', summary: '고쳤어요', question: '', options: [], checks: [], risks: [], ...fields });
const OPTIONS = ['src/a.ts를 고친다', 'README만 고친다', '둘 다 고친다'];
const CHOICE_QUESTION: Step = { output: authored({ status: 'needs_input', summary: '', question: '어느 쪽을 고칠까요?', options: OPTIONS }) };
const V2_WRITE: Step = { ...WRITE_STEP, output: authored({}) };
const openQuestion = async (h: Harness) => (await h.db.query<{ id: string }>(`SELECT id FROM codex_questions WHERE state='open'`)).rows[0]?.id;
const toQuestion = async (h: Harness) => {
  await h.command('100', 'change', { target: REPO.fullName, text: REQUEST_TEXT });
  const id = await h.changeId();
  await h.pump(async () => await openQuestion(h) !== undefined);
  return { id, question: (await openQuestion(h))! };
};

// ---- 지시문 판 ----

test('C28 판: 작업자가 change-v2를 받으면 변경 작성의 시작과 답 뒤 재개를 그 판으로 보낸다', async () => {
  await withHarness({ changeV2: true, steps: [CHOICE_QUESTION, V2_WRITE] }, async h => {
    const { id, question } = await toQuestion(h);
    await h.command('101', 'answer', { target: question, text: 'label=public | src/a.ts를 고친다' });
    await h.pump(async () => await h.phase(id) === 'awaiting_publish_approval');
    const calls = await h.f.calls();
    assert.equal(calls.length, 2);
    for (const call of calls) assert.ok(call.input.startsWith(TASK_INSTRUCTIONS[CHANGE_INSTRUCTIONS_REVISION]), '새 판의 지시문');
  });
});

test('C28 판: 작업자가 받는 판을 알리지 않으면(옛 port) 지금처럼 옛 판을 보낸다', async () => {
  await withHarness({}, async h => {
    await h.command('100', 'change', { target: REPO.fullName, text: REQUEST_TEXT });
    const id = await h.changeId();
    await h.pump(async () => await h.phase(id) === 'awaiting_publish_approval');
    const [call] = await h.f.calls();
    assert.ok(call!.input.startsWith(TASK_INSTRUCTIONS[TASK_INSTRUCTIONS_REVISION]), '옛 판의 지시문');
    assert.ok(!call!.input.startsWith(TASK_INSTRUCTIONS[CHANGE_INSTRUCTIONS_REVISION]));
  });
});

// ---- 선택지 저장과 공개 검사 ----

const options = async (h: Harness, question: string) => (await h.db.query<{ options: string[] | null }>('SELECT options FROM codex_questions WHERE id=$1', [question])).rows[0]!.options;
test('C28 저장: 변경 작성 질문의 선택지가 질문 행에 그 순서로 저장된다', async () => {
  await withHarness({ changeV2: true, steps: [CHOICE_QUESTION, V2_WRITE] }, async h => {
    const { question } = await toQuestion(h);
    assert.deepEqual(await options(h, question), OPTIONS);
  });
});

test('C28 계약: 선택지가 1개·5개인 질문은 작업자 계약(C25)이 받지 않아 질문 없이 변경이 실패로 닫힌다', async () => {
  for (const bad of [['하나뿐'], ['1', '2', '3', '4', '5']]) {
    await withHarness({ changeV2: true, steps: [{ output: authored({ status: 'needs_input', summary: '', question: '어느 쪽?', options: bad }) }] }, async h => {
      await h.command('100', 'change', { target: REPO.fullName, text: REQUEST_TEXT });
      const id = await h.changeId();
      await h.pump(async () => await h.phase(id) === 'failed');
      assert.equal((await h.changes.get(id) as any).value.phaseReason, 'invalid_output', JSON.stringify(bad));
      assert.equal((await h.db.query('SELECT 1 FROM codex_questions')).rows.length, 0);
    });
  }
});

const MARKER = 'fixture-corp-host';
test('C28 공개 검사: 선택지에 내부 표식이 있으면 질문 행·게시 없이 task_question_sensitive로 막는다', async () => {
  const leaking: Step = { output: authored({ status: 'needs_input', summary: '', question: '어느 쪽을 고칠까요?', options: ['그대로 둔다', `${MARKER}로 바꾼다`] }) };
  await withHarness({ changeV2: true, colleague: true, steps: [leaking] }, async h => {
    await h.command('100', 'change', { target: REPO.fullName, text: REQUEST_TEXT });
    const id = await h.changeId();
    await h.pump(async () => await h.phase(id) === 'blocked');
    assert.equal((await h.changes.get(id) as any).value.phaseReason, 'task_question_sensitive');
    assert.equal((await h.db.query('SELECT 1 FROM codex_questions')).rows.length, 0, '질문 행을 만들지 않는다');
    for (let round = 0; round < 20; round++) { await h.runtime.childrenTick(); await h.runtime.publishTick(); }
    await h.deliver();
    assert.ok(!JSON.stringify((await h.db.query('SELECT payload FROM outbox')).rows).includes(MARKER), 'outbox에 없다');
  });
});

// ---- 질문 글 ----

// 질문 글(버튼이 있으면 버튼까지). 게시를 비운 뒤 그 질문을 담은 마지막 글이다.
const questionPost = async (h: Harness) => {
  await h.deliver();
  return h.rest.messages.filter(message => message.body.content.includes('어느 쪽을 고칠까요?')).at(-1)!;
};
const buttonsOf = (post: Awaited<ReturnType<typeof questionPost>>) => post.body.components?.[0]?.components ?? [];
// 공개 여부를 묻는 글. 변경 질문 경로의 어떤 글에도 없어야 한다.
const ASKS_PUBLICITY = /공개해도 되는지|공개 여부|label=/;

test('C28 질문 글(켜짐): 질문, 번호 붙은 선택지, 선택지 버튼과 "직접 답하기", 말로 답해도 된다는 안내가 있고 공개 여부나 질문 ID 옮겨 적기는 없다', async () => {
  await withHarness({ changeV2: true, colleague: true, steps: [CHOICE_QUESTION, V2_WRITE] }, async h => {
    const { question } = await toQuestion(h);
    const post = await questionPost(h);
    const text = post.body.content;
    assert.match(text, /1\. src\/a\.ts를 고친다\n2\. README만 고친다\n3\. 둘 다 고친다/);
    assert.match(text, /이 스레드에서 답을 말해도 돼요/);
    assert.match(text, /도구 실행을 승인하거나 권한을 바꿀 수는 없어요/);
    assert.doesNotMatch(text, /\/answer/);
    assert.doesNotMatch(text, ASKS_PUBLICITY);
    const buttons = buttonsOf(post);
    assert.deepEqual(buttons.map(button => button.label), ['1번', '2번', '3번', '직접 답하기']);
    for (const button of buttons) {
      // 버튼에는 질문 ID와 선택지 순번만 싣는다. 선택지 글은 서버가 저장된 행에서 읽는다.
      assert.ok(button.custom_id.length <= 100, button.custom_id);
      assert.ok(button.custom_id.includes(question.split(':')[0]!), '질문 ID를 싣는다');
      assert.ok(OPTIONS.every(option => !button.custom_id.includes(option) && !button.label.includes(option)), '선택지 글은 싣지 않는다');
      assert.equal(buttonAllowed(button.custom_id), true, '허용 목록에 있는 버튼');
    }
  });
});

test('C28 질문 글(꺼짐): 선택지는 저장하되 질문 글은 지금 판(/answer와 label 서식 안내)이고 버튼이 없다', async () => {
  await withHarness({ changeV2: true, steps: [CHOICE_QUESTION, V2_WRITE] }, async h => {
    const { question } = await toQuestion(h);
    assert.deepEqual(await options(h, question), OPTIONS);
    const post = await questionPost(h);
    assert.match(post.body.content, new RegExp(`/answer question:${question}`));
    assert.equal(buttonsOf(post).length, 0);
    assert.ok(OPTIONS.every(option => !post.body.content.includes(option)), '지금 판 글 그대로다');
  });
});

// ---- 선택지 버튼과 "직접 답하기" ----

let interactions = 0;
// 버튼 상호작용. custom_id의 첫 칸이 이름, 나머지가 대상이다(DiscordProtocol이 나누는 방식).
const press = (h: Harness, customId: string, fields: { actor?: string; scope?: typeof THREAD; id?: string } = {}) => {
  const at = customId.indexOf(':');
  return h.ingress.receive({ id: fields.id ?? `fixture-interaction-${++interactions}`, actor: fields.actor ?? OWNER, scope: fields.scope ?? THREAD,
    kind: 'button', command: customId.slice(0, at), target: customId.slice(at + 1), text: '' });
};
const questionRow = async (h: Harness, question: string) => (await h.db.query<{ state: string; answer: string | null }>(
  'SELECT state,answer FROM codex_questions WHERE id=$1', [question])).rows[0]!;
const lastAck = (h: Harness) => ({ content: h.acknowledgements().at(-1), update: (h.rest.acks.at(-1)?.options as { update?: true } | undefined)?.update === true });
const publicInputs = async (h: Harness, id: string) => (await h.db.query<{ text: string }>(
  `SELECT i.text FROM change_request_inputs i JOIN change_requests r ON r.id=i.change_id WHERE i.change_id=$1 AND i.label='public' AND i.event_id<>r.event_id`, [id])).rows.map(row => row.text);

test('C28 선택지 버튼: 누르면 그 선택지 글이 공개 표시로 작성자에 넘어가 변경이 이어지고, 버튼이 사라지며 다시 눌러도 두 번 답하지 않는다', async () => {
  await withHarness({ changeV2: true, colleague: true, steps: [CHOICE_QUESTION, V2_WRITE] }, async h => {
    const { id, question } = await toQuestion(h);
    const buttons = buttonsOf(await questionPost(h));
    await press(h, buttons[1]!.custom_id, { id: 'fixture-press-1' });
    assert.deepEqual(await questionRow(h, question), { state: 'answered', answer: OPTIONS[1] });
    assert.deepEqual(await publicInputs(h, id), [OPTIONS[1]], '출처 public으로 기록된다');
    assert.equal(lastAck(h).update, true, '질문 글을 바꿔 버튼을 없앤다');
    assert.match(lastAck(h).content!, /2번/);
    // 같은 상호작용의 재전달, 다른 선택지, 같은 버튼 다시 누르기 모두 두 번째 답이 되지 않는다.
    const acks = h.rest.acks.length;
    await press(h, buttons[1]!.custom_id, { id: 'fixture-press-1' });
    assert.equal(h.rest.acks.length, acks, '같은 상호작용은 한 번만 처리한다');
    await press(h, buttons[0]!.custom_id);
    assert.equal(lastAck(h).update, false);
    assert.equal(lastAck(h).content, CHANGE_QUESTION_TEXT.closed);
    await press(h, buttons[1]!.custom_id);
    assert.deepEqual(await questionRow(h, question), { state: 'answered', answer: OPTIONS[1] });
    assert.deepEqual(await publicInputs(h, id), [OPTIONS[1]]);

    await h.pump(async () => await h.phase(id) === 'awaiting_publish_approval');
    const calls = await h.f.calls();
    assert.equal(calls.length, 2);
    assert.ok(calls[1]!.input.includes(OPTIONS[1]!), '작성자에게 그 선택지 글이 간다');
    assert.ok(!calls[1]!.input.includes('label=public'), '공개 표시는 떼고 넘긴다');
    assert.ok(!calls[1]!.input.includes(OPTIONS[0]!));
    assert.ok([...h.messages(), ...h.acknowledgements()].every(text => !ASKS_PUBLICITY.test(text)), '공개 여부를 묻는 글이 없다');
  });
});

test('C28 선택지 버튼 거부: 다른 사람, 다른 스레드, 기한 지난 질문의 버튼은 답이 되지 않는다', async () => {
  await withHarness({ changeV2: true, colleague: true, steps: [CHOICE_QUESTION, V2_WRITE] }, async h => {
    const { question } = await toQuestion(h);
    const [first] = buttonsOf(await questionPost(h));
    await assert.rejects(press(h, first!.custom_id, { actor: 'fixture-stranger' }), '다른 사람');
    // 다른 스레드(owner의 다른 대화)에서 같은 버튼 값을 보낸다.
    await h.command('200', 'change-status', { target: 'fixture-missing', scope: OTHER_THREAD });
    await press(h, first!.custom_id, { scope: OTHER_THREAD }).catch(() => undefined);
    assert.deepEqual(await questionRow(h, question), { state: 'open', answer: null });
    // 기한이 지난 질문. 시계 대신 저장된 기한을 앞당긴다.
    await h.db.query('UPDATE codex_questions SET expires_at=$2 WHERE id=$1', [question, Date.now() - 1]);
    await press(h, first!.custom_id);
    assert.equal(lastAck(h).update, false);
    const row = await questionRow(h, question);
    assert.equal(row.answer, null);
    assert.notEqual(row.state, 'answered');
  });
});

test('C28 "직접 답하기": 누른 owner에게만 말로 답하라고 알리고 질문 상태는 그대로다', async () => {
  await withHarness({ changeV2: true, colleague: true, steps: [CHOICE_QUESTION, V2_WRITE] }, async h => {
    const { question } = await toQuestion(h);
    const direct = buttonsOf(await questionPost(h)).at(-1)!;
    await press(h, direct.custom_id);
    assert.deepEqual(lastAck(h), { content: CHANGE_QUESTION_TEXT.speak, update: false });
    assert.deepEqual(await questionRow(h, question), { state: 'open', answer: null });
  });
});

// ---- 다음 말 ----

let sequence = 1_800_000_000_000_000_000n;
const say = (h: Harness, text: string, fields: { mention?: boolean; actor?: string } = {}) => {
  const id = String(++sequence);
  return h.ingress.receive({ id, actor: fields.actor ?? OWNER, scope: THREAD, kind: 'message', text, mention: fields.mention ?? false }).then(() => id);
};
const eventText = async (h: Harness, delivery: string) => (await h.db.query<{ text: string }>(`SELECT payload->>'text' AS text FROM events WHERE delivery_id=$1`, [delivery])).rows[0]?.text;
const chatJobs = async (h: Harness) => (await h.db.query(`SELECT 1 FROM jobs WHERE type='chat'`)).rows.length;
// 멘션으로 대화를 연 스레드에서 변경을 요청한 것과 같게 구독을 켠다. 이 대화 작업은 시험이 돌리지 않는다.
const opened = async (h: Harness) => { await say(h, '변경 부탁할게요', { mention: true }); return chatJobs(h); };

test('C28 다음 말: 열린 변경 질문이 하나면 owner의 다음 말이 저장 전에 봉인되고 공개 표시로 답이 되어 이어진다. 대화 작업·모델 호출은 없다', async () => {
  await withHarness({ changeV2: true, colleague: true, steps: [CHOICE_QUESTION, V2_WRITE] }, async h => {
    const before = await opened(h);
    const { id, question } = await toQuestion(h);
    const answer = `${OPTIONS[2]}. 시험 이름은 그대로 두세요`;
    const message = await say(h, answer);
    assert.deepEqual(await questionRow(h, question), { state: 'answered', answer });
    assert.equal(await eventText(h, message), '', 'events에 원문이 없다');
    assert.deepEqual(await publicInputs(h, id), [answer]);
    assert.equal(await chatJobs(h), before, '대화 작업을 만들지 않는다');
    await h.deliver();
    assert.ok(h.rest.messages.some(post => post.body.message_reference?.message_id === message), '그 말에 답장으로 결과를 단다');
    await h.pump(async () => await h.phase(id) === 'awaiting_publish_approval');
    const calls = await h.f.calls();
    assert.equal(calls.length, 2, '작성 모델만 두 번이다');
    assert.ok(calls[1]!.input.includes(answer));
    assert.ok([...h.messages(), ...h.acknowledgements()].every(text => !ASKS_PUBLICITY.test(text)), '공개 여부를 묻는 글이 없다');
  });
});

test('C28 다음 말 공개 검사: 답에 내부 표식이 있으면 작성자에 넘기지 않고 변경을 막는다. 값은 events·응답에 없다', async () => {
  await withHarness({ changeV2: true, colleague: true, steps: [CHOICE_QUESTION, V2_WRITE] }, async h => {
    await opened(h);
    const { id, question } = await toQuestion(h);
    const message = await say(h, `${MARKER}를 쓰세요`);
    assert.equal((await questionRow(h, question)).answer, null, '재개가 읽는 자리에 답이 없다');
    assert.equal(await eventText(h, message), '');
    await h.pump(async () => await h.phase(id) === 'blocked');
    assert.equal((await h.f.calls()).length, 1, '답으로 턴을 띄우지 않았다');
    await h.deliver();
    assert.ok([...h.messages(), ...h.acknowledgements()].every(text => !text.includes(MARKER) && !ASKS_PUBLICITY.test(text)));
  });
});

test('C28 꺼짐: 변경 질문이 열려 있어도 다음 말은 답이 아니라 지금처럼 대화로 받고 원문을 남긴다', async () => {
  await withHarness({ changeV2: true, steps: [CHOICE_QUESTION, V2_WRITE] }, async h => {
    const before = await opened(h);
    const { question } = await toQuestion(h);
    const message = await say(h, '그냥 한 말이에요');
    assert.deepEqual(await questionRow(h, question), { state: 'open', answer: null });
    assert.equal(await eventText(h, message), '그냥 한 말이에요');
    assert.equal(await chatJobs(h), before + 1);
    // 꺼짐에서는 버튼을 만들지 않으므로 같은 모양의 상호작용도 받지 않는다.
    await assert.rejects(press(h, changeChoiceId(question, 1)));
    await assert.rejects(press(h, changeDirectId(question)));
    assert.deepEqual(await questionRow(h, question), { state: 'open', answer: null });
  });
});

test('C28 다음 말(history gap 중): 봉인한 말은 복구 버퍼에 두지 않고 바로 답 경로로 보내 원문 없이 답이 된다', async () => {
  await withHarness({ changeV2: true, colleague: true, steps: [CHOICE_QUESTION, V2_WRITE] }, async h => {
    await opened(h);
    const { question } = await toQuestion(h);
    // 재연결 뒤 누락 복구 전이다. 시계 대신 저장된 대화 상태를 바꾼다.
    await h.db.query('UPDATE conversations SET gap=true WHERE id=$1', [h.store.scopeId(THREAD)]);
    const message = await say(h, OPTIONS[0]!);
    assert.deepEqual(await questionRow(h, question), { state: 'answered', answer: OPTIONS[0] });
    const row = (await h.db.query<{ text: string; buffered: boolean }>(`SELECT payload->>'text' AS text,buffered FROM events WHERE delivery_id=$1`, [message])).rows[0]!;
    assert.deepEqual(row, { text: '', buffered: false });
  });
});
