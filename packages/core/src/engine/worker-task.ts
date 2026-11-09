import { WorkerEvent, isQuotaExhaustedStatus, type DoneEvent } from "../schemas/worker-events.js";
import type { RunHandle } from "../store/run-store.js";
import { computeCost } from "./cost.js";
import { AbortedError, QuotaExhaustedError, StepFailure } from "./errors.js";
import { updateQuotaBook, windowsOverThreshold } from "./quota-book.js";
import type { EngineDeps, WorkerRunOptions } from "./types.js";

const COALESCE_CHARS = 4000;
const COALESCE_MS = 250;

/** Merges consecutive text/thinking deltas so the run log stays compact. */
class DeltaCoalescer {
  #type: "text" | "thinking" | null = null;
  #buf = "";
  #since = 0;

  constructor(
    private readonly emit: (ev: WorkerEvent) => void,
    private readonly now: () => number,
  ) {}

  push(ev: { type: "text" | "thinking"; text: string }): void {
    if (this.#type !== null && this.#type !== ev.type) this.flush();
    if (this.#type === null) {
      this.#type = ev.type;
      this.#since = this.now();
    }
    this.#buf += ev.text;
    if (this.#buf.length >= COALESCE_CHARS || this.now() - this.#since >= COALESCE_MS) this.flush();
  }

  flush(): void {
    if (this.#type !== null && this.#buf !== "") this.emit({ type: this.#type, text: this.#buf });
    this.#type = null;
    this.#buf = "";
  }
}

/**
 * Runs one worker task inside a step: validates every normalized event, appends it to the
 * run log, records usage/cost and quota, and maps terminal errors to engine errors.
 */
export async function runWorkerTask(args: {
  run: RunHandle;
  stepId: string;
  attempt: number;
  workerId: string;
  options: WorkerRunOptions;
  signal: AbortSignal;
  deps: EngineDeps;
  now: () => number;
}): Promise<DoneEvent> {
  const { run, stepId, attempt, workerId, options, signal, deps, now } = args;
  const worker = deps.workers[workerId];
  if (!worker) throw new StepFailure("error", `no worker '${workerId}' configured`);
  const cfg = deps.config;

  const append = (event: WorkerEvent) => run.append({ type: "worker_event", stepId, attempt, event });
  const co = new DeltaCoalescer(append, now);
  let done: DoneEvent | undefined;
  let error: Extract<WorkerEvent, { type: "error" }> | undefined;
  let lastResetsAt: number | undefined;
  let exhausted = false;

  const { timeoutMs, ...rest } = options;
  const task = { ...rest, timeoutMs: timeoutMs ?? cfg.timeouts.workerMs, signal };

  try {
    for await (const raw of worker.run(task)) {
      const parsed = WorkerEvent.safeParse(raw);
      if (!parsed.success) {
        throw new StepFailure("error", `worker ${workerId} emitted an invalid event: ${parsed.error.message}`);
      }
      const ev = parsed.data;
      if (ev.type === "text" || ev.type === "thinking") {
        co.push(ev);
        continue;
      }
      co.flush();
      append(ev);
      switch (ev.type) {
        case "usage": {
          const priceKey = `${ev.provider}/${ev.model}`;
          // Claude runs on the Pro subscription: not metered; its vendor cost is API-equivalent only.
          const subscription = cfg.workers[workerId]?.kind === "claude";
          const cost = subscription ? { costUsd: 0 } : computeCost(cfg.prices[priceKey], ev.tokens);
          run.append({
            type: "usage_recorded",
            stepId,
            attempt,
            workerId,
            priceKey,
            tokens: ev.tokens,
            costUsd: cost.costUsd,
            ...(ev.vendorCostUsd !== undefined ? { vendorCostUsd: ev.vendorCostUsd } : {}),
            ...("warning" in cost && cost.warning !== undefined ? { warning: cost.warning } : {}),
            billing: subscription ? "subscription" : "metered",
          });
          break;
        }
        case "rate_limit": {
          if (ev.resetsAt !== undefined) lastResetsAt = ev.resetsAt;
          if (isQuotaExhaustedStatus(ev.status)) exhausted = true;
          observeQuota(run, workerId, ev, deps, now());
          break;
        }
        case "error":
          error = ev;
          break;
        case "done":
          done = ev;
          break;
        default:
          break;
      }
    }
  } catch (e) {
    co.flush();
    if (e instanceof StepFailure || e instanceof QuotaExhaustedError) throw e;
    if (signal.aborted) throw new AbortedError("aborted");
    throw new StepFailure("error", `worker ${workerId} failed: ${(e as Error).message ?? String(e)}`);
  }
  co.flush();

  if (signal.aborted) throw new AbortedError("aborted");
  if (error?.kind === "quota" || (exhausted && !done)) {
    throw new QuotaExhaustedError(workerId, error?.resetsAt ?? lastResetsAt);
  }
  if (error) {
    const kind = error.kind === "timeout" ? "timeout" : error.kind === "transient" ? "transient" : "error";
    throw new StepFailure(kind, `${workerId}: ${error.kind}: ${error.message}`);
  }
  if (!done) throw new StepFailure("error", `worker ${workerId} ended without a done event`);
  return done;
}

function observeQuota(
  run: RunHandle,
  workerId: string,
  ev: Extract<WorkerEvent, { type: "rate_limit" }>,
  deps: EngineDeps,
  now: number,
): void {
  run.append({
    type: "quota_observed",
    workerId,
    status: ev.status,
    windows: ev.windows,
    ...(ev.resetsAt !== undefined ? { resetsAt: ev.resetsAt } : {}),
  });
  if (deps.quotaFile) {
    updateQuotaBook(deps.quotaFile, workerId, {
      status: ev.status,
      windows: ev.windows,
      observedAt: now,
      ...(ev.resetsAt !== undefined ? { resetsAt: ev.resetsAt } : {}),
    });
  }
  const q = deps.config.quota;
  const warned = run.state().quotaWarned;
  for (const w of windowsOverThreshold(ev.windows, q.warnUtilization, now)) {
    if (warned.includes(`${workerId}:${w.window}:live`)) continue;
    run.append({ type: "quota_warning", workerId, ...w, threshold: q.warnUtilization, source: "live" });
  }
  if (q.abortUtilization !== undefined) {
    const over = windowsOverThreshold(ev.windows, q.abortUtilization, now)[0];
    if (over) throw new QuotaExhaustedError(workerId, over.resetsAt ?? ev.resetsAt);
  }
}
