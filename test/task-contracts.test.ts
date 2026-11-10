import { test } from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync, randomUUID } from 'node:crypto';
import type { ReviewMaterial } from '../src/change-contracts.js';
import { CODEX_DEFAULTS, CODEX_LIMITS, EVIDENCE_PATHS } from '../src/codex.js';
import { DEFAULTS, Denied } from '../src/contracts.js';
import type { Job } from '../src/contracts.js';
import { CLAUDE_CHAT_CAPABILITIES } from '../src/executor-claude.js';
import { MAX_TASK_BYTES } from '../src/review-http.js';
import { AMENDMENT_LIMITS, CHANGE_INSTRUCTIONS_REVISION, CHANGE_NOTE_LIMITS, EXECUTION_LANES, TASK_CAPABILITY, TASK_CAPABILITY_AUDIENCE, TASK_ENDPOINTS, TASK_INSTRUCTIONS_REVISION, TASK_INSTRUCTIONS_REVISIONS, TASK_LIMITS, TASK_OPERATIONS,
  TASK_RETENTION, TaskCancelRequestSchema, TaskCancelResponseSchema, TaskCapabilitySchema, TaskFinalizeRequestSchema, TaskFinalizeResponseSchema,
  TaskRejectionSchema, TaskRequestSchema, TaskResponseSchema, TaskStatusRequestSchema, TaskStatusResponseSchema, TaskV2RequestSchema, TaskV2ResultResponseSchema, TaskWorkerSigner, TaskWorkerVerifier,
  boundAmendmentMaterials, executionLaneOf, taskQuestionId } from '../src/task-contracts.js';
import { CAPABILITY_TTL_MS, WorkerSigner, WorkerVerifier, sealCapability, capabilityDigest } from '../src/worker.js';
import { NONCE_RETENTION_MS } from '../src/worker-state.js';

const JOB = randomUUID();
const LEASE = randomUUID();
const SESSION = randomUUID();
const WORKER = { instance: randomUUID(), storage: randomUUID() };
const SHA = 'a'.repeat(40);
const DIGEST = 'b'.repeat(64);
const NOW = 1_800_000_000_000;
const start = () => ({
  version: 1, lane: 'task', job: JOB, lease: LEASE, generation: 1, policyRevision: 'policy-1', instructions: TASK_INSTRUCTIONS_REVISION,
  operation: 'start', sessionId: SESSION, turn: 1, repository: 'fixture-owner/fixture-repo', base: SHA,
  project: { id: 'fixture', revision: 'r1', allowedPaths: ['src/**', 'README.md'], forbiddenPaths: ['.github/**'], verifyCommands: ['unit'] },
  untrusted: { request: '고쳐 줘' }, timeoutMs: 600_000, runBudgetRemainingMs: 5_400_000, toolCalls: 8,
  limits: { archiveBytes: 1_000_000, files: 100, fileBytes: 1000, patchBytes: 1000, lineBytes: 1000, outputBytes: 1000, events: 100 },
}) as Record<string, unknown>;
const resume = () => {
  const { untrusted: _untrusted, ...rest } = start();
  return { ...rest, operation: 'resume', turn: 2, expectedWorker: WORKER, resumeReason: 'clarification',
    questionId: taskQuestionId(JOB, SESSION, 1), untrusted: { answer: 'main 쪽으로' } } as Record<string, unknown>;
};
const without = (value: Record<string, unknown>, key: string) => { const copy = { ...value }; delete copy[key]; return copy; };
const rejects = (schema: { safeParse(input: unknown): { success: boolean } }, input: unknown, label: string) =>
  assert.equal(schema.safeParse(input).success, false, label);

test('T18 B1 TaskRequest: 첫 실행과 재개 세 사유를 받는다', () => {
  assert.equal(TaskRequestSchema.parse(start()).operation, 'start');
  assert.equal(TaskRequestSchema.parse(resume()).operation, 'resume');
  const { questionId: _q, untrusted: _u, ...plain } = resume();
  for (const resumeReason of ['model_limit', 'auth_expired']) {
    TaskRequestSchema.parse({ ...plain, resumeReason });
    TaskRequestSchema.parse({ ...resume(), resumeReason });
  }
});
test('T18 B1 TaskRequest: 필드 누락을 거부한다', () => {
  for (const key of Object.keys(start())) rejects(TaskRequestSchema, without(start(), key), key);
  for (const key of ['expectedWorker', 'resumeReason', 'questionId', 'untrusted']) rejects(TaskRequestSchema, without(resume(), key), key);
  const { questionId: _q, ...noQuestion } = resume();
  rejects(TaskRequestSchema, { ...noQuestion, resumeReason: 'model_limit' }, 'answer without question');
});
test('T18 B1 TaskRequest: 추가 필드를 거부한다', () => {
  for (const [path, input] of Object.entries({
    root: { ...start(), url: 'https://example.invalid/a.tgz' },
    project: { ...start(), project: { ...start().project as object, command: 'rm -rf /' } },
    untrusted: { ...start(), untrusted: { request: 'a', answer: 'b' } },
    limits: { ...start(), limits: { ...start().limits as object, extra: 1 } },
    worker: { ...resume(), expectedWorker: { ...WORKER, host: 'x' } },
    startWorker: { ...start(), expectedWorker: WORKER },
    startReason: { ...start(), resumeReason: 'clarification' },
  })) rejects(TaskRequestSchema, input, path);
});
test('T18 B1 TaskRequest: 범위 밖 값을 거부한다', () => {
  const over = (patch: Record<string, unknown>) => ({ ...start(), ...patch });
  for (const [name, input] of Object.entries({
    version: over({ version: 2 }), lane: over({ lane: 'chat' }), generation: over({ generation: 0 }), bigGeneration: over({ generation: 2 ** 31 }),
    job: over({ job: 'not-uuid' }), session: over({ sessionId: 'not-uuid' }), instructions: over({ instructions: 'task-v0' }),
    startTurn: over({ turn: 2 }), repository: over({ repository: '../evil' }), dotRepo: over({ repository: 'owner/..' }), base: over({ base: 'abc' }),
    timeout: over({ timeoutMs: TASK_LIMITS.turnTimeoutMs + 1 }), zeroTimeout: over({ timeoutMs: 0 }),
    runBudget: over({ runBudgetRemainingMs: TASK_LIMITS.runBudgetMs + 1 }), overBudget: over({ timeoutMs: 1000, runBudgetRemainingMs: 999 }),
    tools: over({ toolCalls: TASK_LIMITS.toolCalls + 1 }), noTools: over({ toolCalls: 0 }),
    request: over({ untrusted: { request: 'x'.repeat(TASK_LIMITS.untrustedChars + 1) } }), blank: over({ untrusted: { request: '  \n' } }),
    archive: over({ limits: { ...start().limits as object, archiveBytes: TASK_LIMITS.archiveBytes + 1 } }),
    absolute: over({ project: { ...start().project as object, allowedPaths: ['/etc/passwd'] } }),
    traversal: over({ project: { ...start().project as object, allowedPaths: ['src/../../x'] } }),
    control: over({ project: { ...start().project as object, forbiddenPaths: ['a\nb'] } }),
    noAllowed: over({ project: { ...start().project as object, allowedPaths: [] } }),
    commandText: over({ project: { ...start().project as object, verifyCommands: ['npm test; curl x'] } }),
  })) rejects(TaskRequestSchema, input, name);
  assert.equal(TaskRequestSchema.safeParse({ ...start(), untrusted: { request: 'x'.repeat(TASK_LIMITS.untrustedChars) } }).success, true);
  rejects(TaskRequestSchema, { ...resume(), turn: 1 }, 'resume turn 1');
  rejects(TaskRequestSchema, { ...resume(), turn: 2_147_483_648 }, 'protocol turn limit');
});
test('C19 턴 번호는 프로토콜 한계(DB integer)까지 받고, 턴 예산 16은 스키마가 아니라 게시 서버가 센다', () => {
  // 한도·인증 대기 턴은 예산에서 빠져 진행 턴 16을 다 쓰지 않아도 턴 번호가 17을 넘는다.
  assert.equal(TaskRequestSchema.safeParse({ ...resume(), turn: 17, resumeReason: 'model_limit' }).success, true);
  assert.equal(TaskRequestSchema.safeParse({ ...resume(), turn: 2_147_483_647, resumeReason: 'model_limit' }).success, true);
  TaskResponseSchema.parse({ ...common(), turn: 17, status: 'limited', stopped: true, sessionRetained: true, cleanupPending: false });
  TaskStatusResponseSchema.parse({ ...control(), worker: WORKER, turn: 17, state: 'waiting', sessionExists: true, stopped: true });
  assert.equal(TASK_LIMITS.turns, 16);
});
test('T18 B1 TaskRequest: 질문 ID는 같은 job·세션의 앞 턴만 가리킨다', () => {
  for (const [name, questionId] of Object.entries({
    otherJob: taskQuestionId(randomUUID(), SESSION, 1), otherSession: taskQuestionId(JOB, randomUUID(), 1),
    sameTurn: taskQuestionId(JOB, SESSION, 2), zero: taskQuestionId(JOB, SESSION, 0), text: `${JOB}:${SESSION}:one`, extra: `${JOB}:${SESSION}:1:1`,
    padded: `${JOB}:${SESSION}:01`,
  })) rejects(TaskRequestSchema, { ...resume(), questionId }, name);
  // 한도로 끊긴 답 재개는 턴이 올라가도 같은 질문을 가리킨다.
  assert.equal(TaskRequestSchema.safeParse({ ...resume(), turn: 3, resumeReason: 'model_limit' }).success, true);
  const { questionId: _q, untrusted: _u, ...plain } = resume();
  rejects(TaskRequestSchema, plain, 'clarification without question');
});

const common = () => ({ version: 1, job: JOB, lease: LEASE, generation: 1, sessionId: SESSION, turn: 1, worker: WORKER,
  usage: { toolCalls: 2, model: null } });
const completed = () => ({ ...common(), status: 'completed', stopped: true, sessionRetained: true, cleanupPending: false, summary: '끝',
  changes: { total: 2, items: [{ change: 'modified', path: 'src/a.ts', mode: '100644', digest: DIGEST }, { change: 'deleted', path: 'old.txt' }] },
  patch: { text: 'abc', bytes: 3, digest: DIGEST, truncated: false },
  verification: [{ command: 'unit', status: 'passed', exitCode: 0 }, { command: 'lint', status: 'not_run', exitCode: null }] }) as Record<string, unknown>;
const needsInput = () => ({ ...common(), status: 'needs_input', stopped: true, sessionRetained: true, cleanupPending: false, question: '어느 쪽?' }) as Record<string, unknown>;
const failed = () => ({ ...common(), status: 'failed', stopped: true, sessionRetained: false, cleanupPending: false, reason: 'exit_nonzero' }) as Record<string, unknown>;
const unknown = () => ({ ...common(), status: 'unknown', stopped: false, sessionRetained: true, cleanupPending: true, usage: { toolCalls: null, model: null } }) as Record<string, unknown>;

test('T18 B1 TaskResponse: 여섯 결과를 받는다', () => {
  for (const value of [completed(), needsInput(), failed(), unknown(),
    { ...common(), status: 'limited', stopped: true, sessionRetained: true, cleanupPending: false },
    { ...common(), status: 'auth_expired', stopped: true, sessionRetained: true, cleanupPending: false }]) TaskResponseSchema.parse(value);
  // 모델 사용량이 있으면 그대로 싣고, 없으면 0이 아니라 null이다.
  TaskResponseSchema.parse({ ...failed(), usage: { toolCalls: 0, model: { inputTokens: 1, outputTokens: 2, cacheReadTokens: null, cacheWriteTokens: 3 } } });
});
test('T18 B1 TaskResponse: strict union이 다른 결과의 필드·거짓 상태를 거부한다', () => {
  for (const [name, input] of Object.entries({
    status: { ...failed(), status: 'succeeded' }, questionOnFailed: { ...failed(), question: 'x' }, reasonFreeText: { ...failed(), reason: '토큰 값 sk-ant' },
    summaryOnUnknown: { ...unknown(), summary: 'x' }, changesOnUnknown: { ...unknown(), changes: { total: 0, items: [] } },
    unknownStopped: { ...unknown(), stopped: true }, unknownDeleted: { ...unknown(), sessionRetained: false },
    completedNotStopped: { ...completed(), stopped: false }, completedPending: { ...completed(), cleanupPending: true },
    needsDeleted: { ...needsInput(), sessionRetained: false }, blankQuestion: { ...needsInput(), question: ' ' },
    longQuestion: { ...needsInput(), question: 'x'.repeat(TASK_LIMITS.questionChars + 1) }, longSummary: { ...completed(), summary: 'x'.repeat(TASK_LIMITS.summaryChars + 1) },
    extra: { ...completed(), diff: 'x' }, usageZeroMissing: { ...failed(), usage: { toolCalls: 0 } }, negativeUsage: { ...failed(), usage: { toolCalls: -1, model: null } },
    badWorker: { ...failed(), worker: { instance: 'x', storage: 'y' } }, noWorker: without(failed(), 'worker'),
    outsidePath: { ...completed(), changes: { total: 1, items: [{ change: 'deleted', path: '../x' }] } },
    duplicatePath: { ...completed(), changes: { total: 2, items: [{ change: 'deleted', path: 'a' }, { change: 'deleted', path: 'a' }] } },
    totalShort: { ...completed(), changes: { total: 0, items: [{ change: 'deleted', path: 'a' }] } },
    deletedDigest: { ...completed(), changes: { total: 1, items: [{ change: 'deleted', path: 'a', digest: DIGEST }] } },
    addedNoMode: { ...completed(), changes: { total: 1, items: [{ change: 'added', path: 'a', digest: DIGEST }] } },
    badMode: { ...completed(), changes: { total: 1, items: [{ change: 'added', path: 'a', mode: '100777', digest: DIGEST }] } },
    patchSize: { ...completed(), patch: { text: 'abc', bytes: 4, digest: DIGEST, truncated: false } },
    patchTruncated: { ...completed(), patch: { text: 'abc', bytes: 3, digest: DIGEST, truncated: true } },
    patchLarge: { ...completed(), patch: { text: 'x'.repeat(TASK_LIMITS.patchBytes + 1), bytes: TASK_LIMITS.patchBytes + 2, digest: DIGEST, truncated: true } },
  })) rejects(TaskResponseSchema, input, name);
  TaskResponseSchema.parse({ ...completed(), patch: { text: 'ab', bytes: 3, digest: DIGEST, truncated: true } });
});

// C03: 게시 서버가 같은 스키마로 작업자 응답을 읽는다. 한도 칸은 선택이라 옛 작업자(칸 없음)와 새 작업자(칸 있음)를 둘 다 받는다.
test('C03 작업 응답 한도 칸: v1·v2 응답이 칸이 있는 것과 없는 것을 둘 다 받고, 모양이 틀리거나 unknown에 실리면 거부한다', () => {
  const warning = { event: { status: 'allowed_warning', resetsAt: 1_794_528_000, rateLimitType: 'seven_day', utilization: 0.91 } };
  const stop = { event: { status: 'rejected', resetsAt: 1_794_286_800 }, stop: { cause: 'rate_limit', resetsAt: 1_794_286_800 } };
  const limited = { ...common(), status: 'limited', stopped: true, sessionRetained: true, cleanupPending: false };
  for (const value of [completed(), { ...completed(), rateLimit: warning }, needsInput(), { ...needsInput(), rateLimit: warning }, limited, { ...limited, rateLimit: stop },
    { ...limited, rateLimit: { stop: { cause: 'billing' } } }, { ...failed(), rateLimit: { event: { status: 'allowed' } } }]) TaskResponseSchema.parse(value);
  for (const [name, input] of Object.entries({
    empty: { ...limited, rateLimit: {} }, nullSlot: { ...limited, rateLimit: null }, unknownStatus: { ...limited, rateLimit: { event: { status: 'blocked' } } },
    millis: { ...limited, rateLimit: { stop: { cause: 'rate_limit', resetsAt: 1_794_286_800_000 } } }, cause: { ...limited, rateLimit: { stop: { cause: 'quota' } } },
    raw: { ...limited, rateLimit: { event: { status: 'rejected', overageStatus: 'rejected' } } }, onUnknown: { ...unknown(), rateLimit: warning },
  })) rejects(TaskResponseSchema, input, name);
  const turned = { version: 2, job: JOB, lease: LEASE, generation: 1, sessionId: SESSION, worker: WORKER, turn: 1, usage: { toolCalls: null, model: null } };
  const v2Limited = { ...turned, status: 'limited', stopped: true, sessionRetained: true, cleanupPending: false };
  const v2Unknown = { ...turned, status: 'unknown', stopped: false, sessionRetained: true, cleanupPending: false };
  for (const value of [v2Limited, { ...v2Limited, rateLimit: stop }, { ...turned, status: 'failed', stopped: true, sessionRetained: true, cleanupPending: false, reason: 'api_error', rateLimit: warning },
    { ...turned, status: 'needs_input', stopped: true, sessionRetained: true, cleanupPending: false, question: '어느 파일인가요?', rateLimit: warning }]) TaskV2ResultResponseSchema.parse(value);
  rejects(TaskV2ResultResponseSchema, { ...v2Limited, rateLimit: {} }, 'v2 empty');
  rejects(TaskV2ResultResponseSchema, { ...v2Unknown, rateLimit: warning }, 'v2 onUnknown');
});

const control = () => ({ version: 1 as const, job: JOB, lease: LEASE, generation: 1, sessionId: SESSION });
const receipt = { outcome: 'succeeded', persistedAt: NOW, resultDigest: DIGEST };
test('T18 B1 cancel·status·finalize 요청: 양성과 음성', () => {
  for (const schema of [TaskCancelRequestSchema, TaskStatusRequestSchema]) {
    // 첫 턴 응답을 잃으면 작업자를 모른다.
    schema.parse({ ...control(), expectedWorker: null });
    schema.parse({ ...control(), expectedWorker: WORKER });
    rejects(schema, control(), 'expectedWorker 누락');
    rejects(schema, { ...control(), expectedWorker: null, extra: 1 }, '추가 필드');
    rejects(schema, { ...control(), expectedWorker: null, generation: 0 }, 'generation');
    rejects(schema, { ...control(), expectedWorker: null, version: 2 }, 'version');
  }
  const finalize = { ...control(), expectedWorker: WORKER, disposition: 'terminal', receipt };
  TaskFinalizeRequestSchema.parse(finalize);
  TaskFinalizeRequestSchema.parse({ ...finalize, receipt: { ...receipt, outcome: 'cancelled', resultDigest: null } });
  rejects(TaskFinalizeRequestSchema, { ...finalize, expectedWorker: null }, '삭제는 작업자를 알아야 함');
  rejects(TaskFinalizeRequestSchema, { ...finalize, disposition: 'retry' }, 'disposition');
  rejects(TaskFinalizeRequestSchema, without(finalize, 'receipt'), 'receipt 누락');
  rejects(TaskFinalizeRequestSchema, { ...finalize, receipt: { ...receipt, resultDigest: null } }, '성공인데 digest 없음');
  rejects(TaskFinalizeRequestSchema, { ...finalize, receipt: { ...receipt, outcome: 'unknown' } }, 'unknown은 terminal이 아님');
});
test('T18 B1 cancel·finalize·status 응답: 사실이 어긋나면 거부한다', () => {
  const facts = { ...control(), worker: WORKER, stopped: true, cleaned: true, cleanupPending: false, sessionRetained: false };
  for (const schema of [TaskCancelResponseSchema, TaskFinalizeResponseSchema]) {
    schema.parse(facts);
    schema.parse({ ...facts, stopped: false, cleaned: false, sessionRetained: true });
    schema.parse({ ...facts, cleaned: false, cleanupPending: true, sessionRetained: true });
    rejects(schema, { ...facts, stopped: false, sessionRetained: true }, '멈추지 않았는데 cleaned');
    rejects(schema, { ...facts, cleanupPending: true }, 'cleaned와 대기가 동시');
    rejects(schema, { ...facts, stopped: false, cleaned: false }, '멈추지 않았는데 삭제');
    rejects(schema, { ...facts, cgroup: 'x' }, '구현 방식 필드');
    rejects(schema, without(facts, 'worker'), 'identity 누락');
  }
  // 취소는 세션을 finalize까지 남길 수 있고, finalize의 cleaned는 세션 삭제까지 뜻한다.
  TaskCancelResponseSchema.parse({ ...facts, sessionRetained: true });
  rejects(TaskFinalizeResponseSchema, { ...facts, sessionRetained: true }, 'cleaned인데 세션 보존');

  const status = { ...control(), worker: WORKER, turn: 2 };
  for (const good of [{ state: 'running', sessionExists: true, stopped: false }, { state: 'running', sessionExists: false, stopped: false, turn: null },
    { state: 'waiting', sessionExists: true, stopped: true }, { state: 'cleanup_pending', sessionExists: true, stopped: true },
    { state: 'finalized', sessionExists: false, stopped: true }, { state: 'absent', sessionExists: false, stopped: true, turn: null },
    { state: 'unknown', sessionExists: true, stopped: false }]) TaskStatusResponseSchema.parse({ ...status, ...good });
  for (const bad of [{ state: 'running', sessionExists: true, stopped: true }, { state: 'waiting', sessionExists: false, stopped: true },
    { state: 'unknown', sessionExists: true, stopped: true }, { state: 'absent', sessionExists: true, stopped: true },
    { state: 'cleanup_pending', sessionExists: true, stopped: false }, { state: 'done', sessionExists: false, stopped: true },
    { state: 'waiting', sessionExists: true, stopped: true, summary: '내용' }, { state: 'waiting', sessionExists: true, stopped: true, files: [] }]) {
    rejects(TaskStatusResponseSchema, { ...status, ...bad }, JSON.stringify(bad));
  }
  TaskRejectionSchema.parse({ status: 'rejected', started: false });
  rejects(TaskRejectionSchema, { status: 'rejected', started: true }, 'started true');
  rejects(TaskRejectionSchema, { status: 'rejected', started: false, reason: 'x' }, '추가 필드');
});

test('T18 B1 확정값과 재사용 상수', () => {
  assert.equal(TASK_RETENTION.questionTtlMs, 3_600_000);
  assert.equal(TASK_RETENTION.questionTtlMs, CODEX_DEFAULTS.questionTtlMs);
  assert.equal(TASK_RETENTION.modelWaitOwnerConfirmMs, 24 * 3_600_000);
  assert.equal(TASK_RETENTION.sessionVolumeBytes, 2_147_483_648);
  assert.equal(TASK_RETENTION.maxRetainedSessions, 8);
  assert.equal(TASK_RETENTION.unknownForceDelete, false);
  assert.equal(TASK_RETENTION.unknownIntake, 'closed');
  assert.equal(TASK_LIMITS.turnTimeoutMs, DEFAULTS.taskTimeoutMs);
  assert.equal(TASK_LIMITS.turnTimeoutMs, 1_800_000);
  assert.equal(TASK_LIMITS.toolCalls, DEFAULTS.maxToolCalls);
  assert.equal(TASK_LIMITS.toolCalls, 8);
  assert.equal(TASK_LIMITS.untrustedChars, DEFAULTS.maxInputChars);
  assert.equal(TASK_LIMITS.untrustedChars, 8000);
  assert.equal(TASK_LIMITS.bodyBytes, MAX_TASK_BYTES);
  assert.equal(TASK_LIMITS.bodyBytes, 2 * 1024 * 1024);
  assert.equal(TASK_LIMITS.changeItems, EVIDENCE_PATHS);
  assert.equal(TASK_LIMITS.lineBytes, CODEX_LIMITS.lineBytes);
  assert.equal(TASK_LIMITS.outputBytes, CODEX_LIMITS.outputBytes);
  assert.equal(TASK_LIMITS.events, CODEX_LIMITS.events);
  assert.ok(TASK_LIMITS.runBudgetMs > TASK_LIMITS.turnTimeoutMs);
  assert.ok(TASK_LIMITS.patchBytes < TASK_LIMITS.bodyBytes);
  assert.deepEqual(TASK_CAPABILITY, { ttlMs: CAPABILITY_TTL_MS, skewMs: DEFAULTS.capabilitySkewMs, nonceRetentionMs: NONCE_RETENTION_MS });
  assert.equal(TASK_CAPABILITY.nonceRetentionMs, 62_000);
  assert.deepEqual([...EXECUTION_LANES], ['interactive', 'task']);
  assert.equal(executionLaneOf('chat'), 'interactive');
  assert.equal(executionLaneOf('review'), 'interactive');
  assert.equal(executionLaneOf('task'), 'task');
});
test('T18 B1 끝점 표: 네 끝점과 operation이 일대일이고 작업 레인은 아직 닫혀 있다', () => {
  assert.deepEqual(Object.keys(TASK_ENDPOINTS), ['/v1/task', '/v1/task/cancel', '/v1/task/status', '/v1/task/finalize']);
  assert.deepEqual(Object.values(TASK_ENDPOINTS).map(endpoint => endpoint.operation), [...TASK_OPERATIONS]);
  assert.deepEqual([...TASK_OPERATIONS], ['task_execute', 'task_cancel', 'task_status', 'task_finalize']);
  assert.equal(TASK_CAPABILITY_AUDIENCE, 'homelab-task-worker');
  assert.equal(CLAUDE_CHAT_CAPABILITIES.lanes.task, false);
});

const keys = generateKeyPairSync('ed25519');
const body = () => ({ ...control(), expectedWorker: null });
function verifier(now = NOW) {
  const spent: string[] = [];
  const v = new TaskWorkerVerifier(keys.publicKey, async nonce => { if (spent.includes(nonce)) return false; spent.push(nonce); return true; }, () => now);
  return { v, spent };
}
const signer = (now = NOW) => new TaskWorkerSigner(keys.privateKey, () => now);
const denied = (promise: Promise<void>) => assert.rejects(promise, Denied);

test('T18 B1 capability: 발급한 끝점·본문만 통과하고 한 번만 쓸 수 있다', async () => {
  const { v } = verifier();
  const token = signer().issue('task_cancel', body());
  await v.check(token, 'task_cancel', body());
  await denied(v.check(token, 'task_cancel', body()));
});
test('T18 B1 capability: 다른 operation·식별자·본문을 거부하고 nonce를 쓰지 않는다', async () => {
  const token = signer().issue('task_status', body());
  const { v, spent } = verifier();
  for (const operation of ['task_execute', 'task_cancel', 'task_finalize'] as const) await denied(v.check(token, operation, body()));
  await denied(v.check(token, 'task_status', { ...body(), job: randomUUID() }));
  await denied(v.check(token, 'task_status', { ...body(), lease: randomUUID() }));
  await denied(v.check(token, 'task_status', { ...body(), generation: 2 }));
  await denied(v.check(token, 'task_status', { ...body(), sessionId: randomUUID() } as ReturnType<typeof body>));
  await denied(v.check(token, 'task_status', { ...body(), expectedWorker: WORKER } as unknown as ReturnType<typeof body>));
  assert.deepEqual(spent, []);
  await v.check(token, 'task_status', body());
});
test('T18 B1 capability: 본문의 저장소·답·예산·정책 revision을 바꾸면 거부한다', async () => {
  const request = TaskRequestSchema.parse(resume());
  const token = signer().issue('task_execute', request);
  const { v } = verifier();
  for (const patch of [{ repository: 'other/repo' }, { untrusted: { answer: '다른 답' } }, { toolCalls: 7 }, { timeoutMs: 1000 }, { policyRevision: 'p2' }, { sessionId: randomUUID() }]) {
    await denied(v.check(token, 'task_execute', { ...request, ...patch } as typeof request));
  }
  await v.check(token, 'task_execute', request);
});
test('T18 B1 capability: 받은 JSON의 필드 순서가 달라도 파싱한 값의 digest는 같다', async () => {
  const shuffle = (value: unknown): unknown => Array.isArray(value) ? value.map(shuffle)
    : typeof value === 'object' && value !== null ? Object.fromEntries(Object.entries(value).reverse().map(([key, inner]) => [key, shuffle(inner)])) : value;
  for (const input of [start(), resume()]) {
    const sent = TaskRequestSchema.parse(input);
    const received = TaskRequestSchema.parse(JSON.parse(JSON.stringify(shuffle(sent))));
    await verifier().v.check(signer().issue('task_execute', sent), 'task_execute', received);
  }
  const finalize = TaskFinalizeRequestSchema.parse({ ...control(), expectedWorker: WORKER, disposition: 'terminal', receipt });
  await verifier().v.check(signer().issue('task_finalize', finalize), 'task_finalize', TaskFinalizeRequestSchema.parse(JSON.parse(JSON.stringify(shuffle(finalize)))));
});
test('T18 B1 capability: 시간·형식을 지키지 않으면 거부한다', async () => {
  const issue = (at: number) => signer(at).issue('task_status', body());
  await denied(verifier().v.check(issue(NOW - CAPABILITY_TTL_MS), 'task_status', body()));
  await denied(verifier().v.check(issue(NOW + DEFAULTS.capabilitySkewMs + 1), 'task_status', body()));
  await verifier().v.check(issue(NOW + DEFAULTS.capabilitySkewMs), 'task_status', body());
  const claims = { audience: TASK_CAPABILITY_AUDIENCE, operation: 'task_status', version: 1, job: JOB, lease: LEASE, generation: 1,
    digest: capabilityDigest(body()), issued: NOW, expires: NOW + CAPABILITY_TTL_MS };
  const sealed = (patch: Record<string, unknown>) => sealCapability({ ...claims, ...patch }, keys.privateKey);
  await verifier().v.check(sealed({}), 'task_status', body());
  await denied(verifier().v.check(sealed({ expires: NOW + CAPABILITY_TTL_MS + 1 }), 'task_status', body()));
  await denied(verifier().v.check(sealed({ extra: 1 }), 'task_status', body()));
  await denied(verifier().v.check(sealed({ audience: 'homelab-worker' }), 'task_status', body()));
  await denied(verifier().v.check(sealed({ operation: 'cancel' }), 'task_status', body()));
  await denied(verifier().v.check(sealed({ version: 2 }), 'task_status', body()));
  assert.equal(TaskCapabilitySchema.safeParse({ ...claims, digest: 'not-hex' }).success, false);
  const other = generateKeyPairSync('ed25519');
  await denied(verifier().v.check(new TaskWorkerSigner(other.privateKey, () => NOW).issue('task_status', body()), 'task_status', body()));
  await denied(verifier().v.check(`${sealed({})}=`, 'task_status', body()));
});
test('T18 B1 capability: 대화·리뷰 capability와 서로 쓸 수 없다', async () => {
  const job = { id: JOB, lease_token: LEASE } as Job;
  const cancel = { job: JOB, lease: LEASE };
  const spent: string[] = [];
  const old = new WorkerVerifier(keys.publicKey, async nonce => { spent.push(nonce); return true; }, () => NOW);
  // 작업 토큰은 같은 키로 서명돼도 기존 검증을 통과하지 못한다.
  for (const operation of TASK_OPERATIONS) {
    const token = signer().issue(operation, body());
    await denied(old.check(token, 'execute', cancel));
    await denied(old.check(token, 'cancel', cancel));
  }
  // 작업 토큰을 기존 모양의 본문에 맞춰 다시 봉인해도 audience가 막는다.
  await denied(old.check(sealCapability({ audience: TASK_CAPABILITY_AUDIENCE, operation: 'cancel', job: JOB, lease: LEASE, digest: capabilityDigest(cancel),
    issued: NOW, expires: NOW + CAPABILITY_TTL_MS }, keys.privateKey), 'cancel', cancel));
  assert.deepEqual(spent, []);
  // 기존 토큰은 작업 검증을 통과하지 못한다.
  const legacy = new WorkerSigner(keys.privateKey, () => NOW);
  for (const operation of ['execute', 'cancel'] as const) {
    const token = legacy.issue(job, operation, body());
    for (const task of TASK_OPERATIONS) await denied(verifier().v.check(token, task, body()));
  }
  // 기존 서명·검증은 그대로다.
  await old.check(legacy.issue(job, 'cancel', cancel), 'cancel', cancel);
});
test('T18 B1 capability: 타입도 교차 사용을 막는다', () => {
  const typeOnly = (_: () => unknown) => {};
  const old = new WorkerVerifier(keys.publicKey, async () => true);
  const { v } = verifier();
  const issuer = new WorkerSigner(keys.privateKey);
  const job = { id: JOB, lease_token: LEASE } as Job;
  typeOnly(() => old.check('',
    // @ts-expect-error 기존 검증은 작업 operation을 받지 않는다.
    'task_execute', { job: JOB, lease: LEASE }));
  typeOnly(() => v.check('',
    // @ts-expect-error 작업 검증은 기존 operation을 받지 않는다.
    'execute', body()));
  typeOnly(() => v.check('', 'task_execute',
    // @ts-expect-error 작업 capability는 세대 없는 기존 본문을 받지 않는다.
    { job: JOB, lease: LEASE }));
  typeOnly(() => issuer.issue(job,
    // @ts-expect-error 기존 발급은 작업 operation을 받지 않는다.
    'task_cancel', body()));
  typeOnly(() => signer().issue(
    // @ts-expect-error 작업 발급은 기존 operation을 받지 않는다.
    'cancel', body()));
});

// ---- C25 변경 작성 v2 판 ----
const v2Start = (overrides: Record<string, unknown> = {}) => ({ ...start(), version: 2,
  baseline: { repoId: 4242, changeGeneration: 1, baseTree: SHA, leaves: [{ path: 'src/app.txt', mode: '100644', blobSha: SHA }] }, ...overrides }) as Record<string, unknown>;
const material = (body: string, overrides: Record<string, unknown> = {}) =>
  ({ kind: 'review_comment', authorId: 7, association: 'OWNER', location: { path: 'src/app.txt', line: 3 }, body, ...overrides }) as ReviewMaterial;
const amendment = (overrides: Record<string, unknown> = {}) => ({ pullNumber: 12, head: SHA, instruction: '리뷰 댓글대로 고쳐 줘',
  materials: { label: 'public', items: [material('여기 이름이 틀렸어요')], omitted: 0 }, ...overrides });

test('C25 지시문 판: v1 요청은 지금 판만, v2 요청은 지금 판과 변경 작성 판을 받는다', () => {
  assert.equal(TASK_INSTRUCTIONS_REVISION, 'task-v1', '게시 서버가 지금 보내는 판은 그대로다');
  assert.deepEqual([...TASK_INSTRUCTIONS_REVISIONS], ['task-v1', CHANGE_INSTRUCTIONS_REVISION]);
  rejects(TaskRequestSchema, { ...start(), instructions: CHANGE_INSTRUCTIONS_REVISION }, 'v1은 새 판을 받지 않는다');
  assert.equal(TaskV2RequestSchema.parse(v2Start()).instructions, 'task-v1');
  assert.equal(TaskV2RequestSchema.parse(v2Start({ instructions: CHANGE_INSTRUCTIONS_REVISION })).instructions, CHANGE_INSTRUCTIONS_REVISION);
  rejects(TaskV2RequestSchema, v2Start({ instructions: 'change-v9' }), '모르는 판');
});

test('C25 수정 차례 입력: 변경 작성 판에서만, head는 base와 같고, 자료 블록 label은 public뿐이다', () => {
  const amend = (value: unknown, instructions: string = CHANGE_INSTRUCTIONS_REVISION) => v2Start({ instructions, amendment: value });
  const parsed = TaskV2RequestSchema.parse(amend(amendment())) as { amendment?: { materials: { items: unknown[] } } };
  assert.equal(parsed.amendment?.materials.items.length, 1);
  TaskV2RequestSchema.parse(amend(amendment({ materials: { label: 'public', items: [material('대화 댓글', { kind: 'comment', authorId: null, association: 'NONE', location: null })], omitted: 3 } })));
  rejects(TaskV2RequestSchema, amend(amendment(), 'task-v1'), '옛 판에는 수정 차례가 없다');
  rejects(TaskV2RequestSchema, amend(amendment({ head: 'c'.repeat(40) })), 'head가 base와 다름');
  for (const label of ['approved_public_summary', 'private', 'unknown']) {
    rejects(TaskV2RequestSchema, amend(amendment({ materials: { label, items: [material('x')], omitted: 0 } })), `label ${label}`);
  }
  rejects(TaskV2RequestSchema, amend(amendment({ materials: { label: 'public', items: [material('x', { kind: 'push' })], omitted: 0 } })), '모르는 자료 종류');
  rejects(TaskV2RequestSchema, amend(amendment({ materials: { label: 'public', items: [material('x', { login: 'someone' })], omitted: 0 } })), '작성자 ID·association·위치·본문 밖 칸');
  rejects(TaskV2RequestSchema, amend(amendment({ materials: { label: 'public', items: [material('x', { location: { path: '../etc/passwd', line: 1 } })], omitted: 0 } })), '경로 규칙');
  rejects(TaskV2RequestSchema, amend(amendment({ instruction: ' ' })), '빈 지시');
  const many = Array.from({ length: AMENDMENT_LIMITS.materials + 1 }, (_, index) => material(`댓글 ${index}`));
  rejects(TaskV2RequestSchema, amend(amendment({ materials: { label: 'public', items: many, omitted: 0 } })), '개수 상한');
  const long = [material('가'.repeat(AMENDMENT_LIMITS.materialChars)), material('나'.repeat(AMENDMENT_LIMITS.materialChars))];
  if (2 * AMENDMENT_LIMITS.materialChars > AMENDMENT_LIMITS.totalChars) rejects(TaskV2RequestSchema, amend(amendment({ materials: { label: 'public', items: long, omitted: 0 } })), '글자 상한');
});

test('C31 게시 전 고치기 입력: PR 번호 없는(null) 수정 차례 칸을 받고, 판·head 규칙은 같다', () => {
  const amend = (value: unknown, instructions: string = CHANGE_INSTRUCTIONS_REVISION) => v2Start({ instructions, amendment: value });
  const parsed = TaskV2RequestSchema.parse(amend(amendment({ pullNumber: null }))) as { amendment?: { pullNumber: unknown } };
  assert.equal(parsed.amendment?.pullNumber, null);
  rejects(TaskV2RequestSchema, amend(amendment({ pullNumber: null }), 'task-v1'), '옛 판에는 고치기 차례도 없다');
  rejects(TaskV2RequestSchema, amend(amendment({ pullNumber: null, head: 'c'.repeat(40) })), 'head가 base와 다름');
  for (const pullNumber of [0, -1, 1.5, '12', undefined]) rejects(TaskV2RequestSchema, amend(amendment({ pullNumber })), `pullNumber ${String(pullNumber)}`);
});

test('C31 호환: 기존 요청의 칸 순서와 직렬화(서명 digest의 재료)가 그대로다', () => {
  const plain = TaskV2RequestSchema.parse(v2Start({ instructions: CHANGE_INSTRUCTIONS_REVISION })) as Record<string, unknown>;
  const amended = TaskV2RequestSchema.parse(v2Start({ instructions: CHANGE_INSTRUCTIONS_REVISION, amendment: amendment() })) as Record<string, unknown>;
  assert.equal('amendment' in plain, false, '칸이 없으면 직렬화에 나타나지 않는다');
  assert.deepEqual(Object.keys(amended), [...Object.keys(plain), 'amendment'], '수정 차례 칸은 맨 끝이다');
  assert.equal(JSON.stringify(amended.amendment), `{"pullNumber":12,"head":"${SHA}","instruction":"리뷰 댓글대로 고쳐 줘","materials":{"label":"public","items":[{"kind":"review_comment","authorId":7,"association":"OWNER","location":{"path":"src/app.txt","line":3},"body":"여기 이름이 틀렸어요"}],"omitted":0}}`);
  assert.equal(JSON.stringify(TaskV2RequestSchema.parse(JSON.parse(JSON.stringify(amended)))), JSON.stringify(amended), '다시 파싱해도 같은 바이트');
});

test('C25 자료 블록 상한: 넘치면 오래된 것부터 빼고 뺀 수를 남긴다. 긴 본문은 자른다', () => {
  const items = Array.from({ length: AMENDMENT_LIMITS.materials + 5 }, (_, index) => material(`댓글 ${index}`));
  const bounded = boundAmendmentMaterials(items);
  assert.equal(bounded.items.length, AMENDMENT_LIMITS.materials);
  assert.equal(bounded.omitted, 5);
  assert.equal(bounded.items[0]!.body, '댓글 5', '앞(오래된) 다섯 개가 빠진다');
  assert.equal(bounded.items.at(-1)!.body, `댓글 ${AMENDMENT_LIMITS.materials + 4}`);
  const heavy = Array.from({ length: 30 }, (_, index) => material(`${index}:${'가'.repeat(AMENDMENT_LIMITS.materialChars * 2)}`));
  const cut = boundAmendmentMaterials(heavy);
  assert.ok(cut.items.every(item => item.body.length <= AMENDMENT_LIMITS.materialChars));
  assert.ok(cut.items.reduce((sum, item) => sum + item.body.length, 0) <= AMENDMENT_LIMITS.totalChars);
  assert.equal(cut.omitted + cut.items.length, 30);
  assert.ok(cut.items.at(-1)!.body.startsWith('29:'), '가장 새 자료는 남는다');
  TaskV2RequestSchema.parse(v2Start({ instructions: CHANGE_INSTRUCTIONS_REVISION, amendment: amendment({ materials: { label: 'public', ...cut } }) }));
});

test('C25 결과 칸: needs_input의 선택지는 2~4개, snapshot의 확인할 것·남은 위험은 선택 칸이다', () => {
  const turned = { version: 2, job: JOB, lease: LEASE, generation: 1, sessionId: SESSION, worker: WORKER, turn: 1, usage: { toolCalls: null, model: null } };
  const asked = { ...turned, status: 'needs_input', stopped: true, sessionRetained: true, cleanupPending: false, question: '어느 쪽으로 할까요?' };
  for (const options of [['A', 'B'], ['A', 'B', 'C', 'D']]) TaskV2ResultResponseSchema.parse({ ...asked, options });
  TaskV2ResultResponseSchema.parse(asked);
  for (const options of [[], ['A'], ['A', 'B', 'C', 'D', 'E'], ['A', ' ']]) rejects(TaskV2ResultResponseSchema, { ...asked, options }, `선택지 ${JSON.stringify(options)}`);
  const snapshot = { ...turned, status: 'snapshot', stopped: true, sessionRetained: true, cleanupPending: false, artifactDigest: DIGEST,
    artifact: { manifest: { version: 1, baseCommit: SHA, baseTree: SHA, resultTree: SHA, patchSha256: DIGEST,
      entries: [{ path: 'src/app.txt', mode: '100644', changeKind: 'modified', blobSha: SHA, sha256: DIGEST, size: 4 }] }, files: [], patch: '' } };
  TaskV2ResultResponseSchema.parse(snapshot);
  const checks = [{ text: '함수 이름을 run으로 가정했어요', location: { path: 'src/app.txt', line: 3 } }, { text: '설정은 기본값', location: { path: 'README.md', line: null } }, { text: '위치 없음' }];
  TaskV2ResultResponseSchema.parse({ ...snapshot, checks, risks: [] });
  rejects(TaskV2ResultResponseSchema, { ...snapshot, checks: [{ text: 'x', location: { path: '/abs', line: 1 } }] }, '절대 경로');
  rejects(TaskV2ResultResponseSchema, { ...snapshot, risks: [{ text: 'x', location: { path: 'a', line: 0 } }] }, '줄 0');
  rejects(TaskV2ResultResponseSchema, { ...snapshot, risks: [{ text: '' }] }, '빈 글');
  rejects(TaskV2ResultResponseSchema, { ...snapshot, checks: Array.from({ length: CHANGE_NOTE_LIMITS.items + 1 }, () => ({ text: 'x' })) }, '개수 상한');
  rejects(TaskV2ResultResponseSchema, { ...asked, checks: [] }, 'needs_input에는 확인할 것이 없다');
});
