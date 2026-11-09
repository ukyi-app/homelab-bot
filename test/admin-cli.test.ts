import { after, before, beforeEach, test } from 'node:test';
import assert from 'node:assert/strict';
import { ADMIN_ACTOR, AdminUsage, parseAdminArgs, runAdmin } from '../src/admin.js';
import { executeAdmin } from '../src/admin-main.js';
import { DEFAULTS } from '../src/contracts.js';
import { localDatabase, fixture, event, thread } from './helpers.js';

// C05 관리 기능(AC-20) S1: 관리 진입점이 모델을 거치지 않고 기존 저장소 경로로 비상 정지·해제·상태 보기를 하고,
// 감사에 행위자 cli를 남긴다. '/' 관리 명령은 그대로 동작한다.
let database: Awaited<ReturnType<typeof localDatabase>>;
let f: Awaited<ReturnType<typeof fixture>>;
before(async () => { database = await localDatabase(); });
beforeEach(async () => {
  const tables = (await database.pg.query<{ tablename: string }>(
    "SELECT tablename FROM pg_tables WHERE schemaname='public' AND tablename<>'schema_migrations'")).rows.map(r => r.tablename);
  await database.pg.exec(`TRUNCATE ${tables.join(',')} RESTART IDENTITY CASCADE`);
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

test('관리 기능 차단·unknown 해제·멈춘 작업 재개는 이 진입점에서 아직 받지 않고 아무것도 바꾸지 않는다', async () => {
  for (const argv of [['block', '123456789012345678'], ['release', '0f8b5a8e-3c1d-4e2f-9a7b-1c2d3e4f5a6b'],
    ['resume', 'job', '0f8b5a8e-3c1d-4e2f-9a7b-1c2d3e4f5a6b']]) {
    const out = await admin(...argv);
    assert.equal(out.code, 4, argv.join(' '));
    assert.equal(out.report.result, 'unsupported');
  }
  assert.equal((await database.db.query('SELECT 1 FROM denied_actors')).rows.length, 0);
  assert.deepEqual(await audits(), []);
});

test('관리 진입점 입력은 고정 명령 단어와 형식이 맞는 ID만 받는다', () => {
  for (const argv of [[], ['stop'], ['emergency-stop', 'now'], ['status', '--json'], ['resume'], ['resume', 'job'],
    ['resume', 'job', 'not-a-uuid'], ['block', 'fixture-owner'], ['block', '12345'], ['block', '123456789012345678', 'x'],
    ['block', '123456789012345678;rm'], ['release', '0F8B5A8E-3C1D-4E2F-9A7B-1C2D3E4F5A6B'], ['release', '$(id)']])
    assert.throws(() => parseAdminArgs(argv), AdminUsage, argv.join(' '));
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
