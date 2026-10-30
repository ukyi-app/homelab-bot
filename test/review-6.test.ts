import { after, before, beforeEach, test } from 'node:test';
import assert from 'node:assert/strict';
import { sign } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import type { Agent } from 'undici';
import { AlertIngress } from '../src/alerts.js';
import { DEFAULTS, Denied, RateLimited, WorkerRejected } from '../src/contracts.js';
import type { Scope } from '../src/contracts.js';
import { MODEL_QUEUE_LIMIT } from '../src/store.js';
import { DiscordIngress, DiscordPublisher } from '../src/discord.js';
import { discordHttpApi } from '../src/discord-protocol.js';
import { Health } from '../src/health.js';
import { HttpWorker } from '../src/worker-http.js';
import { WorkerSigner, WorkerVerifier, workerRequest } from '../src/worker.js';
import { event, fixture, localDatabase, service, thread } from './helpers.js';

let database: Awaited<ReturnType<typeof localDatabase>>;
let f: Awaited<ReturnType<typeof fixture>>;
before(async () => { database = await localDatabase(); });
beforeEach(async () => {
  await database.pg.exec('TRUNCATE events,conversations,jobs,results,outbox,schedules,denied_actors,controls,audit,incidents RESTART IDENTITY CASCADE');
  f = await fixture(database.db);
});
after(async () => { await database.pg.close(); });
async function rows(table: string) { return (await database.db.query<Record<string, any>>(`SELECT * FROM ${table}`)).rows; }
async function enqueue(key: string, scope: Scope = thread) {
  await f.store.enqueue({ key, actor: f.policy.owner, scope, revision: f.policy.revision,
    payload: { kind: 'message', channel: scope.channel, content: key, classification: 'safe_summary' } });
}
// Fail inside a real transaction, including writes that preceded the injection.
async function failTransaction(match: (sql: string) => boolean, run: () => Promise<unknown>) {
  const transaction = database.db.transaction.bind(database.db); let fail = true;
  database.db.transaction = (fn, deadline) => transaction(tx => fn({ ...tx, query: async <T>(sql: string, params?: unknown[]) => {
    if (fail && match(sql)) { fail = false; throw new Error('injected_transaction_failure'); }
    return tx.query<T>(sql, params);
  } }), deadline);
  try { await assert.rejects(run(), /injected_transaction_failure/); } finally { database.db.transaction = transaction; }
  assert.equal(fail, false);
}

test('4314746162 마지막 history 응답 직후 live 입력은 영속 buffer에서 한 번 수락·문맥 순서 보존', async () => {
  await f.ingress.receive(event('100', { text: '시작' }));
  f.rest.history = async () => {
    await f.ingress.receive(event('102', { mention: false, text: 'live 후속' }));
    await f.ingress.receive(event('102', { mention: false, text: '변조' }));
    const live = (await rows('events')).find(e => e.delivery_id === '102')!;
    assert.equal(live.buffered, true); assert.equal(live.accepted, false);
    assert.equal(f.rest.acks.filter(a => a.event.id === '102').length, 1);
    return [event('101', { mention: false, text: 'history 선행' })];
  };
  await f.ingress.recover(thread, f.policy.owner);
  const live = (await rows('events')).find(e => e.delivery_id === '102')!;
  assert.equal(live.accepted, true); assert.equal(live.buffered, false);
  assert.equal((await f.store.conversation(thread))!.gap, false);
  assert.equal((await f.store.conversation(thread))!.checkpoint, '102');
  assert.deepEqual((await f.store.context(f.store.scopeId(thread), live.id)).map(x => (x as { text: string }).text), ['시작', 'history 선행', 'live 후속']);
  await f.ingress.receive(event('103', { mention: false }));
  assert.equal((await rows('events')).find(e => e.delivery_id === '103')!.accepted, true);
});
test('4314746162 복구 실패·재시작과 동시 recover에서도 buffered 요청 유실·중복 없음', async () => {
  await f.ingress.receive(event('100')); let calls = 0;
  f.rest.history = async () => {
    calls++; await f.ingress.receive(event('101', { mention: false }));
    await new DiscordIngress(f.store, f.gate, f.rest).recover(thread, f.policy.owner);
    throw new Error('history_lost');
  };
  await assert.rejects(f.ingress.recover(thread, f.policy.owner), /history_lost/);
  assert.equal(calls, 1); assert.equal((await f.store.conversation(thread))!.gap, true);
  f.rest.history = async () => [];
  await new DiscordIngress(f.store, f.gate, f.rest).recover(thread, f.policy.owner);
  assert.equal((await rows('events')).filter(e => e.delivery_id === '101' && e.accepted).length, 1);
  assert.equal((await f.store.conversation(thread))!.gap, false);
});
test('4314746162 복구 buffer 상한 뒤 요청은 ACK 없이 거부', async () => {
  await f.ingress.receive(event('100')); await database.db.query('UPDATE conversations SET gap=true');
  for (let i = 0; i < DEFAULTS.maxQueue; i++) await f.ingress.receive(event(String(101 + i), { mention: false }));
  await assert.rejects(f.ingress.receive(event('999', { mention: false })), /recovery_buffer_full/);
  assert.equal(f.rest.acks.length, DEFAULTS.maxQueue + 1);
});

test('4314746171 비전역 429는 재구성 뒤에도 동일 채널 backlog·ACK·history·대조를 중지', async () => {
  await f.ingress.receive(event('100'));
  await enqueue('a'); await enqueue('b');
  f.rest.rateLimit = new RateLimited(3000, false, 'fixture-bucket');
  await f.publisher.deliver();
  const publisher = new DiscordPublisher(f.store, f.gate, f.rest);
  assert.equal(await publisher.deliver(), false);
  assert.deepEqual((await rows('outbox')).map(o => o.attempt).sort(), [0, 1]);
  await f.ingress.receive(event('101')); assert.equal(f.rest.acks.length, 1);
  let history = 0; f.rest.history = async () => { history++; return []; };
  await assert.rejects(f.ingress.recover(thread, f.policy.owner), RateLimited); assert.equal(history, 0);
  await database.db.query("UPDATE outbox SET state='unknown' WHERE idempotency_key='a'");
  let searches = 0; f.rest.findDelivery = async () => { searches++; return undefined; };
  await publisher.reconcile(); assert.equal(searches, 0);
  await enqueue('other', { ...thread, channel: 'fixture-other' });
  assert.equal(await publisher.deliver(), true); assert.equal(f.rest.messages[0]!.channel, 'fixture-other');
  f.advance(3000); assert.equal(await publisher.deliver(), true); assert.equal(f.rest.messages.length, 2);
});
for (const path of ['ack', 'history']) test(`4314746171 ${path} 비전역 429도 같은 채널 게시에 전파`, async () => {
  await f.ingress.receive(event('100')); await enqueue('pending');
  if (path === 'ack') {
    f.rest.acknowledge = async () => { throw new RateLimited(2000); };
    await f.ingress.receive(event('101'));
  } else {
    f.rest.history = async () => { throw new RateLimited(2000); };
    await assert.rejects(f.ingress.recover(thread, f.policy.owner), RateLimited);
  }
  assert.equal(await f.publisher.deliver(), false); assert.equal((await rows('outbox'))[0]!.attempt, 0);
});

for (const scope of [thread, { kind: 'dm', channel: 'fixture-dm', guild: null, parent: null } as Scope]) {
  for (const kind of ['message', 'command', 'button'] as const) test(`4314746177/4314746204 owner 교체 뒤 ${scope.kind} ${kind}는 기존 대화에 진입 불가`, async () => {
    f.policy.dmEnabled = true;
    await f.ingress.receive(event('owner-a', { scope, text: '이전 owner 기록' }));
    f.policy.owner = 'fixture-next-owner'; f.policy.revision = 'fixture-v2';
    await assert.rejects(f.ingress.receive(event('owner-b', { actor: f.policy.owner, scope, kind,
      command: kind === 'message' ? undefined : 'list' })), Denied);
    assert.equal((await rows('events')).length, 1); assert.equal(f.rest.acks.length, 1);
    await assert.rejects(f.ingress.recover(scope, f.policy.owner), Denied);
    const fresh = { ...scope, channel: 'fixture-fresh' };
    await f.ingress.receive(event('fresh', { actor: f.policy.owner, scope: fresh }));
    f.advance(DEFAULTS.debounceMs + 50); await f.runtime.tick(); await f.runtime.tick();
    assert.equal(f.requests.length, 1);
    assert.ok(!JSON.stringify(f.requests).includes('이전 owner 기록'));
  });
}
test('4314746177 직접 저장·오염된 context·실행 claim·control outbox도 owner 격리', async () => {
  await f.ingress.receive(event('a', { text: 'owner A' }));
  const saved = (await rows('events'))[0]!;
  await assert.rejects(f.store.save(event('b', { actor: 'fixture-next-owner' }), f.policy.revision, true), Denied);
  await database.db.query('UPDATE events SET actor_id=$1', ['fixture-next-owner']);
  assert.deepEqual(await f.store.context(f.store.scopeId(thread), saved.id), []);
  f.advance(DEFAULTS.debounceMs + 50); assert.equal(await f.store.claim(), undefined);
  f.policy.owner = 'fixture-next-owner'; await enqueue('control-without-conversation');
  await f.publisher.deliver(); assert.equal((await rows('outbox'))[0]!.state, 'blocked'); assert.equal(f.rest.messages.length, 0);
});
test('4314746177 경보 groupKey도 owner별 새 세대로 격리', async () => {
  const ingress = new AlertIngress(f.store, f.gate);
  const alert = { groupKey: 'fixture-group', status: 'firing', alerts: [{ fingerprint: 'fixture-fp', labels: { service: service.id, severity: 'warning' } }] };
  await ingress.receive(alert); await f.publisher.deliver();
  const first = (await rows('incidents'))[0]!;
  f.policy.owner = 'fixture-next-owner'; f.policy.revision = 'fixture-v2';
  await ingress.receive(alert); await f.publisher.deliver(); await f.publisher.deliver();
  assert.equal((await rows('incidents')).length, 2);
  assert.equal(f.rest.threads.length, 2);
  assert.equal((await rows('conversations')).find(c => c.id === first.conversation_id)!.owner_id, 'fixture-owner');
});

for (const stage of ['authorization', 'pause']) test(`4314746184 ${stage} DB 실패는 REST 없이 pending backoff·다음 시도 성공`, async () => {
  await enqueue('known-unsent'); const query = database.db.query.bind(database.db); let fail = true;
  database.db.query = async (sql, params) => {
    if (fail && (stage === 'authorization' ? sql.startsWith('SELECT service_ids') : sql.startsWith("SELECT value FROM controls WHERE key='discord_global_after'"))) {
      fail = false; throw new Error('database_temporarily_down');
    }
    return query(sql, params);
  };
  try { await f.publisher.deliver(); } finally { database.db.query = query; }
  assert.equal(fail, false); const row = (await rows('outbox'))[0]!;
  assert.equal(row.state, 'pending'); assert.equal(row.attempt, 0); assert.ok(Number(row.available_at) > f.now());
  assert.equal(f.rest.messages.length, 0); assert.equal(await f.publisher.deliver(), false);
  f.advance(DEFAULTS.retryDelayMs); await f.publisher.deliver(); assert.equal(f.rest.messages.length, 1);
});
test('4314746184 응답 유실과 확정 DB 실패는 unknown 유지·대조 후 한 번만 전송', async () => {
  await enqueue('lost'); f.rest.loseResponse = true; await f.publisher.deliver();
  assert.equal((await rows('outbox'))[0]!.state, 'unknown'); assert.equal(f.rest.messages.length, 1);
  await f.publisher.reconcile(); assert.equal((await rows('outbox'))[0]!.state, 'sent');
  await enqueue('confirmation');
  const transaction = database.db.transaction.bind(database.db); let fail = true;
  database.db.transaction = (fn, deadline) => transaction(tx => fn({ ...tx, query: async <T>(sql: string, params?: unknown[]) => {
    if (fail && sql.startsWith('SELECT state,service_ids FROM outbox')) { fail = false; throw new Error('confirm_failed'); }
    return tx.query<T>(sql, params);
  } }), deadline);
  try { await f.publisher.deliver(); } finally { database.db.transaction = transaction; }
  const row = (await rows('outbox')).find(o => o.idempotency_key === 'confirmation')!;
  assert.equal(row.state, 'unknown'); assert.ok(row.external_id); assert.equal(f.rest.messages.length, 2);
  await f.publisher.reconcile(); assert.equal((await rows('outbox')).find(o => o.id === row.id)!.state, 'sent');
  assert.equal(f.rest.messages.length, 2);
});
for (const dispatched of [false, true]) test(`R6-AUDIT outbox crash dispatch_started=${dispatched} lease 만료 분류·늦은 작업 차단`, async () => {
  await enqueue('lease'); const row = (await f.store.claimDelivery())!;
  if (dispatched) assert.equal(await f.store.dispatchDelivery(row), true);
  f.advance(DEFAULTS.leaseMs + 1); await f.store.expire();
  const current = (await rows('outbox'))[0]!;
  assert.equal(current.state, dispatched ? 'unknown' : 'pending');
  assert.equal(current.attempt, dispatched ? 1 : 0);
  assert.equal(await f.store.dispatchDelivery(row), false);
});
test('R6-AUDIT 대조 확정 뒤 늦은 REST 오류는 sent를 덮어쓰지 않음', async () => {
  await enqueue('fenced'); const row = (await f.store.claimDelivery())!;
  await database.db.query("UPDATE outbox SET state='sent',external_id='fixture-delivered'");
  await f.store.deliveryState(row, 'unknown'); assert.equal((await rows('outbox'))[0]!.state, 'sent');
});

for (const initial of [true, false]) test(`4314746194 ${initial ? '첫 활성화' : '재활성화'} 수락 rollback 시 구독·epoch·커서 보존`, async () => {
  if (!initial) {
    await f.ingress.receive(event('100'));
    await f.store.control(f.policy.owner, f.store.scopeId(thread), 'stop');
  }
  const prior = await f.store.conversation(thread); const acks = f.rest.acks.length;
  await failTransaction(sql => sql === 'UPDATE events SET accepted=true WHERE id=$1', () => f.ingress.receive(event('200')));
  const current = (await f.store.conversation(thread))!;
  assert.equal(current.active, false); assert.equal(current.subscription_epoch, prior?.subscription_epoch ?? 0);
  assert.equal(current.checkpoint, prior?.checkpoint ?? null); assert.equal(f.rest.acks.length, acks);
  assert.equal((await rows('events')).find(e => e.delivery_id === '200')!.accepted, false);
  await f.ingress.receive(event('201', { mention: false }));
  assert.ok(!(await rows('events')).some(e => e.delivery_id === '201'));
  await f.ingress.receive(event('200')); assert.equal((await f.store.conversation(thread))!.active, true);
});
test('4314746194 resume 제어 outbox 실패도 활성화와 함께 rollback', async () => {
  await f.ingress.receive(event('100')); await f.store.control(f.policy.owner, f.store.scopeId(thread), 'stop');
  await failTransaction(sql => sql.includes('INSERT INTO outbox'), () => f.ingress.receive(event('200', { kind: 'command', command: 'resume' })));
  assert.equal((await f.store.conversation(thread))!.active, false);
  assert.equal((await rows('outbox')).length, 0);
});

for (const resume of ['resume', 'mention']) test(`4314746217 ${resume} 이후 stop 기간 입력은 복구해도 실행하지 않음`, async () => {
  await f.ingress.receive(event('100'));
  await f.ingress.receive(event('150', { kind: 'command', command: 'stop' }));
  await f.ingress.receive(event('160', { mention: false, text: '수집 금지' }));
  await f.ingress.receive(event('200', resume === 'resume' ? { kind: 'command', command: 'resume' } : {}));
  assert.equal((await f.store.conversation(thread))!.activation_after, '200');
  const history = [event('160', { mention: false, text: '수집 금지' }), event('201', { mention: false, text: '새 구독' })];
  const cursors: (string | null)[] = [];
  f.rest.history = async (_channel?: string, after?: string | null) => { cursors.push(after ?? null); return history.filter(e => BigInt(e.id) > BigInt(after ?? '0')); };
  await f.ingress.recover(thread, f.policy.owner);
  await f.ingress.receive(event('160', { mention: false, text: '지연 live' }));
  assert.deepEqual(cursors, ['200']);
  const jobs = (await database.db.query<{ delivery_id: string }>('SELECT e.delivery_id FROM jobs j JOIN events e ON e.id=j.event_id')).rows;
  assert.ok(!jobs.some(j => j.delivery_id === '160')); assert.ok(jobs.some(j => j.delivery_id === '201'));
  assert.equal((await rows('events')).find(e => e.delivery_id === '160')!.accepted, false);
});
test('4314746217 history 중 stop/resume한 이전 복구는 새 epoch에 쓰지 않음', async () => {
  await f.ingress.receive(event('100'));
  f.rest.history = async () => {
    await f.ingress.receive(event('200', { kind: 'command', command: 'stop' }));
    await f.ingress.receive(event('300', { kind: 'command', command: 'resume' }));
    return [event('150', { mention: false, text: '옛 복구' })];
  };
  await f.ingress.recover(thread, f.policy.owner);
  assert.equal((await f.store.conversation(thread))!.checkpoint, '300');
  assert.ok(!(await rows('events')).some(e => e.delivery_id === '150'));
});
test('4314746217 recover 검증 뒤 save 사이 stop해도 recovered mention이 재활성화하지 않음', async () => {
  await f.ingress.receive(event('100')); f.rest.pages = [[event('150')]];
  const save = f.store.save.bind(f.store); let stopped = false;
  f.store.save = async (...args) => {
    if (args[0].id === '150' && !stopped) { stopped = true; await f.store.control(f.policy.owner, f.store.scopeId(thread), 'stop'); }
    return save(...args);
  };
  await f.ingress.recover(thread, f.policy.owner);
  assert.equal(stopped, true); assert.equal((await f.store.conversation(thread))!.active, false);
  assert.equal((await rows('jobs')).length, 1);
});

test('4314746229 일반 chat 교체에도 urgent 우선순위·즉시 실행 가능성 보존', async () => {
  await f.ingress.receive(event('urgent', { kind: 'command', command: 'urgent' }));
  await f.ingress.receive(event('normal-1', { mention: false }));
  await f.ingress.receive(event('normal-2', { mention: false }));
  const jobs = await rows('jobs');
  assert.equal(jobs.find(j => j.priority === 0)!.state, 'queued');
  assert.equal(jobs.filter(j => j.priority === 10 && j.state === 'queued').length, 1);
  const claimed = (await f.store.claim())!; assert.equal(claimed.id, jobs.find(j => j.priority === 0)!.id); assert.equal(Number(jobs.find(j => j.priority === 0)!.available_at), f.now());
});
for (const operation of ['execute', 'cancel'] as const) test(`4314746240 ${operation} 발급 미래 1000ms 허용·1001ms 거부, 만료·TTL·nonce 엄격 유지`, async () => {
  await f.ingress.receive(event('100')); f.advance(DEFAULTS.debounceMs + 50); const job = (await f.store.claim())!;
  const body = { job: job.id, lease: job.lease_token };
  const verifier = (offset: number) => new WorkerVerifier(f.keys.publicKey, async () => true, () => f.now() + offset);
  const token = f.signer.issue(job, operation, body);
  await verifier(-DEFAULTS.capabilitySkewMs).check(token, operation, body);
  await assert.rejects(verifier(-DEFAULTS.capabilitySkewMs - 1).check(token, operation, body), Denied);
  await assert.rejects(verifier(30_000).check(token, operation, body), Denied);
  const parsed = JSON.parse(Buffer.from(token.split('.')[0]!, 'base64url').toString()) as { expires: number };
  parsed.expires++; const payload = Buffer.from(JSON.stringify(parsed)).toString('base64url');
  const oversized = `${payload}.${sign(null, Buffer.from(payload), f.keys.privateKey).toString('base64url')}`;
  await assert.rejects(verifier(0).check(oversized, operation, body), Denied);
  await f.verifier.check(token, operation, body); await assert.rejects(f.verifier.check(token, operation, body), Denied);
  const future = new WorkerSigner(f.keys.privateKey, () => f.now() + 500).issue(job, operation, body);
  await verifier(0).check(future, operation, body);
});

for (const boundary of ['cancel', 'stop', 'gap', 'owner']) test(`R6-AUDIT context 읽은 뒤 ${boundary} 변경은 모델 호출 전 재확인`, async () => {
  await f.ingress.receive(event('100')); f.advance(DEFAULTS.debounceMs + 50);
  const context = f.store.context.bind(f.store);
  f.store.context = async (...args) => {
    const result = await context(...args);
    if (boundary === 'cancel') await f.store.control(f.policy.owner, f.store.scopeId(thread), 'cancel', (await rows('jobs'))[0]!.id);
    else if (boundary === 'stop') await f.store.control(f.policy.owner, f.store.scopeId(thread), 'stop');
    else if (boundary === 'gap') await database.db.query('UPDATE conversations SET gap=true');
    else { f.policy.owner = 'fixture-next-owner'; f.policy.revision = 'fixture-v2'; }
    return result;
  };
  await f.runtime.tick(); assert.equal(f.requests.length, 0);
  assert.equal((await rows('jobs'))[0]!.state, boundary === 'gap' ? 'queued' : boundary === 'stop' ? 'superseded' : 'cancelled');
});
test('R6-AUDIT 직접 emergency-stop 두 번째 쓰기 실패는 scheduler도 rollback', async () => {
  await f.ingress.receive(event('100')); f.advance(DEFAULTS.debounceMs + 50); await f.store.claim();
  await failTransaction(sql => sql.includes("UPDATE jobs SET state='cancel_requested' WHERE state IN ('running','verifying')"),
    () => f.store.control(f.policy.owner, f.store.scopeId(thread), 'emergency-stop'));
  assert.equal((await rows('controls')).find(c => c.key === 'scheduler')!.value, false);
  assert.equal((await rows('jobs'))[0]!.state, 'running');
});
test('R6-AUDIT thread 생성 중 owner 교체는 후속 대화·job 없이 unknown, 재전송 없음', async () => {
  await f.ingress.receive(event('parent', { scope: { kind: 'channel', parent: null, guild: f.policy.guild, channel: f.policy.conversationChannel } }));
  const create = f.rest.createThread.bind(f.rest);
  f.rest.createThread = async (...args) => { const result = await create(...args); f.policy.owner = 'fixture-next-owner'; f.policy.revision = 'fixture-v2'; return result; };
  await f.publisher.deliver(); assert.equal(f.rest.threads.length, 1); assert.equal((await rows('outbox'))[0]!.state, 'unknown');
  assert.equal((await rows('jobs')).length, 0); assert.equal((await rows('conversations')).length, 1);
  await f.publisher.reconcile(); assert.equal((await rows('outbox'))[0]!.state, 'blocked'); assert.equal(f.rest.threads.length, 1);
});
test('R6-AUDIT HttpWorker transport 구성 실패는 미시작, 정리 실패는 확인된 결과 보존', async () => {
  await f.ingress.receive(event('100')); f.advance(DEFAULTS.debounceMs + 50); const job = (await f.store.claim())!;
  const request = workerRequest(job, []); let calls = 0;
  const send: typeof fetch = async () => { calls++; return Response.json({ status: 'failed', stopped: true }); };
  const broken = new HttpWorker('http://fixture-worker', send, () => { throw new Error('setup_failed'); });
  await assert.rejects(broken.execute(request, '', new AbortController().signal), WorkerRejected); assert.equal(calls, 0);
  const dispatcher = { destroy: async () => { throw new Error('cleanup_failed'); } } as unknown as Agent;
  const worker = new HttpWorker('http://fixture-worker', send, () => dispatcher);
  assert.deepEqual(await worker.execute(request, '', new AbortController().signal), { status: 'failed', stopped: true }); assert.equal(calls, 1);
});
test('R6-AUDIT 중첩 heartbeat는 ping 하나만, 실패 후 재시도 가능', async () => {
  let release!: () => void; let calls = 0;
  const health = new Health(f.store, async () => { calls++; await new Promise<void>(resolve => { release = resolve; }); });
  health.gateway(true); health.loop(); const first = health.heartbeat();
  assert.equal(await health.heartbeat(), false); assert.equal(calls, 1); release(); assert.equal(await first, true);
  assert.equal(await health.heartbeat(), false);
  let attempts = 0; const retry = new Health(f.store, async () => { if (!attempts++) throw new Error('ping_failed'); });
  retry.gateway(true); retry.loop(); await assert.rejects(retry.heartbeat(), /ping_failed/); assert.equal(await retry.heartbeat(), true);
});
test('R6-AUDIT migration 007은 기존 sending을 보수적으로 이관하고 반복 시 새 미전송 claim 보존', async () => {
  await enqueue('legacy'); await f.store.claimDelivery();
  await database.db.query('DELETE FROM schema_migrations WHERE version=7');
  const migration = await readFile('migrations/007_execution_boundaries.sql', 'utf8'); await database.pg.exec(migration);
  assert.equal((await rows('outbox'))[0]!.dispatch_started, true);
  await database.db.query("UPDATE outbox SET state='sent'");
  await enqueue('new'); await f.store.claimDelivery(); await database.pg.exec(migration);
  assert.equal((await rows('outbox')).find(o => o.idempotency_key === 'new')!.dispatch_started, false);
});

for (const failure of ['queue_full', 'inbox_deadline']) test(`4314746194 ${failure}도 재활성화 부분 커밋 없음`, async () => {
  await f.ingress.receive(event('100')); await f.store.control(f.policy.owner, f.store.scopeId(thread), 'stop');
  if (failure === 'queue_full') {
    for (let i = 0; i < MODEL_QUEUE_LIMIT - 1; i++) {
      const saved = await f.store.save(event(`queued-${i}`, { kind: 'command', command: 'task' }), f.policy.revision, false);
      await f.store.accept(saved.id, 'task', f.policy.revision);
    }
  }
  const transaction = database.db.transaction.bind(database.db); let delayed = false;
  if (failure === 'inbox_deadline') database.db.transaction = (fn, deadline) => transaction(tx => fn({ ...tx, query: async <T>(sql: string, params?: unknown[]) => {
    const result = await tx.query<T>(sql, params);
    if (!delayed && sql.startsWith('UPDATE conversations SET active=true')) { delayed = true; f.advance(DEFAULTS.inboxTimeoutMs + 1); }
    return result;
  } }), deadline);
  try { await assert.rejects(f.ingress.receive(event('200')), new RegExp(failure)); } finally { database.db.transaction = transaction; }
  assert.equal((await f.store.conversation(thread))!.active, false);
  assert.equal((await f.store.conversation(thread))!.checkpoint, '100');
  assert.equal((await rows('events')).find(e => e.delivery_id === '200')!.accepted, false);
  assert.equal(f.rest.acks.length, 1);
});
test('R6-AUDIT 결과 저장 직전 stop은 완료 결과·게시를 함께 억제', async () => {
  await f.ingress.receive(event('100')); f.advance(DEFAULTS.debounceMs + 50);
  const finish = f.store.finish.bind(f.store);
  f.store.finish = async (...args) => { await f.store.control(f.policy.owner, f.store.scopeId(thread), 'stop'); return finish(...args); };
  await f.runtime.tick(); assert.equal(f.requests.length, 1);
  assert.equal((await rows('jobs'))[0]!.state, 'superseded');
  assert.equal((await rows('results')).length, 0); assert.equal((await rows('outbox')).length, 0);
});
for (const change of ['owner', 'service']) test(`R6-AUDIT 경보 admission 잠금 대기 중 ${change} 변경은 쓰기 전에 재인가`, async () => {
  const transaction = database.db.transaction.bind(database.db); let changed = false;
  database.db.transaction = (fn, deadline) => transaction(tx => fn({ ...tx, query: async <T>(sql: string, params?: unknown[]) => {
    const result = await tx.query<T>(sql, params);
    if (sql.includes("key='alert_admission' FOR UPDATE")) {
      changed = true;
      if (change === 'owner') f.policy.owner = 'fixture-next-owner'; else f.policy.services = [];
    }
    return result;
  } }), deadline);
  try {
    await assert.rejects(new AlertIngress(f.store, f.gate).receive({ groupKey: 'fixture-group', status: 'firing',
      alerts: [{ fingerprint: 'fixture-fp', labels: { service: service.id, severity: 'warning' } }] }), Denied);
  } finally { database.db.transaction = transaction; }
  assert.equal(changed, true); assert.equal((await rows('incidents')).length, 0);
  assert.equal((await rows('events')).length, 0); assert.equal((await rows('outbox')).length, 0);
});
test('4314746171 HTTP 429의 bucket ID·retry_after는 상위 공유 대기 경로에 보존', async () => {
  const api = discordHttpApi('fixture-token', async () => Response.json({ retry_after: 0.125, global: false },
    { status: 429, headers: { 'X-RateLimit-Bucket': 'fixture-bucket' } }));
  await assert.rejects(api.request('POST', '/channels/fixture/messages'), (error: unknown) => {
    assert.ok(error instanceof RateLimited); assert.equal(error.retryAfterMs, 125);
    assert.equal(error.global, false); assert.equal(error.bucket, 'fixture-bucket'); return true;
  });
});

test('R6-AUDIT history 응답 중 복구 lease가 만료되면 stale 응답은 수락하지 않음', async () => {
  await f.ingress.receive(event('100'));
  f.rest.history = async () => { f.advance(DEFAULTS.recoveryMs); return [event('101', { mention: false })]; };
  await f.ingress.recover(thread, f.policy.owner);
  const conversation = (await f.store.conversation(thread))!;
  assert.equal(conversation.gap, true); assert.equal(conversation.checkpoint, '100'); assert.equal(conversation.recovery_token, null);
  assert.equal((await rows('events')).length, 1);
  f.rest.history = async () => [event('101', { mention: false })];
  await f.ingress.recover(thread, f.policy.owner); assert.equal((await f.store.conversation(thread))!.gap, false);
  assert.equal((await rows('events')).length, 2);
});
