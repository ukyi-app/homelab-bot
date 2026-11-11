import { after, before, beforeEach, test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import type { IncomingMessage, Server, ServerResponse } from 'node:http';
import { once } from 'node:events';
import type { AddressInfo } from 'node:net';
import { BriefingScheduler } from '../src/briefing.js';
import type { Observation } from '../src/briefing.js';
import { BACKUP_STALE_MS, CERT_QUERIES, RESTORE_ANNOTATIONS, backupSource, briefingSources, certificateSource, restoreCheck,
  scheduledJobSource } from '../src/briefing-observations.js';
import type { MemoryService } from '../src/memory.js';
import type { ReadTransport } from '../src/read.js';
import { encodeObservation, grafanaTransport, kubernetesTransport } from '../src/read-transports.js';
import { fixture, localDatabase } from './helpers.js';

// 브리핑 관측 어댑터(B5). 가짜 Kubernetes API 응답만 쓴다. 실제 클러스터에는 연결하지 않는다.
const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const NOW = Date.UTC(2027, 0, 15, 23, 50);
const now = () => NOW;
const iso = (ts: number) => new Date(ts).toISOString();
const CLUSTER_PATH = '/apis/postgresql.cnpg.io/v1/namespaces/database/clusters/pg';
const BACKUPS_PATH = '/apis/postgresql.cnpg.io/v1/namespaces/database/backups?labelSelector=cnpg.io%2Fcluster%3Dpg';
const CRONJOBS_PATH = '/apis/batch/v1/cronjobs';

const cluster = (conditions: { type: string; status: string }[] = [
  { type: 'ContinuousArchiving', status: 'True' }, { type: 'LastBackupSucceeded', status: 'True' }]) =>
  ({ metadata: { name: 'pg', namespace: 'database' }, status: { conditions } });
const backup = (name: string, phase: string, startedAt: number, stoppedAt?: number, extra: Record<string, unknown> = {}) => ({
  metadata: { name, namespace: 'database', creationTimestamp: iso(startedAt) }, spec: { cluster: { name: 'pg' } },
  status: { phase, startedAt: iso(startedAt), ...(stoppedAt === undefined ? {} : { stoppedAt: iso(stoppedAt) }), ...extra } });
const cronjob = (name: string, status: Record<string, unknown>, suspend = false) =>
  ({ metadata: { name, namespace: 'app-a', uid: `uid-${name}` }, spec: { schedule: '0 3 * * *', suspend }, status });
const JOBS_PATH = '/apis/batch/v1/namespaces/app-a/jobs';
// CronJob 컨트롤러가 만드는 Job 모양: 이름 <CronJob>-<예약 시각(분)>, 예약 시각 annotation, CronJob ownerReference.
const job = (cron: string, scheduledAt: number, status: Record<string, unknown>,
  options: { annotation?: boolean; owner?: string; ownerUid?: string; name?: string } = {}) => {
  const name = options.name ?? `${cron}-${Math.floor(scheduledAt / 60_000)}`;
  return { metadata: { name, namespace: 'app-a', uid: `uid-job-${name}`,
    ...(options.annotation === false ? {} : { annotations: { 'batch.kubernetes.io/cronjob-scheduled-timestamp': iso(scheduledAt) } }),
    ownerReferences: [{ apiVersion: 'batch/v1', kind: 'CronJob', name: options.owner ?? cron, uid: options.ownerUid ?? `uid-${options.owner ?? cron}`, controller: true }] },
  status };
};
const complete = (start: number, end: number) => ({ startTime: iso(start), completionTime: iso(end), conditions: [{ type: 'Complete', status: 'True' }] });
const failedRun = (start: number) => ({ startTime: iso(start), conditions: [{ type: 'Failed', status: 'True' }] });
const runningRun = (start: number) => ({ startTime: iso(start), active: 1 });
const ref = (value: ReturnType<typeof job>) => ({ kind: 'Job', name: value.metadata.name, namespace: 'app-a', uid: value.metadata.uid });

type Reply = unknown | Error;
function mock(replies: Record<string, Reply>) {
  const seen: string[] = [];
  return { seen, get: async (path: string, signal: AbortSignal) => {
    assert.ok(signal instanceof AbortSignal);
    seen.push(path);
    const reply = Object.hasOwn(replies, path) ? replies[path] : new Error('read_http_404');
    if (reply instanceof Error) throw reply;
    return structuredClone(reply);
  } };
}
const healthyBackups = () => ({ items: [backup('pg-daily-1', 'completed', NOW - 19 * HOUR - 3000, NOW - 19 * HOUR)] });
const readBackup = (replies: Record<string, Reply>) => backupSource(mock(replies), now, { namespace: 'database', cluster: 'pg' }).read();

test('[T20 B5] 백업 정상: 고정 경로 둘만 읽고 관측 시각은 읽은 시각, 복원 기록이 없으면 복원 검증은 미확인', async () => {
  const k8s = mock({ [CLUSTER_PATH]: cluster(), [BACKUPS_PATH]: healthyBackups() });
  const source = backupSource(k8s, now, { namespace: 'database', cluster: 'pg' });
  assert.equal(source.kind, 'backup');
  const value = await source.read();
  assert.deepEqual(value, { observedAt: NOW, status: 'ok', summary: '마지막 성공 백업 19시간 전 · WAL 아카이브 정상', restoreVerifiedAt: null,
    restoreCheck: { status: 'unknown', passAt: null, failedAt: null, staleDays: null, issue: null } });
  assert.deepEqual(k8s.seen.sort(), [BACKUPS_PATH, CLUSTER_PATH].sort());
});

test('[T20 B5] 백업 오래됨·빈 결과·최근 실패·WAL 아카이브 실패는 정상이 아님', async () => {
  const stale = await readBackup({ [CLUSTER_PATH]: cluster(),
    [BACKUPS_PATH]: { items: [backup('old', 'completed', NOW - BACKUP_STALE_MS - HOUR, NOW - BACKUP_STALE_MS - HOUR + 1000)] } });
  assert.equal(stale.status, 'problem');
  assert.match(stale.summary, /마지막 성공 백업 26시간 전\(26시간 기준 초과\)/);

  const empty = await readBackup({ [CLUSTER_PATH]: cluster(), [BACKUPS_PATH]: { items: [] } });
  assert.deepEqual([empty.status, empty.summary], ['problem', '완료된 백업 없음']);

  const failed = await readBackup({ [CLUSTER_PATH]: cluster(), [BACKUPS_PATH]: { items: [
    backup('pg-daily-1', 'completed', NOW - 25 * HOUR - 3000, NOW - 25 * HOUR),
    // 오류 원문에는 저장소 주소가 섞일 수 있다. 요약에 나오면 안 된다.
    backup('pg-daily-2', 'failed', NOW - HOUR, undefined, { error: 'upload to s3://fixture-bucket/path failed' })] } });
  assert.equal(failed.status, 'problem');
  assert.match(failed.summary, /최근 백업 실패\(pg-daily-2\)/);
  assert.match(failed.summary, /마지막 성공 백업 25시간 전/);
  assert.doesNotMatch(failed.summary, /s3:|fixture-bucket|path/);

  const running = await readBackup({ [CLUSTER_PATH]: cluster(), [BACKUPS_PATH]: { items: [...healthyBackups().items,
    backup('pg-daily-2', 'running', NOW - 60_000)] } });
  assert.equal(running.status, 'ok', '진행 중 백업은 문제로 보지 않음');

  for (const [conditions, expected] of [
    [[{ type: 'ContinuousArchiving', status: 'False' }], /WAL 아카이브 실패/],
    [[], /WAL 아카이브 상태 없음/],
    [[{ type: 'ContinuousArchiving', status: 'True' }, { type: 'LastBackupSucceeded', status: 'False' }], /클러스터가 마지막 백업 실패를 보고/],
  ] as const) {
    const value = await readBackup({ [CLUSTER_PATH]: cluster([...conditions]), [BACKUPS_PATH]: healthyBackups() });
    assert.equal(value.status, 'problem');
    assert.match(value.summary, expected);
  }

  // 라벨 선택이 무시된 응답이어도 다른 클러스터의 성공 백업으로 정상이 되지 않는다.
  const other = backup('other', 'completed', NOW - HOUR, NOW - HOUR + 1000);
  other.spec.cluster.name = 'other-pg';
  const foreign = await readBackup({ [CLUSTER_PATH]: cluster(), [BACKUPS_PATH]: { items: [other] } });
  assert.deepEqual([foreign.status, foreign.summary], ['problem', '완료된 백업 없음']);
});

test('[T20 B5] 백업 읽기 실패·권한 없음·모양이 틀린 응답은 관측을 내지 않음(throw)', async () => {
  await assert.rejects(readBackup({ [CLUSTER_PATH]: new Error('read_http_403'), [BACKUPS_PATH]: healthyBackups() }), /read_http_403/);
  await assert.rejects(readBackup({ [CLUSTER_PATH]: cluster(), [BACKUPS_PATH]: new Error('read_http_403') }), /read_http_403/);
  await assert.rejects(readBackup({ [CLUSTER_PATH]: cluster(), [BACKUPS_PATH]: { kind: 'Status' } }));
  await assert.rejects(readBackup({ [CLUSTER_PATH]: { ...cluster(), metadata: { name: 'other', namespace: 'database' } },
    [BACKUPS_PATH]: healthyBackups() }), /unexpected_object/);
  const badTime = healthyBackups();
  (badTime.items[0]!.status as Record<string, unknown>).stoppedAt = 'not-a-time';
  await assert.rejects(readBackup({ [CLUSTER_PATH]: cluster(), [BACKUPS_PATH]: badTime }));
  assert.throws(() => backupSource(mock({}), now, { namespace: '../x', cluster: 'pg' }), /invalid_backup_target/);
});

test('[T20 B5] 예약 작업: 빈 목록·정상·실패·중지·실행 기록 없음·멈춘 실행·읽기 실패', async () => {
  const read = (reply: Reply, jobs: unknown[] = []) => scheduledJobSource(mock({ [CRONJOBS_PATH]: reply, [JOBS_PATH]: { items: jobs } }), now).read();
  assert.deepEqual(await read({ items: [] }), { observedAt: NOW, status: 'ok', summary: '등록된 CronJob 없음' });
  const backupDone = job('a-valkey-backup', NOW - 2 * HOUR, complete(NOW - 2 * HOUR + 1000, NOW - 2 * HOUR + 30_000));
  const reportRun = job('a-report', NOW - 60_000, runningRun(NOW - 59_000));
  const fine = await read({ items: [
    cronjob('a-valkey-backup', { lastScheduleTime: iso(NOW - 2 * HOUR), lastSuccessfulTime: iso(NOW - 2 * HOUR + 30_000) }),
    cronjob('a-report', { lastScheduleTime: iso(NOW - 60_000), lastSuccessfulTime: iso(NOW - DAY), active: [ref(reportRun)] }),
  ] }, [backupDone, reportRun]);
  // 마지막 회차가 아직 실행 중인 CronJob은 성공으로 세지 않고 실행 중으로 따로 적는다.
  assert.deepEqual([fine.status, fine.summary], ['ok', 'CronJob 2개 중 마지막 실행 성공 1개, 실행 중 1개']);
  const done = await read({ items: [cronjob('a-valkey-backup', { lastScheduleTime: iso(NOW - 2 * HOUR) })] }, [backupDone]);
  assert.deepEqual([done.status, done.summary], ['ok', 'CronJob 1개 마지막 실행 성공']);
  const stuckRun = job('stuck', NOW - DAY - HOUR, runningRun(NOW - DAY - HOUR + 1000));
  const bad = await read({ items: [
    cronjob('failed', { lastScheduleTime: iso(NOW - HOUR), lastSuccessfulTime: iso(NOW - DAY) }),
    cronjob('never-succeeded', { lastScheduleTime: iso(NOW - HOUR) }),
    cronjob('paused', { lastScheduleTime: iso(NOW - HOUR), lastSuccessfulTime: iso(NOW - HOUR + 1000) }, true),
    cronjob('never-ran', {}),
    cronjob('stuck', { lastScheduleTime: iso(NOW - DAY - HOUR), active: [ref(stuckRun)] }),
    cronjob('ok', { lastScheduleTime: iso(NOW - HOUR), lastSuccessfulTime: iso(NOW - HOUR + 1000) }),
  ] }, [job('failed', NOW - HOUR, failedRun(NOW - HOUR + 1000)), job('never-succeeded', NOW - HOUR, failedRun(NOW - HOUR + 1000)),
    stuckRun, job('ok', NOW - HOUR, complete(NOW - HOUR + 1000, NOW - HOUR + 2000))]);
  assert.equal(bad.status, 'problem');
  assert.equal(bad.summary, 'CronJob 6개 중 확인 필요 5개: app-a/failed(마지막 실행 실패), app-a/never-succeeded(마지막 실행 실패), '
    + 'app-a/paused(일시 중지), app-a/never-ran(실행 기록 없음), app-a/stuck(24시간 넘게 실행 중)');
  const many = await read({ items: Array.from({ length: 7 }, (_, i) => cronjob(`job-${i}`, {})) });
  assert.match(many.summary, /CronJob 7개 중 확인 필요 7개: .*job-4\(실행 기록 없음\) 외 2개$/);
  await assert.rejects(read(new Error('read_http_403')), /read_http_403/);
  await assert.rejects(read({ items: [{ metadata: { name: 'x' } }] }));
});

// concurrencyPolicy Allow면 새 회차마다 lastScheduleTime이 갱신된다. 예약 시각이 아니라
// active가 가리키는 개별 Job의 시작 시각으로 장기 실행을 본다.
test('[T20 B5 fix] Allow 동시 실행: 새 회차가 예약돼도 오래 실행 중인 옛 Job을 장기 실행으로 잡음', async () => {
  const oldAt = NOW - 30 * HOUR, newAt = NOW - HOUR;
  const read = (jobs: unknown[], active: unknown[]) => scheduledJobSource(mock({
    [CRONJOBS_PATH]: { items: [cronjob('allow', { lastScheduleTime: iso(newAt), lastSuccessfulTime: iso(NOW - 2 * HOUR), active })] },
    [JOBS_PATH]: { items: jobs } }), now).read();
  const oldJob = job('allow', oldAt, runningRun(oldAt + 1000)), newJob = job('allow', newAt, runningRun(newAt + 1000));
  const stuck = await read([oldJob, newJob], [ref(oldJob), ref(newJob)]);
  assert.deepEqual([stuck.status, stuck.summary], ['problem', 'CronJob 1개 중 확인 필요 1개: app-a/allow(24시간 넘게 실행 중)']);

  // 시작 시각을 읽을 수 없으면 장기 실행 여부를 정상으로 두지 않는다.
  const noStart = job('allow', oldAt, {});
  const unknown = await read([noStart, newJob], [ref(noStart), ref(newJob)]);
  assert.deepEqual([unknown.status, unknown.summary], ['problem', 'CronJob 1개 중 확인 필요 1개: app-a/allow(실행 중 Job 시작 시각 미확인)']);
  const missing = await read([newJob], [ref(oldJob), ref(newJob)]);
  assert.deepEqual([missing.status, missing.summary], ['problem', 'CronJob 1개 중 확인 필요 1개: app-a/allow(실행 중 Job 시작 시각 미확인)']);
  // uid가 다른 같은 이름 Job(지워졌다 다시 만든 Job)은 active 항목과 연결하지 않는다.
  const recreated = { ...oldJob, metadata: { ...oldJob.metadata, uid: 'uid-other' } };
  assert.equal((await read([recreated, newJob], [ref(oldJob), ref(newJob)])).status, 'problem');

  const fresh = await read([newJob], [ref(newJob)]);
  assert.deepEqual([fresh.status, fresh.summary], ['ok', 'CronJob 1개 중 마지막 실행 성공 0개, 실행 중 1개']);
  await assert.rejects(scheduledJobSource(mock({ [CRONJOBS_PATH]: { items: [cronjob('allow', { lastScheduleTime: iso(newAt) })] },
    [JOBS_PATH]: new Error('read_http_403') }), now).read(), /read_http_403/);
});

// lastSuccessfulTime >= lastScheduleTime은 마지막 회차의 성공이 아니다
// (10:00 회차가 11:10 성공, 11:00 회차가 11:05 실패). 마지막 예약 회차의 Job 조건을 본다.
test('[T20 B5 fix] 마지막 회차: 이전 회차의 늦은 성공이 마지막 회차의 실패·미확인을 덮지 않음', async () => {
  const t10 = NOW - 13 * HOUR, t11 = t10 + HOUR;
  const status = { lastScheduleTime: iso(t11), lastSuccessfulTime: iso(t10 + 70 * 60_000) };
  const read = (jobs: unknown[]) => scheduledJobSource(mock({ [CRONJOBS_PATH]: { items: [cronjob('report', status)] },
    [JOBS_PATH]: { items: jobs } }), now).read();
  const job10 = job('report', t10, complete(t10 + 1000, t10 + 70 * 60_000));
  const failed = await read([job10, job('report', t11, failedRun(t11 + 1000))]);
  assert.deepEqual([failed.status, failed.summary], ['problem', 'CronJob 1개 중 확인 필요 1개: app-a/report(마지막 실행 실패)']);

  // 마지막 회차 Job이 이력 정리로 없으면 성공을 확정하지 않는다.
  const gone = await read([job10]);
  assert.deepEqual([gone.status, gone.summary], ['problem', 'CronJob 1개 중 확인 필요 1개: app-a/report(마지막 회차 Job 없음 · 결과 미확인)']);
  // 같은 예약 시각이어도 다른 CronJob이나 이전 CronJob(uid 다름)의 Job은 연결하지 않는다.
  const foreign = await read([job10, job('other', t11, complete(t11, t11 + 1000)),
    job('report', t11, complete(t11, t11 + 1000), { name: 'report-old', ownerUid: 'uid-old' })]);
  assert.match(foreign.summary, /report\(마지막 회차 Job 없음 · 결과 미확인\)/);
  // 끝나지도, 실행 중이지도 않은 Job(조건 없음, 시작 시각 없음)은 결과 미확인이다.
  const pending = await read([job10, job('report', t11, {})]);
  assert.match(pending.summary, /report\(마지막 회차 결과 미확인\)/);

  // 마지막 회차가 Complete=True일 때만 성공. annotation이 없으면 컨트롤러 이름 규칙으로 연결한다.
  const ok = await read([job10, job('report', t11, complete(t11 + 1000, t11 + 60_000))]);
  assert.deepEqual([ok.status, ok.summary], ['ok', 'CronJob 1개 마지막 실행 성공']);
  const byName = await read([job10, job('report', t11, complete(t11 + 1000, t11 + 60_000), { annotation: false })]);
  assert.deepEqual([byName.status, byName.summary], ['ok', 'CronJob 1개 마지막 실행 성공']);
  // annotation이 다른 회차를 가리키면 이름이 맞아도 연결하지 않는다.
  const wrong = job('report', t11, complete(t11 + 1000, t11 + 60_000), { annotation: false });
  Object.assign(wrong.metadata, { annotations: { 'batch.kubernetes.io/cronjob-scheduled-timestamp': iso(t10) } });
  assert.equal((await read([wrong])).status, 'problem');
});

// 진입점이 넘길 객체(kubernetesTransport 반환값)로 실제 HTTP 경로·SA 토큰·권한 없음 응답을 본다.
let server: Server;
let base: string;
let handler: (req: IncomingMessage, res: ServerResponse) => void;
let seen: { url: string; auth: string | undefined; method: string }[];
let database: Awaited<ReturnType<typeof localDatabase>>;
before(async () => {
  database = await localDatabase();
  server = createServer((req, res) => { seen.push({ url: req.url ?? '', auth: req.headers.authorization, method: req.method ?? '' }); handler(req, res); });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
after(async () => { server.closeAllConnections(); server.close(); await database.pg.close(); });
beforeEach(() => { seen = []; handler = (_req, res) => res.writeHead(404).end(); });
const json = (res: ServerResponse, value: unknown, status = 200) => res.writeHead(status, { 'content-type': 'application/json' }).end(JSON.stringify(value));
const transport = () => kubernetesTransport({ base, tokenFile: '/fixture/token', caFile: null, applications: [], readText: async () => 'fixture-sa-token\n' });
function serve(routes: Record<string, unknown>) {
  handler = (req, res) => {
    const route = routes[req.url ?? ''];
    if (route === undefined) return res.writeHead(404).end();
    if (typeof route === 'number') return json(res, { kind: 'Status', code: route }, route);
    json(res, route);
  };
}

test('[T20 B5] briefingSources: 읽기 transport의 연결로 고정 경로를 GET하고 403은 읽기 실패', async () => {
  const kubernetes = transport();
  serve({ [CLUSTER_PATH]: cluster(), [BACKUPS_PATH]: healthyBackups(), [CRONJOBS_PATH]: { items: [] } });
  const sources = briefingSources({ kubernetes }, now);
  assert.deepEqual(sources.map(s => [s.id, s.kind]), [['backup:database/pg', 'backup'], ['scheduled_job:cronjobs', 'scheduled_job']]);
  const values = await Promise.all(sources.map(s => s.read()));
  assert.deepEqual(values.map(v => v.status), ['ok', 'ok']);
  assert.deepEqual(seen.map(s => s.url).sort(), [BACKUPS_PATH, CLUSTER_PATH, CRONJOBS_PATH].sort());
  assert.ok(seen.every(s => s.method === 'GET' && s.auth === 'Bearer fixture-sa-token'));
  // CronJob이 있으면 그 namespace의 Job 목록만 고정 모양 경로로 더 읽는다.
  seen = [];
  serve({ [CRONJOBS_PATH]: { items: [cronjob('a-report', { lastScheduleTime: iso(NOW - HOUR) })] },
    [JOBS_PATH]: { items: [job('a-report', NOW - HOUR, complete(NOW - HOUR + 1000, NOW - HOUR + 2000))] } });
  assert.equal((await sources[1]!.read()).summary, 'CronJob 1개 마지막 실행 성공');
  assert.deepEqual(seen.map(s => [s.method, s.url]), [['GET', CRONJOBS_PATH], ['GET', JOBS_PATH]]);
  serve({ [CLUSTER_PATH]: cluster(), [BACKUPS_PATH]: 403, [CRONJOBS_PATH]: 403 });
  for (const source of sources) await assert.rejects(source.read(), /read_http_403/);
  await kubernetes.close();
});

test('[T20 B5] 브리핑 문구: 미확인·확인 필요가 정상으로 바뀌지 않고 인증서는 연결 없음으로 남음', async () => {
  const f = await fixture(database.db);
  await database.pg.exec('TRUNCATE outbox,schedules,briefing_runs,briefing_copies,briefing_observations RESTART IDENTITY CASCADE');
  const memory = { recheckDue: async () => ({ items: [], total: 0 }), live: async () => true } as unknown as MemoryService;
  const kubernetes = transport();
  const sources = briefingSources({ kubernetes }, f.now);
  const scheduler = new BriefingScheduler(f.store, f.gate, memory, sources, { time: '08:50', timezone: 'Asia/Seoul' });
  await scheduler.ensure();
  const at = (ts: number) => { f.advance(ts - f.now()); f.policy.confirmedAt = f.now(); };
  const contents = async () => (await database.db.query<{ payload: { content: string } }>(
    "SELECT payload FROM outbox WHERE message_key LIKE 'briefing:%' ORDER BY created_at,page_index")).rows.map(r => r.payload.content);
  const slot = Date.UTC(2027, 0, 15, 23, 50);

  // 1회차: 백업 정상, CronJob 없음.
  serve({ [CLUSTER_PATH]: cluster(), [CRONJOBS_PATH]: { items: [] },
    [BACKUPS_PATH]: { items: [backup('b1', 'completed', slot - 10 * HOUR - 3000, slot - 10 * HOUR)] } });
  at(slot); assert.equal(await scheduler.tick(), 'enqueued');
  const first = (await contents())[0]!;
  assert.match(first, /PostgreSQL 백업\(pg\): 정상 · 마지막 성공 백업 10시간 전 · WAL 아카이브 정상 · 관측 01-16 08:50 · 복원 검증 기록 없음\(미확인\) · CLI 기록 기준, 백업 성공과 별개/);
  assert.match(first, /예약 작업\(CronJob\): 정상 · 등록된 CronJob 없음/);
  assert.match(first, /- 인증서: 연결된 조회 없음 · 미확인/);
  assert.doesNotMatch(first, /- 없음\(아래 관측 기준\)/);

  // 2회차: 권한 없음(403). 마지막 정상 수집 시각과 미확인, 정상 문구 없음.
  serve({ [CLUSTER_PATH]: 403, [BACKUPS_PATH]: 403, [CRONJOBS_PATH]: 403 });
  at(slot + DAY); assert.equal(await scheduler.tick(), 'enqueued');
  const second = (await contents())[1]!;
  assert.match(second, /PostgreSQL 백업\(pg\): 읽기 불가 · 마지막 정상 수집 01-16 08:50 · 미확인/);
  assert.match(second, /예약 작업\(CronJob\): 읽기 불가 · 마지막 정상 수집 01-16 08:50 · 미확인/);
  assert.doesNotMatch(second, /정상 ·/);

  // 3회차: 백업이 26시간을 넘음, CronJob 실패. 확인 필요이고 정상 문구 없음.
  serve({ [CLUSTER_PATH]: cluster(), [BACKUPS_PATH]: { items: [backup('b1', 'completed', slot - 10 * HOUR - 3000, slot - 10 * HOUR)] },
    [CRONJOBS_PATH]: { items: [cronjob('a-valkey-backup', { lastScheduleTime: iso(slot + 2 * DAY - HOUR) })] },
    [JOBS_PATH]: { items: [job('a-valkey-backup', slot + 2 * DAY - HOUR, failedRun(slot + 2 * DAY - HOUR + 1000))] } });
  at(slot + 2 * DAY); assert.equal(await scheduler.tick(), 'enqueued');
  const third = (await contents())[2]!;
  assert.match(third, /PostgreSQL 백업\(pg\): 확인 필요 · 마지막 성공 백업 58시간 전\(26시간 기준 초과\)/);
  assert.match(third, /예약 작업\(CronJob\): 확인 필요 · CronJob 1개 중 확인 필요 1개: app-a\/a-valkey-backup\(마지막 실행 실패\)/);
  assert.doesNotMatch(third, /정상 ·/);
  for (const content of [first, second, third]) assert.doesNotMatch(content, /127\.0\.0\.1|\/apis\/|fixture-sa-token/);
  await kubernetes.close();
});

test('[T20 B5] 일부 종류만 연결하면 나머지 종류를 연결 없음·미확인으로 적음(관측 결과가 모두 정상이어도)', async () => {
  const f = await fixture(database.db);
  await database.pg.exec('TRUNCATE outbox,schedules,briefing_runs,briefing_copies,briefing_observations RESTART IDENTITY CASCADE');
  const memory = { recheckDue: async () => ({ items: [], total: 0 }), live: async () => true } as unknown as MemoryService;
  const ok: Observation = { observedAt: 0, status: 'ok', summary: '정상 요약' };
  const scheduler = new BriefingScheduler(f.store, f.gate, memory,
    [{ id: 'jobs', label: 'jobs', kind: 'scheduled_job', read: async () => ({ ...ok, observedAt: f.now() }) }], { time: '08:50', timezone: 'Asia/Seoul' });
  await scheduler.ensure();
  f.advance(Date.UTC(2027, 0, 15, 23, 50) - f.now()); f.policy.confirmedAt = f.now();
  assert.equal(await scheduler.tick(), 'enqueued');
  const content = (await database.db.query<{ payload: { content: string } }>("SELECT payload FROM outbox WHERE message_key LIKE 'briefing:%'")).rows[0]!.payload.content;
  assert.match(content, /■ 확인 필요\n- 백업·인증서: 연결된 조회 없음 · 미확인\n■ 관측 결과\n- jobs: 정상 · 정상 요약/);
  assert.match(content, /- 작업 레인: 상태 미확인 · 실행 중 0건 · 질문 대기 0건 · 모델 대기 0건 · unknown 0건 · 도구 승인 대기: 지원 안 함/);
});

test('[T20 B5 fix2] 시계가 작성 시작과 원본 읽기 사이에 지나가도 방금 읽은 관측을 읽기 불가로 버리지 않음', async () => {
  const f = await fixture(database.db);
  await database.pg.exec('TRUNCATE outbox,schedules,briefing_runs,briefing_copies,briefing_observations RESTART IDENTITY CASCADE');
  const memory = { recheckDue: async () => ({ items: [], total: 0 }), live: async () => true } as unknown as MemoryService;
  // 실제 Date.now처럼 원본이 읽는 사이에 1ms가 지난다. 원본은 읽은 시각을 관측 시각으로 낸다.
  const scheduler = new BriefingScheduler(f.store, f.gate, memory, [{ id: 'jobs', label: 'jobs', kind: 'scheduled_job',
    read: async () => { f.advance(1); return { observedAt: f.now(), status: 'ok', summary: '정상 요약' }; } }],
  { time: '08:50', timezone: 'Asia/Seoul' });
  await scheduler.ensure();
  f.advance(Date.UTC(2027, 0, 15, 23, 50) - f.now()); f.policy.confirmedAt = f.now();
  assert.equal(await scheduler.tick(), 'enqueued');
  const content = (await database.db.query<{ payload: { content: string } }>("SELECT payload FROM outbox WHERE message_key LIKE 'briefing:%'")).rows[0]!.payload.content;
  assert.match(content, /- jobs: 정상 · 정상 요약/);
  assert.doesNotMatch(content, /jobs: 읽기 불가/);
});

// T24 인증서 원본. 가짜 Grafana transport가 집계 질의마다 값(없으면 빈 결과)을 돌려준다.
type Metric = number | number[] | undefined | Error;
type CertValues = Partial<Record<keyof typeof CERT_QUERIES, Metric>>;
function grafanaFake(values: CertValues) {
  const seen: Parameters<ReadTransport['query']>[0][] = [];
  const transport: ReadTransport = { async query(request) {
    seen.push(request);
    const key = (Object.keys(CERT_QUERIES) as (keyof typeof CERT_QUERIES)[]).find(k => CERT_QUERIES[k] === request.query);
    assert.ok(key, `모르는 질의 ${request.query}`);
    const value = values[key];
    if (value instanceof Error) throw value;
    const rows = value === undefined ? [] : (Array.isArray(value) ? value : [value]).map(v => ({ value: v }));
    return encodeObservation(request.to, rows, request);
  } };
  return { seen, transport };
}
const seconds = (ts: number) => ts / 1000;
const healthyCerts = (extra: CertValues = {}): CertValues =>
  ({ count: 2, earliest: seconds(NOW + 79 * DAY + HOUR), ready: 2, age: 30, ...extra });
const readCert = (values: CertValues, zone?: string) =>
  certificateSource({ transport: grafanaFake(values).transport, datasource: 'victoriametrics' }, now, zone).read();

test('[T24] 인증서 정상: 집계 질의 4개만 메트릭 datasource로 보내고 관측 시각은 읽은 시각', async () => {
  const fake = grafanaFake(healthyCerts());
  const source = certificateSource({ transport: fake.transport, datasource: 'victoriametrics' }, now, 'Asia/Seoul');
  assert.deepEqual([source.id, source.label, source.kind], ['certificate:cert-manager', '인증서(cert-manager)', 'certificate']);
  assert.deepEqual(await source.read(), { observedAt: NOW, status: 'ok', summary: '2개 모두 Ready · 가장 이른 만료 2027-04-05(79일)' });
  assert.deepEqual(fake.seen.map(r => r.query).sort(), Object.values(CERT_QUERIES).sort());
  // 계약 1의 질의 문자열 그대로. 가장 이른 만료는 발급 전 인증서(만료 값 0)를 뺀다.
  assert.deepEqual({ ...CERT_QUERIES }, {
    count: 'count(certmanager_certificate_expiration_timestamp_seconds)',
    earliest: 'min(certmanager_certificate_expiration_timestamp_seconds > 0)',
    ready: 'count(certmanager_certificate_ready_status{condition="True"} == 1)',
    age: 'max(time() - timestamp(certmanager_certificate_expiration_timestamp_seconds))' });
  assert.ok(fake.seen.every(r => r.datasource === 'victoriametrics' && r.to === NOW && r.signal instanceof AbortSignal && r.limit === 2));
  // 경계: 만료까지 정확히 7일, 신선도 정확히 600초는 정상이다.
  assert.equal((await readCert(healthyCerts({ earliest: seconds(NOW + 7 * DAY), age: 600 }))).status, 'ok');
});

test('[T24] 인증서 확인 필요: 만료 임박·만료됨·Ready 부족·오래됨·0개', async () => {
  const cases: [CertValues, string][] = [
    [healthyCerts({ earliest: seconds(NOW + 6 * DAY + HOUR) }), '만료 임박(7일 미만) · 가장 이른 만료 2027-01-22(6일)'],
    [healthyCerts({ earliest: seconds(NOW - HOUR) }), '만료된 인증서 있음 · 가장 이른 만료 2027-01-15(만료됨)'],
    [healthyCerts({ ready: 1 }), 'Ready 아님 1개(전체 2개) · 가장 이른 만료 2027-04-05(79일)'],
    // Ready 0개는 빈 결과로 온다(== 1 필터). 0개로 본다.
    [healthyCerts({ ready: undefined }), 'Ready 아님 2개(전체 2개) · 가장 이른 만료 2027-04-05(79일)'],
    [healthyCerts({ ready: 3 }), 'Ready 수 불일치(Ready 3, 전체 2) · 가장 이른 만료 2027-04-05(79일)'],
    [healthyCerts({ age: 601 }), '지표 오래됨 10분(10분 기준 초과) · 가장 이른 만료 2027-04-05(79일)'],
    [healthyCerts({ ready: 1, age: 3600, earliest: seconds(NOW + DAY) }),
      '만료 임박(7일 미만), Ready 아님 1개(전체 2개), 지표 오래됨 60분(10분 기준 초과) · 가장 이른 만료 2027-01-16(1일)'],
    // 수집 대상이 사라져 시계열이 없을 때도 0개다. 정상으로 두지 않는다.
    [{}, '인증서 지표 0개(cert-manager 수집·인증서 확인 필요)'],
    [{ count: 0 }, '인증서 지표 0개(cert-manager 수집·인증서 확인 필요)'],
    // 발급 전 인증서 1개(만료 값 0, Ready 아님) + 정상 1개. min은 0을 빼므로 정상 인증서의 만료가 잡히고 Ready 수 불일치로 확인 필요.
    [healthyCerts({ count: 2, ready: 1 }), 'Ready 아님 1개(전체 2개) · 가장 이른 만료 2027-04-05(79일)'],
    // 모두 발급 전이면 min(> 0) 결과가 빈다. throw하지 않고 만료 시각 없음으로 확인 필요.
    [healthyCerts({ count: 1, ready: undefined, earliest: undefined }), '만료 시각 없음, Ready 아님 1개(전체 1개)'],
    [healthyCerts({ earliest: undefined }), '만료 시각 없음'],
  ];
  for (const [values, summary] of cases) assert.deepEqual(await readCert(values), { observedAt: NOW, status: 'problem', summary });
});

test('[T24] 인증서 질의 실패·응답 모양 오류는 관측을 내지 않음(throw)', async () => {
  await assert.rejects(readCert(healthyCerts({ ready: new Error('grafana_query_failed') })), /grafana_query_failed/);
  await assert.rejects(readCert(healthyCerts({ earliest: new Error('read_http_403') })), /read_http_403/);
  // 집계가 아닌 결과(시계열 둘)·개수는 있는데 만료·신선도가 없음·정수가 아닌 개수.
  await assert.rejects(readCert(healthyCerts({ count: [1, 1] })));
  await assert.rejects(readCert(healthyCerts({ age: undefined })), /unexpected_metric/);
  await assert.rejects(readCert(healthyCerts({ count: 1.5 })), /unexpected_metric/);
  await assert.rejects(readCert(healthyCerts({ ready: -1 })), /unexpected_metric/);
  // transport가 관측 JSON이 아닌 것을 돌려주면 모양 오류다.
  const broken: ReadTransport = { query: async () => new TextEncoder().encode('{"rows":"x"}') };
  await assert.rejects(certificateSource({ transport: broken, datasource: 'victoriametrics' }, now).read());
});

test('[T24] 인증서: /read의 Grafana transport로 POST /api/ds/query, 같은 토큰·datasource uid, HTTP 오류는 throw', async () => {
  const values: Record<string, number | undefined> = { [CERT_QUERIES.count]: 1, [CERT_QUERIES.earliest]: seconds(NOW + 30 * DAY),
    [CERT_QUERIES.ready]: 1, [CERT_QUERIES.age]: 12 };
  const bodies: { from: string; to: string; queries: { datasource: { uid: string }; expr: string; instant: boolean }[] }[] = [];
  let status = 200;
  handler = (req, res) => {
    let raw = '';
    req.on('data', chunk => { raw += chunk; });
    req.on('end', () => {
      const body = JSON.parse(raw) as (typeof bodies)[number];
      bodies.push(body);
      if (status !== 200) return json(res, { message: 'fixture' }, status);
      const value = values[body.queries[0]!.expr];
      json(res, { results: { A: { status: 200, frames: value === undefined ? [] : [{
        schema: { fields: [{ name: 'Time', type: 'time' }, { name: 'Value', type: 'number' }] }, data: { values: [[NOW], [value]] } }] } } });
    });
  };
  const grafana = grafanaTransport({ base, token: 'fixture-grafana-token', datasources: { victoriametrics: 'metrics', victorialogs: 'logs' } });
  const source = certificateSource({ transport: grafana, datasource: 'victoriametrics' }, now);
  assert.deepEqual(await source.read(), { observedAt: NOW, status: 'ok', summary: '1개 모두 Ready · 가장 이른 만료 2027-02-14(30일)' });
  assert.equal(seen.length, 4);
  assert.ok(seen.every(s => s.method === 'POST' && s.url === '/api/ds/query' && s.auth === 'Bearer fixture-grafana-token'));
  assert.deepEqual(bodies.map(b => b.queries[0]!.expr).sort(), Object.values(CERT_QUERIES).sort());
  assert.ok(bodies.every(b => b.queries[0]!.datasource.uid === 'victoriametrics' && b.queries[0]!.instant === true && b.to === String(NOW)));
  // 시계열 없음(빈 frames)은 0개다.
  values[CERT_QUERIES.count] = undefined;
  assert.equal((await source.read()).summary, '인증서 지표 0개(cert-manager 수집·인증서 확인 필요)');
  status = 500;
  await assert.rejects(source.read(), /read_http_500/);
  // 메트릭 datasource가 아닌 이름은 요청 없이 실패한다.
  seen = [];
  await assert.rejects(certificateSource({ transport: grafana, datasource: 'victorialogs-missing' }, now).read(), /unsupported_query/);
  assert.equal(seen.length, 0);
});

test('[T24] briefingSources: Grafana 설정이 없으면 인증서 원본을 만들지 않고, 있으면 백업 다음에 둠', () => {
  const kubernetes = mock({});
  assert.deepEqual(briefingSources({ kubernetes }, now).map(s => s.kind), ['backup', 'scheduled_job']);
  assert.deepEqual(briefingSources({ kubernetes, certificates: undefined }, now).map(s => s.kind), ['backup', 'scheduled_job']);
  const certificates = { transport: grafanaFake({}).transport, datasource: 'victoriametrics' };
  assert.deepEqual(briefingSources({ kubernetes, certificates }, now, 'Asia/Seoul').map(s => s.id),
    ['backup:database/pg', 'certificate:cert-manager', 'scheduled_job:cronjobs']);
});

// T24 복원 검증 기록(Cluster pg annotation). 값 스키마 v1, 키 순서 고정·공백 없음(계약 2).
const UID = 'uid-cluster-pg';
const record = (result: 'pass' | 'fail', at: number, extra: Record<string, unknown> = {}) => JSON.stringify({ v: 1, run: `rc-${at}`,
  result, at: iso(at), target: iso(at - HOUR), server: 'pg-restore-check', dbs: 3, cluster: UID,
  ...(result === 'fail' ? { reason: 'missing_db' } : {}), ...extra });
const annotated = (annotations: Record<string, unknown> | unknown, uid: string | undefined = UID, conditions?: { type: string; status: string }[]) => {
  const value = cluster(conditions);
  return { ...value, metadata: { ...value.metadata, ...(uid === undefined ? {} : { uid }), annotations } };
};
const records = (pass?: string, last?: string) => ({
  ...(pass === undefined ? {} : { [RESTORE_ANNOTATIONS.pass]: pass }), ...(last === undefined ? {} : { [RESTORE_ANNOTATIONS.last]: last }) });

test('[T24] 복원 검증 기록: 없음·통과·100일 초과·통과보다 새 실패', () => {
  const check = (annotations: unknown, uid: string | undefined = UID) => restoreCheck(annotations, uid, NOW);
  const none = { status: 'unknown', passAt: null, failedAt: null, staleDays: null, issue: null };
  assert.deepEqual(check(undefined), none);
  assert.deepEqual(check({ other: 'x' }), none);
  const passAt = NOW - 3 * DAY;
  assert.deepEqual(check(records(record('pass', passAt), record('pass', passAt))),
    { status: 'verified', passAt, failedAt: null, staleDays: null, issue: null });
  // 정확히 100일은 아직 오래되지 않았다. 넘으면 확인 필요.
  assert.equal(check(records(record('pass', NOW - 100 * DAY))).status, 'verified');
  assert.deepEqual(check(records(record('pass', NOW - 101 * DAY - HOUR))),
    { status: 'problem', passAt: NOW - 101 * DAY - HOUR, failedAt: null, staleDays: 101, issue: null });
  // 실패는 pass를 건드리지 않는다. last 실패가 pass보다 새것이면 확인 필요, 옛것이면 통과 그대로.
  assert.deepEqual(check(records(record('pass', passAt), record('fail', NOW - DAY))),
    { status: 'problem', passAt, failedAt: NOW - DAY, staleDays: null, issue: null });
  assert.equal(check(records(record('pass', passAt), record('fail', passAt - DAY))).status, 'verified');
  assert.deepEqual(check(records(undefined, record('fail', NOW - DAY, { reason: 'no_db', dbs: 0 }))),
    { status: 'problem', passAt: null, failedAt: NOW - DAY, staleDays: null, issue: null });
  assert.deepEqual(check(records(record('pass', NOW - 120 * DAY), record('fail', NOW - DAY, { reason: 'aborted' }))),
    { status: 'problem', passAt: NOW - 120 * DAY, failedAt: NOW - DAY, staleDays: 120, issue: null });
});

test('[T24] 복원 검증 기록 오류(JSON·스키마·uid 불일치·미래 시각)는 그 기록만 미확인', () => {
  const issue = (annotations: unknown, uid: string | undefined = UID) => {
    const value = restoreCheck(annotations, uid, NOW);
    return [value.status, value.passAt, value.issue];
  };
  const pass = record('pass', NOW - DAY);
  for (const bad of ['{not json', '"pass"', 'null', record('pass', NOW - DAY, { v: 2 }), record('pass', NOW - DAY, { extra: 1 }),
    record('pass', NOW - DAY, { dbs: 0 }), record('pass', NOW - DAY, { reason: 'x' }), record('pass', NOW - DAY, { dbs: 1.5 }),
    record('pass', NOW - DAY, { at: '2027-01-14T23:50:00+09:00' }), record('pass', NOW - DAY, { at: '2027-01-14T25:50:00Z' }),
    record('pass', NOW - DAY, { run: '' }), JSON.stringify({ v: 1, result: 'pass' }),
    // pass 키에 실패 기록이 있으면 계약 위반이다.
    record('fail', NOW - DAY), 'x'.repeat(2000)]) {
    assert.deepEqual(issue(records(bad)), ['unknown', null, 'format'], bad.slice(0, 80));
  }
  assert.deepEqual(issue(records(undefined, record('fail', NOW - DAY, { reason: undefined }))), ['unknown', null, 'format']);
  assert.deepEqual(issue(records(undefined, record('fail', NOW - DAY, { reason: 'Bad Reason' }))), ['unknown', null, 'format']);
  assert.deepEqual(issue({ [RESTORE_ANNOTATIONS.pass]: 42 }), ['unknown', null, 'format']);
  assert.deepEqual(issue('annotations-not-object'), ['unknown', null, 'format']);
  // 지웠다 다시 만든 Cluster(uid 다름)나 uid를 모르는 Cluster의 기록은 믿지 않는다.
  assert.deepEqual(issue(records(pass), 'uid-other'), ['unknown', null, 'cluster']);
  const unknownUid = restoreCheck(records(pass), undefined, NOW);
  assert.deepEqual([unknownUid.status, unknownUid.passAt, unknownUid.issue], ['unknown', null, 'cluster']);
  assert.deepEqual(issue(records(record('pass', NOW + 60_000))), ['unknown', null, 'future']);
  // 통과가 유효하고 last만 틀리면 통과는 그대로 두고 사유를 남긴다. 틀린 last를 실패로 치지 않는다.
  assert.deepEqual(issue(records(pass, '{bad')), ['verified', NOW - DAY, 'format']);
  // pass가 틀려도 유효한 새 실패는 확인 필요로 남는다.
  assert.deepEqual(issue(records('{bad', record('fail', NOW - HOUR))), ['problem', null, 'format']);
});

test('[T24] 백업 원본: 복원 기록을 Cluster 응답에서 읽고, 기록 오류·실패여도 백업 판정은 그대로', async () => {
  const read = (annotations: unknown, uid?: string, conditions?: { type: string; status: string }[]) =>
    readBackup({ [CLUSTER_PATH]: annotated(annotations, uid, conditions), [BACKUPS_PATH]: healthyBackups() });
  const passAt = NOW - 2 * DAY;
  const ok = await read(records(record('pass', passAt), record('pass', passAt)));
  assert.deepEqual([ok.status, ok.summary, ok.restoreVerifiedAt, ok.restoreCheck?.status],
    ['ok', '마지막 성공 백업 19시간 전 · WAL 아카이브 정상', passAt, 'verified']);
  for (const annotations of [records('{bad'), records(record('pass', NOW + DAY)), 'not-an-object', [1, 2], null,
    records(record('pass', passAt), record('fail', NOW - HOUR)), records(record('pass', NOW - 200 * DAY))]) {
    const value = await read(annotations);
    assert.deepEqual([value.status, value.summary], ['ok', '마지막 성공 백업 19시간 전 · WAL 아카이브 정상'], JSON.stringify(annotations));
  }
  assert.equal((await read(records(record('pass', passAt)), 'uid-other')).restoreVerifiedAt, null);
  // 백업이 확인 필요면 복원 기록이 통과여도 확인 필요 그대로다.
  const failing = await read(records(record('pass', passAt)), UID, [{ type: 'ContinuousArchiving', status: 'False' }]);
  assert.deepEqual([failing.status, failing.restoreVerifiedAt], ['problem', passAt]);
  assert.match(failing.summary, /WAL 아카이브 실패/);
});

test('[T24] 브리핑 사본: 인증서·복원 검증 문구(CLI 기록 기준)와 기록 오류에도 백업 정상 유지', async () => {
  const f = await fixture(database.db);
  await database.pg.exec('TRUNCATE outbox,schedules,briefing_runs,briefing_copies,briefing_observations RESTART IDENTITY CASCADE');
  const memory = { recheckDue: async () => ({ items: [], total: 0 }), live: async () => true } as unknown as MemoryService;
  let annotations: unknown = {};
  let certs: CertValues = {};
  const kubernetes = { get: async (path: string) => {
    if (path === CLUSTER_PATH) return annotated(annotations);
    if (path === BACKUPS_PATH) return { items: [backup('b1', 'completed', f.now() - 10 * HOUR - 3000, f.now() - 10 * HOUR)] };
    if (path === CRONJOBS_PATH) return { items: [] };
    throw new Error('read_http_404');
  } };
  const transport: ReadTransport = { query: request => grafanaFake(certs).transport.query(request) };
  const sources = briefingSources({ kubernetes, certificates: { transport, datasource: 'victoriametrics' } }, f.now, 'Asia/Seoul');
  const scheduler = new BriefingScheduler(f.store, f.gate, memory, sources, { time: '08:50', timezone: 'Asia/Seoul' });
  await scheduler.ensure();
  const slot = Date.UTC(2027, 0, 15, 23, 50);
  const tick = async (day: number) => {
    f.advance(slot + day * DAY - f.now()); f.policy.confirmedAt = f.now();
    assert.equal(await scheduler.tick(), 'enqueued');
    return (await database.db.query<{ payload: { content: string } }>(
      "SELECT payload FROM outbox WHERE message_key LIKE 'briefing:%' ORDER BY created_at DESC,page_index LIMIT 1")).rows[0]!.payload.content;
  };
  const tail = ' · CLI 기록 기준, 백업 성공과 별개';
  const backupOk = 'PostgreSQL 백업(pg): 정상 · 마지막 성공 백업 10시간 전 · WAL 아카이브 정상 · 관측 01-16 08:50';

  // 1회차: 통과 기록, 인증서 정상. 확인 필요 없음.
  annotations = records(record('pass', slot - 2 * DAY), record('pass', slot - 2 * DAY));
  certs = healthyCerts();
  const first = await tick(0);
  assert.match(first, /■ 확인 필요\n- 없음\(아래 관측 기준\)\n■ 관측 결과\n/);
  assert.ok(first.includes(`- ${backupOk} · 복원 검증 통과 01-14 08:50${tail}`), first);
  assert.ok(first.includes('- 인증서(cert-manager): 정상 · 2개 모두 Ready · 가장 이른 만료 2027-04-05(79일) · 관측 01-16 08:50'), first);
  assert.doesNotMatch(first, /인증서: 연결된 조회 없음/);

  // 2회차: 통과보다 새 실패, 인증서 만료 임박. 백업 판정은 정상으로 보이되 확인 필요 쪽에 적는다.
  annotations = records(record('pass', slot - 2 * DAY), record('fail', slot + DAY - 3 * HOUR));
  certs = healthyCerts({ earliest: seconds(slot + DAY + 6 * DAY + HOUR) });
  const second = await tick(1);
  assert.ok(second.includes('- PostgreSQL 백업(pg): 백업 정상 · 마지막 성공 백업 10시간 전 · WAL 아카이브 정상 · 관측 01-17 08:50'
    + ` · 확인 필요: 최근 복원 검증 실패 01-17 05:50(마지막 통과 01-14 08:50)${tail}`), second);
  assert.ok(second.includes('- 인증서(cert-manager): 확인 필요 · 만료 임박(7일 미만) · 가장 이른 만료 2027-01-23(6일) · 관측 01-17 08:50'), second);
  assert.doesNotMatch(second, /■ 관측 결과\n- PostgreSQL/);

  // 3회차: 통과가 100일을 넘음, 인증서 질의 실패(읽기 불가·미확인).
  annotations = records(record('pass', slot + 2 * DAY - 101 * DAY));
  certs = healthyCerts({ count: new Error('grafana_query_failed') });
  const third = await tick(2);
  assert.match(third, new RegExp(`백업 정상 · .* · 확인 필요: 복원 검증 오래됨 101일\\(마지막 통과 \\d\\d-\\d\\d 08:50\\)${tail}`));
  assert.match(third, /- 인증서\(cert-manager\): 읽기 불가 · 마지막 정상 수집 01-17 08:50 · 미확인/);

  // 4회차: 기록 JSON 오류. 복원 검증만 미확인이고 백업은 정상(관측 결과)에 남는다.
  annotations = records('{broken');
  certs = healthyCerts();
  const fourth = await tick(3);
  assert.match(fourth, new RegExp(`■ 관측 결과\\n- PostgreSQL 백업\\(pg\\): 정상 · .* · 복원 검증 기록 확인 불가\\(JSON·스키마 오류\\) · 미확인${tail}`));

  // 5회차: 기록 없음, uid 불일치(다른 Cluster의 기록), 미래 시각.
  annotations = {};
  assert.ok((await tick(4)).includes(` · 복원 검증 기록 없음(미확인)${tail}`));
  annotations = records(record('pass', slot).replace(UID, 'uid-other'));
  assert.ok((await tick(5)).includes(` · 복원 검증 기록 확인 불가(클러스터 uid 불일치) · 미확인${tail}`));
  annotations = records(record('pass', slot + 30 * DAY));
  assert.ok((await tick(6)).includes(` · 복원 검증 기록 확인 불가(미래 시각) · 미확인${tail}`));
});
