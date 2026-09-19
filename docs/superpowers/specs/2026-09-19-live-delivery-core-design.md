# Live Delivery Core (real groups, bus, delivery) — Design

**Owner:** Person 3 (live engine) · **Date:** 2026-09-19 · **Status:** draft for review
**Builds on:** `2026-09-19-ws-events-contract-design.md`, `2026-09-19-ws-server-lock-heartbeat-design.md` (both merged, PR #4)
**Source of truth:** `docs/BACKEND-BUILD-PLAN.md` §11c, §13a–§13c, §14; `TEAM-SPLIT.md` (Person 3 + interfaces)
**Covers:** FR-04 (< 1 s to an online tile), FR-05 (offline queue, reconnect part), FR-09 (launch list free/locked), FR-14, FR-17, FR-18 (queued delivered on reopen), FR-10 trigger. **Checkpoint ①.**

## 1. Goal

Replace the interim stand-ins in `develop` with Person 3's real live engine, so that:

- a message Comdove sends reaches the open tile over `/ws` as `message.new` in under 1 s, and only
  then fires the `delivered` webhook;
- a message to a tile whose group is **not open** (or whose flag is off) stays queued;
- opening (claiming) a group shows its full history + queued messages from SQLite and delivers
  the queue (delivered webhooks fire, ticks update);
- status changes (`delivered`, `read`) show as ticks in the tile;
- inbound messages (inject, auto-reply) appear in the open tile;
- the launch list (`GET /api/groups`) shows the real free/locked state.

## 2. What exists in `develop` today (and gets replaced)

| Today | Owner | Replaced by |
|---|---|---|
| `src/dev/interim-delivery.ts` — "online" = tile flag only, no session check | P1 (temporary) | `src/core/delivery.ts` |
| Log-only default bus in `src/compose.ts` | P1 (temporary) | `src/core/bus.ts` |
| `isLocked = () => false` / `lockedSince = () => null` in `src/core/registry.ts` | P2 (placeholder) | `src/ws/shared-lock.ts` |
| In-memory `alpha`/`beta` groups behind `/ws` (`src/dev/dev-groups.ts`) | P3 | `src/ws/store-groups.ts` (P2's SQLite store). `dev-groups.ts` stays for unit tests. |

## 3. Decisions

| # | Decision | Why |
|---|---|---|
| D1 | **Effectively online = group claimed by an open session AND tile flag on** (plan §13a). No session → queued. | The spec rule. The interim delivery ignored the session because none existed. |
| D2 | One **process-wide lock** `sharedLock` in `src/ws/shared-lock.ts`; `registry.ts` reads it. | P2's placeholder comment asks for exactly this import; the DB is a process singleton too. |
| D3 | A **`SessionIndex`** (groupId → session) is filled by two new optional session hooks, `onClaim` / `onRelease`. | Bus and delivery must find "the socket that holds this tile's group" without the session knowing about them. |
| D4 | On claim, queued messages of online tiles are **in the snapshot's `queued`** and then marked delivered (`lifecycle.delivered`); **no `queue.flush`** is sent. | The snapshot already carries them; a flush would show them twice. Ticks arrive as `message.status`. `queue.flush` stays for "tile comes back online" (next step). |
| D5 | Snapshot `history` = all messages **except** the queued ones; both oldest first. `unread` = outbound, delivered, not read, per peer display number. | No duplicates between `history` and `queued`. |
| D6 | Outbound bubbles are pushed by **delivery** (`message.new`, then `delivered`); inbound bubbles by the **bus** (P1's `message.new` event). | P1's lifecycle emits `message.new` only for inbound; delivery owns the outbound push and its order (bubble before the delivered tick). |
| D7 | `log.changed` and `webhook.verify` bus events are **ignored** here. | They feed the admin feed — next spec. |
| D8 | The auto-reply trigger moves into delivery unchanged (P2's `computeReply`, after `delay_ms`, only if the tile is **still effectively online**). | Same behaviour as the interim, plus the session check. |
| D9 | `composeServer()` builds the live engine and returns it; `index.ts` calls `live.attach(server)`. If a caller passes its own `bus` (tests), events go to **both**. | Keeps one boot path for the app and the integrated tests. |
| D10 | `src/dev/interim-delivery.ts` is **deleted**. | Its own header says "replaced at P3 integration". Nothing else imports it. |

## 4. Components

### 4a. `src/ws/shared-lock.ts`
`export const sharedLock = createLockTable();` — used by the WebSocket server and read by
`registry.ts` (`isLocked`, `lockedSince`), so `GET /api/groups`, `GET /api/customers` and
`DELETE /api/groups/:id` (409 while claimed) see the real state.

### 4b. `src/ws/session.ts` (change)
`SessionDeps` gains `onClaim?(session, groupId)` — called after `group.claimed` is sent — and
`onRelease?(session, groupId)` — called on close after the lock is released.

### 4c. `src/ws/session-index.ts`
`createSessionIndex(): { add(groupId, session), remove(groupId, session), get(groupId) }`.
`remove` only removes if that exact session is the one stored.

### 4d. `src/ws/wire.ts`
`statusOf(m)` (`read` > `delivered` > `sent`) and `toWsMessage(m): WsMessage` —
`peer` = business display number (`from_number` for outbound, `to_number` for inbound).
Pure; no DB.

### 4e. `src/ws/store-groups.ts`
`storeGroups: GroupDirectory` on P2's store:
- `exists(id)` → `listGroups()` has it.
- `snapshot(id)` → `{ group:{id,name}, business_numbers:[{phone_number_id, display_number, label}] (no token), tiles }`,
  tiles in `position` order: `{ number, label, online (flag), auto_reply (getAutoReply, default manual/0/[]), history, queued, unread }` per D5.

### 4f. `src/core/delivery.ts` — implements P1's `Delivery` port
```ts
createLiveDelivery(deps: {
  sessions: SessionIndex;
  getCustomer(number): Customer | null;         // sqliteRegistry.getCustomer (online: boolean)
  listGroupTiles(groupId): { number: string }[]; // P2
  queuedFor(number): StoredMessage[];            // P2, per conversation in seq order
  delivered(msgs): void;                         // P1 lifecycle.delivered
  inbound(from, to, body, 'autoreply'): unknown; // P1 lifecycle.inbound
  computeReply(number, body): {reply, delay_ms} | null; // P2
  log?(line): void;
}): Delivery & { isOnline(number): boolean; deliverQueued(groupId): void }
```
- `deliver(m)`: outbound + effectively online → send `message.new {to: customer, number: customer, message}`
  to the session, then `delivered([m])`, then the auto-reply trigger → `'delivered'`. Otherwise `'queued'`.
- `deliverQueued(groupId)`: for each online tile of a claimed group, `delivered(queuedFor(tile))`
  (P1 sorts and de-duplicates), then the auto-reply trigger for each.

### 4g. `src/core/bus.ts` — implements P1's `Bus` port
- `message.new` (inbound) → `message.new {to: business display number, number: customer, message}` to the session of the customer's group.
- `message.new` (outbound) → nothing (delivery pushes it).
- `message.status` → `message.status {wamid, number, status, at}` to that session.
- `log.changed`, `webhook.verify` → nothing yet.
- Logs `[bus] …` lines like today's default bus.

### 4h. `src/live.ts`
`createLiveEngine({ lifecycle: () => Lifecycle | undefined, log?, lock = sharedLock, groups = storeGroups })`
→ `{ bus, delivery, sessions, attach(http, {heartbeatMs?}) }`. `attach` calls `attachWsServer` with
`onClaim = (s, g) => { sessions.add(g, s); delivery.deliverQueued(g) }` and
`onRelease = (s, g) => sessions.remove(g, s)`.

### 4i. Wiring
- `src/compose.ts`: build the live engine (late-bound lifecycle, as today); bus = live bus (tee with `o.bus` if given); delivery = live delivery; return `live`.
- `src/index.ts`: `live.attach(server, { heartbeatMs: env.WS_HEARTBEAT_MS })`.
- `src/core/registry.ts`: the two placeholders read `sharedLock`.

## 5. Data flow

```
Comdove POST /{pnid}/messages → P1 validate → store ('sent') → 200 {wamid} → P1 'sent' webhook
  └─ on response finish: delivery.deliver(msg)
       ├─ group claimed AND flag on → WS message.new → lifecycle.delivered → 'delivered' webhook
       │                               └─ bus message.status → WS message.status (tick)
       │                               └─ auto-reply (P2 computeReply) after delay → lifecycle.inbound
       │                                    └─ bus message.new (inbound) → WS message.new
       └─ otherwise → stays queued
Browser group.claim → snapshot (history + queued) → onClaim → deliverQueued
       → lifecycle.delivered(queued of online tiles) → 'delivered' webhooks + WS message.status
```

## 6. Changes to other people's files (announce in the PR)

| File | Owner | Change |
|---|---|---|
| `src/compose.ts` | P1 | Live engine instead of interim delivery + log bus; returns `live` |
| `src/dev/interim-delivery.ts` | P1 | Deleted |
| `src/core/registry.ts` | P2 | Placeholders read `sharedLock` (2 lines + import) |
| `test/e2e/integrated.e2e.test.ts` | P1 | Attaches `/ws` and claims `alpha` before each test, closes after — delivery now needs an open group (D1). Assertions unchanged. |

## 7. Error handling

- Bus/delivery never throw into P1's lifecycle: a missing customer or session means "not
  online" / "nothing to push".
- Auto-reply failures (e.g. business deleted meanwhile) are caught and logged, as in the interim.
- `storeGroups.snapshot` for an unknown id throws; the session only calls it after `exists`.

## 8. Testing

| File | Kind | Cases |
|---|---|---|
| `test/ws/wire.test.ts` | unit | peer + status for outbound/inbound, read beats delivered (3) |
| `test/ws/session.test.ts` | unit (+1) | `onClaim` after `group.claimed`; `onRelease` on close; not called for refused claims |
| `test/core/delivery.test.ts` | unit, fakes | online push + delivered; flag off; group not claimed; unknown customer; auto-reply fires; auto-reply dropped when offline meanwhile; `deliverQueued` only online tiles; no session → nothing (8) |
| `test/core/bus.test.ts` | unit, fakes | status → session; inbound new → session with business `to`; outbound new ignored; no session / unknown customer / admin events → nothing (5) |
| `test/ws/store-groups.test.ts` | unit, in-memory SQLite | snapshot shape, business numbers without token, tile order, history vs queued, unread per peer, default auto-reply, `exists`; `/api/groups` status via `sharedLock` (4) |
| `test/e2e/live.e2e.test.ts` | integration: `composeServer` + fake Comdove + real `/ws` | online tile gets `message.new` < 1 s then `delivered` tick + webhooks; closed group queues 2 messages → reopen shows them in `queued` and delivers in order; flag-off tile queues; inject shows in the open tile; `/api/groups` locked while open (5) |
| `test/e2e/ws.e2e.test.ts` | E2E (update) | Seeds the business number + groups through `/api/*` after boot (groups now come from SQLite) |
| `test/e2e/integrated.e2e.test.ts` | E2E (update) | See §6 |

`npm test`, `npm run typecheck`, `npm run build` must pass.

## 9. Out of scope (next spec)

Presence (`tile.presence`, `/api/presence` live effect + `queue.flush`), the 4 group-event
handlers (`message.send`, `chat.read`, `tile.presence`, `tile.autoreply`), the admin feed
(`log.changed` → `log.entry`/`log.update`, `groups.update` on lock change, route TODOs), the
reset hook.

## 10. Done when

- All tests pass; typecheck and build clean.
- With `npm run fake-comdove` + `npm run dev`: register a number + group via `/api`, open the group
  over `/ws`, send from Comdove (curl) → the tile gets `message.new` at once and the fake Comdove logs
  `sent` then `delivered`. Close the socket, send again → only `sent`; reopen → the message is in
  `queued` and `delivered` fires.
