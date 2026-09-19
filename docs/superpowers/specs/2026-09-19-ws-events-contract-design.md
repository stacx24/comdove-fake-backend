# WebSocket Event Contract (`src/contract/ws-events.ts`) — Design

**Owner:** Person 3 (live engine) · **Date:** 2026-09-19 · **Status:** draft for review
**Source of truth for behaviour:** `docs/BACKEND-BUILD-PLAN.md` §10c, §11, §12, §14 and `TEAM-SPLIT.md` (Person 3).

## 1. Goal

Freeze every WebSocket frame that crosses `ws://{host}:4020/ws` as TypeScript types, so
that:

- the backend (`src/ws/*`, `src/core/bus.ts`, `src/core/delivery.ts`) sends and receives
  only typed events, and
- the UI team (separate repo) can copy `src/contract/` and build the client grid and the
  admin page against it before the real backend exists.

This is step 1 of Person 3's work. It contains **no server logic**: no socket, no lock, no
delivery. Only types, event-name constants, one parser for client frames, and one
encoder for server frames.

## 2. Decisions

| # | Decision | Why |
|---|---|---|
| D1 | Types **plus a small hand-written parser** for client→server frames. No zod. | Safe input for the server with no new dependency; the file stays copyable by the UI team. |
| D2 | Shapes shared with the HTTP API (`LogEntry`, `GroupListItem`, `BusinessNumber`, `CustomerListItem`, `AutoReply`) live in **`src/contract/api-types.ts`** and are imported by `ws-events.ts`. | One definition, no drift between `/api` and the admin feed. Person 3 writes a minimal stub now; Person 2 owns and extends it. |
| D3 | JSON field names are **snake_case**, exactly as in the build plan. | Types match the wire 1:1; no mapping layer. |
| D4 | Every frame is a flat object `{ type, ...payload }`. List payloads get a named key (e.g. `groups.update` → `{ type, groups: [...] }`). | The plan says "same list as `GET /api/groups`" but a frame must be an object; a named key keeps it flat and extensible. |
| D5 | All times are **epoch milliseconds** (`number`) on the socket. | Matches SQLite storage (`Date.now()`); only Meta webhooks use Unix-seconds strings, and those are not in this contract. |
| D6 | The parser checks **shape only** (types, required fields, enums, ranges). Business rules (group exists, number in group, lock free, tile online) stay in the handlers. | Keeps the contract free of DB access and testable on its own. |
| D7 | Tests use Node's built-in **`node:test`** run through `tsx`. | No new test framework; `tsx` is already a dev dependency. |
| D8 **[Gap]** | `message.send` from an offline tile is refused with `tile_offline`. | Not in the plan. Matches the auto-reply rule "an offline customer does not talk" (plan §14). Confirm at the freeze. |

## 3. Files

| File | Owner | Contents |
|---|---|---|
| `src/contract/api-types.ts` | P2 (stub by P3) | Shared data shapes (§4) |
| `src/contract/ws-events.ts` | P3 | Event types, name constants, error codes, `parseClientEvent`, `encodeEvent` (§5–§7) |
| `test/contract/ws-events.test.ts` | P3 | Parser tests (§8) |
| `README.md` | P3 | Short "Contract" section pointing to the two files |
| `package.json` | P3 | `"test": "node --import tsx --test test/**/*.test.ts"` |

## 4. `api-types.ts` stub (shared shapes)

Only what the socket needs. Person 2 adds request/response types for the other endpoints.

```ts
export type ReplyMode = 'manual' | 'echo' | 'keyword';
export interface AutoReplyRule { keyword: string; reply: string }
export interface AutoReply { mode: ReplyMode; delay_ms: number; rules: AutoReplyRule[] }

export interface BusinessNumber {
  phone_number_id: string; display_number: string; label: string | null;
  token: string; waba_id: string; created_at: number;
}
export interface CustomerListItem {
  number: string; label: string | null; group_id: string;
  online: boolean; effective_online: boolean;
  claim_status: 'free' | 'locked'; reply_mode: ReplyMode;
}
export interface GroupListItem {
  id: string; name: string; count: number;
  status: 'free' | 'locked'; locked_since: number | null;
}

export type MessageStatus = 'sent' | 'delivered' | 'read';
export type WebhookKind = 'inbound' | 'sent' | 'delivered' | 'read';
export interface WebhookAttempt { n: number; http_status: number | null; duration_ms?: number; at: number; error?: string }
export interface WebhookJob { kind: WebhookKind; state: 'pending' | 'ok' | 'failed'; attempts: WebhookAttempt[] }
export interface LogEntry {
  wamid: string | null;                       // null for rejected requests
  time: number;
  direction: 'outbound' | 'inbound' | 'rejected';
  source: 'api' | 'tile' | 'inject' | 'autoreply';
  from: string; to: string;
  business: { phone_number_id: string; label: string | null } | null;
  group_id: string | null;
  body: string;
  status: MessageStatus | null;               // null for rejected
  error_code?: number;                        // only for rejected
  timeline: { status: MessageStatus; at: number }[];
  webhooks: WebhookJob[];
}
```

## 5. `ws-events.ts` — data types

```ts
export type Direction = 'inbound' | 'outbound';

// One chat bubble. `peer` = the business number (display number) on the other side.
export interface WsMessage {
  wamid: string; peer: string; direction: Direction;
  body: string; status: MessageStatus; created_at: number;
}

export interface Tile {
  number: string; label: string | null; online: boolean;
  auto_reply: AutoReply;
  history: WsMessage[];                       // oldest first
  queued: WsMessage[];                        // outbound, not yet delivered, in seq order
  unread: Record<string, number>;             // peer display number -> count
}

export interface Snapshot {
  group: { id: string; name: string };
  business_numbers: Pick<BusinessNumber, 'phone_number_id' | 'display_number' | 'label'>[];
  tiles: Tile[];                              // in customers.position order
}
```

## 6. `ws-events.ts` — the events

### 6a. Client → server (`ClientEvent`, 6 types)

| type | payload | parser rules |
|---|---|---|
| `group.claim` | `{ group: string }` | non-empty string |
| `message.send` | `{ from: string; to: string; body: string }` | `from`, `to` non-empty strings; `body` non-empty after trim, ≤ 4096 chars |
| `tile.presence` | `{ number: string; online: boolean }` | `online` must be a boolean |
| `chat.read` | `{ number: string; peer: string }` | non-empty strings |
| `tile.autoreply` | `{ number: string } & AutoReply` | `mode` ∈ ReplyMode; `delay_ms` integer 0–30000; `rules` array of `{keyword, reply}` non-empty strings (may be empty array) |
| `admin.subscribe` | `{}` | extra fields ignored |

Numbers are passed through as strings; digit normalization (strip `+`, spaces, dashes) is
done by Person 2's registry, not by the parser.

### 6b. Server → client, group session (`ServerEvent`, 8 types)

| type | payload |
|---|---|
| `group.claimed` | `Snapshot` (flattened: `{ type, group, business_numbers, tiles }`) |
| `group.locked` | `{ group: string; since: number }` |
| `message.new` | `{ to: string; number: string; message: WsMessage }` |
| `queue.flush` | `{ number: string; messages: WsMessage[] }` |
| `message.status` | `{ wamid: string; number: string; status: MessageStatus; at: number }` |
| `tile.presence` | `{ number: string; online: boolean }` |
| `tile.autoreply` | `{ number: string } & AutoReply` |
| `error` | `{ code: WsErrorCode; message: string }` |

### 6c. Server → client, admin feed (`AdminEvent`, 6 types)

| type | payload |
|---|---|
| `log.entry` | `{ entry: LogEntry }` |
| `log.update` | `{ entry: LogEntry }` (full entry, replaces the old one by `wamid`) |
| `log.reset` | `{}` |
| `groups.update` | `{ groups: GroupListItem[] }` |
| `numbers.update` | `{ business_numbers: BusinessNumber[]; customers: CustomerListItem[] }` |
| `webhook.verify` | `{ ok: boolean; at: number; detail: string }` |

An admin socket can also receive `error` (e.g. bad JSON).

### 6d. Name constants and unions

```ts
export const CLIENT_EVENT_TYPES = ['group.claim', 'message.send', 'tile.presence',
  'chat.read', 'tile.autoreply', 'admin.subscribe'] as const;
export const SERVER_EVENT_TYPES = [/* the 8 in 6b */] as const;
export const ADMIN_EVENT_TYPES  = [/* the 6 in 6c */] as const;

export type ClientEvent = GroupClaim | MessageSend | TilePresenceIn | ChatRead | TileAutoReplyIn | AdminSubscribe;
export type ServerEvent = GroupClaimed | GroupLocked | MessageNew | QueueFlush | MessageStatusEv | TilePresenceOut | TileAutoReplyOut | WsError;
export type AdminEvent  = LogEntryEv | LogUpdateEv | LogResetEv | GroupsUpdateEv | NumbersUpdateEv | WebhookVerifyEv | WsError;
```

Each member is `{ type: '<literal>' } & payload`, so `switch (ev.type)` narrows in both the
server and the UI.

## 7. Errors, parser and encoder

### 7a. Error codes

```ts
export type WsErrorCode =
  | 'bad_json'            // frame is not valid JSON or not an object
  | 'bad_request'         // known type, wrong/missing field (message names the field)
  | 'unknown_type'        // type not in CLIENT_EVENT_TYPES
  | 'not_claimed'         // group action before group.claim (or on an admin socket)
  | 'already_claimed'     // second group.claim / admin.subscribe on the same socket
  | 'unknown_group'       // group.claim for a group that does not exist
  | 'number_not_in_group' // action for a tile outside the claimed group
  | 'unknown_business'    // message.send / chat.read peer is not a business number
  | 'tile_offline'        // action that needs an online tile (message.send from an offline tile)
  | 'group_deleted';      // reset wiped the group; server closes the socket after sending
```

The parser only produces `bad_json`, `bad_request` and `unknown_type`. The rest are raised
by the handlers (Person 3's `group-session.ts`), but they are listed here so the UI can
handle all of them. `chat.read` on an offline tile is **ignored silently** (plan §11a), not
an error.

### 7b. Parser

```ts
export type ParseResult =
  | { ok: true; event: ClientEvent }
  | { ok: false; error: { code: 'bad_json' | 'bad_request' | 'unknown_type'; message: string } };

export function parseClientEvent(raw: string | Buffer): ParseResult;
```

- `JSON.parse` failure, or result not a plain object → `bad_json`.
- `type` missing or not a string → `bad_request` (`"missing field: type"`).
- `type` not in `CLIENT_EVENT_TYPES` → `unknown_type` (`"unknown type: foo.bar"`).
- Field check fails → `bad_request` with the first failing field (`"field 'online' must be boolean"`).
- On success returns a **new object with only the known fields** (unknown fields dropped),
  so handlers never see extra data.
- Pure function: no I/O, never throws.

### 7c. Encoder

```ts
export function encodeEvent(ev: ServerEvent | AdminEvent): string; // JSON.stringify
```

Exists so every `socket.send` goes through a typed call; a misspelled event or wrong
payload fails at compile time.

## 8. Testing

`test/contract/ws-events.test.ts` with `node:test` + `node:assert/strict`:

1. One valid frame per client type parses to the expected event (6 cases).
2. Unknown fields are dropped from the parsed event.
3. `bad_json`: `"not json"`, `"[]"`, `"null"`, `"42"`.
4. `unknown_type`: `{type:'foo'}`; `bad_request`: `{}` and `{type: 5}`.
5. Per-field `bad_request`: empty `group`; `online: "yes"`; empty/whitespace `body`;
   4097-char `body`; `mode: 'loud'`; `delay_ms: -1`, `30001`, `1.5`; rule with empty
   `keyword`.
6. `Buffer` input parses like the string input.
7. `encodeEvent` round-trips: `JSON.parse(encodeEvent(ev))` deep-equals `ev`.

`npm run build` (`tsc`, strict) must pass. It is the type-level check that the unions narrow
correctly.

## 9. Out of scope (later steps)

- The socket server, heartbeat, lock, sessions, bus, delivery, presence (steps 2–10).
- Digit normalization and every DB-backed rule (Person 2 / handlers).
- Request/response types for the other `/api` endpoints (Person 2 extends `api-types.ts`).
- Versioning of the contract. After the freeze, any change updates `src/contract/` and is
  announced to the UI team the same day (TEAM-SPLIT "Handoff to the UI team").

## 10. Done when

- Both files exist, `npm run build` passes, `npm test` passes.
- The README "Contract" section links them.
- The team and the UI team have read and frozen the event list (the first 30–45 minutes).
