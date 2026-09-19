// Express app assembly. Mount order matters: the Meta catch-all must stay last.
import express, { type Router } from 'express';
import type { MetaFace } from './meta-face.js';

export interface AppParts {
  metaFace: MetaFace;
  /** P2's control API, mounted at /api (and its /reset alias). */
  controlApi?: Router;
}

export function createApp(p: AppParts) {
  const app = express();

  app.get('/health', (_req, res) => {
    res.json({ status: 'ok', service: 'comdove-fake-backend' });
  });

  if (p.controlApi) app.use(p.controlApi);

  app.use(p.metaFace.router);
  app.use(p.metaFace.notImplemented); // LAST
  return app;
}
