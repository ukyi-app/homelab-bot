import { realpathSync } from 'node:fs';
import { homedir } from 'node:os';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';
import { Denied } from './contracts.js';

// 작업자가 쓰는 Codex 설정. 시작과 `exec resume`이 같은 정책을 갖도록 플래그가 아니라 설정 파일에 고정한다.
// `exec resume`에는 -s·-C가 없다 [실측: codex-cli 0.163.0 `codex exec resume --help`, ARCHITECTURE §4].
export const SECRET_NAME = /KEY|SECRET|TOKEN|PASSWORD|CREDENTIAL|AUTH|COOKIE|SESSION|PRIVATE/i;
export interface CodexPaths { job: string; root: string; home: string; taskHome: string; workspace: string; run: string; tmp: string }
// 작업이 띄운 프로세스를 찾는 표식. 새 세션으로 빠져나간 자식도 환경을 지우지 않았다면 찾는다.
export const TASK_MARKER = 'HOMELAB_CODEX_TASK';
export interface ShellPolicy {
  inherit: 'none'; ignore_default_excludes: false; exclude: readonly string[]; set: Readonly<Record<string, string>>;
}
export interface CodexConfig {
  sandbox_mode: 'workspace-write'; approval_policy: 'never';
  sandbox_workspace_write: { network_access: false };
  shell_environment_policy: ShellPolicy;
}

// 개인 Codex 홈(~/.codex, ~/.codex-sub, ~/.codex-work와 심링크 ~/.codex2·~/.codex3)은 목록을 읽지 않고
// 경로 모양만으로 막는다. realpath는 작업자 루트에만 쓴다. 홈 디렉터리를 열거하지 않는다(D-14, spec §4.5).
// 작업자가 사람과 다른 UID로 돌면 자기 홈만으로는 사람 홈을 모른다. 그때는 배치 설정이 사람 홈을 더 넘긴다.
export function assertWorkerRoot(root: string, homes: readonly string[] = [homedir()]): string {
  if (!isAbsolute(root)) throw new Denied();
  let real: string;
  try { real = realpathSync(root); } catch { throw new Denied(); }
  const bases = new Set<string>();
  for (const home of homes) {
    bases.add(resolve(home));
    try { bases.add(realpathSync(home)); } catch { /* 홈이 없으면 문자열 비교만 한다. */ }
  }
  for (const base of bases) {
    for (const candidate of [resolve(root), real]) {
      const rel = relative(base, candidate);
      // 루트가 홈이거나 홈의 조상이면 그 아래 개인 Codex 홈을 품는다.
      if (rel === '' || (!rel.startsWith('..') && rel.split(sep)[0]!.startsWith('.codex')) || !relative(candidate, base).startsWith('..')) throw new Denied();
    }
  }
  return real;
}
export function taskPaths(root: string, job: string): CodexPaths {
  if (!/^[0-9a-f-]{36}$/.test(job)) throw new Denied();
  const base = join(root, 'tasks', job);
  // run(출력·스키마)은 모델 셸이 쓸 수 있는 TMPDIR과 떼어 둔다. 같은 곳이면 셸이 최종 출력을 미리 써 둘 수 있다.
  return { job, root, home: join(base, 'codex-home'), taskHome: join(base, 'home'), workspace: join(base, 'workspace'),
    run: join(base, 'run'), tmp: join(base, 'tmp') };
}

export function codexConfig(paths: CodexPaths): CodexConfig {
  const set = { PATH: '/usr/local/bin:/usr/bin:/bin', HOME: paths.taskHome, LANG: 'C.UTF-8', TMPDIR: paths.tmp, [TASK_MARKER]: paths.job };
  assertShellSet(set, paths);
  return {
    sandbox_mode: 'workspace-write', approval_policy: 'never',
    sandbox_workspace_write: { network_access: false },
    // 기본값은 KEY·SECRET·TOKEN 이름 변수까지 모델이 띄우는 명령에 넘긴다 [확인: config-advanced, 2026-10-18].
    // inherit=none이면 exclude는 쓰이지 않지만, 누가 inherit을 바꿔도 이름 필터가 남게 둔다.
    shell_environment_policy: { inherit: 'none', ignore_default_excludes: false,
      exclude: ['*KEY*', '*SECRET*', '*TOKEN*', '*PASSWORD*', '*CREDENTIAL*', '*AUTH*', 'CODEX_*', 'OPENAI_*', 'GITHUB_*', 'DISCORD_*', 'KUBECONFIG', 'SSH_AUTH_SOCK'],
      set },
  };
}
function assertShellSet(set: Record<string, string>, paths: CodexPaths): void {
  for (const [name, value] of Object.entries(set)) {
    // 모델 셸에 CODEX_HOME 위치나 비밀 이름 변수를 알려 주지 않는다.
    if (SECRET_NAME.test(name) || name.startsWith('CODEX_') || value.includes(paths.home)) throw new Denied();
  }
}
const toml = (value: string | boolean) => typeof value === 'boolean' ? String(value) : JSON.stringify(value);
export function configToml(config: CodexConfig): string {
  const p = config.shell_environment_policy;
  return [
    '# homelab-bot이 작업마다 다시 쓴다. 사람이 고치지 않는다.',
    `sandbox_mode = ${toml(config.sandbox_mode)}`,
    `approval_policy = ${toml(config.approval_policy)}`,
    '', '[sandbox_workspace_write]',
    `network_access = ${toml(config.sandbox_workspace_write.network_access)}`,
    '', '[shell_environment_policy]',
    `inherit = ${toml(p.inherit)}`,
    `ignore_default_excludes = ${toml(p.ignore_default_excludes)}`,
    `exclude = [${p.exclude.map(toml).join(', ')}]`,
    `set = { ${Object.entries(p.set).map(([k, v]) => `${k} = ${toml(v)}`).join(', ')} }`,
    '',
  ].join('\n');
}

// codex 프로세스 자체의 환경. 작업자 프로세스 환경을 읽거나 병합하지 않고 허용 목록으로만 만든다.
// 작업자 환경에는 시드 auth.json(Infisical)이나 플랫폼이 넣은 값이 있을 수 있다.
export function launchEnvironment(paths: CodexPaths, proxy?: { https: string; noProxy: string }): Record<string, string> {
  const env: Record<string, string> = { PATH: '/usr/local/bin:/usr/bin:/bin', HOME: paths.taskHome, LANG: 'C.UTF-8',
    TMPDIR: paths.tmp, CODEX_HOME: paths.home, [TASK_MARKER]: paths.job };
  if (proxy) Object.assign(env, { HTTPS_PROXY: proxy.https, NO_PROXY: proxy.noProxy });
  return env;
}

// 답·작업 지시는 argv에 넣지 않고 stdin(`-`)으로 준다. `--`로 시작하는 답이 플래그가 되지 않게 하고
// 프로세스 목록에 남지 않게 한다 [가정: PROMPT `-`는 stdin, 0.163.0 `--help` 대조는 T16b].
export const FORBIDDEN_FLAGS = ['--dangerously-bypass-approvals-and-sandbox', '--approve-for-me', '--full-auto',
  '--ephemeral', '--ignore-user-config', '-a', '--ask-for-approval', '-s', '--sandbox', '-c', '--config', '--add-dir'];
export function execArgs(paths: CodexPaths, resume: string | null): string[] {
  const common = ['--json', '--output-schema', join(paths.run, 'output.schema.json'), '-o', join(paths.run, 'last-message.json')];
  // 스레드 ID가 '-'로 시작하면 CLI가 플래그로 읽는다.
  if (resume !== null && !/^[A-Za-z0-9][A-Za-z0-9-]{0,127}$/.test(resume)) throw new Denied();
  return resume === null ? ['exec', ...common, '-'] : ['exec', 'resume', ...common, resume, '-'];
}
