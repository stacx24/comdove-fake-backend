import { randomUUID } from 'node:crypto';
import { db, now } from '../db/db.js';

// ---------------------------------------------------------------------------
// Business numbers (FR-01)
// ---------------------------------------------------------------------------

export interface BusinessNumber {
  phone_number_id: string;
  display_number: string;
  label: string | null;
  token: string;
  type: 'business';
}

// Register a business number → fake phone_number_id + fake bearer token.
export function registerBusinessNumber(
  display_number: string,
  label?: string,
): { phone_number_id: string; token: string } {
  const count = (
    db.prepare("SELECT COUNT(*) AS n FROM numbers WHERE type='business'").get() as {
      n: number;
    }
  ).n;
  const phone_number_id = `MOCK-PN-${count + 1}`;
  const token = `MOCK-TOKEN-${randomUUID().slice(0, 12)}`;

  db.prepare(
    `INSERT INTO numbers (phone_number_id, display_number, label, token, type, created_at)
     VALUES (?, ?, ?, ?, 'business', ?)`,
  ).run(phone_number_id, display_number, label ?? null, token, now());

  return { phone_number_id, token };
}

export function listBusinessNumbers(): BusinessNumber[] {
  return db
    .prepare(
      "SELECT phone_number_id, display_number, label, token, type FROM numbers WHERE type='business' ORDER BY created_at",
    )
    .all() as BusinessNumber[];
}

// Used by Person 1 to validate the bearer token on a send (token must match id).
export function getBusinessNumber(phone_number_id: string): BusinessNumber | undefined {
  return db
    .prepare(
      "SELECT phone_number_id, display_number, label, token, type FROM numbers WHERE phone_number_id=? AND type='business'",
    )
    .get(phone_number_id) as BusinessNumber | undefined;
}

// ---------------------------------------------------------------------------
// Customer numbers + groups (FR-15)
// ---------------------------------------------------------------------------

function slugify(name: string): string {
  return name.trim().toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
}

// Create a group of up to 10 customer numbers. Customer numbers auto-register.
export function createGroup(
  name: string,
  numbers: string[],
): { id: string; name: string; numbers: string[] } {
  if (numbers.length > 10) {
    throw new Error('a group can have at most 10 numbers');
  }
  const id = slugify(name);

  const tx = db.transaction(() => {
    db.prepare(
      'INSERT INTO groups (id, name, created_at) VALUES (?, ?, ?)',
    ).run(id, name, now());

    for (const number of numbers) {
      // auto-register the customer number if new
      db.prepare(
        `INSERT OR IGNORE INTO numbers (phone_number_id, display_number, type, created_at)
         VALUES (?, ?, 'customer', ?)`,
      ).run(`MOCK-CUST-${number}`, number, now());

      db.prepare(
        'INSERT OR IGNORE INTO group_members (group_id, number) VALUES (?, ?)',
      ).run(id, number);

      // start every tile offline
      db.prepare(
        'INSERT OR IGNORE INTO presence (number, group_id, online) VALUES (?, ?, 0)',
      ).run(number, id);
    }
  });
  tx();

  return { id, name, numbers };
}

export interface GroupSummary {
  id: string;
  name: string;
  count: number;
  status: 'free' | 'locked';
}

export function listGroups(): GroupSummary[] {
  const rows = db
    .prepare('SELECT id, name, locked FROM groups ORDER BY created_at')
    .all() as Array<{ id: string; name: string; locked: number }>;

  return rows.map((g) => {
    const count = (
      db
        .prepare('SELECT COUNT(*) AS n FROM group_members WHERE group_id=?')
        .get(g.id) as { n: number }
    ).n;
    return {
      id: g.id,
      name: g.name,
      count,
      status: g.locked ? 'locked' : 'free',
    };
  });
}

// Used by Person 1 to validate the recipient on a send (must be a known customer).
export function isRegisteredCustomer(number: string): boolean {
  const row = db
    .prepare("SELECT 1 FROM numbers WHERE display_number=? AND type='customer'")
    .get(number);
  return Boolean(row);
}

// Set a tile online/offline (FR-05). Works for every group the number is in.
export function setPresence(number: string, online: boolean): void {
  db.prepare('UPDATE presence SET online=? WHERE number=?').run(online ? 1 : 0, number);
}
