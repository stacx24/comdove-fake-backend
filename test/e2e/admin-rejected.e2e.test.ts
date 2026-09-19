// A Meta request the emulator rejects shows on the live admin feed at once, with exactly
// the entry GET /api/log returns (plan §8c, §10c, FR-11).
import '../helpers/memory-db.js';
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { composeServer } from '../../src/compose.js';
import { listen } from '../helpers/http.js';
import { wsClient } from '../helpers/ws-client.js';

let base = '';
let wsUrl = '';
let stop: () => Promise<void>;

before(async () => {
  const composed = composeServer({
    env: { COMDOVE_WEBHOOK_URL: 'http://127.0.0.1:9/webhooks/whatsapp', APP_SECRET: 's', WEBHOOK_VERIFY_TOKEN: 'v', STATUS_WEBHOOK_DELAY_MS: 0 },
    log: () => {},
  });
  const m = await listen(composed.app);
  const wss = composed.live.attach(m.server, { heartbeatMs: 60_000 });
  base = m.base;
  wsUrl = `${m.base.replace('http', 'ws')}/ws`;
  stop = async () => { composed.metaFace.dispatcher.cancelAll(); await wss.close(); await m.close(); };
});
after(() => stop());

const send = (token: string, extra: Record<string, string> = {}) =>
  fetch(`${base}/v23.0/PN-1/messages`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}`, ...extra },
    body: JSON.stringify({ messaging_product: 'whatsapp', to: '919876543210', type: 'text', text: { body: 'hello' } }),
  });

test('bad token and forced errors reach the admin feed live, same shape as /api/log', async () => {
  await fetch(`${base}/api/business-numbers`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ display_number: '918888800001', phone_number_id: 'PN-1', token: 'tok' }) });
  const admin = await wsClient(wsUrl);
  admin.send({ type: 'admin.subscribe' });
  await admin.next('numbers.update');

  assert.equal((await send('wrong')).status, 401);
  const live = await admin.next('log.entry', (f) => f.entry.direction === 'rejected');
  assert.deepEqual([live.entry.http_status, live.entry.code, live.entry.forced, live.entry.to, live.entry.body], [401, 190, false, '919876543210', 'hello']);
  const [fromApi] = (await (await fetch(`${base}/api/log?limit=1`)).json()) as unknown[];
  assert.deepEqual(live.entry, fromApi);

  assert.equal((await send('tok', { 'X-Mock-Force-Error': '130429' })).status, 400);
  const forced = await admin.next('log.entry', (f) => f.entry.direction === 'rejected');
  assert.deepEqual([forced.entry.code, forced.entry.forced], [130429, true]);
  await admin.close();
});
