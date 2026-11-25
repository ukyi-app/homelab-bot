// 출력 묶음: 감독이 내는 답 글·확인 카드·게시·진행의 후보와 현관이 묻는 실행 세대 조회. 감독이 내는 것은 모두 후보다. 최종 목적지,
// 승인, 보낼 바이트의 공개 검사, 카드의 문구·유효 시간은 현관이 정하므로 본문에 그 칸이 없다(닫힌 객체라 unknown_field, 금지 이름이면
// forbidden_field). 글은 싣지 않고 감독 쪽 결과 보관소의 내용 digest(candidate_digest)만 싣는다.
import { byOutcome, byTag, int, isPlainObject, literal, nullable, object, oneOf, sha256, uuid } from './olive-control-schema.js';

const generation = int(0);

export const REPLY_PURPOSES = ['start', 'answer'] as const;
export const PUBLICATION_KINDS = ['pull_request', 'pull_request_review', 'knowledge_pull_request'] as const;
// 진행 단계. 표시 문구는 현관이 이 이름에서 만든다. 단계 밖의 값(한국어 표시 문구 포함)은 받지 않는다.
export const PROGRESS_STAGES = ['cause', 'patch', 'verify', 'pull_request', 'done', 'stopped'] as const;
// stopped 단계에만 싣는 멈춤 이유의 닫힌 목록. "기타"처럼 뜻 없는 값과 비상 정지는 없다: 정지 중에는 출력 효과가 intake_closed라
// 정지 때의 멈춤 글은 현관이 자기 정지 원장으로 쓴다.
export const PROGRESS_STOP_CAUSES = [
  'deadline', 'budget_exhausted', 'cancelled', 'input_expired', 'launch_refused', 'worker_failed', 'result_rejected',
  'verification_failed', 'executor_lost',
] as const;

// 보낼 곳은 input_job_id(현관이 그 입력을 접수시킨 input_submit의 job_id)에서 현관이 고른다.
export const parseReplyCandidate = (body: unknown) => object({
  job_id: uuid, input_job_id: uuid, purpose: oneOf(REPLY_PURPOSES), candidate_digest: sha256, stop_generation: generation,
  execution_generation: generation,
})(body, 'body');
export type ReplyCandidate = ReturnType<typeof parseReplyCandidate>;

export const parseApprovalCardRequest = (body: unknown) => object({
  job_id: uuid, input_job_id: uuid, candidate_digest: sha256, stop_generation: generation, execution_generation: generation,
})(body, 'body');
export type ApprovalCardRequest = ReturnType<typeof parseApprovalCardRequest>;

// run_id와 input_job_id는 없을 수 있어 null로 싣는다(선택 칸 없음).
export const parsePublicationCandidate = (body: unknown) => object({
  job_id: uuid, kind: oneOf(PUBLICATION_KINDS), candidate_digest: sha256, run_id: nullable(uuid), input_job_id: nullable(uuid),
  stop_generation: generation, execution_generation: generation,
})(body, 'body');
export type PublicationCandidate = ReturnType<typeof parsePublicationCandidate>;

const progressShape = {
  job_id: uuid, input_job_id: uuid, stage: oneOf(PROGRESS_STAGES), seq: int(0), stop_generation: generation,
  execution_generation: generation,
};
const progressOther = object(progressShape);
const progressStopped = object({ ...progressShape, stage: literal('stopped'), stop_cause: oneOf(PROGRESS_STOP_CAUSES) });

// stop_cause는 stage가 stopped일 때만 있고 그때는 반드시 있다. 다른 단계(목록 밖의 값 포함)의 본문에 오면 모르는 칸이다.
export function parseProgressUpdate(body: unknown) {
  const stopped = isPlainObject(body) && body.stage === 'stopped';
  return stopped ? progressStopped(body, 'body') : progressOther(body, 'body');
}
export type ProgressUpdate = ReturnType<typeof parseProgressUpdate>;

// 현관이 실행 세대를 모를 때(첫 설치, 기록 유실) 묻는다. 감독이 자기 값을 모르면 답하지 않는다(모름 상태의 답은 없다).
export const parseExecutionGenerationLookup = (body: unknown) => object({})(body, 'body');
// 감독 장부의 실행 세대는 1에서 시작하므로 0은 권위 값이 될 수 없다.
export const parseExecutionGenerationReply = (body: unknown) => object({ in_reply_to: uuid, generation: int(1) })(body, 'body');
export type ExecutionGenerationReply = ReturnType<typeof parseExecutionGenerationReply>;

export type ReplyResult = { outcome: 'posted' } | { outcome: 'refused' };
// 카드 요청의 확정 결과에는 승인이 없다: 승인은 현관의 approval_changed로만 온다.
export type CardResult = { outcome: 'shown' } | { outcome: 'refused' };
export type PublicationResult = { outcome: 'posted'; pr_number: number } | { outcome: 'not_posted' };
// superseded: 같은 입력에서 이미 보인 순번 이하라 현관이 무시했다.
export type ProgressResult = { outcome: 'shown' } | { outcome: 'superseded' } | { outcome: 'refused' };

export const replyResult = byOutcome<ReplyResult>(['posted', 'refused']);
export const cardResult = byOutcome<CardResult>(['shown', 'refused']);
// 게시됨은 게시 서비스가 정한 PR 번호를 반드시 싣는다(감독이 장애 색인에 적는다). 게시되지 않음에는 번호가 없다.
export const publicationResult = byTag<PublicationResult>('outcome', {
  posted: object({ outcome: literal('posted'), pr_number: int(1) }),
  not_posted: object({ outcome: literal('not_posted') }),
});
export const progressResult = byOutcome<ProgressResult>(['shown', 'superseded', 'refused']);
