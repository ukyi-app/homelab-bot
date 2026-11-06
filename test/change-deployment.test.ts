import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DEPLOYMENT_SETTLED_STATES, DeploymentObservationSchema } from '../src/change-contracts.js';
import type { ChangeTarget, DeploymentObservation } from '../src/change-contracts.js';
import { ARGOCD_APPLICATIONS, DEPLOY_TARGETS, SERVICES, TEMPLATES } from '../src/catalog.js';
import { DEPLOYMENT_POLL, DeploymentReader, DeploymentTargetError, deploymentPollStep, describeDeployment } from '../src/change-deployment.js';
import { deploymentKubernetesReader, kubernetesClient, publicGithubReader } from '../src/read-transports.js';

// 가짜 HTTP만 쓴다. 실제 클러스터·GitHub에는 닿지 않는다. 값은 모두 합성이다.
const sha = (c: string) => c.repeat(40);
const H = sha('a'), M = sha('b'), K = sha('c'), OLD_REV = sha('d'), NEW_REV = sha('e'), CHART_COMMIT = sha('f');
const D = `sha256:${'1'.repeat(64)}`, OLD_D = `sha256:${'2'.repeat(64)}`;
const NOW = 1_800_000_000_000;
const SMOKE_ID = 9001, CONFIG_ID = 9002;
const REPOSITORY = 'ghcr.io/ukyi-app/homelab-smoke';
const CONFIG = 'ukyi-app/homelab', APP = 'ukyi-app/homelab-smoke';
const NS = 'app-homelab-smoke';
const target = (repoId = SMOKE_ID): ChangeTarget => ({ key: { changeId: '0'.repeat(32), generation: 1 }, repoId });

interface Seen { method: string; url: string; auth: string | null; redirect: string | undefined; accept: string | null }
type Reply = { status?: number; body?: unknown; raw?: string };
const yamlOf = (fields: { repository?: string; digest?: string; revision?: string; hold?: string } = {}) =>
  `repository: ${fields.repository ?? REPOSITORY}\ndigest: ${fields.digest ?? D}\nrevision: ${fields.revision ?? M}\nhold: ${fields.hold ?? 'false'}\n`;
// GitHub contents API는 base64를 60자마다 줄바꿈해 돌려준다.
const fileBody = (text: string) => ({ type: 'file', encoding: 'base64', content: Buffer.from(text).toString('base64').replace(/(.{60})/g, '$1\n') });
const helm = (revision = M, digest = D) => ({ helm: { valuesObject: { repository: REPOSITORY, digest, revision, hold: false, chartVersion: '1.3.0',
  env: { FIXTURE_VALUE_NOT_PROJECTED: 'fixture-values-text' } } } });
// Argo CD Application CR 모양. sync.revision은 chart 태그의 commit이다. K가 아니다.
const application = () => ({
  metadata: { name: 'homelab-smoke', namespace: 'argocd' }, spec: { source: { repoURL: 'fixture', targetRevision: 'app-chart-v1.3.0', ...helm() } },
  status: { health: { status: 'Healthy' }, sync: { status: 'Synced', revision: CHART_COMMIT, comparedTo: { source: helm() } },
    operationState: { phase: 'Succeeded' } },
});
const workload = () => ({
  metadata: { name: 'homelab-smoke', namespace: NS, generation: 7 },
  spec: { replicas: 1, template: { spec: { containers: [{ name: 'app', image: `${REPOSITORY}@${D}` }] } } },
  status: { observedGeneration: 7, readyReplicas: 1, availableReplicas: 1, updatedReplicas: 1 },
});
const pod = (overrides: Record<string, unknown> = {}) => ({
  metadata: { name: 'homelab-smoke-abc', namespace: NS, ownerReferences: [{ kind: 'ReplicaSet' }] },
  status: { phase: 'Running', conditions: [{ type: 'Ready', status: 'True' }],
    containerStatuses: [{ name: 'app', ready: true, imageID: `${REPOSITORY}@${D}` }] }, ...overrides,
});

// 기본값은 전 구간 일치다. 시험은 한 곳만 어긋나게 한다.
function world() {
  const state = {
    imageCommits: [{ sha: K }] as unknown,
    imageText: yamlOf() as string | null,
    compare: { status: 'ahead' } as unknown,
    compareStatus: 200,
    application: application() as unknown,
    workload: workload() as unknown,
    pods: { metadata: {}, items: [pod()] } as unknown,
    commitPulls: [{ number: 12, merge_commit_sha: M, head: { sha: H } }] as unknown,
    pullFiles: [{ filename: 'docs/runbooks-public/a.md', status: 'modified' }] as unknown,
    pull: { number: 12, state: 'closed', merged: true, merge_commit_sha: M, head: { sha: H }, base: { repo: { id: SMOKE_ID, full_name: APP } } } as unknown,
    override: null as ((url: URL) => Reply | undefined) | null,
  };
  const seen: Seen[] = [];
  const route = (url: URL): Reply => {
    const path = url.pathname;
    if (url.origin === 'https://api.github.com') {
      if (path === `/repos/${APP}/pulls/12` || path === `/repos/${CONFIG}/pulls/12`) return { body: state.pull };
      if (path === `/repos/${CONFIG}/commits`) return { body: state.imageCommits };
      if (path === `/repos/${CONFIG}/contents/apps/homelab-smoke/image.yaml`) return state.imageText === null ? { status: 404 } : { body: fileBody(state.imageText) };
      if (path.startsWith(`/repos/${APP}/compare/`)) return { status: state.compareStatus, body: state.compare };
      if (path === `/repos/${CONFIG}/commits/${M}/pulls`) return { body: state.commitPulls };
      if (path === `/repos/${CONFIG}/pulls/12/files`) return { body: state.pullFiles };
    }
    if (url.origin === 'https://k8s.fixture') {
      if (path === '/apis/argoproj.io/v1alpha1/namespaces/argocd/applications/homelab-smoke') return { body: state.application };
      if (path === `/apis/apps/v1/namespaces/${NS}/deployments/homelab-smoke`) return { body: state.workload };
      if (path === `/api/v1/namespaces/${NS}/pods`) return { body: state.pods };
    }
    return { status: 404, body: {} };
  };
  const send = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(String(input));
    const headers = new Headers(init?.headers);
    seen.push({ method: init?.method ?? 'GET', url: url.toString(), auth: headers.get('authorization'), redirect: init?.redirect, accept: headers.get('accept') });
    const reply = state.override?.(url) ?? route(url);
    if (reply.raw !== undefined) return new Response(reply.raw, { status: reply.status ?? 200 });
    return new Response(JSON.stringify(reply.body ?? {}), { status: reply.status ?? 200, headers: { 'content-type': 'application/json' } });
  }) as typeof fetch;
  const client = kubernetesClient({ base: 'https://k8s.fixture', tokenFile: '/fixture/token', caFile: null, readText: async () => 'fixture-sa-token\n', send });
  const services = new Map([[SMOKE_ID, 'homelab-smoke'], [CONFIG_ID, 'homelab']]);
  const reader = new DeploymentReader({ github: publicGithubReader({ send }), kubernetes: deploymentKubernetesReader(client),
    resolveService: repoId => services.get(repoId) ?? null, now: () => NOW, timeoutMs: 200 });
  const observe = (repoId = SMOKE_ID) => reader.observe({ target: target(repoId), headSha: H, mergeCommit: M });
  return { state, seen, reader, observe, send };
}
const expectState = (observation: DeploymentObservation, state: DeploymentObservation['state'], reason: string | null) => {
  assert.equal(observation.state, state, `state ${observation.state} reason ${observation.reason}`);
  assert.equal(observation.reason, reason);
  DeploymentObservationSchema.parse(observation);
};
const mutated = <T>(value: T, change: (copy: any) => void): T => { const copy = structuredClone(value); change(copy); return copy; };

// ---- 병합 읽기 ----

test('readMerge: squash로 H와 M이 달라도 둘을 따로 돌려준다', async () => {
  const { reader } = world();
  assert.deepEqual(await reader.readMerge({ target: target(), prNumber: 12 }), { state: 'merged', prNumber: 12, headSha: H, mergeCommit: M });
});
test('readMerge: 열린 PR과 병합 없이 닫힌 PR을 구분한다', async () => {
  const w = world();
  w.state.pull = { number: 12, state: 'open', merged: false, merge_commit_sha: null, head: { sha: H }, base: { repo: { id: SMOKE_ID, full_name: APP } } };
  assert.deepEqual(await w.reader.readMerge({ target: target(), prNumber: 12 }), { state: 'open' });
  w.state.pull = { number: 12, state: 'closed', merged: false, merge_commit_sha: M, head: { sha: H }, base: { repo: { id: SMOKE_ID, full_name: APP } } };
  assert.deepEqual(await w.reader.readMerge({ target: target(), prNumber: 12 }), { state: 'closed_unmerged' });
});
test('readMerge: 병합으로 나왔는데 merge commit이 없거나 다른 저장소·다른 PR이면 믿지 않는다', async () => {
  const w = world();
  const base = w.state.pull;
  w.state.pull = mutated(base, c => { c.merge_commit_sha = null; });
  await assert.rejects(w.reader.readMerge({ target: target(), prNumber: 12 }), (e: Error) => e instanceof DeploymentTargetError && e.code === 'merge_commit_missing');
  w.state.pull = mutated(base, c => { c.base.repo.id = 1; });
  await assert.rejects(w.reader.readMerge({ target: target(), prNumber: 12 }), (e: Error) => e instanceof DeploymentTargetError && e.code === 'pull_repository_mismatch');
  w.state.pull = mutated(base, c => { c.base.repo.full_name = 'ukyi-app/other'; });
  await assert.rejects(w.reader.readMerge({ target: target(), prNumber: 12 }), (e: Error) => e instanceof DeploymentTargetError && e.code === 'pull_repository_mismatch');
  w.state.pull = mutated(base, c => { c.number = 13; });
  await assert.rejects(w.reader.readMerge({ target: target(), prNumber: 12 }), (e: Error) => e instanceof DeploymentTargetError && e.code === 'pull_number_mismatch');
});
test('readMerge: 미등록 저장소는 요청 없이 거부하고, 조회 실패·스키마 위반은 병합 없음으로 바꾸지 않는다', async () => {
  const w = world();
  await assert.rejects(w.reader.readMerge({ target: target(1), prNumber: 12 }), (e: Error) => e instanceof DeploymentTargetError && e.code === 'deployment_target_unregistered');
  assert.equal(w.seen.length, 0);
  w.state.pull = { number: '12' };
  await assert.rejects(w.reader.readMerge({ target: target(), prNumber: 12 }));
  w.state.override = () => ({ status: 503 });
  await assert.rejects(w.reader.readMerge({ target: target(), prNumber: 12 }));
});

// ---- 전 구간 일치 ----

test('observed: H≠M이어도 M·D가 image.yaml·Argo·workload에서 모두 맞으면 H·M·K·D를 따로 낸다', async () => {
  const { observe } = world();
  const observation = await observe();
  expectState(observation, 'observed', null);
  assert.deepEqual(observation, { state: 'observed', headSha: H, mergeCommit: M, configCommit: K, imageDigest: D,
    argoObservedAt: NOW, workloadObservedAt: NOW, observedAt: NOW, reason: null });
});
test('observed: Argo sync.revision이 chart commit이어도, homelab main에 commit이 더 붙어도 불일치가 아니다', async () => {
  const w = world();
  w.state.application = mutated(application(), c => { c.status.sync.revision = sha('9'); });
  expectState(await w.observe(), 'observed', null);
  // main HEAD를 읽어 대조하는 경로가 없다. image.yaml을 바꾼 commit과 그 내용만 읽는다.
  const github = w.seen.filter(s => s.url.startsWith('https://api.github.com'));
  assert.ok(github.every(s => !/\/branches|\/git\/ref|\/commits\/main/.test(s.url)));
  const list = github.find(s => new URL(s.url).pathname === `/repos/${CONFIG}/commits`);
  assert.ok(list);
  assert.equal(new URL(list.url).searchParams.get('path'), 'apps/homelab-smoke/image.yaml');
  assert.equal(new URL(list.url).searchParams.get('sha'), 'main');
});
test('Argo 값이 K가 아닌 다른 image.yaml과 같으면 observed가 아니다: 내용으로 대조한다', async () => {
  const w = world();
  w.state.application = mutated(application(), c => { c.spec.source = { ...c.spec.source, ...helm(OLD_REV, OLD_D) }; c.status.sync.comparedTo.source = helm(OLD_REV, OLD_D); });
  // sync.revision을 K로 맞춰도 내용이 옛것이면 통과하지 않는다.
  w.state.application = mutated(w.state.application, (c: any) => { c.status.sync.revision = K; });
  expectState(await w.observe(), 'pending', 'argo_config_stale');
});

// ---- image.yaml ----

test('image revision: M보다 오래됐으면 pending이고 K·D를 다른 revision 값으로 채우지 않는다', async () => {
  const w = world();
  w.state.imageText = yamlOf({ revision: OLD_REV, digest: OLD_D });
  w.state.compare = { status: 'behind' };
  const observation = await w.observe();
  expectState(observation, 'pending', 'image_revision_behind');
  assert.equal(observation.configCommit, null);
  assert.equal(observation.imageDigest, null);
  assert.equal(observation.argoObservedAt, null);
  const compare = w.seen.find(s => s.url.includes('/compare/'));
  assert.ok(compare);
  assert.equal(new URL(compare.url).pathname, `/repos/${APP}/compare/${M}...${OLD_REV}`);
});
test('image revision: H가 적혀 있어도 M이 아니면 observed가 아니다(H=M 가정 금지)', async () => {
  const w = world();
  w.state.imageText = yamlOf({ revision: H });
  w.state.compare = { status: 'diverged' };
  expectState(await w.observe(), 'blocked', 'image_revision_unrelated');
});
test('image revision: 더 새 revision이면 M 빌드를 관측할 수 없어 막고, 저장소에 없는 revision도 막는다', async () => {
  const w = world();
  w.state.imageText = yamlOf({ revision: NEW_REV });
  w.state.compare = { status: 'ahead' };
  expectState(await w.observe(), 'blocked', 'image_revision_superseded');
  const other = world();
  other.state.imageText = yamlOf({ revision: NEW_REV });
  other.state.compareStatus = 404;
  expectState(await other.observe(), 'blocked', 'image_revision_unrelated');
});
test('image revision: hold로 고정돼 다른 revision이면 비교 없이 막는다', async () => {
  const w = world();
  w.state.imageText = yamlOf({ revision: OLD_REV, hold: 'true' });
  expectState(await w.observe(), 'blocked', 'image_hold');
  assert.ok(!w.seen.some(s => s.url.includes('/compare/')));
  // M으로 고정된 경우는 M이 배포된 것이므로 막지 않는다.
  const atMerge = world();
  atMerge.state.imageText = yamlOf({ hold: 'true' });
  expectState(await atMerge.observe(), 'observed', null);
});
test('image.yaml: 형식 위반·다른 repository는 막고 그 값을 D로 쓰지 않는다', async () => {
  for (const text of [
    yamlOf({ digest: 'sha256:short' }), yamlOf({ revision: 'main' }), yamlOf({ hold: 'maybe' }),
    `${yamlOf()}extra: value\n`, `${yamlOf()}digest: ${OLD_D}\n`, 'repository: x\n',
  ]) {
    const w = world();
    w.state.imageText = text;
    const observation = await w.observe();
    expectState(observation, 'blocked', 'image_config_invalid');
    assert.equal(observation.imageDigest, null);
  }
  const w = world();
  w.state.imageText = yamlOf({ repository: 'ghcr.io/ukyi-app/other' });
  expectState(await w.observe(), 'blocked', 'image_repository_mismatch');
});
test('image.yaml: 주석·빈 줄은 CI 형식대로 받는다', async () => {
  const w = world();
  w.state.imageText = `# 합성 주석\n\n${yamlOf()}`;
  expectState(await w.observe(), 'observed', null);
});
test('image digest: image.yaml의 D와 Argo가 적용한 digest가 다르면 observed가 아니다', async () => {
  const w = world();
  w.state.imageText = yamlOf({ digest: OLD_D });
  const observation = await w.observe();
  expectState(observation, 'pending', 'argo_config_stale');
  assert.equal(observation.configCommit, K);
  assert.equal(observation.imageDigest, OLD_D);
  assert.equal(observation.workloadObservedAt, null);
});

// ---- Argo ----

test('Argo: 옛 값·미비교·OutOfSync·진행 중·실패를 각각 pending으로 구분한다', async () => {
  const cases: [string, (c: any) => void][] = [
    ['argo_config_stale', c => { c.spec.source = { repoURL: 'fixture', ...helm(OLD_REV, D) }; }],
    ['argo_config_stale', c => { delete c.spec.source.helm; }],
    ['argo_config_stale', c => { c.spec.source.helm.valuesObject.repository = 'ghcr.io/ukyi-app/other'; }],
    ['argo_compare_stale', c => { c.status.sync.comparedTo.source.helm.valuesObject.repository = 'ghcr.io/ukyi-app/other'; }],
    ['argo_compare_stale', c => { c.status.sync.comparedTo.source = helm(OLD_REV, OLD_D); }],
    ['argo_compare_stale', c => { delete c.status.sync.comparedTo; }],
    ['argo_compare_stale', c => { delete c.status; }],
    ['argo_out_of_sync', c => { c.status.sync.status = 'OutOfSync'; }],
    ['argo_out_of_sync', c => { delete c.status.sync.status; }],
    ['argo_sync_running', c => { c.status.operationState.phase = 'Running'; }],
    ['argo_sync_failed', c => { c.status.operationState.phase = 'Failed'; }],
    ['argo_sync_failed', c => { c.status.operationState.phase = 'Error'; }],
  ];
  for (const [reason, change] of cases) {
    const w = world();
    w.state.application = mutated(application(), change);
    const observation = await w.observe();
    expectState(observation, 'pending', reason);
    assert.equal(observation.configCommit, K);
    assert.equal(observation.imageDigest, D);
    assert.equal(observation.argoObservedAt, NOW);
    assert.equal(observation.workloadObservedAt, null);
  }
});
test('Argo: Application이 아직 없으면 pending이고, 다른 객체가 오면 unknown이다', async () => {
  const w = world();
  w.state.override = url => url.pathname.includes('/applications/') ? { status: 404 } : undefined;
  expectState(await w.observe(), 'pending', 'argo_application_missing');
  const other = world();
  other.state.application = mutated(application(), c => { c.metadata.name = 'other'; });
  expectState(await other.observe(), 'unknown', 'kubernetes_response_invalid');
});

// ---- workload ----

test('workload: spec image·세대·ready·pod imageID가 D가 아니면 observed가 아니다', async () => {
  const cases: [string, (s: ReturnType<typeof world>['state']) => void][] = [
    ['workload_image_mismatch', s => { s.workload = mutated(workload(), c => { c.spec.template.spec.containers[0].image = `${REPOSITORY}@${OLD_D}`; }); }],
    ['workload_image_mismatch', s => { s.workload = mutated(workload(), c => { c.spec.template.spec.containers[0].name = 'other'; }); }],
    // 저장소가 달라도 digest만 같다고 받지 않는다.
    ['workload_image_mismatch', s => { s.workload = mutated(workload(), c => { c.spec.template.spec.containers[0].image = `ghcr.io/ukyi-app/other@${D}`; }); }],
    ['workload_generation_stale', s => { s.workload = mutated(workload(), c => { c.status.observedGeneration = 6; }); }],
    ['workload_generation_stale', s => { s.workload = mutated(workload(), c => { delete c.status.observedGeneration; }); }],
    ['workload_unready', s => { s.workload = mutated(workload(), c => { c.status.readyReplicas = 0; }); }],
    ['workload_unready', s => { s.workload = mutated(workload(), c => { c.status.availableReplicas = 0; }); }],
    ['workload_unready', s => { s.workload = mutated(workload(), c => { c.status.updatedReplicas = 0; }); }],
    ['workload_suspended', s => { s.workload = mutated(workload(), c => { c.spec.replicas = 0; }); }],
    ['pod_missing', s => { s.pods = { metadata: {}, items: [] }; }],
    ['pod_image_mismatch', s => { s.pods = { metadata: {}, items: [pod({ status: { phase: 'Running', conditions: [{ type: 'Ready', status: 'True' }], containerStatuses: [{ name: 'app', ready: true, imageID: `${REPOSITORY}@${OLD_D}` }] } })] }; }],
    ['pod_image_mismatch', s => { s.pods = { metadata: {}, items: [pod({ status: { phase: 'Running', conditions: [{ type: 'Ready', status: 'True' }], containerStatuses: [{ name: 'app', ready: true, imageID: '' }] } })] }; }],
    // 옛 파드가 하나라도 남으면 새 파드가 함께 있어도 끝난 것이 아니다.
    ['pod_image_mismatch', s => { s.pods = { metadata: {}, items: [pod(), pod({ status: { phase: 'Running', conditions: [{ type: 'Ready', status: 'True' }], containerStatuses: [{ name: 'app', ready: true, imageID: `${REPOSITORY}@${OLD_D}` }] } })] }; }],
    ['pod_unready', s => { s.pods = { metadata: {}, items: [pod({ status: { phase: 'Running', conditions: [{ type: 'Ready', status: 'False' }], containerStatuses: [{ name: 'app', ready: false, imageID: `${REPOSITORY}@${D}` }] } })] }; }],
    ['pod_unready', s => { s.pods = { metadata: {}, items: [pod({ status: { phase: 'Running', conditions: [{ type: 'Ready', status: 'True' }], containerStatuses: [{ name: 'app', ready: false, imageID: `${REPOSITORY}@${D}` }] } })] }; }],
    ['pod_terminating', s => { s.pods = { metadata: {}, items: [pod({ metadata: { name: 'x', namespace: NS, deletionTimestamp: '2026-11-06T00:00:00Z' } })] }; }],
  ];
  for (const [reason, change] of cases) {
    const w = world();
    change(w.state);
    const observation = await w.observe();
    expectState(observation, 'pending', reason);
    assert.equal(observation.configCommit, K);
    assert.equal(observation.imageDigest, D);
    assert.equal(observation.workloadObservedAt, NOW);
  }
});
test('workload: desired보다 pod가 적으면 observed가 아니다', async () => {
  const w = world();
  w.state.workload = mutated(workload(), c => { c.spec.replicas = 2; c.status.readyReplicas = 2; c.status.availableReplicas = 2; c.status.updatedReplicas = 2; });
  expectState(await w.observe(), 'pending', 'pod_missing');
});
test('workload: Deployment가 없으면 pending이다', async () => {
  const w = world();
  w.state.override = url => url.pathname.includes('/deployments/') ? { status: 404 } : undefined;
  const observation = await w.observe();
  expectState(observation, 'pending', 'workload_missing');
  assert.equal(observation.workloadObservedAt, null);
});
test('workload: 마이그레이션 Job 파드와 끝난 파드는 서비스 파드로 세지 않는다', async () => {
  const w = world();
  const job = pod({ metadata: { name: 'homelab-smoke-migrate-x', namespace: NS, ownerReferences: [{ kind: 'Job' }] },
    status: { phase: 'Running', conditions: [], containerStatuses: [{ name: 'migrate', ready: false, imageID: `${REPOSITORY}@${OLD_D}` }] } });
  const evicted = pod({ status: { phase: 'Failed', conditions: [], containerStatuses: [{ name: 'app', ready: false, imageID: `${REPOSITORY}@${OLD_D}` }] } });
  w.state.pods = { metadata: {}, items: [pod(), job, evicted] };
  expectState(await w.observe(), 'observed', null);
  const only = world();
  only.state.pods = { metadata: {}, items: [job, evicted] };
  expectState(await only.observe(), 'pending', 'pod_missing');
  const list = w.seen.find(s => new URL(s.url).pathname.endsWith('/pods'));
  assert.ok(list);
  assert.equal(new URL(list.url).searchParams.get('labelSelector'), 'homelab.ukyi.app/app=homelab-smoke');
});
test('workload: pod 목록이 잘렸으면 전체를 봤다고 하지 않는다', async () => {
  const w = world();
  w.state.pods = { metadata: { continue: 'token' }, items: [pod()] };
  expectState(await w.observe(), 'unknown', 'kubernetes_response_invalid');
});

// ---- 조회 실패 ----

test('조회 실패: GitHub 실패·거부는 unknown이고 pending·blocked로 바꾸지 않는다', async () => {
  const cases: [Reply | 'throw', string][] = [[{ status: 503 }, 'github_unavailable'], [{ status: 403 }, 'github_refused'], [{ status: 429 }, 'github_refused'],
    [{ raw: 'not json' }, 'github_response_invalid'], ['throw', 'github_unavailable']];
  for (const [reply, reason] of cases) {
    const w = world();
    w.state.override = url => {
      if (url.origin !== 'https://api.github.com') return undefined;
      if (reply === 'throw') throw new TypeError('fetch failed');
      return reply;
    };
    const observation = await w.observe();
    expectState(observation, 'unknown', reason);
    assert.equal(observation.configCommit, null);
    assert.equal(observation.observedAt, NOW);
  }
});
test('조회 실패: compare를 못 읽으면 unknown이다', async () => {
  const w = world();
  w.state.imageText = yamlOf({ revision: OLD_REV });
  w.state.compareStatus = 500;
  expectState(await w.observe(), 'unknown', 'github_unavailable');
});
test('조회 실패: Kubernetes 실패는 unknown이고 이미 확인한 K·D는 남긴다', async () => {
  for (const part of ['/applications/', '/deployments/', '/pods']) {
    for (const [status, reason] of [[503, 'kubernetes_unavailable'], [403, 'kubernetes_refused']] as const) {
      const w = world();
      w.state.override = url => url.pathname.includes(part) ? { status } : undefined;
      const observation = await w.observe();
      expectState(observation, 'unknown', reason);
      assert.equal(observation.configCommit, K);
      assert.equal(observation.imageDigest, D);
    }
  }
});
test('조회 실패: 응답이 오지 않으면 시한에 끊고 unknown이다', async () => {
  const w = world();
  const hanging = (async (_input: string | URL | Request, init?: RequestInit) => new Promise<Response>((_resolve, reject) => {
    init?.signal?.addEventListener('abort', () => reject(init.signal!.reason));
  })) as typeof fetch;
  const client = kubernetesClient({ base: 'https://k8s.fixture', tokenFile: '/x', caFile: null, readText: async () => 'token', send: hanging });
  const reader = new DeploymentReader({ github: publicGithubReader({ send: w.send }), kubernetes: deploymentKubernetesReader(client),
    resolveService: () => 'homelab-smoke', now: () => NOW, timeoutMs: 10 });
  expectState(await reader.observe({ target: target(), headSha: H, mergeCommit: M }), 'unknown', 'kubernetes_unavailable');
});

// ---- 응답 스키마 위반 ----

test('스키마 위반: GitHub 응답 모양이 틀리면 unknown이다', async () => {
  const cases: ((s: ReturnType<typeof world>['state']) => void)[] = [
    s => { s.imageCommits = { items: [] }; },
    s => { s.imageCommits = [{ sha: 'nope' }]; },
    s => { s.override = url => url.pathname.includes('/contents/') ? { body: { type: 'dir', content: [] } } : undefined; },
    s => { s.imageText = yamlOf({ revision: OLD_REV }); s.compare = { status: 42 }; },
  ];
  for (const change of cases) {
    const w = world();
    change(w.state);
    expectState(await w.observe(), 'unknown', 'github_response_invalid');
  }
});
test('스키마 위반: Argo·Deployment·pod 응답 모양이 틀리면 unknown이다', async () => {
  const cases: ((s: ReturnType<typeof world>['state']) => void)[] = [
    s => { s.application = mutated(application(), c => { c.spec.source.helm.valuesObject.digest = 'latest'; }); },
    s => { s.application = mutated(application(), c => { c.status.sync.comparedTo.source.helm.valuesObject.revision = 'main'; }); },
    s => { s.application = mutated(application(), c => { c.status.sync.status = 7; }); },
    s => { s.application = { items: [] }; },
    s => { s.workload = mutated(workload(), c => { c.status.readyReplicas = 'one'; }); },
    s => { s.workload = mutated(workload(), c => { c.metadata.namespace = 'other'; }); },
    s => { s.pods = { items: 'none' }; },
    s => { s.pods = { metadata: {}, items: [{ metadata: {}, status: { containerStatuses: [{ name: 'app', imageID: 3 }] } }] }; },
  ];
  for (const change of cases) {
    const w = world();
    change(w.state);
    const observation = await w.observe();
    expectState(observation, 'unknown', 'kubernetes_response_invalid');
    assert.equal(observation.configCommit, K);
  }
});
test('좁은 투영: Application의 Helm values 다른 키는 관측에 실리지 않는다', async () => {
  const w = world();
  const observation = await w.observe();
  assert.ok(!JSON.stringify(observation).includes('fixture-values-text'));
  const reading = await deploymentKubernetesReader(kubernetesClient({ base: 'https://k8s.fixture', tokenFile: '/x', caFile: null, readText: async () => 'token', send: w.send }))
    .application('homelab-smoke', AbortSignal.timeout(1000));
  assert.ok(!JSON.stringify(reading).includes('fixture-values-text'));
  assert.deepEqual(reading.desired, { repository: REPOSITORY, digest: D, revision: M });
});

// ---- 해당 없음과 미등록 ----

test('docs-only: 배포 영향 없는 경로만 바뀐 설정 저장소 PR은 근거 코드와 함께 not_applicable이다', async () => {
  const w = world();
  w.state.pullFiles = [{ filename: 'docs/runbooks-public/a.md', status: 'modified' }, { filename: 'docs/runbooks-public/b/c.md', status: 'added' },
    { filename: 'docs/runbooks-public/d.md', status: 'renamed', previous_filename: 'docs/runbooks-public/e.md' }];
  const observation = await w.observe(CONFIG_ID);
  expectState(observation, 'not_applicable', 'docs_only');
  assert.equal(observation.configCommit, null);
  assert.equal(observation.imageDigest, null);
});
test('docs-only: 경로 하나라도 밖이면 not_applicable로 닫지 않는다', async () => {
  const cases: unknown[] = [
    [{ filename: 'docs/runbooks-public/a.md', status: 'modified' }, { filename: 'apps/homelab-smoke/values.yaml', status: 'modified' }],
    [{ filename: 'docs/runbooks-public-other/a.md', status: 'modified' }],
    [{ filename: 'docs/runbooks-public/a.md', status: 'renamed', previous_filename: 'platform/x.yaml' }],
    [{ filename: 'docs/runbooks-public/../../apps/x', status: 'modified' }],
  ];
  for (const files of cases) {
    const w = world();
    w.state.pullFiles = files;
    expectState(await w.observe(CONFIG_ID), 'blocked', 'config_change_outside_docs');
  }
});
test('docs-only: 근거를 끝까지 못 읽으면 unknown이다', async () => {
  const many = Array.from({ length: 100 }, (_, i) => ({ filename: `docs/runbooks-public/${i}.md`, status: 'added' }));
  const cases: [(s: ReturnType<typeof world>['state']) => void, string][] = [
    [s => { s.pullFiles = many; }, 'changed_files_incomplete'],
    [s => { s.pullFiles = []; }, 'changed_files_incomplete'],
    [s => { s.commitPulls = []; }, 'merged_pull_not_found'],
    [s => { s.commitPulls = [{ number: 12, merge_commit_sha: M, head: { sha: OLD_REV } }]; }, 'merged_pull_not_found'],
    [s => { s.commitPulls = [{ number: 12, merge_commit_sha: OLD_REV, head: { sha: H } }]; }, 'merged_pull_not_found'],
    [s => { s.pullFiles = [{ path: 'x' }]; }, 'github_response_invalid'],
    [s => { s.override = url => url.pathname.endsWith('/files') ? { status: 502 } : undefined; }, 'github_unavailable'],
  ];
  for (const [change, reason] of cases) {
    const w = world();
    change(w.state);
    expectState(await w.observe(CONFIG_ID), 'unknown', reason);
  }
});
test('docs-only: 앱 저장소의 문서 변경은 새 이미지가 나오므로 not_applicable로 닫지 않는다', async () => {
  const w = world();
  w.state.imageText = yamlOf({ revision: OLD_REV });
  w.state.compare = { status: 'behind' };
  w.state.pullFiles = [{ filename: 'docs/a.md', status: 'modified' }];
  expectState(await w.observe(), 'pending', 'image_revision_behind');
  assert.ok(!w.seen.some(s => s.url.includes('/files')));
});
test('미등록: 매핑에 없는 저장소는 해당 없음이 아니라 blocked이고 요청을 보내지 않는다', async () => {
  const w = world();
  const observation = await w.observe(1);
  expectState(observation, 'blocked', 'deployment_target_unregistered');
  assert.equal(w.seen.length, 0);
});
test('미등록: 정책이 고른 서비스가 정적 매핑에 없으면 blocked다', async () => {
  const w = world();
  const reader = new DeploymentReader({ github: publicGithubReader({ send: w.send }),
    kubernetes: deploymentKubernetesReader(kubernetesClient({ base: 'https://k8s.fixture', tokenFile: '/x', caFile: null, readText: async () => 't', send: w.send })),
    resolveService: () => 'not-in-catalog', now: () => NOW });
  expectState(await reader.observe({ target: target(), headSha: H, mergeCommit: M }), 'blocked', 'deployment_target_unregistered');
  assert.equal(w.seen.length, 0);
});
test('미등록: 매핑은 있어도 image.yaml이 homelab에 없으면(H0 전) blocked다', async () => {
  const w = world();
  w.state.imageCommits = [];
  const empty = await w.observe();
  expectState(empty, 'blocked', 'deploy_config_unregistered');
  assert.equal(empty.configCommit, null);
  const removed = world();
  removed.state.imageText = null;
  expectState(await removed.observe(), 'blocked', 'deploy_config_unregistered');
});

// ---- 경계 ----

test('경계: GitHub는 고정 origin에 자격 없이 GET만, redirect는 따르지 않는다', async () => {
  const w = world();
  await w.observe();
  await w.reader.readMerge({ target: target(), prNumber: 12 });
  w.state.imageText = yamlOf({ revision: OLD_REV });
  await w.observe();
  await w.observe(CONFIG_ID);
  const github = w.seen.filter(s => new URL(s.url).hostname.includes('github'));
  assert.ok(github.length >= 5);
  for (const request of github) {
    assert.equal(new URL(request.url).origin, 'https://api.github.com');
    assert.equal(request.method, 'GET');
    assert.equal(request.auth, null);
    assert.equal(request.redirect, 'error');
  }
});
test('경계: Kubernetes는 허용 경로 셋에만 GET하고 Secret·ConfigMap·log·exec를 부르지 않는다', async () => {
  const w = world();
  await w.observe();
  const k8s = w.seen.filter(s => s.url.startsWith('https://k8s.fixture'));
  assert.deepEqual(k8s.map(s => new URL(s.url).pathname).sort(), [
    `/api/v1/namespaces/${NS}/pods`,
    `/apis/apps/v1/namespaces/${NS}/deployments/homelab-smoke`,
    '/apis/argoproj.io/v1alpha1/namespaces/argocd/applications/homelab-smoke',
  ].sort());
  assert.ok(k8s.every(s => s.method === 'GET'));
  assert.ok(k8s.every(s => !/secrets|configmaps|\/log|\/exec|\/sync|\/restart/.test(s.url)));
});
test('경계: reader 입력은 고정 모양만 받고 어긋나면 요청을 보내지 않는다', async () => {
  const w = world();
  const github = publicGithubReader({ send: w.send });
  const signal = AbortSignal.timeout(1000);
  await assert.rejects(github.pull('../other', 1, signal));
  await assert.rejects(github.pull(APP, -1, signal));
  await assert.rejects(github.fileAt(CONFIG, '../secret', K, signal));
  await assert.rejects(github.fileAt(CONFIG, 'apps/x/image.yaml', 'main', signal));
  await assert.rejects(github.compare(APP, 'main', M, signal));
  await assert.rejects(github.latestFileCommit(CONFIG, 'a?b=c', 'main', signal));
  await assert.rejects(github.latestFileCommit(CONFIG, 'apps/x/image.yaml', 'refs/x;y', signal));
  const k8s = deploymentKubernetesReader(kubernetesClient({ base: 'https://k8s.fixture', tokenFile: '/x', caFile: null, readText: async () => 't', send: w.send }));
  await assert.rejects(k8s.application('../secrets/x', signal));
  await assert.rejects(k8s.workload('../secrets', 'x', 'app', signal));
  await assert.rejects(k8s.workload(NS, 'x/log', 'app', signal));
  await assert.rejects(k8s.pods(NS, 'x,y=z', 'app', signal));
  assert.equal(w.seen.length, 0);
});
test('카탈로그: 정적 매핑은 차트 규칙과 맞고 기존 /read 범위를 넓히지 않는다', () => {
  assert.deepEqual(SERVICES.map(s => s.id), ['homelab-bot']);
  assert.deepEqual([...ARGOCD_APPLICATIONS], ['homelab-bot']);
  assert.ok(TEMPLATES.every(t => t.service === 'homelab-bot'));
  const smoke = DEPLOY_TARGETS.find(t => t.service === 'homelab-smoke');
  assert.deepEqual(smoke, { kind: 'app', service: 'homelab-smoke', repository: APP, configRepository: CONFIG, imageFile: 'apps/homelab-smoke/image.yaml',
    imageRepository: REPOSITORY, namespace: NS, deployment: 'homelab-smoke', container: 'app', argoApplication: 'homelab-smoke', podApp: 'homelab-smoke' });
  const config = DEPLOY_TARGETS.find(t => t.kind === 'config');
  assert.deepEqual(config, { kind: 'config', service: 'homelab', repository: CONFIG, noDeployPrefixes: ['docs/runbooks-public/'] });
  assert.ok(Object.isFrozen(DEPLOY_TARGETS));
});

// ---- 재조회 비용 ----

test('재조회: commit SHA로 정해진 내용은 다시 읽지 않는다. 익명 GitHub 한도를 아낀다', async () => {
  const w = world();
  w.state.imageText = yamlOf({ revision: OLD_REV });
  w.state.compare = { status: 'behind' };
  for (let i = 0; i < 3; i++) await w.observe();
  const count = (part: string) => w.seen.filter(s => s.url.includes(part)).length;
  assert.equal(count('/contents/'), 1);
  assert.equal(count('/compare/'), 1);
  assert.equal(w.seen.filter(s => new URL(s.url).pathname === `/repos/${CONFIG}/commits`).length, 3);
  // 새 K가 나오면 그 내용을 새로 읽는다.
  const next = sha('8');
  w.state.imageCommits = [{ sha: next }];
  w.state.imageText = yamlOf();
  const observation = await w.observe();
  expectState(observation, 'observed', null);
  assert.equal(observation.configCommit, next);
  assert.equal(count('/contents/'), 2);
});
test('재조회: 실패한 읽기는 기억하지 않는다', async () => {
  const w = world();
  w.state.override = url => url.pathname.includes('/contents/') ? { status: 503 } : undefined;
  expectState(await w.observe(), 'unknown', 'github_unavailable');
  w.state.override = null;
  expectState(await w.observe(), 'observed', null);
  const missing = world();
  missing.state.imageText = null;
  expectState(await missing.observe(), 'blocked', 'deploy_config_unregistered');
  missing.state.imageText = yamlOf();
  expectState(await missing.observe(), 'observed', null);
});
test('재조회: 한 commit이 두 앱의 image.yaml을 바꿔도 값이 섞이지 않는다', async () => {
  const w = world();
  const botApplication = 'homelab-bot';
  const reader = new DeploymentReader({ github: publicGithubReader({ send: w.send }),
    kubernetes: deploymentKubernetesReader(kubernetesClient({ base: 'https://k8s.fixture', tokenFile: '/x', caFile: null, readText: async () => 't', send: w.send })),
    resolveService: repoId => repoId === SMOKE_ID ? 'homelab-smoke' : botApplication, now: () => NOW });
  w.state.override = url => url.pathname === `/repos/${CONFIG}/contents/apps/homelab-bot/image.yaml`
    ? { body: fileBody(yamlOf({ repository: 'ghcr.io/ukyi-app/homelab-bot', revision: OLD_REV })) } : undefined;
  await reader.observe({ target: target(), headSha: H, mergeCommit: M });
  const bot = await reader.observe({ target: target(1), headSha: H, mergeCommit: M });
  // homelab-smoke 내용을 재사용했다면 repository가 달라 image_repository_mismatch로 끝난다.
  assert.notEqual(bot.reason, 'image_repository_mismatch');
  assert.ok(w.seen.some(s => s.url.includes('/contents/apps/homelab-bot/image.yaml')));
});

// ---- 조회 주기 ----

test('조회 주기: 60초 간격·10분 초기 창이고, 창이 지나면 pending·unknown을 늦음으로 알린다', () => {
  assert.deepEqual(DEPLOYMENT_POLL, { intervalMs: 60_000, initialWindowMs: 600_000 });
  const base = { headSha: H, mergeCommit: M, configCommit: null, imageDigest: null, argoObservedAt: null, workloadObservedAt: null, observedAt: NOW };
  const at = (state: DeploymentObservation['state'], elapsed: number) => deploymentPollStep({ ...base, state, reason: state === 'observed' ? null : 'x_y' }, NOW, NOW + elapsed);
  assert.equal(at('pending', 0), 'poll');
  assert.equal(at('unknown', 599_999), 'poll');
  assert.equal(at('pending', 600_000), 'report_late');
  assert.equal(at('unknown', 600_001), 'report_late');
  for (const state of DEPLOYMENT_SETTLED_STATES) assert.equal(at(state, 0), 'settled');
});

// ---- 문구 ----

test('문구: 배포 확인을 기능·DB·성능 성공으로 말하지 않고 H·M·K·D를 따로 적는다', () => {
  const observed: DeploymentObservation = { state: 'observed', headSha: H, mergeCommit: M, configCommit: K, imageDigest: D, argoObservedAt: NOW, workloadObservedAt: NOW, observedAt: NOW, reason: null };
  const text = describeDeployment(observed);
  for (const value of [H, M, K, D]) assert.ok(text.includes(value), value);
  assert.match(text, /기능·DB·성능은 확인하지 않았다/);
  assert.doesNotMatch(text, /성공|정상/);
  assert.match(text, new RegExp(new Date(NOW).toISOString()));
  for (const [state, reason] of [['pending', 'image_revision_behind'], ['unknown', 'github_unavailable'], ['blocked', 'deployment_target_unregistered'], ['not_applicable', 'docs_only']] as const) {
    const line = describeDeployment({ ...observed, state, reason, configCommit: null, imageDigest: null, argoObservedAt: null, workloadObservedAt: null });
    assert.ok(line.includes(reason));
    assert.match(line, /기능·DB·성능은 확인하지 않았다/);
    assert.doesNotMatch(line, /성공|정상/);
    assert.match(line, /미확인/);
  }
});
