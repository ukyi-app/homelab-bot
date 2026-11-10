import assert from 'node:assert/strict';
import test from 'node:test';
import { CHANGE_NOTICE_TEXT, ChangeRuntime } from '../src/change-runtime.js';
import type { ChangeRuntimeDeps } from '../src/change-runtime.js';
import type { ChangeRequest } from '../src/change-store.js';
import { PUBLISH_TEXT } from '../src/change-commands.js';
import { buttonAllowed } from '../src/discord-protocol.js';
import { messagePages } from '../src/format.js';
import { Store } from '../src/store.js';
import { CONVERSATION, OWNER, fixtureApprovalSubject, fixtureReview, seedConversation } from './change-store-fixture.js';
import { localDatabase } from './helpers.js';

// A05: CHANGE 게시 미리보기의 승인 명령이 페이지 경계에 걸려도 한 메시지 안에 통째로 있어야 복사해 승인할 수 있다.
// 미리보기는 실제 ChangeRuntime.preview로 만들고, 변경 파일 경로 길이로 digest 위치를 경계 주변에 맞춘다.
const PAGE = 1800;
const request = { id: 'a'.repeat(32), generation: 1 } as ChangeRequest;
const digest = 'b'.repeat(64);
const command = `/change-publish target:${request.id} text:${digest}`;

async function previewWithDigestAt(target: number, files: number): Promise<string> {
  const entries = Array.from({ length: files }, (_, index) => ({ changeKind: 'added', path: `src/file${index}.ts` }));
  const deps = {
    // 리뷰 receipt만 답한다. 확인할 것 기록(change_notes)은 없는 옛 판 결과다.
    store: { now: () => 0, db: { query: async (sql: string) => ({ rows: sql.includes('change_reviews') ? [{ receipt: fixtureReview() }] : [] }) } },
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

// C17: 여러 쪽 미리보기의 게시 승인 버튼. 실제 ChangeRuntime 알림과 실제 Store.enqueue(outbox 쪽 나눔)를 거친다.
async function previewRows(colleague: boolean, approval: string) {
  const { db, pg } = await localDatabase();
  try {
    await seedConversation(db);
    const entries = Array.from({ length: 60 }, (_, index) => ({ changeKind: 'added', path: `src/${'deep/'.repeat(8)}file${index}.ts` }));
    const deps = {
      store: new Store(db, () => 0, colleague),
      gate: { current: async () => ({ revision: 'fixture-v1' }) },
      changes: { approvalSubject: async () => ({ ok: true, value: { subject: fixtureApprovalSubject(request.id), digest: approval } }),
        loadArtifact: async () => ({ ok: true, value: { manifest: { entries } } }) },
    } as unknown as ChangeRuntimeDeps;
    const runtime = new ChangeRuntime(deps) as unknown as { notifyPhase(request: ChangeRequest): Promise<void> };
    await runtime.notifyPhase({ ...request, phase: 'awaiting_publish_approval', conversationId: CONVERSATION, ownerId: OWNER,
      scope: { guild: 'fixture-guild', channel: 'fixture-thread', parent: 'fixture-chat', kind: 'thread' } } as ChangeRequest);
    return (await db.query<{ page_index: number; payload: { content: string; buttons?: { id: string; label: string }[] } }>(
      'SELECT page_index,payload FROM outbox ORDER BY page_index')).rows;
  } finally { await pg.close(); }
}
const APPROVAL = '0123456789abcdef'.repeat(4);

test('C17: 스위치가 켜져 있으면 여러 쪽 미리보기의 마지막 쪽에만 게시 버튼이 붙고, 그 버튼은 미리보기 전체의 승인 digest를 가리킨다', async () => {
  const rows = await previewRows(true, APPROVAL);
  assert.ok(rows.length > 1, `미리보기가 여러 쪽이다(${rows.length})`);
  const preview = rows.map(row => row.payload.content).join('');
  // 켜짐 판은 승인 명령 대신 이 글의 버튼을 가리킨다(C18).
  assert.ok(preview.includes(CHANGE_NOTICE_TEXT.previewApprove(true, request.id, APPROVAL)));
  assert.ok(!preview.includes('/change-publish'));
  for (const row of rows.slice(0, -1)) assert.equal(row.payload.buttons, undefined);
  const buttons = rows.at(-1)!.payload.buttons!;
  assert.equal(buttons.length, 1);
  assert.equal(buttons[0]!.id, `change-publish-ok:${request.id}.1.0123456789abcdef`);
  assert.equal(buttons[0]!.label, PUBLISH_TEXT.label);
  assert.ok(buttonAllowed(buttons[0]!.id), 'custom_id 허용 목록과 100자 상한 안이다');
});

test('C17: 스위치가 꺼져 있으면 미리보기 글에 버튼이 없다', async () => {
  const rows = await previewRows(false, APPROVAL);
  assert.ok(rows.length > 1);
  assert.ok(rows.every(row => row.payload.buttons === undefined));
  assert.ok(rows.map(row => row.payload.content).join('').includes(`/change-publish target:${request.id} text:${APPROVAL}`), "꺼짐 판은 '/' 승인 명령 그대로다");
});
