// Person 3's Delivery (Person 1's port, plan §13a–§13c). A tile is effectively online
// when its group is claimed by an open /ws session AND its tile flag is on. Then an
// outbound message is pushed as message.new and marked delivered (Person 1 fires the
// webhook); otherwise it stays queued until the group is claimed again (deliverQueued)
// or the tile comes back online (next step). Delivery also triggers Person 2's
// auto-reply engine (FR-10, plan §14).
import type { Customer, Delivery, StoredMessage } from './ports.js';
import type { Session } from '../ws/session.js';
import type { SessionIndex } from '../ws/session-index.js';
import { toWsMessage } from '../ws/wire.js';

export interface LiveDeliveryDeps {
  sessions: SessionIndex;
  getCustomer(number: string): Customer | null;
  listGroupTiles(groupId: string): Array<{ number: string }>;
  /** Outbound, not yet delivered, per conversation in seq order (Person 2). */
  queuedFor(number: string): StoredMessage[];
  /** Person 1's lifecycle.delivered: marks delivered + queues the webhooks. */
  delivered(msgs: StoredMessage[]): void;
  /** Person 1's lifecycle.inbound, used to send auto-replies. */
  inbound(from: string, to: string, body: string, source: 'autoreply'): unknown;
  /** Person 2's auto-reply engine. */
  computeReply(number: string, body: string): { reply: string; delay_ms: number } | null;
  log?: (line: string) => void;
}

export interface LiveDelivery extends Delivery {
  isOnline(number: string): boolean;
  /** After a claim: mark every online tile's queue delivered (no message.new — it is in the snapshot). */
  deliverQueued(groupId: string): void;
  /** A tile came back online: push its queue as one queue.flush, then mark it delivered. */
  flushTile(number: string): StoredMessage[];
}

export function createLiveDelivery(d: LiveDeliveryDeps): LiveDelivery {
  const log = d.log ?? (() => {});

  /** The session showing this tile, if the tile is effectively online. */
  function sessionFor(number: string): Session | undefined {
    const c = d.getCustomer(number);
    return c && c.online ? d.sessions.get(c.group_id) : undefined;
  }

  const isOnline = (number: string): boolean => sessionFor(number) !== undefined;

  function autoReply(m: StoredMessage): void {
    const r = d.computeReply(m.customer_number, m.body);
    if (!r) return;
    setTimeout(() => {
      if (!isOnline(m.customer_number)) return; // an offline customer does not talk
      try {
        d.inbound(m.customer_number, m.phone_number_id, r.reply, 'autoreply');
        log(`[auto-reply] ${m.customer_number} → ${r.reply}`);
      } catch (err) {
        log(`[auto-reply] failed: ${(err as Error).message}`);
      }
    }, r.delay_ms);
  }

  return {
    isOnline,

    deliver(m) {
      if (m.direction !== 'outbound') return 'queued';
      const session = sessionFor(m.customer_number);
      if (!session) return 'queued';
      session.send({ type: 'message.new', to: m.customer_number, number: m.customer_number, message: toWsMessage(m) });
      d.delivered([m]);
      autoReply(m);
      return 'delivered';
    },

    deliverQueued(groupId) {
      if (!d.sessions.get(groupId)) return;
      for (const tile of d.listGroupTiles(groupId)) {
        if (!isOnline(tile.number)) continue;
        const msgs = d.queuedFor(tile.number);
        if (msgs.length === 0) continue;
        d.delivered(msgs);
        msgs.forEach(autoReply);
      }
    },

    flushTile(number) {
      const session = sessionFor(number);
      if (!session) return [];
      const msgs = d.queuedFor(number);
      if (msgs.length === 0) return [];
      session.send({ type: 'queue.flush', number, messages: msgs.map(toWsMessage) });
      d.delivered(msgs);
      msgs.forEach(autoReply);
      return msgs;
    },
  };
}
