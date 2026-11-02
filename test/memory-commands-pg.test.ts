import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import pg from 'pg';
import type { EventInput } from '../src/contracts.js';
import { Postgres, migrate } from '../src/database.js';
import { DiscordIngress } from '../src/discord.js';
import { MemoryService } from '../src/memory.js';
import type { DeletionEntry, DeletionLedger } from '../src/memory.js';
import { MemoryCommands } from '../src/memory-commands.js';
import { MockDiscord, event, fixture } from './helpers.js';

// 기억 명령(B4)을 실제 PostgreSQL 다중 연결에서 본다. PGlite는 transaction을 직렬화해 동시 도착을 만들 수 없다.
// HOMELAB_TEST_PG_SOCKET(유닉스 소켓 디렉터리)이 없으면 건너뛴다.
const socket = process.env.HOMELAB_TEST_PG_SOCKET;
const skip = socket ? false : 'HOMELAB_TEST_PG_SOCKET 없음(로컬 PostgreSQL 필요)';
class MemoryLedger implements DeletionLedger {
  private readonly list: DeletionEntry[] = [];
  async append(entry: DeletionEntry) { this.list.push(entry); }
  async has(id: string, createdAt: number) { return this.list.some(e => e.memoryId === id && e.createdAt === createdAt); }
  async entries() { return [...this.list]; }
  async durable() { return true; }
}
class ReplyDiscord extends MockDiscord {
  replies: { id: string; content: string }[] = [];
  override async acknowledge(e: EventInput, content: string, options: Parameters<MockDiscord['acknowledge']>[2]) {
    await super.acknowledge(e, content, options);
    this.replies.push({ id: e.id, content });
  }
}
const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
async function setup() {
  const admin = new pg.Pool({ host: socket, user: 'postgres', database: 'postgres', max: 1 });
  const name = `t20b4_${randomUUID().replaceAll('-', '').slice(0, 12)}`;
  await admin.query(`CREATE DATABASE ${name}`);
  const pool = new pg.Pool({ host: socket, user: 'postgres', database: name, max: 8 });
  const db = new Postgres(pool);
  await migrate(db);
  const f = await fixture(db);
  const memory = new MemoryService(db, f.gate, new MemoryLedger(), { check: async () => 'inaccessible' }, f.now);
  await memory.open();
  const rest = new ReplyDiscord();
  const ingress = new DiscordIngress(f.store, f.gate, rest, true, undefined, () => {}, new MemoryCommands(memory, () => 'ready', () => false, f.now));
  return { db, f, rest, ingress, close: async () => {
    await pool.end();
    for (let attempt = 0; ; attempt++) {
      try { await admin.query(`DROP DATABASE ${name}`); break; } catch (error) {
        if (attempt >= 50 || !/being accessed by other users/.test((error as Error).message)) throw error;
        await sleep(100);
      }
    }
    await admin.end();
  } };
}
const command = (id: string, name: string, text: string, target?: string) =>
  event(id, { kind: 'command', command: name, text, target, mention: undefined });

test('MEM-CMD-PG 같은 상호작용이 여러 연결로 동시에 와도 한 번만 저장·응답하고, 저장→검색→삭제가 실제 PostgreSQL에서 이어짐', { skip }, async () => {
  const env = await setup();
  try {
    const input = command('pg-dup', 'memory-save', '동시 도착 | expires=1d | end=x', 'preference');
    const results = await Promise.allSettled(Array.from({ length: 5 }, () => env.ingress.receive({ ...input })));
    assert.deepEqual(results.map(r => r.status), Array(5).fill('fulfilled'));
    assert.equal((await env.db.query('SELECT 1 FROM memories')).rows.length, 1);
    const replies = env.rest.replies.filter(r => r.id === 'pg-dup');
    assert.equal(replies.length, 1);
    const id = /`([0-9a-f-]{36})`/.exec(replies[0]!.content)![1]!;
    assert.match(replies[0]!.content, /상태 active/);

    await env.ingress.receive(command('pg-search', 'memory-search', '동시'));
    const found = env.rest.replies.find(r => r.id === 'pg-search')!.content;
    assert.ok(found.includes(id)); assert.match(found, /출처 conversation:pg-dup · 저장 \d{4}-\d{2}-\d{2}T\d{2}:\d{2}Z/);
    await env.ingress.receive(command('pg-delete', 'memory-delete', '', id));
    assert.ok(env.rest.replies.find(r => r.id === 'pg-delete')!.content.startsWith(`상태: 삭제 완료(deleted) \`${id}\``));
    await env.ingress.receive(command('pg-search-2', 'memory-search', '동시'));
    assert.equal(env.rest.replies.find(r => r.id === 'pg-search-2')!.content.includes(id), false);
  } finally { await env.close(); }
});
