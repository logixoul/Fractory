import * as os from "node:os";
import { stepTiming } from "@fractory/shared/timing";
import type { StepFailureKind } from "../schemas/run-events.js";
import { TERMINAL_STATUSES, type RunState } from "../state/reducer.js";
import type { RunHandle } from "../store/run-store.js";
import { RATE_LIMIT_RE, retryAfterMsFromText } from "../util/retry-after.js";
import { AbortedError, QuotaExhaustedError, ResumeRefusedError, StepFailure } from "./errors.js";
import { readQuotaBook, windowsOverThreshold } from "./quota-book.js";
import type { ApprovalGate, EngineDeps, FileChange, StepContext, StepDef, WorkStep, WorkflowDef } from "./types.js";
import { runWorkerTask } from "./worker-task.js";

export interface DriveOptions {
  /** External cancellation (e.g. Ctrl-C). */
  signal?: AbortSignal;
  /** Resume a quota-paused run before the known reset time. */
  force?: boolean;
  /** Reopen a failed run and rerun its failed step from that step's checkpoint. */
  retryFailed?: boolean;
}

const MAX_ITERATIONS = 10_000;

const toJson = (v: unknown): unknown => (v === undefined ? null : JSON.parse(JSON.stringify(v)));
const isGate = (s: StepDef): s is ApprovalGate => s.kind === "approval_gate";

/**
 * Drives a run until it completes, fails, is cancelled, or pauses (quota, approval,
 * needs_attention). Idempotent and resumable: completed steps are never rerun; a step
 * that was started but never finished (crash) is marked abandoned and rerun.
 */
export async function drive(run: RunHandle, wf: WorkflowDef, deps: EngineDeps, opts: DriveOptions = {}): Promise<RunState> {
  const now = deps.now ?? Date.now;
  const release = run.acquireWriter();
  const runAc = new AbortController();
  const onExternalAbort = () => runAc.abort();
  opts.signal?.addEventListener("abort", onExternalAbort, { once: true });
  if (opts.signal?.aborted) runAc.abort();
  const poll = setInterval(() => {
    if (run.cancelRequested()) runAc.abort();
  }, deps.cancelPollMs ?? 500);
  poll.unref();
  try {
    if (!prepare(run, now(), opts.force ?? false, opts.retryFailed ?? false)) return run.state();
    run.append({ type: "driver_started", pid: process.pid, hostname: os.hostname() });
    for (const st of Object.values(run.state().steps)) {
      if (st.status === "running") run.append({ type: "step_abandoned", stepId: st.id, attempt: st.attempt });
    }
    preflightQuota(run, deps, now());
    await loop(run, wf, deps, runAc, now);
  } finally {
    clearInterval(poll);
    opts.signal?.removeEventListener("abort", onExternalAbort);
    release();
  }
  return run.state();
}

/** Checks resume preconditions and records the transition. Returns false if there is nothing to do. */
function prepare(run: RunHandle, now: number, force: boolean, retryFailed: boolean): boolean {
  const st = run.state();
  if (st.status === "failed" && retryFailed) {
    if (!st.failure?.stepId) throw new ResumeRefusedError("the run failed outside a step; there is no step to retry");
    run.append({ type: "retry_requested", stepId: st.failure.stepId });
    run.append({ type: "resumed", force });
    return true;
  }
  if (TERMINAL_STATUSES.has(st.status)) return false;
  if (st.cancelRequested || run.cancelRequested()) {
    if (!st.cancelRequested) run.append({ type: "cancel_requested" });
    run.append({ type: "run_cancelled", reason: "cancel requested" });
    return false;
  }
  switch (st.status) {
    case "paused_quota": {
      const resetsAt = st.pause?.resetsAt;
      if (resetsAt !== undefined && now < resetsAt && !force) {
        throw new ResumeRefusedError(
          `quota for ${st.pause?.workerId} resets at ${new Date(resetsAt).toISOString()}; use --force to resume earlier`,
        );
      }
      run.append({ type: "resumed", force });
      break;
    }
    case "awaiting_approval":
      if (!st.approval || st.approval.approvedItemIds === null) {
        throw new ResumeRefusedError(`run is awaiting approval of step ${st.approval?.stepId ?? "?"}`);
      }
      run.append({ type: "resumed", force });
      break;
    case "needs_attention":
      run.append({ type: "attention_resolved", decision: "continue" });
      run.append({ type: "resumed", force });
      break;
    default:
      break;
  }
  return true;
}

function preflightQuota(run: RunHandle, deps: EngineDeps, now: number): void {
  if (!deps.quotaFile) return;
  const book = readQuotaBook(deps.quotaFile);
  const st = run.state();
  const threshold = deps.config.quota.warnUtilization;
  // The run's labelled workers (contestants, or implementer + reviewer) and the judge where one is used.
  const workerIds = [...new Set([...Object.values(st.labels), ...(st.workflow === "review" ? [] : [st.roles.judge])])];
  for (const workerId of workerIds) {
    const entry = book[workerId];
    if (!entry) continue;
    for (const w of windowsOverThreshold(entry.windows, threshold, now)) {
      if (st.quotaWarned.includes(`${workerId}:${w.window}:preflight`)) continue;
      run.append({ type: "quota_warning", workerId, ...w, threshold, source: "preflight" });
    }
  }
}

interface StageOutcome {
  cancelled: boolean;
  failed?: { stepId: string; kind: StepFailureKind; reason: string };
  quota?: { stepId: string; workerId: string; resetsAt?: number };
  attention: { stepId: string; changes: FileChange[] }[];
}

async function loop(run: RunHandle, wf: WorkflowDef, deps: EngineDeps, runAc: AbortController, now: () => number) {
  for (let iter = 0; ; iter++) {
    if (iter > MAX_ITERATIONS) throw new Error(`workflow '${wf.name}' did not terminate`);
    if (runAc.signal.aborted) return cancel(run);
    const st = run.state();
    const next = wf.next(st);
    if (next.kind === "done") {
      run.append({ type: "run_completed", ...(next.result !== undefined ? { result: toJson(next.result) } : {}) });
      return;
    }
    const pending = next.steps.filter((s) => st.steps[s.id]?.status !== "completed");
    if (pending.length === 0) throw new Error(`workflow '${wf.name}' returned a stage with no pending steps`);

    const gates = pending.filter(isGate);
    if (gates.length > 0) {
      if (pending.length !== 1) throw new Error(`workflow '${wf.name}': an approval gate must be alone in its stage`);
      const gate = gates[0]!;
      const ap = st.approval;
      if (ap?.stepId === gate.id && ap.approvedItemIds !== null) {
        const attempt = (st.steps[gate.id]?.attempt ?? 0) + 1;
        run.append({ type: "step_started", stepId: gate.id, attempt });
        run.append({
          type: "step_completed",
          stepId: gate.id,
          attempt,
          result: { approvedItemIds: ap.approvedItemIds, items: ap.items },
          durationMs: 0,
        });
        continue;
      }
      const items = toJson(gate.items(st));
      if (!Array.isArray(items)) throw new Error(`gate ${gate.id}: items() must return an array`);
      run.append({ type: "awaiting_approval", stepId: gate.id, items });
      return;
    }

    const out = await runStage(run, pending as WorkStep[], deps, runAc.signal, now);
    if (runAc.signal.aborted || out.cancelled) return cancel(run);
    if (out.failed) {
      run.append({ type: "run_failed", stepId: out.failed.stepId, kind: out.failed.kind, reason: out.failed.reason });
      return;
    }
    if (out.quota) {
      run.append({ type: "paused_quota", ...out.quota });
      return;
    }
    if (out.attention.length > 0) {
      // Parallel steps observe the same main-repo change; report each change once.
      const seen = new Set<string>();
      const changes = out.attention
        .flatMap((a) => a.changes)
        .filter((c) => {
          const k = JSON.stringify([c.path, c.before, c.after]);
          return seen.has(k) ? false : (seen.add(k), true);
        });
      run.append({ type: "needs_attention", stepId: out.attention[0]!.stepId, changes });
      return;
    }
  }
}

function cancel(run: RunHandle): void {
  if (!run.state().cancelRequested) run.append({ type: "cancel_requested" });
  run.append({ type: "run_cancelled", reason: "cancelled" });
}

async function runStage(
  run: RunHandle,
  steps: WorkStep[],
  deps: EngineDeps,
  runSignal: AbortSignal,
  now: () => number,
): Promise<StageOutcome> {
  const siblings = new AbortController();
  const out: StageOutcome = { cancelled: false, attention: [] };
  await Promise.all(
    steps.map(async (step) => {
      const r = await runStep(run, step, deps, runSignal, siblings.signal, now);
      if (r.kind === "failed") {
        out.failed ??= { stepId: r.stepId, kind: r.failKind, reason: r.reason };
        siblings.abort(); // a hard failure fails the run: stop spending on siblings
      } else if (r.kind === "quota") {
        const { kind: _k, ...q } = r;
        out.quota ??= q; // siblings keep going; their work is kept for resume
      } else if (r.kind === "cancelled") {
        out.cancelled = true;
      } else if (r.attention.length > 0) {
        out.attention.push({ stepId: step.id, changes: r.attention });
      }
    }),
  );
  return out;
}

type StepOutcome =
  | { kind: "completed"; attention: FileChange[] }
  | { kind: "failed"; stepId: string; failKind: StepFailureKind; reason: string }
  | { kind: "quota"; stepId: string; workerId: string; resetsAt?: number }
  | { kind: "cancelled" };

/**
 * Delay before step retry n (0-based): a Retry-After in the error text, else
 * retry.rateLimitBackoffMs for a provider rate limit, else retry.backoffMs.
 */
export function stepRetryDelayMs(reason: string, n: number, retry: { backoffMs: number[]; rateLimitBackoffMs: number[] }): number {
  const after = retryAfterMsFromText(reason);
  if (after !== undefined) return after;
  const list = RATE_LIMIT_RE.test(reason) ? retry.rateLimitBackoffMs : retry.backoffMs;
  return list[Math.min(n, list.length - 1)]!;
}

/**
 * Runs a step; transient failures (5xx, network, provider rate limits) are retried with
 * backoff up to retry.transientMaxRetries times. This is the last resort: Pi retries rate
 * limits and 5xx itself first. Each retry is a new attempt, which restores the step's
 * checkpoint (edit steps) or post-step commit (check steps) first.
 */
async function runStep(
  run: RunHandle,
  step: WorkStep,
  deps: EngineDeps,
  runSignal: AbortSignal,
  siblingSignal: AbortSignal,
  now: () => number,
): Promise<StepOutcome> {
  const { transientMaxRetries } = deps.config.retry;
  for (;;) {
    const r = await runStepAttempt(run, step, deps, runSignal, siblingSignal, now);
    if (r.kind !== "failed" || r.failKind !== "transient") return r;
    const done = run.state().retries[step.id] ?? 0;
    if (done >= transientMaxRetries) return r;
    const delayMs = stepRetryDelayMs(r.reason, done, deps.config.retry);
    run.append({ type: "step_retrying", stepId: step.id, attempt: run.state().steps[step.id]!.attempt, reason: r.reason, delayMs });
    const waited = await sleep(delayMs, [runSignal, siblingSignal]);
    if (!waited) return runSignal.aborted ? { kind: "cancelled" } : r;
  }
}

function sleep(ms: number, signals: AbortSignal[]): Promise<boolean> {
  return new Promise((resolve) => {
    if (signals.some((s) => s.aborted)) return resolve(false);
    const done = (ok: boolean) => {
      clearTimeout(t);
      for (const s of signals) s.removeEventListener("abort", onAbort);
      resolve(ok);
    };
    const onAbort = () => done(false);
    const t = setTimeout(() => done(true), ms);
    for (const s of signals) s.addEventListener("abort", onAbort, { once: true });
  });
}

async function runStepAttempt(
  run: RunHandle,
  step: WorkStep,
  deps: EngineDeps,
  runSignal: AbortSignal,
  siblingSignal: AbortSignal,
  now: () => number,
): Promise<StepOutcome> {
  const attempt = (run.state().steps[step.id]?.attempt ?? 0) + 1;
  run.append({
    type: "step_started",
    stepId: step.id,
    attempt,
    ...(step.workerId !== undefined ? { workerId: step.workerId } : {}),
    ...(step.label !== undefined ? { label: step.label } : {}),
  });
  const startedSeq = run.state().lastSeq - 1; // events(startedSeq) begins at this step_started
  const ac = new AbortController();
  const abort = () => ac.abort();
  runSignal.addEventListener("abort", abort, { once: true });
  siblingSignal.addEventListener("abort", abort, { once: true });
  if (runSignal.aborted || siblingSignal.aborted) ac.abort();

  const attention: FileChange[] = [];
  const ctx: StepContext = {
    run,
    stepId: step.id,
    attempt,
    signal: ac.signal,
    stepDir: run.stepDir(step.id),
    config: deps.config,
    state: () => run.state(),
    record: (ev) => {
      run.append(ev);
    },
    flagAttention: (changes) => {
      attention.push(...changes);
    },
    runWorker: (workerId, options) =>
      runWorkerTask({ run, stepId: step.id, attempt, workerId, options, signal: ac.signal, deps, now }),
  };

  // Timing breakdown from this attempt's events, recorded just before its end event (shared
  // computation, so the GUI's live figures for a running step match the recorded ones).
  const recordTiming = () => {
    try {
      const timing = stepTiming(run.events(startedSeq), step.id, attempt, now());
      if (timing) run.append({ type: "step_timing", stepId: step.id, attempt, timing });
    } catch {
      // diagnostics only: never fail a step over its timing
    }
  };

  const fail = (failKind: StepFailureKind, reason: string): StepOutcome => {
    recordTiming();
    run.append({ type: "step_failed", stepId: step.id, attempt, kind: failKind, reason });
    return { kind: "failed", stepId: step.id, failKind, reason };
  };

  const t0 = now();
  try {
    const result = toJson(await step.run(ctx));
    if (ac.signal.aborted) throw new AbortedError("aborted");
    const chk = step.exitCheck ? await step.exitCheck(ctx, result) : { ok: true };
    if (!chk.ok) return fail("exit_check", chk.reason ?? "exit check failed");
    recordTiming();
    run.append({ type: "step_completed", stepId: step.id, attempt, result, durationMs: Math.max(0, now() - t0) });
    return { kind: "completed", attention };
  } catch (e) {
    if (e instanceof QuotaExhaustedError) {
      recordTiming();
      run.append({ type: "step_failed", stepId: step.id, attempt, kind: "quota", reason: e.message });
      return { kind: "quota", stepId: step.id, workerId: e.workerId, ...(e.resetsAt !== undefined ? { resetsAt: e.resetsAt } : {}) };
    }
    if (ac.signal.aborted || e instanceof AbortedError) {
      if (runSignal.aborted) {
        recordTiming();
        run.append({ type: "step_failed", stepId: step.id, attempt, kind: "cancelled", reason: "run cancelled" });
        return { kind: "cancelled" };
      }
      return fail("cancelled", "aborted: a sibling step failed");
    }
    if (e instanceof StepFailure) return fail(e.kind, e.message);
    return fail("error", e instanceof Error ? (e.stack ?? e.message) : String(e));
  } finally {
    runSignal.removeEventListener("abort", abort);
    siblingSignal.removeEventListener("abort", abort);
  }
}
