import * as fs from "node:fs";
import * as path from "node:path";
import { describe, expect, it } from "vitest";
import { approveRun } from "../src/engine/control.js";
import { createRun, driveRun } from "../src/run/runs.js";
import { reviewerStats } from "../src/run/stats.js";
import { rebuttalSchema, respondSchema, reviewOutputSchema, testPathProblem } from "../src/schemas/outputs.js";
import { RunStore } from "../src/store/run-store.js";
import { Redactor } from "../src/util/redact.js";
import { FakeWorker, type FakeScript } from "../src/workers/fake.js";
import type { WorkerTask } from "../src/workers/types.js";
import { classifyTest, testArgv, type DisagreementItem, type FindingOutcome, type ReviewResult, type ReviewSetup, type TestsResult } from "../src/workflows/review.js";
import { labelOf, testConfig, tmpDir } from "./helpers.js";
import { dataDir, g, initRepo } from "./git-helpers.js";

const MATH = "export const add = (a, b) => a + b;\nexport const sub = (a, b) => a - b;\n";
const FILES = {
  "math.js": MATH,
  "check.cjs": "const s = require('fs').readFileSync('math.js', 'utf8');\nif (!s.includes('div')) { console.error('FAIL: div missing'); process.exit(1); }\nconsole.log('ok');\n",
  ".gitignore": "node_modules/\n",
};
const WITH_DIV = MATH + "export const div = (a, b) => a / b;\n";
const GUARDED = MATH + "export const div = (a, b) => (b === 0 ? NaN : a / b);\n";

/** A reviewer test: reads math.js at the worktree root and fails (exit 1) unless it contains `needle`. */
const testFor = (needle: string) =>
  [
    "const p = require('path');",
    "console.log('running', p.basename(__filename));",
    `const s = require('fs').readFileSync(p.join(__dirname, '..', 'math.js'), 'utf8');`,
    `if (!s.includes(${JSON.stringify(needle)})) { console.error('missing ${needle}'); process.exit(1); }`,
    "console.log('pass');",
  ].join("\n") + "\n";

type Phase = "implement" | "fix" | "review" | "respond" | "rebuttal" | "apply";
function phaseOf(t: WorkerTask): Phase {
  const out = t.outFile ? path.basename(t.outFile) : "";
  if (out === "review.json") return "review";
  if (out === "respond.json") return "respond";
  if (out === "rebuttal.json") return "rebuttal";
  if (/decided that these findings must be addressed/.test(t.prompt)) return "apply";
  if (/some failed/.test(t.prompt)) return "fix";
  return "implement";
}

function worker(id: string, h: Partial<Record<Phase, (t: WorkerTask, n: number) => FakeScript>>) {
  const counts: Partial<Record<Phase, number>> = {};
  return new FakeWorker(id, (t) => {
    const p = phaseOf(t);
    const n = (counts[p] = (counts[p] ?? 0) + 1);
    const f = h[p];
    return f ? f(t, n) : { finalText: `${p} default` };
  });
}

async function setup(cfgOver: object = {}, withTestCommand = true) {
  const repo = initRepo(FILES);
  const data = dataDir();
  const store = new RunStore(data, new Redactor());
  const prompt = path.join(tmpDir(), "prompt.md");
  fs.writeFileSync(prompt, "Add a div function to math.js.\n");
  const config = testConfig({
    workers: { opus: { kind: "fake" }, gpt: { kind: "fake" }, deepseek: { kind: "fake" }, glm: { kind: "fake" } },
    checks: [{ name: "test", argv: [process.execPath, "check.cjs"] }],
    ...cfgOver,
    review: { ...(withTestCommand ? { testCommand: { argv: [process.execPath, "{testFile}"] } } : {}), ...(cfgOver as { review?: object }).review },
  });
  const run = await createRun(store, { workflow: "review", repo, promptFile: prompt, config });
  return { repo, data, store, run, mainHead: g(repo, "rev-parse", "HEAD").trim() };
}

const findings = [
  { id: "F1", severity: "bug", title: "division by zero", explanation: "div(1, 0) returns Infinity", refs: ["math.js:3"], confidence: 0.9, testFile: { path: "t/div0.test.cjs", content: testFor("b === 0") } },
  { id: "F2", severity: "nit", title: "naming", explanation: "add is terse", refs: ["math.js:1"], confidence: 0.4 },
  { id: "F3", severity: "risk", title: "ghost", explanation: "cites a file that does not exist", refs: ["nope.js:9"], confidence: 0.5 },
  { id: "F4", severity: "design", title: "uses arrow functions", explanation: "should use declarations", refs: ["math.js:2"], confidence: 0.3, testFile: { path: "t/arrow.test.cjs", content: testFor("=>") } },
  { id: "F5", severity: "bug", title: "no mul", explanation: "mul is missing", refs: ["math.js:3"], confidence: 0.6, testFile: { path: "t/mul.test.cjs", content: testFor("mul") } },
];

describe("review workflow", () => {
  it("implement → review → confirm → respond → retest → rebuttal → gate → apply → report", async () => {
    const { repo, data, store, run, mainHead } = await setup();
    const opus = worker("opus", {
      implement: () => ({ actions: [{ writeFile: { path: "math.js", content: WITH_DIV } }], finalText: "added div" }),
      respond: () => ({
        actions: [{ writeFile: { path: "math.js", content: GUARDED } }],
        structured: {
          responses: [
            { id: "F1", action: "fixed", reasoning: "guarded b === 0", refs: ["math.js:3"] },
            { id: "F2", action: "rejected", reasoning: "add is the conventional name", refs: [] },
            { id: "F4", action: "rejected", reasoning: "arrows are the house style", refs: ["math.js:1"] },
            { id: "F5", action: "rejected", reasoning: "mul is out of scope", refs: [] },
          ],
        },
      }),
      apply: () => ({ actions: [{ writeFile: { path: "math.js", content: GUARDED.replace("add =", "addNumbers =") } }], finalText: "renamed" }),
    });
    const gpt = worker("gpt", {
      // The first answer and the repair both keep F3's unresolvable ref → F3 is dropped.
      review: () => ({ structured: { summary: "div lacks a zero guard.", findings } }),
      rebuttal: () => ({
        structured: {
          rebuttals: [
            { id: "F1", verdict: "withdrawn", reasoning: "the guard is there", refs: [] },
            { id: "F2", verdict: "maintained", reasoning: "still terse", refs: ["math.js:1"] },
            { id: "F4", verdict: "withdrawn", reasoning: "fair enough", refs: [] },
          ],
        },
      }),
    });
    const workers = { opus, gpt };
    let st = await driveRun(run, { dataDir: data, workers });
    expect(st.failure).toBeUndefined();
    expect(st.status).toBe("awaiting_approval");
    const li = labelOf(st, "opus");
    const lr = labelOf(st, "gpt");
    const su = st.steps.setup!.result as ReviewSetup;
    expect(su.implementerLabel).toBe(li);
    expect(su.branches).toEqual({ [li]: `fractory/${run.runId}/${li}` });
    expect(Object.keys(su.worktrees).sort()).toEqual([li, lr, su.scratchLabel].sort());

    // review: read-only, in the reviewer's own worktree at the implementer's head; one repair turn for F3
    const implHead = (st.steps["implement"]!.result as { head: string }).head;
    const reviewCalls = gpt.calls.filter((c) => phaseOf(c) === "review");
    expect(reviewCalls).toHaveLength(2);
    expect(reviewCalls[0]!.mode).toBe("read-only");
    expect(reviewCalls[0]!.cwd).toBe(su.worktrees[lr]);
    expect(reviewCalls[1]!.sessionId).toBe("fake-gpt-0");
    expect(reviewCalls[1]!.prompt).toContain("F3 (nope.js:9)");
    expect(fs.readdirSync(reviewCalls[0]!.inputsDir!).sort()).toEqual(["checks.md", "diff.patch", "task.md"]);
    expect(fs.readFileSync(path.join(reviewCalls[0]!.inputsDir!, "diff.patch"), "utf8")).toContain("+export const div");
    const rv = st.steps.review!.result as ReviewResult;
    expect(rv.head).toBe(implHead);
    expect(rv.findings.map((f) => f.id)).toEqual(["F1", "F2", "F4", "F5"]);
    expect(rv.dropped.map((f) => f.id)).toEqual(["F3"]);
    expect(rv.findings[0]!.resolvedRefs[0]).toMatchObject({ path: "math.js", line: 3, side: "head", label: li, sha: implHead });
    expect(st.warnings.map((w) => w.code)).toContain("findings_dropped");

    // confirmation: decided by the test command's exit code, never by a model
    const cf = st.steps.confirm!.result as TestsResult;
    expect(cf.results.F1!.status).toBe("confirmed");
    expect(cf.results.F4!.status).toBe("refuted");
    expect(cf.results.F5!.status).toBe("confirmed");
    expect(cf.results.F2).toBeUndefined();
    // test files never reach the implementer's branch
    expect(g(su.worktrees[li]!, "log", "--format=%s", `${su.base}..HEAD`)).not.toMatch(/test F/);
    expect(fs.existsSync(path.join(su.worktrees[li]!, "t"))).toBe(false);

    // respond: resumes the implementer's session in edit mode, with confirmation status
    const respondCall = opus.calls.find((c) => phaseOf(c) === "respond")!;
    expect(respondCall.mode).toBe("edit");
    expect(respondCall.sessionId).toBe(opus.calls[0]!.sessionId ?? "fake-opus-0");
    const fmd = fs.readFileSync(path.join(respondCall.inputsDir!, "findings.md"), "utf8");
    expect(fmd).toMatch(/## F1 \[bug\] division by zero[\s\S]*CONFIRMED/);
    expect(fmd).toMatch(/## F4[\s\S]*refuted/);
    expect(fmd).not.toContain("F3");
    expect((st.steps["rcheck.1.0"]!.result as { allPassed: boolean }).allPassed).toBe(true);

    // retest: F1 now passes; F5 still fails
    const rt = st.steps["retest.1"]!.result as TestsResult;
    expect(rt.results.F1!.status).toBe("refuted");
    expect(rt.results.F5!.status).toBe("confirmed");
    expect(rt.results.F4).toBeUndefined();

    // rebuttal: the reviewer resumes its session; F5 (confirmed, rejected) is maintained without asking
    const rebCall = gpt.calls.find((c) => phaseOf(c) === "rebuttal")!;
    expect(rebCall.sessionId).toBe("fake-gpt-0");
    expect(rebCall.cwd).toBe(su.worktrees[lr]);
    expect(rebCall.prompt).toContain("Findings: F1, F2, F4.");
    expect(fs.readFileSync(path.join(rebCall.inputsDir!, "delta.patch"), "utf8")).toContain("b === 0");
    // the reviewer's worktree followed the implementer's new head
    expect(g(su.worktrees[lr]!, "rev-parse", "HEAD").trim()).toBe((st.steps["respond.1"]!.result as { head: string }).head);

    // gate: the maintained disagreements, in finding order
    const items = st.approval!.items as DisagreementItem[];
    expect(items.map((i) => i.id)).toEqual(["F2", "F5"]);
    expect(items[1]).toMatchObject({ test: "confirmed", reviewer: expect.stringContaining("maintained automatically") });
    expect(items[0]!.implementer).toBe("rejected: add is the conventional name");

    approveRun(store.open(run.runId), [1]);
    st = await driveRun(store.open(run.runId), { dataDir: data, workers });
    expect(st.status).toBe("completed");
    const applyCall = opus.calls.find((c) => phaseOf(c) === "apply")!;
    expect(fs.readFileSync(path.join(applyCall.inputsDir!, "apply.md"), "utf8")).toContain("F2");
    expect(fs.readFileSync(path.join(applyCall.inputsDir!, "apply.md"), "utf8")).not.toContain("F5");
    expect((st.steps["acheck.0"]!.result as { allPassed: boolean }).allPassed).toBe(true);

    const result = st.result as { reportMd: string; branches: Record<string, string>; disagreements: string[] };
    expect(result.disagreements).toEqual(["F2", "F5"]);
    const report = fs.readFileSync(result.reportMd, "utf8");
    expect(report).toContain("| F2 | nit | naming | none | rejected | maintained → apply |");
    expect(report).toContain("| F5 | bug | no mul | confirmed | rejected | maintained (auto) → dismiss |");
    expect(report).toContain("| F1 | bug | division by zero | confirmed | fixed | withdrawn |");
    expect(report).toContain("Dropped findings");
    const outcomes = (st.steps.report!.result as { outcomes: FindingOutcome[] }).outcomes;
    expect(outcomes.find((o) => o.id === "F2")).toMatchObject({ final: "maintained", decision: "apply", action: "rejected" });

    // stats
    const [s] = reviewerStats([st]);
    expect(s).toMatchObject({
      reviewer: "gpt",
      runs: 1,
      findings: 4,
      dropped: 1,
      tested: 3,
      confirmed: 2,
      refuted: 1,
      testErrors: 0,
      confirmedBugRate: 1,
      accepted: 1,
      rejected: 3,
      withdrawn: 2,
      maintained: 2,
      applied: 1,
      dismissed: 1,
    });
    expect(s!.refutedRate).toBeCloseTo(1 / 3);

    // never merged or pushed: the user's branch is untouched
    expect(g(repo, "rev-parse", "HEAD").trim()).toBe(mainHead);
    expect(g(repo, "status", "--porcelain")).toBe("");
  }, 120_000);

  it("no findings: straight to the report", async () => {
    const { data, run } = await setup();
    const opus = worker("opus", { implement: () => ({ actions: [{ writeFile: { path: "math.js", content: GUARDED } }] }) });
    const gpt = worker("gpt", { review: () => ({ structured: { summary: "Looks good.", findings: [] } }) });
    const st = await driveRun(run, { dataDir: data, workers: { opus, gpt } });
    expect(st.status).toBe("completed");
    expect(st.steps.confirm).toBeUndefined();
    expect(st.steps["respond.1"]).toBeUndefined();
    expect(fs.readFileSync((st.result as { reportMd: string }).reportMd, "utf8")).toContain("The reviewer reported no findings.");
    expect(reviewerStats([st])[0]).toMatchObject({ runs: 1, findings: 0, confirmedBugRate: null, refutedRate: null });
  }, 60_000);

  it("an implementation without changes fails the run", async () => {
    const { data, run } = await setup();
    const st = await driveRun(run, { dataDir: data, workers: { opus: worker("opus", {}), gpt: worker("gpt", {}) } });
    expect(st.status).toBe("failed");
    expect(st.failure).toMatchObject({ stepId: "outcome", kind: "exit_check" });
  }, 60_000);

  it("maxRounds 2: a maintained finding gets a second respond/rebuttal round; withdrawn → no gate", async () => {
    const { data, run } = await setup({ review: { maxRounds: 2 } });
    const opus = worker("opus", {
      implement: () => ({ actions: [{ writeFile: { path: "math.js", content: WITH_DIV } }] }),
      respond: (_t, n) => ({ structured: { responses: [{ id: "N1", action: "rejected", reasoning: `round ${n}: keep it`, refs: [] }] } }),
    });
    const gpt = worker("gpt", {
      review: () => ({ structured: { summary: "s", findings: [{ id: "N1", severity: "nit", title: "t", explanation: "e", refs: ["math.js:1"], confidence: 0.2 }] } }),
      rebuttal: (_t, n) => ({
        structured: { rebuttals: [n === 1 ? { id: "N1", verdict: "maintained", reasoning: "no", refs: ["math.js:2"] } : { id: "N1", verdict: "withdrawn", reasoning: "ok", refs: [] }] },
      }),
    });
    const st = await driveRun(run, { dataDir: data, workers: { opus, gpt } });
    expect(st.status).toBe("completed");
    // the respond steps changed no files: no checks after them
    expect(st.steps["rcheck.1.0"]).toBeUndefined();
    expect(st.steps["rebuttal.2"]?.status).toBe("completed");
    expect(st.steps.approve).toBeUndefined();
    const second = opus.calls.filter((c) => phaseOf(c) === "respond")[1]!;
    expect(fs.readFileSync(path.join(second.inputsDir!, "findings.md"), "utf8")).toContain("Reviewer's round 1 rebuttal: **maintained**: no (math.js:2)");
    expect(st.warnings.map((w) => w.code)).not.toContain("fixed_without_changes");
  }, 60_000);

  it("without review.testCommand, tests are recorded as error (with a warning)", async () => {
    const { data, run } = await setup({}, false);
    const opus = worker("opus", {
      implement: () => ({ actions: [{ writeFile: { path: "math.js", content: WITH_DIV } }] }),
      respond: () => ({ structured: { responses: [{ id: "F1", action: "fixed", reasoning: "r", refs: [] }] } }),
    });
    const gpt = worker("gpt", {
      review: () => ({ structured: { summary: "s", findings: [findings[0]] } }),
      rebuttal: () => ({ structured: { rebuttals: [{ id: "F1", verdict: "withdrawn", reasoning: "ok", refs: [] }] } }),
    });
    const st = await driveRun(run, { dataDir: data, workers: { opus, gpt } });
    expect(st.status).toBe("completed");
    expect((st.steps.confirm!.result as TestsResult).results.F1).toMatchObject({ status: "error", reason: "review.testCommand is not configured" });
    expect(st.warnings.map((w) => w.code)).toEqual(expect.arrayContaining(["no_test_command", "fixed_without_changes"]));
  }, 60_000);
});

describe("review helpers", () => {
  it("testArgv substitutes the placeholder or appends the path", () => {
    expect(testArgv(["npx", "vitest", "run", "{testFile}"], "t\\a.test.ts")).toEqual(["npx", "vitest", "run", "t/a.test.ts"]);
    expect(testArgv(["pytest", "--file={testFile}"], "t/a.py")).toEqual(["pytest", "--file=t/a.py"]);
    expect(testArgv(["npm", "test", "--"], "t/a.js")).toEqual(["npm", "test", "--", "t/a.js"]);
  });

  it("classifyTest: exit code decides; the output must mention the file", () => {
    const tc = { failExitCodes: [1], requireFileInOutput: true };
    expect(classifyTest({ reason: "exit", code: 1 }, "FAIL t/a.test.js", "t/a.test.js", tc).status).toBe("confirmed");
    expect(classifyTest({ reason: "exit", code: 0 }, "PASS a.test.js", "t/a.test.js", tc).status).toBe("refuted");
    expect(classifyTest({ reason: "exit", code: 1 }, "No test files found", "t/a.test.js", tc)).toMatchObject({ status: "error", reason: expect.stringMatching(/probably did not run/) });
    expect(classifyTest({ reason: "exit", code: 2 }, "a.test.js", "t/a.test.js", tc)).toMatchObject({ status: "error", reason: expect.stringMatching(/unexpected exit code 2/) });
    expect(classifyTest({ reason: "timeout", code: null }, "", "t/a.test.js", tc).status).toBe("error");
    expect(classifyTest({ reason: "exit", code: 0 }, "", "t/a.test.js", { ...tc, requireFileInOutput: false }).status).toBe("refuted");
  });

  it("test paths must be repo-relative and outside .git", () => {
    expect(testPathProblem("test/a.test.ts")).toBeUndefined();
    for (const bad of ["/etc/x", "C:\\x.js", "../x.js", "a/../../x", ".git/hooks/pre-commit", "~/x", "", "-rf"]) expect(testPathProblem(bad)).toBeDefined();
  });

  it("schemas: unique ids, every open id answered once, maintained needs refs", () => {
    const f = { id: "F1", severity: "bug", title: "t", explanation: "e", refs: ["a.js:1"], confidence: 0.5 };
    expect(reviewOutputSchema(5).safeParse({ summary: "s", findings: [f, f] }).success).toBe(false);
    expect(reviewOutputSchema(1).safeParse({ summary: "s", findings: [f, { ...f, id: "F2" }] }).success).toBe(false);
    expect(reviewOutputSchema(5).safeParse({ summary: "s", findings: [{ ...f, testFile: { path: "../x.js", content: "x" } }] }).success).toBe(false);
    const r = respondSchema(["F1", "F2"]);
    expect(r.safeParse({ responses: [{ id: "F1", action: "fixed", reasoning: "r", refs: [] }] }).success).toBe(false);
    expect(r.safeParse({ responses: [{ id: "F3", action: "fixed", reasoning: "r", refs: [] }] }).success).toBe(false);
    const b = rebuttalSchema(["F1"]);
    expect(b.safeParse({ rebuttals: [{ id: "F1", verdict: "maintained", reasoning: "r", refs: [] }] }).success).toBe(false);
    expect(b.safeParse({ rebuttals: [{ id: "F1", verdict: "withdrawn", reasoning: "r", refs: [] }] }).success).toBe(true);
  });
});
