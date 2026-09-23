/**
 * blast.ts — WS-343. Sends messages from the seeded business numbers to their own
 * customer numbers, through the mock's Meta endpoint (exactly as Comdove would).
 *
 *   npm run blast                     # business 1 → its 100 numbers
 *   npm run blast -- --all            # all 5 businesses → 500 messages
 *   npm run blast -- --business 3     # business 3 → its 100 numbers
 *   npm run blast -- --count 10       # the first 10 numbers only
 *   npm run blast -- --text "hello"   # custom message body
 *
 *   BASE_URL=https://testserver.stacx24.com npm run blast   # the deployed server
 *
 * Needs the numbers from `npm run seed:e2e`. Sends in small batches so the server and
 * its webhook queue stay responsive.
 */
const BASE_URL = (process.env.BASE_URL ?? `http://localhost:${process.env.PORT ?? 4020}`).replace(/\/$/, '');
const API_VERSION = process.env.META_API_VERSION ?? 'v23.0';
const BATCH = 20;

const args = process.argv.slice(2);
const has = (name: string) => args.includes(`--${name}`);
const value = (name: string): string | undefined => {
  const i = args.indexOf(`--${name}`);
  return i === -1 ? undefined : args[i + 1];
};

function fail(message: string): never {
  console.error(`✘ ${message}`);
  process.exit(1);
}

const whole = (name: string, fallback: number): number => {
  const raw = value(name);
  if (raw === undefined) return fallback;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 1) fail(`--${name} needs a positive whole number`);
  return n;
};

const business = whole('business', 1);
const count = whole('count', 100);
const text = value('text') ?? 'WS-343 broadcast test';
const businesses = has('all') ? [1, 2, 3, 4, 5] : [business];

/** Same numbering as seed-e2e.ts: business i owns 919{i}00000001 … +100. */
const customerNumbers = (i: number, n: number) =>
  Array.from({ length: n }, (_, k) => String(919000000000 + i * 100000000 + k + 1));

async function send(i: number, to: string, body: string): Promise<string | null> {
  const res = await fetch(`${BASE_URL}/${API_VERSION}/E2E_PH_${i}/messages`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer e2e-token-${i}` },
    body: JSON.stringify({ messaging_product: 'whatsapp', to, type: 'text', text: { body } }),
  });
  if (res.ok) return null;
  return `HTTP ${res.status} ${(await res.text()).slice(0, 160)}`;
}

async function main(): Promise<void> {
  const total = businesses.length * count;
  console.log(`blast → ${BASE_URL}`);
  console.log(`  business ${businesses.join(', ')} × ${count} numbers = ${total} messages\n`);

  const started = Date.now();
  let sent = 0;
  const problems = new Map<string, number>();

  for (const i of businesses) {
    const numbers = customerNumbers(i, count);
    for (let start = 0; start < numbers.length; start += BATCH) {
      const batch = numbers.slice(start, start + BATCH);
      const results = await Promise.all(batch.map((to) => send(i, to, `${text} (${to})`)));
      for (const problem of results) {
        if (problem === null) sent++;
        else problems.set(problem, (problems.get(problem) ?? 0) + 1);
      }
    }
    console.log(`  business ${i}: ${count} message(s) sent`);
  }

  const seconds = ((Date.now() - started) / 1000).toFixed(1);
  console.log(`\nSent ${sent}/${total} in ${seconds}s.`);
  for (const [problem, n] of problems) console.log(`  ${n}× ${problem}`);
  if (problems.size) process.exitCode = 1;
  console.log(`Watch them in the admin log: ${BASE_URL}/admin`);
}

main().catch((err) => fail(err instanceof Error ? err.message : String(err)));
