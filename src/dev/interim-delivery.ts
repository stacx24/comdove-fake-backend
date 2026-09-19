// Interim stand-in for Person 3's live engine (WebSocket delivery + auto-reply trigger).
// Replaced at P3 integration. Until then:
//   - an outbound message counts as delivered when the tile's persisted online flag is
//     set (no group sessions exist yet, so "group claimed" is not checked);
//   - offline tiles keep messages queued (flushing on /api/presence is P3's job);
//   - on delivery, P2's auto-reply engine picks a reply and it is sent via lifecycle.inbound.
import type { Delivery, Registry, StoredMessage } from '../core/ports.js';
import { computeReply } from '../core/autoreply.js';

export interface InterimDeliveryDeps {
  registry: Pick<Registry, 'getCustomer'>;
  delivered: (msgs: StoredMessage[]) => void;
  inbound: (from: string, to: string, body: string, source: 'autoreply') => unknown;
  log?: (line: string) => void;
}

export function createInterimDelivery(d: InterimDeliveryDeps): Delivery & { pendingReplies(): number } {
  let pending = 0;
  const log = d.log ?? (() => {});

  function autoReply(m: StoredMessage) {
    const r = computeReply(m.customer_number, m.body);
    if (!r) return;
    pending++;
    setTimeout(() => {
      pending--;
      if (!d.registry.getCustomer(m.customer_number)?.online) return; // an offline customer does not talk
      try {
        d.inbound(m.customer_number, m.phone_number_id, r.reply, 'autoreply');
        log(`[auto-reply] ${m.customer_number} → ${r.reply}`);
      } catch (err) {
        log(`[auto-reply] failed: ${(err as Error).message}`);
      }
    }, r.delay_ms);
  }

  return {
    deliver(m) {
      if (m.direction !== 'outbound' || !d.registry.getCustomer(m.customer_number)?.online) return 'queued';
      d.delivered([m]);
      autoReply(m);
      return 'delivered';
    },
    pendingReplies: () => pending,
  };
}
