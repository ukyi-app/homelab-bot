import { randomUUID } from 'node:crypto';
import { open, readFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { z } from 'zod';
import { Denied } from './contracts.js';
import type { Clock, Scope } from './contracts.js';
import type { Database } from './database.js';
import type { Policy, PolicyGate } from './policy.js';

export class MemoryRejected extends Error { constructor(reason: string) { super(reason); } }
export class MemoryNotReady extends Error { constructor() { super('memory_not_ready'); } }

const SourceSchema = z.discriminatedUnion('type', [
  z.strictObject({ type: z.literal('conversation'), message: z.string().min(1).max(100) }),
  z.strictObject({ type: z.literal('job'), job: z.string().min(1).max(100) }),
  z.strictObject({ type: z.literal('document'), uri: z.string().min(1).max(500), revision: z.string().min(1).max(100).nullable() }),
  // PR 댓글·로그 같은 비신뢰 자료. 위치만 남기고 근거로 세지 않는다.
  z.strictObject({ type: z.literal('external'), uri: z.string().min(1).max(500) }),
]);
export type SourceRef = z.infer<typeof SourceSchema>;
const Text = z.string().trim().min(1).max(1000);
const Time = z.number().int().nonnegative();
const common = {
  statement: Text, topic: z.string().trim().min(1).max(200).optional(),
  sources: z.array(SourceSchema).max(10),
  scope: z.strictObject({ user: z.string().min(1).optional(), guild: z.string().min(1).optional(),
    channel: z.string().min(1).optional(), repo: z.string().min(1).optional(), service: z.string().min(1).optional() }).default({}),
  access: z.array(z.string().min(1)).min(1).max(2).optional(),
  classification: z.enum(['internal', 'safe_summary']).default('internal'),
  validFrom: Time.optional(), expiresAt: Time.optional(), recheckAt: Time.optional(),
  recheckCondition: z.string().trim().min(1).max(300).optional(),
};
// 정책·권한·게시 대상 필드가 없다. 기억은 어떤 권한 판단에도 쓰이지 않는다.
export const MemoryInputSchema = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('configuration'), ...common, observedAt: Time, sourceRevision: z.string().min(1).max(100).optional() }),
  z.strictObject({ kind: z.literal('decision'), ...common, decidedBy: z.string().min(1).max(100), decidedAt: Time, appliesTo: Text }),
  z.strictObject({ kind: z.literal('incident'), ...common, facts: z.array(Text).max(10),
    hypotheses: z.array(Text).max(10), unconfirmedCauses: z.array(Text).max(10) }),
  z.strictObject({ kind: z.literal('preference'), ...common, targetUser: z.string().min(1).max(100), expiresAt: Time, endCondition: Text }),
]);
export type MemoryInput = z.input<typeof MemoryInputSchema>;
type Parsed = z.infer<typeof MemoryInputSchema>;
type Kind = Parsed['kind'];
export type SourceCheck = 'verified' | 'unverified' | 'inaccessible';
interface Evidence { active: boolean; keys: string[] }
export interface DocumentSource { check(actor: string, uri: string, revision: string | null): Promise<SourceCheck> }
// 출처 링크가 있다고 정확하다는 뜻은 아니다. 종류마다 근거로 인정하는 출처만 active로 올린다.
const EVIDENCE: Record<Kind, SourceRef['type'][]> = {
  configuration: ['document', 'job'], decision: ['conversation', 'document'],
  incident: ['job', 'document'], preference: ['conversation'],
};
interface MemoryRow {
  id: string; kind: Kind; statement: string; topic: string | null; details: Record<string, unknown>;
  source_refs: SourceRef[]; source_revision: string | null; observed_at: string | number | null;
  owner_id: string; scope: Parsed['scope']; access_channels: string[]; output_classification: 'internal' | 'safe_summary';
  valid_from: string | number; expires_at: string | number | null; recheck_at: string | number | null;
  status: 'candidate' | 'active' | 'superseded' | 'deleted'; conflicts_with: string[];
  deletion_requested_at: string | number | null; created_at: string | number; updated_at: string | number;
}
export interface MemoryView {
  id: string; kind: Kind; statement: string; status: 'candidate' | 'active'; topic: string | null;
  details: Record<string, unknown>; sources: SourceRef[]; observedAt: number | null; createdAt: number;
  recheckAt: number | null; expiresAt: number | null; service: string | null;
  flags: ('unverified' | 'conflict' | 'recheck_due')[];
}
export interface DeletionResult { status: 'deleted' | 'pending'; reason?: 'ledger_unconfirmed' | 'db_purge_pending'; publishedCopies: number; message: string }

export interface DeletionEntry { memoryId: string; createdAt: number; deletedAt: number }
// 복원 대상 밖의 append-only 삭제 원장. append가 resolve되면 내구성 있게 기록된 것이다.
export interface DeletionLedger {
  append(entry: DeletionEntry): Promise<void>;
  has(memoryId: string, createdAt: number): Promise<boolean>;
  entries(): Promise<DeletionEntry[]>;
}
const EntrySchema = z.strictObject({ memoryId: z.string().min(1), createdAt: Time, deletedAt: Time });
// 로컬 대역이다. 실제 원장 위치(R2 등)는 결정 대기(DECISIONS T20).
export class FileDeletionLedger implements DeletionLedger {
  private tail: Promise<unknown> = Promise.resolve();
  private dirSynced = false;
  private syncFailed = false;
  constructor(private readonly path: string) {}
  // 프로세스 안의 append를 줄 세운다. 겹치면 한쪽의 조각 잘라내기가 다른 쪽의 확정된 줄을 지운다.
  // 쓰는 프로세스는 하나라고 가정한다.
  append(entry: DeletionEntry): Promise<void> {
    const run = this.tail.then(() => this.write(entry));
    this.tail = run.catch(() => {});
    return run;
  }
  private async write(entry: DeletionEntry): Promise<void> {
    const line = `${JSON.stringify(EntrySchema.parse(entry))}\n`;
    const handle = await open(this.path, 'a+');
    try {
      // 끊긴 이전 append의 조각 뒤에 붙이면 원장이 손상된다. 확인되지 않은 조각이므로 잘라낸다.
      const raw = await readFile(this.path, 'utf8');
      if (raw.length && !raw.endsWith('\n')) await handle.truncate(Buffer.byteLength(raw.slice(0, raw.lastIndexOf('\n') + 1)));
      await handle.appendFile(line);
      try { await handle.sync(); } catch (error) { this.syncFailed = true; throw error; }
    } finally { await handle.close(); }
    // 파일을 만든 직후뿐 아니라 이 프로세스에서 확인하기 전까지는 디렉터리 항목도 fsync해야 전원 차단 뒤 파일이 남는다.
    if (!this.dirSynced) {
      const dir = await open(dirname(this.path), 'r');
      try { await dir.sync(); } finally { await dir.close(); }
      this.dirSynced = true;
    }
  }
  // fsync가 한 번 실패하면 커널이 실패한 페이지를 clean으로 돌려 캐시만 보고 기록됐다고 답할 수 있다. 그 뒤로는 판정하지 않는다.
  async has(memoryId: string, createdAt: number): Promise<boolean> {
    if (this.syncFailed) throw new Error('deletion_ledger_unsynced');
    await this.tail;
    return (await this.entries()).some(e => e.memoryId === memoryId && e.createdAt === createdAt);
  }
  async entries(): Promise<DeletionEntry[]> {
    let raw: string;
    try { raw = await readFile(this.path, 'utf8'); } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
      throw error;
    }
    const lines = raw.split('\n');
    // 마지막 줄이 줄바꿈 없이 끝나면 확인되지 않은 append가 끊긴 것이다. 그 줄만 무시한다.
    const complete = lines.slice(0, -1);
    return complete.filter(line => line.length).map(line => {
      try { return EntrySchema.parse(JSON.parse(line)); } catch { throw new Error('deletion_ledger_corrupt'); }
    });
  }
}

const parent = (scope: Scope) => scope.kind === 'thread' ? scope.parent ?? '' : scope.channel;
const erasedKey = (id: string, createdAt: number) => `${id}@${createdAt}`;
const num = (value: string | number | null) => value === null ? null : Number(value);
export function terms(text: string): string[] {
  return [...new Set(text.normalize('NFC').toLowerCase().split(/[^\p{L}\p{N}]+/u).filter(Boolean).map(t => t.slice(0, 50)))].slice(0, 200);
}
const like = (term: string) => `${term.replace(/[!%_]/g, '!$&')}%`;
const REDACTED = '[삭제된 기억이 포함돼 로컬 사본을 지웠습니다]';

export class MemoryService {
  private ready = false;
  private readonly erased = new Set<string>();
  constructor(private readonly db: Database, private readonly gate: PolicyGate, private readonly ledger: DeletionLedger,
    private readonly documents: DocumentSource, private readonly now: Clock = Date.now) {}
  // 기동 때마다 원장의 삭제를 다시 적용한 뒤에만 조회를 연다. 원장을 못 읽으면 닫힌 채로 둔다.
  async open(): Promise<{ entries: number; applied: number }> {
    this.ready = false;
    const entries = await this.ledger.entries();
    for (const entry of entries) this.erased.add(erasedKey(entry.memoryId, entry.createdAt));
    let applied = 0;
    for (const entry of entries) if ((await this.purge(entry.memoryId, entry.createdAt, entry.deletedAt, true)).applied) applied++;
    await this.resume();
    await this.audit('memory_ledger_replayed', 'memory', { entries: entries.length, applied });
    this.ready = true;
    return { entries: entries.length, applied };
  }
  async resume(): Promise<number> {
    const rows = (await this.db.query<{ memory_id: string; memory_created_at: string | number }>(
      'SELECT memory_id,memory_created_at FROM memory_deletions WHERE applied_at IS NULL ORDER BY requested_at')).rows;
    let done = 0;
    for (const row of rows) if ((await this.finish(row.memory_id, Number(row.memory_created_at))).status === 'deleted') done++;
    return done;
  }
  async remember(actor: string, scope: Scope, raw: unknown): Promise<{ id: string; status: 'active' | 'candidate'; conflictsWith: string[] }> {
    this.assertReady();
    const policy = await this.gate.authorize(actor, scope);
    const input = this.parse(raw);
    const evidence = await this.evidence(actor, input);
    const access = this.access(policy, scope, input);
    return this.db.transaction(tx => this.insert(tx, actor, scope, input, access, evidence, [], null));
  }
  async correct(actor: string, scope: Scope, ids: string[], raw: unknown, reason: string): Promise<{ id: string; status: 'active' | 'candidate'; conflictsWith: string[] }> {
    this.assertReady();
    const policy = await this.gate.authorize(actor, scope);
    const why = Text.safeParse(reason);
    if (!why.success || !ids.length) throw new MemoryRejected('memory_correction_reason_required');
    const input = this.parse(raw);
    const evidence = await this.evidence(actor, input);
    const access = this.access(policy, scope, input);
    return this.db.transaction(async tx => {
      const current = await this.gate.withDatabase(tx).authorize(actor, scope);
      // remember와 같은 순서(주제 잠금 → 행 잠금)로 잡아야 교착하지 않는다.
      await this.lockTopic(tx, actor, input.topic);
      const rows = (await tx.query<MemoryRow>('SELECT * FROM memories WHERE id=ANY($1::text[]) FOR UPDATE', [ids])).rows;
      if (rows.length !== new Set(ids).size || !rows.every(row => ['active', 'candidate'].includes(row.status)
        && this.visible(current, actor, scope, row))) throw new Denied();
      const result = await this.insert(tx, actor, scope, input, access, evidence, ids, why.data);
      await tx.query("UPDATE memories SET status='superseded',updated_at=$2 WHERE id=ANY($1::text[])", [ids, this.now()]);
      await tx.query('DELETE FROM memory_terms WHERE memory_id=ANY($1::text[])', [ids]);
      await this.forget(tx, ids);
      return result;
    });
  }
  // 이미 저장한 기억도 다음 접근부터 검색·브리핑에서 뺀다. 저장소·백업에서 지우는 것은 delete다.
  async exclude(actor: string, scope: Scope, sourceKey: string): Promise<{ hidden: number }> {
    this.assertReady();
    await this.gate.authorize(actor, scope);
    if (!/^(conversation|job|document|external|channel):.{1,500}$/s.test(sourceKey)) throw new MemoryRejected('memory_exclusion_invalid');
    await this.db.query('INSERT INTO memory_exclusions(source_key,owner_id,created_at) VALUES ($1,$2,$3) ON CONFLICT DO NOTHING', [sourceKey, actor, this.now()]);
    const hidden = (await this.db.query<{ count: string | number }>(`SELECT count(*) AS count FROM memories
      WHERE owner_id=$1 AND status IN ('active','candidate') AND source_keys ? $2`, [actor, sourceKey])).rows[0]!.count;
    return { hidden: Number(hidden) };
  }
  async search(actor: string, scope: Scope, query: string): Promise<MemoryView[]> {
    this.assertReady();
    const policy = await this.gate.authorize(actor, scope);
    const words = terms(query).slice(0, 8);
    const params: unknown[] = [actor, this.now(), parent(scope)];
    const filters = words.map(word => {
      params.push(like(word));
      return `AND EXISTS (SELECT 1 FROM memory_terms t WHERE t.memory_id=m.id AND t.term LIKE $${params.length} ESCAPE '!')`;
    });
    const rows = (await this.db.query<MemoryRow>(`SELECT m.* FROM memories m WHERE m.owner_id=$1
      AND m.status IN ('active','candidate') AND m.deletion_requested_at IS NULL
      AND m.valid_from<=$2 AND (m.expires_at IS NULL OR m.expires_at>$2) AND m.access_channels ? $3
      AND NOT EXISTS (SELECT 1 FROM memory_deletions d WHERE d.memory_id=m.id AND d.memory_created_at=m.created_at)
      AND NOT EXISTS (SELECT 1 FROM memory_exclusions x WHERE x.owner_id=m.owner_id AND m.source_keys ? x.source_key)
      ${filters.join(' ')} ORDER BY m.updated_at DESC, m.id LIMIT 20`, params)).rows;
    return this.views(rows.filter(row => this.visible(policy, actor, scope, row)));
  }
  // 브리핑에는 그 채널에 공개해도 되는 active 기억 중 다시 확인할 것만 넣는다.
  async recheckDue(actor: string, scope: Scope): Promise<{ items: MemoryView[]; total: number }> {
    this.assertReady();
    const policy = await this.gate.authorize(actor, scope);
    const rows = (await this.db.query<MemoryRow>(`SELECT * FROM memories m WHERE owner_id=$1 AND status='active'
      AND output_classification='safe_summary' AND deletion_requested_at IS NULL AND recheck_at<=$2 AND valid_from<=$2
      AND (expires_at IS NULL OR expires_at>$2) AND access_channels ? $3
      AND NOT EXISTS (SELECT 1 FROM memory_exclusions x WHERE x.owner_id=m.owner_id AND m.source_keys ? x.source_key)
      ORDER BY recheck_at, id LIMIT 50`, [actor, this.now(), parent(scope)])).rows.filter(row => this.visible(policy, actor, scope, row));
    return { items: (await this.views(rows)).slice(0, 5), total: rows.length };
  }
  // 브리핑을 큐에 넣는 transaction 안에서 부른다. FOR SHARE로 같은 행의 삭제 요청·정리·정정과 직렬화한다.
  async live(tx: Database, items: Pick<MemoryView, 'id' | 'createdAt'>[]): Promise<boolean> {
    if (!items.length) return true;
    if (items.some(item => this.erased.has(erasedKey(item.id, item.createdAt)))) return false;
    const rows = (await tx.query<{ id: string; created_at: string | number }>(`SELECT id,created_at FROM memories m
      WHERE id=ANY($1::text[]) AND status='active' AND deletion_requested_at IS NULL
      AND NOT EXISTS (SELECT 1 FROM memory_exclusions x WHERE x.owner_id=m.owner_id AND m.source_keys ? x.source_key)
      FOR SHARE`, [items.map(item => item.id)])).rows;
    return items.every(item => rows.some(row => row.id === item.id && Number(row.created_at) === item.createdAt));
  }
  async delete(actor: string, scope: Scope, id: string): Promise<DeletionResult> {
    this.assertReady();
    const policy = await this.gate.authorize(actor, scope);
    const row = (await this.db.query<MemoryRow>('SELECT * FROM memories WHERE id=$1', [id])).rows[0];
    // 남의 기억이나 다른 채널 기억은 존재 여부도 알리지 않는다. 지운 기억의 재요청은 같은 owner에게 멱등으로 답한다.
    if (!row || row.owner_id !== actor || (row.status !== 'deleted' && !this.visible(policy, actor, scope, row, true))) throw new Denied();
    const createdAt = Number(row.created_at);
    await this.db.transaction(async tx => {
      await this.gate.withDatabase(tx).authorize(actor, scope);
      await tx.query(`INSERT INTO memory_deletions(memory_id,memory_created_at,requested_by,requested_at) VALUES ($1,$2,$3,$4)
        ON CONFLICT DO NOTHING`, [id, createdAt, actor, this.now()]);
      await tx.query('UPDATE memories SET deletion_requested_at=$3 WHERE id=$1 AND created_at=$2 AND deletion_requested_at IS NULL',
        [id, createdAt, this.now()]);
    });
    return this.finish(id, createdAt);
  }
  private async finish(id: string, createdAt: number): Promise<DeletionResult> {
    const request = (await this.db.query<{ ledger_state: string; requested_at: string | number; applied_at: string | number | null }>(
      'SELECT * FROM memory_deletions WHERE memory_id=$1 AND memory_created_at=$2', [id, createdAt])).rows[0];
    if (!request) throw new Denied();
    if (request.applied_at !== null) return { status: 'deleted', publishedCopies: 0, message: '이미 삭제가 끝난 기억입니다.' };
    const key = erasedKey(id, createdAt);
    if (request.ledger_state !== 'recorded' && !this.erased.has(key)) {
      let recorded = false;
      const entry = { memoryId: id, createdAt, deletedAt: Number(request.requested_at) };
      // 중복 항목은 재적용에서 무해하므로 한 번 더 쓴다. 그래도 실패하면 응답만 잃었을 수 있어 원장을 다시 읽어 판단한다.
      for (let attempt = 0; attempt < 2 && !recorded; attempt++) recorded = await this.ledger.append(entry).then(() => true, () => false);
      if (!recorded) recorded = await this.ledger.has(id, createdAt).catch(() => false);
      if (!recorded) {
        await this.audit('memory_deletion_pending', id, { reason: 'ledger_unconfirmed' }).catch(() => {});
        return { status: 'pending', reason: 'ledger_unconfirmed', publishedCopies: 0,
          message: '삭제 원장 기록을 확인하지 못해 아직 삭제하지 않았습니다. 조회에서는 숨기고 원장 기록을 다시 시도합니다.' };
      }
      this.erased.add(key);
    }
    try {
      const { publishedCopies } = await this.purge(id, createdAt, Number(request.requested_at), false);
      return { status: 'deleted', publishedCopies, message: publishedCopies
        ? `삭제했습니다. 이미 보냈거나 전송 결과를 모르는 브리핑 ${publishedCopies}건은 Discord에서 지우지 않았습니다. 백업에는 최대 14일 남을 수 있고 복원하면 기동 때 다시 지웁니다.`
        : '삭제했습니다. 백업에는 최대 14일 남을 수 있고 복원하면 기동 때 다시 지웁니다.' };
    } catch {
      return { status: 'pending', reason: 'db_purge_pending', publishedCopies: 0,
        message: '삭제 원장에는 기록했지만 DB 정리가 끝나지 않았습니다. 조회에서는 숨기고 정리를 다시 시도합니다.' };
    }
  }
  private async purge(id: string, createdAt: number, deletedAt: number, replay: boolean): Promise<{ applied: boolean; publishedCopies: number }> {
    return this.db.transaction(async tx => {
      const now = this.now();
      const applied = (await tx.query(`UPDATE memories SET status='deleted',statement='',topic=NULL,details='{}',source_refs='[]',source_keys='[]',
        source_revision=NULL,scope='{}',access_channels='[]',recheck_condition=NULL,correction_reason=NULL,
        deletion_requested_at=COALESCE(deletion_requested_at,$3),updated_at=$3
        WHERE id=$1 AND created_at=$2 AND status<>'deleted' RETURNING id`, [id, createdAt, now])).rows.length > 0;
      if (replay && !applied) {
        // 이미 정리됐거나 그 기억이 없는 스냅숏이다. 복원으로 ID가 되감겨 같은 ID의 다른 기억이 생겼다면 그 기억은 지우지 않는다.
        const other = (await tx.query('SELECT id FROM memories WHERE id=$1 AND created_at<>$2', [id, createdAt])).rows.length;
        if (other) await this.audit('memory_ledger_id_mismatch', id, { createdAt }, tx);
        return { applied, publishedCopies: 0 };
      }
      if (applied) {
        await tx.query('DELETE FROM memory_terms WHERE memory_id=$1', [id]);
        await this.forget(tx, [id]);
      }
      const keys = (await tx.query<{ outbox_key: string }>(`SELECT outbox_key FROM briefing_runs
        WHERE outbox_key IS NOT NULL AND memory_ids ? $1`, [erasedKey(id, createdAt)])).rows.map(row => row.outbox_key);
      let publishedCopies = 0;
      if (keys.length) {
        // 발송 시작 전인 sending은 게시자의 dispatch 표시가 state='sending'을 요구하므로 blocked로 바꾸면 보내지 않는다.
        await tx.query(`UPDATE outbox SET state='blocked' WHERE message_key=ANY($1::text[])
          AND (state='pending' OR (state='sending' AND dispatch_started=false))`, [keys]);
        // 이미 보냈거나 보내는 중인 메시지는 Discord에서 지우지 않는다. 로컬 사본만 가린다.
        // 분류를 safe_summary 밖으로 바꿔 두면 429 등으로 pending에 돌아와도 게시자가 거부한다(src/discord.ts authorized).
        await tx.query(`UPDATE outbox SET payload=jsonb_set(jsonb_set(payload,'{content}',to_jsonb($2::text)),'{classification}','"redacted"')
          WHERE message_key=ANY($1::text[])`, [keys, REDACTED]);
        publishedCopies = Number((await tx.query<{ count: string }>(`SELECT count(DISTINCT message_key) AS count FROM outbox
          WHERE message_key=ANY($1::text[]) AND state IN ('sent','unknown','sending')`, [keys])).rows[0]!.count);
      }
      await tx.query(`INSERT INTO memory_deletions(memory_id,memory_created_at,requested_by,requested_at,ledger_state,applied_at)
        VALUES ($1,$2,'deletion_ledger',$3,'recorded',$4) ON CONFLICT (memory_id,memory_created_at)
        DO UPDATE SET ledger_state='recorded',applied_at=COALESCE(memory_deletions.applied_at,$4)`, [id, createdAt, deletedAt, now]);
      await this.audit('memory_deleted', id, { replay, derivedDeliveries: keys.length, publishedCopies }, tx);
      return { applied, publishedCopies };
    });
  }
  private async lockTopic(tx: Database, actor: string, topic: string | undefined): Promise<void> {
    if (topic) await tx.query('SELECT pg_advisory_xact_lock(hashtext($1))', [`memory-topic:${actor}:${topic}`]);
  }
  private async forget(tx: Database, ids: string[]): Promise<void> {
    await tx.query(`UPDATE memories SET conflicts_with=(SELECT COALESCE(jsonb_agg(v),'[]'::jsonb)
      FROM jsonb_array_elements_text(conflicts_with) v WHERE v<>ALL($1::text[])) WHERE conflicts_with ?| $1::text[]`, [ids]);
  }
  private async insert(tx: Database, actor: string, scope: Scope, input: Parsed, access: string[], evidence: Evidence,
    replaces: string[], reason: string | null): Promise<{ id: string; status: 'active' | 'candidate'; conflictsWith: string[] }> {
    await this.gate.withDatabase(tx).authorize(actor, scope);
    const id = randomUUID();
    const now = this.now();
    // 같은 주제를 동시에 저장하면 READ COMMITTED에서는 서로를 못 봐 둘 다 active가 된다. 주제별로 직렬화한다.
    await this.lockTopic(tx, actor, input.topic);
    // 같은 주제에 다른 진술이 살아 있으면 어느 쪽도 확정하지 않고 사람의 정정을 기다린다.
    const conflicts = input.topic ? (await tx.query<{ id: string }>(`SELECT id FROM memories WHERE owner_id=$1 AND topic=$2
      AND status IN ('active','candidate') AND deletion_requested_at IS NULL AND statement<>$3 AND id<>ALL($4::text[])
      AND NOT EXISTS (SELECT 1 FROM memory_exclusions x WHERE x.owner_id=memories.owner_id AND memories.source_keys ? x.source_key) ORDER BY id`,
    [actor, input.topic, input.statement, replaces])).rows.map(row => row.id) : [];
    const status = evidence.active && !conflicts.length ? 'active' : 'candidate';
    const { kind, statement, topic, sources, scope: about, classification, validFrom, expiresAt, recheckAt, recheckCondition } = input;
    const details = kind === 'configuration' ? { sourceRevision: input.sourceRevision ?? null }
      : kind === 'decision' ? { decidedBy: input.decidedBy, decidedAt: input.decidedAt, appliesTo: input.appliesTo }
        : kind === 'incident' ? { facts: input.facts, hypotheses: input.hypotheses, unconfirmedCauses: input.unconfirmedCauses }
          : { targetUser: input.targetUser, endCondition: input.endCondition };
    await tx.query(`INSERT INTO memories(id,kind,statement,topic,details,source_refs,source_keys,source_revision,observed_at,owner_id,scope,
      access_channels,output_classification,valid_from,expires_at,recheck_at,recheck_condition,status,replaces,conflicts_with,
      correction_reason,created_at,updated_at) VALUES ($1,$2,$3,$4,$5,$6,$22,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$21)`,
    [id, kind, statement, topic ?? null, JSON.stringify(details), JSON.stringify(sources),
      kind === 'configuration' ? input.sourceRevision ?? null : null, kind === 'configuration' ? input.observedAt : null,
      actor, JSON.stringify(about), JSON.stringify(access), classification, validFrom ?? now, expiresAt ?? null, recheckAt ?? null,
      recheckCondition ?? null, status, JSON.stringify(replaces), JSON.stringify(conflicts), reason, now, JSON.stringify(evidence.keys)]);
    if (conflicts.length) await tx.query(`UPDATE memories SET conflicts_with=conflicts_with || jsonb_build_array($1::text),updated_at=$2
      WHERE id=ANY($3::text[])`, [id, now, conflicts]);
    for (const term of terms(`${statement} ${topic ?? ''}`)) await tx.query('INSERT INTO memory_terms VALUES ($1,$2)', [id, term]);
    await this.audit('memory_stored', id, { kind, status, replaces, conflicts: conflicts.length }, tx);
    return { id, status, conflictsWith: conflicts };
  }
  private parse(raw: unknown): Parsed {
    const parsed = MemoryInputSchema.safeParse(raw);
    if (!parsed.success) throw new MemoryRejected('memory_invalid');
    const input = parsed.data;
    if (!input.sources.length) throw new MemoryRejected('memory_source_required');
    if (input.kind === 'configuration' && input.expiresAt === undefined && input.recheckAt === undefined) throw new MemoryRejected('memory_recheck_required');
    if (input.expiresAt !== undefined && input.expiresAt <= (input.validFrom ?? this.now())) throw new MemoryRejected('memory_already_expired');
    return input;
  }
  private access(policy: Policy, scope: Scope, input: Parsed): string[] {
    const access = [...new Set(input.access ?? [parent(scope)])];
    if (!access.every(channel => [policy.conversationChannel, policy.notificationChannel].includes(channel))) throw new MemoryRejected('memory_access_scope');
    if (input.scope.service && !policy.services.includes(input.scope.service)) throw new MemoryRejected('memory_service_scope');
    if (input.scope.guild && input.scope.guild !== policy.guild) throw new MemoryRejected('memory_guild_scope');
    return access;
  }
  // 원본에 접근할 수 없으면 저장하지 않는다. 확인된 출처가 근거 종류에 맞을 때만 active 후보가 된다.
  private async evidence(actor: string, input: Parsed): Promise<Evidence> {
    const excluded = new Set((await this.db.query<{ source_key: string }>('SELECT source_key FROM memory_exclusions WHERE owner_id=$1', [actor])).rows.map(r => r.source_key));
    let evidence = false;
    const all = new Set<string>();
    for (const source of input.sources) {
      const keys = [source.type === 'conversation' ? `conversation:${source.message}` : source.type === 'job' ? `job:${source.job}` : `${source.type}:${source.uri}`];
      let check: SourceCheck;
      if (source.type === 'conversation') {
        const event = (await this.db.query<{ actor_id: string; accepted: boolean; scope: Scope }>(
          "SELECT actor_id,accepted,scope FROM events WHERE provider='discord' AND delivery_id=$1", [source.message])).rows[0];
        if (event) keys.push(`channel:${event.scope.channel}`, `channel:${parent(event.scope)}`);
        check = event && event.accepted && event.actor_id === actor && await this.reachable(actor, event.scope) ? 'verified' : 'inaccessible';
      } else if (source.type === 'job') {
        const job = (await this.db.query<{ owner_id: string; state: string; target: Scope }>('SELECT owner_id,state,target FROM jobs WHERE id=$1', [source.job])).rows[0];
        check = !job || job.owner_id !== actor || !await this.reachable(actor, job.target) ? 'inaccessible' : job.state === 'succeeded' ? 'verified' : 'unverified';
      } else {
        check = await this.documents.check(actor, source.uri, source.type === 'document' ? source.revision : null);
        if (source.type === 'external' && check === 'verified') check = 'unverified';
        if (source.type === 'document' && source.revision === null && check === 'verified') check = 'unverified';
      }
      if (keys.some(key => excluded.has(key))) throw new MemoryRejected('memory_source_excluded');
      for (const key of keys) all.add(key);
      if (check === 'inaccessible') throw new MemoryRejected('memory_source_inaccessible');
      if (check === 'verified' && EVIDENCE[input.kind].includes(source.type)) evidence = true;
    }
    if (input.kind === 'decision' && input.decidedBy !== actor && !input.sources.some(s => s.type === 'document')) evidence = false;
    if (input.kind === 'preference' && input.targetUser !== actor) evidence = false;
    return { active: evidence, keys: [...all] };
  }
  private async reachable(actor: string, scope: Scope): Promise<boolean> {
    try { await this.gate.authorize(actor, scope); return true; } catch (error) {
      if (error instanceof Denied) return false;
      throw error;
    }
  }
  // 권한 철회는 저장 때가 아니라 매 접근에 다시 적용한다.
  private visible(policy: Policy, actor: string, scope: Scope, row: MemoryRow, pendingOk = false): boolean {
    const channel = parent(scope);
    return row.owner_id === actor && row.access_channels.includes(channel)
      && [policy.conversationChannel, policy.notificationChannel].includes(channel)
      && (!row.scope.service || policy.services.includes(row.scope.service))
      && (!row.scope.guild || row.scope.guild === policy.guild)
      && (pendingOk || (row.deletion_requested_at === null && !this.erased.has(erasedKey(row.id, Number(row.created_at)))));
  }
  private async views(rows: MemoryRow[]): Promise<MemoryView[]> {
    const linked = [...new Set(rows.flatMap(row => row.conflicts_with))];
    const live = new Set(linked.length ? (await this.db.query<{ id: string }>(`SELECT id FROM memories WHERE id=ANY($1::text[])
      AND status IN ('active','candidate') AND deletion_requested_at IS NULL`, [linked])).rows.map(row => row.id) : []);
    const now = this.now();
    return rows.map(row => {
      const flags: MemoryView['flags'] = [];
      if (row.status === 'candidate') flags.push('unverified');
      if (row.conflicts_with.some(id => live.has(id))) flags.push('conflict');
      if (row.recheck_at !== null && Number(row.recheck_at) <= now) flags.push('recheck_due');
      return { id: row.id, kind: row.kind, statement: row.statement, status: row.status as 'candidate' | 'active',
        topic: row.topic, details: row.details, sources: row.source_refs, observedAt: num(row.observed_at),
        createdAt: Number(row.created_at), recheckAt: num(row.recheck_at), expiresAt: num(row.expires_at),
        service: row.scope.service ?? null, flags };
    });
  }
  private assertReady(): void { if (!this.ready) throw new MemoryNotReady(); }
  private async audit(kind: string, subject: string, detail: unknown, tx: Database = this.db): Promise<void> {
    // 감사에는 기억 내용을 넣지 않는다. 삭제한 내용이 감사 기록에 남지 않게 한다.
    await tx.query('INSERT INTO audit(kind,subject,detail,created_at) VALUES ($1,$2,$3,$4)', [kind, subject, JSON.stringify(detail), this.now()]);
  }
}
