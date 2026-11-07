import { z } from "zod";

export const UsageTokens = z.object({
  /** Uncached input tokens (both vendors report cached tokens separately). */
  input: z.number().int().nonnegative(),
  output: z.number().int().nonnegative(),
  cacheRead: z.number().int().nonnegative().default(0),
  cacheWrite: z.number().int().nonnegative().default(0),
  /** Informational; already included in `output` by both vendors. */
  reasoning: z.number().int().nonnegative().optional(),
});
export type UsageTokens = z.infer<typeof UsageTokens>;

export const QuotaWindow = z.object({
  utilization: z.number().min(0),
  /** epoch ms */
  resetsAt: z.number().optional(),
});

/**
 * Normalized worker stream. Adapters translate vendor events into these; the raw
 * vendor stream is kept separately per step for debugging. All times are epoch ms.
 */
export const WorkerEvent = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("start"),
    sessionId: z.string().optional(),
    resolvedModel: z.string().optional(),
    requestedModel: z.string().optional(),
    requestedReasoning: z.string().optional(),
  }),
  z.object({ type: z.literal("text"), text: z.string() }),
  z.object({ type: z.literal("thinking"), text: z.string() }),
  z.object({ type: z.literal("tool_call"), id: z.string(), name: z.string(), input: z.unknown() }),
  z.object({ type: z.literal("tool_result"), id: z.string(), isError: z.boolean(), output: z.string() }),
  z.object({ type: z.literal("tool_blocked"), id: z.string(), name: z.string(), reason: z.string() }),
  z.object({
    type: z.literal("usage"),
    provider: z.string(),
    model: z.string(),
    tokens: UsageTokens,
    vendorCostUsd: z.number().optional(),
  }),
  z.object({
    type: z.literal("rate_limit"),
    /** "allowed" | "allowed_warning" | anything else = exhausted */
    status: z.string(),
    resetsAt: z.number().optional(),
    windows: z.record(z.string(), QuotaWindow).default({}),
  }),
  z.object({
    type: z.literal("error"),
    kind: z.enum(["quota", "timeout", "killed", "auth", "process", "protocol", "model"]),
    message: z.string(),
    resetsAt: z.number().optional(),
  }),
  z.object({ type: z.literal("noise"), stream: z.enum(["stdout", "stderr"]), text: z.string() }),
  z.object({
    type: z.literal("done"),
    sessionId: z.string(),
    finalText: z.string(),
    structured: z.unknown().optional(),
    resolvedModels: z.array(z.string()).default([]),
    effectiveReasoning: z.string().nullable().default(null),
  }),
]);

export type WorkerEvent = z.infer<typeof WorkerEvent>;
export type WorkerEventInput = z.input<typeof WorkerEvent>;
export type DoneEvent = Extract<WorkerEvent, { type: "done" }>;

export function isQuotaExhaustedStatus(status: string): boolean {
  return status !== "allowed" && status !== "allowed_warning";
}
