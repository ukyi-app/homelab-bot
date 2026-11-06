import { DEPLOY_TARGETS } from './catalog.js';
import type { DeployTarget } from './catalog.js';
import { ChangeStoreArtifacts } from './change-artifact.js';
import { ChangeAnswerGuard, ChangeCommands } from './change-commands.js';
import type { ChangeKey, ChangeTarget } from './change-contracts.js';
import { DeploymentReader } from './change-deployment.js';
import { compilePathPolicy, taskPathRules } from './change-policy.js';
import { ChangePublisher } from './change-publisher.js';
import { ChangeReviewService, HttpChangeReviewWorker } from './change-review.js';
import { ChangeRuntime, changeAuthorSource, changeRepositoryPolicies } from './change-runtime.js';
import type { ChangeRuntimeDeps } from './change-runtime.js';
import { ChangePrivateInputs, ChangeReviewFindings, ChangeStore } from './change-store.js';
import { VERIFIER_REVISION, WorkerChangeVerification } from './change-verifier.js';
import { ClaudeChangeAuthor } from './claude-task-bridge.js';
import type { ClaudeTaskBridge } from './claude-task-bridge.js';
import type { PublisherConfig } from './config.js';
import type { Scope } from './contracts.js';
import type { GitHubAppCredentials } from './github-app.js';
import { createGitHubWriter, policyWriterRepositories } from './github-writer.js';
import type { Log } from './log.js';
import type { Policy, PolicyGate } from './policy.js';
import { deploymentKubernetesReader, publicGithubReader } from './read-transports.js';
import type { KubernetesClient } from './read-transports.js';
import type { Store } from './store.js';
import type { TaskCommandHandler } from './task-commands.js';
import type { TaskV2WorkerPort } from './task-http.js';
import { TaskPolicySchema } from './task-policy.js';
import type { WorkerSigner } from './worker.js';

// 변경 PR의 정적 조건과 조립. 하나라도 어긋나면 CHANGE만 닫고 대화·작업·리뷰는 그대로 뜬다. 스위치가 꺼져 있으면 답 봉인(guardedTaskCommands) 말고는 이 파일의 어떤 객체도 만들어지지 않는다.

export type ChangeGateClosedReason = 'switch_off' | 'writer_key_missing' | 'policy_missing' | 'task_lane_closed' | 'review_closed' | 'task_policy_mismatch';
export type ChangePrecondition = { open: true; app: GitHubAppCredentials } | { open: false; reason: ChangeGateClosedReason };
// 같은 저장소의 작업 프로젝트가 있으면 허용 경로가 writer 정책을 내린 값과 같아야 한다. 다르면 작성자가 게시할 수 없는 경로를 고치거나 고칠 수 있는 경로를 모른다.
export function changeTaskPathsMatch(policy: Policy): boolean {
  const task = TaskPolicySchema.safeParse(policy.task);
  if (!task.success) return true;
  return (policy.change?.repositories ?? []).every(repository => {
    const compiled = compilePathPolicy(repository.allowedPaths, repository.deniedPaths);
    if (!compiled.ok) return false;
    const allowed = [...taskPathRules(compiled.policy).allowedPaths].sort();
    return task.data.projects.filter(project => project.repository === repository.fullName)
      .every(project => JSON.stringify([...project.allowedPaths].sort()) === JSON.stringify(allowed));
  });
}
export function changePrecondition(config: Pick<PublisherConfig, 'changePr' | 'policy'>, gates: { taskOpen: boolean; reviewOpen: boolean }): ChangePrecondition {
  if (!config.changePr) return { open: false, reason: 'switch_off' };
  if (!config.changePr.writerApp) return { open: false, reason: 'writer_key_missing' };
  if (!config.policy.change) return { open: false, reason: 'policy_missing' };
  if (!gates.taskOpen) return { open: false, reason: 'task_lane_closed' };
  if (!gates.reviewOpen) return { open: false, reason: 'review_closed' };
  if (!changeTaskPathsMatch(config.policy)) return { open: false, reason: 'task_policy_mismatch' };
  return { open: true, app: config.changePr.writerApp };
}
// 작업자에 이 경로가 있는가. capability 없는 POST라 실행·nonce 소모가 없다. 경로가 있으면 401, 옛 이미지는 404다.
export async function workerRouteAnswers(workerUrl: string, path: string, send: typeof fetch, signal: AbortSignal): Promise<boolean> {
  try {
    const response = await send(new URL(path, workerUrl).href, { method: 'POST', redirect: 'error', signal: AbortSignal.any([signal, AbortSignal.timeout(5000)]) });
    await response.body?.cancel().catch(() => {});
    return response.status === 401;
  } catch { return false; }
}

// 리뷰 서비스만 먼저 만든다. ReviewRuntime이 옵션으로 받아야 해서 나머지보다 앞선다.
export function assembleChangeReview(deps: { store: Store; gate: PolicyGate; signer: WorkerSigner; workerUrl: string; send: typeof fetch; now: () => number; shutdown: AbortSignal; drainMs?: number; log: Log }): { service: ChangeReviewService; changes: ChangeStore; findings: ChangeReviewFindings } {
  const changes = new ChangeStore(deps.store.db, deps.now);
  const findings = new ChangeReviewFindings(deps.store.db, deps.now);
  const service = new ChangeReviewService({ store: deps.store, changes, signer: deps.signer, worker: new HttpChangeReviewWorker(deps.workerUrl, deps.send), findings,
    shutdown: deps.shutdown, ...(deps.drainMs !== undefined ? { drainMs: deps.drainMs } : {}),
    async context() {
      const policy = await deps.gate.current();
      const repositories = policy.change?.repositories ?? [];
      return { policyRevision: policy.revision, repository: repoId => repositories.find(item => item.repoId === repoId)?.fullName ?? null, internalMarkers: repositories.flatMap(item => item.internalMarkers) };
    },
    // 모델 한도·인증 대기는 scheduler를 멈춘다. 리뷰 job에는 대화가 없어 부모의 스레드로 알린다.
    async notifyWaiting(job, reason) {
      const link = (await deps.store.db.query<{ change_id: string }>(`SELECT change_id FROM change_child_jobs WHERE job_id=$1 AND role='review'`, [job.id])).rows[0];
      const parent = link ? await changes.get(link.change_id) : null;
      if (!parent?.ok) { deps.log('change_review_wait_unnotified', { reason }); return; }
      const policy = await deps.gate.current();
      await deps.store.enqueue({ key: `change-review-wait:${job.id}:${job.attempt}`, conversation: parent.value.conversationId, actor: parent.value.ownerId, scope: parent.value.scope, revision: policy.revision,
        payload: { kind: 'message', channel: parent.value.scope.channel, classification: 'safe_summary',
          content: `변경 ${parent.value.id}의 리뷰가 ${reason === 'model_limit' ? '모델 사용 한도' : '인증 만료'}로 멈췄습니다. 대화·리뷰 모델 호출도 함께 멈춥니다. 원인을 해소한 뒤 알림 채널에서 /review-resume target:${job.id} 로 재개하세요.` } });
    } });
  return { service, changes, findings };
}

export interface ChangeAssemblyOptions {
  app: GitHubAppCredentials; store: Store; gate: PolicyGate; changes: ChangeStore; review: ChangeReviewService; bridge: ClaudeTaskBridge; worker: TaskV2WorkerPort;
  kubernetes: Pick<KubernetesClient, 'get'>; send: typeof fetch; now: () => number; log: Log; shutdown: AbortSignal; intakeOpen: () => boolean;
  // 시험 주입 자리. 스위치가 꺼졌을 때 writer를 만들지 않음을 이 함수로 센다.
  createWriter?: typeof createGitHubWriter; deployTargets?: readonly DeployTarget[];
  periods?: ChangeRuntimeDeps['periods']; verificationPollMs?: number;
  // 시험이 port 사이에 중단을 넣는 자리.
  instrument?: (deps: ChangeRuntimeDeps) => ChangeRuntimeDeps;
}
export interface ChangeAssembly { runtime: ChangeRuntime; author: ClaudeChangeAuthor; inputs: ChangePrivateInputs; publisher: ChangePublisher }
export function assembleChange(options: ChangeAssemblyOptions): ChangeAssembly {
  const { store, gate, changes, send, now, log } = options;
  const policy = changeRepositoryPolicies(gate);
  const authorize = (request: { ownerId: string; scope: Scope }) => gate.authorize(request.ownerId, request.scope);
  const authorizeWrite = async (target: ChangeTarget): Promise<void> => {
    const request = await changes.get(target.key.changeId);
    // 요청자를 모르면 권한을 말할 수 없다. 철회로 닫지 않고 writer가 보내지 않게만 한다.
    if (!request.ok || request.value.generation !== target.key.generation) throw new Error('change_request_unavailable');
    await authorize(request.value);
  };
  const io = (options.createWriter ?? createGitHubWriter)({ app: options.app, repositories: policyWriterRepositories(policy), authorizeWrite, send, now });
  const publisher = new ChangePublisher({ store: changes, writer: io.writer, preflight: io.preflight, policy, authorize, now, log });
  const artifacts = new ChangeStoreArtifacts(changes);
  const inputs = new ChangePrivateInputs(store.db, now);
  const source = changeAuthorSource({ store, gate, preflight: io.preflight, policy });
  const author = new ClaudeChangeAuthor({ bridge: options.bridge, store, gate, worker: options.worker, source, artifacts });
  const stopped = () => new Error('change_shutdown');
  // 긴 시험을 기다리는 중에도 종료 신호에 바로 깬다. 시험은 작업자에서 계속 돌고 재시작 뒤 같은 receipt를 받는다.
  const sleep = (ms: number) => new Promise<void>((resolve, reject) => {
    if (options.shutdown.aborted) { reject(stopped()); return; }
    const timer = setTimeout(() => { options.shutdown.removeEventListener('abort', onAbort); resolve(); }, ms);
    const onAbort = () => { clearTimeout(timer); reject(stopped()); };
    options.shutdown.addEventListener('abort', onAbort, { once: true });
  });
  const verification = new WorkerChangeVerification({ worker: author.verificationWorker(), control: (key: ChangeKey) => author.verificationControl(key), keepalive: (key: ChangeKey) => author.verificationKeepalive(key),
    imageRevision: 'publisher', sleep, ...(options.verificationPollMs !== undefined ? { pollMs: options.verificationPollMs } : {}) });
  const targets = options.deployTargets ?? DEPLOY_TARGETS;
  // 정책이 허용한 저장소만 답한다. 정책은 기동 때 한 번 읽어 고정이라 동기로 답할 수 있다.
  let services: { repoId: number; service: string }[] = [];
  const refreshServices = () => gate.current().then(current => {
    services = (current.change?.repositories ?? []).flatMap(repository => {
      const target = targets.find(item => item.repository === repository.fullName);
      return target && current.services.includes(target.service) ? [{ repoId: repository.repoId, service: target.service }] : [];
    });
  });
  void refreshServices().catch(() => {});
  const deployment = new DeploymentReader({ github: publicGithubReader({ send }), kubernetes: deploymentKubernetesReader(options.kubernetes), now, targets,
    resolveService: repoId => services.find(item => item.repoId === repoId)?.service ?? null });
  const runtimeDeps: ChangeRuntimeDeps = { store, changes, inputs, gate, author, artifacts, verification, review: options.review, publisher, preflight: io.preflight, deployment, policy,
    intakeOpen: options.intakeOpen, log, verifierRevision: VERIFIER_REVISION, ...(options.periods ? { periods: options.periods } : {}) };
  const runtime = new ChangeRuntime(options.instrument ? options.instrument(runtimeDeps) : runtimeDeps);
  return { runtime, author, inputs, publisher };
}

export function changeCommandHandler(deps: { store: Store; gate: PolicyGate; changes: ChangeStore; log: Log; closedReason: () => string | null; runtime?: ChangeRuntime }): ChangeCommands {
  const { runtime } = deps;
  return new ChangeCommands({ store: deps.store, changes: deps.changes, gate: deps.gate, log: deps.log, closedReason: deps.closedReason, ...(runtime ? { admit: request => runtime.admit(request) } : {}) });
}
export function guardedTaskCommands(inner: TaskCommandHandler, inputs: ChangePrivateInputs, gate: PolicyGate): TaskCommandHandler {
  return new ChangeAnswerGuard(inner, inputs, gate);
}
