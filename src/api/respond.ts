import type { Response } from 'express';

// Control-API error shape (plan §10): { error: { message } } + 4xx. No Meta envelope.
export function fail(res: Response, status: number, message: string) {
  return res.status(status).json({ error: { message } });
}
