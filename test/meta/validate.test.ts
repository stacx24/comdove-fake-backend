import { test } from 'node:test';
import assert from 'node:assert/strict';
import { validate, type ValidateInput, type ValidateResult } from '../../src/meta/validate.js';
import { MemoryRegistry } from '../../src/dev/memory-registry.js';

function setup() {
  const reg = new MemoryRegistry().seed({
    business: [{ phone_number_id: 'MOCK-PN-1', token: 't1' }, { phone_number_id: 'MOCK-PN-2', token: 't2' }],
    customers: [{ number: '919876543210' }],
  });
  const inbound = reg.storeMessage({ wamid: 'wamid.IN1', direction: 'inbound', source: 'tile', phone_number_id: 'MOCK-PN-1', customer_number: '919876543210', body: 'hi', at: 1 });
  const outbound = reg.storeMessage({ wamid: 'wamid.OUT1', direction: 'outbound', source: 'api', phone_number_id: 'MOCK-PN-1', customer_number: '919876543210', body: 'yo', at: 2 });
  const inboundOther = reg.storeMessage({ wamid: 'wamid.IN2', direction: 'inbound', source: 'tile', phone_number_id: 'MOCK-PN-2', customer_number: '919876543210', body: 'hi', at: 3 });
  return { reg, inbound, outbound, inboundOther };
}

// wat-backend meta-graph.client.ts sendTextMessage payload — no recipient_type, no preview_url.
const watBody = { messaging_product: 'whatsapp', to: '919876543210', type: 'text', text: { body: 'Hello from Comdove' } };
const specBody = { ...watBody, recipient_type: 'individual', text: { preview_url: false, body: 'Hello from Comdove' } };
const ok: ValidateInput = { phoneNumberId: 'MOCK-PN-1', auth: 'Bearer t1', body: watBody };

function run(over: Partial<ValidateInput>) {
  return validate({ ...ok, ...over }, setup().reg);
}

function expectError(r: ValidateResult, status: number, code: number, subcode?: number) {
  assert.equal(r.kind, 'error', `expected error, got ${r.kind}`);
  if (r.kind !== 'error') return;
  assert.equal(r.error.status, status);
  assert.equal(r.error.body.error.code, code);
  assert.equal(r.error.body.error.error_subcode, subcode);
}

test('1. force-error wins over every other problem', () => {
  const r = run({ phoneNumberId: 'NOPE', auth: undefined, body: undefined, forceError: '130429' });
  expectError(r, 400, 130429);
  assert.equal(r.kind === 'error' && r.forced, true);
});

test('2. unknown phone_number_id is checked before the token', () => {
  expectError(run({ phoneNumberId: 'NOPE', auth: 'Bearer wrong' }), 400, 100, 33);
});

test('3. missing Authorization → 401/190', () => expectError(run({ auth: undefined }), 401, 190));
test('4. wrong token → 401/190', () => expectError(run({ auth: 'Bearer wrong' }), 401, 190));
test('4b. token of another business → 401/190', () => expectError(run({ auth: 'Bearer t2' }), 401, 190));
test('4c. non-Bearer scheme → 401/190', () => expectError(run({ auth: 'Basic t1' }), 401, 190));

test('5. bearer scheme is case-insensitive', () => {
  assert.equal(run({ auth: 'bearer t1' }).kind, 'send');
});

test('6. non-JSON / missing body → 400/100', () => {
  expectError(run({ body: undefined }), 400, 100);
  expectError(run({ body: 'text' }), 400, 100);
  expectError(run({ body: [] }), 400, 100);
});

test('7. wrong messaging_product → 400/100', () => {
  expectError(run({ body: { ...watBody, messaging_product: 'sms' } }), 400, 100);
});

test('8. neither type nor status → 400/100', () => {
  expectError(run({ body: { messaging_product: 'whatsapp', to: '919876543210' } }), 400, 100);
});

test('9. other message types → 400/100 not implemented', () => {
  const r = run({ body: { ...watBody, type: 'image' } });
  expectError(r, 400, 100);
  assert.match(r.kind === 'error' ? r.error.body.error.message : '', /not implemented in comdove-mock/);
});

test('10. bad text.body → 400/100', () => {
  for (const text of [undefined, {}, { body: '' }, { body: 42 }, { body: 'x'.repeat(4097) }, 'hi']) {
    expectError(run({ body: { ...watBody, text } }), 400, 100);
  }
  assert.equal(run({ body: { ...watBody, text: { body: 'x'.repeat(4096) } } }).kind, 'send');
});

test('11. missing or malformed to → 400/100', () => {
  const { to: _to, ...noTo } = watBody;
  expectError(run({ body: noTo }), 400, 100);
  expectError(run({ body: { ...watBody, to: 'abc' } }), 400, 100);
});

test('12. to not a registered customer → 400/131026', () => {
  expectError(run({ body: { ...watBody, to: '919999999999' } }), 400, 131026);
});

test('12b. a business number is not a valid recipient → 131026', () => {
  expectError(run({ body: { ...watBody, to: '918888800002' } }), 400, 131026);
});

test('13. formatted to: echoes input, normalizes wa_id', () => {
  const r = run({ body: { ...watBody, to: '+91 98765 43210' } });
  assert.equal(r.kind, 'send');
  if (r.kind === 'send') {
    assert.equal(r.to, '+91 98765 43210');
    assert.equal(r.waId, '919876543210');
    assert.equal(r.text, 'Hello from Comdove');
    assert.equal(r.business.phone_number_id, 'MOCK-PN-1');
  }
});

test('14. wat-backend exact payload is accepted', () => assert.equal(run({ body: watBody }).kind, 'send'));
test('15. full Spec §3 payload is accepted', () => assert.equal(run({ body: specBody }).kind, 'send'));

test('16. mark-as-read of an inbound message to this business', () => {
  const r = run({ body: { messaging_product: 'whatsapp', status: 'read', message_id: 'wamid.IN1' } });
  assert.equal(r.kind, 'read');
  if (r.kind === 'read') assert.equal(r.messageId, 'wamid.IN1');
});

test('17. mark-as-read of unknown / outbound / other business message → 400/100', () => {
  for (const id of ['wamid.NOPE', 'wamid.OUT1', 'wamid.IN2', undefined]) {
    expectError(run({ body: { messaging_product: 'whatsapp', status: 'read', message_id: id } }), 400, 100);
  }
});

test('17b. status other than read → 400/100', () => {
  expectError(run({ body: { messaging_product: 'whatsapp', status: 'delivered', message_id: 'wamid.IN1' } }), 400, 100);
});
