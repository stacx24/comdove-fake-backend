// Person 3's live engine, assembled: one SessionIndex shared by the /ws sessions, the
// bus and the delivery. composeServer() builds it; index.ts attaches it to the server.
import type { Server } from 'node:http';
import type { Bus } from './core/ports.js';
import type { Lifecycle } from './core/lifecycle.js';
import { sqliteRegistry } from './core/registry-adapter.js';
import { listGroupTiles, setOnline, setAutoReply } from './core/registry.js';
import { queuedFor } from './core/messages.js';
import { computeReply } from './core/autoreply.js';
import { createLiveBus } from './core/bus.js';
import { createLiveDelivery, type LiveDelivery } from './core/delivery.js';
import { createSessionIndex, type SessionIndex } from './ws/session-index.js';
import { sharedLock } from './ws/shared-lock.js';
import { storeGroups } from './ws/store-groups.js';
import { attachWsServer, type WsServer } from './ws/server.js';
import { createGroupEvents, type GroupEvents } from './ws/group-events.js';
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
  attach(http: Server, opts?: { heartbeatMs?: number }): WsServer;
}

export function createLiveEngine(d: LiveEngineDeps): LiveEngine {
  const sessions = createSessionIndex();
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
  const bus = createLiveBus({ sessions, getCustomer: sqliteRegistry.getCustomer, log: d.log });
  const groupEvents = createGroupEvents({
    sessions,
    delivery,
    lifecycle: d.lifecycle,
    getCustomer: sqliteRegistry.getCustomer,
    getBusiness: sqliteRegistry.getBusiness,
    setOnline,
    setAutoReply,
  });

  return {
    bus,
    delivery,
    sessions,
    groupEvents,
    attach(http, opts = {}) {
      return attachWsServer(http, {
        lock: d.lock ?? sharedLock,
        groups: d.groups ?? storeGroups,
        onClaim: (session, groupId) => {
          sessions.add(groupId, session);
          delivery.deliverQueued(groupId);
        },
        onRelease: (session, groupId) => sessions.remove(groupId, session),
        onGroupEvent: groupEvents.onGroupEvent,
        ...(opts.heartbeatMs !== undefined && { heartbeatMs: opts.heartbeatMs }),
      });
    },
  };
}
