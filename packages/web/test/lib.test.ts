import { describe, expect, it } from "vitest";
import { stripTokenFromUrl } from "../src/lib/api.js";
import { buildPanes, paneKey, phaseStatuses } from "../src/lib/panes.js";
import { findRefs, vscodeHref } from "../src/lib/refs.js";
import type { RunEvent, RunState } from "../src/lib/types.js";

let seq = 0;
const ev = (e: Record<string, unknown>): RunEvent => ({ seq: ++seq, ts: "2026-11-09T00:00:00Z", ...e }) as RunEvent;
const labels = { a1b2: "opus", c3d4: "deepseek" };

describe("panes", () => {
  it("groups steps per worker; judge and orchestrator steps get their own panes", () => {
    expect(paneKey("judge", "deepseek", "e5f6", labels)).toBe("judge");
    expect(paneKey("propose.c3d4", "deepseek", "c3d4", labels)).toBe("deepseek");
    expect(paneKey("check.0.a1b2", undefined, "a1b2", labels)).toBe("opus");
    expect(paneKey("setup", undefined, undefined, labels)).toBe("orchestrator");
  });

  it("merges text deltas, pairs tool calls with results and blocks, records status", () => {
    seq = 0;
    const events = [
      ev({ type: "step_started", stepId: "propose.a1b2", attempt: 1, workerId: "opus", label: "a1b2" }),
      ev({ type: "worker_event", stepId: "propose.a1b2", attempt: 1, event: { type: "start", requestedModel: "opus", resolvedModel: "claude-opus-5", requestedReasoning: "high" } }),
      ev({ type: "worker_event", stepId: "propose.a1b2", attempt: 1, event: { type: "text", text: "Hel" } }),
      ev({ type: "worker_event", stepId: "propose.a1b2", attempt: 1, event: { type: "text", text: "lo" } }),
      ev({ type: "worker_event", stepId: "propose.a1b2", attempt: 1, event: { type: "tool_call", id: "t1", name: "Read", input: { file_path: "a.ts" } } }),
      ev({ type: "worker_event", stepId: "propose.a1b2", attempt: 1, event: { type: "tool_result", id: "t1", isError: false, output: "1\tx" } }),
      ev({ type: "worker_event", stepId: "propose.a1b2", attempt: 1, event: { type: "tool_call", id: "t2", name: "Read", input: { file_path: "../b" } } }),
      ev({ type: "worker_event", stepId: "propose.a1b2", attempt: 1, event: { type: "tool_blocked", id: "t2", name: "Read", reason: "permission denied" } }),
      ev({ type: "step_completed", stepId: "propose.a1b2", attempt: 1, durationMs: 1500 }),
      ev({ type: "step_started", stepId: "judge", attempt: 1, workerId: "deepseek" }),
      ev({ type: "step_failed", stepId: "judge", attempt: 1, kind: "exit_check", reason: "bad" }),
    ];
    const panes = buildPanes(events, labels);
    expect(panes.map((p) => p.key)).toEqual(["deepseek", "opus", "judge"]);
    const opus = panes.find((p) => p.key === "opus")!.steps[0]!;
    expect(opus.status).toBe("completed");
    expect(opus.detail).toBe("1.5s");
    expect(opus.items.map((i) => i.kind)).toEqual(["start", "text", "tool", "tool"]);
    expect(opus.items[0]).toMatchObject({ text: "opus → claude-opus-5 (reasoning high)" });
    expect(opus.items[1]).toMatchObject({ text: "Hello" });
    expect(opus.items[2]).toMatchObject({ name: "Read", output: "1\tx", isError: false });
    expect(opus.items[3]).toMatchObject({ blocked: "permission denied" });
    expect(panes.find((p) => p.key === "judge")!.steps[0]).toMatchObject({ status: "failed", detail: "exit_check: bad" });
  });
});

describe("phase indicator", () => {
  const st = (steps: Record<string, string>, status = "running") =>
    ({
      workflow: "duel",
      status,
      steps: Object.fromEntries(Object.entries(steps).map(([id, s]) => [id, { id, status: s }])),
    }) as unknown as RunState;

  it("derives done/active/pending per phase", () => {
    const p = phaseStatuses(st({ setup: "completed", "implement.a": "completed", "implement.b": "completed", "check.0.a": "running" }));
    expect(p.slice(0, 4).map((x) => x.status)).toEqual(["done", "done", "active", "pending"]);
    const gate = phaseStatuses(st({ setup: "completed", judge: "completed" }, "awaiting_approval"));
    expect(gate.find((x) => x.phase === "approve")!.status).toBe("active");
  });
});

describe("refs → vscode links", () => {
  it("finds refs like core does, skipping URLs", () => {
    expect(findRefs("see src/a.ts:12 and https://x.io/a.js:3 and C:\\r\\b.ts:4").map((r) => [r.path, r.line])).toEqual([
      ["src/a.ts", 12],
      ["C:\\r\\b.ts", 4],
    ]);
  });

  it("builds vscode://file URLs for relative and absolute paths", () => {
    expect(vscodeHref("C:\\Users\\me\\repo", "src/a b.ts", 3)).toBe("vscode://file/C:/Users/me/repo/src/a%20b.ts:3");
    expect(vscodeHref("/home/me/repo/", "./x.ts", 1)).toBe("vscode://file/home/me/repo/x.ts:1");
    expect(vscodeHref("/r", "D:\\y\\z.ts", 9)).toBe("vscode://file/D:/y/z.ts:9");
  });
});

describe("token handling", () => {
  it("removes ?token= from the address bar and keeps the route", () => {
    const calls: string[] = [];
    const loc = { href: "http://127.0.0.1:5000/?token=abc&x=1#/run/r" } as Location;
    stripTokenFromUrl(loc, { replaceState: (_s: unknown, _t: string, url: string) => calls.push(url) } as unknown as History);
    expect(calls).toEqual(["/?x=1#/run/r"]);
  });
});
