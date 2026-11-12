import type { KeyObject } from 'node:crypto';
import { z } from 'zod';
import { ARTIFACT_LIMITS, AUTHOR_ASSOCIATIONS, ArtifactManifestSchema, ChangePathSchema, CommandIdSchema, EvidenceBundleSchema, GenerationSchema, GitShaSchema, REVIEW_MATERIAL_KINDS,
  ReasonCodeSchema, RepoIdSchema, Sha256Schema, VerificationReceiptSchema } from './change-contracts.js';
import type { ChangeLocation, ChangeNote, ReviewMaterial } from './change-contracts.js';
import { CODEX_DEFAULTS, CODEX_LIMITS, EVIDENCE_PATHS } from './codex.js';
import { DEFAULTS, Denied, RateLimitInfoSchema } from './contracts.js';
import type { Clock } from './contracts.js';
import { MAX_TASK_BYTES } from './review-http.js';
import { ExecutionAuthSchema, ExecutionSelectionSchema, SELECTION_REFUSALS } from './execution-auth.js';
import { CAPABILITY_TTL_MS, REPOSITORY_NAME, capabilityDigest, capabilityLive, openCapability, sealCapability } from './worker.js';
import { NONCE_RETENTION_MS } from './worker-state.js';

// 게시 서버 ↔ 작업 레인 작업자의 v1 계약. 기존 /v1/execute·/v1/cancel·/v1/review*와 별개의 끝점이며 실행기 이름·플래그·자격을 담지 않는다.
// 한 /v1/task 호출이 한 턴이다. 끝점·서명은 아직 어디에도 연결하지 않았고, 작업 레인은 꺼져 있다.

// 사용자 확정값(2026-11-05). 기한은 그 일을 자동으로 처리하는 시각이 아니다. 모델 대기는 기한 뒤 owner 확인을 요구할 뿐이고,
// unknown은 기한과 무관하게 살아 있을 수 있는 프로세스의 공간을 지우지 않고 새 접수를 닫는다.
export const TASK_RETENTION = Object.freeze({
  questionTtlMs: CODEX_DEFAULTS.questionTtlMs,
  modelWaitOwnerConfirmMs: 86_400_000,
  sessionVolumeBytes: 2 * 1024 ** 3,
  maxRetainedSessions: 8,
  unknownForceDelete: false,
  unknownIntake: 'closed',
} as const);

// 한 번에 보낼 수 있는 상한. 게시 서버 정책이 더 좁힐 수 있다.
export const TASK_LIMITS = Object.freeze({
  bodyBytes: MAX_TASK_BYTES,
  turnTimeoutMs: DEFAULTS.taskTimeoutMs,
  // job 전체 누적 실행 시간. 재개로 시간 예산이 새로 채워지지 않게 한다. 값은 [제안]: 최대 길이 턴 3회.
  runBudgetMs: 3 * DEFAULTS.taskTimeoutMs,
  // 진행한 턴 수의 예산. 한도·인증 대기로 끝난 턴은 세지 않는다. 값은 [제안]이고 실측 뒤 조정한다.
  turns: 16,
  toolCalls: DEFAULTS.maxToolCalls,
  untrustedChars: DEFAULTS.maxInputChars,
  // 게시되는 요약·질문의 길이. interpretRun이 자르는 값과 같다.
  summaryChars: 1500,
  questionChars: 500,
  // 압축본 상한은 리뷰 레인(InputLimitsSchema)과 같다.
  archiveBytes: 200_000_000,
  files: 1000,
  fileBytes: 2_000_000,
  // 응답 본문 상한 안에 변경 목록과 함께 들어가야 한다. 넘치는 부분은 truncated로 표시하고 전체 digest는 남긴다.
  patchBytes: 1024 * 1024,
  changeItems: EVIDENCE_PATHS,
  lineBytes: CODEX_LIMITS.lineBytes,
  outputBytes: CODEX_LIMITS.outputBytes,
  events: CODEX_LIMITS.events,
  paths: 64,
  pathChars: 512,
  verifyCommands: 8,
} as const);

// 실행 슬롯(migrations/013의 execution_lanes·jobs.execution_lane과 같은 값). 대화·리뷰가 interactive를 함께 쓴다.
export const EXECUTION_LANES = ['interactive', 'task'] as const;
export type ExecutionLane = typeof EXECUTION_LANES[number];
export const executionLaneOf = (type: 'chat' | 'review' | 'task'): ExecutionLane => type === 'task' ? 'task' : 'interactive';
export const EXECUTION_LANE_CLOSED_REASONS = ['unknown', 'cleanup_pending', 'retention_full'] as const;
export type ExecutionLaneClosedReason = typeof EXECUTION_LANE_CLOSED_REASONS[number];
// migrations/013의 cleanup_state와 같은 값. 어떤 방식으로 소멸·정리를 확인했는지는 담지 않는다.
export const TASK_CLEANUP_STATES = ['none', 'pending', 'cleaned'] as const;
export type TaskCleanupState = typeof TASK_CLEANUP_STATES[number];

// 고정 지시문의 판. 게시 서버와 작업자의 판이 다르면 시작하지 않는다. 글은 작업자가 이 판으로 고른다.
// TASK_INSTRUCTIONS_REVISION은 v1 요청이 받는 유일한 판이자 게시 서버가 지금 보내는 판이다.
// 작업자는 v2(변경 작성) 요청에 TASK_INSTRUCTIONS_REVISIONS를 모두 받는다. 게시 서버가 새 판을 보내려면 intake의 change.instructions에 그 판이 있어야 한다.
export const TASK_INSTRUCTIONS_REVISION = 'task-v1';
export const CHANGE_INSTRUCTIONS_REVISION = 'change-v2';
export const TASK_INSTRUCTIONS_REVISIONS = Object.freeze([TASK_INSTRUCTIONS_REVISION, CHANGE_INSTRUCTIONS_REVISION] as const);
export type TaskInstructionsRevision = typeof TASK_INSTRUCTIONS_REVISIONS[number];

const uuid = z.string().uuid();
const sha256 = z.string().regex(/^[a-f0-9]{64}$/);
// DB generation·turn 열이 integer다.
const generation = z.number().int().positive().max(2_147_483_647);
// 턴 번호는 세션 순번이라 프로토콜 한계만 둔다. 턴 예산(TASK_LIMITS.turns)은 한도·인증 대기 턴을 빼고 게시 서버가 센다.
const turn = z.number().int().positive().max(2_147_483_647);
const label = z.string().min(1).max(200);
const bounded = (max: number) => z.number().int().positive().max(max);
// 저장소 안의 상대 경로만. 비신뢰 입력이 들어오는 자리는 아니지만 작업자가 경로를 만들 때 이 모양을 믿는다.
const insidePath = z.string().min(1).max(TASK_LIMITS.pathChars).refine(path =>
  !path.startsWith('/') && !/[\u0000-\u001f\u007f]/.test(path) && !path.split('/').some(part => part === '..' || part === '.' || part === ''), 'invalid_path');
const pathList = z.array(insidePath).max(TASK_LIMITS.paths);
const untrustedText = z.string().max(TASK_LIMITS.untrustedChars).refine(text => text.trim().length > 0, 'empty_text');

export const TaskWorkerIdentitySchema = z.strictObject({ instance: uuid, storage: uuid });
export type TaskWorkerIdentity = z.infer<typeof TaskWorkerIdentitySchema>;

export const TaskProjectSchema = z.strictObject({
  id: label, revision: label,
  allowedPaths: pathList.min(1), forbiddenPaths: pathList,
  // 출처가 검증된 명령의 식별자다. 명령 문자열은 작업자의 고정 정책에서 찾는다.
  verifyCommands: z.array(z.string().regex(/^[a-z][a-z0-9_-]{0,63}$/)).max(TASK_LIMITS.verifyCommands),
});
export const TaskRunLimitsSchema = z.strictObject({
  archiveBytes: bounded(TASK_LIMITS.archiveBytes), files: bounded(TASK_LIMITS.files), fileBytes: bounded(TASK_LIMITS.fileBytes),
  patchBytes: bounded(TASK_LIMITS.patchBytes), lineBytes: bounded(TASK_LIMITS.lineBytes),
  outputBytes: bounded(TASK_LIMITS.outputBytes), events: bounded(TASK_LIMITS.events),
});

// 질문 ID는 job·세션·질문을 낸 턴으로 정해진다. 같은 턴을 다시 받아도 질문이 늘지 않는다.
export const taskQuestionId = (job: string, sessionId: string, questionTurn: number) => `${job}:${sessionId}:${questionTurn}`;

const executionShape = {
  version: z.literal(1), lane: z.literal('task'), job: uuid, lease: uuid, generation,
  policyRevision: label, instructions: z.literal(TASK_INSTRUCTIONS_REVISION),
  sessionId: uuid,
  // owner·게시 대상은 게시 서버가 갖는다. 저장소는 압축본 URL을 작업자가 archiveContract로 만들 재료일 뿐, 임의 URL을 받지 않는다.
  repository: z.string().max(140).regex(REPOSITORY_NAME), base: z.string().regex(/^[a-f0-9]{40}$/),
  project: TaskProjectSchema,
  timeoutMs: bounded(TASK_LIMITS.turnTimeoutMs),
  // 이 턴을 띄울 수 있는 남은 누적 실행 시간. 0이면 띄우지 않으므로 받지 않는다.
  runBudgetRemainingMs: bounded(TASK_LIMITS.runBudgetMs),
  // 남은 도구 호출 수. 0이면 게시 서버가 띄우지 않고 실패로 끝낸다(CodexBridge와 같은 규칙).
  toolCalls: bounded(TASK_LIMITS.toolCalls),
  limits: TaskRunLimitsSchema,
};
// 방식 선택(DECISIONS "C39"). 이 턴을 돌릴 계정·묶음 revision·방식·실행 ID이고 끝에 두는 선택 칸이다. 칸이 없으면 직렬화·digest가
// 옛 요청과 같고 작업자는 방식 표시로 돈다. 게시 서버는 작업 접수(intake)의 executionSelection에 그 끝점이 있을 때만 싣는다.
// 칸을 모르는 옛 작업자는 strict 모양에서 시작 전에 거부한다(조용히 무시하지 않는다).
const executionSlot = { execution: ExecutionSelectionSchema.optional() };
const TaskStartSchema = z.strictObject({
  ...executionShape, operation: z.literal('start'), turn: z.literal(1),
  untrusted: z.strictObject({ request: untrustedText }), ...executionSlot,
});
const TaskResumeSchema = z.strictObject({
  ...executionShape, operation: z.literal('resume'), turn: turn.min(2),
  expectedWorker: TaskWorkerIdentitySchema,
  resumeReason: z.enum(['clarification', 'model_limit', 'auth_expired']),
  questionId: z.string().max(100).optional(),
  // 한도·인증으로 끊긴 턴이 답을 나르던 중이었으면 같은 답으로 잇는다. 그 밖에는 작업자의 고정 재개 글을 쓴다.
  untrusted: z.strictObject({ answer: untrustedText }).optional(), ...executionSlot,
});
export const TaskRequestSchema = z.discriminatedUnion('operation', [TaskStartSchema, TaskResumeSchema]).superRefine((request, ctx) => {
  if (request.timeoutMs > request.runBudgetRemainingMs) ctx.addIssue({ code: 'custom', path: ['timeoutMs'], message: 'over_run_budget' });
  if (request.operation !== 'resume') return;
  if (request.resumeReason === 'clarification' && !request.questionId) ctx.addIssue({ code: 'custom', path: ['questionId'], message: 'question_required' });
  if ((request.questionId === undefined) !== (request.untrusted === undefined)) ctx.addIssue({ code: 'custom', path: ['untrusted'], message: 'answer_question_mismatch' });
  if (request.questionId !== undefined) {
    const [job, session, asked, ...rest] = request.questionId.split(':');
    const number = Number(asked);
    if (job !== request.job || session !== request.sessionId || rest.length || !Number.isInteger(number) || number < 1 || number >= request.turn
      || taskQuestionId(request.job, request.sessionId, number) !== request.questionId) {
      ctx.addIssue({ code: 'custom', path: ['questionId'], message: 'question_mismatch' });
    }
  }
});
export type TaskRequest = z.infer<typeof TaskRequestSchema>;

// 응답의 failed reason. 비신뢰 글이 섞이지 않도록 상수만 받는다.
export const TASK_FAILURE_REASONS = ['lane_closed', 'busy', 'prepare_failed', 'launch_failed', 'aborted', 'turn_timeout',
  'run_budget_exhausted', 'tool_budget_exceeded', 'output_limit_exceeded', 'policy_violation', 'invalid_stream', 'no_result',
  'api_error', 'execution_error', 'exit_nonzero', 'no_structured_output', 'invalid_output', 'model_cannot_complete', 'finish_failed',
  'credential_recheck_failed', 'secret_echo', 'session_missing', 'session_mismatch', 'fenced', 'archive_failed', 'workspace_failed',
  'diff_unavailable', 'change_outside_workspace', 'change_path_invalid', 'change_outside_policy', 'cleanup_pending', 'storage_full'] as const;
export type TaskFailureReason = typeof TASK_FAILURE_REASONS[number];

// 모델 사용량이 없으면 null이다. 0으로 바꾸면 합산 사용량이 틀린다.
const count = z.number().int().nonnegative();
export const TaskUsageSchema = z.strictObject({
  toolCalls: count.nullable(),
  model: z.strictObject({ inputTokens: count, outputTokens: count, cacheReadTokens: count.nullable(), cacheWriteTokens: count.nullable() }).nullable(),
});
export const TaskChangeSchema = z.discriminatedUnion('change', [
  z.strictObject({ change: z.enum(['added', 'modified']), path: insidePath, mode: z.enum(['100644', '100755', '120000']), digest: sha256 }),
  z.strictObject({ change: z.literal('deleted'), path: insidePath }),
]);
export type TaskChange = z.infer<typeof TaskChangeSchema>;
// 변경 목록·patch·검증 결과는 프로세스 소멸을 확인한 뒤 작업자가 직접 계산한 증거다. 모델의 자기 보고를 담지 않는다.
const TaskEvidenceShape = {
  changes: z.strictObject({ total: count, items: z.array(TaskChangeSchema).max(TASK_LIMITS.changeItems) }).superRefine((changes, ctx) => {
    if (changes.total < changes.items.length) ctx.addIssue({ code: 'custom', message: 'total_below_items' });
    if (new Set(changes.items.map(item => item.path)).size !== changes.items.length) ctx.addIssue({ code: 'custom', message: 'duplicate_path' });
  }),
  patch: z.strictObject({ text: z.string(), bytes: count, digest: sha256, truncated: z.boolean() }).superRefine((patch, ctx) => {
    const sent = Buffer.byteLength(patch.text);
    if (sent > TASK_LIMITS.patchBytes) ctx.addIssue({ code: 'custom', path: ['text'], message: 'patch_too_large' });
    if (patch.truncated ? sent >= patch.bytes : sent !== patch.bytes) ctx.addIssue({ code: 'custom', path: ['bytes'], message: 'patch_size_mismatch' });
  }),
  verification: z.array(z.strictObject({ command: z.string().regex(/^[a-z][a-z0-9_-]{0,63}$/), status: z.enum(['passed', 'failed', 'not_run']),
    exitCode: z.number().int().nullable() })).max(TASK_LIMITS.verifyCommands),
};
const responseShape = {
  version: z.literal(1), job: uuid, lease: uuid, generation, sessionId: uuid, turn,
  worker: TaskWorkerIdentitySchema, usage: TaskUsageSchema,
};
// 그 턴에서 본 한도 정보(contracts RateLimitInfoSchema). 소멸을 확인해 실행기 결과를 읽은 응답에만 붙는 선택 칸이다.
// 칸이 없는 옛 작업자 응답도 그대로 받는다. 이 칸을 모르는 옛 게시 서버는 칸이 있는 응답을 거부하므로, 작업자를 이 판으로 둔 채
// 게시 서버만 이전 판으로 되돌리면 안 된다(VERIFICATION "C03 작업자 한도 정보").
const rateLimitSlot = { rateLimit: RateLimitInfoSchema.optional() };
// 방식 선택이 든 요청의 응답에만 있는 실행 칸. unknown에도 있다(시작했을 수 있는 실행은 요청 선택의 방식뿐이다).
const executionAuthSlot = { execution: ExecutionAuthSchema.optional() };
// stopped: 이 턴의 프로세스가 0개임을 확인했다. 세션 삭제 여부는 sessionRetained가 따로 말한다.
// completed·needs_input은 정리가 남아 있으면 내보내지 않는다(실행 뒤 기록 제거 계약). 그 경우는 failed의 cleanup_pending이다.
export const TaskResponseSchema = z.discriminatedUnion('status', [
  z.strictObject({ ...responseShape, status: z.literal('completed'), stopped: z.literal(true), sessionRetained: z.boolean(), cleanupPending: z.literal(false),
    summary: z.string().max(TASK_LIMITS.summaryChars), ...TaskEvidenceShape, ...rateLimitSlot, ...executionAuthSlot }),
  z.strictObject({ ...responseShape, status: z.literal('needs_input'), stopped: z.literal(true), sessionRetained: z.literal(true), cleanupPending: z.literal(false),
    question: z.string().max(TASK_LIMITS.questionChars).refine(text => text.trim().length > 0, 'empty_text'), ...rateLimitSlot, ...executionAuthSlot }),
  z.strictObject({ ...responseShape, status: z.enum(['limited', 'auth_expired']), stopped: z.literal(true), sessionRetained: z.boolean(), cleanupPending: z.boolean(), ...rateLimitSlot, ...executionAuthSlot }),
  z.strictObject({ ...responseShape, status: z.literal('failed'), stopped: z.literal(true), sessionRetained: z.boolean(), cleanupPending: z.boolean(),
    reason: z.enum(TASK_FAILURE_REASONS), ...rateLimitSlot, ...executionAuthSlot }),
  // 소멸을 확인하지 못했다. 살아 있는 프로세스가 쓸 수 있어 결과·diff를 담지 않고 공간을 지웠다고 말하지 않는다.
  z.strictObject({ ...responseShape, status: z.literal('unknown'), stopped: z.literal(false), sessionRetained: z.literal(true), cleanupPending: z.boolean(), ...executionAuthSlot }),
  // 방식 선택이 든 요청만: 선택 대조에 실패해 모델을 부르지 않았다(모델 턴 아님). 첫 턴이면 작업 공간은 만들어졌을 수 있다.
  z.strictObject({ ...responseShape, status: z.literal('not_run'), stopped: z.literal(true), sessionRetained: z.boolean(), cleanupPending: z.literal(false),
    refusal: z.enum(SELECTION_REFUSALS) }),
]);
export type TaskResponse = z.infer<typeof TaskResponseSchema>;

const controlShape = { version: z.literal(1), job: uuid, lease: uuid, generation, sessionId: uuid };
// expectedWorker가 null이면 첫 턴의 응답을 받지 못해 세션을 가진 작업자를 아직 모른다. 작업자는 자기 identity로 답한다.
export const TaskCancelRequestSchema = z.strictObject({ ...controlShape, expectedWorker: TaskWorkerIdentitySchema.nullable() });
export type TaskCancelRequest = z.infer<typeof TaskCancelRequestSchema>;
export const TaskStatusRequestSchema = z.strictObject({ ...controlShape, expectedWorker: TaskWorkerIdentitySchema.nullable() });
export type TaskStatusRequest = z.infer<typeof TaskStatusRequestSchema>;
// 삭제 요청이라 작업자를 모르면 보내지 않는다. status로 identity를 먼저 얻는다.
export const TaskFinalizeRequestSchema = z.strictObject({ ...controlShape, expectedWorker: TaskWorkerIdentitySchema,
  disposition: z.literal('terminal'),
  // 게시 서버가 최종 상태를 DB에 남긴 뒤에만 보낸다는 표시. 성공 작업은 저장한 결과의 digest로 대조할 수 있다.
  receipt: z.strictObject({ outcome: z.enum(['succeeded', 'failed', 'cancelled']), persistedAt: z.number().int().positive(), resultDigest: sha256.nullable() })
    .refine(receipt => receipt.outcome !== 'succeeded' || receipt.resultDigest !== null, 'result_digest_required'),
});
export type TaskFinalizeRequest = z.infer<typeof TaskFinalizeRequestSchema>;

const cleanupShape = { ...controlShape, worker: TaskWorkerIdentitySchema, stopped: z.boolean(), cleaned: z.boolean(), cleanupPending: z.boolean(), sessionRetained: z.boolean() };
interface CleanupFacts { stopped: boolean; cleaned: boolean; cleanupPending: boolean; sessionRetained: boolean }
const cleanupFacts = (facts: CleanupFacts, ctx: z.RefinementCtx) => {
  if (facts.cleaned && (!facts.stopped || facts.cleanupPending)) ctx.addIssue({ code: 'custom', path: ['cleaned'], message: 'cleaned_mismatch' });
  if (!facts.stopped && !facts.sessionRetained) ctx.addIssue({ code: 'custom', path: ['sessionRetained'], message: 'deleted_while_running' });
};
// 취소의 cleaned: 이 턴의 실행 잔여물을 치웠다. 세션은 finalize까지 남을 수 있다.
export const TaskCancelResponseSchema = z.strictObject(cleanupShape).superRefine(cleanupFacts);
export type TaskCancelResponse = z.infer<typeof TaskCancelResponseSchema>;
// finalize의 cleaned: 이 세대의 세션·작업 공간이 정말 없어졌음을 확인했다. stopped와 cleaned가 모두 true일 때 끝난다.
export const TaskFinalizeResponseSchema = z.strictObject(cleanupShape).superRefine((facts, ctx) => {
  cleanupFacts(facts, ctx);
  if (facts.cleaned && facts.sessionRetained) ctx.addIssue({ code: 'custom', path: ['sessionRetained'], message: 'cleaned_but_retained' });
});
export type TaskFinalizeResponse = z.infer<typeof TaskFinalizeResponseSchema>;
// 내용·파일·토큰은 담지 않는다. absent는 이 저장소가 이 세대를 본 적이 없다는 뜻일 뿐 옛 파드의 소멸 증명이 아니다(worker로 대조한다).
export const TASK_STATUS_STATES = ['running', 'waiting', 'cleanup_pending', 'finalized', 'absent', 'unknown'] as const;
export const TaskStatusResponseSchema = z.strictObject({ ...controlShape, worker: TaskWorkerIdentitySchema, state: z.enum(TASK_STATUS_STATES),
  turn: turn.nullable(), sessionExists: z.boolean(), stopped: z.boolean() }).superRefine((status, ctx) => {
  // running은 세션을 만들기 전 준비 단계일 수 있고, unknown은 세션 존재를 단정하지 못한다.
  const consistent = status.state === 'running' || status.state === 'unknown' ? !status.stopped
    : status.state === 'waiting' ? status.stopped && status.sessionExists
      : status.state === 'finalized' || status.state === 'absent' ? status.stopped && !status.sessionExists
        : status.stopped;
  if (!consistent) ctx.addIssue({ code: 'custom', path: ['state'], message: 'status_mismatch' });
});
export type TaskStatusResponse = z.infer<typeof TaskStatusResponseSchema>;
// 400·401·403·409와 함께 온 이 모양, 또는 연결 전 실패만 미시작의 증거다. 연결 뒤 끊김·깨진 응답은 재전송하지 않고 status·cancel로 확인한다.
export const TaskRejectionSchema = z.strictObject({ status: z.literal('rejected'), started: z.literal(false) });
export type TaskRejection = z.infer<typeof TaskRejectionSchema>;

// ---- v2: CHANGE_PR 작성·검증 계약 ----
// v1과 병존한다. v2는 턴을 접수만 하고 돌려주며 결과는 같은 식별자로 몇 번이든 다시 받는다. 그래서 응답을 잃어도 모델을 다시 돌리지 않는다.
// 취소·상태는 v1 끝점을 함께 쓴다. 같은 직렬 슬롯을 보는 같은 동작이다.

export const TASK_V2_CONTRACT = 2 as const;
// 작업자 판정이 v2에서만 낼 수 있는 차단 사유. 전부 자르지 않고 닫는다는 뜻이다.
export const CHANGE_ARTIFACT_REASONS = ['baseline_mismatch', 'baseline_unsupported', 'artifact_too_large', 'artifact_unsupported', 'artifact_binary',
  'artifact_no_changes', 'artifact_incomplete', 'artifact_path_invalid', 'result_unavailable'] as const;
export type ChangeArtifactReason = typeof CHANGE_ARTIFACT_REASONS[number];
export const TASK_V2_FAILURE_REASONS = [...TASK_FAILURE_REASONS, ...CHANGE_ARTIFACT_REASONS] as const;
export type TaskV2FailureReason = typeof TASK_V2_FAILURE_REASONS[number];

// 게시 서버가 Git tree API로 읽은 T0의 잎. 모드는 일단 다 받는다. symlink·gitlink가 있으면 작업자가 "지원 안 함"으로 닫아 사유가 남는다.
export const BaselineLeafSchema = z.strictObject({ path: z.string().min(1).max(ARTIFACT_LIMITS.pathBytes * 2),
  mode: z.string().regex(/^[0-7]{6}$/), blobSha: GitShaSchema });
export type BaselineLeaf = z.infer<typeof BaselineLeafSchema>;
const TaskV2BaselineSchema = z.strictObject({ repoId: RepoIdSchema, changeGeneration: GenerationSchema, baseTree: GitShaSchema,
  leaves: z.array(BaselineLeafSchema).min(1).max(ARTIFACT_LIMITS.manifestEntries) });
// 공개 brief 전체가 들어가는 자리라 v1의 사용자 입력 상한보다 넓다. brief 최대 길이에 맞춘 값이다.
export const TASK_V2_REQUEST_CHARS = 48_000;
const v2Text = z.string().max(TASK_V2_REQUEST_CHARS).refine(text => text.trim().length > 0, 'empty_text');
// 변경 작성 판의 선택지·확인할 것·남은 위험 상한. 모델 출력은 작업자가 이 값으로 자르고 세며, 선택지 개수만은 틀리면 출력 전체를 받지 않는다. 글자·항목 수는 [제안]이다.
export const CHANGE_NOTE_LIMITS = Object.freeze({ minOptions: 2, maxOptions: 4, optionChars: 100, items: 10, textChars: 300 });
// 수정 차례 자료 블록 상한. 요청 본문 상한(TASK_LIMITS.bodyBytes) 안에 brief(TASK_V2_REQUEST_CHARS)·T0 잎과 함께 들어가야 한다. 값은 [제안]이다.
export const AMENDMENT_LIMITS = Object.freeze({ materials: 50, materialChars: 4000, totalChars: 40_000 });
const filled = (max: number) => z.string().max(max).refine(text => text.trim().length > 0, 'empty_text');
export const ChangeLocationSchema = z.strictObject({ path: ChangePathSchema, line: z.number().int().positive().max(2_147_483_647).nullable() }) satisfies z.ZodType<ChangeLocation>;
export const ChangeNoteSchema = z.strictObject({ text: filled(CHANGE_NOTE_LIMITS.textChars), location: ChangeLocationSchema.optional() }) satisfies z.ZodType<ChangeNote>;
const ChangeNotesSchema = z.array(ChangeNoteSchema).max(CHANGE_NOTE_LIMITS.items);
const ChangeOptionsSchema = z.array(filled(CHANGE_NOTE_LIMITS.optionChars)).min(CHANGE_NOTE_LIMITS.minOptions).max(CHANGE_NOTE_LIMITS.maxOptions);
export const ReviewMaterialSchema = z.strictObject({ kind: z.enum(REVIEW_MATERIAL_KINDS), authorId: z.number().int().positive().nullable(),
  association: z.enum(AUTHOR_ASSOCIATIONS), location: ChangeLocationSchema.nullable(), body: z.string().max(AMENDMENT_LIMITS.materialChars) }) satisfies z.ZodType<ReviewMaterial>;
const materialChars = (items: readonly ReviewMaterial[]) => items.reduce((sum, item) => sum + item.body.length, 0);
// 자료 블록은 공개 저장소 PR의 글이라 label이 public뿐이다. omitted는 상한 때문에 뺀 오래된 자료 수다.
// pullNumber가 null이면 게시 전 고치기 차례(PR 없음, head는 그 generation의 B)이고 자료는 자체 리뷰의 발견이다. 게시 뒤 수정 차례는 PR 번호가 있다.
// 칸 순서는 그대로라 PR 번호가 있는 요청의 직렬화·서명 digest가 바뀌지 않는다.
const AmendmentSchema = z.strictObject({ pullNumber: z.number().int().positive().max(2_147_483_647).nullable(), head: z.string().regex(/^[a-f0-9]{40}$/),
  instruction: untrustedText,
  materials: z.strictObject({ label: z.literal('public'), items: z.array(ReviewMaterialSchema).max(AMENDMENT_LIMITS.materials), omitted: z.number().int().nonnegative() })
    .refine(materials => materialChars(materials.items) <= AMENDMENT_LIMITS.totalChars, 'materials_too_long') });
// 자료를 상한 안으로 줄인다. items는 오래된 것부터다. 긴 본문은 자르고, 그래도 넘치면 앞(오래된 것)부터 뺀다.
export function boundAmendmentMaterials(items: readonly ReviewMaterial[]): { items: ReviewMaterial[]; omitted: number } {
  const cut = items.map(item => item.body.length <= AMENDMENT_LIMITS.materialChars ? item : { ...item, body: `${item.body.slice(0, AMENDMENT_LIMITS.materialChars - 1)}…` });
  let from = Math.max(0, cut.length - AMENDMENT_LIMITS.materials);
  while (materialChars(cut.slice(from)) > AMENDMENT_LIMITS.totalChars) from++;
  return { items: cut.slice(from), omitted: from };
}
const v2Identity = { version: z.literal(TASK_V2_CONTRACT), job: uuid, lease: uuid, generation, sessionId: uuid };
const { version: _v1Version, ...sharedExecution } = executionShape;
// instructions는 executionShape의 같은 자리를 덮는다. 칸 순서가 그대로여야 옛 게시 서버의 서명 digest와 맞는다.
const v2Execution = { ...sharedExecution, ...v2Identity, instructions: z.enum(TASK_INSTRUCTIONS_REVISIONS) };
// amendment는 수정 차례에만 있는 선택 칸이고 끝에 둔다. 칸이 없으면 직렬화가 옛 요청과 같다.
const TaskV2StartSchema = z.strictObject({ ...v2Execution, operation: z.literal('start'), turn: z.literal(1),
  baseline: TaskV2BaselineSchema, untrusted: z.strictObject({ request: v2Text }), amendment: AmendmentSchema.optional(), ...executionSlot });
// 답의 출처를 다시 확인한다. private·unknown은 모양부터 받지 않는다.
const TaskV2ResumeSchema = z.strictObject({ ...v2Execution, operation: z.literal('resume'), turn: turn.min(2),
  expectedWorker: TaskWorkerIdentitySchema, resumeReason: z.enum(['clarification', 'model_limit', 'auth_expired']),
  questionId: z.string().max(100).optional(),
  untrusted: z.strictObject({ answer: untrustedText, label: z.enum(['public', 'approved_public_summary']) }).optional(), ...executionSlot });
export const TaskV2RequestSchema = z.discriminatedUnion('operation', [TaskV2StartSchema, TaskV2ResumeSchema]).superRefine((request, ctx) => {
  if (request.timeoutMs > request.runBudgetRemainingMs) ctx.addIssue({ code: 'custom', path: ['timeoutMs'], message: 'over_run_budget' });
  if (request.operation === 'start' && request.amendment) {
    if (request.instructions !== CHANGE_INSTRUCTIONS_REVISION) ctx.addIssue({ code: 'custom', path: ['amendment'], message: 'amendment_revision' });
    // 수정 차례는 PR 브랜치 head 위에서 작성한다. baseline은 그 head의 tree이고 T0 대조 규칙은 같다.
    if (request.amendment.head !== request.base) ctx.addIssue({ code: 'custom', path: ['amendment', 'head'], message: 'amendment_head_mismatch' });
  }
  if (request.operation !== 'resume') return;
  if (request.resumeReason === 'clarification' && !request.questionId) ctx.addIssue({ code: 'custom', path: ['questionId'], message: 'question_required' });
  if ((request.questionId === undefined) !== (request.untrusted === undefined)) ctx.addIssue({ code: 'custom', path: ['untrusted'], message: 'answer_question_mismatch' });
  if (request.questionId !== undefined) {
    const [job, session, asked, ...rest] = request.questionId.split(':');
    const number = Number(asked);
    if (job !== request.job || session !== request.sessionId || rest.length || !Number.isInteger(number) || number < 1 || number >= request.turn) {
      ctx.addIssue({ code: 'custom', path: ['questionId'], message: 'question_mismatch' });
    }
  }
});
export type TaskV2Request = z.infer<typeof TaskV2RequestSchema>;
const v2Response = { ...v2Identity, worker: TaskWorkerIdentitySchema };
export const TaskV2AcceptedSchema = z.strictObject({ ...v2Response, status: z.literal('accepted'), turn });
export type TaskV2Accepted = z.infer<typeof TaskV2AcceptedSchema>;

const v2Control = { ...v2Identity, expectedWorker: TaskWorkerIdentitySchema.nullable() };
export const TaskV2ResultRequestSchema = z.strictObject(v2Control);
export type TaskV2ResultRequest = z.infer<typeof TaskV2ResultRequestSchema>;
// 작업자 저장소에서 서명까지 지나는 바이트다. 파일 내용은 base64로만 나른다.
const WireFileSchema = z.strictObject({ path: ChangePathSchema, contentBase64: z.string() });
export const WireArtifactSchema = z.strictObject({ manifest: ArtifactManifestSchema, files: z.array(WireFileSchema).max(ARTIFACT_LIMITS.changedFiles), patch: z.string() });
export type WireArtifact = z.infer<typeof WireArtifactSchema>;
const turnedResponse = { ...v2Response, turn, usage: TaskUsageSchema };
export const TaskV2ResultResponseSchema = z.discriminatedUnion('status', [
  z.strictObject({ ...v2Response, status: z.literal('running'), turn: turn.nullable(), stopped: z.literal(false) }),
  // 이 저장소가 이 세대를 모른다(finalized:false). 옛 파드의 소멸 증명이 아니고 접수를 잃었다는 증명도 아니다.
  z.strictObject({ ...v2Response, status: z.literal('absent'), finalized: z.boolean(), stopped: z.boolean() }),
  // options·checks·risks는 변경 작성 판 요청의 결과에만 있다. 이 칸을 모르는 옛 게시 서버는 칸이 있는 결과를 거부하지만, 옛 서버는 옛 판만 보내므로 받을 일이 없다.
  z.strictObject({ ...turnedResponse, status: z.literal('needs_input'), stopped: z.literal(true), sessionRetained: z.literal(true), cleanupPending: z.literal(false),
    question: z.string().max(TASK_LIMITS.questionChars).refine(text => text.trim().length > 0, 'empty_text'), ...rateLimitSlot, options: ChangeOptionsSchema.optional(), ...executionAuthSlot }),
  z.strictObject({ ...turnedResponse, status: z.enum(['limited', 'auth_expired']), stopped: z.literal(true), sessionRetained: z.boolean(), cleanupPending: z.boolean(), ...rateLimitSlot, ...executionAuthSlot }),
  z.strictObject({ ...turnedResponse, status: z.literal('failed'), stopped: z.literal(true), sessionRetained: z.boolean(), cleanupPending: z.boolean(), reason: z.enum(TASK_V2_FAILURE_REASONS), ...rateLimitSlot, ...executionAuthSlot }),
  // 소멸을 확인하지 못했거나 그 턴의 결과를 잃었다. 다시 돌리지 않는다.
  z.strictObject({ ...turnedResponse, status: z.literal('unknown'), stopped: z.boolean(), sessionRetained: z.literal(true), cleanupPending: z.boolean(), ...executionAuthSlot }),
  // 방식 선택이 든 요청만: 선택 대조에 실패해 모델을 부르지 않았다(v1 응답의 not_run과 같은 뜻).
  z.strictObject({ ...turnedResponse, status: z.literal('not_run'), stopped: z.literal(true), sessionRetained: z.boolean(), cleanupPending: z.literal(false),
    refusal: z.enum(SELECTION_REFUSALS) }),
  // 프로세스 소멸을 확인한 뒤 실제 파일로 계산한 결과다. 모델의 요약은 싣지 않는다.
  // checks·risks는 작성 모델이 쓴 확인할 것·남은 위험이다. 증거(승인 digest 재료)가 아니고, 공개 경로로 내기 전에 게시 서버가 공개 검사를 거친다.
  z.strictObject({ ...turnedResponse, status: z.literal('snapshot'), stopped: z.literal(true), sessionRetained: z.literal(true), cleanupPending: z.literal(false),
    artifactDigest: Sha256Schema, artifact: WireArtifactSchema, ...rateLimitSlot, checks: ChangeNotesSchema.optional(), risks: ChangeNotesSchema.optional(), ...executionAuthSlot }),
]);
export type TaskV2ResultResponse = z.infer<typeof TaskV2ResultResponseSchema>;
// 저장해 두는 결과. identity는 읽을 때 지금 작업자로 다시 채운다. 파드가 바뀌어도 같은 저장소면 같은 결과다.
export type TaskV2TurnResult = Extract<TaskV2ResultResponse, { turn: number; usage: unknown }>;

const LogNoteSchema = z.strictObject({
  // 비공개 경로 전용 제한 길이 사본이다. 민감정보가 나온 로그는 null이고 저장도 하지 않는다.
  excerpt: z.string().nullable(), truncated: z.boolean(), sensitive: z.boolean(),
  // 왜 그 상태인지의 상수 코드. 공개 경로로 복사하지 않는다.
  detail: ReasonCodeSchema.nullable(),
});
export const TaskV2VerifyRequestSchema = z.strictObject({ ...v2Identity, expectedWorker: TaskWorkerIdentitySchema, commandId: CommandIdSchema, bundle: EvidenceBundleSchema });
export type TaskV2VerifyRequest = z.infer<typeof TaskV2VerifyRequestSchema>;
export const TaskV2VerificationRequestSchema = z.strictObject({ ...v2Control, commandId: CommandIdSchema });
export type TaskV2VerificationRequest = z.infer<typeof TaskV2VerificationRequestSchema>;
export const TaskV2VerificationResponseSchema = z.discriminatedUnion('status', [
  z.strictObject({ ...v2Response, status: z.literal('running'), commandId: CommandIdSchema }),
  z.strictObject({ ...v2Response, status: z.literal('absent'), commandId: CommandIdSchema }),
  z.strictObject({ ...v2Response, status: z.literal('done'), commandId: CommandIdSchema, receipt: VerificationReceiptSchema, log: LogNoteSchema }),
]);
export type TaskV2VerificationResponse = z.infer<typeof TaskV2VerificationResponseSchema>;

// 결과 저장 ACK. saved는 게시 서버가 저장한 artifact의 digest로 대조하고 다르면 지우지 않는다. discarded는 결과 없이 끝낸 job의 정리다.
export const TaskV2FinalizeRequestSchema = z.strictObject({ ...v2Identity, expectedWorker: TaskWorkerIdentitySchema,
  receipt: z.discriminatedUnion('outcome', [
    z.strictObject({ outcome: z.literal('saved'), artifactDigest: Sha256Schema, persistedAt: z.number().int().positive() }),
    z.strictObject({ outcome: z.literal('discarded'), persistedAt: z.number().int().positive() }),
  ]) });
export type TaskV2FinalizeRequest = z.infer<typeof TaskV2FinalizeRequestSchema>;
export const TaskV2FinalizeResponseSchema = z.strictObject({ ...v2Response, stopped: z.boolean(), cleaned: z.boolean(), cleanupPending: z.boolean(), sessionRetained: z.boolean() }).superRefine((facts, ctx) => {
  cleanupFacts(facts, ctx);
  if (facts.cleaned && facts.sessionRetained) ctx.addIssue({ code: 'custom', path: ['sessionRetained'], message: 'cleaned_but_retained' });
});
export type TaskV2FinalizeResponse = z.infer<typeof TaskV2FinalizeResponseSchema>;

export const TASK_V2_OPERATIONS = ['task_v2_execute', 'task_v2_result', 'task_v2_verify', 'task_v2_verification', 'task_v2_finalize'] as const;
export type TaskV2Operation = typeof TASK_V2_OPERATIONS[number];
export const TASK_V2_ENDPOINTS = Object.freeze({
  '/v2/task': { operation: 'task_v2_execute', request: TaskV2RequestSchema, response: TaskV2AcceptedSchema },
  '/v2/task/result': { operation: 'task_v2_result', request: TaskV2ResultRequestSchema, response: TaskV2ResultResponseSchema },
  '/v2/task/verify': { operation: 'task_v2_verify', request: TaskV2VerifyRequestSchema, response: TaskV2VerificationResponseSchema },
  '/v2/task/verification': { operation: 'task_v2_verification', request: TaskV2VerificationRequestSchema, response: TaskV2VerificationResponseSchema },
  '/v2/task/finalize': { operation: 'task_v2_finalize', request: TaskV2FinalizeRequestSchema, response: TaskV2FinalizeResponseSchema },
} as const);
export type TaskV2Endpoint = keyof typeof TASK_V2_ENDPOINTS;

// 서명 capability. 대화·리뷰의 homelab-worker capability와 audience·operation·필드가 달라 어느 쪽 검증도 다른 쪽 토큰을 받지 않는다.
export const TASK_CAPABILITY_AUDIENCE = 'homelab-task-worker';
export const TASK_OPERATIONS = ['task_execute', 'task_cancel', 'task_status', 'task_finalize'] as const;
export type TaskOperation = typeof TASK_OPERATIONS[number];
export type AnyTaskOperation = TaskOperation | TaskV2Operation;
const isV2Operation = (operation: string) => (TASK_V2_OPERATIONS as readonly string[]).includes(operation);
// operation과 version을 함께 묶는다. 옛 작업자는 version 2를 모양에서 거부하고, 새 작업자는 v1 operation에 version 2를 받지 않는다.
export const TaskCapabilitySchema = z.strictObject({
  audience: z.literal(TASK_CAPABILITY_AUDIENCE), operation: z.enum([...TASK_OPERATIONS, ...TASK_V2_OPERATIONS]), version: z.union([z.literal(1), z.literal(TASK_V2_CONTRACT)]),
  job: uuid, lease: uuid, generation, digest: sha256, issued: z.number().int(), expires: z.number().int(),
}).refine(claims => isV2Operation(claims.operation) === (claims.version === TASK_V2_CONTRACT), 'operation_version_mismatch');
export type TaskCapability = z.infer<typeof TaskCapabilitySchema>;
export const TASK_CAPABILITY = Object.freeze({ ttlMs: CAPABILITY_TTL_MS, skewMs: DEFAULTS.capabilitySkewMs, nonceRetentionMs: NONCE_RETENTION_MS });

// 끝점과 그 operation·요청·응답의 짝.
export const TASK_ENDPOINTS = Object.freeze({
  '/v1/task': { operation: 'task_execute', request: TaskRequestSchema, response: TaskResponseSchema },
  '/v1/task/cancel': { operation: 'task_cancel', request: TaskCancelRequestSchema, response: TaskCancelResponseSchema },
  '/v1/task/status': { operation: 'task_status', request: TaskStatusRequestSchema, response: TaskStatusResponseSchema },
  '/v1/task/finalize': { operation: 'task_finalize', request: TaskFinalizeRequestSchema, response: TaskFinalizeResponseSchema },
} as const);
export type TaskEndpoint = keyof typeof TASK_ENDPOINTS;

// digest는 본문 전체에 걸린다. 저장소·답·예산·세션·정책 revision을 바꾼 요청은 거부된다.
// 양쪽 모두 schema로 파싱한 값을 넘겨야 한다. 파싱이 필드 순서를 정해 digest가 같아진다.
export interface TaskSignedBody { version: 1 | typeof TASK_V2_CONTRACT; job: string; lease: string; generation: number }
export class TaskWorkerSigner {
  constructor(private readonly privateKey: KeyObject, private readonly now: Clock = Date.now) {}
  issue(operation: AnyTaskOperation, body: TaskSignedBody): string {
    const issued = this.now();
    return sealCapability({ audience: TASK_CAPABILITY_AUDIENCE, operation, version: body.version, job: body.job, lease: body.lease,
      generation: body.generation, digest: capabilityDigest(body), issued, expires: issued + TASK_CAPABILITY.ttlMs }, this.privateKey);
  }
}
export class TaskWorkerVerifier {
  constructor(private readonly publicKey: KeyObject,
    private readonly consume: (nonce: string) => Promise<boolean>, private readonly now: Clock = Date.now) {}
  async check(token: string, operation: AnyTaskOperation, body: TaskSignedBody): Promise<void> {
    try {
      const { claims, nonce } = openCapability(token, this.publicKey);
      const c = TaskCapabilitySchema.parse(claims);
      if (c.operation !== operation || c.version !== body.version || c.job !== body.job || c.lease !== body.lease
        || c.generation !== body.generation || c.digest !== capabilityDigest(body) || !capabilityLive(c, this.now())
        || !await this.consume(nonce)) throw new Denied();
    } catch { throw new Denied(); }
  }
}
