import { z } from 'zod';
import { scanPublicText } from './change-publication.js';
import { PolicyUnavailable } from './contracts.js';
import type { PublicScan } from './outbound.js';
import type { Policy } from './policy.js';

// Discord로 나가는 글의 공개 검사(F-2~F-6). 판정은 scanPublicText(change-publication.ts)이고 내부 표식은 지금 정책에서 읽는다.
// 저장할 때 붙인 라벨(safe_summary)이나 작성할 때의 정책은 통과 근거가 아니다.
// 탐지기는 완전성 증거가 아니다. 뜻을 바꿔 쓴 누출은 잡지 못한다.

export type MarkerPolicy = Pick<Policy, 'change' | 'review'>;
// 걸린 글 대신 싣는 자리 표시. 걸린 글은 한 글자도 싣지 않고 사유 코드도 싣지 않는다.
export const PUBLIC_WITHHELD = '(밖에 보이면 안 되는 내용이 섞여 있어 싣지 않았어요)';
// 신원 칸도 공개 메타데이터로 함께 검사되므로 어떤 패턴에도 걸리지 않는 고정값을 둔다(task-output.ts와 같은 값).
const IDENTITY = { name: 'homelab-bot', email: 'homelab-bot@users.noreply.github.com' };

// 내부 표식은 CHANGE 저장소별 표식과 리뷰 표식을 합친 것이다(task-output.ts의 taskOutputMarkers와 같은 출처).
// 리뷰 정책에서는 표식 칸만 읽는다. review.ts를 import하면 control-format·store 쪽과 순환 import가 생긴다.
const ReviewMarkers = z.object({ internalMarkers: z.array(z.string().min(4).max(200)).max(100) });
function readMarkers(policy: MarkerPolicy): string[] | null {
  const change = policy.change?.repositories.flatMap(repository => repository.internalMarkers) ?? [];
  if (policy.review === undefined) return change;
  const review = ReviewMarkers.safeParse(policy.review);
  return review.success ? [...change, ...review.data.internalMarkers] : null;
}
// 리뷰 표식을 읽지 못하면 공개 여부를 말할 수 없다. 호출자는 미루고 다시 시도한다(통과시키지 않는다).
function markers(policy: MarkerPolicy): string[] {
  const found = readMarkers(policy);
  if (!found) throw new PolicyUnavailable();
  return found;
}
// 비밀 꼴과 내부 표식만 본다. scanPublicText는 비밀 → 표식 → 메타데이터 차례로 보므로 메타데이터 사유면 앞의 둘은 지난 것이다.
function common(text: string, internalMarkers: readonly string[]): 'secret_detected' | 'internal_marker' | null {
  const reason = scanPublicText({ title: text, body: text }, { internalMarkers, identity: IDENTITY });
  return reason === 'metadata_sensitive' ? null : reason;
}

// 사람·모델·바깥 도구가 쓴 글(기억 문장, 외부 세션 요약). 비밀·표식에 더해 이메일·사설 IP·홈 경로·긴 숫자 ID도 막는다(대화 답과 같은 기준).
export function freeTextRisk(text: string, policy: MarkerPolicy): string | null {
  return scanPublicText({ title: text, body: text }, { internalMarkers: markers(policy), identity: IDENTITY });
}
// 코드가 조립한 최종 글(브리핑 전체). 비밀 꼴과 내부 표식만 본다. 시각·건수 같은 코드의 줄이 메타데이터 꼴로 막히지 않게 한다.
export function assembledRisk(text: string, policy: MarkerPolicy): string | null {
  return common(text, markers(policy));
}
// 게시 직전 검사(발송 한 길 checkOutbound의 scan). 나갈 바이트를 다시 푼 모든 문자열을 하나씩 본다.
// 메타데이터 꼴은 보지 않는다: 본문의 구조 칸(답장 대상, 호출할 사용자)에 Discord ID(긴 숫자)가 늘 들어간다.
// 여러 쪽으로 나뉜 글은 쪽마다 따로 보이므로 쪽 경계에 걸친 값은 여기서 못 잡는다. 나누기 전 검사는 글을 만든 쪽이 한다.
// 표식은 읽을 수 있는 것만 쓴다. 리뷰 정책이 깨지면 리뷰 경로만 닫혀야 하는데(policy.ts) 여기서 닫으면 모든 Discord 글이 멈춘다.
// 표식을 모르면 닫는 검사는 글을 만든 쪽(대화 답, 브리핑, 외부 세션 요약)이 한다.
export function discordScan(policy: MarkerPolicy): PublicScan {
  const list = readMarkers(policy) ?? readMarkers({ change: policy.change }) ?? [];
  return texts => {
    for (const text of texts) {
      const reason = common(text, list);
      if (reason) return reason;
    }
    return null;
  };
}
