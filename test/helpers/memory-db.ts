// Import FIRST in any test that touches P2's SQLite store: db.ts opens DB_PATH at import
// time, and dotenv never overrides an already-set variable. Each test file runs in its
// own process, so every file gets a fresh in-memory database.
process.env.DB_PATH = ':memory:';
