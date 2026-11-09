import {
  RunStore,
  cancelRun,
  driveRun,
  runConfig,
  type CancelResult,
  type Config,
  type Redactor,
  type RunState,
  type Worker,
} from "@fractory/core";

export type WorkerFactory = (config: Config, ctx: { dataDir: string; repo: string; redactor: Redactor }) => Record<string, Worker>;

interface Active {
  ac: AbortController;
  done: Promise<void>;
}

/**
 * Runs drivers in the daemon process (the GUI never owns subprocesses, rule 4). One driver
 * per run; the run's own writer lock still guards against a CLI driving the same run.
 */
export class DriverPool {
  readonly #active = new Map<string, Active>();
  readonly lastError = new Map<string, string>();

  constructor(
    private readonly store: RunStore,
    private readonly dataDir: string,
    private readonly redactor: Redactor,
    private readonly workers: WorkerFactory,
  ) {}

  isActive(runId: string): boolean {
    return this.#active.has(runId);
  }

  /**
   * Starts (or resumes) driving a run. Rejects synchronously-detectable refusals (lock held,
   * resume preconditions such as an early quota resume) before returning.
   */
  async start(runId: string, opts: { force?: boolean; retryFailed?: boolean } = {}): Promise<void> {
    if (this.#active.has(runId)) throw new ConflictError(`run ${runId} is already being driven by this daemon`);
    const run = this.store.open(runId);
    const st = run.state();
    const workers = this.workers(runConfig(st), { dataDir: this.dataDir, repo: st.repo, redactor: this.redactor });
    const ac = new AbortController();
    let early: unknown;
    let settled = false;
    const p = driveRun(run, { dataDir: this.dataDir, workers, force: opts.force ?? false, retryFailed: opts.retryFailed ?? false, signal: ac.signal }).then(
      () => {
        settled = true;
      },
      (e: unknown) => {
        settled = true;
        early = e;
      },
    );
    // drive() acquires the lock and checks resume preconditions before its first await.
    await new Promise((r) => setImmediate(r));
    if (settled && early !== undefined) throw early;
    this.lastError.delete(runId);
    const done = p.then(() => {
      if (early !== undefined) this.lastError.set(runId, early instanceof Error ? early.message : String(early));
      this.#active.delete(runId);
    });
    this.#active.set(runId, { ac, done });
  }

  cancel(runId: string): CancelResult | "aborting" {
    const a = this.#active.get(runId);
    if (a) {
      a.ac.abort();
      return "aborting";
    }
    return cancelRun(this.store.open(runId));
  }

  /** Aborts every driver and waits for them (daemon shutdown). */
  async stopAll(): Promise<void> {
    const all = [...this.#active.values()];
    for (const a of all) a.ac.abort();
    await Promise.all(all.map((a) => a.done));
  }

  async wait(runId: string): Promise<RunState> {
    await this.#active.get(runId)?.done;
    return this.store.open(runId).state();
  }
}

export class ConflictError extends Error {}
