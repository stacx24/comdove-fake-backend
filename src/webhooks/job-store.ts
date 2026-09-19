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
