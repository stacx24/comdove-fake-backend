import http from 'node:http';
import type { AddressInfo } from 'node:net';

type Listener = http.RequestListener;

/** Start an express app (or any request listener) on a random port. */
export async function listen(handler: Listener) {
  const server = http.createServer(handler);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return {
    base,
    server,
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
}

export interface Received {
  method: string;
  url: string;
  headers: http.IncomingHttpHeaders;
  raw: Buffer;
  at: number;
}

/**
 * A scriptable webhook receiver. `respond` decides each reply; return a status, or
 * 'hang' to never answer (tests the timeout).
 */
export async function receiver(respond: (r: Received, n: number) => number | 'hang' | { status: number; body: string } = () => 200) {
  const received: Received[] = [];
  const srv = await listen((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => {
      const r: Received = { method: req.method ?? '', url: req.url ?? '', headers: req.headers, raw: Buffer.concat(chunks), at: Date.now() };
      received.push(r);
      const out = respond(r, received.length);
      if (out === 'hang') return;
      if (typeof out === 'number') {
        res.statusCode = out;
        res.end();
      } else {
        res.statusCode = out.status;
        res.setHeader('content-type', 'text/plain');
        res.end(out.body);
      }
    });
  });
  return { ...srv, received, url: `${srv.base}/webhooks/whatsapp` };
}

/** A port with nothing listening on it (for connection-refused tests). */
export async function deadUrl() {
  const srv = await listen(() => {});
  const url = `${srv.base}/webhooks/whatsapp`;
  await srv.close();
  return url;
}

export async function waitFor(cond: () => boolean, timeoutMs = 2000, stepMs = 5) {
  const start = Date.now();
  while (!cond()) {
    if (Date.now() - start > timeoutMs) throw new Error('waitFor: timed out');
    await new Promise((r) => setTimeout(r, stepMs));
  }
}
