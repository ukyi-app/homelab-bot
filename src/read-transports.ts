import { readFile } from 'node:fs/promises';
import { Agent } from 'undici';
import { z } from 'zod';
import type { ReadTransport } from './read.js';

// T16b 읽기 transport 셋. 원본 응답을 ReadAdapter가 받는 관측 JSON({observedAt, rows})으로 투영한다.
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
      // [미확인] VictoriaLogs 플러그인 v0.33.1의 질의 필드. 실연동(S16)에서 실제 응답으로 맞춘다.
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

const Application = z.object({ metadata: z.object({ name: z.string() }),
  status: z.object({ health: z.object({ status: z.string() }).optional(), sync: z.object({ status: z.string() }).optional() }).optional() });
// Argo CD GET /api/v1/applications/{name}. 앱 객체만 읽고 live 매니페스트(resource-tree·managed-resources)는 부르지 않는다.
export function argoCdTransport(options: { base: string; token: string; send?: typeof fetch }): ReadTransport {
  const send = options.send ?? fetch;
  const base = options.base.replace(/\/$/, '');
  return { async query(request) {
    if (!name.test(request.query)) throw new Error('unsupported_query');
    const app = Application.parse(await call(send, `${base}/api/v1/applications/${encodeURIComponent(request.query)}`,
      { method: 'GET', signal: request.signal, headers: { authorization: bearer(options.token), accept: 'application/json' } }));
    if (app.metadata.name !== request.query) throw new Error('unexpected_object');
    const health = app.status?.health?.status ?? 'Unknown', sync = app.status?.sync?.status ?? 'Unknown';
    const status = health === 'Healthy' ? (sync === 'Synced' ? 'healthy' : 'degraded')
      : health === 'Degraded' || health === 'Missing' ? 'degraded' : 'unknown';
    // [가정] API가 돌려준 상태는 컨트롤러의 최근 평가(재조정 주기 안)라 요청 시각의 관측으로 둔다.
    return encodeObservation(request.to, [{ status, text: text(`health=${health} sync=${sync}`) }], request);
  } };
}

const Workload = z.object({ metadata: z.object({ name: z.string(), namespace: z.string() }),
  spec: z.object({ replicas: z.number().int().nonnegative().optional() }).optional(),
  status: z.object({ readyReplicas: z.number().int().optional(), availableReplicas: z.number().int().optional(),
    updatedReplicas: z.number().int().optional() }).optional() });
const workload = /^(deployment|statefulset)\/([a-z0-9]([-a-z0-9]{0,61}[a-z0-9])?)$/;
export const SERVICE_ACCOUNT = Object.freeze({
  token: '/var/run/secrets/kubernetes.io/serviceaccount/token',
  ca: '/var/run/secrets/kubernetes.io/serviceaccount/ca.crt',
});
// Kubernetes API(D8: in-cluster SA bot-reader). Deployment·StatefulSet 객체 하나만 GET한다.
// 토큰은 kubelet이 갈아 끼우므로 요청마다 다시 읽는다. CA는 처음 쓸 때 읽어 연결 풀을 만든다.
export function kubernetesTransport(options: { base: string; tokenFile: string; caFile: string | null; send?: typeof fetch;
  readText?: (path: string) => Promise<string> }): ReadTransport & { close(): Promise<void> } {
  const send = options.send ?? fetch;
  const readText = options.readText ?? (path => readFile(path, 'utf8'));
  const base = options.base.replace(/\/$/, '');
  let dispatcher: Promise<Agent | undefined> | undefined;
  const agent = () => dispatcher ??= options.caFile === null ? Promise.resolve(undefined)
    : readText(options.caFile).then(ca => new Agent({ connect: { ca } })).catch(error => { dispatcher = undefined; throw error; });
  return {
    async query(request) {
      const match = workload.exec(request.query);
      if (!match || !name.test(request.namespace)) throw new Error('unsupported_query');
      const [, kind, object] = match as unknown as [string, 'deployment' | 'statefulset', string];
      const token = (await readText(options.tokenFile)).trim();
      if (!token || /\s/.test(token)) throw new Error('service_account_token');
      const raw = Workload.parse(await call(send, `${base}/apis/apps/v1/namespaces/${request.namespace}/${kind}s/${object}`,
        { method: 'GET', signal: request.signal, dispatcher: await agent(),
          headers: { authorization: bearer(token), accept: 'application/json' } }));
      if (raw.metadata.name !== object || raw.metadata.namespace !== request.namespace) throw new Error('unexpected_object');
      const desired = raw.spec?.replicas ?? 1, ready = raw.status?.readyReplicas ?? 0;
      const available = raw.status?.availableReplicas ?? 0, updated = raw.status?.updatedReplicas ?? 0;
      const healthy = desired >= 1 && ready >= desired && available >= desired && updated >= desired;
      return encodeObservation(request.to, [{ status: healthy ? 'healthy' : 'degraded', value: ready }], request);
    },
    async close() { const current = await dispatcher?.catch(() => undefined); await current?.close().catch(() => {}); },
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
