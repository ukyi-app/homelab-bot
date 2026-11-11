import type { FileHandle } from 'node:fs/promises';
import { lstat } from 'node:fs/promises';
import { join } from 'node:path';
import { authSecrets } from './codex-events.js';
import { openDir, readAt } from './codex-workspace.js';
import { WorkerStartError, readSecretFile, seedAuth } from './worker-state.js';

// 모델 자격 방식. 실행기 이름과 따로 둔다(같은 실행기도 방식이 다를 수 있다, 예: Claude 구독 토큰과 API 키).
// - env-static: 정적 값(Claude 구독 장기 토큰 또는 API 키). Secret 볼륨 파일을 실행 준비 때마다 다시 읽어 그 실행의 자식 env
//   한 변수에만 넣는다. 영속 공간에 복사·되쓰기하지 않는다. ESO가 값을 바꾸면 다음 실행부터 새 값이다(파드 재시작 불필요).
// - file-mutable: CLI가 스스로 갱신하는 파일(Codex 구독 auth.json). 영속 공간에 없을 때만 시드하고 갱신본을 덮지 않는다
//   (D-14 조건 4). 시드 설치 규칙은 worker-state.seedAuth 그대로다.
// 어느 방식도 자격 값을 로그·오류·결과에 싣지 않는다. 실패는 사유 코드(WorkerStartError.code)뿐이다.
export type CredentialKind = 'env-static' | 'file-mutable';

// Claude 인증 방식(COLLEAGUE_SPEC §4.8 "API 크레딧 방식"). 값 글자는 방식 표시 파일 내용이자 봇 DB model_accounts.method,
// 지표 homelab_bot_model_account의 method 라벨과 같다.
export const CREDENTIAL_METHODS = ['subscription', 'api'] as const;
export type CredentialMethod = (typeof CREDENTIAL_METHODS)[number];
// Secret 볼륨 파일 이름(= Infisical 키 이름, DECISIONS "C23 API 크레딧 방식" 표). 구독 토큰 파일 이름은 WORKER_CREDENTIAL_KEY다.
export const METHOD_FILE = 'CLAUDE_AUTH_METHOD';
export const API_KEY_FILE = 'ANTHROPIC_API_KEY';
// 안 쓰는 방식의 키에 두는 값. ExternalSecret은 키가 Infisical에 있어야 Ready라 키를 지우지 않고 이 값으로 비운다.
export const CREDENTIAL_PLACEHOLDER = 'unset';

export interface RunCredential {
  // env-static: 어댑터가 자식 env에 넣을 값. 넣을 변수 이름은 어댑터(credentialEnv)가 정한다.
  value?: string;
  // 이 실행의 인증 방식. 방식을 고르는 자격(MethodEnvCredential)만 싣는다. 어댑터가 이 값으로 자격 변수 이름을 고른다.
  method?: CredentialMethod;
  // 반사 검사·유출 검사에 쓰는 비밀 문자열(실행 전에 읽은 값).
  secrets: readonly string[];
}
export interface WorkerCredential {
  readonly kind: CredentialKind;
  // 기동 때 한 번. 값 없는 상태 이름만 돌려준다(seeded·kept: 파일 자격, present: 정적 자격).
  open(): Promise<'seeded' | 'kept' | 'present'>;
  // readiness. 모델을 부르지 않고 자격이 쓸 수 있는 모양으로 있는지만 본다.
  ready(): Promise<boolean>;
  // 실행 준비 때. 읽지 못하면 throw다(실행하지 않는다).
  forRun(): Promise<RunCredential>;
  // 실행 뒤 다시 읽은 비밀(회전 파일이면 갱신본). 반사 검사에 실행 전 값과 함께 쓴다.
  // 읽지 못하거나 비어 있으면 throw다. 빈 목록으로 반사 검사를 건너뛰지 않는다.
  secrets(): Promise<string[]>;
}

// 정적 토큰 상한과 모양. 토큰 형식은 공식 문서에 없어 [미확인] 접두어는 보지 않는다. 한 줄의 인쇄 가능한 ASCII만 받는다.
// Secret 저장소가 붙이는 앞뒤 공백·줄바꿈은 떼고 쓴다.
const STATIC_LIMIT = 16 * 1024;
const STATIC_SHAPE = /^[\x21-\x7e]{16,8192}$/;
export class StaticEnvCredential implements WorkerCredential {
  readonly kind = 'env-static';
  constructor(private readonly file: string, private readonly homes: readonly string[]) {}
  async open(): Promise<'present'> { await this.read(); return 'present'; }
  async ready(): Promise<boolean> { return this.read().then(() => true, () => false); }
  async forRun(): Promise<RunCredential> {
    const value = await this.read();
    return { value, secrets: [value] };
  }
  async secrets(): Promise<string[]> { return [await this.read()]; }
  private read(): Promise<string> { return readStatic(this.file, this.homes); }
}
async function readStatic(file: string, homes: readonly string[]): Promise<string> {
  const raw = await readSecretFile(file, homes, { prefix: 'credential', limit: STATIC_LIMIT });
  const value = raw.toString('utf8').replace(/^\s+|\s+$/g, '');
  if (value === CREDENTIAL_PLACEHOLDER) throw new WorkerStartError('credential_missing');
  if (!STATIC_SHAPE.test(value)) throw new WorkerStartError('credential_invalid');
  return value;
}

// Claude 구독 토큰과 API 키 중 방식 표시가 고른 하나(env-static). 같은 Secret 볼륨의 세 파일을 실행 준비 때마다 다시 읽는다.
// owner가 계정을 바꾸면(ESO가 볼륨을 갱신하면) 파드 재시작 없이 다음 실행부터 바뀐다.
// - 방식 표시 파일이 없으면 구독이다. 방식 표시 키가 없는 지금의 Secret과 새 작업자 조합이 지금처럼 돌아야 해서다.
//   표시는 있는데 모르는 값이면 실행하지 않는다(credential_method_invalid).
// - 표시한 방식의 자격만 실행 env에 넣는다. 그 자격이 없거나 자리 표시값인데 다른 방식의 자격이 있으면 실행하지 않는다
//   (credential_method_mismatch). 다른 방식으로 몰래 돌지 않는다.
// - 반사·유출 검사에는 읽을 수 있는 두 방식의 자격을 모두 쓴다. 실행 env에 없는 자격이 출력에 실려도 막는다.
// 방식 표시와 자격 파일은 따로 읽어 kubelet의 볼륨 교체와 엇갈릴 수 있다. 그때도 표시와 자격이 맞지 않으면 실행하지 않을 뿐
// 다른 방식으로 돌지 않는다(다음 실행에서 맞는다).
const METHOD_LIMIT = 64;
export class MethodEnvCredential implements WorkerCredential {
  readonly kind = 'env-static';
  constructor(private readonly files: Readonly<Record<CredentialMethod, string>>, private readonly methodFile: string,
    private readonly homes: readonly string[]) {}
  async open(): Promise<'present'> { await this.forRun(); return 'present'; }
  async ready(): Promise<boolean> { return this.forRun().then(() => true, () => false); }
  async forRun(): Promise<RunCredential> {
    const method = await this.method();
    const other = method === 'subscription' ? 'api' : 'subscription';
    const extra = await readStatic(this.files[other], this.homes).catch(() => null);
    let value: string;
    try { value = await readStatic(this.files[method], this.homes); } catch (error) {
      if (extra !== null) throw new WorkerStartError('credential_method_mismatch');
      throw error;
    }
    return { value, method, secrets: extra === null ? [value] : [value, extra] };
  }
  async secrets(): Promise<string[]> {
    const found = (await Promise.all(CREDENTIAL_METHODS.map(m => readStatic(this.files[m], this.homes).catch(() => null))))
      .filter((value): value is string => value !== null);
    if (!found.length) throw new WorkerStartError('credential_unreadable');
    return found;
  }
  private async method(): Promise<CredentialMethod> {
    let raw: Buffer;
    try { raw = await readSecretFile(this.methodFile, this.homes, { prefix: 'credential_method', limit: METHOD_LIMIT }); } catch (error) {
      if (error instanceof WorkerStartError && error.code === 'credential_method_missing') return 'subscription';
      throw error;
    }
    const value = raw.toString('utf8').replace(/^\s+|\s+$/g, '');
    if (!(CREDENTIAL_METHODS as readonly string[]).includes(value)) throw new WorkerStartError('credential_method_invalid');
    return value as CredentialMethod;
  }
}

// Codex 구독 auth.json. home은 작업자 영속 공간의 CODEX_HOME이다(PVC, 갱신본이 남는 곳).
const AUTH_LIMIT = 1024 * 1024;
export class FileMutableCredential implements WorkerCredential {
  readonly kind = 'file-mutable';
  constructor(readonly home: string, private readonly seedFile: string, private readonly homes: readonly string[]) {}
  open(): Promise<'seeded' | 'kept'> { return seedAuth(this.home, this.seedFile, { homes: this.homes }); }
  // 영속 공간에 일반 파일 auth.json이 있어야 모델을 부를 수 있다.
  async ready(): Promise<boolean> {
    try { return (await lstat(join(this.home, 'auth.json'))).isFile(); } catch { return false; }
  }
  async forRun(): Promise<RunCredential> { return { secrets: await this.secrets() }; }
  // 고정한 디렉터리 핸들 아래에서 읽는다. auth.json 자리에 심링크가 있으면 따라가지 않는다. home은 공장 함수가
  // 해석한 실제 경로여야 한다(openDir이 O_NOFOLLOW라 별칭 경로면 열리지 않는다).
  async secrets(): Promise<string[]> {
    let dir: FileHandle | undefined;
    let found: string[] = [];
    try {
      dir = await openDir(this.home);
      const result = await readAt(dir, 'auth.json', AUTH_LIMIT);
      if (result.status === 'ok') found = authSecrets(result.text);
    } catch { /* 아래에서 실패로 처리한다 */ } finally { await dir?.close().catch(() => {}); }
    if (!found.length) throw new WorkerStartError('credential_unreadable');
    return found;
  }
}
