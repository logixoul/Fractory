import type { SnapshotCache } from "../git/snapshot.js";
import type { Config } from "../schemas/config.js";
import type { FileChange, RunEventInput } from "../schemas/run-events.js";
import type { DoneEvent } from "../schemas/worker-events.js";
import type { RunState } from "../state/reducer.js";
import type { RunHandle } from "../store/run-store.js";
import type { Worker, WorkerTask } from "../workers/types.js";

export type { FileChange };

export interface ExitCheckResult {
  ok: boolean;
  reason?: string;
}

export type WorkerRunOptions = Omit<WorkerTask, "signal" | "timeoutMs"> & { timeoutMs?: number };

export interface StepContext {
  readonly run: RunHandle;
  readonly stepId: string;
  readonly attempt: number;
  /** Aborted on cancel, timeout of the run, or when a sibling step fails hard. */
  readonly signal: AbortSignal;
  /** steps/<stepId>/ (inputs/, out/, artifacts/ exist). */
  readonly stepDir: string;
  readonly config: Config;
  /** Shared by every step of one drive() call (symlink inventories of run worktrees). */
  readonly snapshots?: SnapshotCache;
  state(): RunState;
  /** Runs one worker task, streaming its normalized events into the run log. */
  runWorker(workerId: string, task: WorkerRunOptions): Promise<DoneEvent>;
  /** Appends a step-level event (e.g. checkpoint_created). */
  record(event: RunEventInput): void;
  /** The step's result stands, but the run pauses in needs_attention after this stage (§8.14). */
  flagAttention(changes: FileChange[]): void;
}

export interface WorkStep {
  kind?: "work";
  id: string;
  workerId?: string;
  label?: string;
  /** Returns the step's JSON result (stored in step_completed). */
  run(ctx: StepContext): Promise<unknown>;
  /** Machine-checkable exit condition (rule 6). Never "the model said it's done". */
  exitCheck?(ctx: StepContext, result: unknown): ExitCheckResult | Promise<ExitCheckResult>;
}

export interface ApprovalGate {
  kind: "approval_gate";
  id: string;
  /** Items shown to the human; approval selects 1-based indexes. */
  items(state: RunState): unknown[];
}

export type StepDef = WorkStep | ApprovalGate;

export type Next = { kind: "stage"; steps: StepDef[] } | { kind: "done"; result?: unknown };

/**
 * A workflow is an explicit, deterministic state machine: `next` is a pure function of the
 * run state (completed step results), returning the next stage or done (rule 1).
 * Steps in one stage run in parallel.
 */
export interface WorkflowDef {
  readonly name: string;
  next(state: RunState): Next;
}

export interface EngineDeps {
  workers: Record<string, Worker>;
  config: Config;
  /** <dataDir>/quota.json for cross-run pre-flight warnings. */
  quotaFile?: string;
  now?: () => number;
  cancelPollMs?: number;
}
