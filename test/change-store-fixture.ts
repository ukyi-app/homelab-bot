import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import {
  ApprovalSubjectSchema, EffectExpectedSchema, artifactDigest, changeBranchName, gitBlobSha, sha256Hex,
} from '../src/change-contracts.js';
import type {
  ApprovalSubject, ArtifactFile, ArtifactManifest, ChangeBrief, ChangePhase, EffectExpected, EffectResult, EffectStage, EvidenceBundle, PublicMetadata, ReviewReceipt,
  VerificationReceipt,
} from '../src/change-contracts.js';
import type { ChangeRequest, ChangeStore, StoreResult } from '../src/change-store.js';
import type { Database } from '../src/database.js';

// 값은 모두 합성이다. 같은 씨앗이면 같은 SHA가 나와 시험끼리 대조할 수 있다.
export const git = (seed: string) => createHash('sha1').update(`fixture:${seed}`).digest('hex');
export const hex = (seed: string) => createHash('sha256').update(`fixture:${seed}`).digest('hex');
export const OWNER = 'fixture-owner';
export const CONVERSATION = 'fixture-conversation';
export const REPO_ID = 4242;
export const COMMAND = 'smoke-unit';
const CONTENT = Buffer.from('export const value = 1;\n');
const PATCH = Buffer.from('--- a/src/new.ts\n+++ b/src/new.ts\n');

export function fixtureManifestFiles(): ArtifactFile[] { return [{ path: 'src/new.ts', content: CONTENT }]; }
export function fixtureManifest(): ArtifactManifest {
  return {
    version: 1, baseCommit: git('b'), baseTree: git('t0'), resultTree: git('t1'), patchSha256: sha256Hex(PATCH),
    entries: [
      { path: 'README.md', mode: '100644', changeKind: 'unchanged', blobSha: git('readme'), sha256: hex('readme'), size: 12 },
      { path: 'src/new.ts', mode: '100644', changeKind: 'added', blobSha: gitBlobSha(CONTENT), sha256: sha256Hex(CONTENT), size: CONTENT.byteLength },
    ],
  };
}
export const fixturePatch = () => PATCH.toString('utf8');
export function fixtureBundle(overrides: Partial<EvidenceBundle> = {}): EvidenceBundle {
  return { repoId: REPO_ID, generation: 1, baseCommit: git('b'), baseTree: git('t0'), resultTree: git('t1'), artifactDigest: artifactDigest(fixtureManifest()),
    policyRevision: 'fixture-policy-1', verifierRevision: 'fixture-verifier-1', ...overrides };
}
export function fixtureMetadata(): PublicMetadata {
  const identity = { name: 'fixture-writer[bot]', email: 'fixture-writer[bot]@users.noreply.github.com', date: '2026-01-02T03:04:05Z' };
  return { title: '고정 제목', body: '고정 본문', commitMessage: '고정 커밋 메시지', author: identity, committer: identity, draft: false };
}
export function fixtureVerification(overrides: Partial<VerificationReceipt> = {}): VerificationReceipt {
  return { runId: 'fixture-run-1', commandId: COMMAND, runnerRevision: 'fixture-runner-1', imageRevision: 'fixture-image-1', bundle: fixtureBundle(),
    exitCode: 0, timedOut: false, logDigest: hex('log'), status: 'passed', ...overrides };
}
export function fixtureReview(overrides: Partial<ReviewReceipt> = {}): ReviewReceipt {
  return { instructionRevision: 'fixture-instructions-1', sessionId: '11111111-1111-4111-8111-111111111111', jobId: 'fixture-review-job', bundle: fixtureBundle(),
    coverage: 'complete', verdict: 'pass', risks: [], findingsDigest: hex('findings'), ...overrides };
}
export function fixtureApprovalSubject(changeId: string): ApprovalSubject {
  return ApprovalSubjectSchema.parse({ changeId, bundle: fixtureBundle(), baseBranch: 'main', branch: changeBranchName(changeId, 1),
    verifications: [{ commandId: COMMAND, status: 'passed', receiptDigest: hex('receipt') }],
    review: { receiptDigest: hex('review'), coverage: 'complete', verdict: 'pass' }, publication: fixtureMetadata(), ciFingerprint: hex('ci') });
}
export function fixtureBrief(overrides: Partial<ChangeBrief> = {}): ChangeBrief {
  return { summary: '공개 요약', goal: '공개 목표', acceptanceCriteria: ['시험 통과'], repoId: REPO_ID, baseBranch: 'main', allowedPaths: ['src/**'], deniedPaths: [],
    verificationCommandIds: [COMMAND], label: 'public', ...overrides };
}
export const fixtureExpected = (stage: EffectStage, changeId: string, generation = 1): EffectExpected => EffectExpectedSchema.parse({
  blob: { stage: 'blob', shas: [gitBlobSha(CONTENT)] },
  tree: { stage: 'tree', baseTree: git('t0'), treeSha: git('t1') },
  commit: { stage: 'commit', treeSha: git('t1'), parent: git('b'), commitSha: git('h') },
  ref: { stage: 'ref', ref: `refs/heads/${changeBranchName(changeId, generation)}`, sha: git('h') },
  pull: { stage: 'pull', headBranch: changeBranchName(changeId, generation), baseBranch: 'main', headSha: git('h'), marker: 'fixture-marker' },
}[stage]);
export const fixtureResult = (stage: EffectStage, changeId: string, generation = 1): EffectResult => ({
  blob: { stage: 'blob', shas: [gitBlobSha(CONTENT)] },
  tree: { stage: 'tree', treeSha: git('t1') },
  commit: { stage: 'commit', commitSha: git('h'), treeSha: git('t1'), parents: [git('b')] },
  ref: { stage: 'ref', ref: `refs/heads/${changeBranchName(changeId, generation)}`, sha: git('h') },
  pull: { stage: 'pull', number: 7, headBranch: changeBranchName(changeId, generation), baseBranch: 'main', headSha: git('h') },
} as Record<EffectStage, EffectResult>)[stage];

export function ok<T>(result: StoreResult<T>): T {
  if (!result.ok) assert.fail(`store_failure:${result.reason}:${result.detail ?? ''}`);
  return result.value;
}
export function failure<T>(result: StoreResult<T>, reason: string): void {
  assert.equal(result.ok, false, `실패여야 한다: ${reason}`);
  if (!result.ok) assert.equal(result.reason, reason);
}
export async function seedConversation(db: Database) {
  await db.query(`INSERT INTO conversations(id,owner_id,scope,channel_id,created_at) VALUES ($1,$2,$3,$4,$5) ON CONFLICT DO NOTHING`,
    [CONVERSATION, OWNER, JSON.stringify({ guild: 'fixture-guild', channel: 'fixture-thread', parent: 'fixture-chat', kind: 'thread' }), 'fixture-thread', 1]);
}
let events = 0;
export const newEvent = () => `fixture-event-${++events}-${Math.random().toString(36).slice(2)}`;
export const newRequest = async (store: ChangeStore, label: ChangeBrief['label'] = 'public') => ok(await store.createRequest({
  eventId: newEvent(), ownerId: OWNER, conversationId: CONVERSATION, scope: { guild: 'fixture-guild', channel: 'fixture-thread', parent: 'fixture-chat', kind: 'thread' },
  repoId: REPO_ID, baseBranch: 'main', label, input: { text: '공개 요청문' } }));

export const PATH: ChangePhase[] = ['requested', 'admitted', 'authoring', 'snapshot_ready', 'verifying', 'reviewing',
  'awaiting_publish_approval', 'approved', 'publishing', 'proposed', 'merged', 'observing_deploy'];
const reached = (target: ChangePhase, phase: ChangePhase) => PATH.indexOf(target) >= PATH.indexOf(phase);

// 정상 경로로 target까지 민다. 뒷단계 시험이 앞단계 호출을 되풀이하지 않게 한다.
export async function driveTo(store: ChangeStore, target: ChangePhase, existing?: ChangeRequest, generation = 1): Promise<ChangeRequest> {
  const request = existing ?? await newRequest(store);
  const key = { changeId: request.id, generation };
  const bundle = fixtureBundle({ generation });
  if (reached(target, 'admitted')) ok(await store.admit({ ...key, brief: fixtureBrief(), policyRevision: 'fixture-policy-1' }));
  if (reached(target, 'authoring')) ok(await store.pinBase({ ...key, baseCommit: git('b'), baseTree: git('t0') }));
  if (reached(target, 'snapshot_ready')) {
    ok(await store.recordSnapshot({ ...key, manifest: fixtureManifest(), files: fixtureManifestFiles(), patch: fixturePatch(), transportBytes: 4096 }));
  }
  if (reached(target, 'verifying')) ok(await store.startVerification({ ...key, verifierRevision: 'fixture-verifier-1' }));
  if (reached(target, 'reviewing')) {
    ok(await store.recordVerification({ ...key, receipt: fixtureVerification({ bundle }) }));
    ok(await store.finishVerification(key));
  }
  if (reached(target, 'awaiting_publish_approval')) {
    ok(await store.recordReview({ ...key, receipt: fixtureReview({ bundle, jobId: await reviewJob(store, request.id, generation) }) }));
    ok(await store.prepareApproval({ ...key, publication: fixtureMetadata(), ciFingerprint: hex('ci') }));
  }
  if (reached(target, 'approved')) {
    const subject = ok(await store.approvalSubject(key));
    ok(await store.approve({ ...key, approvalDigest: subject.digest, eventId: newEvent(), actor: OWNER }));
  }
  if (reached(target, 'publishing')) ok(await store.transition({ ...key, from: 'approved', to: 'publishing', reason: null }));
  if (reached(target, 'proposed')) {
    await confirmThrough(store, key.changeId, generation, 'pull');
    ok(await store.transition({ ...key, from: 'publishing', to: 'proposed', reason: null }));
  }
  if (reached(target, 'merged')) ok(await store.recordMerge({ ...key, prNumber: 7, headSha: git('h'), mergeCommit: git('m') }));
  if (reached(target, 'observing_deploy')) ok(await store.transition({ ...key, from: 'merged', to: 'observing_deploy', reason: null }));
  return ok(await store.get(request.id));
}
// 리뷰 receipt의 job은 실제 jobs 행을 가리켜야 한다(FK). 부모 자신은 jobs 행이 아니다.
export async function insertChildJob(db: Database, id: string, type = 'review') {
  await db.query(`INSERT INTO events(id,provider,delivery_id,semantic_key,actor_id,scope,received_at,payload,accepted)
    VALUES ($1,'fixture',$1,$1,$2,'{}'::jsonb,1,'{}'::jsonb,true) ON CONFLICT DO NOTHING`, [`event-${id}`, OWNER]);
  await db.query(`INSERT INTO jobs(id,event_id,type,owner_id,target,revision,budget,state,priority,available_at,created_at)
    VALUES ($1,$2,$3,$4,'{}'::jsonb,'{}'::jsonb,'{}'::jsonb,'succeeded',1,1,1) ON CONFLICT DO NOTHING`, [id, `event-${id}`, type, OWNER]);
}
async function reviewJob(store: ChangeStore, changeId: string, generation: number): Promise<string> {
  const id = `fixture-review-${changeId}-${generation}`;
  await insertChildJob(store.database, id);
  ok(await store.linkChildJob({ changeId, generation, jobId: id, role: 'review' }));
  return id;
}
const STAGES: EffectStage[] = ['blob', 'tree', 'commit', 'ref', 'pull'];
export async function confirmThrough(store: ChangeStore, changeId: string, generation: number, last: EffectStage) {
  for (const stage of STAGES.slice(0, STAGES.indexOf(last) + 1)) {
    const key = { changeId, generation, stage };
    ok(await store.recordEffectIntent({ ...key, requestDigest: hex(`request-${stage}`), expected: fixtureExpected(stage, changeId, generation) }));
    const claim = ok(await store.claimEffect(key));
    ok(await store.confirmEffect({ ...key, leaseId: claim.leaseId, result: fixtureResult(stage, changeId, generation) }));
  }
}
