import { readFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { DEFAULTS, Denied, PolicyUnavailable, ScopeSchema } from './contracts.js';
import type { Clock, Scope } from './contracts.js';
import type { Database } from './database.js';

const PolicySchema = z.strictObject({
  revision: z.string().min(1), confirmedAt: z.number().int().nonnegative(),
  owner: z.string().min(1), guild: z.string().min(1),
  conversationChannel: z.string().min(1), notificationChannel: z.string().min(1),
  dmEnabled: z.boolean().nullable(), services: z.array(z.string()),
  revocationRestores: z.array(z.string().uuid()).optional(),
  // PR 리뷰 정책(T17). 형식 검사는 review.ts가 하고, 없으면 리뷰 경로만 닫힌다.
  review: z.unknown().optional(),
});
export type Policy = z.infer<typeof PolicySchema>;
export class PolicyGate {
  constructor(private readonly source: () => Promise<unknown>, private readonly db: Database,
    private readonly now: Clock = Date.now) {}
  static mounted(path: string, db: Database, now?: Clock): PolicyGate {
    return new PolicyGate(async () => JSON.parse(await readFile(path, 'utf8')), db, now);
  }
  withDatabase(db: Database): PolicyGate { return new PolicyGate(this.source, db, this.now); }
  async current(): Promise<Policy> {
    try {
      const p = PolicySchema.parse(await this.source());
      if (p.confirmedAt > this.now() || this.now() - p.confirmedAt > DEFAULTS.policyMaxAgeMs) throw new PolicyUnavailable();
      return p;
    } catch { throw new PolicyUnavailable(); }
  }
  async authorize(actor: string, scope: Scope, revision?: string): Promise<Policy> {
    ScopeSchema.parse(scope);
    const p = await this.current();
    // A revision is evidence, not authority: always evaluate the current policy.
    if (actor !== p.owner) throw new Denied();
    if (scope.kind === 'dm') {
      if (p.dmEnabled !== true || scope.guild !== null || scope.parent !== null) throw new Denied();
    } else {
      const parent = scope.kind === 'thread' ? scope.parent : scope.channel;
      if (scope.guild !== p.guild || !parent || ![p.conversationChannel, p.notificationChannel].includes(parent)) throw new Denied();
      if (scope.kind === 'channel' && scope.parent !== null) throw new Denied();
    }
    await this.db.query(`DELETE FROM denied_actors WHERE actor_id=$1 AND policy_revision IS NOT NULL
      AND policy_revision<>$2 AND created_at<$3 AND denial_id=ANY($4::text[])`,
    [actor, p.revision, p.confirmedAt, p.revocationRestores ?? []]);
    if ((await this.db.query('SELECT actor_id FROM denied_actors WHERE actor_id=$1', [actor])).rows.length) throw new Denied();
    return p;
  }
  async revoke(actor: string, scope: Scope, target: string): Promise<void> {
    const p = await this.authorize(actor, scope);
    await this.db.query(`INSERT INTO denied_actors(actor_id,created_at,policy_revision,denial_id) VALUES ($1,$2,$3,$4)
      ON CONFLICT (actor_id) DO UPDATE SET created_at=$2,policy_revision=$3,denial_id=$4`, [target, this.now(), p.revision, randomUUID()]);
  }
}
