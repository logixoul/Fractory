import type { RunEvent, StepFailureKind, Workflow } from "../schemas/run-events.js";
import type { UsageTokens } from "../schemas/worker-events.js";

export type RunStatus =
  | "running"
  | "paused_quota"
  | "awaiting_approval"
  | "needs_attention"
  | "failed"
  | "cancelled"
  | "completed";

export const TERMINAL_STATUSES: ReadonlySet<RunStatus> = new Set(["failed", "cancelled", "completed"]);

export interface StepState {
  id: string;
  status: "running" | "completed" | "failed" | "abandoned";
  attempt: number;
  workerId?: string;
  label?: string;
  startedAt: string;
  endedAt?: string;
  result?: unknown;
  failure?: { kind: StepFailureKind; reason: string };
  sessionId?: string;
  resolvedModels: string[];
  effectiveReasoning?: string | null;
  checkpoint?: string;
  toolCalls: number;
  toolBlocked: number;
}

export interface WorkerTotals {
  tokens: Required<Omit<UsageTokens, "reasoning">>;
  costUsd: number;
  /** true when at least one usage record had no computable cost */
  costUnknown: boolean;
  vendorCostUsd: number;
}

export interface QuotaState {
  status: string;
  resetsAt?: number;
  windows: Record<string, { utilization: number; resetsAt?: number }>;
  observedAt: string;
}

export interface RunState {
  runId: string;
  workflow: Workflow;
  repo: string;
  promptFile: string;
  promptSha256: string;
  labels: Record<string, string>;
  roles: { contestants: [string, string]; judge: string };
  seed: number;
  config: unknown;
  createdAt: string;
  updatedAt: string;
  lastSeq: number;
  status: RunStatus;
  steps: Record<string, StepState>;
  stepOrder: string[];
  pause?: { stepId: string; workerId: string; resetsAt?: number };
  approval?: { stepId: string; items: unknown[]; approvedItemIds: number[] | null };
  attention?: { stepId: string; changes: { path: string; before: string | null; after: string | null }[] };
  quota: Record<string, QuotaState>;
  /** "<workerId>:<window>:<preflight|live>" keys already warned about in this run */
  quotaWarned: string[];
  costs: Record<string, WorkerTotals>;
  cancelRequested: boolean;
  failure?: { stepId?: string; kind: StepFailureKind; reason: string };
  result?: unknown;
}

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
      roles: { contestants: [...ev.roles.contestants], judge: ev.roles.judge },
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
      break;
    }
    case "quota_observed": {
      const q: QuotaState = { status: ev.status, windows: structuredClone(ev.windows), observedAt: ev.ts };
      if (ev.resetsAt !== undefined) q.resetsAt = ev.resetsAt;
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
