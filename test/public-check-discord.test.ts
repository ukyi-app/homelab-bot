import { after, before, beforeEach, test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { BRIEFING_TEXT, BriefingScheduler, localDate, nextSlot } from '../src/briefing.js';
import type { ObservationSource } from '../src/briefing.js';
import { SERVICES, TEMPLATES } from '../src/catalog.js';
import { CHAT_TASK_TEXT } from '../src/chat-task-text.js';
import { CONTROL_TEXT, controlText } from '../src/control-format.js';
import { DiscordPublisher } from '../src/discord.js';
import { ExternalTaskLinks, outboxKey } from '../src/external-task-links.js';
import { FIXED_SUMMARY } from '../src/external-task-receiver.js';
import type { MemoryService, MemoryView } from '../src/memory.js';
import type { OutboundBytes } from '../src/outbound.js';
import { publicAlias } from '../src/public-alias.js';
import { PUBLIC_WITHHELD } from '../src/public-check.js';
import { ReadAdapter, readSummary } from '../src/read.js';
import type { ReadResult } from '../src/read.js';
import { repositoryPolicy } from './change-github-fake.js';
import { ExternalTaskReceiver } from '../src/external-task-receiver.js';
import { ENVIRONMENT, eventBody, receiverFixture, signedHeaders } from './external-task-fixture.js';
import { fixture, localDatabase, template, thread } from './helpers.js';

// O08 F7b(AC-06): Discord로 나가는 F-2~F-6 경로마다 가짜 비밀을 심어 바깥으로 나가는 바이트(Discord 전송 본문)와
// 발송함에 남지 않고 고정 안내로 바뀌는지 본다. 게시 직전 검사(발송 한 길의 scan)와 포트 흔들기 훑기도 여기 있다.
const TOKEN = `ghp_${'Q'.repeat(36)}`;
const MARKER = 'fixture-internal-codename';
const TAILNET = ['fixture-node', 'fixture-tail', 'ts', 'net'].join('.');
const INTERNAL_UUID = '6f1d2c3b-4a5e-4f60-9b7c-8d9e0a1b2c3d';
const SECRETS = [TOKEN, MARKER, TAILNET, INTERNAL_UUID];
const notifications = { guild: 'fixture-guild', channel: 'fixture-notifications', parent: null, kind: 'channel' as const };
const seoul = { time: '08:50', timezone: 'Asia/Seoul' };

let database: Awaited<ReturnType<typeof localDatabase>>;
let f: Awaited<ReturnType<typeof fixture>>;
before(async () => { database = await localDatabase(); });
beforeEach(async () => {
  await database.pg.exec('TRUNCATE events,conversations,jobs,results,outbox,schedules,denied_actors,controls,audit,incidents,briefing_runs,briefing_copies,briefing_observations RESTART IDENTITY CASCADE');
  f = await fixture(database.db);
});
after(async () => { await database.pg.close(); });
const withMarker = () => { f.policy.change = { repositories: [repositoryPolicy({ internalMarkers: [MARKER] })] }; };
const deliverAll = async () => { while (await f.publisher.deliver()); };
const sentBytes = () => f.rest.wires.map(w => w.bytes).join('\n');
const leaked = (text: string) => SECRETS.filter(secret => text.includes(secret));
async function outbox() {
  return (await database.db.query<{ id: string; state: string; payload: { content: string }; message_key: string }>(
    'SELECT id,state,payload,message_key FROM outbox ORDER BY created_at,page_index')).rows;
}
const audits = async (kind: string) => (await database.db.query('SELECT 1 FROM audit WHERE kind=$1', [kind])).rows.length;

// 기억 서비스 가짜: 다시 확인할 기억(recheckDue)과 작성 중 삭제 여부(live)만 쓴다.
const view = (id: string, statement: string): MemoryView => ({ id, kind: 'configuration', statement, observedAt: null, service: null, createdAt: 1 } as unknown as MemoryView);
function memoryOf(items: MemoryView[]): MemoryService {
  return { recheckDue: async () => ({ items, total: items.length }), live: async () => true } as unknown as MemoryService;
}
async function briefingAt(items: MemoryView[], sources: ObservationSource[] = []) {
  const briefing = new BriefingScheduler(f.store, f.gate, memoryOf(items), sources, seoul);
  await briefing.ensure();
  const slot = nextSlot(f.now(), seoul.time, seoul.timezone);
  f.advance(slot - f.now()); f.policy.confirmedAt = f.now();
  return { briefing, date: localDate(slot, seoul.timezone) };
}

test('AC-06 F-2 브리핑 기억: 예전 정책에서 실은 기억도 지금 정책으로 다시 보고, 걸린 기억은 종류만 남긴다', async () => {
  const items = [view('m-clean', '백업 보존 14일'), view('m-token', `배포 키는 ${TOKEN}`), view('m-marker', `${MARKER} 클러스터로 옮김`)];
  // 표식이 정책에 없던 날: 표식 기억은 실리고 토큰 기억만 막힌다.
  const first = await briefingAt(items);
  assert.equal(await first.briefing.tick(), 'enqueued');
  let content = (await outbox()).at(-1)!.payload.content;
  assert.ok(content.includes('백업 보존 14일') && content.includes(MARKER) && !content.includes(TOKEN), content);
  assert.equal(content.split(BRIEFING_TEXT.memoryWithheld('설정')).length - 1, 1);
  // 다음 날 정책에 표식을 더하면 같은 기억(저장 때 safe_summary)도 막힌다.
  withMarker();
  const second = await briefingAt(items);
  assert.equal(await second.briefing.tick(), 'enqueued');
  content = (await outbox()).at(-1)!.payload.content;
  assert.deepEqual(leaked(content), []);
  assert.ok(content.includes('백업 보존 14일') && content.includes('[일일 브리핑]'), content);
  assert.equal(content.split(BRIEFING_TEXT.memoryWithheld('설정')).length - 1, 2);
  // 바깥으로 나간 바이트에도 없다. 첫 날 글은 그날 정책으로 나갔고 표식이 든 그 사본은 지금 정책의 게시 직전 검사가 막는다.
  await deliverAll();
  assert.deepEqual(leaked(sentBytes()), []);
});

test('AC-06 F-2 최종 브리핑: 관측 요약처럼 코드 밖에서 온 줄에 비밀이 섞이면 브리핑 전체가 고정 안내로 바뀐다', async () => {
  const leaky: ObservationSource = { id: 'backup', label: '백업', kind: 'backup',
    read: async () => ({ observedAt: f.now(), status: 'ok', summary: `마지막 백업 ${TAILNET} 완료` }) };
  const { briefing, date } = await briefingAt([view('m-clean', '백업 보존 14일')], [leaky]);
  assert.equal(await briefing.tick(), 'enqueued');
  const [row] = await outbox();
  assert.equal(row!.payload.content, BRIEFING_TEXT.withheld(date));
  await deliverAll();
  assert.equal(f.rest.wires.length, 1);
  assert.deepEqual(leaked(sentBytes()), []);
});

test('AC-06 게시 직전 검사: 라벨이 safe_summary여도 비밀·지금 정책의 표식이 든 글은 보내지 않고 사유 코드만 감사에 남긴다', async () => {
  const enqueue = (key: string, content: string) => f.store.enqueue({ key, actor: f.policy.owner, scope: notifications, revision: f.policy.revision,
    payload: { kind: 'message', channel: notifications.channel, content, classification: 'safe_summary' } });
  await enqueue('clean', '공개 글');
  await enqueue('token', `값은 ${TOKEN}`);
  await enqueue('tailnet', `주소는 ${TAILNET}`);
  // 넣을 때는 정책에 없던 표식이라도 보낼 때의 정책으로 본다.
  await enqueue('marker', `${MARKER} 쪽 확인`);
  withMarker();
  await deliverAll();
  const states = Object.fromEntries((await outbox()).map(row => [row.message_key, row.state]));
  assert.deepEqual(states, { clean: 'sent', token: 'blocked', tailnet: 'blocked', marker: 'blocked' });
  assert.equal(f.rest.wires.length, 1);
  assert.deepEqual(leaked(sentBytes()), []);
  assert.equal(await audits('delivery_public_check_blocked'), 3);
});

test('AC-06 F-3 외부 세션 완료: 원시 세션 ID·연결 ID 대신 별칭, 동의한 요약도 지금 정책의 공통 검사에 걸리면 싣지 않는다', async () => {
  const ctx = await receiverFixture({ connectionBurst: 100 });
  try {
    ctx.f.policy.change = { repositories: [repositoryPolicy({ internalMarkers: [MARKER] })] };
    const who = await ctx.attach(INTERNAL_UUID, true);
    const send = async (summary: string) => {
      const body = eventBody(who, ctx.f.now(), { summary });
      return ctx.receiver.receive(signedHeaders(who, body, ctx.f.now()), Buffer.from(body));
    };
    // R08의 자체 거름(suspectSummary)은 지나지만 공통 검사에 걸리는 값: tailnet 이름, 정책의 내부 표식, 사설 주소.
    for (const summary of [`빌드 끝 ${TAILNET}`, `${MARKER} 배포 끝`, '빌드 끝 192.168.0.10']) assert.equal((await send(summary)).outcome, 'accepted', summary);
    assert.equal((await send('빌드 끝')).outcome, 'accepted');
    assert.equal((await send(FIXED_SUMMARY)).outcome, 'accepted');
    const rows = (await ctx.db.query<{ payload: { content: string } }>('SELECT payload FROM outbox ORDER BY created_at')).rows.map(row => row.payload.content);
    assert.equal(rows.length, 5);
    const alias = publicAlias(who.connectionId);
    for (const content of rows) {
      assert.ok(content.includes(`연결 \`${alias}\``), content);
      assert.ok(!content.includes(who.connectionId) && !content.includes(INTERNAL_UUID), content);
      assert.deepEqual(leaked(content), []);
    }
    assert.equal(rows.filter(content => content.includes(`요약: ${PUBLIC_WITHHELD}`)).length, 3);
    assert.ok(rows.some(content => content.includes('요약: `빌드 끝`')));
    await (async () => { while (await ctx.f.publisher.deliver()); })();
    const sent = ctx.f.rest.wires.map(w => w.bytes).join('\n');
    assert.equal(ctx.f.rest.wires.length, 5);
    assert.deepEqual(leaked(sent), []);
    assert.ok(!sent.includes('192.168.0.10'));
  } finally { await ctx.close(); }
});

test('AC-06 F-4 내부 식별자: 작업 목록·리뷰 작업·모델 상태에 작업 UUID 대신 공개 별칭만 싣는다', () => {
  const alias = publicAlias(INTERNAL_UUID);
  const texts = [
    controlText('list', [{ id: INTERNAL_UUID, state: 'queued' }]),
    controlText('review-status', { ok: true, jobs: [{ id: INTERNAL_UUID, state: 'waiting_user', wait_reason: 'auth_expired' }], status: '' }),
    controlText('model-status', { paused: true, emergency: false, executionPending: false, waiting: [{ id: INTERNAL_UUID, wait_reason: 'model_limit' }] }),
    controlText('future', { id: INTERNAL_UUID, token: TOKEN }),
    controlText('future', [INTERNAL_UUID]),
  ];
  for (const text of texts) assert.deepEqual(leaked(text), [], text);
  assert.ok(texts[0]!.includes(`\`${alias}\``) && texts[1]!.includes(`\`${alias}\``));
  assert.equal(texts[3], CONTROL_TEXT.unknownResult);
  assert.equal(texts[4], CONTROL_TEXT.unknownResult);
});

test('AC-06 F-5 고정 안내: 모델 멈춤·비상 정지·종료 모르는 작업은 필요한 상태와 다음 행동만, 모르는 상태 이름은 싣지 않는다', () => {
  const status = (result: Record<string, unknown>) => controlText('model-status', { paused: false, emergency: false, executionPending: false, waiting: [],
    taskLaneClosed: 'retention_full', status: `내부 상태 ${MARKER}`, ...result });
  assert.equal(status({}), CONTROL_TEXT.running);
  assert.equal(status({ paused: true }), CHAT_TASK_TEXT.away);
  assert.equal(status({ emergency: true, paused: true, executionPending: true, waiting: [{ id: 'j', wait_reason: 'model_limit' }] }),
    [CONTROL_TEXT.emergency, CONTROL_TEXT.waiting(1), CONTROL_TEXT.executionPending].join('\n'));
  assert.equal(status({ executionPending: true }), CONTROL_TEXT.executionPending);
  assert.equal(controlText('list', [{ id: 'j', state: 'future_state', wait_reason: 'future_reason' }]),
    `작업 1건\n- \`${publicAlias('j')}\` ${CONTROL_TEXT.unknownState}(${CONTROL_TEXT.unknownState})`);
});

test('AC-06 F-6 읽기: 요약의 출처는 템플릿 ID가 아니라 공개 표시명이다', async () => {
  f.policy.services = ['homelab-bot'];
  const reader = new ReadAdapter([...SERVICES], [...TEMPLATES], f.gate, { query: async () =>
    new TextEncoder().encode(JSON.stringify({ observedAt: f.now(), rows: [{ status: 'healthy' }] })) }, f.now);
  for (const t of TEMPLATES) {
    const result = await reader.recent(f.policy.owner, notifications, { service: 'homelab-bot', template: t.id });
    const summary = readSummary(result);
    assert.ok(summary.includes(`출처: ${t.label}`), summary);
    assert.ok(!summary.includes(t.id), summary);
    assert.equal(result.source, t.id, '기록용 ID는 결과에 남는다');
  }
  // 표시명이 없는 템플릿은 종류의 이름이고, 표시명이 없는 결과는 ID가 있어도 싣지 않는다.
  const fallback = await new ReadAdapter([{ ...SERVICES[0]!, id: 'fixture-service', namespace: template.namespace }], [{ ...template }], f.gate,
    { query: async () => new TextEncoder().encode(JSON.stringify({ observedAt: f.now(), rows: [{ status: 'healthy' }] })) }, f.now);
  f.policy.services = ['fixture-service'];
  assert.ok(readSummary(await fallback.recent(f.policy.owner, notifications, { service: 'fixture-service', template: template.id })).includes('출처: 상태 조회'));
  const bare: ReadResult = { service: 'x', source: 'homelab-bot-logs', window: { from: 0, to: 1 }, observedAt: null, status: 'observed',
    facts: [], hypotheses: [], unknowns: [], checks: [], untrusted: [] };
  assert.ok(readSummary(bare).includes('출처: 없음') && !readSummary(bare).includes('homelab-bot-logs'));
  assert.throws(() => new ReadAdapter([...SERVICES], [{ ...TEMPLATES[0]!, label: '`x`' }], f.gate, { query: async () => new Uint8Array() }, f.now));
});

test('R08 닫기: 연결을 모두 닫고 아직 게시하지 않은 알림을 막는다. 다시 불러도 바뀌는 것이 없다', async () => {
  await database.db.query(`INSERT INTO conversations(id,owner_id,scope,channel_id,created_at) VALUES ($1,'fixture-owner',$2,$3,$4)`,
    [f.store.scopeId(thread), JSON.stringify(thread), thread.channel, f.now()]);
  const links = new ExternalTaskLinks(f.store);
  const a = await links.attach({ owner: 'fixture-owner', scope: thread, externalTaskId: 'session-a', executor: 'claude' });
  const b = await links.attach({ owner: 'fixture-owner', scope: thread, externalTaskId: 'session-b', executor: 'codex' });
  await links.detach(b.connectionId, 'fixture-owner');
  const key = outboxKey(a.connectionId, 'event-aaaaaaaaaaaaaaaa');
  await database.db.query(`INSERT INTO external_task_events(connection_id,event_id,body_sha256,accepted_key_id,occurred_at,received_at,outbox_key)
    VALUES ($1,'event-aaaaaaaaaaaaaaaa',$2,$3,$4,$4,$5)`, [a.connectionId, 'a'.repeat(64), a.keyId, f.now(), key]);
  await f.store.enqueue({ key, conversation: f.store.scopeId(thread), actor: 'fixture-owner', scope: thread, revision: f.policy.revision,
    payload: { kind: 'message', channel: thread.channel, content: '턴 완료 알림', classification: 'safe_summary' } });
  assert.deepEqual(await links.detachAll(), { revoked: 1, blocked: 1 });
  const reasons = (await database.db.query<{ id: string; revoked_reason: string }>('SELECT id,revoked_reason FROM external_task_connections')).rows;
  assert.deepEqual(Object.fromEntries(reasons.map(row => [row.id, row.revoked_reason])), { [a.connectionId]: 'detach', [b.connectionId]: 'detach' });
  assert.deepEqual((await outbox()).map(row => row.state), ['blocked']);
  assert.equal(await audits('external_task_detached_all'), 1);
  assert.deepEqual(await links.detachAll(), { revoked: 0, blocked: 0 });
  assert.equal(await audits('external_task_detached_all'), 1);
});

// 하네스 훑기: 새 검사 경로(게시자의 scan, 브리핑의 재검사)의 포트를 Proxy로 감싸 읽기(get)·호출(call) 지점마다 던지기 하나를 넣고
// 새로 돌린다. 불변식: 심은 비밀이 바깥으로 나간 바이트(Discord 전송)와 발송함 본문에 0번, 검사하지 않은 바이트가 나간 일 0.
interface Point { at: number; kind: 'get' | 'call'; path: string }
class Probe {
  points: Point[] = [];
  private counter = 0;
  constructor(private readonly target?: number) {}
  private fire(kind: 'get' | 'call', path: string): boolean {
    const at = this.counter++;
    if (this.target === undefined) this.points.push({ at, kind, path });
    return this.target === at;
  }
  wrap<T extends object>(path: string, value: T): T {
    const probe = this;
    return new Proxy(value, {
      get(object, key, receiver) {
        const name = `${path}.${String(key)}`;
        if (typeof key === 'string' && key !== 'then' && probe.fire('get', name)) throw new Error(`probe_throw ${name}`);
        const got = Reflect.get(object, key, receiver);
        if (typeof got === 'function') return (...args: unknown[]) => {
          if (probe.fire('call', name)) throw new Error(`probe_throw ${name}()`);
          return Reflect.apply(got, object, args);
        };
        return got;
      },
    });
  }
}
type Outcome = { violations: string[] };
async function sweep(run: (probe: Probe) => Promise<Outcome>) {
  const base = new Probe();
  const baseline = await run(base);
  const violations = baseline.violations.map(line => `baseline | ${line}`);
  for (const point of base.points) {
    const outcome = await run(new Probe(point.at)).catch(error => ({ violations: [`threw ${String(error)}`] }));
    violations.push(...outcome.violations.map(line => `${point.at} ${point.kind} ${point.path} | throw | ${line}`));
  }
  return { points: base.points.length, runs: base.points.length + 1, violations, labels: base.points.map(p => `${p.at} ${p.kind} ${p.path}`) };
}
const sha256 = (text: string) => createHash('sha256').update(text, 'utf8').digest('hex');

test('하네스 훑기(게시자 scan): 발송함·정책·전송의 읽기·호출마다 던져도 비밀이 든 행은 나가지 않고, 나간 바이트는 검사한 바이트다', async () => {
  const report = await sweep(async probe => {
    await database.pg.exec('TRUNCATE outbox,audit,controls RESTART IDENTITY CASCADE');
    f.policy.change = undefined;
    const enqueue = (key: string, content: string) => f.store.enqueue({ key, actor: f.policy.owner, scope: notifications, revision: f.policy.revision,
      payload: { kind: 'message', channel: notifications.channel, content, classification: 'safe_summary' } });
    await enqueue('clean', '공개 글');
    await enqueue('marker', `${MARKER} 쪽 ${TOKEN}`);
    withMarker();
    const wired: { path: string; bytes: string }[] = [];
    const rest = probe.wrap('rest', { wire: async (method: string, path: string, body: OutboundBytes) => {
      wired.push({ path, bytes: body.bytes });
      return f.rest.wire(method as 'POST', path, body);
    } });
    const gate = probe.wrap('gate', { authorize: (...args: Parameters<typeof f.gate.authorize>) => f.gate.authorize(...args),
      withDatabase: (...args: Parameters<typeof f.gate.withDatabase>) => f.gate.withDatabase(...args) });
    const store = probe.wrap('store', f.store);
    // 준비 단계(가짜 전송 자리를 꺼내는 읽기)에서 던지면 게시자를 만들지 못해 보낸 것이 없다. 그때도 아래 대조는 그대로 한다.
    let publisher: DiscordPublisher | undefined;
    try { publisher = new DiscordPublisher(store, gate as never, Object.assign(Object.create(f.rest), { wire: rest.wire }) as never); } catch { publisher = undefined; }
    for (let round = 0; publisher && round < 3; round++) { try { await publisher.deliver(); } catch { /* 흔들기로 난 오류는 결과 대조로 본다 */ } }
    const rows = (await database.db.query<{ message_key: string; sent_digest: string | null }>('SELECT message_key,sent_digest FROM outbox')).rows;
    const digests = new Set(rows.filter(row => row.message_key === 'clean' && row.sent_digest).map(row => row.sent_digest));
    const violations: string[] = [];
    for (const sent of wired) {
      if (leaked(sent.bytes).length) violations.push(`leaked ${sent.path}`);
      if (!digests.has(sha256(sent.bytes))) violations.push(`unchecked ${sent.path}`);
    }
    if (wired.length > 1) violations.push(`dup ${wired.length}`);
    if (probe.points.length && wired.length !== 1) violations.push(`baseline_sent ${wired.length}`);
    return { violations };
  });
  console.log(`sweep publisher-scan ${JSON.stringify({ points: report.points, runs: report.runs, violations: report.violations.length })}`);
  console.log(`sweep publisher-scan points ${JSON.stringify(report.labels)}`);
  for (const line of report.violations) console.log(`violation ${line}`);
  assert.ok(report.points >= 20, String(report.points));
  assert.deepEqual(report.violations, []);
});

test('하네스 훑기(브리핑 재검사): 정책·기억·발송함의 읽기·호출마다 던져도 심은 비밀이 발송함 본문에 들어가지 않는다', async () => {
  const items = [view('m-clean', '백업 보존 14일'), view('m-token', `키 ${TOKEN}`), view('m-marker', `${MARKER} 이전`)];
  const report = await sweep(async probe => {
    await database.pg.exec('TRUNCATE outbox,audit,schedules,briefing_runs,briefing_copies,briefing_observations RESTART IDENTITY CASCADE');
    f.policy.change = undefined;
    withMarker();
    const gate = probe.wrap('gate', { current: () => f.gate.current(), authorize: (...args: Parameters<typeof f.gate.authorize>) => f.gate.authorize(...args),
      withDatabase: (db: Parameters<typeof f.gate.withDatabase>[0]) => probe.wrap('gateTx', f.gate.withDatabase(db)) });
    const memory = probe.wrap('memory', { recheckDue: async () => ({ items, total: items.length }), live: async () => true });
    const briefing = new BriefingScheduler(f.store, gate as never, memory as never, [], seoul);
    try {
      await briefing.ensure();
      const slot = nextSlot(f.now(), seoul.time, seoul.timezone);
      f.advance(slot - f.now()); f.policy.confirmedAt = f.now();
      await briefing.tick();
    } catch { /* 흔들기로 난 오류는 결과 대조로 본다 */ }
    const rows = await outbox();
    const violations = rows.flatMap(row => leaked(row.payload.content).map(secret => `enqueued ${secret.slice(0, 8)}`));
    if (probe.points.length && rows.length !== 1) violations.push(`baseline_enqueued ${rows.length}`);
    return { violations };
  });
  console.log(`sweep briefing ${JSON.stringify({ points: report.points, runs: report.runs, violations: report.violations.length })}`);
  console.log(`sweep briefing points ${JSON.stringify(report.labels)}`);
  for (const line of report.violations) console.log(`violation ${line}`);
  assert.ok(report.points >= 8, String(report.points));
  assert.deepEqual(report.violations, []);
});

test('하네스 훑기(외부 세션 요약 검사): 발송함·연결·정책 문의의 읽기·호출마다 던져도 걸린 요약은 발송함 본문에 들어가지 않는다', async () => {
  const ctx = await receiverFixture({ connectionBurst: 1000, connectionPerHour: 100_000 });
  try {
    ctx.f.policy.change = { repositories: [repositoryPolicy({ internalMarkers: [MARKER] })] };
    const who = await ctx.attach(INTERNAL_UUID, true);
    const report = await sweep(async probe => {
      await ctx.pg.exec('TRUNCATE external_task_events,outbox,audit RESTART IDENTITY CASCADE');
      const store = probe.wrap('store', ctx.f.store);
      const links = probe.wrap('links', { enforceRestoreFence: (...args: Parameters<typeof ctx.links.enforceRestoreFence>) => ctx.links.enforceRestoreFence(...args) });
      const authorize = probe.wrap('policy', { authorize: (owner: string, scope: typeof thread, db: Parameters<typeof ctx.f.gate.withDatabase>[0]) =>
        ctx.f.gate.withDatabase(db).authorize(owner, scope) });
      let outcome = 'none';
      try {
        const receiver = new ExternalTaskReceiver({ store: store as never, links, authorize: authorize.authorize, environment: ENVIRONMENT });
        const body = eventBody(who, ctx.f.now(), { summary: `${MARKER} 배포 끝` });
        outcome = (await receiver.receive(signedHeaders(who, body, ctx.f.now()), Buffer.from(body))).outcome;
      } catch { /* 흔들기로 난 오류는 결과 대조로 본다 */ }
      const rows = (await ctx.db.query<{ payload: { content: string } }>('SELECT payload FROM outbox')).rows.map(row => row.payload.content);
      const violations = rows.flatMap(content => leaked(content).map(secret => `enqueued ${secret.slice(0, 8)}`));
      if (rows.some(content => !content.includes(`요약: ${PUBLIC_WITHHELD}`))) violations.push('summary_not_withheld');
      if (probe.points.length && (outcome !== 'accepted' || rows.length !== 1)) violations.push(`baseline ${outcome} ${rows.length}`);
      return { violations };
    });
    console.log(`sweep r08-summary ${JSON.stringify({ points: report.points, runs: report.runs, violations: report.violations.length })}`);
    console.log(`sweep r08-summary points ${JSON.stringify(report.labels)}`);
    for (const line of report.violations) console.log(`violation ${line}`);
    assert.ok(report.points >= 8, String(report.points));
    assert.deepEqual(report.violations, []);
  } finally { await ctx.close(); }
});
