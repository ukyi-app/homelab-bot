import { Denied, PolicyUnavailable } from './contracts.js';
import type { Clock, Scope } from './contracts.js';
import type { LedgerState } from './deletion-ledger.js';
import { documentRevision } from './document-source.js';
import { MemoryNotReady, MemoryRejected } from './memory.js';
import { RAW_TEXT_RETENTION_MS } from './raw-text-retention.js';
import type { MemoryInput, MemoryService, MemoryView, SourceRef } from './memory.js';

// 기억 명령. 수신(discord.ts)이 owner·채널 확인과 중복 처리를 마친 명령만 여기로 온다.
// 응답은 상호작용 응답(본인만 보는 ephemeral)으로만 나간다. 기억 내용은 outbox·events·감사·로그에 남기지 않는다.
// 검색 결과는 사람에게 보여 줄 뿐 모델 입력에 넣지 않는다(SEC-01, 모델 맥락 주입은 이 범위 밖).

export type MemoryCommand = 'memory-save' | 'memory-search' | 'memory-correct' | 'memory-exclude' | 'memory-delete';
// threadReply: 결과가 본인 전용 응답이 아니라 스레드 일반 글로 나간다(말로 한 기억 검색). 대화 출처의 Discord ID를 싣지 않는다.
export interface MemoryCommandInput { id: string; actor: string; scope: Scope; command: MemoryCommand; text: string; target?: string; threadReply?: true }
// outcome은 로그용 고정 코드다(ok, 거부 사유 코드). 내용을 담지 않는다.
export interface MemoryCommandReply { content: string; outcome: string }
// guide가 없으면 수신은 꺼짐 판(slash) 안내를 쓴다.
export interface MemoryCommandHandler { handle(input: MemoryCommandInput): Promise<MemoryCommandReply>; readonly guide?: MemoryGuide }

// '/'·명령 이름을 안내하는 문구는 동료 기능 스위치로 두 판을 고른다(명세 §4.9). slash는 꺼짐 판, colleague는 켜짐 판이고
// 켜짐 판에는 '/' 이름도 기억 명령 이름도 쓰지 않는다. ackLost·failed는 수신(discord.ts)이 내용 없이 남기는 고정 안내다.
export type MemorySurface = 'slash' | 'colleague';
export interface MemoryGuide { moreConflicts: string; resolveConflict: string; deleteExcluded: string; ackLost: string; failed: string }
export const MEMORY_GUIDE: Readonly<Record<MemorySurface, MemoryGuide>> = Object.freeze({
  slash: {
    moreConflicts: 'memory-search로 확인',
    resolveConflict: 'memory-correct의 target에 이 ID와 충돌 ID를 쉼표로 함께(최대 5개) 넣어 정정하면 그 충돌이 풀려요.',
    deleteExcluded: '지우려면 memory-delete를 써 주세요.',
    ackLost: '기억 명령의 응답을 전하지 못했어요(상호작용 만료·전송 실패). 처리됐는지는 /memory-search로 확인해 주세요.',
    failed: '처리하지 못했어요(일시 오류). /memory-search로 결과를 확인한 뒤 다시 해 주세요.',
  },
  colleague: {
    moreConflicts: '기억을 다시 찾아 달라고 하면 보여 드려요',
    resolveConflict: '이 기억과 충돌하는 기억을 함께(최대 5개) 정정해 달라고 하면 그 충돌이 풀려요.',
    deleteExcluded: '지우려면 "그 기억 지워 줘"라고 말해 주세요.',
    ackLost: '기억 요청의 결과를 전하지 못했어요(상호작용 만료·전송 실패). 처리됐는지는 그 기억을 다시 찾아 달라고 해서 확인해 주세요.',
    failed: '처리하지 못했어요(일시 오류). 그 기억을 다시 찾아 달라고 해서 결과를 확인한 뒤 다시 해 주세요.',
  },
});
type Memory = Pick<MemoryService, 'remember' | 'search' | 'correct' | 'exclude' | 'delete'>;

// 서식 오류. 메시지는 사용자에게 그대로 보이는 한국어 문장이고 입력값을 되풀이하지 않는다.
export class CommandInputError extends Error {
  constructor(readonly code: string, readonly reply: string) { super(code); }
}
const KINDS = ['configuration', 'decision', 'incident', 'preference'] as const;
type Kind = typeof KINDS[number];
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const HOUR = 3_600_000;
const UNITS: Record<string, number> = { h: HOUR, d: 24 * HOUR, w: 7 * 24 * HOUR };
// 날짜만(시간대 없음)은 받지 않는다. 운영자 시간대를 짐작하지 않게 상대 기간이나 오프셋 있는 ISO 시각만 받는다.
const ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2})?(Z|[+-]\d{2}:\d{2})$/;
const FORMAT = '서식은 `진술 | 키=값 | …`이에요. 진술에는 `|`를 쓰지 말아 주세요.';
const TIME_FORMAT = '시각은 `30d`·`12h`·`2w`(지금부터)나 `2026-12-31T09:00+09:00`처럼 적어 주세요.';
// 종류별로 받는 키. 반복 가능한 키는 목록으로 모은다.
const COMMON = ['topic', 'service', 'recheck', 'expires', 'doc', 'briefing'];
const KEYS: Record<Kind, string[]> = {
  configuration: [...COMMON, 'observed'],
  decision: [...COMMON, 'by', 'decided', 'applies'],
  incident: [...COMMON, 'fact', 'hypothesis', 'cause'],
  preference: [...COMMON, 'end'],
};
const REPEATABLE = new Set(['fact', 'hypothesis', 'cause', 'doc']);
const REQUIRED: Record<Kind, string> = {
  configuration: 'configuration은 `recheck=`나 `expires=`가 있어야 해요(설정은 다시 확인할 때가 있어야 해요).',
  decision: 'decision은 `applies=`(적용 범위)가 있어야 해요. `by=`(결정한 사람)·`decided=`(시각)를 빼면 요청한 분과 지금 시각으로 적어요.',
  incident: '',
  preference: 'preference는 `expires=`(만료)와 `end=`(종료 조건)가 있어야 해요.',
};
// 입력 오류 응답. 키 이름(영문 소문자로 검사된 값)만 되돌려 주고 진술·값은 싣지 않는다.
export const INPUT_ERROR = Object.freeze({
  time: (key: string) => `\`${key}=\` 값을 읽지 못했어요. ${TIME_FORMAT}`,
  statement: `진술이 비어 있어요. ${FORMAT}`,
  format: `\`키=값\` 모양이 아닌 조각이 있어요. ${FORMAT}`,
  key: (key: string, allowed: string[]) => `\`${key}=\`는 이 요청·종류에는 쓸 수 없어요. 쓸 수 있는 키: ${allowed.join(' ')}`,
  value: (key: string) => `\`${key}=\` 값이 비어 있어요.`,
  repeat: (key: string) => `\`${key}=\`는 한 번만 써 주세요.`,
  kind: `종류는 ${KINDS.join('·')} 중 하나예요.`,
  docLength: '`doc=` 링크가 너무 길어요(500자까지).',
  docCount: '`doc=`는 세 개까지 쓸 수 있어요.',
  briefing: '`briefing=`은 yes나 no예요.',
  required: REQUIRED,
  ids: '기억 ID(검색 결과의 `…` 안 값)를 쉼표로 5개까지 적어 주세요.',
  deleteOne: '지울 기억 ID는 하나만 적어 주세요.',
});

function time(key: string, value: string, now: number, relative: 'future' | 'past'): number {
  const rel = /^(\d{1,4})([hdw])$/.exec(value);
  if (rel) {
    const span = Number(rel[1]) * UNITS[rel[2]!]!;
    return relative === 'future' ? now + span : now - span;
  }
  const at = ISO.test(value) ? Date.parse(value) : NaN;
  if (!Number.isFinite(at) || at < 0) throw new CommandInputError('memory_cmd_time', INPUT_ERROR.time(key));
  return at;
}
interface Parsed { statement: string; fields: Map<string, string[]> }
function split(text: string, allowed: string[]): Parsed {
  const [head, ...rest] = text.split('|');
  const statement = (head ?? '').trim();
  if (!statement) throw new CommandInputError('memory_cmd_statement', INPUT_ERROR.statement);
  const fields = new Map<string, string[]>();
  for (const segment of rest) {
    const match = /^\s*([a-z]{1,20})=(.*)$/s.exec(segment);
    // 키 이름만 되돌려 준다(영문 소문자로 검사된 값). 진술·값은 응답에 다시 싣지 않는다.
    if (!match) throw new CommandInputError('memory_cmd_format', INPUT_ERROR.format);
    const [, key, raw] = match as unknown as [string, string, string];
    const value = raw.trim();
    if (!allowed.includes(key)) throw new CommandInputError('memory_cmd_key', INPUT_ERROR.key(key, allowed));
    if (!value) throw new CommandInputError('memory_cmd_value', INPUT_ERROR.value(key));
    const list = fields.get(key) ?? [];
    if (list.length && !REPEATABLE.has(key)) throw new CommandInputError('memory_cmd_repeat', INPUT_ERROR.repeat(key));
    list.push(value);
    fields.set(key, list);
  }
  return { statement, fields };
}
const one = (fields: Map<string, string[]>, key: string) => fields.get(key)?.[0];

export function parseKind(value: string | undefined): Kind {
  const kind = value?.trim();
  if (!KINDS.includes(kind as Kind)) throw new CommandInputError('memory_cmd_kind', INPUT_ERROR.kind);
  return kind as Kind;
}
// 저장·정정의 text를 MemoryInput으로 바꾼다. 출처는 이 명령(대화)이 기본이고 doc=를 더한다.
// 대화 출처는 수신이 저장·수락한 이 상호작용 이벤트다(memory.ts가 events의 actor·accepted·현재 권한을 확인한다).
export function parseMemoryText(kind: Kind, text: string, context: { actor: string; eventId: string; now: number }, extra: string[] = []): { input: MemoryInput; fields: Map<string, string[]> } {
  const { statement, fields } = split(text, [...KEYS[kind], ...extra]);
  const { now } = context;
  const sources: SourceRef[] = [{ type: 'conversation', message: context.eventId }];
  for (const uri of fields.get('doc') ?? []) {
    if (uri.length > 500) throw new CommandInputError('memory_cmd_doc', INPUT_ERROR.docLength);
    sources.push({ type: 'document', uri, revision: documentRevision(uri) });
  }
  if (sources.length > 4) throw new CommandInputError('memory_cmd_doc', INPUT_ERROR.docCount);
  const briefing = one(fields, 'briefing');
  if (briefing !== undefined && !['yes', 'no'].includes(briefing)) throw new CommandInputError('memory_cmd_briefing', INPUT_ERROR.briefing);
  const expires = one(fields, 'expires');
  const recheck = one(fields, 'recheck');
  const common = {
    statement, sources, topic: one(fields, 'topic'),
    // service=: 그 서비스 권한이 정책에서 빠지면 다음 접근부터 이 기억도 숨는다(memory.ts visible).
    ...(one(fields, 'service') ? { scope: { service: one(fields, 'service') } } : {}),
    // safe_summary만 채널 브리핑의 재확인 칸에 들어간다(memory.ts recheckDue). 기본은 internal(검색에서만 보임).
    classification: briefing === 'yes' ? 'safe_summary' as const : 'internal' as const,
    expiresAt: expires === undefined ? undefined : time('expires', expires, now, 'future'),
    recheckAt: recheck === undefined ? undefined : time('recheck', recheck, now, 'future'),
  };
  const list = (key: string) => fields.get(key) ?? [];
  let input: MemoryInput;
  if (kind === 'configuration') {
    if (common.expiresAt === undefined && common.recheckAt === undefined) throw new CommandInputError('memory_cmd_required', REQUIRED.configuration);
    const observed = one(fields, 'observed');
    input = { kind, ...common, observedAt: observed === undefined ? now : time('observed', observed, now, 'past') };
  } else if (kind === 'decision') {
    const appliesTo = one(fields, 'applies');
    if (!appliesTo) throw new CommandInputError('memory_cmd_required', REQUIRED.decision);
    const decided = one(fields, 'decided');
    input = { kind, ...common, appliesTo, decidedBy: one(fields, 'by') ?? context.actor,
      decidedAt: decided === undefined ? now : time('decided', decided, now, 'past') };
  } else if (kind === 'incident') {
    input = { kind, ...common, facts: list('fact'), hypotheses: list('hypothesis'), unconfirmedCauses: list('cause') };
  } else {
    const endCondition = one(fields, 'end');
    if (common.expiresAt === undefined || !endCondition) throw new CommandInputError('memory_cmd_required', REQUIRED.preference);
    input = { kind, ...common, expiresAt: common.expiresAt, endCondition, targetUser: context.actor };
  }
  return { input, fields };
}
export function parseIds(target: string | undefined): string[] {
  const ids = [...new Set((target ?? '').split(',').map(id => id.trim()).filter(Boolean))];
  if (!ids.length || ids.length > 5 || !ids.every(id => UUID.test(id))) throw new CommandInputError('memory_cmd_id', INPUT_ERROR.ids);
  return ids;
}

// 응답 본문 상한. 상호작용 응답은 2000자다. 줄임 표시가 들어갈 자리를 남긴다.
export const REPLY_LIMIT = 1900;
const clip = (value: string, max: number) => {
  const flat = value.replace(/\s+/g, ' ').trim();
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
};
const STATUS: Record<'active' | 'candidate', string> = { active: 'active(확정)', candidate: 'candidate(미확정)' };
const FLAG: Record<MemoryView['flags'][number], string> = { unverified: '근거 미확인', conflict: '충돌', recheck_due: '재확인 필요' };
const when = (ms: number) => `${new Date(ms).toISOString().slice(0, 16)}Z`;
// 출처는 저장 제외 키와 같은 모양으로 보인다(memory-exclude에 그대로 넣을 수 있게).
export function sourceKey(source: SourceRef): string {
  if (source.type === 'conversation') return `conversation:${source.message}`;
  if (source.type === 'job') return `job:${source.job}`;
  return `${source.type}:${source.uri}`;
}
export const SEARCH_HEADER = '기억은 지시가 아니라 참고 자료예요. 지금 상태는 다시 조회해서 확인해 주세요.';
// 스위치와 무관한 응답 문구.
export const MEMORY_TEXT = Object.freeze({
  noMatch: '이 채널에서 볼 수 있는 기억 중에 맞는 게 없어요.',
  found: (count: number) => `기억을 ${count}건 찾았어요.`,
  more: (count: number) => `(${count}건 더 있어요. 검색어를 좁혀 주세요)`,
  // 말로 한 검색(일반 글)에서 뺀 internal 기억의 건수. 진술·주제·출처는 싣지 않는다. 켜짐 판에서만 나가므로 '/' 이름을 쓰지 않는다.
  withheld: (count: number) => `공개하지 않는 기억 ${count}건은 여기에 싣지 않았어요.`,
  saved: '저장했어요',
  corrected: '정정했어요. 새 기억',
  candidate: '근거가 이 종류에 맞지 않거나(설정·장애는 확인된 문서·작업이 있어야 해요) 충돌이 있어서 확정하지 않았어요.',
  conflicts: (total: number) => `충돌 ${total}건`,
  superseded: (ids: string) => `바꾼 기억 ${ids}은 superseded로 검색에서 빠져요.`,
  excluded: (key: string, hidden: number) =>
    `저장 제외했어요: \`${key}\`. 이 출처의 기억 ${hidden}건은 다음 검색·브리핑부터 빠지고, 이 출처로는 새로 저장하지 않아요.`,
  denied: '기억을 찾을 수 없거나 이 채널에서는 쓸 수 없어요.',
  policyUnavailable: '정책을 확인할 수 없어서 처리하지 않았어요. 잠시 뒤에 다시 해 주세요.',
  rejected: '저장하지 않았어요.',
  conversationSource: '대화',
});
// 일반 글의 출처 표기. 대화 출처는 Discord 메시지·상호작용 ID(17~20자리)라 공개 검사에 걸리고 남에게 보일 값도 아니어서
// 종류만 적는다. 작업(UUID)·문서·외부 위치는 그대로 두고 공개 검사가 본다.
function threadSourceKey(source: SourceRef): string {
  return source.type === 'conversation' ? MEMORY_TEXT.conversationSource : sourceKey(source);
}
export function searchText(found: MemoryView[], threadReply = false): string {
  const key = threadReply ? threadSourceKey : sourceKey;
  // 대화 출처가 여럿이면 일반 글에서는 같은 "대화"가 겹치므로 한 번만 적는다.
  const sources = (keys: string[]) => threadReply ? [...new Set(keys)] : keys;
  // 일반 글에는 safe_summary 기억만 싣고 나머지는 건수만 적는다(internal은 본인 전용 응답에서만 보인다). 게시 전 공개 검사는
  // 비밀 모양만 잡아 internal 진술을 못 거르므로 본문을 만들기 전에 뺀다.
  const views = threadReply ? found.filter(view => view.classification === 'safe_summary') : found;
  const withheld = found.length - views.length;
  const note = withheld ? `\n${MEMORY_TEXT.withheld(withheld)}` : '';
  if (!views.length) return withheld ? MEMORY_TEXT.withheld(withheld) : `${MEMORY_TEXT.noMatch}\n${SEARCH_HEADER}`;
  const lines = [`${MEMORY_TEXT.found(views.length)} ${SEARCH_HEADER}`];
  let shown = 0;
  for (const view of views) {
    const flags = view.flags.map(flag => FLAG[flag]);
    const at = view.observedAt !== null ? `관측 ${when(view.observedAt)}` : `저장 ${when(view.createdAt)}`;
    const line = [`- \`${view.id}\` ${STATUS[view.status]} ${view.kind}${flags.length ? ` [${flags.join('·')}]` : ''}`,
      `  ${clip(view.statement, 200)}`,
      `  출처 ${sources(view.sources.map(source => clip(key(source), 120))).join(', ') || '없음'} · ${at}`].join('\n');
    const tail = `\n${MEMORY_TEXT.more(views.length - shown)}`;
    if ([...lines, line].join('\n').length + tail.length + note.length > REPLY_LIMIT) { lines.push(tail.trim()); break; }
    lines.push(line);
    shown++;
  }
  return lines.join('\n') + note;
}
// 충돌 ID 수에는 상한이 없다(같은 주제의 진술이 쌓이면 늘어난다). 저장·정정은 응답 전에 이미 끝났으므로 응답이 Discord 한도를
// 넘어 거부되면 사용자는 결과를 못 본다. 검색처럼 전체 길이를 자르고 남은 충돌은 개수로 적는다.
export function savedText(verb: string, result: { id: string; status: 'active' | 'candidate'; conflictsWith: string[] },
  limit = REPLY_LIMIT, surface: MemorySurface = 'slash'): string {
  const guide = MEMORY_GUIDE[surface];
  const lines = [`${verb}: \`${result.id}\` · 상태 ${STATUS[result.status]}`,
    ...(result.status === 'candidate' ? [MEMORY_TEXT.candidate] : [])];
  const total = result.conflictsWith.length;
  if (!total) return lines.join('\n');
  const line = (shown: string[], more: number) =>
    `${MEMORY_TEXT.conflicts(total)}: ${shown.join(', ')}${more ? ` 외 ${more}건(${guide.moreConflicts})` : ''}. ${guide.resolveConflict}`;
  const ids: string[] = [];
  for (const [index, id] of result.conflictsWith.entries()) {
    const left = total - index - 1;
    if ([...lines, line([...ids, `\`${id}\``], left)].join('\n').length > limit) {
      lines.push(line(ids, total - ids.length));
      return lines.join('\n');
    }
    ids.push(`\`${id}\``);
  }
  lines.push(line(ids, 0));
  return lines.join('\n');
}
// 삭제 범위 문구. 서비스 메시지(memory.ts)를 그대로 싣고, Discord 사본 범위를 늘 덧붙인다.
export const DELETE_SCOPE = '이미 Discord에 올라간 사본(브리핑, 기억 응답)은 지우지 않아요.';
export const DELETE_PENDING_SCOPE = '완료돼도 백업에는 최대 14일 남을 수 있어요. 같은 삭제를 다시 요청하면 진행 상황을 볼 수 있어요.';
// 원문 수명 안내(명세 §4.3 "기억 원문", DECISIONS T31). 기억 삭제는 원문을 지우지 않는다. 받아 둔 원문(events.payload.text)은
// 받은 지 7일 뒤 T31 정리가 비우고, owner가 Discord에 올린 메시지는 봇이 지우지 않는다. 그래서 지금 지운다고 말하지 않는다.
export const RAW_TEXT_NOTICE = `이 스레드의 원래 메시지는 ${RAW_TEXT_RETENTION_MS / 86_400_000}일 뒤에 지워져요(제가 받아 둔 원문 기준이고, Discord에 올라간 메시지는 그대로 남아요).`;

export const UNAVAILABLE = '지금은 기억을 쓸 수 없어요. 삭제 원장이 준비되지 않았거나 닫혀 있어요. 잠시 뒤에 다시 해 주세요.';
export const REJECTED: Readonly<Record<string, string>> = Object.freeze({
  memory_invalid: '기억 형식에 맞지 않아요(진술은 1000자까지예요. 값의 길이·개수를 확인해 주세요).',
  memory_source_required: '출처가 없어요.',
  memory_recheck_required: REQUIRED.configuration,
  memory_already_expired: '`expires=`가 이미 지난 시각이에요.',
  memory_access_scope: '이 채널에서는 기억을 쓸 수 없어요(대화·알림 채널과 그 스레드에서만 돼요).',
  memory_service_scope: '허용되지 않은 서비스 범위예요.',
  memory_guild_scope: '허용되지 않은 서버 범위예요.',
  memory_source_excluded: '저장 제외한 출처(이 채널·대화)라서 저장하지 않았어요.',
  memory_source_inaccessible: '출처를 확인할 수 없어서 저장하지 않았어요. 문서는 ukyi-app/homelab·ukyi-app/homelab-bot의 GitHub 링크만 받아요.',
  memory_correction_reason_required: '정정하려면 `reason=`(사유)이 있어야 해요.',
  memory_exclusion_invalid: '출처 키 모양이 아니에요. 예: here, channel:<ID>, conversation:<ID>, document:<URL>',
});

export class MemoryCommands implements MemoryCommandHandler {
  readonly guide: MemoryGuide;
  private readonly surface: MemorySurface;
  // colleague는 동료 기능 스위치 값(config.colleagueEnabled === true)이다. 기동 때 한 번 정해진다.
  constructor(private readonly memory: Memory, private readonly ledger: () => LedgerState,
    private readonly closed: () => boolean = () => false, private readonly now: Clock = Date.now, colleague = false) {
    this.surface = colleague ? 'colleague' : 'slash';
    this.guide = MEMORY_GUIDE[this.surface];
  }
  async handle(input: MemoryCommandInput): Promise<MemoryCommandReply> {
    // 종료 중이거나 원장이 닫힘·실패·차단이면 쓰지 않는다. degraded는 다음 성공에 돌아오는 상태라 받는다
    // (그때 삭제는 pending으로 답한다).
    if (this.closed() || ['closed', 'failed', 'fenced'].includes(this.ledger())) return { content: UNAVAILABLE, outcome: 'unavailable' };
    try { return { content: await this.run(input), outcome: 'ok' }; } catch (error) {
      if (error instanceof CommandInputError) return { content: error.reply, outcome: error.code };
      if (error instanceof MemoryNotReady) return { content: UNAVAILABLE, outcome: 'memory_not_ready' };
      if (error instanceof MemoryRejected) return { content: REJECTED[error.message] ?? MEMORY_TEXT.rejected, outcome: error.message };
      // 남의 기억·다른 채널 기억·없는 ID를 구분하지 않는다(존재 여부를 알리지 않음, memory.ts delete 주석).
      if (error instanceof Denied) return { content: MEMORY_TEXT.denied, outcome: 'denied' };
      if (error instanceof PolicyUnavailable) return { content: MEMORY_TEXT.policyUnavailable, outcome: 'policy_unavailable' };
      throw error;
    }
  }
  private async run({ id, actor, scope, command, text, target, threadReply }: MemoryCommandInput): Promise<string> {
    const context = { actor, eventId: id, now: this.now() };
    if (command === 'memory-save') {
      const { input } = parseMemoryText(parseKind(target), text, context);
      return savedText(MEMORY_TEXT.saved, await this.memory.remember(actor, scope, input), REPLY_LIMIT, this.surface);
    }
    if (command === 'memory-search') return searchText(await this.memory.search(actor, scope, text), threadReply === true);
    if (command === 'memory-correct') {
      const ids = parseIds(target);
      // kind·reason은 진술 뒤 키로 받는다(옵션이 text·target 둘뿐이라 target은 ID가 쓴다).
      const kindAt = /\|\s*kind=([a-z]+)\s*(?=\||$)/.exec(text);
      const kind = parseKind(kindAt?.[1]);
      const { input, fields } = parseMemoryText(kind, text, context, ['kind', 'reason']);
      const reason = one(fields, 'reason');
      if (!reason) throw new CommandInputError('memory_cmd_reason', REJECTED.memory_correction_reason_required!);
      const result = await this.memory.correct(actor, scope, ids, input, reason);
      const replaced = MEMORY_TEXT.superseded(ids.map(old => `\`${old}\``).join(', '));
      return `${savedText(MEMORY_TEXT.corrected, result, REPLY_LIMIT - replaced.length - 1, this.surface)}\n${replaced}`;
    }
    if (command === 'memory-exclude') {
      const raw = (target ?? '').trim();
      // here: 이 명령을 쓴 채널·스레드. 그 채널을 출처로 한 대화·작업 기억이 모두 빠진다(memory.ts 출처 키).
      const key = raw === 'here' ? `channel:${scope.channel}` : raw;
      const { hidden } = await this.memory.exclude(actor, scope, key);
      // here는 채널 ID 없이 그대로 적는다. 말로 한 저장 제외의 결과는 스레드 일반 글로도 나가고, 채널 ID는 공개 검사에 걸린다.
      return `${MEMORY_TEXT.excluded(clip(raw === 'here' ? 'here' : key, 200), hidden)} ${this.guide.deleteExcluded}`;
    }
    const ids = parseIds(target);
    if (ids.length !== 1) throw new CommandInputError('memory_cmd_id', INPUT_ERROR.deleteOne);
    const memoryId = ids[0]!;
    const result = await this.memory.delete(actor, scope, memoryId);
    return result.status === 'deleted'
      ? `상태: 삭제 완료(deleted) \`${memoryId}\`\n${result.message}\n${DELETE_SCOPE}\n${RAW_TEXT_NOTICE}`
      : `상태: 삭제 대기(pending) \`${memoryId}\`\n${result.message}\n${DELETE_PENDING_SCOPE} ${DELETE_SCOPE}\n${RAW_TEXT_NOTICE}`;
  }
}
