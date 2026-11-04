import { ProxyAgent } from 'undici';
import { ArchiveError } from './review-input.js';
import type { ArchiveFetcher } from './review-input.js';

// 리뷰 작업자의 압축본 다운로더(D-15). 조립은 작업자 진입점 몫이다.
// 내장 fetch는 HTTPS_PROXY만으로는 프록시를 타지 않고 직접 DNS를 찾는다(Node 24.22.0 실측, ENOTFOUND).
// NODE_USE_ENV_PROXY=1은 프로세스 전체에 걸리고 NO_PROXY에 맞으면 프록시를 건너뛰므로, 호출마다 ProxyAgent를 직접 쓴다.
export const ARCHIVE_DEADLINE_MS = 300_000;

export type ArchiveFailureKind = 'transient' | 'permanent' | 'too_large' | 'redirect' | 'cancelled';
export const ARCHIVE_FAILURES = {
  archive_request_invalid: 'permanent', archive_url_rejected: 'permanent', archive_proxy_unavailable: 'permanent',
  archive_not_found: 'permanent', archive_http_rejected: 'permanent', archive_bad_response: 'permanent',
  archive_unavailable: 'transient', archive_network: 'transient', archive_deadline: 'transient',
  archive_limit: 'too_large', archive_redirect: 'redirect', archive_cancelled: 'cancelled',
} as const satisfies Record<string, ArchiveFailureKind>;
export type ArchiveFailureReason = keyof typeof ARCHIVE_FAILURES;

// message가 곧 ReviewWorker의 failed reason이다. archive_limit은 readArchive의 크기 초과와 같은 코드다.
export class ArchiveFetchError extends ArchiveError {
  readonly kind: ArchiveFailureKind;
  constructor(readonly reason: ArchiveFailureReason, cause?: unknown) {
    super(reason, cause === undefined ? undefined : { cause });
    this.kind = ARCHIVE_FAILURES[reason];
  }
}

// archiveContract가 만드는 꼴만 통과한다. '.'·'..' 세그먼트는 문자 집합을 통과하지만 URL 정규화로 경로가 바뀌므로 따로 막는다.
const CODELOAD_URL = /^https:\/\/codeload\.github\.com\/(?!\.{1,2}\/)[A-Za-z0-9_.-]+\/(?!\.{1,2}\/)[A-Za-z0-9_.-]+\/tar\.gz\/[a-f0-9]{40}$/;

// sandbox 값의 꼴(http://<ClusterIP>:3128)만 받는다. 주소에 자격이 있으면 undici가 Proxy-Authorization으로 보내므로 설정 오류로 닫는다.
function proxyOrigin(raw: string | undefined): string | undefined {
  const value = raw?.trim();
  if (!value) return undefined;
  try {
    const url = new URL(value);
    const plain = url.protocol === 'http:' && !url.username && !url.password && url.pathname === '/' && !url.search && !url.hash;
    return plain ? url.origin : undefined;
  } catch { return undefined; }
}

function assertAcceptable(response: Response, maxBytes: number): void {
  const { status } = response;
  if (response.type === 'opaqueredirect' || (status >= 300 && status < 400)) throw new ArchiveFetchError('archive_redirect');
  if (status === 404 || status === 410) throw new ArchiveFetchError('archive_not_found');
  if (status === 408 || status === 425 || status === 429 || status >= 500) throw new ArchiveFetchError('archive_unavailable');
  if (status >= 400) throw new ArchiveFetchError('archive_http_rejected');
  if (status !== 200) throw new ArchiveFetchError('archive_bad_response');
  // fetch가 몰래 풀면 상한을 푼 뒤 크기로 재게 되고, 받은 바이트도 압축본이 아니게 된다.
  const encoding = response.headers.get('content-encoding')?.trim().toLowerCase();
  if (encoding && encoding !== 'identity') throw new ArchiveFetchError('archive_bad_response');
  if (Number(response.headers.get('content-length')) > maxBytes) throw new ArchiveFetchError('archive_limit');
}

async function readBounded(response: Response, maxBytes: number): Promise<Uint8Array> {
  const chunks: Uint8Array[] = [];
  let total = 0;
  if (response.body) {
    const reader = response.body.getReader();
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > maxBytes) throw new ArchiveFetchError('archive_limit');
      chunks.push(value);
    }
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
  return bytes;
}

export interface ArchiveFetcherOptions {
  env?: Record<string, string | undefined>;
  // 압축본 하나의 연결부터 본문 끝까지 전체 시간. 호출자 signal과 별개로 항상 걸린다.
  deadlineMs?: number;
}

// 프록시 env가 없어도 생성은 된다. 프록시 없는 작업자가 대화까지 못 뜨면 안 되고, 받는 호출만 보내지 않고 실패한다.
export function createArchiveFetcher(options: ArchiveFetcherOptions = {}): ArchiveFetcher {
  const deadlineMs = options.deadlineMs ?? ARCHIVE_DEADLINE_MS;
  if (!Number.isSafeInteger(deadlineMs) || deadlineMs <= 0) throw new TypeError('archive_deadline_invalid');
  const proxy = proxyOrigin((options.env ?? process.env).HTTPS_PROXY);
  return async (url, init) => {
    // NaN 상한은 어떤 비교에도 걸리지 않아 무제한이 된다.
    if (init.credentials !== 'omit' || init.redirect !== 'error' || !Number.isSafeInteger(init.maxBytes) || init.maxBytes <= 0) {
      throw new ArchiveFetchError('archive_request_invalid');
    }
    if (!CODELOAD_URL.test(url)) throw new ArchiveFetchError('archive_url_rejected');
    if (!proxy) throw new ArchiveFetchError('archive_proxy_unavailable');
    const deadline = AbortSignal.timeout(deadlineMs);
    // 호출마다 만들어 끝나면 부순다. 터널을 남기지 않고, 상한 초과·취소 때 소켓을 바로 끊는 수단이기도 하다.
    // undici 자체 시간 제한(기본 300초)은 끄고 deadline 하나로 잰다. 환경 변수로 TLS 검증이 꺼지지 않게 명시한다.
    const dispatcher = new ProxyAgent({ uri: proxy, proxyTunnel: true, headersTimeout: 0, bodyTimeout: 0, requestTls: { rejectUnauthorized: true } });
    try {
      // redirect:'manual'도 따라가지 않는다. 'error'는 상태 코드 없는 TypeError라 다른 네트워크 실패와 구분할 수 없다.
      const request: RequestInit & { dispatcher: ProxyAgent } = { method: 'GET', credentials: 'omit', redirect: 'manual',
        headers: { 'accept-encoding': 'identity' }, signal: AbortSignal.any([init.signal, deadline]), dispatcher };
      const response = await fetch(url, request);
      assertAcceptable(response, init.maxBytes);
      return await readBounded(response, init.maxBytes);
    } catch (error) {
      if (error instanceof ArchiveFetchError) throw error;
      if (init.signal.aborted) throw new ArchiveFetchError('archive_cancelled', error);
      if (deadline.aborted) throw new ArchiveFetchError('archive_deadline', error);
      throw new ArchiveFetchError('archive_network', error);
    } finally {
      // 기다리지 않는다. 정리가 멈춰도 취소 응답까지 멈추면 ReviewWorker가 슬롯을 풀지 못한다.
      void dispatcher.destroy().catch(() => {});
    }
  };
}
