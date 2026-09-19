// Admin feed + reset hook through the real boot wiring (composeServer + live.attach)
// against a signature-checking fake Comdove. Completes checkpoint ②.
import '../helpers/memory-db.js';
import { test, before, after, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { composeServer } from '../../src/compose.js';
import { createFakeComdove } from '../../tools/fake-comdove-app.js';
import { listen, waitFor } from '../helpers/http.js';
import { openGroup, wsClient, type Frame, type WsClient } from '../helpers/ws-client.js';
import { sharedLock } from '../../src/ws/shared-lock.js';

const SECRET = 'admin-secret';
const BIZ = '918888800001';
const T1 = '919876543210';
const T2 = '919876543211';
let comdove: ReturnType<typeof createFakeComdove>;
let base = '';
let wsUrl = '';
let stop: () => Promise<void>;
const clients: WsClient[] = [];

before(async () => {
  comdove = createFakeComdove({ appSecret: SECRET, verifyToken: 'v' });
  const c = await listen(comdove.app);
  const composed = composeServer({
    env: { COMDOVE_WEBHOOK_URL: `${c.base}/webhooks/whatsapp`, APP_SECRET: SECRET, WEBHOOK_VERIFY_TOKEN: 'v', STATUS_WEBHOOK_DELAY_MS: 30 },
    dispatcher: { retryDelaysMs: [10, 10, 10], timeoutMs: 500 },
    log: () => {},
  });
  const m = await listen(composed.app);
  const wss = composed.live.attach(m.server, { heartbeatMs: 60_000 });
  base = m.base;
  wsUrl = `${m.base.replace('http', 'ws')}/ws`;
  stop = async () => {
    composed.metaFace.dispatcher.cancelAll();
    await wss.close();
    await m.close();
    await c.close();
  };
});
after(() => stop());

const api = async (method: string, path: string, body?: unknown, headers: Record<string, string> = {}) => {
  const res = await fetch(base + path, { method, headers: { 'Content-Type': 'application/json', ...headers }, body: body === undefined ? undefined : JSON.stringify(body) });
  const text = await res.text();
  return { status: res.status, json: text ? JSON.parse(text) : null };
};
const comdoveSend = async (to: string, body: string) =>
  (await api('POST', '/v23.0/PN-1/messages', { messaging_product: 'whatsapp', to, type: 'text', text: { body } }, { Authorization: 'Bearer tok' })).json.messages[0].id as string;

beforeEach(async () => {
  await api('POST', '/api/reset', { keep_numbers: false });
  comdove.received.length = 0;
  assert.equal((await api('POST', '/api/business-numbers', { display_number: BIZ, label: 'Sales', phone_number_id: 'PN-1', waba_id: 'WABA-1', token: 'tok' })).status, 200);
  assert.equal((await api('POST', '/api/groups', { name: 'alpha', numbers: [T1, T2] })).status, 200);
});

afterEach(async () => {
  while (clients.length) await clients.pop()!.close();
  await waitFor(() => !sharedLock.isLocked('alpha'));
});

/** An admin page: subscribes and reads past the two initial lists. */
async function admin() {
  const c = await wsClient(wsUrl);
  clients.push(c);
  c.send({ type: 'admin.subscribe' });
  await c.next('groups.update');
  await c.next('numbers.update');
  return c;
}
async function tab(group = 'alpha') {
  const t = await openGroup(wsUrl, group);
  clients.push(t);
  return t;
}

test('subscribing sends the current groups and numbers', async () => {
  const c = await wsClient(wsUrl);
  clients.push(c);
  c.send({ type: 'admin.subscribe' });
  const g = await c.next('groups.update');
  assert.deepEqual(g.groups.map((x: Frame) => [x.id, x.status]), [['alpha', 'free']]);
  const n = await c.next('numbers.update');
  assert.deepEqual(n.business_numbers.map((b: Frame) => b.phone_number_id), ['PN-1']);
  assert.deepEqual(n.customers.map((x: Frame) => x.number), [T1, T2]);
});

test('live log: log.entry when Comdove sends, then log.update until delivered with both webhooks ok', async () => {
  const a = await admin();
  await tab();
  const wamid = await comdoveSend(T1, 'Hello');
  const first = await a.next('log.entry', (f) => f.entry.wamid === wamid);
  assert.equal(first.entry.body, 'Hello');
  const done = await a.next(
    'log.update',
    (f) => f.entry.wamid === wamid && f.entry.status === 'delivered' && f.entry.webhooks.length === 2 && f.entry.webhooks.every((w: Frame) => w.state === 'ok'),
  );
  assert.deepEqual(done.entry.timeline.map((t: Frame) => t.status), ['sent', 'delivered']);
});

test('a reply typed in a tile appears in the log as an inbound entry', async () => {
  const a = await admin();
  const t = await tab();
  t.send({ type: 'message.send', from: T1, to: BIZ, body: 'how much?' });
  const e = await a.next('log.entry', (f) => f.entry.direction === 'inbound');
  assert.deepEqual([e.entry.body, e.entry.source, e.entry.from], ['how much?', 'tile', T1]);
});

test('opening and closing a group updates the launch list live', async () => {
  const a = await admin();
  const t = await tab();
  const locked = await a.next('groups.update', (f) => f.groups[0]?.status === 'locked');
  assert.equal(typeof locked.groups[0].locked_since, 'number');
  await a.next('numbers.update', (f) => f.customers.every((c: Frame) => c.claim_status === 'locked'));
  await t.close();
  await a.next('groups.update', (f) => f.groups[0]?.status === 'free');
});

test('control-API changes reach admins: new group, new number, presence', async () => {
  const a = await admin();
  assert.equal((await api('POST', '/api/groups', { name: 'beta', numbers: ['919876543220'] })).status, 200);
  await a.next('groups.update', (f) => f.groups.some((g: Frame) => g.id === 'beta'));
  await a.next('numbers.update', (f) => f.customers.some((c: Frame) => c.number === '919876543220'));
  assert.equal((await api('POST', '/api/business-numbers', { display_number: '918888800002', label: 'Support' })).status, 200);
  await a.next('numbers.update', (f) => f.business_numbers.length === 2);
  await api('POST', '/api/presence', { number: T2, online: false });
  await a.next('numbers.update', (f) => f.customers.find((c: Frame) => c.number === T2)?.online === false);
});

test('the webhook handshake result reaches admins', async () => {
  const a = await admin();
  const r = await api('POST', '/api/webhook/verify');
  const v = await a.next('webhook.verify');
  assert.equal(v.ok, true);
  assert.equal(v.ok, r.json.ok);
});

test('reset keeping numbers: log.reset to admins, a fresh empty snapshot to the open tab, lock kept', async () => {
  const a = await admin();
  const t = await tab();
  await comdoveSend(T1, 'Hello');
  await t.next('message.new');
  assert.equal((await api('POST', '/api/reset', {})).status, 200);
  await a.next('log.reset');
  const snap = await t.next('group.claimed');
  assert.deepEqual(snap.tiles.find((x: Frame) => x.number === T1).history, []);
  assert.equal(sharedLock.isLocked('alpha'), true);
  assert.deepEqual((await api('GET', '/api/log')).json, []);
});

test('reset wiping numbers: the open tab gets group_deleted and is closed; the group is free', async () => {
  const a = await admin();
  const t = await tab();
  assert.equal((await api('POST', '/api/reset', { keep_numbers: false })).status, 200);
  const err = await t.next('error');
  assert.equal(err.code, 'group_deleted');
  assert.equal(sharedLock.isLocked('alpha'), false);
  await waitFor(() => t.socket.readyState === 3); // CLOSED
  await a.next('groups.update', (f) => f.groups.length === 0);
});
