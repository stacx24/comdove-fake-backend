// npm run fake-comdove — a local receiver standing in for wat-backend.
// Point the mock at it with COMDOVE_WEBHOOK_URL=http://localhost:3100/webhooks/whatsapp
//
// Knobs (env or POST /_control {failNext, slowMs, clear}):
//   FAIL_NEXT=3   answer 503 to the next 3 webhooks (watch the retries)
//   SLOW_MS=6000  delay every answer (watch the 5 s timeout)
// GET /_received lists everything received.
import 'dotenv/config';
import { createFakeComdove } from './fake-comdove-app.js';

const port = Number(process.env.FAKE_COMDOVE_PORT ?? 3100);
const { app } = createFakeComdove({
  appSecret: process.env.APP_SECRET ?? 'mock-app-secret-1',
  verifyToken: process.env.WEBHOOK_VERIFY_TOKEN ?? 'mock-verify-1',
  failNext: Number(process.env.FAIL_NEXT ?? 0),
  slowMs: Number(process.env.SLOW_MS ?? 0),
  log: (line) => console.log(`[fake-comdove] ${new Date().toISOString().slice(11, 23)} ${line}`),
});

app.listen(port, () => {
  console.log(`[fake-comdove] listening on http://localhost:${port}/webhooks/whatsapp`);
});
