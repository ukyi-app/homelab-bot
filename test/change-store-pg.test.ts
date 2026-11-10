import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import pg from 'pg';
import { CHANGE_AMENDMENT } from '../src/change-contracts.js';
import { ChangePrivateInputs, ChangeStore } from '../src/change-store.js';
import type { StoreResult } from '../src/change-store.js';
import { MIGRATIONS, Postgres, appliedMigrations, migrationVersion } from '../src/database.js';
import { runMigrations } from '../src/migrate-main.js';
import {
  CONVERSATION, OWNER, REPO_ID, driveTo, fixtureExpected, fixtureResult, fixtureReview, git, hex, insertChildJob, newEvent, ok, seedConversation,
} from './change-store-fixture.js';

// 실제 PostgreSQL(18) 시험. HOMELAB_TEST_PG_SOCKET(유닉스 소켓 디렉터리)이 없으면 건너뛴다. 실행 방법은 VERIFICATION T20 절과 같다.
const socket = process.env.HOMELAB_TEST_PG_SOCKET;
const skip = socket ? false : 'HOMELAB_TEST_PG_SOCKET 없음(로컬 PostgreSQL 필요)';
const CONCURRENCY = 8;

async function adminPool() { return new pg.Pool({ host: socket, user: 'postgres', database: 'postgres', max: 1 }); }
async function emptyDatabase() {
  const admin = await adminPool();
  const name = `t19b0_${randomUUID().replaceAll('-', '').slice(0, 12)}`;
  await admin.query(`CREATE DATABASE ${name}`);
  const pools: pg.Pool[] = [];
  const pool = (max: number) => { const p = new pg.Pool({ host: socket, user: 'postgres', database: name, max }); pools.push(p); return p; };
  return { pool, close: async () => {
    await Promise.all(pools.map(p => p.end()));
    for (let attempt = 0; ; attempt++) {
      try { await admin.query(`DROP DATABASE ${name}`); break; } catch (error) {
        if (attempt >= 50 || !/being accessed by other users/.test((error as Error).message)) throw error;
        await new Promise(resolve => setTimeout(resolve, 100));
      }
    }
    await admin.end();
  } };
}
async function database() {
  const d = await emptyDatabase();
  const raw = d.pool(CONCURRENCY + 2);
  await runMigrations(raw);
  const db = new Postgres(raw);
  await seedConversation(db);
  return { raw, db, store: new ChangeStore(db), close: d.close };
}
const parallel = <T>(work: () => Promise<T>, n = CONCURRENCY) => Promise.all(Array.from({ length: n }, work));
const reasons = <T>(results: StoreResult<T>[]) => results.filter(r => !r.ok).map(r => (r as { reason: string }).reason);
const wins = <T>(results: StoreResult<T>[]) => results.filter(r => r.ok).length;
const number = async (raw: pg.Pool, sql: string, params: unknown[] = []) => Number((await raw.query<{ n: string }>(`SELECT count(*)::text AS n FROM ${sql}`, params)).rows[0]!.n);
// 잠금 대기가 길어져 busy가 나면 경합 시험의 판정을 흐린다. 허용 사유 밖의 값이면 실패한다.
const onlyLost = (found: string[], allowed: string[]) => { for (const reason of found) assert.ok(allowed.includes(reason), reason); };

test('T19 B0 실제 PostgreSQL: 같은 전이를 동시에 시도하면 하나만 성공하고 감사도 한 건이다', { skip }, async () => {
  const d = await database();
  try {
    for (let round = 0; round < 5; round++) {
      const r = await driveTo(d.store, 'requested');
      const results = await parallel(() => d.store.transition({ changeId: r.id, generation: 1, from: 'requested', to: 'cancelled', reason: 'user_cancelled' }));
      assert.equal(wins(results), 1);
      onlyLost(reasons(results), ['phase_conflict']);
      assert.equal(await number(d.raw, `audit WHERE subject=$1 AND kind='change_phase'`, [r.id]), 1);
    }
  } finally { await d.close(); }
});

test('T19 B0 실제 PostgreSQL: 다른 전이가 동시에 와도 한 끝 상태만 남는다', { skip }, async () => {
  const d = await database();
  try {
    const r = await driveTo(d.store, 'approved');
    const key = { changeId: r.id, generation: 1 };
    const results = await Promise.all([
      d.store.transition({ ...key, from: 'approved', to: 'publishing', reason: null }),
      d.store.transition({ ...key, from: 'approved', to: 'cancelled', reason: 'user_cancelled' }),
      d.store.invalidateEvidence({ ...key, from: 'approved', to: 'superseded', reason: 'base_moved' }),
      d.store.transition({ ...key, from: 'approved', to: 'blocked', reason: 'policy_changed' }),
    ]);
    assert.equal(wins(results), 1);
    onlyLost(reasons(results), ['phase_conflict']);
    const row = ok(await d.store.get(r.id));
    assert.equal(results.find(result => result.ok && result.value.phase === row.phase) !== undefined, true);
  } finally { await d.close(); }
});

test('T19 B0 실제 PostgreSQL: 같은 effect를 동시에 claim하면 한 lease만 나온다', { skip }, async () => {
  const d = await database();
  try {
    for (let round = 0; round < 5; round++) {
      const r = await driveTo(d.store, 'publishing');
      const key = { changeId: r.id, generation: 1, stage: 'blob' as const };
      ok(await d.store.recordEffectIntent({ ...key, requestDigest: hex('r'), expected: fixtureExpected('blob', r.id) }));
      const results = await parallel(() => d.store.claimEffect(key));
      assert.equal(wins(results), 1);
      onlyLost(reasons(results), ['effect_conflict']);
      const rows = (await d.raw.query(`SELECT state,attempt FROM change_delivery_effects WHERE change_id=$1`, [r.id])).rows;
      assert.deepEqual(rows, [{ state: 'sending', attempt: 1 }]);
    }
  } finally { await d.close(); }
});

test('T19 B0 실제 PostgreSQL: 같은 intent를 동시에 기록하면 한 행이고 다른 digest는 충돌로 거부된다', { skip }, async () => {
  const d = await database();
  try {
    const r = await driveTo(d.store, 'publishing');
    const key = { changeId: r.id, generation: 1, stage: 'blob' as const, expected: fixtureExpected('blob', r.id) };
    const same = await parallel(() => d.store.recordEffectIntent({ ...key, requestDigest: hex('r') }));
    assert.equal(wins(same), CONCURRENCY);
    assert.equal(same.filter(result => result.ok && result.value.created).length, 1);
    assert.equal(await number(d.raw, 'change_delivery_effects WHERE change_id=$1', [r.id]), 1);
    const other = await parallel(() => d.store.recordEffectIntent({ ...key, requestDigest: hex('other') }));
    assert.equal(wins(other), 0);
    onlyLost(reasons(other), ['effect_conflict']);
  } finally { await d.close(); }
});

test('T19 B0 실제 PostgreSQL: 같은 이벤트 ID로 동시에 만들어도 change·입력·승인이 하나다', { skip }, async () => {
  const d = await database();
  try {
    const eventId = newEvent();
    const created = await parallel(() => d.store.createRequest({ eventId, ownerId: OWNER, conversationId: CONVERSATION,
      scope: { guild: 'g', channel: 'c', parent: 'p', kind: 'thread' }, repoId: REPO_ID, baseBranch: 'main', label: 'public', input: { text: '요청' } }));
    assert.equal(wins(created), 1);
    onlyLost(reasons(created), ['duplicate_event']);
    assert.equal(await number(d.raw, 'change_requests WHERE event_id=$1', [eventId]), 1);
    assert.equal(await number(d.raw, 'change_request_inputs WHERE event_id=$1', [eventId]), 1);

    const inputs = new ChangePrivateInputs(d.db);
    const id = ok(created.find(result => result.ok)!).id;
    const answerId = newEvent();
    const answers = await parallel(() => inputs.record({ changeId: id, generation: 1, eventId: answerId, label: 'public', text: '답변' }));
    assert.equal(wins(answers), 1);
    onlyLost(reasons(answers), ['duplicate_event']);

    const awaiting = await driveTo(d.store, 'awaiting_publish_approval');
    const key = { changeId: awaiting.id, generation: 1 };
    const { digest } = ok(await d.store.approvalSubject(key));
    const approveEvent = newEvent();
    const approvals = await parallel(() => d.store.approve({ ...key, approvalDigest: digest, eventId: approveEvent, actor: OWNER }));
    assert.equal(wins(approvals), 1);
    onlyLost(reasons(approvals), ['duplicate_event', 'phase_conflict']);
    assert.equal(await number(d.raw, 'change_approvals WHERE change_id=$1', [awaiting.id]), 1);

    // 이벤트 ID가 달라도 승인은 하나만 산다.
    const other = await driveTo(d.store, 'awaiting_publish_approval');
    const otherKey = { changeId: other.id, generation: 1 };
    const otherDigest = ok(await d.store.approvalSubject(otherKey)).digest;
    const distinct = await parallel(() => d.store.approve({ ...otherKey, approvalDigest: otherDigest, eventId: newEvent(), actor: OWNER }));
    assert.equal(wins(distinct), 1);
    onlyLost(reasons(distinct), ['phase_conflict']);
    assert.equal(await number(d.raw, 'change_approvals WHERE change_id=$1 AND invalidated_at IS NULL', [other.id]), 1);
  } finally { await d.close(); }
});

test('T19 B0 실제 PostgreSQL: claim과 취소가 겹쳐도 취소 뒤에 시작된 전송이 없다', { skip }, async () => {
  const d = await database();
  try {
    let claimedFirst = 0;
    let cancelledFirst = 0;
    for (let round = 0; round < 20; round++) {
      const r = await driveTo(d.store, 'publishing');
      const key = { changeId: r.id, generation: 1, stage: 'blob' as const };
      ok(await d.store.recordEffectIntent({ ...key, requestDigest: hex('r'), expected: fixtureExpected('blob', r.id) }));
      const [claim, cancel] = await Promise.all([
        d.store.claimEffect(key),
        d.store.transition({ changeId: r.id, generation: 1, from: 'publishing', to: 'cancelled', reason: 'user_cancelled' }),
      ]);
      ok(cancel);
      const state = (await d.raw.query<{ state: string }>(`SELECT state FROM change_delivery_effects WHERE change_id=$1`, [r.id])).rows[0]!.state;
      if (claim.ok) { claimedFirst++; assert.equal(state, 'sending'); }
      else {
        cancelledFirst++;
        assert.equal(claim.reason, 'phase_conflict');
        assert.equal(state, 'blocked');
      }
    }
    assert.equal(claimedFirst + cancelledFirst, 20);
  } finally { await d.close(); }
});

test('T19 B0 실제 PostgreSQL: 승인과 무효화가 겹쳐도 무효화 뒤에 살아 있는 승인이 남지 않는다', { skip }, async () => {
  const d = await database();
  try {
    for (let round = 0; round < 10; round++) {
      const r = await driveTo(d.store, 'awaiting_publish_approval');
      const key = { changeId: r.id, generation: 1 };
      const { digest } = ok(await d.store.approvalSubject(key));
      const [approval, invalidation] = await Promise.all([
        d.store.approve({ ...key, approvalDigest: digest, eventId: newEvent(), actor: OWNER }),
        d.store.invalidateEvidence({ ...key, from: 'awaiting_publish_approval', to: 'superseded', reason: 'base_moved' }),
      ]);
      const phase = ok(await d.store.get(r.id)).phase;
      if (invalidation.ok) {
        assert.equal(approval.ok, false);
        assert.equal(phase, 'superseded');
        assert.equal(await number(d.raw, 'change_approvals WHERE change_id=$1', [r.id]), 0);
      } else {
        assert.equal(approval.ok, true);
        assert.equal(phase, 'approved');
      }
    }
  } finally { await d.close(); }
});

test('T19 B0 실제 PostgreSQL: 새 generation을 동시에 열어도 한 번만 올라간다', { skip }, async () => {
  const d = await database();
  try {
    const r = await driveTo(d.store, 'admitted');
    ok(await d.store.transition({ changeId: r.id, generation: 1, from: 'admitted', to: 'blocked', reason: 'fixture' }));
    const blocked = await d.store.startNextGeneration({ changeId: r.id, generation: 1 });
    assert.equal(blocked.ok, false, 'blocked는 새 generation을 열지 않는다');

    const s = await driveTo(d.store, 'approved');
    ok(await d.store.invalidateEvidence({ changeId: s.id, generation: 1, from: 'approved', to: 'superseded', reason: 'base_moved' }));
    const results = await parallel(() => d.store.startNextGeneration({ changeId: s.id, generation: 1 }));
    assert.equal(wins(results), 1);
    onlyLost(reasons(results), ['phase_conflict']);
    assert.equal(ok(await d.store.get(s.id)).generation, 2);
  } finally { await d.close(); }
});

test('C31 실제 PostgreSQL: 고치기 차례를 두 연결이 동시에 열어도 차례는 하나만 생기고, 취소와 겹치면 한쪽만 이긴다', { skip }, async () => {
  const d = await database();
  try {
    const open = async () => {
      const r = await driveTo(d.store, 'reviewing');
      const key = { changeId: r.id, generation: 1 };
      const jobId = `fixture-review-${r.id}-r0`;
      await insertChildJob(d.db, jobId);
      ok(await d.store.linkChildJob({ ...key, jobId, role: 'review' }));
      const bundle = ok(await d.store.evidenceBundle(key));
      ok(await d.store.recordReview({ ...key, receipt: fixtureReview({ bundle, jobId, verdict: 'blocked', risks: [{ priority: 'P1', category: 'correctness', code: 'logic_error' }] }) }));
      return { key, jobId };
    };
    const first = await open();
    const results = await parallel(() => d.store.startSelfFix({ ...first.key, reviewJobId: first.jobId }));
    assert.equal(wins(results), 1);
    onlyLost(reasons(results), ['phase_conflict']);
    assert.equal(await number(d.raw, 'change_fix_rounds WHERE change_id=$1', [first.key.changeId]), 1);
    assert.equal(ok(await d.store.generationRecord(first.key)).fixRound, 1);

    const second = await open();
    const raced: StoreResult<unknown>[] = await Promise.all([
      d.store.startSelfFix({ ...second.key, reviewJobId: second.jobId }),
      d.store.transition({ ...second.key, from: 'reviewing', to: 'cancelled', reason: 'owner_cancelled' }),
    ]);
    assert.equal(wins(raced), 1);
    const phase = ok(await d.store.get(second.key.changeId)).phase;
    const rounds = await number(d.raw, 'change_fix_rounds WHERE change_id=$1', [second.key.changeId]);
    assert.deepEqual([phase, rounds], raced[0]!.ok ? ['authoring', 1] : ['cancelled', 0]);
  } finally { await d.close(); }
});

test('C27 실제 PostgreSQL: 수정 요청이 동시에 확정돼도 차례 번호가 겹치지 않고 상한을 넘지 않으며, 동시에 열어도 차례는 하나만 돈다', { skip }, async () => {
  const d = await database();
  try {
    const r = await driveTo(d.store, 'proposed');
    const key = { changeId: r.id, generation: 1 };
    const request = () => d.store.requestAmendment({ ...key, eventId: newEvent(), actor: OWNER, pullNumber: 7, head: git('h'), materials: ['comment:1'],
      instruction: '리뷰 반영', label: 'public' });
    const first = await parallel(request, 2);
    assert.equal(wins(first), 2);
    const started = await parallel(() => d.store.startAmendment(key));
    assert.equal(wins(started), 1);
    onlyLost(reasons(started), ['phase_conflict']);
    assert.equal(ok(await d.store.get(r.id)).phase, 'amending');
    assert.equal(await number(d.raw, `change_amendments WHERE change_id=$1 AND state='running'`, [r.id]), 1);
    // 상한 근처에서 동시에 와도 11번째는 생기지 않는다.
    const rest = await parallel(request, CHANGE_AMENDMENT.maxRounds);
    assert.equal(wins(rest), CHANGE_AMENDMENT.maxRounds - 2);
    onlyLost(reasons(rest), ['amendment_limit']);
    assert.deepEqual((await d.store.amendments(key)).map(round => round.round), Array.from({ length: CHANGE_AMENDMENT.maxRounds }, (_, i) => i + 1));
  } finally { await d.close(); }
});

test('T19 B0 실제 PostgreSQL: 같은 응답의 확정을 동시에 처리해도 한 번만 confirmed다', { skip }, async () => {
  const d = await database();
  try {
    const r = await driveTo(d.store, 'publishing');
    const key = { changeId: r.id, generation: 1, stage: 'blob' as const };
    ok(await d.store.recordEffectIntent({ ...key, requestDigest: hex('r'), expected: fixtureExpected('blob', r.id) }));
    const claim = ok(await d.store.claimEffect(key));
    ok(await d.store.markEffectUnknown({ ...key, leaseId: claim.leaseId, code: 'response_lost' }));
    const results = await parallel(() => d.store.confirmEffect({ ...key, leaseId: null, result: fixtureResult('blob', r.id) }));
    assert.equal(wins(results), 1);
    onlyLost(reasons(results), ['effect_conflict']);
  } finally { await d.close(); }
});

test('T19 B0 실제 PostgreSQL: 016 DB 업그레이드는 017만 적용하고 진입점을 다시 돌려도 빈 목록이다', { skip }, async () => {
  const d = await emptyDatabase();
  try {
    const raw = d.pool(2);
    for (const file of MIGRATIONS.filter(name => migrationVersion(name) <= 16)) await raw.query(await readFile(`migrations/${file}`, 'utf8'));
    await seedConversation(new Postgres(raw));
    assert.deepEqual(await runMigrations(raw), [17, 18, 19, 20, 21, 22, 23, 24, 25, 26, 27]);
    assert.deepEqual(await runMigrations(raw), []);
    assert.equal((await appliedMigrations(new Postgres(raw))).size, MIGRATIONS.length);
    await raw.query(await readFile('migrations/017_change_pr.sql', 'utf8'));
    const store = new ChangeStore(new Postgres(raw));
    assert.equal((await driveTo(store, 'proposed')).phase, 'proposed');
  } finally { await d.close(); }
});

test('T19 B0 실제 PostgreSQL: 마이그레이션 Job 둘이 겹쳐도 017은 한 번만 적용된다', { skip }, async () => {
  const d = await emptyDatabase();
  try {
    const results = await Promise.all([runMigrations(d.pool(1)), runMigrations(d.pool(1))]);
    assert.deepEqual(results.map(r => r.includes(17)).sort(), [false, true]);
  } finally { await d.close(); }
});
