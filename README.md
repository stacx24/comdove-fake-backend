# comdove-fake-backend

Fake WhatsApp / Meta Cloud API **mock server** for testing Comdove (`wat-backend`)
end to end — without a real Meta account, real phone numbers, or API costs.

Comdove switches to the mock by changing **one env variable**
(`META_GRAPH_API_BASE_URL` → the mock). No code change in wat-backend.

## Stack
Node + TypeScript + Express (WebSocket + SQLite added as build progresses).

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

## Try the Meta face locally (before P2/P3 land)
`npm run dev` seeds an in-memory business `MOCK-PN-1` (token `mock-token-dev`) and
customers `919876543210`–`919876543212`, and treats every tile as online.

```bash
npm run fake-comdove                                            # receiver on :3100
COMDOVE_WEBHOOK_URL=http://localhost:3100/webhooks/whatsapp npm run dev

curl -X POST localhost:4020/v23.0/MOCK-PN-1/messages \
  -H 'Authorization: Bearer mock-token-dev' -H 'Content-Type: application/json' \
  -d '{"messaging_product":"whatsapp","to":"919876543210","type":"text","text":{"body":"hi"}}'
```
The fake Comdove prints `✔ 200 sent …` then `✔ 200 delivered …`. `FAIL_NEXT=3 npm run
fake-comdove` makes it answer 503 three times so you can watch the retries.
