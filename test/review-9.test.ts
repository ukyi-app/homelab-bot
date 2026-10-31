import { after, before, beforeEach, test } from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULTS } from '../src/contracts.js';
import type { Database } from '../src/database.js';
import { DiscordIngress, DiscordPublisher, deliveryMarker } from '../src/discord.js';
import type { DiscordRest } from '../src/discord.js';
import { DiscordProtocol } from '../src/discord-protocol.js';
import type { PolicyGate } from '../src/policy.js';
import { ReadAdapter } from '../src/read.js';
import type { ReadTransport } from '../src/read.js';
import { MODEL_QUEUE_LIMIT, Store } from '../src/store.js';
import type { Delivery } from '../src/store.js';
import { event, fixture, localDatabase, service, template, thread } from './helpers.js';

// PR #5 마지막 재리뷰(head 1a639db)에서 T16b로 이월한 P2와 T16a 변경 요청 6번(ARCHITECTURE §12)의 회귀 시험이다.
let database: Awaited<ReturnType<typeof localDatabase>>;
let f: Awaited<ReturnType<typeof fixture>>;
before(async () => { database = await localDatabase(); });
beforeEach(async () => {
  await database.pg.exec('TRUNCATE events,conversations,jobs,results,outbox,schedules,denied_actors,controls,audit,incidents RESTART IDENTITY CASCADE');
  f = await fixture(database.db);
});
after(async () => { await database.pg.close(); });
async function rows(table: string) { return (await database.db.query<Record<string, any>>(`SELECT * FROM ${table}`)).rows; }
async function queue(id = 'first') { await f.ingress.receive(event(id)); f.advance(DEFAULTS.debounceMs); }
async function enqueue(key = 'fixture-delivery') {
  await f.store.enqueue({ key, actor: f.policy.owner, scope: thread, revision: f.policy.revision,
    payload: { kind: 'message', channel: thread.channel, content: '확인된 요약', classification: 'safe_summary' } });
}
async function queued() { return Number((await rows('jobs')).filter(job => job.state === 'queued').length); }

test('4316750293 긴 /list의 각 Discord 메시지는 marker를 품은 채 그대로 JSON으로 파싱', async () => {
  for (let i = 0; i < 45; i++) await f.ingress.receive(event(`history-${i}`));
  const ids = new Set((await rows('jobs')).map(job => job.id));
  await f.ingress.receive(event('list', { kind: 'command', command: 'list', text: '' }));
  while (await f.publisher.deliver()) { /* 페이지마다 독립 멱등 게시 */ }
  assert.ok(f.rest.messages.length > 1);
  const delivered = f.rest.messages.flatMap(message => {
    assert.ok(message.body.content.length <= 2000);
    const page = JSON.parse(message.body.content) as { ref: string; data: { id: string }[] };
    assert.equal(page.ref, message.body.nonce);
    return page.data;
  });
  assert.equal(delivered.length, ids.size); assert.deepEqual(new Set(delivered.map(job => job.id)), ids);
});
test('4316750293 짧은 제어 결과 JSON도 그대로 파싱, 일반 문장은 끝 줄 marker 유지', async () => {
  await queue(); await f.ingress.receive(event('status', { kind: 'command', command: 'model-status', text: '' }));
  await f.runtime.tick();
  while (await f.publisher.deliver()) { /* 제어 결과와 모델 결과를 모두 보낸다 */ }
  const control = f.rest.messages.find(message => message.body.content.startsWith('{'))!;
  const parsed = JSON.parse(control.body.content) as { ref: string; data: { paused: boolean } };
  assert.equal(parsed.ref, control.body.nonce); assert.equal(parsed.data.paused, false);
  // 대화 답은 빈 섹션을 생략한다(개선안 v2 C1). fixture 답은 미확인 한 항목뿐이다.
  const answer = f.rest.messages.find(message => message.body.content.startsWith('미확인:'))!;
  assert.ok(answer.body.content.endsWith(`\n[ref:${answer.body.nonce}]`));
});
test('4316750293 실제 Protocol 대조는 JSON 본문의 marker 필드로 찾고 다른 작성자·다른 marker는 무시', async () => {
  await f.store.enqueue({ key: 'json-page', actor: f.policy.owner, scope: thread, revision: f.policy.revision,
    payload: { kind: 'message', channel: thread.channel, content: JSON.stringify([{ id: 'job-1', state: 'queued' }]), classification: 'safe_summary' } });
  let sent = ''; let sends = 0; let includeBot = false;
  const protocol = new DiscordProtocol({ request: async (method, _path, input) => {
    if (method === 'POST') { sends++; sent = (input as { content: string }).content; throw new Error('response_lost'); }
    return [{ id: 'intruder-copy', channel_id: thread.channel, author: { id: 'intruder' }, content: sent },
      { id: 'other-marker', channel_id: thread.channel, author: { id: 'fixture-bot' }, content: JSON.stringify({ ref: 'other', data: [] }) },
      ...(includeBot ? [{ id: 'actual', channel_id: thread.channel, author: { id: 'fixture-bot' }, content: sent }] : [])];
  } }, 'fixture-bot', f.now);
  const publisher = new DiscordPublisher(f.store, f.gate, protocol);
  await publisher.deliver(); assert.deepEqual(JSON.parse(sent).data, [{ id: 'job-1', state: 'queued' }]);
  await publisher.reconcile(); assert.equal((await rows('outbox'))[0]!.state, 'unknown');
  includeBot = true; f.advance(DEFAULTS.retryDelayMs); await publisher.reconcile();
  assert.equal((await rows('outbox'))[0]!.external_id, 'actual'); assert.equal(sends, 1);
});

test('4316750293 기존 끝 줄 marker 메시지도 실제 Protocol 대조가 계속 찾음', async () => {
  await enqueue(); const row = (await rows('outbox'))[0]! as Delivery; const marker = deliveryMarker(row);
  const protocol = new DiscordProtocol({ request: async () => [
    { id: 'legacy', channel_id: thread.channel, author: { id: 'fixture-bot' }, content: `이전 요약\n[ref:${marker}]` }] }, 'fixture-bot', f.now);
  assert.equal((await protocol.findDelivery(thread.channel, marker, 'message'))!.id, 'legacy');
});
test('4316750315 marker 검색 실패도 다음 대조 시각을 저장해 backoff, unknown 진입 시각은 그대로', async () => {
  await enqueue(); f.rest.loseResponse = true; await f.publisher.deliver();
  const lost = f.rest.messages.splice(0);
  const unknown = (await rows('outbox'))[0]!; assert.equal(unknown.state, 'unknown'); assert.equal(unknown.external_id, null);
  let searches = 0; const find = f.rest.findDelivery.bind(f.rest);
  f.rest.findDelivery = async (...args: Parameters<DiscordRest['findDelivery']>) => { searches++; return find(...args); };
  await f.publisher.reconcile(); await f.publisher.reconcile(); await f.publisher.reconcile();
  assert.equal(searches, 1);
  f.advance(DEFAULTS.retryDelayMs); await f.publisher.reconcile(); assert.equal(searches, 2);
  f.advance(DEFAULTS.retryDelayMs); await f.publisher.reconcile(); assert.equal(searches, 2);
  f.advance(DEFAULTS.retryDelayMs); await f.publisher.reconcile(); assert.equal(searches, 3);
  const row = (await rows('outbox'))[0]!;
  assert.equal(row.state, 'unknown'); assert.equal(Number(row.available_at), Number(unknown.available_at));
  // 원격에서 다시 보이면 backoff 뒤 같은 행을 확정하고 재게시하지 않는다.
  f.rest.messages.push(...lost); f.advance(4 * DEFAULTS.retryDelayMs);
  await f.publisher.reconcile(); assert.equal(searches, 4); assert.equal((await rows('outbox'))[0]!.state, 'sent');
  assert.equal(await f.publisher.deliver(), false); assert.equal(f.rest.messages.length, 1);
});
test('4316750315 검색 오류도 backoff, 간격은 상한에서 멈추고 unknown 24시간 폐기 기한은 연장하지 않음', async () => {
  await enqueue(); f.rest.loseResponse = true; await f.publisher.deliver(); f.rest.messages.length = 0;
  const unknown = (await rows('outbox'))[0]!; let searches = 0;
  f.rest.findDelivery = async () => { searches++; throw new Error('discord_request_failed'); };
  await f.publisher.reconcile(); await f.publisher.reconcile(); assert.equal(searches, 1);
  f.rest.findDelivery = async () => { searches++; return undefined; };
  const intervals: number[] = [];
  for (let i = 0; i < 14; i++) {
    const next = Number((await rows('outbox'))[0]!.reconcile_after); const before: number = searches;
    intervals.push(next - f.now());
    f.advance(next - f.now() - 1); f.policy.confirmedAt = f.now(); await f.publisher.reconcile(); assert.equal(searches, before);
    f.advance(1); await f.publisher.reconcile(); assert.equal(searches, before + 1);
  }
  // 1초부터 두 배씩 늘고 상한에서 멈춘다.
  assert.deepEqual(intervals.slice(0, 4), [1000, 2000, 4000, 8000]);
  assert.equal(Math.max(...intervals), DEFAULTS.reconcileSearchMaxMs); assert.equal(intervals.at(-1), DEFAULTS.reconcileSearchMaxMs);
  assert.equal(Number((await rows('outbox'))[0]!.available_at), Number(unknown.available_at));
  f.advance(Number(unknown.available_at) + DEFAULTS.unknownDeliveryMs - f.now()); f.policy.confirmedAt = f.now();
  await f.publisher.reconcile();
  assert.equal((await rows('outbox'))[0]!.state, 'blocked');
  assert.equal((await rows('audit')).filter(a => a.kind === 'delivery_unresolved_retired').length, 1);
  assert.equal(f.rest.messages.length, 0);
});

// 개선안 v2 C1: 섹션 예산으로 항목을 버리던 방식을 바꿔 모든 항목을 완결 그대로 싣고 빈 섹션은 생략한다.
test('4316750301 모델 응답 섹션은 완결 항목을 모두 싣고 빈 섹션은 생략', async () => {
  const unknowns = Array.from({ length: 8 }, (_, i) => `미확인 항목 ${i} ${'가'.repeat(80)}`);
  f.setRun(async () => ({ status: 'succeeded', stopped: true, answer: { facts: [], hypotheses: [], unknowns, checks: ['짧은 확인'] } }));
  await queue(); await f.runtime.tick(); await f.publisher.deliver();
  const content = f.rest.messages[0]!.body.content;
  const lines = content.split('\n');
  assert.deepEqual(lines.slice(lines.indexOf('미확인:') + 1, lines.indexOf('미확인:') + 1 + unknowns.length), unknowns.map(u => `- ${u}`));
  assert.doesNotMatch(content, /생략|^사실:|없음/m); assert.match(content, /^권장 확인:\n- 짧은 확인$/m);
  assert.deepEqual((await rows('results'))[0]!.result.unknowns, unknowns);
});

test('4316750328 read 5초 시간 초과는 전송에 AbortSignal을 넘겨 실제 요청을 중단', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  let signal: AbortSignal | undefined; let aborted = false; let started!: () => void;
  const called = new Promise<void>(resolve => { started = resolve; });
  const transport: ReadTransport = { query: request => new Promise<Uint8Array>((_, reject) => {
    signal = (request as { signal?: AbortSignal }).signal;
    signal?.addEventListener('abort', () => { aborted = true; reject(signal!.reason); }, { once: true });
    started();
  }) };
  // DB를 쓰지 않는 gate라 가짜 시계 아래에서도 조회까지 마이크로태스크만으로 닿는다.
  const gate = { authorize: async () => f.policy } as unknown as PolicyGate;
  const reader = new ReadAdapter([service], [template], gate, transport, f.now);
  const pending = reader.recent(f.policy.owner, thread, { service: service.id, template: template.id });
  await called;
  assert.ok(signal, 'ReadTransport가 AbortSignal을 받지 못함'); assert.equal(signal.aborted, false);
  t.mock.timers.tick(4999); assert.equal(signal.aborted, false);
  t.mock.timers.tick(1);
  const result = await pending;
  assert.equal(signal.aborted, true); assert.equal(aborted, true);
  assert.equal(result.status, 'unobservable'); assert.deepEqual(result.unknowns, ['현재 관측 자료를 확인할 수 없음']);
});
test('4316750328 제때 끝난 read는 signal을 abort하지 않음', async () => {
  let signal: AbortSignal | undefined;
  const reader = new ReadAdapter([service], [template], f.gate, { query: async request => {
    signal = (request as { signal?: AbortSignal }).signal;
    return new TextEncoder().encode(JSON.stringify({ observedAt: f.now(), rows: [{ status: 'healthy' }] }));
  } }, f.now);
  assert.equal((await reader.recent(f.policy.owner, thread, { service: service.id, template: template.id })).status, 'observed');
  assert.ok(signal); assert.equal(signal.aborted, false);
});

test('4316750325 /retry도 scheduler 잠금 아래 queued 상한을 지키고 실패 작업은 그대로', async () => {
  await queue(); const job = (await rows('jobs'))[0]!; const conversation = f.store.scopeId(thread);
  await database.db.query("UPDATE jobs SET state='failed',attempt=1");
  for (let i = 0; i < MODEL_QUEUE_LIMIT; i++) {
    const saved = await f.store.save(event(`queue-${i}`, { kind: 'command', command: 'task' }), f.policy.revision, false);
    await f.store.accept(saved.id, 'task', f.policy.revision);
  }
  const retry = () => f.store.control(f.policy.owner, conversation, 'retry', job.id) as Promise<{ ok?: boolean; status: string }>;
  const full = await retry();
  assert.equal(full.ok, false); assert.match(full.status, /대기열이 가득/);
  assert.equal((await rows('jobs')).find(j => j.id === job.id)!.state, 'failed'); assert.equal(await queued(), MODEL_QUEUE_LIMIT);
  await database.db.query("UPDATE jobs SET state='cancelled' WHERE id=(SELECT id FROM jobs WHERE state='queued' ORDER BY created_at LIMIT 1)");
  assert.notEqual((await retry()).ok, false);
  assert.equal((await rows('jobs')).find(j => j.id === job.id)!.state, 'queued'); assert.equal(await queued(), MODEL_QUEUE_LIMIT);
});

// PGlite는 연결이 하나라 행 잠금 대기(교착)를 재현할 수 없다. 트랜잭션마다 잠금을 잡는 문장의 순서를 기록해
// T16a 제어 경로(대화 행 FOR UPDATE → 스케줄러 행)와 같은지 본다. jobs·outbox 삽입은 conversation_id 외래 키 검사로
// 대화 행 KEY SHARE를 잡고 이것은 제어 경로가 먼저 잡은 FOR UPDATE와 충돌하므로 대화 행에 닿는 문장으로 센다.
// 실제 다중 연결 재현은 test/review-9-pg.test.ts다(HOMELAB_TEST_PG_SOCKET).
function lockLog(db: Database) {
  const transactions: string[][] = [];
  const kind = (sql: string) => /FROM controls WHERE key='scheduler' FOR UPDATE/.test(sql) ? 'scheduler'
    : /FROM conversations\b[\s\S]*FOR UPDATE/.test(sql) ? 'conversation'
      : /INSERT INTO (jobs|outbox)\b/.test(sql) ? 'conversation_fk' : undefined;
  const recorded: Database = {
    query: (sql, params) => db.query(sql, params),
    transaction: (fn, deadline) => db.transaction(tx => {
      const log: string[] = [];
      transactions.push(log);
      return fn({ query: (sql, params) => { const k = kind(sql); if (k) log.push(k); return tx.query(sql, params); },
        transaction: inner => tx.transaction(inner) });
    }, deadline),
  };
  const inverted = () => transactions.filter(log => {
    const scheduler = log.indexOf('scheduler');
    return scheduler >= 0 && log.slice(scheduler + 1).some(k => k !== 'scheduler') && !log.slice(0, scheduler).includes('conversation');
  });
  return { db: recorded, transactions, inverted };
}
test('T16a 변경 요청 6 accept()는 대화 행을 스케줄러 행보다 먼저 잠금(/model-status·/retry와 같은 순서)', async () => {
  const log = lockLog(database.db);
  const store = new Store(log.db, f.now);
  const conversation = f.store.scopeId(thread);
  const first = await f.store.save(event('lock-first'), f.policy.revision, true);
  await store.control(f.policy.owner, conversation, 'model-status');
  assert.deepEqual(log.transactions.at(-1), ['conversation', 'scheduler']);
  const id = await store.accept(first.id, 'chat', f.policy.revision);
  assert.deepEqual(log.transactions.at(-1), ['conversation', 'scheduler', 'conversation_fk']);
  await database.db.query("UPDATE jobs SET state='failed',attempt=1 WHERE id=$1", [id]);
  await store.control(f.policy.owner, conversation, 'retry', id);
  assert.deepEqual(log.transactions.at(-1), ['conversation', 'scheduler']);
  assert.deepEqual(log.inverted(), []);
  // 이미 수락한 event의 재수락도 같은 순서이고 기존 ID를 돌려준다.
  assert.equal(await store.accept(first.id, 'chat', f.policy.revision), id);
  assert.deepEqual(log.transactions.at(-1), ['conversation', 'scheduler']);
});
test('T16a 변경 요청 6 ingress·스레드 확정 안의 accept()도 순서 역전 없이 작업 하나', async () => {
  const log = lockLog(database.db);
  const store = new Store(log.db, f.now);
  const ingress = new DiscordIngress(store, f.gate.withDatabase(log.db), f.rest);
  await ingress.receive(event('ingress-direct'));
  await ingress.receive(event('ingress-parent', { scope: { ...thread, kind: 'channel', channel: thread.parent!, parent: null }, kind: 'command', command: 'chat' }));
  const publisher = new DiscordPublisher(store, f.gate.withDatabase(log.db), f.rest);
  while (await publisher.deliver()) { /* 스레드 생성 확정이 accept()를 부른다 */ }
  assert.equal((await rows('jobs')).length, 2);
  assert.deepEqual(log.inverted(), []);
});
