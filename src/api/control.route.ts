import { Router, type Request, type Response } from 'express';
import {
  registerBusinessNumber,
  listBusinessNumbers,
  createGroup,
  listGroups,
  setPresence,
} from '../core/registry.js';
import { saveMessage, getLog, resetAll, newWamid } from '../core/messages.js';

// Control API — mock-only, no auth. All plain JSON; errors are
// { error: { message } } with a 4xx (BACKEND-BUILD-PLAN §10).
export const controlRouter = Router();

function fail(res: Response, status: number, message: string) {
  return res.status(status).json({ error: { message } });
}

// 1. Register a business number → { phone_number_id, token }
controlRouter.post('/business-numbers', (req: Request, res: Response) => {
  const { display_number, label } = req.body ?? {};
  if (!display_number) return fail(res, 400, 'display_number is required');
  return res.json(registerBusinessNumber(String(display_number), label));
});

// 2. List business numbers
controlRouter.get('/business-numbers', (_req: Request, res: Response) => {
  return res.json(listBusinessNumbers());
});

// 3. Create a client group (numbers auto-register as customers)
controlRouter.post('/groups', (req: Request, res: Response) => {
  const { name, numbers } = req.body ?? {};
  if (!name) return fail(res, 400, 'name is required');
  if (!Array.isArray(numbers) || numbers.length === 0)
    return fail(res, 400, 'numbers must be a non-empty array');
  try {
    return res.json(createGroup(String(name), numbers.map(String)));
  } catch (err) {
    return fail(res, 400, err instanceof Error ? err.message : 'could not create group');
  }
});

// 4. List groups with free/locked status
controlRouter.get('/groups', (_req: Request, res: Response) => {
  return res.json(listGroups());
});

// 5. Set a tile online/offline
controlRouter.post('/presence', (req: Request, res: Response) => {
  const { number, online } = req.body ?? {};
  if (!number) return fail(res, 400, 'number is required');
  setPresence(String(number), Boolean(online));
  return res.status(200).json({ ok: true });
});

// 6. Inject an inbound message as if a tile typed it (automation twin of a tile).
//    (Wiring to the webhook dispatcher is Person 1's job; here we store it.)
controlRouter.post('/inject', (req: Request, res: Response) => {
  const { from, to, body } = req.body ?? {};
  if (!from || !to || !body)
    return fail(res, 400, 'from, to and body are required');
  const msg = saveMessage({
    from: String(from),
    to: String(to),
    body: String(body),
    direction: 'inbound',
    status: 'sent',
  });
  return res.json({ wamid: msg.id ?? newWamid() });
});

// 7. Admin live log
controlRouter.get('/log', (req: Request, res: Response) => {
  const limit = Number(req.query.limit ?? 100);
  return res.json(getLog(Number.isFinite(limit) ? limit : 100));
});

// 8. Reset — wipe messages/queues; keep numbers/groups unless keep_numbers=false
controlRouter.post('/reset', (req: Request, res: Response) => {
  const keep = req.body?.keep_numbers !== false; // default true
  resetAll(keep);
  return res.status(200).json({ ok: true, kept_numbers: keep });
});
