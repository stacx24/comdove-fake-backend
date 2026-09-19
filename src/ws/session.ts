// One WebSocket connection's state: its role (group session or admin feed) and the
// group.claim flow (plan §11a, FR-16). Group data comes through the GroupDirectory
// port, so this file never imports Person 2 code.

import {
  encodeEvent,
  type AdminEvent,
  type ClientEvent,
  type ServerEvent,
  type Snapshot,
  type WsErrorCode,
} from '../contract/ws-events.js';
import type { LockTable } from './lock.js';

export interface GroupDirectory {
  exists(groupId: string): boolean;
  /** Everything the grid needs to render (contract Snapshot). */
  snapshot(groupId: string): Snapshot;
}

/** The client events that need a claimed group. */
export type GroupEvent = Exclude<ClientEvent, { type: 'group.claim' | 'admin.subscribe' }>;

export interface SessionDeps {
  lock: LockTable;
  groups: GroupDirectory;
  /** Handlers for the 4 group events (later step). Default: ignore. */
  onGroupEvent?: (session: Session, ev: GroupEvent) => void;
  /** Called after a successful claim, once group.claimed has been sent. */
  onClaim?: (session: Session, groupId: string) => void;
  /** Called when a session that held a group closes, after its lock is released. */
  onRelease?: (session: Session, groupId: string) => void;
}

export type Role = { kind: 'none' } | { kind: 'group'; groupId: string } | { kind: 'admin' };

export interface SessionSocket {
  send(data: string): void;
  readonly readyState: number;
}

export interface Session {
  readonly role: Role;
  send(ev: ServerEvent | AdminEvent): void;
  handle(ev: ClientEvent): void;
  /** Socket closed: release the lock if this session holds one. Safe to call twice. */
  close(): void;
}

const OPEN = 1; // WebSocket.OPEN

export function createSession(socket: SessionSocket, deps: SessionDeps): Session {
  let role: Role = { kind: 'none' };
  let closed = false;

  const session: Session = {
    get role() {
      return role;
    },

    send(ev) {
      if (socket.readyState === OPEN) socket.send(encodeEvent(ev));
    },

    handle(ev) {
      switch (ev.type) {
        case 'group.claim':
          return claim(ev.group);
        case 'admin.subscribe':
          if (role.kind !== 'none') return error('already_claimed', 'this socket already has a role');
          role = { kind: 'admin' };
          return;
        default:
          if (role.kind !== 'group') return error('not_claimed', 'claim a group first');
          deps.onGroupEvent?.(session, ev);
      }
    },

    close() {
      if (closed) return;
      closed = true;
      if (role.kind === 'group') {
        deps.lock.release(role.groupId, session);
        deps.onRelease?.(session, role.groupId);
      }
    },
  };

  function error(code: WsErrorCode, message: string): void {
    session.send({ type: 'error', code, message });
  }

  function claim(groupId: string): void {
    if (role.kind !== 'none') return error('already_claimed', 'this socket already has a role');
    if (!deps.groups.exists(groupId)) return error('unknown_group', `unknown group: ${groupId}`);
    const result = deps.lock.claim(groupId, session);
    if (!result.ok) {
      session.send({ type: 'group.locked', group: groupId, since: result.since });
      return;
    }
    role = { kind: 'group', groupId };
    session.send({ type: 'group.claimed', ...deps.groups.snapshot(groupId) });
    deps.onClaim?.(session, groupId);
  }

  return session;
}
