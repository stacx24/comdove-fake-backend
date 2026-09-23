# WS-343 — E2E broadcast harness (5 businesses × 100 numbers)

Fills the fake WhatsApp server with **5 business numbers, each owning a group of 100 customer
numbers** (500 tiles), and sends **100 messages per business — 500 in total** from the terminal.

Branch `scale-100-per-groups` in both repos (`comdove-fake-backend`, `comdove-fake-ui`).
A group used to hold 10 numbers; it now holds 100.

---

## How the pieces fit

```
  terminal                    fake server (:4020)                 fake UI (:5173)
  ─────────                   ───────────────────                 ───────────────
  npm run seed:e2e ──────────►  Control API  /api/*   ◄──────────  Admin  /admin
     5 businesses                                                   numbers, groups, live log
     5 groups × 100 numbers     SQLite mock.sqlite
                                                       ◄──────────  Client /client
  npm run blast ─────────────►  Meta API                             100 tiles per group
     500 messages               /v23.0/{phone_id}/messages          (WebSocket /ws)
                                       │
                                       │ webhooks (inbound + sent/delivered/read)
                                       ▼
                                 ComDove wat-backend (:3000)
                                   Postgres :5432 · Redis :6379
```

ComDove is only needed when you want the messages to reach it. The fake server, its UI and the
blast script work on their own.

---

## 1. Start the fake server

```bash
cd comdove-fake-backend
npm install
cp .env.example .env          # defaults are local-only
npm run dev                   # → http://localhost:4020
```

`.env` must stay local:

```env
COMDOVE_WEBHOOK_URL=http://localhost:3000/webhooks/whatsapp
```

> Never point this at a live ComDove: the mock would post fake messages into a real inbox.

## 2. Start the UI

```bash
cd comdove-fake-ui/client
npm install
cp .env.example .env          # set VITE_DATA_SOURCE=server
npm run dev                   # → http://localhost:5173
```

| Page | URL |
|---|---|
| Admin: numbers, groups, live log | http://localhost:5173/admin |
| Client: the phone tiles | http://localhost:5173/client |

## 3. Seed the numbers

With the server running, in another terminal:

```bash
cd comdove-fake-backend
npm run seed:e2e
```

Creates 5 business numbers and 5 groups of 100 — 500 tiles, in about a second.

| Business | Number | phone_number_id | token | Group | Customers |
|---|---|---|---|---|---|
| 1 | 918000000001 | `E2E_PH_1` | `e2e-token-1` | `e2e-business1` | 919100000001 … +100 |
| 2 | 918000000002 | `E2E_PH_2` | `e2e-token-2` | `e2e-business2` | 919200000001 … +100 |
| 3 | 918000000003 | `E2E_PH_3` | `e2e-token-3` | `e2e-business3` | 919300000001 … +100 |
| 4 | 918000000004 | `E2E_PH_4` | `e2e-token-4` | `e2e-business4` | 919400000001 … +100 |
| 5 | 918000000005 | `E2E_PH_5` | `e2e-token-5` | `e2e-business5` | 919500000001 … +100 |

Options:

```bash
npm run seed:e2e -- --dry-run                      # show the plan, write nothing
npm run seed:e2e -- --businesses 2 --per-group 10  # smaller set
BASE_URL=https://testserver.stacx24.com UI_USER=… UI_PASSWORD=… npm run seed:e2e
```

Re-running is safe: existing entries come back `409` and are reported as "already there".
To start clean: `curl -X POST localhost:4020/api/reset -H 'Content-Type: application/json' -d '{"keep_numbers":false}'`

## 4. Send the messages

Open **http://localhost:5173/client?group=e2e-business1** first and leave the tab open — tiles
must be online, otherwise messages are queued until the group is opened.

```bash
npm run blast                  # business 1 → its 100 numbers
npm run blast -- --all         # all 5 businesses → 500 messages
npm run blast -- --business 3  # one business
npm run blast -- --count 10    # first 10 numbers only
npm run blast -- --text "Hello from Comdove"
```

Watch them arrive in the tiles, and in **Admin → Live message log**.

---

## 5. Connect ComDove (optional)

Only needed when the messages must reach wat-backend.

**Postgres + Redis** (once):

```bash
cd wat-backend
docker compose up -d           # postgres :5432, redis :6379
docker ps                      # both should say healthy
```

**wat-backend/.env** — local database only, never production:

```env
PORT=3000
DB_TARGET=local
META_GRAPH_API_BASE_URL=http://localhost:4020
META_APP_SECRET=<same value as the mock's APP_SECRET>
WHATSAPP_VERIFY_TOKEN=<same value as the mock's WEBHOOK_VERIFY_TOKEN>
```

**Tell ComDove about the business numbers** (it drops webhooks from numbers it doesn't know):

```bash
cd comdove-fake-backend
COMDOVE_BACKEND_DIR=/path/to/wat-backend npm run seed-comdove
```

**Start it:**

```bash
cd wat-backend && npm run dev
```

Check: `curl -X POST localhost:4020/api/webhook/verify` → `{"ok":true,"detail":"challenge echoed"}`.
The admin log's webhook column then shows **200** instead of "failed · timeout".

> A "failed · timeout" with a 3–5 ms time means nothing is listening on port 3000 — start
> wat-backend. A **401** means the two secrets differ.

---

## What changed for 100 tiles

**comdove-fake-backend**

| Change | Why |
|---|---|
| Group limit 10 → **100** | one business messages 100 tiles |
| Indexes on `webhook_jobs(wamid)`, `webhook_attempts(job_id)`, `conversations(customer_number)`, `keyword_replies(customer_number)` | the admin log scanned whole tables per message |
| `WEBHOOK_MAX_PARALLEL` (default 20) | 500 conversations would call ComDove all at once |
| Snapshot carries the newest 50 messages per tile | a 100-tile group sent its whole history on every reconnect |
| `GET /api/log?limit=` clamped to 1…1000 | `limit=-1` returned the entire table |
| `synchronous = NORMAL` | a 500-message run makes ~6000 transactions |
| `npm run seed:e2e`, `npm run blast` | the harness itself |

**comdove-fake-ui**

| Change | Why |
|---|---|
| Group limit 10 → **100** (form check and counter) | accept 100 numbers |
| A status update touches only its own tile | it used to rebuild all 100 tiles per update |
| `Tile` memoised | one event re-rendered every tile and bubble |
| Tile settings load 8 at a time | opening a group fired 100 requests at once |
| Admin log reads 500 rows | 100 rows is seconds of a 500-message run |

Measured locally: seed 500 tiles **0.8 s** · 500 messages accepted **0.8 s**, all webhooks
delivered · open a 100-tile group **37 ms / 31.6 KB** · `GET /api/log?limit=500` **0.12 s**.
Tests: backend 272 pass, UI 96 pass.

---

## Known limit

The mock handles **text messages only**. A ComDove *campaign* sends WhatsApp **templates**, so a
campaign-driven broadcast is refused with
`(#100) message type "template" is not implemented in comdove-mock`.
The 500-message run above (terminal, or ComDove's inbox send) works today; a campaign broadcast
needs template support in the mock first — scope to confirm against WS-341 / WS-342.
