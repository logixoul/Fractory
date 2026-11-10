import type { RunEvent } from "@fractory/shared/events";
import { TERMINAL_STATUSES, type QuotaState, type RunState, type StepState, type WorkerTotals } from "@fractory/shared/state";

// The state shapes live in @fractory/shared (also used by the GUI); the reducer stays here.
export * from "@fractory/shared/state";

function emptyTotals(): WorkerTotals {
  return { tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, costUsd: 0, costUnknown: false, vendorCostUsd: 0 };
}

/**
 * Applies one event to a state in place. The run state is a pure function of the
 * event sequence: `reduceAll(events)` always yields the same state.
 */
export function reduceInto(state: RunState | null, ev: RunEvent): RunState {
  if (state === null) {
    if (ev.type !== "run_created") throw new Error(`first event must be run_created, got ${ev.type}`);
    return {
      runId: ev.runId,
      workflow: ev.workflow,
      repo: ev.repo,
      promptFile: ev.promptFile,
      promptSha256: ev.promptSha256,
      labels: { ...ev.labels },
      roles: {
        contestants: [...ev.roles.contestants],
        judge: ev.roles.judge,
        ...(ev.roles.implementer !== undefined ? { implementer: ev.roles.implementer } : {}),
        ...(ev.roles.reviewer !== undefined ? { reviewer: ev.roles.reviewer } : {}),
      },
      seed: ev.seed,
      config: ev.config,
      createdAt: ev.ts,
      updatedAt: ev.ts,
      lastSeq: ev.seq,
      status: "running",
      steps: {},
      stepOrder: [],
      quota: {},
      quotaWarned: [],
      costs: {},
      cancelRequested: false,
      warnings: [],
      retries: {},
    };
  }
  const s = state;
  s.updatedAt = ev.ts;
  s.lastSeq = ev.seq;
  const step = (id: string) => {
    const st = s.steps[id];
    if (!st) throw new Error(`event ${ev.seq} (${ev.type}) references unknown step ${id}`);
    return st;
  };

  switch (ev.type) {
    case "run_created":
      throw new Error(`duplicate run_created at seq ${ev.seq}`);
    case "driver_started":
    case "resumed":
      if (!TERMINAL_STATUSES.has(s.status)) s.status = "running";
      delete s.pause;
      break;
    case "step_started": {
      if (!(ev.stepId in s.steps)) s.stepOrder.push(ev.stepId);
      const prev = s.steps[ev.stepId];
      const st: StepState = {
        id: ev.stepId,
        status: "running",
        attempt: ev.attempt,
        startedAt: ev.ts,
        resolvedModels: [],
        toolCalls: 0,
        toolBlocked: 0,
      };
      if (ev.workerId !== undefined) st.workerId = ev.workerId;
      if (ev.label !== undefined) st.label = ev.label;
      if (prev?.checkpoint !== undefined) st.checkpoint = prev.checkpoint;
      s.steps[ev.stepId] = st;
      break;
    }
    case "worker_event": {
      const st = step(ev.stepId);
      const we = ev.event;
      if (we.type === "start" && we.sessionId) st.sessionId = we.sessionId;
      if (we.type === "tool_call") st.toolCalls++;
      if (we.type === "tool_blocked") st.toolBlocked++;
      if (we.type === "done") {
        st.sessionId = we.sessionId;
        st.resolvedModels = [...we.resolvedModels];
        st.effectiveReasoning = we.effectiveReasoning;
      }
      break;
    }
    case "step_completed": {
      const st = step(ev.stepId);
      st.status = "completed";
      st.endedAt = ev.ts;
      st.result = ev.result;
      delete st.failure;
      break;
    }
    case "step_failed": {
      const st = step(ev.stepId);
      st.status = "failed";
      st.endedAt = ev.ts;
      st.failure = { kind: ev.kind, reason: ev.reason };
      break;
    }
    case "step_timing": {
      const st = s.steps[ev.stepId];
      if (st && st.attempt === ev.attempt) st.timing = ev.timing;
      break;
    }
    case "step_abandoned": {
      const st = step(ev.stepId);
      st.status = "abandoned";
      st.endedAt = ev.ts;
      break;
    }
    case "checkpoint_created":
      step(ev.stepId).checkpoint = ev.sha;
      break;
    case "usage_recorded": {
      const t = (s.costs[ev.workerId] ??= emptyTotals());
      t.tokens.input += ev.tokens.input;
      t.tokens.output += ev.tokens.output;
      t.tokens.cacheRead += ev.tokens.cacheRead;
      t.tokens.cacheWrite += ev.tokens.cacheWrite;
      if (ev.costUsd === null) t.costUnknown = true;
      else t.costUsd += ev.costUsd;
      if (ev.vendorCostUsd !== undefined) t.vendorCostUsd += ev.vendorCostUsd;
      // A Claude worker that ran on extra usage at any point stays "overage" for the run.
      if (ev.billing !== undefined && t.billing !== "overage") t.billing = ev.billing;
      break;
    }
    case "step_retrying":
      s.retries[ev.stepId] = (s.retries[ev.stepId] ?? 0) + 1;
      break;
    case "retry_requested":
      // fractory resume --retry-failed: the run continues; the failed step reruns (next attempt).
      s.status = "running";
      delete s.failure;
      delete s.retries[ev.stepId];
      break;
    case "warning":
      s.warnings.push({ code: ev.code, message: ev.message, ...(ev.stepId !== undefined ? { stepId: ev.stepId } : {}) });
      break;
    case "worktrees_cleaned":
      s.cleaned = { at: ev.ts, paths: [...ev.paths] };
      break;
    case "quota_observed": {
      const q: QuotaState = { status: ev.status, windows: structuredClone(ev.windows), observedAt: ev.ts };
      if (ev.resetsAt !== undefined) q.resetsAt = ev.resetsAt;
      if (ev.overage !== undefined) q.overage = structuredClone(ev.overage);
      s.quota[ev.workerId] = q;
      break;
    }
    case "quota_warning": {
      const key = `${ev.workerId}:${ev.window}:${ev.source}`;
      if (!s.quotaWarned.includes(key)) s.quotaWarned.push(key);
      break;
    }
    case "paused_quota":
      s.status = "paused_quota";
      s.pause = { stepId: ev.stepId, workerId: ev.workerId, ...(ev.resetsAt !== undefined ? { resetsAt: ev.resetsAt } : {}) };
      break;
    case "awaiting_approval":
      s.status = "awaiting_approval";
      s.approval = { stepId: ev.stepId, items: structuredClone(ev.items), approvedItemIds: null };
      break;
    case "approval_given":
      if (!s.approval || s.approval.stepId !== ev.stepId) throw new Error(`approval for unknown gate ${ev.stepId}`);
      s.approval.approvedItemIds = [...ev.itemIds];
      break;
    case "needs_attention":
      s.status = "needs_attention";
      s.attention = { stepId: ev.stepId, changes: structuredClone(ev.changes) };
      break;
    case "attention_resolved":
      delete s.attention;
      break;
    case "cancel_requested":
      s.cancelRequested = true;
      break;
    case "run_cancelled":
      s.status = "cancelled";
      break;
    case "run_failed":
      s.status = "failed";
      s.failure = { kind: ev.kind, reason: ev.reason, ...(ev.stepId !== undefined ? { stepId: ev.stepId } : {}) };
      break;
    case "run_completed":
      s.status = "completed";
      if (ev.result !== undefined) s.result = ev.result;
      break;
    default: {
      const never: never = ev;
      throw new Error(`unhandled event ${(never as RunEvent).type}`);
    }
  }
  return s;
}

export function reduceAll(events: readonly RunEvent[]): RunState {
  let s: RunState | null = null;
  for (const ev of events) s = reduceInto(s, ev);
  if (s === null) throw new Error("empty event log");
  return s;
}
