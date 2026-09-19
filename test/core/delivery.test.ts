import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createLiveDelivery, type LiveDeliveryDeps } from '../../src/core/delivery.js';
import { createSessionIndex } from '../../src/ws/session-index.js';
import type { Session } from '../../src/ws/session.js';
import type { Customer, StoredMessage } from '../../src/core/ports.js';
import type { AdminEvent, ServerEvent } from '../../src/contract/ws-events.js';

const SALES = '918888800001';
const T1 = '919876543210';
const T2 = '919876543211';
const tick = (ms = 5) => new Promise((resolve) => setTimeout(resolve, ms));

function fakeSession(groupId: string) {
  const sent: Array<ServerEvent | AdminEvent> = [];
  const session: Session = {
    role: { kind: 'group', groupId },
    send: (ev) => {
      sent.push(ev);
    },
    handle: () => {},
    close: () => {},
  };
  return { session, sent };
}

let n = 0;
function msg(o: Partial<StoredMessage> = {}): StoredMessage {
  n++;
  return {
    wamid: `wamid.MOCK-${n}`,
    conversation_id: 1,
    seq: n,
    direction: 'outbound',
    source: 'api',
    phone_number_id: 'PN-1',
    customer_number: T1,
    from_number: SALES,
    to_number: T1,
    body: `m${n}`,
    created_at: 1000 + n,
    sent_at: 1000 + n,
    delivered_at: null,
    read_at: null,
    ...o,
  };
}

function setup(o: {
  online?: Record<string, boolean>;
  queued?: Record<string, StoredMessage[]>;
  reply?: { reply: string; delay_ms: number } | null;
} = {}) {
  const customers: Record<string, Customer> = {
    [T1]: { number: T1, group_id: 'alpha', label: null, online: o.online?.[T1] ?? true },
    [T2]: { number: T2, group_id: 'alpha', label: null, online: o.online?.[T2] ?? true },
  };
  const sessions = createSessionIndex();
  const delivered: StoredMessage[][] = [];
  const inbound: unknown[][] = [];
  const deps: LiveDeliveryDeps = {
    sessions,
    getCustomer: (number) => customers[number] ?? null,
    listGroupTiles: (groupId) => Object.values(customers).filter((c) => c.group_id === groupId),
    queuedFor: (number) => o.queued?.[number] ?? [],
    delivered: (msgs) => {
      delivered.push(msgs);
    },
    inbound: (...args) => {
      inbound.push(args);
    },
    computeReply: () => o.reply ?? null,
  };
  return { delivery: createLiveDelivery(deps), sessions, customers, delivered, inbound };
}

test('an online tile in a claimed group gets message.new, then the message is delivered', () => {
  const { delivery, sessions, delivered } = setup();
  const { session, sent } = fakeSession('alpha');
  sessions.add('alpha', session);
  const m = msg();
  assert.equal(delivery.deliver(m), 'delivered');
  assert.deepEqual(sent, [
    {
      type: 'message.new',
      to: T1,
      number: T1,
      message: { wamid: m.wamid, peer: SALES, direction: 'outbound', body: m.body, status: 'sent', created_at: m.created_at },
    },
  ]);
  assert.deepEqual(delivered, [[m]]);
});

test('a tile whose flag is off keeps the message queued', () => {
  const { delivery, sessions, delivered } = setup({ online: { [T1]: false } });
  const { session, sent } = fakeSession('alpha');
  sessions.add('alpha', session);
  assert.equal(delivery.deliver(msg()), 'queued');
  assert.deepEqual(sent, []);
  assert.deepEqual(delivered, []);
});

test('a tile whose group is not claimed keeps the message queued', () => {
  const { delivery, delivered } = setup();
  assert.equal(delivery.deliver(msg()), 'queued');
  assert.deepEqual(delivered, []);
});

test('an unknown customer keeps the message queued', () => {
  const { delivery, sessions, delivered } = setup();
  sessions.add('alpha', fakeSession('alpha').session);
  assert.equal(delivery.deliver(msg({ customer_number: '910000000000', to_number: '910000000000' })), 'queued');
  assert.deepEqual(delivered, []);
});

test('auto-reply is sent after its delay while the tile is still online', async () => {
  const { delivery, sessions, inbound } = setup({ reply: { reply: 'how much?', delay_ms: 0 } });
  sessions.add('alpha', fakeSession('alpha').session);
  delivery.deliver(msg());
  assert.deepEqual(inbound, []); // never synchronously
  await tick(10);
  assert.deepEqual(inbound, [[T1, 'PN-1', 'how much?', 'autoreply']]);
});

test('auto-reply is dropped if the tile went offline during the delay', async () => {
  const { delivery, sessions, customers, inbound } = setup({ reply: { reply: 'x', delay_ms: 20 } });
  sessions.add('alpha', fakeSession('alpha').session);
  delivery.deliver(msg());
  customers[T1]!.online = false;
  await tick(40);
  assert.deepEqual(inbound, []);
});

test('deliverQueued delivers online tiles only, without pushing message.new', () => {
  const q1 = [msg(), msg()];
  const q2 = [msg({ customer_number: T2, to_number: T2 })];
  const { delivery, sessions, delivered } = setup({ online: { [T2]: false }, queued: { [T1]: q1, [T2]: q2 } });
  const { session, sent } = fakeSession('alpha');
  sessions.add('alpha', session);
  delivery.deliverQueued('alpha');
  assert.deepEqual(delivered, [q1]);
  assert.deepEqual(sent, []);
});

test('deliverQueued without an open session does nothing; isOnline needs a session', () => {
  const { delivery, sessions, delivered } = setup({ queued: { [T1]: [msg()] } });
  delivery.deliverQueued('alpha');
  assert.deepEqual(delivered, []);
  assert.equal(delivery.isOnline(T1), false);
  sessions.add('alpha', fakeSession('alpha').session);
  assert.equal(delivery.isOnline(T1), true);
});
