import { test } from 'node:test';
import assert from 'node:assert/strict';
import { approvalDigest } from '../src/change-contracts.js';
import type { ChangeKey, ChangeNote, WriterOutcome } from '../src/change-contracts.js';
import { ChangeGuidance, guidanceDiffLines, readChangeNotes, recordChangeNotes } from '../src/change-guidance.js';
import type { GuidanceOutcome } from '../src/change-guidance.js';
import { renderPublication } from '../src/change-publication.js';
import { ChangeReviewFindings } from '../src/change-store.js';
import { guidanceMarker } from '../src/github-review-io.js';
import type { GuidanceReview, GuidanceReviewPort } from '../src/github-review-io.js';
import { DEFAULT_CHANGES, REPO, publishEnv } from './change-github-fake.js';
import type { PublishEnv } from './change-github-fake.js';
import { OWNER, newEvent, ok } from './change-store-fixture.js';
import { localDatabase } from './helpers.js';

// AC-27 안내 댓글(S1). 게시는 가짜 GitHub, 안내 리뷰는 C26 포트 모양의 가짜다. 값은 모두 합성이다.

// DEFAULT_CHANGES의 실제 diff. 오른쪽 줄은 src/a.ts 1, src/new.ts 1이다.
const PATCH = [
  'diff --git a/src/a.ts b/src/a.ts', '--- a/src/a.ts', '+++ b/src/a.ts', '@@ -1 +1 @@', '-export const a = 1;', '+export const a = 2;',
  'diff --git b/src/new.ts b/src/new.ts', 'new file mode 100644', '--- /dev/null', '+++ b/src/new.ts', '@@ -0,0 +1 @@', '+export const n = 1;', '',
].join('\n');
const INSIDE: ChangeNote = { text: '상수 값을 2로 가정했어요', location: { path: 'src/a.ts', line: 1 } };
const OUTSIDE_LINE: ChangeNote = { text: '바뀌지 않은 줄을 봐 주세요', location: { path: 'src/a.ts', line: 30 } };
const OUTSIDE_FILE: ChangeNote = { text: '읽어보기도 맞는지 봐 주세요', location: { path: 'README.md', line: 1 } };
const NOWHERE: ChangeNote = { text: '배포 순서를 가정했어요' };
const RISK: ChangeNote = { text: '새 파일을 아무도 부르지 않을 수 있어요', location: { path: 'src/new.ts', line: 1 } };
const NOTES = { checks: [INSIDE, OUTSIDE_LINE, OUTSIDE_FILE, NOWHERE], risks: [RISK] };

type Mode = WriterOutcome<{ id: number }> | 'lose_response';
// 안내 리뷰 포트의 대역. 표식·head로 회수하는 find는 C26 규칙과 같다.
class FakeGuidance implements GuidanceReviewPort {
  reviews: (GuidanceReview & { id: number })[] = [];
  modes: Mode[] = [];
  posts = 0;
  finds = 0;
  private next = 9000;
  async post(input: GuidanceReview): Promise<WriterOutcome<{ id: number }>> {
    this.posts++;
    const mode = this.modes.shift();
    if (mode && mode !== 'lose_response') return mode;
    const id = this.next++;
    this.reviews.push({ ...input, id });
    return mode === 'lose_response' ? { kind: 'unknown', code: 'response_lost' } : { kind: 'confirmed', value: { id } };
  }
  async find(input: Pick<GuidanceReview, 'repository' | 'pr' | 'head' | 'key'>): Promise<{ id: number } | null> {
    this.finds++;
    const found = this.reviews.find(review => review.repository === input.repository && review.pr === input.pr && review.head === input.head && review.key === input.key);
    return found ? { id: found.id } : null;
  }
}

async function setup(options: { limit?: number | null } = {}) {
  const { db, pg } = await localDatabase();
  const env = await publishEnv(db);
  const port = new FakeGuidance();
  const logs: { event: string; fields: unknown }[] = [];
  const guidance = new ChangeGuidance({ db, changes: env.store, port, policy: async () => env.policy.current, limit: async () => options.limit === undefined ? 5 : options.limit,
    now: () => env.clock.now, log: (event, fields) => { logs.push({ event, fields }); } });
  return { env, port, guidance, logs, close: () => pg.close() };
}
// 작성 결과의 확인할 것·남은 위험을 기록하고 승인·게시까지 민다. 운영에서는 ChangeRuntime이 작성 결과를 받을 때 기록한다.
async function publishWith(env: PublishEnv, notes: { checks: ChangeNote[]; risks: ChangeNote[] }, options: { patch?: string } = {}): Promise<{ key: ChangeKey; digest: string; pr: number; head: string }> {
  const key = await env.newRequest();
  const review = await env.driveToReview(key, DEFAULT_CHANGES, { patch: options.patch ?? PATCH });
  await recordChangeNotes(env.db, key, notes);
  const prepared = await env.publisher.prepareApproval(key, { review, at: env.clock.now });
  assert.ok(prepared.ok, JSON.stringify(prepared));
  ok(await env.store.approve({ ...key, approvalDigest: prepared.digest, eventId: newEvent(), actor: OWNER }));
  const outcome = await env.publisher.publish(key);
  assert.equal(outcome.kind, 'proposed', JSON.stringify(outcome));
  const published = outcome as Extract<typeof outcome, { kind: 'proposed' }>;
  return { key, digest: prepared.digest, pr: published.prNumber, head: published.headSha };
}
const posted = (outcome: GuidanceOutcome) => { assert.equal(outcome.state, 'posted', JSON.stringify(outcome)); return outcome; };

test('AC-27 diff 위치: hunk 안 오른쪽 줄만 센다. 지운 줄이 파일 머리처럼 보여도 다른 파일로 읽지 않는다', () => {
  const tricky = [
    'diff --git a/src/x.ts b/src/x.ts', '--- a/src/x.ts', '+++ b/src/x.ts', '@@ -3,4 +10,5 @@ fn', ' keep', '--- a/src/evil.ts', '+++ b/src/evil.ts', '+added', ' tail', ' end',
    'diff --git a/src/gone.ts b/src/gone.ts', 'deleted file mode 100644', '--- a/src/gone.ts', '+++ /dev/null', '@@ -1,2 +0,0 @@', '-a', '-b',
    'diff --git "a/src/\\355\\225\\234.ts" "b/src/\\355\\225\\234.ts"', '--- "a/src/\\355\\225\\234.ts"', '+++ "b/src/\\355\\225\\234.ts"', '@@ -1 +1,2 @@', ' a', '+b', '',
  ].join('\n');
  const lines = guidanceDiffLines(tricky);
  assert.deepEqual([...lines.keys()].sort(), ['src/x.ts', 'src/한.ts']);
  assert.deepEqual([...lines.get('src/x.ts')!], [10, 11, 12, 13, 14]);
  assert.deepEqual([...lines.get('src/한.ts')!], [1, 2]);
  assert.deepEqual(guidanceDiffLines('--- 합성 표시용 patch\n').size, 0, '읽지 못하는 patch는 diff 안 위치가 없다');
});

test('AC-27 처음 게시: diff 안 위치의 항목만 COMMENT 리뷰 줄 댓글로 한 번 달리고 commit_id는 확정 head다. diff 밖·위치 없는 항목은 PR 설명에만 있다', async () => {
  const { env, port, guidance, close } = await setup();
  try {
    const { key, pr, head } = await publishWith(env, NOTES);
    const outcome = posted(await guidance.afterPublish(key));
    assert.equal(port.reviews.length, 1);
    const review = port.reviews[0]!;
    assert.deepEqual({ repository: review.repository, pr: review.pr, head: review.head, key: review.key }, { repository: REPO.fullName, pr, head, key: `${key.changeId}:g${key.generation}:r0` });
    assert.deepEqual(review.comments, [
      { path: 'src/a.ts', line: 1, body: '**확인할 것** 상수 값을 2로 가정했어요' },
      { path: 'src/new.ts', line: 1, body: '**남은 위험** 새 파일을 아무도 부르지 않을 수 있어요' },
    ]);
    assert.equal(outcome.reviewId, 9000);
    assert.deepEqual(outcome.outside, { checks: [OUTSIDE_LINE, OUTSIDE_FILE, NOWHERE], risks: [] });
    const body = env.github.pulls[0]!.body ?? '';
    for (const text of [INSIDE, OUTSIDE_LINE, OUTSIDE_FILE, NOWHERE, RISK].map(note => note.text)) assert.ok(body.includes(text), text);
    assert.ok(body.includes('## 확인할 것') && body.includes('## 남은 위험'));
  } finally { await close(); }
});

test('AC-27 diff 안 위치가 없으면 리뷰를 달지 않는다(댓글 0건). 항목은 PR 설명에만 있다', async () => {
  const { env, port, guidance, close } = await setup();
  try {
    const { key } = await publishWith(env, { checks: [OUTSIDE_LINE, NOWHERE], risks: [OUTSIDE_FILE] });
    const outcome = await guidance.afterPublish(key);
    assert.deepEqual([outcome.state, outcome.reason], ['skipped', 'no_inline_items']);
    assert.equal(port.posts, 0);
    assert.ok((env.github.pulls[0]!.body ?? '').includes(OUTSIDE_LINE.text));
  } finally { await close(); }
});

test('AC-27 상한: 리뷰 정책 maxInlineComments를 넘는 항목은 댓글로 달지 않고 PR 설명에만 있다. 정책이 게시를 닫았으면 달지 않는다', async () => {
  const { env, port, guidance, close } = await setup({ limit: 1 });
  try {
    const { key } = await publishWith(env, NOTES);
    const outcome = posted(await guidance.afterPublish(key));
    assert.deepEqual(port.reviews[0]!.comments.map(comment => comment.path), ['src/a.ts']);
    assert.deepEqual(outcome.outside.risks, [RISK]);
    assert.ok((env.github.pulls[0]!.body ?? '').includes(RISK.text));
  } finally { await close(); }
  const closed = await setup({ limit: null });
  try {
    const { key } = await publishWith(closed.env, NOTES);
    const outcome = await closed.guidance.afterPublish(key);
    assert.deepEqual([outcome.state, outcome.reason], ['skipped', 'review_publish_closed']);
    assert.equal(closed.port.posts, 0);
  } finally { await closed.close(); }
});

test('AC-27 자체 리뷰 findings 글은 PR 설명과 안내 댓글 어디에도 없다', async () => {
  const { env, port, guidance, close } = await setup();
  try {
    const key = await env.newRequest();
    const review = await env.driveToReview(key, DEFAULT_CHANGES, { patch: PATCH });
    // 자체 리뷰의 모델 원문은 비공개 표에만 있다. 지적 위치가 확인할 것과 같은 줄이어도 공개 경로로 가지 않는다.
    const secretFinding = '자체리뷰-전문-표식 P2 이 함수는 경계 검사를 빠뜨렸다';
    await new ChangeReviewFindings(env.db, () => env.clock.now).save({ key, jobId: review.jobId, sessionId: review.sessionId, instructionRevision: review.instructionRevision,
      findingsDigest: review.findingsDigest, problems: [], output: { findings: [{ priority: 'P2', title: secretFinding, body: secretFinding, path: 'src/a.ts', line: 1 }], summary: secretFinding } });
    await recordChangeNotes(env.db, key, NOTES);
    const prepared = await env.publisher.prepareApproval(key, { review, at: env.clock.now });
    assert.ok(prepared.ok);
    ok(await env.store.approve({ ...key, approvalDigest: prepared.digest, eventId: newEvent(), actor: OWNER }));
    assert.equal((await env.publisher.publish(key)).kind, 'proposed');
    posted(await guidance.afterPublish(key));
    const published = JSON.stringify({ pulls: env.github.pulls, sent: env.github.sent.map(item => item.body), reviews: port.reviews });
    assert.ok(!published.includes('자체리뷰-전문-표식'));
    assert.ok(!published.includes('경계 검사를 빠뜨렸다'));
  } finally { await close(); }
});

test('AC-27 한 번만: 같은 차례를 두 번 불러도 댓글은 한 번이다', async () => {
  const { env, port, guidance, close } = await setup();
  try {
    const { key } = await publishWith(env, NOTES);
    posted(await guidance.afterPublish(key));
    const again = posted(await guidance.afterPublish(key));
    assert.equal(again.reviewId, 9000);
    assert.equal(port.posts, 1);
    assert.equal(await guidance.settled(key, 0), true);
  } finally { await close(); }
});

test('AC-27 한 번만: 응답을 잃으면 다시 보내지 않고 표식과 head SHA로 회수한다. 못 찾으면 unknown으로 두고 다시 보내지 않는다', async () => {
  const { env, port, guidance, close } = await setup();
  try {
    const { key } = await publishWith(env, NOTES);
    port.modes.push('lose_response');
    const recovered = posted(await guidance.afterPublish(key));
    assert.equal(recovered.reviewId, 9000);
    assert.deepEqual([port.posts, port.reviews.length], [1, 1]);
    // 응답도 잃고 GitHub에도 없으면(실제로 안 닿음) 회수할 것이 없다. 중복 대신 unknown이 남는다.
    const lost = await publishWith(env, NOTES);
    port.modes.push({ kind: 'unknown', code: 'response_lost' });
    assert.equal((await guidance.afterPublish(lost.key)).state, 'unknown');
    assert.equal((await guidance.afterPublish(lost.key)).state, 'unknown');
    assert.equal(port.posts, 2, '두 번째 건도 한 번만 보냈다');
    assert.equal(await guidance.settled(lost.key, 0), false);
    // 24시간이 지나면 대조를 멈추고 실패로 닫는다. PR·변경 상태는 그대로다.
    env.clock.now += 86_400_001;
    const expired = await guidance.afterPublish(lost.key);
    assert.deepEqual([expired.state, expired.reason], ['failed', 'unknown_expired']);
    assert.equal(ok(await env.store.get(lost.key.changeId)).phase, 'proposed');
    assert.equal(port.posts, 2);
  } finally { await close(); }
});

test('AC-27 한 번만: 보내는 중에 끊긴 기록(sending)은 다시 보내지 않고 회수만 한다', async () => {
  const { env, port, guidance, close } = await setup();
  try {
    const { key, pr, head } = await publishWith(env, NOTES);
    // 앞 프로세스가 전송을 시작하고 기록 전에 죽은 상태. 요청은 GitHub에 닿았다.
    await env.db.query(`INSERT INTO change_guidance(change_id,generation,round,head_sha,state,attempts,created_at,updated_at) VALUES ($1,$2,0,$3,'sending',1,$4,$4)`, [key.changeId, key.generation, head, env.clock.now]);
    port.reviews.push({ repository: REPO.fullName, pr, head, key: `${key.changeId}:g${key.generation}:r0`, body: 'x', comments: [], id: 7000 });
    const outcome = posted(await guidance.afterPublish(key));
    assert.equal(outcome.reviewId, 7000);
    assert.equal(port.posts, 0);
  } finally { await close(); }
});

test('AC-27 실패: 리뷰 App 설치·정책 밖이면 안내만 건너뛰고 게시는 그대로다. 사유 코드만 로그에 남는다', async () => {
  const { env, port, guidance, logs, close } = await setup();
  try {
    const { key } = await publishWith(env, NOTES);
    port.modes.push({ kind: 'not_sent', code: 'repository_denied' });
    const outcome = await guidance.afterPublish(key);
    assert.deepEqual([outcome.state, outcome.reason], ['skipped', 'repository_denied']);
    assert.equal(ok(await env.store.get(key.changeId)).phase, 'proposed');
    assert.equal(env.github.pulls[0]!.state, 'open');
    assert.deepEqual(logs.filter(entry => entry.event === 'change_guidance').map(entry => entry.fields), [{ round: 0, state: 'skipped', reason: 'repository_denied' }]);
    assert.ok(!JSON.stringify(logs).includes(INSIDE.text), '로그에 항목 글을 남기지 않는다');
    // 끝난 차례는 다시 보내지 않는다.
    await guidance.afterPublish(key);
    assert.equal(port.posts, 1);
  } finally { await close(); }
});

test('AC-27 실패: 연결 전 일시 실패는 미뤘다가 다시 보내고, 거부는 실패로 닫는다', async () => {
  const { env, port, guidance, close } = await setup();
  try {
    const { key } = await publishWith(env, NOTES);
    port.modes.push({ kind: 'not_sent', code: 'rate_limited' });
    const deferred = await guidance.afterPublish(key);
    assert.deepEqual([deferred.state, deferred.reason], ['deferred', 'rate_limited']);
    assert.equal((await guidance.afterPublish(key)).state, 'deferred', '기한 전에는 보내지 않는다');
    assert.equal(port.posts, 1);
    env.clock.now += 600_000;
    posted(await guidance.afterPublish(key));
    assert.equal(port.posts, 2);
    const rejected = await publishWith(env, NOTES);
    port.modes.push({ kind: 'rejected', status: 422, code: 'http_422' });
    const failed = await guidance.afterPublish(rejected.key);
    assert.deepEqual([failed.state, failed.reason], ['failed', 'http_422']);
    assert.equal(ok(await env.store.get(rejected.key.changeId)).phase, 'proposed');
  } finally { await close(); }
});

test('AC-25 승인 묶음: 승인 digest가 확인할 것 목록에 묶인다. 승인 뒤 기록을 바꿔치기하면 안내 댓글을 달지 않고 PR 설명도 승인한 그대로다', async () => {
  const { env, port, guidance, close } = await setup();
  try {
    const key = await env.newRequest();
    const review = await env.driveToReview(key, DEFAULT_CHANGES, { patch: PATCH });
    assert.equal(await recordChangeNotes(env.db, key, NOTES), true);
    assert.equal(await recordChangeNotes(env.db, key, { checks: [], risks: [] }), false, '같은 generation의 목록은 처음 것 그대로다');
    assert.deepEqual(await readChangeNotes(env.db, key), NOTES);
    const prepared = await env.publisher.prepareApproval(key, { review, at: env.clock.now });
    assert.ok(prepared.ok);
    const { subject } = ok(await env.store.approvalSubject(key));
    assert.ok(subject.publication.body.includes(INSIDE.text));
    // 목록만 다른 공개 문구는 다른 승인 대상이다.
    const swapped = renderPublication({ key, label: 'public', brief: ok(await env.store.get(key.changeId)).brief!, bundle: subject.bundle, branch: subject.branch,
      verifications: [{ commandId: 'smoke-unit', status: 'passed' }], review: { verdict: 'pass', risks: [] }, identity: env.policy.current!.identity, at: env.clock.now,
      checks: [{ text: '다른 가정', location: { path: 'src/a.ts', line: 1 } }], risks: [] }, { internalMarkers: env.policy.current!.internalMarkers });
    assert.ok(swapped.ok);
    assert.notEqual(approvalDigest({ ...subject, publication: swapped.publication }), prepared.digest);
    // 기록은 고쳐 쓸 수 없다.
    await assert.rejects(env.db.query(`UPDATE change_notes SET checks='[]'::jsonb WHERE change_id=$1`, [key.changeId]));
    ok(await env.store.approve({ ...key, approvalDigest: prepared.digest, eventId: newEvent(), actor: OWNER }));
    // 지우고 다시 넣어 바꿔치기해도 승인한 본문에 없는 글은 공개하지 않는다.
    await env.db.query('DELETE FROM change_notes WHERE change_id=$1', [key.changeId]);
    await recordChangeNotes(env.db, key, { checks: [{ text: '승인 뒤 끼운 가정', location: { path: 'src/a.ts', line: 1 } }], risks: [] });
    assert.equal((await env.publisher.publish(key)).kind, 'proposed');
    assert.equal(env.github.pulls[0]!.body, subject.publication.body);
    const outcome = await guidance.afterPublish(key);
    assert.deepEqual([outcome.state, outcome.reason], ['skipped', 'notes_unapproved']);
    assert.equal(port.posts, 0);
  } finally { await close(); }
});

test('AC-27 수정 차례 진입점: 같은 함수가 그 차례의 head·diff·목록으로 한 번 달고 diff 밖 항목을 돌려준다(C27이 Discord 요약에 싣는다)', async () => {
  const { env, port, guidance, close } = await setup();
  try {
    const { key, pr } = await publishWith(env, NOTES);
    posted(await guidance.afterPublish(key));
    const head = 'c'.repeat(40);
    const patch = ['diff --git a/src/a.ts b/src/a.ts', '--- a/src/a.ts', '+++ b/src/a.ts', '@@ -1 +1,3 @@', '-export const a = 2;', '+export const a = 3;', '+export const b = 1;', '+export const c = 1;', ''].join('\n');
    const round = { key, round: 1, repoId: REPO.id, pr, headSha: head, patch,
      checks: [{ text: '수정에서 b를 더했어요', location: { path: 'src/a.ts', line: 2 } }, { text: '설명서는 그대로예요', location: { path: 'README.md', line: 1 } }], risks: [] };
    const first = posted(await guidance.post(round));
    assert.deepEqual(first.outside, { checks: [round.checks[1]], risks: [] });
    const second = posted(await guidance.post(round));
    assert.equal(second.reviewId, first.reviewId);
    assert.equal(port.reviews.length, 2, '처음 게시 하나와 수정 차례 하나');
    const review = port.reviews[1]!;
    assert.deepEqual([review.head, review.key, review.comments.map(comment => comment.line)], [head, `${key.changeId}:g${key.generation}:r1`, [2]]);
    assert.match(review.body, /수정 1번째/);
    assert.ok(!review.body.includes(guidanceMarker(review.key)), '표식은 포트가 붙인다');
    // 같은 차례를 다른 head로 부르면 보내지 않는다.
    const other = await guidance.post({ ...round, headSha: 'd'.repeat(40) });
    assert.deepEqual([other.state, other.reason], ['failed', 'head_mismatch']);
    assert.equal(port.posts, 2);
    // 공개 검사에 걸린 수정 차례 글은 보내지 않는다.
    const blocked = await guidance.post({ ...round, round: 2, checks: [{ text: 'fixture-corp-host로 붙어요', location: { path: 'src/a.ts', line: 2 } }] });
    assert.deepEqual([blocked.state, blocked.reason], ['skipped', 'internal_marker']);
    assert.equal(port.posts, 2);
  } finally { await close(); }
});
