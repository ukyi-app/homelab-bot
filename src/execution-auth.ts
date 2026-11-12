import { createHash, timingSafeEqual } from 'node:crypto';
import { z } from 'zod';
import type { EngineOutcome } from './executor.js';
import { ACCOUNT_NAME } from './model-accounts.js';

// 실행마다 방식 고르기의 전송 계약(COLLEAGUE_SPEC §4.11, DECISIONS "C39"). 게시 서버가 고른 방식을 서명된 요청의 신뢰 칸에 싣고,
// 작업자는 설치된 계정 묶음과 대조한 뒤 그 방식의 자격 하나만 실행 env에 넣는다. 모델 출력 스키마에는 이 칸이 없다.
// 이 칸은 새 판 요청(대화 v3)에만 있다. 옛 판 요청에 몰래 더하지 않는다(옛 strict 스키마와 digest 키 순서가 계약이다).

// credentials.ts의 CREDENTIAL_METHODS와 같은 값. credentials.ts가 이 파일을 읽으므로 순환 import를 피하려고 따로 적는다.
const METHODS = ['subscription', 'api'] as const;
type Method = typeof METHODS[number];
// 묶음 revision. homelab CLI가 정한다(C42). 로그·경로에 써도 되는 식별자 모양만 받는다.
export const CREDENTIAL_REVISION = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,63}$/;

// 요청의 신뢰 칸. 키 순서도 digest 계약이다.
export const ExecutionSelectionSchema = z.strictObject({
  account: z.string().regex(ACCOUNT_NAME),
  credentialRevision: z.string().regex(CREDENTIAL_REVISION),
  method: z.enum(METHODS),
  runId: z.string().uuid(),
});
export type ExecutionSelection = z.infer<typeof ExecutionSelectionSchema>;

// 응답 칸. 작업자가 그 요청으로 자격을 넣었거나 넣었을 수 있는 실행의 계정·revision·방식·실행 ID다. 작업자는 요청 선택 말고 다른
// 방식으로 돌 길이 없어 늘 요청 선택과 같은 값이다(게시 서버는 다르면 믿지 않는다).
// subscriptionLimit: 구독 실행이 넘어갈 근거가 되는 한도 실패 모양으로 끝났는지(허용 목록, 아래 subscriptionLimitFailure).
// 넘어갈지는 게시 서버(C40)가 정한다.
export const ExecutionAuthSchema = z.strictObject({
  ...ExecutionSelectionSchema.shape,
  subscriptionLimit: z.boolean(),
});
export type ExecutionAuth = z.infer<typeof ExecutionAuthSchema>;
export const executionAuth = (selection: ExecutionSelection, subscriptionLimit = false): ExecutionAuth =>
  ({ account: selection.account, credentialRevision: selection.credentialRevision, method: selection.method, runId: selection.runId,
    subscriptionLimit });

// 모델을 부르지 않고 거부한 사유. 응답은 HTTP 200의 status not_run이라 게시 서버가 서명 거부(WorkerRejected → failed)와 구분한다.
export const SELECTION_REFUSALS = [
  // 이 작업자 프로필이 방식 고르기를 못 한다(Codex 등).
  'selection_unsupported',
  // 계정 묶음 파일이 없다 / 모양이 틀리다.
  'bundle_missing', 'bundle_invalid',
  // 요청의 계정·revision이 설치된 묶음과 다르다.
  'bundle_mismatch',
  // 두 자격 중 하나라도 없거나 자리 표시값(unset)이거나 모양이 틀리다.
  'credential_missing',
  // 자격 값이 묶음 지문과 다르거나, 파일들이 서로 다른 볼륨 세대에서 왔다(교체 중 섞인 조합).
  'credential_mixed',
] as const;
export type SelectionRefusal = typeof SELECTION_REFUSALS[number];
export class SelectionRefused extends Error {
  constructor(readonly refusal: SelectionRefusal) { super(refusal); }
}
export const NotRunSchema = z.strictObject({ status: z.literal('not_run'), stopped: z.literal(true), refusal: z.enum(SELECTION_REFUSALS) });
export type NotRun = z.infer<typeof NotRunSchema>;
export const notRun = (refusal: SelectionRefusal): NotRun => ({ status: 'not_run', stopped: true, refusal });

// 계정 묶음(작업자가 읽는 쪽 계약, C42·C43이 설치한다). 레인 Secret 볼륨의 이 이름 파일이고 두 자격 파일과 같은 디렉터리다.
// 비밀은 아니지만 지문은 로그·응답·프롬프트·지표에 싣지 않는다.
export const ACCOUNT_BUNDLE_FILE = 'CLAUDE_ACCOUNT_BUNDLE';
export const ACCOUNT_BUNDLE_LIMIT = 1024;
const Fingerprint = z.string().regex(/^[a-f0-9]{64}$/);
export const AccountBundleSchema = z.strictObject({
  version: z.literal(1),
  account: z.string().regex(ACCOUNT_NAME),
  revision: z.string().regex(CREDENTIAL_REVISION),
  fingerprints: z.strictObject({ subscription: Fingerprint, api: Fingerprint }),
});
export type AccountBundle = z.infer<typeof AccountBundleSchema>;
// 지문: 자격 값(앞뒤 공백·줄바꿈을 뗀 문자열)의 UTF-8 바이트 SHA-256, 소문자 hex. 레인마다 자기 Secret의 두 값으로 계산한다.
// 자격은 고엔트로피 값이라 지문에서 값을 되돌릴 수 없다.
export const credentialFingerprint = (value: string): string => createHash('sha256').update(value, 'utf8').digest('hex');
export const fingerprintMatches = (value: string, expected: string): boolean =>
  timingSafeEqual(Buffer.from(credentialFingerprint(value), 'hex'), Buffer.from(expected, 'hex'));

// 넘어갈 근거가 되는 구독 한도 실패의 허용 목록(DECISIONS "C39" fixture 표). 모르는 모양은 넘어가지 않는다.
// 1. 구독 실행이 CLI의 오류 종류 rate_limit으로 한도 대기가 됐다.
// 2. 오류 종류 없이 HTTP 429로 한도 대기가 됐고, 같은 실행의 마지막 rate_limit_event가 rejected다.
// 결제 원인(billing_error·402·결제 오류 식별자), API 방식(429도 결제로 닫힌다), 경고만 본 429, 성공·인증·과부하는 근거가 아니다.
export function subscriptionLimitFailure(method: Method, outcome: EngineOutcome | undefined): boolean {
  if (method !== 'subscription' || outcome?.kind !== 'limited' || outcome.rateLimit?.stop?.cause !== 'rate_limit') return false;
  if (outcome.basis === 'error_kind') return true;
  return outcome.basis === 'http_status' && outcome.rateLimit.event?.status === 'rejected';
}

// 지원 확인. 작업자 HTTP의 인증 없는 GET 경로이고, 방식 고르기를 받는 요청 경로 이름 목록을 낸다. 옛 작업자는 이 경로가 없어 404다.
// 게시 서버는 목록에 그 경로가 있을 때만 새 판 요청을 보낸다. 모르는 이름은 무시한다(뒤 판이 이름을 더할 수 있다).
export const WORKER_CONTRACTS_PATH = '/v1/contracts';
// chat: 대화 요청 v3(/v1/execute). review: PR 리뷰 요청 v2(/v1/review).
export const EXECUTION_SELECTION_PATHS = ['chat', 'review'] as const;
export const WorkerContractsSchema = z.object({ executionSelection: z.array(z.string().max(64)).max(32) });
export type WorkerContracts = z.infer<typeof WorkerContractsSchema>;
