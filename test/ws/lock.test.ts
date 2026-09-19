import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createLockTable } from '../../src/ws/lock.js';

function setup() {
  let time = 1000;
  const changes: string[] = [];
  const lock = createLockTable({ now: () => time, onChange: (g) => changes.push(g) });
  return { lock, changes, advance: (ms: number) => (time += ms) };
}

const OWNER_A = {};
const OWNER_B = {};

test('claiming a free group takes the lock', () => {
  const { lock } = setup();
  assert.deepEqual(lock.claim('alpha', OWNER_A), { ok: true, since: 1000 });
  assert.equal(lock.isLocked('alpha'), true);
  assert.equal(lock.lockedSince('alpha'), 1000);
  assert.equal(lock.isLocked('beta'), false);
  assert.equal(lock.lockedSince('beta'), null);
});

test('a second owner is refused and gets the holder since', () => {
  const { lock, advance } = setup();
  lock.claim('alpha', OWNER_A);
  advance(500);
  assert.deepEqual(lock.claim('alpha', OWNER_B), { ok: false, since: 1000 });
  assert.equal(lock.lockedSince('alpha'), 1000);
  // A still owns it: B cannot release, A can
  assert.equal(lock.release('alpha', OWNER_B), false);
  assert.equal(lock.release('alpha', OWNER_A), true);
});

test('the same owner claiming again is refused and changes nothing', () => {
  const { lock, advance } = setup();
  lock.claim('alpha', OWNER_A);
  advance(500);
  assert.deepEqual(lock.claim('alpha', OWNER_A), { ok: false, since: 1000 });
  assert.equal(lock.lockedSince('alpha'), 1000);
});

test('release by a non-owner or on a free group does nothing', () => {
  const { lock } = setup();
  assert.equal(lock.release('alpha', OWNER_A), false);
  lock.claim('alpha', OWNER_A);
  assert.equal(lock.release('alpha', OWNER_B), false);
  assert.equal(lock.isLocked('alpha'), true);
});

test('release by the owner frees the group for someone else', () => {
  const { lock, advance } = setup();
  lock.claim('alpha', OWNER_A);
  assert.equal(lock.release('alpha', OWNER_A), true);
  assert.equal(lock.isLocked('alpha'), false);
  assert.equal(lock.lockedSince('alpha'), null);
  advance(2000);
  assert.deepEqual(lock.claim('alpha', OWNER_B), { ok: true, since: 3000 });
});

test('onChange fires once per real change only', () => {
  const { lock, changes } = setup();
  lock.claim('alpha', OWNER_A); // change
  lock.claim('alpha', OWNER_B); // refused
  lock.release('alpha', OWNER_B); // refused
  lock.claim('beta', OWNER_B); // change
  lock.release('alpha', OWNER_A); // change
  lock.release('alpha', OWNER_A); // already free
  assert.deepEqual(changes, ['alpha', 'beta', 'alpha']);
});
