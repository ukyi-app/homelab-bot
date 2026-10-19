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
export class GatewayBudget {
  constructor(private readonly store: Store) {}
  async identify(): Promise<boolean> {
    return this.store.db.transaction(async tx => {
      await tx.query(`INSERT INTO controls VALUES ('identify','{}') ON CONFLICT DO NOTHING`);
      await tx.query(`SELECT * FROM controls WHERE key='identify' FOR UPDATE`);
      const count = (await tx.query<{ count: string }>("SELECT count(*) FROM audit WHERE kind='identify' AND created_at>$1",
        [this.store.now() - 86_400_000])).rows[0]!;
      if (Number(count.count) >= 900) return false;
      await tx.query("INSERT INTO audit(kind,subject,detail,created_at) VALUES ('identify','gateway','{}',$1)", [this.store.now()]);
      return true;
    });
  }
  backoff(attempt: number, random = Math.random()): number {
    return Math.min(60_000, 1000 * 2 ** Math.min(Math.max(0, attempt), 10)) + Math.floor(1000 * Math.max(0, Math.min(1, random)));
  }
}
