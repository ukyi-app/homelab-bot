import { z } from 'zod';
import type { Observation, ObservationSource } from './briefing.js';
import type { Clock } from './contracts.js';
import type { KubernetesClient } from './read-transports.js';

// 일일 브리핑의 실제 관측 원본(T20 2단계 B5). 봇 SA(ClusterRole homelab-readonly)로 읽히는 것만 연결한다.
// - 백업: CNPG Cluster 조건과 Backup CR(postgresql.cnpg.io clusters·backups get/list).
// - 예약 작업: CronJob 목록(batch cronjobs list).
// - 인증서: 연결하지 않는다. 봇 RBAC에 cert-manager.io가 없고 cert-manager 지표도 수집되지 않는다(2026-11-02 실측).
//   브리핑은 연결하지 않은 종류를 "연결된 조회 없음 · 미확인"으로 적는다(briefing.ts observations).
// - 복원 검증: 연결하지 않는다. `homelab db restore-check`의 실행 기록(ConfigMap)은 끝나면 지워지고 봇은 ConfigMap을 못 읽는다.
//   그래서 restoreVerifiedAt은 늘 null(브리핑에 "복원 검증 미확인(백업 성공과 별개)")이다. 백업 성공으로 채우지 않는다.
// 관측 시각은 요청 직전 시각이다. Kubernetes API는 현재 상태를 돌려주므로 "오래된 값"은 원본 안의 시각(백업 완료,
// CronJob 마지막 성공)으로 판단한다. 읽기 실패·권한 없음(403)·모양이 틀린 응답은 throw해 브리핑이 읽기 불가·미확인으로 적게 한다.
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

const Time = z.string().transform((value, ctx) => {
  const at = Date.parse(value);
  if (!Number.isFinite(at)) { ctx.addIssue({ code: 'custom', message: 'bad_time' }); return z.NEVER; }
  return at;
});
const Meta = z.object({ name: z.string(), namespace: z.string(), creationTimestamp: Time.optional() });
const Condition = z.object({ type: z.string(), status: z.string() });
const Cluster = z.object({ metadata: Meta, status: z.object({ conditions: z.array(Condition).optional() }).optional() });
const Backup = z.object({ metadata: Meta, spec: z.object({ cluster: z.object({ name: z.string() }) }),
  status: z.object({ phase: z.string().optional(), startedAt: Time.optional(), stoppedAt: Time.optional() }).optional() });
const CronJob = z.object({ metadata: Meta, spec: z.object({ suspend: z.boolean().optional() }).optional(),
  status: z.object({ lastScheduleTime: Time.optional(), lastSuccessfulTime: Time.optional(),
    active: z.array(z.unknown()).optional() }).optional() });
const list = <T extends z.ZodTypeAny>(item: T) => z.object({ items: z.array(item) });

const hours = (ms: number) => `${Math.max(0, Math.floor(ms / 3_600_000))}시간 전`;
const names = (values: string[]) => values.length > NAMES_SHOWN
  ? `${values.slice(0, NAMES_SHOWN).join(', ')} 외 ${values.length - NAMES_SHOWN}개` : values.join(', ');
const k8sName = /^[a-z0-9]([-a-z0-9]{0,61}[a-z0-9])?$/;

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
    return problems.length
      ? { observedAt, status: 'problem', summary: [...problems, ...fresh].join(', '), restoreVerifiedAt: null }
      : { observedAt, status: 'ok', summary: `${fresh[0]} · WAL 아카이브 정상`, restoreVerifiedAt: null };
  } };
}

// CronJob 전체(클러스터 범위 list). 마지막 회차가 성공으로 끝났는지만 본다.
// 한계: cron 식을 해석하지 않아 컨트롤러가 회차를 건너뛴 것은 여기서 못 잡는다(homelab 경보 몫).
export function scheduledJobSource(kubernetes: Pick<KubernetesClient, 'get'>, now: Clock): ObservationSource {
  return { id: 'scheduled_job:cronjobs', label: '예약 작업(CronJob)', kind: 'scheduled_job', async read(): Promise<Observation> {
    const observedAt = now();
    const jobs = list(CronJob).parse(await kubernetes.get('/apis/batch/v1/cronjobs', AbortSignal.timeout(OBSERVATION_TIMEOUT_MS))).items;
    // 목록이 비어도 질의가 성공했으면 "없다"는 관측이다. 백업 예약(CNPG ScheduledBackup)은 CronJob이 아니라 백업 항목에서 본다.
    if (!jobs.length) return { observedAt, status: 'ok', summary: '등록된 CronJob 없음' };
    const problems: string[] = [];
    for (const job of jobs) {
      const at = job.status?.lastScheduleTime, ok = job.status?.lastSuccessfulTime, running = (job.status?.active?.length ?? 0) > 0;
      const reason = job.spec?.suspend ? '일시 중지'
        : at === undefined ? '실행 기록 없음'
        : running ? (observedAt - at > JOB_RUNNING_LIMIT_MS ? '24시간 넘게 실행 중' : undefined)
        // 성공 시각은 완료 시각이라 같은 회차면 예약 시각보다 늦다. 앞서면 마지막 회차가 성공하지 못했다.
        : ok === undefined || ok < at ? '마지막 실행 실패' : undefined;
      if (reason) problems.push(`${job.metadata.namespace}/${job.metadata.name}(${reason})`);
    }
    return problems.length
      ? { observedAt, status: 'problem', summary: `CronJob ${jobs.length}개 중 확인 필요 ${problems.length}개: ${names(problems)}` }
      : { observedAt, status: 'ok', summary: `CronJob ${jobs.length}개 마지막 실행 성공` };
  } };
}

// 진입점이 BriefingScheduler에 넣는 관측 원본. kubernetes는 읽기 transport와 같은 연결(kubernetesTransport 반환값)을 쓴다.
export function briefingSources(transports: { kubernetes: Pick<KubernetesClient, 'get'> }, now: Clock): ObservationSource[] {
  return [...BACKUP_CLUSTERS.map(target => backupSource(transports.kubernetes, now, target)), scheduledJobSource(transports.kubernetes, now)];
}
