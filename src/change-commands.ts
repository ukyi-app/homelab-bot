import { CHANGE_ID, labelAllowsAuthorInput, PROVENANCE_LABELS, propagateLabel } from './change-contracts.js';
import type { ChangeKey, ProvenanceLabel } from './change-contracts.js';
import type { ChangeRepositoryPolicy } from './change-policy.js';
import { scanPublicPayload } from './change-publication.js';
import type { ChangePrivateInputs, ChangeRequest, ChangeStore } from './change-store.js';
import { describeDeployment } from './change-deployment.js';
import { Denied } from './contracts.js';
import type { Scope } from './contracts.js';
import { errorInfo } from './log.js';
import type { Log } from './log.js';
import type { PolicyGate } from './policy.js';
import type { Store } from './store.js';
import type { TaskAnswerInput, TaskAnswerResult } from './task-bridge.js';
import type { TaskCommandHandler } from './task-commands.js';

// Discord 변경 명령과 부모 change 사이. 네트워크를 부르지 않아 상호작용 응답 기한 안에 끝난다. 작업자·GitHub 호출은 change-runtime의 루프가 한다.
// 요청 원문은 events에 남기지 않는다. events는 대화 맥락으로 모델에 들어가고, 원문의 자리는 ChangePrivateInputs가 읽는 표 하나다.

export type ChangeCommand = 'change' | 'change-status' | 'change-cancel' | 'change-publish';
export interface ChangeCommandRequest { id: string; actor: string; scope: Scope; command: ChangeCommand; text: string; target?: string }
export interface ChangeCommandReply { content: string; outcome: string }
export interface ChangeCommandHandler { handle(request: ChangeCommandRequest): Promise<ChangeCommandReply> }

const USAGE = '서식: /change project:<저장소> text:<요약> | goal=<목표> | accept=<인수 조건> | label=public. accept는 여러 번 쓸 수 있고 base=<브랜치>는 선택입니다. label은 이 글을 공개해도 되는지에 대한 owner의 판단입니다(public, approved_public_summary, private, unknown).';
const THREAD_ONLY = '변경 요청은 대화 채널의 스레드에서만 받습니다. /chat으로 스레드를 연 뒤 그 스레드에서 실행하세요.';
const NOT_VISIBLE = '이 스레드에서 볼 수 있는 변경이 아닙니다.';
const TRANSIENT = '처리하지 못했습니다(일시 오류). /change-status로 상태를 확인한 뒤 다시 시도하세요.';
const CONTROL_FREE = /^(?:[^\p{Cc}]|[\n\t])+$/u;
const LABELS: ReadonlySet<string> = new Set(PROVENANCE_LABELS);

export interface ParsedChangeRequest { summary: string; goal: string; acceptance: string[]; label: ProvenanceLabel; base?: string }
export type ParseResult = { ok: true; value: ParsedChangeRequest } | { ok: false; reason: 'summary_missing' | 'acceptance_missing' | 'field_unknown' | 'label_invalid' | 'too_long' | 'control_character' };
// label을 적지 않으면 unknown이다. 모델이 아니라 owner의 이 입력만이 출처를 말할 수 있고, 말하지 않은 글은 공개해도 되는 글이 아니다.
export function parseChangeRequest(text: string): ParseResult {
  const [first, ...rest] = text.split(/\s+\|\s+/);
  const summary = first?.trim() ?? '';
  if (!summary || /^(goal|accept|label|base)=/.test(summary)) return { ok: false, reason: 'summary_missing' };
  const acceptance: string[] = [];
  let goal: string | undefined, label: string | undefined, base: string | undefined;
  for (const part of rest) {
    const at = part.indexOf('=');
    const name = at < 0 ? '' : part.slice(0, at).trim();
    const value = part.slice(at + 1).trim();
    if (name === 'goal') goal = value;
    else if (name === 'accept') acceptance.push(value);
    else if (name === 'label') label = value;
    else if (name === 'base') base = value;
    else return { ok: false, reason: 'field_unknown' };
  }
  if (!acceptance.length || acceptance.some(item => !item)) return { ok: false, reason: 'acceptance_missing' };
  if (label !== undefined && !LABELS.has(label)) return { ok: false, reason: 'label_invalid' };
  if (summary.length > 4000 || (goal?.length ?? 0) > 4000 || acceptance.length > 32 || acceptance.some(item => item.length > 1000)) return { ok: false, reason: 'too_long' };
  if (![summary, goal ?? summary, ...acceptance].every(item => CONTROL_FREE.test(item))) return { ok: false, reason: 'control_character' };
  return { ok: true, value: { summary, goal: goal || summary, acceptance, label: (label ?? 'unknown') as ProvenanceLabel, ...(base ? { base } : {}) } };
}

export interface ChangeCommandDeps {
  store: Store; changes: ChangeStore; gate: PolicyGate; log: Log;
  // 받지 못하는 사유. null이면 받는다. 조회·취소는 닫혀 있어도 된다. 끝내는 경로를 닫으면 진행 중인 건을 멈출 수 없다.
  closedReason: () => string | null;
  admit?: (request: ChangeRequest) => Promise<{ ok: true } | { ok: false; reason: string }>;
}
const closedText = (reason: string) => `지금 변경 요청을 받지 않습니다(${reason}). 대화·작업·리뷰는 그대로 동작합니다.`;

export class ChangeCommands implements ChangeCommandHandler {
  constructor(private readonly deps: ChangeCommandDeps) {}
  async handle(request: ChangeCommandRequest): Promise<ChangeCommandReply> {
    switch (request.command) {
      case 'change': return this.change(request);
      case 'change-status': return this.status(request);
      case 'change-cancel': return this.cancel(request);
      case 'change-publish': return this.publish(request);
    }
  }
  // 요청한 스레드의 owner에게만 존재를 알린다.
  private async own(request: ChangeCommandRequest): Promise<ChangeRequest | null> {
    if (!request.target || !CHANGE_ID.test(request.target)) return null;
    const found = await this.deps.changes.get(request.target);
    if (!found.ok || found.value.ownerId !== request.actor || found.value.conversationId !== this.deps.store.scopeId(request.scope)) return null;
    return found.value;
  }
  private async change(request: ChangeCommandRequest): Promise<ChangeCommandReply> {
    const closed = this.deps.closedReason();
    if (closed) return { content: closedText(closed), outcome: 'closed' };
    const policy = await this.deps.gate.current();
    if (request.scope.kind !== 'thread' || request.scope.parent !== policy.conversationChannel) return { content: THREAD_ONLY, outcome: 'thread_only' };
    if (request.target && CHANGE_ID.test(request.target)) return this.nextGeneration(request);
    const repository = policy.change?.repositories.find(item => item.fullName === request.target || String(item.repoId) === request.target);
    if (!repository) {
      const names = (policy.change?.repositories ?? []).map(item => item.fullName).join(', ');
      return { content: `정책에 없는 저장소라 받지 않았습니다.${names ? ` 받는 저장소: ${names}` : ''}`, outcome: 'repository_unknown' };
    }
    const parsed = parseChangeRequest(request.text);
    if (!parsed.ok) return { content: `요청을 읽지 못했습니다(${parsed.reason}). ${USAGE}`, outcome: parsed.reason };
    const base = parsed.value.base ?? repository.baseBranches[0]!;
    if (!repository.baseBranches.includes(base)) return { content: `정책에 없는 base 브랜치입니다. 받는 브랜치: ${repository.baseBranches.join(', ')}`, outcome: 'base_not_allowed' };
    await this.deps.store.atomic(async store => { await store.activate(await store.ownedConversation(request.scope, request.actor, true), request.id); });
    const sensitive = scanBrief(parsed.value, repository);
    const label = sensitive ? propagateLabel([parsed.value.label, 'private']) : parsed.value.label;
    const created = await this.deps.changes.createRequest({ eventId: request.id, ownerId: request.actor, conversationId: this.deps.store.scopeId(request.scope), scope: request.scope,
      repoId: repository.repoId, baseBranch: base, label, input: { text: request.text } });
    if (!created.ok) {
      if (created.reason === 'duplicate_event') return { content: `이미 받은 요청입니다. 변경 ID: ${created.existingId ?? '알 수 없음'}`, outcome: 'duplicate' };
      this.deps.log('change_request_failed', { reason: created.reason });
      return { content: TRANSIENT, outcome: 'error' };
    }
    const id = created.value.id;
    // 응답을 잃으면 ID를 알 길이 없다. 대화에도 영속 게시로 남긴다.
    await this.deps.store.enqueue({ key: `change-accepted:${id}`, conversation: created.value.conversationId, actor: request.actor, scope: request.scope, revision: policy.revision,
      payload: { kind: 'message', channel: request.scope.channel, content: `변경 ${id}을 받았습니다. /change-status target:${id}`, classification: 'safe_summary' } });
    // 끊기면 런타임 바퀴가 같은 입력으로 admission을 다시 한다.
    const admitted = await this.deps.admit?.(created.value).catch(error => { this.deps.log('change_admit_deferred', errorInfo(error)); return null; });
    if (!labelAllowsAuthorInput(label) || admitted?.ok === false && admitted.reason === 'label_blocked') {
      const why = sensitive ? `입력에서 공개하면 안 되는 값(${sensitive})을 찾았습니다` : `출처가 ${label}입니다`;
      return { content: `변경 ${id}을 막았습니다. ${why}. 작성 모델과 GitHub에 아무것도 보내지 않았습니다. 공개해도 되는 내용만 담아 label=public으로 새로 요청하세요.`, outcome: 'label_blocked' };
    }
    return { content: `변경 ${id}을 받았습니다. 수정·시험·검토까지 진행하고 미리보기를 이 스레드에 보냅니다. 게시는 /change-publish로 따로 승인합니다.`, outcome: 'accepted' };
  }
  // 새 generation은 owner가 이렇게 말할 때만 연다. 자동 재시도는 없다.
  private async nextGeneration(request: ChangeCommandRequest): Promise<ChangeCommandReply> {
    const found = await this.own(request);
    if (!found) return { content: NOT_VISIBLE, outcome: 'not_visible' };
    if (request.text.trim() !== 'next') return { content: `새 generation은 /change project:${found.id} text:next 로 엽니다.`, outcome: 'usage' };
    const opened = await this.deps.changes.startNextGeneration({ changeId: found.id, generation: found.generation });
    if (opened.ok) {
      await this.deps.admit?.(opened.value).catch(error => { this.deps.log('change_admit_deferred', errorInfo(error)); });
      return { content: `변경 ${found.id}의 generation ${opened.value.generation}을 열었습니다. 최신 base에서 수정·시험·검토·승인을 처음부터 다시 받습니다.`, outcome: 'next_generation' };
    }
    const why = opened.reason === 'unresolved_effects' ? '확인되지 않은 게시 기록이 남아 있습니다. 먼저 해소해야 합니다'
      : opened.reason === 'phase_conflict' ? `superseded 상태에서만 열 수 있습니다(지금 ${opened.current?.phase ?? found.phase})` : opened.reason;
    return { content: `새 generation을 열지 않았습니다: ${why}.`, outcome: opened.reason };
  }
  private async publish(request: ChangeCommandRequest): Promise<ChangeCommandReply> {
    const closed = this.deps.closedReason();
    if (closed) return { content: closedText(closed), outcome: 'closed' };
    const found = await this.own(request);
    if (!found) return { content: NOT_VISIBLE, outcome: 'not_visible' };
    const policy = await this.deps.gate.current();
    const repository = policy.change?.repositories.find(item => item.repoId === found.repoId);
    // 승인한 뒤에 막히면 되돌릴 수 없다. 확인 전이면 승인을 받지 않고 대기에 둔다.
    if (repository && !repository.writerAccepted) return { content: '실제 writer의 AC-P8이 확인되지 않아 게시를 받지 않습니다. 승인 대기는 그대로입니다.', outcome: 'writer_unaccepted' };
    const approved = await this.deps.changes.approve({ changeId: found.id, generation: found.generation, approvalDigest: request.text.trim(), eventId: request.id, actor: request.actor });
    if (approved.ok) return { content: `변경 ${found.id} 게시를 승인했습니다. 게시 직전 base·정책·CI를 다시 확인하고, 결과는 이 스레드에 알립니다.`, outcome: 'approved' };
    const text: Partial<Record<string, string>> = { digest_mismatch: '미리보기의 승인 digest와 다릅니다. 승인하지 않았습니다.', duplicate_event: '이미 처리한 승인입니다.',
      owner_mismatch: NOT_VISIBLE, phase_conflict: `승인 대기 상태가 아닙니다(지금 ${approved.current?.phase ?? found.phase}).` };
    return { content: text[approved.reason] ?? TRANSIENT, outcome: approved.reason };
  }
  private async cancel(request: ChangeCommandRequest): Promise<ChangeCommandReply> {
    const found = await this.own(request);
    if (!found) return { content: NOT_VISIBLE, outcome: 'not_visible' };
    if (found.phase === 'merged' || found.phase === 'observing_deploy') return { content: '이미 병합됐습니다. 병합은 되돌릴 수 없어 취소하지 않고 배포 관측만 계속합니다.', outcome: 'merged' };
    const moved = await this.deps.changes.transition({ changeId: found.id, generation: found.generation, from: found.phase, to: 'cancelled', reason: 'owner_cancelled' });
    if (!moved.ok) return { content: moved.reason === 'transition_not_allowed' ? `이미 끝난 변경입니다(${found.phase}).` : '상태가 바뀌었습니다. /change-status로 확인한 뒤 다시 시도하세요.', outcome: moved.reason };
    const published = found.phase === 'publishing' || found.phase === 'proposed';
    return { content: `변경 ${found.id}을 취소했습니다. 돌던 작업은 소멸을 확인한 뒤 정리합니다.${published ? ' 이미 공개된 객체·PR은 닫지 않고 기록만 남깁니다.' : ''}`, outcome: 'cancelled' };
  }
  private async status(request: ChangeCommandRequest): Promise<ChangeCommandReply> {
    const found = await this.own(request);
    if (!found) return { content: NOT_VISIBLE, outcome: 'not_visible' };
    const db = this.deps.store.db;
    const key: ChangeKey = { changeId: found.id, generation: found.generation };
    const lines = [`변경 ${found.id} g${found.generation}: ${found.phase}${found.phaseReason ? `(${found.phaseReason})` : ''}`, `저장소 ID ${found.repoId}, base ${found.baseBranch}, 출처 ${found.label}`];
    const closed = this.deps.closedReason();
    if (closed) lines.push(`새 요청·게시는 지금 닫혀 있습니다(${closed}).`);
    for (const child of (await db.query<{ role: string; id: string; state: string; wait_reason: string | null }>(`SELECT c.role,j.id,j.state,j.wait_reason FROM change_child_jobs c JOIN jobs j ON j.id=c.job_id
      WHERE c.change_id=$1 AND c.generation=$2 ORDER BY c.created_at`, [found.id, found.generation])).rows) {
      lines.push(`${child.role === 'author' ? '작성' : '리뷰'} 작업 ${child.id}: ${child.state}${child.wait_reason ? `(${child.wait_reason})` : ''}`);
      if (child.state === 'unknown') lines.push(`이 작업의 종료를 확인하지 못해 레인이 막혀 있을 수 있습니다. 프로세스 소멸을 확인한 뒤 /task-release target:${child.id}`);
    }
    if (found.phase === 'awaiting_publish_approval') {
      const subject = await this.deps.changes.approvalSubject(key);
      if (subject.ok) lines.push(`승인 digest: ${subject.value.digest}`);
    }
    for (const effect of await this.deps.changes.unresolvedEffects({ changeId: found.id })) {
      lines.push(`미확정 게시 기록: g${effect.generation} ${effect.stage} ${effect.state}${effect.blockedReason ? `(${effect.blockedReason})` : ''}. 이 기록이 풀리기 전에는 새 게시를 시작하지 않습니다.`);
    }
    const pull = (await db.query<{ result: unknown }>(`SELECT result FROM change_delivery_effects WHERE change_id=$1 AND generation=$2 AND stage='pull' AND state='confirmed'`, [found.id, found.generation])).rows[0];
    if (pull) {
      const number = (typeof pull.result === 'string' ? JSON.parse(pull.result) : pull.result as { number: number }).number;
      lines.push(`PR #${number}${found.phase === 'superseded' || found.phase === 'blocked' ? ': 이 PR은 사람이 병합해도 배포를 추적하지 않습니다.' : ''}`);
    }
    const deployment = await this.deps.changes.deployment(key);
    if (deployment.ok) {
      const { prNumber: _pr, ...observation } = deployment.value;
      lines.push(describeDeployment(observation));
    }
    if ((await db.query(`SELECT 1 FROM change_artifacts WHERE change_id=$1 AND purged_at IS NOT NULL LIMIT 1`, [found.id])).rows.length) lines.push('보존 기간이 지나 artifact 바이트와 리뷰 원문을 지웠습니다. digest와 receipt는 남아 있습니다.');
    return { content: lines.join('\n'), outcome: 'status' };
  }
}
// 추가 방어다. 탐지기는 완전성 증거가 아니고 owner의 label이 우선이다. 찾으면 모델을 부르기 전에 막아 값을 작성자에 넘기지 않는다.
function scanBrief(parsed: ParsedChangeRequest, policy: ChangeRepositoryPolicy): string | null {
  const identity = { name: policy.identity.name, email: policy.identity.email, date: '2000-01-01T00:00:00Z' };
  const scanned = scanPublicPayload({ paths: [], files: [], branch: 'change', marker: 'change', publication: { title: parsed.summary.slice(0, 256), body: [parsed.goal, ...parsed.acceptance, parsed.summary].join('\n'),
    commitMessage: 'change', author: identity, committer: identity, draft: false } }, { internalMarkers: policy.internalMarkers });
  return scanned.ok ? null : scanned.reason;
}

const ANSWER_LABEL = /^\s*label=([a-z_]+)\s*\|\s*([\s\S]*)$/;
const ANSWER_USAGE = '변경 작업의 답은 공개해도 되는지 함께 적어야 합니다. /answer question:<ID> text:label=public | <답> 으로 보내세요. 질문은 열려 있습니다.';
// /answer는 작업 레인과 같은 명령이다. CHANGE 질문만 출처를 묻고 나머지는 그대로 넘긴다.
// 답을 작성자에 넘기기 전에 출처를 기록한다. private·unknown이면 작성자에 닿기 전에 부모를 닫는다.
export class ChangeAnswerGuard implements TaskCommandHandler {
  constructor(private readonly inner: TaskCommandHandler, private readonly inputs: Pick<ChangePrivateInputs, 'recordIn'>, private readonly gate: PolicyGate) {}
  admit(store: Store, project: string | undefined) { return this.inner.admit(store, project); }
  cancelIn(store: Store, actor: string, conversation: string, job: string, cursor: string) { return this.inner.cancelIn(store, actor, conversation, job, cursor); }
  status(actor: string, scope: Scope, job: string) { return this.inner.status(actor, scope, job); }
  release(request: { id: string; actor: string; scope: Scope; job: string; revision: string }) { return this.inner.release(request); }
  async answerIn(store: Store, input: TaskAnswerInput): Promise<TaskAnswerResult> {
    const link = (await store.db.query<{ change_id: string; generation: number | string; conversation_id: string; responder_id: string; state: string }>(`SELECT c.change_id,c.generation,q.conversation_id,q.responder_id,q.state
      FROM codex_questions q JOIN change_child_jobs c ON c.job_id=q.job_id AND c.role='author' WHERE q.id=$1`, [input.question])).rows[0];
    if (!link) return this.inner.answerIn(store, input);
    await this.gate.withDatabase(store.db).authorize(input.actor, input.scope);
    // 다른 스레드에서 답해 이 질문의 출처를 정하지 못한다.
    if (link.conversation_id !== store.scopeId(input.scope) || link.responder_id !== input.actor) throw new Denied();
    // 닫힌 질문은 기록할 것이 없다. 안내는 원래 경로가 한다.
    if (link.state !== 'open') return this.inner.answerIn(store, input);
    const matched = ANSWER_LABEL.exec(input.text);
    const label = matched?.[1];
    if (!matched || !label || !LABELS.has(label)) return { ok: false, status: ANSWER_USAGE };
    const key = { changeId: link.change_id, generation: Number(link.generation) };
    const body = matched[2]!;
    if (!labelAllowsAuthorInput(label as ProvenanceLabel)) {
      await this.inputs.recordIn(store.db, { ...key, eventId: input.event, label: label as ProvenanceLabel, text: body });
      return { ok: false, status: `출처가 ${label}인 답이라 작성 모델에 넘기지 않고 이 변경을 막았습니다.` };
    }
    const answered = await this.inner.answerIn(store, { ...input, text: body });
    if (!answered.ok || answered.duplicate) return answered;
    const recorded = await this.inputs.recordIn(store.db, { ...key, eventId: input.event, label: label as ProvenanceLabel, text: body });
    return recorded.ok ? answered : { ok: false, status: `답을 넘기지 않았습니다(${recorded.reason}).` };
  }
}
