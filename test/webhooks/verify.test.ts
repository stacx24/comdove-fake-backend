import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runHandshake } from '../../src/webhooks/verify.js';
import { deadUrl, receiver } from '../helpers/http.js';

// Mirrors wat-backend webhook-whatsapp.ts GET handler.
function comdoveLike(token: string) {
  return receiver((r) => {
    const q = new URL(r.url, 'http://x').searchParams;
    if (q.get('hub.mode') === 'subscribe' && q.get('hub.verify_token') === token) {
      return { status: 200, body: q.get('hub.challenge') ?? '' };
    }
    return 403;
  });
}

test('matching token → ok, all three hub params sent', async () => {
  const r = await comdoveLike('mock-verify-1');
  const res = await runHandshake(r.url, 'mock-verify-1');
  assert.equal(res.ok, true);
  assert.equal(r.received[0].method, 'GET');
  const q = new URL(r.received[0].url, 'http://x').searchParams;
  assert.equal(q.get('hub.mode'), 'subscribe');
  assert.equal(q.get('hub.verify_token'), 'mock-verify-1');
  assert.match(q.get('hub.challenge') ?? '', /^\d{10}$/);
  await r.close();
});

test('token is URL-encoded', async () => {
  const r = await comdoveLike('a&b=c d');
  assert.equal((await runHandshake(r.url, 'a&b=c d')).ok, true);
  await r.close();
});

test('403 → not ok, detail names the status', async () => {
  const r = await comdoveLike('right');
  const res = await runHandshake(r.url, 'wrong');
  assert.equal(res.ok, false);
  assert.match(res.detail, /403/);
  await r.close();
});

test('200 with the wrong body → not ok', async () => {
  const r = await receiver(() => ({ status: 200, body: 'nope' }));
  const res = await runHandshake(r.url, 'x');
  assert.equal(res.ok, false);
  assert.match(res.detail, /challenge/);
  await r.close();
});

test('Comdove down → not ok, never throws', async () => {
  const res = await runHandshake(await deadUrl(), 'x');
  assert.equal(res.ok, false);
  assert.match(res.detail, /ECONNREFUSED/);
  assert.equal(typeof res.at, 'number');
});

test('hanging Comdove → times out, not ok', async () => {
  const r = await receiver(() => 'hang');
  const res = await runHandshake(r.url, 'x', { timeoutMs: 100 });
  assert.equal(res.ok, false);
  assert.match(res.detail, /timeout/);
  await r.close();
});
