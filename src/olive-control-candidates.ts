// 후보 내용 묶음: 현관이 출력 효과의 candidate_digest로 감독에 내용을 묻고(candidate_fetch), 감독이 조각으로 답하며(candidate_chunk),
// 현관이 받은 바이트를 스스로 대조한다(assembleCandidate). 모델이 쓴 내용이 선로를 지나는 자리는 chunk_b64url 하나뿐이다.
// 내용 바이트 안의 꼴(답 글이면 UTF-8 글 등)은 이 쌍이 정하지 않는다: 여기서는 바이트를 바꾸지 않고 대조만 한다.
import { createHash } from 'node:crypto';
import { CANDIDATE_CHUNK_MAX_BYTES, CANDIDATE_MAX_BYTES, CANDIDATE_MAX_CHUNKS } from './olive-control-limits.js';
import {
  byTag, int, isPlainObject, literal, NO_ANSWER_CAUSES, object, SchemaError, sha256, SHA256_HEX, uuid,
} from './olive-control-schema.js';
import type { NoAnswerCause, Parser } from './olive-control-schema.js';

// 받을 조각의 첫 바이트 위치. 전체 상한 미만이다(상한과 같은 위치에는 바이트가 없다).
const offset = int(0, CANDIDATE_MAX_BYTES - 1);
const B64URL = /^[A-Za-z0-9_-]+$/;
// 가장 큰 조각의 base64url 글자 수(패딩 없음). 이보다 긴 글은 풀기 전에 거절한다.
const MAX_CHUNK_CHARS = Math.ceil((CANDIDATE_CHUNK_MAX_BYTES * 4) / 3);

// 조각 바이트. base64url 해석기는 패딩·남는 비트를 너그럽게 버려 한 바이트열에 여러 표기가 생기므로 다시 써서 같은 표기만 받는다.
function chunkBytesOf(text: unknown): Buffer | null {
  if (typeof text !== 'string' || text.length > MAX_CHUNK_CHARS || !B64URL.test(text)) return null;
  const bytes = Buffer.from(text, 'base64url');
  if (bytes.length < 1 || bytes.length > CANDIDATE_CHUNK_MAX_BYTES || bytes.toString('base64url') !== text) return null;
  return bytes;
}

const chunkText: Parser<string> = (value, path) => {
  if (chunkBytesOf(value) === null) throw new SchemaError('malformed', path);
  return value as string;
};

// unavailable은 모르는 digest, 지워짐·만료, 이 현관에 낸 적 없음을 가르지 않는 한 값이다. 가르면 "이 내용이 한때 보관소에 있었다"가
// 새어, 짧은 글을 추측해 해시를 묻는 쪽이 그 글의 존재를 확인할 수 있다.
export type CandidatePiece = { state: 'chunk'; total: number; chunk_b64url: string } | { state: 'unavailable' };
const piece = byTag<CandidatePiece>('state', {
  chunk: object({ state: literal('chunk'), total: int(1, CANDIDATE_MAX_BYTES), chunk_b64url: chunkText }),
  unavailable: object({ state: literal('unavailable') }),
});

export interface CandidateFetch {
  candidate_digest: string;
  offset: number;
}
export interface CandidateChunkReply {
  in_reply_to: string;
  candidate_digest: string;
  offset: number;
  piece: CandidatePiece;
}

export const parseCandidateFetch = (body: unknown): CandidateFetch => object({ candidate_digest: sha256, offset })(body, 'body');

// 조각이 자기 total을 넘으면(offset + 길이 > total) 꼴이 틀린 답이다.
export function parseCandidateChunk(body: unknown): CandidateChunkReply {
  const reply = object({ in_reply_to: uuid, candidate_digest: sha256, offset, piece })(body, 'body');
  if (reply.piece.state === 'chunk' && reply.offset + chunkBytesOf(reply.piece.chunk_b64url)!.length > reply.piece.total) {
    throw new SchemaError('malformed', 'body.piece.total');
  }
  return reply;
}

// 답은 물은 digest와 위치를 되풀이해야 한다. 묻기의 본문을 보관하지 않은 기다리는 요청에는 어떤 답도 맞지 않는다: 그래야 다른 위치를
// 되풀이한 unavailable이 그 묻기의 "확정된 줄 수 없음"으로 읽히지 않는다.
export function chunkAnswersFetch(fetchBody: unknown, reply: Readonly<Record<string, unknown>>): boolean {
  return isPlainObject(fetchBody) && typeof fetchBody.candidate_digest === 'string' && typeof fetchBody.offset === 'number'
    && fetchBody.candidate_digest === reply.candidate_digest && fetchBody.offset === reply.offset;
}

// 후보의 digest: 내용 바이트 그대로의 SHA-256(소문자 16진). 본문 digest(정규 직렬화)와 달리 어떤 정규화도 하지 않는다.
export function candidateDigestOf(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}

// 현관이 한 위치를 물어 얻은 것. 답을 받지 못한 것(시간 초과·끊김·받은 답의 거절)은 "줄 수 없음"이 아니다.
export type CandidateFetchOutcome = { answered: true; reply: CandidateChunkReply } | { answered: false; cause: NoAnswerCause };

export const ASSEMBLY_FAULTS = [
  'malformed', 'other_candidate', 'too_many_chunks', 'size_mismatch', 'order', 'overlap', 'gap', 'digest_mismatch',
] as const;
export type AssemblyFault = (typeof ASSEMBLY_FAULTS)[number];

// complete만 내용으로 쓴다. unavailable은 감독의 확정된 "줄 수 없음", unknown은 답이 없어 모른다(같은 묻기를 다시 낼 수 있다).
export type CandidateAssembly =
  | { kind: 'complete'; bytes: Uint8Array }
  | { kind: 'rejected'; fault: AssemblyFault }
  | { kind: 'unavailable' }
  | { kind: 'unknown'; cause: NoAnswerCause };

const rejected = (fault: AssemblyFault): CandidateAssembly => ({ kind: 'rejected', fault });

interface Chunk {
  offset: number;
  total: number;
  bytes: Buffer;
}

// 한 후보를 위해 물은 위치마다의 마지막 결과를 offset 오름차순으로 받아 내용을 조립한다. 순서(v2 문서):
// 꼴과 digest가 틀린 답(앞에서부터 첫 결과) → unavailable(하나라도 있으면, 다른 묻기의 시간 초과와 무관) → 답 없음 → 조각의 수
// → 조각의 이어짐(크기 → 순서 → 겹침 → 빠짐, 각각 모든 조각에 대해) → 이은 바이트의 digest.
// 현관은 32번째 조각까지 total에 닿지 않으면 더 묻지 않는다(그 조립은 gap). 33개 이상은 이 함수도 받지 않아, 32에서 멈추는 현관과
// 같은 후보의 완료를 다르게 판정하지 않는다.
export function assembleCandidate(candidateDigest: string, outcomes: readonly CandidateFetchOutcome[]): CandidateAssembly {
  if (typeof candidateDigest !== 'string' || !SHA256_HEX.test(candidateDigest) || !Array.isArray(outcomes)) {
    return rejected('malformed');
  }
  const chunks: Chunk[] = [];
  let unavailable = false;
  let unanswered: NoAnswerCause | null = null;
  for (const outcome of outcomes as readonly unknown[]) {
    if (!isPlainObject(outcome)) return rejected('malformed');
    if (outcome.answered === false) {
      if (Object.keys(outcome).length !== 2 || !(NO_ANSWER_CAUSES as readonly unknown[]).includes(outcome.cause)) {
        return rejected('malformed');
      }
      unanswered ??= outcome.cause as NoAnswerCause;
      continue;
    }
    if (outcome.answered !== true || Object.keys(outcome).length !== 2) return rejected('malformed');
    let reply: CandidateChunkReply;
    try {
      reply = parseCandidateChunk(outcome.reply);
    } catch (error) {
      if (error instanceof SchemaError) return rejected('malformed');
      throw error;
    }
    if (reply.candidate_digest !== candidateDigest) return rejected('other_candidate');
    if (reply.piece.state === 'unavailable') {
      unavailable = true;
      continue;
    }
    chunks.push({ offset: reply.offset, total: reply.piece.total, bytes: chunkBytesOf(reply.piece.chunk_b64url)! });
  }
  if (unavailable) return { kind: 'unavailable' };
  if (unanswered !== null) return { kind: 'unknown', cause: unanswered };
  if (chunks.length > CANDIDATE_MAX_CHUNKS) return rejected('too_many_chunks');
  if (chunks.length === 0) return rejected('gap');
  const total = chunks[0]!.total;
  if (chunks.some((chunk) => chunk.total !== total)) return rejected('size_mismatch');
  for (let i = 1; i < chunks.length; i++) if (chunks[i]!.offset < chunks[i - 1]!.offset) return rejected('order');
  for (let i = 1; i < chunks.length; i++) {
    const before = chunks[i - 1]!;
    if (chunks[i]!.offset < before.offset + before.bytes.length) return rejected('overlap');
  }
  let end = 0;
  for (const chunk of chunks) {
    if (chunk.offset !== end) return rejected('gap');
    end += chunk.bytes.length;
  }
  if (end !== total) return rejected('gap');
  const bytes = Buffer.concat(chunks.map((chunk) => chunk.bytes));
  if (candidateDigestOf(bytes) !== candidateDigest) return rejected('digest_mismatch');
  return { kind: 'complete', bytes: new Uint8Array(bytes) };
}
