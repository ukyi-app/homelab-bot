import { after, before, beforeEach, test } from 'node:test';
import assert from 'node:assert/strict';
import { ADMIN_ACTOR, AdminUsage, parseAdminArgs, runAdmin } from '../src/admin.js';
import type { AdminCommand, AdminPorts } from '../src/admin.js';
import { adminPorts, executeAdmin } from '../src/admin-main.js';
import { DEFAULTS, Denied } from '../src/contracts.js';
import type { Database } from '../src/database.js';
import { Runtime } from '../src/runtime.js';
import { Store } from '../src/store.js';
import { localDatabase, fixture, event, thread } from './helpers.js';
import { codexBridge, codexSession, lane, reply, task } from './task-lane-fixture.js';

// C05 관리 기능(AC-20) S1: 관리 진입점이 모델을 거치지 않고 기존 저장소 경로로 비상 정지·해제·상태 보기를 하고,
// 감사에 행위자 cli를 남긴다. '/' 관리 명령은 그대로 동작한다.
let database: Awaited<ReturnType<typeof localDatabase>>;
let f: Awaited<ReturnType<typeof fixture>>;
before(async () => { database = await localDatabase(); });
beforeEach(async () => {
  const tables = (await database.pg.query<{ tablename: string }>(
    "SELECT tablename FROM pg_tables WHERE schemaname='public' AND tablename<>'schema_migrations'")).rows.map(r => r.tablename);
  await database.pg.exec(`TRUNCATE ${tables.join(',')} RESTART IDENTITY CASCADE;
    INSERT INTO execution_lanes(lane) VALUES ('interactive'), ('task') ON CONFLICT DO NOTHING`);
  f = await fixture(database.db);
});
after(async () => { await database.pg.close(); });

const admin = (...argv: string[]) => runAdmin(f.store, parseAdminArgs(argv));
const audits = async () => (await database.db.query<{ kind: string; subject: string; detail: { actor?: string } }>(
  'SELECT kind,subject,detail FROM audit ORDER BY id')).rows;
const flag = async (key: string) => (await database.db.query<{ value: boolean }>('SELECT value FROM controls WHERE key=$1', [key])).rows[0]?.value;

test('관리 기능 비상 정지: 새 모델 호출을 막고 감사 행위자가 cli다', async () => {
  const out = await admin('emergency-stop');
  assert.equal(out.code, 0);
  assert.equal(out.report.result, 'stopped');
  assert.equal(await flag('scheduler_emergency'), true);
  const rows = (await audits()).filter(row => row.detail.actor === ADMIN_ACTOR);
  assert.deepEqual(rows.map(row => [row.kind, row.subject]), [['admin_command', 'emergency-stop']]);
  assert.equal(ADMIN_ACTOR, 'cli');
  assert.equal(f.requests.length, 0);
});

const queued = async (id = 'evt') => { await f.ingress.receive(event(id)); f.advance(DEFAULTS.debounceMs + 50); };

test('관리 기능 해제: 비상 정지를 풀면 대기한 대화가 다시 모델로 가고 감사 행위자가 cli다', async () => {
  await admin('emergency-stop');
  await queued();
  assert.equal(await f.runtime.tick(), false);
  const out = await admin('resume', 'emergency-stop');
  assert.equal(out.code, 0);
  assert.equal(out.report.result, 'released');
  assert.equal(out.report.state?.emergency, false);
  assert.equal(await f.runtime.tick(), true);
  assert.equal(f.requests.length, 1);
  // 기존 해제 감사(model_emergency_released)는 행위자를 subject에 둔다.
  const kinds = (await audits()).filter(row => row.detail.actor === ADMIN_ACTOR || row.subject === ADMIN_ACTOR).map(row => row.kind);
  assert.deepEqual(kinds, ['admin_command', 'model_emergency_released', 'admin_command']);
});

test('관리 기능 해제: 비상 정지가 없으면 아무것도 바꾸지 않는다(재실행 안전)', async () => {
  // 모델 멈춤의 전역 일시 중지만 있고 비상 정지는 없다.
  await database.db.query("INSERT INTO controls(key,value) VALUES ('scheduler','true'),('scheduler_emergency','false') ON CONFLICT (key) DO UPDATE SET value=excluded.value");
  const out = await admin('resume', 'emergency-stop');
  assert.equal(out.code, 0);
  assert.equal(out.report.result, 'not_stopped');
  assert.equal(await flag('scheduler'), true);
  assert.deepEqual(await audits(), []);
});

test('관리 기능 해제: 종료를 확인하지 못한 대화 작업이 있으면 거부하고 비상 정지를 유지한다', async () => {
  await queued();
  await database.db.query("UPDATE jobs SET state='unknown'");
  await admin('emergency-stop');
  const out = await admin('resume', 'emergency-stop');
  assert.equal(out.code, 3);
  assert.equal(out.report.result, 'running_jobs');
  assert.equal(await flag('scheduler_emergency'), true);
});

test('관리 기능 상태 보기: 비상 정지·일시 중지·작업 레인 닫힘 값만 내고 아무것도 바꾸지 않는다', async () => {
  const before = await admin('status');
  assert.equal(before.code, 0);
  assert.deepEqual(before.report, { schema: 'homelab-bot-admin/v1', command: 'status', result: 'status',
    state: { emergency: false, paused: false, executionPending: false, taskLaneClosed: null } });
  await admin('emergency-stop');
  assert.deepEqual((await admin('status')).report.state, { emergency: true, paused: true, executionPending: false, taskLaneClosed: null });
  assert.deepEqual((await audits()).map(row => row.subject), ['emergency-stop']);
  assert.equal(f.requests.length, 0);
});

// ---- C32 차단 ----
const TARGET = '123456789012345678';
const block = (user = TARGET) => runAdmin(f.store, parseAdminArgs(['block', user]), { gate: f.gate });
const denials = async () => (await database.db.query<{ actor_id: string; policy_revision: string | null; denial_id: string; created_at: string }>(
  'SELECT actor_id,policy_revision,denial_id,created_at FROM denied_actors ORDER BY actor_id')).rows;

test('관리 기능 차단: 거부 목록에 행만 더하고 모델을 부르지 않으며 감사 행위자가 cli다', async () => {
  await queued();
  const jobsBefore = (await database.db.query('SELECT id,state FROM jobs ORDER BY id')).rows;
  const out = await block();
  assert.equal(out.code, 0);
  assert.equal(out.report.result, 'blocked');
  assert.equal(out.report.command, 'block');
  const rows = await denials();
  assert.deepEqual(rows.map(row => [row.actor_id, row.policy_revision]), [[TARGET, 'fixture-v1']]);
  assert.deepEqual((await database.db.query('SELECT id,state FROM jobs ORDER BY id')).rows, jobsBefore);
  assert.equal(await flag('scheduler_emergency'), undefined);
  assert.deepEqual((await audits()).map(row => [row.kind, row.subject, row.detail.actor]), [['admin_command', 'block', 'cli']]);
  assert.equal(f.requests.length, 0);
});

test('관리 기능 차단: 이미 거부돼 있으면 같은 행을 그대로 두고 already_blocked다(재실행 안전)', async () => {
  await block();
  const first = await denials();
  f.advance(1000);
  const again = await block();
  assert.equal(again.code, 0);
  assert.equal(again.report.result, 'already_blocked');
  assert.deepEqual(await denials(), first);
});

test('관리 기능 차단: owner 자신도 막고, 막힌 뒤 재실행도 Denied 없이 already_blocked다', async () => {
  f.policy.owner = TARGET;
  assert.equal((await block()).report.result, 'blocked');
  assert.equal((await block()).report.result, 'already_blocked');
});

test('관리 기능 차단: 정책 재동기화(ESO) 전에도 그 사용자의 다음 이벤트가 거부된다(AUTH-02)', async () => {
  f.policy.owner = TARGET;
  await f.ingress.receive(event('before', { actor: TARGET }));
  assert.equal((await database.db.query('SELECT 1 FROM jobs')).rows.length, 1);
  await block();
  await assert.rejects(f.ingress.receive(event('after', { actor: TARGET })), Denied);
  assert.equal((await database.db.query('SELECT 1 FROM jobs')).rows.length, 1);
  assert.equal(f.policy.revision, 'fixture-v1');
});

test('관리 기능 차단: 정책을 읽지 못하면 아무것도 더하지 않고 실패한다(닫힘)', async () => {
  f.setPolicyUnavailable(true);
  await assert.rejects(block());
  assert.deepEqual(await denials(), []);
  assert.deepEqual(await audits(), []);
});

test('관리 기능 차단: 해제 승인(revocationRestores)에 적힌 옛 거부만 남아 있으면 새 거부로 바꿔 다음 인가에도 유지된다', async () => {
  await database.db.query(`INSERT INTO denied_actors(actor_id,created_at,policy_revision,denial_id)
    VALUES ($1,$2,'fixture-v0','0f8b5a8e-3c1d-4e2f-9a7b-1c2d3e4f5a6b')`, [TARGET, f.now() - 1000]);
  f.policy.revocationRestores = ['0f8b5a8e-3c1d-4e2f-9a7b-1c2d3e4f5a6b'];
  f.policy.owner = TARGET;
  const out = await block();
  assert.equal(out.report.result, 'blocked');
  const [row] = await denials();
  assert.equal(row!.policy_revision, 'fixture-v1');
  assert.notEqual(row!.denial_id, '0f8b5a8e-3c1d-4e2f-9a7b-1c2d3e4f5a6b');
  await assert.rejects(f.gate.authorize(TARGET, thread));
});

// ---- C32 멈춘 작업 재개 ----
const MISSING = '0f8b5a8e-3c1d-4e2f-9a7b-1c2d3e4f5a6b';
const paused = async (reason = 'model_limit') => {
  await queued();
  const id = (await database.db.query<{ id: string }>('SELECT id FROM jobs')).rows[0]!.id;
  await database.db.query("UPDATE jobs SET state='waiting_user',wait_reason=$2,attempt=1 WHERE id=$1", [id, reason]);
  // 모델 멈춤은 전역 일시 중지만 켠다. 비상 정지 행이 없으면 lockScheduler가 scheduler 값을 옛 비상 정지로 옮긴다.
  await database.db.query("INSERT INTO controls(key,value) VALUES ('scheduler','true'),('scheduler_emergency','false') ON CONFLICT (key) DO UPDATE SET value=excluded.value");
  return id;
};
const job = async (id: string) => (await database.db.query<{ state: string; wait_reason: string | null }>('SELECT state,wait_reason FROM jobs WHERE id=$1', [id])).rows[0];

test('관리 기능 멈춘 작업 재개: 작업 ID만으로 모델 멈춤 작업을 다시 큐에 넣고 감사 행위자가 cli다', async () => {
  const id = await paused();
  // 대화 구독이 꺼져 있어도 대조하지 않는다.
  await database.db.query('UPDATE conversations SET active=false');
  const out = await admin('resume', 'job', id);
  assert.equal(out.code, 0);
  assert.equal(out.report.result, 'resumed');
  assert.equal(out.report.command, 'resume job');
  assert.deepEqual(await job(id), { state: 'queued', wait_reason: null });
  assert.equal(out.report.state?.paused, false);
  assert.equal(await flag('scheduler'), false);
  assert.deepEqual((await audits()).map(row => [row.kind, row.subject, row.detail.actor]),
    [['model_wait_resumed', id, 'cli'], ['admin_command', 'resume job', 'cli']]);
  assert.equal(f.requests.length, 0);
});

test('관리 기능 멈춘 작업 재개: 인증 대기도 같은 경로로 푼다', async () => {
  const id = await paused('auth_expired');
  assert.equal((await admin('resume', 'job', id)).report.result, 'resumed');
  assert.equal((await job(id))?.state, 'queued');
});

test('관리 기능 멈춘 작업 재개: 그 대기 상태가 아니면 바꾸지 않고 not_waiting이다(재실행·없는 작업·질문 대기·시도 한도)', async () => {
  const id = await paused();
  assert.equal((await admin('resume', 'job', id)).report.result, 'resumed');
  const rerun = await admin('resume', 'job', id);
  assert.equal(rerun.code, 3);
  assert.equal(rerun.report.result, 'not_waiting');
  assert.equal((await admin('resume', 'job', MISSING)).report.result, 'not_waiting');
  await database.db.query("UPDATE jobs SET state='waiting_user',wait_reason='clarification' WHERE id=$1", [id]);
  assert.equal((await admin('resume', 'job', id)).report.result, 'not_waiting');
  await database.db.query("UPDATE jobs SET wait_reason='model_limit',attempt=$2 WHERE id=$1", [id, DEFAULTS.maxRetries + 1]);
  assert.equal((await admin('resume', 'job', id)).report.result, 'not_waiting');
  assert.deepEqual(await job(id), { state: 'waiting_user', wait_reason: 'model_limit' });
  assert.equal((await audits()).filter(row => row.kind === 'model_wait_resumed').length, 1);
});

test('관리 기능 멈춘 작업 재개: 비상 정지 중이면 바꾸지 않고 emergency_stopped다', async () => {
  const id = await paused();
  await admin('emergency-stop');
  const out = await admin('resume', 'job', id);
  assert.equal(out.code, 3);
  assert.equal(out.report.result, 'emergency_stopped');
  assert.deepEqual(await job(id), { state: 'waiting_user', wait_reason: 'model_limit' });
});

test("관리 기능 멈춘 작업 재개: '/resume-model'은 그대로 owner·대화를 대조해 같은 작업을 재개한다", async () => {
  const id = await paused();
  await f.ingress.receive(event('slash-resume-job', { kind: 'command', command: 'resume-model', target: id }));
  assert.equal((await job(id))?.state, 'queued');
  assert.equal((await admin('resume', 'job', id)).report.result, 'not_waiting');
});

// ---- C32 unknown 해제 ----
const unknownTask = async () => {
  const local = lane(f);
  local.worker.scripts.push(reply.unknown());
  const created = await task(f, database.db);
  await local.runtime.tickTask();
  assert.equal((await job(created.id))?.state, 'unknown');
  return { ...local, id: created.id as string };
};
const release = (id: string, releasers: AdminPorts['releasers']) => runAdmin(f.store, parseAdminArgs(['release', id]), { releasers });

test('관리 기능 unknown 해제: 소멸 확인 뒤 풀고 레인을 열며, 모델을 부르지 않고 감사 행위자가 cli다', async () => {
  const { bridge, worker, id } = await unknownTask();
  const out = await release(id, [bridge, codexBridge(f).bridge]);
  assert.equal(out.code, 0);
  assert.equal(out.report.result, 'released');
  assert.equal(out.report.command, 'release');
  assert.equal(out.report.state?.taskLaneClosed, null);
  assert.deepEqual(await job(id), { state: 'cancelled', wait_reason: 'stop_confirmed_after_unknown' });
  assert.deepEqual((await audits()).filter(row => row.detail.actor === ADMIN_ACTOR).map(row => [row.kind, row.subject]),
    [['task_unknown_released', id], ['admin_command', 'release']]);
  assert.equal(worker.executes.length, 1, '다시 실행하지 않는다');
  assert.equal(f.requests.length, 0);
});

test('관리 기능 unknown 해제: 작업자 소멸을 확인하지 못하면 풀지 않고 running_jobs로 거부한다', async () => {
  const { bridge, worker, id } = await unknownTask();
  worker.stopped = false;
  const out = await release(id, [bridge]);
  assert.equal(out.code, 3);
  assert.equal(out.report.result, 'running_jobs');
  assert.equal(out.report.state?.taskLaneClosed, 'unknown');
  assert.equal((await job(id))?.state, 'unknown');
});

test('관리 기능 unknown 해제: 없는 작업·unknown이 아닌 작업·어느 브리지도 맡지 않는 세션은 not_releasable이다', async () => {
  const { bridge, id } = await unknownTask();
  assert.equal((await release(MISSING, [bridge])).report.result, 'not_releasable');
  assert.equal((await release(id, [bridge])).report.result, 'released');
  const rerun = await release(id, [bridge]);
  assert.equal(rerun.code, 3);
  assert.equal(rerun.report.result, 'not_releasable');
  const { job: codexJob } = await codexSession(f, database.db);
  assert.equal((await release(codexJob.id, [bridge])).report.result, 'not_releasable');
  assert.equal((await job(codexJob.id))?.state, 'unknown');
});

test('관리 기능 unknown 해제: Codex 세션은 Codex 브리지가 소멸 확인 뒤 푼다', async () => {
  const { job: codexJob } = await codexSession(f, database.db);
  const codex = codexBridge(f);
  const out = await release(codexJob.id, [lane(f).bridge, codex.bridge]);
  assert.equal(out.report.result, 'released');
  assert.deepEqual(codex.confirms, [codexJob.id]);
});

test('관리 기능 unknown 해제: 작업 레인을 조립하지 못했으면(브리지 없음) 아무것도 바꾸지 않고 실패한다', async () => {
  await assert.rejects(release(MISSING, []));
  assert.deepEqual(await audits(), []);
});

// ---- C22 계정 등록·전환·목록(AC-21의 봇 쪽) ----
const NO_PAUSES = { rate_limit: 0, auth_expired: 0, billing: 0 };
test('계정 기록: 구독 계정의 이름·방식·발급일만 남기고, 목록이 만료일(발급 뒤 1년)과 지금 계정 아님을 보인다', async () => {
  const out = await admin('account', 'record', 'main', 'subscription');
  assert.equal(out.code, 0);
  assert.equal(out.report.result, 'recorded');
  assert.equal(out.report.command, 'account record');
  const list = await admin('account', 'list');
  assert.equal(list.code, 0);
  assert.equal(list.report.result, 'accounts');
  // fixture 시계는 2027-01-15T08:00:00Z다.
  assert.deepEqual(list.report.accounts, [{ name: 'main', method: 'subscription', current: false,
    issuedAt: '2027-01-15T08:00:00Z', expiresAt: '2028-01-15T08:00:00Z', limit: null }]);
  assert.deepEqual(list.report.paused, NO_PAUSES);
  assert.deepEqual((await audits()).map(row => [row.kind, row.subject, row.detail.actor]),
    [['admin_command', 'account record', 'cli']]);
  assert.equal(f.requests.length, 0);
});

// 결제로 멈춘 대화 작업 하나와 한도로 멈춘 PR 리뷰 작업 하나.
const pausedPair = async () => {
  const chat = await paused();
  await database.db.query("INSERT INTO model_pauses(job_id,kind,retry_at,paused_at) VALUES ($1,'billing',NULL,$2)", [chat, f.now()]);
  await database.db.query(`INSERT INTO events(id,provider,delivery_id,semantic_key,actor_id,scope,received_at,payload)
    VALUES ('fixture-review','github','fixture-review','fixture-review','fixture-owner','{}',0,'{}')`);
  await database.db.query(`INSERT INTO jobs(id,event_id,type,owner_id,target,revision,budget,state,wait_reason,attempt,priority,available_at,created_at)
    VALUES ('fixture-review','fixture-review','review','fixture-owner','{}','{}','{}','waiting_user','model_limit',1,20,0,$1)`, [f.now() + 1]);
  await database.db.query("INSERT INTO model_pauses(job_id,kind,retry_at,paused_at) VALUES ('fixture-review','rate_limit',$1,$2)", [f.now() + 3_600_000, f.now()]);
  return { chat, review: 'fixture-review' };
};
const currentAccount = async () => (await database.db.query<{ name: string }>('SELECT name FROM model_accounts WHERE current')).rows.map(row => row.name);

test('계정 전환: 지금 계정을 바꾸고 결제 멈춤까지 모델 멈춤 작업을 모두 다시 큐에 넣으며 감사 행위자가 cli다', async () => {
  await admin('account', 'record', 'main', 'subscription');
  await admin('account', 'record', 'spare', 'subscription');
  const { chat, review } = await pausedPair();
  const before = await admin('account', 'list');
  assert.deepEqual(before.report.paused, { rate_limit: 1, auth_expired: 0, billing: 1 });
  const out = await admin('account', 'use', 'spare', 'subscription');
  assert.equal(out.code, 0);
  assert.equal(out.report.result, 'switched');
  assert.deepEqual(out.report.switch, { resumed: 2, waiting: 0, held: null });
  assert.deepEqual(await job(chat), { state: 'queued', wait_reason: null });
  assert.deepEqual(await job(review), { state: 'queued', wait_reason: null });
  assert.equal(await flag('scheduler'), false);
  assert.deepEqual(await currentAccount(), ['spare']);
  const after = await admin('account', 'list');
  assert.deepEqual(after.report.accounts?.map(a => [a.name, a.current]), [['main', false], ['spare', true]]);
  assert.deepEqual(after.report.paused, NO_PAUSES);
  assert.deepEqual((await audits()).filter(row => row.detail.actor === ADMIN_ACTOR || row.subject === ADMIN_ACTOR).map(row => [row.kind, row.subject]).slice(2),
    [['model_wait_resumed', chat], ['review_wait_resumed', review], ['admin_command', 'account use']]);
  assert.equal(f.requests.length, 0);
});

test('계정 전환: 등록하지 않은 계정이면 아무것도 바꾸지 않고 unknown_account(3)다', async () => {
  await admin('account', 'record', 'main', 'subscription');
  await admin('account', 'use', 'main', 'subscription');
  const { chat } = await pausedPair();
  const out = await admin('account', 'use', 'other', 'subscription');
  assert.equal(out.code, 3);
  assert.equal(out.report.result, 'unknown_account');
  assert.deepEqual(await currentAccount(), ['main']);
  assert.deepEqual(await job(chat), { state: 'waiting_user', wait_reason: 'model_limit' });
});

test('계정 전환: 비상 정지 중이면 지금 계정만 바꾸고 멈춘 작업은 그대로 두며 이유를 알린다', async () => {
  await admin('account', 'record', 'main', 'subscription');
  const { chat } = await pausedPair();
  await admin('emergency-stop');
  const out = await admin('account', 'use', 'main', 'subscription');
  assert.equal(out.code, 0);
  assert.deepEqual(out.report.switch, { resumed: 0, waiting: 2, held: 'emergency_stopped' });
  assert.deepEqual(await currentAccount(), ['main']);
  assert.deepEqual(await job(chat), { state: 'waiting_user', wait_reason: 'model_limit' });
  // 같은 계정으로 다시 실행하면(비상 정지를 푼 뒤) 그때 해제한다. 결제 멈춤을 같은 계정에서 푼 owner의 해제 경로이기도 하다.
  await admin('resume', 'emergency-stop');
  assert.deepEqual((await admin('account', 'use', 'main', 'subscription')).report.switch, { resumed: 2, waiting: 0, held: null });
});

test('계정 전환: 옛 계정의 마지막 한도 관측은 그 계정 목록에 남고, 새 계정은 관측 없음·리뷰 미루기 없음에서 시작한다', async () => {
  await admin('account', 'record', 'main', 'subscription');
  await admin('account', 'record', 'spare', 'subscription');
  await admin('account', 'use', 'main', 'subscription');
  const resets = Math.floor((f.now() + 3_600_000) / 1000);
  await f.store.observeRateLimit({ event: { status: 'allowed_warning', rateLimitType: 'five_hour', utilization: 0.97, resetsAt: resets } }, null);
  const seen = { status: 'allowed_warning', rateLimitType: 'five_hour', utilization: 0.97, resetsAt: '2027-01-15T09:00:00Z', observedAt: '2027-01-15T08:00:00Z' };
  assert.deepEqual((await admin('account', 'list')).report.accounts?.find(a => a.name === 'main')?.limit, seen);
  assert.notEqual(await f.store.reviewDeferredUntil(), null);
  await admin('account', 'use', 'spare', 'subscription');
  const accounts = (await admin('account', 'list')).report.accounts!;
  assert.deepEqual(accounts.find(a => a.name === 'main')?.limit, seen);
  assert.equal(accounts.find(a => a.name === 'spare')?.limit, null);
  assert.equal(await f.store.reviewDeferredUntil(), null);
  // A → B → A: 돌아온 지금 계정에 전환 뒤 관측이 아직 없으면 옮겨 둔 마지막 관측을 보인다. 리뷰 미루기는 되살리지 않는다.
  await admin('account', 'use', 'main', 'subscription');
  const back = (await admin('account', 'list')).report.accounts!.find(a => a.name === 'main')!;
  assert.equal(back.current, true);
  assert.deepEqual(back.limit, seen);
  assert.equal(await f.store.reviewDeferredUntil(), null);
});

const warned = (status: 'allowed_warning' | 'rejected' = 'allowed_warning') =>
  ({ status, rateLimitType: 'five_hour' as const, utilization: 0.97, resetsAt: Math.floor((f.now() + 3_600_000) / 1000) });
const limitState = async () => (await database.db.query<{ utilization: number | null; review_deferred_until: string | null }>(
  "SELECT utilization,review_deferred_until FROM model_limit_state WHERE id='account'")).rows;
const switchMidRun = async (name: string) => { f.advance(1); await admin('account', 'use', name, 'subscription'); };

test('계정 전환: 전환 전에 시작한 대화·작업 실행이 전환 뒤 한도 경고로 끝나도 새 계정의 사용률·리뷰 미루기는 비어 있고, 전환 뒤 시작한 실행의 관측은 적힌다', async () => {
  await admin('account', 'record', 'main', 'subscription');
  await admin('account', 'record', 'spare', 'subscription');
  await admin('account', 'use', 'main', 'subscription');
  // 대화: 실행 중에 owner가 spare로 바꾸고, 옛 자격으로 돈 실행이 한도 경고와 함께 끝난다.
  f.setRun(async () => { await switchMidRun('spare');
    return { status: 'succeeded', stopped: true, rateLimit: { event: warned() }, output: { reply: '답했어요.', proposal: null, ack_only: false } }; });
  await queued('chat-before');
  assert.equal(await f.runtime.tick(), true);
  assert.deepEqual(await limitState(), []);
  assert.equal(await f.store.reviewDeferredUntil(), null);
  // 전환 뒤 시작한 대화의 관측은 지금 계정 상태에 적는다.
  f.setRun(async () => ({ status: 'succeeded', stopped: true, rateLimit: { event: warned() }, output: { reply: '답했어요.', proposal: null, ack_only: false } }));
  await queued('chat-after');
  assert.equal(await f.runtime.tick(), true);
  assert.deepEqual((await limitState()).map(row => row.utilization), [0.97]);
  assert.notEqual(await f.store.reviewDeferredUntil(), null);
  // 작업 레인: 실행 중에 main으로 바꾸고(전환이 한도 상태를 비운다), 옛 자격으로 돈 실행이 한도 경고를 실은 한도 멈춤으로 끝난다.
  // 멈춤 기록과 30분 재시도는 그대로 남아 새 자격으로 다시 돈다.
  const local = lane(f);
  local.worker.scripts.push(async (request, worker) => { await switchMidRun('main');
    return { ...reply.limited()(request, worker), rateLimit: { event: warned(), stop: { cause: 'rate_limit' } } }; });
  const created = await task(f, database.db);
  await local.runtime.tickTask();
  assert.deepEqual(await job(created.id), { state: 'waiting_user', wait_reason: 'model_limit' });
  const pause = (await database.db.query<{ kind: string; retry_at: string | null }>('SELECT kind,retry_at FROM model_pauses WHERE job_id=$1', [created.id])).rows;
  assert.deepEqual(pause.map(row => [row.kind, row.retry_at !== null]), [['rate_limit', true]]);
  assert.deepEqual(await limitState(), []);
  assert.equal(await f.store.reviewDeferredUntil(), null);
});

test('계정 전환 잠금 순서: 전환과 모델 대기가 모두 scheduler 행을 한도 상태(model_limit_state)보다 먼저 잡는다', async () => {
  await admin('account', 'record', 'main', 'subscription');
  await admin('account', 'record', 'spare', 'subscription');
  await admin('account', 'use', 'main', 'subscription');
  await f.store.observeRateLimit({ event: warned() }, null);
  const sequence: string[][] = [];
  const kind = (sql: string) => /FROM controls WHERE key='scheduler' FOR UPDATE/.test(sql) ? 'scheduler'
    : /^\s*(INSERT INTO|DELETE FROM|UPDATE) model_limit_state\b/.test(sql) ? 'limit' : undefined;
  const recorded: Database = { query: (sql, params) => database.db.query(sql, params), transaction: (fn, deadline) => database.db.transaction(tx => {
    const log: string[] = [];
    sequence.push(log);
    return fn({ query: (sql, params) => { const k = kind(sql); if (k) log.push(k); return tx.query(sql, params); }, transaction: inner => tx.transaction(inner) });
  }, deadline) };
  const local = new Store(recorded, f.now);
  f.setRun(async () => ({ status: 'limited', stopped: true, rateLimit: { event: warned('rejected'), stop: { cause: 'rate_limit' } } }));
  await queued();
  assert.equal(await new Runtime(local, f.gate, f.worker, f.signer, f.reader).tick(), true);
  assert.equal((await runAdmin(local, parseAdminArgs(['account', 'use', 'spare', 'subscription']))).report.result, 'switched');
  const checked = sequence.filter(log => log.includes('limit'));
  assert.equal(checked.length, 2, JSON.stringify(sequence));
  for (const log of checked) assert.ok(log.includes('scheduler') && log.indexOf('scheduler') < log.indexOf('limit'), log.join(','));
});

test('관리 진입점 입력은 고정 명령 단어와 형식이 맞는 ID만 받는다', () => {
  for (const argv of [[], ['stop'], ['emergency-stop', 'now'], ['status', '--json'], ['resume'], ['resume', 'job'],
    ['resume', 'job', 'not-a-uuid'], ['block', 'fixture-owner'], ['block', '12345'], ['block', '123456789012345678', 'x'],
    ['block', '123456789012345678;rm'], ['release', '0F8B5A8E-3C1D-4E2F-9A7B-1C2D3E4F5A6B'], ['release', '$(id)'],
    ['account'], ['account', 'list', 'x'], ['account', 'record', 'main'], ['account', 'use', 'main', 'api'],
    ['account', 'use', 'Main', 'subscription'], ['account', 'use', '-main', 'subscription'], ['account', 'use', 'main-', 'subscription'],
    ['account', 'use', 'a'.repeat(33), 'subscription'], ['account', 'use', '../x', 'subscription'], ['account', 'record', 'main', 'subscription', 'x'],
    ['account', 'remove', 'main', 'subscription']])
    assert.throws(() => parseAdminArgs(argv), AdminUsage, argv.join(' '));
  assert.deepEqual(parseAdminArgs(['account', 'use', 'a'.repeat(32), 'subscription']),
    { name: 'account', action: 'use', account: 'a'.repeat(32), method: 'subscription' });
});

test('관리 진입점 실행: 사용법 오류는 DB를 열지 않고 64, 결과는 JSON 한 줄, 실패는 원문 없이 1', async () => {
  const lines: string[] = [];
  let opened = 0;
  const open = async () => { opened++; return { store: f.store, close: async () => {} } };
  assert.equal(await executeAdmin(['block', 'fixture-owner'], open, line => lines.push(line)), 64);
  assert.equal(opened, 0);
  assert.equal(await executeAdmin(['status'], open, line => lines.push(line)), 0);
  assert.equal(await executeAdmin(['status'], async () => { throw new Error('connect postgres://fixture-secret@db'); }, line => lines.push(line)), 1);
  assert.deepEqual(lines.map(line => JSON.parse(line).result), ['usage', 'status', 'failed']);
  assert.equal(lines.some(line => line.includes('fixture-secret')), false);
});

const runtimePolicies = JSON.stringify({ revision: 'fixture-env-v1', owner: 'fixture-owner', guild: 'fixture-guild',
  conversationChannel: 'fixture-chat', notificationChannel: 'fixture-notifications', dmEnabled: null, services: [] });

test('관리 진입점 실행: 차단은 env 정책의 revision으로 거부 행을 더하고, 다른 동작은 정책·작업자 설정을 읽지 않는다', async () => {
  const lines: string[] = [];
  const open = async (command: AdminCommand) => ({ store: f.store, close: async () => {}, ports: adminPorts(command, { RUNTIME_POLICIES: runtimePolicies }, f.store, f.now) });
  assert.equal(await executeAdmin(['block', TARGET], open, line => lines.push(line)), 0);
  assert.deepEqual((await denials()).map(row => [row.actor_id, row.policy_revision]), [[TARGET, 'fixture-env-v1']]);
  // 정책·작업자 설정이 없어도 비상 정지·상태 보기·멈춘 작업 재개는 연다.
  for (const argv of [['status'], ['emergency-stop'], ['resume', 'job', MISSING]]) assert.deepEqual(adminPorts(parseAdminArgs(argv), {}, f.store, f.now), {});
  assert.deepEqual(lines.map(line => JSON.parse(line).result), ['blocked']);
});

test('관리 진입점 실행: 정책·게시 서버 설정을 읽지 못하면 차단·해제는 아무것도 바꾸지 않고 실패(1)한다', async () => {
  const lines: string[] = [];
  const open = (env: Record<string, string>) => async (command: AdminCommand) => ({ store: f.store, close: async () => {}, ports: adminPorts(command, env, f.store, f.now) });
  assert.equal(await executeAdmin(['block', TARGET], open({}), line => lines.push(line)), 1);
  assert.equal(await executeAdmin(['block', TARGET], open({ RUNTIME_POLICIES: '{"revision":1}' }), line => lines.push(line)), 1);
  assert.equal(await executeAdmin(['release', MISSING], open({ RUNTIME_POLICIES: runtimePolicies }), line => lines.push(line)), 1);
  assert.deepEqual(lines.map(line => JSON.parse(line).result), ['failed', 'failed', 'failed']);
  assert.deepEqual(await denials(), []);
  assert.deepEqual(await audits(), []);
});

test('관리 진입점 실행: 실패해도 stdout에는 결과 JSON 한 줄만 나가고 오류 로그는 stderr로 간다', async () => {
  const stdout: string[] = [];
  const stderr: string[] = [];
  const out = process.stdout.write.bind(process.stdout);
  const err = process.stderr.write.bind(process.stderr);
  process.stdout.write = ((chunk: string | Uint8Array) => { stdout.push(String(chunk)); return true; }) as typeof process.stdout.write;
  process.stderr.write = ((chunk: string | Uint8Array) => { stderr.push(String(chunk)); return true; }) as typeof process.stderr.write;
  let code: number;
  try {
    code = await executeAdmin(['status'], async () => { throw new Error('connect postgres://fixture-secret@db'); }, line => process.stdout.write(`${line}\n`));
  } finally {
    process.stdout.write = out;
    process.stderr.write = err;
  }
  assert.equal(code, 1);
  assert.equal(stdout.length, 1);
  assert.equal(JSON.parse(stdout[0]!).result, 'failed');
  assert.equal(stderr.some(line => JSON.parse(line).event === 'admin_failed'), true);
  assert.equal([...stdout, ...stderr].some(line => line.includes('fixture-secret')), false);
});

test("'/' 관리 명령은 그대로 동작하고 관리 기능과 같은 상태를 본다", async () => {
  await f.ingress.receive(event('seed'));
  await f.ingress.receive(event('slash-stop', { kind: 'command', command: 'emergency-stop' }));
  assert.equal((await admin('status')).report.state?.emergency, true);
  await admin('emergency-stop');
  await f.ingress.receive(event('slash-resume', { kind: 'command', command: 'resume-model', target: 'emergency-stop' }));
  assert.equal(await flag('scheduler_emergency'), false);
  await f.ingress.receive(event('slash-revoke', { kind: 'command', command: 'revoke', target: 'fixture-other' }));
  assert.equal((await database.db.query("SELECT 1 FROM denied_actors WHERE actor_id='fixture-other'")).rows.length, 1);
});
