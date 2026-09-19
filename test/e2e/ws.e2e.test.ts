// End-to-end: boots the real app (src/index.ts) as a child process on a free port and
// drives /ws with real WebSocket clients, like browsers would.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createServer, type AddressInfo } from 'node:net';
import { once } from 'node:events';
import { WebSocket, type ClientOptions } from 'ws';
import { DEV_GROUPS } from '../../src/dev/dev-groups.js';

type Frame = Record<string, unknown>;

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function waitFor(check: () => boolean, timeoutMs: number, what: () => string) {
  const end = Date.now() + timeoutMs;
  while (!check()) {
    if (Date.now() > end) throw new Error(`timed out waiting for ${what()}`);
    await sleep(10);
  }
}

async function freePort(): Promise<number> {
  const srv = createServer();
  srv.listen(0, '127.0.0.1');
  await once(srv, 'listening');
  const { port } = srv.address() as AddressInfo;
  await new Promise((resolve) => srv.close(resolve));
  return port;
}

async function startApp(env: Record<string, string> = {}) {
  const port = await freePort();
  const child = spawn(process.execPath, ['--import', 'tsx', 'src/index.ts'], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      PORT: String(port),
      // isolate from the developer's setup: throwaway DB, and no real Comdove to call
      DB_PATH: ':memory:',
      COMDOVE_WEBHOOK_URL: 'http://127.0.0.1:9/webhooks/whatsapp',
      ...env,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let output = '';
  child.stdout.on('data', (d) => (output += d));
  child.stderr.on('data', (d) => (output += d));
  await waitFor(() => output.includes('WebSocket on') || child.exitCode !== null, 15000, () => `app start:\n${output}`);
  if (child.exitCode !== null) throw new Error(`app exited early:\n${output}`);

  // Groups live in P2's store now: seed the two groups the tests expect.
  const post = async (path: string, body: unknown) => {
    const res = await fetch(`http://127.0.0.1:${port}${path}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    if (res.status !== 200) throw new Error(`${path} → ${res.status} ${await res.text()}`);
  };
  await post('/api/business-numbers', { display_number: '918888800001', label: 'Sales' });
  await post('/api/groups', { name: 'Alpha', numbers: DEV_GROUPS.alpha?.tiles });
  await post('/api/groups', { name: 'Beta', numbers: DEV_GROUPS.beta?.tiles });
  return {
    http: `http://127.0.0.1:${port}`,
    ws: `ws://127.0.0.1:${port}/ws`,
    output: () => output,
    async stop() {
      if (child.exitCode === null) {
        child.kill('SIGTERM');
        await once(child, 'exit');
      }
    },
  };
}

async function connect(url: string, opts: ClientOptions = {}) {
  const socket = new WebSocket(url, opts);
  const inbox: Frame[] = [];
  const waiters: Array<(f: Frame) => void> = [];
  socket.on('message', (data) => {
    const frame = JSON.parse(String(data)) as Frame;
    const waiter = waiters.shift();
    if (waiter) waiter(frame);
    else inbox.push(frame);
  });
  const closed = new Promise<number>((resolve) => socket.on('close', (code) => resolve(code)));
  await once(socket, 'open');
  return {
    socket,
    closed,
    send(frame: unknown, binary = false) {
      if (binary) socket.send(Buffer.from(JSON.stringify(frame)), { binary: true });
      else socket.send(typeof frame === 'string' ? frame : JSON.stringify(frame));
    },
    next(timeoutMs = 2000): Promise<Frame> {
      const frame = inbox.shift();
      if (frame) return Promise.resolve(frame);
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('no frame received')), timeoutMs);
        waiters.push((f) => {
          clearTimeout(timer);
          resolve(f);
        });
      });
    },
  };
}

/** Claim `group` with a fresh client, retrying while the server releases an old lock. */
async function claimEventually(url: string, group: string, timeoutMs = 3000) {
  const end = Date.now() + timeoutMs;
  for (;;) {
    const c = await connect(url);
    c.send({ type: 'group.claim', group });
    const frame = await c.next();
    if (frame.type === 'group.claimed') return c;
    c.socket.close();
    if (Date.now() > end) throw new Error(`group ${group} still locked: ${JSON.stringify(frame)}`);
    await sleep(20);
  }
}

const E2E = { timeout: 20000 };

test('E2E-1 app boots: /health answers and only /ws upgrades', E2E, async () => {
  const app = await startApp();
  try {
    const res = await fetch(`${app.http}/health`);
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), { status: 'ok', service: 'comdove-fake-backend' });

    const wrong = new WebSocket(app.ws.replace('/ws', '/nope'));
    const [err] = (await once(wrong, 'error')) as [Error];
    assert.match(err.message, /400/);
  } finally {
    await app.stop();
  }
});

test('E2E-2 lock lifecycle across three browsers', E2E, async () => {
  const app = await startApp();
  try {
    const a = await connect(app.ws);
    a.send({ type: 'group.claim', group: 'alpha' });
    const snap = await a.next();
    assert.equal(snap.type, 'group.claimed');
    assert.deepEqual(snap.group, { id: 'alpha', name: 'Alpha' });
    const tiles = snap.tiles as Array<Frame>;
    assert.deepEqual(tiles.map((t) => t.number), DEV_GROUPS.alpha?.tiles);
    assert.ok(tiles.every((t) => t.online === true));

    const b = await connect(app.ws);
    b.send({ type: 'group.claim', group: 'alpha' });
    const locked = await b.next();
    assert.equal(locked.type, 'group.locked');
    assert.equal(locked.group, 'alpha');
    assert.ok(typeof locked.since === 'number' && locked.since <= Date.now());

    // the refused browser picks another group on the same socket
    b.send({ type: 'group.claim', group: 'beta' });
    assert.equal((await b.next()).type, 'group.claimed');

    // A leaves → a third browser gets alpha
    a.socket.close();
    await claimEventually(app.ws, 'alpha');
  } finally {
    await app.stop();
  }
});

test('E2E-3 admin feed role is fixed and cannot act on tiles', E2E, async () => {
  const app = await startApp();
  try {
    const admin = await connect(app.ws);
    admin.send({ type: 'admin.subscribe' });
    assert.equal((await admin.next()).type, 'groups.update');
    assert.equal((await admin.next()).type, 'numbers.update');
    admin.send({ type: 'group.claim', group: 'alpha' });
    assert.equal((await admin.next()).code, 'already_claimed');
    admin.send({ type: 'tile.presence', number: '919876543210', online: false });
    assert.equal((await admin.next()).code, 'not_claimed');
    // the admin did not take the lock
    await claimEventually(app.ws, 'alpha', 500);
  } finally {
    await app.stop();
  }
});

test('E2E-4 every bad frame gets a typed error and the socket stays usable', E2E, async () => {
  const app = await startApp();
  try {
    const c = await connect(app.ws);
    const cases: Array<[unknown, string, boolean?]> = [
      ['not json', 'bad_json'],
      [{ type: 'group.claim', group: 'alpha' }, 'bad_json', true], // binary frame
      [{ type: 'nope' }, 'unknown_type'],
      [{ type: 'tile.presence', number: '919876543210', online: 'yes' }, 'bad_request'],
      [{ type: 'message.send', from: '919876543210', to: '918888800001', body: 'hi' }, 'not_claimed'],
      [{ type: 'group.claim', group: 'gamma' }, 'unknown_group'],
    ];
    for (const [frame, code, binary] of cases) {
      c.send(frame, binary);
      const reply = await c.next();
      assert.equal(reply.type, 'error', JSON.stringify(frame));
      assert.equal(reply.code, code, JSON.stringify(frame));
    }
    assert.equal(c.socket.readyState, WebSocket.OPEN);
    c.send({ type: 'group.claim', group: 'alpha' });
    assert.equal((await c.next()).type, 'group.claimed');
  } finally {
    await app.stop();
  }
});

test('E2E-5 a frame over 64 KiB closes the socket (1009) and frees its group', E2E, async () => {
  const app = await startApp();
  try {
    const c = await connect(app.ws);
    c.send({ type: 'group.claim', group: 'alpha' });
    await c.next();
    c.send('x'.repeat(70_000));
    assert.equal(await c.closed, 1009);
    await claimEventually(app.ws, 'alpha');
  } finally {
    await app.stop();
  }
});

test('E2E-6 a browser that vanishes without a close frame frees its group', E2E, async () => {
  const app = await startApp();
  try {
    const c = await connect(app.ws);
    c.send({ type: 'group.claim', group: 'alpha' });
    await c.next();
    c.socket.terminate(); // like a killed tab: TCP drops, no WebSocket close frame
    await claimEventually(app.ws, 'alpha');
  } finally {
    await app.stop();
  }
});

test('E2E-7 heartbeat drops a frozen client and keeps a healthy one', E2E, async () => {
  const app = await startApp({ WS_HEARTBEAT_MS: '100' });
  try {
    const frozen = await connect(app.ws, { autoPong: false }); // TCP alive, never answers pings
    const healthy = await connect(app.ws);
    frozen.send({ type: 'group.claim', group: 'alpha' });
    assert.equal((await frozen.next()).type, 'group.claimed');
    healthy.send({ type: 'group.claim', group: 'beta' });
    assert.equal((await healthy.next()).type, 'group.claimed');

    const started = Date.now();
    await frozen.closed;
    const droppedAfter = Date.now() - started;
    assert.ok(droppedAfter <= 1000, `dropped after ${droppedAfter} ms`);

    await claimEventually(app.ws, 'alpha');
    await sleep(500); // 5 more heartbeat ticks
    assert.equal(healthy.socket.readyState, WebSocket.OPEN);
  } finally {
    await app.stop();
  }
});

test('E2E-8 ten browsers race for one group: exactly one wins', E2E, async () => {
  const app = await startApp();
  try {
    const clients = await Promise.all(Array.from({ length: 10 }, () => connect(app.ws)));
    for (const c of clients) c.send({ type: 'group.claim', group: 'alpha' });
    const replies = await Promise.all(clients.map((c) => c.next()));
    const types = replies.map((r) => r.type);
    assert.equal(types.filter((t) => t === 'group.claimed').length, 1);
    assert.equal(types.filter((t) => t === 'group.locked').length, 9);
  } finally {
    await app.stop();
  }
});
