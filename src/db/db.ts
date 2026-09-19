import Database from 'better-sqlite3';
import { env } from '../config/env.js';
import { SCHEMA_SQL } from './schema.js';

// Single SQLite connection for the whole app. The file survives restarts, so
// chat history + queues persist (BACKEND-BUILD-PLAN §6).
export const db = new Database(env.DB_PATH);
db.pragma('journal_mode = WAL');

// Run the schema on boot. CREATE TABLE IF NOT EXISTS makes this safe to re-run.
db.exec(SCHEMA_SQL);

export function now(): number {
  return Date.now();
}
