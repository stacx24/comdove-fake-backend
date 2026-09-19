import { getAutoReply } from './registry.js';

// Auto-reply engine (FR-10) — Person 2 owns the config (registry.getAutoReply /
// setAutoReply) and this reply-selection logic.
//
// The TRIGGER (an outbound message being delivered to a tile) and the SEND (a new
// inbound message + webhook) cross into Person 3 (delivery) and Person 1
// (lifecycle.inbound). Person 3 wires this at integration:
//
//   on 'message.delivered' (outbound → tile):
//     const reply = computeReply(customerNumber, msg.body);
//     if (reply) after delay_ms, if tile still online: lifecycle.inbound(customer, business, reply, 'autoreply')
//
// Kept dependency-free so Person 2's branch stands alone.

export function pickReply(
  mode: string,
  body: string,
  rules: Array<{ keyword: string; reply: string }>,
): string | null {
  if (mode === 'echo') return body;
  if (mode === 'keyword') {
    const lower = body.toLowerCase();
    const hit = rules.find((r) => lower.includes(r.keyword.toLowerCase()));
    return hit ? hit.reply : null;
  }
  return null; // manual
}

// Given a customer and an incoming (outbound-to-tile) body, return the auto-reply
// text to send back, or null. Also returns the configured delay.
export function computeReply(customerNumber: string, body: string): { reply: string; delay_ms: number } | null {
  const ar = getAutoReply(customerNumber);
  if (!ar || ar.mode === 'manual') return null;
  const reply = pickReply(ar.mode, body, ar.rules);
  return reply ? { reply, delay_ms: ar.delay_ms } : null;
}
