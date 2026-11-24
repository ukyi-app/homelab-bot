// 정지 묶음: 권위 정지 기록의 조회와 답, 정지·풀기의 준비와 확정. 선로 형식과 검증뿐이고 원장의 정지 상태를 바꾸지 않는다.
import { bool, byTag, int, isPlainObject, literal, object, UUID, uuid } from './olive-control-schema.js';

// 정지 세대·실행 세대는 0 이상의 정수다. 정지 세대 0은 첫 설치의 유효값이다.
const generation = int(0);

export type StopRecord = { state: 'recorded'; generation: number; stopped: boolean } | { state: 'absent' };
export interface StopRecordBody {
  in_reply_to: string;
  record: StopRecord;
}

// null, {}, 칸이 빠지거나 남은 기록은 모두 거절이라 "기록 없음"으로 읽히지 않는다. 확인된 부재는 state absent 하나뿐이다.
const stopRecord = byTag<StopRecord>('state', {
  recorded: object({ state: literal('recorded'), generation, stopped: bool }),
  absent: object({ state: literal('absent') }),
});

export const parseStopRecordLookup = (body: unknown) => object({})(body, 'body');
export const parseStopRecord = (body: unknown): StopRecordBody => object({ in_reply_to: uuid, record: stopRecord })(body, 'body');

// stop_prepare·stop_commit·release_prepare는 본문 꼴이 같다. 그래서 단계마다 job_id를 따로 둔다: 같은 job_id면 request_digest가
// 같아 답의 대조가 action까지 봐야 갈린다.
export const parseStopStep = (body: unknown) => object({ job_id: uuid, stop_generation: generation })(body, 'body');
export const parseReleaseCommit = (body: unknown) =>
  object({ job_id: uuid, stop_generation: generation, execution_generation: generation })(body, 'body');

// 갈래가 하나인 결과는 byTag가 아니라 닫힌 객체 하나다: 모르는 칸이 outcome 값보다 먼저 보여 {outcome: 'other', note: 1}이
// unknown_field가 된다(감독 구현과 같은 사유).
export const stopPrepareResult = object({ outcome: literal('prepared') });
// 정지 확정에는 거절 결과가 없다: 감독이 적지 못하면 확정하지 않는다(pending이나 unknown).
export const stopCommitResult = object({ outcome: literal('stopped') });

export type ReleasePrepareResult = { outcome: 'prepared'; execution_generation: number } | { outcome: 'refused' };
// 감독 장부의 실행 세대는 1에서 시작하고 풀기가 1 올리므로 약속하는 다음 실행 세대는 2 이상이다.
export const releasePrepareResult = byTag<ReleasePrepareResult>('outcome', {
  prepared: object({ outcome: literal('prepared'), execution_generation: int(2) }),
  refused: object({ outcome: literal('refused') }),
});
export type ReleaseCommitResult = { outcome: 'released' } | { outcome: 'refused' };
export const releaseCommitResult = byTag<ReleaseCommitResult>('outcome', {
  released: object({ outcome: literal('released') }),
  refused: object({ outcome: literal('refused') }),
});

// 현관이 자기 정지 원장을 읽은 결과. unreadable은 읽기 실패·시간 초과·꼴이 틀린 행이다.
export type StopLedgerRead =
  | { state: 'recorded'; generation: number; stopped: boolean }
  | { state: 'absent' }
  | { state: 'unreadable' };

// stop_record_lookup에 실을 답 본문. 만들 수 없으면 null이고 그때 현관은 답하지 않는다(감독은 모름으로 닫힌 채 기다린다).
// absent는 원장을 읽고 행이 없음을 확인한 결과에서만 나온다: 읽기 실패를 absent로 바꾸면 감독이 정지를 잊고 일을 연다.
// 갈래마다 칸 집합이 정확해야 한다. {state: 'absent', stopped: true}처럼 모순된 행은 읽기 실패와 같이 답하지 않는다: 남는 칸을
// 버리고 답하면 감독은 온전한 부재만 보게 된다.
export function stopRecordReply(inReplyTo: string, read: StopLedgerRead): StopRecordBody | null {
  if (typeof inReplyTo !== 'string' || !UUID.test(inReplyTo)) return null;
  const row: unknown = read;
  if (!isPlainObject(row)) return null;
  const keys = Object.keys(row).sort().join(',');
  if (row.state === 'absent' && keys === 'state') return { in_reply_to: inReplyTo, record: { state: 'absent' } };
  if (row.state === 'recorded' && keys === 'generation,state,stopped') {
    const { generation: value, stopped } = row;
    if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0 || Object.is(value, -0)) return null;
    if (typeof stopped !== 'boolean') return null;
    return { in_reply_to: inReplyTo, record: { state: 'recorded', generation: value, stopped } };
  }
  return null;
}
