import { Router, type Request, type Response } from 'express';
import { createGroup, listGroups, deleteGroup, InvalidInputError } from '../core/registry.js';
import { fail } from './respond.js';
import { services } from '../core/services.js';

export const groupsRouter = Router();

// 4. Create a client group (FR-15) — customers auto-register
groupsRouter.post('/groups', (req: Request, res: Response) => {
  const { name, numbers, labels } = req.body ?? {};
  if (!name) return fail(res, 400, 'name is required');
  if (!Array.isArray(numbers) || numbers.length === 0)
    return fail(res, 400, 'numbers must be a non-empty array');
  try {
    const g = createGroup(String(name), numbers.map(String), labels);
    services.adminChanged?.('groups');
    return res.json(g);
  } catch (err) {
    // Bad numbers are the caller's mistake (400); a number already taken is a conflict (409).
    return fail(res, err instanceof InvalidInputError ? 400 : 409, err instanceof Error ? err.message : 'could not create group');
  }
});

// 5. List groups with free/locked status (FR-09, FR-16)
groupsRouter.get('/groups', (_req: Request, res: Response) => res.json(listGroups()));

// 6. Delete a group (PRD C5) — 409 if claimed
groupsRouter.delete('/groups/:id', (req: Request, res: Response) => {
  const r = deleteGroup(String(req.params.id));
  if (r.locked) return fail(res, 409, 'group is claimed by an open session');
  if (!r.ok) return fail(res, 404, 'no such group');
  services.adminChanged?.('groups');
  return res.status(204).end();
});
