// 본문의 어느 깊이에서든 오면 forbidden_field인 칸 이름. 이름은 소문자로 바꾸고 -·_·공백(JS 정규식 \s)을 지운 뒤 대조한다.
// 엄격한 해석기가 어차피 모르는 칸을 거절하지만, 이 이름은 해석 전에 따로 찾아 다른 사유로 거절한다.
import type { Party } from './olive-control-table.js';

// 둘 다 막는 것. 앞 묶음은 실행기 계약(v1)의 금지 이름(명령·이미지·볼륨·argv·환경·로그·사고 과정)이다. v2 문서는 이 묶음을
// 분류로만 적어 이름은 v1 구현의 목록과 같게 둔다.
export const COMMON_FORBIDDEN_FIELD_NAMES = Object.freeze([
  'command', 'commands', 'cmd', 'entrypoint', 'shell', 'exec',
  'image', 'images', 'imageref',
  'volume', 'volumes', 'mount', 'mounts', 'hostpath',
  'argv', 'args', 'arguments',
  'env', 'envs', 'environment', 'envvars',
  'log', 'logs', 'rawlog', 'stdout', 'stderr',
  'transcript', 'thinking', 'reasoning',
  // 비밀
  'token', 'secret', 'password', 'apikey', 'privatekey', 'credential', 'credentials',
  // 원문(Discord 글의 본문)은 참조와 digest로만 오간다.
  'rawmessage', 'messagecontent', 'originaltext', 'rawtext',
] as const);

// 감독이 낸 본문만 막는 것: 승인·최종 목적지·권한의 주장. 모델이 만든 후보가 실릴 수 있는 쪽이다. 승인 변화는 현관이 알리는
// 사실이라 현관이 낸 본문에는 막지 않는다.
export const SUPERVISOR_FORBIDDEN_FIELD_NAMES = Object.freeze([
  'approved', 'approval', 'approvals', 'approvedby', 'approver',
  'authorized', 'authorization', 'permission', 'permissions',
  'destination', 'destinations', 'channelid', 'webhook', 'webhookurl',
] as const);

const COMMON = new Set<string>(COMMON_FORBIDDEN_FIELD_NAMES);
const SUPERVISOR = new Set<string>([...COMMON_FORBIDDEN_FIELD_NAMES, ...SUPERVISOR_FORBIDDEN_FIELD_NAMES]);

export const normalizeFieldName = (name: string): string => name.toLowerCase().replace(/[-_\s]/g, '');

// 정규화를 통과한 값(깊이 16 이하)에만 부른다. 배열 안의 객체도 본다.
export function findForbidden(value: unknown, sender: Party, path = 'body'): string | undefined {
  return walk(value, sender === 'supervisor' ? SUPERVISOR : COMMON, path);
}

function walk(value: unknown, names: ReadonlySet<string>, path: string): string | undefined {
  if (typeof value !== 'object' || value === null) return undefined;
  if (Array.isArray(value)) {
    for (let i = 0; i < value.length; i++) {
      const hit = walk(value[i], names, `${path}[${i}]`);
      if (hit !== undefined) return hit;
    }
    return undefined;
  }
  for (const [key, inner] of Object.entries(value)) {
    if (names.has(normalizeFieldName(key))) return `${path}.${key}`;
    const hit = walk(inner, names, `${path}.${key}`);
    if (hit !== undefined) return hit;
  }
  return undefined;
}
