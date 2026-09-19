// P1 + P2 + P3 integrated: a signature-checking fake Comdove → Meta face → SQLite → live
// delivery over a real /ws socket. Checkpoint ①: a Comdove send shows in the open tile in
// < 1 s and only then fires 'delivered'; a closed group queues until it is reopened.
import '../helpers/memory-db.js';
import { test, before, after, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { WebSocket } from 'ws';
import { composeServer } from '../../src/compose.js';
import { createFakeComdove } from '../../tools/fake-comdove-app.js';
import { listen, waitFor } from '../helpers/http.js';
import { sharedLock } from '../../src/ws/shared-lock.js';

type Frame = Record<string, any>;

const SECRET = 'live-secret';
const SALES = '918888800001';
const T1 = '919876543210';
const T2 = '919876543211';

let comdove: ReturnType<typeof createFakeComdove>;
let base = '';
let closeAll: () => Promise<void>;
const tabs: WebSocket[] = [];

before(async () => {
  comdove = createFakeComdove({ appSecret: SECRET, verifyToken: 'live-verify' });
  const c = await listen(comdove.app);
  const composed = composeServer({
    env: { COMDOVE_WEBHOOK_URL: `${c.base}/webhooks/whatsapp`, APP_SECRET: SECRET, WEBHOOK_VERIFY_TOKEN: 'live-verify', STATUS_WEBHOOK_DELAY_MS: 30 },
    dispatcher: { retryDelaysMs: [10, 10, 10], timeoutMs: 500 },
    log: () => {},
  });
  const m = await listen(composed.app);
  const wss = composed.live.attach(m.server, { heartbeatMs: 60_000 });
  base = m.base;
  closeAll = async () => {
    composed.metaFace.dispatcher.cancelAll();
    await wss.close();
    await m.close();
    await c.close();
  };
});
after(() => closeAll());

const api = async (method: string, path: string, body?: unknown, headers: Record<string, string> = {}) => {
  const res = await fetch(base + path, { method, headers: { 'Content-Type': 'application/json', ...headers }, body: body === undefined ? undefined : JSON.stringify(body) });
  const text = await res.text();
  return { status: res.status, json: text ? JSON.parse(text) : null };
};
const send = (to: string, text: string) =>
  api('POST', '/v23.0/PN-1/messages', { messaging_product: 'whatsapp', to, type: 'text', text: { body: text } }, { Authorization: 'Bearer tok-1' });
const received = () => comdove.received.filter((r) => r.status === 200).map((r) => [r.kind, r.wamid]);
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

beforeEach(async () => {
  await api('POST', '/api/reset', { keep_numbers: false });
  comdove.received.length = 0;
  assert.equal((await api('POST', '/api/business-numbers', { display_number: SALES, label: 'Sales', phone_number_id: 'PN-1', waba_id: 'WABA-1', token: 'tok-1' })).status, 200);
  assert.equal((await api('POST', '/api/groups', { name: 'alpha', numbers: [T1, T2] })).status, 200);
});

afterEach(async () => {
  for (const t of tabs.splice(0)) t.close();
  await waitFor(() => !sharedLock.isLocked('alpha'));
});

/** A browser tab that claims `group` and records every frame it receives. */
async function openTab(group = 'alpha') {
  const ws = new WebSocket(base.replace('http', 'ws') + '/ws');
  tabs.push(ws);
  const frames: Frame[] = [];
  ws.on('message', (data) => frames.push(JSON.parse(String(data)) as Frame));
  await new Promise((resolve, reject) => {
    ws.once('open', resolve);
    ws.once('error', reject);
  });
  ws.send(JSON.stringify({ type: 'group.claim', group }));
  await waitFor(() => frames.length > 0);
  assert.equal(frames[0]?.type, 'group.claimed');
  return { ws, frames, of: (type: string) => frames.filter((f) => f.type === type) };
}

test('online tile: message.new in < 1 s, then the delivered tick and sent + delivered webhooks', async () => {
  const tab = await openTab();
  const t0 = Date.now();
  const r = await send(T1, 'Hello');
  const wamid = r.json.messages[0].id;
  await waitFor(() => tab.of('message.new').length === 1);
  assert.ok(Date.now() - t0 < 1000, 'reached the tile in under a second');
  const bubble = tab.of('message.new')[0]!;
  assert.deepEqual([bubble.to, bubble.number], [T1, T1]);
  assert.deepEqual(
    [bubble.message.wamid, bubble.message.peer, bubble.message.direction, bubble.message.body],
    [wamid, SALES, 'outbound', 'Hello'],
  );
  await waitFor(() => tab.of('message.status').some((f) => f.wamid === wamid && f.status === 'delivered'));
  await waitFor(() => received().length === 2);
  assert.deepEqual(received(), [['sent', wamid], ['delivered', wamid]]);
  assert.ok(comdove.received.every((x) => x.signatureValid));
});

test('closed group: messages queue; reopening shows them in queued and delivers them in order', async () => {
  const a = await send(T1, 'first');
  const b = await send(T1, 'second');
  await waitFor(() => received().length === 2);
  await sleep(80);
  assert.deepEqual(received().map((x) => x[0]), ['sent', 'sent']);

  const tab = await openTab();
  const tile = (tab.frames[0]!.tiles as Frame[]).find((t) => t.number === T1)!;
  assert.deepEqual(tile.queued.map((m: Frame) => m.body), ['first', 'second']);
  assert.deepEqual(tile.history, []);

  await waitFor(() => received().length === 4);
  assert.deepEqual(received().slice(2), [
    ['delivered', a.json.messages[0].id],
    ['delivered', b.json.messages[0].id],
  ]);
  await waitFor(() => tab.of('message.status').length === 2);
  assert.equal(tab.of('message.new').length, 0, 'queued messages come in the snapshot, not as message.new');
});

test('a tile switched off keeps its messages queued even while the group is open', async () => {
  await api('POST', '/api/presence', { number: T2, online: false });
  const tab = await openTab();
  const r = await send(T2, 'are you there?');
  await waitFor(() => received().length === 1);
  await sleep(80);
  assert.deepEqual(received(), [['sent', r.json.messages[0].id]]);
  assert.equal(tab.of('message.new').length, 0);
});

test('/api/inject shows the inbound message in the open tile', async () => {
  const tab = await openTab();
  const r = await api('POST', '/api/inject', { from: T1, to: SALES, body: 'how much?' });
  assert.equal(r.status, 200);
  await waitFor(() => tab.of('message.new').length === 1);
  const f = tab.of('message.new')[0]!;
  assert.deepEqual(
    [f.to, f.number, f.message.wamid, f.message.direction, f.message.peer, f.message.body],
    [SALES, T1, r.json.wamid, 'inbound', SALES, 'how much?'],
  );
});

test('the launch list shows the group locked while a tab holds it', async () => {
  assert.equal((await api('GET', '/api/groups')).json[0].status, 'free');
  const tab = await openTab();
  const g = (await api('GET', '/api/groups')).json[0];
  assert.equal(g.status, 'locked');
  assert.equal(typeof g.locked_since, 'number');
  tab.ws.close();
  await waitFor(() => !sharedLock.isLocked('alpha'));
  assert.equal((await api('GET', '/api/groups')).json[0].status, 'free');
});
