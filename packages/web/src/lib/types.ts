// The subset of core's RunState / RunEvent shapes the GUI reads. The GUI is a pure view over
// the daemon API; it never imports core (which is Node-only).

export type RunStatus = "running" | "paused_quota" | "awaiting_approval" | "needs_attention" | "failed" | "cancelled" | "completed";

export interface StepState {
  id: string;
  status: "running" | "completed" | "failed" | "abandoned";
  attempt: number;
  workerId?: string;
  label?: string;
  startedAt: string;
  endedAt?: string;
  result?: unknown;
  failure?: { kind: string; reason: string };
  sessionId?: string;
  resolvedModels: string[];
  effectiveReasoning?: string | null;
  toolCalls: number;
  toolBlocked: number;
}

export interface WorkerTotals {
  tokens: { input: number; output: number; cacheRead: number; cacheWrite: number };
  costUsd: number;
  costUnknown: boolean;
  vendorCostUsd: number;
  billing?: "metered" | "subscription";
}

export interface FileChange {
  path: string;
  before: string | null;
  after: string | null;
}

export interface RunState {
  runId: string;
  workflow: "consensus" | "duel" | "test";
  repo: string;
  labels: Record<string, string>;
  roles: { contestants: [string, string]; judge: string };
  createdAt: string;
  updatedAt: string;
  lastSeq: number;
  status: RunStatus;
  steps: Record<string, StepState>;
  stepOrder: string[];
  pause?: { stepId: string; workerId: string; resetsAt?: number };
  approval?: { stepId: string; items: unknown[]; approvedItemIds: number[] | null };
  attention?: { stepId: string; changes: FileChange[] };
  costs: Record<string, WorkerTotals>;
  failure?: { stepId?: string; kind: string; reason: string };
  result?: unknown;
  config: { workers?: Record<string, { kind?: string; model?: string }> };
  warnings?: { code: string; message: string; stepId?: string }[];
  retries?: Record<string, number>;
  cleaned?: { at: string; paths: string[] };
  /** Added by the daemon. */
  driving?: boolean;
  driverError?: string | null;
}

export interface RunSummary {
  runId: string;
  workflow?: string;
  status: string;
  repo?: string;
  createdAt?: string;
  updatedAt?: string;
  driving?: boolean;
  costs?: Record<string, WorkerTotals>;
  workerKinds?: Record<string, string>;
}

export type WorkerEvent =
  | { type: "start"; sessionId?: string; resolvedModel?: string; requestedModel?: string; requestedReasoning?: string }
  | { type: "text" | "thinking"; text: string }
  | { type: "tool_call"; id: string; name: string; input: unknown }
  | { type: "tool_result"; id: string; isError: boolean; output: string }
  | { type: "tool_blocked"; id: string; name: string; reason: string }
  | { type: "usage"; provider: string; model: string; tokens: Record<string, number> }
  | { type: "rate_limit"; status: string; resetsAt?: number }
  | { type: "error"; kind: string; message: string }
  | { type: "noise"; stream: string; text: string }
  | { type: "done"; sessionId: string; finalText: string; resolvedModels: string[]; effectiveReasoning: string | null };

export type RunEvent = { seq: number; ts: string } & (
  | { type: "run_created"; labels: Record<string, string> }
  | { type: "step_started"; stepId: string; attempt: number; workerId?: string; label?: string }
  | { type: "step_completed"; stepId: string; attempt: number; durationMs: number }
  | { type: "step_failed"; stepId: string; attempt: number; kind: string; reason: string }
  | { type: "step_abandoned"; stepId: string; attempt: number }
  | { type: "worker_event"; stepId: string; attempt: number; event: WorkerEvent }
  | { type: "checkpoint_created"; stepId: string; sha: string }
  | { type: "step_retrying"; stepId: string; attempt: number; reason: string; delayMs: number }
  | { type: string; stepId?: string }
);

export interface QuotaEntry {
  status: string;
  resetsAt?: number;
  windows: Record<string, { utilization: number; resetsAt?: number }>;
  observedAt: number;
}
