import { execFile } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { promisify } from 'node:util';
import { assertWorkerRoot } from './codex-config.js';
import { API_KEY_FILE, FileMutableCredential, METHOD_FILE, MethodEnvCredential, StaticEnvCredential } from './credentials.js';
import type { CredentialKind, WorkerCredential } from './credentials.js';
import { CLAUDE_CHAT_CAPABILITIES, ClaudeChatAdapter, ClaudeReviewAdapter } from './executor-claude.js';
import { CLAUDE_TASK_CAPABILITIES } from './executor-claude-task.js';
import { CODEX_CHAT_CAPABILITIES, CodexChatAdapter } from './executor-codex.js';
import { ACCOUNT_BUNDLE_FILE } from './execution-auth.js';
import type { ChatAdapter, ExecutorCapabilities, ExecutorId } from './executor.js';
import { WorkerStartError } from './worker-state.js';

// 승인된 실행기 프로필(D-14, 사용자 결정: "추후 쉽게 claude, codex, opencode 등 변경하기 용이하게").
// 기동 env 세 개가 프로필 하나를 고른다: WORKER_EXECUTOR(실행기), WORKER_CREDENTIAL_KEY(자격 키 이름 = 인증 방식),
// WORKER_MODEL(모델). 표에 없는 실행기·자격 조합이나 모양이 틀린 모델은 기동 실패다. 다른 프로필로 몰래 돌아가지 않는다.
// 이미 이 표에 있는 프로필 사이의 전환은 sandbox 설정 PR 하나(env 세 값·Secret 키·egress) + 자격 하나다.
// 새 실행기(예: OpenCode)는 어댑터·이미지·시험을 더한 뒤 이 표에 한 줄을 더한다. Claude API 키는 따로 줄을 두지 않고
// claude 프로필의 methods가 실행마다 고른다(아래).
export interface ExecutorProfile {
  readonly id: string;
  readonly executor: ExecutorId;
  // Infisical 키 이름이자 Secret 볼륨 파일 이름. 인증 방식을 뜻한다.
  readonly credentialKey: string;
  readonly auth: 'subscription-token' | 'subscription-auth-json';
  readonly credential: CredentialKind;
  // 이미지 안 실행 파일(Dockerfile이 심링크를 둔다). WORKER_EXECUTOR_BIN으로만 바꾼다(시험용).
  readonly bin: string;
  // 받는 모델 ID 모양. Claude는 별칭(opus 등) 없이 전체 ID만 받는다(실행마다 init 이벤트의 모델과 대조한다).
  readonly model: RegExp;
  readonly capabilities: ExecutorCapabilities;
  // WORKER_LANES=task로 띄울 때의 능력표. capabilities(대화·리뷰 작업자)와 격리 조건이 달라 따로 둔다. null이면 그 프로필은 작업 레인을 띄우지 않는다.
  readonly taskCapabilities: ExecutorCapabilities | null;
  // 이 프로필에만 필요한 env.
  readonly requiredEnv: readonly string[];
  // 실행마다 인증 방식을 고르는 프로필의 파일 이름(credentialKey와 같은 디렉터리). 방식 표시 파일, API 키 파일, 새 판 요청이
  // 대조하는 계정 묶음 파일이다. credentialKey는 구독 토큰 파일이다. null이면 credentialKey 하나만 읽고 방식 고르기를 받지 않는다.
  readonly methods: { readonly marker: string; readonly apiKey: string; readonly bundle: string } | null;
}
// claude-subscription은 이름이 옛 그대로지만 API 크레딧 방식도 맡는다. 방식은 기동 env가 아니라 실행마다 방식 표시 파일이 고른다
// (owner의 계정 전환이 파드 재시작 없이 반영돼야 한다). 프로필 이름·WORKER_CREDENTIAL_KEY를 바꾸지 않아 sandbox 값과 호환된다.
export const PROFILES: readonly ExecutorProfile[] = Object.freeze([
  Object.freeze({ id: 'claude-subscription', executor: 'claude', credentialKey: 'CLAUDE_CODE_OAUTH_TOKEN',
    auth: 'subscription-token', credential: 'env-static', bin: '/usr/local/bin/claude',
    model: /^claude-[a-z0-9]+(?:-[a-z0-9]+){1,8}$/, capabilities: CLAUDE_CHAT_CAPABILITIES, taskCapabilities: CLAUDE_TASK_CAPABILITIES, requiredEnv: Object.freeze([]),
    methods: Object.freeze({ marker: METHOD_FILE, apiKey: API_KEY_FILE, bundle: ACCOUNT_BUNDLE_FILE }) }),
  // Codex 대화 경로(D4). 모델은 CLI 기본값(`cli-default`, -m 없음)이다.
  Object.freeze({ id: 'codex-subscription', executor: 'codex', credentialKey: 'CODEX_AUTH_JSON',
    auth: 'subscription-auth-json', credential: 'file-mutable', bin: '/usr/local/bin/codex',
    model: /^cli-default$/, capabilities: CODEX_CHAT_CAPABILITIES, taskCapabilities: null, requiredEnv: Object.freeze(['CODEX_HOME']),
    methods: null }),
] as const satisfies readonly ExecutorProfile[]);
const EXECUTORS: readonly string[] = ['claude', 'codex'];
const KEY = /^[A-Z][A-Z0-9_]{0,63}$/;

// 값은 오류에 싣지 않는다. env 키 이름과 사유 코드만이다.
export function selectProfile(executor: string, credentialKey: string, model: string): ExecutorProfile {
  if (!EXECUTORS.includes(executor)) throw new WorkerStartError('config_invalid:WORKER_EXECUTOR');
  if (!KEY.test(credentialKey)) throw new WorkerStartError('config_invalid:WORKER_CREDENTIAL_KEY');
  const profile = PROFILES.find(p => p.executor === executor && p.credentialKey === credentialKey);
  if (!profile) throw new WorkerStartError('profile_unsupported');
  if (!profile.model.test(model)) throw new WorkerStartError('config_invalid:WORKER_MODEL');
  return profile;
}

// reviewAdapter: 리뷰 레인 어댑터. 무도구 경계를 시험하지 않은 실행기는 null이다(능력표 lanes.review와 같은 뜻).
export interface Executor { adapter: ChatAdapter; credential: WorkerCredential; reviewAdapter: ChatAdapter | null }
// 프로필 → 어댑터·자격 방식. 어댑터가 쓰는 경로(CODEX_HOME)가 사람 홈·개인 CLI 홈이면 여기서 거부된다.
export function createExecutor(profile: ExecutorProfile, paths: { credentialFile: string; codexHome?: string },
  homes: readonly string[]): Executor {
  switch (profile.executor) {
    case 'claude':
      return { adapter: new ClaudeChatAdapter('subscription-token'), credential: staticCredential(profile, paths.credentialFile, homes),
        reviewAdapter: new ClaudeReviewAdapter('subscription-token') };
    case 'codex': {
      // 홈을 여기서 한 번 검증·해석해 어댑터와 자격이 같은 실제 경로를 쓴다. 정상 별칭(심링크) 경로를 자격에 그대로
      // 넘기면 O_NOFOLLOW 읽기가 실패해 반사 검사가 비밀을 모른 채 실행된다.
      let home: string;
      try { home = assertWorkerRoot(paths.codexHome ?? '', homes); } catch { throw new WorkerStartError('codex_home_unavailable'); }
      return { adapter: new CodexChatAdapter(home, homes), credential: new FileMutableCredential(home, paths.credentialFile, homes),
        reviewAdapter: null };
    }
  }
}

// env-static 자격. 방식을 고르는 프로필이면 같은 디렉터리의 방식 표시·API 키 파일까지 함께 읽는다. 대화·리뷰 작업자와
// 작업 레인 작업자가 같은 조립을 쓴다(작업 레인 Secret도 같은 파일 이름으로 마운트된다).
export function staticCredential(profile: ExecutorProfile, credentialFile: string, homes: readonly string[]): WorkerCredential {
  if (!profile.methods) return new StaticEnvCredential(credentialFile, homes);
  const dir = dirname(credentialFile);
  return new MethodEnvCredential({ subscription: credentialFile, api: join(dir, profile.methods.apiKey) }, join(dir, profile.methods.marker), homes,
    join(dir, profile.methods.bundle));
}

const run = promisify(execFile);
// `<bin> --version`만 부른다(모델 호출·로그인 없음). 빈 임시 HOME·설정 디렉터리로 돌려 영속 공간을 건드리지 않는다.
export async function executorVersion(adapter: ChatAdapter, bin: string): Promise<string> {
  const scratch = await mkdtemp(join(tmpdir(), 'homelab-executor-version-'));
  try {
    const { stdout } = await run(bin, ['--version'], { timeout: 15_000, maxBuffer: 64 * 1024,
      env: { PATH: '/usr/local/bin:/usr/bin:/bin', HOME: scratch, LANG: 'C.UTF-8', TMPDIR: scratch, ...adapter.versionEnv(scratch) } });
    const version = adapter.parseVersion(stdout);
    if (!version) throw new Error();
    return version;
  } catch { throw new WorkerStartError('executor_version_unavailable'); }
  finally { await rm(scratch, { recursive: true, force: true }).catch(() => {}); }
}
