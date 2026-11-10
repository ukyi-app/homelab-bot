import { after, afterEach, before, beforeEach, test } from 'node:test';
import assert from 'node:assert/strict';
import { GatewaySession } from '../src/gateway.js';
import type { GatewayOptions, PresenceStatus } from '../src/gateway.js';
import { FakeGateway, until } from './fake-gateway.js';
import type { GatewayPayload } from './fake-gateway.js';
import { localDatabase } from './helpers.js';

// C20 자리 비움(AC-15, AC-14의 💤). 경계 S1: 가짜 Gateway·가짜 Discord REST와 저장소(PGlite).
// 실제 Discord에는 연결하지 않는다.
let gw: FakeGateway;
let session: GatewaySession | undefined;
let database: Awaited<ReturnType<typeof localDatabase>>;
before(async () => { database = await localDatabase(); });
after(async () => { await database.pg.close(); });
beforeEach(async () => { gw = new FakeGateway(); gw.options.identifyIntervalMs = 200; await gw.start(); });
afterEach(async () => { await session?.stop(200); session = undefined; await gw.close(); });

function startGateway(presence: () => Promise<PresenceStatus>, overrides: Partial<GatewayOptions> = {}) {
  let last = -Infinity;
  session = new GatewaySession({
    token: 'fixture-token', gatewayUrl: async () => ({ url: gw.url }),
    budget: { next: async () => Math.max(Date.now(), last + 300),
      reserve: async () => { last = Math.max(Date.now(), last + 300); return { at: last, deadline: last + 50 }; },
      backoff: () => 10 },
    health: { gateway: () => {} },
    dispatch: async () => {},
    allowUrl: url => url.protocol === 'ws:' && url.hostname === '127.0.0.1', random: () => 0,
    presence,
    ...overrides,
  });
  session.start();
  return session;
}
// 봇이 Gateway로 보낸 상태 바꾸기(op 3)의 status만, 연결마다 받은 순서대로 모은다.
const statuses = (connection = gw.connections.at(-1)) => (connection?.received ?? []).filter((p: GatewayPayload) => p.op === 3)
  .map(p => (p.d as { status: string }).status);
const presencePayloads = () => gw.connections.flatMap(c => c.received.filter(p => p.op === 3));

test('AC-15 Gateway 상태: READY 뒤 그때의 상태를 보내고, 멈춤이면 idle·풀리면 online으로 바꾸며 같은 상태는 다시 보내지 않는다', async () => {
  let paused = false;
  const gateway = startGateway(async () => paused ? 'idle' : 'online');
  await until(() => statuses().length === 1);
  assert.deepEqual(statuses(), ['online']);
  paused = true;
  gateway.setPresence('idle');
  gateway.setPresence('idle');
  await until(() => statuses().length === 2);
  paused = false;
  gateway.setPresence('online');
  await until(() => statuses().length === 3);
  assert.deepEqual(statuses(), ['online', 'idle', 'online']);
  // 문서(Update Presence)의 네 칸을 모두 보낸다. 활동은 두지 않고 afk는 false다.
  for (const payload of presencePayloads()) {
    const d = payload.d as Record<string, unknown>;
    assert.deepEqual(Object.keys(d).sort(), ['activities', 'afk', 'since', 'status']);
    assert.deepEqual(d.activities, []); assert.equal(d.afk, false);
    assert.equal(d.since === null, d.status === 'online');
  }
});

test('AC-15 Gateway 상태: 재연결(RESUME) 뒤와 새 IDENTIFY 뒤에도 그때의 멈춤 상태를 다시 읽어 돌려놓는다', async () => {
  let paused = true;
  startGateway(async () => paused ? 'idle' : 'online');
  await until(() => statuses().length === 1);
  assert.deepEqual(statuses(), ['idle']);
  // RESUME: 끊긴 동안 풀렸으면 online으로 돌아온다.
  paused = false;
  gw.latest.close(4000);
  await until(() => gw.connections.length === 2 && statuses(gw.connections[1]).length === 1);
  assert.ok(gw.connections[1]!.received.some(p => p.op === 6));
  assert.deepEqual(statuses(gw.connections[1]), ['online']);
  // 세션을 잃어 새 IDENTIFY: 그 사이 다시 멈췄으면 idle로 돌아온다.
  paused = true;
  gw.options.resume = 'invalid';
  gw.latest.close(4000);
  await until(() => gw.connections.some((c, i) => i >= 2 && c.received.some(p => p.op === 2)) && statuses(gw.latest).length === 1, 8000);
  assert.deepEqual(statuses(gw.latest), ['idle']);
});

test('AC-15 Gateway 상태: 연결이 없을 때 바꾼 상태는 버리지 않고 다음 연결이 그때 상태를 읽어 보낸다, 읽기 실패는 연결을 막지 않는다', async () => {
  let fail = true;
  const gateway = startGateway(async () => { if (fail) throw new Error('db_down'); return 'idle'; });
  await until(() => gw.connections.some(c => c.received.some(p => p.op === 2)));
  await new Promise(resolve => setTimeout(resolve, 50));
  assert.deepEqual(statuses(), []);
  fail = false;
  gateway.setPresence('idle');
  await until(() => statuses().length === 1);
  assert.deepEqual(statuses(), ['idle']);
});
