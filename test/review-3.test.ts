import { after, before, beforeEach, test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { once } from 'node:events';
import type { AddressInfo } from 'node:net';
import type pg from 'pg';
import { DEFAULTS, Denied, RateLimited } from '../src/contracts.js';
import type { Job } from '../src/contracts.js';
import { DiscordPublisher } from '../src/discord.js';
import { AlertIngress } from '../src/alerts.js';
import { WorkerSigner, WorkerVerifier, SerialWorker, workerRequest } from '../src/worker.js';
import type { WorkerResult } from '../src/worker.js';
import { HttpWorker, workerServer } from '../src/worker-http.js';
import { Postgres } from '../src/database.js';
import { ReadAdapter, readSummary } from '../src/read.js';
import { Runtime } from '../src/runtime.js';
import { messagePages } from '../src/format.js';
import { event, fixture, localDatabase, service, template, thread } from './helpers.js';

let database: Awaited<ReturnType<typeof localDatabase>>;
let f: Awaited<ReturnType<typeof fixture>>;
const success: WorkerResult = { status: 'succeeded', stopped: true, answer: { facts: [], hypotheses: [], unknowns: [], checks: [] } };
const parent = { ...thread, kind: 'channel' as const, channel: thread.parent!, parent: null };
before(async () => { database = await localDatabase(); });
beforeEach(async () => {
  await database.pg.exec('TRUNCATE events,conversations,jobs,results,outbox,schedules,denied_actors,controls,audit,incidents RESTART IDENTITY CASCADE');
  f = await fixture(database.db);
});
after(async () => { await database.pg.close(); });
async function rows(table: string) { return (await database.db.query<Record<string, any>>(`SELECT * FROM ${table}`)).rows; }
async function queue(id = 'first') { await f.ingress.receive(event(id)); f.advance(DEFAULTS.debounceMs + 50); }
async function enqueue(key = 'delivery') {
  await f.store.enqueue({ key, actor: f.policy.owner, scope: thread, revision: f.policy.revision,
    payload: { kind: 'message', channel: thread.channel, content: '확인된 요약', classification: 'safe_summary' } });
}

for (const state of ['pending', 'unknown']) test(`4313740724 read 서비스 철회는 ${state} 결과 게시·대조 차단`, async () => {
  await f.ingress.receive(event('read', { kind: 'command', command: 'read', target: service.id, text: template.id }));
  f.advance(DEFAULTS.debounceMs + 50); await f.runtime.tickRead();
  assert.deepEqual((await rows('outbox'))[0]!.service_ids, [service.id]);
  await database.db.query('UPDATE outbox SET state=$1,lease_token=$2', [state, randomUUID()]);
  f.policy.services = []; f.policy.revision = 'removed-service';
  let searched = 0; f.rest.findDelivery = async () => { searched++; return undefined; };
  const publisher = new DiscordPublisher(f.store, f.gate, f.rest);
  if (state === 'pending') await publisher.deliver(); else await publisher.reconcile();
  assert.equal((await rows('outbox'))[0]!.state, 'blocked');
  assert.equal(f.rest.messages.length, 0); assert.equal(searched, 0);
});
test('4313740724 이전 read outbox도 migration으로 서비스 경계 복원', async () => {
  await f.ingress.receive(event('read', { kind: 'command', command: 'read', target: service.id, text: template.id }));
  f.advance(DEFAULTS.debounceMs + 50); await f.runtime.tickRead(); await database.db.query("UPDATE outbox SET service_ids='[]'");
  await f.ingress.receive(event('unregistered', { kind: 'command', command: 'read', target: 'unregistered', text: template.id }));
  f.advance(DEFAULTS.debounceMs + 50); await f.runtime.tickRead();
  const sql = await readFile('migrations/004_delivery_services.sql', 'utf8');
  await database.pg.exec(sql); await database.pg.exec(sql);
  const deliveries = await rows('outbox');
  assert.deepEqual(deliveries.find(row => row.payload.content.includes(`대상: ${service.id}`))!.service_ids, [service.id]);
  assert.deepEqual(deliveries.find(row => row.payload.content.includes('대상: unregistered'))!.service_ids, []);
  await f.publisher.deliver(); await f.publisher.deliver(); assert.equal(f.rest.messages.length, 2);
});
for (const outcome of ['succeeded', 'failed']) test(`4313740735 완료 직전 cancel 경합은 cancelled (${outcome})`, async () => {
  await queue(); f.setRun(async () => outcome === 'succeeded' ? success : { status: 'failed', stopped: true });
  const transaction = database.db.transaction.bind(database.db); let raced = false;
  database.db.transaction = (fn, deadline) => transaction(tx => fn({ ...tx, query: async <T>(sql: string, params?: unknown[]) => {
    if (!raced && sql.includes("state=CASE WHEN state='cancel_requested'") && params?.[2] === outcome) {
      raced = true; await tx.query("UPDATE jobs SET state='cancel_requested' WHERE id=$1", [params[0]]);
    }
    return tx.query<T>(sql, params);
  } }), deadline);
  try { await f.runtime.tick(); } finally { database.db.transaction = transaction; }
  assert.equal(raced, true); assert.equal((await rows('jobs'))[0]!.state, 'cancelled');
  assert.equal((await rows('results')).length, 0); assert.equal((await rows('outbox')).length, 0);
  f.setRun(async () => success); await queue('second'); await f.runtime.tick(); assert.equal(f.requests.length, 2);
});
test('4313740738 unknown 대조 첫 429에서 중단, 재구성 뒤에도 retry_after 대기', async () => {
  for (let i = 0; i < 3; i++) await enqueue(`unknown-${i}`);
  await database.db.query("UPDATE outbox SET state='unknown',lease_token=$1", [randomUUID()]); let calls = 0;
  f.rest.findDelivery = async () => { calls++; if (calls === 1) throw new RateLimited(3500); return { id: `found-${calls}` }; };
  await f.publisher.reconcile(); assert.equal(calls, 1);
  const publisher = new DiscordPublisher(f.store, f.gate, f.rest);
  f.advance(3499); await publisher.reconcile(); assert.equal(calls, 1);
  f.advance(1); await publisher.reconcile(); assert.equal(calls, 4);
  assert.ok((await rows('outbox')).every(row => row.state === 'sent'));
  assert.equal(f.rest.messages.length, 0);
});
test('4313740749 다른 경보 그룹 동시 수락은 공통 잠금 뒤 count, 100건 유지', async () => {
  for (let i = 0; i < 99; i++) await enqueue(`existing-${i}`);
  const transaction = database.db.transaction.bind(database.db); let countChecks = 0;
  database.db.transaction = (fn, deadline) => transaction(tx => {
    let locked = false;
    return fn({ ...tx, query: async <T>(sql: string, params?: unknown[]) => {
      if (sql.includes("key='alert_admission' FOR UPDATE")) locked = true;
      if (sql.includes('SELECT count(*) FROM outbox')) { assert.equal(locked, true); countChecks++; }
      return tx.query<T>(sql, params);
    } });
  }, deadline);
  const ingress = new AlertIngress(f.store, f.gate);
  try {
    const results = await Promise.allSettled(['group-a', 'group-b'].map(groupKey => ingress.receive({
      groupKey, status: 'firing', alerts: [{ fingerprint: groupKey, labels: { service: service.id, severity: 'warning' } }],
    })));
    assert.equal(results.filter(result => result.status === 'fulfilled').length, 1);
    assert.equal(results.filter(result => result.status === 'rejected').length, 1);
  } finally { database.db.transaction = transaction; }
  assert.equal(countChecks, 2); assert.equal((await rows('outbox')).length, 100);
});
for (const explicitFlag of [false, true]) test(`4313740757 부모 채널 urgent 보존 (flag=${explicitFlag})`, async () => {
  await queue('normal');
  await f.ingress.receive(event('urgent', { scope: parent, kind: 'command', command: explicitFlag ? 'chat' : 'urgent', urgent: explicitFlag }));
  await f.publisher.deliver();
  const urgent = (await rows('jobs')).find(row => row.target.channel === f.rest.threads[0]!.id)!;
  assert.equal(urgent.priority, 0); assert.equal(Number(urgent.available_at), f.now());
  assert.equal((await f.store.claim())!.id, urgent.id);
});
test('4313740762 매 호출마다 전진하는 시계도 capability TTL 정확히 30000ms', async () => {
  await queue(); const job = (await f.store.claim())!; const request = workerRequest(job, []);
  let clock = f.now(); let reads = 0;
  const signer = new WorkerSigner(f.keys.privateKey, () => { reads++; return clock++; });
  const token = signer.issue(job, 'execute', request);
  const payload = JSON.parse(Buffer.from(token.split('.')[0]!, 'base64url').toString());
  assert.equal(reads, 1); assert.equal(payload.expires - payload.issued, 30_000);
  await new WorkerVerifier(f.keys.publicKey, async () => true, () => clock).check(token, 'execute', request);
});
test('4313740767 이전 lease 취소 capability는 같은 job의 새 실행을 중단하지 않음', async () => {
  await queue(); const first = (await f.store.claim())!;
  let started!: () => void; let resolve!: (value: WorkerResult) => void; let stops = 0;
  let ready = new Promise<void>(r => { started = r; });
  const stoppedLeases: string[] = [];
  const worker = new SerialWorker(f.verifier, () => { started(); return new Promise(r => { resolve = r; }); }, async request => {
    stops++; stoppedLeases.push(request.lease); return true;
  });
  const request1 = workerRequest(first, []);
  const firstRun = worker.execute(request1, f.signer.issue(first, 'execute', request1), new AbortController().signal); await ready;
  const oldCancel = { job: first.id, lease: first.lease_token };
  const oldToken = f.signer.issue(first, 'cancel', oldCancel);
  resolve(success); await firstRun;
  const second: Job = { ...first, lease_token: randomUUID() }; const request2 = workerRequest(second, []);
  ready = new Promise<void>(r => { started = r; });
  const secondRun = worker.execute(request2, f.signer.issue(second, 'execute', request2), new AbortController().signal); await ready;
  const server = workerServer(worker); server.listen(0, '127.0.0.1'); await once(server, 'listening');
  try {
    const client = new HttpWorker(`http://127.0.0.1:${(server.address() as AddressInfo).port}`, fetch);
    assert.deepEqual(await client.cancel(oldCancel, oldToken), { stopped: false }); assert.equal(stops, 0);
    const current = { job: second.id, lease: second.lease_token };
    await assert.rejects(f.verifier.check(f.signer.issue(first, 'cancel', current), 'cancel', current), Denied);
    assert.deepEqual(await client.cancel(current, f.signer.issue(second, 'cancel', current)), { stopped: true }); assert.equal(stops, 1);
    assert.deepEqual(stoppedLeases, [second.lease_token]);
    const missingLease = await fetch(`http://127.0.0.1:${(server.address() as AddressInfo).port}/v1/cancel`, {
      method: 'POST', headers: { authorization: 'Capability fixture' }, body: JSON.stringify({ job: second.id }),
    });
    assert.equal(missingLease.status, 403);
  } finally { resolve(success); await secondRun; server.close(); await once(server, 'close'); }
});
for (const status of ['limited', 'auth_expired'] as const) test(`4313740773 ${status} 중 두 번째 쓰기 실패도 다음 모델 차단`, async () => {
  await queue(); f.setRun(async () => ({ status, stopped: true }));
  const transaction = database.db.transaction.bind(database.db); let failed = false;
  database.db.transaction = (fn, deadline) => transaction(tx => fn({ ...tx, query: async <T>(sql: string, params?: unknown[]) => {
    if (sql.includes("UPDATE controls SET value='true' WHERE key='scheduler'")) { failed = true; throw new Error('scheduler_write_failed'); }
    return tx.query<T>(sql, params);
  } }), deadline);
  try { await f.runtime.tick(); } finally { database.db.transaction = transaction; }
  assert.equal(failed, true); assert.equal((await rows('jobs'))[0]!.state, 'running');
  await queue('next'); assert.equal(await f.runtime.tick(), false); assert.equal(f.requests.length, 1);
  f.advance(DEFAULTS.leaseMs); await f.runtime.tick();
  assert.equal((await rows('jobs')).find(j => j.state === 'unknown')!.wait_reason, 'lease_expired');
  assert.equal(f.requests.length, 1);
});
test('4313740773 waiting_user 잔존은 scheduler 플래그와 무관하게 모델 차단', async () => {
  await queue(); await database.db.query("UPDATE jobs SET state='waiting_user'");
  await queue('next'); assert.equal(await f.runtime.tick(), false); assert.equal(f.requests.length, 0);
});
for (const scope of [thread, parent]) test(`4313740783 최종 accepted UPDATE 지연은 처리 경로 rollback (${scope.kind})`, async () => {
  const transaction = database.db.transaction.bind(database.db);
  database.db.transaction = (fn, deadline) => transaction(tx => fn({ ...tx, query: async <T>(sql: string, params?: unknown[]) => {
    const result = await tx.query<T>(sql, params);
    if (sql === 'UPDATE events SET accepted=true WHERE id=$1') f.advance(1501);
    return result;
  } }), deadline);
  try { await assert.rejects(f.ingress.receive(event('late', { scope })), /inbox_deadline/); }
  finally { database.db.transaction = transaction; }
  assert.equal(f.rest.acks.length, 0); assert.equal((await rows('events'))[0]!.accepted, false);
  assert.equal((await rows('jobs')).length, 0); assert.equal((await rows('outbox')).length, 0);
});
test('4313740783 Postgres deadline은 statement 잔여 예산과 COMMIT까지 제한', async () => {
  const commands: string[] = []; let time = 0;
  const client = { query: async (sql: string) => { commands.push(sql); return { rows: [] }; }, release: () => {} };
  const db = new Postgres({ connect: async () => client } as unknown as pg.Pool);
  await db.transaction(async tx => { time = 700; await tx.query('SELECT 1'); time = 1400; }, { expiresAt: 1500, now: () => time });
  assert.ok(commands.includes("SET LOCAL transaction_timeout = '1500ms'"));
  assert.ok(commands.includes("SET LOCAL statement_timeout = '800ms'"));
  assert.equal(commands.at(-2), "SET LOCAL statement_timeout = '100ms'"); assert.equal(commands.at(-1), 'COMMIT');
  commands.length = 0; time = 0;
  await assert.rejects(db.transaction(async () => { time = 1501; }, { expiresAt: 1500, now: () => time }), /inbox_deadline/);
  assert.equal(commands.includes('COMMIT'), false); assert.equal(commands.at(-1), 'ROLLBACK');
});
test('4313740796 큰 read도 미확인·권장 확인을 보존한 완결 요약', async () => {
  const reader = new ReadAdapter([service], [{ ...template, maxRows: 200, maxBytes: 65536 }], f.gate, {
    query: async () => new TextEncoder().encode(JSON.stringify({ observedAt: f.now(), rows: Array.from({ length: 200 }, () => ({ status: 'degraded', value: 123456789 })) })),
  }, f.now);
  await f.ingress.receive(event('read', { kind: 'command', command: 'read', target: service.id, text: template.id })); f.advance(DEFAULTS.debounceMs + 50);
  await new Runtime(f.store, f.gate, f.worker, f.signer, reader).tickRead(); await f.publisher.deliver();
  const content = f.rest.messages[0]!.body.content;
  assert.ok(content.length < 2000); assert.match(content, /개 생략/); assert.match(content, /미확인:.*복원 가능/); assert.match(content, /권장 확인: 없음/);
  const raw = (await rows('results'))[0]!.result;
  const summary = readSummary({ ...raw, checks: ['승인된 조회 경로와 관측 시각 확인'] });
  assert.match(summary, /권장 확인: 승인된 조회 경로와 관측 시각 확인/);
});
test('4313740796 큰 list는 모든 작업을 유효한 JSON 페이지로 전달', async () => {
  for (let i = 0; i < 45; i++) await f.ingress.receive(event(`history-${i}`));
  const ids = new Set((await rows('jobs')).map(job => job.id));
  await f.ingress.receive(event('list', { kind: 'command', command: 'list', text: '' }));
  while (await f.publisher.deliver()) { /* Drain every independently idempotent page. */ }
  assert.ok(f.rest.messages.length > 1);
  const delivered = f.rest.messages.flatMap(message => {
    assert.ok(message.body.content.length <= 2000);
    // marker는 JSON 필드다(4316750293). 메시지 전체를 그대로 파싱한다.
    return (JSON.parse(message.body.content) as { data: { id: string }[] }).data;
  });
  assert.equal(delivered.length, ids.size); assert.deepEqual(new Set(delivered.map(job => job.id)), ids);
  assert.equal(new Set(f.rest.messages.map(message => message.body.nonce)).size, f.rest.messages.length);
  const text = '안내😀'.repeat(1000); assert.equal(messagePages(text).join(''), text);
});
