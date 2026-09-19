// Stored messages (Person 2's rows) → contract chat bubbles. Pure: no DB, no sockets.
import type { MessageStatus, RejectedLogEntry, WsMessage } from '../contract/ws-events.js';
import type { RejectedRequest, StoredMessage } from '../core/ports.js';

type Row = Pick<
  StoredMessage,
  'wamid' | 'direction' | 'from_number' | 'to_number' | 'body' | 'created_at' | 'delivered_at' | 'read_at'
>;

export function statusOf(m: Pick<StoredMessage, 'delivered_at' | 'read_at'>): MessageStatus {
  return m.read_at ? 'read' : m.delivered_at ? 'delivered' : 'sent';
}

/** `peer` is the business display number on the other side of the chat. */
export function toWsMessage(m: Row): WsMessage {
  return {
    wamid: m.wamid,
    peer: m.direction === 'outbound' ? m.from_number : m.to_number,
    direction: m.direction,
    body: m.body,
    status: statusOf(m),
    created_at: m.created_at,
  };
}

/** A rejected Meta request → the admin-log entry (same shape GET /api/log returns). */
export function toRejectedLogEntry(r: RejectedRequest): RejectedLogEntry {
  return {
    wamid: null,
    time: r.at,
    direction: 'rejected',
    phone_number_id: r.phone_number_id,
    to: r.to ?? null,
    body: r.body ?? null,
    http_status: r.http_status,
    code: r.code,
    subcode: r.subcode ?? null,
    forced: r.forced,
  };
}
