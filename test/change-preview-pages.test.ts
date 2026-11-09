import assert from 'node:assert/strict';
import test from 'node:test';
import { ChangeRuntime } from '../src/change-runtime.js';
import type { ChangeRuntimeDeps } from '../src/change-runtime.js';
import type { ChangeRequest } from '../src/change-store.js';
import { messagePages } from '../src/format.js';
import { fixtureApprovalSubject, fixtureReview } from './change-store-fixture.js';

// A05: CHANGE 게시 미리보기의 승인 명령이 페이지 경계에 걸려도 한 메시지 안에 통째로 있어야 복사해 승인할 수 있다.
// 미리보기는 실제 ChangeRuntime.preview로 만들고, 변경 파일 경로 길이로 digest 위치를 경계 주변에 맞춘다.
const PAGE = 1800;
const request = { id: 'a'.repeat(32), generation: 1 } as ChangeRequest;
const digest = 'b'.repeat(64);
const command = `/change-publish target:${request.id} text:${digest}`;

async function previewWithDigestAt(target: number, files: number): Promise<string> {
  const entries = Array.from({ length: files }, (_, index) => ({ changeKind: 'added', path: `src/file${index}.ts` }));
  const deps = {
    store: { now: () => 0, db: { query: async () => ({ rows: [{ receipt: fixtureReview() }] }) } },
    changes: { approvalSubject: async () => ({ ok: true, value: { subject: fixtureApprovalSubject(request.id), digest } }),
      loadArtifact: async () => ({ ok: true, value: { manifest: { entries } } }) },
  } as unknown as ChangeRuntimeDeps;
  const runtime = new ChangeRuntime(deps) as unknown as { preview(request: ChangeRequest): Promise<string> };
  const base = (await runtime.preview(request)).indexOf(digest);
  let padding = target - base;
  assert.ok(padding >= 0 && padding <= files * 180, `padding ${padding}`);
  for (const entry of entries) { const n = Math.min(padding, 180); entry.path = entry.path.replace('.ts', `${'x'.repeat(n)}.ts`); padding -= n; }
  const preview = await runtime.preview(request);
  assert.equal(preview.indexOf(digest), target);
  return preview;
}
// 글자 수로만 자르는 페이지(수정 전 규칙). 시험 사례가 실제로 경계를 건드리는지 확인하는 데만 쓴다.
const fixedPages = (text: string) => Array.from({ length: Math.ceil(text.length / PAGE) }, (_, index) => text.slice(index * PAGE, (index + 1) * PAGE));

const cases = [
  { name: '경계가 digest 바로 앞(digest가 다음 페이지 첫 글자)', start: PAGE, files: 10, straddles: true },
  { name: '경계가 digest 첫 글자 바로 뒤', start: PAGE - 1, files: 10, straddles: true },
  { name: '경계가 digest 중간(감사 재현 위치 1775)', start: 1775, files: 10, straddles: true },
  { name: '경계가 digest 마지막 글자 바로 앞', start: PAGE - 63, files: 10, straddles: true },
  { name: '경계가 digest 바로 뒤', start: PAGE - 64, files: 10, straddles: false },
  { name: '둘째 경계(3600)가 digest 중간', start: 2 * PAGE - 25, files: 40, straddles: true },
];
for (const c of cases) {
  test(`A05: ${c.name}일 때도 승인 명령 전체가 한 메시지에 있다`, async () => {
    const preview = await previewWithDigestAt(c.start, c.files);
    assert.equal(fixedPages(preview).some(page => page.includes(command)), !c.straddles);
    const pages = messagePages(preview);
    assert.ok(pages.length > 1);
    assert.equal(pages.join(''), preview);
    for (const page of pages) assert.ok(page.length <= PAGE && /\S/.test(page));
    assert.equal(pages.filter(page => page.includes(`승인하려면 이 스레드에서: ${command}`)).length, 1);
  });
}

test('A05: PAGE보다 긴 한 줄과 줄바꿈 없는 글은 글자 수로 자르고 대리쌍을 가르지 않는다', () => {
  const long = `${'가'.repeat(10)}\n${'x'.repeat(PAGE - 1)}😀${'y'.repeat(2000)}`;
  const pages = messagePages(long);
  assert.equal(pages.join(''), long);
  assert.equal(pages[0], `${'가'.repeat(10)}\n`);
  assert.equal(pages[1], 'x'.repeat(PAGE - 1));
  for (const page of pages) assert.doesNotMatch(page, /^[\uDC00-\uDFFF]|[\uD800-\uDBFF]$/);
});

test('A05: 앞쪽이 공백 줄뿐이면 빈 페이지를 만들지 않는다', () => {
  const text = `\n\n${'z'.repeat(PAGE + 10)}`;
  const pages = messagePages(text);
  assert.equal(pages.join(''), text);
  for (const page of pages) assert.match(page, /\S/);
});
