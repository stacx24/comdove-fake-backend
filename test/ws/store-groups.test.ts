import '../helpers/memory-db.js';
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { createGroup, listGroups, registerBusinessNumber, resetAll, setAutoReply } from '../../src/core/registry.js';
import { setDelivered, setRead, storeMessage } from '../../src/core/messages.js';
import { storeGroups } from '../../src/ws/store-groups.js';
import { sharedLock } from '../../src/ws/shared-lock.js';

const SALES = '918888800001';
const SUPPORT = '918888800002';
const T1 = '919876543210';
const T2 = '919876543211';

beforeEach(() => {
  resetAll(false);
  registerBusinessNumber({ display_number: SALES, label: 'Sales', phone_number_id: 'PN-1', waba_id: 'W-1', token: 'secret-1' });
  registerBusinessNumber({ display_number: SUPPORT, label: 'Support', phone_number_id: 'PN-2', waba_id: 'W-1', token: 'secret-2' });
  createGroup('Alpha', [T1, T2]);
});

const out = (from: string, to: string, body: string, at: number) =>
  storeMessage({ from, to, body, direction: 'outbound', source: 'api', at });

test('exists follows the groups table', () => {
  assert.equal(storeGroups.exists('alpha'), true);
  assert.equal(storeGroups.exists('nope'), false);
});

test('snapshot: group, business numbers without tokens, tiles in position order with defaults', () => {
  const snap = storeGroups.snapshot('alpha');
  assert.deepEqual(snap.group, { id: 'alpha', name: 'Alpha' });
  assert.deepEqual(
    [...snap.business_numbers].sort((a, b) => a.phone_number_id.localeCompare(b.phone_number_id)),
    [
      { phone_number_id: 'PN-1', display_number: SALES, label: 'Sales' },
      { phone_number_id: 'PN-2', display_number: SUPPORT, label: 'Support' },
    ],
  );
  assert.deepEqual(snap.tiles.map((t) => t.number), [T1, T2]);
  assert.deepEqual(snap.tiles[1], {
    number: T2,
    label: null,
    online: true,
    auto_reply: { mode: 'manual', delay_ms: 0, rules: [] },
    history: [],
    queued: [],
    unread: {},
  });
});

test('snapshot: history excludes the queue, unread counts per business, auto-reply config', () => {
  const m1 = out(SALES, T1, 'one', 1000);
  setDelivered(m1.wamid, 1001);
  setRead([m1.wamid], 1002);
  const m2 = out(SALES, T1, 'two', 1100);
  setDelivered(m2.wamid, 1101);
  const m3 = out(SUPPORT, T1, 'three', 1200);
  setDelivered(m3.wamid, 1201);
  storeMessage({ from: T1, to: SALES, body: 'reply', direction: 'inbound', source: 'tile', at: 1300 });
  const m4 = out(SALES, T1, 'four', 1400);
  const m5 = out(SALES, T1, 'five', 1500);
  setAutoReply(T1, { mode: 'keyword', delay_ms: 500, rules: [{ keyword: 'price', reply: 'how much?' }] });

  const tile = storeGroups.snapshot('alpha').tiles[0]!;
  assert.deepEqual(
    tile.history.map((m) => [m.body, m.peer, m.direction, m.status]),
    [
      ['one', SALES, 'outbound', 'read'],
      ['two', SALES, 'outbound', 'delivered'],
      ['three', SUPPORT, 'outbound', 'delivered'],
      ['reply', SALES, 'inbound', 'sent'],
    ],
  );
  assert.deepEqual(tile.queued.map((m) => m.wamid), [m4.wamid, m5.wamid]);
  assert.deepEqual(tile.unread, { [SALES]: 1, [SUPPORT]: 1 });
  assert.deepEqual(tile.auto_reply, { mode: 'keyword', delay_ms: 500, rules: [{ keyword: 'price', reply: 'how much?' }] });
});

test('the launch list (GET /api/groups data) reads the shared lock', () => {
  const owner = {};
  assert.equal(listGroups()[0]?.status, 'free');
  assert.equal(sharedLock.claim('alpha', owner).ok, true);
  const g = listGroups()[0]!;
  assert.equal(g.status, 'locked');
  assert.equal(typeof g.locked_since, 'number');
  sharedLock.release('alpha', owner);
  assert.equal(listGroups()[0]?.status, 'free');
});
