import { after, afterEach, before, beforeEach, test } from 'node:test';
import assert from 'node:assert/strict';
import { CHAT_TASK_TEXT } from '../src/chat-task-text.js';
import type { PublisherConfig } from '../src/config.js';
import type { Scope } from '../src/contracts.js';
import { startPublisher } from '../src/main.js';
import type { Publisher } from '../src/main.js';
import { Store } from '../src/store.js';
import { seedConversation } from './external-task-fixture.js';
import { FakeGateway } from './fake-gateway.js';
import { localDatabase } from './helpers.js';
import { CHAT, GUILD, OWNER, Rest, Trace, publisherConfig, waitFor } from './t20-harness.js';

// S1 조립 경계: 정책의 동료 기능 스위치(config.colleagueEnabled)가 startPublisher 조립을 거쳐 Discord에 게시되는 고정 문구의 판을 고른다.
// 단위 시험만으로는 조립 배선이 빠져 운영이 늘 꺼짐 판인 것을 잡지 못한다.
const THREAD = 'fixture-c09-thread';
const SCOPE: Scope = { guild: GUILD, channel: THREAD, parent: CHAT, kind: 'thread' };
class ThreadRest extends Rest {
  registered = false;
  override async request(method: 'GET' | 'POST' | 'PUT', path: string, body?: unknown): Promise<unknown> {
    if (method === 'GET' && path === `/channels/${THREAD}`) return { id: THREAD, type: 11, guild_id: GUILD, parent_id: CHAT };
    if (method === 'PUT' && path === `/applications/fixture-app/guilds/${GUILD}/commands`) this.registered = true;
    return super.request(method, path, body);
  }
}
let database: Awaited<ReturnType<typeof localDatabase>>;
let gw: FakeGateway;
let rest: ThreadRest;
let publisher: Publisher | undefined;
before(async () => { database = await localDatabase(); });
after(async () => { await database.pg.close(); });
beforeEach(async () => {
  const tables = (await database.pg.query<{ tablename: string }>(
    "SELECT tablename FROM pg_tables WHERE schemaname='public' AND tablename NOT IN ('schema_migrations','execution_lanes','external_task_link_fence')")).rows.map(r => r.tablename);
  await database.pg.exec(`TRUNCATE ${tables.join(',')} RESTART IDENTITY CASCADE`);
  gw = new FakeGateway(); gw.options.identifyIntervalMs = 250; await gw.start();
  rest = new ThreadRest(new Trace());
});
afterEach(async () => {
  await publisher?.stop(); publisher = undefined;
  await gw.close();
});
const boot = async (extra: Partial<PublisherConfig>) => {
  publisher = await startPublisher(publisherConfig(extra), { db: database.db, discord: rest, send: async () => new Response('OK'),
    gatewayUrl: async () => ({ url: gw.url }), allowGatewayUrl: url => url.hostname === '127.0.0.1', serviceAccount: { tokenFile: '/nonexistent', caFile: null },
    ports: { app: 0, alerts: 0 }, idleMs: 20, identifySpacingMs: 250, registerDelaysMs: [0], heartbeatEveryMs: 60_000, stopTimeoutMs: 3000, log: () => {} });
};
let interactions = 7000;
function command(name: string) {
  const id = String(++interactions);
  gw.dispatch(gw.latest, interactions, 'INTERACTION_CREATE', { id, token: `fixture-token-${id}`, type: 2, channel_id: THREAD, guild_id: GUILD,
    member: { user: { id: OWNER } }, data: { name, options: [] } });
}
const posted = async (count: number) => {
  await waitFor(() => rest.sent.filter(m => m.channel === THREAD).length >= count);
  return rest.sent.filter(m => m.channel === THREAD).map(m => m.content);
};

for (const colleague of [false, true]) test(`동료 스위치 ${colleague ? '켜짐' : '꺼짐'}: 조립을 거친 제어 결과가 ${colleague ? "'/' 이름 없는" : "'/' 안내"} 판으로 게시된다`, async () => {
  await seedConversation(database.db, new Store(database.db), Date.now(), SCOPE);
  await boot({ colleagueEnabled: colleague });
  await waitFor(() => rest.registered);
  command('stop');
  const [stopped] = await posted(1);
  assert.ok(stopped!.startsWith(CHAT_TASK_TEXT.subscriptionStopped(colleague)), stopped);
  command('model-status');
  const [, status] = await posted(2);
  assert.match(status!, /`homelab bot` CLI|\/resume-model/);
  for (const text of [stopped!, status!]) {
    if (colleague) assert.doesNotMatch(text, /(^|\s)\/[a-z]/, text);
    else assert.match(text, /\/(resume|resume-model)\b/, text);
  }
});
