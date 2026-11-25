// 효과 동작의 세대 규칙. 세대 값은 머리가 아니라 본문 맨 위 칸(stop_generation, execution_generation)에 있어 body_digest로
// 서명에 묶인다. 받는 쪽은 칸(있고 없음과 꼴)을 먼저 보고, 그다음 권위 값과 대조한다. 둘 다 정지 → 실행 순서다.
import { isPlainObject } from './olive-control-schema.js';

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
