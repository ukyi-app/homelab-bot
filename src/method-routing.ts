import { randomUUID } from 'node:crypto';
import { DEFAULTS } from './contracts.js';
import type { Job, RateLimitInfo } from './contracts.js';
import type { Database } from './database.js';
import { CREDENTIAL_REVISION } from './execution-auth.js';
import type { ExecutionSelection } from './execution-auth.js';
import { ACCOUNT_NAME } from './model-accounts.js';
import { MODEL_RESUME } from './store.js';
import type { Store } from './store.js';

// 한도 뒤 API 사용의 게시 서버 쪽(COLLEAGUE_SPEC §4.11, DECISIONS "C38"·"C40", ARCHITECTURE "C40").
// 실행마다 지금 계정의 두 방식(구독·API) 중 하나를 골라 서명 요청의 선택 칸으로 넘기고(select), 작업자 결과로 두 방식의 상태를
// 좁게 바꾼다(settle). 상태는 migration 029의 method_routing 한 행과 실행마다의 method_runs다.
// owner 계정 전환(switchAccount)은 쓰지 않는다. 그 전이는 모든 모델 대기·결제 대기를 풀고 한도 관측을 지운다.
// 고를 수 없으면 select가 null이고 호출자는 옛 판 요청을 보낸다(지금 동작). 스위치·설치·작업자 지원 셋 중 하나라도 없으면 그렇다.

export type MethodPath = 'chat' | 'review' | 'change_review' | 'task';
export interface MethodRouterOptions {
  // 정책 apiAfterLimit === true. 기동 때 한 번 읽는다.
  enabled: boolean;
  // 두 작업자가 이 경로의 새 판을 받는다고 확인됐는지(main.ts가 주기로 지원 확인 경로를 읽어 둔 값). 확인 못 했으면 false다.
  supported: (path: MethodPath) => boolean;
}
// 작업자 결과 중 방식 상태에 쓰는 칸만. subscriptionLimit은 작업자의 넘어갈 근거 판정(execution.subscriptionLimit)이다.
export interface RoutedOutcome {
  status: 'succeeded' | 'limited' | 'auth_expired' | 'failed' | 'not_run';
  rateLimit?: RateLimitInfo | null;
  subscriptionLimit?: boolean;
  refusal?: string;
}
// requeued: 이 일을 다시 대기열에 넣었다(다른 방식으로 이어서 하거나, 옛 판으로 다시 보내려고). 호출자는 더 쓰지 않는다.
// wait: 두 방식이 다 막혀 모델 멈춤이다. 호출자는 이 rateLimit(구독 확인 시각)으로 waitForUser를 부른다.
// default: 지금 동작 그대로 처리한다.
export type Settlement = { action: 'requeued' } | { action: 'wait'; rateLimit: RateLimitInfo | null } | { action: 'default' };
const DEFAULT: Settlement = { action: 'default' };

type RoutingRow = { account: string; revision: string; install_state: 'active' | 'off' | 'refused'; refused_reason: string | null;
  subscription_state: 'available' | 'limited'; subscription_limited_at: string | null; subscription_until: string | null; subscription_next_probe_at: string | null;
  probe_run: string | null; probe_until: string | null; api_state: 'eligible' | 'billing_blocked' | 'auth_blocked'; api_blocked_at: string | null;
  epoch: string; installed_at: string };
type RunRow = { run_id: string; job_id: string; account: string; revision: string; method: 'subscription' | 'api'; epoch: string; probe: boolean;
  settled_at: string | null };
const num = (value: string | number | null | undefined) => value === null || value === undefined ? null : Number(value);

// 구독 확인 실행이 결과 없이 사라졌을 때(게시 서버 재시작 등) 다른 실행이 확인을 대신할 수 있게 되는 시간. 작업 실행 상한보다 길다.
const PROBE_HOLD_MS = DEFAULTS.taskTimeoutMs + DEFAULTS.leaseMs;

async function routing(db: Database, lock = false): Promise<RoutingRow | undefined> {
  return (await db.query<RoutingRow>(`SELECT * FROM method_routing WHERE id='current'${lock ? ' FOR UPDATE' : ''}`)).rows[0];
}
// 지금 고를 수 있는 설치인가: 켜져 있고, 그 계정이 지금 계정이며, 두 방식이 모두 등록돼 있다.
async function activeInstall(db: Database): Promise<RoutingRow | undefined> {
  const row = await routing(db, true);
  if (!row || row.install_state !== 'active') return undefined;
  const accounts = (await db.query<{ method: string; current: boolean }>('SELECT method,current FROM model_accounts WHERE name=$1', [row.account])).rows;
  if (!accounts.some(account => account.current)) return undefined;
  return accounts.length === 2 ? row : undefined;
}

export class MethodRouter {
  constructor(private readonly store: Store, private readonly options: MethodRouterOptions) {}
  get enabled(): boolean { return this.options.enabled; }

  // 이 실행의 방식. null이면 옛 판 요청을 보낸다. 고르면 실행 기록을 남기고, 그 실행 ID가 요청의 서명된 선택 칸이 된다.
  async select(job: Pick<Job, 'id' | 'budget'>, path: MethodPath): Promise<ExecutionSelection | null> {
    if (!this.options.enabled || !this.options.supported(path)) return null;
    return this.store.atomic(async s => {
      // 넘어감·복귀 전이와 같은 scheduler 행 잠금 아래에서 읽고 고른다(두 게시 서버가 같은 확인 자리를 함께 잡지 않게).
      await s.lockScheduler();
      const row = await activeInstall(s.db);
      if (!row) return null;
      const now = s.now();
      const runId = randomUUID();
      let method: 'subscription' | 'api' = 'subscription';
      let probe = false;
      if (row.subscription_state === 'limited') {
        const due = now >= (num(row.subscription_next_probe_at) ?? 0);
        const probing = row.probe_run !== null && (num(row.probe_until) ?? 0) > now;
        // API가 막혔으면 쓸 방식은 구독뿐이다. 이 실행은 재개 예약 루프가 확인 시각에 되돌린 일이다(모델 멈춤의 저절로 재개).
        if (row.api_state !== 'eligible') probe = true;
        else if (due && !probing) {
          probe = true;
          const hold = Math.max(PROBE_HOLD_MS, Number(job.budget?.timeoutMs ?? 0) + DEFAULTS.leaseMs);
          await s.db.query(`UPDATE method_routing SET probe_run=$1,probe_until=$2,updated_at=$3 WHERE id='current'`, [runId, now + hold, now]);
        } else method = 'api';
      }
      await s.db.query(`INSERT INTO method_runs(run_id,job_id,path,account,revision,method,epoch,probe,selected_at) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
        [runId, job.id, path, row.account, row.revision, method, row.epoch, probe, now]);
      return { account: row.account, credentialRevision: row.revision, method, runId };
    });
  }

  // 지금 고를 방식이 API인가(구독이 실제 한도이고 API가 잠기지 않았다). PR 리뷰 claim이 리뷰 미루기를 건너뛸지 정할 때 쓴다.
  // 구독 확인 시각이 지났어도 확인이 성공하기 전까지는 API다. 호출자가 scheduler 행을 이미 잠근 트랜잭션에서 부른다.
  async apiChosen(tx: Database, path: MethodPath = 'review'): Promise<boolean> {
    if (!this.options.enabled || !this.options.supported(path)) return false;
    const row = (await tx.query<RoutingRow>(`SELECT * FROM method_routing WHERE id='current'`)).rows[0];
    if (!row || row.install_state !== 'active' || row.subscription_state !== 'limited' || row.api_state !== 'eligible') return false;
    return (await tx.query('SELECT 1 FROM model_accounts WHERE name=$1 AND current', [row.account])).rows.length > 0;
  }

  // 작업자 결과(멈춤이 확인된 것)를 그 실행의 고정된 선택으로 귀속하고, 필요하면 같은 트랜잭션에서 이 일을 다시 대기열에 넣는다.
  // 같은 실행의 두 번째 보고는 아무것도 바꾸지 않는다(default).
  async settle(job: Pick<Job, 'id' | 'lease_token'>, selection: ExecutionSelection, outcome: RoutedOutcome): Promise<Settlement> {
    return this.store.atomic(async s => {
      // 같은 한도를 두 게시 서버·두 실행 자리가 함께 보고해도 넘어감이 한 번이 되도록 scheduler 행 → 상태 행 순서로 잡는다
      // (모델 대기 Store.waitForUser·계정 전환과 같은 순서).
      await s.lockScheduler();
      const now = s.now();
      const run = (await s.db.query<RunRow>('SELECT * FROM method_runs WHERE run_id=$1 FOR UPDATE', [selection.runId])).rows[0];
      if (!run || run.settled_at !== null || run.job_id !== job.id) return DEFAULT;
      await s.db.query('UPDATE method_runs SET outcome=$2,subscription_limit=$3,settled_at=$4 WHERE run_id=$1',
        [run.run_id, outcome.status, outcome.subscriptionLimit === true, now]);
      const row = await routing(s.db, true);
      if (row?.probe_run === run.run_id) await s.db.query(`UPDATE method_routing SET probe_run=NULL,probe_until=NULL WHERE id='current'`);
      // 고를 때의 설치와 지금 설치가 같은 계정·revision이고 켜져 있을 때만 상태를 바꾼다. 옛 계정·옛 revision의 늦은 결과는
      // 지금 상태·API 잠금·리뷰 미룸을 건드리지 않는다. 그 일은 지금 설치(또는 옛 판)로 다시 고르도록 대기열로 돌린다.
      const current = row !== undefined && row.install_state === 'active' && row.account === run.account && row.revision === run.revision;
      const requeue = async (): Promise<Settlement> => await this.requeue(s, job) ? { action: 'requeued' } : DEFAULT;
      if (outcome.status === 'not_run') {
        if (current) {
          await s.db.query(`UPDATE method_routing SET install_state='refused',refused_reason=$1,epoch=epoch+1,updated_at=$2 WHERE id='current'`,
            [outcome.refusal ?? 'not_run', now]);
          await s.audit('method_route_refused', run.job_id, { account: run.account, revision: run.revision, run: run.run_id, refusal: outcome.refusal ?? null });
        }
        return requeue();
      }
      if (!current) return outcome.status === 'limited' || outcome.status === 'auth_expired' ? requeue() : DEFAULT;
      if (run.method === 'subscription') return this.settleSubscription(s, job, run, row!, outcome, requeue);
      return this.settleApi(s, run, row!, outcome, requeue);
    });
  }

  private async settleSubscription(s: Store, job: Pick<Job, 'id'>, run: RunRow, row: RoutingRow, outcome: RoutedOutcome,
    requeue: () => Promise<Settlement>): Promise<Settlement> {
    const now = s.now();
    if (outcome.status === 'succeeded') {
      // 돌아옴은 예약 시각이 아니라 구독 실행 성공을 확인한 뒤에만 기록한다(풀린 뒤에도 주간 한도가 남을 수 있다).
      // 한도로 넘어가기 전에 고른 실행의 늦은 성공은 확인이 아니다.
      if (row.subscription_state === 'limited' && run.probe) {
        await s.db.query(`UPDATE method_routing SET subscription_state='available',subscription_limited_at=NULL,subscription_until=NULL,
          subscription_next_probe_at=NULL,epoch=epoch+1,updated_at=$1 WHERE id='current'`, [now]);
        await s.audit('method_route_subscription_returned', job.id, { account: run.account, revision: run.revision, run: run.run_id,
          limitedAt: num(row.subscription_limited_at) });
      }
      return DEFAULT;
    }
    // 넘어갈 근거는 작업자의 허용 목록 판정뿐이다. 경고만 본 한도·분류할 수 없는 한도·인증·과부하는 지금 동작이다.
    if (outcome.status !== 'limited' || outcome.subscriptionLimit !== true) return DEFAULT;
    const resetsAt = outcome.rateLimit?.stop?.resetsAt;
    const until = resetsAt === undefined ? null : resetsAt * 1000;
    const next = until !== null ? Math.max(until + MODEL_RESUME.afterResetMs, now + MODEL_RESUME.minDelayMs) : now + MODEL_RESUME.retryMs;
    if (row.subscription_state === 'available' && Number(row.epoch) === Number(run.epoch)) {
      await s.db.query(`UPDATE method_routing SET subscription_state='limited',subscription_limited_at=$1,subscription_until=$2,
        subscription_next_probe_at=$3,epoch=epoch+1,updated_at=$1 WHERE id='current'`, [now, until, next]);
      await s.audit('method_route_subscription_limited', job.id, { account: run.account, revision: run.revision, run: run.run_id, until,
        api: row.api_state });
    } else if (row.subscription_state === 'limited' && run.probe) {
      // 구독 확인이 다시 한도다: 다음 확인 시각만 바꾼다.
      await s.db.query(`UPDATE method_routing SET subscription_until=$1,subscription_next_probe_at=$2,updated_at=$3 WHERE id='current'`, [until, next, now]);
    }
    // 같은 한도를 먼저 보고한 실행이 이미 넘겼으면 상태는 그대로 두고 이 일만 잇는다.
    if (row.api_state !== 'eligible') return DEFAULT;
    return requeue();
  }

  private async settleApi(s: Store, run: RunRow, row: RoutingRow, outcome: RoutedOutcome,
    requeue: () => Promise<Settlement>): Promise<Settlement> {
    const now = s.now();
    // API 결제(보수 분류한 API 429 포함)·API 인증 실패 → API 잠금. 다시 두드리지 않는다. 과부하·실패·성공은 지금 동작이다.
    if (outcome.status !== 'limited' && outcome.status !== 'auth_expired') return DEFAULT;
    if (row.api_state === 'eligible') {
      const state = outcome.status === 'auth_expired' ? 'auth_blocked' : 'billing_blocked';
      await s.db.query(`UPDATE method_routing SET api_state=$1,api_blocked_at=$2,api_blocked_revision=$3,epoch=epoch+1,updated_at=$2 WHERE id='current'`,
        [state, now, run.revision]);
      await s.audit('method_route_api_locked', run.job_id, { account: run.account, revision: run.revision, run: run.run_id, reason: state });
    }
    // 구독이 쓸 수 있으면 그 일을 구독으로 잇는다. 구독도 한도면 모델 멈춤이고, 재시도는 구독 확인 시각이다(구독 복귀 예약은 잠금과 따로 남는다).
    if (row.subscription_state === 'available') return requeue();
    const next = num(row.subscription_next_probe_at);
    const at = next === null ? null : Math.floor((next - MODEL_RESUME.afterResetMs) / 1000);
    // 확인 시각이 이미 지났으면 recordPause가 최소 1분 뒤로 잡는다. 시각을 모르면 30분 뒤다.
    return { action: 'wait', rateLimit: at !== null ? { stop: { cause: 'rate_limit', resetsAt: at } } : null };
  }

  // 실행 중이던 작업을 같은 행 그대로 대기열로 되돌린다. 한도·거부로 끝난 실행은 시도로 세지 않는다(멈춤 기록과 같은 규칙).
  // lease가 살아 있고 running일 때만이다(취소 요청은 호출자의 취소 경로가 맡는다).
  private async requeue(s: Store, job: Pick<Job, 'id' | 'lease_token'>): Promise<boolean> {
    return (await s.db.query(`UPDATE jobs SET state='queued',available_at=$3,wait_reason=NULL,lease_token=NULL,lease_until=NULL,
      started_at=NULL,finished_at=NULL,attempt=GREATEST(0,attempt-1) WHERE id=$1 AND lease_token=$2 AND lease_until>$3 AND state='running'
      RETURNING id`, [job.id, job.lease_token, s.now()])).rows.length > 0;
  }
}

export type InstallOutcome = { result: 'installed'; revision: string; replaced: boolean } | { result: 'unknown_account' } | { result: 'not_current' };
// 자동 사용 설치 기록(관리 진입점 account auto). homelab CLI(C42)가 두 방식의 값 넷과 계정 묶음을 두 작업자에 반영하고
// 지문까지 확인한 뒤에만 부른다. 지금 계정이어야 하고 두 방식이 모두 등록돼 있어야 한다. 호출자의 트랜잭션(Store.atomic) 안에서 돈다.
// 같은 계정·revision으로 다시 부르면 상태를 그대로 두고 켜기만 한다(재실행 안전). 새 revision은 키 교체라 API 잠금을 푼다.
// 다른 계정이면 그 계정의 상태로 새로 시작한다. 구독 한도·확인 예약은 같은 계정이면 남긴다.
export async function installMethods(s: Store, account: string, revision: string): Promise<InstallOutcome> {
  if (!ACCOUNT_NAME.test(account) || !CREDENTIAL_REVISION.test(revision)) return { result: 'unknown_account' };
  await s.lockScheduler();
  const accounts = (await s.db.query<{ current: boolean }>('SELECT current FROM model_accounts WHERE name=$1', [account])).rows;
  if (accounts.length !== 2) return { result: 'unknown_account' };
  if (!accounts.some(row => row.current)) return { result: 'not_current' };
  const now = s.now();
  const before = await routing(s.db, true);
  const same = before?.account === account;
  const replaced = same && before.revision !== revision;
  await s.db.query(`INSERT INTO method_routing(id,account,revision,installed_at,install_state,updated_at) VALUES ('current',$1,$2,$3,'active',$3)
    ON CONFLICT (id) DO UPDATE SET account=$1,revision=$2,installed_at=$3,install_state='active',refused_reason=NULL,updated_at=$3,epoch=method_routing.epoch+1,
      api_state=CASE WHEN $4::boolean AND method_routing.revision=$2 THEN method_routing.api_state ELSE 'eligible' END,
      api_blocked_at=CASE WHEN $4::boolean AND method_routing.revision=$2 THEN method_routing.api_blocked_at ELSE NULL END,
      api_blocked_revision=CASE WHEN $4::boolean AND method_routing.revision=$2 THEN method_routing.api_blocked_revision ELSE NULL END,
      subscription_state=CASE WHEN $4::boolean THEN method_routing.subscription_state ELSE 'available' END,
      subscription_limited_at=CASE WHEN $4::boolean THEN method_routing.subscription_limited_at ELSE NULL END,
      subscription_until=CASE WHEN $4::boolean THEN method_routing.subscription_until ELSE NULL END,
      subscription_next_probe_at=CASE WHEN $4::boolean THEN method_routing.subscription_next_probe_at ELSE NULL END,
      probe_run=NULL,probe_until=NULL`, [account, revision, now, same]);
  if (replaced && before.api_state !== 'eligible') await s.audit('method_route_api_unlocked', account, { revision, by: 'revision', previous: before.revision });
  return { result: 'installed', revision, replaced };
}

// 자동 사용 끄기(관리 진입점 account auto off). 설치 기록과 두 방식 상태·API 잠금은 지우지 않는다(되돌려도 기록·잠금을 지우지 않는다).
export async function disableMethods(s: Store): Promise<boolean> {
  await s.lockScheduler();
  return (await s.db.query(`UPDATE method_routing SET install_state='off',probe_run=NULL,probe_until=NULL,epoch=epoch+1,updated_at=$1
    WHERE id='current' AND install_state<>'off' RETURNING id`, [s.now()])).rows.length > 0;
}

// API 잠금 해제(관리 진입점 account api-unlock). owner의 명시적 동작만 푼다. 잠기지 않았으면 바꾸지 않는다.
export async function unlockApi(s: Store): Promise<boolean> {
  await s.lockScheduler();
  const unlocked = (await s.db.query<{ account: string; revision: string }>(`UPDATE method_routing SET api_state='eligible',api_blocked_at=NULL,
    api_blocked_revision=NULL,epoch=epoch+1,updated_at=$1 WHERE id='current' AND api_state<>'eligible' RETURNING account,revision`, [s.now()])).rows[0];
  if (unlocked) await s.audit('method_route_api_unlocked', unlocked.account, { revision: unlocked.revision, by: 'owner' });
  return unlocked !== undefined;
}

// 관리 목록·CLI(C42)가 보이는 상태. 값·지문·잔액은 없다.
export type MethodRoutingView = { installed: boolean; account: string | null; revision: string | null; state: 'active' | 'off' | 'refused' | null;
  refusal: string | null; current: boolean; subscription: { state: 'available' | 'limited'; until: number | null; nextProbeAt: number | null } | null;
  api: { state: 'eligible' | 'billing_blocked' | 'auth_blocked'; blockedAt: number | null } | null };
export async function methodRoutingView(db: Database): Promise<MethodRoutingView> {
  const row = await routing(db);
  if (!row) return { installed: false, account: null, revision: null, state: null, refusal: null, current: false, subscription: null, api: null };
  const current = (await db.query('SELECT 1 FROM model_accounts WHERE name=$1 AND current', [row.account])).rows.length > 0;
  return { installed: true, account: row.account, revision: row.revision, state: row.install_state, refusal: row.refused_reason, current,
    subscription: { state: row.subscription_state, until: num(row.subscription_until), nextProbeAt: num(row.subscription_next_probe_at) },
    api: { state: row.api_state, blockedAt: num(row.api_blocked_at) } };
}
