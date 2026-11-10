import { after, before, beforeEach, test } from 'node:test';
import assert from 'node:assert/strict';
import { REQUEST_TEXT, changeHarness } from './change-assembly-harness.js';
import type { Harness } from './change-assembly-harness.js';
import { REPO } from './change-github-fake.js';
import { localDatabase } from './helpers.js';

// C33 시험 거절 뒤 다시 확인. 실제 ChangeRuntime·ClaudeTaskBridge·TaskWorkerService를 PGlite 위에서 잇는다. 값은 모두 합성이다.
let database: Awaited<ReturnType<typeof localDatabase>>;
before(async () => { database = await localDatabase(); });
after(async () => { await database.pg.close(); });
beforeEach(async () => {
  const tables = (await database.pg.query<{ tablename: string }>("SELECT tablename FROM pg_tables WHERE schemaname='public' AND tablename<>'schema_migrations'")).rows.map(row => row.tablename);
  await database.pg.exec(`TRUNCATE ${tables.join(',')} RESTART IDENTITY CASCADE`);
  await database.pg.exec(`INSERT INTO execution_lanes(lane) VALUES ('interactive'), ('task') ON CONFLICT DO NOTHING`);
});
const digestOf = async (h: Harness, id: string) => (await h.db.query<{ approval_digest: string }>('SELECT approval_digest FROM change_approval_subjects WHERE change_id=$1', [id])).rows[0]!.approval_digest;
const reasonOf = async (h: Harness, id: string) => (await h.db.query<{ phase_reason: string | null }>('SELECT phase_reason FROM change_requests WHERE id=$1', [id])).rows[0]!.phase_reason;
const verifications = async (h: Harness, id: string) => (await h.db.query<{ status: string }>('SELECT status FROM change_verifications WHERE change_id=$1', [id])).rows.map(row => row.status);
const settled = (phase: string) => ['awaiting_publish_approval', 'blocked', 'cancelled', 'failed'].includes(phase);

test('C33 같은 밀리초: 게시 서버 둘이 같은 verify를 같은 시각에 서명해 한쪽이 거부돼도 변경이 승인 대기까지 가고 모델·시험·PR이 하나다', async () => {
  const h = await changeHarness(database.db, { sameMillisecondVerify: true });
  try {
    await h.command('100', 'change', { target: REPO.fullName, text: REQUEST_TEXT });
    const id = await h.changeId();
    const first = h.runtime;
    const firstReview = h.reviewRuntime;
    h.restart();
    const second = h.runtime;
    const secondReview = h.reviewRuntime;
    const both = async () => { await Promise.allSettled([first.childrenTick(), second.childrenTick(), first.laneTick(), second.laneTick(), first.publishTick(), second.publishTick(), firstReview.tick(), secondReview.tick()]); };
    for (let round = 0; round < 600 && !settled(await h.phase(id)); round++) { await both(); await new Promise(resolve => setTimeout(resolve, 3)); }
    assert.equal(h.collisions.verify, 1, '두 verify가 같은 시각에 서명됐다');
    assert.deepEqual([await h.phase(id), await reasonOf(h, id)], ['awaiting_publish_approval', null]);
    assert.deepEqual(await verifications(h, id), ['passed']);
    await h.command('101', 'change-publish', { target: id, text: await digestOf(h, id) });
    for (let round = 0; round < 600 && await h.phase(id) !== 'proposed'; round++) { await both(); await new Promise(resolve => setTimeout(resolve, 3)); }
    assert.equal(await h.phase(id), 'proposed');
    assert.equal((await h.f.calls()).length, 1, '모델 1회');
    assert.equal(h.runs.verify, 1, '시험 1회');
    assert.equal(h.reviewInputs.length, 1, '리뷰 1회');
    assert.equal(h.env.github.pulls.length, 1, 'PR 하나');
  } finally { await h.close(); }
});

test('C33 파드 교체: 시험 직전에 작업자 파드가 바뀌어 worker_mismatch로 거부돼도 같은 저장소의 새 파드에서 시험이 한 번 돌고 승인 대기까지 간다', async () => {
  const h = await changeHarness(database.db);
  try {
    let replaced = false;
    h.restart({ instrument: deps => ({ ...deps, verification: {
      run: async input => { if (!replaced) { replaced = true; await h.f.restart(); } return deps.verification.run(input); },
      fetchReceipt: input => deps.verification.fetchReceipt(input) } }) });
    await h.command('100', 'change', { target: REPO.fullName, text: REQUEST_TEXT });
    const id = await h.changeId();
    await h.pump(async () => settled(await h.phase(id)));
    assert.equal(replaced, true, '시험 요청 직전에 파드가 바뀌었다');
    assert.deepEqual([await h.phase(id), await reasonOf(h, id)], ['awaiting_publish_approval', null]);
    assert.deepEqual(await verifications(h, id), ['passed']);
    assert.equal(h.runs.verify, 1, '시험 1회');
  } finally { await h.close(); }
});
