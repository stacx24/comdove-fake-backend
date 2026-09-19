# WebSocket Event Contract Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Freeze every WebSocket frame on `/ws` as TypeScript types, and add a safe parser for client frames and a typed encoder for server frames. The UI team and Persons 1–3 all build against these files.

**Architecture:** Two files in `src/contract/`. `api-types.ts` holds the data shapes shared with the HTTP API; Person 2 owns it and this plan writes a stub. `ws-events.ts` holds the event types, name constants, error codes, `parseClientEvent()` (pure function, shape checks only) and `encodeEvent()`. There is no server logic here.

**Tech Stack:** TypeScript (strict, NodeNext), Node 24, `tsx`, and the built-in `node:test` + `node:assert/strict`. No new dependencies.

**Spec:** `docs/superpowers/specs/2026-09-19-ws-events-contract-design.md`

## Global Constraints

- No new dependencies. No zod. Tests use `node:test` through `tsx` (already a dev dependency).
- JSON field names are snake_case, exactly as in the spec (`delay_ms`, `phone_number_id`, `created_at`).
- Every frame is a flat object `{ type, ...payload }`. List payloads use a named key (`groups`, `entry`, `messages`).
- All times on the socket are epoch milliseconds (`number`).
- Relative imports use the `.js` extension (`from './api-types.js'`), which NodeNext requires.
- `parseClientEvent` checks shape only. It has no DB access and never throws for bad input.
- `body` max length is 4096. `delay_ms` is an integer from 0 to 30000. `mode` is one of `manual`, `echo`, `keyword`.
- Commit messages end with `Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>`.

## File map

| File | Action | Responsibility |
|---|---|---|
| `src/contract/api-types.ts` | Create | Shared shapes: `ReplyMode`, `AutoReply`, `BusinessNumber`, `CustomerListItem`, `GroupListItem`, `MessageStatus`, `LogEntry` and related types |
| `src/contract/ws-events.ts` | Create | Event types, `*_EVENT_TYPES` constants, `WsErrorCode`, `encodeEvent` (Task 1) and `parseClientEvent` (Task 2) |
| `test/contract/ws-events.encode.test.ts` | Create | Constants + encoder tests |
| `test/contract/ws-events.parse.test.ts` | Create | Parser tests |
| `package.json` | Modify | Add a `test` script |
| `README.md` | Modify | Add a "Contract" section |

(The spec names a single test file. It is split in two here so each task owns its own file.)

---

### Task 1: Shared shapes, event types and encoder

**Files:**
- Create: `src/contract/api-types.ts`
- Create: `src/contract/ws-events.ts`
- Create: `test/contract/ws-events.encode.test.ts`
- Modify: `package.json` (the `scripts` block)

**Interfaces:**
- Consumes: nothing.
- Produces (used by Task 2 and by later steps 2–10):
  - From `api-types.ts`: `ReplyMode`, `AutoReplyRule`, `AutoReply`, `BusinessNumber`, `CustomerListItem`, `GroupListItem`, `MessageStatus`, `WebhookKind`, `WebhookAttempt`, `WebhookJob`, `LogEntry`.
  - From `ws-events.ts`: the types `Direction`, `WsMessage`, `Tile`, `Snapshot`, `ClientEvent`, `ServerEvent`, `AdminEvent`, `WsErrorCode`, `WsError`, `ClientEventType`; the constants `CLIENT_EVENT_TYPES`, `SERVER_EVENT_TYPES`, `ADMIN_EVENT_TYPES`, `MAX_BODY_LENGTH = 4096`, `MAX_DELAY_MS = 30000`, `REPLY_MODES`; and `encodeEvent(ev: ServerEvent | AdminEvent): string`.

- [ ] **Step 1: Add the test script to `package.json`**

In `"scripts"`, add the `test` line so the block reads:

```json
  "scripts": {
    "dev": "tsx watch src/index.ts",
    "build": "tsc",
    "start": "node dist/index.js",
    "test": "node --import tsx --test \"test/**/*.test.ts\""
  },
```

- [ ] **Step 2: Write the failing test**

Create `test/contract/ws-events.encode.test.ts`:

```ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  ADMIN_EVENT_TYPES,
  CLIENT_EVENT_TYPES,
  SERVER_EVENT_TYPES,
  encodeEvent,
  type AdminEvent,
  type ServerEvent,
} from '../../src/contract/ws-events.js';

test('event name lists have the frozen counts', () => {
  assert.equal(CLIENT_EVENT_TYPES.length, 6);
  assert.equal(SERVER_EVENT_TYPES.length, 8);
  assert.equal(ADMIN_EVENT_TYPES.length, 6);
});

test('event names are unique across all lists', () => {
  const client = new Set<string>(CLIENT_EVENT_TYPES);
  const serverAndAdmin = [...SERVER_EVENT_TYPES, ...ADMIN_EVENT_TYPES];
  assert.equal(new Set(serverAndAdmin).size, serverAndAdmin.length);
  // tile.presence and tile.autoreply exist in both directions on purpose
  const shared = serverAndAdmin.filter((t) => client.has(t)).sort();
  assert.deepEqual(shared, ['tile.autoreply', 'tile.presence']);
});

test('encodeEvent round-trips a group.claimed snapshot', () => {
  const ev: ServerEvent = {
    type: 'group.claimed',
    group: { id: 'alpha', name: 'Alpha' },
    business_numbers: [
      { phone_number_id: 'MOCK-PN-1', display_number: '918888800001', label: 'Sales' },
    ],
    tiles: [
      {
        number: '919876543210',
        label: null,
        online: true,
        auto_reply: { mode: 'manual', delay_ms: 0, rules: [] },
        history: [
          {
            wamid: 'wamid.MOCK-aaaaaaaaaaaaaaaaaaaaaaaa',
            peer: '918888800001',
            direction: 'outbound',
            body: 'Hello',
            status: 'read',
            created_at: 1758270000123,
          },
        ],
        queued: [],
        unread: { '918888800001': 0 },
      },
    ],
  };
  const text = encodeEvent(ev);
  assert.equal(typeof text, 'string');
  assert.deepEqual(JSON.parse(text), ev);
});

test('encodeEvent round-trips an admin log.entry', () => {
  const ev: AdminEvent = {
    type: 'log.entry',
    entry: {
      wamid: 'wamid.MOCK-bbbbbbbbbbbbbbbbbbbbbbbb',
      time: 1758270000123,
      direction: 'outbound',
      source: 'api',
      from: '918888800001',
      to: '919876543210',
      business: { phone_number_id: 'MOCK-PN-1', label: 'Sales' },
      group_id: 'alpha',
      body: 'Hello from Comdove',
      status: 'sent',
      timeline: [{ status: 'sent', at: 1758270000123 }],
      webhooks: [
        { kind: 'sent', state: 'ok', attempts: [{ n: 1, http_status: 200, duration_ms: 12, at: 1758270000650 }] },
      ],
    },
  };
  assert.deepEqual(JSON.parse(encodeEvent(ev)), ev);
});

test('encodeEvent keeps the error shape flat', () => {
  const ev: ServerEvent = { type: 'error', code: 'not_claimed', message: 'claim a group first' };
  assert.equal(encodeEvent(ev), '{"type":"error","code":"not_claimed","message":"claim a group first"}');
});
```

- [ ] **Step 3: Run the test to check that it fails**

Run: `npm test`
Expected: FAIL. The error says it cannot find module `../../src/contract/ws-events.js` (`ERR_MODULE_NOT_FOUND`).

- [ ] **Step 4: Create `src/contract/api-types.ts`**

```ts
// Shapes shared by the HTTP control API (/api/*) and the WebSocket admin feed.
// Owner: Person 2. This is a stub with only the shapes the WebSocket contract
// needs; Person 2 adds request/response types for the other endpoints.
// SHARED with the UI team: any change after the freeze must be announced.

export type ReplyMode = 'manual' | 'echo' | 'keyword';

export interface AutoReplyRule {
  keyword: string;
  reply: string;
}

export interface AutoReply {
  mode: ReplyMode;
  delay_ms: number; // 0–30000
  rules: AutoReplyRule[];
}

export interface BusinessNumber {
  phone_number_id: string;
  display_number: string;
  label: string | null;
  token: string;
  waba_id: string;
  created_at: number;
}

export interface CustomerListItem {
  number: string;
  label: string | null;
  group_id: string;
  online: boolean; // stored tile flag
  effective_online: boolean; // group claimed AND tile flag online
  claim_status: 'free' | 'locked';
  reply_mode: ReplyMode;
}

export interface GroupListItem {
  id: string; // slug, the ?group= value
  name: string;
  count: number;
  status: 'free' | 'locked';
  locked_since: number | null;
}

export type MessageStatus = 'sent' | 'delivered' | 'read';

export type WebhookKind = 'inbound' | 'sent' | 'delivered' | 'read';

export interface WebhookAttempt {
  n: number;
  http_status: number | null; // null = timeout / network error
  duration_ms?: number;
  at: number;
  error?: string;
}

export interface WebhookJob {
  kind: WebhookKind;
  state: 'pending' | 'ok' | 'failed';
  attempts: WebhookAttempt[];
}

export interface LogEntry {
  wamid: string | null; // null for rejected requests
  time: number;
  direction: 'outbound' | 'inbound' | 'rejected';
  source: 'api' | 'tile' | 'inject' | 'autoreply';
  from: string;
  to: string;
  business: { phone_number_id: string; label: string | null } | null;
  group_id: string | null;
  body: string;
  status: MessageStatus | null; // null for rejected
  error_code?: number; // only for rejected
  timeline: { status: MessageStatus; at: number }[];
  webhooks: WebhookJob[];
}
```

- [ ] **Step 5: Create `src/contract/ws-events.ts` (types, constants, encoder)**

```ts
// WebSocket contract for ws://{host}:4020/ws — every frame is { type, ...payload }.
// Owner: Person 3. SHARED with the UI team: any change after the freeze must be
// announced the same day. Spec: docs/superpowers/specs/2026-09-19-ws-events-contract-design.md

import type {
  AutoReply,
  BusinessNumber,
  CustomerListItem,
  GroupListItem,
  LogEntry,
  MessageStatus,
  ReplyMode,
} from './api-types.js';

export type { MessageStatus } from './api-types.js';

// ---------------------------------------------------------------------------
// Limits
// ---------------------------------------------------------------------------

export const MAX_BODY_LENGTH = 4096;
export const MAX_DELAY_MS = 30000;
export const REPLY_MODES: readonly ReplyMode[] = ['manual', 'echo', 'keyword'];

// ---------------------------------------------------------------------------
// Data carried by events
// ---------------------------------------------------------------------------

export type Direction = 'inbound' | 'outbound';

// One chat bubble. `peer` = the business display number on the other side.
export interface WsMessage {
  wamid: string;
  peer: string;
  direction: Direction;
  body: string;
  status: MessageStatus;
  created_at: number;
}

export interface Tile {
  number: string;
  label: string | null;
  online: boolean;
  auto_reply: AutoReply;
  history: WsMessage[]; // oldest first
  queued: WsMessage[]; // outbound, not yet delivered, in seq order
  unread: Record<string, number>; // peer display number -> count
}

export interface Snapshot {
  group: { id: string; name: string };
  business_numbers: Pick<BusinessNumber, 'phone_number_id' | 'display_number' | 'label'>[];
  tiles: Tile[]; // in customers.position order
}

// ---------------------------------------------------------------------------
// Event names
// ---------------------------------------------------------------------------

export const CLIENT_EVENT_TYPES = [
  'group.claim',
  'message.send',
  'tile.presence',
  'chat.read',
  'tile.autoreply',
  'admin.subscribe',
] as const;

export const SERVER_EVENT_TYPES = [
  'group.claimed',
  'group.locked',
  'message.new',
  'queue.flush',
  'message.status',
  'tile.presence',
  'tile.autoreply',
  'error',
] as const;

export const ADMIN_EVENT_TYPES = [
  'log.entry',
  'log.update',
  'log.reset',
  'groups.update',
  'numbers.update',
  'webhook.verify',
] as const;

export type ClientEventType = (typeof CLIENT_EVENT_TYPES)[number];
export type ServerEventType = (typeof SERVER_EVENT_TYPES)[number];
export type AdminEventType = (typeof ADMIN_EVENT_TYPES)[number];

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

export type WsErrorCode =
  | 'bad_json' // frame is not valid JSON or not an object
  | 'bad_request' // known type, wrong/missing field (message names the field)
  | 'unknown_type' // type not in CLIENT_EVENT_TYPES
  | 'not_claimed' // group action before group.claim (or on an admin socket)
  | 'already_claimed' // second group.claim / admin.subscribe on the same socket
  | 'unknown_group' // group.claim for a group that does not exist
  | 'number_not_in_group' // action for a tile outside the claimed group
  | 'unknown_business' // message.send / chat.read peer is not a business number
  | 'tile_offline' // message.send from an offline tile
  | 'group_deleted'; // reset wiped the group; the server closes the socket after sending

export type WsError = { type: 'error'; code: WsErrorCode; message: string };

// ---------------------------------------------------------------------------
// Client -> server
// ---------------------------------------------------------------------------

export type GroupClaim = { type: 'group.claim'; group: string };
export type MessageSend = { type: 'message.send'; from: string; to: string; body: string };
export type TilePresenceIn = { type: 'tile.presence'; number: string; online: boolean };
export type ChatRead = { type: 'chat.read'; number: string; peer: string };
export type TileAutoReplyIn = { type: 'tile.autoreply'; number: string } & AutoReply;
export type AdminSubscribe = { type: 'admin.subscribe' };

export type ClientEvent =
  | GroupClaim
  | MessageSend
  | TilePresenceIn
  | ChatRead
  | TileAutoReplyIn
  | AdminSubscribe;

// ---------------------------------------------------------------------------
// Server -> client (group session)
// ---------------------------------------------------------------------------

export type GroupClaimed = { type: 'group.claimed' } & Snapshot;
export type GroupLocked = { type: 'group.locked'; group: string; since: number };
export type MessageNew = { type: 'message.new'; to: string; number: string; message: WsMessage };
export type QueueFlush = { type: 'queue.flush'; number: string; messages: WsMessage[] };
export type MessageStatusEvent = {
  type: 'message.status';
  wamid: string;
  number: string;
  status: MessageStatus;
  at: number;
};
export type TilePresenceOut = { type: 'tile.presence'; number: string; online: boolean };
export type TileAutoReplyOut = { type: 'tile.autoreply'; number: string } & AutoReply;

export type ServerEvent =
  | GroupClaimed
  | GroupLocked
  | MessageNew
  | QueueFlush
  | MessageStatusEvent
  | TilePresenceOut
  | TileAutoReplyOut
  | WsError;

// ---------------------------------------------------------------------------
// Server -> client (admin feed)
// ---------------------------------------------------------------------------

export type LogEntryEvent = { type: 'log.entry'; entry: LogEntry };
export type LogUpdateEvent = { type: 'log.update'; entry: LogEntry }; // replaces the entry with the same wamid
export type LogResetEvent = { type: 'log.reset' };
export type GroupsUpdateEvent = { type: 'groups.update'; groups: GroupListItem[] };
export type NumbersUpdateEvent = {
  type: 'numbers.update';
  business_numbers: BusinessNumber[];
  customers: CustomerListItem[];
};
export type WebhookVerifyEvent = { type: 'webhook.verify'; ok: boolean; at: number; detail: string };

export type AdminEvent =
  | LogEntryEvent
  | LogUpdateEvent
  | LogResetEvent
  | GroupsUpdateEvent
  | NumbersUpdateEvent
  | WebhookVerifyEvent
  | WsError;

// ---------------------------------------------------------------------------
// Compile-time check: the name lists and the unions stay in sync.
// If one of these lines fails to compile, a list and a union disagree.
// ---------------------------------------------------------------------------

type Equals<A, B> = [A] extends [B] ? ([B] extends [A] ? true : false) : false;
const _clientNamesMatch: Equals<ClientEvent['type'], ClientEventType> = true;
const _serverNamesMatch: Equals<ServerEvent['type'], ServerEventType> = true;
const _adminNamesMatch: Equals<Exclude<AdminEvent['type'], 'error'>, AdminEventType> = true;
void _clientNamesMatch;
void _serverNamesMatch;
void _adminNamesMatch;

// ---------------------------------------------------------------------------
// Encoder — every socket.send goes through this so payloads are type-checked.
// ---------------------------------------------------------------------------

export function encodeEvent(ev: ServerEvent | AdminEvent): string {
  return JSON.stringify(ev);
}
```

- [ ] **Step 6: Run the tests to check that they pass**

Run: `npm test`
Expected: PASS, 5 tests, 0 failures.

- [ ] **Step 7: Run the type check**

Run: `npm run build`
Expected: exits 0 with no errors, and `dist/contract/ws-events.js` exists.

- [ ] **Step 8: Commit**

```bash
git add package.json src/contract/api-types.ts src/contract/ws-events.ts test/contract/ws-events.encode.test.ts
git commit -m "feat(contract): WebSocket event types, shared API shapes and encoder

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
```

---

### Task 2: Client frame parser + README contract section

**Files:**
- Modify: `src/contract/ws-events.ts` (append the parser at the end of the file)
- Create: `test/contract/ws-events.parse.test.ts`
- Modify: `README.md` (append a "Contract" section)

**Interfaces:**
- Consumes (from Task 1, `src/contract/ws-events.ts`): `ClientEvent`, `ClientEventType`, `CLIENT_EVENT_TYPES`, `MAX_BODY_LENGTH`, `MAX_DELAY_MS`, `REPLY_MODES`; and from `api-types.ts`: `AutoReply`, `ReplyMode`.
- Produces (used by step 3, `src/ws/group-session.ts`):
  - `type ParseResult = { ok: true; event: ClientEvent } | { ok: false; error: { code: 'bad_json' | 'bad_request' | 'unknown_type'; message: string } }`
  - `function parseClientEvent(raw: string | Buffer): ParseResult`

- [ ] **Step 1: Write the failing test**

Create `test/contract/ws-events.parse.test.ts`:

```ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseClientEvent, type ClientEvent } from '../../src/contract/ws-events.js';

function ok(frame: unknown, expected: ClientEvent): void {
  const result = parseClientEvent(JSON.stringify(frame));
  assert.deepEqual(result, { ok: true, event: expected });
}

function fails(raw: string, code: string, message: RegExp): void {
  const result = parseClientEvent(raw);
  assert.equal(result.ok, false);
  if (!result.ok) {
    assert.equal(result.error.code, code);
    assert.match(result.error.message, message);
  }
}

const TILE = '919876543210';
const BIZ = '918888800001';

// --- valid frames, one per client type ------------------------------------

test('parses group.claim', () => {
  ok({ type: 'group.claim', group: 'alpha' }, { type: 'group.claim', group: 'alpha' });
});

test('parses message.send', () => {
  ok(
    { type: 'message.send', from: TILE, to: BIZ, body: 'how much?' },
    { type: 'message.send', from: TILE, to: BIZ, body: 'how much?' },
  );
});

test('parses tile.presence with online false', () => {
  ok(
    { type: 'tile.presence', number: TILE, online: false },
    { type: 'tile.presence', number: TILE, online: false },
  );
});

test('parses chat.read', () => {
  ok({ type: 'chat.read', number: TILE, peer: BIZ }, { type: 'chat.read', number: TILE, peer: BIZ });
});

test('parses tile.autoreply', () => {
  ok(
    {
      type: 'tile.autoreply',
      number: TILE,
      mode: 'keyword',
      delay_ms: 500,
      rules: [{ keyword: 'price', reply: 'how much?' }],
    },
    {
      type: 'tile.autoreply',
      number: TILE,
      mode: 'keyword',
      delay_ms: 500,
      rules: [{ keyword: 'price', reply: 'how much?' }],
    },
  );
});

test('parses tile.autoreply with boundary delays and no rules', () => {
  ok(
    { type: 'tile.autoreply', number: TILE, mode: 'manual', delay_ms: 0, rules: [] },
    { type: 'tile.autoreply', number: TILE, mode: 'manual', delay_ms: 0, rules: [] },
  );
  ok(
    { type: 'tile.autoreply', number: TILE, mode: 'echo', delay_ms: 30000, rules: [] },
    { type: 'tile.autoreply', number: TILE, mode: 'echo', delay_ms: 30000, rules: [] },
  );
});

test('parses admin.subscribe', () => {
  ok({ type: 'admin.subscribe' }, { type: 'admin.subscribe' });
});

test('accepts a body of exactly 4096 characters', () => {
  const body = 'x'.repeat(4096);
  ok({ type: 'message.send', from: TILE, to: BIZ, body }, { type: 'message.send', from: TILE, to: BIZ, body });
});

// --- unknown fields are dropped -------------------------------------------

test('drops unknown top-level fields', () => {
  ok({ type: 'group.claim', group: 'alpha', extra: 1 }, { type: 'group.claim', group: 'alpha' });
  ok({ type: 'admin.subscribe', token: 'x' }, { type: 'admin.subscribe' });
});

test('drops unknown fields inside auto-reply rules', () => {
  ok(
    {
      type: 'tile.autoreply',
      number: TILE,
      mode: 'keyword',
      delay_ms: 0,
      rules: [{ keyword: 'yes', reply: 'confirm', priority: 9 }],
    },
    {
      type: 'tile.autoreply',
      number: TILE,
      mode: 'keyword',
      delay_ms: 0,
      rules: [{ keyword: 'yes', reply: 'confirm' }],
    },
  );
});

// --- bad_json -------------------------------------------------------------

test('bad_json for text that is not JSON', () => {
  fails('not json', 'bad_json', /not valid JSON/);
});

test('bad_json for JSON that is not an object', () => {
  fails('[]', 'bad_json', /JSON object/);
  fails('null', 'bad_json', /JSON object/);
  fails('42', 'bad_json', /JSON object/);
  fails('"group.claim"', 'bad_json', /JSON object/);
});

// --- type problems ----------------------------------------------------------

test('bad_request when type is missing or not a string', () => {
  fails('{}', 'bad_request', /missing field: type/);
  fails('{"type":5}', 'bad_request', /missing field: type/);
});

test('unknown_type for a type that is not a client event', () => {
  fails('{"type":"foo.bar"}', 'unknown_type', /unknown type: foo\.bar/);
  // a server->client event name is not a valid client event
  fails('{"type":"message.new"}', 'unknown_type', /unknown type: message\.new/);
});

// --- field problems -------------------------------------------------------

test('bad_request for an empty or missing group', () => {
  fails('{"type":"group.claim","group":""}', 'bad_request', /'group'/);
  fails('{"type":"group.claim","group":"   "}', 'bad_request', /'group'/);
  fails('{"type":"group.claim"}', 'bad_request', /'group'/);
});

test('bad_request when online is not a boolean', () => {
  fails(`{"type":"tile.presence","number":"${TILE}","online":"yes"}`, 'bad_request', /'online' must be boolean/);
});

test('bad_request for an empty or too-long body', () => {
  const base = { type: 'message.send', from: TILE, to: BIZ };
  fails(JSON.stringify({ ...base, body: '' }), 'bad_request', /'body'/);
  fails(JSON.stringify({ ...base, body: '  \n ' }), 'bad_request', /'body'/);
  fails(JSON.stringify({ ...base, body: 'x'.repeat(4097) }), 'bad_request', /'body' must be at most 4096/);
});

test('bad_request for a missing from or to', () => {
  fails(JSON.stringify({ type: 'message.send', to: BIZ, body: 'hi' }), 'bad_request', /'from'/);
  fails(JSON.stringify({ type: 'message.send', from: TILE, body: 'hi' }), 'bad_request', /'to'/);
});

test('bad_request for a missing peer on chat.read', () => {
  fails(JSON.stringify({ type: 'chat.read', number: TILE }), 'bad_request', /'peer'/);
});

test('bad_request for an unknown auto-reply mode', () => {
  const frame = { type: 'tile.autoreply', number: TILE, mode: 'loud', delay_ms: 0, rules: [] };
  fails(JSON.stringify(frame), 'bad_request', /'mode' must be one of manual, echo, keyword/);
});

test('bad_request for delay_ms out of range or not an integer', () => {
  for (const delay_ms of [-1, 30001, 1.5, '100']) {
    const frame = { type: 'tile.autoreply', number: TILE, mode: 'echo', delay_ms, rules: [] };
    fails(JSON.stringify(frame), 'bad_request', /'delay_ms' must be an integer from 0 to 30000/);
  }
});

test('bad_request for bad rules', () => {
  const base = { type: 'tile.autoreply', number: TILE, mode: 'keyword', delay_ms: 0 };
  fails(JSON.stringify({ ...base, rules: 'price' }), 'bad_request', /'rules' must be an array/);
  fails(JSON.stringify({ ...base, rules: ['price'] }), 'bad_request', /'rules\[0\]' must be an object/);
  fails(
    JSON.stringify({ ...base, rules: [{ keyword: 'ok', reply: 'fine' }, { keyword: '', reply: 'x' }] }),
    'bad_request',
    /'rules\[1\]\.keyword'/,
  );
  fails(JSON.stringify({ ...base, rules: [{ keyword: 'ok' }] }), 'bad_request', /'rules\[0\]\.reply'/);
});

// --- input types ------------------------------------------------------------

test('parses a Buffer the same as a string', () => {
  const frame = JSON.stringify({ type: 'group.claim', group: 'alpha' });
  assert.deepEqual(parseClientEvent(Buffer.from(frame, 'utf8')), parseClientEvent(frame));
});
```

- [ ] **Step 2: Run the test to check that it fails**

Run: `npm test`
Expected: FAIL. The parse test file reports that `parseClientEvent` is not a function / not exported. The Task 1 encode tests still pass.

- [ ] **Step 3: Add the parser to the end of `src/contract/ws-events.ts`**

First change the `api-types.js` import at the top of the file so it includes `AutoReplyRule`:

```ts
import type {
  AutoReply,
  AutoReplyRule,
  BusinessNumber,
  CustomerListItem,
  GroupListItem,
  LogEntry,
  MessageStatus,
  ReplyMode,
} from './api-types.js';
```

Then append:

```ts
// ---------------------------------------------------------------------------
// Parser for client -> server frames. Checks shape only; business rules
// (group exists, number in group, tile online) belong to the handlers.
// Never throws for bad input.
// ---------------------------------------------------------------------------

export type ParseResult =
  | { ok: true; event: ClientEvent }
  | { ok: false; error: { code: 'bad_json' | 'bad_request' | 'unknown_type'; message: string } };

class FieldError extends Error {}

type JsonObject = Record<string, unknown>;

function isObject(v: unknown): v is JsonObject {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function isClientEventType(t: string): t is ClientEventType {
  return (CLIENT_EVENT_TYPES as readonly string[]).includes(t);
}

function nonEmptyString(o: JsonObject, key: string, path: string = key): string {
  const v = o[key];
  if (typeof v !== 'string' || v.trim() === '') {
    throw new FieldError(`field '${path}' must be a non-empty string`);
  }
  return v;
}

function bool(o: JsonObject, key: string): boolean {
  const v = o[key];
  if (typeof v !== 'boolean') throw new FieldError(`field '${key}' must be boolean`);
  return v;
}

function messageBody(o: JsonObject): string {
  const v = nonEmptyString(o, 'body');
  if (v.length > MAX_BODY_LENGTH) {
    throw new FieldError(`field 'body' must be at most ${MAX_BODY_LENGTH} characters`);
  }
  return v;
}

function autoReply(o: JsonObject): AutoReply {
  const mode = o.mode;
  if (typeof mode !== 'string' || !(REPLY_MODES as readonly string[]).includes(mode)) {
    throw new FieldError(`field 'mode' must be one of ${REPLY_MODES.join(', ')}`);
  }
  const delay = o.delay_ms;
  if (typeof delay !== 'number' || !Number.isInteger(delay) || delay < 0 || delay > MAX_DELAY_MS) {
    throw new FieldError(`field 'delay_ms' must be an integer from 0 to ${MAX_DELAY_MS}`);
  }
  if (!Array.isArray(o.rules)) throw new FieldError(`field 'rules' must be an array`);
  const rules: AutoReplyRule[] = o.rules.map((r: unknown, i: number) => {
    if (!isObject(r)) throw new FieldError(`field 'rules[${i}]' must be an object`);
    return {
      keyword: nonEmptyString(r, 'keyword', `rules[${i}].keyword`),
      reply: nonEmptyString(r, 'reply', `rules[${i}].reply`),
    };
  });
  return { mode: mode as ReplyMode, delay_ms: delay, rules };
}

// Builds a new event with only the known fields.
function readEvent(type: ClientEventType, o: JsonObject): ClientEvent {
  switch (type) {
    case 'group.claim':
      return { type, group: nonEmptyString(o, 'group') };
    case 'message.send':
      return { type, from: nonEmptyString(o, 'from'), to: nonEmptyString(o, 'to'), body: messageBody(o) };
    case 'tile.presence':
      return { type, number: nonEmptyString(o, 'number'), online: bool(o, 'online') };
    case 'chat.read':
      return { type, number: nonEmptyString(o, 'number'), peer: nonEmptyString(o, 'peer') };
    case 'tile.autoreply':
      return { type, number: nonEmptyString(o, 'number'), ...autoReply(o) };
    case 'admin.subscribe':
      return { type };
  }
}

function fail(code: 'bad_json' | 'bad_request' | 'unknown_type', message: string): ParseResult {
  return { ok: false, error: { code, message } };
}

export function parseClientEvent(raw: string | Buffer): ParseResult {
  let data: unknown;
  try {
    data = JSON.parse(typeof raw === 'string' ? raw : raw.toString('utf8'));
  } catch {
    return fail('bad_json', 'frame is not valid JSON');
  }
  if (!isObject(data)) return fail('bad_json', 'frame must be a JSON object');

  const type = data.type;
  if (typeof type !== 'string') return fail('bad_request', 'missing field: type');
  if (!isClientEventType(type)) return fail('unknown_type', `unknown type: ${type}`);

  try {
    return { ok: true, event: readEvent(type, data) };
  } catch (err) {
    if (err instanceof FieldError) return fail('bad_request', err.message);
    throw err; // a bug in this file, not bad input
  }
}
```

- [ ] **Step 4: Run the tests to check that they pass**

Run: `npm test`
Expected: PASS, 28 tests (5 encode + 23 parse), 0 failures.

- [ ] **Step 5: Run the type check**

Run: `npm run build`
Expected: exits 0 with no errors.

- [ ] **Step 6: Append the "Contract" section to `README.md`**

Add at the end of `README.md`:

```markdown

## Contract (shared with the UI team)

The WebSocket and API shapes are frozen in `src/contract/`:

- `src/contract/ws-events.ts` — every frame on `ws://localhost:4020/ws`
  (6 client→server, 8 server→group-session and 6 admin-feed events), the error codes,
  and `parseClientEvent()` / `encodeEvent()`.
- `src/contract/api-types.ts` — shapes shared by `/api/*` and the admin feed
  (`LogEntry`, `GroupListItem`, `BusinessNumber`, ...).

Design: `docs/superpowers/specs/2026-09-19-ws-events-contract-design.md`.
Any change after the freeze updates these files and is announced to the UI team
the same day.

Run the contract tests with `npm test`.
```

- [ ] **Step 7: Commit**

```bash
git add src/contract/ws-events.ts test/contract/ws-events.parse.test.ts README.md
git commit -m "feat(contract): parseClientEvent for client WebSocket frames

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
```

---

## Done when

- `npm test` → 28 passing, 0 failing.
- `npm run build` → no errors.
- The README "Contract" section links both files.
- The team and the UI team have read `src/contract/` and frozen the event list.
