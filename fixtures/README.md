# Fixtures for the UI team

Sample responses from the **real** mock backend, so the client grid and admin UI can be
built and tested without running it (TEAM-SPLIT, Person 2 task 7). Types for every shape
are in `src/contract/api-types.ts` (HTTP) and `src/contract/ws-events.ts` (WebSocket).

- `api/<name>.json` — one HTTP call: `{ request: { method, path, body? }, status, body }`
- `ws/<name>.json` — one WebSocket frame exactly as the server sends it

They are generated, not hand-written: `npm run fixtures` boots the app on an in-memory
database with a fake Comdove, a browser tab and an admin page, runs one scripted session and
saves every response. wamids (`wamid.MOCK-000…001`, …) are replaced by stable values; times
are replaced by values from `1758270000000`, one second apart, in the order they happened
(regenerating can shift a few of them by a second — they are illustrative). `npm test` fails if
the API's shape or status codes drift from these files.

## Scenario
Business numbers `918888800001` (Sales, `PN-1`) and `918888800002` (Support, generated ids);
group `alpha` = `919876543210` (Asha) + `919876543211`, group `beta` = `919876543220`.
An admin page subscribes; Comdove sends while `alpha` is closed (queued); a tab opens
`alpha` (queue delivered), reads, replies; a tile goes offline and back (queue flush);
keyword auto-reply answers; a wrong-token request is rejected; then deletes and resets.

## HTTP — `api/`
| File | Call | Shows |
|---|---|---|
| `business-numbers.post` | `POST /api/business-numbers` | register with Comdove's ids and token |
| `business-numbers.post.generated-ids` | same | ids and token generated (`MOCK-PN-1`, `MOCK-WABA-1`) |
| `business-numbers.post.400` | same | invalid number → `{error:{message}}` |
| `business-numbers.get` | `GET /api/business-numbers` | inventory |
| `business-numbers.delete` / `.404` | `DELETE /api/business-numbers/:id` | 204 / unknown id |
| `groups.post` | `POST /api/groups` | formatted numbers stored as digits, labels |
| `groups.post.400` / `.409` | same | bad number / number already in another group |
| `groups.get` | `GET /api/groups` | launch list with `free` / `locked` (alpha is open in a tab) |
| `groups.delete` / `.409` / `.404` | `DELETE /api/groups/:id` | 204 / group open in a tab / unknown |
| `customers.get` | `GET /api/customers` | admin number list: `online`, `effective_online`, `claim_status` |
| `presence.post` | `POST /api/presence` | tile flag + `effective_online` |
| `inject.post` / `.400` | `POST /api/inject` | inbound as if typed in a tile / unknown sender |
| `auto-reply.get` / `.put` / `.put.400` | `GET` / `PUT /api/customers/:n/auto-reply` | config / save / bad mode |
| `log.get` | `GET /api/log` | newest first: messages (timeline + webhook attempts) and one **rejected** request (`wamid: null`) |
| `status.get` | `GET /api/status` | admin header: handshake, pending webhooks, counts |
| `webhook-verify.post` | `POST /api/webhook/verify` | re-run the handshake |
| `reset.post` / `reset-alias.post` / `reset.post.wipe` | `POST /api/reset`, `POST /reset` | keep numbers (default) / alias / `keep_numbers:false` |
| `unknown-endpoint.404` | `GET /api/nope` | JSON 404 for unknown control paths |

## WebSocket — `ws/`
| File | Frame | When |
|---|---|---|
| `group.claimed` | snapshot | a tab opens `alpha`: tiles, `history`, `queued`, `unread`, auto-reply |
| `group.claimed.after-reset` | snapshot | the open tab after `POST /api/reset` (empty history) |
| `group.locked` | claim refused | a second tab tries `alpha` |
| `message.new.outbound` / `.inbound` | new bubble | Comdove's message / the tile's own reply |
| `message.status.delivered` / `.read` | tick | delivered to the tile / tile opened the chat |
| `queue.flush` | queued messages | a tile comes back online |
| `tile.presence` / `tile.autoreply` | tile change | set through the control API |
| `error.number_not_in_group` / `error.group_deleted` | error | bad tile action / group wiped by a reset (socket closes) |
| `admin.groups.update` / `admin.numbers.update` | lists | on subscribe and on every change |
| `admin.log.entry` / `admin.log.update` | log row | a message's first entry / its latest update (key rows by `wamid`) |
| `admin.log.entry.rejected` | log row | a rejected Meta request — `wamid: null`, never updated: add as a new row |
| `admin.log.reset` / `admin.webhook.verify` | admin | after a reset / after a handshake |
