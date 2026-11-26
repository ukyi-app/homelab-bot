import { createHash } from 'node:crypto';

// 내부 식별자(작업·연결 UUID)의 공개 별칭. 되돌릴 수 없는 SHA-256 앞 8자리이고 같은 ID는 늘 같은 별칭이다.
// 함정: 원래 값이 추측하기 쉬우면 별칭에서 되찾을 수 있다. 무작위 UUID에만 쓴다(사람이 지은 세션 ID에는 쓰지 않는다).
// node:crypto만 import한다. 제어 결과 문구(control-format.ts)가 쓰는데, 공개 검사 쪽을 import하면 change-* 모듈과 순환 import가 생긴다.
export function publicAlias(id: string): string {
  return createHash('sha256').update(`homelab-bot/public-alias\n${id}`, 'utf8').digest('hex').slice(0, 8);
}
