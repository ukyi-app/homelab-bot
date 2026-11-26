// 본문·머리의 엄격한 해석 도구. 객체는 닫혀 있고 선택 칸이 없다(없을 수 있는 값은 null로 싣는다).
// 한 층에서는 모르는 칸(unknown)을 먼저 보고, 그다음 선언 순서대로 칸마다 없음·꼴(malformed)을 본다. 그래서 모르는 칸과 틀린 칸이
// 함께 있는 객체는 unknown_field다.

export type SchemaFault = 'malformed' | 'unknown';

export class SchemaError extends Error {
  constructor(readonly fault: SchemaFault, readonly path: string) {
    super(`${fault} at ${path}`);
  }
}

export type Parser<T> = (value: unknown, path: string) => T;

export const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
export const SHA256_HEX = /^[0-9a-f]{64}$/;
export const NONCE = /^[0-9a-f]{32}$/;
export const ACTION_NAME = /^[a-z_]{1,40}$/;
// 정책 revision의 꼴. v2 문서에 꼴이 적혀 있지 않아 감독 구현과 같은 값을 쓴다(빈 글은 거절).
export const REVISION = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
// 원문 참조: 원문 저장소가 발행한 `<저장소 이름>/<UUID>`. v2 문서는 저장소 이름의 꼴을 적지 않아 감독 장부와 같은 값을 쓴다.
// 글(공백, 한글, 대문자)은 이 꼴이 될 수 없어 원문이 참조 자리로 새지 않는다.
export const SOURCE_REF = /^[a-z][a-z0-9-]{0,31}\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

// 묻는 쪽이 한 번의 물음에서 답을 받지 못한 까닭. 셋 모두 "없다"가 아니라 "모른다"다.
export const NO_ANSWER_CAUSES = ['timeout', 'disconnected', 'reply_rejected'] as const;
export type NoAnswerCause = (typeof NO_ANSWER_CAUSES)[number];

const malformed = (path: string): never => {
  throw new SchemaError('malformed', path);
};

export function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const proto: unknown = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

export function pattern(re: RegExp): Parser<string> {
  return (value, path) => (typeof value === 'string' && re.test(value) ? value : malformed(path));
}

export const uuid = pattern(UUID);
export const sha256 = pattern(SHA256_HEX);
export const revision = pattern(REVISION);
export const sourceRef = pattern(SOURCE_REF);

// 정수 칸. -0은 정규화가 0으로 쓰므로(서명이 0에 묶임) 0으로 받는다.
export function int(min: number, max = Number.MAX_SAFE_INTEGER): Parser<number> {
  return (value, path) => {
    if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < min || value > max) return malformed(path);
    return value === 0 ? 0 : value;
  };
}

export function nullable<T>(parser: Parser<T>): Parser<T | null> {
  return (value, path) => (value === null ? null : parser(value, path));
}

export const bool: Parser<boolean> = (value, path) => (typeof value === 'boolean' ? value : malformed(path));

export function literal<const T extends string>(expected: T): Parser<T> {
  return (value, path) => (value === expected ? expected : malformed(path));
}

export function oneOf<const T extends string>(values: readonly T[]): Parser<T> {
  return (value, path) => (typeof value === 'string' && (values as readonly string[]).includes(value) ? value as T : malformed(path));
}

// 꼴 검사 없이 값을 그대로 넘긴다. 칸이 있는지만 object가 본다(그 값은 뒤에서 따로 해석한다).
export const present: Parser<unknown> = (value) => value;

type Shape = Record<string, Parser<unknown>>;
export type Parsed<S extends Shape> = { [K in keyof S]: S[K] extends Parser<infer T> ? T : never };

export function object<S extends Shape>(shape: S): Parser<Parsed<S>> {
  return (value, path) => {
    if (!isPlainObject(value)) return malformed(path);
    for (const key of Object.keys(value)) {
      if (!Object.hasOwn(shape, key)) throw new SchemaError('unknown', `${path}.${key}`);
    }
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(shape)) {
      if (!Object.hasOwn(value, key)) return malformed(`${path}.${key}`);
      out[key] = shape[key]!(value[key], `${path}.${key}`);
    }
    return out as Parsed<S>;
  };
}

// 갈래 칸(state, outcome)의 값으로 닫힌 꼴 하나를 고른다. 목록 밖의 값은 malformed다.
export function byTag<T>(tag: string, cases: Readonly<Record<string, Parser<T>>>): Parser<T> {
  return (value, path) => {
    if (!isPlainObject(value)) return malformed(path);
    const chosen = value[tag];
    if (typeof chosen !== 'string' || !Object.hasOwn(cases, chosen)) return malformed(`${path}.${tag}`);
    return cases[chosen]!(value, path);
  };
}

// 칸이 outcome 하나뿐인 갈래 여럿의 확정 결과. 갈래가 여럿이면 outcome 값을 먼저 고른다(목록 밖이면 malformed). 갈래가 하나인 결과는
// 이것이 아니라 object({ outcome: literal(...) })로 둔다: 모르는 칸을 outcome 값보다 먼저 본다.
export function byOutcome<T extends { outcome: string }>(names: readonly T['outcome'][]): Parser<T> {
  const cases: Record<string, Parser<T>> = {};
  for (const name of names) cases[name] = object({ outcome: literal(name) }) as Parser<unknown> as Parser<T>;
  return byTag<T>('outcome', cases);
}
