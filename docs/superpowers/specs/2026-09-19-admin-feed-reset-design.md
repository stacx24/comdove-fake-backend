# Admin Feed and Reset Hook — Design

**Owner:** Person 3 (live engine) · **Date:** 2026-09-19 · **Status:** draft for review
**Builds on:** `develop` at `15b643e` (PR #4 contract + lock, PR #5 live delivery core, PR #6 tile actions by Person 1)
**Source of truth:** `docs/BACKEND-BUILD-PLAN.md` §10c (reset), §11b, §12 (admin feed); contract `src/contract/ws-events.ts`
**Covers:** FR-09 (launch list live), FR-11 (live admin log), FR-12 (reset, demo step 10). **Completes checkpoint ②.**

## 1. Goal

The last Person 3 work in the live engine:

1. **Admin feed:**
   - A socket that sends `admin.subscribe` receives the current group and number lists straight away.
   - It then receives every change live: `log.entry` / `log.update`, `groups.update`, `numbers.update`, `webhook.verify` and `log.reset`.
2. **Reset hook:** after `/api/reset`:
   - Admins receive `log.reset` and fresh lists.
   - Each open tab receives a fresh snapshot (numbers kept), or `error group_deleted` and is closed (numbers wiped).

When this is done, the three remaining `TODO(Person 3)` markers (`groups.route.ts`, `numbers.route.ts`, `system.route.ts`) are gone.

## 2. Decisions

| # | Decision | Why |
|---|---|---|
| D1 | On `admin.subscribe` the socket immediately gets `groups.update` and `numbers.update`. It loads the log history itself with `GET /api/log` (plan §12). | The admin page and the launch page can render from the socket without a second request. The log can be long, so it stays a pull. |
| D2 | `log.changed {wamid}` (Person 1's bus event) becomes `log.entry` the **first** time the feed announces that wamid, and `log.update` after that. The wamids announced so far are cleared on reset. The UI should **upsert by wamid** for both events. | The contract has both events. An admin who joins mid-flight may get a `log.entry` for a message that already appeared in `GET /api/log`, and upserting makes that harmless. |
| D3 | With **no admin connected**, `log.changed` does no database lookup. | The feed costs nothing when unused. |
| D4 | Group-list and number-list broadcasts: **lock change** (claim or release) → both lists (claim status appears in both); **group create/delete** → both; **business number register/delete** → numbers; **presence or auto-reply change** → numbers; **reset** → `log.reset`, then both. | Every field in `GET /api/groups` / `GET /api/customers` stays live. |
| D5 | Control-API routes reach the live engine through two new `services` hooks: `adminChanged(what)` and `afterReset(keepNumbers)`. | This is the existing pattern (`services.presence`, `autoReplyChanged`): Person 2's routes never import the live engine. |
| D6 | Reset that **keeps** numbers: each open tab gets a new `group.claimed` snapshot (empty history) and keeps its lock. Reset that **wipes** numbers: each tab gets `error {code:'group_deleted'}`, its lock is released **at once**, then its socket is closed (code 4000). | Plan §10c step 3/4. Releasing synchronously means a test or UI can recreate and reclaim the group immediately. |
| D7 | Rejected Meta requests (`direction:'rejected'`, no wamid) are **not** pushed live. They still appear in `GET /api/log`. | They have no bus event, and `LogEntryDTO` in Person 2's `api-types.ts` has no rejected shape. Adding one is a contract change for the team to decide later. |

## 3. Components

### 3a. `src/ws/session.ts` (change)
- `SessionDeps.onAdminSubscribe?(session)`: called when a socket becomes an admin feed.
- `SessionDeps.onAdminClose?(session)`: called when an admin-feed socket closes.
- `SessionSocket.close?(code, reason)`: the real `ws` socket already has it.
- `Session.disconnect?()`: `close()` (releases the lock and fires `onRelease`), then `socket.close(4000, 'closed by server')`. It is optional, so existing test fakes still compile.

### 3b. `src/ws/session-index.ts` (change)
`all(): Array<[groupId, Session]>`, returned as a copy, so a reset can close sessions while it iterates.

### 3c. `src/ws/admin-feed.ts` (new)
`createAdminFeed({ getLogEntry, listGroups, listBusinessNumbers, listCustomers })` →
`{ subscribe, unsubscribe, size, logChanged, groupsChanged, numbersChanged, lockChanged, verify, reset }`.
It reads data only through the injected readers (no SQLite import), so unit tests use fakes.

### 3d. `src/core/bus.ts` (change)
`LiveBusDeps.admin?: Pick<AdminFeed, 'logChanged' | 'verify'>`:
- `log.changed` → `admin.logChanged(wamid)`.
- `webhook.verify` → `admin.verify(...)`.

### 3e. `src/live.ts` (change)
- Build the admin feed on Person 2's readers. Two casts are needed: `LogEntry` from `messages.ts`, and `CustomerListItem` from `listCustomers()`, whose types are wider than the DTOs.
- Pass the feed to the bus.
- Wrap `setOnline` / `setAutoReply` for group events so they also call `numbersChanged()`.
- Hooks:
  - `onClaim` / `onRelease` also call `lockChanged()`.
  - `onAdminSubscribe` / `onAdminClose` go to the feed.
- New members:
  - `admin`
  - `adminChanged(what)`: `groups` → both lists, `numbers` → numbers.
  - `reset(keepNumbers)` (D6).

### 3f. Wiring
| File | Owner | Change |
|---|---|---|
| `src/core/services.ts` | shared | + `adminChanged?`, `afterReset?` |
| `src/compose.ts` | P1 | `services.adminChanged = live.adminChanged`, `services.afterReset = live.reset`; `autoReplyChanged` also refreshes numbers |
| `src/api/groups.route.ts` | P2 | create/delete → `services.adminChanged?.('groups')`; TODO removed |
| `src/api/numbers.route.ts` | P2 | register/delete → `services.adminChanged?.('numbers')`; TODO removed |
| `src/api/system.route.ts` | P2 | after `resetAll` → `services.afterReset?.(keep)`; TODO removed |
| `test/e2e/ws.e2e.test.ts` | P3 | E2E-3 reads the two initial lists after `admin.subscribe` (D1) |

## 4. Data flow

```
admin.subscribe ─► session role=admin ─► onAdminSubscribe ─► feed.subscribe ─► groups.update + numbers.update (to that socket)
P1 lifecycle / dispatcher ─► bus log.changed ─► feed.logChanged ─► getLogEntry ─► log.entry | log.update (all admins)
P1 verify ─► bus webhook.verify ─► feed.verify ─► webhook.verify
claim / close ─► onClaim / onRelease ─► feed.lockChanged ─► groups.update + numbers.update
/api/groups, /api/business-numbers ─► services.adminChanged ─► lists
/api/presence, tile.presence, auto-reply ─► setOnline / setAutoReply wrappers ─► numbers.update
/api/reset ─► cancel webhooks ─► resetAll ─► services.afterReset
      ├─► feed.reset ─► log.reset + lists
      └─► each open tab: kept → group.claimed (fresh)   wiped → error group_deleted + disconnect
```

## 5. Error handling

- An unknown wamid in `log.changed` (for example, a late webhook after a reset) is ignored.
- `disconnect` is idempotent with the socket's own later `close` event (`session.close()` runs once).
- The feed never throws into Person 1's lifecycle, and a socket that is not open is skipped by `session.send`.

## 6. Testing

| File | Kind | Cases |
|---|---|---|
| `test/ws/session.test.ts` | unit (+2) | admin hooks (subscribe/close, never for group sockets); `disconnect` releases the lock at once, then closes the socket |
| `test/ws/session-index.test.ts` | unit (+1) | `all()` |
| `test/ws/admin-feed.test.ts` | unit, fakes (6) | subscribe sends the lists to that socket only; entry then update to every admin; no admins → no lookup, unknown wamid ignored; unsubscribe + `lockChanged`; `verify`; `reset` clears the announced wamids |
| `test/core/bus.test.ts` | unit (±) | old "ignored" test replaced by: admin events → feed, not tiles; no feed → dropped quietly (+1 net) |
| `test/e2e/admin.e2e.test.ts` | integration (8) | initial lists; live log sent→delivered with webhook results; tile reply as inbound entry; claim/close live; control-API changes (group, number, presence); `webhook.verify`; reset keep (log.reset, fresh snapshot, lock kept); reset wipe (group_deleted, socket closed, lock free) |
| `test/e2e/ws.e2e.test.ts` | E2E (update) | E2E-3 reads the initial lists |

Start: 221. End: **239**. `npm run typecheck` and `npm run build` must stay clean.

## 7. Done when

- All tests pass (3 runs); typecheck and build are clean; `grep -rn "TODO(Person 3)" src` returns nothing.
- Manual check: an admin socket (`admin.subscribe`) on the dev server shows `groups.update`/`numbers.update`, then `log.entry` → `log.update` for a Comdove send, `groups.update` locked/free as a tab opens and closes, and `log.reset` on `POST /api/reset`.
