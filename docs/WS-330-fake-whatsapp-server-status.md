# WS-330 — Fake WhatsApp Server: Done, Remaining, and Delivery Estimate

**Author:** Sahil Thakur · **Follow-up owner:** Soma Pani · **Date:** 21 Sep 2026
**Related:** WS-304, WS-307, WS-195
**Repos:** `stacx24/comdove-fake-backend` · `stacx24/comdove-fake-ui`

> **Purpose:** one place that captures the whole fake WhatsApp server effort — what's done, what's left,
> and when the remaining work can land — so follow-up doesn't need Slack archaeology.

---

## 1. What the fake WhatsApp server is (30-second context)

A **mock of the Meta/WhatsApp Cloud API** so ComDove (`wat-backend`) can be tested end to end — sending,
receiving, delivery status, errors — **without a real Meta account, real numbers, or cost**. ComDove
switches to it by changing **one env var** (`META_GRAPH_API_BASE_URL → http://localhost:4020`); no code
change in ComDove. It has two apps: a **backend** (pretends to be Meta + a control/admin API + a WebSocket
live engine) and a **browser UI** (client tile-grid + admin page).

---

## 2. DONE — inventory of completed work

### 2.1 Backend — `stacx24/comdove-fake-backend` (branch `develop`)
Built in three lanes, all merged (**14 pull requests** merged into `develop`):

| Lane | What's done | Status |
|---|---|---|
| **Meta emulator (P1)** | `POST /v23.0/{phone_number_id}/messages` (text) returning Meta's exact success shape + `wamid.MOCK-`; full Meta error set (190 / 100 / 131026 / 130429) + `X-Mock-Force-Error`; mark-as-read; not-implemented catch-all | ✅ done |
| **Webhooks to Comdove (P1)** | signed `X-Hub-Signature-256` inbound + status (sent/delivered/read) webhooks; verify handshake; per-conversation FIFO dispatcher with retries (1s/5s/15s); SqliteJobStore | ✅ done |
| **Data core + Control API (P2)** | SQLite (8 tables); ~15 `/api/*` endpoints (register/list/delete business numbers, create/list/delete groups, customers, presence, inject, log, reset + `/reset` alias, auto-reply get/put, webhook/verify, status); auto-reply engine (manual/echo/keyword); phone-number validation | ✅ done |
| **Live engine (P3)** | WebSocket `/ws` (one session per group); one-browser-per-group lock + 15s heartbeat; live delivery (`message.new`), offline queue + flush, presence, group snapshot on claim; tile actions over `/ws` (message.send, chat.read, presence, auto-reply) driving the lifecycle; **admin live feed** (log/groups/numbers/verify/reset) | ✅ done |
| **Tooling / fixtures** | `seed-comdove.ts` (seeds mock numbers into Comdove's local DB); `fake-comdove` receiver; **UI fixtures** — sample JSON for every `/api` response + `/ws` frame; Swagger at `/docs` | ✅ done |

**Quality:** build clean; **270 automated tests pass** (~247 `test()` across 41 files — unit, integration,
e2e, load/WS). Swagger UI live at `/docs`.

### 2.2 UI — `stacx24/comdove-fake-ui` (branch `main`)
React + Vite + TypeScript. **2 feature PRs merged** (`#1 feature/admin-ui`, `#2 feature/client-ui`), then merged together.

| Screen | What's done | Status |
|---|---|---|
| **Admin page** | register number form, numbers table (business + customers, type + claim), live message log with per-status webhook attempts, delete numbers/groups, reset | ✅ done |
| **Client launch** | group list with free/locked, reads the server's real groups format | ✅ done |
| **Client grid** | tile per customer, online/offline toggle, chat history, send box, auto-reply gear; server-side auto-reply + WebSocket error handling | ✅ done (see gaps §3) |
| **Plumbing** | REST via `/api` + WebSocket via `/ws` (dev-proxied to :4020); `data-testid` on every interactive element; sample-data mode for offline dev | ✅ done |

**Quality:** build clean; **94 UI tests pass** (6 test files).

### 2.3 Proven end-to-end (live, against the REAL Comdove/wat-backend)
Verified on 19–21 Sep with wat-backend pointed at the mock (`DB_TARGET=local`, `META_GRAPH_API_BASE_URL=http://localhost:4020`):
- **Inbound** (customer → Comdove): mock's signed webhook verified (`signatureValid=t`), message stored + shown in Comdove's inbox UI. ✅
- **Outbound** (Comdove UI → customer): a message sent from Comdove's inbox reached the mock and showed **Delivered** (✓✓) back in Comdove. ✅
- **Admin + Launch UI** driven by the real mock API. ✅
- **Tile send** (type in a tile → reaches real Comdove) after the `group-events` fix. ✅

---

## 3. REMAINING — gaps, unfinished items, integration left

### 3.1 UI (`comdove-fake-ui`) — the main open work
| # | Item | Detail | Severity |
|---|---|---|---|
| U1 | **Tile chat display bugs** | Incoming (server) bubbles show `+undefined` sender and `NaN:NaN` timestamp — the UI's message model expects `from`/`timestamp` but the server sends `peer`/`created_at`. A mapping is needed. | Medium (cosmetic, but visible) |
| U2 | **Chat orientation** | Customer's own messages render on the left; WhatsApp-style (PRD §7) wants own-messages on the **right** with ticks. | Low |
| U3 | **Own-message ↔ wamid pairing** | When a tile sends, the server doesn't return the new wamid, so the read tick can't attach to that bubble until reopen. Needs a `client_id`/`message.accepted` pairing (server + UI). | Low–Medium |
| U4 | **Production serving** | Dev proxies `/api` + `/ws` to :4020; a built UI has no proxy. Decide: mock serves `client/dist`, or a reverse proxy. | Low |

### 3.2 Backend (`comdove-fake-backend`) — minor
| # | Item | Detail |
|---|---|---|
| B1 | Default data source note | Fresh UI clone defaults to `mock`; needs `.env VITE_DATA_SOURCE=server` to use the real API (documented, not a code gap). |
| B2 | Live-run config | Requires wat-backend on **local DB** + matching `APP_SECRET`/`WHATSAPP_VERIFY_TOKEN` + numbers seeded (via `seed-comdove.ts` or matching ids). Documented; not automated. |

### 3.3 Integration / verification still to click through
- Demo-script steps **4 (offline queue)** and **5 (close & reopen restores history + late statuses)** are
  built + covered by tests but not yet **click-verified live** end to end.
- Auto-reply **firing** over the full live loop (keyword bot) — logic done; confirm live.

> **Not in scope / not a gap:** the ~1000 msg/sec throughput, the Governor, and the service split are
> **WS-308/WS-332 broadcast work**, separate from the fake server. The mock is the *load-test tool* for that,
> not the deliverable.

---

## 4. DELIVERY ESTIMATE (remaining work)

From today (Mon 21 Sep). Backend is essentially complete; remaining is mostly UI polish + a live pass.

| Work | Owner | Estimate |
|---|---|---|
| U1 tile-chat shape mapping (fixes `+undefined`/`NaN`) | UI team | ~0.5 day |
| U2 chat orientation (own = right) | UI team | ~0.25 day |
| U3 own-message wamid pairing (server + UI) | UI + backend | ~0.5–1 day |
| U4 production serving decision + wiring | UI + infra | ~0.5 day |
| Live verification of demo steps 4 & 5 + auto-reply loop | Sahil | ~0.5 day |

- **Milestone A — fake server demo-ready (all screens correct, live-verified):** **~2–3 working days → by ~24–25 Sep.**
- **Milestone B — polish + production serving decided:** **+1 day → ~26 Sep.**

**Summary:** the fake WhatsApp server (backend + UI) is **functionally complete and live-proven both
directions today**; remaining is **~2–3 days** of UI display fixes + a live verification pass. No blockers.

---

## 5. Where things live (so follow-up needs no Slack)

| Thing | Location |
|---|---|
| Backend repo | `stacx24/comdove-fake-backend` — branch `develop` (14 PRs merged) |
| UI repo | `stacx24/comdove-fake-ui` — branch `main` (PRs #1, #2 merged) |
| Backend plan / split | `docs/BACKEND-BUILD-PLAN.md`, `TEAM-SPLIT.md` |
| Backend status detail | `docs/PROJECT-STATUS.md` |
| UI ↔ API contract | `docs/UI-API-GUIDE.md`, `fixtures/` (sample JSON) |
| Setup / env | `docs/BACKEND-ENV-SETUP-GUIDE.md` |
| Swagger (live) | `http://localhost:4020/docs` |
| UI open questions | `comdove-fake-ui/docs/server-team-questions.md` |

---

## 6. Acceptance criteria — met by this doc
- ✅ Written inventory of completed work (backend + UI + tests + PRs) — §2
- ✅ Written list of remaining gaps / unfinished / integration left — §3
- ✅ Clear delivery estimate (dates + milestones) — §4
- ✅ Soma can follow up from here without hunting Slack — §5 (all locations linked)
