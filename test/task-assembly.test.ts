import { after, afterEach, before, beforeEach, test } from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync, randomUUID } from 'node:crypto';
import { createServer } from 'node:http';
import type { Server } from 'node:http';
import { once } from 'node:events';
import { lstat } from 'node:fs/promises';
import type { AddressInfo } from 'node:net';
import { join } from 'node:path';
import { CHAT_TASK_TEXT as T } from '../src/chat-task-text.js';
import { CLAUDE_TASK_LANE_CAPABILITIES } from '../src/claude-task-bridge.js';
import { COMMAND_DEFINITIONS, FOUNDATION_COMMANDS, TASK_COMMANDS, TASK_COMMAND_DEFINITIONS, commandDefinitions } from '../src/commands.js';
import type { PublisherConfig } from '../src/config.js';
import { ADDRESS_KEYS, ConfigError, TASK_KEYS, loadPublisherConfig } from '../src/config.js';
import { Denied, type Job } from '../src/contracts.js';
import { taskLaneClosedText } from '../src/control-format.js';
import { ALL_COMMANDS, DiscordIngress } from '../src/discord.js';
import type { DiscordApi } from '../src/discord-protocol.js';
import { DiscordRejected } from '../src/contracts.js';
import { startPublisher, taskPrecondition } from '../src/main.js';
import type { Publisher } from '../src/main.js';
import { loadRuntimePolicy } from '../src/policy.js';
import type { Policy } from '../src/policy.js';
import { Store } from '../src/store.js';
import { TaskCommands } from '../src/task-commands.js';
import { TASK_ENDPOINTS, TaskWorkerSigner, TaskWorkerVerifier } from '../src/task-contracts.js';
import { HttpTaskWorker, taskWorkerIntake } from '../src/task-http.js';
import { TaskWorkerRejected } from '../src/task-bridge.js';
import { PolicyTaskPlans, TaskPolicySchema, branchHead } from '../src/task-policy.js';
import { FakeGateway } from './fake-gateway.js';
import { event, fixture as storeFixture, localDatabase, thread } from './helpers.js';
import type { MockDiscord } from './helpers.js';
import { jobs, lane, laneRow, reply } from './task-lane-fixture.js';
import { CHAT, GUILD, NOTIFY, OWNER, Trace, publisherConfig, waitFor } from './t20-harness.js';
import { Rest } from './t20-harness.js';
import { COMPLETED, QUESTION, workerFixture } from './task-worker-harness.js';
import type { WorkerFixture } from './task-worker-harness.js';
import { startRequest } from './task-fixtures.js';

// 작업 레인 조립. 실제 Discord·모델·GitHub에는 닿지 않는다: loopback 가짜 Gateway, 메모리 REST, 가짜 CLI, send 주입.
const BASE = 'c'.repeat(40);
const publisherEnv = (overrides: Record<string, string> = {}): Record<string, string> => ({
  DATABASE_URL: 'postgresql://fixture@pg.fixture:5432/fixture', DISCORD_BOT_TOKEN: 'fixture-discord-token-value',
  RUNTIME_POLICIES: JSON.stringify({ revision: 'fixture-v1', owner: OWNER, guild: GUILD, conversationChannel: CHAT, notificationChannel: NOTIFY, dmEnabled: false, services: [] }),
  GRAFANA_READER_TOKEN: 'fixture-grafana-token-value', HEALTHCHECKS_PING_URL: 'https://hc-ping.example/fixture',
  WORKER_CONTROL_PRIVATE_KEY: generateKeyPairSync('ed25519').privateKey.export({ type: 'pkcs8', format: 'pem' }).toString(),
  GITHUB_REVIEW_WEBHOOK_SECRET: 'fixture-webhook-secret-value', WORKER_URL: 'http://worker.sandbox:8080/',
  GRAFANA_URL: 'http://grafana.observability:3000', KUBERNETES_API_URL: 'https://kubernetes.default.svc', ...overrides });
const TASK_POLICY = { projects: [{ id: 'fixture', revision: 'r1', repository: 'fixture-org/fixture-repo', branch: 'main',
  allowedPaths: ['src'], forbiddenPaths: [], verifyCommands: ['unit'] }] };
const policyWith = (task: unknown): Policy => loadRuntimePolicy(JSON.stringify({ revision: 'fixture-v1', owner: OWNER, guild: GUILD, conversationChannel: CHAT,
  notificationChannel: NOTIFY, dmEnabled: false, services: ['homelab-bot'], ...(task === undefined ? {} : { task }) }), Date.now());

class TaskRest extends Rest {
  guild: { name: string }[] = [];
  threads: string[] = [];
  acks: { id: string; content: string }[] = [];
  channels = new Map<string, { id: string; type: number; guild_id: string; parent_id?: string }>([[CHAT, { id: CHAT, type: 0, guild_id: GUILD }], [NOTIFY, { id: NOTIFY, type: 0, guild_id: GUILD }]]);
  override async request(method: 'GET' | 'POST' | 'PUT', path: string, body?: unknown): Promise<unknown> {
    let m: RegExpMatchArray | null;
    if (path === `/applications/fixture-app/guilds/${GUILD}/commands`) {
      if (method === 'PUT') this.guild = body as { name: string }[];
      return this.guild;
    }
    if (method === 'GET' && (m = path.match(/^\/channels\/([^/?]+)$/))) {
      const channel = this.channels.get(decodeURIComponent(m[1]!));
      if (!channel) throw new DiscordRejected(404);
      return channel;
    }
    if (method === 'POST' && (m = path.match(/^\/channels\/([^/]+)\/threads$/))) {
      const id = `fixture-thread-${this.threads.length + 1}`;
      this.threads.push(id);
      this.channels.set(id, { id, type: 11, guild_id: GUILD, parent_id: decodeURIComponent(m[1]!) });
      return { id };
    }
    if (method === 'POST' && (m = path.match(/^\/interactions\/([^/]+)\//))) {
      this.acks.push({ id: decodeURIComponent(m[1]!), content: String((body as { data: { content: string } }).data.content) });
      return undefined;
    }
    return super.request(method, path, body);
  }
  names() { return this.guild.map(c => c.name).sort(); }
  threadText(channel: string) { return this.sent.filter(m => m.channel === channel).map(m => m.content).join('\n'); }
}

let database: Awaited<ReturnType<typeof localDatabase>>;
let gw: FakeGateway;
let rest: TaskRest;
let publisher: Publisher | undefined;
let worker: WorkerFixture | undefined;
let logs: { event: string; detail?: Record<string, unknown> }[];
let sends: { url: string; method: string; auth: boolean }[];
before(async () => { database = await localDatabase(); });
after(async () => { await database.pg.close(); });
beforeEach(async () => {
  const tables = (await database.pg.query<{ tablename: string }>(
    "SELECT tablename FROM pg_tables WHERE schemaname='public' AND tablename NOT IN ('schema_migrations','execution_lanes')")).rows.map(r => r.tablename);
  await database.pg.exec(`TRUNCATE ${tables.join(',')} RESTART IDENTITY CASCADE`);
  await database.pg.exec(`UPDATE execution_lanes SET closed_reason=NULL,closed_at=NULL`);
  gw = new FakeGateway(); gw.options.identifyIntervalMs = 250; await gw.start();
  rest = new TaskRest(new Trace()); logs = []; sends = [];
});
afterEach(async () => {
  await publisher?.stop(); publisher = undefined;
  await worker?.close(); worker = undefined;
  await gw.close();
});

// 작업자 대역과 GitHub 대역이 send 뒤에 있다. 실제 작업자 fixture가 있으면 그 주소로는 진짜 fetch를 쓴다.
function sender(handlers: { head?: () => Response } = {}): typeof fetch {
  return async (input, init = {}) => {
    const url = new URL(String(input));
    sends.push({ url: url.href, method: init.method ?? 'GET', auth: new Headers(init.headers).has('authorization') });
    if (url.hostname === 'api.github.com') return handlers.head?.() ?? new Response(`${BASE}\n`, { status: 200 });
    if (url.hostname === '127.0.0.1') return fetch(input, init);
    return new Response('OK');
  };
}
async function boot(extra: Partial<PublisherConfig>, send: typeof fetch = sender()) {
  publisher = await startPublisher(publisherConfig(extra), { db: database.db, discord: rest, send, gatewayUrl: async () => ({ url: gw.url }),
    allowGatewayUrl: url => url.hostname === '127.0.0.1', serviceAccount: { tokenFile: '/nonexistent', caFile: null }, ports: { app: 0, alerts: 0 },
    idleMs: 20, identifySpacingMs: 250, registerDelaysMs: [0, 20, 20], heartbeatEveryMs: 60_000, stopTimeoutMs: 3000, taskWorkerProbeMs: 30,
    log: (name, detail) => logs.push({ event: name, detail }) });
  return publisher;
}
let interactions = 7000;
function command(name: string, channel: string, options: Record<string, string> = {}) {
  const id = String(++interactions);
  gw.dispatch(gw.latest, interactions, 'INTERACTION_CREATE', { id, token: `fixture-token-${id}`, type: 2, channel_id: channel, guild_id: GUILD,
    member: { user: { id: OWNER } }, data: { name, options: Object.entries(options).map(([key, value]) => ({ name: key, value })) } });
  return id;
}
const rows = async <T = Record<string, any>>(sql: string, params: unknown[] = []) => (await database.db.query<T>(sql, params)).rows;
const metrics = async (p: Publisher) => (await fetch(`http://127.0.0.1:${p.ports.app}/metrics`)).text();
const taskGate = () => logs.filter(l => l.event === 'task_gate').map(l => l.detail);
const registered = () => waitFor(() => rest.guild.length > 0);
const settle = (ms = 100) => new Promise(resolve => setTimeout(resolve, ms));

test('B5 명령 목록: 작업 레인을 열 때만 다섯 명령, 안내 문구와 이름이 맞음', () => {
  assert.equal(commandDefinitions(false), COMMAND_DEFINITIONS);
  assert.deepEqual(commandDefinitions(false, false, true).map(c => c.name), [...FOUNDATION_COMMANDS, ...TASK_COMMANDS]);
  assert.deepEqual([...TASK_COMMANDS], ['task', 'answer', 'task-status', 'task-cancel', 'task-release']);
  for (const definition of TASK_COMMAND_DEFINITIONS) {
    assert.ok(definition.description.length <= 100, definition.name);
    assert.ok(ALL_COMMANDS.has(definition.name), definition.name);
  }
  const answer = TASK_COMMAND_DEFINITIONS.find(c => c.name === 'answer')!;
  // 질문 안내(/answer question:<id>)와 옵션 이름이 같아야 하고 답 길이는 2,000자다.
  assert.deepEqual(answer.options.map(o => [o.name, o.max_length]), [['question', 100], ['text', 2000]]);
  assert.deepEqual(TASK_COMMAND_DEFINITIONS.find(c => c.name === 'task')!.options.map(o => o.name), ['project', 'text']);
  for (const name of ['task-status', 'task-cancel', 'task-release']) assert.deepEqual(TASK_COMMAND_DEFINITIONS.find(c => c.name === name)!.options.map(o => o.name), ['target']);
  assert.match(taskLaneClosedText('unknown'), /\/task-release target:/);
});

test('B5 설정: 스위치가 없거나 false면 주소를 보지 않음, 켰는데 주소가 없거나 틀리면 기동 오류, 값은 오류에 없음', () => {
  assert.deepEqual([...TASK_KEYS], ['TASK_LANE_ENABLED', 'TASK_WORKER_URL']);
  assert.ok(!(ADDRESS_KEYS as readonly string[]).includes('TASK_WORKER_URL'), '필수 주소가 아니다');
  assert.equal(loadPublisherConfig(publisherEnv(), 1).taskLane, null);
  assert.equal(loadPublisherConfig(publisherEnv({ TASK_LANE_ENABLED: 'false', TASK_WORKER_URL: 'not a url' }), 1).taskLane, null);
  assert.deepEqual(loadPublisherConfig(publisherEnv({ TASK_LANE_ENABLED: 'true', TASK_WORKER_URL: 'http://worker-task.sandbox:8080' }), 1).taskLane, { workerUrl: 'http://worker-task.sandbox:8080' });
  const problems = (env: Record<string, string>) => { try { loadPublisherConfig(publisherEnv(env), 1); return []; } catch (error) { return (error as ConfigError).problems; } };
  assert.deepEqual(problems({ TASK_LANE_ENABLED: 'true' }), ['TASK_WORKER_URL(missing)']);
  assert.deepEqual(problems({ TASK_LANE_ENABLED: 'true', TASK_WORKER_URL: 'https://secret-host.example/' }), ['TASK_WORKER_URL(invalid)']);
  for (const value of ['', 'TRUE', '1', 'yes']) assert.deepEqual(problems({ TASK_LANE_ENABLED: value }), ['TASK_LANE_ENABLED(invalid)'], value);
});

test('B5 정책: 저장소·경로·명령 식별자·상한을 검사하고, 공개 값은 없음', () => {
  assert.equal(TaskPolicySchema.safeParse(TASK_POLICY).success, true);
  const project = TASK_POLICY.projects[0]!;
  const cases: Record<string, unknown>[] = [{ ...project, repository: '../evil' }, { ...project, branch: '../main' }, { ...project, base: BASE }, { ...project, branch: undefined },
    { ...project, allowedPaths: [] }, { ...project, allowedPaths: ['/etc'] }, { ...project, verifyCommands: ['rm -rf'] }, { ...project, limits: { files: 1_000_000 } }, { ...project, unknown: 1 }];
  for (const item of cases) assert.equal(TaskPolicySchema.safeParse({ projects: [item] }).success, false, JSON.stringify(item));
  assert.equal(TaskPolicySchema.safeParse({ projects: [{ ...project, branch: undefined, base: BASE }] }).success, true, '고정 SHA');
  assert.equal(TaskPolicySchema.safeParse({ projects: [project, project] }).success, false, '중복 ID');
  assert.equal(TaskPolicySchema.safeParse({ projects: [] }).success, false);
});

test('B5 호환(새 게시 서버 + 옛 작업자, 둘 다 새 + task off): 명령·루프·작업 HTTP가 모두 없다', async () => {
  // 정책에 task 절이 있어도 스위치가 없으면 닫힌다.
  const p = await boot({ policy: policyWith(TASK_POLICY), taskLane: null });
  await registered();
  assert.deepEqual(rest.names(), [...FOUNDATION_COMMANDS].sort());
  assert.deepEqual(taskGate(), [{ state: 'closed', reason: 'switch_off' }]);
  command('task', CHAT, { project: 'fixture', text: '고쳐줘' });
  command('answer', CHAT, { question: 'q', text: '답' });
  await settle();
  assert.equal((await rows('SELECT id FROM events')).length, 0, '수신에서 닫힌다');
  assert.deepEqual(sends.filter(s => s.url.includes('/v1/task')), []);
  assert.deepEqual(sends.filter(s => s.url.includes('api.github.com')), []);
  assert.doesNotMatch(await metrics(p), /homelab_bot_(lane_jobs|task_(?!gate_closed))/);
});

const gateLines = (text: string) => text.split('\n').filter(line => line.startsWith('homelab_bot_task_gate_closed'));
test('게이트 지표 꺼짐: 레인 지표는 없고 switch_off 줄만 1', async () => {
  const text = await metrics(await boot({}));
  assert.deepEqual(gateLines(text), ['homelab_bot_task_gate_closed{reason="switch_off"} 1', 'homelab_bot_task_gate_closed{reason="policy_invalid"} 0']);
  assert.doesNotMatch(text, /homelab_bot_(lane_jobs|task_lane_closed|task_worker_)/);
});
test('게이트 지표 켜짐·정책 틀림: 레인 지표는 없고 policy_invalid 줄만 1', async () => {
  const text = await metrics(await boot({ policy: policyWith({ projects: [] }), taskLane: { workerUrl: 'http://127.0.0.1:9/' } }));
  assert.deepEqual(gateLines(text), ['homelab_bot_task_gate_closed{reason="switch_off"} 0', 'homelab_bot_task_gate_closed{reason="policy_invalid"} 1']);
  assert.doesNotMatch(text, /homelab_bot_(lane_jobs|task_lane_closed|task_worker_)/);
});
test('게이트 지표 켜짐·정책 맞음: 작업자 대기 중에도, 열린 뒤에도 모두 0이고 레인 지표가 함께 나옴', async () => {
  let answering = false;
  const p = await boot({ policy: policyWith(TASK_POLICY), taskLane: { workerUrl: 'http://worker-task.fixture/' } }, async input =>
    new URL(String(input)).pathname === '/v1/task/intake' && answering
      ? Response.json({ version: 1, open: true, reasons: [], capabilities: { lanes: { task: true } } }) : new Response('OK'));
  const zero = ['homelab_bot_task_gate_closed{reason="switch_off"} 0', 'homelab_bot_task_gate_closed{reason="policy_invalid"} 0'];
  const waiting = await metrics(p);
  assert.deepEqual(gateLines(waiting), zero);
  assert.match(waiting, /homelab_bot_task_worker_routed 0/);
  answering = true;
  await waitFor(async () => (await metrics(p)).includes('homelab_bot_task_worker_intake_open 1'));
  assert.deepEqual(gateLines(await metrics(p)), zero);
  assert.match(await metrics(p), /homelab_bot_task_lane_closed\{reason="unknown"\} 0/);
});

test('B5 닫힘: task 절이 없거나 틀리면 작업 레인만 닫히고 작업자에 묻지 않음', async () => {
  assert.deepEqual(taskPrecondition({ taskLane: { workerUrl: 'http://x/' }, policy: policyWith(undefined) }), { open: false, reason: 'policy_invalid' });
  assert.deepEqual(taskPrecondition({ taskLane: { workerUrl: 'http://x/' }, policy: policyWith({ projects: [] }) }), { open: false, reason: 'policy_invalid' });
  assert.deepEqual(taskPrecondition({ taskLane: null, policy: policyWith(TASK_POLICY) }), { open: false, reason: 'switch_off' });
  await boot({ policy: policyWith({ projects: [] }), taskLane: { workerUrl: 'http://127.0.0.1:9/' } });
  await registered();
  await settle();
  assert.deepEqual(rest.names(), [...FOUNDATION_COMMANDS].sort());
  assert.deepEqual(sends.filter(s => s.url.includes('/v1/task')), []);
  assert.deepEqual(taskGate(), [{ state: 'closed', reason: 'policy_invalid' }]);
});

test('B5 작업자 확인: 작업 모드로 답할 때만 열림. 옛 이미지 404·연결 실패·능력표 없음은 닫힘', async () => {
  const signal = new AbortController().signal;
  const send = (status: number, body: unknown): typeof fetch => async () => new Response(JSON.stringify(body), { status });
  const good = { version: 1, open: true, reasons: [], capabilities: { lanes: { task: true } } };
  assert.deepEqual(await taskWorkerIntake('http://w/', send(200, good), signal), { routed: true, open: true, reasons: [] });
  assert.deepEqual(await taskWorkerIntake('http://w/', send(200, { ...good, open: false, reasons: ['volume_low'] }), signal), { routed: true, open: false, reasons: ['volume_low'] });
  for (const [status, body] of [[404, {}], [503, {}], [401, good], [200, {}], [200, { ...good, capabilities: { lanes: { task: false } } }]] as const) {
    assert.equal((await taskWorkerIntake('http://w/', send(status, body), signal)).routed, false, `${status}`);
  }
  assert.equal((await taskWorkerIntake('http://w/', async () => { throw new TypeError('fetch failed'); }, signal)).routed, false);
});

test('B5 호환(게시 서버 gate on + 옛 작업자 이미지): 명령을 열지 않고 실행을 보내지 않음', async () => {
  const old: Server = createServer((_req, res) => { res.writeHead(404).end(); });
  old.listen(0, '127.0.0.1'); await once(old, 'listening');
  try {
    await boot({ policy: policyWith(TASK_POLICY), taskLane: { workerUrl: `http://127.0.0.1:${(old.address() as AddressInfo).port}/` } });
    await registered();
    await waitFor(() => sends.some(s => s.url.endsWith('/v1/task/intake')));
    await settle(150);
    assert.deepEqual(rest.names(), [...FOUNDATION_COMMANDS].sort());
    assert.deepEqual(sends.filter(s => s.method === 'POST' && s.url.includes('/v1/task')), []);
  } finally { old.closeAllConnections(); old.close(); }
});

test('AC-32·AC-42 한도 뒤 API 사용 스위치가 꺼져 있으면 지원 확인조차 보내지 않고, 켜도 두 작업자가 새 판을 알리지 않으면 열리지 않는다', async () => {
  const old: Server = createServer((_req, res) => { res.writeHead(404).end(); });
  old.listen(0, '127.0.0.1'); await once(old, 'listening');
  const taskLane = { workerUrl: `http://127.0.0.1:${(old.address() as AddressInfo).port}/` };
  const gateLog = () => logs.filter(l => l.event === 'method_routing_gate').map(l => l.detail);
  try {
    await boot({ policy: policyWith(TASK_POLICY), taskLane });
    await registered();
    await waitFor(() => sends.some(s => s.url.endsWith('/v1/task/intake')));
    await settle(150);
    assert.deepEqual(gateLog(), [{ state: 'closed' }]);
    assert.deepEqual(sends.filter(s => s.url.includes('/v1/contracts')), []);
    await publisher!.stop(); publisher = undefined; logs = []; sends = [];
    await boot({ policy: { ...policyWith(TASK_POLICY), apiAfterLimit: true }, taskLane });
    await registered();
    await waitFor(() => sends.some(s => s.url.endsWith('/v1/contracts')));
    await settle(150);
    assert.deepEqual(gateLog(), [{ state: 'waiting_worker' }]);
  } finally { old.closeAllConnections(); old.close(); }
});

test('B5 수직 흐름(둘 다 새 + gate on): /task → needs_input → /answer → 같은 세션 resume → completed → 세션 정리, 작업 중에도 대화는 돎', async () => {
  worker = await workerFixture();
  const keys = generateKeyPairSync('ed25519');
  // 게시 서버 키와 짝인 공개 키로 작업자를 다시 띄운다.
  worker.env.WORKER_CONTROL_PUBLIC_KEY = keys.publicKey.export({ type: 'spki', format: 'pem' }).toString();
  await worker.restart();
  await worker.script([QUESTION, { ...COMPLETED, write: { 'src/app.txt': 'two\n' } }]);
  const p = await boot({ policy: policyWith(TASK_POLICY), taskLane: { workerUrl: `${worker.url}/` }, workerKey: keys.privateKey });
  await waitFor(() => rest.names().includes('task'));
  assert.deepEqual(rest.names(), [...FOUNDATION_COMMANDS, ...TASK_COMMANDS].sort());
  await waitFor(async () => (await metrics(p)).includes('homelab_bot_task_worker_intake_open 1'));
  assert.deepEqual(taskGate().at(-1), { state: 'open' });
  command('task', CHAT, { project: 'fixture', text: '실패하는 시험을 고쳐줘' });
  await waitFor(() => rest.threads.length === 1);
  const channel = rest.threads[0]!;
  await waitFor(() => rest.threadText(channel).includes(T.taskQuestion));
  const [job] = await rows<{ id: string; state: string; wait_reason: string }>(`SELECT id,state,wait_reason FROM jobs WHERE type='task'`);
  assert.deepEqual([job!.state, job!.wait_reason], ['waiting_user', 'clarification']);
  const text = rest.threadText(channel);
  const question = /질문 ID: ([^)]+)\)/.exec(text)![1]!;
  assert.match(text, new RegExp(`/answer question:${question.replaceAll('-', '\\-')}`));
  // 기준 SHA는 브랜치 머리이고 세션에 고정된다. 턴 사이에 머리가 움직여도 재개는 같은 값이다.
  const [session] = await rows<{ base_sha: string; repository: string; claude_session_id: string; turn: number }>('SELECT base_sha,repository,claude_session_id,turn FROM codex_sessions');
  assert.deepEqual([session!.base_sha, session!.repository], [BASE, 'fixture-org/fixture-repo']);
  assert.equal(sends.filter(s => s.url === 'https://api.github.com/repos/fixture-org/fixture-repo/commits/main' && !s.auth).length, 1);
  assert.deepEqual(worker.archiveUrls, [`https://codeload.github.com/fixture-org/fixture-repo/tar.gz/${BASE}`]);
  // 대기 중에는 슬롯을 놓는다.
  const metric = await metrics(p);
  assert.match(metric, /homelab_bot_lane_jobs\{lane="task",state="waiting_user"\} 1/);
  assert.match(metric, /homelab_bot_task_sessions_retained 1/);
  command('answer', channel, { question, text: 'src/app.txt 하나만' });
  await waitFor(() => rest.threadText(channel).includes(T.taskCompleted(false, job!.id)));
  const calls = await worker.calls();
  assert.equal(calls.length, 2);
  assert.ok(calls[0]!.args.includes('--session-id') && !calls[0]!.resume);
  assert.ok(calls[1]!.resume, '같은 세션 재개');
  assert.equal(calls[1]!.session, calls[0]!.session);
  assert.equal(calls[1]!.cwd, calls[0]!.cwd);
  assert.equal(calls[1]!.config, calls[0]!.config);
  assert.match(calls[1]!.input, /src\/app\.txt 하나만/);
  assert.equal(calls[1]!.scrub, '1');
  assert.match(rest.threadText(channel), /변경 파일\(작업자 diff 기준\): 1개/);
  assert.match(rest.threadText(channel), /미실행 1/);
  const [done] = await rows<{ state: string }>(`SELECT state FROM jobs WHERE type='task'`);
  assert.equal(done!.state, 'succeeded');
  // 결과를 남긴 뒤 세션 공간을 지운다. 레인은 열려 있다.
  await waitFor(async () => (await rows<{ cleanup_state: string }>('SELECT cleanup_state FROM codex_sessions'))[0]!.cleanup_state === 'cleaned');
  await assert.rejects(lstat(join(worker.root, 'tasks', job!.id)));
  assert.equal((await laneRow(database.db)).closed_reason, null);
  assert.match(await metrics(p), /homelab_bot_task_sessions_retained 0/);
  // 작업 레인의 턴 중에도 대화 레인이 돈다. 작업이 끝나지 않는 동안 /urgent 작업이 처리된다(대역 작업자는 거부).
  await worker.script([{ kind: 'hang' }]);
  command('task', CHAT, { project: 'fixture', text: '오래 걸리는 작업' });
  await waitFor(async () => (await rows(`SELECT id FROM jobs WHERE type='task' AND state='running'`)).length === 1 && (await worker!.calls()).length === 3);
  command('urgent', channel, { text: '지금 상태?' });
  await waitFor(async () => (await rows(`SELECT id FROM jobs WHERE type='chat' AND state NOT IN ('queued','running')`)).length === 1);
  const [running] = await rows<{ id: string }>(`SELECT id FROM jobs WHERE type='task' AND state='running'`);
  await waitFor(() => rest.threads.length === 2);
  command('task-cancel', rest.threads[1]!, { target: running!.id });
  await waitFor(async () => (await rows<{ state: string }>('SELECT state FROM jobs WHERE id=$1', [running!.id]))[0]!.state === 'cancelled');
});

// 게시 서버 진입점 없이 수신 경로만. 처리기를 실제 TaskCommands로 조립한다.
async function wired(project: unknown = TASK_POLICY, intake: { routed: boolean; open: boolean; reasons: string[] } = { routed: true, open: true, reasons: [] }) {
  const f = await storeFixture(database.db);
  (f.policy as { task?: unknown }).task = project;
  const local = lane(f);
  const background: Promise<void>[] = [];
  const handler = new TaskCommands(f.store, f.gate, local.bridge, () => intake, task => background.push(task), () => {});
  const acks: { id: string; content: string }[] = [];
  const realAck = f.rest.acknowledge.bind(f.rest);
  (f.rest as MockDiscord).acknowledge = async (e, content, options) => { acks.push({ id: e.id, content }); return realAck(e, content, options); };
  const ingress = new DiscordIngress(f.store, f.gate, f.rest, true, ALL_COMMANDS, () => {}, undefined, handler);
  return { f, local, ingress, acks, background, handler };
}
const CHANNEL = { guild: 'fixture-guild', channel: 'fixture-chat', parent: null, kind: 'channel' } as const;
const task = (id: string, overrides = {}) => event(id, { kind: 'command', command: 'task', target: 'fixture', text: '고쳐줘', ...overrides });
const outbox = async () => rows<{ payload: { content: string; kind: string } }>('SELECT payload FROM outbox ORDER BY created_at,id');

test('B5 /task 접수: 정책에 없는 프로젝트는 안내만 하고 작업·스레드를 만들지 않음. 필수 옵션 없으면 거부', async () => {
  const { ingress, acks } = await wired();
  await ingress.receive(task('t1', { target: 'other', scope: CHANNEL }));
  assert.match(acks[0]!.content, /정책에 없는 프로젝트.*받는 프로젝트: fixture/);
  assert.deepEqual(await rows('SELECT id FROM jobs'), []);
  assert.deepEqual(await outbox(), []);
  assert.equal((await rows<{ accepted: boolean }>('SELECT accepted FROM events'))[0]!.accepted, true);
  await assert.rejects(ingress.receive(task('t2', { target: undefined })), Denied);
  await assert.rejects(ingress.receive(task('t3', { text: '  ' })), Denied);
});

for (const reason of ['unknown', 'cleanup_pending', 'retention_full']) {
  test(`B5 접수 닫힘(${reason}): LaneClosed 사유로 안내하고 빈 스레드·작업을 만들지 않음`, async () => {
    const { ingress, acks } = await wired();
    await database.db.query(`UPDATE execution_lanes SET closed_reason=$1,closed_at=1 WHERE lane='task'`, [reason]);
    await ingress.receive(task('t1', { scope: CHANNEL }));
    assert.equal(acks[0]!.content, taskLaneClosedText(reason));
    assert.deepEqual([(await rows('SELECT id FROM jobs')).length, (await outbox()).length], [0, 0]);
  });
}

test('B5 접수 경합: admit 뒤 레인이 닫혀도 accept의 LaneClosed를 받아 안내하고 수신은 멀쩡함', async () => {
  const { f } = await wired();
  // 호출자의 트랜잭션 안이다. 같은 연결로 닫아 admit과 accept 사이에 닫힌 경우를 만든다.
  const closing = { admit: async (store: Store) => { await store.db.query(`UPDATE execution_lanes SET closed_reason='unknown',closed_at=1 WHERE lane='task'`); return null; } };
  const acks: string[] = [];
  const realAck = f.rest.acknowledge.bind(f.rest);
  (f.rest as MockDiscord).acknowledge = async (e, content, options) => { acks.push(content); return realAck(e, content, options); };
  const ingress = new DiscordIngress(f.store, f.gate, f.rest, true, ALL_COMMANDS, () => {}, undefined, closing as never);
  await ingress.receive(task('race-thread'));
  assert.equal(acks[0], taskLaneClosedText('unknown'));
  assert.deepEqual(await rows('SELECT id FROM jobs'), []);
  const [row] = await rows<{ accepted: boolean; payload: { ignored?: string } }>('SELECT accepted,payload FROM events');
  assert.deepEqual([row!.accepted, row!.payload.ignored], [true, 'task_refused']);
});

test('B5 스레드 경합: 스레드를 만드는 사이 레인이 닫히면 그 스레드에 이유를 남기고 전달은 sent로 끝남', async () => {
  const { f, ingress } = await wired();
  await ingress.receive(task('t1', { scope: CHANNEL }));
  await database.db.query(`UPDATE execution_lanes SET closed_reason='cleanup_pending',closed_at=1 WHERE lane='task'`);
  await f.publisher.deliver();
  assert.deepEqual(await rows('SELECT id FROM jobs'), []);
  const states = await rows<{ state: string; payload: { content: string; kind: string } }>('SELECT state,payload FROM outbox ORDER BY created_at,id');
  assert.equal(states.find(row => row.payload.kind === 'thread')!.state, 'sent');
  assert.equal(states.find(row => row.payload.kind === 'message')!.payload.content, taskLaneClosedText('cleanup_pending'));
  await f.publisher.deliver();
  assert.equal(f.rest.messages.at(-1)!.body.content.startsWith(taskLaneClosedText('cleanup_pending')), true);
});

test('B5 복구 경합: gap 중 버퍼된 /task가 복구될 때 닫혀 있으면 대화에 안내를 게시', async () => {
  const { f, ingress } = await wired();
  await ingress.receive(event('m0', { kind: 'command', command: 'chat', text: '시작' }));
  await database.db.query('UPDATE conversations SET gap=true');
  await ingress.receive(task('buffered'));
  assert.deepEqual((await rows<{ buffered: boolean }>(`SELECT buffered FROM events WHERE delivery_id='buffered'`))[0]!.buffered, true);
  await database.db.query(`UPDATE execution_lanes SET closed_reason='retention_full',closed_at=1 WHERE lane='task'`);
  await database.db.query('UPDATE conversations SET gap=false');
  const acked = f.rest.acks.length;
  await ingress.receive(task('buffered'), true);
  assert.equal(f.rest.acks.length, acked, '복구 중에는 상호작용 응답이 없다');
  assert.ok((await outbox()).some(row => row.payload.content === taskLaneClosedText('retention_full')));
  assert.equal((await rows(`SELECT id FROM jobs WHERE type='task'`)).length, 0);
});

test('B5 작업자 수락 닫힘: 사유와 함께 받지 않음', async () => {
  const { ingress, acks } = await wired(TASK_POLICY, { routed: true, open: false, reasons: ['volume_low'] });
  await ingress.receive(task('t1'));
  assert.match(acks[0]!.content, /volume_low/);
  assert.deepEqual(await rows('SELECT id FROM jobs'), []);
});

test('B5 /answer: 수신 트랜잭션 안에서 답을 확정하고 같은 세션을 재개, 다른 대화·너무 긴 답·중복은 막음', async () => {
  const { local, ingress } = await wired();
  local.worker.scripts.push(reply.question());
  await ingress.receive(task('t1'));
  await local.runtime.tickTask();
  const [q] = await rows<{ id: string }>('SELECT id FROM codex_questions');
  // 다른 대화의 질문은 존재를 알리지 않고 Denied다. 답 쓰기 전체가 되돌려진다.
  const other = { ...thread, channel: 'fixture-other-thread' };
  await ingress.receive(event('other', { kind: 'command', command: 'chat', scope: other, text: '다른 대화' }));
  await assert.rejects(ingress.receive(event('a0', { kind: 'command', command: 'answer', target: q!.id, text: '답', scope: other })), Denied);
  assert.equal((await rows<{ state: string }>('SELECT state FROM codex_questions'))[0]!.state, 'open');
  // 2,000자 초과는 질문을 닫지 않고 안내한다.
  await ingress.receive(event('a1', { kind: 'command', command: 'answer', target: q!.id, text: 'x'.repeat(2001) }));
  assert.equal((await rows<{ state: string }>('SELECT state FROM codex_questions'))[0]!.state, 'open');
  assert.ok((await outbox()).some(row => row.payload.content === T.controlFailed(false, T.answerInvalid)));
  await ingress.receive(event('a2', { kind: 'command', command: 'answer', target: q!.id, text: '메인 기준으로' }));
  const [answered] = await rows<{ state: string; answer: string; answer_event: string }>('SELECT state,answer,answer_event FROM codex_questions');
  assert.deepEqual([answered!.state, answered!.answer, answered!.answer_event], ['answered', '메인 기준으로', 'a2']);
  assert.ok((await outbox()).some(row => row.payload.content === T.taskAnswerAccepted));
  // 같은 상호작용 재전달은 그대로 끝난다.
  await ingress.receive(event('a2', { kind: 'command', command: 'answer', target: q!.id, text: '메인 기준으로' }));
  assert.equal((await rows(`SELECT id FROM jobs WHERE state='queued' AND type='task'`)).length, 1);
  local.worker.scripts.push(reply.completed());
  await local.runtime.tickTask();
  assert.equal(local.worker.executes.at(-1)!.operation, 'resume');
  const resumed = local.worker.executes.at(-1)! as { untrusted?: { answer: string } };
  assert.equal(resumed.untrusted!.answer, '메인 기준으로');
});

test('B5 /task-status·/task-cancel: 이 대화의 작업만, 대화 작업은 건드리지 않음', async () => {
  const { local, ingress, acks } = await wired();
  local.worker.scripts.push(reply.question());
  await ingress.receive(task('t1'));
  await local.runtime.tickTask();
  const job = (await jobs(database.db))[0]!;
  await ingress.receive(event('s1', { kind: 'command', command: 'task-status', target: job.id }));
  const status = acks.find(a => a.id === 's1')!.content;
  assert.match(status, /확인 기다림\(질문 답 기다림\)/);
  assert.match(status, /열린 질문/);
  assert.match(status, /세대 1/);
  // 다른 대화에서는 존재를 구별해 알리지 않는다.
  const other = { ...thread, channel: 'fixture-other-thread' };
  await ingress.receive(event('o1', { kind: 'command', command: 'chat', scope: other, text: '다른 대화' }));
  await ingress.receive(event('s2', { kind: 'command', command: 'task-status', target: job.id, scope: other }));
  assert.equal(acks.find(a => a.id === 's2')!.content, '이 대화에서 볼 수 있는 작업이 아니에요.');
  // 대화 작업은 /task-cancel로 건드리지 않는다.
  const chat = (await jobs(database.db)).find(row => row.type === 'chat')!;
  await ingress.receive(event('c0', { kind: 'command', command: 'task-cancel', target: chat.id, scope: other }));
  assert.equal((await rows<{ state: string }>('SELECT state FROM jobs WHERE id=$1', [chat.id]))[0]!.state, 'queued');
  await ingress.receive(event('c1', { kind: 'command', command: 'task-cancel', target: job.id }));
  assert.equal((await rows<{ state: string }>('SELECT state FROM jobs WHERE id=$1', [job.id]))[0]!.state, 'cancelled');
  assert.ok((await outbox()).some(row => row.payload.content === T.cancelRequested));
  // 재전달은 한 번만 처리한다(상호작용 응답도 한 번).
  const before = acks.length;
  await ingress.receive(event('s1', { kind: 'command', command: 'task-status', target: job.id }));
  assert.equal(acks.length, before);
});

test('B5 /task-release: 먼저 답하고 소멸 확인 결과를 대화에 게시, 확인 전에는 레인이 그대로 닫힘', async () => {
  const { local, ingress, acks, background } = await wired();
  local.worker.scripts.push(reply.unknown());
  local.worker.stopped = false;
  await ingress.receive(task('t1'));
  await local.runtime.tickTask();
  const job = (await jobs(database.db))[0]!;
  assert.equal(job.state, 'unknown');
  assert.equal((await laneRow(database.db)).closed_reason, 'unknown');
  await ingress.receive(event('r1', { kind: 'command', command: 'task-release', target: job.id }));
  assert.equal(acks.find(a => a.id === 'r1')!.content, T.releaseStarted);
  await Promise.all(background);
  assert.ok((await outbox()).some(row => row.payload.content === T.releaseFailed(false, job.id, T.releaseWorkerAlive)));
  assert.equal((await laneRow(database.db)).closed_reason, 'unknown', '확인하지 못하면 닫힌 채');
  local.worker.stopped = true;
  await ingress.receive(event('r2', { kind: 'command', command: 'task-release', target: job.id }));
  await Promise.all(background);
  assert.ok((await outbox()).some(row => row.payload.content === T.releaseDone(false, job.id, T.releaseConfirmed)));
  assert.equal((await rows<{ state: string }>('SELECT state FROM jobs WHERE id=$1', [job.id]))[0]!.state, 'cancelled');
  assert.equal((await laneRow(database.db)).closed_reason, null);
  // 남의 대화에서는 Denied 문구만.
  const other = { ...thread, channel: 'fixture-other-thread' };
  await ingress.receive(event('o1', { kind: 'command', command: 'chat', scope: other, text: '다른 대화' }));
  await ingress.receive(event('r3', { kind: 'command', command: 'task-release', target: job.id, scope: other }));
  await Promise.all(background);
  assert.ok((await outbox()).some(row => row.payload.content === T.releaseNotFound));
});

test('B5 처리기 없음: 스위치를 끈 수신은 작업 제어를 닫고, 처리기 없는 /task는 지금 경로 그대로', async () => {
  const f = await storeFixture(database.db);
  for (const command of ['answer', 'task-status', 'task-cancel', 'task-release']) {
    await assert.rejects(f.ingress.receive(event(`x-${command}`, { kind: 'command', command, target: 'x' })), Denied, command);
  }
  await f.ingress.receive(event('legacy', { kind: 'command', command: 'task', text: '기존 경로' }));
  assert.equal((await rows<{ type: string }>('SELECT type FROM jobs'))[0]!.type, 'task');
});

test('B5 HTTP 포트: 400·401·403·409 거부와 연결 전 실패만 TaskWorkerRejected, 503·끊김·깨진 응답은 재전송 없이 불명', async () => {
  const keys = generateKeyPairSync('ed25519');
  const signer = new TaskWorkerSigner(keys.privateKey);
  let calls = 0;
  const port = (respond: () => Response | Promise<Response>) => new HttpTaskWorker('http://worker-task.fixture:8080/', signer, async () => { calls++; return respond(); });
  const body = TASK_ENDPOINTS['/v1/task'].request.parse(startRequest());
  const rejection = JSON.stringify({ status: 'rejected', started: false });
  for (const status of [400, 401, 403, 409]) {
    await assert.rejects(port(() => new Response(rejection, { status })).call('/v1/task', body), TaskWorkerRejected, String(status));
    // 모양이 다른 거부 응답은 미시작의 증거가 아니다.
    await assert.rejects(port(() => new Response('{}', { status })).call('/v1/task', body), /task_worker_uncertain/, String(status));
  }
  await assert.rejects(port(() => new Response(rejection, { status: 503 })).call('/v1/task', body), /task_worker_uncertain/);
  await assert.rejects(port(() => new Response(rejection, { status: 500 })).call('/v1/task', body), /task_worker_uncertain/);
  const before = calls;
  await assert.rejects(port(() => new Response('깨진', { status: 200 })).call('/v1/task', body), error => !(error instanceof TaskWorkerRejected));
  await assert.rejects(port(() => { throw new TypeError('fetch failed', { cause: Object.assign(new Error('reset'), { code: 'ECONNRESET' }) }); }).call('/v1/task', body), error => !(error instanceof TaskWorkerRejected));
  assert.equal(calls - before, 2, '재전송 없음');
  await assert.rejects(port(() => { throw new TypeError('fetch failed', { cause: Object.assign(new Error('refused'), { code: 'ECONNREFUSED' }) }); }).call('/v1/task', body), TaskWorkerRejected);
  // 발급한 capability는 파싱한 본문 digest에 묶이고 작업자 검증을 지난다.
  let seen: { token: string; payload: string } | undefined;
  const capture = new HttpTaskWorker('http://worker-task.fixture:8080/', signer, async (_url, init) => {
    seen = { token: new Headers(init!.headers).get('authorization')!.slice(11), payload: String(init!.body) };
    return new Response('{}', { status: 200 });
  });
  await capture.call('/v1/task', { ...body, turn: 1 });
  const verifier = new TaskWorkerVerifier(keys.publicKey, async () => true);
  await verifier.check(seen!.token, 'task_execute', TASK_ENDPOINTS['/v1/task'].request.parse(JSON.parse(seen!.payload)) as never);
  assert.throws(() => new HttpTaskWorker('https://worker-task.fixture/', signer, fetch), /invalid_worker_service/);
  assert.throws(() => new HttpTaskWorker('http://user:pass@worker-task.fixture/', signer, fetch), /invalid_worker_service/);
});

test('B5 기준 SHA: 브랜치 머리를 자격 없이 읽고, 대기 세션은 고정값, 고정 base는 GitHub에 묻지 않음, 실패는 그 작업만 끝냄', async () => {
  const f = await storeFixture(database.db);
  const store: Store = f.store;
  let asked: { url: string; init: RequestInit } | undefined;
  const send: typeof fetch = async (url, init) => { asked = { url: String(url), init: init! }; return new Response(`${BASE}\n`); };
  const plans = new PolicyTaskPlans(store, send);
  await f.ingress.receive(task('t1'));
  const job = (await jobs(database.db))[0]! as unknown as Job;
  const policy = { ...f.policy, task: TASK_POLICY };
  const plan = await plans.plan(job, policy);
  assert.equal(plan.base, BASE);
  assert.equal(plan.repository, 'fixture-org/fixture-repo');
  assert.deepEqual(plan.project, { id: 'fixture', revision: 'r1', allowedPaths: ['src'], forbiddenPaths: [], verifyCommands: ['unit'] });
  assert.equal(asked!.url, 'https://api.github.com/repos/fixture-org/fixture-repo/commits/main');
  assert.equal(new Headers(asked!.init.headers).get('accept'), 'application/vnd.github.sha');
  assert.equal(new Headers(asked!.init.headers).has('authorization'), false);
  assert.equal(asked!.init.redirect, 'error');
  // 대기 세션이면 머리가 움직여도 세션 값이다.
  await database.db.query(`INSERT INTO codex_sessions(job_id,thread_id,turn,tool_calls,host,repository,capabilities,state,created_at,updated_at,executor,claude_session_id,generation,worker_lease,
    base_sha,policy_revision,project_id,project_revision,turn_timeout_ms,run_budget_ms) VALUES ($1,$2,1,0,'worker-task','fixture-org/fixture-repo','{}','waiting_answer',1,1,'claude',$2,1,$2,$3,'fixture-v1','fixture','r1',1000,1000)`,
  [job.id, randomUUID(), 'd'.repeat(40)]);
  asked = undefined;
  assert.equal((await plans.plan(job, policy)).base, 'd'.repeat(40));
  assert.equal(asked, undefined);
  await database.db.query(`UPDATE codex_sessions SET state='failed'`);
  const pinned = { ...f.policy, task: { projects: [{ ...TASK_POLICY.projects[0]!, branch: undefined, base: 'e'.repeat(40), limits: { files: 5 } }] } };
  const fixed = await plans.plan(job, pinned);
  assert.deepEqual([fixed.base, fixed.limits.files], ['e'.repeat(40), 5]);
  assert.equal(asked, undefined);
  await assert.rejects(plans.plan(job, { ...f.policy, task: { projects: [{ ...TASK_POLICY.projects[0]!, id: 'other' }] } }), /task_project_missing/);
  for (const respond of [() => new Response('', { status: 404 }), () => new Response('not a sha')]) {
    await assert.rejects(branchHead(async () => respond(), 'fixture-org/fixture-repo', 'main'), /task_base_unavailable/);
  }
});

test('B5 능력표: 작업 레인 능력이 실제 경로와 맞고, 프로필에 작업 능력이 표시됨', async () => {
  assert.deepEqual({ ...CLAUDE_TASK_LANE_CAPABILITIES }, { adapter: 'claude-print', start_task: true, answer_question: 'clarification_only', request_cancel: true,
    read_status: true, read_final_result: true, confirm_stop: 'pod_pid_space', resume_task: 'same_job_session_only', tool_approval_relay: false, attach_task: false, read_events: false });
  const { PROFILES } = await import('../src/executor-profiles.js');
  assert.deepEqual(PROFILES.map(p => [p.id, p.capabilities.lanes.task, p.taskCapabilities?.lanes.task ?? null]), [['claude-subscription', false, true], ['codex-subscription', false, null]]);
});
