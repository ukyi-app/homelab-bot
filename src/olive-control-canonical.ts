// 서명과 digest가 보는 바이트는 이 직렬화 하나뿐이다. RFC 8785(JCS)의 부분집합이다.
// - 객체 키는 UTF-16 코드 단위 순서로 정렬한다(JCS와 같다). 코드 포인트 순서와는 BMP 밖 문자가 섞일 때 갈린다.
// - 공백이 없다. 문자열은 JCS 이스케이프만 쓴다: `"`, `\\`, U+0000~U+001F. 그중 \b \t \n \f \r는 짧은 꼴, 나머지는
//   \u00xx(소문자 16진)다. `/`, 비 ASCII, U+2028·U+2029는 그대로 쓴다.
// - 숫자는 해석한 값이 안전 정수(±(2^53-1))여야 하고 십진 정수로 쓴다. 소수·NaN·무한대는 구현마다 표기가 갈려 같은 뜻이 다른
//   바이트가 되므로 받지 않는다. 원문의 표기는 해석에서 사라지므로 원문 1e2는 100으로 쓴다. -0은 0으로 쓴다.
// - 짝 없는 서로게이트(값과 키 모두), 빈 칸이 있는 배열, 평범한 객체가 아닌 값, 깊이 16 초과(맨 위 값이 깊이 0)는 받지 않는다.
// 받는 쪽은 받은 바이트가 아니라 해석한 값에서 이 바이트를 다시 만든다. 그래서 같은 키가 두 번 든 JSON 글은 해석기마다 고르는 값이
// 달라질 수 있다: 그런 글은 바이트 틀이 해석 전에 거절해야 한다(이 모듈 밖).
import { createHash } from 'node:crypto';

export const MAX_DEPTH = 16;

export type CanonicalFault = 'too_deep' | 'not_safe_integer' | 'lone_surrogate' | 'sparse_array' | 'not_plain_object'
  | 'unsupported_type';

export class CanonicalError extends Error {
  constructor(readonly fault: CanonicalFault) {
    super(`canonical: ${fault}`);
  }
}

const SHORT_ESCAPES: Readonly<Record<number, string>> = {
  0x08: '\\b', 0x09: '\\t', 0x0a: '\\n', 0x0c: '\\f', 0x0d: '\\r', 0x22: '\\"', 0x5c: '\\\\',
};

function writeString(text: string): string {
  let out = '"';
  for (let i = 0; i < text.length; i++) {
    const unit = text.charCodeAt(i);
    if (unit >= 0xd800 && unit <= 0xdbff) {
      const low = i + 1 < text.length ? text.charCodeAt(i + 1) : -1;
      if (low < 0xdc00 || low > 0xdfff) throw new CanonicalError('lone_surrogate');
      out += text.slice(i, i + 2);
      i++;
      continue;
    }
    if (unit >= 0xdc00 && unit <= 0xdfff) throw new CanonicalError('lone_surrogate');
    const short = SHORT_ESCAPES[unit];
    if (short !== undefined) out += short;
    else if (unit < 0x20) out += '\\u' + unit.toString(16).padStart(4, '0');
    else out += text[i];
  }
  return out + '"';
}

// 문자열의 <, >는 UTF-16 코드 단위로 비교한다. localeCompare는 쓰지 않는다(지역 설정에 따라 순서가 바뀐다).
const byCodeUnits = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

function write(value: unknown, depth: number): string {
  if (depth > MAX_DEPTH) throw new CanonicalError('too_deep');
  if (value === null) return 'null';
  switch (typeof value) {
    case 'boolean':
      return value ? 'true' : 'false';
    case 'number':
      if (!Number.isSafeInteger(value)) throw new CanonicalError('not_safe_integer');
      return value === 0 ? '0' : String(value);
    case 'string':
      return writeString(value);
    case 'object': {
      if (Array.isArray(value)) {
        const parts: string[] = [];
        for (let i = 0; i < value.length; i++) {
          if (!Object.hasOwn(value, i)) throw new CanonicalError('sparse_array');
          parts.push(write(value[i], depth + 1));
        }
        return `[${parts.join(',')}]`;
      }
      const proto: unknown = Object.getPrototypeOf(value);
      if (proto !== Object.prototype && proto !== null) throw new CanonicalError('not_plain_object');
      const record = value as Record<string, unknown>;
      const keys = Object.keys(record).sort(byCodeUnits);
      return `{${keys.map((key) => `${writeString(key)}:${write(record[key], depth + 1)}`).join(',')}}`;
    }
    default:
      throw new CanonicalError('unsupported_type');
  }
}

export function canonicalJson(value: unknown): string {
  return write(value, 0);
}

// 본문 digest: 정규 직렬화의 UTF-8 바이트에 대한 SHA-256, 소문자 16진 64자.
export function digestOf(value: unknown): string {
  return createHash('sha256').update(canonicalJson(value), 'utf8').digest('hex');
}
