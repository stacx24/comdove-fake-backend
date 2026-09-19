import Database from 'better-sqlite3';
import { SqliteJobStore } from '../../src/webhooks/job-store.js';
import { SCHEMA_SQL } from '../../src/db/schema.js';
import { jobStoreContract } from './job-store.contract.js';

// Same contract suite as MemoryJobStore, against P2's real schema (plan Task 10).
jobStoreContract('SqliteJobStore', () => {
  const db = new Database(':memory:');
  db.exec(SCHEMA_SQL);
  return new SqliteJobStore(db);
});
