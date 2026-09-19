// Meta "messages" webhook payloads (Tech Spec §5). Plain objects; the dispatcher
// serializes each one exactly once so every retry sends and signs identical bytes.
import type { BusinessNumber, Customer, Status, StoredMessage } from '../core/ports.js';

/** Meta timestamps are Unix seconds as a string. */
export function unixSeconds(ms: number): string {
  return String(Math.floor(ms / 1000));
}

function envelope<V>(business: BusinessNumber, value: V) {
  return {
    object: 'whatsapp_business_account' as const,
    entry: [
      {
        // Must equal Comdove's WabaAccount.wabaId for this number (build plan §9a).
        id: business.waba_id,
        changes: [
          {
            field: 'messages' as const,
            value: {
              messaging_product: 'whatsapp' as const,
              metadata: { display_phone_number: business.display_number, phone_number_id: business.phone_number_id },
              ...value,
            },
          },
        ],
      },
    ],
  };
}

export function inboundEnvelope(a: { business: BusinessNumber; customer: Customer; message: StoredMessage }) {
  return envelope(a.business, {
    contacts: [{ profile: { name: a.customer.label ?? `Tile ${a.customer.number}` }, wa_id: a.customer.number }],
    messages: [
      {
        from: a.customer.number,
        id: a.message.wamid,
        timestamp: unixSeconds(a.message.created_at),
        type: 'text' as const,
        text: { body: a.message.body },
      },
    ],
  });
}

export function statusEnvelope(a: { business: BusinessNumber; wamid: string; status: Status; at: number; recipient: string }) {
  return envelope(a.business, {
    statuses: [{ id: a.wamid, status: a.status, timestamp: unixSeconds(a.at), recipient_id: a.recipient }],
  });
}
