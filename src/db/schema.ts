// comdove-fake-backend — SQLite schema (BACKEND-BUILD-PLAN §6).
// Kept as a TS constant (not a .sql file) so it works identically in dev (tsx)
// and in the compiled build (tsc does not copy non-.ts files into dist/).

export const SCHEMA_SQL = `
-- business + customer numbers
CREATE TABLE IF NOT EXISTS numbers (
  phone_number_id TEXT PRIMARY KEY,
  display_number  TEXT NOT NULL,
  label           TEXT,
  token           TEXT,
  type            TEXT NOT NULL,        -- 'business' | 'customer'
  reply_mode      TEXT DEFAULT 'manual',
  created_at      INTEGER NOT NULL
);

-- customer groups
CREATE TABLE IF NOT EXISTS groups (
  id           TEXT PRIMARY KEY,
  name         TEXT NOT NULL,
  locked       INTEGER DEFAULT 0,
  locked_since INTEGER,
  connected    INTEGER DEFAULT 0,
  created_at   INTEGER NOT NULL
);

-- which customer numbers belong to a group (up to 10)
CREATE TABLE IF NOT EXISTS group_members (
  group_id TEXT NOT NULL,
  number   TEXT NOT NULL,
  PRIMARY KEY (group_id, number)
);

-- a pair of numbers (business <-> customer)
CREATE TABLE IF NOT EXISTS conversations (
  id              TEXT PRIMARY KEY,
  business_number TEXT NOT NULL,
  customer_number TEXT NOT NULL,
  UNIQUE (business_number, customer_number)
);

-- every message + its status timeline
CREATE TABLE IF NOT EXISTS messages (
  id              TEXT PRIMARY KEY,     -- wamid.MOCK-...
  conversation_id TEXT,
  direction       TEXT NOT NULL,        -- 'outbound' | 'inbound'
  from_number     TEXT NOT NULL,
  to_number       TEXT NOT NULL,
  body            TEXT NOT NULL,
  status          TEXT NOT NULL,        -- 'queued'|'sent'|'delivered'|'read'
  webhook_result  TEXT,
  created_at      INTEGER NOT NULL,
  sent_at         INTEGER,
  delivered_at    INTEGER,
  read_at         INTEGER
);

-- per-tile online/offline flag
CREATE TABLE IF NOT EXISTS presence (
  number   TEXT NOT NULL,
  group_id TEXT NOT NULL,
  online   INTEGER DEFAULT 0,
  PRIMARY KEY (number, group_id)
);
`;
