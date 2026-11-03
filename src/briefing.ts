import { randomUUID } from 'node:crypto';
import { Denied, PolicyUnavailable } from './contracts.js';
import type { Scope } from './contracts.js';
import type { Database } from './database.js';
import { bounded } from './format.js';
import { MemoryNotReady } from './memory.js';
import type { MemoryService, MemoryView } from './memory.js';
import type { Policy, PolicyGate } from './policy.js';
import type { Store } from './store.js';

export const BRIEFING = Object.freeze({
  scheduleId: 'daily-briefing', leaseMs: 120_000, retryMs: 1000, lateMs: 600_000,
  skipAfterMs: 43_200_000, freshMs: 3_600_000, sourceTimeoutMs: 10_000, maxMissed: 31,
});
// 시각·시간대는 실제 설정에서만 온다. 비어 있으면 자동 발송하지 않는다.
export interface BriefingConfig { time: string | null; timezone: string | null }
export interface Observation {
  observedAt: number; status: 'ok' | 'problem'; summary: string; restoreVerifiedAt?: number | null;
  // 백업 원본만 낸다. 백업 status와 따로 판정해 복원 기록 문제·오류가 백업 정상·확인 필요를 바꾸지 않는다.
  restoreCheck?: RestoreCheck;
}
// `homelab db restore-check`가 Cluster annotation에 남긴 기록(CLI 기록)의 판정. 시각은 정수 ms다.
// passAt: 유효한 마지막 통과(= restoreVerifiedAt). failedAt: 통과보다 새로운 유효한 실패.
// staleDays: 통과가 100일을 넘었을 때의 경과 일수. issue: 무효로 버린 기록이 있으면 그 사유.
export interface RestoreCheck {
  status: 'verified' | 'problem' | 'unknown'; passAt: number | null; failedAt: number | null;
  staleDays: number | null; issue: 'format' | 'cluster' | 'future' | null;
}
export interface ObservationSource {
  id: string; label: string; kind: 'backup' | 'certificate' | 'scheduled_job'; read(): Promise<Observation>;
}
interface ScheduleRow {
  id: string; owner_id: string; scope: Scope; timezone: string; next_run: string | number;
  payload: { kind?: string; time?: string }; enabled: boolean;
}
interface Claim { schedule: ScheduleRow; slot: number; date: string; token: string; time: string; revision: number }
export type BriefingOutcome = 'idle' | 'enqueued' | 'blocked' | 'deferred';

type Parts = { year: number; month: number; day: number; hour: number; minute: number; second: number };
function parts(ts: number, timeZone: string): Parts {
  const values = new Intl.DateTimeFormat('en-US', { timeZone, hourCycle: 'h23', year: 'numeric', month: '2-digit',
    day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit' }).formatToParts(new Date(ts));
  return Object.fromEntries(values.filter(p => p.type !== 'literal').map(p => [p.type, Number(p.value)])) as Parts;
}
// 벽시계 시각을 UTC로 바꾼다. 서버 TZ와 무관하다. Asia/Seoul은 DST가 없고 DST 시간대의 없는·겹친 시각은 다루지 않는다.
export function zonedTime(year: number, month: number, day: number, hour: number, minute: number, timeZone: string): number {
  const wall = Date.UTC(year, month - 1, day, hour, minute);
  let guess = wall;
  for (let i = 0; i < 2; i++) {
    const p = parts(guess, timeZone);
    guess = wall - (Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second) - guess);
  }
  return guess;
}
const hm = (time: string) => time.split(':').map(Number) as [number, number];
function shift(slot: number, days: number, time: string, timeZone: string): number {
  const p = parts(slot, timeZone);
  const day = new Date(Date.UTC(p.year, p.month - 1, p.day + days));
  return zonedTime(day.getUTCFullYear(), day.getUTCMonth() + 1, day.getUTCDate(), ...hm(time), timeZone);
}
export function latestSlot(now: number, time: string, timeZone: string): number {
  const p = parts(now, timeZone);
  const today = zonedTime(p.year, p.month, p.day, ...hm(time), timeZone);
  return today <= now ? today : shift(today, -1, time, timeZone);
}
export function nextSlot(now: number, time: string, timeZone: string): number {
  return shift(latestSlot(now, time, timeZone), 1, time, timeZone);
}
export function localDate(ts: number, timeZone: string): string {
  const p = parts(ts, timeZone);
  return `${p.year}-${String(p.month).padStart(2, '0')}-${String(p.day).padStart(2, '0')}`;
}
function clock(ts: number, timeZone: string): string {
  const p = parts(ts, timeZone);
  return `${String(p.month).padStart(2, '0')}-${String(p.day).padStart(2, '0')} ${String(p.hour).padStart(2, '0')}:${String(p.minute).padStart(2, '0')}`;
}
// config.ts의 BRIEFING_TIME·BRIEFING_TIMEZONE 검사도 이 둘을 쓴다(기동 검사와 ensure()의 판단이 갈리지 않게).
export const validTime = (time: unknown): time is string => typeof time === 'string' && /^([01]\d|2[0-3]):[0-5]\d$/.test(time);
export function validZone(zone: unknown): zone is string {
  if (typeof zone !== 'string' || !zone) return false;
  try { new Intl.DateTimeFormat('en-US', { timeZone: zone }); return true; } catch { return false; }
}
class StaleBriefing extends Error { constructor() { super('briefing_stale_memory'); } }
const target = (policy: Policy): Scope => ({ guild: policy.guild, channel: policy.notificationChannel, parent: null, kind: 'channel' });
const KIND: Record<MemoryView['kind'], string> = { configuration: '설정', decision: '결정', incident: '장애', preference: '선호' };
const OBSERVED: Record<ObservationSource['kind'], string> = { backup: '백업', certificate: '인증서', scheduled_job: '예약 작업' };
// bigint 열에 들어가므로 정수 ms만 받는다. 형식이 틀린 관측은 읽기 불가로 다룬다.
function valid(value: Observation, now: number): boolean {
  return Number.isSafeInteger(value?.observedAt) && value.observedAt <= now && ['ok', 'problem'].includes(value.status)
    && typeof value.summary === 'string' && (value.restoreVerifiedAt == null || Number.isSafeInteger(value.restoreVerifiedAt));
}
const RESTORE_ISSUE: Record<NonNullable<RestoreCheck['issue']>, string> = { format: 'JSON·스키마 오류', cluster: '클러스터 uid 불일치', future: '미래 시각' };
const intOrNull = (value: unknown) => value === null || Number.isSafeInteger(value);
function validRestore(check: RestoreCheck | undefined): check is RestoreCheck {
  return check != null && ['verified', 'problem', 'unknown'].includes(check.status) && intOrNull(check.passAt) && intOrNull(check.failedAt)
    && intOrNull(check.staleDays) && (check.issue === null || Object.hasOwn(RESTORE_ISSUE, check.issue));
}
// 백업 줄 끝에 붙는 복원 검증 문구. restoreCheck가 없거나 모양이 틀리면 예전 문구(restoreVerifiedAt만)로 적는다.
function restoreText(observation: Observation, zone: string): { text: string; problem: boolean } {
  const check = observation.restoreCheck;
  if (!validRestore(check)) {
    return { text: `복원 검증 ${observation.restoreVerifiedAt ? clock(observation.restoreVerifiedAt, zone) : '미확인'}(백업 성공과 별개)`, problem: false };
  }
  const parts: string[] = [];
  const pass = check.passAt !== null ? `마지막 통과 ${clock(check.passAt, zone)}` : '통과 기록 없음';
  if (check.failedAt !== null) parts.push(`최근 복원 검증 실패 ${clock(check.failedAt, zone)}${check.staleDays !== null ? '' : `(${pass})`}`);
  if (check.staleDays !== null) parts.push(`복원 검증 오래됨 ${check.staleDays}일(${pass})`);
  if (!parts.length && check.passAt !== null) parts.push(`복원 검증 통과 ${clock(check.passAt, zone)}`);
  const issue = check.issue ? `복원 검증 기록 확인 불가(${RESTORE_ISSUE[check.issue]})` : undefined;
  if (!parts.length) parts.push(issue ? `${issue} · 미확인` : '복원 검증 기록 없음(미확인)');
  else if (issue) parts.push(issue);
  const problem = check.status === 'problem';
  return { text: `${problem ? '확인 필요: ' : ''}${parts.join(' · ')} · CLI 기록 기준, 백업 성공과 별개`, problem };
}
function deadline<T>(work: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  return Promise.race([work, new Promise<T>((_, reject) => { timer = setTimeout(() => reject(new Error('source_timeout')), ms); })])
    .finally(() => clearTimeout(timer));
}

export class BriefingScheduler {
  constructor(private readonly store: Store, private readonly gate: PolicyGate, private readonly memory: MemoryService,
    private readonly sources: ObservationSource[], private readonly config: BriefingConfig) {}
  private get db(): Database { return this.store.db; }
  async ensure(): Promise<'enabled' | 'unconfigured'> {
    const { time, timezone } = this.config;
    if (!validTime(time) || !validZone(timezone)) {
      // 끄기와 남은 사본 차단을 한 transaction에서 한다. 이 UPDATE의 예약 행 잠금이 compose의 FOR SHARE와,
      // stop의 회차 행 잠금이 compose의 회차 UPDATE와 부딪혀 작성 중 회차의 큐 확정과 줄 선다.
      await this.store.atomic(async store => {
        await store.db.query('UPDATE schedules SET enabled=false WHERE id=$1', [BRIEFING.scheduleId]);
        const stopped = await this.stop(store.db);
        await store.audit('briefing_unconfigured', BRIEFING.scheduleId, { time, timezone, ...stopped });
      });
      return 'unconfigured';
    }
    const policy = await this.gate.current();
    const scope = target(policy);
    await this.gate.authorize(policy.owner, scope);
    await this.store.atomic(async store => {
      const previous = (await store.db.query<{ enabled: boolean }>('SELECT enabled FROM schedules WHERE id=$1 FOR UPDATE',
        [BRIEFING.scheduleId])).rows[0];
      // 꺼져 있던 예약을 다시 켤 때도 남은 사본을 막는다. 발송 중에 끈 뒤 429로 대기열에 돌아온 옛 회차가 여기에 남을 수 있다.
      if (previous && !previous.enabled) {
        const stopped = await this.stop(store.db);
        if (stopped.blocked) await store.audit('briefing_reenabled', BRIEFING.scheduleId, stopped);
      }
      // 설정이 같으면 next_run을 유지해야 중단 동안 지난 회차를 누락으로 알아챌 수 있다.
      // 꺼져 있었으면 다음 회차부터 다시 센다. 끈 동안의 회차는 보내지도 누락으로 세지도 않는다.
      await store.db.query(`INSERT INTO schedules(id,owner_id,scope,timezone,next_run,payload,enabled) VALUES ($1,$2,$3,$4,$5,$6,true)
        ON CONFLICT (id) DO UPDATE SET owner_id=$2,scope=$3,timezone=$4,payload=$6,enabled=true,
          next_run=CASE WHEN schedules.enabled AND schedules.timezone=$4 AND schedules.payload->>'time'=$7
            THEN schedules.next_run ELSE $5 END`,
      [BRIEFING.scheduleId, policy.owner, JSON.stringify(scope), timezone, nextSlot(store.now(), time, timezone),
        JSON.stringify({ kind: 'daily_briefing', time }), time]);
    });
    return 'enabled';
  }
  // 예약 행을 잠근 transaction 안에서 부른다. 그 예약의 발송 전 사본(pending, 또는 발송을 시작하지 않은 sending)을 막는다.
  // 막는 대상은 최신 outbox_key만이 아니라 briefing_copies에 남은 그 예약의 모든 사본이다(다시 작성한 회차의 옛 revision 포함).
  // 발송을 시작한 행(sent·unknown·dispatch_started)은 보냈을 수 있으니 그대로 두고, 그 회차도 "취소"로 바꾸지 않는다.
  private async stop(tx: Database): Promise<{ blocked: number; started: number }> {
    const id = BRIEFING.scheduleId;
    const runs = (await tx.query<{ slot_date: string; state: string; outbox_key: string | null }>(`SELECT slot_date,state,outbox_key
      FROM briefing_runs WHERE schedule_id=$1 AND state IN ('composing','enqueued') ORDER BY slot_date FOR UPDATE`, [id])).rows;
    const copies = (await tx.query<{ message_key: string }>('SELECT message_key FROM briefing_copies WHERE schedule_id=$1', [id])).rows;
    const keys = [...new Set([...runs.flatMap(run => run.outbox_key ? [run.outbox_key] : []), ...copies.map(copy => copy.message_key)])];
    // 게시자의 dispatch 표시가 state='sending'을 요구하므로 발송 시작 전 sending을 blocked로 바꾸면 보내지 않는다.
    const blocked = new Set(keys.length ? (await tx.query<{ message_key: string }>(`UPDATE outbox SET state='blocked'
      WHERE message_key=ANY($1::text[]) AND (state='pending' OR (state='sending' AND dispatch_started=false))
      RETURNING message_key`, [keys])).rows.map(row => row.message_key) : []);
    const started = new Set(keys.length ? (await tx.query<{ message_key: string }>(`SELECT DISTINCT message_key FROM outbox
      WHERE message_key=ANY($1::text[]) AND (state IN ('sent','unknown') OR dispatch_started)`, [keys])).rows.map(row => row.message_key) : []);
    // 작성 중 회차는 lease를 지워 작성 중인 쪽의 큐 확정(lease_token 일치 조건)이 실패하게 한다.
    const closed = runs.filter(run => run.state === 'composing'
      || (run.outbox_key !== null && blocked.has(run.outbox_key) && !started.has(run.outbox_key))).map(run => run.slot_date);
    if (closed.length) await tx.query(`UPDATE briefing_runs SET state='blocked',reason='schedule_disabled',lease_token=NULL,lease_until=NULL,
      updated_at=$3 WHERE schedule_id=$1 AND slot_date=ANY($2::text[])`, [id, closed, this.store.now()]);
    return { blocked: blocked.size, started: started.size };
  }
  async tick(): Promise<BriefingOutcome> {
    const claim = await this.claim();
    return claim ? this.compose(claim) : 'idle';
  }
  private async claim(): Promise<Claim | undefined> {
    return this.db.transaction(async tx => {
      const schedule = (await tx.query<ScheduleRow>('SELECT * FROM schedules WHERE id=$1 AND enabled=true FOR UPDATE', [BRIEFING.scheduleId])).rows[0];
      const time = schedule?.payload.time;
      if (!schedule || schedule.payload.kind !== 'daily_briefing' || !validTime(time) || !validZone(schedule.timezone)) return;
      const zone = schedule.timezone;
      const now = this.store.now();
      const slot = latestSlot(now, time, zone);
      const date = localDate(slot, zone);
      // 발송을 시작하지 않은 지난 회차와 12시간 넘게 못 보낸 회차는 막고 누락으로 남긴다. 최신 회차와 몰아 보내지 않는다.
      // 게시자가 이 정리를 앞지르지 않도록 기동 때는 tick을 게시자보다 먼저 돌린다(DECISIONS T20 기동 순서).
      const stale = (await tx.query<{ slot_date: string; slot_at: string | number; outbox_key: string }>(`SELECT slot_date,slot_at,outbox_key
        FROM briefing_runs r WHERE schedule_id=$1 AND state='enqueued' AND (slot_at<$2 OR slot_at<$3)
        AND NOT EXISTS (SELECT 1 FROM outbox o WHERE o.message_key=r.outbox_key AND (o.state IN ('sent','unknown') OR o.dispatch_started))
        FOR UPDATE`, [schedule.id, slot, now - BRIEFING.skipAfterMs])).rows;
      for (const run of stale) {
        await tx.query(`UPDATE outbox SET state='blocked' WHERE message_key=$1
          AND (state='pending' OR (state='sending' AND dispatch_started=false))`, [run.outbox_key]);
        await tx.query('UPDATE briefing_runs SET state=$3,reason=$4,updated_at=$5 WHERE schedule_id=$1 AND slot_date=$2',
          [schedule.id, run.slot_date, 'missed', Number(run.slot_at) < slot ? 'superseded_by_later_slot' : 'too_late', now]);
      }
      if (Number(schedule.next_run) <= now) {
        // 중단 동안 지난 회차는 몰아 보내지 않는다. 누락으로만 남기고 최신 회차 하나에 표시한다.
        let count = 0;
        for (let missed = Number(schedule.next_run); missed < slot && count < BRIEFING.maxMissed; missed = shift(missed, 1, time, zone), count++) {
          await tx.query(`INSERT INTO briefing_runs(schedule_id,slot_date,slot_at,state,reason,created_at,updated_at)
            VALUES ($1,$2,$3,'missed','not_sent_while_down',$4,$4) ON CONFLICT DO NOTHING`, [schedule.id, localDate(missed, zone), missed, now]);
        }
        await tx.query(`UPDATE briefing_runs SET state='missed',reason='superseded_by_later_slot',lease_token=NULL,lease_until=NULL,updated_at=$3
          WHERE schedule_id=$1 AND state='composing' AND slot_at<$2`, [schedule.id, slot, now]);
        await tx.query(`INSERT INTO briefing_runs(schedule_id,slot_date,slot_at,state,created_at,updated_at)
          VALUES ($1,$2,$3,'composing',$4,$4) ON CONFLICT DO NOTHING`, [schedule.id, date, slot, now]);
        await tx.query('UPDATE schedules SET next_run=$2 WHERE id=$1', [schedule.id, shift(slot, 1, time, zone)]);
      }
      if (now - slot > BRIEFING.skipAfterMs) {
        await tx.query(`UPDATE briefing_runs SET state='missed',reason='too_late',lease_token=NULL,lease_until=NULL,updated_at=$3
          WHERE schedule_id=$1 AND slot_date=$2 AND state='composing'`, [schedule.id, date, now]);
        return;
      }
      // 같은 회차를 두 인스턴스가 함께 만들지 않게 lease를 잡는다. 만료된 composing은 재시작 뒤 다시 잡는다.
      const token = randomUUID();
      const held = (await tx.query<{ revision: number }>(`UPDATE briefing_runs SET lease_token=$3,lease_until=$4,updated_at=$5
        WHERE schedule_id=$1 AND slot_date=$2 AND state='composing' AND (lease_until IS NULL OR lease_until<=$5) RETURNING revision`,
      [schedule.id, date, token, now + BRIEFING.leaseMs, now])).rows[0];
      return held ? { schedule, slot, date, token, time, revision: Number(held.revision) } : undefined;
    });
  }
  private async compose(claim: Claim): Promise<BriefingOutcome> {
    const { schedule } = claim;
    try {
      // 대상은 저장된 값이 아니라 현재 정책의 owner·알림 채널이다. 철회는 막고 정책 확인 불가는 미룬다.
      const policy = await this.gate.current();
      const owner = policy.owner;
      const scope = target(policy);
      await this.gate.authorize(owner, scope);
      if (owner !== schedule.owner_id || scope.guild !== schedule.scope.guild || scope.channel !== schedule.scope.channel) {
        await this.store.atomic(async store => {
          await store.db.query('UPDATE schedules SET owner_id=$2,scope=$3 WHERE id=$1', [schedule.id, owner, JSON.stringify(scope)]);
          await store.audit('briefing_target_updated', schedule.id, { owner: owner !== schedule.owner_id, channel: scope.channel !== schedule.scope.channel });
        });
      }
      const memory = await this.memoryLines(owner, scope, schedule.timezone);
      const content = [
        ...this.header(claim), ...await this.history(claim), '',
        ...await this.observations(schedule.timezone), '',
        '■ 모델·작업', ...await this.modelLines(),
        '- Codex 작업 상태·승인/질문 대기: 연결 전(T18) · 미확인', '',
        '■ 다시 확인할 기억', ...memory.lines,
      ].join('\n');
      return await this.db.transaction(async tx => {
        // 예약 끄기(ensure)와 줄 세운다. 끄기가 먼저 끝났으면 이 회차의 lease가 이미 지워졌거나 여기서 막는다.
        // 큐 확정이 먼저 끝났으면 끄기가 이 잠금을 기다렸다가 방금 넣은 사본을 막는다.
        const active = (await tx.query<{ enabled: boolean }>('SELECT enabled FROM schedules WHERE id=$1 FOR SHARE', [schedule.id])).rows[0];
        if (!active?.enabled) {
          const closed = (await tx.query(`UPDATE briefing_runs SET state='blocked',reason='schedule_disabled',lease_token=NULL,lease_until=NULL,
            updated_at=$4 WHERE schedule_id=$1 AND slot_date=$2 AND lease_token=$3 AND state='composing' RETURNING slot_date`,
          [schedule.id, claim.date, claim.token, this.store.now()])).rows.length;
          return closed ? 'blocked' : 'idle';
        }
        // 큐에 넣기 직전에 최신 권한을 다시 본다. 게시 직전 검사는 게시자가 한 번 더 한다.
        // 작성 중에 대상 설정만 바뀌었으면 막지 않고 새 대상으로 다시 작성한다. 실제 철회는 authorize가 막는다.
        const latest = await this.gate.current();
        if (latest.owner !== owner || latest.guild !== scope.guild || latest.notificationChannel !== scope.channel) throw new StaleBriefing();
        const current = await this.gate.withDatabase(tx).authorize(owner, scope);
        // 작성하는 동안 지우거나 대체한 기억이 있으면 다시 작성한다. FOR SHARE가 그 행의 삭제 정리와 직렬화한다.
        if (!await this.memory.live(tx, owner, memory.items)) throw new StaleBriefing();
        // 기억 정정·제외·삭제로 다시 작성한 회차는 새 멱등 키를 쓴다. 막은 이전 사본과 겹치지 않게 한다.
        const key = `briefing:${schedule.id}:${claim.date}${claim.revision ? `:r${claim.revision}` : ''}`;
        const held = (await tx.query(`UPDATE briefing_runs SET state='enqueued',outbox_key=$4,lease_token=NULL,lease_until=NULL,updated_at=$5
          WHERE schedule_id=$1 AND slot_date=$2 AND lease_token=$3 AND state='composing' AND lease_until>$5 RETURNING slot_date`,
        [schedule.id, claim.date, claim.token, key, this.store.now()])).rows.length;
        if (!held) return 'idle';
        await tx.query('INSERT INTO briefing_copies VALUES ($1,$2,$3,$4,$5)', [key, schedule.id, claim.date,
          JSON.stringify(memory.items.map(item => `${item.id}@${item.createdAt}`)), this.store.now()]);
        await this.store.enqueue({ key, actor: owner, scope, revision: current.revision,
          services: memory.services, payload: { kind: 'message', channel: scope.channel, content, classification: 'safe_summary' } }, tx);
        return 'enqueued';
      });
    } catch (error) {
      if (error instanceof Denied) return this.close(claim, 'authorization_revoked');
      if (error instanceof PolicyUnavailable || error instanceof StaleBriefing) {
        await this.db.query(`UPDATE briefing_runs SET lease_until=$4 WHERE schedule_id=$1 AND slot_date=$2 AND lease_token=$3`,
          [schedule.id, claim.date, claim.token, this.store.now() + (error instanceof StaleBriefing ? 0 : BRIEFING.retryMs)]);
        return 'deferred';
      }
      throw error;
    }
  }
  private async close(claim: Claim, reason: string): Promise<'blocked'> {
    await this.store.atomic(async store => {
      await store.db.query(`UPDATE briefing_runs SET state='blocked',reason=$4,lease_token=NULL,lease_until=NULL,updated_at=$5
        WHERE schedule_id=$1 AND slot_date=$2 AND lease_token=$3 AND state='composing'`,
      [claim.schedule.id, claim.date, claim.token, reason, store.now()]);
      await store.audit('briefing_blocked', `${claim.schedule.id}:${claim.date}`, { reason });
    });
    return 'blocked';
  }
  private header(claim: Claim): string[] {
    const zone = claim.schedule.timezone;
    const lines = [`[일일 브리핑] ${claim.date} ${claim.time} ${zone}`];
    if (this.store.now() - claim.slot > BRIEFING.lateMs) lines.push(`지연 발송: 예정 ${claim.time}, 작성 ${clock(this.store.now(), zone)}`);
    return lines;
  }
  private async history(claim: Claim): Promise<string[]> {
    const id = claim.schedule.id;
    const previous = (await this.db.query<{ slot_date: string; slot_at: string | number; outbox_key: string }>(`SELECT slot_date,slot_at,outbox_key
      FROM briefing_runs WHERE schedule_id=$1 AND state='enqueued' AND slot_at<$2 ORDER BY slot_at DESC LIMIT 1`, [id, claim.slot])).rows[0];
    const skipped = (await this.db.query<{ slot_date: string; state: string }>(`SELECT slot_date,state FROM briefing_runs
      WHERE schedule_id=$1 AND slot_at<$2 AND slot_at>$3 AND state IN ('missed','blocked') ORDER BY slot_at`,
    [id, claim.slot, previous ? Number(previous.slot_at) : 0])).rows;
    const lines: string[] = [];
    if (skipped.length) {
      const dates = skipped.map(row => row.slot_date.slice(5));
      // 누락 기록은 중단 한 번에 최대 maxMissed회라 그 이상은 하한으로만 말한다.
      const more = dates.length > 7 ? ` 외 ${dates.length - 7}회${dates.length >= BRIEFING.maxMissed ? ' 이상' : ''}` : '';
      lines.push(`누락: ${dates.slice(0, 7).join(', ')}${more} 브리핑은 보내지 않았습니다(재시작 뒤 몰아 보내지 않음).`);
    }
    if (previous) {
      const states = (await this.db.query<{ state: string }>('SELECT state FROM outbox WHERE message_key=$1', [previous.outbox_key])).rows.map(row => row.state);
      const date = previous.slot_date.slice(5);
      if (states.includes('blocked')) lines.push(`지난 브리핑(${date}) 전달 실패: 다시 보내지 않습니다.`);
      else if (states.includes('unknown')) lines.push(`지난 브리핑(${date}) 전달 결과 확인 불가: 다시 보내지 않습니다.`);
      else if (states.some(state => state === 'pending' || state === 'sending')) lines.push(`지난 브리핑(${date}) 아직 전달 대기 중입니다.`);
    }
    return lines;
  }
  // 정상은 현재 관측이 있을 때만 말한다. 읽기 실패는 마지막 정상 수집 시각과 미확인으로 표시한다.
  private async observations(zone: string): Promise<string[]> {
    if (!this.sources.length) return ['■ 확인 필요', '- 백업·인증서·예약 작업: 연결된 조회 없음 · 미확인'];
    const now = this.store.now();
    const attention: string[] = [];
    const fine: string[] = [];
    // 원본을 함께 읽어 작성 시간이 원본 수에 비례해 lease를 넘지 않게 한다.
    const read = await Promise.all(this.sources.map(source => deadline(Promise.resolve().then(() => source.read()), BRIEFING.sourceTimeoutMs)
      // 미래 시각 검사는 읽은 뒤의 현재 시각과 한다. 작성 시작 시각(now)과 비교하면 원본이 읽는 동안 시계가 지나간 것만으로
      // 방금 읽은 관측이 '미래'가 돼 읽기 불가로 버려진다(PR #26 리뷰).
      .then(value => valid(value, this.store.now()) ? value : undefined, () => undefined)));
    for (const [index, source] of this.sources.entries()) {
      const observation = read[index];
      await this.db.query(`INSERT INTO briefing_observations VALUES ($1,$2,$3,$4) ON CONFLICT (source_id) DO UPDATE SET
        last_ok_at=COALESCE($2,briefing_observations.last_ok_at),last_attempt_at=$3,last_status=$4`,
      [source.id, observation?.observedAt ?? null, now, observation?.status ?? 'unavailable']);
      if (!observation) {
        const last = (await this.db.query<{ last_ok_at: string | number | null }>('SELECT last_ok_at FROM briefing_observations WHERE source_id=$1', [source.id])).rows[0];
        attention.push(`- ${source.label}: 읽기 불가 · 마지막 정상 수집 ${last?.last_ok_at ? clock(Number(last.last_ok_at), zone) : '없음'} · 미확인`);
        continue;
      }
      const check = source.kind === 'backup' ? restoreText(observation, zone) : undefined;
      const restore = check ? ` · ${check.text}` : '';
      const seen = `관측 ${clock(observation.observedAt, zone)}`;
      const summary = bounded(observation.summary.replace(/\s+/g, ' ').trim(), 200);
      if (now - observation.observedAt > BRIEFING.freshMs) attention.push(`- ${source.label}: 오래된 관측(${seen}) · 현재 상태 미확인${restore}`);
      else if (observation.status === 'problem') attention.push(`- ${source.label}: 확인 필요 · ${summary} · ${seen}${restore}`);
      // 백업은 정상이고 복원 검증만 확인 필요면 확인 필요 쪽에 적되 백업 판정(정상)은 그대로 보인다.
      else if (check?.problem) attention.push(`- ${source.label}: 백업 정상 · ${summary} · ${seen}${restore}`);
      else fine.push(`- ${source.label}: 정상 · ${summary} · ${seen}${restore}`);
    }
    // 일부 종류만 연결했으면 나머지 종류를 적는다. 빼면 "확인 필요 없음"이 연결하지 않은 종류까지 정상인 것처럼 읽힌다.
    const unconnected = Object.entries(OBSERVED).filter(([kind]) => !this.sources.some(source => source.kind === kind)).map(([, label]) => label);
    if (unconnected.length) attention.push(`- ${unconnected.join('·')}: 연결된 조회 없음 · 미확인`);
    return [...(attention.length ? ['■ 확인 필요', ...attention] : ['■ 확인 필요', '- 없음(아래 관측 기준)']),
      ...(fine.length ? ['■ 관측 결과', ...fine] : [])];
  }
  private async modelLines(): Promise<string[]> {
    const controls = new Map((await this.db.query<{ key: string; value: unknown }>(
      "SELECT key,value FROM controls WHERE key IN ('scheduler','scheduler_emergency')")).rows.map(row => [row.key, row.value === true]));
    const waits = (await this.db.query<{ wait_reason: string; count: string | number }>(`SELECT wait_reason,count(*) AS count FROM jobs
      WHERE state='waiting_user' AND wait_reason IN ('model_limit','auth_expired') GROUP BY wait_reason ORDER BY wait_reason`)).rows;
    const unknown = Number((await this.db.query<{ count: string | number }>("SELECT count(*) AS count FROM jobs WHERE state='unknown'")).rows[0]!.count);
    const label: Record<string, string> = { model_limit: '한도 대기', auth_expired: '인증 만료 대기' };
    const reasons = [...(controls.get('scheduler_emergency') ? ['비상 중지'] : []), ...waits.map(row => `${label[row.wait_reason]} ${Number(row.count)}건`)];
    const lines = [controls.get('scheduler') || reasons.length
      ? `- 모델 호출: 중지(${reasons.join(', ') || '사유 미기록'}) · /model-status로 확인`
      : '- 모델 호출: 중지 신호 없음'];
    if (unknown) lines.push(`- 종료를 확인하지 못한 작업: ${unknown}건(unknown, 자동 재실행 안 함)`);
    return lines;
  }
  private async memoryLines(owner: string, scope: Scope, zone: string): Promise<{ lines: string[]; items: MemoryView[]; services: string[] }> {
    try {
      const { items, total } = await this.memory.recheckDue(owner, scope);
      if (!items.length) return { lines: ['- 없음'], items: [], services: [] };
      const lines = items.map(item => `- [${KIND[item.kind]}] ${bounded(item.statement.replace(/\s+/g, ' '), 200)}`
        + `${item.observedAt !== null ? ` · 확인 ${clock(item.observedAt, zone)}` : ''} · 현재 조회로 다시 확인 필요`);
      if (total > items.length) lines.push(`- 외 ${total - items.length}건`);
      return { lines, items, services: [...new Set(items.flatMap(item => item.service ? [item.service] : []))].sort() };
    } catch (error) {
      if (error instanceof Denied || error instanceof PolicyUnavailable) throw error;
      return { lines: [error instanceof MemoryNotReady ? '- 삭제 원장 재적용 전이라 조회하지 않음 · 미확인' : '- 기억 조회 실패 · 미확인'], items: [], services: [] };
    }
  }
}
