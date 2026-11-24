// v2의 동작 표: 스물넷 모두의 방향·분류·접수·정책·세대·답 관계를 안다. 본문 해석기는 공통부와 정지 묶음만 있고, 나머지 묶음
// (입력·이벤트, 출력, 후보 내용)은 parse가 null이다. 그 동작의 봉투는 공통 검사를 모두 거친 뒤 해석 단계에서 받아들이지 않는다.
import { parseHandshake, parseHandshakeReply, parseJobLookup, parseJobStatus } from './olive-control-common.js';
import { GENERATION_RULES } from './olive-control-generations.js';
import type { GenerationRule, GenerationRules } from './olive-control-generations.js';
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
  readonly parseResult: Parser<unknown> | null;
}

// 본문 해석기가 받는 문맥. job_lookup·job_status가 가리키는 효과 동작의 방향과 결과 꼴을 표에서 찾는다.
export interface ParseContext {
  readonly sender: Party;
  readonly recipient: Party;
  effect(action: string): EffectView | undefined;
}

export type BodyParser = (body: unknown, pc: ParseContext) => unknown;

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
  readonly parse: BodyParser | null;
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
  parse, parseResult: null,
});

const query = (name: string, bundle: Bundle, from: readonly Party[], duringPolicyMismatch: boolean,
  answers: readonly string[] | typeof ALL_JOBS | null, parse: BodyParser | null): Row => ({
  name, bundle, class: 'query', from, duringClosedIntake: true, duringPolicyMismatch, generations: null, answers, parse,
  parseResult: null,
});

const effect = (name: string, bundle: Bundle, from: readonly Party[], duringClosedIntake: boolean,
  [stop, execution]: readonly [GenerationRule, GenerationRule], parse: BodyParser | null,
  parseResult: Parser<unknown> | null): Row => ({
  name, bundle, class: 'effect', from, duringClosedIntake, duringPolicyMismatch: EFFECTS_DURING_POLICY_MISMATCH.includes(name),
  generations: { stop, execution }, answers: null, parse, parseResult,
});

const NA = 'not_applicable';

const ROWS: readonly Row[] = [
  handshake('handshake', FD, null, parseHandshake),
  handshake('handshake_reply', SV, ['handshake'], parseHandshakeReply),
  query('job_lookup', 'common', BOTH, true, null, parseJobLookup),
  query('job_status', 'common', BOTH, true, ALL_JOBS, parseJobStatus),
  query('stop_record_lookup', 'stop', SV, true, null, parseStopRecordLookup),
  query('stop_record', 'stop', FD, true, ['stop_record_lookup'], parseStopRecord),
  effect('stop_prepare', 'stop', FD, true, ['newer', NA], parseStopStep, stopPrepareResult),
  effect('stop_commit', 'stop', FD, true, ['prepared_newer', NA], parseStopStep, stopCommitResult),
  effect('release_prepare', 'stop', FD, true, ['current', NA], parseStopStep, releasePrepareResult),
  effect('release_commit', 'stop', FD, true, ['prepared_current', 'next'], parseReleaseCommit, releaseCommitResult),
  effect('input_submit', 'input', FD, false, ['current', NA], null, null),
  effect('input_cancel', 'input', FD, true, [NA, NA], null, null),
  effect('approval_changed', 'input', FD, true, ['current', NA], null, null),
  effect('publication_changed', 'input', FD, true, [NA, NA], null, null),
  effect('merge_observed', 'input', FD, true, [NA, NA], null, null),
  effect('source_forgotten', 'input', FD, true, [NA, NA], null, null),
  effect('reply_candidate', 'output', SV, false, ['current', 'current'], null, null),
  effect('approval_card_request', 'output', SV, false, ['current', 'current'], null, null),
  effect('publication_candidate', 'output', SV, false, ['current', 'current'], null, null),
  effect('progress_update', 'output', SV, false, ['current', 'current'], null, null),
  query('execution_generation_lookup', 'output', FD, true, null, null),
  query('execution_generation_reply', 'output', SV, true, ['execution_generation_lookup'], null),
  // 후보의 내용은 계약 판이 뜻을 고정한 사실이 아니라 정책이 어긋난 연결에서 받지 않는 조회다.
  query('candidate_fetch', 'candidate', FD, false, null, null),
  query('candidate_chunk', 'candidate', SV, false, ['candidate_fetch'], null),
];

// 표의 모양을 만들 때 한 번 확인한다. 어긋나면 모듈을 읽는 순간 던진다.
function defineTable(rows: readonly Row[]): ReadonlyMap<string, ActionSpec> {
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
      if (row.parse !== null && row.parseResult === null) fail('effect without result parser');
    } else {
      if (!row.duringClosedIntake) fail('handshake or query closed by intake');
      if (row.generations !== null) fail('generation rules outside effects');
      if (row.parseResult !== null) fail('result parser outside effects');
    }
    const answers = row.answers === ALL_JOBS ? Object.freeze([...effects, 'job_lookup']) : row.answers;
    table.set(row.name, Object.freeze({ ...row, answers }));
  }
  for (const name of [...EFFECTS_DURING_POLICY_MISMATCH, ...EFFECTS_WITHOUT_GENERATIONS]) {
    if (table.get(name)?.class !== 'effect') throw new Error(`olive-control table: ${name}: closed list names a non-effect`);
  }
  return table;
}

export const ACTIONS: ReadonlyMap<string, ActionSpec> = defineTable(ROWS);
