import { AMENDMENT_MATERIAL_ID, AUTHOR_ASSOCIATIONS, amendmentMaterialsDigest, CHANGE_AMENDMENT, CHANGE_ID, ChangePathSchema, labelAllowsAuthorInput, PROVENANCE_LABELS, propagateLabel } from './change-contracts.js';
import type { ChangeKey, ProvenanceLabel, ReviewMaterial } from './change-contracts.js';
import type { ChangeRepositoryPolicy } from './change-policy.js';
import { scanPublicText } from './change-publication.js';
import type { ChangePrivateInputs, ChangeRequest, ChangeStore } from './change-store.js';
import { describeDeployment } from './change-deployment.js';
import { Denied } from './contracts.js';
import type { Scope } from './contracts.js';
import type { Database } from './database.js';
import type { PullDiscussion } from './github-review-io.js';
import { errorInfo } from './log.js';
import type { Log } from './log.js';
import type { PolicyGate } from './policy.js';
import type { OutboxButton, Store } from './store.js';
import type { TaskAnswerInput, TaskAnswerResult } from './task-bridge.js';
import type { TaskCommandHandler } from './task-commands.js';

// Discord 변경 명령과 부모 change 사이. 네트워크를 부르지 않아 상호작용 응답 기한 안에 끝난다. 작업자·GitHub 호출은 change-runtime의 루프가 한다.
// 요청 원문은 events에 남기지 않는다. events는 대화 맥락으로 모델에 들어가고, 원문의 자리는 ChangePrivateInputs가 읽는 표 하나다.

export type ChangeCommand = 'change' | 'change-status' | 'change-cancel' | 'change-publish';
export interface ChangeCommandRequest { id: string; actor: string; scope: Scope; command: ChangeCommand; text: string; target?: string }
export interface ChangeCommandReply { content: string; outcome: string }
// 게시 승인 버튼 누름. target은 버튼 custom_id의 대상 칸(`<변경 ID>.<generation>.<digest 앞 16자>`)이다.
export interface PublishPress { id: string; actor: string; scope: Scope; target: string }
// update: 응답으로 그 글을 content로 바꾸고 버튼을 없앤다. 아니면 누른 owner에게만 보이는 응답이고 버튼은 남는다.
export interface PublishPressReply extends ChangeCommandReply { update?: true }
export interface ChangeCommandHandler {
  handle(request: ChangeCommandRequest): Promise<ChangeCommandReply>;
  pressPublish?(request: PublishPress): Promise<PublishPressReply>;
  // 말로 하는 수정 요청(C27). PR 리뷰·댓글을 읽을 수 있게 조립됐을 때만 있다. 없으면 제안 동작이 "연결 안 됨"이다.
  amendment?: AmendmentRequests;
}
// 수정 요청의 대상 대조와 접수. 대상은 이 스레드에서 owner가 낸 변경이고, 그 변경의 PR이 열려 있어야(proposed·amending) 한다.
export type AmendmentRefusal = 'no_pull' | 'not_open' | 'limit' | 'sensitive' | 'unavailable';
export type AmendmentTarget =
  | { ok: true; changeId: string; generation: number; repository: string; pullNumber: number; head: string; materials: string[]; materialsDigest: string }
  | { ok: false; reason: 'not_visible' | AmendmentRefusal };
export interface AmendmentRequests {
  // 확인 글을 만들 때 부른다. PR 리뷰·댓글을 읽어 ID 묶음과 그 글의 digest를 정한다(이 묶음까지가 이번 차례의 자료다). target은 변경 ID나 PR 번호(#n·n·PR 링크)다.
  prepare(input: { actor: string; scope: Scope; target: string; instruction: string }): Promise<AmendmentTarget>;
  // 버튼을 누른 뒤 부른다. 확인 때 정한 값 그대로 대기열에 넣는다. 차례 시작은 런타임이 한다.
  request(input: { id: string; actor: string; scope: Scope; changeId: string; generation: number; pullNumber: number; head: string; materials: readonly string[]; materialsDigest: string; instruction: string }): Promise<ChangeCommandReply>;
}
// 수정 요청 문구. 동료 기능 스위치를 켰을 때만 보이므로 동료 말투다.
export const AMENDMENT_REQUEST_TEXT = Object.freeze({
  question: (repository: string, pr: number, comments: number) => `${repository} PR #${pr}에 리뷰 댓글 ${comments}개를 반영해서 수정 커밋을 올릴까요?`,
  no_pull: '아직 PR을 올리지 않은 변경이라 수정 요청을 받을 수 없어요. 게시를 먼저 마쳐 주세요.',
  not_open: '이미 병합됐거나 닫힌 PR이라 고칠 수 없어요.',
  limit: (max: number) => `이 PR은 수정을 ${max}번 받아서 더 받을 수 없어요. 필요하면 새 변경으로 요청해 주세요.`,
  sensitive: '말한 내용에 밖에 보이면 안 되는 값이 섞여 있어서 수정 요청으로 받지 않았어요. 그 값을 빼고 다시 말해 주세요.',
  queued: (round: number) => `수정 요청을 받았어요. 지금 돌고 있는 수정이 끝나면 차례 ${round}로 이어서 할게요. 결과는 이 스레드에서 알려 드릴게요.`,
  accepted: (round: number) => `수정 요청을 받았어요. 차례 ${round}로 시작할게요. 결과는 이 스레드에서 알려 드릴게요.`,
  closed: '지금은 수정 요청을 받지 않아요. 잠시 뒤 다시 말해 주세요.',
  failed: '수정 요청을 받지 못했어요(일시 오류). 변경 상태를 확인한 뒤 다시 말해 주세요.',
  stale: 'PR 상태가 바뀌어서 이 요청은 받지 않았어요. 다시 말해 주세요.',
  // PR 리뷰·댓글을 읽을 길이 없거나(리뷰 경로 꺼짐) 지금 읽지 못했다. 대상 변경이 이 스레드에서 보일 때만 이렇게 답한다.
  unavailable: '지금은 PR 리뷰·댓글을 읽을 수 없어서 수정 요청을 받지 못해요. 잠시 뒤 다시 말해 주세요.',
});

// 변경 명령·답 처리기의 고정 문구. 동료 말투(해요체, 결론부터, 자기를 "봇"이라 부르지 않음)다.
// 첫 인자 colleague는 동료 기능 스위치(Store.colleague)다. 켜지면 '/' 이름 대신 말로 하는 안내를, 꺼지면 지금의 '/' 안내를 낸다.
// 함정: 항목마다 분기가 colleague 하나뿐이어야 시험이 모든 항목을 같은 인자로 불러 '/' 이름을 검사할 수 있다.
// label=·goal= 같은 입력 칸 이름은 명령 이름이 아니라 두 판이 같다. 말로는 새 generation을 열 수 없어 켜짐 판은 새 변경으로 다시 부탁하라고 한다.
const LABEL_HELP = 'label은 이 글을 공개해도 되는지에 대한 관리자의 판단이에요(public, approved_public_summary, private, unknown).';
const ASK_STATUS = '변경 상태를 물어봐서 확인한 뒤 다시 부탁해 주세요.';
const usage = (c: boolean) => c
  ? `요약 뒤에 \` | goal=<목표> | accept=<인수 조건> | label=public\`처럼 적어 주세요. accept는 여러 번 쓸 수 있고 base=<브랜치>는 선택이에요. ${LABEL_HELP}`
  : `서식: /change project:<저장소> text:<요약> | goal=<목표> | accept=<인수 조건> | label=public. accept는 여러 번 쓸 수 있고 base=<브랜치>는 선택이에요. ${LABEL_HELP}`;
export const CHANGE_TEXT = Object.freeze({
  usage,
  threadOnly: (c: boolean) => `변경 요청은 대화 채널의 스레드에서만 받아요. ${c
    ? '대화 채널에서 저를 불러 스레드를 연 뒤 그 스레드에서 말해 주세요.' : '/chat으로 스레드를 연 뒤 그 스레드에서 실행해 주세요.'}`,
  notVisible: '이 스레드에서 볼 수 있는 변경이 아니에요.',
  transient: (c: boolean) => `처리하지 못했어요(일시 오류). ${c ? ASK_STATUS : '/change-status로 상태를 확인한 뒤 다시 시도해 주세요.'}`,
  closed: (_c: boolean, reason: string) => `지금은 변경 요청을 받지 않아요(${reason}). 대화·작업·리뷰는 그대로 돼요.`,
  repositoryUnknown: (_c: boolean, names: string) => `정책에 없는 저장소라 받지 않았어요.${names ? ` 받는 저장소: ${names}` : ''}`,
  unreadable: (c: boolean, reason: string) => `요청을 읽지 못했어요(${reason}). ${usage(c)}`,
  baseNotAllowed: (_c: boolean, branches: string) => `정책에 없는 base 브랜치예요. 받는 브랜치: ${branches}`,
  duplicate: (_c: boolean, id: string) => `이미 받은 요청이에요. 변경 ID: ${id}`,
  // 응답을 잃어도 ID가 남게 대화에 따로 거는 글이다.
  acceptedPost: (c: boolean, id: string) => c ? `변경 ${id}을 받았어요. 진행 상황은 이 스레드에 알려 드릴게요.` : `변경 ${id}을 받았어요. /change-status target:${id}`,
  blockedSensitive: (_c: boolean, found: string) => `입력에서 공개하면 안 되는 값(${found})을 찾았어요`,
  blockedLabel: (_c: boolean, label: string) => `출처가 ${label}이에요`,
  blocked: (_c: boolean, id: string, why: string) =>
    `변경 ${id}을 막았어요. ${why}. 작성 모델과 GitHub에는 아무것도 보내지 않았어요. 공개해도 되는 내용만 담아 label=public으로 새로 요청해 주세요.`,
  accepted: (c: boolean, id: string) => `변경 ${id}을 받았어요. 수정·시험·검토까지 하고 미리보기를 이 스레드에 보낼게요. ${c
    ? '게시는 미리보기의 버튼으로 따로 승인해 주세요.' : '게시는 /change-publish로 따로 승인해요.'}`,
  nextUsage: (c: boolean, id: string) => c ? '새 generation을 여는 말은 아직 받지 않아요. 같은 내용을 다시 부탁하면 새 변경으로 받아요.'
    : `새 generation은 /change project:${id} text:next 로 열어요.`,
  nextOpened: (_c: boolean, id: string, generation: number) =>
    `변경 ${id}의 generation ${generation}을 열었어요. 최신 base에서 수정·시험·검토·승인을 처음부터 다시 받아요.`,
  nextUnresolved: '확인되지 않은 게시 기록이 남아 있어요. 먼저 풀어야 해요',
  nextPurged: (c: boolean) => `보존 기간(7일)이 지나 요청 원문을 지웠어요. ${c ? '같은 내용을 새로 부탁해 주세요' : '같은 내용을 /change로 새로 요청해 주세요'}`,
  nextPhase: (_c: boolean, phase: string) => `superseded 상태에서만 열 수 있어요(지금 ${phase})`,
  nextRefused: (_c: boolean, why: string) => `새 generation을 열지 않았어요: ${why}.`,
  writerUnaccepted: '실제 writer의 AC-P8을 아직 확인하지 않아 게시를 받지 않아요. 승인 대기는 그대로예요.',
  digestMismatch: '미리보기의 승인 digest와 달라서 승인하지 않았어요.',
  approvalDuplicate: '이미 처리한 승인이에요.',
  notAwaiting: (_c: boolean, phase: string) => `승인 대기 상태가 아니에요(지금 ${phase}).`,
  cancelMerged: '이미 병합됐어요. 병합은 되돌릴 수 없어서 취소하지 않고 배포 관측만 계속해요.',
  cancelFinished: (_c: boolean, phase: string) => `이미 끝난 변경이에요(${phase}).`,
  cancelRace: (c: boolean) => `상태가 바뀌었어요. ${c ? ASK_STATUS : '/change-status로 확인한 뒤 다시 시도해 주세요.'}`,
  cancelled: (_c: boolean, id: string, published: boolean) =>
    `변경 ${id}을 취소했어요. 돌던 작업은 끝난 걸 확인한 뒤 정리해요.${published ? ' 이미 공개된 객체·PR은 닫지 않고 기록만 남겨요.' : ''}`,
  // '/change-status' 응답의 문장 줄. 상태·사유·ID 칸은 코드 그대로다.
  statusClosed: (_c: boolean, reason: string) => `새 요청·게시는 지금 닫혀 있어요(${reason}).`,
  statusChildUnknown: (c: boolean, job: string) => `이 작업이 끝났는지 확인하지 못해 레인이 막혀 있을 수 있어요. ${c
    ? '프로세스가 사라진 걸 확인한 뒤 `homelab bot` CLI로 풀어 주세요.' : `프로세스가 사라진 걸 확인한 뒤 /task-release target:${job}`}`,
  statusUnresolved: '이 기록이 풀리기 전에는 새 게시를 시작하지 않아요.',
  statusUntracked: '이 PR은 사람이 병합해도 배포를 추적하지 않아요.',
  statusPurged: '보존 기간이 지나 artifact 바이트·리뷰 원문·요청 원문·요약을 지웠어요. digest와 receipt는 남아 있어요.',
  // 변경 질문 답(ChangeAnswerGuard). 서식 안내는 owner가 분류(label=)를 적었는데 틀렸을 때만 나와 공개 여부를 먼저 묻는 글이 아니다.
  answerUsage: (c: boolean) => c ? '변경 작업의 답에 분류를 적으려면 `label=public | <답>`처럼 써 주세요. 질문은 열려 있어요.'
    : '변경 작업의 답은 공개해도 되는지 함께 적어야 해요. /answer question:<ID> text:label=public | <답> 으로 보내 주세요. 질문은 열려 있어요.',
  answerLabelBlocked: (_c: boolean, label: string) => `출처가 ${label}인 답이라 작성 모델에 넘기지 않고 이 변경을 막았어요.`,
  answerNoPolicy: '이 변경의 저장소가 정책에 없어 답을 검사하지 못했어요. 작성 모델에 넘기지 않았고 질문은 열려 있어요.',
  answerSensitive: (_c: boolean, found: string) =>
    `답에서 공개하면 안 되는 값(${found})을 찾아 작성 모델에 넘기지 않고 이 변경을 막았어요. 공개해도 되는 내용만 담아 새로 요청해 주세요.`,
  answerNotRecorded: (_c: boolean, reason: string) => `답을 넘기지 않았어요(${reason}).`,
});
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
  // 수정 요청 자료 읽기(리뷰 App, C26 discussion.read). 있으면 말로 하는 수정 요청을 받는다.
  discussion?: AmendmentDiscussionReader;
}

// 게시 승인 버튼(COLLEAGUE_SPEC §4.3 "게시 승인"). custom_id는 `change-publish-ok:<변경 ID>.<generation>.<승인 digest 앞 16자>`다.
// 전체 digest(64자)는 변경 ID(32자)와 함께 100자 상한에 들지 않는다. 승인 대상은 generation마다 하나이고 DB가 바꾸지 못하게 막으므로
// (ARCHITECTURE §16) 변경 ID·generation이 digest 하나를 정한다. 앞자리는 누를 때 지금 승인 대상의 digest와 한 번 더 대조한다.
export const PUBLISH_BUTTON = 'change-publish-ok';
const PUBLISH_DIGEST_CHARS = 16;
const PUBLISH_TARGET = /^([0-9a-f]{32})\.([1-9][0-9]{0,8})\.([0-9a-f]{16})$/;
// 버튼 응답 문구. 동료 기능 스위치를 켰을 때만 보이므로 동료 말투다.
export const PUBLISH_TEXT = Object.freeze({
  label: '게시해 주세요',
  approved: (id: string) => `변경 ${id} 게시를 승인했어요. 게시 직전에 base·정책·CI를 다시 확인하고 결과는 이 스레드에 알려 드릴게요.`,
  stale: '지난 미리보기의 버튼이라 승인하지 않았어요. 가장 최근 미리보기를 확인해 주세요.',
  settled: '이미 승인한 미리보기예요.',
  notVisible: '이 스레드에서 볼 수 있는 변경이 아니에요.',
  writerUnaccepted: '아직 게시할 수 없어서 승인하지 않았어요(writer 확인 전). 승인 대기는 그대로예요.',
  stopped: '이 대화는 구독이 꺼져 있어서 승인하지 않았어요.',
  closed: '지금은 변경 게시를 받지 않아요. 승인 대기는 그대로예요.',
  failed: '처리하지 못했어요(일시 오류). 잠시 뒤 다시 눌러 주세요.',
});
// 미리보기 글의 outbox 키. change-runtime의 단계 알림 키(`change-phase:<ID>:<generation>:<phase>`)와 같은 꼴이어야 한다.
export const changePreviewKey = (changeId: string, generation: number) => `change-phase:${changeId}:${generation}:awaiting_publish_approval`;
// 승인이 이미 들어간 뒤의 단계. 같은 generation의 버튼을 다시 누르면 "이미 승인"으로 답한다.
const SETTLED_PHASES: ReadonlySet<string> = new Set(['approved', 'publishing', 'proposed', 'merged', 'observing_deploy']);
export const publishButton = (changeId: string, generation: number, digest: string): OutboxButton =>
  ({ id: `${PUBLISH_BUTTON}:${changeId}.${generation}.${digest.slice(0, PUBLISH_DIGEST_CHARS)}`, label: PUBLISH_TEXT.label, style: 'primary' });

export class ChangeCommands implements ChangeCommandHandler {
  // 리뷰 경로가 없어도 둔다. 그때는 보이는 변경에 거절 한 줄(unavailable)로 답해 말한 요청이 조용히 사라지지 않게 한다.
  readonly amendment: AmendmentRequests = { prepare: input => this.prepareAmendment(input), request: input => this.requestAmendment(input) };
  constructor(private readonly deps: ChangeCommandDeps) {}
  private get colleague(): boolean { return this.deps.store.colleague; }
  async handle(request: ChangeCommandRequest): Promise<ChangeCommandReply> {
    switch (request.command) {
      case 'change': return this.change(request);
      case 'change-status': return this.status(request);
      case 'change-cancel': return this.cancel(request);
      case 'change-publish': return this.publish(request);
    }
  }
  // 요청한 스레드의 owner에게만 존재를 알린다.
  private async own(request: Pick<ChangeCommandRequest, 'actor' | 'scope' | 'target'>): Promise<ChangeRequest | null> {
    if (!request.target || !CHANGE_ID.test(request.target)) return null;
    const found = await this.deps.changes.get(request.target);
    if (!found.ok || found.value.ownerId !== request.actor || found.value.conversationId !== this.deps.store.scopeId(request.scope)) return null;
    return found.value;
  }
  private async change(request: ChangeCommandRequest): Promise<ChangeCommandReply> {
    const c = this.colleague;
    const closed = this.deps.closedReason();
    if (closed) return { content: CHANGE_TEXT.closed(c, closed), outcome: 'closed' };
    const policy = await this.deps.gate.current();
    if (request.scope.kind !== 'thread' || request.scope.parent !== policy.conversationChannel) return { content: CHANGE_TEXT.threadOnly(c), outcome: 'thread_only' };
    if (request.target && CHANGE_ID.test(request.target)) return this.nextGeneration(request);
    const repository = policy.change?.repositories.find(item => item.fullName === request.target || String(item.repoId) === request.target);
    if (!repository) {
      const names = (policy.change?.repositories ?? []).map(item => item.fullName).join(', ');
      return { content: CHANGE_TEXT.repositoryUnknown(c, names), outcome: 'repository_unknown' };
    }
    const parsed = parseChangeRequest(request.text);
    if (!parsed.ok) return { content: CHANGE_TEXT.unreadable(c, parsed.reason), outcome: parsed.reason };
    const base = parsed.value.base ?? repository.baseBranches[0]!;
    if (!repository.baseBranches.includes(base)) return { content: CHANGE_TEXT.baseNotAllowed(c, repository.baseBranches.join(', ')), outcome: 'base_not_allowed' };
    await this.deps.store.atomic(async store => { await store.activate(await store.ownedConversation(request.scope, request.actor, true), request.id); });
    const sensitive = scanBrief(parsed.value, repository);
    const label = sensitive ? propagateLabel([parsed.value.label, 'private']) : parsed.value.label;
    const created = await this.deps.changes.createRequest({ eventId: request.id, ownerId: request.actor, conversationId: this.deps.store.scopeId(request.scope), scope: request.scope,
      repoId: repository.repoId, baseBranch: base, label, input: { text: request.text } });
    if (!created.ok) {
      if (created.reason === 'duplicate_event') return { content: CHANGE_TEXT.duplicate(c, created.existingId ?? '알 수 없음'), outcome: 'duplicate' };
      this.deps.log('change_request_failed', { reason: created.reason });
      return { content: CHANGE_TEXT.transient(c), outcome: 'error' };
    }
    const id = created.value.id;
    // 응답을 잃으면 ID를 알 길이 없다. 대화에도 영속 게시로 남긴다.
    await this.deps.store.enqueue({ key: `change-accepted:${id}`, conversation: created.value.conversationId, actor: request.actor, scope: request.scope, revision: policy.revision,
      payload: { kind: 'message', channel: request.scope.channel, content: CHANGE_TEXT.acceptedPost(c, id), classification: 'safe_summary' } });
    // 끊기면 런타임 바퀴가 같은 입력으로 admission을 다시 한다.
    const admitted = await this.deps.admit?.(created.value).catch(error => { this.deps.log('change_admit_deferred', errorInfo(error)); return null; });
    if (!labelAllowsAuthorInput(label) || admitted?.ok === false && admitted.reason === 'label_blocked') {
      const why = sensitive ? CHANGE_TEXT.blockedSensitive(c, sensitive) : CHANGE_TEXT.blockedLabel(c, label);
      return { content: CHANGE_TEXT.blocked(c, id, why), outcome: 'label_blocked' };
    }
    return { content: CHANGE_TEXT.accepted(c, id), outcome: 'accepted' };
  }
  // 새 generation은 owner가 이렇게 말할 때만 연다. 자동 재시도는 없다.
  private async nextGeneration(request: ChangeCommandRequest): Promise<ChangeCommandReply> {
    const c = this.colleague;
    const found = await this.own(request);
    if (!found) return { content: CHANGE_TEXT.notVisible, outcome: 'not_visible' };
    if (request.text.trim() !== 'next') return { content: CHANGE_TEXT.nextUsage(c, found.id), outcome: 'usage' };
    const opened = await this.deps.changes.startNextGeneration({ changeId: found.id, generation: found.generation });
    if (opened.ok) {
      await this.deps.admit?.(opened.value).catch(error => { this.deps.log('change_admit_deferred', errorInfo(error)); });
      return { content: CHANGE_TEXT.nextOpened(c, found.id, opened.value.generation), outcome: 'next_generation' };
    }
    const why = opened.reason === 'unresolved_effects' ? CHANGE_TEXT.nextUnresolved
      : opened.reason === 'input_purged' ? CHANGE_TEXT.nextPurged(c)
      : opened.reason === 'phase_conflict' ? CHANGE_TEXT.nextPhase(c, opened.current?.phase ?? found.phase) : opened.reason;
    return { content: CHANGE_TEXT.nextRefused(c, why), outcome: opened.reason };
  }
  private async publish(request: ChangeCommandRequest): Promise<ChangeCommandReply> {
    const c = this.colleague;
    const closed = this.deps.closedReason();
    if (closed) return { content: CHANGE_TEXT.closed(c, closed), outcome: 'closed' };
    const found = await this.own(request);
    if (!found) return { content: CHANGE_TEXT.notVisible, outcome: 'not_visible' };
    const approved = await this.approve(found, found.generation, request.text.trim(), request);
    if (approved.ok) return { content: PUBLISH_TEXT.approved(found.id), outcome: 'approved' };
    if (approved.reason === 'writer_unaccepted') return { content: CHANGE_TEXT.writerUnaccepted, outcome: 'writer_unaccepted' };
    const text: Partial<Record<string, string>> = { digest_mismatch: CHANGE_TEXT.digestMismatch, duplicate_event: CHANGE_TEXT.approvalDuplicate,
      owner_mismatch: CHANGE_TEXT.notVisible, phase_conflict: CHANGE_TEXT.notAwaiting(c, approved.phase ?? found.phase) };
    return { content: text[approved.reason] ?? CHANGE_TEXT.transient(c), outcome: approved.reason };
  }
  // '/change-publish'와 게시 승인 버튼이 함께 쓰는 승인. 저장 계층의 approve가 owner·generation·phase·digest·이벤트 멱등을 본다.
  private async approve(found: ChangeRequest, generation: number, digest: string, request: { id: string; actor: string }): Promise<{ ok: true } | { ok: false; reason: string; phase?: string }> {
    const policy = await this.deps.gate.current();
    const repository = policy.change?.repositories.find(item => item.repoId === found.repoId);
    // 승인한 뒤에 막히면 되돌릴 수 없다. 확인 전이면 승인을 받지 않고 대기에 둔다.
    if (repository && !repository.writerAccepted) return { ok: false, reason: 'writer_unaccepted' };
    const approved = await this.deps.changes.approve({ changeId: found.id, generation, approvalDigest: digest, eventId: request.id, actor: request.actor });
    return approved.ok ? { ok: true } : { ok: false, reason: approved.reason, ...(approved.current ? { phase: approved.current.phase } : {}) };
  }
  // 게시 승인 버튼. 버튼이 가리키는 generation의 승인 대상 digest로 '/change-publish'와 같은 승인을 한다.
  async pressPublish(request: PublishPress): Promise<PublishPressReply> {
    if (this.deps.closedReason()) return { content: PUBLISH_TEXT.closed, outcome: 'closed' };
    const pressed = PUBLISH_TARGET.exec(request.target);
    const found = pressed ? await this.own({ ...request, target: pressed[1] }) : null;
    if (!pressed || !found) return { content: PUBLISH_TEXT.notVisible, outcome: 'not_visible' };
    const generation = Number(pressed[2]);
    const stale = { content: PUBLISH_TEXT.stale, outcome: 'stale' };
    // 새 generation이 열렸으면 그 버튼이 본 미리보기는 지난 것이다.
    if (generation !== found.generation) return stale;
    const subject = await this.deps.changes.approvalSubject({ changeId: found.id, generation });
    if (!subject.ok || !subject.value.digest.startsWith(pressed[3]!)) return stale;
    const approved = await this.approve(found, generation, subject.value.digest, request);
    if (approved.ok) {
      // 갱신 응답은 그 글 본문을 바꾸므로 미리보기 마지막 쪽을 남기고 결과를 붙인다. 보존 기간이 지나 본문을 비웠으면 결과만 남는다.
      const page = (await this.deps.store.db.query<{ content: string | null }>(`SELECT payload->>'content' AS content FROM outbox WHERE message_key=$1
        ORDER BY page_index DESC LIMIT 1`, [changePreviewKey(found.id, generation)])).rows[0]?.content;
      return { content: page ? `${page}\n\n${PUBLISH_TEXT.approved(found.id)}` : PUBLISH_TEXT.approved(found.id), outcome: 'approved', update: true };
    }
    if (approved.reason === 'writer_unaccepted') return { content: PUBLISH_TEXT.writerUnaccepted, outcome: approved.reason };
    if (approved.reason === 'duplicate_event' || approved.reason === 'phase_conflict' && approved.phase !== undefined && SETTLED_PHASES.has(approved.phase)) {
      return { content: PUBLISH_TEXT.settled, outcome: 'settled' };
    }
    if (approved.reason === 'owner_mismatch') return { content: PUBLISH_TEXT.notVisible, outcome: approved.reason };
    if (approved.reason === 'phase_conflict' || approved.reason === 'digest_mismatch') return { ...stale, outcome: approved.reason };
    return { content: PUBLISH_TEXT.failed, outcome: approved.reason };
  }
  private async cancel(request: ChangeCommandRequest): Promise<ChangeCommandReply> {
    const c = this.colleague;
    const found = await this.own(request);
    if (!found) return { content: CHANGE_TEXT.notVisible, outcome: 'not_visible' };
    if (found.phase === 'merged' || found.phase === 'observing_deploy') return { content: CHANGE_TEXT.cancelMerged, outcome: 'merged' };
    const moved = await this.deps.changes.transition({ changeId: found.id, generation: found.generation, from: found.phase, to: 'cancelled', reason: 'owner_cancelled' });
    if (!moved.ok) return { content: moved.reason === 'transition_not_allowed' ? CHANGE_TEXT.cancelFinished(c, found.phase) : CHANGE_TEXT.cancelRace(c), outcome: moved.reason };
    const published = found.phase === 'publishing' || found.phase === 'proposed';
    return { content: CHANGE_TEXT.cancelled(c, found.id, published), outcome: 'cancelled' };
  }
  // 수정 요청 대상. 남의 변경·다른 스레드의 변경은 존재도 알리지 않는다(not_visible). 병합·닫힘·상한·민감한 말은 거절 사유를 돌려준다.
  private async prepareAmendment(input: { actor: string; scope: Scope; target: string; instruction: string }): Promise<AmendmentTarget> {
    const target = input.target.trim();
    const pr = /^(?:#?(\d{1,9})|https:\/\/github\.com\/([^/\s]+\/[^/\s]+)\/pull\/(\d{1,9})\/?)$/.exec(target);
    const conversation = this.deps.store.scopeId(input.scope);
    const policy = await this.deps.gate.current();
    // 링크로 지정하면 저장소까지 대상이다. 번호만 맞추면 같은 스레드의 다른 저장소 PR이 골라져 엉뚱한 브랜치에 커밋이 올라간다.
    const linked = pr?.[2] === undefined ? null : policy.change?.repositories.find(item => item.fullName.toLowerCase() === pr[2]!.toLowerCase())?.repoId ?? -1;
    const id = CHANGE_ID.test(target) ? target : pr && linked !== -1 ? (await this.deps.store.db.query<{ id: string }>(`SELECT r.id FROM change_requests r JOIN change_delivery_effects e
      ON e.change_id=r.id AND e.generation=r.generation AND e.stage='pull' AND e.state='confirmed' WHERE r.owner_id=$1 AND r.conversation_id=$2 AND e.result->>'number'=$3
      AND ($4::bigint IS NULL OR r.repo_id=$4) ORDER BY r.updated_at DESC LIMIT 1`, [input.actor, conversation, String(Number(pr[1] ?? pr[3])), linked])).rows[0]?.id : undefined;
    const found = id ? await this.own({ actor: input.actor, scope: input.scope, target: id }) : null;
    if (!found) return { ok: false, reason: 'not_visible' };
    const key = { changeId: found.id, generation: found.generation };
    const pull = (await this.deps.store.db.query<{ result: unknown }>(`SELECT result FROM change_delivery_effects WHERE change_id=$1 AND generation=$2 AND stage='pull' AND state='confirmed'`,
      [found.id, found.generation])).rows[0];
    if (found.phase !== 'proposed' && found.phase !== 'amending') return { ok: false, reason: pull || found.phase === 'merged' || found.phase === 'observing_deploy' ? 'not_open' : 'no_pull' };
    if (!pull) return { ok: false, reason: 'no_pull' };
    if ((await this.deps.changes.amendments(key)).length >= CHANGE_AMENDMENT.maxRounds) return { ok: false, reason: 'limit' };
    const repository = policy.change?.repositories.find(item => item.repoId === found.repoId);
    if (!repository || !this.deps.discussion) return { ok: false, reason: 'unavailable' };
    // 지시는 작성 모델에만 가지만, 공개하면 안 되는 값이 섞인 말은 첫 요청(scanBrief)처럼 받지 않는다.
    if (scanPublicText({ title: input.instruction, body: input.instruction }, repository)) return { ok: false, reason: 'sensitive' };
    const pullNumber = (typeof pull.result === 'string' ? JSON.parse(pull.result) : pull.result as { number: number }).number as number;
    const head = await this.deps.changes.publishedHeadOf(key);
    if (!head) return { ok: false, reason: 'unavailable' };
    let read: PullDiscussion;
    try { read = await this.deps.discussion({ repository: repository.fullName, pr: pullNumber }); }
    catch (error) { this.deps.log('change_amendment_discussion_failed', errorInfo(error)); return { ok: false, reason: 'unavailable' }; }
    // DB phase는 마지막 병합 읽기(5분 주기)에 머물러 있다. 그 사이 GitHub에서 병합·닫힌 PR에 확인 버튼을 내면 누른 뒤 차례·횟수가 생긴다.
    if (!read.open) return { ok: false, reason: 'not_open' };
    const items = discussionMaterials(read);
    return { ok: true, changeId: found.id, generation: found.generation, repository: repository.fullName, pullNumber, head,
      materials: items.map(item => item.id), materialsDigest: amendmentMaterialsDigest(items) };
  }
  private async requestAmendment(input: Parameters<AmendmentRequests['request']>[0]): Promise<ChangeCommandReply> {
    if (this.deps.closedReason()) return { content: AMENDMENT_REQUEST_TEXT.closed, outcome: 'closed' };
    const found = await this.own({ actor: input.actor, scope: input.scope, target: input.changeId });
    if (!found) return { content: CHANGE_TEXT.notVisible, outcome: 'not_visible' };
    // 수정 요청 출처는 변경 요청과 같은 공개 표시다(DECISIONS "동료 봇 전환" 15·16, C27 판단).
    const queued = await this.deps.changes.requestAmendment({ changeId: input.changeId, generation: input.generation, eventId: input.id, actor: input.actor,
      pullNumber: input.pullNumber, head: input.head, materials: input.materials, materialsDigest: input.materialsDigest, instruction: input.instruction, label: 'public' });
    if (queued.ok) {
      return found.phase === 'amending' ? { content: AMENDMENT_REQUEST_TEXT.queued(queued.value.round), outcome: 'queued' } : { content: AMENDMENT_REQUEST_TEXT.accepted(queued.value.round), outcome: 'accepted' };
    }
    if (queued.reason === 'amendment_limit') return { content: AMENDMENT_REQUEST_TEXT.limit(CHANGE_AMENDMENT.maxRounds), outcome: queued.reason };
    if (queued.reason === 'phase_conflict') return { content: AMENDMENT_REQUEST_TEXT.not_open, outcome: queued.reason };
    if (queued.reason === 'pull_mismatch' || queued.reason === 'duplicate_event') return { content: AMENDMENT_REQUEST_TEXT.stale, outcome: queued.reason };
    this.deps.log('change_amendment_request_failed', { reason: queued.reason });
    return { content: AMENDMENT_REQUEST_TEXT.failed, outcome: queued.reason };
  }
  private async status(request: ChangeCommandRequest): Promise<ChangeCommandReply> {
    const c = this.colleague;
    const found = await this.own(request);
    if (!found) return { content: CHANGE_TEXT.notVisible, outcome: 'not_visible' };
    const db = this.deps.store.db;
    const key: ChangeKey = { changeId: found.id, generation: found.generation };
    const lines = [`변경 ${found.id} g${found.generation}: ${found.phase}${found.phaseReason ? `(${found.phaseReason})` : ''}`, `저장소 ID ${found.repoId}, base ${found.baseBranch}, 출처 ${found.label}`];
    const closed = this.deps.closedReason();
    if (closed) lines.push(CHANGE_TEXT.statusClosed(c, closed));
    for (const child of (await db.query<{ role: string; id: string; state: string; wait_reason: string | null }>(`SELECT c.role,j.id,j.state,j.wait_reason FROM change_child_jobs c JOIN jobs j ON j.id=c.job_id
      WHERE c.change_id=$1 AND c.generation=$2 ORDER BY c.created_at`, [found.id, found.generation])).rows) {
      lines.push(`${child.role === 'author' ? '작성' : '리뷰'} 작업 ${child.id}: ${child.state}${child.wait_reason ? `(${child.wait_reason})` : ''}`);
      if (child.state === 'unknown') lines.push(CHANGE_TEXT.statusChildUnknown(c, child.id));
    }
    if (found.phase === 'awaiting_publish_approval') {
      const subject = await this.deps.changes.approvalSubject(key);
      if (subject.ok) lines.push(`승인 digest: ${subject.value.digest}`);
    }
    for (const effect of await this.deps.changes.unresolvedEffects({ changeId: found.id })) {
      lines.push(`미확정 게시 기록: g${effect.generation} ${effect.stage} ${effect.state}${effect.blockedReason ? `(${effect.blockedReason})` : ''}. ${CHANGE_TEXT.statusUnresolved}`);
    }
    const pull = (await db.query<{ result: unknown }>(`SELECT result FROM change_delivery_effects WHERE change_id=$1 AND generation=$2 AND stage='pull' AND state='confirmed'`, [found.id, found.generation])).rows[0];
    if (pull) {
      const number = (typeof pull.result === 'string' ? JSON.parse(pull.result) : pull.result as { number: number }).number;
      lines.push(`PR #${number}${found.phase === 'superseded' || found.phase === 'blocked' ? `: ${CHANGE_TEXT.statusUntracked}` : ''}`);
    }
    // 수정 차례(C27). 차례마다 한 줄이고 사유는 고정 코드다.
    const rounds = await this.deps.changes.amendments(key);
    if (rounds.length) lines.push(`수정 차례 ${rounds.length}/${CHANGE_AMENDMENT.maxRounds}: ${rounds.map(round => `${round.round} ${round.state}${round.reason ? `(${round.reason})` : ''}${round.commitSha ? ` ${round.commitSha.slice(0, 12)}` : ''}`).join(', ')}`);
    for (const effect of await this.deps.changes.amendmentEffects({ changeId: found.id, unresolved: true })) {
      lines.push(`미확정 수정 커밋 기록: 차례 ${effect.round} ${effect.stage} ${effect.state}${effect.blockedReason ? `(${effect.blockedReason})` : ''}.`);
    }
    const deployment = await this.deps.changes.deployment(key);
    if (deployment.ok) {
      const { prNumber: _pr, ...observation } = deployment.value;
      lines.push(describeDeployment(observation));
    }
    if ((await db.query(`SELECT 1 FROM change_artifacts WHERE change_id=$1 AND purged_at IS NOT NULL
      UNION ALL SELECT 1 FROM change_requests WHERE id=$1 AND brief_purged_at IS NOT NULL LIMIT 1`, [found.id])).rows.length) lines.push(CHANGE_TEXT.statusPurged);
    return { content: lines.join('\n'), outcome: 'status' };
  }
}
// ---- 수정 요청 자료 (C27) ----

// PR 리뷰·리뷰 댓글·대화 댓글을 수정 차례의 자료 항목으로 옮긴다. 확인 글의 k와 ID 묶음, 실행 때의 자료 블록이 같은 함수를 쓴다.
// 본문이 빈 리뷰(승인만 누른 리뷰 등)는 반영할 내용이 없어 빼고 세지 않는다. 오래된 것부터 둔다(상한이 넘치면 앞에서부터 빠진다).
// 다른 PR의 글이 섞인 응답은 읽는 쪽(github-review-io discussion.read)이 통째로 거부한다.
export interface AmendmentMaterialItem { id: string; material: ReviewMaterial }
export type AmendmentDiscussionReader = (input: { repository: string; pr: number }) => Promise<PullDiscussion>;
const ASSOCIATIONS: ReadonlySet<string> = new Set(AUTHOR_ASSOCIATIONS);
export function discussionMaterials(discussion: PullDiscussion): AmendmentMaterialItem[] {
  const association = (value: string) => (ASSOCIATIONS.has(value) ? value : 'NONE') as ReviewMaterial['association'];
  const at = (value: string | null) => value ? Date.parse(value) || 0 : 0;
  const items: (AmendmentMaterialItem & { at: number })[] = [
    ...discussion.reviews.map(row => ({ id: `review:${row.id}`, at: at(row.createdAt), material: { kind: 'review' as const, authorId: row.author?.id ?? null, association: association(row.association), location: null, body: row.body } })),
    ...discussion.reviewComments.map(row => ({ id: `review_comment:${row.id}`, at: at(row.createdAt), material: { kind: 'review_comment' as const, authorId: row.author?.id ?? null, association: association(row.association),
      location: ChangePathSchema.safeParse(row.path).success ? { path: row.path, line: row.line } : null, body: row.body } })),
    ...discussion.comments.map(row => ({ id: `comment:${row.id}`, at: at(row.createdAt), material: { kind: 'comment' as const, authorId: row.author?.id ?? null, association: association(row.association), location: null, body: row.body } })),
  ];
  return items.filter(item => item.material.body.trim() && AMENDMENT_MATERIAL_ID.test(item.id))
    .sort((a, b) => a.at - b.at || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0)).map(({ id, material }) => ({ id, material }));
}

// 추가 방어다. 탐지기는 완전성 증거가 아니고 owner의 label이 우선이다. 찾으면 모델을 부르기 전에 막아 값을 작성자에 넘기지 않는다.
function scanBrief(parsed: ParsedChangeRequest, policy: ChangeRepositoryPolicy): string | null {
  return scanPublicText({ title: parsed.summary, body: [parsed.goal, ...parsed.acceptance, parsed.summary].join('\n') }, policy);
}

const ANSWER_LABEL = /^\s*label=([a-z_]+)\s*\|\s*([\s\S]*)$/;
// /answer는 작업 레인과 같은 명령이다. CHANGE 질문만 출처를 묻고 나머지는 그대로 넘긴다.
// 답을 작성자에 넘기기 전에 출처를 기록한다. private·unknown이면 작성자에 닿기 전에 부모를 닫는다.
export class ChangeAnswerGuard implements TaskCommandHandler {
  constructor(private readonly inner: TaskCommandHandler, private readonly inputs: Pick<ChangePrivateInputs, 'recordIn'>, private readonly gate: PolicyGate) {}
  admit(store: Store, project: string | undefined) { return this.inner.admit(store, project); }
  cancelIn(store: Store, actor: string, conversation: string, job: string, cursor: string) { return this.inner.cancelIn(store, actor, conversation, job, cursor); }
  status(actor: string, scope: Scope, job: string) { return this.inner.status(actor, scope, job); }
  release(request: { id: string; actor: string; scope: Scope; job: string; revision: string }) { return this.inner.release(request); }
  // CHANGE 질문의 답은 label을 읽기 전의 글이다. events는 대화 맥락으로 모델에 들어가므로 원문의 자리는 재개가 읽는 칸과 ChangePrivateInputs 표뿐이다.
  async sealsAnswer(db: Database, question: string): Promise<boolean> {
    return (await db.query(`SELECT 1 FROM codex_questions q JOIN change_child_jobs c ON c.job_id=q.job_id AND c.role='author' WHERE q.id=$1`, [question])).rows.length > 0;
  }
  async answerIn(store: Store, input: TaskAnswerInput): Promise<TaskAnswerResult> {
    const link = (await store.db.query<{ change_id: string; generation: number | string; repo_id: number | string; conversation_id: string; responder_id: string; state: string }>(`SELECT c.change_id,c.generation,r.repo_id,q.conversation_id,q.responder_id,q.state
      FROM codex_questions q JOIN change_child_jobs c ON c.job_id=q.job_id AND c.role='author' JOIN change_requests r ON r.id=c.change_id WHERE q.id=$1`, [input.question])).rows[0];
    if (!link) return this.inner.answerIn(store, input);
    const policy = await this.gate.withDatabase(store.db).authorize(input.actor, input.scope);
    // 다른 스레드에서 답해 이 질문의 출처를 정하지 못한다.
    if (link.conversation_id !== store.scopeId(input.scope) || link.responder_id !== input.actor) throw new Denied();
    // 닫힌 질문은 기록할 것이 없다. 안내는 원래 경로가 한다.
    if (link.state !== 'open') return this.inner.answerIn(store, input);
    const matched = ANSWER_LABEL.exec(input.text);
    const label = matched?.[1];
    const c = store.colleague;
    if (!matched || !label || !LABELS.has(label)) return { ok: false, status: CHANGE_TEXT.answerUsage(c) };
    const key = { changeId: link.change_id, generation: Number(link.generation) };
    const body = matched[2]!;
    if (!labelAllowsAuthorInput(label as ProvenanceLabel)) {
      await this.inputs.recordIn(store.db, { ...key, eventId: input.event, label: label as ProvenanceLabel, text: body });
      return { ok: false, status: CHANGE_TEXT.answerLabelBlocked(c, label) };
    }
    const repository = policy.change?.repositories.find(item => item.repoId === Number(link.repo_id));
    // 내부 표식을 볼 수 없으면 공개 답이라고 말할 수 없다. 기록도 닫기도 하지 않아 정책이 돌아오면 다시 답할 수 있다.
    if (!repository) return { ok: false, status: CHANGE_TEXT.answerNoPolicy };
    // 첫 요청의 scanBrief와 같은 규칙이다. owner가 public이라 적었어도 찾으면 private로 올린다.
    const sensitive = scanPublicText({ title: body, body }, repository);
    if (sensitive) {
      await this.inputs.recordIn(store.db, { ...key, eventId: input.event, label: propagateLabel([label as ProvenanceLabel, 'private']), text: body });
      return { ok: false, status: CHANGE_TEXT.answerSensitive(c, sensitive) };
    }
    const answered = await this.inner.answerIn(store, { ...input, text: body });
    if (!answered.ok || answered.duplicate) return answered;
    const recorded = await this.inputs.recordIn(store.db, { ...key, eventId: input.event, label: label as ProvenanceLabel, text: body });
    return recorded.ok ? answered : { ok: false, status: CHANGE_TEXT.answerNotRecorded(c, recorded.reason) };
  }
}
