import assert from 'node:assert/strict';
import test from 'node:test';
import { COMMAND_DEFINITIONS, commandDefinitions, registerCommands } from '../src/commands.js';
import type { DiscordApi } from '../src/discord-protocol.js';

// guild 명령 GET 응답 모양. contexts·integration_types는 생략되고(T30 INT-03 운영 GET, 32개 모두),
// 서버가 붙이는 id·version·nsfw 등이 더해진다. 옵션 required false는 생략될 수 있다.
type Definition = { name: string; options?: { required?: boolean }[]; [key: string]: unknown };
const asGuildResponse = (definitions: readonly unknown[]) => (structuredClone(definitions) as Definition[]).map((command, index) => {
  const { contexts: _c, integration_types: _i, ...rest } = command;
  return { id: `${1000 + index}`, application_id: 'fixture-app', guild_id: 'fixture-guild', version: `${2000 + index}`,
    default_member_permissions: null, nsfw: false, ...rest,
    options: (rest.options ?? []).map(({ required, ...option }) => required ? { ...option, required } : option) };
});

function fakeDiscord(initial: readonly unknown[]) {
  let stored = asGuildResponse(initial);
  const puts: unknown[][] = [];
  const api: DiscordApi = {
    request: async (method: string, path: string, body?: unknown) => {
      if (!path.includes('/guilds/')) return [];
      if (method === 'PUT') { puts.push(body as unknown[]); stored = asGuildResponse(body as unknown[]); return stored; }
      return structuredClone(stored);
    },
  } as DiscordApi;
  return { api, puts };
}
const register = (api: DiscordApi, definitions: readonly unknown[]) => registerCommands(api, 'fixture-app', 'fixture-guild', definitions);

test('A08: 실제 guild 응답 모양(contexts·integration_types 생략)으로 연속 등록하면 PUT 0', async () => {
  const definitions = commandDefinitions(true, true, true, true, true);
  const { api, puts } = fakeDiscord(definitions);
  assert.deepEqual(await register(api, definitions), { guild: 'unchanged', global: 'unchanged' });
  assert.deepEqual(await register(api, definitions), { guild: 'unchanged', global: 'unchanged' });
  assert.equal(puts.length, 0);
});

test('A08: 명령 정의가 바뀌면 PUT 1, 그 뒤 같은 정의는 PUT 0', async () => {
  const { api, puts } = fakeDiscord(COMMAND_DEFINITIONS);
  const opened = commandDefinitions(true, true, true, true, true);
  assert.equal((await register(api, opened)).guild, 'updated');
  assert.equal((await register(api, opened)).guild, 'unchanged');
  assert.equal(puts.length, 1);
  assert.deepEqual(puts[0], opened);

  const described = opened.map(command => (command as Definition).name === 'chat' ? { ...(command as Definition), description: '바뀐 설명' } : command);
  assert.equal((await register(api, described)).guild, 'updated');
  assert.equal((await register(api, described)).guild, 'unchanged');
  assert.equal(puts.length, 2);
});

test('A08: 옵션 상한이 바뀌어도 PUT 1', async () => {
  const definitions = commandDefinitions(false, false, false, false, true);
  const { api, puts } = fakeDiscord(definitions);
  const widened = (structuredClone(definitions) as unknown as Definition[]).map(command => command.name === 'change-publish'
    ? { ...command, options: (command.options as { max_length: number }[]).map(option => ({ ...option, max_length: option.max_length + 1 })) } : command);
  assert.equal((await register(api, widened)).guild, 'updated');
  assert.equal(puts.length, 1);
});

test('A08: 요청 모양을 그대로 돌려주는 응답도 PUT 0', async () => {
  const definitions = commandDefinitions(true, true, true, true, true);
  let puts = 0;
  const api = { request: async (method: string, path: string) => {
    if (method === 'PUT') puts++;
    return path.includes('/guilds/') ? structuredClone(definitions) : [];
  } } as DiscordApi;
  await register(api, definitions); await register(api, definitions);
  assert.equal(puts, 0);
});
