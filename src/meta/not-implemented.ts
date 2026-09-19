import type { ErrorRequestHandler, RequestHandler } from 'express';
import { metaError } from './errors.js';

/**
 * Catch-all for every Graph path/method the mock does not emulate (Spec §2): fail loudly
 * with a Meta-shaped 400/100. Mount LAST, after /health, /api, /reset and the Meta router.
 */
export function metaNotImplemented(): RequestHandler {
  return (req, res) => {
    const e = metaError('not_implemented', { method: req.method, path: req.path });
    res.status(e.status).json(e.body);
  };
}

/** Body-parser failures on Meta routes → Meta 400/100 instead of Express's HTML page. */
export function metaJsonErrorHandler(): ErrorRequestHandler {
  return (err, _req, res, next) => {
    const status = (err as { status?: number; statusCode?: number }).status ?? (err as { statusCode?: number }).statusCode;
    if (res.headersSent || !status || status >= 500) return next(err);
    const e = metaError('invalid_param', { detail: 'request body is not valid JSON' });
    res.status(e.status).json(e.body);
  };
}
