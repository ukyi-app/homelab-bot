import { after, before, beforeEach, test } from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { once } from 'node:events';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { changePrecondition, changeTaskPathsMatch } from '../src/change-assembly.js';
import { parseChangeRequest } from '../src/change-commands.js';
import { CHANGE_RETENTION_MS, purgeExpiredChangeContent } from '../src/change-store.js';
import { CHANGE_COMMANDS, FOUNDATION_COMMANDS, commandDefinitions } from '../src/commands.js';
import { ConfigError, loadPublisherConfig } from '../src/config.js';
import type { PublisherConfig } from '../src/config.js';
import type { Job } from '../src/contracts.js';
import type { Database } from '../src/database.js';
import type { DiscordApi } from '../src/discord-protocol.js';
import { startPublisher } from '../src/main.js';
import type { Publisher } from '../src/main.js';
import { loadRuntimePolicy } from '../src/policy.js';
import { createGitHubWriter } from '../src/github-writer.js';
import { TaskWorkerBusy } from '../src/task-bridge.js';
import { FakeGateway, until } from './fake-gateway.js';
import { FAKE_APP_KEY, REPO, repositoryPolicy } from './change-github-fake.js';
import { OTHER_THREAD, REQUEST_TEXT, THREAD, WRITE_STEP, bwrapReady, changeHarness } from './change-assembly-harness.js';
import type { Harness } from './change-assembly-harness.js';
import { OWNER } from './change-store-fixture.js';
import { localDatabase } from './helpers.js';
import { QUESTION } from './task-worker-harness.js';

// T19 B5 조립 시험. 실제 Discord·GitHub·모델·클러스터에 닿지 않는다. 값은 모두 합성이다.
let database: Awaited<ReturnType<typeof localDatabase>>;
before(async () => { database = await localDatabase(); });
after(async () => { await database.pg.close(); });
beforeEach(async () => {
  const tables = (await database.pg.query<{ tablename: string }>("SELECT tablename FROM pg_tables WHERE schemaname='public' AND tablename<>'schema_migrations'")).rows.map(row => row.tablename);
  await database.pg.exec(`TRUNCATE ${tables.join(',')} RESTART IDENTITY CASCADE`);
  await database.pg.exec(`INSERT INTO execution_lanes(lane) VALUES ('interactive'), ('task') ON CONFLICT DO NOTHING`);
});
async function withHarness(options: Parameters<typeof changeHarness>[1], run: (h: Harness) => Promise<void>) {
  const h = await changeHarness(database.db, options);
  try { await run(h); } finally { await h.close(); }
}
const childOf = async (db: Database, id: string, role = 'author') => (await db.query<Job & { state: string; wait_reason: string | null; id: string }>(`SELECT j.* FROM jobs j JOIN change_child_jobs c ON c.job_id=j.id WHERE c.change_id=$1 AND c.role=$2`, [id, role])).rows[0];
const digestOf = async (h: Harness, id: string) => (await h.db.query<{ approval_digest: string }>('SELECT approval_digest FROM change_approval_subjects WHERE change_id=$1', [id])).rows[0]!.approval_digest;
const toAwaiting = async (h: Harness, id = '100') => {
  await h.command(id, 'change', { target: REPO.fullName, text: REQUEST_TEXT });
  const change = await h.changeId();
  await h.pump(async () => await h.phase(change) === 'awaiting_publish_approval');
  return change;
};
const toProposed = async (h: Harness, event = '100') => {
  const change = await toAwaiting(h, event);
  await h.command(`${event}p`, 'change-publish', { target: change, text: await digestOf(h, change) });
  await h.pump(async () => await h.phase(change) === 'proposed');
  return change;
};

// ---- 호환 ----

const baseEnv = (extra: Record<string, string> = {}): Record<string, string> => ({
  DATABASE_URL: 'postgresql://fixture', DISCORD_BOT_TOKEN: 'fixture-token', GRAFANA_READER_TOKEN: 'fixture-grafana', HEALTHCHECKS_PING_URL: 'https://fixture.invalid/ping',
  WORKER_CONTROL_PRIVATE_KEY: generateKeyPairSync('ed25519').privateKey.export({ type: 'pkcs8', format: 'pem' }) as string, GITHUB_REVIEW_WEBHOOK_SECRET: 'fixture-webhook-secret-value',
  WORKER_URL: 'http://worker.invalid/', GRAFANA_URL: 'http://grafana.invalid/', KUBERNETES_API_URL: 'https://kubernetes.invalid/',
  RUNTIME_POLICIES: JSON.stringify({ revision: 'fixture-v1', owner: OWNER, guild: 'fixture-guild', conversationChannel: 'fixture-chat', notificationChannel: 'fixture-notifications', dmEnabled: false, services: [] }), ...extra });
const problems = (env: Record<string, string>) => { try { loadPublisherConfig(env, 1); return []; } catch (error) { assert.ok(error instanceof ConfigError); return [...error.problems]; } };
const rsa = (generateKeyPairSync('rsa', { modulusLength: 2048 }).privateKey.export({ type: 'pkcs8', format: 'pem' }) as string).replaceAll('\n', '\\n');

test('호환 설정: 스위치가 없거나 false면 키를 읽지도 않는다. 잘못된 키 값이 있어도 기동한다', () => {
  assert.equal(loadPublisherConfig(baseEnv(), 1).changePr, null);
  assert.equal(loadPublisherConfig(baseEnv({ CHANGE_PR_ENABLED: 'false', GITHUB_WRITER_APP_ID: 'not-a-number', GITHUB_WRITER_APP_PRIVATE_KEY: 'not-a-key' }), 1).changePr, null);
});
test('호환 설정: 켰는데 키가 부족하면 CHANGE만 닫을 수 있게 기동하고, 값이 틀리면 값 없이 기동을 막는다', () => {
  assert.deepEqual(loadPublisherConfig(baseEnv({ CHANGE_PR_ENABLED: 'true' }), 1).changePr, { writerApp: null });
  assert.deepEqual(loadPublisherConfig(baseEnv({ CHANGE_PR_ENABLED: 'true', GITHUB_WRITER_APP_ID: '12345' }), 1).changePr, { writerApp: null });
  assert.deepEqual(problems(baseEnv({ CHANGE_PR_ENABLED: 'maybe' })), ['CHANGE_PR_ENABLED(invalid)']);
  assert.deepEqual(problems(baseEnv({ CHANGE_PR_ENABLED: 'true', GITHUB_WRITER_APP_ID: 'x', GITHUB_WRITER_APP_PRIVATE_KEY: 'y-secret-value' })), ['GITHUB_WRITER_APP_ID(invalid)', 'GITHUB_WRITER_APP_PRIVATE_KEY(invalid)']);
  assert.ok(loadPublisherConfig(baseEnv({ CHANGE_PR_ENABLED: 'true', GITHUB_WRITER_APP_ID: '12345', GITHUB_WRITER_APP_PRIVATE_KEY: rsa }), 1).changePr?.writerApp);
});
test('호환 정책: 키 없는 옛 정책이 그대로 통과하고, change 절이 틀리면 알려진 필드 경로만 남기고 막는다', () => {
  const base = { revision: 'fixture-v1', owner: OWNER, guild: 'g', conversationChannel: 'c', notificationChannel: 'n', dmEnabled: false, services: [] };
  assert.equal(loadRuntimePolicy(JSON.stringify(base), 1).change, undefined);
  const valid = loadRuntimePolicy(JSON.stringify({ ...base, change: { repositories: [repositoryPolicy()] } }), 1);
  assert.equal(valid.change?.repositories[0]?.repoId, REPO.id);
  assert.throws(() => loadRuntimePolicy(JSON.stringify({ ...base, change: { repositories: [] } }), 1), /change\.repositories/);
  assert.throws(() => loadRuntimePolicy(JSON.stringify({ ...base, change: { repositories: [{ ...repositoryPolicy(), secret_value: 'x' }] } }), 1), /unknown_field\(1\)/);
  assert.throws(() => loadRuntimePolicy(JSON.stringify({ ...base, change: { repositories: [repositoryPolicy(), repositoryPolicy()] } }), 1), /change\.repositories/);
  assert.throws(() => loadRuntimePolicy(JSON.stringify({ ...base, change: { repositories: [{ ...repositoryPolicy(), allowedPaths: ['**'] }] } }), 1), /change\.repositories/);
  // 묶음이 받지 않는 revision이면 모델을 돌린 뒤에야 막힌다.
  assert.throws(() => loadRuntimePolicy(JSON.stringify({ ...base, revision: 'has space', change: { repositories: [repositoryPolicy()] } }), 1), /revision/);
  assert.doesNotThrow(() => loadRuntimePolicy(JSON.stringify({ ...base, revision: 'has space' }), 1));
});
test('호환 조건: 사유마다 CHANGE만 닫힌다. 작업 정책과 writer 경로의 뜻이 다르면 연다고 하지 않는다', () => {
  const policy = loadRuntimePolicy(JSON.stringify({ revision: 'r', owner: OWNER, guild: 'g', conversationChannel: 'c', notificationChannel: 'n', dmEnabled: false, services: [], change: { repositories: [repositoryPolicy()] } }), 1);
  const open = { taskOpen: true, reviewOpen: true };
  const writerApp = { appId: '1', privateKey: FAKE_APP_KEY };
  assert.deepEqual(changePrecondition({ changePr: null, policy }, open), { open: false, reason: 'switch_off' });
  assert.deepEqual(changePrecondition({ changePr: { writerApp: null }, policy }, open), { open: false, reason: 'writer_key_missing' });
  assert.deepEqual(changePrecondition({ changePr: { writerApp }, policy: { ...policy, change: undefined } }, open), { open: false, reason: 'policy_missing' });
  assert.deepEqual(changePrecondition({ changePr: { writerApp }, policy }, { taskOpen: false, reviewOpen: true }), { open: false, reason: 'task_lane_closed' });
  assert.deepEqual(changePrecondition({ changePr: { writerApp }, policy }, { taskOpen: true, reviewOpen: false }), { open: false, reason: 'review_closed' });
  const project = (allowedPaths: string[]) => ({ projects: [{ id: 'p', revision: 'r', allowedPaths, forbiddenPaths: [], verifyCommands: [], repository: REPO.fullName, branch: 'main' }] });
  assert.equal(changeTaskPathsMatch({ ...policy, task: project(['src', 'tests', 'docs', 'README.md']) }), true);
  assert.equal(changeTaskPathsMatch({ ...policy, task: project(['src']) }), false);
  assert.deepEqual(changePrecondition({ changePr: { writerApp }, policy: { ...policy, task: project(['src']) } }, open), { open: false, reason: 'task_policy_mismatch' });
  assert.equal(changePrecondition({ changePr: { writerApp }, policy }, open).open, true);
});
test('호환 명령: 변경 명령은 스위치를 켠 목록에만 있고 Discord 설명 한도(100자) 안이다', () => {
  assert.deepEqual(commandDefinitions(false).map(item => item.name), [...FOUNDATION_COMMANDS]);
  const names = commandDefinitions(false, false, false, false, true);
  for (const name of CHANGE_COMMANDS) assert.ok(names.some(item => item.name === name), name);
  for (const item of names) { assert.ok(item.description.length <= 100, item.name); for (const option of item.options) assert.ok(option.description.length <= 100, `${item.name}.${option.name}`); }
});

class FakeRest implements DiscordApi {
  guildCommands: { name: string }[] = [];
  channels = new Map<string, { id: string; type: number; guild_id: string; parent_id?: string }>([['fixture-chat', { id: 'fixture-chat', type: 0, guild_id: 'fixture-guild' }], ['fixture-thread', { id: 'fixture-thread', type: 11, guild_id: 'fixture-guild', parent_id: 'fixture-chat' }]]);
  interactions: string[] = [];
  async request(method: 'GET' | 'POST' | 'PUT', path: string, body?: unknown): Promise<unknown> {
    const channel = /^\/channels\/([^/?]+)$/.exec(path);
    if (method === 'GET' && channel) return this.channels.get(decodeURIComponent(channel[1]!));
    if (method === 'POST' && path.startsWith('/interactions/')) { this.interactions.push((body as { data: { content: string } }).data.content); return undefined; }
    if (method === 'POST' && /\/messages$/.test(path)) return { id: 'fixture-message' };
    if (method === 'GET' && /\/messages\?/.test(path)) return [];
    if (path.endsWith('/guilds/fixture-guild/commands')) { if (method === 'PUT') this.guildCommands = body as { name: string }[]; return this.guildCommands; }
    if (path.endsWith('/commands')) return [];
    throw new Error(`unexpected_${method}_${path}`);
  }
}
// 진입점 그대로 띄운다. 작업자 대역은 v2 지원 여부만 답한다. 어떤 분기든 GitHub 호출과 writer 생성을 센다.
async function bootPublisher(overrides: Partial<PublisherConfig>, workers: { v2: boolean; reviewRoute: boolean } = { v2: false, reviewRoute: false }, policyExtra: Record<string, unknown> = {}, taskLane?: object) {
  const dir = await mkdtemp(join(tmpdir(), 'homelab-bot-b5-'));
  await writeFile(join(dir, 'token'), 'fixture-sa-token\n');
  const calls: string[] = [];
  const aux: Server = createServer((req, res) => {
    calls.push(`${req.method} ${req.url}`);
    if (req.url === '/ping') { res.writeHead(200).end('OK'); return; }
    if (req.url === '/v1/task/intake') {
      res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ version: 1, open: true, reasons: [], capabilities: { lanes: { task: true } }, ...(workers.v2 ? { change: { contract: 2, verifierRevision: 'x' } } : {}) }));
      return;
    }
    if (req.url === '/v1/review' || (req.url === '/v1/change-review' && workers.reviewRoute)) { res.writeHead(401).end(); return; }
    res.writeHead(404).end();
  });
  aux.listen(0, '127.0.0.1'); await once(aux, 'listening');
  const url = `http://127.0.0.1:${(aux.address() as AddressInfo).port}`;
  const gw = new FakeGateway(); gw.options.identifyIntervalMs = 250; await gw.start();
  const rest = new FakeRest();
  const logs: { event: string; fields: unknown }[] = [];
  const github: string[] = [];
  const send: typeof fetch = async (input, init) => {
    if (String(input).includes('api.github.com')) { github.push(String(input)); return new Response('{}', { status: 404 }); }
    return fetch(input, init);
  };
  let writers = 0;
  const config: PublisherConfig = { databaseUrl: 'postgresql://unused', discordToken: 'fixture-discord-token',
    policy: loadRuntimePolicy(JSON.stringify({ revision: 'fixture-v1', owner: OWNER, guild: 'fixture-guild', conversationChannel: 'fixture-chat', notificationChannel: 'fixture-notifications', dmEnabled: false, services: [], ...policyExtra }), Date.now()),
    grafana: { url, token: 'fixture-grafana-token' }, kubernetes: { url }, workerUrl: `${url}/`, healthchecksUrl: `${url}/ping`, workerKey: generateKeyPairSync('ed25519').privateKey, githubWebhookSecret: 'fixture-webhook-secret-value', ...(taskLane ? { taskLane: { workerUrl: `${url}/` } } : {}), ...overrides };
  const publisher: Publisher = await startPublisher(config, { db: database.db, send, discord: rest, gatewayUrl: async () => ({ url: gw.url }), allowGatewayUrl: target => target.hostname === '127.0.0.1', serviceAccount: { tokenFile: join(dir, 'token'), caFile: null },
    ports: { app: 0, alerts: 0 }, idleMs: 20, identifySpacingMs: 250, recoveryBackoff: () => 200, registerDelaysMs: [0, 20, 20], heartbeatEveryMs: 60_000, stopTimeoutMs: 3000, log: (event, fields) => { logs.push({ event, fields }); }, reviewWorkerProbeMs: 20, taskWorkerProbeMs: 20,
    change: { createWriter: options => { writers++; return createGitHubWriter(options); } } });
  await until(() => rest.guildCommands.length > 0, 6000);
  return { publisher, rest, gw, logs, github, calls, url, workers, writers: () => writers, async close() { await publisher.stop(); await gw.close(); aux.closeAllConnections(); aux.close(); await rm(dir, { recursive: true, force: true }); } };
}
const interaction = (id: string, name: string, options: Record<string, string> = {}, channel = 'fixture-thread') => ({ id, token: `fixture-token-${id}`, type: 2, channel_id: channel, guild_id: 'fixture-guild', member: { user: { id: OWNER } }, data: { name, options: Object.entries(options).map(([key, value]) => ({ name: key, value })) } });
const gate = (logs: { event: string; fields: unknown }[]) => logs.find(entry => entry.event === 'change_gate')?.fields;

test('호환 진입점: 스위치 false면 명령·writer·루프·GitHub 호출·변경 행이 모두 0이고 새 Secret 없이 뜬다', async () => {
  const b = await bootPublisher({ changePr: null });
  try {
    assert.deepEqual(b.rest.guildCommands.map(item => item.name).sort(), [...FOUNDATION_COMMANDS].sort());
    assert.deepEqual(gate(b.logs), { state: 'closed', reason: 'switch_off' });
    assert.equal(b.writers(), 0);
    await new Promise(resolve => setTimeout(resolve, 120));
    assert.deepEqual(b.github, []);
    assert.ok(!b.calls.some(call => call.includes('change-review') || call.includes('/v2/')), b.calls.join(','));
    assert.ok(!b.logs.some(entry => /^change_(lane|publish|reconcile|retention)/.test(entry.event)));
    // 등록하지 않은 명령은 수신에서 닫힌다. 행이 생기지 않는다.
    b.gw.dispatch(b.gw.latest, 2, 'INTERACTION_CREATE', interaction('901', 'change', { project: REPO.fullName, text: REQUEST_TEXT }));
    await new Promise(resolve => setTimeout(resolve, 80));
    assert.equal(Number((await database.db.query<{ count: string }>('SELECT count(*) FROM change_requests')).rows[0]!.count), 0);
  } finally { await b.close(); }
});
test('호환 진입점: 켰는데 키가 없으면 CHANGE만 닫힌다. 명령은 안내하고 writer는 없다', async () => {
  const b = await bootPublisher({ changePr: { writerApp: null } }, undefined, { change: { repositories: [repositoryPolicy()] } });
  try {
    assert.deepEqual(gate(b.logs), { state: 'closed', reason: 'writer_key_missing' });
    assert.ok(CHANGE_COMMANDS.every(name => b.rest.guildCommands.some(item => item.name === name)));
    assert.equal(b.writers(), 0);
    b.gw.dispatch(b.gw.latest, 2, 'INTERACTION_CREATE', interaction('902', 'change', { project: REPO.fullName, text: REQUEST_TEXT }));
    await until(() => b.rest.interactions.some(text => text.includes('writer_key_missing')));
    assert.equal(Number((await database.db.query<{ count: string }>('SELECT count(*) FROM change_requests')).rows[0]!.count), 0);
    assert.deepEqual(b.github, []);
    assert.ok(b.rest.guildCommands.some(item => item.name === 'chat'));
  } finally { await b.close(); }
});
test('호환 진입점: 정책·작업 레인·리뷰가 없으면 writer를 만들지 않고 CHANGE 사유만 다르다', async () => {
  const b = await bootPublisher({ changePr: { writerApp: { appId: '1', privateKey: FAKE_APP_KEY } } });
  try {
    assert.deepEqual(gate(b.logs), { state: 'closed', reason: 'policy_missing' });
    assert.equal(b.writers(), 0);
  } finally { await b.close(); }
});

test('호환 진입점: 조건이 다 맞아도 옛 작업자면 접수만 닫히고 v2로 답하면 열린다. 작업자가 답한 뒤에만 받는다', async () => {
  const review = { repositories: [{ id: 101, fullName: 'fixture-org/fixture-repo', installationId: 501, visibility: 'public' }], allowedBotAuthorIds: [], commentCommand: null, reviewDrafts: false, rereviewOnBaseMove: null, comparison: 'merge_base', reviewSince: 0, internalMarkers: [], input: { maxFiles: 20, maxFileBytes: 100_000, maxDiffBytes: 200_000, maxArchiveBytes: 1_000_000, maxBodyChars: 4000 }, publish: null, reconcile: { maxPages: 1, maxReviewsPerRun: 1 } };
  const task = { projects: [{ id: 'fixture', revision: 'r1', allowedPaths: ['src', 'tests', 'docs', 'README.md'], forbiddenPaths: [], verifyCommands: [], repository: REPO.fullName, branch: 'main' }] };
  const workers = { v2: false, reviewRoute: true };
  const taskPort = { url: '' };
  const b = await bootPublisher({ changePr: { writerApp: { appId: '1', privateKey: FAKE_APP_KEY } }, githubReviewApp: { appId: '2', privateKey: FAKE_APP_KEY }, reviewEnabled: true }, workers, { review, task, change: { repositories: [repositoryPolicy()] } }, taskPort);
  try {
    assert.deepEqual(gate(b.logs), { state: 'waiting_worker' });
    assert.equal(b.writers(), 1, '조건이 맞으면 writer 객체는 하나다');
    await until(() => b.logs.some(entry => entry.event === 'change_workers') || b.calls.some(call => call.includes('/v1/change-review')), 4000);
    b.gw.dispatch(b.gw.latest, 2, 'INTERACTION_CREATE', interaction('903', 'change', { project: REPO.fullName, text: REQUEST_TEXT }));
    await until(() => b.rest.interactions.some(text => text.includes('task_worker_unsupported')), 4000);
    assert.equal(Number((await database.db.query<{ count: string }>('SELECT count(*) FROM change_requests')).rows[0]!.count), 0);
    assert.ok(!b.github.some(url => /\/git\/(blobs|trees|commits|refs)/.test(url)));
    workers.v2 = true;
    await until(() => b.logs.some(entry => entry.event === 'change_workers' && (entry.fields as { task: boolean }).task), 4000);
    b.gw.dispatch(b.gw.latest, 3, 'INTERACTION_CREATE', interaction('904', 'change', { project: REPO.fullName, text: REQUEST_TEXT }));
    await until(() => b.rest.interactions.some(text => text.includes('받았습니다')), 4000);
    assert.equal(Number((await database.db.query<{ count: string }>('SELECT count(*) FROM change_requests')).rows[0]!.count), 1);
  } finally { await b.close(); }
});
test('호환 작업자 진입점: 작업 레인 작업자는 intake로 v2를 말하고, 대화·리뷰 작업자는 /v1/change-review를 연다. 시작 때 시험 실행기·로그 없이 기동한다', async () => {
  const { startWorker, workerConfig } = await import('../src/worker-main.js');
  const { FAKE_CLAUDE, FakeCleanup } = await import('./task-worker-harness.js');
  const { chmod, mkdir } = await import('node:fs/promises');
  const base = await mkdtemp(join(tmpdir(), 'homelab-bot-b5-worker-'));
  try {
    const fake = join(base, 'fake');
    await mkdir(fake);
    await mkdir(join(base, 'credential'));
    await writeFile(join(base, 'credential', 'CLAUDE_CODE_OAUTH_TOKEN'), 'sk-ant-oat01-fixture-token-ABCDEFGHIJKLMNOPQRSTUVWXYZ-0123456789\n');
    await writeFile(join(fake, 'claude.cjs'), FAKE_CLAUDE);
    await writeFile(join(fake, 'claude'), `#!/bin/sh\nexec "${process.execPath}" "${join(fake, 'claude.cjs')}" "$@"\n`);
    await chmod(join(fake, 'claude'), 0o755);
    const { CLAUDE_TASK_CAPABILITIES } = await import('../src/executor-claude-task.js');
    await writeFile(join(fake, 'version.txt'), `${CLAUDE_TASK_CAPABILITIES.cliVersion} (Claude Code)\n`);
    const publicKey = generateKeyPairSync('ed25519').publicKey.export({ type: 'spki', format: 'pem' }) as string;
    const env = (extra: Record<string, string>) => ({ WORKER_EXECUTOR: 'claude', WORKER_MODEL: 'claude-opus-5-5', WORKER_CREDENTIAL_DIR: join(base, 'credential'), WORKER_CREDENTIAL_KEY: 'CLAUDE_CODE_OAUTH_TOKEN',
      WORKER_CONTROL_PUBLIC_KEY: publicKey, WORKER_EXECUTOR_BIN: join(fake, 'claude'), ...extra });
    const root = join(base, 'state');
    const task = workerConfig(env({ WORKER_LANES: 'task', TASK_STATE_ROOT: root, WORKER_NONCE_DIR: join(root, '.homelab-worker', 'nonces') }));
    const running = await startWorker(task, { port: 0, host: '127.0.0.1', homes: [], cleanup: new FakeCleanup(join(fake, 'pids')), fsRoot: base });
    try {
      const port = (running.server.address() as AddressInfo).port;
      const intake = await (await fetch(`http://127.0.0.1:${port}/v1/task/intake`)).json() as { change?: { contract: number } };
      assert.equal(intake.change?.contract, 2);
      assert.equal((await fetch(`http://127.0.0.1:${port}/v2/task`, { method: 'POST', body: '{}' })).status, 401);
    } finally { await running.close(); }
    assert.throws(() => workerConfig(env({ WORKER_NONCE_DIR: join(base, 'nonces'), WORKER_IMAGE_REVISION: 'has space' })), /WORKER_IMAGE_REVISION|config_invalid/);
    assert.equal(workerConfig(env({ WORKER_NONCE_DIR: join(base, 'nonces') })).imageRevision, 'unversioned');
    // 대화·리뷰 작업자는 기존 경로와 후보 리뷰 경로를 함께 연다. 인증 없는 POST는 본문을 읽기 전에 401이다.
    const chat = await startWorker(workerConfig(env({ WORKER_NONCE_DIR: join(base, 'nonces'), HTTPS_PROXY: 'http://127.0.0.1:9' })), { port: 0, host: '127.0.0.1', homes: [] });
    try {
      const port = (chat.server.address() as AddressInfo).port;
      assert.equal(chat.reviewClosed, undefined);
      assert.equal((await fetch(`http://127.0.0.1:${port}/v1/review`, { method: 'POST' })).status, 401);
      assert.equal((await fetch(`http://127.0.0.1:${port}/v1/change-review`, { method: 'POST' })).status, 401);
      assert.equal((await fetch(`http://127.0.0.1:${port}/v1/change-review/result`, { method: 'POST' })).status, 401);
    } finally { await chat.close(); }
    // 프록시 경계가 없으면 리뷰만 닫힌다. 후보 리뷰 경로도 없어 게시 서버가 CHANGE만 닫는다.
    const closed = await startWorker(workerConfig(env({ WORKER_NONCE_DIR: join(base, 'nonces') })), { port: 0, host: '127.0.0.1', homes: [] });
    try {
      assert.ok(closed.reviewClosed);
      assert.equal((await fetch(`http://127.0.0.1:${(closed.server.address() as AddressInfo).port}/v1/change-review`, { method: 'POST' })).status, 404);
    } finally { await closed.close(); }
  } finally { await rm(base, { recursive: true, force: true }); }
});

// ---- CHANGE-01 ----

test('CHANGE-01 local_integration: /change → v2 작성 → 무자격 검증 → 별도 리뷰 → 승인 → 가짜 GitHub. H.tree=T1, parent=B이고 공개 입력만 흐른다', async () => {
  await withHarness({}, async h => {
    await h.command('100', 'change', { target: REPO.fullName, text: REQUEST_TEXT });
    const id = await h.changeId();
    assert.match(h.acknowledgements().join(), new RegExp(id));
    await h.pump(async () => await h.phase(id) === 'awaiting_publish_approval');
    assert.equal(h.env.github.mutations().length, 0, '승인 전에는 GitHub 쓰기가 없다');
    assert.equal(h.env.github.issued.length, 0, '승인 전에는 토큰도 없다');
    // 작성자 입력은 공개 brief뿐이다.
    const calls = await h.f.calls();
    assert.equal(calls.length, 1);
    assert.match(calls[0]!.input, /공개 목표/);
    // 리뷰는 새 세션이고 작성 세션 ID가 입력에 없다.
    assert.equal(h.reviewInputs.length, 1);
    assert.ok(!JSON.stringify(h.reviewInputs[0]).includes(calls[0]!.session));
    const row = (await h.db.query<{ result_tree: string; base_commit: string; artifact_digest: string; verifier_revision: string }>('SELECT * FROM change_generations WHERE change_id=$1', [id])).rows[0]!;
    assert.equal(row.verifier_revision, 'change-verifier-v1');
    assert.equal(h.runs.verify, 1);
    // 미리보기는 digest를 담고 mention이 울리지 않는다.
    await h.deliver();
    const preview = h.messages().find(text => text.includes('게시 미리보기'))!;
    const digest = await digestOf(h, id);
    assert.ok(preview.includes(digest));
    assert.ok(preview.includes('src/new.ts'));
    assert.ok(h.rest.messages.every(message => message.body.allowed_mentions.parse.length === 0));
    // digest가 다르면 승인하지 않는다. 다른 스레드에서는 존재도 알리지 않는다.
    await h.command('101', 'change-publish', { target: id, text: 'f'.repeat(64) });
    assert.equal(await h.phase(id), 'awaiting_publish_approval');
    await h.command('102', 'change-publish', { target: id, text: digest, scope: OTHER_THREAD });
    assert.equal(await h.phase(id), 'awaiting_publish_approval');
    assert.match(h.acknowledgements().at(-1)!, /볼 수 있는 변경이 아닙니다/);
    await h.command('103', 'change-publish', { target: id, text: digest });
    await h.pump(async () => await h.phase(id) === 'proposed');
    const pull = h.env.github.pulls[0]!;
    assert.equal(h.env.github.pulls.length, 1);
    const commit = h.env.github.commits.get(pull.head.sha)!;
    assert.equal(commit.tree, row.result_tree, 'H.tree = T1');
    assert.deepEqual(commit.parents, [row.base_commit], 'H.parents = [B]');
    assert.match(h.env.github.refs.has(`heads/${pull.head.ref}`) ? pull.head.ref : '', /^bot\/change\/[0-9a-f]{32}\/g1$/);
    // 슬롯은 부모가 아니라 자식만 잡았다.
    assert.equal(await h.store.laneBusy('task'), false);
    assert.equal((await childOf(h.db, id))!.state, 'succeeded');
  });
});
test('CHANGE-01 mock: 다른 묶음·다른 generation의 receipt는 저장되지 않는다', async () => {
  await withHarness({}, async h => {
    const id = await toAwaiting(h);
    const key = { changeId: id, generation: 1 };
    const receipt = (await h.db.query<{ receipt: any }>('SELECT receipt FROM change_verifications WHERE change_id=$1', [id])).rows[0]!.receipt;
    const stale = await h.changes.recordVerification({ changeId: id, generation: 2, receipt: { ...receipt, commandId: 'other-command' } });
    assert.equal(stale.ok, false);
    const forged = await h.changes.recordVerification({ ...key, receipt: { ...receipt, bundle: { ...receipt.bundle, resultTree: 'd'.repeat(40) } } });
    assert.equal(forged.ok, false);
    const approved = await h.changes.approve({ ...key, approvalDigest: 'e'.repeat(64), eventId: 'forged', actor: OWNER });
    assert.equal(approved.ok, false);
  });
});
test('CHANGE-01 차단: 시험 실패면 리뷰·승인으로 가지 않고 결과를 정리해 레인을 놓는다', async () => {
  await withHarness({ sandbox: async () => ({ started: true, exitCode: 3, timedOut: false, overflow: false, aborted: false, log: Buffer.from('failed\n'), logBytes: 7, logDigest: 'b'.repeat(64) }) }, async h => {
    await h.command('100', 'change', { target: REPO.fullName, text: REQUEST_TEXT });
    const id = await h.changeId();
    await h.pump(async () => await h.phase(id) === 'blocked');
    assert.equal((await h.changes.get(id) as any).value.phaseReason, 'verification_failed');
    assert.equal(h.reviewInputs.length, 0);
    await h.pump(async () => (await childOf(h.db, id))!.state === 'succeeded');
    assert.equal(await h.store.laneBusy('task'), false);
    assert.equal(h.env.github.mutations().length, 0);
  });
});
test('CHANGE-01 리뷰 차단·경고: blocked 판정은 부모를 닫고, unverifiable은 경고로 미리보기에 보인다', async () => {
  const output = { goal: 'met' as const, acceptance: [{ index: 0, status: 'met' as const }], reviewed_paths: ['src/a.ts', 'src/new.ts'], findings: [], summary: 's' };
  await withHarness({ reviewReply: () => ({ status: 'succeeded', output: { ...output, acceptance: [{ index: 0, status: 'not_met' as const }] } }) }, async h => {
    await h.command('100', 'change', { target: REPO.fullName, text: REQUEST_TEXT });
    const id = await h.changeId();
    await h.pump(async () => await h.phase(id) === 'blocked');
    assert.equal((await h.changes.get(id) as any).value.phaseReason, 'review_blocked');
    assert.equal(h.reviewInputs.length, 1);
    await h.deliver();
    assert.ok(h.messages().some(text => text.includes('review_blocked')));
  });
});
test('CHANGE-01 unverifiable 경고는 pass_with_warnings로 미리보기에 남는다', async () => {
  const output = { goal: 'unverifiable' as const, acceptance: [{ index: 0, status: 'met' as const }], reviewed_paths: ['src/a.ts', 'src/new.ts'], findings: [], summary: 's' };
  await withHarness({ reviewReply: () => ({ status: 'succeeded', output }) }, async h => {
    const id = await toAwaiting(h);
    await h.deliver();
    const preview = h.messages().find(text => text.includes('게시 미리보기'))!;
    assert.match(preview, /pass_with_warnings/);
    assert.match(preview, /경고:/);
    assert.equal(await h.phase(id), 'awaiting_publish_approval');
  });
});
test('CHANGE-03 연결: 승인 뒤 base가 움직이면 superseded이고 자동으로 다시 시작하지 않는다. /change text:next만 새 generation을 연다', async () => {
  await withHarness({}, async h => {
    const id = await toAwaiting(h);
    h.env.github.moveBase();
    await h.command('101', 'change-publish', { target: id, text: await digestOf(h, id) });
    await h.pump(async () => await h.phase(id) === 'superseded');
    assert.equal(h.env.github.mutations().length, 0);
    const before = (await h.f.calls()).length;
    for (let round = 0; round < 5; round++) { await h.runtime.laneTick(); await h.runtime.publishTick(); }
    assert.equal(await h.phase(id), 'superseded', '자동 재시도 없음');
    assert.equal((await h.f.calls()).length, before);
    await h.deliver();
    assert.ok(h.messages().some(text => text.includes(`/change project:${id} text:next`)));
    await h.command('102', 'change', { target: id, text: 'next', scope: OTHER_THREAD });
    assert.equal(await h.phase(id), 'superseded', '다른 스레드에서는 열지 못한다');
    assert.match(h.acknowledgements().at(-1)!, /볼 수 있는 변경이 아닙니다/);
    await h.f.script([WRITE_STEP]);
    await h.command('103', 'change', { target: id, text: 'next' });
    await h.pump(async () => await h.phase(id) === 'awaiting_publish_approval');
    assert.equal((await h.changes.get(id) as any).value.generation, 2);
    assert.equal((await h.f.calls()).length, before + 1, '새 generation에서만 모델을 다시 부른다');
  });
});
test('끝 상태 PR: 병합 전 PR이 blocked가 되면 /change-status가 추적 안 함을 말하고 배포를 읽지 않는다', async () => {
  await withHarness({}, async h => {
    const id = await toProposed(h);
    h.env.github.pulls[0]!.head.sha = 'a'.repeat(40);
    h.env.github.pulls[0]!.merged_at = '2026-01-01T00:00:00Z';
    h.env.github.pulls[0]!.state = 'closed';
    await h.pump(async () => await h.phase(id) === 'blocked');
    assert.equal((await h.changes.get(id) as any).value.phaseReason, 'head_changed');
    await h.command('200', 'change-status', { target: id });
    assert.match(h.acknowledgements().at(-1)!, /병합해도 배포를 추적하지 않습니다/);
  });
});
test('병합 읽기: 조회 실패는 미병합으로 처리하지 않고, 닫힌 PR은 cancelled, 병합은 관측으로 간다. 창 시작은 재시작 뒤에도 남는다', async () => {
  const observations: string[] = [];
  await withHarness({}, async h => {
    const stateful = { state: 'pending' as 'pending' | 'observed', calls: 0 };
    h.restart({ instrument: deps => ({ ...deps, deployment: { readMerge: deps.deployment.readMerge.bind(deps.deployment), observe: async input => {
      stateful.calls++;
      observations.push(stateful.state);
      return { state: stateful.state, headSha: input.headSha, mergeCommit: input.mergeCommit, configCommit: stateful.state === 'observed' ? 'd'.repeat(40) : null, imageDigest: stateful.state === 'observed' ? `sha256:${'e'.repeat(64)}` : null, argoObservedAt: stateful.state === 'observed' ? 1 : null, workloadObservedAt: stateful.state === 'observed' ? 1 : null, observedAt: Date.now(), reason: null };
    } } }) });
    const id = await toProposed(h);
    const pull = h.env.github.pulls[0]!;
    h.env.github.fail(new RegExp(`GET .*/pulls/${pull.number}$`), { status: 500 }, 0);
    // 없는 PR(404)은 조회 실패다. phase를 유지한다.
    const number = pull.number;
    pull.number = 999;
    await h.runtime.publishTick();
    assert.equal(await h.phase(id), 'proposed');
    pull.number = number;
    pull.merged_at = '2026-01-01T00:00:00Z';
    pull.state = 'closed';
    await h.pump(async () => await h.phase(id) === 'observing_deploy');
    const window = (await h.db.query<{ started_at: string }>('SELECT started_at FROM change_deployment_windows WHERE change_id=$1', [id])).rows[0]!;
    await h.pump(async () => stateful.calls > 0);
    h.restart({ instrument: deps => ({ ...deps, deployment: { readMerge: deps.deployment.readMerge.bind(deps.deployment), observe: async input => {
      stateful.state = 'observed';
      stateful.calls++;
      return { state: 'observed', headSha: input.headSha, mergeCommit: input.mergeCommit, configCommit: 'd'.repeat(40), imageDigest: `sha256:${'e'.repeat(64)}`, argoObservedAt: 1, workloadObservedAt: 1, observedAt: Date.now(), reason: null };
    } } }) });
    await h.pump(async () => (await h.changes.deployment({ changeId: id, generation: 1 }) as any).value.state === 'observed');
    assert.equal((await h.db.query<{ started_at: string }>('SELECT started_at FROM change_deployment_windows WHERE change_id=$1', [id])).rows[0]!.started_at, window.started_at, '창 시작은 그대로');
    // 재시도 간격을 잃은 새 프로세스에서도 다시 읽지 않아야 끝났다고 말할 수 있다.
    const stop = stateful.calls;
    h.restart({ instrument: deps => ({ ...deps, deployment: { readMerge: deps.deployment.readMerge.bind(deps.deployment), observe: async () => { stateful.calls++; throw new Error('not_expected'); } } }) });
    for (let round = 0; round < 5; round++) await h.runtime.publishTick();
    assert.equal(stateful.calls, stop, '끝나면 더 읽지 않는다');
    await h.deliver();
    assert.ok(h.messages().some(text => text.includes('배포 관측: observed')));
    assert.ok(h.messages().every(text => !text.includes('@everyone')));
  });
});
test('병합 읽기: 병합 없이 닫힌 PR은 cancelled(closed_unmerged)다', async () => {
  await withHarness({}, async h => {
    const id = await toProposed(h);
    // 열려 있는 동안은 읽기만 한다. 슬롯도 잡지 않는다.
    for (let round = 0; round < 3; round++) await h.runtime.publishTick();
    assert.equal(await h.phase(id), 'proposed');
    assert.equal(await h.store.laneBusy('task'), false);
    h.env.github.pulls[0]!.state = 'closed';
    await h.pump(async () => await h.phase(id) === 'cancelled');
    assert.equal((await h.changes.get(id) as any).value.phaseReason, 'closed_unmerged');
  });
});
test('배포 늦음: 창이 지나면 멈추고 마지막 관측을 알린다. 끝 상태로 바꾸지 않는다', async () => {
  await withHarness({}, async h => {
    let reads = 0;
    h.restart({ instrument: deps => ({ ...deps, deployment: { readMerge: deps.deployment.readMerge.bind(deps.deployment), observe: async input => { reads++; return { state: 'pending', headSha: input.headSha, mergeCommit: input.mergeCommit, configCommit: null, imageDigest: null, argoObservedAt: null, workloadObservedAt: null, observedAt: Date.now(), reason: 'argo_config_stale' }; } } }) });
    const id = await toProposed(h);
    h.env.github.pulls[0]!.merged_at = '2026-01-01T00:00:00Z';
    h.env.github.pulls[0]!.state = 'closed';
    await h.pump(async () => await h.phase(id) === 'observing_deploy');
    await h.db.query('UPDATE change_deployment_windows SET started_at=1 WHERE change_id=$1', [id]);
    h.restart({ instrument: deps => ({ ...deps, deployment: { readMerge: deps.deployment.readMerge.bind(deps.deployment), observe: async input => { reads++; return { state: 'pending', headSha: input.headSha, mergeCommit: input.mergeCommit, configCommit: null, imageDigest: null, argoObservedAt: null, workloadObservedAt: null, observedAt: Date.now(), reason: 'argo_config_stale' }; } } }) });
    await h.pump(async () => (await h.db.query<{ late_reported_at: string | null }>('SELECT late_reported_at FROM change_deployment_windows WHERE change_id=$1', [id])).rows[0]!.late_reported_at !== null);
    const stop = reads;
    h.restart({ instrument: deps => ({ ...deps, deployment: { readMerge: deps.deployment.readMerge.bind(deps.deployment), observe: async () => { reads++; throw new Error('not_expected'); } } }) });
    for (let round = 0; round < 3; round++) await h.runtime.publishTick();
    assert.equal(reads, stop);
    assert.equal(await h.phase(id), 'observing_deploy');
    await h.deliver();
    assert.ok(h.messages().some(text => text.includes('argo_config_stale')));
  });
});

// ---- DATA-01 ----

const CANARY = ['fixture', 'private', 'canary', '7f3a'].join('-');
const nothingSent = async (h: Harness) => {
  assert.equal(h.env.github.mutations().length, 0, 'GitHub 쓰기 0회');
  assert.equal((await h.f.calls()).length, 0, '작성 모델 0회');
  assert.equal(h.reviewInputs.length, 0, '리뷰 모델 0회');
};
for (const label of ['private', 'unknown'] as const) {
  test(`DATA-01 요청: label=${label}이면 작성자·GitHub에 아무것도 가지 않고 막힌다`, async () => {
    await withHarness({}, async h => {
      await h.command('100', 'change', { target: REPO.fullName, text: `${CANARY} | goal=${CANARY} | accept=${CANARY} | label=${label}` });
      const id = await h.changeId();
      assert.equal(await h.phase(id), 'blocked');
      assert.match(h.acknowledgements().at(-1)!, /막았습니다/);
      for (let round = 0; round < 5; round++) { await h.runtime.laneTick(); await h.runtime.publishTick(); }
      await nothingSent(h);
      await h.deliver();
      assert.ok(h.messages().every(text => !text.includes(CANARY)), '응답·알림에 원문이 없다');
      // 원문은 비공개 입력 표에만 있고 대화 맥락(events)에 남지 않는다.
      const events = (await h.db.query<{ payload: unknown }>('SELECT payload FROM events')).rows;
      assert.ok(!JSON.stringify(events).includes(CANARY));
    });
  });
}
test('DATA-01 label을 적지 않으면 unknown이다. 입력에서 비공개 표식이 나오면 label=public을 적어도 막는다', async () => {
  await withHarness({}, async h => {
    await h.command('100', 'change', { target: REPO.fullName, text: '요약 | accept=조건' });
    assert.equal(await h.phase(await h.changeId()), 'blocked');
    await h.command('101', 'change', { target: REPO.fullName, text: '요약 fixture-corp-host | accept=조건 | label=public' });
    const second = await h.changeId();
    assert.equal(await h.phase(second), 'blocked');
    assert.equal((await h.changes.get(second) as any).value.label, 'private');
    assert.match(h.acknowledgements().at(-1)!, /internal_marker/);
    await nothingSent(h);
  });
});
test('DATA-01 허용 scope: 스레드 밖·다른 owner·DM·알림 채널 스레드는 받지 않는다', async () => {
  await withHarness({}, async h => {
    await h.command('100', 'change', { target: REPO.fullName, text: REQUEST_TEXT, scope: { guild: 'fixture-guild', channel: 'fixture-chat', parent: null, kind: 'channel' } });
    assert.match(h.acknowledgements().at(-1)!, /스레드에서만/);
    await h.command('101', 'change', { target: REPO.fullName, text: REQUEST_TEXT, scope: { guild: 'fixture-guild', channel: 'fixture-thread-n', parent: 'fixture-notifications', kind: 'thread' } });
    assert.match(h.acknowledgements().at(-1)!, /스레드에서만/);
    await assert.rejects(h.command('102', 'change', { target: REPO.fullName, text: REQUEST_TEXT, actor: 'fixture-stranger' }));
    assert.equal(Number((await h.db.query<{ count: string }>('SELECT count(*) FROM change_requests')).rows[0]!.count), 0);
    h.policy.current = { ...h.policy.current, dmEnabled: true };
    await h.command('103', 'change', { target: REPO.fullName, text: REQUEST_TEXT, scope: { guild: null, channel: 'fixture-dm', parent: null, kind: 'dm' } });
    assert.match(h.acknowledgements().at(-1)!, /스레드에서만/);
    assert.equal(Number((await h.db.query<{ count: string }>('SELECT count(*) FROM change_requests')).rows[0]!.count), 0);
  });
});
test('DATA-01 다른 thread·메모리: 같은 스레드의 대화와 다른 스레드의 글이 작성·리뷰 입력에 들어가지 않는다', async () => {
  await withHarness({}, async h => {
    await h.store.save({ id: '50', actor: OWNER, scope: THREAD, kind: 'message', text: CANARY }, 'fixture-policy-1', true);
    await h.store.save({ id: '51', actor: OWNER, scope: OTHER_THREAD, kind: 'message', text: CANARY }, 'fixture-policy-1', true);
    await h.db.query(`UPDATE events SET accepted=true`);
    const id = await toAwaiting(h);
    const calls = await h.f.calls();
    assert.ok(!JSON.stringify(calls).includes(CANARY));
    assert.ok(!JSON.stringify(h.reviewInputs).includes(CANARY));
    assert.equal(await h.phase(id), 'awaiting_publish_approval');
  });
});
test('DATA-01 추가 답변: label 없는 답은 받지 않고, private 답은 작성자에 닿기 전에 막고, 다른 스레드에서는 답하지 못한다', async () => {
  await withHarness({ steps: [QUESTION, WRITE_STEP] }, async h => {
    await h.command('100', 'change', { target: REPO.fullName, text: REQUEST_TEXT });
    const id = await h.changeId();
    await h.pump(async () => (await h.db.query(`SELECT 1 FROM codex_questions WHERE state='open'`)).rows.length > 0);
    const question = (await h.db.query<{ id: string }>(`SELECT id FROM codex_questions WHERE state='open'`)).rows[0]!.id;
    await h.deliver();
    assert.ok(h.messages().some(text => text.includes(question)));
    assert.equal(await h.store.laneBusy('task'), false, '질문 대기 중에는 슬롯을 놓는다');
    await h.command('101', 'answer', { target: question, text: `${CANARY} 라벨 없는 답` });
    assert.equal((await h.db.query<{ state: string }>('SELECT state FROM codex_questions WHERE id=$1', [question])).rows[0]!.state, 'open');
    await assert.rejects(h.command('102', 'answer', { target: question, text: 'label=public | 다른 스레드의 답', scope: OTHER_THREAD }));
    await h.command('103', 'answer', { target: question, text: `label=private | ${CANARY}` });
    assert.equal((await h.db.query<{ answer: string | null }>('SELECT answer FROM codex_questions WHERE id=$1', [question])).rows[0]!.answer, null, '재개가 읽는 자리에 답이 없다');
    assert.equal(await h.phase(id), 'blocked');
    assert.equal((await h.changes.get(id) as any).value.label, 'private');
    for (let round = 0; round < 10; round++) { await h.runtime.childrenTick(); await h.runtime.laneTick(); await h.runtime.publishTick(); }
    const calls = await h.f.calls();
    assert.equal(calls.length, 1, '답으로 턴을 다시 띄우지 않았다');
    assert.ok(!JSON.stringify(calls).includes(CANARY));
    await h.pump(async () => ['cancelled', 'failed'].includes((await childOf(h.db, id))!.state));
    assert.equal(h.env.github.mutations().length, 0);
  });
});
test('DATA-01 기록 없는 답: 출처 기록을 찾지 못한 답은 unknown으로 보고 작성자에 넘기지 않는다', async () => {
  await withHarness({ steps: [QUESTION, WRITE_STEP] }, async h => {
    await h.command('100', 'change', { target: REPO.fullName, text: REQUEST_TEXT });
    const id = await h.changeId();
    await h.pump(async () => (await h.db.query(`SELECT 1 FROM codex_questions WHERE state='open'`)).rows.length > 0);
    const question = (await h.db.query<{ id: string }>(`SELECT id FROM codex_questions WHERE state='open'`)).rows[0]!.id;
    await h.command('101', 'answer', { target: question, text: 'label=public | 답' });
    await h.db.query('UPDATE codex_questions SET answer_event=$2 WHERE id=$1', [question, 'event-without-record']);
    await h.pump(async () => await h.phase(id) === 'blocked');
    assert.equal((await h.changes.get(id) as any).value.phaseReason, 'label_blocked');
    assert.equal((await h.f.calls()).length, 1, '답으로 턴을 띄우지 않았다');
  });
});
test('DATA-01 공개 답: label=public 답은 표식을 떼고 작성자에게 가서 이어 간다. label 위조로 내려가지 않는다', async () => {
  await withHarness({ steps: [QUESTION, WRITE_STEP] }, async h => {
    await h.command('100', 'change', { target: REPO.fullName, text: REQUEST_TEXT });
    const id = await h.changeId();
    await h.pump(async () => (await h.db.query(`SELECT 1 FROM codex_questions WHERE state='open'`)).rows.length > 0);
    const question = (await h.db.query<{ id: string }>(`SELECT id FROM codex_questions WHERE state='open'`)).rows[0]!.id;
    await h.command('101', 'answer', { target: question, text: 'label=public | src/a.ts를 고치세요' });
    await h.pump(async () => await h.phase(id) === 'awaiting_publish_approval');
    const calls = await h.f.calls();
    assert.equal(calls.length, 2);
    assert.match(calls[1]!.input, /src\/a\.ts를 고치세요/);
    assert.ok(!calls[1]!.input.includes('label=public'));
    assert.equal((await h.changes.get(id) as any).value.label, 'public');
    // 입력 표에는 답의 출처가 남는다. 저장 계층이 낮추지 못한다.
    const lowered = await h.changes.admit({ changeId: id, generation: 1, brief: (await h.changes.get(id) as any).value.brief, policyRevision: 'x' });
    assert.equal(lowered.ok, false);
  });
});

// ---- EVENT-02 ----

const CRASH_POINTS = ['author.start', 'author.fetchResult', 'artifacts.save', 'changes.startVerification', 'verification.run', 'changes.recordVerification', 'author.finalize', 'changes.finishVerification', 'review.submit', 'review.fetchReceipt', 'publisher.prepareApproval', 'changes.pinBase', 'changes.admit'];
for (const point of CRASH_POINTS) {
  for (const when of ['before', 'after'] as const) {
    test(`EVENT-02 ${point} ${when} 중단 뒤 재시작: 모델·시험·리뷰가 한 번씩이고 같은 결과로 이어 간다`, async () => {
      await withHarness({ crash: { point, when } }, async h => {
        const fired = () => h.logs.some(entry => entry.event === 'change_step_failed');
        await h.command('100', 'change', { target: REPO.fullName, text: REQUEST_TEXT });
        const id = await h.changeId();
        // 끊긴 바퀴 뒤에 새 프로세스를 만든다. 메모리에 든 것이 없다.
        await h.pump(async () => fired() || await h.phase(id) === 'awaiting_publish_approval');
        h.restart();
        await h.pump(async () => await h.phase(id) === 'awaiting_publish_approval');
        await h.pump(async () => (await childOf(h.db, id))!.state === 'succeeded');
        assert.equal((await h.f.calls()).length, 1, '모델 1회');
        assert.equal(h.runs.verify, 1, '시험 1회');
        assert.equal(h.reviewInputs.length, 1, '리뷰 1회');
        assert.equal(await h.store.laneBusy('task'), false, '레인이 풀렸다');
      });
    });
  }
}
for (const stage of ['blobs', 'trees', 'commits', 'refs', 'pulls']) {
  test(`EVENT-02 게시 ${stage} 응답 유실·재시작: 중복 없이 PR 하나로 끝난다`, async () => {
    await withHarness({}, async h => {
      const id = await toAwaiting(h);
      const route = stage === 'pulls' ? /POST .*\/pulls$/ : new RegExp(`POST .*/git/${stage}$`);
      h.env.github.fail(route, 'lose_response');
      await h.command('101', 'change-publish', { target: id, text: await digestOf(h, id) });
      await h.pump(async () => h.env.github.count(route) > 0);
      h.restart();
      await h.pump(async () => {
        await h.runtime.reconcile();
        return await h.phase(id) === 'proposed';
      }, 60);
      assert.equal(h.env.github.pulls.length, 1);
      // blob은 파일마다 POST 하나다. 같은 내용을 두 번 보내면 대조 대신 재전송한 것이다.
      const bodies = h.env.github.sent.filter(item => route.test(`${item.method} ${item.path}`)).map(item => JSON.stringify(item.body));
      assert.equal(new Set(bodies).size, bodies.length, '불명확한 요청을 다시 보내지 않는다');
    });
  });
}
test('EVENT-02 lease 만료: 재시작으로 lease를 잃어도 턴을 다시 돌리지 않고 되찾아 끝낸다. 레인은 풀린다', async () => {
  await withHarness({}, async h => {
    await h.command('100', 'change', { target: REPO.fullName, text: REQUEST_TEXT });
    const id = await h.changeId();
    await h.pump(async () => (await h.db.query(`SELECT 1 FROM codex_sessions WHERE state='running'`)).rows.length > 0);
    await h.db.query(`UPDATE jobs SET lease_until=1 WHERE type='task'`);
    await h.store.expire();
    assert.equal((await childOf(h.db, id))!.state, 'unknown');
    h.restart();
    await h.pump(async () => await h.phase(id) === 'awaiting_publish_approval');
    assert.equal((await h.f.calls()).length, 1);
    await h.pump(async () => (await childOf(h.db, id))!.state === 'succeeded');
    await h.store.atomic(async store => { await store.db.query(`SELECT lane FROM execution_lanes WHERE lane='task' FOR UPDATE`); await store.syncTaskLane(); });
    assert.equal((await h.db.query<{ closed_reason: string | null }>(`SELECT closed_reason FROM execution_lanes WHERE lane='task'`)).rows[0]!.closed_reason, null);
  });
});
test('EVENT-02 lease 만료(시작 전): 턴을 보내기 전에 끊긴 job은 줄로 돌아가 레인을 막지 않는다', async () => {
  await withHarness({ crash: { point: 'author.start', when: 'before' } }, async h => {
    await h.command('100', 'change', { target: REPO.fullName, text: REQUEST_TEXT });
    const id = await h.changeId();
    await h.pump(async () => h.logs.some(entry => entry.event === 'change_step_failed'));
    assert.equal((await childOf(h.db, id))!.state, 'queued', '보내지 못한 job은 슬롯을 놓는다');
    assert.equal(await h.store.laneBusy('task'), false);
    await h.db.query(`UPDATE jobs SET state='running',lease_token=gen_random_uuid()::text,lease_until=1 WHERE type='task'`);
    await h.store.expire();
    h.restart();
    await h.pump(async () => await h.phase(id) === 'awaiting_publish_approval');
    assert.equal((await h.f.calls()).length, 1);
  });
});
test('EVENT-02 finalize 전이 실패: 저장과 시험이 끝났으면 부모는 나아가고 정리는 다시 시도한다', async () => {
  await withHarness({}, async h => {
    let failing = true;
    h.restart({ instrument: deps => ({ ...deps, author: new Proxy(deps.author, { get(target, property) {
      const value = Reflect.get(target, property) as (...args: unknown[]) => unknown;
      if (property === 'finalize') return async (...args: unknown[]) => { if (failing) { failing = false; throw new Error('change_job_not_settled'); } return value.apply(target, args); };
      return typeof value === 'function' ? value.bind(target) : value;
    } }) }) });
    await h.command('100', 'change', { target: REPO.fullName, text: REQUEST_TEXT });
    const id = await h.changeId();
    await h.pump(async () => await h.phase(id) === 'awaiting_publish_approval');
    await h.pump(async () => (await childOf(h.db, id))!.state === 'succeeded');
    assert.equal(failing, false);
    assert.equal(await h.store.laneBusy('task'), false);
  });
});
test('EVENT-02 시험 중 lease 만료: 재시작한 프로세스가 시험을 다시 돌리지 않고 lease를 되찾아 레인이 unknown으로 닫혀 있지 않다', async () => {
  let release!: () => void;
  const hold = new Promise<void>(resolve => { release = resolve; });
  await withHarness({ sandbox: async () => { await hold; return { started: true, exitCode: 0, timedOut: false, overflow: false, aborted: false, log: Buffer.from('ok\n'), logBytes: 3, logDigest: 'a'.repeat(64) }; } }, async h => {
    await h.command('100', 'change', { target: REPO.fullName, text: REQUEST_TEXT });
    const id = await h.changeId();
    let stopping = false;
    const lane = (async () => { while (!stopping) { await h.runtime.laneTick(); await new Promise(resolve => setTimeout(resolve, 3)); } })();
    await until(() => h.runs.verify === 1, 8000);
    stopping = true;
    h.stop();
    await lane;
    await h.db.query(`UPDATE jobs SET lease_until=1 WHERE type='task'`);
    await h.store.expire();
    assert.equal((await childOf(h.db, id))!.state, 'unknown');
    h.restart();
    // 이 바퀴는 시험이 끝날 때까지 돌아오지 않는다. 그동안 상태만 본다.
    const second = h.runtime.laneTick();
    for (let round = 0; round < 400 && (await childOf(h.db, id))!.state !== 'running'; round++) await new Promise(resolve => setTimeout(resolve, 5));
    assert.equal((await childOf(h.db, id))!.state, 'running', '시험이 끝나기 전에 되찾았다');
    release();
    await second;
    await h.pump(async () => await h.phase(id) === 'awaiting_publish_approval');
    assert.equal(h.runs.verify, 1);
    assert.equal((await h.f.calls()).length, 1);
  });
});
test('일시 경합: 작업자가 턴 시작에 busy라고 답해도 부모를 닫지 않고 같은 턴을 다시 보낸다', async () => {
  await withHarness({}, async h => {
    const port = h.f.port;
    const original = port.callV2.bind(port);
    let busy = 2;
    port.callV2 = (async (endpoint: never, body: never, signal?: AbortSignal) => {
      if (endpoint === '/v2/task' && busy > 0) { busy--; throw new TaskWorkerBusy(); }
      return original(endpoint, body, signal);
    }) as typeof port.callV2;
    const id = await toAwaiting(h);
    assert.equal(busy, 0);
    assert.equal((await h.f.calls()).length, 1);
    assert.equal(await h.phase(id), 'awaiting_publish_approval');
  });
});
test('일시 경합: 작업자가 시험 시작에 busy라고 답하면 not_run을 남기지 않고 다시 부른다', async () => {
  await withHarness({}, async h => {
    const port = h.f.port;
    const original = port.callV2.bind(port);
    let busy = 2;
    port.callV2 = (async (endpoint: never, body: never, signal?: AbortSignal) => {
      if (endpoint === '/v2/task/verify' && busy > 0) { busy--; throw new TaskWorkerBusy(); }
      return original(endpoint, body, signal);
    }) as typeof port.callV2;
    const id = await toAwaiting(h);
    assert.equal(busy, 0);
    assert.equal((await h.db.query<{ status: string }>('SELECT status FROM change_verifications WHERE change_id=$1', [id])).rows[0]!.status, 'passed');
    assert.equal(h.runs.verify, 1);
  });
});
test('막힌 건 보고: 병합 여부를 읽을 수 없는 대상이면 phase를 유지하고 한 번 알린다', async () => {
  await withHarness({ policyPatch: policy => ({ ...policy, services: [] }) }, async h => {
    const id = await toProposed(h);
    for (let round = 0; round < 3; round++) await h.runtime.publishTick();
    assert.equal(await h.phase(id), 'proposed');
    await h.deliver();
    assert.equal(h.messages().filter(text => text.includes('병합 여부를 읽지 못합니다')).length, 1);
    assert.match(h.messages().find(text => text.includes('병합 여부를 읽지 못합니다'))!, /deployment_target_unregistered/);
  });
});
test('EVENT-02 Discord ACK 유실: 요청·승인은 영속이고 ID는 스레드 게시로 남는다. 같은 상호작용은 한 번만 처리한다', async () => {
  await withHarness({}, async h => {
    h.rest.failAck = true;
    await h.command('100', 'change', { target: REPO.fullName, text: REQUEST_TEXT });
    await h.command('100', 'change', { target: REPO.fullName, text: REQUEST_TEXT });
    assert.equal(Number((await h.db.query<{ count: string }>('SELECT count(*) FROM change_requests')).rows[0]!.count), 1);
    const id = await h.changeId();
    await h.deliver();
    assert.ok(h.messages().some(text => text.includes(id)));
    await h.pump(async () => await h.phase(id) === 'awaiting_publish_approval');
    await h.command('101', 'change-publish', { target: id, text: await digestOf(h, id) });
    assert.equal(await h.phase(id), 'approved');
    h.rest.failAck = false;
    h.rest.loseResponse = true;
    await h.deliver();
    await h.store.expire();
    await h.discord.reconcile();
    await h.deliver();
    const previews = h.rest.messages.filter(message => message.body.content.includes('게시 미리보기'));
    assert.equal(previews.length, 1, '응답을 잃어도 미리보기는 한 번이다');
  });
});
test('EVENT-02 시작 불명: 시작 요청이 닿았는지 끝내 모르면 다시 보내지 않고 닫아 레인을 놓는다', async () => {
  await withHarness({}, async h => {
    let dropped = 0;
    const port = h.f.port;
    const original = port.callV2.bind(port);
    port.callV2 = (async (endpoint: never, body: never, signal?: AbortSignal) => {
      if (endpoint === '/v2/task') { dropped++; throw new Error('task_worker_uncertain'); }
      return original(endpoint, body, signal);
    }) as typeof port.callV2;
    await h.command('100', 'change', { target: REPO.fullName, text: REQUEST_TEXT });
    const id = await h.changeId();
    await h.pump(async () => await h.phase(id) === 'failed');
    assert.equal(dropped, 1, '다시 보내지 않는다');
    assert.equal((await h.f.calls()).length, 0);
    assert.equal(await h.store.laneBusy('task'), false);
  });
});
test('EVENT-02 결과 유실: 작업자가 결과를 잃은 턴은 모델을 다시 돌리지 않고 부모를 닫는다', async () => {
  await withHarness({}, async h => {
    await h.command('100', 'change', { target: REPO.fullName, text: REQUEST_TEXT });
    const id = await h.changeId();
    await h.pump(async () => (await h.db.query(`SELECT 1 FROM codex_sessions WHERE state='running'`)).rows.length > 0);
    await new Promise(resolve => setTimeout(resolve, 400));
    const { readdir, rm: remove } = await import('node:fs/promises');
    await h.f.restart(async () => {
      const dir = join(h.f.root, '.homelab-worker', 'change-results');
      for (const name of await readdir(dir).catch(() => [] as string[])) await remove(join(dir, name), { force: true });
    });
    await h.pump(async () => await h.phase(id) === 'failed');
    assert.equal((await h.changes.get(id) as any).value.phaseReason, 'task_worker_lost');
    assert.equal((await h.f.calls()).length, 1);
    assert.equal(h.env.github.mutations().length, 0);
  });
});

// ---- 슬롯·v1 분리 ----

test('호환 슬롯: CHANGE 자식 job은 v1 claim에 잡히지 않고 /retry로 되살아나지 않는다. 작성 중이면 /task가 기다린다', async () => {
  await withHarness({ steps: [{ kind: 'hang' }] }, async h => {
    await h.command('100', 'change', { target: REPO.fullName, text: REQUEST_TEXT });
    const id = await h.changeId();
    await h.runtime.laneTick();
    await h.runtime.laneTick();
    const child = (await childOf(h.db, id))!;
    assert.ok(child, '자식이 만들어졌다');
    // v1 경로가 집지 못한다. 집으면 세션이 task_session_mismatch로 닫히고 결과가 지워진다.
    await h.db.query(`UPDATE jobs SET state='queued',lease_token=NULL,lease_until=NULL WHERE id=$1 AND state='queued'`, [child.id]);
    h.worker.taskOpen = false;
    assert.equal((await h.store.claim('task'))?.id, undefined);
    assert.equal((await h.store.claim())?.id, undefined);
    h.worker.taskOpen = true;
    await h.pump(async () => (await h.db.query(`SELECT 1 FROM codex_sessions WHERE state='running'`)).rows.length > 0);
    assert.equal(await h.store.laneBusy('task'), true, '자식이 슬롯을 쥔다');
    // 사람이 낸 /task는 같은 슬롯을 기다린다. 부모와 무관하다.
    const saved = await h.store.save({ id: '200', actor: OWNER, scope: THREAD, kind: 'command', command: 'task', text: 'v1 작업', target: 'p' }, 'fixture-policy-1', false);
    await h.db.query(`UPDATE conversations SET active=true`);
    await h.db.query(`UPDATE events SET accepted=true WHERE id=$1`, [saved.id]);
    const v1 = await h.store.accept(saved.id, 'task', 'fixture-policy-1');
    assert.equal(await h.store.claim('task'), undefined);
    // 취소하면 소멸을 확인하고 슬롯을 놓는다. 그 뒤에 v1 작업이 집힌다.
    await h.command('201', 'change-cancel', { target: id });
    assert.equal(await h.phase(id), 'cancelled');
    await h.pump(async () => !(await h.store.laneBusy('task')));
    assert.equal((await h.store.claim('task'))?.id, v1);
    // 끝난 자식은 /retry로 되살아나지 않는다.
    await h.db.query(`UPDATE jobs SET state='failed' WHERE id=$1`, [child.id]);
    const retried = await h.store.control(OWNER, h.store.scopeId(THREAD), 'retry', child.id) as { status: string };
    assert.match(retried.status, /재시도할 작업이/);
    assert.equal((await childOf(h.db, id))!.state, 'failed');
  });
});
test('호환 슬롯: 리뷰는 대화 레인이고 작업 레인과 겹치지 않는다. 승인 대기 중인 부모는 어느 슬롯도 잡지 않는다', async () => {
  await withHarness({}, async h => {
    const id = await toAwaiting(h);
    assert.equal(await h.store.laneBusy('task'), false);
    assert.equal(await h.store.laneBusy('interactive'), false);
    assert.equal(await h.phase(id), 'awaiting_publish_approval');
    const review = (await childOf(h.db, id, 'review'))!;
    assert.equal(review.state, 'succeeded');
    assert.equal((await h.db.query<{ execution_lane: string }>('SELECT execution_lane FROM jobs WHERE id=$1', [review.id])).rows[0]!.execution_lane, 'interactive');
    assert.equal((await h.db.query<{ execution_lane: string }>('SELECT execution_lane FROM jobs WHERE id=$1', [(await childOf(h.db, id))!.id])).rows[0]!.execution_lane, 'task');
  });
});
test('호환 unknown: 소멸을 확인하지 못한 작성 job은 레인을 닫은 채 유지되고 /task-release 뒤에 결과를 잃은 것으로 닫힌다', async () => {
  await withHarness({ steps: [{ kind: 'hang' }] }, async h => {
    await h.command('100', 'change', { target: REPO.fullName, text: REQUEST_TEXT });
    const id = await h.changeId();
    await h.pump(async () => (await h.db.query(`SELECT 1 FROM codex_sessions WHERE state='running'`)).rows.length > 0);
    await new Promise(resolve => setTimeout(resolve, 100));
    const child = (await childOf(h.db, id))!;
    // 작업자가 닿지 않는 동안 lease가 끝났다. 여러 바퀴가 돌아도 지우거나 되찾지 않는다.
    h.worker.unreachable = true;
    await h.db.query(`UPDATE jobs SET lease_until=1 WHERE id=$1`, [child.id]);
    await h.store.expire();
    for (let round = 0; round < 3; round++) await h.runtime.laneTick();
    assert.equal((await childOf(h.db, id))!.state, 'unknown');
    assert.equal(await h.phase(id), 'authoring', '일시 장애로 부모를 닫지 않는다');
    await h.store.atomic(async store => { await store.db.query(`SELECT lane FROM execution_lanes WHERE lane='task' FOR UPDATE`); await store.syncTaskLane(); });
    assert.equal((await h.db.query<{ closed_reason: string | null }>(`SELECT closed_reason FROM execution_lanes WHERE lane='task'`)).rows[0]!.closed_reason, 'unknown');
    await h.command('300', 'change-status', { target: id });
    assert.match(h.acknowledgements().at(-1)!, /task-release/);
    // 사람이 해제하면 소멸을 확인하고 결과를 잃은 것으로 닫는다. 모델을 다시 돌리지 않는다.
    h.worker.unreachable = false;
    assert.equal((await h.bridge.release(OWNER, THREAD, child.id)).ok, true);
    await h.pump(async () => await h.phase(id) === 'failed');
    assert.equal((await h.changes.get(id) as any).value.phaseReason, 'task_worker_lost');
    assert.equal((await h.f.calls()).length, 1);
  });
});
test('호환 종료: 종료 신호를 받으면 긴 시험 대기에서 바로 깬다. 시험은 다시 돌리지 않고 다음 프로세스가 같은 receipt를 받는다', async () => {
  let release!: () => void;
  const hold = new Promise<void>(resolve => { release = resolve; });
  await withHarness({ sandbox: async () => { await hold; return { started: true, exitCode: 0, timedOut: false, overflow: false, aborted: false, log: Buffer.from('ok\n'), logBytes: 3, logDigest: 'a'.repeat(64) }; } }, async h => {
    await h.command('100', 'change', { target: REPO.fullName, text: REQUEST_TEXT });
    const id = await h.changeId();
    let stopping = false;
    const lane = (async () => { while (!stopping) { await h.runtime.laneTick(); await new Promise(resolve => setTimeout(resolve, 3)); } })();
    await until(() => h.runs.verify === 1, 8000);
    stopping = true;
    // 시험이 끝나지 않았는데 종료 신호에 바퀴가 끝난다.
    h.stop();
    await lane;
    assert.ok(h.logs.some(entry => entry.event === 'change_step_failed'));
    h.restart();
    release();
    await h.pump(async () => await h.phase(id) === 'awaiting_publish_approval');
    assert.equal(h.runs.verify, 1);
  });
});

// ---- 보존 ----

test('보존: 끝난 지 7일이 지난 건의 바이트·리뷰 원문만 지우고 receipt·digest·effect는 남긴다. 진행 중·미확정 건은 지우지 않는다', async () => {
  await withHarness({}, async h => {
    const id = await toAwaiting(h);
    assert.equal(await purgeExpiredChangeContent(h.db, Date.now() + CHANGE_RETENTION_MS + 1), 0, '승인 대기 중인 건은 지우지 않는다');
    assert.equal(Number((await h.db.query<{ count: string }>('SELECT count(*) FROM change_review_findings')).rows[0]!.count), 1, '리뷰 원문은 비공개 표에 있다');
    await h.command('101', 'change-cancel', { target: id });
    assert.equal(await purgeExpiredChangeContent(h.db, Date.now()), 0, '7일 전에는 지우지 않는다');
    const ended = Date.now() + CHANGE_RETENTION_MS + 1;
    assert.equal(await purgeExpiredChangeContent(h.db, ended), 1);
    assert.equal(Number((await h.db.query<{ count: string }>('SELECT count(*) FROM change_artifact_files WHERE change_id=$1', [id])).rows[0]!.count), 0);
    assert.equal(Number((await h.db.query<{ count: string }>('SELECT count(*) FROM change_review_findings')).rows[0]!.count), 0);
    const artifact = (await h.db.query<{ patch: string; artifact_digest: string; purged_at: string }>('SELECT patch,artifact_digest,purged_at FROM change_artifacts WHERE change_id=$1', [id])).rows[0]!;
    assert.equal(artifact.patch, '');
    assert.match(artifact.artifact_digest, /^[0-9a-f]{64}$/);
    assert.equal(Number((await h.db.query<{ count: string }>('SELECT count(*) FROM change_verifications WHERE change_id=$1', [id])).rows[0]!.count), 1);
    assert.equal(await purgeExpiredChangeContent(h.db, ended), 0, '다시 고르지 않는다');
    // artifact의 다른 칸은 그대로 고치지 못한다.
    await assert.rejects(h.db.query(`UPDATE change_artifacts SET result_tree=$2 WHERE change_id=$1`, [id, 'd'.repeat(40)]), /change_evidence_immutable/);
    await h.command('102', 'change-status', { target: id });
    assert.match(h.acknowledgements().at(-1)!, /보존 기간이 지나/);
  });
});
test('보존: 미확정 effect가 있으면 끝난 지 오래여도 지우지 않는다', async () => {
  await withHarness({}, async h => {
    const id = await toAwaiting(h);
    await h.command('101', 'change-publish', { target: id, text: await digestOf(h, id) });
    // 요청이 닿기 전에 끊겨 PR을 찾을 수 없다. 대조가 끝나지 않는다.
    h.env.github.fail(/POST .*\/pulls$/, 'reset_before_apply');
    await h.pump(async () => h.env.github.count(/POST .*\/pulls$/) > 0);
    assert.equal((await h.changes.transition({ changeId: id, generation: 1, from: 'publishing', to: 'cancelled', reason: 'owner_cancelled' })).ok, true);
    const unresolved = await h.changes.unresolvedEffects({ changeId: id });
    assert.ok(unresolved.length > 0);
    assert.equal(await purgeExpiredChangeContent(h.db, Date.now() + CHANGE_RETENTION_MS + 1), 0);
    assert.ok(Number((await h.db.query<{ count: string }>('SELECT count(*) FROM change_artifact_files WHERE change_id=$1', [id])).rows[0]!.count) > 0);
  });
});

// ---- 파서 ----

test('요청 서식: 알 수 없는 키·인수 조건 없음·제어 문자는 받지 않는다. label을 안 적으면 unknown이다', () => {
  assert.deepEqual(parseChangeRequest('요약 | accept=조건').ok && parseChangeRequest('요약 | accept=조건'), { ok: true, value: { summary: '요약', goal: '요약', acceptance: ['조건'], label: 'unknown' } });
  assert.equal((parseChangeRequest('요약') as { reason: string }).reason, 'acceptance_missing');
  assert.equal((parseChangeRequest('요약 | accept=a | token=x') as { reason: string }).reason, 'field_unknown');
  assert.equal((parseChangeRequest('요약 | accept=a | label=open') as { reason: string }).reason, 'label_invalid');
  assert.equal((parseChangeRequest('label=public | accept=a') as { reason: string }).reason, 'summary_missing');
  assert.equal((parseChangeRequest('요\u0007약 | accept=a') as { reason: string }).reason, 'control_character');
});

// ---- SEC-02 조립 ----

test('SEC-02 조립: 합성 자격이 있는 작업자에서 실제 무자격 실행기로 시험을 돌려도 자격·다른 세션을 읽지 못한다', { skip: bwrapReady ? false : 'bwrap으로 namespace를 만들 수 없다. 운영 이미지 절차(change-sec02)에서 돈다' }, async () => {
  const { FIXTURE_TOKEN } = await import('./change-worker-harness.js');
  // 경계가 뚫리면 종료 코드가 0이 아니라 passed가 나오지 않는다. 앞줄은 음성 대조다. 후보 파일이 보여야 시험이 돈 것이다.
  const script = (f: { base: string; root: string }) => [
    'test -f src/new.ts || exit 6', 'grep -q "a = 2" src/a.ts || exit 6',
    `test ! -e ${f.base} || exit 7`, `test ! -e ${f.root} || exit 7`,
    `cat /proc/*/environ 2>/dev/null | grep -q "${FIXTURE_TOKEN.slice(0, 24)}" && exit 8`,
    'test -z "$CLAUDE_CODE_OAUTH_TOKEN" || exit 8',
    'echo probe > src/a.ts 2>/dev/null && exit 9',
    'exit 0',
  ].join('; ');
  await withHarness({ script }, async h => {
    const id = await toAwaiting(h);
    assert.equal(h.runs.verify, 1);
    const row = (await h.db.query<{ status: string; exit_code: number; receipt: unknown }>('SELECT status,exit_code,receipt FROM change_verifications WHERE change_id=$1', [id])).rows[0]!;
    assert.equal(row.status, 'passed', `종료 코드 ${row.exit_code}`);
    assert.ok(!JSON.stringify(row.receipt).includes(FIXTURE_TOKEN), 'receipt에 자격이 없다');
    assert.ok(!JSON.stringify(row.receipt).includes('src/a.ts'), 'receipt에 로그 원문이 없다');
  });
});
test('SEC-02 조립 음성 대조: 경계 검사가 실제로 실패할 수 있다. 후보 파일이 없다고 나오면 시험 실패로 막힌다', { skip: bwrapReady ? false : 'bwrap으로 namespace를 만들 수 없다' }, async () => {
  await withHarness({ script: 'test -e /etc/never-mounted-fixture || exit 6' }, async h => {
    await h.command('100', 'change', { target: REPO.fullName, text: REQUEST_TEXT });
    const id = await h.changeId();
    await h.pump(async () => await h.phase(id) === 'blocked');
    assert.equal((await h.changes.get(id) as any).value.phaseReason, 'verification_failed');
  });
});
test('DATA-01 메모리: 변경 경로의 어떤 모듈도 기억 서비스와 대화 맥락을 import하지 않는다', async () => {
  for (const file of ['change-runtime', 'change-commands', 'change-assembly', 'change-publisher', 'change-publication', 'change-review']) {
    const source = await readFile(`src/${file}.ts`, 'utf8');
    assert.doesNotMatch(source, /from '\.\/(memory|memory-commands|chat-context)\.js'/, file);
  }
});
test('CI 선확인: 승인되지 않은 CI 형태면 모델을 한 번도 부르지 않고 닫고, 사람이 등록할 값을 로그에 남긴다', async () => {
  await withHarness({ policyPatch: policy => ({ ...policy, change: { repositories: [{ ...policy.change!.repositories[0]!, ci: { ...policy.change!.repositories[0]!.ci, approvedFingerprint: '0'.repeat(64) } }] } }) }, async h => {
    h.policy.current = { ...h.policy.current };
    await h.command('100', 'change', { target: REPO.fullName, text: REQUEST_TEXT });
    const id = await h.changeId();
    await h.pump(async () => await h.phase(id) === 'blocked');
    assert.equal((await h.changes.get(id) as any).value.phaseReason, 'ci_fingerprint_unapproved');
    assert.ok(h.logs.some(entry => entry.event === 'change_ci_fingerprint_unapproved'));
    assert.equal((await h.f.calls()).length, 0);
  });
});
test('AC-P8 전: writerAccepted가 false면 승인을 받지 않고 대기에 둔다. 영구 차단으로 닫지 않는다', async () => {
  await withHarness({}, async h => {
    const id = await toAwaiting(h);
    const digest = await digestOf(h, id);
    const open = h.policy.current;
    h.policy.current = { ...open, change: { repositories: [{ ...open.change!.repositories[0]!, writerAccepted: false }] } };
    await h.command('101', 'change-publish', { target: id, text: digest });
    assert.equal(await h.phase(id), 'awaiting_publish_approval');
    assert.match(h.acknowledgements().at(-1)!, /AC-P8/);
    assert.equal(h.env.github.mutations().length, 0);
    h.policy.current = open;
    await h.command('102', 'change-publish', { target: id, text: digest });
    assert.equal(await h.phase(id), 'approved');
  });
});
test('권한 철회: 작성 중 owner가 바뀌면 부모를 닫고 돌던 턴의 소멸을 확인해 레인을 놓는다. 새 실행·공개 효과가 없다', async () => {
  await withHarness({ steps: [{ kind: 'hang' }] }, async h => {
    await h.command('100', 'change', { target: REPO.fullName, text: REQUEST_TEXT });
    const id = await h.changeId();
    await h.pump(async () => (await h.db.query(`SELECT 1 FROM codex_sessions WHERE state='running'`)).rows.length > 0);
    h.policy.current = { ...h.policy.current, owner: 'fixture-new-owner' };
    await h.pump(async () => await h.phase(id) === 'cancelled');
    assert.equal((await h.changes.get(id) as any).value.phaseReason, 'authorization_revoked');
    await h.pump(async () => !(await h.store.laneBusy('task')));
    assert.equal(h.runs.verify, 0);
    assert.equal(h.env.github.mutations().length, 0);
  });
});
test('사람 취소: 시험을 기다리는 중에도 /change-cancel이 시한까지 기다리지 않고 시험을 멈춘다', async () => {
  await withHarness({ sandbox: (_args, _limits, signal) => new Promise(resolve => { signal.addEventListener('abort', () => resolve({ started: true, exitCode: null, timedOut: false, overflow: false, aborted: true, log: Buffer.from(''), logBytes: 0, logDigest: 'a'.repeat(64) })); }) }, async h => {
    await h.command('100', 'change', { target: REPO.fullName, text: REQUEST_TEXT });
    const id = await h.changeId();
    let stopping = false;
    const lane = (async () => { while (!stopping) { await h.runtime.laneTick(); await new Promise(resolve => setTimeout(resolve, 3)); } })();
    await until(() => h.runs.verify === 1, 8000);
    await h.command('101', 'change-cancel', { target: id });
    assert.equal(await h.phase(id), 'cancelled');
    for (let round = 0; round < 400 && await h.store.laneBusy('task'); round++) { await h.runtime.childrenTick(); await new Promise(resolve => setTimeout(resolve, 5)); }
    stopping = true;
    await lane;
    assert.equal(await h.store.laneBusy('task'), false);
    assert.equal(h.reviewInputs.length, 0);
  });
});
test('호환 작업자: 옛 작업자(v2 없음)면 CHANGE는 admitted에서 멈추고 부모를 닫지 않는다', async () => {
  await withHarness({ change: false }, async h => {
    assert.equal(await h.f.port.supportsChange(), false);
    await h.command('100', 'change', { target: REPO.fullName, text: REQUEST_TEXT });
    const id = await h.changeId();
    for (let round = 0; round < 3; round++) await h.runtime.laneTick();
    assert.equal(await h.phase(id), 'admitted');
    assert.equal((await h.f.calls()).length, 0);
  });
});
