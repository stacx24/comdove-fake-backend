import { Router, type Request, type Response } from 'express';
import { createGroup, listGroups, deleteGroup } from '../core/registry.js';
import { fail } from './respond.js';
// TODO(Person 3): emit groups.update / numbers.update to the admin feed on changes (bus)

export const groupsRouter = Router();

// 4. Create a client group (FR-15) — customers auto-register
groupsRouter.post('/groups', (req: Request, res: Response) => {
  const { name, numbers, labels } = req.body ?? {};
  if (!name) return fail(res, 400, 'name is required');
  if (!Array.isArray(numbers) || numbers.length === 0)
    return fail(res, 400, 'numbers must be a non-empty array');
  try {
    const g = createGroup(String(name), numbers.map(String), labels);
    return res.json(g);
  } catch (err) {
    return fail(res, 409, err instanceof Error ? err.message : 'could not create group');
  }
});

// 5. List groups with free/locked status (FR-09, FR-16)
groupsRouter.get('/groups', (_req: Request, res: Response) => res.json(listGroups()));

// 6. Delete a group (PRD C5) — 409 if claimed
groupsRouter.delete('/groups/:id', (req: Request, res: Response) => {
  const r = deleteGroup(String(req.params.id));
  if (r.locked) return fail(res, 409, 'group is claimed by an open session');
  if (!r.ok) return fail(res, 404, 'no such group');
  return res.status(204).end();
});
