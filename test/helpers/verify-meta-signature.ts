// VERBATIM copy of wat-backend `src/utils/webhook-signature.ts` (stacx24/wat-backend @ a8cdff8).
// It is the oracle for every signing test: if this accepts our header, Comdove will too.
// Do not "improve" it — keep it identical to the source.
import crypto from 'crypto';

const PREFIX = 'sha256=';

export function verifyMetaSignature(
  rawBody: Buffer | undefined,
  header: string | undefined,
  appSecret: string | undefined,
): boolean {
  if (!rawBody || !header || !appSecret) return false;
  if (!header.startsWith(PREFIX)) return false;

  const provided = header.slice(PREFIX.length);
  const expected = crypto
    .createHmac('sha256', appSecret)
    .update(rawBody)
    .digest('hex');

  let providedBuf: Buffer;
  let expectedBuf: Buffer;
  try {
    providedBuf = Buffer.from(provided, 'hex');
    expectedBuf = Buffer.from(expected, 'hex');
  } catch {
    return false;
  }

  if (providedBuf.length !== expectedBuf.length) return false;
  return crypto.timingSafeEqual(providedBuf, expectedBuf);
}
