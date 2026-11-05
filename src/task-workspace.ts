import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import { chmod, lstat, mkdir, open, readFile, readdir, rename, rm, rmdir, statfs, symlink, writeFile } from 'node:fs/promises';
import { dirname, join, posix } from 'node:path';
import { StringDecoder } from 'node:string_decoder';
import { gunzip } from 'node:zlib';
import { promisify } from 'node:util';
import { z } from 'zod';
import { assertWorkerRoot } from './codex-config.js';
import { changedPaths, fileWorkspace, openDir } from './codex-workspace.js';
import type { Snapshot } from './codex-workspace.js';
import type { RunDirs } from './executor.js';
import { ArchiveError } from './review-input.js';
import type { ArchiveFetcher } from './review-input.js';
import { TASK_LIMITS, TASK_RETENTION, TaskChangeSchema } from './task-contracts.js';
import type { TaskChange, TaskFailureReason, TaskRequest } from './task-contracts.js';
import { archiveContract } from './worker.js';

// 작업 레인의 세션 공간: <TASK_STATE_ROOT>/tasks/<job>/<generation>/{home,config,workspace,run,tmp}.
// 같은 job의 턴 사이에 유지하고 finalize로 지운다(α′). run은 제어 파일 자리이고 모델 셸·파일 도구에서 가린다(executor-claude-task).
// 비신뢰 입력은 압축본과, 실행 뒤의 workspace·config 전부다. 결과 증거는 소멸을 확인한 뒤 이 모듈이 직접 계산한다.

export class TaskWorkspaceError extends Error {
  constructor(readonly reason: TaskFailureReason, readonly detail?: string) { super(detail ?? reason); }
}
// 압축 해제본 전체 상한. 실행 뒤 대조(codex-workspace snapshot)의 상한과 같아야 한다. 더 크면 풀었어도 대조할 수 없다.
const EXPANDED_BYTES = 256 * 1024 * 1024;
const BLOCK = 512;
const CONTROL_CHARS = /[\u0000-\u001f\u007f]/;
const GIT_NAME = /^\.git$/i;

export type ArchiveEntry =
  | { kind: 'directory'; path: string }
  | { kind: 'file'; path: string; executable: boolean; data: Buffer }
  | { kind: 'symlink'; path: string; target: string };
export interface ParsedArchive {
  entries: ArchiveEntry[];
  bytes: number;
  // 압축본에 내용이 없어 작업 공간에 빠지는 것. 조용히 빼지 않고 호출자가 표시한다.
  unsupported: ('submodule' | 'lfs')[];
}
export interface ArchiveLimits { files: number; fileBytes: number }

const reject = (code: string): never => { throw new ArchiveError(code); };
const textField = (block: Buffer, start: number, length: number): string => {
  const raw = block.subarray(start, start + length);
  const end = raw.indexOf(0);
  const bytes = raw.subarray(0, end < 0 ? raw.length : end);
  const text = bytes.toString('utf8');
  // 깨진 UTF-8은 대체 문자로 바뀌어 검사한 이름과 다른 이름이 된다.
  if (!Buffer.from(text, 'utf8').equals(bytes)) reject('archive_path');
  return text;
};
const octalField = (block: Buffer, start: number, length: number): number => {
  const text = block.subarray(start, start + length).toString('latin1').replace(/[\0 ]+$/, '').replace(/^ +/, '');
  if (!/^[0-7]*$/.test(text)) reject('archive_unreadable');
  const value = Number.parseInt(text || '0', 8);
  if (!Number.isSafeInteger(value)) reject('archive_unreadable');
  return value;
};
function checkHeader(header: Buffer): void {
  let sum = 0;
  for (let i = 0; i < BLOCK; i++) sum += i >= 148 && i < 156 ? 32 : header[i]!;
  if (sum !== octalField(header, 148, 8)) reject('archive_unreadable');
  if (header.subarray(257, 262).toString('latin1') !== 'ustar') reject('archive_unreadable');
}
// pax 레코드: "<길이> <키>=<값>\n". 길이가 레코드 전체 바이트 수다. 값에 줄바꿈이 올 수 있어 split으로 나누면 안 된다.
function paxRecords(data: Buffer): Map<string, Buffer> {
  const records = new Map<string, Buffer>();
  for (let offset = 0; offset < data.length;) {
    const space = data.indexOf(32, offset);
    if (space < 0) reject('archive_unreadable');
    const digits = data.subarray(offset, space).toString('latin1');
    const length = Number(digits);
    if (!/^[1-9]\d*$/.test(digits) || !Number.isSafeInteger(length) || offset + length > data.length || data[offset + length - 1] !== 10) reject('archive_unreadable');
    const record = data.subarray(space + 1, offset + length - 1);
    const equals = record.indexOf(61);
    if (equals < 1) reject('archive_unreadable');
    records.set(record.subarray(0, equals).toString('latin1'), record.subarray(equals + 1));
    offset += length;
  }
  return records;
}
const utf8Value = (value: Buffer): string => {
  const text = value.toString('utf8');
  if (!Buffer.from(text, 'utf8').equals(value)) reject('archive_path');
  return text;
};
// 저장소 안 경로 하나를 검사한다. 절대경로·`..`·`.`·빈 칸·제어 문자는 어떤 추출 도구에서도 뜻이 달라질 수 있어 받지 않는다.
function pathParts(name: string): string[] {
  if (!name || name.startsWith('/') || CONTROL_CHARS.test(name)) reject('archive_path');
  const parts = name.split('/');
  if (parts.some(part => part === '' || part === '.' || part === '..')) reject('archive_path');
  return parts;
}

// 심링크를 실제로 따라갔을 때 루트 밖으로 나가는지. 글자로만 정규화하면 `a -> ..`, `b -> a/..` 같은 조합을 놓친다.
// 경유한 심링크는 대상을 다시 펼친다. 중간에라도 루트 위로 올라가거나 .git에 닿으면 탈출로 본다. 끝이 없는 대상은 받는다.
export function symlinkEscapes(path: string, target: string, links: ReadonlyMap<string, string>): boolean {
  if (!target || target.startsWith('/') || CONTROL_CHARS.test(target)) return true;
  let hops = 0;
  const walk = (from: readonly string[], text: string): string[] | null => {
    const stack = [...from];
    for (const part of text.split('/')) {
      if (part === '' || part === '.') continue;
      if (part === '..') { if (!stack.length) return null; stack.pop(); continue; }
      if (GIT_NAME.test(part)) return null;
      const here = [...stack, part].join('/');
      const link = links.get(here);
      if (link === undefined) { stack.push(part); continue; }
      if (++hops > 64 || link.startsWith('/')) return null;
      const resolved = walk(stack, link);
      if (!resolved) return null;
      stack.splice(0, stack.length, ...resolved);
    }
    return stack;
  };
  return walk(posix.dirname(path) === '.' ? [] : posix.dirname(path).split('/'), target) === null;
}

// 고정 SHA 압축본을 디스크에 쓰기 전에 끝까지 검사한다. 하나라도 어긋나면 아무것도 쓰지 않는다. 메시지가 거부 사유 상수다.
// git이 만든 압축본(ustar + pax)의 꼴만 받는다. 하드링크·장치·FIFO·GNU 확장은 그 꼴에 없으므로 받을 이유가 없다.
export async function parseTaskArchive(archive: Uint8Array, limits: ArchiveLimits): Promise<ParsedArchive> {
  let tar: Buffer;
  try { tar = await promisify(gunzip)(archive, { maxOutputLength: EXPANDED_BYTES + (limits.files + 2) * 3 * BLOCK }); }
  catch (error) { throw new ArchiveError((error as { code?: string }).code === 'ERR_BUFFER_TOO_LARGE' ? 'archive_limit' : 'archive_unreadable'); }
  const entries = new Map<string, ArchiveEntry>();
  let root: string | undefined;
  let pending: Map<string, Buffer> | undefined;
  let total = 0;
  let ended = false;
  for (let offset = 0; offset + BLOCK <= tar.length;) {
    const header = tar.subarray(offset, offset + BLOCK);
    if (header.every(byte => byte === 0)) { ended = true; break; }
    checkHeader(header);
    const size = octalField(header, 124, 12);
    const type = String.fromCharCode(header[156]!);
    const data = tar.subarray(offset + BLOCK, offset + BLOCK + size);
    if (data.length !== size) reject('archive_unreadable');
    offset += BLOCK + Math.ceil(size / BLOCK) * BLOCK;
    if (type === 'g' || type === 'x') {
      const records = paxRecords(data);
      if (type === 'g') {
        // 전역 헤더가 이름을 바꾸면 도구마다 다른 경로로 풀린다. codeload는 커밋 주석만 싣는다.
        if (records.has('path') || records.has('linkpath') || records.has('size')) reject('archive_type');
      } else {
        if (pending || records.has('size')) reject('archive_type');
        pending = records;
      }
      continue;
    }
    if (type !== '0' && type !== '\0' && type !== '5' && type !== '2') reject('archive_type');
    if (type !== '0' && type !== '\0' && size !== 0) reject('archive_unreadable');
    const paxPath = pending?.get('path');
    const prefix = textField(header, 345, 155);
    const shortName = textField(header, 0, 100);
    let name = paxPath ? utf8Value(paxPath) : prefix ? `${prefix}/${shortName}` : shortName;
    const linkTarget = pending?.get('linkpath');
    pending = undefined;
    if (type === '5' && name.endsWith('/')) name = name.slice(0, -1);
    const parts = pathParts(name);
    root ??= parts[0]!;
    if (parts[0] !== root) reject('archive_path');
    if (parts.length === 1) {
      if (type !== '5') reject('archive_path');
      continue;
    }
    const inside = parts.slice(1);
    if (inside.some(part => GIT_NAME.test(part))) reject('archive_git');
    const path = inside.join('/');
    if (path.length > TASK_LIMITS.pathChars) reject('archive_limit');
    if (entries.has(path)) reject('archive_duplicate');
    if (entries.size >= limits.files) reject('archive_limit');
    if (type === '5') entries.set(path, { kind: 'directory', path });
    else if (type === '2') {
      const target = linkTarget ? utf8Value(linkTarget) : textField(header, 157, 100);
      entries.set(path, { kind: 'symlink', path, target });
    } else {
      if (size > limits.fileBytes || (total += size) > EXPANDED_BYTES) reject('archive_limit');
      entries.set(path, { kind: 'file', path, executable: (octalField(header, 100, 8) & 0o100) !== 0, data });
    }
  }
  if (!ended || pending) reject('archive_unreadable');
  const links = new Map<string, string>();
  for (const entry of entries.values()) if (entry.kind === 'symlink') links.set(entry.path, entry.target);
  for (const entry of entries.values()) {
    // 부모가 파일이나 심링크면 쓰는 자리가 다른 곳으로 옮겨 간다. 쓰는 순서와 무관하게 전체를 본 뒤 거부한다.
    const parts = entry.path.split('/');
    for (let depth = 1; depth < parts.length; depth++) {
      const parent = entries.get(parts.slice(0, depth).join('/'));
      if (parent && parent.kind !== 'directory') reject('archive_path');
    }
    if (entry.kind === 'symlink' && symlinkEscapes(entry.path, entry.target, links)) reject('archive_symlink');
  }
  const unsupported: ParsedArchive['unsupported'] = [];
  if (entries.has('.gitmodules')) unsupported.push('submodule');
  for (const entry of entries.values()) {
    if (entry.kind === 'file' && posix.basename(entry.path) === '.gitattributes' && entry.data.includes('filter=lfs')) { unsupported.push('lfs'); break; }
  }
  return { entries: [...entries.values()], bytes: total, unsupported };
}

// 비어 있는 디렉터리 아래에 쓴다. 심링크는 마지막에 만들어 쓰는 동안 경로가 다른 곳을 가리키는 일이 없다. 권한은 실행 비트만 살린다.
export async function writeArchive(parsed: ParsedArchive, root: string): Promise<void> {
  const parents = new Set<string>();
  for (const entry of parsed.entries) {
    if (entry.kind === 'directory') parents.add(entry.path);
    const parent = posix.dirname(entry.path);
    if (parent !== '.') parents.add(parent);
  }
  for (const dir of [...parents].sort()) await mkdir(join(root, dir), { recursive: true, mode: 0o755 });
  for (const entry of parsed.entries) {
    if (entry.kind !== 'file') continue;
    const mode = entry.executable ? 0o755 : 0o644;
    const file = await open(join(root, entry.path), constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, mode);
    try { await file.writeFile(entry.data); await file.chmod(mode); } finally { await file.close(); }
  }
  for (const entry of parsed.entries) {
    if (entry.kind === 'symlink') await symlink(entry.target, join(root, entry.path));
  }
}

const isNoSpace = (error: unknown): boolean => {
  const failure = error as { code?: unknown; stderr?: unknown } | null;
  return failure?.code === 'ENOSPC' || failure?.code === 'EDQUOT' || (typeof failure?.stderr === 'string' && /No space left|Disk quota/i.test(failure.stderr));
};

const SessionRecordSchema = z.strictObject({
  version: z.literal(1), job: z.string(), generation: z.number().int(), sessionId: z.string(), repository: z.string(), base: z.string(),
  policyRevision: z.string(), projectId: z.string(), projectRevision: z.string(), storage: z.string(), turn: z.number().int(),
  limits: z.strictObject({ files: z.number().int(), fileBytes: z.number().int() }),
  unsupported: z.array(z.enum(['submodule', 'lfs'])),
});
type SessionRecord = z.infer<typeof SessionRecordSchema>;
export interface TaskSession { dirs: RunDirs; job: string; generation: number; sessionId: string; unsupported: readonly ('submodule' | 'lfs')[] }
export interface TaskEvidence {
  changes: { total: number; items: TaskChange[] };
  patch: { text: string; bytes: number; digest: string; truncated: boolean };
}
type Project = TaskRequest['project'];
export type EvidenceResult = { ok: true; evidence: TaskEvidence } | { ok: false; reason: TaskFailureReason };
export interface TaskSessionsOptions {
  // 이 작업자가 쓰는 저장소의 식별자(worker identity의 storage). 재개 대조에 쓴다.
  storage: string;
  homes?: readonly string[];
  maxSessions?: number;
  volumeBytes?: number;
}
const JOB = /^[0-9a-f-]{36}$/;
const GENERATION = /^[1-9]\d*$/;

// 비신뢰 코드가 권한을 없앤 디렉터리(chmod 000)가 있어도 지운다. lstat로 보므로 심링크를 따라 바깥 권한을 바꾸지 않는다.
async function openPermissions(dir: string): Promise<void> {
  const info = await lstat(dir);
  if (!info.isDirectory()) return;
  await chmod(dir, 0o700);
  for (const name of await readdir(dir)) await openPermissions(join(dir, name));
}
// 권한을 먼저 연다. rm은 첫 EACCES로 거부한 뒤에도 다른 항목을 계속 지우고 있어, 실패한 뒤 열면 그 진행과 경합한다.
// 판정은 rm의 성공이 아니라 실제 부재다.
export async function removeTree(path: string): Promise<boolean> {
  const gone = () => lstat(path).then(() => false, (error: { code?: string }) => error.code === 'ENOENT');
  try {
    if (await gone()) return true;
    await openPermissions(path);
    await rm(path, { recursive: true, force: true });
    return await gone();
  } catch { return false; }
}

export class TaskSessions {
  readonly root: string;
  // nonce·실행 receipt 자리. 모델에서 가린다.
  readonly controlDir: string;
  private readonly tasks: string;
  private readonly maxSessions: number;
  private readonly volumeBytes: number;
  constructor(root: string, private readonly options: TaskSessionsOptions) {
    this.root = assertWorkerRoot(root, options.homes);
    this.controlDir = join(this.root, '.homelab-worker');
    this.tasks = join(this.root, 'tasks');
    this.maxSessions = options.maxSessions ?? TASK_RETENTION.maxRetainedSessions;
    this.volumeBytes = options.volumeBytes ?? TASK_RETENTION.sessionVolumeBytes;
  }
  private generationDir(job: string, generation: number): string {
    if (!JOB.test(job) || !Number.isSafeInteger(generation) || generation < 1) throw new TaskWorkspaceError('prepare_failed', 'session_path');
    return join(this.tasks, job, String(generation));
  }
  paths(job: string, generation: number): RunDirs {
    const root = this.generationDir(job, generation);
    return { root, home: join(root, 'home'), config: join(root, 'config'), workspace: join(root, 'workspace'), run: join(root, 'run'), tmp: join(root, 'tmp') };
  }
  private async generations(): Promise<{ job: string; generation: string }[]> {
    const found: { job: string; generation: string }[] = [];
    const jobs = await readdir(this.tasks).catch((error: { code?: string }) => { if (error.code === 'ENOENT') return [] as string[]; throw error; });
    for (const job of jobs) {
      if (!JOB.test(job)) throw new TaskWorkspaceError('prepare_failed', 'session_listing');
      for (const generation of await readdir(join(this.tasks, job))) {
        if (!GENERATION.test(generation)) throw new TaskWorkspaceError('prepare_failed', 'session_listing');
        found.push({ job, generation });
      }
    }
    return found;
  }
  // 이 세대를 뺀 모든 작업 경로. 샌드박스 설정이 이 목록으로 가린다. 직렬 1이라 실행 중에 새 세션이 생기지 않는다.
  async others(job: string, generation: number): Promise<string[]> {
    return (await this.generations()).filter(item => !(item.job === job && item.generation === String(generation)))
      .map(item => join(this.tasks, item.job, item.generation)).sort();
  }
  async retained(): Promise<number> { return (await this.generations()).length; }
  // 이 세대 공간이 디스크에 남아 있는가. 오류 사유로 짐작하지 않고 실제 경로를 본다. 없음을 확인하지 못하면 남은 것으로 답한다.
  async exists(job: string, generation: number): Promise<boolean> {
    let dir: string;
    // 이 모양의 경로는 create가 만들지 않는다.
    try { dir = this.generationDir(job, generation); } catch { return false; }
    return lstat(dir).then(() => true, (error: { code?: string }) => error.code !== 'ENOENT');
  }
  private async usedBytes(dir: string, budget = { entries: 2_000_000 }): Promise<number> {
    let used = 0;
    const names = await readdir(dir).catch((error: { code?: string }) => { if (error.code === 'ENOENT') return [] as string[]; throw error; });
    for (const name of names) {
      if (--budget.entries < 0) return Number.POSITIVE_INFINITY;
      const path = join(dir, name);
      const info = await lstat(path).catch(() => null);
      if (!info) continue;
      used += info.isDirectory() ? await this.usedBytes(path, budget) : info.size;
    }
    return used;
  }
  // 로컬 PV는 요청 크기를 강제하지 않아 2Gi 상한을 여기서 센다. 기준 커밋이 내용을 한 벌 더 쓰므로 해제본의 두 배를 예약한다.
  private async assertRoom(parsed: ParsedArchive, archiveBytes: number): Promise<void> {
    const needed = parsed.bytes * 2 + archiveBytes;
    const info = await statfs(this.root);
    if (info.bavail * info.bsize < needed) throw new TaskWorkspaceError('storage_full', 'disk');
    if (await this.usedBytes(this.tasks) + needed > this.volumeBytes) throw new TaskWorkspaceError('storage_full', 'volume');
  }
  private async writeRecord(dirs: RunDirs, record: SessionRecord): Promise<void> {
    const path = join(dirs.run, 'session.json');
    await writeFile(`${path}.tmp`, JSON.stringify(record), { mode: 0o600 });
    await rename(`${path}.tmp`, path);
  }

  // 첫 턴. 압축본을 받아 검사하고, 풀고, 기준 커밋과 기준 해시를 남긴다. 실패하면 만든 것을 지운다.
  async create(request: Extract<TaskRequest, { operation: 'start' }>, fetchArchive: ArchiveFetcher, signal: AbortSignal): Promise<TaskSession> {
    const dirs = this.paths(request.job, request.generation);
    let created = false;
    try {
      if ((await this.retained()) >= this.maxSessions) throw new TaskWorkspaceError('storage_full', 'retention');
      const taken = await lstat(dirs.root).then(() => true, (error: { code?: string }) => { if (error.code === 'ENOENT') return false; throw error; });
      if (taken) throw new TaskWorkspaceError('session_mismatch', 'generation_exists');
      const url = archiveContract(request.repository, request.base, request.base).base;
      const archive = await fetchArchive(url, { credentials: 'omit', redirect: 'error', maxBytes: request.limits.archiveBytes, signal });
      if (signal.aborted) throw new TaskWorkspaceError('aborted');
      const limits = { files: request.limits.files, fileBytes: request.limits.fileBytes };
      const parsed = await parseTaskArchive(archive, limits);
      await this.assertRoom(parsed, archive.byteLength);
      await mkdir(join(this.tasks, request.job), { recursive: true, mode: 0o700 });
      await mkdir(dirs.root, { mode: 0o700 });
      created = true;
      for (const dir of [dirs.home, dirs.config, dirs.workspace, dirs.run, dirs.tmp]) await mkdir(dir, { mode: 0o700 });
      await writeArchive(parsed, dirs.workspace);
      // 기준 해시는 기준 커밋 뒤에 잰다. 해시는 .git을 보지 않으므로 순서와 무관하지만, 실패한 준비의 해시를 남기지 않는다.
      await fileWorkspace.prepare(dirs.workspace);
      const baseline = await fileWorkspace.snapshot(dirs.workspace);
      if (!baseline) throw new TaskWorkspaceError('workspace_failed', 'baseline_snapshot');
      await writeFile(join(dirs.run, 'baseline.json'), JSON.stringify(baseline), { mode: 0o600 });
      // patch의 "이전" 쪽 원본. 실행 뒤의 workspace/.git은 비신뢰라 쓰지 않는다.
      await writeFile(join(dirs.run, 'baseline.tar.gz'), archive, { mode: 0o600 });
      await this.writeRecord(dirs, { version: 1, job: request.job, generation: request.generation, sessionId: request.sessionId,
        repository: request.repository, base: request.base, policyRevision: request.policyRevision, projectId: request.project.id,
        projectRevision: request.project.revision, storage: this.options.storage, turn: 0, limits, unsupported: parsed.unsupported });
      return { dirs, job: request.job, generation: request.generation, sessionId: request.sessionId, unsupported: parsed.unsupported };
    } catch (error) {
      if (created) await removeTree(dirs.root);
      if (error instanceof TaskWorkspaceError) throw error;
      if (isNoSpace(error)) throw new TaskWorkspaceError('storage_full', 'no_space');
      if (signal.aborted) throw new TaskWorkspaceError('aborted');
      if (error instanceof ArchiveError) throw new TaskWorkspaceError('archive_failed', error.message);
      throw new TaskWorkspaceError('workspace_failed', created ? 'prepare' : 'session');
    }
  }

  // 재개. 세션이 없거나 묶인 값이 다르면 새 세션으로 대신하지 않고 실패한다.
  async open(request: Extract<TaskRequest, { operation: 'resume' }>): Promise<TaskSession> {
    const dirs = this.paths(request.job, request.generation);
    let record: SessionRecord;
    try { record = SessionRecordSchema.parse(JSON.parse(await readFile(join(dirs.run, 'session.json'), 'utf8'))); }
    catch { throw new TaskWorkspaceError('session_missing'); }
    if (record.job !== request.job || record.generation !== request.generation || record.sessionId !== request.sessionId
      || record.repository !== request.repository || record.base !== request.base || record.policyRevision !== request.policyRevision
      || record.projectId !== request.project.id || record.projectRevision !== request.project.revision
      || record.storage !== this.options.storage || request.expectedWorker.storage !== this.options.storage
      || request.turn <= record.turn) throw new TaskWorkspaceError('session_mismatch');
    if (!await this.conversationExists(dirs, request.sessionId)) throw new TaskWorkspaceError('session_missing', 'conversation');
    return { dirs, job: request.job, generation: request.generation, sessionId: request.sessionId, unsupported: record.unsupported };
  }
  // CLI는 세션 기록을 $CLAUDE_CONFIG_DIR/projects/<cwd 이름>/<id>.jsonl에 둔다 [실측: 2.1.308]. 없으면 --resume이 새 세션처럼 시작할 수 없게 먼저 막는다.
  private async conversationExists(dirs: RunDirs, sessionId: string): Promise<boolean> {
    const projects = join(dirs.config, 'projects');
    for (const name of await readdir(projects).catch(() => [] as string[])) {
      const info = await lstat(join(projects, name, `${sessionId}.jsonl`)).catch(() => null);
      if (info?.isFile()) return true;
    }
    return false;
  }
  // 턴이 끝나고 소멸을 확인한 뒤 부른다. 같은 턴 번호가 다시 오면 재개를 거부하게 된다.
  async recordTurn(session: TaskSession, turn: number): Promise<void> {
    const path = join(session.dirs.run, 'session.json');
    const record = SessionRecordSchema.parse(JSON.parse(await readFile(path, 'utf8')));
    await this.writeRecord(session.dirs, { ...record, turn });
  }

  // 결과 영속 뒤 세대 전체를 지운다. 소멸을 확인하지 못하면 살아 있는 프로세스가 쓰는 공간일 수 있어 건드리지 않는다.
  async finalize(job: string, generation: number, stop: () => Promise<boolean>): Promise<{ stopped: boolean; cleaned: boolean }> {
    const stopped = await stop().catch(() => false);
    if (!stopped) return { stopped: false, cleaned: false };
    const dir = this.generationDir(job, generation);
    if (!await removeTree(dir)) return { stopped: true, cleaned: false };
    await rmdir(dirname(dir)).catch(() => {});
    return { stopped: true, cleaned: true };
  }

  // 소멸을 확인한 뒤에만 부른다. 해시 대조는 실제 파일에서 한다. 모델이 무엇을 했다고 말했는지는 보지 않는다.
  async collect(session: TaskSession, project: Project, limits: { patchBytes: number; changeItems?: number }, secrets: readonly string[]): Promise<EvidenceResult> {
    const { dirs } = session;
    let before: Snapshot;
    let after: Snapshot | null;
    let record: SessionRecord;
    try {
      before = Object.assign(Object.create(null) as Snapshot, JSON.parse(await readFile(join(dirs.run, 'baseline.json'), 'utf8')) as Snapshot);
      record = SessionRecordSchema.parse(JSON.parse(await readFile(join(dirs.run, 'session.json'), 'utf8')));
      const handle = await openDir(dirs.workspace);
      try { after = await fileWorkspace.snapshot(handle); } finally { await handle.close().catch(() => {}); }
    } catch { return { ok: false, reason: 'diff_unavailable' }; }
    if (!after) return { ok: false, reason: 'diff_unavailable' };
    const changed = changedPaths(before, after);
    const classified = classifyChanges(changed, before, after, project);
    if (!classified.ok) return classified;
    const scanner = new SecretScanner(secrets);
    for (const path of changed) scanner.push(Buffer.from(path, 'utf8'));
    const patchRoot = join(dirs.run, 'patch');
    try {
      await removeTree(patchRoot);
      await mkdir(join(patchRoot, 'a'), { recursive: true, mode: 0o700 });
      await mkdir(join(patchRoot, 'b'), { mode: 0o700 });
      if (changed.length) await materialize(await readFile(join(dirs.run, 'baseline.tar.gz')), record.limits, changed, before, after, dirs.workspace, patchRoot, scanner);
      if (scanner.found()) return { ok: false, reason: 'secret_echo' };
      scanner.end();
      const patch = changed.length ? await gitPatch(patchRoot, limits.patchBytes, scanner) : emptyPatch();
      // 양쪽 파일에 나뉜 조각이 삭제 줄과 추가 줄로 나란히 놓이면 patch에서 처음 온전해진다.
      if (scanner.found()) return { ok: false, reason: 'secret_echo' };
      const max = limits.changeItems ?? TASK_LIMITS.changeItems;
      return { ok: true, evidence: { changes: { total: classified.items.length, items: classified.items.slice(0, max) }, patch } };
    } catch { return { ok: false, reason: 'diff_unavailable' }; }
    finally { await removeTree(patchRoot); }
  }
}

const matchesPrefix = (path: string, prefix: string) => path === prefix || path.startsWith(`${prefix}/`);
const sha256 = (data: string) => createHash('sha256').update(data).digest('hex');
function classifyChanges(changed: readonly string[], before: Snapshot, after: Snapshot, project: Project): { ok: true; items: TaskChange[] } | { ok: false; reason: TaskFailureReason } {
  const links = new Map<string, string>();
  for (const [path, value] of Object.entries(after)) if (value.startsWith('link:')) links.set(path, value.slice(5));
  const items: TaskChange[] = [];
  for (const path of changed) {
    const value = after[path];
    if (path.split('/').some(part => GIT_NAME.test(part))) return { ok: false, reason: 'change_path_invalid' };
    if (project.forbiddenPaths.some(prefix => matchesPrefix(path, prefix)) || !project.allowedPaths.some(prefix => matchesPrefix(path, prefix))) {
      return { ok: false, reason: 'change_outside_policy' };
    }
    let item: TaskChange;
    if (value === undefined) item = { change: 'deleted', path };
    else if (value === 'special:hardlink') return { ok: false, reason: 'change_outside_workspace' };
    else if (value.startsWith('special')) return { ok: false, reason: 'change_path_invalid' };
    else if (value.startsWith('link:')) {
      if (symlinkEscapes(path, value.slice(5), links)) return { ok: false, reason: 'change_outside_workspace' };
      item = { change: before[path] === undefined ? 'added' : 'modified', path, mode: '120000', digest: sha256(value.slice(5)) };
    } else {
      const [digest, mode] = value.split(':');
      item = { change: before[path] === undefined ? 'added' : 'modified', path, mode: mode === '755' ? '100755' : '100644', digest: digest! };
    }
    if (!TaskChangeSchema.safeParse(item).success) return { ok: false, reason: 'change_path_invalid' };
    items.push(item);
  }
  return { ok: true, items };
}

// echoesSecret과 같은 기준(영숫자만 남겨 16자 조각 비교)을 조각으로 흘려 잰다. 변경 파일은 메모리에 다 올리기엔 클 수 있다.
class SecretScanner {
  private readonly windows: string[] = [];
  private tail = '';
  private hit = false;
  constructor(secrets: readonly string[]) {
    for (const secret of secrets) {
      const squashed = secret.replace(/[^A-Za-z0-9]/g, '');
      for (let start = 0; start + 16 <= squashed.length; start += 4) this.windows.push(squashed.slice(start, start + 16));
    }
  }
  push(chunk: Buffer): void {
    if (this.hit || !this.windows.length) return;
    const text = this.tail + chunk.toString('latin1').replace(/[^A-Za-z0-9]/g, '');
    if (this.windows.some(window => text.includes(window))) { this.hit = true; return; }
    this.tail = text.slice(-15);
  }
  end(): void { this.tail = ''; }
  found(): boolean { return this.hit; }
}

// 바뀐 파일만 a/(기준)·b/(실행 뒤)에 복사한다. 실행 뒤 쪽은 snapshot이 일반 파일로 본 것만 읽고, 소멸을 확인했으므로 경로가 그 사이 바뀌지 않는다.
// 삭제 줄·문맥 줄·심링크 대상은 양쪽에서 patch로 나가므로 복사하는 바이트를 양쪽 다 검사한다. 이진 파일은 patch에서 base85가 되어 원본에서 재야 잡힌다.
async function materialize(archive: Buffer, limits: ArchiveLimits, changed: readonly string[], before: Snapshot, after: Snapshot,
  workspace: string, patchRoot: string, scanner: SecretScanner): Promise<void> {
  const wanted = new Set(changed);
  const parsed = await parseTaskArchive(archive, limits);
  for (const entry of parsed.entries) {
    if (!wanted.has(entry.path) || before[entry.path] === undefined || entry.kind === 'directory') continue;
    const target = join(patchRoot, 'a', entry.path);
    await mkdir(dirname(target), { recursive: true, mode: 0o700 });
    scanner.push(entry.kind === 'symlink' ? Buffer.from(entry.target, 'utf8') : entry.data);
    scanner.end();
    if (entry.kind === 'symlink') await symlink(entry.target, target);
    else await writeFile(target, entry.data, { mode: entry.executable ? 0o755 : 0o644, flag: 'wx' });
  }
  for (const path of changed) {
    const value = after[path];
    if (value === undefined) continue;
    const target = join(patchRoot, 'b', path);
    await mkdir(dirname(target), { recursive: true, mode: 0o700 });
    if (value.startsWith('link:')) {
      scanner.push(Buffer.from(value.slice(5), 'utf8')); scanner.end();
      await symlink(value.slice(5), target);
      continue;
    }
    const source = await open(join(workspace, path), constants.O_RDONLY | constants.O_NOFOLLOW);
    const copy = await open(target, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL, value.endsWith(':755') ? 0o755 : 0o644);
    try {
      for await (const chunk of source.createReadStream({ autoClose: false })) { scanner.push(chunk as Buffer); await copy.write(chunk as Buffer); }
      scanner.end();
    } finally { await source.close().catch(() => {}); await copy.close().catch(() => {}); }
  }
}

function emptyPatch(): TaskEvidence['patch'] { return { text: '', bytes: 0, digest: sha256(''), truncated: false }; }

// 저장소 밖의 두 디렉터리를 비교한다. 설정을 하나도 읽지 않게 하고 외부 diff·textconv를 끈다. 비신뢰 .git/config와 .gitattributes 구동기는 닿지 않는다.
// digest와 bytes는 전체 출력 기준이다. text는 상한 안에서 유효한 UTF-8까지만 담고, 줄었으면 truncated다. 반사 검사도 잘리기 전 전체를 본다.
function gitPatch(patchRoot: string, patchBytes: number, scanner: SecretScanner): Promise<TaskEvidence['patch']> {
  return new Promise((resolve, reject) => {
    const child = spawn('git', ['diff', '--no-index', '--no-prefix', '--binary', '--full-index', '--no-color', '--no-ext-diff', '--no-textconv', '--no-renames', '--', 'a', 'b'], {
      cwd: patchRoot, stdio: ['ignore', 'pipe', 'ignore'],
      env: { PATH: '/usr/local/bin:/usr/bin:/bin', HOME: patchRoot, LANG: 'C.UTF-8', GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null',
        GIT_CEILING_DIRECTORIES: dirname(patchRoot), GIT_ATTR_NOSYSTEM: '1', GIT_TERMINAL_PROMPT: '0' } });
    const hash = createHash('sha256');
    const kept: Buffer[] = [];
    let keptBytes = 0;
    let bytes = 0;
    child.stdout.on('data', (chunk: Buffer) => {
      hash.update(chunk);
      scanner.push(chunk);
      bytes += chunk.length;
      if (keptBytes < patchBytes) {
        const part = chunk.subarray(0, patchBytes - keptBytes);
        kept.push(part); keptBytes += part.length;
      }
    });
    child.once('error', reject);
    child.once('close', code => {
      // git diff --no-index는 차이가 있으면 1이다. 그 밖은 실패다.
      if (code !== 0 && code !== 1) { reject(new Error('patch_failed')); return; }
      let text = new StringDecoder('utf8').write(Buffer.concat(kept));
      const invalid = text.indexOf('�');
      if (invalid >= 0) text = text.slice(0, invalid);
      resolve({ text, bytes, digest: hash.digest('hex'), truncated: Buffer.byteLength(text) < bytes });
    });
  });
}
