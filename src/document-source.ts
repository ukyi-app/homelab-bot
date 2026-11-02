import type { DocumentSource, SourceCheck } from './memory.js';

// 기억의 문서 출처 확인기(T20 B4). 공개 저장소 두 곳의 커밋 고정 링크만 확인한다.
// 게시 서버는 공유 차트 정책으로 인터넷 443(IPv4)만 나간다. 새 egress·토큰 없이 닿는 곳은 공개 저장소의 raw 파일뿐이다.
// 공개 문서라 actor별 권한 차이는 없다. 봇의 기억 명령은 owner만 쓰고 owner 확인은 수신·서비스가 한다.
export const DOCUMENT_REPOSITORIES: readonly string[] = Object.freeze(['ukyi-app/homelab', 'ukyi-app/homelab-bot']);
export const DOCUMENT_CHECK_TIMEOUT_MS = 1000;
const SHA = /^[0-9a-f]{40}$/;
// 경로는 안전한 문자만 받는다(퍼센트 인코딩·`..`·질의 문자열 없음). 받는 모양 그대로 raw 주소를 만들기 때문이다.
const SEGMENT = /^(?!\.{1,2}$)[A-Za-z0-9._-]{1,100}$/;
const BLOB = /^https:\/\/github\.com\/([A-Za-z0-9-]{1,39})\/([A-Za-z0-9._-]{1,100})\/blob\/([^/?#]{1,100})\/([^?#]{1,400})(#L\d{1,6}(-L\d{1,6})?)?$/;

export interface DocumentLink { repository: string; ref: string; path: string; pinned: boolean }
// GitHub blob 링크를 나눈다. 허용 저장소 밖이거나 모양이 다르면 undefined.
export function documentLink(uri: string): DocumentLink | undefined {
  const match = BLOB.exec(uri);
  if (!match) return;
  const repository = `${match[1]}/${match[2]}`;
  const path = match[4]!;
  if (!DOCUMENT_REPOSITORIES.includes(repository) || !path.split('/').every(segment => SEGMENT.test(segment))) return;
  return { repository, ref: match[3]!, path, pinned: SHA.test(match[3]!) };
}
// 명령의 doc= 값에서 근거 revision을 뽑는다. 커밋 고정 링크가 아니면 null(memory.ts가 verified를 unverified로 낮춘다).
export function documentRevision(uri: string): string | null {
  const link = documentLink(uri);
  return link?.pinned ? link.ref : null;
}

// verified: 그 커밋에 그 파일이 있다(진술이 맞는지는 아님. memory.ts EVIDENCE 주석).
// unverified: 허용 저장소지만 브랜치 링크(내용이 바뀜)이거나, 확인 요청이 일시 실패(시간 초과·5xx·429)했다.
// inaccessible: 허용 저장소 밖, 모양이 다름, revision이 링크와 다름, 그 커밋에 파일이 없음(404). 기억은 저장되지 않는다.
export function githubDocuments(options: { send: typeof fetch; timeoutMs?: number }): DocumentSource {
  return {
    async check(_actor: string, uri: string, revision: string | null): Promise<SourceCheck> {
      const link = documentLink(uri);
      if (!link) return 'inaccessible';
      if (!link.pinned) return revision === null ? 'unverified' : 'inaccessible';
      if (revision !== null && revision !== link.ref) return 'inaccessible';
      try {
        const response = await options.send(`https://raw.githubusercontent.com/${link.repository}/${link.ref}/${link.path}`, {
          method: 'GET', redirect: 'error', signal: AbortSignal.timeout(options.timeoutMs ?? DOCUMENT_CHECK_TIMEOUT_MS) });
        // 내용은 읽지 않는다. 있는지만 본다.
        await response.body?.cancel().catch(() => {});
        if (response.status === 200) return 'verified';
        return response.status === 404 ? 'inaccessible' : 'unverified';
      } catch { return 'unverified'; }
    },
  };
}
