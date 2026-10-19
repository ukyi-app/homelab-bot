import { after, before, beforeEach, test } from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { readFile } from 'node:fs/promises';
import { setTimeout as delay } from 'node:timers/promises';
import { Agent } from 'undici';
import { DEFAULTS, Denied, DiscordUnauthorized, WorkerRejected } from '../src/contracts.js';
import { HttpWorker } from '../src/worker-http.js';
import { workerRequest } from '../src/worker.js';
import type { WorkerResult } from '../src/worker.js';
import { Runtime } from '../src/runtime.js';
import { DiscordPublisher } from '../src/discord.js';
import { AlertIngress } from '../src/alerts.js';
import { event, fixture, localDatabase, service, thread } from './helpers.js';

let database: Awaited<ReturnType<typeof localDatabase>>;
let f: Awaited<ReturnType<typeof fixture>>;
const answer = { facts: [], hypotheses: [], unknowns: [], checks: [] };
const success: WorkerResult = { status: 'succeeded', stopped: true, answer };
before(async () => { database = await localDatabase(); });
beforeEach(async () => {
  await database.pg.exec('TRUNCATE events,conversations,jobs,results,outbox,schedules,denied_actors,controls,audit,incidents RESTART IDENTITY CASCADE');
  f = await fixture(database.db);
});
after(async () => { await database.pg.close(); });
async function rows(table: string) { return (await database.db.query<Record<string, any>>(`SELECT * FROM ${table}`)).rows; }
async function queue(id = 'first') { await f.ingress.receive(event(id)); f.advance(800); }
async function enqueue() {
  await f.store.enqueue({ key: 'delivery', actor: f.policy.owner, scope: thread, revision: f.policy.revision,
    payload: { kind: 'message', channel: thread.channel, content: '확인된 요약', classification: 'safe_summary' } });
}

test('R2-01 닫힌 worker 포트는 failed와 안내, 다음 작업 실행', async () => {
  const server = createServer(); server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const port = (server.address() as AddressInfo).port; server.close(); await once(server, 'close');
  await queue();
  const client = new HttpWorker(`http://127.0.0.1:${port}`, fetch);
  await new Runtime(f.store, f.gate, client, f.signer, f.reader).tick();
  assert.equal((await rows('jobs'))[0]!.state, 'failed');
  await f.publisher.deliver(); assert.match(f.rest.messages[0]!.body.content, /실패/);
  await queue('second'); await f.runtime.tick(); assert.equal(f.requests.length, 1);
});
test('R2-01 연결 수립 전 오류만 확정 거부, reset·혼합 원인은 불명 유지', async () => {
  await queue(); const job = (await f.store.claim())!; const request = workerRequest(job, []);
  for (const code of ['ECONNREFUSED', 'ENOTFOUND', 'EAI_AGAIN', 'UND_ERR_CONNECT_TIMEOUT', 'ECONNRESET', 'UND_ERR_SOCKET']) {
    const failure = new TypeError('fetch failed', { cause: Object.assign(new Error(code), { code }) });
    const client = new HttpWorker('http://worker:8080', async () => { throw failure; });
    await assert.rejects(client.execute(request, 'fixture', new AbortController().signal), error =>
      ['ECONNRESET', 'UND_ERR_SOCKET'].includes(code) ? error === failure : error instanceof WorkerRejected);
  }
  const failure = new TypeError('fetch failed', { cause: new AggregateError([
    { code: 'ECONNREFUSED' }, { code: 'ECONNRESET' },
  ]) });
  const client = new HttpWorker('http://worker:8080', async () => { throw failure; });
  await assert.rejects(client.execute(request, 'fixture', new AbortController().signal), error => error === failure);
});
test('R2-01 실제 응답 도중 단절은 unknown으로 슬롯 유지', async () => {
  const server = createServer((_req, res) => { res.writeHead(200); res.write('{'); setTimeout(() => res.destroy(), 10); });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  try {
    await queue(); const client = new HttpWorker(`http://127.0.0.1:${(server.address() as AddressInfo).port}`, fetch);
    await new Runtime(f.store, f.gate, client, f.signer, f.reader).tick();
    assert.equal((await rows('jobs'))[0]!.state, 'unknown'); assert.equal(await f.runtime.tick(), false);
  } finally { server.close(); await once(server, 'close'); }
});
for (const stopConfirmed of [true, false]) test(`R2-02 실행 중 stale은 중단하지 않고 heartbeat·완료 보존 (stop=${stopConfirmed})`, async () => {
  let finish!: (r: WorkerResult) => void; let started!: () => void; let cancels = 0;
  const ready = new Promise<void>(resolve => { started = resolve; });
  f.setRun(() => { started(); return new Promise(resolve => { finish = resolve; }); });
  f.worker.cancel = async () => { cancels++; return { stopped: stopConfirmed }; };
  await queue(); const running = f.runtime.tick(); await ready;
  const initialLease = Number((await rows('jobs'))[0]!.lease_until);
  f.policy.confirmedAt -= DEFAULTS.policyMaxAgeMs + 1; f.advance(1000);
  await delay(1150);
  assert.equal((await rows('jobs'))[0]!.state, 'running'); assert.equal(cancels, 0);
  assert.ok(Number((await rows('jobs'))[0]!.lease_until) > initialLease);
  finish(success); await running;
  assert.equal((await rows('jobs'))[0]!.state, 'succeeded');
  await f.publisher.deliver(); assert.equal(f.rest.messages.length, 0);
  f.policy.confirmedAt = f.now(); f.advance(1000); await f.publisher.deliver();
  assert.equal(f.rest.messages.length, 1); assert.equal(f.requests.length, 1);
});
test('R2-02 실제 권한 철회는 중단, 종료 확인 실패 안내 보존', async () => {
  let started!: () => void; let cancels = 0;
  const ready = new Promise<void>(resolve => { started = resolve; });
  f.setRun(() => { started(); return new Promise(() => {}); });
  f.worker.cancel = async () => { cancels++; return { stopped: true }; };
  await queue(); const running = f.runtime.tick(); await ready;
  f.policy.owner = 'replacement-owner'; await running;
  assert.equal(cancels, 1); assert.equal((await rows('jobs'))[0]!.state, 'failed');
  assert.equal((await rows('outbox')).length, 1);
  await f.publisher.deliver(); assert.equal(f.rest.messages.length, 0);
});
test('R2-02 timeout 중단 확인은 failed 안내, 새 작업 실행', async () => {
  await queue(); await database.db.query(`UPDATE jobs SET budget='{"timeoutMs":20,"toolCalls":8}'`);
  f.setRun(() => new Promise(() => {})); await f.runtime.tick();
  assert.equal((await rows('jobs'))[0]!.state, 'failed');
  await f.publisher.deliver(); assert.match(f.rest.messages[0]!.body.content, /실패/);
  f.setRun(async () => success); await queue('second'); await f.runtime.tick(); assert.equal(f.requests.length, 2);
});
test('R2-03 재시작 대조 표는 3열이며 Discord 복구 계약 유지', async () => {
  const text = await readFile('docs/ai-bot/ARCHITECTURE.md', 'utf8');
  const table = text.split('**재시작·누락 대조**')[1]!.split('**IDENTIFY 예산:**')[0]!;
  for (const row of table.split('\n').filter(line => line.startsWith('|'))) assert.equal(row.split('|').length, 5);
  const discord = table.split('\n').find(line => line.startsWith('| Discord |'))!;
  for (const required of ['RESUME', 'IDENTIFY', 'after=', '100건×10쪽/30초', '`gap`', '보관된 스레드', '구독 목록 원본은 봇 DB']) assert.ok(discord.includes(required), required);
});
test('R2-04 무관한 revision은 철회 유지, 명시 해제 ID는 해당 철회 한 번만 허용', async () => {
  await f.gate.revoke(f.policy.owner, thread, f.policy.owner);
  const first = (await rows('denied_actors'))[0]!.denial_id;
  f.advance(1); f.policy.revision = 'unrelated-services'; f.policy.services.push('new-service'); f.policy.confirmedAt = f.now();
  await assert.rejects(f.gate.authorize(f.policy.owner, thread), Denied);
  f.policy.revocationRestores = [first]; await f.gate.authorize(f.policy.owner, thread);
  await f.gate.revoke(f.policy.owner, thread, f.policy.owner);
  assert.notEqual((await rows('denied_actors'))[0]!.denial_id, first);
  f.advance(1); f.policy.revision = 'another-change'; f.policy.confirmedAt = f.now();
  await assert.rejects(f.gate.authorize(f.policy.owner, thread), Denied);
});
test('R2-05 혼합 경보 그룹은 지원 항목만 게시하고 제외 건수 감사', async () => {
  const ingress = new AlertIngress(f.store, f.gate);
  const supported = { fingerprint: 'supported', labels: { service: service.id, severity: 'warning' } };
  const unsupported = { fingerprint: 'unsupported', labels: { service: 'unregistered', severity: 'page' } };
  await ingress.receive({ groupKey: 'mixed', status: 'firing', alerts: [supported, unsupported] });
  assert.equal((await rows('outbox')).length, 1);
  assert.equal((await rows('audit'))[0]!.detail.count, 1);
  await f.publisher.deliver(); await f.publisher.deliver();
  assert.match(f.rest.messages[0]!.body.content, /경보 firing: 1건/);
  await ingress.receive({ groupKey: 'mixed', status: 'firing', alerts: [supported, { ...unsupported, fingerprint: 'changed' }] });
  await f.publisher.deliver(); assert.equal(f.rest.messages.length, 1); assert.equal(f.requests.length, 0);
});
test('R2-06 일시 중지는 변화 때만 감사, 재시작에도 backoff 유지·복구', async () => {
  await enqueue(); f.policy.confirmedAt -= DEFAULTS.policyMaxAgeMs + 1;
  let publisher = f.publisher;
  for (let i = 0; i < 9; i++) {
    await publisher.deliver();
    const row = (await rows('outbox'))[0]!;
    assert.equal(row.attempt, 0);
    assert.equal(Number(row.available_at) - f.now(), Math.min(60_000, 1000 * 2 ** i));
    assert.equal(await publisher.deliver(), false);
    f.advance(Number(row.available_at) - f.now());
    publisher = new DiscordPublisher(f.store, f.gate, f.rest);
  }
  assert.equal((await rows('audit')).filter(r => r.kind === 'delivery_paused').length, 1);
  f.policy.confirmedAt = f.now(); f.rest.rateLimit = new DiscordUnauthorized(); await publisher.deliver();
  assert.equal((await rows('audit')).filter(r => r.kind === 'delivery_paused').length, 2);
  for (let i = 0; i < 3; i++) {
    f.advance(Number((await rows('outbox'))[0]!.available_at) - f.now());
    f.rest.rateLimit = new DiscordUnauthorized(); await publisher.deliver();
  }
  assert.equal((await rows('audit')).filter(r => r.kind === 'delivery_paused').length, 2);
  f.advance(Number((await rows('outbox'))[0]!.available_at) - f.now()); await publisher.deliver();
  assert.equal(f.rest.messages.length, 1); assert.equal((await rows('outbox'))[0]!.pause_reason, null);
});
for (const parent of [true, false]) test(`R2-07 interaction ACK 만료는 처리 대화에 안내 하나 (parent=${parent})`, async () => {
  const scope = parent ? { ...thread, kind: 'channel' as const, channel: thread.parent!, parent: null } : thread;
  f.rest.acknowledge = async () => { f.advance(3100); throw new Error('interaction_expired'); };
  const input = event('interaction', { kind: 'command', command: 'chat', scope });
  await f.ingress.receive(input); await f.ingress.receive(input);
  if (parent) await f.publisher.deliver();
  await f.publisher.deliver();
  assert.equal(f.rest.messages.length, 1); assert.match(f.rest.messages[0]!.body.content, /다시 보내기 전에/);
  assert.equal(f.rest.messages[0]!.channel, parent ? f.rest.threads[0]!.id : thread.channel);
  assert.equal((await rows('jobs')).length, 1);
  f.advance(800); await f.runtime.tick(); assert.equal(f.requests.length, 1);
});
test('R2-08 작은 transport 기본 timeout을 예산 설정으로 덮어 느린 headers/body 수집', async () => {
  await queue(); const job = (await f.store.claim())!; job.budget.timeoutMs = 5000;
  for (const phase of ['headers', 'body']) {
    const payload = JSON.stringify(success);
    const server = createServer((_req, res) => {
      if (phase === 'body') { res.writeHead(200, { 'content-type': 'application/json' }); res.write(payload.slice(0, 1)); }
      setTimeout(() => res.end(phase === 'body' ? payload.slice(1) : payload), 1600);
    });
    server.listen(0, '127.0.0.1'); await once(server, 'listening');
    const endpoint = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    const baseline = new Agent({ headersTimeout: 50, bodyTimeout: 50 });
    try {
      await assert.rejects(async () => { const options = { method: 'GET', dispatcher: baseline }; await (await fetch(endpoint, options)).json(); });
      const client = new HttpWorker(endpoint, fetch, options => new Agent({
        ...{ headersTimeout: 50, bodyTimeout: 50 }, ...options,
      }));
      const result = await client.execute(workerRequest(job, []), 'fixture', AbortSignal.timeout(5000));
      assert.equal(result.status, 'succeeded');
    } finally { await baseline.destroy(); server.close(); await once(server, 'close'); }
  }
});
test('R2-09 retry 0건은 실패 안내, 범위·상태·횟수 확인 뒤에만 재수락', async () => {
  await queue(); const job = (await rows('jobs'))[0]!; const conversation = f.store.scopeId(thread);
  const retry = async (id = job.id, owner = f.policy.owner, scope = conversation) => f.store.control(owner, scope, 'retry', id) as Promise<{ ok?: boolean }>;
  assert.equal((await retry()).ok, false);
  await database.db.query("UPDATE jobs SET state='failed',attempt=1");
  assert.equal((await retry('00000000-0000-4000-8000-000000000000')).ok, false);
  assert.equal((await retry(job.id, 'intruder')).ok, false);
  assert.equal((await retry(job.id, f.policy.owner, 'channel:other')).ok, false);
  await database.db.query('UPDATE jobs SET attempt=$1', [DEFAULTS.maxRetries + 1]);
  assert.equal((await retry()).ok, false);
  await database.db.query('UPDATE jobs SET attempt=1'); assert.notEqual((await retry()).ok, false);
  assert.equal((await rows('jobs'))[0]!.state, 'queued');
});
