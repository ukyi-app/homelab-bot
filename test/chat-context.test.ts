import { after, before, beforeEach, test } from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULTS } from '../src/contracts.js';
import type { Answer, Scope } from '../src/contracts.js';
import { event, fixture, localDatabase, thread } from './helpers.js';

// 개선안 v2 C3: 봇이 owner에게 실제로 게시한 자기 답(같은 대화, chat 결과, sent 페이지)을 문맥에 넣는다.
let database: Awaited<ReturnType<typeof localDatabase>>;
let f: Awaited<ReturnType<typeof fixture>>;
let nextMessage = 0n;
before(async () => { database = await localDatabase(); });
beforeEach(async () => {
  await database.pg.exec('TRUNCATE events,conversations,jobs,results,outbox,schedules,denied_actors,controls,audit,incidents RESTART IDENTITY CASCADE');
  f = await fixture(database.db);
  // 게시된 메시지에 Discord처럼 시간순 snowflake 숫자 ID를 준다. 기본 MockDiscord ID는 숫자가 아니라 순서 비교에서 빠진다.
  const send = f.rest.sendMessage.bind(f.rest);
  f.rest.sendMessage = async (channel, body) => {
    const sent = await send(channel, body);
    const id = String(nextMessage);
    f.rest.messages.at(-1)!.id = id;
    return { ...sent, id };
  };
});
after(async () => { await database.pg.close(); });
type Item = { from: 'owner' | 'bot'; text: string; partial?: boolean };
const empty: Answer = { facts: [], hypotheses: [], unknowns: [], checks: [] };

// owner 메시지 id를 받고, 답을 실행한 뒤 Discord ID postId로 게시한다(postId가 없으면 게시하지 않음).
async function exchange(id: string, text: string, reply: Partial<Answer>, postId?: bigint, scope: Scope = thread) {
  f.setRun(async () => ({ status: 'succeeded', stopped: true, answer: { ...empty, ...reply } }));
  await f.ingress.receive(event(id, { text, scope }));
  f.advance(DEFAULTS.debounceMs); await f.runtime.tick();
  if (postId !== undefined) await post(postId);
}
async function post(id: bigint) {
  nextMessage = id;
  while (await f.publisher.deliver()) nextMessage++;
}
async function contextFor(id: string, scope: Scope = thread): Promise<Item[]> {
  const row = (await database.db.query<{ id: string }>('SELECT id FROM events WHERE delivery_id=$1', [id])).rows[0]!;
  return await f.store.context(f.store.scopeId(scope), row.id) as Item[];
}
const shape = (items: Item[]) => items.map(i => `${i.from}:${i.text}${i.partial ? ':partial' : ''}`);

test('가설 2번 장면: 직전 봇 답이 owner 메시지 사이에 들어간다', async () => {
  await exchange('1000', '디스크가 왜 느려?', { hypotheses: ['IO 경합', '스왑 사용'] }, 1001n);
  await exchange('1002', '가설 2번 더 설명해줘', { facts: ['스왑 설명'] });
  const request = f.requests.at(-1)!.untrusted as Item[];
  assert.deepEqual(request.map(i => i.from), ['owner', 'bot', 'owner']);
  assert.match(request[1]!.text, /^가설:\n- IO 경합\n- 스왑 사용$/);
  assert.equal(request[2]!.text, '가설 2번 더 설명해줘');
  // owner 항목은 저장된 payload 그대로에 from만 더한다.
  assert.equal((request[0] as Record<string, unknown>).kind, 'message');
});

test('미전송·전송 중·unknown·blocked 답은 빠진다', async () => {
  for (const [i, state] of ['pending', 'sending', 'unknown', 'blocked'].entries()) {
    const base = 2000 + i * 10;
    await exchange(String(base), `질문 ${state}`, { facts: [`답 ${state}`] }, BigInt(base + 1));
    // pending은 다시 게시되지 않게 먼 미래로 미룬다. 외부 ID는 숫자 그대로라 상태만으로 빠지는지 본다.
    await database.db.query("UPDATE outbox SET state=$1,available_at=$2 WHERE message_key LIKE 'result:%' AND state='sent'", [state, f.now() + 86_400_000]);
  }
  await exchange('2100', '마지막', { facts: ['x'] });
  assert.deepEqual(shape(await contextFor('2100')).filter(s => s.startsWith('bot')), []);
  // 대조: 같은 행을 sent로 되돌리면 들어간다(외부 ID·순서 조건은 이미 맞다).
  await database.db.query("UPDATE outbox SET state='sent' WHERE payload->>'content'='답 unknown'");
  assert.deepEqual(shape(await contextFor('2100')).filter(s => s.startsWith('bot')), ['bot:답 unknown']);
});

test('일부 페이지만 sent면 sent 페이지만 넣고 일부로 표시한다', async () => {
  const long = (n: number) => Array.from({ length: 8 }, (_, i) => `${n}-${i} ${'가'.repeat(480)}`);
  await exchange('3000', '길게 설명해줘', { facts: long(1) });
  nextMessage = 3001n; assert.equal(await f.publisher.deliver(), true);
  const pages = (await database.db.query<{ state: string; payload: { content: string } }>(
    "SELECT state,payload FROM outbox WHERE message_key LIKE 'result:%' ORDER BY page_index")).rows;
  assert.ok(pages.length >= 2); assert.equal(pages[0]!.state, 'sent'); assert.equal(pages[1]!.state, 'pending');
  await exchange('3100', '이어서', { facts: ['x'] });
  const bot = (await contextFor('3100')).filter(i => i.from === 'bot');
  assert.deepEqual(bot, [{ from: 'bot', text: pages[0]!.payload.content, partial: true }]);
});

test('현재 입력 뒤에 게시된 답과 순서를 모르는 답은 빠진다', async () => {
  await exchange('4000', '첫 질문', { facts: ['늦게 게시된 답'] });
  await f.ingress.receive(event('4002', { text: '답 오기 전 후속' }));
  await post(4005n);
  assert.deepEqual(shape(await contextFor('4002')), ['owner:첫 질문', 'owner:답 오기 전 후속']);
  // 게시 ID가 숫자가 아니면 순서가 불확실하다.
  await database.db.query("UPDATE outbox SET external_id='not-a-snowflake' WHERE message_key LIKE 'result:%'");
  await f.ingress.receive(event('4010', { text: '나중' }));
  assert.deepEqual(shape(await contextFor('4010')).filter(s => s.startsWith('bot')), []);
});

test('현재 입력 ID가 숫자가 아니면 봇 답을 넣지 않는다', async () => {
  await exchange('4500', '첫 질문', { facts: ['답'] }, 4501n);
  await f.ingress.receive(event('fixture-nonnumeric', { text: '두 번째' }));
  assert.deepEqual(shape(await contextFor('fixture-nonnumeric')), ['owner:첫 질문', 'owner:두 번째']);
});

test('다른 대화·다른 owner·read 결과는 빠진다', async () => {
  const other: Scope = { ...thread, channel: 'fixture-other-thread' };
  await exchange('5000', '다른 대화 질문', { facts: ['다른 대화 답'] }, 5001n, other);
  await exchange('5010', '질문', { facts: ['read로 바꿀 답'] }, 5011n);
  await database.db.query("UPDATE jobs SET type='read' WHERE event_id=(SELECT id FROM events WHERE delivery_id='5010')");
  await exchange('5020', '질문 2', { facts: ['owner를 바꿀 답'] }, 5021n);
  await database.db.query("UPDATE jobs SET owner_id='fixture-intruder' WHERE event_id=(SELECT id FROM events WHERE delivery_id='5020')");
  await exchange('5030', '질문 3', { facts: ['남는 답'] }, 5031n);
  await f.ingress.receive(event('5040', { text: '마지막' }));
  assert.deepEqual(shape(await contextFor('5040')),
    ['owner:질문', 'owner:질문 2', 'owner:질문 3', 'bot:남는 답', 'owner:마지막']);
});

test('제어 ACK·스레드 생성·실패 안내는 봇 답으로 넣지 않는다', async () => {
  await exchange('5500', '질문', { facts: ['정상 답'] }, 5501n);
  await f.store.enqueue({ key: 'control:fixture', actor: f.policy.owner, scope: thread, conversation: f.store.scopeId(thread),
    revision: f.policy.revision, payload: { kind: 'message', channel: thread.channel, content: '{"ok":true}', classification: 'safe_summary' } });
  await post(5502n);
  f.setRun(async () => ({ status: 'failed', stopped: true }));
  await f.ingress.receive(event('5503', { text: '실패할 질문' })); f.advance(DEFAULTS.debounceMs); await f.runtime.tick();
  await post(5504n);
  assert.ok((await database.db.query("SELECT 1 FROM outbox WHERE message_key LIKE 'failure:%' AND state='sent'")).rows.length);
  await f.ingress.receive(event('5510', { text: '다음' }));
  assert.deepEqual(shape(await contextFor('5510')), ['owner:질문', 'bot:정상 답', 'owner:실패할 질문', 'owner:다음']);
});

test('전체 20개 상한, 현재 메시지가 마지막', async () => {
  for (let i = 0; i < 15; i++) await exchange(String(6000 + i * 10), `질문 ${i}`, { facts: [`답 ${i}`] }, BigInt(6001 + i * 10));
  await f.ingress.receive(event('6500', { text: '현재' }));
  const items = await contextFor('6500');
  assert.equal(items.length, DEFAULTS.contextMessages);
  assert.deepEqual(items.at(-1), { ...items.at(-1), from: 'owner', text: '현재' });
  assert.deepEqual(shape(items).slice(-3), ['owner:질문 14', 'bot:답 14', 'owner:현재']);
  // 가장 오래된 것부터 잘린다. 남은 앞부분도 시간 순서다.
  assert.deepEqual(shape(items).slice(0, 2), ['bot:답 5', 'owner:질문 6']);
});

test('32KiB 상한은 한글·이모지 바이트와 라벨까지 센다', async () => {
  const big = '가😀'.repeat(1300); // 한 항목 약 9.1KB
  for (let i = 0; i < 4; i++) await exchange(String(7000 + i * 10), `${big}${i}`, { facts: [`답 ${i}`] }, BigInt(7001 + i * 10));
  await f.ingress.receive(event('7100', { text: `${big}현재` }));
  const items = await contextFor('7100');
  const bytes = Buffer.byteLength(JSON.stringify(items));
  assert.ok(bytes <= 32768, String(bytes));
  assert.equal(items.at(-1)!.text, `${big}현재`);
  assert.deepEqual(shape(items).slice(-2).map(s => s.slice(0, 6)), ['bot:답 ', 'owner:']);
  assert.ok(items.length >= 3 && items.length < 9);
});

test('직전 봇 답은 owner 메시지보다 먼저 자리를 받는다', async () => {
  const big = '나'.repeat(6000); // 약 18KB씩: 둘은 32KiB에 못 들어간다
  await exchange('8000', '처음', { facts: ['직전 답'] }, 8001n);
  await f.ingress.receive(event('8002', { text: big }));
  await f.ingress.receive(event('8003', { text: `${big}!` }));
  const items = await contextFor('8003');
  assert.ok(Buffer.byteLength(JSON.stringify(items)) <= 32768);
  assert.deepEqual(items.map(i => i.from), ['bot', 'owner']);
  assert.equal(items[0]!.text, '직전 답');
});

test('현재 메시지 하나가 32KiB를 넘어도 그것만은 넣는다', async () => {
  await exchange('9000', '처음', { facts: ['답'] }, 9001n);
  // 제어 문자는 JSON에서 6바이트(\u0001)라 8000자가 48000바이트다.
  await f.ingress.receive(event('9002', { text: '\u0001'.repeat(DEFAULTS.maxInputChars) }));
  const items = await contextFor('9002');
  assert.equal(items.length, 1);
  assert.equal(items[0]!.from, 'owner');
});

test('32KiB에 통째로 안 들어가는 봇 답은 앞 페이지만 일부로 넣는다', async () => {
  const items = (n: number, label: string) => Array.from({ length: n }, (_, i) => `${label}${i} ${'다'.repeat(490)}`);
  const huge = { facts: items(8, '사실'), hypotheses: items(4, '가설'), unknowns: items(8, '미확인'), checks: items(4, '확인') };
  await exchange('9500', '전부 알려줘', huge, 9501n);
  const pages = (await database.db.query<{ payload: { content: string } }>(
    "SELECT payload FROM outbox WHERE message_key LIKE 'result:%' AND state='sent' ORDER BY page_index")).rows.map(r => r.payload.content);
  assert.ok(pages.length >= 6);
  await f.ingress.receive(event('9600', { text: '가설 2번은?' }));
  const context = await contextFor('9600');
  assert.ok(Buffer.byteLength(JSON.stringify(context)) <= 32768);
  // 잘린 직전 답 뒤에도 남은 자리에 들어가는 더 오래된 짧은 질문은 넣는다.
  assert.deepEqual(shape(context).map(s => s.split(':')[0]), ['owner', 'bot', 'owner']);
  const bot = context[1]!;
  assert.equal(bot.partial, true);
  assert.ok(pages.join('').startsWith(bot.text) && bot.text.length < pages.join('').length);
  assert.equal(pages.some((_, n) => pages.slice(0, n + 1).join('') === bot.text), true);
});
