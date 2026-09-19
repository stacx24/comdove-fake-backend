import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  ADMIN_EVENT_TYPES,
  CLIENT_EVENT_TYPES,
  SERVER_EVENT_TYPES,
  encodeEvent,
  type AdminEvent,
  type ServerEvent,
} from '../../src/contract/ws-events.js';

test('event name lists have the frozen counts', () => {
  assert.equal(CLIENT_EVENT_TYPES.length, 6);
  assert.equal(SERVER_EVENT_TYPES.length, 8);
  assert.equal(ADMIN_EVENT_TYPES.length, 6);
});

test('event names are unique across all lists', () => {
  const client = new Set<string>(CLIENT_EVENT_TYPES);
  const serverAndAdmin = [...SERVER_EVENT_TYPES, ...ADMIN_EVENT_TYPES];
  assert.equal(new Set(serverAndAdmin).size, serverAndAdmin.length);
  // tile.presence and tile.autoreply exist in both directions on purpose
  const shared = serverAndAdmin.filter((t) => client.has(t)).sort();
  assert.deepEqual(shared, ['tile.autoreply', 'tile.presence']);
});

test('encodeEvent round-trips a group.claimed snapshot', () => {
  const ev: ServerEvent = {
    type: 'group.claimed',
    group: { id: 'alpha', name: 'Alpha' },
    business_numbers: [
      { phone_number_id: 'MOCK-PN-1', display_number: '918888800001', label: 'Sales' },
    ],
    tiles: [
      {
        number: '919876543210',
        label: null,
        online: true,
        auto_reply: { mode: 'manual', delay_ms: 0, rules: [] },
        history: [
          {
            wamid: 'wamid.MOCK-aaaaaaaaaaaaaaaaaaaaaaaa',
            peer: '918888800001',
            direction: 'outbound',
            body: 'Hello',
            status: 'read',
            created_at: 1758270000123,
          },
        ],
        queued: [],
        unread: { '918888800001': 0 },
      },
    ],
  };
  const text = encodeEvent(ev);
  assert.equal(typeof text, 'string');
  assert.deepEqual(JSON.parse(text), ev);
});

test('encodeEvent round-trips an admin log.entry', () => {
  const ev: AdminEvent = {
    type: 'log.entry',
    entry: {
      wamid: 'wamid.MOCK-bbbbbbbbbbbbbbbbbbbbbbbb',
      time: 1758270000123,
      direction: 'outbound',
      source: 'api',
      from: '918888800001',
      to: '919876543210',
      business: { phone_number_id: 'MOCK-PN-1', label: 'Sales' },
      group_id: 'alpha',
      body: 'Hello from Comdove',
      status: 'sent',
      timeline: [{ status: 'sent', at: 1758270000123 }],
      webhooks: [
        { kind: 'sent', state: 'ok', attempts: [{ n: 1, http_status: 200, duration_ms: 12, at: 1758270000650 }] },
      ],
    },
  };
  assert.deepEqual(JSON.parse(encodeEvent(ev)), ev);
});

test('encodeEvent keeps the error shape flat', () => {
  const ev: ServerEvent = { type: 'error', code: 'not_claimed', message: 'claim a group first' };
  assert.equal(encodeEvent(ev), '{"type":"error","code":"not_claimed","message":"claim a group first"}');
});
