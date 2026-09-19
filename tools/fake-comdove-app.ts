// A stand-in for wat-backend's /webhooks/whatsapp, for testing the mock without Comdove.
// GET answers the verify handshake and POST checks X-Hub-Signature-256 over the raw body,
// both exactly as wat-backend does (routes/webhook-whatsapp.ts, middleware/raw-body.ts).
import express from 'express';
import { verifyMetaSignature } from '../test/helpers/verify-meta-signature.js';

export interface ReceivedWebhook {
  at: number;
  signatureValid: boolean;
  status: number; // what we answered
  kind: string; // 'inbound' | 'sent' | 'delivered' | 'read' | 'unknown'
  wamid: string | null;
  payload: unknown;
}

export interface FakeComdoveOptions {
  appSecret: string;
  verifyToken: string;
  /** Answer 503 to the next N POSTs (tests retries). */
  failNext?: number;
  /** Delay every POST answer by this many ms (tests the 5 s timeout). */
  slowMs?: number;
  log?: (line: string) => void;
}

function describe(payload: any): { kind: string; wamid: string | null } {
  const value = payload?.entry?.[0]?.changes?.[0]?.value;
  if (value?.messages?.length) return { kind: 'inbound', wamid: value.messages[0].id ?? null };
  if (value?.statuses?.length) return { kind: value.statuses[0].status ?? 'unknown', wamid: value.statuses[0].id ?? null };
  return { kind: 'unknown', wamid: null };
}

export function createFakeComdove(o: FakeComdoveOptions) {
  const state = { failNext: o.failNext ?? 0, slowMs: o.slowMs ?? 0 };
  const received: ReceivedWebhook[] = [];
  const log = o.log ?? (() => {});
  const app = express();

  app.get('/webhooks/whatsapp', (req, res) => {
    const ok = req.query['hub.mode'] === 'subscribe' && req.query['hub.verify_token'] === o.verifyToken;
    log(ok ? '🤝 handshake ok' : '✘ handshake refused (verify token mismatch)');
    if (!ok) return void res.status(403).end();
    res.status(200).type('text/plain').send(String(req.query['hub.challenge'] ?? ''));
  });

  app.post(
    '/webhooks/whatsapp',
    express.json({ limit: '5mb', verify: (req, _res, buf) => ((req as express.Request & { rawBody?: Buffer }).rawBody = Buffer.from(buf)) }),
    async (req, res) => {
      const raw = (req as express.Request & { rawBody?: Buffer }).rawBody;
      const signatureValid = verifyMetaSignature(raw, req.get('x-hub-signature-256'), o.appSecret);
      const { kind, wamid } = describe(req.body);
      let status = 200;
      if (!signatureValid) status = 401;
      else if (state.failNext > 0) {
        state.failNext--;
        status = 503;
      }
      if (state.slowMs > 0) await new Promise((r) => setTimeout(r, state.slowMs));
      received.push({ at: Date.now(), signatureValid, status, kind, wamid, payload: req.body });
      log(`${status === 200 ? '✔' : '✘'} ${status} ${kind.padEnd(9)} ${wamid ?? ''}${signatureValid ? '' : '  (bad signature)'}`);
      res.status(status).end();
    },
  );

  // Test helpers (not part of wat-backend).
  app.get('/_received', (_req, res) => { res.json(received); });
  app.post('/_control', express.json(), (req, res) => {
    if (typeof req.body?.failNext === 'number') state.failNext = req.body.failNext;
    if (typeof req.body?.slowMs === 'number') state.slowMs = req.body.slowMs;
    if (req.body?.clear) received.length = 0;
    res.json(state);
  });

  return { app, received, state };
}
