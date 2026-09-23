# WS-345 — Seed + broadcast harness, and the WhatsApp-style client UI

One feature, two repos, one branch name in both: **`scale-100-per-groups`**.

- `comdove-fake-backend` — 100 customer numbers per group (was 10), a seed script, a send
  script, and the scale fixes needed to survive 500 messages.
- `comdove-fake-ui` — the client screen rebuilt as WhatsApp: pick a number, then see that
  phone's own chats, in WhatsApp's white-and-green theme.

> Code comments and commit messages say **WS-343** — the ticket the work started under.

## Contents

1. [Architecture](#1-architecture)
2. [Run everything, in order](#2-run-everything-in-order)
3. [Seed data — what gets created](#3-seed-data--what-gets-created)
4. [Sending messages](#4-sending-messages)
5. [Connect ComDove (optional)](#5-connect-comdove-optional)
6. [What the UI looks like](#6-what-the-ui-looks-like)
7. [What changed under the hood](#7-what-changed-under-the-hood)
8. [Known limit](#8-known-limit)
9. [Where the code is](#9-where-the-code-is)

---

## 1. Architecture

```
 Terminal                     Fake WhatsApp server (:4020)              Fake UI (:5173)
 ────────                     ─────────────────────────────            ────────────────
 npm run seed:e2e ──────────► Control API  /api/*            ◄──────── Admin   /admin
   5 businesses                 numbers · groups · live log             numbers, groups,
   5 groups × 100 numbers       SQLite  mock.sqlite                     live message log

 npm run blast ─────────────► Meta API                       ◄──────── Client  /client
   500 messages                 /v23.0/{phone_id}/messages              WhatsApp-style inbox
                                          │                              (WebSocket /ws)
                                          │ webhooks
                                          │ (inbound + sent/delivered/read)
                                          ▼
                                 ComDove wat-backend (:3000)
                                   Postgres :5432  ·  Redis :6379
```

The fake server, its UI and the two scripts (`seed:e2e`, `blast`) work fully on their own.
ComDove is only needed for section 5, when messages must actually land in a real inbox.

---

## 2. Run everything, in order

**0. Docker (once)** — Postgres + Redis, only needed for step 5:
```bash
open -a Docker                                    # if it isn't already running
cd wat-backend && docker compose up -d
docker ps                                         # both containers "healthy"
```

**1. Fake server** (terminal A):
```bash
cd comdove-fake-backend
npm install
cp .env.example .env          # defaults are local-only — never point COMDOVE_WEBHOOK_URL
npm run dev                   # at a live ComDove
```
Wait for: `🟢 comdove-fake-backend listening on http://localhost:4020`

**2. Fake UI** (terminal B):
```bash
cd comdove-fake-ui/client
npm install
cp .env.example .env          # set VITE_DATA_SOURCE=server
npm run dev                   # → http://localhost:5173 (or 5174 if 5173 is busy)
```

**3. Seed the data** (terminal C, once the fake server is up):
```bash
cd comdove-fake-backend
npm run seed:e2e
```

**4. wat-backend / ComDove** (terminal D — only for section 5):
```bash
cd wat-backend
npm run dev
```
Wait for: `🤝 webhook handshake ok`

**5. Tell ComDove about the business numbers** (terminal C, only for section 5):
```bash
cd comdove-fake-backend
npm run seed-comdove
```

**Open in the browser:**
| Page | URL |
|---|---|
| Client (WhatsApp-style inbox) | http://localhost:5173/client?group=e2e-business1 |
| Admin (numbers, groups, live log) | http://localhost:5173/admin |

**6. Send messages** (terminal C):
```bash
npm run blast                  # business 1 → its 100 numbers
npm run blast -- --all         # all 5 businesses → 500 messages
```

**To stop:** `Ctrl+C` in terminals A, B, D. Optionally `docker compose down` in wat-backend.

---

## 3. Seed data — what gets created

`npm run seed:e2e` creates **5 business numbers**, each owning **its own group of 100 customer
numbers** — 500 tiles, 500 possible conversations.

| Business | Display number | phone_number_id | token | Group | Customer numbers |
|---|---|---|---|---|---|
| 1 | 918000000001 | `E2E_PH_1` | `e2e-token-1` | `e2e-business1` | 919100000001 … 919100000100 |
| 2 | 918000000002 | `E2E_PH_2` | `e2e-token-2` | `e2e-business2` | 919200000001 … 919200000100 |
| 3 | 918000000003 | `E2E_PH_3` | `e2e-token-3` | `e2e-business3` | 919300000001 … 919300000100 |
| 4 | 918000000004 | `E2E_PH_4` | `e2e-token-4` | `e2e-business4` | 919400000001 … 919400000100 |
| 5 | 918000000005 | `E2E_PH_5` | `e2e-token-5` | `e2e-business5` | 919500000001 … 919500000100 |

All numbers are fixed and deterministic, so ComDove can be seeded to match (`seed-comdove`,
section 5) and both sides always agree.

**Options:**
```bash
npm run seed:e2e -- --dry-run                       # show the plan, write nothing
npm run seed:e2e -- --businesses 2 --per-group 10   # a smaller set
BASE_URL=https://testserver.stacx24.com UI_USER=… UI_PASSWORD=… npm run seed:e2e   # AWS
```

**Re-running is safe.** Anything that already exists comes back `409` and is reported as
"already there" — nothing is duplicated or deleted.

**To start from empty:**
```bash
curl -X POST localhost:4020/api/reset -H 'Content-Type: application/json' -d '{"keep_numbers":false}'
```

---

## 4. Sending messages

Open the group in the browser first (`/client?group=e2e-business1`) and leave the tab open —
tiles must be online, or messages are queued until the group is opened.

```bash
npm run blast                    # business 1 → its 100 numbers
npm run blast -- --all           # all 5 businesses → 500 messages
npm run blast -- --business 3    # one business only
npm run blast -- --count 10      # first 10 numbers only (a quick check)
npm run blast -- --text "Hello from Comdove"
```

Watch them arrive live in the Inbox, and in **Admin → Live message log**.

---

## 5. Connect ComDove (optional)

Only needed when the messages must actually reach wat-backend's database.

**`wat-backend/.env`** — local database only, never production:
```env
PORT=3000
DB_TARGET=local
META_GRAPH_API_BASE_URL=http://localhost:4020
META_APP_SECRET=<same value as the mock's APP_SECRET>
WHATSAPP_VERIFY_TOKEN=<same value as the mock's WEBHOOK_VERIFY_TOKEN>
```

**Check the handshake:**
```bash
curl -X POST localhost:4020/api/webhook/verify
# → {"ok":true,"detail":"challenge echoed"}
```

The admin log's Webhook column then shows **200** instead of "failed · timeout".

| Symptom | Meaning |
|---|---|
| "failed · timeout", 3–5 ms | Nothing is listening on port 3000 — start wat-backend |
| **401** | `META_APP_SECRET` ≠ the mock's `APP_SECRET` |
| Message not in ComDove's inbox | ComDove doesn't know the business number — run `seed-comdove` |

---

## 6. What the UI looks like

The client page shows the test from **the customer's side**: you pick a phone, then you see
exactly what that phone would see in WhatsApp — in WhatsApp's own theme (white panels, green
bubbles, beige wallpaper, blue read ticks). A toggle in the header switches to **Tiles** (the
original 100-tile grid) if you prefer it. The admin page uses the same theme.

### Step 1 — pick a number

```
┌────────────────────────────────────────────────────────────────────┐
│ [ e2e-business1 ] [ e2e-business2 ] [ e2e-business3 🔒 ] …          │ ← other groups
├──────────────────────────┬─────────────────────────────────────────┤
│ Search 100 numbers…      │                                          │
├──────────────────────────┤                   💬                     │
│▎(01) +919100000001  12:04│              Pick a number               │
│  E2E Business 1: msg 1  ①│   Choose one of this group's 100        │
│ (02) +919100000002  12:04│   numbers to open its chats…            │
│  E2E Business 1: msg 2   │                                          │
│            ⋮             │                                          │
├──────────────────────────┤                                          │
│ ↑↓ move · Enter · Esc    │                                          │
└──────────────────────────┴─────────────────────────────────────────┘
```

The list stays in a narrow sidebar (300–400px), as WhatsApp does — it never stretches across
the screen. Search covers all 100 numbers. Each row shows the last message, the unread count,
and a chip with the queued count when the phone is offline.

**Keyboard:** `↑` `↓` move the cursor (the green bar on the left edge), `Enter` opens it,
`Esc` goes back — or clears the search first. The arrows work while you type in the search
box, so you can filter and jump straight down.

### Step 2 — open a number to see that phone's WhatsApp

```
┌──────────────────────────┬─────────────────────────────────────────┐
│ ← (05) +9191…005  [YOU]  │ (E) E2E Business 1                      │
│        ONLINE      ● ⚙   │     +918000000001                       │
├──────────────────────────┼─────────────────────────────────────────┤
│ 👥 e2e-business1    12:04│            ──── TODAY ────              │
│    WS-343 message 100    │  ┌──────────────────────┐               │
│ ─────────────────────────│  │ WS-343 message 5  ✓✓ │               │
│▎(E) E2E Business 1  12:04│  └──────────────────────┘               │
│     WS-343 message 5   ② │ ═══ 2 UNREAD MESSAGES ═══               │
│ (E) E2E Business 2       │  ┌──────────────────────┐               │
│     No messages yet      │  │ broadcast test    ✓✓ │               │
│ (E) E2E Business 3       │  └──────────────────────┘               │
│     No messages yet      │              ┌───────────────────┐      │
│                          │              │ my reply    12:05 │      │
├──────────────────────────┼─────────────────────────────────────────┤
│                          │ Type a message                 [ Send ] │
└──────────────────────────┴─────────────────────────────────────────┘
```

- **Left — that phone's chat list**, exactly like WhatsApp: the **group** it belongs to
  pinned on top, then **one separate chat per business number**. Businesses that haven't
  written yet are listed too, so a chat can always be started with any of them.
- **Top-left is the phone itself** — its number tagged **YOU**, an online/offline toggle, and
  the ⚙ auto-reply panel. `←` (or `Esc`) goes back to the number list.
- **Right — the open conversation.** A business chat is a plain 1-to-1 thread with a
  composer; the phone's own messages sit on the right in green with ticks.
- **Day dividers** (`TODAY`, `YESTERDAY`, `22 JANUARY 2026`) and a **`N UNREAD MESSAGES`**
  band mark where you left off. The band is captured as the chat opens and stays put while
  you read, as WhatsApp does.
- **The group chat** is the whole group's traffic in one feed, each message labelled with who
  sent it and to which number — useful for watching a 500-message broadcast land. It is
  read-only, because the mock has no group-send.
- **Header and composer stay pinned.** Only the chat list and the message thread scroll —
  fixed by giving the app shell a real `height: 100vh` instead of `min-height`, which had let
  the whole page (composer included) scroll away.

### Contact info — click the profile icon

```
┌───────────────────────────────┐
│ Contact info               ✕  │
│                                │
│           (••)                 │
│        +919100000001          │  ← the client number, revealed here
│           Online               │
│  ────────────────────────────  │
│  MESSAGED BY                   │
│  E2E Business 1                │
│  ────────────────────────────  │
│  Messages           14         │
│  Queued              0         │
└───────────────────────────────┘
```
Slides in from the right over the open conversation. Shows the customer's full number, online
state, every business that has messaged them, and message/queue counts.

---

## 7. What changed under the hood

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
| **Number list → per-phone WhatsApp** (group chat + one chat per business, contact info, group switcher) | the tile grid had no way to show who sent what at 100 tiles; this shows the test from the customer's side |
| **WhatsApp theme across client and admin** — white panels, green bubbles on the right, white on the left, beige wallpaper, blue read ticks | asked for: match WhatsApp exactly |
| **Narrow sidebar** (300–400px) + splash pane | full-width rows stretched across the screen and looked messy |
| **Day dividers + "N unread messages" band**, **keyboard nav** (↑/↓/Enter/Esc) | the last WhatsApp details, and scanning 100 numbers by mouse was slow |
| App shell `height: 100vh` (was `min-height`) + `.main` owns the one scrollbar | the composer and header were scrolling away with the page |
| A status update touches only its own tile | it used to rebuild all 100 tiles per update |
| `Tile` memoised | one event re-rendered every tile and bubble |
| Tile settings load 8 at a time | opening a group fired 100 requests at once |
| Admin log reads 500 rows | 100 rows is seconds of a 500-message run |

**Measured locally:** seed 500 tiles **0.8 s** · 500 messages accepted **0.8 s**, all webhooks
delivered · open a 100-tile group **37 ms / 31.6 KB** · `GET /api/log?limit=500` **0.12 s**.
**Tests:** backend 272 pass, UI 96 pass. Both typecheck clean; the UI builds clean.

---

## 8. Known limit

The mock handles **text messages only**. A ComDove *campaign* sends WhatsApp **templates**, so
a campaign-driven broadcast is refused with:
```
(#100) message type "template" is not implemented in comdove-mock
```
The 500-message run above (`npm run blast`, or ComDove's own inbox send) works today; a
campaign-driven broadcast needs template support added to the mock first — scope to confirm
against WS-341 / WS-342.

---

## 9. Where the code is

Both repos, branch **`scale-100-per-groups`**:

| Repo | What's there |
|---|---|
| `comdove-fake-backend` | `9d2683c` — scale + seed/blast harness, and this doc |
| `comdove-fake-ui` | `e0dd45c` — 100 tiles per group · `6f19d2f` — WhatsApp-style client · plus the theme, sidebar layout, dividers and keyboard nav |

Open a PR when ready:
- https://github.com/stacx24/comdove-fake-backend/pull/new/scale-100-per-groups
- https://github.com/stacx24/comdove-fake-ui/pull/new/scale-100-per-groups
