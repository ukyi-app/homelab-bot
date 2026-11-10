import { z } from 'zod';
import type { WriterOutcome } from './change-contracts.js';
import { DEFAULTS, Denied, PolicyUnavailable } from './contracts.js';
import { GitHubApi, GitHubAppAuth, GitHubTokenError, TokenResponse, appJwt, assertAllowed, grantedExactly } from './github-app.js';
import type { BoundRepository, GitHubAppCredentials } from './github-app.js';
import { GitHubError, pullRequest, requestedRepository, restrictGitHubWrite, ReviewQueue, ReviewRequests } from './review.js';
import type { GitHubReader, GitHubTransport, ReviewPolicySource, ReviewTarget, ReviewTargetReader } from './review.js';
import type { Change } from './review-input.js';
import { bindReviewRequests, REVIEW_REQUEST_ORGANIZATION } from './review-request.js';
import type { Store } from './store.js';

// src/review.ts의 GitHubReader·GitHubTransport 실제 구현. 조립은 main.ts 몫이다(C5).
// ReviewTaskSchema.changes와 ChangeSchema.path의 상한과 같아야 한다. 넘긴 목록이 계약 밖이면 열거 실패로 닫힌다.
export const MAX_CHANGES = 5000;
const MAX_PATH_CHARS = 4096;
const NOT_SENT_RETRY_MS = 60_000;

const Sha = z.string().regex(/^[a-f0-9]{40}$/);
const ModeSchema = z.string().regex(/^[0-7]{6}$/);
const CommitSchema = z.object({ sha: Sha, tree: z.object({ sha: Sha }) });
const MergeBaseSchema = z.object({ base_commit: z.object({ sha: Sha }), merge_base_commit: z.object({ sha: Sha }) });
const TreeSchema = z.object({ sha: Sha, truncated: z.boolean(), tree: z.array(z.object({
  path: z.string().min(1), mode: ModeSchema, type: z.enum(['blob', 'tree', 'commit']), sha: Sha })) });
type Tree = z.infer<typeof TreeSchema>;
type TreeEntry = Tree['tree'][number];
const ReviewCreated = z.object({ id: z.number().int().positive() });
const parse = <T>(schema: z.ZodType<T>, raw: unknown): T => {
  const result = schema.safeParse(raw);
  if (!result.success) throw new Error('github_invalid_response');
  return result.data;
};

const LINK_MODE = '120000';
const describe = (status: Change['status'], before: TreeEntry | undefined, after: TreeEntry | undefined, path: string): Change => ({
  path, previousPath: status === 'renamed' ? before!.path : null, status, baseType: before?.type ?? null, headType: after?.type ?? null,
  baseMode: before?.mode ?? null, headMode: after?.mode ?? null,
});
const byPath = <T extends { path: string }>(left: T, right: T) => left.path < right.path ? -1 : left.path > right.path ? 1 : 0;
const renameKey = (entry: TreeEntry) => `${entry.sha}:${entry.mode === LINK_MODE}`;
// 두 tree의 path·mode·object SHA 차이. 디렉터리 항목은 내용이 아니라서 빼고, gitlink(commit)는 그대로 남긴다.
// 이름 변경은 같은 내용의 blob만 짝짓는다. 내용까지 바뀐 이동은 삭제 + 추가로 나온다.
export function diffTrees(base: Pick<Tree, 'tree' | 'truncated'>, head: Pick<Tree, 'tree' | 'truncated'>): { files: Change[]; truncated: boolean } {
  const remaining = new Map(base.tree.filter(entry => entry.type !== 'tree').map(entry => [entry.path, entry]));
  const changes: Change[] = [];
  const added: TreeEntry[] = [];
  for (const after of head.tree) {
    if (after.type === 'tree') continue;
    const before = remaining.get(after.path);
    if (!before) { added.push(after); continue; }
    remaining.delete(after.path);
    if (before.sha === after.sha && before.mode === after.mode) continue;
    const kindChanged = before.type !== after.type || (before.mode === LINK_MODE) !== (after.mode === LINK_MODE);
    changes.push(describe(kindChanged ? 'type_changed' : 'modified', before, after, after.path));
  }
  // 잘린 tree에 없는 경로는 정말 없는지 모른다. 반대쪽에만 보인다고 추가·삭제로 지어내지 않는다.
  const removed = head.truncated ? [] : [...remaining.values()].sort(byPath);
  // 같은 내용의 파일(빈 파일 등)이 수만 개여도 선형이어야 한다. 배열 복사·shift()는 O(n²)이라 이벤트 루프를 막는다.
  const sources = new Map<string, { entries: TreeEntry[]; next: number }>();
  for (const entry of removed) {
    if (entry.type !== 'blob') continue;
    const key = renameKey(entry);
    const bucket = sources.get(key);
    if (bucket) bucket.entries.push(entry); else sources.set(key, { entries: [entry], next: 0 });
  }
  const take = (key: string): TreeEntry | undefined => {
    const bucket = sources.get(key);
    return bucket && bucket.next < bucket.entries.length ? bucket.entries[bucket.next++] : undefined;
  };
  const moved = new Set<string>();
  for (const after of base.truncated ? [] : added.sort(byPath)) {
    const before = after.type === 'blob' ? take(renameKey(after)) : undefined;
    if (before) moved.add(before.path);
    changes.push(describe(before ? 'renamed' : 'added', before, after, after.path));
  }
  for (const before of removed) if (!moved.has(before.path)) changes.push(describe('removed', before, undefined, before.path));
  const representable = changes.filter(change => change.path.length <= MAX_PATH_CHARS && (change.previousPath?.length ?? 0) <= MAX_PATH_CHARS).sort(byPath);
  return { files: representable.slice(0, MAX_CHANGES), truncated: base.truncated || head.truncated
    || representable.length > MAX_CHANGES || representable.length < changes.length };
}

export type RepositoryLookup = (fullName: string) => Promise<BoundRepository>;
// 저장소 이름에서 토큰 범위를 현재 정책으로 정한다. 정책에 없으면 토큰을 발급하지 않는다.
// store를 주면 정책 목록 밖 저장소도 Discord 리뷰 요청(C30) 세대가 아직 살아 있는 동안(실행 전·실행 중·게시 대기·게시 불명)
// 그 세대의 대상 기록으로 토큰 범위를 정한다. 작업이 끝나면 다시 닫힌다.
const LIVE_REQUEST = `SELECT p.request_target,p.repo_id,p.repo_full_name,p.installation_id FROM pr_reviews p JOIN jobs j ON j.id=p.job_id
  WHERE p.repo_full_name=$1 AND p.request_target IS NOT NULL AND (j.state IN ('queued','running','verifying','waiting_user','cancel_requested')
    OR EXISTS (SELECT 1 FROM review_deliveries d WHERE d.job_id=p.job_id AND d.state IN ('pending','sending','unknown')))
  ORDER BY p.created_at DESC LIMIT 1`;
export function policyRepositories(policy: Pick<ReviewPolicySource, 'current'>, store?: Pick<Store, 'db'>): RepositoryLookup {
  return async fullName => {
    const repo = (await policy.current()).review.repositories.find(r => r.fullName === fullName);
    if (repo) return repo;
    const row = store && (await store.db.query<{ request_target: unknown; repo_id: string; repo_full_name: string; installation_id: string }>(
      LIVE_REQUEST, [fullName])).rows[0];
    const requested = row ? requestedRepository(row) : undefined;
    if (!requested) throw new Denied();
    return requested;
  };
}

// ---- 수정 요청 자료(PR 리뷰·리뷰 댓글·대화 댓글) ----

// 목록마다 읽는 쪽 수, 세 목록을 합친 항목 수, 본문 하나와 합계의 글자 수 상한이다. 넘으면 잘라 truncated로 알린다.
// 목록은 오래된 것부터 오므로 잘리면 최근 글이 빠진다.
export const DISCUSSION_LIMITS = Object.freeze({ pages: 3, items: 300, bodyChars: 8_192, totalChars: 131_072 });
const PAGE_SIZE = 100;
export type DiscussionAuthorKind = 'review_app' | 'writer_app' | 'bot' | 'user';
// 탈퇴한 계정의 글은 user가 null로 온다.
export interface DiscussionAuthor { id: number; login: string; kind: DiscussionAuthorKind }
export interface DiscussionComment { id: number; author: DiscussionAuthor | null; association: string; createdAt: string | null; body: string }
export interface DiscussionReview extends DiscussionComment { state: string; commitId: string | null }
export interface DiscussionReviewComment extends DiscussionComment {
  reviewId: number | null; inReplyTo: number | null; path: string; line: number | null; side: 'LEFT' | 'RIGHT' | null; commitId: string;
}
export interface PullDiscussion {
  repository: string; pr: number; truncated: boolean;
  reviews: DiscussionReview[]; reviewComments: DiscussionReviewComment[]; comments: DiscussionComment[];
}
// 본문은 해석하지 않고 그대로 넘긴다. 지시로 쓸지는 부르는 쪽이 자료 블록으로 정한다.
export interface PullDiscussionReader {
  read(input: { repository: string; pr: number; selfAuthors: { reviewApp: readonly number[]; writerApp: readonly number[] } }): Promise<PullDiscussion>;
}
const Association = z.enum(['COLLABORATOR', 'CONTRIBUTOR', 'FIRST_TIMER', 'FIRST_TIME_CONTRIBUTOR', 'MANNEQUIN', 'MEMBER', 'NONE', 'OWNER']);
const Author = z.object({ id: z.number().int().positive(), login: z.string().min(1).max(100), type: z.string() }).nullable();
const RemoteReviewRow = z.object({ id: z.number().int().positive(), user: Author, body: z.string().nullable(), state: z.string().max(40),
  commit_id: Sha.nullable(), author_association: Association, submitted_at: z.string().nullable().optional(), pull_request_url: z.string() });
const RemoteReviewComment = z.object({ id: z.number().int().positive(), pull_request_review_id: z.number().int().positive().nullable(),
  in_reply_to_id: z.number().int().positive().optional(), path: z.string().min(1).max(MAX_PATH_CHARS), line: z.number().int().positive().nullable().optional(),
  side: z.enum(['LEFT', 'RIGHT']).nullable().optional(), commit_id: Sha, user: Author, author_association: Association, created_at: z.string(),
  body: z.string(), pull_request_url: z.string() });
const RemoteIssueComment = z.object({ id: z.number().int().positive(), user: Author, author_association: Association, created_at: z.string(),
  body: z.string().optional(), issue_url: z.string() });

// ---- 안내 리뷰 게시 ----

// 자동 참고 리뷰(reviewMarker)와 접두가 달라 서로의 회수에 걸리지 않는다.
export const guidanceMarker = (key: string) => `<!-- homelab-bot-guidance:${key} -->`;
export interface GuidanceReview {
  repository: string; pr: number; head: string; key: string; body: string;
  comments: readonly { path: string; line: number; body: string }[];
}
// 봇 PR에 COMMENT 리뷰를 단다. 게시 상태(outbox·재시도)는 부르는 쪽이 맡는다.
export interface GuidanceReviewPort {
  // 다시 보내지 않는다. unknown이면 find로 회수하고, 못 찾아도 자동으로 다시 게시하지 않는다.
  post(input: GuidanceReview): Promise<WriterOutcome<{ id: number }>>;
  find(input: Pick<GuidanceReview, 'repository' | 'pr' | 'head' | 'key'>): Promise<{ id: number } | null>;
}
const GuidanceKey = z.string().regex(/^[A-Za-z0-9_.:-]{1,128}$/);
const GuidanceTarget = { repository: z.string(), pr: z.number().int().positive(), head: Sha, key: GuidanceKey };
// 인라인 개수(50)·본문 길이·event·side는 restrictGitHubWrite가 본다. 여기서는 그 밖의 필드가 끼지 못하게만 한다.
const GuidanceInput = z.strictObject({ ...GuidanceTarget, body: z.string().min(1),
  comments: z.array(z.strictObject({ path: z.string().min(1), line: z.number().int().positive(), body: z.string().min(1) })) });
const GuidanceLookup = z.strictObject(GuidanceTarget);
const RecoveredReview = z.object({ id: z.number().int().positive(), commit_id: z.string().nullable(), body: z.string().nullable(), pull_request_url: z.string() });

// ---- 리뷰 요청 대상(C30) ----

const InstallationSchema = z.object({ id: z.number().int().positive(), account: z.object({ login: z.string() }).nullable() });
const RepositorySchema = z.object({ id: z.number().int().positive(), full_name: z.string(), private: z.boolean(),
  owner: z.object({ login: z.string(), type: z.string() }) });
// 저장소 정보 읽기에는 메타데이터 읽기만 쓴다. App의 다른 권한을 이 토큰에 싣지 않는다.
const METADATA = Object.freeze({ metadata: 'read' });

export interface GitHubReviewIO {
  reader: GitHubReader; transport: GitHubTransport; discussion: PullDiscussionReader; guidance: GuidanceReviewPort; targets: ReviewTargetReader;
}
// requests: 주면 같은 Store에 Discord 리뷰 요청 접수(ReviewRequests)를 묶는다. 대화 성공 분기의 제안 대조가 그 묶음을 읽는다.
export function githubReviewIO(options: { app: GitHubAppCredentials; repositories: RepositoryLookup; send?: typeof fetch; now?: () => number;
  requests?: { store: Store; policy: ReviewPolicySource } }): GitHubReviewIO {
  const now = options.now ?? Date.now;
  const api = new GitHubApi(options.send ?? fetch, now);
  const auth = new GitHubAppAuth(options.app, api, now);
  const { repositories } = options;
  const readFrom = (repo: BoundRepository, suffix: string): Promise<unknown> => {
    const path = `/repos/${repo.fullName}${suffix}`;
    assertAllowed('GET', path);
    return auth.withToken(repo, 'read', token => api.call('GET', path, token));
  };
  const read = async (repository: string, suffix: string): Promise<unknown> => {
    assertAllowed('GET', `/repos/${repository}${suffix}`);
    return readFrom(await repositories(repository), suffix);
  };
  const mergeBaseOf = async (get: (suffix: string) => Promise<unknown>, base: string, head: string): Promise<string> => {
    const raw = parse(MergeBaseSchema, await get(`/compare/${base}...${head}?per_page=1`));
    if (raw.base_commit.sha !== base) throw new Error('github_invalid_response');
    return raw.merge_base_commit.sha;
  };
  // 정책 목록 밖 조직 저장소. 설치는 App JWT로 묻고(없으면 404 → null), 저장소 ID를 아직 모르므로 이름으로 좁힌 메타데이터 토큰으로
  // 저장소 정보를 읽는다. 설치 계정·토큰 저장소·정보가 요청한 저장소와 하나라도 다르면 쓰지 않는다.
  const targets: ReviewTargetReader = {
    async repository(fullName) {
      const [owner, name] = fullName.split('/') as [string, string];
      if (owner.toLowerCase() !== REVIEW_REQUEST_ORGANIZATION || !name) throw new Denied();
      let installation: z.infer<typeof InstallationSchema>;
      try { installation = parse(InstallationSchema, await api.call('GET', `/repos/${fullName}/installation`, appJwt(options.app, now()))); }
      catch (error) {
        if (error instanceof GitHubError && error.status === 404) return null;
        throw error;
      }
      if (installation.account?.login.toLowerCase() !== owner.toLowerCase()) throw new Error('github_installation_mismatch');
      const issued = TokenResponse.safeParse(await api.call('POST', `/app/installations/${installation.id}/access_tokens`, appJwt(options.app, now()),
        { repositories: [name], permissions: METADATA }));
      const granted = issued.success && issued.data.repositories?.length === 1 ? issued.data.repositories[0]! : undefined;
      if (!issued.success || !granted || granted.full_name.toLowerCase() !== fullName.toLowerCase() || !grantedExactly(issued.data.permissions, METADATA)) {
        throw new Error('github_token_mismatch');
      }
      const path = `/repos/${granted.full_name}`;
      assertAllowed('GET', path);
      const info = parse(RepositorySchema, await api.call('GET', path, issued.data.token));
      if (info.id !== granted.id || info.full_name !== granted.full_name || info.owner.type !== 'Organization'
        || info.owner.login.toLowerCase() !== REVIEW_REQUEST_ORGANIZATION) throw new Error('github_repository_mismatch');
      // visibility 칸은 문서상 필수가 아니라 필수 칸인 private로 정한다(internal 저장소도 private로 다룬다).
      return { id: info.id, fullName: info.full_name, installationId: installation.id, visibility: info.private ? 'private' : 'public' };
    },
    pullRequest: (target: ReviewTarget, number) => readFrom(target, `/pulls/${number}`),
    mergeBase: (target: ReviewTarget, base, head) => mergeBaseOf(suffix => readFrom(target, suffix), base, head),
  };
  const list = async (repository: string, suffix: string): Promise<unknown[]> => parse(z.array(z.unknown()), await read(repository, suffix));
  const commitTree = async (repository: string, commit: string): Promise<string> => {
    const raw = parse(CommitSchema, await read(repository, `/git/commits/${commit}`));
    if (raw.sha !== commit) throw new Error('github_invalid_response');
    return raw.tree.sha;
  };
  const tree = async (repository: string, id: string): Promise<Tree> => {
    const raw = parse(TreeSchema, await read(repository, `/git/trees/${id}?recursive=1`));
    if (raw.sha !== id) throw new Error('github_invalid_response');
    return raw;
  };
  const reader: GitHubReader = {
    pullRequest: (repository, number) => read(repository, `/pulls/${number}`),
    openPullRequests: (repository, page) => list(repository, `/pulls?state=open&sort=updated&direction=desc&per_page=100&page=${page}`),
    reviews: (repository, number, page) => list(repository, `/pulls/${number}/reviews?per_page=100&page=${page}`),
    mergeBase: (repository, base, head) => mergeBaseOf(suffix => read(repository, suffix), base, head),
    // compare API 파일 목록은 300개에서 끊기고 gitlink를 놓칠 수 있어 tree로 직접 비교한다. 실패를 그 목록으로 덮지 않는다.
    async compare(repository, base, head) {
      const [baseTree, headTree] = [await commitTree(repository, base), await commitTree(repository, head)];
      if (baseTree === headTree) return { files: [], truncated: false };
      return diffTrees(await tree(repository, baseTree), await tree(repository, headTree));
    },
  };
  const transport: GitHubTransport = async request => {
    // 타입을 믿지 않고 실행 시점에 다시 본다. 경로에서 대상을 뽑아 RestrictedGitHub과 같은 검사를 통과해야 보낸다.
    const { method, path } = request as { method?: unknown; path?: unknown };
    assertAllowed(String(method), String(path));
    const target = /^\/repos\/([^/]+\/[^/]+)\/pulls\/(\d+)\/reviews$/.exec(String(path));
    if (!target) throw new Denied();
    const write = restrictGitHubWrite(request, { repository: target[1]!, pr: Number(target[2]), head: request.body?.commit_id });
    // deliver는 transport를 부르기 직전에 dispatched로 표시하고, 그 뒤의 예외를 응답 유실(unknown)로 본다.
    // 정책 조회는 아무것도 보내기 전이라 그렇게 잃으면 안 된다. 일시 불가는 나중에 다시(429),
    // 정책에서 빠진 저장소는 보내지 않고 막는다(403, 재시도 없음).
    let repo: BoundRepository;
    try {
      repo = await repositories(target[1]!);
    } catch (error) {
      if (error instanceof PolicyUnavailable) throw new GitHubError(429, NOT_SENT_RETRY_MS);
      if (error instanceof Denied) throw new GitHubError(403, 0);
      throw error;
    }
    try {
      return parse(ReviewCreated, await auth.withToken(repo, 'write', token => api.call('POST', write.path, token, write.body)));
    } catch (error) {
      // deliver는 전송 시작 뒤의 5xx를 응답 유실로 보고 다시 보내지 않는다. 토큰 단계 실패는 POST 전이라 그렇게 잃으면 안 된다.
      if (error instanceof GitHubTokenError && (error.status >= 500 || error.status === 408)) throw new GitHubError(429, Math.max(error.retryAfterMs, NOT_SENT_RETRY_MS));
      throw error;
    }
  };
  const discussion: PullDiscussionReader = {
    async read({ repository, pr, selfAuthors }) {
      const pullUrl = `https://api.github.com/repos/${repository}/pulls/${pr}`;
      const issueUrl = `https://api.github.com/repos/${repository}/issues/${pr}`;
      let truncated = false;
      let items = 0;
      let chars = 0;
      const author = (user: z.infer<typeof Author>): DiscussionAuthor | null => user && { id: user.id, login: user.login,
        kind: selfAuthors.reviewApp.includes(user.id) ? 'review_app' : selfAuthors.writerApp.includes(user.id) ? 'writer_app' : user.type === 'Bot' ? 'bot' : 'user' };
      // 상한 안이면 본문을 잘라서라도 받고, 항목 수나 합계를 넘으면 그 항목부터 버린다.
      const admit = (raw: string): string | null => {
        let body = raw;
        if (body.length > DISCUSSION_LIMITS.bodyChars) {
          body = body.slice(0, DISCUSSION_LIMITS.bodyChars);
          if (/[\uD800-\uDBFF]$/.test(body)) body = body.slice(0, -1);
          truncated = true;
        }
        if (items >= DISCUSSION_LIMITS.items || chars + body.length > DISCUSSION_LIMITS.totalChars) { truncated = true; return null; }
        items++;
        chars += body.length;
        return body;
      };
      const pages = async <T>(suffix: string, schema: z.ZodType<T>, sameTarget: (row: T) => boolean): Promise<T[]> => {
        const rows: T[] = [];
        for (let page = 1; page <= DISCUSSION_LIMITS.pages; page++) {
          const batch = parse(z.array(schema), await read(repository, `${suffix}?per_page=${PAGE_SIZE}&page=${page}`));
          // 다른 PR의 글이 섞인 응답은 통째로 버린다. 일부만 걸러 쓰면 무엇이 빠졌는지 모른다.
          if (!batch.every(sameTarget)) throw new Error('github_pull_mismatch');
          rows.push(...batch);
          if (batch.length < PAGE_SIZE) return rows;
        }
        truncated = true;
        return rows;
      };
      const reviews = await pages(`/pulls/${pr}/reviews`, RemoteReviewRow, row => row.pull_request_url === pullUrl);
      const reviewComments = await pages(`/pulls/${pr}/comments`, RemoteReviewComment, row => row.pull_request_url === pullUrl);
      const comments = await pages(`/issues/${pr}/comments`, RemoteIssueComment, row => row.issue_url === issueUrl);
      const result: PullDiscussion = { repository, pr, truncated: false, reviews: [], reviewComments: [], comments: [] };
      for (const row of reviews) {
        const body = admit(row.body ?? '');
        if (body !== null) result.reviews.push({ id: row.id, author: author(row.user), association: row.author_association, createdAt: row.submitted_at ?? null,
          body, state: row.state, commitId: row.commit_id });
      }
      for (const row of reviewComments) {
        const body = admit(row.body);
        if (body !== null) result.reviewComments.push({ id: row.id, author: author(row.user), association: row.author_association, createdAt: row.created_at, body,
          reviewId: row.pull_request_review_id, inReplyTo: row.in_reply_to_id ?? null, path: row.path, line: row.line ?? null, side: row.side ?? null, commitId: row.commit_id });
      }
      for (const row of comments) {
        const body = admit(row.body ?? '');
        if (body !== null) result.comments.push({ id: row.id, author: author(row.user), association: row.author_association, createdAt: row.created_at, body });
      }
      result.truncated = truncated;
      return result;
    },
  };
  const notSent = (code: string) => ({ kind: 'not_sent', code }) as const;
  const guidance: GuidanceReviewPort = {
    async post(raw) {
      const parsed = GuidanceInput.safeParse(raw);
      // 호출자 본문이 표식을 흉내 내면 다른 글의 회수에 걸릴 수 있다.
      if (!parsed.success || parsed.data.body.includes('<!-- homelab-bot-')) return notSent('input_invalid');
      const { repository, pr, head, key, body, comments } = parsed.data;
      const request = { method: 'POST', path: `/repos/${repository}/pulls/${pr}/reviews`,
        body: { commit_id: head, event: 'COMMENT', body: `${guidanceMarker(key)}\n${body}`, comments: comments.map(c => ({ path: c.path, line: c.line, side: 'RIGHT', body: c.body })) } };
      let write: ReturnType<typeof restrictGitHubWrite>;
      try {
        write = restrictGitHubWrite(request, { repository, pr, head });
        assertAllowed('POST', write.path);
      } catch { return notSent('input_invalid'); }
      let repo: BoundRepository;
      try { repo = await repositories(repository); }
      catch (error) {
        if (error instanceof Denied) return notSent('repository_denied');
        if (error instanceof PolicyUnavailable) return notSent('policy_unavailable');
        throw error;
      }
      // 사람이 브랜치를 옮겼으면 옛 head에 안내를 달지 않는다. 읽기 실패는 아무것도 보내기 전이다.
      try {
        const pull = pullRequest(await auth.withToken(repo, 'read', token => api.call('GET', `/repos/${repository}/pulls/${pr}`, token)));
        if (!pull.open) return notSent('pull_closed');
        if (pull.head.sha !== head) return notSent('head_changed');
        if (pull.head.repoId !== repo.id || pull.base.repoId !== repo.id) return notSent('pull_mismatch');
      } catch (error) {
        return notSent(error instanceof GitHubError && error.status === 429 ? 'rate_limited' : error instanceof GitHubError ? `read_http_${error.status}` : 'read_failed');
      }
      let created: unknown;
      try { created = await auth.withToken(repo, 'write', token => api.call('POST', write.path, token, write.body)); }
      catch (error) {
        if (error instanceof GitHubTokenError) return notSent(error.status >= 500 || error.status === 408 || error.status === 429 ? 'token_unavailable' : error.message);
        // 연결 실패도 GitHubApi가 503으로 올려 보냈는지 알 수 없다. 그래서 unknown이다.
        if (error instanceof GitHubError && error.status === 429) return notSent('rate_limited');
        if (error instanceof GitHubError && (error.status >= 500 || error.status === 408)) return { kind: 'unknown', code: error.status === 503 ? 'response_lost' : 'http_5xx' };
        if (error instanceof GitHubError) return { kind: 'rejected', status: error.status, code: `http_${error.status}` };
        return { kind: 'unknown', code: 'response_invalid' };
      }
      const confirmed = ReviewCreated.safeParse(created);
      return confirmed.success ? { kind: 'confirmed', value: { id: confirmed.data.id } } : { kind: 'unknown', code: 'response_invalid' };
    },
    // review.ts의 ReviewPublisher.existing과 같은 규칙: 리뷰 목록에서 표식과 head SHA가 모두 맞는 글을 찾는다.
    async find(raw) {
      const parsed = GuidanceLookup.safeParse(raw);
      if (!parsed.success) throw new Denied();
      const { repository, pr, head, key } = parsed.data;
      const pullUrl = `https://api.github.com/repos/${repository}/pulls/${pr}`;
      for (let page = 1; page <= DEFAULTS.recoveryPages; page++) {
        const rows = parse(z.array(RecoveredReview), await read(repository, `/pulls/${pr}/reviews?per_page=${PAGE_SIZE}&page=${page}`));
        if (!rows.every(row => row.pull_request_url === pullUrl)) throw new Error('github_pull_mismatch');
        const found = rows.find(row => row.commit_id === head && row.body?.includes(guidanceMarker(key)));
        if (found) return { id: found.id };
        if (rows.length < PAGE_SIZE) break;
      }
      return null;
    },
  };
  if (options.requests) {
    const { store, policy } = options.requests;
    bindReviewRequests(store, new ReviewRequests(store, policy, new ReviewQueue(store, reader), reader, targets));
  }
  return { reader, transport, discussion, guidance, targets };
}
