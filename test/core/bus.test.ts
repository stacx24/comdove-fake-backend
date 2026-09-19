import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createLiveBus, type LiveBusDeps } from '../../src/core/bus.js';
import { createSessionIndex } from '../../src/ws/session-index.js';
import type { Session } from '../../src/ws/session.js';
import type { Customer, StoredMessage } from '../../src/core/ports.js';
import type { AdminEvent, ServerEvent } from '../../src/contract/ws-events.js';

const SALES = '918888800001';
const T1 = '919876543210';

function setup(admin?: LiveBusDeps['admin']) {
  const customers: Record<string, Customer> = { [T1]: { number: T1, group_id: 'alpha', label: null, online: true } };
  const sessions = createSessionIndex();
  const sent: Array<ServerEvent | AdminEvent> = [];
  const session: Session = {
    role: { kind: 'group', groupId: 'alpha' },
    send: (ev) => {
      sent.push(ev);
    },
    handle: () => {},
    close: () => {},
  };
  const logs: string[] = [];
  const bus = createLiveBus({ sessions, getCustomer: (n) => customers[n] ?? null, log: (l) => logs.push(l), admin });
  return { bus, sessions, session, sent, logs };
}

const stored = (o: Partial<StoredMessage>): StoredMessage => ({
  wamid: 'wamid.MOCK-1',
  conversation_id: 1,
  seq: 1,
  direction: 'inbound',
  source: 'inject',
  phone_number_id: 'PN-1',
  customer_number: T1,
  from_number: T1,
  to_number: SALES,
  body: 'how much?',
  created_at: 1000,
  sent_at: null,
  delivered_at: null,
  read_at: null,
  ...o,
});

test('message.status goes to the session holding the tile group', () => {
  const { bus, sessions, session, sent, logs } = setup();
  sessions.add('alpha', session);
  bus.emit({ type: 'message.status', wamid: 'w1', number: T1, status: 'delivered', at: 5 });
  assert.deepEqual(sent, [{ type: 'message.status', wamid: 'w1', number: T1, status: 'delivered', at: 5 }]);
  assert.equal(logs.length, 1);
});

test('an inbound message.new shows in the tile, addressed to the business', () => {
  const { bus, sessions, session, sent } = setup();
  sessions.add('alpha', session);
  bus.emit({ type: 'message.new', message: stored({}) });
  assert.deepEqual(sent, [
    {
      type: 'message.new',
      to: SALES,
      number: T1,
      message: { wamid: 'wamid.MOCK-1', peer: SALES, direction: 'inbound', body: 'how much?', status: 'sent', created_at: 1000 },
    },
  ]);
});

test('an outbound message.new is ignored (delivery pushes outbound bubbles)', () => {
  const { bus, sessions, session, sent } = setup();
  sessions.add('alpha', session);
  bus.emit({
    type: 'message.new',
    message: stored({ direction: 'outbound', source: 'api', from_number: SALES, to_number: T1 }),
  });
  assert.deepEqual(sent, []);
});

test('no open session, or an unknown customer, sends nothing', () => {
  const { bus, sessions, session, sent } = setup();
  bus.emit({ type: 'message.status', wamid: 'w1', number: T1, status: 'read', at: 5 });
  sessions.add('alpha', session);
  bus.emit({ type: 'message.status', wamid: 'w2', number: '910000000000', status: 'read', at: 6 });
  assert.deepEqual(sent, []);
});

test('log.changed and webhook.verify go to the admin feed, not to tiles', () => {
  const calls: unknown[] = [];
  const { bus, sessions, session, sent } = setup({
    logChanged: (wamid) => calls.push(['log', wamid]),
    verify: (r) => calls.push(['verify', r]),
  });
  sessions.add('alpha', session);
  bus.emit({ type: 'log.changed', wamid: 'w1' });
  bus.emit({ type: 'webhook.verify', ok: true, at: 1, detail: 'ok' });
  assert.deepEqual(calls, [
    ['log', 'w1'],
    ['verify', { ok: true, at: 1, detail: 'ok' }],
  ]);
  assert.deepEqual(sent, []);
});

test('without an admin feed, admin events are dropped quietly', () => {
  const { bus, sessions, session, sent } = setup();
  sessions.add('alpha', session);
  bus.emit({ type: 'log.changed', wamid: 'w1' });
  bus.emit({ type: 'webhook.verify', ok: false, at: 1, detail: 'down' });
  assert.deepEqual(sent, []);
});

test('log.rejected goes to the admin feed as the /api/log rejected entry', () => {
  const got: unknown[] = [];
  const { bus, sessions, session, sent } = setup({ logChanged: () => {}, verify: () => {}, rejected: (e) => got.push(e) });
  sessions.add('alpha', session);
  bus.emit({ type: 'log.rejected', request: { at: 5, phone_number_id: 'PN-1', http_status: 401, code: 190, forced: false, to: T1, body: 'x' } });
  assert.deepEqual(got, [
    { wamid: null, time: 5, direction: 'rejected', phone_number_id: 'PN-1', to: T1, body: 'x', http_status: 401, code: 190, subcode: null, forced: false },
  ]);
  assert.deepEqual(sent, []);
});
