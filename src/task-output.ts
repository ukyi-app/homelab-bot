import { scanPublicText } from './change-publication.js';
import type { Policy } from './policy.js';
import { ReviewPolicySchema } from './review.js';

// 작업 레인에서 모델이 쓴 글(질문·완료 요약)이 Discord로 나가기 전의 공개 검사. 기준은 CHANGE 질문과 같은 scanPublicText다.
// 탐지기는 완전성 증거가 아니다. 잡는 형태는 change-publication.ts의 패턴이 정한다.

export type TaskOutputRisk = 'secret_detected' | 'internal_marker' | 'metadata_sensitive' | 'policy_unavailable';

// 작업 레인 정책에는 내부 표식 칸이 없다. 운영자가 이미 적어 둔 CHANGE 저장소별 표식과 리뷰 표식을 모두 합쳐 쓴다.
// 표식은 저장소와 무관하게 밖에 보이면 안 되는 문자열이라, 프로젝트와 같은 저장소의 것만 고르면 빠지는 값이 생긴다.
// 리뷰 정책이 있는데 읽을 수 없으면 그 표식을 모르는 것이라 공개 여부를 말할 수 없다(null).
export function taskOutputMarkers(policy: Policy): string[] | null {
  const change = policy.change?.repositories.flatMap(repository => repository.internalMarkers) ?? [];
  if (policy.review === undefined) return change;
  const review = ReviewPolicySchema.safeParse(policy.review);
  return review.success ? [...change, ...review.data.internalMarkers] : null;
}

// 신원 칸은 공개 메타데이터로 함께 검사되므로 어떤 패턴에도 걸리지 않는 고정값을 둔다.
const IDENTITY = { name: 'homelab-bot', email: 'homelab-bot@users.noreply.github.com' };

// 걸린 사유 코드만 돌려주고 값은 돌려주지 않는다. 정책을 못 읽었으면 닫는다.
export function taskOutputRisk(text: string, policy: Policy | undefined): TaskOutputRisk | null {
  const markers = policy ? taskOutputMarkers(policy) : null;
  if (!markers) return 'policy_unavailable';
  return scanPublicText({ title: text, body: text }, { internalMarkers: markers, identity: IDENTITY });
}
