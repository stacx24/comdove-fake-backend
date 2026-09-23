// Outgoing webhook dispatcher (build plan §9e–§9h).
//
// - Per-conversation FIFO: one job at a time per conversation_id, in enqueue order, so a
//   `sent` in retry backoff can never be overtaken by `delivered`. Conversations run in
//   parallel.
// - notBefore: the head job waits until then (used to give Comdove time to store the wamid
//   before its first status arrives); later jobs wait behind it.
// - Success is HTTP 200 only. 5 s timeout. 1 attempt + retries after 1 s / 5 s / 15 s, then
//   `failed` and the queue moves on.
// - The body is serialized once at enqueue; every attempt sends and signs those bytes.
import { sign } from './sign.js';
import type { Job, JobKind, JobStore } from './job-store.js';

export interface DispatcherOptions {
  url: string;
  secret: string;
  store: JobStore;
  retryDelaysMs?: number[];
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
  now?: () => number;
  /** Called after every attempt and every finish (→ admin log update). */
  onChange?: (job: Job) => void;
  onError?: (err: unknown) => void;
  /** How many conversations may have a request in flight at once (WS-343). */
  maxParallel?: number;
}

export interface EnqueueInput {
  conversation_id: number;
  wamid: string;
  kind: JobKind;
  body: object;
  notBefore?: number;
}

export interface Dispatcher {
  enqueue(j: EnqueueInput): Job;
  /** Reset: abort in-flight requests, drop timers and queues. Rows are the caller's to delete. */
  cancelAll(): void;
  /** Boot: re-queue the store's pending jobs in id order. */
  resume(): void;
  /** Resolves once every queue is empty and nothing is in flight. */
  idle(): Promise<void>;
}

export const DEFAULT_RETRY_DELAYS_MS = [1000, 5000, 15000];
export const DEFAULT_TIMEOUT_MS = 5000;
/** 5 businesses x 100 tiles = 500 conversations; without a cap they all call Comdove at once. */
export const DEFAULT_MAX_PARALLEL = 20;

class Cancelled extends Error {}

function sleep(ms: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) return Promise.reject(new Cancelled());
  if (ms <= 0) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      reject(new Cancelled());
    };
    signal.addEventListener('abort', onAbort, { once: true });
  });
}

/** Short, stable error label for the attempt log: 'timeout', 'ECONNREFUSED', ... */
function describeError(err: unknown): string {
  const e = err as { name?: string; code?: string; message?: string; cause?: { code?: string; message?: string } };
  if (e?.name === 'TimeoutError') return 'timeout';
  return e?.cause?.code ?? e?.code ?? e?.cause?.message ?? e?.message ?? String(err);
}

export function createDispatcher(o: DispatcherOptions): Dispatcher {
  const retryDelays = o.retryDelaysMs ?? DEFAULT_RETRY_DELAYS_MS;
  const timeoutMs = o.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const doFetch = o.fetchImpl ?? fetch;
  const now = o.now ?? Date.now;
  const report = (err: unknown) => (o.onError ?? ((e) => console.error('[dispatcher]', e)))(err);

  const maxParallel = Math.max(1, o.maxParallel ?? DEFAULT_MAX_PARALLEL);

  let queues = new Map<number, Job[]>();
  let running = new Set<number>();
  // Conversations with work waiting for a free slot, in arrival order.
  let waiting: number[] = [];
  let cancel = new AbortController();
  let idleWaiters: Array<() => void> = [];

  const changed = (id: number) => {
    const job = o.store.get(id);
    if (job && o.onChange) o.onChange(job);
  };

  function settleIdle() {
    if (running.size === 0 && [...queues.values()].every((q) => q.length === 0)) {
      const waiters = idleWaiters;
      idleWaiters = [];
      waiters.forEach((w) => w());
    }
  }

  async function attempt(job: Job, n: number, signal: AbortSignal): Promise<boolean> {
    const started = now();
    let status: number | null = null;
    let error: string | null = null;
    try {
      const res = await doFetch(o.url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Hub-Signature-256': sign(job.payload, o.secret) },
        body: job.payload,
        signal: AbortSignal.any([AbortSignal.timeout(timeoutMs), signal]),
      });
      status = res.status;
      await res.arrayBuffer().catch(() => undefined); // free the socket
    } catch (err) {
      if (signal.aborted) throw new Cancelled();
      error = describeError(err);
    }
    o.store.addAttempt({ job_id: job.id, attempt: n, http_status: status, error, duration_ms: now() - started, at: now() });
    changed(job.id);
    return status === 200;
  }

  async function runHead(cid: number, signal: AbortSignal) {
    const queue = queues.get(cid)!;
    const job = queue[0];
    await sleep(job.not_before - now(), signal);
    const maxAttempts = retryDelays.length + 1;
    for (let n = 1; n <= maxAttempts; n++) {
      if (await attempt(job, n, signal)) {
        o.store.finish(job.id, 'ok', now());
        changed(job.id);
        return;
      }
      if (n < maxAttempts) await sleep(retryDelays[n - 1], signal);
    }
    o.store.finish(job.id, 'failed', now());
    changed(job.id);
  }

  function pump(cid: number) {
    const queue = queues.get(cid);
    if (running.has(cid) || !queue || queue.length === 0) return;
    if (running.size >= maxParallel) {
      // All slots busy: wait for one, keeping this conversation's own order.
      if (!waiting.includes(cid)) waiting.push(cid);
      return;
    }
    waiting = waiting.filter((id) => id !== cid);
    running.add(cid);
    const signal = cancel.signal;
    const myQueues = queues;
    const myRunning = running;
    runHead(cid, signal)
      .catch((err) => {
        if (!(err instanceof Cancelled)) report(err);
      })
      .finally(() => {
        myRunning.delete(cid);
        if (signal.aborted) return settleIdle(); // cancelAll already replaced the queues
        myQueues.get(cid)?.shift();
        pump(cid);
        // A slot just freed up: let the longest-waiting conversation in.
        while (running.size < maxParallel && waiting.length > 0) {
          const next = waiting.shift()!;
          if (next !== cid) pump(next);
        }
        settleIdle();
      });
  }

  function push(job: Job) {
    const q = queues.get(job.conversation_id) ?? [];
    q.push(job);
    queues.set(job.conversation_id, q);
    pump(job.conversation_id);
  }

  return {
    enqueue(j) {
      const job = o.store.insert({
        conversation_id: j.conversation_id,
        wamid: j.wamid,
        kind: j.kind,
        payload: JSON.stringify(j.body),
        not_before: j.notBefore ?? 0,
        created_at: now(),
      });
      push(job);
      return job;
    },

    cancelAll() {
      cancel.abort();
      cancel = new AbortController();
      queues = new Map();
      running = new Set();
      waiting = [];
      settleIdle();
    },

    resume() {
      for (const job of o.store.pending()) push({ ...job, not_before: 0 });
    },

    idle() {
      return new Promise<void>((resolve) => {
        idleWaiters.push(resolve);
        settleIdle();
      });
    },
  };
}
