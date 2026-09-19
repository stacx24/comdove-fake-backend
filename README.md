# comdove-fake-backend

Fake WhatsApp / Meta Cloud API **mock server** for testing Comdove (`wat-backend`)
end to end — without a real Meta account, real phone numbers, or API costs.

Comdove switches to the mock by changing **one env variable**
(`META_GRAPH_API_BASE_URL` → the mock). No code change in wat-backend.

## Stack
Node + TypeScript + Express + SQLite (better-sqlite3); WebSocket added with the live engine.

## Getting started

```bash
cp .env.example .env    # then align APP_SECRET / WEBHOOK_VERIFY_TOKEN with wat-backend
npm install
npm run dev             # starts on PORT 4020
```

Check it's up: `curl http://localhost:4020/health`

## API docs (Swagger)
With the server running, open **http://localhost:4020/docs** to browse and try
every endpoint. Raw spec at **http://localhost:4020/openapi.json**.

## Scripts
- `npm run dev` — run with live reload (tsx watch)
- `npm run build` — compile TypeScript to `dist/`
- `npm start` — run the compiled build

## Tests
- `npm test` — unit + end-to-end tests (Node's built-in runner via tsx)
- `npm run typecheck` — type-checks `src`, `test` and `tools`

## Try it locally
Numbers live in SQLite (`DB_PATH`, default `./mock.sqlite`); register them through the
control API. Until the live engine (WebSocket) lands, a tile counts as online when its
`/api/presence` flag is on, and auto-replies fire on delivery.

```bash
npm run fake-comdove                                            # receiver on :3100
COMDOVE_WEBHOOK_URL=http://localhost:3100/webhooks/whatsapp npm run dev

curl -X POST localhost:4020/api/business-numbers -H 'Content-Type: application/json' \
  -d '{"display_number":"918888800001","label":"Sales","phone_number_id":"MOCK-PN-1","waba_id":"MOCK-WABA-1","token":"mock-token-dev"}'
curl -X POST localhost:4020/api/groups -H 'Content-Type: application/json' \
  -d '{"name":"alpha","numbers":["919876543210","919876543211"]}'

curl -X POST localhost:4020/v23.0/MOCK-PN-1/messages \
  -H 'Authorization: Bearer mock-token-dev' -H 'Content-Type: application/json' \
  -d '{"messaging_product":"whatsapp","to":"919876543210","type":"text","text":{"body":"hi"}}'
curl -X POST localhost:4020/api/inject -H 'Content-Type: application/json' \
  -d '{"from":"919876543210","to":"918888800001","body":"how much?"}'
curl localhost:4020/api/log
```
The fake Comdove prints `✔ 200 sent …`, `✔ 200 delivered …` and `✔ 200 inbound …`.
`FAIL_NEXT=3 npm run fake-comdove` makes it answer 503 three times so you can watch the
retries in `/api/log`.

Against a real wat-backend, its local DB must know the same `phone_number_id`,
`waba_id` and token (build plan §5c).

## Contract (shared with the UI team)

The WebSocket and API shapes are frozen in `src/contract/`:

- `src/contract/ws-events.ts` — every frame on `ws://localhost:4020/ws`
  (6 client→server, 8 server→group-session and 6 admin-feed events), the error codes,
  and `parseClientEvent()` / `encodeEvent()`.
- `src/contract/api-types.ts` — shapes shared by `/api/*` and the admin feed
  (`LogEntryDTO`, `GroupSummaryDTO`, `BusinessNumberDTO`, ...; owned by Person 2).

Design: `docs/superpowers/specs/2026-09-19-ws-events-contract-design.md`.
Any change after the freeze updates these files and is announced to the UI team
the same day.
