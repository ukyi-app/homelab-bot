import { after, before, beforeEach, test } from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULTS, Denied, DiscordRejected, RateLimited } from '../src/contracts.js';
import { DiscordIngress, DiscordPublisher } from '../src/discord.js';
import { DiscordProtocol, discordHttpApi } from '../src/discord-protocol.js';
import { Runtime } from '../src/runtime.js';
import { MODEL_QUEUE_LIMIT, Store } from '../src/store.js';
import { event, fixture, localDatabase, thread } from './helpers.js';

let database: Awaited<ReturnType<typeof localDatabase>>;
let f: Awaited<ReturnType<typeof fixture>>;
before(async () => { database = await localDatabase(); });
beforeEach(async () => {
  await database.pg.exec('TRUNCATE events,conversations,jobs,results,outbox,schedules,denied_actors,controls,audit,incidents RESTART IDENTITY CASCADE');
  f = await fixture(database.db);
});
after(async () => { await database.pg.close(); });
async function rows(table: string) { return (await database.db.query<Record<string, any>>(`SELECT * FROM ${table}`)).rows; }
async function enqueue(key = 'fixture-delivery') {
  await f.store.enqueue({ key, actor: f.policy.owner, scope: thread, revision: f.policy.revision,
    payload: { kind: 'message', channel: thread.channel, content: '확인된 요약', classification: 'safe_summary' } });
}
const parent = { ...thread, kind: 'channel' as const, channel: thread.parent!, parent: null };
async function paused(reason: 'limited' | 'auth_expired' = 'limited') {
  await f.ingress.receive(event('start')); f.advance(DEFAULTS.debounceMs);
  f.setRun(async () => ({ status: reason, stopped: true })); await f.runtime.tick();
  return (await rows('jobs'))[0]!;
}
async function control(command: string, target?: string, id = `${command}-${target ?? 'none'}`) {
  await f.ingress.receive(event(id, { kind: 'command', command, target }));
  const input = (await rows('events')).find(e => e.delivery_id === id)!;
  return JSON.parse((await rows('outbox')).find(o => o.idempotency_key === `control:${input.id}`)!.payload.content);
}
async function flag(key = 'scheduler') { return (await rows('controls')).find(c => c.key === key)!.value; }
async function failOnce(match: (sql: string) => boolean, run: () => Promise<unknown>) {
  const transaction = database.db.transaction.bind(database.db); let injected = false;
  database.db.transaction = (fn, deadline) => transaction(tx => fn({ ...tx, query: async <T>(sql: string, params?: unknown[]) => {
    if (!injected && match(sql)) { injected = true; throw new Error('injected_commit_failure'); }
    return tx.query<T>(sql, params);
  } }), deadline);
  try { await run(); } finally { database.db.transaction = transaction; }
  assert.equal(injected, true);
}
for (const type of [2, 3]) for (const elapsed of [2499, 2500, 2600]) test(`4316099207 type=${type} 수신 후 ${elapsed}ms는 metadata·저장 시간을 합산해 callback 결정`, async () => {
  if (type === 3) await f.ingress.receive(event('seed'));
  const received = f.now(); let callbacks = 0; let expires = 0;
  const protocol = new DiscordProtocol({ request: async (method, path, _body, options) => {
    if (method === 'GET') { f.advance(1200); return { id: thread.channel, type: 11, parent_id: thread.parent, guild_id: thread.guild }; }
    if (path.endsWith('/callback')) { callbacks++; expires = options!.expiresAt; return; }
    throw new Error('unexpected');
  } }, 'fixture-bot', f.now);
  const save = f.store.save.bind(f.store);
  f.store.save = async (...args) => { const result = await save(...args); f.advance(elapsed - 1200); return result; };
  await protocol.gateway('INTERACTION_CREATE', { id: 'fixture-interaction', token: 'fixture-ephemeral-token', type,
    channel_id: thread.channel, guild_id: thread.guild, member: { user: { id: f.policy.owner } }, data: type === 2 ? { name: 'chat' } : { custom_id: 'list' } },
  new DiscordIngress(f.store, f.gate, protocol));
  assert.equal(callbacks, elapsed < 2500 ? 1 : 0);
  if (callbacks) assert.equal(expires, received + 2500);
  assert.equal((await rows('events')).find(e => e.delivery_id === 'fixture-interaction')!.accepted, true); assert.equal((await rows('jobs')).length, 1);
  assert.equal((await rows('outbox')).filter(o => o.idempotency_key.startsWith('ack-notice:')).length, callbacks ? 0 : 1);
  assert.ok(!JSON.stringify(await rows('events')).includes('fixture-ephemeral-token'));
});
test('4316099207 HTTP callback도 절대 마감의 남은 시간만 사용하고 만료 후 호출하지 않음', async t => {
  const timeouts: number[] = []; let calls = 0;
  t.mock.method(AbortSignal, 'timeout', (ms: number) => { timeouts.push(ms); return new AbortController().signal; });
  const api = discordHttpApi('fixture-token', async () => { calls++; return new Response(null, { status: 204 }); }, f.now);
  const expiresAt = f.now() + 300;
  await api.request('POST', '/interactions/fixture/token/callback', {}, { expiresAt });
  assert.deepEqual(timeouts, [300]); f.advance(300);
  await assert.rejects(api.request('POST', '/interactions/fixture/token/callback', {}, { expiresAt }), /interaction_expired/);
  assert.equal(calls, 1);
});

for (const reason of ['limited', 'auth_expired'] as const) for (const action of ['resume-model', 'cancel']) {
  test(`4316099215 ${reason} 뒤 owner ${action}은 재구성 후에도 대기·scheduler를 함께 해제`, async () => {
    const job = await paused(reason);
    const status = await control('model-status'); assert.equal(status.paused, true); assert.equal(status.emergency, false);
    assert.deepEqual(status.waiting, [{ id: job.id, wait_reason: reason === 'limited' ? 'model_limit' : 'auth_expired' }]);
    const store = new Store(database.db, f.now);
    const ingress = new DiscordIngress(store, f.gate, f.rest);
    await ingress.receive(event('owner-action', { kind: 'command', command: action, target: job.id }));
    const current = (await rows('jobs'))[0]!;
    assert.equal(current.state, action === 'cancel' ? 'cancelled' : 'queued'); assert.equal(await flag(), false);
    f.setRun(async () => ({ status: 'succeeded', stopped: true, answer: { facts: [], hypotheses: [], unknowns: [], checks: [] } }));
    if (action === 'cancel') await ingress.receive(event('next', { kind: 'command', command: 'task' }));
    await new Runtime(store, f.gate, f.worker, f.signer, f.reader).tick();
    assert.equal(f.requests.length, 2); assert.equal((await rows('jobs')).filter(j => j.state === 'succeeded').length, 1);
  });
}
test('4316099215 다른 actor·대화·잘못된 원인·unknown은 resume으로 우회 불가', async () => {
  const job = await paused();
  await assert.rejects(f.ingress.receive(event('intruder', { actor: 'intruder', kind: 'command', command: 'resume-model', target: job.id })), Denied);
  await f.ingress.receive(event('other', { scope: { ...thread, channel: 'fixture-other' }, kind: 'command', command: 'resume-model', target: job.id }));
  assert.equal((await rows('jobs'))[0]!.state, 'waiting_user'); assert.equal(await flag(), true);
  await database.db.query("UPDATE jobs SET wait_reason='unrecognized'"); assert.equal((await control('resume-model', job.id)).ok, false);
  await database.db.query("UPDATE jobs SET state='unknown'");
  assert.equal((await control('resume-model', 'emergency-stop')).ok, false); assert.equal((await control('cancel', job.id)).ok, false);
  assert.equal(await flag(), true); assert.equal((await rows('jobs'))[0]!.state, 'unknown');
});
test('4316099215 resume 대상 누락·재시도 상한·큐 상한은 차단하고 cancel은 가능', async () => {
  const job = await paused();
  await assert.rejects(f.ingress.receive(event('missing', { kind: 'command', command: 'resume-model' })), Denied);
  await database.db.query('UPDATE jobs SET attempt=$1', [DEFAULTS.maxRetries + 1]);
  assert.equal((await control('resume-model', job.id, 'exhausted')).ok, false);
  await database.db.query('UPDATE jobs SET attempt=1');
  for (let i = 0; i < MODEL_QUEUE_LIMIT; i++) {
    const saved = await f.store.save(event(`queue-${i}`, { kind: 'command', command: 'task' }), f.policy.revision, false);
    await f.store.accept(saved.id, 'task', f.policy.revision);
  }
  assert.equal((await control('resume-model', job.id, 'full')).ok, false); assert.equal(await flag(), true);
  await control('cancel', job.id); assert.equal(await flag(), false);
});
for (const stage of ['scheduler', 'outbox']) test(`4316099215 재개 중 ${stage} 쓰기 실패는 job과 scheduler 모두 rollback`, async () => {
  const job = await paused();
  await failOnce(sql => stage === 'scheduler' ? sql.startsWith("UPDATE controls SET value='false' WHERE key='scheduler'") : sql.includes('INSERT INTO outbox'),
    () => assert.rejects(control('resume-model', job.id), /injected_commit_failure/));
  assert.equal((await rows('jobs'))[0]!.state, 'waiting_user'); assert.equal(await flag(), true);
  // impl-sched S4: waiting_user 안내는 대기 진입 때 이미 들어가 있다. 재개 실패가 남긴 것만 센다.
  assert.equal((await rows('outbox')).filter(o => !/^(waiting|unknown):/.test(o.idempotency_key)).length, 0);
  assert.equal((await control('resume-model', job.id)).ok, true); assert.equal(await flag(), false);
});
test('4316099215 동시 재개 요청은 하나만 재수락, 나머지는 상태 불일치', async () => {
  const job = await paused();
  const results = await Promise.all(['resume-a', 'resume-b'].map(id => control('resume-model', job.id, id)));
  assert.equal(results.filter(r => r.ok === true).length, 1);
  assert.equal((await rows('jobs')).length, 1); assert.equal((await rows('jobs'))[0]!.attempt, 1); assert.equal(await flag(), false);
});
test('R8-AUDIT emergency-stop은 waiting 취소로 해제되지 않고 명시 확인 뒤 해제', async () => {
  const job = await paused(); await control('emergency-stop');
  assert.equal((await control('resume-model', job.id)).ok, false);
  await control('cancel', job.id); assert.equal(await flag(), true); assert.equal(await flag('scheduler_emergency'), true);
  assert.equal((await control('resume-model', 'emergency-stop')).ok, true); assert.equal(await flag(), false);
});
test('R8-AUDIT 이전 버전의 원인 없는 scheduler 중지는 명시 확인과 waiting 처리를 모두 요구', async () => {
  const job = await paused(); await database.db.query("DELETE FROM controls WHERE key='scheduler_emergency'");
  assert.equal((await control('model-status')).emergency, true);
  assert.equal((await control('resume-model', job.id, 'legacy-denied')).ok, false);
  const released = await control('resume-model', 'emergency-stop'); assert.equal(released.ok, true); assert.equal(released.paused, true);
  assert.equal((await control('resume-model', job.id, 'legacy-resume')).ok, true); assert.equal(await flag(), false);
});
test('R8-AUDIT 비상 재개는 실행/종료 불명 작업을 해제하지 않고 사용자 취소로 위장하지 않음', async () => {
  await f.ingress.receive(event('start')); f.advance(DEFAULTS.debounceMs); const job = (await f.store.claim())!;
  await control('emergency-stop'); assert.equal((await rows('jobs'))[0]!.state, 'cancel_requested');
  assert.equal((await control('resume-model', 'emergency-stop', 'not-stopped')).ok, false);
  await f.store.transition(job, 'unknown'); assert.equal((await control('resume-model', 'emergency-stop', 'uncertain')).ok, false);
  assert.equal(await flag(), true); assert.equal((await control('model-status')).executionPending, true);
});

for (const status of [400, 403, 404] as const) for (const kind of ['message', 'thread']) {
  test(`4316099220 ${kind} 확정 ${status} 거부는 unknown·대조 없이 blocked`, async () => {
    if (kind === 'thread') await f.ingress.receive(event('parent', { scope: parent })); else await enqueue();
    let calls = 0;
    const protocol = new DiscordProtocol(discordHttpApi('fixture-token', async () => { calls++; return new Response('rejected', { status }); }), 'fixture-bot', f.now);
    const publisher = new DiscordPublisher(f.store, f.gate, protocol);
    await publisher.deliver(); assert.equal((await rows('outbox'))[0]!.state, 'blocked'); assert.equal(calls, 1);
    await publisher.reconcile(); assert.equal(await publisher.deliver(), false); assert.equal(calls, 1);
    assert.equal((await rows('audit')).find(a => a.kind === 'discord_delivery_rejected')!.detail.status, status);
    assert.equal((await rows('jobs')).length, 0);
  });
}
for (const status of [408, 409, 500, 502]) test(`4316099220 ${status}는 부작용 부재를 단정하지 않고 unknown`, async () => {
  await enqueue();
  const publisher = new DiscordPublisher(f.store, f.gate, new DiscordProtocol(
    discordHttpApi('fixture-token', async () => new Response('uncertain', { status })), 'fixture-bot', f.now));
  await publisher.deliver(); assert.equal((await rows('outbox'))[0]!.state, 'unknown');
});
test('R8-AUDIT 대조 GET의 404는 이전 POST 미전송 증거로 사용하지 않음', async () => {
  await enqueue(); f.rest.loseResponse = true; await f.publisher.deliver();
  f.rest.findDelivery = async () => { throw new DiscordRejected(404); };
  await f.publisher.reconcile(); assert.equal((await rows('outbox'))[0]!.state, 'unknown'); assert.equal(f.rest.messages.length, 1);
});

for (const kind of ['message', 'thread']) test(`4316099228 ${kind} confirm 실패 뒤 저장 ID로 검색 없이 재확정`, async () => {
  if (kind === 'thread') await f.ingress.receive(event('parent', { scope: parent })); else await enqueue();
  await failOnce(sql => sql.startsWith('SELECT state,service_ids FROM outbox'), () => f.publisher.deliver());
  const pending = (await rows('outbox'))[0]!; assert.equal(pending.state, 'unknown'); assert.ok(pending.external_id);
  f.rest.findDelivery = async () => { throw new Error('bounded_search_must_not_run'); };
  await f.store.recordRateLimit(new RateLimited(5000, true));
  await database.db.query("INSERT INTO controls VALUES ('discord_reconcile_after',to_jsonb($1::bigint))", [f.now() + 5000]);
  await new DiscordPublisher(new Store(database.db, f.now), f.gate, f.rest).reconcile();
  assert.equal((await rows('outbox')).find(o => o.id === pending.id)!.state, 'sent');
  assert.equal(f.rest.messages.length + f.rest.threads.length, 1);
  assert.equal((await rows('jobs')).length, kind === 'thread' ? 1 : 0);
});
test('4316099228 확정 ID는 24시간 unknown 폐기 대상에서 제외하고 현재 인가 뒤 확정', async () => {
  await enqueue(); await failOnce(sql => sql.startsWith('SELECT state,service_ids FROM outbox'), () => f.publisher.deliver());
  f.advance(DEFAULTS.unknownDeliveryMs + 1); f.policy.confirmedAt = f.now();
  f.rest.findDelivery = async () => { throw new Error('must_not_search'); };
  await f.publisher.reconcile(); assert.equal((await rows('outbox'))[0]!.state, 'sent');
  assert.equal(f.rest.messages.length, 1);
});
test('4316099228 저장 ID가 있어도 철회된 owner는 로컬 후속 효과를 확정하지 않음', async () => {
  await f.ingress.receive(event('parent', { scope: parent }));
  await failOnce(sql => sql.startsWith('SELECT state,service_ids FROM outbox'), () => f.publisher.deliver());
  f.policy.owner = 'fixture-other-owner';
  f.rest.findDelivery = async () => { throw new Error('must_not_search'); };
  await f.publisher.reconcile(); assert.equal((await rows('outbox'))[0]!.state, 'blocked');
  assert.equal((await rows('jobs')).length, 0); assert.equal((await rows('conversations')).length, 1);
});
test('R8-AUDIT 늦은 unknown 갱신·반복 confirm 실패도 이미 저장된 ID를 지우지 않음', async () => {
  await enqueue(); await failOnce(sql => sql.startsWith('SELECT state,service_ids FROM outbox'), () => f.publisher.deliver());
  const row = (await rows('outbox'))[0]!;
  await f.store.deliveryState(row as Parameters<Store['deliveryState']>[0], 'unknown');
  assert.equal((await rows('outbox'))[0]!.external_id, row.external_id);
  await failOnce(sql => sql.startsWith('SELECT state,service_ids FROM outbox'), () => f.publisher.reconcile());
  assert.equal((await rows('outbox'))[0]!.external_id, row.external_id); assert.equal((await rows('outbox'))[0]!.state, 'unknown');
  await f.publisher.reconcile(); assert.equal((await rows('outbox'))[0]!.state, 'unknown');
  f.advance(DEFAULTS.retryDelayMs);
  f.rest.findDelivery = async () => { throw new Error('must_not_search'); };
  await f.publisher.reconcile(); assert.equal((await rows('outbox'))[0]!.state, 'sent'); assert.equal(f.rest.messages.length, 1);
});

for (const action of ['cancel', 'resume-model']) test(`R8-AUDIT ${action} 제어 응답 저장 실패는 해제까지 rollback`, async () => {
  const job = await paused();
  if (action === 'resume-model') await control('emergency-stop');
  const target = action === 'cancel' ? job.id : 'emergency-stop';
  await failOnce(sql => sql.includes('INSERT INTO outbox'), () => assert.rejects(control(action, target, 'rollback'), /injected_commit_failure/));
  assert.equal((await rows('jobs'))[0]!.state, 'waiting_user'); assert.equal(await flag(), true);
  if (action === 'resume-model') assert.equal(await flag('scheduler_emergency'), true);
});
test('R8-AUDIT waiting 재개는 이전 실행 lease의 완료를 거부하고 새 lease로 실행', async () => {
  const job = await paused(); await control('resume-model', job.id);
  await assert.rejects(f.store.finish(job as Parameters<Store['finish']>[0], {}, {}, '늦은 결과', thread), /stale_result/);
  assert.equal((await rows('results')).length, 0);
  const claimed = (await f.store.claim())!;
  assert.notEqual(claimed.lease_token, job.lease_token); assert.equal(claimed.attempt, job.attempt + 1);
});
for (const action of ['cancel', 'emergency-stop']) test(`R8-AUDIT verifying도 ${action}으로 종료 요청하고 확인 뒤만 재개`, async () => {
  await f.ingress.receive(event('start')); f.advance(DEFAULTS.debounceMs); const job = (await f.store.claim())!;
  await f.store.transition(job, 'verifying'); await control(action, action === 'cancel' ? job.id : undefined);
  assert.equal((await rows('jobs'))[0]!.state, 'cancel_requested');
  if (action === 'emergency-stop') assert.equal((await control('resume-model', 'emergency-stop', 'before-stop')).ok, false);
  await f.store.transition(job, 'cancelled');
  if (action === 'emergency-stop') assert.equal((await control('resume-model', 'emergency-stop', 'after-stop')).ok, true);
});
