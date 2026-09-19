import { Router, type Request, type Response } from 'express';
import { getAutoReply, setAutoReply, type AutoReply } from '../core/registry.js';
import { fail } from './respond.js';
// TODO(Person 3): emit tile.autoreply to the open group session on change (bus)

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
  if (!['manual', 'echo', 'keyword'].includes(mode))
    return fail(res, 400, "mode must be 'manual', 'echo' or 'keyword'");
  const ar: AutoReply = { mode, delay_ms: Number(delay_ms ?? 0), rules: Array.isArray(rules) ? rules : [] };
  const number = String(req.params.number);
  try {
    const saved = setAutoReply(number, ar);
    return res.json(saved);
  } catch (err) {
    return fail(res, 404, err instanceof Error ? err.message : 'could not set auto-reply');
  }
});
