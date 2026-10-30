import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { Denied, PolicyUnavailable, ScopeSchema } from './contracts.js';
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
// 사람이 Infisical에 두는 값(env RUNTIME_POLICIES)의 모양. confirmedAt은 봇이 읽은 시각으로 채우므로 받지 않는다.
const RuntimePolicyInputSchema = PolicySchema.omit({ confirmedAt: true });
function frozen<T>(value: T): T {
  if (value !== null && typeof value === 'object') {
    for (const child of Object.values(value)) frozen(child);
    Object.freeze(value);
  }
  return value;
}
// D1(사용자 2026-10-30): 정책은 기동 때 env에서 한 번 읽는다. 값 변경은 `homelab secret set`의 파드 재시작으로 반영되고,
// 즉시 차단은 /revoke(DB 거부 목록)다. confirmedAt은 이 읽은 시각이고, 거부 해제(revocationRestores)가
// "철회 뒤 확인한 정책"인지 가리는 기준이다. 오류 메시지에는 필드 경로만 넣고 값은 넣지 않는다(값이 비밀일 수 있다).
export function loadRuntimePolicy(raw: string, loadedAt: number): Policy {
  let input: unknown;
  try { input = JSON.parse(raw); } catch { throw new Error('runtime_policies_invalid: json'); }
  const parsed = RuntimePolicyInputSchema.safeParse(input);
  if (!parsed.success) {
    const fields = [...new Set(parsed.error.issues.flatMap(issue => {
      const path = issue.path.map(String).join('.');
      const keys = issue.code === 'unrecognized_keys' ? issue.keys.map(key => path ? `${path}.${key}` : key) : [];
      return keys.length ? keys : [path || '(root)'];
    }))];
    throw new Error(`runtime_policies_invalid: ${fields.join(',')}`);
  }
  return frozen({ ...parsed.data, confirmedAt: loadedAt });
}
export class PolicyGate {
  constructor(private readonly source: () => Promise<unknown>, private readonly db: Database,
    private readonly now: Clock = Date.now) {}
  static fixed(policy: Policy, db: Database, now?: Clock): PolicyGate {
    return new PolicyGate(async () => policy, db, now);
  }
  withDatabase(db: Database): PolicyGate { return new PolicyGate(this.source, db, this.now); }
  async current(): Promise<Policy> {
    try {
      const p = PolicySchema.parse(await this.source());
      // 읽은 시각이 미래면(시계 역행) 해제 판단의 기준이 틀어지므로 닫는다. 나이는 보지 않는다(D1).
      if (p.confirmedAt > this.now()) throw new PolicyUnavailable();
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
