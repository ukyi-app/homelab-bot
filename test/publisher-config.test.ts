import { test } from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync } from 'node:crypto';
import pg from 'pg';
import { ADDRESS_KEYS, ConfigError, MEMORY_KEYS, SECRET_KEYS, databasePoolConfig, loadPublisherConfig } from '../src/config.js';

// 값은 모두 시험용 가짜다. 실제 토큰·ID·주소를 쓰지 않는다.
const ed25519 = () => generateKeyPairSync('ed25519').privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();
const policy = { revision: 'fixture-v1', owner: 'fixture-owner-id', guild: 'fixture-guild-id', conversationChannel: 'fixture-chat-id',
  notificationChannel: 'fixture-notify-id', dmEnabled: false, services: ['homelab-bot'], revocationRestores: [] };
export function publisherEnv(overrides: Record<string, string | undefined> = {}): Record<string, string | undefined> {
  return {
    DATABASE_URL: 'postgresql://homelab-bot:fixture-db-password@pg-rw.database.svc:5432/homelab-bot?sslmode=require',
    DISCORD_BOT_TOKEN: 'fixture-discord-token-value',
    RUNTIME_POLICIES: JSON.stringify(policy),
    GRAFANA_READER_TOKEN: 'fixture-grafana-token-value',
    HEALTHCHECKS_PING_URL: 'https://hc-ping.example/fixture-check-uuid',
    WORKER_CONTROL_PRIVATE_KEY: ed25519(),
    GITHUB_REVIEW_WEBHOOK_SECRET: 'fixture-webhook-secret-value',
    WORKER_URL: 'http://worker.sandbox:8080/',
    GRAFANA_URL: 'http://grafana.observability:3000',
    KUBERNETES_API_URL: 'https://kubernetes.default.svc',
    PORT: '8080',
    ...overrides,
  };
}
const SECRET_VALUES = ['fixture-db-password', 'fixture-discord-token-value', 'fixture-owner-id', 'fixture-grafana-token-value',
  'fixture-check-uuid', 'PRIVATE KEY', 'fixture-webhook-secret-value'];
const problems = (env: Record<string, string | undefined>) => {
  try { loadPublisherConfig(env, 1_800_000_000_000); } catch (error) {
    assert.ok(error instanceof ConfigError);
    for (const value of SECRET_VALUES) assert.ok(!error.message.includes(value), `값이 오류에 들어감: ${value}`);
    return error.problems;
  }
  return [];
};

const rsa = () => generateKeyPairSync('rsa', { modulusLength: 2048 }).privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();
test('T17 REVIEW_ENABLED: 없으면 꺼짐, true·false만 받음, 켜졌는데 App 자격이 없으면 기동 오류', () => {
  const app = { GITHUB_REVIEW_APP_ID: '12345', GITHUB_REVIEW_APP_PRIVATE_KEY: rsa() };
  assert.equal(loadPublisherConfig(publisherEnv(), 1).reviewEnabled, false);
  assert.equal(loadPublisherConfig(publisherEnv({ REVIEW_ENABLED: 'false' }), 1).reviewEnabled, false);
  assert.equal(loadPublisherConfig(publisherEnv({ REVIEW_ENABLED: 'true', ...app }), 1).reviewEnabled, true);
  // 자격만 있고 스위치가 없으면 열지 않는다.
  assert.equal(loadPublisherConfig(publisherEnv(app), 1).reviewEnabled, false);
  for (const value of ['', 'TRUE', '1', 'yes', ' true']) assert.deepEqual(problems(publisherEnv({ REVIEW_ENABLED: value })), ['REVIEW_ENABLED(invalid)'], value);
  assert.deepEqual(problems(publisherEnv({ REVIEW_ENABLED: 'true' })), ['REVIEW_ENABLED(requires GITHUB_REVIEW_APP_ID, GITHUB_REVIEW_APP_PRIVATE_KEY)']);
  // 스위치가 꺼져 있어도 자격 하나만 있으면 기동 오류다. 켜졌을 때 사유가 겹치지 않는다.
  for (const flag of [{}, { REVIEW_ENABLED: 'false' }, { REVIEW_ENABLED: 'true' }]) {
    assert.deepEqual(problems(publisherEnv({ ...flag, GITHUB_REVIEW_APP_ID: '12345' })), ['GITHUB_REVIEW_APP_PRIVATE_KEY(missing)']);
    assert.deepEqual(problems(publisherEnv({ ...flag, GITHUB_REVIEW_APP_PRIVATE_KEY: app.GITHUB_REVIEW_APP_PRIVATE_KEY })), ['GITHUB_REVIEW_APP_ID(missing)']);
  }
  assert.deepEqual(problems(publisherEnv({ REVIEW_ENABLED: 'true', GITHUB_REVIEW_APP_ID: 'not-a-number', GITHUB_REVIEW_APP_PRIVATE_KEY: app.GITHUB_REVIEW_APP_PRIVATE_KEY })), ['GITHUB_REVIEW_APP_ID(invalid)']);
});

test('T16b 설정: 키가 모두 맞으면 읽고, 정책 confirmedAt은 기동 시각', () => {
  const config = loadPublisherConfig(publisherEnv(), 1_800_000_000_000);
  assert.equal(config.policy.confirmedAt, 1_800_000_000_000); assert.equal(config.policy.owner, 'fixture-owner-id');
  assert.equal(config.workerKey.asymmetricKeyType, 'ed25519');
  assert.equal(config.workerUrl, 'http://worker.sandbox:8080/'); assert.equal(config.kubernetes.url, 'https://kubernetes.default.svc');
  // README·ARCHITECTURE §5의 env 목록과 같다. Argo CD 토큰·주소는 없다(D9: Kubernetes API의 Application CR로 읽음).
  assert.deepEqual([...SECRET_KEYS], ['DATABASE_URL', 'DISCORD_BOT_TOKEN', 'RUNTIME_POLICIES', 'GRAFANA_READER_TOKEN',
    'HEALTHCHECKS_PING_URL', 'WORKER_CONTROL_PRIVATE_KEY', 'GITHUB_REVIEW_WEBHOOK_SECRET']);
  assert.deepEqual([...ADDRESS_KEYS], ['WORKER_URL', 'GRAFANA_URL', 'KUBERNETES_API_URL']);
  assert.ok(!('argocd' in config));
});

test('D9 설정: 차트에 ARGOCD_URL·ARGOCD_READER_TOKEN이 남아 있어도(값이 틀려도) 읽지 않고 기동에 영향 없음', () => {
  assert.deepEqual(problems(publisherEnv({ ARGOCD_URL: 'not a url', ARGOCD_READER_TOKEN: 'a b' })), []);
  assert.deepEqual(problems(publisherEnv({ ARGOCD_URL: undefined, ARGOCD_READER_TOKEN: undefined })), []);
});

test('T16b 설정: 키 하나라도 없으면 기동 실패, 오류에는 키 이름만 있고 값은 없음(주소도 기본값 없음)', () => {
  for (const key of [...SECRET_KEYS, ...ADDRESS_KEYS]) {
    assert.deepEqual(problems(publisherEnv({ [key]: undefined })), [`${key}(missing)`], key);
    assert.deepEqual(problems(publisherEnv({ [key]: '   ' })), [`${key}(missing)`], key);
  }
  assert.deepEqual(problems(publisherEnv({ PORT: undefined })), []);
});

test('T16b 설정: 틀린 값은 기동 실패(토큰 공백, http ping, 경로 있는 작업자 주소, 키 종류, 정책 confirmedAt, PORT)', () => {
  const rsa = generateKeyPairSync('rsa', { modulusLength: 1024 }).privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();
  const cases: [Record<string, string>, string][] = [
    [{ DISCORD_BOT_TOKEN: 'fixture discord-token-value' }, 'DISCORD_BOT_TOKEN(invalid)'],
    [{ GRAFANA_READER_TOKEN: 'a\nb' }, 'GRAFANA_READER_TOKEN(invalid)'],
    [{ HEALTHCHECKS_PING_URL: 'http://hc-ping.example/fixture-check-uuid' }, 'HEALTHCHECKS_PING_URL(invalid)'],
    [{ WORKER_URL: 'http://worker.sandbox:8080/v1' }, 'WORKER_URL(invalid)'],
    [{ WORKER_URL: 'http://user:pw@worker.sandbox:8080/' }, 'WORKER_URL(invalid)'],
    [{ GRAFANA_URL: 'ftp://grafana.observability' }, 'GRAFANA_URL(invalid)'],
    [{ KUBERNETES_API_URL: 'http://kubernetes.default.svc' }, 'KUBERNETES_API_URL(invalid)'],
    [{ DATABASE_URL: 'mysql://x' }, 'DATABASE_URL(invalid)'],
    [{ WORKER_CONTROL_PRIVATE_KEY: rsa }, 'WORKER_CONTROL_PRIVATE_KEY(invalid)'],
    [{ WORKER_CONTROL_PRIVATE_KEY: 'not-a-key' }, 'WORKER_CONTROL_PRIVATE_KEY(invalid)'],
    [{ GITHUB_REVIEW_WEBHOOK_SECRET: 'short' }, 'GITHUB_REVIEW_WEBHOOK_SECRET(invalid)'],
    [{ RUNTIME_POLICIES: JSON.stringify({ ...policy, confirmedAt: 1 }) }, 'RUNTIME_POLICIES(invalid: confirmedAt)'],
    [{ RUNTIME_POLICIES: JSON.stringify({ ...policy, owner: 7 }) }, 'RUNTIME_POLICIES(invalid: owner)'],
    [{ RUNTIME_POLICIES: '{' }, 'RUNTIME_POLICIES(invalid: json)'],
    [{ PORT: '3000' }, 'PORT(invalid)'],
  ];
  for (const [overrides, expected] of cases) assert.deepEqual(problems(publisherEnv(overrides)), [expected], expected);
  // 여러 개가 틀리면 모두 한 번에 보여 준다.
  assert.deepEqual(problems(publisherEnv({ DISCORD_BOT_TOKEN: undefined, WORKER_URL: 'x' })), ['DISCORD_BOT_TOKEN(missing)', 'WORKER_URL(invalid)']);
});

test('T16b 설정: 한 줄로 넣은 PEM(\\n 글자)도 받음, 앞뒤 공백·개행은 무시', () => {
  const pem = ed25519();
  assert.equal(loadPublisherConfig(publisherEnv({ WORKER_CONTROL_PRIVATE_KEY: pem.replaceAll('\n', '\\n') }), 1).workerKey.asymmetricKeyType, 'ed25519');
  assert.equal(loadPublisherConfig(publisherEnv({ DISCORD_BOT_TOKEN: 'fixture-discord-token-value\n' }), 1).discordToken, 'fixture-discord-token-value');
});

test('T16b DB 연결: 차트의 sslmode=require를 libpq 의미(암호화, 인증서 검증 없음)로, node-pg 기본은 verify-full', () => {
  const url = publisherEnv().DATABASE_URL!;
  const plain = new pg.Client({ connectionString: url }) as unknown as { connectionParameters: { ssl: { rejectUnauthorized?: boolean } } };
  assert.notEqual(plain.connectionParameters.ssl.rejectUnauthorized, false);
  const config = databasePoolConfig(url);
  assert.match(String(config.connectionString), /\?sslmode=require&uselibpqcompat=true$/);
  const compat = new pg.Client(config) as unknown as { connectionParameters: { ssl: { rejectUnauthorized?: boolean } } };
  assert.equal(compat.connectionParameters.ssl.rejectUnauthorized, false);
  assert.equal(databasePoolConfig('postgresql://h/db').connectionString, 'postgresql://h/db?uselibpqcompat=true');
  assert.equal(databasePoolConfig(`${url}&uselibpqcompat=false`).connectionString, `${url}&uselibpqcompat=false`);
  assert.equal(config.statement_timeout, 10_000);
});

const LEDGER = '/var/lib/homelab-bot/ledger';
const GEN = '3f1c9a2e-7b4d-4e8a-9c21-5d6e7f8a9b0c';
test('T20 설정: 원장·브리핑 env가 없으면 둘 다 꺼짐(T20 전과 같음), 있으면 읽음', () => {
  assert.deepEqual([...MEMORY_KEYS], ['MEMORY_LEDGER_DIR', 'MEMORY_LEDGER_ACCEPT_GENERATION', 'BRIEFING_TIME', 'BRIEFING_TIMEZONE']);
  const off = loadPublisherConfig(publisherEnv(), 1_800_000_000_000);
  assert.equal(off.memory, null); assert.equal(off.briefing, null);
  const ledgerOnly = loadPublisherConfig(publisherEnv({ MEMORY_LEDGER_DIR: LEDGER }), 1_800_000_000_000);
  assert.deepEqual(ledgerOnly.memory, { ledgerDir: LEDGER, acceptGeneration: null }); assert.equal(ledgerOnly.briefing, null);
  const all = loadPublisherConfig(publisherEnv({ MEMORY_LEDGER_DIR: LEDGER, MEMORY_LEDGER_ACCEPT_GENERATION: GEN,
    BRIEFING_TIME: '08:50', BRIEFING_TIMEZONE: 'Asia/Seoul' }), 1_800_000_000_000);
  assert.deepEqual(all.memory, { ledgerDir: LEDGER, acceptGeneration: GEN });
  assert.deepEqual(all.briefing, { time: '08:50', timezone: 'Asia/Seoul' });
});

test('T20 설정: 형식이 틀리면 기동 실패, 오류에는 키 이름과 사유만(값·경로 없음)', () => {
  const bad: [string, string][] = [
    ['MEMORY_LEDGER_DIR', 'var/lib/homelab-bot/ledger'], ['MEMORY_LEDGER_DIR', '/var/lib/homelab-bot'], ['MEMORY_LEDGER_DIR', '/var/lib/homelab-bot/'],
    ['MEMORY_LEDGER_DIR', '/var/lib/homelab-bot/ledger/'], ['MEMORY_LEDGER_DIR', '/var/lib/homelab-bot/../secret-place'],
    ['MEMORY_LEDGER_DIR', '/var/lib/homelab-bot-other/ledger'], ['MEMORY_LEDGER_DIR', '/tmp/secret-place'], ['MEMORY_LEDGER_DIR', ''],
    ['MEMORY_LEDGER_DIR', '/var/lib/homelab-bot//ledger'],
  ];
  for (const [key, value] of bad) {
    const found = problems(publisherEnv({ [key]: value }));
    assert.deepEqual(found, [`${key}(invalid)`], `${key}=${value}`);
    assert.ok(!found.join().includes('secret-place'));
  }
  const withLedger = (extra: Record<string, string | undefined>) => problems(publisherEnv({ MEMORY_LEDGER_DIR: LEDGER, ...extra }));
  for (const value of ['3F1C9A2E-7B4D-4E8A-9C21-5D6E7F8A9B0C', '3f1c9a2e-7b4d-1e8a-9c21-5d6e7f8a9b0c', 'not-a-uuid', '']) {
    assert.deepEqual(withLedger({ MEMORY_LEDGER_ACCEPT_GENERATION: value }), ['MEMORY_LEDGER_ACCEPT_GENERATION(invalid)'], value);
  }
  for (const value of ['8:50', '24:00', '08:60', '0850', '08:50:00', ' 08:50', '']) {
    assert.deepEqual(withLedger({ BRIEFING_TIME: value, BRIEFING_TIMEZONE: 'Asia/Seoul' }), ['BRIEFING_TIME(invalid)'], value);
  }
  for (const value of ['Asia/Nowhere', 'KST+9', '']) {
    assert.deepEqual(withLedger({ BRIEFING_TIME: '08:50', BRIEFING_TIMEZONE: value }), ['BRIEFING_TIMEZONE(invalid)'], value);
  }
});

test('T20 설정: 브리핑 둘 중 하나만 있거나, 원장 없이 원장 의존 키가 있으면 기동 실패(조용히 끄지 않음)', () => {
  assert.deepEqual(problems(publisherEnv({ MEMORY_LEDGER_DIR: LEDGER, BRIEFING_TIME: '08:50' })), ['BRIEFING_TIMEZONE(missing)']);
  assert.deepEqual(problems(publisherEnv({ MEMORY_LEDGER_DIR: LEDGER, BRIEFING_TIMEZONE: 'Asia/Seoul' })), ['BRIEFING_TIME(missing)']);
  assert.deepEqual(problems(publisherEnv({ BRIEFING_TIME: '08:50', BRIEFING_TIMEZONE: 'Asia/Seoul' })),
    ['BRIEFING_TIME(requires MEMORY_LEDGER_DIR)', 'BRIEFING_TIMEZONE(requires MEMORY_LEDGER_DIR)']);
  assert.deepEqual(problems(publisherEnv({ MEMORY_LEDGER_ACCEPT_GENERATION: GEN })), ['MEMORY_LEDGER_ACCEPT_GENERATION(requires MEMORY_LEDGER_DIR)']);
  // 다른 키 오류와 함께 모두 모아 알린다.
  assert.deepEqual(problems(publisherEnv({ WORKER_URL: undefined, MEMORY_LEDGER_DIR: '/tmp/x', BRIEFING_TIME: '25:00' })),
    ['WORKER_URL(missing)', 'MEMORY_LEDGER_DIR(invalid)', 'BRIEFING_TIME(invalid)', 'BRIEFING_TIMEZONE(missing)']);
});

test('C01 동료 기능 스위치: 정책에 칸이 없거나 false면 꺼짐, true면 켜짐', () => {
  const withSwitch = (value: unknown) => publisherEnv({ RUNTIME_POLICIES: JSON.stringify({ ...policy, colleagueEnabled: value }) });
  assert.equal(loadPublisherConfig(publisherEnv(), 1).colleagueEnabled, false);
  assert.equal(loadPublisherConfig(withSwitch(false), 1).colleagueEnabled, false);
  assert.equal(loadPublisherConfig(withSwitch(true), 1).colleagueEnabled, true);
});
