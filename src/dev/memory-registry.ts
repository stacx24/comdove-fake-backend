// In-memory stand-ins used by tests and by `npm run dev` until P2/P3 land (checkpoint ①).
import type {
  BusinessNumber,
  Customer,
  NewMessage,
  Registry,
  RejectedRequest,
  StoredMessage,
} from '../core/ports.js';

/** In-memory stand-in for P2's registry. Same contract, no SQLite. */
export class MemoryRegistry implements Registry {
  business: BusinessNumber[] = [];
  customers: Customer[] = [];
  messages: StoredMessage[] = [];
  rejected: RejectedRequest[] = [];
  private conversations = new Map<string, { id: number; nextSeq: number }>();

  seed(s: { business?: Partial<BusinessNumber>[]; customers?: Partial<Customer>[] }) {
    for (const b of s.business ?? []) {
      const n = this.business.length + 1;
      this.business.push({
        phone_number_id: `MOCK-PN-${n}`,
        display_number: `91888880000${n}`,
        label: null,
        token: `t${n}`,
        waba_id: 'MOCK-WABA-1',
        ...b,
      });
    }
    for (const c of s.customers ?? []) {
      this.customers.push({ number: '919876543210', group_id: 'alpha', label: null, online: true, ...c });
    }
    return this;
  }

  getBusiness(idOrDisplay: string) {
    return this.business.find((b) => b.phone_number_id === idOrDisplay || b.display_number === idOrDisplay) ?? null;
  }

  getCustomer(number: string) {
    return this.customers.find((c) => c.number === number) ?? null;
  }

  storeMessage(m: NewMessage): StoredMessage {
    const key = `${m.phone_number_id}|${m.customer_number}`;
    let conv = this.conversations.get(key);
    if (!conv) {
      conv = { id: this.conversations.size + 1, nextSeq: 1 };
      this.conversations.set(key, conv);
    }
    const business = this.getBusiness(m.phone_number_id);
    const businessDisplay = business?.display_number ?? m.phone_number_id;
    const stored: StoredMessage = {
      wamid: m.wamid,
      conversation_id: conv.id,
      seq: conv.nextSeq++,
      direction: m.direction,
      source: m.source,
      phone_number_id: m.phone_number_id,
      customer_number: m.customer_number,
      from_number: m.direction === 'outbound' ? businessDisplay : m.customer_number,
      to_number: m.direction === 'outbound' ? m.customer_number : businessDisplay,
      body: m.body,
      created_at: m.at,
      sent_at: m.direction === 'outbound' ? m.at : null,
      delivered_at: null,
      read_at: null,
    };
    this.messages.push(stored);
    return { ...stored };
  }

  getMessage(wamid: string) {
    const m = this.messages.find((x) => x.wamid === wamid);
    return m ? { ...m } : null;
  }

  setDelivered(wamids: string[], at: number) {
    for (const m of this.messages) if (wamids.includes(m.wamid) && m.delivered_at === null) m.delivered_at = at;
  }

  setRead(wamids: string[], at: number) {
    for (const m of this.messages) if (wamids.includes(m.wamid) && m.read_at === null) m.read_at = at;
  }

  unreadDelivered(customer: string, phoneNumberId: string) {
    return this.messages
      .filter(
        (m) =>
          m.direction === 'outbound' &&
          m.customer_number === customer &&
          m.phone_number_id === phoneNumberId &&
          m.delivered_at !== null &&
          m.read_at === null,
      )
      .sort((a, b) => a.seq - b.seq)
      .map((m) => ({ ...m }));
  }

  logRejected(r: RejectedRequest) {
    this.rejected.push(r);
  }
}
