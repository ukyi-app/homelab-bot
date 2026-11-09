import { after, before, beforeEach, test } from 'node:test';
import assert from 'node:assert/strict';
import { DiscordProtocol, discordHttpApi } from '../src/discord-protocol.js';
import type { DiscordApi } from '../src/discord-protocol.js';
import { localDatabase } from './helpers.js';

// C04 반응 수명(AC-14): 받으면 👀, 다른 모델 일 뒤에 기다리면 ⏳, 답이 게시되면 봇 반응을 모두 지운다.
// 실패가 확정되면 지우고 실패 한 줄을 단다. 지우기는 봇 자신의 반응(@me)만이다.
type Call = { method: string; path: string; body?: unknown };
const EYES = '%F0%9F%91%80';
const HOURGLASS = '%E2%8F%B3';
function fakeApi(fail?: (call: Call) => Error | undefined) {
  const calls: Call[] = [];
  const api: DiscordApi = {
    async request(method, path, body) {
      const call = { method, path, body };
      calls.push(call);
      const error = fail?.(call);
      if (error) throw error;
      return method === 'PUT' || method === 'DELETE' ? undefined : { id: '1' };
    },
  };
  return { api, calls };
}

test('protocol: ⏳ 더하기는 봇 자신(@me)의 PUT, 지우기는 봇 자신(@me)의 DELETE', async () => {
  const { api, calls } = fakeApi();
  const protocol = new DiscordProtocol(api, 'fixture-bot');
  await protocol.addReaction('c1', 'm1', '⏳');
  await protocol.removeOwnReaction('c1', 'm1', '👀');
  assert.deepEqual(calls.map(c => [c.method, c.path, c.body]), [
    ['PUT', `/channels/c1/messages/m1/reactions/${HOURGLASS}/@me`, undefined],
    ['DELETE', `/channels/c1/messages/m1/reactions/${EYES}/@me`, undefined],
  ]);
});

test('discordHttpApi: 반응 DELETE는 본문 없이 보내고 204 빈 응답을 받는다', async () => {
  const seen: { url: string; method?: string; body?: unknown }[] = [];
  const api = discordHttpApi('fixture-token', (async (url: string, init: RequestInit) => {
    seen.push({ url, method: init.method, body: init.body });
    return new Response(null, { status: 204 });
  }) as typeof fetch);
  assert.equal(await api.request('DELETE', `/channels/1/messages/2/reactions/${EYES}/@me`), undefined);
  assert.deepEqual(seen, [{ url: `https://discord.com/api/v10/channels/1/messages/2/reactions/${EYES}/@me`, method: 'DELETE', body: undefined }]);
});

let database: Awaited<ReturnType<typeof localDatabase>>;
before(async () => { database = await localDatabase(); });
beforeEach(async () => {
  await database.pg.exec('TRUNCATE events,conversations,jobs,results,outbox,schedules,denied_actors,controls,audit,incidents RESTART IDENTITY CASCADE');
});
after(async () => { await database.pg.close(); });
