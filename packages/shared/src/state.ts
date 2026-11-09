// Derived run state (state.json) shapes, shared by core (reducer) and the GUI.
import type { StepFailureKind, Workflow } from "./run-events.js";
import type { StepTiming } from "./timing.js";
import type { UsageTokens } from "./worker-events.js";

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
  /** Timing breakdown of the latest finished attempt (step_timing). */
  timing?: StepTiming;
}

export interface WorkerTotals {
  tokens: Required<Omit<UsageTokens, "reasoning">>;
  costUsd: number;
  /** true when at least one usage record had no computable cost */
  costUnknown: boolean;
  vendorCostUsd: number;
  /** "subscription": not metered (Claude Pro); vendorCostUsd is API-equivalent only. */
  billing?: "metered" | "subscription";
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
  roles: { contestants: [string, string]; judge: string; implementer?: string; reviewer?: string };
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
  /** Non-blocking warnings (dirty repo at start, identity tokens in judge diffs, ...). */
  warnings: { code: string; message: string; stepId?: string }[];
  /** Automatic transient retries per step id. */
  retries: Record<string, number>;
  /** Set once fractory clean/gc removed the run's worktrees (branches are kept). */
  cleaned?: { at: string; paths: string[] };
}
