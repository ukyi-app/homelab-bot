import { after, afterEach, before, beforeEach, test } from 'node:test';
import assert from 'node:assert/strict';
import { createHmac, generateKeyPairSync } from 'node:crypto';
import { COMMAND_DEFINITIONS, FOUNDATION_COMMANDS, MEMORY_COMMANDS, REVIEW_COMMANDS, commandDefinitions } from '../src/commands.js';
import type { PublisherConfig } from '../src/config.js';
import { reviewPrecondition, reviewWorkerRouted, startPublisher } from '../src/main.js';
import type { Publisher, PublisherDeps } from '../src/main.js';
import { loadRuntimePolicy } from '../src/policy.js';
import { ReviewPublisher, ReviewReconciler, ReviewRuntime } from '../src/review.js';
import { Store } from '../src/store.js';
import { FakeGateway } from './fake-gateway.js';
import { localDatabase } from './helpers.js';
import { CHAT, GUILD, NOTIFY, OWNER, Rest, Trace, waitFor } from './t20-harness.js';

// 게시 서버 조립 시험. 네트워크를 쓰지 않는다. GitHub·작업자는 send 주입 가짜, Discord는 loopback 가짜 Gateway다. 값은 모두 가짜다.
const SECRET = 'fixture-webhook-secret-value';
const REPO = { id: 101, full_name: 'fixture-org/fixture-repo' };
const BASE = 'a'.repeat(40), HEAD = 'b'.repeat(40), MERGE_BASE = '9'.repeat(40), BASE_TREE = 'c'.repeat(40), HEAD_TREE = 'd'.repeat(40);
const APP = { appId: '12345', privateKey: generateKeyPairSync('rsa', { modulusLength: 2048 }).privateKey };
const REVIEW = { repositories: [{ id: REPO.id, fullName: REPO.full_name, installationId: 501, visibility: 'public' }],
  allowedBotAuthorIds: [], commentCommand: '/homelab-review', reviewDrafts: false, rereviewOnBaseMove: false, comparison: 'merge_base',
  reviewSince: 1, internalMarkers: [], input: { maxFiles: 20, maxFileBytes: 100_000, maxDiffBytes: 200_000, maxArchiveBytes: 1_000_000, maxBodyChars: 4000 },
  publish: { maxFindings: 10, maxInlineComments: 5, maxBodyChars: 20_000 }, reconcile: { maxPages: 1, maxReviewsPerRun: 5 } };
const OUTPUT = { findings: [{ severity: 'P1', title: '0으로 나누기', path: 'src/app.ts', line: 2, condition: 'count가 0일 때',
  impact: 'NaN이 전파된다', evidence: 'return total / count;', suggestion: 'count 0을 거부한다' }], open_questions: [], public_summary: '경계 조건을 확인하세요.' };
const SUCCEEDED = { status: 'succeeded', stopped: true, coverage: { checked_files: ['src/app.ts'], omitted_files_with_reasons: [], limits_hit: [] },
  positions: [{ path: 'src/app.ts', lines: [2] }], output: OUTPUT };
const pull = (o: Record<string, unknown> = {}) => ({ number: 7, state: 'open', draft: false, merged: false, title: '수정', body: '본문',
  user: { id: 42, login: 'fixture-member', type: 'User' }, author_association: 'MEMBER', updated_at: '2026-11-04T00:00:00Z',
  head: { sha: HEAD, ref: 'feature', repo: REPO }, base: { sha: BASE, ref: 'main', repo: REPO }, ...o });
const json = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status, headers: { 'content-type': 'application/json' } });
type Task = { job: string; base: string; head: string; changes: { path: string }[] };

// GitHub와 작업자 흉내. 서비스별 호출을 따로 센다.
class World {
  routed = true;
  workerDown = false;
  cancelStopped = true;
  probes = 0;
  cancels = 0;
  tasks: Task[] = [];
  github: string[] = [];
  posted: { commit_id: string; event: string; body: string; comments: unknown[] }[] = [];
  open: unknown[] = [];
  holdPull: Promise<void> | undefined;
  reply: (task: Task, signal: AbortSignal) => Promise<unknown> = async () => SUCCEEDED;
  readonly send: typeof fetch = async (input, init = {}) => {
    const url = new URL(String(input));
    if (url.hostname === 'api.github.com') return this.api(init.method ?? 'GET', `${url.pathname}${url.search}`, init);
    if (url.hostname === 'worker.fixture') return this.worker(url.pathname, init);
    return new Response('OK');
  };
  private async worker(path: string, init: RequestInit): Promise<Response> {
    const auth = new Headers(init.headers).get('authorization');
    if (!auth) {
      this.probes++;
      if (this.workerDown) throw new TypeError('fetch failed');
      return json({ status: 'rejected', started: false }, this.routed ? 401 : 404);
    }
    if (path === '/v1/review/cancel') { this.cancels++; return json({ stopped: this.cancelStopped }); }
    assert.equal(path, '/v1/review');
    assert.match(auth, /^Capability /);
    const task = JSON.parse(String(init.body)) as Task;
    this.tasks.push(task);
    return json(await this.reply(task, init.signal!));
  }
  private async api(method: string, path: string, init: RequestInit): Promise<Response> {
    this.github.push(`${method} ${path}`);
    const repo = `/repos/${REPO.full_name}`;
    if (method === 'POST' && path === '/app/installations/501/access_tokens') {
      const body = JSON.parse(String(init.body)) as { permissions: Record<string, string> };
      return json({ token: 'ghs_fixtureInstallationTokenValue0001', expires_at: new Date(Date.now() + 3_600_000).toISOString(),
        permissions: body.permissions, repositories: [REPO] }, 201);
    }
    if (method === 'GET' && path === `${repo}/pulls/7`) { await this.holdPull; return json(pull()); }
    if (method === 'GET' && path.startsWith(`${repo}/pulls?state=open`)) return json(this.open);
    if (method === 'GET' && path === `${repo}/compare/${BASE}...${HEAD}?per_page=1`) {
      return json({ base_commit: { sha: BASE }, merge_base_commit: { sha: MERGE_BASE } });
    }
    if (method === 'GET' && path === `${repo}/git/commits/${MERGE_BASE}`) return json({ sha: MERGE_BASE, tree: { sha: BASE_TREE } });
    if (method === 'GET' && path === `${repo}/git/commits/${HEAD}`) return json({ sha: HEAD, tree: { sha: HEAD_TREE } });
    if (method === 'GET' && (path === `${repo}/git/trees/${BASE_TREE}?recursive=1` || path === `${repo}/git/trees/${HEAD_TREE}?recursive=1`)) {
      const sha = path.includes(BASE_TREE) ? BASE_TREE : HEAD_TREE;
      return json({ sha, truncated: false, tree: [{ path: 'src/app.ts', mode: '100644', type: 'blob', sha: sha === BASE_TREE ? 'e'.repeat(40) : 'f'.repeat(40) }] });
    }
    if (method === 'POST' && path === `${repo}/pulls/7/reviews`) {
      this.posted.push(JSON.parse(String(init.body)) as World['posted'][number]);
      return json({ id: 9001 }, 201);
    }
    throw new Error(`unexpected_github_${method}_${path}`);
  }
}
const hang = (_task: Task, signal: AbortSignal) => new Promise<unknown>((_resolve, reject) => {
  signal.addEventListener('abort', () => reject(new Error('fixture_aborted')), { once: true });
});

class CommandRest extends Rest {
  guild: { name: string }[] = [];
  puts = 0;
  override async request(method: 'GET' | 'POST' | 'PUT', path: string, body?: unknown): Promise<unknown> {
    if (path === `/applications/fixture-app/guilds/${GUILD}/commands`) {
      if (method === 'PUT') { this.guild = body as { name: string }[]; this.puts++; }
      return this.guild;
    }
    return super.request(method, path, body);
  }
  names() { return this.guild.map(c => c.name).sort(); }
}

let database: Awaited<ReturnType<typeof localDatabase>>;
let gw: FakeGateway;
let rest: CommandRest;
let world: World;
let publisher: Publisher | undefined;
let logs: { event: string; detail?: Record<string, unknown> }[];
before(async () => { database = await localDatabase(); });
after(async () => { await database.pg.close(); });
beforeEach(async () => {
  const tables = (await database.pg.query<{ tablename: string }>(
    "SELECT tablename FROM pg_tables WHERE schemaname='public' AND tablename<>'schema_migrations'")).rows.map(r => r.tablename);
  await database.pg.exec(`TRUNCATE ${tables.join(',')} RESTART IDENTITY CASCADE`);
  gw = new FakeGateway(); gw.options.identifyIntervalMs = 250; await gw.start();
  rest = new CommandRest(new Trace()); world = new World(); logs = [];
});
afterEach(async () => { await publisher?.stop(); publisher = undefined; await gw.close(); });

function config(extra: Partial<PublisherConfig> = {}, review: unknown = REVIEW): PublisherConfig {
  return { databaseUrl: 'postgresql://unused', discordToken: 'fixture-discord-token',
    policy: loadRuntimePolicy(JSON.stringify({ revision: 'fixture-v1', owner: OWNER, guild: GUILD, conversationChannel: CHAT,
      notificationChannel: NOTIFY, dmEnabled: false, services: ['homelab-bot'], ...(review === null ? {} : { review }) }), Date.now()),
    grafana: { url: 'http://grafana.fixture/', token: 'fixture-grafana-token' }, kubernetes: { url: 'https://kube.fixture/' },
    workerUrl: 'http://worker.fixture/', healthchecksUrl: 'https://hc.fixture/ping', workerKey: generateKeyPairSync('ed25519').privateKey,
    githubWebhookSecret: SECRET, reviewEnabled: true, githubReviewApp: APP, ...extra };
}
async function boot(cfg: PublisherConfig, deps: Partial<PublisherDeps> = {}) {
  publisher = await startPublisher(cfg, { db: database.db, discord: rest, send: world.send, gatewayUrl: async () => ({ url: gw.url }),
    allowGatewayUrl: url => url.hostname === '127.0.0.1', serviceAccount: { tokenFile: '/nonexistent', caFile: null },
    ports: { app: 0, alerts: 0 }, idleMs: 20, identifySpacingMs: 250, registerDelaysMs: [0, 20, 20], heartbeatEveryMs: 60_000,
    stopTimeoutMs: 3000, reviewWorkerProbeMs: 30, log: (event, detail) => logs.push({ event, detail }), ...deps });
  return publisher;
}
const registered = () => waitFor(() => rest.puts > 0);
let delivery = 0;
async function webhook(p: Publisher, payload: unknown, event = 'pull_request') {
  const body = JSON.stringify(payload);
  return (await fetch(`http://127.0.0.1:${p.ports.app}/github`, { method: 'POST', body, headers: { 'content-type': 'application/json',
    'x-hub-signature-256': `sha256=${createHmac('sha256', SECRET).update(body).digest('hex')}`,
    'x-github-delivery': `fixture-delivery-${++delivery}`, 'x-github-event': event } })).status;
}
const opened = (pr: unknown = pull()) => ({ action: 'opened', number: 7, pull_request: pr, repository: REPO, installation: { id: 501 } });
const lastDelivery = async () => (await database.db.query<{ outcome: string; reason: string | null }>(
  'SELECT outcome,reason FROM github_deliveries ORDER BY received_at DESC,delivery_id DESC LIMIT 1')).rows[0]!;
const reviewJobs = async () => (await database.db.query<{ id: string; state: string; wait_reason: string | null; attempt: number; trigger: string }>(
  `SELECT j.id,j.state,j.wait_reason,j.attempt,p.trigger FROM jobs j JOIN pr_reviews p ON p.job_id=j.id ORDER BY j.created_at`)).rows;
const deliveries = async () => (await database.db.query<{ state: string; reason: string | null }>('SELECT state,reason FROM review_deliveries')).rows;
const count = async (table: string) => Number((await database.db.query<{ count: string }>(`SELECT count(*) FROM ${table}`)).rows[0]!.count);
let interactions = 9000;
function command(name: string, channel: string, options: Record<string, string> = {}, actor = OWNER) {
  const id = String(++interactions);
  gw.dispatch(gw.latest, interactions, 'INTERACTION_CREATE', { id, token: `fixture-token-${id}`, type: 2, channel_id: channel, guild_id: GUILD,
    member: { user: { id: actor } }, data: { name, options: Object.entries(options).map(([key, value]) => ({ name: key, value })) } });
  return id;
}
const gate = () => logs.filter(l => l.event === 'review_gate').map(l => l.detail);

test('T17 열림 조건: 스위치·자격·정책 조합', () => {
  const closed = (extra: Partial<PublisherConfig>) => reviewPrecondition(config(extra));
  assert.deepEqual(closed({ reviewEnabled: false }), { open: false, reason: 'switch_off' });
  assert.deepEqual(closed({ reviewEnabled: undefined }), { open: false, reason: 'switch_off' });
  assert.deepEqual(closed({ reviewEnabled: false, githubReviewApp: null }), { open: false, reason: 'switch_off' });
  assert.deepEqual(closed({ githubReviewApp: null }), { open: false, reason: 'app_missing' });
  assert.deepEqual(closed({ githubReviewApp: undefined }), { open: false, reason: 'app_missing' });
  for (const [why, review] of [['없음', null], ['comparison null', { ...REVIEW, comparison: null }], ['형식 오류', { ...REVIEW, unknown_field: 1 }],
    ['필수 값 빠짐', { ...REVIEW, input: undefined }]] as const) {
    assert.deepEqual(reviewPrecondition(config({}, review)), { open: false, reason: 'policy_invalid' }, why);
  }
  const open = reviewPrecondition(config());
  assert.equal(open.open, true);
  // publish:null은 닫는 조건이 아니다. 모델을 부르지 않게 하려면 스위치를 끈다.
  assert.equal(reviewPrecondition(config({}, { ...REVIEW, publish: null })).open, true);
});

test('T17 작업자 조건: 401만 준비로 보고, capability 없이 POST', async () => {
  const signal = new AbortController().signal;
  const calls: { url: string; init?: RequestInit }[] = [];
  const respond = (status: number): typeof fetch => async (url, init) => { calls.push({ url: String(url), init }); return new Response(null, { status }); };
  assert.equal(await reviewWorkerRouted('http://worker.fixture/', respond(401), signal), true);
  for (const status of [200, 403, 404, 500, 503]) assert.equal(await reviewWorkerRouted('http://worker.fixture/', respond(status), signal), false, String(status));
  assert.equal(await reviewWorkerRouted('http://worker.fixture/', async () => { throw new TypeError('fetch failed'); }, signal), false);
  assert.equal(calls[0]!.url, 'http://worker.fixture/v1/review');
  assert.equal(calls[0]!.init!.method, 'POST'); assert.equal(calls[0]!.init!.redirect, 'error');
  assert.equal(new Headers(calls[0]!.init!.headers).has('authorization'), false); assert.equal(calls[0]!.init!.body, undefined);
});

test('T17 명령 목록: 리뷰가 열릴 때만 세 명령이 더해짐', () => {
  const names = (list: readonly unknown[]) => (list as { name: string }[]).map(c => c.name);
  assert.equal(commandDefinitions(false), COMMAND_DEFINITIONS);
  assert.deepEqual(names(commandDefinitions(false, true)), [...FOUNDATION_COMMANDS, ...REVIEW_COMMANDS]);
  assert.deepEqual(names(commandDefinitions(true, true)), [...FOUNDATION_COMMANDS, ...MEMORY_COMMANDS, ...REVIEW_COMMANDS]);
  for (const definition of commandDefinitions(false, true)) assert.ok(definition.description.length <= 100);
});

const STATIC_CLOSED: [string, () => PublisherConfig, string][] = [
  ['스위치 꺼짐', () => config({ reviewEnabled: false }), 'switch_off'],
  ['자격 없음', () => config({ githubReviewApp: null }), 'app_missing'],
  ['comparison null', () => config({}, { ...REVIEW, comparison: null }), 'policy_invalid'],
  ['review 절 없음', () => config({}, null), 'policy_invalid'],
];
for (const [name, make, reason] of STATIC_CLOSED) {
  test(`T17 닫힘(${name}): webhook은 review_disabled, GitHub·작업자를 부르지 않고 명령도 없음`, async () => {
    const p = await boot(make());
    await registered();
    assert.equal(await webhook(p, opened()), 202);
    assert.deepEqual(await lastDelivery(), { outcome: 'ignored', reason: 'review_disabled' });
    assert.deepEqual(rest.names(), [...FOUNDATION_COMMANDS].sort());
    command('review-status', NOTIFY);
    await new Promise(resolve => setTimeout(resolve, 100));
    assert.equal(await count('events'), 0);
    assert.equal(await count('jobs'), 0);
    assert.deepEqual([world.github, world.probes], [[], 0]);
    assert.deepEqual(gate(), [{ state: 'closed', reason }]);
  });
}

for (const [name, setup] of [['옛 이미지(404)', (w: World) => { w.routed = false; }], ['연결 실패', (w: World) => { w.workerDown = true; }]] as const) {
  test(`T17 닫힘(작업자 ${name}): 네 조건 중 하나라도 아니면 열지 않음`, async () => {
    setup(world);
    world.open = [pull()];
    const p = await boot(config());
    await registered();
    await waitFor(() => world.probes >= 3);
    assert.equal(await webhook(p, opened()), 202);
    assert.deepEqual(await lastDelivery(), { outcome: 'ignored', reason: 'review_disabled' });
    assert.deepEqual(rest.names(), [...FOUNDATION_COMMANDS].sort());
    assert.deepEqual([world.github, world.tasks, await count('jobs')], [[], [], 0]);
    assert.deepEqual(gate(), [{ state: 'waiting_worker', publishLimitsSet: true, reviewSinceSet: true }]);
  });
}

test('T17 열림 조립: opened → 작업 생성 → 작업자 → COMMENT 게시 → Discord 요약, 리뷰 명령 등록', async () => {
  const p = await boot(config());
  await waitFor(() => rest.names().includes('review-status'));
  assert.deepEqual(rest.names(), [...FOUNDATION_COMMANDS, ...REVIEW_COMMANDS].sort());
  assert.equal(await webhook(p, opened()), 202);
  assert.deepEqual((await lastDelivery()).outcome, 'queued');
  await waitFor(() => world.posted.length === 1);
  // 비교 기준은 결정대로 merge base, 게시는 COMMENT와 검토한 head뿐이다.
  assert.deepEqual([world.tasks[0]!.base, world.tasks[0]!.head, world.tasks[0]!.changes.map(c => c.path)], [MERGE_BASE, HEAD, ['src/app.ts']]);
  assert.deepEqual([world.posted[0]!.event, world.posted[0]!.commit_id], ['COMMENT', HEAD]);
  assert.match(world.posted[0]!.body, /0으로 나누기/);
  await waitFor(() => rest.sent.some(m => m.channel === NOTIFY && m.content.includes('PR 리뷰 게시: fixture-org/fixture-repo#7')));
  assert.deepEqual((await reviewJobs()).map(j => [j.state, j.trigger]), [['succeeded', 'opened']]);
  assert.deepEqual((await deliveries()).map(d => d.state), ['sent']);
  // 같은 세대는 다시 넣지 않는다.
  assert.equal(await webhook(p, opened()), 202);
  assert.equal((await lastDelivery()).outcome, 'duplicate_generation');
  assert.equal(world.tasks.length, 1);
  assert.deepEqual(gate().at(-1), { state: 'open' });
});

test('T17 열림: publish:null은 모델 호출을 끄지 않고 게시만 막음', async () => {
  const p = await boot(config({}, { ...REVIEW, publish: null }));
  await waitFor(() => rest.names().includes('review-status'));
  assert.equal(gate()[0]!.publishLimitsSet, false);
  assert.equal(await webhook(p, opened()), 202);
  await waitFor(async () => (await deliveries()).length === 1);
  assert.deepEqual(await deliveries(), [{ state: 'blocked', reason: 'publish_limits_unset' }]);
  assert.equal(world.tasks.length, 1);
  assert.deepEqual(world.posted, []);
});

test('T17 늦은 열림: 작업자가 나중에 준비되면 명령을 다시 등록하고 재조정이 놓친 PR을 넣음, reviewSince 이전 PR은 제외', async () => {
  world.routed = false;
  world.open = [pull(), pull({ number: 8, updated_at: '2026-10-01T00:00:00Z' })];
  const p = await boot(config({}, { ...REVIEW, reviewSince: Date.parse('2026-11-01T00:00:00Z') }));
  await registered();
  assert.equal(await webhook(p, opened()), 202);
  assert.deepEqual(await lastDelivery(), { outcome: 'ignored', reason: 'review_disabled' });
  assert.deepEqual(rest.names(), [...FOUNDATION_COMMANDS].sort());
  world.routed = true;
  await waitFor(() => rest.names().includes('review-status'));
  await waitFor(() => world.posted.length === 1);
  const jobs = await reviewJobs();
  assert.deepEqual(jobs.map(j => j.trigger), ['reconcile']);
  assert.equal((await database.db.query<{ pr_number: number }>('SELECT pr_number FROM pr_reviews')).rows[0]!.pr_number, 7);
});

test('B5 레인: 작업 레인을 켜면 리뷰가 대화 슬롯만 보고, 켜지 않으면 실행 중 작업 job이 리뷰를 막음', async () => {
  const store = new Store(database.db);
  const scope = { kind: 'thread', guild: GUILD, channel: 'fixture-thread', parent: CHAT } as const;
  const saved = await store.save({ id: 'b5-task', actor: OWNER, scope, text: '작업', kind: 'command', command: 'task', target: 'fixture' }, 'fixture-v1', true);
  await store.accept(saved.id, 'task', 'fixture-v1');
  await database.db.query("UPDATE conversations SET active=true");
  assert.equal((await store.claim('task'))?.type, 'task');
  const heartbeat = setInterval(() => { void database.db.query(`UPDATE jobs SET lease_until=$1 WHERE type='task'`, [Date.now() + 60_000]); }, 200);
  try {
    const off = await boot(config());
    await waitFor(() => rest.names().includes('review-status'));
    assert.equal(await webhook(off, opened()), 202);
    await new Promise(resolve => setTimeout(resolve, 150));
    assert.deepEqual(world.tasks, [], '단일 슬롯이면 작업 job이 리뷰를 막는다');
    await off.stop(); publisher = undefined;
    // 켠 배치: 정책에 task 절이 있다. 작업자 확인 전이라 작업 명령은 닫혀 있어도 슬롯은 나뉜다.
    const task = { projects: [{ id: 'fixture', revision: 'r1', repository: 'fixture-org/fixture-repo', branch: 'main', allowedPaths: ['src'], forbiddenPaths: [], verifyCommands: [] }] };
    const policy = loadRuntimePolicy(JSON.stringify({ revision: 'fixture-v1', owner: OWNER, guild: GUILD, conversationChannel: CHAT, notificationChannel: NOTIFY, dmEnabled: false,
      services: ['homelab-bot'], review: REVIEW, task }), Date.now());
    await boot(config({ policy, taskLane: { workerUrl: 'http://worker-task.fixture/' } }));
    await waitFor(() => world.posted.length === 1);
    assert.equal(world.tasks.length, 1);
  } finally { clearInterval(heartbeat); }
});

test('T17 첫 READY 전: webhook은 대기열에 넣지만 claim은 장벽 뒤로 미룸', async () => {
  const p = await boot(config(), { gatewayUrl: () => new Promise(() => {}) });
  await waitFor(() => world.probes >= 1 && gate().some(g => g!.state === 'open'));
  assert.equal(await webhook(p, opened()), 202);
  assert.equal((await lastDelivery()).outcome, 'queued');
  await new Promise(resolve => setTimeout(resolve, 200));
  assert.deepEqual((await reviewJobs()).map(j => j.state), ['queued']);
  assert.deepEqual(world.tasks, []);
});

test('T17 열린 뒤 작업자 후퇴: 새 claim만 멈추고 webhook·명령은 유지, 복구되면 이어서 실행', async () => {
  const p = await boot(config());
  await waitFor(() => rest.names().includes('review-status'));
  world.routed = false;
  const seen = world.probes;
  await waitFor(() => world.probes >= seen + 2);
  assert.equal(await webhook(p, opened()), 202);
  assert.equal((await lastDelivery()).outcome, 'queued');
  await new Promise(resolve => setTimeout(resolve, 150));
  assert.deepEqual((await reviewJobs()).map(j => j.state), ['queued']);
  assert.deepEqual(world.tasks, []);
  assert.ok(rest.names().includes('review-status'));
  world.routed = true;
  await waitFor(() => world.posted.length === 1);
});

test('T17 종료 drain: 드레인 안에 끝나면 결과를 저장하고 cancel 없음, 종료 중에는 새 게시를 잡지 않음', async () => {
  let release!: () => void;
  const held = new Promise<void>(resolve => { release = resolve; });
  world.reply = async () => { await held; return SUCCEEDED; };
  const p = await boot(config(), { drainMs: 5000 });
  await waitFor(() => rest.names().includes('review-status'));
  assert.equal(await webhook(p, opened()), 202);
  await waitFor(() => world.tasks.length === 1);
  const stopping = p.stop();
  publisher = undefined;
  await new Promise(resolve => setTimeout(resolve, 50));
  release();
  await stopping;
  assert.equal(world.cancels, 0);
  assert.deepEqual((await reviewJobs()).map(j => j.state), ['succeeded']);
  assert.deepEqual((await deliveries()).map(d => d.state), ['pending']);
  assert.deepEqual(world.posted, []);
});

test('T17 종료 drain: 기한을 넘기면 cancel을 한 번 보내고 멈춤 확인 시 failed, 대기 작업은 claim하지 않음', async () => {
  world.reply = hang;
  const p = await boot(config(), { drainMs: 50 });
  await waitFor(() => rest.names().includes('review-status'));
  assert.equal(await webhook(p, opened()), 202);
  await waitFor(() => world.tasks.length === 1);
  // 슬롯이 하나라 다음 PR은 대기한다. 앞 작업이 끝나 슬롯이 비어도 종료 중에는 집지 않는다.
  assert.equal(await webhook(p, opened(pull({ number: 8 }))), 202);
  await p.stop();
  publisher = undefined;
  assert.equal(world.cancels, 1);
  assert.deepEqual((await reviewJobs()).map(j => [j.state, j.wait_reason]), [['failed', 'stop_confirmation'], ['queued', null]]);
  const audit = (await database.db.query<{ detail: { outcome: string; type: string } }>("SELECT detail FROM audit WHERE kind='publisher_shutdown'")).rows;
  assert.deepEqual(audit.map(a => [a.detail.type, a.detail.outcome]), [['review', 'failed']]);
  assert.equal(world.tasks.length, 1);
});

test('T17 종료 drain: 멈춤을 확인하지 못하면 unknown(publisher_shutdown)', async () => {
  world.reply = hang;
  world.cancelStopped = false;
  const p = await boot(config(), { drainMs: 50 });
  await waitFor(() => rest.names().includes('review-status'));
  assert.equal(await webhook(p, opened()), 202);
  await waitFor(() => world.tasks.length === 1);
  await p.stop();
  publisher = undefined;
  assert.equal(world.cancels, 1);
  assert.deepEqual((await reviewJobs()).map(j => [j.state, j.wait_reason]), [['unknown', 'publisher_shutdown']]);
});

test('T17 종료: dispatch 전 GitHub 조회 중이면 기다리지 않고 대기열로 되돌림(시도 소모·모델 호출 없음)', async () => {
  world.holdPull = new Promise(() => {});
  const p = await boot(config(), { drainMs: 5000 });
  await waitFor(() => rest.names().includes('review-status'));
  assert.equal(await webhook(p, opened()), 202);
  const pulls = `GET /repos/${REPO.full_name}/pulls/7`;
  await waitFor(() => world.github.includes(pulls));
  const started = Date.now();
  await p.stop();
  publisher = undefined;
  assert.ok(Date.now() - started < 2500, `stop ${Date.now() - started}ms`);
  assert.deepEqual((await reviewJobs()).map(j => [j.state, j.wait_reason, j.attempt]), [['queued', 'publisher_shutdown', 0]]);
  assert.deepEqual(world.tasks, []);
  const audit = (await database.db.query<{ detail: { outcome: string } }>("SELECT detail FROM audit WHERE kind='publisher_shutdown'")).rows;
  assert.deepEqual(audit.map(a => a.detail.outcome), ['deferred']);
});

test('T17 종료: 신호 뒤 runtime·publisher·reconciler는 저장소와 GitHub에 닿지 않음', async () => {
  const signal = AbortSignal.abort();
  const untouched = new Proxy({}, { get(_target, name) { throw new Error(`touched_${String(name)}`); } }) as never;
  assert.equal(await new ReviewRuntime(untouched, untouched, untouched, untouched, untouched, untouched, 1000, { shutdown: signal }).tick(), false);
  const publisher = new ReviewPublisher(untouched, untouched, untouched, untouched, untouched, 1000, signal);
  assert.equal(await publisher.deliver(), false);
  await publisher.reconcile();
  const policy = { current: async () => ({ review: { repositories: REVIEW.repositories, reconcile: REVIEW.reconcile } }) } as never;
  assert.deepEqual(await new ReviewReconciler(untouched, policy, untouched, untouched, signal).run(), { admitted: 0, limited: false });
});

test('T17 제어 명령: owner가 알림 채널에서만 동작, 다른 채널·다른 사용자는 작업을 바꾸지 못함', async () => {
  world.reply = hang;
  const p = await boot(config());
  await waitFor(() => rest.names().includes('review-status'));
  assert.equal(await webhook(p, opened()), 202);
  await waitFor(() => world.tasks.length === 1);
  const job = (await reviewJobs())[0]!;
  command('review-status', NOTIFY);
  await waitFor(() => rest.sent.some(m => m.channel === NOTIFY && m.content.includes(job.id)));
  command('review-cancel', CHAT, { target: job.id });
  await waitFor(() => rest.sent.some(m => m.channel === CHAT && m.content.includes('owner가 알림 채널에서만')));
  const before = await count('events');
  command('review-cancel', NOTIFY, { target: job.id }, 'fixture-intruder');
  await new Promise(resolve => setTimeout(resolve, 100));
  assert.equal(await count('events'), before);
  assert.deepEqual((await reviewJobs()).map(j => j.state), ['running']);
  assert.equal(world.cancels, 0);
  command('review-cancel', NOTIFY, { target: job.id });
  await waitFor(async () => (await reviewJobs())[0]!.state === 'cancelled');
  assert.equal(world.cancels, 1);
  await p.stop();
  publisher = undefined;
});
