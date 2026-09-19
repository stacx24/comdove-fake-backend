import { test } from 'node:test';
import assert from 'node:assert/strict';
import { READ_SUCCESS, sendSuccess } from '../../src/meta/responses.js';

test('send success is Meta’s exact shape', () => {
  assert.deepEqual(sendSuccess('+91 98765 43210', '919876543210', 'wamid.MOCK-x'), {
    messaging_product: 'whatsapp',
    contacts: [{ input: '+91 98765 43210', wa_id: '919876543210' }],
    messages: [{ id: 'wamid.MOCK-x' }],
  });
});

test('mark-as-read success', () => assert.deepEqual(READ_SUCCESS, { success: true }));
