// Builds the whole server: P2's SQLite store + control API, P1's Meta face and P3's
// live engine (attach it with live.attach(server)). Used by src/index.ts and the
// integrated e2e tests, so tests exercise the exact boot wiring.
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
import { createLiveEngine } from './live.js';
import { numbersRouter } from './api/numbers.route.js';
import { groupsRouter } from './api/groups.route.js';
import { trafficRouter } from './api/traffic.route.js';
import { autoReplyRouter } from './api/autoreply.route.js';
import { systemRouter } from './api/system.route.js';
import { fail } from './api/respond.js';
import { openapiSpec } from './docs/openapi.js';

export interface ComposeOptions {
  env?: Pick<
    Env,
    'COMDOVE_WEBHOOK_URL' | 'APP_SECRET' | 'WEBHOOK_VERIFY_TOKEN' | 'STATUS_WEBHOOK_DELAY_MS'
  > &
    Partial<Pick<Env, 'WEBHOOK_MAX_PARALLEL'>>;
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
  // P3's live engine (/ws sessions, bus, delivery). Delivery and the Meta face reference
  // each other (delivered → lifecycle), so the lifecycle is late-bound.
  let lifecycleRef: ReturnType<typeof createMetaFace>['lifecycle'] | undefined;
  const live = createLiveEngine({ lifecycle: () => lifecycleRef, log });
  const extraBus = o.bus;
  const bus: Bus = extraBus
    ? {
        emit(e: BusEvent) {
          live.bus.emit(e);
          extraBus.emit(e); // tests may listen in
        },
      }
    : live.bus;
  const delivery = live.delivery;

  const metaFace = createMetaFace({
    registry: sqliteRegistry,
    bus,
    delivery,
    jobStore: new SqliteJobStore(db),
    webhookUrl: cfg.COMDOVE_WEBHOOK_URL,
    appSecret: cfg.APP_SECRET,
    verifyToken: cfg.WEBHOOK_VERIFY_TOKEN,
    statusDelayMs: cfg.STATUS_WEBHOOK_DELAY_MS,
    dispatcher: { maxParallel: cfg.WEBHOOK_MAX_PARALLEL, ...o.dispatcher },
  });
  lifecycleRef = metaFace.lifecycle;

  services.inbound = metaFace.lifecycle.inbound;
  services.cancelWebhooks = () => metaFace.dispatcher.cancelAll();
  services.verify = async () => (services.lastVerify = await metaFace.verify());
  services.presence = live.groupEvents.setPresence;
  services.autoReplyChanged = (number, ar) => {
    live.groupEvents.autoReplyChanged(number, ar);
    live.admin.numbersChanged(); // reply_mode is in the customers list
  };
  services.adminChanged = live.adminChanged;
  services.afterReset = live.reset;

  const app = createApp({ metaFace, controlApi: controlApi() });
  return { app, metaFace, delivery, bus, live };
}
