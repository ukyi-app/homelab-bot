import { sign } from 'node:crypto';
import type { KeyObject } from 'node:crypto';
import { z } from 'zod';
import { Denied } from './contracts.js';
import { GitHubError } from './review.js';

// 게시 서버가 리뷰 App으로 GitHub을 부르는 맨 아래 층. 작업자에는 두지 않는다(D-15).
// 오류에는 고정 코드만 싣는다. fetch·JSON.parse 원본 오류는 요청 값이나 응답 조각을 담을 수 있어 cause로도 잇지 않는다.
const API = 'https://api.github.com';
const API_VERSION = '2022-11-28';
const REQUEST_TIMEOUT_MS = 30_000;
const RATE_LIMIT_DEFAULT_MS = 60_000;
const RETRY_AFTER_MAX_MS = 3_600_000;
// 게시 서버 limit이 256Mi다. recursive tree 문서 상한(7MB)과 PR 100개 목록은 담되, 파싱 부담을 고려해 더 키우지 않는다.
export const RESPONSE_LIMIT_BYTES = 16 * 1024 * 1024;
export const REFRESH_MARGIN_MS = 300_000;
const TOKEN_LIFETIME_MAX_MS = 3_600_000 + REFRESH_MARGIN_MS;

// fetch가 점 세그먼트를 정규화하면 검사한 경로와 다른 곳으로 가므로 "."·".."은 소유자·저장소 이름에서 뺀다.
const SEGMENT = String.raw`(?!\.\.?/)[A-Za-z0-9_.-]+`;
const REPO = `/repos/${SEGMENT}/${SEGMENT}`;
const NUMBER = '[1-9][0-9]{0,15}';
const SHA = '[a-f0-9]{40}';
const ALLOWED = Object.freeze([
  `POST /app/installations/${NUMBER}/access_tokens`,
  // 리뷰 요청(C30) 대상 확인: 그 저장소의 App 설치(App JWT)와 저장소 정보(ID·공개 범위, 이름으로 좁힌 설치 토큰).
  `GET ${REPO}/installation`,
  `GET ${REPO}`,
  `GET ${REPO}/pulls/${NUMBER}`,
  String.raw`GET ${REPO}/pulls\?state=open&sort=updated&direction=desc&per_page=100&page=${NUMBER}`,
  String.raw`GET ${REPO}/pulls/${NUMBER}/reviews\?per_page=100&page=${NUMBER}`,
  // 수정 요청 때 그 PR의 리뷰 댓글과 대화 댓글을 자료로 읽는다. 대화 댓글은 issue 댓글 API로만 나온다.
  String.raw`GET ${REPO}/pulls/${NUMBER}/comments\?per_page=100&page=${NUMBER}`,
  String.raw`GET ${REPO}/issues/${NUMBER}/comments\?per_page=100&page=${NUMBER}`,
  String.raw`GET ${REPO}/compare/${SHA}\.\.\.${SHA}\?per_page=1`,
  `GET ${REPO}/git/commits/${SHA}`,
  String.raw`GET ${REPO}/git/trees/${SHA}\?recursive=1`,
  `POST ${REPO}/pulls/${NUMBER}/reviews`,
].map(rule => new RegExp(`^${rule}$`)));
export function assertAllowed(method: string, path: string): void {
  if (!ALLOWED.some(rule => rule.test(`${method} ${path}`))) throw new Denied();
}

function retryAfterMs(headers: Headers, now: number): number {
  const header = headers.get('retry-after');
  let wait = 0;
  if (header && /^\d+$/.test(header)) wait = Number(header) * 1000;
  else if (header) wait = Date.parse(header) - now;
  else if (headers.get('x-ratelimit-remaining') === '0') wait = Number(headers.get('x-ratelimit-reset')) * 1000 - now;
  return Number.isFinite(wait) ? Math.min(Math.max(wait, 0), RETRY_AFTER_MAX_MS) : 0;
}
// 한도 초과 403을 429로 맞춘다. 호출자는 429·5xx만 기다리고 403은 권한 상실로 닫기 때문이다.
function failure(response: Response, now: number): GitHubError {
  const wait = retryAfterMs(response.headers, now);
  const limited = response.status === 429 || (response.status === 403
    && (response.headers.has('retry-after') || response.headers.get('x-ratelimit-remaining') === '0'));
  if (limited) return new GitHubError(429, wait || RATE_LIMIT_DEFAULT_MS);
  return new GitHubError(response.status, response.status >= 500 ? wait : 0);
}
async function readJson(response: Response): Promise<unknown> {
  if (Number(response.headers.get('content-length') ?? '0') > RESPONSE_LIMIT_BYTES) {
    await response.body?.cancel().catch(() => {});
    throw new Error('github_response_limit');
  }
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    if (response.body) for await (const chunk of response.body) {
      size += chunk.byteLength;
      if (size > RESPONSE_LIMIT_BYTES) break;
      chunks.push(chunk);
    }
  } catch { throw new GitHubError(503); }
  if (size > RESPONSE_LIMIT_BYTES) throw new Error('github_response_limit');
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); }
  catch { throw new Error('github_invalid_response'); }
}

export class GitHubApi {
  constructor(private readonly send: typeof fetch = fetch, private readonly now: () => number = Date.now) {}
  // redirect는 따라가지 않는다. 자격을 다른 주소로 넘기지 않고, 이름 바뀐 저장소도 정책 대조 없이 쓰지 않는다.
  async call(method: 'GET' | 'POST', path: string, credential: string, body?: unknown): Promise<unknown> {
    assertAllowed(method, path);
    let response: Response;
    try {
      response = await this.send(`${API}${path}`, { method, redirect: 'manual', signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
        headers: { accept: 'application/vnd.github+json', authorization: `Bearer ${credential}`, 'user-agent': 'homelab-bot',
          'x-github-api-version': API_VERSION, ...(body === undefined ? {} : { 'content-type': 'application/json' }) },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    } catch { throw new GitHubError(503); }
    if (!response.ok) {
      await response.body?.cancel().catch(() => {});
      throw failure(response, this.now());
    }
    return readJson(response);
  }
}

export interface GitHubAppCredentials { appId: string; privateKey: KeyObject }
export interface BoundRepository { id: number; fullName: string; installationId: number }
export type TokenScope = 'read' | 'write';
const SCOPES: Readonly<Record<TokenScope, Readonly<Record<string, string>>>> = Object.freeze({
  read: Object.freeze({ contents: 'read', pull_requests: 'read' }),
  write: Object.freeze({ pull_requests: 'write' }),
});
const base64url = (value: string) => Buffer.from(value).toString('base64url');
// exp는 지금부터 9분이다. GitHub 상한(10분)에 시계 차이 여유를 둔다.
export function appJwt(app: GitHubAppCredentials, nowMs: number): string {
  const now = Math.floor(nowMs / 1000);
  const unsigned = `${base64url(JSON.stringify({ alg: 'RS256', typ: 'JWT' }))}.${base64url(JSON.stringify({ iat: now - 60, exp: now + 540, iss: app.appId }))}`;
  return `${unsigned}.${sign('RSA-SHA256', Buffer.from(unsigned), app.privateKey).toString('base64url')}`;
}
// 토큰을 얻는 단계의 실패. 호출 대상 요청은 아직 나가지 않았다는 뜻이라 게시 경로가 재시도 판단에 쓴다.
export class GitHubTokenError extends GitHubError {
  constructor(status: number, retryAfterMs: number, reason: string) {
    super(status, retryAfterMs);
    this.message = reason;
  }
}
export const TokenResponse = z.object({
  token: z.string().regex(/^[\x21-\x7e]{1,8192}$/), expires_at: z.string(), permissions: z.record(z.string(), z.string()),
  repositories: z.array(z.object({ id: z.number(), full_name: z.string() })).optional(),
});
export function grantedExactly(granted: Record<string, string>, wanted: Readonly<Record<string, string>>): boolean {
  // metadata:read는 모든 App에 따라붙어 요청하지 않아도 응답에 올 수 있다. 그 밖의 추가 권한은 받지 않는다.
  const extra = Object.keys(granted).filter(name => !(name in wanted));
  return extra.every(name => name === 'metadata' && granted[name] === 'read')
    && Object.entries(wanted).every(([name, level]) => granted[name] === level);
}

// 토큰·키는 # 필드에 둔다. private 필드는 inspect·JSON.stringify에 그대로 나온다.
export class GitHubAppAuth {
  #app: GitHubAppCredentials;
  #api: GitHubApi;
  #now: () => number;
  #cache = new Map<string, { token: string; expiresAt: number }>();
  #pending = new Map<string, Promise<string>>();
  constructor(app: GitHubAppCredentials, api: GitHubApi, now: () => number = Date.now) {
    this.#app = app; this.#api = api; this.#now = now;
  }
  async withToken<T>(repo: BoundRepository, scope: TokenScope, call: (token: string) => Promise<T>): Promise<T> {
    const key = `${repo.installationId}:${repo.id}:${repo.fullName}:${scope}`;
    const attempt = async (token: string) => {
      try { return await call(token); } catch (error) {
        if (error instanceof GitHubError && error.status === 401 && this.#cache.get(key)?.token === token) this.#cache.delete(key);
        throw error;
      }
    };
    const entry = this.#cache.get(key);
    if (!entry || this.#now() >= entry.expiresAt - REFRESH_MARGIN_MS) return attempt(await this.#issue(key, repo, scope));
    // 만료 전에 철회된 캐시 토큰일 수 있다. 401은 처리되지 않은 요청이라 새 토큰으로 한 번만 다시 보낸다.
    try { return await attempt(entry.token); } catch (error) {
      if (!(error instanceof GitHubError && error.status === 401)) throw error;
    }
    return attempt(await this.#issue(key, repo, scope));
  }
  #issue(key: string, repo: BoundRepository, scope: TokenScope): Promise<string> {
    const running = this.#pending.get(key);
    if (running) return running;
    const issuing = this.#request(repo, scope).then(issued => {
      this.#cache.set(key, issued);
      return issued.token;
    }).finally(() => { this.#pending.delete(key); });
    this.#pending.set(key, issuing);
    return issuing;
  }
  async #request(repo: BoundRepository, scope: TokenScope): Promise<{ token: string; expiresAt: number }> {
    const wanted = SCOPES[scope];
    let raw: unknown;
    try {
      raw = await this.#api.call('POST', `/app/installations/${repo.installationId}/access_tokens`, appJwt(this.#app, this.#now()),
        { repository_ids: [repo.id], permissions: wanted });
    } catch (error) {
      if (error instanceof GitHubError) throw new GitHubTokenError(error.status, error.retryAfterMs, `token_http_${error.status}`);
      if (error instanceof Denied) throw error;
      throw new GitHubTokenError(502, 0, 'token_response_invalid');
    }
    const parsed = TokenResponse.safeParse(raw);
    const expiresAt = parsed.success ? Date.parse(parsed.data.expires_at) : Number.NaN;
    if (!parsed.success || !Number.isFinite(expiresAt)) throw new GitHubTokenError(502, 0, 'token_response_invalid');
    const repositories = parsed.data.repositories ?? [];
    if (repositories.length !== 1 || repositories[0]!.id !== repo.id || repositories[0]!.full_name !== repo.fullName) {
      throw new GitHubTokenError(403, 0, 'token_repository_mismatch');
    }
    if (!grantedExactly(parsed.data.permissions, wanted)) throw new GitHubTokenError(403, 0, 'token_permission_mismatch');
    const now = this.#now();
    if (expiresAt <= now || expiresAt > now + TOKEN_LIFETIME_MAX_MS) throw new GitHubTokenError(502, 0, 'token_expiry_invalid');
    return { token: parsed.data.token, expiresAt };
  }
}
