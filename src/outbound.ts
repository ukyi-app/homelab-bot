import { createHash } from 'node:crypto';
import { Denied } from './contracts.js';

// 발송 한 길. 바깥으로 나가는 글(Discord 글·스레드·고치기, GitHub 쓰기)은 모두 여기를 지난다.
// 순서: finalPayload(목적지 + 본문 → 보낼 바이트) → checkOutbound(그 바이트를 검사하고 digest·정책 판·목적지에 묶음)
// → sendOutbound(묶음 대조 → 지금 정책 판 → 발송함 대조 → 검사한 바이트 그대로 전송).
// 전송층(discordHttpApi, GitHubApi.call, github-writer의 exchange)은 쓰기 본문으로 OutboundBytes만 받고,
// OutboundBytes는 sendOutbound만 만든다. 그래서 이 함수를 건너뛴 쓰기는 전송층에서 막힌다(시험 test/outbound.test.ts).

// 검사 규칙의 판. 규칙을 바꾸면 올린다. 옛 판으로 만든 검사 결과는 보내지 못한다.
export const OUTBOUND_RULES_REVISION = 'outbound-1';

export type OutboundTarget =
  | { kind: 'discord-message'; channel: string }
  | { kind: 'discord-thread'; channel: string; from?: string }
  | { kind: 'discord-edit'; channel: string; message: string }
  | { kind: 'github'; method: 'POST' | 'PATCH'; path: string };
export interface OutboundPayload { readonly target: OutboundTarget; readonly bytes: string }
export interface OutboundCheck {
  readonly target: OutboundTarget; readonly digest: string; readonly policyRevision: string; readonly rules: string;
}
export type OutboundRefusal = 'unchecked' | 'payload_changed' | 'target_changed' | 'policy_changed' | 'rules_changed'
  | 'outbox_mismatch' | 'shape' | 'public_check';
// Denied의 하위라 기존 호출자의 "막힘" 처리를 그대로 탄다. 정책 판이 바뀐 경우만 호출자가 다시 시도할 수 있게 사유를 둔다.
export class OutboundRefused extends Denied {
  constructor(readonly reason: OutboundRefusal) { super(); this.message = `outbound_${reason}`; }
}

let mint: (bytes: string) => OutboundBytes;
// 검사를 지난 바이트. 생성자는 이 파일 밖에서 부를 수 없다(static 블록의 mint만).
export class OutboundBytes {
  readonly #bytes: string;
  private constructor(bytes: string) { this.#bytes = bytes; Object.freeze(this); }
  get bytes(): string { return this.#bytes; }
  static { mint = bytes => new OutboundBytes(bytes); }
}

// 공개 검사 하나. 본문의 모든 문자열 값을 받아 걸린 사유를 돌려준다. 경로별 검사(F-1~F-8)는 여기에 끼운다.
export type PublicScan = (texts: readonly string[]) => string | null;
export interface OutboundPorts {
  // 지금 정책 판. 검사 때의 판과 다르면 보내지 않는다.
  revision(): string | Promise<string>;
  // 발송함 대조. 같은 목적지·같은 바이트를 처음 보내는 자리일 때만 true다. 고치기는 그 목적지의 기존 글일 때만 true다.
  ledger: { admit(target: OutboundTarget, digest: string): Promise<boolean> };
  wire: OutboundWire;
}
export interface OutboundWire { wire(method: 'POST' | 'PATCH', path: string, body: OutboundBytes): Promise<unknown> }

const issued = new WeakSet<OutboundCheck>();
const sha256 = (bytes: string) => createHash('sha256').update(bytes, 'utf8').digest('hex');
const id = (value: unknown) => typeof value === 'string' && value.length > 0 && value.length <= 64 && !/[/?#%\s]/.test(value);
const GITHUB_PATH = /^\/repos\/[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+\/[A-Za-z0-9_./-]+$/;

// 목적지를 한 꼴의 문자열로. 검사 때와 보낼 때를 이 값으로 대조한다(칸 순서·덧붙은 칸에 흔들리지 않는다).
function targetKey(target: OutboundTarget): string {
  switch (target.kind) {
    case 'discord-message': return JSON.stringify([target.kind, target.channel]);
    case 'discord-thread': return JSON.stringify([target.kind, target.channel, target.from ?? null]);
    case 'discord-edit': return JSON.stringify([target.kind, target.channel, target.message]);
    case 'github': return JSON.stringify([target.kind, target.method, target.path]);
  }
}
function copyTarget(target: OutboundTarget): OutboundTarget {
  switch (target.kind) {
    case 'discord-message': return Object.freeze({ kind: target.kind, channel: target.channel });
    case 'discord-thread': return Object.freeze({ kind: target.kind, channel: target.channel, ...(target.from === undefined ? {} : { from: target.from }) });
    case 'discord-edit': return Object.freeze({ kind: target.kind, channel: target.channel, message: target.message });
    case 'github': return Object.freeze({ kind: target.kind, method: target.method, path: target.path });
    default: throw new OutboundRefused('shape');
  }
}
function validTarget(target: OutboundTarget): boolean {
  switch (target.kind) {
    case 'discord-message': return id(target.channel);
    case 'discord-thread': return id(target.channel) && (target.from === undefined || id(target.from));
    case 'discord-edit': return id(target.channel) && id(target.message);
    case 'github': return (target.method === 'POST' || target.method === 'PATCH') && GITHUB_PATH.test(target.path)
      && !target.path.split('/').some(part => part === '.' || part === '..');
  }
}
// 목적지에서 경로를 만드는 곳은 여기 하나다. 호출자는 경로를 넘기지 않는다(github은 경로 자체가 목적지다).
function route(target: OutboundTarget): { method: 'POST' | 'PATCH'; path: string } {
  const part = encodeURIComponent;
  switch (target.kind) {
    case 'discord-message': return { method: 'POST', path: `/channels/${part(target.channel)}/messages` };
    case 'discord-thread': return { method: 'POST', path: target.from === undefined ? `/channels/${part(target.channel)}/threads`
      : `/channels/${part(target.channel)}/messages/${part(target.from)}/threads` };
    case 'discord-edit': return { method: 'PATCH', path: `/channels/${part(target.channel)}/messages/${part(target.message)}` };
    case 'github': return { method: target.method, path: target.path };
  }
}
function strings(value: unknown, out: string[] = []): string[] {
  if (typeof value === 'string') out.push(value);
  else if (Array.isArray(value)) for (const item of value) strings(item, out);
  else if (value !== null && typeof value === 'object') for (const [key, item] of Object.entries(value)) { out.push(key); strings(item, out); }
  return out;
}
const record = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value);
// Discord 상한(글 2000자, 스레드 이름 100자, custom_id 100자)과 알림 막기. parse는 늘 비어 있어야 하고(everyone·역할 없음),
// 사용자 호출은 한 사람까지다. 버튼 이름 허용 목록은 게시자(DiscordPublisher.messageBody)가 BUTTONS 표로 본다.
function discordShape(target: OutboundTarget, body: Record<string, unknown>): boolean {
  if (target.kind === 'discord-thread') {
    const keys = Object.keys(body).sort().join(',');
    if (keys !== (target.from === undefined ? 'auto_archive_duration,name,type' : 'auto_archive_duration,name')) return false;
    return typeof body.name === 'string' && body.name.length > 0 && Array.from(body.name).length <= 100;
  }
  if (typeof body.content !== 'string' || Array.from(body.content).length > 2000) return false;
  const mentions = body.allowed_mentions;
  if (!record(mentions) || !Array.isArray(mentions.parse) || mentions.parse.length !== 0) return false;
  if (mentions.users !== undefined && (!Array.isArray(mentions.users) || mentions.users.length > 1)) return false;
  if (target.kind === 'discord-edit' && ('nonce' in body || 'message_reference' in body || 'components' in body)) return false;
  const rows = body.components;
  if (rows === undefined) return true;
  if (!Array.isArray(rows)) return false;
  return rows.every(row => record(row) && Array.isArray(row.components)
    && row.components.every(button => record(button) && typeof button.custom_id === 'string' && button.custom_id.length > 0 && button.custom_id.length <= 100));
}

// 보낼 바이트를 한 번 만든다. 이 뒤로 본문 객체를 다시 읽지 않는다.
export function finalPayload(target: OutboundTarget, body: unknown): OutboundPayload {
  const bytes = JSON.stringify(body);
  if (typeof bytes !== 'string') throw new OutboundRefused('shape');
  return Object.freeze({ target: copyTarget(target), bytes });
}

// 바이트를 다시 풀어 검사한다(본문 객체가 아니라 나갈 바이트가 기준이다). 결과는 얼린 값이고 이 파일만 진짜로 인정한다.
export function checkOutbound(payload: OutboundPayload, options: { policyRevision: string; scan?: PublicScan }): OutboundCheck {
  const bytes = payload.bytes;
  const target = copyTarget(payload.target);
  if (typeof bytes !== 'string' || !validTarget(target) || typeof options.policyRevision !== 'string' || !options.policyRevision) throw new OutboundRefused('shape');
  let body: unknown;
  try { body = JSON.parse(bytes); } catch { throw new OutboundRefused('shape'); }
  if (!record(body)) throw new OutboundRefused('shape');
  if (target.kind !== 'github' && !discordShape(target, body)) throw new OutboundRefused('shape');
  if (options.scan?.(Object.freeze(strings(body))) != null) throw new OutboundRefused('public_check');
  const check = Object.freeze({ target, digest: sha256(bytes), policyRevision: options.policyRevision, rules: OUTBOUND_RULES_REVISION });
  issued.add(check);
  return check;
}

// 한 길의 끝. payload와 check는 각각 한 번만 읽고, 보내는 바이트는 digest를 계산한 그 문자열이다.
// 대조가 하나라도 어긋나면 아무것도 보내지 않는다. 포트가 던지면 그대로 올라가고 그 뒤 효과는 없다.
export async function sendOutbound(payload: OutboundPayload, check: OutboundCheck, ports: OutboundPorts): Promise<unknown> {
  const bytes = payload.bytes;
  const target = payload.target;
  if (!issued.has(check)) throw new OutboundRefused('unchecked');
  if (check.rules !== OUTBOUND_RULES_REVISION) throw new OutboundRefused('rules_changed');
  if (typeof bytes !== 'string' || sha256(bytes) !== check.digest) throw new OutboundRefused('payload_changed');
  if (!target || targetKey(target) !== targetKey(check.target)) throw new OutboundRefused('target_changed');
  if (await ports.revision() !== check.policyRevision) throw new OutboundRefused('policy_changed');
  if (!await ports.ledger.admit(check.target, check.digest)) throw new OutboundRefused('outbox_mismatch');
  const { method, path } = route(check.target);
  return ports.wire.wire(method, path, mint(bytes));
}

// Discord 글·스레드 응답의 ID. 응답 모양이 다르면 보냈을 수 있으므로 호출자가 결과 불명으로 다룬다.
export function sentId(response: unknown): { id: string } {
  if (!record(response) || typeof response.id !== 'string' || !response.id) throw new Error('discord_response_invalid');
  return { id: response.id };
}
