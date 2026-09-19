# Person 1 — The Meta Face: Implementation Plan

> **Goal:** Comdove (wat-backend) sends text messages to this mock exactly as it does to
> `graph.facebook.com`, gets Meta's exact success and error JSON back, and receives signed,
> ordered, retried webhooks (inbound, sent, delivered, read) that its real verification and
> pipeline accept.
>
> **Scope:** `TEAM-SPLIT.md` → Person 1 · `docs/BACKEND-BUILD-PLAN.md` §7, §8, §9, §13, §17.
> **Owns:** `src/meta/`, `src/webhooks/`, `src/core/lifecycle.ts`, `tools/fake-comdove.ts`.
> **Covers:** FR-02, FR-03, FR-06, FR-07, FR-08, FR-18 (statuses). Demo steps 3, 7, 9.

**Approach:**
- Every module takes its collaborators as arguments (dependency injection), so it can be
  built and tested **today**, before Person 2 (store) or Person 3 (WebSocket) exist.
- Stubs live in `test/stubs/`. At checkpoint ① they are swapped for the real modules in
  `src/index.ts`, and nothing else changes.
- Each task is test-first: write the failing test, run it and see it fail, write the
  smallest code that passes, run it and see it pass, commit.

**Tech:**
- Node 22 (`fetch`, `AbortSignal.timeout`, `node:test` are all built in).
- Express 5, TypeScript, `tsx`, `node:crypto`.
- **No new runtime dependencies** for P1. The only SQLite code (the job store, Task 10)
  uses P2's `better-sqlite3`.

---

## 0. What must be byte-exact (checked against wat-backend source)

| wat-backend code | What it requires from us |
|---|---|
| `src/utils/webhook-signature.ts` `verifyMetaSignature` | Header `x-hub-signature-256` = `sha256=` + **hex** HMAC-SHA256 of the **exact raw body bytes**, key = `META_APP_SECRET`. Compared with `timingSafeEqual`, so length must match |
| `src/middleware/raw-body.ts` | Body parsed with `express.json` → send `Content-Type: application/json` |
| `src/routes/webhook-whatsapp.ts:12-40` | Handshake: `hub.mode=subscribe` + matching `hub.verify_token` → 200 text/plain challenge, else 403 |
| `webhook-whatsapp.ts:74-96` | Stores the raw payload using `entry[0].id` (waba) + `changes[0].field`; returns **503** if its DB insert fails → we retry |
| `src/workers/process-event.ts:172-176` | `field=messages` + `value.messages[]` → inbound; `value.statuses[]` → status |
| `process-event.ts:214-229` | Inbound resolved by `value.metadata.phone_number_id` → must exist in Comdove DB |
| `process-event.ts` `processOneStatus` | Status resolved by `statuses[].id` (wamid) → unknown = **permanent** error, so never send a status before Comdove saved the wamid |
| `src/services/meta-graph.client.ts:520-548` `sendTextMessage` | Sends `{messaging_product, to, type:'text', text:{body}}` — **no** `recipient_type`, **no** `preview_url`; reads `messages[0].id` |
| `meta-graph.client.ts:856-872` `readMetaError` | Reads `error.code` (number), `message`, `type`, `fbtrace_id`, `error_subcode` (number), `error_data` |
| `src/lib/meta-graph.ts:27` | URL = `{BASE}/{META_GRAPH_API_VERSION}/{path}` — the version is always the first segment |

Keep `test/helpers/verify-meta-signature.ts` as a **verbatim copy** of wat-backend's
`verifyMetaSignature`. It is the oracle every signing test checks against.

---

## 1. Architecture

```
                 ┌──────────────── src/meta/ ───────────────────┐
Comdove ──POST──►│ messages.route.ts                            │
 /vNN.N/{pnid}/  │   ├─ force-error? (errors.ts)                 │
 messages        │   ├─ validate.ts  (pure: req → Send|Read|Err)  │
                 │   ├─ responses.ts (success JSON, ids.ts)       │
                 │   └─ calls ──► lifecycle.accept(...)           │
                 │ not-implemented.ts (catch-all, mounted last)   │
                 └──────────────────────┬─────────────────────────┘
                                        ▼
                 ┌──────────── src/core/lifecycle.ts ───────────┐
                 │ accept / delivered / read / inbound / markInboundRead
                 │ uses: Registry (P2) · Bus (P3) · Dispatcher    │
                 └──────────────────────┬─────────────────────────┘
                                        ▼
                 ┌──────────────── src/webhooks/ ────────────────┐
                 │ envelopes.ts → JSON string (serialized ONCE)   │
                 │ sign.ts      → sha256=<hex>                    │
                 │ dispatcher.ts: per-conversation FIFO, notBefore,│
                 │   5s timeout, 1+3 retries (1s/5s/15s), attempts │
                 │ job-store.ts: memory (tests) + sqlite (real)    │
                 │ verify.ts: hub.challenge handshake             │
                 └──────────────────────┬─────────────────────────┘
                                        ▼  signed POST
                                     Comdove  (or tools/fake-comdove.ts)
```

### 1a. Ports (agree with P2/P3 in the first 30 min → `src/core/ports.ts`)

TEAM-SPLIT lists the base interfaces. P1 needs these **exact** shapes. The items marked
➕ are **additions** P1 must ask P2 or P3 for.

```ts
// src/core/ports.ts
export interface BusinessNumber { phone_number_id: string; display_number: string; label: string | null; token: string; waba_id: string }
export interface Customer { number: string; group_id: string; label: string | null; online: boolean }
export type Direction = 'outbound' | 'inbound';
export type Source = 'api' | 'tile' | 'inject' | 'autoreply';
export interface StoredMessage {
  wamid: string; conversation_id: number; seq: number;
  direction: Direction; source: Source;
  phone_number_id: string;          // business side of the conversation
  customer_number: string;          // customer side
  from_number: string; to_number: string; body: string;
  created_at: number; sent_at: number | null; delivered_at: number | null; read_at: number | null;
}
export interface NewMessage { wamid: string; direction: Direction; source: Source; phone_number_id: string; customer_number: string; body: string; at: number }

// P2 — Registry
export interface Registry {
  getBusiness(phoneNumberIdOrDisplay: string): BusinessNumber | null;
  getCustomer(number: string): Customer | null;
  storeMessage(m: NewMessage): StoredMessage;                 // sets sent_at=at for outbound
  getMessage(wamid: string): StoredMessage | null;            // ➕
  setDelivered(wamids: string[], at: number): void;
  setRead(wamids: string[], at: number): void;
  unreadDelivered(customer: string, phoneNumberId: string): StoredMessage[]; // ➕ outbound, delivered, not read, by seq
  logRejected(r: RejectedRequest): void;                       // ➕ admin log row for Meta errors
}
export interface RejectedRequest { at: number; phone_number_id: string; http_status: number; code: number; subcode?: number; forced: boolean; to?: string; body?: string }

// P3 — Bus + delivery
export interface Bus { emit(e: BusEvent): void }
export type BusEvent =
  | { type: 'message.new'; message: StoredMessage }
  | { type: 'message.status'; wamid: string; number: string; status: 'sent' | 'delivered' | 'read'; at: number }
  | { type: 'log.changed'; wamid: string }                     // P3 turns this into log.entry / log.update
  | { type: 'webhook.verify'; ok: boolean; at: number; detail: string };
export interface Delivery { deliver(m: StoredMessage): 'delivered' | 'queued' }
```

The ➕ items are small store queries. If P2 disagrees on names, adapt `ports.ts` — only
`lifecycle.ts` and the route touch them.

### 1b. Key rules (from BACKEND-BUILD-PLAN)
- **Validation order:** force-error → unknown pnid (400/100/33) → token (401/190) → JSON +
  product (100) → send-or-read (100) → text/body/to (100) → recipient (131026).
- **One status per webhook.** `entry[].id` = the business number's `waba_id`.
  `timestamp` = Unix seconds as a string.
- **FIFO per `conversation_id`.** The first status job of an outbound message gets
  `notBefore = acceptedAt + STATUS_WEBHOOK_DELAY_MS` (default 500 ms). Since the queue is
  FIFO, later jobs wait behind it automatically.
- **Success = HTTP 200 only.** 5 s timeout. Retry delays `[1000, 5000, 15000]` (4 attempts
  in total), then `failed` and move on.
- **Mark-as-read:** `{success:true}`, sets `read_at` on the **inbound** message, emits
  `message.status`, and sends **no webhook**.

---

## 2. File map

| File | Responsibility |
|---|---|
| `src/core/ports.ts` | shared interfaces above (agreed with P2/P3) |
| `src/meta/ids.ts` | `newWamid()`, `nextTraceId()`, `normalizeNumber()` |
| `src/meta/errors.ts` | error catalogue, `metaError(kind, ctx)`, `parseForceError(header)` |
| `src/meta/validate.ts` | pure validation → `{kind:'send'}` / `{kind:'read'}` / `{kind:'error'}` |
| `src/meta/responses.ts` | `sendSuccess(input, wamid)`, `READ_SUCCESS` |
| `src/meta/messages.route.ts` | `createMetaRouter(deps)`: parse, validate, call lifecycle, respond |
| `src/meta/not-implemented.ts` | catch-all Meta 400 + JSON-parse error handler |
| `src/webhooks/sign.ts` | `sign(raw, secret)` |
| `src/webhooks/envelopes.ts` | `inboundEnvelope(...)`, `statusEnvelope(...)` → objects |
| `src/webhooks/job-store.ts` | `JobStore` interface + `MemoryJobStore` + `SqliteJobStore` |
| `src/webhooks/dispatcher.ts` | `createDispatcher(opts)`: enqueue, FIFO, retry, cancelAll, resume |
| `src/webhooks/verify.ts` | `runHandshake(url, token, fetchImpl?)` |
| `src/core/lifecycle.ts` | `createLifecycle(deps)`: accept / delivered / read / inbound / markInboundRead |
| `tools/fake-comdove.ts` | receiver for local testing |
| `test/helpers/verify-meta-signature.ts` | verbatim copy of wat-backend's verifier (oracle) |
| `test/helpers/http.ts` | start an express app on port 0, `fetch` helper |
| `test/stubs/*.ts` | in-memory Registry, Bus, Delivery |
| `test/**/*.test.ts` | one test file per module |

---

## 3. Tasks

### Task 0 — Tooling (15 min)

- [ ] Add scripts to `package.json`:
  ```json
  "test": "node --import tsx --test \"test/**/*.test.ts\"",
  "test:watch": "node --import tsx --test --watch \"test/**/*.test.ts\"",
  "fake-comdove": "tsx tools/fake-comdove.ts"
  ```
- [ ] Add `STATUS_WEBHOOK_DELAY_MS=500` to `.env.example` (coordinate with P2, who owns `env.ts`).
- [ ] Create `test/helpers/verify-meta-signature.ts` (copy of wat-backend's
      `src/utils/webhook-signature.ts`, with a comment naming the source).
- [ ] Create `test/helpers/http.ts`:
  ```ts
  import express from 'express';
  import type { AddressInfo } from 'node:net';
  export async function listen(app: express.Express) {
    const server = app.listen(0);
    await new Promise<void>((r) => server.once('listening', () => r()));
    const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    return { base, close: () => new Promise<void>((r) => server.close(() => r())) };
  }
  ```
- [ ] `npm test` → "0 tests" with exit 0. Commit: `chore(p1): test runner + helpers`.

### Task 1 — `ports.ts` + stubs (30 min, during the team freeze)

- [ ] Write `src/core/ports.ts` from §1a; share it with P2/P3.
- [ ] `test/stubs/registry.ts`: a `MemoryRegistry implements Registry`, backed by arrays.
      Seed helper: `seed({business:[...], customers:[...]})`. `storeMessage` assigns a
      `conversation_id` per (pnid, customer) and increments `seq`.
- [ ] `test/stubs/bus.ts`: `RecordingBus` with `events: BusEvent[]`.
- [ ] `test/stubs/delivery.ts`: `FakeDelivery` with `mode: 'online' | 'offline'` and `calls[]`.
- [ ] Commit: `feat(p1): ports + in-memory stubs`.

### Task 2 — `ids.ts` (15 min)

**Test first** `test/meta/ids.test.ts`:
```ts
test('wamid format', () => assert.match(newWamid(), /^wamid\.MOCK-[0-9a-f]{24}$/));
test('wamids unique', () => assert.equal(new Set(Array.from({length:1000}, newWamid)).size, 1000));
test('trace ids', () => { assert.match(nextTraceId(), /^MOCK-trace-\d{6}$/); assert.notEqual(nextTraceId(), nextTraceId()); });
test('normalize', () => {
  assert.equal(normalizeNumber('+91 98765-43210'), '919876543210');
  assert.equal(normalizeNumber('12ab'), null);          // non-digits after stripping → invalid
  assert.equal(normalizeNumber('1234567'), null);       // < 8 digits
});
```
**Implement:** `crypto.randomBytes(12).toString('hex')`. The counter is padded to 6 digits.
`normalizeNumber` strips `+`, spaces and `-`, then requires `^\d{8,15}$`.
Commit: `feat(p1): wamid, trace id, number normalization`.

### Task 3 — `errors.ts` (30 min)

Catalogue (Spec §4 + plan §8):

| kind | http | code | subcode | message |
|---|---|---|---|---|
| `unknown_object` | 400 | 100 | 33 | `Unsupported post request. Object with ID '{id}' does not exist, cannot be loaded due to missing permissions, or does not support this operation` |
| `invalid_token` | 401 | 190 | – | `Invalid OAuth access token - Cannot parse access token` |
| `invalid_param` | 400 | 100 | – | `(#100) {detail}` (default detail `Invalid parameter`) |
| `not_implemented` | 400 | 100 | – | `(#100) {METHOD} {path} is not implemented in comdove-mock` |
| `undeliverable` | 400 | 131026 | – | `(#131026) Message undeliverable` + `error_data.details` |
| `rate_limit` | 400 | 130429 | – | `(#130429) Rate limit hit` |

All have `type: "OAuthException"`, `fbtrace_id`, and
`error_data: {messaging_product:"whatsapp", details}` when there are details.

**Test first** `test/meta/errors.test.ts`:
- each kind → exact `status`, `body.error.code`, `error_subcode` present **only** for
  `unknown_object`, `fbtrace_id` matches `/^MOCK-trace-/`.
- `undeliverable` body deep-equals the Spec §4 example (except `fbtrace_id`).
- `parseForceError('190')` → `invalid_token`; `'33'` → `unknown_object`;
  `'131026'`, `'130429'`, `'100'` map to their kinds; `'999'` / `'abc'` → `{kind:'invalid_param', detail:'unsupported X-Mock-Force-Error value'}`;
  `undefined` → `null`.
- **Oracle test:** simulate wat-backend's `readMetaError` on the body → `code`,
  `error_subcode`, `type`, `fbtrace_id` all have the right types (numbers stay numbers).

**Implement:** `metaError(kind, ctx?: {id?, detail?, method?, path?}) → { status, body }`.
Commit: `feat(p1): Meta error catalogue + force-error parsing`.

### Task 4 — `validate.ts` (45 min)

Signature (pure — no Express, no I/O):
```ts
type Input = { phoneNumberId: string; auth?: string; forceError?: string; body: unknown };
type Result =
  | { kind: 'send'; business: BusinessNumber; to: string /* as sent */; waId: string; text: string }
  | { kind: 'read'; business: BusinessNumber; messageId: string }
  | { kind: 'error'; error: ReturnType<typeof metaError>; forced: boolean };
export function validate(input: Input, reg: Pick<Registry,'getBusiness'|'getCustomer'|'getMessage'>): Result
```

**Tests first** (`test/meta/validate.test.ts`). Seed business `MOCK-PN-1` with token `t1`
and customer `919876543210`. One case per row:

| # | Input | Expect |
|---|---|---|
| 1 | force `130429` + everything else wrong | error `130429`, `forced:true` (step 0 wins) |
| 2 | pnid `NOPE` + bad token | `unknown_object` 400/100/33 (step 1 before 2) |
| 3 | no `Authorization` | 401/190 |
| 4 | `Bearer wrong` | 401/190 |
| 5 | `bearer t1` (lowercase scheme) | accepted (scheme is case-insensitive) |
| 6 | body `undefined` (non-JSON) | 400/100 |
| 7 | `messaging_product: 'sms'` | 400/100 |
| 8 | neither `type` nor `status` | 400/100 |
| 9 | `type: 'image'` | 400/100, message contains `not implemented in comdove-mock` |
| 10 | `text.body` missing / `''` / 4097 chars / not a string | 400/100 each |
| 11 | `to` missing | 400/100 |
| 12 | `to: '919999999999'` (not a customer) | 400/131026 |
| 13 | `to: '+91 98765 43210'` | send, `to` as sent, `waId` `919876543210` |
| 14 | wat-backend's exact payload (no `recipient_type`, no `preview_url`) | send |
| 15 | full Spec §3 payload | send |
| 16 | read: `{status:'read', message_id}` for an inbound msg to this business | read |
| 17 | read: unknown id / outbound id / inbound to another business | 400/100 |

Run → all fail. Implement → all pass. Commit: `feat(p1): Meta request validation pipeline`.

### Task 5 — `responses.ts` (10 min)

**Test:** `sendSuccess('+91 98765 43210', '919876543210', 'wamid.MOCK-x')` deep-equals
`{messaging_product:'whatsapp', contacts:[{input:'+91 98765 43210', wa_id:'919876543210'}], messages:[{id:'wamid.MOCK-x'}]}`.
`READ_SUCCESS` = `{success:true}`.
Commit: `feat(p1): Meta success shapes`.

### Task 6 — `sign.ts` + `envelopes.ts` (30 min)

**Tests first:**
- `sign(raw, 'mock-app-secret-1')` starts with `sha256=` + 64 hex chars, and the **oracle**
  `verifyMetaSignature(Buffer.from(raw), header, secret)` returns `true`. It returns `false`
  with a different secret, and `false` if one byte of `raw` changes.
- Unicode body (`'héllo 👋'`): sign the UTF-8 bytes; the oracle passes.
- `inboundEnvelope({business, customer, message})` deep-equals Spec §5 inbound, with:
  `entry[0].id === business.waba_id`, `metadata.display_phone_number === business.display_number`,
  `metadata.phone_number_id === business.phone_number_id`, `profile.name === customer.label ?? 'Tile {number}'`,
  `timestamp === String(Math.floor(created_at/1000))`, `type: 'text'`.
- `statusEnvelope({business, wamid, status, at, recipient})` deep-equals Spec §5 status —
  one entry in `statuses`, no `conversation` or `pricing` keys.

**Implement:** `sign = (raw: string|Buffer, secret) => 'sha256=' + createHmac('sha256', secret).update(raw).digest('hex')`.
Envelopes return plain objects. The **dispatcher** serializes once (Task 8).
Commit: `feat(p1): webhook signing + Meta envelopes`.

### Task 7 — `job-store.ts` (memory first) (30 min)

```ts
export type JobKind = 'inbound' | 'sent' | 'delivered' | 'read';
export interface Job { id: number; conversation_id: number; wamid: string; kind: JobKind; payload: string; not_before: number; state: 'pending'|'ok'|'failed'; created_at: number; finished_at: number | null }
export interface Attempt { job_id: number; attempt: number; http_status: number | null; error: string | null; duration_ms: number; at: number }
export interface JobStore {
  insert(j: Omit<Job,'id'|'state'|'finished_at'>): Job;
  addAttempt(a: Attempt): void;
  finish(id: number, state: 'ok'|'failed', at: number): void;
  pending(): Job[];                 // ordered by id — for resume
  attempts(jobId: number): Attempt[];
  clear(): void;                    // reset
}
```
`not_before` is kept in memory only. On the SQLite side it's not a column: on resume every
pending job is eligible now, so the SQL store returns `not_before: 0`.

**Tests:** insert → pending → finish → not pending; attempts stored in order; clear empties.
Run the **same test suite** against `SqliteJobStore` in Task 10.
Commit: `feat(p1): webhook job store (memory)`.

### Task 8 — `dispatcher.ts` (the hard one, 1.5–2 h)

```ts
export function createDispatcher(o: {
  url: string; secret: string; store: JobStore;
  retryDelaysMs?: number[];        // default [1000, 5000, 15000]
  timeoutMs?: number;              // default 5000
  fetchImpl?: typeof fetch;        // default global fetch
  now?: () => number;
  onChange?: (job: Job) => void;   // → bus 'log.changed'
}): {
  enqueue(j: { conversation_id: number; wamid: string; kind: JobKind; body: object; notBefore?: number }): Job;
  cancelAll(): void;               // reset: abort in-flight, clear timers + queues
  resume(): void;                  // boot: re-queue store.pending() in id order
  idle(): Promise<void>;           // tests: resolves when every queue is empty
}
```

**Algorithm:**
- `queues: Map<conversation_id, Job[]>` and `running: Set<conversation_id>`.
- `enqueue`:
  1. `raw = JSON.stringify(body)` (the only serialization).
  2. `store.insert(...)`.
  3. Push onto that conversation's queue, then `pump(cid)`.
- `pump(cid)`: if the conversation is running or its queue is empty, return. Otherwise
  mark it running and call `runHead(cid)`.
- `runHead(cid)`:
  1. `job = queue[0]`.
  2. Wait `max(0, job.not_before - now())`.
  3. For `attempt` 1..4:
     - POST `raw` with headers `Content-Type: application/json` and
       `X-Hub-Signature-256: sign(raw)`, `signal = AbortSignal.any([AbortSignal.timeout(timeoutMs), cancelCtl.signal])`.
     - Record the attempt and call `onChange`.
     - `res.status === 200` → `finish(ok)` and stop.
     - Otherwise, if more attempts are left, sleep `retryDelaysMs[attempt-1]`.
     - After the 4th failure → `finish(failed)`.
  4. `queue.shift()`, clear the running flag, `pump(cid)`.
- All sleeps go through a cancellable `sleep(ms, signal)`. `cancelAll()` aborts the shared
  controller, clears the maps and creates a new controller.

**Tests first** (`test/webhooks/dispatcher.test.ts`). Use a real in-process receiver built
on `node:http` (the `listen` helper). Use tiny delays: `retryDelaysMs: [10, 20, 30]`,
`timeoutMs: 100`.

| # | Scenario | Assert |
|---|---|---|
| 1 | receiver 200 | 1 request; oracle signature valid; body bytes === stored payload; `Content-Type` json; job `ok`; 1 attempt `http_status 200` |
| 2 | receiver 500, 500, 200 | 3 attempts, job `ok`, attempts `[500,500,200]` |
| 3 | receiver always 503 | exactly **4** attempts, job `failed`, next job in the same conversation **then runs** |
| 4 | receiver 201 | treated as failure (only 200 counts) |
| 5 | receiver hangs > timeout | attempt `error:'timeout'`, `http_status:null`, retried |
| 6 | receiver down (closed port) | attempt `error` set (ECONNREFUSED), retried |
| 7 | FIFO: conv A = [sent(fails once), delivered], conv B = [inbound] | A's delivered arrives **after** A's sent succeeds; B is **not** blocked by A (B arrives first) |
| 8 | `notBefore = now+80ms` on A's sent, A's delivered enqueued right after | receiver sees sent at ≥80 ms, then delivered |
| 9 | retries resend identical bytes | every attempt's body and signature are identical |
| 10 | `cancelAll()` during backoff | no further requests; `idle()` resolves |
| 11 | `resume()` with 2 pending jobs in the store | both sent, in id order |
| 12 | `onChange` called for every attempt and every finish | count matches |

Commit: `feat(p1): webhook dispatcher — FIFO, delay, retries, cancel, resume`.

### Task 9 — `lifecycle.ts` (1 h)

```ts
export function createLifecycle(d: {
  registry: Registry; bus: Bus; dispatcher: Pick<Dispatcher,'enqueue'>;
  statusDelayMs: number; now?: () => number;
}) {
  accept(business, to, waId, text): StoredMessage;          // store outbound + 'sent' job (notBefore = now+delay)
  delivered(msgs: StoredMessage[]): void;                   // seq order: setDelivered, 'delivered' job, emit status + log
  read(customer: string, peer: string): void;               // unreadDelivered → setRead, 'read' jobs, emit
  inbound(from: string, to: string, body: string, source): StoredMessage; // store inbound, emit message.new + log, 'inbound' job
  markInboundRead(business, wamid): void;                   // setRead, emit message.status 'read', NO job
}
```

Rules:
- `peer` and `to` accept a display number **or** a phone_number_id (`registry.getBusiness`).
- `delivered` / `read` skip messages already in that state (idempotent).
- `inbound` validates that `from` is a customer and `to` is a business, and throws a typed
  `LifecycleError` otherwise (P3 turns it into a WS `error`, P2 into a 4xx).

**Tests** (stub registry + recording bus + fake dispatcher that records `enqueue` calls):
- `accept` → 1 outbound stored with `sent_at`; 1 `sent` job with `notBefore = now+500`;
  body = `statusEnvelope(status:'sent', recipient: waId)`; bus `log.changed`.
- `delivered([m2, m1])` → jobs in **seq** order (m1, m2); `message.status` ×2; calling it
  again → no new jobs.
- `read(customer, display)` → only delivered-and-unread messages get `read` jobs; the
  phone_number_id form of `peer` also works.
- `inbound` → envelope with the right `waba_id` / `phone_number_id`, `message.new` emitted,
  `inbound` job has no `notBefore`; unknown `from` or `to` → `LifecycleError`.
- `markInboundRead` → `read_at` set, `message.status` emitted, **no** enqueue.

Commit: `feat(p1): message lifecycle state machine`.

### Task 10 — `SqliteJobStore` (30 min, needs P2's schema)

- [ ] Implement it against the `webhook_jobs` / `webhook_attempts` tables from
      BACKEND-BUILD-PLAN §6 (a P2 migration), using P2's `db` handle.
- [ ] Run the **Task 7 test suite** against an in-memory SQLite (`new Database(':memory:')`
      + schema). Must pass unchanged.

Until P2 lands the schema, keep using `MemoryJobStore`. Mark this task blocked on P2.
Commit: `feat(p1): sqlite webhook job store`.

### Task 11 — `messages.route.ts` + `not-implemented.ts` (1 h)

```ts
export function createMetaRouter(d: { registry: Registry; lifecycle: Lifecycle; delivery: Delivery; now?: () => number }): express.Router
export function metaNotImplemented(): express.RequestHandler            // mounted LAST
export function metaJsonErrorHandler(): express.ErrorRequestHandler    // body-parse errors → Meta 400/100
```

Route: `router.post('/:version/:phoneNumberId/messages', express.json({limit:'1mb'}), handler)`.
- `version` must match `^v\d+\.\d+$`, else `next()`, so the request falls through to
  not-implemented.
- Handler:
  1. `validate(...)`.
  2. On `error`: `registry.logRejected(...)` and `res.status(e.status).json(e.body)`.
  3. On `send`:
     - `msg = lifecycle.accept(...)`.
     - `res.status(200).json(sendSuccess(...))`.
     - **then** `setImmediate(() => delivery.deliver(msg))`, so the response goes out first.
  4. On `read`: `lifecycle.markInboundRead(...)` and `res.json(READ_SUCCESS)`.

**Tests** (supertest-style with `listen()` + `fetch`, all stubs):
- Happy path with wat-backend's exact payload → 200, exact body shape, `delivery.calls`
  has the message **after** the response.
- Any version works (`/v21.0/`, `/v23.0/`, `/v99.9/`). `/latest/MOCK-PN-1/messages` →
  not-implemented 400/100.
- Malformed JSON body → 400/100 Meta envelope (not Express's HTML).
- Wrong token → 401/190 **and** `logRejected` called; `X-Mock-Force-Error: 130429` → 400/130429,
  `forced:true`, nothing stored.
- `GET /v23.0/123/message_templates`, `POST /v23.0/123/media`,
  `POST /v23.0/waba/subscribed_apps` → 400/100 `not implemented in comdove-mock`, and the
  message names the method and path.
- Mark-as-read → `{success:true}`, no dispatcher enqueue.
- **Mount-order test:** an app with a dummy `/api/ping` and `/health` mounted before the
  Meta router → both still reachable.

Commit: `feat(p1): Meta send endpoint + not-implemented catch-all`.

### Task 12 — `verify.ts` (20 min)

```ts
export async function runHandshake(url: string, verifyToken: string, fetchImpl = fetch):
  Promise<{ ok: boolean; at: number; detail: string }>
```
- GET with `hub.mode=subscribe`, `hub.verify_token`, and `hub.challenge` = 10 random digits.
- Pass only if the status is 200 **and** the trimmed body equals the challenge.
- **Never throws.** Network errors return `{ok:false, detail:'ECONNREFUSED ...'}`.
- 5 s timeout.

**Tests:** echoing receiver → ok; receiver answers 403 → `ok:false, detail:'403'`; receiver
echoes the wrong value → `ok:false`; closed port → `ok:false` and no throw; the query
string contains all three params, URL-encoded.
Commit: `feat(p1): webhook verify handshake`.

### Task 13 — `tools/fake-comdove.ts` (30 min)

- Express on `FAKE_COMDOVE_PORT` (default **3100**, so it doesn't clash with a real
  wat-backend on 3000). Route `/webhooks/whatsapp`:
  - **GET:** the same logic as wat-backend (verify token from `WEBHOOK_VERIFY_TOKEN`).
  - **POST:** the raw body is captured exactly like wat-backend's `raw-body.ts`, the
    signature is checked with the copied oracle, and the result is printed:
    `✔ 200 statuses delivered wamid.MOCK-… (conv 3)` or `✘ 401 bad signature`.
- **Failure knobs** (query or env): `FAIL_NEXT=3` → return 503 for the next 3 POSTs;
  `SLOW_MS=6000` → delay the response (tests the timeout).
- `GET /_received` returns every payload received, for e2e tests.

Run it: `npm run fake-comdove`, and set the mock's `COMDOVE_WEBHOOK_URL=http://localhost:3100/webhooks/whatsapp`.
Commit: `feat(p1): fake Comdove receiver for local testing`.

### Task 14 — Wire into `src/index.ts` (30 min, with P2)

Order matters:
```ts
app.get('/health', ...);                       // existing
app.use('/api', controlRouter);                // P2 (stub: none yet)
app.post('/reset', ...);                       // P2
app.use(createMetaRouter({ registry, lifecycle, delivery }));   // P1
app.use(metaJsonErrorHandler());               // P1
app.use(metaNotImplemented());                 // P1 — LAST
// ws upgrade is on the http server, not an express route (P3)
dispatcher.resume();
void runHandshake(env.COMDOVE_WEBHOOK_URL, env.WEBHOOK_VERIFY_TOKEN)
  .then(r => { bus.emit({ type:'webhook.verify', ...r }); console.log(r.ok ? '🤝 handshake ok' : `⚠️ handshake failed: ${r.detail}`); });
```
- Until checkpoint ①, `registry` / `bus` / `delivery` come from `test/stubs`, behind
  `MOCK_STUBS=1` or a `src/dev-stubs.ts`. That's enough to curl the endpoint for real.
- Export `{ lifecycle, dispatcher, runHandshake }` from a `src/meta-face.ts` barrel so P2
  (`inject`, reset `cancelAll`, `/api/webhook/verify`) and P3 (`delivered`, `read`,
  `inbound`) import one thing.

Commit: `feat(p1): wire Meta face into boot`.

### Task 15 — End-to-end test + checkpoint ① (45 min)

`test/e2e/meta-face.e2e.test.ts`: the real app (stubs for P2/P3) + an in-process fake Comdove.
1. Register the stub business `MOCK-PN-1` / `waba W1` / token `t1` and customer `919876543210`.
2. POST wat-backend's exact payload → 200 with a wamid.
3. Stub delivery = online → `lifecycle.delivered` is called.
4. The fake Comdove receives **`sent`**, then **`delivered`**, in order. The first status
   arrives ≥ `STATUS_WEBHOOK_DELAY_MS` after the 200. Signatures are valid (oracle).
   `entry[0].id === 'W1'`.
5. `lifecycle.read('919876543210','MOCK-PN-1')` → **`read`** arrives third.
6. `lifecycle.inbound(...)` → an inbound envelope arrives, correctly signed.
7. Bad token → 401/190 envelope.

**Checkpoint ① with the team:**
- Swap the stubs for P2's store and P3's delivery.
- curl a send → it shows in `wscat` (P3) → fake Comdove gets `sent` + `delivered` → `/api/log`
  shows the attempts (P2).

### Task 16 — Real wat-backend smoke (demo steps 3, 7, 9)

Preconditions:
- wat-backend `.env`: `META_GRAPH_API_BASE_URL=http://localhost:4020`, matching
  `META_APP_SECRET` / `WHATSAPP_VERIFY_TOKEN`, `ALLOW_LOCAL_TEST=false`, local DB.
- P2's seed has run.

| Check | Expect |
|---|---|
| Mock boot log | `🤝 handshake ok` (wat-backend answered the challenge) |
| Send from Comdove UI to an online tile | Comdove `WaMessage` gets the `wamid.MOCK-…`; status moves sent → delivered → read; no `UNKNOWN_WAMID` in wat-backend logs |
| Reply from a tile | wat-backend logs `webhook.received`, no `webhook.signature_invalid`; the message shows in Comdove's inbox |
| Set a wrong token in Comdove's DB and send | Comdove raises `MetaApiError` with `metaCode 190` and shows the error |
| Stop wat-backend, send, restart it within 20 s | attempts 1–2 fail, a later retry gets 200; log shows the attempts |

If `UNKNOWN_WAMID` still appears, raise `STATUS_WEBHOOK_DELAY_MS` (e.g. 1500). wat-backend
processes webhooks asynchronously, so its worker lag can exceed 500 ms under load.

---

## 4. Order, time, dependencies

| # | Task | Est. | Blocked by |
|---|---|---|---|
| 0 | Tooling | 15 m | – |
| 1 | Ports + stubs | 30 m | team freeze |
| 2 | ids | 15 m | – |
| 3 | errors | 30 m | – |
| 4 | validate | 45 m | 1, 2, 3 |
| 5 | responses | 10 m | – |
| 6 | sign + envelopes | 30 m | 1 |
| 7 | job store (memory) | 30 m | – |
| 8 | dispatcher | 1.5–2 h | 6, 7 |
| 9 | lifecycle | 1 h | 1, 6, 8 |
| 11 | route + not-implemented | 1 h | 4, 5, 9 |
| 12 | verify | 20 m | – |
| 13 | fake Comdove | 30 m | 6 (oracle) |
| 14 | wiring | 30 m | 11, 12 |
| 15 | e2e + checkpoint ① | 45 m | 13, 14 |
| 10 | sqlite job store | 30 m | **P2 schema** |
| 16 | real wat-backend smoke | 30 m | **P2 seed**, 15 |

**Critical path:** 0 → 1 → 6 → 7 → 8 → 9 → 11 → 14 → 15, about **7 h**.
**Fits the checkpoints:**
- **Hour 3:** tasks 0–7 + 11 happy path (curl works, `sent` fires).
- **Hour 5:** 8–15 (retries, FIFO, delay, errors, handshake).
- **Final:** 10 + 16.

**If behind schedule, cut in this order:** restart `resume()` → mark-as-read →
`SLOW_MS` knob. **Never** cut: FIFO, status delay, byte-exact signing, the error set.
Those are what make Comdove accept the mock.

---

## 5. Definition of done (Person 1)

- [ ] `npm test` is green: unit tests for ids, errors, validate, responses, sign, envelopes,
      job store (memory + sqlite), dispatcher, lifecycle, route, verify, and the e2e test.
- [ ] Every signature passes the verbatim wat-backend oracle.
- [ ] Comdove's real send gets Meta's exact 200. A bad token gets 401/190. Unknown pnid →
      400/100/33. Unregistered `to` → 131026. `X-Mock-Force-Error: 130429` works.
- [ ] Any other Graph path → 400/100 "not implemented in comdove-mock".
- [ ] wat-backend receives sent → delivered → read in order, and a signed inbound, with no
      `UNKNOWN_WAMID` or `signature_invalid` in its logs.
- [ ] A 503 from Comdove produces 4 attempts, visible in `/api/log`. A dead Comdove
      doesn't block other conversations.
- [ ] Handshake result is logged on boot, and boot never fails because Comdove is down.
- [ ] `lifecycle`, `dispatcher.cancelAll`, `runHandshake` are exported for P2/P3.

## 6. Things to tell P2 / P3 at the freeze

1. **P2:**
   - Please add the ➕ registry methods: `getMessage`, `unreadDelivered`, `logRejected`.
   - Put `phone_number_id` + `customer_number` on `StoredMessage`.
   - `storeMessage` sets `sent_at` for outbound.
2. **P2:** reset calls `dispatcher.cancelAll()` **before** deleting the rows, and
   `/api/inject` calls `lifecycle.inbound(..., 'inject')`.
3. **P3:**
   - Call `lifecycle.delivered(msgs)` after every push (live, flush, reconnect snapshot).
   - Call `lifecycle.read(number, peer)` on `chat.read`.
   - Call `lifecycle.inbound(..., 'tile')` on `message.send`.
   - Never build webhooks yourself.
4. **P3:** the bus event `log.changed {wamid}` is emitted by P1 on every job attempt or
   finish. Turn it into `log.update` using P2's log builder.
5. **Everyone:** `LifecycleError` has `{code, message}`. Map it to a WS `error` (P3) or an
   HTTP 4xx (P2).
