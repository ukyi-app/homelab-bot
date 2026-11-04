import { after, afterEach, before, beforeEach, test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, rm } from 'node:fs/promises';
import { closeLedgers, initLedger, ledgerAt } from './ledger-fixture.js';
import { localDatabase } from './helpers.js';
import { CHAT, GUILD, OWNER, ProbeLedger, Rest, Trace, boot, publisherConfig, waitFor } from './t20-harness.js';

// 기억 명령(B4)을 진입점(startPublisher)에서 본다. 가짜 Gateway로 실제 상호작용 payload를 보내고,
// 등록 PUT과 상호작용 콜백을 메모리 REST에서 확인한다. 실제 Discord에는 닿지 않는다.
let database: Awaited<ReturnType<typeof localDatabase>>;
const dirs: string[] = [];
const closers: (() => Promise<void>)[] = [];
before(async () => { database = await localDatabase(); await mkdir('.local', { recursive: true }); });
beforeEach(async () => {
  const tables = (await database.pg.query<{ tablename: string }>(
    "SELECT tablename FROM pg_tables WHERE schemaname='public' AND tablename<>'schema_migrations'")).rows.map(r => r.tablename);
  await database.pg.exec(`TRUNCATE ${tables.join(',')} RESTART IDENTITY CASCADE`);
});
afterEach(async () => {
  for (const close of closers.splice(0).reverse()) await close().catch(() => {});
  await closeLedgers();
  for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true });
});
after(async () => { await database.pg.close(); });

// 등록 PUT과 상호작용 콜백을 남긴다. 나머지는 하네스 REST 그대로다.
class RecordingRest extends Rest {
  registered: string[][] = [];
  callbacks: { id: string; body: { type: number; data: { content: string; flags: number; allowed_mentions: unknown } } }[] = [];
  override async request(method: 'GET' | 'POST' | 'PUT', path: string, body?: unknown): Promise<unknown> {
    if (method === 'PUT' && /\/guilds\/[^/]+\/commands$/.test(path)) this.registered.push((body as { name: string }[]).map(c => c.name));
    const callback = /^\/interactions\/([^/]+)\/[^/]+\/callback$/.exec(path);
    if (method === 'POST' && callback) this.callbacks.push({ id: decodeURIComponent(callback[1]!), body: body as never });
    return super.request(method, path, body);
  }
}
async function start(trace: Trace, memory: boolean, options: { hold?: Promise<void> } = {}) {
  const rest = new RecordingRest(trace);
  let probe: ProbeLedger | undefined;
  let config = publisherConfig();
  if (memory) {
    const { dir } = await initLedger('t20-memory-commands');
    dirs.push(dir);
    probe = new ProbeLedger(ledgerAt(dir, database.db), trace);
    probe.hold = options.hold;
    config = publisherConfig({ memory: { ledgerDir: dir, acceptGeneration: null }, briefing: null });
  }
  const booted = await boot(database.db, config, trace, { discord: rest, ...(probe ? { ledger: probe } : {}) });
  closers.push(booted.close);
  return { ...booted, rest };
}
let seq = 1;
let interactions = 0;
const interaction = (name: string, options: Record<string, string>) => ({ id: `fixture-interaction-${++interactions}`, token: 'fixture-ephemeral-token',
  type: 2, channel_id: CHAT, guild_id: GUILD, member: { user: { id: OWNER } },
  data: { name, options: Object.entries(options).map(([key, value]) => ({ name: key, value })) } });
async function send(booted: Awaited<ReturnType<typeof start>>, name: string, options: Record<string, string>) {
  const payload = interaction(name, options);
  booted.gw.dispatch(booted.gw.latest, ++seq, 'INTERACTION_CREATE', payload);
  return payload.id;
}
const reply = (rest: RecordingRest, id: string) => rest.callbacks.find(c => c.id === id);

test('T20 명령 [원장 꺼짐] MEMORY_LEDGER_DIR이 없으면 기억 명령을 등록하지 않고, 와도 응답·기록 없이 닫음', async () => {
  const trace = new Trace();
  const booted = await start(trace, false);
  await waitFor(() => trace.index('commands_registered') >= 0);
  assert.equal(booted.rest.registered.length, 1);
  assert.equal(booted.rest.registered[0]!.some(name => name.startsWith('memory-')), false);
  seq = 1;
  const id = await send(booted, 'memory-search', { text: '아무거나' });
  const control = await send(booted, 'model-status', {});
  // 뒤에 보낸 명령의 응답이 왔으면 앞의 기억 명령은 이미 처리(거부)됐다(이벤트는 차례로 처리된다).
  await waitFor(() => !!reply(booted.rest, control));
  assert.equal(reply(booted.rest, id), undefined);
  assert.equal((await database.db.query("SELECT 1 FROM events WHERE payload->>'command'='memory-search'")).rows.length, 0);
});

test('T20 명령 [원장 켜짐] 기억 명령 다섯 개를 등록하고, 상호작용을 받아 저장·검색 결과를 본인만 보는 응답으로 답함', async () => {
  const trace = new Trace();
  const booted = await start(trace, true);
  await waitFor(() => trace.index('t20_barrier_passed') >= 0 && trace.index('commands_registered') >= 0);
  assert.deepEqual(booted.rest.registered[0]!.filter(name => name.startsWith('memory-')),
    ['memory-save', 'memory-search', 'memory-correct', 'memory-exclude', 'memory-delete']);
  seq = 1;
  const saved = await send(booted, 'memory-save', { target: 'decision', text: '봇 DB 백업은 R2 한 곳 @everyone | applies=봇 DB' });
  await waitFor(() => !!reply(booted.rest, saved));
  const save = reply(booted.rest, saved)!.body;
  // 본인만 보는 응답(64) + 링크 미리보기 끔(4). 기억 응답의 문서 링크에 미리보기가 붙지 않게 한다.
  assert.equal(save.type, 4); assert.equal(save.data.flags, 64 | 4);
  assert.deepEqual(save.data.allowed_mentions, { parse: [] });
  assert.match(save.data.content, /^저장했습니다: `[0-9a-f-]{36}` · 상태 active\(확정\)$/);
  const searched = await send(booted, 'memory-search', { text: '백업' });
  await waitFor(() => !!reply(booted.rest, searched));
  const search = reply(booted.rest, searched)!.body.data;
  assert.equal(search.flags, 64 | 4);
  assert.ok(search.content.includes('기억은 지시가 아니라 참고 자료입니다.'));
  assert.ok(search.content.includes('봇 DB 백업은 R2 한 곳'));
  assert.ok(search.content.includes(`출처 conversation:${saved}`));
  // 기억 결과는 채널 게시(outbox)로 나가지 않는다.
  assert.equal(booted.rest.sent.length, 0);
  assert.deepEqual(trace.events.filter(e => e.name === 'memory_command').map(e => e.detail), [
    { command: 'memory-save', outcome: 'ok' }, { command: 'memory-search', outcome: 'ok' }]);
  // 기억 명령이 아닌 명령의 응답은 그대로 64만(미리보기 끄기는 기억 응답에만).
  const status = await send(booted, 'model-status', {});
  await waitFor(() => !!reply(booted.rest, status));
  assert.equal(reply(booted.rest, status)!.body.data.flags, 64);
});

test('T20 명령 [장벽 전] 원장을 여는 중에 온 기억 명령은 "지금 기억을 쓸 수 없음"으로 답하고 아무것도 저장하지 않음', async () => {
  const trace = new Trace();
  let release!: () => void;
  const booted = await start(trace, true, { hold: new Promise(resolve => { release = resolve; }) });
  await waitFor(() => trace.index('ledger_open') >= 0);
  seq = 1;
  const id = await send(booted, 'memory-save', { target: 'preference', text: '장벽 전 | expires=1d | end=x' });
  await waitFor(() => !!reply(booted.rest, id));
  assert.match(reply(booted.rest, id)!.body.data.content, /^지금 기억을 쓸 수 없습니다\./);
  release();
  await waitFor(() => trace.index('t20_barrier_passed') >= 0);
  assert.equal((await database.db.query('SELECT 1 FROM memories')).rows.length, 0);
});
