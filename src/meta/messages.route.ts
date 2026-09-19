// POST /{version}/{phone_number_id}/messages — the endpoint Comdove calls instead of
// graph.facebook.com (Tech Spec §3, build plan §7).
import express, { type Router } from 'express';
import type { Delivery, Registry } from '../core/ports.js';
import type { Lifecycle } from '../core/lifecycle.js';
import { validate } from './validate.js';
import { READ_SUCCESS, sendSuccess } from './responses.js';
import { metaJsonErrorHandler } from './not-implemented.js';

export { metaNotImplemented, metaJsonErrorHandler } from './not-implemented.js';

const VERSION = /^v\d+\.\d+$/;

export interface MetaRouterDeps {
  registry: Registry;
  lifecycle: Lifecycle;
  delivery: Delivery;
  now?: () => number;
}

export function createMetaRouter(d: MetaRouterDeps): Router {
  const now = d.now ?? Date.now;
  const router = express.Router();

  router.post('/:version/:phoneNumberId/messages', (req, res, next) => {
    // Anything that is not /vNN.N/ falls through to the not-implemented catch-all.
    if (!VERSION.test(req.params.version)) return next('router');
    next();
  });

  router.post('/:version/:phoneNumberId/messages', express.json({ limit: '1mb' }), (req, res) => {
    const { phoneNumberId } = req.params;
    const result = validate(
      { phoneNumberId, auth: req.get('authorization'), forceError: req.get('x-mock-force-error'), body: req.body },
      d.registry,
    );

    if (result.kind === 'error') {
      const { status, body } = result.error;
      const sent = (req.body ?? {}) as { to?: unknown; text?: { body?: unknown } };
      d.registry.logRejected({
        at: now(),
        phone_number_id: phoneNumberId,
        http_status: status,
        code: body.error.code,
        ...(body.error.error_subcode !== undefined && { subcode: body.error.error_subcode }),
        forced: result.forced,
        ...(typeof sent.to === 'string' && { to: sent.to }),
        ...(typeof sent.text?.body === 'string' && { body: sent.text.body }),
      });
      res.status(status).json(body);
      return;
    }

    if (result.kind === 'read') {
      d.lifecycle.markInboundRead(result.business, result.messageId);
      res.json(READ_SUCCESS);
      return;
    }

    const msg = d.lifecycle.accept(result.business, result.waId, result.text);
    // Deliver only after the 200 is on the wire: Comdove must see the wamid first.
    res.once('finish', () => d.delivery.deliver(msg));
    res.status(200).json(sendSuccess(result.to, result.waId, msg.wamid));
  });

  router.use(metaJsonErrorHandler());
  return router;
}
