import 'dotenv/config';

// Central place to read + lightly validate env. Falls back to sensible defaults
// so the mock boots out of the box (API Tech Spec §8).
export const env = {
  PORT: Number(process.env.PORT ?? 4020),
  COMDOVE_WEBHOOK_URL:
    process.env.COMDOVE_WEBHOOK_URL ?? 'http://localhost:3000/webhooks/whatsapp',
  APP_SECRET: process.env.APP_SECRET ?? 'mock-app-secret-1',
  WEBHOOK_VERIFY_TOKEN: process.env.WEBHOOK_VERIFY_TOKEN ?? 'mock-verify-1',
  DB_PATH: process.env.DB_PATH ?? './mock.sqlite',
};
