export interface QueuedJob {
  id: string;
  conversationId: string | null;
  promptText: string;
  modelTarget: string;
  scheduledFor: string; // ISO 8601
  status: string;       // expected 'PENDING'
}

type Listener = (jobs: QueuedJob[]) => void;
type Fetcher = () => Promise<QueuedJob[]>;
interface Options { graceMs?: number; now?: () => number }

/**
 * Observable store of this account's PENDING queued jobs. The backend is the
 * source of truth (via `fetcher`); locally-added (optimistic) jobs are retained
 * for a short grace window so freshly-queued messages show instantly without
 * flickering before the next fetch reflects them.
 */
export class QueueStore {
  private jobs: QueuedJob[] = [];
  private listeners = new Set<Listener>();
  private localAdds: { job: QueuedJob; at: number }[] = [];
  private pollTimer?: ReturnType<typeof setInterval>;
  private readonly graceMs: number;
  private readonly now: () => number;

  constructor(private fetcher: Fetcher, opts: Options = {}) {
    this.graceMs = opts.graceMs ?? 20_000;
    this.now = opts.now ?? Date.now;
  }

  getJobs(): QueuedJob[] { return this.jobs; }

  jobsForConversation(conversationId: string | null): QueuedJob[] {
    return this.jobs.filter((j) => j.conversationId === conversationId);
  }

  subscribe(listener: Listener): () => void {
    this.listeners.add(listener);
    listener(this.jobs);
    return () => { this.listeners.delete(listener); };
  }

  private notify() { for (const l of this.listeners) l(this.jobs); }

  private recompute(fetched: QueuedJob[]) {
    // Client-side safety net: never surface non-PENDING jobs, even if the
    // backend hasn't been updated with the status filter yet.
    const pending = fetched.filter((j) => j.status === 'PENDING');
    const fetchedIds = new Set(pending.map((j) => j.id));
    this.localAdds = this.localAdds.filter(
      (a) => !fetchedIds.has(a.job.id) && this.now() - a.at < this.graceMs,
    );
    this.jobs = [...pending, ...this.localAdds.map((a) => a.job)];
    this.notify();
  }

  async refresh(): Promise<void> {
    try {
      const fetched = await this.fetcher();
      this.recompute(fetched);
    } catch {
      /* keep last-known jobs on transient failure */
    }
  }

  addOptimistic(job: QueuedJob): void {
    this.localAdds.push({ job, at: this.now() });
    this.jobs = [...this.jobs.filter((j) => j.id !== job.id), job];
    this.notify();
  }

  remove(id: string): void {
    this.localAdds = this.localAdds.filter((a) => a.job.id !== id);
    this.jobs = this.jobs.filter((j) => j.id !== id);
    this.notify();
  }

  startPolling(intervalMs: number): () => void {
    void this.refresh();
    this.pollTimer = setInterval(() => void this.refresh(), intervalMs);
    return () => { if (this.pollTimer) clearInterval(this.pollTimer); };
  }
}
