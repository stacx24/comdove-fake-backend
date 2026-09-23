import { Router, type Request, type Response } from 'express';
import { getCustomer, getBusiness, setOnline } from '../core/registry.js';
import { storeMessage, getLog } from '../core/messages.js';
import { services } from '../core/services.js';
import { LifecycleError } from '../core/lifecycle.js';
import { fail } from './respond.js';

export const trafficRouter = Router();

/** GET /api/log?limit= — default, and the ceiling a 500-message run must not exceed. */
export const DEFAULT_LOG_LIMIT = 100;
export const MAX_LOG_LIMIT = 1000;

// 8. Set a tile online/offline (FR-05, FR-13).
// Person 2 persists the flag. Person 3 wires the live effect (push tile.presence,
// flush the queue with delivered webhooks) at integration.
trafficRouter.post('/presence', (req: Request, res: Response) => {
  const { number, online } = req.body ?? {};
  if (!number) return fail(res, 400, 'number is required');
  // A real boolean only: Boolean("false") is true, so a text value would flip the tile the wrong way.
  if (typeof online !== 'boolean') return fail(res, 400, 'online must be true or false');
  const c = getCustomer(String(number));
  if (!c) return fail(res, 404, 'no such customer');
  // Wired: same effect as the tile toggle — push tile.presence and, going online,
  // flush the queue with delivered webhooks. effective = group open AND flag on.
  if (services.presence) {
    const effective = services.presence(c.number, online);
    return res.json({ number: c.number, online, effective_online: effective });
  }
  setOnline(String(number), online);
  return res.json({ number: c.number, online, effective_online: online });
});

// 9. Inject an inbound message as if typed in a tile (FR-07, FR-13).
// Person 2 stores it. Person 1 wires the signed inbound webhook to Comdove.
trafficRouter.post('/inject', (req: Request, res: Response) => {
  const { from, to, body } = req.body ?? {};
  if (!from || !to || !body) return fail(res, 400, 'from, to and body are required');
  if (!getCustomer(String(from))) return fail(res, 400, 'from must be a registered customer');
  const biz = getBusiness(String(to));
  if (!biz) return fail(res, 400, 'to must be a registered business number');
  // Wired: Person 1's lifecycle stores it AND fires the signed inbound webhook.
  if (services.inbound) {
    try {
      return res.json({ wamid: services.inbound(String(from), biz.phone_number_id, String(body), 'inject').wamid });
    } catch (err) {
      if (err instanceof LifecycleError) return fail(res, 400, err.message);
      throw err;
    }
  }
  const msg = storeMessage({
    from: String(from),
    to: biz.display_number,
    body: String(body),
    direction: 'inbound',
    source: 'inject',
  });
  return res.json({ wamid: msg.wamid });
});

// 10. Admin live log (FR-11). Person 2 serves the data (pull); Person 3 adds the
// live push (admin feed) at integration.
trafficRouter.get('/log', (req: Request, res: Response) => {
  const raw = Number(req.query.limit ?? DEFAULT_LOG_LIMIT);
  // Clamp: a 500-message run makes an unbounded (or negative → "no LIMIT") read expensive.
  const limit = Number.isFinite(raw) ? Math.min(Math.max(Math.trunc(raw), 1), MAX_LOG_LIMIT) : DEFAULT_LOG_LIMIT;
  return res.json(getLog(limit));
});
