import { test } from 'node:test';
import assert from 'node:assert/strict';
import { statusOf, toWsMessage } from '../../src/ws/wire.js';

const SALES = '918888800001';
const TILE = '919876543210';
const base = { wamid: 'wamid.MOCK-1', body: 'hi', created_at: 1000, delivered_at: null, read_at: null };

test('an outbound message: peer is the business (from), status follows the timestamps', () => {
  assert.deepEqual(
    toWsMessage({ ...base, direction: 'outbound', from_number: SALES, to_number: TILE, delivered_at: 1100 }),
    { wamid: 'wamid.MOCK-1', peer: SALES, direction: 'outbound', body: 'hi', status: 'delivered', created_at: 1000 },
  );
});

test('an inbound message: peer is the business (to)', () => {
  const m = toWsMessage({ ...base, direction: 'inbound', from_number: TILE, to_number: SALES });
  assert.equal(m.peer, SALES);
  assert.equal(m.direction, 'inbound');
  assert.equal(m.status, 'sent');
});

test('statusOf: read beats delivered beats sent', () => {
  assert.equal(statusOf({ delivered_at: null, read_at: null }), 'sent');
  assert.equal(statusOf({ delivered_at: 5, read_at: null }), 'delivered');
  assert.equal(statusOf({ delivered_at: 5, read_at: 6 }), 'read');
});
