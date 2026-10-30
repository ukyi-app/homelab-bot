import { after, afterEach, before, beforeEach, test } from 'node:test';
import assert from 'node:assert/strict';
import { RateLimited } from '../src/contracts.js';
import type { Database } from '../src/database.js';
import type { DiscordApi } from '../src/discord-protocol.js';
import type { Publisher } from '../src/main.js';
import { Store } from '../src/store.js';
import { TYPING_REFRESH_MS, typingActivity } from '../src/activity.js';
import { FakeGateway } from './fake-gateway.js';
import { localDatabase, fixture, event } from './helpers.js';
import { GUILD, OWNER, THREAD, SignalRest, bootSignal, waitFor } from './signal-boot.js';

// 모델 실행 중 입력 중 표시(개선안 v2 2-2). running chat의 채널에만 8초마다 POST /channels/{id}/typing.
let database: Awaited<ReturnType<typeof localDatabase>>;
let f: Awaited<ReturnType<typeof fixture>>;
let logs: { event: string; detail?: Record<string, unknown> }[];
let calls: string[];
let respond: (path: string) => Promise<unknown>;
const api: DiscordApi = { request: async (method, path) => { calls.push(`${method} ${path}`); return respond(path); } };
const log = (event: string, detail?: Record<string, unknown>) => { logs.push({ event, detail }); };
before(async () => { database = await localDatabase(); });
beforeEach(async () => {
  const tables = (await database.pg.query<{ tablename: string }>(
    "SELECT tablename FROM pg_tables WHERE schemaname='public' AND tablename<>'schema_migrations'")).rows.map(r => r.tablename);
  await database.pg.exec(`TRUNCATE ${tables.join(',')} RESTART IDENTITY CASCADE`);
  f = await fixture(database.db); logs = []; calls = []; respond = async () => undefined;
});
after(async () => { await database.pg.close(); });

const TYPING = 'POST /channels/fixture-thread/typing';
async function running(type = 'chat') {
  await f.ingress.receive(event(`m-${type}`));
  await database.db.query("UPDATE jobs SET state='running',type=$1,lease_until=$2 WHERE state='queued'", [type, f.now() + 60_000]);
}

test('ACT-01 running chat의 채널에만 typing, 8초 주기(그 사이에는 다시 보내지 않음)', async () => {
  assert.equal(TYPING_REFRESH_MS, 8000);
  const step = typingActivity(f.store, f.gate, api, log);
  assert.equal(await step(), false);
  assert.deepEqual(calls, []);
  await running();
  f.advance(TYPING_REFRESH_MS); await step();
  assert.deepEqual(calls, [TYPING]);
  f.advance(TYPING_REFRESH_MS - 1); await step();
  assert.deepEqual(calls, [TYPING]);
  f.advance(1); await step();
  assert.deepEqual(calls, [TYPING, TYPING]);
  // 끝나면(running 아님) 멈춘다.
  await database.db.query("UPDATE jobs SET state='succeeded'");
  f.advance(TYPING_REFRESH_MS); await step();
  assert.equal(calls.length, 2);
});

test('ACT-02 queued chat·running read/task, 구독 꺼짐·gap 대화에는 보내지 않음', async () => {
  const step = typingActivity(f.store, f.gate, api, log);
  await f.ingress.receive(event('queued'));
  await step();
  for (const type of ['read', 'task']) {
    await database.db.query("UPDATE jobs SET state='running',type=$1", [type]);
    f.advance(TYPING_REFRESH_MS); await step();
  }
  await database.db.query("UPDATE jobs SET type='chat'");
  await database.db.query('UPDATE conversations SET active=false');
  f.advance(TYPING_REFRESH_MS); await step();
  await database.db.query('UPDATE conversations SET active=true,gap=true');
  f.advance(TYPING_REFRESH_MS); await step();
  assert.deepEqual(calls, []);
});

test('ACT-03 채널·전역 rate limit pause 중이면 건너뜀', async () => {
  const step = typingActivity(f.store, f.gate, api, log);
  await running();
  await f.store.recordRateLimit(new RateLimited(5000), THREAD);
  await step();
  assert.deepEqual(calls, []);
  f.advance(TYPING_REFRESH_MS); await step();
  assert.deepEqual(calls, [TYPING]);
  await f.store.recordRateLimit(new RateLimited(20_000, true));
  f.advance(TYPING_REFRESH_MS); await step();
  assert.deepEqual(calls, [TYPING]);
});

test('ACT-04 정책 거부(철회·owner 바뀜)·정책 확인 불가면 보내지 않음', async () => {
  const step = typingActivity(f.store, f.gate, api, log);
  await running();
  await database.db.query(`INSERT INTO denied_actors(actor_id,created_at) VALUES ('fixture-owner',0)`);
  await step();
  await database.db.query('DELETE FROM denied_actors');
  f.policy.owner = 'fixture-new-owner';
  f.advance(TYPING_REFRESH_MS); await step();
  f.policy.owner = 'fixture-owner';
  f.setPolicyUnavailable(true);
  f.advance(TYPING_REFRESH_MS); await step();
  assert.deepEqual(calls, []);
  f.setPolicyUnavailable(false);
  f.advance(TYPING_REFRESH_MS); await step();
  assert.deepEqual(calls, [TYPING]);
});

test('ACT-05 429는 recordRateLimit로 기록, 그 밖 오류는 로그만 남기고 다음 주기에 다시 봄(빡빡한 재시도 없음)', async () => {
  const step = typingActivity(f.store, f.gate, api, log);
  await running();
  respond = async () => { throw new RateLimited(3000); };
  await step();
  assert.equal(await f.store.discordPauseUntil(THREAD), f.now() + 3000);
  respond = async () => { throw new Error('discord_request_failed'); };
  f.advance(TYPING_REFRESH_MS); assert.equal(await step(), false);
  // 실패 직후 다시 불러도 주기 전에는 보내지 않는다.
  await step(); await step();
  assert.equal(calls.length, 2);
  respond = async () => undefined;
  f.advance(TYPING_REFRESH_MS); await step();
  assert.equal(calls.length, 3);
  assert.deepEqual(logs.map(l => l.event), ['typing_signal_failed', 'typing_signal_failed']);
});

test('ACT-06 DB 조회 오류도 step 밖으로 던지지 않고 다음 주기에 다시 봄', async () => {
  let fail = true;
  const broken: Database = {
    query: async (sql, params) => { if (fail && /FROM jobs/.test(sql)) throw new Error('fixture_db_down'); return database.db.query(sql, params); },
    transaction: (fn, deadline) => database.db.transaction(fn, deadline),
  };
  const step = typingActivity(new Store(broken, f.now), f.gate, api, log);
  await running();
  assert.equal(await step(), false);
  fail = false;
  await step();
  assert.deepEqual(calls, []);
  f.advance(TYPING_REFRESH_MS); await step();
  assert.deepEqual(calls, [TYPING]);
  assert.equal(logs[0]?.event, 'typing_activity_failed');
});

// 진입점 배선: onReady에서 한 번 등록, 종료 신호에 멈춤.
let gw: FakeGateway;
let publisher: Publisher | undefined;
afterEach(async () => { await publisher?.stop(); publisher = undefined; await gw?.close(); });

test('ACT-07 진입점: running chat이 있으면 typing을 보내고, stop() 뒤에는 시계가 흘러도 보내지 않음', async () => {
  let offset = 0;
  gw = new FakeGateway(); gw.options.identifyIntervalMs = 250; await gw.start();
  const rest = new SignalRest();
  publisher = await bootSignal({ db: database.db, rest, gw, logs, now: () => Date.now() + offset });
  await database.db.query(`INSERT INTO conversations(id,owner_id,scope,channel_id,created_at,active)
    VALUES ($1,$2,$3,$4,0,true)`, [`thread:${GUILD}:${THREAD}`, OWNER, JSON.stringify({ kind: 'thread', guild: GUILD, channel: THREAD, parent: 'fixture-chat' }), THREAD]);
  await database.db.query(`INSERT INTO events(id,provider,delivery_id,semantic_key,actor_id,scope,conversation_id,received_at,payload,accepted)
    VALUES ('fixture-event','discord','1000','discord:1000',$1,$2,$3,0,'{}',true)`, [OWNER, JSON.stringify({ kind: 'thread', guild: GUILD, channel: THREAD, parent: 'fixture-chat' }), `thread:${GUILD}:${THREAD}`]);
  await database.db.query(`INSERT INTO jobs(id,event_id,conversation_id,type,owner_id,target,revision,budget,state,priority,available_at,created_at,lease_token,lease_until,started_at,attempt)
    VALUES ('fixture-job','fixture-event',$1,'chat',$2,$3,'{"policy":"fixture-v1"}','{}','running',10,0,0,'fixture-lease',$4,0,1)`,
  [`thread:${GUILD}:${THREAD}`, OWNER, JSON.stringify({ kind: 'thread', guild: GUILD, channel: THREAD, parent: 'fixture-chat' }), Date.now() + 3_600_000]);
  offset += TYPING_REFRESH_MS;
  assert.ok(await waitFor(() => rest.typingCalls() >= 1));
  const first = rest.typingCalls();
  offset += TYPING_REFRESH_MS;
  assert.ok(await waitFor(() => rest.typingCalls() > first));
  await publisher.stop(); publisher = undefined;
  const stopped = rest.typingCalls();
  offset += TYPING_REFRESH_MS * 3;
  await new Promise(resolve => setTimeout(resolve, 150));
  assert.equal(rest.typingCalls(), stopped);
  // alive=false: typing 루프는 하트비트 근거(health.loop)가 되지 않는다. 오류 없이 돌았는지만 본다.
  assert.equal(logs.some(l => l.event === 'typing_failed' || l.event === 'typing_signal_failed'), false);
});
