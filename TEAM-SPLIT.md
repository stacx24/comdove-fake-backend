# comdove-fake-backend — Team Split (Backend, 3 people)

Backend-only split for the hackathon. Each person's section below is **self-contained** —
it tells you exactly what to build: the APIs (with request/response), the SQL, and
the WebSocket events. Frontend (client grid) is a separate task, not covered here.

Full spec background: `BACKEND-BUILD-PLAN.md` (in `wat-backend/fake-whatsapp-server/`).

---

## Folder structure (who owns what)

```
comdove-fake-backend/
├── src/
│   ├── index.ts              # boot: express + ws + sqlite   [P2 sets up, P1/P3 plug in]
│   ├── config/env.ts         # read + validate env            [P2]
│   ├── db/
│   │   ├── schema.sql        # CREATE TABLE statements        [P2]
│   │   └── db.ts             # sqlite connection + helpers     [P2]
│   ├── core/
│   │   ├── registry.ts       # numbers + groups                [P2]
│   │   ├── messages.ts       # store + route (tile vs queue)   [P2]
│   │   ├── presence.ts       # online/offline flags            [P3]
│   │   └── queue.ts          # offline queue + flush-in-order  [P3]
│   ├── meta/                 # Meta emulator                   [P1]
│   │   ├── messages.route.ts # POST /:version/:phoneNumberId/messages
│   │   ├── validate.ts       # token / product / type / recipient checks
│   │   ├── errors.ts         # Meta error envelope + codes + X-Mock-Force-Error
│   │   └── responses.ts      # success shape + wamid.MOCK- generator
│   ├── webhooks/             # dispatcher                      [P1]
│   │   ├── dispatcher.ts     # send + retry (1s/5s/15s) + log
│   │   ├── sign.ts           # X-Hub-Signature-256 (HMAC-SHA256)
│   │   ├── inbound.ts        # build messages[] envelope
│   │   ├── status.ts         # build statuses[] envelope
│   │   └── verify.ts         # hub.challenge handshake
│   ├── api/control.route.ts  # /api/* control endpoints        [P2]
│   └── ws/
│       ├── server.ts         # /ws, one conn per group, heartbeat [P3]
│       ├── handlers.ts       # group.claim, message.send, ...  [P3]
│       └── lock.ts           # one-session-per-group lock      [P3]
├── mock.sqlite               # created at runtime (git-ignored)
├── .env / .env.example
├── package.json
└── tsconfig.json
```

**Ownership key:** `[P1]` Meta face · `[P2]` Data core + Control API · `[P3]` Live engine.

**Start order:** P2 first (DB + boot + store helpers). Then P1 and P3 build against P2.

---
---

# 👤 PERSON 2 — Data core + Control API (START FIRST)

**You are the spine. P1 and P3 cannot work until your DB + store helpers exist.
Do the DB first, then the control API.**

## Your task list
1. Set up SQLite (`better-sqlite3`) and run the schema on boot.
2. Write the store helper functions the others call (add/get numbers, groups, messages).
3. Build the boot file `src/index.ts` (express + sqlite) so P1/P3 can plug in.
4. Build the 8 control-API endpoints.

## Install
```bash
npm install better-sqlite3
npm install -D @types/better-sqlite3
```

## Step 1 — Create the database (6 tables). Put this in `src/db/schema.sql`:

```sql
-- business + customer numbers
CREATE TABLE IF NOT EXISTS numbers (
  phone_number_id TEXT PRIMARY KEY,   -- fake Meta id (business); customers get one too
  display_number  TEXT NOT NULL,      -- e.g. 919876543210
  label           TEXT,
  token           TEXT,               -- fake bearer token (business numbers only)
  type            TEXT NOT NULL,      -- 'business' | 'customer'
  reply_mode      TEXT DEFAULT 'manual', -- 'manual' | 'echo' | 'keyword'
  created_at      INTEGER NOT NULL
);

-- customer groups
CREATE TABLE IF NOT EXISTS groups (
  id           TEXT PRIMARY KEY,      -- slug, e.g. 'alpha'
  name         TEXT NOT NULL,
  locked       INTEGER DEFAULT 0,     -- session lock (one browser at a time)
  locked_since INTEGER,
  connected    INTEGER DEFAULT 0,     -- group currently open?
  created_at   INTEGER NOT NULL
);

-- which customer numbers belong to a group (up to 10)
CREATE TABLE IF NOT EXISTS group_members (
  group_id TEXT NOT NULL,
  number   TEXT NOT NULL,
  PRIMARY KEY (group_id, number)
);

-- a pair of numbers (business <-> customer)
CREATE TABLE IF NOT EXISTS conversations (
  id              TEXT PRIMARY KEY,
  business_number TEXT NOT NULL,
  customer_number TEXT NOT NULL,
  UNIQUE (business_number, customer_number)
);

-- every message + its status timeline
CREATE TABLE IF NOT EXISTS messages (
  id              TEXT PRIMARY KEY,   -- wamid.MOCK-...
  conversation_id TEXT NOT NULL,
  direction       TEXT NOT NULL,      -- 'outbound' (Comdove->customer) | 'inbound'
  from_number     TEXT NOT NULL,
  to_number       TEXT NOT NULL,
  body            TEXT NOT NULL,
  status          TEXT NOT NULL,      -- 'queued'|'sent'|'delivered'|'read'
  webhook_result  TEXT,               -- '200' or retry count, for the admin log
  created_at      INTEGER NOT NULL,
  sent_at         INTEGER,
  delivered_at    INTEGER,
  read_at         INTEGER
);

-- per-tile online/offline flag
CREATE TABLE IF NOT EXISTS presence (
  number   TEXT NOT NULL,
  group_id TEXT NOT NULL,
  online   INTEGER DEFAULT 0,
  PRIMARY KEY (number, group_id)
);
```

## Step 2 — Connect + run schema (`src/db/db.ts`, sketch):
```ts
import Database from 'better-sqlite3';
import { readFileSync } from 'node:fs';
export const db = new Database(process.env.DB_PATH ?? './mock.sqlite');
db.exec(readFileSync(new URL('./schema.sql', import.meta.url), 'utf8'));
```

## Step 3 — Store helpers others will call (`src/core/registry.ts`, `messages.ts`):
- `registerBusinessNumber(display, label) -> {phone_number_id, token}`
- `createGroup(name, numbers[]) -> group`  (also inserts customer numbers + members)
- `listBusinessNumbers()`, `listGroups()` (with free/locked status)
- `saveMessage({...}) -> message` , `getLog(limit)` , `resetAll(keepNumbers)`

## Step 4 — Build these 8 HTTP endpoints (all under `/api`, no auth):

| # | Method + path | Body | Returns | Purpose |
|---|---------------|------|---------|---------|
| 1 | `POST /api/business-numbers` | `{display_number, label}` | `{phone_number_id, token}` | Register a business number (FR-01) |
| 2 | `GET  /api/business-numbers` | – | `[ {...} ]` | List numbers (admin) |
| 3 | `POST /api/groups` | `{name, numbers:[≤10]}` | `{id, name, ...}` | Create group; numbers auto-register as customers (FR-15) |
| 4 | `GET  /api/groups` | – | `[ {id, name, count, status:"free"|"locked"} ]` | Launch list (FR-09, FR-16) |
| 5 | `POST /api/presence` | `{number, online}` | `200` | Set a tile online/offline (FR-05) |
| 6 | `POST /api/inject` | `{from, to, body}` | `{wamid}` | Fire an inbound message w/o a browser (FR-07 twin) |
| 7 | `GET  /api/log?limit=100` | – | `[ {id, from, to, body, status, webhook_result, ...} ]` | Admin live log (FR-11) |
| 8 | `POST /api/reset` | `{keep_numbers:true}` | `200` | Wipe messages/queues; keep numbers/groups if asked (FR-12) |

**Error format for these:** plain JSON `{ "error": { "message": "..." } }` with a 4xx
status. (No Meta envelope here — this side is not pretending to be Meta.)

### Example — endpoint 1 (register a business number)
Request:
```json
POST /api/business-numbers
{ "display_number": "918888800001", "label": "Support line" }
```
Response `200`:
```json
{ "phone_number_id": "MOCK-PN-1", "token": "MOCK-TOKEN-8f3a..." }
```

### Example — endpoint 3 (create a group)
Request:
```json
POST /api/groups
{ "name": "alpha", "numbers": ["919876543210", "919876543211"] }
```
Response `200`:
```json
{ "id": "alpha", "name": "alpha", "numbers": ["919876543210","919876543211"] }
```

## Your count
**6 tables + store helpers + 8 HTTP endpoints + the boot file.**
**Covers:** FR-01, FR-11, FR-12, FR-13, FR-15.
**Done when:** you can register numbers/groups and read them back via HTTP, and
`/api/log` + `/api/reset` work.

---
---

# 👤 PERSON 1 — The Meta face (HTTP in, webhooks out)

**You build the part Comdove actually talks to. It must copy Meta's exact JSON.**

## Your task list
1. Build the send endpoint (must look byte-identical to Meta).
2. Return real Meta error JSON for bad cases.
3. Fire webhooks back to Comdove (inbound + sent/delivered/read), signed + retried.
4. Do the verify handshake.

## Install
Nothing extra — use built-in `crypto` (HMAC) and `fetch` (to call Comdove).

## Task 1 — Send endpoint: `POST /v23.0/{phone_number_id}/messages`
Accept any `/vXX.X/` prefix and ignore it. Request that arrives (from Comdove):
```
POST /v23.0/{phone_number_id}/messages
Authorization: Bearer {token}
Content-Type: application/json

{ "messaging_product":"whatsapp", "recipient_type":"individual",
  "to":"919876543210", "type":"text",
  "text":{ "preview_url":false, "body":"Hello from Comdove" } }
```
**Validation order (important):**
1. Bearer token matches the registered token for `{phone_number_id}` → else **401 / code 190**.
2. `messaging_product=="whatsapp"` and `type=="text"` → else **400 / code 100**.
3. `to` is a registered customer number → else **400 / code 131026** (undeliverable).
4. On success: save the message (call P2's `saveMessage`), route it to the tile
   (P3) or queue it, and fire the **sent** status webhook.

Success response `200`:
```json
{ "messaging_product":"whatsapp",
  "contacts":[{ "input":"919876543210", "wa_id":"919876543210" }],
  "messages":[{ "id":"wamid.MOCK-a1b2c3d4e5f6" }] }
```
**wamid format:** `"wamid.MOCK-"` + a unique suffix.

**Mark-as-read (same endpoint):** body `{ "messaging_product":"whatsapp",
"status":"read", "message_id":"wamid..." }` → return `{ "success": true }`.

**Fallback:** any other path/type → `400` with a Meta-shaped error (code 100),
message "not implemented in comdove-mock".

## Task 2 — Error responses (Meta envelope):
```json
{ "error": {
    "message":"(#131026) Message undeliverable",
    "type":"OAuthException",
    "code":131026,
    "error_data":{ "messaging_product":"whatsapp", "details":"Recipient is not a registered mock number" },
    "fbtrace_id":"MOCK-trace-000123" } }
```
| Trigger | HTTP | code |
|---------|------|------|
| Missing/wrong bearer token | 401 | 190 |
| Bad body / wrong product / unsupported type or path | 400 | 100 |
| `to` not a registered customer | 400 | 131026 |
| Forced rate limit | 400 | 130429 |

**Error injection:** if request header `X-Mock-Force-Error: {code}` is present,
return exactly that error. (Mock-only testing hook.)

## Task 3 — Webhooks to Comdove (POST to `COMDOVE_WEBHOOK_URL`)
**Inbound** (a customer/tile sent a message):
```json
{ "object":"whatsapp_business_account",
  "entry":[{ "id":"MOCK-WABA-1", "changes":[{ "field":"messages",
    "value":{ "messaging_product":"whatsapp",
      "metadata":{ "display_phone_number":"918888800001", "phone_number_id":"MOCK-PN-1" },
      "contacts":[{ "profile":{ "name":"Tile 919876543210" }, "wa_id":"919876543210" }],
      "messages":[{ "from":"919876543210", "id":"wamid.MOCK-...", "timestamp":"1758270000",
        "type":"text", "text":{ "body":"how much?" } }] } }] }] }
```
**Status** (one webhook per transition sent→delivered→read):
```json
{ "object":"whatsapp_business_account",
  "entry":[{ "id":"MOCK-WABA-1", "changes":[{ "field":"messages",
    "value":{ "messaging_product":"whatsapp",
      "metadata":{ "display_phone_number":"918888800001", "phone_number_id":"MOCK-PN-1" },
      "statuses":[{ "id":"wamid.MOCK-...", "status":"delivered", "timestamp":"1758270031",
        "recipient_id":"919876543210" }] } }] }] }
```
**Signing (every webhook):** header
`X-Hub-Signature-256: sha256={HMAC-SHA256 of the RAW body, key = APP_SECRET}`.
Sign the exact bytes you send.
**timestamp** = unix seconds as a **string** (e.g. `"1758270000"`).
**Retries:** on non-200 or a 5s timeout, retry up to **3 times** (1s/5s/15s).
Record each attempt's result on the message's `webhook_result` (for P2's log).

## Task 4 — Verify handshake (`src/webhooks/verify.ts`)
On startup, GET Comdove's webhook with
`?hub.mode=subscribe&hub.verify_token={WEBHOOK_VERIFY_TOKEN}&hub.challenge={random}`
and expect the challenge echoed back with `200`.

## Your count
**1 Meta send endpoint (+ mark-as-read + fallback) + 3 outgoing webhook types
(inbound, status, verify) + signing + retries.**
**Covers:** FR-02, FR-03, FR-06, FR-07, FR-08.
**Done when:** Comdove send returns Meta success, bad token returns Meta error,
and Comdove receives signed webhooks it accepts.

---
---

# 👤 PERSON 3 — The live engine (WebSocket + presence/queue/lock)

**You make the tiles live: one open connection per group, instant delivery,
offline queue, and the one-browser-per-group lock.**

## Your task list
1. Run a WebSocket server at `/ws` (one connection per group).
2. Handle the 4 client→server events and send the 5 server→client events.
3. Implement presence (online/offline), the offline queue (flush in order), and
   the session lock. Persist via P2's tables.

## Install
```bash
npm install ws
npm install -D @types/ws
```

## The WebSocket endpoint
One connection **per group** at `ws://{host}/ws`. Every message is JSON:
`{ "type": "...", ...payload }`. No auth; the `group.claim` message takes the lock;
the lock releases when the socket closes.

## Handle these 4 — Client → server:
| type | payload | what you do |
|------|---------|-------------|
| `group.claim` | `{group}` | If free: lock it, reply `group.claimed` with a full snapshot (tiles + history + queued). If already locked: reply `group.locked`. (FR-16, FR-17) |
| `message.send` | `{from, to, body}` | Save the message (P2), then ask P1 to fire the inbound webhook to Comdove. (FR-07) |
| `tile.presence` | `{number, online}` | Update presence. If going online → flush that tile's queue in order. (FR-05) |
| `chat.read` | `{number, peer}` | Mark unread messages read → ask P1 to fire the read status webhook. (FR-06) |

## Send these 5 — Server → client:
| type | payload | when |
|------|---------|------|
| `group.claimed` | `{group, tiles:[{number, online, history, queued}]}` | after a successful claim |
| `group.locked` | `{group, since}` | claim refused (another session holds it) |
| `message.new` | `{to, message}` | a new message for an online tile (live, <1s) (FR-04) |
| `queue.flush` | `{number, messages:[]}` | queued messages delivered in order after a tile/group comes back (FR-05, FR-17) |
| `message.status` | `{wamid, status}` | mirror a status change so tiles show ticks |

## Presence / queue / lock rules
- **Online tile** → deliver immediately via `message.new`, then P1 fires `delivered`.
- **Offline tile / closed group** → set message `status='queued'`; do NOT deliver yet.
- **Back online** → send `queue.flush` in send order, then P1 fires `delivered` for each.
- **Closed group** = every number in it counts offline. On reopen: flush each
  conversation's queue in order, fire pending `delivered`, fire `read` as chats open. (FR-18)
- **Lock:** one active session per group. Second browser → `group.locked`. Lock
  releases on socket close.
- **Heartbeat:** ping every 15s; a missed pong closes the socket and releases the
  lock (so a killed browser never wedges a group). (FR-16)

## Your count
**1 WebSocket endpoint with 9 event types (4 in + 5 out) + presence + queue + lock.**
**Covers:** FR-04, FR-05, FR-16, FR-17, FR-18.
**Done when:** a message hits an online tile in <1s, offline messages queue and
flush in order on reconnect, and a second browser on an open group is refused.

---
---

# How the 3 connect

```
PERSON 2  (SQLite tables + store helpers + /api + boot)   ← spine, START FIRST
    │                                        │
    ├── PERSON 1 calls saveMessage() to store + fires webhooks to Comdove
    └── PERSON 3 reads presence/queue/history + runs the WebSocket server
```

- P1 needs P2's `saveMessage`, `registry` (to validate token/recipient).
- P3 needs P2's presence/queue tables + message history.
- P1 and P3 both fire off each other: a tile `message.send` (P3) triggers P1's
  inbound webhook; a Comdove send (P1) triggers P3's `message.new`.

## First 30 minutes — freeze together, write in README
1. **SQLite table shapes** (P2's schema above).
2. **WebSocket event names** (P3's 9 events above).
3. **`/api` paths** (P2's 8 endpoints above).

## Checkpoints (hard stops)
- **Hour 3:** register a number/group (P2) → Comdove send appears in a tile
  (P1 → P2 → P3) → reply reaches Comdove (P3 → P1) → shows in the log (P2).
- **Hour 5:** offline queue + close/reopen + one error case.
- **Rule:** not integrated at a checkpoint → **simplify it, never extend it.**

## Total backend surface
- **~10 HTTP endpoints** — 8 control (P2) + 1 Meta send w/ fallback (P1)
- **3 outgoing webhook types** — inbound, status, verify (P1)
- **1 WebSocket endpoint** — 9 event types (P3)
- **6 SQLite tables** (P2)
