import * as fs from "node:fs";
import * as path from "node:path";
import { describe, expect, it } from "vitest";
import { createRun, driveRun } from "../src/run/runs.js";
import { RunStore } from "../src/store/run-store.js";
import { Redactor } from "../src/util/redact.js";
import { FakeWorker, type FakeScript } from "../src/workers/fake.js";
import type { WorkerTask } from "../src/workers/types.js";
import { labelOf, testConfig, tmpDir } from "./helpers.js";
import { dataDir, g, initRepo } from "./git-helpers.js";

const FILES = {
  "math.js": "export const add = (a, b) => a + b;\nexport const sub = (a, b) => a - b;\nexport const mul = (a, b) => a * b;\n",
  "util.js": "export const id = (x) => x;\n",
  "AGENTS.md": "Use tabs. CODENAME-HERON.\n",
};

const verdict = {
  summary: "Add a div function next to the others.",
  decisions: [{ topic: "placement", decision: "put div in math.js", rationale: "keeps arithmetic together", basedOn: "A", evidence: ["math.js:3"] }],
  unresolved: [{ topic: "naming", positionA: "div", positionB: "divide", whyUnresolved: "style preference" }],
};

type Over = Partial<Record<"propose" | "critique" | "revise" | "judge", (t: WorkerTask, n: number) => FakeScript>>;

/** A fake contestant that behaves well unless overridden per phase. */
function contestant(id: string, over: Over = {}, opts: { reviseNoChanges?: boolean } = {}) {
  const counts: Record<string, number> = {};
  return new FakeWorker(id, (task) => {
    const p = task.prompt;
    const out = task.outFile ?? "";
    const phase = out.endsWith("decision.json") || /You are the judge/.test(p)
      ? "judge"
      : out.endsWith("revise.json") || /Revision round/.test(p)
        ? "revise"
        : /Critique it/.test(p)
          ? "critique"
          : "propose";
    const n = (counts[phase] = (counts[phase] ?? 0) + 1);
    const o = over[phase];
    if (o) return o(task, n);
    switch (phase) {
      case "propose":
        return { finalText: `As ${id === "opus" ? "Claude" : "DeepSeek"} I propose: add div in math.js:3, mirror math.js:1 and util.js:1. Path ${task.cwd}${path.sep}math.js:2.` };
      case "critique":
        return { finalText: `The other plan ignores math.js:2.` };
      case "revise":
        return opts.reviseNoChanges
          ? { structured: { noChanges: true, proposal: "", changeSummary: "kept" } }
          : { structured: { noChanges: false, proposal: "Revised: math.js:1 math.js:2 math.js:3", changeSummary: "added detail" } };
      case "judge":
        return { structured: verdict };
    }
  });
}

async function setup(cfgOver: unknown = {}, workers?: (d: { opus?: Over; deepseek?: Over }) => void) {
  void workers;
  const repo = initRepo(FILES);
  const data = dataDir();
  const store = new RunStore(data, new Redactor());
  const prompt = path.join(tmpDir(), "prompt.md");
  fs.writeFileSync(prompt, "Add a division function. Mention Claude here on purpose.\n");
  const config = testConfig({ workers: { opus: { kind: "fake" }, deepseek: { kind: "fake" }, glm: { kind: "fake" } }, consensus: { minRefs: 3, contestants: ["opus", "deepseek"], judge: "glm" }, ...(cfgOver as object) });
  const run = await createRun(store, { workflow: "consensus", repo, promptFile: prompt, config });
  return { repo, data, store, run };
}

describe("consensus workflow", () => {
  it("runs propose → critique → revise → judge; judge inputs are anonymized; repo untouched", async () => {
    const { repo, data, run } = await setup();
    const opus = contestant("opus");
    const deepseek = contestant("deepseek", {}, { reviseNoChanges: true });
    const statusBefore = g(repo, "status", "--porcelain", "--ignored");
    const glm = contestant("glm");
    const st = await driveRun(run, { dataDir: data, workers: { glm, opus, deepseek } });

    expect(st.status).toBe("completed");
    const lo = labelOf(st, "opus");
    const ld = labelOf(st, "deepseek");
    const phase = (id: string) => ["setup", "propose", "critique", "revise", "judge"].indexOf(id.split(".")[0]!);
    expect(st.stepOrder.map(phase)).toEqual([...st.stepOrder.map(phase)].sort((x, y) => x - y));
    expect(new Set(st.stepOrder)).toEqual(new Set(["setup", `propose.${lo}`, `propose.${ld}`, `critique.${lo}`, `critique.${ld}`, `revise.r1.${lo}`, `revise.r1.${ld}`, "judge"]));

    // sessions are kept per contestant; prompts carry the injected project context
    expect(opus.calls.slice(1).every((c) => c.sessionId === opus.calls[0]!.sessionId || c.sessionId?.startsWith("fake-opus"))).toBe(true);
    expect(opus.calls[0]!.prompt).toContain("CODENAME-HERON");
    expect(deepseek.calls[0]!.prompt).toContain("CODENAME-HERON");
    expect(opus.calls[0]!.mode).toBe("read-only");

    // contestants work in their own worktrees outside the repo; the critique sees only the other's proposal via inputs/
    const setupRes = st.steps.setup!.result as { worktrees: Record<string, string> };
    expect(opus.calls[0]!.cwd).toBe(setupRes.worktrees[lo]);
    expect(path.relative(repo, opus.calls[0]!.cwd).startsWith("..")).toBe(true);
    const crit = opus.calls.find((c) => /Critique it/.test(c.prompt))!;
    expect(fs.readFileSync(path.join(crit.inputsDir!, "other-proposal.md"), "utf8")).toContain("As DeepSeek");

    // judge inputs: scrubbed prose, repo-relative paths, A/B only
    const judgeCall = glm.calls.find((c) => /You are the judge/.test(c.prompt))!;
    expect(deepseek.calls.some((c) => /You are the judge/.test(c.prompt))).toBe(false);
    const inputs = fs.readdirSync(judgeCall.inputsDir!).sort();
    expect(inputs).toEqual(["critique-by-A.md", "critique-by-B.md", "proposal-A.md", "proposal-B.md", "revisions-A.md", "revisions-B.md", "task.md"]);
    const all = inputs.map((f) => fs.readFileSync(path.join(judgeCall.inputsDir!, f), "utf8")).join("\n");
    // prose is scrubbed; the user's own task text is exempt (it says "Mention Claude here on purpose")
    const prose = inputs.filter((f) => f !== "task.md").map((f) => fs.readFileSync(path.join(judgeCall.inputsDir!, f), "utf8")).join(" ");
    expect(prose).not.toMatch(/claude|deepseek|opus/i);
    expect(fs.readFileSync(path.join(judgeCall.inputsDir!, "task.md"), "utf8")).toContain("Mention Claude here on purpose");
    expect(all).toContain("[agent]");
    expect(all).not.toContain(data);
    expect(all).toContain("Path math.js:2");
    expect(judgeCall.prompt).not.toMatch(/claude|deepseek|opus/i);

    const j = st.steps.judge!.result as { decisionMd: string; decisionJson: string; sides: Record<string, { workerId: string }> };
    expect(fs.readFileSync(j.decisionMd, "utf8")).toContain("## Unresolved disagreements");
    expect(new Set([j.sides.A!.workerId, j.sides.B!.workerId])).toEqual(new Set(["opus", "deepseek"]));
    expect(st.result).toMatchObject({ decisionMd: j.decisionMd });

    expect(g(repo, "status", "--porcelain", "--ignored")).toBe(statusBefore);
  });

  it("records a step_timing breakdown for every step attempt (tool rounds, tool time, tokens)", async () => {
    const { data, run } = await setup();
    const glm = contestant("glm", {
      judge: () => ({
        actions: [
          { emit: { type: "tool_call", id: "r1", name: "read", input: { path: "math.js" } } },
          { delayMs: 120 },
          { emit: { type: "tool_result", id: "r1", isError: false, output: "ok" } },
          { delayMs: 40 },
          { emit: { type: "usage", provider: "fake", model: "glm", tokens: { input: 10, output: 321, cacheRead: 0, cacheWrite: 0, reasoning: 99 } } },
        ],
        structured: verdict,
      }),
    });
    const st = await driveRun(run, { dataDir: data, workers: { glm, opus: contestant("opus"), deepseek: contestant("deepseek", {}, { reviseNoChanges: true }) } });
    expect(st.status).toBe("completed");
    const timings = run.events().filter((e) => e.type === "step_timing");
    const worked = Object.values(st.steps).filter((s) => s.id !== "setup");
    for (const s of worked) {
      expect(s.timing, s.id).toBeDefined();
      expect(timings.some((e) => e.type === "step_timing" && e.stepId === s.id && e.attempt === s.attempt)).toBe(true);
    }
    // every step_timing comes right before its step's end event
    const evs = run.events();
    for (const [i, e] of evs.entries()) if (e.type === "step_timing") expect(["step_completed", "step_failed"]).toContain(evs[i + 1]!.type);
    const j = st.steps.judge!.timing!;
    expect(j).toMatchObject({ toolCalls: 1, toolRounds: 1, outputTokens: 321, reasoningTokens: 99 });
    expect(j.toolMs).toBeGreaterThanOrEqual(100);
    expect(j.wallMs).toBeGreaterThanOrEqual(j.workerMs);
    expect(j.workerMs).toBeGreaterThanOrEqual(j.toolMs);
  });

  it("stops revising early when both report noChanges", async () => {
    const { data, run } = await setup({ consensus: { maxRounds: 3, minRefs: 3, contestants: ["opus", "deepseek"], judge: "glm" } });
    const st = await driveRun(run, {
      dataDir: data,
      workers: { glm: contestant("glm"), opus: contestant("opus", {}, { reviseNoChanges: true }), deepseek: contestant("deepseek", {}, { reviseNoChanges: true }) },
    });
    expect(st.status).toBe("completed");
    expect(st.stepOrder.filter((s) => s.startsWith("revise."))).toHaveLength(2);
  });

  it("repairs too few valid refs once, then fails the step", async () => {
    const { data, run } = await setup();
    const opus = contestant("opus", { propose: (_t, n) => ({ finalText: n === 1 ? "vague plan, see nowhere.js:1" : "fixed: math.js:1 math.js:2 util.js:1" }) });
    const st = await driveRun(run, { dataDir: data, workers: { glm: contestant("glm"), opus, deepseek: contestant("deepseek") } });
    expect(st.status).toBe("completed");
    const proposeCalls = opus.calls.slice(0, 2);
    expect(proposeCalls[1]!.prompt).toContain("could validate only 0");
    expect(proposeCalls[1]!.sessionId).toBe(proposeCalls[0]!.sessionId ?? "fake-opus-0");

    const again = await setup();
    const vague = contestant("deepseek", { propose: () => ({ finalText: "still vague, see math.js:99" }) });
    const st2 = await driveRun(again.run, { dataDir: again.data, workers: { glm: contestant("glm"), opus: contestant("opus"), deepseek: vague } });
    expect(st2.status).toBe("failed");
    expect(st2.failure).toMatchObject({ kind: "exit_check", reason: expect.stringContaining("only 0 valid") });
    expect(vague.calls).toHaveLength(2);
  });

  it("repairs invalid structured output once (judge)", async () => {
    const { data, run } = await setup();
    const glm = contestant("glm", { judge: (_t, n) => ({ structured: n === 1 ? { summary: "" } : verdict }) });
    const st = await driveRun(run, { dataDir: data, workers: { glm, opus: contestant("opus"), deepseek: contestant("deepseek") } });
    expect(st.failure).toBeUndefined();
    expect(st.status).toBe("completed");
    const repair = glm.calls.filter((c) => c.outFile?.endsWith("decision.json"));
    expect(repair).toHaveLength(2);
    expect(repair[1]!.prompt).toContain("rejected by the orchestrator's validator");
    expect(repair[1]!.sessionId).toBeDefined();
  });

  it("a read-only violation fails the step hard and restores the worktree", async () => {
    const { data, run } = await setup();
    const opus = contestant("opus", {
      propose: () => ({ actions: [{ writeFile: { path: "math.js", content: "hacked" } }], finalText: "math.js:1 math.js:2 util.js:1" }),
    });
    const st = await driveRun(run, { dataDir: data, workers: { glm: contestant("glm"), opus, deepseek: contestant("deepseek") } });
    expect(st.status).toBe("failed");
    expect(st.failure).toMatchObject({ kind: "integrity" });
    const wt = (st.steps.setup!.result as { worktrees: Record<string, string> }).worktrees[labelOf(st, "opus")]!;
    expect(fs.readFileSync(path.join(wt, "math.js"), "utf8")).toContain("add");
  });

  it("a concurrent main-repo edit pauses in needs_attention; resume continues", async () => {
    const { repo, data, run, store } = await setup();
    const opus = contestant("opus", {
      propose: (t) => {
        fs.writeFileSync(path.join(repo, "user-edit.txt"), "the user is typing");
        return { finalText: `plan math.js:1 math.js:2 util.js:1 ${t.prompt.length > 0 ? "" : ""}` };
      },
    });
    const workers = { glm: contestant("glm"), opus, deepseek: contestant("deepseek") };
    const st = await driveRun(run, { dataDir: data, workers });
    expect(st.status).toBe("needs_attention");
    expect(st.attention?.changes.map((c) => c.path)).toEqual(["user-edit.txt"]);
    const st2 = await driveRun(store.open(run.runId), { dataDir: data, workers });
    expect(st2.status).toBe("completed");
  });
});
