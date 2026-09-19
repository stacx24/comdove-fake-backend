import crypto from 'node:crypto';

/**
 * X-Hub-Signature-256 value, byte-identical to Meta: "sha256=" + hex HMAC-SHA256 of the
 * exact raw body. Sign the same bytes you send — wat-backend verifies the raw body.
 */
export function sign(raw: string | Buffer, appSecret: string): string {
  return `sha256=${crypto.createHmac('sha256', appSecret).update(raw).digest('hex')}`;
}
