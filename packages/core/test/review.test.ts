// Tests for the M0–M5 decisions review (docs/decisions-todo.md, "Review changes").
import * as fs from "node:fs";
import * as path from "node:path";
import { describe, expect, it } from "vitest";
import { loadConfig } from "../src/config/load.js";
import { approveRun } from "../src/engine/control.js";
import { drive } from "../src/engine/drive.js";
import type { EngineDeps } from "../src/engine/types.js";
import { cleanRun, createRun, driveRun, gcRuns } from "../src/run/runs.js";
import { RunStore } from "../src/store/run-store.js";
import { Redactor } from "../src/util/redact.js";
import { ClaudeStreamParser } from "../src/workers/claude.js";
import { classifyError } from "../src/workers/cli-run.js";
import { FakeWorker, type FakeScript } from "../src/workers/fake.js";
import { createWorkers } from "../src/workers/factory.js";
import type { WorkerTask } from "../src/workers/types.js";
import type { DuelSetup } from "../src/workflows/duel.js";
import { demoWorkflow, labelOf, newTestRun, testConfig, tmpDir } from "./helpers.js";
import { dataDir, g, initRepo } from "./git-helpers.js";

describe("1. quota text matching only on error results", () => {
  const parser = () => new ClaudeStreamParser({ sessionId: "s", requestedModel: "opus", requestedReasoning: "high" });

  it("a successful result that discusses rate limits does not pause", () => {
    const evs = parser().record({
      type: "result",
      subtype: "success",
      is_error: false,
      session_id: "s",
      result: "To handle the usage limit, return 429 Too Many Requests and respect the rate limit quota.",
    });
    expect(evs.at(-1)).toMatchObject({ type: "done" });
  });

  it("an error result with that text is quota; a non-error non-success subtype is a plain model error", () => {
    expect(parser().record({ type: "result", subtype: "success", is_error: true, session_id: "s", result: "usage limit reached" }).at(-1)).toMatchObject({ kind: "quota" });
    expect(parser().record({ type: "result", subtype: "error_max_turns", is_error: false, session_id: "s", result: "rate limit talk" }).at(-1)).toMatchObject({ kind: "model" });
  });

  it("classifies transient vs quota per vendor", () => {
    expect(classifyError("overloaded", { status: 529, vendor: "claude" })).toBe("transient");
    expect(classifyError("x", { status: 429, vendor: "claude" })).toBe("quota");
    expect(classifyError("429: rate limit exceeded", { vendor: "pi" })).toBe("transient");
    expect(classifyError("fetch failed: ECONNRESET", { vendor: "pi" })).toBe("transient");
    expect(classifyError("502 Bad Gateway", { vendor: "pi" })).toBe("transient");
    expect(classifyError("401: invalid api key", { vendor: "pi" })).toBe("auth");
    expect(classifyError("the model refused", { vendor: "pi" })).toBe("model");
  });
});

const transientError: FakeScript = { actions: [{ emit: { type: "error", kind: "transient", message: "503 Service Unavailable" } }] };

function engine(deepseek: FakeScript[] | ((t: WorkerTask, n: number) => FakeScript), config: unknown = {}) {
  const store = new RunStore(tmpDir(), new Redactor([]));
  const opus = new FakeWorker("opus", [{ match: "propose", finalText: "plan O", repeat: true }, { match: "apply", finalText: "applied", repeat: true }]);
  const ds = new FakeWorker("deepseek", deepseek);
  const deps: EngineDeps = { workers: { opus, deepseek: ds }, config: testConfig({ retry: { backoffMs: [1] }, ...(config as object) }), cancelPollMs: 10 };
  return { store, run: newTestRun(store), deps, ds };
}

describe("reasoning level: requested vs effective", () => {
  it("a mismatch is a run warning; a match is not", async () => {
    const { run, deps } = engine([
      { match: "propose", finalText: "plan D", reasoning: { requested: "medium", effective: "high" } },
      { match: "apply", finalText: "ok", reasoning: { requested: "medium", effective: "medium" }, repeat: true },
    ]);
    const st = await drive(run, demoWorkflow(), deps);
    const w = st.warnings.filter((x) => x.code === "reasoning_level_mismatch");
    expect(w).toEqual([expect.objectContaining({ stepId: `propose.${labelOf(st, "deepseek")}`, message: "deepseek: requested reasoning 'medium', but the model ran at 'high'" })]);
  });
});

describe("2. transient errors: automatic retry with backoff; --retry-failed", () => {
  it("retries a transient failure and logs it", async () => {
    const { run, deps, ds } = engine([transientError, { match: "propose", finalText: "plan D" }]);
    const st = await drive(run, demoWorkflow(), deps);
    expect(st.status).toBe("awaiting_approval");
    const ld = labelOf(st, "deepseek");
    expect(st.steps[`propose.${ld}`]).toMatchObject({ status: "completed", attempt: 2 });
    expect(st.retries[`propose.${ld}`]).toBe(1);
    expect(run.events().filter((e) => e.type === "step_retrying")).toEqual([expect.objectContaining({ stepId: `propose.${ld}`, delayMs: 1, reason: expect.stringContaining("503") })]);
    expect(ds.calls).toHaveLength(2);
  });

  it("gives up after transientMaxRetries; --retry-failed reruns the failed step", async () => {
    let fail = true;
    const { store, run, deps, ds } = engine(() => (fail ? transientError : { finalText: "plan D" }), { retry: { transientMaxRetries: 2, backoffMs: [1] } });
    let st = await drive(run, demoWorkflow(), deps);
    const ld = labelOf(st, "deepseek");
    expect(st.status).toBe("failed");
    expect(st.failure).toMatchObject({ stepId: `propose.${ld}`, kind: "transient" });
    expect(ds.calls).toHaveLength(3); // 1 + 2 retries
    // plain resume of a failed run is a no-op; --retry-failed reopens it
    st = await drive(store.open(run.runId), demoWorkflow(), deps);
    expect(st.status).toBe("failed");
    fail = false;
    st = await drive(store.open(run.runId), demoWorkflow(), deps, { retryFailed: true });
    expect(st.status).toBe("awaiting_approval");
    expect(st.steps[`propose.${ld}`]).toMatchObject({ status: "completed", attempt: 4 });
    expect(st.failure).toBeUndefined();
  });

  it("a transient retry of an edit step restores the step's checkpoint first", async () => {
    const repo = initRepo({ "math.js": "export const add = (a, b) => a + b;\n" });
    const data = dataDir();
    const store = new RunStore(data, new Redactor());
    const prompt = path.join(tmpDir(), "p.md");
    fs.writeFileSync(prompt, "Add div.\n");
    const config = testConfig({ workers: { opus: { kind: "fake" }, deepseek: { kind: "fake" }, glm: { kind: "fake" } }, consensus: { contestants: ["opus", "deepseek"], judge: "glm" }, retry: { backoffMs: [1] } });
    const run = await createRun(store, { workflow: "duel", repo, promptFile: prompt, config });
    let n = 0;
    const writeDiv: FakeScript = { actions: [{ writeFile: { path: "math.js", content: "export const div = (a, b) => a / b;\n" } }], finalText: "ok" };
    const opus = new FakeWorker("opus", () =>
      ++n === 1 ? { actions: [{ writeFile: { path: "partial.txt", content: "half" } }, { emit: { type: "error", kind: "transient", message: "fetch failed" } }] } : writeDiv,
    );
    const deepseek = new FakeWorker("deepseek", () => writeDiv);
    const glm = new FakeWorker("glm", () => ({ structured: { summary: "s", items: [{ aspect: "a", betterSide: "A", evidence: [{ ref: "math.js:1", side: "A" }], recommendation: "r", risk: "" }] } }));
    const st = await driveRun(run, { dataDir: data, workers: { opus, deepseek, glm } });
    expect(st.status).toBe("awaiting_approval");
    const lo = labelOf(st, "opus");
    const wt = (st.steps.setup!.result as DuelSetup).worktrees[lo]!;
    expect(st.steps[`implement.${lo}`]!.attempt).toBe(2);
    expect(fs.existsSync(path.join(wt, "partial.txt"))).toBe(false);
    expect(g(wt, "log", "--format=%s").split("\n").filter((s) => s.includes("checkpoint"))).toHaveLength(1);
  });
});

describe("8. relative envFile resolves against the config file that declares it", () => {
  it("global and repo config files", () => {
    const configDir = tmpDir();
    const repo = tmpDir();
    fs.writeFileSync(path.join(configDir, "fractory.config.json"), JSON.stringify({ envFile: "secrets/.dev.vars" }));
    expect(loadConfig({ configDir, repo }).config.envFile).toBe(path.join(configDir, "secrets", ".dev.vars"));
    fs.writeFileSync(path.join(repo, "fractory.config.json"), JSON.stringify({ envFile: "../x.vars" }));
    expect(loadConfig({ configDir, repo }).config.envFile).toBe(path.resolve(repo, "..", "x.vars"));
    const abs = path.join(tmpDir(), "abs.vars");
    fs.writeFileSync(path.join(repo, "fractory.config.json"), JSON.stringify({ envFile: abs }));
    expect(loadConfig({ configDir, repo }).config.envFile).toBe(abs);
  });

  it("the recorded run config stores the envFile path, never the secret values", async () => {
    const configDir = tmpDir();
    fs.writeFileSync(path.join(configDir, ".dev.vars"), "TOGETHER_API_KEY=tgp_super_secret_value_123\n");
    fs.writeFileSync(path.join(configDir, "fractory.config.json"), JSON.stringify({ envFile: ".dev.vars" }));
    const repo = initRepo();
    const data = dataDir();
    const redactor = new Redactor();
    const store = new RunStore(data, redactor);
    const { config } = loadConfig({ configDir, repo });
    const prompt = path.join(tmpDir(), "p.md");
    fs.writeFileSync(prompt, "x\n");
    const run = await createRun(store, { workflow: "consensus", repo, promptFile: prompt, config });
    createWorkers(config, { dataDir: data, redactor, baseDir: repo }); // registers envFile values with the redactor
    const raw = fs.readFileSync(run.eventsFile, "utf8");
    expect(raw).toContain(JSON.stringify(path.join(configDir, ".dev.vars")).slice(1, -1));
    expect(raw).not.toContain("tgp_super_secret_value_123");
    expect(redactor.string("k=tgp_super_secret_value_123")).not.toContain("tgp_super");
  });
});

describe("10. dirty main repo: warning at run start, not a block", () => {
  it("records a dirty_repo warning", async () => {
    const repo = initRepo();
    fs.writeFileSync(path.join(repo, "wip.txt"), "uncommitted");
    const store = new RunStore(dataDir(), new Redactor());
    const prompt = path.join(tmpDir(), "p.md");
    fs.writeFileSync(prompt, "x\n");
    const run = await createRun(store, { workflow: "consensus", repo, promptFile: prompt, config: testConfig() });
    expect(run.state().status).toBe("running");
    expect(run.state().warnings).toEqual([expect.objectContaining({ code: "dirty_repo", message: expect.stringContaining("HEAD") })]);
    const clean = await createRun(store, { workflow: "consensus", repo: initRepo(), promptFile: prompt, config: testConfig() });
    expect(clean.state().warnings).toEqual([]);
  });
});

describe("9. fractory clean / gc", () => {
  async function finishedRun() {
    const repo = initRepo({ "math.js": "export const add = (a, b) => a + b;\n" });
    const data = dataDir();
    const store = new RunStore(data, new Redactor());
    const prompt = path.join(tmpDir(), "p.md");
    fs.writeFileSync(prompt, "Add div.\n");
    const config = testConfig({ workers: { opus: { kind: "fake" }, deepseek: { kind: "fake" }, glm: { kind: "fake" } }, consensus: { contestants: ["opus", "deepseek"], judge: "glm" } });
    const run = await createRun(store, { workflow: "duel", repo, promptFile: prompt, config });
    const writeDiv: FakeScript = { actions: [{ writeFile: { path: "math.js", content: "export const div = (a, b) => a / b;\n" } }], finalText: "ok" };
    const workers = {
      opus: new FakeWorker("opus", () => writeDiv),
      deepseek: new FakeWorker("deepseek", () => writeDiv),
      glm: new FakeWorker("glm", () => ({ structured: { summary: "s", items: [{ aspect: "a", betterSide: "A", evidence: [{ ref: "math.js:1", side: "A" }], recommendation: "r", risk: "" }] } })),
    };
    let st = await driveRun(run, { dataDir: data, workers });
    expect(st.status).toBe("awaiting_approval");
    return { repo, data, store, run, workers };
  }

  it("refuses unfinished runs; removes worktrees of finished ones, keeps branches", async () => {
    const { repo, data, store, run, workers } = await finishedRun();
    await expect(cleanRun(store.open(run.runId), data)).rejects.toThrow(/only finished runs/);
    approveRun(store.open(run.runId), []);
    const st = await driveRun(store.open(run.runId), { dataDir: data, workers });
    expect(st.status).toBe("completed");
    const removed = await cleanRun(store.open(run.runId), data);
    expect(removed).toHaveLength(3); // two contestants + judge
    expect(fs.existsSync(path.join(data, "worktrees", run.runId))).toBe(false);
    expect(g(repo, "branch", "--list", `fractory/${run.runId}/*`).trim().split("\n")).toHaveLength(3);
    expect(g(repo, "worktree", "list")).not.toContain(run.runId);
    expect(store.open(run.runId).state().cleaned?.paths).toHaveLength(3);
    // idempotent
    expect(await cleanRun(store.open(run.runId), data)).toEqual([]);
  });

  it("gc cleans finished runs older than N days only", async () => {
    const { data, store, run, workers } = await finishedRun();
    approveRun(store.open(run.runId), []);
    await driveRun(store.open(run.runId), { dataDir: data, workers });
    expect(await gcRuns(store, { dataDir: data, olderThanDays: 1 })).toEqual([]);
    const later = Date.now() + 2 * 86_400_000;
    const done = await gcRuns(store, { dataDir: data, olderThanDays: 1, now: later });
    expect(done).toEqual([{ runId: run.runId, removed: expect.any(Array) }]);
    expect(await gcRuns(store, { dataDir: data, olderThanDays: 1, now: later })).toEqual([]);
  });
});

/** A consensus run (opus vs deepseek, judged by fake glm) with the swapped-order pass on. */
async function swapRun() {
  const repo = initRepo({ "math.js": "export const add = (a, b) => a + b;\nexport const sub = (a, b) => a - b;\nexport const mul = (a, b) => a * b;\n" });
  const data = dataDir();
  const store = new RunStore(data, new Redactor());
  const prompt = path.join(tmpDir(), "p.md");
  fs.writeFileSync(prompt, "Add div.\n");
  const config = testConfig({
    workers: { opus: { kind: "fake" }, deepseek: { kind: "fake" }, glm: { kind: "fake" } },
    consensus: { contestants: ["opus", "deepseek"], judge: "glm" },
    judge: { swapOrderPass: true },
  });
  return { data, run: await createRun(store, { workflow: "consensus", repo, promptFile: prompt, config }) };
}

describe("3. consensus judge.swapOrderPass", () => {
  it("checks the decision, not attribution: adopted decisions survive any attribution flip (marked attributionUnstable); unadopted ones are dropped", async () => {
    const { data, run } = await swapRun();
    const contestant = (id: string) =>
      new FakeWorker(id, (t) =>
        t.outFile?.endsWith("revise.json")
          ? { structured: { noChanges: true, proposal: "", changeSummary: "" } }
          : { finalText: `${id} plan math.js:1 math.js:2 math.js:3` },
      );
    const verdict = {
      summary: "s",
      decisions: [
        { topic: "stable", decision: "d1", rationale: "r", basedOn: "A", evidence: ["math.js:1"] },
        // a decision both proposals contain: the swapped pass credits only one side, still adopted
        { topic: "shared", decision: "d2", rationale: "r", basedOn: "both", evidence: ["math.js:2"] },
        { topic: "flipped", decision: "d3", rationale: "r", basedOn: "B", evidence: ["math.js:3"] },
        { topic: "rejected", decision: "d4", rationale: "r", basedOn: "A", evidence: ["math.js:1"] },
      ],
      unresolved: [],
    };
    // swapped pass (A and B exchanged): "stable" A→B maps to the same contestant; "shared" both→A
    // and "flipped" B→B map differently but are adopted; "rejected" is not adopted.
    const swapVerdicts = [
      { index: 1, adopt: true, side: "B" },
      { index: 2, adopt: true, side: "A" },
      { index: 3, adopt: true, side: "B" },
      { index: 4, adopt: false, side: "B" },
    ];
    const glm = new FakeWorker("glm", (t) => (t.outFile?.endsWith("swap.json") ? { structured: { verdicts: swapVerdicts } } : { structured: verdict }));
    const st = await driveRun(run, { dataDir: data, workers: { opus: contestant("opus"), deepseek: contestant("deepseek"), glm } });
    expect(st.failure).toBeUndefined();
    expect(st.status).toBe("completed");
    const j = JSON.parse(fs.readFileSync((st.steps.judge!.result as { decisionJson: string }).decisionJson, "utf8"));
    expect(j.verdict.decisions.map((d: { topic: string; attributionUnstable?: boolean }) => [d.topic, d.attributionUnstable ?? false])).toEqual([
      ["stable", false],
      ["shared", true],
      ["flipped", true],
    ]);
    expect(j.droppedBySwapPass.map((d: { topic: string }) => d.topic)).toEqual(["rejected"]);
    expect(st.warnings.map((w) => w.code)).toContain("attribution_unstable");
    const md = fs.readFileSync((st.steps.judge!.result as { decisionMd: string }).decisionMd, "utf8");
    expect(md).toContain("Dropped by the swapped-order pass");
    expect(md.match(/attribution unstable/g)).toHaveLength(2);
  });

  it("a decision both proposals contain survives every attribution the swapped pass gives it", async () => {
    const sides = ["A", "B", "both", "neither"] as const;
    const { data, run } = await swapRun();
    const contestant = (id: string) =>
      new FakeWorker(id, (t) =>
        t.outFile?.endsWith("revise.json") ? { structured: { noChanges: true, proposal: "", changeSummary: "" } } : { finalText: "put div in math.js math.js:1 math.js:2 math.js:3" },
      );
    const verdict = {
      summary: "s",
      decisions: sides.map((side) => ({ topic: `div-${side}`, decision: "put div in math.js", rationale: "r", basedOn: "both", evidence: ["math.js:3"] })),
      unresolved: [],
    };
    const swapVerdicts = sides.map((side, i) => ({ index: i + 1, adopt: true, side }));
    const glm = new FakeWorker("glm", (t) => (t.outFile?.endsWith("swap.json") ? { structured: { verdicts: swapVerdicts } } : { structured: verdict }));
    const st = await driveRun(run, { dataDir: data, workers: { opus: contestant("opus"), deepseek: contestant("deepseek"), glm } });
    expect(st.status).toBe("completed");
    const j = JSON.parse(fs.readFileSync((st.steps.judge!.result as { decisionJson: string }).decisionJson, "utf8"));
    const d = j.verdict.decisions as { topic: string; attributionUnstable?: boolean }[];
    expect(d.map((x) => [x.topic, x.attributionUnstable ?? false])).toEqual(sides.map((side) => [`div-${side}`, side !== "both"]));
    expect(j.droppedBySwapPass).toEqual([]);
  });

  it("judge inputs: revision summaries per side, and critiques labelled with the draft they target", async () => {
    const { data, run } = await swapRun();
    const contestant = (id: string, revise?: string) =>
      new FakeWorker(id, (t) =>
        t.outFile?.endsWith("revise.json")
          ? {
              structured: revise
                ? { noChanges: false, proposal: `${id} revised math.js:1 math.js:2 math.js:3`, changeSummary: revise }
                : { noChanges: true, proposal: "", changeSummary: "kept as is" },
            }
          : { finalText: `${id} plan math.js:1 math.js:2 math.js:3` },
      );
    const verdict = { summary: "s", decisions: [{ topic: "t", decision: "d", rationale: "r", basedOn: "A", evidence: ["math.js:1"] }], unresolved: [] };
    const prompts: string[] = [];
    const glm = new FakeWorker("glm", (t) => {
      prompts.push(t.prompt);
      return t.outFile?.endsWith("swap.json") ? { structured: { verdicts: [{ index: 1, adopt: true, side: "B" }] } } : { structured: verdict };
    });
    const st = await driveRun(run, { dataDir: data, workers: { opus: contestant("opus"), deepseek: contestant("deepseek", "added a zero guard"), glm } });
    expect(st.status).toBe("completed");
    const sides = (st.steps.judge!.result as { sides: Record<"A" | "B", { workerId: string }> }).sides;
    const ds = sides.A.workerId === "deepseek" ? "A" : "B";
    const op = ds === "A" ? "B" : "A";
    const inputs = path.join(run.dir, "steps", "judge", "inputs");
    expect(fs.readFileSync(path.join(inputs, `revisions-${ds}.md`), "utf8")).toMatch(/## Round 1: revised\s+added a zero guard/);
    expect(fs.readFileSync(path.join(inputs, `revisions-${op}.md`), "utf8")).toMatch(/## Round 1: no changes\s+kept as is/);
    // judge + swap pass; in the swap pass A and B are exchanged
    expect(prompts).toHaveLength(2);
    const [first, swap] = prompts as [string, string];
    expect(first).toContain(`proposal ${ds} (final version: revised in round 1 of 1)`);
    expect(first).toContain(`proposal ${op} (final version: the original, unchanged through 1 revision round(s))`);
    expect(swap).toContain(`proposal ${op} (final version: revised in round 1 of 1)`);
    for (const p of prompts) {
      expect(p).toContain("A's critique of B, targeting B's ORIGINAL proposal (before any revision)");
      expect(p).toContain("B's critique of A, targeting A's ORIGINAL proposal (before any revision)");
      expect(p).toMatch(/revisions-A\.md/);
    }
    expect(fs.readFileSync(path.join(inputs, "swap", `revisions-${op}.md`), "utf8")).toContain("added a zero guard");
  });

  it("no surviving decision: no_robust_preferences, an empty verdict, and the run completes", async () => {
    const repo = initRepo({ "math.js": "export const add = (a, b) => a + b;\nexport const sub = (a, b) => a - b;\nexport const mul = (a, b) => a * b;\n" });
    const data = dataDir();
    const store = new RunStore(data, new Redactor());
    const prompt = path.join(tmpDir(), "p.md");
    fs.writeFileSync(prompt, "Add div.\n");
    const config = testConfig({ workers: { opus: { kind: "fake" }, deepseek: { kind: "fake" }, glm: { kind: "fake" } }, consensus: { contestants: ["opus", "deepseek"], judge: "glm" }, judge: { swapOrderPass: true } });
    const run = await createRun(store, { workflow: "consensus", repo, promptFile: prompt, config });
    const contestant = (id: string) =>
      new FakeWorker(id, (t) => (t.outFile?.endsWith("revise.json") ? { structured: { noChanges: true, proposal: "", changeSummary: "" } } : { finalText: `${id} math.js:1 math.js:2 math.js:3` }));
    const verdict = { summary: "s", decisions: [{ topic: "t", decision: "d", rationale: "r", basedOn: "A", evidence: ["math.js:1"] }], unresolved: [] };
    // the swapped pass does not adopt the only decision
    const glm = new FakeWorker("glm", (t) => (t.outFile?.endsWith("swap.json") ? { structured: { verdicts: [{ index: 1, adopt: false, side: "B" }] } } : { structured: verdict }));
    const st = await driveRun(run, { dataDir: data, workers: { opus: contestant("opus"), deepseek: contestant("deepseek"), glm } });
    expect(st.failure).toBeUndefined();
    expect(st.status).toBe("completed");
    expect(st.steps.judge!.result).toMatchObject({ noRobustPreferences: true });
    expect(st.warnings.map((w) => w.code)).toContain("no_robust_preferences");
    const j = JSON.parse(fs.readFileSync((st.steps.judge!.result as { decisionJson: string }).decisionJson, "utf8"));
    expect(j.verdict.decisions).toEqual([]);
    expect(fs.readFileSync((st.steps.judge!.result as { decisionMd: string }).decisionMd, "utf8")).toContain("No robust preferences");
  });
});

describe("consensus lineup", () => {
  it("consensus runs use config.consensus (gpt + deepseek-std, judged by opus); duel keeps config.roles", async () => {
    const store = new RunStore(dataDir(), new Redactor());
    const prompt = path.join(tmpDir(), "p.md");
    fs.writeFileSync(prompt, "x\n");
    const consensus = (await createRun(store, { workflow: "consensus", repo: initRepo(), promptFile: prompt, config: testConfig() })).state();
    expect(consensus.roles).toMatchObject({ contestants: ["gpt", "deepseek-std"], judge: "opus" });
    expect(Object.values(consensus.labels).sort()).toEqual(["deepseek-std", "gpt"]);
    const duel = (await createRun(store, { workflow: "duel", repo: initRepo(), promptFile: prompt, config: testConfig() })).state();
    expect(duel.roles).toMatchObject({ contestants: ["opus", "deepseek"], judge: "glm" });
    expect(Object.values(duel.labels).sort()).toEqual(["deepseek", "opus"]);
  });

  it("rejects an unknown or duplicate consensus worker", () => {
    expect(() => testConfig({ consensus: { judge: "nope" } })).toThrow(/consensus\.judge.*unknown worker 'nope'|unknown worker 'nope'/s);
    expect(() => testConfig({ consensus: { contestants: ["gpt", "gpt"] } })).toThrow(/two different workers/);
  });
});
