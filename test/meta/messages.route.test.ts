import { test } from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import { createMetaRouter, metaNotImplemented } from '../../src/meta/messages.route.js';
import { createLifecycle } from '../../src/core/lifecycle.js';
import type { EnqueueInput } from '../../src/webhooks/dispatcher.js';
import { MemoryRegistry } from '../stubs/registry.js';
import { FakeDelivery, RecordingBus } from '../stubs/bus.js';
import { listen, waitFor } from '../helpers/http.js';

const watBody = { messaging_product: 'whatsapp', to: '919876543210', type: 'text', text: { body: 'Hello from Comdove' } };

async function setup() {
  const registry = new MemoryRegistry().seed({
    business: [{ phone_number_id: 'MOCK-PN-1', token: 't1', waba_id: 'W1' }],
    customers: [{ number: '919876543210' }],
  });
  const jobs: EnqueueInput[] = [];
  const lifecycle = createLifecycle({ registry, bus: new RecordingBus(), dispatcher: { enqueue: (j) => { jobs.push(j); return j as never; } }, statusDelayMs: 0 });
  const delivery = new FakeDelivery('offline');
  const app = express();
  app.get('/health', (_req, res) => { res.json({ status: 'ok' }); });
  app.use('/api', express.Router().get('/ping', (_req, res) => { res.json({ pong: true }); }));
  app.use(createMetaRouter({ registry, lifecycle, delivery }));
  app.use(metaNotImplemented());
  const srv = await listen(app);
  const post = (path: string, body: unknown, headers: Record<string, string> = {}) =>
    fetch(srv.base + path, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer t1', ...headers },
      body: typeof body === 'string' ? body : JSON.stringify(body),
    });
  return { srv, post, registry, jobs, delivery };
}

test('happy path: wat-backend payload → Meta 200 shape, stored, sent queued, then delivered', async () => {
  const { srv, post, registry, jobs, delivery } = await setup();
  const res = await post('/v23.0/MOCK-PN-1/messages', watBody);
  assert.equal(res.status, 200);
  assert.match(res.headers.get('content-type') ?? '', /application\/json/);
  const body = (await res.json()) as { messages: Array<{ id: string }>; contacts: unknown };
  assert.deepEqual(Object.keys(body), ['messaging_product', 'contacts', 'messages']);
  assert.deepEqual(body.contacts, [{ input: '919876543210', wa_id: '919876543210' }]);
  assert.match(body.messages[0].id, /^wamid\.MOCK-[0-9a-f]{24}$/);
  assert.equal(registry.messages[0].wamid, body.messages[0].id);
  assert.deepEqual(jobs.map((j) => j.kind), ['sent']);
  await waitFor(() => delivery.calls.length === 1);
  assert.equal(delivery.calls[0].wamid, body.messages[0].id);
  await srv.close();
});

test('any /vNN.N/ version is accepted', async () => {
  const { srv, post } = await setup();
  for (const v of ['v21.0', 'v23.0', 'v99.9']) assert.equal((await post(`/${v}/MOCK-PN-1/messages`, watBody)).status, 200, v);
  await srv.close();
});

test('non-version prefix falls through to not-implemented', async () => {
  const { srv, post } = await setup();
  const res = await post('/latest/MOCK-PN-1/messages', watBody);
  assert.equal(res.status, 400);
  const e = ((await res.json()) as { error: { code: number; message: string } }).error;
  assert.equal(e.code, 100);
  assert.equal(e.message, '(#100) POST /latest/MOCK-PN-1/messages is not implemented in comdove-mock');
  await srv.close();
});

test('malformed JSON → Meta 400/100 envelope, not an HTML error page', async () => {
  const { srv, post } = await setup();
  const res = await post('/v23.0/MOCK-PN-1/messages', '{"messaging_product":');
  assert.equal(res.status, 400);
  assert.match(res.headers.get('content-type') ?? '', /application\/json/);
  const e = ((await res.json()) as { error: { code: number; type: string; fbtrace_id: string } }).error;
  assert.equal(e.code, 100);
  assert.equal(e.type, 'OAuthException');
  assert.match(e.fbtrace_id, /^MOCK-trace-/);
  await srv.close();
});

test('non-JSON content type → 400/100', async () => {
  const { srv } = await setup();
  const res = await fetch(srv.base + '/v23.0/MOCK-PN-1/messages', { method: 'POST', headers: { Authorization: 'Bearer t1', 'Content-Type': 'text/plain' }, body: 'hi' });
  assert.equal(res.status, 400);
  assert.equal(((await res.json()) as { error: { code: number } }).error.code, 100);
  await srv.close();
});

test('wrong token → 401/190 and the rejection is logged', async () => {
  const { srv, post, registry, jobs } = await setup();
  const res = await post('/v23.0/MOCK-PN-1/messages', watBody, { Authorization: 'Bearer nope' });
  assert.equal(res.status, 401);
  assert.equal(((await res.json()) as { error: { code: number } }).error.code, 190);
  assert.equal(registry.messages.length, 0);
  assert.equal(jobs.length, 0);
  assert.deepEqual(registry.rejected.map((r) => [r.http_status, r.code, r.forced, r.to, r.body]), [[401, 190, false, '919876543210', 'Hello from Comdove']]);
  await srv.close();
});

test('unknown phone_number_id → 400/100/33', async () => {
  const { srv, post } = await setup();
  const res = await post('/v23.0/NOPE/messages', watBody);
  assert.equal(res.status, 400);
  const e = ((await res.json()) as { error: { code: number; error_subcode: number } }).error;
  assert.deepEqual([e.code, e.error_subcode], [100, 33]);
  await srv.close();
});

test('X-Mock-Force-Error returns that error, stores nothing, logs forced', async () => {
  const { srv, post, registry } = await setup();
  const res = await post('/v23.0/MOCK-PN-1/messages', watBody, { 'X-Mock-Force-Error': '130429' });
  assert.equal(res.status, 400);
  assert.equal(((await res.json()) as { error: { code: number } }).error.code, 130429);
  assert.equal(registry.messages.length, 0);
  assert.equal(registry.rejected[0].forced, true);
  await srv.close();
});

test('unregistered recipient → 400/131026', async () => {
  const { srv, post } = await setup();
  const res = await post('/v23.0/MOCK-PN-1/messages', { ...watBody, to: '919999999999' });
  assert.equal(res.status, 400);
  assert.equal(((await res.json()) as { error: { code: number } }).error.code, 131026);
  await srv.close();
});

test('mark-as-read → {success:true}, no webhook, no delivery', async () => {
  const { srv, post, registry, jobs, delivery } = await setup();
  const inb = registry.storeMessage({ wamid: 'wamid.IN', direction: 'inbound', source: 'tile', phone_number_id: 'MOCK-PN-1', customer_number: '919876543210', body: 'hi', at: 1 });
  const res = await post('/v23.0/MOCK-PN-1/messages', { messaging_product: 'whatsapp', status: 'read', message_id: inb.wamid });
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), { success: true });
  assert.equal(jobs.length, 0);
  assert.equal(delivery.calls.length, 0);
  assert.notEqual(registry.getMessage(inb.wamid)?.read_at, null);
  await srv.close();
});

test('other Graph paths → 400/100 not implemented, naming method and path', async () => {
  const { srv } = await setup();
  const cases: Array<[string, string]> = [
    ['GET', '/v23.0/WABA/message_templates?fields=name'],
    ['POST', '/v23.0/MOCK-PN-1/media'],
    ['POST', '/v23.0/WABA/subscribed_apps'],
    ['GET', '/v23.0/MOCK-PN-1/messages'],
  ];
  for (const [method, path] of cases) {
    const res = await fetch(srv.base + path, { method, headers: { Authorization: 'Bearer t1' } });
    assert.equal(res.status, 400, `${method} ${path}`);
    const e = ((await res.json()) as { error: { code: number; message: string } }).error;
    assert.equal(e.code, 100);
    assert.equal(e.message, `(#100) ${method} ${path.split('?')[0]} is not implemented in comdove-mock`);
  }
  await srv.close();
});

test('routes mounted before the Meta router still work', async () => {
  const { srv } = await setup();
  assert.deepEqual(await (await fetch(srv.base + '/health')).json(), { status: 'ok' });
  assert.deepEqual(await (await fetch(srv.base + '/api/ping')).json(), { pong: true });
  await srv.close();
});
