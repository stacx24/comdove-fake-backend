import { test } from 'node:test';
import assert from 'node:assert/strict';
import { MemoryRegistry } from './registry.js';

test('stub registry: conversations get their own id and increasing seq', () => {
  const reg = new MemoryRegistry().seed({ business: [{}, {}], customers: [{}] });
  const base = { direction: 'outbound' as const, source: 'api' as const, customer_number: '919876543210', body: 'x', at: 1 };
  const a1 = reg.storeMessage({ ...base, wamid: 'a1', phone_number_id: 'MOCK-PN-1' });
  const a2 = reg.storeMessage({ ...base, wamid: 'a2', phone_number_id: 'MOCK-PN-1' });
  const b1 = reg.storeMessage({ ...base, wamid: 'b1', phone_number_id: 'MOCK-PN-2' });
  assert.equal(a1.conversation_id, a2.conversation_id);
  assert.notEqual(a1.conversation_id, b1.conversation_id);
  assert.deepEqual([a1.seq, a2.seq, b1.seq], [1, 2, 1]);
  assert.equal(a1.sent_at, 1);
  assert.equal(a1.from_number, '918888800001');
});

test('stub registry: unreadDelivered returns delivered, unread outbound by seq', () => {
  const reg = new MemoryRegistry().seed({ business: [{}], customers: [{}] });
  const base = { direction: 'outbound' as const, source: 'api' as const, phone_number_id: 'MOCK-PN-1', customer_number: '919876543210', body: 'x', at: 1 };
  for (const w of ['m1', 'm2', 'm3']) reg.storeMessage({ ...base, wamid: w });
  reg.setDelivered(['m2', 'm1'], 5);
  reg.setRead(['m1'], 6);
  assert.deepEqual(reg.unreadDelivered('919876543210', 'MOCK-PN-1').map((m) => m.wamid), ['m2']);
});
