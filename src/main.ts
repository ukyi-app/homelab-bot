import { pathToFileURL } from 'node:url';
import { setTimeout as sleep } from 'node:timers/promises';
import type { Server } from 'node:http';
import pg from 'pg';
import { AlertIngress } from './alerts.js';
import { BriefingScheduler } from './briefing.js';
import type { ObservationSource } from './briefing.js';
import { briefingSources } from './briefing-observations.js';
import { ARGOCD_APPLICATIONS, GRAFANA_DATASOURCES, SERVICES, TEMPLATES } from './catalog.js';
import { ClaudeTaskBridge } from './claude-task-bridge.js';
import { assembleChange, assembleChangeReview, changeCommandHandler, changePrecondition, guardedTaskCommands, workerRouteAnswers } from './change-assembly.js';
import type { ChangeAssemblyOptions } from './change-assembly.js';
import { CHANGE_PERIODS } from './change-runtime.js';
import { ChangePrivateInputs, ChangeStore, purgeExpiredChangeContentRounds } from './change-store.js';
import { CHANGE_COMMANDS, EXTERNAL_TASK_COMMANDS, FOUNDATION_COMMANDS, MEMORY_COMMANDS, REVIEW_COMMANDS, TASK_COMMANDS, commandDefinitions, registerCommands } from './commands.js';
import { ConfigError, databasePoolConfig, loadPublisherConfig } from './config.js';
import type { PublisherConfig } from './config.js';
import { z } from 'zod';
import { Denied, DiscordRejected, RateLimited } from './contracts.js';
import type { Clock, Scope } from './contracts.js';
import { MIGRATIONS, Postgres, appliedMigrations, migrationVersion } from './database.js';
import { withConnectRetry } from './db-connect.js';
import type { Database } from './database.js';
import { FileDeletionLedger, LedgerError } from './deletion-ledger.js';
import type { DeletionLedger, LedgerStatus } from './deletion-ledger.js';
import { DiscordIngress, DiscordPublisher } from './discord.js';
import { githubDocuments } from './document-source.js';
import { DiscordProtocol, discordHttpApi } from './discord-protocol.js';
import type { DiscordApi } from './discord-protocol.js';
import { ExternalTaskCommands } from './external-task-commands.js';
import { ExternalTaskLinks } from './external-task-links.js';
import { ExternalTaskReceiver, externalTaskServer } from './external-task-receiver.js';
import { GatewaySession, discordGatewayUrl } from './gateway.js';
import type { GatewaySocket } from './gateway.js';
import { GatewayBudget, Health } from './health.js';
import { typingActivity } from './activity.js';
import { typingHints } from './typing.js';
import { advisoryLedgerLock, lockClient } from './ledger-lock.js';
import { MemoryService } from './memory.js';
import type { DocumentSource } from './memory.js';
import { MemoryCommands } from './memory-commands.js';
import type { TaskGateClosedReason } from './ops-metrics.js';
import { PORTS, receivers } from './http.js';
import { errorInfo, jsonLog } from './log.js';
import type { Log } from './log.js';
import { PolicyGate } from './policy.js';
import { ReadAdapter } from './read.js';
import { SERVICE_ACCOUNT, grafanaTransport, kubernetesTransport, routedTransport } from './read-transports.js';
import { githubReviewIO, policyRepositories } from './github-review-io.js';
import type { GitHubAppCredentials } from './github-app.js';
import { GitHubIngress, RestrictedGitHub, ReviewDisabled, ReviewPolicySchema, ReviewPolicySource, ReviewPublisher, ReviewQueue,
  ReviewReconciler, ReviewRuntime, githubWebhook } from './review.js';
import type { GitHubReader, ReviewContext, ReviewPolicy } from './review.js';
import { HttpReviewWorker } from './review-http.js';
import { RAW_TEXT_PURGE_EVERY_MS, purgeExpiredRawText } from './raw-text-retention.js';
import { RecoveryScheduler } from './recovery.js';
import { Runtime } from './runtime.js';
import { Store } from './store.js';
import { TASK_ANSWER_PURGE_EVERY_MS, purgeExpiredTaskAnswers } from './task-bridge.js';
import { TaskCommands } from './task-commands.js';
import { TaskWorkerSigner } from './task-contracts.js';
import { HttpTaskV2Worker, HttpTaskWorker, TASK_INTAKE_UNREACHED, taskWorkerChangeContract, taskWorkerIntake } from './task-http.js';
import type { TaskIntakeStatus } from './task-http.js';
import { PolicyTaskPlans, TaskPolicySchema } from './task-policy.js';
import { WorkerSigner } from './worker.js';
import { HttpWorker } from './worker-http.js';

// 게시 서버 진입점. 이미지 기본 CMD는 node dist/src/main.js다. 마이그레이션은 src/migrate-main.ts(차트 migration.command).
// 리뷰는 네 조건이 모두 맞을 때만 열고, 아니면 /github을 리뷰 비활성으로만 받는다(D6).
// 작업 레인은 스위치·주소·유효한 task 절이 있을 때만 조립하고, 작업 모드 작업자가 답할 때 명령을 연다. 조립하지 않으면 명령·루프·HTTP 클라이언트가 모두 없다.
// 기억·브리핑은 MEMORY_LEDGER_DIR이 있을 때만 만들고 기동 장벽·주기 루프까지 잇는다. 기억 명령(memory-*)도 그때만 등록·수신한다.
// R08은 EXTERNAL_TASK_EVENTS_ENABLED가 켜졌을 때만 리스너(8082)·명령·루프·지표를 만든다. 작업 레인 스위치와 독립이다.
// 변경 PR은 CHANGE_PR_ENABLED가 true일 때만 명령을 등록하고, 키·정책·작업 레인·리뷰가 모두 있을 때만 writer와 루프를 만든다. 작업자가 v2로 답하기 전에는 접수만 닫힌다.

// 닫혀 있으면 정책 JSON에 리뷰 절이 있어도 리뷰 경로를 열지 않는다. 기본 정책을 못 읽으면 503(PolicyUnavailable)이다.
class GatedReviewPolicy extends ReviewPolicySource {
  constructor(private readonly base: PolicyGate, private readonly opened: () => boolean) { super(base); }
  override async current(): Promise<ReviewContext> {
    if (this.opened()) return super.current();
    await this.base.current();
    throw new ReviewDisabled();
  }
}
// 기동 때 정해지는 세 조건: (a) 스위치 (b) App 자격 (c) 유효한 review 절(comparison null 아님). 정책 변경은 재시작으로만 반영된다.
// publish:null은 닫는 조건이 아니다. 모델은 부르고 게시만 막힌다(publish_limits_unset). 준비 단계는 스위치로 닫는다.
export type ReviewPrecondition = { open: true; app: GitHubAppCredentials; review: ReviewPolicy }
  | { open: false; reason: 'switch_off' | 'app_missing' | 'policy_invalid' };
export function reviewPrecondition(config: Pick<PublisherConfig, 'reviewEnabled' | 'githubReviewApp' | 'policy'>): ReviewPrecondition {
  if (!config.reviewEnabled) return { open: false, reason: 'switch_off' };
  if (!config.githubReviewApp) return { open: false, reason: 'app_missing' };
  const review = ReviewPolicySchema.safeParse(config.policy.review);
  if (!review.success || review.data.comparison === null) return { open: false, reason: 'policy_invalid' };
  return { open: true, app: config.githubReviewApp, review: review.data };
}
// 작업 레인의 정적 조건. 하나라도 어긋나면 작업 레인만 닫고 대화·리뷰는 그대로 뜬다. 정책 변경은 재시작으로만 반영된다.
export type TaskPrecondition = { open: true; workerUrl: string } | { open: false; reason: TaskGateClosedReason };
export function taskPrecondition(config: Pick<PublisherConfig, 'taskLane' | 'policy'>): TaskPrecondition {
  if (!config.taskLane) return { open: false, reason: 'switch_off' };
  if (!TaskPolicySchema.safeParse(config.policy.task).success) return { open: false, reason: 'policy_invalid' };
  return { open: true, workerUrl: config.taskLane.workerUrl };
}
// (d) 작업자에 리뷰 경로가 있는가. capability 없는 POST라 실행·nonce 소모가 없다. 경로가 있으면 401, 옛 이미지는 404다.
// 옛 이미지에 리뷰를 보내면 404가 응답 불명으로 처리돼 전역 슬롯을 잡는 unknown이 되므로 먼저 확인한다.
export async function reviewWorkerRouted(workerUrl: string, send: typeof fetch, signal: AbortSignal): Promise<boolean> {
  try {
    const response = await send(new URL('/v1/review', workerUrl).href, { method: 'POST', redirect: 'error',
      signal: AbortSignal.any([signal, AbortSignal.timeout(5000)]) });
    await response.body?.cancel().catch(() => {});
    return response.status === 401;
  } catch { return false; }
}
const MessageChannel = z.object({ channel_id: z.string().min(1) });
export type ManagedLedger = DeletionLedger & { status(): LedgerStatus; close(): Promise<void> };
const T20_PERIODS = { briefingTickMs: 30_000, memoryResumeMs: 60_000, ledgerReopenMs: 60_000 };
// 재조정 주기. PR 재조정은 열린 PR마다 compare를 한 번 부르므로 길게 두고(webhook이 주 경로), 게시 대조는 응답 유실 행만 본다.
const REVIEW_PERIODS = { workerProbeMs: 30_000, deliveryReconcileMs: 60_000, pullRequestReconcileMs: 900_000 };
const TASK_WORKER_PROBE_MS = 30_000;
// 재개 예약 루프(Store.resumeDue) 주기. 재개 시각은 분 단위라 15초 늦어도 "풀리는 시각 1분 뒤"·"30분 안에"를 지킨다.
const MODEL_RESUME_TICK_MS = 15_000;
// 중복 방지 ID의 보관 기한은 7일이라 정리는 드물어도 된다.
const EXTERNAL_PURGE_MS = 3_600_000;
const closedReader: GitHubReader = {
  pullRequest: async () => { throw new Error('review_disabled'); },
  openPullRequests: async () => { throw new Error('review_disabled'); },
  compare: async () => { throw new Error('review_disabled'); },
  mergeBase: async () => { throw new Error('review_disabled'); },
  reviews: async () => { throw new Error('review_disabled'); },
};

export interface PublisherDeps {
  db: Database;
  now?: Clock;
  log?: Log;
  send?: typeof fetch;
  discord?: DiscordApi;
  gatewayUrl?: () => Promise<{ url: string; retryAfterMs?: number }>;
  connect?: (url: string) => GatewaySocket;
  allowGatewayUrl?: (url: URL) => boolean;
  serviceAccount?: { tokenFile: string; caFile: string | null };
  ports?: { app: number; alerts: number; externalEvents?: number };
  idleMs?: number;
  heartbeatEveryMs?: number;
  reconcileEveryMs?: number;
  stopTimeoutMs?: number;
  drainMs?: number;
  registerDelaysMs?: readonly number[];
  recoveryBackoff?: (attempt: number) => number;
  identifySpacingMs?: number;
  // config.memory가 있을 때만 쓴다. 시험이 원장(임시 디렉터리·잠금)·관측 원본·주기를 바꿀 때만 준다.
  ledger?: ManagedLedger;
  documents?: DocumentSource;
  observations?: ObservationSource[];
  briefingTickMs?: number;
  memoryResumeMs?: number;
  ledgerReopenMs?: number;
  t20Backoff?: (attempt: number) => number;
  // 리뷰 주기. 시험만 바꾼다.
  reviewWorkerProbeMs?: number;
  reviewDeliveryReconcileMs?: number;
  reviewPullRequestReconcileMs?: number;
  // 작업 레인 작업자 확인 주기. 시험만 바꾼다.
  taskWorkerProbeMs?: number;
  // 재개 예약 루프 주기. 시험만 바꾼다.
  modelResumeTickMs?: number;
  // R08 보관 정리 주기. 시험만 바꾼다.
  externalPurgeMs?: number;
  // 변경 PR 조립의 시험 주입 자리. 켜져 있을 때만 쓴다.
  change?: Pick<ChangeAssemblyOptions, 'createWriter' | 'deployTargets' | 'periods' | 'verificationPollMs' | 'instrument'>;
}
export interface Publisher {
  // externalEvents는 R08을 켰을 때만 있다.
  health: Health; gateway: GatewaySession; ports: { app: number; alerts: number; externalEvents?: number };
  stop(): Promise<void>;
}
const listen = (server: Server, port: number) => new Promise<number>((resolve, reject) => {
  server.once('error', reject);
  server.listen(port, () => { server.off('error', reject); resolve((server.address() as { port: number }).port); });
});
const closeServer = async (server: Server, timeoutMs: number) => {
  const closed = new Promise<void>(resolve => server.close(() => resolve()));
  server.closeIdleConnections();
  await Promise.race([closed, sleep(timeoutMs)]);
  server.closeAllConnections();
};

export async function startPublisher(config: PublisherConfig, deps: PublisherDeps): Promise<Publisher> {
  const now = deps.now ?? Date.now;
  const log = deps.log ?? jsonLog;
  const send = deps.send ?? fetch;
  const stop = new AbortController();
  const pause = (ms: number) => sleep(ms, undefined, { signal: stop.signal }).catch(() => {});
  const store = new Store(deps.db, now, config.colleagueEnabled === true);
  const gate = PolicyGate.fixed(config.policy, deps.db, now);
  const health = new Health(store, async () => {
    // healthchecks.io ping. URL은 비밀(체크 UUID)이라 오류에도 남기지 않는다.
    const response = await send(config.healthchecksUrl, { method: 'GET', redirect: 'error', signal: AbortSignal.timeout(10_000) });
    await response.body?.cancel().catch(() => {});
    if (!response.ok) throw new Error(`heartbeat_http_${response.status}`);
  });
  const kubernetes = kubernetesTransport({ base: config.kubernetes.url, tokenFile: deps.serviceAccount?.tokenFile ?? SERVICE_ACCOUNT.token,
    caFile: deps.serviceAccount ? deps.serviceAccount.caFile : SERVICE_ACCOUNT.ca, applications: ARGOCD_APPLICATIONS, send });
  const grafana = grafanaTransport({ base: config.grafana.url, token: config.grafana.token, datasources: GRAFANA_DATASOURCES, send });
  // Argo CD 앱 상태도 Kubernetes API의 Application CR로 읽는다(D9). argocd-server(자체 서명 TLS)에는 닿지 않는다.
  const reader = new ReadAdapter([...SERVICES], [...TEMPLATES], gate, routedTransport({ kubernetes, argocd: kubernetes,
    victoriametrics: grafana, victorialogs: grafana }), now);
  // stop 신호가 곧 runtime의 종료 신호다. 새 claim을 멈추고 실행 중 작업의 드레인·취소 확인을 바로 시작한다.
  const signer = new WorkerSigner(config.workerKey, now);
  // 객체는 만들기만 한다(I/O 없음). 작업자가 답하기 전에는 명령이 닫혀 있고 루프는 첫 READY 장벽 뒤에 돈다.
  const taskGate = taskPrecondition(config);
  log('task_gate', taskGate.open ? { state: 'waiting_worker' } : { state: 'closed', reason: taskGate.reason });
  health.watchTaskGate(() => taskGate.open ? null : taskGate.reason);
  // 변경 PR. 스위치가 꺼져 있으면 writer·리뷰 서비스·명령·루프를 만들지 않는다.
  const reviewGate = reviewPrecondition(config);
  const changeGate = changePrecondition(config, { taskOpen: taskGate.open, reviewOpen: reviewGate.open });
  log('change_gate', changeGate.open ? { state: 'waiting_worker' } : { state: 'closed', reason: changeGate.reason });
  const taskSigner = taskGate.open ? new TaskWorkerSigner(config.workerKey, now) : undefined;
  // 호출은 v2 세션이 있을 때만 나간다. 스위치를 끄고 되돌릴 때 남은 작성 세션을 /task-release로 정리하려면 이 경로가 있어야 한다. 없으면 레인이 cleanup_pending으로 닫힌 채 남는다.
  const changeWorker = taskGate.open ? new HttpTaskV2Worker(taskGate.workerUrl, taskSigner!, send) : undefined;
  const taskBridge = taskGate.open ? new ClaudeTaskBridge(store, gate, new HttpTaskWorker(taskGate.workerUrl, taskSigner!, send),
    new PolicyTaskPlans(store, send),
    // undefined를 그대로 넘기면 브리지 기본값을 덮어 드레인 없이 바로 끊는다.
    { shutdown: stop.signal, ...(deps.drainMs !== undefined ? { drainMs: deps.drainMs } : {}) }, changeWorker) : undefined;
  // taskLoop와 lanes는 함께 켠다. 하나만 켜면 해제 문구와 실제 슬롯이 어긋난다.
  const taskLoop = !!taskBridge;
  const runtime = new Runtime(store, gate, new HttpWorker(config.workerUrl, send), signer, reader,
    taskBridge, { shutdown: stop.signal, drainMs: deps.drainMs, taskLoop, externalTask: !!config.externalTask });
  const changeReview = changeGate.open ? assembleChangeReview({ store, gate, signer, workerUrl: config.workerUrl, send, now, shutdown: stop.signal, log, ...(deps.drainMs !== undefined ? { drainMs: deps.drainMs } : {}) }) : undefined;
  // 객체는 만들기만 한다(I/O 없음). 조건 (d)를 확인하기 전에는 reviewOpened가 false라 webhook·명령이 닫힌 그대로다.
  const precondition = reviewGate;
  let reviewOpened = false;
  const reviewPolicy = new GatedReviewPolicy(gate, () => reviewOpened);
  const review = precondition.open ? (() => {
    const io = githubReviewIO({ app: precondition.app, repositories: policyRepositories(reviewPolicy, store), send, now, requests: { store, policy: reviewPolicy } });
    const queue = new ReviewQueue(store, io.reader);
    return { queue, reader: io.reader, guidance: io.guidance,
      runtime: new ReviewRuntime(store, reviewPolicy, queue, io.reader, new HttpReviewWorker(config.workerUrl, send), signer, undefined,
        { shutdown: stop.signal, drainMs: deps.drainMs, lanes: taskLoop, ...(changeReview ? { changeReview: changeReview.service } : {}) }),
      publisher: new ReviewPublisher(store, reviewPolicy, io.reader, new RestrictedGitHub(io.transport), queue, undefined, stop.signal),
      reconciler: new ReviewReconciler(store, reviewPolicy, queue, io.reader, stop.signal) };
  })() : undefined;
  // 둘 다 정책상 유효하지만 위험한 값이다. publish null은 모델만 쓰고 게시가 막히고, reviewSince 0은 열린 PR 전체가 재조정 대상이다.
  log('review_gate', precondition.open
    ? { state: 'waiting_worker', publishLimitsSet: precondition.review.publish !== null, reviewSinceSet: precondition.review.reviewSince > 0 }
    : { state: 'closed', reason: precondition.reason });
  const github = new GitHubIngress(config.githubWebhookSecret, store, reviewPolicy, review?.queue ?? new ReviewQueue(store, closedReader),
    review?.reader ?? closedReader);
  const servers = receivers(health, new AlertIngress(store, gate), { github: githubWebhook(github) });
  // 객체는 만들기만 한다(I/O 없음). 수신 판정은 요청마다 복원 울타리·서명·현재 owner 권한을 본다.
  const external = config.externalTask ? (() => {
    const { environment, restoreEpoch } = config.externalTask;
    const links = new ExternalTaskLinks(store, restoreEpoch === undefined ? {} : { restoreEpoch });
    const receiver = new ExternalTaskReceiver({ store, links, environment, log,
      authorize: (owner, scope, db) => gate.withDatabase(db).authorize(owner, scope) });
    return { links, receiver, server: externalTaskServer(receiver), commands: new ExternalTaskCommands(links, environment, log) };
  })() : undefined;
  log('external_task_gate', external ? { state: 'open' } : { state: 'closed', reason: 'switch_off' });
  if (external) health.watchExternalTasks(() => external.receiver.metrics());
  // 기억·브리핑 객체는 만들기만 한다(I/O 없음). 원장 잠금 연결·파일은 첫 READY의 기동 장벽에서 연다.
  // 잠금은 풀과 다른 전용 연결이다. 풀은 연결을 돌려쓰거나 닫아 세션 잠금이 유지되지 않는다(ledger-lock.ts).
  const t20 = config.memory ? (() => {
    const ledger = deps.ledger ?? new FileDeletionLedger({ dir: config.memory.ledgerDir, db: deps.db, now,
      acceptGeneration: config.memory.acceptGeneration ?? undefined,
      lock: advisoryLedgerLock(lockClient(databasePoolConfig(config.databaseUrl, { application_name: 'homelab-bot-ledger' }))) });
    // 문서 출처는 공개 저장소 두 곳의 커밋 고정 링크만 raw 파일 존재로 확인한다(document-source.ts, 기존 인터넷 443 egress).
    const memory = new MemoryService(deps.db, gate, ledger, deps.documents ?? githubDocuments({ send }), now);
    // 관측 원본: 백업(CNPG, 복원 검증 기록 포함)·인증서(cert-manager 지표)·예약 작업(CronJob).
    // kubernetes는 읽기 transport와 같은 연결(SA 토큰·CA)이고 닫기는 종료의 kubernetes.close()가 맡는다.
    // 인증서는 /read와 같은 Grafana transport·자격·메트릭 datasource를 쓴다. 설정이 비면 인증서 원본을 만들지 않는다.
    const metrics = Object.entries(GRAFANA_DATASOURCES).find(([, kind]) => kind === 'metrics')?.[0];
    const certificates = config.grafana.url && config.grafana.token && metrics ? { transport: grafana, datasource: metrics } : undefined;
    const observations: ObservationSource[] = deps.observations
      ?? briefingSources({ kubernetes, certificates }, now, config.briefing?.timezone);
    const briefing = new BriefingScheduler(store, gate, memory, observations,
      { time: config.briefing?.time ?? null, timezone: config.briefing?.timezone ?? null, colleague: config.colleagueEnabled === true },
      { gate: () => taskGate.open ? { open: true, routed: taskIntake.routed, intakeOpen: taskIntake.open } : taskGate,
        ...(external ? { externalConnections: () => external.links.activeCount() } : {}) });
    return { ledger, memory, briefing };
  })() : undefined;
  let briefingEnabled = false;
  health.watchMemory(() => ({ ledger: t20 ? t20.ledger.status().state : 'disabled', briefingEnabled }));
  let taskIntake: TaskIntakeStatus = TASK_INTAKE_UNREACHED;
  if (taskBridge) health.watchTaskLane(() => ({ workerRouted: taskIntake.routed, intakeOpen: taskIntake.open }));
  // 옛 작업자면 이 값이 false라 CHANGE만 닫히고 v1 /task는 그대로 돈다. 작업자는 나중에 바뀌므로 주기로 다시 본다.
  const changeWorkers = { task: false, review: false };
  const change = changeGate.open && changeReview && taskBridge && changeWorker ? assembleChange({ app: changeGate.app, store, gate, changes: changeReview.changes, review: changeReview.service, bridge: taskBridge, worker: changeWorker,
    kubernetes, send, now, log, shutdown: stop.signal, intakeOpen: () => taskIntake.routed && taskIntake.open, ...(review ? { guidance: review.guidance } : {}), ...deps.change }) : undefined;
  const changeClosedReason = (): string | null => !changeGate.open ? changeGate.reason : !changeWorkers.task ? 'task_worker_unsupported' : !changeWorkers.review ? 'review_worker_unsupported'
    : !reviewOpened ? 'review_closed' : !taskIntake.open ? 'task_intake_closed' : null;
  const changeCommands = config.changePr ? changeCommandHandler({ store, gate, changes: changeReview?.changes ?? new ChangeStore(deps.db, now), log, closedReason: changeClosedReason, ...(change ? { runtime: change.runtime } : {}) }) : undefined;
  let ports: Publisher['ports'];
  try {
    ports = { app: await listen(servers.app, deps.ports?.app ?? PORTS.publisher),
      alerts: await listen(servers.alerts, deps.ports?.alerts ?? PORTS.alerts) };
    if (external) ports.externalEvents = await listen(external.server, deps.ports?.externalEvents ?? PORTS.externalEvents);
  } catch (error) {
    // 한쪽만 열린 채 남으면 프로세스가 반쪽으로 살아 있다(이벤트 루프를 붙잡음). 연 것을 모두 닫고 다시 던진다.
    await Promise.all([closeServer(servers.app, 1000), closeServer(servers.alerts, 1000), external && closeServer(external.server, 1000)]);
    await kubernetes.close();
    throw error;
  }

  // Discord 쪽은 첫 READY에서 봇 사용자 ID를 받은 뒤 만든다. 그 전에는 수신·게시를 하지 않는다(경보·webhook 수신은 계속).
  const api = deps.discord ?? discordHttpApi(config.discordToken, send, now);
  let discord: { ingress: DiscordIngress; publisher: DiscordPublisher } | undefined;
  let protocol: DiscordProtocol | undefined;
  let runtimeStarted = false;
  // 수신 허용 목록. 리뷰가 열리면 같은 Set에 더한다(DiscordIngress는 이 참조를 본다).
  const acceptedCommands = new Set<string>([...FOUNDATION_COMMANDS, ...(t20 ? MEMORY_COMMANDS : []), ...(external ? EXTERNAL_TASK_COMMANDS : []), ...(config.changePr ? CHANGE_COMMANDS : [])]);
  const background = new Set<Promise<void>>();
  const track = (task: Promise<void>) => { background.add(task); void task.finally(() => background.delete(task)); };
  const typingHint = typingHints(store, gate, log, track, { shutdown: stop.signal });
  const loops: Promise<void>[] = [];
  // alive: 이 루프의 한 바퀴가 성공했다는 것이 DB에 닿았다는 증거인지. 하트비트 조건(조율 루프가 최근 60초 안에 돎)은
  // 그런 루프로만 잰다. runtime(store.expire)·publisher(claimDelivery)는 늘 DB를 거친다. 복구 루프는 대기 항목이 없으면
  // DB 없이 끝나므로 생존 근거가 아니다(DB 장애 중에도 정상 ping이 나가지 않게).
  const loop = (name: string, step: () => Promise<boolean>, alive = true) => loops.push((async () => {
    while (!stop.signal.aborted) {
      try {
        const busy = await step();
        if (alive) health.loop();
        if (!busy) await pause(deps.idleMs ?? 500);
      } catch (error) {
        log(`${name}_failed`, errorInfo(error));
        await pause(1000);
      }
    }
  })());
  const recovery = new RecoveryScheduler(store, (scope: Scope, owner: string) => {
    if (!discord) throw new Error('discord_not_ready');
    return discord.ingress.recover(scope, owner);
  }, log, deps.recoveryBackoff);
  // 새 READY의 복구 장벽. live 이벤트는 이 처리 뒤에 차례로 들어오므로(Gateway 이벤트 순서) 장벽이 서기 전에 처리되지 않는다.
  // DB가 잠시 안 되면 장벽이 설 때까지 다시 시도한다(그동안 이벤트는 기다린다).
  const guard = async (channel: string) => {
    for (let attempt = 0; !stop.signal.aborted; attempt++) {
      try { log('recovery_guard', { conversations: await recovery.guard(channel) }); return; }
      catch (error) { log('recovery_guard_failed', errorInfo(error)); await pause(Math.min(30_000, 1000 * 2 ** Math.min(attempt, 5))); }
    }
  };
  const barrier = async () => {
    for (let attempt = 0; !stop.signal.aborted; attempt++) {
      try { log('recovery_barrier', { conversations: await recovery.barrier() }); return; }
      catch (error) { log('recovery_barrier_failed', errorInfo(error)); await pause(Math.min(30_000, 1000 * 2 ** Math.min(attempt, 5))); }
    }
  };
  // R08 복원 장벽. 게시 트리거는 WAL timeline만 볼 수 있어 pg_dump 복원의 restoreEpoch 변경은 이 호출이 미게시 행보다 먼저 잡아야 한다.
  // Discord를 기다리지 않는다. 울타리를 세우지 못한 동안에는 게시자를 열지 않는다.
  const externalFence = async (): Promise<boolean> => {
    for (let attempt = 0; !stop.signal.aborted; attempt++) {
      try { log('external_task_fence', await external!.links.enforceRestoreFence()); return true; }
      catch (error) { log('external_task_fence_failed', errorInfo(error)); await pause(Math.min(30_000, 1000 * 2 ** Math.min(attempt, 5))); }
    }
    return false;
  };
  const externalFenced = external ? externalFence() : undefined;
  if (externalFenced) loops.push(externalFenced.then(() => {}));
  // 기동 장벽(DECISIONS T20 기동 순서): 원장 열기·재적용(memory.open) → 예약 반영(ensure) → 첫 tick → 게시자.
  // 첫 tick이 지난 회차·12시간 넘은 대기 브리핑을 막기 전에 게시자가 그것을 보내지 않게 한다.
  let memoryOpen = false;
  // 'closed': 원장을 열지 못했지만 open()이 기억이 든 대기 브리핑을 막은 뒤 원장 오류를 다시 던졌다. 기억만 닫고 진행한다.
  // 그 밖의 throw(차단 transaction·재적용의 DB 오류)는 무엇이 막혔는지 모른다. 호출한 쪽이 게시자를 열지 않고 다시 시도한다.
  // 근거: memory.open()은 원장 open·entries 실패에만 LedgerError를 던지고(차단 성공 뒤), 차단이 실패하면 그 DB 오류를 던진다.
  const openMemory = async (): Promise<'open' | 'closed'> => {
    try {
      log('memory_opened', await t20!.memory.open());
      memoryOpen = true;
      return 'open';
    } catch (error) {
      if (!(error instanceof LedgerError)) throw error;
      log('memory_closed', { ...errorInfo(error), stage: error.stage, state: t20!.ledger.status().state });
      return 'closed';
    }
  };
  const t20Barrier = async (): Promise<boolean> => {
    let opened = false, ensured = false;
    for (let attempt = 0; !stop.signal.aborted; attempt++) {
      const step = !opened ? 'memory_open' : !ensured ? 'briefing_ensure' : 'briefing_first_tick';
      try {
        if (!opened) { await openMemory(); opened = true; }
        if (stop.signal.aborted) return false;
        if (!ensured) {
          // ensure()는 transaction이라 교착(deadlock)·DB 오류로 throw할 수 있다. 그때도 게시자를 열지 않는다.
          const result = await t20!.briefing.ensure();
          briefingEnabled = result === 'enabled';
          log('briefing_ensured', { result });
          ensured = true;
        }
        if (stop.signal.aborted) return false;
        log('briefing_first_tick', { outcome: await t20!.briefing.tick() });
        log('t20_barrier_passed', { memory: memoryOpen ? 'open' : 'closed', briefing: briefingEnabled ? 'enabled' : 'disabled' });
        return true;
      } catch (error) {
        log('t20_barrier_failed', { step, ...errorInfo(error) });
        await pause((deps.t20Backoff ?? (n => Math.min(30_000, 1000 * 2 ** Math.min(n, 5))))(attempt));
      }
    }
    return false;
  };
  // 주기 작업. 주기는 실제 시간으로 잰다(deps.now는 업무 시계라 시험에서 멈춰 있을 수 있다).
  // 한 바퀴가 주기보다 길면 다음 바퀴는 끝난 뒤 바로 돈다. DB를 늘 거치지 않으므로 생존 근거가 아니다.
  const every = (name: string, ms: number, step: () => Promise<void>) => {
    let last = -Infinity;
    loop(name, async () => {
      if (Date.now() - last < ms) return false;
      last = Date.now();
      await step();
      return false;
    }, false);
  };
  const t20Loops = () => {
    every('briefing_tick', deps.briefingTickMs ?? T20_PERIODS.briefingTickMs, async () => { await t20!.briefing.tick(); });
    every('memory_resume', deps.memoryResumeMs ?? T20_PERIODS.memoryResumeMs, async () => {
      if (memoryOpen) { const done = await t20!.memory.resume(); if (done) log('memory_resumed', { done }); }
    });
    // 원장을 못 연 채 기동했으면 다시 연다(SSD·PVC·잠금이 나중에 준비되는 경우). 한 번 연 뒤 쓰는 중에 failed·fenced가 되면
    // 다시 열지 않는다(원장도 거부한다). 재기동이 잠금·파일 동일성·세대를 처음부터 다시 확인한다. 열기 중 잠금을 잃은 fenced도 같다.
    every('ledger_reopen', deps.ledgerReopenMs ?? T20_PERIODS.ledgerReopenMs, async () => {
      if (memoryOpen || stop.signal.aborted || t20!.ledger.status().state === 'fenced') return;
      await openMemory().catch(error => { log('memory_open_failed', errorInfo(error)); });
    });
  };
  // 리뷰 루프는 조건 (d)와 첫 READY 장벽을 모두 지난 뒤 시작한다. 장벽 전에 슬롯을 잡으면 복구할 대화 메시지보다 리뷰가 먼저 돈다.
  // 게시 대조·게시, PR 재조정, claim은 함께 출발한다. 실행·게시 직전 live 재확인이 있어 셋의 선후가 안전성을 좌우하지 않는다.
  // 리뷰 runtime은 DB를 거치지만 대화 runtime 루프가 이미 생존 근거라 하트비트에 더하지 않는다.
  let reviewWorkerReady = false;
  let reviewLoopsStarted = false;
  const startReviewLoops = () => {
    if (!review || !reviewOpened || !runtimeStarted || reviewLoopsStarted || stop.signal.aborted) return;
    reviewLoopsStarted = true;
    let reconciled = -Infinity;
    loop('review_publisher', async () => {
      if (Date.now() - reconciled >= (deps.reviewDeliveryReconcileMs ?? REVIEW_PERIODS.deliveryReconcileMs)) {
        reconciled = Date.now();
        await review.publisher.reconcile();
      }
      return review.publisher.deliver();
    }, false);
    every('review_reconcile', deps.reviewPullRequestReconcileMs ?? REVIEW_PERIODS.pullRequestReconcileMs, async () => {
      const result = await review.reconciler.run();
      if (result.admitted || result.limited) log('review_reconciled', result);
    });
    // 열린 뒤 작업자가 옛 이미지·재시작으로 돌아가면 새 claim만 멈춘다. webhook은 계속 받아 재시작 중 댓글 명령을 잃지 않는다.
    loop('review_runtime', () => reviewWorkerReady ? review.runtime.tick() : Promise.resolve(false), false);
  };
  // 작업 루프. 긴 턴이 대화 루프를 기다리게 하지 않으려고 따로 돈다. 대화 runtime 루프가 이미 생존 근거라 하트비트에 더하지 않는다.
  // 작업자가 수락을 닫았으면 새 claim만 멈추고 정리는 계속한다. 볼륨이 찼을 때 공간을 비우는 길이 이 정리다.
  let taskLoopStarted = false;
  const startTaskLoop = () => {
    if (!taskBridge || !runtimeStarted || taskLoopStarted || stop.signal.aborted) return;
    taskLoopStarted = true;
    loop('task_runtime', async () => {
      if (taskIntake.routed && taskIntake.open) return runtime.tickTask();
      if (!stop.signal.aborted) await taskBridge.sweep();
      return false;
    }, false);
  };
  // 변경 루프. 부모는 슬롯을 잡지 않고 자식 job만 레인을 쓴다. 긴 시험 대기가 대화·작업 루프를 늦추지 않게 따로 돈다. 첫 READY 장벽 뒤에 시작한다.
  let changeLoopsStarted = false;
  const startChangeLoops = () => {
    if (!change || !runtimeStarted || changeLoopsStarted || stop.signal.aborted) return;
    changeLoopsStarted = true;
    loop('change_lane', () => change.runtime.laneTick(), false);
    loop('change_children', () => change.runtime.childrenTick(), false);
    loop('change_publish', () => change.runtime.publishTick(), false);
    every('change_reconcile', CHANGE_PERIODS.reconcileMs, async () => {
      const report = await change.runtime.reconcile();
      if (report.confirmed.length || report.blocked.length) log('change_reconciled', { confirmed: report.confirmed.length, stillUnknown: report.stillUnknown.length, blocked: report.blocked.length });
    });
  };
  // REST 요청 하나가 시간 초과(5초)·일시 오류로 실패할 수 있다. 다음 READY(며칠 뒤일 수도)까지 미루지 않고 몇 번 더 시도한다.
  let registering: string | undefined;
  let registerAgain = false;
  let knownApplication: string | undefined;
  let taskOpened = false;
  const register = async (applicationId: string) => {
    if (registering === applicationId) return;
    registering = applicationId;
    try {
      for (const delay of deps.registerDelaysMs ?? [0, 5000, 30_000, 120_000, 300_000]) {
        if (delay) await pause(delay);
        if (stop.signal.aborted) return;
        try { log('commands_registered', await registerCommands(api, applicationId, config.policy.guild, commandDefinitions(!!t20, reviewOpened, taskOpened, !!external, !!config.changePr))); return; }
        catch (error) {
          log('commands_register_failed', errorInfo(error));
          if (error instanceof RateLimited) await pause(error.retryAfterMs);
        }
      }
    } finally {
      registering = undefined;
      // 진행 중이던 등록은 열리기 전 목록을 보냈을 수 있다.
      if (registerAgain) { registerAgain = false; track(register(applicationId)); }
    }
  };
  // 한 번 열리면 이 프로세스에서는 닫지 않는다. 작업자 재시작마다 Discord 명령을 지웠다 다시 쓰면 대기 작업을 제어할 수 없다.
  const openReview = () => {
    reviewOpened = true;
    for (const name of REVIEW_COMMANDS) acceptedCommands.add(name);
    log('review_gate', { state: 'open' });
    if (knownApplication) {
      if (registering) registerAgain = true;
      else track(register(knownApplication));
    }
    startReviewLoops();
  };
  // 리뷰와 같다. 작업자가 작업 모드로 답한 뒤에 명령을 열고, 한 번 열면 닫지 않는다. 작업자 재시작마다 명령을 지우면 대기 작업을 제어할 수 없다.
  const openTaskLane = () => {
    taskOpened = true;
    for (const name of TASK_COMMANDS) acceptedCommands.add(name);
    log('task_gate', { state: 'open' });
    if (knownApplication) {
      if (registering) registerAgain = true;
      else track(register(knownApplication));
    }
  };
  const gateway = new GatewaySession({
    token: config.discordToken,
    gatewayUrl: deps.gatewayUrl ?? discordGatewayUrl(api),
    budget: new GatewayBudget(store, { spacingMs: deps.identifySpacingMs }),
    health,
    log,
    connect: deps.connect,
    allowUrl: deps.allowGatewayUrl,
    dispatch: async (type, data) => {
      // 입력 중 힌트. 기다리지 않고(뒤 이벤트를 막지 않게) 백그라운드로 돌린다. 오류를 스스로 삼키므로 guard로 가지 않는다.
      if (type === 'TYPING_START') { typingHint(data); return; }
      if (!discord || (type !== 'MESSAGE_CREATE' && type !== 'INTERACTION_CREATE')) return;
      try { await protocol!.gateway(type, data, discord.ingress); }
      catch (error) {
        // 확정 거부(권한·채널 종류, 잘못된 payload·입력, 채널 403/404)는 다시 해도 같다. 버린다.
        if (error instanceof Denied || error instanceof z.ZodError || error instanceof DiscordRejected) return;
        log('discord_event_failed', { type, ...errorInfo(error) });
        // 일시 장애(DB·REST·429·정책 확인 불가 등). 상호작용은 토큰이 3초라 되살릴 수 없고 checkpoint와도 무관하다.
        // 메시지는 그 대화에 장벽을 세워 history 대조로 메운다. 장벽이 설 때까지 다음 이벤트는 기다린다(순서 유지).
        const channel = MessageChannel.safeParse(data);
        if (type === 'MESSAGE_CREATE' && channel.success) await guard(channel.data.channel_id);
      }
    },
    onReady: async ready => {
      if (!discord) {
        protocol = new DiscordProtocol(api, ready.userId, now);
        // 기억 명령은 원장이 켜졌을 때만 받는다. 장벽 전·기억이 닫힌 동안은 MemoryNotReady로, 종료 중이면 바로 "쓸 수 없음"으로 답한다.
        const memoryCommands = t20 && new MemoryCommands(t20.memory, () => t20.ledger.status().state, () => stop.signal.aborted, now, config.colleagueEnabled === true);
        const plainTaskCommands = taskBridge && new TaskCommands(store, gate, taskBridge, () => taskIntake, track, log);
        // 답 봉인은 스위치와 무관하다. 켰다가 끈 뒤에도 남은 CHANGE 질문의 답이 events로 들어가면 대화 모델에 샌다.
        const taskCommands = plainTaskCommands && guardedTaskCommands(plainTaskCommands, change?.inputs ?? new ChangePrivateInputs(deps.db, now), gate);
        discord = { ingress: new DiscordIngress(store, gate, protocol, true, acceptedCommands, log, memoryCommands || undefined, taskCommands, external?.commands, changeCommands),
          publisher: new DiscordPublisher(store, gate, protocol) };
        const publisher = discord.publisher;
        const publish = () => {
          let reconciled = 0;
          loop('publisher', async () => {
            if (now() - reconciled >= (deps.reconcileEveryMs ?? 30_000)) { reconciled = now(); await publisher.reconcile(); }
            return publisher.deliver();
          });
        };
        // 기억·브리핑이 켜져 있으면 게시자(reconcile·deliver 모두)는 기동 장벽 뒤에 연다. 대화 수신·복구 장벽·runtime claim은 기다리지 않는다
        // (그동안 나온 답은 outbox에 쌓였다가 게시자가 열리면 나간다). 장벽은 이벤트 순서 밖에서 돌아 Gateway 이벤트를 막지 않는다.
        // R08 복원 장벽도 같은 자리에서 게시자 앞에 선다.
        if (!t20 && !externalFenced) publish();
        else loops.push((async () => {
          if (externalFenced && !await externalFenced) return;
          if (t20 && !await t20Barrier()) return;
          if (stop.signal.aborted) return;
          publish();
          if (t20) t20Loops();
        })());
        loop('recovery', () => recovery.runDue(), false);
        loop('typing', typingActivity(store, gate, api, log, stop.signal), false);
      }
      await barrier();
      // 작업 claim은 첫 장벽이 선 뒤에 시작한다. 재시작 때 남은 queued 작업이 중단 중 메시지를 history로 복구하기 전에
      // 이전 입력으로 모델을 부르지 않게 한다. 이후 READY의 장벽은 claim의 gap 조건이 막는다.
      // read는 모델 응답을 기다리지 않게 따로 돈다. 늘 DB를 거치므로 생존 근거다.
      if (!runtimeStarted && !stop.signal.aborted) {
        runtimeStarted = true;
        loop('runtime', () => runtime.tick());
        loop('read', () => runtime.tickRead());
        // 모델 멈춤의 저절로 재개. 같은 작업 행을 대기열로 돌릴 뿐이라 계정·모델·실행기는 그대로다(D-14 조건 2).
        every('model_resume', deps.modelResumeTickMs ?? MODEL_RESUME_TICK_MS, async () => {
          const resumed = await store.resumeDue();
          if (resumed) log('model_resumed', { jobs: resumed });
        });
        startReviewLoops();
        startTaskLoop();
        startChangeLoops();
      }
      // 명령 등록과 history 대조 자체는 이벤트 처리 순서 밖에서 돈다(대조가 30초까지 걸려도 상호작용 ACK가 밀리지 않게).
      knownApplication = ready.applicationId;
      track(register(ready.applicationId));
    },
  });
  health.watchGateway(() => gateway.state);
  const heartbeat = setInterval(() => { health.heartbeat().catch(error => log('heartbeat_failed', errorInfo(error))); },
    deps.heartbeatEveryMs ?? 10_000);
  // Discord를 기다리지 않는다. Discord 장애 중에도 webhook의 댓글 명령은 받아 대기열에 둘 수 있어야 한다(claim만 장벽 뒤).
  if (review) every('review_worker_probe', deps.reviewWorkerProbeMs ?? REVIEW_PERIODS.workerProbeMs, async () => {
    reviewWorkerReady = await reviewWorkerRouted(config.workerUrl, send, stop.signal);
    if (reviewWorkerReady && !reviewOpened && !stop.signal.aborted) openReview();
  });
  if (taskGate.open) every('task_worker_probe', deps.taskWorkerProbeMs ?? TASK_WORKER_PROBE_MS, async () => {
    const before = taskIntake;
    taskIntake = await taskWorkerIntake(taskGate.workerUrl, send, stop.signal);
    if (before.routed !== taskIntake.routed || before.open !== taskIntake.open) log('task_worker_intake', { routed: taskIntake.routed, open: taskIntake.open, reasons: taskIntake.reasons });
    if (taskIntake.routed && !taskOpened && !stop.signal.aborted) openTaskLane();
  });
  if (change && taskGate.open) every('change_worker_probe', deps.taskWorkerProbeMs ?? TASK_WORKER_PROBE_MS, async () => {
    const task = await taskWorkerChangeContract(taskGate.workerUrl, send, stop.signal);
    const routed = await workerRouteAnswers(config.workerUrl, '/v1/change-review', send, stop.signal);
    if (task !== changeWorkers.task || routed !== changeWorkers.review) log('change_workers', { task, review: routed });
    changeWorkers.task = task;
    changeWorkers.review = routed;
  });
  // 원문 보존 정리(CHANGE 원문·artifact·brief 7일, 작업 레인 질문 답 7일, 입력·질문·결과·게시 본문 7일)는 DB만 쓴다. 레인 스위치·작업자 수락·READY 장벽과 묶으면
  // 레인을 끈 채 재시작했을 때 이미 지울 때가 된 원문이 다시 켤 때까지 남으므로 늘 돈다.
  every('change_retention', CHANGE_PERIODS.retentionMs, async () => {
    const purged = await purgeExpiredChangeContentRounds(store.db, store.now());
    if (purged) log('change_content_purged', { purged });
  });
  every('task_answer_retention', TASK_ANSWER_PURGE_EVERY_MS, async () => {
    const purged = await purgeExpiredTaskAnswers(store.db, store.now());
    if (purged) log('task_answers_purged', { purged });
  });
  every('raw_text_retention', RAW_TEXT_PURGE_EVERY_MS, async () => {
    const purged = await purgeExpiredRawText(store.db, store.now());
    if (purged.events || purged.prompts || purged.results || purged.outbox) log('raw_text_purged', { ...purged });
  });
  if (external) every('external_task_purge', deps.externalPurgeMs ?? EXTERNAL_PURGE_MS, async () => {
    const purged = await external.links.purge();
    if (purged.events || purged.connections) log('external_task_purged', purged);
  });
  gateway.start();
  log('publisher_started', { ports, policyRevision: config.policy.revision, services: SERVICES.length });

  let stopped: Promise<void> | undefined;
  return { health, gateway, ports, stop: () => stopped ??= (async () => {
    // 전체 종료 기한 하나(기본 20초, kubelet 유예 30초 안). 단계별 대기를 차례로 더하지 않고 남은 시간을 나눈다.
    // 최악: Gateway 정리(≤4초)·수신 서버(≤5초)는 runtime의 드레인(10초)+cancel(대화 5초·리뷰 10초)과 동시에 돌아 기한 안에 끝난다.
    // 전역 슬롯이 하나라 대화와 리뷰가 함께 드레인하지 않는다.
    const deadline = Date.now() + (deps.stopTimeoutMs ?? 20_000);
    const left = () => Math.max(0, deadline - Date.now());
    stop.abort();
    clearInterval(heartbeat);
    await Promise.all([gateway.stop(Math.min(2000, left())),
      closeServer(servers.app, Math.min(5000, left())), closeServer(servers.alerts, Math.min(5000, left())),
      external && closeServer(external.server, Math.min(5000, left()))]);
    // 진행 중인 한 바퀴(드레인·취소 확인 포함)는 기한까지 기다린다. 넘으면 lease 만료가 unknown으로 남긴다.
    await Promise.race([Promise.all([...loops, ...background]), sleep(left())]);
    // 원장: 위에서 루프가 멈춰 새 tick·resume·재열기가 없다. close()가 줄 선 쓰기를 마친 뒤 파일을 닫고 잠금을 놓는다.
    // 남은 기한(최소 1초)까지만 기다린다. 못 마쳐도 프로세스가 끝나면 잠금 연결이 닫혀 PostgreSQL이 세션 잠금을 푼다.
    await Promise.all([Promise.race([kubernetes.close(), sleep(1000)]),
      t20 && Promise.race([t20.ledger.close().catch(error => log('ledger_close_failed', errorInfo(error))), sleep(Math.max(1000, left()))])]);
    log('publisher_stopped');
  })() };
}

async function main(): Promise<void> {
  const log = jsonLog;
  let config: PublisherConfig;
  try { config = loadPublisherConfig(process.env, Date.now()); }
  catch (error) {
    log('config_invalid', { problems: error instanceof ConfigError ? error.problems : ['unknown'] });
    process.exitCode = 1; return;
  }
  const pool = new pg.Pool(databasePoolConfig(config.databaseUrl));
  pool.on('error', error => log('database_pool_error', errorInfo(error)));
  const db = new Postgres(pool);
  try {
    const applied = await withConnectRetry(() => appliedMigrations(db), {
      onRetry: (attempt, error) => log('database_connect_retry', { attempt: String(attempt), ...errorInfo(error) }) });
    const missing = MIGRATIONS.map(migrationVersion).filter(version => !applied.has(version));
    if (missing.length) { log('schema_not_migrated', { missing }); await pool.end(); process.exitCode = 1; return; }
  } catch (error) { log('database_unavailable', errorInfo(error)); await pool.end().catch(() => {}); process.exitCode = 1; return; }
  let publisher: Publisher;
  try { publisher = await startPublisher(config, { db, log }); }
  catch (error) {
    log('publisher_start_failed', errorInfo(error));
    await pool.end().catch(() => {});
    process.exitCode = 1;
    // 열린 자원은 startPublisher가 닫는다. 그래도 무언가 남아 프로세스가 반쪽으로 살아 있지 않게 5초 뒤 끝낸다.
    setTimeout(() => process.exit(1), 5000).unref();
    return;
  }
  let shutting = false;
  const shutdown = (signal: string) => {
    if (shutting) return;
    shutting = true;
    log('shutdown', { signal });
    // 기한을 넘긴 작업이 연결을 쥐고 있으면 pool.end()가 끝나지 않는다. 오래 기다리지 않는다.
    void publisher.stop().finally(async () => { await Promise.race([pool.end().catch(() => {}), sleep(2000)]); process.exit(0); });
  };
  process.once('SIGTERM', () => shutdown('SIGTERM'));
  process.once('SIGINT', () => shutdown('SIGINT'));
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) void main();
