// Per-step timing breakdown (Node-free: the engine records it in `step_timing`, the GUI computes
// it live for running steps). Derived only from the event log's timestamps, so it is approximate:
//  - tool time   = union of [tool_call, tool_result | tool_blocked] intervals (parallel calls merged)
//  - worker time = union of worker invocations, [start, done | error]
//  - generation  = worker time − tool time: the model thinking and writing, plus network and
//                  harness latency between turns (not separable from the stream)
//  - orchestrator = wall time − worker time: gates, snapshots, checks, process spawn
// A slow judge then reads as "many tool rounds" (tool time, rounds) vs "slow tokens"
// (generation time per output token).
import { z } from "zod";

export const InvocationTiming = z.object({
  wallMs: z.number().nonnegative(),
  toolMs: z.number().nonnegative(),
  generationMs: z.number().nonnegative(),
  toolCalls: z.number().int().nonnegative(),
  /** Model turns that issued tool calls (consecutive calls without other output count once). */
  toolRounds: z.number().int().nonnegative(),
  outputTokens: z.number().int().nonnegative(),
  /** Null when the worker does not report reasoning tokens separately (Claude counts them in output). */
  reasoningTokens: z.number().int().nonnegative().nullable(),
});
export type InvocationTiming = z.infer<typeof InvocationTiming>;

export const StepTiming = InvocationTiming.extend({
  workerMs: z.number().nonnegative(),
  orchestratorMs: z.number().nonnegative(),
  /** Uncached + cached input tokens. */
  inputTokens: z.number().int().nonnegative(),
  /** One entry per worker invocation (a step may run several: repair turns, the swap pass). */
  invocations: z.array(InvocationTiming),
});
export type StepTiming = z.infer<typeof StepTiming>;

/** The subset of run events the computation reads (structural, so core and web types both fit). */
export interface TimingEvent {
  type: string;
  ts: string;
  stepId?: string;
  attempt?: number;
  event?: { type: string; id?: string; tokens?: { input: number; output: number; cacheRead?: number; cacheWrite?: number; reasoning?: number } };
}

type Interval = [number, number];

function unionMs(intervals: Interval[]): number {
  const sorted = intervals.filter(([a, b]) => b > a).sort((x, y) => x[0] - y[0]);
  let total = 0;
  let cur: Interval | undefined;
  for (const iv of sorted) {
    if (!cur || iv[0] > cur[1]) {
      if (cur) total += cur[1] - cur[0];
      cur = [iv[0], iv[1]];
    } else cur[1] = Math.max(cur[1], iv[1]);
  }
  if (cur) total += cur[1] - cur[0];
  return total;
}

/** Metadata events: they neither start nor end a tool round. */
const NEUTRAL = new Set(["usage", "noise", "rate_limit", "provider_retry"]);

interface Acc {
  start: number;
  end?: number;
  tools: Interval[];
  open: Map<string, number>;
  toolCalls: number;
  toolRounds: number;
  lastWasCall: boolean;
  output: number;
  reasoning: number | null;
  input: number;
}

/**
 * Timing of one attempt of a step. `events` may be the whole log (filtered here). `endTs` is the
 * step's end (epoch ms); for a running step pass "now". Unclosed intervals end there.
 */
export function stepTiming(events: readonly TimingEvent[], stepId: string, attempt: number, endTs?: number): StepTiming | undefined {
  let started: number | undefined;
  let ended: number | undefined;
  const invocations: Acc[] = [];
  let cur: Acc | undefined;
  const t = (e: TimingEvent) => Date.parse(e.ts);
  for (const e of events) {
    if (e.stepId !== stepId || e.attempt !== attempt) continue;
    if (e.type === "step_started") started = t(e);
    else if (e.type === "step_completed" || e.type === "step_failed" || e.type === "step_abandoned") ended = t(e);
    if (e.type !== "worker_event" || !e.event) continue;
    const w = e.event;
    const at = t(e);
    if (w.type === "start" || !cur) {
      cur = { start: at, tools: [], open: new Map(), toolCalls: 0, toolRounds: 0, lastWasCall: false, output: 0, reasoning: null, input: 0 };
      invocations.push(cur);
      if (w.type === "start") continue;
    }
    switch (w.type) {
      case "tool_call":
        cur.toolCalls++;
        // A round = the calls of one model turn: a call right after another call, or while calls
        // are still open (all calls of a message come before their results), joins the round.
        if (!cur.lastWasCall && cur.open.size === 0) cur.toolRounds++;
        cur.lastWasCall = true;
        if (w.id) cur.open.set(w.id, at);
        break;
      case "tool_result":
      case "tool_blocked": {
        const from = w.id ? cur.open.get(w.id) : undefined;
        if (from !== undefined) {
          cur.tools.push([from, at]);
          cur.open.delete(w.id!);
        }
        break;
      }
      case "usage":
        if (w.tokens) {
          cur.output += w.tokens.output;
          cur.input += w.tokens.input + (w.tokens.cacheRead ?? 0) + (w.tokens.cacheWrite ?? 0);
          if (w.tokens.reasoning !== undefined) cur.reasoning = (cur.reasoning ?? 0) + w.tokens.reasoning;
        }
        break;
      case "done":
      case "error":
        cur.end = at;
        break;
    }
    if (!NEUTRAL.has(w.type) && w.type !== "tool_call") cur.lastWasCall = false;
    if (w.type === "done" || w.type === "error") cur = undefined;
  }
  if (started === undefined) return undefined;
  const end = ended ?? endTs ?? started;
  const per: InvocationTiming[] = [];
  const workerIntervals: Interval[] = [];
  const allTools: Interval[] = [];
  for (const a of invocations) {
    const stop = Math.min(a.end ?? end, end);
    for (const from of a.open.values()) a.tools.push([from, stop]);
    const toolMs = unionMs(a.tools);
    const wallMs = Math.max(0, stop - a.start);
    workerIntervals.push([a.start, stop]);
    allTools.push(...a.tools);
    per.push({
      wallMs,
      toolMs,
      generationMs: Math.max(0, wallMs - toolMs),
      toolCalls: a.toolCalls,
      toolRounds: a.toolRounds,
      outputTokens: a.output,
      reasoningTokens: a.reasoning,
    });
  }
  const wallMs = Math.max(0, end - started);
  const workerMs = unionMs(workerIntervals);
  const toolMs = unionMs(allTools);
  const reasoning = per.some((p) => p.reasoningTokens !== null) ? per.reduce((n, p) => n + (p.reasoningTokens ?? 0), 0) : null;
  return {
    wallMs,
    workerMs,
    toolMs,
    generationMs: Math.max(0, workerMs - toolMs),
    orchestratorMs: Math.max(0, wallMs - workerMs),
    toolCalls: per.reduce((n, p) => n + p.toolCalls, 0),
    toolRounds: per.reduce((n, p) => n + p.toolRounds, 0),
    outputTokens: per.reduce((n, p) => n + p.outputTokens, 0),
    reasoningTokens: reasoning,
    inputTokens: invocations.reduce((n, a) => n + a.input, 0),
    invocations: per,
  };
}

const secs = (ms: number) => (ms < 60_000 ? `${(ms / 1000).toFixed(ms < 10_000 ? 1 : 0)}s` : `${Math.floor(ms / 60_000)}m ${String(Math.round((ms % 60_000) / 1000)).padStart(2, "0")}s`);
const k = (n: number) => (n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n));

/** One-line summary, e.g. "4m 10s · 14 tool calls in 6 rounds · tools 40s · generation 3m 20s · 8.1k out (5.2k reasoning) · 41 tok/s". */
export function formatTiming(x: StepTiming): string {
  const parts = [secs(x.wallMs)];
  if (x.toolCalls > 0) parts.push(`${x.toolCalls} tool call${x.toolCalls === 1 ? "" : "s"} in ${x.toolRounds} round${x.toolRounds === 1 ? "" : "s"}`, `tools ${secs(x.toolMs)}`);
  if (x.workerMs > 0) parts.push(`generation ${secs(x.generationMs)}`);
  if (x.outputTokens > 0) {
    parts.push(`${k(x.outputTokens)} out${x.reasoningTokens !== null ? ` (${k(x.reasoningTokens)} reasoning)` : ""}`);
    if (x.generationMs >= 1000) parts.push(`${Math.round(x.outputTokens / (x.generationMs / 1000))} tok/s`);
  }
  if (x.orchestratorMs >= 1000) parts.push(`orchestrator ${secs(x.orchestratorMs)}`);
  if (x.invocations.length > 1) parts.push(`${x.invocations.length} invocations`);
  return parts.join(" · ");
}
