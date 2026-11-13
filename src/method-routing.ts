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
// 실행마다 지금 계정의 두 방식(구독·API) 중 하나를 골라(select) 보내기 직전에 다시 확인하고(start), 서명 요청의 선택 칸으로 넘긴다.
// 작업자 결과로 두 방식의 상태를 좁게 바꾼다(settle). 상태는 migration 029의 표들이다: 지금 설치(method_routing 한 행),
// 계정별 구독 상태(method_subscription), 계정·revision별 API 상태(method_api), 실행마다의 선택(method_runs).
// owner 계정 전환(switchAccount)은 쓰지 않는다. 그 전이는 모든 모델 대기·결제 대기를 풀고 한도 관측을 지운다.
// 고를 수 없으면 select가 null이고 호출자는 옛 판 요청을 보낸다(지금 동작). 스위치·설치·작업자 지원 셋 중 하나라도 없으면 그렇다.

// change_author: 변경 작성 턴(v2). 작업 레인과 같은 세션 표·같은 작업 경로라 실행 기록(method_runs.path)에는 'task'로 남는다.
export type MethodPath = 'chat' | 'review' | 'change_review' | 'task' | 'change_author';
const TASK_PATHS: ReadonlySet<MethodPath> = new Set(['task', 'change_author']);
export interface MethodRouterOptions {
  // 정책 apiAfterLimit === true. 기동 때 한 번 읽는다.
  enabled: boolean;
  // 정책 apiAfterLimitTask === true. 작업 경로(task·change_author)는 enabled에 더해 이것도 켜져야 고른다. 없으면 꺼짐이다.
  task?: boolean;
  // 두 작업자가 이 경로의 새 판을 받는다고 확인됐는지(main.ts가 주기로 지원 확인 경로를 읽어 둔 값). 확인 못 했으면 false다.
  supported: (path: MethodPath) => boolean;
}
// 작업자 결과 중 방식 상태에 쓰는 칸만. subscriptionLimit은 작업자의 넘어갈 근거 판정(execution.subscriptionLimit)이다.
export interface RoutedOutcome {
  status: 'succeeded' | 'limited' | 'auth_expired' | 'failed' | 'not_run';
  rateLimit?: RateLimitInfo | null;
  subscriptionLimit?: boolean;
  refusal?: string;
  // false면 그 일을 다른 방식으로 이을 수 없다(작업 레인에 이어 갈 세션이 남지 않음). 상태 전이는 하되 다시 넣지 않는다.
  resumable?: boolean;
}
// requeued: 이 일을 다시 대기열에 넣었다(다른 방식으로 이어서 하거나, 옛 판으로 다시 보내려고). 호출자는 더 쓰지 않는다.
// wait: 두 방식이 다 막혀 모델 멈춤이다. 호출자는 이 rateLimit(구독 확인 시각)으로 waitForUser를 부른다.
// held: 이을 세션이 없는(resumable: false) 일의 결과가 지금 계정의 구독 한도를 말하지 않는다
// (옛 계정의 결과, 옛 설치의 API 실패, 지금 설치의 API 실패).
// 호출자는 지금 계정의 전역 대기를 만들지 않고, 그 일만 작업 레인에서 owner 판단까지 보존한다(시간으로 다시 돌리지 않는다.
// 세션이 없어 다시 돌려도 이어 갈 수 없다, COLLEAGUE_SPEC §4.11 "작업 이어가기").
// default: 지금 동작 그대로 처리한다.
export type Settlement = { action: 'requeued' } | { action: 'wait'; rateLimit: RateLimitInfo | null } | { action: 'held' } | { action: 'default' };
const DEFAULT: Settlement = { action: 'default' };
const HELD: Settlement = { action: 'held' };
// 구독은 한도이고 API는 잠겼으며 구독 확인 자리도 없다(확인 시각 전이거나 다른 실행이 확인 중). 어느 방식으로도 보내지 않는다.
// 호출자는 이 rateLimit으로 모델 멈춤(waitForUser)에 넣는다. 다시 시도는 구독 확인 시각, 이미 지났으면 최소 1분 뒤다.
export type MethodWait = { wait: RateLimitInfo | null };
export const methodWait = (routed: ExecutionSelection | MethodWait | null): routed is MethodWait => routed !== null && 'wait' in routed;

type RoutingRow = { account: string; revision: string; install_state: 'active' | 'off' | 'refused'; refused_reason: string | null;
  epoch: string; installed_at: string; current_account: boolean; methods: string | number;
  subscription_state: 'available' | 'limited'; subscription_limited_at: string | null; subscription_until: string | null; subscription_next_probe_at: string | null;
  probe_run: string | null; probe_until: string | null; api_state: 'eligible' | 'billing_blocked' | 'auth_blocked'; api_blocked_at: string | null };
type RunRow = { run_id: string; job_id: string; account: string; revision: string; method: 'subscription' | 'api'; epoch: string; probe: boolean;
  started_at: string | null; settled_at: string | null };
const num = (value: string | number | null | undefined) => value === null || value === undefined ? null : Number(value);

// 구독 확인 실행이 결과 없이 사라졌을 때(게시 서버 재시작 등) 다른 실행이 확인을 대신할 수 있게 되는 시간. 작업 실행 상한보다 길다.
const PROBE_HOLD_MS = DEFAULTS.taskTimeoutMs + DEFAULTS.leaseMs;

// 지금 설치와 그 계정의 구독 상태·그 계정 revision의 API 상태를 한 행으로 읽는다. 설치가 만들므로 상태 행은 늘 있다.
// current_account: 그 계정이 실제 지금 계정인가(owner가 account use로 바꾸면 설치 행은 그대로라 따로 본다). methods: 등록된 방식 수.
const ROUTING = `SELECT r.account,r.revision,r.install_state,r.refused_reason,r.epoch,r.installed_at,
  EXISTS (SELECT 1 FROM model_accounts m WHERE m.name=r.account AND m.current) AS current_account,
  (SELECT count(*) FROM model_accounts m WHERE m.name=r.account) AS methods,
  s.state AS subscription_state,s.limited_at AS subscription_limited_at,s.until AS subscription_until,s.next_probe_at AS subscription_next_probe_at,
  s.probe_run,s.probe_until,a.state AS api_state,a.blocked_at AS api_blocked_at
  FROM method_routing r JOIN method_subscription s ON s.account=r.account JOIN method_api a ON a.account=r.account AND a.revision=r.revision
  WHERE r.id='current'`;
async function routing(db: Database, lock = false): Promise<RoutingRow | undefined> {
  return (await db.query<RoutingRow>(`${ROUTING}${lock ? ' FOR UPDATE OF r,s,a' : ''}`)).rows[0];
}
// 지금 고를 수 있는 설치인가: 켜져 있고, 그 계정이 지금 계정이며, 두 방식이 모두 등록돼 있다.
const usable = (row: RoutingRow | undefined): row is RoutingRow => row !== undefined && row.install_state === 'active' && row.current_account
  && Number(row.methods) === 2;
// 구독 확인을 기다리는 멈춤의 한도 정보. recordPause가 풀리는 시각 + 1분과 지금 + 1분 중 늦은 때를 다시 시도 시각으로 잡는다.
function probeWait(row: RoutingRow, now: number): RateLimitInfo | null {
  const next = num(row.subscription_next_probe_at);
  return next === null ? null : { stop: { cause: 'rate_limit', resetsAt: Math.floor((Math.max(next, now) - MODEL_RESUME.afterResetMs) / 1000) } };
}
const bump = (db: Database, now: number) => db.query(`UPDATE method_routing SET epoch=epoch+1,updated_at=$1 WHERE id='current'`, [now]);

export class MethodRouter {
  constructor(private readonly store: Store, private readonly options: MethodRouterOptions) {}
  get enabled(): boolean { return this.options.enabled; }
  private open(path: MethodPath): boolean {
    return this.options.enabled && (!TASK_PATHS.has(path) || this.options.task === true) && this.options.supported(path);
  }

  // 이 실행의 방식. null이면 옛 판 요청을 보낸다. 고르면 실행 기록을 남기고, 그 실행 ID가 요청의 서명된 선택 칸이 된다.
  // 보내기 직전에 start로 다시 확인해야 한다. MethodWait면 보내지 않고 모델 멈춤으로 기다린다.
  async select(job: Pick<Job, 'id' | 'budget' | 'lease_token'>, path: MethodPath): Promise<ExecutionSelection | MethodWait | null> {
    if (!this.open(path)) return null;
    return this.store.atomic(async s => {
      // 넘어감·복귀 전이와 같은 scheduler 행 잠금 아래에서 읽고 고른다(두 게시 서버·두 실행 자리가 같은 확인 자리를 함께 잡지 않게).
      await s.lockScheduler();
      const row = await routing(s.db, true);
      if (!usable(row)) return null;
      const now = s.now();
      const runId = randomUUID();
      let method: 'subscription' | 'api' = 'subscription';
      let probe = false;
      if (row.subscription_state === 'limited') {
        const due = now >= (num(row.subscription_next_probe_at) ?? 0);
        const probing = row.probe_run !== null && (num(row.probe_until) ?? 0) > now;
        // 구독 확인은 API 잠금과 무관하게 확인 시각 뒤 실행 하나만이다. 나머지는 API로 가거나, API도 막혔으면 기다린다.
        if (due && !probing) {
          probe = true;
          const hold = Math.max(PROBE_HOLD_MS, Number(job.budget?.timeoutMs ?? 0) + DEFAULTS.leaseMs);
          await s.db.query(`UPDATE method_subscription SET probe_run=$1,probe_until=$2,updated_at=$3 WHERE account=$4`, [runId, now + hold, now, row.account]);
        } else if (row.api_state === 'eligible') method = 'api';
        else return { wait: probeWait(row, now) };
      }
      await s.db.query(`INSERT INTO method_runs(run_id,job_id,lease,path,account,revision,method,epoch,probe,selected_at) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
        [runId, job.id, job.lease_token ?? null, TASK_PATHS.has(path) ? 'task' : path, row.account, row.revision, method, row.epoch, probe, now]);
      return { account: row.account, credentialRevision: row.revision, method, runId };
    });
  }

  // 고른 선택을 지금 보내도 되는지. API 잠금·구독 한도 전이·설치와 같은 scheduler 행 잠금 아래에서 본다.
  // API면 그 설치의 API가 아직 eligible이어야 하고, 구독 확인이면 그 자리를 아직 쥐고 있어야 하며, 다른 구독 실행은 구독이 한도가 아니어야 한다.
  // 거절된 선택은 보내지 않는다. 호출자는 reroute로 그 일을 다시 넣어 새로 고르게 한다.
  async admit(job: Pick<Job, 'id'>, selection: ExecutionSelection, within: Store): Promise<boolean> {
    await within.lockScheduler();
    const run = (await within.db.query<RunRow>('SELECT * FROM method_runs WHERE run_id=$1 FOR UPDATE', [selection.runId])).rows[0];
    if (!run || run.job_id !== job.id || run.settled_at !== null || run.started_at !== null) return false;
    const row = await routing(within.db, true);
    if (!usable(row) || row.account !== run.account || row.revision !== run.revision) return false;
    if (run.method === 'api') return row.api_state === 'eligible';
    return run.probe ? row.probe_run === run.run_id : row.subscription_state === 'available';
  }
  // 그 선택을 실제로 보낸 실행으로 적는다. admit과 같은 트랜잭션에서 부른다. 회수·결과 대조는 이 칸이 있는 실행만 찾는다.
  async started(selection: ExecutionSelection, within: Store): Promise<void> {
    await within.db.query('UPDATE method_runs SET started_at=$2 WHERE run_id=$1 AND started_at IS NULL', [selection.runId, within.now()]);
  }
  // admit + started를 한 트랜잭션으로. 이 뒤에 확정된 잠금은 이미 시작한 이 실행을 막지 않는다(잠금보다 먼저 시작했다).
  async start(job: Pick<Job, 'id'>, selection: ExecutionSelection): Promise<boolean> {
    return this.store.atomic(async s => {
      if (!await this.admit(job, selection, s)) return false;
      await this.started(selection, s);
      return true;
    });
  }
  // 보내지 않은 선택을 버리고(구독 확인 자리도 놓는다) 실행 중인 그 일을 대기열로 되돌린다. 보내지 않았으니 시도로 세지 않는다.
  async reroute(job: Pick<Job, 'id' | 'lease_token'>, selection: ExecutionSelection, within?: Store): Promise<boolean> {
    return (within ?? this.store).atomic(async s => {
      await this.abandonIn(s, selection);
      return this.requeue(s, job, false);
    });
  }
  // 보내지 않은 선택을 버린다(일은 호출자가 따로 처리한다: 취소·종료로 되돌림·미루기). 이미 귀속된 실행은 바꾸지 않는다.
  async abandon(selection: ExecutionSelection): Promise<void> {
    await this.store.atomic(s => this.abandonIn(s, selection));
  }
  private async abandonIn(s: Store, selection: ExecutionSelection): Promise<void> {
    await s.lockScheduler();
    const dropped = (await s.db.query(`UPDATE method_runs SET outcome='unstarted',started_at=NULL,settled_at=$2 WHERE run_id=$1 AND settled_at IS NULL RETURNING run_id`,
      [selection.runId, s.now()])).rows.length > 0;
    if (dropped) await s.db.query(`UPDATE method_subscription SET probe_run=NULL,probe_until=NULL WHERE probe_run=$1`, [selection.runId]);
  }

  // 지금 고를 방식이 API인가(select와 같은 판단: 구독이 실제 한도이고, 구독 확인 자리가 없으며, API가 잠기지 않았다).
  // PR 리뷰 claim이 리뷰 미루기를 건너뛸지 정할 때 쓴다. 확인 시각이 지나 확인 자리가 비어 있으면 select가 구독 확인을 고르므로 false다.
  // 호출자가 scheduler 행을 이미 잠근 트랜잭션에서 부른다.
  // 작업 턴의 대기 범위(claude-task-bridge)는 probe: false로 부른다: 확인 시각이 지나도 다른 경로는 확인이나 API로 계속 돌 수 있어 작업 레인만 막으면 된다.
  async apiChosen(tx: Database, path: MethodPath = 'review', options: { probe?: boolean } = {}): Promise<boolean> {
    if (!this.open(path)) return false;
    const row = await routing(tx);
    if (!usable(row) || row.subscription_state !== 'limited' || row.api_state !== 'eligible') return false;
    if (options.probe === false) return true;
    const now = this.store.now();
    const due = now >= (num(row.subscription_next_probe_at) ?? 0);
    const probing = row.probe_run !== null && (num(row.probe_until) ?? 0) > now;
    return !due || probing;
  }

  // 대화 경로가 구독 한도를 만나면 API로 넘어갈 수 있는가(구독 상태와 무관하게 설치가 켜져 있고 API가 잠기지 않았다).
  // 선택 없이 돈 작업 턴(작업 경로 칸 꺼짐)이 구독 한도로 끝났을 때 작업 레인만 세울지 정한다. 전역 scheduler를 닫으면
  // 대화·PR 리뷰가 한도를 스스로 만나지 못해 넘어가지 못한다.
  async routesOthers(tx: Database): Promise<boolean> {
    if (!this.open('chat')) return false;
    const row = await routing(tx);
    return usable(row) && row.api_state === 'eligible';
  }

  // 그 job lease로 실제로 보낸 새 판 요청의 선택. 저장 결과 회수가 v2 결과를 읽고 실행 칸을 대조할 때 쓴다.
  // 귀속(settle) 여부와 무관하게 찾는다: 귀속한 뒤 저장이 실패하거나 재시작해도 그 결과는 v2로 다시 읽어야 한다.
  // 보내지 않은 선택(다른 게시 서버가 같은 lease의 턴을 먼저 시작함, 고른 뒤 막힘)은 고르지 않는다.
  // 스위치·지원과 무관하게 찾는다: 끈 뒤에도 이미 v2로 낸 결과는 회수해야 한다(옛 판 파서는 읽지 못한다).
  async pendingSelection(job: Pick<Job, 'id' | 'lease_token'>): Promise<ExecutionSelection | null> {
    if (!job.lease_token) return null;
    const run = (await this.store.db.query<RunRow>(`SELECT * FROM method_runs WHERE job_id=$1 AND lease=$2 AND started_at IS NOT NULL
      ORDER BY started_at DESC,selected_at DESC LIMIT 1`, [job.id, job.lease_token])).rows[0];
    return run ? { account: run.account, credentialRevision: run.revision, method: run.method, runId: run.run_id } : null;
  }

  // 작업자 결과(멈춤이 확인된 것)를 그 실행의 고정된 선택으로 귀속하고, 필요하면 같은 트랜잭션에서 이 일을 다시 대기열에 넣는다.
  // 같은 실행의 두 번째 보고는 아무것도 바꾸지 않는다(default). 단 저장 결과 회수(recovered)가 같은 결과를 다시 가져오면
  // 상태는 다시 바꾸지 않되 후속 결정(재큐·대기)은 지금 상태로 다시 낸다: 귀속을 커밋한 뒤 대기 저장이 실패한 일은 그 결정이 필요하다.
  // recovered: 저장 결과 회수로 받은 결과다. 그 job은 실행 중이 아니라 unknown(또는 멈춤 확인 뒤 failed)이라 그 상태에서 되돌린다.
  // within: 호출자가 이미 연 트랜잭션의 Store(작업 레인의 턴 확정). 그 트랜잭션이 scheduler 행을 잡았거나 잡을 순서여야 한다.
  // record: 확인된 API 실패의 잠금만 적는다(취소·종료가 그 일의 끝을 정한 경우). API 실행이 아니면 아무것도 하지 않고, 다시 넣지도 기다리지도 않는다.
  async settle(job: Pick<Job, 'id' | 'lease_token'>, selection: ExecutionSelection, outcome: RoutedOutcome,
    options: { recovered?: boolean; within?: Store; record?: boolean } = {}): Promise<Settlement> {
    return (options.within ?? this.store).atomic(async s => {
      // 같은 한도를 두 게시 서버·두 실행 자리가 함께 보고해도 넘어감이 한 번이 되도록 scheduler 행 → 상태 행 순서로 잡는다
      // (모델 대기 Store.waitForUser·계정 전환과 같은 순서).
      await s.lockScheduler();
      const now = s.now();
      const run = (await s.db.query<RunRow & { outcome: string | null }>('SELECT * FROM method_runs WHERE run_id=$1 FOR UPDATE', [selection.runId])).rows[0];
      if (!run || run.job_id !== job.id) return DEFAULT;
      const apiFailure = run.method === 'api' && (outcome.status === 'limited' || outcome.status === 'auth_expired');
      if (options.record && !apiFailure) return DEFAULT;
      // first: 이 보고가 귀속한다. 아니면 회수의 같은 결과일 때만 결정을 다시 내고(상태는 그대로), 그 밖은 아무것도 하지 않는다.
      const first = run.settled_at === null;
      if (!first && (options.recovered !== true || options.record || run.outcome !== outcome.status)) return DEFAULT;
      if (first) {
        await s.db.query('UPDATE method_runs SET outcome=$2,subscription_limit=$3,settled_at=$4 WHERE run_id=$1',
          [run.run_id, outcome.status, outcome.subscriptionLimit === true, now]);
        await s.db.query(`UPDATE method_subscription SET probe_run=NULL,probe_until=NULL WHERE probe_run=$1`, [run.run_id]);
      }
      const row = await routing(s.db, true);
      // 고를 때의 설치와 지금 설치가 같은 계정·revision이고 켜져 있으며 그 계정이 실제 지금 계정일 때만 지금 상태를 바꾼다.
      // 옛 계정(owner의 account use 뒤)·옛 revision의 늦은 결과는 지금 상태·리뷰 미룸·scheduler를 건드리지 않고,
      // 그 일은 지금 설치(또는 옛 판)로 다시 고르도록 대기열로 돌린다.
      const current = row !== undefined && row.install_state === 'active' && row.current_account && row.account === run.account && row.revision === run.revision;
      // 확인된 API 실패는 지금 설치 여부와 무관하게 그 실행에 고정된 계정·revision의 API 상태에 남긴다.
      // 남기지 않으면 owner가 같은 계정·revision을 다시 설치했을 때 실패한 API를 다시 부른다(해제는 owner 동작과 새 revision뿐).
      if (first && apiFailure) await this.lockApi(s, run, outcome, current);
      // hold: 다시 넣을 수 없는 일(이을 세션 없음)의 옛 설치 결과가 지금 계정의 구독 한도를 말하지 않으면, 호출자가 전역 대기 대신 그 일만 보존한다.
      const requeue = async (hold = false): Promise<Settlement> => {
        if (options.record) return DEFAULT;
        if (outcome.resumable === false) return hold ? HELD : DEFAULT;
        return await this.requeue(s, job, options.recovered === true) ? { action: 'requeued' } : DEFAULT;
      };
      if (outcome.status === 'not_run') {
        if (first && current) {
          await s.db.query(`UPDATE method_routing SET install_state='refused',refused_reason=$1,epoch=epoch+1,updated_at=$2 WHERE id='current'`,
            [outcome.refusal ?? 'not_run', now]);
          await s.audit('method_route_refused', run.job_id, { account: run.account, revision: run.revision, run: run.run_id, refusal: outcome.refusal ?? null });
        }
        return requeue();
      }
      if (!current) {
        if (outcome.status !== 'limited' && outcome.status !== 'auth_expired') return DEFAULT;
        const foreign = !(await s.db.query('SELECT 1 FROM model_accounts WHERE name=$1 AND current', [run.account])).rows.length;
        return requeue(apiFailure || foreign);
      }
      // 대기가 아닌 결과의 한도 경고는 그 구독 실행의 계정·revision이 지금 설치일 때만 계정 기록에 남긴다(리뷰 미루기).
      // 실행 시작 시각과 전환 시각의 비교(옛 요청 경로)는 쓰지 않는다: 같은 계정의 새 revision 설치는 그 시각을 바꾸지 않는다.
      if (first && (outcome.status === 'succeeded' || outcome.status === 'failed') && run.method === 'subscription') await s.observeRateLimit(outcome.rateLimit, null, s.db);
      if (run.method === 'subscription') return this.settleSubscription(s, job, run, row!, outcome, requeue, first);
      const settled = await this.settleApi(s, row!, outcome, requeue);
      return options.record ? DEFAULT : settled;
    });
  }

  // 확인된 API 실패를 그 실행의 계정·revision에 잠금으로 적는다. 이미 잠겼으면 바꾸지 않는다.
  // 방식 상태가 바뀌었다는 표시(epoch)는 지금 설치의 잠금일 때만 올린다.
  private async lockApi(s: Store, run: RunRow, outcome: RoutedOutcome, current: boolean): Promise<void> {
    const now = s.now();
    const state = outcome.status === 'auth_expired' ? 'auth_blocked' : 'billing_blocked';
    const locked = (await s.db.query(`UPDATE method_api SET state=$3,blocked_at=$4,updated_at=$4 WHERE account=$1 AND revision=$2 AND state='eligible' RETURNING account`,
      [run.account, run.revision, state, now])).rows.length > 0;
    if (!locked) return;
    if (current) await bump(s.db, now);
    await s.audit('method_route_api_locked', run.job_id, { account: run.account, revision: run.revision, run: run.run_id, reason: state });
  }

  private async settleSubscription(s: Store, job: Pick<Job, 'id'>, run: RunRow, row: RoutingRow, outcome: RoutedOutcome,
    requeue: () => Promise<Settlement>, first: boolean): Promise<Settlement> {
    const now = s.now();
    if (!first) {
      // 회수의 재진입: 상태는 이미 귀속했다. 그 일만 같은 규칙으로 잇는다(API를 쓸 수 있으면 다시 넣고, 아니면 지금 동작).
      return outcome.status === 'limited' && outcome.subscriptionLimit === true && row.api_state === 'eligible' ? requeue() : DEFAULT;
    }
    if (outcome.status === 'succeeded') {
      // 돌아옴은 예약 시각이 아니라 구독 실행 성공을 확인한 뒤에만 기록한다(풀린 뒤에도 주간 한도가 남을 수 있다).
      // 한도로 넘어가기 전에 고른 실행의 늦은 성공은 확인이 아니다.
      if (row.subscription_state === 'limited' && run.probe) {
        await s.db.query(`UPDATE method_subscription SET state='available',limited_at=NULL,until=NULL,next_probe_at=NULL,updated_at=$2 WHERE account=$1`,
          [run.account, now]);
        await bump(s.db, now);
        await s.audit('method_route_subscription_returned', job.id, { account: run.account, revision: run.revision, run: run.run_id,
          limitedAt: num(row.subscription_limited_at) });
      }
      return DEFAULT;
    }
    // 넘어갈 근거는 작업자의 허용 목록 판정뿐이다. 경고만 본 한도·분류할 수 없는 한도·인증·과부하는 지금 동작이다.
    if (outcome.status !== 'limited' || outcome.subscriptionLimit !== true) return DEFAULT;
    // 모델 멈춤(waitForUser)을 거치지 않으므로 그 실행의 한도 관측을 여기서 계정 기록에 남긴다(계정 목록의 마지막 관측). scheduler 행은 잡혀 있다.
    await s.observeRateLimit(outcome.rateLimit, job.id, s.db);
    const resetsAt = outcome.rateLimit?.stop?.resetsAt;
    const until = resetsAt === undefined ? null : resetsAt * 1000;
    const next = until !== null ? Math.max(until + MODEL_RESUME.afterResetMs, now + MODEL_RESUME.minDelayMs) : now + MODEL_RESUME.retryMs;
    if (row.subscription_state === 'available' && Number(row.epoch) === Number(run.epoch)) {
      await s.db.query(`UPDATE method_subscription SET state='limited',limited_at=$2,until=$3,next_probe_at=$4,updated_at=$2 WHERE account=$1`,
        [run.account, now, until, next]);
      await bump(s.db, now);
      await s.audit('method_route_subscription_limited', job.id, { account: run.account, revision: run.revision, run: run.run_id, until,
        api: row.api_state });
    } else if (row.subscription_state === 'limited' && run.probe) {
      // 구독 확인이 다시 한도다: 다음 확인 시각만 바꾼다.
      await s.db.query(`UPDATE method_subscription SET until=$2,next_probe_at=$3,updated_at=$4 WHERE account=$1`, [run.account, until, next, now]);
    }
    // 같은 한도를 먼저 보고한 실행이 이미 넘겼으면 상태는 그대로 두고 이 일만 잇는다.
    if (row.api_state !== 'eligible') return DEFAULT;
    return requeue();
  }

  // API 결제(보수 분류한 API 429 포함)·API 인증 실패의 후속 결정. 잠금은 settle이 이미 적었다(lockApi). 과부하·실패·성공은 지금 동작이다.
  private async settleApi(s: Store, row: RoutingRow, outcome: RoutedOutcome, requeue: () => Promise<Settlement>): Promise<Settlement> {
    if (outcome.status !== 'limited' && outcome.status !== 'auth_expired') return DEFAULT;
    // 이을 세션이 없는 일은 어느 방식으로도 잇지 못해 그 일만 보존한다. 이 실패는 API의 사실이라 지금 계정의 전역 대기를 만들지 않는다:
    // 구독을 쓸 수 있으면 다른 일은 구독으로 돌고, 구독도 한도면 다음 실행의 고르기(select)가 구독 확인 시각까지 모델 멈춤을 건다.
    if (outcome.resumable === false) return HELD;
    // 구독이 쓸 수 있으면 그 일을 구독으로 잇는다. 구독도 한도면 모델 멈춤이고, 재시도는 구독 확인 시각이다(구독 복귀 예약은 잠금과 따로 남는다).
    if (row.subscription_state === 'available') return requeue();
    // 확인 시각이 이미 지났으면 recordPause가 최소 1분 뒤로 잡는다. 시각을 모르면 30분 뒤다.
    return { action: 'wait', rateLimit: probeWait(row, s.now()) };
  }

  // 실행 중이던 작업을 같은 행 그대로 대기열로 되돌린다. 한도·거부로 끝난 실행은 시도로 세지 않는다(멈춤 기록과 같은 규칙).
  // lease가 살아 있고 running일 때만이다(취소 요청은 호출자의 취소 경로가 맡는다). 회수한 결과면 그 lease의 unknown(또는 멈춤 확인 뒤
  // failed)에서 되돌리고 unknown 조사 표식을 지운다(변경 자체 리뷰의 waitRecovered와 같은 조건).
  private async requeue(s: Store, job: Pick<Job, 'id' | 'lease_token'>, recovered: boolean): Promise<boolean> {
    const from = recovered ? `(state='unknown' OR (state='failed' AND wait_reason='stop_confirmed_after_unknown'))` : `lease_until>$3 AND state='running'`;
    const moved = (await s.db.query(`UPDATE jobs SET state='queued',available_at=$3,wait_reason=NULL,lease_token=NULL,lease_until=NULL,
      started_at=NULL,finished_at=NULL,attempt=GREATEST(0,attempt-1) WHERE id=$1 AND lease_token=$2 AND ${from}
      RETURNING id`, [job.id, job.lease_token, s.now()])).rows.length > 0;
    if (moved && recovered) await s.db.query('DELETE FROM controls WHERE key=$1', [`unknown_probe:${job.id}`]);
    return moved;
  }
}

export type InstallOutcome = { result: 'installed'; revision: string; replaced: boolean } | { result: 'unknown_account' } | { result: 'not_current' };
// 자동 사용 설치 기록(관리 진입점 account auto). homelab CLI(C42)가 두 방식의 값 넷과 계정 묶음을 두 작업자에 반영하고
// 지문까지 확인한 뒤에만 부른다. 지금 계정이어야 하고 두 방식이 모두 등록돼 있어야 한다. 호출자의 트랜잭션(Store.atomic) 안에서 돈다.
// 설치는 지금 설치를 가리키는 행만 바꾼다. 두 방식의 상태는 계정별·계정 revision별로 남아 있어:
// 같은 계정·revision을 다시 설치하거나 다른 계정을 거쳐 돌아와도 그 API 잠금·구독 한도·확인 예약이 그대로다(재실행 안전).
// 새 revision은 키 교체라 새 API 상태 행(eligible)으로 시작한다. 구독 한도·확인 예약은 같은 계정이면 남는다.
export async function installMethods(s: Store, account: string, revision: string): Promise<InstallOutcome> {
  if (!ACCOUNT_NAME.test(account) || !CREDENTIAL_REVISION.test(revision)) return { result: 'unknown_account' };
  await s.lockScheduler();
  const accounts = (await s.db.query<{ current: boolean }>('SELECT current FROM model_accounts WHERE name=$1', [account])).rows;
  if (accounts.length !== 2) return { result: 'unknown_account' };
  if (!accounts.some(row => row.current)) return { result: 'not_current' };
  const now = s.now();
  const before = await routing(s.db, true);
  const moved = before?.account !== account || before.revision !== revision;
  const replaced = before?.account === account && before.revision !== revision;
  // 가리키는 설치가 바뀌면 그 계정의 구독 확인 자리를 놓는다. 다른 설치로 고른 확인 실행의 결과는 귀속되지 않아 자리를 영영 쥐게 된다.
  await s.db.query(`INSERT INTO method_subscription(account,updated_at) VALUES ($1,$2)
    ON CONFLICT (account) DO UPDATE SET probe_run=CASE WHEN $3::boolean THEN NULL ELSE method_subscription.probe_run END,
      probe_until=CASE WHEN $3::boolean THEN NULL ELSE method_subscription.probe_until END`, [account, now, moved]);
  await s.db.query(`INSERT INTO method_api(account,revision,updated_at) VALUES ($1,$2,$3) ON CONFLICT (account,revision) DO NOTHING`, [account, revision, now]);
  await s.db.query(`INSERT INTO method_routing(id,account,revision,installed_at,install_state,updated_at) VALUES ('current',$1,$2,$3,'active',$3)
    ON CONFLICT (id) DO UPDATE SET account=$1,revision=$2,installed_at=$3,install_state='active',refused_reason=NULL,updated_at=$3,epoch=method_routing.epoch+1`,
  [account, revision, now]);
  if (replaced && before.api_state !== 'eligible') await s.audit('method_route_api_unlocked', account, { revision, by: 'revision', previous: before.revision });
  return { result: 'installed', revision, replaced };
}

// 자동 사용 끄기(관리 진입점 account auto off). 설치 기록과 두 방식 상태·API 잠금은 지우지 않는다(되돌려도 기록·잠금을 지우지 않는다).
export async function disableMethods(s: Store): Promise<boolean> {
  await s.lockScheduler();
  const off = (await s.db.query<{ account: string }>(`UPDATE method_routing SET install_state='off',epoch=epoch+1,updated_at=$1
    WHERE id='current' AND install_state<>'off' RETURNING account`, [s.now()])).rows[0];
  if (off) await s.db.query(`UPDATE method_subscription SET probe_run=NULL,probe_until=NULL WHERE account=$1`, [off.account]);
  return off !== undefined;
}

// API 잠금 해제(관리 진입점 account api-unlock). owner의 명시적 동작만 푼다. 지금 설치(계정·revision)의 잠금만이고, 잠기지 않았으면 바꾸지 않는다.
export async function unlockApi(s: Store): Promise<boolean> {
  await s.lockScheduler();
  const now = s.now();
  const unlocked = (await s.db.query<{ account: string; revision: string }>(`UPDATE method_api a SET state='eligible',blocked_at=NULL,updated_at=$1
    FROM method_routing r WHERE r.id='current' AND a.account=r.account AND a.revision=r.revision AND a.state<>'eligible' RETURNING a.account,a.revision`, [now])).rows[0];
  if (!unlocked) return false;
  await bump(s.db, now);
  await s.audit('method_route_api_unlocked', unlocked.account, { revision: unlocked.revision, by: 'owner' });
  return true;
}

// 관리 목록·CLI(C42)가 보이는 상태. 지금 설치와 그 계정·revision의 두 방식 상태다. 값·지문·잔액은 없다.
export type MethodRoutingView = { installed: boolean; account: string | null; revision: string | null; state: 'active' | 'off' | 'refused' | null;
  refusal: string | null; current: boolean; subscription: { state: 'available' | 'limited'; until: number | null; nextProbeAt: number | null } | null;
  api: { state: 'eligible' | 'billing_blocked' | 'auth_blocked'; blockedAt: number | null } | null };
export async function methodRoutingView(db: Database): Promise<MethodRoutingView> {
  const row = await routing(db);
  if (!row) return { installed: false, account: null, revision: null, state: null, refusal: null, current: false, subscription: null, api: null };
  return { installed: true, account: row.account, revision: row.revision, state: row.install_state, refusal: row.refused_reason, current: row.current_account,
    subscription: { state: row.subscription_state, until: num(row.subscription_until), nextProbeAt: num(row.subscription_next_probe_at) },
    api: { state: row.api_state, blockedAt: num(row.api_blocked_at) } };
}
