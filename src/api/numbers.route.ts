import { Router, type Request, type Response } from 'express';
import {
  registerBusinessNumber,
  listBusinessNumbers,
  deleteBusinessNumber,
  listCustomers,
} from '../core/registry.js';
import { fail } from './respond.js';
// TODO(Person 3): emit numbers.update to the admin feed on changes (bus)

export const numbersRouter = Router();

// 1. Register a business number (FR-01)
numbersRouter.post('/business-numbers', (req: Request, res: Response) => {
  const { display_number, label, phone_number_id, waba_id, token } = req.body ?? {};
  if (!display_number) return fail(res, 400, 'display_number is required');
  try {
    const bn = registerBusinessNumber({ display_number: String(display_number), label, phone_number_id, waba_id, token });
    return res.json(bn);
  } catch (err) {
    return fail(res, 400, err instanceof Error ? err.message : 'could not register');
  }
});

// 2. List business numbers
numbersRouter.get('/business-numbers', (_req: Request, res: Response) => res.json(listBusinessNumbers()));

// 3. Delete a business number (PRD C5)
numbersRouter.delete('/business-numbers/:phone_number_id', (req: Request, res: Response) => {
  const ok = deleteBusinessNumber(String(req.params.phone_number_id));
  if (!ok) return fail(res, 404, 'no such business number');
  return res.status(204).end();
});

// 7. Admin list of customers with type + claim status (PRD §7)
numbersRouter.get('/customers', (_req: Request, res: Response) => res.json(listCustomers()));
