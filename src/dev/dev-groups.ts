// In-memory GroupDirectory for tests and `npm run dev` until Person 2's store is
// plugged in at checkpoint ①. Every tile starts online with an empty history.

import type { Snapshot } from '../contract/ws-events.js';
import type { GroupDirectory } from '../ws/session.js';

export interface MemoryGroup {
  name: string;
  tiles?: string[];
}

export const DEV_GROUPS: Record<string, MemoryGroup> = {
  alpha: { name: 'Alpha', tiles: ['919876543210', '919876543211'] },
  beta: { name: 'Beta', tiles: ['919876543220'] },
};

export function createMemoryGroups(groups: Record<string, MemoryGroup>): GroupDirectory {
  return {
    exists: (groupId) => Object.hasOwn(groups, groupId),

    snapshot(groupId): Snapshot {
      const group = groups[groupId];
      if (!group || !Object.hasOwn(groups, groupId)) throw new Error(`unknown group: ${groupId}`);
      return {
        group: { id: groupId, name: group.name },
        business_numbers: [],
        tiles: (group.tiles ?? []).map((number) => ({
          number,
          label: null,
          online: true,
          auto_reply: { mode: 'manual', delay_ms: 0, rules: [] },
          history: [],
          queued: [],
          unread: {},
        })),
      };
    },
  };
}
