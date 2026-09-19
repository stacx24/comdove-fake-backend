import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createSessionIndex } from '../../src/ws/session-index.js';
import type { Session } from '../../src/ws/session.js';

const fake = (): Session => ({ role: { kind: 'none' }, send: () => {}, handle: () => {}, close: () => {} });

test('the index maps a group to its session and only that session can remove it', () => {
  const index = createSessionIndex();
  const a = fake();
  const b = fake();
  assert.equal(index.get('alpha'), undefined);
  index.add('alpha', a);
  assert.equal(index.get('alpha'), a);
  index.remove('alpha', b); // not the holder
  assert.equal(index.get('alpha'), a);
  index.remove('alpha', a);
  assert.equal(index.get('alpha'), undefined);
});
