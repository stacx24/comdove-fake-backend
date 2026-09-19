# comdove-fake-backend — Team Split (Backend, 3 people)

Backend-only split for the hackathon. Each person's section below is **self-contained** —
it tells you exactly what to build: the APIs (with request/response), the SQL, and
the WebSocket events. The client grid and admin UI are built by the separate UI team
against the contract in `src/contract/` (see "Handoff to the UI team").

Full spec background: [`docs/BACKEND-BUILD-PLAN.md`](docs/BACKEND-BUILD-PLAN.md)
(section numbers below like **§9f** point into that file). Source docs: `docs/*.pdf`.

**[Gap]** = the PDFs don't say; the build plan decided it (all listed in plan §22).

---

## Folder structure (who owns what)

```
comdove-fake-backend/
├── src/
│   ├── index.ts                 # boot: env → db → express → ws → handshake → listen  [P2 sets up, P1/P3 plug in]
│   ├── config/env.ts            # read + validate env                                  [P2]
│   ├── contract/                # SHARED with the UI team — freeze in the first 30 min
│   │   ├── ws-events.ts         # every WebSocket event + payload                     [P3]
│   │   └── api-types.ts         # every /api request + response                       [P2]
│   ├── db/
│   │   ├── schema.sql           # CREATE TABLE statements                             [P2]
│   │   └── db.ts                # better-sqlite3 connection + helpers                  [P2]
│   ├── core/
│   │   ├── registry.ts          # numbers, groups, customers, messages store          [P2]
│   │   ├── autoreply.ts         # echo / keyword engine (FR-10)                       [P2]
│   │   ├── lifecycle.ts         # sent → delivered → read state machine + webhooks    [P1]
│   │   ├── presence.ts          # effective online = group claimed AND tile flag      [P3]
│   │   ├── delivery.ts          # route to tile vs queue, flush in order              [P3]
│   │   └── bus.ts               # in-process event bus → WS sessions + admin feed     [P3]
│   ├── meta/                    # Meta emulator                                       [P1]
│   │   ├── messages.route.ts    # POST /:version/:phoneNumberId/messages
│   │   ├── validate.ts          # validation pipeline (steps 0–6)
│   │   ├── errors.ts            # Meta error envelope + codes + X-Mock-Force-Error
│   │   ├── responses.ts         # success shape + wamid.MOCK- generator
│   │   └── not-implemented.ts   # catch-all for every other Graph path
│   ├── webhooks/                # dispatcher                                          [P1]
│   │   ├── dispatcher.ts        # per-conversation FIFO, retry 1s/5s/15s, attempt log
│   │   ├── sign.ts              # X-Hub-Signature-256 (HMAC-SHA256)
│   │   ├── envelopes.ts         # inbound messages[] + statuses[] builders
│   │   └── verify.ts            # hub.challenge handshake
│   ├── api/                     # control API                                         [P2]
│   │   ├── numbers.route.ts     # business numbers + customers
│   │   ├── groups.route.ts
│   │   ├── traffic.route.ts     # presence, inject, log
│   │   ├── autoreply.route.ts
│   │   └── system.route.ts      # reset (+ /reset alias), status, webhook/verify
│   └── ws/                      # WebSocket server                                    [P3]
│       ├── server.ts            # /ws upgrade + 15s heartbeat
│       ├── group-session.ts     # group.claim, message.send, tile.presence, chat.read, tile.autoreply
│       ├── admin-feed.ts        # admin.subscribe + broadcasts
│       └── lock.ts              # in-memory one-session-per-group lock
├── tools/
│   ├── fake-comdove.ts          # receiver: checks signature, answers handshake, logs   [P1]
│   └── seed-comdove.ts          # puts mock ids/tokens into Comdove's LOCAL Postgres  [P2]
├── test/                        # each person tests their own folder
├── mock.sqlite                  # created at runtime (git-ignored)
├── .env / .env.example
├── package.json
└── tsconfig.json
```

**Ownership key:** `[P1]` Meta face · `[P2]` Data core + Control API · `[P3]` Live engine.

**Start order:** P2 first (DB + boot + store helpers). P1 and P3 start at the same time
against **stubs** of P2's functions (below), and swap to the real ones at checkpoint ①.

---

## Shared rules (everyone)

- **Numbers** are digits only (strip `+`, spaces, dashes); 8–15 digits. The digits are
  also the `wa_id`.
- **Timestamps:** stored as ms (`Date.now()`); in Meta webhooks as **Unix seconds, as a
  string** (`"1758270000"`).
- **wamid:** `"wamid.MOCK-"` + 24 hex chars (`crypto.randomBytes(12)`), for both
  directions.
- **"Queued" is not a status.** A queued message has been `sent` (webhook fired on API
  accept) but has no `delivered_at` yet.
- **"Delivered"** = pushed over an open socket to an online tile **[Gap]** (there is no
  client ack in the spec).
- **Lock is in memory**, never in SQLite **[Gap]** — a crash must not wedge a group.
- **Never** send the `X-Local-Test` header to Comdove.

### Interfaces between the three of you (write these first, stub them, then fill in)

```ts
// P2 — core/registry.ts
getBusiness(phoneNumberIdOrDisplay: string): BusinessNumber | null
getCustomer(number: string): Customer | null            // includes group_id, online, reply_mode
listGroupTiles(groupId: string): Customer[]
storeMessage(m: NewMessage): StoredMessage              // one transaction: conversation, seq, insert
setDelivered(wamid: string, at: number): void
setRead(wamids: string[], at: number): void
queuedFor(number: string): StoredMessage[]              // outbound, delivered_at IS NULL, by conversation+seq
history(number: string): StoredMessage[]
getLogEntry(wamid: string): LogEntry

// P1 — core/lifecycle.ts   (P3 and P2 call these; they never build webhooks themselves)
outboundAccepted(msg: StoredMessage): void              // enqueue 'sent' (after STATUS_WEBHOOK_DELAY_MS)
delivered(msgs: StoredMessage[]): void                  // setDelivered + enqueue 'delivered' in seq order
read(number: string, peer: string): void                // setRead + enqueue 'read' in seq order
inbound(from: string, to: string, body: string, source: 'tile'|'inject'|'autoreply'): StoredMessage

// P3 — core/delivery.ts + core/bus.ts
deliver(msg: StoredMessage): 'delivered' | 'queued'     // push message.new or leave queued
setPresence(number: string, online: boolean): void      // store flag, push tile.presence, flush if online
emit(event: BusEvent): void                             // → group sessions + admin feed
```

---
---

# 👤 PERSON 2 — Data core + Control API (START FIRST)

**You are the spine. P1 and P3 cannot integrate until your DB + store helpers exist.
Do the DB first (~1.5 h), then the control API, then auto-reply and the Comdove seed.**

## Your task list
1. Set up SQLite (`better-sqlite3`, WAL, foreign keys on) and run the schema on boot.
2. Write the store helpers above (`core/registry.ts`).
3. Build `src/index.ts` + `src/config/env.ts` so P1/P3 can plug in.
4. Build the 15 control-API endpoints + the `/reset` alias (16 rows below).
5. Build the auto-reply engine (FR-10).
6. Write `tools/seed-comdove.ts` so wat-backend knows the mock's numbers.
7. Give the UI team fixtures (sample JSON for every `/api` response) from `src/contract/api-types.ts`.

## Install
```bash
npm install better-sqlite3
npm install -D @types/better-sqlite3
```

## Step 1 — Env (`src/config/env.ts`)

| Variable | Example | Notes |
|---|---|---|
| `PORT` | `4020` | HTTP + WebSocket |
| `COMDOVE_WEBHOOK_URL` | `http://localhost:3000/webhooks/whatsapp` | where webhooks go |
| `APP_SECRET` | `mock-app-secret-1` | must equal wat-backend `META_APP_SECRET` |
| `WEBHOOK_VERIFY_TOKEN` | `mock-verify-1` | must equal wat-backend `WHATSAPP_VERIFY_TOKEN` |
| `DB_PATH` | `./mock.sqlite` | delete for a factory reset |
| `STATUS_WEBHOOK_DELAY_MS` **[Gap]** | `500` | optional, default 500 — used by P1 |

Add `STATUS_WEBHOOK_DELAY_MS=500` to `.env.example`.

## Step 2 — Create the database (8 tables). Put this in `src/db/schema.sql`:

```sql
PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;

-- Business numbers (FR-01)
CREATE TABLE IF NOT EXISTS business_numbers (
  phone_number_id TEXT PRIMARY KEY,          -- 'MOCK-PN-n' or supplied (Comdove's id)
  display_number  TEXT NOT NULL UNIQUE,      -- digits only
  label           TEXT,
  token           TEXT NOT NULL,             -- fake bearer token
  waba_id         TEXT NOT NULL,             -- webhook entry[].id; must match Comdove WabaAccount.wabaId
  created_at      INTEGER NOT NULL
);

-- Client groups (FR-15). NO lock columns — the lock lives in memory (P3).
CREATE TABLE IF NOT EXISTS groups (
  id          TEXT PRIMARY KEY,              -- slug of name, the ?group= value (FR-14)
  name        TEXT NOT NULL UNIQUE,
  created_at  INTEGER NOT NULL
);

-- Customer numbers = tiles. Exactly ONE group per customer. [Gap]
CREATE TABLE IF NOT EXISTS customers (
  number          TEXT PRIMARY KEY,
  group_id        TEXT NOT NULL REFERENCES groups(id) ON DELETE CASCADE,
  position        INTEGER NOT NULL,          -- tile order
  label           TEXT,                      -- webhook contacts[].profile.name
  online          INTEGER NOT NULL DEFAULT 1,-- tile flag, default ONLINE [Gap]
  reply_mode      TEXT NOT NULL DEFAULT 'manual' CHECK (reply_mode IN ('manual','echo','keyword')),
  reply_delay_ms  INTEGER NOT NULL DEFAULT 0 CHECK (reply_delay_ms BETWEEN 0 AND 30000),
  created_at      INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_customers_group ON customers(group_id, position);

-- Keyword map (FR-10). First match by position wins.
CREATE TABLE IF NOT EXISTS keyword_replies (
  id               INTEGER PRIMARY KEY AUTOINCREMENT,
  customer_number  TEXT NOT NULL REFERENCES customers(number) ON DELETE CASCADE,
  position         INTEGER NOT NULL,
  keyword          TEXT NOT NULL,            -- case-insensitive "contains"
  reply            TEXT NOT NULL
);

-- Pair of numbers; next_seq gives per-conversation ordering
CREATE TABLE IF NOT EXISTS conversations (
  id               INTEGER PRIMARY KEY AUTOINCREMENT,
  phone_number_id  TEXT NOT NULL,
  customer_number  TEXT NOT NULL,
  next_seq         INTEGER NOT NULL DEFAULT 1,
  UNIQUE (phone_number_id, customer_number)
);

-- Every message + status timeline (FR-11)
CREATE TABLE IF NOT EXISTS messages (
  wamid            TEXT PRIMARY KEY,
  conversation_id  INTEGER NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  seq              INTEGER NOT NULL,
  direction        TEXT NOT NULL CHECK (direction IN ('outbound','inbound')), -- outbound = Comdove -> tile
  source           TEXT NOT NULL CHECK (source IN ('api','tile','inject','autoreply')),
  from_number      TEXT NOT NULL,
  to_number        TEXT NOT NULL,
  body             TEXT NOT NULL,
  created_at       INTEGER NOT NULL,
  sent_at          INTEGER,
  delivered_at     INTEGER,
  read_at          INTEGER,
  UNIQUE (conversation_id, seq)
);
CREATE INDEX IF NOT EXISTS idx_messages_created ON messages(created_at DESC);

-- One row per webhook Comdove must get (P1 writes). Payload kept so retries are byte-identical.
CREATE TABLE IF NOT EXISTS webhook_jobs (
  id               INTEGER PRIMARY KEY AUTOINCREMENT,
  conversation_id  INTEGER NOT NULL,
  wamid            TEXT NOT NULL,
  kind             TEXT NOT NULL CHECK (kind IN ('inbound','sent','delivered','read')),
  payload          TEXT NOT NULL,
  state            TEXT NOT NULL DEFAULT 'pending' CHECK (state IN ('pending','ok','failed')),
  created_at       INTEGER NOT NULL,
  finished_at      INTEGER
);
CREATE INDEX IF NOT EXISTS idx_jobs_pending ON webhook_jobs(state, conversation_id, id);

-- Every attempt + outcome (P1 writes, admin log reads)
CREATE TABLE IF NOT EXISTS webhook_attempts (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  job_id       INTEGER NOT NULL REFERENCES webhook_jobs(id) ON DELETE CASCADE,
  attempt      INTEGER NOT NULL,             -- 1..4
  http_status  INTEGER,
  error        TEXT,
  duration_ms  INTEGER,
  at           INTEGER NOT NULL
);
```

Derived, no columns: **status** = read if `read_at`, else delivered if `delivered_at`,
else sent · **queue** = outbound with `delivered_at IS NULL` by `seq` · **unread** =
delivered and not read.

## Step 3 — Connect + run schema (`src/db/db.ts`, sketch):
```ts
import Database from 'better-sqlite3';
import { readFileSync } from 'node:fs';
export const db = new Database(process.env.DB_PATH ?? './mock.sqlite');
db.exec(readFileSync(new URL('./schema.sql', import.meta.url), 'utf8'));
```

## Step 4 — Store helpers (`src/core/registry.ts`)
The `P2` interface in "Interfaces" above, plus:
- `registerBusinessNumber({display_number, label, phone_number_id?, waba_id?, token?})`
- `createGroup(name, numbers[], labels?)` (inserts customers in one transaction)
- `deleteBusinessNumber(id)`, `deleteGroup(id)` (keep messages for the log until reset)
- `listBusinessNumbers()`, `listGroups()` (status from P3's `lock.isLocked(id)`), `listCustomers()`
- `getLog(limit)`, `resetAll(keepNumbers)`

## Step 5 — The control API (all under `/api`, no auth)

| # | Method + path | Body | Returns | FR |
|---|---|---|---|---|
| 1 | `POST /api/business-numbers` | `{display_number, label, phone_number_id?, waba_id?, token?}` | `{phone_number_id, token, waba_id, display_number, label}` | FR-01 |
| 2 | `GET /api/business-numbers` | – | `[{phone_number_id, display_number, label, token, waba_id, created_at}]` | FR-01 |
| 3 | `DELETE /api/business-numbers/:phone_number_id` **[Gap]** | – | `204` | PRD C5 |
| 4 | `POST /api/groups` | `{name, numbers:[1..10], labels?}` | `{id, name, numbers}` | FR-15 |
| 5 | `GET /api/groups` | – | `[{id, name, count, status:"free"\|"locked", locked_since}]` | FR-09, FR-16 |
| 6 | `DELETE /api/groups/:id` **[Gap]** | – | `204`, or `409` if claimed | PRD C5 |
| 7 | `GET /api/customers` **[Gap]** | – | `[{number, label, group_id, online, effective_online, claim_status, reply_mode}]` | PRD §7 admin list |
| 8 | `POST /api/presence` | `{number, online}` | `{number, online, effective_online}` | FR-05, FR-13 |
| 9 | `POST /api/inject` | `{from, to, body}` | `{wamid}` | FR-07, FR-13 |
| 10 | `GET /api/log?limit=100` | – | log entries, newest first | FR-11 |
| 11 | `POST /api/reset` | `{keep_numbers?}` (default `true`) | `{ok:true}` | FR-12 |
| 12 | `POST /reset` **[Gap]** | same | same | FR-12 wording (alias) |
| 13 | `GET /api/customers/:number/auto-reply` **[Gap]** | – | `{mode, delay_ms, rules:[{keyword, reply}]}` | FR-10 |
| 14 | `PUT /api/customers/:number/auto-reply` **[Gap]** | `{mode, delay_ms, rules}` | same | FR-10 |
| 15 | `POST /api/webhook/verify` **[Gap]** | – | `{ok, detail}` (calls P1's `verify()`) | Spec §5 |
| 16 | `GET /api/status` **[Gap]** | – | `{uptime, comdove_webhook_url, verify, pending_webhooks, counts}` | admin header |

**Error format:** `{ "error": { "message": "..." } }` with 4xx. No Meta envelope here.

**Validation:**
- Max **10** business numbers.
- A group has 1–10 numbers.
- A number can't be a customer in two groups, or a customer and a business number → `409`.
- Group `id` = slug of `name` (`a-z0-9-`).

**Behaviour that must match the WebSocket (call the shared functions, don't re-implement):**
- `/api/presence` → P3's `setPresence()` (stores the flag, pushes `tile.presence` to the
  open group, flushes the queue if going online).
- `/api/inject` → P1's `lifecycle.inbound(..., 'inject')`. Works even when the group is
  closed (no browser needed).
- Every change → `bus.emit(...)` so the admin feed updates (`numbers.update`,
  `groups.update`, `log.entry`).

**Log entry shape** (`/api/log` and P3's admin feed use the same builder):
```json
{ "wamid":"wamid.MOCK-...", "time":1758270000123, "direction":"outbound", "source":"api",
  "from":"918888800001", "to":"919876543210",
  "business":{ "phone_number_id":"MOCK-PN-1", "label":"Sales" }, "group_id":"alpha",
  "body":"Hello from Comdove", "status":"delivered",
  "timeline":[ {"status":"sent","at":1758270000123}, {"status":"delivered","at":1758270000410} ],
  "webhooks":[ {"kind":"sent","state":"ok","attempts":[{"n":1,"http_status":200,"duration_ms":12,"at":1758270000650}]} ] }
```
Rejected Meta requests (errors, forced errors) appear with `direction:"rejected"`,
the error code, and no wamid.

**Reset (FR-12):**
1. Cancel P1's in-flight retries (`dispatcher.cancelAll()`).
2. Delete `webhook_attempts`, `webhook_jobs`, `messages`, `conversations`.
3. If `keep_numbers:false`, also delete `keyword_replies`, `customers`, `groups` and
   `business_numbers`, and P3 closes open sessions with `error {code:'group_deleted'}`.
4. Otherwise P3 pushes a fresh `group.claimed` snapshot to each open session.
5. Emit `log.reset` and `groups.update`.

### Example — register a business number
```json
POST /api/business-numbers
{ "display_number": "918888800001", "label": "Support line" }
→ 200 { "phone_number_id": "MOCK-PN-1", "token": "mock-token-8f3a...", "waba_id": "MOCK-WABA-1",
        "display_number": "918888800001", "label": "Support line" }
```
To reuse ids Comdove already has (plan §5c way A), pass `phone_number_id`, `waba_id`, `token`.

### Example — create a group
```json
POST /api/groups
{ "name": "alpha", "numbers": ["919876543210", "919876543211"] }
→ 200 { "id": "alpha", "name": "alpha", "numbers": ["919876543210","919876543211"] }
```

## Step 6 — Auto-reply engine (`src/core/autoreply.ts`, FR-10) **[Gap: runs on the server]**

| mode | behaviour |
|---|---|
| `manual` | nothing (default) |
| `echo` | reply with the same body |
| `keyword` | first rule whose `keyword` is contained in the body (case-insensitive) → its `reply`; no match → nothing |

- **Trigger:** listen on the bus for an **outbound message delivered** to a tile (live,
  flushed, or on reconnect). A message that is still queued does not trigger.
- **Reply:** after `delay_ms`, call `lifecycle.inbound(customer, business, reply, 'autoreply')`
  to the business number that sent the message. Drop the reply if the tile went offline
  meanwhile.
- **No loops:** only outbound messages trigger replies, and replies are inbound.

## Step 7 — Comdove seed (`tools/seed-comdove.ts`) **[Gap — critical]**

wat-backend reads the token from **its DB** (`WabaAccount.accessTokenEncrypted`), not env,
and drops webhooks for an unknown `phoneNumberId` (`UNKNOWN_PHONE_NUMBER`). For each mock
business number, the script upserts into Comdove's **local** Postgres (never prod):
- `WabaAccount`: `wabaId`, and `accessTokenEncrypted = encryptSecret(token)` using
  wat-backend's `src/utils/crypto.ts`.
- `WabaPhoneNumber`: `phoneNumberId`, `displayPhoneNumber`, `teamId`, `wabaAccountId`.

Alternative: register mock numbers with Comdove's existing ids (plan §5c).

## Your count
**8 tables + store helpers + 15 endpoints + `/reset` alias + boot/env + auto-reply engine
+ Comdove seed + UI fixtures.**
**Covers:** FR-01, FR-09 (list), FR-10, FR-11 (log data), FR-12, FR-13, FR-14 (slug), FR-15.
**Demo steps you own:** 1 (register), 2 (seed + env), 8 (keyword bot), 10 (reset).
**Done when:**
- Numbers and groups can be registered, listed and deleted over HTTP.
- `/api/log`, `/api/reset` and `/reset` work.
- A keyword tile answers a message on its own.
- wat-backend resolves the mock's `phone_number_id`.

---
---

# 👤 PERSON 1 — The Meta face (HTTP in, webhooks out)

**You build the part Comdove actually talks to. It must copy Meta's exact JSON.
You also own the message lifecycle, so every status webhook goes through you.**

## Your task list
1. Send endpoint + mark-as-read + not-implemented catch-all.
2. Real Meta error JSON, incl. unknown `phone_number_id` and `X-Mock-Force-Error`.
3. `core/lifecycle.ts` — the sent → delivered → read state machine.
4. Webhook dispatcher: envelopes, signing, per-conversation FIFO, status delay, retries,
   attempt log, restart resume.
5. Verify handshake.
6. `tools/fake-comdove.ts` so everyone can test without wat-backend.

## Install
Nothing extra — built-in `crypto` (HMAC) and `fetch` (with `AbortSignal.timeout(5000)`).

## Task 1 — Send endpoint: `POST /{version}/{phone_number_id}/messages`
Accept any version matching `^v\d+\.\d+$` and ignore it. Request from Comdove:
```
POST /v23.0/{phone_number_id}/messages
Authorization: Bearer {token}
Content-Type: application/json

{ "messaging_product":"whatsapp", "recipient_type":"individual",
  "to":"919876543210", "type":"text",
  "text":{ "preview_url":false, "body":"Hello from Comdove" } }
```
`recipient_type` and `preview_url` are **optional**. wat-backend's `sendTextMessage`
doesn't send them.

**Validation order (important):**

| Step | Check | Failure |
|---|---|---|
| 0 **[Gap]** | `X-Mock-Force-Error` header present → return that error, store nothing | forced error |
| 1 **[Gap]** | `{phone_number_id}` is registered | **400 / 100 / subcode 33** |
| 2 | Bearer token equals that number's token | **401 / 190** |
| 3 | JSON body, `messaging_product == "whatsapp"` | **400 / 100** |
| 4 | It's a send (`type`) or a mark-as-read (`status:"read"`) | **400 / 100** |
| 5 | Send: `type == "text"`, `text.body` non-empty ≤ 4096, `to` present | **400 / 100** (other types: "not implemented in comdove-mock") |
| 6 | `to` is a registered customer | **400 / 131026** |

**On success:**
1. `storeMessage` (P2), then `lifecycle.outboundAccepted(msg)` (enqueues `sent`).
2. Respond **200**.
3. Call `deliver(msg)` (P3) — it pushes the message to the tile or leaves it queued.

Success response `200`:
```json
{ "messaging_product":"whatsapp",
  "contacts":[{ "input":"919876543210", "wa_id":"919876543210" }],
  "messages":[{ "id":"wamid.MOCK-a1b2c3d4e5f6" }] }
```
`input` echoes `to` exactly as sent; `wa_id` is the digits only.

**Mark-as-read:**
- Request: `{ "messaging_product":"whatsapp", "status":"read", "message_id":"wamid..." }`
  → `{ "success": true }`.
- `message_id` must be an **inbound** message to this business number, else 400 / 100.
- Set its `read_at` and emit `message.status {status:'read'}` so the tile shows blue ticks.
- **Fire no webhook** **[Gap]** — real Meta sends none for this.

**Catch-all:**
- Any other Graph path or method → `400`, Meta envelope, `code: 100`, message
  `"(#100) <METHOD> <path> is not implemented in comdove-mock"`.
- Examples: media, templates, `phone_numbers`, `subscribed_apps`.
- Mount it **after** `/api`, `/reset` and `/ws`.

## Task 2 — Error responses (Meta envelope)
```json
{ "error": {
    "message":"(#131026) Message undeliverable",
    "type":"OAuthException",
    "code":131026,
    "error_data":{ "messaging_product":"whatsapp", "details":"Recipient is not a registered mock number" },
    "fbtrace_id":"MOCK-trace-000123" } }
```
- Add `"error_subcode"` only where Meta has one (FR-03 names it).
- `fbtrace_id` = `MOCK-trace-` + a 6-digit counter.

| Trigger | HTTP | code | subcode |
|---------|------|------|---------|
| Unknown `phone_number_id` **[Gap]** | 400 | 100 | 33 |
| Missing/wrong bearer token | 401 | 190 | – |
| Bad body / wrong product / unsupported type or path | 400 | 100 | – |
| `to` not a registered customer | 400 | 131026 | – |
| Forced rate limit | 400 | 130429 | – |

**Error injection:**
- `X-Mock-Force-Error: {code}` accepts `190`, `100`, `33`, `131026` or `130429`. Any other
  value → 400 / 100 "unsupported X-Mock-Force-Error value".
- Log every rejected request to the admin log as `direction:"rejected"`.
- wat-backend can't send this header, so the demo's bad-token step uses a real wrong
  token.

## Task 3 — Lifecycle (`src/core/lifecycle.ts`)
Implement the `P1` interface above.
- **`delivered(msgs)`** — for each message in `seq` order: `setDelivered`, enqueue the
  `delivered` job, and emit `message.status` + `log.update`.
- **`read(number, peer)`** — find the chat's messages that are delivered but not read, in
  `seq` order: `setRead`, enqueue `read` jobs, emit the same events.
- **Always delivered before read** **[Gap]** (allowed by Spec §5).
- **`inbound(from, to, body, source)`** — `storeMessage`, emit `message.new` to the open
  group (if any) + `log.entry`, and enqueue the `inbound` job.

## Task 4 — Webhooks to Comdove (POST to `COMDOVE_WEBHOOK_URL`)
**Inbound:**
```json
{ "object":"whatsapp_business_account",
  "entry":[{ "id":"<business waba_id>", "changes":[{ "field":"messages",
    "value":{ "messaging_product":"whatsapp",
      "metadata":{ "display_phone_number":"918888800001", "phone_number_id":"<business phone_number_id>" },
      "contacts":[{ "profile":{ "name":"Tile 919876543210" }, "wa_id":"919876543210" }],
      "messages":[{ "from":"919876543210", "id":"wamid.MOCK-...", "timestamp":"1758270000",
        "type":"text", "text":{ "body":"how much?" } }] } }] }] }
```
**Status** (one status per webhook):
```json
{ "object":"whatsapp_business_account",
  "entry":[{ "id":"<business waba_id>", "changes":[{ "field":"messages",
    "value":{ "messaging_product":"whatsapp",
      "metadata":{ "display_phone_number":"918888800001", "phone_number_id":"<business phone_number_id>" },
      "statuses":[{ "id":"wamid.MOCK-...", "status":"delivered", "timestamp":"1758270031",
        "recipient_id":"919876543210" }] } }] }] }
```
- `entry[].id` = **that business number's `waba_id`** **[Gap]**, not a hardcoded
  `MOCK-WABA-1`.
- `profile.name` = the customer's `label`, else `"Tile {number}"`.
- No `conversation` or `pricing` objects.

**Signing:**
- Header: `X-Hub-Signature-256: sha256=<hex HMAC-SHA256 of the raw body, key = APP_SECRET>`,
  plus `Content-Type: application/json`.
- Serialize the body **once**, store it in `webhook_jobs.payload`, and sign and send those
  exact bytes on every attempt.

**Dispatcher rules:**
- **Per-conversation FIFO** **[Gap]**: one job at a time per `conversation_id`, in `id`
  order. The next job waits until the previous one is `ok` or `failed`. Different
  conversations run in parallel.
- **Status delay** **[Gap]**: don't send a message's first status job until
  `STATUS_WEBHOOK_DELAY_MS` (500 ms) after the API response. wat-backend stores the wamid
  only after our 200 comes back; a status that arrives earlier fails permanently with
  `UNKNOWN_WAMID`.
- **Success = HTTP 200.** Anything else, a network error or a **5 s timeout** is a failure.
- **Retries:** 1 attempt + **3 retries** after **1 s / 5 s / 15 s**. After the 4th failure,
  mark the job `failed` and move on.
- Write a `webhook_attempts` row for every attempt and emit `log.update`.
- On boot, resume `pending` jobs in FIFO order. Expose `cancelAll()` for reset.

## Task 5 — Verify handshake (`src/webhooks/verify.ts`)
- **When:** on boot, and from P2's `POST /api/webhook/verify`.
- **Request:** `GET {COMDOVE_WEBHOOK_URL}?hub.mode=subscribe&hub.verify_token={WEBHOOK_VERIFY_TOKEN}&hub.challenge={random 10 digits}`.
- **Pass:** HTTP 200 and a body equal to the challenge.
- **Result:** keep `{ok, at, detail}` in memory for `/api/status`, and emit `webhook.verify`.
- **Never block boot.** If Comdove is down, log a warning.

## Task 6 — `tools/fake-comdove.ts`
A tiny Express app on port 3000 at `/webhooks/whatsapp`:
- GET answers the handshake.
- POST checks the signature against `APP_SECRET`, logs the payload, and returns 200.
- A flag makes it return 500 N times, so retries can be tested.

## Your count
**1 Meta endpoint (send + mark-as-read) + catch-all + 5 error codes + lifecycle + 4 webhook
kinds (inbound, sent, delivered, read) + handshake + FIFO dispatcher with retries + fake
Comdove.**
**Covers:** FR-02, FR-03, FR-06, FR-07, FR-08, FR-18 (statuses).
**Demo steps you own:** 3 (sent/delivered/read reach Comdove), 7 (signed inbound), 9 (bad token).
**Done when:**
- A Comdove send gets Meta's success response, and a bad token gets 401 / 190.
- Fake Comdove and real wat-backend accept every webhook in order.
- A forced 500 shows 4 attempts in the log.

---
---

# 👤 PERSON 3 — The live engine (WebSocket + presence/queue/lock + admin feed)

**You make the tiles live: one open connection per group, instant delivery,
offline queue, the one-browser-per-group lock, and the live admin feed.**

## Your task list
1. WebSocket server at `/ws` with a 15 s heartbeat.
2. Group sessions: 5 client→server events, 8 server→client events.
3. Presence, delivery and queue flush (`core/presence.ts`, `core/delivery.ts`).
4. In-memory lock (`ws/lock.ts`).
5. The event bus (`core/bus.ts`) and the admin feed (`ws/admin-feed.ts`).
6. Write `src/contract/ws-events.ts` for the UI team.

## Install
```bash
npm install ws
npm install -D @types/ws
```

## The WebSocket endpoint
- `ws://{host}:4020/ws`. Every frame is JSON: `{ "type": "...", ...payload }`. No auth.
- A socket becomes a **group session** by sending `group.claim`, or an **admin feed** by
  sending `admin.subscribe`. One group per socket.

## Handle these 5 — Client → server (group session)
| type | payload | what you do |
|------|---------|-------------|
| `group.claim` | `{group}` | Free: lock it, send `group.claimed` (snapshot), then `lifecycle.delivered()` for every online tile's queued messages. Locked: `group.locked`. Unknown group: `error`. (FR-09, FR-14, FR-16, FR-17, FR-18) |
| `message.send` | `{from, to, body}` | `from` = tile, `to` = business (display number or phone_number_id) → `lifecycle.inbound(from, to, body, 'tile')`. (FR-07) |
| `tile.presence` | `{number, online}` | `setPresence()`. Going online → `queue.flush` in `seq` order, then `lifecycle.delivered()`. (FR-05) |
| `chat.read` | `{number, peer}` | `lifecycle.read(number, peer)`. Ignored if the tile is offline. (FR-06) |
| `tile.autoreply` **[Gap]** | `{number, mode, delay_ms, rules}` | Same as P2's `PUT /api/customers/:number/auto-reply`. (FR-10) |

An action before a claim, or for a number that isn't in the claimed group →
`error {code, message}`, and nothing changes.

## Send these 8 — Server → client (group session)
| type | payload | when |
|------|---------|------|
| `group.claimed` | snapshot (below) | after a claim, and again after a reset |
| `group.locked` | `{group, since}` | claim refused |
| `message.new` | `{to, number, message}` | a new message for an online tile, < 1 s (FR-04). `number` **[Gap]** = the tile it belongs to. Also sent for inbound messages from inject or auto-reply, so the tile shows them |
| `queue.flush` | `{number, messages:[]}` | queued messages, in order, when a tile comes back online (FR-05) |
| `message.status` | `{wamid, number, status, at}` | status ticks. Also `read` on the tile's own message when Comdove marks it read |
| `tile.presence` **[Gap]** | `{number, online}` | presence changed via `/api/presence` |
| `tile.autoreply` **[Gap]** | `{number, mode, delay_ms, rules}` | auto-reply changed via the API |
| `error` **[Gap]** | `{code, message}` | bad request. `group_deleted` also closes the socket |

**Snapshot** (the grid must render from this alone):
```json
{ "type":"group.claimed",
  "group":{ "id":"alpha", "name":"Alpha" },
  "business_numbers":[ { "phone_number_id":"MOCK-PN-1", "display_number":"918888800001", "label":"Sales" } ],
  "tiles":[ { "number":"919876543210", "label":null, "online":true,
              "auto_reply":{ "mode":"manual", "delay_ms":0, "rules":[] },
              "history":[ { "wamid":"...", "peer":"918888800001", "direction":"outbound", "body":"...", "status":"read", "created_at":0 } ],
              "queued":[ ... ],
              "unread":{ "918888800001": 2 } } ] }
```
- `business_numbers` **[Gap]** lets a tile pick which business to reply to.
- A tile has **one chat per business number**.

## Admin feed **[Gap: FR-11 real time]**
- The client sends `admin.subscribe {}`, then loads history with `GET /api/log`.
- Broadcast to all admin sockets:
  - `log.entry` — a new entry (P2's log shape).
  - `log.update` — the full entry, whenever a status or webhook attempt changes.
  - `log.reset`.
  - `groups.update` — the same list as `GET /api/groups`.
  - `numbers.update`.
  - `webhook.verify`.
- The launch page may subscribe too, so free/locked status is live (FR-09).

## Presence / queue / lock rules
- **Effective online** = group claimed **AND** tile flag online. A closed group means
  every tile in it is offline.
- **Default:** the tile flag starts online and is stored in SQLite, so a tile toggled
  offline stays offline when the group reopens **[Gap]**.
- **`deliver(msg)`:**
  - Tile effectively online → push `message.new`, then `lifecycle.delivered([msg])`.
  - Otherwise → leave it queued.
- **Back online** → one `queue.flush` with the queued messages in `seq` order, then
  `lifecycle.delivered(msgs)`.
- **Reopen** (FR-17, FR-18):
  1. Take the lock and send the snapshot, with the waiting messages in `queued`.
  2. Call `lifecycle.delivered()` for each online tile's queue, per conversation in order.
  3. `read` fires later, as chats are opened.
- **Lock:**
  - An in-memory `Map<groupId, {socket, since}>`, empty on boot.
  - A second claim → `group.locked`.
  - Released on socket `close`.
  - Every change → `groups.update`.
- **Heartbeat:** ping every 15 s. No pong by the next ping → `terminate()` and release the
  lock (FR-16).
- **Reset** (called by P2):
  - Numbers kept → push a fresh snapshot to each open session.
  - Numbers wiped → `error {code:'group_deleted'}`, then close the socket.

## Your count
**1 WebSocket endpoint: 5 in + 8 out group events, 1 in + 6 out admin events, plus
presence, delivery/queue, lock, heartbeat and the bus.**
**Covers:** FR-04, FR-05, FR-09 (live), FR-11 (live feed), FR-14, FR-16, FR-17, FR-18.
**Demo steps you own:** 4 (offline queue), 5 (close/reopen), 6 (lock) + the live admin log.
**Done when:**
- A message reaches an online tile in under 1 s.
- Offline messages queue and flush in order.
- A reopened group shows its history plus the queued messages.
- A second browser is refused.
- The admin feed updates live.

---
---

# How the 3 connect

```
Comdove → [P1 emulator] → P2 storeMessage → P1 lifecycle.outboundAccepted → 'sent' webhook
                                 ↓
                         [P3 deliver] → WS message.new, or queue → P1 lifecycle.delivered → 'delivered' webhook
                                 ↓                                     ↓
                         tile chat.read → P1 lifecycle.read → 'read'   P2 auto-reply (on delivered)
Tile message.send (P3) / /api/inject (P2) / auto-reply (P2) → P1 lifecycle.inbound → signed inbound webhook
Everything → P3 bus → group sessions + admin feed (log entries built by P2)
```

- **P1 needs from P2:** `getBusiness`, `getCustomer`, `storeMessage`, `setDelivered`,
  `setRead`. **From P3:** `deliver`, `emit`.
- **P3 needs from P2:** `listGroupTiles`, `queuedFor`, `history`, `getLogEntry`.
  **From P1:** `delivered`, `read`, `inbound`.
- **P2 needs from P1:** `inbound` (for inject and auto-reply), `cancelAll`, `verify`.
  **From P3:** `setPresence`, `lock.isLocked`, `emit`.

## First 30–45 minutes — freeze together (with the UI team), write in README
1. **Interfaces** above, as stubs in each folder.
2. **SQLite schema** (P2's 8 tables).
3. **WebSocket events** (`src/contract/ws-events.ts`, P3).
4. **`/api` paths + shapes** (`src/contract/api-types.ts`, P2).
5. **The [Gap] decisions** — challenge them now, not later (plan §22).

## Checkpoints (hard stops)
- **① Hour 3:** P2's real store replaces the stubs. Register a number and group (P2) →
  send with curl (P1) → it shows in `wscat` (P3) → fake Comdove gets `sent` + `delivered`
  → reply from `wscat` reaches fake Comdove → everything is in `/api/log`.
- **② Hour 5:** offline queue, close/reopen with late statuses, lock and heartbeat, the
  error set, reset. **Hand the real backend to the UI team.**
- **③ Final:** seed Comdove (P2) → real wat-backend → the full demo script below.
- **Rule:** if something isn't integrated at a checkpoint, **simplify it, never extend it.**

## Handoff to the UI team
- **Until ②:** they build against P2's JSON fixtures and `src/contract/`.
- **At ②:** they switch to `http://localhost:4020` and `ws://localhost:4020/ws`. Contract
  changes after the freeze must update `src/contract/` and be announced the same day.
- **Stable ids for their `data-testid`s:** group slug, digit-only numbers, wamids.

## wat-backend setup for the demo (`.env` values only, no code change)
```
META_GRAPH_API_BASE_URL=http://localhost:4020
META_APP_SECRET=<same as mock APP_SECRET>
WHATSAPP_VERIFY_TOKEN=<same as mock WEBHOOK_VERIFY_TOKEN>
ALLOW_LOCAL_TEST=false
DATABASE_URL=<LOCAL postgres, never prod>
```
Plus P2's seed. **Don't trigger interactive menus**: `interactive-menu.service.ts:19`
hardcodes graph.facebook.com.

## Demo script (PRD §10) → owner
| # | Step | Owner |
|---|---|---|
| 1 | Register 5 business numbers + 2 groups | P2 |
| 2 | Point wat-backend at the mock (env + seed) | P2 |
| 3 | Send to an online tile: < 1 s, log shows sent → delivered → read, Comdove gets all 3 | P1 + P3 |
| 4 | Tile offline → send → online: the queued message arrives, delivered fires | P3 |
| 5 | Close the group, send 2–3, reopen: history + queued, delivered on reconnect, read on open | P3 + P1 |
| 6 | Second tab on an open group → locked | P3 |
| 7 | Reply from a tile → Comdove gets a signed inbound webhook | P1 + P3 |
| 8 | Keyword auto-reply bot conversation | P2 |
| 9 | Bad token → Comdove handles Meta's error JSON | P1 |
| 10 | `POST /reset` → messages clear, numbers and groups remain | P2 |

## FR coverage (all 18)
| FR | Owner | FR | Owner | FR | Owner |
|---|---|---|---|---|---|
| FR-01 | P2 | FR-07 | P1 (+P3 WS) | FR-13 | P2 |
| FR-02 | P1 | FR-08 | P1 | FR-14 | P2 slug + P3 claim |
| FR-03 | P1 | FR-09 | P2 list + P3 live | FR-15 | P2 |
| FR-04 | P3 | FR-10 | P2 (+P3 WS event) | FR-16 | P3 |
| FR-05 | P3 | FR-11 | P2 data + P3 live | FR-17 | P3 |
| FR-06 | P1 (+P3 trigger) | FR-12 | P2 | FR-18 | P3 + P1 |

## Total backend surface
- **HTTP:** 15 control endpoints + the `/reset` alias (P2); 1 Meta endpoint (send +
  mark-as-read) + the not-implemented catch-all (P1).
- **Outgoing:** 4 webhook kinds (inbound, sent, delivered, read) + the verify handshake (P1).
- **WebSocket:** 1 endpoint — 5 in + 8 out group events, 1 in + 6 out admin events (P3).
- **SQLite:** 8 tables (P2). **Tools:** fake Comdove (P1), Comdove seed (P2).
