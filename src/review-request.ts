import type { Store } from './store.js';

// 말로 하는 PR 리뷰 요청(COLLEAGUE_SPEC §4.10, DECISIONS "동료 봇 전환" 18). 제안 동작 표(proposals.ts)와 리뷰 접수(review.ts
// ReviewRequests)가 함께 쓰는 값과 포트만 둔다. review.ts를 값으로 불러오지 않는다(proposals → review → runtime → proposals 순환).

// 리뷰 요청을 받는 GitHub 조직. 이 조직 밖 저장소는 GitHub에 묻지 않고 거절한다.
export const REVIEW_REQUEST_ORGANIZATION = 'ukyi-app';

export interface PullReference { owner: string; repo: string; number: number }
const NAME = '[A-Za-z0-9_.-]{1,100}';
const NUMBER = '[1-9][0-9]{0,9}';
// 링크(github.com/<소유자>/<저장소>/pull/<번호>)와 짧은 꼴(<소유자>/<저장소>#<번호>, 소유자를 빼면 조직 저장소)을 찾는다.
const LINK = new RegExp(String.raw`github\.com/(${NAME})/(${NAME})/pull/(${NUMBER})(?![0-9])`, 'gi');
const SHORT = new RegExp(String.raw`(?<![A-Za-z0-9_./#-])(?:(${NAME})/)?(${NAME})#(${NUMBER})(?![0-9])`, 'g');
// 경로 조립에서 위로 올라가지 않게 "."·".." 이름은 받지 않는다(review.ts REPO_NAME과 같은 규칙).
const named = (value: string) => value !== '.' && value !== '..';
function collect(text: string): PullReference[] {
  const found: PullReference[] = [];
  for (const match of text.matchAll(LINK)) found.push({ owner: match[1]!, repo: match[2]!, number: Number(match[3]) });
  for (const match of text.matchAll(SHORT)) found.push({ owner: match[1] ?? REVIEW_REQUEST_ORGANIZATION, repo: match[2]!, number: Number(match[3]) });
  return found.filter(ref => named(ref.owner) && named(ref.repo));
}
// owner 원문에 적힌 PR들. 링크와 짧은 꼴을 모두 본다.
export const pullReferences = (text: string): PullReference[] => collect(text);
// 모델이 고른 대상 하나. 링크, <소유자>/<저장소>#<번호>, <소유자>/<저장소>/pull/<번호>를 받는다. 그 밖의 꼴이나 둘 이상이면 없다.
export function pullTarget(target: string): PullReference | undefined {
  const value = target.trim();
  const slashed = /^([^/\s]+)\/([^/\s]+)\/pull\/([1-9][0-9]{0,9})$/.exec(value);
  const found = slashed ? collect(`github.com/${value}`) : collect(value);
  return found.length === 1 ? found[0] : undefined;
}
// GitHub 저장소 이름은 대소문자를 가리지 않는다.
export const samePull = (left: PullReference, right: PullReference) => left.number === right.number
  && left.owner.toLowerCase() === right.owner.toLowerCase() && left.repo.toLowerCase() === right.repo.toLowerCase();

export type ReviewRequestRefusal = 'outside_organization' | 'not_installed' | 'not_public' | 'not_found' | 'fork' | 'author' | 'closed' | 'unavailable';
export type ReviewRequestResult =
  | { outcome: 'started' | 'already'; repository: string; pr: number }
  | { outcome: 'refused'; reason: ReviewRequestRefusal };
// key: 요청 하나의 ID(대화 job). 리뷰 입력 이벤트의 delivery_id(`discord:<key>`)가 되어 출처가 Discord 요청임을 남긴다.
export interface ReviewRequestPort {
  request(input: { repository: string; pr: number; key: string }): Promise<ReviewRequestResult>;
}
// 리뷰 경로를 조립한 게시 서버만 묶는다(github-review-io.ts). 묶이지 않았으면 리뷰 요청 제안은 "연결 안 됨"으로 버린다.
const bound = new WeakMap<Store, ReviewRequestPort>();
export function bindReviewRequests(store: Store, port: ReviewRequestPort): void { bound.set(store, port); }
export const reviewRequestsOf = (store: Store): ReviewRequestPort | undefined => bound.get(store);

const pullLink = (repository: string, pr: number) => `https://github.com/${repository}/pull/${pr}`;
// 리뷰 요청 답(동료 말투 고정 문구). 결과 알림은 지금처럼 알림 채널의 리뷰 요약이다.
export const REVIEW_REQUEST_TEXT = Object.freeze({
  started: (repository: string, pr: number) => `리뷰 시작했어요. ${pullLink(repository, pr)}`,
  already: (repository: string, pr: number) => `이 PR은 지금 커밋으로 이미 리뷰했거나 리뷰하고 있어요. ${pullLink(repository, pr)}`,
  notInText: '말한 내용에서 그 PR 링크를 찾지 못해서 리뷰를 시작하지 않았어요. PR 링크를 같이 보내 주세요.',
  refused: Object.freeze({
    outside_organization: `${REVIEW_REQUEST_ORGANIZATION} 조직 저장소의 PR만 리뷰할 수 있어요.`,
    not_installed: '그 저장소에는 리뷰 App이 설치돼 있지 않아서 리뷰할 수 없어요.',
    not_public: '비공개 저장소의 PR은 아직 리뷰할 수 없어요.',
    not_found: '그 PR을 찾지 못했어요. 링크를 다시 확인해 주세요.',
    fork: 'fork에서 온 PR은 리뷰하지 않아요.',
    author: 'PR 작성자가 리뷰 조건(조직 멤버·협업자나 허용된 봇)에 맞지 않아서 리뷰하지 않아요.',
    closed: '닫혔거나 병합된 PR이라 리뷰하지 않아요.',
    unavailable: '지금은 리뷰를 시작할 수 없어요. 잠시 뒤 다시 말해 주세요.',
  } satisfies Record<ReviewRequestRefusal, string>),
});
