import { randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import type { FileHandle } from 'node:fs/promises';
import { open, rename, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { CODEX_CAPABILITIES } from './codex.js';
import { assertWorkerRoot, codexConfig, configToml } from './codex-config.js';
import type { CodexPaths } from './codex-config.js';
import { compactEvent, parseStream, waitReason } from './codex-events.js';
import { openDir, readAt, writeAt } from './codex-workspace.js';
import type { AdapterRun, ChatAdapter, ChatRun, EngineOutcome, ExecutorCapabilities, ExitStatus } from './executor.js';

// Codex 대화 어댑터(T16b D4의 기존 경로를 실행기 인터페이스 뒤로 옮긴 것, 동작은 그대로).
// - CODEX_HOME은 작업자 영속 공간(file-mutable 자격의 home)을 그대로 쓴다. auth.json 갱신본이 그 자리에 남는다(D-14 조건 4).
// - 세션 기록을 남기지 않는다: `--ephemeral` [확인: 0.163.0 `codex exec --help` "Run without persisting session files
//   to disk"]. 플래그가 실제로 지키는지는 모델 호출 전이라 [미확인]이어서, 실행 뒤 세션 디렉터리도 지운다.
// - 빈 임시 작업 공간 + `--skip-git-repo-check`. 정책은 플래그가 아니라 config.toml(read-only 샌드박스, 셸 env 비상속).
// - 모델은 CLI 기본값이다(프로필 모델 `cli-default`, -m을 넘기지 않는다). 모델 고정은 검증한 모델 ID가 생기면 더한다.
export const CODEX_CHAT_CAPABILITIES: ExecutorCapabilities = Object.freeze({
  executor: 'codex', cliVersion: CODEX_CAPABILITIES.version, lanes: Object.freeze({ chat: true, task: false }),
  structuredOutput: 'native-schema', tools: 'read-only-sandbox', sessionPersistence: 'off', modelPinned: false,
  credential: 'file-mutable', evidence: 'fake-cli',
} as const);

export function chatArgs(run: string): string[] {
  return ['exec', '--json', '--ephemeral', '--skip-git-repo-check',
    '--output-schema', join(run, 'answer.schema.json'), '-o', join(run, 'last-message.json'), '-'];
}

export interface CodexChatReport {
  lines: readonly string[];
  exit: ExitStatus;
  output: string | null;
  outputTooLarge?: boolean;
}
const failed = (reason: string): EngineOutcome => ({ kind: 'failed', reason });
// Codex JSONL 해석. 순서는 작업 레인(interpretRun)과 같다: 흐름 무결성 → 실패 신호 → 종료 코드 → 턴 완료 → 최종 출력.
// 소멸 확인·상한·중단·스키마·반사는 공통부(chat-lane)가 한다.
export function interpretCodexChat(report: CodexChatReport): EngineOutcome {
  const { events, malformed } = parseStream(report.lines);
  if (malformed > 0) return failed('invalid_stream');
  const failures = events.flatMap(e => e.type === 'turn.failed' ? [e.error?.message ?? ''] : e.type === 'error' ? [e.message ?? ''] : []);
  const lastTurn = events.filter(e => e.type.startsWith('turn.')).at(-1);
  if (events.some(e => e.type === 'turn.failed') || (failures.length && (report.exit.code !== 0 || lastTurn?.type !== 'turn.completed'))) {
    // 한도·인증 만료의 이벤트 모양은 공식 문서에 없다. 실패 메시지 문구로 고른다 [가정](codex-events.waitReason).
    const reason = waitReason(failures.join('\n'));
    return reason === 'model_limit' ? { kind: 'limited' } : reason === 'auth_expired' ? { kind: 'auth_expired' } : failed('turn_failed');
  }
  if (report.exit.code !== 0) return failed('exit_nonzero');
  if (lastTurn?.type !== 'turn.completed') return failed('turn_incomplete');
  if (report.outputTooLarge) return failed('output_too_large');
  try { return { kind: 'output', value: JSON.parse(report.output ?? '') }; } catch { return failed('invalid_output'); }
}

// 공유 CODEX_HOME의 설정을 원자적으로 바꾼다. 대화 레인은 직렬 하나라 동시에 쓰는 실행이 없다.
async function writeConfig(home: string, content: string): Promise<void> {
  const temporary = join(home, `.config.toml-${randomUUID()}`);
  try {
    const handle = await open(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
    try { await handle.writeFile(content); } finally { await handle.close(); }
    await rename(temporary, join(home, 'config.toml'));
  } catch (error) { await rm(temporary, { force: true }).catch(() => {}); throw error; }
}
const OUTPUT_LIMIT = 1024 * 1024;

export class CodexChatAdapter implements ChatAdapter {
  readonly capabilities = CODEX_CHAT_CAPABILITIES;
  readonly envNames: readonly string[] = Object.freeze(['CODEX_HOME']);
  readonly credentialEnv = null;
  private readonly home: string;
  constructor(codexHome: string, homes?: readonly string[]) {
    // 개인 Codex·Claude 홈(~/.codex*·~/.claude*)이나 사람 홈 자체는 거부한다(D-14 조건 1). 경로 모양으로만 본다.
    this.home = assertWorkerRoot(codexHome, homes);
  }
  versionEnv(scratch: string): Record<string, string> { return { CODEX_HOME: scratch }; }
  parseVersion(stdout: string): string | null { return /^codex-cli (\S+)\s*$/m.exec(stdout)?.[1] ?? null; }
  async start(run: ChatRun): Promise<AdapterRun> {
    // home은 codex가 쓰는 CODEX_HOME(공유 원본), taskHome은 이 실행의 HOME이다(codex-config 이름 그대로).
    const paths: CodexPaths = { job: run.job, root: run.dirs.root, home: this.home, taskHome: run.dirs.home,
      workspace: run.dirs.workspace, run: run.dirs.run, tmp: run.dirs.tmp };
    await writeConfig(this.home, configToml(codexConfig(paths, 'read-only')));
    const dir: FileHandle = await openDir(run.dirs.run);
    try { await writeAt(dir, 'answer.schema.json', JSON.stringify(run.schema)); }
    catch (error) { await dir.close().catch(() => {}); throw error; }
    const home = this.home;
    return {
      args: chatArgs(run.dirs.run),
      env: { CODEX_HOME: home },
      observe: line => { const compact = compactEvent(line); return { line: compact.line, tool: compact.tool, violation: null }; },
      async finish(lines, exit) {
        const output = await readAt(dir, 'last-message.json', OUTPUT_LIMIT);
        return interpretCodexChat({ lines, exit, output: output.status === 'ok' ? output.text : null,
          outputTooLarge: output.status === 'too_large' });
      },
      async cleanup(confirmed) {
        // 여러 번 불릴 수 있다(공통부가 지우지 못한 기록을 다시 지울 때). 이미 닫힌 핸들의 닫기 오류는 무시한다.
        await dir.close().catch(() => {});
        if (!confirmed) return;
        // `--ephemeral`이 남긴 것이 있으면 지운다. 이 CODEX_HOME의 세션은 대화 레인 것뿐이다(작업 레인 미연결).
        // 세션 위치 `sessions/`·`archived_sessions/`는 [가정: Codex 기본 배치]다. 지우지 못하면 오류를 올려 보내
        // 공통부가 실패로 다루고 다시 지운다(리뷰 exec-r1 P2: 예전에는 오류를 숨겼다).
        for (const name of ['sessions', 'archived_sessions']) await rm(join(home, name), { recursive: true, force: true });
      },
    };
  }
}
