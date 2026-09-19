// Number rules from TEAM-SPLIT.md "Shared rules": digits only after stripping +, spaces
// and dashes; 8–15 digits. Bad input is a 400; a real conflict stays a 409.
import '../helpers/memory-db.js';
import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { composeServer } from '../../src/compose.js';
import { listen } from '../helpers/http.js';

let base = '';
let stop: () => Promise<void>;

before(async () => {
  const composed = composeServer({
    env: { COMDOVE_WEBHOOK_URL: 'http://127.0.0.1:9/webhooks/whatsapp', APP_SECRET: 's', WEBHOOK_VERIFY_TOKEN: 'v', STATUS_WEBHOOK_DELAY_MS: 0 },
    log: () => {},
  });
  const m = await listen(composed.app);
  base = m.base;
  stop = async () => { composed.metaFace.dispatcher.cancelAll(); await m.close(); };
});
after(() => stop());

const api = async (method: string, path: string, body?: unknown) => {
  const res = await fetch(base + path, { method, headers: { 'Content-Type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });
  const text = await res.text();
  return { status: res.status, json: text ? JSON.parse(text) : null };
};

beforeEach(async () => {
  await api('POST', '/api/reset', { keep_numbers: false });
  await api('POST', '/api/business-numbers', { display_number: '918888800001' });
});

for (const bad of ['12', 'abc', '', '9198765432101234567', '91a9876543210', '+91 (98765) 43210']) {
  test(`group with customer number ${JSON.stringify(bad)} → 400, nothing stored`, async () => {
    const r = await api('POST', '/api/groups', { name: 'g', numbers: ['919876543210', bad] });
    assert.equal(r.status, 400);
    assert.match(r.json.error.message, /8–15 digits/);
    assert.deepEqual((await api('GET', '/api/groups')).json, []);
    assert.deepEqual((await api('GET', '/api/customers')).json, []);
  });
}

test('formatted numbers are stored as digits', async () => {
  const r = await api('POST', '/api/groups', { name: 'g', numbers: ['+91 98765-43210', '919876543211'] });
  assert.equal(r.status, 200);
  assert.deepEqual(r.json.numbers, ['919876543210', '919876543211']);
});

test('the same number twice in one group → 400', async () => {
  const r = await api('POST', '/api/groups', { name: 'g', numbers: ['919876543210', '+91 98765 43210'] });
  assert.equal(r.status, 400);
  assert.match(r.json.error.message, /more than once/);
});

test('real conflicts stay 409: number in another group, or a business number', async () => {
  assert.equal((await api('POST', '/api/groups', { name: 'a', numbers: ['919876543210'] })).status, 200);
  assert.equal((await api('POST', '/api/groups', { name: 'b', numbers: ['919876543210'] })).status, 409);
  assert.equal((await api('POST', '/api/groups', { name: 'c', numbers: ['918888800001'] })).status, 409);
});

test('business display numbers follow the same rule', async () => {
  await api('POST', '/api/reset', { keep_numbers: false });
  for (const bad of ['91a8888800001', '1234567', '1234567890123456']) {
    const r = await api('POST', '/api/business-numbers', { display_number: bad });
    assert.equal(r.status, 400, bad);
  }
  const ok = await api('POST', '/api/business-numbers', { display_number: '+91 88888-00001' });
  assert.equal(ok.status, 200);
  assert.equal(ok.json.display_number, '918888800001');
});
