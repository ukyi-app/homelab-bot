import { after, before, beforeEach, test } from 'node:test';
import assert from 'node:assert/strict';
import { chatReplyContent } from '../src/chat-format.js';
import { DEFAULTS } from '../src/contracts.js';
import type { ChatReply } from '../src/contracts.js';
import { markedContent } from '../src/discord.js';
import { messagePages, summaryItems } from '../src/format.js';
import { readSummary } from '../src/read.js';
import type { WorkerResultV2 } from '../src/worker.js';
import { event, fixture, localDatabase } from './helpers.js';

// C11 대화 v2: 서버는 라벨 없이 reply를 그대로 게시한다(명세 §4.2, AC-3). 섹션 350자 예산은 read 요약에만 남는다.
const replied = (reply: string, patch: Partial<ChatReply> = {}): WorkerResultV2 => ({ status: 'succeeded', stopped: true,
  output: { reply, proposal: null, ack_only: false, ...patch }, rateLimit: null });
const EMPTY = '드릴 답을 만들지 못했어요. 조금 더 자세히 다시 물어봐 주세요.';
const WITHHELD = '밖에 보이면 안 되는 내용이 섞여 있어 이 답은 올리지 않았어요. 질문을 바꿔 다시 물어봐 주세요.';

test('reply는 앞뒤 공백만 다듬고 라벨 없이 그대로', () => {
  assert.equal(chatReplyContent('  노드 3개 모두 Ready예요.\n- 디스크는 61%예요.  '), '노드 3개 모두 Ready예요.\n- 디스크는 61%예요.');
  assert.doesNotMatch(chatReplyContent('사실 같은 말이에요'), /^사실:|^가설:|^미확인:|^권장 확인:/m);
});

test('reply가 비거나 공백뿐이면 동료 말투의 빈 답 문구', () => {
  assert.equal(chatReplyContent(''), EMPTY);
  assert.equal(chatReplyContent(' \n\t'), EMPTY);
});

test('JSON으로 읽히는 reply는 코드 블록으로 보내 게시 표식이 본문을 다시 감싸지 않게 한다', () => {
  const content = chatReplyContent('{"status":"ok"}');
  assert.equal(content, '```json\n{"status":"ok"}\n```');
  assert.equal(markedContent(content, 'm').startsWith(content), true);
});

test('12,000자 reply·한글·대리쌍도 하나도 버리지 않고 1800자 페이지로 나뉜다', () => {
  const reply = Array.from({ length: 24 }, (_, i) => `${i}번 ${'한'.repeat(240)}😀${'글'.repeat(250)}`.slice(0, 499)).join('\n');
  const content = chatReplyContent(reply);
  assert.equal(content, reply);
  const pages = messagePages(content);
  assert.ok(pages.length > 1);
  assert.equal(pages.join(''), content);
  for (const page of pages) {
    assert.ok(page.length <= 1800);
    assert.ok(markedContent(page, 'x'.repeat(24)).length <= 1900 + 42);
    assert.doesNotMatch(page, /^[\uDC00-\uDFFF]|[\uD800-\uDBFF]$/);
  }
});

test('read 요약은 그대로 섹션 예산·생략 건수를 쓴다', () => {
  assert.equal(summaryItems([`첫 ${'가'.repeat(400)}`], 350), ' (1개 생략)');
  assert.equal(summaryItems([], 350), '없음');
  const summary = readSummary({ service: 'fixture-service', source: 'fixture-source', status: 'ok',
    window: { from: 'a', to: 'b' }, observedAt: 1, facts: ['상태: healthy'], unknowns: [], checks: [] } as never);
  assert.match(summary, /^사실: 상태: healthy$/m);
  assert.match(summary, /^가설: 없음$/m);
  assert.match(summary, /^권장 확인: 없음$/m);
});

let database: Awaited<ReturnType<typeof localDatabase>>;
let f: Awaited<ReturnType<typeof fixture>>;
before(async () => { database = await localDatabase(); });
beforeEach(async () => {
  await database.pg.exec('TRUNCATE events,conversations,jobs,results,outbox,schedules,denied_actors,controls,audit,incidents RESTART IDENTITY CASCADE');
  f = await fixture(database.db);
});
after(async () => { await database.pg.close(); });
async function rows(table: string) { return (await database.db.query<Record<string, any>>(`SELECT * FROM ${table}`)).rows; }
async function ask(id: string) {
  await f.ingress.receive(event(id)); f.advance(DEFAULTS.debounceMs);
  await f.runtime.tick();
  while (await f.publisher.deliver()) { /* 모든 페이지 */ }
  return f.rest.messages.map(m => m.body.content.replace(/\n-# ref:[0-9a-f]+$/, '')).join('');
}

for (const colleague of [false, true]) test(`게시 경로(스위치 ${colleague ? '켜짐' : '꺼짐'}): 대화 답은 라벨 없이 reply 문장 그대로`, async () => {
  if (colleague) f = await fixture(database.db, { colleague: true });
  f.setRun(async () => replied('네, 지금 노드 3개 모두 Ready예요.\n디스크만 조금 찼어요.'));
  const posted = await ask(colleague ? '9011' : '9010');
  assert.equal(posted, '네, 지금 노드 3개 모두 Ready예요.\n디스크만 조금 찼어요.');
  assert.equal(f.requests.at(-1)!.version, 2);
});

test('게시 경로: 400자 넘는 문단도 Discord 본문에 온전히 실린다', async () => {
  const long = `원인 후보는 ${'나'.repeat(397)}예요.`;
  f.setRun(async () => replied(`디스크가 91%예요.\n${long}`));
  assert.ok((await ask('9001')).includes(long));
});

test('게시 경로: 빈 reply는 빈 답 문구로 게시된다', async () => {
  f.setRun(async () => replied('   '));
  assert.equal(await ask('9002'), EMPTY);
});

test('게시 경로: 공개 검사에 걸린 reply는 모델 글 없이 고정 문구만, 결과·감사에는 사유 코드만 남는다', async () => {
  const leaked = `그 노드는 ${['192', '168', '0', '17'].join('.')}에 있어요.`;
  f.setRun(async () => replied(leaked));
  const posted = await ask('9003');
  assert.equal(posted, WITHHELD);
  const job = (await rows('jobs'))[0]!;
  assert.equal(job.state, 'succeeded');
  const result = (await rows('results'))[0]!;
  assert.deepEqual(result.result, { withheld: 'metadata_sensitive', ack_only: false });
  const everything = JSON.stringify([await rows('results'), await rows('audit'), await rows('outbox')]);
  assert.ok(!everything.includes('192.168'), everything);
});

test('게시 경로: 내부 표식을 알 수 없으면(리뷰 정책 형식 오류) 공개 여부를 말할 수 없어 고정 문구로 닫는다', async () => {
  f.policy.review = { internalMarkers: ['fixture-internal-codename'] };
  f.setRun(async () => replied('평범한 답이에요.'));
  assert.equal(await ask('9004'), WITHHELD);
  assert.equal((await rows('results'))[0]!.result.withheld, 'policy_unavailable');
});

test('게시 경로: 제안(proposal)은 저장·게시하지 않는다', async () => {
  f.setRun(async () => replied('목록을 볼게요.', { proposal: { action: 'list', target: null, content: '비밀 제안 내용' } }));
  assert.equal(await ask('9005'), '목록을 볼게요.');
  assert.deepEqual((await rows('results'))[0]!.result, { reply: '목록을 볼게요.', ack_only: false });
  assert.ok(!JSON.stringify([await rows('results'), await rows('audit'), await rows('outbox')]).includes('비밀 제안 내용'));
});
