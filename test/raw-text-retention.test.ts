import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import pg from 'pg';
import { CHANGE_PURGE_BATCH, CHANGE_RETENTION_MS, ChangeStore, purgeExpiredChangeContent, purgeExpiredChangeContentRounds } from '../src/change-store.js';
import type { ChangeRequest } from '../src/change-store.js';
import { DEFAULTS } from '../src/contracts.js';
import type { Answer } from '../src/contracts.js';
import type { Database } from '../src/database.js';
import { MIGRATIONS, Postgres, migrationVersion } from '../src/database.js';
import { runMigrations } from '../src/migrate-main.js';
import {
  RAW_TEXT_PURGE_BATCH, RAW_TEXT_RETENTION_MS, purgeExpiredEventText, purgeExpiredOutboxContent, purgeExpiredQuestionPrompts, purgeExpiredRawText, purgeExpiredResults,
} from '../src/raw-text-retention.js';
import { purgeExpiredTaskAnswers } from '../src/task-bridge.js';
import { taskQuestionId } from '../src/task-contracts.js';
import { CONVERSATION, OWNER, driveTo, failure, ok, seedConversation } from './change-store-fixture.js';
import { event, fixture, localDatabase, thread } from './helpers.js';
import { answer, lane, reply, task } from './task-lane-fixture.js';

// 정리 경로가 없던 원문 칸 다섯 개의 7일 보존(DECISIONS T31).
const DAY = 86_400_000;
const T = 1_800_000_000_000;
const FINAL = ['succeeded', 'failed', 'cancelled', 'superseded'];
const OPEN = ['queued', 'running', 'waiting_user', 'verifying', 'cancel_requested', 'unknown'];
const sha = (text: string) => createHash('sha256').update(text, 'utf8').digest('hex');

async function setup() {
  const { db, pg: engine } = await localDatabase();
  await seedConversation(db);
  return { db, close: () => engine.close() };
}
// event 하나와(job을 주면) 그 job·세션·질문·결과를 바로 만든다.
async function seed(db: Database, id: string, opts: {
  receivedAt?: number; payload?: Record<string, unknown>; buffered?: boolean;
  job?: { state: string; finishedAt?: number | null; session?: { state: string; cleanup?: string }; prompt?: string; result?: unknown };
} = {}) {
  const eventId = `event-${id}`;
  const payload = opts.payload ?? { text: `요청 원문 ${id}`, command: 'task', target: 'fixture-project', kind: 'command', mention: true };
  await db.query(`INSERT INTO events(id,provider,delivery_id,semantic_key,actor_id,scope,received_at,payload,accepted,buffered)
    VALUES ($1,'fixture',$1,$2,$3,'{}'::jsonb,$4,$5,true,$6)`, [eventId, `semantic-${id}`, OWNER, opts.receivedAt ?? T, JSON.stringify(payload), opts.buffered ?? false]);
  const job = opts.job;
  if (!job) return { eventId };
  await db.query(`INSERT INTO jobs(id,event_id,conversation_id,type,owner_id,target,revision,budget,state,priority,available_at,created_at,finished_at)
    VALUES ($1,$2,$3,'task',$4,'{}'::jsonb,'{}'::jsonb,'{}'::jsonb,$5,1,1,1,$6)`, [id, eventId, CONVERSATION, OWNER, job.state, job.finishedAt === undefined ? T : job.finishedAt]);
  if (job.session) await db.query(`INSERT INTO codex_sessions(job_id,thread_id,turn,tool_calls,host,capabilities,state,created_at,updated_at,cleanup_state)
    VALUES ($1,'thread',1,0,'worker','{}',$2,1,1,$3)`, [id, job.session.state, job.session.cleanup ?? 'none']);
  const question = `${id}:thread:1`;
  await db.query(`INSERT INTO codex_questions(id,job_id,conversation_id,thread_id,turn,kind,responder_id,prompt,state,created_at,expires_at)
    VALUES ($1,$2,$3,'thread',1,'clarification',$4,$5,'expired',1,2)`, [question, id, CONVERSATION, OWNER, job.prompt ?? `모델 질문 ${id}`]);
  if (job.state === 'succeeded' || job.result !== undefined) await db.query(`INSERT INTO results VALUES ($1,$2,$3,'internal',$4)`,
    [id, JSON.stringify(job.result ?? { summary: `완료 요약 ${id}` }), JSON.stringify({ source: 'task_worker', resultDigest: 'd'.repeat(64) }), T]);
  return { eventId, question };
}
async function outbox(db: Database, id: string, opts: { state: string; at: number; kind?: string; content?: string }) {
  await db.query(`INSERT INTO outbox(id,owner_id,scope,policy_revision,idempotency_key,payload,state,available_at,created_at,message_key,page_index,external_id)
    VALUES ($1,$2,'{}'::jsonb,'fixture-v1',$1,$3,$4,$5,1,$1,0,$6)`, [id, OWNER,
    JSON.stringify({ kind: opts.kind ?? 'message', channel: 'fixture-thread', content: opts.content ?? `게시 본문 ${id}`, classification: 'safe_summary' }),
    opts.state, opts.at, opts.state === 'sent' ? '1234' : null]);
}
const eventRow = async (db: Database, eventId: string) => (await db.query<{ payload: Record<string, unknown>; semantic_key: string; text_sha256: string | null; text_purged_at: string | null }>(
  'SELECT payload,semantic_key,text_sha256,text_purged_at FROM events WHERE id=$1', [eventId])).rows[0]!;
const promptRow = async (db: Database, id: string) => (await db.query<{ prompt: string; prompt_sha256: string | null; prompt_purged_at: string | null; state: string }>(
  'SELECT prompt,prompt_sha256,prompt_purged_at,state FROM codex_questions WHERE id=$1', [id])).rows[0]!;
const resultRow = async (db: Database, id: string) => (await db.query<{ result: unknown; evidence: { resultDigest: string }; result_sha256: string | null; result_purged_at: string | null }>(
  'SELECT result,evidence,result_sha256,result_purged_at FROM results WHERE job_id=$1', [id])).rows[0]!;
const outboxRow = async (db: Database, id: string) => (await db.query<{ payload: Record<string, unknown>; state: string; external_id: string | null; content_sha256: string | null; content_purged_at: string | null }>(
  'SELECT payload,state,external_id,content_sha256,content_purged_at FROM outbox WHERE id=$1', [id])).rows[0]!;

// ---- events.payload.text ----

test('입력 원문: 받은 뒤 7일 cutoff 직전에는 남고 cutoff에 원문만 비운다. 행·semantic_key·다른 칸·digest가 남고 멱등이며 복원된 행은 다시 지운다', async () => {
  const s = await setup();
  try {
    const { eventId } = await seed(s.db, 'done', { job: { state: 'succeeded' }, payload: { text: '한글 요청 원문 ✓', command: 'task', target: 'p', kind: 'command' } });
    assert.equal(await purgeExpiredEventText(s.db, T + RAW_TEXT_RETENTION_MS - 1), 0, 'cutoff 1ms 전');
    assert.equal((await eventRow(s.db, eventId)).payload.text, '한글 요청 원문 ✓');
    assert.equal(await purgeExpiredEventText(s.db, T + RAW_TEXT_RETENTION_MS), 1, 'cutoff 시각');
    const purged = await eventRow(s.db, eventId);
    assert.deepEqual(purged.payload, { text: '', command: 'task', target: 'p', kind: 'command' });
    assert.equal(purged.semantic_key, 'semantic-done');
    assert.equal(purged.text_sha256, sha('한글 요청 원문 ✓'), 'DB가 계산한 digest가 UTF-8 바이트 기준이다');
    assert.equal(Number(purged.text_purged_at), T + RAW_TEXT_RETENTION_MS);
    assert.equal(await purgeExpiredEventText(s.db, T + 20 * DAY), 0, '멱등');
    assert.deepEqual(await eventRow(s.db, eventId), purged);
    // 백업 시점의 행(digest·지운 시각 없음)으로 되돌린다.
    await s.db.query(`UPDATE events SET payload=jsonb_set(payload,'{text}','"한글 요청 원문 ✓"'),text_sha256=NULL,text_purged_at=NULL WHERE id=$1`, [eventId]);
    assert.equal(await purgeExpiredEventText(s.db, T + 21 * DAY), 1);
    assert.equal((await eventRow(s.db, eventId)).text_sha256, purged.text_sha256);
  } finally { await s.close(); }
});

test('입력 원문: 끝나지 않은 job, 누락 복구 버퍼, 확정 전 스레드 게시가 가리키는 원문은 오래돼도 남는다. 빈 원문과 text 없는 행은 고르지 않는다', async () => {
  const s = await setup();
  try {
    const held: string[] = [];
    const gone: string[] = [];
    for (const state of OPEN) held.push((await seed(s.db, `open-${state}`, { job: { state, finishedAt: null } })).eventId);
    for (const state of FINAL) gone.push((await seed(s.db, `final-${state}`, { job: { state } })).eventId);
    gone.push((await seed(s.db, 'chat-without-job')).eventId);
    held.push((await seed(s.db, 'buffered', { buffered: true })).eventId);
    // 스레드 게시가 확정되면 그 event의 원문으로 job을 만들거나 경보 요약을 게시한다.
    for (const state of ['pending', 'sending', 'unknown']) {
      const { eventId } = await seed(s.db, `thread-${state}`);
      await outbox(s.db, `thread-out-${state}`, { state, at: T, kind: 'thread', content: eventId });
      held.push(eventId);
    }
    for (const state of ['sent', 'blocked']) {
      const { eventId } = await seed(s.db, `thread-${state}`);
      await outbox(s.db, `thread-out-${state}`, { state, at: T, kind: 'thread', content: eventId });
      gone.push(eventId);
    }
    // CHANGE /answer(sealsAnswer)는 빈 원문으로 저장되고, 리뷰 이벤트에는 text가 없다.
    await seed(s.db, 'sealed', { payload: { text: '', command: 'answer', target: 'q', kind: 'command' } });
    await seed(s.db, 'review', { payload: { command: 'review', trigger: 'comment' } });

    assert.equal(await purgeExpiredEventText(s.db, T + 30 * DAY), gone.length);
    for (const id of held) assert.notEqual((await eventRow(s.db, id)).payload.text, '', id);
    for (const id of gone) assert.equal((await eventRow(s.db, id)).payload.text, '', id);
    assert.equal((await eventRow(s.db, 'event-sealed')).text_purged_at, null);
    assert.deepEqual((await eventRow(s.db, 'event-review')).payload, { command: 'review', trigger: 'comment' });
  } finally { await s.close(); }
});

test('입력 원문: 원문을 비운 실패 작업은 /retry가 다시 돌리지 않고 사유를 알린다. 비우기 전 작업은 그대로 재시도된다', async () => {
  const { db, pg: engine } = await localDatabase();
  try {
    const f = await fixture(db);
    const conversation = f.store.scopeId(thread);
    const old = await f.store.save(event('retry-old', { text: '오래된 요청 원문' }), f.policy.revision, true);
    const oldJob = await f.store.accept(old.id, 'chat', f.policy.revision);
    f.advance(2 * DAY);
    const fresh = await f.store.save(event('retry-fresh', { text: '최근 요청 원문' }), f.policy.revision, true);
    const freshJob = await f.store.accept(fresh.id, 'chat', f.policy.revision);
    await db.query(`UPDATE jobs SET state='failed',attempt=1,finished_at=$1`, [f.now()]);
    f.advance(6 * DAY);
    assert.equal(await purgeExpiredEventText(db, f.now()), 1);

    const refused = await f.store.control(f.policy.owner, conversation, 'retry', oldJob) as { ok?: boolean; status: string };
    assert.equal(refused.ok, false);
    assert.match(refused.status, /보존 기간\(7일\)이 지나 요청 원문을 지워/);
    assert.equal((await db.query<{ state: string }>('SELECT state FROM jobs WHERE id=$1', [oldJob])).rows[0]!.state, 'failed');
    assert.notEqual(((await f.store.control(f.policy.owner, conversation, 'retry', freshJob)) as { ok?: boolean }).ok, false);
    assert.equal((await db.query<{ state: string }>('SELECT state FROM jobs WHERE id=$1', [freshJob])).rows[0]!.state, 'queued');
    // 되살린 작업의 원문은 다시 진행 중이라 정리가 고르지 않는다.
    f.advance(DAY);
    assert.equal(await purgeExpiredEventText(db, f.now()), 0);
    assert.equal((await eventRow(db, fresh.id)).payload.text, '최근 요청 원문');
  } finally { await engine.close(); }
});

test('입력 원문: 비운 행도 중복 판정에 그대로 쓰이고, 받지 못한 채 비운 입력이 다시 오면 빈 원문으로 처리하지 않는다', async () => {
  const { db, pg: engine } = await localDatabase();
  try {
    const f = await fixture(db);
    // 처리된 입력: 같은 메시지가 다시 와도 새 행·새 job을 만들지 않는다.
    await f.ingress.receive(event('dup-1', { text: '처리된 요청' }));
    const before = (await db.query('SELECT id FROM jobs')).rows.length;
    assert.equal(before, 1);
    // 저장만 되고 받지 못한 입력(처리 중 종료 등).
    const pending = await f.store.save(event('lost-1', { text: '받지 못한 요청' }), f.policy.revision, true);
    await db.query(`UPDATE jobs SET state='succeeded',finished_at=$1`, [f.now()]);
    f.advance(8 * DAY);
    assert.equal(await purgeExpiredEventText(db, f.now()), 2);

    await f.ingress.receive(event('dup-1', { text: '처리된 요청' }));
    assert.equal((await db.query(`SELECT 1 FROM events WHERE delivery_id='dup-1'`)).rows.length, 1);
    await f.ingress.receive(event('lost-1', { text: '받지 못한 요청' }));
    assert.equal((await db.query('SELECT id FROM jobs')).rows.length, before, '비운 입력으로 job을 만들지 않는다');
    const lost = await eventRow(db, pending.id);
    assert.equal(lost.payload.text, '');
    assert.equal(lost.payload.ignored, 'text_purged');
    assert.equal((await db.query<{ accepted: boolean }>('SELECT accepted FROM events WHERE id=$1', [pending.id])).rows[0]!.accepted, false);
  } finally { await engine.close(); }
});

test('대화 맥락: 원문을 비운 owner 메시지와 본문을 비운 봇 답은 빈 말로 넣지 않고 뺀다', async () => {
  const { db, pg: engine } = await localDatabase();
  try {
    const f = await fixture(db);
    let next = 5000n;
    const send = f.rest.sendMessage.bind(f.rest);
    f.rest.sendMessage = async (channel, body) => {
      const sent = await send(channel, body);
      const id = String(next++);
      f.rest.messages.at(-1)!.id = id;
      return { ...sent, id };
    };
    const empty: Answer = { facts: [], hypotheses: [], unknowns: [], checks: [] };
    const exchange = async (id: string, text: string, facts: string[]) => {
      f.setRun(async () => ({ status: 'succeeded', stopped: true, answer: { ...empty, facts } }));
      await f.ingress.receive(event(id, { text }));
      f.advance(DEFAULTS.debounceMs); await f.runtime.tick();
      while (await f.publisher.deliver()) { /* 모든 페이지 */ }
    };
    await exchange('4000', '옛 질문', ['옛 답']);
    f.advance(8 * DAY);
    const purged = await purgeExpiredRawText(db, f.now());
    assert.equal(purged.events, 1);
    assert.ok(purged.outbox >= 1);
    await exchange('9000', '새 질문', ['새 답']);
    const request = f.requests.at(-1)!.untrusted as { from: string; text: string }[];
    assert.deepEqual(request.map(item => `${item.from}:${item.text}`), ['owner:새 질문']);
  } finally { await engine.close(); }
});

test('작업 재개: 받은 지 7일이 지나도 답을 기다리는 작업의 요청·질문은 남아 답하면 이어서 끝나고, 끝난 뒤 7일에 요청·질문·결과·답이 모두 비워진다', async () => {
  const { db, pg: engine } = await localDatabase();
  try {
    const f = await fixture(db);
    const setup = lane(f);
    setup.worker.scripts.push(reply.question('Synthetic retention question'));
    const j = await task(f, db, 'resume-task', 'synthetic-request-marker 고쳐줘');
    await setup.runtime.tickTask();
    assert.equal((await db.query<{ state: string }>('SELECT state FROM jobs WHERE id=$1', [j.id])).rows[0]!.state, 'waiting_user');
    // 질문 만료(시계)와 떼어 놓으려고 받은 시각만 8일 전으로 옮긴다. 질문 게시 본문은 아직 보내지 않았다.
    await db.query('UPDATE events SET received_at=received_at-$2 WHERE id=$1', [j.event_id, 8 * DAY]);
    assert.deepEqual(await purgeExpiredRawText(db, f.now()), { events: 0, prompts: 0, results: 0, outbox: 0 });
    const s = (await db.query<{ claude_session_id: string }>('SELECT claude_session_id FROM codex_sessions WHERE job_id=$1', [j.id])).rows[0]!;
    const q = taskQuestionId(j.id, s.claude_session_id, 1);
    assert.equal((await promptRow(db, q)).prompt, 'Synthetic retention question');
    assert.equal((await answer(setup.bridge, q, 'synthetic-answer-marker', 'resume-answer')).ok, true);
    setup.worker.scripts.push(reply.completed('synthetic-summary-marker'));
    await setup.runtime.tickTask();
    assert.equal((await db.query<{ state: string }>('SELECT state FROM jobs WHERE id=$1', [j.id])).rows[0]!.state, 'succeeded');
    assert.equal(setup.worker.executes.at(-1)!.operation, 'resume');
    // 끝난 직후: 요청은 받은 지 8일이 지났으므로 지금 비워지고, 질문·결과는 끝난 뒤 7일을 기다린다.
    assert.equal(await purgeExpiredEventText(db, f.now()), 1);
    assert.equal(await purgeExpiredQuestionPrompts(db, f.now()), 0);
    assert.equal(await purgeExpiredResults(db, f.now()), 0);
    while (await f.publisher.deliver()) { /* 게시 */ }
    f.advance(8 * DAY);
    const later = await purgeExpiredRawText(db, f.now());
    assert.equal(later.prompts, 1);
    assert.equal(later.results, 1);
    assert.ok(later.outbox >= 1);
    assert.equal(await purgeExpiredTaskAnswers(db, f.now()), 1);
    const dump = JSON.stringify([(await db.query('SELECT * FROM events')).rows, (await db.query('SELECT * FROM codex_questions')).rows,
      (await db.query('SELECT * FROM results')).rows, (await db.query("SELECT * FROM outbox WHERE state IN ('sent','blocked')")).rows]);
    for (const marker of ['synthetic-request-marker', 'Synthetic retention question', 'synthetic-answer-marker', 'synthetic-summary-marker']) assert.equal(dump.includes(marker), false, marker);
  } finally { await engine.close(); }
});

// ---- codex_questions.prompt, results.result ----

test('모델 질문·결과: 작업이 끝난 뒤 7일 cutoff 직전에는 남고 cutoff에 비운다. digest·evidence가 남고 멱등이며 복원된 행은 다시 지운다', async () => {
  const s = await setup();
  try {
    const { question } = await seed(s.db, 'done', { job: { state: 'succeeded', session: { state: 'completed', cleanup: 'cleaned' }, prompt: '한글 질문 ✓', result: { summary: '한글 요약 ✓', changes: [] } } });
    const resultText = (await s.db.query<{ t: string }>(`SELECT result::text AS t FROM results WHERE job_id='done'`)).rows[0]!.t;
    assert.equal(await purgeExpiredQuestionPrompts(s.db, T + RAW_TEXT_RETENTION_MS - 1), 0, 'cutoff 1ms 전');
    assert.equal(await purgeExpiredResults(s.db, T + RAW_TEXT_RETENTION_MS - 1), 0, 'cutoff 1ms 전');
    assert.equal(await purgeExpiredQuestionPrompts(s.db, T + RAW_TEXT_RETENTION_MS), 1, 'cutoff 시각');
    assert.equal(await purgeExpiredResults(s.db, T + RAW_TEXT_RETENTION_MS), 1, 'cutoff 시각');
    const prompt = await promptRow(s.db, question!);
    assert.deepEqual([prompt.prompt, prompt.prompt_sha256, Number(prompt.prompt_purged_at), prompt.state], ['', sha('한글 질문 ✓'), T + RAW_TEXT_RETENTION_MS, 'expired']);
    const result = await resultRow(s.db, 'done');
    assert.deepEqual(result.result, {});
    assert.equal(result.result_sha256, sha(resultText));
    assert.equal(result.evidence.resultDigest, 'd'.repeat(64));
    assert.equal(await purgeExpiredQuestionPrompts(s.db, T + 20 * DAY), 0, '멱등');
    assert.equal(await purgeExpiredResults(s.db, T + 20 * DAY), 0, '멱등');
    await s.db.query(`UPDATE codex_questions SET prompt='한글 질문 ✓',prompt_sha256=NULL,prompt_purged_at=NULL WHERE id=$1`, [question]);
    await s.db.query(`UPDATE results SET result=$1::jsonb,result_sha256=NULL,result_purged_at=NULL WHERE job_id='done'`, [resultText]);
    assert.equal(await purgeExpiredQuestionPrompts(s.db, T + 21 * DAY), 1);
    assert.equal(await purgeExpiredResults(s.db, T + 21 * DAY), 1);
    assert.equal((await promptRow(s.db, question!)).prompt_sha256, prompt.prompt_sha256);
    assert.equal((await resultRow(s.db, 'done')).result_sha256, result.result_sha256);
  } finally { await s.close(); }
});

test('C28 변경 질문 선택지: 질문과 같은 7일 기준으로 선택지를 비우고 digest를 남긴다. 끝나지 않은 작업의 선택지와 선택지 없는 질문은 그대로다', async () => {
  const s = await setup();
  try {
    const options = ['src 설정을 고친다 ✓', 'README만 고친다'];
    const done = await seed(s.db, 'done', { job: { state: 'succeeded', session: { state: 'completed', cleanup: 'cleaned' } } });
    const waiting = await seed(s.db, 'waiting', { job: { state: 'waiting_user', finishedAt: null, session: { state: 'waiting_answer' } } });
    const plain = await seed(s.db, 'plain', { job: { state: 'succeeded', session: { state: 'completed', cleanup: 'cleaned' } } });
    for (const row of [done, waiting]) await s.db.query('UPDATE codex_questions SET options=$2::jsonb WHERE id=$1', [row.question, JSON.stringify(options)]);
    const optionsRow = async (question: string) => (await s.db.query<{ options: string[] | null; options_sha256: string | null }>(
      'SELECT options,options_sha256 FROM codex_questions WHERE id=$1', [question])).rows[0]!;
    assert.equal(await purgeExpiredQuestionPrompts(s.db, T + RAW_TEXT_RETENTION_MS - 1), 0, 'cutoff 1ms 전');
    assert.deepEqual((await optionsRow(done.question!)).options, options);
    assert.equal(await purgeExpiredQuestionPrompts(s.db, T + 30 * DAY), 2);
    // digest는 지울 때 DB가 jsonb의 text 표현에서 계산한다.
    assert.deepEqual(await optionsRow(done.question!), { options: null, options_sha256: sha('["src 설정을 고친다 ✓", "README만 고친다"]') });
    assert.deepEqual(await optionsRow(plain.question!), { options: null, options_sha256: null }, '선택지 없는 질문은 digest도 없다');
    assert.deepEqual(await optionsRow(waiting.question!), { options, options_sha256: null }, '답을 기다리는 작업의 선택지는 남는다');
  } finally { await s.close(); }
});

test('모델 질문·결과: 끝나지 않은 작업과 재개·마무리가 아직 다루는 세션의 행은 오래돼도 남는다(T27 질문 답과 같은 조건)', async () => {
  const s = await setup();
  try {
    const held = [];
    for (const state of OPEN) held.push(await seed(s.db, `open-${state}`, { job: { state, finishedAt: null, result: { summary: 'x' } } }));
    held.push(await seed(s.db, 'retryable', { job: { state: 'failed', session: { state: 'waiting_answer' }, result: { summary: 'x' } } }));
    held.push(await seed(s.db, 'session-unknown', { job: { state: 'failed', session: { state: 'unknown' }, result: { summary: 'x' } } }));
    held.push(await seed(s.db, 'cleanup', { job: { state: 'succeeded', session: { state: 'completed', cleanup: 'pending' } } }));
    const gone = [];
    for (const state of FINAL) gone.push(await seed(s.db, `final-${state}`, { job: { state, session: { state: 'failed', cleanup: 'cleaned' }, result: { summary: 'x' } } }));
    gone.push(await seed(s.db, 'no-session', { job: { state: 'cancelled', finishedAt: null, result: { summary: 'x' } } }));
    assert.equal(await purgeExpiredQuestionPrompts(s.db, T + 30 * DAY), gone.length);
    assert.equal(await purgeExpiredResults(s.db, T + 30 * DAY), gone.length);
    for (const row of held) {
      assert.notEqual((await promptRow(s.db, row.question!)).prompt, '', row.question);
      assert.notDeepEqual((await resultRow(s.db, row.question!.split(':')[0]!)).result, {}, row.question);
    }
    for (const row of gone) {
      assert.equal((await promptRow(s.db, row.question!)).prompt, '', row.question);
      assert.deepEqual((await resultRow(s.db, row.question!.split(':')[0]!)).result, {}, row.question);
    }
  } finally { await s.close(); }
});

// ---- outbox.payload.content ----

test('게시 본문: 보낸 뒤 7일 cutoff 직전에는 남고 cutoff에 본문만 비운다. 끝나지 않은 상태와 스레드 행은 남고 blocked는 지운다', async () => {
  const s = await setup();
  try {
    await outbox(s.db, 'sent', { state: 'sent', at: T, content: '한글 본문 ✓' });
    await outbox(s.db, 'blocked', { state: 'blocked', at: T });
    for (const state of ['pending', 'sending', 'unknown']) await outbox(s.db, state, { state, at: T });
    await outbox(s.db, 'thread', { state: 'sent', at: T, kind: 'thread', content: 'event-id-reference' });
    assert.equal(await purgeExpiredOutboxContent(s.db, T + RAW_TEXT_RETENTION_MS - 1), 0, 'cutoff 1ms 전');
    assert.equal(await purgeExpiredOutboxContent(s.db, T + RAW_TEXT_RETENTION_MS), 2, 'cutoff 시각');
    const sent = await outboxRow(s.db, 'sent');
    assert.deepEqual(sent.payload, { kind: 'message', channel: 'fixture-thread', content: '', classification: 'safe_summary' });
    assert.deepEqual([sent.state, sent.external_id, sent.content_sha256, Number(sent.content_purged_at)], ['sent', '1234', sha('한글 본문 ✓'), T + RAW_TEXT_RETENTION_MS]);
    assert.equal((await outboxRow(s.db, 'blocked')).payload.content, '');
    assert.equal(await purgeExpiredOutboxContent(s.db, T + 30 * DAY), 0, '끝나지 않은 상태와 스레드 행은 오래돼도 남는다');
    for (const id of ['pending', 'sending', 'unknown']) assert.equal((await outboxRow(s.db, id)).payload.content, `게시 본문 ${id}`, id);
    assert.equal((await outboxRow(s.db, 'thread')).payload.content, 'event-id-reference');
    // 복원.
    await s.db.query(`UPDATE outbox SET payload=jsonb_set(payload,'{content}','"한글 본문 ✓"'),content_sha256=NULL,content_purged_at=NULL WHERE id='sent'`);
    assert.equal(await purgeExpiredOutboxContent(s.db, T + 31 * DAY), 1);
    assert.equal((await outboxRow(s.db, 'sent')).content_sha256, sent.content_sha256);
  } finally { await s.close(); }
});

// ---- change_requests.brief ----

async function changeSetup() {
  const s = await setup();
  const clock = { now: T };
  return { ...s, clock, store: new ChangeStore(s.db, () => clock.now) };
}
async function ended(store: ChangeStore, to: 'cancelled' | 'superseded' = 'cancelled'): Promise<ChangeRequest> {
  const r = await driveTo(store, 'snapshot_ready');
  ok(await store.transition({ changeId: r.id, generation: 1, from: 'snapshot_ready', to, reason: to === 'cancelled' ? 'user_cancelled' : 'base_moved' }));
  return r;
}
const briefRow = async (db: Database, id: string) => (await db.query<{ brief: Record<string, unknown>; brief_digest: string; brief_purged_at: string | null; policy_revision: string }>(
  'SELECT brief,brief_digest,brief_purged_at,policy_revision FROM change_requests WHERE id=$1', [id])).rows[0]!;

test('변경 brief: 끝난 뒤 7일 cutoff 직전에는 남고 cutoff에 요청 글 세 칸만 비운다. digest·경로·명령은 남고 진행 중 건은 남는다', async () => {
  const s = await changeSetup();
  try {
    const done = await ended(s.store);
    const live = await driveTo(s.store, 'authoring');
    const before = await briefRow(s.db, done.id);
    assert.ok(String(before.brief.summary).length > 0);
    assert.equal(await purgeExpiredChangeContent(s.db, T + CHANGE_RETENTION_MS - 1), 0, 'cutoff 1ms 전');
    assert.deepEqual(await briefRow(s.db, done.id), before);
    assert.equal(await purgeExpiredChangeContent(s.db, T + CHANGE_RETENTION_MS), 1, 'cutoff 시각');
    const after = await briefRow(s.db, done.id);
    assert.deepEqual(after.brief, { ...before.brief, summary: '', goal: '', acceptanceCriteria: [] });
    assert.equal(after.brief_digest, before.brief_digest);
    assert.equal(after.policy_revision, before.policy_revision);
    assert.equal(Number(after.brief_purged_at), T + CHANGE_RETENTION_MS);
    assert.equal(ok(await s.store.get(done.id)).phase, 'cancelled');
    assert.equal(await purgeExpiredChangeContent(s.db, T + 30 * DAY), 0, '멱등, 진행 중 건은 고르지 않는다');
    assert.equal((await briefRow(s.db, live.id)).brief_purged_at, null);
  } finally { await s.close(); }
});

test('변경 brief: T27 정리로 artifact·요청 원문을 이미 비운 건도 brief를 비우러 다시 고른다. 비운 superseded 건은 새 generation을 열지 않는다', async () => {
  const s = await changeSetup();
  try {
    const done = await ended(s.store);
    const gone = await ended(s.store, 'superseded');
    // 020 이전 정리가 brief만 남긴 상태.
    await s.db.query(`UPDATE change_artifacts SET patch='',purged_at=$1`, [T + 8 * DAY]);
    await s.db.query(`UPDATE change_request_inputs SET text='',purged_at=$1`, [T + 8 * DAY]);
    await s.db.query('DELETE FROM change_artifact_files');
    assert.equal(await purgeExpiredChangeContent(s.db, T + 9 * DAY), 2);
    assert.notEqual((await briefRow(s.db, done.id)).brief_purged_at, null);
    failure(await s.store.startNextGeneration({ changeId: gone.id, generation: 1 }), 'input_purged');
    assert.equal(ok(await s.store.get(gone.id)).phase, 'superseded');
  } finally { await s.close(); }
});

// ---- 한 바퀴에 여러 쪽 ----

test('한 바퀴: 쪽 크기를 넘게 밀린 원문도 한 번의 정리 호출이 모두 비운다', async () => {
  const s = await changeSetup();
  try {
    const many = RAW_TEXT_PURGE_BATCH * 2 + 7;
    await s.db.query(`INSERT INTO events(id,provider,delivery_id,semantic_key,actor_id,scope,received_at,payload,accepted)
      SELECT 'bulk-'||g,'fixture','bulk-'||g,'bulk-'||g,$1,'{}'::jsonb,$2,jsonb_build_object('text','원문 '||g),true FROM generate_series(1,$3::int) g`, [OWNER, T, many]);
    await s.db.query(`INSERT INTO jobs(id,event_id,conversation_id,type,owner_id,target,revision,budget,state,priority,available_at,created_at,finished_at)
      SELECT 'bulk-job-'||g,'bulk-'||g,$1,'task',$2,'{}'::jsonb,'{}'::jsonb,'{}'::jsonb,'succeeded',1,1,1,$3 FROM generate_series(1,$4::int) g`, [CONVERSATION, OWNER, T, many]);
    await s.db.query(`INSERT INTO codex_questions(id,job_id,conversation_id,thread_id,turn,kind,responder_id,prompt,state,created_at,expires_at)
      SELECT 'bulk-job-'||g||':t:1','bulk-job-'||g,$1,'t',1,'clarification',$2,'질문 '||g,'expired',1,2 FROM generate_series(1,$3::int) g`, [CONVERSATION, OWNER, many]);
    await s.db.query(`INSERT INTO results SELECT 'bulk-job-'||g,jsonb_build_object('summary','요약 '||g),'{}'::jsonb,'internal',$1 FROM generate_series(1,$2::int) g`, [T, many]);
    await s.db.query(`INSERT INTO outbox(id,owner_id,scope,policy_revision,idempotency_key,payload,state,available_at,created_at,message_key,page_index)
      SELECT 'bulk-out-'||g,$1,'{}'::jsonb,'r','bulk-out-'||g,jsonb_build_object('kind','message','content','본문 '||g),'sent',$2,1,'bulk-out-'||g,0 FROM generate_series(1,$3::int) g`, [OWNER, T, many]);
    assert.deepEqual(await purgeExpiredRawText(s.db, T + 8 * DAY), { events: many, prompts: many, results: many, outbox: many });

    const changes = CHANGE_PURGE_BATCH + 3;
    for (let i = 0; i < changes; i++) await ended(s.store);
    assert.equal(await purgeExpiredChangeContentRounds(s.db, T + 8 * DAY), changes);
    assert.equal((await s.db.query('SELECT 1 FROM change_requests WHERE brief_purged_at IS NULL')).rows.length, 0);
  } finally { await s.close(); }
});

// ---- 실제 PostgreSQL ----

const socket = process.env.HOMELAB_TEST_PG_SOCKET;
const skip = socket ? false : 'HOMELAB_TEST_PG_SOCKET 없음(로컬 PostgreSQL 필요)';
async function emptyDatabase() {
  const admin = new pg.Pool({ host: socket, user: 'postgres', database: 'postgres', max: 1 });
  const name = `t31_${randomUUID().replaceAll('-', '').slice(0, 12)}`;
  await admin.query(`CREATE DATABASE ${name}`);
  const raw = new pg.Pool({ host: socket, user: 'postgres', database: name, max: 4 });
  return { raw, close: async () => { await raw.end(); await admin.query(`DROP DATABASE ${name}`); await admin.end(); } };
}

test('실제 PostgreSQL: 019까지의 DB에 남은 옛 원문도 020 적용 뒤 8일 정리에서 비워지고 진행 중 행은 남는다', { skip }, async () => {
  const d = await emptyDatabase();
  try {
    // 옛 코드가 쓰던 스키마(019)에 행을 만든 뒤 020을 적용한다. 배포 순서와 같다.
    for (const file of MIGRATIONS.filter(name => migrationVersion(name) <= 19)) await d.raw.query(await readFile(`migrations/${file}`, 'utf8'));
    const db = new Postgres(d.raw);
    await seedConversation(db);
    const clock = { now: T };
    const store = new ChangeStore(db, () => clock.now);
    const done = await ended(store);
    const live = await driveTo(store, 'authoring');
    const finished = await seed(db, 'pg-done', { job: { state: 'succeeded', session: { state: 'completed' }, prompt: '실제 PG 질문 ✓' }, payload: { text: '실제 PG 요청 ✓', kind: 'command' } });
    const waiting = await seed(db, 'pg-wait', { job: { state: 'waiting_user', finishedAt: null, session: { state: 'waiting_answer' } } });
    await outbox(db, 'pg-sent', { state: 'sent', at: T, content: '실제 PG 본문 ✓' });
    await outbox(db, 'pg-unknown', { state: 'unknown', at: T });
    assert.deepEqual(await runMigrations(d.raw), [20, 21, 22, 23, 24, 25, 26, 27, 28]);

    assert.equal(await purgeExpiredChangeContentRounds(db, T + 8 * DAY), 1);
    assert.deepEqual(await purgeExpiredRawText(db, T + 8 * DAY), { events: 1, prompts: 1, results: 1, outbox: 1 });
    assert.equal((await eventRow(db, finished.eventId)).text_sha256, sha('실제 PG 요청 ✓'));
    assert.equal((await promptRow(db, finished.question!)).prompt_sha256, sha('실제 PG 질문 ✓'));
    assert.equal((await outboxRow(db, 'pg-sent')).content_sha256, sha('실제 PG 본문 ✓'));
    assert.notEqual((await briefRow(db, done.id)).brief_purged_at, null);
    assert.equal((await briefRow(db, live.id)).brief_purged_at, null);
    assert.notEqual((await eventRow(db, waiting.eventId)).payload.text, '');
    assert.notEqual((await promptRow(db, waiting.question!)).prompt, '');
    assert.notEqual((await outboxRow(db, 'pg-unknown')).payload.content, '');
    assert.deepEqual(await purgeExpiredRawText(db, T + 8 * DAY), { events: 0, prompts: 0, results: 0, outbox: 0 });
  } finally { await d.close(); }
});
