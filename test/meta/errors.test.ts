import { test } from 'node:test';
import assert from 'node:assert/strict';
import { metaError, parseForceError, type MetaErrorKind } from '../../src/meta/errors.js';

const table: Array<[MetaErrorKind, number, number]> = [
  ['unknown_object', 400, 100],
  ['invalid_token', 401, 190],
  ['invalid_param', 400, 100],
  ['not_implemented', 400, 100],
  ['undeliverable', 400, 131026],
  ['rate_limit', 400, 130429],
];

for (const [kind, status, code] of table) {
  test(`${kind} → HTTP ${status} / code ${code}`, () => {
    const e = metaError(kind, { id: 'X', method: 'GET', path: '/v23.0/x/media' });
    assert.equal(e.status, status);
    assert.equal(e.body.error.code, code);
    assert.equal(e.body.error.type, 'OAuthException');
    assert.match(e.body.error.fbtrace_id, /^MOCK-trace-\d{6}$/);
    if (kind === 'unknown_object') assert.equal(e.body.error.error_subcode, 33);
    else assert.equal('error_subcode' in e.body.error, false);
  });
}

test('undeliverable matches the Spec §4 example (except fbtrace_id)', () => {
  const { body } = metaError('undeliverable');
  const { fbtrace_id, ...rest } = body.error;
  assert.ok(fbtrace_id);
  assert.deepEqual(rest, {
    message: '(#131026) Message undeliverable',
    type: 'OAuthException',
    code: 131026,
    error_data: { messaging_product: 'whatsapp', details: 'Recipient is not a registered mock number' },
  });
});

test('unknown_object names the id', () => {
  assert.match(metaError('unknown_object', { id: 'NOPE' }).body.error.message, /Object with ID 'NOPE' does not exist/);
});

test('not_implemented names method + path and says comdove-mock', () => {
  const m = metaError('not_implemented', { method: 'POST', path: '/v23.0/123/media' }).body.error.message;
  assert.equal(m, '(#100) POST /v23.0/123/media is not implemented in comdove-mock');
});

test('invalid_param carries a detail', () => {
  const e = metaError('invalid_param', { detail: 'text.body is required' }).body.error;
  assert.equal(e.message, '(#100) Invalid parameter');
  assert.deepEqual(e.error_data, { messaging_product: 'whatsapp', details: 'text.body is required' });
});

test('invalid_token message', () => {
  assert.equal(metaError('invalid_token').body.error.message, 'Invalid OAuth access token - Cannot parse access token');
});

test('parseForceError maps supported codes', () => {
  assert.equal(parseForceError(undefined), null);
  assert.equal(parseForceError('190')?.kind, 'invalid_token');
  assert.equal(parseForceError('33')?.kind, 'unknown_object');
  assert.equal(parseForceError('100')?.kind, 'invalid_param');
  assert.equal(parseForceError(' 131026 ')?.kind, 'undeliverable');
  assert.equal(parseForceError('130429')?.kind, 'rate_limit');
});

test('parseForceError rejects unsupported values with a 100', () => {
  for (const v of ['999', 'abc', '']) {
    const p = parseForceError(v);
    assert.equal(p?.kind, 'invalid_param');
    assert.equal(p?.detail, 'unsupported X-Mock-Force-Error value');
  }
});

// wat-backend meta-graph.client.ts readMetaError — types must survive a JSON round trip.
test('wat-backend readMetaError sees numeric code/subcode and string trace/type', () => {
  const body = JSON.parse(JSON.stringify(metaError('unknown_object', { id: 'x' }).body));
  const e = body.error;
  assert.equal(typeof e.code, 'number');
  assert.equal(typeof e.error_subcode, 'number');
  assert.equal(typeof e.message, 'string');
  assert.equal(typeof e.type, 'string');
  assert.equal(typeof e.fbtrace_id, 'string');
});
