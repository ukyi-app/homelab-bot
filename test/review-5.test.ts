import { after, before, beforeEach, test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { AlertIngress } from '../src/alerts.js';
import { DEFAULTS, Denied } from '../src/contracts.js';
import { DiscordIngress } from '../src/discord.js';
import { DiscordProtocol } from '../src/discord-protocol.js';
import { ReadAdapter } from '../src/read.js';
import type { ReadTransport } from '../src/read.js';
import { Runtime } from '../src/runtime.js';
import { event, fixture, localDatabase, service, template, thread } from './helpers.js';

let database: Awaited<ReturnType<typeof localDatabase>>;
let f: Awaited<ReturnType<typeof fixture>>;
before(async () => { database = await localDatabase(); });
beforeEach(async () => {
  await database.pg.exec('TRUNCATE events,conversations,jobs,results,outbox,schedules,denied_actors,controls,audit,incidents RESTART IDENTITY CASCADE');
  f = await fixture(database.db);
});
after(async () => { await database.pg.close(); });
async function rows(table: string) { return (await database.db.query<Record<string, any>>(`SELECT * FROM ${table}`)).rows; }
function alert(services = [service.id], fingerprint = 'fingerprint') {
  return { groupKey: 'fixture-group', status: 'firing', alerts: services.map(id => ({ fingerprint, labels: { service: id, severity: 'warning' } })) };
}
const texts = (context: unknown[]) => context.map(value => (value as { text: string }).text);

for (const stage of ['thread', 'initial-summary', 'repeat']) for (const state of ['pending', 'unknown']) {
  test(`4314491268 ${stage} ${state} 서비스 철회 시 게시·대조 차단`, async () => {
    const ingress = new AlertIngress(f.store, f.gate); await ingress.receive(alert([service.id, service.id]));
    if (stage !== 'thread') await f.publisher.deliver();
    if (stage === 'repeat') { await f.publisher.deliver(); await ingress.receive(alert([service.id], 'repeat')); }
    const delivery = (await rows('outbox')).find(row => row.state === 'pending')!;
    assert.deepEqual(delivery.service_ids, [service.id]);
    await database.db.query('UPDATE outbox SET state=$2,lease_token=$3 WHERE id=$1', [delivery.id, state, randomUUID()]);
    f.policy.services = []; let sends = 0; let searches = 0;
    f.rest.createThread = async (channel, body) => { sends++; return { id: 'unexpected', channel, body }; };
    f.rest.sendMessage = async (channel, body) => { sends++; return { id: 'unexpected', channel, body }; };
    f.rest.findDelivery = async () => { searches++; return { id: 'unexpected' }; };
    if (state === 'pending') await f.publisher.deliver(); else await f.publisher.reconcile();
    assert.equal((await rows('outbox')).find(row => row.id === delivery.id)!.state, 'blocked');
    assert.equal(sends, 0); assert.equal(searches, 0);
  });
}
for (const state of ['pending', 'sending', 'unknown']) test(`4314491268 ${state} 병합은 교체된 내용의 서비스 집합과 함께 갱신`, async () => {
  const ingress = new AlertIngress(f.store, f.gate); const next = 'fixture-next-service';
  f.policy.services.push(next); await ingress.receive(alert());
  await database.db.query('UPDATE outbox SET state=$1,lease_token=$2,lease_until=$3,dispatch_started=true', [state, randomUUID(), f.now() + 30_000]);
  // The fingerprint string is unchanged; the service is part of the semantic identity.
  await ingress.receive(alert([next, next]));
  assert.equal((await rows('outbox')).length, 1);
  assert.deepEqual((await rows('outbox'))[0]!.service_ids, [next]);
  assert.deepEqual((await rows('events'))[0]!.payload.services, [next]);
  f.policy.services = [service.id];
  if (state === 'sending') { f.advance(30_001); await f.store.expire(); }
  if (state === 'pending') await f.publisher.deliver(); else await f.publisher.reconcile();
  assert.equal((await rows('outbox'))[0]!.state, 'blocked');
});
test('4314491268 thread 전송 중 병합해도 새 summary는 최신 서비스 집합 보존', async () => {
  const ingress = new AlertIngress(f.store, f.gate); const next = 'fixture-next-service'; f.policy.services.push(next);
  await ingress.receive(alert()); const create = f.rest.createThread.bind(f.rest);
  f.rest.createThread = async (...args) => { await ingress.receive(alert([next])); return create(...args); };
  await f.publisher.deliver();
  const summary = (await rows('outbox')).find(row => row.payload.kind === 'message')!;
  assert.deepEqual(summary.service_ids, [next]);
  f.policy.services = [service.id]; await f.publisher.deliver(); assert.equal(f.rest.messages.length, 0);
  assert.equal((await rows('outbox')).find(row => row.id === summary.id)!.state, 'blocked');
});
test('4314491268 migration은 복원 불가능한 기존 경보만 차단·감사하고 반복 가능', async () => {
  const ingress = new AlertIngress(f.store, f.gate); await ingress.receive(alert()); await f.publisher.deliver();
  await database.db.query("UPDATE outbox SET service_ids='[]',state='unknown',lease_token=$1 WHERE payload->>'kind'='message'", [randomUUID()]);
  await f.store.enqueue({ key: 'ordinary', actor: f.policy.owner, scope: thread, revision: f.policy.revision,
    payload: { kind: 'message', channel: thread.channel, content: '일반 요약', classification: 'safe_summary' } });
  const sql = await readFile('migrations/006_alert_services.sql', 'utf8'); await database.pg.exec(sql); await database.pg.exec(sql);
  const deliveries = await rows('outbox');
  assert.equal(deliveries.find(row => row.idempotency_key.startsWith('incident-summary:'))!.state, 'blocked');
  assert.equal(deliveries.find(row => row.payload.kind === 'thread')!.state, 'sent');
  assert.equal(deliveries.find(row => row.idempotency_key === 'ordinary')!.state, 'pending');
  assert.equal((await rows('audit')).filter(row => row.kind === 'legacy_alert_scope_missing').length, 1);
  await ingress.receive(alert()); assert.deepEqual((await rows('outbox')).find(row => row.idempotency_key.startsWith('alert:'))!.service_ids, [service.id]);
});

for (const seconds of [1, 15, 60, 120]) test(`4314491278 템플릿 ${seconds}초 상한에서 Runtime read 성공·시간창 준수`, async () => {
  const requests: Parameters<ReadTransport['query']>[0][] = [];
  const reader = new ReadAdapter([service], [{ ...template, maxWindowSeconds: seconds }], f.gate, { query: async request => {
    requests.push(request); return new TextEncoder().encode(JSON.stringify({ observedAt: request.to, rows: [{ status: 'healthy' }] }));
  } }, f.now);
  await f.ingress.receive(event('read', { kind: 'command', command: 'read', target: service.id, text: template.id }));
  await new Runtime(f.store, f.gate, f.worker, f.signer, reader).tickRead();
  assert.equal((await rows('jobs'))[0]!.state, 'succeeded'); assert.equal(f.requests.length, 0); assert.equal(requests.length, 1);
  const window = { from: f.now() - Math.min(60, seconds) * 1000, to: f.now() };
  assert.deepEqual((await rows('results'))[0]!.result.window, window);
  assert.equal(requests[0]!.from, window.from); assert.equal(requests[0]!.to, window.to);
});
test('4314491278 recent도 서비스/템플릿 인가 유지, 명시적인 초과 시간창은 여전히 거부', async () => {
  let calls = 0;
  const reader = new ReadAdapter([service], [{ ...template, maxWindowSeconds: 5 }], f.gate, { query: async () => { calls++; throw new Error('unexpected'); } }, f.now);
  await assert.rejects(reader.read(f.policy.owner, thread, { service: service.id, template: template.id, from: f.now() - 6000, to: f.now() }), Denied);
  await assert.rejects(reader.recent(f.policy.owner, thread, { service: service.id, template: 'unknown' }), Denied);
  f.policy.services = []; await assert.rejects(reader.recent(f.policy.owner, thread, { service: service.id, template: template.id }), Denied);
  assert.equal((await reader.recent(f.policy.owner, thread, { service: 'unregistered', template: template.id })).status, 'unregistered');
  assert.equal(calls, 0);
  for (const maxWindowSeconds of [0, 0.5, NaN, Infinity]) assert.throws(() => new ReadAdapter([service], [{ ...template, maxWindowSeconds }], f.gate, { query: async () => new Uint8Array() }, f.now), Denied);
});

test('4314491292 task A의 맥락은 같은 시각에 수락한 후속 task B를 포함하지 않음', async () => {
  await f.ingress.receive(event('z-A', { kind: 'command', command: 'task', text: '작업 A' }));
  await f.ingress.receive(event('a-B', { kind: 'command', command: 'task', text: '작업 B' }));
  await f.runtime.tick(); await f.runtime.tick();
  assert.deepEqual(texts(f.requests[0]!.untrusted), ['작업 A']);
  assert.deepEqual(texts(f.requests[1]!.untrusted), ['작업 A', '작업 B']);
});
test('4314491292 chat claim 뒤 맥락 조회 전에 들어온 이벤트도 제외', async () => {
  await f.ingress.receive(event('A', { text: '응답 A' })); f.advance(DEFAULTS.debounceMs + 50);
  const context = f.store.context.bind(f.store); let arrived = false;
  f.store.context = async (...args) => {
    if (!arrived) { arrived = true; await f.ingress.receive(event('B', { text: '응답 B' })); }
    return context(...args);
  };
  await f.runtime.tick(); f.advance(DEFAULTS.debounceMs + 50); await f.runtime.tick();
  assert.deepEqual(texts(f.requests[0]!.untrusted), ['응답 A']);
  assert.deepEqual(texts(f.requests[1]!.untrusted), ['응답 A', '응답 B']);
});
test('4314491292 causal boundary 안에서도 20건/32KiB·accepted·대화 격리 유지', async () => {
  const ids: string[] = [];
  for (let i = 0; i < 35; i++) {
    const saved = await f.store.save(event(`item-${i}`, { text: `내용 ${i}` }), f.policy.revision, true); ids.push(saved.id);
    await database.db.query('UPDATE events SET accepted=true WHERE id=$1', [saved.id]);
  }
  const conversation = f.store.scopeId(thread);
  assert.deepEqual(texts(await f.store.context(conversation, ids[24]!)), Array.from({ length: 20 }, (_, i) => `내용 ${i + 5}`));
  const unaccepted = await f.store.save(event('unaccepted', { text: '미수락' }), f.policy.revision, true);
  assert.equal(texts(await f.store.context(conversation, unaccepted.id)).includes('미수락'), false);
  const foreign = await f.store.save(event('foreign', { scope: { ...thread, channel: 'other-thread' } }), f.policy.revision, true);
  assert.deepEqual(await f.store.context(conversation, foreign.id), []); assert.deepEqual(await f.store.context(conversation, 'missing'), []);
  let last = '';
  for (let i = 0; i < 6; i++) {
    last = (await f.store.save(event(`large-${i}`, { text: '가'.repeat(8000) }), f.policy.revision, true)).id;
    await database.db.query('UPDATE events SET accepted=true WHERE id=$1', [last]);
  }
  const bounded = await f.store.context(conversation, last);
  assert.equal(bounded.length, 1); assert.ok(Buffer.byteLength(JSON.stringify(bounded)) <= 32768);
});

// The source-backed model selects the nearest newer N, then returns that page newest first.
// Without after, model Discord's latest-N selection to catch a missing initial cursor.
for (const checkpoint of ['1000', null]) test(`4314491302 after 최근접 페이지·내림차순 응답으로 150건 완전 복구 (${checkpoint})`, async () => {
  await f.store.save(event('seed', { kind: 'command', command: 'chat' }), f.policy.revision, true);
  await database.db.query('DELETE FROM events');
  await database.db.query('UPDATE conversations SET active=true,checkpoint=$1', [checkpoint]);
  const base = checkpoint === null ? 0 : Number(checkpoint);
  const source = Array.from({ length: 150 }, (_, i) => ({ id: String(base + i + 1), channel_id: thread.channel,
    content: `복구 ${i}`, author: { id: f.policy.owner } }));
  const cursors: (string | null)[] = []; const pages: string[][] = [];
  const protocol = new DiscordProtocol({ request: async (_method, path) => {
    if (!path.includes('/messages?')) return { id: thread.channel, type: 11, parent_id: thread.parent, guild_id: thread.guild };
    const url = new URL(path, 'http://fixture'); const after = url.searchParams.get('after'); cursors.push(after);
    const selected = after === null ? source.slice(-100) : source.filter(m => BigInt(m.id) > BigInt(after)).slice(0, 100);
    const page = [...selected].reverse(); pages.push(page.map(m => m.id)); return page;
  } }, 'fixture-bot', f.now);
  await new DiscordIngress(f.store, f.gate, protocol).recover(thread, f.policy.owner);
  assert.deepEqual(cursors, [String(base), String(base + 100)]);
  assert.deepEqual(pages[0], source.slice(0, 100).map(m => m.id).reverse());
  const recovered = (await database.db.query<{ delivery_id: string }>('SELECT delivery_id FROM events ORDER BY event_order')).rows;
  assert.deepEqual(recovered.map(e => e.delivery_id), source.map(m => m.id));
  assert.equal((await f.store.conversation(thread))!.checkpoint, String(base + 150)); assert.equal((await f.store.conversation(thread))!.gap, false);
});

test('4314491268 claim 뒤 병합된 서비스도 게시 직전 현재 범위로 재인가', async () => {
  const ingress = new AlertIngress(f.store, f.gate); const next = 'fixture-next-service'; f.policy.services.push(next);
  await ingress.receive(alert());
  const claim = f.store.claimDelivery.bind(f.store);
  f.store.claimDelivery = async () => {
    const claimed = await claim(); await ingress.receive(alert([next])); f.policy.services = [service.id]; return claimed;
  };
  await f.publisher.deliver(); assert.equal(f.rest.threads.length, 0);
  assert.equal((await rows('outbox'))[0]!.state, 'blocked');
});
