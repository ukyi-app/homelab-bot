import { after, before, beforeEach, test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { ChangeStore } from '../src/change-store.js';
import { PolicyUnavailable } from '../src/contracts.js';
import { ReviewRuntime } from '../src/review.js';
import { fixture, localDatabase } from './helpers.js';
import { REPO_ID, fixtureBrief, git, newRequest, ok, seedConversation } from './change-store-fixture.js';

// `type='review'` job에 게시 PR 리뷰와 미게시 후보 리뷰가 함께 들어온다. 기존 claim은 pr_reviews 행을 전제하므로 출처를 가려야 한다.
let database: Awaited<ReturnType<typeof localDatabase>>;
let f: Awaited<ReturnType<typeof fixture>>;
before(async () => { database = await localDatabase(); });
beforeEach(async () => {
  await database.pg.exec(`TRUNCATE events,conversations,jobs,results,outbox,schedules,denied_actors,controls,audit,incidents,
    github_deliveries,pr_reviews,review_deliveries,change_requests RESTART IDENTITY CASCADE`);
  f = await fixture(database.db);
  await seedConversation(database.db);
});
after(async () => { await database.pg.close(); });

async function changeReviewJob(): Promise<string> {
  const changes = new ChangeStore(database.db, f.now);
  const request = await newRequest(changes);
  const key = { changeId: request.id, generation: 1 };
  ok(await changes.admit({ ...key, brief: fixtureBrief(), policyRevision: 'fixture-policy-1' }));
  ok(await changes.pinBase({ ...key, baseCommit: git('b'), baseTree: git('t0') }));
  const job = randomUUID();
  await database.db.query(`INSERT INTO events(id,provider,delivery_id,semantic_key,actor_id,scope,received_at,payload,accepted)
    VALUES ($1,'change',$1,$1,'change-review','{}'::jsonb,1,'{}'::jsonb,true)`, [`event-${job}`]);
  await database.db.query(`INSERT INTO jobs(id,event_id,type,owner_id,target,revision,budget,priority,available_at,created_at)
    VALUES ($1,$2,'review','change-review',$3,'{}'::jsonb,'{}'::jsonb,40,1,1)`, [job, `event-${job}`, JSON.stringify({ kind: 'change', changeId: request.id, generation: 1, repoId: REPO_ID })]);
  ok(await changes.linkChildJob({ ...key, jobId: job, role: 'review' }));
  return job;
}
const stateOf = async (job: string) => (await database.db.query<{ state: string }>('SELECT state FROM jobs WHERE id=$1', [job])).rows[0]!.state;

test('T19 B2 미게시 후보 job은 dispatcher 없는 기존 ReviewRuntime이 집지 않고 그대로 남는다', async () => {
  const job = await changeReviewJob();
  const runtime = new ReviewRuntime(f.store, null as never, null as never, null as never, null as never, null as never, 5);
  assert.equal(await runtime.tick(), false);
  assert.equal(await stateOf(job), 'queued');
});

async function prReviewJob(): Promise<string> {
  const job = randomUUID();
  await database.db.query(`INSERT INTO events(id,provider,delivery_id,semantic_key,actor_id,scope,received_at,payload,accepted)
    VALUES ($1,'github',$1,$1,'github:1','{}'::jsonb,1,'{}'::jsonb,true)`, [`event-${job}`]);
  await database.db.query(`INSERT INTO jobs(id,event_id,type,owner_id,target,revision,budget,priority,available_at,created_at)
    VALUES ($1,$2,'review','github-review','{}'::jsonb,'{}'::jsonb,'{}'::jsonb,40,1,1)`, [job, `event-${job}`]);
  await database.db.query(`INSERT INTO pr_reviews(job_id,generation_key,installation_id,repo_id,repo_full_name,pr_number,head_sha,comparison_revision,base_ref,policy_revision,trigger,pr_updated_at,created_at)
    VALUES ($1,$2,1,1,'fixture/repo',1,$3,$3,'main','rp','opened',1,1)`, [job, `key-${job}`, git('h')]);
  return job;
}

test('T19 B2 dispatcher가 있으면 미게시 후보 job만 넘기고 게시 PR 리뷰 job은 기존 경로로 간다', async () => {
  const change = await changeReviewJob();
  const seen: string[] = [];
  const closedPolicy = { current: async () => { throw new PolicyUnavailable(); } };
  const dispatcher = { run: async (job: { id: string }) => { seen.push(job.id); await database.db.query(`UPDATE jobs SET state='succeeded',finished_at=1 WHERE id=$1`, [job.id]); } };
  const runtime = new ReviewRuntime(f.store, closedPolicy as never, null as never, null as never, null as never, null as never, 5, { changeReview: dispatcher });
  assert.equal(await runtime.tick(), true);
  assert.deepEqual(seen, [change]);
  const pr = await prReviewJob();
  assert.equal(await runtime.tick(), true);
  assert.deepEqual(seen, [change]);
  // 정책을 못 읽으면 기존 경로의 규칙대로 대기열로 돌아간다. dispatcher에 닿지 않았다는 증거다.
  assert.equal(await stateOf(pr), 'queued');
});

test('T19 B2 맡을 PR이 없는 review job은 모델 없이 실패로 닫혀 대기열을 막지 않는다', async () => {
  const job = randomUUID();
  await database.db.query(`INSERT INTO events(id,provider,delivery_id,semantic_key,actor_id,scope,received_at,payload,accepted)
    VALUES ($1,'fixture',$1,$1,'x','{}'::jsonb,1,'{}'::jsonb,true)`, [`event-${job}`]);
  await database.db.query(`INSERT INTO jobs(id,event_id,type,owner_id,target,revision,budget,priority,available_at,created_at)
    VALUES ($1,$2,'review','x','{}'::jsonb,'{}'::jsonb,'{}'::jsonb,40,1,1)`, [job, `event-${job}`]);
  const runtime = new ReviewRuntime(f.store, null as never, null as never, null as never, null as never, null as never, 5);
  assert.equal(await runtime.tick(), true);
  assert.equal(await stateOf(job), 'failed');
  assert.equal((await database.db.query<{ wait_reason: string }>('SELECT wait_reason FROM jobs WHERE id=$1', [job])).rows[0]!.wait_reason, 'review_source_unknown');
});
