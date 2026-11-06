import { createHash } from 'node:crypto';
import { z } from 'zod';
import { BranchNameSchema, GitShaSchema, Sha256Schema, canonicalJson } from './change-contracts.js';
import type { ChangeTarget } from './change-contracts.js';

// 후보 코드가 CI에서 쓰기 권한·비밀과 함께 돌지 않는 알려진 형태인지 보는 좁은 판정이다. 임의 workflow의 안전을 증명하지 않는다.
// 사람이 승인한 fingerprint와 정확히 같아야 하고, 모르는 구문은 추측하지 않고 닫는다.

// ref는 움직이지 않는 것만 받는다. 브랜치나 움직이는 태그면 검사 뒤 PR 실행 전에 승인 안 된 workflow로 바뀔 수 있어서다.
// SHA로만 제한하지 못한다. 배포 키 identity가 app-build-v* 태그 ref에 묶여 앱 저장소는 태그로 불러야 하고, 그 태그는 ruleset D1이 bypass 없이 잠근다.
export const REUSABLE_USES = /^([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+)\/(\.github\/workflows\/[A-Za-z0-9_.-]+\.ya?ml)@([0-9a-f]{40}|app-build-v\d+\.\d+\.\d+)$/;
export const CiPolicySchema = z.strictObject({
  approvedFingerprint: Sha256Schema,
  // 태그 이동을 잡으려고 해석된 blob까지 승인값에 둔다.
  reusable: z.array(z.strictObject({ uses: z.string().regex(REUSABLE_USES), blobSha: GitShaSchema })).max(16),
  pushBranches: z.array(BranchNameSchema).min(1).max(8),
});
export type CiPolicy = z.infer<typeof CiPolicySchema>;
export interface CiSnapshot {
  // 신뢰 base의 .github 아래 전부다. workflow가 아닌 파일이 바뀌어도 fingerprint가 달라진다.
  files: { path: string; mode: string; blobSha: string }[];
  workflows: { path: string; blobSha: string; text: string }[];
  reusable: { uses: string; blobSha: string; text: string }[];
}
export type CiResult = { ok: true; fingerprint: string } | { ok: false; reason: string; fingerprint?: string };
export interface CiContentReader {
  readBlobText(target: ChangeTarget, sha: string): Promise<string | null>;
  readPinnedWorkflow(input: { uses: string }): Promise<{ blobSha: string; text: string } | null>;
}

// ---- 좁은 YAML 부분집합 ----

// 일반 YAML 파서를 쓰면 GitHub과 해석이 어긋난 채 통과할 수 있다. 그래서 anchor·merge·태그·여러 줄 평문·복합 키를 받지 않는 부분집합만 읽는다.
export type WorkflowNode = string | null | WorkflowNode[] | { [key: string]: WorkflowNode };
const unsupported = () => new Error('ci_yaml_unsupported');
interface Line { indent: number; text: string }
function logicalLines(source: string): Line[] {
  const lines: Line[] = [];
  for (const raw of source.split('\n')) {
    if (raw.includes('\r')) throw unsupported();
    lines.push({ indent: raw.length - raw.trimStart().length, text: raw.trim() === '' ? '' : raw.slice(raw.length - raw.trimStart().length) });
  }
  return lines;
}
function stripComment(text: string): string {
  let quote: string | null = null;
  for (let i = 0; i < text.length; i++) {
    const char = text[i]!;
    if (quote) { if (char === quote) quote = null; continue; }
    if ((char === '"' || char === "'") && (i === 0 || /[\s:[,]/.test(text[i - 1]!))) quote = char;
    else if (char === '#' && (i === 0 || /\s/.test(text[i - 1]!))) return text.slice(0, i).trimEnd();
  }
  return text;
}
function scalar(text: string): string {
  if (/^["']/.test(text)) {
    const quote = text[0]!;
    if (text.length < 2 || !text.endsWith(quote)) throw unsupported();
    const inner = text.slice(1, -1);
    if (inner.includes(quote) || (quote === '"' && inner.includes('\\'))) throw unsupported();
    return inner;
  }
  // anchor·alias·태그·병합은 값이 어디서 오는지 이 줄만으로 알 수 없다.
  if (/^[&*!|>%@`]/.test(text)) throw unsupported();
  return text;
}
function flowList(text: string): string[] {
  const inner = text.slice(1, -1).trim();
  if (!inner) return [];
  if (/[[\]{}]/.test(inner.replace(/\$\{\{.*?\}\}/g, ''))) throw unsupported();
  return inner.split(',').map(item => scalar(item.trim()));
}
// 큰따옴표 키의 이스케이프는 받지 않는다. GitHub에서는 다른 이름으로 풀려 형태 검사를 비껴간다.
const KEY = /^(?:"([^"\\]+)"|'([^']+)'|([A-Za-z0-9_.-]+)):(?:\s+(.*))?$/;
class Parser {
  index = 0;
  constructor(readonly lines: Line[]) {}
  skipBlank() { while (this.index < this.lines.length && this.current().text === '') this.index++; }
  current() { return this.lines[this.index]!; }
  atEnd() { this.skipBlank(); return this.index >= this.lines.length; }
  block(indent: number): WorkflowNode {
    this.skipBlank();
    const line = this.current();
    if (line.indent !== indent) throw unsupported();
    return /^-(\s|$)/.test(line.text) ? this.sequence(indent) : this.mapping(indent);
  }
  // 값 뒤에 이어지는 더 깊은 줄은 여러 줄 평문이나 잘못된 들여쓰기다.
  noDeeper(indent: number) {
    if (!this.atEnd() && this.current().indent > indent) throw unsupported();
  }
  value(rest: string, indent: number, childIndentMin: number): WorkflowNode {
    const text = stripComment(rest).trim();
    if (text === '') {
      if (this.atEnd() || this.current().indent < childIndentMin) {
        // `key:` 바로 아래 같은 들여쓰기의 목록은 YAML이 허용한다.
        if (!this.atEnd() && this.current().indent === indent && /^-(\s|$)/.test(this.current().text) && childIndentMin > indent) return this.sequence(indent);
        return null;
      }
      return this.block(this.current().indent);
    }
    if (/^[|>][-+]?$/.test(text)) return this.blockScalar(text, indent);
    if (text.startsWith('[')) {
      if (!text.endsWith(']')) throw unsupported();
      this.noDeeper(indent);
      return flowList(text);
    }
    if (text === '{}') { this.noDeeper(indent); return {}; }
    if (text.startsWith('{')) throw unsupported();
    const parsed = scalar(text);
    this.noDeeper(indent);
    return parsed;
  }
  blockScalar(style: string, indent: number): string {
    const rows: string[] = [];
    let baseIndent: number | null = null;
    while (this.index < this.lines.length) {
      const line = this.lines[this.index]!;
      if (line.text !== '' && line.indent <= indent) break;
      if (line.text !== '') baseIndent ??= line.indent;
      rows.push(line.text === '' ? '' : `${' '.repeat(line.indent - (baseIndent ?? line.indent))}${line.text}`);
      this.index++;
    }
    while (rows.length && rows.at(-1) === '') rows.pop();
    if (style.startsWith('|')) return `${rows.join('\n')}${style.endsWith('-') ? '' : '\n'}`;
    return `${rows.join(' ')}${style.endsWith('-') ? '' : '\n'}`;
  }
  mapping(indent: number): WorkflowNode {
    const out: { [key: string]: WorkflowNode } = Object.create(null) as { [key: string]: WorkflowNode };
    while (!this.atEnd()) {
      const line = this.current();
      if (line.indent < indent) break;
      if (line.indent > indent) throw unsupported();
      if (/^-(\s|$)/.test(line.text)) break;
      if (line.text.startsWith('#')) { this.index++; continue; }
      const match = KEY.exec(stripComment(line.text));
      if (!match) throw unsupported();
      const key = match[1] ?? match[2] ?? match[3]!;
      if (key in out) throw unsupported();
      this.index++;
      out[key] = this.value(match[4] ?? '', indent, indent + 1);
    }
    return Object.setPrototypeOf(out, Object.prototype) as WorkflowNode;
  }
  sequence(indent: number): WorkflowNode {
    const out: WorkflowNode[] = [];
    while (!this.atEnd()) {
      const line = this.current();
      if (line.indent !== indent) { if (line.indent < indent) break; throw unsupported(); }
      if (line.text.startsWith('#')) { this.index++; continue; }
      if (!/^-(\s|$)/.test(line.text)) break;
      const body = line.text.slice(1);
      const inner = body.trimStart();
      const offset = indent + 1 + (body.length - inner.length);
      if (inner === '' || inner.startsWith('#')) {
        this.index++;
        out.push(this.atEnd() || this.current().indent <= indent ? null : this.block(this.current().indent));
      } else if (KEY.test(stripComment(inner))) {
        // `- key: value`는 key 위치를 들여쓰기로 삼는 mapping이다.
        this.lines[this.index] = { indent: offset, text: inner };
        out.push(this.mapping(offset));
      } else {
        this.index++;
        out.push(this.value(inner, indent, indent + 1));
      }
    }
    return out;
  }
}
export function parseWorkflowSubset(text: string): WorkflowNode {
  if (text.includes('\t')) throw unsupported();
  const lines = logicalLines(text).filter(line => !/^#/.test(line.text));
  if (lines.some((line, index) => (line.text === '...' || (line.indent === 0 && line.text.startsWith('---') && index > 0)))) throw unsupported();
  while (lines.length && lines[0]!.text === '') lines.shift();
  if (lines[0]?.text === '---') lines.shift();
  const parser = new Parser(lines);
  if (parser.atEnd()) return null;
  const root = parser.block(0);
  if (!parser.atEnd()) throw unsupported();
  return root;
}

// ---- 형태 판정 ----

class CiViolation extends Error {}
const violation = (reason: string) => new CiViolation(reason);
const isMap = (node: WorkflowNode | undefined): node is { [key: string]: WorkflowNode } => typeof node === 'object' && node !== null && !Array.isArray(node);
const texts = (node: WorkflowNode | undefined): string[] => node === null || node === undefined ? [] : typeof node === 'string' ? [node] : Array.isArray(node) ? node.flatMap(item => texts(item)) : [];
const hasExpression = (value: string) => value.includes('${{');
const PR_HEAD = /github\.event\.pull_request\.head|github\.head_ref|pull_request\.head/;
const PINNED_ACTION = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_./-]+@[0-9a-f]{40}$/;
const PR_FILTERS = new Set(['types', 'branches', 'paths', 'paths-ignore']);
const PUSH_FILTERS = new Set(['branches', 'paths', 'paths-ignore']);

function triggers(root: { [key: string]: WorkflowNode }): Record<string, WorkflowNode> {
  const on = root.on;
  if (on === undefined || on === null) throw violation('ci_trigger_missing');
  if (typeof on === 'string') return { [on]: null };
  if (Array.isArray(on)) return Object.fromEntries(texts(on).map(name => [name, null]));
  return on;
}
function checkPush(push: WorkflowNode, policy: CiPolicy): void {
  if (!isMap(push)) throw violation('ci_push_unfiltered');
  for (const key of Object.keys(push)) if (!PUSH_FILTERS.has(key)) throw violation('ci_push_filter_unknown');
  const branches = texts(push.branches);
  if (!branches.length) throw violation('ci_push_unfiltered');
  // 와일드카드는 정확한 값이 아니라서 승인 목록에 맞을 수 없다. bot 브랜치 push가 배포를 부르는 형태가 여기서 닫힌다.
  for (const branch of branches) if (!policy.pushBranches.includes(branch)) throw violation('ci_push_branch_unapproved');
}
function checkReference(uses: string, policy: CiPolicy): void {
  if (hasExpression(uses)) throw violation('ci_reference_dynamic');
  if (!policy.reusable.some(item => item.uses === uses)) throw violation('ci_reference_unapproved');
}
function checkAction(uses: string): void {
  if (hasExpression(uses)) throw violation('ci_reference_dynamic');
  if (!PINNED_ACTION.test(uses)) throw violation('ci_action_unpinned');
}
function checkJobs(root: { [key: string]: WorkflowNode }, policy: CiPolicy): void {
  if (root.permissions === 'write-all') throw violation('ci_permissions_write_all');
  const jobs = root.jobs;
  if (jobs === undefined || jobs === null) return;
  if (!isMap(jobs)) throw violation('ci_yaml_unsupported');
  for (const job of Object.values(jobs)) {
    if (!isMap(job)) throw violation('ci_yaml_unsupported');
    if (job.permissions === 'write-all') throw violation('ci_permissions_write_all');
    if (job.secrets === 'inherit') throw violation('ci_secrets_inherit');
    // GitHub은 라벨 대소문자를 가리지 않고, group 형태는 라벨 없이 자체 러너로 간다.
    if (isMap(job['runs-on']) || texts(job['runs-on']).some(label => label.toLowerCase() === 'self-hosted' || hasExpression(label))) throw violation('ci_self_hosted');
    if (typeof job.uses === 'string') checkReference(job.uses, policy);
    else if (job.uses !== undefined) throw violation('ci_yaml_unsupported');
    if (job.steps === undefined) continue;
    if (!Array.isArray(job.steps)) throw violation('ci_yaml_unsupported');
    for (const step of job.steps) {
      if (!isMap(step)) throw violation('ci_yaml_unsupported');
      if (typeof step.uses === 'string') checkAction(step.uses);
      if (isMap(step.with)) {
        // 권한 있는 job에서 PR head를 받아 돌리는 전형이다. 권한 범위까지 따지지 않고 닫는다.
        if (texts(step.with.ref).some(ref => PR_HEAD.test(ref)) || texts(step.with.repository).some(ref => PR_HEAD.test(ref))) throw violation('ci_pr_head_checkout');
      }
    }
  }
}
function checkCaller(text: string, policy: CiPolicy): void {
  const root = parseWorkflowSubset(text);
  if (!isMap(root)) throw unsupported();
  const on = triggers(root);
  const names = Object.keys(on);
  if (!names.length) throw violation('ci_trigger_missing');
  for (const name of names) {
    if (name === 'pull_request') {
      if (isMap(on[name])) for (const key of Object.keys(on[name] as object)) if (!PR_FILTERS.has(key)) throw violation('ci_trigger_unapproved');
    } else if (name === 'push') checkPush(on[name] ?? null, policy);
    else throw violation('ci_trigger_unapproved');
  }
  checkJobs(root, policy);
}
function checkReusable(text: string, policy: CiPolicy): void {
  const root = parseWorkflowSubset(text);
  if (!isMap(root)) throw unsupported();
  const names = Object.keys(triggers(root));
  if (names.length !== 1 || names[0] !== 'workflow_call') throw violation('ci_trigger_unapproved');
  checkJobs(root, policy);
}
export function ciFingerprint(snapshot: CiSnapshot, policy: CiPolicy): string {
  const order = (a: { path: string }, b: { path: string }) => Buffer.compare(Buffer.from(a.path), Buffer.from(b.path));
  const body = canonicalJson({
    files: [...snapshot.files].sort(order).map(file => ({ path: file.path, mode: file.mode, blobSha: file.blobSha })),
    reusable: [...snapshot.reusable].sort((a, b) => a.uses < b.uses ? -1 : a.uses > b.uses ? 1 : 0).map(item => ({ uses: item.uses, blobSha: item.blobSha })),
    pushBranches: [...policy.pushBranches].sort(),
  });
  return createHash('sha256').update(`homelab-bot/change-ci/v1\n${body}`).digest('hex');
}
// 값이 틀려도 fingerprint는 돌려준다. 사람이 승인값을 처음 정할 때 쓴다. 형태 위반이면 값도 주지 않는다.
export function evaluateCi(snapshot: CiSnapshot, policy: CiPolicy): CiResult {
  try {
    for (const workflow of snapshot.workflows) checkCaller(workflow.text, policy);
    for (const pinned of policy.reusable) {
      const found = snapshot.reusable.find(item => item.uses === pinned.uses);
      if (!found) throw violation('ci_reusable_unreadable');
      if (found.blobSha !== pinned.blobSha) throw violation('ci_reusable_moved');
      checkReusable(found.text, policy);
    }
  } catch (error) {
    if (error instanceof CiViolation) return { ok: false, reason: error.message };
    if (error instanceof Error && error.message === 'ci_yaml_unsupported') return { ok: false, reason: 'ci_yaml_unsupported' };
    throw error;
  }
  const fingerprint = ciFingerprint(snapshot, policy);
  return fingerprint === policy.approvedFingerprint ? { ok: true, fingerprint } : { ok: false, reason: 'ci_fingerprint_unapproved', fingerprint };
}

const isWorkflowFile = (path: string) => /^\.github\/workflows\/[^/]+\.ya?ml$/.test(path);
// 신뢰 base에서만 읽는다. 후보의 .github는 정책이 이미 막아 읽을 일이 없다. 하나라도 못 읽으면 null이고 호출자가 닫는다.
export async function readCiSnapshot(reader: CiContentReader, target: ChangeTarget, leaves: readonly { path: string; mode: string; blobSha: string }[], policy: CiPolicy): Promise<CiSnapshot | null> {
  const files = leaves.filter(leaf => leaf.path.startsWith('.github/')).map(leaf => ({ path: leaf.path, mode: leaf.mode, blobSha: leaf.blobSha }))
    .sort((a, b) => Buffer.compare(Buffer.from(a.path), Buffer.from(b.path)));
  const workflows: CiSnapshot['workflows'] = [];
  for (const file of files) {
    if (!isWorkflowFile(file.path)) continue;
    // symlink면 내용 blob이 다른 파일의 경로일 뿐이라 검사한 내용과 실행되는 내용이 다르다.
    if (file.mode !== '100644' && file.mode !== '100755') throw new Error('ci_workflow_mode');
    const text = await reader.readBlobText(target, file.blobSha);
    if (text === null) return null;
    workflows.push({ path: file.path, blobSha: file.blobSha, text });
  }
  const reusable: CiSnapshot['reusable'] = [];
  for (const pinned of policy.reusable) {
    const found = await reader.readPinnedWorkflow({ uses: pinned.uses });
    if (found) reusable.push({ uses: pinned.uses, blobSha: found.blobSha, text: found.text });
  }
  return { files, workflows, reusable };
}
