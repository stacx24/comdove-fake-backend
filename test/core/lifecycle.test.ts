import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createLifecycle, LifecycleError } from '../../src/core/lifecycle.js';
import type { EnqueueInput } from '../../src/webhooks/dispatcher.js';
import { MemoryRegistry } from '../../src/dev/memory-registry.js';
import { RecordingBus } from '../../src/dev/memory-bus.js';

const NOW = 1_758_270_000_000;

function setup() {
  const registry = new MemoryRegistry().seed({
    business: [{ phone_number_id: 'MOCK-PN-1', display_number: '918888800001', waba_id: 'W1', token: 't1' }],
    customers: [{ number: '919876543210', label: 'Asha' }],
  });
  const bus = new RecordingBus();
  const jobs: EnqueueInput[] = [];
  const lc = createLifecycle({ registry, bus, dispatcher: { enqueue: (j) => { jobs.push(j); return j as never; } }, statusDelayMs: 500, now: () => NOW });
  const business = registry.getBusiness('MOCK-PN-1')!;
  return { registry, bus, jobs, lc, business };
}

type Env = { entry: Array<{ id: string; changes: Array<{ value: Record<string, any> }> }> };
const value = (j: EnqueueInput) => (j.body as Env).entry[0].changes[0].value;

test('accept stores an outbound message and queues a delayed sent webhook', () => {
  const { lc, jobs, bus, business, registry } = setup();
  const m = lc.accept(business, '919876543210', 'Hello');
  assert.match(m.wamid, /^wamid\.MOCK-/);
  assert.equal(m.direction, 'outbound');
  assert.equal(m.source, 'api');
  assert.equal(m.sent_at, NOW);
  assert.equal(registry.messages.length, 1);
  assert.equal(jobs.length, 1);
  assert.equal(jobs[0].kind, 'sent');
  assert.equal(jobs[0].notBefore, NOW + 500);
  assert.equal(jobs[0].conversation_id, m.conversation_id);
  assert.equal((jobs[0].body as Env).entry[0].id, 'W1');
  assert.deepEqual(value(jobs[0]).statuses, [{ id: m.wamid, status: 'sent', timestamp: String(NOW / 1000), recipient_id: '919876543210' }]);
  assert.deepEqual(bus.ofType('log.changed').map((e) => e.wamid), [m.wamid]);
});

test('delivered queues webhooks in seq order, emits status, and is idempotent', () => {
  const { lc, jobs, bus, business, registry } = setup();
  const m1 = lc.accept(business, '919876543210', 'one');
  const m2 = lc.accept(business, '919876543210', 'two');
  jobs.length = 0;
  lc.delivered([m2, m1]);
  assert.deepEqual(jobs.map((j) => [j.kind, value(j).statuses[0].id]), [['delivered', m1.wamid], ['delivered', m2.wamid]]);
  assert.ok(jobs.every((j) => j.notBefore === undefined));
  assert.deepEqual(bus.ofType('message.status').map((e) => [e.wamid, e.status, e.number]), [
    [m1.wamid, 'delivered', '919876543210'],
    [m2.wamid, 'delivered', '919876543210'],
  ]);
  assert.equal(registry.getMessage(m1.wamid)?.delivered_at, NOW);
  lc.delivered([m1, m2]);
  assert.equal(jobs.length, 2);
});

test('delivered ignores inbound messages', () => {
  const { lc, jobs } = setup();
  const inb = lc.inbound('919876543210', '918888800001', 'hi', 'tile');
  jobs.length = 0;
  lc.delivered([inb]);
  assert.equal(jobs.length, 0);
});

test('read marks delivered-unread messages read, in order; accepts display number or id', () => {
  const { lc, jobs, business, registry } = setup();
  const m1 = lc.accept(business, '919876543210', 'one');
  const m2 = lc.accept(business, '919876543210', 'two');
  const m3 = lc.accept(business, '919876543210', 'still queued');
  lc.delivered([m1, m2]);
  jobs.length = 0;
  lc.read('919876543210', '918888800001');
  assert.deepEqual(jobs.map((j) => [j.kind, value(j).statuses[0].id]), [['read', m1.wamid], ['read', m2.wamid]]);
  assert.equal(registry.getMessage(m3.wamid)?.read_at, null);
  jobs.length = 0;
  lc.read('919876543210', 'MOCK-PN-1');
  assert.equal(jobs.length, 0, 'nothing left to read');
});

test('read with an unknown peer throws LifecycleError', () => {
  const { lc } = setup();
  assert.throws(() => lc.read('919876543210', 'nope'), (e: unknown) => e instanceof LifecycleError && e.code === 'unknown_business');
});

test('inbound stores, emits message.new, and queues an undelayed inbound webhook', () => {
  const { lc, jobs, bus } = setup();
  const m = lc.inbound('919876543210', '918888800001', 'how much?', 'tile');
  assert.equal(m.direction, 'inbound');
  assert.equal(m.source, 'tile');
  assert.equal(m.phone_number_id, 'MOCK-PN-1');
  assert.equal(jobs.length, 1);
  assert.equal(jobs[0].kind, 'inbound');
  assert.equal(jobs[0].notBefore, undefined);
  assert.equal((jobs[0].body as Env).entry[0].id, 'W1');
  const v = value(jobs[0]);
  assert.deepEqual(v.metadata, { display_phone_number: '918888800001', phone_number_id: 'MOCK-PN-1' });
  assert.deepEqual(v.contacts, [{ profile: { name: 'Asha' }, wa_id: '919876543210' }]);
  assert.equal(v.messages[0].text.body, 'how much?');
  assert.equal(bus.ofType('message.new')[0].message.wamid, m.wamid);
  assert.deepEqual(bus.ofType('log.changed').map((e) => e.wamid), [m.wamid]);
});

test('inbound accepts the business phone_number_id as `to`', () => {
  const { lc } = setup();
  assert.equal(lc.inbound('919876543210', 'MOCK-PN-1', 'x', 'inject').phone_number_id, 'MOCK-PN-1');
});

test('inbound validates from / to / body', () => {
  const { lc } = setup();
  const code = (fn: () => unknown) => {
    try { fn(); } catch (e) { return e instanceof LifecycleError ? e.code : 'other'; }
    return 'no-throw';
  };
  assert.equal(code(() => lc.inbound('911111111111', '918888800001', 'x', 'tile')), 'unknown_customer');
  assert.equal(code(() => lc.inbound('919876543210', '910000000000', 'x', 'tile')), 'unknown_business');
  assert.equal(code(() => lc.inbound('919876543210', '918888800001', '', 'tile')), 'invalid_body');
  assert.equal(code(() => lc.inbound('919876543210', '918888800001', 'x'.repeat(4097), 'tile')), 'invalid_body');
});

test('markInboundRead sets read_at and emits status, but sends no webhook', () => {
  const { lc, jobs, bus, business, registry } = setup();
  const m = lc.inbound('919876543210', '918888800001', 'hi', 'tile');
  jobs.length = 0;
  lc.markInboundRead(business, m.wamid);
  assert.equal(jobs.length, 0);
  assert.equal(registry.getMessage(m.wamid)?.read_at, NOW);
  assert.deepEqual(bus.ofType('message.status').map((e) => [e.wamid, e.status, e.number]), [[m.wamid, 'read', '919876543210']]);
});
