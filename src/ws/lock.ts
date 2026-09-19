// One active session per group (FR-16). In memory only, empty on boot, so a crash
// can never wedge a group. Only the owner can release its lock.

export type ClaimResult = { ok: true; since: number } | { ok: false; since: number };

export interface LockTable {
  /** Free → take it. Held (by anyone, including `owner`) → refused with the holder's since. */
  claim(groupId: string, owner: object): ClaimResult;
  /** Only the owner can release. Returns true if the lock was released. */
  release(groupId: string, owner: object): boolean;
  isLocked(groupId: string): boolean;
  lockedSince(groupId: string): number | null;
}

export function createLockTable(
  opts: { now?: () => number; onChange?: (groupId: string) => void } = {},
): LockTable {
  const now = opts.now ?? Date.now;
  const onChange = opts.onChange ?? (() => {});
  const locks = new Map<string, { owner: object; since: number }>();

  return {
    claim(groupId, owner) {
      const held = locks.get(groupId);
      if (held) return { ok: false, since: held.since };
      const since = now();
      locks.set(groupId, { owner, since });
      onChange(groupId);
      return { ok: true, since };
    },

    release(groupId, owner) {
      const held = locks.get(groupId);
      if (!held || held.owner !== owner) return false;
      locks.delete(groupId);
      onChange(groupId);
      return true;
    },

    isLocked: (groupId) => locks.has(groupId),
    lockedSince: (groupId) => locks.get(groupId)?.since ?? null,
  };
}
