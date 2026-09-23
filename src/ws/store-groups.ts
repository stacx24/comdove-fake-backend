// GroupDirectory on Person 2's SQLite store: what /ws needs to claim a group and render
// its grid from the snapshot alone (contract Snapshot, plan §11c).
import { SNAPSHOT_HISTORY_PER_TILE, type Snapshot, type Tile } from '../contract/ws-events.js';
import type { GroupDirectory } from './session.js';
import { getAutoReply, listBusinessNumbers, listGroupTiles, listGroups, type Customer } from '../core/registry.js';
import { history, queuedFor } from '../core/messages.js';
import { toWsMessage } from './wire.js';

function tileOf(c: Customer): Tile {
  const queued = queuedFor(c.number);
  const queuedIds = new Set(queued.map((m) => m.wamid));
  const past = history(c.number).filter((m) => !queuedIds.has(m.wamid));
  const unread: Record<string, number> = {};
  for (const m of past) {
    if (m.direction === 'outbound' && m.delivered_at && !m.read_at) {
      unread[m.from_number] = (unread[m.from_number] ?? 0) + 1;
    }
  }
  // Only the newest slice goes in the snapshot: a 100-tile group talking to 5 businesses
  // would otherwise send one huge frame on every claim and every reconnect (WS-343).
  // Unread is counted above, over the whole history, so the badges stay right.
  const recent = past.length > SNAPSHOT_HISTORY_PER_TILE ? past.slice(-SNAPSHOT_HISTORY_PER_TILE) : past;
  return {
    number: c.number,
    label: c.label,
    online: Boolean(c.online),
    auto_reply: getAutoReply(c.number) ?? { mode: 'manual', delay_ms: 0, rules: [] },
    history: recent.map(toWsMessage),
    queued: queued.map(toWsMessage),
    unread,
  };
}

export const storeGroups: GroupDirectory = {
  exists: (groupId) => listGroups().some((g) => g.id === groupId),

  snapshot(groupId): Snapshot {
    const group = listGroups().find((g) => g.id === groupId);
    if (!group) throw new Error(`unknown group: ${groupId}`);
    return {
      group: { id: group.id, name: group.name },
      business_numbers: listBusinessNumbers().map((b) => ({
        phone_number_id: b.phone_number_id,
        display_number: b.display_number,
        label: b.label,
      })),
      tiles: listGroupTiles(groupId).map(tileOf),
    };
  },
};
