import { after, before, beforeEach, test } from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { readFile } from 'node:fs/promises';
import { DEFAULTS, Denied, DiscordUnauthorized, PolicyUnavailable, WorkerRejected } from '../src/contracts.js';
import type { Scope } from '../src/contracts.js';
import { DiscordIngress, DiscordPublisher, deliveryMarker } from '../src/discord.js';
import { DiscordProtocol, discordHttpApi } from '../src/discord-protocol.js';
import { Runtime } from '../src/runtime.js';
import { Store } from '../src/store.js';
import type { Delivery } from '../src/store.js';
import { HttpWorker, workerServer } from '../src/worker-http.js';
import { workerRequest } from '../src/worker.js';
import { PolicyGate } from '../src/policy.js';
import { AlertIngress } from '../src/alerts.js';
import { Health } from '../src/health.js';
import { receivers } from '../src/http.js';
import { event, fixture, localDatabase, service, thread } from './helpers.js';

let database: Awaited<ReturnType<typeof localDatabase>>;
let f: Awaited<ReturnType<typeof fixture>>;
const channel: Scope = { ...thread, kind: 'channel', channel: 'fixture-chat', parent: null };
const answer = { facts: [], hypotheses: [], unknowns: [], checks: [] };
before(async () => { database = await localDatabase(); });
beforeEach(async () => {
  await database.pg.exec('TRUNCATE events,conversations,jobs,results,outbox,schedules,denied_actors,controls,audit,incidents RESTART IDENTITY CASCADE');
  f = await fixture(database.db);
});
after(async () => { await database.pg.close(); });
async function rows(table: string) { return (await database.db.query<Record<string, any>>(`SELECT * FROM ${table}`)).rows; }
async function queue(id = 'first') { await f.ingress.receive(event(id)); f.advance(800); }
async function enqueue(key = 'delivery') {
  await f.store.enqueue({ key, actor: f.policy.owner, scope: thread, revision: f.policy.revision,
    payload: { kind: 'message', channel: thread.channel, content: '확인된 요약', classification: 'safe_summary' } });
}
const alert = { groupKey: 'fixture-group', status: 'firing', alerts: [{ fingerprint: 'fixture-fingerprint', labels: { service: service.id, severity: 'warning' } }] };

test('R1-01 부모 채널은 매번 멘션/명령 필요, 활성 스레드만 후속 수집', async () => {
  await f.ingress.receive(event('start', { scope: channel })); await f.publisher.deliver();
  assert.equal((await f.store.conversation(channel))!.active, false);
  const resumed = await f.store.control(f.policy.owner, f.store.scopeId(channel), 'resume') as { ok: boolean };
  assert.equal(resumed.ok, false);
  await database.db.query('UPDATE conversations SET active=true WHERE id=$1', [f.store.scopeId(channel)]);
  await f.ingress.receive(event('casual', { scope: channel, mention: false, text: '점심 뭐 먹지' }));
  await f.publisher.deliver();
  assert.equal(f.rest.threads.length, 1); assert.equal(f.rest.acks.length, 1);
  assert.equal((await rows('events')).length, 1); assert.equal((await rows('jobs')).length, 1);
  await f.ingress.receive(event('explicit-again', { scope: channel }));
  assert.equal((await f.store.conversation(channel))!.active, false);
  await f.ingress.receive(event('follow', { scope: { ...thread, channel: f.rest.threads[0]!.id }, mention: false }));
  assert.equal((await rows('events')).length, 3);
});
test('R1-02 잘못된 read는 수신 전에 거부하고 다음 대화는 실행', async () => {
  await assert.rejects(f.ingress.receive(event('invalid', { kind: 'command', command: 'read' })), Denied);
  assert.equal((await rows('events')).length, 0); assert.equal(f.rest.acks.length, 0);
  await queue(); await f.runtime.tick(); assert.equal((await rows('jobs'))[0]!.state, 'succeeded');
});
test('R1-02 dispatch 전 DB 오류는 failed, 슬롯과 실패 안내 유지', async () => {
  await queue(); const query = database.db.query.bind(database.db); let fail = true;
  database.db.query = async (sql, params) => {
    if (fail && sql.includes('SELECT payload FROM events')) { fail = false; throw new Error('temporary_db_error'); }
    return query(sql, params);
  };
  try { await f.runtime.tick(); } finally { database.db.query = query; }
  assert.equal((await rows('jobs'))[0]!.state, 'failed'); assert.equal(f.requests.length, 0);
  await f.publisher.deliver(); assert.match(f.rest.messages[0]!.body.content, /실패/);
  await queue('second'); await f.runtime.tick(); assert.equal(f.requests.length, 1);
});
test('R1-02 stopped:true 무효 출력은 failed, mutex 해제 뒤 다음 작업 실행', async () => {
  for (const invalid of [{ ...answer, facts: ['x'.repeat(501)] }, { ...answer, tool: 'shell' }]) {
    await queue(`bad-${(await rows('jobs')).length}`);
    f.setRun(async () => ({ status: 'succeeded', stopped: true, answer: invalid }));
    await f.runtime.tick(); assert.equal((await rows('jobs')).at(-1)!.state, 'failed');
    f.setRun(async () => ({ status: 'succeeded', stopped: true, answer }));
    await queue(`good-${(await rows('jobs')).length}`); await f.runtime.tick();
    assert.equal((await rows('jobs')).at(-1)!.state, 'succeeded');
  }
});
test('R1-02 HTTP 실행 전 거부와 실행 후 예외를 구분', async () => {
  const server = workerServer(f.worker); server.listen(0, '127.0.0.1'); await once(server, 'listening');
  try {
    const client = new HttpWorker(`http://127.0.0.1:${(server.address() as AddressInfo).port}`, fetch);
    await queue(); const job = (await f.store.claim())!; const request = workerRequest(job, []);
    await assert.rejects(client.execute(request, 'invalid', new AbortController().signal), WorkerRejected);
    assert.equal(f.requests.length, 0);
    f.setRun(async () => { throw new Error('disconnected_after_start'); });
    const result = await client.execute(request, f.signer.issue(job, 'execute', request), new AbortController().signal);
    assert.deepEqual(result, { status: 'unknown', stopped: false });
  } finally { server.close(); await once(server, 'close'); }
});
test('R1-02 HttpWorker의 중단 확인된 무효 JSON 출력도 failed', async () => {
  await queue(); const job = (await f.store.claim())!;
  const client = new HttpWorker('http://worker:8080', async () => new Response(JSON.stringify({ status: 'succeeded', stopped: true, answer: { tool: 'shell' } })));
  assert.deepEqual(await client.execute(workerRequest(job, []), 'fixture', new AbortController().signal), { status: 'failed', stopped: true });
});
test('R1-02 실행 전 작업자 거부는 Runtime failed, 다음 모델 작업 허용', async () => {
  await queue();
  const runtime = new Runtime(f.store, f.gate, {
    execute: async () => { throw new WorkerRejected(); }, cancel: async () => ({ stopped: false }),
  }, f.signer, f.reader);
  await runtime.tick(); assert.equal((await rows('jobs'))[0]!.state, 'failed');
  await f.publisher.deliver(); assert.match(f.rest.messages[0]!.body.content, /실패/);
  await queue('after-rejection'); await f.runtime.tick(); assert.equal(f.requests.length, 1);
});
test('R1-03/EVENT-03 실제 Protocol.history와 DB jsonb scope로 101건 복구', async () => {
  await queue('1'); const scope = (await f.store.conversation(thread))!.scope;
  const cursors: string[] = [];
  const protocol = new DiscordProtocol({ request: async (_method, path) => {
    if (path === `/channels/${thread.channel}`) return { id: thread.channel, type: 11, parent_id: thread.parent, guild_id: thread.guild };
    const url = new URL(path, 'http://fixture'); const after = url.searchParams.get('after')!; cursors.push(after);
    const start = Number(after) + 1; const count = after === '1' ? 100 : 1;
    return Array.from({ length: count }, (_, i) => ({ id: String(start + i), channel_id: thread.channel, content: '후속', author: { id: f.policy.owner } })).reverse();
  } }, 'fixture-bot', f.now);
  const ingress = new DiscordIngress(f.store, f.gate, protocol);
  await ingress.recover(scope, f.policy.owner);
  assert.deepEqual(cursors, ['1', '101']); assert.equal((await rows('events')).length, 102);
  assert.equal((await f.store.conversation(thread))!.checkpoint, '102');
  assert.equal((await f.store.conversation(thread))!.gap, false);
  await f.ingress.receive(event('103', { mention: false })); assert.equal((await rows('events')).length, 103);
});
test('R1-04 정책 stale은 queued/pending 유지, 갱신 뒤 같은 작업과 게시 재개', async () => {
  await queue(); await enqueue(); f.advance(300001);
  await f.runtime.tick(); await f.publisher.deliver();
  assert.equal((await rows('jobs'))[0]!.state, 'queued'); assert.equal((await rows('outbox'))[0]!.state, 'pending');
  assert.equal(f.requests.length, 0); assert.equal(f.rest.messages.length, 0);
  f.advance(1001); f.policy.confirmedAt = f.now(); f.policy.revision = 'fixture-v2';
  await f.runtime.tick(); await f.publisher.deliver();
  assert.equal((await rows('jobs'))[0]!.state, 'succeeded'); assert.equal(f.requests.length, 1);
  assert.equal(f.requests[0]!.policyRevision, 'fixture-v2'); assert.equal(f.rest.messages.length, 1);
});
test('R1-04 정책 파일 일시 누락도 queued 유지, 실제 철회만 cancelled', async () => {
  await queue(); let missing = true;
  const gate = new PolicyGate(async () => { if (missing) throw new Error('missing'); return f.policy; }, database.db, f.now);
  const runtime = new Runtime(f.store, gate, f.worker, f.signer, f.reader);
  await runtime.tick(); assert.equal((await rows('jobs'))[0]!.state, 'queued');
  missing = false; f.advance(1001); f.policy.owner = 'replacement'; f.policy.confirmedAt = f.now();
  await runtime.tick(); assert.equal((await rows('jobs'))[0]!.state, 'cancelled'); assert.equal(f.requests.length, 0);
});
test('R1-04 revision만 바뀌면 현재 정책으로 허용, 완료 결과는 stale 동안 재실행 없이 대기', async () => {
  await queue(); f.policy.revision = 'fixture-v2';
  f.setRun(async () => { f.policy.confirmedAt = f.now() - 300001; return { status: 'succeeded', stopped: true, answer }; });
  await f.runtime.tick(); assert.equal((await rows('jobs'))[0]!.state, 'succeeded');
  await f.publisher.deliver(); assert.equal((await rows('outbox'))[0]!.state, 'pending');
  f.advance(1001); f.policy.confirmedAt = f.now(); await f.publisher.deliver();
  assert.equal(f.rest.messages.length, 1); assert.equal(f.requests.length, 1);
});
test('R1-04 Discord 401은 정책 거부와 구분, 새 자격 어댑터로 pending 게시 재개', async () => {
  await enqueue(); let calls = 0;
  const api = discordHttpApi('fixture-token', async () => { calls++; return new Response('', { status: 401 }); });
  const publisher = new DiscordPublisher(f.store, f.gate, new DiscordProtocol(api, 'fixture-bot', f.now));
  await publisher.deliver(); f.advance(1001); await publisher.deliver();
  assert.equal(calls, 1); assert.equal((await rows('outbox'))[0]!.state, 'pending');
  f.advance(Number((await rows('outbox'))[0]!.available_at) - f.now());
  await f.publisher.deliver(); assert.equal((await rows('outbox'))[0]!.state, 'sent');
});
test('R1-05 ACK가 보인 뒤 응답 유실/재시작에도 작업 하나가 남음', async () => {
  f.rest.acknowledge = async e => {
    f.rest.acks.push({ event: e, options: {} });
    assert.equal((await rows('jobs')).length, 1); throw new Error('response_timeout_after_publish');
  };
  await f.ingress.receive(event('lost')); await f.ingress.receive(event('lost'));
  const restarted = new Runtime(new Store(database.db, f.now), f.gate, f.worker, f.signer, f.reader);
  f.advance(800); await restarted.tick();
  assert.equal(f.rest.acks.length, 1); assert.equal(f.requests.length, 1); assert.equal((await rows('jobs')).length, 1);
});
test('R1-05 queue_full·outbox 저장 실패는 ACK 전에 실패하고 수락하지 않음', async () => {
  const query = database.db.query.bind(database.db);
  const transaction = database.db.transaction.bind(database.db);
  database.db.transaction = fn => transaction(tx => fn({ ...tx, query: async (sql, params) => {
    if (sql.includes("SELECT count(*) FROM jobs WHERE state='queued'")) return { rows: [{ count: '100' }] } as any;
    return tx.query(sql, params);
  } }));
  try { await assert.rejects(f.ingress.receive(event('full')), /queue_full/); }
  finally { database.db.transaction = transaction; }
  assert.equal(f.rest.acks.length, 0); assert.equal((await rows('events'))[0]!.accepted, false);
  database.db.transaction = fn => transaction(tx => fn({ ...tx, query: async (sql, params) => {
    if (sql.includes('INSERT INTO outbox')) throw new Error('outbox_unavailable');
    return tx.query(sql, params);
  } }));
  try { await assert.rejects(f.ingress.receive(event('thread', { scope: channel })), /outbox_unavailable/); }
  finally { database.db.transaction = transaction; database.db.query = query; }
  assert.equal(f.rest.acks.length, 0); assert.equal((await rows('outbox')).length, 0);
});
test('R1-06 느린 HTTP 작업도 예산에 맞춘 dispatcher로 완료', async () => {
  const delay = Number(process.env.HOMELAB_WORKER_SLOW_MS ?? 1100);
  assert.ok(Number.isInteger(delay) && delay >= 1100 && delay <= 1_790_000);
  await queue(); const job = (await f.store.claim())!; job.budget.timeoutMs = delay + 5000;
  const server = createServer((_req, res) => { setTimeout(() => res.end(JSON.stringify({ status: 'succeeded', stopped: true, answer })), delay); });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  try {
    let dispatcherSeen = false;
    const client = new HttpWorker(`http://127.0.0.1:${(server.address() as AddressInfo).port}`, async (url, init) => {
      dispatcherSeen = !!(init as { dispatcher?: unknown })?.dispatcher;
      return fetch(url, init);
    });
    const started = Date.now();
    const result = await client.execute(workerRequest(job, []), 'fixture', AbortSignal.timeout(job.budget.timeoutMs));
    assert.equal(result.status, 'succeeded'); assert.equal(dispatcherSeen, true);
    assert.ok(Date.now() - started >= delay);
  } finally { server.close(); await once(server, 'close'); }
});
test('R1-07 unknown 100건이 신규 경보를 막지 않고 초과/기한은 감사 후 종료', async () => {
  for (let i = 0; i < 101; i++) await enqueue(`unknown-${i}`);
  await database.db.query("UPDATE outbox SET state='unknown'");
  await new AlertIngress(f.store, f.gate).receive(alert);
  assert.equal((await rows('incidents')).length, 1);
  const health = new Health(f.store, async () => {}); assert.match(await health.metrics(), /outbox_unknown 101/);
  await f.store.retireUnknownDeliveries(); assert.equal((await rows('outbox')).filter(r => r.state === 'unknown').length, 100);
  f.advance(DEFAULTS.unknownDeliveryMs); await f.store.retireUnknownDeliveries();
  assert.equal((await rows('outbox')).filter(r => r.state === 'unknown').length, 0);
  assert.equal((await rows('audit')).filter(r => r.kind === 'delivery_unresolved_retired').length, 101);
  assert.equal(f.rest.messages.length, 0);
});
test('R1-08/EVENT-02 실제 Protocol.findDelivery는 다른 작성자의 marker를 무시하고 대조', async () => {
  await enqueue(); let content = ''; let sends = 0; let includeBot = false;
  const protocol = new DiscordProtocol({ request: async (method, _path, input) => {
    if (method === 'POST') { sends++; content = (input as { content: string }).content; throw new Error('response_lost'); }
    return [{ id: 'fake', channel_id: thread.channel, author: { id: 'intruder' }, content },
      ...(includeBot ? [{ id: 'actual', channel_id: thread.channel, author: { id: 'fixture-bot' }, content }] : [])];
  } }, 'fixture-bot', f.now);
  const publisher = new DiscordPublisher(f.store, f.gate, protocol);
  await publisher.deliver(); await publisher.reconcile(); assert.equal((await rows('outbox'))[0]!.state, 'unknown');
  includeBot = true; await publisher.reconcile(); await publisher.deliver();
  assert.equal((await rows('outbox'))[0]!.external_id, 'actual'); assert.equal(sends, 1);
});
test('R1-08/EVENT-02 실제 Protocol의 게시 대조는 페이지와 보관 스레드 검색', async () => {
  await enqueue(); const row = (await rows('outbox'))[0]! as Delivery; const marker = deliveryMarker(row); const paths: string[] = [];
  const protocol = new DiscordProtocol({ request: async (_method, path) => {
    paths.push(path);
    if (path === `/channels/${thread.parent}`) return { id: thread.parent, type: 0, guild_id: thread.guild };
    if (path.includes('/threads/active')) return { threads: [{ id: 'wrong-parent', parent_id: 'other', name: `homelab-${marker}` }] };
    if (path.includes('/threads/archived')) return { threads: [{ id: 'archived', parent_id: thread.parent, name: `homelab-${marker}` }] };
    if (path.includes('before=')) return [{ id: 'found', channel_id: thread.channel, author: { id: 'fixture-bot' }, content: `summary\n[ref:${marker}]` }];
    return Array.from({ length: 100 }, (_, i) => ({ id: String(200 - i), channel_id: thread.channel, author: { id: 'fixture-bot' }, content: 'unrelated' }));
  } }, 'fixture-bot', f.now);
  assert.equal((await protocol.findDelivery(thread.channel, marker, 'message'))!.id, 'found');
  assert.ok(paths.some(p => p.includes('before=101')));
  assert.equal((await protocol.findDelivery(thread.parent!, marker, 'thread'))!.id, 'archived');
});
test('R1-09 부모 채널 취소·목록은 영향 0을 명시하고 스레드 작업 유지', async () => {
  await queue(); const job = (await rows('jobs'))[0]!;
  const cancelled = await f.store.control(f.policy.owner, f.store.scopeId(channel), 'cancel', job.id) as { ok: boolean; status: string };
  assert.equal(cancelled.ok, false); assert.match(cancelled.status, /없거나/);
  const listed = await f.store.control(f.policy.owner, f.store.scopeId(channel), 'list') as { ok: boolean };
  assert.equal(listed.ok, false); assert.equal((await rows('jobs'))[0]!.state, 'queued');
});
test('R1-10 자기 철회는 같은 revision으로 해제 불가, 이후 확인한 새 정책만 복구', async () => {
  await f.gate.revoke(f.policy.owner, thread, f.policy.owner);
  f.advance(1); f.policy.confirmedAt = f.now(); await assert.rejects(f.gate.authorize(f.policy.owner, thread), Denied);
  f.policy.revision = 'fixture-v2'; f.policy.confirmedAt = f.now() - 1;
  await assert.rejects(f.gate.authorize(f.policy.owner, thread), Denied);
  f.policy.confirmedAt = f.now();
  f.policy.revocationRestores = [(await rows('denied_actors'))[0]!.denial_id];
  await f.gate.authorize(f.policy.owner, thread);
  await queue(); await f.runtime.tick(); assert.equal(f.requests.length, 1);
});
test('R1-11 설계의 런타임·Discord 선택이 설치 계약과 일치', async () => {
  const pkg = JSON.parse(await readFile('package.json', 'utf8'));
  const architecture = await readFile('docs/ai-bot/ARCHITECTURE.md', 'utf8');
  const tools = architecture.split('## 3.')[1]!.split('## 4.')[0]!;
  const foundation = architecture.split('## 11.')[1]!;
  for (const section of [tools, foundation]) {
    assert.ok(section.includes(`Node ${pkg.engines.node}`));
    assert.ok(section.includes('DiscordProtocol'));
  }
  assert.equal(Object.keys(pkg.dependencies).some(name => name.startsWith('@discordjs/')), false);
});
test('R1-12 Node 타입 major와 런타임 major 일치', async () => {
  const pkg = JSON.parse(await readFile('node_modules/@types/node/package.json', 'utf8'));
  assert.equal(pkg.version.split('.')[0], process.versions.node.split('.')[0]);
  const declared = JSON.parse(await readFile('package.json', 'utf8'));
  assert.equal(declared.devDependencies['@types/node'], pkg.version);
});
test('R1-13 서비스 없는 플랫폼 경보는 감사 후 202, 잘못된 형식은 400', async () => {
  const health = new Health(f.store, async () => {}); const servers = receivers(health, new AlertIngress(f.store, f.gate));
  servers.alerts.listen(0, '127.0.0.1'); await once(servers.alerts, 'listening');
  try {
    const endpoint = `http://127.0.0.1:${(servers.alerts.address() as AddressInfo).port}/alerts`;
    for (const labels of [{ alertname: 'BackupFailed' }, { service: service.id, severity: 'page' }]) {
      const response = await fetch(endpoint, { method: 'POST', body: JSON.stringify({ ...alert, alerts: [{ fingerprint: 'fixture', labels }] }) });
      assert.equal(response.status, 202);
    }
    assert.equal((await rows('audit')).filter(r => r.kind === 'alert_ignored').length, 2);
    assert.equal((await rows('outbox')).length, 0);
    assert.equal((await fetch(endpoint, { method: 'POST', body: '{broken' })).status, 400);
  } finally { servers.alerts.close(); await once(servers.alerts, 'close'); }
});
