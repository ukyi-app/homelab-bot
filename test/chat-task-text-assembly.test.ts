import { after, afterEach, before, beforeEach, test } from 'node:test';
import assert from 'node:assert/strict';
import { CHAT_TASK_TEXT } from '../src/chat-task-text.js';
import { CONTROL_TEXT } from '../src/control-format.js';
import type { PublisherConfig } from '../src/config.js';
import type { Scope } from '../src/contracts.js';
import { startPublisher } from '../src/main.js';
import type { Publisher } from '../src/main.js';
import { Store } from '../src/store.js';
import { sendToHandlers } from './legacy-interaction-protocol.js';
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
// 운영 진입점은 '/' 명령을 받지 않는다(O08 F5). 운영 조립이 만든 처리기 묶음(조립된 Store 포함)을 운영과 같은 조립 함수로 묶어 부른다.
function command(name: string) {
  const id = String(++interactions);
  void sendToHandlers(rest, publisher?.handlers(), { id, token: `fixture-token-${id}`, type: 2, channel_id: THREAD, guild_id: GUILD,
    member: { user: { id: OWNER } }, data: { name, options: [] } }).catch(() => {});
}
const posted = async (count: number) => {
  await waitFor(() => rest.sent.filter(m => m.channel === THREAD).length >= count);
  return rest.sent.filter(m => m.channel === THREAD).map(m => m.content);
};

for (const colleague of [false, true]) test(`동료 스위치 ${colleague ? '켜짐' : '꺼짐'}: 조립을 거친 제어 결과가 ${colleague ? "'/' 이름 없는" : "'/' 안내"} 판으로 게시된다`, async () => {
  await seedConversation(database.db, new Store(database.db), Date.now(), SCOPE);
  await boot({ colleagueEnabled: colleague });
  await waitFor(() => !!publisher?.handlers());
  command('stop');
  const [stopped] = await posted(1);
  assert.ok(stopped!.startsWith(CHAT_TASK_TEXT.subscriptionStopped(colleague)), stopped);
  command('model-status');
  const [, status] = await posted(2);
  // 모델 상태는 스위치와 상관없이 필요한 상태·다음 행동만 싣는 고정 안내다(O08 F7b, F-5). 스위치 배선은 stop 문구가 본다.
  assert.ok(status!.startsWith(`${CONTROL_TEXT.running}\n`), status);
  assert.doesNotMatch(status!, /(^|\s)\/[a-z]/, status);
  if (colleague) assert.doesNotMatch(stopped!, /(^|\s)\/[a-z]/, stopped);
  else assert.match(stopped!, /\/(resume|resume-model)\b/, stopped);
});

for (const colleague of [false, true]) test(`O08 F5 배선: 설정의 동료 스위치(${colleague ? '켜짐' : '꺼짐'})가 조립된 처리기 묶음의 Store까지 간다`, async () => {
  await boot({ colleagueEnabled: colleague });
  await waitFor(() => !!publisher?.handlers());
  assert.equal(publisher!.handlers()!.store.colleague, colleague);
});
