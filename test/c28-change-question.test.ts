import { after, before, beforeEach, test } from 'node:test';
import assert from 'node:assert/strict';
import { TASK_INSTRUCTIONS } from '../src/executor-claude-task.js';
import { CHANGE_INSTRUCTIONS_REVISION, TASK_INSTRUCTIONS_REVISION } from '../src/task-contracts.js';
import { REPO } from './change-github-fake.js';
import { REQUEST_TEXT, WRITE_STEP, changeHarness } from './change-assembly-harness.js';
import type { Harness } from './change-assembly-harness.js';
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
