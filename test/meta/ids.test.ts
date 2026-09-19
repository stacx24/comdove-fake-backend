import { test } from 'node:test';
import assert from 'node:assert/strict';
import { newWamid, nextTraceId, normalizeNumber } from '../../src/meta/ids.js';

test('wamid format', () => assert.match(newWamid(), /^wamid\.MOCK-[0-9a-f]{24}$/));

test('wamids are unique', () => {
  assert.equal(new Set(Array.from({ length: 1000 }, newWamid)).size, 1000);
});

test('trace ids are MOCK-trace-NNNNNN and unique', () => {
  const a = nextTraceId();
  assert.match(a, /^MOCK-trace-\d{6}$/);
  assert.notEqual(a, nextTraceId());
});

test('normalizeNumber strips +, spaces, dashes', () => {
  assert.equal(normalizeNumber('+91 98765-43210'), '919876543210');
  assert.equal(normalizeNumber('919876543210'), '919876543210');
});

test('normalizeNumber rejects junk and wrong lengths', () => {
  assert.equal(normalizeNumber('12ab5678'), null);
  assert.equal(normalizeNumber('1234567'), null);
  assert.equal(normalizeNumber('1234567890123456'), null);
  assert.equal(normalizeNumber(''), null);
  assert.equal(normalizeNumber(919876543210 as unknown as string), null);
});
