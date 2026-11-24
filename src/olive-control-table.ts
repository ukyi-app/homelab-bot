// v2의 동작 표: 스물넷 모두의 방향·분류·접수·정책·세대·답 관계와 본문·확정 결과의 해석기.
import { chunkAnswersFetch, parseCandidateChunk, parseCandidateFetch } from './olive-control-candidates.js';
import { parseHandshake, parseHandshakeReply, parseJobLookup, parseJobStatus, sameJob } from './olive-control-common.js';
import { GENERATION_RULES } from './olive-control-generations.js';
import type { GenerationRule, GenerationRules } from './olive-control-generations.js';
import {
  eventResult, inputCancelResult, inputSubmitResult, parseApprovalChanged, parseInputCancel, parseInputSubmit, parseMergeObserved,
  parsePublicationChanged, parseSourceForgotten,
} from './olive-control-inputs.js';
import {
  cardResult, parseApprovalCardRequest, parseExecutionGenerationLookup, parseExecutionGenerationReply, parseProgressUpdate,
  parsePublicationCandidate, parseReplyCandidate, progressResult, publicationResult, replyResult,
} from './olive-control-outputs.js';
import { ACTION_NAME } from './olive-control-schema.js';
import type { Parser } from './olive-control-schema.js';
import {
  parseReleaseCommit, parseStopRecord, parseStopRecordLookup, parseStopStep, releaseCommitResult, releasePrepareResult,
  stopCommitResult, stopPrepareResult,
} from './olive-control-stop.js';

export const PARTIES = ['front-door', 'supervisor'] as const;
export type Party = (typeof PARTIES)[number];
export type ActionClass = 'handshake' | 'query' | 'effect';
export type Bundle = 'common' | 'stop' | 'input' | 'output' | 'candidate';

export interface EffectView {
  readonly from: readonly Party[];
  readonly parseResult: Parser<unknown>;
}

// 본문 해석기가 받는 문맥. job_lookup·job_status가 가리키는 효과 동작의 방향과 결과 꼴을 표에서 찾는다.
export interface ParseContext {
  readonly sender: Party;
  readonly recipient: Party;
  effect(action: string): EffectView | undefined;
}

export type BodyParser = (body: unknown, pc: ParseContext) => unknown;

// 기다리는 요청(이 연결에서 실어 보낸 것)과 해석을 지난 답 본문이 같은 것을 가리키는가. 어긋나면 reply_mismatch다.
export type ReplyMatch = (awaited: { readonly job: unknown; readonly body?: unknown }, reply: Readonly<Record<string, unknown>>) =>
  boolean;

export interface ActionSpec {
  readonly name: string;
  readonly bundle: Bundle;
  readonly class: ActionClass;
  readonly from: readonly Party[];
  readonly duringClosedIntake: boolean;
  // 인사는 상태가 none인 연결에서만 받으므로 이 값을 쓰지 않는다(false로 둔다).
  readonly duringPolicyMismatch: boolean;
  readonly generations: GenerationRules | null;
  // 답 동작이 가리킬 수 있는 요청 동작. 답이 아니면 null.
  readonly answers: readonly string[] | null;
  // 답이 기다리는 요청의 작업이나 본문을 되풀이해야 하는 동작(job_status, candidate_chunk)의 대조. 그 밖은 null.
  readonly matches: ReplyMatch | null;
  readonly parse: BodyParser;
  // 효과의 확정 결과(job_status의 confirmed.result) 해석기.
  readonly parseResult: Parser<unknown> | null;
}

// 정책이 어긋난 연결에서도 받는 효과의 닫힌 목록. 관리자 결정(2026-11-19): 멈추는 쪽은 늘 열어 둔다. 효과의 duringPolicyMismatch는
// 이 목록에서만 나온다. 넓히면 정책이 맞지 않는 현관이 실행을 다시 열 수 있다(풀기는 넣지 않는다).
export const EFFECTS_DURING_POLICY_MISMATCH: readonly string[] = Object.freeze(['stop_prepare', 'stop_commit']);
// 두 세대를 모두 싣지 않는 효과의 닫힌 목록. 관리자 결정(2026-11-20): 감독이 세대를 모르는 복원 1단계와 정지 중에도 받아야 하는
// 취소와 바깥에서 이미 일어난 사실이다.
export const EFFECTS_WITHOUT_GENERATIONS: readonly string[] = Object.freeze([
  'input_cancel', 'publication_changed', 'merge_observed', 'source_forgotten',
]);

const FD = ['front-door'] as const;
const SV = ['supervisor'] as const;
const BOTH = ['front-door', 'supervisor'] as const;
// job_status는 모든 효과(바로 답)와 job_lookup(조회의 답)에 답한다. 표를 만들 때 효과 이름으로 푼다.
const ALL_JOBS = 'all_jobs';

interface Row extends Omit<ActionSpec, 'answers'> {
  readonly answers: readonly string[] | typeof ALL_JOBS | null;
}

const handshake = (name: string, from: readonly Party[], answers: readonly string[] | null, parse: BodyParser): Row => ({
  name, bundle: 'common', class: 'handshake', from, duringClosedIntake: true, duringPolicyMismatch: false, generations: null, answers,
  matches: null, parse, parseResult: null,
});

const query = (name: string, bundle: Bundle, from: readonly Party[], duringPolicyMismatch: boolean,
  answers: readonly string[] | typeof ALL_JOBS | null, parse: BodyParser, matches: ReplyMatch | null = null): Row => ({
  name, bundle, class: 'query', from, duringClosedIntake: true, duringPolicyMismatch, generations: null, answers, matches, parse,
  parseResult: null,
});

const effect = (name: string, bundle: Bundle, from: readonly Party[], duringClosedIntake: boolean,
  [stop, execution]: readonly [GenerationRule, GenerationRule], parse: BodyParser, parseResult: Parser<unknown>): Row => ({
  name, bundle, class: 'effect', from, duringClosedIntake, duringPolicyMismatch: EFFECTS_DURING_POLICY_MISMATCH.includes(name),
  generations: { stop, execution }, answers: null, matches: null, parse, parseResult,
});

const fetchMatch: ReplyMatch = (awaited, reply) => chunkAnswersFetch(awaited.body, reply);
const jobMatch: ReplyMatch = (awaited, reply) => sameJob(awaited.job, reply);

const NA = 'not_applicable';

const ROWS: readonly Row[] = [
  handshake('handshake', FD, null, parseHandshake),
  handshake('handshake_reply', SV, ['handshake'], parseHandshakeReply),
  query('job_lookup', 'common', BOTH, true, null, parseJobLookup),
  query('job_status', 'common', BOTH, true, ALL_JOBS, parseJobStatus, jobMatch),
  query('stop_record_lookup', 'stop', SV, true, null, parseStopRecordLookup),
  query('stop_record', 'stop', FD, true, ['stop_record_lookup'], parseStopRecord),
  effect('stop_prepare', 'stop', FD, true, ['newer', NA], parseStopStep, stopPrepareResult),
  effect('stop_commit', 'stop', FD, true, ['prepared_newer', NA], parseStopStep, stopCommitResult),
  effect('release_prepare', 'stop', FD, true, ['current', NA], parseStopStep, releasePrepareResult),
  effect('release_commit', 'stop', FD, true, ['prepared_current', 'next'], parseReleaseCommit, releaseCommitResult),
  // 입력은 새 일이라 닫힌 접수에서 받지 않는다. 취소와 사실 넷은 정지 중에도 받는다. 승인 변화는 한 정지 세대 안의 사실이다.
  effect('input_submit', 'input', FD, false, ['current', NA], parseInputSubmit, inputSubmitResult),
  effect('input_cancel', 'input', FD, true, [NA, NA], parseInputCancel, inputCancelResult),
  effect('approval_changed', 'input', FD, true, ['current', NA], parseApprovalChanged, eventResult),
  effect('publication_changed', 'input', FD, true, [NA, NA], parsePublicationChanged, eventResult),
  effect('merge_observed', 'input', FD, true, [NA, NA], parseMergeObserved, eventResult),
  effect('source_forgotten', 'input', FD, true, [NA, NA], parseSourceForgotten, eventResult),
  // 감독의 출력 후보는 현관의 지금 정지·실행 세대에서만 받는다: 정지를 건너온 후보와 풀기 전 실행의 늦은 후보를 닫는다.
  effect('reply_candidate', 'output', SV, false, ['current', 'current'], parseReplyCandidate, replyResult),
  effect('approval_card_request', 'output', SV, false, ['current', 'current'], parseApprovalCardRequest, cardResult),
  effect('publication_candidate', 'output', SV, false, ['current', 'current'], parsePublicationCandidate, publicationResult),
  effect('progress_update', 'output', SV, false, ['current', 'current'], parseProgressUpdate, progressResult),
  query('execution_generation_lookup', 'output', FD, true, null, parseExecutionGenerationLookup),
  query('execution_generation_reply', 'output', SV, true, ['execution_generation_lookup'], parseExecutionGenerationReply),
  // 후보의 내용은 계약 판이 뜻을 고정한 사실이 아니라 정책이 어긋난 연결에서 받지 않는 조회다.
  query('candidate_fetch', 'candidate', FD, false, null, parseCandidateFetch),
  query('candidate_chunk', 'candidate', SV, false, ['candidate_fetch'], parseCandidateChunk, fetchMatch),
];

// 표의 모양을 만들 때 한 번 확인한다. 어긋나면 모듈을 읽는 순간 던진다. 행과 그 안의 배열·세대 객체는 복사해 동결한다.
function defineTable(rows: readonly Row[]): Map<string, ActionSpec> {
  const effects = rows.filter((row) => row.class === 'effect').map((row) => row.name);
  const table = new Map<string, ActionSpec>();
  for (const row of rows) {
    const fail = (why: string): never => {
      throw new Error(`olive-control table: ${row.name}: ${why}`);
    };
    if (!ACTION_NAME.test(row.name)) fail('name');
    if (table.has(row.name)) fail('duplicate');
    if (row.from.length === 0) fail('no sender');
    if (row.class === 'effect') {
      if (row.generations === null) fail('effect without generation rules');
      const { stop, execution } = row.generations!;
      if (!GENERATION_RULES.includes(stop) || !GENERATION_RULES.includes(execution)) fail('unknown generation rule');
      const none = stop === NA && execution === NA;
      if (none !== EFFECTS_WITHOUT_GENERATIONS.includes(row.name)) fail('generation-free list');
      if (row.answers !== null) fail('effect with answers');
      if (row.parseResult === null) fail('effect without result parser');
    } else {
      if (!row.duringClosedIntake) fail('handshake or query closed by intake');
      if (row.generations !== null) fail('generation rules outside effects');
      if (row.parseResult !== null) fail('result parser outside effects');
    }
    if (row.matches !== null && row.answers === null) fail('reply match outside answers');
    const answers = row.answers === ALL_JOBS ? [...effects, 'job_lookup'] : row.answers;
    table.set(row.name, Object.freeze({
      ...row,
      from: Object.freeze([...row.from]),
      generations: row.generations === null ? null : Object.freeze({ ...row.generations }),
      answers: answers === null ? null : Object.freeze([...answers]),
    }));
  }
  for (const name of [...EFFECTS_DURING_POLICY_MISMATCH, ...EFFECTS_WITHOUT_GENERATIONS]) {
    if (table.get(name)?.class !== 'effect') throw new Error(`olive-control table: ${name}: closed list names a non-effect`);
  }
  return table;
}

// 검증이 보는 표는 이 모듈 안의 Map 하나다. 밖에는 조회만 하는 동결한 객체를 준다: ReadonlyMap 타입은 빌드한 JS에서 사라지고,
// Object.freeze(map)은 Map 항목의 set·delete를 막지 못한다.
const TABLE = defineTable(ROWS);

export const specOf = (name: string): ActionSpec | undefined => TABLE.get(name);

export const ACTIONS: ReadonlyMap<string, ActionSpec> = Object.freeze({
  get size() {
    return TABLE.size;
  },
  get: (name: string) => TABLE.get(name),
  has: (name: string) => TABLE.has(name),
  keys: () => TABLE.keys(),
  values: () => TABLE.values(),
  entries: () => TABLE.entries(),
  forEach(callback: (spec: ActionSpec, name: string, map: ReadonlyMap<string, ActionSpec>) => void, thisArg?: unknown) {
    TABLE.forEach((spec, name) => callback.call(thisArg, spec, name, ACTIONS));
  },
  [Symbol.iterator]: () => TABLE.entries(),
});
