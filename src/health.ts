import { DEFAULTS } from './contracts.js';
import type { Store } from './store.js';

export class Health {
  private connected = false;
  private lastConnected: number | null = null;
  private lastLoop: number | null = null;
  private lastPing: number | null = null;
  private pinging = false;
  public receivers = { app: false, alerts: false };
  constructor(private readonly store: Store, private readonly ping: () => Promise<void>) {}
  gateway(connected: boolean): void {
    this.connected = connected;
    if (connected) this.lastConnected = this.store.now();
  }
  loop(): void { this.lastLoop = this.store.now(); }
  async ready(): Promise<boolean> {
    if (!this.receivers.app || !this.receivers.alerts) return false;
    try {
      await this.store.db.transaction(async tx => {
        await tx.query(`INSERT INTO controls VALUES ('readiness','true') ON CONFLICT (key) DO UPDATE SET value='true'`);
      });
      return true;
    } catch { return false; }
  }
  async heartbeat(): Promise<boolean> {
    const now = this.store.now();
    if (this.connected) this.lastConnected = now;
    if (this.pinging || this.lastLoop === null || now - this.lastLoop > DEFAULTS.heartbeatMs
      || this.lastConnected === null || now - this.lastConnected > DEFAULTS.gatewayGraceMs
      || (this.lastPing !== null && now - this.lastPing < DEFAULTS.heartbeatMs)) return false;
    this.pinging = true;
    try { await this.ping(); this.lastPing = now; return true; }
    finally { this.pinging = false; }
  }
  async metrics(): Promise<string> {
    const unknown = (await this.store.db.query<{ count: string }>("SELECT count(*) FROM outbox WHERE state='unknown'")).rows[0]!;
    const row = (await this.store.db.query<{ oldest: string | null }>(
      "SELECT min(created_at) AS oldest FROM outbox WHERE state IN ('pending','unknown')")).rows[0]!;
    return `homelab_bot_gateway_connected ${Number(this.connected)}\n`
      + `homelab_bot_outbox_unknown ${unknown.count}\n`
      + `homelab_bot_outbox_oldest_seconds ${row.oldest === null ? 0 : Math.max(0, (this.store.now() - Number(row.oldest)) / 1000)}\n`;
  }
}
// Discord는 IDENTIFY를 24시간 1000회(봇 상한 900), rate_limit_key마다 5초에 1회 받는다. 단일 shard라 키는 하나다.
// 다중 shard가 되면 max_concurrency 버킷마다 이 간격을 따로 둔다. 예약 시각과 Discord가 받는 시각 사이 지연 차이에 0.5초 여유를 둔다.
export const IDENTIFY_INTERVAL_MS = 5500;
const DAY_MS = 86_400_000;
export class GatewayBudget {
  constructor(private readonly store: Store, private readonly intervalMs = IDENTIFY_INTERVAL_MS) {}
  // 다음 IDENTIFY를 보낼 수 있는 가장 이른 시각(읽기만). 일일 예산이 없으면 undefined. 연결 전에 기다릴 시간을 정한다.
  async next(): Promise<number | undefined> {
    const now = this.store.now();
    const row = (await this.store.db.query<{ count: string; last: string | null }>(
      "SELECT count(*) AS count,max(created_at) AS last FROM audit WHERE kind='identify' AND created_at>$1", [now - DAY_MS])).rows[0]!;
    if (Number(row.count) >= 900) return undefined;
    return Math.max(now, row.last === null ? 0 : Number(row.last) + this.intervalMs);
  }
  // IDENTIFY 한 번을 예약하고 그 시각을 돌려준다. 일일 900회와 직전 예약에서 5초 간격을 같은 잠금 아래에서 함께 본다.
  // 예약 시각은 audit에 남아 프로세스를 다시 시작해도 이어진다. RESUME은 예약하지 않는다. 예산이 없으면 undefined.
  async reserve(): Promise<number | undefined> {
    return this.store.db.transaction(async tx => {
      await tx.query(`INSERT INTO controls VALUES ('identify','{}') ON CONFLICT DO NOTHING`);
      await tx.query(`SELECT * FROM controls WHERE key='identify' FOR UPDATE`);
      const now = this.store.now();
      const row = (await tx.query<{ count: string; last: string | null }>(
        "SELECT count(*) AS count,max(created_at) AS last FROM audit WHERE kind='identify' AND created_at>$1", [now - DAY_MS])).rows[0]!;
      if (Number(row.count) >= 900) return undefined;
      const at = Math.max(now, row.last === null ? 0 : Number(row.last) + this.intervalMs);
      await tx.query("INSERT INTO audit(kind,subject,detail,created_at) VALUES ('identify','gateway','{}',$1)", [at]);
      return at;
    });
  }
  backoff(attempt: number, random = Math.random()): number {
    return Math.min(60_000, 1000 * 2 ** Math.min(Math.max(0, attempt), 10)) + Math.floor(1000 * Math.max(0, Math.min(1, random)));
  }
}
