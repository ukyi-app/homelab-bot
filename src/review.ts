import { createHash, createHmac, randomUUID, timingSafeEqual } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { z } from 'zod';
import { DEFAULTS, Denied, PolicyUnavailable, WorkerRejected } from './contracts.js';
import type { Job, Scope } from './contracts.js';
import type { Database } from './database.js';
import type { Policy, PolicyGate } from './policy.js';
import { DRAIN_MS } from './runtime.js';
import type { Store } from './store.js';
import type { CancelRequest, WorkerSigner } from './worker.js';
import { archiveContract } from './worker.js';
import { CoverageSchema, FindingSchema, InputLimitsSchema, REVIEW_INSTRUCTIONS, REVIEW_INSTRUCTIONS_V2, ReviewOutputSchema, ReviewTaskSchema,
  SECRET_PATTERNS, reviewOutcome } from './review-input.js';
import type { Change, Coverage, ReviewOutput, ReviewTask, ReviewWorkerResult } from './review-input.js';
import { REVIEW_REQUEST_ORGANIZATION } from './review-request.js';
import type { ReviewRequestPort, ReviewRequestRefusal, ReviewRequestResult } from './review-request.js';

// PR_REVIEW 게시 서버 쪽. 모델 호출 전 작성자 확인(D-16), 세대 단위 작업, COMMENT만 게시하는 제한 게시.
const Sha = z.string().regex(/^[a-f0-9]{40}$/);
// owner/repo. 세그먼트가 정확히 `.`·`..`이면 거부한다(경로 조립에서 위로 올라가지 않게).
// 작업자 쪽 REPOSITORY_NAME(src/worker.ts)과 같은 규칙이다. 게시 서버가 작업자 모듈을 불러오지 않게 따로 둔다.
const REPO_NAME = /^(?!\.\.?\/)[A-Za-z0-9_.-]+\/(?!\.\.?$)[A-Za-z0-9_.-]+$/;
const RepoName = z.string().regex(REPO_NAME);
export const ReviewPolicySchema = z.strictObject({
  repositories: z.array(z.strictObject({ id: z.number().int().positive(), fullName: RepoName,
    installationId: z.number().int().positive(), visibility: z.enum(['public', 'private']) })).max(50),
  // 실제 ID는 Infisical runtime policy(review.allowedBotAuthorIds)에만 둔다.
  allowedBotAuthorIds: z.array(z.number().int().positive()).max(20),
  commentCommand: z.string().trim().min(1).max(100).nullable(),
  reviewDrafts: z.boolean(), rereviewOnBaseMove: z.boolean().nullable(),
  // 비교 기준(운영 값 merge_base, DECISIONS "T17 결정"). null이면 리뷰 경로를 닫는다.
  comparison: z.enum(['merge_base', 'base_head']).nullable(),
  reviewSince: z.number().int().nonnegative(), internalMarkers: z.array(z.string().min(4).max(200)).max(100),
  input: InputLimitsSchema,
  publish: z.strictObject({ maxFindings: z.number().int().positive().max(50),
    maxInlineComments: z.number().int().nonnegative().max(50), maxBodyChars: z.number().int().positive().max(65_536) }).nullable(),
  reconcile: z.strictObject({ maxPages: z.number().int().positive().max(10), maxReviewsPerRun: z.number().int().positive().max(20) }),
});
export type ReviewPolicy = z.infer<typeof ReviewPolicySchema>;
export interface ReviewContext { base: Policy; review: ReviewPolicy; revision: string }
export const MODEL_CALL_ASSOCIATIONS = Object.freeze(['OWNER', 'MEMBER', 'COLLABORATOR']);
// 게시 서버가 작업자에 보내는 리뷰 지시문. 작업자 요청의 literal이라 작업자가 이 판을 받게 먼저 배포돼 있어야 한다(명세 §4.2).
export const SERVER_REVIEW_INSTRUCTIONS = REVIEW_INSTRUCTIONS_V2;
// 권한 필드(허용 목록·저장소)는 매번 다시 검사하므로 세대 revision에는 리뷰 내용에 닿는 값만 넣는다.
export function reviewRevision(review: ReviewPolicy, instructions: string = SERVER_REVIEW_INSTRUCTIONS): string {
  return `rp-${createHash('sha256').update(JSON.stringify([instructions, review.input, review.comparison])).digest('hex').slice(0, 16)}`;
}
// 출력 스키마가 같고 말투만 다른 지시문 판들. 이 판끼리만 다른 revision(입력 상한·비교 기준이 같음)으로 이미 나온 결과는 버리지 않는다.
// 게시 대기 결과는 지금 렌더로 게시하고, 같은 head에 그런 결과가 있으면 자동 이벤트로 다시 리뷰하지 않는다(DECISIONS "C12 PR 리뷰 말투").
// 모델을 아직 부르지 않은 작업은 이 규칙과 무관하게 policy_changed로 닫고 새 지시문으로 새 세대를 만든다.
const VOICE_ONLY_INSTRUCTIONS = Object.freeze([REVIEW_INSTRUCTIONS, REVIEW_INSTRUCTIONS_V2]);
const sameReviewContent = (revision: string, context: ReviewContext) =>
  revision === context.revision || VOICE_ONLY_INSTRUCTIONS.some(instructions => reviewRevision(context.review, instructions) === revision);
// 리뷰 정책이 없거나 비교 기준을 정하지 않은 값(comparison null)이면 새 요청만 받지 않는다. 철회(Denied)가 아니라
// 일시 상태로 다뤄, 대기 작업과 미게시 결과를 지우지 않고 다시 켜질 때까지 기다린다.
export class ReviewDisabled extends PolicyUnavailable {}
export class ReviewPolicySource {
  constructor(private readonly gate: PolicyGate) {}
  async current(): Promise<ReviewContext> {
    const base = await this.gate.current();
    const parsed = ReviewPolicySchema.safeParse(base.review);
    if (!parsed.success || parsed.data.comparison === null) throw new ReviewDisabled();
    return { base, review: parsed.data, revision: reviewRevision(parsed.data) };
  }
}

const User = z.object({ id: z.number().int().positive(), login: z.string(), type: z.string() });
const Repo = z.object({ id: z.number().int().positive(), full_name: z.string() });
const PullSchema = z.object({
  number: z.number().int().positive(), state: z.enum(['open', 'closed']), draft: z.boolean().default(false),
  merged: z.boolean().nullable().optional(), merged_at: z.string().nullable().optional(),
  title: z.string(), body: z.string().nullable(), user: User, author_association: z.string(), updated_at: z.string(),
  head: z.object({ sha: Sha, ref: z.string(), repo: Repo.nullable() }),
  base: z.object({ sha: Sha, ref: z.string(), repo: Repo }),
});
export interface PullRequest {
  number: number; open: boolean; merged: boolean; draft: boolean; title: string; body: string;
  author: { id: number; type: string; association: string }; updatedAt: number;
  head: { sha: string; repoId: number | null }; base: { sha: string; ref: string; repoId: number };
}
export function pullRequest(raw: unknown): PullRequest {
  const p = PullSchema.parse(raw);
  const updatedAt = Date.parse(p.updated_at);
  if (!Number.isFinite(updatedAt)) throw new Error('invalid_pull_request');
  return { number: p.number, open: p.state === 'open', merged: !!p.merged || !!p.merged_at, draft: p.draft,
    title: p.title, body: p.body ?? '', author: { id: p.user.id, type: p.user.type, association: p.author_association },
    updatedAt, head: { sha: p.head.sha, repoId: p.head.repo?.id ?? null }, base: { sha: p.base.sha, ref: p.base.ref, repoId: p.base.repo.id } };
}
const Installation = z.object({ id: z.number().int().positive() });
const PullEvent = z.object({ action: z.string(), pull_request: z.unknown(), repository: Repo, installation: Installation,
  changes: z.object({ base: z.object({}).passthrough().optional() }).passthrough().optional() });
const CommentEvent = z.object({ action: z.string(), repository: Repo, installation: Installation,
  issue: z.object({ number: z.number().int().positive(), pull_request: z.object({}).passthrough().optional() }),
  comment: z.object({ id: z.number().int().positive(), body: z.string(), user: User, author_association: z.string() }) });

type Decision = { outcome: 'denied' | 'ignored'; reason: string };
type Outcome = { outcome: string; reason?: string; key?: string };
// D-16 하위 결정. 표시 이름·본문·댓글 지시는 보지 않고, 숫자 ID와 association만 본다.
export function authorAllowed(author: PullRequest['author'], review: ReviewPolicy): boolean {
  if (author.type === 'Bot') return review.allowedBotAuthorIds.includes(author.id);
  return MODEL_CALL_ASSOCIATIONS.includes(author.association);
}
export function pullRequestDecision(pr: PullRequest, repo: ReviewPolicy['repositories'][number], review: ReviewPolicy,
  explicit = false): Decision | undefined {
  if (pr.base.repoId !== repo.id) return { outcome: 'denied', reason: 'repository_mismatch' };
  // head 저장소가 지워진 fork는 head.repo가 null이다. 같은 저장소임을 확인할 수 없으면 fork로 본다.
  if (pr.head.repoId !== pr.base.repoId) return { outcome: 'denied', reason: 'fork' };
  if (!authorAllowed(pr.author, review)) return { outcome: 'denied', reason: 'author_denied' };
  if (!pr.open) return { outcome: 'ignored', reason: pr.merged ? 'pr_merged' : 'pr_closed' };
  if (pr.draft && !explicit && !review.reviewDrafts) return { outcome: 'ignored', reason: 'draft_waiting' };
  return undefined;
}
export function verifySignature(secret: string, raw: Buffer, header: string | undefined): boolean {
  if (!secret || !header || !/^sha256=[a-f0-9]{64}$/.test(header)) return false;
  const expected = Buffer.from(`sha256=${createHmac('sha256', secret).update(raw).digest('hex')}`);
  return timingSafeEqual(expected, Buffer.from(header));
}

export class GitHubError extends Error {
  constructor(public readonly status: number, public readonly retryAfterMs = 0) { super(`github_${status}`); }
}
// 게시 서버가 리뷰 App 토큰으로 읽는 자리. 작업자에는 없다(D-15).
export interface GitHubReader {
  pullRequest(repository: string, number: number): Promise<unknown>;
  openPullRequests(repository: string, page: number): Promise<unknown[]>;
  // base와 head 두 커밋 사이의 정확한 변경 목록(two-dot). merge_base 기준이면 compare API 결과와 같다.
  compare(repository: string, base: string, head: string): Promise<unknown>;
  mergeBase(repository: string, base: string, head: string): Promise<unknown>;
  reviews(repository: string, number: number, page: number): Promise<unknown[]>;
}
const CompareSchema = z.strictObject({ files: ReviewTaskSchema.shape.changes, truncated: z.boolean() });
const RemoteReview = z.object({ id: z.number().int(), commit_id: z.string().nullable(), body: z.string().nullable() });
const ReviewWriteSchema = z.strictObject({
  method: z.literal('POST'), path: z.string().regex(/^\/repos\/(?!\.\.?\/)[A-Za-z0-9_.-]+\/(?!\.\.?\/)[A-Za-z0-9_.-]+\/pulls\/[1-9]\d*\/reviews$/),
  body: z.strictObject({ commit_id: Sha, event: z.literal('COMMENT'), body: z.string().min(1).max(65_536),
    comments: z.array(z.strictObject({ path: z.string().min(1), line: z.number().int().positive(), side: z.literal('RIGHT'),
      body: z.string().min(1).max(65_536) })).max(50) }),
});
export type GitHubWrite = z.infer<typeof ReviewWriteSchema>;
export type GitHubTransport = (request: GitHubWrite) => Promise<{ id: number }>;
// REVIEW-04: 쓰기는 이 함수만 통과한다. APPROVE·REQUEST_CHANGES·PENDING(event 없음)·dismiss·merge·auto-merge·PR 수정은
// 모양부터 맞지 않아 거부되고, 대상 저장소·PR·검토 head SHA까지 고정한다.
export function restrictGitHubWrite(request: unknown, expected: { repository: string; pr: number; head: string }): GitHubWrite {
  const parsed = ReviewWriteSchema.safeParse(request);
  if (!parsed.success || parsed.data.path !== `/repos/${expected.repository}/pulls/${expected.pr}/reviews`
    || parsed.data.body.commit_id !== expected.head) throw new Denied();
  return parsed.data;
}
export class RestrictedGitHub {
  constructor(private readonly transport: GitHubTransport) {}
  async createReview(request: unknown, expected: { repository: string; pr: number; head: string }): Promise<{ id: number }> {
    return this.transport(restrictGitHubWrite(request, expected));
  }
}

export interface ReviewRow {
  job_id: string; generation_key: string; installation_id: string; repo_id: string; repo_full_name: string;
  pr_number: number; head_sha: string; comparison_revision: string; base_ref: string; policy_revision: string;
  trigger: string; pr_updated_at: string; review_outcome: string | null; result: ReviewResult | null;
  superseded_reason: string | null; superseded_at: string | null; request_target: unknown;
}
export type ReviewTarget = ReviewPolicy['repositories'][number];
const ReviewTargetSchema = ReviewPolicySchema.shape.repositories.element;
const requestTarget = (repo: ReviewTarget): ReviewTarget =>
  ({ id: repo.id, fullName: repo.fullName, installationId: repo.installationId, visibility: repo.visibility });
// 정책 목록 밖 저장소의 리뷰 요청 대상(C30). 그 세대 행의 저장소·설치와 같고 조직 저장소일 때만 쓴다.
// 이 기록은 그 세대의 작업 하나에만 범위를 준다. 정책 목록·폴링 대조·webhook 저장소 검사에는 쓰지 않는다.
export function requestedRepository(row: { request_target: unknown; repo_id: string | number; repo_full_name: string;
  installation_id: string | number }): ReviewTarget | undefined {
  const parsed = ReviewTargetSchema.safeParse(typeof row.request_target === 'string' ? JSON.parse(row.request_target) : row.request_target);
  if (!parsed.success) return;
  const target = parsed.data;
  if (target.fullName.split('/')[0]!.toLowerCase() !== REVIEW_REQUEST_ORGANIZATION) return;
  return String(target.id) === String(row.repo_id) && target.fullName === row.repo_full_name
    && String(target.installationId) === String(row.installation_id) ? target : undefined;
}
type Admission = { outcome: 'queued' | 'requeued' | 'resumed' | 'duplicate_generation' | 'stale_event' | 'base_moved' | 'instructions_only';
  key: string; job?: string };
export const generationKey = (repo: number, pr: number, head: string, comparison: string, policy: string) =>
  `github:review:${repo}:${pr}:${head}:${comparison}:${policy}`;
const json = (value: unknown) => JSON.stringify(value);
export class ReviewQueue {
  constructor(private readonly store: Store, private readonly reader: GitHubReader) {}
  // 비교 기준 SHA. merge_base는 GitHub "Files changed"와 같은 diff이고 base 머리가 앞서가도 바뀌지 않는다.
  async comparison(repository: string, pr: PullRequest, review: ReviewPolicy): Promise<string> {
    if (review.comparison === 'base_head') return pr.base.sha;
    return Sha.parse(await this.reader.mergeBase(repository, pr.base.sha, pr.head.sha));
  }
  // 게이트 → 비교 기준 조회 → 세대 등록. 조회가 실패하면 모델 작업을 만들지 않는다.
  async admitLive(pr: PullRequest, repo: ReviewPolicy['repositories'][number], context: ReviewContext, trigger: string,
    deliveryId = `${trigger}:${randomUUID()}`): Promise<Admission | Decision> {
    const decision = pullRequestDecision(pr, repo, context.review, trigger === 'comment');
    if (decision) return decision;
    let comparison: string;
    try { comparison = await this.comparison(repo.fullName, pr, context.review); }
    catch { return { outcome: 'denied', reason: 'comparison_lookup_failed' }; }
    return this.store.db.transaction(tx => this.admit(pr, repo, context, comparison, trigger, deliveryId, tx));
  }
  // 세대 키 (repo_id, pr, head_sha, comparison_revision, policy_revision)로 작업 한 건만 만든다(EVENT-01).
  // request: Discord 리뷰 요청(C30). 입력 이벤트에 출처를 남기고, outside면 정책 목록 밖 저장소라 그 세대에 대상 기록을 둔다.
  async admit(pr: PullRequest, repo: ReviewPolicy['repositories'][number], context: ReviewContext, comparison: string,
    trigger: string, deliveryId: string, tx: Database, request?: { outside: boolean }): Promise<Admission | Decision> {
    const decision = pullRequestDecision(pr, repo, context.review, trigger === 'comment');
    if (decision) return decision;
    const now = this.store.now();
    await tx.query(`INSERT INTO controls VALUES ('review_admission','false') ON CONFLICT DO NOTHING`);
    await tx.query(`SELECT * FROM controls WHERE key='review_admission' FOR UPDATE`);
    const key = generationKey(repo.id, pr.number, pr.head.sha, comparison, context.revision);
    // 행을 먼저 잠그고 다음 문장에서 읽는다. finish가 같은 행을 잠그므로, 실행 중으로 읽고 밀려남을 풀었는데
    // 그 사이 finish가 게시 행 없이 끝나 결과가 영영 게시되지 못하는 순서를 막는다.
    await tx.query('SELECT job_id FROM pr_reviews WHERE generation_key=$1 FOR UPDATE', [key]);
    const existing = (await tx.query<{ job_id: string; state: string; attempt: number; superseded_at: string | null; delivered: boolean;
      held: boolean; blocked: boolean; result: ReviewResult | null; head_sha: string; comparison_revision: string; policy_revision: string }>(
      `SELECT p.job_id,j.state,j.attempt,p.superseded_at,p.result,p.head_sha,p.comparison_revision,p.policy_revision,
        EXISTS (SELECT 1 FROM review_deliveries d WHERE d.job_id=p.job_id AND d.state IN ('pending','sending','sent','unknown')) AS delivered,
        EXISTS (SELECT 1 FROM review_deliveries d WHERE d.job_id=p.job_id AND d.state='superseded') AS held,
        EXISTS (SELECT 1 FROM review_deliveries d WHERE d.job_id=p.job_id AND d.state='blocked') AS blocked
      FROM pr_reviews p JOIN jobs j ON j.id=p.job_id WHERE p.generation_key=$1`, [key])).rows[0];
    // 정책에서 빠진 저장소의 옛 세대를 리뷰 요청이 되살리면, 실행·게시가 그 세대를 쓸 수 있게 대상 기록을 채운다.
    if (existing && request?.outside) await tx.query('UPDATE pr_reviews SET request_target=COALESCE(request_target,$2) WHERE job_id=$1',
      [existing.job_id, json(requestTarget(repo))]);
    // 같은 세대의 공개 가능한 결과가 이미 있는데 닫힘·draft·게시 직전 상태 변화로 게시만 못 했으면, 모델을 다시 부르지 않고
    // 그 결과의 게시를 이어간다(세대가 같으면 head·base·정책이 같아 결과가 유효하다).
    const resume = !!existing && existing.state === 'succeeded' && existing.result?.output_classification === 'public'
      && !existing.delivered && !existing.blocked && (existing.superseded_at !== null || existing.held);
    // 대기·진행·게시된 같은 세대는 다시 넣지 않는다(직렬 1개, D-14). 닫힘·draft·옛 이벤트로 밀려나 게시되지 못한 세대가
    // 다시 live가 됐거나, 명시 요청이 확인된 실패·취소를 다시 부를 때만 같은 작업을 되살린다. 세대당 시도는 재시도 한도로 묶는다.
    const revive = existing && !resume && existing.attempt <= DEFAULTS.maxRetries && (existing.state === 'superseded'
      || (existing.state === 'succeeded' && existing.superseded_at !== null && !existing.delivered)
      || (trigger === 'comment' && ['failed', 'cancelled'].includes(existing.state)));
    const latest = (await tx.query<ReviewRow>(`SELECT * FROM pr_reviews WHERE repo_id=$1 AND pr_number=$2
      ORDER BY pr_updated_at DESC,created_at DESC LIMIT 1`, [repo.id, pr.number])).rows[0];
    const stale = !!latest && Number(latest.pr_updated_at) > pr.updatedAt;
    if (existing && !revive && !resume) {
      // 아직 끝나지 않은 작업이 닫힘·draft·새 세대로 밀려나 있으면 finish가 결과를 버린다. 명시 요청은 이 세대를 다시 현재로 되돌린다.
      const rejoin = trigger === 'comment' && !stale && existing.superseded_at !== null
        && ['queued', 'running', 'verifying', 'waiting_user'].includes(existing.state);
      if (rejoin) await this.supersede(tx, repo.id, pr.number, 'new_generation', key);
      // 같은 세대라도 더 새 이벤트(재개·draft 해제 등)를 봤다는 사실은 남긴다. 늦게 온 옛 닫힘·draft가 이 시각과 비교된다.
      // 명시 요청은 draft 예외의 근거이므로 승격하고, 뒤따르는 자동 이벤트가 낮추지 못한다.
      await tx.query(`UPDATE pr_reviews SET pr_updated_at=GREATEST(pr_updated_at,$2),trigger=CASE WHEN $3='comment' THEN 'comment' ELSE trigger END,
        superseded_at=CASE WHEN $4::boolean THEN NULL ELSE superseded_at END,superseded_reason=CASE WHEN $4::boolean THEN NULL ELSE superseded_reason END,
        review_outcome=CASE WHEN $4::boolean THEN NULL ELSE review_outcome END WHERE job_id=$1`, [existing.job_id, pr.updatedAt, trigger, rejoin]);
      return { outcome: 'duplicate_generation', key, job: existing.job_id };
    }
    // 늦게 도착한 옛 이벤트가 새 세대를 밀어내지 않게 한다. 실행 직전 live 조회가 한 번 더 막는다.
    if (stale) return { outcome: 'stale_event', key };
    if (existing && resume) {
      await this.supersede(tx, repo.id, pr.number, 'new_generation', key);
      const result = existing.result!;
      const outcome = reviewOutcome(result.coverage);
      await tx.query(`UPDATE pr_reviews SET review_outcome=$2,result=$3,superseded_at=NULL,superseded_reason=NULL,
        pr_updated_at=GREATEST(pr_updated_at,$4),trigger=CASE WHEN $5='comment' THEN 'comment' ELSE trigger END WHERE job_id=$1`,
      [existing.job_id, outcome, json({ ...result, review_outcome: outcome }), pr.updatedAt, trigger]);
      const reopened = await tx.query(`UPDATE review_deliveries SET state='pending',reason=NULL,attempt=0,pause_count=0,dispatch_started=false,
        available_at=$2,lease_token=NULL,lease_until=NULL WHERE id=(SELECT id FROM review_deliveries WHERE job_id=$1 AND state='superseded'
        ORDER BY created_at DESC LIMIT 1) RETURNING id`, [existing.job_id, now]);
      // 실행 중 밀려 게시 행이 없었으면 새로 만든다. 본문은 게시 직전 현재 정책으로 다시 렌더링된다.
      if (!reopened.rows.length) await tx.query(`INSERT INTO review_deliveries(id,job_id,idempotency_key,repo_id,repo_full_name,pr_number,
        head_sha,comparison_revision,policy_revision,body,comments,state,available_at,created_at)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,'','[]','pending',$10,$10) ON CONFLICT (idempotency_key) DO NOTHING`,
      [randomUUID(), existing.job_id, `github-review:${existing.job_id}:${existing.attempt}`, repo.id, repo.fullName, pr.number,
        existing.head_sha, existing.comparison_revision, existing.policy_revision, now]);
      return { outcome: 'resumed', key, job: existing.job_id };
    }
    if (existing) {
      const queued = (await tx.query<{ count: string }>("SELECT count(*) FROM jobs WHERE state='queued'")).rows[0]!;
      if (Number(queued.count) >= DEFAULTS.maxQueue) throw new Error('queue_full');
      await this.supersede(tx, repo.id, pr.number, 'new_generation', key);
      await tx.query(`UPDATE jobs SET state='queued',available_at=$2,wait_reason=NULL,finished_at=NULL,lease_token=NULL,lease_until=NULL
        WHERE id=$1 AND state IN ('superseded','failed','cancelled','succeeded')`, [existing.job_id, now]);
      // 되살린 이유(댓글 명시 요청 등)가 draft 예외 판단에 쓰이므로 trigger도 바꾼다.
      await tx.query(`UPDATE pr_reviews SET review_outcome=NULL,result=NULL,superseded_at=NULL,superseded_reason=NULL,pr_updated_at=$2,
        trigger=$3,defer_count=0 WHERE job_id=$1`, [existing.job_id, pr.updatedAt, trigger]);
      return { outcome: 'requeued', key, job: existing.job_id };
    }
    // 지시문 판만 바뀌었고 같은 head·비교 기준의 결과가 게시됐거나 게시를 기다리면 자동 이벤트로는 다시 리뷰하지 않는다.
    // 배포 순간 열린 PR마다 새 세대가 생겨 모델 호출이 몰리는 것을 막는다. 댓글 명시 요청과 base 재지정은 늘 새 세대다.
    if (trigger !== 'comment' && trigger !== 'retarget') {
      const kept = (await tx.query<{ job_id: string; policy_revision: string }>(`SELECT p.job_id,p.policy_revision FROM pr_reviews p
        WHERE p.repo_id=$1 AND p.pr_number=$2 AND p.head_sha=$3 AND p.comparison_revision=$4 AND p.policy_revision<>$5
        AND EXISTS (SELECT 1 FROM review_deliveries d WHERE d.job_id=p.job_id AND d.state IN ('pending','sending','sent','unknown'))`,
      [repo.id, pr.number, pr.head.sha, comparison, context.revision])).rows.filter(row => sameReviewContent(row.policy_revision, context));
      if (kept.length) {
        // duplicate_generation과 같이 더 새 이벤트를 봤다는 시각을 남긴다. 늦게 온 옛 닫힘·draft가 이 시각과 비교되어 남긴 결과를 지우지 못한다.
        await tx.query('UPDATE pr_reviews SET pr_updated_at=GREATEST(pr_updated_at,$2) WHERE job_id = ANY($1::text[])',
          [kept.map(row => row.job_id), pr.updatedAt]);
        return { outcome: 'instructions_only', key };
      }
    }
    const baseOnly = latest && latest.head_sha === pr.head.sha && latest.comparison_revision !== comparison
      && latest.policy_revision === context.revision;
    // base만 움직였을 때 재리뷰를 건너뛰는 것은 이전 세대가 이미 게시됐거나 확인된 실패로 끝났을 때뿐이다.
    // 아직 리뷰가 한 번도 게시되지 않은 PR을 base 이동으로 버리지 않는다.
    // 게시됐거나(차단 포함), 공개 범위 검사에서 막혔거나, 확인된 실패거나, 같은 head에서 이미 두 번 리뷰했으면 끝난 것으로 본다.
    // base 머리 기준에서 base가 자주 움직여도 같은 head의 모델 호출이 계속 늘지 않게 한다.
    const head = latest ? (await tx.query<{ failed: boolean; restricted: boolean; published: boolean; blocked: boolean; results: string }>(
      `SELECT bool_or(p.job_id=$4 AND j.state='failed') AS failed,
        bool_or(p.result->>'output_classification'='restricted') AS restricted,
        bool_or(EXISTS (SELECT 1 FROM review_deliveries d WHERE d.job_id=p.job_id AND d.state IN ('sending','sent','unknown'))) AS published,
        bool_or(EXISTS (SELECT 1 FROM review_deliveries d WHERE d.job_id=p.job_id AND d.state='blocked')) AS blocked,
        count(p.result) AS results
      FROM pr_reviews p JOIN jobs j ON j.id=p.job_id WHERE p.repo_id=$1 AND p.pr_number=$2 AND p.head_sha=$3`,
    [repo.id, pr.number, pr.head.sha, latest.job_id])).rows[0] : undefined;
    const capped = !!head && Number(head.results) >= 2;
    const concluded = !!head && (!!head.failed || !!head.restricted || !!head.published || !!head.blocked || capped);
    const rereview = !baseOnly || !concluded || trigger === 'retarget' || trigger === 'comment' || context.review.rereviewOnBaseMove === true;
    if (rereview) {
      const queued = (await tx.query<{ count: string }>("SELECT count(*) FROM jobs WHERE state='queued'")).rows[0]!;
      if (Number(queued.count) >= DEFAULTS.maxQueue) throw new Error('queue_full');
    }
    const reason = baseOnly ? 'base_moved' : latest && latest.head_sha === pr.head.sha ? 'policy_changed' : 'new_head';
    await this.supersede(tx, repo.id, pr.number, reason, key);
    if (!rereview) {
      // 상한 때문에 한 번도 게시하지 못한 채 멈추면 조용히 사라지지 않게 알린다. 모델 문장은 넣지 않는다.
      if (capped && !head!.published && !head!.blocked && !head!.restricted && !head!.failed) {
        const scope = notificationScope(context.base);
        await this.store.enqueue({ key: `review-unpublished:${repo.id}:${pr.number}:${pr.head.sha}`, actor: context.base.owner, scope,
          revision: context.base.revision, payload: { kind: 'message', channel: scope.channel, classification: 'safe_summary',
            content: `PR 리뷰를 게시하지 못했습니다: ${repo.fullName}#${pr.number}, head ${pr.head.sha.slice(0, 12)}. `
              + 'base가 움직여 결과가 오래됐고 같은 head의 재리뷰 상한에 걸렸습니다. 리뷰 명령 댓글로 다시 요청할 수 있습니다.' } }, tx);
      }
      return { outcome: 'base_moved', key };
    }
    const event = randomUUID(), job = randomUUID();
    await tx.query(`INSERT INTO events(id,provider,delivery_id,semantic_key,actor_id,scope,conversation_id,received_at,payload,accepted)
      VALUES ($1,'github',$2,$3,$4,$5,NULL,$6,$7,true)`, [event, deliveryId, key, `github:${pr.author.id}`,
      json({ kind: 'github', repo: repo.id, pr: pr.number }), now, json({ command: 'review', trigger, ...(request ? { source: 'discord' } : {}) })]);
    await tx.query(`INSERT INTO jobs(id,event_id,conversation_id,type,owner_id,target,revision,budget,priority,available_at,created_at)
      VALUES ($1,$2,NULL,'review','github-review',$3,$4,$5,40,$6,$6)`, [job, event, json({ kind: 'github', repo: repo.id, pr: pr.number }),
      json({ policy: context.revision, head: pr.head.sha, comparison }),
      json({ timeoutMs: DEFAULTS.taskTimeoutMs, toolCalls: 0 }), now]);
    await tx.query(`INSERT INTO pr_reviews(job_id,generation_key,installation_id,repo_id,repo_full_name,pr_number,head_sha,
      comparison_revision,base_ref,policy_revision,trigger,pr_updated_at,created_at,request_target) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)`,
    [job, key, repo.installationId, repo.id, repo.fullName, pr.number, pr.head.sha, comparison, pr.base.ref, context.revision,
      trigger, pr.updatedAt, now, request?.outside ? json(requestTarget(repo)) : null]);
    return { outcome: 'queued', key, job };
  }
  // 닫힘·draft 이벤트도 admission과 같은 잠금·시각 검사를 거친다. 기록보다 오래된 이벤트는 최신 세대를 지우지 못한다.
  async close(tx: Database, repo: number, pr: PullRequest, reason: string, keepExplicit = false): Promise<{ outcome: string; reason: string }> {
    await tx.query(`INSERT INTO controls VALUES ('review_admission','false') ON CONFLICT DO NOTHING`);
    await tx.query(`SELECT * FROM controls WHERE key='review_admission' FOR UPDATE`);
    const latest = (await tx.query<{ updated: string | null }>('SELECT max(pr_updated_at) AS updated FROM pr_reviews WHERE repo_id=$1 AND pr_number=$2',
      [repo, pr.number])).rows[0]?.updated;
    if (latest !== null && latest !== undefined && Number(latest) > pr.updatedAt) return { outcome: 'stale_event', reason };
    await this.supersede(tx, repo, pr.number, reason, '', keepExplicit);
    return { outcome: 'superseded', reason };
  }
  // 새 세대·닫힘·병합이면 대기 작업과 미게시 결과를 superseded로. 실행 중인 작업은 끝날 때 결과가 superseded로 남는다.
  // keepExplicit이면 댓글 명시 요청 세대는 남긴다(draft 대기의 예외).
  async supersede(tx: Database, repo: number, pr: number, reason: string, except = '', keepExplicit = false): Promise<void> {
    const now = this.store.now();
    await tx.query(`UPDATE jobs SET state='superseded',wait_reason=$4,finished_at=$5 WHERE state='queued' AND id IN
      (SELECT job_id FROM pr_reviews WHERE repo_id=$1 AND pr_number=$2 AND generation_key<>$3 AND NOT ($6::boolean AND trigger='comment'))`,
    [repo, pr, except, reason, now, keepExplicit]);
    await tx.query(`UPDATE review_deliveries SET state='superseded',reason=$3 WHERE repo_id=$1 AND pr_number=$2 AND state='pending'
      AND NOT ($4::boolean AND job_id IN (SELECT job_id FROM pr_reviews WHERE trigger='comment'))`, [repo, pr, reason, keepExplicit]);
    await tx.query(`UPDATE pr_reviews SET superseded_at=$4,superseded_reason=$5,
      review_outcome=CASE WHEN review_outcome IS NULL OR review_outcome IN ('completed','partial') THEN 'superseded' ELSE review_outcome END
      WHERE repo_id=$1 AND pr_number=$2 AND generation_key<>$3 AND superseded_at IS NULL AND NOT ($6::boolean AND trigger='comment')`,
    [repo, pr, except, now, reason, keepExplicit]);
  }
}

// 정책 목록 밖 조직 저장소를 리뷰 App으로 찾는 자리(github-review-io.ts). 설치가 없으면 null이다.
export interface ReviewTargetReader {
  repository(fullName: string): Promise<ReviewTarget | null>;
  pullRequest(target: ReviewTarget, number: number): Promise<unknown>;
  mergeBase(target: ReviewTarget, base: string, head: string): Promise<unknown>;
}
const REQUEST_REFUSALS: Readonly<Record<string, ReviewRequestRefusal>> = Object.freeze({
  fork: 'fork', author_denied: 'author', pr_closed: 'closed', pr_merged: 'closed', repository_mismatch: 'not_found',
});
// Discord 리뷰 요청(COLLEAGUE_SPEC §4.10)을 PR 댓글 리뷰 명령과 같은 명시 트리거('comment': draft 예외, 늘 새 세대, 대체에서 보호)로
// 접수한다. 조직 밖이면 GitHub에 묻지 않는다. 정책 목록의 저장소는 정책 기록을, 목록 밖이면 리뷰 App 설치 조회 기록을 쓴다.
// fork·작성자 association·닫힘 판단(pullRequestDecision)은 자동 리뷰와 같다.
export class ReviewRequests implements ReviewRequestPort {
  constructor(private readonly store: Store, private readonly policy: ReviewPolicySource, private readonly queue: ReviewQueue,
    private readonly reader: GitHubReader, private readonly targets: ReviewTargetReader) {}
  async request(input: { repository: string; pr: number; key: string }): Promise<ReviewRequestResult> {
    const result = await this.resolve(input.repository, input.pr, input.key);
    await this.store.audit('review_requested', input.key, { repository: input.repository, pr: input.pr, outcome: result.outcome,
      ...(result.outcome === 'refused' ? { reason: result.reason } : {}) });
    return result;
  }
  private async resolve(repository: string, number: number, key: string): Promise<ReviewRequestResult> {
    const refused = (reason: ReviewRequestRefusal) => ({ outcome: 'refused', reason }) as const;
    if (repository.split('/')[0]!.toLowerCase() !== REVIEW_REQUEST_ORGANIZATION) return refused('outside_organization');
    if (!REPO_NAME.test(repository)) return refused('not_found');
    let context: ReviewContext;
    try { context = await this.policy.current(); } catch (error) {
      if (error instanceof PolicyUnavailable) return refused('unavailable');
      throw error;
    }
    const listed = context.review.repositories.find(r => r.fullName.toLowerCase() === repository.toLowerCase());
    let repo: ReviewTarget, pr: PullRequest, comparison: string;
    try {
      const found = listed ?? await this.targets.repository(repository);
      if (!found) return refused('not_installed');
      repo = found;
      pr = pullRequest(listed ? await this.reader.pullRequest(repo.fullName, number) : await this.targets.pullRequest(repo, number));
      const decision = pullRequestDecision(pr, repo, context.review, true);
      if (decision) return refused(REQUEST_REFUSALS[decision.reason] ?? 'unavailable');
      comparison = context.review.comparison === 'base_head' ? pr.base.sha : Sha.parse(listed
        ? await this.reader.mergeBase(repo.fullName, pr.base.sha, pr.head.sha) : await this.targets.mergeBase(repo, pr.base.sha, pr.head.sha));
    } catch (error) {
      // 조회 실패면 모델 작업을 만들지 않는다. 원인은 답에 싣지 않는다.
      return refused(error instanceof GitHubError && error.status === 404 ? 'not_found' : 'unavailable');
    }
    let admitted: Admission | Decision;
    try {
      admitted = await this.store.db.transaction(tx => this.queue.admit(pr, repo, context, comparison, 'comment', `discord:${key}`, tx,
        { outside: !listed }));
    } catch (error) {
      if (error instanceof Error && error.message === 'queue_full') return refused('unavailable');
      throw error;
    }
    if (admitted.outcome === 'denied' || admitted.outcome === 'ignored') return refused(REQUEST_REFUSALS[admitted.reason] ?? 'unavailable');
    if (admitted.outcome === 'stale_event') return refused('unavailable');
    const started = ['queued', 'requeued', 'resumed'].includes(admitted.outcome);
    return { outcome: started ? 'started' : 'already', repository: repo.fullName, pr: pr.number };
  }
}

const MAX_WEBHOOK_BYTES = 1_048_576;
export interface IngressResult { status: number; outcome: string; reason?: string }
export class GitHubIngress {
  constructor(private readonly secret: string, private readonly store: Store, private readonly policy: ReviewPolicySource,
    private readonly queue: ReviewQueue, private readonly reader: GitHubReader) {}
  async receive(headers: Record<string, string | undefined>, raw: Buffer): Promise<IngressResult> {
    // 원본 바이트로 서명을 먼저 본다. 실패하면 아무것도 저장하지 않는다.
    if (!verifySignature(this.secret, raw, headers['x-hub-signature-256'])) return { status: 401, outcome: 'rejected', reason: 'signature' };
    const delivery = headers['x-github-delivery'], event = headers['x-github-event'];
    if (!delivery || !/^[A-Za-z0-9-]{1,100}$/.test(delivery) || !event || !/^[a-z_]{1,50}$/.test(event)) return { status: 400, outcome: 'rejected', reason: 'headers' };
    let payload: unknown;
    try { payload = JSON.parse(raw.toString('utf8')); } catch { return { status: 400, outcome: 'rejected', reason: 'json' }; }
    if ((await this.store.db.query('SELECT 1 FROM github_deliveries WHERE delivery_id=$1', [delivery])).rows.length) return { status: 200, outcome: 'duplicate_delivery' };
    let context: ReviewContext;
    try { context = await this.policy.current(); }
    catch (error) {
      if (error instanceof ReviewDisabled) return this.record(delivery, event, null, { outcome: 'ignored', reason: 'review_disabled' });
      return { status: 503, outcome: 'policy_unavailable' };
    }
    if (event === 'pull_request') {
      const parsed = PullEvent.safeParse(payload);
      if (!parsed.success) return { status: 400, outcome: 'rejected', reason: 'payload' };
      const e = parsed.data;
      const repo = this.repository(context, e.repository.id, e.installation.id);
      if (!repo) return this.record(delivery, event, e, { outcome: 'denied', reason: 'installation_or_repository' });
      let pr: PullRequest;
      try { pr = pullRequest(e.pull_request); } catch { return { status: 400, outcome: 'rejected', reason: 'payload' }; }
      const target = { ...e, pr: pr.number };
      // draft 전환은 draft 대기 정책이 막는 세대만 정리한다. 실행 직전·게시 직전 판단(pullRequestDecision·게시자)과 같은 규칙이다.
      if (e.action === 'converted_to_draft' && context.review.reviewDrafts) {
        return this.record(delivery, event, target, { outcome: 'ignored', reason: 'draft_allowed' });
      }
      if (e.action === 'closed' || e.action === 'converted_to_draft') {
        const draft = e.action === 'converted_to_draft';
        const reason = draft ? 'draft' : pr.merged ? 'merged_before_review' : 'pr_closed';
        return this.record(delivery, event, target, tx => this.queue.close(tx, repo.id, pr, reason, draft));
      }
      const trigger = ['opened', 'reopened', 'ready_for_review', 'synchronize'].includes(e.action) ? e.action
        : e.action === 'edited' && e.changes?.base ? 'retarget' : undefined;
      if (!trigger) return this.record(delivery, event, target, { outcome: 'ignored', reason: `action_${e.action}`.slice(0, 60) });
      return this.enqueue(delivery, event, target, pr, repo, context, trigger);
    }
    if (event === 'issue_comment') {
      const parsed = CommentEvent.safeParse(payload);
      if (!parsed.success) return { status: 400, outcome: 'rejected', reason: 'payload' };
      const e = parsed.data;
      const target = { ...e, pr: e.issue.number };
      // 자기 리뷰·Codex 댓글이 다시 리뷰를 부르지 않게 Bot 댓글은 내용과 무관하게 무시한다(REVIEW-05).
      if (e.comment.user.type === 'Bot') return this.record(delivery, event, target, { outcome: 'ignored', reason: 'bot_comment' });
      if (e.action !== 'created') return this.record(delivery, event, target, { outcome: 'ignored', reason: 'comment_action' });
      if (!e.issue.pull_request) return this.record(delivery, event, target, { outcome: 'ignored', reason: 'not_pull_request' });
      if (context.review.commentCommand === null) return this.record(delivery, event, target, { outcome: 'ignored', reason: 'comment_trigger_disabled' });
      if (e.comment.body.trim() !== context.review.commentCommand) return this.record(delivery, event, target, { outcome: 'ignored', reason: 'not_command' });
      const repo = this.repository(context, e.repository.id, e.installation.id);
      if (!repo) return this.record(delivery, event, target, { outcome: 'denied', reason: 'installation_or_repository' });
      // issue.author_association이 아니라 댓글 작성자의 association을 본다.
      if (!MODEL_CALL_ASSOCIATIONS.includes(e.comment.author_association)) return this.record(delivery, event, target, { outcome: 'denied', reason: 'comment_author_denied' });
      let pr: PullRequest;
      // payload에는 PR head 저장소가 없어 PR을 조회한다. 조회 실패면 모델을 부르지 않는다.
      try { pr = pullRequest(await this.reader.pullRequest(repo.fullName, e.issue.number)); }
      catch { return this.record(delivery, event, target, { outcome: 'denied', reason: 'pr_lookup_failed' }); }
      return this.enqueue(delivery, event, target, pr, repo, context, 'comment');
    }
    return this.record(delivery, event, null, { outcome: 'ignored', reason: 'unsupported_event' });
  }
  private async enqueue(delivery: string, event: string, target: { action?: string; repository?: { id: number }; pr?: number },
    pr: PullRequest, repo: ReviewPolicy['repositories'][number], context: ReviewContext, trigger: string): Promise<IngressResult> {
    const decision = pullRequestDecision(pr, repo, context.review, trigger === 'comment');
    if (decision) return this.record(delivery, event, target, decision);
    let comparison: string;
    try { comparison = await this.queue.comparison(repo.fullName, pr, context.review); }
    catch { return this.record(delivery, event, target, { outcome: 'denied', reason: 'comparison_lookup_failed' }); }
    return this.record(delivery, event, target, tx => this.queue.admit(pr, repo, context, comparison, trigger, delivery, tx));
  }
  private repository(context: ReviewContext, repo: number, installation: number) {
    return context.review.repositories.find(r => r.id === repo && r.installationId === installation);
  }
  private async record(delivery: string, event: string, target: { action?: string; repository?: { id: number }; pr?: number } | null,
    decide: Outcome | ((tx: Database) => Promise<Outcome>)): Promise<IngressResult> {
    return this.store.db.transaction(async tx => {
      const inserted = await tx.query(`INSERT INTO github_deliveries(delivery_id,event,action,repo_id,pr_number,outcome,received_at)
        VALUES ($1,$2,$3,$4,$5,'pending',$6) ON CONFLICT DO NOTHING RETURNING delivery_id`,
      [delivery, event, target?.action ?? null, target?.repository?.id ?? null, target?.pr ?? null, this.store.now()]);
      if (!inserted.rows.length) return { status: 200, outcome: 'duplicate_delivery' };
      const result = typeof decide === 'function' ? await decide(tx) : decide;
      await tx.query('UPDATE github_deliveries SET outcome=$2,reason=$3,generation_key=$4 WHERE delivery_id=$1',
        [delivery, result.outcome, result.reason ?? null, result.key ?? null]);
      return { status: 202, outcome: result.outcome, reason: result.reason };
    });
  }
}
export function githubWebhook(ingress: GitHubIngress) {
  return async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    if (req.method !== 'POST') { res.writeHead(404).end(); return; }
    const chunks: Buffer[] = [];
    let size = 0;
    try {
      for await (const chunk of req) {
        size += chunk.length;
        if (size > MAX_WEBHOOK_BYTES) throw new Error('body_limit');
        chunks.push(Buffer.from(chunk));
      }
    } catch { res.writeHead(413).end(); return; }
    const header = (name: string) => { const value = req.headers[name]; return typeof value === 'string' ? value : undefined; };
    try {
      const result = await ingress.receive({ 'x-hub-signature-256': header('x-hub-signature-256'),
        'x-github-delivery': header('x-github-delivery'), 'x-github-event': header('x-github-event') }, Buffer.concat(chunks));
      res.writeHead(result.status).end();
    } catch { res.writeHead(503).end(); }
  };
}

export const ReviewResultSchema = z.strictObject({
  review_job_id: z.string().uuid(), repo_id: z.string(), pr_number: z.number().int().positive(),
  head_sha: Sha, comparison_revision: Sha, policy_revision: z.string().min(1), reviewed_at: z.number().int(),
  coverage: CoverageSchema,
  checks: z.array(z.strictObject({ name: z.string(), revision: Sha, result: z.enum(['pass', 'fail', 'pending', 'not_run']), link: z.string().nullable() })),
  findings: z.array(FindingSchema), open_questions: z.array(z.string()), public_summary: z.string(),
  output_classification: z.enum(['public', 'restricted']),
  review_outcome: z.enum(['completed', 'partial', 'failed', 'superseded']),
});
export type ReviewResult = z.infer<typeof ReviewResultSchema>;
const PositionsSchema = z.array(z.strictObject({ path: z.string(), lines: z.array(z.number().int().positive()).max(100_000) })).max(1000);
// DATA-01: 운영 비밀·내부 표식이 모델 출력에 섞이면 공개 PR에 올리지 않는다. 마스킹이 아니라 게시 차단이다.
export function classify(output: Pick<ReviewOutput, 'findings' | 'open_questions' | 'public_summary'>, review: ReviewPolicy): ReviewResult['output_classification'] {
  // JSON 문자열화는 따옴표를 이스케이프해 패턴을 피해 가므로 원문 문자열을 그대로 모은다.
  const text = [...output.findings.flatMap(f => Object.values(f).map(String)), ...output.open_questions, output.public_summary].join('\n');
  const lower = text.toLowerCase();
  if (SECRET_PATTERNS.some(pattern => pattern.test(text)) || review.internalMarkers.some(m => lower.includes(m.toLowerCase()))) return 'restricted';
  return 'public';
}
const asJob = (row: Record<string, unknown>) => row as unknown as Job;
const MAX_DEFERS = 10;
export const notificationScope = (policy: Policy): Scope => ({ guild: policy.guild, channel: policy.notificationChannel, parent: null, kind: 'channel' });

export interface ReviewWorkerClient {
  review(task: ReviewTask, capability: string, signal: AbortSignal): Promise<ReviewWorkerResult>;
  cancel(request: CancelRequest, capability: string): Promise<{ stopped: boolean }>;
}
// 종료 규칙은 대화 runtime과 같다(ARCHITECTURE "정상 종료"). 신호 뒤에는 claim하지 않고, dispatch 전이면 대기열로 되돌리고,
// 실행 중이면 drainMs를 기다린 뒤 cancel한다. 멈춤이 확인된 리뷰는 자동 재실행하지 않고 failed다.
// lanes: 작업 루프를 켠 배치. 리뷰는 대화와 interactive 레인을 나눠 쓰고 작업 레인의 실행·대기에 막히지 않는다.
// changeReview: 미게시 후보 job을 맡을 실행기. 없으면 그 job을 집지 않는다. 있든 없든 게시 PR 리뷰 경로는 그대로다.
export interface ChangeReviewDispatcher { run(job: Job): Promise<void> }
export interface ReviewRuntimeOptions { shutdown?: AbortSignal; drainMs?: number; lanes?: boolean; changeReview?: ChangeReviewDispatcher }
class ReviewShutdown extends Error {}
export class ReviewRuntime {
  private readonly shutdown?: AbortSignal;
  private readonly drainMs: number;
  private readonly lanes: boolean;
  private readonly changeReview?: ChangeReviewDispatcher;
  constructor(private readonly store: Store, private readonly policy: ReviewPolicySource, private readonly queue: ReviewQueue,
    private readonly reader: GitHubReader, private readonly worker: ReviewWorkerClient, private readonly signer: WorkerSigner,
    private readonly pollMs = 1000, options: ReviewRuntimeOptions = {}) {
    this.shutdown = options.shutdown;
    this.drainMs = options.drainMs ?? DRAIN_MS;
    this.lanes = options.lanes ?? false;
    if (options.changeReview) this.changeReview = options.changeReview;
  }
  // dispatch 전 GitHub 조회를 종료 기한까지 기다리지 않는다. 끝까지 기다리면 프로세스가 먼저 끝나
  // 모델을 부르지 않은 작업이 lease 만료로 unknown이 되고 전역 슬롯을 잡는다.
  private untilShutdown<T>(work: Promise<T>): Promise<T> {
    const signal = this.shutdown;
    if (!signal) return work;
    return new Promise<T>((resolve, reject) => {
      const stop = () => reject(new ReviewShutdown());
      signal.addEventListener('abort', stop, { once: true });
      work.then(resolve, reject).finally(() => signal.removeEventListener('abort', stop));
      if (signal.aborted) stop();
    });
  }
  // 대화 claim과 같은 scheduler 잠금·전역 슬롯 조건을 쓴다. 리뷰도 대화와 같은 직렬 1개다(D-14).
  async claim(): Promise<(Job & Record<string, unknown>) | undefined> {
    return this.store.db.transaction(async tx => {
      await tx.query(`INSERT INTO controls VALUES ('scheduler','false') ON CONFLICT DO NOTHING`);
      const control = (await tx.query<{ value: boolean }>(`SELECT value FROM controls WHERE key='scheduler' FOR UPDATE`)).rows[0]!;
      if (control.value) return;
      if (this.lanes) {
        await tx.query(`SELECT lane FROM execution_lanes WHERE lane='interactive' FOR UPDATE`);
        if (await this.store.laneBusy('interactive', tx)) return;
      } else if ((await tx.query(`SELECT id FROM jobs WHERE state IN ('running','verifying','cancel_requested','unknown','waiting_user') LIMIT 1`)).rows.length) return;
      // 대화가 리뷰보다 먼저다(F05). Store.claim이 지금 집을 수 있는 대화·작업이 있으면 양보한다.
      if ((await tx.query(`SELECT j.id FROM jobs j JOIN events e ON e.id=j.event_id JOIN conversations c ON c.id=j.conversation_id
        WHERE j.state='queued' AND e.accepted=true AND c.active=true AND c.gap=false AND c.owner_id=j.owner_id
        AND e.actor_id=j.owner_id AND j.available_at<=$1 ${this.lanes ? "AND j.execution_lane='interactive'" : ''} LIMIT 1`, [this.store.now()])).rows.length) return;
      // type='review'에는 게시 PR 리뷰와 미게시 후보(change_child_jobs)가 함께 있다. 맡을 실행기가 없으면 미게시 후보를 집지 않고 대기열에 둔다.
      const unassigned = this.changeReview ? '' : `AND NOT EXISTS (SELECT 1 FROM change_child_jobs c WHERE c.job_id=jobs.id AND c.role='review')`;
      // 리뷰 미루기(COLLEAGUE_SPEC §4.7): 한도 경고의 풀리는 시각까지 새 PR 리뷰를 집지 않는다. 미룬 리뷰는 queued로 남아 기한 뒤에 집힌다.
      // 미게시 후보 리뷰는 owner가 시킨 변경 작업의 한 단계라 작업처럼 계속한다.
      const deferred = await this.store.reviewDeferredUntil(tx) === null ? ''
        : `AND EXISTS (SELECT 1 FROM change_child_jobs c WHERE c.job_id=jobs.id AND c.role='review')`;
      const row = (await tx.query<{ id: string }>(`SELECT id FROM jobs WHERE type='review' AND state='queued' AND available_at<=$1 ${unassigned} ${deferred}
        ORDER BY priority,created_at FOR UPDATE SKIP LOCKED LIMIT 1`, [this.store.now()])).rows[0];
      if (!row) return;
      return (await tx.query<Job & Record<string, unknown>>(`UPDATE jobs SET state='running',attempt=attempt+1,lease_token=$2,
        lease_until=$3,started_at=$4 WHERE id=$1 RETURNING *`, [row.id, randomUUID(), this.store.now() + DEFAULTS.leaseMs, this.store.now()])).rows[0];
    });
  }
  async tick(): Promise<boolean> {
    if (this.shutdown?.aborted) return false;
    await this.store.expire();
    const job = await this.claim();
    if (!job) return false;
    const review = (await this.store.db.query<ReviewRow>('SELECT * FROM pr_reviews WHERE job_id=$1', [job.id])).rows[0];
    if (!review) {
      // 맡을 PR이 없다. 실행기는 자식 job 연결을 다시 보고 출처를 모르면 실패로 닫는다. 모델을 부르지 않는다.
      if (this.changeReview) await this.changeReview.run(asJob(job));
      else await this.store.transition(asJob(job), 'failed', 'review_source_unknown');
      return true;
    }
    let dispatched = false;
    let stopped = false;
    // dispatch 전 GitHub 조회가 lease(30초)보다 길어질 수 있어 그동안에도 lease를 늘린다.
    const keepalive = setInterval(() => { void this.store.heartbeat(asJob(job)).catch(() => {}); }, this.pollMs);
    try {
      const context = await this.policy.current();
      // 정책 목록 밖이면 Discord 리뷰 요청의 대상 기록으로만 통과한다. 그 세대는 다시 넣지 않는다(범위는 이 작업 하나).
      const listed = context.review.repositories.find(r => String(r.id) === String(review.repo_id)
        && String(r.installationId) === String(review.installation_id) && r.fullName === review.repo_full_name);
      const outside = listed ? undefined : requestedRepository(review);
      const repo = listed ?? outside;
      if (!repo) { await this.close(job, review, 'cancelled', 'authorization_revoked'); return true; }
      if (context.revision !== review.policy_revision) { await this.close(job, review, 'superseded', 'policy_changed'); return true; }
      // 실행 직전 live PR로 head·base·닫힘·작성자를 다시 본다. webhook 내용만 믿지 않는다.
      const pr = pullRequest(await this.untilShutdown(this.reader.pullRequest(repo.fullName, review.pr_number)));
      const liveComparison = pr.open && pr.head.sha === review.head_sha ? await this.untilShutdown(this.queue.comparison(repo.fullName, pr, context.review)) : undefined;
      const stale = !pr.open ? (pr.merged ? 'merged_before_review' : 'pr_closed')
        : pr.head.sha !== review.head_sha ? 'stale_head' : liveComparison !== review.comparison_revision ? 'base_moved' : undefined;
      if (stale) {
        await this.close(job, review, 'superseded', stale);
        // 늦게 온 옛 이벤트나 base 이동이면 live 세대를 같은 규칙으로 넣는다. 닫혔으면 남은 대기 작업도 정리한다.
        if (pr.open && !outside) await this.queue.admitLive(pr, repo, context, 'live_check');
        else if (!pr.open) await this.store.db.transaction(tx => this.queue.supersede(tx, repo.id, pr.number, stale));
        return true;
      }
      // trigger는 조회 중 댓글 명시 요청으로 승격될 수 있어 작업 시작 때 읽은 값을 쓰지 않는다.
      const denied = pullRequestDecision(pr, repo, context.review, await this.explicit(job.id));
      if (denied) { await this.close(job, review, denied.outcome === 'denied' ? 'cancelled' : 'superseded', denied.reason); return true; }
      let compare: { files: Change[]; truncated: boolean };
      try { compare = CompareSchema.parse(await this.untilShutdown(this.reader.compare(repo.fullName, review.comparison_revision, review.head_sha))); }
      catch (error) {
        if (error instanceof ReviewShutdown) throw error;
        if (error instanceof GitHubError && (error.status === 429 || error.status >= 500)) { await this.backoff(job, review, error); return true; }
        // 열거 실패를 압축본 비교로 대신하지 않는다(REVIEW-03).
        await this.close(job, review, 'failed', 'enumeration_failed'); return true;
      }
      const contract = archiveContract(repo.fullName, review.comparison_revision, review.head_sha);
      const task = ReviewTaskSchema.parse({ version: 1, job: job.id, lease: job.lease_token, lane: 'review',
        repository: repo.fullName, base: review.comparison_revision, head: review.head_sha,
        archives: { base: contract.base, head: contract.head }, changes: compare.files, truncated: compare.truncated,
        pullRequest: { title: pr.title.slice(0, 1000), body: pr.body.slice(0, 65_536) }, limits: context.review.input,
        policyRevision: context.revision, instructions: SERVER_REVIEW_INSTRUCTIONS, timeoutMs: DEFAULTS.taskTimeoutMs });
      // 원격 조회 동안 바뀐 권한·정책을 capability 발급 직전에 최신 정책으로 다시 본다(D-16 모델 호출 전 허용 확인).
      const fresh = await this.policy.current();
      const freshRepo = fresh.review.repositories.find(r => r.id === repo.id && r.installationId === repo.installationId && r.fullName === repo.fullName)
        ?? outside;
      if (!freshRepo) { await this.close(job, review, 'cancelled', 'authorization_revoked'); return true; }
      if (fresh.revision !== review.policy_revision) {
        await this.close(job, review, 'superseded', 'policy_changed');
        if (!outside) await this.queue.admitLive(pr, freshRepo, fresh, 'live_check');
        return true;
      }
      const revoked = pullRequestDecision(pr, freshRepo, fresh.review, await this.explicit(job.id));
      if (revoked) { await this.close(job, review, revoked.outcome === 'denied' ? 'cancelled' : 'superseded', revoked.reason); return true; }
      // PR·목록 조회 동안 들어온 취소·비상 중지와 lease 만료를 dispatch 직전에 다시 본다.
      const live = (await this.store.db.query<{ state: string; lease_token: string; lease_until: string }>(
        'SELECT state,lease_token,lease_until FROM jobs WHERE id=$1', [job.id])).rows[0];
      if (!live || live.lease_token !== job.lease_token || Number(live.lease_until) <= this.store.now()) return true;
      if (live.state === 'cancel_requested') { await this.close(job, review, 'cancelled', 'cancel_before_dispatch'); return true; }
      if (live.state !== 'running' || !await this.store.heartbeat(asJob(job))) return true;
      // 여기부터 아래 리스너 등록까지 await가 없어 신호를 놓치지 않는다. 신호 뒤 dispatch하지 않는다.
      if (this.shutdown?.aborted) throw new ReviewShutdown();
      const abort = new AbortController();
      let timeout: ReturnType<typeof setTimeout> | undefined;
      let checking: Promise<void> | undefined;
      const cancelBody = { job: job.id, lease: job.lease_token };
      // cancel은 한 번만 보낸다. 작업자는 첫 확인 뒤 job을 놓아 두 번째 cancel은 stopped:false다.
      let stopping: Promise<{ stopped: boolean }> | undefined;
      const stopRequest = () => stopping ??= this.worker.cancel(cancelBody, this.signer.issue(asJob(job), 'cancel', cancelBody)).catch(() => ({ stopped: false }));
      let drained = false;
      let drain: ReturnType<typeof setTimeout> | undefined;
      // 드레인 기한이 되면 DB 후처리를 기다리지 않고 그 자리에서 cancel을 보낸다(대화 runtime과 같은 이유).
      const onShutdown = () => { drain = setTimeout(() => { drained = true; void stopRequest(); abort.abort(); }, this.drainMs); };
      this.shutdown?.addEventListener('abort', onShutdown, { once: true });
      const interrupted = new Promise<ReviewWorkerResult>(resolve => {
        abort.signal.addEventListener('abort', () => resolve({ status: 'unknown', stopped: false }), { once: true });
      });
      // 비상 중지·취소 요청·lease 상실을 실행 중에도 본다(대화 레인과 같은 규칙).
      const monitor = setInterval(() => {
        if (checking) return;
        checking = (async () => {
          const state = (await this.store.db.query<{ state: string }>('SELECT state FROM jobs WHERE id=$1', [job.id])).rows[0]?.state;
          if (state === 'cancel_requested' || !await this.store.heartbeat(asJob(job))) abort.abort();
        })().catch(() => abort.abort()).finally(() => { checking = undefined; });
      }, this.pollMs);
      let result: ReviewWorkerResult;
      try {
        const capability = this.signer.issue(asJob(job), 'execute', task);
        dispatched = true;
        result = await Promise.race([this.worker.review(task, capability, abort.signal), interrupted,
          new Promise<ReviewWorkerResult>(resolve => {
            timeout = setTimeout(() => { abort.abort(); resolve({ status: 'unknown', stopped: false }); }, task.timeoutMs);
          })]);
      } finally {
        clearInterval(monitor); clearTimeout(timeout); clearTimeout(drain);
        this.shutdown?.removeEventListener('abort', onShutdown);
        await checking;
      }
      const current = (await this.store.db.query<{ state: string }>('SELECT state FROM jobs WHERE id=$1', [job.id])).rows[0]?.state;
      if (current === 'cancel_requested' || abort.signal.aborted) {
        const confirmation = result.stopped ? { stopped: true } : await stopRequest();
        // 멈춤을 확인하지 못하면 unknown으로 두어 전역 슬롯을 잡는다. 자동 재실행하지 않는다.
        const state = !confirmation.stopped ? 'unknown' : current === 'cancel_requested' ? 'cancelled' : 'failed';
        if (state === 'unknown') await this.store.transition(asJob(job), 'unknown', drained ? 'publisher_shutdown' : 'stop_confirmation');
        else await this.close(job, review, state, 'stop_confirmation');
        if (drained) await this.store.audit('publisher_shutdown', job.id, { type: 'review', attempt: job.attempt, outcome: state });
        return true;
      }
      if (!result.stopped) { await this.store.transition(asJob(job), 'unknown', 'worker_disconnected'); return true; }
      stopped = true;
      if (result.status === 'limited' || result.status === 'auth_expired') {
        await this.store.waitForUser(asJob(job), result.status === 'limited' ? 'model_limit' : 'auth_expired', { rateLimit: result.rateLimit ?? null });
        // 전역 모델 대기를 owner가 알림 채널에서 풀 수 있게 job ID와 명령을 알린다(원문 없음).
        const scope = notificationScope(context.base);
        await this.store.enqueue({ key: `review-waiting:${job.id}`, actor: context.base.owner, scope, revision: context.base.revision,
          payload: { kind: 'message', channel: scope.channel, classification: 'safe_summary',
            content: `PR 리뷰가 모델 ${result.status === 'limited' ? '한도' : '인증 만료'}로 대기 중이고 새 모델 호출이 멈췄습니다: `
              + `${review.repo_full_name}#${review.pr_number}, job ${job.id}. 원인 해소 뒤 이 채널에서 /review-resume target:${job.id}, `
              + `포기는 /review-cancel target:${job.id}.` } });
        return true;
      }
      // 대기가 아닌 결과의 한도 경고도 계정 기록에 남긴다(리뷰 미루기). 기록 실패가 결과 처리를 막지 않는다.
      await this.store.observeRateLimit(result.rateLimit).catch(() => {});
      if (result.status !== 'succeeded') { await this.close(job, review, 'failed', result.reason ?? 'model_failed'); return true; }
      await this.finish(job, review, context, task, result);
    } catch (error) {
      if (error instanceof ReviewShutdown) {
        await this.store.defer(asJob(job), 'publisher_shutdown');
        await this.store.audit('publisher_shutdown', job.id, { type: 'review', outcome: 'deferred' });
      }
      else if (error instanceof WorkerRejected) await this.close(job, review, 'failed', 'worker_rejected');
      else if (!dispatched && error instanceof PolicyUnavailable) {
        await this.store.defer(asJob(job), error instanceof ReviewDisabled ? 'review_disabled' : 'policy_unavailable');
        // 리뷰가 꺼진 동안은 1분 간격으로만 다시 본다.
        if (error instanceof ReviewDisabled) await this.store.db.query(`UPDATE jobs SET available_at=$2 WHERE id=$1 AND state='queued'`, [job.id, this.store.now() + 60_000]);
      }
      else if (!dispatched && error instanceof GitHubError && (error.status === 429 || error.status >= 500)) await this.backoff(job, review, error);
      else if (!dispatched) await this.close(job, review, error instanceof Denied ? 'cancelled' : 'failed',
        error instanceof Denied ? 'authorization_revoked' : error instanceof GitHubError ? 'github_access_lost' : 'before_dispatch');
      // 작업자가 멈춤을 확인한 뒤의 저장 오류는 실행 효과가 불명이 아니다. 슬롯을 잡지 않고 실패로 닫는다.
      else if (stopped) await this.close(job, review, 'failed', 'after_stop');
      else await this.store.transition(asJob(job), 'unknown', 'runtime_uncertain');
    } finally {
      clearInterval(keepalive);
      // dispatch 전에 lease를 잃어 상태를 못 바꿨으면, 모델을 부르지 않은 것이 확실하므로 대기열로 되돌린다.
      // 조기 return 경로도 지나가야 해서 finally에 둔다. 정상 종료된 작업은 상태 조건에 걸리지 않는다.
      if (!dispatched) await this.releaseUndispatched(job).catch(() => {});
    }
    return true;
  }
  private async explicit(job: string): Promise<boolean> {
    return (await this.store.db.query<{ trigger: string }>('SELECT trigger FROM pr_reviews WHERE job_id=$1', [job])).rows[0]?.trigger === 'comment';
  }
  private async releaseUndispatched(job: Job): Promise<void> {
    await this.store.db.query(`UPDATE jobs SET state='queued',attempt=GREATEST(0,attempt-1),available_at=$3,lease_token=NULL,
      lease_until=NULL,started_at=NULL,wait_reason='lease_lost_before_dispatch' WHERE id=$1 AND lease_token=$2
      AND (state='running' OR (state='unknown' AND wait_reason='lease_expired'))`, [job.id, job.lease_token, this.store.now() + DEFAULTS.retryDelayMs]);
  }
  private async finish(job: Job, review: ReviewRow, context: ReviewContext, task: ReviewTask,
    result: Extract<ReviewWorkerResult, { status: 'succeeded' }>): Promise<void> {
    const output = ReviewOutputSchema.safeParse(result.output);
    const coverage = CoverageSchema.safeParse(result.coverage);
    const positions = PositionsSchema.safeParse(result.positions);
    // 모델 출력은 권한 근거가 아니다. 계약 밖 필드나 검토하지 않은 파일 지적이 있으면 게시하지 않는다.
    if (!output.success || !coverage.success || !positions.success
      || output.data.findings.some(f => !coverage.data.checked_files.includes(f.path))) {
      await this.close(job, review, 'failed', 'invalid_output'); return;
    }
    const classification = classify(output.data, context.review);
    const reviewed: ReviewResult = ReviewResultSchema.parse({ review_job_id: job.id, repo_id: String(review.repo_id),
      pr_number: review.pr_number, head_sha: task.head, comparison_revision: task.base, policy_revision: task.policyRevision,
      reviewed_at: this.store.now(), coverage: coverage.data,
      checks: [{ name: 'ci', revision: task.head, result: 'not_run', link: null }],
      findings: output.data.findings, open_questions: output.data.open_questions, public_summary: output.data.public_summary,
      output_classification: classification, review_outcome: reviewOutcome(coverage.data) });
    await this.store.db.transaction(async tx => {
      const state = (await tx.query<{ state: string }>(`UPDATE jobs SET state=CASE WHEN state='cancel_requested' THEN 'cancelled' ELSE 'succeeded' END,
        wait_reason=NULL,finished_at=$3 WHERE id=$1 AND lease_token=$2 AND lease_until>$3 AND state IN ('running','verifying','cancel_requested')
        RETURNING state`, [job.id, job.lease_token, this.store.now()])).rows[0]?.state;
      if (!state) throw new Error('stale_result');
      if (state === 'cancelled') return;
      const current = (await tx.query<ReviewRow>('SELECT * FROM pr_reviews WHERE job_id=$1 FOR UPDATE', [job.id])).rows[0]!;
      // 실행 중 새 세대가 들어왔으면 결과는 과거 기록으로만 남긴다(REVIEW-02).
      const outcome = current.superseded_at ? 'superseded' : reviewed.review_outcome;
      await tx.query('UPDATE pr_reviews SET result=$2,review_outcome=$3,positions=$4 WHERE job_id=$1',
        [job.id, json({ ...reviewed, review_outcome: outcome }), outcome, json(positions.data)]);
      if (current.superseded_at) return;
      if (classification === 'restricted') {
        await tx.query('INSERT INTO audit(kind,subject,detail,created_at) VALUES ($1,$2,$3,$4)',
          ['review_restricted', job.id, json({ reason: 'output_classification', resend: false }), this.store.now()]);
        await this.notify(tx, context, `review-restricted:${job.id}`, `PR 리뷰 결과를 공개 범위 검사에서 차단했습니다: ${review.repo_full_name}#${review.pr_number}. 게시하지 않았습니다.`);
        return;
      }
      // 되살린 세대가 다시 게시할 수 있게 시도마다 키를 나눈다. 대조 marker도 이 키다.
      const key = `github-review:${job.id}:${job.attempt}`;
      const rendered = context.review.publish && render(reviewed, positions.data, context.review.publish, key);
      await tx.query(`INSERT INTO review_deliveries(id,job_id,idempotency_key,repo_id,repo_full_name,pr_number,head_sha,comparison_revision,
        policy_revision,body,comments,state,reason,available_at,created_at) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$14)
        ON CONFLICT (idempotency_key) DO NOTHING`, [randomUUID(), job.id, key, review.repo_id, review.repo_full_name,
        review.pr_number, task.head, task.base, task.policyRevision, rendered ? rendered.body : '', json(rendered ? rendered.comments : []),
        rendered ? 'pending' : 'blocked', rendered ? null : context.review.publish ? 'publish_limit_exceeded' : 'publish_limits_unset', this.store.now()]);
    });
  }
  // GitHub 일시 장애는 Retry-After와 지수 백오프로 기다리고, 상한을 넘으면 실패로 닫는다(새 push·댓글로 다시 시작).
  private async backoff(job: Job, review: ReviewRow, error: GitHubError): Promise<void> {
    const count = (await this.store.db.query<{ defer_count: number }>(
      'UPDATE pr_reviews SET defer_count=defer_count+1 WHERE job_id=$1 RETURNING defer_count', [review.job_id])).rows[0]!.defer_count;
    if (count > MAX_DEFERS) { await this.close(job, review, 'failed', 'github_unavailable'); return; }
    await this.store.defer(job, 'github_unavailable');
    await this.store.db.query(`UPDATE jobs SET available_at=$2 WHERE id=$1 AND state='queued'`,
      [job.id, this.store.now() + Math.max(error.retryAfterMs, Math.min(60_000, DEFAULTS.retryDelayMs * 2 ** (count - 1)))]);
  }
  private async close(job: Job, review: ReviewRow, state: 'failed' | 'cancelled' | 'superseded', reason: string): Promise<void> {
    if (!await this.store.transition(job, state, reason)) return;
    await this.store.db.query(`UPDATE pr_reviews SET review_outcome=$2,superseded_reason=CASE WHEN $2='superseded' THEN $3 ELSE superseded_reason END,
      superseded_at=CASE WHEN $2='superseded' THEN COALESCE(superseded_at,$4) ELSE superseded_at END WHERE job_id=$1`,
    [job.id, state === 'cancelled' ? 'failed' : state, reason, this.store.now()]);
  }
  private async notify(tx: Database, context: ReviewContext, key: string, content: string): Promise<void> {
    const scope = notificationScope(context.base);
    await this.store.enqueue({ key, actor: context.base.owner, scope, revision: context.base.revision,
      payload: { kind: 'message', channel: scope.channel, content, classification: 'safe_summary' } }, tx);
  }
}

const SEVERITY = ['P0', 'P1', 'P2', 'P3'];
// 모델 문장이 사람·팀을 멘션하거나 HTML 주석으로 대조 marker를 흉내 내지 못하게 한다.
const inert = (value: string) => value.replace(/@(?=[A-Za-z0-9_-])/g, '@\u200b').replace(/<!--/g, '&lt;!--');
// 파일 경로도 PR 작성자가 정한 자료다. 코드 칸을 깨거나 줄을 바꾸지 못하게 한다.
const code = (value: string) => `\`${inert(value.replace(/[`\r\n]/g, '?'))}\``;
export const reviewMarker = (key: string) => `<!-- homelab-bot-review:${key} -->`;
// 모델 칸 하나를 문단 안의 문장 하나로 만든다. 빈 줄이 문단을 끊지 못하게 줄바꿈을 공백으로 접고,
// 문장 끝 없이 끝난 칸(v1 지시문으로 저장된 결과의 "…일 때" 같은 조각)에는 마침표를 붙인다.
const sentence = (value: string) => {
  const flat = value.replace(/\s*[\r\n]+\s*/g, ' ').trim();
  return /[\p{L}\p{N}]$/u.test(flat) ? `${flat}.` : flat;
};
// 게시 본문은 코드가 만든다. 모델 텍스트는 지적 칸 안의 자료로만 들어가고 event·대상은 상수다.
export function render(result: ReviewResult, positions: { path: string; lines: number[] }[],
  limits: NonNullable<ReviewPolicy['publish']>, key: string): { body: string; comments: { path: string; line: number; side: 'RIGHT'; body: string }[] } | null {
  const findings = [...result.findings].sort((a, b) => SEVERITY.indexOf(a.severity) - SEVERITY.indexOf(b.severity));
  const shown = findings.slice(0, limits.maxFindings);
  const comments: { path: string; line: number; side: 'RIGHT'; body: string }[] = [];
  const valid = new Map(positions.map(p => [p.path, new Set(p.lines)]));
  const heading = (f: ReviewResult['findings'][number]) => `**[${f.severity}] ${inert(f.title.replace(/\s*[\r\n]+\s*/g, ' '))}**`;
  const paragraph = (f: ReviewResult['findings'][number]) =>
    [f.condition, f.impact, f.evidence, f.suggestion].map(text => inert(sentence(text))).join(' ');
  for (const f of shown) if (f.line && valid.get(f.path)?.has(f.line) && comments.length < limits.maxInlineComments) {
    comments.push({ path: f.path, line: f.line, side: 'RIGHT', body: `${heading(f)}\n\n${paragraph(f)}` });
  }
  const omitted = result.coverage.omitted_files_with_reasons;
  const limitsHit = result.coverage.limits_hit.length ? `(상한: ${result.coverage.limits_hit.join(', ')})` : '';
  const lines = [reviewMarker(key), '참고용 자동 리뷰예요. 승인·병합 판단이 아니고 안전을 보증하지도 않아요.',
    `${result.review_outcome === 'partial' ? '부분 검토예요' : '검토를 마쳤어요'}. 파일 ${result.coverage.checked_files.length}개를 봤어요`
      + (omitted.length ? `, ${omitted.length}개는 못 봤어요` : '') + `${limitsHit}. `
      + `리비전 head \`${result.head_sha}\` · 기준 \`${result.comparison_revision}\` · 정책 \`${result.policy_revision}\``,
    ...omitted.slice(0, 20).map(o => `- 못 본 파일 ${code(o.path)}: ${o.reason}`),
    ...(omitted.length > 20 ? [`- 못 본 파일이 ${omitted.length - 20}개 더 있어요`] : []),
    '', inert(result.public_summary), ''];
  if (!shown.length) lines.push('따로 지적할 건 없어요.');
  for (const f of shown) lines.push(`${heading(f)} · ${code(f.path)}${f.line ? `:${f.line}` : ''}\n${paragraph(f)}`, '');
  if (findings.length > shown.length) lines.push(`게시 상한 때문에 ${findings.length - shown.length}건은 싣지 않았어요.`, '');
  if (result.open_questions.length) lines.push('확인하고 싶은 점이 있어요.', ...result.open_questions.map(q => `- ${inert(q)}`));
  const body = lines.join('\n').trimEnd();
  return body.length > limits.maxBodyChars ? null : { body, comments };
}

interface DeliveryRow {
  id: string; job_id: string; idempotency_key: string; repo_id: string; repo_full_name: string; pr_number: number;
  head_sha: string; comparison_revision: string; policy_revision: string; body: string;
  comments: { path: string; line: number; side: 'RIGHT'; body: string }[]; inline: boolean; state: string; attempt: number;
  lease_token: string; external_id: string | null; available_at: string | number;
}
const RECONCILE_BATCH = 20;
export class ReviewPublisher {
  constructor(private readonly store: Store, private readonly policy: ReviewPolicySource, private readonly reader: GitHubReader,
    private readonly github: RestrictedGitHub, private readonly queue: ReviewQueue, private readonly pollMs = 1000,
    private readonly shutdown?: AbortSignal) {}
  async deliver(): Promise<boolean> {
    // 종료 신호 뒤에는 새 게시를 잡지 않는다. 이미 잡은 게시는 끝까지 간다. 프로세스가 먼저 끝나면 다음 기동이 lease로 회수한다.
    if (this.shutdown?.aborted) return false;
    // 게시 중 죽은 프로세스의 lease를 회수한다. 전송을 시작했으면 결과를 모르므로 unknown(재게시 없이 대조).
    // unknown의 available_at은 진입 시각이다(outbox와 같은 관례). 대조 기한을 생성 시각이 아니라 여기서부터 센다.
    await this.store.db.query(`UPDATE review_deliveries SET state=CASE WHEN dispatch_started THEN 'unknown' ELSE 'pending' END,
      reason=CASE WHEN dispatch_started THEN 'lease_expired' ELSE reason END,
      available_at=CASE WHEN dispatch_started THEN $1 ELSE available_at END WHERE state='sending' AND lease_until<=$1`, [this.store.now()]);
    const row = await this.store.db.transaction(async tx => {
      const next = (await tx.query<{ id: string }>(`SELECT id FROM review_deliveries WHERE state='pending' AND available_at<=$1
        ORDER BY created_at FOR UPDATE SKIP LOCKED LIMIT 1`, [this.store.now()])).rows[0];
      if (!next) return;
      return (await tx.query<DeliveryRow>(`UPDATE review_deliveries SET state='sending',attempt=attempt+1,dispatch_started=false,
        lease_token=$2,lease_until=$3 WHERE id=$1 RETURNING *`, [next.id, randomUUID(), this.store.now() + DEFAULTS.leaseMs])).rows[0];
    });
    if (!row) return false;
    let dispatched = false;
    // 게시 전 PR·비교 기준·기존 리뷰 조회 합계가 lease(30초)보다 길어질 수 있어 그동안에도 이 lease만 늘린다.
    // 만료됐거나 다른 lease로 넘어간 행은 건드리지 않는다(Store.heartbeat와 같은 조건).
    const keepalive = setInterval(() => {
      void this.store.db.query(`UPDATE review_deliveries SET lease_until=$3 WHERE id=$1 AND lease_token=$2 AND state='sending' AND lease_until>$4`,
        [row.id, row.lease_token, this.store.now() + DEFAULTS.leaseMs, this.store.now()]).catch(() => {});
    }, this.pollMs);
    try {
      // 원격 조회를 부르기 전에 막을 수 있는 것은 먼저 막는다. 조회 뒤에 같은 검사를 최신 정책으로 다시 한다.
      const initial = await this.policy.current();
      if (!await this.publishable(row, initial)) return true;
      // 이전 시도의 게시 여부는 다른 판단보다 먼저 확인한다. 이미 올라간 리뷰를 보류·차단으로 기록하면 재개 때 중복 게시된다.
      if (row.attempt > 1 && await this.existing(row)) return true;
      // 게시 직전 최신 PR을 다시 본다. 오래된 리뷰를 최신 검증처럼 올리지 않는다(REVIEW-02).
      const pr = pullRequest(await this.reader.pullRequest(row.repo_full_name, row.pr_number));
      const current = pr.open && pr.head.sha === row.head_sha ? await this.queue.comparison(row.repo_full_name, pr, initial.review) : undefined;
      // 원격 조회 동안 바뀐 저장소 허용·revision·공개 범위·게시 상한을 POST 직전에 최신 정책으로 다시 본다.
      // 이 아래로는 원격 호출이 없어 판단과 POST 사이에 다시 벌어지는 틈은 DB 조회뿐이다.
      const context = await this.policy.current();
      const repo = await this.publishable(row, context);
      if (!repo) return true;
      const stale = !pr.open ? (pr.merged ? 'merged_before_publish' : 'pr_closed')
        : pr.head.sha !== row.head_sha ? 'stale_head' : current !== row.comparison_revision ? 'base_moved' : undefined;
      if (stale) {
        await this.state(row, 'superseded', stale);
        // 게시하지 못한 채 밀려났으므로 live 세대를 같은 규칙으로 넣는다(아직 게시된 리뷰가 없으면 base 이동도 재리뷰).
        if (pr.open && context.review.repositories.includes(repo)) await this.queue.admitLive(pr, repo, context, 'live_check');
        return true;
      }
      if (pr.head.repoId !== pr.base.repoId || !authorAllowed(pr.author, context.review)) { await this.state(row, 'blocked', 'author_denied'); return true; }
      // draft는 기본 대기다. 늦거나 빠진 converted_to_draft를 기다리지 않고 게시 직전 live 상태로 본다. 댓글 명시 요청만 예외.
      const trigger = (await this.store.db.query<{ trigger: string }>('SELECT trigger FROM pr_reviews WHERE job_id=$1', [row.job_id])).rows[0]?.trigger;
      if (pr.draft && trigger !== 'comment' && !context.review.reviewDrafts) {
        await this.state(row, 'superseded', 'draft');
        // 세대 기록도 보류 상태로 둔다. ready_for_review·재조정·댓글이 오면 저장된 결과로 게시를 잇는다.
        await this.store.db.query(`UPDATE pr_reviews SET superseded_at=COALESCE(superseded_at,$2),superseded_reason='draft',
          review_outcome=CASE WHEN review_outcome IN ('completed','partial') THEN 'superseded' ELSE review_outcome END WHERE job_id=$1`,
        [row.job_id, this.store.now()]);
        return true;
      }
      const request = { method: 'POST', path: `/repos/${repo.fullName}/pulls/${row.pr_number}/reviews`,
        body: { commit_id: row.head_sha, event: 'COMMENT', body: row.body, comments: row.comments } };
      const expected = { repository: repo.fullName, pr: row.pr_number, head: row.head_sha };
      try { restrictGitHubWrite(request, expected); } catch { await this.state(row, 'blocked', 'github_write_denied'); return true; }
      if (!(await this.store.db.query(`UPDATE review_deliveries SET dispatch_started=true WHERE id=$1 AND lease_token=$2
        AND state='sending' AND lease_until>$3 RETURNING id`, [row.id, row.lease_token, this.store.now()])).rows.length) return true;
      dispatched = true;
      const sent = await this.github.createReview(request, expected);
      await this.sent(row, String(sent.id), context);
    } catch (error) {
      if (dispatched && !(error instanceof GitHubError && error.status < 500 && error.status !== 408)) {
        // 응답을 잃은 게시는 다시 보내지 않고 기존 리뷰를 대조한다(EVENT-02).
        await this.state(row, 'unknown', 'response_lost');
      } else if (error instanceof Denied) await this.state(row, 'blocked', 'authorization_revoked');
      else if (error instanceof PolicyUnavailable) await this.pause(row, 'policy_unavailable');
      else if (error instanceof GitHubError && error.status === 422 && row.comments.length) {
        // 인라인 위치가 무효면 같은 내용을 본문만으로 한 번 더 시도한다.
        await this.store.db.query(`UPDATE review_deliveries SET state='pending',comments='[]',inline=false,dispatch_started=false,available_at=$3
          WHERE id=$1 AND lease_token=$2`, [row.id, row.lease_token, this.store.now()]);
      } else if (error instanceof GitHubError && [401, 403, 404, 422].includes(error.status) && !error.retryAfterMs) await this.state(row, 'blocked', `github_${error.status}`);
      // 전송 전 일시 장애(조회 5xx·429·연결 실패)는 재시도 횟수를 쓰지 않는다. retry_limit은 전송을 시작한 시도만 센다.
      else if (!dispatched) await this.pause(row, 'before_dispatch', error instanceof GitHubError ? error.retryAfterMs : 0);
      else if (row.attempt > DEFAULTS.maxRetries) await this.state(row, 'blocked', 'retry_limit');
      else await this.store.db.query(`UPDATE review_deliveries SET state='pending',dispatch_started=false,available_at=$3,reason=$4
        WHERE id=$1 AND lease_token=$2`, [row.id, row.lease_token, this.store.now() + Math.max(DEFAULTS.retryDelayMs,
        error instanceof GitHubError ? error.retryAfterMs : 0), 'retry']);
    } finally { clearInterval(keepalive); }
    return true;
  }
  // 이 정책으로 게시해도 되는지 본다. 되면 row.body·comments를 이 정책으로 다시 렌더링해 허용 저장소를 돌려주고,
  // 안 되면 게시 행 상태를 바꾸고 undefined를 돌려준다.
  private async publishable(row: DeliveryRow, context: ReviewContext): Promise<ReviewPolicy['repositories'][number] | undefined> {
    const saved = (await this.store.db.query<{ result: ReviewResult | null; positions: { path: string; lines: number[] }[] | null; installation_id: string;
      request_target: unknown }>('SELECT result,positions,installation_id,request_target FROM pr_reviews WHERE job_id=$1', [row.job_id])).rows[0];
    // 정책 목록 밖이면 Discord 리뷰 요청의 대상 기록으로만 통과한다(실행 직전 판단과 같은 규칙).
    const repo = context.review.repositories.find(r => String(r.id) === String(row.repo_id) && r.fullName === row.repo_full_name
      && String(r.installationId) === String(saved?.installation_id))
      ?? (saved ? requestedRepository({ ...saved, repo_id: row.repo_id, repo_full_name: row.repo_full_name }) : undefined);
    if (!repo) { await this.state(row, 'blocked', 'authorization_revoked'); return; }
    if (!sameReviewContent(row.policy_revision, context)) { await this.state(row, 'superseded', 'policy_changed'); return; }
    if (!context.review.publish) { await this.state(row, 'blocked', 'publish_limits_unset'); return; }
    // 내부 표식 목록은 결과 저장 뒤에도 바뀔 수 있어 게시 직전 현재 정책으로 다시 분류한다(DATA-01).
    const stored = saved?.result;
    if (!stored || classify(stored, context.review) !== 'public') { await this.state(row, 'blocked', 'output_classification'); return; }
    // 게시 상한(지적 수·인라인 수·본문 길이)은 게시 시점 정책으로 저장된 구조화 결과를 다시 렌더링해 적용한다.
    const rendered = render(stored, saved.positions ?? [], context.review.publish, row.idempotency_key);
    if (!rendered) { await this.state(row, 'blocked', 'publish_limit_exceeded'); return; }
    row.body = rendered.body;
    row.comments = row.inline ? rendered.comments : [];
    await this.store.db.query('UPDATE review_deliveries SET body=$3,comments=$4 WHERE id=$1 AND lease_token=$2',
      [row.id, row.lease_token, row.body, json(row.comments)]);
    return repo;
  }
  // outbox 게시 pause와 같은 규칙: 시도 수를 되돌리고 1초부터 60초까지 늘려 기다린다.
  private async pause(row: DeliveryRow, reason: string, retryAfterMs = 0): Promise<void> {
    await this.store.db.query(`UPDATE review_deliveries SET state='pending',attempt=GREATEST(0,attempt-1),dispatch_started=false,
      pause_count=LEAST(pause_count+1,7),available_at=$3+GREATEST($4::bigint,LEAST(60000,$5::bigint*power(2,LEAST(pause_count,6))::bigint)),
      reason=$6 WHERE id=$1 AND lease_token=$2 AND state='sending'`,
    [row.id, row.lease_token, this.store.now(), retryAfterMs, DEFAULTS.retryDelayMs, reason]);
  }
  // 응답 유실 뒤에는 PR의 리뷰 목록에서 marker와 검토 SHA로 찾는다. 못 찾아도 자동 재게시하지 않는다.
  async reconcile(): Promise<void> {
    if (this.shutdown?.aborted) return;
    // 기한은 unknown 진입 시각(available_at)부터다. 정책 비활성·조회 장애·draft 보류로 오래 기다린 행도 대조 기회를 온전히 받는다.
    const retired = await this.store.db.query<{ id: string }>(`UPDATE review_deliveries SET state='blocked',reason='unknown_deadline'
      WHERE state='unknown' AND available_at<=$1 RETURNING id`, [this.store.now() - DEFAULTS.unknownDeliveryMs]);
    for (const row of retired.rows) await this.store.audit('review_delivery_unresolved_retired', row.id, { reason: 'unknown_deadline', resend: false });
    // 커서 다음 행부터 진입 시각 순으로 보고 끝에 닿으면 처음으로 돌아가, 행이 많아도 모든 행이 기한 안에 차례를 받는다.
    // 재시작해도 이어지게 저장하고, 대조 전에 옮겨 한 행이 계속 프로세스를 죽여도 다음 행으로 넘어간다.
    // 키가 위치(진입 시각, id)라 앞선 행이 sent·은퇴로 빠져도 차례가 밀리지 않는다.
    const cursor = (await this.store.db.query<{ value: { at: number; id: string } }>(`SELECT value FROM controls WHERE key='review_reconcile_cursor'`)).rows[0]?.value;
    const rows = (await this.store.db.query<DeliveryRow>(`SELECT * FROM review_deliveries WHERE state='unknown'
      ORDER BY (available_at,id) > ($1::bigint,$2::text) DESC,available_at,id LIMIT $3`, [cursor?.at ?? -1, cursor?.id ?? '', RECONCILE_BATCH])).rows;
    const last = rows.at(-1);
    if (last) await this.store.db.query(`INSERT INTO controls VALUES ('review_reconcile_cursor',$1::jsonb) ON CONFLICT (key) DO UPDATE SET value=EXCLUDED.value`,
      [json({ at: Number(last.available_at), id: last.id })]);
    for (const row of rows) {
      if (this.shutdown?.aborted) return;
      try { await this.existing(row); } catch { /* 다음 차례에 다시 본다 */ }
    }
  }
  private async existing(row: DeliveryRow): Promise<boolean> {
    for (let page = 1; page <= DEFAULTS.recoveryPages; page++) {
      const reviews = z.array(RemoteReview).parse(await this.reader.reviews(row.repo_full_name, row.pr_number, page));
      const found = reviews.find(r => r.commit_id === row.head_sha && r.body?.includes(reviewMarker(row.idempotency_key)));
      if (found) { await this.sent(row, String(found.id), await this.policy.current()); return true; }
      if (reviews.length < 100) break;
    }
    return false;
  }
  private async sent(row: DeliveryRow, id: string, context: ReviewContext): Promise<void> {
    await this.store.db.transaction(async tx => {
      const changed = await tx.query(`UPDATE review_deliveries SET state='sent',external_id=$2,reason=NULL WHERE id=$1
        AND state IN ('sending','unknown') RETURNING id`, [row.id, id]);
      if (!changed.rows.length) return;
      const result = (await tx.query<{ result: ReviewResult }>('SELECT result FROM pr_reviews WHERE job_id=$1', [row.job_id])).rows[0]?.result;
      const scope = notificationScope(context.base);
      // Discord 요약은 코드가 만든 숫자·리비전만 쓴다. 모델 문장은 넣지 않는다.
      const content = `PR 리뷰 게시: ${row.repo_full_name}#${row.pr_number}, head ${row.head_sha.slice(0, 12)}, `
        + `${result?.review_outcome === 'partial' ? '부분 검토' : '검토 완료'}, 지적 ${result?.findings.length ?? 0}건(인라인 ${row.comments.length}). `
        + '참고 리뷰이며 승인·병합 판단이 아닙니다.';
      await this.store.enqueue({ key: `review-summary:${row.id}`, actor: context.base.owner, scope, revision: context.base.revision,
        payload: { kind: 'message', channel: scope.channel, content, classification: 'safe_summary' } }, tx);
    });
  }
  private async state(row: DeliveryRow, state: string, reason: string): Promise<void> {
    await this.store.db.query(`UPDATE review_deliveries SET state=$3,reason=$4,available_at=CASE WHEN $3='unknown' THEN $5 ELSE available_at END
      WHERE id=$1 AND lease_token=$2 AND state='sending'`, [row.id, row.lease_token, state, reason, this.store.now()]);
    if (state === 'blocked') await this.store.audit('review_delivery_blocked', row.id, { reason, resend: false });
  }
}

// EVENT-03: 봇 중단 중 놓친 PR을 허용 저장소의 열린 PR로 대조한다. 설치 전 PR과 실행 한도 밖은 넣지 않는다.
export class ReviewReconciler {
  constructor(private readonly store: Store, private readonly policy: ReviewPolicySource, private readonly queue: ReviewQueue,
    private readonly reader: GitHubReader, private readonly shutdown?: AbortSignal) {}
  async run(): Promise<{ admitted: number; limited: boolean }> {
    const context = await this.policy.current();
    let admitted = 0;
    for (const repo of context.review.repositories) {
      for (let page = 1; page <= context.review.reconcile.maxPages; page++) {
        if (this.shutdown?.aborted) return { admitted, limited: false };
        const prs = (await this.reader.openPullRequests(repo.fullName, page)).map(pullRequest);
        for (const pr of prs) {
          if (this.shutdown?.aborted) return { admitted, limited: false };
          if (pr.updatedAt < context.review.reviewSince) continue;
          if (admitted >= context.review.reconcile.maxReviewsPerRun) {
            await this.store.audit('review_reconcile_limit', repo.fullName, { admitted });
            return { admitted, limited: true };
          }
          const result = await this.queue.admitLive(pr, repo, context, 'reconcile');
          // 되살린 세대도 모델 호출 후보라 같은 예산에 센다.
          if (result.outcome === 'queued' || result.outcome === 'requeued') admitted++;
        }
        if (prs.length < 100) break;
      }
    }
    return { admitted, limited: false };
  }
}
