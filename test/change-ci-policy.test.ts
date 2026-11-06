import { test } from 'node:test';
import assert from 'node:assert/strict';
import { gitBlobSha } from '../src/change-contracts.js';
import { evaluateCi, parseWorkflowSubset, readCiSnapshot } from '../src/change-ci-policy.js';
import type { CiPolicy, CiSnapshot } from '../src/change-ci-policy.js';

// 합성 workflow다. 실제 저장소의 파일을 복사하지 않았다.
const blob = (text: string) => gitBlobSha(Buffer.from(text));
const USES = 'fixture-org/fixture-platform/.github/workflows/app-build.yaml@app-build-v1.0.1';
const REUSABLE = `name: app-build
on:
  workflow_call:
    inputs:
      image:
        type: string
        required: false
jobs:
  build:
    runs-on: ubuntu-latest
    permissions:
      contents: read
    steps:
      - uses: actions/checkout@${'a'.repeat(40)} # v4
        with:
          persist-credentials: false
      - name: 시험
        run: |
          echo "ok: yes"
          ls *.ts
`;
const CALLER = `name: build
"on":
  pull_request:
  push:
    branches: [main]
permissions:
  contents: read
jobs:
  build:
    uses: ${USES}
    permissions:
      contents: read
      packages: write
      id-token: write
    with:
      image: fixture
`;
const ciPolicy = (overrides: Partial<CiPolicy> = {}): CiPolicy => ({
  approvedFingerprint: 'f'.repeat(64), reusable: [{ uses: USES, blobSha: blob(REUSABLE) }], pushBranches: ['main'], ...overrides,
});
const snapshot = (caller = CALLER, reusable = REUSABLE): CiSnapshot => ({
  files: [{ path: '.github/workflows/build.yaml', mode: '100644', blobSha: blob(caller) }],
  workflows: [{ path: '.github/workflows/build.yaml', blobSha: blob(caller), text: caller }],
  reusable: [{ uses: USES, blobSha: blob(reusable), text: reusable }],
});
function approved(snap = snapshot()) {
  const first = evaluateCi(snap, ciPolicy());
  assert.equal(first.ok, false);
  assert.equal((first as { reason: string }).reason, 'ci_fingerprint_unapproved');
  const fingerprint = (first as { fingerprint?: string }).fingerprint!;
  return { policy: ciPolicy({ approvedFingerprint: fingerprint }), fingerprint };
}
const closed = (caller: string, reason: string, policy?: CiPolicy, reusable?: string) => {
  const result = evaluateCi(snapshot(caller, reusable ?? REUSABLE), policy ?? ciPolicy());
  assert.equal(result.ok, false, `닫혀야 한다: ${reason}`);
  assert.equal((result as { reason: string }).reason, reason);
};

test('T19 B3 CI: 승인된 형태·fingerprint만 통과한다', () => {
  const { policy, fingerprint } = approved();
  const result = evaluateCi(snapshot(), policy);
  assert.deepEqual(result, { ok: true, fingerprint });
});

test('T19 B3 CI: workflow·reusable·보조 파일이 바뀌면 fingerprint가 바뀌어 닫힌다', () => {
  const { policy } = approved();
  const changed = `${CALLER}# 주석 추가\n`;
  assert.equal((evaluateCi(snapshot(changed), policy) as { reason: string }).reason, 'ci_fingerprint_unapproved');
  const withAction = snapshot();
  withAction.files.push({ path: '.github/actions/x/action.yaml', mode: '100644', blobSha: blob('x') });
  assert.equal((evaluateCi(withAction, policy) as { reason: string }).reason, 'ci_fingerprint_unapproved');
  const added = snapshot();
  added.files.push({ path: '.github/workflows/other.yaml', mode: '100644', blobSha: blob(CALLER) });
  added.workflows.push({ path: '.github/workflows/other.yaml', blobSha: blob(CALLER), text: CALLER });
  assert.equal((evaluateCi(added, policy) as { reason: string }).reason, 'ci_fingerprint_unapproved');
  // 실행 비트만 바뀌어도 형태가 다르다.
  const mode = snapshot();
  mode.files[0]!.mode = '100755';
  assert.equal((evaluateCi(mode, policy) as { reason: string }).reason, 'ci_fingerprint_unapproved');
});

test('T19 B3 CI 거부: bot 브랜치 push가 배포를 부른다', () => {
  closed(CALLER.replace('branches: [main]', 'branches: [main, "bot/**"]'), 'ci_push_branch_unapproved');
  closed(CALLER.replace('branches: [main]', 'branches: ["**"]'), 'ci_push_branch_unapproved');
  closed(CALLER.replace('    branches: [main]\n', ''), 'ci_push_unfiltered');
  closed(CALLER.replace('    branches: [main]\n', '    branches-ignore: [wip]\n'), 'ci_push_filter_unknown');
  closed(CALLER.replace('    branches: [main]\n', '    tags: ["v*"]\n'), 'ci_push_filter_unknown');
  closed(`name: x\non: push\njobs:\n  a:\n    uses: ${USES}\n`, 'ci_push_unfiltered');
  closed(`name: x\non: [pull_request, push]\njobs:\n  a:\n    uses: ${USES}\n`, 'ci_push_unfiltered');
});

test('T19 B3 CI 거부: pull_request_target·workflow_run과 모르는 트리거', () => {
  for (const trigger of ['pull_request_target', 'workflow_run', 'workflow_dispatch', 'repository_dispatch', 'issue_comment', 'schedule', 'pull_request_review']) {
    closed(CALLER.replace('  pull_request:\n', `  pull_request:\n  ${trigger}:\n`), 'ci_trigger_unapproved');
  }
  closed(`name: x\non: pull_request_target\njobs:\n  a:\n    uses: ${USES}\n`, 'ci_trigger_unapproved');
  closed(`name: x\njobs:\n  a:\n    uses: ${USES}\n`, 'ci_trigger_missing');
});

test('T19 B3 CI 거부: 동적·미승인·이동한 참조', () => {
  closed(CALLER.replace(USES, 'fixture-org/fixture-platform/.github/workflows/app-build.yaml@${{ github.ref }}'), 'ci_reference_dynamic');
  closed(CALLER.replace(USES, 'fixture-org/fixture-platform/.github/workflows/app-build.yaml@main'), 'ci_reference_unapproved');
  closed(CALLER.replace(USES, 'evil-org/x/.github/workflows/app-build.yaml@app-build-v1.0.1'), 'ci_reference_unapproved');
  closed(CALLER.replace(USES, './.github/workflows/local.yaml'), 'ci_reference_unapproved');
  // 태그가 움직여 다른 blob으로 해석되면 승인한 값과 다르다.
  closed(CALLER, 'ci_reusable_moved', undefined, `${REUSABLE}# 이동\n`);
  const missing = snapshot();
  missing.reusable = [];
  assert.equal((evaluateCi(missing, ciPolicy()) as { reason: string }).reason, 'ci_reusable_unreadable');
});

test('T19 B3 CI 거부: step의 action은 40자 SHA 고정만 받는다', () => {
  const steps = (uses: string) => `name: x\non:\n  pull_request:\njobs:\n  a:\n    runs-on: ubuntu-latest\n    steps:\n      - uses: ${uses}\n`;
  closed(steps('actions/checkout@v4'), 'ci_action_unpinned');
  closed(steps('docker://alpine:3'), 'ci_action_unpinned');
  closed(steps('./.github/actions/local'), 'ci_action_unpinned');
  closed(steps('actions/${{ matrix.a }}@v1'), 'ci_reference_dynamic');
  assert.equal((evaluateCi(snapshot(steps(`actions/checkout@${'b'.repeat(40)}`)), ciPolicy()) as { reason: string }).reason, 'ci_fingerprint_unapproved');
});

test('T19 B3 CI 거부: PR head를 받아 권한 있는 job에서 돌리는 형태', () => {
  const checkout = (ref: string) => `name: x\non:\n  pull_request:\njobs:\n  a:\n    runs-on: ubuntu-latest\n    permissions:\n      contents: write\n    steps:\n      - uses: actions/checkout@${'b'.repeat(40)}\n        with:\n          ref: ${ref}\n`;
  closed(checkout('${{ github.event.pull_request.head.sha }}'), 'ci_pr_head_checkout');
  closed(checkout('${{ github.head_ref }}'), 'ci_pr_head_checkout');
  closed(`name: x\non:\n  pull_request:\njobs:\n  a:\n    uses: ${USES}\n    secrets: inherit\n`, 'ci_secrets_inherit');
  closed(`name: x\non:\n  pull_request:\npermissions: write-all\njobs:\n  a:\n    uses: ${USES}\n`, 'ci_permissions_write_all');
  closed(`name: x\non:\n  pull_request:\njobs:\n  a:\n    runs-on: [self-hosted, linux]\n    steps:\n      - run: echo\n`, 'ci_self_hosted');
  // GitHub은 라벨 대소문자를 가리지 않고, 러너 그룹은 라벨 없이 자체 러너로 간다.
  closed(`name: x\non:\n  pull_request:\njobs:\n  a:\n    runs-on: [Self-Hosted, linux]\n    steps:\n      - run: echo\n`, 'ci_self_hosted');
  closed(`name: x\non:\n  pull_request:\njobs:\n  a:\n    runs-on:\n      group: fixture-runners\n    steps:\n      - run: echo\n`, 'ci_self_hosted');
  closed(`name: x\non:\n  pull_request:\njobs:\n  a:\n    runs-on: \${{ matrix.os }}\n    steps:\n      - run: echo\n`, 'ci_self_hosted');
  // reusable 안의 같은 형태도 닫는다.
  const bad = REUSABLE.replace('persist-credentials: false', 'ref: ${{ github.event.pull_request.head.sha }}');
  closed(CALLER, 'ci_pr_head_checkout', ciPolicy({ reusable: [{ uses: USES, blobSha: blob(bad) }] }), bad);
  const target = REUSABLE.replace('  workflow_call:\n', '  workflow_call:\n  pull_request_target:\n');
  closed(CALLER, 'ci_trigger_unapproved', ciPolicy({ reusable: [{ uses: USES, blobSha: blob(target) }] }), target);
});

test('T19 B3 CI 거부: 검사할 수 없는 YAML은 일반 파서로 추측하지 않고 닫는다', () => {
  for (const text of [
    'name: x\ndefaults: &anchor\n  run:\n    shell: bash\njobs: *anchor\n',
    'on:\n  pull_request:\n<<: {a: b}\njobs: {}\n',
    'on: !!str push\njobs: {}\n',
    'on:\n  pull_request:\non:\n  pull_request:\njobs: {}\n',
    'name: x\n---\non: push\n',
    'name: plain\n  이어지는 줄\non: push\n',
    '? complex\n: value\n',
    'on:\n\tpull_request:\n',
    'jobs: {a: {uses: x}}\non: pull_request\n',
    // 이스케이프한 키는 GitHub에서 "permissions"가 되는데 여기서는 다른 이름으로 보여 검사를 비껴간다.
    'on:\n  pull_request:\n"perm\\u0069ssions": write-all\njobs: {}\n',
  ]) {
    assert.throws(() => parseWorkflowSubset(text), /ci_yaml_unsupported/, JSON.stringify(text));
    const result = evaluateCi(snapshot(text), ciPolicy());
    assert.equal((result as { reason: string }).reason, 'ci_yaml_unsupported', JSON.stringify(text));
  }
  assert.deepEqual(parseWorkflowSubset('a:\n- x\n- y: 1\n  z: "2"\nb: [p, "q"]\nc: |\n  한\n   둘\nd: >-\n  셋\ne:\n'), {
    a: ['x', { y: '1', z: '2' }], b: ['p', 'q'], c: '한\n 둘\n', d: '셋', e: null,
  });
});

test('T19 B3 CI: 스냅샷 읽기는 .github 아래만 읽고 승인된 참조만 해석한다', async () => {
  const reads: string[] = [];
  const reader = {
    readBlobText: async (_target: unknown, sha: string) => { reads.push(`blob:${sha}`); return sha === blob(CALLER) ? CALLER : null; },
    readPinnedWorkflow: async (input: { uses: string }) => { reads.push(`pinned:${input.uses}`); return { blobSha: blob(REUSABLE), text: REUSABLE }; },
  };
  const target = { key: { changeId: 'a'.repeat(32), generation: 1 }, repoId: 7 };
  const leaves = [
    { path: '.github/workflows/build.yaml', mode: '100644', blobSha: blob(CALLER) },
    { path: '.github/dependabot.yaml', mode: '100644', blobSha: blob('d') },
    { path: 'src/a.ts', mode: '100644', blobSha: blob('a') },
  ];
  const snap = await readCiSnapshot(reader, target, leaves, ciPolicy());
  assert.deepEqual(reads, [`blob:${blob(CALLER)}`, `pinned:${USES}`]);
  assert.deepEqual(snap?.files.map(file => file.path), ['.github/dependabot.yaml', '.github/workflows/build.yaml']);
  assert.equal(snap?.workflows.length, 1);
  const missing = await readCiSnapshot({ ...reader, readBlobText: async () => null }, target, leaves, ciPolicy());
  assert.equal(missing, null);
  await assert.rejects(readCiSnapshot(reader, target, [{ path: '.github/workflows/link.yaml', mode: '120000', blobSha: blob('x') }], ciPolicy()), /ci_workflow_mode/);
});
