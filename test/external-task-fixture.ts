import assert from 'node:assert/strict';
import { createPrivateKey, randomBytes, sign } from 'node:crypto';
import type { AddressInfo } from 'node:net';
import { connect } from 'node:net';
import type { Server } from 'node:http';
import type { Database } from '../src/database.js';
import { ExternalTaskLinks } from '../src/external-task-links.js';
import type { IssuedLink } from '../src/external-task-links.js';
import { EXTERNAL_TASK_PATH, ExternalTaskReceiver, FIXED_SUMMARY, sha256Hex, signatureInput } from '../src/external-task-receiver.js';
import type { ExternalReceiverOptions, ReceiverLimits } from '../src/external-task-receiver.js';
import type { Store } from '../src/store.js';
import { fixture, localDatabase, thread } from './helpers.js';

// [합성] 세션 ID·이벤트는 공식 문서의 필드로 만든 값이다. 실제 Claude·Codex 실행에서 얻은 것이 아니다.
export const SESSION = '00893aaf-19fa-41d2-8238-13269b9b3ca0';
export const ENVIRONMENT = 'fixture-env';
const PKCS8_ED25519 = Buffer.from('302e020100300506032b657004220420', 'hex');
export const conversationId = (store: Store) => store.scopeId(thread);
export async function seedConversation(db: Database, store: Store, now: number, scope = thread): Promise<void> {
  await db.query(`INSERT INTO conversations(id,owner_id,scope,channel_id,created_at) VALUES ($1,'fixture-owner',$2,$3,$4) ON CONFLICT DO NOTHING`,
    [store.scopeId(scope), JSON.stringify(scope), scope.channel, now]);
}
export interface Sender { connectionId: string; keyId: string; seed: string; externalTaskId: string }
export const sender = (link: IssuedLink): Sender => ({ connectionId: link.connectionId, keyId: link.keyId, seed: link.seed.reveal(), externalTaskId: link.externalTaskId });
export function eventBody(who: Sender, now: number, overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({ version: 1, connection_id: who.connectionId, event_id: randomBytes(16).toString('base64url'), external_task_id: who.externalTaskId,
    type: 'turn_complete', occurred_at: now, summary: FIXED_SUMMARY, ...overrides });
}
export function signedHeaders(who: Sender, raw: string | Buffer, sentAt: number, options: { environment?: string; method?: string; path?: string; seed?: string; keyId?: string; connectionId?: string } = {}) {
  const keyId = options.keyId ?? who.keyId;
  const connectionId = options.connectionId ?? who.connectionId;
  const input = signatureInput({ environment: options.environment ?? ENVIRONMENT, method: options.method ?? 'POST', path: options.path ?? EXTERNAL_TASK_PATH,
    connectionId, keyId, sentAt: String(sentAt), bodySha256: sha256Hex(Buffer.from(raw)) });
  const key = createPrivateKey({ key: Buffer.concat([PKCS8_ED25519, Buffer.from(options.seed ?? who.seed, 'base64url')]), format: 'der', type: 'pkcs8' });
  return { 'content-type': 'application/json', 'x-r08-connection-id': connectionId, 'x-r08-key-id': keyId,
    'x-r08-sent-at': String(sentAt), 'x-r08-signature': sign(null, input, key).toString('base64url') };
}
export async function receiverFixture(limits: Partial<ReceiverLimits> = {}, options: Partial<ExternalReceiverOptions> = {}) {
  const { db, pg } = await localDatabase();
  const f = await fixture(db);
  await seedConversation(db, f.store, f.now());
  const links = new ExternalTaskLinks(f.store);
  const receiver = new ExternalTaskReceiver({ store: f.store, links, authorize: (owner, scope) => f.gate.authorize(owner, scope), environment: ENVIRONMENT, limits, ...options });
  const attach = async (externalTaskId = SESSION, summaryConsent = false) =>
    sender(await links.attach({ owner: 'fixture-owner', scope: thread, externalTaskId, executor: 'claude', summaryConsent }));
  const count = async (table: string) => Number((await db.query<{ n: string }>(`SELECT count(*)::text AS n FROM ${table}`)).rows[0]!.n);
  return { db, pg, f, links, receiver, attach, count, close: () => pg.close() };
}
// 응답을 끝까지 읽거나 소켓이 닫힐 때까지 기다리는 저수준 클라이언트. fetch로는 보낼 수 없는 경로·헤더·느린 전송을 시험한다.
export function rawClient(server: Server) {
  const socket = connect((server.address() as AddressInfo).port, '127.0.0.1');
  let received = '';
  socket.setEncoding('utf8');
  socket.on('data', chunk => { received += chunk; });
  const closed = new Promise<void>(resolve => { socket.once('close', () => resolve()); socket.once('error', () => resolve()); });
  return {
    write: (text: string) => { if (!socket.destroyed) socket.write(text); },
    response: async () => { await closed; return { text: received, status: Number(/^HTTP\/1\.1 (\d{3})/.exec(received)?.[1] ?? 0) }; },
    destroy: () => socket.destroy(),
  };
}
export async function raw(server: Server, text: string) {
  const client = rawClient(server);
  client.write(text);
  return client.response();
}
export const request = (method: string, target: string, headers: Record<string, string>, body = '') =>
  `${method} ${target} HTTP/1.1\r\nHost: fixture\r\nConnection: close\r\n${Object.entries(headers).map(([k, v]) => `${k}: ${v}`).join('\r\n')}${Object.keys(headers).length ? '\r\n' : ''}`
  + `Content-Length: ${Buffer.byteLength(body)}\r\n\r\n${body}`;
export const listen = (server: Server) => new Promise<void>(resolve => server.listen(0, '127.0.0.1', () => resolve()));
export const shut = (server: Server) => new Promise<void>(resolve => { server.closeAllConnections(); server.close(() => resolve()); });

// PGlite와 실제 PostgreSQL에서 같이 돈다. outbox 삽입이 실패하면 이벤트도 남지 않아야 하고, 같은 event_id의 재시도가 그때 통과해야 한다.
export async function atomicityScenario(db: Database, handle: (raw: string) => Promise<{ status: number }>, body: string, connectionId: string): Promise<void> {
  await db.query(`CREATE FUNCTION fixture_outbox_boom() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'fixture_outbox_boom'; END $$`);
  await db.query('CREATE TRIGGER fixture_outbox_boom BEFORE INSERT ON outbox FOR EACH ROW EXECUTE FUNCTION fixture_outbox_boom()');
  assert.equal((await handle(body)).status, 503);
  const events = async () => Number((await db.query<{ n: string }>('SELECT count(*)::text AS n FROM external_task_events WHERE connection_id=$1', [connectionId])).rows[0]!.n);
  const outbox = async () => Number((await db.query<{ n: string }>(`SELECT count(*)::text AS n FROM outbox WHERE idempotency_key LIKE $1`, [`external-task:${connectionId}:%`])).rows[0]!.n);
  assert.equal(await events(), 0);
  assert.equal(await outbox(), 0);
  const last = (await db.query<{ last_event_at: string | null }>('SELECT last_event_at FROM external_task_connections WHERE id=$1', [connectionId])).rows[0]!;
  assert.equal(last.last_event_at, null);
  await db.query('DROP TRIGGER fixture_outbox_boom ON outbox');
  await db.query('DROP FUNCTION fixture_outbox_boom()');
  assert.equal((await handle(body)).status, 202);
  assert.equal(await events(), 1);
  assert.equal(await outbox(), 1);
}
