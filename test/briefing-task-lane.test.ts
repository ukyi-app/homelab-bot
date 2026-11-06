import { after, afterEach, before, beforeEach, test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, rm } from 'node:fs/promises';
import { BriefingScheduler } from '../src/briefing.js';
import type { BriefingTaskSource } from '../src/briefing.js';
import type { PublisherConfig } from '../src/config.js';
import type { Database } from '../src/database.js';
import { EXTERNAL_LINK_TTL_MS, ExternalTaskLinks } from '../src/external-task-links.js';
import type { MemoryService } from '../src/memory.js';
import { loadRuntimePolicy } from '../src/policy.js';
import { Store } from '../src/store.js';
import { ENVIRONMENT, seedConversation } from './external-task-fixture.js';
import { fixture, localDatabase, thread } from './helpers.js';
import { closeLedgers, initLedger, ledgerAt } from './ledger-fixture.js';
import { CHAT, GUILD, NOTIFY, OWNER, ProbeLedger, Trace, boot, breakable, briefingTime, publisherConfig, waitFor } from './t20-harness.js';

// 브리핑의 작업 레인 칸. 브리핑은 알림 채널에 공개되므로 건수와 상태 상수만 담는다.
const SLOT = Date.UTC(2027, 0, 15, 23, 50);
const COUNTS_ZERO = '실행 중 0건 · 질문 대기 0건 · 한도·인증 대기 0건 · unknown 0건 · 도구 승인 대기: 지원 안 함';
const OPEN: BriefingTaskSource = { gate: () => ({ open: true, routed: true, intakeOpen: true }) };
const SECRETS = ['fixture-secret-request', 'fixture-secret-prompt', 'fixture-secret-org/fixture-secret-repo', '/fixture/secret/path', 'fixture-secret-token'];
const memory = { recheckDue: async () => ({ items: [], total: 0 }), live: async () => true } as unknown as MemoryService;

let database: Awaited<ReturnType<typeof localDatabase>>;
let f: Awaited<ReturnType<typeof fixture>>;
let dirs: string[] = [];
const closers: (() => Promise<void>)[] = [];
before(async () => { database = await localDatabase(); await mkdir('.local', { recursive: true }); });
after(async () => { await database.pg.close(); });
beforeEach(async () => {
  const tables = (await database.pg.query<{ tablename: string }>(
    "SELECT tablename FROM pg_tables WHERE schemaname='public' AND tablename NOT IN ('schema_migrations','execution_lanes','external_task_link_fence')")).rows.map(r => r.tablename);
  await database.pg.exec(`TRUNCATE ${tables.join(',')} RESTART IDENTITY CASCADE`);
  await database.pg.exec('UPDATE execution_lanes SET closed_reason=NULL,closed_at=NULL');
  await database.pg.exec('UPDATE external_task_link_fence SET token=NULL,fenced_at=NULL');
  f = await fixture(database.db);
});
afterEach(async () => {
  for (const close of closers.splice(0).reverse()) await close().catch(() => {});
  await closeLedgers();
  for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true });
});

let seq = 0;
async function job(type: string, state: string, waitReason: string | null = null) {
  const id = `fixture-job-${++seq}`;
  await database.db.query(`INSERT INTO events(id,provider,delivery_id,semantic_key,actor_id,scope,received_at,payload)
    VALUES ($1,'discord',$1,$1,'fixture-owner','{}',0,$2)`, [id, JSON.stringify({ text: SECRETS[0] })]);
  await database.db.query(`INSERT INTO jobs(id,event_id,type,owner_id,target,revision,budget,state,wait_reason,priority,available_at,created_at)
    VALUES ($1,$1,$2,'fixture-owner',$3,'{}','{}',$4,$5,10,0,0)`, [id, type, JSON.stringify({ request: SECRETS[0], repository: SECRETS[2], path: SECRETS[3] }), state, waitReason]);
  return id;
}
async function question(jobId: string, createdAt: number, state = 'open') {
  await seedConversation(database.db, f.store, 0);
  await database.db.query(`INSERT INTO codex_questions(id,job_id,conversation_id,thread_id,turn,kind,responder_id,prompt,state,created_at,expires_at)
    VALUES ($1,$2,$3,'fixture-thread-id',1,'clarification','fixture-owner',$4,$5,$6,$7)`,
  [`${jobId}:q`, jobId, f.store.scopeId(thread), SECRETS[1], state, createdAt, createdAt + 3_600_000]);
}
async function compose(task?: BriefingTaskSource, store: Store = f.store) {
  const scheduler = new BriefingScheduler(store, f.gate, memory, [], { time: '08:50', timezone: 'Asia/Seoul' }, task);
  await scheduler.ensure();
  f.advance(SLOT - f.now()); f.policy.confirmedAt = f.now();
  assert.equal(await scheduler.tick(), 'enqueued', '조회 실패가 브리핑을 막지 않는다');
  return (await database.db.query<{ payload: { content: string } }>("SELECT payload FROM outbox WHERE message_key LIKE 'briefing:%'")).rows[0]!.payload.content;
}
function laneLine(content: string): string {
  const lines = content.split('\n').filter(line => line.startsWith('- 작업 레인'));
  assert.equal(lines.length, 1, content);
  return lines[0]!;
}

test('브리핑 칸 꺼짐: 스위치가 꺼진 작업자는 꺼짐과 0건, 승인은 지원 안 함, R08 표시 없음', async () => {
  const content = await compose({ gate: () => ({ open: false, reason: 'switch_off' }) });
  assert.equal(laneLine(content), `- 작업 레인: 꺼짐 · ${COUNTS_ZERO}`);
  assert.doesNotMatch(content, /연결 전\(T18\)|Codex 작업 상태|R08/);
});

test('브리핑 칸 꺼짐: 스위치를 끈 뒤 남은 작업도 건수로 드러남', async () => {
  await job('task', 'unknown');
  const line = laneLine(await compose({ gate: () => ({ open: false, reason: 'switch_off' }) }));
  assert.match(line, /^- 작업 레인: 꺼짐 · .*unknown 1건/);
});

test('브리핑 칸 열림: 작업 레인 건수만 세고 질문 대기에 가장 오래된 대기 시간을 붙임', async () => {
  await job('task', 'running'); await job('task', 'cancel_requested');
  await question(await job('task', 'waiting_user', 'clarification'), SLOT - 42 * 60_000);
  await question(await job('task', 'waiting_user', 'clarification'), SLOT - 60_000);
  await job('task', 'waiting_user', 'model_limit'); await job('task', 'waiting_user', 'auth_expired');
  await job('task', 'unknown');
  // 세지 않는 것: 대기열·끝난 작업·다른 레인, 답을 받아 끝난 질문.
  await job('task', 'queued'); await job('task', 'succeeded'); await job('chat', 'running'); await job('review', 'unknown');
  await question(await job('task', 'queued'), SLOT - 300 * 60_000, 'answered');
  assert.equal(laneLine(await compose(OPEN)),
    '- 작업 레인: 열림 · 실행 중 2건 · 질문 대기 2건(가장 오래된 42분) · 한도·인증 대기 2건 · unknown 1건 · 도구 승인 대기: 지원 안 함');
});

for (const [elapsed, text] of [[30_000, '1분 미만'], [65 * 60_000, '1시간 5분'], [-60_000, '1분 미만']] as const) {
  test(`브리핑 칸 대기 시간: ${elapsed}ms 전 질문은 ${text}`, async () => {
    await question(await job('task', 'waiting_user', 'clarification'), SLOT - elapsed);
    assert.match(laneLine(await compose(OPEN)), new RegExp(`질문 대기 1건\\(가장 오래된 ${text}\\)`));
  });
}

test('브리핑 칸 대기 시간: 질문 행이 없는 대기는 시간을 지어내지 않음', async () => {
  await job('task', 'waiting_user', 'clarification');
  assert.match(laneLine(await compose(OPEN)), /질문 대기 1건\(대기 시간 미확인\)/);
});

const CLOSED: [string, BriefingTaskSource, string | null, string][] = [
  ['정책 오류', { gate: () => ({ open: false, reason: 'policy_invalid' }) }, null, '닫힘(정책 오류)'],
  ['작업자 응답 전', { gate: () => ({ open: true, routed: false, intakeOpen: false }) }, null, '닫힘(작업자 대기)'],
  ['작업자 수락 닫힘', { gate: () => ({ open: true, routed: true, intakeOpen: false }) }, null, '닫힘(작업자 수락 닫힘)'],
  ['unknown', OPEN, 'unknown', '닫힘(종료 미확인)'],
  ['정리 대기', OPEN, 'cleanup_pending', '닫힘(정리 대기)'],
  ['보존 가득', OPEN, 'retention_full', '닫힘(보존 세션 가득 참)'],
  ['작업자와 DB 함께', { gate: () => ({ open: true, routed: true, intakeOpen: false }) }, 'unknown', '닫힘(작업자 수락 닫힘, 종료 미확인)'],
  ['DB의 모르는 사유', OPEN, 'fixture_secret_reason', '닫힘(사유 미상)'],
];
for (const [name, task, reason, label] of CLOSED) {
  test(`브리핑 칸 닫힘(${name}): ${label}`, async () => {
    if (reason) {
      // 모르는 사유 칸은 DB 제약 밖의 값이다. DB 응답만 바꿔 라벨로 새지 않는지 본다.
      const known = reason !== 'fixture_secret_reason';
      if (known) await database.db.query(`UPDATE execution_lanes SET closed_reason=$1,closed_at=1 WHERE lane='task'`, [reason]);
      const db: Database = known ? database.db : rewritingClosedReason(database.db, reason);
      const content = await compose(task, known ? f.store : new Store(db, f.now));
      assert.equal(laneLine(content), `- 작업 레인: ${label} · ${COUNTS_ZERO}`);
      assert.doesNotMatch(content, /fixture_secret_reason/);
      return;
    }
    assert.equal(laneLine(await compose(task)), `- 작업 레인: ${label} · ${COUNTS_ZERO}`);
  });
}
function rewritingClosedReason(db: Database, reason: string): Database {
  return { query: async <T>(sql: string, params?: unknown[]) => {
    const result = await db.query<T>(sql, params);
    return sql.includes('closed_reason') ? { ...result, rows: result.rows.map(row => ({ ...row, closed_reason: reason })) } : result;
  }, transaction: (fn, deadline) => db.transaction(fn, deadline) };
}

test('브리핑 칸 원본 없음: 게이트를 받지 못하면 열림이라 말하지 않음', async () => {
  assert.equal(laneLine(await compose()), `- 작업 레인: 상태 미확인 · ${COUNTS_ZERO}`);
});

test('브리핑 칸 조회 실패: 건수를 읽지 못해도 브리핑은 나가고 미확인, 열림이라 말하지 않음', async () => {
  const broken = breakable(database.db, sql => sql.includes("execution_lane='task'"), () => new Error('injected_db_failure'));
  const store = new Store(broken.db, f.now);
  assert.equal(laneLine(await compose(OPEN, store)), '- 작업 레인: 상태 미확인 · 건수 미확인 · 도구 승인 대기: 지원 안 함');
  assert.ok(broken.state.hits > 0);
});

test('브리핑 칸 조회 실패: 스위치가 꺼졌거나 작업자가 닫혔다는 사실은 건수 실패와 무관하게 보임', async () => {
  const broken = breakable(database.db, sql => sql.includes("execution_lane='task'"), () => new Error('injected_db_failure'));
  const store = new Store(broken.db, f.now);
  assert.equal(laneLine(await compose({ gate: () => ({ open: true, routed: false, intakeOpen: false }) }, store)),
    '- 작업 레인: 닫힘(작업자 대기) · 건수 미확인 · 도구 승인 대기: 지원 안 함');
});

test('브리핑 칸 조회 실패: 스위치 꺼짐도 건수 실패 때 그대로 꺼짐', async () => {
  const broken = breakable(database.db, sql => sql.includes("execution_lane='task'"), () => new Error('injected_db_failure'));
  assert.equal(laneLine(await compose({ gate: () => ({ open: false, reason: 'switch_off' }) }, new Store(broken.db, f.now))),
    '- 작업 레인: 꺼짐 · 건수 미확인 · 도구 승인 대기: 지원 안 함');
});

test('브리핑 칸 조회 실패: 게이트 함수가 던져도 브리핑은 나감', async () => {
  const line = laneLine(await compose({ gate: () => { throw new Error('fixture-secret-token'); } }));
  assert.equal(line, `- 작업 레인: 상태 미확인 · ${COUNTS_ZERO}`);
});

test('브리핑 칸 R08: 스위치를 켠 작업자는 같은 줄에 연결 수를 보임', async () => {
  const on = laneLine(await compose({ ...OPEN, externalConnections: async () => 3 }));
  assert.equal(on, `- 작업 레인: 열림 · ${COUNTS_ZERO} · R08 연결 3건`);
});
test('브리핑 칸 R08: 연결 조회 실패는 그 칸만 미확인이고 레인 건수는 그대로', async () => {
  const failed = laneLine(await compose({ ...OPEN, externalConnections: async () => { throw new Error('fixture-secret-token'); } }));
  assert.equal(failed, `- 작업 레인: 열림 · ${COUNTS_ZERO} · R08 연결 미확인`);
});

test('브리핑 칸 공개 범위: 요청 원문·질문·저장소·경로·토큰이 브리핑 어디에도 없음', async () => {
  await question(await job('task', 'waiting_user', 'clarification'), SLOT - 60_000);
  await job('task', 'running'); await job('task', 'unknown');
  await database.db.query(`INSERT INTO codex_sessions(job_id,thread_id,turn,tool_calls,host,repository,capabilities,state,created_at,updated_at)
    SELECT id,$1,1,0,'worker-task',$2,'{}','running',0,0 FROM jobs WHERE state='running'`, [SECRETS[4], SECRETS[2]]);
  const content = await compose({ gate: () => ({ open: true, routed: true, intakeOpen: false }), externalConnections: async () => 1 });
  assert.match(laneLine(content), /질문 대기 1건/);
  for (const secret of SECRETS) assert.ok(!content.includes(secret), secret);
  // 칸은 고정 문구·숫자로만 이뤄진다.
  assert.match(laneLine(content), /^- 작업 레인: [가-힣()·, 0-9a-zR:]+$/);
});

test('R08 활성 연결 수: 살아 있는 연결만 세고 해제·만료는 뺌', async () => {
  await seedConversation(database.db, f.store, f.now());
  const links = new ExternalTaskLinks(f.store);
  assert.equal(await links.activeCount(), 0);
  await links.attach({ owner: 'fixture-owner', scope: thread, externalTaskId: 'session-keep', executor: 'claude' });
  const revoked = await links.attach({ owner: 'fixture-owner', scope: thread, externalTaskId: 'session-revoked', executor: 'claude' });
  const expiring = await links.attach({ owner: 'fixture-owner', scope: thread, externalTaskId: 'session-expiring', executor: 'codex' });
  assert.equal(await links.activeCount(), 3);
  await links.revoke(revoked.connectionId, 'fixture-owner', 'detach');
  assert.equal(await links.activeCount(), 2);
  await database.db.query('UPDATE external_task_connections SET expires_at=$2 WHERE id=$1', [expiring.connectionId, f.now() - 1]);
  assert.equal(await links.activeCount(), 1);
  f.advance(EXTERNAL_LINK_TTL_MS + 1);
  assert.equal(await links.activeCount(), 0, '시각만 지나도 뺀다');
});

// 조립: 게시 서버가 설정·작업자 응답에서 실제로 넘기는 값으로 브리핑이 나가는지 본다.
const TASK_POLICY = { projects: [{ id: 'fixture', revision: 'r1', repository: 'fixture-org/fixture-repo', branch: 'main',
  allowedPaths: ['src'], forbiddenPaths: [], verifyCommands: ['unit'] }] };
const policyWith = (task: unknown) => loadRuntimePolicy(JSON.stringify({ revision: 'fixture-v1', owner: OWNER, guild: GUILD, conversationChannel: CHAT,
  notificationChannel: NOTIFY, dmEnabled: false, services: ['homelab-bot'], task }), Date.now());
const intake = (open: boolean | null): typeof fetch => async input => {
  if (new URL(String(input)).pathname !== '/v1/task/intake' || open === null) return new Response('OK');
  return Response.json({ version: 1, open, reasons: [], capabilities: { lanes: { task: true } } });
};
async function assembled(extra: Partial<PublisherConfig>, deps: Parameters<typeof boot>[3] = {}) {
  const trace = new Trace();
  const { dir } = await initLedger('briefing-task-lane');
  dirs.push(dir);
  const booted = await boot(database.db, publisherConfig({ memory: { ledgerDir: dir, acceptGeneration: null },
    briefing: { time: briefingTime(), timezone: 'UTC' }, ...extra }), trace,
  { ledger: new ProbeLedger(ledgerAt(dir, database.db), trace), taskWorkerProbeMs: 20, ...deps });
  closers.push(booted.close);
  return { ...booted, trace };
}
// 새 예약은 다음 회차부터 돈다. 기다리지 않게 예약을 지금으로 당겨 오늘 회차를 쓰게 한다.
async function sentLine({ rest, trace }: { rest: { sent: { content: string }[] }; trace: Trace }) {
  await waitFor(() => trace.index('t20_barrier_passed') >= 0);
  await database.db.query('UPDATE schedules SET next_run=$1', [Date.now()]);
  await waitFor(() => rest.sent.some(message => message.content.includes('- 작업 레인')));
  return laneLine(rest.sent.find(message => message.content.includes('- 작업 레인'))!.content);
}

test('조립 브리핑: 스위치가 꺼진 게시 서버는 꺼짐이고 R08 표시가 없음', async () => {
  assert.equal(await sentLine(await assembled({})), `- 작업 레인: 꺼짐 · ${COUNTS_ZERO}`);
});
test('조립 브리핑: 켰는데 정책이 틀리면 닫힘(정책 오류)', async () => {
  const booted = await assembled({ policy: policyWith({ projects: [] }), taskLane: { workerUrl: 'http://127.0.0.1:9/' } });
  assert.equal(await sentLine(booted), `- 작업 레인: 닫힘(정책 오류) · ${COUNTS_ZERO}`);
});
test('조립 브리핑: 켰고 정책이 맞아도 작업자가 답하기 전에는 닫힘(작업자 대기)', async () => {
  const booted = await assembled({ policy: policyWith(TASK_POLICY), taskLane: { workerUrl: 'http://worker-task.fixture/' } }, { send: intake(null) });
  assert.equal(await sentLine(booted), `- 작업 레인: 닫힘(작업자 대기) · ${COUNTS_ZERO}`);
});
for (const [open, label] of [[false, '닫힘(작업자 수락 닫힘)'], [true, '열림']] as const) {
  test(`조립 브리핑: 켠 작업자가 수락 ${open}으로 답하면 ${label}`, async () => {
    const booted = await assembled({ policy: policyWith(TASK_POLICY), taskLane: { workerUrl: 'http://worker-task.fixture/' } }, { send: intake(open) });
    await waitFor(() => booted.trace.index('task_worker_intake') >= 0);
    assert.equal(await sentLine(booted), `- 작업 레인: ${label} · ${COUNTS_ZERO}`);
  });
}
test('조립 브리핑: R08 스위치를 켜면 활성 연결 수가 같은 줄에 나옴', async () => {
  await seedConversation(database.db, f.store, f.now());
  await new ExternalTaskLinks(new Store(database.db)).attach({ owner: OWNER, scope: thread, externalTaskId: 'session-a', executor: 'claude' });
  const booted = await assembled({ externalTask: { environment: ENVIRONMENT } }, { ports: { app: 0, alerts: 0, externalEvents: 0 } });
  assert.equal(await sentLine(booted), `- 작업 레인: 꺼짐 · ${COUNTS_ZERO} · R08 연결 1건`);
});
