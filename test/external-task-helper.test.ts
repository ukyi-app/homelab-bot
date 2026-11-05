import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { chmod, mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { externalTaskServer, EXTERNAL_TASK_PATH, signatureInput as serverSignatureInput, sha256Hex, suspectSummary as serverSuspect } from '../src/external-task-receiver.js';
import { ENVIRONMENT, SESSION, listen, receiverFixture, shut } from './external-task-fixture.js';
import type { AddressInfo } from 'node:net';

type Helper = typeof import('../tools/r08-helper/lib.mjs');
const helperUrl = (file: string) => new URL(`../../tools/r08-helper/${file}`, import.meta.url);
const helper = await import(helperUrl('lib.mjs').href) as Helper;
const { FIXED_SUMMARY, QUEUE_LIMITS, SEND_LIMITS, Queue, backoffMs, enqueueTurn, eventBody, loadConfig, parseClaudeStop, parseCodexNotify, parseConfig, postEvent, readSecretRef, runHook, sanitizeSummary, sendDue, signatureInput, signedHeaders, suspectSummary } = helper;

const NOW = 1_800_000_000_000;
const CONNECTION = '11111111-1111-4111-8111-111111111111';
const connection = (overrides: Partial<import('../tools/r08-helper/lib.mjs').HelperConnection> = {}): import('../tools/r08-helper/lib.mjs').HelperConnection => ({
  connection_id: CONNECTION, key_id: 'A'.repeat(16), external_task_id: SESSION, executor: 'claude', key_ref: 'keychain:r08-helper:fixture', ...overrides,
});
const config = (overrides: Partial<import('../tools/r08-helper/lib.mjs').HelperConfig> = {}): import('../tools/r08-helper/lib.mjs').HelperConfig => ({
  version: 1, endpoint: 'https://fixture.invalid/external-task-events', environment: ENVIRONMENT, connections: [connection()], ...overrides,
});
// [합성] 공식 문서의 필드로 만든 입력이다. 실제 Claude·Codex 실행에서 얻은 것이 아니다.
const MARKERS = { cwd: '/Users/fixture-marker/project', transcript: '/Users/fixture-marker/.claude/t.jsonl', message: 'SECRET-ANSWER-MARKER 전문입니다', input: 'SECRET-INPUT-MARKER' };
const claudeStop = (overrides: Record<string, unknown> = {}) => JSON.stringify({ session_id: SESSION, transcript_path: MARKERS.transcript, cwd: MARKERS.cwd, permission_mode: 'default',
  hook_event_name: 'Stop', stop_hook_active: false, last_assistant_message: MARKERS.message, background_tasks: [{ id: 'task-001', command: 'SECRET-COMMAND-MARKER' }], ...overrides });
const codexNotify = (overrides: Record<string, unknown> = {}) => JSON.stringify({ type: 'agent-turn-complete', 'thread-id': SESSION, 'turn-id': 'turn-1', cwd: MARKERS.cwd,
  'input-messages': [MARKERS.input], 'last-assistant-message': MARKERS.message, ...overrides });
async function temp() {
  const dir = await mkdtemp(join(tmpdir(), 'r08-helper-test-'));
  return { dir, state: join(dir, 'state'), config: join(dir, 'config.json'), close: () => rm(dir, { recursive: true, force: true }) };
}
const everything = async (dir: string): Promise<string> => {
  let text = '';
  for (const name of await readdir(dir, { recursive: true })) {
    const path = join(dir, name);
    if ((await stat(path)).isFile()) text += await readFile(path, 'utf8');
  }
  return text;
};

test('R08 helper: 서명 입력과 정제 표가 서버와 같다', async () => {
  const body = '{"version":1}';
  assert.deepEqual(signatureInput({ environment: 'env', connectionId: CONNECTION, keyId: 'k', sentAt: '1', body }),
    serverSignatureInput({ environment: 'env', method: 'POST', path: EXTERNAL_TASK_PATH, connectionId: CONNECTION, keyId: 'k', sentAt: '1', bodySha256: sha256Hex(Buffer.from(body)) }));
  const table = (text: string) => /const SUSPECT_SUMMARY = \[([\s\S]*?)\n\];/.exec(text)?.[1];
  const [server, local] = await Promise.all([readFile('src/external-task-receiver.ts', 'utf8'), readFile(helperUrl('lib.mjs'), 'utf8')]);
  assert.ok(table(server));
  assert.equal(table(server), table(local));
  for (const text of ['정상 요약', '/home/x/y', 'C:\\Users\\x', 'sk-abcdefghijklmn', 'x'.repeat(40), 'https://user:pw@example.invalid/']) assert.equal(suspectSummary(text), serverSuspect(text), text);
});

test('R08 helper: 공식 문서 필드에서 ID와 메시지만 고르고 다른 이벤트·알아볼 수 없는 입력을 구별한다 [합성]', () => {
  assert.deepEqual(parseClaudeStop(claudeStop()), { sessionId: SESSION, turnId: undefined, message: MARKERS.message });
  assert.equal(parseClaudeStop(claudeStop({ hook_event_name: 'SubagentStop' })), undefined);
  assert.equal(parseClaudeStop(claudeStop({ hook_event_name: 'StopFailure' })), undefined);
  assert.equal(parseClaudeStop(claudeStop({ session_id: undefined })), null);
  assert.equal(parseClaudeStop('{not json'), null);
  assert.equal(parseClaudeStop('{}'), null);
  assert.deepEqual(parseCodexNotify(codexNotify()), { sessionId: SESSION, turnId: 'turn-1', message: MARKERS.message });
  assert.equal(parseCodexNotify(codexNotify({ type: 'other' })), undefined);
  assert.equal(parseCodexNotify(codexNotify({ 'thread-id': 1 })), null);
  assert.equal(parseCodexNotify('nope'), null);
});

test('R08 helper: 기본 요약은 고정 문구이고, 원본 입력은 큐·실패 표시에 남지 않으며, 등록 안 된 세션은 큐에 들어가지 않는다', async () => {
  const t = await temp();
  try {
    const queue = new Queue(t.state, { now: () => NOW });
    const turn = parseClaudeStop(claudeStop())!;
    assert.deepEqual(await enqueueTurn(turn, { executor: 'claude', config: config(), queue, now: () => NOW }), ['queued']);
    const rows = await queue.entries();
    assert.equal(rows.length, 1);
    assert.deepEqual(JSON.parse(rows[0]!.body), { version: 1, connection_id: CONNECTION, event_id: rows[0]!.event_id, external_task_id: SESSION, type: 'turn_complete', occurred_at: NOW, summary: FIXED_SUMMARY });
    assert.deepEqual(await enqueueTurn({ ...turn, sessionId: 'other-session' }, { executor: 'claude', config: config(), queue, now: () => NOW }), []);
    assert.deepEqual(await enqueueTurn(turn, { executor: 'codex', config: config(), queue, now: () => NOW }), []);
    assert.equal((await queue.entries()).length, 1);
    const dump = await everything(t.state);
    for (const marker of Object.values(MARKERS)) assert.equal(dump.includes(marker), false, marker);
    assert.equal(dump.includes('SECRET-COMMAND-MARKER'), false);
    // 큐 파일은 본인만 읽는다.
    assert.equal((await stat(t.state)).mode & 0o077, 0);
    assert.equal((await stat(rows[0]!.path)).mode & 0o077, 0);
  } finally { await t.close(); }
});

test('R08 helper: 요약 동의는 정제하고, 의심되면 고정 문구로, 재전송에 쓸 본문은 4 KiB를 넘지 않는다', () => {
  assert.equal(sanitizeSummary('줄\n바꿈\t정리\u200b됨'), '줄 바꿈 정리 됨');
  assert.equal([...sanitizeSummary('가'.repeat(600))!].length, 500);
  assert.ok(Buffer.byteLength(sanitizeSummary('😀'.repeat(600))!) <= 2000);
  assert.equal(sanitizeSummary(undefined), undefined);
  assert.equal(sanitizeSummary('   '), undefined);
  for (const text of [MARKERS.cwd, '~/.ssh/config 확인', 'C:\\Users\\x 확인', '토큰은 ghp_abcdefghijklmnop 입니다', 'api_key=abc', 'x'.repeat(50), `${'가'.repeat(495)} sk-abcdefghijklmnopqrstu`]) {
    assert.equal(sanitizeSummary(text), undefined, text);
  }
  const connectionValue = connection({ summary_consent: true });
  const escaped = '"'.repeat(1990);
  const fixedFallback = JSON.parse(eventBody({ connection: connectionValue, eventId: 'e'.repeat(16), occurredAt: NOW, summary: escaped + escaped + escaped })) as { summary: string };
  assert.equal(fixedFallback.summary, FIXED_SUMMARY);
  const big = eventBody({ connection: connectionValue, eventId: 'e'.repeat(16), occurredAt: NOW, summary: '"'.repeat(500) });
  assert.ok(Buffer.byteLength(big) <= 4096);
  assert.equal((JSON.parse(big) as { summary: string }).summary.length, 500);
});

test('R08 helper: 동의한 연결의 큐에는 정제한 요약만 들어간다 [합성]', async () => {
  const t = await temp();
  try {
    const queue = new Queue(t.state, { now: () => NOW });
    const cfg = config({ connections: [connection({ summary_consent: true })] });
    await enqueueTurn({ sessionId: SESSION, turnId: undefined, message: '빌드가 끝났습니다.\n다음은 배포입니다.' }, { executor: 'claude', config: cfg, queue, now: () => NOW });
    await enqueueTurn({ sessionId: SESSION, turnId: undefined, message: `자세한 내용은 ${MARKERS.cwd} 를 보세요` }, { executor: 'claude', config: cfg, queue, now: () => NOW });
    const summaries = (await queue.entries()).map(row => (JSON.parse(row.body) as { summary: string }).summary).sort();
    assert.deepEqual(summaries, [FIXED_SUMMARY, '빌드가 끝났습니다. 다음은 배포입니다.'].sort());
    assert.equal((await everything(t.state)).includes(MARKERS.cwd), false);
  } finally { await t.close(); }
});

test('R08 helper: Codex turn-id가 같으면 같은 event_id라 큐에 한 번만 든다', async () => {
  const t = await temp();
  try {
    const queue = new Queue(t.state, { now: () => NOW });
    const cfg = config({ connections: [connection({ executor: 'codex' })] });
    const turn = parseCodexNotify(codexNotify())!;
    await enqueueTurn(turn, { executor: 'codex', config: cfg, queue, now: () => NOW });
    await enqueueTurn(turn, { executor: 'codex', config: cfg, queue, now: () => NOW + 1 });
    assert.equal((await queue.entries()).length, 1);
    await enqueueTurn({ ...turn, turnId: 'turn-2' }, { executor: 'codex', config: cfg, queue, now: () => NOW });
    assert.equal((await queue.entries()).length, 2);
  } finally { await t.close(); }
});

test('R08 helper 큐: 100건·1 MiB·24시간 한도를 넘으면 조용히 버리지 않고 실패로 표시한다', async () => {
  assert.deepEqual(QUEUE_LIMITS, { events: 100, bytes: 1024 * 1024, ttlMs: 24 * 3_600_000 });
  const t = await temp();
  try {
    let now = NOW;
    const queue = new Queue(t.state, { now: () => now });
    const entry = (i: number, body = '{}') => ({ connection_id: CONNECTION, event_id: `event-${String(i).padStart(12, '0')}`, occurred_at: now, body });
    for (let i = 0; i < 100; i++) assert.equal(await queue.enqueue(entry(i)), 'queued');
    assert.equal(await queue.enqueue(entry(100)), 'queue_full');
    let status = await queue.status();
    assert.equal(status.queued, 100);
    assert.equal(status.failures.queue_full, 1);
    assert.ok((await readFile(queue.failures, 'utf8')).includes('event-000000000100'));
    // 24시간이 지나면 만료로 표시하고 빠진다. 경계 직전까지는 남는다.
    now = NOW + 24 * 3_600_000 - 1;
    assert.equal((await queue.due()).length, 100);
    now = NOW + 24 * 3_600_000;
    assert.equal((await queue.due()).length, 0);
    status = await queue.status();
    assert.equal(status.queued, 0);
    assert.equal(status.failures.expired, 100);
    assert.equal((await readdir(queue.events)).length, 0);
  } finally { await t.close(); }
  const bytes = await temp();
  try {
    const queue = new Queue(bytes.state, { now: () => NOW });
    const body = 'x'.repeat(300 * 1024);
    for (let i = 0; i < 3; i++) assert.equal(await queue.enqueue({ connection_id: CONNECTION, event_id: `event-${String(i).padStart(12, '0')}`, occurred_at: NOW, body }), 'queued');
    assert.equal(await queue.enqueue({ connection_id: CONNECTION, event_id: 'event-000000000003', occurred_at: NOW, body }), 'queue_full');
    assert.equal((await queue.status()).failures.queue_full, 1);
    assert.ok((await queue.status()).bytes <= 1024 * 1024);
  } finally { await bytes.close(); }
});

test('R08 helper 큐: 훅이 동시에 여러 개 떠도 한도를 넘지 않고, 망가진 항목은 실패로 표시하며, 죽은 잠금에 막히지 않는다', async () => {
  const t = await temp();
  try {
    const queue = new Queue(t.state, { now: () => NOW, limits: { events: 10, bytes: 1024 * 1024, ttlMs: QUEUE_LIMITS.ttlMs } });
    const results = await Promise.all(Array.from({ length: 30 }, (_, i) => queue.enqueue({ connection_id: CONNECTION, event_id: `event-${String(i).padStart(12, '0')}`, occurred_at: NOW, body: '{}' })));
    assert.equal(results.filter(result => result === 'queued').length, 10);
    assert.equal(results.filter(result => result === 'queue_full').length + results.filter(result => result === 'failed').length, 20);
    assert.equal((await queue.entries()).length, 10);
    await writeFile(join(queue.events, 'broken-entry-000000.json'), '{oops');
    await queue.due();
    assert.equal((await queue.status()).failures.corrupt_entry, 1);
    assert.equal((await readdir(queue.events)).includes('broken-entry-000000.json'), false);
    await mkdir(join(t.state, 'queue.lock'));
    const { utimes } = await import('node:fs/promises');
    await utimes(join(t.state, 'queue.lock'), new Date(Date.now() - 60_000), new Date(Date.now() - 60_000));
    assert.equal((await queue.due()).length, 10);
  } finally { await t.close(); }
});

test('R08 helper 설정: seed 같은 모르는 키·공개 평문 주소·다른 경로·넓은 권한을 거절한다', async () => {
  parseConfig(JSON.stringify(config()));
  const reject = (value: unknown) => assert.throws(() => parseConfig(JSON.stringify(value)), /config_invalid/);
  reject({ ...config(), seed: 'x' });
  reject({ ...config(), connections: [{ ...connection(), seed: 'x' }] });
  reject({ ...config(), connections: [{ ...connection(), key_ref: 'A'.repeat(43) }] });
  reject({ ...config(), connections: [{ ...connection(), key_ref: 'file:/tmp/key' }] });
  reject({ ...config(), connections: [{ ...connection(), external_task_id: '/home/x' }] });
  reject({ ...config(), endpoint: 'http://fixture.invalid/external-task-events' });
  reject({ ...config(), endpoint: 'https://fixture.invalid/external-task-events/' });
  reject({ ...config(), endpoint: 'https://fixture.invalid/external-task-events?x=1' });
  reject({ ...config(), endpoint: 'https://user:pw@fixture.invalid/external-task-events' });
  reject({ ...config(), environment: 'Bad Env' });
  assert.throws(() => parseConfig('{'), /config_invalid/);
  parseConfig(JSON.stringify(config({ endpoint: 'http://127.0.0.1:1/external-task-events' })));
  const t = await temp();
  try {
    await writeFile(t.config, JSON.stringify(config()), { mode: 0o600 });
    assert.equal((await loadConfig(t.config)).environment, ENVIRONMENT);
    await chmod(t.config, 0o666);
    await assert.rejects(loadConfig(t.config), /config_invalid/);
    await assert.rejects(loadConfig(join(t.dir, 'missing.json')), /config_invalid/);
  } finally { await t.close(); }
});

test('R08 helper 키: 참조만 받고 argv에는 서비스·계정 이름만 가며 실패 문구에 값이 없다', async () => {
  const seed = 'S'.repeat(43);
  const calls: [string, string[]][] = [];
  const run = async (file: string, args: string[]) => { calls.push([file, args]); return `${seed}\n`; };
  assert.equal(await readSecretRef('keychain:r08-helper:acct', run), seed);
  assert.equal(await readSecretRef('libsecret:r08-helper:acct', run), seed);
  assert.deepEqual(calls, [['security', ['find-generic-password', '-s', 'r08-helper', '-a', 'acct', '-w']], ['secret-tool', ['lookup', 'service', 'r08-helper', 'account', 'acct']]]);
  assert.equal(JSON.stringify(calls).includes(seed), false);
  await assert.rejects(readSecretRef(seed, run), /key_unavailable/);
  await assert.rejects(readSecretRef('env:SEED', run), /key_unavailable/);
  await assert.rejects(readSecretRef('keychain:a:b', async () => 'not-a-seed'), error => {
    assert.equal((error as Error).message, 'key_unavailable');
    return true;
  });
});

test('R08 helper 재전송: backoff+지터·Retry-After, 거절은 실패 표시, 재시도는 본문을 그대로 두고 새 sent_at으로 다시 서명한다', async () => {
  assert.equal(backoffMs(0, () => 0), 2500);
  assert.equal(backoffMs(0, () => 1), 5000);
  assert.equal(backoffMs(3, () => 1), 40_000);
  assert.equal(backoffMs(50, () => 1), SEND_LIMITS.backoffMaxMs);
  assert.deepEqual([SEND_LIMITS.connectMs, SEND_LIMITS.totalMs], [2000, 5000]);
  const t = await temp();
  try {
    let now = NOW;
    const queue = new Queue(t.state, { now: () => now });
    const clock = () => now;
    const cfg = config();
    const seed = 'S'.repeat(43);
    const add = (i: number) => queue.enqueue({ connection_id: CONNECTION, event_id: `event-${String(i).padStart(12, '0')}`, occurred_at: now + i, body: eventBody({ connection: cfg.connections[0]!, eventId: `event-${String(i).padStart(12, '0')}`, occurredAt: now, summary: FIXED_SUMMARY }) });
    await add(0);
    await add(1);
    const sent: { sentAt: string; body: string }[] = [];
    let responses: { status: number; code?: string; retryAfterMs: number }[] = [{ status: 429, code: 'rate_limited_connection', retryAfterMs: 60_000 }];
    const post = async (_url: string, headers: Record<string, string>, body: string) => {
      sent.push({ sentAt: headers['x-r08-sent-at']!, body });
      return responses.shift() ?? { status: 202, retryAfterMs: 0 };
    };
    const send = () => sendDue({ config: cfg, queue, now: clock, post, readSecret: async () => seed, random: () => 0 });
    // 429는 Retry-After까지 기다리고 그 동안 다른 이벤트로도 두드리지 않는다.
    assert.deepEqual(await send(), { sent: 0, retried: 1, failed: 0 });
    assert.equal(sent.length, 1);
    assert.equal((await queue.state()).not_before, NOW + 60_000);
    assert.equal((await queue.entries())[0]!.next_at, NOW + 60_000);
    now += 59_999;
    assert.deepEqual(await send(), { sent: 0, retried: 0, failed: 0 });
    now += 1;
    responses = [{ status: 503, retryAfterMs: 0 }];
    assert.deepEqual(await send(), { sent: 0, retried: 1, failed: 0 });
    assert.equal(sent[1]!.body, sent[0]!.body);
    assert.notEqual(sent[1]!.sentAt, sent[0]!.sentAt);
    // 503 뒤 backoff는 시도 수에 맞게 늘어 있다.
    const retried = (await queue.entries())[0]!;
    assert.equal(retried.attempts, 2);
    assert.equal(retried.next_at, now + 5000);
    // 전송 실패도 다시 시도한다.
    now += 5000;
    const failing = async () => { throw new Error('connect_timeout'); };
    assert.deepEqual(await sendDue({ config: cfg, queue, now: clock, post: failing, readSecret: async () => seed, random: () => 0 }), { sent: 0, retried: 1, failed: 0 });
    now += 60_000;
    // 시계 오차는 다시 보낸다. 다른 거절은 큐에서 빼고 실패로 표시한다.
    responses = [{ status: 422, code: 'clock_skew', retryAfterMs: 0 }];
    assert.deepEqual(await send(), { sent: 0, retried: 1, failed: 0 });
    now += 120_000;
    responses = [{ status: 401, code: 'unauthorized', retryAfterMs: 0 }];
    assert.deepEqual(await send(), { sent: 1, retried: 0, failed: 1 });
    const status = await queue.status();
    assert.equal(status.queued, 0);
    assert.equal(status.failures.rejected_401_unauthorized, 1);
    // 키를 못 읽는 것은 이벤트 실패가 아니다. 큐에 남기고 표시한다.
    await add(2);
    assert.deepEqual(await sendDue({ config: cfg, queue, now: clock, post, readSecret: async () => { throw new Error('key_unavailable'); }, random: () => 0 }), { sent: 0, retried: 1, failed: 0 });
    assert.equal((await queue.status()).queued, 1);
    assert.equal((await queue.status()).failures.key_unavailable, 1);
    // 설정에서 연결을 지우면 남은 이벤트는 실패로 표시한다.
    now += QUEUE_LIMITS.ttlMs - 1;
    assert.deepEqual(await sendDue({ config: config({ connections: [] }), queue, now: clock, post, readSecret: async () => seed }), { sent: 0, retried: 0, failed: 1 });
    assert.equal((await queue.status()).failures.connection_removed, 1);
    const dump = await everything(t.state);
    assert.equal(dump.includes(seed), false);
  } finally { await t.close(); }
});

test('R08 helper 전송: 연결 2초·전체 5초 제한을 지키고 리다이렉트를 따라가지 않는다', async () => {
  const { createServer } = await import('node:http');
  const silent = createServer(() => { /* 응답하지 않는다 */ });
  await listen(silent);
  const url = `http://127.0.0.1:${(silent.address() as AddressInfo).port}${EXTERNAL_TASK_PATH}`;
  try {
    const started = Date.now();
    await assert.rejects(postEvent(url, {}, '{}', { ...SEND_LIMITS, totalMs: 100 }), /total_timeout/);
    assert.ok(Date.now() - started < 2000);
  } finally { await shut(silent); }
  const stalled = createServer((_req, res) => { res.writeHead(202); res.write('{'); });
  await listen(stalled);
  try {
    await assert.rejects(postEvent(`http://127.0.0.1:${(stalled.address() as AddressInfo).port}${EXTERNAL_TASK_PATH}`, {}, '{}', { ...SEND_LIMITS, totalMs: 100 }));
  } finally { await shut(stalled); }
  const redirect = createServer((_req, res) => { res.writeHead(302, { location: 'http://127.0.0.1:1/' }).end(); });
  await listen(redirect);
  try {
    const response = await postEvent(`http://127.0.0.1:${(redirect.address() as AddressInfo).port}${EXTERNAL_TASK_PATH}`, {}, '{}');
    assert.equal(response.status, 302);
  } finally { await shut(redirect); }
});

const run = (script: string, args: string[], input: string | undefined, env: Record<string, string>) => new Promise<{ code: number | null; stdout: string; stderr: string; elapsed: number }>((resolve, reject) => {
  const started = Date.now();
  const child = spawn(process.execPath, [helperUrl(script).pathname, ...args], { env: { PATH: process.env.PATH ?? '', ...env } });
  let stdout = '', stderr = '';
  child.stdout.on('data', chunk => { stdout += chunk; });
  child.stderr.on('data', chunk => { stderr += chunk; });
  child.once('error', reject);
  child.once('close', code => resolve({ code, stdout, stderr, elapsed: Date.now() - started }));
  child.stdin.end(input);
});

test('R08 helper 훅 실행: 입력을 큐에 넣고 짧게 끝나며 stdout·stderr가 비고 항상 0이다 [합성]', async () => {
  const t = await temp();
  try {
    await writeFile(t.config, JSON.stringify(config({ connections: [connection(), connection({ connection_id: '22222222-2222-4222-8222-222222222222', executor: 'codex' })] })), { mode: 0o600 });
    const env = { R08_HELPER_CONFIG: t.config, R08_HELPER_STATE: t.state };
    const stop = await run('claude-stop.mjs', [], claudeStop(), env);
    assert.deepEqual([stop.code, stop.stdout, stop.stderr], [0, '', '']);
    assert.ok(stop.elapsed < 5000);
    const notify = await run('codex-notify.mjs', [codexNotify()], '', env);
    assert.deepEqual([notify.code, notify.stdout, notify.stderr], [0, '', '']);
    const status = JSON.parse((await run('sender.mjs', ['status'], '', env)).stdout) as { queued: number; failures: Record<string, number> };
    assert.equal(status.queued, 2);
    assert.deepEqual(status.failures, {});
    const dump = await everything(t.state);
    for (const marker of Object.values(MARKERS)) assert.equal(dump.includes(marker), false, marker);
    // 망가진 입력·설정도 세션을 방해하지 않고 표시만 남는다.
    assert.equal((await run('claude-stop.mjs', [], '{broken', env)).code, 0);
    assert.equal((await run('codex-notify.mjs', ['{broken'], '', env)).code, 0);
    await chmod(t.config, 0o666);
    assert.equal((await run('claude-stop.mjs', [], claudeStop(), env)).code, 0);
    const after = JSON.parse((await run('sender.mjs', ['status'], '', env)).stdout) as { failures: Record<string, number> };
    assert.deepEqual(after.failures, { input_invalid: 2, config_invalid: 1 });
    assert.equal((await run('sender.mjs', ['once'], '', env)).code, 1);
  } finally { await t.close(); }
});

test('R08 helper 입력: runHook은 읽지 못한 입력을 표시하고 throw하지 않는다', async () => {
  const t = await temp();
  try {
    assert.deepEqual(await runHook({ executor: 'claude', input: undefined, parse: parseClaudeStop, env: { R08_HELPER_CONFIG: t.config, R08_HELPER_STATE: t.state } }), []);
    assert.equal((await new Queue(t.state).status()).failures.input_unreadable, 1);
  } finally { await t.close(); }
});

test('R08 helper 끝까지: 훅 → 큐 → 전송기 서명 → 실제 수신 → outbox → 게시 (네트워크는 loopback) [합성]', async () => {
  const ctx = await receiverFixture({ globalBurst: 1000 });
  const server = externalTaskServer(ctx.receiver);
  await listen(server);
  const t = await temp();
  try {
    const who = await ctx.attach(SESSION, true);
    const cfg = config({ endpoint: `http://127.0.0.1:${(server.address() as AddressInfo).port}${EXTERNAL_TASK_PATH}`,
      connections: [connection({ connection_id: who.connectionId, key_id: who.keyId, summary_consent: true })] });
    await writeFile(t.config, JSON.stringify(cfg), { mode: 0o600 });
    const now = ctx.f.now;
    const env = { R08_HELPER_CONFIG: t.config, R08_HELPER_STATE: t.state };
    assert.deepEqual(await runHook({ executor: 'claude', input: claudeStop({ last_assistant_message: '빌드가 끝났습니다.' }), parse: parseClaudeStop, env, now }), ['queued']);
    const queue = new Queue(t.state, { now });
    assert.deepEqual(await sendDue({ config: cfg, queue, now, readSecret: async () => who.seed }), { sent: 1, retried: 0, failed: 0 });
    assert.equal((await queue.status()).queued, 0);
    assert.equal(await ctx.f.publisher.deliver(), true);
    const { content } = ctx.f.rest.messages[0]!.body;
    assert.ok(content.includes('사람 세션이 턴을 끝냈다고 알림'));
    assert.ok(content.includes('요약: `빌드가 끝났습니다.`'));
    // 보낸 뒤 ACK를 잃어 같은 본문을 다시 보내도 게시는 한 번이다.
    assert.deepEqual(await runHook({ executor: 'claude', input: claudeStop(), parse: parseClaudeStop, env, now }), ['queued']);
    const replay = (await queue.entries())[0]!;
    await sendDue({ config: cfg, queue, now, readSecret: async () => who.seed });
    const headers = signedHeaders({ seed: who.seed, environment: ENVIRONMENT, connectionId: who.connectionId, keyId: who.keyId, sentAt: String(now()), body: replay.body });
    assert.equal((await postEvent(cfg.endpoint, headers, replay.body)).status, 202);
    assert.equal(await ctx.count('outbox'), 2);
    // 폐기되면 전송기는 실패로 표시하고 큐에서 뺀다.
    await ctx.links.detach(who.connectionId, 'fixture-owner');
    assert.deepEqual(await runHook({ executor: 'claude', input: claudeStop(), parse: parseClaudeStop, env, now }), ['queued']);
    assert.deepEqual(await sendDue({ config: cfg, queue, now, readSecret: async () => who.seed }), { sent: 0, retried: 0, failed: 1 });
    assert.equal((await queue.status()).failures.rejected_401_unauthorized, 1);
  } finally { await t.close(); await shut(server); await ctx.close(); }
});
