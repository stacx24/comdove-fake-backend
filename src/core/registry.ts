import { randomUUID } from 'node:crypto';
import { db, now } from '../db/db.js';
import { sharedLock } from '../ws/shared-lock.js';

// The session lock is owned by Person 3 (in memory, ws/shared-lock.ts): the /ws
// sessions take it; the registry only reads it.
const isLocked = (groupId: string): boolean => sharedLock.isLocked(groupId);
const lockedSince = (groupId: string): number | null => sharedLock.lockedSince(groupId);

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------
export interface BusinessNumber {
  phone_number_id: string;
  display_number: string;
  label: string | null;
  token: string;
  waba_id: string;
  created_at: number;
}

export interface Customer {
  number: string;
  group_id: string;
  position: number;
  label: string | null;
  online: number; // 0 | 1 (tile flag)
  reply_mode: 'manual' | 'echo' | 'keyword';
  reply_delay_ms: number;
}

export interface AutoReply {
  mode: 'manual' | 'echo' | 'keyword';
  delay_ms: number;
  rules: Array<{ keyword: string; reply: string }>;
}

function slugify(name: string): string {
  return name.trim().toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
}

function digitsOnly(n: string): string {
  return String(n).replace(/[^\d]/g, '');
}

/** Bad input from the caller (the route answers 400); other errors are conflicts (409). */
export class InvalidInputError extends Error {}

// TEAM-SPLIT "Shared rules": strip +, spaces and dashes; what is left must be 8–15 digits.
// Anything else (letters, brackets, too short/long) is rejected rather than silently cleaned.
function phoneNumber(raw: unknown, what: string): string {
  const cleaned = String(raw ?? '').replace(/[+\s-]/g, '');
  if (!/^\d{8,15}$/.test(cleaned)) throw new InvalidInputError(`${what} ${JSON.stringify(raw)} must be 8–15 digits`);
  return cleaned;
}

// ---------------------------------------------------------------------------
// Business numbers (FR-01)
// ---------------------------------------------------------------------------
export function registerBusinessNumber(input: {
  display_number: string;
  label?: string;
  phone_number_id?: string; // optional — supply Comdove's real id (plan §5c)
  waba_id?: string;
  token?: string;
}): BusinessNumber {
  const count = (db.prepare('SELECT COUNT(*) AS n FROM business_numbers').get() as { n: number }).n;
  if (count >= 10) throw new Error('at most 10 business numbers (PRD scale target)');

  const display_number = phoneNumber(input.display_number, 'display_number');

  const phone_number_id = input.phone_number_id ?? `MOCK-PN-${count + 1}`;
  const token = input.token ?? `mock-token-${randomUUID().slice(0, 12)}`;
  const waba_id = input.waba_id ?? 'MOCK-WABA-1';

  db.prepare(
    `INSERT INTO business_numbers (phone_number_id, display_number, label, token, waba_id, created_at)
     VALUES (?, ?, ?, ?, ?, ?)`,
  ).run(phone_number_id, display_number, input.label ?? null, token, waba_id, now());

  return { phone_number_id, display_number, label: input.label ?? null, token, waba_id, created_at: now() };
}

export function listBusinessNumbers(): BusinessNumber[] {
  return db
    .prepare('SELECT phone_number_id, display_number, label, token, waba_id, created_at FROM business_numbers ORDER BY created_at')
    .all() as BusinessNumber[];
}

// Resolve a business number by phone_number_id OR display number (Person 1 + inject).
export function getBusiness(phoneNumberIdOrDisplay: string): BusinessNumber | null {
  const key = String(phoneNumberIdOrDisplay);
  const row = db
    .prepare(
      `SELECT phone_number_id, display_number, label, token, waba_id, created_at
         FROM business_numbers WHERE phone_number_id = ? OR display_number = ?`,
    )
    .get(key, digitsOnly(key)) as BusinessNumber | undefined;
  return row ?? null;
}

export function deleteBusinessNumber(phone_number_id: string): boolean {
  const info = db.prepare('DELETE FROM business_numbers WHERE phone_number_id=?').run(phone_number_id);
  return info.changes > 0;
}

// ---------------------------------------------------------------------------
// Groups + customers (FR-15)
// ---------------------------------------------------------------------------
export function createGroup(
  name: string,
  numbers: string[],
  labels?: Record<string, string>,
): { id: string; name: string; numbers: string[] } {
  if (numbers.length < 1 || numbers.length > 10) throw new Error('a group needs 1–10 numbers');
  const id = slugify(name);
  if (!id) throw new Error('group name must contain letters or digits');

  const clean = numbers.map((n) => phoneNumber(n, 'customer number'));
  const dup = clean.find((n, i) => clean.indexOf(n) !== i);
  if (dup) throw new InvalidInputError(`number ${dup} is listed more than once`);
  for (const num of clean) {
    if (getCustomer(num)) throw new Error(`number ${num} is already a customer in another group`);
    if (getBusiness(num)) throw new Error(`number ${num} is a business number`);
  }

  const tx = db.transaction(() => {
    db.prepare('INSERT INTO groups (id, name, created_at) VALUES (?, ?, ?)').run(id, name, now());
    clean.forEach((num, i) => {
      db.prepare(
        `INSERT INTO customers (number, group_id, position, label, online, created_at)
         VALUES (?, ?, ?, ?, 1, ?)`,
      ).run(num, id, i, labels?.[num] ?? null, now());
    });
  });
  tx();

  return { id, name, numbers: clean };
}

export interface GroupSummary {
  id: string;
  name: string;
  count: number;
  status: 'free' | 'locked';
  locked_since: number | null;
}

export function listGroups(): GroupSummary[] {
  const rows = db.prepare('SELECT id, name FROM groups ORDER BY created_at').all() as Array<{
    id: string;
    name: string;
  }>;
  return rows.map((g) => ({
    id: g.id,
    name: g.name,
    count: (db.prepare('SELECT COUNT(*) AS n FROM customers WHERE group_id=?').get(g.id) as { n: number }).n,
    status: isLocked(g.id) ? 'locked' : 'free',
    locked_since: lockedSince(g.id),
  }));
}

export function deleteGroup(id: string): { ok: boolean; locked: boolean } {
  if (isLocked(id)) return { ok: false, locked: true };
  const info = db.prepare('DELETE FROM groups WHERE id=?').run(id); // customers cascade
  return { ok: info.changes > 0, locked: false };
}

export function getCustomer(number: string): Customer | null {
  const row = db
    .prepare(
      'SELECT number, group_id, position, label, online, reply_mode, reply_delay_ms FROM customers WHERE number=?',
    )
    .get(digitsOnly(number)) as Customer | undefined;
  return row ?? null;
}

export function listGroupTiles(groupId: string): Customer[] {
  return db
    .prepare(
      'SELECT number, group_id, position, label, online, reply_mode, reply_delay_ms FROM customers WHERE group_id=? ORDER BY position',
    )
    .all(groupId) as Customer[];
}

// Admin list: every customer + type + claim status (PRD §7).
export function listCustomers() {
  const rows = db
    .prepare('SELECT number, group_id, label, online, reply_mode FROM customers ORDER BY group_id, position')
    .all() as Array<{ number: string; group_id: string; label: string | null; online: number; reply_mode: string }>;
  return rows.map((c) => ({
    number: c.number,
    label: c.label,
    group_id: c.group_id,
    online: Boolean(c.online),
    effective_online: Boolean(c.online) && isLocked(c.group_id),
    claim_status: isLocked(c.group_id) ? 'locked' : 'free',
    reply_mode: c.reply_mode,
    type: 'customer' as const,
  }));
}

// Set the persisted tile flag (Person 3's delivery.setPresence calls this).
export function setOnline(number: string, online: boolean): void {
  db.prepare('UPDATE customers SET online=? WHERE number=?').run(online ? 1 : 0, digitsOnly(number));
}

// ---------------------------------------------------------------------------
// Auto-reply config (FR-10)
// ---------------------------------------------------------------------------
export function getAutoReply(number: string): AutoReply | null {
  const c = getCustomer(number);
  if (!c) return null;
  const rules = db
    .prepare('SELECT keyword, reply FROM keyword_replies WHERE customer_number=? ORDER BY position')
    .all(digitsOnly(number)) as Array<{ keyword: string; reply: string }>;
  return { mode: c.reply_mode, delay_ms: c.reply_delay_ms, rules };
}

export function setAutoReply(number: string, ar: AutoReply): AutoReply {
  const num = digitsOnly(number);
  if (!getCustomer(num)) throw new Error(`unknown customer ${num}`);
  const tx = db.transaction(() => {
    db.prepare('UPDATE customers SET reply_mode=?, reply_delay_ms=? WHERE number=?').run(
      ar.mode,
      ar.delay_ms ?? 0,
      num,
    );
    db.prepare('DELETE FROM keyword_replies WHERE customer_number=?').run(num);
    (ar.rules ?? []).forEach((r, i) =>
      db.prepare(
        'INSERT INTO keyword_replies (customer_number, position, keyword, reply) VALUES (?, ?, ?, ?)',
      ).run(num, i, r.keyword, r.reply),
    );
  });
  tx();
  return getAutoReply(num)!;
}

// ---------------------------------------------------------------------------
// Reset (FR-12)
// ---------------------------------------------------------------------------
export function resetAll(keepNumbers = true): void {
  const tx = db.transaction(() => {
    db.prepare('DELETE FROM webhook_attempts').run();
    db.prepare('DELETE FROM webhook_jobs').run();
    db.prepare('DELETE FROM rejected_requests').run();
    db.prepare('DELETE FROM messages').run();
    db.prepare('DELETE FROM conversations').run();
    if (!keepNumbers) {
      db.prepare('DELETE FROM keyword_replies').run();
      db.prepare('DELETE FROM customers').run();
      db.prepare('DELETE FROM groups').run();
      db.prepare('DELETE FROM business_numbers').run();
    }
  });
  tx();
}
