import * as fs from "node:fs";
import * as path from "node:path";
import { describe, expect, it } from "vitest";
import { approveRun, cancelRun } from "../src/engine/control.js";
import { drive } from "../src/engine/drive.js";
import { ResumeRefusedError } from "../src/engine/errors.js";
import { updateQuotaBook } from "../src/engine/quota-book.js";
import type { EngineDeps, WorkflowDef } from "../src/engine/types.js";
import { reduceAll } from "../src/state/reducer.js";
import { RunStore, readEventsFile } from "../src/store/run-store.js";
import { Redactor } from "../src/util/redact.js";
import { FakeWorker, fakeQuotaExhausted, type FakeScript } from "../src/workers/fake.js";
import { demoWorkflow, labelOf, newTestRun, testConfig, tmpDir, waitFor } from "./helpers.js";

function setup(opts: { opus?: FakeScript[]; deepseek?: FakeScript[]; config?: unknown; quotaFile?: boolean } = {}) {
  const dataDir = tmpDir();
  const store = new RunStore(dataDir, new Redactor([]));
  const opus = new FakeWorker("opus", opts.opus ?? [{ match: "propose", finalText: "plan O", sessionId: "s-opus" }, { match: "apply", finalText: "applied" }]);
  const deepseek = new FakeWorker("deepseek", opts.deepseek ?? [{ match: "propose", finalText: "plan D", sessionId: "s-ds" }]);
  const deps: EngineDeps = {
    workers: { opus, deepseek },
    config: testConfig(opts.config ?? {}),
    cancelPollMs: 10,
    ...(opts.quotaFile ? { quotaFile: path.join(dataDir, "quota.json") } : {}),
  };
  const run = newTestRun(store);
  return { dataDir, store, opus, deepseek, deps, run };
}

const types = (run: { events(): { type: string }[] }) => run.events().map((e) => e.type);

describe("engine: happy path and determinism", () => {
  it("runs parallel steps, pauses at the gate, then resumes the recorded session", async () => {
    const { run, deps, opus, deepseek } = setup();
    const wf = demoWorkflow();

    let st = await drive(run, wf, deps);
    expect(st.status).toBe("awaiting_approval");
    expect(st.approval?.items).toHaveLength(2);
    expect(opus.calls).toHaveLength(1);
    expect(deepseek.calls).toHaveLength(1);

    await expect(drive(run, wf, deps)).rejects.toBeInstanceOf(ResumeRefusedError);
    approveRun(run, [1]);
    st = await drive(run, wf, deps);
    expect(st.status).toBe("completed");
    expect(st.result).toEqual({ applied: "applied" });
    expect(opus.calls[1]?.sessionId).toBe("s-opus");
    expect(opus.calls[1]?.prompt).toBe("apply [1]");
    expect(deepseek.calls).toHaveLength(1);

    const events = run.events();
    expect(reduceAll(events)).toEqual(run.state());
    expect(JSON.parse(fs.readFileSync(run.stateFile, "utf8"))).toEqual(run.state());

    const before = run.state().lastSeq;
    await drive(run, wf, deps); // completed run: no-op
    expect(run.state().lastSeq).toBe(before);
  });

  it("validates approvals", async () => {
    const { run, deps } = setup();
    expect(() => approveRun(run, [1])).toThrow(/not awaiting approval/);
    await drive(run, demoWorkflow(), deps);
    expect(() => approveRun(run, [3])).toThrow(/valid range is 1..2/);
    expect(approveRun(run, [2, 1, 2])).toEqual([1, 2]);
  });
});

describe("engine: crash recovery", () => {
  it("skips completed steps, abandons and reruns the partial one, repairs a torn tail", async () => {
    const { run, deps, opus, deepseek } = setup();
    const st0 = run.state();
    const a = `propose.${labelOf(st0, "opus")}`;
    const b = `propose.${labelOf(st0, "deepseek")}`;

    // What a crash mid-stage leaves behind: B finished, A started, a torn write.
    const release = run.acquireWriter();
    run.append({ type: "driver_started", pid: 999_999, hostname: "h" });
    run.append({ type: "step_started", stepId: a, attempt: 1, workerId: "opus" });
    run.append({ type: "step_started", stepId: b, attempt: 1, workerId: "deepseek" });
    run.append({ type: "step_completed", stepId: b, attempt: 1, result: { text: "plan D (pre-crash)", sessionId: "s-ds" }, durationMs: 1 });
    release();
    fs.appendFileSync(run.eventsFile, '{"seq":99,"type":"worker_ev');

    const st = await drive(run, demoWorkflow(), deps);
    expect(st.status).toBe("awaiting_approval");
    expect(deepseek.calls).toHaveLength(0);
    expect(opus.calls).toHaveLength(1);
    expect(st.steps[a]).toMatchObject({ status: "completed", attempt: 2 });
    expect(st.steps[b]).toMatchObject({ status: "completed", attempt: 1, result: { text: "plan D (pre-crash)" } });
    const evs = run.events();
    expect(evs.some((e) => e.type === "step_abandoned" && e.stepId === a && e.attempt === 1)).toBe(true);
    expect(readEventsFile(run.eventsFile).tornTailBytes).toBe(0);
  });
});

describe("engine: quota", () => {
  it("pauses with the reset time, keeps sibling work, refuses early resume unless forced", async () => {
    const resetsAt = Date.now() + 3_600_000;
    const { run, deps, opus, deepseek } = setup({
      opus: [
        { match: "propose", actions: fakeQuotaExhausted(resetsAt) },
        { match: "propose", finalText: "plan O" },
      ],
    });
    const wf = demoWorkflow();
    let st = await drive(run, wf, deps);
    expect(st.status).toBe("paused_quota");
    expect(st.pause).toEqual({ stepId: `propose.${labelOf(st, "opus")}`, workerId: "opus", resetsAt });
    expect(st.steps[`propose.${labelOf(st, "deepseek")}`]?.status).toBe("completed");
    expect(st.quota.opus?.status).toBe("rejected");

    await expect(drive(run, wf, deps)).rejects.toThrow(/resets at/);
    st = await drive(run, wf, deps, { force: true });
    expect(st.status).toBe("awaiting_approval");
    expect(opus.calls).toHaveLength(2);
    expect(deepseek.calls).toHaveLength(1);
    expect(types(run)).toContain("resumed");
  });

  it("resumes without force once the reset time has passed", async () => {
    const resetsAt = Date.now() + 3_600_000;
    const { run, deps } = setup({
      opus: [{ match: "propose", actions: fakeQuotaExhausted(resetsAt) }, { match: "propose", finalText: "ok" }],
    });
    await drive(run, demoWorkflow(), deps);
    const st = await drive(run, demoWorkflow(), { ...deps, now: () => resetsAt + 1 });
    expect(st.status).toBe("awaiting_approval");
  });

  it("warns once per window at the configured utilization (live) and from the quota book (preflight)", async () => {
    const future = Date.now() + 3_600_000;
    const rl = { type: "rate_limit" as const, status: "allowed", resetsAt: future, windows: { five_hour: { utilization: 0.85, resetsAt: future } } };
    const { run, deps, dataDir } = setup({
      quotaFile: true,
      opus: [{ match: "propose", finalText: "x", actions: [{ emit: rl }, { emit: rl }] }],
    });
    updateQuotaBook(path.join(dataDir, "quota.json"), "deepseek", {
      status: "allowed",
      windows: { seven_day: { utilization: 0.9, resetsAt: future } },
      observedAt: Date.now(),
    });
    await drive(run, demoWorkflow(), deps);
    const warnings = run.events().filter((e) => e.type === "quota_warning");
    expect(warnings.map((w) => [w.workerId, w.window, w.source])).toEqual([
      ["deepseek", "seven_day", "preflight"],
      ["opus", "five_hour", "live"],
    ]);
    const book = JSON.parse(fs.readFileSync(path.join(dataDir, "quota.json"), "utf8"));
    expect(book.opus.windows.five_hour.utilization).toBe(0.85);
  });

  it("pauses proactively above abortUtilization", async () => {
    const future = Date.now() + 3_600_000;
    const { run, deps } = setup({
      config: { quota: { abortUtilization: 0.95 } },
      opus: [
        {
          match: "propose",
          finalText: "x",
          actions: [{ emit: { type: "rate_limit", status: "allowed", windows: { five_hour: { utilization: 0.97, resetsAt: future } } } }],
        },
      ],
    });
    const st = await drive(run, demoWorkflow(), deps);
    expect(st.status).toBe("paused_quota");
    expect(st.pause?.resetsAt).toBe(future);
  });
});

describe("engine: failures and cancellation", () => {
  it("fails the run on an exit-check failure and aborts the hanging sibling", async () => {
    const { run, deps } = setup({
      opus: [{ match: "propose", actions: [{ hang: true }] }],
      deepseek: [{ match: "propose", finalText: "" }],
    });
    const t0 = Date.now();
    const st = await drive(run, demoWorkflow(), deps);
    expect(Date.now() - t0).toBeLessThan(5000);
    expect(st.status).toBe("failed");
    expect(st.failure).toMatchObject({ kind: "exit_check", stepId: `propose.${labelOf(st, "deepseek")}`, reason: "empty proposal" });
    expect(st.steps[`propose.${labelOf(st, "opus")}`]?.failure).toEqual({ kind: "cancelled", reason: "aborted: a sibling step failed" });
  });

  it("maps a worker timeout to a timeout failure", async () => {
    const { run, deps } = setup({
      config: { timeouts: { workerMs: 50 } },
      deepseek: [{ match: "propose", actions: [{ hang: true }] }],
    });
    const st = await drive(run, demoWorkflow(), deps);
    expect(st.failure?.kind).toBe("timeout");
  });

  it("fails on invalid worker events, adapter exceptions and missing done", async () => {
    for (const bad of [
      { match: "propose", actions: [{ emit: { type: "usage", provider: "x" } as never }] },
      { match: "propose", actions: [{ throw: "adapter exploded" }] },
      { match: "propose", noDone: true },
    ] satisfies FakeScript[]) {
      const { run, deps } = setup({ deepseek: [bad] });
      const st = await drive(run, demoWorkflow(), deps);
      expect(st.status).toBe("failed");
      expect(st.failure?.reason).toMatch(/invalid event|adapter exploded|without a done event/);
    }
  });

  it("cancels a running driver from another process via the request file", async () => {
    const { run, deps, store } = setup({ opus: [{ match: "propose", actions: [{ hang: true }] }] });
    const p = drive(run, demoWorkflow(), deps);
    const other = store.open(run.runId);
    await waitFor(() => Object.values(other.state().steps).some((s) => s.workerId === "opus" && s.status === "running"));
    expect(cancelRun(other)).toBe("requested");
    const st = await p;
    expect(st.status).toBe("cancelled");
    expect(st.steps[`propose.${labelOf(st, "opus")}`]?.failure?.kind).toBe("cancelled");
  });

  it("cancels an idle (paused) run directly, and stays cancelled", async () => {
    const { run, deps } = setup();
    await drive(run, demoWorkflow(), deps);
    expect(cancelRun(run)).toBe("cancelled");
    expect(cancelRun(run)).toBe("already_terminal");
    expect((await drive(run, demoWorkflow(), deps)).status).toBe("cancelled");
  });

  it("honors an external AbortSignal", async () => {
    const { run, deps } = setup({ opus: [{ match: "propose", actions: [{ hang: true }] }] });
    const ac = new AbortController();
    setTimeout(() => ac.abort(), 30);
    expect((await drive(run, demoWorkflow(), deps, { signal: ac.signal })).status).toBe("cancelled");
  });

  it("releases the lock when the workflow itself is broken", async () => {
    const { run, deps } = setup();
    const broken: WorkflowDef = {
      name: "broken",
      next: () => ({ kind: "stage", steps: [{ id: "x", run: async () => 1 }] }),
    };
    await expect(drive(run, broken, deps)).rejects.toThrow(/no pending steps/);
    run.acquireWriter()(); // lock was released
  });
});

describe("engine: workflow features", () => {
  it("pauses in needs_attention after the stage and continues on resume", async () => {
    const { run, deps } = setup();
    const wf: WorkflowDef = {
      name: "attention",
      next(st) {
        if (st.steps.one?.status !== "completed") {
          return {
            kind: "stage",
            steps: [
              {
                id: "one",
                async run(ctx) {
                  ctx.flagAttention([{ path: "src/x.ts", before: null, after: "?? abc" }]);
                  return "r1";
                },
              },
            ],
          };
        }
        if (st.steps.two?.status !== "completed") return { kind: "stage", steps: [{ id: "two", run: async () => "r2" }] };
        return { kind: "done" };
      },
    };
    let st = await drive(run, wf, deps);
    expect(st.status).toBe("needs_attention");
    expect(st.attention).toEqual({ stepId: "one", changes: [{ path: "src/x.ts", before: null, after: "?? abc" }] });
    expect(st.steps.one?.status).toBe("completed");
    st = await drive(run, wf, deps);
    expect(st.status).toBe("completed");
    expect(st.attention).toBeUndefined();
  });

  it("supports deterministic loops with a schema-validated early stop", async () => {
    const answers = [false, false, true, false];
    const { run, deps } = setup();
    deps.workers.opus = new FakeWorker("opus", (_t, n) => ({ finalText: `round ${n}`, structured: { noChanges: answers[n] } }));
    const MAX = 5;
    const wf: WorkflowDef = {
      name: "rounds",
      next(st) {
        let last = 0;
        while (st.steps[`round.${last + 1}`]?.status === "completed") last++;
        const lastResult = st.steps[`round.${last}`]?.result as { noChanges: boolean } | undefined;
        if (last >= MAX || lastResult?.noChanges === true) return { kind: "done", result: { rounds: last } };
        return {
          kind: "stage",
          steps: [
            {
              id: `round.${last + 1}`,
              async run(ctx) {
                const d = await ctx.runWorker("opus", { prompt: "revise", cwd: ctx.stepDir, mode: "read-only" });
                const s = d.structured as { noChanges?: unknown };
                if (typeof s?.noChanges !== "boolean") throw new Error("schema");
                return { noChanges: s.noChanges };
              },
            },
          ],
        };
      },
    };
    const st = await drive(run, wf, deps);
    expect(st.result).toEqual({ rounds: 3 });
  });

  it("records usage with orchestrator-computed cost and flags unknown prices", async () => {
    const { run, deps } = setup({
      deepseek: [
        {
          match: "propose",
          finalText: "D",
          actions: [
            {
              emit: {
                type: "usage",
                provider: "together",
                model: "deepseek-ai/DeepSeek-V4.1-Flash-1017",
                tokens: { input: 1_000_000, output: 1_000_000, cacheRead: 1_000_000 },
                vendorCostUsd: 18.3,
              },
            },
            { emit: { type: "usage", provider: "together", model: "some/unpriced-model", tokens: { input: 5, output: 5 } } },
          ],
        },
      ],
      opus: [
        {
          match: "propose",
          finalText: "O",
          actions: [{ emit: { type: "usage", provider: "anthropic", model: "claude-opus-5", tokens: { input: 10, output: 20 } } }],
        },
      ],
    });
    const st = await drive(run, demoWorkflow(), deps);
    expect(st.costs.deepseek?.costUsd).toBeCloseTo(0.3 + 1.2 + 0.006, 10);
    expect(st.costs.deepseek?.vendorCostUsd).toBe(18.3);
    // an unpriced model makes the total unknown (never guessed)
    expect(st.costs.deepseek?.costUnknown).toBe(true);
    // Claude is subscription-billed: not metered, no price warning, vendor cost = API-equivalent
    expect(st.costs.opus).toMatchObject({ costUnknown: false, costUsd: 0, billing: "subscription", tokens: { input: 10, output: 20 } });
    const usage = run.events().filter((e) => e.type === "usage_recorded");
    const opusUsage = usage.find((u) => u.workerId === "opus")!;
    expect(opusUsage).toMatchObject({ costUsd: 0, billing: "subscription" });
    expect(opusUsage).not.toHaveProperty("warning");
    expect(usage.find((u) => u.priceKey === "together/some/unpriced-model")).toMatchObject({ costUsd: null, warning: expect.stringContaining("no price") });
  });

  it("coalesces streamed text deltas without losing content", async () => {
    const deltas = Array.from({ length: 200 }, (_, i) => ({ emit: { type: "text" as const, text: `t${i} ` } }));
    const { run, deps } = setup({ deepseek: [{ match: "propose", finalText: "D", actions: deltas }] });
    await drive(run, demoWorkflow(), deps);
    const texts = run
      .events()
      .filter((e) => e.type === "worker_event" && e.event.type === "text")
      .map((e) => (e.type === "worker_event" && e.event.type === "text" ? e.event.text : ""));
    expect(texts.length).toBeLessThan(20);
    expect(texts.join("")).toBe(deltas.map((d) => d.emit.text).join(""));
  });
});
