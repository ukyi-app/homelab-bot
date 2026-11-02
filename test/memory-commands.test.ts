import { randomUUID } from 'node:crypto';
import { after, afterEach, before, beforeEach, test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, rm } from 'node:fs/promises';
import { COMMAND_DEFINITIONS, MEMORY_COMMANDS, MEMORY_COMMAND_DEFINITIONS, commandDefinitions } from '../src/commands.js';
import { Denied } from '../src/contracts.js';
import type { EventInput, Scope } from '../src/contracts.js';
import type { LedgerState } from '../src/deletion-ledger.js';
import { ALL_COMMANDS, DiscordIngress, MEMORY_ACK_NOTICE } from '../src/discord.js';
import { DOCUMENT_REPOSITORIES, githubDocuments } from '../src/document-source.js';
import { MemoryService } from '../src/memory.js';
import type { DeletionEntry, DeletionLedger, DocumentSource } from '../src/memory.js';
import { DELETE_SCOPE, MemoryCommands, REPLY_LIMIT, SEARCH_HEADER, UNAVAILABLE, savedText } from '../src/memory-commands.js';
import { MockDiscord, event, fixture, localDatabase, thread } from './helpers.js';
import { closeLedgers, initLedger, ledgerAt } from './ledger-fixture.js';

// T20 기억 명령(B4). 수신(DiscordIngress) → 명령 처리기 → MemoryService(PGlite + 실제 원장 파일)까지 잇는다.
let database: Awaited<ReturnType<typeof localDatabase>>;
let f: Awaited<ReturnType<typeof fixture>>;
let dir: string;
let ledger: SwitchLedger;
let memory: MemoryService;
let rest: ReplyDiscord;
let ingress: DiscordIngress;
let logs: { name: string; detail: unknown }[];
let state: { ledger: LedgerState | undefined; closed: boolean };
const DAY = 86_400_000;
const chat: Scope = { guild: 'fixture-guild', channel: 'fixture-chat', parent: null, kind: 'channel' };
const notifications: Scope = { guild: 'fixture-guild', channel: 'fixture-notifications', parent: null, kind: 'channel' };
const PINNED = `https://github.com/ukyi-app/homelab/blob/${'a'.repeat(40)}/docs/design.md`;
const documents: DocumentSource = { check: async (_actor, uri) => uri === PINNED ? 'verified' : 'inaccessible' };

// 상호작용 응답 본문을 남기는 대역. 실제 프로토콜은 이 본문을 ephemeral 콜백으로 보낸다(아래 프로토콜 시험).
class ReplyDiscord extends MockDiscord {
  replies: { id: string; content: string }[] = [];
  override async acknowledge(e: EventInput, content: string, options: Parameters<MockDiscord['acknowledge']>[2]) {
    await super.acknowledge(e, content, options);
    this.replies.push({ id: e.id, content });
  }
}
// 원장 쓰기를 실패시킬 수 있는 대역. 나머지는 실제 파일 원장이다.
class SwitchLedger implements DeletionLedger {
  appendFails = false;
  constructor(readonly inner: ReturnType<typeof ledgerAt>) {}
  async open() { await this.inner.open(); }
  async append(entry: DeletionEntry) { if (this.appendFails) throw new Error('ledger_down'); await this.inner.append(entry); }
  async has(id: string, createdAt: number) { return this.appendFails ? false : this.inner.has(id, createdAt); }
  async entries() { return this.inner.entries(); }
  async durable() { return this.inner.durable(); }
}

before(async () => { database = await localDatabase(); await mkdir('.local', { recursive: true }); });
beforeEach(async () => {
  await database.pg.exec(`TRUNCATE events,conversations,jobs,results,outbox,schedules,denied_actors,controls,audit,incidents,
    memories,memory_terms,memory_exclusions,memory_deletions,briefing_runs,briefing_copies,briefing_observations,
    deletion_ledger_generation RESTART IDENTITY CASCADE`);
  f = await fixture(database.db);
  ({ dir } = await initLedger('memory-commands'));
  const inner = ledgerAt(dir, database.db);
  ledger = new SwitchLedger(inner);
  memory = new MemoryService(database.db, f.gate, ledger, documents, f.now);
  await memory.open();
  state = { ledger: undefined, closed: false };
  rest = new ReplyDiscord();
  logs = [];
  ingress = wire(memory);
});
afterEach(async () => { await closeLedgers(); await rm(dir, { recursive: true, force: true }); });
after(async () => { await database.pg.close(); });

function wire(service: MemoryService, commands: ReadonlySet<string> = ALL_COMMANDS) {
  const handler = new MemoryCommands(service, () => state.ledger ?? ledger.inner.status().state, () => state.closed, f.now);
  return new DiscordIngress(f.store, f.gate, rest, true, commands, (name, detail) => { logs.push({ name, detail }); }, handler);
}
let seq = 0;
// 명령 하나를 보내고 그 상호작용의 응답 본문을 돌려준다(응답이 없으면 undefined).
async function run(command: string, options: { text?: string; target?: string; scope?: Scope; actor?: string; id?: string } = {}) {
  const id = options.id ?? `memory-cmd-${++seq}`;
  await ingress.receive(event(id, { kind: 'command', command, text: options.text ?? '', target: options.target,
    scope: options.scope ?? thread, actor: options.actor ?? 'fixture-owner', mention: undefined }));
  return rest.replies.filter(r => r.id === id).map(r => r.content).at(-1);
}
const idOf = (reply: string | undefined) => /`([0-9a-f-]{36})`/.exec(reply ?? '')?.[1];
async function count(table: string) { return Number((await database.db.query<{ n: string }>(`SELECT count(*) AS n FROM ${table}`)).rows[0]!.n); }

test('MEM-CMD 정의: 다섯 명령은 문자열 옵션(text·target)만 쓰고 Discord 길이 한도 안이며, 원장이 꺼지면 등록 목록에 없음', () => {
  assert.deepEqual(MEMORY_COMMAND_DEFINITIONS.map(c => c.name), [...MEMORY_COMMANDS]);
  for (const c of MEMORY_COMMAND_DEFINITIONS) {
    assert.ok([...c.description].length <= 100, c.name);
    assert.ok(c.options.length <= 25);
    for (const o of c.options) {
      assert.equal(o.type, 3); assert.ok(['text', 'target'].includes(o.name));
      assert.ok([...o.description].length <= 100, `${c.name}.${o.name}`);
      assert.ok(o.max_length <= 6000);
    }
  }
  assert.equal(commandDefinitions(false), COMMAND_DEFINITIONS);
  assert.equal(commandDefinitions(false).some(c => c.name.startsWith('memory-')), false);
  assert.deepEqual(commandDefinitions(true).map(c => c.name), [...COMMAND_DEFINITIONS.map(c => c.name), ...MEMORY_COMMANDS]);
});

test('MEM-CMD 흐름: 저장 → 검색 → 정정 → 삭제 → 저장 제외, 응답마다 id·상태·출처·지시 아님 표시', async () => {
  const saved = await run('memory-save', { target: 'preference', text: '답은 짧게 | expires=30d | end=해제 요청 | topic=답 길이' });
  const first = idOf(saved);
  assert.ok(first);
  assert.match(saved!, /저장했습니다: `[0-9a-f-]{36}` · 상태 active\(확정\)/);

  const found = await run('memory-search', { text: '짧게' });
  assert.ok(found!.includes(SEARCH_HEADER));
  assert.ok(found!.includes(`\`${first}\` active(확정) preference`));
  assert.match(found!, /출처 conversation:memory-cmd-\d+ · 저장 \d{4}-\d{2}-\d{2}T\d{2}:\d{2}Z/);
  assert.ok(found!.includes('답은 짧게'));

  const corrected = await run('memory-correct', { target: first, text: '답은 세 줄 이내 | kind=preference | reason=더 구체적으로 | expires=30d | end=해제 요청 | topic=답 길이' });
  const second = idOf(corrected);
  assert.ok(second && second !== first);
  assert.match(corrected!, /정정했습니다\. 새 기억: `[0-9a-f-]{36}` · 상태 active/);
  assert.ok(corrected!.includes(`\`${first}\`은 superseded`));
  const afterCorrect = await run('memory-search', { text: '답은' });
  assert.ok(afterCorrect!.includes(second!)); assert.equal(afterCorrect!.includes(first!), false);

  const decision = idOf(await run('memory-save', { target: 'decision', text: '백업은 R2 한 곳 | applies=봇 DB' }));
  const deleted = await run('memory-delete', { target: decision });
  assert.ok(deleted!.startsWith(`상태: 삭제 완료(deleted) \`${decision}\``));
  assert.ok(deleted!.includes('백업에는 최대 14일 남을 수 있고'));
  assert.ok(deleted!.includes(DELETE_SCOPE));
  assert.equal((await run('memory-search', { text: '백업' }))!.includes(decision!), false);
  // 같은 ID를 다시 지우면 멱등으로 완료를 알린다.
  assert.ok((await run('memory-delete', { target: decision }))!.includes('이미 삭제가 끝난 기억입니다.'));

  const excluded = await run('memory-exclude', { target: 'here' });
  assert.ok(excluded!.startsWith(`저장 제외했습니다: \`channel:${thread.channel}\`. 이 출처의 기억 1건을`));
  assert.ok((await run('memory-search', { text: '답은' }))!.startsWith('이 채널에서 볼 수 있는 기억 중 맞는 것이 없습니다.'));
  // 저장 제외한 채널에서는 새로 저장하지 않는다.
  assert.ok((await run('memory-save', { target: 'preference', text: '다시 | expires=1d | end=해제' }))!.includes('저장 제외한 출처'));
});

test('MEM-CMD 근거: 대화만으로는 설정·장애가 candidate, 커밋 고정 문서를 확인하면 active, 확인 못 하는 문서는 저장 거부', async () => {
  const claim = await run('memory-save', { target: 'configuration', text: '백업 보존 14일 | recheck=30d' });
  assert.match(claim!, /상태 candidate\(미확정\)\n근거가 이 종류에 맞지 않거나/);
  const docBacked = await run('memory-save', { target: 'configuration', text: `PG 18 | recheck=30d | doc=${PINNED}` });
  assert.match(docBacked!, /상태 active\(확정\)/);
  const stored = (await database.db.query<{ source_refs: unknown }>('SELECT source_refs FROM memories WHERE id=$1', [idOf(docBacked)])).rows[0]!;
  assert.deepEqual((stored.source_refs as { type: string }[]).map(s => s.type), ['conversation', 'document']);
  assert.equal((stored.source_refs as { revision?: string }[])[1]!.revision, 'a'.repeat(40));
  const outside = await run('memory-save', { target: 'configuration', text: 'X | recheck=1d | doc=https://example.com/a.md' });
  assert.ok(outside!.startsWith('출처를 확인할 수 없어 저장하지 않았습니다.'));
  // 다른 사람의 결정은 대화만으로 확정하지 않는다.
  assert.match((await run('memory-save', { target: 'decision', text: '배포는 금요일 금지 | applies=homelab | by=팀장' }))!, /candidate/);
  assert.equal(await count('memories'), 3);
});

test('MEM-CMD 잘못된 입력: 서식·필수 값·시각·ID 오류는 저장하지 않고 이유를 짧게 답함(입력값은 되풀이하지 않음)', async () => {
  const cases: [string, { text?: string; target?: string }, RegExp][] = [
    ['memory-save', { target: 'opinion', text: 'x' }, /^종류는 configuration·decision·incident·preference 중 하나입니다\.$/],
    ['memory-save', { target: 'preference', text: '   | expires=1d' }, /^진술이 비어 있습니다\./],
    ['memory-save', { target: 'preference', text: '비밀문구 | expires=1d' }, /^preference는 `expires=`\(만료\)와 `end=`/],
    ['memory-save', { target: 'preference', text: '비밀문구 | expires=내일 | end=x' }, /^`expires=` 값을 읽지 못했습니다\./],
    ['memory-save', { target: 'preference', text: '비밀문구 | expires=2026-12-31 | end=x' }, /^`expires=` 값을 읽지 못했습니다\./],
    ['memory-save', { target: 'preference', text: '비밀문구 | applies=x' }, /^`applies=`는 이 명령·종류에서 쓰지 않습니다\./],
    ['memory-save', { target: 'preference', text: '비밀문구 | 그냥 문장' }, /^`키=값` 모양이 아닌 조각이 있습니다\./],
    ['memory-save', { target: 'preference', text: '비밀문구 | topic=a | topic=b' }, /^`topic=`는 한 번만 씁니다\.$/],
    ['memory-save', { target: 'configuration', text: '비밀문구' }, /^configuration은 `recheck=` 또는 `expires=`가 필요합니다/],
    ['memory-save', { target: 'decision', text: '비밀문구' }, /^decision은 `applies=`/],
    ['memory-save', { target: 'incident', text: '비밀문구 | briefing=maybe' }, /^`briefing=`은 yes 또는 no입니다\.$/],
    ['memory-save', { target: 'preference', text: `${'가'.repeat(1001)} | expires=1d | end=x` }, /^입력이 기억 형식에 맞지 않습니다/],
    ['memory-save', { target: 'preference', text: '비밀문구 | expires=1d | end=x | service=unknown-service' }, /^허용되지 않은 서비스 범위입니다\.$/],
    ['memory-correct', { target: 'not-an-id', text: '비밀문구 | kind=preference | reason=x' }, /^기억 ID/],
    ['memory-correct', { target: '00000000-0000-4000-8000-000000000000', text: '비밀문구 | kind=preference | expires=1d | end=x' }, /^정정에는 `reason=`/],
    ['memory-correct', { target: '00000000-0000-4000-8000-000000000000', text: '비밀문구 | reason=x' }, /^종류는/],
    ['memory-correct', { target: '00000000-0000-4000-8000-000000000000', text: '비밀문구 | kind=preference | reason=x | expires=1d | end=x' }, /^기억을 찾을 수 없거나/],
    ['memory-delete', { target: 'a,b' }, /^기억 ID/],
    ['memory-delete', { target: '00000000-0000-4000-8000-000000000000,00000000-0000-4000-8000-000000000001' }, /^삭제할 기억 ID 하나를 적습니다\.$/],
    ['memory-delete', { target: '00000000-0000-4000-8000-000000000000' }, /^기억을 찾을 수 없거나/],
    ['memory-exclude', { target: 'whatever' }, /^출처 키 모양이 아닙니다\./],
  ];
  for (const [command, options, expected] of cases) {
    const reply = await run(command, options);
    assert.match(reply ?? '(응답 없음)', expected, `${command} ${options.target}`);
    assert.equal(reply!.includes('비밀문구'), false);
  }
  assert.equal(await count('memories'), 0);
  assert.equal(await count('memory_exclusions'), 0);
});

test('MEM-CMD 권한: 비owner·허용 밖 채널·다른 서버는 수신에서 막혀 응답·저장 없음, 다른 채널과 철회된 서비스의 기억은 검색에 안 보임', async () => {
  await assert.rejects(run('memory-save', { target: 'preference', text: 'a | expires=1d | end=x', actor: 'fixture-stranger' }), Denied);
  await assert.rejects(run('memory-search', { text: 'a', scope: { guild: 'fixture-guild', channel: 'fixture-other', parent: null, kind: 'channel' } }), Denied);
  await assert.rejects(run('memory-search', { text: 'a', scope: { guild: 'other-guild', channel: 'fixture-chat', parent: null, kind: 'channel' } }), Denied);
  assert.equal(rest.replies.length, 0);
  assert.equal(await count('memories'), 0);

  // 대화 채널(스레드)에서 저장한 기억은 알림 채널 검색에 나오지 않는다(접근 채널은 저장한 곳의 부모 채널).
  const saved = idOf(await run('memory-save', { target: 'preference', text: '채널 비밀 | expires=1d | end=x' }));
  assert.ok((await run('memory-search', { text: '채널', scope: chat }))!.includes(saved!));
  const elsewhere = await run('memory-search', { text: '채널', scope: notifications });
  assert.equal(elsewhere!.includes(saved!), false); assert.equal(elsewhere!.includes('채널 비밀'), false);
  // 알림 채널에서는 그 기억을 지울 수도 없다(존재 여부도 알리지 않음).
  assert.ok((await run('memory-delete', { target: saved, scope: notifications }))!.startsWith('기억을 찾을 수 없거나'));

  // 서비스에 묶인 기억은 정책에서 그 서비스가 빠지면 다음 검색부터 숨는다.
  const bound = idOf(await run('memory-save', { target: 'preference', text: '서비스 비밀 | expires=1d | end=x | service=fixture-service' }));
  assert.ok((await run('memory-search', { text: '서비스' }))!.includes(bound!));
  f.policy.services = [];
  const revoked = await run('memory-search', { text: '서비스' });
  assert.equal(revoked!.includes(bound!), false); assert.equal(revoked!.includes('서비스 비밀'), false);
});

test('MEM-CMD 원장 닫힘: 기억이 아직 열리지 않았거나 원장이 failed·fenced·closed이거나 종료 중이면 "지금 기억을 쓸 수 없음"', async () => {
  const unopened = new MemoryService(database.db, f.gate, ledger, documents, f.now);
  ingress = wire(unopened);
  assert.equal(await run('memory-save', { target: 'preference', text: 'a | expires=1d | end=x' }), UNAVAILABLE);
  ingress = wire(memory);
  for (const value of ['failed', 'fenced', 'closed'] as const) {
    state.ledger = value;
    assert.equal(await run('memory-search', { text: 'a' }), UNAVAILABLE, value);
  }
  state.ledger = 'degraded';
  assert.ok((await run('memory-search', { text: 'a' }))!.startsWith('이 채널에서 볼 수 있는 기억'));
  state.ledger = undefined; state.closed = true;
  assert.equal(await run('memory-delete', { target: '00000000-0000-4000-8000-000000000000' }), UNAVAILABLE);
  assert.equal(await count('memories'), 0);
  assert.deepEqual(logs.filter(l => l.name === 'memory_command').map(l => (l.detail as { outcome: string }).outcome),
    ['memory_not_ready', 'unavailable', 'unavailable', 'unavailable', 'ok', 'unavailable']);
});

test('MEM-CMD 중복 상호작용: 같은 상호작용이 두 번(차례로·동시에) 와도 한 번만 처리하고 한 번만 답함', async () => {
  await run('memory-save', { id: 'dup-1', target: 'preference', text: '한 번만 | expires=1d | end=x' });
  await run('memory-save', { id: 'dup-1', target: 'preference', text: '한 번만 | expires=1d | end=x' });
  const input = event('dup-2', { kind: 'command', command: 'memory-save', target: 'preference', text: '동시 | expires=1d | end=x', mention: undefined });
  await Promise.all([ingress.receive({ ...input }), ingress.receive({ ...input })]);
  assert.equal(await count('memories'), 2);
  assert.equal(rest.replies.filter(r => r.id === 'dup-1').length, 1);
  assert.equal(rest.replies.filter(r => r.id === 'dup-2').length, 1);
});

test('MEM-CMD 삭제 pending/deleted: 원장 기록을 확인하지 못하면 대기로 답하고 범위를 알림, 확인 뒤 같은 명령이 완료로 바꿈', async () => {
  const id = idOf(await run('memory-save', { target: 'preference', text: '지울 것 | expires=1d | end=x' }));
  ledger.appendFails = true;
  const pending = await run('memory-delete', { target: id });
  assert.ok(pending!.startsWith(`상태: 삭제 대기(pending) \`${id}\`\n삭제 원장 기록을 확인하지 못해 아직 삭제하지 않았습니다.`));
  assert.ok(pending!.includes('백업에는 최대 14일')); assert.ok(pending!.includes(DELETE_SCOPE));
  assert.equal((await run('memory-search', { text: '지울' }))!.includes(id!), false);
  ledger.appendFails = false;
  const done = await run('memory-delete', { target: id });
  assert.ok(done!.startsWith(`상태: 삭제 완료(deleted) \`${id}\``));
  const row = (await database.db.query<{ status: string; statement: string }>('SELECT status,statement FROM memories WHERE id=$1', [id])).rows[0]!;
  assert.deepEqual(row, { status: 'deleted', statement: '' });
});

test('MEM-CMD 기록: 진술·검색어는 events·감사·로그·outbox에 남지 않고, 응답 실패 안내도 내용 없이 고정 문구', async () => {
  const secret = '기록금지문구';
  await run('memory-save', { target: 'preference', text: `${secret} | expires=1d | end=x` });
  await run('memory-search', { text: secret });
  rest.failAck = true;
  await run('memory-search', { id: 'lost-ack', text: secret });
  for (const table of ['events', 'audit', 'outbox', 'jobs']) {
    const dump = JSON.stringify((await database.db.query(`SELECT * FROM ${table}`)).rows);
    assert.equal(dump.includes(secret), false, table);
  }
  assert.equal(JSON.stringify(logs).includes(secret), false);
  // 기억 명령은 작업(job)을 만들지 않는다(모델을 부르지 않음).
  assert.equal(await count('jobs'), 0);
  const notice = (await database.db.query<{ payload: { content: string; channel: string } }>("SELECT payload FROM outbox WHERE message_key='ack-notice:' || (SELECT id FROM events WHERE delivery_id='lost-ack')")).rows;
  assert.deepEqual(notice.map(r => r.payload.content), [MEMORY_ACK_NOTICE]);
  const audit = (await database.db.query<{ kind: string }>("SELECT kind FROM audit WHERE kind='ack_uncertain'")).rows;
  assert.equal(audit.length, 1);
});

test('MEM-CMD 원장 꺼짐: 수신 목록에 없으면(지금 운영 목록) 기억 명령은 저장·응답 없이 닫힘, 처리기가 없어도 닫힘', async () => {
  ingress = wire(memory, new Set(['chat', 'list']));
  await assert.rejects(run('memory-search', { text: 'a' }), Denied);
  ingress = new DiscordIngress(f.store, f.gate, rest);
  await assert.rejects(run('memory-search', { text: 'a' }), Denied);
  assert.equal(rest.replies.length, 0);
  assert.equal(await count('events'), 0);
});

test('DOC-SRC 문서 출처 확인기: 허용 저장소의 커밋 고정 링크만 raw 파일로 확인하고, 나머지는 요청 없이 판정', async () => {
  const calls: { url: string; init: RequestInit | undefined }[] = [];
  let reply: () => Promise<Response> = async () => new Response('x', { status: 200 });
  const docs = githubDocuments({ send: (async (url: string, init?: RequestInit) => { calls.push({ url, init }); return reply(); }) as typeof fetch });
  const sha = 'b'.repeat(40);
  const pinned = `https://github.com/ukyi-app/homelab-bot/blob/${sha}/docs/ai-bot/DECISIONS.md#L10-L20`;
  assert.deepEqual(DOCUMENT_REPOSITORIES, ['ukyi-app/homelab', 'ukyi-app/homelab-bot']);
  assert.equal(await docs.check('fixture-owner', pinned, sha), 'verified');
  assert.equal(calls[0]!.url, `https://raw.githubusercontent.com/ukyi-app/homelab-bot/${sha}/docs/ai-bot/DECISIONS.md`);
  assert.equal(calls[0]!.init?.redirect, 'error');
  reply = async () => new Response('', { status: 404 });
  assert.equal(await docs.check('fixture-owner', pinned, sha), 'inaccessible');
  reply = async () => new Response('', { status: 503 });
  assert.equal(await docs.check('fixture-owner', pinned, sha), 'unverified');
  reply = async () => { throw new DOMException('timeout', 'TimeoutError'); };
  assert.equal(await docs.check('fixture-owner', pinned, sha), 'unverified');
  const before = calls.length;
  // 요청을 보내지 않는 판정들.
  assert.equal(await docs.check('fixture-owner', 'https://github.com/ukyi-app/homelab/blob/main/README.md', null), 'unverified');
  assert.equal(await docs.check('fixture-owner', pinned, 'c'.repeat(40)), 'inaccessible');
  for (const uri of [`https://github.com/other/homelab/blob/${sha}/README.md`, `https://github.com/ukyi-app/homelab/blob/${sha}/../secret`,
    `https://github.com/ukyi-app/homelab/blob/${sha}/a/%2e%2e/b`, `https://github.com/ukyi-app/homelab/blob/${sha}/a?x=1`,
    `http://github.com/ukyi-app/homelab/blob/${sha}/README.md`, `https://github.com.evil.example/ukyi-app/homelab/blob/${sha}/README.md`,
    `https://raw.githubusercontent.com/ukyi-app/homelab/${sha}/README.md`, 'file:///etc/passwd']) {
    assert.equal(await docs.check('fixture-owner', uri, null), 'inaccessible', uri);
  }
  assert.equal(calls.length, before);
});

test('MEM-CMD 응답 길이: 충돌이 많아도 저장·정정 응답은 Discord 한도 안이고 남은 충돌은 개수로 적음(PR #28 리뷰)', () => {
  const ids = Array.from({ length: 50 }, () => randomUUID());
  const saved = savedText('저장했습니다', { id: randomUUID(), status: 'candidate', conflictsWith: ids });
  assert.ok(saved.length <= REPLY_LIMIT, `저장 응답 ${saved.length}자`);
  assert.match(saved, /충돌 50건: .* 외 \d+건\(memory-search로 확인\)\. memory-correct로 정리하세요\./);
  const shown = (saved.match(/`[0-9a-f-]{36}`/g) ?? []).length - 1;
  assert.ok(shown > 0 && shown < 50);
  assert.ok(saved.includes(`외 ${50 - shown}건`));
  // 정정은 뒤에 바꾼 기억 줄이 붙는다. 그 몫을 빼고 자른다.
  const tail = `바꾼 기억 ${ids.slice(0, 5).map(id => `\`${id}\``).join(', ')}은 superseded로 검색에서 빠집니다.`;
  const corrected = `${savedText('정정했습니다. 새 기억', { id: randomUUID(), status: 'candidate', conflictsWith: ids }, REPLY_LIMIT - tail.length - 1)}\n${tail}`;
  assert.ok(corrected.length <= REPLY_LIMIT, `정정 응답 ${corrected.length}자`);
  // 충돌이 적으면 전부 적는다.
  const few = savedText('저장했습니다', { id: randomUUID(), status: 'candidate', conflictsWith: ids.slice(0, 3) });
  assert.match(few, /충돌 3건: `[^`]+`, `[^`]+`, `[^`]+`\. memory-correct로 정리하세요\./);
  assert.doesNotMatch(few, /외 \d+건/);
});
