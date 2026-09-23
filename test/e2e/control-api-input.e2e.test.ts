// Control-API input handling found in review: generated ids after a delete, auto-reply
// validation, and text booleans. Bad input → 400 with a clear message (never a raw database
// error); conflicts with existing data → 409.
import '../helpers/memory-db.js';
import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { composeServer } from '../../src/compose.js';
import { listen } from '../helpers/http.js';

let base = '';
let stop: () => Promise<void>;
const T1 = '919876543210';

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
const noDbErrors = (msg: string) => assert.doesNotMatch(msg, /constraint|SQLITE/i, `raw database error leaked: ${msg}`);

beforeEach(async () => {
  await api('POST', '/api/reset', { keep_numbers: false });
});

// --- A. generated phone_number_id -------------------------------------------------------
test('A: a generated id is never reused after a delete', async () => {
  assert.equal((await api('POST', '/api/business-numbers', { display_number: '918888800001' })).json.phone_number_id, 'MOCK-PN-1');
  assert.equal((await api('POST', '/api/business-numbers', { display_number: '918888800002' })).json.phone_number_id, 'MOCK-PN-2');
  assert.equal((await api('DELETE', '/api/business-numbers/MOCK-PN-1')).status, 204);
  const third = await api('POST', '/api/business-numbers', { display_number: '918888800003' });
  assert.equal(third.status, 200, JSON.stringify(third.json));
  assert.equal(third.json.phone_number_id, 'MOCK-PN-3');
});

test('A: a generated id skips ids supplied by the caller', async () => {
  await api('POST', '/api/business-numbers', { display_number: '918888800001', phone_number_id: 'MOCK-PN-1' });
  await api('POST', '/api/business-numbers', { display_number: '918888800002', phone_number_id: 'MOCK-PN-3' });
  assert.equal((await api('POST', '/api/business-numbers', { display_number: '918888800003' })).json.phone_number_id, 'MOCK-PN-4');
});

test('A: a duplicate phone_number_id or display number is a clear 409', async () => {
  await api('POST', '/api/business-numbers', { display_number: '918888800001', phone_number_id: 'PN-X' });
  const sameId = await api('POST', '/api/business-numbers', { display_number: '918888800002', phone_number_id: 'PN-X' });
  assert.equal(sameId.status, 409);
  assert.match(sameId.json.error.message, /PN-X/);
  noDbErrors(sameId.json.error.message);
  const sameNumber = await api('POST', '/api/business-numbers', { display_number: '+91 88888-00001' });
  assert.equal(sameNumber.status, 409);
  noDbErrors(sameNumber.json.error.message);
});

test('A: the 11th business number is refused with 409', async () => {
  for (let i = 1; i <= 10; i++) assert.equal((await api('POST', '/api/business-numbers', { display_number: `9188888000${String(i).padStart(2, '0')}` })).status, 200);
  const r = await api('POST', '/api/business-numbers', { display_number: '918888800099' });
  assert.equal(r.status, 409);
  assert.match(r.json.error.message, /at most 10/);
});

// --- A2. group size: 100 tiles per group (WS-343) -------------------------------------------
const numbers = (count: number, from = 919000000000) =>
  Array.from({ length: count }, (_, i) => String(from + i));

test('A2: a group of 100 numbers is accepted', async () => {
  const r = await api('POST', '/api/groups', { name: 'hundred', numbers: numbers(100) });
  assert.equal(r.status, 200);
  assert.equal(r.json.numbers.length, 100);
  const group = (await api('GET', '/api/groups')).json.find((g: { id: string }) => g.id === 'hundred');
  assert.equal(group.count, 100);
});

test('A2: the 101st number is refused with 409', async () => {
  const r = await api('POST', '/api/groups', { name: 'too-many', numbers: numbers(101, 919100000000) });
  assert.equal(r.status, 409);
  assert.match(r.json.error.message, /1–100 numbers/);
  noDbErrors(r.json.error.message);
});

// --- B. auto-reply validation --------------------------------------------------------------
const put = (body: unknown, n = T1) => api('PUT', `/api/customers/${n}/auto-reply`, body);

for (const [label, body, field] of [
  ['delay_ms -5', { mode: 'echo', delay_ms: -5, rules: [] }, 'delay_ms'],
  ['delay_ms 99999', { mode: 'echo', delay_ms: 99999, rules: [] }, 'delay_ms'],
  ['delay_ms "abc"', { mode: 'echo', delay_ms: 'abc', rules: [] }, 'delay_ms'],
  ['delay_ms 1.5', { mode: 'echo', delay_ms: 1.5, rules: [] }, 'delay_ms'],
  ['rules [{}]', { mode: 'keyword', delay_ms: 0, rules: [{}] }, 'rules[0].keyword'],
  ['rules [{keyword:"a"}]', { mode: 'keyword', delay_ms: 0, rules: [{ keyword: 'a' }] }, 'rules[0].reply'],
  ['rules "x"', { mode: 'keyword', delay_ms: 0, rules: 'x' }, 'rules'],
  ['mode "robot"', { mode: 'robot', delay_ms: 0, rules: [] }, 'mode'],
] as const) {
  test(`B: auto-reply ${label} → 400 naming ${field}, config unchanged`, async () => {
    await api('POST', '/api/groups', { name: 'alpha', numbers: [T1] });
    await put({ mode: 'keyword', delay_ms: 100, rules: [{ keyword: 'price', reply: 'how much?' }] });
    const r = await put(body);
    assert.equal(r.status, 400, JSON.stringify(r.json));
    assert.ok(r.json.error.message.includes(`'${field}'`), r.json.error.message);
    noDbErrors(r.json.error.message);
    assert.deepEqual((await api('GET', `/api/customers/${T1}/auto-reply`)).json, { mode: 'keyword', delay_ms: 100, rules: [{ keyword: 'price', reply: 'how much?' }] });
  });
}

test('B: missing delay_ms / rules still default to 0 / []', async () => {
  await api('POST', '/api/groups', { name: 'alpha', numbers: [T1] });
  const r = await put({ mode: 'echo' });
  assert.equal(r.status, 200);
  assert.deepEqual(r.json, { mode: 'echo', delay_ms: 0, rules: [] });
});

test('B: unknown customer is still 404', async () => {
  assert.equal((await put({ mode: 'echo', delay_ms: 0, rules: [] }, '911111111111')).status, 404);
});

// --- C. real booleans only ------------------------------------------------------------------
test('C: presence online must be true or false', async () => {
  await api('POST', '/api/groups', { name: 'alpha', numbers: [T1] });
  for (const online of ['false', 'true', 0, 1, null, undefined]) {
    const r = await api('POST', '/api/presence', { number: T1, online });
    assert.equal(r.status, 400, `online=${JSON.stringify(online)}`);
    assert.match(r.json.error.message, /online/);
  }
  assert.equal((await api('GET', '/api/customers')).json[0].online, true, 'flag unchanged by the rejected calls');
  assert.equal((await api('POST', '/api/presence', { number: T1, online: false })).json.online, false);
});

test('C: reset keep_numbers must be true or false when given', async () => {
  await api('POST', '/api/business-numbers', { display_number: '918888800001' });
  for (const keep of ['false', 0, 'no']) {
    const r = await api('POST', '/api/reset', { keep_numbers: keep });
    assert.equal(r.status, 400, `keep_numbers=${JSON.stringify(keep)}`);
    assert.match(r.json.error.message, /keep_numbers/);
  }
  assert.equal((await api('GET', '/api/business-numbers')).json.length, 1, 'nothing reset by the rejected calls');
  assert.deepEqual((await api('POST', '/reset', {})).json, { ok: true, kept_numbers: true });
  assert.deepEqual((await api('POST', '/api/reset', { keep_numbers: false })).json, { ok: true, kept_numbers: false });
});
