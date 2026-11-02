import { after, before, beforeEach, test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import type { IncomingMessage, Server, ServerResponse } from 'node:http';
import { once } from 'node:events';
import type { AddressInfo } from 'node:net';
import { BriefingScheduler } from '../src/briefing.js';
import type { Observation } from '../src/briefing.js';
import { BACKUP_STALE_MS, backupSource, briefingSources, scheduledJobSource } from '../src/briefing-observations.js';
import type { MemoryService } from '../src/memory.js';
import { kubernetesTransport } from '../src/read-transports.js';
import { fixture, localDatabase } from './helpers.js';

// 브리핑 관측 어댑터(T20 B5). 가짜 Kubernetes API 응답만 쓴다. 실제 클러스터에는 연결하지 않는다.
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

test('[T20 B5] 백업 정상: 고정 경로 둘만 읽고 관측 시각은 읽은 시각, 복원 검증은 채우지 않음', async () => {
  const k8s = mock({ [CLUSTER_PATH]: cluster(), [BACKUPS_PATH]: healthyBackups() });
  const source = backupSource(k8s, now, { namespace: 'database', cluster: 'pg' });
  assert.equal(source.kind, 'backup');
  const value = await source.read();
  assert.deepEqual(value, { observedAt: NOW, status: 'ok', summary: '마지막 성공 백업 19시간 전 · WAL 아카이브 정상', restoreVerifiedAt: null });
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

// PR #26 리뷰 지적 1: concurrencyPolicy Allow면 새 회차마다 lastScheduleTime이 갱신된다. 예약 시각이 아니라
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

// PR #26 리뷰 지적 2: lastSuccessfulTime >= lastScheduleTime은 마지막 회차의 성공이 아니다
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
  assert.match(first, /PostgreSQL 백업\(pg\): 정상 · 마지막 성공 백업 10시간 전 · WAL 아카이브 정상 · 관측 01-16 08:50 · 복원 검증 미확인\(백업 성공과 별개\)/);
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
  assert.match(content, /- Codex 작업 상태·승인\/질문 대기: 연결 전\(T18\) · 미확인/);
});
