// Builds the whole server: P2's SQLite store + control API, P1's Meta face, and the
// interim delivery until P3's live engine lands. Used by src/index.ts and the
// integrated e2e test, so tests exercise the exact boot wiring.
import express from 'express';
import swaggerUi from 'swagger-ui-express';
import { env, type Env } from './config/env.js';
import { db } from './db/db.js';
import { createApp } from './app.js';
import { createMetaFace } from './meta-face.js';
import { sqliteRegistry } from './core/registry-adapter.js';
import { services } from './core/services.js';
import type { Bus, BusEvent } from './core/ports.js';
import { SqliteJobStore } from './webhooks/job-store.js';
import type { DispatcherOptions } from './webhooks/dispatcher.js';
import { createInterimDelivery } from './dev/interim-delivery.js';
import { numbersRouter } from './api/numbers.route.js';
import { groupsRouter } from './api/groups.route.js';
import { trafficRouter } from './api/traffic.route.js';
import { autoReplyRouter } from './api/autoreply.route.js';
import { systemRouter } from './api/system.route.js';
import { fail } from './api/respond.js';
import { openapiSpec } from './docs/openapi.js';

export interface ComposeOptions {
  env?: Pick<Env, 'COMDOVE_WEBHOOK_URL' | 'APP_SECRET' | 'WEBHOOK_VERIFY_TOKEN' | 'STATUS_WEBHOOK_DELAY_MS'>;
  bus?: Bus;
  log?: (line: string) => void;
  /** Test knobs (retry delays, timeout). */
  dispatcher?: Partial<Pick<DispatcherOptions, 'retryDelaysMs' | 'timeoutMs'>>;
}

/** P2's control API. JSON parsing is scoped to /api and /reset so Meta routes keep their own parser. */
function controlApi() {
  const r = express.Router();
  r.use('/docs', swaggerUi.serve, swaggerUi.setup(openapiSpec));
  r.get('/openapi.json', (_req, res) => { res.json(openapiSpec); });
  r.use(['/api', '/reset'], express.json());
  r.use('/api', numbersRouter, groupsRouter, trafficRouter, autoReplyRouter);
  r.use(systemRouter); // /api/reset, /reset, /api/webhook/verify, /api/status
  r.use('/api', (_req, res) => { fail(res, 404, 'no such control API endpoint'); });
  return r;
}

export function composeServer(o: ComposeOptions = {}) {
  const cfg = o.env ?? env;
  const log = o.log ?? ((line: string) => console.log(line));
  const bus: Bus = o.bus ?? {
    emit(e: BusEvent) {
      if (e.type === 'message.status') log(`[bus] ${e.status.padEnd(9)} ${e.wamid} → ${e.number}`);
      if (e.type === 'message.new') log(`[bus] new ${e.message.direction} ${e.message.wamid}`);
    },
  };

  // Delivery and the Meta face reference each other (delivered → lifecycle), so late-bind.
  let lifecycleRef: ReturnType<typeof createMetaFace>['lifecycle'] | undefined;
  const delivery = createInterimDelivery({
    registry: sqliteRegistry,
    delivered: (msgs) => lifecycleRef?.delivered(msgs),
    inbound: (from, to, body, source) => lifecycleRef?.inbound(from, to, body, source),
    log,
  });

  const metaFace = createMetaFace({
    registry: sqliteRegistry,
    bus,
    delivery,
    jobStore: new SqliteJobStore(db),
    webhookUrl: cfg.COMDOVE_WEBHOOK_URL,
    appSecret: cfg.APP_SECRET,
    verifyToken: cfg.WEBHOOK_VERIFY_TOKEN,
    statusDelayMs: cfg.STATUS_WEBHOOK_DELAY_MS,
    dispatcher: o.dispatcher,
  });
  lifecycleRef = metaFace.lifecycle;

  services.inbound = metaFace.lifecycle.inbound;
  services.cancelWebhooks = () => metaFace.dispatcher.cancelAll();
  services.verify = async () => (services.lastVerify = await metaFace.verify());

  const app = createApp({ metaFace, controlApi: controlApi() });
  return { app, metaFace, delivery, bus };
}
