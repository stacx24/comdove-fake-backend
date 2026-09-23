# WS-330 — Fake WhatsApp Server: Done, Remaining, and Delivery Estimate

**Author:** Sahil Thakur · **Follow-up owner:** Soma Pani · **Date:** 21 Sep 2026
**Related:** WS-304, WS-307, WS-195
**Repos:** `stacx24/comdove-fake-backend` (backend) · `stacx24/comdove-fake-ui` (UI)

> One place with the whole fake WhatsApp server status — completed work, remaining gaps, and a dated
> delivery estimate — so follow-up needs no Slack archaeology. Every claim below was checked against the
> code on 21 Sep 2026.

---

## 1. What it is (context)

A **mock of the Meta/WhatsApp Cloud API** so ComDove (`wat-backend`) can be tested end to end — sending,
receiving, delivery status, errors — **without a real Meta account, real numbers, or cost**. ComDove
switches to it with **one env var** (`META_GRAPH_API_BASE_URL → http://localhost:4020`); no ComDove code
change. Two apps: a **backend** (Meta emulator + control/admin API + WebSocket live engine) and a
**browser UI** (client tile-grid + admin page). Source of truth: the Hackathon PRD + API Tech Spec (both in
`docs/`); build split in `TEAM-SPLIT.md`.

---

## 2. DONE — completed work (verified in code)

### 2.1 Backend — `comdove-fake-backend` (branch `develop`, 14 PRs merged, 270 tests passing, build clean)

**Meta emulator (C1):** `POST /:version/:phoneNumberId/messages` (text) → Meta success shape + `wamid.MOCK-`;
bearer-token check; full Meta error set — `190`, `100`, `131026`, `130429` — plus the `X-Mock-Force-Error`
injection header; mark-as-read; not-implemented catch-all.

**Webhook dispatcher (C2):** signed **`X-Hub-Signature-256`** (HMAC-SHA256) inbound + status
(sent/delivered/read) webhooks; verify handshake; per-conversation FIFO dispatcher with retries; SQLite job store.

**Data core + Control API (C3/C5):** SQLite (8 tables). Verified endpoints under `/api`:
`POST/GET /business-numbers`, `DELETE /business-numbers/:id`, `POST/GET /groups`, `DELETE /groups/:id`,
`GET /customers`, `POST /presence`, `POST /inject`, `GET /log`, `POST /reset` (+ `/reset` alias),
`GET/PUT /customers/:number/auto-reply`, `POST /api/webhook/verify`, `GET /api/status`. Auto-reply engine
(manual/echo/keyword). Swagger at `/docs`.

**Live engine (C3 live):** WebSocket `/ws`. Verified events — client→server: `group.claim`, `message.send`,
`tile.presence`, `chat.read`, `tile.autoreply`, `admin.subscribe`; server→client: `group.claimed`,
`group.locked`, `message.new`, `message.status`, `queue.flush`, and admin feed `log.entry`/`log.update`/`log.reset`.
One-session-per-group lock; 15s heartbeat (ping/pong/terminate); offline queue + flush; group snapshot on claim.

**Tooling / fixtures:** `seed-comdove.ts` (seed mock numbers into Comdove's local DB); `fake-comdove`
receiver; UI fixtures (sample JSON for every `/api` response + `/ws` frame).

### 2.2 UI — `comdove-fake-ui` (branch `main`, PRs #1/#2 merged, 94 tests passing, build clean)

Pages verified: `Launch.tsx` (group list, free/locked), `ClientGrid.tsx` (tile grid, online toggle, chat,
send box, auto-reply gear), `Admin.tsx` (register, numbers table, live log with webhook attempts, delete,
reset). REST via `/api`, WebSocket via `/ws` (dev-proxied to :4020), `VITE_DATA_SOURCE` switch (mock vs
server). **79 `data-testid`** usages (build-constraint met). Sample-data mode for offline dev.

### 2.3 Proven end-to-end LIVE (against the real Comdove/wat-backend, 19–21 Sep)
- **Inbound** (customer → Comdove): mock's signed webhook **verified** (`signatureValid=t`), message stored + shown in Comdove's inbox. ✅
- **Outbound** (Comdove → customer): a send from Comdove's inbox reached the mock and showed **Delivered** (✓✓). ✅
- **Tile send** (type in a tile → real Comdove) after the `group-events` fix. ✅
- Admin + Launch UI driven by the real mock API. ✅

### 2.4 PRD requirement coverage (FR-01 → FR-18)

| FR | Requirement | Status | Where |
|----|-------------|--------|-------|
| FR-01 | Register 5–10 business numbers + token | ✅ | `POST /api/business-numbers` |
| FR-02 | Send text → Meta success shape | ✅ | Meta emulator |
| FR-03 | Meta errors (190/100/131026/130429) | ✅ | `meta/errors.ts` |
| FR-04 | Online tile message < 1s | ✅ | WS `message.new` |
| FR-05 | Offline queue + flush in order | ✅ | `queue.flush`, presence |
| FR-06 | Status webhooks sent/delivered/read | ✅ | dispatcher |
| FR-07 | Tile reply → inbound webhook | ✅ | `message.send` → webhook (live-proven) |
| FR-08 | Signed webhooks + retries | ✅ | `X-Hub-Signature-256` + retry backoff |
| FR-09 | Launch page free/locked | ✅ | `GET /api/groups` + Launch page |
| FR-10 | Auto-reply manual/echo/keyword | ✅ | auto-reply engine + gear |
| FR-11 | Admin live log (real-time) | ✅ | `GET /api/log` + admin feed |
| FR-12 | Reset (keep numbers/groups) | ✅ | `POST /api/reset` |
| FR-13 | Control API (register/group/presence/inject) | ✅ | `/api/*` |
| FR-14 | URL-addressable groups | ✅ | `/client?group=` + slug |
| FR-15 | Groups of ≤100 customers (WS-343; was 10) | ✅ | `POST /api/groups` |
| FR-16 | One session per group (lock) | ✅ | in-memory lock + 15s heartbeat |
| FR-17 | Reopen restores history + queued | ✅ | snapshot on claim |
| FR-18 | Late statuses on reconnect | ✅ | flush + status on reconnect |

**All 18 FRs implemented.** FR-04/05/17/18 are built + covered by tests; live click-through of the
offline-queue and close/reopen steps is the one verification still pending (§3.3).

---

## 3. REMAINING — gaps, unfinished, integration left

### 3.1 UI (`comdove-fake-ui`) — the main open work
| # | Item | Detail | Severity |
|---|---|---|---|
| U1 | Tile chat display bugs | Incoming bubbles show `+undefined` sender + `NaN:NaN` time — UI expects `from`/`timestamp`, server sends `peer`/`created_at`; needs a mapping | Medium (cosmetic, visible) |
| U2 | Chat orientation | Own messages render left; WhatsApp-style (PRD §7) wants own = right with ticks | Low |
| U3 | Own-message ↔ wamid pairing | Server doesn't return the new wamid on a tile send, so the read tick can't attach until reopen | Low–Medium |
| U4 | Production serving | Dev proxies `/api`+`/ws`; a built UI has no proxy → decide: mock serves `client/dist`, or a reverse proxy | Low |

### 3.2 Backend (`comdove-fake-backend`) — minor
- Fresh UI clone defaults to `mock` data source → needs `.env VITE_DATA_SOURCE=server` (documented).
- Live run needs wat-backend on **local DB** + matching `APP_SECRET`/`WHATSAPP_VERIFY_TOKEN` + seeded numbers (documented; `seed-comdove.ts` provided).

### 3.3 Integration / verification still to click through
- Demo-script steps **4 (offline queue)** and **5 (close & reopen restores history + late statuses)** — built + tested, not yet click-verified live end to end.
- Auto-reply **firing** over the full live loop (keyword bot) — logic done; confirm live.

> **Not a gap / out of scope here:** ~1000 msg/sec throughput, the Governor, and the service split are the
> **broadcast work (WS-308/WS-332)** — the mock is the *load-test tool* for that, not part of this deliverable.

---

## 4. DELIVERY ESTIMATE (remaining work)

From today (Mon 21 Sep). Backend is essentially complete; remaining is mostly UI polish + a live pass.

| Work | Owner | Estimate |
|---|---|---|
| U1 tile-chat shape mapping (fix `+undefined`/`NaN`) | UI team | ~0.5 day |
| U2 chat orientation (own = right) | UI team | ~0.25 day |
| U3 own-message wamid pairing (server + UI) | UI + backend | ~0.5–1 day |
| U4 production serving decision + wiring | UI + infra | ~0.5 day |
| Live verify demo steps 4 & 5 + auto-reply loop | Sahil | ~0.5 day |

- **Milestone A — fake server demo-ready (all screens correct, live-verified):** **~2–3 working days → by ~24–25 Sep.**
- **Milestone B — polish + production serving decided:** **+1 day → ~26 Sep.**

**Summary:** the fake WhatsApp server (backend + UI) is **functionally complete and live-proven both
directions today**; remaining is **~2–3 days** of UI display fixes + a live verification pass. No blockers.

---

## 5. Where things live (follow-up without Slack)

| Thing | Location |
|---|---|
| Backend repo | `stacx24/comdove-fake-backend` — branch `develop` (14 PRs; 270 tests) |
| UI repo | `stacx24/comdove-fake-ui` — branch `main` (PRs #1, #2; 94 tests) |
| Backend plan / split | `docs/BACKEND-BUILD-PLAN.md`, `TEAM-SPLIT.md` |
| Per-person status tracker | `docs/PROJECT-STATUS.md` |
| UI ↔ API contract | `docs/UI-API-GUIDE.md`, `fixtures/` (sample JSON) |
| Setup / env | `docs/BACKEND-ENV-SETUP-GUIDE.md` |
| Source specs | `docs/*.pdf` (PRD + API Tech Spec) |
| Swagger (live) | `http://localhost:4020/docs` |
| UI open questions | `comdove-fake-ui/docs/server-team-questions.md` |

---

## 6. Acceptance criteria — met by this doc
- ✅ Written inventory of completed work (backend + UI + tests + PRs) — §2 (+ FR matrix §2.4)
- ✅ Written list of remaining gaps / unfinished / integration left — §3
- ✅ Clear delivery estimate (dates + milestones) — §4
- ✅ Soma can follow up from here without hunting Slack — §5
