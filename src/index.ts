<<<<<<< HEAD
import express from 'express';
import swaggerUi from 'swagger-ui-express';
import { env } from './config/env.js';
import './db/db.js'; // opens SQLite + runs the schema on import
import { numbersRouter } from './api/numbers.route.js';
import { groupsRouter } from './api/groups.route.js';
import { trafficRouter } from './api/traffic.route.js';
import { autoReplyRouter } from './api/autoreply.route.js';
import { systemRouter } from './api/system.route.js';
import { openapiSpec } from './docs/openapi.js';
=======
import { env } from './config/env.js';
import { createApp } from './app.js';
import { createMetaFace } from './meta-face.js';
import { MemoryJobStore } from './webhooks/job-store.js';
import { createDevParts, DEV_BUSINESS, DEV_CUSTOMERS } from './dev/dev-wiring.js';
>>>>>>> 4931ef9 (feat(p1): wire Meta face into boot (createMetaFace + createApp))

// Until checkpoint ①: in-memory registry + always-online delivery (src/dev).
// P2 swaps in the SQLite registry + SqliteJobStore; P3 swaps in the WebSocket delivery + bus.
const dev = createDevParts();

<<<<<<< HEAD
// Health check — confirms the server is up.
app.get('/health', (_req, res) => {
  res.json({ status: 'ok', service: 'comdove-fake-backend' });
=======
const metaFace = createMetaFace({
  registry: dev.registry,
  bus: dev.bus,
  delivery: dev.delivery,
  jobStore: new MemoryJobStore(),
  webhookUrl: env.COMDOVE_WEBHOOK_URL,
  appSecret: env.APP_SECRET,
  verifyToken: env.WEBHOOK_VERIFY_TOKEN,
  statusDelayMs: env.STATUS_WEBHOOK_DELAY_MS,
>>>>>>> 4931ef9 (feat(p1): wire Meta face into boot (createMetaFace + createApp))
});
dev.connect((msgs) => metaFace.lifecycle.delivered(msgs));

<<<<<<< HEAD
// Swagger API docs — browse + try every endpoint at /docs.
app.use('/docs', swaggerUi.serve, swaggerUi.setup(openapiSpec));
app.get('/openapi.json', (_req, res) => res.json(openapiSpec));

// Control API (Person 2) — mock-only, no auth (plan §10).
app.use('/api', numbersRouter);
app.use('/api', groupsRouter);
app.use('/api', trafficRouter);
app.use('/api', autoReplyRouter);
app.use('/', systemRouter); // /api/reset, /reset alias, /api/webhook/verify, /api/status

// TODO(Person 1): mount Meta emulator (/v:version/:phoneNumberId/messages), webhook dispatcher, verify handshake
// TODO(Person 3): attach the WebSocket server (/ws) — group sessions + admin feed; wire lock + auto-reply trigger

app.listen(env.PORT, () => {
  console.log(`🟢 comdove-fake-backend listening on http://localhost:${env.PORT}`);
=======
const app = createApp({ metaFace });

app.listen(env.PORT, () => {
  console.log(`🟢 comdove-fake-backend listening on http://localhost:${env.PORT}`);
  console.log(`   webhooks → ${env.COMDOVE_WEBHOOK_URL}`);
  console.log(`   dev business ${DEV_BUSINESS.phone_number_id} token=${DEV_BUSINESS.token} · customers ${DEV_CUSTOMERS.join(', ')}`);
  metaFace.start();
  void metaFace.verify().then((r) =>
    console.log(r.ok ? '🤝 webhook handshake ok' : `⚠️  webhook handshake failed: ${r.detail} (continuing)`),
  );
>>>>>>> 4931ef9 (feat(p1): wire Meta face into boot (createMetaFace + createApp))
});
