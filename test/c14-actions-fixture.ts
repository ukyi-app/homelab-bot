import { randomUUID } from 'node:crypto';
import { mkdir, rm } from 'node:fs/promises';
import { ChangeCommands } from '../src/change-commands.js';
import type { AmendmentDiscussionReader } from '../src/change-commands.js';
import { ChangeStore } from '../src/change-store.js';
import type { Proposal, Scope } from '../src/contracts.js';
import type { Database } from '../src/database.js';
import { ALL_COMMANDS, DiscordIngress } from '../src/discord.js';
import { DiscordProtocol } from '../src/discord-protocol.js';
import { ExternalTaskCommands } from '../src/external-task-commands.js';
import { ExternalTaskLinks } from '../src/external-task-links.js';
import { MemoryService } from '../src/memory.js';
import type { DocumentSource } from '../src/memory.js';
import { MemoryCommands } from '../src/memory-commands.js';
import { TaskCommands } from '../src/task-commands.js';
import { BOT, harness } from './c13-proposal-fixture.js';
import type { ChangeRepositoryPolicy } from '../src/change-policy.js';
import { repositoryPolicy } from './change-github-fake.js';
import { thread } from './helpers.js';
import { closeLedgers, initLedger, ledgerAt } from './ledger-fixture.js';

// C14 시험의 S1 경계. C13 경계(Gateway 프레임 → 수신·저장 → 가짜 REST, 작업 레인)에 '/'와 같은 처리기 셋을 더 잇는다:
// 기억(MemoryService + 실제 파일 원장), 세션 연결(ExternalTaskLinks), 변경(ChangeStore, 작업자·GitHub 없이 접수까지).
export const TRUNCATE = `TRUNCATE events,conversations,jobs,results,outbox,controls,audit,denied_actors,codex_sessions,codex_questions,proposals,
  memories,memory_terms,memory_exclusions,memory_deletions,deletion_ledger_generation,external_task_connections,change_requests RESTART IDENTITY CASCADE`;
// 알림 채널 아래 스레드와 허용 채널 밖 스레드. 대화 채널 아래 스레드는 helpers.thread다.
export const notifyThread: Scope = { guild: thread.guild, channel: 'fixture-notify-thread', parent: 'fixture-notifications', kind: 'thread' };
export const outsideThread: Scope = { guild: thread.guild, channel: 'fixture-outside-thread', parent: 'fixture-outside', kind: 'thread' };
export const notifyChannel: Scope = { guild: thread.guild, channel: 'fixture-notifications', parent: null, kind: 'channel' };
const documents: DocumentSource = { check: async () => 'inaccessible' };
export type Actions = Awaited<ReturnType<typeof actions>>;
// discussion: 수정 요청(C27)의 PR 리뷰·댓글 읽기. 주면 변경 명령이 말로 하는 수정 요청을 받는다. repositories: 변경 정책의 저장소 목록(기본 하나).
export async function actions(db: Database, options: { colleague?: boolean; discussion?: AmendmentDiscussionReader; repositories?: ChangeRepositoryPolicy[] } = {}) {
  const h = await harness(db, options);
  (h.f.policy as { change?: unknown }).change = { repositories: options.repositories ?? [repositoryPolicy()] };
  await mkdir('.local', { recursive: true });
  const { dir } = await initLedger('c14-actions');
  const ledger = ledgerAt(dir, db);
  const memoryService = new MemoryService(db, h.f.gate, ledger, documents, h.f.now);
  await memoryService.open();
  const memory = new MemoryCommands(memoryService, () => ledger.status().state, () => false, h.f.now, options.colleague ?? true);
  const links = new ExternalTaskLinks(h.f.store);
  const external = new ExternalTaskCommands(links, 'fixture-environment', () => {}, options.colleague ?? true);
  const changeStore = new ChangeStore(db, h.f.now);
  const changes = new ChangeCommands({ store: h.f.store, changes: changeStore, gate: h.f.gate, log: () => {}, closedReason: () => null,
    ...(options.discussion ? { discussion: options.discussion } : {}) });
  const tasks = new TaskCommands(h.f.store, h.f.gate, h.local.bridge, () => ({ routed: true, open: true, reasons: [] }), () => {}, () => {});
  const channels = new Map([thread, notifyThread, outsideThread].map(scope => [scope.channel, scope]));
  const callbacks: { body: { type: number; data: Record<string, unknown> } }[] = [];
  // 상호작용 응답 직전에 부른다. 끝나지 않는 약속을 주면 응답 전에 멈춘 게시 서버, 던지면 응답 실패가 된다.
  const hooks: { beforeCallback?: () => Promise<void> } = {};
  const protocol = new DiscordProtocol({ request: async (method, path, body) => {
    const scope = method === 'GET' ? channels.get(path.replace('/channels/', '')) : undefined;
    if (scope) return { id: scope.channel, type: 11, parent_id: scope.parent, guild_id: scope.guild };
    if (method === 'GET' && path === `/channels/${notifyChannel.channel}`) return { id: notifyChannel.channel, type: 0, guild_id: thread.guild };
    if (method === 'PUT') return undefined;
    if (method === 'POST' && path.endsWith('/callback')) { await hooks.beforeCallback?.(); callbacks.push({ body: body as never }); return undefined; }
    throw new Error(`unexpected_route ${method} ${path}`);
  } }, BOT, h.f.now);
  const ingress = new DiscordIngress(h.f.store, h.f.gate, protocol, true, ALL_COMMANDS, () => {}, memory, tasks, external, changes);
  let interactions = 0;
  let commands = 0;
  const content = (text: string) => text.split('\n-# ref:')[0]!;
  const deliver = async () => { while (await h.f.publisher.deliver()) { /* 쌓인 게시를 비운다 */ } };
  const self = {
    f: h.f, local: h.local, ingress, memoryService, links, changeStore, callbacks, deliver, hooks,
    reply: (proposal: Proposal | null, text = '확인해 주세요.') => h.reply(proposal, text),
    // owner의 멘션 메시지 한 통(Gateway MESSAGE_CREATE).
    say: (id: string, text: string, options: { author?: string; scope?: Scope } = {}) => protocol.gateway('MESSAGE_CREATE', { id,
      channel_id: (options.scope ?? thread).channel, guild_id: thread.guild, author: { id: options.author ?? h.f.policy.owner },
      content: `<@${BOT}> ${text}`, mentions: [{ id: BOT }] }, ingress),
    turn: h.turn,
    // 말 한 통과 대화 차례 한 번. 모델 답은 proposal 하나를 낸다.
    speak: async (id: string, text: string, proposal: Proposal | null, options: { scope?: Scope } = {}) => {
      h.reply(proposal, '확인해 주세요.');
      await self.say(id, text, options);
      await h.turn();
    },
    press: (customId: string, options: { actor?: string; scope?: Scope } = {}) => protocol.gateway('INTERACTION_CREATE', {
      id: `fixture-c14-interaction-${++interactions}`, token: 'fixture-interaction-token', type: 3, channel_id: (options.scope ?? thread).channel,
      guild_id: thread.guild, member: { user: { id: options.actor ?? h.f.policy.owner } }, data: { custom_id: customId } }, ingress),
    // '/' 명령 하나(비교 기준). 상호작용 응답 본문(reply)과 그 명령이 남긴 영속 게시 본문(posted)을 돌려준다.
    slash: async (command: string, fields: { text?: string; target?: string; scope?: Scope } = {}) => {
      const callbacksBefore = callbacks.length;
      const postedBefore = h.f.rest.messages.length;
      const options = [...(fields.target !== undefined ? [{ name: 'target', type: 3, value: fields.target }] : []),
        ...(fields.text !== undefined ? [{ name: 'text', type: 3, value: fields.text }] : [])];
      await protocol.gateway('INTERACTION_CREATE', { id: `fixture-c14-command-${++commands}`, token: 'fixture-interaction-token', type: 2,
        channel_id: (fields.scope ?? thread).channel, guild_id: thread.guild, member: { user: { id: h.f.policy.owner } },
        data: { name: command, ...(options.length ? { options } : {}) } }, ingress);
      await deliver();
      const reply = callbacks.length > callbacksBefore ? String(callbacks.at(-1)!.body.data.content ?? '') : undefined;
      return { reply, posted: h.f.rest.messages.slice(postedBefore).map(m => content(m.body.content)) };
    },
    buttons: h.buttons,
    lastCallback: () => callbacks.at(-1)?.body,
    posted: () => h.f.rest.messages.map(m => content(m.body.content)),
    proposals: async () => (await db.query<{ id: string; action: string; state: string; value: string | null; source_event: string | null; reason: string | null }>(
      'SELECT id,action,state,value,source_event,reason FROM proposals ORDER BY created_at')).rows,
    dropped: async () => (await db.query<{ detail: { action: string; reason: string } }>("SELECT detail FROM audit WHERE kind='proposal_dropped' ORDER BY created_at")).rows
      .map(row => typeof row.detail === 'string' ? JSON.parse(row.detail) as { action: string; reason: string } : row.detail),
    jobs: async (type: string) => (await db.query<{ id: string; state: string }>('SELECT id,state FROM jobs WHERE type=$1 ORDER BY created_at', [type])).rows,
    // 리뷰 작업 한 건(대화 없음). 리뷰 접수 경로 대신 행을 바로 둔다. 시험 대상은 제어 경로다.
    reviewJob: async (state: 'queued' | 'waiting_user' = 'queued') => {
      const event = randomUUID();
      const job = randomUUID();
      await db.query(`INSERT INTO events(id,provider,delivery_id,semantic_key,actor_id,scope,conversation_id,received_at,payload)
        VALUES ($1,'github',$2,$3,'fixture-github',$4,NULL,$5,'{"text":""}')`, [event, event, `github:${event}`, JSON.stringify(notifyChannel), h.f.now()]);
      await db.query(`INSERT INTO jobs(id,event_id,conversation_id,type,owner_id,target,revision,budget,priority,available_at,created_at,state,wait_reason)
        VALUES ($1,$2,NULL,'review',$3,$4,'{"policy":"fixture-v1"}','{"timeoutMs":1000,"toolCalls":0}',50,$5,$5,$6,$7)`,
      [job, event, h.f.policy.owner, JSON.stringify(notifyChannel), h.f.now(), state, state === 'waiting_user' ? 'model_limit' : null]);
      return job;
    },
    // 리뷰 작업이 한도 대기에 들어간다. 한도 대기는 대화 슬롯도 잡으므로 대화 차례를 끝낸 뒤에 둔다.
    waitReview: async (job: string) => {
      await db.query("UPDATE jobs SET state='waiting_user',wait_reason='model_limit' WHERE id=$1", [job]);
    },
    close: async () => { await closeLedgers(); await rm(dir, { recursive: true, force: true }); },
  };
  return self;
}
