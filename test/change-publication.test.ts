import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PublicMetadataSchema } from '../src/change-contracts.js';
import { neutralizePublicText, publicationMarker, renderPublication } from '../src/change-publication.js';
import type { PublicationInput } from '../src/change-publication.js';
import { fixtureBrief, fixtureBundle } from './change-store-fixture.js';

const KEY = { changeId: '0123456789abcdef0123456789abcdef', generation: 2 };
const SCAN = { internalMarkers: ['fixture-internal-host'] };
const input = (overrides: Partial<PublicationInput> = {}): PublicationInput => ({
  key: KEY, label: 'public', brief: fixtureBrief({ summary: '요약 제목\n둘째 줄 설명', goal: '목표 문장', acceptanceCriteria: ['기준 하나', '기준 둘'] }),
  bundle: fixtureBundle({ generation: 2 }), branch: `bot/change/${KEY.changeId}/g2`,
  verifications: [{ commandId: 'smoke-unit', status: 'passed' }],
  review: { verdict: 'pass_with_warnings', risks: [{ priority: 'P2', category: 'correctness' }, { priority: 'P3', category: 'other' }] },
  identity: { name: 'fixture-writer[bot]', email: 'fixture-writer[bot]@users.noreply.github.com' }, at: Date.UTC(2026, 0, 2, 3, 4, 5, 678), ...overrides,
});
const rendered = (value: PublicationInput) => {
  const result = renderPublication(value, SCAN);
  assert.equal(result.ok, true, JSON.stringify(result));
  return (result as Extract<typeof result, { ok: true }>).publication;
};

test('T19 B3 공개 문구: 승인 brief와 구조화 값만으로 만들고 계약 스키마를 지난다', () => {
  const publication = rendered(input());
  assert.equal(PublicMetadataSchema.safeParse(publication).success, true);
  assert.equal(publication.title, '요약 제목');
  assert.equal(publication.draft, false);
  assert.equal(publication.author.date, '2026-01-02T03:04:05Z', '초 아래를 버려 형식을 고정한다');
  assert.deepEqual(publication.author, publication.committer);
  for (const expected of ['목표 문장', '기준 둘', '`smoke-unit`', 'passed', fixtureBundle().baseCommit, fixtureBundle().resultTree, 'pass_with_warnings', 'P2', 'correctness', publicationMarker(KEY)]) {
    assert.ok(publication.body.includes(expected), expected);
  }
  assert.ok(publication.commitMessage.endsWith('\n'));
  assert.ok(publication.commitMessage.startsWith('요약 제목\n\n'));
});

test('T19 B3 공개 문구: 같은 입력은 같은 결과다(재시도·승인 digest 고정)', () => {
  assert.deepEqual(rendered(input()), rendered(input()));
});

test('T19 B3 공개 문구: 입력 스키마가 raw 로그·대화·리뷰 자유문 자리를 거부한다', () => {
  for (const extra of [{ logs: 'raw' }, { stdout: 'raw' }, { conversation: 'raw' }, { findings: 'raw' }]) {
    const result = renderPublication({ ...input(), ...extra } as PublicationInput, SCAN);
    assert.deepEqual(result, { ok: false, reason: 'publication_input_invalid' });
  }
  const freeText = input({ review: { verdict: 'pass', risks: [{ priority: 'P2', category: 'correctness', body: '자유문' } as never] } });
  assert.deepEqual(renderPublication(freeText, SCAN), { ok: false, reason: 'publication_input_invalid' });
  // 시험 실패·미실행은 V1에서 게시하지 않는다.
  assert.deepEqual(renderPublication(input({ verifications: [{ commandId: 'smoke-unit', status: 'failed' as 'passed' }] }), SCAN), { ok: false, reason: 'publication_input_invalid' });
  assert.deepEqual(renderPublication(input({ verifications: [] }), SCAN), { ok: false, reason: 'publication_input_invalid' });
});

test('T19 B3 공개 문구: mention·자동 연결·숨은 문구를 무력화한다', () => {
  const neutral = neutralizePublicText('@octocat fixes #12 and org/repo#3 GH-9 <!-- 숨김 --> ![x](https://e.example/a.png) Co-authored-by: A <a@b.example>');
  assert.ok(!/@[A-Za-z]/.test(neutral));
  assert.ok(!/#\d/.test(neutral));
  assert.ok(!/GH-\d/.test(neutral));
  assert.ok(!neutral.includes('<!--'));
  assert.ok(!neutral.includes('!['));
  assert.ok(!neutral.includes('://'));
  const zwsp = String.fromCodePoint(0x200b);
  assert.equal(neutralizePublicText('@a #1'), `@${zwsp}a #${zwsp}1`, '끊는 문자는 폭 없는 공백 하나다');
  const publication = rendered(input({ brief: fixtureBrief({ summary: '@team 검토 요청 #7', goal: '@octocat fixes #12', acceptanceCriteria: ['@other 확인'] }) }));
  for (const text of [publication.title, publication.body, publication.commitMessage]) {
    assert.ok(!/(^|[^\w])@[A-Za-z]/.test(text), text);
    assert.ok(!/#\d/.test(text), text);
  }
});

test('T19 B3 공개 문구: 본문이 marker를 위조하지 못한다', () => {
  const forged = `<!-- ${publicationMarker({ changeId: 'f'.repeat(32), generation: 1 })} -->`;
  const publication = rendered(input({ brief: fixtureBrief({ goal: forged }) }));
  assert.equal(publication.body.split('<!--').length, 2, 'marker 주석은 서버가 넣은 하나뿐이다');
  assert.ok(publication.body.includes(`<!-- ${publicationMarker(KEY)} -->`));
});

test('T19 B3 공개 문구: 넘치는 값은 자르지 않고 막는다', () => {
  assert.deepEqual(renderPublication(input({ brief: fixtureBrief({ summary: '제'.repeat(257) }) }), SCAN), { ok: false, reason: 'publication_too_long' });
  const huge = fixtureBrief({ summary: '요약', goal: '가'.repeat(4000), acceptanceCriteria: Array.from({ length: 32 }, () => '나'.repeat(1000)) });
  assert.deepEqual(renderPublication(input({ brief: huge }), SCAN), { ok: false, reason: 'publication_too_long' });
});

test('T19 B3 공개 문구: private·unknown label은 렌더링부터 막고 brief 신고로 낮출 수 없다', () => {
  for (const label of ['private', 'unknown'] as const) {
    assert.deepEqual(renderPublication(input({ label }), SCAN), { ok: false, reason: 'label_blocked' });
    assert.deepEqual(renderPublication(input({ brief: fixtureBrief({ label }) }), SCAN), { ok: false, reason: 'label_blocked' });
    // 요청은 private인데 brief가 public이라고 신고해도 올라간 label이 이긴다.
    assert.deepEqual(renderPublication(input({ label, brief: fixtureBrief({ label: 'public' }) }), SCAN), { ok: false, reason: 'label_blocked' });
  }
  assert.ok(rendered(input({ label: 'approved_public_summary' })).body.includes('approved_public_summary'));
});
