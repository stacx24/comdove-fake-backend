import { randomBytes } from 'node:crypto';
import { db, now } from '../db/db.js';
import { getBusiness } from './registry.js';

export type Direction = 'outbound' | 'inbound';
export type Source = 'api' | 'tile' | 'inject' | 'autoreply';
export type Status = 'sent' | 'delivered' | 'read';

export interface NewMessage {
  from: string; // display numbers on both sides
  to: string;
  body: string;
  direction: Direction;
  source: Source;
  /** Person 1 passes the wamid it already generated; otherwise one is made here. */
  wamid?: string;
  /** ms; defaults to now(). */
  at?: number;
}

export interface StoredMessage {
  wamid: string;
  conversation_id: number;
  seq: number;
  direction: Direction;
  source: Source;
  phone_number_id: string; // business side (from conversations)
  customer_number: string; // customer side (from conversations)
  from_number: string;
  to_number: string;
  body: string;
  created_at: number;
  sent_at: number | null;
  delivered_at: number | null;
  read_at: number | null;
}

// "wamid.MOCK-" + 24 hex chars (plan §7c).
export function newWamid(): string {
  return `wamid.MOCK-${randomBytes(12).toString('hex')}`;
}

// Messages joined with their conversation, so every row carries phone_number_id +
// customer_number (Person 1's lifecycle keys webhooks and reads on those).
const SELECT_MESSAGE = `SELECT m.*, c.phone_number_id, c.customer_number
  FROM messages m JOIN conversations c ON c.id = m.conversation_id`;

// Find/create the conversation for a business<->customer pair and hand out the
// next per-conversation seq. Direction decides which side is the business.
// conversations.phone_number_id stores the business's phone_number_id (not its
// display number), so it matches business_numbers and Meta's metadata.
function conversationFor(from: string, to: string, direction: Direction): { id: number; phone_number_id: string; customer_number: string } {
  const businessKey = direction === 'outbound' ? from : to;
  const customer_number = direction === 'outbound' ? to : from;
  const phone_number_id = getBusiness(businessKey)?.phone_number_id ?? businessKey;
  const existing = db
    .prepare('SELECT id FROM conversations WHERE phone_number_id=? AND customer_number=?')
    .get(phone_number_id, customer_number) as { id: number } | undefined;
  if (existing) return { id: existing.id, phone_number_id, customer_number };
  const info = db
    .prepare('INSERT INTO conversations (phone_number_id, customer_number, next_seq) VALUES (?, ?, 1)')
    .run(phone_number_id, customer_number);
  return { id: Number(info.lastInsertRowid), phone_number_id, customer_number };
}

// Store a message in one transaction (conversation, seq, insert). Outbound is
// created 'sent' (sent_at set); inbound has no status timeline.
export function storeMessage(m: NewMessage): StoredMessage {
  const wamid = m.wamid ?? newWamid();
  const created_at = m.at ?? now();
  const tx = db.transaction(() => {
    const { id: conversation_id, phone_number_id, customer_number } = conversationFor(m.from, m.to, m.direction);
    const seqRow = db.prepare('SELECT next_seq FROM conversations WHERE id=?').get(conversation_id) as {
      next_seq: number;
    };
    const seq = seqRow.next_seq;
    db.prepare('UPDATE conversations SET next_seq=? WHERE id=?').run(seq + 1, conversation_id);
    const sent_at = m.direction === 'outbound' ? created_at : null;
    db.prepare(
      `INSERT INTO messages (wamid, conversation_id, seq, direction, source, from_number, to_number, body, created_at, sent_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(wamid, conversation_id, seq, m.direction, m.source, m.from, m.to, m.body, created_at, sent_at);
    return { conversation_id, seq, phone_number_id, customer_number };
  });
  const { conversation_id, seq, phone_number_id, customer_number } = tx();
  return {
    wamid,
    conversation_id,
    seq,
    direction: m.direction,
    source: m.source,
    phone_number_id,
    customer_number,
    from_number: m.from,
    to_number: m.to,
    body: m.body,
    created_at,
    sent_at: m.direction === 'outbound' ? created_at : null,
    delivered_at: null,
    read_at: null,
  };
}

export function getMessage(wamid: string): StoredMessage | null {
  return (db.prepare(`${SELECT_MESSAGE} WHERE m.wamid=?`).get(wamid) as StoredMessage) ?? null;
}

export function setDelivered(wamids: string | string[], at: number): void {
  const stmt = db.prepare('UPDATE messages SET delivered_at=COALESCE(delivered_at, ?) WHERE wamid=?');
  const tx = db.transaction((ids: string[]) => ids.forEach((id) => stmt.run(at, id)));
  tx(Array.isArray(wamids) ? wamids : [wamids]);
}

// Outbound messages in one chat that are delivered but not yet read, in seq order
// (what a chat.read turns into read webhooks — Person 1's lifecycle.read).
export function unreadDelivered(customerNumber: string, phoneNumberId: string): StoredMessage[] {
  return db
    .prepare(
      `${SELECT_MESSAGE} WHERE c.customer_number = ? AND c.phone_number_id = ?
         AND m.direction='outbound' AND m.delivered_at IS NOT NULL AND m.read_at IS NULL
       ORDER BY m.seq`,
    )
    .all(customerNumber, phoneNumberId) as StoredMessage[];
}

export function setRead(wamids: string[], at: number): void {
  const stmt = db.prepare('UPDATE messages SET read_at=COALESCE(read_at, ?) WHERE wamid=?');
  const tx = db.transaction((ids: string[]) => ids.forEach((id) => stmt.run(at, id)));
  tx(wamids);
}

// Outbound messages not yet delivered, per conversation, in seq order (the queue).
export function queuedFor(customerNumber: string): StoredMessage[] {
  return db
    .prepare(
      `${SELECT_MESSAGE}
        WHERE c.customer_number = ? AND m.direction='outbound' AND m.delivered_at IS NULL
        ORDER BY m.conversation_id, m.seq`,
    )
    .all(customerNumber) as StoredMessage[];
}

export function history(customerNumber: string): StoredMessage[] {
  return db
    .prepare(
      `${SELECT_MESSAGE}
        WHERE c.customer_number = ? ORDER BY m.created_at, m.seq`,
    )
    .all(customerNumber) as StoredMessage[];
}

function statusOf(m: StoredMessage): Status {
  return m.read_at ? 'read' : m.delivered_at ? 'delivered' : 'sent';
}

// One admin-log entry (plan §10c). Shared by GET /api/log and the admin feed.
export interface LogEntry {
  wamid: string;
  time: number;
  direction: Direction;
  source: Source;
  from: string;
  to: string;
  business: { phone_number_id: string; label: string | null } | null;
  group_id: string | null;
  body: string;
  status: Status;
  timeline: Array<{ status: Status; at: number }>;
  webhooks: Array<{
    kind: string;
    state: string;
    attempts: Array<{ n: number; http_status: number | null; error: string | null; duration_ms: number | null; at: number }>;
  }>;
}

// A Meta request the emulator rejected (plan §8c, §10c): no wamid, never stored as a message.
export interface RejectedLogEntry {
  wamid: null;
  time: number;
  direction: 'rejected';
  phone_number_id: string;
  to: string | null;
  body: string | null;
  http_status: number;
  code: number;
  subcode: number | null;
  forced: boolean;
}

export interface RejectedRequest {
  at: number;
  phone_number_id: string;
  http_status: number;
  code: number;
  subcode?: number;
  forced: boolean;
  to?: string;
  body?: string;
}

export function logRejected(r: RejectedRequest): void {
  db.prepare(
    `INSERT INTO rejected_requests (at, phone_number_id, http_status, code, subcode, forced, to_number, body)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(r.at, r.phone_number_id, r.http_status, r.code, r.subcode ?? null, r.forced ? 1 : 0, r.to ?? null, r.body ?? null);
}

function toLogEntry(m: StoredMessage): LogEntry {
  const biz = getBusiness(m.phone_number_id);
  const group = db
    .prepare('SELECT group_id FROM customers WHERE number=?')
    .get(m.customer_number) as { group_id: string } | undefined;

  const timeline: Array<{ status: Status; at: number }> = [];
  if (m.sent_at) timeline.push({ status: 'sent', at: m.sent_at });
  if (m.delivered_at) timeline.push({ status: 'delivered', at: m.delivered_at });
  if (m.read_at) timeline.push({ status: 'read', at: m.read_at });

  const jobs = db
    .prepare('SELECT id, kind, state FROM webhook_jobs WHERE wamid=? ORDER BY id')
    .all(m.wamid) as Array<{ id: number; kind: string; state: string }>;
  const webhooks = jobs.map((j) => ({
    kind: j.kind,
    state: j.state,
    attempts: (
      db
        .prepare('SELECT attempt, http_status, error, duration_ms, at FROM webhook_attempts WHERE job_id=? ORDER BY attempt')
        .all(j.id) as Array<{ attempt: number; http_status: number | null; error: string | null; duration_ms: number | null; at: number }>
    ).map((a) => ({ n: a.attempt, http_status: a.http_status, error: a.error, duration_ms: a.duration_ms, at: a.at })),
  }));

  return {
    wamid: m.wamid,
    time: m.created_at,
    direction: m.direction,
    source: m.source,
    from: m.from_number,
    to: m.to_number,
    business: biz ? { phone_number_id: biz.phone_number_id, label: biz.label } : null,
    group_id: group?.group_id ?? null,
    body: m.body,
    status: statusOf(m),
    timeline,
    webhooks,
  };
}

export function getLogEntry(wamid: string): LogEntry | null {
  const m = getMessage(wamid);
  return m ? toLogEntry(m) : null;
}

// Newest first: messages and rejected Meta requests interleaved by time.
export function getLog(limit = 100): Array<LogEntry | RejectedLogEntry> {
  const rows = db
    .prepare(`${SELECT_MESSAGE} ORDER BY m.created_at DESC LIMIT ?`)
    .all(limit) as StoredMessage[];
  const rejected = (
    db.prepare('SELECT * FROM rejected_requests ORDER BY at DESC LIMIT ?').all(limit) as Array<{
      at: number; phone_number_id: string; http_status: number; code: number; subcode: number | null; forced: number; to_number: string | null; body: string | null;
    }>
  ).map(
    (r): RejectedLogEntry => ({
      wamid: null, time: r.at, direction: 'rejected', phone_number_id: r.phone_number_id, to: r.to_number, body: r.body,
      http_status: r.http_status, code: r.code, subcode: r.subcode, forced: Boolean(r.forced),
    }),
  );
  return [...rows.map(toLogEntry), ...rejected].sort((a, b) => b.time - a.time).slice(0, limit);
}
