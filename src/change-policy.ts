import { createHash } from 'node:crypto';
import { z } from 'zod';
import { ArtifactManifestSchema, BranchNameSchema, ChangePathSchema, CommandIdSchema, RepoIdSchema, RevisionSchema, validateArtifactFiles } from './change-contracts.js';
import type { ArtifactFile, ArtifactManifest } from './change-contracts.js';
import { CiPolicySchema } from './change-ci-policy.js';

// 첫 blob 전의 전체 후보 검사다. 네트워크를 모른다. 입력은 고정 API base tree, 전체 결과 manifest, 변경 바이트, 정책이다.
// Git 객체 SHA 계산도 여기 둔다. 게시 전에 T0·T1·H를 스스로 계산해 대조한다. 작업공간의 .git·모델이 준 SHA를 믿지 않는다.

// ---- Git 객체 ----

export interface BaseLeaf { path: string; mode: string; blobSha: string }
const sha1 = (type: string, body: Buffer) => createHash('sha1').update(`${type} ${body.byteLength}\0`).update(body).digest('hex');
type TreeNode = Map<string, { mode: string; sha: string } | TreeNode>;
function writeTree(node: TreeNode): string {
  // git은 디렉터리를 `이름/`로 비교한다. 그래서 a.b < a/ < a0 순서가 된다. 바이트로 비교해야 한글 이름도 맞는다.
  const rows = [...node.entries()].map(([name, child]) => {
    const dir = child instanceof Map;
    const sha = dir ? writeTree(child) : child.sha;
    const mode = dir ? '40000' : child.mode;
    return { sort: Buffer.from(dir ? `${name}/` : name), row: Buffer.concat([Buffer.from(`${mode} ${name}\0`), Buffer.from(sha, 'hex')]) };
  }).sort((a, b) => Buffer.compare(a.sort, b.sort));
  return sha1('tree', Buffer.concat(rows.map(row => row.row)));
}
export function gitTreeSha(leaves: readonly BaseLeaf[]): string {
  const root: TreeNode = new Map();
  for (const leaf of leaves) {
    const segments = leaf.path.split('/');
    let node = root;
    for (const segment of segments.slice(0, -1)) {
      const existing = node.get(segment);
      if (existing && !(existing instanceof Map)) throw new Error('tree_file_directory_conflict');
      const child: TreeNode = existing ?? new Map();
      node.set(segment, child);
      node = child;
    }
    // 조용히 덮으면 디렉터리 아래 파일이 빠진 SHA가 나온다.
    if (node.has(segments.at(-1)!)) throw new Error('tree_file_directory_conflict');
    node.set(segments.at(-1)!, { mode: leaf.mode, sha: leaf.blobSha });
  }
  return writeTree(root);
}
export interface GitIdentity { name: string; email: string; date: string }
const identityLine = (kind: string, person: GitIdentity) => `${kind} ${person.name} <${person.email}> ${Math.floor(Date.parse(person.date) / 1000)} +0000\n`;
// 고정 metadata로 H를 미리 계산한다. 응답을 잃어도 같은 값을 대조할 수 있다. GitHub이 서명·개행 정규화를 더하면 SHA가 달라져 게시가 멈춘다.
export function gitCommitSha(input: { treeSha: string; parents: readonly string[]; message: string; author: GitIdentity; committer: GitIdentity }): string {
  const head = [`tree ${input.treeSha}\n`, ...input.parents.map(parent => `parent ${parent}\n`), identityLine('author', input.author), identityLine('committer', input.committer), '\n'].join('');
  return sha1('commit', Buffer.from(`${head}${input.message}`));
}

// ---- 경로 ----

// 저장소마다 달라지지 않는 D-24 공통 거부다. 어느 깊이든 막는다. 비교는 NFKC·소문자로 접은 값에 한다. 대소문자를 안 가리는 파일 시스템으로 받아도 같은 파일이기 때문이다.
const PROTECTED_DIRS = new Set(['.github', '.ssh', '.aws', '.gnupg', '.kube', '.docker', '.claude', '.codex']);
const PROTECTED_NAMES = new Set(['agents.md', 'claude.md', 'codeowners', '.gitmodules', '.gitattributes', '.lfsconfig', '.pre-commit-config.yaml',
  '.npmrc', '.pypirc', '.netrc', '.git-credentials', '.dockercfg', 'credentials', 'credentials.json', 'auth.json', 'id_rsa', 'id_dsa', 'id_ecdsa', 'id_ed25519', 'kubeconfig']);
const PROTECTED_NAME_PATTERNS = [/^\.gitleaks/, /^\.env(\.|$)/, /\.(pem|key|p12|pfx|jks|keystore)$/, /^service-account.*\.json$/, /^secrets?\.ya?ml$/];
const fold = (path: string) => path.normalize('NFKC').toLowerCase();
export function isProtectedPath(path: string): boolean {
  const segments = fold(path).split('/');
  const name = segments.at(-1)!;
  return segments.some(segment => PROTECTED_DIRS.has(segment)) || PROTECTED_NAMES.has(name) || PROTECTED_NAME_PATTERNS.some(pattern => pattern.test(name));
}
// 작업 정책은 뿌리 기준 prefix뿐이라 깊은 위치를 표현하지 못한다. 그래서 prefix로는 뿌리 이름만 내리고 최종 판정은 위 함수가 한다.
export const COMMON_DENY_SUMMARY: readonly string[] = Object.freeze(['.github', 'AGENTS.md', 'CLAUDE.md', 'CODEOWNERS', '.gitmodules', '.gitattributes', '.pre-commit-config.yaml', '.gitleaks.toml', '.env', '.npmrc']) as readonly string[];

export type PathProblem = 'path_invalid' | 'path_noncanonical';
export function pathProblem(path: string): PathProblem | null {
  if (!ChangePathSchema.safeParse(path).success) return 'path_invalid';
  if (path !== path.normalize('NFC')) return 'path_noncanonical';
  // 폭 없는 문자·방향 제어는 눈에 안 보이고, 전각 구분자는 다른 도구에서 경로로 바뀐다.
  if (/\p{Cf}/u.test(path)) return 'path_noncanonical';
  const compat = path.normalize('NFKC');
  if (compat.split('/').length !== path.split('/').length || compat.includes('\\') || compat.split('/').some(segment => segment === '.' || segment === '..')) return 'path_noncanonical';
  if (path.split('/').some(segment => /[. ]$/.test(segment))) return 'path_noncanonical';
  return null;
}

// ---- 정책 컴파일 ----

// glob은 두 모양만 받는다. `디렉터리/**`(그 아래 전부)와 정확한 파일 경로다. 작업 정책의 prefix와 의미가 달라 D-24 glob을 그대로 넘기면 안 된다.
export interface CompiledPathPolicy {
  readonly allowed: readonly CompiledRule[];
  readonly denied: readonly CompiledRule[];
}
export type CompiledRule = { kind: 'exact'; path: string } | { kind: 'tree'; prefix: string };
const TREE_SUFFIX = '/**';
function compileRule(glob: string): CompiledRule | null {
  const tree = glob.endsWith(TREE_SUFFIX);
  const path = tree ? glob.slice(0, -TREE_SUFFIX.length) : glob;
  // 나머지 메타 문자는 해석하지 않고 거부한다. 틀린 해석으로 넓어지는 것보다 닫히는 편이 낫다.
  if (!path || /[*?[\]{}!]/.test(path) || pathProblem(path)) return null;
  return tree ? { kind: 'tree', prefix: path } : { kind: 'exact', path };
}
const matches = (rule: CompiledRule, path: string) => rule.kind === 'exact' ? rule.path === path : path.startsWith(`${rule.prefix}/`);
export type CompileResult = { ok: true; policy: CompiledPathPolicy } | { ok: false; reason: 'policy_empty' | 'policy_glob_invalid' };
export function compilePathPolicy(allowedGlobs: readonly string[], deniedGlobs: readonly string[]): CompileResult {
  if (!allowedGlobs.length) return { ok: false, reason: 'policy_empty' };
  const allowed = allowedGlobs.map(compileRule);
  const denied = deniedGlobs.map(compileRule);
  if (allowed.includes(null) || denied.includes(null)) return { ok: false, reason: 'policy_glob_invalid' };
  const rules = allowed as CompiledRule[];
  // 공통 거부와 겹치는 허용은 설정 실수다. 조용히 무시하지 않는다.
  if (rules.some(rule => isProtectedPath(rule.kind === 'exact' ? rule.path : rule.prefix))) return { ok: false, reason: 'policy_glob_invalid' };
  return { ok: true, policy: { allowed: rules, denied: denied as CompiledRule[] } };
}
// 허용은 글자 그대로, 금지는 접어서 비교한다. 대소문자를 안 가리는 파일 시스템에서 같은 파일이면 금지가 이겨야 한다.
const deniedMatches = (rule: CompiledRule, path: string) => rule.kind === 'exact' ? fold(rule.path) === fold(path) : fold(path).startsWith(`${fold(rule.prefix)}/`);
export const pathAllowed = (policy: CompiledPathPolicy, path: string): boolean =>
  policy.allowed.some(rule => matches(rule, path)) && !policy.denied.some(rule => deniedMatches(rule, path));
// task 계약의 allowedPaths·forbiddenPaths로 내린다. 게시 서버의 최종 검사가 원래 의미로 다시 본다.
export function taskPathRules(policy: CompiledPathPolicy): { allowedPaths: string[]; forbiddenPaths: string[] } {
  return { allowedPaths: policy.allowed.map(rule => rule.kind === 'exact' ? rule.path : rule.prefix),
    forbiddenPaths: [...policy.denied.map(rule => rule.kind === 'exact' ? rule.path : rule.prefix), ...COMMON_DENY_SUMMARY] };
}

// RUNTIME_POLICIES의 change.repositories 한 항목이다. B5가 policy.ts에서 이 스키마로 읽는다.
const GlobList = z.array(z.string().min(1).max(512)).max(64);
export const ChangeRepositoryPolicySchema = z.strictObject({
  repoId: RepoIdSchema, fullName: z.string().regex(/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/), installationId: z.number().int().positive(),
  revision: RevisionSchema, baseBranches: z.array(BranchNameSchema).min(1).max(8),
  allowedPaths: GlobList.min(1), deniedPaths: GlobList,
  requiredCommands: z.array(CommandIdSchema).min(1).max(8),
  // 실제 writer의 AC-P8을 사람이 확인했는지다. false면 게시가 막힌다.
  writerAccepted: z.boolean(),
  // 이름 비교로 인증하지 않는다. 봇 사용자의 숫자 ID로 PR 작성자를 대조한다.
  writerBotUserId: z.number().int().positive(),
  identity: z.strictObject({ name: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._[\]-]{0,63}$/), email: z.string().regex(/^[A-Za-z0-9+._[\]-]{1,128}@users\.noreply\.github\.com$/) }),
  // 짧은 표식은 오탐으로 모든 게시를 막거나, 정규화 뒤 비교가 무의미해진다.
  internalMarkers: z.array(z.string().min(4).max(256)).max(256),
  ci: CiPolicySchema,
}).superRefine((policy, context) => {
  if (!compilePathPolicy(policy.allowedPaths, policy.deniedPaths).ok) context.addIssue({ code: 'custom', message: 'policy_glob_invalid' });
});
export type ChangeRepositoryPolicy = z.infer<typeof ChangeRepositoryPolicySchema>;

// ---- 전체 후보 검사 ----

export interface BaseTreeSnapshot { sha: string; complete: boolean; leaves: readonly BaseLeaf[] }
export interface TreeEntryPlan { path: string; mode: '100644' | '100755'; blobSha: string | null }
export interface PublishPlan {
  resultTree: string;
  blobs: (ArtifactFile & { blobSha: string })[];
  treeEntries: TreeEntryPlan[];
  changedPaths: string[];
}
export type InspectFailureReason = 'manifest_invalid' | 'base_tree_incomplete' | 'base_tree_mismatch' | 'base_tree_unproven' | 'base_special_mode' | 'manifest_missing_base_leaf'
  | 'manifest_base_mismatch' | 'result_tree_mismatch' | 'policy_missing' | 'protected_path' | 'path_not_allowed' | 'path_collision' | PathProblem
  | 'file_duplicate' | 'file_unexpected' | 'file_missing' | 'content_mismatch' | 'binary_content';
export type InspectResult = { ok: true; plan: PublishPlan } | { ok: false; reason: InspectFailureReason; path?: string };
const GENERAL_MODES = new Set(['100644', '100755']);
const byBytes = (a: string, b: string) => Buffer.compare(Buffer.from(a), Buffer.from(b));

// 전체를 먼저 판정하고 계획을 하나 돌려준다. 호출자는 이 계획으로만 blob·tree를 보낸다. 앞 파일만 올리고 뒤에서 멈추는 경로가 없다.
export function inspectCandidate(input: { base: BaseTreeSnapshot; manifest: ArtifactManifest; files: readonly ArtifactFile[]; policies: readonly CompiledPathPolicy[] }): InspectResult {
  const { base, files, policies } = input;
  const parsed = ArtifactManifestSchema.safeParse(input.manifest);
  if (!parsed.success) return { ok: false, reason: 'manifest_invalid' };
  const manifest = parsed.data;
  if (!policies.length) return { ok: false, reason: 'policy_missing' };
  if (!base.complete) return { ok: false, reason: 'base_tree_incomplete' };
  if (manifest.baseTree !== base.sha) return { ok: false, reason: 'base_tree_mismatch' };
  for (const leaf of base.leaves) {
    // gitlink·symlink가 있는 저장소는 V1 대상이 아니다. 변경 대상이 아니어도 시작부터 닫는다.
    if (!GENERAL_MODES.has(leaf.mode)) return { ok: false, reason: 'base_special_mode', path: leaf.path };
  }
  // API가 준 잎을 다시 해시한다. 같으면 빠진 잎이 없다는 증명이다.
  let provenTree: string;
  try { provenTree = gitTreeSha(base.leaves); } catch { return { ok: false, reason: 'base_tree_unproven' }; }
  if (provenTree !== base.sha) return { ok: false, reason: 'base_tree_unproven' };

  const baseByPath = new Map(base.leaves.map(leaf => [leaf.path, leaf]));
  const seen = new Set<string>();
  const changed: ArtifactManifest['entries'] = [];
  for (const entry of manifest.entries) {
    seen.add(entry.path);
    const old = baseByPath.get(entry.path);
    const same = old !== undefined && old.blobSha === entry.blobSha && old.mode === entry.mode;
    const consistent = entry.changeKind === 'unchanged' ? same
      : entry.changeKind === 'added' ? old === undefined
        : entry.changeKind === 'deleted' ? same
          : entry.changeKind === 'modified' ? old !== undefined && old.blobSha !== entry.blobSha
            : old !== undefined && old.blobSha === entry.blobSha && old.mode !== entry.mode;
    if (!consistent) return { ok: false, reason: 'manifest_base_mismatch', path: entry.path };
    if (entry.changeKind !== 'unchanged') changed.push(entry);
  }
  // archive에서 빠진 파일을 모델 삭제로 오인하지 않는다. 삭제는 manifest에 deleted로 적혀야 한다.
  for (const leaf of base.leaves) if (!seen.has(leaf.path)) return { ok: false, reason: 'manifest_missing_base_leaf', path: leaf.path };

  const result = manifest.entries.filter(entry => entry.changeKind !== 'deleted');
  let resultTree: string;
  try { resultTree = gitTreeSha(result.map(entry => ({ path: entry.path, mode: entry.mode, blobSha: entry.blobSha }))); } catch { return { ok: false, reason: 'manifest_invalid' }; }
  if (resultTree !== manifest.resultTree) return { ok: false, reason: 'result_tree_mismatch' };

  for (const entry of changed) {
    const problem = pathProblem(entry.path);
    if (problem) return { ok: false, reason: problem, path: entry.path };
  }
  // 대소문자·정규화로 같은 이름이 되는 경로를 새로 만들지 않는다. T0에 이미 있는 충돌을 그대로 두는 것은 변경이 아니다.
  const folded = new Map<string, string[]>();
  for (const entry of result) folded.set(fold(entry.path), [...(folded.get(fold(entry.path)) ?? []), entry.path]);
  // 접었을 때 파일이 다른 파일의 상위 디렉터리가 되어도 그런 파일 시스템에는 함께 받을 수 없다. 원래 경로로 보는 gitTreeSha 검사는 이 경우를 잡지 못한다.
  const parentsOf = (path: string) => path.split('/').slice(0, -1).map((_, index, parts) => parts.slice(0, index + 1).join('/'));
  const foldedParents = new Set([...folded.keys()].flatMap(parentsOf));
  for (const entry of changed) {
    if (entry.changeKind === 'deleted') continue;
    const name = fold(entry.path);
    if ((folded.get(name)?.length ?? 0) > 1 || foldedParents.has(name) || parentsOf(name).some(parent => folded.has(parent))) return { ok: false, reason: 'path_collision', path: entry.path };
  }
  // rename은 deleted+added로 나타나 두 쪽이 모두 여기를 지난다. 보호 판정이 허용 목록보다 먼저다.
  for (const entry of changed) if (isProtectedPath(entry.path)) return { ok: false, reason: 'protected_path', path: entry.path };
  for (const entry of changed) {
    if (!policies.every(policy => pathAllowed(policy, entry.path))) return { ok: false, reason: 'path_not_allowed', path: entry.path };
  }
  const content = validateArtifactFiles(manifest, files);
  if (!content.ok) return { ok: false, reason: content.reason, path: content.path };

  const contentByPath = new Map(files.map(file => [file.path, file.content]));
  const carrying = changed.filter(entry => entry.changeKind === 'added' || entry.changeKind === 'modified');
  return { ok: true, plan: {
    resultTree,
    blobs: carrying.map(entry => ({ path: entry.path, content: contentByPath.get(entry.path)!, blobSha: entry.blobSha })),
    treeEntries: changed.map(entry => ({ path: entry.path, mode: entry.mode, blobSha: entry.changeKind === 'deleted' ? null : entry.blobSha })).sort((a, b) => byBytes(a.path, b.path)),
    changedPaths: changed.map(entry => entry.path).sort(byBytes),
  } };
}
