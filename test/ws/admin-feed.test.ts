import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createAdminFeed, type AdminFeedDeps } from '../../src/ws/admin-feed.js';
import type { Session } from '../../src/ws/session.js';
import type {
  AdminEvent,
  BusinessNumber,
  CustomerListItem,
  GroupListItem,
  LogEntry,
  ServerEvent,
} from '../../src/contract/ws-events.js';

const BIZ: BusinessNumber = {
  phone_number_id: 'PN-1',
  display_number: '918888800001',
  label: 'Sales',
  token: 'tok',
  waba_id: 'W-1',
  created_at: 1,
};
const CUST: CustomerListItem = {
  number: '919876543210',
  label: null,
  group_id: 'alpha',
  online: true,
  effective_online: false,
  claim_status: 'free',
  reply_mode: 'manual',
  type: 'customer',
};
const GROUPS: GroupListItem[] = [{ id: 'alpha', name: 'alpha', count: 1, status: 'free', locked_since: null }];

const entry = (wamid: string): LogEntry => ({
  wamid,
  time: 1,
  direction: 'outbound',
  source: 'api',
  from: BIZ.display_number,
  to: CUST.number,
  business: { phone_number_id: 'PN-1', label: 'Sales' },
  group_id: 'alpha',
  body: 'hi',
  status: 'sent',
  timeline: [],
  webhooks: [],
});

function fakeSession() {
  const sent: Array<ServerEvent | AdminEvent> = [];
  const session: Session = {
    role: { kind: 'admin' },
    send: (ev) => {
      sent.push(ev);
    },
    handle: () => {},
    close: () => {},
  };
  return { session, sent, types: () => sent.map((e) => e.type) };
}

function setup() {
  const lookups: string[] = [];
  const entries: Record<string, LogEntry> = { w1: entry('w1') };
  const deps: AdminFeedDeps = {
    getLogEntry: (wamid) => {
      lookups.push(wamid);
      return entries[wamid] ?? null;
    },
    listGroups: () => GROUPS,
    listBusinessNumbers: () => [BIZ],
    listCustomers: () => [CUST],
  };
  return { feed: createAdminFeed(deps), lookups, entries };
}

test('subscribe sends the current groups and numbers to that socket only', () => {
  const { feed } = setup();
  const a = fakeSession();
  const b = fakeSession();
  feed.subscribe(a.session);
  assert.deepEqual(a.sent, [
    { type: 'groups.update', groups: GROUPS },
    { type: 'numbers.update', business_numbers: [BIZ], customers: [CUST] },
  ]);
  assert.deepEqual(b.sent, []);
  assert.equal(feed.size(), 1);
});

test('a message change is log.entry the first time and log.update after, to every admin', () => {
  const { feed, entries } = setup();
  const a = fakeSession();
  const b = fakeSession();
  feed.subscribe(a.session);
  feed.subscribe(b.session);
  a.sent.length = 0;
  b.sent.length = 0;
  feed.logChanged('w1');
  feed.logChanged('w1');
  for (const s of [a, b]) {
    assert.deepEqual(s.sent, [
      { type: 'log.entry', entry: entries.w1 },
      { type: 'log.update', entry: entries.w1 },
    ]);
  }
});

test('with no admins there is no lookup; unknown wamids are ignored', () => {
  const { feed, lookups } = setup();
  feed.logChanged('w1');
  assert.deepEqual(lookups, []);
  const a = fakeSession();
  feed.subscribe(a.session);
  a.sent.length = 0;
  feed.logChanged('nope');
  assert.deepEqual(a.sent, []);
  feed.logChanged('w1'); // not announced while nobody listened → still an entry
  assert.deepEqual(a.types(), ['log.entry']);
});

test('unsubscribed sockets get nothing; lockChanged sends both lists', () => {
  const { feed } = setup();
  const a = fakeSession();
  const b = fakeSession();
  feed.subscribe(a.session);
  feed.subscribe(b.session);
  feed.unsubscribe(b.session);
  a.sent.length = 0;
  b.sent.length = 0;
  feed.lockChanged();
  feed.groupsChanged();
  feed.numbersChanged();
  assert.deepEqual(a.types(), ['groups.update', 'numbers.update', 'groups.update', 'numbers.update']);
  assert.deepEqual(b.sent, []);
  assert.equal(feed.size(), 1);
});

test('the webhook handshake result is broadcast', () => {
  const { feed } = setup();
  const a = fakeSession();
  feed.subscribe(a.session);
  a.sent.length = 0;
  feed.verify({ ok: true, at: 5, detail: 'ok' });
  assert.deepEqual(a.sent, [{ type: 'webhook.verify', ok: true, at: 5, detail: 'ok' }]);
});

test('reset sends log.reset then fresh lists, and the next change is a log.entry again', () => {
  const { feed } = setup();
  const a = fakeSession();
  feed.subscribe(a.session);
  feed.logChanged('w1');
  a.sent.length = 0;
  feed.reset();
  assert.deepEqual(a.types(), ['log.reset', 'groups.update', 'numbers.update']);
  a.sent.length = 0;
  feed.logChanged('w1');
  assert.deepEqual(a.types(), ['log.entry']);
});

test('a rejected Meta request is broadcast as a log.entry (never updated later)', () => {
  const { feed, lookups } = setup();
  const a = fakeSession();
  feed.subscribe(a.session);
  const rejected = { wamid: null, time: 7, direction: 'rejected' as const, phone_number_id: 'PN-1', to: null, body: null, http_status: 400, code: 130429, subcode: null, forced: true };
  feed.rejected(rejected);
  assert.deepEqual(a.sent.at(-1), { type: 'log.entry', entry: rejected });
  assert.deepEqual(lookups, []);
  const idle = createAdminFeed({ getLogEntry: () => null, listGroups: () => [], listBusinessNumbers: () => [], listCustomers: () => [] });
  idle.rejected(rejected); // no admins: nothing to do, no error
});
