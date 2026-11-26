// 효과 동작의 세대 규칙. 세대 값은 머리가 아니라 본문 맨 위 칸(stop_generation, execution_generation)에 있어 body_digest로
// 서명에 묶인다. 받는 쪽은 칸(있고 없음과 꼴)을 먼저 보고, 그다음 권위 값과 대조한다. 둘 다 정지 → 실행 순서다.
import { isPlainObject } from './olive-control-schema.js';
import type { NoAnswerCause } from './olive-control-schema.js';

export const GENERATION_RULES = ['not_applicable', 'current', 'next', 'newer', 'prepared_newer', 'prepared_current'] as const;
export type GenerationRule = (typeof GENERATION_RULES)[number];
export interface GenerationRules {
  readonly stop: GenerationRule;
  readonly execution: GenerationRule;
}

// 받는 쪽의 권위 값. 모르면 known: false로 준다(지어내지 않는다).
// prepared: 받아 두고 아직 확정하지 않은 준비의 세대. 정지 준비와 풀기 준비가 이 칸 하나를 함께 쓴다: 정지 준비면 current보다 크고,
// 풀기 준비면 current와 같다. 확정 규칙은 그래서 번호만이 아니라 준비의 종류(큰가, 같은가)까지 본다.
export type GenerationAuthority = { known: false } | { known: true; current: number; prepared: number | null };
export interface Generations {
  readonly stop: GenerationAuthority;
  readonly execution: GenerationAuthority;
}

export const GENERATION_FIELDS = { stop: 'stop_generation', execution: 'execution_generation' } as const;
const KINDS = ['stop', 'execution'] as const;

// not_applicable인데 칸이 있으면 body_malformed다: 검사되지 않는 세대 값을 처리기에 넘기지 않는다.
export function generationFieldFault(rules: GenerationRules, body: unknown): 'generation_missing' | 'body_malformed' | null {
  if (!isPlainObject(body)) return 'body_malformed';
  for (const kind of KINDS) {
    const field = GENERATION_FIELDS[kind];
    const present = Object.hasOwn(body, field);
    if (rules[kind] === 'not_applicable') {
      if (present) return 'body_malformed';
      continue;
    }
    if (!present) return 'generation_missing';
    const value = body[field];
    if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) return 'body_malformed';
  }
  return null;
}

export function generationValueFault(rule: GenerationRule, value: number, authority: GenerationAuthority):
  'generation_unknown' | 'generation_mismatch' | null {
  if (rule === 'not_applicable') return null;
  if (!authority.known) return 'generation_unknown';
  const { current, prepared } = authority;
  let fits: boolean;
  switch (rule) {
    case 'current':
      fits = value === current;
      break;
    case 'next':
      fits = value === current + 1;
      break;
    case 'newer':
      // 건너뛴 세대는 받되, 더 높은 준비를 받아 둔 뒤 늦게 온 낮은 준비는 받지 않는다(받으면 준비 칸이 낮아져 높은 확정이 막힌다).
      fits = value > current && (prepared === null || value >= prepared);
      break;
    case 'prepared_newer':
      fits = prepared !== null && value === prepared && prepared > current;
      break;
    case 'prepared_current':
      fits = prepared !== null && value === prepared && prepared === current;
      break;
  }
  return fits ? null : 'generation_mismatch';
}

// 현관이 실행 세대의 권위 값을 얻는 두 길(풀기 확정 released의 execution_generation, execution_generation_reply)의 한 번의 결과.
export type ExecutionGenerationOutcome = { answered: true; generation: number } | { answered: false; cause: NoAnswerCause };

// 현관의 generations.execution을 감독이 알려 준 값으로 고친다. 두 길 모두 이 함수로만 넣어, 값이 어긋나면 큰 값이 남는다.
// - 실행 세대는 풀 때만 오른다. 아는 값보다 작은 답은 늦게 온 옛 답이거나 감독 장부의 되돌림이라 낮추지 않는다(regressed). 낮추면
//   옛 실행의 후보가 다시 통과한다.
// - 감독 장부의 실행 세대는 1에서 시작한다. 0, 음수, 정수가 아닌 값, 답 없음은 아는 값을 그대로 둔다. 모르던 값을 지어내지 않는다.
// - 현관은 실행 세대의 준비를 받지 않지만, 아는 값의 prepared는 이 함수가 바꿀 칸이 아니라 그대로 둔다.
export function adoptExecutionGeneration(previous: GenerationAuthority, outcome: ExecutionGenerationOutcome):
  { authority: GenerationAuthority; regressed: boolean } {
  const kept = { authority: previous, regressed: false };
  if (!isPlainObject(outcome) || outcome.answered !== true) return kept;
  const value: unknown = outcome.generation;
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 1) return kept;
  if (!previous.known) return { authority: { known: true, current: value, prepared: null }, regressed: false };
  if (value < previous.current) return { authority: previous, regressed: true };
  return { authority: { known: true, current: value, prepared: previous.prepared }, regressed: false };
}

// generationFieldFault를 지난 본문에만 부른다.
export function generationsFault(rules: GenerationRules, body: Readonly<Record<string, unknown>>, authority: Generations):
  'generation_unknown' | 'generation_mismatch' | null {
  for (const kind of KINDS) {
    if (rules[kind] === 'not_applicable') continue;
    const fault = generationValueFault(rules[kind], body[GENERATION_FIELDS[kind]] as number, authority[kind]);
    if (fault !== null) return fault;
  }
  return null;
}
