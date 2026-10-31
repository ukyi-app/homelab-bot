import { after, before, beforeEach, test } from 'node:test';
import assert from 'node:assert/strict';
import { chatAnswerContent } from '../src/chat-format.js';
import { DEFAULTS } from '../src/contracts.js';
import type { Answer } from '../src/contracts.js';
import { markedContent } from '../src/discord.js';
import { messagePages, summaryItems } from '../src/format.js';
import { readSummary } from '../src/read.js';
import { event, fixture, localDatabase } from './helpers.js';

// 개선안 v2 C1: 대화 답의 항목을 조용히 버리지 않는다. 섹션 350자 예산은 read 요약에만 남는다.
const empty: Answer = { facts: [], hypotheses: [], unknowns: [], checks: [] };
const answer = (patch: Partial<Answer>): Answer => ({ ...empty, ...patch });

test('첫 항목이 400자여도 온전히 싣는다', () => {
  const long = `원인 후보 ${'가'.repeat(394)}`;
  const content = chatAnswerContent(answer({ facts: ['디스크 사용률 91%'], hypotheses: [long] }));
  assert.ok(content.includes(long), content);
  assert.doesNotMatch(content, /생략/);
});

test('사실 1개뿐이면 라벨 없이 그 문장만', () => {
  assert.equal(chatAnswerContent(answer({ facts: ['  지금 노드 3개 모두 Ready입니다.  '] })), '지금 노드 3개 모두 Ready입니다.');
  // 공백 항목은 내용이 아니다. 실질 사실이 하나면 단순 답이다.
  assert.equal(chatAnswerContent(answer({ facts: ['한 줄 답'], checks: ['   '] })), '한 줄 답');
});

test('사실 1개라도 JSON처럼 읽히면 라벨을 붙여 게시 표식이 본문을 바꾸지 않게 한다', () => {
  const fact = '{"status":"ok"}';
  const content = chatAnswerContent(answer({ facts: [fact] }));
  assert.notEqual(content, fact);
  assert.equal(markedContent(content, 'm').startsWith(content), true);
});

test('빈 섹션은 생략하고 순서는 사실·가설·미확인·권장 확인', () => {
  const content = chatAnswerContent(answer({ facts: ['a', 'b'], unknowns: ['c'], checks: ['d'] }));
  assert.equal(content, ['사실:', '- a', '- b', '', '미확인:', '- c', '', '권장 확인:', '- d'].join('\n'));
  assert.doesNotMatch(content, /가설|없음/);
  const noFacts = chatAnswerContent(answer({ hypotheses: ['h'] }));
  assert.equal(noFacts, '가설:\n- h');
});

test('네 배열이 모두 비거나 공백뿐이면 결정적 안내', () => {
  const notice = '답변 내용을 얻지 못했습니다. 질문을 보완해 다시 요청해 주세요.';
  assert.equal(chatAnswerContent(empty), notice);
  assert.equal(chatAnswerContent(answer({ facts: [' ', '\n'], checks: ['\t'] })), notice);
});

test('최대 24항목·한글·대리쌍도 하나도 버리지 않고 1800자 페이지로 나뉜다', () => {
  const item = (label: string, i: number) => `${label}${i} ${'한'.repeat(240)}😀${'글'.repeat(250)}`.slice(0, 500);
  const full: Answer = {
    facts: Array.from({ length: 8 }, (_, i) => item('사실', i)),
    hypotheses: Array.from({ length: 4 }, (_, i) => item('가설', i)),
    unknowns: Array.from({ length: 8 }, (_, i) => item('미확인', i)),
    checks: Array.from({ length: 4 }, (_, i) => item('확인', i)),
  };
  const content = chatAnswerContent(full);
  for (const value of [...full.facts, ...full.hypotheses, ...full.unknowns, ...full.checks]) assert.ok(content.includes(value));
  const pages = messagePages(content);
  assert.ok(pages.length > 1);
  assert.equal(pages.join(''), content);
  for (const page of pages) {
    assert.ok(page.length <= 1800);
    // 게시자는 표식을 붙인 본문 1900자를 넘기면 막는다. 페이지 경계에서 대리쌍이 갈라지지 않는다.
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

test('게시 경로: 400자 첫 가설이 Discord 본문에 온전히 실린다', async () => {
  const long = `가설 ${'나'.repeat(397)}`;
  f.setRun(async () => ({ status: 'succeeded', stopped: true, answer: answer({ facts: ['사실 A'], hypotheses: [long] }) }));
  await f.ingress.receive(event('9001')); f.advance(DEFAULTS.debounceMs);
  await f.runtime.tick();
  while (await f.publisher.deliver()) { /* 모든 페이지 */ }
  const posted = f.rest.messages.map(m => m.body.content.replace(/\n\[ref:[0-9a-f]+\]$/, '')).join('');
  assert.ok(posted.includes(long), posted);
});

test('게시 경로: 단순 답은 라벨 없이 한 문장', async () => {
  f.setRun(async () => ({ status: 'succeeded', stopped: true, answer: answer({ facts: ['네, 정상입니다.'] }) }));
  await f.ingress.receive(event('9002')); f.advance(DEFAULTS.debounceMs);
  await f.runtime.tick(); await f.publisher.deliver();
  assert.match(f.rest.messages[0]!.body.content, /^네, 정상입니다\.\n\[ref:[0-9a-f]+\]$/);
});
