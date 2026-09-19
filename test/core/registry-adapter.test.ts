import '../helpers/memory-db.js';
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { sqliteRegistry as reg } from '../../src/core/registry-adapter.js';
import { registerBusinessNumber, createGroup, resetAll } from '../../src/core/registry.js';
import { getLog, history, queuedFor } from '../../src/core/messages.js';
import { db } from '../../src/db/db.js';

beforeEach(() => {
  resetAll(false);
  registerBusinessNumber({ display_number: '918888800001', label: 'Sales', phone_number_id: 'PN-REAL', waba_id: 'W1', token: 't1' });
  createGroup('alpha', ['919876543210']);
});

const out = (wamid: string, at = 1000) =>
  reg.storeMessage({ wamid, direction: 'outbound', source: 'api', phone_number_id: 'PN-REAL', customer_number: '919876543210', body: 'hi', at });

test('conversation is keyed by phone_number_id, not the display number (P2 bug fix)', () => {
  out('w1');
  reg.storeMessage({ wamid: 'w2', direction: 'inbound', source: 'tile', phone_number_id: 'PN-REAL', customer_number: '919876543210', body: 'yo', at: 2000 });
  const convs = db.prepare('SELECT phone_number_id, customer_number FROM conversations').all();
  assert.deepEqual(convs, [{ phone_number_id: 'PN-REAL', customer_number: '919876543210' }]);
});

test('storeMessage keeps the given wamid/time and returns both sides', () => {
  const m = out('wamid.MOCK-given', 1234);
  assert.equal(m.wamid, 'wamid.MOCK-given');
  assert.equal(m.created_at, 1234);
  assert.equal(m.sent_at, 1234);
  assert.equal(m.phone_number_id, 'PN-REAL');
  assert.equal(m.customer_number, '919876543210');
  assert.equal(m.from_number, '918888800001');
  assert.equal(m.to_number, '919876543210');
  assert.deepEqual(reg.getMessage('wamid.MOCK-given'), { ...m });
});

test('inbound: from customer, to business display number, same conversation', () => {
  const a = out('w1');
  const b = reg.storeMessage({ wamid: 'w2', direction: 'inbound', source: 'tile', phone_number_id: 'PN-REAL', customer_number: '919876543210', body: 'yo', at: 2 });
  assert.equal(b.conversation_id, a.conversation_id);
  assert.equal(b.seq, 2);
  assert.equal(b.from_number, '919876543210');
  assert.equal(b.to_number, '918888800001');
  assert.equal(b.sent_at, null);
});

test('setDelivered (array) / unreadDelivered / setRead', () => {
  out('w1'); out('w2'); out('w3');
  reg.setDelivered(['w2', 'w1'], 50);
  assert.deepEqual(reg.unreadDelivered('919876543210', 'PN-REAL').map((m) => m.wamid), ['w1', 'w2']);
  assert.deepEqual(queuedFor('919876543210').map((m) => m.wamid), ['w3']);
  reg.setRead(['w1'], 60);
  assert.deepEqual(reg.unreadDelivered('919876543210', 'PN-REAL').map((m) => m.wamid), ['w2']);
  reg.setDelivered(['w1'], 99); // idempotent: first delivery time wins
  assert.equal(reg.getMessage('w1')?.delivered_at, 50);
  assert.equal(history('919876543210').length, 3);
});

test('customers map online 0/1 to boolean; business lookup by id or display', () => {
  assert.equal(reg.getCustomer('919876543210')?.online, true);
  assert.equal(reg.getBusiness('PN-REAL')?.display_number, '918888800001');
  assert.equal(reg.getBusiness('918888800001')?.phone_number_id, 'PN-REAL');
  assert.equal(reg.getCustomer('911111111111'), null);
});

test('logRejected rows appear in /api/log as direction "rejected", newest first', () => {
  out('w1', 1000);
  reg.logRejected({ at: 2000, phone_number_id: 'PN-REAL', http_status: 401, code: 190, forced: false, to: '919876543210', body: 'x' });
  const log = getLog(10);
  assert.deepEqual(log.map((e) => e.direction), ['rejected', 'outbound']);
  assert.deepEqual(log[0], { wamid: null, time: 2000, direction: 'rejected', phone_number_id: 'PN-REAL', to: '919876543210', body: 'x', http_status: 401, code: 190, subcode: null, forced: false });
});

test('log entries resolve business + group via phone_number_id', () => {
  out('w1');
  const [e] = getLog(1);
  assert.ok(e.direction === 'outbound');
  assert.deepEqual(e.business, { phone_number_id: 'PN-REAL', label: 'Sales' });
  assert.equal(e.group_id, 'alpha');
});
