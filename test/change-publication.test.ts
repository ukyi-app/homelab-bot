import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PublicMetadataSchema } from '../src/change-contracts.js';
import { neutralizePublicText, publicationMarker, renderGuidance, renderPublication } from '../src/change-publication.js';
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

// ---- C29 확인할 것·남은 위험 ----

const NOTES = {
  checks: [{ text: '기본 포트를 8080으로 가정했어요', location: { path: 'src/a.ts', line: 1 } }, { text: '설정 파일이 없으면 기본값을 써요' }],
  risks: [{ text: '동시 요청에서 캐시가 오래될 수 있어요', location: { path: 'src/new.ts', line: null } }],
};

test('AC-25 PR 설명: 확인할 것·남은 위험 절에 항목 글과 위치가 있고, 기존 사전 리뷰 절은 그대로다', () => {
  const body = rendered(input(NOTES)).body;
  assert.ok(body.includes('## 확인할 것\n- 기본 포트를 8080으로 가정했어요 (`src/a.ts:1`)\n- 설정 파일이 없으면 기본값을 써요\n'), body);
  assert.ok(body.includes('## 남은 위험\n- 동시 요청에서 캐시가 오래될 수 있어요 (`src/new.ts`)\n'), body);
  assert.ok(body.includes('## 사전 리뷰\n- 판정: pass_with_warnings, 범위 complete\n- 남은 위험: P2 correctness 1건'), body);
  assert.ok(body.indexOf('## 확인할 것') < body.indexOf('## 사전 리뷰'));
});

test('AC-25 PR 설명: 항목이 없으면 확인할 것·남은 위험 절이 없다(C28 병합 전 옛 판 결과)', () => {
  const body = rendered(input()).body;
  assert.ok(!body.includes('## 확인할 것'));
  assert.ok(!body.includes('\n## 남은 위험'));
  assert.deepEqual(rendered(input({ checks: [], risks: [] })), rendered(input()), '빈 목록과 칸 없음은 같은 공개 문구다');
});

test('AC-25 PR 설명: 항목 글도 mention·자동 연결을 끊는다', () => {
  const body = rendered(input({ checks: [{ text: '@octocat fixes #12 <!-- 숨김 -->' }] })).body;
  assert.ok(!/(^|[^\w])@[A-Za-z]/.test(body));
  assert.ok(!/#\d/.test(body));
  assert.equal(body.split('<!--').length, 2, 'marker 주석은 서버가 넣은 하나뿐이다');
});

test('AC-25 공개 검사: 항목 글에 비밀·내부 표식이 있으면 고치지 않고 게시를 막는다', () => {
  assert.deepEqual(renderPublication(input({ checks: [{ text: 'fixture-internal-host에 붙어요' }] }), SCAN), { ok: false, reason: 'internal_marker' });
  assert.deepEqual(renderPublication(input({ risks: [{ text: `토큰 ghp_${'a'.repeat(30)} 노출` }] }), SCAN), { ok: false, reason: 'secret_detected' });
  assert.deepEqual(renderPublication(input({ risks: [{ text: '/home/owner/x 경로를 읽어요' }] }), SCAN), { ok: false, reason: 'metadata_sensitive' });
});

test('AC-25 입력 스키마: 항목 수·글 길이가 C25 상한(10개·300자)을 넘거나 위치가 틀리면 받지 않는다', () => {
  const many = Array.from({ length: 11 }, (_, index) => ({ text: `항목 ${index}` }));
  assert.deepEqual(renderPublication(input({ checks: many }), SCAN), { ok: false, reason: 'publication_input_invalid' });
  assert.deepEqual(renderPublication(input({ risks: [{ text: '가'.repeat(301) }] }), SCAN), { ok: false, reason: 'publication_input_invalid' });
  assert.deepEqual(renderPublication(input({ checks: [{ text: '위치', location: { path: '../x', line: 1 } }] }), SCAN), { ok: false, reason: 'publication_input_invalid' });
  // 최대 개수·길이·경로라도 본문 상한 안에 든다.
  const longest = (prefix: string) => Array.from({ length: 10 }, (_, index) => ({ text: '나'.repeat(300), location: { path: `${prefix}${index}/${'p'.repeat(500)}`, line: 2_147_483_647 } }));
  assert.equal(renderPublication(input({ checks: longest('c'), risks: longest('r') }), SCAN).ok, true);
});

// ---- C29 안내 리뷰 글 ----

const IDENTITY = { name: 'fixture-writer[bot]', email: 'fixture-writer[bot]@users.noreply.github.com' };
const GUIDE_SCAN = { ...SCAN, identity: IDENTITY };
// src/a.ts는 오른쪽 1~4줄, src/new.ts는 1~2줄이 diff 안이다.
const POSITIONS = new Map([['src/a.ts', new Set([1, 2, 3, 4])], ['src/new.ts', new Set([1, 2])]]);
const guide = (overrides: Partial<Parameters<typeof renderGuidance>[0]> = {}) => renderGuidance({ checks: [], risks: [], positions: POSITIONS, limit: 5, round: 0, ...overrides }, GUIDE_SCAN);

test('AC-27 안내 리뷰 글: diff 안 위치의 항목만 줄 댓글이 되고, diff 밖·줄 없음·위치 없음은 밖 목록에 남는다', () => {
  const inside = { text: '포트를 가정했어요', location: { path: 'src/a.ts', line: 2 } };
  const otherLine = { text: '바뀌지 않은 줄', location: { path: 'src/a.ts', line: 40 } };
  const otherFile = { text: '바뀌지 않은 파일', location: { path: 'README.md', line: 1 } };
  const noLine = { text: '줄을 모름', location: { path: 'src/new.ts', line: null } };
  const nowhere = { text: '위치 없음' };
  const risk = { text: '캐시가 오래될 수 있어요', location: { path: 'src/new.ts', line: 1 } };
  const result = guide({ checks: [inside, otherLine, otherFile, noLine, nowhere], risks: [risk] });
  assert.ok(result.ok, JSON.stringify(result));
  assert.deepEqual(result.comments, [
    { path: 'src/a.ts', line: 2, body: '**확인할 것** 포트를 가정했어요' },
    { path: 'src/new.ts', line: 1, body: '**남은 위험** 캐시가 오래될 수 있어요' },
  ]);
  assert.deepEqual(result.outside, { checks: [otherLine, otherFile, noLine, nowhere], risks: [] });
  assert.equal(result.body, '확인할 것과 남은 위험 중 바뀐 줄에 있는 것만 줄 댓글로 달았어요. 전체 목록은 PR 설명에 있어요.');
});

test('AC-27 안내 리뷰 글: 수정 차례는 diff 밖 항목이 Discord 결과 요약에 있다고 말한다', () => {
  const result = guide({ round: 2, checks: [{ text: '가정', location: { path: 'src/a.ts', line: 1 } }] });
  assert.ok(result.ok);
  assert.equal(result.body, '수정 2번째의 확인할 것과 남은 위험 중 바뀐 줄에 있는 것만 줄 댓글로 달았어요. 나머지는 Discord 결과 요약에 있어요.');
});

test('AC-27 안내 리뷰 글: 상한을 넘는 항목은 댓글로 달지 않고 밖 목록에 남는다. 확인할 것이 먼저다', () => {
  const at = (line: number) => ({ text: `항목 ${line}`, location: { path: 'src/a.ts', line } });
  const result = guide({ limit: 2, checks: [at(1), at(2), at(3)], risks: [at(4)] });
  assert.ok(result.ok);
  assert.deepEqual(result.comments.map(comment => comment.line), [1, 2]);
  assert.deepEqual(result.outside, { checks: [at(3)], risks: [at(4)] });
  const none = guide({ limit: 0, checks: [at(1)] });
  assert.ok(none.ok);
  assert.deepEqual([none.comments.length, none.outside.checks.length], [0, 1]);
});

test('AC-27 안내 리뷰 글: 댓글 글도 무력화하고, 비밀·내부 표식이 있으면 아무것도 내보내지 않는다', () => {
  const neutral = guide({ checks: [{ text: '@octocat fixes #12\n## 머리줄', location: { path: 'src/a.ts', line: 1 } }] });
  assert.ok(neutral.ok);
  assert.ok(!/(^|[^\w])@[A-Za-z]/.test(neutral.comments[0]!.body));
  assert.ok(!/#\d/.test(neutral.comments[0]!.body));
  assert.ok(!neutral.comments[0]!.body.includes('\n'), '줄바꿈으로 머리줄을 만들지 못한다');
  assert.deepEqual(guide({ risks: [{ text: 'fixture-internal-host 접속', location: { path: 'src/a.ts', line: 1 } }] }), { ok: false, reason: 'internal_marker' });
  assert.deepEqual(guide({ checks: [{ text: `ghp_${'b'.repeat(30)}`, location: { path: 'src/a.ts', line: 1 } }] }), { ok: false, reason: 'secret_detected' });
  // diff 밖 항목도 C27이 Discord에 실을 수 있어 함께 검사한다.
  assert.deepEqual(guide({ checks: [{ text: 'fixture-internal-host', location: { path: 'README.md', line: 1 } }] }), { ok: false, reason: 'internal_marker' });
  assert.deepEqual(guide({ checks: [{ text: '형식이 틀린 항목', location: { path: '/abs', line: 1 } }] }), { ok: false, reason: 'guidance_input_invalid' });
});
