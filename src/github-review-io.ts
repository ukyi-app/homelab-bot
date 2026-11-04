import { z } from 'zod';
import { Denied, PolicyUnavailable } from './contracts.js';
import { GitHubApi, GitHubAppAuth, GitHubTokenError, assertAllowed } from './github-app.js';
import type { BoundRepository, GitHubAppCredentials } from './github-app.js';
import { GitHubError, restrictGitHubWrite } from './review.js';
import type { GitHubReader, GitHubTransport, ReviewPolicySource } from './review.js';
import type { Change } from './review-input.js';

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
  // 같은 내용의 파일(빈 파일 등)이 수만 개여도 선형이어야 한다. 배열 복사·shift()는 O(n²)이라 이벤트 루프를 막는다(PR #38 리뷰).
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
export function policyRepositories(policy: Pick<ReviewPolicySource, 'current'>): RepositoryLookup {
  return async fullName => {
    const repo = (await policy.current()).review.repositories.find(r => r.fullName === fullName);
    if (!repo) throw new Denied();
    return repo;
  };
}

export function githubReviewIO(options: { app: GitHubAppCredentials; repositories: RepositoryLookup; send?: typeof fetch; now?: () => number }):
  { reader: GitHubReader; transport: GitHubTransport } {
  const now = options.now ?? Date.now;
  const api = new GitHubApi(options.send ?? fetch, now);
  const auth = new GitHubAppAuth(options.app, api, now);
  const { repositories } = options;
  const read = async (repository: string, suffix: string): Promise<unknown> => {
    const path = `/repos/${repository}${suffix}`;
    assertAllowed('GET', path);
    const repo = await repositories(repository);
    return auth.withToken(repo, 'read', token => api.call('GET', path, token));
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
    async mergeBase(repository, base, head) {
      const raw = parse(MergeBaseSchema, await read(repository, `/compare/${base}...${head}?per_page=1`));
      if (raw.base_commit.sha !== base) throw new Error('github_invalid_response');
      return raw.merge_base_commit.sha;
    },
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
    // 정책 조회는 아무것도 보내기 전이라 그렇게 잃으면 안 된다(PR #38 리뷰). 일시 불가는 나중에 다시(429),
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
  return { reader, transport };
}
