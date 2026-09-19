import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createFakeComdove } from '../../tools/fake-comdove-app.js';
import { createDispatcher } from '../../src/webhooks/dispatcher.js';
import { MemoryJobStore } from '../../src/webhooks/job-store.js';
import { runHandshake } from '../../src/webhooks/verify.js';
import { statusEnvelope } from '../../src/webhooks/envelopes.js';
import { listen } from '../helpers/http.js';

const business = { phone_number_id: 'MOCK-PN-1', display_number: '918888800001', label: null, token: 't', waba_id: 'W1' };

test('fake Comdove accepts the mock’s handshake and signed webhooks', async () => {
  const fc = createFakeComdove({ appSecret: 's3cret', verifyToken: 'v1' });
  const srv = await listen(fc.app);
  const url = `${srv.base}/webhooks/whatsapp`;
  assert.equal((await runHandshake(url, 'v1')).ok, true);
  assert.equal((await runHandshake(url, 'wrong')).ok, false);

  const store = new MemoryJobStore();
  const d = createDispatcher({ url, secret: 's3cret', store, retryDelaysMs: [5, 5, 5] });
  d.enqueue({ conversation_id: 1, wamid: 'w1', kind: 'delivered', body: statusEnvelope({ business, wamid: 'w1', status: 'delivered', at: 0, recipient: '1' }) });
  await d.idle();
  assert.deepEqual(fc.received.map((r) => [r.signatureValid, r.status, r.kind, r.wamid]), [[true, 200, 'delivered', 'w1']]);
  await srv.close();
});

test('fake Comdove rejects a wrong secret with 401 and can fail on demand', async () => {
  const fc = createFakeComdove({ appSecret: 'right', verifyToken: 'v', failNext: 2 });
  const srv = await listen(fc.app);
  const url = `${srv.base}/webhooks/whatsapp`;
  const bad = createDispatcher({ url, secret: 'wrong', store: new MemoryJobStore(), retryDelaysMs: [] });
  bad.enqueue({ conversation_id: 1, wamid: 'x', kind: 'sent', body: { a: 1 } });
  await bad.idle();
  assert.deepEqual(fc.received.map((r) => [r.signatureValid, r.status]), [[false, 401]]);

  const store = new MemoryJobStore();
  const good = createDispatcher({ url, secret: 'right', store, retryDelaysMs: [5, 5, 5] });
  const job = good.enqueue({ conversation_id: 1, wamid: 'y', kind: 'sent', body: { a: 1 } });
  await good.idle();
  assert.deepEqual(store.attempts(job.id).map((a) => a.http_status), [503, 503, 200]);
  await srv.close();
});
