// Tile actions over /ws → Person 1's lifecycle (src/ws/group-events.ts), through the real
// boot wiring (composeServer + live.attach) against a fake Comdove that verifies
// signatures like wat-backend. Complements live.e2e.test.ts (delivery, queue, reopen).
import '../helpers/memory-db.js';
import { test, before, after, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { composeServer } from '../../src/compose.js';
import { createFakeComdove } from '../../tools/fake-comdove-app.js';
import { listen, waitFor } from '../helpers/http.js';
import { openGroup, type WsClient } from '../helpers/ws-client.js';

const SECRET = 'events-secret';
const BIZ = '918888800001';
const T1 = '919876543210';
const T2 = '919876543211';
let comdove: ReturnType<typeof createFakeComdove>;
let base = '';
let wsUrl = '';
let stop: () => Promise<void>;
const tabs: WsClient[] = [];

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
  stop = async () => { composed.metaFace.dispatcher.cancelAll(); await wss.close(); await m.close(); await c.close(); };
});
after(() => stop());

const api = async (method: string, path: string, body?: unknown, headers: Record<string, string> = {}) => {
  const res = await fetch(base + path, { method, headers: { 'Content-Type': 'application/json', ...headers }, body: body === undefined ? undefined : JSON.stringify(body) });
  const text = await res.text();
  return { status: res.status, json: text ? JSON.parse(text) : null };
};
const comdoveSend = async (to: string, body: string) =>
  (await api('POST', '/v23.0/PN-1/messages', { messaging_product: 'whatsapp', to, type: 'text', text: { body } }, { Authorization: 'Bearer tok' })).json.messages[0].id as string;
const hooks = (wamid?: string) => comdove.received.filter((r) => r.status === 200 && (!wamid || r.wamid === wamid)).map((r) => r.kind);
const tab = async () => { const t = await openGroup(wsUrl, 'alpha'); tabs.push(t); return t; };

beforeEach(async () => {
  await api('POST', '/api/reset', { keep_numbers: false });
  comdove.received.length = 0;
  await api('POST', '/api/business-numbers', { display_number: BIZ, label: 'Sales', phone_number_id: 'PN-1', waba_id: 'W1', token: 'tok' });
  await api('POST', '/api/groups', { name: 'alpha', numbers: [T1, T2], labels: { [T1]: 'Asha' } });
});
afterEach(async () => {
  while (tabs.length) await tabs.pop()!.close();
  await new Promise((r) => setTimeout(r, 20)); // let the server release the lock
});

test('demo 7: message.send → lifecycle.inbound: bubble echoed + signed inbound webhook', async () => {
  const t = await tab();
  t.send({ type: 'message.send', from: T1, to: BIZ, body: 'how much?' });
  const echo = await t.next('message.new');
  assert.deepEqual([echo.number, echo.message.direction, echo.message.body, echo.message.peer], [T1, 'inbound', 'how much?', BIZ]);
  await waitFor(() => hooks().length === 1);
  assert.deepEqual(hooks(), ['inbound']);
  assert.equal(comdove.received[0].signatureValid, true);
  assert.equal((comdove.received[0].payload as any).entry[0].changes[0].value.contacts[0].profile.name, 'Asha');
});

test('demo 3: chat.read → lifecycle.read: read tick + sent/delivered/read webhooks in order', async () => {
  const t = await tab();
  const wamid = await comdoveSend(T1, 'Hello from Comdove');
  await t.next('message.status', (f) => f.wamid === wamid && f.status === 'delivered');
  t.send({ type: 'chat.read', number: T1, peer: BIZ });
  await t.next('message.status', (f) => f.wamid === wamid && f.status === 'read');
  await waitFor(() => hooks(wamid).length === 3);
  assert.deepEqual(hooks(wamid), ['sent', 'delivered', 'read']);
});

test('chat.read accepts the phone_number_id as peer and reads only delivered messages', async () => {
  const t = await tab();
  t.send({ type: 'tile.presence', number: T2, online: false });
  await t.next('tile.presence');
  const a = await comdoveSend(T1, 'to T1');
  const queued = await comdoveSend(T2, 'to offline T2');
  await t.next('message.status', (f) => f.wamid === a && f.status === 'delivered');
  t.send({ type: 'chat.read', number: T1, peer: 'PN-1' });
  await waitFor(() => hooks(a).includes('read'));
  await new Promise((r) => setTimeout(r, 60));
  assert.deepEqual(hooks(queued), ['sent']);
});

test('demo 4: tile.presence off → only sent; on → queue.flush + delivered', async () => {
  const t = await tab();
  t.send({ type: 'tile.presence', number: T2, online: false });
  await t.next('tile.presence', (f) => f.number === T2 && f.online === false);
  const wamid = await comdoveSend(T2, 'Are you there?');
  await waitFor(() => hooks(wamid).length === 1);
  await new Promise((r) => setTimeout(r, 60));
  assert.deepEqual(hooks(wamid), ['sent']);
  assert.equal(t.all('message.new').length, 0);
  t.send({ type: 'tile.presence', number: T2, online: true });
  const flush = await t.next('queue.flush');
  assert.deepEqual([flush.number, flush.messages.map((m: any) => m.wamid)], [T2, [wamid]]);
  await t.next('message.status', (f) => f.wamid === wamid && f.status === 'delivered');
  await waitFor(() => hooks(wamid).length === 2);
  assert.deepEqual(hooks(wamid), ['sent', 'delivered']);
});

test('/api/presence has the same live effect as the tile toggle', async () => {
  const t = await tab();
  assert.equal((await api('POST', '/api/presence', { number: T1, online: false })).json.effective_online, false);
  await t.next('tile.presence', (f) => f.number === T1 && f.online === false);
  const wamid = await comdoveSend(T1, 'queued');
  await waitFor(() => hooks(wamid).length === 1);
  assert.equal((await api('POST', '/api/presence', { number: T1, online: true })).json.effective_online, true);
  await t.next('queue.flush');
  await waitFor(() => hooks(wamid).length === 2);
});

test('/api/presence with the group closed stores the flag only', async () => {
  assert.equal((await api('POST', '/api/presence', { number: T2, online: false })).json.effective_online, false);
  const t = await tab();
  assert.equal(t.snapshot.tiles.find((x: any) => x.number === T2).online, false);
});

test('demo 5: reopened group → chat.read reads the late-delivered messages', async () => {
  const q1 = await comdoveSend(T1, 'while closed 1');
  const q2 = await comdoveSend(T1, 'while closed 2');
  await waitFor(() => hooks(q1).length === 1 && hooks(q2).length === 1);
  const t = await tab();
  await waitFor(() => hooks(q1).length === 2 && hooks(q2).length === 2);
  t.send({ type: 'chat.read', number: T1, peer: BIZ });
  await waitFor(() => hooks(q1).includes('read') && hooks(q2).includes('read'));
  const reads = comdove.received.filter((r) => r.kind === 'read').map((r) => r.wamid);
  assert.deepEqual(reads, [q1, q2], 'read in send order');
});

test('tile.autoreply over /ws is stored and echoed; an API change is pushed to the tile', async () => {
  const t = await tab();
  t.send({ type: 'tile.autoreply', number: T1, mode: 'keyword', delay_ms: 0, rules: [{ keyword: 'price', reply: 'what price?' }] });
  assert.equal((await t.next('tile.autoreply')).mode, 'keyword');
  assert.equal((await api('GET', `/api/customers/${T1}/auto-reply`)).json.rules[0].reply, 'what price?');
  await comdoveSend(T1, 'Our PRICE list');
  const reply = await t.next('message.new', (f) => f.message.direction === 'inbound');
  assert.equal(reply.message.body, 'what price?');
  await api('PUT', `/api/customers/${T1}/auto-reply`, { mode: 'echo', delay_ms: 0, rules: [] });
  assert.equal((await t.next('tile.autoreply', (f) => f.mode === 'echo')).number, T1);
});

test('tile errors: not in group, unknown business, offline tile — nothing sent', async () => {
  const t = await tab();
  t.send({ type: 'message.send', from: '919999999999', to: BIZ, body: 'x' });
  assert.equal((await t.next('error')).code, 'number_not_in_group');
  t.send({ type: 'message.send', from: T1, to: '910000000000', body: 'x' });
  assert.equal((await t.next('error')).code, 'unknown_business');
  t.send({ type: 'chat.read', number: T1, peer: 'nope' });
  assert.equal((await t.next('error')).code, 'unknown_business');
  t.send({ type: 'tile.presence', number: T1, online: false });
  t.send({ type: 'message.send', from: T1, to: BIZ, body: 'x' });
  assert.equal((await t.next('error')).code, 'tile_offline');
  await new Promise((r) => setTimeout(r, 60));
  assert.equal(comdove.received.length, 0);
});
