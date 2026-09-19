// Meta's webhook subscription handshake, performed against Comdove (Tech Spec §5).
// Never throws and never blocks boot: the result is only reported.
import crypto from 'node:crypto';

export interface HandshakeResult {
  ok: boolean;
  at: number;
  detail: string;
}

export async function runHandshake(
  webhookUrl: string,
  verifyToken: string,
  opts: { timeoutMs?: number; fetchImpl?: typeof fetch } = {},
): Promise<HandshakeResult> {
  const challenge = String(crypto.randomInt(1_000_000_000, 10_000_000_000));
  const url = new URL(webhookUrl);
  url.searchParams.set('hub.mode', 'subscribe');
  url.searchParams.set('hub.verify_token', verifyToken);
  url.searchParams.set('hub.challenge', challenge);

  const at = Date.now();
  try {
    const res = await (opts.fetchImpl ?? fetch)(url, { signal: AbortSignal.timeout(opts.timeoutMs ?? 5000) });
    const body = (await res.text()).trim();
    if (res.status !== 200) return { ok: false, at, detail: `HTTP ${res.status}` };
    if (body !== challenge) return { ok: false, at, detail: 'challenge was not echoed back' };
    return { ok: true, at, detail: 'challenge echoed' };
  } catch (err) {
    const e = err as { name?: string; cause?: { code?: string }; message?: string };
    return { ok: false, at, detail: e.name === 'TimeoutError' ? 'timeout' : (e.cause?.code ?? e.message ?? String(err)) };
  }
}
