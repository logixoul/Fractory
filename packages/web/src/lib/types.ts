// Run state and event types come from @fractory/shared (type-only: erased at build time).
// Only the daemon's own response shapes are declared here.
import type { RunState as SharedRunState, WorkerTotals } from "@fractory/shared/state";

export type { FileChange, RunEvent, WorkerEvent } from "@fractory/shared/events";
export type { StepState, WorkerTotals } from "@fractory/shared/state";

/** GET /api/runs/:id: the run state plus the daemon's driver status. */
export type RunState = SharedRunState & {
  driving?: boolean;
  driverError?: string | null;
};

/** One row of GET /api/runs. */
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

/** GET /api/quota: the cross-run quota book. */
export interface QuotaEntry {
  status: string;
  resetsAt?: number;
  windows: Record<string, { utilization: number; resetsAt?: number }>;
  observedAt: number;
}

/** GET /api/start-info: defaults for the new-run form. */
export interface StartInfo {
  defaultRepo: string | null;
  recentRepos: string[];
}

/** GET /api/repo-check: live check of a typed repo path. */
export interface RepoCheck {
  ok: boolean;
  error?: string;
  root?: string;
  branch?: string | null;
  head?: string | null;
  dirty?: number;
  warnings?: string[];
}
