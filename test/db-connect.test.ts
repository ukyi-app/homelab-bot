import { test } from 'node:test';
import assert from 'node:assert/strict';
import type pg from 'pg';
import { transientConnectError, withConnectRetry } from '../src/db-connect.js';
import { runMigrations } from '../src/migrate-main.js';

const refused = () => Object.assign(new Error('connect'), { code: 'ECONNREFUSED' });
// 가짜 시계: sleep이 시간을 앞으로 민다. 실제로 기다리지 않는다.
function clock() {
  let t = 0; const waits: number[] = [];
  return { now: () => t, sleep: async (ms: number) => { waits.push(ms); t += ms; }, waits };
}

test('T16b 새 파드 첫 접속 거부(ECONNREFUSED)는 짧게 다시 시도해 성공', async () => {
  const c = clock(); let calls = 0; const retries: number[] = [];
  const value = await withConnectRetry(async () => { if (++calls < 3) throw refused(); return 'ok'; },
    { now: c.now, sleep: c.sleep, onRetry: attempt => retries.push(attempt) });
  assert.equal(value, 'ok');
  assert.equal(calls, 3);
  assert.deepEqual(c.waits, [250, 500]);
  assert.deepEqual(retries, [1, 2]);
});

test('T16b 연결 단계가 아닌 오류(인증 28P01)는 다시 시도하지 않음', async () => {
  const c = clock(); let calls = 0;
  const auth = Object.assign(new Error('password authentication failed'), { code: '28P01' });
  await assert.rejects(withConnectRetry(async () => { calls++; throw auth; }, { now: c.now, sleep: c.sleep }), auth);
  assert.equal(calls, 1);
  assert.deepEqual(c.waits, []);
});

test('T16b 계속 거부되면 deadline 안에서 멈추고 마지막 오류를 던짐', async () => {
  const c = clock(); let calls = 0;
  await assert.rejects(withConnectRetry(async () => { calls++; throw refused(); },
    { deadlineMs: 3_000, now: c.now, sleep: c.sleep }), { code: 'ECONNREFUSED' });
  assert.ok(c.waits.reduce((a, b) => a + b, 0) <= 3_000, `waited ${c.waits.join(',')}`);
  assert.deepEqual(c.waits, [250, 500, 1_000]);
  assert.equal(calls, 4);
});

test('T16b 연결 오류 코드는 cause에 있어도 알아봄', () => {
  assert.equal(transientConnectError(new Error('x', { cause: refused() })), true);
  assert.equal(transientConnectError(Object.assign(new Error('x'), { code: '42P01' })), false);
  assert.equal(transientConnectError(null), false);
});

test('T16b runMigrations는 첫 연결이 거부돼도 같은 프로세스에서 다시 연결', async () => {
  // 연결은 한 번 거부되고 두 번째에 열린다. 그 뒤 첫 질의에서 멈춰 재연결 배선만 본다(DB 없이).
  let connects = 0; const stop = new Error('stop_after_connect');
  const pool = { connect: async () => {
    if (++connects === 1) throw refused();
    return { query: async () => { throw stop; }, release: () => {} };
  } } as unknown as pg.Pool;
  await assert.rejects(runMigrations(pool), stop);
  assert.equal(connects, 2);
});

test('T16b node-pg 연결 시간 초과·연결 중 끊김(코드 없음)도 다시 시도, SQLSTATE 오류는 아님', async () => {
  for (const message of ['Connection terminated due to connection timeout', 'timeout expired', 'Connection terminated unexpectedly']) {
    assert.equal(transientConnectError(new Error(message)), true, message);
  }
  // pg-pool은 원인을 cause에 싣는다.
  assert.equal(transientConnectError(new Error('wrapper', { cause: new Error('timeout expired') })), true);
  assert.equal(transientConnectError(Object.assign(new Error('Connection terminated unexpectedly'), { code: '57P01' })), false);
  assert.equal(transientConnectError(new Error('relation "x" does not exist')), false);
  const c = clock(); let calls = 0;
  const value = await withConnectRetry(async () => {
    if (++calls < 2) throw new Error('Connection terminated due to connection timeout');
    return 'ok';
  }, { now: c.now, sleep: c.sleep });
  assert.equal(value, 'ok');
  assert.deepEqual(c.waits, [250]);
});
