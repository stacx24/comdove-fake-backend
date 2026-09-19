import { Router, type Request, type Response } from 'express';
import { getAutoReply, setAutoReply, type AutoReply } from '../core/registry.js';
import { fail } from './respond.js';
import { services } from '../core/services.js';
import { parseClientEvent } from '../contract/ws-events.js';

export const autoReplyRouter = Router();

// 13. GET a tile's auto-reply config (FR-10)
autoReplyRouter.get('/customers/:number/auto-reply', (req: Request, res: Response) => {
  const ar = getAutoReply(String(req.params.number));
  if (!ar) return fail(res, 404, 'no such customer');
  return res.json(ar);
});

// 14. PUT a tile's auto-reply config (FR-10)
autoReplyRouter.put('/customers/:number/auto-reply', (req: Request, res: Response) => {
  const { mode, delay_ms, rules } = req.body ?? {};
  // Same checks as the tile's gear over /ws (tile.autoreply, contract parser), so both paths
  // accept exactly the same input. Omitted delay_ms / rules default to 0 / [].
  const parsed = parseClientEvent(
    JSON.stringify({ type: 'tile.autoreply', number: String(req.params.number), mode, delay_ms: delay_ms ?? 0, rules: rules ?? [] }),
  );
  if (!parsed.ok) return fail(res, 400, parsed.error.message);
  if (parsed.event.type !== 'tile.autoreply') return fail(res, 400, 'invalid auto-reply');
  const ar: AutoReply = { mode: parsed.event.mode, delay_ms: parsed.event.delay_ms, rules: parsed.event.rules };
  const number = String(req.params.number);
  try {
    const saved = setAutoReply(number, ar);
    services.autoReplyChanged?.(number, saved); // show it in the open tile
    return res.json(saved);
  } catch (err) {
    return fail(res, 404, err instanceof Error ? err.message : 'could not set auto-reply');
  }
});
