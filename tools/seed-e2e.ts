/**
 * seed-e2e.ts — WS-343. Fills a RUNNING fake server with the data Sahil's E2E broadcast
 * needs: 5 business numbers, and one group of 100 customer numbers per business
 * (5 × 100 = 500 tiles), so each business can send 100 messages.
 *
 * ── Run ────────────────────────────────────────────────────────────────────────
 *   npm run dev              # in another terminal: the server must be up
 *   npm run seed:e2e         # → http://localhost:4020
 *
 *   npm run seed:e2e -- --dry-run          # print the plan, write nothing
 *   npm run seed:e2e -- --businesses 2 --per-group 10     # smaller run
 *   BASE_URL=https://testserver.stacx24.com UI_USER=comdove UI_PASSWORD=comdove \
 *     npm run seed:e2e                     # the deployed server (Caddy basic auth)
 *
 * Safe to re-run: anything that already exists comes back 409 and is counted as
 * "existing", never an error. Nothing is ever deleted — to start clean, first call
 * POST /api/reset {"keep_numbers": false}.
 *
 * Numbers are deterministic, so Comdove can be seeded to match:
 *   business i (1..5)  display 91800000000i   phone_number_id E2E_PH_i   waba_id E2E_WABA_i
 *   group i            e2e-businessi          919{i}00000001 … +100
 * After this, run `npm run seed-comdove` so wat-backend knows the same business numbers.
 */
const BASE_URL = (process.env.BASE_URL ?? `http://localhost:${process.env.PORT ?? 4020}`).replace(/\/$/, '');
const USER = process.env.UI_USER ?? '';
const PASSWORD = process.env.UI_PASSWORD ?? '';

const args = process.argv.slice(2);
const flag = (name: string): boolean => args.includes(`--${name}`);
const option = (name: string, fallback: number): number => {
  const i = args.indexOf(`--${name}`);
  if (i === -1) return fallback;
  const value = Number(args[i + 1]);
  if (!Number.isInteger(value) || value < 1) fail(`--${name} needs a positive whole number`);
  return value;
};

const dryRun = flag('dry-run');
const businesses = option('businesses', 5);
const perGroup = option('per-group', 100);

function fail(message: string): never {
  console.error(`✘ ${message}`);
  process.exit(1);
}

/** 918000000001…, one per business. */
const businessNumber = (i: number) => `9180000000${String(i).padStart(2, '0')}`;
/** Group i gets its own block of customers: 919100000001…, 919200000001…, … */
const customerNumbers = (i: number, count: number) =>
  Array.from({ length: count }, (_, k) => String(919000000000 + i * 100000000 + k + 1));

interface Result {
  created: number;
  existing: number;
}

async function post(path: string, body: unknown): Promise<{ status: number; text: string }> {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (USER) headers.Authorization = `Basic ${Buffer.from(`${USER}:${PASSWORD}`).toString('base64')}`;
  const res = await fetch(BASE_URL + path, { method: 'POST', headers, body: JSON.stringify(body) });
  return { status: res.status, text: await res.text() };
}

/** 200 = created, 409 = already there (both fine); anything else stops the run. */
async function create(label: string, path: string, body: unknown, into: Result): Promise<void> {
  if (dryRun) {
    console.log(`  would create ${label}`);
    into.created++;
    return;
  }
  const { status, text } = await post(path, body);
  if (status === 200) {
    into.created++;
    console.log(`  ✓ ${label}`);
    return;
  }
  if (status === 409) {
    into.existing++;
    console.log(`  · ${label} (already there)`);
    return;
  }
  fail(`${label}: HTTP ${status} ${text.slice(0, 200)}`);
}

async function main(): Promise<void> {
  console.log(`comdove-fake seed → ${BASE_URL}`);
  console.log(`  ${businesses} business numbers, ${perGroup} customers each = ${businesses * perGroup} tiles`);
  if (dryRun) console.log('  (dry run: nothing is written)\n');

  if (!dryRun) {
    const res = await fetch(`${BASE_URL}/health`).catch(() => null);
    if (!res?.ok) fail(`no fake server at ${BASE_URL} — start it with "npm run dev"`);
  }

  const numbers: Result = { created: 0, existing: 0 };
  const groups: Result = { created: 0, existing: 0 };

  for (let i = 1; i <= businesses; i++) {
    const display = businessNumber(i);
    const group = `e2e-business${i}`;
    console.log(`\nBusiness ${i}: ${display} → group "${group}" (${perGroup} numbers)`);
    await create(`business ${display}`, '/api/business-numbers', {
      display_number: display,
      label: `E2E Business ${i}`,
      phone_number_id: `E2E_PH_${i}`,
      waba_id: `E2E_WABA_${i}`,
      token: `e2e-token-${i}`,
    }, numbers);
    await create(`group ${group}`, '/api/groups', {
      name: group,
      numbers: customerNumbers(i, perGroup),
    }, groups);
  }

  console.log(
    `\nDone. Business numbers: ${numbers.created} created, ${numbers.existing} already there. ` +
      `Groups: ${groups.created} created, ${groups.existing} already there.`,
  );
  console.log('Next:');
  console.log(`  open   ${BASE_URL}/client  → pick a group to bring its 100 tiles online`);
  console.log('  comdove: npm run seed-comdove   (copies these business numbers into wat-backend)');
}

main().catch((err) => fail(err instanceof Error ? err.message : String(err)));
