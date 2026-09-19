import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createLockTable } from '../../src/ws/lock.js';
import { createSession, type GroupEvent, type Session, type SessionDeps } from '../../src/ws/session.js';
import { createMemoryGroups, DEV_GROUPS } from '../../src/dev/dev-groups.js';

type Frame = Record<string, unknown>;

function fakeSocket() {
  const sent: Frame[] = [];
  return {
    sent,
    readyState: 1, // OPEN
    send(data: string) {
      sent.push(JSON.parse(data) as Frame);
    },
  };
}

function setup(extra: Partial<SessionDeps> = {}) {
  const groups = createMemoryGroups(DEV_GROUPS);
  const lock = createLockTable({ now: () => 1000 });
  const deps: SessionDeps = { lock, groups, ...extra };
  const open = () => {
    const socket = fakeSocket();
    return { socket, session: createSession(socket, deps) };
  };
  return { groups, lock, open };
}

const GROUP_EVENTS: GroupEvent[] = [
  { type: 'message.send', from: '919876543210', to: '918888800001', body: 'hi' },
  { type: 'tile.presence', number: '919876543210', online: false },
  { type: 'chat.read', number: '919876543210', peer: '918888800001' },
  { type: 'tile.autoreply', number: '919876543210', mode: 'echo', delay_ms: 0, rules: [] },
];

test('claiming a known free group sends the snapshot and sets the role', () => {
  const { open, groups, lock } = setup();
  const { socket, session } = open();
  session.handle({ type: 'group.claim', group: 'alpha' });
  assert.deepEqual(socket.sent, [{ type: 'group.claimed', ...groups.snapshot('alpha') }]);
  assert.deepEqual(session.role, { kind: 'group', groupId: 'alpha' });
  assert.equal(lock.isLocked('alpha'), true);
});

test('claiming an unknown group is an error and keeps role none', () => {
  const { open, lock } = setup();
  const { socket, session } = open();
  session.handle({ type: 'group.claim', group: 'nope' });
  assert.deepEqual(socket.sent, [{ type: 'error', code: 'unknown_group', message: 'unknown group: nope' }]);
  assert.deepEqual(session.role, { kind: 'none' });
  assert.equal(lock.isLocked('nope'), false);
});

test('claiming a held group sends group.locked and keeps role none', () => {
  const { open } = setup();
  const first = open();
  const second = open();
  first.session.handle({ type: 'group.claim', group: 'alpha' });
  second.session.handle({ type: 'group.claim', group: 'alpha' });
  assert.deepEqual(second.socket.sent, [{ type: 'group.locked', group: 'alpha', since: 1000 }]);
  assert.deepEqual(second.session.role, { kind: 'none' });
  // the refused socket may still claim another group
  second.session.handle({ type: 'group.claim', group: 'beta' });
  assert.equal(second.socket.sent[1]?.type, 'group.claimed');
});

test('a second claim on a group socket is already_claimed', () => {
  const { open, lock } = setup();
  const { socket, session } = open();
  session.handle({ type: 'group.claim', group: 'alpha' });
  session.handle({ type: 'group.claim', group: 'beta' });
  assert.equal(socket.sent[1]?.type, 'error');
  assert.equal(socket.sent[1]?.code, 'already_claimed');
  assert.equal(lock.isLocked('beta'), false);
  assert.deepEqual(session.role, { kind: 'group', groupId: 'alpha' });
});

test('admin.subscribe sets the admin role, and the role is then fixed', () => {
  const { open } = setup();
  const { socket, session } = open();
  session.handle({ type: 'admin.subscribe' });
  assert.deepEqual(session.role, { kind: 'admin' });
  assert.equal(socket.sent.length, 0); // not deepEqual(..., []): that narrows `sent` to never[]
  session.handle({ type: 'group.claim', group: 'alpha' });
  session.handle({ type: 'admin.subscribe' });
  assert.deepEqual(
    socket.sent.map((f) => f.code),
    ['already_claimed', 'already_claimed'],
  );
  assert.deepEqual(session.role, { kind: 'admin' });
});

test('group events before a claim or on an admin socket are not_claimed', () => {
  const { open } = setup();
  const none = open();
  const admin = open();
  admin.session.handle({ type: 'admin.subscribe' });
  for (const ev of GROUP_EVENTS) {
    none.session.handle(ev);
    admin.session.handle(ev);
  }
  assert.deepEqual(none.socket.sent.map((f) => f.code), ['not_claimed', 'not_claimed', 'not_claimed', 'not_claimed']);
  assert.deepEqual(admin.socket.sent.map((f) => f.code), ['not_claimed', 'not_claimed', 'not_claimed', 'not_claimed']);
});

test('group events on a group socket reach onGroupEvent', () => {
  const received: Array<{ session: Session; ev: GroupEvent }> = [];
  const { open } = setup({ onGroupEvent: (session, ev) => received.push({ session, ev }) });
  const { socket, session } = open();
  session.handle({ type: 'group.claim', group: 'alpha' });
  for (const ev of GROUP_EVENTS) session.handle(ev);
  assert.equal(received.length, 4);
  assert.equal(received[0]?.session, session);
  assert.deepEqual(received.map((r) => r.ev), GROUP_EVENTS);
  assert.equal(socket.sent.length, 1); // only group.claimed, no errors
});

test('close releases the lock once, and never a newer owner lock', () => {
  const { open, lock } = setup();
  const first = open();
  first.session.handle({ type: 'group.claim', group: 'alpha' });
  first.session.close();
  assert.equal(lock.isLocked('alpha'), false);
  const second = open();
  second.session.handle({ type: 'group.claim', group: 'alpha' });
  first.session.close(); // late duplicate close must not free second's lock
  assert.equal(lock.isLocked('alpha'), true);
  // a session never sends on a socket that is not open
  const closedSocket = { ...fakeSocket(), readyState: 3 };
  const s = createSession(closedSocket, { lock, groups: createMemoryGroups(DEV_GROUPS) });
  s.handle({ type: 'group.claim', group: 'nope' });
  assert.deepEqual(closedSocket.sent, []);
});

test('onClaim runs after a successful claim and onRelease on close; never for refused claims', () => {
  const calls: string[] = [];
  const { open } = setup({
    onClaim: (s, g) => calls.push(`claim:${g}:${s.role.kind}`),
    onRelease: (_s, g) => calls.push(`release:${g}`),
  });
  const first = open();
  const second = open();
  first.session.handle({ type: 'group.claim', group: 'alpha' });
  assert.equal(first.socket.sent[0]?.type, 'group.claimed');
  second.session.handle({ type: 'group.claim', group: 'alpha' }); // refused
  second.session.close(); // held nothing
  first.session.close();
  first.session.close(); // idempotent
  assert.deepEqual(calls, ['claim:alpha:group', 'release:alpha']);
});

test('admin hooks: onAdminSubscribe on subscribe, onAdminClose on close; group sockets never call them', () => {
  const calls: string[] = [];
  const { open } = setup({ onAdminSubscribe: () => calls.push('sub'), onAdminClose: () => calls.push('close') });
  const admin = open();
  const group = open();
  admin.session.handle({ type: 'admin.subscribe' });
  group.session.handle({ type: 'group.claim', group: 'alpha' });
  group.session.close();
  admin.session.close();
  admin.session.close(); // idempotent
  assert.deepEqual(calls, ['sub', 'close']);
});

test('disconnect releases the lock at once, then closes the socket', () => {
  const { lock, groups } = setup();
  const closes: Array<[number | undefined, string | undefined]> = [];
  const socket = {
    ...fakeSocket(),
    close: (code?: number, reason?: string) => {
      closes.push([code, reason]);
    },
  };
  const released: string[] = [];
  const s = createSession(socket, { lock, groups, onRelease: (_s, g) => released.push(g) });
  s.handle({ type: 'group.claim', group: 'alpha' });
  s.disconnect!();
  assert.equal(lock.isLocked('alpha'), false);
  assert.deepEqual(released, ['alpha']);
  assert.deepEqual(closes, [[4000, 'closed by server']]);
  s.close(); // the socket's own close event arrives later → no-op
  assert.deepEqual(released, ['alpha']);
});
