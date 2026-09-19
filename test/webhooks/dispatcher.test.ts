import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createDispatcher, type DispatcherOptions } from '../../src/webhooks/dispatcher.js';
import { MemoryJobStore, type Job } from '../../src/webhooks/job-store.js';
import { deadUrl, receiver, waitFor, type Received } from '../helpers/http.js';
import { verifyMetaSignature } from '../helpers/verify-meta-signature.js';

const SECRET = 'mock-app-secret-1';
const fast = { retryDelaysMs: [10, 20, 30], timeoutMs: 150 };
const tag = (r: Received) => (JSON.parse(r.raw.toString()) as { tag: string }).tag;

function make(url: string, over: Partial<DispatcherOptions> = {}) {
  const store = new MemoryJobStore();
  const changes: Job[] = [];
  const d = createDispatcher({ url, secret: SECRET, store, ...fast, onChange: (j) => changes.push(j), ...over });
  return { d, store, changes };
}

test('1. 200 → one signed request with the stored bytes, job ok', async () => {
  const r = await receiver();
  const { d, store } = make(r.url);
  const job = d.enqueue({ conversation_id: 1, wamid: 'w1', kind: 'sent', body: { tag: 'a', text: 'héllo 👋' } });
  await d.idle();
  assert.equal(r.received.length, 1);
  const req = r.received[0];
  assert.equal(req.method, 'POST');
  assert.equal(req.headers['content-type'], 'application/json');
  assert.equal(verifyMetaSignature(req.raw, req.headers['x-hub-signature-256'] as string, SECRET), true);
  assert.equal(req.raw.toString(), store.get(job.id)?.payload);
  assert.equal(req.headers['x-local-test'], undefined);
  assert.equal(store.get(job.id)?.state, 'ok');
  assert.deepEqual(store.attempts(job.id).map((a) => a.http_status), [200]);
  await r.close();
});

test('2. 500, 500, 200 → three attempts, ok', async () => {
  const r = await receiver((_req, n) => (n < 3 ? 500 : 200));
  const { d, store } = make(r.url);
  const job = d.enqueue({ conversation_id: 1, wamid: 'w1', kind: 'sent', body: { tag: 'a' } });
  await d.idle();
  assert.deepEqual(store.attempts(job.id).map((a) => a.http_status), [500, 500, 200]);
  assert.equal(store.get(job.id)?.state, 'ok');
  await r.close();
});

test('3. always 503 → exactly 4 attempts, failed, then the next job runs', async () => {
  const r = await receiver((req) => (tag(req) === 'first' ? 503 : 200));
  const { d, store } = make(r.url);
  const first = d.enqueue({ conversation_id: 1, wamid: 'w1', kind: 'sent', body: { tag: 'first' } });
  const next = d.enqueue({ conversation_id: 1, wamid: 'w1', kind: 'delivered', body: { tag: 'next' } });
  await d.idle();
  assert.equal(store.attempts(first.id).length, 4);
  assert.equal(store.get(first.id)?.state, 'failed');
  assert.equal(store.get(next.id)?.state, 'ok');
  assert.deepEqual(r.received.map(tag), ['first', 'first', 'first', 'first', 'next']);
  await r.close();
});

test('4. only HTTP 200 counts as success (201 is retried)', async () => {
  const r = await receiver((_req, n) => (n === 1 ? 201 : 200));
  const { d, store } = make(r.url);
  const job = d.enqueue({ conversation_id: 1, wamid: 'w1', kind: 'sent', body: { tag: 'a' } });
  await d.idle();
  assert.deepEqual(store.attempts(job.id).map((a) => a.http_status), [201, 200]);
  await r.close();
});

test('5. a hanging receiver times out and is retried', async () => {
  const r = await receiver((_req, n) => (n === 1 ? 'hang' : 200));
  const { d, store } = make(r.url);
  const job = d.enqueue({ conversation_id: 1, wamid: 'w1', kind: 'sent', body: { tag: 'a' } });
  await d.idle();
  const [first, second] = store.attempts(job.id);
  assert.equal(first.http_status, null);
  assert.equal(first.error, 'timeout');
  assert.ok(first.duration_ms >= 140);
  assert.equal(second.http_status, 200);
  await r.close();
});

test('6. connection refused is recorded and retried, then failed', async () => {
  const { d, store } = make(await deadUrl());
  const job = d.enqueue({ conversation_id: 1, wamid: 'w1', kind: 'sent', body: { tag: 'a' } });
  await d.idle();
  const attempts = store.attempts(job.id);
  assert.equal(attempts.length, 4);
  assert.ok(attempts.every((a) => a.http_status === null && a.error));
  assert.match(attempts[0].error ?? '', /ECONNREFUSED/);
  assert.equal(store.get(job.id)?.state, 'failed');
});

test('7. FIFO per conversation; other conversations are not blocked', async () => {
  let aSentFailed = false;
  const r = await receiver((req) => {
    if (tag(req) === 'A-sent' && !aSentFailed) {
      aSentFailed = true;
      return 500;
    }
    return 200;
  });
  const { d } = make(r.url, { retryDelaysMs: [60, 60, 60] });
  d.enqueue({ conversation_id: 1, wamid: 'a', kind: 'sent', body: { tag: 'A-sent' } });
  d.enqueue({ conversation_id: 1, wamid: 'a', kind: 'delivered', body: { tag: 'A-delivered' } });
  d.enqueue({ conversation_id: 2, wamid: 'b', kind: 'inbound', body: { tag: 'B-inbound' } });
  await d.idle();
  const order = r.received.map(tag);
  assert.deepEqual(order.filter((t) => t.startsWith('A')), ['A-sent', 'A-sent', 'A-delivered']);
  assert.ok(order.indexOf('B-inbound') < order.lastIndexOf('A-sent'), `B waited for A: ${order}`);
  await r.close();
});

test('8. notBefore delays the head job and everything behind it', async () => {
  const r = await receiver();
  const { d } = make(r.url);
  const t0 = Date.now();
  d.enqueue({ conversation_id: 1, wamid: 'a', kind: 'sent', body: { tag: 'sent' }, notBefore: t0 + 80 });
  d.enqueue({ conversation_id: 1, wamid: 'a', kind: 'delivered', body: { tag: 'delivered' } });
  await d.idle();
  assert.deepEqual(r.received.map(tag), ['sent', 'delivered']);
  assert.ok(r.received[0].at - t0 >= 75, `sent after ${r.received[0].at - t0}ms`);
  await r.close();
});

test('9. retries resend identical bytes and signature', async () => {
  const r = await receiver((_req, n) => (n < 3 ? 500 : 200));
  const { d } = make(r.url);
  d.enqueue({ conversation_id: 1, wamid: 'w', kind: 'inbound', body: { tag: 'a', n: Math.random() } });
  await d.idle();
  const raws = new Set(r.received.map((x) => x.raw.toString()));
  const sigs = new Set(r.received.map((x) => x.headers['x-hub-signature-256']));
  assert.equal(r.received.length, 3);
  assert.equal(raws.size, 1);
  assert.equal(sigs.size, 1);
  await r.close();
});

test('10. cancelAll during backoff stops further requests', async () => {
  const r = await receiver(() => 500);
  const { d } = make(r.url, { retryDelaysMs: [200, 200, 200] });
  d.enqueue({ conversation_id: 1, wamid: 'w', kind: 'sent', body: { tag: 'a' } });
  d.enqueue({ conversation_id: 1, wamid: 'w', kind: 'delivered', body: { tag: 'b' } });
  await waitFor(() => r.received.length === 1);
  d.cancelAll();
  await d.idle();
  await new Promise((res) => setTimeout(res, 250));
  assert.equal(r.received.length, 1);
  await r.close();
});

test('10b. cancelAll aborts an in-flight request; the dispatcher keeps working after', async () => {
  const r = await receiver((req) => (tag(req) === 'hang' ? 'hang' : 200));
  const { d } = make(r.url, { timeoutMs: 5000 });
  d.enqueue({ conversation_id: 1, wamid: 'w', kind: 'sent', body: { tag: 'hang' } });
  await waitFor(() => r.received.length === 1);
  d.cancelAll();
  await d.idle();
  d.enqueue({ conversation_id: 1, wamid: 'w2', kind: 'sent', body: { tag: 'after' } });
  await d.idle();
  assert.deepEqual(r.received.map(tag), ['hang', 'after']);
  await r.close();
});

test('11. resume() sends pending store jobs in id order', async () => {
  const r = await receiver();
  const store = new MemoryJobStore();
  const base = { conversation_id: 1, wamid: 'w', kind: 'sent' as const, not_before: 0, created_at: 1 };
  store.insert({ ...base, payload: JSON.stringify({ tag: 'one' }) });
  const done = store.insert({ ...base, payload: JSON.stringify({ tag: 'done' }) });
  store.finish(done.id, 'ok', 2);
  store.insert({ ...base, conversation_id: 2, payload: JSON.stringify({ tag: 'two' }) });
  store.insert({ ...base, payload: JSON.stringify({ tag: 'three' }) });
  const d = createDispatcher({ url: r.url, secret: SECRET, store, ...fast });
  d.resume();
  await d.idle();
  const order = r.received.map(tag);
  assert.deepEqual(order.filter((t) => t !== 'two'), ['one', 'three']);
  assert.ok(order.includes('two'));
  assert.equal(order.includes('done'), false);
  assert.equal(store.pending().length, 0);
  await r.close();
});

test('12. onChange fires for every attempt and every finish', async () => {
  const r = await receiver((_req, n) => (n === 1 ? 500 : 200));
  const { d, changes } = make(r.url);
  d.enqueue({ conversation_id: 1, wamid: 'w', kind: 'sent', body: { tag: 'a' } });
  await d.idle();
  // attempt 1, attempt 2, finish
  assert.equal(changes.length, 3);
  assert.equal(changes.at(-1)?.state, 'ok');
  await r.close();
});

test('idle() resolves immediately when nothing is queued', async () => {
  const { d } = make(await deadUrl());
  await d.idle();
});
