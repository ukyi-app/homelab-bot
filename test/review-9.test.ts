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
import { Store } from '../src/store.js';
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
  const answer = f.rest.messages.find(message => message.body.content.startsWith('사실:'))!;
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

