import { createHash, sign, verify } from 'node:crypto';
import type { KeyObject } from 'node:crypto';
import { z } from 'zod';
import { AnswerSchema, ChatReplySchema, DEFAULTS, Denied, SYSTEM_INSTRUCTIONS, SYSTEM_INSTRUCTIONS_V2, WORKER_ACCEPT,
  WorkerRejected } from './contracts.js';
import type { Answer, ChatReply, Clock, Job } from './contracts.js';

// 키 순서가 계약이다: capability digest는 schema를 거친 본문의 JSON.stringify라, 순서가 바뀌면 다른 판의 게시 서버가
// 서명한 요청을 작업자가 거부한다. v1은 옛 순서 그대로 두고, 칸을 더할 때는 v2처럼 새 판에만 더한다.
const timeoutMs = z.number().int().positive().max(DEFAULTS.taskTimeoutMs);
const toolCalls = z.number().int().min(0).max(DEFAULTS.maxToolCalls);
export const WorkerRequestV1Schema = z.strictObject({
  version: z.literal(1), job: z.string().uuid(), lease: z.string().uuid(),
  lane: z.enum(['chat', 'task']), policyRevision: z.string(),
  instructions: z.literal(SYSTEM_INSTRUCTIONS),
  untrusted: z.array(z.unknown()).max(WORKER_ACCEPT.contextMessagesV1),
  timeoutMs, toolCalls,
});
// surface: 신뢰 문맥 변형('/' 명령을 안내하는 slash, 말로 하는 일만 안내하는 speech). earlierPurged: 원문 7일 정리로
// 빠진 앞 대화가 있다는 표시. 기록 바이트는 게시 서버 chat-context와 같은 방식(배열 JSON의 UTF-8 바이트)으로 잰다.
export const WorkerRequestV2Schema = z.strictObject({
  version: z.literal(2), job: z.string().uuid(), lease: z.string().uuid(),
  lane: z.enum(['chat', 'task']), policyRevision: z.string(),
  instructions: z.literal(SYSTEM_INSTRUCTIONS_V2),
  surface: z.enum(['slash', 'speech']), earlierPurged: z.boolean(),
  untrusted: z.array(z.unknown()).max(WORKER_ACCEPT.contextMessagesV2)
    .refine(items => Buffer.byteLength(JSON.stringify(items)) <= WORKER_ACCEPT.contextBytesV2, 'context_too_large'),
  timeoutMs, toolCalls,
});
export const WorkerRequestSchema = z.discriminatedUnion('version', [WorkerRequestV1Schema, WorkerRequestV2Schema]);
export type WorkerRequestV1 = z.infer<typeof WorkerRequestV1Schema>;
export type WorkerRequestV2 = z.infer<typeof WorkerRequestV2Schema>;
export type WorkerRequest = WorkerRequestV1 | WorkerRequestV2;
export const CancelRequestSchema = z.strictObject({ job: z.string().uuid(), lease: z.string().uuid() });
export type CancelRequest = z.infer<typeof CancelRequestSchema>;
export type WorkerResult =
  | { status: 'succeeded'; answer: Answer; stopped: true }
  | { status: 'limited' | 'auth_expired' | 'failed'; stopped: true }
  | { status: 'unknown'; stopped: false };
// v2 응답. rateLimit은 C03이 채우기 전까지 null이다. 멈춤을 확인하지 못한 unknown에는 싣지 않는다.
export type WorkerResultV2 =
  | { status: 'succeeded'; output: ChatReply; stopped: true; rateLimit: null }
  | { status: 'limited' | 'auth_expired' | 'failed'; stopped: true; rateLimit: null }
  | { status: 'unknown'; stopped: false };
// 게시 서버가 쓰는 작업자 꼴. 게시 서버는 아직 v1만 보낸다(v2 사용은 C11).
export interface WorkerClient {
  execute(request: WorkerRequestV1, capability: string, signal: AbortSignal): Promise<WorkerResult>;
  cancel(request: CancelRequest, capability: string): Promise<{ stopped: boolean }>;
}
// 작업자 서버가 받는 꼴. 두 판을 모두 받고 요청 판에 맞는 응답 판을 돌려준다(v1 요청에는 v1 모양만).
export interface VersionedWorker {
  execute(request: WorkerRequest, capability: string, signal: AbortSignal): Promise<WorkerResult | WorkerResultV2>;
  cancel(request: CancelRequest, capability: string): Promise<{ stopped: boolean }>;
}
const CapabilitySchema = z.strictObject({
  audience: z.literal('homelab-worker'), operation: z.enum(['execute', 'cancel']),
  job: z.string().uuid(), lease: z.string().uuid(), digest: z.string().length(64),
  issued: z.number().int(), expires: z.number().int(),
});
// 서명 형식은 대화·리뷰·작업 레인이 같다. 무엇을 허가하는지(audience·operation·식별자)는 레인마다 자기 schema가 정한다.
export const CAPABILITY_TTL_MS = 30_000;
export const capabilityDigest = (body: unknown) => createHash('sha256').update(JSON.stringify(body)).digest('hex');
export function sealCapability(claims: object, privateKey: KeyObject): string {
  const payload = Buffer.from(JSON.stringify(claims)).toString('base64url');
  return `${payload}.${sign(null, Buffer.from(payload), privateKey).toString('base64url')}`;
}
// Node's base64url decoder skips padding, foreign characters and unused trailing bits, so one capability
// has many spellings. Only the spelling that re-encodes to itself is accepted.
const canonical = (part: string) => Buffer.from(part, 'base64url').toString('base64url') === part;
// 서명만 확인해 내용과 nonce를 돌려준다. 내용은 아직 믿지 않는다. 호출자가 자기 schema로 검사한 뒤 nonce를 쓴다.
// The nonce is the signed payload, not the token text: Ed25519 gives one signature per payload,
// so a capability is spent once however its signature is spelled.
export function openCapability(token: string, publicKey: KeyObject): { claims: unknown; nonce: string } {
  const pieces = token.split('.');
  if (pieces.length !== 2) throw new Denied();
  const [payload, signature] = pieces as [string, string];
  if (!canonical(payload) || !canonical(signature)) throw new Denied();
  const signed = Buffer.from(payload);
  if (!verify(null, signed, publicKey, Buffer.from(signature, 'base64url'))) throw new Denied();
  return { claims: JSON.parse(Buffer.from(payload, 'base64url').toString()), nonce: createHash('sha256').update(signed).digest('hex') };
}
export const capabilityLive = (c: { issued: number; expires: number }, now: number) =>
  c.issued <= now + DEFAULTS.capabilitySkewMs && c.expires > now && c.expires > c.issued && c.expires - c.issued <= CAPABILITY_TTL_MS;
export class WorkerSigner {
  constructor(private readonly privateKey: KeyObject, private readonly now: Clock = Date.now) {}
  issue(job: Job, operation: 'execute' | 'cancel', body: unknown): string {
    const issued = this.now();
    return sealCapability({ audience: 'homelab-worker', operation, job: job.id,
      lease: job.lease_token, digest: capabilityDigest(body), issued, expires: issued + CAPABILITY_TTL_MS }, this.privateKey);
  }
}
export class WorkerVerifier {
  constructor(private readonly publicKey: KeyObject,
    private readonly consume: (nonce: string) => Promise<boolean>, private readonly now: Clock = Date.now) {}
  async check(token: string, operation: 'execute' | 'cancel', body: { job: string; lease: string }): Promise<void> {
    try {
      const { claims, nonce } = openCapability(token, this.publicKey);
      const c = CapabilitySchema.parse(claims);
      if (c.operation !== operation || c.job !== body.job || c.lease !== body.lease
        || c.digest !== capabilityDigest(body) || !capabilityLive(c, this.now())
        || !await this.consume(nonce)) throw new Denied();
    } catch { throw new Denied(); }
  }
}
export function workerRequest(job: Job, context: unknown[]): WorkerRequestV1 {
  return WorkerRequestV1Schema.parse({ version: 1, job: job.id, lease: job.lease_token, lane: job.type,
    policyRevision: job.revision.policy, instructions: SYSTEM_INSTRUCTIONS, untrusted: context,
    timeoutMs: job.budget.timeoutMs, toolCalls: job.budget.toolCalls });
}

// 작업자의 실행 자리 하나. 대화와 리뷰가 같은 인스턴스를 써서 한쪽이 잡은 동안 다른 쪽을 거절한다.
// SQL 슬롯과 별개의 잠금이고, 리뷰는 모델을 띄우기 전(압축본 받기·diff 계산)에도 자리를 잡는다.
export interface SlotControl { stop(job: string): Promise<boolean>; sweep(): Promise<boolean> }
export interface SlotHolder {
  readonly job: string; readonly lease: string; readonly stop: () => Promise<boolean>;
  // 끝난 뒤의 cancel에도 멈춤을 답한다(리뷰 레인 계약).
  readonly remember: boolean;
  // 실행은 끝났는데 소멸을 확인하지 못해 자리만 잡고 있다.
  locked: boolean;
  stopping?: Promise<boolean>;
}
const MAX_BARRED = 256;
export class ExecutionSlot {
  private held: SlotHolder | undefined;
  private finished: { job: string; lease: string } | undefined;
  // 소멸을 확인해 멈췄다고 답한 job·lease. 게시 서버가 이 답으로 작업을 끝내므로 뒤의 취소가 실패해도 지우지 않는다.
  private readonly barred = new Set<string>();
  // 소멸을 확인하는 중인 취소 수. 겹친 호출 중 마지막이 끝날 때까지 실행을 막는다.
  private readonly probing = new Map<string, number>();
  constructor(private readonly control?: SlotControl) {}
  acquire(job: string, lease: string, stop: () => Promise<boolean>, remember = false): SlotHolder | undefined {
    const key = `${job}:${lease}`;
    if (this.held || this.barred.has(key) || this.probing.has(key)) return undefined;
    this.held = { job, lease, stop, remember, locked: false };
    return this.held;
  }
  lock(holder: SlotHolder): void { holder.locked = true; }
  release(holder: SlotHolder): void {
    if (this.held !== holder) return;
    this.held = undefined;
    if (holder.remember) this.finished = { job: holder.job, lease: holder.lease };
  }
  // 소멸 확인. 실행 제어가 없으면(단독 조립) 확인할 길이 없어 false다.
  async confirmGone(job: string): Promise<boolean> {
    return this.control ? this.control.stop(job).catch(() => false) : false;
  }
  async cancel(request: CancelRequest): Promise<{ stopped: boolean }> {
    const held = this.held;
    if (held?.job === request.job && held.lease === request.lease) {
      // 경로 둘로 cancel이 겹쳐도 정리를 한 번만 한다. 먼저 끝난 쪽이 자리를 놓은 뒤 뒤쪽 sweep이 새 실행 공간을 지우면 안 된다.
      held.stopping ??= this.stopHeld(held).finally(() => { held.stopping = undefined; });
      return { stopped: await held.stopping };
    }
    if (this.finished?.job === request.job && this.finished.lease === request.lease) return { stopped: true };
    if (held || !this.control) return { stopped: false };
    // 잡고 있지 않은 job: 응답 유실·작업자 재시작 뒤의 unknown이 여기로 온다. 프로세스 표식으로 소멸을 확인해 답한다.
    // 이 답을 믿으려면 작업자가 하나여야 한다(sandbox Recreate·replicas 1). 다른 파드가 실행 중이면 여기서 볼 수 없다.
    // 아직 도착 중인 실행 요청이 뒤늦게 자리를 잡지 못하도록 await 전에 막는다.
    const key = `${request.job}:${request.lease}`;
    this.probing.set(key, (this.probing.get(key) ?? 0) + 1);
    let stopped = false;
    try { stopped = await this.confirmGone(request.job); }
    finally {
      const left = this.probing.get(key)! - 1;
      if (left) this.probing.set(key, left); else this.probing.delete(key);
    }
    if (stopped) {
      this.barred.add(key);
      // capability가 30초면 만료라 상한만 둔다. 확인 중인 호출은 probing에 있어 이 상한에 밀려 풀리지 않는다.
      if (this.barred.size > MAX_BARRED) this.barred.delete(this.barred.values().next().value!);
    }
    return { stopped };
  }
  private async stopHeld(holder: SlotHolder): Promise<boolean> {
    if (!await holder.stop()) return false;
    // 소멸을 확인하기 전까지 지우지 않은 실행 공간을 치운다. 잠금은 stop을 기다리는 사이에도 걸리므로(실행 중 취소 뒤 unknown) 기다린 뒤에 본다.
    // 자리를 쥔 동안에만 해서 새 실행의 공간을 건드리지 않는다.
    // 실패하면 잔여물로 남아 새 실행과 readiness를 막으므로 여기서 답을 바꾸지 않는다.
    if (holder.locked && this.held === holder) await this.control?.sweep().catch(() => false);
    this.release(holder);
    return true;
  }
}

// 멈춤을 확인한 실행기 결과를 요청 판의 응답 모양으로 다시 맞춘다. 판이 다르거나 답이 계약 밖이면 성공으로 내보내지 않는다.
function settled(request: WorkerRequest, result: WorkerResult | WorkerResultV2): WorkerResult | WorkerResultV2 {
  if (request.version === 1) {
    if (result.status !== 'succeeded') return { status: result.status as 'limited' | 'auth_expired' | 'failed', stopped: true };
    return 'answer' in result && AnswerSchema.safeParse(result.answer).success
      ? { status: 'succeeded', stopped: true, answer: result.answer } : { status: 'failed', stopped: true };
  }
  const rateLimit = 'rateLimit' in result ? result.rateLimit : null;
  if (result.status !== 'succeeded') return { status: result.status as 'limited' | 'auth_expired' | 'failed', stopped: true, rateLimit };
  return 'output' in result && ChatReplySchema.safeParse(result.output).success
    ? { status: 'succeeded', stopped: true, output: result.output, rateLimit } : { status: 'failed', stopped: true, rateLimit };
}

// Used by the mock HTTP worker and the process adapter.
// A mutex is also enforced here, independently of the publisher's SQL scheduler.
export class SerialWorker implements WorkerClient, VersionedWorker {
  constructor(private readonly verifier: WorkerVerifier,
    private readonly run: (r: WorkerRequest, s: AbortSignal) => Promise<WorkerResult | WorkerResultV2>,
    private readonly stop: (request: CancelRequest) => Promise<boolean>,
    private readonly slot = new ExecutionSlot()) {}
  execute(input: WorkerRequestV1, capability: string, signal: AbortSignal): Promise<WorkerResult>;
  execute(input: WorkerRequestV2, capability: string, signal: AbortSignal): Promise<WorkerResultV2>;
  execute(input: WorkerRequest, capability: string, signal: AbortSignal): Promise<WorkerResult | WorkerResultV2>;
  async execute(input: WorkerRequest, capability: string, signal: AbortSignal): Promise<WorkerResult | WorkerResultV2> {
    let r: WorkerRequest;
    try {
      r = WorkerRequestSchema.parse(input);
      await this.verifier.check(capability, 'execute', r);
    } catch { throw new WorkerRejected(); }
    const request = { job: r.job, lease: r.lease };
    const held = this.slot.acquire(r.job, r.lease, () => this.stop(request));
    if (!held) throw new WorkerRejected('worker_busy');
    try {
      const result = await this.run(r, signal);
      if (!result.stopped) { this.slot.lock(held); return { status: 'unknown', stopped: false }; }
      this.slot.release(held);
      return settled(r, result);
    } catch {
      // A broken response is not proof that a process stopped.
      this.slot.lock(held);
      return { status: 'unknown', stopped: false };
    }
  }
  async cancel(input: CancelRequest, capability: string): Promise<{ stopped: boolean }> {
    const request = CancelRequestSchema.parse(input);
    await this.verifier.check(capability, 'cancel', request);
    return this.slot.cancel(request);
  }
}

// owner/repo 꼴만 받는다. URL 파서가 점 세그먼트를 정규화해 검사한 저장소와 다른 경로로 가므로 "."·".."만 뺀다(.github는 실제 이름이다).
export const REPOSITORY_NAME = /^(?!\.\.?\/)[A-Za-z0-9_.-]+\/(?!\.\.?$)[A-Za-z0-9_.-]+$/;
export function archiveContract(repository: string, base: string, head: string) {
  if (!REPOSITORY_NAME.test(repository)
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
