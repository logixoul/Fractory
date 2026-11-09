import { describe, expect, it } from "vitest";
import { formatTiming, stepTiming, type TimingEvent } from "../src/timing.js";

const T0 = Date.parse("2026-11-10T10:00:00.000Z");
const at = (ms: number) => new Date(T0 + ms).toISOString();
const step = (type: string, ms: number, attempt = 1): TimingEvent => ({ type, ts: at(ms), stepId: "judge", attempt });
const w = (ms: number, event: TimingEvent["event"], attempt = 1): TimingEvent => ({ type: "worker_event", ts: at(ms), stepId: "judge", attempt, event });
const usage = (output: number, reasoning?: number) => ({ type: "usage", tokens: { input: 100, output, cacheRead: 50, cacheWrite: 0, ...(reasoning !== undefined ? { reasoning } : {}) } });

describe("step timing breakdown", () => {
  it("Claude-style turns: each tool message is a round; tool vs generation vs orchestrator time; reasoning unknown", () => {
    const events = [
      step("step_started", 0),
      w(1_000, { type: "start" }),
      w(5_000, { type: "thinking" }),
      // turn 1: two parallel reads
      w(6_000, { type: "tool_call", id: "a" }),
      w(6_000, { type: "tool_call", id: "b" }),
      w(8_000, { type: "tool_result", id: "a" }),
      w(9_000, { type: "tool_result", id: "b" }),
      // turn 2: one read, directly after the results (no text in between)
      w(15_000, { type: "tool_call", id: "c" }),
      w(16_000, { type: "tool_result", id: "c" }),
      w(30_000, { type: "text" }),
      w(30_000, usage(4_000)),
      w(31_000, { type: "done" }),
      step("step_completed", 33_000),
    ];
    const t = stepTiming(events, "judge", 1)!;
    expect(t).toMatchObject({
      wallMs: 33_000,
      workerMs: 30_000,
      orchestratorMs: 3_000,
      toolCalls: 3,
      toolRounds: 2,
      toolMs: 4_000, // [6,9] merged + [15,16]
      generationMs: 26_000,
      outputTokens: 4_000,
      reasoningTokens: null,
      inputTokens: 150,
    });
    expect(t.invocations).toHaveLength(1);
    expect(formatTiming(t)).toBe("33s · 3 tool calls in 2 rounds · tools 4.0s · generation 26s · 4.0k out · 154 tok/s · orchestrator 3.0s");
  });

  it("Pi-style: calls before results are one round; several invocations (judge + swap pass); reasoning summed", () => {
    const events = [
      step("step_started", 0),
      w(0, { type: "start" }),
      w(1_000, { type: "tool_call", id: "1" }),
      w(1_000, { type: "tool_call", id: "2" }),
      w(1_000, { type: "tool_call", id: "3" }),
      w(2_000, { type: "tool_result", id: "1" }),
      w(2_500, { type: "tool_result", id: "2" }),
      w(3_000, { type: "tool_blocked", id: "3" }),
      w(10_000, usage(1_000, 600)),
      w(10_000, { type: "done" }),
      w(11_000, { type: "start" }),
      w(20_000, usage(500)), // no reasoning figure on this one
      w(20_000, { type: "done" }),
      step("step_completed", 20_000),
    ];
    const t = stepTiming(events, "judge", 1)!;
    expect(t).toMatchObject({ toolCalls: 3, toolRounds: 1, toolMs: 2_000, workerMs: 19_000, generationMs: 17_000, outputTokens: 1_500, reasoningTokens: 600 });
    expect(t.invocations.map((i) => [i.wallMs, i.toolRounds, i.outputTokens, i.reasoningTokens])).toEqual([
      [10_000, 1, 1_000, 600],
      [9_000, 0, 500, null],
    ]);
  });

  it("a running step is timed up to `endTs`; an unanswered tool call counts until then; other attempts are ignored", () => {
    const events = [
      step("step_started", 0, 1),
      w(500, { type: "start" }, 1),
      step("step_failed", 1_000, 1),
      step("step_started", 2_000, 2),
      w(2_000, { type: "start" }, 2),
      w(3_000, { type: "tool_call", id: "x" }, 2),
    ];
    const t = stepTiming(events, "judge", 2, T0 + 10_000)!;
    expect(t).toMatchObject({ wallMs: 8_000, workerMs: 8_000, toolMs: 7_000, generationMs: 1_000, toolCalls: 1, toolRounds: 1 });
    expect(stepTiming(events, "judge", 1)!.wallMs).toBe(1_000);
    expect(stepTiming(events, "judge", 3)).toBeUndefined();
  });
});
