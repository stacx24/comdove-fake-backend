import { test } from 'node:test';
import assert from 'node:assert/strict';
import { receiver } from './http.js';

test('receiver helper records a POST', async () => {
  const r = await receiver();
  const res = await fetch(r.url, { method: 'POST', body: 'hi' });
  assert.equal(res.status, 200);
  assert.equal(r.received[0].raw.toString(), 'hi');
  await r.close();
});
