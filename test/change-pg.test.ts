import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { EFFECT_LEASE_MS } from '../src/change-contracts.js';
import type { ArtifactSaveResult, AuthorResult, ChangeArtifactPort, EffectStage } from '../src/change-contracts.js';
import { ChangePublisher } from '../src/change-publisher.js';
import { readFile } from 'node:fs/promises';
import { MIGRATIONS, Postgres, migrationVersion } from '../src/database.js';
import { MethodRouter, installMethods } from '../src/method-routing.js';
import { runMigrations } from '../src/migrate-main.js';
import { recordAccount, switchAccount } from '../src/model-accounts.js';
import { REQUEST_TEXT, WRITE_STEP, changeHarness } from './change-assembly-harness.js';
import type { Harness } from './change-assembly-harness.js';
import { OWNER, driveTo, git, hex, ok, seedConversation } from './change-store-fixture.js';
import { REPO, publishEnv } from './change-github-fake.js';
import { QUESTION } from './task-worker-harness.js';
import { until } from './fake-gateway.js';

// 실제 PostgreSQL(18) 시험. HOMELAB_TEST_PG_SOCKET(유닉스 소켓 디렉터리)이 없으면 건너뛴다. GitHub은 가짜다.
const socket = process.env.HOMELAB_TEST_PG_SOCKET;
const skip = socket ? false : 'HOMELAB_TEST_PG_SOCKET 없음(로컬 PostgreSQL 필요)';
const CONCURRENCY = 8;

async function database() {
  const admin = new pg.Pool({ host: socket, user: 'postgres', database: 'postgres', max: 1 });
  const name = `t19b3_${randomUUID().replaceAll('-', '').slice(0, 12)}`;
  await admin.query(`CREATE DATABASE ${name}`);
  const raw = new pg.Pool({ host: socket, user: 'postgres', database: name, max: CONCURRENCY + 2 });
  await runMigrations(raw);
  const db = new Postgres(raw);
  const env = await publishEnv(db);
  return { raw, env, close: async () => {
    await raw.end();
    for (let attempt = 0; ; attempt++) {
      try { await admin.query(`DROP DATABASE ${name}`); break; } catch (error) {
        if (attempt >= 50 || !/being accessed by other users/.test((error as Error).message)) throw error;
        await new Promise(resolve => setTimeout(resolve, 100));
      }
    }
    await admin.end();
  } };
}
const ROUTES: Record<EffectStage, RegExp> = {
  blob: /POST .*\/git\/blobs$/, tree: /POST .*\/git\/trees$/, commit: /POST .*\/git\/commits$/, ref: /POST .*\/git\/refs$/, pull: /POST .*\/pulls$/,
};

test('T19 B3 실제 PostgreSQL: 게시자 여럿이 동시에 돌아도 stage마다 POST가 한 번이다', { skip }, async () => {
  const d = await database();
  try {
    for (let round = 0; round < 3; round++) {
      const key = await d.env.approve([{ path: `src/round-${round}.ts`, kind: 'added', content: `export const r = ${round};\n` }]);
      const before = { blob: d.env.github.count(ROUTES.blob), tree: d.env.github.count(ROUTES.tree), commit: d.env.github.count(ROUTES.commit), ref: d.env.github.count(ROUTES.ref), pull: d.env.github.count(ROUTES.pull) };
      const outcomes = await Promise.all(Array.from({ length: CONCURRENCY }, () => d.env.newPublisher().publish(key)));
      for (const outcome of outcomes) assert.ok(['proposed', 'busy', 'deferred', 'stopped'].includes(outcome.kind), JSON.stringify(outcome));
      // 진 게시자는 멈출 뿐이다. 마지막 한 번으로 끝까지 민다.
      let final = await d.env.newPublisher().publish(key);
      for (let i = 0; i < 10 && final.kind !== 'proposed'; i++) {
        await new Promise(resolve => setTimeout(resolve, 100));
        final = await d.env.newPublisher().publish(key);
      }
      assert.equal(final.kind, 'proposed', JSON.stringify(final));
      for (const stage of ['blob', 'tree', 'commit', 'ref', 'pull'] as const) assert.equal(d.env.github.count(ROUTES[stage]) - before[stage], 1, stage);
      assert.equal(ok(await d.env.store.get(key.changeId)).phase, 'proposed');
    }
    assert.equal(d.env.github.pulls.length, 3);
  } finally { await d.close(); }
});

for (const stage of ['blob', 'tree', 'commit', 'ref', 'pull'] as const) {
  test(`T19 B3 실제 PostgreSQL: ${stage} 전송 뒤 프로세스 중단·임대 만료·동시 재시작에도 중복이 없다`, { skip }, async () => {
    const d = await database();
    try {
      const key = await d.env.approve();
      // 응답을 받기 전에 프로세스가 죽은 상황. GitHub에는 적용됐고 DB에는 sending만 남는다.
      d.env.github.fail(ROUTES[stage], 'lose_response');
      const real = d.env.store.markEffectUnknown.bind(d.env.store);
      d.env.store.markEffectUnknown = async () => { throw new Error('process_killed'); };
      await assert.rejects(d.env.publisher.publish(key), /process_killed/);
      d.env.store.markEffectUnknown = real;
      assert.equal((await d.env.store.unresolvedEffects({ changeId: key.changeId }))[0]?.state, 'sending');
      const sent = d.env.github.count(ROUTES[stage]);

      // 임대가 살아 있는 동안에는 아무도 대조·재전송하지 않는다.
      assert.deepEqual(await new ChangePublisher({ store: d.env.store, writer: d.env.writerIO.writer, preflight: d.env.writerIO.preflight, policy: async () => d.env.policy.current, authorize: async () => {}, now: () => d.env.clock.now, retryMs: 60_000 }).publish(key), { kind: 'busy' });

      d.env.clock.now += EFFECT_LEASE_MS + 1;
      const outcomes = await Promise.all(Array.from({ length: CONCURRENCY }, () => d.env.newPublisher().publish(key)));
      for (const outcome of outcomes) assert.ok(['proposed', 'busy', 'unknown', 'deferred', 'stopped'].includes(outcome.kind), JSON.stringify(outcome));
      let final = await d.env.newPublisher().publish(key);
      for (let i = 0; i < 10 && final.kind !== 'proposed'; i++) {
        await new Promise(resolve => setTimeout(resolve, 100));
        final = await d.env.newPublisher().publish(key);
      }
      assert.equal(final.kind, 'proposed', JSON.stringify(final));
      assert.equal(d.env.github.count(ROUTES[stage]), sent, '다시 보내지 않고 대조로 회수한다');
      assert.equal(d.env.github.pulls.length, 1);
      assert.deepEqual(await d.env.store.unresolvedEffects({ changeId: key.changeId }), []);
    } finally { await d.close(); }
  });
}

test('T19 B3 실제 PostgreSQL: 동시 reconcile은 같은 unknown을 한 번만 처리한다', { skip }, async () => {
  const d = await database();
  try {
    const key = await d.env.approve();
    d.env.github.fail(ROUTES.commit, 'lose_response');
    const real = d.env.store.confirmEffect.bind(d.env.store);
    let hold = true;
    d.env.store.confirmEffect = async input => {
      if (hold && input.stage === 'commit') throw new Error('crash');
      return real(input);
    };
    await assert.rejects(d.env.publisher.publish(key), /crash/);
    hold = false;
    d.env.clock.now += EFFECT_LEASE_MS + 1;
    const reports = await Promise.all(Array.from({ length: CONCURRENCY }, () => d.env.newPublisher().reconcile()));
    assert.ok(reports.some(report => report.confirmed.length === 1));
    let final = await d.env.newPublisher().publish(key);
    for (let i = 0; i < 10 && final.kind !== 'proposed'; i++) final = await d.env.newPublisher().publish(key);
    assert.equal(final.kind, 'proposed', JSON.stringify(final));
    assert.equal(d.env.github.count(ROUTES.commit), 1);
    assert.equal(d.env.github.pulls.length, 1);
  } finally { await d.close(); }
});

test('T19 B3 실제 PostgreSQL: claim과 취소가 겹쳐도 취소 뒤 시작되는 전송이 없다', { skip }, async () => {
  const d = await database();
  try {
    const rounds = 5;
    for (let round = 0; round < rounds; round++) {
      const key = await d.env.approve([{ path: `src/cancel-${round}.ts`, kind: 'added', content: `export const c = ${round};\n` }]);
      const before = d.env.github.mutations().length;
      const [, cancel] = await Promise.all([
        d.env.newPublisher().publish(key),
        (async () => {
          for (let i = 0; i < 50; i++) {
            const phase = ok(await d.env.store.get(key.changeId)).phase;
            if (phase === 'publishing') return d.env.store.transition({ ...key, from: 'publishing', to: 'cancelled', reason: 'user_cancelled' });
            if (phase === 'proposed') return null;
            await new Promise(resolve => setImmediate(resolve));
          }
          return null;
        })(),
      ]);
      const request = ok(await d.env.store.get(key.changeId));
      if (cancel?.ok) {
        assert.equal(request.phase, 'cancelled');
        // 취소 뒤에는 어떤 게시자도 새 stage를 열지 못한다.
        const sent = d.env.github.mutations().length;
        assert.deepEqual(await d.env.newPublisher().publish(key), { kind: 'stopped', phase: 'cancelled' });
        assert.equal(d.env.github.mutations().length, sent);
      } else {
        assert.equal(request.phase, 'proposed');
        assert.ok(d.env.github.mutations().length > before);
      }
    }
  } finally { await d.close(); }
});

// ---- T19 B5 조립: 부모 runtime 전체를 실제 PostgreSQL에서 돌린다 ----

async function bare() {
  const admin = new pg.Pool({ host: socket, user: 'postgres', database: 'postgres', max: 1 });
  const name = `t19b5_${randomUUID().replaceAll('-', '').slice(0, 12)}`;
  await admin.query(`CREATE DATABASE ${name}`);
  const raw = new pg.Pool({ host: socket, user: 'postgres', database: name, max: CONCURRENCY + 2 });
  return { raw, db: new Postgres(raw), close: async () => {
    await raw.end();
    for (let attempt = 0; ; attempt++) {
      try { await admin.query(`DROP DATABASE ${name}`); break; } catch (error) {
        if (attempt >= 50 || !/being accessed by other users/.test((error as Error).message)) throw error;
        await new Promise(resolve => setTimeout(resolve, 100));
      }
    }
    await admin.end();
  } };
}
const childState = async (h: Harness, id: string) => (await h.db.query<{ state: string }>(`SELECT j.state FROM jobs j JOIN change_child_jobs c ON c.job_id=j.id WHERE c.change_id=$1 AND c.role='author'`, [id])).rows[0]!.state;
const digest = async (h: Harness, id: string) => (await h.db.query<{ approval_digest: string }>('SELECT approval_digest FROM change_approval_subjects WHERE change_id=$1', [id])).rows[0]!.approval_digest;

test('T19 B5 EVENT-02 실제 PostgreSQL: 전이 지점마다 끊고 재시작해도 모델·시험·리뷰·게시가 한 번씩이다', { skip }, async () => {
  const points = ['changes.admit', 'changes.pinBase', 'author.start', 'author.fetchResult', 'artifacts.save', 'changes.startVerification', 'verification.run', 'changes.recordVerification', 'author.finalize', 'changes.finishVerification', 'review.submit', 'publisher.prepareApproval', 'publisher.publish'];
  for (const point of points) for (const when of ['before', 'after'] as const) {
    const d = await bare();
    await runMigrations(d.raw);
    const h = await changeHarness(d.db, { crash: { point, when } });
    try {
      const fired = () => h.logs.some(entry => entry.event === 'change_step_failed');
      await h.command('100', 'change', { target: REPO.fullName, text: REQUEST_TEXT });
      const id = await h.changeId();
      await h.pump(async () => fired() || await h.phase(id) === 'awaiting_publish_approval');
      h.restart({ crash: { point, when } });
      await h.pump(async () => await h.phase(id) === 'awaiting_publish_approval');
      await h.command('101', 'change-publish', { target: id, text: await digest(h, id) });
      await h.pump(async () => await h.phase(id) === 'proposed');
      h.restart();
      await h.pump(async () => await childState(h, id) === 'succeeded');
      assert.equal((await h.f.calls()).length, 1, `${point} ${when}: 모델 1회`);
      assert.equal(h.runs.verify, 1, `${point} ${when}: 시험 1회`);
      assert.equal(h.reviewInputs.length, 1, `${point} ${when}: 리뷰 1회`);
      assert.equal(h.env.github.pulls.length, 1, `${point} ${when}: PR 하나`);
      assert.equal(h.env.github.count(ROUTES.pull), 1);
      assert.equal(await h.store.laneBusy('task'), false);
    } finally { await h.close(); await d.close(); }
  }
});
test('T19 B5 EVENT-02 실제 PostgreSQL: 게시 서버 둘이 같은 부모를 동시에 밀어도 모델·시험·PR이 하나다', { skip }, async () => {
  const d = await bare();
  await runMigrations(d.raw);
  const h = await changeHarness(d.db);
  try {
    await h.command('100', 'change', { target: REPO.fullName, text: REQUEST_TEXT });
    const id = await h.changeId();
    const first = h.runtime;
    const firstReview = h.reviewRuntime;
    h.restart();
    const second = h.runtime;
    const secondReview = h.reviewRuntime;
    const both = async () => { await Promise.allSettled([first.childrenTick(), second.childrenTick(), first.laneTick(), second.laneTick(), first.publishTick(), second.publishTick(), firstReview.tick(), secondReview.tick()]); };
    for (let round = 0; round < 400 && await h.phase(id) !== 'awaiting_publish_approval'; round++) { await both(); await new Promise(resolve => setTimeout(resolve, 3)); }
    assert.equal(await h.phase(id), 'awaiting_publish_approval');
    await h.command('101', 'change-publish', { target: id, text: await digest(h, id) });
    for (let round = 0; round < 400 && await h.phase(id) !== 'proposed'; round++) { await both(); await new Promise(resolve => setTimeout(resolve, 3)); }
    assert.equal(await h.phase(id), 'proposed');
    assert.equal((await h.f.calls()).length, 1);
    assert.equal(h.runs.verify, 1);
    assert.equal(h.reviewInputs.length, 1);
    assert.equal(h.env.github.pulls.length, 1);
    for (const stage of ['tree', 'commit', 'ref', 'pull'] as const) assert.equal(h.env.github.count(ROUTES[stage]), 1, stage);
  } finally { await h.close(); await d.close(); }
});
// C40(AC-37·AC-38). 구독 한도로 대기열에 돌아온 작성 job을 두 게시 서버가 함께 재개 준비한다. B가 집고 API를 고른 뒤 턴 시작 직전에
// A가 같은 job·lease의 대기 세션을 읽어 API로 다음 턴을 시작하고, 이어서 다른 실행의 API 결제 실패로 API가 잠긴다. B의 시작은 거절되고
// 세션이 바뀐 것을 본다(change_turn_conflict). 그 경합이 부모를 닫거나 A의 턴을 취소하면 안 된다.
test('C40 AC-37 실제 PostgreSQL: 두 게시 서버의 변경 작성 재개 준비가 겹쳐 늦은 쪽 턴 시작이 그 사이 잠긴 API로 거절돼도 부모는 작성 단계에 남고, 먼저 시작한 턴이 저장·시험·리뷰를 거쳐 승인 대기까지 간다', { skip }, async () => {
  const d = await bare();
  await runMigrations(d.raw);
  const turnEnds = new Set(['snapshot', 'needs_input', 'limited', 'auth_expired', 'failed', 'unknown']);
  const resetsAt = Math.floor((Date.now() + 3_600_000) / 1000);
  // 첫 턴은 구독 한도(세션 남음), 그 뒤 턴은 그 요청의 선택으로 돈 결과다.
  const methods = { sent: [] as Record<string, any>[], result: (response: any, sent: Record<string, any>[]) => {
    const request = sent.at(-1);
    if (!turnEnds.has(response.status) || !request?.execution) return response;
    if (sent.length === 1) return { version: response.version, job: response.job, lease: response.lease, generation: response.generation, sessionId: response.sessionId, worker: response.worker,
      turn: response.turn, usage: { toolCalls: 0, model: null }, status: 'limited', stopped: true, sessionRetained: true, cleanupPending: false,
      rateLimit: { stop: { cause: 'rate_limit', resetsAt } }, execution: { ...request.execution, subscriptionLimit: true } };
    return { ...response, execution: { ...request.execution, subscriptionLimit: false } };
  } };
  const h = await changeHarness(d.db, { methods, steps: [WRITE_STEP, WRITE_STEP] });
  try {
    await recordAccount(h.db, 'main', 'subscription', Date.now());
    await recordAccount(h.db, 'main', 'api', Date.now());
    await h.store.atomic(s => switchAccount(s, 'main', 'subscription', 'cli', 'cli'));
    assert.equal((await h.store.atomic(s => installMethods(s, 'main', 'rev-1'))).result, 'installed');
    const router = new MethodRouter(h.store, { enabled: true, task: true, supported: () => true });
    h.bridge.useMethods(router);
    await h.command('100', 'change', { target: REPO.fullName, text: REQUEST_TEXT });
    const id = await h.changeId();
    const child = async () => (await h.db.query<{ id: string; state: string; lease_token: string | null; attempt: number; session: string | null }>(`SELECT j.id,j.state,j.lease_token,j.attempt,s.state AS session
      FROM jobs j JOIN change_child_jobs c ON c.job_id=j.id LEFT JOIN codex_sessions s ON s.job_id=j.id WHERE c.change_id=$1 AND c.role='author'`, [id])).rows[0];
    await h.pump(async () => { const row = await child(); return row?.state === 'queued' && row.session === 'waiting_model'; });
    const a = h.runtime;
    h.restart();
    const b = h.runtime;
    h.bridge.useMethods(router);
    const begin = h.bridge.beginChangeTurn.bind(h.bridge);
    let raced = false;
    // 장벽: B가 고른 뒤 턴 시작 직전에 A의 재개 준비를 끝까지 돌리고 API를 잠근다.
    h.bridge.beginChangeTurn = async (job, request, session) => {
      if (!raced) {
        raced = true;
        await a.laneTick();
        await h.db.query(`UPDATE method_api SET state='billing_blocked',blocked_at=$1`, [Date.now()]);
      }
      return begin(job, request, session);
    };
    await b.laneTick();
    assert.ok(raced);
    assert.deepEqual(methods.sent.map(request => [request.operation, request.execution?.method]), [['start', 'subscription'], ['resume', 'api']]);
    const during = (await child())!;
    assert.deepEqual([await h.phase(id), during.state, during.session], ['authoring', 'running', 'running']);
    assert.equal(h.logs.some(entry => entry.event === 'change_closed'), false);
    const runs = (await h.db.query<{ outcome: string | null; started: boolean }>('SELECT outcome,started_at IS NOT NULL AS started FROM method_runs WHERE method=$1 ORDER BY selected_at', ['api'])).rows;
    assert.deepEqual(runs.map(run => [run.started, run.outcome]).sort(), [[false, 'unstarted'], [true, null]]);
    const both = async () => { await Promise.allSettled([a.childrenTick(), b.childrenTick(), a.laneTick(), b.laneTick(), a.publishTick(), b.publishTick(), h.reviewRuntime.tick()]); };
    for (let round = 0; round < 400 && await h.phase(id) !== 'awaiting_publish_approval'; round++) { await both(); await new Promise(resolve => setTimeout(resolve, 3)); }
    assert.equal(await h.phase(id), 'awaiting_publish_approval');
    const after = (await child())!;
    assert.deepEqual([after.state, after.session, after.attempt], ['succeeded', 'completed', during.attempt]);
    assert.equal((await h.f.calls()).length, 2);
    assert.equal(methods.sent.length, 2);
    assert.equal(h.runs.verify, 1);
    assert.equal(h.reviewInputs.length, 1);
  } finally { await h.close(); await d.close(); }
});
// C36 묶음 D(F-8). 한 게시 서버가 앞 차례 작성 결과를 받아 들고 있는 동안 다른 게시 서버가 저장·시험·리뷰를 마치고 고치기 차례를 연다.
// 늦게 풀린 앞 차례 결과는 새 차례의 단계·artifact·확인할 것을 바꾸지 않고, 새 차례는 자기 결과로 승인 대기까지 간다.
test('C36 F-8 실제 PostgreSQL: 앞 차례 작성 결과를 들고 있던 게시 서버가 고치기 차례가 열린 뒤 풀려도 새 차례의 단계·artifact·확인할 것을 바꾸지 않는다', { skip }, async () => {
  const d = await bare();
  await runMigrations(d.raw);
  const v2 = (summary: string, check: string) => ({ status: 'completed', summary, question: '', options: [], checks: [{ text: check, path: 'src/new.ts', line: 1 }], risks: [] });
  const firstStep = { ...WRITE_STEP, output: v2('작성했어요', '고치기 전 가정을 확인') };
  const fixedStep = { write: { ...WRITE_STEP.write, 'src/new.ts': 'export const n = 2;\n' }, output: v2('고쳤어요', '빈 입력 처리를 확인') };
  const finding = { priority: 'P0' as const, code: 'logic_error' as const, path: 'src/new.ts', line: 1, title: '빈 입력에서 예외가 난다', detail: '입력이 비면 멈춘다', evidence: 'src/new.ts 1행' };
  let reviews = 0;
  const reviewReply = () => ({ status: 'succeeded' as const, output: { goal: 'met' as const, acceptance: [{ index: 0, status: 'met' as const }], reviewed_paths: ['src/a.ts', 'src/new.ts'],
    findings: reviews++ === 0 ? [finding] : [], summary: 's' } });
  const h = await changeHarness(d.db, { changeV2: true, steps: [firstStep, fixedStep], reviewReply });
  try {
    let held = false;
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    h.restart({ instrument: deps => ({ ...deps, author: new Proxy(deps.author, { get(target, property) {
      const value = Reflect.get(target, property) as (...args: unknown[]) => unknown;
      if (property === 'fetchResult') return async (...args: unknown[]) => {
        const result = await value.apply(target, args) as AuthorResult;
        if (result.kind === 'snapshot' && !held) { held = true; await gate; }
        return result;
      };
      return typeof value === 'function' ? value.bind(target) : value;
    } }) }) });
    const stale = h.runtime;
    h.restart();
    await h.command('100', 'change', { target: REPO.fullName, text: REQUEST_TEXT });
    const id = await h.changeId();
    let stopping = false;
    const staleLoop = (async () => { while (!stopping) { await stale.laneTick(); await new Promise(resolve => setTimeout(resolve, 3)); } })();
    await until(() => held, 30_000);
    await h.pump(async () => (await d.raw.query(`SELECT 1 FROM change_requests r JOIN change_generations g ON g.change_id=r.id AND g.generation=r.generation
      WHERE r.id=$1 AND r.phase='authoring' AND g.fix_round=1`, [id])).rows.length === 1);
    stopping = true;
    release();
    await staleLoop;
    assert.equal(await h.phase(id), 'authoring', '앞 차례 결과가 새 차례를 snapshot_ready로 넘기지 않는다');
    assert.equal((await d.raw.query('SELECT 1 FROM change_artifacts WHERE change_id=$1', [id])).rows.length, 0, '앞 차례 artifact가 새 차례 자리에 없다');
    assert.equal((await d.raw.query('SELECT 1 FROM change_notes WHERE change_id=$1', [id])).rows.length, 0, '앞 차례 확인할 것이 새 차례 자리에 없다');

    await h.pump(async () => await h.phase(id) === 'awaiting_publish_approval');
    assert.equal((await h.f.calls()).length, 2, '처음 작성 + 고치기 1번');
    const notes = (await d.raw.query<{ checks: unknown }>('SELECT checks FROM change_notes WHERE change_id=$1', [id])).rows;
    assert.deepEqual(notes.map(row => row.checks), [[{ text: '빈 입력 처리를 확인', location: { path: 'src/new.ts', line: 1 } }]]);
    const archived = (await d.raw.query<{ artifact_digest: string }>('SELECT artifact_digest FROM change_fix_rounds WHERE change_id=$1', [id])).rows[0]!.artifact_digest;
    const live = (await d.raw.query<{ artifact_digest: string }>('SELECT artifact_digest FROM change_artifacts WHERE change_id=$1', [id])).rows[0]!.artifact_digest;
    assert.notEqual(live, archived, '승인 대상은 새 차례 artifact다');
  } finally { await h.close(); await d.close(); }
});
// C36 묶음 D(F-8). 한 게시 서버가 차례 확인(확인할 것 기록)은 지났지만 artifact 저장 직전에 멈춘 사이 다른 게시 서버가 저장·시험·리뷰를 마치고 고치기 차례를 연다.
// 풀린 저장은 저장 자체의 차례 확인에서 거부되고, 새 차례에는 artifact가 없다.
test('C36 F-8 실제 PostgreSQL: 차례 확인 뒤 artifact 저장 직전에 멈춘 게시 서버가 고치기 차례가 열린 뒤 풀려도 저장은 phase_conflict이고 새 차례에 artifact가 없다', { skip }, async () => {
  const d = await bare();
  await runMigrations(d.raw);
  const v2 = (summary: string, check: string) => ({ status: 'completed', summary, question: '', options: [], checks: [{ text: check, path: 'src/new.ts', line: 1 }], risks: [] });
  const firstStep = { ...WRITE_STEP, output: v2('작성했어요', '고치기 전 가정을 확인') };
  const fixedStep = { write: { ...WRITE_STEP.write, 'src/new.ts': 'export const n = 2;\n' }, output: v2('고쳤어요', '빈 입력 처리를 확인') };
  const finding = { priority: 'P0' as const, code: 'logic_error' as const, path: 'src/new.ts', line: 1, title: '빈 입력에서 예외가 난다', detail: '입력이 비면 멈춘다', evidence: 'src/new.ts 1행' };
  let reviews = 0;
  const reviewReply = () => ({ status: 'succeeded' as const, output: { goal: 'met' as const, acceptance: [{ index: 0, status: 'met' as const }], reviewed_paths: ['src/a.ts', 'src/new.ts'],
    findings: reviews++ === 0 ? [finding] : [], summary: 's' } });
  const h = await changeHarness(d.db, { changeV2: true, steps: [firstStep, fixedStep], reviewReply });
  try {
    let held = false;
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    let staleSave: ArtifactSaveResult | undefined;
    h.restart({ instrument: deps => ({ ...deps, artifacts: {
      save: async (...args: Parameters<ChangeArtifactPort['save']>) => {
        if (args[0].round || held) return deps.artifacts.save(...args);
        held = true;
        await gate;
        staleSave = await deps.artifacts.save(...args);
        return staleSave;
      },
      load: deps.artifacts.load.bind(deps.artifacts),
    } }) });
    const stale = h.runtime;
    h.restart();
    await h.command('100', 'change', { target: REPO.fullName, text: REQUEST_TEXT });
    const id = await h.changeId();
    let stopping = false;
    const staleLoop = (async () => { while (!stopping) { await stale.laneTick(); await new Promise(resolve => setTimeout(resolve, 3)); } })();
    await until(() => held, 30_000);
    await h.pump(async () => (await d.raw.query(`SELECT 1 FROM change_requests r JOIN change_generations g ON g.change_id=r.id AND g.generation=r.generation
      WHERE r.id=$1 AND r.phase='authoring' AND g.fix_round=1`, [id])).rows.length === 1);
    stopping = true;
    release();
    await staleLoop;
    assert.deepEqual(staleSave, { ok: false, reason: 'phase_conflict' }, '앞 차례 작성 job의 늦은 저장은 거부된다');
    assert.equal(await h.phase(id), 'authoring', '앞 차례 결과가 새 차례를 snapshot_ready로 넘기지 않는다');
    assert.equal((await d.raw.query('SELECT 1 FROM change_artifacts WHERE change_id=$1', [id])).rows.length, 0, '앞 차례 artifact가 새 차례 자리에 없다');

    await h.pump(async () => await h.phase(id) === 'awaiting_publish_approval');
    assert.equal((await h.f.calls()).length, 2, '처음 작성 + 고치기 1번');
    const archived = (await d.raw.query<{ artifact_digest: string }>('SELECT artifact_digest FROM change_fix_rounds WHERE change_id=$1', [id])).rows[0]!.artifact_digest;
    const live = (await d.raw.query<{ artifact_digest: string }>('SELECT artifact_digest FROM change_artifacts WHERE change_id=$1', [id])).rows[0]!.artifact_digest;
    assert.notEqual(live, archived, '승인 대상은 새 차례 artifact다');
  } finally { await h.close(); await d.close(); }
});
test('C33 EVENT-02 실제 PostgreSQL: 게시 서버 둘이 같은 밀리초에 verify를 서명해 한쪽이 거부돼도 승인 대기까지 가고 시험 receipt는 passed 하나다', { skip }, async () => {
  const d = await bare();
  await runMigrations(d.raw);
  const h = await changeHarness(d.db, { sameMillisecondVerify: true });
  try {
    await h.command('100', 'change', { target: REPO.fullName, text: REQUEST_TEXT });
    const id = await h.changeId();
    const first = h.runtime;
    const firstReview = h.reviewRuntime;
    h.restart();
    const second = h.runtime;
    const secondReview = h.reviewRuntime;
    const both = async () => { await Promise.allSettled([first.childrenTick(), second.childrenTick(), first.laneTick(), second.laneTick(), first.publishTick(), second.publishTick(), firstReview.tick(), secondReview.tick()]); };
    for (let round = 0; round < 400 && !['awaiting_publish_approval', 'blocked'].includes(await h.phase(id)); round++) { await both(); await new Promise(resolve => setTimeout(resolve, 3)); }
    assert.equal(h.collisions.verify, 1, '두 verify가 같은 시각에 서명됐다');
    assert.equal(await h.phase(id), 'awaiting_publish_approval');
    assert.deepEqual((await h.db.query<{ status: string }>('SELECT status FROM change_verifications WHERE change_id=$1', [id])).rows.map(row => row.status), ['passed']);
    assert.equal((await h.f.calls()).length, 1);
    assert.equal(h.runs.verify, 1);
  } finally { await h.close(); await d.close(); }
});
test('T19 B5 굶주림·철회 실제 PostgreSQL: 끝난 관측과 오래된 proposed가 33개씩 있어도 새 요청이 진행하고, 승인 뒤 /revoke면 대조가 쓰지 않는다', { skip }, async () => {
  const d = await bare();
  await runMigrations(d.raw);
  const h = await changeHarness(d.db);
  try {
    await seedConversation(h.db);
    for (let index = 0; index < 33; index++) {
      const request = await driveTo(h.changes, 'observing_deploy');
      const at = Date.now() + 1000;
      ok(await h.changes.recordDeployment({ changeId: request.id, generation: 1, observation: { state: 'observed', headSha: git('h'), mergeCommit: git('m'), configCommit: git('k'), imageDigest: `sha256:${hex('d')}`, argoObservedAt: at, workloadObservedAt: at, observedAt: at, reason: null } }));
      await h.db.query('INSERT INTO change_deployment_windows(change_id,generation,started_at) VALUES ($1,1,$2)', [request.id, Date.now()]);
    }
    const waiting = new Set<string>();
    for (let index = 0; index < 33; index++) waiting.add((await driveTo(h.changes, 'proposed')).id);
    const polled = new Set<string>();
    h.restart({ instrument: deps => ({ ...deps, deployment: { readMerge: async input => {
      polled.add(input.target.key.changeId);
      return waiting.has(input.target.key.changeId) ? { state: 'open' } : deps.deployment.readMerge(input);
    }, observe: deps.deployment.observe.bind(deps.deployment) } }) });
    for (let round = 0; round < 4; round++) await h.runtime.publishTick();
    assert.equal(polled.size, 33, '커서가 끝까지 돈다');
    await h.command('100', 'change', { target: REPO.fullName, text: REQUEST_TEXT });
    const id = await h.changeId();
    await h.pump(async () => await h.phase(id) === 'awaiting_publish_approval', 300);
    await h.command('101', 'change-publish', { target: id, text: await digest(h, id) });
    await h.command('102', 'revoke', { target: OWNER });
    await h.runtime.reconcile();
    assert.equal(h.env.github.mutations().length, 0);
    assert.equal(await h.phase(id), 'cancelled');
  } finally { await h.close(); await d.close(); }
});
test('T19 B5 DATA-01 실제 PostgreSQL: CHANGE 답의 원문은 events에 없고 작성자 재개가 읽는 자리에는 있다', { skip }, async () => {
  const d = await bare();
  await runMigrations(d.raw);
  const h = await changeHarness(d.db, { steps: [QUESTION, WRITE_STEP] });
  try {
    await h.command('100', 'change', { target: REPO.fullName, text: REQUEST_TEXT });
    const id = await h.changeId();
    await h.pump(async () => (await h.db.query(`SELECT 1 FROM codex_questions WHERE state='open'`)).rows.length > 0);
    const question = (await h.db.query<{ id: string }>(`SELECT id FROM codex_questions WHERE state='open'`)).rows[0]!.id;
    const canary = ['fixture', 'answer', 'canary', '42b1'].join('-');
    await h.command('101', 'answer', { target: question, text: `label=public | ${canary}` });
    assert.ok(!JSON.stringify((await h.db.query('SELECT payload FROM events')).rows).includes(canary));
    await h.pump(async () => await h.phase(id) === 'awaiting_publish_approval');
    assert.ok((await h.f.calls())[1]!.input.includes(canary));
  } finally { await h.close(); await d.close(); }
});
test('T19 B5 EVENT-02 실제 PostgreSQL: 프로세스가 죽어 lease가 끝난 뒤 새 프로세스가 되찾아 끝내고 레인을 연다', { skip }, async () => {
  const d = await bare();
  await runMigrations(d.raw);
  const h = await changeHarness(d.db);
  try {
    await h.command('100', 'change', { target: REPO.fullName, text: REQUEST_TEXT });
    const id = await h.changeId();
    await h.pump(async () => (await h.db.query(`SELECT 1 FROM codex_sessions WHERE state='running'`)).rows.length > 0);
    await h.db.query(`UPDATE jobs SET lease_until=1 WHERE type='task'`);
    await h.store.expire();
    assert.equal(await childState(h, id), 'unknown');
    h.restart();
    await h.pump(async () => await h.phase(id) === 'awaiting_publish_approval');
    assert.equal((await h.f.calls()).length, 1);
    await h.pump(async () => await childState(h, id) === 'succeeded');
    assert.equal(await h.store.laneBusy('task'), false);
    assert.equal(await h.store.syncTaskLane(), null);
  } finally { await h.close(); await d.close(); }
});
test('T19 B5 호환 실제 PostgreSQL: 016까지 적용된 DB를 018로 올려도 기존 행이 그대로이고 artifact는 비우는 변경만 받는다', { skip }, async () => {
  const d = await bare();
  try {
    for (const file of MIGRATIONS.filter(name => migrationVersion(name) <= 16)) await d.raw.query(await readFile(`migrations/${file}`, 'utf8'));
    await d.raw.query(`INSERT INTO conversations(id,owner_id,scope,channel_id,created_at,active) VALUES ('c','o','{}'::jsonb,'c',1,true)`);
    assert.deepEqual(await runMigrations(d.raw), [17, 18, 19, 20, 21, 22, 23, 24, 25, 26, 27, 28, 29]);
    assert.equal((await d.raw.query(`SELECT 1 FROM conversations WHERE id='c'`)).rows.length, 1);
    assert.deepEqual(await runMigrations(d.raw), []);
    const h = await changeHarness(d.db);
    try {
      await h.command('100', 'change', { target: REPO.fullName, text: REQUEST_TEXT });
      const id = await h.changeId();
      await h.pump(async () => await h.phase(id) === 'awaiting_publish_approval');
      await assert.rejects(d.raw.query(`UPDATE change_artifacts SET patch='x' WHERE change_id=$1`, [id]), /change_evidence_immutable/);
      await assert.rejects(d.raw.query(`UPDATE change_artifacts SET patch='',purged_at=1,label='public',result_tree=$2 WHERE change_id=$1`, [id, 'd'.repeat(40)]), /change_evidence_immutable/);
      assert.equal((await d.raw.query(`UPDATE change_artifacts SET patch='',purged_at=1 WHERE change_id=$1`, [id])).rowCount, 1);
      await assert.rejects(d.raw.query(`UPDATE change_artifacts SET purged_at=2 WHERE change_id=$1`, [id]), /change_evidence_immutable/);
    } finally { await h.close(); }
  } finally { await d.close(); }
});
