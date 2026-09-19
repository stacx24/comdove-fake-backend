# Testing Guide — Person 1 (Meta face)

How to check everything Person 1 built — the Meta send endpoint, Meta errors, signed
webhooks to Comdove, retries — and how it works with Person 2's store/control API and
Person 3's WebSocket (live delivery, tile actions).

Four levels:

1. **Automated tests** — 2 minutes, nothing else running.
2. **Manual tests with a fake Comdove** — safe, never touches the real Comdove.
3. **Live test with the real Comdove** (wat-backend).
4. **Demo step 9 with the real Comdove** — bad token → Comdove handles Meta's error.

> **Key rule (plan §13a):** a message is **delivered** only when the tile's group is
> **open in a browser tab** (claimed over `/ws`) **and** the tile is online. With no tab
> open, Comdove's messages stay queued (`sent` only) and are delivered when the group is
> opened. `npm run tab -- alpha` opens a group from the terminal.

---

## Part 1 — Automated tests

```bash
cd ~/Projects/comdov-mock-backend
npm test            # expect: # tests 221  # pass 221  # fail 0
npm run typecheck   # expect: no output (no errors)
```

One area at a time:

| What it tests | Command |
|---|---|
| Errors and request validation | `node --import tsx --test test/meta/*.test.ts` |
| Signing, webhook sender, retries, handshake | `node --import tsx --test test/webhooks/*.test.ts` |
| Lifecycle, P2 store adapter, P3 delivery/bus | `node --import tsx --test test/core/*.test.ts` |
| Full flows (Meta face + store + WebSocket) | `node --import tsx --test test/e2e/*.test.ts` |
| Tile actions → lifecycle (send, read, presence, auto-reply) | `node --import tsx --test test/e2e/live-events.e2e.test.ts` |

Tests use an in-memory database; they never touch `mock.sqlite`.

---

## Part 2 — Manual tests with the fake Comdove

Use **4 terminals**. This runs on port **4021** with its own database file, so it does
not clash with a mock already running on 4020.

**Terminal 1 — fake Comdove (receives the webhooks, prints one line per webhook)**
```bash
cd ~/Projects/comdov-mock-backend
npm run fake-comdove
```

**Terminal 2 — the mock server**
```bash
cd ~/Projects/comdov-mock-backend
PORT=4021 DB_PATH=./manual-test.sqlite \
COMDOVE_WEBHOOK_URL=http://localhost:3100/webhooks/whatsapp npm run dev
```
✅ Expect `🤝 webhook handshake ok` here, and `🤝 handshake ok` in Terminal 1.

**Terminal 3 — run the tests.** Set up once (run every test below in this same terminal):
```bash
M=http://localhost:4021
curl -s -X POST $M/api/business-numbers -H 'Content-Type: application/json' \
  -d '{"display_number":"918888800001","label":"Sales","phone_number_id":"MOCK-PN-1","waba_id":"MOCK-WABA-1","token":"mock-token-dev"}'; echo
curl -s -X POST $M/api/groups -H 'Content-Type: application/json' \
  -d '{"name":"alpha","numbers":["919876543210","919876543211"]}'; echo
```

**Terminal 4 — a browser tab on group `alpha`** (stand-in for the UI; keep it open)
```bash
cd ~/Projects/comdov-mock-backend
PORT=4021 npm run tab -- alpha
```
✅ `group.claimed alpha: 919876543210(on, …) 919876543211(on, …)`. It prints every event
the server pushes, and sends each JSON line you type (Tests 11–13).

### Test 1 — Health and handshake
```bash
curl -s $M/health; echo
curl -s $M/api/status; echo
curl -s $M/api/groups; echo
```
✅ `"status":"ok"`, `"verify":{"ok":true,...}`, and group `alpha` shows `"status":"locked"`
(Terminal 4 holds it).

### Test 2 — Send a message (Meta success response)
```bash
curl -s -X POST $M/v23.0/MOCK-PN-1/messages \
  -H 'Authorization: Bearer mock-token-dev' -H 'Content-Type: application/json' \
  -d '{"messaging_product":"whatsapp","to":"919876543210","type":"text","text":{"body":"Hello"}}'; echo
```
✅ `{"messaging_product":"whatsapp","contacts":[...],"messages":[{"id":"wamid.MOCK-..."}]}`
✅ Terminal 4: `message.new 919876543210 ⬅ "Hello"`, then `message.status … delivered`.
✅ Terminal 1: `✔ 200 sent` then `✔ 200 delivered` (the first status waits ~0.5 s by design).

### Test 3 — Meta error responses
Run one at a time. The number in `[ ]` is the HTTP status.

```bash
# a) Wrong token → [401], code 190
curl -s -w ' [%{http_code}]\n' -X POST $M/v23.0/MOCK-PN-1/messages \
  -H 'Authorization: Bearer WRONG' -H 'Content-Type: application/json' \
  -d '{"messaging_product":"whatsapp","to":"919876543210","type":"text","text":{"body":"x"}}'

# b) Unknown phone number id → [400], code 100, error_subcode 33
curl -s -w ' [%{http_code}]\n' -X POST $M/v23.0/NOPE/messages \
  -H 'Authorization: Bearer mock-token-dev' -H 'Content-Type: application/json' \
  -d '{"messaging_product":"whatsapp","to":"919876543210","type":"text","text":{"body":"x"}}'

# c) Recipient not registered → [400], code 131026
curl -s -w ' [%{http_code}]\n' -X POST $M/v23.0/MOCK-PN-1/messages \
  -H 'Authorization: Bearer mock-token-dev' -H 'Content-Type: application/json' \
  -d '{"messaging_product":"whatsapp","to":"919999999999","type":"text","text":{"body":"x"}}'

# d) Unsupported type (image) → [400], "not implemented in comdove-mock"
curl -s -w ' [%{http_code}]\n' -X POST $M/v23.0/MOCK-PN-1/messages \
  -H 'Authorization: Bearer mock-token-dev' -H 'Content-Type: application/json' \
  -d '{"messaging_product":"whatsapp","to":"919876543210","type":"image"}'

# e) Forced rate limit → [400], code 130429
curl -s -w ' [%{http_code}]\n' -X POST $M/v23.0/MOCK-PN-1/messages \
  -H 'X-Mock-Force-Error: 130429' -d '{}'

# f) Unsupported Graph path → [400], "GET /v23.0/WABA/message_templates is not implemented in comdove-mock"
curl -s -w ' [%{http_code}]\n' $M/v23.0/WABA/message_templates

# g) Broken JSON → [400], Meta error format (not an HTML page)
curl -s -w ' [%{http_code}]\n' -X POST $M/v23.0/MOCK-PN-1/messages \
  -H 'Authorization: Bearer mock-token-dev' -H 'Content-Type: application/json' -d '{bad'
```
✅ None of these print anything in Terminal 1 (rejected requests send no webhook).

### Test 4 — Customer reply via the control API (signed inbound webhook)
```bash
curl -s -X POST $M/api/inject -H 'Content-Type: application/json' \
  -d '{"from":"919876543210","to":"918888800001","body":"How much?"}'; echo
```
✅ `{"wamid":"wamid.MOCK-..."}`, Terminal 1: `✔ 200 inbound`,
Terminal 4: `message.new 919876543210 ➡ "How much?"`.

### Test 5 — Mark as read by Comdove (no webhook expected)
Step 1 saves the new message's id in `$W`; step 2 uses it. Run both in the same terminal.
```bash
# 1. Customer sends a message; save its id
W=$(curl -s -X POST $M/api/inject -H 'Content-Type: application/json' \
  -d '{"from":"919876543210","to":"918888800001","body":"Test 5 message"}' \
  | sed -E 's/.*"wamid":"([^"]+)".*/\1/')
echo "wamid: $W"

# 2. Comdove marks it read
curl -s -X POST $M/v23.0/MOCK-PN-1/messages \
  -H 'Authorization: Bearer mock-token-dev' -H 'Content-Type: application/json' \
  -d "{\"messaging_product\":\"whatsapp\",\"status\":\"read\",\"message_id\":\"$W\"}"; echo
```
✅ `{"success":true}`. Terminal 1 shows `✔ 200 inbound` for step 1 and **nothing** for step 2
(correct — Meta sends no webhook for a business's own read receipt). Terminal 4 shows
`message.status … read` for the customer's own bubble.

⚠️ Step 2 uses **double quotes** so `$W` is filled in. A `400` with
`"message_id is not an inbound message for this phone number"` means the id was wrong:
a placeholder, an empty `$W` (different terminal), or the id of a message Comdove *sent*.

### Test 6 — Offline tile: queued, then flushed when it comes back online
```bash
curl -s -X POST $M/api/presence -H 'Content-Type: application/json' -d '{"number":"919876543211","online":false}'; echo
curl -s -X POST $M/v23.0/MOCK-PN-1/messages \
  -H 'Authorization: Bearer mock-token-dev' -H 'Content-Type: application/json' \
  -d '{"messaging_product":"whatsapp","to":"919876543211","type":"text","text":{"body":"Are you there?"}}'; echo
```
✅ Terminal 1 shows only `✔ 200 sent` — **no** `delivered`. Terminal 4 shows
`tile.presence … online:false` and no new bubble.
```bash
curl -s -X POST $M/api/presence -H 'Content-Type: application/json' -d '{"number":"919876543211","online":true}'; echo
```
✅ Terminal 4: `queue.flush 919876543211: 1 message(s)`, then `message.status … delivered`.
Terminal 1: `✔ 200 delivered`.

### Test 7 — Retries when Comdove fails
```bash
curl -s -X POST localhost:3100/_control -H 'Content-Type: application/json' -d '{"failNext":3}'; echo
curl -s -X POST $M/v23.0/MOCK-PN-1/messages \
  -H 'Authorization: Bearer mock-token-dev' -H 'Content-Type: application/json' \
  -d '{"messaging_product":"whatsapp","to":"919876543210","type":"text","text":{"body":"retry test"}}'; echo
```
The two commands only print `{"failNext":3,...}` and Meta's success response — the retries
happen **in the background** and take about **21 seconds** (waits of 1 s, 5 s, 15 s).

✅ Terminal 1 over ~21 s:
```
✘ 503 sent   → (1 s) ✘ 503 sent → (5 s) ✘ 503 sent → (15 s) ✔ 200 sent → ✔ 200 delivered
```
✅ After ~25 s, `curl -s "$M/api/log?limit=5"`: the `"retry test"` message's `sent`
webhook lists attempts `503, 503, 503, 200`, and `delivered` waited until `sent` got through.

### Test 8 — Auto-reply bot
```bash
curl -s -X PUT $M/api/customers/919876543210/auto-reply -H 'Content-Type: application/json' \
  -d '{"mode":"keyword","delay_ms":500,"rules":[{"keyword":"price","reply":"What is the price?"}]}'; echo
curl -s -X POST $M/v23.0/MOCK-PN-1/messages \
  -H 'Authorization: Bearer mock-token-dev' -H 'Content-Type: application/json' \
  -d '{"messaging_product":"whatsapp","to":"919876543210","type":"text","text":{"body":"Our price list"}}'; echo
```
✅ Terminal 4: `tile.autoreply … keyword`, the Comdove bubble, then ~0.5 s later
`message.new 919876543210 ➡ "What is the price?"`.
✅ Terminal 1: `sent`, `delivered`, then `✔ 200 inbound` (the bot's reply).

### Test 9 — Admin log
```bash
curl -s "$M/api/log?limit=10"; echo
```
✅ Every message with its status timeline and webhook attempts. The errors from Test 3
appear as `"direction":"rejected"` with their HTTP status and code.

### Test 10 — Reset
```bash
curl -s -X POST $M/reset -H 'Content-Type: application/json' -d '{}'; echo
curl -s $M/api/log; echo                  # expect: []
curl -s $M/api/business-numbers; echo     # expect: still 1 number
```
✅ Messages cleared, numbers and groups kept, pending retries cancelled.

### Test 11 — A tile types a reply (demo step 7, over `/ws`)
Type this line in **Terminal 4**:
```json
{"type":"message.send","from":"919876543210","to":"918888800001","body":"I want 2 units"}
```
✅ Terminal 4: `message.new 919876543210 ➡ "I want 2 units"` (the bubble echoed back).
✅ Terminal 1: `✔ 200 inbound` — the signed inbound webhook Comdove would receive.

### Test 12 — The tile opens the chat → read (demo step 3, last part)
Send Comdove a message first (Test 2), then type in **Terminal 4**:
```json
{"type":"chat.read","number":"919876543210","peer":"918888800001"}
```
✅ Terminal 4: `message.status 919876543210 read …` for every delivered, unread message.
✅ Terminal 1: `✔ 200 read` per message, after its `sent` and `delivered`.

Errors to try (each prints an `error` frame in Terminal 4 and sends nothing):
`{"type":"message.send","from":"919999999999","to":"918888800001","body":"x"}` →
`number_not_in_group`; a `to` that is not a business → `unknown_business`; sending from a
tile you switched off → `tile_offline`.

### Test 13 — Close and reopen the group (demo step 5)
1. Ctrl+C in Terminal 4 (the group is now closed; `curl -s $M/api/groups` shows `free`).
2. Send 2 messages from Comdove (Test 2, twice). Terminal 1: `✔ 200 sent` only — no `delivered`.
3. Reopen: `PORT=4021 npm run tab -- alpha` in Terminal 4.

✅ `group.claimed` shows the 2 messages as `queued` on that tile, then
`message.status … delivered` for each. Terminal 1: `✔ 200 delivered` twice, in send order.
✅ Type the `chat.read` line from Test 12 → `read` for both.

### Test 14 — Live admin feed (admin page over `/ws`)
**Terminal 5 — an admin page** (stand-in for the admin UI; keep it open):
```bash
cd ~/Projects/comdov-mock-backend
node --input-type=module -e '
const { WebSocket } = await import("ws");
const ws = new WebSocket("ws://localhost:4021/ws");
ws.on("open", () => ws.send(JSON.stringify({ type: "admin.subscribe" })));
ws.on("message", (d) => { const f = JSON.parse(String(d));
  const e = f.entry;
  console.log("[admin]", f.type, e ? (e.direction === "rejected" ? `REJECTED ${e.http_status}/${e.code}` : `${e.body} ${e.status}`) : f.groups ? f.groups.map(g => `${g.id}:${g.status}`).join(",") : ""); });'
```
✅ At once: `[admin] groups.update alpha:locked` (Terminal 4 holds it) and `[admin] numbers.update`.

Then, with Terminal 5 open:
1. Send a message from Comdove (Test 2).
   ✅ `[admin] log.entry Hello sent`, then `[admin] log.update Hello delivered` (more `log.update`
   lines follow as each webhook attempt lands).
2. Ctrl+C in Terminal 4. ✅ `[admin] groups.update alpha:free`. Reopen the tab
   (`PORT=4021 npm run tab -- alpha`) → `alpha:locked` again.
3. `curl -s -X POST $M/api/presence -H 'Content-Type: application/json' -d '{"number":"919876543211","online":false}'; echo`
   ✅ `[admin] numbers.update` (the customer now shows `online:false`).
4. `curl -s -X POST $M/api/webhook/verify; echo` ✅ `[admin] webhook.verify`.
5. Send with a wrong token (Test 3a):
   ```bash
   curl -s -o /dev/null -X POST $M/v23.0/MOCK-PN-1/messages -H 'Authorization: Bearer WRONG' \
     -H 'Content-Type: application/json' \
     -d '{"messaging_product":"whatsapp","to":"919876543210","type":"text","text":{"body":"x"}}'
   ```
   ✅ At once: `[admin] log.entry REJECTED 401/190`. Every Test 3 error shows up the same way.

The admin page loads older history itself with `GET $M/api/log`. Live rows:
- a **message** arrives as `log.entry` (first time) and changes as `log.update` — key these rows
  by `wamid`;
- a **rejected Meta request** arrives once as `log.entry` with `direction: "rejected"` and
  **`wamid: null`** (`RejectedLogEntryDTO` in `src/contract/api-types.ts`), the same object
  `GET /api/log` returns. It is never updated — always add it as a new row; do not key it by `wamid`.

### Test 15 — Reset with a tab open (demo step 10)
Keep Terminals 4 and 5 open.
1. Keep numbers: `curl -s -X POST $M/reset -H 'Content-Type: application/json' -d '{}'; echo`
   ✅ Terminal 4: a fresh `group.claimed alpha: …(0 msgs, 0 queued)` — the tab keeps the group.
   ✅ Terminal 5: `[admin] log.reset`, then `groups.update` and `numbers.update`.
2. Wipe numbers: `curl -s -X POST $M/reset -H 'Content-Type: application/json' -d '{"keep_numbers":false}'; echo`
   ✅ Terminal 4: `{"type":"error","code":"group_deleted",…}` then `[tab] closed`.
   ✅ Terminal 5: `[admin] groups.update` with no groups.
   Run the Terminal 3 set-up again before any other test.

### Clean up
Ctrl+C in Terminals 1, 2, 4 and 5, then:
```bash
rm manual-test.sqlite*
```
(no trailing dot — it removes `manual-test.sqlite`, `-shm` and `-wal`; `mock.sqlite` is untouched)

---

## Part 3 — Live test with the real Comdove (wat-backend)

**Prerequisites** (plan §5, §5c):
- wat-backend `.env`: `META_GRAPH_API_BASE_URL=http://localhost:4020`,
  `META_APP_SECRET` = mock `APP_SECRET`, `WHATSAPP_VERIFY_TOKEN` = mock
  `WEBHOOK_VERIFY_TOKEN`, `ALLOW_LOCAL_TEST=false`, `DB_TARGET=local`,
  `WABA_TOKEN_ENCRYPTION_KEY` set.
- The mock (port 4020) has the business number registered (the `business-numbers` call
  from Part 2 with `M=http://localhost:4020`) and a group `alpha` with the customer numbers.
- Comdove's **local** DB knows the same number and token. Copy them there with:
  ```bash
  npm run seed-comdove -- --dry-run   # shows what it will write
  npm run seed-comdove                # upserts WabaAccount + WabaPhoneNumber, verifies the token
  ```
  It uses wat-backend's own Prisma client and `encryptSecret` (checkout at
  `~/Projects/comdov-backend`, or set `COMDOVE_BACKEND_DIR`), picks the database from
  wat-backend's `.env` (`DB_TARGET`), and refuses anything that is not localhost.
  Re-run it whenever you register a new business number or change a token.

| Step | Do this | Check |
|---|---|---|
| 1 | `curl -s localhost:4020/api/status` | `"verify":{"ok":true}` |
| 2 | Open the group: `npm run tab -- alpha` (keep it open) | `group.claimed alpha: …` |
| 3 | In the tab, type `{"type":"message.send","from":"919876543212","to":"918888800001","body":"Hi from customer 3"}` | A new chat appears in the **Comdove inbox** (frontend http://localhost:5173) |
| 4 | Reply to that chat **from the Comdove inbox** | The tab shows the reply (`message.new … ⬅`) and `delivered`; Comdove shows ✓✓ **Delivered** |
| 5 | In the tab, type `{"type":"chat.read","number":"919876543212","peer":"918888800001"}` | Comdove shows the reply as **Read** |
| 6 | `curl -s "localhost:4020/api/log?limit=3"` | The reply has `sent:ok`, `delivered:ok`, `read:ok`, each HTTP 200 |

Comdove's log should contain **no** `UNKNOWN_WAMID`, `UNKNOWN_PHONE_NUMBER`,
`webhook.signature_invalid` or unexpected `MetaApiError`.

---

## Part 4 — Demo step 9 with the real Comdove (bad token)

PRD §10: *"Trigger one error case (bad token) and show Comdove handling Meta's error JSON."*
We make Comdove's token wrong **without touching Comdove's database**: the mock is told to
accept a different token, so Comdove's stored `mock-token-dev` becomes the bad one (like
an expired or rotated token). Needs a customer who messaged in the last 24 h (Part 3, step 3).

```bash
M=http://localhost:4020

# 1. Rotate the token the mock accepts for MOCK-PN-1
curl -s -X DELETE $M/api/business-numbers/MOCK-PN-1 -w '%{http_code}\n'      # 204
curl -s -X POST $M/api/business-numbers -H 'Content-Type: application/json' \
  -d '{"display_number":"918888800001","label":"Mock Business","phone_number_id":"MOCK-PN-1","waba_id":"MOCK-WABA-1","token":"rotated-token-demo9"}'; echo
```

2. **Reply to the customer from the Comdove inbox.**

3. Check:

| Where | Expected |
|---|---|
| Comdove inbox | The reply bubble shows **failed** |
| Comdove DB (`WaMessage`) | `status: FAILED`, `errorCode: "META_190"`, `errorMessage` = Meta's envelope: `{status: 401, code: 190, type: "OAuthException", message: "Invalid OAuth access token - Cannot parse access token", fbtrace_id: "MOCK-trace-…"}`, `wamid: null` |
| Comdove log | one `meta.api.call`, then `waba.metaGraph.sendTextMessage.failed` and `worker.outbound.job.failed` — **no retry** (4xx is unrecoverable) |
| Mock log `curl -s "$M/api/log?limit=1"` | `"direction":"rejected"`, `"http_status":401`, `"code":190`, with the recipient and text |

```bash
# 4. Restore the real token
curl -s -X DELETE $M/api/business-numbers/MOCK-PN-1 -w '%{http_code}\n'
curl -s -X POST $M/api/business-numbers -H 'Content-Type: application/json' \
  -d '{"display_number":"918888800001","label":"Mock Business","phone_number_id":"MOCK-PN-1","waba_id":"MOCK-WABA-1","token":"mock-token-dev"}'; echo
```
✅ The next reply from Comdove goes through again (`SENT`, a `wamid.MOCK-…`, no error).

Verified on 2026-09-19 against the real wat-backend: FAILED / `META_190`, one attempt, no
retry; after restoring the token the next send was `SENT`.

---

## Checklist

| Completed task | Tested by |
|---|---|
| Send endpoint + Meta success response | Test 2 |
| Meta errors (190, 100/33, 131026, 130429, not implemented, bad JSON) | Test 3 |
| Customer reply → signed inbound webhook (API / tile) | Tests 4, 11 |
| Mark-as-read by Comdove | Test 5 |
| Offline tile queues; back online flushes + delivered | Test 6 |
| Retries, timing and ordering | Test 7 |
| Auto-reply | Test 8 |
| Admin log incl. rejected requests | Tests 9, 14 |
| Reset cancels retries, keeps numbers | Test 10 |
| Tile opens chat → read webhooks + ticks | Test 12 |
| Close / reopen group → queued, late delivered, read | Test 13 |
| Verify handshake, lock shown in `/api/groups` | Test 1 |
| Live admin feed (log incl. rejected, groups, numbers, verify) | Test 14 |
| Reset refreshes open tabs; wipe closes them (`group_deleted`) | Test 15 |
| Everything with the real Comdove | Part 3 |
| Demo step 9 — Comdove handles Meta's 401/190 | Part 4 |
| All code paths | Part 1 (`npm test`) |

