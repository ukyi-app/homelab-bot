import { test } from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync } from 'node:crypto';
import pg from 'pg';
import { ADDRESS_KEYS, ConfigError, SECRET_KEYS, databasePoolConfig, loadPublisherConfig } from '../src/config.js';

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
    ARGOCD_READER_TOKEN: 'fixture-argocd-token-value',
    HEALTHCHECKS_PING_URL: 'https://hc-ping.example/fixture-check-uuid',
    WORKER_CONTROL_PRIVATE_KEY: ed25519(),
    GITHUB_REVIEW_WEBHOOK_SECRET: 'fixture-webhook-secret-value',
    WORKER_URL: 'http://worker.sandbox:8080/',
    GRAFANA_URL: 'http://grafana.observability:3000',
    ARGOCD_URL: 'http://argocd-server.argocd:80',
    KUBERNETES_API_URL: 'https://kubernetes.default.svc',
    PORT: '8080',
    ...overrides,
  };
}
const SECRET_VALUES = ['fixture-db-password', 'fixture-discord-token-value', 'fixture-owner-id', 'fixture-grafana-token-value',
  'fixture-argocd-token-value', 'fixture-check-uuid', 'PRIVATE KEY', 'fixture-webhook-secret-value'];
const problems = (env: Record<string, string | undefined>) => {
  try { loadPublisherConfig(env, 1_800_000_000_000); } catch (error) {
    assert.ok(error instanceof ConfigError);
    for (const value of SECRET_VALUES) assert.ok(!error.message.includes(value), `값이 오류에 들어감: ${value}`);
    return error.problems;
  }
  return [];
};

test('T16b 설정: 키가 모두 맞으면 읽고, 정책 confirmedAt은 기동 시각', () => {
  const config = loadPublisherConfig(publisherEnv(), 1_800_000_000_000);
  assert.equal(config.policy.confirmedAt, 1_800_000_000_000); assert.equal(config.policy.owner, 'fixture-owner-id');
  assert.equal(config.workerKey.asymmetricKeyType, 'ed25519');
  assert.equal(config.workerUrl, 'http://worker.sandbox:8080/'); assert.equal(config.kubernetes.url, 'https://kubernetes.default.svc');
  assert.deepEqual([...SECRET_KEYS, ...ADDRESS_KEYS].length, 12);
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
