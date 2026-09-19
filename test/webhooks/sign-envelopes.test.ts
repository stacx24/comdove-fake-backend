import { test } from 'node:test';
import assert from 'node:assert/strict';
import { sign } from '../../src/webhooks/sign.js';
import { inboundEnvelope, statusEnvelope, unixSeconds } from '../../src/webhooks/envelopes.js';
import { verifyMetaSignature } from '../helpers/verify-meta-signature.js';
import type { BusinessNumber, Customer, StoredMessage } from '../../src/core/ports.js';

const SECRET = 'mock-app-secret-1';

test('signature is sha256=<64 hex> and wat-backend accepts it', () => {
  const raw = JSON.stringify({ a: 1 });
  const header = sign(raw, SECRET);
  assert.match(header, /^sha256=[0-9a-f]{64}$/);
  assert.equal(verifyMetaSignature(Buffer.from(raw), header, SECRET), true);
});

test('signature fails with another secret or a changed byte', () => {
  const raw = JSON.stringify({ a: 1 });
  const header = sign(raw, SECRET);
  assert.equal(verifyMetaSignature(Buffer.from(raw), header, 'other'), false);
  assert.equal(verifyMetaSignature(Buffer.from(raw.replace('1', '2')), header, SECRET), false);
});

test('unicode bodies are signed over their UTF-8 bytes', () => {
  const raw = JSON.stringify({ text: 'héllo 👋 नमस्ते' });
  assert.equal(verifyMetaSignature(Buffer.from(raw, 'utf8'), sign(raw, SECRET), SECRET), true);
  assert.equal(sign(raw, SECRET), sign(Buffer.from(raw, 'utf8'), SECRET));
});

const business: BusinessNumber = { phone_number_id: 'MOCK-PN-1', display_number: '918888800001', label: 'Sales', token: 't1', waba_id: 'W1' };
const customer: Customer = { number: '919876543210', group_id: 'alpha', label: null, online: true };
const message: StoredMessage = {
  wamid: 'wamid.MOCK-abc', conversation_id: 1, seq: 1, direction: 'inbound', source: 'tile',
  phone_number_id: 'MOCK-PN-1', customer_number: '919876543210', from_number: '919876543210', to_number: '918888800001',
  body: 'how much?', created_at: 1758270000999, sent_at: null, delivered_at: null, read_at: null,
};

test('unixSeconds is a floored string', () => assert.equal(unixSeconds(1758270000999), '1758270000'));

test('inbound envelope matches Spec §5 with per-business waba id', () => {
  assert.deepEqual(inboundEnvelope({ business, customer, message }), {
    object: 'whatsapp_business_account',
    entry: [{
      id: 'W1',
      changes: [{
        field: 'messages',
        value: {
          messaging_product: 'whatsapp',
          metadata: { display_phone_number: '918888800001', phone_number_id: 'MOCK-PN-1' },
          contacts: [{ profile: { name: 'Tile 919876543210' }, wa_id: '919876543210' }],
          messages: [{ from: '919876543210', id: 'wamid.MOCK-abc', timestamp: '1758270000', type: 'text', text: { body: 'how much?' } }],
        },
      }],
    }],
  });
});

test('inbound profile name uses the customer label when set', () => {
  const env = inboundEnvelope({ business, customer: { ...customer, label: 'Asha' }, message });
  assert.equal(env.entry[0].changes[0].value.contacts[0].profile.name, 'Asha');
});

test('status envelope matches Spec §5, one status, no pricing/conversation', () => {
  const env = statusEnvelope({ business, wamid: 'wamid.MOCK-abc', status: 'delivered', at: 1758270031500, recipient: '919876543210' });
  assert.deepEqual(env, {
    object: 'whatsapp_business_account',
    entry: [{
      id: 'W1',
      changes: [{
        field: 'messages',
        value: {
          messaging_product: 'whatsapp',
          metadata: { display_phone_number: '918888800001', phone_number_id: 'MOCK-PN-1' },
          statuses: [{ id: 'wamid.MOCK-abc', status: 'delivered', timestamp: '1758270031', recipient_id: '919876543210' }],
        },
      }],
    }],
  });
});

// wat-backend process-event.ts: field === 'messages' && value.messages?.length → inbound; value.statuses?.length → status
test('wat-backend routing keys are where it looks for them', () => {
  const i = inboundEnvelope({ business, customer, message }).entry[0].changes[0];
  const s = statusEnvelope({ business, wamid: 'x', status: 'sent', at: 0, recipient: '1' }).entry[0].changes[0];
  assert.equal(i.field, 'messages');
  assert.equal(i.value.messages.length, 1);
  assert.equal(s.value.statuses.length, 1);
  assert.equal('messages' in s.value, false);
});
