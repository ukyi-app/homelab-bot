// 입력·이벤트 묶음: 요청 접수와 취소, 현관이 알리는 사실 넷. 여섯 모두 현관만 내는 효과다. 선로 형식과 검증뿐이고, 같은 ID 다른
// 본문의 충돌, 중복 효과를 한 번으로 줄이는 일, 순번이 늦은 사실을 버리는 일은 감독의 처리기와 장부의 일이다.
import { byOutcome, int, literal, object, oneOf, pattern, sha256, sourceRef, uuid } from './olive-control-schema.js';

const stopGeneration = int(0);
// 병합 커밋: 소문자 16진 40자(SHA-1 커밋 ID).
export const MERGE_COMMIT = /^[0-9a-f]{40}$/;

// 출처의 닫힌 목록. 다른 사람의 글, webhook, 인용·전달 메시지는 현관이 관리자 요청(admin)으로 보내지 않는다.
export const INPUT_SOURCES = ['admin', 'alert'] as const;
export const APPROVAL_STATES = ['approved', 'declined', 'expired', 'invalidated'] as const;
export const PUBLICATION_STATES = ['posted', 'not_posted', 'closed'] as const;

// 원문은 싣지 않는다: 참조(저장소가 발행한 꼴), 원문 바이트의 SHA-256, 원문의 만료 시각뿐이다. 만료 시각은 머리의 시각 칸과 같이
// 1 이상의 Unix epoch 밀리초다. 만료가 이미 지났거나 168시간보다 먼 값은 계약이 거르지 않는다(처리기의 일).
const sourceRefWithDigest = object({ ref: sourceRef, digest: sha256, expires_at: int(1) });

export const parseInputSubmit = (body: unknown) => object({
  job_id: uuid, stop_generation: stopGeneration, source: oneOf(INPUT_SOURCES), source_ref: sourceRefWithDigest,
})(body, 'body');
export type InputSubmit = ReturnType<typeof parseInputSubmit>;

// 취소는 일을 줄이기만 해서 세대를 싣지 않는다(정지 중, 감독이 정지 세대를 모르는 복원 1단계에도 받는다).
export const parseInputCancel = (body: unknown) => object({ job_id: uuid, input_job_id: uuid })(body, 'body');
export type InputCancel = ReturnType<typeof parseInputCancel>;

// 승인 변화에는 글 칸이 없다: 모델의 글이 승인 사실로 올라갈 자리를 두지 않는다. seq는 카드마다 1부터 오른다.
export const parseApprovalChanged = (body: unknown) => object({
  job_id: uuid, stop_generation: stopGeneration, card_job_id: uuid, candidate_digest: sha256, seq: int(1),
  state: oneOf(APPROVAL_STATES),
})(body, 'body');
export type ApprovalChanged = ReturnType<typeof parseApprovalChanged>;

export const parsePublicationChanged = (body: unknown) => object({
  job_id: uuid, publication_job_id: uuid, candidate_digest: sha256, seq: int(1), state: oneOf(PUBLICATION_STATES),
})(body, 'body');
export type PublicationChanged = ReturnType<typeof parsePublicationChanged>;

// merged_at은 병합이 일어난 시각이라 재전달에도 같은 값이다. 봉투의 issued_at은 보낼 때마다 바뀌어 병합 뒤 기한의 기준이 될 수 없다.
export const parseMergeObserved = (body: unknown) => object({
  job_id: uuid, publication_job_id: uuid, merge_commit: pattern(MERGE_COMMIT), merged_at: int(1),
})(body, 'body');
export type MergeObserved = ReturnType<typeof parseMergeObserved>;

// 잊기는 참조 하나만 가리킨다. 이 칸은 input_submit의 source_ref와 이름이 같지만 객체가 아니라 참조 글 하나다(v2 문서·표본).
export const parseSourceForgotten = (body: unknown) => object({ job_id: uuid, source_ref: sourceRef })(body, 'body');
export type SourceForgotten = ReturnType<typeof parseSourceForgotten>;

export type InputSubmitResult = { outcome: 'queued' } | { outcome: 'refused' };
export type InputCancelResult = { outcome: 'cancelled' } | { outcome: 'not_found' };
export type EventResult = { outcome: 'recorded' };

export const inputSubmitResult = byOutcome<InputSubmitResult>(['queued', 'refused']);
// not_found는 감독이 그 입력을 모른다는 확정 결과다. cancelled는 입력에 취소를 적었다는 뜻이고 도는 실행이 멈췄다는 뜻이 아니다.
export const inputCancelResult = byOutcome<InputCancelResult>(['cancelled', 'not_found']);
// 갈래가 하나인 결과는 닫힌 객체 하나다: 모르는 칸을 outcome 값보다 먼저 본다(정지 묶음의 단일 결과와 같은 사유 순서).
export const eventResult = object({ outcome: literal('recorded') });
