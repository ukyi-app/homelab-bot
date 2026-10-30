import { execFile } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { assertWorkerRoot } from './codex-config.js';
import { FileMutableCredential, StaticEnvCredential } from './credentials.js';
import type { CredentialKind, WorkerCredential } from './credentials.js';
import { CLAUDE_CHAT_CAPABILITIES, ClaudeChatAdapter } from './executor-claude.js';
import { CODEX_CHAT_CAPABILITIES, CodexChatAdapter } from './executor-codex.js';
import type { ChatAdapter, ExecutorCapabilities, ExecutorId } from './executor.js';
import { WorkerStartError } from './worker-state.js';

// 승인된 실행기 프로필(D-14 변경, 사용자 2026-10-30: "추후 쉽게 claude, codex, opencode 등 변경하기 용이하게").
// 기동 env 세 개가 프로필 하나를 고른다: WORKER_EXECUTOR(실행기), WORKER_CREDENTIAL_KEY(자격 키 이름 = 인증 방식),
// WORKER_MODEL(모델). 표에 없는 실행기·자격 조합이나 모양이 틀린 모델은 기동 실패다. 다른 프로필로 몰래 돌아가지 않는다.
// 이미 이 표에 있는 프로필 사이의 전환은 sandbox 설정 PR 하나(env 세 값·Secret 키·egress) + 자격 하나다.
// 새 실행기(예: OpenCode)나 새 인증 방식(예: Claude API 키)은 어댑터·이미지·시험을 더한 뒤 이 표에 한 줄을 더한다.
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
  // 이 프로필에만 필요한 env.
  readonly requiredEnv: readonly string[];
}
export const PROFILES: readonly ExecutorProfile[] = Object.freeze([
  Object.freeze({ id: 'claude-subscription', executor: 'claude', credentialKey: 'CLAUDE_CODE_OAUTH_TOKEN',
    auth: 'subscription-token', credential: 'env-static', bin: '/usr/local/bin/claude',
    model: /^claude-[a-z0-9]+(?:-[a-z0-9]+){1,8}$/, capabilities: CLAUDE_CHAT_CAPABILITIES, requiredEnv: Object.freeze([]) }),
  // 기존 Codex 대화 경로(D4). 모델은 CLI 기본값(`cli-default`, -m 없음)이다.
  Object.freeze({ id: 'codex-subscription', executor: 'codex', credentialKey: 'CODEX_AUTH_JSON',
    auth: 'subscription-auth-json', credential: 'file-mutable', bin: '/usr/local/bin/codex',
    model: /^cli-default$/, capabilities: CODEX_CHAT_CAPABILITIES, requiredEnv: Object.freeze(['CODEX_HOME']) }),
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

export interface Executor { adapter: ChatAdapter; credential: WorkerCredential }
// 프로필 → 어댑터·자격 방식. 어댑터가 쓰는 경로(CODEX_HOME)가 사람 홈·개인 CLI 홈이면 여기서 거부된다.
export function createExecutor(profile: ExecutorProfile, paths: { credentialFile: string; codexHome?: string },
  homes: readonly string[]): Executor {
  switch (profile.executor) {
    case 'claude':
      return { adapter: new ClaudeChatAdapter('subscription-token'), credential: new StaticEnvCredential(paths.credentialFile, homes) };
    case 'codex': {
      // 홈을 여기서 한 번 검증·해석해 어댑터와 자격이 같은 실제 경로를 쓴다. 정상 별칭(심링크) 경로를 자격에 그대로
      // 넘기면 O_NOFOLLOW 읽기가 실패해 반사 검사가 비밀을 모른 채 실행됐다(리뷰 exec-r1 P1).
      let home: string;
      try { home = assertWorkerRoot(paths.codexHome ?? '', homes); } catch { throw new WorkerStartError('codex_home_unavailable'); }
      return { adapter: new CodexChatAdapter(home, homes), credential: new FileMutableCredential(home, paths.credentialFile, homes) };
    }
  }
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
