import { randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { chmod, lstat, mkdtemp, open, writeFile } from 'node:fs/promises';
import type { FileHandle } from 'node:fs/promises';
import { join } from 'node:path';
import type { Database } from '../src/database.js';
import { FileDeletionLedger, LEDGER_FILE, LedgerError, MARKER_FILE, MARKER_FORMAT, MARKER_VERSION } from '../src/deletion-ledger.js';
import type { FileLedgerOptions, LedgerIo } from '../src/deletion-ledger.js';
import type { LedgerLockSource } from '../src/ledger-lock.js';

// 계약 v1 표식의 정확한 바이트. host/install.sh(H1)가 쓰는 모양과 같아야 한다.
export const FIXED_MARKER = '{"format":"homelab-bot-deletion-ledger","version":1,"generation":"3f1c9a2e-7b4d-4e8a-9c21-5d6e7f8a9b0c","initializedAt":"2026-11-02T12:00:00Z"}\n';
export const markerBytes = (generation: string, initializedAt: string) =>
  `${JSON.stringify({ format: MARKER_FORMAT, version: MARKER_VERSION, generation, initializedAt })}\n`;

// 시험용 초기화 도우미. 운영에서는 사람이 install.sh로 같은 일을 한다(디렉터리 0750, 파일 0600, 빈 원장).
export async function initLedger(prefix = 'ledger', options: { marker?: string; generation?: string } = {}) {
  const dir = await mkdtemp(`.local/${prefix}-`);
  await chmod(dir, 0o750);
  const generation = options.generation ?? randomUUID();
  await writeFile(join(dir, LEDGER_FILE), '', { mode: 0o600, flag: 'wx' });
  await writeFile(join(dir, MARKER_FILE), options.marker ?? markerBytes(generation, '2026-11-02T12:00:00Z'), { mode: 0o600, flag: 'wx' });
  await chmod(join(dir, LEDGER_FILE), 0o600);
  await chmod(join(dir, MARKER_FILE), 0o600);
  return { dir, generation, file: join(dir, LEDGER_FILE) };
}

// PGlite 시험용 잠금. 늘 잡히고, lose()로 잠금 연결이 끊긴 것을 흉내 낸다. 실제 배타는 PG 시험이 본다.
export function freeLock(): { source: LedgerLockSource; lose: () => void } {
  const lost: ((error: unknown) => void)[] = [];
  let gone = false;
  return {
    source: async onLost => {
      lost.push(onLost);
      return { verify: async () => { if (gone) throw new LedgerError('fenced', 'lock'); }, release: async () => {} };
    },
    lose: () => { gone = true; for (const fn of lost) fn(new Error('lock_connection_ended')); },
  };
}

export const errno = (code: string) => Object.assign(new Error(code), { code });
// 걸어 둔 errno로 해당 단계만 실패시킨다. 값은 호출 때마다 다시 읽어 열린 핸들에도 바로 적용된다.
export interface Faults { dirSync?: string; fileSync?: string; write?: string; read?: string; truncate?: string; uid?: number }
export function faultyIo(faults: Faults, counts: { dirSync: number; fileSync: number } = { dirSync: 0, fileSync: 0 }): LedgerIo {
  const wrap = (handle: FileHandle, directory: boolean, ledger: boolean) => new Proxy(handle, {
    get(target, prop) {
      if (prop === 'sync') return async () => {
        const code = directory ? faults.dirSync : ledger ? faults.fileSync : undefined;
        if (code) { counts[directory ? 'dirSync' : 'fileSync']++; throw errno(code); }
        return target.sync();
      };
      if ((prop === 'write' || prop === 'read' || prop === 'truncate') && ledger) return async (...args: unknown[]) => {
        const code = faults[prop];
        if (code) throw errno(code);
        return (target[prop] as (...a: unknown[]) => unknown).apply(target, args);
      };
      const value = Reflect.get(target, prop, target);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
  return {
    open: async (path, flags) => wrap(await open(path, flags), (flags & constants.O_DIRECTORY) !== 0, path.endsWith(LEDGER_FILE)),
    lstat: path => lstat(path, { bigint: true }),
    uid: () => faults.uid ?? process.getuid!(),
  };
}

// 시험이 만든 원장은 afterEach에서 닫는다. 열린 FileHandle을 GC가 닫으면 Node가 오류를 낸다.
const created: FileDeletionLedger[] = [];
export function ledgerAt(dir: string, db: Database, extra: Partial<FileLedgerOptions> = {}) {
  const ledger = new FileDeletionLedger({ dir, db, lock: freeLock().source, ...extra });
  created.push(ledger);
  return ledger;
}
export async function closeLedgers(): Promise<void> {
  await Promise.all(created.splice(0).map(ledger => ledger.close().catch(() => {})));
}
export async function openLedger(dir: string, db: Database, extra: Partial<FileLedgerOptions> = {}) {
  const ledger = ledgerAt(dir, db, extra);
  await ledger.open();
  return ledger;
}
