import crypto from 'node:crypto';

/** Meta-shaped message id; the MOCK- prefix makes test data unmistakable in Comdove's DB. */
export function newWamid(): string {
  return `wamid.MOCK-${crypto.randomBytes(12).toString('hex')}`;
}

let traceCounter = 0;

/** fbtrace_id for Meta error envelopes: MOCK-trace-000001, MOCK-trace-000002, ... */
export function nextTraceId(): string {
  traceCounter = (traceCounter % 999_999) + 1;
  return `MOCK-trace-${String(traceCounter).padStart(6, '0')}`;
}

/** Digits-only form used as wa_id and storage key; null when not a plausible phone number. */
export function normalizeNumber(input: unknown): string | null {
  if (typeof input !== 'string') return null;
  const digits = input.replace(/[+\s-]/g, '');
  return /^\d{8,15}$/.test(digits) ? digits : null;
}
