// Message lifecycle: sent → delivered → read, plus inbound (build plan §13, TEAM-SPLIT P1).
// The only place that turns state changes into webhooks. P2 (inject, auto-reply) and P3
// (WebSocket) call these functions; they never build webhooks themselves.
import type { BusinessNumber, Bus, Registry, Source, Status, StoredMessage } from './ports.js';
import type { Dispatcher } from '../webhooks/dispatcher.js';
import { inboundEnvelope, statusEnvelope } from '../webhooks/envelopes.js';
import { newWamid } from '../meta/ids.js';
import { MAX_TEXT_LENGTH } from '../meta/validate.js';

export type LifecycleErrorCode = 'unknown_customer' | 'unknown_business' | 'invalid_body';

/** Bad input from a tile / control API. P3 maps it to a WS `error`, P2 to an HTTP 4xx. */
export class LifecycleError extends Error {
  constructor(
    public readonly code: LifecycleErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'LifecycleError';
  }
}

export interface LifecycleDeps {
  registry: Registry;
  bus: Bus;
  dispatcher: Pick<Dispatcher, 'enqueue'>;
  /** Wait before an outbound message's first status webhook (STATUS_WEBHOOK_DELAY_MS). */
  statusDelayMs: number;
  now?: () => number;
}

export interface Lifecycle {
  /** A validated Meta send: store it and queue the `sent` webhook. */
  accept(business: BusinessNumber, waId: string, text: string): StoredMessage;
  /** Messages pushed to an open, online tile (live, flush or reconnect). */
  delivered(msgs: StoredMessage[]): void;
  /** Tester opened `customer`'s chat with business `peer` (display number or phone_number_id). */
  read(customer: string, peer: string): void;
  /** Customer → business message from a tile, /api/inject or auto-reply. */
  inbound(from: string, to: string, body: string, source: Exclude<Source, 'api'>): StoredMessage;
  /** Comdove marked an inbound message read (Meta mark-as-read). No webhook — Meta sends none. */
  markInboundRead(business: BusinessNumber, wamid: string): void;
}

export function createLifecycle(d: LifecycleDeps): Lifecycle {
  const now = d.now ?? Date.now;
  const { registry, bus, dispatcher } = d;

  function businessOrThrow(idOrDisplay: string): BusinessNumber {
    const b = registry.getBusiness(idOrDisplay);
    if (!b) throw new LifecycleError('unknown_business', `${idOrDisplay} is not a registered business number`);
    return b;
  }

  function queueStatus(m: StoredMessage, status: Status, at: number, notBefore?: number) {
    const business = businessOrThrow(m.phone_number_id);
    dispatcher.enqueue({
      conversation_id: m.conversation_id,
      wamid: m.wamid,
      kind: status,
      body: statusEnvelope({ business, wamid: m.wamid, status, at, recipient: m.customer_number }),
      ...(notBefore !== undefined && { notBefore }),
    });
  }

  function announce(m: StoredMessage, status: Status, at: number) {
    bus.emit({ type: 'message.status', wamid: m.wamid, number: m.customer_number, status, at });
    bus.emit({ type: 'log.changed', wamid: m.wamid });
  }

  return {
    accept(business, waId, text) {
      const at = now();
      const m = registry.storeMessage({
        wamid: newWamid(),
        direction: 'outbound',
        source: 'api',
        phone_number_id: business.phone_number_id,
        customer_number: waId,
        body: text,
        at,
      });
      queueStatus(m, 'sent', at, at + d.statusDelayMs);
      bus.emit({ type: 'log.changed', wamid: m.wamid });
      return m;
    },

    delivered(msgs) {
      const at = now();
      const todo = msgs
        .filter((m) => m.direction === 'outbound')
        .map((m) => registry.getMessage(m.wamid))
        .filter((m): m is StoredMessage => m !== null && m.delivered_at === null)
        .sort((a, b) => a.conversation_id - b.conversation_id || a.seq - b.seq);
      if (todo.length === 0) return;
      registry.setDelivered(todo.map((m) => m.wamid), at);
      for (const m of todo) {
        queueStatus(m, 'delivered', at);
        announce(m, 'delivered', at);
      }
    },

    read(customer, peer) {
      const business = businessOrThrow(peer);
      const todo = registry.unreadDelivered(customer, business.phone_number_id);
      if (todo.length === 0) return;
      const at = now();
      registry.setRead(todo.map((m) => m.wamid), at);
      for (const m of todo) {
        queueStatus(m, 'read', at);
        announce(m, 'read', at);
      }
    },

    inbound(from, to, body, source) {
      const customer = registry.getCustomer(from);
      if (!customer) throw new LifecycleError('unknown_customer', `${from} is not a registered customer number`);
      const business = businessOrThrow(to);
      if (typeof body !== 'string' || body.length === 0 || body.length > MAX_TEXT_LENGTH) {
        throw new LifecycleError('invalid_body', `body must be 1–${MAX_TEXT_LENGTH} characters`);
      }
      const m = registry.storeMessage({
        wamid: newWamid(),
        direction: 'inbound',
        source,
        phone_number_id: business.phone_number_id,
        customer_number: customer.number,
        body,
        at: now(),
      });
      dispatcher.enqueue({
        conversation_id: m.conversation_id,
        wamid: m.wamid,
        kind: 'inbound',
        body: inboundEnvelope({ business, customer, message: m }),
      });
      bus.emit({ type: 'message.new', message: m });
      bus.emit({ type: 'log.changed', wamid: m.wamid });
      return m;
    },

    markInboundRead(business, wamid) {
      const m = registry.getMessage(wamid);
      if (!m || m.direction !== 'inbound' || m.phone_number_id !== business.phone_number_id || m.read_at !== null) return;
      const at = now();
      registry.setRead([wamid], at);
      announce(m, 'read', at);
    },
  };
}
