import { z } from 'zod';
import { DEPLOYMENT_SETTLED_STATES, DeploymentObservationSchema, GitShaSchema } from './change-contracts.js';
import type { ChangeDeploymentPort, ChangeTarget, DeploymentObservation, MergeReading } from './change-contracts.js';
import { DEPLOY_TARGETS } from './catalog.js';
import type { AppDeployTarget, ConfigDeployTarget, DeployTarget } from './catalog.js';
import type { Clock } from './contracts.js';
import type { CompareStatus, DeployedValuesReading, DeploymentKubernetesReader, PublicGithubReader } from './read-transports.js';

// 사람이 병합한 뒤 H(PR head) → M(병합) → K(배포 설정 commit) → D(이미지 digest) → 실제 workload를 읽어 잇는다. 쓰기는 없다.
// 함정: Argo의 status.sync.revision은 K가 아니다. Application source의 targetRevision이 chart 태그이고 image.yaml은
// ApplicationSet이 helm.valuesObject로 넣는다(platform/appsets/apps). 그래서 K는 Argo가 비교한 values의 내용으로 대조한다.
// 같은 이유로 homelab main HEAD를 읽지 않는다. main에 다른 commit이 붙어도 image.yaml을 바꾼 commit과 내용만 본다.
// 한계: D가 정말 M에서 빌드됐는지는 다시 검증하지 않는다. image.yaml에 적힌 값이고 그 출처 검증은 deploy-merge 조건 5의 몫이다.

// Argo가 Git을 60초마다 읽어 그보다 자주 봐도 새 사실이 없다.
export const DEPLOYMENT_POLL = Object.freeze({ intervalMs: 60_000, initialWindowMs: 600_000 });
const READ_TIMEOUT_MS = 5000;
// commit SHA로 정해진 값만 기억한다. 프로세스 수명 동안 관측 대상이 몇 건뿐이라 작게 둔다.
const CACHE_LIMIT = 64;

export type DeploymentPollStep = 'settled' | 'poll' | 'report_late';
// 창이 지나면 멈춘 게 아니라 늦은 것이다. 끝 상태로 바꾸지 않고 마지막 pending·unknown과 관측 시각을 알린다.
export function deploymentPollStep(observation: DeploymentObservation, startedAt: number, now: number): DeploymentPollStep {
  if ((DEPLOYMENT_SETTLED_STATES as readonly string[]).includes(observation.state)) return 'settled';
  return now - startedAt >= DEPLOYMENT_POLL.initialWindowMs ? 'report_late' : 'poll';
}

// readMerge가 답할 수 없는 경우다. MergeReading에 unknown이 없어 값으로 낼 수 없고, 호출자는 병합 여부를 모르는 것으로 다룬다.
export class DeploymentTargetError extends Error {
  constructor(readonly code: string) { super(code); this.name = 'DeploymentTargetError'; }
}

interface ImageConfig { repository: string; digest: string; revision: string; hold: boolean }
const DIGEST = /^sha256:[0-9a-f]{64}$/;
const SHA = /^[0-9a-f]{40}$/;
// app-build의 read_image와 같은 형식이다. 네 키가 한 줄씩이고 나머지는 주석·빈 줄뿐이다.
function parseImageConfig(text: string): ImageConfig | null {
  const fields = new Map<string, string>();
  for (const line of text.split('\n')) {
    if (/^\s*(#.*)?$/.test(line)) continue;
    const match = /^(repository|digest|revision|hold): (.*)$/.exec(line);
    if (!match || fields.has(match[1]!)) return null;
    fields.set(match[1]!, match[2]!);
  }
  const repository = fields.get('repository'), digest = fields.get('digest'), revision = fields.get('revision'), hold = fields.get('hold');
  if (!repository || !digest || !DIGEST.test(digest) || !revision || !SHA.test(revision) || (hold !== 'true' && hold !== 'false')) return null;
  return { repository, digest, revision, hold: hold === 'true' };
}

type ReadSource = 'github' | 'kubernetes';
// 원문을 사유로 내지 않는다. 사유 코드만 공개 경로로 간다.
function readFailure(source: ReadSource, error: unknown): string {
  if (error instanceof z.ZodError || error instanceof SyntaxError) return `${source}_response_invalid`;
  const message = error instanceof Error ? error.message : '';
  if (message === 'read_http_401' || message === 'read_http_403' || message === 'read_http_429') return `${source}_refused`;
  if (message === 'unexpected_object' || message === 'response_limit' || message === 'response_empty') return `${source}_response_invalid`;
  return `${source}_unavailable`;
}
const isNotFound = (error: unknown) => error instanceof Error && error.message === 'read_http_404';
const sameValues = (values: DeployedValuesReading | null, config: ImageConfig) =>
  values !== null && values.repository === config.repository && values.digest === config.digest && values.revision === config.revision;
const remember = <V>(cache: Map<string, V>, key: string, value: V) => {
  if (cache.size >= CACHE_LIMIT) cache.clear();
  cache.set(key, value);
};
const underPrefixes = (path: string, prefixes: readonly string[]) => !path.split('/').includes('..') && prefixes.some(prefix => path.startsWith(prefix));

export interface DeploymentReaderOptions {
  github: PublicGithubReader;
  kubernetes: DeploymentKubernetesReader;
  // 저장소 ID → 서비스 이름. 숫자 ID는 정책에 있고 저장소에 두지 않는다. 조립할 때 정책이 허용한 저장소만 답한다.
  resolveService: (repoId: number) => string | null;
  targets?: readonly DeployTarget[];
  now?: Clock;
  timeoutMs?: number;
}

export class DeploymentReader implements ChangeDeploymentPort {
  private readonly targets: Map<string, DeployTarget>;
  private readonly now: Clock;
  private readonly timeoutMs: number;
  private readonly configs = new Map<string, string>();
  private readonly compares = new Map<string, CompareStatus>();
  constructor(private readonly options: DeploymentReaderOptions) {
    this.targets = new Map((options.targets ?? DEPLOY_TARGETS).map(target => [target.service, target]));
    this.now = options.now ?? Date.now;
    this.timeoutMs = options.timeoutMs ?? READ_TIMEOUT_MS;
  }
  private signal() { return AbortSignal.timeout(this.timeoutMs); }
  private target(repoId: number): DeployTarget | null {
    const service = this.options.resolveService(repoId);
    return service === null ? null : this.targets.get(service) ?? null;
  }

  // 답하지 못하면 던진다. 조회 실패를 미병합으로 바꾸면 병합된 PR이 닫힌 것으로 보인다.
  async readMerge(input: { target: ChangeTarget; prNumber: number }): Promise<MergeReading> {
    const target = this.target(input.target.repoId);
    if (!target) throw new DeploymentTargetError('deployment_target_unregistered');
    const pull = await this.options.github.pull(target.repository, input.prNumber, this.signal());
    if (pull.number !== input.prNumber) throw new DeploymentTargetError('pull_number_mismatch');
    if (pull.baseRepoId !== input.target.repoId || pull.baseRepository !== target.repository) throw new DeploymentTargetError('pull_repository_mismatch');
    if (pull.merged) {
      if (!pull.mergeCommit) throw new DeploymentTargetError('merge_commit_missing');
      return { state: 'merged', prNumber: pull.number, headSha: pull.headSha, mergeCommit: pull.mergeCommit };
    }
    return pull.state === 'open' ? { state: 'open' } : { state: 'closed_unmerged' };
  }

  // 읽기 실패로 던지지 않는다. 호출자는 항상 관측 시각이 있는 값을 받는다.
  async observe(input: { target: ChangeTarget; headSha: string; mergeCommit: string }): Promise<DeploymentObservation> {
    const headSha = GitShaSchema.parse(input.headSha), mergeCommit = GitShaSchema.parse(input.mergeCommit);
    const base: DeploymentObservation = { state: 'unknown', headSha, mergeCommit, configCommit: null, imageDigest: null,
      argoObservedAt: null, workloadObservedAt: null, observedAt: this.now(), reason: null };
    const target = this.target(input.target.repoId);
    const finding = !target ? { state: 'blocked' as const, reason: 'deployment_target_unregistered' }
      : target.kind === 'config' ? await this.observeConfigChange(target, headSha, mergeCommit)
      : await this.observeApp(target, mergeCommit);
    return DeploymentObservationSchema.parse({ ...base, ...finding, observedAt: this.now() });
  }

  // 근거 없이 해당 없음으로 닫지 않는다. PR 파일을 끝까지 읽었고 전부 배포 영향 없는 경로일 때만이다.
  // 파일 목록은 M이 아니라 PR에서 읽는다. rebase 병합이면 M 하나의 diff는 PR 일부뿐이다.
  private async observeConfigChange(target: ConfigDeployTarget, headSha: string, mergeCommit: string): Promise<Partial<DeploymentObservation>> {
    try {
      const pulls = await this.options.github.commitPulls(target.repository, mergeCommit, this.signal());
      const pull = pulls.find(item => item.mergeCommit === mergeCommit && item.headSha === headSha);
      if (!pull) return { state: 'unknown', reason: 'merged_pull_not_found' };
      const changed = await this.options.github.pullFiles(target.repository, pull.number, this.signal());
      if (!changed.complete) return { state: 'unknown', reason: 'changed_files_incomplete' };
      const inside = changed.files.every(file => underPrefixes(file.path, target.noDeployPrefixes)
        && (file.previousPath === null || underPrefixes(file.previousPath, target.noDeployPrefixes)));
      return inside ? { state: 'not_applicable', reason: 'docs_only' } : { state: 'blocked', reason: 'config_change_outside_docs' };
    } catch (error) {
      return { state: 'unknown', reason: readFailure('github', error) };
    }
  }

  private async observeApp(target: AppDeployTarget, mergeCommit: string): Promise<Partial<DeploymentObservation>> {
    let configCommit: string | null;
    let config: ImageConfig | null;
    try {
      configCommit = await this.options.github.latestFileCommit(target.configRepository, target.imageFile, 'main', this.signal());
      if (configCommit === null) return { state: 'blocked', reason: 'deploy_config_unregistered' };
      const text = await this.readConfigText(target, configCommit);
      if (text === null) return { state: 'blocked', reason: 'deploy_config_unregistered' };
      config = parseImageConfig(text);
    } catch (error) {
      return { state: 'unknown', reason: readFailure('github', error) };
    }
    if (!config) return { state: 'blocked', reason: 'image_config_invalid' };
    if (config.repository !== target.imageRepository) return { state: 'blocked', reason: 'image_repository_mismatch' };
    // 여기까지 M이 아니면 K·D를 채우지 않는다. 다른 revision의 값을 M의 것으로 기록하게 된다.
    if (config.revision !== mergeCommit) return this.classifyOtherRevision(target, config, mergeCommit);
    const evidence = { configCommit, imageDigest: config.digest };
    const argo = await this.readArgo(target, config);
    if (argo.state) return { ...evidence, ...argo };
    const workload = await this.readWorkload(target, config);
    return { ...evidence, argoObservedAt: argo.argoObservedAt, ...workload };
  }

  private async readConfigText(target: AppDeployTarget, commit: string): Promise<string | null> {
    // 한 commit이 여러 앱의 image.yaml을 바꿀 수 있어 파일까지 키에 넣는다.
    const key = `${target.imageFile}@${commit}`;
    const known = this.configs.get(key);
    if (known !== undefined) return known;
    const text = await this.options.github.fileAt(target.configRepository, target.imageFile, commit, this.signal());
    if (text !== null) remember(this.configs, key, text);
    return text;
  }

  private async classifyOtherRevision(target: AppDeployTarget, config: ImageConfig, mergeCommit: string): Promise<Partial<DeploymentObservation>> {
    if (config.hold) return { state: 'blocked', reason: 'image_hold' };
    const key = `${target.repository}:${mergeCommit}...${config.revision}`;
    let status: CompareStatus | null | undefined = this.compares.get(key);
    try {
      if (status === undefined) {
        status = await this.options.github.compare(target.repository, mergeCommit, config.revision, this.signal());
        if (status !== null) remember(this.compares, key, status);
      }
    } catch (error) {
      return { state: 'unknown', reason: readFailure('github', error) };
    }
    // M 빌드가 아직 안 왔다. 더 새 revision이면 M의 이미지를 이 경로로 관측할 길이 없어 더 기다리지 않는다.
    if (status === 'behind') return { state: 'pending', reason: 'image_revision_behind' };
    if (status === 'ahead') return { state: 'blocked', reason: 'image_revision_superseded' };
    return { state: 'blocked', reason: 'image_revision_unrelated' };
  }

  private async readArgo(target: AppDeployTarget, config: ImageConfig): Promise<Partial<DeploymentObservation>> {
    try {
      const application = await this.options.kubernetes.application(target.argoApplication, this.signal());
      const pending = (reason: string) => ({ state: 'pending' as const, reason, argoObservedAt: this.now() });
      if (!sameValues(application.desired, config)) return pending('argo_config_stale');
      if (!sameValues(application.compared, config)) return pending('argo_compare_stale');
      if (application.operationPhase === 'Running' || application.operationPhase === 'Terminating') return pending('argo_sync_running');
      if (application.operationPhase === 'Failed' || application.operationPhase === 'Error') return pending('argo_sync_failed');
      if (application.syncStatus !== 'Synced') return pending('argo_out_of_sync');
      return { argoObservedAt: this.now() };
    } catch (error) {
      if (isNotFound(error)) return { state: 'pending', reason: 'argo_application_missing' };
      return { state: 'unknown', reason: readFailure('kubernetes', error) };
    }
  }

  private async readWorkload(target: AppDeployTarget, config: ImageConfig): Promise<Partial<DeploymentObservation>> {
    const pending = (reason: string, observedAt: number) => ({ state: 'pending' as const, reason, workloadObservedAt: observedAt });
    try {
      const workload = await this.options.kubernetes.workload(target.namespace, target.deployment, target.container, this.signal());
      const observedAt = this.now();
      if (workload.image !== `${config.repository}@${config.digest}`) return pending('workload_image_mismatch', observedAt);
      // 컨트롤러가 최신 spec을 보기 전의 replica 수는 이전 세대 기준이다.
      if (workload.generation === null || workload.observedGeneration === null || workload.observedGeneration < workload.generation) return pending('workload_generation_stale', observedAt);
      // suspended(복원 중)면 replica 0이다. 0개가 모두 준비됐다고 배포를 확인한 것으로 보지 않는다.
      if (workload.replicas < 1) return pending('workload_suspended', observedAt);
      if (workload.ready < workload.replicas || workload.available < workload.replicas || workload.updated < workload.replicas) return pending('workload_unready', observedAt);
      const pods = await this.options.kubernetes.pods(target.namespace, target.podApp, target.container, this.signal());
      const podsAt = this.now();
      if (pods.length < workload.replicas) return pending('pod_missing', podsAt);
      if (pods.some(pod => pod.terminating)) return pending('pod_terminating', podsAt);
      if (pods.some(pod => pod.imageId === null || !pod.imageId.endsWith(`@${config.digest}`))) return pending('pod_image_mismatch', podsAt);
      if (pods.some(pod => !pod.ready)) return pending('pod_unready', podsAt);
      return { state: 'observed', reason: null, workloadObservedAt: podsAt };
    } catch (error) {
      if (isNotFound(error)) return { state: 'pending', reason: 'workload_missing' };
      return { state: 'unknown', reason: readFailure('kubernetes', error) };
    }
  }
}

const shown = (value: string | null) => value ?? '미확인';
const timeOf = (at: number | null) => at === null ? '미확인' : new Date(at).toISOString();
const STATE_TEXT: Readonly<Record<DeploymentObservation['state'], string>> = Object.freeze({
  observed: '기록된 버전이 image.yaml·Argo·workload에서 일치한다',
  pending: '아직 일치를 확인하지 못했다. 기다리는 중이다',
  unknown: '읽지 못해 미확인이다',
  blocked: '이 경로로는 연결을 확인할 수 없다. 사람이 볼 일이다',
  not_applicable: '배포 영향이 없는 변경이다. 배포를 읽지 않았다',
});
// 사람이 읽는 상태 문구다. 이 관측은 버전 일치만 말하므로 범위 문장을 늘 함께 낸다.
export function describeDeployment(observation: DeploymentObservation): string {
  return [
    `배포 관측: ${observation.state}. ${STATE_TEXT[observation.state]}.`,
    ...(observation.reason ? [`사유: ${observation.reason}`] : []),
    `PR head H: ${observation.headSha}`,
    `병합 M: ${observation.mergeCommit}`,
    `배포 설정 K: ${shown(observation.configCommit)}`,
    `이미지 D: ${shown(observation.imageDigest)}`,
    `관측 시각: ${timeOf(observation.observedAt)} (Argo ${timeOf(observation.argoObservedAt)}, workload ${timeOf(observation.workloadObservedAt)})`,
    '범위: 배포된 버전만 읽었다. 기능·DB·성능은 확인하지 않았다.',
  ].join('\n');
}
