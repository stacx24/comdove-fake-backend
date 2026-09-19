import { Router, type Request, type Response } from 'express';
import { db } from '../db/db.js';
import { env } from '../config/env.js';
import { resetAll } from '../core/registry.js';

export const systemRouter = Router();

function count(table: string): number {
  return (db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number }).n;
}

// 11. Reset — wipe messages/queues; keep numbers/groups unless keep_numbers=false (FR-12)
function doReset(req: Request, res: Response) {
  const keep = req.body?.keep_numbers !== false; // default true
  resetAll(keep);
  // TODO(Person 1): dispatcher.cancelAll() to cancel in-flight webhook retries
  // TODO(Person 3): emit log.reset / groups.update to the admin feed
  return res.json({ ok: true, kept_numbers: keep });
}
systemRouter.post('/api/reset', doReset);
// 12. /reset alias (PRD FR-12 wording)
systemRouter.post('/reset', doReset);

// 15. Re-run the verify handshake (Spec §5). The handshake itself is owned by
// Person 1 (webhooks/verify.ts). Until it lands this reports "not wired".
systemRouter.post('/api/webhook/verify', (_req: Request, res: Response) => {
  return res.json({ ok: false, detail: 'verify handshake owned by Person 1 (not wired yet)' });
});

// 16. Admin header / debugging
systemRouter.get('/api/status', (_req: Request, res: Response) => {
  return res.json({
    uptime: Math.round(process.uptime()),
    comdove_webhook_url: env.COMDOVE_WEBHOOK_URL,
    verify: { ok: false, detail: 'not wired (Person 1)', at: 0 },
    pending_webhooks: (db.prepare("SELECT COUNT(*) AS n FROM webhook_jobs WHERE state='pending'").get() as { n: number }).n,
    counts: {
      business_numbers: count('business_numbers'),
      groups: count('groups'),
      customers: count('customers'),
      messages: count('messages'),
    },
  });
});
