import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { RevisionSchema } from './change-contracts.js';
import { ChangeRepositoryPolicySchema } from './change-policy.js';
import { Denied, PolicyUnavailable, ScopeSchema } from './contracts.js';
import type { Clock, Scope } from './contracts.js';
import type { Database } from './database.js';

// 변경 PR 정책. 키가 없는 옛 정책은 그대로 통과하고 CHANGE만 닫힌다. 있으면 값이 잘못된 것을 스위치와 무관하게 기동 전에 막는다.
const ChangePolicySchema = z.strictObject({ repositories: z.array(ChangeRepositoryPolicySchema).min(1).max(16) }).superRefine((policy, ctx) => {
  if (new Set(policy.repositories.map(repository => repository.repoId)).size !== policy.repositories.length) ctx.addIssue({ code: 'custom', path: ['repositories'], message: 'duplicate_repository' });
  if (new Set(policy.repositories.map(repository => repository.fullName)).size !== policy.repositories.length) ctx.addIssue({ code: 'custom', path: ['repositories'], message: 'duplicate_repository' });
});
const PolicyFields = z.strictObject({
  revision: z.string().min(1), confirmedAt: z.number().int().nonnegative(),
  owner: z.string().min(1), guild: z.string().min(1),
  conversationChannel: z.string().min(1), notificationChannel: z.string().min(1),
  dmEnabled: z.boolean().nullable(), services: z.array(z.string()),
  revocationRestores: z.array(z.string().uuid()).optional(),
  // PR 리뷰 정책. 형식 검사는 review.ts가 하고, 없으면 리뷰 경로만 닫힌다.
  review: z.unknown().optional(),
  // 작업 레인 프로젝트 정책. 형식 검사는 task-policy.ts가 하고, 없으면 작업 레인만 닫힌다.
  task: z.unknown().optional(),
  change: ChangePolicySchema.optional(),
  // 동료 기능 스위치(DECISIONS "동료 봇 전환" 9). 없으면 꺼짐. 문자열 "true" 같은 오타가 조용히 꺼짐이 되지 않게 참·거짓만 받는다.
  // 읽는 곳은 PublisherConfig.colleagueEnabled 하나다.
  colleagueEnabled: z.boolean().optional(),
});
// 이 값이 증거 묶음의 policy revision이 된다. 묶음이 받지 않는 모양이면 모델을 돌린 뒤에야 막힌다.
const changeRevisionShape = (policy: { revision: string; change?: unknown }, ctx: z.RefinementCtx) => {
  if (policy.change && !RevisionSchema.safeParse(policy.revision).success) ctx.addIssue({ code: 'custom', path: ['revision'], message: 'revision_shape' });
};
const PolicySchema = PolicyFields.superRefine(changeRevisionShape);
export type Policy = z.infer<typeof PolicySchema>;
// 사람이 Infisical에 두는 값(env RUNTIME_POLICIES)의 모양. confirmedAt은 봇이 읽은 시각으로 채우므로 받지 않는다.
const RuntimePolicyInputSchema = PolicyFields.omit({ confirmedAt: true }).superRefine(changeRevisionShape);
function frozen<T>(value: T): T {
  if (value !== null && typeof value === 'object') {
    for (const child of Object.values(value)) frozen(child);
    Object.freeze(value);
  }
  return value;
}
// D1(사용자 결정): 정책은 기동 때 env에서 한 번 읽는다. 값 변경은 `homelab secret set`의 파드 재시작으로 반영되고,
// 즉시 차단은 /revoke(DB 거부 목록)다. confirmedAt은 이 읽은 시각이고, 거부 해제(revocationRestores)가
// "철회 뒤 확인한 정책"인지 가리는 기준이다. 오류 메시지에는 알려진 필드 경로만 넣고 값·모르는 키 이름은 넣지 않는다(비밀일 수 있다).
export function loadRuntimePolicy(raw: string, loadedAt: number): Policy {
  let input: unknown;
  try { input = JSON.parse(raw); } catch { throw new Error('runtime_policies_invalid: json'); }
  const parsed = RuntimePolicyInputSchema.safeParse(input);
  if (!parsed.success) {
    // 모르는 키의 이름은 env 원문에서 온 임의 문자열이라(비밀을 키로 잘못 넣을 수 있다) 이름 대신 개수만 남긴다.
    // 나머지 경로는 스키마가 아는 필드 이름과 배열 위치뿐이다.
    // confirmedAt은 봇이 채우는 고정 필드라 이름을 그대로 알려 준다.
    const fields = [...new Set(parsed.error.issues.flatMap(issue => {
      const path = issue.path.map(String).join('.');
      if (issue.code !== 'unrecognized_keys') return [path || '(root)'];
      const known = issue.keys.filter(key => !path && key === 'confirmedAt');
      const unknown = issue.keys.length - known.length;
      return [...known, ...(unknown ? [`${path ? `${path}.` : ''}unknown_field(${unknown})`] : [])];
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
    await this.restoreApproved(actor, p);
    if ((await this.db.query('SELECT actor_id FROM denied_actors WHERE actor_id=$1', [actor])).rows.length) throw new Denied();
    return p;
  }
  // 사람이 revocationRestores에 적은, 철회 뒤 확인한 정책보다 앞선 거부만 지운다.
  private async restoreApproved(actor: string, p: Policy): Promise<void> {
    await this.db.query(`DELETE FROM denied_actors WHERE actor_id=$1 AND policy_revision IS NOT NULL
      AND policy_revision<>$2 AND created_at<$3 AND denial_id=ANY($4::text[])`,
    [actor, p.revision, p.confirmedAt, p.revocationRestores ?? []]);
  }
  // 관리 기능 차단(COLLEAGUE_SPEC §4.8). 권한의 근거는 클러스터 접근이라 actor·범위를 대조하지 않는다. owner 자신도 막을 수 있다.
  // 정책은 거부 행의 revision을 적으려고만 읽고, 읽지 못하면 PolicyUnavailable로 아무것도 더하지 않는다. 해제 경로는 없다.
  // 이미 거부돼 있으면 행을 그대로 둔다(새 거부면 true). 덮어쓰면 denial_id가 바뀌어 사람이 준비해 둔 해제 승인이 듣지 않는다.
  // 다만 해제 승인이 이미 적힌 옛 거부는 다음 인가가 지울 행이라 먼저 지우고 새 거부를 더한다.
  async deny(target: string): Promise<boolean> {
    const p = await this.current();
    await this.restoreApproved(target, p);
    return (await this.db.query(`INSERT INTO denied_actors(actor_id,created_at,policy_revision,denial_id) VALUES ($1,$2,$3,$4)
      ON CONFLICT (actor_id) DO NOTHING RETURNING actor_id`, [target, this.now(), p.revision, randomUUID()])).rows.length > 0;
  }
  async revoke(actor: string, scope: Scope, target: string): Promise<void> {
    const p = await this.authorize(actor, scope);
    await this.db.query(`INSERT INTO denied_actors(actor_id,created_at,policy_revision,denial_id) VALUES ($1,$2,$3,$4)
      ON CONFLICT (actor_id) DO UPDATE SET created_at=$2,policy_revision=$3,denial_id=$4`, [target, this.now(), p.revision, randomUUID()]);
  }
}
