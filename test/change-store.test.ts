import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import { PGlite } from '@electric-sql/pglite';
import {
  CHANGE_PHASES, EFFECT_STAGES, EFFECT_STATES, UNKNOWN_RECONCILE_MS, approvalDigest, canTransition, canTransitionEffect, changeBranchName, gitBlobSha, sha256Hex,
} from '../src/change-contracts.js';
import type { ChangePhase, EffectExpected, EffectStage, EffectState } from '../src/change-contracts.js';
import { ChangePrivateInputs, ChangeStore } from '../src/change-store.js';
import type { Database } from '../src/database.js';
import { MIGRATIONS, migrate } from '../src/database.js';
import { localDatabase } from './helpers.js';
import {
  CONVERSATION, COMMAND, OWNER, PATH, REPO_ID, confirmThrough, driveTo, failure, fixtureBrief, fixtureBundle, fixtureExpected, fixtureManifest, fixtureManifestFiles, fixtureMetadata,
  fixturePatch, fixtureResult, fixtureReview, fixtureVerification, git, hex, insertChildJob, newEvent, newRequest, ok, seedConversation,
} from './change-store-fixture.js';

async function setup(start = 1_800_000_000_000) {
  const { db, pg } = await localDatabase();
  await seedConversation(db);
  const clock = { now: start };
  const store = new ChangeStore(db, () => clock.now);
  return { db, pg, clock, store, close: () => pg.close() };
}
const count = async (db: Database, sql: string, params: unknown[] = []) =>
  Number((await db.query<{ n: string }>(`SELECT count(*)::text AS n FROM ${sql}`, params)).rows[0]!.n);
const phaseOf = async (store: ChangeStore, id: string) => ok(await store.get(id)).phase;
const stageKey = (changeId: string, stage: EffectStage, generation = 1) => ({ changeId, generation, stage });
const intent = (store: ChangeStore, changeId: string, stage: EffectStage, requestDigest = hex(`request-${stage}`)) =>
  store.recordEffectIntent({ ...stageKey(changeId, stage), requestDigest, expected: fixtureExpected(stage, changeId) });
const rawError = async (work: Promise<unknown>, expected: RegExp) => {
  const error = await work.then(() => null, (e: unknown) => e as Error);
  assert.ok(error, `DB가 막아야 한다: ${expected}`);
  assert.match(error.message, expected);
};

test('T19 B0 정상 경로: requested부터 observing_deploy까지 돌고 부모는 jobs 행을 만들지 않는다', async () => {
  const s = await setup();
  try {
    const first = await newRequest(s.store);
    assert.equal(first.phase, 'requested');
    assert.equal(first.generation, 1);
    assert.match(first.id, /^[0-9a-f]{32}$/);
    for (const phase of PATH.slice(1)) {
      const { phase: reached } = await driveTo(s.store, phase);
      assert.equal(reached, phase);
    }
    const done = await driveTo(s.store, 'observing_deploy');
    const bundle = ok(await s.store.evidenceBundle({ changeId: done.id, generation: 1 }));
    assert.deepEqual(bundle, fixtureBundle());
    assert.equal(ok(await s.store.generationRecord({ changeId: done.id, generation: 1 })).branch, changeBranchName(done.id, 1));
    // jobs에 있는 것은 fixture가 넣은 리뷰 자식 job뿐이다. 승인 대기 부모가 slot을 잡지 않는다.
    const parents = await count(s.db, `jobs WHERE id = ANY($1)`, [[first.id, done.id]]);
    assert.equal(parents, 0);
    assert.equal(await count(s.db, `jobs WHERE state IN ('running','verifying','cancel_requested','unknown','waiting_user')`), 0);
    assert.equal(await count(s.db, `jobs WHERE type NOT IN ('review')`), 0);
    assert.ok(await count(s.db, `audit WHERE kind='change_phase' AND subject=$1`, [done.id]) >= 11);
  } finally { await s.close(); }
});

test('T19 B0 전이 CAS: phase·generation이 어긋나면 값으로 실패하고 현재 값을 돌려주며 행을 바꾸지 않는다', async () => {
  const s = await setup();
  try {
    const r = await newRequest(s.store);
    const key = { changeId: r.id, generation: 1 };
    const wrongPhase = await s.store.transition({ ...key, from: 'admitted', to: 'cancelled', reason: 'user_cancelled' });
    failure(wrongPhase, 'phase_conflict');
    if (!wrongPhase.ok) assert.deepEqual(wrongPhase.current, { phase: 'requested', generation: 1 });
    failure(await s.store.transition({ ...key, generation: 2, from: 'requested', to: 'cancelled', reason: 'user_cancelled' }), 'phase_conflict');
    failure(await s.store.transition({ changeId: 'f'.repeat(32), generation: 1, from: 'requested', to: 'cancelled', reason: 'x' }), 'not_found');
    failure(await s.store.transition({ ...key, from: 'requested', to: 'authoring', reason: null }), 'transition_not_allowed');
    failure(await s.store.transition({ ...key, from: 'requested', to: 'admitted', reason: null }), 'dedicated_operation');
    failure(await s.store.transition({ ...key, from: 'requested', to: 'cancelled', reason: 'free text 자유문' }), 'invalid_input');
    assert.equal(await phaseOf(s.store, r.id), 'requested');
    assert.equal(await count(s.db, `audit WHERE subject=$1 AND kind='change_phase'`, [r.id]), 0);
    const moved = ok(await s.store.transition({ ...key, from: 'requested', to: 'cancelled', reason: 'user_cancelled' }));
    assert.equal(moved.phase, 'cancelled');
    assert.equal(moved.phaseReason, 'user_cancelled');
    failure(await s.store.transition({ ...key, from: 'requested', to: 'cancelled', reason: 'user_cancelled' }), 'phase_conflict');
    assert.equal(await count(s.db, `audit WHERE subject=$1 AND kind='change_phase'`, [r.id]), 1);
  } finally { await s.close(); }
});

test('T19 B0 DB 전이 함수는 코드 표와 모든 쌍에서 같고 phase CHECK가 모르는 값을 막는다', async () => {
  const s = await setup();
  try {
    for (const from of CHANGE_PHASES) {
      for (const to of CHANGE_PHASES) {
        const row = (await s.db.query<{ allowed: boolean }>('SELECT change_phase_transition_allowed($1,$2) AS allowed', [from, to])).rows[0]!;
        assert.equal(row.allowed, canTransition(from, to), `${from}->${to}`);
      }
    }
    for (const from of EFFECT_STATES) {
      for (const to of EFFECT_STATES) {
        const row = (await s.db.query<{ allowed: boolean }>('SELECT change_effect_transition_allowed($1,$2) AS allowed', [from, to])).rows[0]!;
        assert.equal(row.allowed, canTransitionEffect(from, to), `${from}->${to}`);
      }
    }
    const r = await newRequest(s.store);
    await rawError(s.db.query(`UPDATE change_requests SET phase='done' WHERE id=$1`, [r.id]), /transition_not_allowed/);
    // 트리거가 꺼져도 phase CHECK가 따로 막는다. brief가 있는 행이어야 다른 CHECK보다 이 CHECK가 먼저 걸린다.
    const admitted = await driveTo(s.store, 'admitted');
    await s.db.query('ALTER TABLE change_requests DISABLE TRIGGER USER');
    await rawError(s.db.query(`UPDATE change_requests SET phase='done' WHERE id=$1`, [admitted.id]), /change_requests_phase_check/);
    await s.db.query('ALTER TABLE change_requests ENABLE TRIGGER USER');
  } finally { await s.close(); }
});

test('T19 B0 DB가 코드를 거치지 않은 위험한 전이를 직접 막는다', async () => {
  const s = await setup();
  try {
    const set = (id: string, fields: string) => s.db.query(`UPDATE change_requests SET ${fields} WHERE id=$1`, [id]);
    const r = await newRequest(s.store);
    await rawError(set(r.id, `phase='authoring'`), /transition_not_allowed/);
    await rawError(set(r.id, `phase='admitted'`), /check/i);
    await rawError(s.db.query(`INSERT INTO change_requests(id,event_id,owner_id,conversation_id,scope,repo_id,base_branch,phase,label,created_at,updated_at)
      VALUES ($1,'raw-event',$2,$3,'{}'::jsonb,1,'main','approved','public',1,1)`, ['e'.repeat(32), OWNER, CONVERSATION]), /change_must_start_requested/);

    const awaiting = await driveTo(s.store, 'awaiting_publish_approval');
    await rawError(set(awaiting.id, `phase='approved'`), /approval_required/);
    const approved = await driveTo(s.store, 'approved');
    await s.db.query(`UPDATE change_approvals SET invalidated_at=1,invalidated_reason='fixture' WHERE change_id=$1`, [approved.id]);
    await rawError(set(approved.id, `phase='publishing'`), /approval_required/);
    const publishing = await driveTo(s.store, 'publishing');
    await rawError(set(publishing.id, `phase='proposed'`), /pull_effect_required/);
    const verifying = await driveTo(s.store, 'verifying');
    await rawError(set(verifying.id, `phase='reviewing'`), /verification_required/);
    const reviewing = await driveTo(s.store, 'reviewing');
    await rawError(set(reviewing.id, `phase='awaiting_publish_approval'`), /review_required/);
    const authoring = await driveTo(s.store, 'authoring');
    await rawError(set(authoring.id, `phase='snapshot_ready'`), /artifact_required/);
    const snapshot = await driveTo(s.store, 'snapshot_ready');
    await rawError(set(snapshot.id, `phase='verifying'`), /verifier_required/);
    const admitted = await driveTo(s.store, 'admitted');
    await rawError(set(admitted.id, `phase='authoring'`), /generation_required/);
    const proposed = await driveTo(s.store, 'proposed');
    await rawError(set(proposed.id, `phase='merged'`), /merge_record_required/);

    await rawError(set(admitted.id, `generation=2,phase='requested'`), /generation_restart_invalid/);
    await rawError(set(admitted.id, `owner_id='someone'`), /change_identity_immutable/);
    await rawError(set(admitted.id, `repo_id=1`), /change_identity_immutable/);
    await rawError(set(admitted.id, `brief_digest='${hex('other')}'`), /change_admission_immutable/);
    await rawError(set(admitted.id, `policy_revision='other'`), /change_admission_immutable/);
    await rawError(set(snapshot.id, `id='${'d'.repeat(32)}'`), /change_identity_immutable/);
  } finally { await s.close(); }
});

test('T19 B0 이벤트 중복: 같은 event ID는 새 change·입력·승인을 만들지 않는다', async () => {
  const s = await setup();
  try {
    const input = { eventId: 'dup-event', ownerId: OWNER, conversationId: CONVERSATION, scope: { guild: 'g', channel: 'c', parent: 'p', kind: 'thread' as const },
      repoId: REPO_ID, baseBranch: 'main', label: 'public' as const, input: { text: '요청' } };
    const first = ok(await s.store.createRequest(input));
    const again = await s.store.createRequest(input);
    failure(again, 'duplicate_event');
    if (!again.ok) assert.equal(again.existingId, first.id);
    assert.equal(await count(s.db, 'change_requests'), 1);
    assert.equal(await count(s.db, 'change_request_inputs'), 1);

    const inputs = new ChangePrivateInputs(s.db, () => s.clock.now);
    ok(await inputs.record({ changeId: first.id, generation: 1, eventId: 'answer-1', label: 'public', text: '추가 답변' }));
    failure(await inputs.record({ changeId: first.id, generation: 1, eventId: 'answer-1', label: 'public', text: '추가 답변' }), 'duplicate_event');
    assert.equal(await count(s.db, 'change_request_inputs'), 2);

    const awaiting = await driveTo(s.store, 'awaiting_publish_approval');
    const key = { changeId: awaiting.id, generation: 1 };
    const { digest } = ok(await s.store.approvalSubject(key));
    ok(await s.store.approve({ ...key, approvalDigest: digest, eventId: 'approve-1', actor: OWNER }));
    failure(await s.store.approve({ ...key, approvalDigest: digest, eventId: 'approve-1', actor: OWNER }), 'duplicate_event');
    assert.equal(await count(s.db, 'change_approvals WHERE change_id=$1', [awaiting.id]), 1);
    await rawError(s.db.query(`INSERT INTO change_requests(id,event_id,owner_id,conversation_id,scope,repo_id,base_branch,label,created_at,updated_at)
      VALUES ($1,'dup-event',$2,$3,'{}'::jsonb,1,'main','public',1,1)`, ['e'.repeat(32), OWNER, CONVERSATION]), /unique|duplicate/i);
  } finally { await s.close(); }
});

test('T19 B0 출처: private·unknown은 admission에서 막히고 추가 답변이 private면 진행 중 change를 닫으며 label은 낮아지지 않는다', async () => {
  const s = await setup();
  try {
    const inputs = new ChangePrivateInputs(s.db, () => s.clock.now);
    for (const label of ['private', 'unknown'] as const) {
      const r = await newRequest(s.store, label);
      failure(await s.store.admit({ changeId: r.id, generation: 1, brief: fixtureBrief(), policyRevision: 'fixture-policy-1' }), 'label_blocked');
      const row = ok(await s.store.get(r.id));
      assert.equal(row.phase, 'blocked');
      assert.equal(row.phaseReason, 'label_blocked');
      assert.equal(row.label, label);
    }
    // brief의 자기 신고는 요청의 label을 낮추지 못한다.
    const low = await newRequest(s.store, 'approved_public_summary');
    const admitted = ok(await s.store.admit({ changeId: low.id, generation: 1, brief: fixtureBrief({ label: 'public' }), policyRevision: 'fixture-policy-1' }));
    assert.equal(admitted.label, 'approved_public_summary');
    await rawError(s.db.query(`UPDATE change_requests SET label='public' WHERE id=$1`, [low.id]), /label_lowered/);
    // brief가 더 높으면 올라가고 private면 막힌다.
    const raised = await newRequest(s.store, 'public');
    failure(await s.store.admit({ changeId: raised.id, generation: 1, brief: fixtureBrief({ label: 'private' }), policyRevision: 'fixture-policy-1' }), 'label_blocked');
    assert.equal(ok(await s.store.get(raised.id)).label, 'private');

    const authoring = await driveTo(s.store, 'authoring');
    failure(await inputs.record({ changeId: authoring.id, generation: 1, eventId: newEvent(), label: 'private', text: '비공개 답변' }), 'label_blocked');
    const closed = ok(await s.store.get(authoring.id));
    assert.equal(closed.phase, 'blocked');
    assert.equal(closed.label, 'private');
    assert.deepEqual((await inputs.read({ changeId: authoring.id })).map(row => row.label), ['public', 'private']);
    // 승인까지 간 change도 private 답변이 오면 승인과 미전송 effect를 함께 닫는다.
    const publishing = await driveTo(s.store, 'publishing');
    ok(await intent(s.store, publishing.id, 'blob'));
    failure(await inputs.record({ changeId: publishing.id, generation: 1, eventId: newEvent(), label: 'unknown', text: '분류 안 된 답변' }), 'label_blocked');
    assert.equal(await count(s.db, `change_approvals WHERE change_id=$1 AND invalidated_at IS NULL`, [publishing.id]), 0);
    assert.deepEqual(await s.store.unresolvedEffects({ changeId: publishing.id }), []);
    failure(await inputs.record({ changeId: publishing.id, generation: 1, eventId: newEvent(), label: 'public', text: '닫힌 뒤 답변' }), 'phase_conflict');
    // 공개 경로가 쓰는 표는 private label로 진행하지 못한다.
    await rawError(s.db.query(`UPDATE change_requests SET label='private' WHERE id=$1`, [(await driveTo(s.store, 'authoring')).id]), /check/i);
  } finally { await s.close(); }
});

test('T19 B0 요청 원문은 별도 표에 label과 함께 두고 ChangeStore가 읽지 않으며 공개 금지 값 열이 없다', async () => {
  const s = await setup();
  try {
    const r = await newRequest(s.store);
    const inputs = new ChangePrivateInputs(s.db, () => s.clock.now);
    const rows = await inputs.read({ changeId: r.id });
    assert.deepEqual(rows.map(row => [row.label, row.text, row.textSha256]), [['public', '공개 요청문', sha256Hex(Buffer.from('공개 요청문'))]]);
    // 원문 표를 부르는 코드는 ChangePrivateInputs 하나다. 공개 경로가 import해도 이 표를 만질 수단이 없다.
    const offenders: string[] = [];
    for (const file of await readdir('src')) {
      const source = await readFile(`src/${file}`, 'utf8');
      if (source.includes('change_request_inputs') && file !== 'change-store.ts') offenders.push(file);
    }
    assert.deepEqual(offenders, []);
    const store = await readFile('src/change-store.ts', 'utf8');
    const outside = store.slice(0, store.indexOf('export class ChangePrivateInputs'));
    assert.equal(outside.split('change_request_inputs').length - 1, 1, '공용 INSERT 한 곳만 남는다');

    const columns = (await s.db.query<{ table_name: string; column_name: string }>(`SELECT table_name,column_name FROM information_schema.columns
      WHERE table_schema='public' AND table_name LIKE 'change\\_%'`)).rows;
    assert.ok(columns.length > 40);
    const forbidden = columns.filter(c => /token|secret|password|passphrase|private_key|jwt|credential|api_key/i.test(c.column_name));
    assert.deepEqual(forbidden, []);
    const publicTables = new Set(columns.map(c => c.table_name));
    publicTables.delete('change_request_inputs');
    for (const table of publicTables) assert.equal(columns.some(c => c.table_name === table && c.column_name === 'text'), false, table);
  } finally { await s.close(); }
});

test('T19 B0 스냅샷: 바이트·기대 base·상한을 어기면 값으로 거부하고 같은 결과 재저장은 멱등이다', async () => {
  const s = await setup();
  try {
    const r = await driveTo(s.store, 'authoring');
    const key = { changeId: r.id, generation: 1 };
    const base = { ...key, manifest: fixtureManifest(), files: fixtureManifestFiles(), patch: fixturePatch(), transportBytes: 4096 };
    failure(await s.store.recordSnapshot({ ...base, files: [{ path: 'src/new.ts', content: Buffer.from('tampered') }] }), 'artifact_invalid');
    failure(await s.store.recordSnapshot({ ...base, manifest: { ...base.manifest, baseCommit: git('other') } }), 'base_mismatch');
    failure(await s.store.recordSnapshot({ ...base, manifest: { ...base.manifest, baseTree: git('other') } }), 'base_mismatch');
    failure(await s.store.recordSnapshot({ ...base, patch: 'other patch' }), 'artifact_invalid');
    failure(await s.store.recordSnapshot({ ...base, transportBytes: 2 * 1024 * 1024 + 1 }), 'artifact_too_large');
    failure(await s.store.recordSnapshot({ ...base, manifest: { ...base.manifest, entries: [] } }), 'invalid_input');
    assert.equal(await phaseOf(s.store, r.id), 'authoring');
    assert.equal(await count(s.db, 'change_artifacts WHERE change_id=$1', [r.id]), 0);

    const saved = ok(await s.store.recordSnapshot(base));
    assert.equal(saved.created, true);
    assert.equal(await phaseOf(s.store, r.id), 'snapshot_ready');
    const again = ok(await s.store.recordSnapshot(base));
    assert.equal(again.created, false);
    assert.equal(again.artifactDigest, saved.artifactDigest);
    failure(await s.store.recordSnapshot({ ...base, manifest: { ...base.manifest, resultTree: git('other') } }), 'artifact_conflict');

    const loaded = ok(await s.store.loadArtifact(key));
    assert.equal(loaded.artifactDigest, saved.artifactDigest);
    assert.equal(loaded.patch, fixturePatch());
    assert.deepEqual(loaded.manifest, fixtureManifest());
    assert.deepEqual(loaded.files.map(f => [f.path, Buffer.from(f.content).toString('utf8')]), fixtureManifestFiles().map(f => [f.path, Buffer.from(f.content).toString('utf8')]));
    assert.equal(gitBlobSha(loaded.files[0]!.content), loaded.manifest.entries[1]!.blobSha);
    await rawError(s.db.query(`UPDATE change_artifact_files SET content='\\x00'::bytea WHERE change_id=$1`, [r.id]), /change_evidence_immutable/);
    await rawError(s.db.query(`UPDATE change_artifacts SET artifact_digest=$2 WHERE change_id=$1`, [r.id, hex('x')]), /change_evidence_immutable/);
    await rawError(s.db.query(`UPDATE change_generations SET result_tree=$2 WHERE change_id=$1`, [r.id, git('x')]), /change_generation_immutable/);
    await rawError(s.db.query(`UPDATE change_generations SET base_commit=$2 WHERE change_id=$1`, [r.id, git('x')]), /change_generation_immutable/);
  } finally { await s.close(); }
});

test('T19 B0 시험 receipt: 다른 묶음·허용 안 된 command·실패가 다음 단계로 못 가고 같은 receipt 재기록은 멱등이다', async () => {
  const s = await setup();
  try {
    const r = await driveTo(s.store, 'verifying');
    const key = { changeId: r.id, generation: 1 };
    failure(await s.store.finishVerification(key), 'verification_incomplete');
    failure(await s.store.recordVerification({ ...key, receipt: fixtureVerification({ bundle: fixtureBundle({ resultTree: git('other') }) }) }), 'bundle_mismatch');
    failure(await s.store.recordVerification({ ...key, receipt: fixtureVerification({ bundle: fixtureBundle({ generation: 2 }) }) }), 'bundle_mismatch');
    failure(await s.store.recordVerification({ ...key, receipt: fixtureVerification({ commandId: 'other-unit' }) }), 'command_not_allowed');
    failure(await s.store.recordVerification({ ...key, receipt: { ...fixtureVerification(), exitCode: 1 } }), 'invalid_input');
    assert.equal(ok(await s.store.recordVerification({ ...key, receipt: fixtureVerification() })).created, true);
    assert.equal(ok(await s.store.recordVerification({ ...key, receipt: fixtureVerification() })).created, false);
    failure(await s.store.recordVerification({ ...key, receipt: fixtureVerification({ status: 'failed', exitCode: 1 }) }), 'receipt_conflict');

    const failing = await driveTo(s.store, 'verifying');
    const failingKey = { changeId: failing.id, generation: 1 };
    ok(await s.store.recordVerification({ ...failingKey, receipt: fixtureVerification({ status: 'failed', exitCode: 1 }) }));
    const blocked = await s.store.finishVerification(failingKey);
    failure(blocked, 'verification_incomplete');
    if (!blocked.ok) assert.deepEqual(blocked.commands, [`${COMMAND}:failed`]);
    assert.equal(await phaseOf(s.store, failing.id), 'verifying');
    await rawError(s.db.query(`UPDATE change_verifications SET status='passed',exit_code=0 WHERE change_id=$1`, [failing.id]), /change_receipt_immutable/);
    await rawError(s.db.query(`UPDATE change_requests SET phase='reviewing' WHERE id=$1`, [failing.id]), /verification_required/);
  } finally { await s.close(); }
});

test('T19 B0 리뷰·승인 대상: 시험 없음·범위 부족·차단 판정이면 승인 대기로 못 간다', async () => {
  const s = await setup();
  try {
    const r = await driveTo(s.store, 'reviewing');
    const key = { changeId: r.id, generation: 1 };
    const prepare = { ...key, publication: fixtureMetadata(), ciFingerprint: hex('ci') };
    failure(await s.store.prepareApproval(prepare), 'review_incomplete');
    const job = 'fixture-review-gate';
    failure(await s.store.recordReview({ ...key, receipt: fixtureReview({ jobId: job }) }), 'job_not_linked');
    await insertChildJob(s.db, job);
    failure(await s.store.linkChildJob({ ...key, jobId: 'no-such-job', role: 'review' }), 'job_not_found');
    ok(await s.store.linkChildJob({ ...key, jobId: job, role: 'review' }));
    ok(await s.store.linkChildJob({ ...key, jobId: job, role: 'review' }));
    failure(await s.store.recordReview({ ...key, receipt: fixtureReview({ jobId: job, bundle: fixtureBundle({ artifactDigest: hex('other') }) }) }), 'bundle_mismatch');
    ok(await s.store.recordReview({ ...key, receipt: fixtureReview({ jobId: job, coverage: 'incomplete', verdict: 'blocked' }) }));
    failure(await s.store.prepareApproval(prepare), 'review_incomplete');
    assert.equal(await phaseOf(s.store, r.id), 'reviewing');

    const good = await driveTo(s.store, 'awaiting_publish_approval');
    const goodKey = { changeId: good.id, generation: 1 };
    const { digest, subject } = ok(await s.store.approvalSubject(goodKey));
    assert.equal(digest, approvalDigest(subject));
    assert.deepEqual(subject.bundle, fixtureBundle());
    assert.equal(subject.branch, changeBranchName(good.id, 1));
    assert.deepEqual(subject.publication, fixtureMetadata());
    await rawError(s.db.query(`UPDATE change_approval_subjects SET approval_digest=$2 WHERE change_id=$1`, [good.id, hex('x')]), /change_evidence_immutable/);
  } finally { await s.close(); }
});

test('T19 B0 승인: 다른 digest·다른 사람·잘못된 단계는 값으로 거부하고 한 generation에 살아 있는 승인은 하나다', async () => {
  const s = await setup();
  try {
    const r = await driveTo(s.store, 'awaiting_publish_approval');
    const key = { changeId: r.id, generation: 1 };
    const { digest, subject } = ok(await s.store.approvalSubject(key));
    failure(await s.store.approve({ ...key, approvalDigest: hex('other'), eventId: newEvent(), actor: OWNER }), 'digest_mismatch');
    failure(await s.store.approve({ ...key, approvalDigest: digest, eventId: newEvent(), actor: 'someone-else' }), 'owner_mismatch');
    assert.equal(await phaseOf(s.store, r.id), 'awaiting_publish_approval');
    const approved = ok(await s.store.approve({ ...key, approvalDigest: digest, eventId: newEvent(), actor: OWNER }));
    assert.equal(approved.phase, 'approved');
    failure(await s.store.approve({ ...key, approvalDigest: digest, eventId: newEvent(), actor: OWNER }), 'phase_conflict');
    // 재확인은 지금 계산한 대상으로 비교한다. 공개 본문 하나만 달라도 통과하지 않는다.
    assert.equal(ok(await s.store.checkLiveApproval({ ...key, subject })).digest, digest);
    failure(await s.store.checkLiveApproval({ ...key, subject: { ...subject, publication: { ...subject.publication, body: '바뀐 본문' } } }), 'digest_mismatch');
    await rawError(s.db.query(`INSERT INTO change_approvals(change_id,generation,approval_digest,event_id,approved_by,approved_at) VALUES ($1,1,$2,'raw-approve',$3,1)`,
      [r.id, digest, OWNER]), /unique|duplicate/i);
    await rawError(s.db.query(`UPDATE change_approvals SET approval_digest=$2 WHERE change_id=$1`, [r.id, hex('x')]), /change_approval_immutable/);
  } finally { await s.close(); }
});

test('T19 B0 무효화: 승인·시험·리뷰를 함께 무효로 하고 끝 상태로 옮기며 무효 증거로 게시를 시작하지 못한다', async () => {
  const s = await setup();
  try {
    const r = await driveTo(s.store, 'approved');
    const key = { changeId: r.id, generation: 1 };
    const { subject } = ok(await s.store.approvalSubject(key));
    failure(await s.store.invalidateEvidence({ ...key, from: 'reviewing', to: 'superseded', reason: 'base_moved' }), 'phase_conflict');
    const moved = ok(await s.store.invalidateEvidence({ ...key, from: 'approved', to: 'superseded', reason: 'base_moved' }));
    assert.equal(moved.phase, 'superseded');
    assert.equal(moved.phaseReason, 'base_moved');
    assert.equal(await count(s.db, `change_approvals WHERE change_id=$1 AND invalidated_at IS NULL`, [r.id]), 0);
    assert.equal(await count(s.db, `change_verifications WHERE change_id=$1 AND invalidated_at IS NULL`, [r.id]), 0);
    assert.equal(await count(s.db, `change_reviews WHERE change_id=$1 AND invalidated_at IS NULL`, [r.id]), 0);
    failure(await s.store.checkLiveApproval({ ...key, subject }), 'approval_missing');
    failure(await s.store.transition({ ...key, from: 'approved', to: 'publishing', reason: null }), 'phase_conflict');

    const blocked = await driveTo(s.store, 'approved');
    ok(await s.store.invalidateEvidence({ changeId: blocked.id, generation: 1, from: 'approved', to: 'blocked', reason: 'policy_changed' }));
    assert.equal(await phaseOf(s.store, blocked.id), 'blocked');

    // 끝 상태로 바로 가는 일반 전이도 살아 있는 승인을 남기지 않는다.
    const cancelled = await driveTo(s.store, 'approved');
    ok(await s.store.transition({ changeId: cancelled.id, generation: 1, from: 'approved', to: 'cancelled', reason: 'user_cancelled' }));
    assert.equal(await count(s.db, `change_approvals WHERE change_id=$1 AND invalidated_at IS NULL`, [cancelled.id]), 0);
  } finally { await s.close(); }
});

test('T19 B0 새 generation: superseded에서만 requested로 열고 이전 증거를 잇지 않으며 브랜치가 새로 정해진다', async () => {
  const s = await setup();
  try {
    const r = await driveTo(s.store, 'approved');
    const key = { changeId: r.id, generation: 1 };
    failure(await s.store.startNextGeneration(key), 'phase_conflict');
    ok(await s.store.invalidateEvidence({ ...key, from: 'approved', to: 'superseded', reason: 'base_moved' }));
    failure(await s.store.startNextGeneration({ ...key, generation: 2 }), 'phase_conflict');
    const next = ok(await s.store.startNextGeneration(key));
    assert.deepEqual([next.generation, next.phase, next.policyRevision, next.briefDigest], [2, 'requested', null, null]);
    failure(await s.store.startNextGeneration(key), 'phase_conflict');
    // 옛 generation의 전이·기록은 현재 generation과 달라 값으로 거부된다.
    failure(await s.store.transition({ ...key, from: 'requested', to: 'cancelled', reason: 'x' }), 'phase_conflict');
    failure(await s.store.recordVerification({ ...key, receipt: fixtureVerification() }), 'phase_conflict');
    failure(await s.store.approve({ ...key, approvalDigest: hex('x'), eventId: newEvent(), actor: OWNER }), 'phase_conflict');

    const second = await driveTo(s.store, 'verifying', next, 2);
    assert.equal(second.generation, 2);
    assert.equal(ok(await s.store.generationRecord({ changeId: r.id, generation: 2 })).branch, changeBranchName(r.id, 2));
    assert.notEqual(ok(await s.store.generationRecord({ changeId: r.id, generation: 1 })).branch, changeBranchName(r.id, 2));
    // generation 1의 receipt는 새 묶음과 달라 인정되지 않는다.
    failure(await s.store.recordVerification({ changeId: r.id, generation: 2, receipt: fixtureVerification() }), 'bundle_mismatch');
    failure(await s.store.finishVerification({ changeId: r.id, generation: 2 }), 'verification_incomplete');
    failure(await s.store.startNextGeneration({ changeId: r.id, generation: 2 }), 'phase_conflict');
  } finally { await s.close(); }
});

test('T19 B0 effect intent: 게시 단계·살아 있는 승인·앞 stage 확정이 있어야 만들고 같은 key는 digest가 같을 때만 멱등이다', async () => {
  const s = await setup();
  try {
    const approved = await driveTo(s.store, 'approved');
    failure(await intent(s.store, approved.id, 'blob'), 'phase_conflict');
    await rawError(s.db.query(`INSERT INTO change_delivery_effects(change_id,generation,stage,approval_digest,request_digest,expected,available_at,created_at,updated_at)
      SELECT change_id,generation,'blob',approval_digest,$2,'{}'::jsonb,1,1,1 FROM change_approvals WHERE change_id=$1`, [approved.id, hex('r')]), /change_not_publishing/);

    const r = await driveTo(s.store, 'publishing');
    failure(await intent(s.store, r.id, 'tree'), 'predecessor_unconfirmed');
    const created = ok(await intent(s.store, r.id, 'blob'));
    assert.deepEqual([created.state, created.created, created.attempt], ['pending', true, 0]);
    assert.equal(ok(await intent(s.store, r.id, 'blob')).created, false);
    failure(await intent(s.store, r.id, 'blob', hex('different')), 'effect_conflict');
    failure(await s.store.recordEffectIntent({ ...stageKey(r.id, 'blob'), requestDigest: hex('r'), expected: fixtureExpected('tree', r.id) }), 'invalid_input');
    // 미확정 effect가 있으면 다음 stage를 시작하지 못한다.
    failure(await intent(s.store, r.id, 'tree'), 'predecessor_unconfirmed');
    await rawError(s.db.query(`INSERT INTO change_delivery_effects(change_id,generation,stage,approval_digest,request_digest,expected,available_at,created_at,updated_at)
      SELECT change_id,generation,'blob',approval_digest,$2,'{}'::jsonb,1,1,1 FROM change_approvals WHERE change_id=$1`, [r.id, hex('r')]), /unique|duplicate/i);
    assert.deepEqual((await s.store.unresolvedEffects({ changeId: r.id })).map(e => [e.stage, e.state]), [['blob', 'pending']]);

    // ref는 자기 generation 브랜치만 기대할 수 있다.
    const ref = await driveTo(s.store, 'publishing');
    await confirmThrough(s.store, ref.id, 1, 'commit');
    failure(await s.store.recordEffectIntent({ ...stageKey(ref.id, 'ref'), requestDigest: hex('r'), expected: { stage: 'ref', ref: `refs/heads/${changeBranchName(ref.id, 2)}`, sha: git('h') } }), 'branch_mismatch');
    failure(await s.store.recordEffectIntent({ ...stageKey(ref.id, 'pull'), requestDigest: hex('r'), expected: fixtureExpected('pull', ref.id) }), 'predecessor_unconfirmed');
  } finally { await s.close(); }
});

test('T19 B0 effect 기대값은 고정 증거와 같아야 한다: 다른 blob·tree·parent·head를 적지 못하고 트리거 거부도 값이다', async () => {
  const s = await setup();
  try {
    const r = await driveTo(s.store, 'publishing');
    const put = (stage: EffectStage, expected: EffectExpected) => s.store.recordEffectIntent({ ...stageKey(r.id, stage), requestDigest: hex(`request-${stage}`), expected });
    failure(await put('blob', { stage: 'blob', shas: [git('unapproved')] }), 'evidence_mismatch');
    failure(await put('blob', { stage: 'blob', shas: [gitBlobSha(Buffer.from('export const value = 1;\n')), git('extra')] }), 'evidence_mismatch');
    await confirmThrough(s.store, r.id, 1, 'blob');
    failure(await put('tree', { stage: 'tree', baseTree: git('other'), treeSha: git('t1') }), 'evidence_mismatch');
    failure(await put('tree', { stage: 'tree', baseTree: git('t0'), treeSha: git('other') }), 'evidence_mismatch');
    ok(await put('tree', fixtureExpected('tree', r.id)));
    const treeClaim = ok(await s.store.claimEffect(stageKey(r.id, 'tree')));
    ok(await s.store.confirmEffect({ ...stageKey(r.id, 'tree'), leaseId: treeClaim.leaseId, result: fixtureResult('tree', r.id) }));
    failure(await put('commit', { stage: 'commit', treeSha: git('other'), parent: git('b'), commitSha: git('h') }), 'evidence_mismatch');
    failure(await put('commit', { stage: 'commit', treeSha: git('t1'), parent: git('other'), commitSha: git('h') }), 'evidence_mismatch');
    ok(await put('commit', fixtureExpected('commit', r.id)));
    const commitClaim = ok(await s.store.claimEffect(stageKey(r.id, 'commit')));
    ok(await s.store.confirmEffect({ ...stageKey(r.id, 'commit'), leaseId: commitClaim.leaseId, result: fixtureResult('commit', r.id) }));
    failure(await put('ref', { stage: 'ref', ref: `refs/heads/${changeBranchName(r.id, 1)}`, sha: git('other') }), 'evidence_mismatch');
    ok(await put('ref', fixtureExpected('ref', r.id)));
    const refClaim = ok(await s.store.claimEffect(stageKey(r.id, 'ref')));
    ok(await s.store.confirmEffect({ ...stageKey(r.id, 'ref'), leaseId: refClaim.leaseId, result: fixtureResult('ref', r.id) }));
    const pull = fixtureExpected('pull', r.id);
    failure(await put('pull', { ...pull, headSha: git('other') } as EffectExpected), 'evidence_mismatch');
    failure(await put('pull', { ...pull, baseBranch: 'develop' } as EffectExpected), 'branch_mismatch');
    const guarded = await s.store.transition({ changeId: r.id, generation: 1, from: 'publishing', to: 'proposed', reason: null });
    failure(guarded, 'guard_rejected');
    if (!guarded.ok) assert.equal(guarded.detail, 'pull_effect_required');
    assert.equal(await phaseOf(s.store, r.id), 'publishing');
  } finally { await s.close(); }
});

test('T19 B0 미확정 effect 유일성은 트리거 없이 인덱스만으로도 막힌다', async () => {
  const s = await setup();
  try {
    const r = await driveTo(s.store, 'publishing');
    ok(await intent(s.store, r.id, 'blob'));
    await s.db.query('ALTER TABLE change_delivery_effects DISABLE TRIGGER USER');
    await rawError(s.db.query(`INSERT INTO change_delivery_effects(change_id,generation,stage,approval_digest,request_digest,expected,available_at,created_at,updated_at)
      SELECT change_id,generation,'tree',approval_digest,$2,'{}'::jsonb,1,1,1 FROM change_approvals WHERE change_id=$1`, [r.id, hex('r')]), /change_delivery_effects_one_unresolved|unique|duplicate/i);
    await s.db.query('ALTER TABLE change_delivery_effects ENABLE TRIGGER USER');
  } finally { await s.close(); }
});

test('T19 B0 effect 상태: claim은 한 번, lease가 맞아야 확정하고 기대와 다른 결과는 확정하지 않는다', async () => {
  const s = await setup();
  try {
    const r = await driveTo(s.store, 'publishing');
    const key = stageKey(r.id, 'blob');
    ok(await intent(s.store, r.id, 'blob'));
    const claim = ok(await s.store.claimEffect(key));
    assert.match(claim.leaseId, /^[0-9a-f-]{36}$/);
    assert.equal(claim.attempt, 1);
    failure(await s.store.claimEffect(key), 'effect_conflict');
    failure(await s.store.confirmEffect({ ...key, leaseId: 'other', result: fixtureResult('blob', r.id) }), 'lease_mismatch');
    failure(await s.store.confirmEffect({ ...key, leaseId: claim.leaseId, result: { stage: 'blob', shas: [git('wrong')] } }), 'result_mismatch');
    failure(await s.store.confirmEffect({ ...key, leaseId: claim.leaseId, result: { stage: 'tree', treeSha: git('t1') } }), 'result_mismatch');
    const confirmed = ok(await s.store.confirmEffect({ ...key, leaseId: claim.leaseId, result: fixtureResult('blob', r.id) }));
    assert.equal(confirmed.state, 'confirmed');
    assert.deepEqual(confirmed.result, fixtureResult('blob', r.id));
    failure(await s.store.confirmEffect({ ...key, leaseId: claim.leaseId, result: fixtureResult('blob', r.id) }), 'effect_conflict');
    assert.deepEqual(await s.store.unresolvedEffects({ changeId: r.id }), []);
    await rawError(s.db.query(`UPDATE change_delivery_effects SET state='pending' WHERE change_id=$1`, [r.id]), /effect_transition_not_allowed/);
    await rawError(s.db.query(`UPDATE change_delivery_effects SET request_digest=$2 WHERE change_id=$1`, [r.id, hex('x')]), /effect_intent_immutable/);
    await rawError(s.db.query(`UPDATE change_delivery_effects SET expected='{}'::jsonb WHERE change_id=$1`, [r.id]), /effect_intent_immutable/);
    // pending에서 confirmed로 건너뛰지 못한다.
    ok(await intent(s.store, r.id, 'tree'));
    await rawError(s.db.query(`UPDATE change_delivery_effects SET state='confirmed',result='{}'::jsonb WHERE change_id=$1 AND stage='tree'`, [r.id]), /effect_transition_not_allowed/);
  } finally { await s.close(); }
});

test('T19 B0 응답 유실: lease 만료는 unknown, 24시간 안에는 대조로 확정, 지나면 blocked로 닫고 게시를 막는다', async () => {
  const s = await setup();
  try {
    const r = await driveTo(s.store, 'publishing');
    const key = stageKey(r.id, 'blob');
    ok(await intent(s.store, r.id, 'blob'));
    ok(await s.store.claimEffect(key));
    assert.equal((await s.store.expireSendingEffects()).length, 0);
    s.clock.now += 60_000;
    assert.deepEqual((await s.store.expireSendingEffects()).map(e => [e.stage, e.state]), [['blob', 'unknown']]);
    const unknown = (await s.store.unresolvedEffects({ changeId: r.id }))[0]!;
    assert.equal(unknown.reconcileDeadline, s.clock.now + UNKNOWN_RECONCILE_MS);
    failure(await s.store.claimEffect(key), 'effect_conflict');
    failure(await intent(s.store, r.id, 'tree'), 'predecessor_unconfirmed');
    // 대조로 찾으면 lease 없이 확정한다.
    assert.equal(ok(await s.store.confirmEffect({ ...key, leaseId: null, result: fixtureResult('blob', r.id) })).state, 'confirmed');

    const late = await driveTo(s.store, 'publishing');
    const lateKey = stageKey(late.id, 'blob');
    ok(await intent(s.store, late.id, 'blob'));
    const claim = ok(await s.store.claimEffect(lateKey));
    failure(await s.store.markEffectUnknown({ ...lateKey, leaseId: 'other', code: 'response_lost' }), 'lease_mismatch');
    ok(await s.store.markEffectUnknown({ ...lateKey, leaseId: claim.leaseId, code: 'response_lost' }));
    assert.equal((await s.store.blockExpiredUnknownEffects()).length, 0);
    s.clock.now += UNKNOWN_RECONCILE_MS - 1;
    assert.equal((await s.store.blockExpiredUnknownEffects()).length, 0);
    s.clock.now += 1;
    assert.deepEqual((await s.store.blockExpiredUnknownEffects()).map(e => [e.stage, e.state, e.blockedReason]), [['blob', 'blocked', 'unknown_deadline']]);
    const closed = ok(await s.store.get(late.id));
    assert.deepEqual([closed.phase, closed.phaseReason], ['blocked', 'effect_blocked']);
    failure(await s.store.confirmEffect({ ...lateKey, leaseId: null, result: fixtureResult('blob', late.id) }), 'effect_conflict');
    assert.equal((await s.store.unresolvedEffects({ changeId: late.id })).length, 1);
    await rawError(s.db.query(`DELETE FROM change_delivery_effects WHERE change_id=$1`, [late.id]), /effect_unresolved_delete/);
  } finally { await s.close(); }
});

test('T19 B0 lease 갱신과 확실한 미전송 반납: 반납은 재시도 시각 뒤에만 다시 claim되고 unknown에서는 반납이 없다', async () => {
  const s = await setup();
  try {
    const r = await driveTo(s.store, 'publishing');
    const key = stageKey(r.id, 'blob');
    ok(await intent(s.store, r.id, 'blob'));
    const claim = ok(await s.store.claimEffect(key));
    s.clock.now += 20_000;
    failure(await s.store.renewEffectLease({ ...key, leaseId: 'other' }), 'lease_mismatch');
    ok(await s.store.renewEffectLease({ ...key, leaseId: claim.leaseId }));
    s.clock.now += 20_000;
    assert.equal((await s.store.expireSendingEffects()).length, 0);
    failure(await s.store.releaseUnsentEffect({ ...key, leaseId: 'other', retryAt: s.clock.now + 1000 }), 'lease_mismatch');
    assert.equal(ok(await s.store.releaseUnsentEffect({ ...key, leaseId: claim.leaseId, retryAt: s.clock.now + 1000 })).state, 'pending');
    failure(await s.store.claimEffect(key), 'effect_not_due');
    s.clock.now += 1000;
    const second = ok(await s.store.claimEffect(key));
    assert.equal(second.attempt, 2);
    assert.notEqual(second.leaseId, claim.leaseId);
    ok(await s.store.markEffectUnknown({ ...key, leaseId: second.leaseId, code: 'response_lost' }));
    failure(await s.store.releaseUnsentEffect({ ...key, leaseId: second.leaseId, retryAt: s.clock.now }), 'lease_mismatch');
    await rawError(s.db.query(`UPDATE change_delivery_effects SET state='pending',reconcile_deadline=NULL WHERE change_id=$1`, [r.id]), /effect_transition_not_allowed/);
  } finally { await s.close(); }
});

test('T19 B0 끝 상태 뒤의 미전송 반납은 재시도 대기로 남기지 않고 해소해 다음 generation을 막지 않는다', async () => {
  const s = await setup();
  try {
    const r = await driveTo(s.store, 'publishing');
    const key = stageKey(r.id, 'blob');
    ok(await intent(s.store, r.id, 'blob'));
    const claim = ok(await s.store.claimEffect(key));
    ok(await s.store.transition({ changeId: r.id, generation: 1, from: 'publishing', to: 'superseded', reason: 'base_moved' }));
    assert.equal(ok(await s.store.get(r.id)).phase, 'superseded');
    failure(await s.store.startNextGeneration({ changeId: r.id, generation: 1 }), 'unresolved_effects');
    const released = ok(await s.store.releaseUnsentEffect({ ...key, leaseId: claim.leaseId, retryAt: s.clock.now }));
    assert.equal(released.state, 'blocked');
    assert.equal(released.resolution, 'not_sent');
    assert.deepEqual(await s.store.unresolvedEffects({ changeId: r.id }), []);
    assert.equal(ok(await s.store.startNextGeneration({ changeId: r.id, generation: 1 })).generation, 2);
    // 이미 해소된 행은 다시 반납할 수 없다.
    failure(await s.store.releaseUnsentEffect({ ...key, leaseId: claim.leaseId, retryAt: s.clock.now }), 'lease_mismatch');
  } finally { await s.close(); }
});

test('T19 B0 잘못된 policy revision은 저장되지 않아 같은 change를 고쳐 admission할 수 있다', async () => {
  const s = await setup();
  try {
    const r = await newRequest(s.store);
    const key = { changeId: r.id, generation: 1 };
    for (const bad of ['', 'has space', '-leading', 'x'.repeat(129)]) failure(await s.store.admit({ ...key, brief: fixtureBrief(), policyRevision: bad }), 'invalid_input');
    const current = ok(await s.store.get(r.id));
    assert.equal(current.phase, 'requested');
    assert.equal(current.policyRevision, null);
    assert.equal(ok(await s.store.admit({ ...key, brief: fixtureBrief(), policyRevision: 'fixture-policy-1' })).phase, 'admitted');
  } finally { await s.close(); }
});

test('T19 B0 잘못된 verifier revision은 묶음 칸에 남지 않아 같은 generation을 고쳐 진행할 수 있다', async () => {
  const s = await setup();
  try {
    const r = await driveTo(s.store, 'snapshot_ready');
    const key = { changeId: r.id, generation: 1 };
    for (const bad of ['', 'has space', '-leading', 'x'.repeat(129)]) failure(await s.store.startVerification({ ...key, verifierRevision: bad }), 'invalid_input');
    assert.equal(ok(await s.store.generationRecord(key)).verifierRevision, null);
    assert.equal(ok(await s.store.get(r.id)).phase, 'snapshot_ready');
    assert.equal(ok(await s.store.startVerification({ ...key, verifierRevision: 'fixture-verifier-1' })).verifierRevision, 'fixture-verifier-1');
  } finally { await s.close(); }
});

test('T19 B0 삭제만 있는 artifact도 빈 blob 단계를 지나 tree까지 게시할 수 있다', async () => {
  const s = await setup();
  try {
    const r = await newRequest(s.store);
    const key = { changeId: r.id, generation: 1 };
    const patch = '--- a/src/old.ts\n+++ /dev/null\n';
    const manifest = { ...fixtureManifest(), patchSha256: sha256Hex(Buffer.from(patch)),
      entries: [{ path: 'src/old.ts', mode: '100644' as const, changeKind: 'deleted' as const, blobSha: git('old'), sha256: hex('old'), size: 3 }] };
    ok(await s.store.admit({ ...key, brief: fixtureBrief(), policyRevision: 'fixture-policy-1' }));
    ok(await s.store.pinBase({ ...key, baseCommit: git('b'), baseTree: git('t0') }));
    ok(await s.store.recordSnapshot({ ...key, manifest, files: [], patch, transportBytes: 1024 }));
    const bundle = ok(await s.store.startVerification({ ...key, verifierRevision: 'fixture-verifier-1' }));
    ok(await s.store.recordVerification({ ...key, receipt: fixtureVerification({ bundle }) }));
    ok(await s.store.finishVerification(key));
    await insertChildJob(s.db, 'fixture-delete-review');
    ok(await s.store.linkChildJob({ ...key, jobId: 'fixture-delete-review', role: 'review' }));
    ok(await s.store.recordReview({ ...key, receipt: fixtureReview({ bundle, jobId: 'fixture-delete-review' }) }));
    const subject = ok(await s.store.prepareApproval({ ...key, publication: fixtureMetadata(), ciFingerprint: hex('ci') }));
    ok(await s.store.approve({ ...key, approvalDigest: subject.digest, eventId: newEvent(), actor: OWNER }));
    ok(await s.store.transition({ ...key, from: 'approved', to: 'publishing', reason: null }));

    failure(await s.store.recordEffectIntent({ ...stageKey(r.id, 'blob'), requestDigest: hex('blob'), expected: { stage: 'blob', shas: [git('old')] } }), 'evidence_mismatch');
    ok(await s.store.recordEffectIntent({ ...stageKey(r.id, 'blob'), requestDigest: hex('blob'), expected: { stage: 'blob', shas: [] } }));
    const claim = ok(await s.store.claimEffect(stageKey(r.id, 'blob')));
    ok(await s.store.confirmEffect({ ...stageKey(r.id, 'blob'), leaseId: claim.leaseId, result: { stage: 'blob', shas: [] } }));
    ok(await intent(s.store, r.id, 'tree'));
  } finally { await s.close(); }
});

test('T19 B0 취소·끝 상태 뒤: 새 intent·claim은 막히고 미전송은 닫히며 이미 보낸 effect는 대조로 남는다', async () => {
  const s = await setup();
  try {
    const pending = await driveTo(s.store, 'publishing');
    const pendingKey = { changeId: pending.id, generation: 1 };
    ok(await intent(s.store, pending.id, 'blob'));
    ok(await s.store.transition({ ...pendingKey, from: 'publishing', to: 'cancelled', reason: 'user_cancelled' }));
    failure(await s.store.claimEffect(stageKey(pending.id, 'blob')), 'phase_conflict');
    const [abandoned] = await s.db.query<{ state: string; blocked_reason: string; resolution: string }>(
      `SELECT state,blocked_reason,resolution FROM change_delivery_effects WHERE change_id=$1`, [pending.id]).then(r => r.rows);
    assert.deepEqual(abandoned, { state: 'blocked', blocked_reason: 'abandoned_unsent', resolution: 'not_sent' });
    assert.deepEqual(await s.store.unresolvedEffects({ changeId: pending.id }), []);
    failure(await intent(s.store, pending.id, 'tree'), 'phase_conflict');
    await rawError(s.db.query(`UPDATE change_delivery_effects SET state='sending',lease_id='x',lease_until=1 WHERE change_id=$1`, [pending.id]), /effect_transition_not_allowed/);

    const sending = await driveTo(s.store, 'publishing');
    const sendingKey = stageKey(sending.id, 'blob');
    ok(await intent(s.store, sending.id, 'blob'));
    const claim = ok(await s.store.claimEffect(sendingKey));
    ok(await s.store.transition({ changeId: sending.id, generation: 1, from: 'publishing', to: 'cancelled', reason: 'user_cancelled' }));
    const stillSending = await s.store.unresolvedEffects({ changeId: sending.id });
    assert.deepEqual(stillSending.map(e => e.state), ['sending']);
    ok(await s.store.markEffectUnknown({ ...sendingKey, leaseId: claim.leaseId, code: 'response_lost' }));
    ok(await s.store.confirmEffect({ ...sendingKey, leaseId: null, result: fixtureResult('blob', sending.id) }));

    // 트리거 자체도 pending→sending을 막는다(코드 선검사를 건너뛰었을 때).
    const raw = await driveTo(s.store, 'publishing');
    ok(await intent(s.store, raw.id, 'blob'));
    await s.db.query(`UPDATE change_approvals SET invalidated_at=1,invalidated_reason='fixture' WHERE change_id=$1`, [raw.id]);
    await rawError(s.db.query(`UPDATE change_delivery_effects SET state='sending',lease_id='x',lease_until=1 WHERE change_id=$1`, [raw.id]), /approval_required/);
    failure(await s.store.claimEffect(stageKey(raw.id, 'blob')), 'approval_missing');
    failure(await intent(s.store, raw.id, 'tree'), 'approval_missing');
  } finally { await s.close(); }
});

test('T19 B0 미해소 effect가 있으면 새 generation을 열지 못하고 사람 해소 뒤에 열린다', async () => {
  const s = await setup();
  try {
    const r = await driveTo(s.store, 'publishing');
    const key = stageKey(r.id, 'blob');
    const generationKey = { changeId: r.id, generation: 1 };
    ok(await intent(s.store, r.id, 'blob'));
    const claim = ok(await s.store.claimEffect(key));
    ok(await s.store.markEffectUnknown({ ...key, leaseId: claim.leaseId, code: 'response_lost' }));
    ok(await s.store.transition({ ...generationKey, from: 'publishing', to: 'superseded', reason: 'base_moved' }));
    failure(await s.store.startNextGeneration(generationKey), 'unresolved_effects');
    await rawError(s.db.query(`UPDATE change_requests SET generation=2,phase='requested',brief=NULL,brief_digest=NULL,policy_revision=NULL WHERE id=$1`, [r.id]), /unresolved_effects/);
    failure(await s.store.resolveBlockedEffect({ ...key, actor: OWNER, resolution: 'not_published' }), 'effect_conflict');
    ok(await s.store.blockEffect({ ...key, reason: 'operator_blocked' }));
    assert.equal(await phaseOf(s.store, r.id), 'superseded', '끝 상태 부모는 다시 움직이지 않는다');
    failure(await s.store.startNextGeneration(generationKey), 'unresolved_effects');
    failure(await s.store.resolveBlockedEffect({ ...key, actor: 'someone-else', resolution: 'not_published' }), 'owner_mismatch');
    const resolved = ok(await s.store.resolveBlockedEffect({ ...key, actor: OWNER, resolution: 'not_published' }));
    assert.equal(resolved.resolution, 'not_published');
    failure(await s.store.resolveBlockedEffect({ ...key, actor: OWNER, resolution: 'not_published' }), 'effect_conflict');
    await rawError(s.db.query(`UPDATE change_delivery_effects SET resolution='published_recorded' WHERE change_id=$1`, [r.id]), /effect_resolution_immutable/);
    assert.equal(ok(await s.store.startNextGeneration(generationKey)).generation, 2);
    // 해소돼도 기록은 지워지지 않고 그 generation에서 다음 stage를 열지 않는다.
    assert.equal(await count(s.db, `change_delivery_effects WHERE change_id=$1`, [r.id]), 1);
  } finally { await s.close(); }
});

test('T19 B0 게시 중 blocked 표시는 부모도 닫는다', async () => {
  const s = await setup();
  try {
    const r = await driveTo(s.store, 'publishing');
    const key = stageKey(r.id, 'blob');
    ok(await intent(s.store, r.id, 'blob'));
    ok(await s.store.claimEffect(key));
    ok(await s.store.blockEffect({ ...key, reason: 'tree_mismatch' }));
    const row = ok(await s.store.get(r.id));
    assert.deepEqual([row.phase, row.phaseReason], ['blocked', 'effect_blocked']);
    assert.equal(await count(s.db, `change_approvals WHERE change_id=$1 AND invalidated_at IS NULL`, [r.id]), 0);
    failure(await s.store.blockEffect({ ...key, reason: 'tree_mismatch' }), 'effect_conflict');
  } finally { await s.close(); }
});

test('T19 B0 병합·배포: 게시한 head가 아니면 merged로 못 가고 H·M은 다시 못 바꾸며 오래된 관측은 덮지 못한다', async () => {
  const s = await setup();
  try {
    const r = await driveTo(s.store, 'proposed');
    const key = { changeId: r.id, generation: 1 };
    failure(await s.store.recordMerge({ ...key, prNumber: 7, headSha: git('human'), mergeCommit: git('m') }), 'head_mismatch');
    failure(await s.store.recordMerge({ ...key, prNumber: 8, headSha: git('h'), mergeCommit: git('m') }), 'pull_mismatch');
    assert.equal(await phaseOf(s.store, r.id), 'proposed');
    const pending = { state: 'pending' as const, headSha: git('h'), mergeCommit: git('m'), configCommit: null, imageDigest: null, argoObservedAt: null, workloadObservedAt: null, observedAt: s.clock.now, reason: null };
    failure(await s.store.recordDeployment({ ...key, observation: pending }), 'phase_conflict');
    ok(await s.store.recordMerge({ ...key, prNumber: 7, headSha: git('h'), mergeCommit: git('m') }));
    assert.deepEqual(ok(await s.store.deployment(key)), { ...pending, prNumber: 7, observedAt: s.clock.now });
    ok(await s.store.transition({ ...key, from: 'merged', to: 'observing_deploy', reason: null }));
    const observed = { state: 'observed' as const, headSha: git('h'), mergeCommit: git('m'), configCommit: git('k'), imageDigest: `sha256:${hex('d')}`, argoObservedAt: s.clock.now + 1, workloadObservedAt: s.clock.now + 2, observedAt: s.clock.now + 3, reason: null };
    failure(await s.store.recordDeployment({ ...key, observation: { ...observed, mergeCommit: git('other') } }), 'deployment_conflict');
    failure(await s.store.recordDeployment({ ...key, observation: { ...observed, configCommit: null } }), 'invalid_input');
    ok(await s.store.recordDeployment({ ...key, observation: observed }));
    assert.equal(ok(await s.store.deployment(key)).state, 'observed');
    failure(await s.store.recordDeployment({ ...key, observation: { ...pending, observedAt: observed.observedAt - 1 } }), 'deployment_stale');
    assert.equal(ok(await s.store.deployment(key)).imageDigest, observed.imageDigest);
    await rawError(s.db.query(`UPDATE change_deployments SET state='observed',config_commit=NULL WHERE change_id=$1`, [r.id]), /check/i);
    failure(await s.store.deployment({ changeId: r.id, generation: 2 }), 'not_found');
  } finally { await s.close(); }
});

test('T19 B0 다른 generation의 receipt·effect는 현재 generation이 받지 않는다', async () => {
  const s = await setup();
  try {
    const r = await driveTo(s.store, 'publishing');
    ok(await intent(s.store, r.id, 'blob'));
    failure(await s.store.claimEffect({ changeId: r.id, generation: 2, stage: 'blob' }), 'not_found');
    failure(await s.store.recordEffectIntent({ changeId: r.id, generation: 2, stage: 'blob', requestDigest: hex('r'), expected: fixtureExpected('blob', r.id) }), 'phase_conflict');
    const stages = (await s.db.query<{ stage: string }>(`SELECT stage FROM change_delivery_effects WHERE change_id=$1`, [r.id])).rows.map(row => row.stage);
    assert.deepEqual(stages, ['blob']);
    assert.deepEqual(new Set(EFFECT_STAGES).has('blob'), true);
  } finally { await s.close(); }
});

// PGlite는 다중 문장을 exec로만 받는다.
function migrationDatabase(pg: PGlite): Database {
  return {
    query: async <T>(sql: string, params: unknown[] = []) => params.length
      ? pg.query<T>(sql, params)
      : { rows: ((await pg.exec(sql)).at(-1)?.rows ?? []) as T[] },
    transaction: fn => pg.transaction(tx => fn({ query: (sql, params = []) => tx.query(sql, params), transaction: () => { throw new Error('nested'); } })),
  };
}
const OLD_TABLES = `table_schema='public' AND table_name NOT LIKE 'change\\_%' AND table_name <> 'schema_migrations'`;
const schemaOf = async (db: Database) => JSON.stringify((await db.query(`SELECT table_name,column_name,data_type,is_nullable,column_default
  FROM information_schema.columns WHERE ${OLD_TABLES} ORDER BY table_name,ordinal_position`)).rows);
const constraintsOf = async (db: Database) => JSON.stringify((await db.query(`SELECT conrelid::regclass::text AS t,conname,pg_get_constraintdef(oid) AS d FROM pg_constraint
  WHERE connamespace='public'::regnamespace AND conrelid<>0 AND conrelid::regclass::text NOT LIKE 'change\\_%' ORDER BY t,conname`)).rows);

test('T19 B0 migration: 016 DB에 017만 더하고 기존 표·제약·행을 바꾸지 않으며 파일을 다시 돌려도 그대로다', async () => {
  const pg = new PGlite();
  try {
    const db = migrationDatabase(pg);
    const upTo016 = MIGRATIONS.filter(file => Number.parseInt(file, 10) <= 16);
    assert.equal(upTo016.length, MIGRATIONS.length - 1);
    for (const file of upTo016) await pg.exec(await readFile(`migrations/${file}`, 'utf8'));
    await seedConversation(db);
    await insertChildJob(db, 'existing-job', 'task');
    const schema = await schemaOf(db);
    const constraints = await constraintsOf(db);
    const jobs = JSON.stringify((await db.query('SELECT * FROM jobs')).rows);

    assert.deepEqual(await migrate(db), [17]);
    assert.equal(await schemaOf(db), schema);
    assert.equal(await constraintsOf(db), constraints);
    assert.equal(JSON.stringify((await db.query('SELECT * FROM jobs')).rows), jobs);
    assert.deepEqual(await migrate(db), []);

    const store = new ChangeStore(db, () => 1);
    const r = await newRequest(store);
    // 파일을 직접 다시 돌려도(버전 기록이 사라진 복구 상황) 오류·행 변화가 없다.
    await pg.exec(await readFile('migrations/017_change_pr.sql', 'utf8'));
    assert.equal(ok(await store.get(r.id)).phase, 'requested');
    assert.equal((await db.query('SELECT 1 FROM change_requests')).rows.length, 1);
    await rawError(db.query(`UPDATE change_requests SET phase='authoring' WHERE id=$1`, [r.id]), /transition_not_allowed/);
  } finally { await pg.close(); }
});

test('T19 B0 017은 기존 표를 고치는 문장이 없고 시드 행을 넣지 않는다', async () => {
  const sql = await readFile('migrations/017_change_pr.sql', 'utf8');
  for (const match of sql.matchAll(/ALTER\s+TABLE\s+(?:IF\s+EXISTS\s+)?([a-z_]+)/gi)) assert.match(match[1]!, /^change_/);
  for (const match of sql.matchAll(/CREATE\s+TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?([a-z_]+)/gi)) assert.match(match[1]!, /^change_/);
  for (const match of sql.matchAll(/CREATE\s+(?:OR\s+REPLACE\s+)?TRIGGER\s+[a-z_]+\s+(?:BEFORE|AFTER)[^;]*?\sON\s+([a-z_]+)/gi)) assert.match(match[1]!, /^change_/);
  const inserts = [...sql.matchAll(/INSERT\s+INTO\s+([a-z_]+)/gi)].map(m => m[1]);
  assert.deepEqual(inserts, ['schema_migrations']);
});

test('T19 B0 phase 표의 모든 끝 상태와 단계가 CHECK에 있어 코드가 쓰는 값이 DB에서 막히지 않는다', async () => {
  const s = await setup();
  try {
    const definition = (await s.db.query<{ d: string }>(`SELECT pg_get_constraintdef(oid) AS d FROM pg_constraint WHERE conname='change_requests_phase_check'`)).rows[0]!.d;
    for (const phase of CHANGE_PHASES as readonly ChangePhase[]) assert.ok(definition.includes(`'${phase}'`), phase);
    const effect = (await s.db.query<{ d: string }>(`SELECT pg_get_constraintdef(oid) AS d FROM pg_constraint WHERE conname='change_delivery_effects_state_check'`)).rows[0]!.d;
    for (const state of EFFECT_STATES as readonly EffectState[]) assert.ok(effect.includes(`'${state}'`), state);
  } finally { await s.close(); }
});
