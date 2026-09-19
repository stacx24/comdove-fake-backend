// Person 3's live engine, assembled: one SessionIndex shared by the /ws sessions, the
// bus, the delivery, the tile actions and the admin feed. composeServer() builds it;
// index.ts attaches it to the server.
import type { Server } from 'node:http';
import type { Bus } from './core/ports.js';
import type { Lifecycle } from './core/lifecycle.js';
import type { CustomerListItem, LogEntry } from './contract/ws-events.js';
import { sqliteRegistry } from './core/registry-adapter.js';
import {
  listBusinessNumbers,
  listCustomers,
  listGroupTiles,
  listGroups,
  setAutoReply,
  setOnline,
} from './core/registry.js';
import { getLogEntry, queuedFor } from './core/messages.js';
import { computeReply } from './core/autoreply.js';
import { createLiveBus } from './core/bus.js';
import { createLiveDelivery, type LiveDelivery } from './core/delivery.js';
import { createSessionIndex, type SessionIndex } from './ws/session-index.js';
import { sharedLock } from './ws/shared-lock.js';
import { storeGroups } from './ws/store-groups.js';
import { attachWsServer, type WsServer } from './ws/server.js';
import { createGroupEvents, type GroupEvents } from './ws/group-events.js';
import { createAdminFeed, type AdminFeed } from './ws/admin-feed.js';
import type { LockTable } from './ws/lock.js';
import type { GroupDirectory } from './ws/session.js';

export interface LiveEngineDeps {
  /** Late-bound: the Meta face (and its lifecycle) is built after the live engine. */
  lifecycle: () => Pick<Lifecycle, 'delivered' | 'inbound' | 'read'> | undefined;
  log?: (line: string) => void;
  lock?: LockTable;
  groups?: GroupDirectory;
}

export interface LiveEngine {
  bus: Bus;
  delivery: LiveDelivery;
  sessions: SessionIndex;
  /** Tile actions (message.send, chat.read, tile.presence, tile.autoreply) + their API twins. */
  groupEvents: GroupEvents;
  /** Live admin feed (log, group and number lists, verify). */
  admin: AdminFeed;
  /** The control API changed groups (also refreshes customers) or numbers. */
  adminChanged(what: 'groups' | 'numbers'): void;
  /** After /api/reset: admins get log.reset + lists; open tabs get a fresh snapshot or group_deleted. */
  reset(keepNumbers: boolean): void;
  attach(http: Server, opts?: { heartbeatMs?: number }): WsServer;
}

export function createLiveEngine(d: LiveEngineDeps): LiveEngine {
  const sessions = createSessionIndex();
  const groups = d.groups ?? storeGroups;

  const admin = createAdminFeed({
    // P2's rows are slightly wider than the DTOs (e.g. webhook kind: string).
    getLogEntry: (wamid) => getLogEntry(wamid) as LogEntry | null,
    listGroups,
    listBusinessNumbers,
    listCustomers: () => listCustomers() as CustomerListItem[],
  });

  const delivery = createLiveDelivery({
    sessions,
    getCustomer: sqliteRegistry.getCustomer,
    listGroupTiles,
    queuedFor,
    delivered: (msgs) => d.lifecycle()?.delivered(msgs),
    inbound: (from, to, body, source) => d.lifecycle()?.inbound(from, to, body, source),
    computeReply,
    log: d.log,
  });
  const bus = createLiveBus({ sessions, getCustomer: sqliteRegistry.getCustomer, log: d.log, admin });
  const groupEvents = createGroupEvents({
    sessions,
    delivery,
    lifecycle: d.lifecycle,
    getCustomer: sqliteRegistry.getCustomer,
    getBusiness: sqliteRegistry.getBusiness,
    setOnline: (number, online) => {
      setOnline(number, online);
      admin.numbersChanged();
    },
    setAutoReply: (number, ar) => {
      const saved = setAutoReply(number, ar);
      admin.numbersChanged();
      return saved;
    },
  });

  return {
    bus,
    delivery,
    sessions,
    groupEvents,
    admin,

    adminChanged(what) {
      if (what === 'groups') admin.groupsChanged();
      admin.numbersChanged();
    },

    reset(keepNumbers) {
      admin.reset();
      for (const [groupId, session] of sessions.all()) {
        if (keepNumbers && groups.exists(groupId)) {
          session.send({ type: 'group.claimed', ...groups.snapshot(groupId) });
        } else {
          session.send({ type: 'error', code: 'group_deleted', message: `group ${groupId} was deleted by a reset` });
          session.disconnect?.();
        }
      }
    },

    attach(http, opts = {}) {
      return attachWsServer(http, {
        lock: d.lock ?? sharedLock,
        groups,
        onClaim: (session, groupId) => {
          sessions.add(groupId, session);
          delivery.deliverQueued(groupId);
          admin.lockChanged();
        },
        onRelease: (session, groupId) => {
          sessions.remove(groupId, session);
          admin.lockChanged();
        },
        onAdminSubscribe: (session) => admin.subscribe(session),
        onAdminClose: (session) => admin.unsubscribe(session),
        onGroupEvent: groupEvents.onGroupEvent,
        ...(opts.heartbeatMs !== undefined && { heartbeatMs: opts.heartbeatMs }),
      });
    },
  };
}
