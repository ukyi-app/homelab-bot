import { z } from 'zod';
import { Denied, PolicyUnavailable } from './contracts.js';
import type { Clock, Scope } from './contracts.js';
import type { PolicyGate } from './policy.js';
import { bounded, summaryItems } from './format.js';

export interface Service {
  id: string; repository: string; namespace: string; deployment: string;
  internalDomain: string | null; externalDomain: string | null; documentation: string[];
}
export interface QueryTemplate {
  id: string; service: string; datasource: string; namespace: string;
  kind: 'status' | 'metrics' | 'logs'; query: string;
  maxWindowSeconds: number; maxBytes: number; maxRows: number;
}
// timeoutMs가 지나면 ReadAdapter가 signal을 abort한다. 구현은 signal로 실제 요청·연결을 끊어야 한다.
// 끊지 않으면 Runtime은 다음 작업으로 넘어가도 조회가 직렬성 밖에 남는다.
export interface ReadTransport {
  query(request: { datasource: string; namespace: string; query: string;
    from: number; to: number; limit: number; maxBytes: number; timeoutMs: number; signal: AbortSignal }): Promise<Uint8Array>;
}
const READ_TIMEOUT_MS = 5000;
const RequestSchema = z.strictObject({ service: z.string(), template: z.string(), from: z.number().finite(), to: z.number().finite() });
const ObservationSchema = z.strictObject({ observedAt: z.number().finite(),
  rows: z.array(z.strictObject({ status: z.enum(['healthy', 'degraded', 'unknown']).optional(),
    value: z.number().finite().optional(), text: z.string().max(1000).optional() })) });
export interface ReadResult {
  service: string; source: string | null; window: { from: number; to: number };
  observedAt: number | null; status: 'unregistered' | 'unobservable' | 'observed';
  facts: string[]; hypotheses: string[]; unknowns: string[]; checks: string[];
  untrusted: string[];
}
export class ReadAdapter {
  private readonly services: Map<string, Service>;
  private readonly templates: Map<string, QueryTemplate>;
  constructor(services: Service[], templates: QueryTemplate[], private readonly gate: PolicyGate,
    private readonly transport: ReadTransport, private readonly now: Clock = Date.now) {
    this.services = new Map(services.map(s => [s.id, structuredClone(s)]));
    this.templates = new Map(templates.map(t => {
      const service = this.services.get(t.service);
      const maxWindow = t.kind === 'logs' ? 3600 : t.kind === 'metrics' ? 21600 : 300;
      if (!service || service.namespace !== t.namespace || !Number.isFinite(t.maxWindowSeconds)
        || t.maxWindowSeconds < 1 || t.maxWindowSeconds > maxWindow
        || t.maxRows < 1 || t.maxRows > 200 || t.maxBytes < 1 || t.maxBytes > 65536
        || t.query.length > 2000 || !t.query || !t.datasource) throw new Denied();
      return [t.id, structuredClone(t)];
    }));
  }
  async recent(actor: string, scope: Scope, request: { service: string; template: string }): Promise<ReadResult> {
    const template = this.templates.get(request.template);
    const to = this.now();
    // 템플릿 상한 전체를 본다. 60초로 자르면 logs는 거의 늘 0줄이다(S16). 행 수·바이트 상한과 관측 신선도(5분)는 그대로다.
    const seconds = template?.service === request.service ? template.maxWindowSeconds : 60;
    return this.read(actor, scope, { ...request, from: to - seconds * 1000, to });
  }
  async read(actor: string, scope: Scope, request: unknown): Promise<ReadResult> {
    const r = RequestSchema.parse(request);
    const p = await this.gate.authorize(actor, scope);
    const base: ReadResult = { service: r.service, source: null, window: { from: r.from, to: r.to },
      observedAt: null, status: 'unobservable', facts: [], hypotheses: [], unknowns: [], checks: [], untrusted: [] };
    const service = this.services.get(r.service);
    if (!service) return { ...base, status: 'unregistered', unknowns: ['등록되지 않은 서비스'] };
    if (!p.services.includes(r.service)) throw new Denied();
    // 없는 템플릿·다른 서비스의 템플릿은 권한 경계가 아니라 입력 오류다. 조회 없이 미등록 답을 돌려준다.
    // Denied로 던지면 runtime이 권한 철회(authorization_revoked)로 기록하고 사용자에게 아무 답도 가지 않는다(S16).
    // 서비스 권한(위의 정책 services)과 시간창 우회는 그대로 거부다.
    const t = this.templates.get(r.template);
    if (!t || t.service !== service.id || t.namespace !== service.namespace) {
      return { ...base, status: 'unregistered', unknowns: ['등록되지 않은 조회 템플릿'] };
    }
    if (r.from >= r.to || r.to > this.now() || r.to - r.from > t.maxWindowSeconds * 1000) throw new Denied();
    base.source = t.id;
    try {
      let timeout: ReturnType<typeof setTimeout> | undefined;
      let bytes: Uint8Array;
      const abort = new AbortController();
      try {
        bytes = await Promise.race([
          this.transport.query({ datasource: t.datasource, namespace: t.namespace, query: t.query,
            from: r.from, to: r.to, limit: t.maxRows, maxBytes: t.maxBytes, timeoutMs: READ_TIMEOUT_MS, signal: abort.signal }),
          new Promise<never>((_, reject) => { timeout = setTimeout(() => {
            const error = new Error('read_timeout');
            abort.abort(error); reject(error);
          }, READ_TIMEOUT_MS); }),
        ]);
      } finally { clearTimeout(timeout); }
      if (bytes.byteLength > t.maxBytes) throw new Error('response_budget');
      const data = ObservationSchema.parse(JSON.parse(new TextDecoder().decode(bytes)));
      if (data.rows.length > t.maxRows || data.observedAt > this.now() || data.observedAt < r.from || data.observedAt > r.to
        || this.now() - data.observedAt > 300_000) throw new Error('stale_or_oversized');
      if (!data.rows.length) throw new Error('no_observation');
      if (!(await this.gate.authorize(actor, scope, p.revision)).services.includes(r.service)) throw new Denied();
      return { ...base, observedAt: data.observedAt, status: 'observed',
        facts: data.rows.flatMap(row => [row.status ? `상태: ${row.status}` : '', row.value !== undefined ? `값: ${row.value}` : ''].filter(Boolean)),
        unknowns: t.kind === 'status' ? ['메트릭·로그는 조회하지 않음', '복원 가능 여부는 확인하지 않음'] : [],
        untrusted: data.rows.flatMap(row => row.text ? [row.text] : []) };
    } catch (error) {
      if (error instanceof Denied || error instanceof PolicyUnavailable) throw error;
      return { ...base, unknowns: ['현재 관측 자료를 확인할 수 없음'], checks: ['승인된 조회 경로와 관측 시각 확인'] };
    }
  }
}
// Public threads only get deterministic metadata/status, never raw logs or model declassification.
// 시각은 ISO-8601 UTC 초 단위다(epoch ms 숫자는 사람이 읽지 못한다, S16).
// 미등록 답은 시간창 검사 전에 돌아오므로 Date 범위 밖 값이 올 수 있다. 그때는 숫자 그대로 둔다(toISOString이 던진다).
export function isoSeconds(ms: number): string {
  const date = new Date(ms);
  return Number.isNaN(date.getTime()) ? String(ms) : date.toISOString().replace(/\.\d{3}Z$/, 'Z');
}
export function readSummary(result: ReadResult): string {
  return [`대상: ${bounded(result.service, 120)}`, `출처: ${bounded(result.source ?? '없음', 120)}`,
    `시간창: ${isoSeconds(result.window.from)}~${isoSeconds(result.window.to)}`,
    `관측 시각: ${result.observedAt === null ? '미확인' : isoSeconds(result.observedAt)}`, `사실: ${summaryItems(result.facts, 600)}`,
    '가설: 없음', `미확인: ${summaryItems(result.unknowns, 350)}`, `권장 확인: ${summaryItems(result.checks, 350)}`].join('\n');
}
