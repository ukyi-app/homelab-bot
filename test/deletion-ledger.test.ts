import { after, afterEach, before, beforeEach, test } from 'node:test';
import assert from 'node:assert/strict';
import { access, chmod, mkdir, readFile, rename, rm, symlink, unlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { FileDeletionLedger, LEDGER_FILE, LedgerError, MARKER_FILE, parseLedgerMarker } from '../src/deletion-ledger.js';
import { MemoryNotReady, MemoryService } from '../src/memory.js';
import type { DocumentSource } from '../src/memory.js';
import { localDatabase, fixture, thread } from './helpers.js';
import { FIXED_MARKER, closeLedgers, faultyIo, freeLock, initLedger, ledgerAt, markerBytes, openLedger } from './ledger-fixture.js';
import type { Faults } from './ledger-fixture.js';

// T20 원장 계약 v1(파일·표식·권한·동일성·디스크 오류). 잠금 배타와 세대 묶음은 deletion-ledger-pg.test.ts가 실제 PostgreSQL로 본다.
let database: Awaited<ReturnType<typeof localDatabase>>;
let ledger: Awaited<ReturnType<typeof initLedger>>;
const dirs: string[] = [];
const documents: DocumentSource = { check: async () => 'verified' };
const entry = (memoryId: string, at = 1) => ({ memoryId, createdAt: at, deletedAt: at + 1 });
async function fresh(prefix: string, options: Parameters<typeof initLedger>[1] = {}) {
  const made = await initLedger(prefix, { generation: ledger.generation, ...options });
  dirs.push(made.dir);
  return made;
}
const rejectsWith = (promise: Promise<unknown>, reason: string, extra: Partial<LedgerError> = {}) =>
  assert.rejects(promise, (error: unknown) => {
    assert.ok(error instanceof LedgerError, String(error));
    assert.equal(error.message, `deletion_ledger_${reason}`);
    for (const [k, v] of Object.entries(extra)) assert.equal((error as unknown as Record<string, unknown>)[k], v, k);
    return true;
  });
const exists = (path: string) => access(path).then(() => true, () => false);

before(async () => { database = await localDatabase(); await mkdir('.local', { recursive: true }); });
beforeEach(async () => {
  await database.pg.exec('TRUNCATE audit,deletion_ledger_generation RESTART IDENTITY CASCADE');
  ledger = await initLedger('ledger-contract');
  dirs.push(ledger.dir);
});
afterEach(async () => {
  await closeLedgers();
  for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true });
});
after(async () => { await database.pg.close(); });

test('DATA-02 [T20 원장] 계약 v1 표식의 정확한 바이트로 초기화한 디렉터리는 열리고, 시험 도우미도 같은 바이트를 만듦', async () => {
  assert.equal(markerBytes('3f1c9a2e-7b4d-4e8a-9c21-5d6e7f8a9b0c', '2026-11-02T12:00:00Z'), FIXED_MARKER);
  assert.deepEqual(parseLedgerMarker(FIXED_MARKER), { generation: '3f1c9a2e-7b4d-4e8a-9c21-5d6e7f8a9b0c', initializedAt: '2026-11-02T12:00:00Z' });
  const fixed = await fresh('ledger-fixed', { marker: FIXED_MARKER });
  const opened = await openLedger(fixed.dir, database.db, { acceptGeneration: '3f1c9a2e-7b4d-4e8a-9c21-5d6e7f8a9b0c' });
  assert.equal(opened.status().state, 'ready');
  assert.equal(opened.status().generation, '3f1c9a2e-7b4d-4e8a-9c21-5d6e7f8a9b0c');
  assert.deepEqual(await opened.entries(), []);
  await opened.append(entry('m-1'));
  assert.equal(await opened.has('m-1', 1), true);
  // 표식은 읽기만 한다.
  assert.equal(await readFile(join(fixed.dir, MARKER_FILE), 'utf8'), FIXED_MARKER);
});

test('DATA-02 [T20 원장] 파일·표식·디렉터리가 없으면 빈 원장으로 열지 않고, 봇은 어떤 파일도 만들지 않음', async () => {
  const neither = await fresh('ledger-neither');
  await unlink(join(neither.dir, LEDGER_FILE)); await unlink(join(neither.dir, MARKER_FILE));
  await rejectsWith(openLedger(neither.dir, database.db), 'missing', { stage: 'open', code: 'ENOENT' });
  const noMarker = await fresh('ledger-no-marker');
  await unlink(join(noMarker.dir, MARKER_FILE));
  await rejectsWith(openLedger(noMarker.dir, database.db), 'missing');
  const noFile = await fresh('ledger-no-file');
  await unlink(noFile.file);
  await rejectsWith(openLedger(noFile.dir, database.db), 'missing');
  await rejectsWith(openLedger(join(ledger.dir, 'absent'), database.db), 'missing');
  for (const dir of [neither.dir, noMarker.dir, noFile.dir]) {
    assert.equal(await exists(join(dir, LEDGER_FILE)), dir === noMarker.dir);
    assert.equal(await exists(join(dir, MARKER_FILE)), dir === noFile.dir);
  }
  assert.equal(await exists(join(ledger.dir, 'absent')), false);
  // 기억 서비스도 닫힌 채로 남는다.
  const f = await fixture(database.db);
  const memory = new MemoryService(database.db, f.gate, ledgerAt(noFile.dir, database.db), documents, f.now);
  await rejectsWith(memory.open(), 'missing');
  await assert.rejects(memory.search('fixture-owner', thread, '아무'), MemoryNotReady);
});

test('DATA-02 [T20 원장] 심링크 디렉터리·표식·원장 파일과 일반 파일이 아닌 항목은 거부', async () => {
  const link = `${ledger.dir}-link`;
  await symlink(join(process.cwd(), ledger.dir), link);
  dirs.push(link);
  await rejectsWith(openLedger(link, database.db), 'symlink');

  const markerLink = await fresh('ledger-marker-link');
  await rename(join(markerLink.dir, MARKER_FILE), join(markerLink.dir, 'real.json'));
  await symlink('real.json', join(markerLink.dir, MARKER_FILE));
  await rejectsWith(openLedger(markerLink.dir, database.db), 'symlink');

  const fileLink = await fresh('ledger-file-link');
  await rename(fileLink.file, join(fileLink.dir, 'real.jsonl'));
  await symlink('real.jsonl', fileLink.file);
  await rejectsWith(openLedger(fileLink.dir, database.db), 'symlink');

  const fileDir = await fresh('ledger-file-dir');
  await unlink(fileDir.file); await mkdir(fileDir.file, { mode: 0o700 });
  await rejectsWith(openLedger(fileDir.dir, database.db), 'not_regular_file');

  await rejectsWith(openLedger(join(ledger.dir, MARKER_FILE), database.db), 'not_directory');
});

test('DATA-02 [T20 원장] group·other 쓰기 권한이 있거나 소유 uid가 다르면 거부', async () => {
  const cases: [string, string | null, number][] = [['dir', null, 0o770], ['file', LEDGER_FILE, 0o620], ['marker', MARKER_FILE, 0o602]];
  for (const [name, file, mode] of cases) {
    const made = await fresh(`ledger-mode-${name}`);
    await chmod(file ? join(made.dir, file) : made.dir, mode);
    await rejectsWith(openLedger(made.dir, database.db), 'permissions_too_open', { stage: 'verify' });
  }
  // 읽기 권한만 넓은 것은 계약 위반이 아니다(쓰기 경로가 아님).
  const readable = await fresh('ledger-mode-read');
  await chmod(join(readable.dir, MARKER_FILE), 0o644);
  await openLedger(readable.dir, database.db);
  await rejectsWith(openLedger(ledger.dir, database.db, { io: faultyIo({ uid: process.getuid!() + 1 }) }), 'owner_mismatch');
});

test('DATA-02 [T20 원장] 표식이 손상됐거나 버전이 다르면 거부', async () => {
  const gen = ledger.generation;
  const good = markerBytes(gen, '2026-11-02T12:00:00Z');
  const invalid = [
    '', good.trimEnd(), `${good}${good}`, good.replace('":', '": '), good.replace(gen, gen.toUpperCase()),
    good.replace(gen, '3f1c9a2e-7b4d-1e8a-9c21-5d6e7f8a9b0c'), good.replace('2026-11-02T12:00:00Z', '2026-02-30T12:00:00Z'),
    good.replace('2026-11-02T12:00:00Z', '2026-11-02T12:00:00.000Z'), good.replace('homelab-bot-deletion-ledger', 'other'),
    good.replace('}\n', ',"extra":1}\n'), good.replace('"version":1', '"version":"1"'),
    `{"version":1,"format":"homelab-bot-deletion-ledger","generation":"${gen}","initializedAt":"2026-11-02T12:00:00Z"}\n`,
  ];
  for (const [i, marker] of invalid.entries()) {
    const made = await fresh(`ledger-marker-${i}`, { marker });
    await rejectsWith(openLedger(made.dir, database.db), 'marker_invalid', { stage: 'verify' });
  }
  const v2 = await fresh('ledger-marker-v2', { marker: good.replace('"version":1', '"version":2') });
  await rejectsWith(openLedger(v2.dir, database.db), 'marker_version');
});

test('DATA-02 [T20 원장] 연 파일이 교체·삭제·재생성되면 쓰지 않고 실패 상태로 고정', async () => {
  for (const change of ['replace', 'delete', 'recreate'] as const) {
    const made = await fresh(`ledger-identity-${change}`);
    const opened = await openLedger(made.dir, database.db);
    await opened.append(entry('before'));
    if (change === 'replace') {
      await writeFile(`${made.file}.new`, '', { mode: 0o600 });
      await rename(`${made.file}.new`, made.file);
    } else {
      await unlink(made.file);
      if (change === 'recreate') await writeFile(made.file, '', { mode: 0o600 });
    }
    await rejectsWith(opened.append(entry('after')), 'identity_changed', { stage: 'verify' });
    assert.equal(await opened.durable(), false);
    await rejectsWith(opened.entries(), 'identity_changed');
    assert.deepEqual([opened.status().state, opened.status().failure?.reason], ['failed', 'identity_changed']);
    assert.equal(await exists(made.file), change !== 'delete');
    if (change !== 'delete') assert.equal(await readFile(made.file, 'utf8'), '');
  }
  // 디렉터리 자체를 바꿔치기해도 같다.
  const moved = await fresh('ledger-identity-dir');
  const opened = await openLedger(moved.dir, database.db);
  await rename(moved.dir, `${moved.dir}-old`); dirs.push(`${moved.dir}-old`);
  await fresh('ledger-identity-dir-new').then(made => rename(made.dir, moved.dir));
  await rejectsWith(opened.append(entry('x')), 'identity_changed');
});

test('DATA-02 [T20 원장] ENOSPC·EIO 쓰기·읽기·잘라내기 오류는 단계와 errno를 남기고, 풀리면 다시 씀', async () => {
  const faults: Faults = {};
  let clock = 1_000;
  const opened = await openLedger(ledger.dir, database.db, { io: faultyIo(faults), now: () => clock });
  faults.write = 'ENOSPC';
  clock = 2_000;
  await rejectsWith(opened.append(entry('a')), 'io', { stage: 'append', code: 'ENOSPC' });
  assert.deepEqual(opened.status(), { state: 'degraded', generation: ledger.generation,
    failure: { stage: 'append', reason: 'io', code: 'ENOSPC', at: 2_000 }, since: 2_000 });
  faults.write = undefined;
  await opened.append(entry('a'));
  assert.equal(opened.status().state, 'ready');
  faults.read = 'EIO';
  await rejectsWith(opened.entries(), 'io', { stage: 'read', code: 'EIO' });
  await rejectsWith(opened.append(entry('b')), 'io', { stage: 'read', code: 'EIO' });
  faults.read = undefined;
  // 끊긴 꼬리를 잘라내지 못하면 그 뒤에 붙이지 않는다.
  await writeFile(ledger.file, `${JSON.stringify(entry('a'))}\n{"memoryId":"torn`);
  faults.truncate = 'EROFS';
  await rejectsWith(opened.append(entry('c')), 'io', { stage: 'truncate', code: 'EROFS' });
  assert.match(await readFile(ledger.file, 'utf8'), /torn$/);
  faults.truncate = undefined;
  await opened.append(entry('c'));
  assert.deepEqual((await opened.entries()).map(e => e.memoryId), ['a', 'c']);
  assert.equal(opened.status().state, 'ready');
});

test('DATA-02 [T20 원장] 파일 fsync 실패 뒤에는 새 append가 성공할 수 있어도 프로세스 수명 동안 실패로 고정', async () => {
  const faults: Faults = { fileSync: 'EIO' };
  const opened = await openLedger(ledger.dir, database.db, { io: faultyIo(faults) });
  await rejectsWith(opened.append(entry('a')), 'fsync_failed', { stage: 'fsync', code: 'EIO' });
  faults.fileSync = undefined;
  await rejectsWith(opened.append(entry('b')), 'fsync_failed');
  assert.equal(await opened.durable(), false);
  await rejectsWith(opened.has('a', 1), 'unsynced');
  assert.deepEqual([opened.status().state, opened.status().failure?.stage], ['failed', 'fsync']);
  // 같은 프로세스에서 새 인스턴스를 만들어도 그 파일은 다시 믿지 않는다.
  await rejectsWith(openLedger(ledger.dir, database.db), 'fsync_failed', { stage: 'fsync', code: 'EIO' });
});

test('DATA-02 [T20 원장] 디렉터리 fsync 실패는 내구성 미확인으로 두고, 확인되면 회복', async () => {
  const faults: Faults = { dirSync: 'EIO' };
  const opened = await openLedger(ledger.dir, database.db, { io: faultyIo(faults) });
  await rejectsWith(opened.append(entry('a')), 'io', { stage: 'dirsync', code: 'EIO' });
  assert.equal(await opened.durable(), false);
  assert.equal(opened.status().state, 'degraded');
  faults.dirSync = undefined;
  assert.equal(await opened.durable(), true);
  assert.equal(await opened.has('a', 1), true);
  assert.equal(opened.status().state, 'ready');
});

test('DATA-02 [T20 원장] 잠금 연결을 잃으면 fenced: append·재적용 확인·읽기 모두 실패', async () => {
  const lock = freeLock();
  const opened = ledgerAt(ledger.dir, database.db, { lock: lock.source });
  await opened.open();
  await opened.append(entry('a'));
  lock.lose();
  assert.equal(opened.status().state, 'fenced');
  await rejectsWith(opened.append(entry('b')), 'fenced', { stage: 'lock' });
  assert.equal(await opened.durable(), false);
  await rejectsWith(opened.entries(), 'fenced');
  await rejectsWith(opened.open(), 'fenced');
  assert.equal((await readFile(ledger.file, 'utf8')).split('\n').filter(Boolean).length, 1);
});

test('DATA-02 [T20 원장] close()는 진행 중 쓰기를 마친 뒤 잠금을 놓고, 그 뒤 쓰기는 거부', async () => {
  let released = 0;
  const opened = new FileDeletionLedger({ dir: ledger.dir, db: database.db,
    lock: async () => ({ verify: async () => {}, release: async () => { released++; } }) });
  await rejectsWith(opened.append(entry('early')), 'not_open');
  await opened.open();
  const writing = opened.append(entry('a'));
  const closing = opened.close();
  await writing;
  await closing;
  assert.equal(released, 1);
  assert.equal(opened.status().state, 'closed');
  await rejectsWith(opened.append(entry('b')), 'closed');
  assert.deepEqual((await readFile(ledger.file, 'utf8')).trim().split('\n').map(line => JSON.parse(line).memoryId), ['a']);
});
