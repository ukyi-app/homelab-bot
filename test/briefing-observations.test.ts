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
  ({ metadata: { name, namespace: 'app-a' }, spec: { schedule: '0 3 * * *', suspend }, status });

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
  const read = (reply: Reply) => scheduledJobSource(mock({ [CRONJOBS_PATH]: reply }), now).read();
  assert.deepEqual(await read({ items: [] }), { observedAt: NOW, status: 'ok', summary: '등록된 CronJob 없음' });
  const fine = await read({ items: [
    cronjob('a-valkey-backup', { lastScheduleTime: iso(NOW - 2 * HOUR), lastSuccessfulTime: iso(NOW - 2 * HOUR + 30_000) }),
    cronjob('a-report', { lastScheduleTime: iso(NOW - 60_000), lastSuccessfulTime: iso(NOW - DAY), active: [{ name: 'a-report-1' }] }),
  ] });
  assert.deepEqual([fine.status, fine.summary], ['ok', 'CronJob 2개 마지막 실행 성공']);
  const bad = await read({ items: [
    cronjob('failed', { lastScheduleTime: iso(NOW - HOUR), lastSuccessfulTime: iso(NOW - DAY) }),
    cronjob('never-succeeded', { lastScheduleTime: iso(NOW - HOUR) }),
    cronjob('paused', { lastScheduleTime: iso(NOW - HOUR), lastSuccessfulTime: iso(NOW - HOUR + 1000) }, true),
    cronjob('never-ran', {}),
    cronjob('stuck', { lastScheduleTime: iso(NOW - DAY - HOUR), active: [{ name: 'stuck-1' }] }),
    cronjob('ok', { lastScheduleTime: iso(NOW - HOUR), lastSuccessfulTime: iso(NOW - HOUR + 1000) }),
  ] });
  assert.equal(bad.status, 'problem');
  assert.equal(bad.summary, 'CronJob 6개 중 확인 필요 5개: app-a/failed(마지막 실행 실패), app-a/never-succeeded(마지막 실행 실패), '
    + 'app-a/paused(일시 중지), app-a/never-ran(실행 기록 없음), app-a/stuck(24시간 넘게 실행 중)');
  const many = await read({ items: Array.from({ length: 7 }, (_, i) => cronjob(`job-${i}`, {})) });
  assert.match(many.summary, /CronJob 7개 중 확인 필요 7개: .*job-4\(실행 기록 없음\) 외 2개$/);
  await assert.rejects(read(new Error('read_http_403')), /read_http_403/);
  await assert.rejects(read({ items: [{ metadata: { name: 'x' } }] }));
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
    [CRONJOBS_PATH]: { items: [cronjob('a-valkey-backup', { lastScheduleTime: iso(slot + 2 * DAY - HOUR) })] } });
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
