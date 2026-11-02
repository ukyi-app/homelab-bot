import { createPrivateKey } from 'node:crypto';
import type { KeyObject } from 'node:crypto';
import { posix } from 'node:path';
import type { PoolConfig } from 'pg';
import { loadRuntimePolicy } from './policy.js';
import type { Policy } from './policy.js';
import { PORTS } from './http.js';
import { validTime, validZone } from './briefing.js';

// 게시 서버 env. 비밀은 Infisical /apps/homelab-bot/ → 공유 차트 secretKeyRef, 주소는 차트 values env.
// 주소도 기본값을 두지 않는다. 하나라도 없거나 틀리면 기동하지 않고, 오류에는 키 이름과 사유만 남긴다(값은 남기지 않는다).
// Argo CD 앱 상태는 Kubernetes API(SA bot-reader)로 읽어 Argo CD 토큰·주소가 없다(D9).
export const SECRET_KEYS = Object.freeze(['DATABASE_URL', 'DISCORD_BOT_TOKEN', 'RUNTIME_POLICIES', 'GRAFANA_READER_TOKEN',
  'HEALTHCHECKS_PING_URL', 'WORKER_CONTROL_PRIVATE_KEY', 'GITHUB_REVIEW_WEBHOOK_SECRET'] as const);
export const ADDRESS_KEYS = Object.freeze(['WORKER_URL', 'GRAFANA_URL', 'KUBERNETES_API_URL'] as const);
// T20 기억·브리핑(비밀 아님, 차트 env). 없으면 끈다. 있는데 틀리면 기동하지 않는다(조용히 끄지 않는다).
export const MEMORY_KEYS = Object.freeze(['MEMORY_LEDGER_DIR', 'MEMORY_LEDGER_ACCEPT_GENERATION', 'BRIEFING_TIME', 'BRIEFING_TIMEZONE'] as const);
// 원장 PVC 마운트(계약 v1 /var/lib/homelab-bot/ledger)가 들어갈 수 있는 곳. 그 밖 경로는 컨테이너 쓰기 층이라 재시작에 사라진다.
export const LEDGER_ROOT = '/var/lib/homelab-bot/';
const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
export class ConfigError extends Error {
  constructor(readonly problems: readonly string[]) { super(`config_invalid: ${problems.join(', ')}`); }
}
export interface PublisherConfig {
  databaseUrl: string; discordToken: string; policy: Policy;
  grafana: { url: string; token: string }; kubernetes: { url: string };
  workerUrl: string; healthchecksUrl: string; workerKey: KeyObject; githubWebhookSecret: string;
  // null(또는 없음)이면 기억·원장·브리핑을 만들지 않는다(T20 전과 같은 동작).
  memory?: { ledgerDir: string; acceptGeneration: string | null } | null;
  // null이면 브리핑 예약을 끈다(ensure()가 남은 사본을 막음). memory 없이 켤 수 없다.
  briefing?: { time: string; timezone: string } | null;
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
  const kubernetesUrl = read('KUBERNETES_API_URL', value => url(value, ['https:'], true));
  const { memory, briefing } = memoryConfig(env, problems);
  if (problems.length || !policy || !workerKey) throw new ConfigError(problems.length ? problems : ['unknown']);
  return { databaseUrl, discordToken, policy, grafana: { url: grafanaUrl, token: grafanaToken },
    kubernetes: { url: kubernetesUrl }, workerUrl, healthchecksUrl,
    workerKey, githubWebhookSecret, memory, briefing };
}
// 선택 키는 "없음(undefined)"만 끔으로 본다. 빈 값은 잘못 넣은 것이라 오류다.
function memoryConfig(env: Env, problems: string[]): Pick<PublisherConfig, 'memory' | 'briefing'> {
  const optional = (key: (typeof MEMORY_KEYS)[number], valid: (value: string) => boolean): string | null => {
    const value = env[key];
    if (value === undefined) return null;
    if (!valid(value)) { problems.push(`${key}(invalid)`); return null; }
    return value;
  };
  const ledgerDir = optional('MEMORY_LEDGER_DIR', value => posix.isAbsolute(value) && posix.normalize(value) === value
    && !value.endsWith('/') && value.startsWith(LEDGER_ROOT) && value.length > LEDGER_ROOT.length);
  const acceptGeneration = optional('MEMORY_LEDGER_ACCEPT_GENERATION', value => UUID_V4.test(value));
  const time = optional('BRIEFING_TIME', validTime);
  const timezone = optional('BRIEFING_TIMEZONE', validZone);
  // 하나만 있으면 운영자가 뭘 원했는지 모른다. 둘 다 있거나 둘 다 없어야 한다.
  if ((env.BRIEFING_TIME === undefined) !== (env.BRIEFING_TIMEZONE === undefined)) {
    problems.push(`${env.BRIEFING_TIME === undefined ? 'BRIEFING_TIME' : 'BRIEFING_TIMEZONE'}(missing)`);
  }
  // 원장 없이는 기억도 브리핑도 만들지 않는다. 원장만 빠뜨린 설정을 브리핑 꺼짐으로 조용히 받지 않는다.
  if (env.MEMORY_LEDGER_DIR === undefined) {
    for (const key of ['MEMORY_LEDGER_ACCEPT_GENERATION', 'BRIEFING_TIME', 'BRIEFING_TIMEZONE'] as const) {
      if (env[key] !== undefined) problems.push(`${key}(requires MEMORY_LEDGER_DIR)`);
    }
  }
  return { memory: ledgerDir ? { ledgerDir, acceptGeneration } : null, briefing: time && timezone ? { time, timezone } : null };
}
// 공유 차트의 DATABASE_URL은 sslmode=require다. node-pg는 libpq와 달리 require를 verify-full로 다뤄,
// 플랫폼 CNPG의 자체 서명 인증서에서 연결이 실패한다. libpq 의미(암호화, 인증서 검증 없음)로 맞춘다.
export function databasePoolConfig(databaseUrl: string, overrides: PoolConfig = {}): PoolConfig {
  const connectionString = /[?&]uselibpqcompat=/.test(databaseUrl) ? databaseUrl
    : `${databaseUrl}${databaseUrl.includes('?') ? '&' : '?'}uselibpqcompat=true`;
  return { connectionString, application_name: 'homelab-bot', max: 5, connectionTimeoutMillis: 5000,
    idleTimeoutMillis: 30_000, statement_timeout: 10_000, ...overrides };
}
