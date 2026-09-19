// Person 3's Bus (Person 1's port): turns lifecycle and dispatcher events into /ws frames
// for the session that holds the tile's group. Outbound bubbles are pushed by delivery;
// the bus shows inbound bubbles and status ticks. Admin-feed events (log.changed,
// webhook.verify) are ignored until the admin feed lands (next step).
import type { Bus, BusEvent, Customer } from './ports.js';
import type { SessionIndex } from '../ws/session-index.js';
import { toWsMessage } from '../ws/wire.js';

export interface LiveBusDeps {
  sessions: SessionIndex;
  getCustomer(number: string): Customer | null;
  log?: (line: string) => void;
}

export function createLiveBus(d: LiveBusDeps): Bus {
  const log = d.log ?? (() => {});

  const sessionFor = (number: string) => {
    const c = d.getCustomer(number);
    return c ? d.sessions.get(c.group_id) : undefined;
  };

  return {
    emit(e: BusEvent) {
      switch (e.type) {
        case 'message.new': {
          const m = e.message;
          log(`[bus] new ${m.direction} ${m.wamid}`);
          if (m.direction !== 'inbound') return;
          sessionFor(m.customer_number)?.send({
            type: 'message.new',
            to: m.to_number,
            number: m.customer_number,
            message: toWsMessage(m),
          });
          return;
        }
        case 'message.status':
          log(`[bus] ${e.status.padEnd(9)} ${e.wamid} → ${e.number}`);
          sessionFor(e.number)?.send({ type: 'message.status', wamid: e.wamid, number: e.number, status: e.status, at: e.at });
          return;
        default:
          return; // log.changed, webhook.verify → admin feed (next step)
      }
    },
  };
}
