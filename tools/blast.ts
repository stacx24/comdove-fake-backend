/**
 * blast.ts — WS-343. Sends messages from the seeded business numbers to their own
 * customer numbers **through Comdove**, so they show up in the Comdove inbox.
 *
 *   blast → Comdove POST /waba/accounts/:id/send-message → the fake server
 *              │
 *              └─ Comdove stores WaContact + WaConversation + WaMessage → inbox
 *
 * An earlier version posted straight at the fake server's Meta endpoint
 * (`/v23.0/E2E_PH_1/messages`). That works, but it impersonates Comdove instead of
 * driving it: Comdove never learns about those messages, so the only webhook it gets
 * back is a *status* callback for a wamid it has no record of, and the inbox stays
 * empty. Sending through Comdove is what makes the run end-to-end.
 *
 * ── Run ────────────────────────────────────────────────────────────────────────
 *   npm run blast                     # business 1 → its 100 numbers
 *   npm run blast -- --all            # all 5 businesses → 500 messages
 *   npm run blast -- --business 3     # business 3 → its 100 numbers
 *   npm run blast -- --count 10       # the first 10 numbers only
 *   npm run blast -- --dry-run        # print the plan, send nothing
 *
 *   npm run blast -- --template hello_world --language en
 *   npm run blast -- --vars "Nandha,10%"        # body variables {{1}},{{2}}
 *   npm run blast -- --business 3 --number-offset 900   # 100 sends that must all fail
 *
 * ── Comdove connection ─────────────────────────────────────────────────────────
 *   COMDOVE_URL       default http://localhost:3000
 *   COMDOVE_EMAIL     login (or set COMDOVE_TOKEN and skip the login call)
 *   COMDOVE_PASSWORD
 *   COMDOVE_TOKEN     a bearer token, used as-is when set
 *
 * Needs `npm run seed:e2e` (the fake server's numbers) and `npm run seed-comdove`
 * (so Comdove knows the same business numbers). A cold send has to be a template —
 * that is WhatsApp's rule, not ours: free text is only allowed inside an open
 * 24-hour customer-service window, which a first contact does not have.
 */
const COMDOVE_URL = (process.env.COMDOVE_URL ?? 'http://localhost:3000').replace(/\/$/, '');
const EMAIL = process.env.COMDOVE_EMAIL ?? 'admin@example.com';
const PASSWORD = process.env.COMDOVE_PASSWORD ?? 'Password123!';
const TOKEN = process.env.COMDOVE_TOKEN ?? '';

/** Sent in small batches, paced under Comdove's per-number governor (80/sec by default). */
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

/** Shifts the generated customer numbers out of the seeded block, so they are
 *  unknown to the fake server and every send comes back undeliverable. Used to
 *  make one business fail on purpose in a blast-radius run. */
const numberOffset = (() => {
  const raw = value('number-offset');
  if (raw === undefined) return 0;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 0) fail('--number-offset needs a whole number >= 0');
  return n;
})();

const business = whole('business', 1);
const count = whole('count', 100);
const rate = whole('rate', 40);
const template = value('template') ?? 'hello_world';
const language = value('language') ?? 'en';
const vars = (value('vars') ?? '').split(',').map((v) => v.trim()).filter(Boolean);
const dryRun = has('dry-run');
const businesses = has('all') ? [1, 2, 3, 4, 5] : [business];

/** Same numbering as seed-e2e.ts: business i owns 919{i}00000001 … +100. */
const customerNumbers = (i: number, n: number) =>
  Array.from({ length: n }, (_, k) => String(919000000000 + i * 100000000 + k + 1 + numberOffset));

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Comdove's phone_number_id for business i, as seed-e2e.ts creates it. */
const phoneNumberIdFor = (i: number) => `E2E_PH_${i}`;

async function login(): Promise<string> {
  if (TOKEN) return TOKEN;
  const res = await fetch(`${COMDOVE_URL}/api/v1/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: EMAIL, password: PASSWORD }),
  });
  if (!res.ok) {
    fail(
      `could not log in to Comdove at ${COMDOVE_URL} (HTTP ${res.status}). ` +
        'Set COMDOVE_EMAIL / COMDOVE_PASSWORD, or COMDOVE_TOKEN.',
    );
  }
  const body = (await res.json()) as { data?: { token?: string } };
  const token = body.data?.token;
  if (!token) fail('Comdove login succeeded but returned no token');
  return token;
}

interface Sender {
  accountId: string;
  phoneNumberId: string;
  displayPhoneNumber: string;
}

/** Maps each phone_number_id Comdove knows to the WabaAccount that owns it. */
async function loadSenders(token: string): Promise<Map<string, Sender>> {
  const res = await fetch(`${COMDOVE_URL}/api/v1/waba/accounts`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!res.ok) fail(`could not list Comdove WABA accounts (HTTP ${res.status})`);
  const body = (await res.json()) as {
    data?: {
      wabaAccounts?: Array<{
        id: string;
        phoneNumbers?: Array<{ phoneNumberId: string; displayPhoneNumber: string }>;
      }>;
    };
  };

  const senders = new Map<string, Sender>();
  for (const account of body.data?.wabaAccounts ?? []) {
    for (const phone of account.phoneNumbers ?? []) {
      senders.set(phone.phoneNumberId, {
        accountId: account.id,
        phoneNumberId: phone.phoneNumberId,
        displayPhoneNumber: phone.displayPhoneNumber,
      });
    }
  }
  return senders;
}

async function send(token: string, sender: Sender, to: string): Promise<string | null> {
  const res = await fetch(`${COMDOVE_URL}/api/v1/waba/accounts/${sender.accountId}/send-message`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
    body: JSON.stringify({
      phoneNumberId: sender.phoneNumberId,
      to: `+${to}`,
      templateName: template,
      languageCode: language,
      // Only send a components block when the template actually takes variables.
      ...(vars.length > 0 && {
        components: [{ type: 'body', parameters: vars.map((text) => ({ type: 'text', text })) }],
      }),
    }),
  });
  if (res.ok) return null;
  const text = (await res.text()).slice(0, 160);
  return `HTTP ${res.status} ${text}`;
}

async function main(): Promise<void> {
  const total = businesses.length * count;
  console.log(`blast → Comdove ${COMDOVE_URL}`);
  console.log(`  business ${businesses.join(', ')} × ${count} numbers = ${total} messages`);
  console.log(`  template "${template}" (${language})${vars.length ? ` vars: ${vars.join(', ')}` : ''}\n`);

  if (dryRun) {
    for (const i of businesses) {
      const numbers = customerNumbers(i, count);
      console.log(`  business ${i} (${phoneNumberIdFor(i)}): ${numbers[0]} … ${numbers[numbers.length - 1]}`);
    }
    console.log('\nDry run — nothing sent.');
    return;
  }

  const token = await login();
  const senders = await loadSenders(token);

  // Fail before sending anything if Comdove does not know one of the numbers —
  // otherwise half the run succeeds and the rest 404s.
  const missing = businesses.map(phoneNumberIdFor).filter((id) => !senders.has(id));
  if (missing.length) {
    fail(
      `Comdove does not know ${missing.join(', ')}. ` +
        'Run `npm run seed-comdove` so it has the same business numbers as the fake server.',
    );
  }

  const started = Date.now();
  let sent = 0;
  const problems = new Map<string, number>();

  for (const i of businesses) {
    const sender = senders.get(phoneNumberIdFor(i))!;
    const numbers = customerNumbers(i, count);

    for (let start = 0; start < numbers.length; start += BATCH) {
      const batch = numbers.slice(start, start + BATCH);
      const batchStarted = Date.now();
      const results = await Promise.all(batch.map((to) => send(token, sender, to)));
      for (const problem of results) {
        if (problem === null) sent++;
        else problems.set(problem, (problems.get(problem) ?? 0) + 1);
      }
      // Stay under the governor: a burst above the per-number limit comes back as
      // a throttle, and those messages are simply not sent.
      const owed = (batch.length / rate) * 1000 - (Date.now() - batchStarted);
      if (owed > 0) await sleep(owed);
    }
    console.log(`  business ${i} (${sender.displayPhoneNumber}): ${count} message(s) attempted`);
  }

  const seconds = ((Date.now() - started) / 1000).toFixed(1);
  console.log(`\nSent ${sent}/${total} through Comdove in ${seconds}s.`);
  for (const [problem, n] of problems) console.log(`  ${n}× ${problem}`);
  if (problems.size) process.exitCode = 1;
  console.log('Watch them in the Comdove inbox, and in the fake server admin log.');
}

main().catch((err) => fail(err instanceof Error ? err.message : String(err)));
