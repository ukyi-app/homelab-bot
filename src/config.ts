import { createPrivateKey } from 'node:crypto';
import type { KeyObject } from 'node:crypto';
import type { PoolConfig } from 'pg';
import { loadRuntimePolicy } from './policy.js';
import type { Policy } from './policy.js';
import { PORTS } from './http.js';

// 게시 서버 env. 비밀은 Infisical /apps/homelab-bot/ → 공유 차트 secretKeyRef, 주소는 차트 values env.
// 주소도 기본값을 두지 않는다. 하나라도 없거나 틀리면 기동하지 않고, 오류에는 키 이름과 사유만 남긴다(값은 남기지 않는다).
export const SECRET_KEYS = Object.freeze(['DATABASE_URL', 'DISCORD_BOT_TOKEN', 'RUNTIME_POLICIES', 'GRAFANA_READER_TOKEN',
  'ARGOCD_READER_TOKEN', 'HEALTHCHECKS_PING_URL', 'WORKER_CONTROL_PRIVATE_KEY', 'GITHUB_REVIEW_WEBHOOK_SECRET'] as const);
export const ADDRESS_KEYS = Object.freeze(['WORKER_URL', 'GRAFANA_URL', 'ARGOCD_URL', 'KUBERNETES_API_URL'] as const);
export class ConfigError extends Error {
  constructor(readonly problems: readonly string[]) { super(`config_invalid: ${problems.join(', ')}`); }
}
export interface PublisherConfig {
  databaseUrl: string; discordToken: string; policy: Policy;
  grafana: { url: string; token: string }; argocd: { url: string; token: string }; kubernetes: { url: string };
  workerUrl: string; healthchecksUrl: string; workerKey: KeyObject; githubWebhookSecret: string;
}
type Env = Readonly<Record<string, string | undefined>>;
const token = (value: string) => value.length > 0 && !/\s/.test(value);
function url(value: string, protocols: string[], pathRoot: boolean): boolean {
  try {
    const parsed = new URL(value);
    return protocols.includes(parsed.protocol) && !parsed.username && !parsed.password && !parsed.hash
      && (!pathRoot || (parsed.pathname === '/' && !parsed.search));
  } catch { return false; }
}
export function loadPublisherConfig(env: Env, loadedAt: number): PublisherConfig {
  const problems: string[] = [];
  const read = (key: string, valid: (value: string) => boolean): string => {
    const value = env[key]?.trim();
    if (!value) { problems.push(`${key}(missing)`); return ''; }
    if (!valid(value)) { problems.push(`${key}(invalid)`); return ''; }
    return value;
  };
  // 차트가 web 앱에 넣는 PORT는 서비스·probe 포트다. 봇 수신 포트(8080)와 다르면 Service가 엉뚱한 곳을 본다.
  if (env.PORT !== undefined && env.PORT.trim() !== String(PORTS.publisher)) problems.push('PORT(invalid)');
  // DB URL은 자격(역할·비밀번호)을 담는 게 정상이라 scheme만 본다.
  const databaseUrl = read('DATABASE_URL', value => { try { return ['postgres:', 'postgresql:'].includes(new URL(value).protocol); } catch { return false; } });
  const discordToken = read('DISCORD_BOT_TOKEN', token);
  let policy: Policy | undefined;
  const rawPolicy = read('RUNTIME_POLICIES', () => true);
  if (rawPolicy) {
    try { policy = loadRuntimePolicy(rawPolicy, loadedAt); }
    catch (error) { problems.push(`RUNTIME_POLICIES(${error instanceof Error ? error.message.replace(/^runtime_policies_invalid: /, 'invalid: ') : 'invalid'})`); }
  }
  const grafanaToken = read('GRAFANA_READER_TOKEN', token);
  const argocdToken = read('ARGOCD_READER_TOKEN', token);
  const healthchecksUrl = read('HEALTHCHECKS_PING_URL', value => url(value, ['https:'], false));
  let workerKey: KeyObject | undefined;
  const rawKey = read('WORKER_CONTROL_PRIVATE_KEY', () => true);
  if (rawKey) {
    try {
      const key = createPrivateKey(rawKey.replaceAll('\\n', '\n'));
      if (key.asymmetricKeyType !== 'ed25519') throw new Error('not_ed25519');
      workerKey = key;
    } catch { problems.push('WORKER_CONTROL_PRIVATE_KEY(invalid)'); }
  }
  // GitHub webhook 비밀(D6). 시험 webhook과 T17 리뷰 App이 같은 값을 쓴다. homelab secret set 하한과 같은 16자 이상.
  const githubWebhookSecret = read('GITHUB_REVIEW_WEBHOOK_SECRET', value => value.length >= 16);
  const workerUrl = read('WORKER_URL', value => url(value, ['http:'], true));
  const grafanaUrl = read('GRAFANA_URL', value => url(value, ['http:', 'https:'], true));
  const argocdUrl = read('ARGOCD_URL', value => url(value, ['http:', 'https:'], true));
  const kubernetesUrl = read('KUBERNETES_API_URL', value => url(value, ['https:'], true));
  if (problems.length || !policy || !workerKey) throw new ConfigError(problems.length ? problems : ['unknown']);
  return { databaseUrl, discordToken, policy, grafana: { url: grafanaUrl, token: grafanaToken },
    argocd: { url: argocdUrl, token: argocdToken }, kubernetes: { url: kubernetesUrl }, workerUrl, healthchecksUrl,
    workerKey, githubWebhookSecret };
}
// 공유 차트의 DATABASE_URL은 sslmode=require다. node-pg는 libpq와 달리 require를 verify-full로 다뤄,
// 플랫폼 CNPG의 자체 서명 인증서에서 연결이 실패한다. libpq 의미(암호화, 인증서 검증 없음)로 맞춘다.
export function databasePoolConfig(databaseUrl: string, overrides: PoolConfig = {}): PoolConfig {
  const connectionString = /[?&]uselibpqcompat=/.test(databaseUrl) ? databaseUrl
    : `${databaseUrl}${databaseUrl.includes('?') ? '&' : '?'}uselibpqcompat=true`;
  return { connectionString, application_name: 'homelab-bot', max: 5, connectionTimeoutMillis: 5000,
    idleTimeoutMillis: 30_000, statement_timeout: 10_000, ...overrides };
}
