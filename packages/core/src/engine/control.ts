import { TERMINAL_STATUSES } from "../state/reducer.js";
import { LockedError, type RunHandle } from "../store/run-store.js";

export type CancelResult = "cancelled" | "requested" | "already_terminal";

/**
 * Cancels a run. If no driver holds the run, the cancellation is recorded directly;
 * otherwise a cancel request is left for the driver, which aborts and tree-kills its workers.
 */
export function cancelRun(run: RunHandle): CancelResult {
  let release: () => void;
  try {
    release = run.acquireWriter();
  } catch (e) {
    if (e instanceof LockedError) {
      run.requestCancel();
      return "requested";
    }
    throw e;
  }
  try {
    if (TERMINAL_STATUSES.has(run.state().status)) return "already_terminal";
    run.append({ type: "cancel_requested" });
    run.append({ type: "run_cancelled", reason: "cancelled by user" });
    return "cancelled";
  } finally {
    release();
  }
}

/** Records the human's selection (1-based item ids) for the pending approval gate. */
export function approveRun(run: RunHandle, itemIds: readonly number[]): number[] {
  const release = run.acquireWriter();
  try {
    const st = run.state();
    if (st.status !== "awaiting_approval" || !st.approval) {
      throw new Error(`run ${st.runId} is not awaiting approval (status: ${st.status})`);
    }
    const n = st.approval.items.length;
    const ids = [...new Set(itemIds)].sort((a, b) => a - b);
    const bad = ids.filter((i) => !Number.isInteger(i) || i < 1 || i > n);
    if (bad.length > 0) throw new Error(`invalid item ids ${bad.join(",")}; valid range is 1..${n}`);
    run.append({ type: "approval_given", stepId: st.approval.stepId, itemIds: ids });
    return ids;
  } finally {
    release();
  }
}
