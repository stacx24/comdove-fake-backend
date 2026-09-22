# Fake WhatsApp Server — Setup & Testing Guide

How to set up and test the fake WhatsApp server (backend + UI), either **standalone** (fastest) or
**wired to the real Comdove/wat-backend** for a full end-to-end test.

- **Backend repo:** `stacx24/comdove-fake-backend` — the mock (Meta emulator + control API + WebSocket)
- **UI repo:** `stacx24/comdove-fake-ui` — the browser client grid + admin page
- **Ports:** mock = **4020**, UI dev = **5173**, real wat-backend (optional) = **3000**

---

## 0. What you need

| Tool | For |
|------|-----|
| Node.js 20+ | run both apps |
| npm | install deps |
| (optional) Docker | only if you also run the real wat-backend (needs Postgres + Redis) |

There are **three ways to run**, pick what you need:
- **A. Standalone (mock + UI only)** — test the fake server + UI by themselves. No Comdove, no Docker. Fastest.
- **B. Automated tests** — run the backend + UI test suites. No browser.
- **C. Full end-to-end** — mock + UI + the real wat-backend, sending/receiving live.

---

## A. Standalone — mock + UI (fastest)

### A1. Start the mock (backend)
```bash
cd comdove-fake-backend
npm install
cp .env.example .env        # defaults are fine for standalone
npm run dev                 # → http://localhost:4020  (Swagger at /docs)
```
✅ You'll see `🟢 comdove-fake-backend listening on http://localhost:4020` and `🔌 WebSocket on ws://localhost:4020/ws`.

### A2. Start the UI
```bash
cd comdove-fake-ui/client
npm install
cp .env.example .env
# edit .env → set the data source to the real mock:
#   VITE_DATA_SOURCE=server
npm run dev                 # → http://localhost:5173
```
> `VITE_DATA_SOURCE=server` makes the UI use the **real mock API** (proxied to :4020).
> Leave it `mock` to use built-in sample data with no server.

### A3. Open in the browser
| Screen | URL |
|--------|-----|
| Admin (register numbers, groups, live log, reset) | http://localhost:5173/admin |
| Client launch (group list) | http://localhost:5173/client |
| Client grid (a group's tiles) | http://localhost:5173/client?group=alpha |
| Swagger (try any API) | http://localhost:4020/docs |

### A4. Quick manual flow
1. **Admin →** register a business number (display number + label) → get a `phone_number_id` + token.
2. **Admin →** create a group with a customer number (e.g. `919876543210`).
3. **Client →** open that group → you see a tile per customer.
4. Type in the tile "as the customer" and Send → it appears in the **Admin live log**.
5. **Admin →** Reset to clear messages.

---

## B. Automated tests (no browser)

### Backend
```bash
cd comdove-fake-backend
npm test          # expect: all tests pass (270)
npm run typecheck # no output = clean
```
Run one area at a time:
```bash
node --import tsx --test test/meta/*.test.ts       # Meta emulator + errors
node --import tsx --test test/webhooks/*.test.ts   # signing, dispatcher, retries, handshake
node --import tsx --test test/e2e/*.test.ts        # full flows
```

### UI
```bash
cd comdove-fake-ui/client
npm test          # expect: all tests pass (94)
```

---

## C. Full end-to-end — with the real wat-backend

This proves the mock talking to the **real Comdove backend** both directions.

### C1. Start Postgres + Redis (Docker)
```bash
cd wat-backend
docker compose up -d        # postgres :5432 + redis :6379
```

### C2. Point wat-backend at the mock (⚠ safe config — never live)
In `wat-backend/.env`:
```
DB_TARGET=local                                  # local Docker DB, NOT production
META_GRAPH_API_BASE_URL=http://localhost:4020    # send to the mock, not real Meta
ALLOW_LOCAL_TEST=false
```
**The two secrets must match on both sides** (or webhooks are rejected 401):
```
wat-backend  META_APP_SECRET      == mock  APP_SECRET
wat-backend  WHATSAPP_VERIFY_TOKEN == mock  WEBHOOK_VERIFY_TOKEN
```

### C3. Seed the local DB (once)
```bash
cd wat-backend
npm run prisma:generate
npm run db:push                                  # create tables in local backend_db
NODE_OPTIONS='-r ./scripts/resolve-db.cjs' npx tsx prisma/seed-dev-user.ts   # login user + team
# seed a demo WABA phone the mock will use:
TEAM_ID=$(docker exec wat-test-pg psql -U postgres -d backend_db -tAc "SELECT id FROM \"Team\" WHERE slug='admin-team';")
NODE_OPTIONS='-r ./scripts/resolve-db.cjs' SEED_TEAM_ID="$TEAM_ID" npx tsx scripts/seed-ws205-phone.ts
```
This registers `PHONE_DEMO_WS205` / display `15559258976` in Comdove's local DB.
On the **mock**, register the same number so both sides agree:
```bash
curl -s -X POST localhost:4020/api/business-numbers -H 'Content-Type: application/json' \
  -d '{"display_number":"15559258976","label":"WS205 Demo","phone_number_id":"PHONE_DEMO_WS205","waba_id":"WABA_DEMO_WS205","token":"demo-token"}'
curl -s -X POST localhost:4020/api/groups -H 'Content-Type: application/json' \
  -d '{"name":"realtest","numbers":["919876543210"]}'
```

### C4. Start everything
```bash
# terminal 1 — mock
cd comdove-fake-backend && npm run dev
# terminal 2 — real wat-backend
cd wat-backend && npm run dev
# terminal 3 — UI (optional, VITE_DATA_SOURCE=server)
cd comdove-fake-ui/client && npm run dev
```
✅ On wat-backend boot you should see `🤝 webhook handshake ok` (the mock verified with Comdove).

### C5. Test both directions
**Inbound (customer → Comdove):**
```bash
curl -s -X POST localhost:4020/api/inject -H 'Content-Type: application/json' \
  -d '{"from":"919876543210","to":"15559258976","body":"Hi from the mock"}'
```
→ the message shows in Comdove's inbox (signed webhook accepted).

**Outbound (Comdove → customer):** send a message from Comdove's inbox UI to `919876543210`
→ it reaches the mock and Comdove shows **Delivered** (✓✓).

Verify it landed in the mock:
```bash
curl -s "localhost:4020/api/log?limit=5"
```

---

## Demo script (the acceptance test — PRD §10)

Tick each in the UI:
1. Register 5 business numbers + 2 groups in Admin.
2. Point wat-backend at the mock (env, no code change).
3. Send from Comdove → appears < 1s; log shows sent → delivered → read.
4. Toggle a tile offline → send → toggle online → queued message arrives.
5. Close a group, send 2–3, reopen → history + queued appear.
6. Open the same group in a 2nd tab → it's locked.
7. Type a reply in a tile → Comdove receives it.
8. Set a tile to keyword auto-reply → short bot chat.
9. Trigger a bad-token error → Comdove handles Meta's error.
10. Reset → messages clear, numbers/groups remain.

---

## Handy commands & tools

| Task | Command |
|------|---------|
| Factory reset the mock DB | delete `mock.sqlite` (or `POST /api/reset`) |
| Open a group from terminal (no browser) | `npm run tab -- alpha` (in comdove-fake-backend) |
| Fake Comdove receiver (test webhooks, no real backend) | `npm run fake-comdove` |
| Seed mock numbers into Comdove | `npm run seed-comdove` |
| Regenerate UI fixtures | `npm run fixtures` |
| Swagger (browse/try APIs) | http://localhost:4020/docs |

---

## Troubleshooting

| Symptom | Fix |
|---------|-----|
| UI shows sample data, not real | set `VITE_DATA_SOURCE=server` in `comdove-fake-ui/client/.env`, restart |
| Webhooks rejected (401) | mock `APP_SECRET` must equal wat-backend `META_APP_SECRET` |
| wat-backend handshake fails | mock `WEBHOOK_VERIFY_TOKEN` must equal wat-backend `WHATSAPP_VERIFY_TOKEN`; is wat-backend on :3000? |
| Inbound message not in Comdove | the business `phone_number_id` must exist in Comdove's local DB (seed it, C3) |
| Queues/real-time dead | Redis not running → `docker compose up -d redis` |
| Port in use | change `PORT` (mock) or stop the process on 4020/3000/5173 |
| ⚠ Never | point wat-backend at `DB_TARGET=live` for testing — use `local` |

---

## Safety notes
- The mock runs on **localhost only** — never expose it publicly.
- For testing, wat-backend must use the **local** DB (`DB_TARGET=local`), never production.
- `.env` files hold secrets — never commit them (they're git-ignored).
