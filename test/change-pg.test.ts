import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { EFFECT_LEASE_MS } from '../src/change-contracts.js';
import type { EffectStage } from '../src/change-contracts.js';
import { ChangePublisher } from '../src/change-publisher.js';
import { Postgres } from '../src/database.js';
import { runMigrations } from '../src/migrate-main.js';
import { ok } from './change-store-fixture.js';
import { publishEnv } from './change-github-fake.js';

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
      assert.deepEqual(await new ChangePublisher({ store: d.env.store, writer: d.env.writerIO.writer, preflight: d.env.writerIO.preflight, policy: async () => d.env.policy.current, now: () => d.env.clock.now, retryMs: 60_000 }).publish(key), { kind: 'busy' });

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
