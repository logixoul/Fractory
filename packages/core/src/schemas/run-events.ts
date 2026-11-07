import { z } from "zod";
import { QuotaWindow, UsageTokens, WorkerEvent } from "./worker-events.js";

export const Workflow = z.enum(["consensus", "duel", "test"]);
export type Workflow = z.infer<typeof Workflow>;

export const StepFailureKind = z.enum([
  "exit_check",
  "error",
  "timeout",
  "quota",
  "cancelled",
  "integrity",
  "env_error",
]);
export type StepFailureKind = z.infer<typeof StepFailureKind>;

const STEP_ID = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_.-]*$/, "invalid step id");
const base = { seq: z.number().int().positive(), ts: z.string() };
const stepRef = { stepId: STEP_ID, attempt: z.number().int().positive() };

export const FileChange = z.object({
  path: z.string(),
  /** "<XY> <hash>" snapshot entry, or null if absent */
  before: z.string().nullable(),
  after: z.string().nullable(),
});
export type FileChange = z.infer<typeof FileChange>;

/**
 * The append-only event log (events.jsonl) is the source of truth for a run.
 * state.json is derived from it by `reduce`.
 */
export const RunEvent = z.discriminatedUnion("type", [
  z.object({
    ...base,
    type: z.literal("run_created"),
    runId: z.string(),
    workflow: Workflow,
    repo: z.string(),
    promptFile: z.string(),
    promptSha256: z.string(),
    /** label → workerId. The only place the mapping exists (§8.16). */
    labels: z.record(z.string(), z.string()),
    roles: z.object({ contestants: z.tuple([z.string(), z.string()]), judge: z.string() }),
    seed: z.number().int(),
    config: z.unknown(),
    fractoryVersion: z.string(),
  }),
  z.object({ ...base, type: z.literal("driver_started"), pid: z.number().int(), hostname: z.string() }),
  z.object({
    ...base,
    type: z.literal("step_started"),
    ...stepRef,
    workerId: z.string().optional(),
    label: z.string().optional(),
  }),
  z.object({ ...base, type: z.literal("worker_event"), ...stepRef, event: WorkerEvent }),
  z.object({
    ...base,
    type: z.literal("step_completed"),
    ...stepRef,
    result: z.unknown(),
    durationMs: z.number().nonnegative(),
  }),
  z.object({ ...base, type: z.literal("step_failed"), ...stepRef, kind: StepFailureKind, reason: z.string() }),
  z.object({ ...base, type: z.literal("step_abandoned"), ...stepRef }),
  z.object({ ...base, type: z.literal("checkpoint_created"), stepId: STEP_ID, label: z.string(), sha: z.string() }),
  z.object({
    ...base,
    type: z.literal("usage_recorded"),
    ...stepRef,
    workerId: z.string(),
    priceKey: z.string(),
    tokens: UsageTokens,
    costUsd: z.number().nullable(),
    vendorCostUsd: z.number().optional(),
    warning: z.string().optional(),
  }),
  z.object({
    ...base,
    type: z.literal("quota_observed"),
    workerId: z.string(),
    status: z.string(),
    resetsAt: z.number().optional(),
    windows: z.record(z.string(), QuotaWindow),
  }),
  z.object({
    ...base,
    type: z.literal("quota_warning"),
    workerId: z.string(),
    window: z.string(),
    utilization: z.number(),
    threshold: z.number(),
    resetsAt: z.number().optional(),
    source: z.enum(["preflight", "live"]),
  }),
  z.object({
    ...base,
    type: z.literal("paused_quota"),
    stepId: STEP_ID,
    workerId: z.string(),
    resetsAt: z.number().optional(),
  }),
  z.object({ ...base, type: z.literal("awaiting_approval"), stepId: STEP_ID, items: z.array(z.unknown()) }),
  z.object({
    ...base,
    type: z.literal("approval_given"),
    stepId: STEP_ID,
    /** 1-based indexes into the gate's items. */
    itemIds: z.array(z.number().int().positive()),
  }),
  z.object({ ...base, type: z.literal("needs_attention"), stepId: STEP_ID, changes: z.array(FileChange) }),
  z.object({ ...base, type: z.literal("attention_resolved"), decision: z.literal("continue") }),
  z.object({ ...base, type: z.literal("resumed"), force: z.boolean() }),
  z.object({ ...base, type: z.literal("cancel_requested") }),
  z.object({ ...base, type: z.literal("run_cancelled"), reason: z.string() }),
  z.object({
    ...base,
    type: z.literal("run_failed"),
    stepId: STEP_ID.optional(),
    kind: StepFailureKind,
    reason: z.string(),
  }),
  z.object({ ...base, type: z.literal("run_completed"), result: z.unknown().optional() }),
]);

export type RunEvent = z.infer<typeof RunEvent>;
export type RunEventType = RunEvent["type"];
type DistributiveOmit<T, K extends PropertyKey> = T extends unknown ? Omit<T, K> : never;
/** What callers pass to `append`: seq and ts are assigned by the store. */
export type RunEventInput = DistributiveOmit<z.input<typeof RunEvent>, "seq" | "ts">;
export type RunCreatedEvent = Extract<RunEvent, { type: "run_created" }>;
