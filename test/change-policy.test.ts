import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { artifactDigest, gitBlobSha, sha256Hex } from '../src/change-contracts.js';
import type { ArtifactFile, ArtifactManifest, ManifestChangeKind } from '../src/change-contracts.js';
import {
  COMMON_DENY_SUMMARY, compilePathPolicy, gitCommitSha, gitTreeSha, inspectCandidate, isProtectedPath, pathProblem, taskPathRules,
} from '../src/change-policy.js';
import type { BaseLeaf, BaseTreeSnapshot, CompiledPathPolicy } from '../src/change-policy.js';

// 입력은 모두 합성이고 SHA는 실제 git 형식으로 계산한다. 네트워크를 쓰지 않는다.
const text = (value: string) => Buffer.from(value);
const leaf = (path: string, content: string, mode = '100644'): BaseLeaf => ({ path, mode, blobSha: gitBlobSha(text(content)) });
const BASE_FILES: Record<string, string> = {
  '.github/workflows/build.yaml': 'on: pull_request\n', 'AGENTS.md': '# 지침\n', 'README.md': '# 읽어보기\n',
  'package.json': '{}\n', 'src/a.ts': 'export const a = 1;\n', 'src/deep/b.ts': 'export const b = 2;\n', 'tests/a.test.ts': 'test\n',
};
const baseLeaves = () => Object.entries(BASE_FILES).map(([path, content]) => leaf(path, content));
function baseOf(leaves: BaseLeaf[] = baseLeaves()): BaseTreeSnapshot {
  return { sha: gitTreeSha(leaves), complete: true, leaves };
}
const compare = (a: string, b: string) => Buffer.compare(Buffer.from(a), Buffer.from(b));

interface Change { path: string; content?: string; mode?: '100644' | '100755'; kind: ManifestChangeKind }
// 변경 목록을 실제 manifest·결과 tree로 만든다. 바꾸지 않은 T0 leaf는 unchanged로 함께 넣는다.
function candidate(changes: Change[], base: BaseTreeSnapshot = baseOf()): { manifest: ArtifactManifest; files: ArtifactFile[] } {
  const byPath = new Map(changes.map(change => [change.path, change]));
  const entries: ArtifactManifest['entries'] = [];
  const files: ArtifactFile[] = [];
  for (const old of base.leaves) {
    const change = byPath.get(old.path);
    if (change) continue;
    entries.push({ path: old.path, mode: old.mode as '100644', changeKind: 'unchanged', blobSha: old.blobSha, sha256: 'a'.repeat(64), size: 1 });
  }
  for (const change of changes) {
    const old = base.leaves.find(item => item.path === change.path);
    if (change.kind === 'deleted' || change.kind === 'mode_changed') {
      entries.push({ path: change.path, mode: change.mode ?? (old?.mode as '100644') ?? '100644', changeKind: change.kind, blobSha: old?.blobSha ?? gitBlobSha(text('없음')), sha256: 'a'.repeat(64), size: 1 });
      continue;
    }
    const content = text(change.content ?? '변경\n');
    entries.push({ path: change.path, mode: change.mode ?? '100644', changeKind: change.kind, blobSha: gitBlobSha(content), sha256: sha256Hex(content), size: content.byteLength });
    files.push({ path: change.path, content });
  }
  entries.sort((a, b) => compare(a.path, b.path));
  const resultTree = gitTreeSha(entries.filter(entry => entry.changeKind !== 'deleted').map(entry => ({ path: entry.path, mode: entry.mode, blobSha: entry.blobSha })));
  return { manifest: { version: 1, baseCommit: 'c'.repeat(40), baseTree: base.sha, resultTree, patchSha256: 'b'.repeat(64), entries }, files };
}
const smokePolicy = (): CompiledPathPolicy => {
  const compiled = compilePathPolicy(['src/**', 'tests/**', 'docs/**', 'README.md'], []);
  assert.equal(compiled.ok, true);
  return (compiled as { ok: true; policy: CompiledPathPolicy }).policy;
};
function inspect(changes: Change[], options: { base?: BaseTreeSnapshot; policies?: CompiledPathPolicy[] } = {}) {
  const base = options.base ?? baseOf();
  const { manifest, files } = candidate(changes, base);
  return inspectCandidate({ base, manifest, files, policies: options.policies ?? [smokePolicy()] });
}
const rejected = (result: ReturnType<typeof inspectCandidate>, reason: string) => {
  assert.equal(result.ok, false, `거부돼야 한다: ${reason}`);
  if (!result.ok) assert.equal(result.reason, reason);
};

test('T19 B3 정책: 허용 경로의 추가·수정·삭제·mode 변경은 계획으로 나오고 blob은 내용이 있는 변경만이다', () => {
  const result = inspect([
    { path: 'src/new.ts', kind: 'added', content: '새 파일\n' },
    { path: 'src/a.ts', kind: 'modified', content: '수정\n' },
    { path: 'tests/a.test.ts', kind: 'deleted' },
    { path: 'src/deep/b.ts', kind: 'mode_changed', mode: '100755' },
  ]);
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.deepEqual(result.plan.blobs.map(blob => blob.path).sort(), ['src/a.ts', 'src/new.ts']);
  assert.deepEqual(result.plan.treeEntries.map(entry => [entry.path, entry.mode, entry.blobSha === null]), [
    ['src/a.ts', '100644', false], ['src/deep/b.ts', '100755', false], ['src/new.ts', '100644', false], ['tests/a.test.ts', '100644', true],
  ]);
  assert.deepEqual(result.plan.changedPaths, ['src/a.ts', 'src/deep/b.ts', 'src/new.ts', 'tests/a.test.ts']);
});

const WORKFLOW = '.github/workflows/build.yaml';
for (const [name, changes] of Object.entries({
  'workflow 생성': [{ path: '.github/workflows/new.yaml', kind: 'added' }],
  'workflow 수정': [{ path: WORKFLOW, kind: 'modified' }],
  'workflow 삭제': [{ path: WORKFLOW, kind: 'deleted' }],
  'workflow를 허용 경로로 옮김(출발)': [{ path: WORKFLOW, kind: 'deleted' }, { path: 'src/moved.yaml', kind: 'added', content: 'on: pull_request\n' }],
  'workflow로 옮김(도착)': [{ path: 'src/a.ts', kind: 'deleted' }, { path: '.github/workflows/moved.yaml', kind: 'added', content: 'export const a = 1;\n' }],
  'workflow mode만 변경': [{ path: WORKFLOW, kind: 'mode_changed', mode: '100755' }],
  '허용 경로 안의 깊은 .github': [{ path: 'src/.github/x.yaml', kind: 'added' }],
  '허용 경로 안의 AGENTS.md': [{ path: 'src/AGENTS.md', kind: 'added' }],
  '뿌리 AGENTS.md 수정': [{ path: 'AGENTS.md', kind: 'modified' }],
  '보호 파일 삭제 후 이름 변경': [{ path: 'AGENTS.md', kind: 'deleted' }, { path: 'docs/agents-copy.md', kind: 'added', content: '# 지침\n' }],
  '깊은 CLAUDE.md': [{ path: 'docs/x/CLAUDE.md', kind: 'added' }],
  '깊은 CODEOWNERS': [{ path: 'docs/CODEOWNERS', kind: 'added' }],
  '.gitmodules': [{ path: 'src/.gitmodules', kind: 'added' }],
  '.gitleaks 설정': [{ path: 'src/.gitleaks.toml', kind: 'added' }],
  '.pre-commit-config.yaml': [{ path: 'docs/.pre-commit-config.yaml', kind: 'added' }],
  '.env': [{ path: 'src/.env', kind: 'added' }],
  '.env.local': [{ path: 'src/.env.local', kind: 'added' }],
  '개인 키': [{ path: 'docs/id_ed25519', kind: 'added' }],
  'pem': [{ path: 'src/server.pem', kind: 'added' }],
  '.npmrc': [{ path: 'src/.npmrc', kind: 'added' }],
  '대소문자 우회 .GitHub': [{ path: 'src/.GitHub/x.yaml', kind: 'added' }],
  '대소문자 우회 agents.MD': [{ path: 'src/agents.MD', kind: 'added' }],
} satisfies Record<string, Change[]>)) {
  test(`T19 B3 정책 거부 protected_path: ${name}`, () => rejected(inspect(changes), 'protected_path'));
}

test('T19 B3 정책: 기존 보호 파일을 그대로 상속하는 것은 변경이 아니다', () => {
  assert.equal(inspect([{ path: 'src/a.ts', kind: 'modified' }]).ok, true);
});

test('T19 B3 정책: 허용 목록 밖과 glob의 경계', () => {
  rejected(inspect([{ path: 'package.json', kind: 'modified' }]), 'path_not_allowed');
  rejected(inspect([{ path: 'srcx/a.ts', kind: 'added' }]), 'path_not_allowed');
  rejected(inspect([{ path: 'lib/README.md', kind: 'added' }]), 'path_not_allowed');
  assert.equal(inspect([{ path: 'README.md', kind: 'modified' }]).ok, true);
  assert.equal(inspect([{ path: 'src/deep/deeper/x.ts', kind: 'added' }]).ok, true);
});

test('T19 B3 정책: 비거나 잘못된 정책은 닫힌다', () => {
  rejected(inspect([{ path: 'src/a.ts', kind: 'modified' }], { policies: [] }), 'policy_missing');
  for (const globs of [[], [''], ['**'], ['/src/**'], ['src/*'], ['src/**/x'], ['*.md'], ['src/../x'], ['{a,b}/**'], ['!src/**'], ['src/'], ['.github/**'], ['AGENTS.md']]) {
    assert.equal(compilePathPolicy(globs, []).ok, false, JSON.stringify(globs));
  }
  assert.equal(compilePathPolicy(['src/**'], ['src/*.ts']).ok, false);
});

test('T19 B3 정책: 교차 적용한다. 요청의 좁은 목록과 금지 목록이 저장소 목록을 넓히지 못한다', () => {
  const brief = compilePathPolicy(['src/deep/**', 'package.json'], ['src/deep/secret/**']);
  assert.equal(brief.ok, true);
  const policies = [smokePolicy(), (brief as { ok: true; policy: CompiledPathPolicy }).policy];
  assert.equal(inspect([{ path: 'src/deep/x.ts', kind: 'added' }], { policies }).ok, true);
  rejected(inspect([{ path: 'src/a.ts', kind: 'modified' }], { policies }), 'path_not_allowed');
  rejected(inspect([{ path: 'package.json', kind: 'modified' }], { policies }), 'path_not_allowed');
  rejected(inspect([{ path: 'src/deep/secret/x.ts', kind: 'added' }], { policies }), 'path_not_allowed');
  // 금지 목록은 대소문자·호환 문자로 비껴가지 못한다. 대소문자를 안 가리는 파일 시스템에서는 같은 파일이다.
  rejected(inspect([{ path: 'src/deep/SECRET/x.ts', kind: 'added' }], { policies }), 'path_not_allowed');
  rejected(inspect([{ path: 'src/deep/ｓｅｃｒｅｔ/x.ts', kind: 'added' }], { policies }), 'path_not_allowed');
  // 허용 목록은 그렇게 넓어지지 않는다.
  rejected(inspect([{ path: 'SRC/x.ts', kind: 'added' }]), 'path_not_allowed');
});

test('T19 B3 정책: 비정규 경로를 거부한다', () => {
  const problems: Record<string, string> = {
    '/etc/passwd': 'path_invalid', 'src/../x': 'path_invalid', 'src/./x': 'path_invalid', 'src//x': 'path_invalid', 'src\\x': 'path_invalid', 'src/x\0y': 'path_invalid',
    'src/.git/config': 'path_invalid', 'src/.GIT/config': 'path_invalid', '': 'path_invalid',
    'src/／x': 'path_noncanonical', 'src/．．/x': 'path_noncanonical', [`src/a${String.fromCodePoint(0x200b)}b`]: 'path_noncanonical', [`src/${String.fromCodePoint(0x202e)}x`]: 'path_noncanonical',
    'src/café': 'path_noncanonical', 'src/x.': 'path_noncanonical', 'src/x ': 'path_noncanonical',
  };
  for (const [path, reason] of Object.entries(problems)) assert.equal(pathProblem(path), reason, JSON.stringify(path));
  assert.equal(pathProblem('src/한글.ts'), null);
  rejected(inspect([{ path: 'src/／x.ts', kind: 'added' }]), 'path_noncanonical');
  assert.equal(isProtectedPath('src/．github/x'), true, 'NFKC 뒤에 보호 이름이면 보호다');
});

test('T19 B3 정책: 대소문자·정규화 충돌과 파일·디렉터리 충돌을 거부한다', () => {
  rejected(inspect([{ path: 'src/A.ts', kind: 'added' }]), 'path_collision');
  const base = baseOf();
  const { manifest, files } = candidate([{ path: 'src/new.ts', kind: 'added' }], base);
  const conflicted = { ...manifest, entries: manifest.entries.map(entry => entry.path === 'src/new.ts' ? { ...entry, path: 'src/a.ts/x' } : entry).sort((a, b) => compare(a.path, b.path)) };
  rejected(inspectCandidate({ base, manifest: conflicted, files, policies: [smokePolicy()] }), 'manifest_invalid');
  const swap = inspect([{ path: 'src/a.ts', kind: 'deleted' }, { path: 'src/a.ts/x', kind: 'added' }]);
  assert.equal(swap.ok, true, '지운 파일 자리를 디렉터리로 바꾸는 변경은 받는다');
  // 접으면 파일이 다른 파일의 상위 디렉터리가 되는 경우다. 대소문자를 안 가리는 파일 시스템에는 함께 받을 수 없다.
  rejected(inspect([{ path: 'src/A.ts/x.ts', kind: 'added' }]), 'path_collision');
  rejected(inspect([{ path: 'src/LIB', kind: 'added' }], { base: baseOf([...baseLeaves(), leaf('src/lib/x.ts', '1\n')]) }), 'path_collision');
  assert.equal(inspect([{ path: 'src/a.ts', kind: 'deleted' }, { path: 'src/A.ts/x.ts', kind: 'added' }]).ok, true, '지운 파일과는 충돌하지 않는다');
  // 입력 순서와 상관없이 같은 이름의 파일과 디렉터리는 한 tree에 있을 수 없다. 조용히 덮으면 그 아래 파일이 빠진 SHA가 나온다.
  const dirAndFile = [leaf('a/b', '1\n'), leaf('a', '2\n')];
  assert.throws(() => gitTreeSha(dirAndFile), /tree_file_directory_conflict/);
  assert.throws(() => gitTreeSha([...dirAndFile].reverse()), /tree_file_directory_conflict/);
  // 디렉터리 안 보호 파일을 파일 하나로 덮어 없애는 후보: 아래 파일이 unchanged면 충돌이고, deleted면 보호 판정에 걸린다.
  const guarded = baseOf([...baseLeaves(), leaf('src/x/AGENTS.md', '# 지침\n')]);
  rejected(inspect([{ path: 'src/x/AGENTS.md', kind: 'deleted' }, { path: 'src/x', kind: 'added' }], { base: guarded }), 'protected_path');
  const hidden = candidate([{ path: 'src/new.ts', kind: 'added' }], guarded);
  const covering = { ...hidden.manifest, entries: hidden.manifest.entries.map(entry => entry.path === 'src/new.ts' ? { ...entry, path: 'src/x' } : entry).sort((a, b) => compare(a.path, b.path)) };
  rejected(inspectCandidate({ base: guarded, manifest: covering, files: [], policies: [smokePolicy()] }), 'manifest_invalid');
});

test('T19 B3 정책: T0의 symlink·gitlink·특수 mode는 시작부터 닫힌다', () => {
  for (const mode of ['120000', '160000', '100664', '040000']) {
    const leaves = [...baseLeaves(), { path: 'src/link', mode, blobSha: gitBlobSha(text('x')) }];
    const base: BaseTreeSnapshot = { sha: 'd'.repeat(40), complete: true, leaves };
    const { manifest, files } = candidate([{ path: 'src/a.ts', kind: 'modified' }], baseOf());
    rejected(inspectCandidate({ base, manifest: { ...manifest, baseTree: base.sha }, files, policies: [smokePolicy()] }), 'base_special_mode');
  }
});

test('T19 B3 정책: 후보의 symlink·gitlink mode는 manifest에서 거부된다', () => {
  const base = baseOf();
  for (const mode of ['120000', '160000']) {
    const { manifest, files } = candidate([{ path: 'src/new.ts', kind: 'added' }], base);
    const forged = { ...manifest, entries: manifest.entries.map(entry => entry.path === 'src/new.ts' ? { ...entry, mode: mode as '100644' } : entry) };
    rejected(inspectCandidate({ base, manifest: forged, files, policies: [smokePolicy()] }), 'manifest_invalid');
  }
});

test('T19 B3 정책: 잘린 tree와 입증되지 않는 tree는 닫힌다', () => {
  const { manifest, files } = candidate([{ path: 'src/a.ts', kind: 'modified' }]);
  rejected(inspectCandidate({ base: { ...baseOf(), complete: false }, manifest, files, policies: [smokePolicy()] }), 'base_tree_incomplete');
  rejected(inspectCandidate({ base: { ...baseOf(), leaves: baseLeaves().slice(1) }, manifest, files, policies: [smokePolicy()] }), 'base_tree_unproven');
  rejected(inspectCandidate({ base: { ...baseOf(), sha: 'e'.repeat(40) }, manifest, files, policies: [smokePolicy()] }), 'base_tree_mismatch');
});

test('T19 B3 정책: manifest를 T0와 대조한다. 빠진 leaf를 삭제로 오인하지 않고 거짓 kind를 받지 않는다', () => {
  const base = baseOf();
  const { manifest, files } = candidate([{ path: 'src/a.ts', kind: 'modified' }], base);
  const without = (path: string) => manifest.entries.filter(entry => entry.path !== path);
  rejected(inspectCandidate({ base, manifest: { ...manifest, entries: without('package.json') }, files, policies: [smokePolicy()] }), 'manifest_missing_base_leaf');
  const edit = (path: string, patch: Partial<ArtifactManifest['entries'][number]>) => ({ ...manifest, entries: manifest.entries.map(entry => entry.path === path ? { ...entry, ...patch } : entry) });
  // 몰래 바꾼 파일을 unchanged로 신고한다. 보호 파일이어도 changed로 잡혀야 한다.
  rejected(inspectCandidate({ base, manifest: edit('AGENTS.md', { blobSha: gitBlobSha(text('변조')) }), files, policies: [smokePolicy()] }), 'manifest_base_mismatch');
  rejected(inspectCandidate({ base, manifest: edit('AGENTS.md', { mode: '100755' }), files, policies: [smokePolicy()] }), 'manifest_base_mismatch');
  rejected(inspectCandidate({ base, manifest: edit('src/a.ts', { changeKind: 'added' }), files, policies: [smokePolicy()] }), 'manifest_base_mismatch');
  rejected(inspectCandidate({ base, manifest: edit('README.md', { changeKind: 'mode_changed' }), files, policies: [smokePolicy()] }), 'manifest_base_mismatch');
  rejected(inspectCandidate({ base, manifest: edit('README.md', { changeKind: 'deleted', blobSha: gitBlobSha(text('다른')) }), files, policies: [smokePolicy()] }), 'manifest_base_mismatch');
  rejected(inspectCandidate({ base, manifest: { ...manifest, resultTree: 'f'.repeat(40) }, files, policies: [smokePolicy()] }), 'result_tree_mismatch');
});

test('T19 B3 정책: 바이트가 manifest와 다르거나 텍스트가 아니면 닫힌다', () => {
  const base = baseOf();
  const { manifest, files } = candidate([{ path: 'src/a.ts', kind: 'modified' }], base);
  rejected(inspectCandidate({ base, manifest, files: [], policies: [smokePolicy()] }), 'file_missing');
  rejected(inspectCandidate({ base, manifest, files: [{ path: 'src/a.ts', content: text('다른 내용') }], policies: [smokePolicy()] }), 'content_mismatch');
  const binary = Buffer.from([0x00, 0xff, 0x01]);
  const entries = manifest.entries.map(entry => entry.path === 'src/a.ts' ? { ...entry, blobSha: gitBlobSha(binary), sha256: sha256Hex(binary), size: binary.byteLength } : entry);
  const resultTree = gitTreeSha(entries.map(entry => ({ path: entry.path, mode: entry.mode, blobSha: entry.blobSha })));
  rejected(inspectCandidate({ base, manifest: { ...manifest, entries, resultTree }, files: [{ path: 'src/a.ts', content: binary }], policies: [smokePolicy()] }), 'binary_content');
});

test('T19 B3 정책: 작업 정책 prefix는 한 곳에서 컴파일하고 가장 좁게 내린다', () => {
  assert.deepEqual(taskPathRules(smokePolicy()), {
    allowedPaths: ['src', 'tests', 'docs', 'README.md'],
    forbiddenPaths: COMMON_DENY_SUMMARY,
  });
  assert.ok(COMMON_DENY_SUMMARY.includes('.github'));
  assert.ok(COMMON_DENY_SUMMARY.includes('AGENTS.md'));
});

const git = (cwd: string, args: string[], input?: string, env: NodeJS.ProcessEnv = {}) => execFileSync('git', args, {
  cwd, encoding: 'utf8', ...(input === undefined ? {} : { input }),
  env: { PATH: process.env.PATH, HOME: cwd, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null', ...env }, stdio: ['pipe', 'pipe', 'pipe'],
}).trim();

test('T19 B3 정책: blob·tree·commit SHA 계산이 로컬 git과 같다', { skip: spawnableGit() ? false : 'git 없음' }, () => {
  const root = mkdtempSync(join(tmpdir(), 't19-b3-git-'));
  try {
    git(root, ['init', '-q', '.']);
    // 정렬 함정을 넣는다. git은 디렉터리를 `이름/`로 비교하므로 a.b < a/ < a0 순서가 된다.
    const contents: Record<string, string> = { 'a.b': '1\n', 'a/x': '2\n', 'a/y/z.ts': '3\n', 'a0': '4\n', 'b': '5\n', 'run.sh': '#!/bin/sh\n', '한글/파일.md': '6\n' };
    const modes: Record<string, string> = { 'run.sh': '100755' };
    const leaves: BaseLeaf[] = [];
    for (const [path, content] of Object.entries(contents)) {
      const file = join(root, 'blob-input');
      writeFileSync(file, content);
      const blob = git(root, ['hash-object', '-w', file]);
      assert.equal(blob, gitBlobSha(text(content)));
      leaves.push({ path, mode: modes[path] ?? '100644', blobSha: blob });
    }
    const indexInput = leaves.map(item => `${item.mode} ${item.blobSha}\t${item.path}`).join('\n');
    git(root, ['update-index', '--add', '-z', '--index-info'], `${indexInput.replaceAll('\n', '\0')}\0`);
    const tree = git(root, ['write-tree']);
    assert.equal(gitTreeSha(leaves), tree);
    // 삭제 뒤 tree, 순서를 바꾼 입력도 같아야 한다.
    assert.equal(gitTreeSha([...leaves].reverse()), tree);

    const identity = { name: 'fixture-writer[bot]', email: 'fixture-writer[bot]@users.noreply.github.com', date: '2026-01-02T03:04:05Z' };
    const message = '고정 제목\n\n본문\n';
    const env = {
      GIT_AUTHOR_NAME: identity.name, GIT_AUTHOR_EMAIL: identity.email, GIT_AUTHOR_DATE: '2026-01-02T03:04:05Z',
      GIT_COMMITTER_NAME: identity.name, GIT_COMMITTER_EMAIL: identity.email, GIT_COMMITTER_DATE: '2026-01-02T03:04:05Z', TZ: 'UTC',
    };
    const root0 = git(root, ['commit-tree', tree], message, env);
    assert.equal(gitCommitSha({ treeSha: tree, parents: [], message, author: identity, committer: identity }), root0);
    const child = git(root, ['commit-tree', tree, '-p', root0], message, env);
    assert.equal(gitCommitSha({ treeSha: tree, parents: [root0], message, author: identity, committer: identity }), child);
    assert.equal(git(root, ['rev-parse', `${child}^{tree}`]), tree);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
function spawnableGit() { try { execFileSync('git', ['--version'], { stdio: 'ignore' }); return true; } catch { return false; } }

test('T19 B3 정책: 내용 변경이 manifest digest를 바꾼다(artifact 재사용 불가)', () => {
  const { manifest } = candidate([{ path: 'src/a.ts', kind: 'modified', content: '하나\n' }]);
  const other = candidate([{ path: 'src/a.ts', kind: 'modified', content: '둘\n' }]).manifest;
  assert.notEqual(artifactDigest(manifest), artifactDigest(other));
});
