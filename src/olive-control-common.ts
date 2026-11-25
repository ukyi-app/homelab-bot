// 공통부 동작의 본문: 인사 둘과 작업 조회 둘.
import { BundleNotImplemented, byTag, literal, object, present, revision, SchemaError, sha256, uuid } from './olive-control-schema.js';
import type { Parser } from './olive-control-schema.js';
import type { ParseContext, Party } from './olive-control-table.js';

export const parseHandshake = (body: unknown) => object({ policy_revision: revision })(body, 'body');
export const parseHandshakeReply = (body: unknown) => object({ in_reply_to: uuid, policy_revision: revision })(body, 'body');

// 조회의 방향: action은 표의 효과 동작이고 그 작업을 낸 쪽(party)이 낼 수 있어야 한다. job_lookup은 묻는 쪽, job_status는 답을 받는
// 쪽이 낸 작업이다. 그래서 현관만 내는 효과를 감독이 묻거나 감독에게 그 결과를 답할 수 없다(body_malformed).
function jobAction(pc: ParseContext, party: Party): Parser<string> {
  return (value, path) => {
    if (typeof value !== 'string' || pc.effect(value)?.from.includes(party) !== true) throw new SchemaError('malformed', path);
    return value;
  };
}

export const parseJobLookup = (body: unknown, pc: ParseContext) =>
  object({ job_id: uuid, action: jobAction(pc, pc.sender), request_digest: sha256 })(body, 'body');

// 셋은 서로 다른 값이다. "효과 없음"은 상태가 아니라 confirmed의 결과로만 온다. unknown은 결과를 실을 수 없다.
export type JobStatus = { state: 'confirmed'; result: unknown } | { state: 'pending' } | { state: 'unknown' };

export function parseJobStatus(body: unknown, pc: ParseContext) {
  const top = object({ in_reply_to: uuid, job_id: uuid, action: jobAction(pc, pc.recipient), request_digest: sha256, status: present })(
    body, 'body');
  const parseResult = pc.effect(top.action)!.parseResult;
  const result: Parser<unknown> = (value, path) => {
    if (parseResult === null) throw new BundleNotImplemented(top.action);
    return parseResult(value, path);
  };
  const status = byTag<JobStatus>('state', {
    confirmed: object({ state: literal('confirmed'), result }),
    pending: object({ state: literal('pending') }),
    unknown: object({ state: literal('unknown') }),
  })(top.status, 'body.status');
  return { ...top, status };
}
