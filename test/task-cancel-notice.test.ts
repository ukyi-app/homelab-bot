import { after, before, beforeEach, test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { CHAT_TASK_TEXT } from '../src/chat-task-text.js';
import { Denied } from '../src/contracts.js';
import { Postgres, migrate } from '../src/database.js';
import { taskQuestionId } from '../src/task-contracts.js';
import { event, fixture, localDatabase } from './helpers.js';
import { allRows, codexSession, control, conversationId, hang, jobs, lane, reply, task, until } from './task-lane-fixture.js';
import type { Fixture } from './task-lane-fixture.js';

// 작업이 cancelled로 확정되면 그 스레드에 안내가 한 번 간다. 안내는 상태를 바꾸는 트랜잭션에서 outbox에 들어간다.
let database: Awaited<ReturnType<typeof localDatabase>>;
let f: Fixture;
before(async () => { database = await localDatabase(); });
const RESET = `TRUNCATE events,conversations,jobs,results,outbox,schedules,denied_actors,controls,audit,incidents,codex_sessions,codex_questions RESTART IDENTITY CASCADE;
  UPDATE execution_lanes SET closed_reason=NULL,closed_at=NULL`;
beforeEach(async () => {
  await database.pg.exec(RESET);
  f = await fixture(database.db);
});
after(async () => { await database.pg.close(); });
const db = () => database.db;
const outbox = async () => (await db().query<Record<string, any>>('SELECT * FROM outbox ORDER BY created_at,idempotency_key')).rows;
const notices = async () => (await outbox()).filter(row => String(row.idempotency_key).startsWith('task-cancelled:'));
const blocked = async () => (await outbox()).filter(row => String(row.idempotency_key).startsWith('task-blocked:'));
const state = async (id: string) => (await db().query<{ state: string; wait_reason: string | null }>('SELECT state,wait_reason FROM jobs WHERE id=$1', [id])).rows[0]!;
const claimedJob = async (id: string) => (await db().query<any>('SELECT * FROM jobs WHERE id=$1', [id])).rows[0];

// 턴이 실행 중일 때 /task-cancel을 보내고 소멸 확인까지 끝낸다.
async function cancelRunning(setup: ReturnType<typeof lane>) {
  setup.worker.scripts.push(hang);
  const job = await task(f, db());
  const running = setup.runtime.tickTask();
  await until(() => setup.worker.executes.length === 1);
  await control(f, 'cancel', job.id);
  await running;
  return job;
}

test('실행 중 취소: 소멸을 확인하면 cancelled와 안내 1건이고, 안내는 그 스레드로 멘션 없는 요약이다', async () => {
  const setup = lane(f);
  const job = await cancelRunning(setup);
  assert.deepEqual(await state(job.id), { state: 'cancelled', wait_reason: 'stop_confirmation' });
  assert.equal(setup.worker.cancels.length, 1);
  const rows = await notices();
  assert.equal(rows.length, 1);
  const [row] = rows;
  assert.equal(row!.idempotency_key, `task-cancelled:${job.id}`);
  assert.equal(row!.job_id, job.id);
  assert.equal(row!.owner_id, job.owner_id);
  assert.equal(row!.conversation_id, job.conversation_id);
  assert.equal(row!.state, 'pending');
  assert.equal(row!.payload.kind, 'message');
  assert.equal(row!.payload.channel, job.target.channel);
  assert.equal(row!.payload.classification, 'safe_summary');
  assert.equal(row!.payload.content, CHAT_TASK_TEXT.taskCancelled(false, job.id));
  assert.equal((await blocked()).length, 0);
});

test('같은 확정을 두 번 처리: 늦은 응답·sweep 반복·같은 키 재삽입에도 안내는 1건이다', async () => {
  const setup = lane(f);
  const job = await cancelRunning(setup);
  const claimed = await claimedJob(job.id);
  await setup.bridge.sweep();
  await setup.bridge.sweep();
  assert.equal(await f.store.transition(claimed, 'cancelled', 'stop_confirmation'), false, '이미 끝난 job은 바꾸지 못한다');
  assert.equal((await notices()).length, 1);
  // 상태 검사를 지나 다시 확정돼도 멱등 키가 막는다.
  await db().query("UPDATE jobs SET state='cancel_requested',lease_until=$2 WHERE id=$1", [job.id, f.now() + 60_000]);
  assert.equal(await f.store.transition({ ...claimed, lease_until: f.now() + 60_000 }, 'cancelled', 'stop_confirmation'), true);
  assert.equal((await state(job.id)).state, 'cancelled');
  assert.equal((await notices()).length, 1);
});

test('소멸을 확인하지 못한 취소: cancelled 안내 없이 unknown 안내 1건, 해제 전까지 레인이 닫힌다', async () => {
  const setup = lane(f);
  setup.worker.stopped = false;
  const job = await cancelRunning(setup);
  assert.deepEqual(await state(job.id), { state: 'unknown', wait_reason: 'stop_confirmation' });
  assert.equal((await notices()).length, 0);
  assert.equal((await blocked()).length, 1);
  await setup.bridge.sweep();
  assert.equal((await notices()).length, 0);
  assert.equal((await blocked()).length, 1);
});

test('취소 뒤 lease가 끝나 상태를 못 바꾸면 안내하지 않고, unknown 해제는 /task-release 결과가 알린다', async () => {
  const setup = lane(f, { monitorMs: 3_600_000 });
  let deliver!: () => void;
  const held = new Promise<void>(resolve => { deliver = resolve; });
  setup.worker.scripts.push(async (request, worker) => { await held; return reply.failed('api_error')(request, worker); });
  const job = await task(f, db());
  const running = setup.runtime.tickTask();
  await until(() => setup.worker.executes.length === 1);
  await control(f, 'cancel', job.id);
  f.advance(120_000); f.policy.confirmedAt = f.now();
  await f.store.expire();
  assert.equal((await state(job.id)).state, 'unknown');
  deliver();
  await running;
  assert.equal((await state(job.id)).state, 'unknown');
  assert.equal((await notices()).length, 0);

  const released = await setup.bridge.release('fixture-owner', job.target, job.id);
  assert.equal(released.ok, true, released.status);
  assert.equal((await state(job.id)).state, 'cancelled');
  assert.equal((await notices()).length, 0, 'TaskCommands.release가 해제 결과를 이미 게시한다');
});

test('실행 전 취소: 대기열·질문 대기·한도 대기·dispatch 직전 모두 안내 1건이다', async () => {
  const queued = await task(f, db(), 'queued');
  await control(f, 'cancel', queued.id);
  assert.equal((await state(queued.id)).state, 'cancelled');
  assert.deepEqual((await notices()).map(row => row.idempotency_key), [`task-cancelled:${queued.id}`]);
  assert.equal((await control(f, 'cancel', queued.id)).ok, false, '이미 끝난 작업');
  assert.equal((await notices()).length, 1);

  await database.pg.exec(RESET);
  f = await fixture(database.db);
  const asking = lane(f);
  asking.worker.scripts.push(reply.question());
  const waiting = await task(f, db(), 'waiting');
  await asking.runtime.tickTask();
  assert.equal((await state(waiting.id)).state, 'waiting_user');
  await control(f, 'cancel', waiting.id);
  await asking.bridge.sweep();
  assert.deepEqual((await notices()).map(row => row.idempotency_key), [`task-cancelled:${waiting.id}`]);

  await database.pg.exec(RESET);
  f = await fixture(database.db);
  const limited = lane(f);
  limited.worker.scripts.push(reply.limited());
  const held = await task(f, db(), 'limited');
  await limited.runtime.tickTask();
  await control(f, 'cancel', held.id);
  assert.deepEqual((await notices()).map(row => row.idempotency_key), [`task-cancelled:${held.id}`]);

  await database.pg.exec(RESET);
  f = await fixture(database.db);
  const racing = lane(f);
  const early = await task(f, db(), 'early');
  const claimed = (await f.store.claim('task'))!;
  await control(f, 'cancel', early.id);
  await racing.bridge.run(claimed);
  assert.deepEqual(await state(early.id), { state: 'cancelled', wait_reason: 'cancel_before_dispatch' });
  assert.equal(racing.worker.executes.length, 0);
  assert.deepEqual((await notices()).map(row => row.idempotency_key), [`task-cancelled:${early.id}`]);

  await database.pg.exec(RESET);
  f = await fixture(database.db);
  const deferred = await task(f, db(), 'deferred');
  const late = (await f.store.claim('task'))!;
  await control(f, 'cancel', deferred.id);
  await f.store.defer(late, 'publisher_shutdown');
  assert.deepEqual(await state(deferred.id), { state: 'cancelled', wait_reason: 'cancel_before_dispatch' });
  assert.deepEqual((await notices()).map(row => row.idempotency_key), [`task-cancelled:${deferred.id}`]);
});

test('안내하지 않는 끝: 완료·실패·권한 철회·질문 만료와 대화 취소는 취소 안내를 넣지 않는다', async () => {
  const done = lane(f);
  done.worker.scripts.push(reply.completed());
  await task(f, db(), 'done');
  await done.runtime.tickTask();
  done.worker.scripts.push(reply.failed('api_error'));
  await task(f, db(), 'failed');
  await done.runtime.tickTask();
  assert.equal((await notices()).length, 0);

  await database.pg.exec(RESET);
  f = await fixture(database.db);
  const revoked = lane(f);
  revoked.worker.scripts.push(hang);
  const stopped = await task(f, db(), 'revoked');
  const running = revoked.runtime.tickTask();
  await until(() => revoked.worker.executes.length === 1);
  const authorize = f.gate.authorize.bind(f.gate);
  f.gate.authorize = async () => { throw new Denied(); };
  await running;
  f.gate.authorize = authorize;
  assert.deepEqual(await state(stopped.id), { state: 'cancelled', wait_reason: 'authorization_revoked' });
  assert.equal((await notices()).length, 0);

  await database.pg.exec(RESET);
  f = await fixture(database.db);
  const asking = lane(f, { questionTtlMs: 1000 });
  asking.worker.scripts.push(reply.question());
  const waiting = await task(f, db(), 'expiring');
  await asking.runtime.tickTask();
  const sid = (await allRows(db(), 'codex_sessions'))[0]!.claude_session_id as string;
  f.advance(1001); f.policy.confirmedAt = f.now();
  await asking.bridge.sweep();
  assert.equal((await state(waiting.id)).wait_reason, 'question_expired');
  assert.equal((await notices()).length, 0, '만료 안내가 따로 간다');
  assert.equal((await outbox()).filter(row => row.idempotency_key === `task-expired:${taskQuestionId(waiting.id, sid, 1)}`).length, 1);

  await database.pg.exec(RESET);
  f = await fixture(database.db);
  await f.ingress.receive(event('chat-1', { kind: 'command', command: 'urgent', text: '대화' }));
  const chat = (await jobs(db())).at(-1)!;
  await control(f, 'cancel', chat.id);
  assert.equal((await state(chat.id)).state, 'cancelled');
  assert.equal((await notices()).length, 0);
});

test('Codex 세션의 작업도 같은 저장소 경로라 취소 확정 안내가 간다', async () => {
  const { job, claimed } = await codexSession(f, db(), 'running', 'running');
  await control(f, 'cancel', job.id);
  assert.equal(await f.store.transition(claimed, 'cancelled', 'stop_confirmation'), true);
  assert.deepEqual((await notices()).map(row => row.idempotency_key), [`task-cancelled:${job.id}`]);
});

// 실제 PostgreSQL 다중 연결. 안내 삽입이 대화 행을 잡아 제어 경로와 교착하지 않는지 본다. 소켓이 없으면 건너뛴다(test/task-lane-pg.test.ts와 같은 방식).
const socket = process.env.HOMELAB_TEST_PG_SOCKET;
const skip = socket ? false : 'HOMELAB_TEST_PG_SOCKET 없음(로컬 PostgreSQL 필요)';
test('실제 PostgreSQL: 취소 확정과 제어·접수가 겹쳐도 교착 없이 안내 1건으로 끝난다', { skip, timeout: 120_000 }, async () => {
  const admin = new pg.Pool({ host: socket, user: 'postgres', database: 'postgres', max: 1 });
  const name = `t18b7a_${randomUUID().replaceAll('-', '').slice(0, 12)}`;
  await admin.query(`CREATE DATABASE ${name}`);
  const pool = new pg.Pool({ host: socket, user: 'postgres', database: name, max: 12 });
  try {
    const real = new Postgres(pool);
    await migrate(real);
    const local = await fixture(real);
    await real.query("INSERT INTO controls VALUES ('scheduler','false') ON CONFLICT DO NOTHING");
    const scoped = async (id: string) => (await real.query<{ idempotency_key: string }>("SELECT idempotency_key FROM outbox WHERE idempotency_key=$1", [`task-cancelled:${id}`])).rows.length;
    for (let round = 0; round < 8; round++) {
      const setup = lane(local);
      setup.worker.scripts.push(hang);
      const job = await task(local, real, `pg-${round}`);
      const running = setup.runtime.tickTask();
      await until(() => setup.worker.executes.length === 1);
      const results = await Promise.allSettled([running,
        local.store.control('fixture-owner', conversationId(local), 'cancel', job.id),
        local.store.control('fixture-owner', conversationId(local), 'cancel', job.id),
        local.store.control('fixture-owner', conversationId(local), 'model-status'),
        local.ingress.receive(event(`pg-chat-${round}`, { kind: 'command', command: 'urgent', text: '대화' }))]);
      for (const result of results) assert.equal(result.status, 'fulfilled', result.status === 'rejected' ? String(result.reason) : '');
      await setup.bridge.sweep();
      const { state: finalState } = (await real.query<{ state: string }>('SELECT state FROM jobs WHERE id=$1', [job.id])).rows[0]!;
      assert.equal(finalState, 'cancelled');
      assert.equal(await scoped(job.id), 1);
    }
  } finally {
    await pool.end();
    for (let attempt = 0; ; attempt++) {
      try { await admin.query(`DROP DATABASE ${name}`); break; } catch (error) {
        if (attempt >= 50 || !/being accessed by other users/.test((error as Error).message)) throw error;
        await new Promise(resolve => setTimeout(resolve, 100));
      }
    }
    await admin.end();
  }
});
