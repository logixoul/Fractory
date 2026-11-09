import * as fs from "node:fs";
import * as path from "node:path";
import { describe, expect, it } from "vitest";
import { approveRun } from "../src/engine/control.js";
import { createRun, driveRun } from "../src/run/runs.js";
import { RunStore } from "../src/store/run-store.js";
import { Redactor } from "../src/util/redact.js";
import { FakeWorker, fakeQuotaExhausted, type FakeScript } from "../src/workers/fake.js";
import type { WorkerTask } from "../src/workers/types.js";
import type { DuelSetup, JudgeItem } from "../src/workflows/duel.js";
import { diffExcerpt } from "../src/workflows/duel.js";
import { labelOf, testConfig, tmpDir } from "./helpers.js";
import { dataDir, g, initRepo } from "./git-helpers.js";

const FILES = {
  "math.js": "export const add = (a, b) => a + b;\nexport const sub = (a, b) => a - b;\n",
  "check.cjs": "const s = require('fs').readFileSync('math.js', 'utf8');\nif (!s.includes('div')) { console.error('FAIL: div missing'); process.exit(1); }\nconsole.log('ok');\n",
  ".gitignore": "node_modules/\n",
};
const WITH_DIV = FILES["math.js"] + "// Written by Claude\nexport const div = (a, b) => a / b;\n";

type Phase = "implement" | "fix" | "judge" | "apply";
type Handler = (t: WorkerTask, n: number) => FakeScript;

function phaseOf(t: WorkerTask): Phase {
  if (t.outFile?.endsWith("verdict.json") || /You are the judge/.test(t.prompt)) return "judge";
  if (/approved these items/.test(t.prompt)) return "apply";
  if (/some failed/.test(t.prompt)) return "fix";
  return "implement";
}

function worker(id: string, h: Partial<Record<Phase, Handler>>) {
  const counts: Partial<Record<Phase, number>> = {};
  return new FakeWorker(id, (t) => {
    const p = phaseOf(t);
    const n = (counts[p] = (counts[p] ?? 0) + 1);
    const f = h[p];
    if (!f) return { finalText: `${p} default` };
    return f(t, n);
  });
}

const write = (content: string, extra: object = {}): FakeScript => ({ actions: [{ writeFile: { path: "math.js", content } }], finalText: "done", ...extra });

const verdict = {
  summary: "Both work; take the guard from one side.",
  items: [
    { aspect: "division guard", betterSide: "A", evidence: ["math.js:4"], recommendation: "guard against b === 0", risk: "low" },
    { aspect: "naming", betterSide: "B", evidence: ["math.js:1"], recommendation: "keep names", risk: "" },
  ],
};

async function setup(cfgOver: object = {}) {
  const repo = initRepo(FILES);
  const data = dataDir();
  const store = new RunStore(data, new Redactor());
  const prompt = path.join(tmpDir(), "prompt.md");
  fs.writeFileSync(prompt, "Add a div function to math.js. (Claude: be careful.)\n");
  const config = testConfig({
    workers: { opus: { kind: "fake" }, deepseek: { kind: "fake" } },
    checks: [{ name: "test", argv: [process.execPath, "check.cjs"] }],
    ...cfgOver,
  });
  const run = await createRun(store, { workflow: "duel", repo, promptFile: prompt, config });
  return { repo, data, store, run, mainHead: g(repo, "rev-parse", "HEAD").trim() };
}

describe("duel workflow", () => {
  it("implement ∥ → checks + fix loop → judge → approval → apply (resumed session) → recheck → report", async () => {
    const { repo, data, store, run, mainHead } = await setup();
    const opus = worker("opus", {
      implement: () => write(WITH_DIV),
      apply: () => write(WITH_DIV.replace("a / b", "(b === 0 ? NaN : a / b)")),
    });
    const deepseek = worker("deepseek", {
      implement: () => write(FILES["math.js"] + "export const mul = (a, b) => a * b;\n"),
      fix: () => write(FILES["math.js"] + "export const div = (a, b) => (b === 0 ? NaN : a / b);\n"),
      judge: () => ({ structured: verdict }),
    });
    const workers = { opus, deepseek };
    let st = await driveRun(run, { dataDir: data, workers });
    expect(st.status).toBe("awaiting_approval");
    const lo = labelOf(st, "opus");
    const ld = labelOf(st, "deepseek");
    const setupRes = st.steps.setup!.result as DuelSetup;

    // chains: opus passes at check.0; deepseek needs one fix
    expect((st.steps[`check.0.${lo}`]!.result as { allPassed: boolean }).allPassed).toBe(true);
    expect((st.steps[`check.0.${ld}`]!.result as { allPassed: boolean }).allPassed).toBe(false);
    expect((st.steps[`check.1.${ld}`]!.result as { allPassed: boolean }).allPassed).toBe(true);
    expect(st.steps[`fix.1.${lo}`]).toBeUndefined();
    const fixCall = deepseek.calls.find((c) => phaseOf(c) === "fix")!;
    expect(fixCall.sessionId).toBe(deepseek.calls[0]!.sessionId ?? "fake-deepseek-0");
    expect(fs.readFileSync(path.join(fixCall.inputsDir!, "check-failures.md"), "utf8")).toContain("FAIL: div missing");

    // checkpoints are recorded and hook-free fractory commits are on the worker branches
    expect(st.steps[`implement.${lo}`]!.checkpoint).toMatch(/^[0-9a-f]{40}$/);
    const log = g(setupRes.worktrees[ld]!, "log", "--format=%an|%s", `${setupRes.base}..HEAD`);
    expect(log).toContain(`fractory|fractory: fix.1.${ld} result`);
    expect(log).not.toMatch(/opus|deepseek/);

    // judge saw squashed diffs verbatim (code not scrubbed) and a scrubbed task
    const judgeCall = deepseek.calls.find((c) => phaseOf(c) === "judge")!;
    const inDir = judgeCall.inputsDir!;
    const diffs = fs.readFileSync(path.join(inDir, "diff-A.patch"), "utf8") + fs.readFileSync(path.join(inDir, "diff-B.patch"), "utf8");
    expect(diffs).toContain("// Written by Claude");
    expect(diffs).not.toContain("checkpoint");
    expect(fs.readFileSync(path.join(inDir, "task.md"), "utf8")).toContain("([agent]: be careful.)");
    expect(fs.readdirSync(inDir).sort()).toEqual(["checks-A.md", "checks-B.md", "diff-A.patch", "diff-B.patch", "task.md"]);

    // approval items carry the real side; approve item 1 and resume
    const items = st.approval!.items as JudgeItem[];
    expect(items).toHaveLength(2);
    expect(["opus", "deepseek"]).toContain(items[0]!.betterWorker);
    approveRun(store.open(run.runId), [1]);
    st = await driveRun(store.open(run.runId), { dataDir: data, workers });
    expect(st.status).toBe("completed");

    const applyCall = opus.calls.find((c) => phaseOf(c) === "apply")!;
    expect(applyCall.sessionId).toBe(opus.calls[0]!.sessionId ?? "fake-opus-0");
    expect(applyCall.mode).toBe("edit");
    expect(fs.readFileSync(path.join(applyCall.inputsDir!, "approved-items.md"), "utf8")).toContain("guard against b === 0");
    expect(fs.readFileSync(path.join(applyCall.inputsDir!, "other-diff.patch"), "utf8")).toContain("diff --git a/math.js");
    expect((st.steps.recheck!.result as { allPassed: boolean }).allPassed).toBe(true);
    const report = fs.readFileSync((st.result as { reportMd: string }).reportMd, "utf8");
    expect(report).toContain("[x] **1. division guard**");
    expect(report).toContain("[ ] **2. naming**");
    expect(report).toContain(setupRes.branches[lo]!);

    // never merged or pushed: the user's branch and tree are untouched
    expect(g(repo, "rev-parse", "HEAD").trim()).toBe(mainHead);
    expect(g(repo, "status", "--porcelain")).toBe("");
    expect(g(repo, "branch", "--list", "fractory/*").trim().split("\n")).toHaveLength(3);
  });

  it("stops the fix loop at maxFixIterations; zero approved items skip apply and recheck", async () => {
    const { data, store, run } = await setup({ duel: { maxFixIterations: 2 } });
    const opus = worker("opus", { implement: () => write(WITH_DIV) });
    const deepseek = worker("deepseek", {
      implement: () => write("export const nope = 1;\n"),
      fix: (_t, n) => write(`export const nope = ${n + 1};\n`),
      judge: () => ({ structured: verdict }),
    });
    let st = await driveRun(run, { dataDir: data, workers: { opus, deepseek } });
    const ld = labelOf(st, "deepseek");
    expect(st.status).toBe("awaiting_approval");
    expect(st.stepOrder.filter((s) => s.endsWith(`.${ld}`) && s.startsWith("fix."))).toEqual([`fix.1.${ld}`, `fix.2.${ld}`]);
    expect(st.steps[`check.3.${ld}`]).toBeUndefined();
    expect(fs.readFileSync(path.join(deepseek.calls.find((c) => phaseOf(c) === "judge")!.inputsDir!, "checks-A.md"), "utf8")).toMatch(/pass|FAIL/);

    approveRun(store.open(run.runId), []);
    st = await driveRun(store.open(run.runId), { dataDir: data, workers: { opus, deepseek } });
    expect(st.status).toBe("completed");
    expect(st.steps.apply!.result).toMatchObject({ skipped: true });
    expect(st.steps.recheck!.result).toEqual({ skipped: true });
    expect(opus.calls.some((c) => phaseOf(c) === "apply")).toBe(false);
  });

  it("an implementation without changes fails its exit check", async () => {
    const { data, run } = await setup();
    const st = await driveRun(run, {
      dataDir: data,
      workers: { opus: worker("opus", { implement: () => ({ finalText: "nothing to do" }) }), deepseek: worker("deepseek", { implement: () => write(WITH_DIV) }) },
    });
    expect(st.status).toBe("failed");
    expect(st.failure).toMatchObject({ kind: "exit_check", reason: expect.stringContaining("changed no files") });
  });

  it("apply writing into the other worktree fails hard and that worktree is restored", async () => {
    const { data, store, run } = await setup({ checks: [] });
    let otherWt = "";
    const opus = worker("opus", {
      implement: () => write(WITH_DIV),
      apply: () => ({ actions: [{ writeFile: { path: path.join(otherWt, "math.js"), content: "sabotage" } }], finalText: "x" }),
    });
    const deepseek = worker("deepseek", { implement: () => write(WITH_DIV), judge: () => ({ structured: verdict }) });
    let st = await driveRun(run, { dataDir: data, workers: { opus, deepseek } });
    otherWt = (st.steps.setup!.result as DuelSetup).worktrees[labelOf(st, "deepseek")]!;
    approveRun(store.open(run.runId), [1]);
    st = await driveRun(store.open(run.runId), { dataDir: data, workers: { opus, deepseek } });
    expect(st.status).toBe("failed");
    expect(st.failure).toMatchObject({ stepId: "apply", kind: "integrity" });
    expect(fs.readFileSync(path.join(otherWt, "math.js"), "utf8")).toContain("div");
  });

  it("a quota pause during implement resumes from the step's checkpoint", async () => {
    const { data, store, run } = await setup({ checks: [] });
    const reset = Date.now() + 3600_000;
    const opus = worker("opus", {
      implement: (_t, n) =>
        n === 1
          ? { actions: [{ writeFile: { path: "partial.txt", content: "half done" } }, ...fakeQuotaExhausted(reset)] }
          : write(WITH_DIV),
    });
    const deepseek = worker("deepseek", { implement: () => write(WITH_DIV), judge: () => ({ structured: verdict }) });
    let st = await driveRun(run, { dataDir: data, workers: { opus, deepseek } });
    expect(st.status).toBe("paused_quota");
    const lo = labelOf(st, "opus");
    const cp = st.steps[`implement.${lo}`]!.checkpoint!;
    st = await driveRun(store.open(run.runId), { dataDir: data, workers: { opus, deepseek }, force: true });
    expect(st.status).toBe("awaiting_approval");
    expect(st.steps[`implement.${lo}`]).toMatchObject({ attempt: 2, checkpoint: cp });
    const wt = (st.steps.setup!.result as DuelSetup).worktrees[lo]!;
    expect(fs.existsSync(path.join(wt, "partial.txt"))).toBe(false);
    expect(g(wt, "log", "--format=%s").split("\n").filter((s) => s.includes("checkpoint"))).toHaveLength(1);
  });

  it("setup failure is an env_error before any worker runs", async () => {
    const { data, run } = await setup({ setup: [{ argv: [process.execPath, "-e", "process.exit(3)"] }] });
    const opus = worker("opus", {});
    const st = await driveRun(run, { dataDir: data, workers: { opus, deepseek: worker("deepseek", {}) } });
    expect(st.failure).toMatchObject({ stepId: "setup", kind: "env_error" });
    expect(opus.calls).toHaveLength(0);
  });

  it("diffExcerpt picks the sections of the cited files", () => {
    const d = "diff --git a/x.js b/x.js\n+x\ndiff --git a/y.js b/y.js\n+y\n";
    expect(diffExcerpt(d, ["y.js"])).toBe("diff --git a/y.js b/y.js\n+y\n");
    expect(diffExcerpt(d, ["z.js"])).toBe(d);
  });
});
