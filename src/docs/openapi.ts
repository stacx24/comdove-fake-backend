// OpenAPI 3 spec for comdove-fake-backend (served at /docs via swagger-ui-express).
// Person 2 owns the Control API + health below. Person 1 (Meta emulator) and
// Person 3 (WebSocket) add their paths as they build.

import { MAX_GROUP_SIZE } from '../contract/api-types.js';

const jsonBody = (schema: unknown) => ({ required: true, content: { 'application/json': { schema } } });
const ok = (example: unknown) => ({ '200': { description: 'OK', content: { 'application/json': { example } } } });

export const openapiSpec = {
  openapi: '3.0.3',
  info: {
    title: 'comdove-fake-backend — Mock WhatsApp / Meta Cloud API',
    version: '0.2.0',
    description:
      'Fake WhatsApp server for testing Comdove (wat-backend). This page documents the ' +
      'mock-only Control API (no auth). Meta emulator (/v23.0/...) and WebSocket (/ws) added later.',
  },
  servers: [{ url: 'http://localhost:4020', description: 'Local mock server' }],
  tags: [
    { name: 'Health' },
    { name: 'Numbers' },
    { name: 'Groups' },
    { name: 'Traffic' },
    { name: 'Auto-reply' },
    { name: 'System' },
  ],
  paths: {
    '/health': { get: { tags: ['Health'], summary: 'Health check', responses: ok({ status: 'ok', service: 'comdove-fake-backend' }) } },

    '/api/business-numbers': {
      post: {
        tags: ['Numbers'], summary: 'Register a business number (FR-01)',
        requestBody: jsonBody({
          type: 'object', required: ['display_number'],
          properties: {
            display_number: { type: 'string', example: '918888800001' },
            label: { type: 'string', example: 'Support line' },
            phone_number_id: { type: 'string', description: 'optional — supply Comdove’s real id (plan §5c)' },
            waba_id: { type: 'string' }, token: { type: 'string' },
          },
        }),
        responses: ok({ phone_number_id: 'MOCK-PN-1', token: 'mock-token-8f3a', waba_id: 'MOCK-WABA-1', display_number: '918888800001', label: 'Support line' }),
      },
      get: { tags: ['Numbers'], summary: 'List business numbers', responses: ok([{ phone_number_id: 'MOCK-PN-1', display_number: '918888800001', label: 'Support', token: 'mock-token', waba_id: 'MOCK-WABA-1' }]) },
    },
    '/api/business-numbers/{phone_number_id}': {
      delete: { tags: ['Numbers'], summary: 'Delete a business number (PRD C5)', parameters: [{ name: 'phone_number_id', in: 'path', required: true, schema: { type: 'string' } }], responses: { '204': { description: 'Deleted' }, '404': { description: 'Not found' } } },
    },
    '/api/customers': {
      get: { tags: ['Numbers'], summary: 'List customers with type + claim status (PRD §7)', responses: ok([{ number: '919876543210', label: null, group_id: 'alpha', online: true, effective_online: false, claim_status: 'free', reply_mode: 'manual', type: 'customer' }]) },
    },

    '/api/groups': {
      post: {
        tags: ['Groups'], summary: 'Create a client group (FR-15)',
        requestBody: jsonBody({ type: 'object', required: ['name', 'numbers'], properties: { name: { type: 'string', example: 'alpha' }, numbers: { type: 'array', maxItems: MAX_GROUP_SIZE, items: { type: 'string' }, example: ['919876543210', '919876543211'] } } }),
        responses: ok({ id: 'alpha', name: 'alpha', numbers: ['919876543210', '919876543211'] }),
      },
      get: { tags: ['Groups'], summary: 'List groups (free/locked)', responses: ok([{ id: 'alpha', name: 'alpha', count: 2, status: 'free', locked_since: null }]) },
    },
    '/api/groups/{id}': {
      delete: { tags: ['Groups'], summary: 'Delete a group (PRD C5)', parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }], responses: { '204': { description: 'Deleted' }, '409': { description: 'Group is claimed' } } },
    },

    '/api/presence': {
      post: { tags: ['Traffic'], summary: 'Set a tile online/offline (FR-05)', requestBody: jsonBody({ type: 'object', required: ['number', 'online'], properties: { number: { type: 'string', example: '919876543210' }, online: { type: 'boolean', example: true } } }), responses: ok({ number: '919876543210', online: true, effective_online: false }) },
    },
    '/api/inject': {
      post: { tags: ['Traffic'], summary: 'Inject an inbound message (FR-07 twin)', requestBody: jsonBody({ type: 'object', required: ['from', 'to', 'body'], properties: { from: { type: 'string', example: '919876543210' }, to: { type: 'string', example: '918888800001' }, body: { type: 'string', example: 'how much?' } } }), responses: ok({ wamid: 'wamid.MOCK-a1b2c3d4e5f6a1b2' }) },
    },
    '/api/log': {
      get: { tags: ['Traffic'], summary: 'Admin live log (FR-11)', parameters: [{ name: 'limit', in: 'query', schema: { type: 'integer', default: 100 } }], responses: ok([{ wamid: 'wamid.MOCK-...', time: 1758270000123, direction: 'inbound', source: 'inject', from: '919876543210', to: '918888800001', status: 'sent', timeline: [{ status: 'sent', at: 1758270000123 }], webhooks: [] }]) },
    },

    '/api/customers/{number}/auto-reply': {
      get: { tags: ['Auto-reply'], summary: 'Get a tile auto-reply (FR-10)', parameters: [{ name: 'number', in: 'path', required: true, schema: { type: 'string' } }], responses: ok({ mode: 'keyword', delay_ms: 0, rules: [{ keyword: 'price', reply: 'it is 500' }] }) },
      put: { tags: ['Auto-reply'], summary: 'Set a tile auto-reply (FR-10)', parameters: [{ name: 'number', in: 'path', required: true, schema: { type: 'string' } }], requestBody: jsonBody({ type: 'object', required: ['mode'], properties: { mode: { type: 'string', enum: ['manual', 'echo', 'keyword'] }, delay_ms: { type: 'integer' }, rules: { type: 'array', items: { type: 'object', properties: { keyword: { type: 'string' }, reply: { type: 'string' } } } } } }), responses: ok({ mode: 'keyword', delay_ms: 0, rules: [{ keyword: 'price', reply: 'it is 500' }] }) },
    },

    '/api/reset': { post: { tags: ['System'], summary: 'Reset — wipe messages/queues; keep numbers/groups (FR-12)', requestBody: { required: false, content: { 'application/json': { schema: { type: 'object', properties: { keep_numbers: { type: 'boolean', default: true } } } } } }, responses: ok({ ok: true, kept_numbers: true }) } },
    '/reset': { post: { tags: ['System'], summary: 'Reset alias (PRD FR-12 wording)', responses: ok({ ok: true, kept_numbers: true }) } },
    '/api/webhook/verify': { post: { tags: ['System'], summary: 'Re-run the verify handshake (Spec §5)', responses: ok({ ok: false, detail: 'unreachable', at: 0 }) } },
    '/api/status': { get: { tags: ['System'], summary: 'Admin header / debug', responses: ok({ uptime: 42, comdove_webhook_url: 'http://localhost:3000/webhooks/whatsapp', verify: { ok: false, detail: 'not run yet', at: 0 }, pending_webhooks: 0, counts: { business_numbers: 1, groups: 1, customers: 2, messages: 0 } }) } },
  },
};
