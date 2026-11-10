import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import {
  ARTIFACT_LIMITS, ApprovalSubjectSchema, ArtifactManifestSchema, CHANGE_AMENDMENT, CHANGE_PHASES, CHANGE_PHASE_TRANSITIONS, ChangeBriefSchema, DEPLOYMENT_STATES,
  DeploymentObservationSchema, EFFECT_STAGES, EFFECT_STATES, EFFECT_TRANSITIONS, EffectExpectedSchema, EffectResultSchema, EvidenceBundleSchema, GENERATION_RESTART,
  PROVENANCE_LABELS, PublicMetadataSchema, ReviewReceiptSchema, TERMINAL_CHANGE_PHASES, UNKNOWN_RECONCILE_MS, VerificationReceiptSchema,
  approvalDigest, artifactDigest, canTransition, canTransitionEffect, canonicalJson, changeBranchName, changeBranchRef, effectResultMatches,
  evidenceBundleDigest, gitBlobSha, isTerminalPhase, labelAllowsAuthorInput, labelIsLowering, newChangeId, nextEffectStage, parseChangeBranch,
  propagateLabel, raiseLabel, sha256Hex, validateArtifactFiles,
} from '../src/change-contracts.js';
import type { ApprovalSubject, ArtifactManifest, ChangePhase, ProvenanceLabel } from '../src/change-contracts.js';
import { fixtureApprovalSubject, fixtureBundle, fixtureManifest, fixtureManifestFiles, fixtureMetadata, fixtureReview, fixtureVerification, git, hex } from './change-store-fixture.js';

const CHANGE = 'a'.repeat(32);

test('T19 B0 전이 표는 phase를 모두 덮고 정확히 이 모양이다', () => {
  const terminal = ['superseded', 'blocked', 'cancelled', 'failed'];
  const stop = ['superseded', 'blocked', 'cancelled', 'failed'];
  assert.deepEqual([...CHANGE_PHASES], ['requested', 'admitted', 'authoring', 'snapshot_ready', 'verifying', 'reviewing',
    'awaiting_publish_approval', 'approved', 'publishing', 'proposed', 'amending', 'merged', 'observing_deploy', ...terminal]);
  assert.deepEqual([...TERMINAL_CHANGE_PHASES], terminal);
  assert.deepEqual(CHANGE_PHASE_TRANSITIONS, {
    requested: ['admitted', 'blocked', 'cancelled', 'failed'],
    admitted: ['authoring', 'blocked', 'cancelled', 'failed'],
    authoring: ['snapshot_ready', ...stop],
    snapshot_ready: ['verifying', ...stop],
    verifying: ['reviewing', ...stop],
    reviewing: ['awaiting_publish_approval', 'authoring', ...stop],
    awaiting_publish_approval: ['approved', ...stop],
    approved: ['publishing', ...stop],
    publishing: ['proposed', ...stop],
    proposed: ['merged', 'amending', 'superseded', 'blocked', 'cancelled'],
    // C27 수정 차례. 실패해도 failed로 가지 않고 proposed로 돌아온다(공개된 PR은 그대로다).
    amending: ['proposed', 'merged', 'blocked', 'cancelled'],
    merged: ['observing_deploy', 'blocked', 'failed'],
    observing_deploy: ['blocked', 'failed'],
    superseded: [], blocked: [], cancelled: [], failed: [],
  });
});

test('T19 B0 끝 상태에서는 나가지 못하고 단계를 건너뛰지 못하며 새 generation은 superseded에서 requested로만 연다', () => {
  for (const from of TERMINAL_CHANGE_PHASES) {
    assert.equal(isTerminalPhase(from), true);
    for (const to of CHANGE_PHASES) assert.equal(canTransition(from, to), false, `${from}->${to}`);
  }
  const main: ChangePhase[] = ['requested', 'admitted', 'authoring', 'snapshot_ready', 'verifying', 'reviewing',
    'awaiting_publish_approval', 'approved', 'publishing', 'proposed', 'merged', 'observing_deploy'];
  for (let i = 0; i < main.length; i++) {
    for (let j = 0; j < main.length; j++) {
      // 뒤로 가는 길은 게시 전 고치기 차례(reviewing → authoring) 하나뿐이다.
      const selfFix = main[i] === 'reviewing' && main[j] === 'authoring';
      assert.equal(canTransition(main[i]!, main[j]!), j === i + 1 || selfFix, `${main[i]}->${main[j]}`);
    }
  }
  assert.deepEqual(GENERATION_RESTART, { from: 'superseded', to: 'requested' });
  // 수정 차례는 proposed와 amending 사이만 오가고 게시 전 단계로 돌아가지 못한다.
  for (const phase of main) {
    assert.equal(canTransition('amending', phase), phase === 'proposed' || phase === 'merged', `amending->${phase}`);
    assert.equal(canTransition(phase, 'amending'), phase === 'proposed', `${phase}->amending`);
  }
  assert.equal(CHANGE_AMENDMENT.maxRounds, 10);
});

test('T19 B0 label 전파는 가장 제한적인 값이고 어떤 입력으로도 낮출 수 없다', () => {
  assert.deepEqual([...PROVENANCE_LABELS], ['public', 'approved_public_summary', 'unknown', 'private']);
  assert.equal(propagateLabel(['public', 'public']), 'public');
  assert.equal(propagateLabel(['public', 'approved_public_summary']), 'approved_public_summary');
  assert.equal(propagateLabel(['approved_public_summary', 'unknown', 'public']), 'unknown');
  assert.equal(propagateLabel(['unknown', 'private']), 'private');
  assert.equal(propagateLabel(['private', 'public']), 'private');
  // 입력이 없다는 것은 출처를 모른다는 뜻이다.
  assert.equal(propagateLabel([]), 'unknown');
  for (const current of PROVENANCE_LABELS) {
    for (const claimed of PROVENANCE_LABELS) {
      const raised = raiseLabel(current, claimed);
      assert.equal(labelIsLowering(current, raised), false, `${current} + ${claimed}`);
      assert.equal(PROVENANCE_LABELS.indexOf(raised) >= PROVENANCE_LABELS.indexOf(current), true);
    }
  }
  assert.equal(raiseLabel('private', 'public'), 'private');
  assert.equal(labelIsLowering('private', 'public'), true);
  assert.equal(labelIsLowering('public', 'private'), false);
  const allowed = (label: ProvenanceLabel) => labelAllowsAuthorInput(label);
  assert.deepEqual(PROVENANCE_LABELS.filter(allowed), ['public', 'approved_public_summary']);
});

test('T19 B0 canonicalJson은 키 순서에 흔들리지 않고 배열 순서는 보존하며 표현 못 하는 값은 거부한다', () => {
  assert.equal(canonicalJson({ b: 1, a: { d: [2, 1], c: null } }), '{"a":{"c":null,"d":[2,1]},"b":1}');
  assert.equal(canonicalJson({ a: { c: null, d: [2, 1] }, b: 1 }), '{"a":{"c":null,"d":[2,1]},"b":1}');
  assert.notEqual(canonicalJson([1, 2]), canonicalJson([2, 1]));
  for (const bad of [undefined, Number.NaN, Number.POSITIVE_INFINITY, () => 1, 1n, new Date(0), { a: undefined }, [undefined]]) {
    assert.throws(() => canonicalJson(bad), /canonical_json_unsupported/);
  }
});

// 승인 digest 대상 필드를 하나씩 바꾼다. 빠진 필드가 있으면 디지스트가 같게 나와 실패한다.
const SUBJECT_CHANGES: Record<string, (subject: ApprovalSubject) => ApprovalSubject> = {
  changeId: s => ({ ...s, changeId: 'b'.repeat(32), branch: changeBranchName('b'.repeat(32), s.bundle.generation) }),
  repoId: s => ({ ...s, bundle: { ...s.bundle, repoId: s.bundle.repoId + 1 } }),
  generation: s => ({ ...s, bundle: { ...s.bundle, generation: 2 }, branch: changeBranchName(s.changeId, 2) }),
  baseCommit: s => ({ ...s, bundle: { ...s.bundle, baseCommit: git('other-base') } }),
  baseTree: s => ({ ...s, bundle: { ...s.bundle, baseTree: git('other-t0') } }),
  resultTree: s => ({ ...s, bundle: { ...s.bundle, resultTree: git('other-t1') } }),
  artifactDigest: s => ({ ...s, bundle: { ...s.bundle, artifactDigest: hex('other-a') } }),
  policyRevision: s => ({ ...s, bundle: { ...s.bundle, policyRevision: 'fixture-policy-2' } }),
  verifierRevision: s => ({ ...s, bundle: { ...s.bundle, verifierRevision: 'fixture-verifier-2' } }),
  baseBranch: s => ({ ...s, baseBranch: 'develop' }),
  branch: s => ({ ...s, branch: changeBranchName('c'.repeat(32), s.bundle.generation), changeId: 'c'.repeat(32) }),
  verificationReceipt: s => ({ ...s, verifications: [{ ...s.verifications[0]!, receiptDigest: hex('other-receipt') }] }),
  verificationCommand: s => ({ ...s, verifications: [{ ...s.verifications[0]!, commandId: 'other-unit' }] }),
  reviewReceipt: s => ({ ...s, review: { ...s.review, receiptDigest: hex('other-review') } }),
  reviewVerdict: s => ({ ...s, review: { ...s.review, verdict: 'pass_with_warnings' } }),
  ciFingerprint: s => ({ ...s, ciFingerprint: hex('other-ci') }),
  title: s => ({ ...s, publication: { ...s.publication, title: '다른 제목' } }),
  body: s => ({ ...s, publication: { ...s.publication, body: '다른 본문' } }),
  commitMessage: s => ({ ...s, publication: { ...s.publication, commitMessage: '다른 메시지' } }),
  authorName: s => ({ ...s, publication: { ...s.publication, author: { ...s.publication.author, name: 'other-bot' } } }),
  authorDate: s => ({ ...s, publication: { ...s.publication, author: { ...s.publication.author, date: '2026-01-02T03:04:06Z' } } }),
  committerEmail: s => ({ ...s, publication: { ...s.publication, committer: { ...s.publication.committer, email: 'other@users.noreply.github.com' } } }),
  committerDate: s => ({ ...s, publication: { ...s.publication, committer: { ...s.publication.committer, date: '2026-01-02T03:04:06Z' } } }),
  draft: s => ({ ...s, publication: { ...s.publication, draft: !s.publication.draft } }),
};

test('T19 B0 승인 digest는 대상 필드가 하나만 바뀌어도 달라진다', () => {
  const base = fixtureApprovalSubject(CHANGE);
  const digest = approvalDigest(base);
  assert.match(digest, /^[0-9a-f]{64}$/);
  const seen = new Set([digest]);
  for (const [name, change] of Object.entries(SUBJECT_CHANGES)) {
    const changed = approvalDigest(ApprovalSubjectSchema.parse(change(base)));
    assert.equal(seen.has(changed), false, name);
    seen.add(changed);
  }
  assert.equal(approvalDigest(structuredClone(base)), digest);
});

test('T19 B0 승인 digest 시험은 스키마의 모든 필드를 덮는다', () => {
  // 필드를 스키마에 추가하고 digest 변이를 빠뜨리면 여기서 걸린다.
  const leaves = (value: unknown, prefix: string): string[] => {
    if (Array.isArray(value)) return value.flatMap((item, index) => leaves(item, `${prefix}[${index}]`));
    if (value && typeof value === 'object') return Object.entries(value).flatMap(([key, item]) => leaves(item, prefix ? `${prefix}.${key}` : key));
    return [prefix];
  };
  assert.deepEqual(leaves(fixtureApprovalSubject(CHANGE), '').sort(), [
    'baseBranch', 'branch', 'bundle.artifactDigest', 'bundle.baseCommit', 'bundle.baseTree', 'bundle.generation', 'bundle.policyRevision', 'bundle.repoId',
    'bundle.resultTree', 'bundle.verifierRevision', 'changeId', 'ciFingerprint', 'publication.author.date', 'publication.author.email', 'publication.author.name',
    'publication.body', 'publication.commitMessage', 'publication.committer.date', 'publication.committer.email', 'publication.committer.name', 'publication.draft',
    'publication.title', 'review.coverage', 'review.receiptDigest', 'review.verdict', 'verifications[0].commandId', 'verifications[0].receiptDigest', 'verifications[0].status',
  ].sort());
});

test('T19 B0 승인 digest는 필드 순서·시험 나열 순서에 흔들리지 않는다', () => {
  const a = fixtureApprovalSubject(CHANGE);
  const reversedKeys = <T>(value: T): T => {
    if (Array.isArray(value)) return value.map(reversedKeys) as T;
    if (value && typeof value === 'object') {
      return Object.fromEntries(Object.entries(value).reverse().map(([key, item]) => [key, reversedKeys(item)])) as T;
    }
    return value;
  };
  assert.equal(approvalDigest(reversedKeys(a)), approvalDigest(a));
  const two = { ...a, verifications: [
    { commandId: 'a-unit', status: 'passed' as const, receiptDigest: hex('a') },
    { commandId: 'b-unit', status: 'passed' as const, receiptDigest: hex('b') },
  ] };
  assert.equal(approvalDigest({ ...two, verifications: [...two.verifications].reverse() }), approvalDigest(two));
});

test('T19 B0 승인 대상은 브랜치·시험·리뷰가 게시 가능한 모양일 때만 받는다', () => {
  const base = fixtureApprovalSubject(CHANGE);
  const rejected: Record<string, unknown> = {
    otherBranch: { ...base, branch: changeBranchName('b'.repeat(32), 1) },
    otherGenerationBranch: { ...base, branch: changeBranchName(CHANGE, 2) },
    failedTest: { ...base, verifications: [{ ...base.verifications[0]!, status: 'failed' }] },
    noTest: { ...base, verifications: [] },
    duplicateTest: { ...base, verifications: [base.verifications[0]!, base.verifications[0]!] },
    partialReview: { ...base, review: { ...base.review, coverage: 'incomplete' } },
    blockedReview: { ...base, review: { ...base.review, verdict: 'blocked' } },
    extra: { ...base, extra: 1 },
  };
  for (const [name, value] of Object.entries(rejected)) assert.equal(ApprovalSubjectSchema.safeParse(value).success, false, name);
});

test('T19 B0 evidence bundle digest도 필드 하나마다 달라지고 형식 틀린 값은 거부한다', () => {
  const bundle = fixtureBundle();
  const digest = evidenceBundleDigest(bundle);
  const reversed = Object.fromEntries(Object.entries(bundle).reverse()) as typeof bundle;
  assert.equal(evidenceBundleDigest(reversed), digest);
  const changes = { repoId: 99, generation: 9, baseCommit: git('x'), baseTree: git('y'), resultTree: git('z'), artifactDigest: hex('q'), policyRevision: 'p-2', verifierRevision: 'v-2' };
  assert.deepEqual(Object.keys(changes).sort(), Object.keys(bundle).sort());
  for (const [key, value] of Object.entries(changes)) {
    assert.notEqual(evidenceBundleDigest({ ...bundle, [key]: value }), digest, key);
  }
  for (const bad of [{ ...bundle, baseCommit: 'main' }, { ...bundle, generation: 0 }, { ...bundle, repoId: 0 }, { ...bundle, artifactDigest: git('x') }, { ...bundle, extra: 1 }]) {
    assert.equal(EvidenceBundleSchema.safeParse(bad).success, false);
  }
});

test('T19 B0 공개 metadata는 고정 신원·시각만 받고 토큰 자리가 없다', () => {
  const base = fixtureMetadata();
  assert.equal(PublicMetadataSchema.safeParse(base).success, true);
  const rejected: Record<string, unknown> = {
    personalEmail: { ...base, author: { ...base.author, email: 'someone@example.com' } },
    localDate: { ...base, author: { ...base.author, date: '2026-01-02T12:04:05+09:00' } },
    multilineTitle: { ...base, title: '제목\n둘째 줄' },
    controlBody: { ...base, body: 'a\u0007b' },
    emptyTitle: { ...base, title: '' },
    token: { ...base, token: 'x' },
  };
  for (const [name, value] of Object.entries(rejected)) assert.equal(PublicMetadataSchema.safeParse(value).success, false, name);
});

test('T19 B0 브랜치 이름은 bot/change/<opaque-id>/g<n>만 만들고 받는다', () => {
  assert.equal(changeBranchName(CHANGE, 1), `bot/change/${CHANGE}/g1`);
  assert.equal(changeBranchRef(CHANGE, 12), `refs/heads/bot/change/${CHANGE}/g12`);
  assert.deepEqual(parseChangeBranch(`bot/change/${CHANGE}/g12`), { changeId: CHANGE, generation: 12 });
  for (const bad of ['main', 'deploy/x', `botx/change/${CHANGE}/g1`, `bot/change/${CHANGE}`, `bot/change/${CHANGE}/g0`, `bot/change/${CHANGE}/g01`,
    `bot/change/${CHANGE}/g1/x`, `refs/heads/bot/change/${CHANGE}/g1`, `bot/change/${CHANGE.toUpperCase()}/g1`, 'bot/change/123456789012345678/g1',
    `bot/change/${CHANGE}/g1000`, `bot/change/../g1`, `bot/change/${CHANGE}/g1\n`]) {
    assert.equal(parseChangeBranch(bad), null, bad);
  }
  for (const [id, generation] of [['123456789012345678', 1], ['제목', 1], [CHANGE, 0], [CHANGE, 1.5], [CHANGE, 1000]] as const) {
    assert.throws(() => changeBranchName(id, generation), /change_branch_invalid/);
  }
});

test('T19 B0 생성한 브랜치는 ruleset의 refs/heads/bot/**/*에 들어맞고 보호 ref는 아니다', () => {
  // 저장소 ruleset의 fnmatch 의미(** 는 경로 구분자를 넘는다)를 정규식으로 옮겼다.
  const botRule = /^refs\/heads\/bot\/(?:[^/]+\/)*[^/]+$/;
  const protectedRule = /^refs\/heads\/(?:main|deploy(?:\/.*)?)$|^refs\/tags\//;
  for (const generation of [1, 2, 999]) {
    const ref = changeBranchRef(newChangeId(), generation);
    assert.match(ref, botRule);
    assert.doesNotMatch(ref, protectedRule);
  }
  for (const other of ['refs/heads/main', 'refs/heads/deploy/x', 'refs/heads/botx/change/a/g1', 'refs/heads/bot', 'refs/tags/bot/a']) assert.doesNotMatch(other, botRule);
});

test('T19 B0 opaque-id는 무작위 32자리 소문자 hex라 snowflake·제목을 담을 수 없다', () => {
  const ids = new Set(Array.from({ length: 64 }, () => newChangeId()));
  assert.equal(ids.size, 64);
  for (const id of ids) assert.match(id, /^[0-9a-f]{32}$/);
});

test('T19 B0 상한 상수는 1 MiB·2 MiB다', () => {
  assert.equal(ARTIFACT_LIMITS.changedContentBytes, 1024 * 1024);
  assert.equal(ARTIFACT_LIMITS.httpBodyBytes, 2 * 1024 * 1024);
});

const withEntries = (entries: ArtifactManifest['entries']) => ({ ...fixtureManifest(), entries });
const entry = (path: string, changeKind: ArtifactManifest['entries'][number]['changeKind'], size = 1): ArtifactManifest['entries'][number] =>
  ({ path, mode: '100644', changeKind, blobSha: git(path), sha256: hex(path), size });

test('T19 B0 manifest는 비정규 경로·순서·중복·디렉터리 충돌·지원 안 하는 mode를 거부한다', () => {
  assert.equal(ArtifactManifestSchema.safeParse(fixtureManifest()).success, true);
  for (const path of ['/abs', '../up', 'a/../b', 'a//b', 'a/./b', 'a\\b', 'a\0b', '', 'a/', '.git/config', 'x/.GIT/hooks', `a\nb`, 'x'.repeat(513)]) {
    assert.equal(ArtifactManifestSchema.safeParse(withEntries([entry(path, 'added')])).success, false, JSON.stringify(path));
  }
  assert.equal(ArtifactManifestSchema.safeParse(withEntries([entry('b', 'added'), entry('a', 'unchanged')])).success, false, '순서');
  assert.equal(ArtifactManifestSchema.safeParse(withEntries([entry('a', 'added'), entry('a', 'unchanged')])).success, false, '중복');
  assert.equal(ArtifactManifestSchema.safeParse(withEntries([entry('a', 'added'), entry('a/b', 'unchanged')])).success, false, '파일·디렉터리 충돌');
  for (const mode of ['120000', '160000', '040000', '100664']) {
    assert.equal(ArtifactManifestSchema.safeParse(withEntries([{ ...entry('a', 'added'), mode } as never])).success, false, mode);
  }
  assert.equal(ArtifactManifestSchema.safeParse(withEntries([entry('a', 'unchanged')])).success, false, '변경 없음');
});

test('T19 B0 manifest 경로 충돌은 T0·T1을 따로 본다: 파일↔디렉터리 교체는 받고 한 트리 안의 충돌은 거부한다', () => {
  const parses = (...entries: ArtifactManifest['entries']) => ArtifactManifestSchema.safeParse(withEntries(entries)).success;
  assert.equal(parses(entry('a', 'deleted'), entry('a/b', 'added')), true, '파일을 지우고 그 자리에 디렉터리');
  assert.equal(parses(entry('a', 'added'), entry('a/b', 'deleted')), true, '디렉터리를 지우고 그 자리에 파일');
  assert.equal(parses(entry('a', 'added'), entry('a/b', 'added')), false, 'T1 안의 충돌');
  assert.equal(parses(entry('a', 'modified'), entry('a/b', 'unchanged')), false, 'T0·T1 모두의 충돌');
  assert.equal(parses(entry('a', 'deleted'), entry('a/b', 'unchanged')), false, 'T0 안의 충돌');
  assert.equal(parses(entry('a', 'deleted'), entry('a/b', 'deleted')), false, 'T0 안의 충돌(둘 다 삭제)');
});

test('T19 B0 내용 변경이 없는 generation의 blob 기대값은 빈 목록이고 빈 결과와만 맞는다', () => {
  const empty = EffectExpectedSchema.parse({ stage: 'blob', shas: [] });
  assert.equal(effectResultMatches(empty, EffectResultSchema.parse({ stage: 'blob', shas: [] })), true);
  assert.equal(effectResultMatches(empty, { stage: 'blob', shas: [git('a')] }), false);
  assert.equal(effectResultMatches(EffectExpectedSchema.parse({ stage: 'blob', shas: [git('a')] }), { stage: 'blob', shas: [] }), false);
});

test('T19 B0 manifest 변경 내용 합계가 1 MiB를 넘으면 자르지 않고 거부한다', () => {
  const limit = ARTIFACT_LIMITS.changedContentBytes;
  assert.equal(ArtifactManifestSchema.safeParse(withEntries([entry('a', 'added', limit)])).success, true);
  assert.equal(ArtifactManifestSchema.safeParse(withEntries([entry('a', 'added', limit), entry('b', 'modified', 1)])).success, false);
  assert.equal(ArtifactManifestSchema.safeParse(withEntries([entry('a', 'added', limit), entry('b', 'unchanged', limit), entry('c', 'deleted', limit), entry('d', 'mode_changed', limit)])).success, true, '내용 변경만 센다');
  const tooMany = Array.from({ length: ARTIFACT_LIMITS.manifestEntries + 1 }, (_, i) => entry(`f${String(i).padStart(6, '0')}`, i === 0 ? 'added' : 'unchanged'));
  assert.equal(ArtifactManifestSchema.safeParse(withEntries(tooMany)).success, false);
  const tooManyChanged = Array.from({ length: ARTIFACT_LIMITS.changedFiles + 1 }, (_, i) => entry(`f${String(i).padStart(6, '0')}`, 'deleted'));
  assert.equal(ArtifactManifestSchema.safeParse(withEntries(tooManyChanged)).success, false);
});

test('T19 B0 artifact digest는 manifest 항목·patch 하나만 바뀌어도 달라지고 키 순서에 흔들리지 않는다', () => {
  const manifest = fixtureManifest();
  const digest = artifactDigest(manifest);
  const first = manifest.entries[0]!;
  const reordered = { entries: manifest.entries.map(e => ({ size: e.size, sha256: e.sha256, blobSha: e.blobSha, changeKind: e.changeKind, mode: e.mode, path: e.path })),
    patchSha256: manifest.patchSha256, resultTree: manifest.resultTree, baseTree: manifest.baseTree, baseCommit: manifest.baseCommit, version: manifest.version } as ArtifactManifest;
  assert.equal(artifactDigest(reordered), digest);
  const mutations: Partial<ArtifactManifest['entries'][number]>[] = [{ mode: '100755' }, { blobSha: git('x') }, { sha256: hex('x') }, { size: first.size + 1 }, { changeKind: 'modified' }];
  for (const change of mutations) assert.notEqual(artifactDigest({ ...manifest, entries: [{ ...first, ...change }, ...manifest.entries.slice(1)] }), digest, JSON.stringify(change));
  assert.notEqual(artifactDigest({ ...manifest, patchSha256: hex('x') }), digest);
  assert.notEqual(artifactDigest({ ...manifest, resultTree: git('x') }), digest);
  assert.notEqual(artifactDigest({ ...manifest, baseTree: git('x') }), digest);
});

test('T19 B0 gitBlobSha는 git hash-object와 같은 값이다', () => {
  // `printf 'hello\n' | git hash-object --stdin`
  assert.equal(gitBlobSha(Buffer.from('hello\n')), 'ce013625030ba8dba906f756967f9e9ca394464a');
  assert.equal(gitBlobSha(Buffer.alloc(0)), 'e69de29bb2d1d6434b8b29ae775ad8c2e48c5391');
  assert.equal(sha256Hex(Buffer.from('hello\n')), createHash('sha256').update('hello\n').digest('hex'));
});

test('T19 B0 파일 바이트 검증은 manifest와 다른 바이트·누락·여분·binary를 거부한다', () => {
  const manifest = fixtureManifest();
  const files = fixtureManifestFiles();
  assert.deepEqual(validateArtifactFiles(manifest, files), { ok: true, changedBytes: files[0]!.content.byteLength });
  const path = files[0]!.path;
  const cases: [string, typeof files, string][] = [
    ['다른 바이트', [{ path, content: Buffer.from('tampered') }], 'content_mismatch'],
    ['누락', [], 'file_missing'],
    ['여분', [...files, { path: 'src/extra.ts', content: Buffer.from('x') }], 'file_unexpected'],
    ['중복', [...files, ...files], 'file_duplicate'],
  ];
  for (const [name, input, reason] of cases) {
    const result = validateArtifactFiles(manifest, input);
    assert.equal(result.ok, false, name);
    if (!result.ok) assert.equal(result.reason, reason, name);
  }
  for (const content of [Buffer.from([0x61, 0x00, 0x62]), Buffer.from([0xff, 0xfe, 0x00])]) {
    const binary = { ...manifest, entries: [manifest.entries[0]!, { ...manifest.entries[1]!, blobSha: gitBlobSha(content), sha256: sha256Hex(content), size: content.byteLength }] };
    const result = validateArtifactFiles(binary, [{ path, content }]);
    assert.equal(result.ok, false);
    if (!result.ok) assert.equal(result.reason, 'binary_content');
  }
});

test('T19 B0 시험 receipt는 상태와 종료 코드가 어긋나면 받지 않는다', () => {
  const ok = fixtureVerification();
  assert.equal(VerificationReceiptSchema.safeParse(ok).success, true);
  const rejected: Record<string, unknown> = {
    passedNonZero: { ...ok, exitCode: 1 },
    passedNoExit: { ...ok, exitCode: null },
    passedTimedOut: { ...ok, timedOut: true },
    passedNoLog: { ...ok, logDigest: null },
    timeoutNotFlagged: { ...ok, status: 'timed_out', timedOut: false },
    failedZero: { ...ok, status: 'failed', exitCode: 0 },
    shell: { ...ok, commandId: 'npm run test && curl x' },
    extra: { ...ok, stdout: 'raw log' },
  };
  for (const [name, value] of Object.entries(rejected)) assert.equal(VerificationReceiptSchema.safeParse(value).success, false, name);
  assert.equal(VerificationReceiptSchema.safeParse({ ...ok, status: 'not_run', exitCode: null, logDigest: null }).success, true);
  assert.equal(VerificationReceiptSchema.safeParse({ ...ok, status: 'timed_out', exitCode: null, timedOut: true }).success, true);
  assert.equal(VerificationReceiptSchema.safeParse({ ...ok, status: 'failed', exitCode: 1 }).success, true);
});

test('T19 B0 리뷰 receipt의 통과 판정은 전체 범위·P0/P1 없음·공개 위험 없음을 요구한다', () => {
  const ok = fixtureReview();
  assert.equal(ReviewReceiptSchema.safeParse(ok).success, true);
  const warn = { ...ok, verdict: 'pass_with_warnings', risks: [{ priority: 'P2', category: 'correctness', code: 'minor_issue' }] };
  assert.equal(ReviewReceiptSchema.safeParse(warn).success, true);
  const rejected: Record<string, unknown> = {
    partial: { ...ok, coverage: 'incomplete' },
    p0: { ...ok, verdict: 'pass_with_warnings', risks: [{ priority: 'P0', category: 'correctness', code: 'bad' }] },
    p1: { ...ok, verdict: 'pass_with_warnings', risks: [{ priority: 'P1', category: 'correctness', code: 'bad' }] },
    dataExposure: { ...ok, verdict: 'pass_with_warnings', risks: [{ priority: 'P3', category: 'data_exposure', code: 'leak' }] },
    passWithRisk: { ...ok, risks: [{ priority: 'P3', category: 'correctness', code: 'minor' }] },
    warningsNoRisk: { ...ok, verdict: 'pass_with_warnings' },
    freeText: { ...ok, summary: '자유문' },
  };
  for (const [name, value] of Object.entries(rejected)) assert.equal(ReviewReceiptSchema.safeParse(value).success, false, name);
  assert.equal(ReviewReceiptSchema.safeParse({ ...ok, verdict: 'blocked', coverage: 'incomplete', risks: [{ priority: 'P0', category: 'data_exposure', code: 'leak' }] }).success, true);
});

test('T19 B0 effect stage·상태 전이·대조 기한 값을 고정한다', () => {
  assert.deepEqual([...EFFECT_STAGES], ['blob', 'tree', 'commit', 'ref', 'pull']);
  assert.deepEqual([...EFFECT_STATES], ['pending', 'sending', 'confirmed', 'unknown', 'blocked']);
  assert.deepEqual(EFFECT_TRANSITIONS, {
    pending: ['sending', 'blocked'], sending: ['pending', 'confirmed', 'unknown', 'blocked'],
    unknown: ['confirmed', 'blocked'], confirmed: [], blocked: [],
  });
  assert.equal(UNKNOWN_RECONCILE_MS, 86_400_000);
  assert.equal(nextEffectStage('blob'), 'tree');
  assert.equal(nextEffectStage('ref'), 'pull');
  assert.equal(nextEffectStage('pull'), null);
  assert.equal(canTransitionEffect('unknown', 'pending'), false);
  assert.equal(canTransitionEffect('sending', 'pending'), true);
});

test('T19 B0 effect 기대값 대조는 식별자가 하나라도 다르면 거짓이다', () => {
  const blobs = EffectExpectedSchema.parse({ stage: 'blob', shas: [git('a'), git('b')] });
  assert.equal(effectResultMatches(blobs, { stage: 'blob', shas: [git('b'), git('a')] }), true);
  assert.equal(effectResultMatches(blobs, { stage: 'blob', shas: [git('a')] }), false);
  const tree = EffectExpectedSchema.parse({ stage: 'tree', baseTree: git('t0'), treeSha: git('t1') });
  assert.equal(effectResultMatches(tree, { stage: 'tree', treeSha: git('t1') }), true);
  assert.equal(effectResultMatches(tree, { stage: 'tree', treeSha: git('t2') }), false);
  assert.equal(effectResultMatches(tree, { stage: 'blob', shas: [] }), false);
  const commit = EffectExpectedSchema.parse({ stage: 'commit', treeSha: git('t1'), parent: git('b'), commitSha: git('h') });
  assert.equal(effectResultMatches(commit, { stage: 'commit', commitSha: git('h'), treeSha: git('t1'), parents: [git('b')] }), true);
  assert.equal(effectResultMatches(commit, { stage: 'commit', commitSha: git('h'), treeSha: git('t1'), parents: [git('b'), git('x')] }), false);
  assert.equal(effectResultMatches(commit, { stage: 'commit', commitSha: git('h'), treeSha: git('t2'), parents: [git('b')] }), false);
  const ref = `refs/heads/bot/change/${CHANGE}/g1`;
  const expectedRef = EffectExpectedSchema.parse({ stage: 'ref', ref, sha: git('h') });
  assert.equal(effectResultMatches(expectedRef, { stage: 'ref', ref, sha: git('h') }), true);
  assert.equal(effectResultMatches(expectedRef, { stage: 'ref', ref, sha: git('other') }), false);
  assert.equal(EffectExpectedSchema.safeParse({ stage: 'ref', ref: 'refs/heads/main', sha: git('h') }).success, false);
  const pull = EffectExpectedSchema.parse({ stage: 'pull', headBranch: changeBranchName(CHANGE, 1), baseBranch: 'main', headSha: git('h'), marker: 'fixture-marker' });
  const result = { stage: 'pull' as const, number: 7, headBranch: changeBranchName(CHANGE, 1), baseBranch: 'main', headSha: git('h') };
  assert.equal(effectResultMatches(pull, result), true);
  assert.equal(effectResultMatches(pull, { ...result, headSha: git('human') }), false);
  assert.equal(effectResultMatches(pull, { ...result, baseBranch: 'develop' }), false);
});

test('T19 B0 배포 관측은 H·M을 따로 받고 observed면 K·D·관측 시각을 모두 요구한다', () => {
  assert.deepEqual([...DEPLOYMENT_STATES], ['pending', 'unknown', 'observed', 'not_applicable', 'blocked']);
  const observed = { state: 'observed', headSha: git('h'), mergeCommit: git('m'), configCommit: git('k'), imageDigest: `sha256:${hex('d')}`, argoObservedAt: 1, workloadObservedAt: 2, observedAt: 3, reason: null };
  assert.equal(DeploymentObservationSchema.safeParse(observed).success, true);
  // squash·rebase에서 H와 M은 다르고, fast-forward면 같을 수 있다. 어느 쪽도 가정하지 않는다.
  assert.equal(DeploymentObservationSchema.safeParse({ ...observed, mergeCommit: observed.headSha }).success, true);
  for (const [name, value] of Object.entries({
    noK: { ...observed, configCommit: null }, noD: { ...observed, imageDigest: null }, noArgo: { ...observed, argoObservedAt: null }, noWorkload: { ...observed, workloadObservedAt: null },
    badDigest: { ...observed, imageDigest: 'latest' }, mutableImage: { ...observed, imageDigest: 'ghcr.io/x:latest' },
    notApplicableNoReason: { ...observed, state: 'not_applicable', configCommit: null, imageDigest: null, argoObservedAt: null, workloadObservedAt: null },
    blockedNoReason: { ...observed, state: 'blocked', configCommit: null, imageDigest: null, argoObservedAt: null, workloadObservedAt: null },
    observedWithReason: { ...observed, reason: 'x_y' },
  })) assert.equal(DeploymentObservationSchema.safeParse(value).success, false, name);
  assert.equal(DeploymentObservationSchema.safeParse({ ...observed, state: 'pending', configCommit: null, imageDigest: null, argoObservedAt: null, workloadObservedAt: null }).success, true);
  assert.equal(DeploymentObservationSchema.safeParse({ ...observed, state: 'not_applicable', configCommit: null, imageDigest: null, argoObservedAt: null, workloadObservedAt: null, reason: 'docs_only' }).success, true);
});

test('T19 B0 brief는 repo·base·경로·검증 ID를 모두 요구하고 빈 정책을 받지 않는다', () => {
  const brief = { summary: '요약', goal: '목표', acceptanceCriteria: ['조건'], repoId: 1, baseBranch: 'main', allowedPaths: ['src/**'], deniedPaths: [], verificationCommandIds: ['smoke-unit'], label: 'public' };
  assert.equal(ChangeBriefSchema.safeParse(brief).success, true);
  for (const bad of [{ ...brief, allowedPaths: [] }, { ...brief, verificationCommandIds: [] }, { ...brief, verificationCommandIds: ['a b'] }, { ...brief, label: 'secret' }, { ...brief, baseBranch: 'refs/heads/main' }, { ...brief, extra: 1 }]) {
    assert.equal(ChangeBriefSchema.safeParse(bad).success, false);
  }
});
