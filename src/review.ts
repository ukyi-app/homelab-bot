import { createHash, createHmac, randomUUID, timingSafeEqual } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { z } from 'zod';
import { DEFAULTS, Denied, PolicyUnavailable, WorkerRejected } from './contracts.js';
import type { Job, Scope } from './contracts.js';
import type { Database } from './database.js';
import type { Policy, PolicyGate } from './policy.js';
import type { Store } from './store.js';
import type { CancelRequest, WorkerSigner } from './worker.js';
import { archiveContract } from './worker.js';
import { CoverageSchema, FindingSchema, InputLimitsSchema, REVIEW_INSTRUCTIONS, ReviewOutputSchema, ReviewTaskSchema,
  reviewOutcome } from './review-input.js';
import type { Change, Coverage, ReviewOutput, ReviewTask, ReviewWorkerResult } from './review-input.js';

// PR_REVIEW(T17) 게시 서버 쪽. 모델 호출 전 작성자 확인(D-16), 세대 단위 작업, COMMENT만 게시하는 제한 게시.
const Sha = z.string().regex(/^[a-f0-9]{40}$/);
const RepoName = z.string().regex(/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/);
export const ReviewPolicySchema = z.strictObject({
  repositories: z.array(z.strictObject({ id: z.number().int().positive(), fullName: RepoName,
    installationId: z.number().int().positive(), visibility: z.enum(['public', 'private']) })).max(50),
  // 실제 ID는 Infisical runtime policy(review.allowed_bot_author_ids)에만 둔다.
  allowedBotAuthorIds: z.array(z.number().int().positive()).max(20),
  commentCommand: z.string().trim().min(1).max(100).nullable(),
  reviewDrafts: z.boolean(), rereviewOnBaseMove: z.boolean().nullable(),
  reviewSince: z.number().int().nonnegative(), internalMarkers: z.array(z.string().min(4).max(200)).max(100),
  input: InputLimitsSchema,
  publish: z.strictObject({ maxFindings: z.number().int().positive().max(50),
    maxInlineComments: z.number().int().nonnegative().max(50), maxBodyChars: z.number().int().positive().max(65_536) }).nullable(),
  reconcile: z.strictObject({ maxPages: z.number().int().positive().max(10), maxReviewsPerRun: z.number().int().positive().max(20) }),
});
export type ReviewPolicy = z.infer<typeof ReviewPolicySchema>;
export interface ReviewContext { base: Policy; review: ReviewPolicy; revision: string }
export const MODEL_CALL_ASSOCIATIONS = Object.freeze(['OWNER', 'MEMBER', 'COLLABORATOR']);
// 권한 필드(허용 목록·저장소)는 매번 다시 검사하므로 세대 revision에는 리뷰 내용에 닿는 값만 넣는다.
export function reviewRevision(review: ReviewPolicy): string {
  return `rp-${createHash('sha256').update(JSON.stringify([REVIEW_INSTRUCTIONS, review.input])).digest('hex').slice(0, 16)}`;
}
export class ReviewPolicySource {
  constructor(private readonly gate: PolicyGate) {}
  async current(): Promise<ReviewContext> {
    const base = await this.gate.current();
    const parsed = ReviewPolicySchema.safeParse(base.review);
    if (!parsed.success) throw new Denied();
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
  compare(repository: string, base: string, head: string): Promise<unknown>;
  reviews(repository: string, number: number, page: number): Promise<unknown[]>;
}
const CompareSchema = z.strictObject({ files: ReviewTaskSchema.shape.changes, truncated: z.boolean() });
const RemoteReview = z.object({ id: z.number().int(), commit_id: z.string().nullable(), body: z.string().nullable() });
const ReviewWriteSchema = z.strictObject({
  method: z.literal('POST'), path: z.string().regex(/^\/repos\/[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+\/pulls\/[1-9]\d*\/reviews$/),
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
  superseded_reason: string | null; superseded_at: string | null;
}
type Admission = { outcome: 'queued' | 'requeued' | 'duplicate_generation' | 'stale_event' | 'base_moved'; key: string; job?: string };
export const generationKey = (repo: number, pr: number, head: string, comparison: string, policy: string) =>
  `github:review:${repo}:${pr}:${head}:${comparison}:${policy}`;
const json = (value: unknown) => JSON.stringify(value);
export class ReviewQueue {
  constructor(private readonly store: Store) {}
  // 세대 키 (repo_id, pr, head_sha, comparison_revision, policy_revision)로 작업 한 건만 만든다(EVENT-01).
  async admit(pr: PullRequest, repo: ReviewPolicy['repositories'][number], context: ReviewContext,
    trigger: string, deliveryId: string, tx: Database): Promise<Admission | Decision> {
    const decision = pullRequestDecision(pr, repo, context.review, trigger === 'comment');
    if (decision) return decision;
    const now = this.store.now();
    await tx.query(`INSERT INTO controls VALUES ('review_admission','false') ON CONFLICT DO NOTHING`);
    await tx.query(`SELECT * FROM controls WHERE key='review_admission' FOR UPDATE`);
    const key = generationKey(repo.id, pr.number, pr.head.sha, pr.base.sha, context.revision);
    const existing = (await tx.query<{ job_id: string; state: string; attempt: number }>(`SELECT p.job_id,j.state,j.attempt
      FROM pr_reviews p JOIN jobs j ON j.id=p.job_id WHERE p.generation_key=$1`, [key])).rows[0];
    // 대기·진행·완료된 같은 세대는 다시 넣지 않는다(직렬 1개, D-14). 닫힘·draft·옛 이벤트로 밀려난 세대가
    // 다시 live가 됐거나, 명시 요청이 확인된 실패를 다시 부를 때만 같은 작업을 되살린다. 세대당 모델 호출은 재시도 한도로 묶는다.
    const revive = existing && existing.attempt <= DEFAULTS.maxRetries
      && (existing.state === 'superseded' || (trigger === 'comment' && existing.state === 'failed'));
    if (existing && !revive) return { outcome: 'duplicate_generation', key, job: existing.job_id };
    const latest = (await tx.query<ReviewRow>(`SELECT * FROM pr_reviews WHERE repo_id=$1 AND pr_number=$2
      ORDER BY pr_updated_at DESC,created_at DESC LIMIT 1`, [repo.id, pr.number])).rows[0];
    // 늦게 도착한 옛 이벤트가 새 세대를 밀어내지 않게 한다. 실행 직전 live 조회가 한 번 더 막는다.
    if (latest && Number(latest.pr_updated_at) > pr.updatedAt) return { outcome: 'stale_event', key };
    if (existing) {
      const queued = (await tx.query<{ count: string }>("SELECT count(*) FROM jobs WHERE state='queued'")).rows[0]!;
      if (Number(queued.count) >= DEFAULTS.maxQueue) throw new Error('queue_full');
      await this.supersede(tx, repo.id, pr.number, 'new_generation', key);
      await tx.query(`UPDATE jobs SET state='queued',available_at=$2,wait_reason=NULL,finished_at=NULL,lease_token=NULL,lease_until=NULL
        WHERE id=$1 AND state IN ('superseded','failed')`, [existing.job_id, now]);
      await tx.query(`UPDATE pr_reviews SET review_outcome=NULL,result=NULL,superseded_at=NULL,superseded_reason=NULL,pr_updated_at=$2
        WHERE job_id=$1`, [existing.job_id, pr.updatedAt]);
      return { outcome: 'requeued', key, job: existing.job_id };
    }
    const baseOnly = latest && latest.head_sha === pr.head.sha && latest.comparison_revision !== pr.base.sha
      && latest.policy_revision === context.revision;
    const rereview = !baseOnly || trigger === 'retarget' || trigger === 'comment' || context.review.rereviewOnBaseMove === true;
    if (rereview) {
      const queued = (await tx.query<{ count: string }>("SELECT count(*) FROM jobs WHERE state='queued'")).rows[0]!;
      if (Number(queued.count) >= DEFAULTS.maxQueue) throw new Error('queue_full');
    }
    const reason = baseOnly ? 'base_moved' : latest && latest.head_sha === pr.head.sha ? 'policy_changed' : 'new_head';
    await this.supersede(tx, repo.id, pr.number, reason, key);
    if (!rereview) return { outcome: 'base_moved', key };
    const event = randomUUID(), job = randomUUID();
    await tx.query(`INSERT INTO events(id,provider,delivery_id,semantic_key,actor_id,scope,conversation_id,received_at,payload,accepted)
      VALUES ($1,'github',$2,$3,$4,$5,NULL,$6,$7,true)`, [event, deliveryId, key, `github:${pr.author.id}`,
      json({ kind: 'github', repo: repo.id, pr: pr.number }), now, json({ command: 'review', trigger })]);
    await tx.query(`INSERT INTO jobs(id,event_id,conversation_id,type,owner_id,target,revision,budget,priority,available_at,created_at)
      VALUES ($1,$2,NULL,'review','github-review',$3,$4,$5,40,$6,$6)`, [job, event, json({ kind: 'github', repo: repo.id, pr: pr.number }),
      json({ policy: context.revision, head: pr.head.sha, comparison: pr.base.sha }),
      json({ timeoutMs: DEFAULTS.taskTimeoutMs, toolCalls: 0 }), now]);
    await tx.query(`INSERT INTO pr_reviews(job_id,generation_key,installation_id,repo_id,repo_full_name,pr_number,head_sha,
      comparison_revision,base_ref,policy_revision,trigger,pr_updated_at,created_at) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)`,
    [job, key, repo.installationId, repo.id, repo.fullName, pr.number, pr.head.sha, pr.base.sha, pr.base.ref, context.revision,
      trigger, pr.updatedAt, now]);
    return { outcome: 'queued', key, job };
  }
  // 새 세대·닫힘·병합이면 대기 작업과 미게시 결과를 superseded로. 실행 중인 작업은 끝날 때 결과가 superseded로 남는다.
  async supersede(tx: Database, repo: number, pr: number, reason: string, except = ''): Promise<void> {
    const now = this.store.now();
    await tx.query(`UPDATE jobs SET state='superseded',wait_reason=$4,finished_at=$5 WHERE state='queued' AND id IN
      (SELECT job_id FROM pr_reviews WHERE repo_id=$1 AND pr_number=$2 AND generation_key<>$3)`, [repo, pr, except, reason, now]);
    await tx.query(`UPDATE review_deliveries SET state='superseded',reason=$3 WHERE repo_id=$1 AND pr_number=$2 AND state='pending'`, [repo, pr, reason]);
    await tx.query(`UPDATE pr_reviews SET superseded_at=$4,superseded_reason=$5,
      review_outcome=CASE WHEN review_outcome IS NULL OR review_outcome IN ('completed','partial') THEN 'superseded' ELSE review_outcome END
      WHERE repo_id=$1 AND pr_number=$2 AND generation_key<>$3 AND superseded_at IS NULL`, [repo, pr, except, now, reason]);
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
      if (error instanceof Denied) return this.record(delivery, event, null, { outcome: 'ignored', reason: 'review_disabled' });
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
      if (e.action === 'closed' || e.action === 'converted_to_draft') {
        const reason = e.action === 'converted_to_draft' ? 'draft' : pr.merged ? 'merged_before_review' : 'pr_closed';
        return this.record(delivery, event, target, async tx => {
          await this.queue.supersede(tx, repo.id, pr.number, reason);
          return { outcome: 'superseded', reason };
        });
      }
      const trigger = ['opened', 'reopened', 'ready_for_review', 'synchronize'].includes(e.action) ? e.action
        : e.action === 'edited' && e.changes?.base ? 'retarget' : undefined;
      if (!trigger) return this.record(delivery, event, target, { outcome: 'ignored', reason: `action_${e.action}`.slice(0, 60) });
      return this.record(delivery, event, target, tx => this.queue.admit(pr, repo, context, trigger, delivery, tx));
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
      return this.record(delivery, event, target, tx => this.queue.admit(pr, repo, context, 'comment', delivery, tx));
    }
    return this.record(delivery, event, null, { outcome: 'ignored', reason: 'unsupported_event' });
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
const SECRET_PATTERNS = [/\b(?:ghp|gho|ghs|ghu|ghr|github_pat)_[A-Za-z0-9_]{20,}/, /\bsk-[A-Za-z0-9_-]{20,}/,
  /-----BEGIN [A-Z ]*PRIVATE KEY-----/, /\b[a-z0-9-]+\.ts\.net\b/i, /\b100\.(?:6[4-9]|[7-9]\d|1[01]\d|12[0-7])\.\d{1,3}\.\d{1,3}\b/,
  /"refresh_token"\s*:/];
export function classify(output: Pick<ReviewOutput, 'findings' | 'open_questions' | 'public_summary'>, review: ReviewPolicy): ReviewResult['output_classification'] {
  // JSON 문자열화는 따옴표를 이스케이프해 패턴을 피해 가므로 원문 문자열을 그대로 모은다.
  const text = [...output.findings.flatMap(f => Object.values(f).map(String)), ...output.open_questions, output.public_summary].join('\n');
  const lower = text.toLowerCase();
  if (SECRET_PATTERNS.some(pattern => pattern.test(text)) || review.internalMarkers.some(m => lower.includes(m.toLowerCase()))) return 'restricted';
  return 'public';
}
const asJob = (row: Record<string, unknown>) => row as unknown as Job;
export const notificationScope = (policy: Policy): Scope => ({ guild: policy.guild, channel: policy.notificationChannel, parent: null, kind: 'channel' });

export interface ReviewWorkerClient {
  review(task: ReviewTask, capability: string, signal: AbortSignal): Promise<ReviewWorkerResult>;
  cancel(request: CancelRequest, capability: string): Promise<{ stopped: boolean }>;
}
export class ReviewRuntime {
  constructor(private readonly store: Store, private readonly policy: ReviewPolicySource, private readonly queue: ReviewQueue,
    private readonly reader: GitHubReader, private readonly worker: ReviewWorkerClient, private readonly signer: WorkerSigner,
    private readonly pollMs = 1000) {}
  // T16a의 claim과 같은 scheduler 잠금·전역 슬롯 조건을 쓴다. 리뷰도 대화와 같은 auth.json 직렬 1개다(D-14).
  async claim(): Promise<(Job & Record<string, unknown>) | undefined> {
    return this.store.db.transaction(async tx => {
      await tx.query(`INSERT INTO controls VALUES ('scheduler','false') ON CONFLICT DO NOTHING`);
      const control = (await tx.query<{ value: boolean }>(`SELECT value FROM controls WHERE key='scheduler' FOR UPDATE`)).rows[0]!;
      if (control.value) return;
      if ((await tx.query(`SELECT id FROM jobs WHERE state IN ('running','verifying','cancel_requested','unknown','waiting_user') LIMIT 1`)).rows.length) return;
      const row = (await tx.query<{ id: string }>(`SELECT id FROM jobs WHERE type='review' AND state='queued' AND available_at<=$1
        ORDER BY priority,created_at FOR UPDATE SKIP LOCKED LIMIT 1`, [this.store.now()])).rows[0];
      if (!row) return;
      return (await tx.query<Job & Record<string, unknown>>(`UPDATE jobs SET state='running',attempt=attempt+1,lease_token=$2,
        lease_until=$3,started_at=$4 WHERE id=$1 RETURNING *`, [row.id, randomUUID(), this.store.now() + DEFAULTS.leaseMs, this.store.now()])).rows[0];
    });
  }
  async tick(): Promise<boolean> {
    await this.store.expire();
    const job = await this.claim();
    if (!job) return false;
    const review = (await this.store.db.query<ReviewRow>('SELECT * FROM pr_reviews WHERE job_id=$1', [job.id])).rows[0]!;
    let dispatched = false;
    try {
      const context = await this.policy.current();
      const repo = context.review.repositories.find(r => String(r.id) === String(review.repo_id)
        && String(r.installationId) === String(review.installation_id) && r.fullName === review.repo_full_name);
      if (!repo) { await this.close(job, review, 'cancelled', 'authorization_revoked'); return true; }
      if (context.revision !== review.policy_revision) { await this.close(job, review, 'superseded', 'policy_changed'); return true; }
      // 실행 직전 live PR로 head·base·닫힘·작성자를 다시 본다. webhook 내용만 믿지 않는다.
      const pr = pullRequest(await this.reader.pullRequest(repo.fullName, review.pr_number));
      const stale = !pr.open ? (pr.merged ? 'merged_before_review' : 'pr_closed')
        : pr.head.sha !== review.head_sha ? 'stale_head' : pr.base.sha !== review.comparison_revision ? 'base_moved' : undefined;
      if (stale) {
        await this.close(job, review, 'superseded', stale);
        // 늦게 온 옛 이벤트나 base 이동이면 live 세대를 같은 규칙으로 넣는다. 닫혔으면 남은 대기 작업도 정리한다.
        await this.store.db.transaction<unknown>(tx => pr.open ? this.queue.admit(pr, repo, context, 'live_check', `live:${randomUUID()}`, tx)
          : this.queue.supersede(tx, repo.id, pr.number, stale));
        return true;
      }
      const denied = pullRequestDecision(pr, repo, context.review, review.trigger === 'comment');
      if (denied) { await this.close(job, review, denied.outcome === 'denied' ? 'cancelled' : 'superseded', denied.reason); return true; }
      let compare: { files: Change[]; truncated: boolean };
      try { compare = CompareSchema.parse(await this.reader.compare(repo.fullName, review.comparison_revision, review.head_sha)); }
      catch (error) {
        if (error instanceof GitHubError && (error.status === 429 || error.status >= 500)) { await this.store.defer(asJob(job), 'github_unavailable'); return true; }
        // 열거 실패를 압축본 비교로 대신하지 않는다(REVIEW-03).
        await this.close(job, review, 'failed', 'enumeration_failed'); return true;
      }
      const contract = archiveContract(repo.fullName, review.comparison_revision, review.head_sha);
      const task = ReviewTaskSchema.parse({ version: 1, job: job.id, lease: job.lease_token, lane: 'review',
        repository: repo.fullName, base: review.comparison_revision, head: review.head_sha,
        archives: { base: contract.base, head: contract.head }, changes: compare.files, truncated: compare.truncated,
        pullRequest: { title: pr.title.slice(0, 1000), body: pr.body.slice(0, 65_536) }, limits: context.review.input,
        policyRevision: context.revision, instructions: REVIEW_INSTRUCTIONS, timeoutMs: DEFAULTS.taskTimeoutMs });
      const abort = new AbortController();
      let timeout: ReturnType<typeof setTimeout> | undefined;
      let checking: Promise<void> | undefined;
      const interrupted = new Promise<ReviewWorkerResult>(resolve => {
        abort.signal.addEventListener('abort', () => resolve({ status: 'unknown', stopped: false }), { once: true });
      });
      // 비상 중지·취소 요청·lease 상실을 실행 중에도 본다(T16a 대화 레인과 같은 규칙).
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
      } finally { clearInterval(monitor); clearTimeout(timeout); await checking; }
      const current = (await this.store.db.query<{ state: string }>('SELECT state FROM jobs WHERE id=$1', [job.id])).rows[0]?.state;
      if (current === 'cancel_requested' || abort.signal.aborted) {
        const body = { job: job.id, lease: job.lease_token };
        const confirmation = result.stopped ? { stopped: true }
          : await this.worker.cancel(body, this.signer.issue(asJob(job), 'cancel', body)).catch(() => ({ stopped: false }));
        // 멈춤을 확인하지 못하면 unknown으로 두어 전역 슬롯을 잡는다. 자동 재실행하지 않는다.
        const state = !confirmation.stopped ? 'unknown' : current === 'cancel_requested' ? 'cancelled' : 'failed';
        if (state === 'unknown') await this.store.transition(asJob(job), 'unknown', 'stop_confirmation');
        else await this.close(job, review, state, 'stop_confirmation');
        return true;
      }
      if (!result.stopped) { await this.store.transition(asJob(job), 'unknown', 'worker_disconnected'); return true; }
      if (result.status === 'limited' || result.status === 'auth_expired') {
        await this.store.waitForUser(asJob(job), result.status === 'limited' ? 'model_limit' : 'auth_expired'); return true;
      }
      if (result.status !== 'succeeded') { await this.close(job, review, 'failed', result.reason ?? 'model_failed'); return true; }
      await this.finish(job, review, context, task, result);
    } catch (error) {
      if (error instanceof WorkerRejected) await this.close(job, review, 'failed', 'worker_rejected');
      else if (!dispatched && error instanceof PolicyUnavailable) await this.store.defer(asJob(job));
      else if (!dispatched && error instanceof GitHubError && (error.status === 429 || error.status >= 500)) await this.store.defer(asJob(job), 'github_unavailable');
      else if (!dispatched) await this.close(job, review, error instanceof Denied ? 'cancelled' : 'failed',
        error instanceof Denied ? 'authorization_revoked' : error instanceof GitHubError ? 'github_access_lost' : 'before_dispatch');
      else await this.store.transition(asJob(job), 'unknown', 'runtime_uncertain');
    }
    return true;
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
      await tx.query('UPDATE pr_reviews SET result=$2,review_outcome=$3 WHERE job_id=$1', [job.id, json({ ...reviewed, review_outcome: outcome }), outcome]);
      if (current.superseded_at) return;
      if (classification === 'restricted') {
        await tx.query('INSERT INTO audit(kind,subject,detail,created_at) VALUES ($1,$2,$3,$4)',
          ['review_restricted', job.id, json({ reason: 'output_classification', resend: false }), this.store.now()]);
        await this.notify(tx, context, `review-restricted:${job.id}`, `PR 리뷰 결과를 공개 범위 검사에서 차단했습니다: ${review.repo_full_name}#${review.pr_number}. 게시하지 않았습니다.`);
        return;
      }
      const rendered = context.review.publish && render(reviewed, positions.data, context.review.publish, `github-review:${job.id}`);
      await tx.query(`INSERT INTO review_deliveries(id,job_id,idempotency_key,repo_id,repo_full_name,pr_number,head_sha,comparison_revision,
        policy_revision,body,comments,state,reason,available_at,created_at) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$14)
        ON CONFLICT (idempotency_key) DO NOTHING`, [randomUUID(), job.id, `github-review:${job.id}`, review.repo_id, review.repo_full_name,
        review.pr_number, task.head, task.base, task.policyRevision, rendered ? rendered.body : '', json(rendered ? rendered.comments : []),
        rendered ? 'pending' : 'blocked', rendered ? null : context.review.publish ? 'publish_limit_exceeded' : 'publish_limits_unset', this.store.now()]);
    });
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
export const reviewMarker = (key: string) => `<!-- homelab-bot-review:${key} -->`;
// 게시 본문은 코드가 만든다. 모델 텍스트는 지적 칸 안의 자료로만 들어가고 event·대상은 상수다.
export function render(result: ReviewResult, positions: { path: string; lines: number[] }[],
  limits: NonNullable<ReviewPolicy['publish']>, key: string): { body: string; comments: { path: string; line: number; side: 'RIGHT'; body: string }[] } | null {
  const findings = [...result.findings].sort((a, b) => SEVERITY.indexOf(a.severity) - SEVERITY.indexOf(b.severity));
  const shown = findings.slice(0, limits.maxFindings);
  const comments: { path: string; line: number; side: 'RIGHT'; body: string }[] = [];
  const valid = new Map(positions.map(p => [p.path, new Set(p.lines)]));
  const entry = (f: ReviewResult['findings'][number]) => `**[${f.severity}] ${inert(f.title)}**\n- 조건: ${inert(f.condition)}\n- 영향: ${inert(f.impact)}\n- 근거: ${inert(f.evidence)}\n- 개선: ${inert(f.suggestion)}`;
  for (const f of shown) if (f.line && valid.get(f.path)?.has(f.line) && comments.length < limits.maxInlineComments) {
    comments.push({ path: f.path, line: f.line, side: 'RIGHT', body: entry(f) });
  }
  const omitted = result.coverage.omitted_files_with_reasons;
  const lines = [reviewMarker(key), '**자동 참고 리뷰**: 승인·병합 판단이 아니며 안전을 보증하지 않습니다.',
    `- 검토 리비전: head \`${result.head_sha}\`, 기준 \`${result.comparison_revision}\`, 정책 \`${result.policy_revision}\``,
    `- 결과: ${result.review_outcome === 'partial' ? '부분 검토' : '검토 완료'}. 확인 파일 ${result.coverage.checked_files.length}개, 제외 ${omitted.length}개`
      + (result.coverage.limits_hit.length ? `, 상한: ${result.coverage.limits_hit.join(', ')}` : ''),
    ...omitted.slice(0, 20).map(o => `  - 미검토 \`${o.path}\`: ${o.reason}`),
    ...(omitted.length > 20 ? [`  - 미검토 ${omitted.length - 20}개 더 있음`] : []),
    '', inert(result.public_summary), ''];
  lines.push(shown.length ? '### 지적' : '### 지적 없음');
  for (const f of shown) lines.push(`${entry(f)}\n- 위치: \`${inert(f.path)}\`${f.line ? `:${f.line}` : ''}`);
  if (findings.length > shown.length) lines.push(`- 상한으로 ${findings.length - shown.length}건 생략`);
  if (result.open_questions.length) lines.push('### 확인 질문', ...result.open_questions.map(q => `- ${inert(q)}`));
  const body = lines.join('\n');
  return body.length > limits.maxBodyChars ? null : { body, comments };
}

interface DeliveryRow {
  id: string; job_id: string; idempotency_key: string; repo_id: string; repo_full_name: string; pr_number: number;
  head_sha: string; comparison_revision: string; policy_revision: string; body: string;
  comments: { path: string; line: number; side: 'RIGHT'; body: string }[]; state: string; attempt: number;
  lease_token: string; external_id: string | null;
}
export class ReviewPublisher {
  constructor(private readonly store: Store, private readonly policy: ReviewPolicySource, private readonly reader: GitHubReader,
    private readonly github: RestrictedGitHub) {}
  async deliver(): Promise<boolean> {
    // 게시 중 죽은 프로세스의 lease를 회수한다. 전송을 시작했으면 결과를 모르므로 unknown(재게시 없이 대조).
    await this.store.db.query(`UPDATE review_deliveries SET state=CASE WHEN dispatch_started THEN 'unknown' ELSE 'pending' END,
      reason=CASE WHEN dispatch_started THEN 'lease_expired' ELSE reason END WHERE state='sending' AND lease_until<=$1`, [this.store.now()]);
    const row = await this.store.db.transaction(async tx => {
      const next = (await tx.query<{ id: string }>(`SELECT id FROM review_deliveries WHERE state='pending' AND available_at<=$1
        ORDER BY created_at FOR UPDATE SKIP LOCKED LIMIT 1`, [this.store.now()])).rows[0];
      if (!next) return;
      return (await tx.query<DeliveryRow>(`UPDATE review_deliveries SET state='sending',attempt=attempt+1,dispatch_started=false,
        lease_token=$2,lease_until=$3 WHERE id=$1 RETURNING *`, [next.id, randomUUID(), this.store.now() + DEFAULTS.leaseMs])).rows[0];
    });
    if (!row) return false;
    let dispatched = false;
    try {
      const context = await this.policy.current();
      const repo = context.review.repositories.find(r => String(r.id) === String(row.repo_id) && r.fullName === row.repo_full_name);
      if (!repo) { await this.state(row, 'blocked', 'authorization_revoked'); return true; }
      if (context.revision !== row.policy_revision) { await this.state(row, 'superseded', 'policy_changed'); return true; }
      if (!context.review.publish) { await this.state(row, 'blocked', 'publish_limits_unset'); return true; }
      if (row.body.length > context.review.publish.maxBodyChars || row.comments.length > context.review.publish.maxInlineComments) {
        await this.state(row, 'blocked', 'publish_limit_exceeded'); return true;
      }
      // 내부 표식 목록은 결과 저장 뒤에도 바뀔 수 있어 게시 직전 현재 정책으로 다시 분류한다(DATA-01).
      const stored = (await this.store.db.query<{ result: ReviewResult }>('SELECT result FROM pr_reviews WHERE job_id=$1', [row.job_id])).rows[0]?.result;
      if (!stored || classify(stored, context.review) !== 'public') { await this.state(row, 'blocked', 'output_classification'); return true; }
      // 게시 직전 최신 PR을 다시 본다. 오래된 리뷰를 최신 검증처럼 올리지 않는다(REVIEW-02).
      const pr = pullRequest(await this.reader.pullRequest(repo.fullName, row.pr_number));
      const stale = !pr.open ? (pr.merged ? 'merged_before_publish' : 'pr_closed')
        : pr.head.sha !== row.head_sha ? 'stale_head' : pr.base.sha !== row.comparison_revision ? 'base_moved' : undefined;
      if (stale) { await this.state(row, 'superseded', stale); return true; }
      if (pr.head.repoId !== pr.base.repoId || !authorAllowed(pr.author, context.review)) { await this.state(row, 'blocked', 'author_denied'); return true; }
      if (row.attempt > 1 && await this.existing(row)) return true;
      const request = { method: 'POST', path: `/repos/${repo.fullName}/pulls/${row.pr_number}/reviews`,
        body: { commit_id: row.head_sha, event: 'COMMENT', body: row.body, comments: row.comments } };
      const expected = { repository: repo.fullName, pr: row.pr_number, head: row.head_sha };
      restrictGitHubWrite(request, expected);
      if (!(await this.store.db.query(`UPDATE review_deliveries SET dispatch_started=true WHERE id=$1 AND lease_token=$2
        AND state='sending' AND lease_until>$3 RETURNING id`, [row.id, row.lease_token, this.store.now()])).rows.length) return true;
      dispatched = true;
      const sent = await this.github.createReview(request, expected);
      await this.sent(row, String(sent.id), context);
    } catch (error) {
      if (dispatched && !(error instanceof GitHubError && error.status < 500 && error.status !== 408)) {
        // 응답을 잃은 게시는 다시 보내지 않고 기존 리뷰를 대조한다(EVENT-02).
        await this.state(row, 'unknown', 'response_lost');
      } else if (error instanceof Denied) await this.state(row, 'blocked', 'github_write_denied');
      else if (error instanceof GitHubError && error.status === 422 && row.comments.length) {
        // 인라인 위치가 무효면 같은 내용을 본문만으로 한 번 더 시도한다.
        await this.store.db.query(`UPDATE review_deliveries SET state='pending',comments='[]',dispatch_started=false,available_at=$3
          WHERE id=$1 AND lease_token=$2`, [row.id, row.lease_token, this.store.now()]);
      } else if (error instanceof GitHubError && [401, 403, 404, 422].includes(error.status) && !error.retryAfterMs) await this.state(row, 'blocked', `github_${error.status}`);
      else if (row.attempt > DEFAULTS.maxRetries) await this.state(row, 'blocked', 'retry_limit');
      else await this.store.db.query(`UPDATE review_deliveries SET state='pending',dispatch_started=false,available_at=$3,reason=$4
        WHERE id=$1 AND lease_token=$2`, [row.id, row.lease_token, this.store.now() + Math.max(DEFAULTS.retryDelayMs,
        error instanceof GitHubError ? error.retryAfterMs : 0), error instanceof PolicyUnavailable ? 'policy_unavailable' : 'retry']);
    }
    return true;
  }
  // 응답 유실 뒤에는 PR의 리뷰 목록에서 marker와 검토 SHA로 찾는다. 못 찾아도 자동 재게시하지 않는다.
  async reconcile(): Promise<void> {
    const retired = await this.store.db.query<{ id: string }>(`UPDATE review_deliveries SET state='blocked',reason='unknown_deadline'
      WHERE state='unknown' AND created_at<=$1 RETURNING id`, [this.store.now() - DEFAULTS.unknownDeliveryMs]);
    for (const row of retired.rows) await this.store.audit('review_delivery_unresolved_retired', row.id, { reason: 'unknown_deadline', resend: false });
    for (const row of (await this.store.db.query<DeliveryRow>("SELECT * FROM review_deliveries WHERE state='unknown' ORDER BY created_at DESC LIMIT 20")).rows) {
      try { await this.existing(row); } catch { /* 다음 대조에서 다시 본다 */ }
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
    await this.store.db.query(`UPDATE review_deliveries SET state=$3,reason=$4 WHERE id=$1 AND lease_token=$2 AND state='sending'`,
      [row.id, row.lease_token, state, reason]);
    if (state === 'blocked') await this.store.audit('review_delivery_blocked', row.id, { reason, resend: false });
  }
}

// EVENT-03: 봇 중단 중 놓친 PR을 허용 저장소의 열린 PR로 대조한다. 설치 전 PR과 실행 한도 밖은 넣지 않는다.
export class ReviewReconciler {
  constructor(private readonly store: Store, private readonly policy: ReviewPolicySource, private readonly queue: ReviewQueue,
    private readonly reader: GitHubReader) {}
  async run(): Promise<{ admitted: number; limited: boolean }> {
    const context = await this.policy.current();
    let admitted = 0;
    for (const repo of context.review.repositories) {
      for (let page = 1; page <= context.review.reconcile.maxPages; page++) {
        const prs = (await this.reader.openPullRequests(repo.fullName, page)).map(pullRequest);
        for (const pr of prs) {
          if (pr.updatedAt < context.review.reviewSince) continue;
          if (admitted >= context.review.reconcile.maxReviewsPerRun) {
            await this.store.audit('review_reconcile_limit', repo.fullName, { admitted });
            return { admitted, limited: true };
          }
          const result = await this.store.db.transaction(tx => this.queue.admit(pr, repo, context, 'reconcile', `reconcile:${randomUUID()}`, tx));
          if (result.outcome === 'queued') admitted++;
        }
        if (prs.length < 100) break;
      }
    }
    return { admitted, limited: false };
  }
}
