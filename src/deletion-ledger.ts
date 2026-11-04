import { constants } from 'node:fs';
import type { BigIntStats } from 'node:fs';
import { lstat, open } from 'node:fs/promises';
import type { FileHandle } from 'node:fs/promises';
import { join } from 'node:path';
import { z } from 'zod';
import type { Clock } from './contracts.js';
import type { Database } from './database.js';
import type { LedgerLease, LedgerLockSource } from './ledger-lock.js';

export interface DeletionEntry { memoryId: string; createdAt: number; deletedAt: number }
// 복원 대상 밖의 append-only 삭제 원장. append가 resolve되면 내구성 있게 기록된 것이다.
// entries()는 지금 보이는 항목일 뿐이다. 그 항목으로 삭제를 완료로 올리기 전에는 durable()로 내구성을 확인한다.
// open()이 있으면 MemoryService.open()이 원장을 읽기 전에 부른다(잠금·검증을 읽기보다 먼저 한다).
export interface DeletionLedger {
  open?(): Promise<void>;
  append(entry: DeletionEntry): Promise<void>;
  has(memoryId: string, createdAt: number): Promise<boolean>;
  entries(): Promise<DeletionEntry[]>;
  durable(): Promise<boolean>;
}

// 원장 계약 v1. 디렉터리와 두 파일은 사람이 host/install.sh로 만든다. 봇은 어떤 파일도 만들지 않는다.
export const LEDGER_FILE = 'deletions.jsonl';
export const MARKER_FILE = 'ledger.json';
export const MARKER_FORMAT = 'homelab-bot-deletion-ledger';
export const MARKER_VERSION = 1;

export type LedgerStage = 'lock' | 'open' | 'verify' | 'generation' | 'read' | 'truncate' | 'append' | 'fsync' | 'dirsync' | 'close';
export type LedgerReason = 'lock_held' | 'lock_unavailable' | 'fenced' | 'missing' | 'symlink' | 'not_directory' | 'not_regular_file'
  | 'owner_mismatch' | 'permissions_too_open' | 'marker_invalid' | 'marker_version' | 'generation_mismatch'
  | 'generation_accept_mismatch' | 'generation_unavailable' | 'identity_changed' | 'corrupt' | 'io' | 'fsync_failed'
  | 'unsynced' | 'not_open' | 'closed';
// 메시지·필드에 기억 내용이나 경로 밖 값을 넣지 않는다. code는 errno 이름(ENOSPC·EIO·EROFS·EACCES 등)뿐이다.
export class LedgerError extends Error {
  constructor(readonly reason: LedgerReason, readonly stage: LedgerStage, readonly code?: string) {
    super(`deletion_ledger_${reason}`);
  }
}
export const errnoCode = (error: unknown): string | undefined => {
  const code = (error as NodeJS.ErrnoException | null)?.code;
  return typeof code === 'string' && /^E[A-Z0-9]+$/.test(code) ? code : undefined;
};
// ready: 쓸 수 있음. degraded: 마지막 작업이 재시도할 수 있는 오류로 실패(다음 성공에 ready).
// failed: 이 인스턴스는 더 쓰지 않음. fenced: 잠금을 잃음. closed: 열기 전이거나 close() 뒤.
export type LedgerState = 'closed' | 'ready' | 'degraded' | 'failed' | 'fenced';
export interface LedgerFailure { stage: LedgerStage; reason: LedgerReason; code: string | null; at: number }
export interface LedgerStatus { state: LedgerState; generation: string | null; failure: LedgerFailure | null; since: number }

const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const UTC_SECOND = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/;
export interface LedgerMarker { generation: string; initializedAt: string }
// 표식은 정확히 한 줄 + 개행, 키 순서·공백까지 계약 v1의 모양과 같아야 한다. 셸(H1)이 같은 바이트를 쓴다.
export function parseLedgerMarker(raw: string): LedgerMarker {
  const invalid = () => new LedgerError('marker_invalid', 'verify');
  if (!raw.endsWith('\n') || raw.indexOf('\n') !== raw.length - 1) throw invalid();
  let value: unknown;
  try { value = JSON.parse(raw.slice(0, -1)); } catch { throw invalid(); }
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw invalid();
  const record = value as Record<string, unknown>;
  if (record.format !== MARKER_FORMAT) throw invalid();
  if (record.version !== MARKER_VERSION) throw typeof record.version === 'number' ? new LedgerError('marker_version', 'verify') : invalid();
  const { generation, initializedAt } = record;
  if (Object.keys(record).length !== 4 || typeof generation !== 'string' || !UUID_V4.test(generation)
    || typeof initializedAt !== 'string' || !UTC_SECOND.test(initializedAt)) throw invalid();
  // 2026-02-30 같은 날짜는 왕복하면 바뀐다.
  const time = Date.parse(initializedAt);
  if (!Number.isFinite(time) || new Date(time).toISOString().replace('.000Z', 'Z') !== initializedAt) throw invalid();
  const canonical = `${JSON.stringify({ format: MARKER_FORMAT, version: MARKER_VERSION, generation, initializedAt })}\n`;
  if (canonical !== raw) throw invalid();
  return { generation, initializedAt };
}

const EntrySchema = z.strictObject({ memoryId: z.string().min(1), createdAt: z.number().int().nonnegative(), deletedAt: z.number().int().nonnegative() });
export function parseLedgerEntries(raw: string): DeletionEntry[] {
  // 마지막 줄이 줄바꿈 없이 끝나면 확인되지 않은 append가 끊긴 것이다. 그 줄만 무시한다.
  return raw.split('\n').slice(0, -1).filter(line => line.length).map(line => {
    try { return EntrySchema.parse(JSON.parse(line)); } catch { throw new LedgerError('corrupt', 'read'); }
  });
}

// 파일 I/O는 장애 주입 시험을 위해서만 바꾼다.
export interface LedgerIo {
  open(path: string, flags: number): Promise<FileHandle>;
  lstat(path: string): Promise<BigIntStats>;
  uid(): number;
}
const DEFAULT_IO: LedgerIo = { open: (path, flags) => open(path, flags), lstat: path => lstat(path, { bigint: true }),
  uid: () => process.getuid?.() ?? -1 };
export interface FileLedgerOptions {
  dir: string;
  db: Database;
  lock: LedgerLockSource;
  // 운영자가 새 세대(SSD 교체·재초기화)를 받아들일 때만 준다. 표식의 generation과 같을 때만 DB 묶음을 바꾼다.
  acceptGeneration?: string;
  now?: Clock;
  io?: LedgerIo;
}
// 지운 파일의 inode 번호는 다시 쓰일 수 있어 생성 시각(statx birthtime, 없으면 0)까지 본다.
interface Identity { dev: bigint; ino: bigint; birth: bigint }
interface Handles { dir: FileHandle; file: FileHandle; dirId: Identity; fileId: Identity }

// 파일 fsync 실패는 프로세스 수명 동안 이어진다. 커널이 실패한 페이지를 clean으로 돌려 캐시만 보일 수 있어,
// 같은 프로세스에서 새 인스턴스를 만들거나 다음 append가 성공해도 그 파일을 다시 믿지 않는다. 키는 dev:ino다.
const FSYNC_POISONED = new Map<string, LedgerFailure>();
const key = (id: Identity) => `${id.dev}:${id.ino}:${id.birth}`;
const identity = (stat: BigIntStats): Identity => ({ dev: stat.dev, ino: stat.ino, birth: stat.birthtimeNs });
const READ_ONLY_NOFOLLOW = constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK;

export class FileDeletionLedger implements DeletionLedger {
  private tail: Promise<unknown> = Promise.resolve();
  private state: LedgerState = 'closed';
  private failure: LedgerFailure | null = null;
  private since: number;
  private generation: string | null = null;
  private handles: Handles | undefined;
  private lease: LedgerLease | undefined;
  private opening: Promise<void> | undefined;
  private closing = false;
  private opened = false;
  private lost = false;
  // 디렉터리 항목은 이 프로세스에서 한 번 fsync로 확인하면 된다. 파일을 바꿔치기하면 동일성 검사가 먼저 막는다.
  private dirSynced = false;
  private readonly io: LedgerIo;
  private readonly now: Clock;
  constructor(private readonly options: FileLedgerOptions) {
    this.io = options.io ?? DEFAULT_IO;
    this.now = options.now ?? Date.now;
    this.since = this.now();
  }
  status(): LedgerStatus {
    return { state: this.state, generation: this.generation, failure: this.failure && { ...this.failure }, since: this.since };
  }
  // 잠금 → 디렉터리·표식·파일 검증 → 세대 묶기 순서다. 원장 읽기·꼬리 잘라내기는 모두 잠금 뒤다.
  // 열기 실패는 잡은 것을 모두 놓고 다시 open()할 수 있다. 쓰는 중의 failed·fenced는 다시 열지 않는다.
  async open(): Promise<void> {
    if (this.state === 'ready' || this.state === 'degraded') return;
    if (this.opening) return this.opening;
    if (this.state === 'fenced' || this.handles) throw this.unusable();
    this.opening = this.establish().finally(() => { this.opening = undefined; });
    return this.opening;
  }
  private async establish(): Promise<void> {
    let lease: LedgerLease | undefined;
    let dir: FileHandle | undefined;
    let file: FileHandle | undefined;
    this.lost = false;
    try {
      lease = await this.options.lock(error => this.fence(error)).catch((error: unknown) => {
        throw error instanceof LedgerError ? error : new LedgerError('lock_unavailable', 'lock', errnoCode(error));
      });
      // 심링크 디렉터리·파일은 따라가지 않는다(O_NOFOLLOW). 없으면 만들지 않고 실패한다(O_CREAT 없음).
      dir = await this.step('open', () => this.io.open(this.options.dir, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW))
        .catch(async (error: LedgerError) => {
          // O_DIRECTORY|O_NOFOLLOW는 심링크에 ELOOP 대신 ENOTDIR을 준다. 원인을 바로 적는다.
          if (error.reason === 'not_directory' && (await this.io.lstat(this.options.dir).catch(() => undefined))?.isSymbolicLink()) {
            throw new LedgerError('symlink', 'open', error.code);
          }
          throw error;
        });
      const dirId = this.check(await this.step('verify', () => dir!.stat({ bigint: true })), 'directory');
      const marker = await this.readMarker();
      file = await this.step('open', () => this.io.open(join(this.options.dir, LEDGER_FILE),
        constants.O_RDWR | constants.O_APPEND | constants.O_NOFOLLOW | constants.O_NONBLOCK));
      const fileId = this.check(await this.step('verify', () => file!.stat({ bigint: true })), 'file');
      const poisoned = FSYNC_POISONED.get(key(fileId));
      if (poisoned) throw new LedgerError('fsync_failed', 'fsync', poisoned.code ?? undefined);
      await this.bind(marker.generation);
      if (this.lost) throw new LedgerError('fenced', 'lock');
      this.handles = { dir, file, dirId, fileId };
      this.lease = lease;
      this.generation = marker.generation;
      this.failure = null;
      this.dirSynced = false;
      this.opened = true;
      this.move('ready');
    } catch (error) {
      await file?.close().catch(() => {});
      await dir?.close().catch(() => {});
      await lease?.release().catch(() => {});
      const failure = error instanceof LedgerError ? error : new LedgerError('io', 'open', errnoCode(error));
      this.record(failure);
      this.move(this.lost ? 'fenced' : 'failed');
      throw failure;
    }
  }
  private async readMarker(): Promise<LedgerMarker> {
    const handle = await this.step('open', () => this.io.open(join(this.options.dir, MARKER_FILE), READ_ONLY_NOFOLLOW));
    try {
      this.check(await this.step('verify', () => handle.stat({ bigint: true })), 'file');
      const raw = await this.readAll(handle, 4096);
      return parseLedgerMarker(raw.toString('utf8'));
    } finally { await handle.close().catch(() => {}); }
  }
  // 계약 v1: 소유자는 이 프로세스 uid, group·other 쓰기 없음(디렉터리 0750, 파일 0600).
  private check(stat: BigIntStats, kind: 'directory' | 'file'): Identity {
    if (kind === 'directory' ? !stat.isDirectory() : !stat.isFile()) throw new LedgerError(kind === 'directory' ? 'not_directory' : 'not_regular_file', 'verify');
    if (stat.uid !== BigInt(this.io.uid())) throw new LedgerError('owner_mismatch', 'verify');
    if (stat.mode & 0o022n) throw new LedgerError('permissions_too_open', 'verify');
    return identity(stat);
  }
  // 첫 open은 표식의 세대를 DB에 묶는다. 다르면(SSD 교체·재초기화·다른 디스크) 운영자가 그 세대를 명시할 때만 바꾼다.
  private async bind(generation: string): Promise<void> {
    const accept = this.options.acceptGeneration;
    if (accept !== undefined && accept !== generation) throw new LedgerError('generation_accept_mismatch', 'generation');
    try {
      await this.options.db.transaction(async tx => {
        const now = this.now();
        const bound = (await tx.query<{ generation: string }>('SELECT generation FROM deletion_ledger_generation FOR UPDATE')).rows[0];
        if (bound?.generation === generation) return;
        if (bound && accept !== generation) throw new LedgerError('generation_mismatch', 'generation');
        if (bound) await tx.query('UPDATE deletion_ledger_generation SET generation=$1,bound_at=$2', [generation, now]);
        else await tx.query('INSERT INTO deletion_ledger_generation(generation,bound_at) VALUES ($1,$2)', [generation, now]);
        await tx.query('INSERT INTO audit(kind,subject,detail,created_at) VALUES ($1,$2,$3,$4)', [
          bound ? 'memory_ledger_generation_accepted' : 'memory_ledger_generation_bound', 'deletion_ledger',
          JSON.stringify(bound ? { from: bound.generation, to: generation } : { generation }), now]);
      });
    } catch (error) {
      throw error instanceof LedgerError ? error : new LedgerError('generation_unavailable', 'generation');
    }
  }

  // 프로세스 안의 원장 작업을 줄 세운다. 겹치면 한쪽의 조각 잘라내기가 다른 쪽의 확정된 줄을 지운다.
  // 프로세스 사이는 잠금(LedgerLockSource)이 막는다.
  // close()가 시작된 뒤 들어온 작업은 줄에 넣지 않는다. 그 전에 줄 선 작업은 close()가 기다린다.
  private run<T>(fn: () => Promise<T>): Promise<T> {
    if (this.closing) return Promise.reject(new LedgerError('closed', 'close'));
    const result = this.tail.then(fn);
    this.tail = result.catch(() => {});
    return result;
  }
  append(entry: DeletionEntry): Promise<void> {
    return this.run(async () => {
      const line = Buffer.from(`${JSON.stringify(EntrySchema.parse(entry))}\n`);
      const h = this.usable();
      // 잠금 연결이 살아 있는지 쓰기 직전에 확인한다. 확인과 write 사이에 끊기면 그 한 줄은 쓰일 수 있다.
      // 그 틈에 새 작성자가 들어오는 일은 Recreate(옛 파드 종료 뒤 새 파드)로 줄인다.
      await this.guard();
      await this.verifyIdentity(h);
      try {
        // 끊긴 이전 append의 조각 뒤에 붙이면 원장이 손상된다. 확인되지 않은 조각이므로 잘라낸다.
        const raw = await this.readAll(h.file);
        if (raw.length && raw[raw.length - 1] !== 0x0a) await this.step('truncate', () => h.file.truncate(raw.lastIndexOf(0x0a) + 1));
        await this.step('append', () => this.writeAll(h.file, line));
      } catch (error) { throw this.degrade(error); }
      await this.syncFile(h);
      await this.syncDirectory(h);
      this.recover();
    });
  }
  async has(memoryId: string, createdAt: number): Promise<boolean> {
    if (!await this.durable()) throw new LedgerError('unsynced', 'fsync');
    return (await this.entries()).some(e => e.memoryId === memoryId && e.createdAt === createdAt);
  }
  // 파일과 디렉터리 항목이 둘 다 fsync로 확인될 때만 true다. 잠금을 잃었거나 파일이 바뀌었으면 false다.
  durable(): Promise<boolean> {
    if (this.closing) return Promise.resolve(false);
    return this.run(async () => {
      try {
        const h = this.usable();
        await this.guard();
        await this.verifyIdentity(h);
        await this.syncFile(h);
        await this.syncDirectory(h);
        this.recover();
        return true;
      } catch { return false; }
    });
  }
  // 재시작 때마다 원장 전체를 엄격히 다시 읽는다. 줄바꿈으로 끝난 손상 줄은 오류다.
  entries(): Promise<DeletionEntry[]> {
    return this.run(async () => {
      const h = this.usable();
      await this.verifyIdentity(h);
      let raw: Buffer;
      try { raw = await this.readAll(h.file); } catch (error) { throw this.degrade(error); }
      try { return parseLedgerEntries(raw.toString('utf8')); } catch (error) { throw this.fail(error); }
    });
  }
  // 정상 종료: 새 작업을 받지 않고 진행 중인 쓰기를 마친 뒤 파일을 닫고 잠금을 놓는다.
  async close(): Promise<void> {
    this.closing = true;
    try {
      await this.opening?.catch(() => {});
      await this.tail;
      const h = this.handles;
      this.handles = undefined;
      for (const handle of h ? [h.file, h.dir] : []) {
        try { await handle.close(); } catch (error) { this.record(new LedgerError('io', 'close', errnoCode(error))); }
      }
      await this.lease?.release().catch(() => {});
      this.lease = undefined;
      if (this.state !== 'fenced') this.move('closed');
    } finally { this.closing = false; }
  }

  private usable(): Handles {
    if ((this.state === 'ready' || this.state === 'degraded') && this.handles) return this.handles;
    throw this.unusable();
  }
  private unusable(): LedgerError {
    if ((this.state === 'failed' || this.state === 'fenced') && this.failure) {
      return new LedgerError(this.failure.reason, this.failure.stage, this.failure.code ?? undefined);
    }
    return new LedgerError(this.opened ? 'closed' : 'not_open', 'open');
  }
  private async guard(): Promise<void> {
    try { await this.lease!.verify(); } catch (error) {
      this.fence(error);
      throw this.unusable();
    }
  }
  private fence(error: unknown): void {
    this.lost = true;
    if (this.state === 'fenced') return;
    this.record(new LedgerError('fenced', 'lock', errnoCode(error)));
    // 열기 중이면 establish()가 lost를 보고 실패로 끝낸다.
    if (this.handles) this.move('fenced');
  }
  // 경로가 가리키는 디렉터리·파일이 연 것과 같은지 본다. 교체·삭제·재생성이면 이 인스턴스는 더 쓰지 않는다.
  private async verifyIdentity(h: Handles): Promise<void> {
    const same = async (path: string, id: Identity) => {
      let stat: BigIntStats;
      try { stat = await this.io.lstat(path); } catch (error) {
        if (errnoCode(error) === 'ENOENT') return false;
        throw this.degrade(new LedgerError('io', 'verify', errnoCode(error)));
      }
      return !stat.isSymbolicLink() && key(identity(stat)) === key(id);
    };
    if (!await same(this.options.dir, h.dirId) || !await same(join(this.options.dir, LEDGER_FILE), h.fileId)) {
      throw this.fail(new LedgerError('identity_changed', 'verify'));
    }
  }
  private async syncFile(h: Handles): Promise<void> {
    try { await h.file.sync(); } catch (error) {
      const failure = new LedgerError('fsync_failed', 'fsync', errnoCode(error));
      this.record(failure);
      FSYNC_POISONED.set(key(h.fileId), { ...this.failure! });
      throw this.fail(failure);
    }
  }
  // 디렉터리 fsync 실패는 재시도할 수 있게 둔다(확인될 때까지 durable()이 false다).
  private async syncDirectory(h: Handles): Promise<void> {
    if (this.dirSynced) return;
    try { await h.dir.sync(); } catch (error) { throw this.degrade(new LedgerError('io', 'dirsync', errnoCode(error))); }
    this.dirSynced = true;
  }
  private async readAll(handle: FileHandle, limit = Number.MAX_SAFE_INTEGER): Promise<Buffer> {
    return this.step('read', async () => {
      const size = Number((await handle.stat({ bigint: true })).size);
      if (size > limit) throw new LedgerError('marker_invalid', 'verify');
      const buffer = Buffer.alloc(size);
      let offset = 0;
      while (offset < size) {
        const { bytesRead } = await handle.read(buffer, offset, size - offset, offset);
        if (!bytesRead) break;
        offset += bytesRead;
      }
      return buffer.subarray(0, offset);
    });
  }
  private async writeAll(handle: FileHandle, data: Buffer): Promise<void> {
    let offset = 0;
    while (offset < data.length) offset += (await handle.write(data, offset, data.length - offset, null)).bytesWritten;
  }
  private async step<T>(stage: LedgerStage, fn: () => Promise<T>): Promise<T> {
    try { return await fn(); } catch (error) {
      if (error instanceof LedgerError) throw error;
      const code = errnoCode(error);
      const reason: LedgerReason = code === 'ENOENT' ? 'missing' : code === 'ELOOP' ? 'symlink' : code === 'ENOTDIR' ? 'not_directory'
        : code === 'EISDIR' ? 'not_regular_file' : 'io';
      throw new LedgerError(reason, stage, code);
    }
  }
  private degrade(error: unknown): LedgerError {
    const failure = error instanceof LedgerError ? error : new LedgerError('io', 'append', errnoCode(error));
    if (failure.reason === 'fenced' || this.state === 'failed' || this.state === 'fenced') return failure;
    this.record(failure);
    if (this.state === 'ready') this.move('degraded');
    return failure;
  }
  private fail(error: unknown): LedgerError {
    const failure = error instanceof LedgerError ? error : new LedgerError('io', 'read', errnoCode(error));
    if (this.state === 'fenced') return failure;
    this.record(failure);
    this.move('failed');
    return failure;
  }
  private recover(): void { if (this.state === 'degraded') this.move('ready'); }
  private record(error: LedgerError): void {
    this.failure = { stage: error.stage, reason: error.reason, code: error.code ?? null, at: this.now() };
  }
  private move(state: LedgerState): void {
    if (this.state !== state) { this.state = state; this.since = this.now(); }
  }
}
