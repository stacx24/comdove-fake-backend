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
