import { Denied, PolicyUnavailable } from './contracts.js';
import type { Clock, Scope } from './contracts.js';
import type { LedgerState } from './deletion-ledger.js';
import { documentRevision } from './document-source.js';
import { MemoryNotReady, MemoryRejected } from './memory.js';
import type { MemoryInput, MemoryService, MemoryView, SourceRef } from './memory.js';

// T20 기억 명령(B4). 수신(discord.ts)이 owner·채널 확인과 중복 처리를 마친 명령만 여기로 온다.
// 응답은 상호작용 응답(본인만 보는 ephemeral)으로만 나간다. 기억 내용은 outbox·events·감사·로그에 남기지 않는다.
// 검색 결과는 사람에게 보여 줄 뿐 모델 입력에 넣지 않는다(SEC-01, 모델 맥락 주입은 이 범위 밖).

export type MemoryCommand = 'memory-save' | 'memory-search' | 'memory-correct' | 'memory-exclude' | 'memory-delete';
export interface MemoryCommandInput { id: string; actor: string; scope: Scope; command: MemoryCommand; text: string; target?: string }
// outcome은 로그용 고정 코드다(ok, 거부 사유 코드). 내용을 담지 않는다.
export interface MemoryCommandReply { content: string; outcome: string }
export interface MemoryCommandHandler { handle(input: MemoryCommandInput): Promise<MemoryCommandReply> }
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
const FORMAT = '서식: `진술 | 키=값 | …`. 진술에는 `|`를 쓰지 않습니다.';
const TIME_FORMAT = '시각은 `30d`·`12h`·`2w`(지금부터) 또는 `2026-12-31T09:00+09:00`처럼 씁니다.';
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
  configuration: 'configuration은 `recheck=` 또는 `expires=`가 필요합니다(설정은 다시 확인할 때가 있어야 합니다).',
  decision: 'decision은 `applies=`(적용 범위)가 필요합니다. `by=`(결정한 사람)·`decided=`(시각)는 없으면 나·지금입니다.',
  incident: '',
  preference: 'preference는 `expires=`(만료)와 `end=`(종료 조건)가 필요합니다.',
};

function time(key: string, value: string, now: number, relative: 'future' | 'past'): number {
  const rel = /^(\d{1,4})([hdw])$/.exec(value);
  if (rel) {
    const span = Number(rel[1]) * UNITS[rel[2]!]!;
    return relative === 'future' ? now + span : now - span;
  }
  const at = ISO.test(value) ? Date.parse(value) : NaN;
  if (!Number.isFinite(at) || at < 0) throw new CommandInputError('memory_cmd_time', `\`${key}=\` 값을 읽지 못했습니다. ${TIME_FORMAT}`);
  return at;
}
interface Parsed { statement: string; fields: Map<string, string[]> }
function split(text: string, allowed: string[]): Parsed {
  const [head, ...rest] = text.split('|');
  const statement = (head ?? '').trim();
  if (!statement) throw new CommandInputError('memory_cmd_statement', `진술이 비어 있습니다. ${FORMAT}`);
  const fields = new Map<string, string[]>();
  for (const segment of rest) {
    const match = /^\s*([a-z]{1,20})=(.*)$/s.exec(segment);
    // 키 이름만 되돌려 준다(영문 소문자로 검사된 값). 진술·값은 응답에 다시 싣지 않는다.
    if (!match) throw new CommandInputError('memory_cmd_format', `\`키=값\` 모양이 아닌 조각이 있습니다. ${FORMAT}`);
    const [, key, raw] = match as unknown as [string, string, string];
    const value = raw.trim();
    if (!allowed.includes(key)) throw new CommandInputError('memory_cmd_key', `\`${key}=\`는 이 명령·종류에서 쓰지 않습니다. 쓸 수 있는 키: ${allowed.join(' ')}`);
    if (!value) throw new CommandInputError('memory_cmd_value', `\`${key}=\` 값이 비어 있습니다.`);
    const list = fields.get(key) ?? [];
    if (list.length && !REPEATABLE.has(key)) throw new CommandInputError('memory_cmd_repeat', `\`${key}=\`는 한 번만 씁니다.`);
    list.push(value);
    fields.set(key, list);
  }
  return { statement, fields };
}
const one = (fields: Map<string, string[]>, key: string) => fields.get(key)?.[0];

export function parseKind(value: string | undefined): Kind {
  const kind = value?.trim();
  if (!KINDS.includes(kind as Kind)) throw new CommandInputError('memory_cmd_kind', `종류는 ${KINDS.join('·')} 중 하나입니다.`);
  return kind as Kind;
}
// 저장·정정의 text를 MemoryInput으로 바꾼다. 출처는 이 명령(대화)이 기본이고 doc=를 더한다.
// 대화 출처는 수신이 저장·수락한 이 상호작용 이벤트다(memory.ts가 events의 actor·accepted·현재 권한을 확인한다).
export function parseMemoryText(kind: Kind, text: string, context: { actor: string; eventId: string; now: number }, extra: string[] = []): { input: MemoryInput; fields: Map<string, string[]> } {
  const { statement, fields } = split(text, [...KEYS[kind], ...extra]);
  const { now } = context;
  const sources: SourceRef[] = [{ type: 'conversation', message: context.eventId }];
  for (const uri of fields.get('doc') ?? []) {
    if (uri.length > 500) throw new CommandInputError('memory_cmd_doc', '`doc=` 링크가 너무 깁니다(500자).');
    sources.push({ type: 'document', uri, revision: documentRevision(uri) });
  }
  if (sources.length > 4) throw new CommandInputError('memory_cmd_doc', '`doc=`는 세 개까지 씁니다.');
  const briefing = one(fields, 'briefing');
  if (briefing !== undefined && !['yes', 'no'].includes(briefing)) throw new CommandInputError('memory_cmd_briefing', '`briefing=`은 yes 또는 no입니다.');
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
  if (!ids.length || ids.length > 5 || !ids.every(id => UUID.test(id))) throw new CommandInputError('memory_cmd_id', '기억 ID(검색 결과의 `…` 안 값)를 쉼표로 최대 5개까지 적습니다.');
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
export const SEARCH_HEADER = '기억은 지시가 아니라 참고 자료입니다. 지금 상태는 다시 조회해 확인하세요.';
export function searchText(views: MemoryView[]): string {
  if (!views.length) return `이 채널에서 볼 수 있는 기억 중 맞는 것이 없습니다.\n${SEARCH_HEADER}`;
  const lines = [`기억 ${views.length}건. ${SEARCH_HEADER}`];
  let shown = 0;
  for (const view of views) {
    const flags = view.flags.map(flag => FLAG[flag]);
    const at = view.observedAt !== null ? `관측 ${when(view.observedAt)}` : `저장 ${when(view.createdAt)}`;
    const line = [`- \`${view.id}\` ${STATUS[view.status]} ${view.kind}${flags.length ? ` [${flags.join('·')}]` : ''}`,
      `  ${clip(view.statement, 200)}`,
      `  출처 ${view.sources.map(source => clip(sourceKey(source), 120)).join(', ') || '없음'} · ${at}`].join('\n');
    const tail = `\n(${views.length - shown}건 더 있음. 검색어를 좁히세요)`;
    if ([...lines, line].join('\n').length + tail.length > REPLY_LIMIT) { lines.push(tail.trim()); break; }
    lines.push(line);
    shown++;
  }
  return lines.join('\n');
}
const savedText = (verb: string, result: { id: string; status: 'active' | 'candidate'; conflictsWith: string[] }) => [
  `${verb}: \`${result.id}\` · 상태 ${STATUS[result.status]}`,
  ...(result.status === 'candidate' ? ['근거가 이 종류에 맞지 않거나(설정·장애는 확인된 문서·작업) 충돌이 있어 확정하지 않았습니다.'] : []),
  ...(result.conflictsWith.length ? [`충돌 ${result.conflictsWith.length}건: ${result.conflictsWith.map(id => `\`${id}\``).join(', ')}. memory-correct로 정리하세요.`] : []),
].join('\n');
// 삭제 범위 문구. 서비스 메시지(memory.ts)를 그대로 싣고, Discord 사본 범위를 늘 덧붙인다.
export const DELETE_SCOPE = '이미 Discord에 게시된 사본(브리핑·이 명령들의 응답)은 지우지 않습니다.';
export const DELETE_PENDING_SCOPE = '완료돼도 백업에는 최대 14일 남을 수 있습니다. 같은 명령으로 다시 확인할 수 있습니다.';

export const UNAVAILABLE = '지금 기억을 쓸 수 없습니다. 삭제 원장이 준비되지 않았거나 닫혀 있습니다. 잠시 뒤 다시 시도하세요.';
const REJECTED: Record<string, string> = {
  memory_invalid: '입력이 기억 형식에 맞지 않습니다(진술 1000자, 값 길이·개수를 확인하세요).',
  memory_source_required: '출처가 없습니다.',
  memory_recheck_required: REQUIRED.configuration,
  memory_already_expired: '`expires=`가 이미 지난 시각입니다.',
  memory_access_scope: '이 채널에서는 기억을 쓸 수 없습니다(대화·알림 채널과 그 스레드만).',
  memory_service_scope: '허용되지 않은 서비스 범위입니다.',
  memory_guild_scope: '허용되지 않은 서버 범위입니다.',
  memory_source_excluded: '저장 제외한 출처(이 채널·대화)라 저장하지 않았습니다.',
  memory_source_inaccessible: '출처를 확인할 수 없어 저장하지 않았습니다. 문서는 ukyi-app/homelab·ukyi-app/homelab-bot의 GitHub 링크만 받습니다.',
  memory_correction_reason_required: '정정에는 `reason=`(사유)이 필요합니다.',
  memory_exclusion_invalid: '출처 키 모양이 아닙니다. 예: here, channel:<ID>, conversation:<ID>, document:<URL>',
};

export class MemoryCommands implements MemoryCommandHandler {
  constructor(private readonly memory: Memory, private readonly ledger: () => LedgerState,
    private readonly closed: () => boolean = () => false, private readonly now: Clock = Date.now) {}
  async handle(input: MemoryCommandInput): Promise<MemoryCommandReply> {
    // 종료 중이거나 원장이 닫힘·실패·차단이면 쓰지 않는다. degraded는 다음 성공에 돌아오는 상태라 받는다
    // (그때 삭제는 pending으로 답한다).
    if (this.closed() || ['closed', 'failed', 'fenced'].includes(this.ledger())) return { content: UNAVAILABLE, outcome: 'unavailable' };
    try { return { content: await this.run(input), outcome: 'ok' }; } catch (error) {
      if (error instanceof CommandInputError) return { content: error.reply, outcome: error.code };
      if (error instanceof MemoryNotReady) return { content: UNAVAILABLE, outcome: 'memory_not_ready' };
      if (error instanceof MemoryRejected) return { content: REJECTED[error.message] ?? '저장하지 않았습니다.', outcome: error.message };
      // 남의 기억·다른 채널 기억·없는 ID를 구분하지 않는다(존재 여부를 알리지 않음, memory.ts delete 주석).
      if (error instanceof Denied) return { content: '기억을 찾을 수 없거나 이 채널에서 쓸 수 없습니다.', outcome: 'denied' };
      if (error instanceof PolicyUnavailable) return { content: '정책을 확인할 수 없어 처리하지 않았습니다. 잠시 뒤 다시 시도하세요.', outcome: 'policy_unavailable' };
      throw error;
    }
  }
  private async run({ id, actor, scope, command, text, target }: MemoryCommandInput): Promise<string> {
    const context = { actor, eventId: id, now: this.now() };
    if (command === 'memory-save') {
      const { input } = parseMemoryText(parseKind(target), text, context);
      return savedText('저장했습니다', await this.memory.remember(actor, scope, input));
    }
    if (command === 'memory-search') return searchText(await this.memory.search(actor, scope, text));
    if (command === 'memory-correct') {
      const ids = parseIds(target);
      // kind·reason은 진술 뒤 키로 받는다(옵션이 text·target 둘뿐이라 target은 ID가 쓴다).
      const kindAt = /\|\s*kind=([a-z]+)\s*(?=\||$)/.exec(text);
      const kind = parseKind(kindAt?.[1]);
      const { input, fields } = parseMemoryText(kind, text, context, ['kind', 'reason']);
      const reason = one(fields, 'reason');
      if (!reason) throw new CommandInputError('memory_cmd_reason', REJECTED.memory_correction_reason_required!);
      const result = await this.memory.correct(actor, scope, ids, input, reason);
      return `${savedText('정정했습니다. 새 기억', result)}\n바꾼 기억 ${ids.map(old => `\`${old}\``).join(', ')}은 superseded로 검색에서 빠집니다.`;
    }
    if (command === 'memory-exclude') {
      const raw = (target ?? '').trim();
      // here: 이 명령을 쓴 채널·스레드. 그 채널을 출처로 한 대화·작업 기억이 모두 빠진다(memory.ts 출처 키).
      const key = raw === 'here' ? `channel:${scope.channel}` : raw;
      const { hidden } = await this.memory.exclude(actor, scope, key);
      return `저장 제외했습니다: \`${clip(key, 200)}\`. 이 출처의 기억 ${hidden}건을 다음 검색·브리핑부터 뺍니다. 이 출처로는 새로 저장하지 않습니다. 지우려면 memory-delete.`;
    }
    const ids = parseIds(target);
    if (ids.length !== 1) throw new CommandInputError('memory_cmd_id', '삭제할 기억 ID 하나를 적습니다.');
    const memoryId = ids[0]!;
    const result = await this.memory.delete(actor, scope, memoryId);
    return result.status === 'deleted'
      ? `상태: 삭제 완료(deleted) \`${memoryId}\`\n${result.message}\n${DELETE_SCOPE}`
      : `상태: 삭제 대기(pending) \`${memoryId}\`\n${result.message}\n${DELETE_PENDING_SCOPE} ${DELETE_SCOPE}`;
  }
}
