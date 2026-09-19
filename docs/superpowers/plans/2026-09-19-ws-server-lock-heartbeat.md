# WebSocket Server, Session Lock and Heartbeat Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Stand up `ws://localhost:4020/ws` with typed errors, socket roles, `group.claim` end to end, a one-session-per-group in-memory lock and a 15 s heartbeat, with no code from Person 1 or Person 2.

**Architecture:** Three small modules in `src/ws/`, each built by a `createX(deps)` factory:
- `lock.ts`: an in-memory lock table.
- `session.ts`: one socket's role and the claim flow, reading group data through a `GroupDirectory` port.
- `server.ts`: the `ws` server, frame parsing and the heartbeat.

`src/dev/dev-groups.ts` is an in-memory `GroupDirectory` used by tests and `npm run dev` until Person 2's store is plugged in.

**Tech Stack:** TypeScript (strict, NodeNext, CommonJS output), Node 24, `ws` 8.21 (already installed), `node:test` through `tsx`.

**Spec:** `docs/superpowers/specs/2026-09-19-ws-server-lock-heartbeat-design.md`

## Global Constraints

- No new dependencies. Tests use `node:test` + `node:assert/strict`; run with `npm test`.
- Never import Person 1 or Person 2 code; everything outside `src/ws/` comes in through parameters.
- The lock lives in memory only (a `Map`), empty on boot, never in SQLite.
- Only the lock owner can release a lock.
- A socket's role is set once (`group` or `admin`) and never changes.
- Heartbeat default is 15000 ms and uses WebSocket protocol ping/pong. A client with no pong since the last tick is terminated.
- `maxPayload` = 65536 bytes; binary frames → `error bad_json`.
- Every outgoing frame goes through `encodeEvent` from `src/contract/ws-events.ts`.
- Relative imports use the `.js` extension.
- Commit messages end with `Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>`.

## File map

| File | Action | Responsibility |
|---|---|---|
| `src/ws/lock.ts` | Create | `createLockTable()`: claim / release / isLocked / lockedSince, `onChange` hook |
| `src/ws/session.ts` | Create | `GroupDirectory` port, `createSession()`: roles, claim flow, release on close |
| `src/dev/dev-groups.ts` | Create | `createMemoryGroups()`, `DEV_GROUPS` |
| `src/ws/server.ts` | Create | `attachWsServer()`: `/ws`, frame parsing, heartbeat, shutdown |
| `src/index.ts` | Modify | Attach the socket server to the HTTP server |
| `test/ws/lock.test.ts` | Create | 6 unit tests |
| `test/ws/session.test.ts` | Create | 8 unit tests |
| `test/ws/server.test.ts` | Create | 5 integration tests |

---

### Task 1: In-memory lock table

**Files:**
- Create: `src/ws/lock.ts`
- Test: `test/ws/lock.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces:
  - `type ClaimResult = { ok: true; since: number } | { ok: false; since: number }`
  - `interface LockTable { claim(groupId: string, owner: object): ClaimResult; release(groupId: string, owner: object): boolean; isLocked(groupId: string): boolean; lockedSince(groupId: string): number | null }`
  - `function createLockTable(opts?: { now?: () => number; onChange?: (groupId: string) => void }): LockTable`

- [ ] **Step 1: Write the failing test**

Create `test/ws/lock.test.ts`:

```ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createLockTable } from '../../src/ws/lock.js';

function setup() {
  let time = 1000;
  const changes: string[] = [];
  const lock = createLockTable({ now: () => time, onChange: (g) => changes.push(g) });
  return { lock, changes, advance: (ms: number) => (time += ms) };
}

const OWNER_A = {};
const OWNER_B = {};

test('claiming a free group takes the lock', () => {
  const { lock } = setup();
  assert.deepEqual(lock.claim('alpha', OWNER_A), { ok: true, since: 1000 });
  assert.equal(lock.isLocked('alpha'), true);
  assert.equal(lock.lockedSince('alpha'), 1000);
  assert.equal(lock.isLocked('beta'), false);
  assert.equal(lock.lockedSince('beta'), null);
});

test('a second owner is refused and gets the holder since', () => {
  const { lock, advance } = setup();
  lock.claim('alpha', OWNER_A);
  advance(500);
  assert.deepEqual(lock.claim('alpha', OWNER_B), { ok: false, since: 1000 });
  assert.equal(lock.lockedSince('alpha'), 1000);
  // A still owns it: B cannot release, A can
  assert.equal(lock.release('alpha', OWNER_B), false);
  assert.equal(lock.release('alpha', OWNER_A), true);
});

test('the same owner claiming again is refused and changes nothing', () => {
  const { lock, advance } = setup();
  lock.claim('alpha', OWNER_A);
  advance(500);
  assert.deepEqual(lock.claim('alpha', OWNER_A), { ok: false, since: 1000 });
  assert.equal(lock.lockedSince('alpha'), 1000);
});

test('release by a non-owner or on a free group does nothing', () => {
  const { lock } = setup();
  assert.equal(lock.release('alpha', OWNER_A), false);
  lock.claim('alpha', OWNER_A);
  assert.equal(lock.release('alpha', OWNER_B), false);
  assert.equal(lock.isLocked('alpha'), true);
});

test('release by the owner frees the group for someone else', () => {
  const { lock, advance } = setup();
  lock.claim('alpha', OWNER_A);
  assert.equal(lock.release('alpha', OWNER_A), true);
  assert.equal(lock.isLocked('alpha'), false);
  assert.equal(lock.lockedSince('alpha'), null);
  advance(2000);
  assert.deepEqual(lock.claim('alpha', OWNER_B), { ok: true, since: 3000 });
});

test('onChange fires once per real change only', () => {
  const { lock, changes } = setup();
  lock.claim('alpha', OWNER_A); // change
  lock.claim('alpha', OWNER_B); // refused
  lock.release('alpha', OWNER_B); // refused
  lock.claim('beta', OWNER_B); // change
  lock.release('alpha', OWNER_A); // change
  lock.release('alpha', OWNER_A); // already free
  assert.deepEqual(changes, ['alpha', 'beta', 'alpha']);
});
```

- [ ] **Step 2: Run the test to check that it fails**

Run: `npm test`
Expected: FAIL. `test/ws/lock.test.ts` reports `Cannot find module '../../src/ws/lock.js'` (`MODULE_NOT_FOUND`). The 28 contract tests still pass.

- [ ] **Step 3: Create `src/ws/lock.ts`**

```ts
// One active session per group (FR-16). In memory only, empty on boot, so a crash
// can never wedge a group. Only the owner can release its lock.

export type ClaimResult = { ok: true; since: number } | { ok: false; since: number };

export interface LockTable {
  /** Free → take it. Held (by anyone, including `owner`) → refused with the holder's since. */
  claim(groupId: string, owner: object): ClaimResult;
  /** Only the owner can release. Returns true if the lock was released. */
  release(groupId: string, owner: object): boolean;
  isLocked(groupId: string): boolean;
  lockedSince(groupId: string): number | null;
}

export function createLockTable(
  opts: { now?: () => number; onChange?: (groupId: string) => void } = {},
): LockTable {
  const now = opts.now ?? Date.now;
  const onChange = opts.onChange ?? (() => {});
  const locks = new Map<string, { owner: object; since: number }>();

  return {
    claim(groupId, owner) {
      const held = locks.get(groupId);
      if (held) return { ok: false, since: held.since };
      const since = now();
      locks.set(groupId, { owner, since });
      onChange(groupId);
      return { ok: true, since };
    },

    release(groupId, owner) {
      const held = locks.get(groupId);
      if (!held || held.owner !== owner) return false;
      locks.delete(groupId);
      onChange(groupId);
      return true;
    },

    isLocked: (groupId) => locks.has(groupId),
    lockedSince: (groupId) => locks.get(groupId)?.since ?? null,
  };
}
```

- [ ] **Step 4: Run the tests to check that they pass**

Run: `npm test`
Expected: PASS, 34 tests (28 contract + 6 lock), 0 failures.

- [ ] **Step 5: Run the type check**

Run: `npm run build`
Expected: exits 0 with no errors.

- [ ] **Step 6: Commit**

```bash
git add src/ws/lock.ts test/ws/lock.test.ts
git commit -m "feat(ws): in-memory one-session-per-group lock table

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
```

---

### Task 2: Session roles, claim flow and in-memory groups

**Files:**
- Create: `src/ws/session.ts`
- Create: `src/dev/dev-groups.ts`
- Test: `test/ws/session.test.ts`

**Interfaces:**
- Consumes (Task 1, `src/ws/lock.ts`): `LockTable`, `createLockTable`.
- Consumes (contract, `src/contract/ws-events.ts`): `encodeEvent`, `ClientEvent`, `ServerEvent`, `AdminEvent`, `Snapshot`, `WsErrorCode`.
- Produces (`src/ws/session.ts`):
  - `interface GroupDirectory { exists(groupId: string): boolean; snapshot(groupId: string): Snapshot }`
  - `type GroupEvent = Exclude<ClientEvent, { type: 'group.claim' | 'admin.subscribe' }>`
  - `interface SessionDeps { lock: LockTable; groups: GroupDirectory; onGroupEvent?: (session: Session, ev: GroupEvent) => void }`
  - `type Role = { kind: 'none' } | { kind: 'group'; groupId: string } | { kind: 'admin' }`
  - `interface SessionSocket { send(data: string): void; readonly readyState: number }`
  - `interface Session { readonly role: Role; send(ev: ServerEvent | AdminEvent): void; handle(ev: ClientEvent): void; close(): void }`
  - `function createSession(socket: SessionSocket, deps: SessionDeps): Session`
- Produces (`src/dev/dev-groups.ts`):
  - `interface MemoryGroup { name: string; tiles?: string[] }`
  - `function createMemoryGroups(groups: Record<string, MemoryGroup>): GroupDirectory`
  - `const DEV_GROUPS: Record<string, MemoryGroup>` with keys `alpha` and `beta`

- [ ] **Step 1: Write the failing test**

Create `test/ws/session.test.ts`:

```ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createLockTable } from '../../src/ws/lock.js';
import { createSession, type GroupEvent, type Session, type SessionDeps } from '../../src/ws/session.js';
import { createMemoryGroups, DEV_GROUPS } from '../../src/dev/dev-groups.js';

type Frame = Record<string, unknown>;

function fakeSocket() {
  const sent: Frame[] = [];
  return {
    sent,
    readyState: 1, // OPEN
    send(data: string) {
      sent.push(JSON.parse(data) as Frame);
    },
  };
}

function setup(extra: Partial<SessionDeps> = {}) {
  const groups = createMemoryGroups(DEV_GROUPS);
  const lock = createLockTable({ now: () => 1000 });
  const deps: SessionDeps = { lock, groups, ...extra };
  const open = () => {
    const socket = fakeSocket();
    return { socket, session: createSession(socket, deps) };
  };
  return { groups, lock, open };
}

const GROUP_EVENTS: GroupEvent[] = [
  { type: 'message.send', from: '919876543210', to: '918888800001', body: 'hi' },
  { type: 'tile.presence', number: '919876543210', online: false },
  { type: 'chat.read', number: '919876543210', peer: '918888800001' },
  { type: 'tile.autoreply', number: '919876543210', mode: 'echo', delay_ms: 0, rules: [] },
];

test('claiming a known free group sends the snapshot and sets the role', () => {
  const { open, groups, lock } = setup();
  const { socket, session } = open();
  session.handle({ type: 'group.claim', group: 'alpha' });
  assert.deepEqual(socket.sent, [{ type: 'group.claimed', ...groups.snapshot('alpha') }]);
  assert.deepEqual(session.role, { kind: 'group', groupId: 'alpha' });
  assert.equal(lock.isLocked('alpha'), true);
});

test('claiming an unknown group is an error and keeps role none', () => {
  const { open, lock } = setup();
  const { socket, session } = open();
  session.handle({ type: 'group.claim', group: 'nope' });
  assert.deepEqual(socket.sent, [{ type: 'error', code: 'unknown_group', message: 'unknown group: nope' }]);
  assert.deepEqual(session.role, { kind: 'none' });
  assert.equal(lock.isLocked('nope'), false);
});

test('claiming a held group sends group.locked and keeps role none', () => {
  const { open } = setup();
  const first = open();
  const second = open();
  first.session.handle({ type: 'group.claim', group: 'alpha' });
  second.session.handle({ type: 'group.claim', group: 'alpha' });
  assert.deepEqual(second.socket.sent, [{ type: 'group.locked', group: 'alpha', since: 1000 }]);
  assert.deepEqual(second.session.role, { kind: 'none' });
  // the refused socket may still claim another group
  second.session.handle({ type: 'group.claim', group: 'beta' });
  assert.equal(second.socket.sent[1]?.type, 'group.claimed');
});

test('a second claim on a group socket is already_claimed', () => {
  const { open, lock } = setup();
  const { socket, session } = open();
  session.handle({ type: 'group.claim', group: 'alpha' });
  session.handle({ type: 'group.claim', group: 'beta' });
  assert.equal(socket.sent[1]?.type, 'error');
  assert.equal(socket.sent[1]?.code, 'already_claimed');
  assert.equal(lock.isLocked('beta'), false);
  assert.deepEqual(session.role, { kind: 'group', groupId: 'alpha' });
});

test('admin.subscribe sets the admin role, and the role is then fixed', () => {
  const { open } = setup();
  const { socket, session } = open();
  session.handle({ type: 'admin.subscribe' });
  assert.deepEqual(session.role, { kind: 'admin' });
  assert.deepEqual(socket.sent, []);
  session.handle({ type: 'group.claim', group: 'alpha' });
  session.handle({ type: 'admin.subscribe' });
  assert.deepEqual(
    socket.sent.map((f) => f.code),
    ['already_claimed', 'already_claimed'],
  );
  assert.deepEqual(session.role, { kind: 'admin' });
});

test('group events before a claim or on an admin socket are not_claimed', () => {
  const { open } = setup();
  const none = open();
  const admin = open();
  admin.session.handle({ type: 'admin.subscribe' });
  for (const ev of GROUP_EVENTS) {
    none.session.handle(ev);
    admin.session.handle(ev);
  }
  assert.deepEqual(none.socket.sent.map((f) => f.code), ['not_claimed', 'not_claimed', 'not_claimed', 'not_claimed']);
  assert.deepEqual(admin.socket.sent.map((f) => f.code), ['not_claimed', 'not_claimed', 'not_claimed', 'not_claimed']);
});

test('group events on a group socket reach onGroupEvent', () => {
  const received: Array<{ session: Session; ev: GroupEvent }> = [];
  const { open } = setup({ onGroupEvent: (session, ev) => received.push({ session, ev }) });
  const { socket, session } = open();
  session.handle({ type: 'group.claim', group: 'alpha' });
  for (const ev of GROUP_EVENTS) session.handle(ev);
  assert.equal(received.length, 4);
  assert.equal(received[0]?.session, session);
  assert.deepEqual(received.map((r) => r.ev), GROUP_EVENTS);
  assert.equal(socket.sent.length, 1); // only group.claimed, no errors
});

test('close releases the lock once, and never a newer owner lock', () => {
  const { open, lock } = setup();
  const first = open();
  first.session.handle({ type: 'group.claim', group: 'alpha' });
  first.session.close();
  assert.equal(lock.isLocked('alpha'), false);
  const second = open();
  second.session.handle({ type: 'group.claim', group: 'alpha' });
  first.session.close(); // late duplicate close must not free second's lock
  assert.equal(lock.isLocked('alpha'), true);
  // a session never sends on a socket that is not open
  const closedSocket = { ...fakeSocket(), readyState: 3 };
  const s = createSession(closedSocket, { lock, groups: createMemoryGroups(DEV_GROUPS) });
  s.handle({ type: 'group.claim', group: 'nope' });
  assert.deepEqual(closedSocket.sent, []);
});
```

- [ ] **Step 2: Run the test to check that it fails**

Run: `npm test`
Expected: FAIL. `test/ws/session.test.ts` reports `Cannot find module '../../src/ws/session.js'`. The other 34 tests pass.

- [ ] **Step 3: Create `src/ws/session.ts`**

```ts
// One WebSocket connection's state: its role (group session or admin feed) and the
// group.claim flow (plan §11a, FR-16). Group data comes through the GroupDirectory
// port, so this file never imports Person 2 code.

import {
  encodeEvent,
  type AdminEvent,
  type ClientEvent,
  type ServerEvent,
  type Snapshot,
  type WsErrorCode,
} from '../contract/ws-events.js';
import type { LockTable } from './lock.js';

export interface GroupDirectory {
  exists(groupId: string): boolean;
  /** Everything the grid needs to render (contract Snapshot). */
  snapshot(groupId: string): Snapshot;
}

/** The client events that need a claimed group. */
export type GroupEvent = Exclude<ClientEvent, { type: 'group.claim' | 'admin.subscribe' }>;

export interface SessionDeps {
  lock: LockTable;
  groups: GroupDirectory;
  /** Handlers for the 4 group events (later step). Default: ignore. */
  onGroupEvent?: (session: Session, ev: GroupEvent) => void;
}

export type Role = { kind: 'none' } | { kind: 'group'; groupId: string } | { kind: 'admin' };

export interface SessionSocket {
  send(data: string): void;
  readonly readyState: number;
}

export interface Session {
  readonly role: Role;
  send(ev: ServerEvent | AdminEvent): void;
  handle(ev: ClientEvent): void;
  /** Socket closed: release the lock if this session holds one. Safe to call twice. */
  close(): void;
}

const OPEN = 1; // WebSocket.OPEN

export function createSession(socket: SessionSocket, deps: SessionDeps): Session {
  let role: Role = { kind: 'none' };
  let closed = false;

  const session: Session = {
    get role() {
      return role;
    },

    send(ev) {
      if (socket.readyState === OPEN) socket.send(encodeEvent(ev));
    },

    handle(ev) {
      switch (ev.type) {
        case 'group.claim':
          return claim(ev.group);
        case 'admin.subscribe':
          if (role.kind !== 'none') return error('already_claimed', 'this socket already has a role');
          role = { kind: 'admin' };
          return;
        default:
          if (role.kind !== 'group') return error('not_claimed', 'claim a group first');
          deps.onGroupEvent?.(session, ev);
      }
    },

    close() {
      if (closed) return;
      closed = true;
      if (role.kind === 'group') deps.lock.release(role.groupId, session);
    },
  };

  function error(code: WsErrorCode, message: string): void {
    session.send({ type: 'error', code, message });
  }

  function claim(groupId: string): void {
    if (role.kind !== 'none') return error('already_claimed', 'this socket already has a role');
    if (!deps.groups.exists(groupId)) return error('unknown_group', `unknown group: ${groupId}`);
    const result = deps.lock.claim(groupId, session);
    if (!result.ok) {
      session.send({ type: 'group.locked', group: groupId, since: result.since });
      return;
    }
    role = { kind: 'group', groupId };
    session.send({ type: 'group.claimed', ...deps.groups.snapshot(groupId) });
  }

  return session;
}
```

- [ ] **Step 4: Create `src/dev/dev-groups.ts`**

```ts
// In-memory GroupDirectory for tests and `npm run dev` until Person 2's store is
// plugged in at checkpoint ①. Every tile starts online with an empty history.

import type { Snapshot } from '../contract/ws-events.js';
import type { GroupDirectory } from '../ws/session.js';

export interface MemoryGroup {
  name: string;
  tiles?: string[];
}

export const DEV_GROUPS: Record<string, MemoryGroup> = {
  alpha: { name: 'Alpha', tiles: ['919876543210', '919876543211'] },
  beta: { name: 'Beta', tiles: ['919876543220'] },
};

export function createMemoryGroups(groups: Record<string, MemoryGroup>): GroupDirectory {
  return {
    exists: (groupId) => Object.hasOwn(groups, groupId),

    snapshot(groupId): Snapshot {
      const group = groups[groupId];
      if (!group || !Object.hasOwn(groups, groupId)) throw new Error(`unknown group: ${groupId}`);
      return {
        group: { id: groupId, name: group.name },
        business_numbers: [],
        tiles: (group.tiles ?? []).map((number) => ({
          number,
          label: null,
          online: true,
          auto_reply: { mode: 'manual', delay_ms: 0, rules: [] },
          history: [],
          queued: [],
          unread: {},
        })),
      };
    },
  };
}
```

- [ ] **Step 5: Run the tests to check that they pass**

Run: `npm test`
Expected: PASS, 42 tests (28 contract + 6 lock + 8 session), 0 failures.

- [ ] **Step 6: Run the type check**

Run: `npm run build`
Expected: exits 0 with no errors.

- [ ] **Step 7: Commit**

```bash
git add src/ws/session.ts src/dev/dev-groups.ts test/ws/session.test.ts
git commit -m "feat(ws): socket roles, group.claim flow and in-memory dev groups

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
```

---

### Task 3: Socket server, heartbeat and wiring

**Files:**
- Create: `src/ws/server.ts`
- Modify: `src/index.ts` (the whole file, shown below)
- Test: `test/ws/server.test.ts`

**Interfaces:**
- Consumes (Task 1): `createLockTable`, `LockTable`. (Task 2): `createSession`, `Session`, `SessionDeps`; `createMemoryGroups`, `DEV_GROUPS`. (Contract): `parseClientEvent`.
- Produces (`src/ws/server.ts`):
  - `const WS_PATH = '/ws'`, `const MAX_FRAME_BYTES = 65536`, `const DEFAULT_HEARTBEAT_MS = 15000`
  - `interface WsServerDeps extends SessionDeps { heartbeatMs?: number }`
  - `interface WsServer { close(): Promise<void>; sessionCount(): number }`
  - `function attachWsServer(http: Server, deps: WsServerDeps): WsServer` (where `Server` is from `node:http`)

- [ ] **Step 1: Write the failing test**

Create `test/ws/server.test.ts`:

```ts
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
```

- [ ] **Step 2: Run the test to check that it fails**

Run: `npm test`
Expected: FAIL. `test/ws/server.test.ts` reports `Cannot find module '../../src/ws/server.js'`. The other 42 tests pass.

- [ ] **Step 3: Create `src/ws/server.ts`**

```ts
// The /ws endpoint (plan §11, §11d): parses every frame with the contract parser,
// gives each socket a Session, and runs the heartbeat. A client that misses a pong
// is terminated, which closes its session and releases its group lock (FR-16).

import type { Server } from 'node:http';
import { WebSocketServer, type RawData, type WebSocket } from 'ws';
import { parseClientEvent } from '../contract/ws-events.js';
import { createSession, type Session, type SessionDeps } from './session.js';

export const WS_PATH = '/ws';
export const MAX_FRAME_BYTES = 65536;
export const DEFAULT_HEARTBEAT_MS = 15000;

export interface WsServerDeps extends SessionDeps {
  heartbeatMs?: number;
}

export interface WsServer {
  /** Stop the heartbeat, drop every client, close the WebSocket server. */
  close(): Promise<void>;
  sessionCount(): number;
}

function toBuffer(data: RawData): Buffer {
  if (Buffer.isBuffer(data)) return data;
  if (Array.isArray(data)) return Buffer.concat(data);
  return Buffer.from(data);
}

export function attachWsServer(http: Server, deps: WsServerDeps): WsServer {
  const wss = new WebSocketServer({ server: http, path: WS_PATH, maxPayload: MAX_FRAME_BYTES });
  const clients = new Map<WebSocket, { session: Session; alive: boolean }>();

  wss.on('connection', (socket) => {
    const client = { session: createSession(socket, deps), alive: true };
    clients.set(socket, client);

    socket.on('pong', () => {
      client.alive = true;
    });

    socket.on('message', (data, isBinary) => {
      if (isBinary) {
        client.session.send({ type: 'error', code: 'bad_json', message: 'binary frames are not supported' });
        return;
      }
      const parsed = parseClientEvent(toBuffer(data));
      if (!parsed.ok) {
        client.session.send({ type: 'error', ...parsed.error });
        return;
      }
      try {
        client.session.handle(parsed.event);
      } catch (err) {
        console.error('[ws] handler error', err);
        client.session.send({ type: 'error', code: 'bad_request', message: 'internal error' });
      }
    });

    socket.on('close', () => {
      client.session.close();
      clients.delete(socket);
    });

    // ws emits 'close' after 'error'; listening here stops an error from crashing the process.
    socket.on('error', () => client.session.close());
  });

  const heartbeat = setInterval(() => {
    for (const [socket, client] of clients) {
      if (!client.alive) {
        socket.terminate(); // fires 'close' → session.close() → lock released
        continue;
      }
      client.alive = false;
      socket.ping();
    }
  }, deps.heartbeatMs ?? DEFAULT_HEARTBEAT_MS);
  heartbeat.unref();

  return {
    close() {
      clearInterval(heartbeat);
      for (const socket of clients.keys()) socket.terminate();
      return new Promise<void>((resolve, reject) => wss.close((err) => (err ? reject(err) : resolve())));
    },
    sessionCount: () => clients.size,
  };
}
```

- [ ] **Step 4: Replace `src/index.ts`**

```ts
import 'dotenv/config';
import express from 'express';
import { createLockTable } from './ws/lock.js';
import { attachWsServer } from './ws/server.js';
import { createMemoryGroups, DEV_GROUPS } from './dev/dev-groups.js';

const app = express();
app.use(express.json());

const PORT = Number(process.env.PORT ?? 4020);

// Health check — confirms the server is up.
app.get('/health', (_req, res) => {
  res.json({ status: 'ok', service: 'comdove-fake-backend' });
});

const server = app.listen(PORT, () => {
  console.log(`🟢 comdove-fake-backend listening on http://localhost:${PORT}`);
  console.log(`🔌 WebSocket on ws://localhost:${PORT}/ws`);
});

// WebSocket: group sessions + lock + heartbeat. Dev wiring until Person 2's store
// lands (checkpoint ①): in-memory groups `alpha` and `beta`.
attachWsServer(server, { lock: createLockTable(), groups: createMemoryGroups(DEV_GROUPS) });
```

- [ ] **Step 5: Run the tests to check that they pass**

Run: `npm test`
Expected: PASS, 47 tests (28 contract + 6 lock + 8 session + 5 server), 0 failures.

- [ ] **Step 6: Run the type check**

Run: `npm run build`
Expected: exits 0 with no errors.

- [ ] **Step 7: Manual check with two real clients**

Start the server in one terminal: `npm run dev`
Expected log: `🔌 WebSocket on ws://localhost:4020/ws`

In a second terminal, run:

```bash
node -e '
const { WebSocket } = require("ws");
const open = () => new Promise((r) => { const s = new WebSocket("ws://localhost:4020/ws"); s.on("open", () => r(s)); });
(async () => {
  const a = await open(); const b = await open();
  const next = (s) => new Promise((r) => s.once("message", (d) => r(JSON.parse(String(d)))));
  a.send(JSON.stringify({ type: "group.claim", group: "alpha" })); console.log("A:", (await next(a)).type);
  b.send(JSON.stringify({ type: "group.claim", group: "alpha" })); console.log("B:", (await next(b)).type);
  a.close(); await new Promise((r) => setTimeout(r, 100));
  b.send(JSON.stringify({ type: "group.claim", group: "alpha" })); console.log("B retry:", (await next(b)).type);
  b.close();
})();'
```

Expected output:

```
A: group.claimed
B: group.locked
B retry: group.claimed
```

Stop the dev server with Ctrl+C.

- [ ] **Step 8: Commit**

```bash
git add src/ws/server.ts src/index.ts test/ws/server.test.ts
git commit -m "feat(ws): /ws server with frame parsing, heartbeat and dev wiring

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
```

---

## Done when

- `npm test` → 47 passing, 0 failing.
- `npm run build` → no errors.
- The manual check prints `group.claimed`, `group.locked`, `group.claimed`.
