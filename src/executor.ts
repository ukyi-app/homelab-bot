import type { CredentialKind, RunCredential } from './credentials.js';

// 작업자 안 모델 실행기의 내부 계약(T16b, D-14 변경 사용자 2026-10-30).
// 게시 서버와의 HTTP v1(worker.ts)은 실행기 이름·플래그·자격을 담지 않는다. 그 아래에서
//   공통 실행 제어(chat-lane, process-launcher): 직렬·기한·취소·프로세스 그룹 정리·빈 작업 공간·env 허용 목록·
//     자격 유출 검사·구조화 결과 검증·반사 검사·결과 분류(succeeded/limited/auth_expired/failed/unknown)
//   실행기 어댑터(executor-codex 등): argv·env·설정 파일·출력 해석·CLI 오류 분류만
// 로 나눈다. 어떤 실행기를 쓸지는 기동 때 프로필(executor-profiles)이 고르고, 실행 중에는 바꾸지 않는다.

export type ExecutorId = 'codex';

// 프로필에서 내는 능력표. 값이 불명확하면 지원한다고 적지 않는다.
export interface ExecutorCapabilities {
  readonly executor: ExecutorId;
  // 이미지에 고정한 CLI 버전. 기동 때 `--version`과 대조한다.
  readonly cliVersion: string;
  // 레인별 지원. 작업 레인은 아직 어떤 실행기도 연결하지 않았다(T18 결정 대기).
  readonly lanes: { readonly chat: boolean; readonly task: boolean };
  // 구조화 출력: CLI가 스키마를 받아 결과에 담는다. 봇이 공통 스키마로 다시 검증한다.
  readonly structuredOutput: 'native-schema';
  // 대화 레인에서 모델이 쓸 수 있는 도구. none: CLI 도구를 끄고 실행 중 도구 호출이 보이면 멈춘다.
  // read-only-sandbox: Codex read-only 샌드박스 + 요청의 도구 예산(D4, 기존 승인 범위).
  readonly tools: 'none' | 'read-only-sandbox';
  // 대화 실행은 세션 기록을 남기지 않는다(CLI 플래그 + 실행 뒤 정리). 재개는 지원하지 않는다.
  readonly sessionPersistence: 'off';
  // 모델을 CLI 인자로 정확히 고정하는지. false면 CLI 기본 모델이다.
  readonly modelPinned: boolean;
  readonly credential: CredentialKind;
  // 근거 수준. 실제 모델 호출로 확인하기 전에는 가짜 CLI 시험까지다.
  readonly evidence: 'fake-cli';
}

// 실행마다 /tmp 아래 새로 만드는 디렉터리. 모두 실행이 끝나고 남은 프로세스 0개를 확인한 뒤 지운다.
export interface RunDirs { root: string; home: string; config: string; workspace: string; run: string; tmp: string }
export interface ChatRun {
  job: string;
  model: string;
  dirs: RunDirs;
  credential: RunCredential;
  // CLI에 넘길 출력 스키마(공통부 소유). 프롬프트는 공통부가 stdin으로만 넘긴다(argv·파일에 두지 않는다).
  schema: object;
}
// 실행 중 stdout 한 줄을 본 결과. line은 판정에 쓰는 필드만 남긴 줄이다(모델 본문·도구 출력은 버린다).
// tool은 작업용 도구 호출 ID(출력 전달용 내부 도구는 빼고), violation은 정책 위반 사유(있으면 공통부가 바로 멈춘다).
export interface Observation { line: string; tool: string | null; violation: string | null }
// 어댑터가 내는 실행기 중립 결과. 소멸 확인·중단·상한·스키마·반사 판정은 공통부가 한다.
export type EngineOutcome =
  | { kind: 'output'; value: unknown }
  | { kind: 'limited' }
  | { kind: 'auth_expired' }
  | { kind: 'failed'; reason: string };
export interface ExitStatus { code: number | null; signal: string | null }

export interface AdapterRun {
  readonly args: readonly string[];
  // 어댑터가 공통 기본 env(PATH·HOME·LANG·TMPDIR·작업 표식·프록시)에 더하는 것만.
  readonly env: Readonly<Record<string, string>>;
  observe(line: string): Observation;
  // 프로세스 소멸을 확인한 뒤에만 부른다. 살아 있는 프로세스가 결과 파일을 바꿔치기할 수 있다.
  finish(lines: readonly string[], exit: ExitStatus): Promise<EngineOutcome>;
  // 항상 부른다(열어 둔 핸들 닫기). confirmed(남은 프로세스 0개)일 때만 실행기 고유 잔여물을 지운다.
  cleanup(confirmed: boolean): Promise<void>;
}
export interface ChatAdapter {
  readonly capabilities: ExecutorCapabilities;
  // 어댑터가 자식 env에 더할 수 있는 이름. 이 밖의 이름을 내면 공통부가 실행하지 않는다.
  readonly envNames: readonly string[];
  // 자격 값을 넣는 env 이름(env-static 자격). 자격 값은 이 변수에만 있어야 한다. 파일 자격이면 null.
  readonly credentialEnv: string | null;
  // `--version` 실행 때 더할 env(빈 임시 디렉터리만 가리킨다)와 출력 해석. 모델 호출이 없다.
  versionEnv(scratch: string): Record<string, string>;
  parseVersion(stdout: string): string | null;
  start(run: ChatRun): Promise<AdapterRun>;
}
