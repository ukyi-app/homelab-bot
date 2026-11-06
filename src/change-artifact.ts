import { createHash, randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { chmod, lstat, mkdir, open, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';
import { z } from 'zod';
import { ARTIFACT_LIMITS, ArtifactManifestSchema, ChangePathSchema, MANIFEST_MODES, artifactDigest, gitBlobSha, sha256Hex, validateArtifactFiles } from './change-contracts.js';
import type { ArtifactBundle, ArtifactFile, ArtifactManifestEntry, ArtifactSaveResult, ChangeArtifactPort, ChangeKey } from './change-contracts.js';
import type { ChangeStore } from './change-store.js';
import { changedPaths, fileWorkspace, openDir } from './codex-workspace.js';
import type { Snapshot } from './codex-workspace.js';
import type { RunDirs } from './executor.js';
import { TaskV2ResultResponseSchema, WireArtifactSchema } from './task-contracts.js';
import type { BaselineLeaf, ChangeArtifactReason, TaskV2TurnResult, WireArtifact } from './task-contracts.js';
import { parseTaskArchive, sandboxTraces } from './task-workspace.js';
import type { ArchiveLimits, ParsedArchive, TaskEvidence } from './task-workspace.js';

// 작업 레인 결과를 게시 서버에 넘길 artifact로 만든다. 프로세스 소멸을 확인한 뒤의 실제 파일과, 모델이 돌기 전에 게시 서버 값과 대조한 T0만 믿는다.
// 작업 공간의 .git·hook·config와 모델이 준 SHA는 읽지 않는다. 상한을 넘거나 하나라도 불완전하면 자르지 않고 닫는다.

const fail = (reason: ChangeArtifactReason) => ({ ok: false as const, reason });
export type ArtifactOutcome<T> = { ok: true; value: T } | { ok: false; reason: ChangeArtifactReason };
const sameBytes = (a: string, b: string) => Buffer.compare(Buffer.from(a), Buffer.from(b));

// ---- Git 객체 계산 ----

type TreeNode = Map<string, { mode: string; sha: string } | TreeNode>;
// git mktree·GitHub create tree와 같은 값이어야 한다. 시험이 실제 git과 대조한다.
export function gitTreeSha(leaves: readonly { path: string; mode: string; blobSha: string }[]): string {
  const root: TreeNode = new Map();
  for (const leaf of leaves) {
    const parts = leaf.path.split('/');
    let node = root;
    for (const part of parts.slice(0, -1)) {
      const next = node.get(part);
      if (next instanceof Map) { node = next; continue; }
      if (next) throw new Error('tree_file_directory_conflict');
      const created: TreeNode = new Map();
      node.set(part, created);
      node = created;
    }
    const name = parts[parts.length - 1]!;
    if (node.has(name)) throw new Error('tree_file_directory_conflict');
    node.set(name, { mode: leaf.mode, sha: leaf.blobSha });
  }
  const hash = (node: TreeNode): string => {
    // git은 디렉터리 이름을 '/'가 붙은 것처럼 바이트로 정렬한다.
    const sorted = [...node.entries()].sort(([a, left], [b, right]) => sameBytes(left instanceof Map ? `${a}/` : a, right instanceof Map ? `${b}/` : b));
    const body = Buffer.concat(sorted.flatMap(([name, entry]) => {
      const mode = entry instanceof Map ? '40000' : entry.mode;
      const sha = entry instanceof Map ? hash(entry) : entry.sha;
      return [Buffer.from(`${mode} ${name}\0`), Buffer.from(sha, 'hex')];
    }));
    return createHash('sha1').update(`tree ${body.length}\0`).update(body).digest('hex');
  };
  return hash(root);
}

// ---- T0 대조 ----

const BaselineEntrySchema = z.strictObject({ path: z.string(), mode: z.enum(MANIFEST_MODES), blobSha: z.string(), sha256: z.string(), size: z.number().int().nonnegative() });
export const ChangeBaselineSchema = z.strictObject({ version: z.literal(1), repoId: z.number().int(), changeGeneration: z.number().int(), baseCommit: z.string(), baseTree: z.string(), entries: z.array(BaselineEntrySchema) });
export type ChangeBaseline = z.infer<typeof ChangeBaselineSchema>;
const BASELINE_FILE = 'change-baseline.json';

// 압축본과 게시 서버의 T0가 정확히 같을 때만 진행한다. export-ignore·export-subst·LFS·submodule처럼 둘이 달라지는 저장소는 모델을 띄우기 전에 닫는다.
// 그래서 뒤의 계산에서 "압축본에 없음"이 "모델이 지움"으로 둔갑할 수 없다.
export function compareBaseline(parsed: ParsedArchive, input: { repoId: number; changeGeneration: number; base: string; baseTree: string; leaves: readonly BaselineLeaf[] }): ArtifactOutcome<ChangeBaseline> {
  if (parsed.unsupported.length) return fail('baseline_unsupported');
  if (input.leaves.some(leaf => !(MANIFEST_MODES as readonly string[]).includes(leaf.mode))) return fail('baseline_unsupported');
  if (parsed.entries.some(entry => entry.kind === 'symlink')) return fail('baseline_unsupported');
  if (input.leaves.some(leaf => !ChangePathSchema.safeParse(leaf.path).success)) return fail('baseline_unsupported');
  let computed: string;
  try { computed = gitTreeSha(input.leaves); } catch { return fail('baseline_mismatch'); }
  if (computed !== input.baseTree) return fail('baseline_mismatch');
  const files = new Map<string, Extract<ParsedArchive['entries'][number], { kind: 'file' }>>();
  for (const entry of parsed.entries) if (entry.kind === 'file') files.set(entry.path, entry);
  if (files.size !== input.leaves.length) return fail('baseline_mismatch');
  const entries: ChangeBaseline['entries'] = [];
  for (const leaf of [...input.leaves].sort((a, b) => sameBytes(a.path, b.path))) {
    const file = files.get(leaf.path);
    if (!file || gitBlobSha(file.data) !== leaf.blobSha || (file.executable ? '100755' : '100644') !== leaf.mode) return fail('baseline_mismatch');
    entries.push({ path: leaf.path, mode: leaf.mode as typeof MANIFEST_MODES[number], blobSha: leaf.blobSha, sha256: sha256Hex(file.data), size: file.data.byteLength });
  }
  return { ok: true, value: { version: 1, repoId: input.repoId, changeGeneration: input.changeGeneration, baseCommit: input.base, baseTree: input.baseTree, entries } };
}
export async function writeBaseline(dirs: RunDirs, baseline: ChangeBaseline): Promise<void> {
  await writeFile(join(dirs.run, BASELINE_FILE), JSON.stringify(baseline), { mode: 0o600 });
}
export async function readBaseline(dirs: RunDirs): Promise<ChangeBaseline | null> {
  try { return ChangeBaselineSchema.parse(JSON.parse(await readFile(join(dirs.run, BASELINE_FILE), 'utf8'))); } catch { return null; }
}

// ---- 결과 수집 ----

async function readChanged(workspace: string, path: string, room: number): Promise<Buffer | 'too_large' | null> {
  const handle = await open(join(workspace, path), constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK).catch(() => null);
  if (!handle) return null;
  try {
    const info = await handle.stat();
    if (!info.isFile() || info.nlink !== 1) return null;
    if (info.size > room) return 'too_large';
    const data = await handle.readFile();
    return data.byteLength > room ? 'too_large' : data;
  } catch { return null; } finally { await handle.close().catch(() => {}); }
}
// T0 대조는 기준 저장소만 본다. 모델이 결과에 새로 넣은 submodule·LFS 선언은 tree에서 일반 blob이지만 clone에서 다르게 풀리므로 여기서 닫는다.
const LFS_POINTER = Buffer.from('version https://git-lfs.github.com/spec/');
function declaresExternalContent(path: string, data: Buffer): boolean {
  const name = basename(path).toLowerCase();
  if (name === '.gitmodules') return true;
  if (name === '.gitattributes' && data.includes('filter=lfs')) return true;
  return data.subarray(0, LFS_POINTER.length).equals(LFS_POINTER);
}
const manifestFailure = (message: string | undefined): ChangeArtifactReason =>
  message === 'manifest_no_changes' ? 'artifact_no_changes'
    : message === 'manifest_too_many_changes' || message === 'manifest_content_too_large' ? 'artifact_too_large'
      : message === 'manifest_order' || message === 'manifest_file_directory_conflict' || message === 'change_path_invalid' ? 'artifact_path_invalid'
        : 'artifact_incomplete';

// 소멸을 확인한 뒤에만 부른다. patch는 v1 증거 계산(반사 검사 포함)이 만든 것을 그대로 받는다. 전체 출력일 때만 쓴다.
export async function collectArtifact(input: { dirs: RunDirs; baseline: ChangeBaseline; patch: TaskEvidence['patch'] }): Promise<ArtifactOutcome<ArtifactBundle>> {
  const { dirs, baseline, patch } = input;
  if (patch.truncated) return fail('artifact_too_large');
  const patchBytes = Buffer.from(patch.text);
  // 깨진 UTF-8은 글자로 옮기며 바뀐다. 옮긴 뒤 digest가 다르면 리뷰가 본 patch와 원본이 다른 것이다.
  if (patchBytes.byteLength !== patch.bytes || sha256Hex(patchBytes) !== patch.digest) return fail('artifact_too_large');
  let before: Snapshot;
  let after: Snapshot | null;
  try {
    before = Object.assign(Object.create(null) as Snapshot, JSON.parse(await readFile(join(dirs.run, 'baseline.json'), 'utf8')) as Snapshot);
    const handle = await openDir(dirs.workspace);
    try { after = await fileWorkspace.snapshot(handle); } finally { await handle.close().catch(() => {}); }
  } catch { return fail('artifact_incomplete'); }
  if (!after) return fail('artifact_incomplete');
  for (const path of sandboxTraces(before, after)) delete after[path];
  const base = new Map(baseline.entries.map(entry => [entry.path, entry]));
  const paths = [...new Set([...base.keys(), ...Object.keys(after)])].sort(sameBytes);
  if (paths.length > ARTIFACT_LIMITS.manifestEntries) return fail('artifact_too_large');
  const entries: ArtifactManifestEntry[] = [];
  const files: ArtifactFile[] = [];
  let contentBytes = 0;
  for (const path of paths) {
    if (!ChangePathSchema.safeParse(path).success) return fail('artifact_path_invalid');
    const value = after[path];
    const prior = base.get(path);
    if (value === undefined) {
      // T0를 압축본과 대조했으므로 여기 오는 것은 실제로 사라진 파일뿐이다.
      entries.push({ path, mode: prior!.mode, changeKind: 'deleted', blobSha: prior!.blobSha, sha256: prior!.sha256, size: prior!.size });
      continue;
    }
    if (value.startsWith('link:') || value.startsWith('special')) return fail('artifact_unsupported');
    const [digest, perm] = value.split(':');
    const mode = perm === '755' ? '100755' as const : '100644' as const;
    if (prior && prior.sha256 === digest) {
      entries.push({ path, mode, changeKind: prior.mode === mode ? 'unchanged' : 'mode_changed', blobSha: prior.blobSha, sha256: prior.sha256, size: prior.size });
      continue;
    }
    const data = await readChanged(dirs.workspace, path, ARTIFACT_LIMITS.changedContentBytes - contentBytes);
    if (data === 'too_large') return fail('artifact_too_large');
    if (!data || sha256Hex(data) !== digest) return fail('artifact_incomplete');
    if (declaresExternalContent(path, data)) return fail('artifact_unsupported');
    contentBytes += data.byteLength;
    files.push({ path, content: data });
    entries.push({ path, mode, changeKind: prior ? 'modified' : 'added', blobSha: gitBlobSha(data), sha256: digest!, size: data.byteLength });
  }
  let resultTree: string;
  try { resultTree = gitTreeSha(entries.filter(entry => entry.changeKind !== 'deleted')); } catch { return fail('artifact_path_invalid'); }
  const parsed = ArtifactManifestSchema.safeParse({ version: 1, baseCommit: baseline.baseCommit, baseTree: baseline.baseTree, resultTree, patchSha256: sha256Hex(patchBytes), entries });
  if (!parsed.success) return fail(manifestFailure(parsed.error.issues[0]?.message));
  const checked = validateArtifactFiles(parsed.data, files);
  if (!checked.ok) return fail(checked.reason === 'binary_content' ? 'artifact_binary' : 'artifact_incomplete');
  return { ok: true, value: { manifest: parsed.data, files, patch: patch.text } };
}

// ---- 전송 ----

export const encodeArtifact = (artifact: ArtifactBundle): WireArtifact => ({ manifest: artifact.manifest, patch: artifact.patch,
  files: artifact.files.map(file => ({ path: file.path, contentBase64: Buffer.from(file.content).toString('base64') })) });
// 작업자 응답도 저장 전에 전부 다시 대조한다. 같은 base64가 나오지 않으면 다른 바이트로 풀린 것이다.
export function decodeArtifact(wire: unknown, expectedDigest: string): ArtifactBundle | null {
  const parsed = WireArtifactSchema.safeParse(wire);
  if (!parsed.success || artifactDigest(parsed.data.manifest) !== expectedDigest) return null;
  const files: ArtifactFile[] = [];
  for (const file of parsed.data.files) {
    const content = Buffer.from(file.contentBase64, 'base64');
    if (content.toString('base64') !== file.contentBase64) return null;
    files.push({ path: file.path, content });
  }
  if (!validateArtifactFiles(parsed.data.manifest, files).ok || sha256Hex(Buffer.from(parsed.data.patch)) !== parsed.data.manifest.patchSha256) return null;
  return { manifest: parsed.data.manifest, files, patch: parsed.data.patch };
}

// ---- 작업자 쪽 결과 보존 ----

// 제어 디렉터리에 둔다. 세션 공간과 달리 준비 실패로 세션이 없을 때도 답을 남길 수 있고 모델에서 가려져 있다. finalize나 기록 정리까지 지우지 않는다.
const RESULT_NAME = (job: string, generation: number) => `${job}.${generation}.result.json`;
const RECEIPT_NAME = (job: string, generation: number, command: string) => `${job}.${generation}.verification.${command}.json`;
const RECEIPT_START_NAME = (job: string, generation: number, command: string) => `${job}.${generation}.verification.${command}.started`;
const StoredResultSchema = TaskV2ResultResponseSchema;
async function writeAtomic(path: string, content: string): Promise<void> {
  const temporary = `${path}.${randomUUID()}.tmp`;
  try {
    const handle = await open(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL, 0o600);
    // 재시작 뒤에도 답할 수 있어야 하는 파일이라 이름을 옮기기 전에 내용을 디스크로 보낸다.
    try { await handle.writeFile(content); await handle.sync(); } finally { await handle.close(); }
    await rename(temporary, path);
  } catch (error) { await rm(temporary, { force: true }).catch(() => {}); throw error; }
}
export class ChangeResults {
  constructor(private readonly dir: string) {}
  async writeResult(result: TaskV2TurnResult): Promise<void> {
    await mkdir(this.dir, { recursive: true, mode: 0o700 });
    await writeAtomic(join(this.dir, RESULT_NAME(result.job, result.generation)), JSON.stringify(result));
  }
  async readResult(job: string, generation: number): Promise<TaskV2TurnResult | null> {
    const raw = await readFile(join(this.dir, RESULT_NAME(job, generation)), 'utf8').catch(() => null);
    if (raw === null) return null;
    const parsed = StoredResultSchema.safeParse(JSON.parse(raw));
    return parsed.success && 'usage' in parsed.data ? parsed.data : null;
  }
  async writeVerification(job: string, generation: number, command: string, record: unknown): Promise<void> {
    await mkdir(this.dir, { recursive: true, mode: 0o700 });
    await writeAtomic(join(this.dir, RECEIPT_NAME(job, generation, command)), JSON.stringify(record));
  }
  // 시험 프로세스를 띄우기 전에 남긴다. 재시작 뒤 이 기록만 있으면 앞선 실행의 결과를 모르는 것이라 다시 돌리지 않는다.
  // 배타적으로 만든다. 이미 있으면 false이고 호출자는 시험을 띄우지 않는다. 내용은 보지 않으므로 쓰기 도중 끊겨 빈 파일이 남아도 "시작함"으로 읽혀 안전하다.
  async writeVerificationStart(job: string, generation: number, command: string): Promise<boolean> {
    await mkdir(this.dir, { recursive: true, mode: 0o700 });
    const path = join(this.dir, RECEIPT_START_NAME(job, generation, command));
    let handle;
    try { handle = await open(path, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL, 0o600); }
    catch (error) {
      if ((error as { code?: string }).code === 'EEXIST') return false;
      throw error;
    }
    try { await handle.writeFile('{}'); await handle.sync(); }
    catch (error) { await rm(path, { force: true }).catch(() => {}); throw error; }
    finally { await handle.close(); }
    return true;
  }
  async verificationStarted(job: string, generation: number, command: string): Promise<boolean> {
    return readFile(join(this.dir, RECEIPT_START_NAME(job, generation, command)), 'utf8').then(() => true, (error: { code?: string }) => {
      if (error.code === 'ENOENT') return false;
      throw error;
    });
  }
  async readVerification(job: string, generation: number, command: string): Promise<unknown> {
    const raw = await readFile(join(this.dir, RECEIPT_NAME(job, generation, command)), 'utf8').catch(() => null);
    return raw === null ? null : JSON.parse(raw) as unknown;
  }
  async remove(job: string, generation: number): Promise<void> {
    for (const name of await readdir(this.dir).catch(() => [] as string[])) {
      if (name.startsWith(`${job}.${generation}.`)) await rm(join(this.dir, name), { force: true });
    }
  }
  // 영수증이 사라진 job의 결과를 지운다. 볼륨을 영영 차지하지 않게 한다.
  async prune(known: (job: string) => boolean): Promise<void> {
    for (const name of await readdir(this.dir).catch(() => [] as string[])) {
      const job = name.split('.')[0]!;
      if (!known(job)) await rm(join(this.dir, name), { force: true });
    }
  }
}

// ---- 검증용 source ----

export interface MaterializeInput { target: string; archive: Uint8Array; limits: ArchiveLimits; artifact: ArtifactBundle }
// T1을 작업 공간이 아니라 신뢰할 수 있는 두 곳에서 다시 짓는다: 모델 실행 전에 대조한 압축본과, 소멸 뒤 고정한 artifact 바이트. 작업 공간의 흔적·.git·무시된 파일이 시험에 닿지 않는다.
export async function materializeSource(input: MaterializeInput): Promise<ArtifactOutcome<Snapshot>> {
  const { target, artifact } = input;
  const parsed = await parseTaskArchive(input.archive, input.limits).catch(() => null);
  if (!parsed) return fail('artifact_incomplete');
  const archive = new Map(parsed.entries.flatMap(entry => entry.kind === 'file' ? [[entry.path, entry.data] as const] : []));
  const changed = new Map(artifact.files.map(file => [file.path, file.content]));
  const expected: Snapshot = Object.create(null);
  await mkdir(target, { recursive: true, mode: 0o700 });
  for (const entry of artifact.manifest.entries) {
    if (entry.changeKind === 'deleted') continue;
    const bytes = entry.changeKind === 'added' || entry.changeKind === 'modified' ? changed.get(entry.path) : archive.get(entry.path);
    if (!bytes || sha256Hex(bytes) !== entry.sha256 || gitBlobSha(bytes) !== entry.blobSha) return fail('artifact_incomplete');
    const path = join(target, entry.path);
    await mkdir(dirname(path), { recursive: true, mode: 0o755 });
    const mode = entry.mode === '100755' ? 0o755 : 0o644;
    const handle = await open(path, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, mode);
    try { await handle.writeFile(bytes); await handle.chmod(mode); } finally { await handle.close(); }
    expected[entry.path] = `${entry.sha256}:${entry.mode === '100755' ? '755' : '644'}`;
  }
  const actual = await snapshotSource(target);
  if (!actual || changedPaths(expected, actual.files).length) return fail('artifact_incomplete');
  if (gitTreeSha(artifact.manifest.entries.filter(entry => entry.changeKind !== 'deleted')) !== artifact.manifest.resultTree) return fail('artifact_incomplete');
  return { ok: true, value: expected };
}
// 실행 전후 대조의 값. 파일뿐 아니라 디렉터리 목록과 .git 유무까지 본다. snapshot은 이 둘을 기록하지 않는다.
export interface SourceSnapshot { files: Snapshot; directories: string[] }
export async function snapshotSource(root: string): Promise<SourceSnapshot | null> {
  const files = await fileWorkspace.snapshot(root);
  if (!files) return null;
  const directories: string[] = [];
  const walk = async (dir: string, rel: string): Promise<void> => {
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const path = rel ? `${rel}/${entry.name}` : entry.name;
      directories.push(path);
      await walk(join(dir, entry.name), path);
    }
  };
  try {
    await walk(root, '');
    // snapshot이 최상위 .git을 건너뛴다. 생겼으면 파일 하나로 치고 대조에 걸리게 한다.
    if (await lstat(join(root, '.git')).then(() => true, () => false)) files['.git'] = 'special';
  } catch { return null; }
  return { files, directories: directories.sort() };
}
export const sourceUnchanged = (before: SourceSnapshot, after: SourceSnapshot | null): boolean =>
  after !== null && changedPaths(before.files, after.files).length === 0 && JSON.stringify(before.directories) === JSON.stringify(after.directories);
// 비신뢰 프로세스 뒤에 지울 수 있게 권한을 열고, 쓰기 금지를 파일 권한으로도 건다. 경계는 읽기 전용 마운트이고 이 권한은 덧댐이다.
export async function freezeSource(root: string): Promise<void> {
  const walk = async (dir: string): Promise<void> => {
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) await walk(path);
      else if (entry.isFile()) await chmod(path, (await lstat(path)).mode & 0o111 ? 0o555 : 0o444);
    }
    await chmod(dir, 0o555);
  };
  await walk(root);
}

// ---- 게시 서버 쪽 저장 ----

// ChangeStore 위의 어댑터. 저장 실패면 값을 돌려주고 작업자 결과를 지우지 않는다.
export class ChangeStoreArtifacts implements ChangeArtifactPort {
  constructor(private readonly store: ChangeStore) {}
  async save(key: ChangeKey, artifact: ArtifactBundle, transportBytes: number): Promise<ArtifactSaveResult> {
    const saved = await this.store.recordSnapshot({ ...key, manifest: artifact.manifest, files: artifact.files, patch: artifact.patch, transportBytes });
    return saved.ok ? { ok: true, artifactDigest: saved.value.artifactDigest } : { ok: false, reason: saved.reason };
  }
  async load(key: ChangeKey): Promise<(ArtifactBundle & { artifactDigest: string }) | null> {
    const loaded = await this.store.loadArtifact(key);
    if (!loaded.ok) return null;
    return { manifest: loaded.value.manifest, files: loaded.value.files, patch: loaded.value.patch, artifactDigest: loaded.value.artifactDigest };
  }
}
