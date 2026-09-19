// End-to-end: the real app (Meta router + lifecycle + dispatcher) against a fake Comdove
// that verifies signatures exactly like wat-backend. P2/P3 are the in-memory stand-ins.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createApp } from '../../src/app.js';
import { createMetaFace } from '../../src/meta-face.js';
import { MemoryJobStore } from '../../src/webhooks/job-store.js';
import { MemoryRegistry } from '../../src/dev/memory-registry.js';
import { FakeDelivery, RecordingBus } from '../../src/dev/memory-bus.js';
import { createFakeComdove } from '../../tools/fake-comdove-app.js';
import { listen, waitFor } from '../helpers/http.js';

const SECRET = 'e2e-secret';
const DELAY = 120;
const watBody = { messaging_product: 'whatsapp', to: '919876543210', type: 'text', text: { body: 'Hello from Comdove' } };

async function boot(opts: { failNext?: number; online?: boolean } = {}) {
  const comdove = createFakeComdove({ appSecret: SECRET, verifyToken: 'e2e-verify', failNext: opts.failNext });
  const comdoveSrv = await listen(comdove.app);
  const registry = new MemoryRegistry().seed({
    business: [{ phone_number_id: 'MOCK-PN-1', display_number: '918888800001', token: 't1', waba_id: 'W1' }],
    customers: [{ number: '919876543210' }],
  });
  const bus = new RecordingBus();
  let delivered: (m: Parameters<FakeDelivery['deliver']>[0]) => void = () => {};
  const delivery = new FakeDelivery(opts.online === false ? 'offline' : 'online', (m) => delivered(m));
  const jobStore = new MemoryJobStore();
  const face = createMetaFace({
    registry, bus, delivery, jobStore,
    webhookUrl: `${comdoveSrv.base}/webhooks/whatsapp`,
    appSecret: SECRET,
    verifyToken: 'e2e-verify',
    statusDelayMs: DELAY,
    dispatcher: { retryDelaysMs: [20, 20, 20], timeoutMs: 500 },
  });
  delivered = (m) => face.lifecycle.delivered([m]);
  const mock = await listen(createApp({ metaFace: face }));
  const send = (body: unknown = watBody, auth = 'Bearer t1') =>
    fetch(`${mock.base}/v23.0/MOCK-PN-1/messages`, { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: auth }, body: JSON.stringify(body) });
  const close = async () => { face.dispatcher.cancelAll(); await mock.close(); await comdoveSrv.close(); };
  return { comdove, face, registry, bus, jobStore, send, close };
}

type Payload = { entry: Array<{ id: string; changes: Array<{ value: { statuses?: Array<{ status: string; recipient_id: string }>; messages?: unknown[] } }> }> };

test('demo step 3: send → Meta 200 → Comdove gets signed sent, delivered, read in order', async () => {
  const s = await boot();
  assert.equal((await s.face.verify()).ok, true);

  const t0 = Date.now();
  const res = await s.send();
  assert.equal(res.status, 200);
  const wamid = ((await res.json()) as { messages: Array<{ id: string }> }).messages[0].id;

  await waitFor(() => s.comdove.received.length === 2);
  s.face.lifecycle.read('919876543210', '918888800001');
  await waitFor(() => s.comdove.received.length === 3);

  assert.deepEqual(s.comdove.received.map((r) => [r.kind, r.wamid, r.signatureValid, r.status]), [
    ['sent', wamid, true, 200],
    ['delivered', wamid, true, 200],
    ['read', wamid, true, 200],
  ]);
  assert.ok(s.comdove.received[0].at - t0 >= DELAY - 5, 'first status waits STATUS_WEBHOOK_DELAY_MS');
  const p = s.comdove.received[0].payload as Payload;
  assert.equal(p.entry[0].id, 'W1');
  assert.equal(p.entry[0].changes[0].value.statuses?.[0].recipient_id, '919876543210');
  assert.equal(s.bus.ofType('webhook.verify')[0].ok, true);
  await s.close();
});

test('demo step 7: a tile reply reaches Comdove as a signed inbound webhook', async () => {
  const s = await boot();
  const m = s.face.lifecycle.inbound('919876543210', '918888800001', 'how much?', 'tile');
  await waitFor(() => s.comdove.received.length === 1);
  const r = s.comdove.received[0];
  assert.deepEqual([r.kind, r.wamid, r.signatureValid, r.status], ['inbound', m.wamid, true, 200]);
  await s.close();
});

test('demo step 9: bad token → Meta 401/190, nothing reaches Comdove', async () => {
  const s = await boot();
  const res = await s.send(watBody, 'Bearer wrong');
  assert.equal(res.status, 401);
  assert.equal(((await res.json()) as { error: { code: number } }).error.code, 190);
  await new Promise((r) => setTimeout(r, DELAY + 50));
  assert.equal(s.comdove.received.length, 0);
  assert.equal(s.registry.rejected.length, 1);
  await s.close();
});

test('offline tile: only sent fires until delivery is reported', async () => {
  const s = await boot({ online: false });
  const res = await s.send();
  const wamid = ((await res.json()) as { messages: Array<{ id: string }> }).messages[0].id;
  await waitFor(() => s.comdove.received.length === 1);
  await new Promise((r) => setTimeout(r, 60));
  assert.deepEqual(s.comdove.received.map((r) => r.kind), ['sent']);
  s.face.lifecycle.delivered([s.registry.getMessage(wamid)!]); // P3 flush when the tile comes online
  await waitFor(() => s.comdove.received.length === 2);
  assert.deepEqual(s.comdove.received.map((r) => r.kind), ['sent', 'delivered']);
  await s.close();
});

test('Comdove returning 503 is retried; order is kept; attempts are recorded', async () => {
  const s = await boot({ failNext: 2 });
  const res = await s.send();
  const wamid = ((await res.json()) as { messages: Array<{ id: string }> }).messages[0].id;
  await waitFor(() => s.comdove.received.filter((r) => r.status === 200).length === 2);
  assert.deepEqual(s.comdove.received.map((r) => [r.kind, r.status]), [
    ['sent', 503],
    ['sent', 503],
    ['sent', 200],
    ['delivered', 200],
  ]);
  const sentJob = s.jobStore.jobsFor(wamid).find((j) => j.kind === 'sent')!;
  assert.deepEqual(s.jobStore.attempts(sentJob.id).map((a) => a.http_status), [503, 503, 200]);
  assert.ok(s.bus.ofType('log.changed').length >= 5);
  await s.close();
});
