import { test } from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync, randomBytes, sign } from 'node:crypto';
import { createServer as createHttpServer } from 'node:http';
import type { IncomingHttpHeaders, IncomingMessage, Server as HttpServer, ServerResponse } from 'node:http';
import { createServer as createHttpsServer } from 'node:https';
import { connect as connectTcp } from 'node:net';
import type { AddressInfo, Socket } from 'node:net';
import { setDefaultCACertificates } from 'node:tls';
import { gzipSync } from 'node:zlib';
import { ARCHIVE_DEADLINE_MS, ArchiveFetchError, createArchiveFetcher } from '../src/archive-fetcher.js';
import type { ArchiveFailureReason } from '../src/archive-fetcher.js';
import { ArchiveError, readArchive } from '../src/review-input.js';
import { archiveContract } from '../src/worker.js';

// 실제 네트워크를 쓰지 않는다. codeload.github.com:443 CONNECT를 가짜 프록시가 받아 로컬 TLS 서버로 잇고,
// DER을 직접 만든 시험용 인증서로 실제 TLS 검증까지 탄다. 인증서 파일·openssl이 필요 없다.
const der = (tag: number, ...parts: Buffer[]) => {
  const body = Buffer.concat(parts);
  const length = body.length < 0x80 ? [body.length] : body.length < 0x100 ? [0x81, body.length] : [0x82, body.length >> 8, body.length & 0xff];
  return Buffer.concat([Buffer.from([tag, ...length]), body]);
};
const seq = (...parts: Buffer[]) => der(0x30, ...parts);
const oid = (...bytes: number[]) => der(0x06, Buffer.from(bytes));
function selfSigned(hostname: string): { key: string; cert: string } {
  const { privateKey, publicKey } = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
  const algorithm = seq(oid(0x2a, 0x86, 0x48, 0xce, 0x3d, 0x04, 0x03, 0x02));
  const name = seq(der(0x31, seq(oid(0x55, 0x04, 0x03), der(0x0c, Buffer.from(hostname)))));
  const extensions = der(0xa3, seq(
    seq(oid(0x55, 0x1d, 0x13), der(0x04, seq(der(0x01, Buffer.from([0xff]))))),
    seq(oid(0x55, 0x1d, 0x11), der(0x04, seq(der(0x82, Buffer.from(hostname))))),
  ));
  const tbs = seq(der(0xa0, der(0x02, Buffer.from([2]))), der(0x02, randomBytes(8).fill(1, 0, 1)), algorithm, name,
    seq(der(0x17, Buffer.from('200101000000Z')), der(0x17, Buffer.from('491231235959Z'))), name,
    publicKey.export({ type: 'spki', format: 'der' }), extensions);
  const signature = sign('sha256', tbs, privateKey);
  const certificate = seq(tbs, algorithm, der(0x03, Buffer.from([0]), signature));
  return { key: privateKey.export({ type: 'pkcs8', format: 'pem' }).toString(),
    cert: `-----BEGIN CERTIFICATE-----\n${certificate.toString('base64').replace(/.{64}/g, '$&\n')}\n-----END CERTIFICATE-----\n` };
}
const TRUSTED = selfSigned('codeload.github.com');
const WRONG_NAME = selfSigned('other.example.test');
const UNTRUSTED = selfSigned('codeload.github.com');
// node --test는 파일마다 프로세스를 나누므로 이 설정은 다른 시험에 새지 않는다.
setDefaultCACertificates([TRUSTED.cert, WRONG_NAME.cert]);

const sha = (seed: string) => seed.repeat(40).slice(0, 40);
const URL_OK = archiveContract('fixture-org/fixture-repo', sha('a'), sha('b')).base;
const listen = (server: HttpServer) => new Promise<number>(resolve => server.listen(0, '127.0.0.1', () => resolve((server.address() as AddressInfo).port)));
const options = (signal: AbortSignal = new AbortController().signal, maxBytes = 1_000_000) =>
  ({ credentials: 'omit' as const, redirect: 'error' as const, maxBytes, signal });
async function failsWith(run: Promise<unknown>, reason: ArchiveFailureReason, kind: ArchiveFetchError['kind']) {
  const error = await run.then(() => assert.fail('받기가 성공하면 안 된다'), (caught: unknown) => caught);
  assert.ok(error instanceof ArchiveFetchError, String(error));
  assert.ok(error instanceof ArchiveError); // ReviewWorker가 message를 failed reason으로 쓰는 조건
  assert.equal(error.message, reason);
  assert.equal(error.kind, kind);
}
const closed = (socket: { once(event: 'close', listener: () => void): unknown }) => new Promise<void>(resolve => { socket.once('close', resolve); });

type Handler = (req: IncomingMessage, res: ServerResponse) => void;
interface HarnessOptions { tls?: { key: string; cert: string }; connect?: 'tunnel' | 'refuse' | 'hang' }
async function harness(handler: Handler, setup: HarnessOptions = {}) {
  const requests: { method: string | undefined; url: string | undefined; headers: IncomingHttpHeaders }[] = [];
  const connects: { target: string | undefined; headers: IncomingHttpHeaders }[] = [];
  const sockets = new Set<Socket>();
  const tunnels: Socket[] = [];
  let plain = 0;
  const origin = createHttpsServer(setup.tls ?? TRUSTED, (req, res) => {
    requests.push({ method: req.method, url: req.url, headers: req.headers });
    handler(req, res);
  });
  const originPort = await listen(origin);
  const proxy = createHttpServer((_req, res) => { plain++; res.writeHead(405).end(); });
  proxy.on('connect', (req: IncomingMessage, client: Socket, head: Buffer) => {
    connects.push({ target: req.url, headers: req.headers });
    sockets.add(client);
    tunnels.push(client);
    client.on('error', () => {});
    if (setup.connect === 'hang') return;
    if (setup.connect === 'refuse') { client.end('HTTP/1.1 403 Forbidden\r\n\r\n'); return; }
    const upstream = connectTcp(originPort, '127.0.0.1', () => {
      client.write('HTTP/1.1 200 Connection Established\r\n\r\n');
      upstream.write(head);
      upstream.pipe(client);
      client.pipe(upstream);
    });
    sockets.add(upstream);
    upstream.on('error', () => client.destroy());
    client.on('close', () => upstream.destroy());
  });
  const proxyPort = await listen(proxy);
  return {
    env: { HTTPS_PROXY: `http://127.0.0.1:${proxyPort}` }, requests, connects, tunnels, plain: () => plain,
    async close() {
      for (const socket of sockets) socket.destroy();
      origin.closeAllConnections();
      proxy.closeAllConnections();
      await Promise.all([new Promise(resolve => origin.close(resolve)), new Promise(resolve => proxy.close(resolve))]);
    },
  };
}
type Harness = Awaited<ReturnType<typeof harness>>;
async function withHarness(handler: Handler, run: (h: Harness) => Promise<void>, setup?: HarnessOptions) {
  const h = await harness(handler, setup);
  try { await run(h); } finally { await h.close(); }
}
const never: Handler = () => {};
// 회귀가 나도 기본 deadline 5분을 기다리며 시험이 매달리지 않게 한다.
const via = (h: Harness) => createArchiveFetcher({ env: h.env, deadlineMs: 5000 });
async function within(done: Promise<unknown>, ms: number, label: string) {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try { await Promise.race([done, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(label)), ms); })]); }
  finally { clearTimeout(timer); }
}

test('정상: CONNECT로 프록시를 타고 바이트를 그대로 돌려주며 자격 헤더를 보내지 않는다', async () => {
  const body = randomBytes(300_000);
  await withHarness((_req, res) => { res.writeHead(200, { 'content-type': 'application/x-gzip' }); res.end(body); }, async h => {
    const bytes = await via(h)(URL_OK, options());
    assert.ok(Buffer.from(bytes).equals(body));
    assert.deepEqual(h.connects.map(c => c.target), ['codeload.github.com:443']);
    assert.equal(h.plain(), 0);
    assert.equal(h.connects[0]!.headers['proxy-authorization'], undefined);
    assert.equal(h.requests.length, 1);
    const sent = h.requests[0]!;
    assert.equal(sent.method, 'GET');
    assert.equal(sent.url, `/fixture-org/fixture-repo/tar.gz/${sha('a')}`);
    assert.equal(sent.headers.host, 'codeload.github.com');
    assert.equal(sent.headers['accept-encoding'], 'identity');
    for (const name of ['authorization', 'cookie', 'proxy-authorization']) assert.equal(sent.headers[name], undefined, name);
  });
});

test('정상: 받은 뒤 터널을 남기지 않는다', async () => {
  await withHarness((_req, res) => res.end('ok'), async h => {
    await via(h)(URL_OK, options());
    // undici keep-alive 기본값이 4초다. 그보다 짧게 봐야 정리 없이 저절로 닫히는 경우와 구분된다.
    await within(closed(h.tunnels[0]!), 1500, '터널이 남았다');
  });
});

test('정상: base·head를 차례로 받아 readArchive까지 읽힌다', async () => {
  const tar = Buffer.alloc(1536);
  tar.write('fixture-repo-abc/AGENTS.md', 0);
  tar.write('0000644\0', 100);
  tar.write('00000000005\0', 124);
  tar.write('0', 156);
  tar.write('hello', 512);
  const gz = gzipSync(tar);
  await withHarness((_req, res) => { res.writeHead(200, { 'content-type': 'application/x-gzip' }); res.end(gz); }, async h => {
    const fetcher = via(h);
    const contract = archiveContract('fixture-org/fixture-repo', sha('a'), sha('b'));
    for (const url of [contract.base, contract.head]) {
      const entries = readArchive(await fetcher(url, options()), 1_000_000);
      assert.equal(entries.get('AGENTS.md')?.data.toString(), 'hello');
    }
    assert.deepEqual(h.requests.map(r => r.url), [`/fixture-org/fixture-repo/tar.gz/${sha('a')}`, `/fixture-org/fixture-repo/tar.gz/${sha('b')}`]);
    assert.equal(h.connects.length, 2);
  });
});

test('정상: env를 주지 않으면 process.env의 HTTPS_PROXY를 쓴다', async () => {
  await withHarness((_req, res) => res.end('ok'), async h => {
    const saved = process.env.HTTPS_PROXY;
    process.env.HTTPS_PROXY = h.env.HTTPS_PROXY;
    try {
      assert.equal(Buffer.from(await createArchiveFetcher()(URL_OK, options())).toString(), 'ok');
      assert.equal(h.connects.length, 1);
    } finally {
      if (saved === undefined) delete process.env.HTTPS_PROXY; else process.env.HTTPS_PROXY = saved;
    }
  });
});

test('URL 거부: 정확한 codeload 꼴이 아니면 프록시에도 보내지 않는다', async () => {
  const good = sha('a');
  const rejected = [
    `https://github.com/o/r/tar.gz/${good}`,
    `https://api.github.com/o/r/tar.gz/${good}`,
    `https://codeload.github.com.example.test/o/r/tar.gz/${good}`,
    `https://CODELOAD.github.com/o/r/tar.gz/${good}`,
    `http://codeload.github.com/o/r/tar.gz/${good}`,
    `https://codeload.github.com:8443/o/r/tar.gz/${good}`,
    `https://user:secret@codeload.github.com/o/r/tar.gz/${good}`,
    `https://codeload.github.com/o/r/tar.gz/${good}?token=x`,
    `https://codeload.github.com/o/r/tar.gz/${good}#x`,
    `https://codeload.github.com/o/r/tar.gz/${good}/`,
    `https://codeload.github.com/o/r/tar.gz/${good}\n`,
    `https://codeload.github.com/../r/tar.gz/${good}`,
    `https://codeload.github.com/o/../tar.gz/${good}`,
    `https://codeload.github.com/./r/tar.gz/${good}`,
    `https://codeload.github.com/o/./tar.gz/${good}`,
    `https://codeload.github.com/%2e%2e/r/tar.gz/${good}`,
    `https://codeload.github.com/o/r/extra/tar.gz/${good}`,
    `https://codeload.github.com/o/r/zip/${good}`,
    `https://codeload.github.com/o/r/tar.gz/${good.slice(0, 39)}`,
    `https://codeload.github.com/o/r/tar.gz/${good}a`,
    `https://codeload.github.com/o/r/tar.gz/${good.toUpperCase()}`,
    `https://codeload.github.com/o/r/tar.gz/main`,
    '',
  ];
  await withHarness(never, async h => {
    const fetcher = via(h);
    for (const url of rejected) await failsWith(fetcher(url, options()), 'archive_url_rejected', 'permanent');
    assert.equal(h.connects.length, 0);
    assert.equal(h.requests.length, 0);
  });
});

test('호출 계약 거부: 무자격·redirect 거부·유효 상한이 아닌 호출은 보내지 않는다', async () => {
  const signal = new AbortController().signal;
  const bad = [
    { credentials: 'include', redirect: 'error', maxBytes: 10, signal },
    { credentials: 'omit', redirect: 'follow', maxBytes: 10, signal },
    { credentials: 'omit', redirect: 'error', maxBytes: Number.NaN, signal },
    { credentials: 'omit', redirect: 'error', maxBytes: Number.POSITIVE_INFINITY, signal },
    { credentials: 'omit', redirect: 'error', maxBytes: 0, signal },
    { credentials: 'omit', redirect: 'error', maxBytes: -1, signal },
  ] as unknown as Parameters<ReturnType<typeof createArchiveFetcher>>[1][];
  await withHarness(never, async h => {
    const fetcher = via(h);
    for (const init of bad) await failsWith(fetcher(URL_OK, init), 'archive_request_invalid', 'permanent');
    assert.equal(h.connects.length, 0);
  });
});

test('생성 거부: 쓸 수 없는 deadline은 만들 때 터진다', () => {
  for (const deadlineMs of [0, -1, Number.NaN, 1.5]) assert.throws(() => createArchiveFetcher({ env: {}, deadlineMs }), /archive_deadline_invalid/);
  assert.equal(ARCHIVE_DEADLINE_MS, 300_000);
});

test('redirect 거부: 3xx를 따라가지 않고 다른 곳에 연결하지 않는다', async () => {
  for (const status of [301, 302, 303, 307, 308]) {
    await withHarness((_req, res) => { res.writeHead(status, { location: 'https://evil.example.test/steal' }); res.end(); }, async h => {
      await failsWith(via(h)(URL_OK, options()), 'archive_redirect', 'redirect');
      assert.equal(h.requests.length, 1);
      assert.deepEqual(h.connects.map(c => c.target), ['codeload.github.com:443']);
    });
  }
});

test('크기 상한: 정확히 상한까지는 받고 한 바이트 넘으면 실패한다', async () => {
  const body = randomBytes(1024);
  await withHarness((_req, res) => { res.write(body.subarray(0, 512)); res.end(body.subarray(512)); }, async h => {
    const fetcher = via(h);
    assert.equal((await fetcher(URL_OK, options(undefined, 1024))).byteLength, 1024);
    await failsWith(fetcher(URL_OK, options(undefined, 1023)), 'archive_limit', 'too_large');
  });
});

test('크기 상한: 끝없는 스트림을 도중에 끊는다', async () => {
  const chunk = Buffer.alloc(64 * 1024, 1);
  let sent = 0;
  let stopped!: () => void;
  const stoppedByClient = new Promise<void>(resolve => { stopped = resolve; });
  const pump: Handler = (_req, res) => {
    res.on('close', stopped);
    const write = () => {
      while (!res.destroyed) {
        sent += chunk.length;
        if (!res.write(chunk)) { res.once('drain', write); return; }
      }
    };
    write();
  };
  await withHarness(pump, async h => {
    await failsWith(via(h)(URL_OK, options(undefined, 256 * 1024)), 'archive_limit', 'too_large');
    await within(stoppedByClient, 1500, '연결이 끊기지 않았다');
    assert.ok(sent < 64 * 1024 * 1024, `서버가 ${sent}바이트나 보냈다`);
  });
});

test('크기 상한: content-length가 넘으면 본문을 읽기 전에 거부한다', async () => {
  let closedEarly!: () => void;
  const socketClosed = new Promise<void>(resolve => { closedEarly = resolve; });
  await withHarness((_req, res) => {
    res.on('close', closedEarly);
    res.writeHead(200, { 'content-length': '2000' });
    res.write(Buffer.alloc(10)); // 끝내지 않아 본문을 끝까지 읽으려 하면 걸린다
  }, async h => {
    await failsWith(via(h)(URL_OK, options(undefined, 1000)), 'archive_limit', 'too_large');
    await within(socketClosed, 1500, '연결이 끊기지 않았다');
  });
});

test('취소: 이미 취소된 신호면 프록시에도 보내지 않는다', async () => {
  await withHarness(never, async h => {
    await failsWith(via(h)(URL_OK, options(AbortSignal.abort())), 'archive_cancelled', 'cancelled');
    assert.equal(h.connects.length, 0);
  });
});

test('취소: 응답 머리를 기다리는 중', async () => {
  const abort = new AbortController();
  await withHarness(() => abort.abort(), async h => {
    // deadline까지 기다렸다 cancelled로 분류돼도 통과하면 안 되므로 즉시성을 함께 본다.
    await within(failsWith(via(h)(URL_OK, options(abort.signal)), 'archive_cancelled', 'cancelled'), 1500, '취소가 바로 먹지 않았다');
  });
});

test('취소: 본문을 받는 도중이면 연결까지 끊는다', async () => {
  const abort = new AbortController();
  let stopped!: () => void;
  const stoppedByClient = new Promise<void>(resolve => { stopped = resolve; });
  await withHarness((_req, res) => {
    res.on('close', stopped);
    res.write(Buffer.alloc(1024), () => setTimeout(() => abort.abort(), 20));
  }, async h => {
    await within(failsWith(via(h)(URL_OK, options(abort.signal)), 'archive_cancelled', 'cancelled'), 1500, '취소가 바로 먹지 않았다');
    await within(stoppedByClient, 1500, '연결이 끊기지 않았다');
  });
});

test('취소: 프록시가 CONNECT에 답하지 않는 중', async () => {
  const abort = new AbortController();
  await withHarness(never, async h => {
    const running = via(h)(URL_OK, options(abort.signal));
    for (let i = 0; i < 400 && !h.connects.length; i++) await new Promise(resolve => setTimeout(resolve, 5));
    assert.equal(h.connects.length, 1);
    abort.abort();
    await within(failsWith(running, 'archive_cancelled', 'cancelled'), 1500, '취소가 바로 먹지 않았다');
  }, { connect: 'hang' });
});

test('deadline: 응답 머리가 오지 않으면 일시 실패다', async () => {
  await withHarness(never, async h => {
    await failsWith(createArchiveFetcher({ env: h.env, deadlineMs: 100 })(URL_OK, options()), 'archive_deadline', 'transient');
  });
});

test('deadline: 본문이 멈춰도 전체 시간으로 끊는다', async () => {
  let stopped!: () => void;
  const stoppedByClient = new Promise<void>(resolve => { stopped = resolve; });
  await withHarness((_req, res) => { res.on('close', stopped); res.write(Buffer.alloc(1024)); }, async h => {
    await failsWith(createArchiveFetcher({ env: h.env, deadlineMs: 150 })(URL_OK, options()), 'archive_deadline', 'transient');
    await within(stoppedByClient, 1500, '연결이 끊기지 않았다');
  });
});

test('deadline: 프록시 CONNECT가 멈춰도 끊는다', async () => {
  await withHarness(never, async h => {
    await failsWith(createArchiveFetcher({ env: h.env, deadlineMs: 100 })(URL_OK, options()), 'archive_deadline', 'transient');
    assert.equal(h.connects.length, 1);
  }, { connect: 'hang' });
});

test('프록시 없음: env가 없거나 쓸 수 없으면 보내지 않고 실패한다', async () => {
  await withHarness(never, async h => {
    const envs: Record<string, string | undefined>[] = [
      {}, { HTTPS_PROXY: '' }, { HTTPS_PROXY: '   ' }, { HTTPS_PROXY: undefined },
      // 작업자 계약은 대문자만 읽는다(sandbox worker-deployment).
      { https_proxy: h.env.HTTPS_PROXY }, { HTTP_PROXY: h.env.HTTPS_PROXY }, { ALL_PROXY: h.env.HTTPS_PROXY },
      { HTTPS_PROXY: 'not a url' }, { HTTPS_PROXY: h.env.HTTPS_PROXY.replace('http:', 'https:') }, { HTTPS_PROXY: h.env.HTTPS_PROXY.replace('http:', 'socks5:') },
      { HTTPS_PROXY: h.env.HTTPS_PROXY.replace('http://', 'http://user:secret@') }, { HTTPS_PROXY: `${h.env.HTTPS_PROXY}/path` }, { HTTPS_PROXY: `${h.env.HTTPS_PROXY}?x=1` },
    ];
    for (const env of envs) await failsWith(createArchiveFetcher({ env, deadlineMs: 5000 })(URL_OK, options()), 'archive_proxy_unavailable', 'permanent');
    assert.equal(h.connects.length, 0);
    assert.equal(h.requests.length, 0);
  });
});

test('프록시 경유: NO_PROXY에 codeload가 있어도 프록시를 건너뛰지 않는다', async () => {
  await withHarness((_req, res) => res.end('ok'), async h => {
    const fetcher = createArchiveFetcher({ env: { ...h.env, NO_PROXY: 'codeload.github.com,.github.com,*' } });
    assert.equal(Buffer.from(await fetcher(URL_OK, options())).toString(), 'ok');
    assert.deepEqual(h.connects.map(c => c.target), ['codeload.github.com:443']);
  });
});

test('프록시 경유: 프록시가 CONNECT를 거부하면 원서버에 닿지 않고 일시 실패다', async () => {
  await withHarness(never, async h => {
    await failsWith(via(h)(URL_OK, options()), 'archive_network', 'transient');
    assert.equal(h.connects.length, 1);
    assert.equal(h.requests.length, 0);
  }, { connect: 'refuse' });
});

test('프록시 경유: 프록시에 연결하지 못하면 일시 실패다', async () => {
  const closedProxy = createHttpServer();
  const port = await listen(closedProxy);
  await new Promise(resolve => closedProxy.close(resolve));
  await failsWith(createArchiveFetcher({ env: { HTTPS_PROXY: `http://127.0.0.1:${port}` } })(URL_OK, options()), 'archive_network', 'transient');
});

test('응답 분류: 상태 코드마다 일시·영구를 나눈다', async () => {
  const cases: [number, ArchiveFailureReason, ArchiveFetchError['kind']][] = [
    [404, 'archive_not_found', 'permanent'], [410, 'archive_not_found', 'permanent'],
    [400, 'archive_http_rejected', 'permanent'], [401, 'archive_http_rejected', 'permanent'],
    [403, 'archive_http_rejected', 'permanent'], [451, 'archive_http_rejected', 'permanent'],
    [408, 'archive_unavailable', 'transient'], [425, 'archive_unavailable', 'transient'], [429, 'archive_unavailable', 'transient'],
    [500, 'archive_unavailable', 'transient'], [502, 'archive_unavailable', 'transient'], [503, 'archive_unavailable', 'transient'],
    [204, 'archive_bad_response', 'permanent'], [206, 'archive_bad_response', 'permanent'],
  ];
  for (const [status, reason, kind] of cases) {
    await withHarness((_req, res) => { res.writeHead(status); res.end(); }, async h => {
      await failsWith(via(h)(URL_OK, options()), reason, kind);
      assert.equal(h.requests.length, 1, '자체 재시도를 하지 않는다');
    });
  }
});

test('응답 분류: 전송 압축이 걸린 응답은 풀지 않고 거부한다', async () => {
  await withHarness((_req, res) => { res.writeHead(200, { 'content-encoding': 'gzip' }); res.end(Buffer.alloc(10)); }, async h => {
    await failsWith(via(h)(URL_OK, options()), 'archive_bad_response', 'permanent');
  });
});

test('응답 분류: 본문 도중 끊기면 일시 실패고 조각을 돌려주지 않는다', async () => {
  await withHarness((req, res) => { res.write(Buffer.alloc(1024), () => req.socket.destroy()); }, async h => {
    await failsWith(via(h)(URL_OK, options()), 'archive_network', 'transient');
  });
});

test('응답 분류: content-length보다 짧게 끝나면 일시 실패다', async () => {
  await withHarness((req, res) => {
    res.writeHead(200, { 'content-length': '2000' });
    res.write(Buffer.alloc(10), () => req.socket.destroy());
  }, async h => {
    await failsWith(via(h)(URL_OK, options()), 'archive_network', 'transient');
  });
});

test('TLS: 터널 안에서도 인증서를 검증한다', async () => {
  for (const tls of [UNTRUSTED, WRONG_NAME]) {
    await withHarness((_req, res) => res.end('secret'), async h => {
      await failsWith(via(h)(URL_OK, options()), 'archive_network', 'transient');
      assert.equal(h.connects.length, 1);
      assert.equal(h.requests.length, 0);
    }, { tls });
  }
});
