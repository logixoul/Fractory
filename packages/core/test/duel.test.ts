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
  "old.js": "// legacy\n",
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

/** The default judge is a third, non-contestant worker. */
const judgeWorker = (swap?: { index: number; side: string }[]) =>
  new FakeWorker("glm", (t) =>
    t.outFile?.endsWith("swap.json") ? { structured: { verdicts: swap ?? [] } } : { structured: verdict },
  );

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
    workers: { opus: { kind: "fake" }, deepseek: { kind: "fake" }, glm: { kind: "fake" } },
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
    });
    const glm = judgeWorker();
    const workers = { opus, deepseek, glm };
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

    // judge (a third worker) saw squashed diffs verbatim (code not scrubbed) and the task verbatim
    expect(deepseek.calls.some((c) => phaseOf(c) === "judge")).toBe(false);
    const judgeCall = glm.calls.find((c) => phaseOf(c) === "judge")!;
    const inDir = judgeCall.inputsDir!;
    const diffs = fs.readFileSync(path.join(inDir, "diff-A.patch"), "utf8") + fs.readFileSync(path.join(inDir, "diff-B.patch"), "utf8");
    expect(diffs).toContain("// Written by Claude");
    expect(diffs).not.toContain("checkpoint");
    expect(fs.readFileSync(path.join(inDir, "task.md"), "utf8")).toContain("(Claude: be careful.)");
    // identity tokens in code are only a warning
    expect(st.warnings).toEqual([expect.objectContaining({ code: "identity_in_diff", stepId: "judge" })]);
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
    expect((st.steps["recheck.0"]!.result as { allPassed: boolean }).allPassed).toBe(true);
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
    });
    const glm = judgeWorker();
    let st = await driveRun(run, { dataDir: data, workers: { opus, deepseek, glm } });
    const ld = labelOf(st, "deepseek");
    expect(st.status).toBe("awaiting_approval");
    expect(st.stepOrder.filter((s) => s.endsWith(`.${ld}`) && s.startsWith("fix."))).toEqual([`fix.1.${ld}`, `fix.2.${ld}`]);
    expect(st.steps[`check.3.${ld}`]).toBeUndefined();
    expect(fs.readFileSync(path.join(glm.calls.find((c) => phaseOf(c) === "judge")!.inputsDir!, "checks-A.md"), "utf8")).toMatch(/pass|FAIL/);

    approveRun(store.open(run.runId), []);
    st = await driveRun(store.open(run.runId), { dataDir: data, workers: { opus, deepseek, glm } });
    expect(st.status).toBe("completed");
    expect(st.steps.apply!.result).toMatchObject({ skipped: true });
    expect(st.steps["recheck.0"]).toBeUndefined();
    expect(opus.calls.some((c) => phaseOf(c) === "apply")).toBe(false);
  });

  it("an implementation without changes forfeits: no judge, the other branch is the result", async () => {
    const { data, run } = await setup();
    const glm = judgeWorker();
    const st = await driveRun(run, {
      dataDir: data,
      workers: { opus: worker("opus", { implement: () => ({ finalText: "nothing to do" }) }), deepseek: worker("deepseek", { implement: () => write(WITH_DIV) }), glm },
    });
    expect(st.status).toBe("completed");
    const lo = labelOf(st, "opus");
    const ld = labelOf(st, "deepseek");
    expect(st.steps[`check.0.${lo}`]).toBeUndefined();
    expect(st.steps.judge).toBeUndefined();
    expect(st.steps.apply).toBeUndefined();
    expect(glm.calls).toHaveLength(0);
    expect(st.result).toMatchObject({ forfeited: [lo], winner: { label: ld, workerId: "deepseek" } });
    const report = fs.readFileSync((st.result as { reportMd: string }).reportMd, "utf8");
    expect(report).toContain("**forfeited**");
    expect(report).toContain("opus forfeited");
  });

  it("both forfeiting fails the run", async () => {
    const { data, run } = await setup();
    const nothing = () => ({ finalText: "nothing" });
    const st = await driveRun(run, { dataDir: data, workers: { opus: worker("opus", { implement: nothing }), deepseek: worker("deepseek", { implement: nothing }), glm: judgeWorker() } });
    expect(st.status).toBe("failed");
    expect(st.failure).toMatchObject({ stepId: "outcome", kind: "exit_check", reason: expect.stringContaining("both contestants forfeited") });
  });

  it("after apply, failing checks feed a fix loop on the apply session (recheck.0 → refix.1 → recheck.1)", async () => {
    const { data, store, run } = await setup();
    const opus = worker("opus", {
      implement: () => write(WITH_DIV),
      apply: () => write("export const broken = 1;\n"),
      fix: () => write(WITH_DIV.replace("a / b", "(b === 0 ? NaN : a / b)")),
    });
    const deepseek = worker("deepseek", { implement: () => write(WITH_DIV) });
    const workers = { opus, deepseek, glm: judgeWorker() };
    let st = await driveRun(run, { dataDir: data, workers });
    approveRun(store.open(run.runId), [1]);
    st = await driveRun(store.open(run.runId), { dataDir: data, workers });
    expect(st.status).toBe("completed");
    expect(st.steps["recheck.0"]!.result).toMatchObject({ allPassed: false });
    expect(st.steps["refix.1"]!.status).toBe("completed");
    expect(st.steps["recheck.1"]!.result).toMatchObject({ allPassed: true });
    const applyCall = opus.calls.find((c) => phaseOf(c) === "apply")!;
    const refix = opus.calls.find((c) => phaseOf(c) === "fix")!;
    expect(refix.sessionId).toBe(applyCall.sessionId);
    expect(fs.readFileSync((st.result as { reportMd: string }).reportMd, "utf8")).toContain("1 fix iteration(s) after apply");
  });

  it("judge.swapOrderPass with no surviving item: no_robust_preferences, empty approval, run completes", async () => {
    const { data, store, run } = await setup({ judge: { swapOrderPass: true } });
    // pass 1: item 1 → A, item 2 → B. Swapped (A↔B): "A" for item 1 and "B" for item 2 both disagree.
    const glm = judgeWorker([
      { index: 1, side: "A" },
      { index: 2, side: "B" },
    ]);
    const workers = { opus: worker("opus", { implement: () => write(WITH_DIV) }), deepseek: worker("deepseek", { implement: () => write(WITH_DIV) }), glm };
    let st = await driveRun(run, { dataDir: data, workers });
    expect(st.status).toBe("awaiting_approval");
    expect(st.approval!.items).toEqual([]);
    expect(st.steps.judge!.result).toMatchObject({ noRobustPreferences: true, items: [] });
    expect(st.warnings.map((w) => w.code)).toContain("no_robust_preferences");
    approveRun(store.open(run.runId), []);
    st = await driveRun(store.open(run.runId), { dataDir: data, workers });
    expect(st.status).toBe("completed");
    expect(st.steps.apply!.result).toMatchObject({ skipped: true });
    expect(fs.readFileSync((st.result as { reportMd: string }).reportMd, "utf8")).toContain("No robust preferences");
  });

  it("resolves each evidence ref to its own side and commit (better side, other side, base, ambiguous)", async () => {
    const { data, run } = await setup({ checks: [] });
    // each contestant adds its own file, keeps math.js, deletes old.js (which exists only at base)
    const impl = (id: string) => (): FakeScript => ({
      actions: [{ writeFile: { path: `${id}.js`, content: `// by ${id}\n` } }, { writeFile: { path: "math.js", content: WITH_DIV } }, { removeFile: "old.js" }],
      finalText: "done",
    });
    // The judge learns which contestant is A from its diff input (the A/B order is seeded).
    const glm = new FakeWorker("glm", (t) => {
      const diffA = fs.readFileSync(path.join(t.inputsDir!, "diff-A.patch"), "utf8");
      const [aFile, bFile] = diffA.includes("opus.js") ? ["opus.js", "deepseek.js"] : ["deepseek.js", "opus.js"];
      return {
        structured: {
          summary: "s",
          items: [
            { aspect: "structure", betterSide: "A", evidence: [`${aFile}:1`, `${bFile}:1`, "B: math.js:1", "math.js:2", "old.js:1"], recommendation: "keep it", risk: "" },
            { aspect: "guard", betterSide: "A", evidence: ["math.js:1"], recommendation: "copy the guard from side B", risk: "" },
          ],
        },
      };
    });
    const st = await driveRun(run, { dataDir: data, workers: { opus: worker("opus", { implement: impl("opus") }), deepseek: worker("deepseek", { implement: impl("deepseek") }), glm } });
    expect(st.status).toBe("awaiting_approval");
    const j = st.steps.judge!.result as { sides: Record<"A" | "B", { label: string; workerId: string }>; heads: Record<string, string>; items: JudgeItem[] };
    const setupRes = st.steps.setup!.result as DuelSetup;
    const la = j.sides.A.label;
    const lb = j.sides.B.label;
    const [one, two] = j.items as [JudgeItem, JudgeItem];
    const byRaw = Object.fromEntries(one.evidenceRefs.map((r) => [r.raw, r]));
    const aFile = `${j.sides.A.workerId}.js:1`;
    const bFile = `${j.sides.B.workerId}.js:1`;
    // the better side's own file
    expect(byRaw[aFile]).toMatchObject({ side: "A", label: la, sha: j.heads[la], ambiguous: false, chosenBy: "only" });
    // the other (losing) side's file: its own side and commit, not the item's better side
    expect(byRaw[bFile]).toMatchObject({ side: "B", label: lb, sha: j.heads[lb], ambiguous: false, chosenBy: "only" });
    // resolves everywhere: the evidence text names B
    expect(byRaw["math.js:1"]).toMatchObject({ side: "B", sha: j.heads[lb], ambiguous: true, chosenBy: "evidence", resolvedIn: ["A", "B", "base"] });
    // resolves everywhere, nothing named: the item's better side
    expect(byRaw["math.js:2"]).toMatchObject({ side: "A", sha: j.heads[la], ambiguous: true, chosenBy: "better" });
    // only at base (deleted by both)
    expect(byRaw["old.js:1"]).toMatchObject({ side: "base", sha: setupRes.base, ambiguous: false, chosenBy: "only" });
    expect(byRaw["old.js:1"]!.label).toBeUndefined();
    // item text names side B
    expect(two.evidenceRefs[0]).toMatchObject({ side: "B", label: lb, ambiguous: true, chosenBy: "item" });

    // report.md links each ref to its own side and commit
    approveRun(store().open(run.runId), []);
    const done = await driveRun(store().open(run.runId), { dataDir: data, workers: { opus: worker("opus", {}), deepseek: worker("deepseek", {}), glm } });
    const report = fs.readFileSync((done.result as { reportMd: string }).reportMd, "utf8");
    expect(report).toContain(`[${bFile}](#ref/${lb}/${j.heads[lb]}/1-1/${j.sides.B.workerId}.js) (B, ${j.sides.B.workerId} @ ${j.heads[lb]!.slice(0, 7)})`);
    expect(report).toContain(`[old.js:1](#ref/base/${setupRes.base}/1-1/old.js) (base @ ${setupRes.base.slice(0, 7)})`);
    expect(report).toContain("ambiguous");

    function store() {
      return new RunStore(data, new Redactor());
    }
  });

  it("the judge result records each side's head commit as judged (refs point there)", async () => {
    const { data, run } = await setup({ checks: [] });
    const st = await driveRun(run, { dataDir: data, workers: { opus: worker("opus", { implement: () => write(WITH_DIV) }), deepseek: worker("deepseek", { implement: () => write(WITH_DIV) }), glm: judgeWorker() } });
    const heads = (st.steps.judge!.result as { heads: Record<string, string> }).heads;
    for (const l of Object.keys(st.labels)) expect(heads[l]).toBe((st.steps[`implement.${l}`]!.result as { head: string }).head);
  });

  it("judge.swapOrderPass keeps only items both passes agree on", async () => {
    const { data, run } = await setup({ judge: { swapOrderPass: true } });
    // pass 1: item 1 → A, item 2 → B. Swap pass (A/B exchanged): "B" for item 1 agrees, "B" for item 2 does not.
    const glm = judgeWorker([
      { index: 1, side: "B" },
      { index: 2, side: "B" },
    ]);
    const st = await driveRun(run, { dataDir: data, workers: { opus: worker("opus", { implement: () => write(WITH_DIV) }), deepseek: worker("deepseek", { implement: () => write(WITH_DIV) }), glm } });
    expect(st.status).toBe("awaiting_approval");
    expect((st.approval!.items as JudgeItem[]).map((i) => i.aspect)).toEqual(["division guard"]);
    const j = st.steps.judge!.result as { droppedBySwapPass: JudgeItem[] };
    expect(j.droppedBySwapPass.map((i) => i.aspect)).toEqual(["naming"]);
    const swapCall = glm.calls.find((c) => c.outFile?.endsWith("swap.json"))!;
    expect(swapCall.sessionId).toBeUndefined(); // fresh session
    const swapIn = path.join(swapCall.inputsDir!, "swap");
    const first = path.join(swapCall.inputsDir!);
    // the swap pass's A is the first pass's B
    expect(fs.readFileSync(path.join(swapIn, "diff-A.patch"), "utf8")).toBe(fs.readFileSync(path.join(first, "diff-B.patch"), "utf8"));
  });

  it("apply writing into the other worktree fails hard and that worktree is restored", async () => {
    const { data, store, run } = await setup({ checks: [] });
    let otherWt = "";
    const opus = worker("opus", {
      implement: () => write(WITH_DIV),
      apply: () => ({ actions: [{ writeFile: { path: path.join(otherWt, "math.js"), content: "sabotage" } }], finalText: "x" }),
    });
    const deepseek = worker("deepseek", { implement: () => write(WITH_DIV) });
    const glm = judgeWorker();
    let st = await driveRun(run, { dataDir: data, workers: { opus, deepseek, glm } });
    otherWt = (st.steps.setup!.result as DuelSetup).worktrees[labelOf(st, "deepseek")]!;
    approveRun(store.open(run.runId), [1]);
    st = await driveRun(store.open(run.runId), { dataDir: data, workers: { opus, deepseek, glm } });
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
    const deepseek = worker("deepseek", { implement: () => write(WITH_DIV) });
    const glm = judgeWorker();
    let st = await driveRun(run, { dataDir: data, workers: { opus, deepseek, glm } });
    expect(st.status).toBe("paused_quota");
    const lo = labelOf(st, "opus");
    const cp = st.steps[`implement.${lo}`]!.checkpoint!;
    st = await driveRun(store.open(run.runId), { dataDir: data, workers: { opus, deepseek, glm }, force: true });
    expect(st.status).toBe("awaiting_approval");
    expect(st.steps[`implement.${lo}`]).toMatchObject({ attempt: 2, checkpoint: cp });
    const wt = (st.steps.setup!.result as DuelSetup).worktrees[lo]!;
    expect(fs.existsSync(path.join(wt, "partial.txt"))).toBe(false);
    expect(g(wt, "log", "--format=%s").split("\n").filter((s) => s.includes("checkpoint"))).toHaveLength(1);
  });

  it("setup failure is an env_error before any worker runs", async () => {
    const { data, run } = await setup({ setup: [{ argv: [process.execPath, "-e", "process.exit(3)"] }] });
    const opus = worker("opus", {});
    const st = await driveRun(run, { dataDir: data, workers: { opus, deepseek: worker("deepseek", {}), glm: judgeWorker() } });
    expect(st.failure).toMatchObject({ stepId: "setup", kind: "env_error" });
    expect(opus.calls).toHaveLength(0);
  });

  it("diffExcerpt picks the sections of the cited files", () => {
    const d = "diff --git a/x.js b/x.js\n+x\ndiff --git a/y.js b/y.js\n+y\n";
    expect(diffExcerpt(d, ["y.js"])).toBe("diff --git a/y.js b/y.js\n+y\n");
    expect(diffExcerpt(d, ["z.js"])).toBe(d);
  });
});
