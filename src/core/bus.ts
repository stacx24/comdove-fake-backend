// Person 3's Bus (Person 1's port): turns lifecycle and dispatcher events into /ws frames.
// Tiles: inbound bubbles and status ticks for the session that holds the tile's group
// (outbound bubbles are pushed by delivery). Admins: log.changed and webhook.verify go
// to the admin feed.
import type { Bus, BusEvent, Customer } from './ports.js';
import type { SessionIndex } from '../ws/session-index.js';
import { toWsMessage } from '../ws/wire.js';
import type { AdminFeed } from '../ws/admin-feed.js';

export interface LiveBusDeps {
  sessions: SessionIndex;
  getCustomer(number: string): Customer | null;
  log?: (line: string) => void;
  admin?: Pick<AdminFeed, 'logChanged' | 'verify'>;
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
        case 'log.changed':
          d.admin?.logChanged(e.wamid);
          return;
        case 'webhook.verify':
          d.admin?.verify({ ok: e.ok, at: e.at, detail: e.detail });
          return;
      }
    },
  };
}
