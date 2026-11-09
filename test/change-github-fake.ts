import assert from 'node:assert/strict';
import { generateKeyPairSync } from 'node:crypto';
import { changeBranchName, gitBlobSha, sha256Hex } from '../src/change-contracts.js';
import type { ArtifactFile, ArtifactManifest, ChangeBrief, ChangeKey, ChangeTarget, ManifestChangeKind, ReviewReceipt } from '../src/change-contracts.js';
import { evaluateCi } from '../src/change-ci-policy.js';
import { ChangeRepositoryPolicySchema, gitCommitSha, gitTreeSha } from '../src/change-policy.js';
import type { BaseLeaf, ChangeRepositoryPolicy } from '../src/change-policy.js';
import { ChangePublisher } from '../src/change-publisher.js';
import { ChangeStore } from '../src/change-store.js';
import type { Database } from '../src/database.js';
import { createGitHubWriter, policyWriterRepositories } from '../src/github-writer.js';
import { CONVERSATION, OWNER, fixtureReview, fixtureVerification, hex, insertChildJob, newEvent, ok, seedConversation } from './change-store-fixture.js';

// GitHub 흉내. 객체를 실제 git 형식 SHA로 저장해 게시자가 미리 계산한 값과 대조된다. 키·토큰·ID는 모두 합성이다.
export const { privateKey: FAKE_APP_KEY } = generateKeyPairSync('rsa', { modulusLength: 2048 });
export const REPO = { id: 4242, fullName: 'fixture-org/fixture-repo', installationId: 900 };
export const BOT_USER = 777;
export const API = 'https://api.github.com';
const USES = 'fixture-org/fixture-platform/.github/workflows/app-build.yaml@app-build-v1.0.1';
const REUSABLE = `name: app-build\non:\n  workflow_call:\njobs:\n  build:\n    runs-on: ubuntu-latest\n    steps:\n      - run: echo ok\n`;
const CALLER = `name: build\non:\n  pull_request:\n  push:\n    branches: [main]\njobs:\n  build:\n    uses: ${USES}\n`;
export const FIXTURE_TIME = Date.UTC(2026, 0, 2, 3, 4, 5);

export interface Sent { method: string; path: string; authorization: string; body: unknown; init: RequestInit }
export type FaultMode = 'lose_response' | 'reset_before_apply' | 'refused' | 'rate_limited' | 'invalid_json' | 'oversize' | { status: number; headers?: Record<string, string> };
interface Fault { match: RegExp; mode: FaultMode; remaining: number }
export interface TokenIssue { permissions: Record<string, string>; repositoryIds: number[]; token: string }
interface FakePull { number: number; state: 'open' | 'closed'; merged_at: string | null; title: string; body: string | null; draft: boolean; user: { id: number }; head: { ref: string; sha: string; repo: { id: number } }; base: { ref: string; repo: { id: number } } }
interface TreeEntry { path: string; mode: string; type: 'blob' | 'tree' | 'commit'; sha: string }
const error = (code: string) => Object.assign(new TypeError('fetch failed'), { cause: { code } });
const json = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status, headers: { 'content-type': 'application/json' } });

export class FakeGitHub {
  sent: Sent[] = [];
  issued: TokenIssue[] = [];
  clock = FIXTURE_TIME;
  blobs = new Map<string, Buffer>();
  trees = new Map<string, TreeEntry[]>();
  commits = new Map<string, { tree: string; parents: string[] }>();
  refs = new Map<string, string>();
  pulls: FakePull[] = [];
  pinned = new Map<string, string>();
  faults: Fault[] = [];
  truncated = new Set<string>();
  tokenOverride: ((body: { repository_ids: number[]; permissions: Record<string, string> }) => Response) | undefined;
  repoFullName = REPO.fullName;
  private tokens = new Map<string, Record<string, string>>();
  private nextNumber = 41;

  fail(match: RegExp, mode: FaultMode, remaining = 1) { this.faults.push({ match, mode, remaining }); }
  mutations(pattern?: RegExp) { return this.sent.filter(item => item.method !== 'GET' && !item.path.startsWith('/app/') && (!pattern || pattern.test(`${item.method} ${item.path}`))); }
  count(pattern: RegExp) { return this.sent.filter(item => pattern.test(`${item.method} ${item.path}`)).length; }
  get tokenPosts() { return this.count(/access_tokens/); }

  addBlob(content: Buffer) { const sha = gitBlobSha(content); this.blobs.set(sha, content); return sha; }
  // 잎 목록으로 tree 객체를 모두 저장하고 뿌리 SHA를 돌려준다.
  storeTree(leaves: BaseLeaf[]): string {
    const here = new Map<string, TreeEntry>();
    const children = new Map<string, BaseLeaf[]>();
    for (const leaf of leaves) {
      const slash = leaf.path.indexOf('/');
      if (slash < 0) { here.set(leaf.path, { path: leaf.path, mode: leaf.mode, type: leaf.mode === '160000' ? 'commit' : 'blob', sha: leaf.blobSha }); continue; }
      const name = leaf.path.slice(0, slash);
      children.set(name, [...(children.get(name) ?? []), { ...leaf, path: leaf.path.slice(slash + 1) }]);
    }
    for (const [name, sub] of children) here.set(name, { path: name, mode: '040000', type: 'tree', sha: this.storeTree(sub) });
    const sha = gitTreeSha(leaves);
    this.trees.set(sha, [...here.values()]);
    return sha;
  }
  flatten(sha: string, prefix = ''): TreeEntry[] {
    const entries = this.trees.get(sha);
    if (!entries) return [];
    return entries.flatMap(entry => {
      const path = `${prefix}${entry.path}`;
      return entry.type === 'tree' ? [{ ...entry, path }, ...this.flatten(entry.sha, `${path}/`)] : [{ ...entry, path }];
    });
  }
  leaves(treeSha: string): BaseLeaf[] { return this.flatten(treeSha).filter(entry => entry.type !== 'tree').map(entry => ({ path: entry.path, mode: entry.mode, blobSha: entry.sha })); }
  commitFiles(files: Record<string, string>, parents: string[] = [], modes: Record<string, string> = {}) {
    const leaves = Object.entries(files).map(([path, content]) => ({ path, mode: modes[path] ?? '100644', blobSha: this.addBlob(Buffer.from(content)) }));
    const tree = this.storeTree(leaves);
    const identity = { name: 'fixture-human', email: 'fixture-human@users.noreply.github.com', date: '2025-01-01T00:00:00Z' };
    const sha = gitCommitSha({ treeSha: tree, parents, message: `시드 ${tree}\n`, author: identity, committer: identity });
    this.commits.set(sha, { tree, parents });
    return { sha, tree, leaves };
  }
  // base를 사람 commit으로 옮긴다.
  moveBase(branch = 'main') {
    const head = this.refs.get(`heads/${branch}`)!;
    const moved = this.commitFiles({ ...Object.fromEntries(this.leaves(this.commits.get(head)!.tree).map(leaf => [leaf.path, this.blobs.get(leaf.blobSha)!.toString()])), 'later.txt': `${head}\n` }, [head]);
    this.refs.set(`heads/${branch}`, moved.sha);
    return moved.sha;
  }

  readonly send: typeof fetch = async (input, init = {}) => {
    const url = new URL(String(input));
    assert.equal(url.origin, API);
    const authorization = new Headers(init.headers).get('authorization') ?? '';
    const sent: Sent = { method: init.method ?? 'GET', path: `${url.pathname}${url.search}`, authorization, body: typeof init.body === 'string' ? JSON.parse(init.body) : undefined, init };
    this.sent.push(sent);
    const fault = this.faults.find(item => item.remaining > 0 && item.match.test(`${sent.method} ${sent.path}`));
    if (fault) fault.remaining--;
    const mode = fault?.mode;
    if (mode === 'reset_before_apply') throw error('ECONNRESET');
    if (mode === 'refused') throw error('ECONNREFUSED');
    if (mode === 'rate_limited') return new Response('{}', { status: 403, headers: { 'x-ratelimit-remaining': '0', 'x-ratelimit-reset': String(Math.floor(this.clock / 1000) + 60) } });
    if (mode && typeof mode === 'object') return new Response('{}', { status: mode.status, headers: mode.headers ?? {} });
    if (sent.path.includes('/git/') || sent.path.includes('/pulls') || sent.path.includes('/contents/') || sent.path.includes('/app/')) {
      const response = this.route(sent);
      if (mode === 'lose_response') throw error('ECONNRESET');
      if (mode === 'invalid_json') return new Response('<html>', { status: response.status });
      if (mode === 'oversize') return new Response('x'.repeat(32 * 1024 * 1024), { status: response.status });
      return response;
    }
    return new Response('{}', { status: 404 });
  };

  private hasPermission(sent: Sent, name: string, level: string) {
    const token = sent.authorization.replace(/^Bearer /, '');
    return this.tokens.get(token)?.[name] === level;
  }
  private route(sent: Sent): Response {
    const { method, path, body } = sent;
    const repo = `/repos/${this.repoFullName}`;
    const object = body as Record<string, any>;
    if (method === 'POST' && /^\/app\/installations\/\d+\/access_tokens$/.test(path)) {
      assert.match(sent.authorization, /^Bearer eyJ/);
      if (this.tokenOverride) return this.tokenOverride(object as never);
      const token = `ghs_fixture${this.issued.length + 1}`;
      this.issued.push({ permissions: object.permissions, repositoryIds: object.repository_ids, token });
      this.tokens.set(token, object.permissions);
      return json({ token, expires_at: new Date(this.clock + 3_600_000).toISOString(), permissions: { ...object.permissions, metadata: 'read' },
        repositories: [{ id: object.repository_ids[0], full_name: this.repoFullName }] }, 201);
    }
    const pinned = /^\/repos\/(fixture-org\/fixture-platform)\/contents\/(\.github\/workflows\/[^?]+)\?ref=(.+)$/.exec(path);
    if (method === 'GET' && pinned) {
      const text = this.pinned.get(`${pinned[1]}/${pinned[2]}@${pinned[3]}`);
      if (text === undefined) return new Response('{}', { status: 404 });
      return json({ type: 'file', encoding: 'base64', sha: gitBlobSha(Buffer.from(text)), path: pinned[2], content: Buffer.from(text).toString('base64') });
    }
    if (!path.startsWith(`${repo}/`)) return new Response('{}', { status: 404 });
    const rest = path.slice(repo.length);
    if (method === 'POST') {
      if (rest === '/pulls') {
        if (!this.hasPermission(sent, 'pull_requests', 'write')) return new Response('{}', { status: 403 });
        return this.createPull(object);
      }
      if (!this.hasPermission(sent, 'contents', 'write')) return new Response('{}', { status: 403 });
      if (rest === '/git/blobs') {
        const sha = this.addBlob(Buffer.from(object.content, object.encoding));
        return json({ sha, url: `${API}${repo}/git/blobs/${sha}` }, 201);
      }
      if (rest === '/git/trees') return this.createTree(object);
      if (rest === '/git/commits') {
        const sha = gitCommitSha({ treeSha: object.tree, parents: object.parents, message: object.message, author: object.author, committer: object.committer });
        this.commits.set(sha, { tree: object.tree, parents: object.parents });
        return json({ sha, tree: { sha: object.tree }, parents: object.parents.map((parent: string) => ({ sha: parent })) }, 201);
      }
      if (rest === '/git/refs') {
        const name = String(object.ref).replace(/^refs\//, '');
        if (this.refs.has(name)) return json({ message: 'Reference already exists' }, 422);
        if (!this.commits.has(object.sha)) return json({ message: 'Object does not exist' }, 422);
        this.refs.set(name, object.sha);
        return json({ ref: object.ref, object: { type: 'commit', sha: object.sha } }, 201);
      }
      return new Response('{}', { status: 404 });
    }
    const update = /^\/git\/refs\/(heads\/.+)$/.exec(rest);
    if (method === 'PATCH' && update) {
      if (!this.hasPermission(sent, 'contents', 'write')) return new Response('{}', { status: 403 });
      const name = update[1]!;
      const current = this.refs.get(name);
      if (!current) return json({ message: 'Reference does not exist' }, 422);
      if (!this.commits.has(object.sha)) return json({ message: 'Object does not exist' }, 422);
      if (object.force !== true && !this.descends(object.sha, current)) return json({ message: 'Update is not a fast forward' }, 422);
      this.refs.set(name, object.sha);
      return json({ ref: `refs/${name}`, object: { type: 'commit', sha: object.sha } });
    }
    if (method !== 'GET') return new Response('{}', { status: 405 });
    const ref = /^\/git\/ref\/(.+)$/.exec(rest);
    if (ref) {
      const sha = this.refs.get(ref[1]!);
      return sha ? json({ ref: `refs/${ref[1]}`, object: { type: 'commit', sha } }) : new Response('{}', { status: 404 });
    }
    const commit = /^\/git\/commits\/([0-9a-f]{40})$/.exec(rest);
    if (commit) {
      const found = this.commits.get(commit[1]!);
      return found ? json({ sha: commit[1], tree: { sha: found.tree }, parents: found.parents.map(sha => ({ sha })) }) : new Response('{}', { status: 404 });
    }
    const blob = /^\/git\/blobs\/([0-9a-f]{40})$/.exec(rest);
    if (blob) {
      const found = this.blobs.get(blob[1]!);
      return found ? json({ sha: blob[1], size: found.byteLength, encoding: 'base64', content: found.toString('base64') }) : new Response('{}', { status: 404 });
    }
    const tree = /^\/git\/trees\/([0-9a-f]{40})(\?recursive=1)?$/.exec(rest);
    if (tree) {
      const sha = tree[1]!;
      if (!this.trees.has(sha)) return new Response('{}', { status: 404 });
      if (tree[2]) {
        if (this.truncated.has(sha)) return json({ sha, truncated: true, tree: this.trees.get(sha)!.slice(0, 1) });
        return json({ sha, truncated: false, tree: this.flatten(sha) });
      }
      return json({ sha, truncated: this.truncated.has(`${sha}:flat`), tree: this.trees.get(sha) });
    }
    const list = /^\/pulls\?state=all&head=([^&]+)&base=([^&]+)&per_page=100$/.exec(rest);
    if (list) {
      const branch = list[1]!.slice(list[1]!.indexOf(':') + 1);
      return json(this.pulls.filter(pull => pull.head.ref === branch && pull.base.ref === list[2]));
    }
    return new Response('{}', { status: 404 });
  }
  private descends(sha: string, ancestor: string): boolean {
    const queue = [sha];
    for (const seen = new Set<string>(); queue.length;) {
      const next = queue.shift()!;
      if (next === ancestor) return true;
      if (seen.has(next)) continue;
      seen.add(next);
      queue.push(...(this.commits.get(next)?.parents ?? []));
    }
    return false;
  }
  private createTree(object: Record<string, any>): Response {
    if (!this.trees.has(object.base_tree)) return json({ message: 'base_tree' }, 422);
    const leaves = new Map(this.leaves(object.base_tree).map(leaf => [leaf.path, leaf]));
    for (const entry of object.tree as { path: string; mode: string; sha: string | null }[]) {
      if (entry.sha === null) {
        if (!leaves.delete(entry.path)) return json({ message: 'missing path' }, 422);
        continue;
      }
      if (!this.blobs.has(entry.sha)) return json({ message: 'missing blob' }, 422);
      for (const existing of [...leaves.keys()]) if (entry.path.startsWith(`${existing}/`) || existing.startsWith(`${entry.path}/`)) leaves.delete(existing);
      leaves.set(entry.path, { path: entry.path, mode: entry.mode, blobSha: entry.sha });
    }
    const sha = this.storeTree([...leaves.values()]);
    return json({ sha, truncated: false, tree: this.trees.get(sha) }, 201);
  }
  addPull(values: Partial<FakePull> & { head: FakePull['head']; base: FakePull['base'] }) {
    const pull: FakePull = { number: this.nextNumber++, state: 'open', merged_at: null, title: '', body: '', draft: false, user: { id: BOT_USER }, ...values };
    this.pulls.push(pull);
    return pull;
  }
  private createPull(object: Record<string, any>): Response {
    const sha = this.refs.get(`heads/${object.head}`);
    if (!sha) return json({ message: 'head missing' }, 422);
    if (this.pulls.some(pull => pull.head.ref === object.head && pull.base.ref === object.base && pull.state === 'open')) return json({ message: 'exists' }, 422);
    return json(this.addPull({ title: object.title, body: object.body, draft: object.draft, head: { ref: object.head, sha, repo: { id: REPO.id } }, base: { ref: object.base, repo: { id: REPO.id } } }), 201);
  }
}

export function repositoryPolicy(overrides: Partial<ChangeRepositoryPolicy> = {}): ChangeRepositoryPolicy {
  return ChangeRepositoryPolicySchema.parse({
    repoId: REPO.id, fullName: REPO.fullName, installationId: REPO.installationId, revision: 'fixture-policy-1', baseBranches: ['main'],
    allowedPaths: ['src/**', 'tests/**', 'docs/**', 'README.md'], deniedPaths: [], requiredCommands: ['smoke-unit'], writerAccepted: true, writerBotUserId: BOT_USER,
    identity: { name: 'fixture-writer[bot]', email: 'fixture-writer[bot]@users.noreply.github.com' }, internalMarkers: ['fixture-corp-host'],
    ci: { approvedFingerprint: 'f'.repeat(64), reusable: [{ uses: USES, blobSha: gitBlobSha(Buffer.from(REUSABLE)) }], pushBranches: ['main'] }, ...overrides,
  });
}
export const FIXTURE_BASE_FILES: Record<string, string> = {
  '.github/workflows/build.yaml': CALLER, 'AGENTS.md': '# 지침\n', 'README.md': '# 읽어보기\n', 'package.json': '{}\n', 'src/a.ts': 'export const a = 1;\n', 'tests/a.test.ts': 'test\n',
};
export interface FileChange { path: string; content?: string; kind: Extract<ManifestChangeKind, 'added' | 'modified' | 'deleted' | 'mode_changed'>; mode?: '100644' | '100755' }
export const DEFAULT_CHANGES: FileChange[] = [{ path: 'src/a.ts', kind: 'modified', content: 'export const a = 2;\n' }, { path: 'src/new.ts', kind: 'added', content: 'export const n = 1;\n' }];

export function buildCandidate(leaves: BaseLeaf[], baseCommit: string, baseTree: string, changes: FileChange[]): { manifest: ArtifactManifest; files: ArtifactFile[]; patch: string } {
  const patch = '--- 합성 표시용 patch\n';
  const byPath = new Map(changes.map(change => [change.path, change]));
  const entries: ArtifactManifest['entries'] = [];
  const files: ArtifactFile[] = [];
  for (const old of leaves) if (!byPath.has(old.path)) entries.push({ path: old.path, mode: old.mode as '100644', changeKind: 'unchanged', blobSha: old.blobSha, sha256: hex(old.path), size: 1 });
  for (const change of changes) {
    const old = leaves.find(leaf => leaf.path === change.path);
    if (change.kind === 'deleted' || change.kind === 'mode_changed') {
      entries.push({ path: change.path, mode: change.mode ?? (old?.mode as '100644'), changeKind: change.kind, blobSha: old!.blobSha, sha256: hex(change.path), size: 1 });
      continue;
    }
    const content = Buffer.from(change.content ?? '내용\n');
    entries.push({ path: change.path, mode: change.mode ?? '100644', changeKind: change.kind, blobSha: gitBlobSha(content), sha256: sha256Hex(content), size: content.byteLength });
    files.push({ path: change.path, content });
  }
  entries.sort((a, b) => Buffer.compare(Buffer.from(a.path), Buffer.from(b.path)));
  const resultTree = gitTreeSha(entries.filter(entry => entry.changeKind !== 'deleted').map(entry => ({ path: entry.path, mode: entry.mode, blobSha: entry.blobSha })));
  return { manifest: { version: 1, baseCommit, baseTree, resultTree, patchSha256: sha256Hex(Buffer.from(patch)), entries }, files, patch };
}

export interface PublishEnv {
  db: Database; store: ChangeStore; github: FakeGitHub; clock: { now: number };
  policy: { current: ChangeRepositoryPolicy | null };
  publisher: ChangePublisher; newPublisher: () => ChangePublisher;
  base: { sha: string; tree: string; leaves: BaseLeaf[] };
  writerIO: ReturnType<typeof createGitHubWriter>;
  // 쓰기 직전 권한 확인의 대역. 기본은 통과이고 시험이 check를 바꿔 끼운다.
  writeGuard: { check: (target: ChangeTarget) => Promise<void> };
  approve: (changes?: FileChange[], overrides?: { brief?: Partial<ChangeBrief> }) => Promise<ChangeKey>;
  // 현재 generation을 admit부터 approve 직전(reviewing)까지 민다.
  driveToReview: (key: ChangeKey, changes: FileChange[], overrides?: { brief?: Partial<ChangeBrief> }) => Promise<ReviewReceipt>;
  newRequest: () => Promise<ChangeKey>;
}
// db는 호출자가 만든다(PGlite·실제 PostgreSQL). 시드 base와 승인 직전까지 가는 도구를 돌려준다.
export async function publishEnv(db: Database, options: { files?: Record<string, string>; modes?: Record<string, string> } = {}): Promise<PublishEnv> {
  await seedConversation(db);
  const clock = { now: FIXTURE_TIME };
  const github = new FakeGitHub();
  github.pinned.set(USES, REUSABLE);
  const base = github.commitFiles(options.files ?? FIXTURE_BASE_FILES, [], options.modes ?? {});
  github.refs.set('heads/main', base.sha);
  const store = new ChangeStore(db, () => clock.now);
  const policy: { current: ChangeRepositoryPolicy | null } = { current: repositoryPolicy() };
  const first = evaluateCi({
    files: [{ path: '.github/workflows/build.yaml', mode: '100644', blobSha: gitBlobSha(Buffer.from(CALLER)) }],
    workflows: [{ path: '.github/workflows/build.yaml', blobSha: gitBlobSha(Buffer.from(CALLER)), text: CALLER }],
    reusable: [{ uses: USES, blobSha: gitBlobSha(Buffer.from(REUSABLE)), text: REUSABLE }],
  }, policy.current!.ci);
  const fingerprint = (first as { fingerprint: string }).fingerprint;
  assert.ok(fingerprint);
  policy.current = repositoryPolicy({ ci: { ...policy.current!.ci, approvedFingerprint: fingerprint } });
  const source = async () => policy.current;
  const syncedNow = () => { github.clock = clock.now; return clock.now; };
  const writeGuard: PublishEnv['writeGuard'] = { check: async () => {} };
  const writerIO = createGitHubWriter({ app: { appId: '12345', privateKey: FAKE_APP_KEY }, repositories: policyWriterRepositories(source), authorizeWrite: target => writeGuard.check(target), send: github.send, now: syncedNow });
  const newPublisher = () => new ChangePublisher({ store, writer: writerIO.writer, preflight: writerIO.preflight, policy: source, authorize: async () => {}, now: () => clock.now, retryMs: 60_000 });
  const newRequest = async () => {
    const request = ok(await store.createRequest({ eventId: newEvent(), ownerId: OWNER, conversationId: CONVERSATION, scope: { guild: 'fixture-guild', channel: 'fixture-thread', parent: 'fixture-chat', kind: 'thread' },
      repoId: REPO.id, baseBranch: 'main', label: 'public', input: { text: '공개 요청문' } }));
    return { changeId: request.id, generation: request.generation };
  };
  const driveToReview: PublishEnv['driveToReview'] = async (key, changes, overrides = {}) => {
    const current = policy.current!;
    const head = github.refs.get('heads/main')!;
    const tree = github.commits.get(head)!.tree;
    const brief: ChangeBrief = { summary: '공개 제목', goal: '공개 목표', acceptanceCriteria: ['시험 통과'], repoId: REPO.id, baseBranch: 'main', allowedPaths: ['src/**', 'tests/**', 'docs/**', 'README.md'], deniedPaths: [], verificationCommandIds: ['smoke-unit'], label: 'public', ...overrides.brief };
    ok(await store.admit({ ...key, brief, policyRevision: current.revision }));
    ok(await store.pinBase({ ...key, baseCommit: head, baseTree: tree }));
    const { manifest, files, patch } = buildCandidate(github.leaves(tree), head, tree, changes);
    ok(await store.recordSnapshot({ ...key, manifest, files, patch, transportBytes: 4096 }));
    const bundle = ok(await store.startVerification({ ...key, verifierRevision: 'fixture-verifier-1' }));
    ok(await store.recordVerification({ ...key, receipt: fixtureVerification({ bundle }) }));
    ok(await store.finishVerification(key));
    const jobId = `fixture-review-${key.changeId}-${key.generation}`;
    await insertChildJob(db, jobId);
    ok(await store.linkChildJob({ ...key, jobId, role: 'review' }));
    const receipt = fixtureReview({ bundle, jobId });
    ok(await store.recordReview({ ...key, receipt }));
    return receipt;
  };
  const publisher = newPublisher();
  const approveKey = async (key: ChangeKey, changes: FileChange[], overrides: { brief?: Partial<ChangeBrief> } = {}) => {
    const review = await driveToReview(key, changes, overrides);
    const prepared = await publisher.prepareApproval(key, { review, at: FIXTURE_TIME });
    if (!prepared.ok) throw new Error(prepared.reason);
    ok(await store.approve({ ...key, approvalDigest: prepared.digest, eventId: newEvent(), actor: OWNER }));
    return key;
  };
  approveKeyFor.set(store, approveKey);
  const approve: PublishEnv['approve'] = async (changes = DEFAULT_CHANGES, overrides = {}) => approveKey(await newRequest(), changes, overrides);
  return { db, store, github, clock, policy, publisher, newPublisher, base, writerIO, writeGuard, approve, driveToReview, newRequest };
}
const approveKeyFor = new WeakMap<ChangeStore, (key: ChangeKey, changes: FileChange[]) => Promise<ChangeKey>>();
// 새 generation도 같은 경로로 민다.
export async function reapprove(env: PublishEnv, key: ChangeKey, changes: FileChange[] = DEFAULT_CHANGES): Promise<ChangeKey> {
  const next = ok(await env.store.startNextGeneration(key));
  return approveKeyFor.get(env.store)!({ changeId: next.id, generation: next.generation }, changes);
}
export const branchOf = (key: ChangeKey) => changeBranchName(key.changeId, key.generation);
