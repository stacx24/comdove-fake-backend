# UI → API Guide (Person 2 Control API)

How the **Comdove Mock UI** should call Person 2's control API. Based on the design
(`Comdove Mock UI` — Client launch, Admin, Client grid) and the endpoints in
`docs/BACKEND-BUILD-PLAN.md` §10.

- **Base URL:** `http://localhost:4020`
- **Auth:** none (mock-only, local network). No headers needed except `Content-Type: application/json` on POST/PUT.
- **Error shape (all control endpoints):** `{ "error": { "message": "..." } }` with a 4xx status.
- **Live updates (tiles + live log):** delivered over **WebSocket `/ws`** — that's Person 3's part, not these REST calls. REST here is for register/list/config/reset.

---

## Screen 1 — Client launch page (`/client`)

Shows the list of groups with FREE / LOCKED status. Pick a free group to open it.

### On page load → list groups
```
GET /api/groups
```
Response:
```json
[
  { "id": "alpha", "name": "alpha", "count": 8, "status": "free",   "locked_since": null },
  { "id": "beta",  "name": "beta",  "count": 10, "status": "locked", "locked_since": 1758270000000 }
]
```
UI mapping:
- `name` → group title; `count` → "N numbers"
- `status: "free"` → green **FREE** pill, clickable → opens `/client?group=<id>` (WebSocket claim)
- `status: "locked"` → grey **LOCKED** pill, not clickable
- Live free/locked updates come from the WebSocket **admin/launch feed** (`groups.update`, Person 3) — poll `GET /api/groups` as a fallback.

---

## Screen 2 — Admin page (`/admin`)

### 2a. Register business number (top-left form)
User enters **Display number** + **Label** only, clicks **Register**.
```
POST /api/business-numbers
{ "display_number": "918888800004", "label": "Support line" }
```
Response (the server generates the id + token — do NOT ask the user for these):
```json
{ "phone_number_id": "MOCK-PN-4", "token": "mock-token-…", "waba_id": "MOCK-WABA-1",
  "display_number": "918888800004", "label": "Support line" }
```
After success → refresh the numbers table (2b).

### 2b. Registered numbers table (business + customers, with TYPE + CLAIM)
Two calls, then merge for the table:
```
GET /api/business-numbers     → business rows (has phone_number_id, token)
GET /api/customers            → customer rows (has claim status)
```
`GET /api/business-numbers`:
```json
[ { "phone_number_id": "MOCK-PN-1", "display_number": "918888800001", "label": "Sales",
    "token": "mock-token-…", "waba_id": "MOCK-WABA-1", "created_at": 1758270000000 } ]
```
`GET /api/customers`:
```json
[ { "number": "919876543210", "label": "alpha", "group_id": "alpha", "online": true,
    "effective_online": true, "claim_status": "locked", "reply_mode": "manual", "type": "customer" } ]
```
UI mapping (table columns):
- NUMBER → `display_number` / `number`
- LABEL → `label`
- PHONE_NUMBER_ID → `phone_number_id` (business only; "—" for customers)
- TOKEN → `token` (business only; "—" for customers)
- TYPE → `BUSINESS` (from business list) / `CUSTOMER` (from customers list)
- CLAIM → business: "—"; customer: `claim_status` (`free` grey, or `<group>·live` when locked)

### 2c. Delete a number / group (row action)
```
DELETE /api/business-numbers/{phone_number_id}   → 204
DELETE /api/groups/{id}                          → 204, or 409 if the group is open (claimed)
```
On 409 → show "group is open in a browser, close it first". After success → refresh the table.

### 2d. Create a group (if the admin creates groups here)
```
POST /api/groups
{ "name": "alpha", "numbers": ["919876543210","919876543211"], "labels": { "919876543210": "VIP" } }
```
Response: `{ "id": "alpha", "name": "alpha", "numbers": ["919876543210","919876543211"] }`
Errors: 409 if a number is already a customer elsewhere / is a business number, 400 if >10 numbers.

### 2e. Live message log (bottom table)
Initial load (pull), then live via WebSocket admin feed:
```
GET /api/log?limit=100
```
Response (newest first):
```json
[ { "wamid": "wamid.MOCK-…", "time": 1758270271000, "direction": "outbound", "source": "api",
    "from": "918888800001", "to": "919876543210",
    "business": { "phone_number_id": "MOCK-PN-1", "label": "Sales" }, "group_id": "alpha",
    "body": "Hello from Comdove", "status": "delivered",
    "timeline": [ { "status": "sent", "at": 1758270271000 }, { "status": "delivered", "at": 1758270271400 } ],
    "webhooks": [ { "kind": "sent", "state": "ok",
      "attempts": [ { "n": 1, "http_status": 200, "duration_ms": 84, "at": 1758270271650 } ] } ] } ]
```
UI mapping (columns):
- TIME → `time` · FROM → `from` · TO → `to` · TEXT → `body`
- STATUS chips → from `timeline` (sent / delivered / read; grey until present)
- WEBHOOK → last attempt: `200 · 84ms`, or `queued · tile offline`, or `retry 2/3 · 500`
- **Live rows/updates** come from the WebSocket admin feed (`log.entry` / `log.update`, Person 3). `GET /api/log` is the initial load + fallback.

### 2f. Reset button (top-right of the log)
```
POST /api/reset
{ "keep_numbers": true }
```
Response: `{ "ok": true, "kept_numbers": true }`. Show a confirm dialog first (UI only).
`keep_numbers: true` clears messages but keeps numbers/groups (the demo default).

---

## Screen 3 — Client grid (tiles inside a group, `/client?group=alpha`)

The live chat (open group, send, receive, ticks, queue flush) runs over **WebSocket
`/ws`** — Person 3. Person 2's REST endpoints the grid uses:

### 3a. Tile online/offline toggle (the green/grey dot)
```
POST /api/presence
{ "number": "919876543210", "online": false }
```
Response: `{ "number": "919876543210", "online": false, "effective_online": false }`
(The live flush + tile push also happen over WebSocket; this REST call is the same effect without the socket.)

### 3b. Auto-reply gear (manual / echo / keyword)
Read current config:
```
GET /api/customers/919876543210/auto-reply
→ { "mode": "keyword", "delay_ms": 500, "rules": [ { "keyword": "price", "reply": "It is 500" } ] }
```
Save from the gear panel:
```
PUT /api/customers/919876543210/auto-reply
{ "mode": "keyword", "delay_ms": 500, "rules": [ { "keyword": "price", "reply": "It is 500" } ] }
```
`mode` = `manual` | `echo` | `keyword`. For `keyword`, provide `rules` (contains X → reply Y).

### 3c. Inject a message without the browser (testing / automation only)
Not a normal UI action, but handy for scripts:
```
POST /api/inject
{ "from": "919876543210", "to": "918888800001", "body": "how much?" }
→ { "wamid": "wamid.MOCK-…" }
```

---

## Quick reference — which screen calls which API

| UI screen / action | Method + path |
|---|---|
| Client launch — list groups | `GET /api/groups` |
| Admin — register number | `POST /api/business-numbers` |
| Admin — numbers table (business) | `GET /api/business-numbers` |
| Admin — numbers table (customers + claim) | `GET /api/customers` |
| Admin — delete number | `DELETE /api/business-numbers/{id}` |
| Admin — delete group | `DELETE /api/groups/{id}` |
| Admin — create group | `POST /api/groups` |
| Admin — live log (load) | `GET /api/log?limit=100` |
| Admin — reset | `POST /api/reset` |
| Grid — tile online/offline | `POST /api/presence` |
| Grid — auto-reply read/save | `GET` / `PUT /api/customers/{number}/auto-reply` |
| (testing) inject a customer message | `POST /api/inject` |
| Live tiles + live log push | **WebSocket `/ws`** (Person 3) |

## Notes for the UI team
- Numbers are **digits only** (strip `+`, spaces, dashes) before sending; the API normalizes too.
- After any create/delete, **re-fetch** the affected list (or rely on the WebSocket admin feed for live updates).
- Every error is `{ "error": { "message } }` with a 4xx — show `message` to the user.
- Try any endpoint live at **`http://localhost:4020/docs`** (Swagger).
