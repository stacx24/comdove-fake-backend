// OpenAPI 3 spec for comdove-fake-backend.
// Kept as a TS object (served via swagger-ui-express at /docs).
// Person 2 owns the Control API + health below. Person 1 (Meta emulator) and
// Person 3 (WebSocket) add their paths here as they build.

export const openapiSpec = {
  openapi: '3.0.3',
  info: {
    title: 'comdove-fake-backend — Mock WhatsApp / Meta Cloud API',
    version: '0.1.0',
    description:
      'Fake WhatsApp server for testing Comdove (wat-backend) end to end. ' +
      'This page documents the mock-only Control API (no auth). ' +
      'Meta emulator (/v23.0/...) and WebSocket (/ws) are added as they are built.',
  },
  servers: [{ url: 'http://localhost:4020', description: 'Local mock server' }],
  tags: [
    { name: 'Health', description: 'Service status' },
    { name: 'Control API', description: 'Mock-only admin endpoints (no auth)' },
  ],
  paths: {
    '/health': {
      get: {
        tags: ['Health'],
        summary: 'Health check',
        responses: {
          '200': {
            description: 'Server is up',
            content: {
              'application/json': {
                example: { status: 'ok', service: 'comdove-fake-backend' },
              },
            },
          },
        },
      },
    },

    '/api/business-numbers': {
      post: {
        tags: ['Control API'],
        summary: 'Register a business number (FR-01)',
        requestBody: {
          required: true,
          content: {
            'application/json': {
              schema: {
                type: 'object',
                required: ['display_number'],
                properties: {
                  display_number: { type: 'string', example: '918888800001' },
                  label: { type: 'string', example: 'Support line' },
                },
              },
            },
          },
        },
        responses: {
          '200': {
            description: 'Registered — returns fake id + token',
            content: {
              'application/json': {
                example: {
                  phone_number_id: 'MOCK-PN-1',
                  token: 'MOCK-TOKEN-8f3a1b2c3d4e',
                },
              },
            },
          },
          '400': { $ref: '#/components/responses/BadRequest' },
        },
      },
      get: {
        tags: ['Control API'],
        summary: 'List business numbers',
        responses: {
          '200': {
            description: 'All registered business numbers',
            content: {
              'application/json': {
                example: [
                  {
                    phone_number_id: 'MOCK-PN-1',
                    display_number: '918888800001',
                    label: 'Support line',
                    token: 'MOCK-TOKEN-8f3a1b2c3d4e',
                    type: 'business',
                  },
                ],
              },
            },
          },
        },
      },
    },

    '/api/groups': {
      post: {
        tags: ['Control API'],
        summary: 'Create a client group (FR-15) — customer numbers auto-register',
        requestBody: {
          required: true,
          content: {
            'application/json': {
              schema: {
                type: 'object',
                required: ['name', 'numbers'],
                properties: {
                  name: { type: 'string', example: 'alpha' },
                  numbers: {
                    type: 'array',
                    maxItems: 10,
                    items: { type: 'string' },
                    example: ['919876543210', '919876543211'],
                  },
                },
              },
            },
          },
        },
        responses: {
          '200': {
            description: 'Group created',
            content: {
              'application/json': {
                example: {
                  id: 'alpha',
                  name: 'alpha',
                  numbers: ['919876543210', '919876543211'],
                },
              },
            },
          },
          '400': { $ref: '#/components/responses/BadRequest' },
        },
      },
      get: {
        tags: ['Control API'],
        summary: 'List groups with free/locked status (FR-09, FR-16)',
        responses: {
          '200': {
            description: 'All groups',
            content: {
              'application/json': {
                example: [
                  { id: 'alpha', name: 'alpha', count: 2, status: 'free' },
                ],
              },
            },
          },
        },
      },
    },

    '/api/presence': {
      post: {
        tags: ['Control API'],
        summary: 'Set a tile online/offline (FR-05)',
        requestBody: {
          required: true,
          content: {
            'application/json': {
              schema: {
                type: 'object',
                required: ['number', 'online'],
                properties: {
                  number: { type: 'string', example: '919876543210' },
                  online: { type: 'boolean', example: true },
                },
              },
            },
          },
        },
        responses: {
          '200': {
            description: 'Updated',
            content: { 'application/json': { example: { ok: true } } },
          },
          '400': { $ref: '#/components/responses/BadRequest' },
        },
      },
    },

    '/api/inject': {
      post: {
        tags: ['Control API'],
        summary: 'Inject an inbound message as if a tile typed it (FR-07 twin)',
        requestBody: {
          required: true,
          content: {
            'application/json': {
              schema: {
                type: 'object',
                required: ['from', 'to', 'body'],
                properties: {
                  from: { type: 'string', example: '919876543210' },
                  to: { type: 'string', example: '918888800001' },
                  body: { type: 'string', example: 'how much?' },
                },
              },
            },
          },
        },
        responses: {
          '200': {
            description: 'Stored — returns the wamid',
            content: {
              'application/json': {
                example: { wamid: 'wamid.MOCK-a1b2c3d4e5f6a1b2' },
              },
            },
          },
          '400': { $ref: '#/components/responses/BadRequest' },
        },
      },
    },

    '/api/log': {
      get: {
        tags: ['Control API'],
        summary: 'Admin live log — every message + status timeline (FR-11)',
        parameters: [
          {
            name: 'limit',
            in: 'query',
            schema: { type: 'integer', default: 100 },
            description: 'Max rows (newest first)',
          },
        ],
        responses: {
          '200': {
            description: 'Recent messages',
            content: {
              'application/json': {
                example: [
                  {
                    id: 'wamid.MOCK-a1b2c3d4e5f6a1b2',
                    direction: 'inbound',
                    from_number: '919876543210',
                    to_number: '918888800001',
                    body: 'how much?',
                    status: 'sent',
                    webhook_result: null,
                    created_at: 1789806058672,
                  },
                ],
              },
            },
          },
        },
      },
    },

    '/api/reset': {
      post: {
        tags: ['Control API'],
        summary: 'Reset — wipe messages/queues; keep numbers/groups if asked (FR-12)',
        requestBody: {
          required: false,
          content: {
            'application/json': {
              schema: {
                type: 'object',
                properties: {
                  keep_numbers: {
                    type: 'boolean',
                    default: true,
                    description: 'Keep numbers + groups (default true)',
                  },
                },
              },
            },
          },
        },
        responses: {
          '200': {
            description: 'Reset done',
            content: {
              'application/json': {
                example: { ok: true, kept_numbers: true },
              },
            },
          },
        },
      },
    },
  },

  components: {
    responses: {
      BadRequest: {
        description: 'Validation error',
        content: {
          'application/json': {
            example: { error: { message: 'display_number is required' } },
          },
        },
      },
    },
  },
};
