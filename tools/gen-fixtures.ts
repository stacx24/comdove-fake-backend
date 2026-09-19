// npm run fixtures — writes fixtures/ for the UI team (TEAM-SPLIT Person 2, task 7).
//
// Boots the REAL app (P2 store + control API, P1 Meta face, P3 /ws) on an in-memory
// database with a fake Comdove, a browser tab and an admin page, runs one scripted
// session that covers every /api row of TEAM-SPLIT (incl. error cases) and the /ws events
// the UI receives, and saves each response. Nothing is hand-written, so the fixtures match
// the code. wamids and timestamps are replaced by stable values so re-running gives the
// same files; test/fixtures.test.ts fails if the API shape drifts from the saved files.
import { mkdirSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

export interface ApiFixture {
  request: { method: string; path: string; body?: unknown };
  status: number;
  body: unknown;
}
export type Fixtures = { api: Record<string, ApiFixture>; ws: Record<string, unknown> };

const BIZ = '918888800001';
const T1 = '919876543210';
const T2 = '919876543211';
const T3 = '919876543220';

export async function generateFixtures(): Promise<Fixtures> {
  process.env.DB_PATH = ':memory:'; // before db.ts is first imported
  const { composeServer } = await import('../src/compose.js');
  const { createFakeComdove } = await import('./fake-comdove-app.js');
  const { listen, waitFor } = await import('../test/helpers/http.js');
  const { wsClient } = await import('../test/helpers/ws-client.js');

  const comdove = createFakeComdove({ appSecret: 'fixtures-secret', verifyToken: 'fixtures-verify' });
  const c = await listen(comdove.app);
  const composed = composeServer({
    env: { COMDOVE_WEBHOOK_URL: `${c.base}/webhooks/whatsapp`, APP_SECRET: 'fixtures-secret', WEBHOOK_VERIFY_TOKEN: 'fixtures-verify', STATUS_WEBHOOK_DELAY_MS: 0 },
    dispatcher: { retryDelaysMs: [10, 10, 10], timeoutMs: 1000 },
    log: () => {},
  });
  const m = await listen(composed.app);
  const wss = composed.live.attach(m.server, { heartbeatMs: 60_000 });
  const wsUrl = `${m.base.replace('http', 'ws')}/ws`;

  const api: Record<string, ApiFixture> = {};
  const ws: Record<string, unknown> = {};
  async function call(name: string, method: string, p: string, body?: unknown, headers: Record<string, string> = {}) {
    const res = await fetch(m.base + p, {
      method,
      headers: { 'Content-Type': 'application/json', ...headers },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await res.text();
    const fixture: ApiFixture = { request: { method, path: p, ...(body !== undefined && { body }) }, status: res.status, body: text ? JSON.parse(text) : null };
    if (name) api[name] = fixture;
    return fixture;
  }
  const comdoveSend = async (to: string, text: string) =>
    ((await call('', 'POST', '/v23.0/PN-1/messages', { messaging_product: 'whatsapp', to, type: 'text', text: { body: text } }, { Authorization: 'Bearer tok-1' })).body as any).messages[0].id as string;
  const settle = () => composed.metaFace.dispatcher.idle();

  try {
    // --- numbers, groups, admin page ------------------------------------------------
    await call('business-numbers.post', 'POST', '/api/business-numbers', { display_number: BIZ, label: 'Sales', phone_number_id: 'PN-1', waba_id: 'WABA-1', token: 'tok-1' });
    await call('business-numbers.post.generated-ids', 'POST', '/api/business-numbers', { display_number: '918888800002', label: 'Support' });
    await call('business-numbers.post.400', 'POST', '/api/business-numbers', { display_number: '12' });
    await call('groups.post', 'POST', '/api/groups', { name: 'alpha', numbers: [T1, '+91 98765-43211'], labels: { [T1]: 'Asha' } });
    await call('', 'POST', '/api/groups', { name: 'beta', numbers: [T3] });
    await call('groups.post.400', 'POST', '/api/groups', { name: 'gamma', numbers: ['abc'] });
    await call('groups.post.409', 'POST', '/api/groups', { name: 'gamma', numbers: [T1] });

    const admin = await wsClient(wsUrl);
    admin.send({ type: 'admin.subscribe' });
    await admin.next('numbers.update');
    await call('webhook-verify.post', 'POST', '/api/webhook/verify');
    ws['admin.webhook.verify'] = await admin.next('webhook.verify');

    // --- a message while the group is closed → queued, then the tab opens ------------
    await comdoveSend(T1, 'Your order is packed');
    await settle();
    const tab = await wsClient(wsUrl);
    tab.send({ type: 'group.claim', group: 'alpha' });
    ws['group.claimed'] = await tab.next('group.claimed');
    ws['admin.groups.update'] = await admin.next('groups.update', (f) => f.groups.some((g: any) => g.id === 'alpha' && g.status === 'locked'));
    ws['message.status.delivered'] = await tab.next('message.status', (f) => f.status === 'delivered');
    const other = await wsClient(wsUrl);
    other.send({ type: 'group.claim', group: 'alpha' });
    ws['group.locked'] = await other.next('group.locked');
    await other.close();

    await call('groups.get', 'GET', '/api/groups');
    await call('groups.delete.409', 'DELETE', '/api/groups/alpha');
    await call('customers.get', 'GET', '/api/customers');

    // --- live traffic -------------------------------------------------------------------
    const live = await comdoveSend(T1, 'It ships tomorrow');
    ws['message.new.outbound'] = await tab.next('message.new', (f) => f.message.wamid === live);
    await tab.next('message.status', (f) => f.wamid === live && f.status === 'delivered');
    tab.send({ type: 'chat.read', number: T1, peer: BIZ });
    ws['message.status.read'] = await tab.next('message.status', (f) => f.wamid === live && f.status === 'read');
    tab.send({ type: 'message.send', from: T1, to: BIZ, body: 'Thanks! What time?' });
    ws['message.new.inbound'] = await tab.next('message.new', (f) => f.message.direction === 'inbound');
    await call('inject.post', 'POST', '/api/inject', { from: T1, to: BIZ, body: 'Can I pay cash?' });
    await call('inject.post.400', 'POST', '/api/inject', { from: '911111111111', to: BIZ, body: 'x' });

    await call('presence.post', 'POST', '/api/presence', { number: T2, online: false });
    ws['tile.presence'] = await tab.next('tile.presence');
    await comdoveSend(T2, 'Are you there?');
    await settle();
    await call('', 'POST', '/api/presence', { number: T2, online: true });
    ws['queue.flush'] = await tab.next('queue.flush');

    await call('auto-reply.put', 'PUT', `/api/customers/${T1}/auto-reply`, { mode: 'keyword', delay_ms: 0, rules: [{ keyword: 'price', reply: 'What is the price?' }] });
    ws['tile.autoreply'] = await tab.next('tile.autoreply');
    await call('auto-reply.get', 'GET', `/api/customers/${T1}/auto-reply`);
    await call('auto-reply.put.400', 'PUT', `/api/customers/${T1}/auto-reply`, { mode: 'robot' });
    await comdoveSend(T1, 'Our price list is attached');
    await tab.next('message.new', (f) => f.message.direction === 'inbound' && f.message.body === 'What is the price?');

    tab.send({ type: 'message.send', from: '919999999999', to: BIZ, body: 'x' });
    ws['error.number_not_in_group'] = await tab.next('error');

    await call('', 'POST', '/v23.0/PN-1/messages', { messaging_product: 'whatsapp', to: T1, type: 'text', text: { body: 'wrong token' } }, { Authorization: 'Bearer WRONG' });
    ws['admin.log.entry.rejected'] = await admin.next('log.entry', (f) => f.entry.direction === 'rejected');

    await settle();
    await waitFor(() => comdove.received.length >= 8);
    const firstEntry = admin.all('log.entry').find((f) => f.entry.direction === 'outbound' && f.entry.body === 'It ships tomorrow');
    ws['admin.log.entry'] = firstEntry;
    ws['admin.log.update'] = admin.all('log.update').filter((f) => f.entry.wamid === live).at(-1);
    ws['admin.numbers.update'] = admin.all('numbers.update').at(-1);

    await call('log.get', 'GET', '/api/log?limit=100');
    await call('status.get', 'GET', '/api/status');
    await call('business-numbers.get', 'GET', '/api/business-numbers');

    // --- deletes, resets, errors ----------------------------------------------------------
    await call('business-numbers.delete', 'DELETE', '/api/business-numbers/MOCK-PN-2');
    await call('business-numbers.delete.404', 'DELETE', '/api/business-numbers/NOPE');
    await call('groups.delete', 'DELETE', '/api/groups/beta');
    await call('groups.delete.404', 'DELETE', '/api/groups/nope');
    await call('unknown-endpoint.404', 'GET', '/api/nope');

    await call('reset.post', 'POST', '/api/reset', {});
    ws['group.claimed.after-reset'] = await tab.next('group.claimed');
    ws['admin.log.reset'] = await admin.next('log.reset');
    await call('reset-alias.post', 'POST', '/reset', {});
    await call('reset.post.wipe', 'POST', '/api/reset', { keep_numbers: false });
    ws['error.group_deleted'] = await tab.next('error', (f) => f.code === 'group_deleted');

    await admin.close();
    await tab.close();
  } finally {
    composed.metaFace.dispatcher.cancelAll();
    await wss.close();
    await m.close();
    await c.close();
  }
  return stabilize({ api, ws });
}

// --- stable values: wamids and times get fixed stand-ins, keeping their order ------------
const TIME_KEYS = new Set(['time', 'at', 'created_at', 'since', 'locked_since', 'finished_at']);

function stabilize(f: Fixtures): Fixtures {
  const wamids = new Map<string, string>();
  const times = new Set<number>();
  const traces = new Map<string, string>();
  const walk = (v: unknown, visit: (key: string, value: unknown) => unknown, key = ''): unknown => {
    if (Array.isArray(v)) return v.map((x) => walk(x, visit, key));
    if (v && typeof v === 'object') return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, walk(x, visit, k)]));
    return visit(key, v);
  };
  walk(f, (k, v) => {
    if (typeof v === 'string' && /^wamid\.MOCK-[0-9a-f]{24}$/.test(v) && !wamids.has(v)) wamids.set(v, `wamid.MOCK-${String(wamids.size + 1).padStart(24, '0')}`);
    if (typeof v === 'number' && TIME_KEYS.has(k)) times.add(v);
    if (typeof v === 'string' && /^MOCK-trace-\d{6}$/.test(v) && !traces.has(v)) traces.set(v, `MOCK-trace-${String(traces.size + 1).padStart(6, '0')}`);
    return v;
  });
  const sorted = [...times].sort((a, b) => a - b);
  const BASE = 1758270000000; // 2025-09-19T08:20:00Z
  const timeOf = new Map(sorted.map((t, i) => [t, BASE + i * 1000]));
  const out = walk(f, (k, v) => {
    if (typeof v === 'string' && wamids.has(v)) return wamids.get(v);
    if (typeof v === 'string' && traces.has(v)) return traces.get(v);
    if (typeof v === 'number' && TIME_KEYS.has(k)) return timeOf.get(v);
    if (typeof v === 'number' && k === 'duration_ms') return 12;
    if (typeof v === 'number' && k === 'uptime') return 42;
    if (typeof v === 'string' && k === 'comdove_webhook_url') return 'http://localhost:3000/webhooks/whatsapp'; // not the dev's .env
    if (typeof v === 'string' && k === 'token' && v.startsWith('mock-token-') && v !== 'mock-token-dev') return 'mock-token-3f9c2a1b7e4d';
    return v;
  });
  return out as Fixtures;
}

// --- writing ---------------------------------------------------------------------------------
export const FIXTURES_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'fixtures');

export function writeFixtures(f: Fixtures, dir = FIXTURES_DIR) {
  for (const sub of ['api', 'ws']) {
    mkdirSync(path.join(dir, sub), { recursive: true });
    for (const old of readdirSync(path.join(dir, sub))) if (old.endsWith('.json')) rmSync(path.join(dir, sub, old));
  }
  for (const [name, fx] of Object.entries(f.api)) writeFileSync(path.join(dir, 'api', `${name}.json`), JSON.stringify(fx, null, 2) + '\n');
  for (const [name, frame] of Object.entries(f.ws)) writeFileSync(path.join(dir, 'ws', `${name}.json`), JSON.stringify(frame, null, 2) + '\n');
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  generateFixtures()
    .then((f) => {
      writeFixtures(f);
      console.log(`✔ wrote ${Object.keys(f.api).length} API and ${Object.keys(f.ws).length} WebSocket fixtures to ${FIXTURES_DIR}`);
      process.exit(0);
    })
    .catch((err) => {
      console.error('✘ fixture generation failed:', err);
      process.exit(1);
    });
}
