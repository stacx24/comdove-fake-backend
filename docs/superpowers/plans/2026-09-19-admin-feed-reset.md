# Admin Feed and Reset Hook Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add the live admin feed (`log.entry`/`log.update`, `groups.update`, `numbers.update`, `webhook.verify`, `log.reset`) and the reset hook (fresh snapshot, or `group_deleted` and close). This finishes Person 3's live engine and checkpoint ②.

**Architecture:**
- The session gets admin hooks (`onAdminSubscribe`/`onAdminClose`) and a `disconnect()`.
- A new `src/ws/admin-feed.ts` keeps the admin sockets and builds the admin events from Person 2's readers, which are injected.
- The bus forwards `log.changed`/`webhook.verify` to the feed.
- `src/live.ts` wires the feed into claims, releases, presence and auto-reply, and exposes `adminChanged` and `reset`. Person 2's routes reach both through `services`.

**Tech Stack:** TypeScript (strict, NodeNext, ES modules), Node 24, `ws` 8, `better-sqlite3`, `node:test` via `tsx`.

**Spec:** `docs/superpowers/specs/2026-09-19-admin-feed-reset-design.md`

## Global Constraints

- Branch: `feature/live-delivery-core` (already rebased onto `develop` `15b643e`). Starting point: `npm test` → **221 pass**.
- No new dependencies. Keep `npm test`, `npm run typecheck` and `npm run build` clean after every task.
- Tests importing `src/core/registry.ts`, `src/core/messages.ts`, `src/compose.ts` or `src/live.ts` import `../helpers/memory-db.js` **first**.
- `admin.subscribe` → the socket immediately receives `groups.update` then `numbers.update`.
- `log.changed` → `log.entry` the first time a wamid is announced, `log.update` after. The announced set is cleared on reset. With no admins, no database lookup.
- Lock change and group create/delete → both lists. Number register/delete, presence and auto-reply → numbers. Reset → `log.reset`, then both lists.
- Reset keeping numbers → a fresh `group.claimed` to each open tab (the lock is kept). Reset wiping numbers → `error {code:'group_deleted'}`, the lock is released synchronously, then the socket is closed with code 4000.
- Rejected Meta requests are not pushed live (spec D7).
- Relative imports use `.js`. Commit messages end with `Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>`.

## File map

| File | Action | Responsibility |
|---|---|---|
| `src/ws/session.ts` | Modify | `onAdminSubscribe`, `onAdminClose`, `SessionSocket.close?`, `Session.disconnect?` |
| `src/ws/session-index.ts` | Modify | `all()` |
| `src/ws/admin-feed.ts` | Create | `createAdminFeed` |
| `src/core/bus.ts` | Modify | `admin` dep: `log.changed` / `webhook.verify` → feed |
| `src/live.ts` | Replace | Feed wiring, `admin`, `adminChanged`, `reset` |
| `src/core/services.ts` | Modify | `adminChanged?`, `afterReset?` |
| `src/compose.ts` | Modify (P1) | Wire the two services; `autoReplyChanged` refreshes numbers |
| `src/api/groups.route.ts`, `numbers.route.ts`, `system.route.ts` | Modify (P2) | Call the services; remove the TODOs |
| `test/ws/session.test.ts` | Modify | +2 |
| `test/ws/session-index.test.ts` | Modify | +1 |
| `test/ws/admin-feed.test.ts` | Create | 6 |
| `test/core/bus.test.ts` | Modify | 1 test replaced by 2 |
| `test/e2e/admin.e2e.test.ts` | Create | 8 |
| `test/e2e/ws.e2e.test.ts` | Modify | E2E-3 reads the initial lists |

---

### Task 1: Session admin hooks, disconnect, and `SessionIndex.all()`

**Files:**
- Modify: `src/ws/session.ts`, `src/ws/session-index.ts`
- Test: `test/ws/session.test.ts` (append), `test/ws/session-index.test.ts` (append)

**Interfaces:**
- Produces:
  - `SessionDeps.onAdminSubscribe?: (session: Session) => void`
  - `SessionDeps.onAdminClose?: (session: Session) => void`
  - `SessionSocket.close?(code?: number, reason?: string): void`
  - `Session.disconnect?(): void` — releases now (`close()`), then `socket.close(4000, 'closed by server')`
  - `SessionIndex.all(): Array<[string, Session]>` (a copy)

- [ ] **Step 1: Write the failing tests**

Append to `test/ws/session.test.ts`:

```ts
test('admin hooks: onAdminSubscribe on subscribe, onAdminClose on close; group sockets never call them', () => {
  const calls: string[] = [];
  const { open } = setup({ onAdminSubscribe: () => calls.push('sub'), onAdminClose: () => calls.push('close') });
  const admin = open();
  const group = open();
  admin.session.handle({ type: 'admin.subscribe' });
  group.session.handle({ type: 'group.claim', group: 'alpha' });
  group.session.close();
  admin.session.close();
  admin.session.close(); // idempotent
  assert.deepEqual(calls, ['sub', 'close']);
});

test('disconnect releases the lock at once, then closes the socket', () => {
  const { lock, groups } = setup();
  const closes: Array<[number | undefined, string | undefined]> = [];
  const socket = {
    ...fakeSocket(),
    close: (code?: number, reason?: string) => {
      closes.push([code, reason]);
    },
  };
  const released: string[] = [];
  const s = createSession(socket, { lock, groups, onRelease: (_s, g) => released.push(g) });
  s.handle({ type: 'group.claim', group: 'alpha' });
  s.disconnect!();
  assert.equal(lock.isLocked('alpha'), false);
  assert.deepEqual(released, ['alpha']);
  assert.deepEqual(closes, [[4000, 'closed by server']]);
  s.close(); // the socket's own close event arrives later → no-op
  assert.deepEqual(released, ['alpha']);
});
```

Append to `test/ws/session-index.test.ts`:

```ts
test('all() lists every open group session', () => {
  const index = createSessionIndex();
  const a = fake();
  const b = fake();
  index.add('alpha', a);
  index.add('beta', b);
  assert.deepEqual(index.all(), [
    ['alpha', a],
    ['beta', b],
  ]);
});
```

- [ ] **Step 2: Run the tests to check that they fail**

Run: `npm test`
Expected: 3 failures. The admin-hooks test gets `calls` = `[]`. The disconnect test throws `TypeError: s.disconnect is not a function`. The `all()` test throws `TypeError: index.all is not a function`. The other 221 pass.

- [ ] **Step 3: Change `src/ws/session.ts`**

In `interface SessionDeps`, after `onRelease`, add:

```ts
  /** Called when the socket becomes an admin feed (admin.subscribe). */
  onAdminSubscribe?: (session: Session) => void;
  /** Called when an admin-feed socket closes. */
  onAdminClose?: (session: Session) => void;
```

Replace `interface SessionSocket` with:

```ts
export interface SessionSocket {
  send(data: string): void;
  readonly readyState: number;
  close?(code?: number, reason?: string): void;
}
```

In `interface Session`, after `close(): void;`, add:

```ts
  /** Server-initiated end (a reset wiped the group): release now, then close the socket. */
  disconnect?(): void;
```

In `handle`, replace:

```ts
          role = { kind: 'admin' };
          return;
```

with:

```ts
          role = { kind: 'admin' };
          deps.onAdminSubscribe?.(session);
          return;
```

Replace the `close()` method with:

```ts
    close() {
      if (closed) return;
      closed = true;
      if (role.kind === 'group') {
        deps.lock.release(role.groupId, session);
        deps.onRelease?.(session, role.groupId);
      } else if (role.kind === 'admin') {
        deps.onAdminClose?.(session);
      }
    },

    disconnect() {
      session.close();
      socket.close?.(4000, 'closed by server');
    },
```

- [ ] **Step 4: Add `all()` to `src/ws/session-index.ts`**

In `interface SessionIndex`, after `get(...)`, add:

```ts
  /** Every open group session, as a copy (safe to close sessions while iterating). */
  all(): Array<[string, Session]>;
```

In the returned object of `createSessionIndex`, after `get`, add:

```ts
    all: () => [...byGroup],
```

- [ ] **Step 5: Run the tests to check that they pass**

Run: `npm test`
Expected: PASS, **224** tests, 0 failures.

- [ ] **Step 6: Typecheck and build**

Run: `npm run typecheck && npm run build`
Expected: both exit 0 with no `error TS` lines.

- [ ] **Step 7: Commit**

```bash
git add src/ws/session.ts src/ws/session-index.ts test/ws/session.test.ts test/ws/session-index.test.ts
git commit -m "feat(ws): admin session hooks, server-side disconnect, SessionIndex.all

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
```

---

### Task 2: The admin feed

**Files:**
- Create: `src/ws/admin-feed.ts`
- Test: `test/ws/admin-feed.test.ts`

**Interfaces:**
- Consumes: `AdminEvent`, `BusinessNumber`, `CustomerListItem`, `GroupListItem`, `LogEntry` (`src/contract/ws-events.ts`); `Session` (`src/ws/session.ts`).
- Produces:
  - `interface AdminFeedDeps { getLogEntry(wamid: string): LogEntry | null; listGroups(): GroupListItem[]; listBusinessNumbers(): BusinessNumber[]; listCustomers(): CustomerListItem[] }`
  - `interface AdminFeed { subscribe(s: Session): void; unsubscribe(s: Session): void; size(): number; logChanged(wamid: string): void; groupsChanged(): void; numbersChanged(): void; lockChanged(): void; verify(r: { ok: boolean; at: number; detail: string }): void; reset(): void }`
  - `function createAdminFeed(d: AdminFeedDeps): AdminFeed`

- [ ] **Step 1: Write the failing test**

Create `test/ws/admin-feed.test.ts`:

```ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createAdminFeed, type AdminFeedDeps } from '../../src/ws/admin-feed.js';
import type { Session } from '../../src/ws/session.js';
import type {
  AdminEvent,
  BusinessNumber,
  CustomerListItem,
  GroupListItem,
  LogEntry,
  ServerEvent,
} from '../../src/contract/ws-events.js';

const BIZ: BusinessNumber = {
  phone_number_id: 'PN-1',
  display_number: '918888800001',
  label: 'Sales',
  token: 'tok',
  waba_id: 'W-1',
  created_at: 1,
};
const CUST: CustomerListItem = {
  number: '919876543210',
  label: null,
  group_id: 'alpha',
  online: true,
  effective_online: false,
  claim_status: 'free',
  reply_mode: 'manual',
  type: 'customer',
};
const GROUPS: GroupListItem[] = [{ id: 'alpha', name: 'alpha', count: 1, status: 'free', locked_since: null }];

const entry = (wamid: string): LogEntry => ({
  wamid,
  time: 1,
  direction: 'outbound',
  source: 'api',
  from: BIZ.display_number,
  to: CUST.number,
  business: { phone_number_id: 'PN-1', label: 'Sales' },
  group_id: 'alpha',
  body: 'hi',
  status: 'sent',
  timeline: [],
  webhooks: [],
});

function fakeSession() {
  const sent: Array<ServerEvent | AdminEvent> = [];
  const session: Session = {
    role: { kind: 'admin' },
    send: (ev) => {
      sent.push(ev);
    },
    handle: () => {},
    close: () => {},
  };
  return { session, sent, types: () => sent.map((e) => e.type) };
}

function setup() {
  const lookups: string[] = [];
  const entries: Record<string, LogEntry> = { w1: entry('w1') };
  const deps: AdminFeedDeps = {
    getLogEntry: (wamid) => {
      lookups.push(wamid);
      return entries[wamid] ?? null;
    },
    listGroups: () => GROUPS,
    listBusinessNumbers: () => [BIZ],
    listCustomers: () => [CUST],
  };
  return { feed: createAdminFeed(deps), lookups, entries };
}

test('subscribe sends the current groups and numbers to that socket only', () => {
  const { feed } = setup();
  const a = fakeSession();
  const b = fakeSession();
  feed.subscribe(a.session);
  assert.deepEqual(a.sent, [
    { type: 'groups.update', groups: GROUPS },
    { type: 'numbers.update', business_numbers: [BIZ], customers: [CUST] },
  ]);
  assert.deepEqual(b.sent, []);
  assert.equal(feed.size(), 1);
});

test('a message change is log.entry the first time and log.update after, to every admin', () => {
  const { feed, entries } = setup();
  const a = fakeSession();
  const b = fakeSession();
  feed.subscribe(a.session);
  feed.subscribe(b.session);
  a.sent.length = 0;
  b.sent.length = 0;
  feed.logChanged('w1');
  feed.logChanged('w1');
  for (const s of [a, b]) {
    assert.deepEqual(s.sent, [
      { type: 'log.entry', entry: entries.w1 },
      { type: 'log.update', entry: entries.w1 },
    ]);
  }
});

test('with no admins there is no lookup; unknown wamids are ignored', () => {
  const { feed, lookups } = setup();
  feed.logChanged('w1');
  assert.deepEqual(lookups, []);
  const a = fakeSession();
  feed.subscribe(a.session);
  a.sent.length = 0;
  feed.logChanged('nope');
  assert.deepEqual(a.sent, []);
  feed.logChanged('w1'); // not announced while nobody listened → still an entry
  assert.deepEqual(a.types(), ['log.entry']);
});

test('unsubscribed sockets get nothing; lockChanged sends both lists', () => {
  const { feed } = setup();
  const a = fakeSession();
  const b = fakeSession();
  feed.subscribe(a.session);
  feed.subscribe(b.session);
  feed.unsubscribe(b.session);
  a.sent.length = 0;
  b.sent.length = 0;
  feed.lockChanged();
  feed.groupsChanged();
  feed.numbersChanged();
  assert.deepEqual(a.types(), ['groups.update', 'numbers.update', 'groups.update', 'numbers.update']);
  assert.deepEqual(b.sent, []);
  assert.equal(feed.size(), 1);
});

test('the webhook handshake result is broadcast', () => {
  const { feed } = setup();
  const a = fakeSession();
  feed.subscribe(a.session);
  a.sent.length = 0;
  feed.verify({ ok: true, at: 5, detail: 'ok' });
  assert.deepEqual(a.sent, [{ type: 'webhook.verify', ok: true, at: 5, detail: 'ok' }]);
});

test('reset sends log.reset then fresh lists, and the next change is a log.entry again', () => {
  const { feed } = setup();
  const a = fakeSession();
  feed.subscribe(a.session);
  feed.logChanged('w1');
  a.sent.length = 0;
  feed.reset();
  assert.deepEqual(a.types(), ['log.reset', 'groups.update', 'numbers.update']);
  a.sent.length = 0;
  feed.logChanged('w1');
  assert.deepEqual(a.types(), ['log.entry']);
});
```

- [ ] **Step 2: Run the test to check that it fails**

Run: `npm test`
Expected: FAIL. `admin-feed.test.ts` reports `Cannot find module '…/src/ws/admin-feed.js'`. The other 224 pass.

- [ ] **Step 3: Create `src/ws/admin-feed.ts`**

```ts
// The live admin feed (plan §12, FR-09, FR-11): every socket that sent admin.subscribe
// gets the current group and number lists at once, then every change live. Data comes
// from Person 2's store through injected readers, so this file never touches SQLite.
import type {
  AdminEvent,
  BusinessNumber,
  CustomerListItem,
  GroupListItem,
  LogEntry,
} from '../contract/ws-events.js';
import type { Session } from './session.js';

export interface AdminFeedDeps {
  getLogEntry(wamid: string): LogEntry | null;
  listGroups(): GroupListItem[];
  listBusinessNumbers(): BusinessNumber[];
  listCustomers(): CustomerListItem[];
}

export interface AdminFeed {
  /** A socket became an admin feed: remember it and send it the current lists. */
  subscribe(session: Session): void;
  unsubscribe(session: Session): void;
  size(): number;
  /** A message or one of its webhooks changed: log.entry the first time, log.update after. */
  logChanged(wamid: string): void;
  groupsChanged(): void;
  numbersChanged(): void;
  /** A group was claimed or released: both lists show the claim status. */
  lockChanged(): void;
  verify(result: { ok: boolean; at: number; detail: string }): void;
  /** After /api/reset: log.reset, then fresh lists. */
  reset(): void;
}

export function createAdminFeed(d: AdminFeedDeps): AdminFeed {
  const admins = new Set<Session>();
  const announced = new Set<string>(); // wamids already sent as log.entry

  const broadcast = (ev: AdminEvent) => {
    for (const s of admins) s.send(ev);
  };
  const groupsEvent = (): AdminEvent => ({ type: 'groups.update', groups: d.listGroups() });
  const numbersEvent = (): AdminEvent => ({
    type: 'numbers.update',
    business_numbers: d.listBusinessNumbers(),
    customers: d.listCustomers(),
  });
  /** Build the event only if someone is listening. */
  const toAdmins = (make: () => AdminEvent) => {
    if (admins.size > 0) broadcast(make());
  };

  return {
    subscribe(session) {
      admins.add(session);
      session.send(groupsEvent());
      session.send(numbersEvent());
    },
    unsubscribe(session) {
      admins.delete(session);
    },
    size: () => admins.size,

    logChanged(wamid) {
      if (admins.size === 0) return;
      const entry = d.getLogEntry(wamid);
      if (!entry) return;
      const type = announced.has(wamid) ? 'log.update' : 'log.entry';
      announced.add(wamid);
      broadcast({ type, entry });
    },

    groupsChanged: () => toAdmins(groupsEvent),
    numbersChanged: () => toAdmins(numbersEvent),
    lockChanged() {
      toAdmins(groupsEvent);
      toAdmins(numbersEvent);
    },

    verify(result) {
      toAdmins(() => ({ type: 'webhook.verify', ok: result.ok, at: result.at, detail: result.detail }));
    },

    reset() {
      announced.clear();
      toAdmins(() => ({ type: 'log.reset' }));
      toAdmins(groupsEvent);
      toAdmins(numbersEvent);
    },
  };
}
```

- [ ] **Step 4: Run the tests to check that they pass**

Run: `npm test`
Expected: PASS, **230** tests, 0 failures.

- [ ] **Step 5: Typecheck and build**

Run: `npm run typecheck && npm run build`
Expected: both exit 0 with no `error TS` lines.

- [ ] **Step 6: Commit**

```bash
git add src/ws/admin-feed.ts test/ws/admin-feed.test.ts
git commit -m "feat(ws): admin feed — live log, group and number lists, verify, reset

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
```

---

### Task 3: Bus forwards admin events to the feed

**Files:**
- Modify: `src/core/bus.ts`
- Test: `test/core/bus.test.ts`

**Interfaces:**
- Consumes: `AdminFeed` (Task 2).
- Produces: `LiveBusDeps.admin?: Pick<AdminFeed, 'logChanged' | 'verify'>`

- [ ] **Step 1: Change the bus test**

In `test/core/bus.test.ts`, replace the import line:

```ts
import { createLiveBus } from '../../src/core/bus.js';
```

with:

```ts
import { createLiveBus, type LiveBusDeps } from '../../src/core/bus.js';
```

Replace:

```ts
function setup() {
```

with:

```ts
function setup(admin?: LiveBusDeps['admin']) {
```

Replace:

```ts
  const bus = createLiveBus({ sessions, getCustomer: (n) => customers[n] ?? null, log: (l) => logs.push(l) });
```

with:

```ts
  const bus = createLiveBus({ sessions, getCustomer: (n) => customers[n] ?? null, log: (l) => logs.push(l), admin });
```

Replace the whole last test:

```ts
test('admin-feed events are ignored for now', () => {
  const { bus, sessions, session, sent } = setup();
  sessions.add('alpha', session);
  bus.emit({ type: 'log.changed', wamid: 'w1' });
  bus.emit({ type: 'webhook.verify', ok: true, at: 1, detail: 'ok' });
  assert.deepEqual(sent, []);
});
```

with:

```ts
test('log.changed and webhook.verify go to the admin feed, not to tiles', () => {
  const calls: unknown[] = [];
  const { bus, sessions, session, sent } = setup({
    logChanged: (wamid) => calls.push(['log', wamid]),
    verify: (r) => calls.push(['verify', r]),
  });
  sessions.add('alpha', session);
  bus.emit({ type: 'log.changed', wamid: 'w1' });
  bus.emit({ type: 'webhook.verify', ok: true, at: 1, detail: 'ok' });
  assert.deepEqual(calls, [
    ['log', 'w1'],
    ['verify', { ok: true, at: 1, detail: 'ok' }],
  ]);
  assert.deepEqual(sent, []);
});

test('without an admin feed, admin events are dropped quietly', () => {
  const { bus, sessions, session, sent } = setup();
  sessions.add('alpha', session);
  bus.emit({ type: 'log.changed', wamid: 'w1' });
  bus.emit({ type: 'webhook.verify', ok: false, at: 1, detail: 'down' });
  assert.deepEqual(sent, []);
});
```

- [ ] **Step 2: Run the tests to check that they fail**

Run: `npm test`
Expected: 1 failure — `log.changed and webhook.verify go to the admin feed, not to tiles` (`calls` is `[]`). (`npm run typecheck` would also flag `admin` as an unknown property until Step 3.) The other 230 pass.

- [ ] **Step 3: Change `src/core/bus.ts`**

Replace the header comment:

```ts
// Person 3's Bus (Person 1's port): turns lifecycle and dispatcher events into /ws frames
// for the session that holds the tile's group. Outbound bubbles are pushed by delivery;
// the bus shows inbound bubbles and status ticks. Admin-feed events (log.changed,
// webhook.verify) are ignored until the admin feed lands (next step).
```

with:

```ts
// Person 3's Bus (Person 1's port): turns lifecycle and dispatcher events into /ws frames.
// Tiles: inbound bubbles and status ticks for the session that holds the tile's group
// (outbound bubbles are pushed by delivery). Admins: log.changed and webhook.verify go
// to the admin feed.
```

Add after the other imports:

```ts
import type { AdminFeed } from '../ws/admin-feed.js';
```

In `interface LiveBusDeps`, after `log?`, add:

```ts
  admin?: Pick<AdminFeed, 'logChanged' | 'verify'>;
```

Replace:

```ts
        default:
          return; // log.changed, webhook.verify → admin feed (next step)
```

with:

```ts
        case 'log.changed':
          d.admin?.logChanged(e.wamid);
          return;
        case 'webhook.verify':
          d.admin?.verify({ ok: e.ok, at: e.at, detail: e.detail });
          return;
```

- [ ] **Step 4: Run the tests to check that they pass**

Run: `npm test`
Expected: PASS, **231** tests, 0 failures.

- [ ] **Step 5: Typecheck and build**

Run: `npm run typecheck && npm run build`
Expected: both exit 0 with no `error TS` lines.

- [ ] **Step 6: Commit**

```bash
git add src/core/bus.ts test/core/bus.test.ts
git commit -m "feat(core): bus forwards log.changed and webhook.verify to the admin feed

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
```

---

### Task 4: Wire the feed and the reset hook into the app

**Files:**
- Replace: `src/live.ts`
- Modify: `src/core/services.ts`, `src/compose.ts`, `src/api/groups.route.ts`, `src/api/numbers.route.ts`, `src/api/system.route.ts`, `test/e2e/ws.e2e.test.ts`
- Create: `test/e2e/admin.e2e.test.ts`

**Interfaces:**
- Consumes: Tasks 1–3; P2 `getLogEntry` (`src/core/messages.ts`); `listGroups`, `listBusinessNumbers`, `listCustomers`, `setOnline`, `setAutoReply`, `listGroupTiles` (`src/core/registry.ts`); `openGroup`, `wsClient`, `WsClient` (`test/helpers/ws-client.ts`).
- Produces:
  - `LiveEngine.admin: AdminFeed`
  - `LiveEngine.adminChanged(what: 'groups' | 'numbers'): void`
  - `LiveEngine.reset(keepNumbers: boolean): void`
  - `Services.adminChanged?: (what: 'groups' | 'numbers') => void`
  - `Services.afterReset?: (keepNumbers: boolean) => void`

- [ ] **Step 1: Write the failing end-to-end test**

Create `test/e2e/admin.e2e.test.ts`:

```ts
// Admin feed + reset hook through the real boot wiring (composeServer + live.attach)
// against a signature-checking fake Comdove. Completes checkpoint ②.
import '../helpers/memory-db.js';
import { test, before, after, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { composeServer } from '../../src/compose.js';
import { createFakeComdove } from '../../tools/fake-comdove-app.js';
import { listen, waitFor } from '../helpers/http.js';
import { openGroup, wsClient, type Frame, type WsClient } from '../helpers/ws-client.js';
import { sharedLock } from '../../src/ws/shared-lock.js';

const SECRET = 'admin-secret';
const BIZ = '918888800001';
const T1 = '919876543210';
const T2 = '919876543211';
let comdove: ReturnType<typeof createFakeComdove>;
let base = '';
let wsUrl = '';
let stop: () => Promise<void>;
const clients: WsClient[] = [];

before(async () => {
  comdove = createFakeComdove({ appSecret: SECRET, verifyToken: 'v' });
  const c = await listen(comdove.app);
  const composed = composeServer({
    env: { COMDOVE_WEBHOOK_URL: `${c.base}/webhooks/whatsapp`, APP_SECRET: SECRET, WEBHOOK_VERIFY_TOKEN: 'v', STATUS_WEBHOOK_DELAY_MS: 30 },
    dispatcher: { retryDelaysMs: [10, 10, 10], timeoutMs: 500 },
    log: () => {},
  });
  const m = await listen(composed.app);
  const wss = composed.live.attach(m.server, { heartbeatMs: 60_000 });
  base = m.base;
  wsUrl = `${m.base.replace('http', 'ws')}/ws`;
  stop = async () => {
    composed.metaFace.dispatcher.cancelAll();
    await wss.close();
    await m.close();
    await c.close();
  };
});
after(() => stop());

const api = async (method: string, path: string, body?: unknown, headers: Record<string, string> = {}) => {
  const res = await fetch(base + path, { method, headers: { 'Content-Type': 'application/json', ...headers }, body: body === undefined ? undefined : JSON.stringify(body) });
  const text = await res.text();
  return { status: res.status, json: text ? JSON.parse(text) : null };
};
const comdoveSend = async (to: string, body: string) =>
  (await api('POST', '/v23.0/PN-1/messages', { messaging_product: 'whatsapp', to, type: 'text', text: { body } }, { Authorization: 'Bearer tok' })).json.messages[0].id as string;

beforeEach(async () => {
  await api('POST', '/api/reset', { keep_numbers: false });
  comdove.received.length = 0;
  assert.equal((await api('POST', '/api/business-numbers', { display_number: BIZ, label: 'Sales', phone_number_id: 'PN-1', waba_id: 'WABA-1', token: 'tok' })).status, 200);
  assert.equal((await api('POST', '/api/groups', { name: 'alpha', numbers: [T1, T2] })).status, 200);
});

afterEach(async () => {
  while (clients.length) await clients.pop()!.close();
  await waitFor(() => !sharedLock.isLocked('alpha'));
});

/** An admin page: subscribes and reads past the two initial lists. */
async function admin() {
  const c = await wsClient(wsUrl);
  clients.push(c);
  c.send({ type: 'admin.subscribe' });
  await c.next('groups.update');
  await c.next('numbers.update');
  return c;
}
async function tab(group = 'alpha') {
  const t = await openGroup(wsUrl, group);
  clients.push(t);
  return t;
}

test('subscribing sends the current groups and numbers', async () => {
  const c = await wsClient(wsUrl);
  clients.push(c);
  c.send({ type: 'admin.subscribe' });
  const g = await c.next('groups.update');
  assert.deepEqual(g.groups.map((x: Frame) => [x.id, x.status]), [['alpha', 'free']]);
  const n = await c.next('numbers.update');
  assert.deepEqual(n.business_numbers.map((b: Frame) => b.phone_number_id), ['PN-1']);
  assert.deepEqual(n.customers.map((x: Frame) => x.number), [T1, T2]);
});

test('live log: log.entry when Comdove sends, then log.update until delivered with both webhooks ok', async () => {
  const a = await admin();
  await tab();
  const wamid = await comdoveSend(T1, 'Hello');
  const first = await a.next('log.entry', (f) => f.entry.wamid === wamid);
  assert.equal(first.entry.body, 'Hello');
  const done = await a.next(
    'log.update',
    (f) => f.entry.wamid === wamid && f.entry.status === 'delivered' && f.entry.webhooks.length === 2 && f.entry.webhooks.every((w: Frame) => w.state === 'ok'),
  );
  assert.deepEqual(done.entry.timeline.map((t: Frame) => t.status), ['sent', 'delivered']);
});

test('a reply typed in a tile appears in the log as an inbound entry', async () => {
  const a = await admin();
  const t = await tab();
  t.send({ type: 'message.send', from: T1, to: BIZ, body: 'how much?' });
  const e = await a.next('log.entry', (f) => f.entry.direction === 'inbound');
  assert.deepEqual([e.entry.body, e.entry.source, e.entry.from], ['how much?', 'tile', T1]);
});

test('opening and closing a group updates the launch list live', async () => {
  const a = await admin();
  const t = await tab();
  const locked = await a.next('groups.update', (f) => f.groups[0]?.status === 'locked');
  assert.equal(typeof locked.groups[0].locked_since, 'number');
  await a.next('numbers.update', (f) => f.customers.every((c: Frame) => c.claim_status === 'locked'));
  await t.close();
  await a.next('groups.update', (f) => f.groups[0]?.status === 'free');
});

test('control-API changes reach admins: new group, new number, presence', async () => {
  const a = await admin();
  assert.equal((await api('POST', '/api/groups', { name: 'beta', numbers: ['919876543220'] })).status, 200);
  await a.next('groups.update', (f) => f.groups.some((g: Frame) => g.id === 'beta'));
  await a.next('numbers.update', (f) => f.customers.some((c: Frame) => c.number === '919876543220'));
  assert.equal((await api('POST', '/api/business-numbers', { display_number: '918888800002', label: 'Support' })).status, 200);
  await a.next('numbers.update', (f) => f.business_numbers.length === 2);
  await api('POST', '/api/presence', { number: T2, online: false });
  await a.next('numbers.update', (f) => f.customers.find((c: Frame) => c.number === T2)?.online === false);
});

test('the webhook handshake result reaches admins', async () => {
  const a = await admin();
  const r = await api('POST', '/api/webhook/verify');
  const v = await a.next('webhook.verify');
  assert.equal(v.ok, true);
  assert.equal(v.ok, r.json.ok);
});

test('reset keeping numbers: log.reset to admins, a fresh empty snapshot to the open tab, lock kept', async () => {
  const a = await admin();
  const t = await tab();
  await comdoveSend(T1, 'Hello');
  await t.next('message.new');
  assert.equal((await api('POST', '/api/reset', {})).status, 200);
  await a.next('log.reset');
  const snap = await t.next('group.claimed');
  assert.deepEqual(snap.tiles.find((x: Frame) => x.number === T1).history, []);
  assert.equal(sharedLock.isLocked('alpha'), true);
  assert.deepEqual((await api('GET', '/api/log')).json, []);
});

test('reset wiping numbers: the open tab gets group_deleted and is closed; the group is free', async () => {
  const a = await admin();
  const t = await tab();
  assert.equal((await api('POST', '/api/reset', { keep_numbers: false })).status, 200);
  const err = await t.next('error');
  assert.equal(err.code, 'group_deleted');
  assert.equal(sharedLock.isLocked('alpha'), false);
  await waitFor(() => t.socket.readyState === 3); // CLOSED
  await a.next('groups.update', (f) => f.groups.length === 0);
});
```

- [ ] **Step 2: Run the test to check that it fails**

Run: `timeout 120 node --import tsx --test test/e2e/admin.e2e.test.ts`
Expected: FAIL. The first test times out with `no groups.update frame within 3000ms` (the feed isn't wired in yet), and the others fail the same way. The 221 existing tests are unaffected.

- [ ] **Step 3: Replace `src/live.ts`**

```ts
// Person 3's live engine, assembled: one SessionIndex shared by the /ws sessions, the
// bus, the delivery, the tile actions and the admin feed. composeServer() builds it;
// index.ts attaches it to the server.
import type { Server } from 'node:http';
import type { Bus } from './core/ports.js';
import type { Lifecycle } from './core/lifecycle.js';
import type { CustomerListItem, LogEntry } from './contract/ws-events.js';
import { sqliteRegistry } from './core/registry-adapter.js';
import {
  listBusinessNumbers,
  listCustomers,
  listGroupTiles,
  listGroups,
  setAutoReply,
  setOnline,
} from './core/registry.js';
import { getLogEntry, queuedFor } from './core/messages.js';
import { computeReply } from './core/autoreply.js';
import { createLiveBus } from './core/bus.js';
import { createLiveDelivery, type LiveDelivery } from './core/delivery.js';
import { createSessionIndex, type SessionIndex } from './ws/session-index.js';
import { sharedLock } from './ws/shared-lock.js';
import { storeGroups } from './ws/store-groups.js';
import { attachWsServer, type WsServer } from './ws/server.js';
import { createGroupEvents, type GroupEvents } from './ws/group-events.js';
import { createAdminFeed, type AdminFeed } from './ws/admin-feed.js';
import type { LockTable } from './ws/lock.js';
import type { GroupDirectory } from './ws/session.js';

export interface LiveEngineDeps {
  /** Late-bound: the Meta face (and its lifecycle) is built after the live engine. */
  lifecycle: () => Pick<Lifecycle, 'delivered' | 'inbound' | 'read'> | undefined;
  log?: (line: string) => void;
  lock?: LockTable;
  groups?: GroupDirectory;
}

export interface LiveEngine {
  bus: Bus;
  delivery: LiveDelivery;
  sessions: SessionIndex;
  /** Tile actions (message.send, chat.read, tile.presence, tile.autoreply) + their API twins. */
  groupEvents: GroupEvents;
  /** Live admin feed (log, group and number lists, verify). */
  admin: AdminFeed;
  /** The control API changed groups (also refreshes customers) or numbers. */
  adminChanged(what: 'groups' | 'numbers'): void;
  /** After /api/reset: admins get log.reset + lists; open tabs get a fresh snapshot or group_deleted. */
  reset(keepNumbers: boolean): void;
  attach(http: Server, opts?: { heartbeatMs?: number }): WsServer;
}

export function createLiveEngine(d: LiveEngineDeps): LiveEngine {
  const sessions = createSessionIndex();
  const groups = d.groups ?? storeGroups;

  const admin = createAdminFeed({
    // P2's rows are slightly wider than the DTOs (e.g. webhook kind: string).
    getLogEntry: (wamid) => getLogEntry(wamid) as LogEntry | null,
    listGroups,
    listBusinessNumbers,
    listCustomers: () => listCustomers() as CustomerListItem[],
  });

  const delivery = createLiveDelivery({
    sessions,
    getCustomer: sqliteRegistry.getCustomer,
    listGroupTiles,
    queuedFor,
    delivered: (msgs) => d.lifecycle()?.delivered(msgs),
    inbound: (from, to, body, source) => d.lifecycle()?.inbound(from, to, body, source),
    computeReply,
    log: d.log,
  });
  const bus = createLiveBus({ sessions, getCustomer: sqliteRegistry.getCustomer, log: d.log, admin });
  const groupEvents = createGroupEvents({
    sessions,
    delivery,
    lifecycle: d.lifecycle,
    getCustomer: sqliteRegistry.getCustomer,
    getBusiness: sqliteRegistry.getBusiness,
    setOnline: (number, online) => {
      setOnline(number, online);
      admin.numbersChanged();
    },
    setAutoReply: (number, ar) => {
      const saved = setAutoReply(number, ar);
      admin.numbersChanged();
      return saved;
    },
  });

  return {
    bus,
    delivery,
    sessions,
    groupEvents,
    admin,

    adminChanged(what) {
      if (what === 'groups') admin.groupsChanged();
      admin.numbersChanged();
    },

    reset(keepNumbers) {
      admin.reset();
      for (const [groupId, session] of sessions.all()) {
        if (keepNumbers && groups.exists(groupId)) {
          session.send({ type: 'group.claimed', ...groups.snapshot(groupId) });
        } else {
          session.send({ type: 'error', code: 'group_deleted', message: `group ${groupId} was deleted by a reset` });
          session.disconnect?.();
        }
      }
    },

    attach(http, opts = {}) {
      return attachWsServer(http, {
        lock: d.lock ?? sharedLock,
        groups,
        onClaim: (session, groupId) => {
          sessions.add(groupId, session);
          delivery.deliverQueued(groupId);
          admin.lockChanged();
        },
        onRelease: (session, groupId) => {
          sessions.remove(groupId, session);
          admin.lockChanged();
        },
        onAdminSubscribe: (session) => admin.subscribe(session),
        onAdminClose: (session) => admin.unsubscribe(session),
        onGroupEvent: groupEvents.onGroupEvent,
        ...(opts.heartbeatMs !== undefined && { heartbeatMs: opts.heartbeatMs }),
      });
    },
  };
}
```

- [ ] **Step 4: Add the two services to `src/core/services.ts`**

In `interface Services`, after the `autoReplyChanged` member, add:

```ts
  /** P3 live engine — the admin lists changed ('groups' also refreshes customers). */
  adminChanged?: (what: 'groups' | 'numbers') => void;
  /** P3 live engine — after /api/reset: log.reset + lists to admins; fresh snapshot or group_deleted to open tabs. */
  afterReset?: (keepNumbers: boolean) => void;
```

- [ ] **Step 5: Wire them in `src/compose.ts`**

Replace:

```ts
  services.autoReplyChanged = live.groupEvents.autoReplyChanged;
```

with:

```ts
  services.autoReplyChanged = (number, ar) => {
    live.groupEvents.autoReplyChanged(number, ar);
    live.admin.numbersChanged(); // reply_mode is in the customers list
  };
  services.adminChanged = live.adminChanged;
  services.afterReset = live.reset;
```

- [ ] **Step 6: Call the services from Person 2's routes**

`src/api/groups.route.ts`: replace

```ts
import { fail } from './respond.js';
// TODO(Person 3): emit groups.update / numbers.update to the admin feed on changes (bus)
```

with

```ts
import { fail } from './respond.js';
import { services } from '../core/services.js';
```

then replace

```ts
    const g = createGroup(String(name), numbers.map(String), labels);
    return res.json(g);
```

with

```ts
    const g = createGroup(String(name), numbers.map(String), labels);
    services.adminChanged?.('groups');
    return res.json(g);
```

and replace

```ts
  if (!r.ok) return fail(res, 404, 'no such group');
  return res.status(204).end();
```

with

```ts
  if (!r.ok) return fail(res, 404, 'no such group');
  services.adminChanged?.('groups');
  return res.status(204).end();
```

`src/api/numbers.route.ts`: replace

```ts
import { fail } from './respond.js';
// TODO(Person 3): emit numbers.update to the admin feed on changes (bus)
```

with

```ts
import { fail } from './respond.js';
import { services } from '../core/services.js';
```

then replace

```ts
    const bn = registerBusinessNumber({ display_number: String(display_number), label, phone_number_id, waba_id, token });
    return res.json(bn);
```

with

```ts
    const bn = registerBusinessNumber({ display_number: String(display_number), label, phone_number_id, waba_id, token });
    services.adminChanged?.('numbers');
    return res.json(bn);
```

and replace

```ts
  if (!ok) return fail(res, 404, 'no such business number');
  return res.status(204).end();
```

with

```ts
  if (!ok) return fail(res, 404, 'no such business number');
  services.adminChanged?.('numbers');
  return res.status(204).end();
```

`src/api/system.route.ts`: replace

```ts
  // TODO(Person 3): emit log.reset / groups.update to the admin feed
```

with

```ts
  services.afterReset?.(keep); // admins: log.reset + lists; open tabs: fresh snapshot or group_deleted
```

- [ ] **Step 7: Update `ws.e2e` E2E-3 — admins now receive the lists first**

In `test/e2e/ws.e2e.test.ts`, replace:

```ts
    admin.send({ type: 'admin.subscribe' });
    admin.send({ type: 'group.claim', group: 'alpha' });
```

with:

```ts
    admin.send({ type: 'admin.subscribe' });
    assert.equal((await admin.next()).type, 'groups.update');
    assert.equal((await admin.next()).type, 'numbers.update');
    admin.send({ type: 'group.claim', group: 'alpha' });
```

- [ ] **Step 8: Run the tests to check that they pass**

Run: `timeout 280 npm test`
Expected: PASS, **239** tests, 0 failures. Run it two more times; it must stay green.
Then: `grep -rn "TODO(Person 3)" src` → no output.

- [ ] **Step 9: Typecheck and build**

Run: `npm run typecheck && npm run build`
Expected: both exit 0 with no `error TS` lines.

- [ ] **Step 10: Manual check**

Terminal 1: `npm run fake-comdove`
Terminal 2: `PORT=4030 DB_PATH=/tmp/admin-check.sqlite COMDOVE_WEBHOOK_URL=http://localhost:3100/webhooks/whatsapp npm run dev`
Terminal 3:

```bash
curl -s -X POST localhost:4030/api/business-numbers -H 'Content-Type: application/json' \
  -d '{"display_number":"918888800001","label":"Sales","phone_number_id":"MOCK-PN-1","waba_id":"MOCK-WABA-1","token":"mock-token-dev"}' >/dev/null
curl -s -X POST localhost:4030/api/groups -H 'Content-Type: application/json' \
  -d '{"name":"alpha","numbers":["919876543210","919876543211"]}' >/dev/null
node --input-type=module -e '
const { WebSocket } = await import("ws");
const admin = new WebSocket("ws://localhost:4030/ws");
admin.on("open", () => admin.send(JSON.stringify({ type: "admin.subscribe" })));
admin.on("message", (d) => { const f = JSON.parse(String(d));
  console.log("ADMIN", f.type, f.entry ? `${f.entry.body} ${f.entry.status}` : f.groups ? f.groups.map(g => `${g.id}:${g.status}`).join(",") : ""); });
setTimeout(() => admin.close(), 4000);' &
sleep 0.5
node --input-type=module -e '
const { WebSocket } = await import("ws");
const tab = new WebSocket("ws://localhost:4030/ws");
tab.on("open", () => tab.send(JSON.stringify({ type: "group.claim", group: "alpha" })));
setTimeout(() => tab.close(), 2000);' &
sleep 0.5
curl -s -X POST localhost:4030/v23.0/MOCK-PN-1/messages -H 'Authorization: Bearer mock-token-dev' -H 'Content-Type: application/json' \
  -d '{"messaging_product":"whatsapp","to":"919876543210","type":"text","text":{"body":"hi"}}' >/dev/null
sleep 2
curl -s -X POST localhost:4030/api/reset -H 'Content-Type: application/json' -d '{}' >/dev/null
wait
```

Expected in terminal 3, in order:
- `ADMIN groups.update alpha:free`, then `ADMIN numbers.update`.
- `ADMIN groups.update alpha:locked` (and `numbers.update`) when the tab opens.
- `ADMIN log.entry hi sent`, then `ADMIN log.update hi …` until `hi delivered`.
- `ADMIN groups.update alpha:free` when the tab closes.
- `ADMIN log.reset` after the reset.

Stop both servers with Ctrl+C in their terminals, then `rm -f /tmp/admin-check.sqlite*`.

- [ ] **Step 11: Commit**

```bash
git add src/live.ts src/core/services.ts src/compose.ts src/api/groups.route.ts src/api/numbers.route.ts src/api/system.route.ts test/e2e/admin.e2e.test.ts test/e2e/ws.e2e.test.ts
git commit -m "feat(live): admin feed and reset hook wired into the app (checkpoint ②)

Admins get the group and number lists on subscribe, then the live log, lock
changes, control-API changes, verify results and log.reset. /api/reset sends open
tabs a fresh snapshot, or group_deleted and closes them. Removes the last
TODO(Person 3) markers.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
```

---

## Done when

- `npm test` → 239 passing, 0 failing (3 runs); `npm run typecheck` and `npm run build` are clean.
- `grep -rn "TODO(Person 3)" src` → nothing.
- The manual check shows the admin sequence above.
