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

const app = express();
app.use(express.json());

// Health check — confirms the server is up.
app.get('/health', (_req, res) => {
  res.json({ status: 'ok', service: 'comdove-fake-backend' });
});

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
});
