import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Denied } from '../src/contracts.js';
import { ReviewPolicySchema, restrictGitHubWrite } from '../src/review.js';

// 게시 서버의 정책 저장소 이름과 리뷰 쓰기 경로도 점 세그먼트를 거부한다(작업자 쪽 REPOSITORY_NAME과 같은 규칙).
const SHA = 'a'.repeat(40);
const policy = (fullName: string) => ({
  repositories: [{ id: 1, fullName, installationId: 2, visibility: 'public' }], allowedBotAuthorIds: [], commentCommand: null,
  reviewDrafts: false, rereviewOnBaseMove: false, comparison: 'merge_base', reviewSince: 0, internalMarkers: [],
  input: { maxFiles: 1, maxFileBytes: 1, maxDiffBytes: 1, maxArchiveBytes: 1, maxBodyChars: 0 }, publish: null,
  reconcile: { maxPages: 1, maxReviewsPerRun: 1 },
});
const write = (repository: string) => ({ method: 'POST', path: `/repos/${repository}/pulls/5/reviews`,
  body: { commit_id: SHA, event: 'COMMENT', body: 'x', comments: [] } });

test('T17 PR #42 리뷰 후속: 정책 저장소 이름은 owner/repo 꼴만 받고 점 세그먼트를 거부한다', () => {
  for (const ok of ['ukyi-app/homelab-smoke', 'ukyi-app/.github', 'a.b/c.d']) assert.equal(ReviewPolicySchema.safeParse(policy(ok)).success, true, ok);
  for (const bad of ['../x', './x', 'a/..', 'a/.', 'a//b', '/a', 'a/b/c', '']) assert.equal(ReviewPolicySchema.safeParse(policy(bad)).success, false, bad);
});

test('T17 PR #42 리뷰 후속: 리뷰 쓰기 경로도 점 세그먼트 저장소를 보내기 전에 거부한다', () => {
  assert.doesNotThrow(() => restrictGitHubWrite(write('ukyi-app/homelab-smoke'), { repository: 'ukyi-app/homelab-smoke', pr: 5, head: SHA }));
  for (const bad of ['../x', 'a/..', '..', '.']) {
    assert.throws(() => restrictGitHubWrite(write(bad), { repository: bad, pr: 5, head: SHA }), Denied, bad);
  }
});
