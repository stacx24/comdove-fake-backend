# Testing Guide — Person 1 (Meta face)

How to check everything Person 1 built: the Meta send endpoint, Meta errors, signed
webhooks to Comdove, retries, and how it works with Person 2's store and control API.

Three levels:

1. **Automated tests** — 2 minutes, nothing else running.
2. **Manual tests with a fake Comdove** — safe, never touches the real Comdove.
3. **Live test with the real Comdove** (wat-backend).

---

## Part 1 — Automated tests

```bash
cd ~/Projects/comdov-mock-backend
npm test            # expect: # tests 130  # pass 130  # fail 0
npm run typecheck   # expect: no output (no errors)
```

One area at a time:

| What it tests | Command |
|---|---|
| Errors and request validation | `node --import tsx --test test/meta/*.test.ts` |
| Signing, webhook sender, retries, handshake | `node --import tsx --test test/webhooks/*.test.ts` |
| Message status tracking (lifecycle) + P2 store adapter | `node --import tsx --test test/core/*.test.ts` |
| Full flow (Meta face + Person 2 store/API) | `node --import tsx --test test/e2e/*.test.ts` |

Tests use an in-memory database; they never touch `mock.sqlite`.

---

## Part 2 — Manual tests with the fake Comdove

Use **3 terminals**. This runs on port **4021** with its own database file, so it does
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

### Test 1 — Health and handshake
```bash
curl -s $M/health; echo
curl -s $M/api/status; echo
```
✅ `"status":"ok"` and `"verify":{"ok":true,...}`

### Test 2 — Send a message (Meta success response)
```bash
curl -s -X POST $M/v23.0/MOCK-PN-1/messages \
  -H 'Authorization: Bearer mock-token-dev' -H 'Content-Type: application/json' \
  -d '{"messaging_product":"whatsapp","to":"919876543210","type":"text","text":{"body":"Hello"}}'; echo
```
✅ `{"messaging_product":"whatsapp","contacts":[...],"messages":[{"id":"wamid.MOCK-..."}]}`
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

### Test 4 — Customer reply (signed inbound webhook)
```bash
curl -s -X POST $M/api/inject -H 'Content-Type: application/json' \
  -d '{"from":"919876543210","to":"918888800001","body":"How much?"}'; echo
```
✅ `{"wamid":"wamid.MOCK-..."}` and Terminal 1: `✔ 200 inbound`

### Test 5 — Mark as read (no webhook expected)
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
(correct — Meta sends no webhook for a business's own read receipt).

⚠️ Step 2 uses **double quotes** so `$W` is filled in. A `400` with
`"message_id is not an inbound message for this phone number"` means the id was wrong:
a placeholder, an empty `$W` (different terminal), or the id of a message Comdove *sent*
(only customer messages can be marked read).

### Test 6 — Offline tile queues the message
```bash
curl -s -X POST $M/api/presence -H 'Content-Type: application/json' -d '{"number":"919876543211","online":false}'; echo
curl -s -X POST $M/v23.0/MOCK-PN-1/messages \
  -H 'Authorization: Bearer mock-token-dev' -H 'Content-Type: application/json' \
  -d '{"messaging_product":"whatsapp","to":"919876543211","type":"text","text":{"body":"Are you there?"}}'; echo
```
✅ Terminal 1 shows only `✔ 200 sent` — **no** `delivered` (the tile is offline).

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
✅ Terminal 1: `sent`, `delivered`, then ~0.5 s later `✔ 200 inbound` (the bot's reply).

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

### Clean up
Ctrl+C in Terminals 1 and 2, then:
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
- Comdove's **local** DB has a `WabaAccount` (`wabaId` = `MOCK-WABA-1`, token encrypted
  with its `encryptSecret`) and a `WabaPhoneNumber` (`phoneNumberId` = `MOCK-PN-1`).
- The mock (port 4020) has the same number registered (the `business-numbers` call from
  Part 2 with `M=http://localhost:4020`) and a group containing the customer numbers.

| Step | Do this | Check |
|---|---|---|
| 1 | `curl -s localhost:4020/api/status` | `"verify":{"ok":true}` |
| 2 | `curl -s -X POST localhost:4020/api/inject -H 'Content-Type: application/json' -d '{"from":"919876543212","to":"918888800001","body":"Hi from customer 3"}'` | A new chat appears in the **Comdove inbox** (frontend http://localhost:5173) |
| 3 | Reply to that chat **from the Comdove inbox** | The reply shows ✓✓ **Delivered** in Comdove |
| 4 | `curl -s "localhost:4020/api/log?limit=3"` | The reply has `sent:ok` and `delivered:ok`, each HTTP 200 |

Comdove's log should contain **no** `UNKNOWN_WAMID`, `UNKNOWN_PHONE_NUMBER`,
`webhook.signature_invalid` or `MetaApiError`.

---

## Checklist

| Completed task | Tested by |
|---|---|
| Send endpoint + Meta success response | Test 2 |
| Meta errors (190, 100/33, 131026, 130429, not implemented, bad JSON) | Test 3 |
| Customer reply → signed inbound webhook | Test 4 |
| Mark-as-read | Test 5 |
| Offline tile keeps the message queued | Test 6 |
| Retries, timing and ordering | Test 7 |
| Auto-reply | Test 8 |
| Admin log incl. rejected requests | Test 9 |
| Reset cancels retries, keeps numbers | Test 10 |
| Verify handshake | Test 1 |
| Everything with the real Comdove | Part 3 |
| All code paths | Part 1 (`npm test`) |

**Not testable yet** (needs Person 3's WebSocket): `read` status from a tile opening a
chat, and late `delivered` statuses when a closed group is reopened.
