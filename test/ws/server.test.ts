import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import type { AddressInfo } from 'node:net';
import { WebSocket, type ClientOptions } from 'ws';
import { createLockTable } from '../../src/ws/lock.js';
import { attachWsServer } from '../../src/ws/server.js';
import { createMemoryGroups, DEV_GROUPS } from '../../src/dev/dev-groups.js';

type Frame = Record<string, unknown>;

async function start(heartbeatMs?: number) {
  const http = createServer();
  const lock = createLockTable();
  const ws = attachWsServer(http, {
    lock,
    groups: createMemoryGroups(DEV_GROUPS),
    ...(heartbeatMs !== undefined && { heartbeatMs }),
  });
  http.listen(0, '127.0.0.1');
  await once(http, 'listening');
  const { port } = http.address() as AddressInfo;
  return {
    url: `ws://127.0.0.1:${port}/ws`,
    lock,
    ws,
    async stop() {
      await ws.close();
      await new Promise<void>((resolve) => http.close(() => resolve()));
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
  await once(socket, 'open');
  return {
    socket,
    send(frame: unknown) {
      socket.send(typeof frame === 'string' ? frame : JSON.stringify(frame));
    },
    next(): Promise<Frame> {
      const frame = inbox.shift();
      if (frame) return Promise.resolve(frame);
      return new Promise((resolve) => waiters.push(resolve));
    },
  };
}

async function waitFor(check: () => boolean, timeoutMs = 1000) {
  const end = Date.now() + timeoutMs;
  while (!check()) {
    if (Date.now() > end) throw new Error('waitFor timed out');
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

test('a bad frame gets an error and the socket stays open', async () => {
  const srv = await start();
  try {
    const c = await connect(srv.url);
    c.send('not json');
    assert.deepEqual(await c.next(), { type: 'error', code: 'bad_json', message: 'frame is not valid JSON' });
    c.send({ type: 'group.claim', group: 'alpha' });
    assert.equal((await c.next()).type, 'group.claimed');
  } finally {
    await srv.stop();
  }
});

test('the second client on a claimed group gets group.locked', async () => {
  const srv = await start();
  try {
    const a = await connect(srv.url);
    const b = await connect(srv.url);
    a.send({ type: 'group.claim', group: 'alpha' });
    assert.equal((await a.next()).type, 'group.claimed');
    b.send({ type: 'group.claim', group: 'alpha' });
    const locked = await b.next();
    assert.equal(locked.type, 'group.locked');
    assert.equal(locked.group, 'alpha');
    assert.equal(typeof locked.since, 'number');
  } finally {
    await srv.stop();
  }
});

test('closing the holder frees the group for the next client', async () => {
  const srv = await start();
  try {
    const a = await connect(srv.url);
    const b = await connect(srv.url);
    a.send({ type: 'group.claim', group: 'alpha' });
    await a.next();
    a.socket.close();
    await waitFor(() => !srv.lock.isLocked('alpha'));
    b.send({ type: 'group.claim', group: 'alpha' });
    assert.equal((await b.next()).type, 'group.claimed');
  } finally {
    await srv.stop();
  }
});

test('a client that stops answering pings is dropped and its lock freed', async () => {
  const srv = await start(50);
  try {
    const dead = await connect(srv.url, { autoPong: false });
    const live = await connect(srv.url);
    dead.send({ type: 'group.claim', group: 'alpha' });
    assert.equal((await dead.next()).type, 'group.claimed');
    await waitFor(() => !srv.lock.isLocked('alpha'), 1000);
    await waitFor(() => dead.socket.readyState === WebSocket.CLOSED, 1000);
    await new Promise((resolve) => setTimeout(resolve, 200)); // several heartbeat ticks
    assert.equal(live.socket.readyState, WebSocket.OPEN);
    live.send({ type: 'group.claim', group: 'alpha' });
    assert.equal((await live.next()).type, 'group.claimed');
  } finally {
    await srv.stop();
  }
});

test('close() drops every client and reports zero sessions', async () => {
  const srv = await start();
  await connect(srv.url);
  await connect(srv.url);
  assert.equal(srv.ws.sessionCount(), 2);
  await srv.stop();
  assert.equal(srv.ws.sessionCount(), 0);
});
