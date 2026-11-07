import { describe, expect, it } from "vitest";
import { RunEvent } from "../src/schemas/run-events.js";
import { reduceAll } from "../src/state/reducer.js";

let seq = 0;
const ev = (e: Record<string, unknown>): RunEvent => RunEvent.parse({ seq: ++seq, ts: `2026-11-07T00:00:${String(seq).padStart(2, "0")}Z`, ...e });

function sample(): RunEvent[] {
  seq = 0;
  return [
    ev({
      type: "run_created",
      runId: "r",
      workflow: "test",
      repo: "/r",
      promptFile: "p",
      promptSha256: "x",
      labels: { a1b2: "opus", c3d4: "deepseek" },
      roles: { contestants: ["opus", "deepseek"], judge: "deepseek" },
      seed: 7,
      config: {},
      fractoryVersion: "t",
    }),
    ev({ type: "driver_started", pid: 1, hostname: "h" }),
    ev({ type: "step_started", stepId: "s", attempt: 1, workerId: "deepseek", label: "c3d4" }),
    ev({ type: "worker_event", stepId: "s", attempt: 1, event: { type: "tool_call", id: "1", name: "read", input: {} } }),
    ev({ type: "worker_event", stepId: "s", attempt: 1, event: { type: "tool_blocked", id: "2", name: "read", reason: "guard" } }),
    ev({
      type: "worker_event",
      stepId: "s",
      attempt: 1,
      event: { type: "done", sessionId: "sess-1", finalText: "hi", resolvedModels: ["together/x"], effectiveReasoning: "high" },
    }),
    ev({
      type: "usage_recorded",
      stepId: "s",
      attempt: 1,
      workerId: "deepseek",
      priceKey: "together/x",
      tokens: { input: 10, output: 5, cacheRead: 100 },
      costUsd: 0.25,
    }),
    ev({
      type: "usage_recorded",
      stepId: "s",
      attempt: 1,
      workerId: "deepseek",
      priceKey: "together/y",
      tokens: { input: 1, output: 1 },
      costUsd: null,
      warning: "no price configured",
    }),
    ev({ type: "step_completed", stepId: "s", attempt: 1, result: { ok: true }, durationMs: 5 }),
    ev({ type: "awaiting_approval", stepId: "gate", items: [{ a: 1 }, { b: 2 }] }),
    ev({ type: "approval_given", stepId: "gate", itemIds: [2] }),
  ];
}

describe("reducer", () => {
  it("derives step, cost and approval state", () => {
    const s = reduceAll(sample());
    expect(s.status).toBe("awaiting_approval");
    expect(s.steps.s).toMatchObject({
      status: "completed",
      sessionId: "sess-1",
      resolvedModels: ["together/x"],
      effectiveReasoning: "high",
      toolCalls: 1,
      toolBlocked: 1,
      result: { ok: true },
    });
    expect(s.costs.deepseek).toEqual({
      tokens: { input: 11, output: 6, cacheRead: 100, cacheWrite: 0 },
      costUsd: 0.25,
      costUnknown: true,
      vendorCostUsd: 0,
    });
    expect(s.approval).toEqual({ stepId: "gate", items: [{ a: 1 }, { b: 2 }], approvedItemIds: [2] });
  });

  it("is deterministic and JSON round-trip stable for every prefix", () => {
    const events = sample();
    for (let k = 1; k <= events.length; k++) {
      const a = reduceAll(events.slice(0, k));
      const b = reduceAll(structuredClone(events.slice(0, k)));
      expect(a).toEqual(b);
      expect(JSON.parse(JSON.stringify(a))).toEqual(a);
    }
  });

  it("rejects logs that do not start with run_created or reference unknown steps", () => {
    const events = sample();
    expect(() => reduceAll(events.slice(1))).toThrow(/first event must be run_created/);
    seq = events.length;
    expect(() => reduceAll([...events, ev({ type: "step_completed", stepId: "nope", attempt: 1, result: null, durationMs: 0 })])).toThrow(
      /unknown step nope/,
    );
  });
});
