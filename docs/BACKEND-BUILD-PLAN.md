# Comdove Mock Server — Backend Build Plan

> Everything the **fake server backend** must build, taken from the two source
> docs and checked against the real wat-backend code:
> - `Comdove WhatsApp Mock Server — Hackathon PRD.pdf` (cited as **PRD §n**)
> - `Comdove Mock Server — API Tech Spec.pdf` (cited as **Spec §n**)
> - wat-backend repo (`stacx24/wat-backend`, local checkout `~/Projects/comdov-backend`)
>
> Scope of this file = **backend only** (Node/TS/Express + SQLite + WebSocket
> server + webhooks). The client grid and admin UI are built separately by the
> UI team, against the contract in §11–§12.
>
> **Legend.** Plain text = straight from the PDFs. **[Gap]** = the PDFs are
> silent, ambiguous or contradictory, and this plan makes the decision. Every
> gap is also listed in one place in §22 so the team can challenge it.

---

## 1. Purpose

Build a fake WhatsApp server that **impersonates the Meta Cloud API**, so Comdove
(wat-backend) can be tested end to end without a real Meta account, real phone
numbers, or API costs. Comdove switches to the mock by changing **one env
variable** (`META_GRAPH_API_BASE_URL` → the mock). **No code change in
wat-backend** (only env values and local test data, see §5c).

The backend has two faces:
1. **Meta-facing (HTTP):** must look identical to Meta for the text slice —
   Comdove talks to it and cannot tell it is fake (PRD §8.1).
2. **Client-facing (WebSocket + control API):** feeds the browser tile grid and
   the admin page. Mock-specific, **no auth** (Spec §1).

Why it matters (PRD §1): anyone on the team can register 5–10 business numbers,
simulate 10–15 customers per number, and watch every message flow live.

---

## 2. Tech stack (PRD §8.6 — non-negotiable)

- **Node + TypeScript + Express** (already scaffolded in this repo)
- **WebSocket** — `ws` (chosen over socket.io: plain JSON frames match Spec §7 exactly, and native ping/pong gives the heartbeat)
- **SQLite** — `better-sqlite3` (synchronous, simple, fast enough for 150 numbers) — group history and queues **must survive disconnects**
- **HMAC-SHA256** via `node:crypto` for `X-Hub-Signature-256`
- Port **4020**

Packages to add: `ws`, `better-sqlite3`, `@types/ws`, `@types/better-sqlite3`.

---

## 3. Backend components (PRD §4)

| ID | Component | Backend responsibility |
|----|-----------|------------------------|
| **C1** | Meta API emulator | `POST /{version}/{phone_number_id}/messages` (text + mark-as-read); validate token, payload, recipient; return Meta success/error JSON; error injection; loud failure for everything else (§7–§8) |
| **C2** | Webhook dispatcher | Post inbound + status (sent/delivered/read) to Comdove in Meta's envelope, signed, **ordered per conversation**, retried; verify handshake; late statuses on group reconnect (§9) |
| **C3** | Registry, groups + presence | SQLite store for business numbers, groups (≤10 customers), per-tile online flags, offline queues, auto-reply rules; in-memory session lock; the WebSocket server (§6, §11, §13) |
| **C4** | Client grid (browser) | **UI team.** Backend supplies the WebSocket contract (§11) |
| **C5** | Admin UI + control API | **Backend:** `/api/*` endpoints + live admin feed (§10, §12). **UI team:** the `/admin` page |
| **—** | Auto-reply engine **[Gap]** | Server-side echo / keyword map with delay (FR-10). The PDFs only put the setting on the tile; §14 decides where it runs |

---

## 4. Project structure (this repo, flat — no `server/` subfolder)

```
comdove-fake-backend/
├── src/
│   ├── index.ts                 # boot: env → db → express → ws → handshake → listen 4020
│   ├── config/env.ts            # read + validate env (§5)
│   ├── contract/                # SHARED CONTRACT for the UI team (§11, §12)
│   │   ├── ws-events.ts         # every WebSocket event type + payload
│   │   └── api-types.ts         # every /api request + response type
│   ├── db/
│   │   ├── schema.sql           # CREATE TABLE statements (§6)
│   │   └── db.ts                # better-sqlite3 connection, migrations, helpers
│   ├── meta/                    # C1 — Meta emulator
│   │   ├── messages.route.ts    # POST /:version/:phoneNumberId/messages
│   │   ├── validate.ts          # validation pipeline (§7b)
│   │   ├── errors.ts            # Meta error envelope + code table + X-Mock-Force-Error
│   │   ├── responses.ts         # success shape + wamid.MOCK- generator
│   │   └── not-implemented.ts   # catch-all for every other Graph path (§7f)
│   ├── webhooks/                # C2 — dispatcher
│   │   ├── dispatcher.ts        # per-conversation FIFO, retry 1s/5s/15s, attempt log
│   │   ├── sign.ts              # X-Hub-Signature-256
│   │   ├── envelopes.ts         # inbound messages[] + statuses[] builders
│   │   └── verify.ts            # hub.challenge handshake
│   ├── api/                     # C5 — control API
│   │   ├── numbers.route.ts     # business numbers + customers
│   │   ├── groups.route.ts
│   │   ├── traffic.route.ts     # presence, inject, log
│   │   ├── autoreply.route.ts
│   │   └── system.route.ts      # reset, status, verify
│   ├── ws/                      # WebSocket server
│   │   ├── server.ts            # /ws upgrade, heartbeat
│   │   ├── group-session.ts     # group.claim, message.send, tile.presence, chat.read, tile.autoreply
│   │   ├── admin-feed.ts        # admin.subscribe + broadcast
│   │   └── lock.ts              # in-memory one-session-per-group lock
│   └── core/                    # domain logic, shared by HTTP + WS
│       ├── registry.ts          # numbers, groups, customers
│       ├── presence.ts          # effective online = group claimed AND tile flag
│       ├── lifecycle.ts         # message state machine sent → delivered → read
│       ├── delivery.ts          # route to tile vs queue, flush in order
│       ├── autoreply.ts         # echo / keyword engine
│       └── bus.ts               # in-process event bus → WS sessions + admin feed
├── test/                        # unit + e2e (curl-free: supertest + fake Comdove)
├── tools/fake-comdove.ts        # tiny receiver: checks signature, answers handshake, logs
├── docs/
├── .env / .env.example
└── package.json
```

`src/contract/` replaces the `packages/shared` idea: this is a backend-only repo,
so the UI team copies (or imports from git) these two files.

---

## 5. Environment variables (Spec §8)

### 5.0 Mock server `.env`

| Variable | Example | Purpose |
|----------|---------|---------|
| `PORT` | `4020` | HTTP + WebSocket port |
| `COMDOVE_WEBHOOK_URL` | `http://localhost:3000/webhooks/whatsapp` | Where inbound + status webhooks go |
| `APP_SECRET` | `mock-app-secret-1` | HMAC key for `X-Hub-Signature-256`; **must equal** Comdove's app secret |
| `WEBHOOK_VERIFY_TOKEN` | `mock-verify-1` | Sent as `hub.verify_token` in the handshake; **must equal** Comdove's verify token |
| `DB_PATH` | `./mock.sqlite` | SQLite file; delete it for a factory reset |
| `STATUS_WEBHOOK_DELAY_MS` **[Gap]** | `500` | Wait before the first status webhook of a message, so Comdove has stored the wamid (§9f). Optional, default 500 |

Only the first five are in the spec; the last is optional with a safe default,
so "nothing else is configured" still holds.

### 5a. wat-backend `.env` (values changed for testing)

| wat-backend variable | Test value | Must match mock |
|---|---|---|
| `META_GRAPH_API_BASE_URL` | `http://localhost:4020` (was `4000` for the old fake server) | the mock's `PORT` |
| `META_APP_SECRET` | `mock-app-secret-1` (or keep its current value and copy it to the mock) | `APP_SECRET` |
| `WHATSAPP_VERIFY_TOKEN` | `mock-verify-1` (or copy across) | `WEBHOOK_VERIFY_TOKEN` |
| `ALLOW_LOCAL_TEST` | `false` | — (see below) |
| `DATABASE_URL` / `DB_TARGET` | **local** Postgres, never prod RDS | — |

Where these are used in wat-backend:

| Value | Code |
|---|---|
| Webhook route `/webhooks/whatsapp` | mounted at `src/app.ts:70`; handler `src/routes/webhook-whatsapp.ts` |
| `META_APP_SECRET` | signature check at `webhook-whatsapp.ts:44` (`verifyMetaSignature`) |
| `WHATSAPP_VERIFY_TOKEN` | GET handshake at `webhook-whatsapp.ts:22` |
| `META_GRAPH_API_BASE_URL` | `src/lib/meta-graph.ts:27`, `src/services/meta-graph.client.ts:266` → URL is `{BASE}/{META_GRAPH_API_VERSION}/...` |

**Why `ALLOW_LOCAL_TEST=false`:** the old fake server sent `X-Local-Test: true`,
which routes inbound into isolated `Local*` tables and skips the normal pipeline
(`webhook-whatsapp.ts:63`). The new mock behaves like real Meta, must **never**
send that header, and must go through the normal pipeline.

### 5b. The rule

```
mock APP_SECRET            === wat-backend META_APP_SECRET
mock WEBHOOK_VERIFY_TOKEN  === wat-backend WHATSAPP_VERIFY_TOKEN
mock COMDOVE_WEBHOOK_URL   === wat-backend host:PORT + /webhooks/whatsapp
mock PORT                  === port in wat-backend META_GRAPH_API_BASE_URL
```

### 5c. Comdove test data prerequisite **[Gap — critical, not in PDFs]**

The Spec says Comdove reads the access token "from its existing env variable".
**It does not.** In wat-backend:

- The token is decrypted from the database: `WabaAccount.accessTokenEncrypted`
  (e.g. `waba-send-message.service.ts:154`, `decryptSecret(...)`).
- Every inbound webhook is resolved by
  `prisma.wabaPhoneNumber.findUnique({ where: { phoneNumberId } })`; no row →
  `PermanentError('UNKNOWN_PHONE_NUMBER')` (`src/workers/process-event.ts:214-229`).
- Status webhooks are resolved by wamid; unknown wamid →
  `PermanentError('UNKNOWN_WAMID')` (`process-event.ts`, `processOneStatus`).

So the mock's numbers must **exist in Comdove's local database** with the same
ids and token. Two supported ways (pick one per business number):

| Way | How | When |
|---|---|---|
| **A. Mock adopts Comdove's ids** (recommended) | `POST /api/business-numbers` with optional `phone_number_id`, `waba_id`, `token` set to the values already in Comdove's local `WabaPhoneNumber.phoneNumberId`, `WabaAccount.wabaId`, and the decrypted token | Comdove already has test WABA rows |
| **B. Comdove adopts the mock's ids** | Register on the mock (ids generated), then insert/update Comdove's local rows: `WabaAccount { wabaId, accessTokenEncrypted = encryptSecret(token) }` + `WabaPhoneNumber { phoneNumberId, displayPhoneNumber, teamId, wabaAccountId }` using wat-backend's `src/utils/crypto.ts` `encryptSecret`, via a local seed script (not app code) | Fresh local DB |

This is part of "Point a local wat-backend at the mock" (demo step 2) and must be
done before the demo. The seed script lives in `tools/` of this repo and talks
to the local Comdove Postgres only.

### 5d. Known wat-backend risks (not fixed by the mock)

- `src/services/interactive-menu.service.ts:19` hardcodes
  `https://graph.facebook.com` and ignores `META_GRAPH_API_BASE_URL`. Interactive
  messages are out of scope for v1, but that path would call **real Meta** with a
  fake token. Do not trigger interactive menus during mock tests.
- Onboarding calls (`/{waba_id}/subscribed_apps`, `/phone_numbers`,
  `/message_templates`, token exchange) hit the mock's not-implemented rule
  (§7f) and fail loudly. That is intended: seed the data (§5c) instead of
  onboarding through the mock.

---

## 6. SQLite data model (PRD §4, page 3)

PRD: "numbers (business and customer), groups (name, member numbers, session
lock), conversations (pair of numbers), messages (id, from, to, body, status
timeline, timestamps), presence (group connected plus per-tile flag)." Plus the
tables the PDFs imply but do not name: webhook attempts (Spec §5, PRD §7) and
auto-reply rules (FR-10).

```sql
PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;

-- Business numbers (FR-01). One row per registered Comdove sender.
CREATE TABLE business_numbers (
  phone_number_id TEXT PRIMARY KEY,          -- generated 'MOCK-PN-n' or supplied (§5c)
  display_number  TEXT NOT NULL UNIQUE,      -- digits only, e.g. '918888800001'
  label           TEXT,
  token           TEXT NOT NULL,             -- fake bearer token, string compare only
  waba_id         TEXT NOT NULL,             -- used as webhook entry[].id (§9)
  created_at      INTEGER NOT NULL
);

-- Client groups (FR-15). The session lock is NOT stored here (see below).
CREATE TABLE groups (
  id          TEXT PRIMARY KEY,              -- URL slug, e.g. 'alpha' (FR-14)
  name        TEXT NOT NULL UNIQUE,
  created_at  INTEGER NOT NULL
);

-- Customer numbers = tiles. A customer belongs to exactly ONE group. [Gap]
CREATE TABLE customers (
  number          TEXT PRIMARY KEY,          -- digits only, also the wa_id
  group_id        TEXT NOT NULL REFERENCES groups(id) ON DELETE CASCADE,
  position        INTEGER NOT NULL,          -- tile order inside the group
  label           TEXT,                      -- used as contacts[].profile.name
  online          INTEGER NOT NULL DEFAULT 1,-- per-tile flag (presence)
  reply_mode      TEXT NOT NULL DEFAULT 'manual'
                  CHECK (reply_mode IN ('manual','echo','keyword')),
  reply_delay_ms  INTEGER NOT NULL DEFAULT 0 CHECK (reply_delay_ms BETWEEN 0 AND 30000),
  created_at      INTEGER NOT NULL
);
CREATE INDEX idx_customers_group ON customers(group_id, position);

-- Keyword map for reply_mode='keyword' (FR-10). First match by position wins.
CREATE TABLE keyword_replies (
  id               INTEGER PRIMARY KEY AUTOINCREMENT,
  customer_number  TEXT NOT NULL REFERENCES customers(number) ON DELETE CASCADE,
  position         INTEGER NOT NULL,
  keyword          TEXT NOT NULL,            -- case-insensitive "contains"
  reply            TEXT NOT NULL
);

-- A pair of numbers. seq gives per-conversation ordering (Spec §5 / PRD §6).
CREATE TABLE conversations (
  id               INTEGER PRIMARY KEY AUTOINCREMENT,
  phone_number_id  TEXT NOT NULL,            -- business side
  customer_number  TEXT NOT NULL,
  next_seq         INTEGER NOT NULL DEFAULT 1,
  UNIQUE (phone_number_id, customer_number)
);

-- Every message + its status timeline (FR-11).
CREATE TABLE messages (
  wamid            TEXT PRIMARY KEY,         -- 'wamid.MOCK-...'
  conversation_id  INTEGER NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  seq              INTEGER NOT NULL,
  direction        TEXT NOT NULL CHECK (direction IN ('outbound','inbound')),
                   -- outbound = Comdove -> customer tile; inbound = tile -> Comdove
  source           TEXT NOT NULL CHECK (source IN ('api','tile','inject','autoreply')),
  from_number      TEXT NOT NULL,            -- display numbers on both sides
  to_number        TEXT NOT NULL,
  body             TEXT NOT NULL,
  created_at       INTEGER NOT NULL,         -- ms
  sent_at          INTEGER,                  -- outbound: API accept
  delivered_at     INTEGER,                  -- outbound: pushed to an open tile
  read_at          INTEGER,                  -- outbound: chat opened; inbound: Comdove mark-as-read
  UNIQUE (conversation_id, seq)
);
CREATE INDEX idx_messages_created ON messages(created_at DESC);

-- One row per webhook Comdove must receive; payload stored so retries are byte-identical.
CREATE TABLE webhook_jobs (
  id               INTEGER PRIMARY KEY AUTOINCREMENT,
  conversation_id  INTEGER NOT NULL,         -- FIFO key (§9f)
  wamid            TEXT NOT NULL,
  kind             TEXT NOT NULL CHECK (kind IN ('inbound','sent','delivered','read')),
  payload          TEXT NOT NULL,            -- exact JSON bytes that are signed
  state            TEXT NOT NULL DEFAULT 'pending' CHECK (state IN ('pending','ok','failed')),
  created_at       INTEGER NOT NULL,
  finished_at      INTEGER
);
CREATE INDEX idx_jobs_pending ON webhook_jobs(state, conversation_id, id);

-- Every attempt and outcome (Spec §5 "every attempt and outcome shows in the admin log").
CREATE TABLE webhook_attempts (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  job_id       INTEGER NOT NULL REFERENCES webhook_jobs(id) ON DELETE CASCADE,
  attempt      INTEGER NOT NULL,             -- 1..4
  http_status  INTEGER,                      -- null on timeout / connection error
  error        TEXT,                         -- 'timeout' | 'ECONNREFUSED' | ...
  duration_ms  INTEGER,
  at           INTEGER NOT NULL
);
```

**Derived state (no extra columns):**
- **Offline queue** = outbound messages with `delivered_at IS NULL`, per
  conversation, ordered by `seq`. A queued message **has** been `sent` (its sent
  webhook fired on API accept), so "queued" is not a status of its own.
- **Status** = `read` if `read_at`, else `delivered` if `delivered_at`, else `sent`.
- **Unread count per chat** = outbound messages in that conversation with
  `delivered_at` set and `read_at` null.

**Session lock — in memory, not SQLite [Gap].** The PRD lists the lock in the
data model, but a lock stored on disk survives a crash and wedges the group
forever. The lock is a `Map<groupId, {socket, since}>` in `ws/lock.ts`; on boot
every group is free. "Group connected" = has a lock entry.

**Deleting** a group or business number keeps its messages in the log until the
next reset (the log is the audit trail); conversations simply stop receiving.

---

## 7. C1 — Meta API emulator (Spec §2–§3)

### 7a. Send message (emulated in full for `type: text`) — FR-02

Request, identical to Meta:

```
POST /v23.0/{phone_number_id}/messages
Authorization: Bearer {token}
Content-Type: application/json

{
  "messaging_product": "whatsapp",
  "recipient_type": "individual",
  "to": "919876543210",
  "type": "text",
  "text": { "preview_url": false, "body": "Hello from Comdove" }
}
```

`recipient_type` and `text.preview_url` are **optional** (Meta treats them so, and
wat-backend's `sendTextMessage` does not send them — `meta-graph.client.ts:524`).

Success `200`:

```json
{
  "messaging_product": "whatsapp",
  "contacts": [{ "input": "919876543210", "wa_id": "919876543210" }],
  "messages": [{ "id": "wamid.MOCK-a1b2c3d4e5f6" }]
}
```

`contacts[].input` echoes `to` exactly as sent; `wa_id` is the normalized digits
(leading `+`, spaces, dashes stripped).

### 7b. Validation pipeline (Spec §3 order, gaps filled)

| Step | Check | Failure |
|---|---|---|
| 0 **[Gap]** | `X-Mock-Force-Error` header present → return that error now, nothing stored | the forced error (§8b) |
| 1 **[Gap]** | `{phone_number_id}` is a registered business number (FR-03 "unknown phone_number_id") | **400 / 100 / subcode 33** |
| 2 | `Authorization: Bearer <token>` present and equal to that number's token | **401 / 190** |
| 3 | Body is JSON; `messaging_product == "whatsapp"` | **400 / 100** |
| 4 | Body is a send (`type` present) or a mark-as-read (`status == "read"`) — nothing else | **400 / 100** |
| 5 | Send: `type == "text"`; `text.body` is a non-empty string ≤ 4096 chars; `to` present | **400 / 100** (other types: "not implemented in comdove-mock") |
| 6 | Send: `to` is a registered customer number (in some group) | **400 / 131026** |

Step 1 before step 2 matches Meta (it resolves the object before checking the
token's permission on it). Steps 2–6 follow the Spec's stated order.

**On success (send):** in one SQLite transaction — find/create the conversation,
take `seq`, insert the message with `sent_at = now`, enqueue the `sent` webhook.
After the transaction: respond 200, then hand the message to delivery (§13):
push to the tile if its group is claimed and the tile is online, otherwise leave
it queued.

### 7c. wamid format

`"wamid.MOCK-"` + 24 hex chars from `crypto.randomBytes(12)`. Same field and place
as Meta's id; the `MOCK-` prefix makes test data unmistakable in Comdove's DB.
Inbound wamids (tile → Comdove) use the same format.

### 7d. Mark as read (Spec §3, Should)

```
POST /v23.0/{phone_number_id}/messages
{ "messaging_product": "whatsapp", "status": "read", "message_id": "wamid.MOCK-..." }
→ 200 { "success": true }
```

- `message_id` must be an **inbound** message addressed to this business number,
  else **400 / 100**.
- Sets `read_at` on that inbound message and pushes `message.status {status:'read'}`
  to the tile so the customer's own bubble shows blue ticks.
- **No webhook is fired. [Gap — resolves a Spec contradiction]** Spec §2's table says
  it "triggers the read status webhook"; Spec §3 says it "marks the inbound
  message read in the tile". Real Meta sends no status webhook to the business
  for its own read receipt, so §3 wins. (wat-backend does not call this endpoint
  today; it is here for fidelity.)

### 7e. Versioning

Accept any `/vNN.N/` prefix (regex `^v\d+\.\d+$`) and ignore it; wat-backend pins
`META_GRAPH_API_VERSION`. Payloads follow the v23.0 reference.

### 7f. Not-implemented rule (Spec §2)

Every other Graph path or method (media, templates, phone numbers,
subscribed_apps, token exchange, …) and every message type other than `text` →
**400**, Meta envelope, `code: 100`, message
`"(#100) <METHOD> <path> is not implemented in comdove-mock"`. Registered after
the control API and `/ws` so it never shadows them. Fail loudly, never half-work.

---

## 8. C1 — Error responses (Spec §4, FR-03)

### 8a. Envelope

All Meta-side errors use Meta's envelope so wat-backend's `MetaApiError` parsing
(`status`, `metaCode`, `metaSubcode`, `metaMessage`) runs unchanged:

```json
{
  "error": {
    "message": "(#131026) Message undeliverable",
    "type": "OAuthException",
    "code": 131026,
    "error_data": { "messaging_product": "whatsapp", "details": "Recipient is not a registered mock number" },
    "fbtrace_id": "MOCK-trace-000123"
  }
}
```

- `error_subcode` is included only where Meta sends one (FR-03 names
  `error.subcode`). **[Gap]** The Spec example omits it.
- `fbtrace_id` = `"MOCK-trace-"` + a 6-digit counter (unique per response).

### 8b. Error set

| Trigger | HTTP | code | subcode | message |
|---------|------|------|---------|---------|
| Unknown `{phone_number_id}` **[Gap: FR-03 lists it, Spec §4 table omits it]** | 400 | 100 | 33 | `Unsupported post request. Object with ID '{id}' does not exist, cannot be loaded due to missing permissions, or does not support this operation` |
| Missing / wrong bearer token | 401 | 190 | — | `Invalid OAuth access token - Cannot parse access token` |
| Malformed body, wrong `messaging_product`, unsupported type or path | 400 | 100 | — | `(#100) Invalid parameter` / `... not implemented in comdove-mock` |
| `to` not a registered customer number | 400 | 131026 | — | `(#131026) Message undeliverable` |
| Forced rate limit | 400 | 130429 | — | `(#130429) Rate limit hit` |

### 8c. Deterministic error injection (Spec §4)

Header **`X-Mock-Force-Error: {code}`** returns exactly that error for that
request (checked first, §7b step 0). Accepted values: `190`, `100`, `33`
(unknown id), `131026`, `130429`. Any other value → 400/100
`"unsupported X-Mock-Force-Error value"`. Forced errors are also written to the
admin log (as a rejected request, no wamid) so a tester can see them. Mock-only;
listed in §17.

> wat-backend does not send this header on its own. For the demo "bad token"
> step, use a wrong token (real 401/190 path); the header is for curl and
> phase-2 automation that sits between Comdove and the mock.

---

## 9. C2 — Webhooks to Comdove (Spec §5)

Both kinds use the `entry / changes / value` envelope with `field: "messages"`. A
`messages` array = inbound; a `statuses` array = status update. wat-backend
dispatches on exactly this (`process-event.ts:172-176`).

### 9a. Inbound (tile typed, `/api/inject`, or auto-reply) — FR-07

```json
{
  "object": "whatsapp_business_account",
  "entry": [{
    "id": "<business waba_id>",
    "changes": [{
      "field": "messages",
      "value": {
        "messaging_product": "whatsapp",
        "metadata": { "display_phone_number": "918888800001", "phone_number_id": "<business phone_number_id>" },
        "contacts": [{ "profile": { "name": "Tile 919876543210" }, "wa_id": "919876543210" }],
        "messages": [{ "from": "919876543210", "id": "wamid.MOCK-...", "timestamp": "1758270000", "type": "text", "text": { "body": "how much?" } }]
      }
    }]
  }]
}
```

- `entry[].id` = that business number's `waba_id` **[Gap]** (the Spec example
  hardcodes `MOCK-WABA-1`; with several business numbers it must be per number,
  and it must match Comdove's `WabaAccount.wabaId`, §5c).
- `profile.name` = customer `label` if set, else `"Tile {number}"`.
- `timestamp` = Unix **seconds** as a string (Meta format).

### 9b. Status (one webhook per transition) — FR-06

```json
{
  "object": "whatsapp_business_account",
  "entry": [{
    "id": "<business waba_id>",
    "changes": [{
      "field": "messages",
      "value": {
        "messaging_product": "whatsapp",
        "metadata": { "display_phone_number": "918888800001", "phone_number_id": "<business phone_number_id>" },
        "statuses": [{ "id": "wamid.MOCK-...", "status": "delivered", "timestamp": "1758270031", "recipient_id": "919876543210" }]
      }
    }]
  }]
}
```

| status | fires when |
|---|---|
| `sent` | the Meta API accepted the message (§7b) |
| `delivered` | the message was pushed to an **open, online** tile — live (`message.new`), on tile online (`queue.flush`), or on group reconnect (snapshot) |
| `read` | the tester opened that chat (`chat.read`) |

No `conversation` / `pricing` objects (Spec §9). One status per webhook.

### 9c. Signature (FR-08)

Every POST carries `X-Hub-Signature-256: sha256=<hex HMAC-SHA256 of the exact raw
body bytes, keyed with APP_SECRET>` and `Content-Type: application/json`. The
body is serialized **once**, stored in `webhook_jobs.payload`, and the same bytes
are signed and sent on every attempt. Never send `X-Local-Test`.

### 9d. Verify handshake (Spec §5)

On boot, and on demand via `POST /api/webhook/verify` **[Gap]** (the webhook URL
is env-only, so "when the URL changes" = restart):

```
GET {COMDOVE_WEBHOOK_URL}?hub.mode=subscribe&hub.verify_token={WEBHOOK_VERIFY_TOKEN}&hub.challenge={random 10 digits}
expect 200 and body === challenge
```

Result (`ok` / `failed: reason` / time) is kept in memory, shown by
`GET /api/status` and pushed on the admin feed. **Never blocks boot** — if
Comdove is down, log a warning and carry on. wat-backend answers this at
`webhook-whatsapp.ts:12-40` (200 text/plain challenge, else 403).

### 9e. Delivery + retries (FR-08, Spec §5)

- A delivery attempt succeeds on **HTTP 200** only (Spec: "non-200 … triggers
  retries"). Any other status, connection error, or **5 s timeout** = failure.
- **1 attempt + up to 3 retries** after **1 s, 5 s, 15 s** (4 attempts total).
  **[Gap]** Spec §9 says "3 attempts, 1s/5s/15s"; three delays only make sense
  with three retries, which also matches FR-08 "retried up to 3 times".
- Each attempt → a `webhook_attempts` row → `log.update` on the admin feed.
- After the 4th failure the job is marked `failed` and the next job in that
  conversation proceeds (a dead Comdove must not freeze the mock).

### 9f. Ordering + Comdove race **[Gap — not in PDFs]**

- **Per-conversation FIFO.** Jobs are sent strictly one at a time per
  `conversation_id` in `id` order; the next job waits until the previous one is
  `ok` or `failed`. Otherwise a `sent` in retry backoff could be overtaken by
  `delivered`, breaking "per conversation, messages and their statuses are
  delivered in send order" (PRD §6). Different conversations run in parallel.
- **Do not beat Comdove to its own wamid.** wat-backend stores the wamid only
  after our 200 response returns; a status webhook that arrives first fails with
  `UNKNOWN_WAMID` (a permanent error, not retried). The first status job of an
  outbound message is therefore not sent before `STATUS_WEBHOOK_DELAY_MS`
  (default 500 ms) after the API response.
- wat-backend applies statuses forward-only (`shouldApplyStatus`), so a late
  `delivered` after `read` is harmless — but we still send in order.

### 9g. Read without delivered (Spec §5)

The Spec allows "read without a preceding delivered" on a reconnect straight into
an open chat. **[Gap]** This plan always sends `delivered` then `read` in order
(allowed, simpler, and still correct for wat-backend). The "may skip" is recorded
as a permitted variation, not a requirement.

### 9h. Restart safety

On boot, `pending` jobs are resumed in FIFO order (retry count restarts), so a
mock restart does not silently drop statuses.

---

## 10. C5 — Control API (Spec §6, mock-only, no auth)

Everything the admin UI does exists first as a plain HTTP endpoint (PRD §8.4). No
auth headers. Plain JSON. Errors are `{ "error": { "message": "..." } }` with
4xx (**no** Meta envelope — this side is not pretending to be Meta). Every change
also emits the matching admin-feed event (§12).

### 10a. From the Spec

| Method + path | Body | Returns | Purpose (FR) |
|---|---|---|---|
| `POST /api/business-numbers` | `{display_number, label, phone_number_id?, waba_id?, token?}` | `{phone_number_id, token, waba_id, display_number, label}` | Register a business number (FR-01). Optional ids **[Gap]** for §5c way A; default ids `MOCK-PN-{n}`, `MOCK-WABA-1`, token `mock-token-{random}` |
| `GET /api/business-numbers` | – | `[{phone_number_id, display_number, label, token, waba_id, created_at}]` | Admin inventory |
| `POST /api/groups` | `{name, numbers:[1..10], labels?:{[number]:label}}` | group | Create a client group (FR-15); numbers auto-register as customers |
| `GET /api/groups` | – | `[{id, name, count, status:'free'\|'locked', locked_since}]` | Launch page + lock display (FR-09, FR-16) |
| `POST /api/presence` | `{number, online}` | `{number, online, effective_online}` | Set a tile online/offline without the UI; **same effect as `tile.presence`** (flush + delivered) |
| `POST /api/inject` | `{from, to, body}` | `{wamid}` | Inbound as if typed in a tile (FR-13); **same effect as `message.send`** (stored, shown in the open tile, webhook fired) |
| `GET /api/log?limit=100` | – | log entries, newest first (§10c) | Admin log (FR-11) |
| `POST /api/reset` | `{keep_numbers?: boolean}` (default `true`) | `{ok:true}` | Known state in one call (FR-12, §15) |

### 10b. Added to cover PRD requirements **[Gap]**

| Method + path | Body | Returns | Why |
|---|---|---|---|
| `DELETE /api/business-numbers/:phone_number_id` | – | 204 | PRD C5: "Register/**delete** numbers and groups" |
| `DELETE /api/groups/:id` | – | 204, or 409 if the group is claimed | same |
| `GET /api/customers` | – | `[{number, label, group_id, online, effective_online, claim_status:'free'\|'locked', reply_mode}]` | PRD §7 admin list shows numbers with **type (business/customer)** and **claim status** |
| `GET /api/customers/:number/auto-reply` | – | `{mode, delay_ms, rules:[{keyword, reply}]}` | FR-10 |
| `PUT /api/customers/:number/auto-reply` | `{mode, delay_ms, rules}` | same | FR-10, and FR-13 "all as plain HTTP" |
| `POST /api/webhook/verify` | – | `{ok, detail}` | Re-run the handshake (§9d) |
| `GET /api/status` | – | `{uptime, comdove_webhook_url, verify:{ok, at, detail}, pending_webhooks, counts}` | Admin header / debugging |
| `POST /reset` | same as `/api/reset` | same | **Alias.** PRD FR-12 and §8.5 say `POST /reset`; Spec §6 says `/api/reset`. Both work |

### 10c. Details

- **Validation:** numbers are digits only after normalization, 8–15 digits.
  Business numbers: max **10** (PRD scale target). Group: 1–10 numbers, a number
  may not already be a customer in another group or a business number (409).
  Group `id` = slug of `name` (lowercase, `a-z0-9-`); it is the `?group=` value
  (FR-14).
- **`/api/inject`:** `from` must be a customer, `to` a business number
  (display number or phone_number_id). Works whether or not the group is open —
  it is "the automation twin of typing in a tile", so no browser needed.
- **`/api/presence`:** stores the tile flag. If the group is claimed, pushes
  `tile.presence` to that session, and going online flushes the tile's queue.
  If the group is closed, only the flag changes (the tile is offline anyway).
- **`/api/log` entry shape** (also the admin-feed shape):

  ```json
  {
    "wamid": "wamid.MOCK-...",
    "time": 1758270000123,
    "direction": "outbound",
    "source": "api",
    "from": "918888800001",
    "to": "919876543210",
    "business": { "phone_number_id": "MOCK-PN-1", "label": "Sales" },
    "group_id": "alpha",
    "body": "Hello from Comdove",
    "status": "delivered",
    "timeline": [ { "status": "sent", "at": 1758270000123 }, { "status": "delivered", "at": 1758270000410 } ],
    "webhooks": [
      { "kind": "sent", "state": "ok", "attempts": [ { "n": 1, "http_status": 200, "duration_ms": 12, "at": 1758270000650 } ] },
      { "kind": "delivered", "state": "pending", "attempts": [ { "n": 1, "http_status": 500, "at": 1758270000900 } ] }
    ]
  }
  ```

  The "webhook result" column in PRD §7 = last attempt's `http_status` (200) or
  the retry count. Rejected Meta requests (errors, forced errors) appear as
  entries with `direction: "rejected"`, the error code, and no wamid.
- **Reset** (`keep_numbers` default `true` **[Gap]** — the PRD demo expects
  "numbers and groups remain"):
  1. cancel all in-flight webhook retries,
  2. delete `webhook_attempts`, `webhook_jobs`, `messages`, `conversations`,
  3. if `keep_numbers:false`, also delete `keyword_replies`, `customers`,
     `groups`, `business_numbers` and close every group session with
     `error {code:'group_deleted'}`,
  4. otherwise push a fresh `group.claimed` snapshot to each open session (locks
     are kept), and broadcast `log.reset` + `groups.update` to admin sockets.

---

## 11. WebSocket — client grid contract (Spec §7)

`ws://{host}:4020/ws`. JSON frames, each `{ "type": "...", ...payload }`. No auth.
A socket becomes a **group session** by sending `group.claim`, or an **admin
feed** by sending `admin.subscribe` (§12). One group per socket.

### 11a. Client → server

| type | payload | effect |
|------|---------|--------|
| `group.claim` | `{group}` | Claim the group. Free → take the lock, reply `group.claimed` (snapshot), then deliver everything queued for online tiles (§13c). Held by another socket → `group.locked`. Unknown → `error` (FR-09, FR-14, FR-16, FR-17) |
| `message.send` | `{from, to, body}` | Tester sent a text from tile `from` to business number `to` (display number or phone_number_id); store, echo `message.new` back, fire inbound webhook (FR-07) |
| `tile.presence` | `{number, online}` | Toggle a tile; going online flushes that tile's queue in order (FR-05) |
| `chat.read` | `{number, peer}` | Tester opened tile `number`'s chat with business `peer`; mark its delivered-unread messages read, fire `read` webhooks in order (FR-06). Ignored if the tile is offline |
| `tile.autoreply` **[Gap]** | `{number, mode, delay_ms, rules}` | Set auto-reply from the tile's gear (FR-10). Same as `PUT /api/customers/:number/auto-reply` |

Any action on a socket that has not claimed a group, or for a number not in the
claimed group, → `error {code, message}`; nothing changes.

### 11b. Server → client

| type | payload | effect |
|------|---------|--------|
| `group.claimed` | see 11c | Snapshot on claim (and after reset); the grid renders from this alone |
| `group.locked` | `{group, since}` | Claim refused; client returns to the launch page |
| `message.new` | `{to, number, message}` | New message for a tile. `to` as in the Spec; `number` **[Gap]** = the tile it belongs to (for inbound echoes `to` is the business number). Live delivery < 1 s (FR-04) |
| `queue.flush` | `{number, messages:[]}` | Queued messages delivered in order after a tile comes back online (FR-05) |
| `message.status` | `{wamid, number, status, at}` | Status mirror so tiles show ticks (`sent`/`delivered`/`read`; for the tile's own inbound messages, `read` when Comdove marks it read) |
| `tile.presence` **[Gap]** | `{number, online}` | Presence changed from elsewhere (control API) |
| `tile.autoreply` **[Gap]** | `{number, mode, delay_ms, rules}` | Auto-reply changed from elsewhere |
| `error` **[Gap]** | `{code, message}` | Bad request on this socket; `group_deleted` closes it |

### 11c. Snapshot shape

The Spec gives `{group, tiles:[{number, online, history, queued}]}`. Filled in so
the grid can render "from this alone":

```json
{
  "type": "group.claimed",
  "group": { "id": "alpha", "name": "Alpha" },
  "business_numbers": [ { "phone_number_id": "MOCK-PN-1", "display_number": "918888800001", "label": "Sales" } ],
  "tiles": [
    {
      "number": "919876543210",
      "label": null,
      "online": true,
      "auto_reply": { "mode": "manual", "delay_ms": 0, "rules": [] },
      "history": [ { "wamid": "...", "peer": "918888800001", "direction": "outbound", "body": "...", "status": "read", "created_at": 0 } ],
      "queued":  [ { "wamid": "...", "peer": "918888800001", "direction": "outbound", "body": "...", "status": "sent", "created_at": 0 } ],
      "unread": { "918888800001": 2 }
    }
  ]
}
```

- `business_numbers` **[Gap]** lets a tile choose which business to reply to. A
  customer can talk to several business numbers, so a tile has **one chat per
  business number** (the tile shows a peer switcher; `chat.read` and
  `message.send` already carry the peer).
- `queued` = messages that arrived while the group was closed. For online tiles
  they are delivered right after the snapshot (delivered webhooks fire); for
  offline tiles they stay queued until `tile.presence online`.

### 11d. Heartbeat + lock (FR-16)

Server sends a WebSocket **ping every 15 s**. If no pong has arrived by the next
ping, the socket is terminated and the lock released, so a killed browser never
wedges a group. Socket `close` also releases the lock immediately. Every lock
change broadcasts `groups.update`.

---

## 12. WebSocket — admin feed **[Gap: FR-11 needs real time, Spec §7 has no admin events]**

PRD C5 lists "HTTP + WebSocket for live log". Same `/ws` endpoint:

| Direction | type | payload |
|---|---|---|
| client → server | `admin.subscribe` | `{}` — then load history with `GET /api/log` |
| server → client | `log.entry` | a new log entry (§10c shape) |
| server → client | `log.update` | the full updated entry when a status or webhook attempt changes (late reconnect statuses appear exactly like live traffic — FR-18) |
| server → client | `log.reset` | `{}` after a reset |
| server → client | `groups.update` | same list as `GET /api/groups` (lock changes, create/delete) |
| server → client | `numbers.update` | same list as `GET /api/business-numbers` + `GET /api/customers` |
| server → client | `webhook.verify` | `{ok, at, detail}` |

The client launch page may also subscribe to receive `groups.update`, so
free/locked status is live (FR-09).

---

## 13. Domain rules the backend must enforce

### 13a. Rules (PRD §6, FR-04/05/16/17/18)

- **Ordering:** per conversation, messages and their statuses are delivered in
  send order (`seq` + webhook FIFO). Across conversations, no guarantee (same as
  Meta).
- **Effective presence:** a tile is online only if its **group is claimed AND its
  tile flag is online**. A closed group counts as offline for every number in it.
- **Default presence [Gap]:** new tiles start with the flag **online**. The flag is
  persisted, so a tile toggled offline stays offline across group reopen.
- **Offline queue (FR-05):** a message to an offline tile or a closed group is
  queued (stored, `sent`, not `delivered`); coming back online flushes the queue
  in order.
- **Persistence (FR-17):** closing a group's browser and reopening restores full
  chat history plus anything queued while it was closed — all from SQLite.
- **Late statuses (FR-18):** on reconnect, delivered fires for the flushed
  messages and read fires per chat as the tester opens it; the admin log shows
  them like live traffic.
- **Session lock (FR-16):** one active session per group; a second browser gets
  `group.locked`; the lock releases on disconnect or missed heartbeat.
- **< 1 second (FR-04):** direct push over the open socket; no polling anywhere
  (PRD §8.7).
- **"Delivered" = pushed to an open socket [Gap].** The Spec has no client ack
  event, so a successful `ws.send` to an online tile counts as client receipt.

### 13b. Outbound (Comdove → customer)

```
Comdove POST /{pnid}/messages ──► validate (§7b) ──► store (sent_at) + enqueue 'sent' job
   ◄── 200 {wamid}
   ├─ tile effectively online ─► WS message.new ─► delivered_at ─► enqueue 'delivered'
   │                               └─► auto-reply check (§14)
   │     tester opens chat ─► chat.read ─► read_at ─► enqueue 'read'
   └─ tile offline / group closed ─► stays queued
         tile.presence online ─► WS queue.flush (seq order) ─► delivered per message
         group.claim ─► snapshot (queued listed) ─► delivered per message
```

### 13c. Group reconnect (demo step 5)

1. `group.claim` → take lock → build snapshot (history + queued per tile).
2. Send `group.claimed`.
3. For every online tile, for every conversation: mark queued messages delivered
   in `seq` order → enqueue `delivered` jobs → `message.status` + `log.update`.
4. `read` fires later, per chat, when the tester opens it (`chat.read`).

### 13d. Inbound (customer → Comdove)

```
tile message.send / POST /api/inject / auto-reply
  ─► validate (from = customer, to = business) ─► store inbound message
  ─► echo message.new to the open group session (if any) ─► log.entry
  ─► enqueue 'inbound' job ─► signed POST to Comdove ─► 200 (else retry ×3)
```

---

## 14. Auto-reply engine (FR-10, PRD §6 note) **[Gap: placement]**

PRD: "Per-tile auto-reply modes: manual (default), echo, keyword map (small
editable table: contains X, reply Y), optional fixed delay." PRD §6: "auto-reply
mode does the same [as a typed reply], triggered by an incoming message."

**Decision:** runs **on the server** (`core/autoreply.ts`), configured per
customer number, so it works the same from the browser gear, the control API,
and phase-2 automation, and is stored in SQLite with the rest of the tile state.

| mode | behaviour |
|---|---|
| `manual` | nothing (default) |
| `echo` | reply with the same body |
| `keyword` | first rule (by position) whose `keyword` is contained in the body, case-insensitive → reply with its `reply`; no match → no reply |

- **Trigger:** an **outbound** message (from Comdove) is **delivered** to the tile.
  Queued messages trigger when they are flushed, not while queued — an offline
  customer does not talk.
- **Delay:** `delay_ms` (0–30000). The reply is sent after the delay through the
  exact inbound path (§13d) with `source: 'autoreply'`, to the business number
  that sent the triggering message. If the tile went offline or the group closed
  meanwhile, the reply is dropped.
- **No loops:** only outbound messages trigger, and replies are inbound.
- **Demo:** set a tile to keyword mode (`price → "how much?"`, `yes → "confirm"`)
  and run a short bot conversation from Comdove (demo step 8).

---

## 15. Build constraints (PRD §8 — non-negotiable)

1. **Meta contract fidelity** over features — request/response/webhook shapes
   copied exactly (§7–§9). If the shape is wrong, the mock tests nothing.
2. **`data-testid`** on every interactive element — UI team. Backend keeps ids
   stable and deterministic (`group.id` slugs, digit-only numbers, wamids) so
   testids can be built from them.
3. **URL-addressable groups** (FR-14) — `group.id` is the `?group=` value.
4. **Control API before UI** — every admin action is a plain HTTP call first
   (§10); the WebSocket handlers call the same `core/` functions.
5. **Stateless enough to reset** — one call to `POST /api/reset` (or `/reset`).
6. **Stack** = Node/TS/Express + `ws` + `better-sqlite3`.
7. **Scale target:** 10 business × 15 customers = 150 numbers, a few msgs/sec. No
   performance engineering; also no per-message polling (event bus + direct push).

---

## 16. Out of scope for v1 (PRD §2, §9)

Media / template / interactive message types and reactions; 24-hour customer
service window + template-only enforcement; failure injection beyond the FR-03
set (chaos mode, duplicate webhooks, out-of-order delivery); scripted load +
the Playwright suite (the control API and testids are their landing pad);
multi-device per number, group chats, encryption; auth on the mock's
admin/control endpoints — **localhost / internal network only, never exposed
publicly.**

---

## 17. Known divergences from the official API (Spec §9, extended)

| Area | Meta | Mock |
|---|---|---|
| Auth | Real OAuth system-user tokens with scopes and expiry | Static fake token per number, string compare only |
| Control plane | No admin/control endpoints; numbers come from WABA onboarding | `/api/*`, no auth, local network only |
| wamid | Opaque base64-like id | `wamid.MOCK-` + hex, deliberately recognizable |
| Status webhook extras | `conversation` and `pricing` objects on some statuses | Omitted entirely |
| Webhook retries | Increasing backoff up to ~24 h | 1 + 3 retries at 1 s / 5 s / 15 s, then `failed` |
| 24-hour session window | Enforced | Not enforced in v1 |
| Rate limits | Real per-number throughput limits (80 msg/s default) | Only via `X-Mock-Force-Error: 130429` |
| Error injection header | Does not exist | `X-Mock-Force-Error`, mock-only |
| Encryption, quality, billing | Present | Absent |
| "Delivered" **[added]** | Device acknowledgement | Pushed to an open, online browser tile |
| Read without delivered **[added]** | Can happen | Always delivered-then-read (allowed by Spec §5) |
| Mark-as-read **[added]** | No webhook to the business | Same — no webhook; tile shows blue ticks |
| Status timing **[added]** | Seconds after send | ≥ `STATUS_WEBHOOK_DELAY_MS` (500 ms) after the API response |
| Customers **[added]** | Any WhatsApp user | Only numbers registered in a group; one group per number |

None of these sit on Comdove's text happy path or its error-handling path.

---

## 18. Traceability

### 18a. Functional requirements (PRD §5) — all 18

| FR | Pri | Requirement | Covered in |
|----|-----|-------------|------------|
| FR-01 | Must | Register 5–10 business numbers; each gets phone_number_id + fake token | §10a `POST /api/business-numbers`, §6 |
| FR-02 | Must | `POST /{id}/messages` text → Meta success shape | §7a |
| FR-03 | Must | Meta error JSON (`code`, `subcode`, `fbtrace_id`): invalid token, unknown phone_number_id, unregistered recipient, malformed payload, one rate-limit code | §7b, §8 |
| FR-04 | Must | Message to online tile in < 1 s | §11b `message.new`, §13a |
| FR-05 | Must | Offline tile / closed group queues; online flushes in order | §11a `tile.presence`, §13 |
| FR-06 | Must | Status webhooks: sent on accept, delivered on receipt, read on open | §9b, §13b |
| FR-07 | Must | Tester typing fires inbound webhook in Meta's envelope | §9a, §11a `message.send`, §13d |
| FR-08 | Must | All webhooks signed; retried up to 3 times on non-200 | §9c, §9e |
| FR-09 | Must | Launch page lists groups free/locked; free group opens one tile per number | §10a `GET /api/groups`, §11 `group.claim`, §12 `groups.update` |
| FR-10 | Should | Auto-reply manual / echo / keyword map, optional fixed delay | §14, §10b, §11a `tile.autoreply` |
| FR-11 | Must | Admin live log (from, to, body, status timeline) in real time, incl. late statuses | §10c `/api/log`, §12 admin feed |
| FR-12 | Must | `POST /reset` wipes messages + queues, numbers/groups optionally kept | §10a/§10b `/api/reset` + `/reset` alias, §10c |
| FR-13 | Should | Control API: register, create group, set presence, inject — plain HTTP | §10 |
| FR-14 | Should | `/client?group=alpha` opens straight into the group (subject to lock) | §10c group slug, §11a `group.claim` |
| FR-15 | Must | Customer numbers in named groups of up to 10 | §10a `POST /api/groups`, §6 `customers` |
| FR-16 | Must | One session per group; locked groups refused; lock releases on disconnect | §6 (in-memory lock), §11d |
| FR-17 | Must | Reopen restores full history + queued | §11c snapshot, §13c |
| FR-18 | Must | Queued-during-closure statuses fire on reconnect and show in admin log | §13c, §12 `log.update` |

### 18b. PRD goals (§2) and components (§4)

| Item | Covered in |
|---|---|
| Emulate send endpoint, text only, real bodies + errors | §7, §8 |
| Signed Meta-shaped webhooks: inbound + sent/delivered/read | §9 |
| 5–10 business numbers; groups of up to 10 customers | §10 |
| Browser client: groups, tiles, send/receive, online/offline + queuing | §11, §13 (UI team renders) |
| Group lifecycle: persistence, late statuses, single session | §11c, §11d, §13c |
| Basic auto-reply (echo / keyword) | §14 |
| Admin: register numbers + groups, live log | §10, §12 |
| C1–C5 | §3 |
| Data model: numbers, groups, conversations, messages, presence | §6 |

### 18c. Tech Spec sections

| Spec | Covered in |
|---|---|
| §1 Auth model (bearer on Meta API only; `/api` + `/ws` none; webhooks signed) | §7b, §9c, §10, §11 |
| §2 Surface map (text send, mark-as-read, webhooks, verify handshake; media/templates/phone mgmt not implemented; any `/vXX.X/`) | §7d, §7e, §7f, §9 |
| §3 Send API (request, response, validation order, wamid, mark-as-read) | §7 |
| §4 Error responses + `X-Mock-Force-Error` | §8 |
| §5 Webhooks (inbound, status, signature, handshake, retries, read-without-delivered) | §9 |
| §6 Control API | §10 |
| §7 WebSocket protocol + heartbeat | §11 |
| §8 Environment variables | §5 |
| §9 Known divergences | §17 |

### 18d. UI requirements (PRD §3, §7) — built by the UI team, supplied by the backend

| PRD UI requirement | Backend supplies |
|---|---|
| "One repo, two apps" (Node server + React/Vite client), admin as a page in the client app | **[Gap — team decision]** Two repos: this backend repo + the UI team's client repo. The contract lives in `src/contract/` + README (§4, §19) |
| Launch page: groups with name, number count, free/locked; locked greyed out | `GET /api/groups` `{name, count, status}` + live `groups.update` (§10a, §12) |
| Group view: responsive grid, 3–4 tiles per row, a full group of 10 on one screen; no avatars/theming | Nothing extra; tile order = `customers.position` (§6) |
| Header: group name, connection state, count of online tiles | `group.claimed.group`, socket state, `tiles[].online` + `tile.presence` (§11) |
| Tile: number as title, green/grey online dot = toggle | `tiles[].number`, `online`; `tile.presence` (§11a) |
| Tile: unread badge | `tiles[].unread` per peer + `message.new` / `message.status` (§11c) |
| Tile: chat history, incoming left / outgoing right | `history[]` with `direction` (§11c) |
| Tile: text input + send | `message.send` (§11a) |
| Tile: gear for auto-reply mode | `tiles[].auto_reply` + `tile.autoreply` (§11, §14) |
| Reopen restores history + queued | snapshot `history` + `queued` (§11c, §13c) |
| Admin top: registration form (display number, label); list with phone_number_id, token, type, claim status | `POST/GET /api/business-numbers`, `GET /api/customers` (§10) |
| Admin middle: live log newest first — time, from, to, text, status chips (sent/delivered/read), webhook result (200 or retry count) | `GET /api/log` + `log.entry` / `log.update`: `time`, `from`, `to`, `body`, `timeline[]` → status chips, `webhooks[].attempts` → result (§10c, §12) |
| Admin corner: Reset button with a confirm | `POST /api/reset` (confirm dialog is UI-only) (§10c) |
| `data-testid` on every interactive element | Stable ids: group slug, digit-only numbers, wamids (§15) |

---

## 19. Work split (3 backend people; UI team builds against §11–§12)

**First 30–45 min, together with the UI team (PRD §10):** freeze
`src/contract/ws-events.ts` + `src/contract/api-types.ts` and the README contract
section; decide anything in §22 the team disagrees with.

| | **Job 1 — Meta side** | **Job 2 — Data + control** | **Job 3 — Live delivery** |
|---|---|---|---|
| Folders | `src/meta/`, `src/webhooks/`, `src/core/lifecycle.ts` | `src/db/`, `src/api/`, `src/core/registry.ts`, `src/core/autoreply.ts`, `tools/` | `src/ws/`, `src/core/presence.ts`, `src/core/delivery.ts`, `src/core/bus.ts` |
| Builds | §7, §8, §9 (emulator, errors, dispatcher FIFO + retries, signing, handshake, status delay) | §6, §10, §14, §5c seed script, fake-Comdove receiver, UI fixtures | §11, §12, §13 (claim/lock/heartbeat, presence, queue/flush, admin feed) |
| Delivers first | emulator 200 + errors via curl | **schema + store in ~1.5 h** (everyone depends on it) | `group.claim` + lock via `wscat` |
| Demo steps | 3, 7, 9 | 1, 2, 8, 10 | 4, 5, 6 + admin log |

Checkpoints: **①** real store in Jobs 1 + 3 → curl send reaches `wscat` and fake
Comdove gets sent + delivered. **②** real backend handed to the UI team. **③**
real wat-backend → full demo (§21).

---

## 20. Build order (fits the hour-3 / hour-5 checkpoints)

**First 30–45 min — shared freeze:** contract files + README (§19).

**Milestone A (toward Hour 3) — the basic loop**
1. Add deps; `config/env.ts`; SQLite schema + connection (§6)
2. Business numbers (with optional ids), groups, customers, GET lists, deletes (§10)
3. `POST /vXX.X/{id}/messages` happy path + validation steps 1–6 (§7a, §7b)
4. Envelopes + signing + dispatcher (FIFO, status delay) + `sent` webhook + handshake (§9)
5. WebSocket `group.claim` → lock + snapshot, `message.new`, `message.send` + inbound webhook (§11)
6. `GET /api/log` + admin feed `log.entry` / `log.update` (§10c, §12)
7. `tools/fake-comdove.ts` + §5c seed script → first real wat-backend send

**Milestone B (toward Hour 5) — the hard bits**
8. Presence (tile flag + effective online) + offline queue + `queue.flush` (§13)
9. `delivered` / `read` webhooks + `message.status` mirror (§9b, §11b)
10. Heartbeat 15 s + lock release + `groups.update` (§11d)
11. Group close/reopen: snapshot with queued, late delivered (§13c)
12. Error set + unknown id + `X-Mock-Force-Error` + not-implemented catch-all (§7f, §8)
13. Retries 1/5/15 s + attempt log + restart resume (§9e, §9h)
14. `POST /api/reset` + `/reset` alias (§10c)
15. Auto-reply engine + endpoints + `tile.autoreply` (§14)
16. `/api/presence` + `/api/inject` parity with WS; mark-as-read (§10c, §7d)
17. Full demo run against wat-backend (§21)

Rule: if a bit is not integrated at a checkpoint, **simplify it, never extend it.**

---

## 21. Acceptance — the demo script (PRD §10), with backend checks

| # | Demo step | Backend proof |
|---|---|---|
| 1 | Register 5 business numbers and 2 client groups (≤10 customers each) in admin | `GET /api/business-numbers` = 5, `GET /api/groups` = 2, both free |
| 2 | Point a local wat-backend at the mock via env; no code change in wat-backend | §5a env + §5c seeded rows; handshake `ok` in `GET /api/status` |
| 3 | From Comdove, send a text to an online tile → appears < 1 s; admin log sent → delivered → read; Comdove gets all three status webhooks | log entry timeline has 3 statuses, 3 webhook jobs `ok` (200); Comdove `WaMessage.status = read` |
| 4 | Toggle a tile offline, send, toggle online → queued message arrives, delivered fires | message queued (no `delivered_at`) → `queue.flush` → `delivered` job `ok` |
| 5 | Close a group's tab, send 2–3 messages, reopen → history + queued appear, delivered fires on reconnect, read fires when the chat opens | snapshot `queued` has them in order; delivered jobs after claim; read jobs after `chat.read`; all visible in the live log |
| 6 | While a group is open, open it from a second tab → launch page shows it locked and refuses | `GET /api/groups` status `locked`; second `group.claim` → `group.locked` |
| 7 | Type a reply in a tile → Comdove receives a signed inbound webhook and shows the message | inbound job `ok` (200 means Comdove's signature check passed) |
| 8 | Set one tile to keyword auto-reply and hold a short bot conversation from Comdove | replies with `source: autoreply` in the log, each with an `ok` inbound job |
| 9 | Trigger one error case (bad token) and show Comdove handling Meta's error JSON | wrong token → 401 / code 190 envelope; wat-backend raises `MetaApiError` with `metaCode 190` |
| 10 | `POST /reset` → everything clears, numbers and groups remain | log empty; numbers + groups lists unchanged; open sessions get a fresh empty snapshot |

If all ten pass, v1 is done and phase 2 (Playwright + load) can start on top
without rework.

---

## 22. Gaps in the PDFs and how this plan resolves them

| # | Gap in PDFs | Resolution | § |
|---|---|---|---|
| 1 | Spec says Comdove reads the token from env; it reads it from its DB and resolves webhooks by `phoneNumberId` | Optional ids on registration + seed script for Comdove's local DB | 5c, 10a |
| 2 | `entry.id` hardcoded `MOCK-WABA-1` | Per business number `waba_id`, matching Comdove's `WabaAccount.wabaId` | 6, 9a |
| 3 | Status could reach Comdove before it stores the wamid → `UNKNOWN_WAMID` | `STATUS_WEBHOOK_DELAY_MS` (default 500 ms) before the first status | 5.0, 9f |
| 4 | Retries could reorder a conversation's webhooks | Per-conversation FIFO dispatcher | 9f |
| 5 | Retry count: "up to 3 times" vs "3 attempts" | 1 attempt + 3 retries at 1/5/15 s | 9e |
| 6 | Mark-as-read: webhook (Spec §2) vs tile only (Spec §3) | Tile only, no webhook (matches Meta) | 7d |
| 7 | Unknown `phone_number_id` in FR-03 but not in Spec error table; `error.subcode` missing | 400 / 100 / subcode 33; `error_subcode` in envelope | 7b, 8 |
| 8 | Validation order position of force-error / unknown id | Force-error first, then unknown id, then Spec order | 7b |
| 9 | wat-backend omits `recipient_type`, `preview_url` | Optional | 7a |
| 10 | Lock stored in the data model would survive a crash | Lock in memory; free on boot | 6, 11d |
| 11 | Single webhook-result column can't hold every attempt | `webhook_jobs` + `webhook_attempts` tables | 6 |
| 12 | "Queued" confused with status | Queued = sent but not delivered | 6 |
| 13 | A number in two groups makes routing ambiguous | One group per customer; not also a business number | 6, 10c |
| 14 | Which business number a tile replies to | Snapshot lists business numbers; one chat per business per tile | 11c |
| 15 | No admin live channel (FR-11 real time) | Admin feed on `/ws` | 12 |
| 16 | No delete endpoints (PRD C5) | `DELETE` numbers and groups | 10b |
| 17 | Admin shows customers + "claim status"; no endpoint | `GET /api/customers` with `claim_status` = group locked/free | 10b |
| 18 | Auto-reply placement, storage, API not specified | Server-side engine, SQLite, `GET/PUT` + `tile.autoreply` | 14 |
| 19 | Reset path `/reset` (PRD) vs `/api/reset` (Spec); `keep_numbers` default | Both paths; default `true` | 10b, 10c |
| 20 | `/api/presence` and `/api/inject` effects not spelled out | Same effects as the WS actions | 10c |
| 21 | No client receipt ack | Delivered = pushed to an open online tile | 13a |
| 22 | Default tile presence | Online by default; flag persisted | 13a |
| 23 | `message.new` has only `to`; inbound echoes need the tile | Added `number` field | 11b |
| 24 | Presence / auto-reply changes from the API must reach the open tile | Server → client `tile.presence`, `tile.autoreply` | 11b |
| 25 | Handshake failure behaviour | Never blocks boot; re-run via `POST /api/webhook/verify` | 9d |
| 26 | `X-Mock-Force-Error` can't be sent by wat-backend | Bad-token demo uses a real wrong token; header for curl/phase 2 | 8c |
| 27 | Mock restart drops pending webhooks | Resume `pending` jobs on boot | 9h |
| 28 | wat-backend `interactive-menu.service.ts:19` hardcodes graph.facebook.com | Documented risk; do not trigger interactive menus | 5d |
| 29 | `packages/shared` does not fit a backend-only repo | `src/contract/` files | 4 |
| 30 | Spec §8 lists 5 env vars only | One optional var with a default (`STATUS_WEBHOOK_DELAY_MS`) | 5.0 |
| 31 | PRD §3 "one repo, two apps" vs a separate UI team | Two repos sharing `src/contract/` (team decision) | 18d |
