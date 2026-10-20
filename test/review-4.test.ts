import { after, before, beforeEach, test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { DEFAULTS, PolicyUnavailable, RateLimited } from '../src/contracts.js';
import { DiscordIngress, DiscordPublisher } from '../src/discord.js';
import { discordHttpApi } from '../src/discord-protocol.js';
import { AlertIngress } from '../src/alerts.js';
import { PolicyGate } from '../src/policy.js';
import { ReadAdapter } from '../src/read.js';
import { Runtime } from '../src/runtime.js';
import { event, fixture, localDatabase, service, template, thread } from './helpers.js';

let database: Awaited<ReturnType<typeof localDatabase>>;
let f: Awaited<ReturnType<typeof fixture>>;
const parent = { ...thread, kind: 'channel' as const, channel: thread.parent!, parent: null };
before(async () => { database = await localDatabase(); });
beforeEach(async () => {
  await database.pg.exec('TRUNCATE events,conversations,jobs,results,outbox,schedules,denied_actors,controls,audit,incidents RESTART IDENTITY CASCADE');
  f = await fixture(database.db);
});
after(async () => { await database.pg.close(); });
async function rows(table: string) { return (await database.db.query<Record<string, any>>(`SELECT * FROM ${table}`)).rows; }
async function queue(id = 'first') { await f.ingress.receive(event(id)); f.advance(800); }
async function enqueue(key = 'delivery', content = '확인된 요약') {
  await f.store.enqueue({ key, actor: f.policy.owner, scope: thread, revision: f.policy.revision,
    payload: { kind: 'message', channel: thread.channel, content, classification: 'safe_summary' } });
}
function alert(fingerprint = 'first') {
  return { groupKey: 'fixture-group', status: 'firing', alerts: [{ fingerprint, labels: { service: service.id, severity: 'warning' } }] };
}

for (const cause of ['policy', '429']) for (const same of [false, true]) {
  test(`4314215604 ${cause} 차단 뒤 ${same ? '동일' : '새'} fingerprint도 새 경보 세대`, async () => {
    const ingress = new AlertIngress(f.store, f.gate);
    await ingress.receive(alert());
    if (cause === 'policy') {
      const channel = f.policy.notificationChannel; f.policy.notificationChannel = 'changed-notifications';
      await f.publisher.deliver(); f.policy.notificationChannel = channel;
    } else {
      const create = f.rest.createThread.bind(f.rest);
      f.rest.createThread = async () => { throw new RateLimited(1000); };
      for (let attempt = 0; attempt < 3; attempt++) { await f.publisher.deliver(); f.advance(1000); }
      f.rest.createThread = create;
    }
    assert.equal((await rows('outbox'))[0]!.state, 'blocked');
    await ingress.receive(alert(same ? 'first' : 'second'));
    assert.equal((await rows('outbox')).length, 2);
    assert.equal(new Set((await rows('outbox')).map(row => row.idempotency_key)).size, 2);
    await f.publisher.deliver(); await f.publisher.deliver();
    assert.equal(f.rest.threads.length, 1); assert.equal(f.rest.messages.length, 1);
    assert.ok((await rows('incidents'))[0]!.conversation_id);
  });
}
for (const state of ['pending', 'sending', 'unknown']) test(`4314215604 ${state} 경보 스레드는 재사용, 반복·회귀 fingerprint도 유일`, async () => {
  const ingress = new AlertIngress(f.store, f.gate); await ingress.receive(alert());
  await database.db.query('UPDATE outbox SET state=$1', [state]);
  await ingress.receive(alert('second')); await ingress.receive(alert());
  assert.equal((await rows('outbox')).length, 1); assert.equal((await rows('events')).length, 1);
});

test('4314215621 HTTP global 429 범위를 보존하고 생략 시 route 범위', async () => {
  for (const global of [true, false, undefined]) {
    const api = discordHttpApi('fixture-token', async () => new Response(JSON.stringify({ retry_after: 2.5, global }), { status: 429 }));
    await assert.rejects(api.request('POST', '/fixture'), error => error instanceof RateLimited && error.global === (global === true) && error.retryAfterMs === 2500);
  }
});
for (const kind of ['message', 'thread']) test(`4314215621 ${kind} 전역 429는 재구성 후 claim·대조 모두 중지`, async () => {
  if (kind === 'thread') await f.ingress.receive(event('parent', { scope: parent }));
  else await enqueue('a');
  const send = f.rest.sendMessage.bind(f.rest); const create = f.rest.createThread.bind(f.rest);
  let calls = 0;
  f.rest.sendMessage = async (...args) => { calls++; if (calls === 1) throw new RateLimited(4000, true); return send(...args); };
  f.rest.createThread = async (...args) => { calls++; if (calls === 1) throw new RateLimited(4000, true); return create(...args); };
  await f.publisher.deliver();
  await enqueue('b'); await enqueue('unknown');
  await database.db.query("UPDATE outbox SET state='unknown',lease_token=$1 WHERE idempotency_key='unknown'", [randomUUID()]);
  let searches = 0; f.rest.findDelivery = async () => { searches++; return undefined; };
  const publisher = new DiscordPublisher(f.store, f.gate, f.rest);
  assert.equal(await publisher.deliver(), false); await publisher.reconcile();
  f.advance(3999); assert.equal(await publisher.deliver(), false); await publisher.reconcile();
  assert.equal(calls, 1); assert.equal(searches, 0);
  assert.equal((await rows('outbox')).find(row => row.idempotency_key === 'b')!.attempt, 0);
  f.advance(1); assert.equal(await publisher.deliver(), true); await publisher.reconcile();
  assert.equal(calls, 2); assert.equal(searches, 1);
});
test('4314215621 대조·ACK·history의 global 429도 게시자에 영속 전파', async () => {
  await enqueue('unknown'); await database.db.query("UPDATE outbox SET state='unknown',lease_token=$1", [randomUUID()]);
  f.rest.findDelivery = async () => { throw new RateLimited(3000, true); };
  await f.publisher.reconcile(); await enqueue('pending'); assert.equal(await f.publisher.deliver(), false);
  f.advance(3000);
  f.rest.acknowledge = async () => { throw new RateLimited(3000, true); };
  await f.ingress.receive(event('ack', { kind: 'command', command: 'chat' }));
  assert.equal(await f.publisher.deliver(), false);
  f.advance(3000); f.rest.history = async () => { throw new RateLimited(3000, true); };
  await assert.rejects(f.ingress.recover(thread, f.policy.owner), RateLimited);
  assert.equal(await f.publisher.deliver(), false);
  let historyCalls = 0; f.rest.history = async () => { historyCalls++; return []; };
  await assert.rejects(f.ingress.recover(thread, f.policy.owner), RateLimited); assert.equal(historyCalls, 0);
});
test('4314215621 route 429는 다른 채널의 시도를 소진하지 않고 전달 허용', async () => {
  await enqueue('a'); await enqueue('b');
  await database.db.query("UPDATE outbox SET scope=jsonb_set(scope,'{channel}','\"fixture-other\"'),payload=jsonb_set(payload,'{channel}','\"fixture-other\"') WHERE idempotency_key='b'"); f.rest.rateLimit = new RateLimited(3000);
  await f.publisher.deliver(); await f.publisher.deliver();
  assert.equal(f.rest.messages.length, 1); assert.equal(await f.store.discordPauseUntil(), 0);
});

for (const obstruction of ['429', 'unknown', 'blocked']) test(`4314215638 ${obstruction} 첫 페이지 뒤로 추월 금지, 별도 메시지는 진행`, async () => {
  const content = '첫째😀둘째'.repeat(700); await enqueue('pages', content);
  const pages = (await rows('outbox')).sort((a, b) => a.page_index - b.page_index);
  assert.ok(pages.length >= 3);
  // Reverse IDs deliberately, with the same created_at on all pages.
  for (const page of pages) await database.db.query('UPDATE outbox SET id=$2 WHERE id=$1', [page.id, `reverse-${pages.length - page.page_index}`]);
  if (obstruction === '429') f.rest.rateLimit = new RateLimited(2000);
  else if (obstruction === 'unknown') f.rest.loseResponse = true;
  else await database.db.query("UPDATE outbox SET state='blocked' WHERE page_index=0");
  if (obstruction !== 'blocked') await f.publisher.deliver();
  assert.equal(await f.publisher.deliver(), false);
  assert.ok((await rows('outbox')).filter(p => p.page_index > 0).every(p => p.attempt === 0));
  await enqueue('other', '다른 메시지');
  await database.db.query("UPDATE outbox SET scope=jsonb_set(scope,'{channel}','\"fixture-other\"'),payload=jsonb_set(payload,'{channel}','\"fixture-other\"') WHERE idempotency_key='other'");
  assert.equal(await f.publisher.deliver(), true);
  if (obstruction === 'blocked') return;
  if (obstruction === 'unknown') await f.publisher.reconcile(); else f.advance(2000);
  while (await f.publisher.deliver()) { /* Ordered drain. */ }
  const delivered = f.rest.messages.filter(m => !m.body.content.startsWith('다른 메시지')).map(m => m.body.content.split('\n[ref:')[0]!);
  assert.equal(delivered.join(''), content);
});
test('4314215638 기존 페이지·read migration을 두 번 실행해도 순서·유형 보존', async () => {
  await enqueue('legacy', '문장'.repeat(2000));
  await f.ingress.receive(event('read', { kind: 'command', command: 'read', target: service.id, text: template.id }));
  await database.db.query("UPDATE jobs SET type='chat'");
  await database.pg.exec('ALTER TABLE outbox DROP COLUMN message_key CASCADE; ALTER TABLE outbox DROP COLUMN page_index');
  const sql = await readFile('migrations/005_delivery_order.sql', 'utf8'); await database.pg.exec(sql); await database.pg.exec(sql);
  const pages = (await rows('outbox')).sort((a, b) => a.page_index - b.page_index);
  assert.deepEqual(pages.map(p => p.page_index), [0, 1, 2]); assert.ok(pages.every(p => p.message_key === 'legacy'));
  assert.equal((await rows('jobs'))[0]!.type, 'read');
  while (await f.publisher.deliver()) { /* Legacy pages preserve order. */ }
  assert.equal(f.rest.messages.map(m => m.body.content.split('\n[ref:')[0]!).join(''), '문장'.repeat(2000));
});

for (const lane of ['chat', 'read']) test(`4314215647 복구 gap 중 ${lane} 완료 결과 보존, gap 해제 후 게시`, async () => {
  await f.ingress.receive(event(lane, lane === 'read' ? { kind: 'command', command: 'read', target: service.id, text: template.id } : {})); f.advance(800);
  const setGap = () => database.db.query('UPDATE conversations SET gap=true');
  f.setRun(async () => { await setGap(); return { status: 'succeeded', stopped: true, answer: { facts: [], hypotheses: [], unknowns: [], checks: [] } }; });
  const reader = new ReadAdapter([service], [template], f.gate, { query: async () => {
    await setGap(); return new TextEncoder().encode(JSON.stringify({ observedAt: f.now(), rows: [{ status: 'healthy' }] }));
  } }, f.now);
  await new Runtime(f.store, f.gate, f.worker, f.signer, reader).tick();
  assert.equal((await rows('jobs'))[0]!.state, 'succeeded'); assert.equal((await rows('results')).length, 1);
  await f.publisher.deliver(); assert.equal(f.rest.messages.length, 0);
  const delivery = (await rows('outbox'))[0]!; assert.equal(delivery.state, 'pending'); assert.equal(delivery.pause_reason, 'history_gap'); assert.equal(delivery.attempt, 0);
  await f.ingress.recover(thread, f.policy.owner); f.advance(1000);
  await f.publisher.deliver(); assert.equal(f.rest.messages.length, 1);
});
test('4314215647 unknown도 gap 동안 보존, stop은 여전히 영구 차단', async () => {
  await queue(); await f.runtime.tick(); f.rest.loseResponse = true; await f.publisher.deliver();
  await database.db.query('UPDATE conversations SET gap=true'); await f.publisher.reconcile();
  assert.equal((await rows('outbox'))[0]!.state, 'unknown');
  await f.ingress.recover(thread, f.policy.owner); await f.publisher.reconcile();
  assert.equal((await rows('outbox'))[0]!.state, 'sent'); assert.equal(f.rest.messages.length, 1);
  await queue('next'); await f.runtime.tick(); await f.store.control(f.policy.owner, f.store.scopeId(thread), 'stop'); await f.publisher.deliver();
  assert.equal((await rows('outbox')).find(row => row.state === 'blocked')!.attempt, 1);
});

for (const control of ['cancel', 'emergency-stop']) test(`4314215657 정책 읽기 중 ${control}는 dispatch 없이 cancelled, 다음 실행 가능`, async () => {
  await queue();
  const gate = new PolicyGate(async () => {
    const job = (await rows('jobs'))[0]!;
    await f.store.control(f.policy.owner, f.store.scopeId(thread), control, job.id);
    throw new PolicyUnavailable();
  }, database.db, f.now);
  await new Runtime(f.store, gate, f.worker, f.signer, f.reader).tick();
  const job = (await rows('jobs'))[0]!;
  assert.equal(job.state, 'cancelled'); assert.equal(job.lease_token, null); assert.equal(Number(job.finished_at), f.now()); assert.equal(f.requests.length, 0);
  if (control === 'emergency-stop') await database.db.query("UPDATE controls SET value='false' WHERE key='scheduler'");
  await queue('next'); await f.runtime.tick(); assert.equal(f.requests.length, 1);
});
test('4314215657 superseded·waiting_user 경합은 cancelled, 미확인 worker는 unknown 유지', async () => {
  for (const state of ['superseded', 'waiting_user', 'unknown'] as const) {
    await queue(state); const job = (await f.store.claim())!;
    await f.store.control(f.policy.owner, job.conversation_id, 'cancel', job.id);
    if (state === 'waiting_user') await f.store.waitForUser(job, 'model_limit'); else await f.store.transition(job, state);
    assert.equal((await rows('jobs')).find(row => row.id === job.id)!.state, state === 'unknown' ? 'unknown' : 'cancelled');
  }
  assert.equal((await rows('controls')).find(row => row.key === 'scheduler')!.value, false);
});
test('4314215657 defer는 다른 lease나 만료 lease의 상태를 바꾸지 않음', async () => {
  await queue(); const job = (await f.store.claim())!;
  await f.store.defer({ ...job, lease_token: randomUUID() }); assert.equal((await rows('jobs'))[0]!.state, 'running');
  f.advance(DEFAULTS.leaseMs); await f.store.defer(job); await f.store.expire(); assert.equal((await rows('jobs'))[0]!.state, 'unknown');
});

for (const scope of [thread, { guild: null, channel: 'fixture-dm', parent: null, kind: 'dm' as const }]) {
  test(`4314215667 ${scope.kind} 연속 read와 chat 모두 독립 실행`, async () => {
    f.policy.dmEnabled = true;
    for (const id of ['read-1', 'read-2']) await f.ingress.receive(event(id, { scope, kind: 'command', command: 'read', target: service.id, text: template.id }));
    await f.ingress.receive(event('chat-1', { scope })); await f.ingress.receive(event('chat-2', { scope }));
    const jobs = await rows('jobs'); assert.equal(jobs.filter(j => j.type === 'read' && j.state === 'queued').length, 2);
    assert.equal(jobs.filter(j => j.state === 'superseded').length, 1);
    await f.runtime.tick(); await f.runtime.tick(); assert.equal(f.queries.length, 2); assert.equal(f.requests.length, 0);
    f.advance(800); await f.runtime.tick(); assert.equal(f.requests.length, 1);
  });
}
test('4314215667 부모 채널 read도 thread 확정 뒤 즉시 실행 가능한 read 유형', async () => {
  await f.ingress.receive(event('parent-read', { scope: parent, kind: 'command', command: 'read', target: service.id, text: template.id }));
  await f.publisher.deliver(); const job = (await rows('jobs'))[0]!;
  assert.equal(job.type, 'read'); assert.equal(Number(job.available_at), f.now()); await f.runtime.tick(); assert.equal(f.queries.length, 1);
});

for (const route of ['chat', 'thread', 'control']) test(`4314215673 save 직후 종료된 ${route} 미수락 inbox를 동시 재전달해도 한 번 라우팅`, async () => {
  const original = event('200', route === 'thread' ? { scope: parent } : route === 'control' ? { kind: 'command', command: 'list' } : {});
  const saved = await f.store.save(original, f.policy.revision, true);
  await Promise.all([f.ingress.receive(original), f.ingress.receive(original)]);
  assert.equal((await rows('events')).length, 1); assert.equal((await rows('events'))[0]!.accepted, true);
  assert.equal((await rows(route === 'chat' ? 'jobs' : 'outbox')).length, 1);
  assert.equal(f.rest.acks.length, 1);
  // Accepted duplicates do not create another ACK or processing route.
  assert.equal(await f.ingress.receive(original), saved.id); assert.equal(f.rest.acks.length, 1);
});
test('4314215673 route rollback 뒤 history 복구는 job 저장 후 checkpoint 전진', async () => {
  await f.store.save(event('seed'), f.policy.revision, true);
  await database.db.query('DELETE FROM events');
  await database.db.query('UPDATE conversations SET active=true');
  const transaction = database.db.transaction.bind(database.db); let fail = true;
  database.db.transaction = (fn, deadline) => transaction(tx => fn({ ...tx, query: async <T>(sql: string, params?: unknown[]) => {
    if (fail && sql === 'UPDATE events SET accepted=true WHERE id=$1') { fail = false; throw new Error('route_rollback'); }
    return tx.query<T>(sql, params);
  } }), deadline);
  try { await assert.rejects(f.ingress.receive(event('300')), /route_rollback/); } finally { database.db.transaction = transaction; }
  assert.equal((await rows('events'))[0]!.accepted, false); assert.equal((await rows('jobs')).length, 0);
  f.rest.pages = [[event('300')]]; await f.ingress.recover(thread, f.policy.owner);
  assert.equal((await rows('jobs')).length, 1); assert.equal((await rows('events'))[0]!.accepted, true);
  assert.equal((await f.store.conversation(thread))!.checkpoint, '300'); assert.equal((await f.store.conversation(thread))!.gap, false);
  f.advance(800); await f.runtime.tick(); assert.equal(f.requests.length, 1);
});
test('4314215673 미수락 재전달은 저장된 명령을 사용하고 다른 actor는 거부', async () => {
  const original = event('durable', { kind: 'command', command: 'read', target: service.id, text: template.id });
  await f.store.save(original, f.policy.revision, true);
  await assert.rejects(f.ingress.receive({ ...original, actor: 'other-owner' }));
  await f.ingress.receive({ ...original, command: 'list', text: '' });
  assert.equal((await rows('jobs'))[0]!.type, 'read'); assert.equal((await rows('outbox')).length, 0);
});
test('4314215673 기존 job 재수락은 queue full에서도 기존 ID 반환·다른 chat 유지', async () => {
  await queue(); const original = (await rows('jobs'))[0]!;
  for (let i = 0; i < 99; i++) {
    const saved = await f.store.save(event(`task-${i}`, { kind: 'command', command: 'task' }), f.policy.revision, true);
    await f.store.accept(saved.id, 'task', f.policy.revision);
  }
  assert.equal(await f.store.accept(original.event_id, 'chat', f.policy.revision), original.id);
  assert.equal((await rows('jobs')).filter(j => j.state === 'queued').length, 100);
});

test('4314215604 기존 스레드 요약도 blocked 뒤 같은 fingerprint를 새 세대로 전달', async () => {
  const ingress = new AlertIngress(f.store, f.gate); await ingress.receive(alert()); await f.publisher.deliver();
  await database.db.query("UPDATE outbox SET state='blocked' WHERE payload->>'kind'='message'");
  // Existing rows regain their latest delivery reference during upgrade.
  await database.db.query('UPDATE incidents SET delivery_key=NULL');
  await database.pg.exec(await readFile('migrations/005_delivery_order.sql', 'utf8'));
  await ingress.receive(alert()); await ingress.receive(alert());
  assert.equal((await rows('outbox')).filter(row => row.state === 'pending').length, 1);
  await f.publisher.deliver(); assert.equal(f.rest.messages.length, 1); assert.equal(f.rest.threads.length, 1);
  await ingress.receive(alert()); assert.equal(await f.publisher.deliver(), false);
});
test('4314215621 전역 대기 중 새 ACK 요청은 남은 창을 연장하지 않음', async () => {
  await f.store.recordRateLimit(new RateLimited(2000, true)); f.advance(1500);
  await f.ingress.receive(event('late-ack', { kind: 'command', command: 'chat' }));
  assert.equal(f.rest.acks.length, 0); assert.equal(await f.store.discordPauseUntil(), f.now() + 500);
  f.advance(500); await f.publisher.deliver(); assert.equal(f.rest.messages.length, 1);
});
test('4314215638 중간 페이지 enqueue 실패는 논리 메시지 전체 rollback', async () => {
  const transaction = database.db.transaction.bind(database.db); let inserts = 0;
  database.db.transaction = (fn, deadline) => transaction(tx => fn({ ...tx, query: async <T>(sql: string, params?: unknown[]) => {
    if (sql.includes('INSERT INTO outbox') && ++inserts === 2) throw new Error('page_write_failed');
    return tx.query<T>(sql, params);
  } }), deadline);
  try { await assert.rejects(enqueue('atomic', '내용'.repeat(2000)), /page_write_failed/); } finally { database.db.transaction = transaction; }
  assert.equal((await rows('outbox')).length, 0);
});
test('4314215667 모델 실행 중 연속 read도 완료 뒤 둘 다 관측', async () => {
  await queue(); let ready!: () => void; let release!: () => void;
  const started = new Promise<void>(resolve => { ready = resolve; });
  const held = new Promise<void>(resolve => { release = resolve; });
  f.setRun(async () => { ready(); await held; return { status: 'succeeded', stopped: true, answer: { facts: [], hypotheses: [], unknowns: [], checks: [] } }; });
  const running = f.runtime.tick(); await started;
  for (const id of ['busy-read-1', 'busy-read-2']) await f.ingress.receive(event(id, { kind: 'command', command: 'read', target: service.id, text: template.id }));
  assert.equal(await f.runtime.tick(), false); release(); await running;
  await f.runtime.tick(); await f.runtime.tick(); assert.equal(f.queries.length, 2);
  assert.ok((await rows('jobs')).every(job => job.state === 'succeeded'));
});

test('4314215604 경보 thread 확정 중 summary 실패는 원자적 rollback 뒤 대조로 복구', async () => {
  const ingress = new AlertIngress(f.store, f.gate); await ingress.receive(alert());
  const transaction = database.db.transaction.bind(database.db); let fail = true;
  database.db.transaction = (fn, deadline) => transaction(tx => fn({ ...tx, query: async <T>(sql: string, params?: unknown[]) => {
    if (fail && sql.includes('INSERT INTO outbox')) { fail = false; throw new Error('summary_write_failed'); }
    return tx.query<T>(sql, params);
  } }), deadline);
  try { await f.publisher.deliver(); } finally { database.db.transaction = transaction; }
  assert.equal((await rows('outbox'))[0]!.state, 'unknown'); assert.equal((await rows('incidents'))[0]!.conversation_id, null);
  await ingress.receive(alert('next')); assert.equal((await rows('outbox')).length, 1);
  await f.publisher.reconcile(); await f.publisher.deliver();
  assert.equal(f.rest.threads.length, 1); assert.equal(f.rest.messages.length, 1);
  assert.ok((await rows('outbox')).every(row => row.state === 'sent'));
});
