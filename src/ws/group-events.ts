// The four group events a claimed tile can send (plan §11a), wired to Person 1's
// lifecycle, Person 2's store and Person 3's delivery. Plugged into the session hook
// `onGroupEvent` (src/live.ts).
//
//   message.send   → lifecycle.inbound(…, 'tile')  signed inbound webhook; the bus echoes the bubble
//   chat.read      → lifecycle.read               read webhooks + read ticks (via the bus)
//   tile.presence  → store the flag, echo it; online → delivery.flushTile (queue.flush + delivered)
//   tile.autoreply → store the config, echo it
import type { GroupEvent, Session } from './session.js';
import type { SessionIndex } from './session-index.js';
import type { LiveDelivery } from '../core/delivery.js';
import type { BusinessNumber, Customer } from '../core/ports.js';
import { LifecycleError, type Lifecycle } from '../core/lifecycle.js';
import type { AutoReply, WsErrorCode } from '../contract/ws-events.js';

export interface GroupEventsDeps {
  sessions: SessionIndex;
  delivery: Pick<LiveDelivery, 'flushTile'>;
  /** Late-bound: the Meta face (and its lifecycle) is built after the live engine. */
  lifecycle: () => Pick<Lifecycle, 'inbound' | 'read'> | undefined;
  getCustomer(number: string): Customer | null;
  getBusiness(idOrDisplay: string): BusinessNumber | null;
  setOnline(number: string, online: boolean): void;
  setAutoReply(number: string, ar: AutoReply): AutoReply;
}

export interface GroupEvents {
  onGroupEvent(session: Session, ev: GroupEvent): void;
  /** Tile toggle from /ws or /api/presence. Returns effective online (group open AND flag on). */
  setPresence(number: string, online: boolean): boolean;
  /** An auto-reply changed through the control API: show it in the open tile. */
  autoReplyChanged(number: string, ar: AutoReply): void;
}

export function createGroupEvents(d: GroupEventsDeps): GroupEvents {
  const lifecycle = () => {
    const lc = d.lifecycle();
    if (!lc) throw new Error('group events: lifecycle not wired');
    return lc;
  };
  const sessionOf = (c: Customer) => d.sessions.get(c.group_id);

  function setPresence(number: string, online: boolean): boolean {
    d.setOnline(number, online);
    const c = d.getCustomer(number);
    const session = c && sessionOf(c);
    if (!c || !session) return false;
    session.send({ type: 'tile.presence', number: c.number, online });
    if (online) d.delivery.flushTile(c.number);
    return online;
  }

  function onGroupEvent(session: Session, ev: GroupEvent): void {
    if (session.role.kind !== 'group') return;
    const groupId = session.role.groupId;
    const error = (code: WsErrorCode, message: string) => session.send({ type: 'error', code, message });

    const tile = (number: string): Customer | null => {
      const c = d.getCustomer(number);
      if (c && c.group_id === groupId) return c;
      error('number_not_in_group', `${number} is not a tile in group ${groupId}`);
      return null;
    };
    const business = (key: string): BusinessNumber | null => {
      const b = d.getBusiness(key);
      if (!b) error('unknown_business', `${key} is not a registered business number`);
      return b;
    };

    try {
      switch (ev.type) {
        case 'message.send': {
          const c = tile(ev.from);
          if (!c) return;
          if (!c.online) return error('tile_offline', `${c.number} is offline`);
          const b = business(ev.to);
          if (b) lifecycle().inbound(c.number, b.phone_number_id, ev.body, 'tile');
          return;
        }
        case 'chat.read': {
          const c = tile(ev.number);
          if (!c) return;
          const b = business(ev.peer);
          if (b && c.online) lifecycle().read(c.number, b.phone_number_id); // an offline tile cannot open a chat
          return;
        }
        case 'tile.presence': {
          const c = tile(ev.number);
          if (c) setPresence(c.number, ev.online);
          return;
        }
        case 'tile.autoreply': {
          const c = tile(ev.number);
          if (!c) return;
          const saved = d.setAutoReply(c.number, { mode: ev.mode, delay_ms: ev.delay_ms, rules: ev.rules });
          session.send({ type: 'tile.autoreply', number: c.number, ...saved });
          return;
        }
      }
    } catch (err) {
      if (err instanceof LifecycleError) return error('bad_request', err.message);
      throw err;
    }
  }

  return {
    onGroupEvent,
    setPresence,
    autoReplyChanged(number, ar) {
      const c = d.getCustomer(number);
      const session = c && sessionOf(c);
      session?.send({ type: 'tile.autoreply', number, ...ar });
    },
  };
}
