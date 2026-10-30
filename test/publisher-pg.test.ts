import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID, generateKeyPairSync } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import pg from 'pg';
import { databasePoolConfig } from '../src/config.js';
import type { PublisherConfig } from '../src/config.js';
import { MIGRATIONS, Postgres, appliedMigrations } from '../src/database.js';
import { startPublisher } from '../src/main.js';
import { runMigrations } from '../src/migrate-main.js';
import { loadRuntimePolicy } from '../src/policy.js';
import { Store } from '../src/store.js';
import { thread } from './helpers.js';

// 실제 PostgreSQL(18) 시험. HOMELAB_TEST_PG_SOCKET(유닉스 소켓 디렉터리)이 없으면 건너뛴다. 실행 방법은 VERIFICATION T20 절과 같다.
const socket = process.env.HOMELAB_TEST_PG_SOCKET;
const skip = socket ? false : 'HOMELAB_TEST_PG_SOCKET 없음(로컬 PostgreSQL 필요)';
const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
async function database() {
  const admin = new pg.Pool({ host: socket, user: 'postgres', database: 'postgres', max: 1 });
  const name = `t16b_${randomUUID().replaceAll('-', '').slice(0, 12)}`;
  await admin.query(`CREATE DATABASE ${name}`);
  // 진입점과 같은 설정 함수로 연결한다(sslmode 없음 + uselibpqcompat, 소켓 경로는 host 매개변수).
  const url = `postgresql://postgres@localhost/${name}?host=${encodeURIComponent(socket!)}`;
  const pools: pg.Pool[] = [];
  const pool = (max = 1) => { const p = new pg.Pool(databasePoolConfig(url, { max })); pools.push(p); return p; };
  return { name, pool, close: async () => {
    for (const p of pools) await p.end().catch(() => {});
    for (let attempt = 0; ; attempt++) {
      try { await admin.query(`DROP DATABASE ${name}`); break; } catch (error) {
        if (attempt >= 50 || !/being accessed by other users/.test((error as Error).message)) throw error;
        await sleep(100);
      }
    }
    await admin.end();
  } };
}
const pendingAlert = (db: Postgres) => new Store(db).enqueue({ key: 'alert:fixture-group:fixture-fingerprint:1', actor: 'fixture-owner',
  scope: thread, revision: 'fixture-v1', payload: { kind: 'message', channel: thread.channel, content: '경보', classification: 'safe_summary' } });

test('T16b 위험 5 실제 PostgreSQL: 마이그레이션 진입점 재실행은 빈 목록, 006이 대기 경보를 다시 막지 않음', { skip }, async () => {
  const d = await database();
  try {
    const pool = d.pool();
    assert.deepEqual(await runMigrations(pool), MIGRATIONS.map((_, i) => i + 1));
    const db = new Postgres(d.pool(2));
    await pendingAlert(db);
    assert.deepEqual(await runMigrations(pool), []);
    assert.equal((await db.query<{ state: string }>('SELECT state FROM outbox')).rows[0]!.state, 'pending');
    assert.equal((await db.query("SELECT 1 FROM audit WHERE kind='legacy_alert_scope_missing'")).rows.length, 0);
  } finally { await d.close(); }
});

test('T16b 실제 PostgreSQL: 마이그레이션 Job 두 개가 겹쳐도 advisory lock으로 한 번만 적용', { skip }, async () => {
  const d = await database();
  try {
    const results = await Promise.all([runMigrations(d.pool()), runMigrations(d.pool()), runMigrations(d.pool())]);
    assert.deepEqual(results.map(r => r.length).sort(), [0, 0, 11]);
    assert.equal((await appliedMigrations(new Postgres(d.pool()))).size, 11);
  } finally { await d.close(); }
});

test('T16b 실제 PostgreSQL: 010까지 적용된 기존 DB는 011만 적용', { skip }, async () => {
  const d = await database();
  try {
    const pool = d.pool();
    for (const file of MIGRATIONS.slice(0, 10)) await pool.query(await readFile(`migrations/${file}`, 'utf8'));
    const db = new Postgres(d.pool(2));
    await pendingAlert(db);
    assert.deepEqual(await runMigrations(pool), [11]);
    assert.equal((await db.query<{ state: string }>('SELECT state FROM outbox')).rows[0]!.state, 'pending');
  } finally { await d.close(); }
});

test('T16b 실제 PostgreSQL: 진입점은 실제 풀로 /readyz 200(DB 쓰기), 경보 저장, 정지 뒤 수신 닫힘', { skip }, async () => {
  const d = await database();
  try {
    await runMigrations(d.pool());
    const db = new Postgres(d.pool(5));
    const config: PublisherConfig = { databaseUrl: 'unused', discordToken: 'fixture-discord-token',
      policy: loadRuntimePolicy(JSON.stringify({ revision: 'fixture-v1', owner: 'fixture-owner', guild: 'fixture-guild',
        conversationChannel: 'fixture-chat', notificationChannel: 'fixture-notifications', dmEnabled: false, services: ['homelab-bot'] }), Date.now()),
      grafana: { url: 'http://127.0.0.1:9', token: 'x' }, argocd: { url: 'http://127.0.0.1:9', token: 'x' }, kubernetes: { url: 'http://127.0.0.1:9' },
      workerUrl: 'http://127.0.0.1:9/', healthchecksUrl: 'http://127.0.0.1:9/ping', workerKey: generateKeyPairSync('ed25519').privateKey,
      githubWebhookSecret: 'fixture-webhook-secret-value' };
    const p = await startPublisher(config, { db, gatewayUrl: () => new Promise(() => {}), ports: { app: 0, alerts: 0 },
      serviceAccount: { tokenFile: '/nonexistent', caFile: null }, idleMs: 20, stopTimeoutMs: 3000, log: () => {} });
    try {
      assert.equal((await fetch(`http://127.0.0.1:${p.ports.app}/readyz`)).status, 200);
      const alert = { groupKey: 'fixture-group', status: 'firing', alerts: [{ fingerprint: 'f1', labels: { service: 'homelab-bot', severity: 'warning' } }] };
      assert.equal((await fetch(`http://127.0.0.1:${p.ports.alerts}/alerts`, { method: 'POST', body: JSON.stringify(alert) })).status, 202);
      assert.equal((await db.query<{ count: string }>('SELECT count(*) FROM outbox')).rows[0]!.count, '1');
    } finally { await p.stop(); }
    await assert.rejects(fetch(`http://127.0.0.1:${p.ports.app}/readyz`));
  } finally { await d.close(); }
});
