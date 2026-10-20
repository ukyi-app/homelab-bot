import { createServer } from 'node:http';
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { AlertIngress } from './alerts.js';
import type { Health } from './health.js';
import { z } from 'zod';

export const PORTS = Object.freeze({ publisher: 8080, alerts: 8081, worker: 8080 });
export async function body(request: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > 65_536) throw new Error('body_limit');
    chunks.push(Buffer.from(chunk));
  }
  return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}
export function receivers(health: Health, alerts: AlertIngress) {
  const app = createServer(async (req, res) => {
    if (req.method === 'GET' && req.url === '/readyz') {
      const ready = await health.ready(); res.writeHead(ready ? 200 : 503).end();
    } else if (req.method === 'GET' && req.url === '/metrics') {
      try { res.writeHead(200, { 'content-type': 'text/plain' }).end(await health.metrics()); }
      catch { res.writeHead(503).end(); }
    } else res.writeHead(404).end(); // GitHub ingestion belongs to T17; no permissive placeholder.
  });
  const alertServer = createServer(async (req: IncomingMessage, res: ServerResponse) => {
    if (req.method !== 'POST' || req.url !== '/alerts') { res.writeHead(404).end(); return; }
    try { await alerts.receive(await body(req)); res.writeHead(202).end(); }
    catch (error) { res.writeHead(error instanceof z.ZodError || error instanceof SyntaxError ? 400 : 503).end(); }
  });
  app.on('listening', () => { health.receivers.app = true; });
  app.on('close', () => { health.receivers.app = false; });
  alertServer.on('listening', () => { health.receivers.alerts = true; });
  alertServer.on('close', () => { health.receivers.alerts = false; });
  app.requestTimeout = alertServer.requestTimeout = 5000;
  return { app, alerts: alertServer };
}
