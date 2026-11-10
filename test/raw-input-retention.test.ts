import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import pg from 'pg';
import { CHANGE_RETENTION_MS, ChangePrivateInputs, ChangeStore, purgeExpiredChangeContent } from '../src/change-store.js';
import type { ChangeRequest } from '../src/change-store.js';
import type { Database } from '../src/database.js';
import { MIGRATIONS, Postgres, migrationVersion } from '../src/database.js';
import { runMigrations } from '../src/migrate-main.js';
import { TASK_ANSWER_RETENTION_MS, purgeExpiredTaskAnswers } from '../src/task-bridge.js';
import { taskQuestionId } from '../src/task-contracts.js';
import { CONVERSATION, OWNER, driveTo, failure, newRequest, ok, seedConversation } from './change-store-fixture.js';
import { fixture, localDatabase } from './helpers.js';
import { answer, lane, reply, task } from './task-lane-fixture.js';

// 사람 입력 원문 두 칸(change_request_inputs.text, codex_questions.answer)의 7일 보존(DECISIONS T27).
const DAY = 86_400_000;
const sha = (text: string) => createHash('sha256').update(text, 'utf8').digest('hex');
const inputRows = async (db: Database, changeId: string) =>
  (await db.query<{ text: string; text_sha256: string; purged_at: string | null }>('SELECT text,text_sha256,purged_at FROM change_request_inputs WHERE change_id=$1', [changeId])).rows;
const questionRow = async (db: Database, id: string) =>
  (await db.query<{ answer: string | null; answer_sha256: string | null; answer_purged_at: string | null; answer_event: string | null; answered_by: string | null }>(
    'SELECT answer,answer_sha256,answer_purged_at,answer_event,answered_by FROM codex_questions WHERE id=$1', [id])).rows[0]!;

async function changeSetup(start = 1_800_000_000_000) {
  const { db, pg: engine } = await localDatabase();
  await seedConversation(db);
  const clock = { now: start };
  const store = new ChangeStore(db, () => clock.now);
  return { db, clock, store, close: () => engine.close() };
}
// 끝 상태에 든 시각이 clock.now인 change.
async function ended(store: ChangeStore, at: 'snapshot_ready' | 'authoring' = 'snapshot_ready', to: 'cancelled' | 'superseded' = 'cancelled'): Promise<ChangeRequest> {
  const r = await driveTo(store, at);
  ok(await store.transition({ changeId: r.id, generation: 1, from: at, to, reason: to === 'cancelled' ? 'user_cancelled' : 'base_moved' }));
  return r;
}

test('감사 A03 조건: 작업 레인 질문 답과 CHANGE 요청 원문이 8일 뒤 정리에서 남지 않고 digest·영수증은 남는다', async () => {
  const { db, pg: engine } = await localDatabase();
  try {
    const f = await fixture(db);
    const setup = lane(f);
    setup.worker.scripts.push(reply.question('Synthetic question for retention'));
    const j = await task(f, db, 'retention-task');
    await setup.runtime.tickTask();
    const s = (await db.query<{ claude_session_id: string }>('SELECT claude_session_id FROM codex_sessions WHERE job_id=$1', [j.id])).rows[0]!;
    const q = taskQuestionId(j.id, s.claude_session_id, 1);
    const marker = 'synthetic-private-answer-marker';
    assert.equal((await answer(setup.bridge, q, marker, 'answer-retention')).ok, true);
    setup.worker.scripts.push(reply.completed());
    await setup.runtime.tickTask();
    assert.equal((await db.query<{ state: string }>('SELECT state FROM jobs WHERE id=$1', [j.id])).rows[0]!.state, 'succeeded');

    await seedConversation(db);
    const store = new ChangeStore(db, f.now);
    const r = await newRequest(store);
    const digestBefore = (await inputRows(db, r.id))[0]!.text_sha256;
    await db.query('UPDATE change_request_inputs SET text=$2 WHERE change_id=$1', [r.id, 'synthetic-private-request-marker']);
    await driveTo(store, 'snapshot_ready', r);
    ok(await store.transition({ changeId: r.id, generation: 1, from: 'snapshot_ready', to: 'cancelled', reason: 'user_cancelled' }));
    f.advance(8 * DAY);

    // 운영에서 도는 두 정리 진입점이다(main의 change_retention·task_answer_retention).
    assert.equal(await purgeExpiredChangeContent(db, f.now()), 1);
    assert.equal(await purgeExpiredTaskAnswers(db, f.now()), 1);
    const row = await questionRow(db, q);
    assert.equal(row.answer, null);
    assert.equal(row.answer_sha256, sha(marker));
    assert.equal(row.answer_event, 'answer-retention');
    assert.equal(row.answered_by, 'fixture-owner');
    assert.equal(Number(row.answer_purged_at), f.now());
    const inputs = await inputRows(db, r.id);
    assert.deepEqual(inputs.map(i => [i.text, i.text_sha256, Number(i.purged_at)]), [['', digestBefore, f.now()]]);
    const dump = JSON.stringify([(await db.query('SELECT * FROM codex_questions')).rows, (await db.query('SELECT * FROM change_request_inputs')).rows]);
    assert.equal(dump.includes('synthetic-private'), false);
  } finally { await engine.close(); }
});

test('CHANGE 요청 원문: 끝 상태에 든 뒤 7일 cutoff 직전에는 남고 cutoff에 지워지며 진행 중 건은 남는다', async () => {
  const s = await changeSetup();
  try {
    const done = await ended(s.store);
    const live = await driveTo(s.store, 'authoring');
    const endedAt = s.clock.now;
    const before = await inputRows(s.db, done.id);
    assert.equal(await purgeExpiredChangeContent(s.db, endedAt + CHANGE_RETENTION_MS - 1), 0, 'cutoff 1ms 전');
    assert.deepEqual(await inputRows(s.db, done.id), before);
    assert.equal(await purgeExpiredChangeContent(s.db, endedAt + CHANGE_RETENTION_MS), 1, 'cutoff 시각');
    const after = await inputRows(s.db, done.id);
    assert.deepEqual(after.map(i => [i.text, i.text_sha256]), [['', before[0]!.text_sha256]]);
    // 진행 중 건은 오래 지나도 원문을 읽어야 하므로 남는다.
    assert.equal(await purgeExpiredChangeContent(s.db, endedAt + 30 * DAY), 0);
    assert.equal((await inputRows(s.db, live.id))[0]!.text, '공개 요청문');
    // 두 번째 정리는 고를 것이 없고 지운 시각도 그대로다(멱등).
    assert.equal(await purgeExpiredChangeContent(s.db, endedAt + 31 * DAY), 0);
    assert.deepEqual(await inputRows(s.db, done.id), after);
  } finally { await s.close(); }
});

test('CHANGE 요청 원문: 복원으로 옛 행이 돌아오면 다음 정리가 다시 지운다. artifact를 이미 비운 건도 고른다', async () => {
  const s = await changeSetup();
  try {
    const done = await ended(s.store);
    const endedAt = s.clock.now;
    assert.equal(await purgeExpiredChangeContent(s.db, endedAt + 8 * DAY), 1);
    const purged = await inputRows(s.db, done.id);
    // 백업 시점의 행으로 되돌린다. artifact는 비운 채다.
    await s.db.query(`UPDATE change_request_inputs SET text='공개 요청문',purged_at=NULL WHERE change_id=$1`, [done.id]);
    assert.equal((await s.db.query('SELECT 1 FROM change_artifacts WHERE change_id=$1 AND purged_at IS NULL', [done.id])).rows.length, 0);
    assert.equal(await purgeExpiredChangeContent(s.db, endedAt + 9 * DAY), 1);
    const again = await inputRows(s.db, done.id);
    assert.deepEqual(again.map(i => [i.text, i.text_sha256]), purged.map(i => [i.text, i.text_sha256]));
    // 행을 지우고 다시 넣는 복원도 같다.
    await s.db.query('DELETE FROM change_request_inputs WHERE change_id=$1', [done.id]);
    await s.db.query(`INSERT INTO change_request_inputs(event_id,change_id,generation,label,text,text_sha256,created_at) VALUES ($1,$2,1,'public','공개 요청문',$3,$4)`,
      [done.eventId, done.id, sha('공개 요청문'), endedAt]);
    assert.equal(await purgeExpiredChangeContent(s.db, endedAt + 10 * DAY), 1);
    assert.equal((await inputRows(s.db, done.id))[0]!.text, '');
  } finally { await s.close(); }
});

test('CHANGE 요청 원문: 지운 superseded 건은 새 generation을 열지 않고 사유를 돌려준다. 지우기 전에는 연다', async () => {
  const s = await changeSetup();
  try {
    const kept = await ended(s.store, 'snapshot_ready', 'superseded');
    const gone = await ended(s.store, 'snapshot_ready', 'superseded');
    const endedAt = s.clock.now;
    // kept는 정리 전에 다시 연다. 열린 건은 requested라 정리가 고르지 않는다.
    const opened = ok(await s.store.startNextGeneration({ changeId: kept.id, generation: 1 }));
    assert.equal(opened.phase, 'requested');
    assert.equal(await purgeExpiredChangeContent(s.db, endedAt + 8 * DAY), 1);
    assert.equal((await inputRows(s.db, kept.id))[0]!.text, '공개 요청문');
    failure(await s.store.startNextGeneration({ changeId: gone.id, generation: 1 }), 'input_purged');
    assert.equal(ok(await s.store.get(gone.id)).phase, 'superseded');
    assert.equal(await ChangePrivateInputs.purgedIn(s.db, kept.id), false);
  } finally { await s.close(); }
});

// 작업 레인 질문 하나를 job 상태와 세션 상태를 정해 바로 만든다. 끝난 시각은 finished_at이다.
async function seedQuestion(db: Database, id: string, opts: { jobState: string; finishedAt: number | null; answeredAt: number; session?: { state: string; cleanup?: string }; text?: string }) {
  await db.query(`INSERT INTO events(id,provider,delivery_id,semantic_key,actor_id,scope,received_at,payload,accepted)
    VALUES ($1,'fixture',$1,$1,$2,'{}'::jsonb,1,'{}'::jsonb,true)`, [`event-${id}`, OWNER]);
  await db.query(`INSERT INTO jobs(id,event_id,conversation_id,type,owner_id,target,revision,budget,state,priority,available_at,created_at,finished_at)
    VALUES ($1,$2,$3,'task',$4,'{}'::jsonb,'{}'::jsonb,'{}'::jsonb,$5,1,1,1,$6)`, [id, `event-${id}`, CONVERSATION, OWNER, opts.jobState, opts.finishedAt]);
  if (opts.session) await db.query(`INSERT INTO codex_sessions(job_id,thread_id,turn,tool_calls,host,capabilities,state,created_at,updated_at,cleanup_state)
    VALUES ($1,'thread',1,0,'worker','{}',$2,1,1,$3)`, [id, opts.session.state, opts.session.cleanup ?? 'none']);
  const question = `${id}:thread:1`;
  await db.query(`INSERT INTO codex_questions(id,job_id,conversation_id,thread_id,turn,kind,responder_id,prompt,state,created_at,expires_at,answer,answered_by,answer_event,answered_at)
    VALUES ($1,$2,$3,'thread',1,'clarification',$4,'질문',$5,1,2,$6,$4,$7,$8)`,
  [question, id, CONVERSATION, OWNER, opts.jobState === 'queued' ? 'answered' : 'resumed', opts.text ?? `답 원문 ${id}`, `answer-${id}`, opts.answeredAt]);
  return question;
}

test('질문 답: 작업이 끝난 뒤 7일 cutoff 직전에는 남고 cutoff에 지워진다. 두 번 정리해도 같고 복원된 행은 다시 지운다', async () => {
  const { db, pg: engine } = await localDatabase();
  try {
    await seedConversation(db);
    const T = 1_800_000_000_000;
    const q = await seedQuestion(db, 'done', { jobState: 'succeeded', finishedAt: T, answeredAt: T - DAY, session: { state: 'completed', cleanup: 'cleaned' }, text: '한글 답 원문 ✓' });
    assert.equal(await purgeExpiredTaskAnswers(db, T + TASK_ANSWER_RETENTION_MS - 1), 0, 'cutoff 1ms 전');
    assert.equal((await questionRow(db, q)).answer, '한글 답 원문 ✓');
    assert.equal(await purgeExpiredTaskAnswers(db, T + TASK_ANSWER_RETENTION_MS), 1, 'cutoff 시각');
    const purged = await questionRow(db, q);
    assert.equal(purged.answer, null);
    assert.equal(purged.answer_sha256, sha('한글 답 원문 ✓'), 'DB가 계산한 digest가 UTF-8 바이트 기준이다');
    assert.equal(purged.answer_event, 'answer-done');
    assert.equal(await purgeExpiredTaskAnswers(db, T + 20 * DAY), 0, '멱등');
    assert.deepEqual(await questionRow(db, q), purged);
    // 백업 시점의 행(digest·지운 시각 없음)으로 되돌린다.
    await db.query(`UPDATE codex_questions SET answer='한글 답 원문 ✓',answer_sha256=NULL,answer_purged_at=NULL WHERE id=$1`, [q]);
    assert.equal(await purgeExpiredTaskAnswers(db, T + 21 * DAY), 1);
    const again = await questionRow(db, q);
    assert.equal(again.answer, null);
    assert.equal(again.answer_sha256, purged.answer_sha256);
  } finally { await engine.close(); }
});

test('질문 답: 진행 중·대기·unknown 작업과 재개할 수 있는 세션·정리 전 세션의 답은 오래돼도 남는다', async () => {
  const { db, pg: engine } = await localDatabase();
  try {
    await seedConversation(db);
    const T = 1_800_000_000_000;
    const held = [
      await seedQuestion(db, 'queued', { jobState: 'queued', finishedAt: null, answeredAt: T }),
      await seedQuestion(db, 'running', { jobState: 'running', finishedAt: null, answeredAt: T, session: { state: 'running' } }),
      await seedQuestion(db, 'waiting', { jobState: 'waiting_user', finishedAt: T, answeredAt: T, session: { state: 'waiting_model' } }),
      await seedQuestion(db, 'unknown', { jobState: 'unknown', finishedAt: null, answeredAt: T, session: { state: 'unknown' } }),
      // /retry가 되살릴 수 있는 failed가 대기 세션을 가지면 재개가 답을 읽는다.
      await seedQuestion(db, 'retryable', { jobState: 'failed', finishedAt: T, answeredAt: T, session: { state: 'waiting_answer' } }),
      await seedQuestion(db, 'session-unknown', { jobState: 'failed', finishedAt: T, answeredAt: T, session: { state: 'unknown' } }),
      await seedQuestion(db, 'cleanup', { jobState: 'cancelled', finishedAt: T, answeredAt: T, session: { state: 'cancelled', cleanup: 'pending' } }),
    ];
    const gone = [
      await seedQuestion(db, 'failed', { jobState: 'failed', finishedAt: T, answeredAt: T, session: { state: 'failed', cleanup: 'cleaned' } }),
      await seedQuestion(db, 'no-session', { jobState: 'cancelled', finishedAt: null, answeredAt: T }),
    ];
    assert.equal(await purgeExpiredTaskAnswers(db, T + 30 * DAY), gone.length);
    for (const id of held) assert.notEqual((await questionRow(db, id)).answer, null, id);
    for (const id of gone) assert.equal((await questionRow(db, id)).answer, null, id);
  } finally { await engine.close(); }
});

// ---- 실제 PostgreSQL ----

const socket = process.env.HOMELAB_TEST_PG_SOCKET;
const skip = socket ? false : 'HOMELAB_TEST_PG_SOCKET 없음(로컬 PostgreSQL 필요)';
async function emptyDatabase() {
  const admin = new pg.Pool({ host: socket, user: 'postgres', database: 'postgres', max: 1 });
  const name = `t27_${randomUUID().replaceAll('-', '').slice(0, 12)}`;
  await admin.query(`CREATE DATABASE ${name}`);
  const raw = new pg.Pool({ host: socket, user: 'postgres', database: name, max: 4 });
  return { raw, close: async () => { await raw.end(); await admin.query(`DROP DATABASE ${name}`); await admin.end(); } };
}

test('실제 PostgreSQL: 018까지의 DB에 남은 옛 원문도 019 적용 뒤 8일 정리에서 지워지고, 복원 뒤 다시 지워진다', { skip }, async () => {
  const d = await emptyDatabase();
  try {
    // 옛 코드가 쓰던 스키마(018)에 행을 만든 뒤 019를 적용한다. 배포 순서와 같다.
    for (const file of MIGRATIONS.filter(name => migrationVersion(name) <= 18)) await d.raw.query(await readFile(`migrations/${file}`, 'utf8'));
    const db = new Postgres(d.raw);
    await seedConversation(db);
    const clock = { now: 1_800_000_000_000 };
    const store = new ChangeStore(db, () => clock.now);
    const done = await ended(store);
    const live = await driveTo(store, 'authoring');
    const T = clock.now;
    const answered = await seedQuestion(db, 'pg-done', { jobState: 'succeeded', finishedAt: T, answeredAt: T, session: { state: 'completed' }, text: '실제 PG 답 원문 ✓' });
    const waiting = await seedQuestion(db, 'pg-wait', { jobState: 'waiting_user', finishedAt: T, answeredAt: T, session: { state: 'waiting_answer' } });
    assert.deepEqual(await runMigrations(d.raw), [19, 20, 21, 22, 23, 24]);

    assert.equal(await purgeExpiredChangeContent(db, T + 8 * DAY), 1);
    assert.equal(await purgeExpiredTaskAnswers(db, T + 8 * DAY), 1);
    assert.equal((await inputRows(db, done.id))[0]!.text, '');
    assert.equal((await inputRows(db, live.id))[0]!.text, '공개 요청문');
    const row = await questionRow(db, answered);
    assert.equal(row.answer, null);
    assert.equal(row.answer_sha256, sha('실제 PG 답 원문 ✓'));
    assert.notEqual((await questionRow(db, waiting)).answer, null);
    assert.equal(await purgeExpiredChangeContent(db, T + 8 * DAY), 0);
    assert.equal(await purgeExpiredTaskAnswers(db, T + 8 * DAY), 0);

    // 복원: 지우기 전 값으로 되돌린 뒤 다음 정리.
    await d.raw.query(`UPDATE change_request_inputs SET text='공개 요청문',purged_at=NULL WHERE change_id=$1`, [done.id]);
    await d.raw.query(`UPDATE codex_questions SET answer='실제 PG 답 원문 ✓',answer_sha256=NULL,answer_purged_at=NULL WHERE id=$1`, [answered]);
    assert.equal(await purgeExpiredChangeContent(db, T + 9 * DAY), 1);
    assert.equal(await purgeExpiredTaskAnswers(db, T + 9 * DAY), 1);
    const leftovers = (await d.raw.query(`SELECT (SELECT count(*) FROM change_request_inputs WHERE change_id=$1 AND text<>'')::int AS inputs,
      (SELECT count(*) FROM codex_questions WHERE id=$2 AND answer IS NOT NULL)::int AS answers`, [done.id, answered])).rows[0];
    assert.deepEqual(leftovers, { inputs: 0, answers: 0 });
  } finally { await d.close(); }
});
