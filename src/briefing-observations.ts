import { z } from 'zod';
import { localDate, validZone } from './briefing.js';
import type { Observation, ObservationSource, RestoreCheck } from './briefing.js';
import type { Clock } from './contracts.js';
import type { ReadTransport } from './read.js';
import type { KubernetesClient } from './read-transports.js';

// 일일 브리핑의 실제 관측 원본(T20 2단계 B5, T24). 봇 SA(ClusterRole homelab-readonly)와 /read의 Grafana 자격으로 읽히는 것만 연결한다.
// - 백업: CNPG Cluster 조건과 Backup CR(postgresql.cnpg.io clusters·backups get/list).
// - 예약 작업: CronJob 목록과 그 Job(batch cronjobs list, jobs list).
// - 인증서: cert-manager 지표(수집 job cert-manager)를 /read와 같은 Grafana transport로 집계 질의한다(T24 계약 1·3).
//   클러스터 안 Certificate CR만 본다. 공개 TLS(Cloudflare 종단)·ts.net 인증서는 cert-manager 밖이라 범위 밖이다.
// - 복원 검증: `homelab db restore-check`가 Cluster pg에 남기는 annotation 두 개(T24 계약 2)를 백업 원본이 이미 읽는
//   Cluster 응답에서 읽는다. 기록은 CLI가 쓴 것이라 "CLI 기록 기준"으로 적고, 기록 오류는 복원 검증만 미확인으로 둔다.
// 관측 시각은 요청 직전 시각이다. Kubernetes API는 현재 상태를 돌려주므로 "오래된 값"은 원본 안의 시각(백업 완료,
// Job 시작)으로 판단한다. 읽기 실패·권한 없음(403)·모양이 틀린 응답은 throw해 브리핑이 읽기 불가·미확인으로 적게 한다.
// 요약에는 객체 이름과 나이만 넣는다. Backup의 status.error 같은 원문은 저장소 주소·경로가 섞일 수 있어 넣지 않는다.

// 브리핑의 원본 시간 제한(BRIEFING.sourceTimeoutMs 10초)보다 짧게 끊어 늦은 요청이 뒤에 남지 않게 한다.
export const OBSERVATION_TIMEOUT_MS = 8000;
// homelab vmalert PGBackupStale과 같은 기준(마지막 성공 백업 26시간). 매일 백업에 2시간 여유다.
export const BACKUP_STALE_MS = 26 * 3_600_000;
// CronJob 한 회차가 이보다 오래 실행 중이면 멈춘 것으로 본다. 일정(cron 식)은 해석하지 않는다(아래 한계).
export const JOB_RUNNING_LIMIT_MS = 24 * 3_600_000;
// 운영 공유 CNPG 클러스터(homelab platform/cnpg/cluster). 바뀌면 여기와 봇 RBAC 범위를 함께 본다.
export const BACKUP_CLUSTERS: readonly { namespace: string; cluster: string }[] = Object.freeze([{ namespace: 'database', cluster: 'pg' }]);
const NAMES_SHOWN = 5;
const DAY = 86_400_000;
// homelab vmalert 인증서 경보의 warning 기준(만료 7일 미만)과 같다. 갱신은 만료 15일 전이라 7일이면 갱신이 8일 넘게 실패한 것이다.
export const CERT_EXPIRY_WARN_MS = 7 * DAY;
// 지표 신선도 상한(초). 수집이 멈추면 마지막 값이 이만큼 지난 뒤 오래됨으로 본다.
export const CERT_METRICS_STALE_SECONDS = 600;
// 집계 질의만 쓴다. Grafana transport가 라벨을 버려 인증서별 값을 구분할 수 없고, 코드에 인증서 이름을 박지 않는다.
export const CERT_QUERIES = Object.freeze({
  count: 'count(certmanager_certificate_expiration_timestamp_seconds)',
  // 발급 전 인증서는 만료 값이 0이라 1970년이 가장 이른 만료로 잡힌다. 0을 빼고, 그런 인증서는 Ready 수 불일치로 잡힌다.
  earliest: 'min(certmanager_certificate_expiration_timestamp_seconds > 0)',
  ready: 'count(certmanager_certificate_ready_status{condition="True"} == 1)',
  age: 'max(time() - timestamp(certmanager_certificate_expiration_timestamp_seconds))',
});
// restore-check 기록(T24 계약 2). last: 마지막으로 끝난 시도, pass: 마지막 통과(실패는 이 키를 건드리지 않음).
export const RESTORE_ANNOTATIONS = Object.freeze({
  last: 'homelab.ukyi.app/restore-check-last', pass: 'homelab.ukyi.app/restore-check-pass' });
export const RESTORE_STALE_MS = 100 * DAY;

const Time = z.string().transform((value, ctx) => {
  const at = Date.parse(value);
  if (!Number.isFinite(at)) { ctx.addIssue({ code: 'custom', message: 'bad_time' }); return z.NEVER; }
  return at;
});
const Meta = z.object({ name: z.string(), namespace: z.string(), uid: z.string().optional(), creationTimestamp: Time.optional() });
const Condition = z.object({ type: z.string(), status: z.string() });
// annotations는 모양을 여기서 강제하지 않는다. 복원 기록이 틀려도 Cluster 파싱(백업 판정)이 실패하지 않게 restoreCheck가 따로 본다.
const Cluster = z.object({ metadata: Meta.extend({ annotations: z.unknown().optional() }), status: z.object({ conditions: z.array(Condition).optional() }).optional() });
const Backup = z.object({ metadata: Meta, spec: z.object({ cluster: z.object({ name: z.string() }) }),
  status: z.object({ phase: z.string().optional(), startedAt: Time.optional(), stoppedAt: Time.optional() }).optional() });
const CronJob = z.object({ metadata: Meta, spec: z.object({ suspend: z.boolean().optional() }).optional(),
  status: z.object({ lastScheduleTime: Time.optional(),
    active: z.array(z.object({ name: z.string(), uid: z.string().optional() })).optional() }).optional() });
const Job = z.object({
  metadata: Meta.extend({ annotations: z.record(z.string(), z.string()).optional(),
    ownerReferences: z.array(z.object({ kind: z.string(), name: z.string(), uid: z.string().optional() })).optional() }),
  status: z.object({ startTime: Time.optional(), conditions: z.array(Condition).optional() }).optional() });
type CronJob = z.infer<typeof CronJob>;
type Job = z.infer<typeof Job>;
// CronJob 컨트롤러가 Job에 다는 예약 시각(RFC3339). 없으면 컨트롤러의 이름 규칙 <CronJob>-<예약 시각 분>으로 연결한다.
const SCHEDULED_AT = 'batch.kubernetes.io/cronjob-scheduled-timestamp';
const list = <T extends z.ZodTypeAny>(item: T) => z.object({ items: z.array(item) });

const hours = (ms: number) => `${Math.max(0, Math.floor(ms / 3_600_000))}시간 전`;
const names = (values: string[]) => values.length > NAMES_SHOWN
  ? `${values.slice(0, NAMES_SHOWN).join(', ')} 외 ${values.length - NAMES_SHOWN}개` : values.join(', ');
const k8sName = /^[a-z0-9]([-a-z0-9]{0,61}[a-z0-9])?$/;

// 기록 값 스키마 v1. 시각은 RFC3339 UTC(Z)만 받는다. 통과는 확인한 DB가 1개 이상이고(0개는 실패 no_db) reason이 없다.
const UtcTime = z.string().regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,9})?Z$/).pipe(Time);
const RestoreRecord = z.strictObject({ v: z.literal(1), run: z.string().min(1).max(128), result: z.enum(['pass', 'fail']),
  at: UtcTime, target: UtcTime, server: z.string().min(1).max(253), dbs: z.number().int().nonnegative(), cluster: z.string().min(1).max(128),
  reason: z.string().regex(/^[a-z][a-z0-9_]{0,31}$/).optional() })
  .refine(r => r.result === 'fail' ? r.reason !== undefined : r.reason === undefined && r.dbs >= 1);
type RestoreIssue = NonNullable<RestoreCheck['issue']>;
// 기록 하나를 읽는다. 없으면 undefined, 쓸 수 없으면 사유. 다른 Cluster(지웠다 다시 만든 pg 포함)의 기록과 미래 시각은 믿지 않는다.
function restoreRecord(raw: unknown, expect: 'pass' | undefined, uid: string | undefined, observedAt: number):
  { result: 'pass' | 'fail'; at: number } | { issue: RestoreIssue } | undefined {
  if (raw === undefined) return undefined;
  if (typeof raw !== 'string' || raw.length > 1024) return { issue: 'format' };
  let json: unknown;
  try { json = JSON.parse(raw); } catch { return { issue: 'format' }; }
  const parsed = RestoreRecord.safeParse(json);
  if (!parsed.success || (expect !== undefined && parsed.data.result !== expect)) return { issue: 'format' };
  if (uid === undefined || parsed.data.cluster !== uid) return { issue: 'cluster' };
  if (parsed.data.at > observedAt) return { issue: 'future' };
  return { result: parsed.data.result, at: parsed.data.at };
}
// 복원 검증 판정. 백업 status와 섞지 않는다(브리핑이 따로 적음). 예상 못 한 값도 throw하지 않고 미확인으로 둔다.
export function restoreCheck(annotations: unknown, uid: string | undefined, observedAt: number): RestoreCheck {
  try {
    const values = annotations === undefined ? {} : annotations;
    if (typeof values !== 'object' || values === null || Array.isArray(values)) throw new Error('bad_annotations');
    const read = (key: string) => Object.hasOwn(values, key) ? (values as Record<string, unknown>)[key] : undefined;
    const pass = restoreRecord(read(RESTORE_ANNOTATIONS.pass), 'pass', uid, observedAt);
    const last = restoreRecord(read(RESTORE_ANNOTATIONS.last), undefined, uid, observedAt);
    const passAt = pass && 'at' in pass ? pass.at : null;
    const failedAt = last && 'at' in last && last.result === 'fail' && (passAt === null || last.at > passAt) ? last.at : null;
    const age = passAt === null ? 0 : observedAt - passAt;
    const staleDays = passAt !== null && age > RESTORE_STALE_MS ? Math.floor(age / DAY) : null;
    const issue = (pass && 'issue' in pass ? pass.issue : undefined) ?? (last && 'issue' in last ? last.issue : undefined) ?? null;
    const status = failedAt !== null || staleDays !== null ? 'problem' : passAt !== null ? 'verified' : 'unknown';
    return { status, passAt, failedAt, staleDays, issue };
  } catch {
    return { status: 'unknown', passAt: null, failedAt: null, staleDays: null, issue: 'format' };
  }
}

// CNPG 백업. 성공은 phase completed의 stoppedAt만 센다. Cluster 조건으로 WAL 아카이브와 마지막 백업 결과를 함께 본다.
export function backupSource(kubernetes: Pick<KubernetesClient, 'get'>, now: Clock,
  target: { namespace: string; cluster: string }): ObservationSource {
  const { namespace, cluster } = target;
  if (!k8sName.test(namespace) || !k8sName.test(cluster)) throw new Error('invalid_backup_target');
  return { id: `backup:${namespace}/${cluster}`, label: `PostgreSQL 백업(${cluster})`, kind: 'backup', async read(): Promise<Observation> {
    const observedAt = now();
    const signal = AbortSignal.timeout(OBSERVATION_TIMEOUT_MS);
    const [rawCluster, rawBackups] = await Promise.all([
      kubernetes.get(`/apis/postgresql.cnpg.io/v1/namespaces/${namespace}/clusters/${cluster}`, signal),
      kubernetes.get(`/apis/postgresql.cnpg.io/v1/namespaces/${namespace}/backups?labelSelector=${encodeURIComponent(`cnpg.io/cluster=${cluster}`)}`, signal),
    ]);
    const state = Cluster.parse(rawCluster);
    if (state.metadata.name !== cluster || state.metadata.namespace !== namespace) throw new Error('unexpected_object');
    // 라벨 선택이 무시돼도 다른 클러스터의 백업을 세지 않게 spec으로 한 번 더 거른다.
    const backups = list(Backup).parse(rawBackups).items.filter(b => b.metadata.namespace === namespace && b.spec.cluster.name === cluster);
    const condition = (type: string) => state.status?.conditions?.find(c => c.type === type)?.status;
    const problems: string[] = [];
    const archiving = condition('ContinuousArchiving');
    if (archiving !== 'True') problems.push(archiving === undefined ? 'WAL 아카이브 상태 없음' : 'WAL 아카이브 실패');
    if (condition('LastBackupSucceeded') === 'False') problems.push('클러스터가 마지막 백업 실패를 보고');
    const done = backups.flatMap(b => b.status?.phase === 'completed' && b.status.stoppedAt !== undefined ? [b.status.stoppedAt] : []);
    const age = done.length ? observedAt - Math.max(...done) : undefined;
    if (age === undefined) problems.push('완료된 백업 없음');
    else if (age > BACKUP_STALE_MS) problems.push(`마지막 성공 백업 ${hours(age)}(26시간 기준 초과)`);
    const fresh = age !== undefined && age <= BACKUP_STALE_MS ? [`마지막 성공 백업 ${hours(age)}`] : [];
    // 가장 최근에 시작한 백업이 실패했으면 그 뒤 성공이 없다는 뜻이다. 진행 중은 문제로 보지 않는다(다음 브리핑에서 다시 본다).
    const started = (b: z.infer<typeof Backup>) => b.status?.startedAt ?? b.metadata.creationTimestamp ?? 0;
    const latest = backups.reduce<z.infer<typeof Backup> | undefined>((a, b) => !a || started(b) > started(a) ? b : a, undefined);
    if (latest?.status?.phase === 'failed') problems.push(`최근 백업 실패(${latest.metadata.name})`);
    else if (latest?.status?.phase === 'walArchivingFailing') problems.push(`최근 백업의 WAL 아카이브 실패(${latest.metadata.name})`);
    const restore = restoreCheck(state.metadata.annotations, state.metadata.uid, observedAt);
    const verified = { restoreVerifiedAt: restore.passAt, restoreCheck: restore };
    return problems.length
      ? { observedAt, status: 'problem', summary: [...problems, ...fresh].join(', '), ...verified }
      : { observedAt, status: 'ok', summary: `${fresh[0]} · WAL 아카이브 정상`, ...verified };
  } };
}

// CronJob 하나의 판정. reason이 있으면 확인 필요, running이면 마지막 회차가 아직 실행 중(정상)이다.
// CronJob status만으로는 판정하지 않는다. concurrencyPolicy Allow면 lastScheduleTime이 새 회차마다 갱신돼 옛 Job의
// 장기 실행을 가리고, lastSuccessfulTime은 어느 회차의 성공인지 모른다(이전 회차가 마지막 회차 실패 뒤에 성공할 수 있다).
// 그래서 active가 가리키는 Job의 시작 시각과, 마지막 예약 회차에 해당하는 Job의 조건을 본다.
// 연결하지 못하거나 시각·조건을 못 읽으면 정상으로 두지 않는다. 관측 상태가 ok·problem 둘뿐이라 "미확인" 문구를 단 확인 필요로 낸다
// (원본 전체를 throw하면 다른 CronJob의 관측까지 읽기 불가가 된다).
function judgeCronJob(cron: CronJob, jobs: Job[], observedAt: number): { reason?: string; running?: boolean } {
  if (cron.spec?.suspend) return { reason: '일시 중지' };
  const at = cron.status?.lastScheduleTime;
  if (at === undefined) return { reason: '실행 기록 없음' };
  const active = cron.status?.active ?? [];
  // active 항목은 이름과 uid로 찾는다. 같은 이름으로 다시 만든 Job(uid 다름)은 다른 Job이다.
  const find = (ref: { name: string; uid?: string | undefined }) =>
    jobs.find(j => j.metadata.name === ref.name && (ref.uid === undefined || j.metadata.uid === ref.uid));
  const starts = active.map(ref => find(ref)?.status?.startTime);
  if (starts.some(start => start !== undefined && observedAt - start > JOB_RUNNING_LIMIT_MS)) return { reason: '24시간 넘게 실행 중' };
  if (starts.some(start => start === undefined)) return { reason: '실행 중 Job 시작 시각 미확인' };

  const owned = (j: Job) => j.metadata.ownerReferences?.some(o => o.kind === 'CronJob' && o.name === cron.metadata.name
    && (cron.metadata.uid === undefined || o.uid === cron.metadata.uid)) ?? false;
  const scheduled = (j: Job) => {
    const value = j.metadata.annotations?.[SCHEDULED_AT];
    // annotation 값이 틀리면 NaN이라 어느 회차와도 연결되지 않는다(성공을 확정하지 않는 쪽).
    return value !== undefined ? Date.parse(value) === at : j.metadata.name === `${cron.metadata.name}-${Math.floor(at / 60_000)}`;
  };
  const last = jobs.find(j => owned(j) && scheduled(j));
  // 이력 정리(successfulJobsHistoryLimit·ttlSecondsAfterFinished)로 지워졌을 수 있다. 성공이었는지 알 수 없다.
  if (!last) return { reason: '마지막 회차 Job 없음 · 결과 미확인' };
  const condition = (type: string) => last.status?.conditions?.some(c => c.type === type && c.status === 'True') ?? false;
  if (condition('Failed')) return { reason: '마지막 실행 실패' };
  if (condition('Complete')) return {};
  // 아직 끝나지 않은 마지막 회차. active에 있으면 위에서 시작 시각을 봤다.
  if (active.some(ref => find(ref) === last)) return { running: true };
  const start = last.status?.startTime;
  if (start === undefined) return { reason: '마지막 회차 결과 미확인' };
  return observedAt - start > JOB_RUNNING_LIMIT_MS ? { reason: '24시간 넘게 실행 중' } : { running: true };
}

// CronJob 전체(클러스터 범위 list)와, 판정에 필요한 namespace의 Job 목록. 마지막 회차의 결과와 실행 중 Job의 시작 시각을 본다.
// 한계: cron 식을 해석하지 않아 컨트롤러가 회차를 건너뛴 것은 여기서 못 잡는다(homelab 경보 몫).
export function scheduledJobSource(kubernetes: Pick<KubernetesClient, 'get'>, now: Clock): ObservationSource {
  return { id: 'scheduled_job:cronjobs', label: '예약 작업(CronJob)', kind: 'scheduled_job', async read(): Promise<Observation> {
    const observedAt = now();
    const signal = AbortSignal.timeout(OBSERVATION_TIMEOUT_MS);
    const crons = list(CronJob).parse(await kubernetes.get('/apis/batch/v1/cronjobs', signal)).items;
    // 목록이 비어도 질의가 성공했으면 "없다"는 관측이다. 백업 예약(CNPG ScheduledBackup)은 CronJob이 아니라 백업 항목에서 본다.
    if (!crons.length) return { observedAt, status: 'ok', summary: '등록된 CronJob 없음' };
    // Job은 판정에 쓰는 namespace만 읽는다(클러스터 전체 Job 목록은 응답 상한에 걸리기 쉽다). 경로에 넣기 전에 이름 모양을 검사한다.
    const namespaces = [...new Set(crons.filter(c => !c.spec?.suspend && c.status?.lastScheduleTime !== undefined)
      .map(c => c.metadata.namespace))];
    if (namespaces.some(ns => !k8sName.test(ns))) throw new Error('unexpected_object');
    const jobs = new Map(await Promise.all(namespaces.map(async ns => [ns,
      list(Job).parse(await kubernetes.get(`/apis/batch/v1/namespaces/${ns}/jobs`, signal)).items
        .filter(j => j.metadata.namespace === ns)] as const)));
    const problems: string[] = [];
    let running = 0;
    for (const cron of crons) {
      const verdict = judgeCronJob(cron, jobs.get(cron.metadata.namespace) ?? [], observedAt);
      if (verdict.reason) problems.push(`${cron.metadata.namespace}/${cron.metadata.name}(${verdict.reason})`);
      else if (verdict.running) running++;
    }
    if (problems.length) return { observedAt, status: 'problem', summary: `CronJob ${crons.length}개 중 확인 필요 ${problems.length}개: ${names(problems)}` };
    return { observedAt, status: 'ok', summary: running
      ? `CronJob ${crons.length}개 중 마지막 실행 성공 ${crons.length - running}개, 실행 중 ${running}개`
      : `CronJob ${crons.length}개 마지막 실행 성공` };
  } };
}

// 집계 질의 하나의 값. 빈 결과(시계열 없음)는 undefined, 시계열이 둘 이상이면 집계가 아니라 모양 오류다.
const Scalar = z.strictObject({ observedAt: z.number(), rows: z.array(z.strictObject({ value: z.number() })).max(1) });
export interface CertificateMetrics { transport: Pick<ReadTransport, 'query'>; datasource: string }
// cert-manager 인증서. 질의 실패·응답 모양 오류는 throw한다(브리핑이 읽기 불가·미확인으로 적음).
// zone은 만료 날짜를 적는 시간대다(브리핑 시간대). 틀리면 UTC로 적는다.
export function certificateSource(metrics: CertificateMetrics, now: Clock, zone = 'UTC'): ObservationSource {
  const timeZone = validZone(zone) ? zone : 'UTC';
  return { id: 'certificate:cert-manager', label: '인증서(cert-manager)', kind: 'certificate', async read(): Promise<Observation> {
    const observedAt = now();
    const signal = AbortSignal.timeout(OBSERVATION_TIMEOUT_MS);
    const scalar = async (query: string) => {
      // limit 2: 집계가 아닌 결과(시계열 여럿)를 잘라 내지 않고 모양 오류로 잡는다.
      const bytes = await metrics.transport.query({ datasource: metrics.datasource, namespace: '', query, from: observedAt - 300_000,
        to: observedAt, limit: 2, maxBytes: 4096, timeoutMs: OBSERVATION_TIMEOUT_MS, signal });
      return Scalar.parse(JSON.parse(new TextDecoder().decode(bytes))).rows[0]?.value;
    };
    const [count, earliest, ready, age] = await Promise.all([CERT_QUERIES.count, CERT_QUERIES.earliest, CERT_QUERIES.ready, CERT_QUERIES.age].map(scalar));
    // count()는 시계열이 없으면 빈 결과다. 인증서 0개(또는 수집 대상 없음)와 Ready 0개는 0으로 본다.
    const total = count ?? 0, readyCount = ready ?? 0;
    if (!Number.isSafeInteger(total) || total < 0 || !Number.isSafeInteger(readyCount) || readyCount < 0) throw new Error('unexpected_metric');
    if (total === 0) return { observedAt, status: 'problem', summary: '인증서 지표 0개(cert-manager 수집·인증서 확인 필요)' };
    // 개수가 있는데 신선도 값이 없으면 같은 시계열에 대한 답이 서로 맞지 않는다.
    if (age === undefined || !Number.isFinite(age)) throw new Error('unexpected_metric');
    // 만료 값이 모두 0(전부 발급 전)이면 min 결과가 빈다. 모양 오류가 아니라 관측된 문제다.
    if (earliest !== undefined && !Number.isFinite(earliest)) throw new Error('unexpected_metric');
    const left = earliest === undefined ? undefined : earliest * 1000 - observedAt;
    const expiry = earliest === undefined || left === undefined ? []
      : [`가장 이른 만료 ${localDate(earliest * 1000, timeZone)}(${left >= 0 ? `${Math.floor(left / DAY)}일` : '만료됨'})`];
    const problems: string[] = [];
    if (left === undefined) problems.push('만료 시각 없음');
    else if (left < 0) problems.push('만료된 인증서 있음');
    else if (left < CERT_EXPIRY_WARN_MS) problems.push('만료 임박(7일 미만)');
    if (readyCount < total) problems.push(`Ready 아님 ${total - readyCount}개(전체 ${total}개)`);
    else if (readyCount > total) problems.push(`Ready 수 불일치(Ready ${readyCount}, 전체 ${total})`);
    if (age > CERT_METRICS_STALE_SECONDS) problems.push(`지표 오래됨 ${Math.floor(age / 60)}분(10분 기준 초과)`);
    return problems.length
      ? { observedAt, status: 'problem', summary: [problems.join(', '), ...expiry].join(' · ') }
      : { observedAt, status: 'ok', summary: [`${total}개 모두 Ready`, ...expiry].join(' · ') };
  } };
}

// 진입점이 BriefingScheduler에 넣는 관측 원본. kubernetes는 읽기 transport와 같은 연결(kubernetesTransport 반환값)을 쓴다.
// certificates는 /read의 Grafana transport와 메트릭 datasource uid다. 없으면 인증서 원본을 만들지 않는다
// (브리핑이 "인증서: 연결된 조회 없음 · 미확인"으로 적음).
export function briefingSources(transports: { kubernetes: Pick<KubernetesClient, 'get'>; certificates?: CertificateMetrics | undefined },
  now: Clock, zone?: string): ObservationSource[] {
  return [...BACKUP_CLUSTERS.map(target => backupSource(transports.kubernetes, now, target)),
    ...(transports.certificates ? [certificateSource(transports.certificates, now, zone)] : []),
    scheduledJobSource(transports.kubernetes, now)];
}
