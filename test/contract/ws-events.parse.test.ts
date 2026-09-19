import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseClientEvent, type ClientEvent } from '../../src/contract/ws-events.js';

function ok(frame: unknown, expected: ClientEvent): void {
  const result = parseClientEvent(JSON.stringify(frame));
  assert.deepEqual(result, { ok: true, event: expected });
}

function fails(raw: string, code: string, message: RegExp): void {
  const result = parseClientEvent(raw);
  assert.equal(result.ok, false);
  if (!result.ok) {
    assert.equal(result.error.code, code);
    assert.match(result.error.message, message);
  }
}

const TILE = '919876543210';
const BIZ = '918888800001';

// --- valid frames, one per client type ------------------------------------

test('parses group.claim', () => {
  ok({ type: 'group.claim', group: 'alpha' }, { type: 'group.claim', group: 'alpha' });
});

test('parses message.send', () => {
  ok(
    { type: 'message.send', from: TILE, to: BIZ, body: 'how much?' },
    { type: 'message.send', from: TILE, to: BIZ, body: 'how much?' },
  );
});

test('parses tile.presence with online false', () => {
  ok(
    { type: 'tile.presence', number: TILE, online: false },
    { type: 'tile.presence', number: TILE, online: false },
  );
});

test('parses chat.read', () => {
  ok({ type: 'chat.read', number: TILE, peer: BIZ }, { type: 'chat.read', number: TILE, peer: BIZ });
});

test('parses tile.autoreply', () => {
  ok(
    {
      type: 'tile.autoreply',
      number: TILE,
      mode: 'keyword',
      delay_ms: 500,
      rules: [{ keyword: 'price', reply: 'how much?' }],
    },
    {
      type: 'tile.autoreply',
      number: TILE,
      mode: 'keyword',
      delay_ms: 500,
      rules: [{ keyword: 'price', reply: 'how much?' }],
    },
  );
});

test('parses tile.autoreply with boundary delays and no rules', () => {
  ok(
    { type: 'tile.autoreply', number: TILE, mode: 'manual', delay_ms: 0, rules: [] },
    { type: 'tile.autoreply', number: TILE, mode: 'manual', delay_ms: 0, rules: [] },
  );
  ok(
    { type: 'tile.autoreply', number: TILE, mode: 'echo', delay_ms: 30000, rules: [] },
    { type: 'tile.autoreply', number: TILE, mode: 'echo', delay_ms: 30000, rules: [] },
  );
});

test('parses admin.subscribe', () => {
  ok({ type: 'admin.subscribe' }, { type: 'admin.subscribe' });
});

test('accepts a body of exactly 4096 characters', () => {
  const body = 'x'.repeat(4096);
  ok({ type: 'message.send', from: TILE, to: BIZ, body }, { type: 'message.send', from: TILE, to: BIZ, body });
});

// --- unknown fields are dropped -------------------------------------------

test('drops unknown top-level fields', () => {
  ok({ type: 'group.claim', group: 'alpha', extra: 1 }, { type: 'group.claim', group: 'alpha' });
  ok({ type: 'admin.subscribe', token: 'x' }, { type: 'admin.subscribe' });
});

test('drops unknown fields inside auto-reply rules', () => {
  ok(
    {
      type: 'tile.autoreply',
      number: TILE,
      mode: 'keyword',
      delay_ms: 0,
      rules: [{ keyword: 'yes', reply: 'confirm', priority: 9 }],
    },
    {
      type: 'tile.autoreply',
      number: TILE,
      mode: 'keyword',
      delay_ms: 0,
      rules: [{ keyword: 'yes', reply: 'confirm' }],
    },
  );
});

// --- bad_json -------------------------------------------------------------

test('bad_json for text that is not JSON', () => {
  fails('not json', 'bad_json', /not valid JSON/);
});

test('bad_json for JSON that is not an object', () => {
  fails('[]', 'bad_json', /JSON object/);
  fails('null', 'bad_json', /JSON object/);
  fails('42', 'bad_json', /JSON object/);
  fails('"group.claim"', 'bad_json', /JSON object/);
});

// --- type problems ----------------------------------------------------------

test('bad_request when type is missing or not a string', () => {
  fails('{}', 'bad_request', /missing field: type/);
  fails('{"type":5}', 'bad_request', /missing field: type/);
});

test('unknown_type for a type that is not a client event', () => {
  fails('{"type":"foo.bar"}', 'unknown_type', /unknown type: foo\.bar/);
  // a server->client event name is not a valid client event
  fails('{"type":"message.new"}', 'unknown_type', /unknown type: message\.new/);
});

// --- field problems -------------------------------------------------------

test('bad_request for an empty or missing group', () => {
  fails('{"type":"group.claim","group":""}', 'bad_request', /'group'/);
  fails('{"type":"group.claim","group":"   "}', 'bad_request', /'group'/);
  fails('{"type":"group.claim"}', 'bad_request', /'group'/);
});

test('bad_request when online is not a boolean', () => {
  fails(`{"type":"tile.presence","number":"${TILE}","online":"yes"}`, 'bad_request', /'online' must be boolean/);
});

test('bad_request for an empty or too-long body', () => {
  const base = { type: 'message.send', from: TILE, to: BIZ };
  fails(JSON.stringify({ ...base, body: '' }), 'bad_request', /'body'/);
  fails(JSON.stringify({ ...base, body: '  \n ' }), 'bad_request', /'body'/);
  fails(JSON.stringify({ ...base, body: 'x'.repeat(4097) }), 'bad_request', /'body' must be at most 4096/);
});

test('bad_request for a missing from or to', () => {
  fails(JSON.stringify({ type: 'message.send', to: BIZ, body: 'hi' }), 'bad_request', /'from'/);
  fails(JSON.stringify({ type: 'message.send', from: TILE, body: 'hi' }), 'bad_request', /'to'/);
});

test('bad_request for a missing peer on chat.read', () => {
  fails(JSON.stringify({ type: 'chat.read', number: TILE }), 'bad_request', /'peer'/);
});

test('bad_request for an unknown auto-reply mode', () => {
  const frame = { type: 'tile.autoreply', number: TILE, mode: 'loud', delay_ms: 0, rules: [] };
  fails(JSON.stringify(frame), 'bad_request', /'mode' must be one of manual, echo, keyword/);
});

test('bad_request for delay_ms out of range or not an integer', () => {
  for (const delay_ms of [-1, 30001, 1.5, '100']) {
    const frame = { type: 'tile.autoreply', number: TILE, mode: 'echo', delay_ms, rules: [] };
    fails(JSON.stringify(frame), 'bad_request', /'delay_ms' must be an integer from 0 to 30000/);
  }
});

test('bad_request for bad rules', () => {
  const base = { type: 'tile.autoreply', number: TILE, mode: 'keyword', delay_ms: 0 };
  fails(JSON.stringify({ ...base, rules: 'price' }), 'bad_request', /'rules' must be an array/);
  fails(JSON.stringify({ ...base, rules: ['price'] }), 'bad_request', /'rules\[0\]' must be an object/);
  fails(
    JSON.stringify({ ...base, rules: [{ keyword: 'ok', reply: 'fine' }, { keyword: '', reply: 'x' }] }),
    'bad_request',
    /'rules\[1\]\.keyword'/,
  );
  fails(JSON.stringify({ ...base, rules: [{ keyword: 'ok' }] }), 'bad_request', /'rules\[0\]\.reply'/);
});

// --- input types ------------------------------------------------------------

test('parses a Buffer the same as a string', () => {
  const frame = JSON.stringify({ type: 'group.claim', group: 'alpha' });
  assert.deepEqual(parseClientEvent(Buffer.from(frame, 'utf8')), parseClientEvent(frame));
});
