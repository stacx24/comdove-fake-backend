import { randomUUID } from 'node:crypto';
import { db, now } from '../db/db.js';

export type Direction = 'outbound' | 'inbound';
export type Status = 'queued' | 'sent' | 'delivered' | 'read';

export interface SaveMessageInput {
  from: string;
  to: string;
  body: string;
  direction: Direction;
  status: Status;
}

export interface StoredMessage {
  id: string;
  conversation_id: string;
  direction: Direction;
  from_number: string;
  to_number: string;
  body: string;
  status: Status;
  webhook_result: string | null;
  created_at: number;
}

// A mock wamid: "wamid.MOCK-" + unique suffix (BACKEND-BUILD-PLAN §7c).
export function newWamid(): string {
  return `wamid.MOCK-${randomUUID().replace(/-/g, '').slice(0, 16)}`;
}

// Find or create the conversation for a business<->customer pair. Direction
// decides which side is the business number.
function ensureConversation(from: string, to: string, direction: Direction): string {
  const business = direction === 'outbound' ? from : to;
  const customer = direction === 'outbound' ? to : from;

  const existing = db
    .prepare(
      'SELECT id FROM conversations WHERE business_number=? AND customer_number=?',
    )
    .get(business, customer) as { id: string } | undefined;
  if (existing) return existing.id;

  const id = randomUUID();
  db.prepare(
    'INSERT INTO conversations (id, business_number, customer_number) VALUES (?, ?, ?)',
  ).run(id, business, customer);
  return id;
}

// Save a message and return it. Person 1 (send) and Person 3 (tile reply) both
// call this.
export function saveMessage(input: SaveMessageInput): StoredMessage {
  const id = newWamid();
  const conversation_id = ensureConversation(input.from, input.to, input.direction);
  const created_at = now();

  db.prepare(
    `INSERT INTO messages
       (id, conversation_id, direction, from_number, to_number, body, status, created_at,
        sent_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    id,
    conversation_id,
    input.direction,
    input.from,
    input.to,
    input.body,
    input.status,
    created_at,
    input.status === 'sent' ? created_at : null,
  );

  return {
    id,
    conversation_id,
    direction: input.direction,
    from_number: input.from,
    to_number: input.to,
    body: input.body,
    status: input.status,
    webhook_result: null,
    created_at,
  };
}

// Update a message's status timeline. Person 1/3 call this as statuses advance.
export function updateStatus(wamid: string, status: Status): void {
  const column =
    status === 'delivered' ? 'delivered_at' : status === 'read' ? 'read_at' : 'sent_at';
  db.prepare(`UPDATE messages SET status=?, ${column}=? WHERE id=?`).run(
    status,
    now(),
    wamid,
  );
}

// Record the webhook delivery outcome for the admin log (Person 1 calls this).
export function setWebhookResult(wamid: string, result: string): void {
  db.prepare('UPDATE messages SET webhook_result=? WHERE id=?').run(result, wamid);
}

// Admin live log, newest first (FR-11).
export function getLog(limit = 100): StoredMessage[] {
  return db
    .prepare(
      `SELECT id, conversation_id, direction, from_number, to_number, body, status,
              webhook_result, created_at, sent_at, delivered_at, read_at
         FROM messages ORDER BY created_at DESC LIMIT ?`,
    )
    .all(limit) as StoredMessage[];
}

// Wipe messages/queues. Keep numbers + groups unless keepNumbers is false (FR-12).
export function resetAll(keepNumbers = true): void {
  const tx = db.transaction(() => {
    db.prepare('DELETE FROM messages').run();
    db.prepare('DELETE FROM conversations').run();
    if (!keepNumbers) {
      db.prepare('DELETE FROM group_members').run();
      db.prepare('DELETE FROM presence').run();
      db.prepare('DELETE FROM groups').run();
      db.prepare('DELETE FROM numbers').run();
    }
  });
  tx();
}
