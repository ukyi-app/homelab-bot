import type { ChangeKey, ChangeNote, WriterOutcome } from './change-contracts.js';
import type { ChangeRepositoryPolicy } from './change-policy.js';
import { noteLine, renderGuidance } from './change-publication.js';
import type { ChangeStore } from './change-store.js';
import type { Database } from './database.js';
import type { GuidanceReviewPort } from './github-review-io.js';
import type { Log } from './log.js';
import type { Policy } from './policy.js';
import { ReviewPolicySchema } from './review.js';
import { CHANGE_NOTE_LIMITS, ChangeNoteSchema } from './task-contracts.js';
import { z } from 'zod';

// 봇 PR 안내 댓글(COLLEAGUE_SPEC §4.10 "안내 댓글", AC-27). 확인할 것·남은 위험 중 diff 안 위치인 것만 리뷰 App의 COMMENT 리뷰 줄 댓글로 단다.
// 차례(처음 게시 0, 수정 차례 1부터)마다 한 번이다. 의도를 행으로 남긴 뒤 보내고, 보냈는지 모르면 다시 보내지 않고 C26 포트의 표식·head 대조로만 회수한다.
// 그래서 중복 대신 unknown이 남을 수 있다. 어떤 실패도 PR과 변경 상태를 되돌리지 않고 로그에 사유 코드만 남긴다.

// ---- 작성 결과의 확인할 것·남은 위험 ----

const NotesSchema = z.strictObject({ checks: z.array(ChangeNoteSchema).max(CHANGE_NOTE_LIMITS.items), risks: z.array(ChangeNoteSchema).max(CHANGE_NOTE_LIMITS.items) });
export interface ChangeNotes { checks: ChangeNote[]; risks: ChangeNote[] }
const parsedJson = (value: unknown) => typeof value === 'string' ? JSON.parse(value) as unknown : value;
// generation마다 처음 받은 목록 하나다. 같은 결과를 다시 받아도(응답 유실 뒤 재조회) 처음 것을 둔다. 새로 기록했으면 true.
export async function recordChangeNotes(db: Pick<Database, 'query'>, key: ChangeKey, notes: { checks: readonly ChangeNote[]; risks: readonly ChangeNote[] }, now: () => number = Date.now): Promise<boolean> {
  const parsed = NotesSchema.parse({ checks: [...notes.checks], risks: [...notes.risks] });
  const inserted = await db.query('INSERT INTO change_notes(change_id,generation,checks,risks,recorded_at) VALUES ($1,$2,$3::jsonb,$4::jsonb,$5) ON CONFLICT DO NOTHING RETURNING 1',
    [key.changeId, key.generation, JSON.stringify(parsed.checks), JSON.stringify(parsed.risks), now()]);
  return inserted.rows.length === 1;
}
// 기록이 없으면(옛 판 결과) 빈 목록이다.
export async function readChangeNotes(db: Pick<Database, 'query'>, key: ChangeKey): Promise<ChangeNotes> {
  const row = (await db.query<{ checks: unknown; risks: unknown }>('SELECT checks,risks FROM change_notes WHERE change_id=$1 AND generation=$2', [key.changeId, key.generation])).rows[0];
  if (!row) return { checks: [], risks: [] };
  return NotesSchema.parse({ checks: parsedJson(row.checks), risks: parsedJson(row.risks) });
}
// 승인 본문에 목록의 줄이 모두 그대로 있는가. 승인 뒤 기록을 바꿔치기하면 여기서 걸린다.
export const notesApproved = (body: string, notes: { checks: readonly ChangeNote[]; risks: readonly ChangeNote[] }): boolean =>
  [...notes.checks, ...notes.risks].every(note => body.includes(`${noteLine(note)}\n`));

// ---- diff 안 위치 ----

const HUNK = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/;
const QUOTE_ESCAPES: Readonly<Record<string, number>> = { a: 7, b: 8, t: 9, n: 10, v: 11, f: 12, r: 13, '"': 34, '\\': 92 };
// git이 큰따옴표로 감싼 경로(비ASCII는 8진 바이트)를 푼다.
function unquote(text: string): string | null {
  if (!text.startsWith('"') || !text.endsWith('"') || text.length < 2) return null;
  const bytes: number[] = [];
  for (let i = 1; i < text.length - 1; i++) {
    const char = text[i]!;
    if (char !== '\\') { bytes.push(...Buffer.from(char)); continue; }
    const octal = /^[0-3][0-7]{2}/.exec(text.slice(i + 1, i + 4));
    if (octal) { bytes.push(Number.parseInt(octal[0], 8)); i += 3; continue; }
    const escape = QUOTE_ESCAPES[text[i + 1] ?? ''];
    if (escape === undefined) return null;
    bytes.push(escape);
    i++;
  }
  return Buffer.from(bytes).toString('utf8');
}
function rightPath(value: string): string | null {
  if (value === '/dev/null') return null;
  const path = value.startsWith('"') ? unquote(value) : value.replace(/\t$/, '');
  return path?.startsWith('b/') ? path.slice(2) : null;
}
// 파일마다 hunk 안 오른쪽 줄(문맥 줄과 더한 줄). GitHub이 오른쪽 줄 댓글을 받는 자리다.
// 게시한 artifact patch만 읽고 GitHub에 다시 묻지 않는다. hunk 줄 수를 끝까지 세어 지운 줄이 파일 머리로 보이지 않게 한다. 읽지 못하면 빈 결과다.
export function guidanceDiffLines(patch: string): Map<string, Set<number>> {
  const result = new Map<string, Set<number>>();
  const lines = patch.split('\n');
  if (lines.at(-1) === '') lines.pop();
  let path: string | null = null;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    if (line.startsWith('diff --git ')) { path = null; continue; }
    if (line.startsWith('+++ ')) { path = rightPath(line.slice(4)); continue; }
    const hunk = HUNK.exec(line);
    if (!hunk) continue;
    let before = Number(hunk[2] ?? 1), after = Number(hunk[4] ?? 1), at = Number(hunk[3]);
    const seen = path === null ? null : result.get(path) ?? new Set<number>();
    while (before > 0 || after > 0) {
      const body = lines[++i];
      if (body === undefined) return new Map();
      const kind = body[0];
      if (kind === ' ' && before > 0 && after > 0) { seen?.add(at++); before--; after--; }
      else if (kind === '-' && before > 0) before--;
      else if (kind === '+' && after > 0) { seen?.add(at++); after--; }
      else if (!body.startsWith('\\')) return new Map();
    }
    if (path !== null && seen?.size) result.set(path, seen);
  }
  return result;
}

// ---- 전송 ----

export const GUIDANCE_RETRY_MS = 60_000;
const GUIDANCE_MAX_RETRY_MS = 3_600_000;
const GUIDANCE_MAX_ATTEMPTS = 5;
// 보냈는지 모르는 차례를 대조하는 기한. 게시 effect의 unknown 기한과 같다.
const GUIDANCE_UNKNOWN_MS = 86_400_000;
// 연결 전·토큰 발급 전의 일시 실패만 다시 보낸다. 저장소 정책 밖(repository_denied)·PR 닫힘·head 변경·설치 없음은 다시 해도 같다.
const TRANSIENT = /^(rate_limited|policy_unavailable|token_unavailable|read_failed|read_http_5\d\d)$/;

export type GuidanceState = 'pending' | 'sending' | 'unknown' | 'posted' | 'skipped' | 'failed';
export interface GuidanceOutcome {
  // deferred는 기록상 pending(기한 뒤 다시 보냄)이다.
  state: Exclude<GuidanceState, 'pending'> | 'deferred';
  reason: string | null; reviewId: number | null;
  // 줄 댓글로 달지 않은 항목(diff 밖·위치 없음·상한 초과). 수정 차례면 C27이 Discord 결과 요약에 싣는다. 공개 검사에 걸렸으면 비어 있다.
  outside: ChangeNotes;
}
export interface GuidanceRound {
  key: ChangeKey; round: number; repoId: number; pr: number; headSha: string;
  checks: readonly ChangeNote[]; risks: readonly ChangeNote[];
  // 그 차례에 게시한 diff. 처음 게시는 artifact patch, 수정 차례는 수정 커밋의 patch다.
  patch: string;
  // 처음 게시만. 승인 본문에 목록이 그대로 있어야 단다.
  approvedBody?: string;
}
export interface ChangeGuidanceOptions {
  db: Database; changes: Pick<ChangeStore, 'approvalSubject' | 'loadArtifact' | 'generationRecord'>; port: GuidanceReviewPort;
  policy: (repoId: number) => Promise<ChangeRepositoryPolicy | null>;
  // 리뷰 정책 publish.maxInlineComments. null이면 리뷰 게시가 닫혀 있다.
  limit: () => Promise<number | null>;
  now?: () => number; log?: Log;
}
interface Row { head_sha: string; state: GuidanceState; attempts: number; retry_at: string | number | null; review_id: string | number | null; reason: string | null; created_at: string | number }

export const guidanceKey = (key: ChangeKey, round: number) => `${key.changeId}:g${key.generation}:r${round}`;
// 줄 댓글 상한은 PR 리뷰 게시와 같은 값(publish.maxInlineComments)이다. 리뷰 정책이 없거나 게시를 닫았으면 null이다.
export function guidanceLimit(policy: Pick<Policy, 'review'>): number | null {
  const parsed = ReviewPolicySchema.safeParse(policy.review);
  return parsed.success ? parsed.data.publish?.maxInlineComments ?? null : null;
}

export class ChangeGuidance {
  private readonly now: () => number;
  private readonly log: Log;
  constructor(private readonly options: ChangeGuidanceOptions) {
    this.now = options.now ?? Date.now;
    this.log = options.log ?? (() => {});
  }

  // 그 차례가 끝났는가(posted·skipped·failed). 끝났으면 부르는 쪽이 patch를 읽지 않아도 된다.
  async settled(key: ChangeKey, round: number): Promise<boolean> {
    const row = await this.row(key, round);
    return row !== null && (row.state === 'posted' || row.state === 'skipped' || row.state === 'failed');
  }

  // 처음 게시 뒤(proposed) 한 번. 확정된 pull effect의 PR·head, 게시한 artifact patch, 승인 본문으로 부른다.
  async afterPublish(key: ChangeKey): Promise<GuidanceOutcome> {
    const pull = (await this.options.db.query<{ result: unknown }>(`SELECT result FROM change_delivery_effects WHERE change_id=$1 AND generation=$2 AND stage='pull' AND state='confirmed'`, [key.changeId, key.generation])).rows[0];
    if (!pull) throw new Error('pull_effect_missing');
    const { number, headSha } = parsedJson(pull.result) as { number: number; headSha: string };
    const notes = await readChangeNotes(this.options.db, key);
    const generation = await this.options.changes.generationRecord(key);
    const approval = await this.options.changes.approvalSubject(key);
    // 목록이 없으면(옛 판 결과, 이 기능 전에 게시한 PR) 달 것이 없어 patch를 읽지 않는다.
    const artifact = notes.checks.length || notes.risks.length ? await this.options.changes.loadArtifact(key) : null;
    if (!generation.ok || !approval.ok || (artifact && !artifact.ok)) throw new Error('guidance_evidence_missing');
    return this.post({ key, round: 0, repoId: generation.value.repoId, pr: number, headSha, patch: artifact?.ok ? artifact.value.patch : '', ...notes, approvedBody: approval.value.subject.publication.body });
  }

  // 수정 차례(C27)도 이 함수를 부른다. 같은 차례를 몇 번 불러도 한 번만 보낸다.
  async post(round: GuidanceRound): Promise<GuidanceOutcome> {
    const { key } = round;
    if (!/^[0-9a-f]{40}$/.test(round.headSha)) return this.result('failed', 'guidance_input_invalid');
    const policy = await this.options.policy(round.repoId);
    const limit = await this.options.limit();
    const rendered = policy ? renderGuidance({ checks: round.checks, risks: round.risks, positions: guidanceDiffLines(round.patch), limit: limit ?? 0, round: round.round },
      { internalMarkers: policy.internalMarkers, identity: policy.identity }) : null;
    const outside = rendered?.ok ? rendered.outside : { checks: [], risks: [] };
    const existing = await this.row(key, round.round);
    if (existing && existing.head_sha !== round.headSha) return this.result('failed', 'head_mismatch', null, outside);
    if (existing) return this.resume(round, existing, outside);
    const skip = !policy ? 'repository_not_allowed'
      : !rendered!.ok ? rendered!.reason
      : limit === null ? 'review_publish_closed'
      : round.approvedBody !== undefined && !notesApproved(round.approvedBody, round) ? 'notes_unapproved'
      : rendered!.comments.length === 0 ? 'no_inline_items' : null;
    if (skip) {
      await this.options.db.query(`INSERT INTO change_guidance(change_id,generation,round,head_sha,state,reason,created_at,updated_at) VALUES ($1,$2,$3,$4,'skipped',$5,$6,$6) ON CONFLICT DO NOTHING`,
        [key.changeId, key.generation, round.round, round.headSha, skip, this.now()]);
      const row = await this.row(key, round.round);
      if (row?.state === 'skipped' && row.reason === skip) this.log('change_guidance', { round: round.round, state: 'skipped', reason: skip });
      return row ? this.resume(round, row, outside) : this.result('deferred', 'busy', null, outside);
    }
    await this.options.db.query(`INSERT INTO change_guidance(change_id,generation,round,head_sha,state,created_at,updated_at) VALUES ($1,$2,$3,$4,'pending',$5,$5) ON CONFLICT DO NOTHING`,
      [key.changeId, key.generation, round.round, round.headSha, this.now()]);
    const row = await this.row(key, round.round);
    if (!row) return this.result('deferred', 'busy', null, outside);
    return this.resume(round, row, outside);
  }

  private async resume(round: GuidanceRound, row: Row, outside: ChangeNotes): Promise<GuidanceOutcome> {
    switch (row.state) {
      case 'posted': return this.result('posted', null, Number(row.review_id), outside);
      case 'skipped': case 'failed': return this.result(row.state, row.reason, null, outside);
      case 'sending': case 'unknown': return this.recover(round, row, outside);
      case 'pending': return this.send(round, row, outside);
    }
  }

  private async send(round: GuidanceRound, row: Row, outside: ChangeNotes): Promise<GuidanceOutcome> {
    const { key } = round;
    if (row.retry_at !== null && Number(row.retry_at) > this.now()) return this.result('deferred', row.reason ?? 'retry_pending', null, outside);
    // 정책·글을 다시 본다. 미룬 사이에 정책에서 빠졌거나 공개 검사가 바뀌었을 수 있다.
    const policy = await this.options.policy(round.repoId);
    const limit = await this.options.limit();
    const rendered = policy && limit !== null ? renderGuidance({ checks: round.checks, risks: round.risks, positions: guidanceDiffLines(round.patch), limit, round: round.round },
      { internalMarkers: policy.internalMarkers, identity: policy.identity }) : null;
    if (!policy || !rendered?.ok || rendered.comments.length === 0) {
      const reason = !policy ? 'repository_not_allowed' : limit === null ? 'review_publish_closed' : rendered && !rendered.ok ? rendered.reason : 'no_inline_items';
      return this.settle(round, 'pending', 'skipped', reason, null, outside);
    }
    const claimed = await this.options.db.query<{ attempts: number }>(`UPDATE change_guidance SET state='sending',attempts=attempts+1,updated_at=$4 WHERE change_id=$1 AND generation=$2 AND round=$3 AND state='pending' RETURNING attempts`,
      [key.changeId, key.generation, round.round, this.now()]);
    // 다른 호출이 먼저 집었다.
    if (!claimed.rows[0]) return this.result('deferred', 'busy', null, outside);
    const attempts = Number(claimed.rows[0].attempts);
    let outcome: WriterOutcome<{ id: number }>;
    try {
      outcome = await this.options.port.post({ repository: policy.fullName, pr: round.pr, head: round.headSha, key: guidanceKey(key, round.round), body: rendered.body, comments: rendered.comments });
    } catch {
      // 포트는 값으로 답한다. 던졌으면 어디까지 갔는지 모른다.
      outcome = { kind: 'unknown', code: 'guidance_send_failed' };
    }
    switch (outcome.kind) {
      case 'confirmed': return this.settle(round, 'sending', 'posted', null, outcome.value.id, outside);
      case 'rejected': return this.settle(round, 'sending', 'failed', safeCode(outcome.code), null, outside);
      case 'not_sent': {
        const code = safeCode(outcome.code);
        if (!TRANSIENT.test(code)) return this.settle(round, 'sending', 'skipped', code, null, outside);
        if (attempts >= GUIDANCE_MAX_ATTEMPTS) return this.settle(round, 'sending', 'failed', 'send_attempts_exhausted', null, outside);
        const retryAt = this.now() + Math.min(GUIDANCE_RETRY_MS * 2 ** (attempts - 1), GUIDANCE_MAX_RETRY_MS);
        await this.options.db.query(`UPDATE change_guidance SET state='pending',retry_at=$4,reason=$5,updated_at=$6 WHERE change_id=$1 AND generation=$2 AND round=$3 AND state='sending'`,
          [key.changeId, key.generation, round.round, retryAt, code, this.now()]);
        this.log('change_guidance', { round: round.round, state: 'deferred', reason: code });
        return this.result('deferred', code, null, outside);
      }
      case 'unknown': {
        await this.options.db.query(`UPDATE change_guidance SET state='unknown',reason=$4,updated_at=$5 WHERE change_id=$1 AND generation=$2 AND round=$3 AND state='sending'`,
          [key.changeId, key.generation, round.round, safeCode(outcome.code), this.now()]);
        this.log('change_guidance', { round: round.round, state: 'unknown', reason: safeCode(outcome.code) });
        const current = await this.row(key, round.round);
        return current ? this.recover(round, current, outside) : this.result('unknown', safeCode(outcome.code), null, outside);
      }
    }
  }

  // 보냈는지 모르는 차례다. 읽기로만 회수하고 다시 보내지 않는다. sending은 다른 호출이 보내는 중일 수도 있어 찾지 못하면 기록을 건드리지 않는다.
  private async recover(round: GuidanceRound, row: Row, outside: ChangeNotes): Promise<GuidanceOutcome> {
    const policy = await this.options.policy(round.repoId);
    if (policy) {
      try {
        const found = await this.options.port.find({ repository: policy.fullName, pr: round.pr, head: round.headSha, key: guidanceKey(round.key, round.round) });
        if (found) return this.settle(round, row.state, 'posted', null, found.id, outside);
      } catch { /* 다음 호출이 다시 읽는다 */ }
    }
    if (this.now() - Number(row.created_at) > GUIDANCE_UNKNOWN_MS) return this.settle(round, row.state, 'failed', 'unknown_expired', null, outside);
    return this.result('unknown', row.reason ?? row.state, null, outside);
  }

  private async settle(round: GuidanceRound, from: GuidanceState, to: 'posted' | 'skipped' | 'failed', reason: string | null, reviewId: number | null, outside: ChangeNotes): Promise<GuidanceOutcome> {
    const { key } = round;
    const moved = await this.options.db.query(`UPDATE change_guidance SET state=$5,reason=$6,review_id=$7,retry_at=NULL,updated_at=$8 WHERE change_id=$1 AND generation=$2 AND round=$3 AND state=$4 RETURNING 1`,
      [key.changeId, key.generation, round.round, from, to, reason, reviewId, this.now()]);
    if (moved.rows.length) {
      this.log('change_guidance', { round: round.round, state: to, reason });
      return this.result(to, reason, reviewId, outside);
    }
    // 동시에 돈 호출이 먼저 끝냈으면 그 기록을 쓴다.
    const current = await this.row(key, round.round);
    if (current?.state === 'posted') return this.result('posted', null, Number(current.review_id), outside);
    if (current?.state === 'skipped' || current?.state === 'failed') return this.result(current.state, current.reason, null, outside);
    return this.result('deferred', 'busy', null, outside);
  }

  private async row(key: ChangeKey, round: number): Promise<Row | null> {
    return (await this.options.db.query<Row>('SELECT head_sha,state,attempts,retry_at,review_id,reason,created_at FROM change_guidance WHERE change_id=$1 AND generation=$2 AND round=$3',
      [key.changeId, key.generation, round])).rows[0] ?? null;
  }
  private result(state: GuidanceOutcome['state'], reason: string | null, reviewId: number | null = null, outside: ChangeNotes = { checks: [], risks: [] }): GuidanceOutcome {
    return { state, reason, reviewId, outside };
  }
}
const safeCode = (code: string) => /^[a-z][a-z0-9_]{0,63}$/.test(code) ? code : 'guidance_code_invalid';
