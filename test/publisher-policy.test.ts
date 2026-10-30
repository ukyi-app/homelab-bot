import { after, before, beforeEach, test } from 'node:test';
import assert from 'node:assert/strict';
import { Denied } from '../src/contracts.js';
import { PolicyGate, loadRuntimePolicy } from '../src/policy.js';
import { localDatabase, fixture, thread } from './helpers.js';

// D1(사용자 2026-10-30): 정책은 env RUNTIME_POLICIES를 기동 때 한 번 읽는다. 값 변경은 파드 재시작으로,
// 즉시 차단은 /revoke(DB 거부 목록)로 한다. 읽은 뒤 시간이 지났다는 이유로 닫지 않는다.
let database: Awaited<ReturnType<typeof localDatabase>>;
let f: Awaited<ReturnType<typeof fixture>>;
before(async () => { database = await localDatabase(); });
after(async () => { await database.pg.close(); });
beforeEach(async () => {
  await database.pg.exec('TRUNCATE audit,denied_actors RESTART IDENTITY CASCADE');
  f = await fixture(database.db);
});
const policyJson = (overrides: Record<string, unknown> = {}) => {
  const { confirmedAt: _, ...rest } = f.policy;
  return JSON.stringify({ ...rest, ...overrides });
};

test('AUTH-02 D1 기동 때 읽은 정책은 300초·하루가 지나도 닫히지 않음', async () => {
  await f.gate.authorize('fixture-owner', thread);
  f.advance(300_001);
  await f.gate.authorize('fixture-owner', thread);
  f.advance(86_400_000);
  await f.gate.authorize('fixture-owner', thread);
});

test('AUTH-02 D1 loadRuntimePolicy는 읽은 시각을 confirmedAt으로 넣고 그 뒤 값이 바뀌어도 다시 읽지 않음', async () => {
  const raw = policyJson();
  const policy = loadRuntimePolicy(raw, f.now());
  assert.equal(policy.confirmedAt, f.now());
  assert.ok(Object.isFrozen(policy) && Object.isFrozen(policy.services));
  const gate = PolicyGate.fixed(policy, database.db, f.now);
  f.advance(3_600_000);
  assert.equal((await gate.authorize('fixture-owner', thread)).revision, 'fixture-v1');
  // 원본 문자열을 다시 읽지 않는다(재시작 전까지 같은 값).
  assert.equal((await gate.current()).owner, 'fixture-owner');
});

test('AUTH-02 D1 RUNTIME_POLICIES 형식 오류는 기동 실패, 오류에는 필드 이름만 있고 값은 없음', () => {
  const secretLike = 'fixture-secret-owner-value';
  for (const [raw, field] of [
    ['{', 'json'],
    [policyJson({ owner: '' }), 'owner'],
    [policyJson({ owner: undefined }), 'owner'],
    [policyJson({ guild: 7 }), 'guild'],
    [policyJson({ confirmedAt: 1 }), 'confirmedAt'],
    [policyJson({ extra: secretLike }), 'unknown_field(1)'],
    [policyJson({ services: [secretLike, 3] }), 'services.1'],
    [JSON.stringify([secretLike]), '(root)'],
  ] as const) {
    assert.throws(() => loadRuntimePolicy(raw, f.now()), (error: Error) => {
      assert.match(error.message, /^runtime_policies_invalid: /);
      assert.ok(error.message.includes(field), `${error.message} / ${field}`);
      assert.ok(!error.message.includes(secretLike) && !error.message.includes('fixture-guild'), error.message);
      return true;
    });
  }
});

test('P3-6 정책의 모르는 키 이름은 값처럼 다뤄 오류에 싣지 않고 unknown_field 개수만 남김', () => {
  const leak = 'fixture-secret-used-as-key';
  for (const [raw, expected] of [
    [policyJson({ [leak]: true }), 'runtime_policies_invalid: unknown_field(1)'],
    [policyJson({ [leak]: true, [`${leak}-2`]: 1 }), 'runtime_policies_invalid: unknown_field(2)'],
    [policyJson({ [leak]: true, owner: '' }), 'runtime_policies_invalid: unknown_field(1),owner'],
  ] as const) {
    assert.throws(() => loadRuntimePolicy(raw, f.now()), (error: Error) => {
      assert.ok(!error.message.includes(leak), error.message);
      const fields = (message: string) => message.replace(/^runtime_policies_invalid: /, '').split(',').sort();
      assert.match(error.message, /^runtime_policies_invalid: /);
      assert.deepEqual(fields(error.message), fields(expected));
      return true;
    });
  }
});

test('AUTH-02 D1 /revoke 즉시 차단은 재시작에도 남고, 새 revision + revocationRestores + 철회 뒤 기동일 때만 풀림', async () => {
  const boot = loadRuntimePolicy(policyJson(), f.now());
  const gate = PolicyGate.fixed(boot, database.db, f.now);
  f.advance(1000);
  await gate.revoke('fixture-owner', thread, 'fixture-owner');
  await assert.rejects(gate.authorize('fixture-owner', thread), Denied);
  const denial = (await database.db.query<{ denial_id: string }>('SELECT denial_id FROM denied_actors')).rows[0]!.denial_id;
  f.advance(1000);
  // 같은 값으로 재시작: 풀리지 않는다.
  await assert.rejects(PolicyGate.fixed(loadRuntimePolicy(policyJson(), f.now()), database.db, f.now).authorize('fixture-owner', thread), Denied);
  // 해제 목록만 있고 revision이 같으면 풀리지 않는다.
  await assert.rejects(PolicyGate.fixed(loadRuntimePolicy(policyJson({ revocationRestores: [denial] }), f.now()), database.db, f.now)
    .authorize('fixture-owner', thread), Denied);
  // 새 revision과 해제 목록을 담아 다시 기동하면(읽은 시각이 철회 뒤) 풀린다.
  const restored = PolicyGate.fixed(loadRuntimePolicy(policyJson({ revision: 'fixture-v2', revocationRestores: [denial] }), f.now()), database.db, f.now);
  assert.equal((await restored.authorize('fixture-owner', thread)).revision, 'fixture-v2');
});

test('AUTH-02 D1 철회보다 먼저 읽은 정책은 해제 목록이 있어도 풀지 않음', async () => {
  const early = f.now();
  f.advance(1000);
  await f.gate.revoke('fixture-owner', thread, 'fixture-owner');
  const denial = (await database.db.query<{ denial_id: string }>('SELECT denial_id FROM denied_actors')).rows[0]!.denial_id;
  const stale = PolicyGate.fixed(loadRuntimePolicy(policyJson({ revision: 'fixture-v2', revocationRestores: [denial] }), early), database.db, f.now);
  await assert.rejects(stale.authorize('fixture-owner', thread), Denied);
});
