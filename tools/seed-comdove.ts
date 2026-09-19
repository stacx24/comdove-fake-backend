/**
 * seed-comdove.ts — plan §5c. Makes Comdove (wat-backend) know the mock's business numbers.
 *
 * Comdove does NOT read the WhatsApp token from env: it decrypts it from its database
 * (`WabaAccount.accessTokenEncrypted`), and it drops any webhook whose `phone_number_id`
 * it doesn't know (`UNKNOWN_PHONE_NUMBER`). So every mock business number must exist in
 * Comdove's LOCAL Postgres with the same ids and token. This script copies them there.
 *
 * It reads the mock's business numbers from its SQLite file and upserts, for each one:
 *   WabaAccount     { teamId, wabaId, connectionType SELF_HOSTED, status ACTIVE,
 *                     accessTokenEncrypted = Comdove's own encryptSecret(token) }
 *   WabaPhoneNumber { phoneNumberId, displayPhoneNumber, teamId, wabaAccountId, isRegistered }
 * using Comdove's OWN Prisma client and crypto from the wat-backend checkout, so the rows
 * always match Comdove's schema and key (no pg driver, no copied crypto).
 *
 * ── Run ──────────────────────────────────────────────────────────────────────────
 *   npm run seed-comdove                 # upsert, then verify the token decrypts
 *   npm run seed-comdove -- --dry-run    # show what would be written
 *
 * Env (all optional):
 *   COMDOVE_BACKEND_DIR   wat-backend checkout      (default ~/Projects/comdov-backend)
 *   COMDOVE_TEAM_ID       team to own the rows      (default: the oldest team)
 *   DB_PATH               the mock's SQLite file    (default ./mock.sqlite)
 *
 * The database is the one wat-backend itself uses: its .env + scripts/resolve-db.cjs
 * (DB_TARGET). The script REFUSES anything that is not localhost — never production.
 * Safe to re-run: every write is an upsert.
 */
import { createRequire } from 'node:module';
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';

interface MockBiz {
  phone_number_id: string;
  display_number: string;
  label: string | null;
  token: string;
  waba_id: string;
}

const dryRun = process.argv.includes('--dry-run');
const backendDir = path.resolve(process.env.COMDOVE_BACKEND_DIR ?? path.join(homedir(), 'Projects', 'comdov-backend'));
const mockDbPath = path.resolve(process.env.DB_PATH ?? './mock.sqlite');

function fail(message: string): never {
  console.error(`✘ ${message}`);
  process.exit(1);
}

function readMockBusinessNumbers(): MockBiz[] {
  if (!existsSync(mockDbPath)) fail(`mock database not found: ${mockDbPath} (set DB_PATH, or start the mock once)`);
  const db = new Database(mockDbPath, { readonly: true });
  try {
    return db.prepare('SELECT phone_number_id, display_number, label, token, waba_id FROM business_numbers ORDER BY created_at').all() as MockBiz[];
  } finally {
    db.close();
  }
}

/** Comdove keeps ONE token per WabaAccount, so numbers sharing a waba_id must share a token. */
function groupByWaba(numbers: MockBiz[]): Map<string, { token: string; numbers: MockBiz[] }> {
  const byWaba = new Map<string, { token: string; numbers: MockBiz[] }>();
  for (const n of numbers) {
    const g = byWaba.get(n.waba_id);
    if (!g) byWaba.set(n.waba_id, { token: n.token, numbers: [n] });
    else if (g.token !== n.token) {
      fail(`waba_id ${n.waba_id} has numbers with different tokens (${g.numbers[0].phone_number_id}, ${n.phone_number_id}); Comdove stores one token per WABA — use one token or separate waba_ids`);
    } else g.numbers.push(n);
  }
  return byWaba;
}

/** Load wat-backend's .env and let its own resolve-db.cjs pick DATABASE_URL (DB_TARGET). */
function useComdoveDatabase(require: NodeRequire): string {
  const cwd = process.cwd();
  process.chdir(backendDir); // resolve-db.cjs reads .env from the working directory
  try {
    require('dotenv').config({ path: path.join(backendDir, '.env') });
    require(path.join(backendDir, 'scripts', 'resolve-db.cjs'));
  } finally {
    process.chdir(cwd);
  }
  const url = process.env.DATABASE_URL ?? '';
  let host = '';
  try {
    host = new URL(url).hostname;
  } catch {
    fail('could not resolve Comdove DATABASE_URL from its .env');
  }
  if (!['localhost', '127.0.0.1', '::1'].includes(host)) fail(`refusing to seed a non-local database (host ${host}). Set DB_TARGET=local in wat-backend's .env.`);
  if (!process.env.WABA_TOKEN_ENCRYPTION_KEY) fail(`WABA_TOKEN_ENCRYPTION_KEY is not set in ${backendDir}/.env — Comdove could not decrypt the token`);
  return host;
}

async function main() {
  if (!existsSync(path.join(backendDir, 'package.json'))) fail(`wat-backend checkout not found at ${backendDir} (set COMDOVE_BACKEND_DIR)`);

  const numbers = readMockBusinessNumbers();
  if (numbers.length === 0) fail('the mock has no business numbers — register one with POST /api/business-numbers first');
  const byWaba = groupByWaba(numbers);

  const require = createRequire(path.join(backendDir, 'package.json'));
  const host = useComdoveDatabase(require);
  const { PrismaClient } = require('@prisma/client');
  const { encryptSecret, decryptSecret } = await import(path.join(backendDir, 'src', 'utils', 'crypto.ts'));
  const prisma = new PrismaClient();

  try {
    const team = process.env.COMDOVE_TEAM_ID
      ? await prisma.team.findUnique({ where: { id: process.env.COMDOVE_TEAM_ID }, select: { id: true, name: true } })
      : await prisma.team.findFirst({ orderBy: { createdAt: 'asc' }, select: { id: true, name: true } });
    if (!team) fail(process.env.COMDOVE_TEAM_ID ? `team ${process.env.COMDOVE_TEAM_ID} not found` : 'Comdove has no team — sign up once in the Comdove app first');

    console.log(`Comdove DB ${host} · team "${team.name}" (${team.id})${dryRun ? ' · DRY RUN' : ''}`);
    for (const [wabaId, g] of byWaba) {
      console.log(`  WabaAccount ${wabaId}`);
      for (const n of g.numbers) console.log(`    WabaPhoneNumber ${n.phone_number_id}  ${n.display_number}${n.label ? `  (${n.label})` : ''}`);
    }
    if (dryRun) return;

    let ok = 0;
    for (const [wabaId, g] of byWaba) {
      const accessTokenEncrypted = encryptSecret(g.token);
      const account = await prisma.wabaAccount.upsert({
        where: { teamId_wabaId: { teamId: team.id, wabaId } },
        create: { teamId: team.id, wabaId, connectionType: 'SELF_HOSTED', status: 'ACTIVE', accessTokenEncrypted },
        update: { status: 'ACTIVE', accessTokenEncrypted },
        select: { id: true, accessTokenEncrypted: true },
      });
      if (decryptSecret(Buffer.from(account.accessTokenEncrypted)) !== g.token) fail(`token for ${wabaId} did not decrypt back — check WABA_TOKEN_ENCRYPTION_KEY`);

      for (const n of g.numbers) {
        const owner = await prisma.wabaPhoneNumber.findUnique({ where: { phoneNumberId: n.phone_number_id }, select: { teamId: true } });
        if (owner && owner.teamId !== team.id) fail(`${n.phone_number_id} already belongs to another team (${owner.teamId}) — set COMDOVE_TEAM_ID to that team`);
        await prisma.wabaPhoneNumber.upsert({
          where: { phoneNumberId: n.phone_number_id },
          create: { wabaAccountId: account.id, teamId: team.id, phoneNumberId: n.phone_number_id, displayPhoneNumber: n.display_number, verifiedName: n.label ?? 'Mock Business', isRegistered: true },
          update: { wabaAccountId: account.id, displayPhoneNumber: n.display_number, isRegistered: true },
        });
        ok++;
      }
    }
    console.log(`✔ seeded ${ok} number(s) into Comdove; tokens verified with Comdove's own decryptSecret`);
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((err) => fail(err instanceof Error ? err.message : String(err)));
