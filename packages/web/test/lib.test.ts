import { describe, expect, it } from "vitest";
import { stripTokenFromUrl } from "../src/lib/api.js";
import { buildPanes, paneKey, phaseStatuses } from "../src/lib/panes.js";
import { findRefs } from "@fractory/shared/refs";
import { toRepoRelative, vscodeHref } from "../src/lib/refs.js";
import { latestHead, refContext, vscodeTarget } from "../src/lib/refctx.js";
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

  it("shows provider retries and step retries in the live view", () => {
    seq = 0;
    const s = { stepId: "propose.c3d4", attempt: 1 };
    const events = [
      ev({ type: "step_started", ...s, workerId: "deepseek", label: "c3d4" }),
      ev({ type: "worker_event", ...s, event: { type: "provider_retry", phase: "scheduled", attempt: 1, maxAttempts: 4, delayMs: 2000, message: "429 Too Many Requests" } }),
      ev({ type: "worker_event", ...s, event: { type: "provider_retry", phase: "finished", attempt: 1, success: true } }),
      ev({ type: "worker_event", ...s, event: { type: "provider_retry", phase: "finished", attempt: 4, success: false, message: "503" } }),
      ev({ type: "step_retrying", ...s, reason: "deepseek: transient: 429", delayMs: 60000 }),
    ];
    const items = buildPanes(events, labels).find((p) => p.key === "deepseek")!.steps[0]!.items;
    expect(items).toEqual([
      { kind: "retry", text: "provider retry 1/4 in 2.0s: 429 Too Many Requests" },
      { kind: "retry", text: "provider retry 1 succeeded" },
      { kind: "error", text: "provider retries gave up after 4: 503" },
      { kind: "retry", text: "transient failure, retrying the step in 60s: deepseek: transient: 429" },
    ]);
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

describe("refs → in-app file view", () => {
  it("uses the shared extractor (same forms as core), skipping URLs", () => {
    expect(findRefs("see src/a.ts:12 and https://x.io/a.js:3 and C:\\r\\b.ts:4-6").map((r) => [r.path, r.line, r.endLine])).toEqual([
      ["src/a.ts", 12, undefined],
      ["C:\\r\\b.ts", 4, 6],
    ]);
  });

  it("maps written paths to repo-relative ones through the known roots", () => {
    const roots = ["C:\\data\\worktrees\\r1\\a1b2", "C:\\Users\\me\\repo"];
    expect(toRepoRelative("src/a.ts", roots)).toBe("src/a.ts");
    expect(toRepoRelative("./src/a.ts", roots)).toBe("src/a.ts");
    expect(toRepoRelative("C:\\data\\worktrees\\r1\\a1b2\\src\\a.ts", roots)).toBe("src/a.ts");
    expect(toRepoRelative("c:/users/me/repo/x.ts", roots)).toBe("x.ts");
    expect(toRepoRelative("D:\\elsewhere\\x.ts", roots)).toBeNull();
    expect(toRepoRelative("../x.ts", roots)).toBeNull();
  });

  const st = (over: Record<string, unknown> = {}) =>
    ({
      runId: "20261109-000000-abcd",
      workflow: "duel",
      repo: "C:\\Users\\me\\repo",
      labels: { a1b2: "opus", c3d4: "deepseek" },
      stepOrder: ["setup", "implement.a1b2", "apply"],
      steps: {
        setup: { id: "setup", status: "completed", result: { base: "b0", judgeLabel: "e5f6", worktrees: { a1b2: "C:\\wt\\a1b2", c3d4: "C:\\wt\\c3d4", e5f6: "C:\\wt\\e5f6" } } },
        "implement.a1b2": { id: "implement.a1b2", label: "a1b2", status: "completed", result: { head: "h1" } },
        apply: { id: "apply", label: "a1b2", status: "completed", result: { head: "h2" } },
      },
      ...over,
    }) as unknown as RunState;

  it("VS Code opens the worktree when it exists, labelled; notes when it has moved on", () => {
    const atJudging = refContext(st(), { label: "a1b2", rev: "h1", revTitle: "opus head at judging" });
    expect(latestHead(st(), "a1b2")).toBe("h2");
    expect(atJudging.worktree).toEqual({ path: "C:\\wt\\a1b2", label: "opus (a1b2)", atRev: false });
    const t = vscodeTarget(atJudging, "src/a.ts", 7);
    expect(t.href).toBe("vscode://file/C:/wt/a1b2/src/a.ts:7");
    expect(t.label).toBe("Open in VS Code: opus (a1b2) worktree");
    expect(t.note).toMatch(/moved on/);
  });

  it("falls back to the main repo with a note once the worktrees are removed", () => {
    const ctx = refContext(st({ cleaned: { at: "x", paths: [] } }), { label: "a1b2" });
    expect(ctx.worktree).toBeUndefined();
    expect(ctx.rev).toBe("base");
    const t = vscodeTarget(ctx, "src/a b.ts", 3);
    expect(t.href).toBe("vscode://file/C:/Users/me/repo/src/a%20b.ts:3");
    expect(t.label).toBe("Open in VS Code: main repository");
    expect(t.note).toMatch(/may differ/);
  });

  it("vscode hrefs for POSIX roots", () => {
    expect(vscodeHref("/home/me/repo/", "x.ts", 1)).toBe("vscode://file/home/me/repo/x.ts:1");
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
