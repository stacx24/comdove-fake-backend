import express from 'express';
import swaggerUi from 'swagger-ui-express';
import { env } from './config/env.js';
import './db/db.js'; // opens SQLite + runs the schema on import
import { controlRouter } from './api/control.route.js';
import { openapiSpec } from './docs/openapi.js';

const app = express();
app.use(express.json());

// Health check — confirms the server is up.
app.get('/health', (_req, res) => {
  res.json({ status: 'ok', service: 'comdove-fake-backend' });
});

// Swagger API docs — browse + try every endpoint at /docs.
app.use('/docs', swaggerUi.serve, swaggerUi.setup(openapiSpec));
// Raw spec (handy for Postman / codegen).
app.get('/openapi.json', (_req, res) => res.json(openapiSpec));

// Control API (Person 2) — mock-only, no auth.
app.use('/api', controlRouter);

// TODO(Person 1): mount Meta emulator routes here (/v:version/:phoneNumberId/messages)
// TODO(Person 3): attach the WebSocket server (/ws) to the http server

app.listen(env.PORT, () => {
  console.log(`🟢 comdove-fake-backend listening on http://localhost:${env.PORT}`);
});
