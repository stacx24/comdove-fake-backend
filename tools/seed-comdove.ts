/**
 * seed-comdove.ts — plan §5c (Person 2).
 *
 * Comdove (wat-backend) does NOT read the WhatsApp token from env — it reads it
 * from its DATABASE (`WabaAccount.accessTokenEncrypted`), and it drops any inbound
 * webhook whose `phone_number_id` it doesn't know (`UNKNOWN_PHONE_NUMBER`,
 * process-event.ts:214-229). So before the demo, every mock business number must
 * exist in Comdove's LOCAL Postgres with the SAME ids + token.
 *
 * This script reads the mock's business numbers from mock.sqlite and upserts them
 * into Comdove's local Postgres.
 *
 * ── Run ──────────────────────────────────────────────────────────────────────
 *   COMDOVE_DATABASE_URL=postgres://user:pass@localhost:5432/watdb \
 *   COMDOVE_TEAM_ID=<a team id in that DB> \
 *   npx tsx tools/seed-comdove.ts
 *
 * ⚠ Requires two things wired in (kept out of the mock's runtime deps on purpose):
 *   1. `pg` installed:  npm i -D pg @types/pg
 *   2. wat-backend's token encryption. Comdove decrypts with src/utils/crypto.ts
 *      `decryptSecret`, so the token MUST be written with the matching
 *      `encryptSecret`. Import it from the wat-backend checkout (adjust the path)
 *      or copy the util. Do NOT hand-roll it — a mismatch fails silently at send.
 *
 * Alternative (no encryption needed): register mock numbers with Comdove's EXISTING
 * ids/token via `POST /api/business-numbers {phone_number_id, waba_id, token}` — then
 * no DB write is needed at all (plan §5c way A).
 *
 * NEVER point COMDOVE_DATABASE_URL at production RDS.
 */

import Database from 'better-sqlite3';

// import { Client } from 'pg';                          // ← after: npm i -D pg
// import { encryptSecret } from '<wat-backend>/src/utils/crypto';  // ← adjust path

interface MockBiz {
  phone_number_id: string;
  display_number: string;
  token: string;
  waba_id: string;
}

function readMockBusinessNumbers(dbPath = process.env.DB_PATH ?? './mock.sqlite'): MockBiz[] {
  const db = new Database(dbPath, { readonly: true });
  return db
    .prepare('SELECT phone_number_id, display_number, token, waba_id FROM business_numbers')
    .all() as MockBiz[];
}

async function main() {
  const url = process.env.COMDOVE_DATABASE_URL;
  const teamId = process.env.COMDOVE_TEAM_ID;
  if (!url || !teamId) {
    console.error('Set COMDOVE_DATABASE_URL and COMDOVE_TEAM_ID (local Postgres, never prod).');
    process.exit(1);
  }
  if (/rds\.amazonaws\.com/i.test(url)) {
    console.error('Refusing to run against what looks like production RDS.');
    process.exit(1);
  }

  const numbers = readMockBusinessNumbers();
  console.log(`Found ${numbers.length} mock business number(s):`);
  for (const n of numbers) console.log(`  ${n.phone_number_id}  ${n.display_number}  waba=${n.waba_id}`);

  console.log(`
TODO to finish (see header):
  1. npm i -D pg @types/pg
  2. wire encryptSecret from the wat-backend checkout
  3. for each number, upsert into Comdove Postgres:
       WabaAccount     { wabaId, accessTokenEncrypted = encryptSecret(token), teamId=${teamId} }
       WabaPhoneNumber { phoneNumberId, displayPhoneNumber, teamId=${teamId}, wabaAccountId }
`);
  // Pseudocode once pg + encryptSecret are wired:
  //   const c = new Client({ connectionString: url }); await c.connect();
  //   for (const n of numbers) {
  //     const acc = await c.query(
  //       `INSERT INTO "WabaAccount"(id,"wabaId","accessTokenEncrypted","teamId")
  //        VALUES (gen_random_uuid()::text,$1,$2,$3)
  //        ON CONFLICT ("wabaId") DO UPDATE SET "accessTokenEncrypted"=EXCLUDED."accessTokenEncrypted"
  //        RETURNING id`, [n.waba_id, encryptSecret(n.token), teamId]);
  //     await c.query(
  //       `INSERT INTO "WabaPhoneNumber"(id,"phoneNumberId","displayPhoneNumber","teamId","wabaAccountId")
  //        VALUES (gen_random_uuid()::text,$1,$2,$3,$4)
  //        ON CONFLICT ("phoneNumberId") DO UPDATE SET "wabaAccountId"=EXCLUDED."wabaAccountId"`,
  //       [n.phone_number_id, n.display_number, teamId, acc.rows[0].id]);
  //   }
  //   await c.end();
}

main().catch((e) => { console.error(e); process.exit(1); });
