import { createHash, sign, verify } from 'node:crypto';
import type { KeyObject } from 'node:crypto';
import { z } from 'zod';
import { AnswerSchema, DEFAULTS, Denied, SYSTEM_INSTRUCTIONS, WorkerRejected } from './contracts.js';
import type { Answer, Clock, Job } from './contracts.js';

export const WorkerRequestSchema = z.strictObject({
  version: z.literal(1), job: z.string().uuid(), lease: z.string().uuid(),
  lane: z.enum(['chat', 'task']), policyRevision: z.string(),
  instructions: z.literal(SYSTEM_INSTRUCTIONS),
  untrusted: z.array(z.unknown()).max(DEFAULTS.contextMessages),
  timeoutMs: z.number().int().positive().max(DEFAULTS.taskTimeoutMs),
  toolCalls: z.number().int().min(0).max(DEFAULTS.maxToolCalls),
});
export type WorkerRequest = z.infer<typeof WorkerRequestSchema>;
export const CancelRequestSchema = z.strictObject({ job: z.string().uuid(), lease: z.string().uuid() });
export type CancelRequest = z.infer<typeof CancelRequestSchema>;
export type WorkerResult =
  | { status: 'succeeded'; answer: Answer; stopped: true }
  | { status: 'limited' | 'auth_expired' | 'failed'; stopped: true }
  | { status: 'unknown'; stopped: false };
export interface WorkerClient {
  execute(request: WorkerRequest, capability: string, signal: AbortSignal): Promise<WorkerResult>;
  cancel(request: CancelRequest, capability: string): Promise<{ stopped: boolean }>;
}
const CapabilitySchema = z.strictObject({
  audience: z.literal('homelab-worker'), operation: z.enum(['execute', 'cancel']),
  job: z.string().uuid(), lease: z.string().uuid(), digest: z.string().length(64),
  issued: z.number().int(), expires: z.number().int(),
});
export class WorkerSigner {
  constructor(private readonly privateKey: KeyObject, private readonly now: Clock = Date.now) {}
  issue(job: Job, operation: 'execute' | 'cancel', body: unknown): string {
    const issued = this.now();
    const payload = Buffer.from(JSON.stringify({ audience: 'homelab-worker', operation, job: job.id,
      lease: job.lease_token, digest: digest(body), issued, expires: issued + 30_000 })).toString('base64url');
    return `${payload}.${sign(null, Buffer.from(payload), this.privateKey).toString('base64url')}`;
  }
}
const digest = (body: unknown) => createHash('sha256').update(JSON.stringify(body)).digest('hex');
// Node's base64url decoder skips padding, foreign characters and unused trailing bits, so one capability
// has many spellings. Only the spelling that re-encodes to itself is accepted.
const canonical = (part: string) => Buffer.from(part, 'base64url').toString('base64url') === part;
export class WorkerVerifier {
  constructor(private readonly publicKey: KeyObject,
    private readonly consume: (nonce: string) => Promise<boolean>, private readonly now: Clock = Date.now) {}
  async check(token: string, operation: 'execute' | 'cancel', body: { job: string; lease: string }): Promise<void> {
    try {
      const pieces = token.split('.');
      if (pieces.length !== 2) throw new Denied();
      const [payload, signature] = pieces as [string, string];
      if (!canonical(payload) || !canonical(signature)) throw new Denied();
      const signed = Buffer.from(payload);
      if (!verify(null, signed, this.publicKey, Buffer.from(signature, 'base64url'))) throw new Denied();
      const c = CapabilitySchema.parse(JSON.parse(Buffer.from(payload, 'base64url').toString()));
      const now = this.now();
      // The nonce is the signed payload, not the token text: Ed25519 gives one signature per payload,
      // so a capability is spent once however its signature is spelled.
      if (c.operation !== operation || c.job !== body.job || c.lease !== body.lease
        || c.digest !== digest(body) || c.issued > now + DEFAULTS.capabilitySkewMs || c.expires <= now
        || c.expires <= c.issued || c.expires - c.issued > 30_000
        || !await this.consume(createHash('sha256').update(signed).digest('hex'))) throw new Denied();
    } catch { throw new Denied(); }
  }
}
export function workerRequest(job: Job, context: unknown[]): WorkerRequest {
  return WorkerRequestSchema.parse({ version: 1, job: job.id, lease: job.lease_token, lane: job.type,
    policyRevision: job.revision.policy, instructions: SYSTEM_INSTRUCTIONS, untrusted: context,
    timeoutMs: job.budget.timeoutMs, toolCalls: job.budget.toolCalls });
}

// Used by the mock HTTP worker and, after T16b verification, a process adapter.
// A mutex is also enforced here, independently of the publisher's SQL scheduler.
export class SerialWorker implements WorkerClient {
  private busy: { job: string; lease: string } | undefined;
  constructor(private readonly verifier: WorkerVerifier,
    private readonly run: (r: WorkerRequest, s: AbortSignal) => Promise<WorkerResult>,
    private readonly stop: (request: CancelRequest) => Promise<boolean>) {}
  async execute(input: WorkerRequest, capability: string, signal: AbortSignal): Promise<WorkerResult> {
    let r: WorkerRequest;
    try {
      r = WorkerRequestSchema.parse(input);
      await this.verifier.check(capability, 'execute', r);
    } catch { throw new WorkerRejected(); }
    if (this.busy) throw new WorkerRejected('worker_busy');
    const active = { job: r.job, lease: r.lease };
    this.busy = active;
    try {
      const result = await this.run(r, signal);
      if (!result.stopped) return { status: 'unknown', stopped: false };
      if (this.busy === active) this.busy = undefined;
      if (result.status === 'succeeded' && !AnswerSchema.safeParse(result.answer).success) return { status: 'failed', stopped: true };
      return result;
    } catch {
      // A broken response is not proof that a process stopped.
      return { status: 'unknown', stopped: false };
    }
  }
  async cancel(input: CancelRequest, capability: string): Promise<{ stopped: boolean }> {
    const request = CancelRequestSchema.parse(input);
    await this.verifier.check(capability, 'cancel', request);
    const active = this.busy;
    if (active?.job !== request.job || active.lease !== request.lease) return { stopped: false };
    const stopped = await this.stop(request);
    if (stopped && this.busy === active) this.busy = undefined;
    return { stopped };
  }
}

export function archiveContract(repository: string, base: string, head: string) {
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repository)
    || !/^[a-f0-9]{40}$/.test(base) || !/^[a-f0-9]{40}$/.test(head)) throw new Denied();
  return Object.freeze({
    base: `https://codeload.github.com/${repository}/tar.gz/${base}`,
    head: `https://codeload.github.com/${repository}/tar.gz/${head}`,
    credentials: 'none', redirect: 'error', history: false,
    initialization: ['git init', 'git add --all', 'git commit --no-verify -m baseline'],
    diffSource: 'base_and_head_archives', publishing: 'publisher_only',
  });
}

// Declarative launch contract only: this module never starts a CLI or reads a home directory.
// 실제 대화 레인 argv는 codex-chat.ts의 chatArgs다. 샌드박스(read-only)는 플래그가 아니라 config.toml에 둔다.
export const CODEX_CONTRACT = Object.freeze({
  pinnedVersion: '0.163.0',
  command: ['codex', 'exec', '--json', '--ephemeral', '--skip-git-repo-check', '--output-schema', 'answer.schema.json',
    '-o', 'last-message.json', '-'],
  codeSource: 'codeload.github.com', home: 'worker_dedicated_persistent',
  seed: 'only_if_auth_json_missing', environmentInheritance: 'none',
  githubCredentials: false, concurrency: 1, authFallback: 'none',
  onLimit: 'waiting_user', waitReasons: ['model_limit', 'auth_expired'],
});
