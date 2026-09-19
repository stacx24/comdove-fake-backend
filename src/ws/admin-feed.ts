// The live admin feed (plan §12, FR-09, FR-11): every socket that sent admin.subscribe
// gets the current group and number lists at once, then every change live. Data comes
// from Person 2's store through injected readers, so this file never touches SQLite.
import type {
  AdminEvent,
  BusinessNumber,
  CustomerListItem,
  GroupListItem,
  LogEntry,
} from '../contract/ws-events.js';
import type { Session } from './session.js';

export interface AdminFeedDeps {
  getLogEntry(wamid: string): LogEntry | null;
  listGroups(): GroupListItem[];
  listBusinessNumbers(): BusinessNumber[];
  listCustomers(): CustomerListItem[];
}

export interface AdminFeed {
  /** A socket became an admin feed: remember it and send it the current lists. */
  subscribe(session: Session): void;
  unsubscribe(session: Session): void;
  size(): number;
  /** A message or one of its webhooks changed: log.entry the first time, log.update after. */
  logChanged(wamid: string): void;
  groupsChanged(): void;
  numbersChanged(): void;
  /** A group was claimed or released: both lists show the claim status. */
  lockChanged(): void;
  verify(result: { ok: boolean; at: number; detail: string }): void;
  /** After /api/reset: log.reset, then fresh lists. */
  reset(): void;
}

export function createAdminFeed(d: AdminFeedDeps): AdminFeed {
  const admins = new Set<Session>();
  const announced = new Set<string>(); // wamids already sent as log.entry

  const broadcast = (ev: AdminEvent) => {
    for (const s of admins) s.send(ev);
  };
  const groupsEvent = (): AdminEvent => ({ type: 'groups.update', groups: d.listGroups() });
  const numbersEvent = (): AdminEvent => ({
    type: 'numbers.update',
    business_numbers: d.listBusinessNumbers(),
    customers: d.listCustomers(),
  });
  /** Build the event only if someone is listening. */
  const toAdmins = (make: () => AdminEvent) => {
    if (admins.size > 0) broadcast(make());
  };

  return {
    subscribe(session) {
      admins.add(session);
      session.send(groupsEvent());
      session.send(numbersEvent());
    },
    unsubscribe(session) {
      admins.delete(session);
    },
    size: () => admins.size,

    logChanged(wamid) {
      if (admins.size === 0) return;
      const entry = d.getLogEntry(wamid);
      if (!entry) return;
      const type = announced.has(wamid) ? 'log.update' : 'log.entry';
      announced.add(wamid);
      broadcast({ type, entry });
    },

    groupsChanged: () => toAdmins(groupsEvent),
    numbersChanged: () => toAdmins(numbersEvent),
    lockChanged() {
      toAdmins(groupsEvent);
      toAdmins(numbersEvent);
    },

    verify(result) {
      toAdmins(() => ({ type: 'webhook.verify', ok: result.ok, at: result.at, detail: result.detail }));
    },

    reset() {
      announced.clear();
      toAdmins(() => ({ type: 'log.reset' }));
      toAdmins(groupsEvent);
      toAdmins(numbersEvent);
    },
  };
}
