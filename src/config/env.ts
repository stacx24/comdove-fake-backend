// Central place to read + validate env (API Tech Spec §8, build plan §5.0). Falls back
// to sensible defaults so the mock boots out of the box; rejects values that would
// otherwise fail later in confusing ways (a non-URL webhook target, a negative delay).
import 'dotenv/config';

function num(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return fallback;
  const n = Number(raw);
  if (!Number.isFinite(n) || n < 0) throw new Error(`${name} must be a non-negative number, got "${raw}"`);
  return n;
}

function url(name: string, fallback: string): string {
  const raw = process.env[name] || fallback;
  try {
    new URL(raw);
  } catch {
    throw new Error(`${name} must be a URL, got "${raw}"`);
  }
  return raw;
}

export const env = {
  PORT: num('PORT', 4020),
  COMDOVE_WEBHOOK_URL: url('COMDOVE_WEBHOOK_URL', 'http://localhost:3000/webhooks/whatsapp'),
  APP_SECRET: process.env.APP_SECRET || 'mock-app-secret-1',
  WEBHOOK_VERIFY_TOKEN: process.env.WEBHOOK_VERIFY_TOKEN || 'mock-verify-1',
  DB_PATH: process.env.DB_PATH || './mock.sqlite',
  // Wait before a message's first status webhook so Comdove has stored the wamid
  // (plan §9f, avoids UNKNOWN_WAMID).
  STATUS_WEBHOOK_DELAY_MS: num('STATUS_WEBHOOK_DELAY_MS', 500),
};

export type Env = typeof env;
