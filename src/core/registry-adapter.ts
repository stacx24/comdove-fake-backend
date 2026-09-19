// Person 2's SQLite store (core/registry.ts + core/messages.ts) behind the Registry
// port Person 1's Meta face depends on (core/ports.ts). Thin: only shape mapping.
import type { BusinessNumber, Customer, NewMessage, Registry, RejectedRequest, StoredMessage } from './ports.js';
import * as registry from './registry.js';
import * as messages from './messages.js';

function toBusiness(b: registry.BusinessNumber | null): BusinessNumber | null {
  return b && { phone_number_id: b.phone_number_id, display_number: b.display_number, label: b.label, token: b.token, waba_id: b.waba_id };
}

export const sqliteRegistry: Registry = {
  getBusiness: (idOrDisplay) => toBusiness(registry.getBusiness(idOrDisplay)),

  getCustomer(number): Customer | null {
    const c = registry.getCustomer(number);
    return c && { number: c.number, group_id: c.group_id, label: c.label, online: Boolean(c.online) };
  },

  storeMessage(m: NewMessage): StoredMessage {
    const business = registry.getBusiness(m.phone_number_id);
    if (!business) throw new Error(`unknown business ${m.phone_number_id}`);
    const outbound = m.direction === 'outbound';
    return messages.storeMessage({
      wamid: m.wamid,
      at: m.at,
      direction: m.direction,
      source: m.source,
      from: outbound ? business.display_number : m.customer_number,
      to: outbound ? m.customer_number : business.display_number,
      body: m.body,
    });
  },

  getMessage: (wamid) => messages.getMessage(wamid),
  setDelivered: (wamids, at) => messages.setDelivered(wamids, at),
  setRead: (wamids, at) => messages.setRead(wamids, at),
  unreadDelivered: (customer, phoneNumberId) => messages.unreadDelivered(customer, phoneNumberId),
  logRejected: (r: RejectedRequest) => messages.logRejected(r),
};
