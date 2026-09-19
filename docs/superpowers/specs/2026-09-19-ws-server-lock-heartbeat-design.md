# WebSocket Server, Session Lock and Heartbeat — Design

**Owner:** Person 3 (live engine) · **Date:** 2026-09-19 · **Status:** draft for review
**Builds on:** `docs/superpowers/specs/2026-09-19-ws-events-contract-design.md` (step 1, done)
**Source of truth for behaviour:** `docs/BACKEND-BUILD-PLAN.md` §11, §11d, §13a and `TEAM-SPLIT.md` (Person 3).
**Covers:** FR-16 (one session per group, lock released on disconnect or missed heartbeat), plus the
socket-role rules in plan §11a.

## 1. Goal

Stand up `/ws` so that, **without any code from Person 1 or Person 2**:

- a browser (or `wscat`) can connect, send frames, and get a typed `error` for bad ones;
- the first socket to `group.claim` a group gets it; a second one gets `group.locked`;
- closing the socket, or missing a heartbeat pong, frees the group;
- a socket has exactly one role: **group session** or **admin feed**.

This is demo step 6 (lock). It is the skeleton that steps 5–10 plug into.

## 2. Scope

**In:** the socket server, frame parsing, socket roles, `group.claim` end to end, the in-memory lock,
the 15 s heartbeat, wiring into `src/index.ts`, and an in-memory group list for development.

**Out (later specs):** the other 4 group events (`message.send`, `tile.presence`, `chat.read`,
`tile.autoreply`), the bus and routing of server events, admin broadcasts (`groups.update` etc.),
presence, delivery and the queue, the reset hook, and the real Person 2 data behind the snapshot.
This spec only leaves the hooks for them (§5c, §4 `onChange`).

## 3. Decisions

| # | Decision | Why |
|---|---|---|
| D1 | Every module takes its dependencies as parameters (`createX(deps)`), never imports Person 1/2 code. | Person 1 already uses this style (`createLifecycle(deps)`). Fakes in tests and dev; real code plugged in at checkpoint ①. |
| D2 | Group data comes through a small **`GroupDirectory`** port (`exists`, `snapshot`). This spec ships an in-memory one for dev and tests. | The claim flow works now; Person 2's store implements the same port later. |
| D3 | The lock is a plain in-memory `Map`, empty on boot, never in SQLite. | Plan §13a / TEAM-SPLIT shared rule: a crash must not wedge a group. |
| D4 | The lock **owner** is an opaque object (the session), not a socket id string. | `release` only succeeds for the owner, so a late `close` from an old socket can never free a newer session's lock. |
| D5 | Heartbeat uses WebSocket protocol ping/pong (`ws.ping()` / `'pong'`), not a JSON event. | Browsers answer protocol pings automatically; no UI code needed. Matches plan §11d. |
| D6 | Heartbeat interval and `now()` are injectable (default 15000 ms and `Date.now`). | Tests run the heartbeat at ~50 ms instead of waiting 30 s. |
| D7 | `maxPayload` = 64 KiB. Binary frames are rejected with `bad_json`. | A text frame with a 4096-char body fits easily; bigger frames are abuse. The contract is JSON text only. |
| D8 | A socket's role is set by its first successful `group.claim` or `admin.subscribe` and never changes. | Plan §11: "One group per socket". Keeps sessions simple. |

## 4. `src/ws/lock.ts` — the lock table

```ts
export type ClaimResult = { ok: true; since: number } | { ok: false; since: number };

export interface LockTable {
  claim(groupId: string, owner: object): ClaimResult;   // free → take it; held → ok:false + holder's since
  release(groupId: string, owner: object): boolean;     // only the owner can release; true if released
  isLocked(groupId: string): boolean;
  lockedSince(groupId: string): number | null;
}

export function createLockTable(opts?: {
  now?: () => number;
  onChange?: (groupId: string) => void;   // called after every claim/release that changes state
}): LockTable;
```

Rules:
- `claim` on a free group stores `{ owner, since: now() }`, calls `onChange`, returns `{ok:true, since}`.
- `claim` on a held group (by anyone, including the same owner) returns `{ok:false, since}` of the
  current holder and changes nothing.
- `release` by a non-owner, or on a free group, returns `false` and changes nothing.
- `onChange` is the hook the bus will use to broadcast `groups.update` (later spec). Default: no-op.
- `isLocked` / `lockedSince` are what Person 2's `registry.ts` placeholders will import.

## 5. `src/ws/session.ts` — one socket's state and the claim flow

(The build plan calls this file `group-session.ts`; it is named `session.ts` here because it also
handles the admin role.)

### 5a. Ports

```ts
import type { ClientEvent, ServerEvent, AdminEvent, Snapshot } from '../contract/ws-events.js';

export interface GroupDirectory {
  exists(groupId: string): boolean;
  snapshot(groupId: string): Snapshot;       // everything the grid needs (contract §5)
}

export interface SessionDeps {
  lock: LockTable;
  groups: GroupDirectory;
  // Later specs: the other 4 group events. Default: ignore.
  onGroupEvent?: (session: Session, ev: Exclude<ClientEvent, { type: 'group.claim' | 'admin.subscribe' }>) => void;
}
```

### 5b. Session

```ts
export type Role = { kind: 'none' } | { kind: 'group'; groupId: string } | { kind: 'admin' };

export interface Session {
  readonly role: Role;
  send(ev: ServerEvent | AdminEvent): void;    // encodeEvent + socket.send, skipped if socket not open
  handle(ev: ClientEvent): void;               // role rules + claim flow
  close(): void;                               // called on socket close: releases the lock if held
}

export function createSession(socket: { send(data: string): void; readyState: number }, deps: SessionDeps): Session;
```

### 5c. Rules for each event

| Event | Role `none` | Role `group` | Role `admin` |
|---|---|---|---|
| `group.claim {group}` | see 5d | `error already_claimed` | `error already_claimed` |
| `admin.subscribe` | role → `admin` (no reply in this spec; broadcasts come later) | `error already_claimed` | `error already_claimed` |
| `message.send`, `tile.presence`, `chat.read`, `tile.autoreply` | `error not_claimed` | passed to `deps.onGroupEvent` | `error not_claimed` |

### 5d. Claim flow (`group.claim {group}` on a `none` socket)

1. `groups.exists(group)` is false → `error {code:'unknown_group', message:'unknown group: <id>'}`. Role stays `none`.
2. `lock.claim(group, session)`:
   - `ok:false` → send `group.locked {group, since}`. Role stays `none`, so the client may retry
     another group on the same socket.
   - `ok:true` → role = `group`, send `group.claimed` with `groups.snapshot(group)` spread in.
3. (Later spec: deliver queued messages for online tiles right after the snapshot.)

### 5e. Close

`close()` → if role is `group`, `lock.release(groupId, session)`. Idempotent: calling it twice does
nothing the second time.

## 6. `src/ws/server.ts` — the socket server and heartbeat

```ts
import type { Server } from 'node:http';

export interface WsServerDeps extends SessionDeps {
  heartbeatMs?: number;                   // default 15000
}

export interface WsServer {
  close(): Promise<void>;                 // stop heartbeat, terminate clients, close the server
  sessionCount(): number;                 // for tests and /api/status later
}

export function attachWsServer(http: Server, deps: WsServerDeps): WsServer;
```

Behaviour:
- `new WebSocketServer({ server: http, path: '/ws', maxPayload: 65536 })`. Other paths are not upgraded.
- On `connection`: create a `Session`; mark the socket alive; listen for `pong` → alive again.
- On `message (data, isBinary)`:
  - `isBinary` → `error bad_json` ("binary frames are not supported").
  - Otherwise turn `data` into one `Buffer` (it can be `Buffer`, `ArrayBuffer` or `Buffer[]`),
    `parseClientEvent(buf)`; `ok:false` → send `error {code, message}`; `ok:true` → `session.handle(event)`.
  - Any exception thrown by a handler is caught, logged, and answered with
    `error {code:'bad_request', message:'internal error'}`; the socket stays open.
- On `close` or `error`: `session.close()` (releases the lock).
- Heartbeat, every `heartbeatMs`: for each client, if it has not ponged since the last tick →
  `terminate()` (this fires `close` → lock released); else mark not-alive and `ping()`.
  So a dead client is dropped after at most two intervals (≤ 30 s at the default), as plan §11d says.
- `close()` clears the interval, terminates all clients, and closes the `WebSocketServer`.

## 7. Dev wiring

### 7a. `src/dev/dev-groups.ts`

An in-memory `GroupDirectory` for `npm run dev` and tests until Person 2's store is plugged in:

```ts
export function createMemoryGroups(groups: Record<string, { name: string; tiles?: string[] }>): GroupDirectory;
export const DEV_GROUPS = { alpha: { name: 'Alpha', tiles: ['919876543210', '919876543211'] },
                            beta:  { name: 'Beta',  tiles: ['919876543220'] } };
```

`snapshot(id)` returns `{ group: {id, name}, business_numbers: [], tiles }` where each tile is
`{ number, label: null, online: true, auto_reply: {mode:'manual', delay_ms:0, rules:[]}, history: [], queued: [], unread: {} }`.

### 7b. `src/index.ts`

Keep the `http.Server` that `app.listen` returns and attach the socket server to it:

```ts
const server = app.listen(PORT, () => { ... });
attachWsServer(server, { lock: createLockTable(), groups: createMemoryGroups(DEV_GROUPS) });
```

This is the only change to `index.ts`. At checkpoint ①, `createMemoryGroups` is replaced by the
Person 2-backed directory, and the lock instance is shared with Person 2's registry.

## 8. Error handling summary

| Situation | Reply | Socket |
|---|---|---|
| Not JSON / not an object / binary frame | `error bad_json` | stays open |
| Missing type or bad field | `error bad_request` | stays open |
| Unknown type | `error unknown_type` | stays open |
| Group action before claim, or on an admin socket | `error not_claimed` | stays open |
| Second claim / subscribe on the same socket | `error already_claimed` | stays open |
| Claim of a group that does not exist | `error unknown_group` | stays open |
| Claim of a held group | `group.locked {group, since}` | stays open |
| Frame > 64 KiB | closed by `ws` with code 1009 | closed, lock released |
| Handler throws | `error bad_request` "internal error" (logged) | stays open |
| No pong within one interval | — | terminated, lock released |

## 9. Testing (`node:test`, no new dependencies)

**`test/ws/lock.test.ts`** (unit, fake `now`):
1. claim a free group → `ok:true`, `isLocked` true, `lockedSince` = now.
2. second claim by another owner → `ok:false` with the first `since`; holder unchanged.
3. same owner claims again → `ok:false`, nothing changes.
4. release by a non-owner → `false`, still locked.
5. release by the owner → `true`, `isLocked` false, `lockedSince` null.
6. `onChange` called once per real change (claim, release), not for refused calls.

**`test/ws/session.test.ts`** (unit, fake socket that records sent frames, memory groups):
1. claim a known free group → `group.claimed` with the snapshot; role = group.
2. claim an unknown group → `unknown_group`; role stays none.
3. claim a held group → `group.locked` with the holder's `since`; role stays none.
4. second claim on a group socket → `already_claimed`.
5. `admin.subscribe` → role admin; then `group.claim` → `already_claimed`.
6. each of the 4 group events before claim → `not_claimed`; on an admin socket → `not_claimed`.
7. on a group socket, a group event reaches `onGroupEvent`.
8. `close()` releases the lock; a second `close()` does nothing.

**`test/ws/server.test.ts`** (integration: real HTTP server on port 0, `ws` clients):
1. bad frame (`"not json"`) → `error bad_json`, socket still open.
2. two clients claim `alpha` → first gets `group.claimed`, second `group.locked`.
3. first client closes → second client's retry of `alpha` gets `group.claimed`.
4. heartbeat (`heartbeatMs: 50`): a client created with `autoPong: false` is terminated and its
   lock freed (a new client can claim the group) within ~150 ms; a normal client stays connected.
5. `close()` resolves and `sessionCount()` is 0.

`npm run build` must pass. Manual check: `npm run dev`, then two `wscat -c ws://localhost:4020/ws`
sessions sending `{"type":"group.claim","group":"alpha"}`.

## 10. Hand-off to later steps

- **Bus / admin feed:** passes `onChange` to `createLockTable` to broadcast `groups.update`;
  gets the admin sockets from sessions with role `admin`.
- **Group handlers:** implement `onGroupEvent`.
- **Person 2:** imports `isLocked` / `lockedSince` from the shared `LockTable` instance instead of
  its `() => false` placeholders; implements `GroupDirectory` on its store.
- **Reset hook:** will need "all sessions of group X", added with the bus.

## 11. Done when

- `npm test` passes (existing 28 + the new lock, session and server tests); `npm run build` passes.
- With `npm run dev`: two `wscat` sessions on `alpha` → the second gets `group.locked`; closing the
  first lets the second claim; killing a client frees the group within 30 s.
