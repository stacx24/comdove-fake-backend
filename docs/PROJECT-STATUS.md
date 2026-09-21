# comdove-fake-backend — Project Status (completed vs left)

**Source of truth:** `TEAM-SPLIT.md` (the plan) — every "Done"/"Left" item below maps
to that file's per-person **task list** and **"Done when"** checklist, and to
`docs/BACKEND-BUILD-PLAN.md` (FRs + §). Verified against the actual pushed branches
on **2026-09-19** by git inspection (read-only).

**Legend:** ✅ done · 🟡 partial · ❌ not started · 📋 = quoted from the plan.

---

## Overall summary

| Person | Lane | Branch | Status |
|--------|------|--------|--------|
| **Person 1** | Meta side (C1+C2) | `feature/meta-scope` → **merged to develop** | ✅ **done** |
| **Person 2** | Data core + Control API | `feature/person2-data-core` → **merged to develop** | ✅ core done · 🟡 2 small items left |
| **Person 3** | Live engine (WebSocket) | `feature_live_engine` (not merged) | 🟡 **~half** — plumbing done, live flow left |
| UI team | Client grid + Admin page | — | ❌ not started (separate track) |

`develop` currently = **Person 1 + Person 2 composed** (via `compose.ts`), with an
"interim delivery" stub standing in for Person 3.

---

## 👤 Person 1 — Meta side (`feature/meta-scope`, merged) ✅

📋 Plan task list (TEAM-SPLIT "Person 1"):
| # | Plan task | Status |
|---|-----------|--------|
| 1 | Send endpoint + mark-as-read + not-implemented catch-all | ✅ |
| 2 | Real Meta errors + `X-Mock-Force-Error` | ✅ |
| 3 | `core/lifecycle.ts` (sent→delivered→read state machine) | ✅ |
| 4 | Webhook dispatcher: envelopes, signing, FIFO, status delay, retries, resume | ✅ |
| 5 | Verify handshake | ✅ |
| 6 | `tools/fake-comdove.ts` | ✅ |

📋 "Done when" — all met:
- ✅ Comdove send → Meta success; bad token → 401/190 *(verified live: 11/11 smoke checks)*
- ✅ Fake Comdove + real wat-backend accept every webhook in order
- ✅ Forced 500 shows 4 attempts in the log

**Evidence:** 130 automated tests pass; merged into develop via PR #3; **live inbound
test against the REAL wat-backend succeeded** (signature verified, message stored).
**Left:** nothing from the plan.

---

## 👤 Person 2 — Data core + Control API (`feature/person2-data-core`, merged) ✅ (2 small items left)

📋 Plan task list (TEAM-SPLIT "Person 2"):
| # | Plan task | Status |
|---|-----------|--------|
| 1 | SQLite 8 tables + schema on boot | ✅ |
| 2 | Store helpers (`core/registry.ts`, messages) | ✅ |
| 3 | `src/index.ts` + `src/config/env.ts` | ✅ |
| 4 | 15 control endpoints + `/reset` alias | ✅ |
| 5 | Auto-reply engine (FR-10) | ✅ config + logic (fires via P1's interim delivery on develop) |
| 6 | `tools/seed-comdove.ts` | 🟡 **skeleton — LEFT** (needs `pg` + wat-backend `encryptSecret` wired) |
| 7 | UI fixtures (sample JSON per `/api` response) | 🟡 **LEFT** (types + Swagger examples exist; no fixtures file) |

📋 "Done when":
- ✅ Numbers/groups registered, listed, deleted over HTTP
- ✅ `/api/log`, `/api/reset`, `/reset` work
- 🟡 "A keyword tile answers on its own" — works on develop via P1's interim delivery
- 🟡 "wat-backend resolves the mock's phone_number_id" — proven in the live test **by seeding wat-backend's DB manually** (the `seed-comdove.ts` script itself is still a skeleton)

**Evidence:** build clean; 130 tests; 17/17 browser checks; merged to develop.
**Left (2 items):** **Task 6** (finish seed script) and **Task 7** (UI fixtures).

---

## 👤 Person 3 — Live engine (`feature_live_engine`, NOT merged) 🟡 ~half

📋 Plan task list (TEAM-SPLIT "Person 3"):
| # | Plan task | Status | File |
|---|-----------|--------|------|
| 1 | `/ws` server + 15s heartbeat | ✅ | `ws/server.ts` |
| 2 | Group sessions: 5 client→server + 8 server→client events | 🟡 **partial** — claim/roles/errors done; live handlers left | `ws/session.ts` |
| 3 | Presence, delivery, queue flush | ❌ **LEFT** | `core/presence.ts`, `core/delivery.ts` (missing) |
| 4 | In-memory lock | ✅ | `ws/lock.ts` |
| 5 | Event bus + admin feed | ❌ **LEFT** | `core/bus.ts`, `ws/admin-feed.ts` (missing) |
| 6 | `contract/ws-events.ts` | ✅ | present |

📋 "Done when":
| Condition | Status |
|-----------|--------|
| Message reaches an online tile in <1s | ❌ needs `message.new` + delivery |
| Offline messages queue and flush in order | ❌ |
| Reopened group shows history + queued | 🟡 claim snapshot exists; queue/delivery missing |
| A second browser is refused | ✅ (the lock — demo step 6) |
| Admin feed updates live | ❌ |

**What's LEFT for Person 3:**
1. **Presence + delivery + offline queue** (`core/presence.ts`, `core/delivery.ts`) — deliver to online tiles, queue for offline, flush in order.
2. **Event bus + admin feed** (`core/bus.ts`, `ws/admin-feed.ts`) — live admin log + live free/locked status.
3. **Session message handlers** — `message.send`→inbound, `tile.presence`→flush, `chat.read`→read, `tile.autoreply`; emit `message.new`, `queue.flush`, `message.status`.
4. **Group reconnect** — deliver queued + fire late statuses on reopen.
5. **E2E tests** for demo step **4 (offline queue)** and **5 (close & reopen)**.
6. **Merge into develop** (replacing P1's interim-delivery stub with the real engine).

**Done (the foundation):** WebSocket server, heartbeat, session roles, one-browser
lock, event contract, dev groups + tests → **demo step 6 (lock) ready.**

---

## Demo script (PRD §10) — coverage

| # | Demo step | Owner | Status |
|---|-----------|-------|--------|
| 1 | Register numbers + groups | P2 | ✅ |
| 2 | Point wat-backend at the mock (env + seed) | P2 | ✅ (env ✅; seed done manually, script still skeleton) |
| 3 | Send → sent/delivered/read, Comdove gets all 3 | P1+P3 | 🟡 P1 side ✅; live tile delivery needs P3 |
| 4 | Offline queue | P3 | ❌ |
| 5 | Close & reopen restores history + queued | P3 | ❌ |
| 6 | Second tab → locked | P3 | ✅ |
| 7 | Reply from a tile → Comdove gets signed inbound | P1+P3 | ✅ (proven live via `/api/inject`; tile UI pending) |
| 8 | Keyword auto-reply bot | P2 | ✅ logic (needs delivery trigger for the full loop) |
| 9 | Bad token → Meta error | P1 | ✅ |
| 10 | Reset → messages clear, numbers/groups remain | P2 | ✅ |

---

## What remains for a full working demo

1. **Person 3** finishes the live engine (items 1–5 above) and merges to develop.
2. **Person 2** finishes the seed script (Task 6) + UI fixtures (Task 7).
3. **UI team** builds the client grid + admin page against the contract (`src/contract/`, `docs/UI-API-GUIDE.md`).
4. **Integration:** swap P1's interim-delivery for P3's real engine; reconcile shared files (`api-types.ts`, `index.ts`).

## Is this from the plan?
Yes. Every task number + "Done when" line above is quoted from **`TEAM-SPLIT.md`**
(the agreed plan), which itself traces to **`docs/BACKEND-BUILD-PLAN.md`** and the two
source PDFs. The ✅/🟡/❌ marks were verified by inspecting the actual pushed branches
(`feature/meta-scope`, `feature/person2-data-core`, `feature_live_engine`) and by the
live test against the real wat-backend on 2026-09-19.
