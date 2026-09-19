// Cross-lane services the control API calls, set once at boot (src/compose.ts).
// Keeps P2's routers as plain module-level routers with no import of P1/P3 internals;
// each route falls back to its standalone behaviour when a service is not wired.
import type { Source, StoredMessage } from './ports.js';

export interface HandshakeStatus {
  ok: boolean;
  at: number;
  detail: string;
}

export interface Services {
  /** P1 lifecycle.inbound — store + signed inbound webhook (/api/inject, auto-reply). */
  inbound?: (from: string, to: string, body: string, source: Exclude<Source, 'api'>) => StoredMessage;
  /** P1 dispatcher.cancelAll — reset stops in-flight webhook retries before rows are wiped. */
  cancelWebhooks?: () => void;
  /** P1 verify handshake — /api/webhook/verify. */
  verify?: () => Promise<HandshakeStatus>;
  /** Last handshake result — /api/status. */
  lastVerify?: HandshakeStatus;
}

export const services: Services = {};
