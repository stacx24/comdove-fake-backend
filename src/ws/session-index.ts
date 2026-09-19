// Which open session holds each group, so the bus and delivery can reach the tile's
// browser. Filled by the session hooks onClaim / onRelease (see src/live.ts).
import type { Session } from './session.js';

export interface SessionIndex {
  add(groupId: string, session: Session): void;
  /** Removes only if `session` is the one stored for the group. */
  remove(groupId: string, session: Session): void;
  get(groupId: string): Session | undefined;
}

export function createSessionIndex(): SessionIndex {
  const byGroup = new Map<string, Session>();
  return {
    add(groupId, session) {
      byGroup.set(groupId, session);
    },
    remove(groupId, session) {
      if (byGroup.get(groupId) === session) byGroup.delete(groupId);
    },
    get: (groupId) => byGroup.get(groupId),
  };
}
