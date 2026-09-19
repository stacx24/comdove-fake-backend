// Interfaces between the three backend lanes (TEAM-SPLIT.md "Interfaces").
// P1 (Meta face) depends only on these, so it can run on stubs until P2/P3 land.
// Items marked "P1 addition" must be agreed with the owner at the contract freeze.

export interface BusinessNumber {
  phone_number_id: string;
  display_number: string;
  label: string | null;
  token: string;
  waba_id: string;
}

export interface Customer {
  number: string;
  group_id: string;
  label: string | null;
  online: boolean;
}

export type Direction = 'outbound' | 'inbound';
export type Source = 'api' | 'tile' | 'inject' | 'autoreply';
export type Status = 'sent' | 'delivered' | 'read';

export interface StoredMessage {
  wamid: string;
  conversation_id: number;
  seq: number;
  direction: Direction;
  source: Source;
  phone_number_id: string; // business side of the conversation
  customer_number: string; // customer side
  from_number: string;
  to_number: string;
  body: string;
  created_at: number; // ms
  sent_at: number | null;
  delivered_at: number | null;
  read_at: number | null;
}

export interface NewMessage {
  wamid: string;
  direction: Direction;
  source: Source;
  phone_number_id: string;
  customer_number: string;
  body: string;
  at: number; // ms; outbound messages get sent_at = at
}

export interface RejectedRequest {
  at: number;
  phone_number_id: string;
  http_status: number;
  code: number;
  subcode?: number;
  forced: boolean;
  to?: string;
  body?: string;
}

/** P2 — core/registry.ts */
export interface Registry {
  getBusiness(phoneNumberIdOrDisplay: string): BusinessNumber | null;
  getCustomer(number: string): Customer | null;
  storeMessage(m: NewMessage): StoredMessage;
  getMessage(wamid: string): StoredMessage | null; // P1 addition
  setDelivered(wamids: string[], at: number): void;
  setRead(wamids: string[], at: number): void;
  /** Outbound messages in this chat that are delivered but not read, by seq. P1 addition */
  unreadDelivered(customer: string, phoneNumberId: string): StoredMessage[];
  logRejected(r: RejectedRequest): void; // P1 addition
}

export type BusEvent =
  | { type: 'message.new'; message: StoredMessage }
  | { type: 'message.status'; wamid: string; number: string; status: Status; at: number }
  | { type: 'log.changed'; wamid: string }
  | { type: 'log.rejected'; request: RejectedRequest }
  | { type: 'webhook.verify'; ok: boolean; at: number; detail: string };

/** P3 — core/bus.ts */
export interface Bus {
  emit(e: BusEvent): void;
}

/** P3 — core/delivery.ts */
export interface Delivery {
  deliver(m: StoredMessage): 'delivered' | 'queued';
}
