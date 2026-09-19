import { Router, type Request, type Response } from 'express';
import { db } from '../db/db.js';
import { env } from '../config/env.js';
import { resetAll } from '../core/registry.js';
import { services } from '../core/services.js';

export const systemRouter = Router();

function count(table: string): number {
  return (db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number }).n;
}

// 11. Reset — wipe messages/queues; keep numbers/groups unless keep_numbers=false (FR-12)
function doReset(req: Request, res: Response) {
  const keep = req.body?.keep_numbers !== false; // default true
  services.cancelWebhooks?.(); // stop in-flight retries BEFORE their rows are deleted
  resetAll(keep);
  // TODO(Person 3): emit log.reset / groups.update to the admin feed
  return res.json({ ok: true, kept_numbers: keep });
}
systemRouter.post('/api/reset', doReset);
// 12. /reset alias (PRD FR-12 wording)
systemRouter.post('/reset', doReset);

// 15. Re-run the verify handshake (Spec §5). Person 1's webhooks/verify.ts.
systemRouter.post('/api/webhook/verify', async (_req: Request, res: Response) => {
  if (!services.verify) return res.json({ ok: false, detail: 'verify handshake not wired' });
  return res.json(await services.verify());
});

// 16. Admin header / debugging
systemRouter.get('/api/status', (_req: Request, res: Response) => {
  return res.json({
    uptime: Math.round(process.uptime()),
    comdove_webhook_url: env.COMDOVE_WEBHOOK_URL,
    verify: services.lastVerify ?? { ok: false, detail: 'handshake not run yet', at: 0 },
    pending_webhooks: (db.prepare("SELECT COUNT(*) AS n FROM webhook_jobs WHERE state='pending'").get() as { n: number }).n,
    counts: {
      business_numbers: count('business_numbers'),
      groups: count('groups'),
      customers: count('customers'),
      messages: count('messages'),
    },
  });
});
