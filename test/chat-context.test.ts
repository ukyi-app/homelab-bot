import { after, before, beforeEach, test } from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULTS } from '../src/contracts.js';
import type { Scope } from '../src/contracts.js';
import { chatPrompt } from '../src/chat-lane.js';
import type { WorkerRequestV2 } from '../src/worker.js';
import { event, fixture, localDatabase, thread } from './helpers.js';

// 개선안 v2 C3: 봇이 owner에게 실제로 게시한 자기 답(같은 대화, chat 결과, sent 페이지)을 문맥에 넣는다.
// C11: 상한은 작업자 v2 계약과 같은 50개·80KiB이고, 7일 정리로 빠진 앞부분이 있으면 신뢰 문맥 표시 칸을 채운다.
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
const LIMIT_MESSAGES = 50;
const LIMIT_BYTES = 80 * 1024;

// owner 메시지 id를 받고, 답을 실행한 뒤 Discord ID postId로 게시한다(postId가 없으면 게시하지 않음).
async function exchange(id: string, text: string, reply: string, postId?: bigint, scope: Scope = thread) {
  f.setRun(async () => ({ status: 'succeeded', stopped: true, output: { reply, proposal: null, ack_only: false }, rateLimit: null }));
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
  await exchange('1000', '디스크가 왜 느려?', 'IO 경합이나 스왑 사용 같아요.', 1001n);
  await exchange('1002', '가설 2번 더 설명해줘', '스왑 설명이에요.');
  const request = f.requests.at(-1)!.untrusted as Item[];
  assert.deepEqual(request.map(i => i.from), ['owner', 'bot', 'owner']);
  assert.equal(request[1]!.text, 'IO 경합이나 스왑 사용 같아요.');
  assert.equal(request[2]!.text, '가설 2번 더 설명해줘');
  // owner 항목은 저장된 payload에서 text·kind(명령이면 command·target)만 고르고 from을 더한다(S16).
  assert.equal((request[0] as Record<string, unknown>).kind, 'message');
});

test('미전송·전송 중·unknown·blocked 답은 빠진다', async () => {
  for (const [i, state] of ['pending', 'sending', 'unknown', 'blocked'].entries()) {
    const base = 2000 + i * 10;
    await exchange(String(base), `질문 ${state}`, `답 ${state}`, BigInt(base + 1));
    // pending은 다시 게시되지 않게 먼 미래로 미룬다. 외부 ID는 숫자 그대로라 상태만으로 빠지는지 본다.
    await database.db.query("UPDATE outbox SET state=$1,available_at=$2 WHERE message_key LIKE 'result:%' AND state='sent'", [state, f.now() + 86_400_000]);
  }
  await exchange('2100', '마지막', 'x');
  assert.deepEqual(shape(await contextFor('2100')).filter(s => s.startsWith('bot')), []);
  // 대조: 같은 행을 sent로 되돌리면 들어간다(외부 ID·순서 조건은 이미 맞다).
  await database.db.query("UPDATE outbox SET state='sent' WHERE payload->>'content'='답 unknown'");
  assert.deepEqual(shape(await contextFor('2100')).filter(s => s.startsWith('bot')), ['bot:답 unknown']);
});

test('일부 페이지만 sent면 sent 페이지만 넣고 일부로 표시한다', async () => {
  const long = Array.from({ length: 8 }, (_, i) => `${i} ${'가'.repeat(480)}`).join('\n');
  await exchange('3000', '길게 설명해줘', long);
  nextMessage = 3001n; assert.equal(await f.publisher.deliver(), true);
  const pages = (await database.db.query<{ state: string; payload: { content: string } }>(
    "SELECT state,payload FROM outbox WHERE message_key LIKE 'result:%' ORDER BY page_index")).rows;
  assert.ok(pages.length >= 2); assert.equal(pages[0]!.state, 'sent'); assert.equal(pages[1]!.state, 'pending');
  await exchange('3100', '이어서', 'x');
  const bot = (await contextFor('3100')).filter(i => i.from === 'bot');
  assert.deepEqual(bot, [{ from: 'bot', text: pages[0]!.payload.content, partial: true }]);
});

test('현재 입력 뒤에 게시된 답과 순서를 모르는 답은 빠진다', async () => {
  await exchange('4000', '첫 질문', '늦게 게시된 답');
  await f.ingress.receive(event('4002', { text: '답 오기 전 후속' }));
  await post(4005n);
  assert.deepEqual(shape(await contextFor('4002')), ['owner:첫 질문', 'owner:답 오기 전 후속']);
  // 게시 ID가 숫자가 아니면 순서가 불확실하다.
  await database.db.query("UPDATE outbox SET external_id='not-a-snowflake' WHERE message_key LIKE 'result:%'");
  await f.ingress.receive(event('4010', { text: '나중' }));
  assert.deepEqual(shape(await contextFor('4010')).filter(s => s.startsWith('bot')), []);
});

test('현재 입력 ID가 숫자가 아니면 봇 답을 넣지 않는다', async () => {
  await exchange('4500', '첫 질문', '답', 4501n);
  await f.ingress.receive(event('fixture-nonnumeric', { text: '두 번째' }));
  assert.deepEqual(shape(await contextFor('fixture-nonnumeric')), ['owner:첫 질문', 'owner:두 번째']);
});

test('다른 대화·다른 owner·read 결과는 빠진다', async () => {
  const other: Scope = { ...thread, channel: 'fixture-other-thread' };
  await exchange('5000', '다른 대화 질문', '다른 대화 답', 5001n, other);
  await exchange('5010', '질문', 'read로 바꿀 답', 5011n);
  await database.db.query("UPDATE jobs SET type='read' WHERE event_id=(SELECT id FROM events WHERE delivery_id='5010')");
  await exchange('5020', '질문 2', 'owner를 바꿀 답', 5021n);
  await database.db.query("UPDATE jobs SET owner_id='fixture-intruder' WHERE event_id=(SELECT id FROM events WHERE delivery_id='5020')");
  await exchange('5030', '질문 3', '남는 답', 5031n);
  await f.ingress.receive(event('5040', { text: '마지막' }));
  assert.deepEqual(shape(await contextFor('5040')),
    ['owner:질문', 'owner:질문 2', 'owner:질문 3', 'bot:남는 답', 'owner:마지막']);
});

test('제어 ACK·스레드 생성·실패 안내는 봇 답으로 넣지 않는다', async () => {
  await exchange('5500', '질문', '정상 답', 5501n);
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

test('전체 50개 상한, 현재 메시지가 마지막이고 오래된 것부터 빠진다', async () => {
  for (let i = 0; i < 30; i++) await exchange(String(6000 + i * 10), `질문 ${i}`, `답 ${i}`, BigInt(6001 + i * 10));
  await f.ingress.receive(event('6500', { text: '현재' }));
  const items = await contextFor('6500');
  assert.equal(items.length, LIMIT_MESSAGES);
  assert.deepEqual(items.at(-1), { ...items.at(-1), from: 'owner', text: '현재' });
  assert.deepEqual(shape(items).slice(-3), ['owner:질문 29', 'bot:답 29', 'owner:현재']);
  // 61개 중 앞 11개(질문 0~4·답 0~4, 질문 5)가 빠진다. 남은 앞부분도 시간 순서다.
  assert.deepEqual(shape(items).slice(0, 2), ['bot:답 5', 'owner:질문 6']);
  // 실제 작업자 요청도 같은 기록을 싣고 v2 스키마(50개)를 통과한다.
  await exchange('6510', '하나 더', '네');
  assert.equal((f.requests.at(-1)!.untrusted as Item[]).length, LIMIT_MESSAGES);
  assert.equal((await database.db.query<{ state: string }>(
    "SELECT j.state FROM jobs j JOIN events e ON e.id=j.event_id WHERE e.delivery_id='6510'")).rows[0]!.state, 'succeeded');
});

test('80KiB 상한은 한글·이모지 바이트와 라벨까지 센다', async () => {
  const big = '가😀'.repeat(3200); // 한 항목 약 22.4KB
  for (let i = 0; i < 4; i++) await exchange(String(7000 + i * 10), `${big}${i}`, `답 ${i}`, BigInt(7001 + i * 10));
  await f.ingress.receive(event('7100', { text: `${big}현재` }));
  const items = await contextFor('7100');
  const bytes = Buffer.byteLength(JSON.stringify(items));
  assert.ok(bytes <= LIMIT_BYTES, String(bytes));
  assert.ok(bytes > 64 * 1024, String(bytes));
  assert.equal(items.at(-1)!.text, `${big}현재`);
  // 현재(22.4KB)·답 3·질문 3·답 2·질문 2·답 1까지 들어가고 질문 1(22.4KB)에서 넘친다.
  assert.deepEqual(shape(items).map(s => s.slice(0, 6)), ['bot:답 ', 'owner:', 'bot:답 ', 'owner:', 'bot:답 ', 'owner:']);
});

test('직전 봇 답은 owner 메시지보다 먼저 자리를 받는다', async () => {
  const big = '\u0001'.repeat(7000); // JSON에서 42KB씩(입력 상한 8000자 안): 둘은 80KiB에 못 들어간다
  await exchange('8000', '처음', '직전 답', 8001n);
  await f.ingress.receive(event('8002', { text: big }));
  await f.ingress.receive(event('8003', { text: `${big}!` }));
  const items = await contextFor('8003');
  assert.ok(Buffer.byteLength(JSON.stringify(items)) <= LIMIT_BYTES);
  assert.deepEqual(items.map(i => i.from), ['bot', 'owner']);
  assert.equal(items[0]!.text, '직전 답');
});

test('입력 상한 안에서 가장 큰 현재 메시지(제어 문자 8000자, 약 48KB)도 80KiB 안이라 앞 기록과 함께 들어간다', async () => {
  await exchange('9000', '처음', '답', 9001n);
  // 제어 문자는 JSON에서 6바이트(\u0001)라 8000자가 48000바이트다.
  await f.ingress.receive(event('9002', { text: '\u0001'.repeat(DEFAULTS.maxInputChars) }));
  const items = await contextFor('9002');
  assert.deepEqual(items.map(i => i.from), ['owner', 'bot', 'owner']);
});

test('80KiB에 통째로 안 들어가는 봇 답은 앞 페이지만 일부로 넣는다', async () => {
  const reply = Array.from({ length: 24 }, (_, i) => `${i} ${'다'.repeat(490)}`).join('\n'); // 약 35KB
  await exchange('9500', '전부 알려줘', reply, 9501n);
  const pages = (await database.db.query<{ payload: { content: string } }>(
    "SELECT payload FROM outbox WHERE message_key LIKE 'result:%' AND state='sent' ORDER BY page_index")).rows.map(r => r.payload.content);
  assert.ok(pages.length >= 6);
  // 제어 문자 8000자(48KB) 현재 메시지와 합치면 80KiB를 넘는다.
  await f.ingress.receive(event('9600', { text: '\u0001'.repeat(DEFAULTS.maxInputChars) }));
  const context = await contextFor('9600');
  assert.ok(Buffer.byteLength(JSON.stringify(context)) <= LIMIT_BYTES);
  // 잘린 직전 답 뒤에도 남은 자리에 들어가는 더 오래된 짧은 질문은 넣는다.
  assert.deepEqual(shape(context).map(s => s.split(':')[0]), ['owner', 'bot', 'owner']);
  const bot = context[1]!;
  assert.equal(bot.partial, true);
  assert.ok(pages.join('').startsWith(bot.text) && bot.text.length < pages.join('').length);
  assert.equal(pages.some((_, n) => pages.slice(0, n + 1).join('') === bot.text), true);
});

const lastRequest = () => f.requests.at(-1)! as WorkerRequestV2;
const NOTE = '이 대화의 앞부분 일부는 원문 보존 기간(7일)이 지나 지워져 기록에 없다';

test('정리 표시: 지워진 앞부분이 없으면 earlierPurged는 거짓이고 프롬프트에 표시가 없다', async () => {
  await exchange('9700', '처음', '답', 9701n);
  await exchange('9702', '다음', '네');
  assert.equal(lastRequest().earlierPurged, false);
  assert.ok(!chatPrompt(lastRequest()).includes(NOTE));
});

test('정리 표시: 원문을 비운 owner 메시지가 앞에 있으면 기록에서 빠지고 표시 칸이 채워진다', async () => {
  await exchange('9800', '오래된 질문', '오래된 답', 9801n);
  await exchange('9802', '덜 오래된 질문', '덜 오래된 답', 9803n);
  await database.db.query("UPDATE events SET text_purged_at=$1 WHERE delivery_id='9800'", [f.now()]);
  await exchange('9804', '처음에 뭐라고 했지?', '기억나지 않아요.');
  assert.equal(lastRequest().earlierPurged, true);
  assert.deepEqual(shape(lastRequest().untrusted as Item[]),
    ['bot:오래된 답', 'owner:덜 오래된 질문', 'bot:덜 오래된 답', 'owner:처음에 뭐라고 했지?']);
  // 표시는 대화 기록(untrusted) 밖, 신뢰 문맥에 든다.
  const prompt = chatPrompt(lastRequest());
  const history = prompt.indexOf(JSON.stringify(lastRequest().untrusted));
  assert.ok(prompt.indexOf(NOTE) > 0 && prompt.indexOf(NOTE) < history);
});

test('정리 표시: 본문을 비운 봇 답 페이지가 앞에 있어도 표시 칸이 채워진다', async () => {
  await exchange('9900', '질문', '비워질 답', 9901n);
  await database.db.query("UPDATE outbox SET content_purged_at=$1 WHERE message_key LIKE 'result:%'", [f.now()]);
  await exchange('9902', '아까 답 다시', '기억나지 않아요.');
  assert.equal(lastRequest().earlierPurged, true);
  assert.deepEqual(shape(lastRequest().untrusted as Item[]), ['owner:질문', 'owner:아까 답 다시']);
});

test('정리 표시: 다른 대화의 정리는 이 대화 표시에 들지 않는다', async () => {
  const other: Scope = { ...thread, channel: 'fixture-other-thread' };
  await exchange('9950', '다른 대화', '다른 답', 9951n, other);
  await database.db.query("UPDATE events SET text_purged_at=$1 WHERE delivery_id='9950'", [f.now()]);
  await database.db.query("UPDATE outbox SET content_purged_at=$1 WHERE message_key LIKE 'result:%'", [f.now()]);
  await exchange('9960', '이 대화', '네');
  assert.equal(lastRequest().earlierPurged, false);
});
