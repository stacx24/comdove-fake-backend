// The UI team builds against fixtures/ (TEAM-SPLIT Person 2, task 7). This test regenerates
// them from the real app and fails if the saved files no longer match the API's shape or
// status codes — run `npm run fixtures` and commit the result when an API change is intended.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { generateFixtures, FIXTURES_DIR, type Fixtures } from '../tools/gen-fixtures.js';

/** Keys and value types only: values (ids, times, texts) may differ, the shape may not. */
function skeleton(v: unknown): unknown {
  if (v === null) return 'null';
  if (Array.isArray(v)) {
    const shapes = [...new Set(v.map((x) => JSON.stringify(skeleton(x))))].sort();
    return shapes.map((s) => JSON.parse(s));
  }
  if (typeof v === 'object') return Object.fromEntries(Object.keys(v as object).sort().map((k) => [k, skeleton((v as Record<string, unknown>)[k])]));
  return typeof v;
}

function readSaved(): Fixtures {
  const read = (sub: string) =>
    Object.fromEntries(
      readdirSync(path.join(FIXTURES_DIR, sub))
        .filter((f) => f.endsWith('.json'))
        .map((f) => [f.replace(/\.json$/, ''), JSON.parse(readFileSync(path.join(FIXTURES_DIR, sub, f), 'utf8'))]),
    );
  return { api: read('api'), ws: read('ws') } as Fixtures;
}

test('saved fixtures match a fresh run of the real app (shape + status codes)', { timeout: 60_000 }, async () => {
  const fresh = await generateFixtures();
  const saved = readSaved();
  assert.deepEqual(Object.keys(saved.api).sort(), Object.keys(fresh.api).sort(), 'API fixture set changed — run npm run fixtures');
  assert.deepEqual(Object.keys(saved.ws).sort(), Object.keys(fresh.ws).sort(), 'WebSocket fixture set changed — run npm run fixtures');
  for (const [name, fx] of Object.entries(fresh.api)) {
    assert.equal(saved.api[name].status, fx.status, `${name}: status changed — run npm run fixtures`);
    assert.deepEqual(skeleton(saved.api[name].body), skeleton(fx.body), `${name}: response shape changed — run npm run fixtures`);
  }
  for (const [name, frame] of Object.entries(fresh.ws)) {
    assert.deepEqual(skeleton(saved.ws[name]), skeleton(frame), `ws ${name}: frame shape changed — run npm run fixtures`);
  }
});

test('every control-API row of TEAM-SPLIT has a fixture', () => {
  const saved = readSaved();
  const covered = new Set(Object.values(saved.api).map((f) => `${f.request.method} ${f.request.path.replace(/\?.*$/, '')}`));
  const ok = (name: string, want: number) => assert.equal(saved.api[name]?.status, want, `${name} should be ${want}`);
  ok('business-numbers.delete', 204); // the happy-path fixtures really are happy paths
  ok('groups.delete', 204);
  ok('business-numbers.post', 200);
  ok('groups.post', 200);
  const rows = [
    'POST /api/business-numbers', 'GET /api/business-numbers', 'DELETE /api/business-numbers/MOCK-PN-1',
    'POST /api/groups', 'GET /api/groups', 'DELETE /api/groups/beta',
    'GET /api/customers', 'POST /api/presence', 'POST /api/inject', 'GET /api/log',
    'POST /api/reset', 'POST /reset',
    'GET /api/customers/919876543210/auto-reply', 'PUT /api/customers/919876543210/auto-reply',
    'POST /api/webhook/verify', 'GET /api/status',
  ];
  for (const row of rows) assert.ok(covered.has(row), `no fixture for ${row}`);
});
