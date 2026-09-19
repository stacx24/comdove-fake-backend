// Persistence for outgoing webhooks: one job per webhook Comdove must receive, one
// attempt row per HTTP try (build plan §6 webhook_jobs / webhook_attempts).
// MemoryJobStore is used until P2's SQLite schema exists; SqliteJobStore follows the
// same contract (test/webhooks/job-store.contract.ts).

export type JobKind = 'inbound' | 'sent' | 'delivered' | 'read';
export type JobState = 'pending' | 'ok' | 'failed';

export interface Job {
  id: number;
  conversation_id: number;
  wamid: string;
  kind: JobKind;
  payload: string; // exact JSON bytes that are signed and sent
  not_before: number; // ms; in memory only — resumed jobs are eligible immediately
  state: JobState;
  created_at: number;
  finished_at: number | null;
}

export interface Attempt {
  job_id: number;
  attempt: number; // 1..4
  http_status: number | null; // null on timeout / network error
  error: string | null;
  duration_ms: number;
  at: number;
}

export type NewJob = Omit<Job, 'id' | 'state' | 'finished_at'>;

export interface JobStore {
  insert(j: NewJob): Job;
  get(id: number): Job | null;
  addAttempt(a: Attempt): void;
  finish(id: number, state: 'ok' | 'failed', at: number): void;
  /** Unfinished jobs ordered by id (FIFO resume on boot). */
  pending(): Job[];
  attempts(jobId: number): Attempt[];
  /** Webhook jobs for one message, for the admin log. */
  jobsFor(wamid: string): Job[];
  clear(): void;
}

export class MemoryJobStore implements JobStore {
  private jobs = new Map<number, Job>();
  private attemptRows: Attempt[] = [];
  private nextId = 1;

  insert(j: NewJob): Job {
    const job: Job = { ...j, id: this.nextId++, state: 'pending', finished_at: null };
    this.jobs.set(job.id, job);
    return { ...job };
  }

  get(id: number): Job | null {
    const j = this.jobs.get(id);
    return j ? { ...j } : null;
  }

  addAttempt(a: Attempt): void {
    this.attemptRows.push({ ...a });
  }

  finish(id: number, state: 'ok' | 'failed', at: number): void {
    const j = this.jobs.get(id);
    if (j) Object.assign(j, { state, finished_at: at });
  }

  pending(): Job[] {
    return [...this.jobs.values()].filter((j) => j.state === 'pending').map((j) => ({ ...j }));
  }

  attempts(jobId: number): Attempt[] {
    return this.attemptRows.filter((a) => a.job_id === jobId).map((a) => ({ ...a }));
  }

  jobsFor(wamid: string): Job[] {
    return [...this.jobs.values()].filter((j) => j.wamid === wamid).map((j) => ({ ...j }));
  }

  clear(): void {
    this.jobs.clear();
    this.attemptRows = [];
  }
}

/** The subset of better-sqlite3's Database this store uses (keeps the type import light). */
interface SqliteDb {
  prepare(sql: string): {
    run(...params: unknown[]): { lastInsertRowid: number | bigint };
    get(...params: unknown[]): unknown;
    all(...params: unknown[]): unknown[];
  };
}

type JobRow = Omit<Job, 'not_before'>;
const JOB_COLUMNS = 'id, conversation_id, wamid, kind, payload, state, created_at, finished_at';
const toJob = (r: JobRow): Job => ({ ...r, not_before: 0 });

/**
 * Jobs + attempts in P2's SQLite tables (build plan §6). not_before is not a column:
 * after a restart every pending job is eligible immediately, so it reads back as 0.
 */
export class SqliteJobStore implements JobStore {
  constructor(private db: SqliteDb) {}

  insert(j: NewJob): Job {
    const info = this.db
      .prepare('INSERT INTO webhook_jobs (conversation_id, wamid, kind, payload, state, created_at) VALUES (?, ?, ?, ?, ?, ?)')
      .run(j.conversation_id, j.wamid, j.kind, j.payload, 'pending', j.created_at);
    return { ...j, id: Number(info.lastInsertRowid), state: 'pending', finished_at: null };
  }

  get(id: number): Job | null {
    const r = this.db.prepare(`SELECT ${JOB_COLUMNS} FROM webhook_jobs WHERE id=?`).get(id) as JobRow | undefined;
    return r ? toJob(r) : null;
  }

  addAttempt(a: Attempt): void {
    this.db
      .prepare('INSERT INTO webhook_attempts (job_id, attempt, http_status, error, duration_ms, at) VALUES (?, ?, ?, ?, ?, ?)')
      .run(a.job_id, a.attempt, a.http_status, a.error, a.duration_ms, a.at);
  }

  finish(id: number, state: 'ok' | 'failed', at: number): void {
    this.db.prepare('UPDATE webhook_jobs SET state=?, finished_at=? WHERE id=?').run(state, at, id);
  }

  pending(): Job[] {
    return (this.db.prepare(`SELECT ${JOB_COLUMNS} FROM webhook_jobs WHERE state='pending' ORDER BY id`).all() as JobRow[]).map(toJob);
  }

  attempts(jobId: number): Attempt[] {
    return this.db
      .prepare('SELECT job_id, attempt, http_status, error, duration_ms, at FROM webhook_attempts WHERE job_id=? ORDER BY id')
      .all(jobId) as Attempt[];
  }

  jobsFor(wamid: string): Job[] {
    return (this.db.prepare(`SELECT ${JOB_COLUMNS} FROM webhook_jobs WHERE wamid=? ORDER BY id`).all(wamid) as JobRow[]).map(toJob);
  }

  clear(): void {
    this.db.prepare('DELETE FROM webhook_attempts').run();
    this.db.prepare('DELETE FROM webhook_jobs').run();
  }
}
