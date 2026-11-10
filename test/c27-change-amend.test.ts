import { after, afterEach, before, beforeEach, test } from 'node:test';
import assert from 'node:assert/strict';
import { AMENDMENT_REQUEST_TEXT, discussionMaterials } from '../src/change-commands.js';
import { amendmentMaterialsDigest, CHANGE_AMENDMENT } from '../src/change-contracts.js';
import { AMENDMENT_TEXT } from '../src/change-runtime.js';
import { ChatReplySchema, PROPOSAL_RUN_ACTIONS } from '../src/contracts.js';
import type { PullDiscussion } from '../src/github-review-io.js';
import { actions, notifyThread, TRUNCATE } from './c14-actions-fixture.js';
import type { Actions } from './c14-actions-fixture.js';
import type { ChangeRepositoryPolicy } from '../src/change-policy.js';
import { REPO, repositoryPolicy } from './change-github-fake.js';
import { driveTo, git, ok } from './change-store-fixture.js';
import { localDatabase } from './helpers.js';

// C27 말로 하는 수정 요청(COLLEAGUE_SPEC §4.3·§4.10, AC-28). 경계는 S1이다: Gateway 프레임 → 수신·대화 차례·제안 대조(PGlite) → 가짜 Discord REST.
// PR 리뷰·댓글 읽기는 가짜 reader다. 차례 실행·게시는 change-assembly 시험(AC-28)이 본다.
let database: Awaited<ReturnType<typeof localDatabase>>;
let open: Actions | undefined;
before(async () => { database = await localDatabase(); });
beforeEach(async () => {
  await database.pg.exec(TRUNCATE);
  await database.pg.exec(`UPDATE execution_lanes SET closed_reason=NULL,closed_at=NULL`);
});
afterEach(async () => { await open?.close(); open = undefined; });
after(async () => { await database.pg.close(); });

const body = (content: string) => content.split('\n-# ref:')[0]!;
let seq = 500;
const message = () => `1000000000000${String(++seq).padStart(5, '0')}`;
const user = (id: number) => ({ id, login: `user${id}`, kind: 'user' as const });
function discussion(): PullDiscussion {
  return { repository: REPO.fullName, pr: 7, truncated: false,
    reviews: [{ id: 31, author: user(1), association: 'MEMBER', createdAt: '2026-01-02T03:05:00Z', body: '상수를 바꿔 주세요', state: 'COMMENTED', commitId: null },
      // 본문 없는 승인 리뷰는 반영할 내용이 없어 세지 않는다.
      { id: 32, author: user(2), association: 'OWNER', createdAt: '2026-01-02T03:06:00Z', body: '  ', state: 'APPROVED', commitId: null }],
    reviewComments: [{ id: 33, author: user(3), association: 'CONTRIBUTOR', createdAt: '2026-01-02T03:04:00Z', body: '이 줄', reviewId: 31, inReplyTo: null,
      path: 'src/a.ts', line: 1, side: 'RIGHT', commitId: 'a'.repeat(40) }],
    comments: [{ id: 34, author: null, association: 'NONE', createdAt: '2026-01-02T03:07:00Z', body: '탈퇴한 계정의 댓글' }] };
}
async function wired(options: { colleague?: boolean; fail?: boolean; reader?: false; repositories?: ChangeRepositoryPolicy[] } = {}) {
  const reads: { repository: string; pr: number }[] = [];
  open = await actions(database.db, { colleague: options.colleague ?? true, ...(options.repositories ? { repositories: options.repositories } : {}), ...(options.reader === false ? {} : { discussion: async (input: { repository: string; pr: number }) => {
    reads.push(input);
    if (options.fail) throw new Error('read_failed');
    return discussion();
  } }) });
  return { a: open, reads };
}
// 이 스레드에서 '/change'로 받은 변경을 PR 게시(proposed, PR #7)까지 민다.
async function published(a: Actions) {
  await a.slash('change', { target: REPO.fullName, text: '공개 요약 | accept=시험 통과 | label=public' });
  const id = (await database.db.query<{ id: string }>('SELECT id FROM change_requests ORDER BY created_at DESC LIMIT 1')).rows[0]!.id;
  await driveTo(a.changeStore, 'proposed', ok(await a.changeStore.get(id)));
  return id;
}
const rounds = async (id: string) => (await database.db.query<{ round: number; state: string; event_id: string; materials: string[]; confirmed_head: string; pull_number: number }>(
  'SELECT round,state,event_id,materials,confirmed_head,pull_number FROM change_amendments WHERE change_id=$1 ORDER BY round', [id])).rows;

test('C27 수정 요청 확인: "PR #n에 리뷰 댓글 k개를 반영해서 수정 커밋을 올릴까요?"로 묻고 누르기 전 접수 0건, 누르면 owner 원문을 지시로 대기열에 넣는다', async () => {
  const { a, reads } = await wired();
  const id = await published(a);
  await a.speak(message(), 'PR 7에 리뷰 반영해 줘', { action: 'change_amend', target: '#7', content: '모델이 다시 쓴 지시' });
  assert.equal(body(a.buttons().content), AMENDMENT_REQUEST_TEXT.question(REPO.fullName, 7, 3));
  assert.deepEqual(reads, [{ repository: REPO.fullName, pr: 7 }]);
  assert.equal((await rounds(id)).length, 0, '누르기 전에는 접수하지 않는다');
  // 확인 글을 만들 때 읽은 글의 digest가 제안 값에 묶인다. 본문은 값에 없다(값은 누른 뒤 비워진다).
  const pending = (await a.proposals()).at(-1)!;
  assert.equal((JSON.parse(pending.value!) as { materialsDigest: string }).materialsDigest, amendmentMaterialsDigest(discussionMaterials(discussion())));
  assert.ok(!pending.value!.includes('상수를 바꿔 주세요'));
  await a.press(a.buttons().ids[0]!);
  const [round] = await rounds(id);
  assert.deepEqual([round!.round, round!.state, Number(round!.pull_number), round!.confirmed_head], [1, 'queued', 7, git('h')]);
  // 확인 때 센 ID 묶음(오래된 것부터, 빈 리뷰 제외)이 그대로 실행 자료의 범위다.
  assert.deepEqual(round!.materials, ['review_comment:33', 'review:31', 'comment:34']);
  const proposal = (await a.proposals()).at(-1)!;
  assert.equal(round!.event_id, `proposal:${proposal.id}`);
  const digest = (await database.db.query<{ materials_digest: string }>('SELECT materials_digest FROM change_amendments WHERE event_id=$1', [round!.event_id])).rows[0]!.materials_digest;
  assert.equal(digest, amendmentMaterialsDigest(discussionMaterials(discussion())));
  const instruction = (await database.db.query<{ text: string; label: string }>('SELECT text,label FROM change_request_inputs WHERE event_id=$1', [round!.event_id])).rows[0]!;
  assert.deepEqual([instruction.text, instruction.label], ['PR 7에 리뷰 반영해 줘', 'public']);
  assert.equal(String(a.lastCallback()!.data.content), AMENDMENT_REQUEST_TEXT.accepted(1));

  // 수정 차례가 도는 중에 확정된 요청은 다음 차례다. 대상은 변경 ID로도 고를 수 있다.
  ok(await a.changeStore.startAmendment({ changeId: id, generation: 1 }));
  await a.speak(message(), '하나 더 반영해 줘', { action: 'change_amend', target: id, content: null });
  await a.press(a.buttons().ids[0]!);
  assert.deepEqual((await rounds(id)).map(item => [item.round, item.state]), [[1, 'running'], [2, 'queued']]);
  assert.equal(String(a.lastCallback()!.data.content), AMENDMENT_REQUEST_TEXT.queued(2));
});

test('C27 수정 요청 PR 링크: 링크의 저장소와 번호를 함께 대조해 같은 스레드의 다른 저장소 #7을 고르지 않고, 확인 글에 저장소를 보인다', async () => {
  const OTHER = 'fixture-org/fixture-other';
  const { a } = await wired({ repositories: [repositoryPolicy(), repositoryPolicy({ repoId: 4343, fullName: OTHER })] });
  const mine = await published(a);
  // 같은 스레드에서 더 최근에 다른 저장소의 PR #7이 올라온 변경. 저장소는 바꿀 수 없는 칸이라 트리거를 끄고 옮긴다.
  await a.slash('change', { target: REPO.fullName, text: '다른 요약 | accept=시험 통과 | label=public' });
  const other = (await database.db.query<{ id: string }>('SELECT id FROM change_requests WHERE id<>$1', [mine])).rows[0]!.id;
  await driveTo(a.changeStore, 'proposed', ok(await a.changeStore.get(other)));
  await database.pg.exec(`SET session_replication_role=replica;
    UPDATE change_requests SET repo_id=4343,updated_at=updated_at+60000 WHERE id='${other}'; UPDATE change_generations SET repo_id=4343 WHERE change_id='${other}';
    SET session_replication_role=origin;`);
  await a.speak(message(), '이 PR 리뷰 반영해 줘', { action: 'change_amend', target: `https://github.com/${REPO.fullName}/pull/7`, content: null });
  assert.equal(body(a.buttons().content), AMENDMENT_REQUEST_TEXT.question(REPO.fullName, 7, 3));
  await a.press(a.buttons().ids[0]!);
  assert.deepEqual([(await rounds(mine)).length, (await rounds(other)).length], [1, 0], '링크의 저장소 변경에 들어간다');

  await a.speak(message(), '저 PR 리뷰 반영해 줘', { action: 'change_amend', target: `https://github.com/${OTHER}/pull/7`, content: null });
  assert.equal(body(a.buttons().content), AMENDMENT_REQUEST_TEXT.question(OTHER, 7, 3));
  // 정책에 없는 저장소의 링크는 번호가 같아도 고르지 않는다.
  const before = a.buttons().posted.length;
  await a.speak(message(), '그 PR 반영해 줘', { action: 'change_amend', target: 'https://github.com/fixture-org/unknown/pull/7', content: null });
  assert.equal((await a.dropped()).at(-1)!.reason, 'target_denied');
  assert.equal(a.buttons().posted.length, before);
});

test('C27 수정 요청 거절: 병합·닫힌 PR과 상한에 닿은 변경은 확인 글 없이 거절 한 줄로 답하고, 남의 스레드·없는 PR은 버린다', async () => {
  const { a } = await wired();
  const id = await published(a);
  for (let i = 0; i < CHANGE_AMENDMENT.maxRounds; i++) {
    ok(await a.changeStore.requestAmendment({ changeId: id, generation: 1, eventId: `limit-${i}`, actor: (await a.changeStore.get(id) as { value: { ownerId: string } }).value.ownerId,
      pullNumber: 7, head: git('h'), materials: [], materialsDigest: amendmentMaterialsDigest([]), instruction: '반영', label: 'public' }));
  }
  await a.speak(message(), 'PR 7 고쳐 줘', { action: 'change_amend', target: '#7', content: null });
  assert.equal(a.buttons().posted.length, 0, '확인 글이 없다');
  await a.deliver();
  assert.ok(a.posted().includes(AMENDMENT_REQUEST_TEXT.limit(CHANGE_AMENDMENT.maxRounds)), JSON.stringify(a.posted()));

  const closed = await published(a);
  ok(await a.changeStore.transition({ changeId: closed, generation: 1, from: 'proposed', to: 'cancelled', reason: 'closed_unmerged' }));
  await a.speak(message(), '그 PR 고쳐 줘', { action: 'change_amend', target: closed, content: null });
  const merged = await published(a);
  ok(await a.changeStore.recordMerge({ changeId: merged, generation: 1, prNumber: 7, headSha: git('h'), mergeCommit: git('m') }));
  await a.speak(message(), '병합된 PR 고쳐 줘', { action: 'change_amend', target: merged, content: null });
  await a.deliver();
  assert.equal(a.posted().filter(text => text === AMENDMENT_REQUEST_TEXT.not_open).length, 2);
  assert.equal(a.buttons().posted.length, 0);

  // 이 스레드에서 볼 수 없는 변경·없는 PR은 존재를 알리지 않고 버린다.
  await a.speak(message(), 'PR 99 고쳐 줘', { action: 'change_amend', target: '#99', content: null });
  await a.speak(message(), '그 PR 고쳐 줘', { action: 'change_amend', target: id, content: null }, { scope: notifyThread });
  assert.deepEqual((await a.dropped()).slice(-2).map(row => row.reason), ['target_denied', 'target_denied']);
  assert.equal(a.buttons().posted.length, 0);
});

test('C27 수정 요청: 공개하면 안 되는 값이 섞인 말은 거절하고, 자료를 읽지 못하면 확인 글 없이 거절하며, 스위치가 꺼져 있으면 동작이 없다', async () => {
  const first = await wired();
  await published(first.a);
  await first.a.speak(message(), 'fixture-corp-host 주소로 바꿔 줘', { action: 'change_amend', target: '#7', content: null });
  await first.a.deliver();
  assert.ok(first.a.posted().includes(AMENDMENT_REQUEST_TEXT.sensitive));
  assert.equal(first.a.buttons().posted.length, 0);
  await open!.close(); open = undefined;
  await database.pg.exec(TRUNCATE);

  const failing = await wired({ fail: true });
  await published(failing.a);
  await failing.a.speak(message(), 'PR 7 고쳐 줘', { action: 'change_amend', target: '#7', content: null });
  assert.equal(failing.a.buttons().posted.length, 0);
  await failing.a.deliver();
  assert.ok(failing.a.posted().includes(AMENDMENT_REQUEST_TEXT.unavailable));
  await open!.close(); open = undefined;
  await database.pg.exec(TRUNCATE);

  const off = await wired({ colleague: false });
  await published(off.a);
  await off.a.speak(message(), 'PR 7 고쳐 줘', { action: 'change_amend', target: '#7', content: null });
  assert.equal(off.a.buttons().posted.length, 0);
  assert.equal(off.reads.length, 0, '스위치가 꺼져 있으면 PR 글도 읽지 않는다');
  assert.equal((await off.a.proposals()).length, 0);
});

test('C27 제안 동작 ID: 목록 끝에 change_amend 하나만 더해 앞 줄의 뜻·순서가 그대로다(옛 작업자는 이 제안을 낼 수 없을 뿐 대화는 그대로)', () => {
  assert.deepEqual([...PROPOSAL_RUN_ACTIONS], ['task', 'cancel', 'task_cancel', 'retry', 'memory_save', 'memory_correct', 'memory_exclude', 'memory_delete',
    'attach', 'detach', 'change', 'change_cancel', 'review_resume', 'review_cancel', 'review_request', 'change_amend']);
  // 옛 작업자(9b067e9)의 출력은 이 목록의 앞부분만 쓰므로 새 게시 서버가 그대로 받는다. 새 동작도 받는다.
  for (const action of ['review_request', 'change', 'change_amend']) {
    assert.equal(ChatReplySchema.safeParse({ reply: '네', proposal: { action, target: '#7', content: null }, ack_only: false }).success, true, action);
  }
});

test('C27 자료 항목: 리뷰·리뷰 댓글·대화 댓글을 오래된 것부터 두고 빈 본문을 빼며, 저장소 경로 꼴이 아닌 위치는 버린다', () => {
  const read = discussion();
  read.reviewComments.push({ ...read.reviewComments[0]!, id: 35, path: '../etc/passwd', createdAt: '2026-01-02T03:08:00Z', body: '바깥 경로' });
  assert.deepEqual(discussionMaterials(read).map(item => [item.id, item.material.kind, item.material.authorId, item.material.location]), [
    ['review_comment:33', 'review_comment', 3, { path: 'src/a.ts', line: 1 }],
    ['review:31', 'review', 1, null],
    ['comment:34', 'comment', null, null],
    ['review_comment:35', 'review_comment', 3, null],
  ]);
});

test('C27 리뷰 경로 없음: PR 리뷰·댓글 읽기가 없으면 수정 요청은 확인 글 없이 거절 한 줄로 끝나고, 변경 요청·게시 흐름은 그대로다', async () => {
  const { a } = await wired({ reader: false });
  const id = await published(a);
  assert.equal((await a.changeStore.get(id) as { value: { phase: string } }).value.phase, 'proposed');
  await a.speak(message(), 'PR 7에 리뷰 반영해 줘', { action: 'change_amend', target: '#7', content: null });
  assert.equal(a.buttons().posted.length, 0);
  await a.deliver();
  assert.ok(a.posted().includes(AMENDMENT_REQUEST_TEXT.unavailable), JSON.stringify(a.posted()));
  assert.equal((await rounds(id)).length, 0);
  // 말로 한 변경 요청은 지금처럼 확인 뒤 접수된다.
  await a.speak(message(), '로그인 화면 오타 고쳐 줘', { action: 'change', target: REPO.fullName, content: null });
  assert.equal(body(a.buttons().content), `${REPO.fullName}에 이 변경 PR을 준비할까요?`);
  await a.press(a.buttons().ids[0]!);
  assert.equal((await database.db.query('SELECT id FROM change_requests')).rows.length, 2);
});

test("C27 문구: 수정 요청·결과 문구는 동료 말투(해요체)이고 '/' 명령 이름이 없다(C18 검사 방식)", () => {
  const slashName = /(^|[^\p{L}\p{N}])\/[a-z][a-z-]*/u;
  const texts = [...Object.values(AMENDMENT_REQUEST_TEXT).map(text => typeof text === 'string' ? text : (text as (...values: unknown[]) => string)(REPO.fullName, 7, 3)),
    AMENDMENT_TEXT.committed(7, 1, 2, 1, 1, 3), AMENDMENT_TEXT.checks, AMENDMENT_TEXT.risks,
    ...['head_changed', 'verification_failed', 'review_blocked', 'policy_changed', 'fixture_unknown_reason'].map(reason => AMENDMENT_TEXT.failed(7, 1, reason))];
  for (const text of texts) {
    assert.doesNotMatch(text, slashName, text);
    assert.doesNotMatch(text, /니다|봇/, text);
  }
  // 문장으로 끝나는 안내는 해요체다(목록 머리 두 줄은 문장이 아니다).
  for (const text of texts.filter(text => !text.endsWith(':'))) assert.match(text, /요[.?]?$|사유 코드: [a-z_]+\.$/, text);
});
