# Live Delivery Core Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the interim delivery, the log-only bus and the lock placeholders in `develop` with Person 3's real live engine, so a Comdove send reaches an open tile over `/ws` in < 1 s, closed groups queue, and reopening a group delivers its queue (checkpoint ①).

**Architecture:**
- A `SessionIndex` (groupId → open session) is filled by two new session hooks (`onClaim`/`onRelease`).
- `core/delivery.ts` implements Person 1's `Delivery` port, and `core/bus.ts` implements Person 1's `Bus` port. Both look up the session through the index.
- `ws/store-groups.ts` builds snapshots from Person 2's SQLite store, and `ws/shared-lock.ts` is the one lock that `registry.ts` also reads.
- `src/live.ts` assembles them; `compose.ts` uses it instead of the interim stand-ins, and `index.ts` attaches it to the HTTP server.

**Tech Stack:** TypeScript (strict, NodeNext, ES modules), Node 24, `ws` 8, `better-sqlite3`, `node:test` via `tsx`.

**Spec:** `docs/superpowers/specs/2026-09-19-live-delivery-core-design.md`

## Global Constraints

- No new dependencies. Tests: `node:test` + `node:assert/strict`; run `npm test`. Also keep `npm run typecheck` and `npm run build` clean.
- Any test that imports `src/core/registry.ts`, `src/core/messages.ts`, `src/compose.ts` or `src/live.ts` must import `../helpers/memory-db.js` **first** (in-memory SQLite).
- Effectively online = group claimed by an open session **AND** tile flag on. No session → queued.
- On claim, queued messages are in the snapshot's `queued`; then `lifecycle.delivered()` runs for online tiles. **No `queue.flush`** on claim.
- Snapshot `history` excludes queued messages; `unread` = outbound, delivered, not read, keyed by business display number.
- Bus and delivery never throw into Person 1's lifecycle.
- `log.changed` and `webhook.verify` bus events are ignored (admin feed is the next spec).
- Relative imports use the `.js` extension.
- Commit messages end with `Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>`.
- Work on branch `feature/live-delivery-core` (already created from `develop` `c9cc139`).

## File map

| File | Action | Responsibility |
|---|---|---|
| `src/ws/session.ts` | Modify | `onClaim` / `onRelease` hooks |
| `src/ws/session-index.ts` | Create | groupId → open session |
| `src/ws/wire.ts` | Create | `statusOf`, `toWsMessage` (stored row → chat bubble) |
| `src/ws/shared-lock.ts` | Create | Process-wide `sharedLock` |
| `src/core/registry.ts` | Modify (P2) | Placeholders read `sharedLock` |
| `src/ws/store-groups.ts` | Create | `storeGroups: GroupDirectory` on P2's store |
| `src/core/delivery.ts` | Create | `createLiveDelivery` (P1 `Delivery` port) |
| `src/core/bus.ts` | Create | `createLiveBus` (P1 `Bus` port) |
| `src/live.ts` | Create | `createLiveEngine` — assembles and attaches |
| `src/compose.ts` | Modify (P1) | Live engine instead of interim delivery + log bus |
| `src/index.ts` | Modify | `live.attach(server)` |
| `src/dev/interim-delivery.ts` | Delete (P1) | Replaced |
| `test/ws/session.test.ts` | Modify | +1 test |
| `test/ws/session-index.test.ts`, `test/ws/wire.test.ts` | Create | 1 + 3 tests |
| `test/ws/store-groups.test.ts` | Create | 4 tests |
| `test/core/delivery.test.ts` | Create | 8 tests |
| `test/core/bus.test.ts` | Create | 5 tests |
| `test/e2e/live.e2e.test.ts` | Create | 5 tests |
| `test/e2e/integrated.e2e.test.ts` | Modify (P1) | Open `alpha` over `/ws` per test |
| `test/e2e/ws.e2e.test.ts` | Modify | Seed groups through `/api` |

Starting point: `npm test` → **185 pass**.

---

### Task 1: Session hooks, session index and wire format

**Files:**
- Modify: `src/ws/session.ts`
- Create: `src/ws/session-index.ts`, `src/ws/wire.ts`
- Test: `test/ws/session.test.ts` (append), `test/ws/session-index.test.ts`, `test/ws/wire.test.ts`

**Interfaces:**
- Consumes: `Session`, `SessionDeps` (`src/ws/session.ts`); `WsMessage`, `MessageStatus` (`src/contract/ws-events.ts`); `StoredMessage` (`src/core/ports.ts`).
- Produces:
  - `SessionDeps.onClaim?: (session: Session, groupId: string) => void` — after `group.claimed` is sent
  - `SessionDeps.onRelease?: (session: Session, groupId: string) => void` — on close, after the lock is released
  - `interface SessionIndex { add(groupId: string, session: Session): void; remove(groupId: string, session: Session): void; get(groupId: string): Session | undefined }`, `function createSessionIndex(): SessionIndex`
  - `function statusOf(m: Pick<StoredMessage, 'delivered_at' | 'read_at'>): MessageStatus`
  - `function toWsMessage(m: Pick<StoredMessage, 'wamid' | 'direction' | 'from_number' | 'to_number' | 'body' | 'created_at' | 'delivered_at' | 'read_at'>): WsMessage`

- [ ] **Step 1: Write the failing tests**

Append to `test/ws/session.test.ts`:

```ts
test('onClaim runs after a successful claim and onRelease on close; never for refused claims', () => {
  const calls: string[] = [];
  const { open } = setup({
    onClaim: (s, g) => calls.push(`claim:${g}:${s.role.kind}`),
    onRelease: (_s, g) => calls.push(`release:${g}`),
  });
  const first = open();
  const second = open();
  first.session.handle({ type: 'group.claim', group: 'alpha' });
  assert.equal(first.socket.sent[0]?.type, 'group.claimed');
  second.session.handle({ type: 'group.claim', group: 'alpha' }); // refused
  second.session.close(); // held nothing
  first.session.close();
  first.session.close(); // idempotent
  assert.deepEqual(calls, ['claim:alpha:group', 'release:alpha']);
});
```

Create `test/ws/session-index.test.ts`:

```ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createSessionIndex } from '../../src/ws/session-index.js';
import type { Session } from '../../src/ws/session.js';

const fake = (): Session => ({ role: { kind: 'none' }, send: () => {}, handle: () => {}, close: () => {} });

test('the index maps a group to its session and only that session can remove it', () => {
  const index = createSessionIndex();
  const a = fake();
  const b = fake();
  assert.equal(index.get('alpha'), undefined);
  index.add('alpha', a);
  assert.equal(index.get('alpha'), a);
  index.remove('alpha', b); // not the holder
  assert.equal(index.get('alpha'), a);
  index.remove('alpha', a);
  assert.equal(index.get('alpha'), undefined);
});
```

Create `test/ws/wire.test.ts`:

```ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { statusOf, toWsMessage } from '../../src/ws/wire.js';

const SALES = '918888800001';
const TILE = '919876543210';
const base = { wamid: 'wamid.MOCK-1', body: 'hi', created_at: 1000, delivered_at: null, read_at: null };

test('an outbound message: peer is the business (from), status follows the timestamps', () => {
  assert.deepEqual(
    toWsMessage({ ...base, direction: 'outbound', from_number: SALES, to_number: TILE, delivered_at: 1100 }),
    { wamid: 'wamid.MOCK-1', peer: SALES, direction: 'outbound', body: 'hi', status: 'delivered', created_at: 1000 },
  );
});

test('an inbound message: peer is the business (to)', () => {
  const m = toWsMessage({ ...base, direction: 'inbound', from_number: TILE, to_number: SALES });
  assert.equal(m.peer, SALES);
  assert.equal(m.direction, 'inbound');
  assert.equal(m.status, 'sent');
});

test('statusOf: read beats delivered beats sent', () => {
  assert.equal(statusOf({ delivered_at: null, read_at: null }), 'sent');
  assert.equal(statusOf({ delivered_at: 5, read_at: null }), 'delivered');
  assert.equal(statusOf({ delivered_at: 5, read_at: 6 }), 'read');
});
```

- [ ] **Step 2: Run the tests to check that they fail**

Run: `npm test`
Expected: FAIL — `session-index.test.ts` and `wire.test.ts` report `Cannot find module`; the new session test fails with `calls` equal to `[]` (hooks not called). The other 185 pass.

- [ ] **Step 3: Add the hooks to `src/ws/session.ts`**

In `interface SessionDeps`, after the `onGroupEvent` member, add:

```ts
  /** Called after a successful claim, once group.claimed has been sent. */
  onClaim?: (session: Session, groupId: string) => void;
  /** Called when a session that held a group closes, after its lock is released. */
  onRelease?: (session: Session, groupId: string) => void;
```

Replace the `close()` method with:

```ts
    close() {
      if (closed) return;
      closed = true;
      if (role.kind === 'group') {
        deps.lock.release(role.groupId, session);
        deps.onRelease?.(session, role.groupId);
      }
    },
```

At the end of `function claim`, replace the last two lines:

```ts
    role = { kind: 'group', groupId };
    session.send({ type: 'group.claimed', ...deps.groups.snapshot(groupId) });
```

with:

```ts
    role = { kind: 'group', groupId };
    session.send({ type: 'group.claimed', ...deps.groups.snapshot(groupId) });
    deps.onClaim?.(session, groupId);
```

- [ ] **Step 4: Create `src/ws/session-index.ts`**

```ts
// Which open session holds each group, so the bus and delivery can reach the tile's
// browser. Filled by the session hooks onClaim / onRelease (see src/live.ts).
import type { Session } from './session.js';

export interface SessionIndex {
  add(groupId: string, session: Session): void;
  /** Removes only if `session` is the one stored for the group. */
  remove(groupId: string, session: Session): void;
  get(groupId: string): Session | undefined;
}

export function createSessionIndex(): SessionIndex {
  const byGroup = new Map<string, Session>();
  return {
    add(groupId, session) {
      byGroup.set(groupId, session);
    },
    remove(groupId, session) {
      if (byGroup.get(groupId) === session) byGroup.delete(groupId);
    },
    get: (groupId) => byGroup.get(groupId),
  };
}
```

- [ ] **Step 5: Create `src/ws/wire.ts`**

```ts
// Stored messages (Person 2's rows) → contract chat bubbles. Pure: no DB, no sockets.
import type { MessageStatus, WsMessage } from '../contract/ws-events.js';
import type { StoredMessage } from '../core/ports.js';

type Row = Pick<
  StoredMessage,
  'wamid' | 'direction' | 'from_number' | 'to_number' | 'body' | 'created_at' | 'delivered_at' | 'read_at'
>;

export function statusOf(m: Pick<StoredMessage, 'delivered_at' | 'read_at'>): MessageStatus {
  return m.read_at ? 'read' : m.delivered_at ? 'delivered' : 'sent';
}

/** `peer` is the business display number on the other side of the chat. */
export function toWsMessage(m: Row): WsMessage {
  return {
    wamid: m.wamid,
    peer: m.direction === 'outbound' ? m.from_number : m.to_number,
    direction: m.direction,
    body: m.body,
    status: statusOf(m),
    created_at: m.created_at,
  };
}
```

- [ ] **Step 6: Run the tests to check that they pass**

Run: `npm test`
Expected: PASS, **190** tests, 0 failures.

- [ ] **Step 7: Typecheck and build**

Run: `npm run typecheck && npm run build`
Expected: both exit 0 with no `error TS` lines.

- [ ] **Step 8: Commit**

```bash
git add src/ws/session.ts src/ws/session-index.ts src/ws/wire.ts test/ws/session.test.ts test/ws/session-index.test.ts test/ws/wire.test.ts
git commit -m "feat(ws): session claim/release hooks, session index and wire format

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
```

---

### Task 2: Shared lock and snapshots from Person 2's store

**Files:**
- Create: `src/ws/shared-lock.ts`, `src/ws/store-groups.ts`
- Modify: `src/core/registry.ts` (lines 1–8: imports + the two placeholders)
- Test: `test/ws/store-groups.test.ts`

**Interfaces:**
- Consumes: `createLockTable` (`src/ws/lock.ts`); `GroupDirectory` (`src/ws/session.ts`); `toWsMessage` (Task 1); from P2 `src/core/registry.ts`: `listGroups(): GroupSummary[]`, `listGroupTiles(groupId): Customer[]` (`Customer.online` is `0 | 1`), `listBusinessNumbers()`, `getAutoReply(number): AutoReply | null`; from P2 `src/core/messages.ts`: `history(number)`, `queuedFor(number)`.
- Produces:
  - `const sharedLock: LockTable` (`src/ws/shared-lock.ts`)
  - `const storeGroups: GroupDirectory` (`src/ws/store-groups.ts`)

- [ ] **Step 1: Write the failing test**

Create `test/ws/store-groups.test.ts`:

```ts
import '../helpers/memory-db.js';
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { createGroup, listGroups, registerBusinessNumber, resetAll, setAutoReply } from '../../src/core/registry.js';
import { setDelivered, setRead, storeMessage } from '../../src/core/messages.js';
import { storeGroups } from '../../src/ws/store-groups.js';
import { sharedLock } from '../../src/ws/shared-lock.js';

const SALES = '918888800001';
const SUPPORT = '918888800002';
const T1 = '919876543210';
const T2 = '919876543211';

beforeEach(() => {
  resetAll(false);
  registerBusinessNumber({ display_number: SALES, label: 'Sales', phone_number_id: 'PN-1', waba_id: 'W-1', token: 'secret-1' });
  registerBusinessNumber({ display_number: SUPPORT, label: 'Support', phone_number_id: 'PN-2', waba_id: 'W-1', token: 'secret-2' });
  createGroup('Alpha', [T1, T2]);
});

const out = (from: string, to: string, body: string, at: number) =>
  storeMessage({ from, to, body, direction: 'outbound', source: 'api', at });

test('exists follows the groups table', () => {
  assert.equal(storeGroups.exists('alpha'), true);
  assert.equal(storeGroups.exists('nope'), false);
});

test('snapshot: group, business numbers without tokens, tiles in position order with defaults', () => {
  const snap = storeGroups.snapshot('alpha');
  assert.deepEqual(snap.group, { id: 'alpha', name: 'Alpha' });
  assert.deepEqual(
    [...snap.business_numbers].sort((a, b) => a.phone_number_id.localeCompare(b.phone_number_id)),
    [
      { phone_number_id: 'PN-1', display_number: SALES, label: 'Sales' },
      { phone_number_id: 'PN-2', display_number: SUPPORT, label: 'Support' },
    ],
  );
  assert.deepEqual(snap.tiles.map((t) => t.number), [T1, T2]);
  assert.deepEqual(snap.tiles[1], {
    number: T2,
    label: null,
    online: true,
    auto_reply: { mode: 'manual', delay_ms: 0, rules: [] },
    history: [],
    queued: [],
    unread: {},
  });
});

test('snapshot: history excludes the queue, unread counts per business, auto-reply config', () => {
  const m1 = out(SALES, T1, 'one', 1000);
  setDelivered(m1.wamid, 1001);
  setRead([m1.wamid], 1002);
  const m2 = out(SALES, T1, 'two', 1100);
  setDelivered(m2.wamid, 1101);
  const m3 = out(SUPPORT, T1, 'three', 1200);
  setDelivered(m3.wamid, 1201);
  storeMessage({ from: T1, to: SALES, body: 'reply', direction: 'inbound', source: 'tile', at: 1300 });
  const m4 = out(SALES, T1, 'four', 1400);
  const m5 = out(SALES, T1, 'five', 1500);
  setAutoReply(T1, { mode: 'keyword', delay_ms: 500, rules: [{ keyword: 'price', reply: 'how much?' }] });

  const tile = storeGroups.snapshot('alpha').tiles[0]!;
  assert.deepEqual(
    tile.history.map((m) => [m.body, m.peer, m.direction, m.status]),
    [
      ['one', SALES, 'outbound', 'read'],
      ['two', SALES, 'outbound', 'delivered'],
      ['three', SUPPORT, 'outbound', 'delivered'],
      ['reply', SALES, 'inbound', 'sent'],
    ],
  );
  assert.deepEqual(tile.queued.map((m) => m.wamid), [m4.wamid, m5.wamid]);
  assert.deepEqual(tile.unread, { [SALES]: 1, [SUPPORT]: 1 });
  assert.deepEqual(tile.auto_reply, { mode: 'keyword', delay_ms: 500, rules: [{ keyword: 'price', reply: 'how much?' }] });
});

test('the launch list (GET /api/groups data) reads the shared lock', () => {
  const owner = {};
  assert.equal(listGroups()[0]?.status, 'free');
  assert.equal(sharedLock.claim('alpha', owner).ok, true);
  const g = listGroups()[0]!;
  assert.equal(g.status, 'locked');
  assert.equal(typeof g.locked_since, 'number');
  sharedLock.release('alpha', owner);
  assert.equal(listGroups()[0]?.status, 'free');
});
```

- [ ] **Step 2: Run the test to check that it fails**

Run: `npm test`
Expected: FAIL — `store-groups.test.ts` reports `Cannot find module '../../src/ws/store-groups.js'`. The other 190 pass.

- [ ] **Step 3: Create `src/ws/shared-lock.ts`**

```ts
// The one lock table for the whole process: the /ws sessions take it and Person 2's
// registry reads it (launch-page free/locked, claim status, 409 on delete) (FR-09, FR-16).
import { createLockTable } from './lock.js';

export const sharedLock = createLockTable();
```

- [ ] **Step 4: Point Person 2's placeholders at the shared lock**

In `src/core/registry.ts`, replace:

```ts
import { randomUUID } from 'node:crypto';
import { db, now } from '../db/db.js';

// The session lock is owned by Person 3 (in-memory, ws/lock.ts). Until that lands,
// Person 2 treats every group as free/unlocked. Person 3 replaces these two shims
// with imports from ws/lock.ts at integration (checkpoint ①).
const isLocked = (_groupId: string): boolean => false;
const lockedSince = (_groupId: string): number | null => null;
```

with:

```ts
import { randomUUID } from 'node:crypto';
import { db, now } from '../db/db.js';
import { sharedLock } from '../ws/shared-lock.js';

// The session lock is owned by Person 3 (in memory, ws/shared-lock.ts): the /ws
// sessions take it; the registry only reads it.
const isLocked = (groupId: string): boolean => sharedLock.isLocked(groupId);
const lockedSince = (groupId: string): number | null => sharedLock.lockedSince(groupId);
```

- [ ] **Step 5: Create `src/ws/store-groups.ts`**

```ts
// GroupDirectory on Person 2's SQLite store: what /ws needs to claim a group and render
// its grid from the snapshot alone (contract Snapshot, plan §11c).
import type { Snapshot, Tile } from '../contract/ws-events.js';
import type { GroupDirectory } from './session.js';
import { getAutoReply, listBusinessNumbers, listGroupTiles, listGroups, type Customer } from '../core/registry.js';
import { history, queuedFor } from '../core/messages.js';
import { toWsMessage } from './wire.js';

function tileOf(c: Customer): Tile {
  const queued = queuedFor(c.number);
  const queuedIds = new Set(queued.map((m) => m.wamid));
  const past = history(c.number).filter((m) => !queuedIds.has(m.wamid));
  const unread: Record<string, number> = {};
  for (const m of past) {
    if (m.direction === 'outbound' && m.delivered_at && !m.read_at) {
      unread[m.from_number] = (unread[m.from_number] ?? 0) + 1;
    }
  }
  return {
    number: c.number,
    label: c.label,
    online: Boolean(c.online),
    auto_reply: getAutoReply(c.number) ?? { mode: 'manual', delay_ms: 0, rules: [] },
    history: past.map(toWsMessage),
    queued: queued.map(toWsMessage),
    unread,
  };
}

export const storeGroups: GroupDirectory = {
  exists: (groupId) => listGroups().some((g) => g.id === groupId),

  snapshot(groupId): Snapshot {
    const group = listGroups().find((g) => g.id === groupId);
    if (!group) throw new Error(`unknown group: ${groupId}`);
    return {
      group: { id: group.id, name: group.name },
      business_numbers: listBusinessNumbers().map((b) => ({
        phone_number_id: b.phone_number_id,
        display_number: b.display_number,
        label: b.label,
      })),
      tiles: listGroupTiles(groupId).map(tileOf),
    };
  },
};
```

- [ ] **Step 6: Run the tests to check that they pass**

Run: `npm test`
Expected: PASS, **194** tests, 0 failures.

- [ ] **Step 7: Typecheck and build**

Run: `npm run typecheck && npm run build`
Expected: both exit 0 with no `error TS` lines.

- [ ] **Step 8: Commit**

```bash
git add src/ws/shared-lock.ts src/ws/store-groups.ts src/core/registry.ts test/ws/store-groups.test.ts
git commit -m "feat(ws): shared group lock read by the registry; snapshots from P2's store

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
```

---

### Task 3: Live delivery (Person 1's `Delivery` port)

**Files:**
- Create: `src/core/delivery.ts`
- Test: `test/core/delivery.test.ts`

**Interfaces:**
- Consumes: `Customer`, `Delivery`, `StoredMessage` (`src/core/ports.ts`; `Customer.online` is boolean); `SessionIndex` (Task 1); `Session` (`src/ws/session.ts`); `toWsMessage` (Task 1).
- Produces:
  - `interface LiveDeliveryDeps { sessions: SessionIndex; getCustomer(number: string): Customer | null; listGroupTiles(groupId: string): Array<{ number: string }>; queuedFor(number: string): StoredMessage[]; delivered(msgs: StoredMessage[]): void; inbound(from: string, to: string, body: string, source: 'autoreply'): unknown; computeReply(number: string, body: string): { reply: string; delay_ms: number } | null; log?: (line: string) => void }`
  - `interface LiveDelivery extends Delivery { isOnline(number: string): boolean; deliverQueued(groupId: string): void }`
  - `function createLiveDelivery(d: LiveDeliveryDeps): LiveDelivery`

- [ ] **Step 1: Write the failing test**

Create `test/core/delivery.test.ts`:

```ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createLiveDelivery, type LiveDeliveryDeps } from '../../src/core/delivery.js';
import { createSessionIndex } from '../../src/ws/session-index.js';
import type { Session } from '../../src/ws/session.js';
import type { Customer, StoredMessage } from '../../src/core/ports.js';
import type { AdminEvent, ServerEvent } from '../../src/contract/ws-events.js';

const SALES = '918888800001';
const T1 = '919876543210';
const T2 = '919876543211';
const tick = (ms = 5) => new Promise((resolve) => setTimeout(resolve, ms));

function fakeSession(groupId: string) {
  const sent: Array<ServerEvent | AdminEvent> = [];
  const session: Session = {
    role: { kind: 'group', groupId },
    send: (ev) => {
      sent.push(ev);
    },
    handle: () => {},
    close: () => {},
  };
  return { session, sent };
}

let n = 0;
function msg(o: Partial<StoredMessage> = {}): StoredMessage {
  n++;
  return {
    wamid: `wamid.MOCK-${n}`,
    conversation_id: 1,
    seq: n,
    direction: 'outbound',
    source: 'api',
    phone_number_id: 'PN-1',
    customer_number: T1,
    from_number: SALES,
    to_number: T1,
    body: `m${n}`,
    created_at: 1000 + n,
    sent_at: 1000 + n,
    delivered_at: null,
    read_at: null,
    ...o,
  };
}

function setup(o: {
  online?: Record<string, boolean>;
  queued?: Record<string, StoredMessage[]>;
  reply?: { reply: string; delay_ms: number } | null;
} = {}) {
  const customers: Record<string, Customer> = {
    [T1]: { number: T1, group_id: 'alpha', label: null, online: o.online?.[T1] ?? true },
    [T2]: { number: T2, group_id: 'alpha', label: null, online: o.online?.[T2] ?? true },
  };
  const sessions = createSessionIndex();
  const delivered: StoredMessage[][] = [];
  const inbound: unknown[][] = [];
  const deps: LiveDeliveryDeps = {
    sessions,
    getCustomer: (number) => customers[number] ?? null,
    listGroupTiles: (groupId) => Object.values(customers).filter((c) => c.group_id === groupId),
    queuedFor: (number) => o.queued?.[number] ?? [],
    delivered: (msgs) => {
      delivered.push(msgs);
    },
    inbound: (...args) => {
      inbound.push(args);
    },
    computeReply: () => o.reply ?? null,
  };
  return { delivery: createLiveDelivery(deps), sessions, customers, delivered, inbound };
}

test('an online tile in a claimed group gets message.new, then the message is delivered', () => {
  const { delivery, sessions, delivered } = setup();
  const { session, sent } = fakeSession('alpha');
  sessions.add('alpha', session);
  const m = msg();
  assert.equal(delivery.deliver(m), 'delivered');
  assert.deepEqual(sent, [
    {
      type: 'message.new',
      to: T1,
      number: T1,
      message: { wamid: m.wamid, peer: SALES, direction: 'outbound', body: m.body, status: 'sent', created_at: m.created_at },
    },
  ]);
  assert.deepEqual(delivered, [[m]]);
});

test('a tile whose flag is off keeps the message queued', () => {
  const { delivery, sessions, delivered } = setup({ online: { [T1]: false } });
  const { session, sent } = fakeSession('alpha');
  sessions.add('alpha', session);
  assert.equal(delivery.deliver(msg()), 'queued');
  assert.deepEqual(sent, []);
  assert.deepEqual(delivered, []);
});

test('a tile whose group is not claimed keeps the message queued', () => {
  const { delivery, delivered } = setup();
  assert.equal(delivery.deliver(msg()), 'queued');
  assert.deepEqual(delivered, []);
});

test('an unknown customer keeps the message queued', () => {
  const { delivery, sessions, delivered } = setup();
  sessions.add('alpha', fakeSession('alpha').session);
  assert.equal(delivery.deliver(msg({ customer_number: '910000000000', to_number: '910000000000' })), 'queued');
  assert.deepEqual(delivered, []);
});

test('auto-reply is sent after its delay while the tile is still online', async () => {
  const { delivery, sessions, inbound } = setup({ reply: { reply: 'how much?', delay_ms: 0 } });
  sessions.add('alpha', fakeSession('alpha').session);
  delivery.deliver(msg());
  assert.deepEqual(inbound, []); // never synchronously
  await tick(10);
  assert.deepEqual(inbound, [[T1, 'PN-1', 'how much?', 'autoreply']]);
});

test('auto-reply is dropped if the tile went offline during the delay', async () => {
  const { delivery, sessions, customers, inbound } = setup({ reply: { reply: 'x', delay_ms: 20 } });
  sessions.add('alpha', fakeSession('alpha').session);
  delivery.deliver(msg());
  customers[T1]!.online = false;
  await tick(40);
  assert.deepEqual(inbound, []);
});

test('deliverQueued delivers online tiles only, without pushing message.new', () => {
  const q1 = [msg(), msg()];
  const q2 = [msg({ customer_number: T2, to_number: T2 })];
  const { delivery, sessions, delivered } = setup({ online: { [T2]: false }, queued: { [T1]: q1, [T2]: q2 } });
  const { session, sent } = fakeSession('alpha');
  sessions.add('alpha', session);
  delivery.deliverQueued('alpha');
  assert.deepEqual(delivered, [q1]);
  assert.deepEqual(sent, []);
});

test('deliverQueued without an open session does nothing; isOnline needs a session', () => {
  const { delivery, sessions, delivered } = setup({ queued: { [T1]: [msg()] } });
  delivery.deliverQueued('alpha');
  assert.deepEqual(delivered, []);
  assert.equal(delivery.isOnline(T1), false);
  sessions.add('alpha', fakeSession('alpha').session);
  assert.equal(delivery.isOnline(T1), true);
});
```

- [ ] **Step 2: Run the test to check that it fails**

Run: `npm test`
Expected: FAIL — `delivery.test.ts` reports `Cannot find module '../../src/core/delivery.js'`. The other 194 pass.

- [ ] **Step 3: Create `src/core/delivery.ts`**

```ts
// Person 3's Delivery (Person 1's port, plan §13a–§13c). A tile is effectively online
// when its group is claimed by an open /ws session AND its tile flag is on. Then an
// outbound message is pushed as message.new and marked delivered (Person 1 fires the
// webhook); otherwise it stays queued until the group is claimed again (deliverQueued)
// or the tile comes back online (next step). Delivery also triggers Person 2's
// auto-reply engine (FR-10, plan §14).
import type { Customer, Delivery, StoredMessage } from './ports.js';
import type { Session } from '../ws/session.js';
import type { SessionIndex } from '../ws/session-index.js';
import { toWsMessage } from '../ws/wire.js';

export interface LiveDeliveryDeps {
  sessions: SessionIndex;
  getCustomer(number: string): Customer | null;
  listGroupTiles(groupId: string): Array<{ number: string }>;
  /** Outbound, not yet delivered, per conversation in seq order (Person 2). */
  queuedFor(number: string): StoredMessage[];
  /** Person 1's lifecycle.delivered: marks delivered + queues the webhooks. */
  delivered(msgs: StoredMessage[]): void;
  /** Person 1's lifecycle.inbound, used to send auto-replies. */
  inbound(from: string, to: string, body: string, source: 'autoreply'): unknown;
  /** Person 2's auto-reply engine. */
  computeReply(number: string, body: string): { reply: string; delay_ms: number } | null;
  log?: (line: string) => void;
}

export interface LiveDelivery extends Delivery {
  isOnline(number: string): boolean;
  /** After a claim: mark every online tile's queue delivered (no message.new — it is in the snapshot). */
  deliverQueued(groupId: string): void;
}

export function createLiveDelivery(d: LiveDeliveryDeps): LiveDelivery {
  const log = d.log ?? (() => {});

  /** The session showing this tile, if the tile is effectively online. */
  function sessionFor(number: string): Session | undefined {
    const c = d.getCustomer(number);
    return c && c.online ? d.sessions.get(c.group_id) : undefined;
  }

  const isOnline = (number: string): boolean => sessionFor(number) !== undefined;

  function autoReply(m: StoredMessage): void {
    const r = d.computeReply(m.customer_number, m.body);
    if (!r) return;
    setTimeout(() => {
      if (!isOnline(m.customer_number)) return; // an offline customer does not talk
      try {
        d.inbound(m.customer_number, m.phone_number_id, r.reply, 'autoreply');
        log(`[auto-reply] ${m.customer_number} → ${r.reply}`);
      } catch (err) {
        log(`[auto-reply] failed: ${(err as Error).message}`);
      }
    }, r.delay_ms);
  }

  return {
    isOnline,

    deliver(m) {
      if (m.direction !== 'outbound') return 'queued';
      const session = sessionFor(m.customer_number);
      if (!session) return 'queued';
      session.send({ type: 'message.new', to: m.customer_number, number: m.customer_number, message: toWsMessage(m) });
      d.delivered([m]);
      autoReply(m);
      return 'delivered';
    },

    deliverQueued(groupId) {
      if (!d.sessions.get(groupId)) return;
      for (const tile of d.listGroupTiles(groupId)) {
        if (!isOnline(tile.number)) continue;
        const msgs = d.queuedFor(tile.number);
        if (msgs.length === 0) continue;
        d.delivered(msgs);
        msgs.forEach(autoReply);
      }
    },
  };
}
```

- [ ] **Step 4: Run the tests to check that they pass**

Run: `npm test`
Expected: PASS, **202** tests, 0 failures.

- [ ] **Step 5: Typecheck and build**

Run: `npm run typecheck && npm run build`
Expected: both exit 0 with no `error TS` lines.

- [ ] **Step 6: Commit**

```bash
git add src/core/delivery.ts test/core/delivery.test.ts
git commit -m "feat(core): live delivery — push to open tiles, queue otherwise, auto-reply trigger

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
```

---

### Task 4: Live bus (Person 1's `Bus` port)

**Files:**
- Create: `src/core/bus.ts`
- Test: `test/core/bus.test.ts`

**Interfaces:**
- Consumes: `Bus`, `BusEvent`, `Customer`, `StoredMessage` (`src/core/ports.ts`); `SessionIndex` (Task 1); `toWsMessage` (Task 1).
- Produces:
  - `interface LiveBusDeps { sessions: SessionIndex; getCustomer(number: string): Customer | null; log?: (line: string) => void }`
  - `function createLiveBus(d: LiveBusDeps): Bus`

- [ ] **Step 1: Write the failing test**

Create `test/core/bus.test.ts`:

```ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createLiveBus } from '../../src/core/bus.js';
import { createSessionIndex } from '../../src/ws/session-index.js';
import type { Session } from '../../src/ws/session.js';
import type { Customer, StoredMessage } from '../../src/core/ports.js';
import type { AdminEvent, ServerEvent } from '../../src/contract/ws-events.js';

const SALES = '918888800001';
const T1 = '919876543210';

function setup() {
  const customers: Record<string, Customer> = { [T1]: { number: T1, group_id: 'alpha', label: null, online: true } };
  const sessions = createSessionIndex();
  const sent: Array<ServerEvent | AdminEvent> = [];
  const session: Session = {
    role: { kind: 'group', groupId: 'alpha' },
    send: (ev) => {
      sent.push(ev);
    },
    handle: () => {},
    close: () => {},
  };
  const logs: string[] = [];
  const bus = createLiveBus({ sessions, getCustomer: (n) => customers[n] ?? null, log: (l) => logs.push(l) });
  return { bus, sessions, session, sent, logs };
}

const stored = (o: Partial<StoredMessage>): StoredMessage => ({
  wamid: 'wamid.MOCK-1',
  conversation_id: 1,
  seq: 1,
  direction: 'inbound',
  source: 'inject',
  phone_number_id: 'PN-1',
  customer_number: T1,
  from_number: T1,
  to_number: SALES,
  body: 'how much?',
  created_at: 1000,
  sent_at: null,
  delivered_at: null,
  read_at: null,
  ...o,
});

test('message.status goes to the session holding the tile group', () => {
  const { bus, sessions, session, sent, logs } = setup();
  sessions.add('alpha', session);
  bus.emit({ type: 'message.status', wamid: 'w1', number: T1, status: 'delivered', at: 5 });
  assert.deepEqual(sent, [{ type: 'message.status', wamid: 'w1', number: T1, status: 'delivered', at: 5 }]);
  assert.equal(logs.length, 1);
});

test('an inbound message.new shows in the tile, addressed to the business', () => {
  const { bus, sessions, session, sent } = setup();
  sessions.add('alpha', session);
  bus.emit({ type: 'message.new', message: stored({}) });
  assert.deepEqual(sent, [
    {
      type: 'message.new',
      to: SALES,
      number: T1,
      message: { wamid: 'wamid.MOCK-1', peer: SALES, direction: 'inbound', body: 'how much?', status: 'sent', created_at: 1000 },
    },
  ]);
});

test('an outbound message.new is ignored (delivery pushes outbound bubbles)', () => {
  const { bus, sessions, session, sent } = setup();
  sessions.add('alpha', session);
  bus.emit({
    type: 'message.new',
    message: stored({ direction: 'outbound', source: 'api', from_number: SALES, to_number: T1 }),
  });
  assert.deepEqual(sent, []);
});

test('no open session, or an unknown customer, sends nothing', () => {
  const { bus, sessions, session, sent } = setup();
  bus.emit({ type: 'message.status', wamid: 'w1', number: T1, status: 'read', at: 5 });
  sessions.add('alpha', session);
  bus.emit({ type: 'message.status', wamid: 'w2', number: '910000000000', status: 'read', at: 6 });
  assert.deepEqual(sent, []);
});

test('admin-feed events are ignored for now', () => {
  const { bus, sessions, session, sent } = setup();
  sessions.add('alpha', session);
  bus.emit({ type: 'log.changed', wamid: 'w1' });
  bus.emit({ type: 'webhook.verify', ok: true, at: 1, detail: 'ok' });
  assert.deepEqual(sent, []);
});
```

- [ ] **Step 2: Run the test to check that it fails**

Run: `npm test`
Expected: FAIL — `bus.test.ts` reports `Cannot find module '../../src/core/bus.js'`. The other 202 pass.

- [ ] **Step 3: Create `src/core/bus.ts`**

```ts
// Person 3's Bus (Person 1's port): turns lifecycle and dispatcher events into /ws frames
// for the session that holds the tile's group. Outbound bubbles are pushed by delivery;
// the bus shows inbound bubbles and status ticks. Admin-feed events (log.changed,
// webhook.verify) are ignored until the admin feed lands (next step).
import type { Bus, BusEvent, Customer } from './ports.js';
import type { SessionIndex } from '../ws/session-index.js';
import { toWsMessage } from '../ws/wire.js';

export interface LiveBusDeps {
  sessions: SessionIndex;
  getCustomer(number: string): Customer | null;
  log?: (line: string) => void;
}

export function createLiveBus(d: LiveBusDeps): Bus {
  const log = d.log ?? (() => {});

  const sessionFor = (number: string) => {
    const c = d.getCustomer(number);
    return c ? d.sessions.get(c.group_id) : undefined;
  };

  return {
    emit(e: BusEvent) {
      switch (e.type) {
        case 'message.new': {
          const m = e.message;
          log(`[bus] new ${m.direction} ${m.wamid}`);
          if (m.direction !== 'inbound') return;
          sessionFor(m.customer_number)?.send({
            type: 'message.new',
            to: m.to_number,
            number: m.customer_number,
            message: toWsMessage(m),
          });
          return;
        }
        case 'message.status':
          log(`[bus] ${e.status.padEnd(9)} ${e.wamid} → ${e.number}`);
          sessionFor(e.number)?.send({ type: 'message.status', wamid: e.wamid, number: e.number, status: e.status, at: e.at });
          return;
        default:
          return; // log.changed, webhook.verify → admin feed (next step)
      }
    },
  };
}
```

- [ ] **Step 4: Run the tests to check that they pass**

Run: `npm test`
Expected: PASS, **207** tests, 0 failures.

- [ ] **Step 5: Typecheck and build**

Run: `npm run typecheck && npm run build`
Expected: both exit 0 with no `error TS` lines.

- [ ] **Step 6: Commit**

```bash
git add src/core/bus.ts test/core/bus.test.ts
git commit -m "feat(core): live bus — inbound bubbles and status ticks to the open tile

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
```

---

### Task 5: Assemble the live engine and switch the app to it

**Files:**
- Create: `src/live.ts`, `test/e2e/live.e2e.test.ts`
- Modify: `src/compose.ts`, `src/index.ts`, `test/e2e/integrated.e2e.test.ts`, `test/e2e/ws.e2e.test.ts`
- Delete: `src/dev/interim-delivery.ts`

**Interfaces:**
- Consumes: Tasks 1–4; `attachWsServer`, `WsServer` (`src/ws/server.ts`); `Lifecycle` (`src/core/lifecycle.ts`); `sqliteRegistry` (`src/core/registry-adapter.ts`); `listGroupTiles` (`src/core/registry.ts`); `queuedFor` (`src/core/messages.ts`); `computeReply` (`src/core/autoreply.ts`).
- Produces:
  - `interface LiveEngineDeps { lifecycle: () => Pick<Lifecycle, 'delivered' | 'inbound'> | undefined; log?: (line: string) => void; lock?: LockTable; groups?: GroupDirectory }`
  - `interface LiveEngine { bus: Bus; delivery: LiveDelivery; sessions: SessionIndex; attach(http: Server, opts?: { heartbeatMs?: number }): WsServer }`
  - `function createLiveEngine(d: LiveEngineDeps): LiveEngine`
  - `composeServer()` now also returns `live: LiveEngine`

- [ ] **Step 1: Write the failing end-to-end test**

Create `test/e2e/live.e2e.test.ts`:

```ts
// P1 + P2 + P3 integrated: a signature-checking fake Comdove → Meta face → SQLite → live
// delivery over a real /ws socket. Checkpoint ①: a Comdove send shows in the open tile in
// < 1 s and only then fires 'delivered'; a closed group queues until it is reopened.
import '../helpers/memory-db.js';
import { test, before, after, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { WebSocket } from 'ws';
import { composeServer } from '../../src/compose.js';
import { createFakeComdove } from '../../tools/fake-comdove-app.js';
import { listen, waitFor } from '../helpers/http.js';
import { sharedLock } from '../../src/ws/shared-lock.js';

type Frame = Record<string, any>;

const SECRET = 'live-secret';
const SALES = '918888800001';
const T1 = '919876543210';
const T2 = '919876543211';

let comdove: ReturnType<typeof createFakeComdove>;
let base = '';
let closeAll: () => Promise<void>;
const tabs: WebSocket[] = [];

before(async () => {
  comdove = createFakeComdove({ appSecret: SECRET, verifyToken: 'live-verify' });
  const c = await listen(comdove.app);
  const composed = composeServer({
    env: { COMDOVE_WEBHOOK_URL: `${c.base}/webhooks/whatsapp`, APP_SECRET: SECRET, WEBHOOK_VERIFY_TOKEN: 'live-verify', STATUS_WEBHOOK_DELAY_MS: 30 },
    dispatcher: { retryDelaysMs: [10, 10, 10], timeoutMs: 500 },
    log: () => {},
  });
  const m = await listen(composed.app);
  const wss = composed.live.attach(m.server, { heartbeatMs: 60_000 });
  base = m.base;
  closeAll = async () => {
    composed.metaFace.dispatcher.cancelAll();
    await wss.close();
    await m.close();
    await c.close();
  };
});
after(() => closeAll());

const api = async (method: string, path: string, body?: unknown, headers: Record<string, string> = {}) => {
  const res = await fetch(base + path, { method, headers: { 'Content-Type': 'application/json', ...headers }, body: body === undefined ? undefined : JSON.stringify(body) });
  const text = await res.text();
  return { status: res.status, json: text ? JSON.parse(text) : null };
};
const send = (to: string, text: string) =>
  api('POST', '/v23.0/PN-1/messages', { messaging_product: 'whatsapp', to, type: 'text', text: { body: text } }, { Authorization: 'Bearer tok-1' });
const received = () => comdove.received.filter((r) => r.status === 200).map((r) => [r.kind, r.wamid]);
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

beforeEach(async () => {
  await api('POST', '/api/reset', { keep_numbers: false });
  comdove.received.length = 0;
  assert.equal((await api('POST', '/api/business-numbers', { display_number: SALES, label: 'Sales', phone_number_id: 'PN-1', waba_id: 'WABA-1', token: 'tok-1' })).status, 200);
  assert.equal((await api('POST', '/api/groups', { name: 'alpha', numbers: [T1, T2] })).status, 200);
});

afterEach(async () => {
  for (const t of tabs.splice(0)) t.close();
  await waitFor(() => !sharedLock.isLocked('alpha'));
});

/** A browser tab that claims `group` and records every frame it receives. */
async function openTab(group = 'alpha') {
  const ws = new WebSocket(base.replace('http', 'ws') + '/ws');
  tabs.push(ws);
  const frames: Frame[] = [];
  ws.on('message', (data) => frames.push(JSON.parse(String(data)) as Frame));
  await new Promise((resolve, reject) => {
    ws.once('open', resolve);
    ws.once('error', reject);
  });
  ws.send(JSON.stringify({ type: 'group.claim', group }));
  await waitFor(() => frames.length > 0);
  assert.equal(frames[0]?.type, 'group.claimed');
  return { ws, frames, of: (type: string) => frames.filter((f) => f.type === type) };
}

test('online tile: message.new in < 1 s, then the delivered tick and sent + delivered webhooks', async () => {
  const tab = await openTab();
  const t0 = Date.now();
  const r = await send(T1, 'Hello');
  const wamid = r.json.messages[0].id;
  await waitFor(() => tab.of('message.new').length === 1);
  assert.ok(Date.now() - t0 < 1000, 'reached the tile in under a second');
  const bubble = tab.of('message.new')[0]!;
  assert.deepEqual([bubble.to, bubble.number], [T1, T1]);
  assert.deepEqual(
    [bubble.message.wamid, bubble.message.peer, bubble.message.direction, bubble.message.body],
    [wamid, SALES, 'outbound', 'Hello'],
  );
  await waitFor(() => tab.of('message.status').some((f) => f.wamid === wamid && f.status === 'delivered'));
  await waitFor(() => received().length === 2);
  assert.deepEqual(received(), [['sent', wamid], ['delivered', wamid]]);
  assert.ok(comdove.received.every((x) => x.signatureValid));
});

test('closed group: messages queue; reopening shows them in queued and delivers them in order', async () => {
  const a = await send(T1, 'first');
  const b = await send(T1, 'second');
  await waitFor(() => received().length === 2);
  await sleep(80);
  assert.deepEqual(received().map((x) => x[0]), ['sent', 'sent']);

  const tab = await openTab();
  const tile = (tab.frames[0]!.tiles as Frame[]).find((t) => t.number === T1)!;
  assert.deepEqual(tile.queued.map((m: Frame) => m.body), ['first', 'second']);
  assert.deepEqual(tile.history, []);

  await waitFor(() => received().length === 4);
  assert.deepEqual(received().slice(2), [
    ['delivered', a.json.messages[0].id],
    ['delivered', b.json.messages[0].id],
  ]);
  await waitFor(() => tab.of('message.status').length === 2);
  assert.equal(tab.of('message.new').length, 0, 'queued messages come in the snapshot, not as message.new');
});

test('a tile switched off keeps its messages queued even while the group is open', async () => {
  await api('POST', '/api/presence', { number: T2, online: false });
  const tab = await openTab();
  const r = await send(T2, 'are you there?');
  await waitFor(() => received().length === 1);
  await sleep(80);
  assert.deepEqual(received(), [['sent', r.json.messages[0].id]]);
  assert.equal(tab.of('message.new').length, 0);
});

test('/api/inject shows the inbound message in the open tile', async () => {
  const tab = await openTab();
  const r = await api('POST', '/api/inject', { from: T1, to: SALES, body: 'how much?' });
  assert.equal(r.status, 200);
  await waitFor(() => tab.of('message.new').length === 1);
  const f = tab.of('message.new')[0]!;
  assert.deepEqual(
    [f.to, f.number, f.message.wamid, f.message.direction, f.message.peer, f.message.body],
    [SALES, T1, r.json.wamid, 'inbound', SALES, 'how much?'],
  );
});

test('the launch list shows the group locked while a tab holds it', async () => {
  assert.equal((await api('GET', '/api/groups')).json[0].status, 'free');
  const tab = await openTab();
  const g = (await api('GET', '/api/groups')).json[0];
  assert.equal(g.status, 'locked');
  assert.equal(typeof g.locked_since, 'number');
  tab.ws.close();
  await waitFor(() => !sharedLock.isLocked('alpha'));
  assert.equal((await api('GET', '/api/groups')).json[0].status, 'free');
});
```

- [ ] **Step 2: Run the test to check that it fails**

Run: `npm test`
Expected: FAIL — `live.e2e.test.ts` fails in `before` with `TypeError: Cannot read properties of undefined (reading 'attach')` (`composed.live` does not exist yet). The other 207 pass.

- [ ] **Step 3: Create `src/live.ts`**

```ts
// Person 3's live engine, assembled: one SessionIndex shared by the /ws sessions, the
// bus and the delivery. composeServer() builds it; index.ts attaches it to the server.
import type { Server } from 'node:http';
import type { Bus } from './core/ports.js';
import type { Lifecycle } from './core/lifecycle.js';
import { sqliteRegistry } from './core/registry-adapter.js';
import { listGroupTiles } from './core/registry.js';
import { queuedFor } from './core/messages.js';
import { computeReply } from './core/autoreply.js';
import { createLiveBus } from './core/bus.js';
import { createLiveDelivery, type LiveDelivery } from './core/delivery.js';
import { createSessionIndex, type SessionIndex } from './ws/session-index.js';
import { sharedLock } from './ws/shared-lock.js';
import { storeGroups } from './ws/store-groups.js';
import { attachWsServer, type WsServer } from './ws/server.js';
import type { LockTable } from './ws/lock.js';
import type { GroupDirectory } from './ws/session.js';

export interface LiveEngineDeps {
  /** Late-bound: the Meta face (and its lifecycle) is built after the live engine. */
  lifecycle: () => Pick<Lifecycle, 'delivered' | 'inbound'> | undefined;
  log?: (line: string) => void;
  lock?: LockTable;
  groups?: GroupDirectory;
}

export interface LiveEngine {
  bus: Bus;
  delivery: LiveDelivery;
  sessions: SessionIndex;
  attach(http: Server, opts?: { heartbeatMs?: number }): WsServer;
}

export function createLiveEngine(d: LiveEngineDeps): LiveEngine {
  const sessions = createSessionIndex();
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
  const bus = createLiveBus({ sessions, getCustomer: sqliteRegistry.getCustomer, log: d.log });

  return {
    bus,
    delivery,
    sessions,
    attach(http, opts = {}) {
      return attachWsServer(http, {
        lock: d.lock ?? sharedLock,
        groups: d.groups ?? storeGroups,
        onClaim: (session, groupId) => {
          sessions.add(groupId, session);
          delivery.deliverQueued(groupId);
        },
        onRelease: (session, groupId) => sessions.remove(groupId, session),
        ...(opts.heartbeatMs !== undefined && { heartbeatMs: opts.heartbeatMs }),
      });
    },
  };
}
```

- [ ] **Step 4: Switch `src/compose.ts` to the live engine**

Replace the import line:

```ts
import { createInterimDelivery } from './dev/interim-delivery.js';
```

with:

```ts
import { createLiveEngine } from './live.js';
```

Replace this block:

```ts
  const bus: Bus = o.bus ?? {
    emit(e: BusEvent) {
      if (e.type === 'message.status') log(`[bus] ${e.status.padEnd(9)} ${e.wamid} → ${e.number}`);
      if (e.type === 'message.new') log(`[bus] new ${e.message.direction} ${e.message.wamid}`);
    },
  };

  // Delivery and the Meta face reference each other (delivered → lifecycle), so late-bind.
  let lifecycleRef: ReturnType<typeof createMetaFace>['lifecycle'] | undefined;
  const delivery = createInterimDelivery({
    registry: sqliteRegistry,
    delivered: (msgs) => lifecycleRef?.delivered(msgs),
    inbound: (from, to, body, source) => lifecycleRef?.inbound(from, to, body, source),
    log,
  });
```

with:

```ts
  // P3's live engine (/ws sessions, bus, delivery). Delivery and the Meta face reference
  // each other (delivered → lifecycle), so the lifecycle is late-bound.
  let lifecycleRef: ReturnType<typeof createMetaFace>['lifecycle'] | undefined;
  const live = createLiveEngine({ lifecycle: () => lifecycleRef, log });
  const extraBus = o.bus;
  const bus: Bus = extraBus
    ? {
        emit(e: BusEvent) {
          live.bus.emit(e);
          extraBus.emit(e); // tests may listen in
        },
      }
    : live.bus;
  const delivery = live.delivery;
```

Replace the return line:

```ts
  return { app, metaFace, delivery, bus };
```

with:

```ts
  return { app, metaFace, delivery, bus, live };
```

Also update the file's header comment, replacing:

```ts
// Builds the whole server: P2's SQLite store + control API, P1's Meta face, and the
// interim delivery until P3's live engine lands. Used by src/index.ts and the
// integrated e2e test, so tests exercise the exact boot wiring.
```

with:

```ts
// Builds the whole server: P2's SQLite store + control API, P1's Meta face and P3's
// live engine (attach it with live.attach(server)). Used by src/index.ts and the
// integrated e2e tests, so tests exercise the exact boot wiring.
```

- [ ] **Step 5: Delete the interim delivery**

Run: `git rm src/dev/interim-delivery.ts`
Then check nothing imports it: `grep -rn "interim-delivery" src test tools`
Expected: no output.

- [ ] **Step 6: Replace `src/index.ts`**

```ts
import { env } from './config/env.js';
import { composeServer } from './compose.js';
import { services } from './core/services.js';

// P2 store + control API (Swagger at /docs) + P1 Meta face + P3 live engine (/ws).
const { app, metaFace, live } = composeServer();

const server = app.listen(env.PORT, () => {
  console.log(`🟢 comdove-fake-backend listening on http://localhost:${env.PORT}  (API docs: /docs)`);
  console.log(`🔌 WebSocket on ws://localhost:${env.PORT}/ws`);
  console.log(`   webhooks → ${env.COMDOVE_WEBHOOK_URL}`);
  metaFace.start(); // resume webhooks left pending by a previous run
  void services.verify!().then((r) =>
    console.log(r.ok ? '🤝 webhook handshake ok' : `⚠️  webhook handshake failed: ${r.detail} (continuing)`),
  );
});

// /ws: group sessions on P2's store, the shared lock, heartbeat and live delivery.
live.attach(server, { heartbeatMs: env.WS_HEARTBEAT_MS });
```

- [ ] **Step 7: Update Person 1's integrated test — delivery now needs an open group**

In `test/e2e/integrated.e2e.test.ts`:

Replace the import line:

```ts
import { test, before, after, beforeEach } from 'node:test';
```

with:

```ts
import { test, before, after, beforeEach, afterEach } from 'node:test';
import { WebSocket } from 'ws';
import { sharedLock } from '../../src/ws/shared-lock.js';
```

Replace:

```ts
  const m = await listen(composed.app);
  base = m.base;
  closeAll = async () => { composed.metaFace.dispatcher.cancelAll(); await m.close(); await c.close(); };
```

with:

```ts
  const m = await listen(composed.app);
  const wss = composed.live.attach(m.server, { heartbeatMs: 60_000 });
  base = m.base;
  closeAll = async () => { composed.metaFace.dispatcher.cancelAll(); await wss.close(); await m.close(); await c.close(); };
```

At the end of the existing `beforeEach` body (after the `/api/groups` assertion), add:

```ts
  tab = await openGroup('alpha');
```

Directly after the whole `beforeEach(...)` call, add:

```ts
afterEach(async () => {
  tab?.close();
  tab = undefined;
  await waitFor(() => !sharedLock.isLocked('alpha'));
});

// Delivery needs an open group (P3, plan §13a): a browser tab claims `alpha` for each test.
let tab: WebSocket | undefined;
async function openGroup(group: string): Promise<WebSocket> {
  const ws = new WebSocket(base.replace('http', 'ws') + '/ws');
  await new Promise((resolve, reject) => {
    ws.once('open', resolve);
    ws.once('error', reject);
  });
  const claimed = new Promise<void>((resolve, reject) =>
    ws.once('message', (data) => (JSON.parse(String(data)).type === 'group.claimed' ? resolve() : reject(new Error(String(data))))),
  );
  ws.send(JSON.stringify({ type: 'group.claim', group }));
  await claimed;
  return ws;
}
```

- [ ] **Step 8: Update our `ws.e2e` test — groups come from SQLite now**

In `test/e2e/ws.e2e.test.ts`, inside `startApp`, replace:

```ts
  if (child.exitCode !== null) throw new Error(`app exited early:\n${output}`);
```

with:

```ts
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
```

- [ ] **Step 9: Run the tests to check that they pass**

Run: `npm test`
Expected: PASS, **212** tests, 0 failures. Run it two more times; it must stay green.

- [ ] **Step 10: Typecheck and build**

Run: `npm run typecheck && npm run build`
Expected: both exit 0 with no `error TS` lines.

- [ ] **Step 11: Manual check — checkpoint ①**

Terminal 1: `npm run fake-comdove` (receiver on :3100).
Terminal 2 (a spare port, so it does not clash with a running dev server):

```bash
PORT=4030 DB_PATH=/tmp/live-check.sqlite COMDOVE_WEBHOOK_URL=http://localhost:3100/webhooks/whatsapp npm run dev
```

Terminal 3:

```bash
curl -s -X POST localhost:4030/api/business-numbers -H 'Content-Type: application/json' \
  -d '{"display_number":"918888800001","label":"Sales","phone_number_id":"MOCK-PN-1","waba_id":"MOCK-WABA-1","token":"mock-token-dev"}'
curl -s -X POST localhost:4030/api/groups -H 'Content-Type: application/json' \
  -d '{"name":"alpha","numbers":["919876543210","919876543211"]}'
node --input-type=module -e '
const { WebSocket } = await import("ws");
const ws = new WebSocket("ws://localhost:4030/ws");
ws.on("open", () => ws.send(JSON.stringify({ type: "group.claim", group: "alpha" })));
ws.on("message", (d) => { const f = JSON.parse(String(d)); console.log(f.type, f.message?.body ?? f.status ?? ""); });
setTimeout(() => ws.close(), 3000);' &
sleep 0.5
curl -s -X POST localhost:4030/v23.0/MOCK-PN-1/messages -H 'Authorization: Bearer mock-token-dev' \
  -H 'Content-Type: application/json' \
  -d '{"messaging_product":"whatsapp","to":"919876543210","type":"text","text":{"body":"hi"}}'
wait
```

Expected in terminal 3: `group.claimed`, then `message.new hi`, then `message.status delivered`.
Expected in terminal 1: `✔ 200 sent …` then `✔ 200 delivered …`.
Stop both servers (Ctrl+C) and `rm -f /tmp/live-check.sqlite*`.

- [ ] **Step 12: Commit**

```bash
git add src/live.ts src/compose.ts src/index.ts test/e2e/live.e2e.test.ts test/e2e/integrated.e2e.test.ts test/e2e/ws.e2e.test.ts
git commit -m "feat(live): switch the app to the live engine; drop the interim delivery

Delivery now needs an open group (plan §13a), so the integrated e2e opens alpha
over /ws per test, and ws.e2e seeds its groups through /api.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
```

---

## Done when

- `npm test` → 212 passing, 0 failing (3 runs); `npm run typecheck` and `npm run build` clean.
- The manual check prints `group.claimed`, `message.new hi`, `message.status delivered`, and the fake Comdove logs `sent` then `delivered`.
- The PR description lists the changes to Person 1's and Person 2's files (spec §6).
