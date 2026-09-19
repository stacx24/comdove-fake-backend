// comdove-fake-backend — SQLite schema (BACKEND-BUILD-PLAN §6, 8 tables).
// Kept as a TS constant (not a .sql file) so it works identically in dev (tsx)
// and in the compiled build (tsc does not copy non-.ts files into dist/).

export const SCHEMA_SQL = `
PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;

-- Business numbers (FR-01)
CREATE TABLE IF NOT EXISTS business_numbers (
  phone_number_id TEXT PRIMARY KEY,          -- 'MOCK-PN-n' or supplied (Comdove's id)
  display_number  TEXT NOT NULL UNIQUE,      -- digits only
  label           TEXT,
  token           TEXT NOT NULL,             -- fake bearer token
  waba_id         TEXT NOT NULL,             -- webhook entry[].id; must match Comdove WabaAccount.wabaId
  created_at      INTEGER NOT NULL
);

-- Client groups (FR-15). NO lock columns — the lock lives in memory (Person 3).
CREATE TABLE IF NOT EXISTS groups (
  id          TEXT PRIMARY KEY,              -- slug of name, the ?group= value (FR-14)
  name        TEXT NOT NULL UNIQUE,
  created_at  INTEGER NOT NULL
);

-- Customer numbers = tiles. Exactly ONE group per customer.
CREATE TABLE IF NOT EXISTS customers (
  number          TEXT PRIMARY KEY,
  group_id        TEXT NOT NULL REFERENCES groups(id) ON DELETE CASCADE,
  position        INTEGER NOT NULL,          -- tile order
  label           TEXT,                      -- webhook contacts[].profile.name
  online          INTEGER NOT NULL DEFAULT 1,-- tile flag, default ONLINE
  reply_mode      TEXT NOT NULL DEFAULT 'manual' CHECK (reply_mode IN ('manual','echo','keyword')),
  reply_delay_ms  INTEGER NOT NULL DEFAULT 0 CHECK (reply_delay_ms BETWEEN 0 AND 30000),
  created_at      INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_customers_group ON customers(group_id, position);

-- Keyword map (FR-10). First match by position wins.
CREATE TABLE IF NOT EXISTS keyword_replies (
  id               INTEGER PRIMARY KEY AUTOINCREMENT,
  customer_number  TEXT NOT NULL REFERENCES customers(number) ON DELETE CASCADE,
  position         INTEGER NOT NULL,
  keyword          TEXT NOT NULL,            -- case-insensitive "contains"
  reply            TEXT NOT NULL
);

-- Pair of numbers; next_seq gives per-conversation ordering (Spec §5 / PRD §6)
CREATE TABLE IF NOT EXISTS conversations (
  id               INTEGER PRIMARY KEY AUTOINCREMENT,
  phone_number_id  TEXT NOT NULL,
  customer_number  TEXT NOT NULL,
  next_seq         INTEGER NOT NULL DEFAULT 1,
  UNIQUE (phone_number_id, customer_number)
);

-- Every message + status timeline (FR-11)
CREATE TABLE IF NOT EXISTS messages (
  wamid            TEXT PRIMARY KEY,
  conversation_id  INTEGER NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  seq              INTEGER NOT NULL,
  direction        TEXT NOT NULL CHECK (direction IN ('outbound','inbound')), -- outbound = Comdove -> tile
  source           TEXT NOT NULL CHECK (source IN ('api','tile','inject','autoreply')),
  from_number      TEXT NOT NULL,
  to_number        TEXT NOT NULL,
  body             TEXT NOT NULL,
  created_at       INTEGER NOT NULL,
  sent_at          INTEGER,
  delivered_at     INTEGER,
  read_at          INTEGER,
  UNIQUE (conversation_id, seq)
);
CREATE INDEX IF NOT EXISTS idx_messages_created ON messages(created_at DESC);

-- One row per webhook Comdove must get (Person 1 writes). Payload kept so retries
-- are byte-identical.
CREATE TABLE IF NOT EXISTS webhook_jobs (
  id               INTEGER PRIMARY KEY AUTOINCREMENT,
  conversation_id  INTEGER NOT NULL,
  wamid            TEXT NOT NULL,
  kind             TEXT NOT NULL CHECK (kind IN ('inbound','sent','delivered','read')),
  payload          TEXT NOT NULL,
  state            TEXT NOT NULL DEFAULT 'pending' CHECK (state IN ('pending','ok','failed')),
  created_at       INTEGER NOT NULL,
  finished_at      INTEGER
);
CREATE INDEX IF NOT EXISTS idx_jobs_pending ON webhook_jobs(state, conversation_id, id);

-- Every attempt + outcome (Person 1 writes, admin log reads)
CREATE TABLE IF NOT EXISTS webhook_attempts (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  job_id       INTEGER NOT NULL REFERENCES webhook_jobs(id) ON DELETE CASCADE,
  attempt      INTEGER NOT NULL,             -- 1..4
  http_status  INTEGER,
  error        TEXT,
  duration_ms  INTEGER,
  at           INTEGER NOT NULL
);
`;
