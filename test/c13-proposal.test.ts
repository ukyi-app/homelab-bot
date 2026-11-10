import { after, before, beforeEach, test } from 'node:test';
import assert from 'node:assert/strict';
import { localDatabase } from './helpers.js';
import { harness, PROJECT } from './c13-proposal-fixture.js';
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
