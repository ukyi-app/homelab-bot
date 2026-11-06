import { test } from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync, randomUUID } from 'node:crypto';
import pg from 'pg';
import { sha256Hex } from '../src/change-contracts.js';
import { ChangeReviewService } from '../src/change-review.js';
import type { ChangeReviewOutput, ChangeReviewWorkerClient, ChangeReviewWorkerResult } from '../src/change-review.js';
import { ChangeStore } from '../src/change-store.js';
import { Postgres } from '../src/database.js';
import { runMigrations } from '../src/migrate-main.js';
import { ReviewRuntime } from '../src/review.js';
import { Store } from '../src/store.js';
import { WorkerSigner } from '../src/worker.js';
import { REPO_ID, fixtureBrief, fixtureManifest, fixtureManifestFiles, fixtureVerification, newRequest, ok, seedConversation } from './change-store-fixture.js';

// 실제 PostgreSQL(18) 시험. HOMELAB_TEST_PG_SOCKET이 없으면 건너뛴다. 여러 연결에서 제출·claim 경합과 응답 유실 회수를 본다.
const socket = process.env.HOMELAB_TEST_PG_SOCKET;
const skip = socket ? false : 'HOMELAB_TEST_PG_SOCKET 없음(로컬 PostgreSQL 필요)';
const OUTPUT: ChangeReviewOutput = { goal: 'met', acceptance: [{ index: 0, status: 'met' }], reviewed_paths: ['src/new.ts'], findings: [], summary: '문제를 찾지 못했다.' };
const PATCH = 'diff --git a/src/new.ts b/src/new.ts\nnew file mode 100644\n--- /dev/null\n+++ b/src/new.ts\n@@ -0,0 +1 @@\n+export const value = 1;\n';

async function database() {
  const admin = new pg.Pool({ host: socket, user: 'postgres', database: 'postgres', max: 1 });
  const name = `t19b2_${randomUUID().replaceAll('-', '').slice(0, 12)}`;
  await admin.query(`CREATE DATABASE ${name}`);
  const raw = new pg.Pool({ host: socket, user: 'postgres', database: name, max: 10 });
  await runMigrations(raw);
  const db = new Postgres(raw);
  await seedConversation(db);
  return { raw, db, close: async () => {
    await raw.end();
    // WITH (FORCE)는 쓰지 않는다. pool.end() 직후 닫히는 중인 연결이 FATAL을 받아 시험 실패로 나타난다.
    for (let attempt = 0; ; attempt++) {
      try { await admin.query(`DROP DATABASE ${name}`); break; } catch (error) {
        if (attempt >= 50 || !/being accessed by other users/.test((error as Error).message)) throw error;
        await new Promise(resolve => setTimeout(resolve, 100));
      }
    }
    await admin.end();
  } };
}
type Harness = Awaited<ReturnType<typeof database>>;
async function reviewing(d: Harness) {
  const changes = new ChangeStore(d.db);
  const request = await newRequest(changes);
  const key = { changeId: request.id, generation: 1 };
  const manifest = { ...fixtureManifest(), patchSha256: sha256Hex(Buffer.from(PATCH)) };
  ok(await changes.admit({ ...key, brief: fixtureBrief(), policyRevision: 'fixture-policy-1' }));
  ok(await changes.pinBase({ ...key, baseCommit: manifest.baseCommit, baseTree: manifest.baseTree }));
  ok(await changes.recordSnapshot({ ...key, manifest, files: fixtureManifestFiles(), patch: PATCH, transportBytes: 4096 }));
  const bundle = ok(await changes.startVerification({ ...key, verifierRevision: 'fixture-verifier-1' }));
  const verification = fixtureVerification({ bundle });
  ok(await changes.recordVerification({ ...key, receipt: verification }));
  ok(await changes.finishVerification(key));
  return { key, bundle, brief: ok(await changes.get(request.id)).brief!, manifest, patch: PATCH, verifications: [verification] };
}
function parts(d: Harness, worker: ChangeReviewWorkerClient) {
  const store = new Store(d.db);
  const signer = new WorkerSigner(generateKeyPairSync('ed25519').privateKey);
  const service = new ChangeReviewService({ store, changes: new ChangeStore(d.db), signer, worker, findings: { save: async () => {} },
    context: async () => ({ policyRevision: 'fixture-policy-1', repository: id => id === REPO_ID ? 'fixture/repo' : null, internalMarkers: [] }), notifyWaiting: async () => {}, pollMs: 20 });
  const runtime = () => new ReviewRuntime(store, null as never, null as never, null as never, null as never, signer, 20, { changeReview: service });
  return { service, runtime };
}
const succeeded = (sessionId: string): ChangeReviewWorkerResult => ({ status: 'succeeded', stopped: true, sessionId, problems: [], output: OUTPUT });
const idleWorker = (over: Partial<ChangeReviewWorkerClient> = {}): ChangeReviewWorkerClient => ({
  review: async () => succeeded(randomUUID()), cancel: async () => ({ stopped: true }), result: async () => ({ found: false }), ack: async () => {}, ...over,
});

test('T19 B2 실제 PostgreSQL: 동시 제출은 job 하나로 모이고 동시 tick도 한 번만 실행한다', { skip }, async () => {
  const d = await database();
  try {
    let runs = 0;
    const { service, runtime } = parts(d, idleWorker({ review: async () => { runs++; await new Promise(resolve => setTimeout(resolve, 50)); return succeeded(randomUUID()); } }));
    const input = await reviewing(d);
    const jobs = await Promise.all(Array.from({ length: 8 }, () => service.submit(input)));
    assert.equal(new Set(jobs).size, 1);
    assert.equal((await d.raw.query(`SELECT 1 FROM change_child_jobs WHERE role='review'`)).rows.length, 1);
    const ticks = await Promise.all(Array.from({ length: 4 }, () => runtime().tick()));
    assert.equal(ticks.filter(Boolean).length, 1);
    assert.equal(runs, 1);
    assert.equal((await service.fetchReceipt(input.key))!.verdict, 'pass');
    assert.equal((await d.raw.query(`SELECT state FROM jobs WHERE id=$1`, [jobs[0]])).rows[0].state, 'succeeded');
  } finally { await d.close(); }
});

test('T19 B2 실제 PostgreSQL: 응답을 잃은 job을 회수하고 unknown 슬롯을 푼다', { skip }, async () => {
  const d = await database();
  try {
    const session = randomUUID();
    let acked = 0;
    const { service, runtime } = parts(d, idleWorker({ review: async () => { throw new Error('worker_response_uncertain'); },
      result: async () => ({ found: true, result: succeeded(session) }), ack: async () => { acked++; } }));
    const input = await reviewing(d);
    const job = await service.submit(input);
    await runtime().tick();
    assert.equal((await d.raw.query(`SELECT state FROM jobs WHERE id=$1`, [job])).rows[0].state, 'unknown');
    await d.raw.query(`INSERT INTO controls VALUES ($1,'{}'::jsonb)`, [`unknown_probe:${job}`]);
    const receipt = (await service.fetchReceipt(input.key))!;
    assert.equal(receipt.sessionId, session);
    assert.equal(acked, 1);
    assert.equal((await d.raw.query(`SELECT state FROM jobs WHERE id=$1`, [job])).rows[0].state, 'succeeded');
    assert.equal((await d.raw.query(`SELECT 1 FROM controls WHERE key=$1`, [`unknown_probe:${job}`])).rows.length, 0);
  } finally { await d.close(); }
});
