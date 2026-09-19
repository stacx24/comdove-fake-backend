// Shared contract suite: every JobStore implementation must pass it unchanged
// (MemoryJobStore now, SqliteJobStore once P2's schema lands — plan Task 10).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { JobStore } from '../../src/webhooks/job-store.js';

export function jobStoreContract(name: string, make: () => JobStore) {
  const base = { conversation_id: 1, wamid: 'w1', kind: 'sent' as const, payload: '{"a":1}', not_before: 0, created_at: 10 };

  test(`${name}: insert assigns increasing ids and starts pending`, () => {
    const s = make();
    const a = s.insert(base);
    const b = s.insert({ ...base, wamid: 'w2' });
    assert.ok(b.id > a.id);
    assert.equal(a.state, 'pending');
    assert.equal(a.finished_at, null);
    assert.equal(a.payload, '{"a":1}');
  });

  test(`${name}: pending() is id-ordered and excludes finished jobs`, () => {
    const s = make();
    const a = s.insert(base);
    const b = s.insert({ ...base, conversation_id: 2 });
    const c = s.insert({ ...base, wamid: 'w3' });
    s.finish(b.id, 'ok', 20);
    assert.deepEqual(s.pending().map((j) => j.id), [a.id, c.id]);
  });

  test(`${name}: finish records state and time`, () => {
    const s = make();
    const a = s.insert(base);
    s.finish(a.id, 'failed', 99);
    assert.equal(s.get(a.id)?.state, 'failed');
    assert.equal(s.get(a.id)?.finished_at, 99);
  });

  test(`${name}: attempts are stored in order per job`, () => {
    const s = make();
    const a = s.insert(base);
    const b = s.insert(base);
    s.addAttempt({ job_id: a.id, attempt: 1, http_status: 500, error: null, duration_ms: 3, at: 11 });
    s.addAttempt({ job_id: b.id, attempt: 1, http_status: 200, error: null, duration_ms: 2, at: 12 });
    s.addAttempt({ job_id: a.id, attempt: 2, http_status: null, error: 'timeout', duration_ms: 100, at: 13 });
    assert.deepEqual(s.attempts(a.id).map((x) => [x.attempt, x.http_status, x.error]), [[1, 500, null], [2, null, 'timeout']]);
    assert.equal(s.attempts(b.id).length, 1);
  });

  test(`${name}: jobsFor(wamid) lists that message's webhooks`, () => {
    const s = make();
    s.insert(base);
    s.insert({ ...base, kind: 'delivered' });
    s.insert({ ...base, wamid: 'other' });
    assert.deepEqual(s.jobsFor('w1').map((j) => j.kind), ['sent', 'delivered']);
  });

  test(`${name}: clear() empties jobs and attempts`, () => {
    const s = make();
    const a = s.insert(base);
    s.addAttempt({ job_id: a.id, attempt: 1, http_status: 200, error: null, duration_ms: 1, at: 1 });
    s.clear();
    assert.equal(s.pending().length, 0);
    assert.equal(s.attempts(a.id).length, 0);
    assert.equal(s.get(a.id), null);
  });
}
