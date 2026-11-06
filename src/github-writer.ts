import { z } from 'zod';
import {
  ARTIFACT_LIMITS, BranchNameSchema, ChangeIdSchema, ChangePathSchema, GenerationSchema, GitShaSchema, PublicMetadataSchema, RepoIdSchema, gitBlobSha, parseChangeBranch,
} from './change-contracts.js';
import type { ChangeTarget, ChangeWriterPort, WriterOutcome, WriterPullSnapshot } from './change-contracts.js';
import { REUSABLE_USES } from './change-ci-policy.js';
import type { CiContentReader } from './change-ci-policy.js';
import { isProtectedPath } from './change-policy.js';
import type { ChangeRepositoryPolicy } from './change-policy.js';
import { Denied, PolicyUnavailable } from './contracts.js';
import { REFRESH_MARGIN_MS, TokenResponse, appJwt, grantedExactly } from './github-app.js';
import type { GitHubAppCredentials } from './github-app.js';

// 봇이 공개 저장소에 쓰는 유일한 경로다. 네트워크 호출은 createGitHubWriter 안의 exchange 한 곳이고, 밖으로는 도메인 메서드만 나간다.
// URL·method·token을 받는 함수가 없어서 표에 없는 API를 부를 방법이 코드에 없다. 키가 새면 이 경계는 우회되고, 남는 상한은 설치 저장소와 서버 ruleset이다.

const API = 'https://api.github.com';
const API_VERSION = '2022-11-28';
const REQUEST_TIMEOUT_MS = 30_000;
const TOKEN_LIFETIME_MAX_MS = 3_600_000 + REFRESH_MARGIN_MS;
const LIMIT = Object.freeze({ small: 64 * 1024, content: 2 * 1024 * 1024, pull: 1024 * 1024, large: 16 * 1024 * 1024 });
// 비재귀 탐색의 상한이다. 익명 호출 한도가 시간당 60회라 그 안에서 끝나야 하고, 넘으면 입증 실패로 닫는다.
const TREE_WALK_REQUESTS = 64;
const PULL_PAGE = 100;

// fetch가 점 세그먼트를 정규화하면 검사한 경로와 다른 곳으로 가므로 "."·".."은 뺀다. %가 없어 인코딩 우회도 안 된다.
const SEGMENT = String.raw`(?!\.\.?(?:/|$|\?|&|:))[A-Za-z0-9_.-]+`;
const REPO = `/repos/${SEGMENT}/${SEGMENT}`;
const BRANCH = `${SEGMENT}(?:/${SEGMENT})*`;
const SHA = '[0-9a-f]{40}';
const ROUTES: readonly RegExp[] = Object.freeze([
  'POST /app/installations/[1-9][0-9]{0,15}/access_tokens',
  `POST ${REPO}/git/blobs`, `POST ${REPO}/git/trees`, `POST ${REPO}/git/commits`, `POST ${REPO}/git/refs`, `POST ${REPO}/pulls`,
  `GET ${REPO}/git/ref/heads/${BRANCH}`, `GET ${REPO}/git/commits/${SHA}`, `GET ${REPO}/git/blobs/${SHA}`,
  `GET ${REPO}/git/trees/${SHA}`, String.raw`GET ${REPO}/git/trees/${SHA}\?recursive=1`,
  String.raw`GET ${REPO}/pulls\?state=all&head=${SEGMENT}:${BRANCH}&base=${BRANCH}&per_page=100`,
  String.raw`GET ${REPO}/contents/\.github/workflows/[A-Za-z0-9_.-]+\.ya?ml\?ref=${SEGMENT}`,
].map(rule => new RegExp(`^${rule}$`)));
export function writerRouteAllowed(method: string, path: string): boolean {
  return ROUTES.some(rule => rule.test(`${method} ${path}`));
}
const exactKeys = (body: unknown, keys: readonly string[]) => {
  if (typeof body !== 'object' || body === null) return false;
  const found = Object.keys(body).sort();
  return found.length === keys.length && [...keys].sort().every((key, index) => key === found[index]);
};
// 도메인 메서드가 이미 본 값이지만 전송 직전에 다시 본다. 표에 없는 필드(force, merge_method 등)가 나갈 길을 닫는다.
function bodyAllowed(method: string, path: string, body: unknown): boolean {
  if (method === 'GET') return body === undefined;
  if (path.endsWith('/access_tokens')) return exactKeys(body, ['repository_ids', 'permissions']);
  if (path.endsWith('/git/blobs')) return exactKeys(body, ['content', 'encoding']);
  if (path.endsWith('/git/trees')) return exactKeys(body, ['base_tree', 'tree']);
  if (path.endsWith('/git/commits')) return exactKeys(body, ['message', 'tree', 'parents', 'author', 'committer']);
  if (path.endsWith('/git/refs')) return exactKeys(body, ['ref', 'sha']);
  if (path.endsWith('/pulls')) return exactKeys(body, ['title', 'body', 'head', 'base', 'draft', 'maintainer_can_modify']) && (body as { maintainer_can_modify: unknown }).maintainer_can_modify === false;
  return false;
}

export interface WriterRepository { id: number; fullName: string; installationId: number; baseBranches: readonly string[] }
export type WriterRepositoryLookup = (repoId: number) => Promise<WriterRepository>;
export function policyWriterRepositories(policy: (repoId: number) => Promise<ChangeRepositoryPolicy | null>): WriterRepositoryLookup {
  return async repoId => {
    const current = await policy(repoId);
    if (!current || current.repoId !== repoId) throw new Denied();
    return { id: current.repoId, fullName: current.fullName, installationId: current.installationId, baseBranches: current.baseBranches };
  };
}
// 첫 공개 효과 전의 검사에 쓰는 읽기다. 자격을 아예 받지 않아 쓰기 권한을 가질 수 없다. 대상은 공개 저장소라 익명으로 읽힌다.
export interface ChangePreflightPort extends CiContentReader {
  readBranchHead: ChangeWriterPort['readBranchHead'];
  readCommit: ChangeWriterPort['readCommit'];
  readTreeLeaves: ChangeWriterPort['readTreeLeaves'];
}
export interface GitHubWriterOptions {
  app: GitHubAppCredentials; repositories: WriterRepositoryLookup;
  // 지금 이 쓰기를 보내도 되는가. 철회면 Denied, 부모가 끝났거나 승인이 무효면 PublicationStopped, 정책을 못 읽으면 PolicyUnavailable을 던진다. 필수값이라 빼먹은 writer를 만들 수 없다.
  authorizeWrite: (target: ChangeTarget) => Promise<void>;
  send?: typeof fetch; now?: () => number;
}

class WriterReadError extends Error {}
// 부모가 더는 게시 중이 아니거나 승인이 무효다. 끝난 부모를 다시 닫지 않도록 권한 철회(Denied)와 나눠 돌려준다.
export class PublicationStopped extends Error { constructor() { super('publication_stopped'); } }
const readFailure = (code: string) => new WriterReadError(code);
type Scope = 'contents' | 'pull';
const SCOPES: Readonly<Record<Scope, Readonly<Record<string, string>>>> = Object.freeze({
  contents: Object.freeze({ contents: 'write' }),
  pull: Object.freeze({ contents: 'read', pull_requests: 'write' }),
});
const SAFE_SEGMENT = new RegExp(`^${SEGMENT}$`);
const safeBranchPath = (branch: string) => BranchNameSchema.safeParse(branch).success && branch.split('/').every(segment => SAFE_SEGMENT.test(segment));
function usableRepository(repo: WriterRepository, repoId: number): boolean {
  const parts = repo.fullName.split('/');
  return repo.id === repoId && Number.isSafeInteger(repo.installationId) && repo.installationId > 0 && parts.length === 2 && parts.every(part => SAFE_SEGMENT.test(part));
}

// 전송 시작 전에 끝났다고 확실한 오류만 미전송이다. 나머지는 나갔을 수 있어 unknown이다.
const BEFORE_REQUEST = new Set(['ECONNREFUSED', 'ENOTFOUND', 'EAI_AGAIN', 'ENETUNREACH', 'EHOSTUNREACH', 'UND_ERR_CONNECT_TIMEOUT']);
type Exchange = { kind: 'ok'; status: number; json: unknown } | { kind: 'http'; status: number; limited: boolean } | { kind: 'not_sent'; code: string } | { kind: 'lost'; code: string };

const Target = z.strictObject({ key: z.strictObject({ changeId: ChangeIdSchema, generation: GenerationSchema }), repoId: RepoIdSchema });
const Mode = z.enum(['100644', '100755']);
const BlobsInput = z.strictObject({ target: Target, files: z.array(z.strictObject({ path: ChangePathSchema, content: z.instanceof(Uint8Array), blobSha: GitShaSchema })).min(1).max(ARTIFACT_LIMITS.changedFiles) });
const TreeInput = z.strictObject({ target: Target, baseTree: GitShaSchema, entries: z.array(z.strictObject({ path: ChangePathSchema, mode: Mode, blobSha: GitShaSchema.nullable() })).min(1).max(ARTIFACT_LIMITS.changedFiles) });
const CommitInput = z.strictObject({ target: Target, treeSha: GitShaSchema, parent: GitShaSchema,
  metadata: z.strictObject({ message: PublicMetadataSchema.shape.commitMessage, author: PublicMetadataSchema.shape.author, committer: PublicMetadataSchema.shape.committer }) });
const RefInput = z.strictObject({ target: Target, branch: z.string(), sha: GitShaSchema });
const PullInput = z.strictObject({ target: Target, branch: z.string(), baseBranch: z.string(), title: PublicMetadataSchema.shape.title, body: PublicMetadataSchema.shape.body, draft: z.boolean() });

const CreatedSha = z.object({ sha: GitShaSchema });
const CreatedCommit = z.object({ sha: GitShaSchema, tree: z.object({ sha: GitShaSchema }), parents: z.array(z.object({ sha: GitShaSchema })) });
const CreatedRef = z.object({ ref: z.string(), object: z.object({ type: z.string(), sha: GitShaSchema }) });
const TreeRows = z.object({ sha: GitShaSchema, truncated: z.boolean(), tree: z.array(z.object({ path: z.string().min(1), mode: z.string(), type: z.string(), sha: GitShaSchema })) });
const ContentsFile = z.object({ type: z.literal('file'), encoding: z.literal('base64'), sha: GitShaSchema, content: z.string() });
const BlobRow = z.object({ sha: GitShaSchema, encoding: z.string().optional(), content: z.string().optional() });
const PullRow = z.object({
  number: z.number().int().positive(), state: z.enum(['open', 'closed']), merged_at: z.string().nullable().optional(), title: z.string(), body: z.string().nullable(),
  user: z.object({ id: z.number().int() }), head: z.object({ ref: z.string(), sha: GitShaSchema, repo: z.object({ id: z.number().int() }).nullable() }),
  base: z.object({ ref: z.string(), repo: z.object({ id: z.number().int() }) }),
});
type PullRow = z.infer<typeof PullRow>;
const snapshot = (row: PullRow): WriterPullSnapshot => ({
  number: row.number, state: row.state, merged: Boolean(row.merged_at), headBranch: row.head.ref, headSha: row.head.sha, baseBranch: row.base.ref,
  authorId: row.user.id, title: row.title, body: row.body ?? '', repoId: row.base.repo.id,
});

export interface GitHubWriterIO { writer: ChangeWriterPort; preflight: ChangePreflightPort }
export function createGitHubWriter(options: GitHubWriterOptions): GitHubWriterIO {
  const { app, repositories, authorizeWrite } = options;
  const send = options.send ?? fetch;
  const now = options.now ?? Date.now;
  const tokens = new Map<string, { token: string; expiresAt: number }>();
  const issuing = new Map<string, Promise<string>>();

  // 이 파일에서 네트워크로 나가는 유일한 지점이다. redirect를 따라가지 않아 자격이 다른 주소로 가지 않는다.
  const exchange = async (method: 'GET' | 'POST', path: string, credential: string | null, body: unknown, limit: number): Promise<Exchange> => {
    if (!writerRouteAllowed(method, path) || !bodyAllowed(method, path, body)) return { kind: 'not_sent', code: 'route_denied' };
    let response: Response;
    try {
      response = await send(`${API}${path}`, { method, redirect: 'manual', signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
        headers: { accept: 'application/vnd.github+json', 'user-agent': 'homelab-bot', 'x-github-api-version': API_VERSION,
          ...(credential === null ? {} : { authorization: `Bearer ${credential}` }), ...(body === undefined ? {} : { 'content-type': 'application/json' }) },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    } catch (error) {
      const code = (error as { cause?: { code?: unknown } } | null)?.cause?.code;
      if (typeof code === 'string' && BEFORE_REQUEST.has(code)) return { kind: 'not_sent', code: code === 'ECONNREFUSED' ? 'connection_refused' : 'connection_failed' };
      return { kind: 'lost', code: 'response_lost' };
    }
    if (!response.ok) {
      await response.body?.cancel().catch(() => {});
      const limited = response.status === 429 || (response.status === 403 && (response.headers.has('retry-after') || response.headers.get('x-ratelimit-remaining') === '0'));
      return { kind: 'http', status: response.status, limited };
    }
    if (Number(response.headers.get('content-length') ?? '0') > limit) {
      await response.body?.cancel().catch(() => {});
      return { kind: 'lost', code: 'response_too_large' };
    }
    const chunks: Uint8Array[] = [];
    let size = 0;
    try {
      if (response.body) for await (const chunk of response.body) {
        size += chunk.byteLength;
        if (size > limit) break;
        chunks.push(chunk);
      }
    } catch { return { kind: 'lost', code: 'response_lost' }; }
    if (size > limit) return { kind: 'lost', code: 'response_too_large' };
    try { return { kind: 'ok', status: response.status, json: JSON.parse(Buffer.concat(chunks).toString('utf8')) }; }
    catch { return { kind: 'lost', code: 'response_invalid' }; }
  };

  // 공개 저장소로 나가는 쓰기는 모두 여기를 지난다. 게시자의 단계 입구 검사 뒤에도 GitHub 조회·토큰 발급을 기다리므로 그사이의 /revoke·/change-cancel은 여기서만 잡힌다.
  // 확인이 실패해도 보내지 않는다. 읽기는 이 길을 지나지 않아 보냈을 수 있는 effect의 대조가 철회로 막히지 않는다.
  // 이 확인과 전송 사이의 아주 짧은 틈은 남는다. 이미 나간 요청과 같게 대조로 다룬다.
  const sendWrite = async (target: ChangeTarget, path: string, token: string, body: unknown, limit: number): Promise<Exchange> => {
    try { await authorizeWrite(target); }
    catch (error) {
      return { kind: 'not_sent', code: error instanceof Denied ? 'authorization_revoked' : error instanceof PublicationStopped ? 'publication_stopped' : error instanceof PolicyUnavailable ? 'policy_unavailable' : 'authorization_check_failed' };
    }
    return exchange('POST', path, token, body, limit);
  };

  const resolve = async (repoId: number): Promise<WriterRepository | { denied: string }> => {
    try {
      const repo = await repositories(repoId);
      return usableRepository(repo, repoId) ? repo : { denied: 'repository_denied' };
    } catch (error) { return { denied: error instanceof Denied ? 'repository_denied' : 'policy_unavailable' }; }
  };
  const isDenied = (value: WriterRepository | { denied: string }): value is { denied: string } => 'denied' in value;

  // 토큰은 이 closure의 Map에만 있다. change·generation·저장소·scope가 다르면 공유하지 않는다.
  class TokenFailure extends Error {}
  const issue = async (repo: WriterRepository, scope: Scope): Promise<{ token: string; expiresAt: number }> => {
    const wanted = SCOPES[scope];
    let jwt: string;
    try { jwt = appJwt(app, now()); } catch { throw new TokenFailure('token_jwt_failed'); }
    const result = await exchange('POST', `/app/installations/${repo.installationId}/access_tokens`, jwt, { repository_ids: [repo.id], permissions: wanted }, LIMIT.small);
    // 한도 초과는 쓰기 요청과 같이 다뤄 게시를 닫지 않고 미룬다. 토큰 발급 전이라 공개 쓰기는 나가지 않았다.
    if (result.kind === 'http') throw new TokenFailure(result.limited ? 'rate_limited' : `token_http_${result.status}`);
    if (result.kind === 'not_sent') throw new TokenFailure(result.code);
    if (result.kind === 'lost') throw new TokenFailure(result.code === 'response_lost' ? 'token_unavailable' : 'token_response_invalid');
    const parsed = TokenResponse.safeParse(result.json);
    const expiresAt = parsed.success ? Date.parse(parsed.data.expires_at) : Number.NaN;
    if (!parsed.success || !Number.isFinite(expiresAt)) throw new TokenFailure('token_response_invalid');
    const granted = parsed.data.repositories ?? [];
    if (granted.length !== 1 || granted[0]!.id !== repo.id || granted[0]!.full_name !== repo.fullName) throw new TokenFailure('token_repository_mismatch');
    if (!grantedExactly(parsed.data.permissions, wanted)) throw new TokenFailure('token_permission_mismatch');
    if (expiresAt <= now() || expiresAt > now() + TOKEN_LIFETIME_MAX_MS) throw new TokenFailure('token_expiry_invalid');
    return { token: parsed.data.token, expiresAt };
  };
  const tokenKey = (target: ChangeTarget, repo: WriterRepository, scope: Scope) => `${target.key.changeId}:${target.key.generation}:${repo.id}:${repo.fullName}:${repo.installationId}:${scope}`;
  const tokenFor = async (target: ChangeTarget, repo: WriterRepository, scope: Scope): Promise<string> => {
    const key = tokenKey(target, repo, scope);
    const cached = tokens.get(key);
    if (cached && now() < cached.expiresAt - REFRESH_MARGIN_MS) return cached.token;
    const running = issuing.get(key);
    if (running) return running;
    const started = issue(repo, scope).then(fresh => {
      for (const [other, entry] of tokens) if (entry.expiresAt <= now()) tokens.delete(other);
      tokens.set(key, fresh);
      return fresh.token;
    }).finally(() => { issuing.delete(key); });
    issuing.set(key, started);
    return started;
  };

  // mutation은 자동으로 다시 보내지 않는다. 401이어도 호출자가 판단한다. 토큰 만료를 불명확한 재전송의 이유로 쓰지 않는다.
  const classify = <T>(result: Exchange, parse: (json: unknown, status: number) => WriterOutcome<T>): WriterOutcome<T> => {
    switch (result.kind) {
      case 'not_sent': return { kind: 'not_sent', code: result.code };
      case 'lost': return { kind: 'unknown', code: result.code };
      case 'http':
        // 한도 초과는 GitHub이 처리하지 않은 요청이라 나중에 다시 보내도 중복이 없다.
        if (result.limited) return { kind: 'not_sent', code: 'rate_limited' };
        if (result.status >= 500 || result.status === 408) return { kind: 'unknown', code: 'http_5xx' };
        return { kind: 'rejected', status: result.status, code: `http_${result.status}` };
      case 'ok': return parse(result.json, result.status);
    }
  };
  const invalid = { kind: 'unknown', code: 'response_invalid' } as const;
  const withWriteAccess = async <T>(target: ChangeTarget, scope: Scope, work: (repo: WriterRepository, token: string) => Promise<WriterOutcome<T>>, precheck?: (repo: WriterRepository) => string | null): Promise<WriterOutcome<T>> => {
    const repo = await resolve(target.repoId);
    if (isDenied(repo)) return { kind: 'not_sent', code: repo.denied };
    const failed = precheck?.(repo);
    if (failed) return { kind: 'not_sent', code: failed };
    let token: string;
    try { token = await tokenFor(target, repo, scope); }
    catch (error) {
      if (error instanceof TokenFailure) return { kind: 'not_sent', code: error.message };
      throw error;
    }
    return work(repo, token);
  };
  const input = <S extends z.ZodType>(schema: S, value: unknown): z.infer<S> | null => {
    const parsed = schema.safeParse(value);
    return parsed.success ? parsed.data : null;
  };
  const notSent = (code: string) => ({ kind: 'not_sent', code }) as const;
  const ownsBranch = (target: ChangeTarget, branch: string) => {
    const parsed = parseChangeBranch(branch);
    return parsed !== null && parsed.changeId === target.key.changeId && parsed.generation === target.key.generation;
  };

  const writer: Pick<ChangeWriterPort, 'createBlobs' | 'createTree' | 'createCommit' | 'createRef' | 'createPull'> = {
    async createBlobs(raw) {
      const parsed = input(BlobsInput, raw);
      if (!parsed) return notSent('input_invalid');
      for (const file of parsed.files) if (isProtectedPath(file.path) || gitBlobSha(file.content) !== file.blobSha) return notSent('input_invalid');
      // 토큰 발급 전에 본다. 넘치면 일부만 공개되는 일이 없게 한 바이트도 보내지 않는다.
      if (parsed.files.reduce((sum, file) => sum + file.content.byteLength, 0) > ARTIFACT_LIMITS.changedContentBytes) return notSent('content_too_large');
      return withWriteAccess(raw.target, 'contents', async (repo, token) => {
        const shas: string[] = [];
        let lost: { kind: 'unknown'; code: string } | null = null;
        for (const file of parsed.files) {
          const result = await sendWrite(raw.target, `/repos/${repo.fullName}/git/blobs`, token, { content: Buffer.from(file.content).toString('base64'), encoding: 'base64' }, LIMIT.small);
          // blob은 내용 주소라 일부만 올라간 뒤 처음부터 다시 보내도 중복이 생기지 않는다. 그래서 앞 blob의 응답을 잃었어도 not_sent를 그대로 돌려줘도 안전하다.
          // unknown으로 돌려주면 안 나간 blob 때문에 대조로 영영 확정하지 못한다.
          const outcome = classify<string>(result, (json, status) => {
            const created = CreatedSha.safeParse(json);
            if (!created.success) return invalid;
            return created.data.sha === file.blobSha ? { kind: 'confirmed', value: created.data.sha } : { kind: 'rejected', status, code: 'blob_sha_mismatch' };
          });
          // 응답만 잃은 blob 때문에 나머지를 안 보내면 대조로 영영 확정하지 못한다. 끝까지 보내고 unknown을 돌려준다.
          if (outcome.kind === 'unknown') { lost ??= outcome; continue; }
          if (outcome.kind !== 'confirmed') return outcome;
          shas.push(outcome.value);
        }
        return lost ?? { kind: 'confirmed', value: { shas } };
      });
    },
    async createTree(raw) {
      const parsed = input(TreeInput, raw);
      if (!parsed) return notSent('input_invalid');
      if (new Set(parsed.entries.map(entry => entry.path)).size !== parsed.entries.length || parsed.entries.some(entry => isProtectedPath(entry.path))) return notSent('input_invalid');
      return withWriteAccess(raw.target, 'contents', async (repo, token) => {
        // type은 항상 blob이다. 임의 subtree·gitlink를 끼워 넣을 자리가 없다. base_tree가 없으면 기존 파일이 사라지므로 필수다.
        const body = { base_tree: parsed.baseTree, tree: parsed.entries.map(entry => ({ path: entry.path, mode: entry.mode, type: 'blob', sha: entry.blobSha })) };
        return classify(await sendWrite(raw.target, `/repos/${repo.fullName}/git/trees`, token, body, LIMIT.large), json => {
          const created = CreatedSha.safeParse(json);
          return created.success ? { kind: 'confirmed', value: { treeSha: created.data.sha } } : invalid;
        });
      });
    },
    async createCommit(raw) {
      const parsed = input(CommitInput, raw);
      if (!parsed) return notSent('input_invalid');
      return withWriteAccess(raw.target, 'contents', async (repo, token) => {
        const body = { message: parsed.metadata.message, tree: parsed.treeSha, parents: [parsed.parent], author: parsed.metadata.author, committer: parsed.metadata.committer };
        return classify(await sendWrite(raw.target, `/repos/${repo.fullName}/git/commits`, token, body, LIMIT.small), json => {
          const created = CreatedCommit.safeParse(json);
          return created.success ? { kind: 'confirmed', value: { commitSha: created.data.sha, treeSha: created.data.tree.sha, parents: created.data.parents.map(parent => parent.sha) } } : invalid;
        });
      });
    },
    async createRef(raw) {
      const parsed = input(RefInput, raw);
      if (!parsed) return notSent('input_invalid');
      if (!ownsBranch(raw.target, parsed.branch)) return notSent('branch_not_allowed');
      return withWriteAccess(raw.target, 'contents', async (repo, token) => {
        const ref = `refs/heads/${parsed.branch}`;
        return classify(await sendWrite(raw.target, `/repos/${repo.fullName}/git/refs`, token, { ref, sha: parsed.sha }, LIMIT.small), json => {
          const created = CreatedRef.safeParse(json);
          return created.success && created.data.ref === ref && created.data.object.type === 'commit' ? { kind: 'confirmed', value: { ref, sha: created.data.object.sha } } : invalid;
        });
      });
    },
    async createPull(raw) {
      const parsed = input(PullInput, raw);
      if (!parsed) return notSent('input_invalid');
      if (!ownsBranch(raw.target, parsed.branch)) return notSent('branch_not_allowed');
      return withWriteAccess(raw.target, 'pull', async (repo, token) => {
        const body = { title: parsed.title, body: parsed.body, head: parsed.branch, base: parsed.baseBranch, draft: parsed.draft, maintainer_can_modify: false };
        return classify(await sendWrite(raw.target, `/repos/${repo.fullName}/pulls`, token, body, LIMIT.pull), json => {
          const created = PullRow.safeParse(json);
          return created.success && created.data.base.repo.id === repo.id && created.data.head.repo?.id === repo.id ? { kind: 'confirmed', value: snapshot(created.data) } : invalid;
        });
      }, repo => repo.baseBranches.includes(parsed.baseBranch) && parseChangeBranch(parsed.baseBranch) === null && safeBranchPath(parsed.baseBranch) ? null : 'base_not_allowed');
    },
  };

  // ---- 읽기 ----

  // 자격 방식만 다른 읽기 묶음을 만든다. 선행 읽기는 null이라 토큰 경로에 닿지 않는다.
  type Credential = (target: ChangeTarget, repo: WriterRepository, fresh: boolean) => Promise<string | null>;
  const reads = (credential: Credential) => {
    const repoFor = async (target: ChangeTarget): Promise<WriterRepository> => {
      if (!Target.safeParse(target).success) throw readFailure('read_input_invalid');
      const repo = await resolve(target.repoId);
      if (isDenied(repo)) throw readFailure(repo.denied);
      return repo;
    };
    const fetchJson = async (target: ChangeTarget, repo: WriterRepository, suffix: string, limit: number): Promise<unknown | null> => {
      const attempt = async (fresh: boolean): Promise<Exchange> => {
        let token: string | null;
        try { token = await credential(target, repo, fresh); }
        catch (error) {
          if (error instanceof TokenFailure) throw readFailure(error.message);
          throw error;
        }
        return exchange('GET', `/repos/${repo.fullName}${suffix}`, token, undefined, limit);
      };
      let result = await attempt(false);
      // 읽기는 부작용이 없어 철회된 캐시 토큰을 한 번 갈아 끼워도 된다.
      if (result.kind === 'http' && result.status === 401) result = await attempt(true);
      if (result.kind === 'http' && result.status === 404) return null;
      if (result.kind === 'http') throw readFailure(result.limited ? 'read_rate_limited' : `read_http_${result.status}`);
      if (result.kind !== 'ok') throw readFailure(`read_${result.code}`);
      return result.json;
    };
    const parseRead = <S extends z.ZodType>(schema: S, json: unknown): z.infer<S> => {
      const parsed = schema.safeParse(json);
      if (!parsed.success) throw readFailure('read_response_invalid');
      return parsed.data;
    };
    const requireSha = (sha: string) => { if (!GitShaSchema.safeParse(sha).success) throw readFailure('read_input_invalid'); };
    const readTreeLeaves: ChangeWriterPort['readTreeLeaves'] = async ({ target, sha }) => {
      requireSha(sha);
      const repo = await repoFor(target);
      const first = await fetchJson(target, repo, `/git/trees/${sha}?recursive=1`, LIMIT.large);
      if (first === null) return null;
      const rows = parseRead(TreeRows, first);
      if (rows.sha !== sha) throw readFailure('read_response_invalid');
      const leafOf = (row: z.infer<typeof TreeRows>['tree'][number], prefix = '') => ({ path: `${prefix}${row.path}`, mode: row.mode, blobSha: row.sha });
      if (!rows.truncated) return { complete: true, leaves: rows.tree.filter(row => row.type !== 'tree').map(row => leafOf(row)) };
      // recursive가 잘리면 한 단계씩 끝까지 읽어 본다. 상한을 넘거나 한 단계라도 잘리면 입증 실패다.
      const leaves: { path: string; mode: string; blobSha: string }[] = [];
      const queue: { sha: string; prefix: string }[] = [{ sha, prefix: '' }];
      for (let requests = 0; queue.length; requests++) {
        if (requests >= TREE_WALK_REQUESTS) return { complete: false, leaves };
        const next = queue.shift()!;
        const raw = await fetchJson(target, repo, `/git/trees/${next.sha}`, LIMIT.large);
        if (raw === null) return { complete: false, leaves };
        const level = parseRead(TreeRows, raw);
        if (level.sha !== next.sha) throw readFailure('read_response_invalid');
        if (level.truncated) return { complete: false, leaves };
        for (const row of level.tree) {
          if (row.type === 'tree') queue.push({ sha: row.sha, prefix: `${next.prefix}${row.path}/` });
          else leaves.push(leafOf(row, next.prefix));
        }
      }
      return { complete: true, leaves };
    };
    return {
      readTreeLeaves,
      readBranchHead: (async ({ target, branch }) => {
        if (!safeBranchPath(branch)) throw readFailure('read_input_invalid');
        const repo = await repoFor(target);
        const raw = await fetchJson(target, repo, `/git/ref/heads/${branch}`, LIMIT.small);
        if (raw === null) return null;
        // 정확한 이름인지 응답으로 다시 본다. prefix 응답의 첫 항목을 채택하지 않는다.
        const ref = parseRead(CreatedRef, raw);
        if (ref.ref !== `refs/heads/${branch}` || ref.object.type !== 'commit') throw readFailure('read_response_invalid');
        return { sha: ref.object.sha };
      }) as ChangeWriterPort['readBranchHead'],
      readCommit: (async ({ target, sha }) => {
        requireSha(sha);
        const repo = await repoFor(target);
        const raw = await fetchJson(target, repo, `/git/commits/${sha}`, LIMIT.small);
        if (raw === null) return null;
        const commit = parseRead(CreatedCommit, raw);
        if (commit.sha !== sha) throw readFailure('read_response_invalid');
        return { treeSha: commit.tree.sha, parents: commit.parents.map(parent => parent.sha) };
      }) as ChangeWriterPort['readCommit'],
      blobRow: async (target: ChangeTarget, sha: string) => {
        requireSha(sha);
        const repo = await repoFor(target);
        const raw = await fetchJson(target, repo, `/git/blobs/${sha}`, LIMIT.content);
        if (raw === null) return null;
        const row = parseRead(BlobRow, raw);
        if (row.sha !== sha) throw readFailure('read_response_invalid');
        return row;
      },
      repoFor,
      fetchJson,
      parseRead,
    };
  };
  const pullToken: Credential = async (target, repo, fresh) => {
    if (fresh) tokens.delete(tokenKey(target, repo, 'pull'));
    return tokenFor(target, repo, 'pull');
  };
  const signed = reads(pullToken);
  const anonymous = reads(async () => null);

  const port: ChangeWriterPort = {
    ...writer,
    readBranchHead: signed.readBranchHead,
    readCommit: signed.readCommit,
    readTreeLeaves: signed.readTreeLeaves,
    readBlobExists: async ({ target, sha }) => (await signed.blobRow(target, sha)) !== null,
    findPulls: async ({ target, headBranch, baseBranch }) => {
      if (!ownsBranch(target, headBranch)) throw readFailure('read_input_invalid');
      const repo = await signed.repoFor(target);
      if (!repo.baseBranches.includes(baseBranch) || !safeBranchPath(baseBranch)) throw readFailure('read_input_invalid');
      const owner = repo.fullName.split('/')[0]!;
      const raw = await signed.fetchJson(target, repo, `/pulls?state=all&head=${owner}:${headBranch}&base=${baseBranch}&per_page=${PULL_PAGE}`, LIMIT.large);
      if (raw === null) throw readFailure('read_http_404');
      const rows = signed.parseRead(z.array(PullRow), raw);
      // 한 쪽이 가득 차면 뒤에 더 있을 수 있어 "일치 한 건"을 입증할 수 없다.
      if (rows.length >= PULL_PAGE) throw readFailure('pull_list_incomplete');
      return rows.filter(row => row.head.ref === headBranch && row.base.ref === baseBranch && row.head.repo?.id === repo.id && row.base.repo.id === repo.id).map(snapshot);
    },
  };
  const preflight: ChangePreflightPort = {
    readBranchHead: anonymous.readBranchHead,
    readCommit: anonymous.readCommit,
    readTreeLeaves: anonymous.readTreeLeaves,
    readBlobText: async (target, sha) => {
      const row = await anonymous.blobRow(target, sha);
      if (row === null) return null;
      const bytes = Buffer.from(row.content ?? '', 'base64');
      if (row.encoding !== 'base64' || gitBlobSha(bytes) !== sha) throw readFailure('read_response_invalid');
      return bytes.toString('utf8');
    },
    // 다른 저장소의 reusable workflow다. writer 저장소 범위를 넓히지 않게 자격 없이 정확한 태그·경로로만 읽는다.
    readPinnedWorkflow: async ({ uses }) => {
      const match = REUSABLE_USES.exec(uses);
      if (!match || !SAFE_SEGMENT.test(match[1]!) || !SAFE_SEGMENT.test(match[2]!) || !SAFE_SEGMENT.test(match[4]!)) throw readFailure('read_input_invalid');
      const path = `/repos/${match[1]}/${match[2]}/contents/${match[3]}?ref=${match[4]}`;
      const result = await exchange('GET', path, null, undefined, LIMIT.content);
      if (result.kind === 'http' && result.status === 404) return null;
      if (result.kind === 'http') throw readFailure(result.limited ? 'read_rate_limited' : `read_http_${result.status}`);
      if (result.kind !== 'ok') throw readFailure(`read_${result.code}`);
      const parsed = ContentsFile.safeParse(result.json);
      if (!parsed.success) throw readFailure('read_response_invalid');
      const bytes = Buffer.from(parsed.data.content, 'base64');
      if (gitBlobSha(bytes) !== parsed.data.sha) throw readFailure('read_response_invalid');
      return { blobSha: parsed.data.sha, text: bytes.toString('utf8') };
    },
  };
  return { writer: port, preflight };
}
