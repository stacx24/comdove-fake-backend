# Existing Fake WhatsApp Server — What It Does, Its Flow, and Its Limits

> This document explains the **current** fake server that already lives in
> `wat-backend/fake-whatsapp-server/`. It covers what it does, how a message
> flows through it, and why it is **not enough** for the Comdove Mock Server
> hackathon PRD. Written in plain words.

---

## 1. What it is (in one line)

A small local tool that lets you test wat-backend's **inbound WhatsApp
automations** on your laptop — no real Meta, no real phone, no deploy. It plays
**both sides** of WhatsApp: it pretends a customer texted you, and it catches the
reply your backend tries to send.

It is a **proof of concept for one number, one customer, one chat** — not a full
mock of Meta.

---

## 2. What it does (features)

| # | Feature | How |
|---|---------|-----|
| 1 | **Inbound injector** | Pretends a customer sent a text and posts a correctly **signed** webhook to the local backend so the automation runs |
| 2 | **Outbound mock** | Stands in for the Graph API — when the backend "sends" a reply it lands here and is shown on screen instead of going to a real phone |
| 3 | **Signature signing** | Signs every inbound webhook with `X-Hub-Signature-256` (HMAC-SHA256 of the raw body, keyed with `META_APP_SECRET`) so the backend accepts it |
| 4 | **Chat persistence** | Saves the whole conversation to a **JSON file** (`conversations.json`) so it survives a restart |
| 5 | **Simple web UI** | A single static page (`public/index.html`) to type a message and watch the chat |
| 6 | **Local-tables mode** | Sends an `X-Local-Test: true` header so the backend writes to `Local*` tables, not the real ones |
| 7 | **Permissive fallback** | Any other Graph API call (mark-as-read, media, templates) returns `200 {success:true}` so the backend does not error |

---

## 3. Files (what each does)

```
fake-whatsapp-server/
├── server.js            # the whole server: routes + UI + inject + outbound mock
├── src/payload.js       # builds the Meta inbound webhook envelope + signs the body
├── src/store.js         # loads/saves the conversation to a JSON file
├── public/index.html    # the single-chat web UI
├── conversations.json   # the saved chat (the fake server's own record)
├── .env / .env.example  # config
└── test/                # payload + store tests
```

- **`server.js`** — Express app. Key routes:
  - `GET  /config` — tells the UI the backend URL, webhook path, defaults.
  - `GET  /thread` — returns the saved chat.
  - `POST /thread/clear` — clears the chat.
  - `POST /simulate` — **inbound**: build a Meta payload, sign it, POST it to the backend webhook.
  - `POST /:version/:phoneNumberId/messages` — **outbound**: catches the backend's send, logs it, returns a Meta-shaped success.
  - `ALL  /v{n}/...` — fallback for any other Graph call → `200 {success:true, data:[]}`.
- **`src/payload.js`** — `buildInboundPayload()` makes the `whatsapp_business_account` → `entry[] → changes[] → value` envelope for one text message. `signBody()` does the HMAC-SHA256 signature.
- **`src/store.js`** — `loadThread()` / `saveThread()` read/write the JSON file.

---

## 4. Config (env variables)

| Variable | Default | Meaning |
|----------|---------|---------|
| `PORT` | `4000` | Fake server port |
| `BACKEND_URL` | `http://localhost:3000` | Where inbound webhooks are POSTed |
| `WEBHOOK_PATH` | `/webhooks/whatsapp` | The backend webhook route |
| `META_APP_SECRET` | *(empty)* | **Must match** wat-backend, or webhooks are rejected (401) |
| `LOCAL_MODE` | `true` | Adds `X-Local-Test` header to write to `Local*` tables |
| `DEFAULT_FROM` / `DEFAULT_PHONE_NUMBER_ID` / `DEFAULT_WABA_ID` / `DEFAULT_PROFILE_NAME` | baked-in test values | Pre-fill the UI for one number |
| `CONVERSATIONS_FILE` | `./conversations.json` | Where the chat is saved |

**The switch on the wat-backend side:** set
`META_GRAPH_API_BASE_URL=http://localhost:4000` (send replies here) and point
`DATABASE_URL` at a **local** Postgres — **not** prod RDS.

---

## 5. The flow

### 5a. Inbound flow (customer → backend)

```
You type in the UI (or POST /simulate)
        │
        ▼
buildInboundPayload()  →  makes the Meta "whatsapp_business_account" envelope
        │
        ▼
signBody()  →  HMAC-SHA256 signature (X-Hub-Signature-256)
        │
        ▼
POST  BACKEND_URL + WEBHOOK_PATH   (+ X-Local-Test header if LOCAL_MODE)
        │
        ▼
wat-backend verifies signature → runs onInboundMessage → your automation
        │
        ▼
chat saved to conversations.json ; UI shows the message on the right
```

### 5b. Outbound flow (backend → customer)

```
wat-backend automation decides to reply
        │
        │  (because META_GRAPH_API_BASE_URL points at the fake server)
        ▼
POST  /{version}/{phoneNumberId}/messages   →  hits the fake server
        │
        ▼
fake server logs it + saves to conversations.json
        │
        ▼
returns a Meta-shaped success:
   { messaging_product, contacts:[...], messages:[{ id: "wamid.LOCALREPLY_...", message_status:"accepted" }] }
        │
        ▼
UI shows the reply as a left-side bubble  (no real message ever sent)
```

**Summary of the loop:** you inject a customer message → the backend automation
runs → its reply comes back to the fake server → both show up in the single-chat
UI, and both are saved to a JSON file.

---

## 6. Issues / gaps — why this is NOT enough for the PRD

The current server proves **2 of the flows** well (inbound inject + outbound
accept + signing), but the hackathon PRD is a much bigger, different-shaped
thing. Here is what is missing or wrong for the PRD.

### 6a. Wrong storage
- **Uses a JSON file, PRD requires SQLite.** The PRD says group history and
  offline queues **must survive disconnects** — a JSON file cannot reliably do
  queues, locks, and multi-group state.

### 6b. Wrong shape — single chat, not a grid
- **One conversation only.** It handles a single hardcoded number/customer. The
  PRD needs **5–10 business numbers** and **groups of up to 10 customers** (≈150
  numbers), each customer as its own **tile** in a grid.
- The UI is one static chat page — there is **no tile grid, no group picker, no
  admin page.**

### 6c. No live channel (no WebSocket)
- Messages move by HTTP + a JSON file. The PRD needs a **WebSocket** so a message
  appears in a tile in **under 1 second** and tiles can be toggled live.

### 6d. No status webhooks
- It only forwards inbound and accepts outbound. It **never fires
  sent → delivered → read** status webhooks back to Comdove (PRD FR-06).

### 6e. No real error emulation
- It **always returns success** (even the fallback returns `200`). The PRD needs
  **Meta error JSON**: `401/190` bad token, `100` bad request, `131026`
  undeliverable, `130429` rate limit — plus the `X-Mock-Force-Error` header.

### 6f. No auth / no validation
- The outbound endpoint **ignores the bearer token** and does **not validate**
  the recipient. The PRD requires checking the token per number and that `to` is
  a registered customer.

### 6g. No presence / queue / lock
- No **online/offline** per tile, no **offline queue** that flushes on
  reconnect, no **one-browser-per-group session lock** (PRD FR-05, FR-16, FR-17,
  FR-18).

### 6h. No control API, no admin log, no reset
- No `/api/business-numbers`, `/api/groups`, `/api/presence`, `/api/inject`,
  `/api/log`, `/api/reset`. No live admin log table. No reset endpoint.

### 6i. No verify handshake / no retries
- No `hub.mode`/`hub.verify_token`/`hub.challenge` handshake, no 3× retry with
  backoff on non-200 (PRD FR-08).

### 6j. Small mismatches
- Message ids use `wamid.LOCALREPLY_` / `wamid.LOCAL_`; the PRD wants
  `wamid.MOCK-`.
- Default port is `4000`; the PRD spec uses `4020`.
- No `data-testid` on UI elements (PRD requires them from commit one).
- Plain JavaScript + static HTML; the PRD requires **TS/Express + React/Vite**.

---

## 7. What is worth keeping (reuse for the new build)

Two pieces are already correct and should be **lifted into the new project**:

1. **`src/payload.js` → `buildInboundPayload()`** — the Meta inbound envelope
   shape is right and already matches what the backend reads.
2. **`src/payload.js` → `signBody()`** — the `X-Hub-Signature-256` signing is
   correct and verified by the existing tests.

Everything else (JSON store, single-chat UI, no-auth outbound) should be
**replaced** by the PRD build: SQLite, WebSocket, tile grid, admin, control API,
status webhooks, and real Meta errors.

---

## 8. Bottom line

| Aspect | Existing fake server | PRD requirement |
|--------|----------------------|-----------------|
| Numbers | 1 hardcoded | 5–10 business numbers |
| Customers | 1 | groups of up to 10 (~150) |
| UI | single chat page | tile grid + group picker + admin |
| Storage | JSON file | **SQLite** |
| Live updates | none (HTTP) | **WebSocket** (<1s) |
| Status webhooks | none | sent → delivered → read |
| Errors | always 200 | real Meta error JSON |
| Auth/validation | ignored | token + recipient checks |
| Presence/queue/lock | none | required |
| Control API / admin log / reset | none | required |
| Stack | plain JS + static HTML | **TS/Express + React/Vite** |

**Conclusion:** keep the existing server as a **reference** and reuse the payload
+ signing code, but the hackathon needs a **fresh build** to the PRD (TS/Express +
React/Vite + SQLite + WebSocket). Growing the current `server.js` into all of the
above would fight its single-chat, JSON-file shape.
