// P1 + P2 integrated: the real boot wiring (composeServer) — P2's SQLite store and
// control API, P1's Meta face and SqliteJobStore — against a fake Comdove that
// verifies signatures like wat-backend. Driven entirely over HTTP.
import '../helpers/memory-db.js';
import { test, before, after, beforeEach, afterEach } from 'node:test';
import { WebSocket } from 'ws';
import { sharedLock } from '../../src/ws/shared-lock.js';
import assert from 'node:assert/strict';
import { composeServer } from '../../src/compose.js';
import { createFakeComdove } from '../../tools/fake-comdove-app.js';
import { listen, waitFor } from '../helpers/http.js';

const SECRET = 'int-secret';
let comdove: ReturnType<typeof createFakeComdove>;
let base = '';
let closeAll: () => Promise<void>;
let composed: ReturnType<typeof composeServer>;

before(async () => {
  comdove = createFakeComdove({ appSecret: SECRET, verifyToken: 'int-verify' });
  const c = await listen(comdove.app);
  composed = composeServer({
    env: { COMDOVE_WEBHOOK_URL: `${c.base}/webhooks/whatsapp`, APP_SECRET: SECRET, WEBHOOK_VERIFY_TOKEN: 'int-verify', STATUS_WEBHOOK_DELAY_MS: 30 },
    dispatcher: { retryDelaysMs: [10, 10, 10], timeoutMs: 500 },
    log: () => {},
  });
  const m = await listen(composed.app);
  const wss = composed.live.attach(m.server, { heartbeatMs: 60_000 });
  base = m.base;
  closeAll = async () => { composed.metaFace.dispatcher.cancelAll(); await wss.close(); await m.close(); await c.close(); };
});
after(() => closeAll());

const api = async (method: string, path: string, body?: unknown, headers: Record<string, string> = {}) => {
  const res = await fetch(base + path, { method, headers: { 'Content-Type': 'application/json', ...headers }, body: body === undefined ? undefined : JSON.stringify(body) });
  const text = await res.text();
  return { status: res.status, json: text ? JSON.parse(text) : null };
};
const send = (to: string, text: string, token = 'tok-1') =>
  api('POST', '/v23.0/PN-1/messages', { messaging_product: 'whatsapp', to, type: 'text', text: { body: text } }, { Authorization: `Bearer ${token}` });
const received = () => comdove.received.filter((r) => r.status === 200).map((r) => [r.kind, r.wamid]);

beforeEach(async () => {
  await api('POST', '/api/reset', { keep_numbers: false });
  comdove.received.length = 0;
  assert.equal((await api('POST', '/api/business-numbers', { display_number: '918888800001', label: 'Sales', phone_number_id: 'PN-1', waba_id: 'WABA-1', token: 'tok-1' })).status, 200);
  assert.equal((await api('POST', '/api/groups', { name: 'alpha', numbers: ['919876543210', '919876543211'] })).status, 200);
  tab = await openGroup('alpha');
});

afterEach(async () => {
  tab?.close();
  tab = undefined;
  await waitFor(() => !sharedLock.isLocked('alpha'));
});

// Delivery needs an open group (P3, plan §13a): a browser tab claims `alpha` for each test.
let tab: WebSocket | undefined;
async function openGroup(group: string): Promise<WebSocket> {
  const ws = new WebSocket(base.replace('http', 'ws') + '/ws');
  await new Promise((resolve, reject) => {
    ws.once('open', resolve);
    ws.once('error', reject);
  });
  const claimed = new Promise<void>((resolve, reject) =>
    ws.once('message', (data) => (JSON.parse(String(data)).type === 'group.claimed' ? resolve() : reject(new Error(String(data))))),
  );
  ws.send(JSON.stringify({ type: 'group.claim', group }));
  await claimed;
  return ws;
}

test('handshake via /api/webhook/verify, reflected in /api/status', async () => {
  assert.equal((await api('POST', '/api/webhook/verify')).json.ok, true);
  assert.equal((await api('GET', '/api/status')).json.verify.ok, true);
});

test('Meta send to an online tile → sent + delivered webhooks; /api/log shows timeline + attempts', async () => {
  const r = await send('919876543210', 'Hello');
  assert.equal(r.status, 200);
  const wamid = r.json.messages[0].id;
  await waitFor(() => received().length === 2);
  assert.deepEqual(received(), [['sent', wamid], ['delivered', wamid]]);
  assert.ok(comdove.received.every((x) => x.signatureValid));
  assert.equal((comdove.received[0].payload as { entry: Array<{ id: string }> }).entry[0].id, 'WABA-1');
  const [entry] = (await api('GET', '/api/log?limit=5')).json;
  assert.equal(entry.wamid, wamid);
  assert.deepEqual(entry.business, { phone_number_id: 'PN-1', label: 'Sales' });
  assert.equal(entry.group_id, 'alpha');
  assert.deepEqual(entry.timeline.map((t: { status: string }) => t.status), ['sent', 'delivered']);
  assert.deepEqual(entry.webhooks.map((w: { kind: string; state: string }) => [w.kind, w.state]), [['sent', 'ok'], ['delivered', 'ok']]);
  assert.equal(entry.webhooks[0].attempts[0].http_status, 200);
});

test('offline tile (via /api/presence) keeps the message queued: only sent fires', async () => {
  await api('POST', '/api/presence', { number: '919876543211', online: false });
  const r = await send('919876543211', 'Are you there?');
  await waitFor(() => received().length === 1);
  await new Promise((res) => setTimeout(res, 80));
  assert.deepEqual(received(), [['sent', r.json.messages[0].id]]);
  const [entry] = (await api('GET', '/api/log?limit=1')).json;
  assert.equal(entry.status, 'sent');
});

test('/api/inject → one stored message + signed inbound webhook (no double store)', async () => {
  const r = await api('POST', '/api/inject', { from: '919876543210', to: '918888800001', body: 'how much?' });
  assert.equal(r.status, 200);
  await waitFor(() => received().length === 1);
  assert.deepEqual(received(), [['inbound', r.json.wamid]]);
  const log = (await api('GET', '/api/log')).json;
  assert.equal(log.length, 1);
  assert.equal(log[0].source, 'inject');
  assert.equal(log[0].direction, 'inbound');
});

test('/api/inject with a bad sender → 400 JSON, nothing sent', async () => {
  const r = await api('POST', '/api/inject', { from: '911111111111', to: '918888800001', body: 'x' });
  assert.equal(r.status, 400);
  assert.ok(r.json.error.message);
  assert.equal(comdove.received.length, 0);
});

test('keyword auto-reply (P2 engine) answers a Comdove message with a signed inbound', async () => {
  const put = await api('PUT', '/api/customers/919876543210/auto-reply', { mode: 'keyword', delay_ms: 0, rules: [{ keyword: 'price', reply: 'how much is it?' }] });
  assert.equal(put.status, 200);
  const r = await send('919876543210', 'Our PRICE list is ready');
  await waitFor(() => received().length === 3);
  const kinds = received().map((x) => x[0]).sort();
  assert.deepEqual(kinds, ['delivered', 'inbound', 'sent']);
  const reply = (await api('GET', '/api/log')).json.find((e: { source: string }) => e.source === 'autoreply');
  assert.equal(reply.body, 'how much is it?');
  assert.equal(reply.from, '919876543210');
  assert.ok(r.json.messages[0].id);
});

test('Meta errors are logged as rejected; bad token and unknown id', async () => {
  assert.equal((await send('919876543210', 'x', 'wrong')).status, 401);
  const unknown = await api('POST', '/v23.0/NOPE/messages', { messaging_product: 'whatsapp', to: '919876543210', type: 'text', text: { body: 'x' } }, { Authorization: 'Bearer tok-1' });
  assert.deepEqual([unknown.status, unknown.json.error.code, unknown.json.error.error_subcode], [400, 100, 33]);
  const log = (await api('GET', '/api/log')).json;
  assert.deepEqual(log.map((e: { direction: string; code: number }) => [e.direction, e.code]), [['rejected', 100], ['rejected', 190]]);
  assert.equal(comdove.received.length, 0);
});

test('control API errors stay JSON; Meta routes keep Meta envelopes', async () => {
  const miss = await api('GET', '/api/nope');
  assert.equal(miss.status, 404);
  assert.ok(miss.json.error.message);
  const bad = await fetch(`${base}/v23.0/PN-1/messages`, { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer tok-1' }, body: '{bad' });
  assert.equal(bad.status, 400);
  assert.equal(((await bad.json()) as { error: { code: number; type: string } }).error.type, 'OAuthException');
  assert.equal((await api('GET', '/v23.0/WABA-1/message_templates')).json.error.code, 100);
});

test('reset cancels in-flight webhook retries and keeps numbers/groups', async () => {
  comdove.state.failNext = 100; // Comdove keeps failing → the sent webhook sits in retry
  await send('919876543210', 'x');
  await waitFor(() => comdove.received.length >= 1);
  const r = await api('POST', '/reset', {});
  assert.deepEqual(r.json, { ok: true, kept_numbers: true });
  const seen = comdove.received.length;
  await new Promise((res) => setTimeout(res, 120));
  assert.equal(comdove.received.length, seen, 'no retries after reset');
  comdove.state.failNext = 0;
  assert.deepEqual((await api('GET', '/api/log')).json, []);
  assert.equal((await api('GET', '/api/business-numbers')).json.length, 1);
  assert.equal((await api('GET', '/api/groups')).json[0].count, 2);
});
