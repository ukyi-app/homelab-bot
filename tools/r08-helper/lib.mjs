// R08 사람 쪽 helper의 공용 코드. 사람 기기에 복사해 쓰므로 Node 내장 모듈만 쓴다(README.md).
// 훅은 큐에 넣고 끝나며 네트워크·키를 만지지 않는다. 키는 전송기만 OS 비밀 저장소에서 읽는다.
// 원본 hook·notify 입력은 어디에도 남기지 않는다. 이 파일에서 파일이나 stderr로 나가는 것은 ID·고정 사유 코드뿐이다.
import { createHash, createPrivateKey, randomBytes, sign } from 'node:crypto';
import { execFile } from 'node:child_process';
import { appendFile, chmod, mkdir, open, readFile, readdir, rename, rm, rmdir, stat, truncate } from 'node:fs/promises';
import { request as httpRequest } from 'node:http';
import { request as httpsRequest } from 'node:https';
import { homedir } from 'node:os';
import { join } from 'node:path';

export const FIXED_SUMMARY = '턴 완료';
export const EVENT_PATH = '/external-task-events';
export const QUEUE_LIMITS = Object.freeze({ events: 100, bytes: 1024 * 1024, ttlMs: 24 * 3_600_000 });
export const SEND_LIMITS = Object.freeze({ connectMs: 2000, totalMs: 5000, backoffBaseMs: 5000, backoffMaxMs: 900_000, retryAfterMaxMs: 3_600_000 });
export const INPUT_LIMIT_BYTES = 8 * 1024 * 1024;
const BODY_BYTES = 4096;
const SUMMARY_CODE_POINTS = 500;
const SUMMARY_BYTES = 2000;
const FAILURE_LOG_BYTES = 256 * 1024;
const LOCK_WAIT_MS = 2000;
const LOCK_STALE_MS = 10_000;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const KEY_ID = /^[A-Za-z0-9_-]{16}$/;
const EXTERNAL_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const EVENT_ID = /^[A-Za-z0-9_-]{16,64}$/;
const ENVIRONMENT = /^[a-z0-9][a-z0-9-]{0,62}$/;
const KEY_REF = /^(keychain|libsecret):([A-Za-z0-9._-]{1,64}):([A-Za-z0-9._-]{1,64})$/;
const SEED = /^[A-Za-z0-9_-]{43}$/;
const FAILURE_REASON = /^[a-z][a-z0-9_]{0,60}$/;

export function helperPaths(env = process.env) {
  const home = homedir();
  return {
    config: env.R08_HELPER_CONFIG ?? join(env.XDG_CONFIG_HOME ?? join(home, '.config'), 'r08-helper', 'config.json'),
    state: env.R08_HELPER_STATE ?? join(env.XDG_STATE_HOME ?? join(home, '.local', 'state'), 'r08-helper'),
  };
}

class ConfigError extends Error { constructor() { super('config_invalid'); } }
const CONFIG_KEYS = new Set(['version', 'endpoint', 'environment', 'connections']);
const CONNECTION_KEYS = new Set(['connection_id', 'key_id', 'external_task_id', 'executor', 'key_ref', 'summary_consent']);
const onlyKeys = (value, keys) => value && typeof value === 'object' && !Array.isArray(value) && Object.keys(value).every(key => keys.has(key));
// 모르는 키를 거절하므로 설정 파일에 seed 같은 값을 넣으면 쓰이지 않고 바로 실패한다.
export function parseConfig(text) {
  let config;
  try { config = JSON.parse(text); } catch { throw new ConfigError(); }
  if (!onlyKeys(config, CONFIG_KEYS) || config.version !== 1 || typeof config.environment !== 'string' || !ENVIRONMENT.test(config.environment)
    || !Array.isArray(config.connections) || typeof config.endpoint !== 'string') throw new ConfigError();
  let endpoint;
  try { endpoint = new URL(config.endpoint); } catch { throw new ConfigError(); }
  const loopback = ['127.0.0.1', 'localhost', '[::1]'].includes(endpoint.hostname);
  if ((endpoint.protocol !== 'https:' && !(endpoint.protocol === 'http:' && loopback)) || endpoint.pathname !== EVENT_PATH
    || endpoint.search || endpoint.hash || endpoint.username || endpoint.password) throw new ConfigError();
  for (const connection of config.connections) {
    if (!onlyKeys(connection, CONNECTION_KEYS) || typeof connection.connection_id !== 'string' || !UUID.test(connection.connection_id)
      || typeof connection.key_id !== 'string' || !KEY_ID.test(connection.key_id)
      || typeof connection.external_task_id !== 'string' || !EXTERNAL_ID.test(connection.external_task_id)
      || (connection.executor !== 'claude' && connection.executor !== 'codex')
      || typeof connection.key_ref !== 'string' || !KEY_REF.test(connection.key_ref)
      || (connection.summary_consent !== undefined && typeof connection.summary_consent !== 'boolean')) throw new ConfigError();
  }
  return config;
}
// 목적지와 키 참조를 정하는 파일이라 다른 사용자가 쓸 수 있으면 믿지 않는다.
export async function loadConfig(path) {
  try {
    const info = await stat(path);
    if (info.mode & 0o022) throw new ConfigError();
    return parseConfig(await readFile(path, 'utf8'));
  } catch { throw new ConfigError(); }
}

// 서버 src/external-task-receiver.ts의 표와 같다. 시험이 두 쪽의 판정을 대조한다.
const SUSPECT_SUMMARY = [
  /(^|[\s"'`(=:,])(~[/\\]|\/(Users|home|root|etc|var|tmp|opt|private|mnt|srv|usr|run|proc|sys)([/\\\s]|$))/,
  /(^|[\s"'`(=:,])[A-Za-z]:[\\/]/, /\\\\[A-Za-z0-9._-]+\\/, /file:\/\//i, /:\/\/[^\s/@]+:[^\s/@]+@/,
  /\bsk-[A-Za-z0-9_-]{10,}/, /\bgh[pousr]_[A-Za-z0-9]{10,}/, /\bgithub_pat_/i, /\bxox[abprs]-/, /\bAKIA[0-9A-Z]{12,}/, /\bAIza[0-9A-Za-z_-]{20,}/,
  /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/, /-----BEGIN [A-Z ]*(PRIVATE KEY|CERTIFICATE)/, /\bbearer\s+[A-Za-z0-9._~+/=-]{8,}/i,
  /\b(password|passwd|pwd|secret|token|api[_-]?key|credential)s?\s*[:=]\s*\S/i, /(비밀번호|암호|토큰|시크릿)\s*[:=]\s*\S/,
  /[A-Za-z0-9+/_=-]{40,}/,
];
export const suspectSummary = text => SUSPECT_SUMMARY.some(pattern => pattern.test(text));
// 의심되거나 비면 undefined. 호출자는 고정 문구로 대체한다. 길이를 자르는 것만으로 비밀이 지워지지 않으므로 자르기 전 조금 넓은 창을 본다.
// 자른 경계에 걸려 짧아진 토큰 조각이 패턴을 빠져나가지 못하게 하기 위해서다.
export function sanitizeSummary(text) {
  if (typeof text !== 'string') return undefined;
  const clean = text.toWellFormed().normalize('NFC').replace(/[\p{Cc}\p{Cf}]+/gu, ' ').replace(/\s+/g, ' ').trim();
  if (!clean) return undefined;
  const points = [...clean];
  if (suspectSummary(points.slice(0, SUMMARY_CODE_POINTS + 200).join(''))) return undefined;
  let kept = points.slice(0, SUMMARY_CODE_POINTS);
  while (Buffer.byteLength(kept.join(''), 'utf8') > SUMMARY_BYTES) kept = kept.slice(0, -1);
  return kept.join('') || undefined;
}
export function eventBody({ connection, eventId, occurredAt, summary }) {
  const body = text => JSON.stringify({ version: 1, connection_id: connection.connection_id, event_id: eventId,
    external_task_id: connection.external_task_id, type: 'turn_complete', occurred_at: occurredAt, summary: text });
  const full = body(summary);
  // JSON escape로 늘어난 실제 바이트까지 본다. 넘치면 내용을 버리고 고정 문구로 보낸다.
  return Buffer.byteLength(full, 'utf8') <= BODY_BYTES ? full : body(FIXED_SUMMARY);
}

// 공식 문서의 필드에서 필요한 값만 꺼낸다. 호출자는 이 반환값만 쓰고 원본 객체를 들고 있지 않는다.
// undefined는 턴 완료가 아닌 다른 이벤트, null은 알아볼 수 없는 입력이다. CLI 필드가 바뀌면 null이 나와 실패로 드러난다.
// Claude Stop은 사용자 중단·API 오류 때 발생하지 않는다(API 오류는 StopFailure). 그래서 Stop만 턴 완료로 본다.
export function parseClaudeStop(text) {
  let input;
  try { input = JSON.parse(text); } catch { return null; }
  if (input?.hook_event_name !== 'Stop') return input?.hook_event_name === undefined ? null : undefined;
  if (typeof input.session_id !== 'string') return null;
  return { sessionId: input.session_id, turnId: undefined, message: typeof input.last_assistant_message === 'string' ? input.last_assistant_message : undefined };
}
export function parseCodexNotify(text) {
  let input;
  try { input = JSON.parse(text); } catch { return null; }
  if (input?.type !== 'agent-turn-complete') return input?.type === undefined ? null : undefined;
  if (typeof input['thread-id'] !== 'string') return null;
  return { sessionId: input['thread-id'], turnId: typeof input['turn-id'] === 'string' ? input['turn-id'] : undefined,
    message: typeof input['last-assistant-message'] === 'string' ? input['last-assistant-message'] : undefined };
}

const isGone = error => error?.code === 'ENOENT';
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

// 파일 하나에 이벤트 하나를 둔다. 훅이 동시에 여러 개 떠도 쓰기가 서로 섞이지 않고, rename이라 반쯤 쓴 파일이 보이지 않는다.
export class Queue {
  constructor(dir, { now = Date.now, limits = QUEUE_LIMITS } = {}) {
    this.dir = dir;
    this.now = now;
    this.limits = limits;
    this.events = join(dir, 'events');
    this.failures = join(dir, 'failures.jsonl');
    this.lockPath = join(dir, 'queue.lock');
    this.statePath = join(dir, 'sender-state.json');
  }
  async ready() {
    await mkdir(this.events, { recursive: true, mode: 0o700 });
    await chmod(this.dir, 0o700);
    await chmod(this.events, 0o700);
  }
  // 조용히 버리지 않는다. 사유와 ID만 남겨 `sender.mjs status`가 보여 준다.
  async fail(reason, eventId) {
    if (!FAILURE_REASON.test(reason)) reason = 'unknown';
    await mkdir(this.dir, { recursive: true, mode: 0o700 });
    await appendFile(this.failures, `${JSON.stringify({ at: this.now(), reason, ...(eventId && EVENT_ID.test(eventId) ? { event_id: eventId } : {}) })}\n`, { mode: 0o600 });
  }
  async withLock(fn) {
    await this.ready();
    const deadline = Date.now() + LOCK_WAIT_MS;
    for (;;) {
      try { await mkdir(this.lockPath); break; } catch (error) {
        if (error?.code !== 'EEXIST') throw error;
        // 잠금을 쥔 채 죽은 훅이 큐를 영원히 막지 않게 한다. 잠금 안의 작업은 파일 몇 개라 10초면 충분히 길다.
        const held = await stat(this.lockPath).catch(() => undefined);
        if (held && Date.now() - held.mtimeMs > LOCK_STALE_MS) { await rmdir(this.lockPath).catch(() => {}); continue; }
        if (Date.now() > deadline) throw new Error('lock_unavailable');
        await sleep(20);
      }
    }
    try { return await fn(); } finally { await rmdir(this.lockPath).catch(() => {}); }
  }
  async entries() {
    const names = (await readdir(this.events)).filter(name => /^[A-Za-z0-9_-]{16,64}\.json$/.test(name));
    const rows = [];
    for (const name of names) {
      const path = join(this.events, name);
      try {
        const text = await readFile(path, 'utf8');
        rows.push({ ...JSON.parse(text), path, size: Buffer.byteLength(text, 'utf8') });
      } catch (error) {
        if (isGone(error)) continue;
        await rm(path, { force: true });
        await this.fail('corrupt_entry');
      }
    }
    return rows.sort((a, b) => a.occurred_at - b.occurred_at || a.event_id.localeCompare(b.event_id));
  }
  async write(path, value) {
    const temporary = `${path}.${randomBytes(4).toString('hex')}.tmp`;
    const handle = await open(temporary, 'wx', 0o600);
    try {
      await handle.writeFile(JSON.stringify(value));
      await handle.sync();
    } finally { await handle.close(); }
    await rename(temporary, path);
  }
  async sweepLocked() {
    const kept = [];
    for (const row of await this.entries()) {
      if (row.occurred_at + this.limits.ttlMs <= this.now()) {
        await rm(row.path, { force: true });
        await this.fail('expired', row.event_id);
      } else kept.push(row);
    }
    const log = await stat(this.failures).catch(() => undefined);
    if (log && log.size > FAILURE_LOG_BYTES) {
      const lines = (await readFile(this.failures, 'utf8')).split('\n').filter(Boolean).slice(-1000);
      await truncate(this.failures, 0);
      await appendFile(this.failures, `${lines.join('\n')}\n`);
    }
    return kept;
  }
  async enqueue({ connection_id, event_id, occurred_at, body }) {
    try {
      return await this.withLock(async () => {
        const rows = await this.sweepLocked();
        if (rows.some(row => row.event_id === event_id)) return 'queued';
        const value = { connection_id, event_id, occurred_at, body, enqueued_at: this.now(), attempts: 0, next_at: this.now() };
        const size = Buffer.byteLength(JSON.stringify(value), 'utf8');
        const total = rows.reduce((sum, row) => sum + row.size, 0);
        if (rows.length >= this.limits.events || total + size > this.limits.bytes) {
          await this.fail('queue_full', event_id);
          return 'queue_full';
        }
        await this.write(join(this.events, `${event_id}.json`), value);
        return 'queued';
      });
    } catch (error) {
      await this.fail(error?.message === 'lock_unavailable' ? 'lock_unavailable' : 'queue_write_failed', event_id).catch(() => {});
      return 'failed';
    }
  }
  async due() {
    return this.withLock(async () => {
      const rows = await this.sweepLocked();
      const state = await this.state();
      if (state.not_before > this.now()) return [];
      return rows.filter(row => row.next_at <= this.now());
    });
  }
  async state() {
    try { return { not_before: 0, ...JSON.parse(await readFile(this.statePath, 'utf8')) }; } catch { return { not_before: 0 }; }
  }
  // 서버가 전체 역압을 보낸 동안 다른 이벤트로도 두드리지 않는다.
  async pause(until) {
    await this.withLock(() => this.write(this.statePath, { not_before: until }));
  }
  async remove(row) { await rm(row.path, { force: true }); }
  async retry(row, nextAt) {
    await this.withLock(async () => {
      const exists = await stat(row.path).catch(() => undefined);
      if (!exists) return;
      const { path: _path, size: _size, ...value } = row;
      await this.write(row.path, { ...value, attempts: row.attempts + 1, next_at: nextAt });
    });
  }
  async status() {
    await this.ready();
    const rows = await this.entries();
    const counts = {};
    let last = null;
    const log = await readFile(this.failures, 'utf8').catch(() => '');
    for (const line of log.split('\n').filter(Boolean)) {
      try {
        const entry = JSON.parse(line);
        counts[entry.reason] = (counts[entry.reason] ?? 0) + 1;
        last = entry.at;
      } catch { counts.unreadable = (counts.unreadable ?? 0) + 1; }
    }
    return { queued: rows.length, bytes: rows.reduce((sum, row) => sum + row.size, 0),
      oldest_age_seconds: rows.length ? Math.floor((this.now() - rows[0].occurred_at) / 1000) : null, failures: counts, last_failure_at: last };
  }
}

// 훅 진입점 공통. 등록한 세션만 큐에 넣는다. 등록 안 된 세션은 아무것도 남기지 않고 끝난다.
export async function enqueueTurn(turn, { executor, config, queue, now = Date.now }) {
  const results = [];
  const occurredAt = now();
  for (const connection of config.connections) {
    if (connection.executor !== executor || connection.external_task_id !== turn.sessionId) continue;
    const summary = (connection.summary_consent === true ? sanitizeSummary(turn.message) : undefined) ?? FIXED_SUMMARY;
    // Codex turn-id가 있으면 같은 턴의 중복 호출이 같은 event_id가 된다. Claude Stop 입력에는 턴 ID가 없다.
    const eventId = turn.turnId
      ? createHash('sha256').update(`${connection.connection_id}:${turn.turnId}`).digest('base64url').slice(0, 32)
      : randomBytes(16).toString('base64url');
    results.push(await queue.enqueue({ connection_id: connection.connection_id, event_id: eventId, occurred_at: occurredAt,
      body: eventBody({ connection, eventId, occurredAt, summary }) }));
  }
  return results;
}
// 훅은 사용자의 세션을 절대 방해하지 않는다. 입력이 이상해도 고정 사유만 남기고 정상 종료한다.
export async function runHook({ executor, input, parse, env = process.env, now = Date.now }) {
  const paths = helperPaths(env);
  const queue = new Queue(paths.state, { now });
  try {
    if (input === undefined) { await queue.fail('input_unreadable'); return []; }
    const turn = parse(input);
    if (turn === null) { await queue.fail('input_invalid'); return []; }
    if (!turn) return [];
    let config;
    try { config = await loadConfig(paths.config); } catch { await queue.fail('config_invalid'); return []; }
    return await enqueueTurn(turn, { executor, config, queue, now });
  } catch { await queue.fail('hook_failed').catch(() => {}); return []; }
}
export async function readLimited(stream, limit = INPUT_LIMIT_BYTES, timeoutMs = 2000) {
  return new Promise(resolve => {
    const chunks = [];
    let size = 0;
    const finish = value => { clearTimeout(timer); stream.removeAllListeners('data'); stream.removeAllListeners('end'); stream.pause?.(); resolve(value); };
    const timer = setTimeout(() => finish(undefined), timeoutMs);
    stream.on('data', chunk => {
      size += chunk.length;
      if (size > limit) { finish(undefined); return; }
      chunks.push(chunk);
    });
    stream.on('end', () => finish(Buffer.concat(chunks).toString('utf8')));
    stream.on('error', () => finish(undefined));
  });
}

const runCommand = (file, args) => new Promise((resolve, reject) => {
  execFile(file, args, { timeout: 2000, maxBuffer: 4096, windowsHide: true }, (error, stdout) => {
    if (error) reject(new Error('key_unavailable')); else resolve(stdout);
  });
});
// 키 값이 아니라 참조만 받는다. argv에는 서비스·계정 이름만 간다. 오류 문구에 값을 싣지 않는다.
export async function readSecretRef(ref, run = runCommand) {
  const match = KEY_REF.exec(ref);
  if (!match) throw new Error('key_unavailable');
  const [, kind, service, account] = match;
  const output = kind === 'keychain'
    ? await run('security', ['find-generic-password', '-s', service, '-a', account, '-w'])
    : await run('secret-tool', ['lookup', 'service', service, 'account', account]);
  const seed = String(output).trim();
  if (!SEED.test(seed)) throw new Error('key_unavailable');
  return seed;
}
const PKCS8_ED25519 = Buffer.from('302e020100300506032b657004220420', 'hex');
export function signatureInput({ environment, connectionId, keyId, sentAt, body }) {
  const bodySha256 = createHash('sha256').update(body).digest('hex');
  return Buffer.from(['R08-v1', environment, 'POST', EVENT_PATH, connectionId, keyId, sentAt, bodySha256].join('\n'), 'utf8');
}
export function signedHeaders({ seed, environment, connectionId, keyId, sentAt, body }) {
  const key = createPrivateKey({ key: Buffer.concat([PKCS8_ED25519, Buffer.from(seed, 'base64url')]), format: 'der', type: 'pkcs8' });
  return { 'content-type': 'application/json', 'x-r08-connection-id': connectionId, 'x-r08-key-id': keyId, 'x-r08-sent-at': sentAt,
    'x-r08-signature': sign(null, signatureInput({ environment, connectionId, keyId, sentAt, body }), key).toString('base64url') };
}
export function postEvent(endpoint, headers, body, limits = SEND_LIMITS) {
  return new Promise((resolve, reject) => {
    const url = new URL(endpoint);
    const secure = url.protocol === 'https:';
    const payload = Buffer.from(body, 'utf8');
    const request = (secure ? httpsRequest : httpRequest)(url, { method: 'POST', agent: false,
      headers: { ...headers, 'content-length': String(payload.length), connection: 'close' } });
    const connect = setTimeout(() => request.destroy(new Error('connect_timeout')), limits.connectMs);
    const total = setTimeout(() => request.destroy(new Error('total_timeout')), limits.totalMs);
    const done = () => { clearTimeout(connect); clearTimeout(total); };
    request.once('socket', socket => {
      if (!socket.connecting) { clearTimeout(connect); return; }
      socket.once(secure ? 'secureConnect' : 'connect', () => clearTimeout(connect));
    });
    request.once('response', response => {
      const chunks = [];
      let size = 0;
      response.on('data', chunk => { size += chunk.length; if (size <= 512) chunks.push(chunk); });
      response.once('error', error => { done(); reject(error); });
      response.once('end', () => {
        done();
        let code;
        try { code = JSON.parse(Buffer.concat(chunks).toString('utf8')).error; } catch { code = undefined; }
        const retryAfter = Number(response.headers['retry-after']);
        resolve({ status: response.statusCode ?? 0, code: typeof code === 'string' ? code : undefined,
          retryAfterMs: Number.isFinite(retryAfter) && retryAfter > 0 ? Math.min(retryAfter * 1000, limits.retryAfterMaxMs) : 0 });
      });
    });
    request.once('error', error => { done(); reject(error); });
    request.end(payload);
  });
}
export function backoffMs(attempts, random = Math.random, limits = SEND_LIMITS) {
  const cap = Math.min(limits.backoffMaxMs, limits.backoffBaseMs * 2 ** Math.min(attempts, 20));
  return Math.round(cap / 2 + random() * cap / 2);
}
// 재시도해도 소용없는 거절은 실패로 표시하고 큐에서 뺀다. clock_skew는 시계가 돌아오면 새 sent_at으로 다시 서명해 통과한다.
const retryable = response => response.status === 408 || response.status === 429 || response.status >= 500
  || (response.status === 422 && response.code === 'clock_skew');
const reasonCode = code => (typeof code === 'string' && FAILURE_REASON.test(code) ? code : 'other');
// 한 번 돈다. 전송 실패가 나면 같은 서버로 다음 이벤트를 곧바로 두드리지 않고 이번 패스를 끝낸다.
export async function sendDue({ config, queue, now = Date.now, post = postEvent, readSecret = readSecretRef, random = Math.random, log = () => {} }) {
  const result = { sent: 0, retried: 0, failed: 0 };
  const rows = await queue.due();
  const byId = new Map(config.connections.map(connection => [connection.connection_id, connection]));
  const seeds = new Map();
  for (const row of rows) {
    const connection = byId.get(row.connection_id);
    if (!connection) {
      await queue.remove(row);
      await queue.fail('connection_removed', row.event_id);
      result.failed++;
      continue;
    }
    let seed = seeds.get(connection.connection_id);
    if (!seed) {
      try { seed = await readSecret(connection.key_ref); } catch {
        // 키를 잠시 못 읽는 것(잠긴 Keychain 등)은 이벤트 문제가 아니다. 기한까지 큐에 두고 표시만 한다.
        await queue.fail('key_unavailable', row.event_id);
        await queue.retry(row, now() + backoffMs(row.attempts, random));
        log('key_unavailable');
        result.retried++;
        continue;
      }
      seeds.set(connection.connection_id, seed);
    }
    const sentAt = String(now());
    let response;
    try {
      const headers = signedHeaders({ seed, environment: config.environment, connectionId: row.connection_id, keyId: connection.key_id, sentAt, body: row.body });
      response = await post(config.endpoint, headers, row.body);
    } catch {
      await queue.retry(row, now() + backoffMs(row.attempts, random));
      log('send_failed');
      result.retried++;
      return result;
    }
    if (response.status >= 200 && response.status < 300) {
      await queue.remove(row);
      result.sent++;
    } else if (retryable(response)) {
      const delay = Math.max(backoffMs(row.attempts, random), response.retryAfterMs);
      await queue.retry(row, now() + delay);
      if (response.status === 429 || response.status === 503) await queue.pause(now() + response.retryAfterMs);
      log(`retry_${response.status}`);
      result.retried++;
      return result;
    } else {
      await queue.remove(row);
      await queue.fail(`rejected_${response.status}_${reasonCode(response.code)}`, row.event_id);
      log(`rejected_${response.status}`);
      result.failed++;
    }
  }
  return result;
}
