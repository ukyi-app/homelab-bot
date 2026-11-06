import { readFile } from 'node:fs/promises';
import { Agent } from 'undici';
import { z } from 'zod';
import type { ReadTransport } from './read.js';

// 읽기 transport 둘(Grafana, Kubernetes API). 원본 응답을 ReadAdapter가 받는 관측 JSON({observedAt, rows})으로 투영한다.
// 각 transport는 ReadAdapter의 AbortSignal을 fetch에 넘겨 5초 시간 초과 때 실제 요청을 끊는다.
// 경로는 고정 모양만 만든다. 템플릿이 코드에 있어도 여기서 다시 막아 Secret·ConfigMap·pods/log·exec 경로가 생기지 않는다.
type Request = Parameters<ReadTransport['query']>[0];
interface Row { status?: 'healthy' | 'degraded' | 'unknown'; value?: number; text?: string }
// Grafana 데이터소스 응답 상한(4MiB)과 같다. 다른 API도 이만큼만 버퍼에 담는다.
export const RESPONSE_LIMIT_BYTES = 4 * 1024 * 1024;
const TEXT_LIMIT = 1000;
const name = /^[a-z0-9]([-a-z0-9]{0,61}[a-z0-9])?$/;
const bearer = (token: string) => `Bearer ${token}`;

async function limited(response: Response, limit = RESPONSE_LIMIT_BYTES): Promise<unknown> {
  const declared = Number(response.headers.get('content-length') ?? '0');
  if (declared > limit) { await response.body?.cancel().catch(() => {}); throw new Error('response_limit'); }
  if (!response.body) throw new Error('response_empty');
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > limit) { await reader.cancel().catch(() => {}); throw new Error('response_limit'); }
    chunks.push(value);
  }
  return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}
async function call(send: typeof fetch, url: string, init: RequestInit & { dispatcher?: Agent }): Promise<unknown> {
  const response = await send(url, { ...init, redirect: 'error' });
  if (!response.ok) { await response.body?.cancel().catch(() => {}); throw new Error(`read_http_${response.status}`); }
  return limited(response);
}
// 행 수와 바이트 상한을 넘지 않게 뒤에서부터 덜어 낸다. 첫 행(상태·건수)은 남긴다.
export function encodeObservation(observedAt: number, rows: Row[], request: Pick<Request, 'limit' | 'maxBytes'>): Uint8Array {
  const kept = rows.slice(0, request.limit);
  for (;;) {
    const bytes = new TextEncoder().encode(JSON.stringify({ observedAt, rows: kept }));
    if (bytes.byteLength <= request.maxBytes || kept.length <= 1) return bytes;
    kept.pop();
  }
}
const text = (value: string) => value.length > TEXT_LIMIT ? value.slice(0, TEXT_LIMIT) : value;

const Frame = z.object({
  schema: z.object({ fields: z.array(z.object({ name: z.string(), type: z.string().optional() })) }),
  data: z.object({ values: z.array(z.array(z.unknown())) }),
});
const DataResponse = z.object({ results: z.record(z.string(), z.object({
  status: z.number().optional(), error: z.string().optional(), frames: z.array(Frame).optional() })) });
export type GrafanaKind = 'metrics' | 'logs';
// Grafana POST /api/ds/query. 메트릭은 instant 질의의 마지막 값, 로그는 줄 수 + 원문(untrusted, 게시하지 않음).
export function grafanaTransport(options: { base: string; token: string; datasources: Readonly<Record<string, GrafanaKind>>;
  send?: typeof fetch }): ReadTransport {
  const send = options.send ?? fetch;
  const base = options.base.replace(/\/$/, '');
  return { async query(request) {
    const kind = options.datasources[request.datasource];
    if (!kind || !request.query || request.query.length > 2000) throw new Error('unsupported_query');
    const query = kind === 'metrics'
      ? { refId: 'A', datasource: { uid: request.datasource }, expr: request.query, instant: true, range: false,
        format: 'time_series', maxDataPoints: request.limit }
      // VictoriaLogs 플러그인 v0.33.1(pkg/plugin/query.go): queryType instant는 /select/logsql/query로 가고
      // start=from, end=to, limit=maxLines다. 그래서 창 전체의 원문 줄을 최대 maxLines개 받는다(실측).
      : { refId: 'A', datasource: { uid: request.datasource }, expr: request.query, queryType: 'instant', maxLines: request.limit };
    const raw = DataResponse.parse(await call(send, `${base}/api/ds/query`, { method: 'POST', signal: request.signal,
      headers: { authorization: bearer(options.token), 'content-type': 'application/json', accept: 'application/json' },
      body: JSON.stringify({ from: String(request.from), to: String(request.to), queries: [query] }) }));
    const result = raw.results.A;
    if (!result || result.error || (result.status !== undefined && result.status >= 400)) throw new Error('grafana_query_failed');
    const frames = result.frames ?? [];
    if (kind === 'metrics') {
      const rows: Row[] = [];
      let observedAt = 0;
      for (const frame of frames) {
        const fields = frame.schema.fields;
        const time = fields.findIndex(f => f.type === 'time');
        if (time < 0) continue;
        const times = frame.data.values[time] ?? [];
        fields.forEach((field, index) => {
          if (field.type !== 'number') return;
          const values = frame.data.values[index] ?? [];
          for (let i = values.length - 1; i >= 0; i--) {
            const value = values[i], at = times[i];
            if (typeof value === 'number' && Number.isFinite(value) && typeof at === 'number' && Number.isFinite(at)) {
              rows.push({ value }); observedAt = Math.max(observedAt, at); return;
            }
          }
        });
      }
      return encodeObservation(observedAt, rows, request);
    }
    const lines: string[] = [];
    for (const frame of frames) {
      const fields = frame.schema.fields;
      const line = fields.findIndex(f => ['Line', 'line', '_msg'].includes(f.name));
      const index = line >= 0 ? line : fields.findIndex(f => f.type === 'string' && f.name !== 'labels');
      if (index < 0) continue;
      for (const value of frame.data.values[index] ?? []) if (typeof value === 'string') lines.push(text(value));
    }
    // 질의가 성공했으면 줄이 0이어도 그 창의 관측이다. 첫 행은 돌려받은 줄 수(상한 limit-1)다.
    const shown = lines.slice(0, Math.max(0, request.limit - 1));
    return encodeObservation(request.to, [{ value: shown.length }, ...shown.map(line => ({ text: line }))], request);
  } };
}

const Workload = z.object({ metadata: z.object({ name: z.string(), namespace: z.string(), generation: z.number().int().optional() }),
  spec: z.object({ replicas: z.number().int().nonnegative().optional() }).optional(),
  status: z.object({ observedGeneration: z.number().int().optional(), readyReplicas: z.number().int().optional(),
    availableReplicas: z.number().int().optional(), updatedReplicas: z.number().int().optional() }).optional() });
const workload = /^(deployment|statefulset)\/([a-z0-9]([-a-z0-9]{0,61}[a-z0-9])?)$/;
const Application = z.object({ metadata: z.object({ name: z.string(), namespace: z.string() }),
  status: z.object({ health: z.object({ status: z.string() }).optional(), sync: z.object({ status: z.string() }).optional() }).optional() });
// Argo CD Application CR이 사는 namespace(D9). 템플릿 namespace(서비스 ns)와 상관없이 고정이다.
// SA 권한은 클러스터 범위 읽기(ClusterRole homelab-readonly)라 다른 ns도 읽힌다. Application이 argocd에만 있어
// 실제 차이는 없고, 경계는 이 코드가 이 ns만 읽는다는 데 있다(실측).
export const ARGOCD_NAMESPACE = 'argocd';
export const SERVICE_ACCOUNT = Object.freeze({
  token: '/var/run/secrets/kubernetes.io/serviceaccount/token',
  ca: '/var/run/secrets/kubernetes.io/serviceaccount/ca.crt',
});
// Kubernetes API GET(D8·D9: in-cluster SA bot-reader). 읽기 transport와 브리핑 관측(src/briefing-observations.ts)이 같은
// 연결 풀을 쓴다. path는 호출하는 쪽이 고정 모양으로만 만든다(사용자 입력을 넣지 않는다).
// 토큰은 kubelet이 갈아 끼우므로 요청마다 다시 읽는다. CA는 처음 쓸 때 읽어 연결 풀을 만든다.
export interface KubernetesClient { get(path: string, signal: AbortSignal): Promise<unknown>; close(): Promise<void> }
export function kubernetesClient(options: { base: string; tokenFile: string; caFile: string | null; send?: typeof fetch;
  readText?: (path: string) => Promise<string> }): KubernetesClient {
  const send = options.send ?? fetch;
  const readText = options.readText ?? (path => readFile(path, 'utf8'));
  const base = options.base.replace(/\/$/, '');
  let dispatcher: Promise<Agent | undefined> | undefined;
  const agent = () => dispatcher ??= options.caFile === null ? Promise.resolve(undefined)
    : readText(options.caFile).then(ca => new Agent({ connect: { ca } })).catch(error => { dispatcher = undefined; throw error; });
  return {
    async get(path, signal) {
      const token = (await readText(options.tokenFile)).trim();
      if (!token || /\s/.test(token)) throw new Error('service_account_token');
      return call(send, `${base}${path}`, { method: 'GET', signal, dispatcher: await agent(),
        headers: { authorization: bearer(token), accept: 'application/json' } });
    },
    async close() { const current = await dispatcher?.catch(() => undefined); await current?.close().catch(() => {}); },
  };
}
// 읽기 transport. 객체 하나만 GET한다.
// datasource kubernetes: 템플릿 namespace의 Deployment·StatefulSet. argocd: namespace argocd의 Argo CD Application CR,
// 이름은 applications(카탈로그 고정값)에 있을 때만. 그 밖 datasource는 요청 없이 거부한다.
export function kubernetesTransport(options: { base: string; tokenFile: string; caFile: string | null;
  applications: readonly string[]; send?: typeof fetch; readText?: (path: string) => Promise<string> }): ReadTransport & KubernetesClient {
  const client = kubernetesClient(options);
  const applications = new Set(options.applications.filter(app => name.test(app)));
  // path는 아래 두 함수가 모양을 검사한 값으로만 만든다.
  const get = client.get;
  const workloadStatus = async (request: Request): Promise<Uint8Array> => {
    const match = workload.exec(request.query);
    if (!match || !name.test(request.namespace)) throw new Error('unsupported_query');
    const [, kind, object] = match as unknown as [string, 'deployment' | 'statefulset', string];
    const raw = Workload.parse(await get(`/apis/apps/v1/namespaces/${request.namespace}/${kind}s/${object}`, request.signal));
    if (raw.metadata.name !== object || raw.metadata.namespace !== request.namespace) throw new Error('unexpected_object');
    const desired = raw.spec?.replicas ?? 1, ready = raw.status?.readyReplicas ?? 0;
    const available = raw.status?.availableReplicas ?? 0, updated = raw.status?.updatedReplicas ?? 0;
    // 컨트롤러가 최신 spec 세대를 관측하기 전의 replica 수는 이전 세대 기준이다. 그때는 정상·비정상을 말하지 않는다.
    const generation = raw.metadata.generation, observed = raw.status?.observedGeneration;
    const current = generation !== undefined && observed !== undefined && observed >= generation;
    const healthy = desired >= 1 && ready >= desired && available >= desired && updated >= desired;
    return encodeObservation(request.to, [{ status: !current ? 'unknown' : healthy ? 'healthy' : 'degraded', value: ready }], request);
  };
  // 앱 객체의 status.health·status.sync만 쓴다. spec(Helm values 등)·status.resources는 투영하지 않는다.
  const applicationStatus = async (request: Request): Promise<Uint8Array> => {
    if (!name.test(request.query) || !applications.has(request.query)) throw new Error('unsupported_query');
    const app = Application.parse(await get(`/apis/argoproj.io/v1alpha1/namespaces/${ARGOCD_NAMESPACE}/applications/${request.query}`,
      request.signal));
    if (app.metadata.name !== request.query || app.metadata.namespace !== ARGOCD_NAMESPACE) throw new Error('unexpected_object');
    const health = app.status?.health?.status ?? 'Unknown', sync = app.status?.sync?.status ?? 'Unknown';
    const status = health === 'Healthy' ? (sync === 'Synced' ? 'healthy' : 'degraded')
      : health === 'Degraded' || health === 'Missing' ? 'degraded' : 'unknown';
    // [가정] status는 application-controller의 최근 평가(재조정 주기 안)라 요청 시각의 관측으로 둔다(D9 전 Argo CD API 경로와 같은 의미).
    return encodeObservation(request.to, [{ status, text: text(`health=${health} sync=${sync}`) }], request);
  };
  return {
    async query(request) {
      if (request.datasource === 'kubernetes') return workloadStatus(request);
      if (request.datasource === 'argocd') return applicationStatus(request);
      throw new Error('unsupported_query');
    },
    get: client.get,
    close: client.close,
  };
}

// ---- 병합 뒤 배포 읽기(T19 DEPLOY-01) ----
// 위 /read 경로의 응답 모양을 건드리지 않게 스키마를 따로 둔다. 값 투영은 revision·digest·이미지·준비 상태뿐이다.
// 경로는 SA bot-reader의 ClusterRole homelab-readonly가 이미 허용한 읽기 셋(applications, deployments, pods)이다.

const SHA_TEXT = /^[0-9a-f]{40}$/;
const DIGEST_TEXT = /^sha256:[0-9a-f]{64}$/;
const DeployedValues = z.object({ repository: z.string().max(256).optional(), digest: z.string().regex(DIGEST_TEXT).optional(),
  revision: z.string().regex(SHA_TEXT).optional() });
const HelmSource = z.object({ helm: z.object({ valuesObject: DeployedValues.optional() }).optional() });
const DeployApplication = z.object({ metadata: z.object({ name: z.string(), namespace: z.string() }),
  spec: z.object({ source: HelmSource.optional() }),
  status: z.object({ sync: z.object({ status: z.string().optional(), comparedTo: z.object({ source: HelmSource.optional() }).optional() }).optional(),
    operationState: z.object({ phase: z.string().optional() }).optional() }).optional() });
const DeployWorkload = z.object({ metadata: z.object({ name: z.string(), namespace: z.string(), generation: z.number().int().optional() }),
  spec: z.object({ replicas: z.number().int().nonnegative().optional(),
    template: z.object({ spec: z.object({ containers: z.array(z.object({ name: z.string(), image: z.string().optional() })) }) }) }),
  status: z.object({ observedGeneration: z.number().int().optional(), readyReplicas: z.number().int().optional(),
    availableReplicas: z.number().int().optional(), updatedReplicas: z.number().int().optional() }).optional() });
const DeployPods = z.object({ metadata: z.object({ continue: z.string().optional() }).optional(),
  items: z.array(z.object({ metadata: z.object({ deletionTimestamp: z.string().nullable().optional(),
    ownerReferences: z.array(z.object({ kind: z.string() })).optional() }),
  status: z.object({ phase: z.string().optional(), conditions: z.array(z.object({ type: z.string(), status: z.string() })).optional(),
    containerStatuses: z.array(z.object({ name: z.string(), ready: z.boolean().optional(), imageID: z.string().optional() })).optional() }).optional() })) });
const POD_LIST_LIMIT = 50;
export interface DeployedValuesReading { repository: string | null; digest: string | null; revision: string | null }
export interface DeployedApplicationReading { desired: DeployedValuesReading | null; compared: DeployedValuesReading | null; syncStatus: string | null; operationPhase: string | null }
export interface DeployedWorkloadReading { generation: number | null; observedGeneration: number | null; replicas: number; ready: number; available: number; updated: number; image: string | null }
export interface DeployedPodReading { ready: boolean; imageId: string | null; terminating: boolean }
export interface DeploymentKubernetesReader {
  application(application: string, signal: AbortSignal): Promise<DeployedApplicationReading>;
  workload(namespace: string, deployment: string, container: string, signal: AbortSignal): Promise<DeployedWorkloadReading>;
  pods(namespace: string, app: string, container: string, signal: AbortSignal): Promise<DeployedPodReading[]>;
}
const projectValues = (source: z.infer<typeof HelmSource> | undefined): DeployedValuesReading | null => {
  const values = source?.helm?.valuesObject;
  return values ? { repository: values.repository ?? null, digest: values.digest ?? null, revision: values.revision ?? null } : null;
};
export function deploymentKubernetesReader(client: Pick<KubernetesClient, 'get'>): DeploymentKubernetesReader {
  const names = async (...values: string[]) => { if (!values.every(value => name.test(value))) throw new Error('unsupported_query'); };
  return {
    async application(application, signal) {
      await names(application);
      const raw = DeployApplication.parse(await client.get(`/apis/argoproj.io/v1alpha1/namespaces/${ARGOCD_NAMESPACE}/applications/${application}`, signal));
      if (raw.metadata.name !== application || raw.metadata.namespace !== ARGOCD_NAMESPACE) throw new Error('unexpected_object');
      return { desired: projectValues(raw.spec.source), compared: projectValues(raw.status?.sync?.comparedTo?.source),
        syncStatus: raw.status?.sync?.status ?? null, operationPhase: raw.status?.operationState?.phase ?? null };
    },
    async workload(namespace, deployment, container, signal) {
      await names(namespace, deployment, container);
      const raw = DeployWorkload.parse(await client.get(`/apis/apps/v1/namespaces/${namespace}/deployments/${deployment}`, signal));
      if (raw.metadata.name !== deployment || raw.metadata.namespace !== namespace) throw new Error('unexpected_object');
      return { generation: raw.metadata.generation ?? null, observedGeneration: raw.status?.observedGeneration ?? null, replicas: raw.spec.replicas ?? 1,
        ready: raw.status?.readyReplicas ?? 0, available: raw.status?.availableReplicas ?? 0, updated: raw.status?.updatedReplicas ?? 0,
        image: raw.spec.template.spec.containers.find(item => item.name === container)?.image ?? null };
    },
    async pods(namespace, app, container, signal) {
      await names(namespace, app, container);
      const selector = encodeURIComponent(`homelab.ukyi.app/app=${app}`);
      const raw = DeployPods.parse(await client.get(`/api/v1/namespaces/${namespace}/pods?labelSelector=${selector}&limit=${POD_LIST_LIMIT}`, signal));
      if (raw.metadata?.continue) throw new Error('unexpected_object');
      // 같은 라벨을 쓰는 마이그레이션 Job 파드와 끝난 파드(퇴거된 옛 파드 포함)는 지금 서비스하는 파드가 아니다. homelab status와 같은 판정이다.
      return raw.items.filter(pod => !pod.metadata.ownerReferences?.some(owner => owner.kind === 'Job')
        && pod.status?.phase !== 'Succeeded' && pod.status?.phase !== 'Failed').map(pod => {
        const status = pod.status?.containerStatuses?.find(item => item.name === container);
        const ready = pod.status?.conditions?.some(item => item.type === 'Ready' && item.status === 'True') === true && status?.ready === true;
        return { ready, imageId: status?.imageID || null, terminating: Boolean(pod.metadata.deletionTimestamp) };
      });
    },
  };
}

// 공개 저장소 읽기. 어떤 자격도 받지 않아 writer·리뷰 App 토큰이 이 경로로 나가지 못한다.
// 함정: 익명 한도는 출구 IP당 시간 60회다. 넘으면 403·429이고 호출자는 unknown으로 낸다. 자동으로 다른 자격으로 넘어가지 않는다.
const GITHUB_API = 'https://api.github.com';
const REPOSITORY_TEXT = /^[A-Za-z0-9-]{1,39}\/[A-Za-z0-9._-]{1,100}$/;
const REF_TEXT = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const FILE_TEXT = /^[A-Za-z0-9._-]+(?:\/[A-Za-z0-9._-]+)*$/;
const FILE_CONTENT_LIMIT = 8192;
export const PULL_FILES_PAGE = 100;
const Sha = z.string().regex(SHA_TEXT);
const GithubPull = z.object({ number: z.number().int().positive(), state: z.enum(['open', 'closed']), merged: z.boolean(), merge_commit_sha: Sha.nullable(),
  head: z.object({ sha: Sha }), base: z.object({ repo: z.object({ id: z.number().int().positive(), full_name: z.string() }) }) });
const GithubCommits = z.array(z.object({ sha: Sha })).max(1);
const GithubFile = z.object({ type: z.literal('file'), encoding: z.literal('base64'), content: z.string().max(FILE_CONTENT_LIMIT) });
const GithubCompare = z.object({ status: z.enum(['ahead', 'behind', 'diverged', 'identical']) });
const GithubCommitPulls = z.array(z.object({ number: z.number().int().positive(), merge_commit_sha: Sha.nullable(), head: z.object({ sha: Sha }) }));
const GithubPullFiles = z.array(z.object({ filename: z.string().max(4096), previous_filename: z.string().max(4096).optional() })).max(PULL_FILES_PAGE);
export interface PublicPullReading { number: number; state: 'open' | 'closed'; merged: boolean; mergeCommit: string | null; headSha: string; baseRepoId: number; baseRepository: string }
export type CompareStatus = z.infer<typeof GithubCompare>['status'];
export interface PublicGithubReader {
  pull(repository: string, number: number, signal: AbortSignal): Promise<PublicPullReading>;
  // 그 ref에서 이 파일을 마지막으로 바꾼 commit. 파일 역사가 없으면 null이다.
  latestFileCommit(repository: string, path: string, ref: string, signal: AbortSignal): Promise<string | null>;
  // commit SHA로만 읽는다. 내용이 바뀌지 않아 호출자가 기억해 둘 수 있다. 파일이 없으면 null이다.
  fileAt(repository: string, path: string, commit: string, signal: AbortSignal): Promise<string | null>;
  // base 기준 head의 관계. 둘 중 하나가 저장소에 없으면 null이다.
  compare(repository: string, base: string, head: string, signal: AbortSignal): Promise<CompareStatus | null>;
  // 이 commit을 만든 병합 PR 목록.
  commitPulls(repository: string, commit: string, signal: AbortSignal): Promise<{ number: number; mergeCommit: string | null; headSha: string }[]>;
  // 한 쪽만 읽는다. 쪽이 가득 차면 뒤가 더 있을 수 있어 complete=false다.
  pullFiles(repository: string, number: number, signal: AbortSignal): Promise<{ complete: boolean; files: { path: string; previousPath: string | null }[] }>;
}
export function publicGithubReader(options: { send?: typeof fetch } = {}): PublicGithubReader {
  const send = options.send ?? fetch;
  const repo = (value: string) => { if (!REPOSITORY_TEXT.test(value) || value.split('/').some(part => part === '.' || part === '..')) throw new Error('unsupported_query'); return value; };
  const commit = (value: string) => { if (!SHA_TEXT.test(value)) throw new Error('unsupported_query'); return value; };
  const positive = (value: number) => { if (!Number.isSafeInteger(value) || value < 1) throw new Error('unsupported_query'); return value; };
  const file = (value: string) => { if (!FILE_TEXT.test(value) || value.split('/').some(part => part === '.' || part === '..')) throw new Error('unsupported_query'); return value; };
  const get = (path: string, signal: AbortSignal) => call(send, `${GITHUB_API}${path}`, { method: 'GET', signal,
    headers: { accept: 'application/vnd.github+json', 'user-agent': 'homelab-bot', 'x-github-api-version': '2022-11-28' } });
  const notFoundIsNull = async <T>(read: () => Promise<T>): Promise<T | null> => {
    try { return await read(); } catch (error) {
      if (error instanceof Error && error.message === 'read_http_404') return null;
      throw error;
    }
  };
  return {
    async pull(repository, number, signal) {
      const raw = GithubPull.parse(await get(`/repos/${repo(repository)}/pulls/${positive(number)}`, signal));
      return { number: raw.number, state: raw.state, merged: raw.merged, mergeCommit: raw.merge_commit_sha, headSha: raw.head.sha,
        baseRepoId: raw.base.repo.id, baseRepository: raw.base.repo.full_name };
    },
    async latestFileCommit(repository, path, ref, signal) {
      if (!REF_TEXT.test(ref)) throw new Error('unsupported_query');
      const query = new URLSearchParams({ sha: ref, path: file(path), per_page: '1' });
      const raw = GithubCommits.parse(await get(`/repos/${repo(repository)}/commits?${query}`, signal));
      return raw[0]?.sha ?? null;
    },
    async fileAt(repository, path, at, signal) {
      const target = `/repos/${repo(repository)}/contents/${file(path)}?ref=${commit(at)}`;
      return notFoundIsNull(async () => Buffer.from(GithubFile.parse(await get(target, signal)).content, 'base64').toString('utf8'));
    },
    async compare(repository, base, head, signal) {
      const target = `/repos/${repo(repository)}/compare/${commit(base)}...${commit(head)}?per_page=1`;
      return notFoundIsNull(async () => GithubCompare.parse(await get(target, signal)).status);
    },
    async commitPulls(repository, at, signal) {
      const raw = GithubCommitPulls.parse(await get(`/repos/${repo(repository)}/commits/${commit(at)}/pulls`, signal));
      return raw.map(pull => ({ number: pull.number, mergeCommit: pull.merge_commit_sha, headSha: pull.head.sha }));
    },
    async pullFiles(repository, number, signal) {
      const raw = GithubPullFiles.parse(await get(`/repos/${repo(repository)}/pulls/${positive(number)}/files?per_page=${PULL_FILES_PAGE}`, signal));
      return { complete: raw.length > 0 && raw.length < PULL_FILES_PAGE, files: raw.map(item => ({ path: item.filename, previousPath: item.previous_filename ?? null })) };
    },
  };
}

// 템플릿의 datasource 이름으로 transport를 고른다. 모르는 이름은 요청 없이 실패(관측 불가)다.
export function routedTransport(routes: Readonly<Record<string, ReadTransport>>): ReadTransport & { routes: readonly string[] } {
  return { routes: Object.freeze(Object.keys(routes)), async query(request) {
    const route = Object.hasOwn(routes, request.datasource) ? routes[request.datasource] : undefined;
    if (!route) throw new Error('unsupported_datasource');
    return route.query(request);
  } };
}
