import * as fs from "node:fs";
import * as path from "node:path";
import { evidenceMarkdown, type ResolvedRef } from "@fractory/shared/refs";
import { runChecksIsolated, runSetup } from "../checks/runner.js";
import { withGates } from "../engine/gated.js";
import { runStructured } from "../engine/structured.js";
import type { ApprovalGate, StepContext, StepDef, WorkStep, WorkflowDef } from "../engine/types.js";
import { restoreCheckpoint } from "../git/checkpoint.js";
import { commitAll, revParse, squashedDiff } from "../git/git.js";
import { ensureWorktree, worktreeBranch } from "../git/worktree.js";
import { dataPaths } from "../paths.js";
import { TEST_FILE_PLACEHOLDER, type Config, type TestCommand } from "../schemas/config.js";
import { rebuttalSchema, respondSchema, reviewOutputSchema, testPathProblem, type ReviewFinding, type Severity } from "../schemas/outputs.js";
import type { RunState } from "../state/reducer.js";
import { relativizePaths } from "../text/anonymize.js";
import { loadProjectContext } from "../text/context.js";
import { checkRefs, extractRefs } from "../text/refs.js";
import { isInside } from "../util/pathx.js";
import { randomHex } from "../util/random.js";
import { promptText, res, writeInput, writeOut } from "./common.js";
import {
  checkFixLoop,
  checksMarkdown,
  editTurn,
  fixTurn,
  guardCtx,
  headsOf,
  noShell,
  runChecksFor,
  type CheckStepResult,
  type EditResult,
  type Loop,
} from "./edit.js";

/**
 * Review workflow (the default of `fractory run`):
 *   setup (implementer, reviewer and scratch worktrees) → implement → check.0 → [fix.i → check.i]
 *   → review (reviewer, read-only, at the implementer's head) → confirm (orchestrator runs the
 *   reviewer's test files in the scratch worktree: confirmed / refuted / error)
 *   → per round r ≤ review.maxRounds:
 *       respond.r (implementer resumes: fixed | rejected per open finding; fixes committed)
 *       → rcheck.r.0 → [rfix.r.i → rcheck.r.i]   (only if respond.r changed files)
 *       → retest.r (confirmed findings' tests at the new head)
 *       → rebuttal.r (reviewer resumes: withdrawn | maintained with new evidence; confirmed
 *         findings that were rejected, or whose test still fails, are maintained automatically)
 *   → approve (human gate over the maintained disagreements: apply | dismiss)
 *   → apply (implementer resumes) → acheck.0 → [afix.i → acheck.i] → report.
 * The orchestrator decides every transition and every confirmation; no model does (rule 1).
 * Never merges or pushes; the implementer's branch is left for the user.
 */
export interface ReviewEnv {
  dataDir: string;
}

export interface ReviewSetup {
  base: string;
  /** label → worktree: implementer, reviewer (read-only, follows the implementer's head), scratch (tests). */
  worktrees: Record<string, string>;
  /** The result branch (the implementer's). */
  branches: Record<string, string>;
  implementerLabel: string;
  reviewerLabel: string;
  scratchLabel: string;
  contextFile: string;
  contextFiles: { path: string; sha256: string; bytes: number; truncated: boolean }[];
}

export type TestStatus = "confirmed" | "refuted" | "error";

export interface TestRun {
  status: TestStatus;
  reason: string;
  path: string;
  /** The commit the test ran against (the implementer's head plus only the test file). */
  sha: string;
  argv?: string[];
  code?: number | null;
  durationMs?: number;
  logFile?: string;
  logTail?: string;
  /** The test file replaced a file that exists at that head. */
  overwrote?: boolean;
}

export interface TestsResult {
  head: string;
  results: Record<string, TestRun>;
}

export interface Finding extends ReviewFinding {
  resolvedRefs: ResolvedRef[];
  invalidRefs: string[];
}

export interface ReviewResult {
  sessionId: string;
  /** The implementer's head the review saw (refs resolve here). */
  head: string;
  summary: string;
  findings: Finding[];
  /** Findings without a ref that resolves at the head, even after the repair turn. */
  dropped: Finding[];
  reviewFile: string;
}

export interface FindingResponse {
  id: string;
  action: "fixed" | "rejected";
  reasoning: string;
  refs: string[];
  resolvedRefs: ResolvedRef[];
  invalidRefs: string[];
}

export interface RespondResult extends EditResult {
  round: number;
  responses: FindingResponse[];
}

export interface Rebuttal {
  id: string;
  verdict: "withdrawn" | "maintained";
  reasoning: string;
  refs: string[];
  resolvedRefs: ResolvedRef[];
  invalidRefs: string[];
  /** Set by the orchestrator (no reviewer call): why the finding is maintained automatically. */
  auto?: string;
  /** Maintained, but no new ref resolves at the head even after the repair turn. */
  evidenceInvalid?: boolean;
}

export interface RebuttalResult {
  round: number;
  /** Reviewer session after the rebuttal (unchanged if no reviewer call was needed). */
  sessionId: string;
  head: string;
  rebuttals: Rebuttal[];
  /** Ids still disputed after this round (maintained, including automatic ones). */
  maintained: string[];
}

/** One maintained disagreement shown at the approval gate. */
export interface DisagreementItem {
  id: string;
  severity: Severity;
  title: string;
  explanation: string;
  test: TestStatus | "none";
  implementer: string;
  reviewer: string;
  refs: string[];
  resolvedRefs: ResolvedRef[];
}

export interface ReviewApplyResult extends Partial<EditResult> {
  skipped: boolean;
  appliedIds: string[];
  dismissedIds: string[];
  head: string;
}

interface ReviewCfg {
  review: { maxRounds: number; maxFixIterations: number };
}
const cfgOf = (st: RunState) => st.config as ReviewCfg;

function labelFor(st: RunState, workerId: string | undefined): string {
  const l = Object.entries(st.labels).find(([, w]) => w === workerId)?.[0];
  if (!l) throw new Error(`worker '${workerId}' has no label in this run`);
  return l;
}

export function reviewRoles(st: RunState) {
  const implementer = st.roles.implementer!;
  const reviewer = st.roles.reviewer!;
  return { implementer, reviewer, implLabel: labelFor(st, implementer), revLabel: labelFor(st, reviewer) };
}

/** Where the implementer's branch stands: its latest edit, check result and session. */
interface Track {
  head: EditResult;
  check: CheckStepResult | undefined;
  fixes: number;
}

/** Everything the workflow has decided so far, derived from step results only (rule 1). */
export interface ReviewProgress {
  /** The next stage (undefined when the run is ready for the report). */
  next?: { step: string; track?: Track; round?: number; open?: string[] };
  setup?: ReviewSetup;
  track?: Track;
  review?: ReviewResult;
  confirm?: TestsResult;
  rounds: { round: number; respond?: RespondResult; loop?: Loop; retest?: TestsResult; rebuttal?: RebuttalResult }[];
  /** Findings still disputed after the last round (the gate's items, in this order). */
  disagreements: string[];
  approval?: { approvedItemIds: number[] };
  apply?: ReviewApplyResult;
  applyLoop?: Loop;
  implementedNothing?: boolean;
}

export function reviewProgress(st: RunState): ReviewProgress {
  const { maxRounds, maxFixIterations: maxFix } = cfgOf(st).review;
  const p: ReviewProgress = { rounds: [], disagreements: [] };
  const setup = res<ReviewSetup>(st, "setup");
  if (!setup) return { ...p, next: { step: "setup" } };
  p.setup = setup;

  const impl = res<EditResult>(st, "implement");
  if (!impl) return { ...p, next: { step: "implement" } };
  if (impl.changedFiles.length === 0) return { ...p, implementedNothing: true, next: { step: "outcome" } };
  const l0 = checkFixLoop(st, impl, { check: (i) => `check.${i}`, fix: (i) => `fix.${i}` }, maxFix);
  if (l0.next) return { ...p, next: { step: l0.next, track: { head: l0.head!, check: undefined, fixes: l0.fixes } } };
  let track: Track = { head: l0.head!, check: l0.finalCheck, fixes: l0.fixes };
  p.track = track;

  const review = res<ReviewResult>(st, "review");
  if (!review) return { ...p, next: { step: "review", track } };
  p.review = review;
  if (review.findings.length > 0) {
    const confirm = res<TestsResult>(st, "confirm");
    if (!confirm) return { ...p, next: { step: "confirm", track } };
    p.confirm = confirm;

    let open = review.findings.map((f) => f.id);
    for (let r = 1; r <= maxRounds && open.length > 0; r++) {
      const round: ReviewProgress["rounds"][number] = { round: r };
      p.rounds.push(round);
      const respond = res<RespondResult>(st, `respond.${r}`);
      if (!respond) return { ...p, next: { step: `respond.${r}`, track, round: r, open } };
      round.respond = respond;
      if ((respond.stepChangedFiles ?? respond.changedFiles).length > 0) {
        const loop = checkFixLoop(st, respond, { check: (i) => `rcheck.${r}.${i}`, fix: (i) => `rfix.${r}.${i}` }, maxFix);
        round.loop = loop;
        if (loop.next) return { ...p, next: { step: loop.next, track: { head: loop.head!, check: track.check, fixes: loop.fixes }, round: r, open } };
        track = { head: loop.head!, check: loop.finalCheck, fixes: loop.fixes };
      } else {
        track = { ...track, head: respond };
      }
      p.track = track;
      const retest = res<TestsResult>(st, `retest.${r}`);
      if (!retest) return { ...p, next: { step: `retest.${r}`, track, round: r, open } };
      round.retest = retest;
      const rebuttal = res<RebuttalResult>(st, `rebuttal.${r}`);
      if (!rebuttal) return { ...p, next: { step: `rebuttal.${r}`, track, round: r, open } };
      round.rebuttal = rebuttal;
      open = rebuttal.maintained;
    }
    p.disagreements = open;
  }

  if (p.disagreements.length > 0) {
    const approval = res<{ approvedItemIds: number[] }>(st, "approve");
    if (!approval) return { ...p, next: { step: "approve", track } };
    p.approval = approval;
    const apply = res<ReviewApplyResult>(st, "apply");
    if (!apply) return { ...p, next: { step: "apply", track } };
    p.apply = apply;
    if (!apply.skipped) {
      const loop = checkFixLoop(st, apply as EditResult, { check: (i) => `acheck.${i}`, fix: (i) => `afix.${i}` }, maxFix);
      p.applyLoop = loop;
      if (loop.next) return { ...p, next: { step: loop.next, track: { head: loop.head!, check: track.check, fixes: loop.fixes } } };
      p.track = { head: loop.head!, check: loop.finalCheck, fixes: loop.fixes };
    }
  }
  if (!res(st, "report")) return { ...p, next: { step: "report", track: p.track! } };
  return p;
}

export function reviewWorkflow(env: ReviewEnv): WorkflowDef {
  return {
    name: "review",
    next(st) {
      const p = reviewProgress(st);
      if (!p.next) {
        const report = res<{ reportMd: string }>(st, "report")!;
        return { kind: "done", result: { reportMd: report.reportMd, branches: p.setup!.branches, head: p.track!.head.head, disagreements: p.disagreements } };
      }
      return { kind: "stage", steps: [stepFor(env, st, p)] };
    },
  };
}

function stepFor(env: ReviewEnv, st: RunState, p: ReviewProgress): StepDef {
  const n = p.next!;
  const { implementer, reviewer, implLabel, revLabel } = reviewRoles(st);
  const maxFix = cfgOf(st).review.maxFixIterations;
  const setup = p.setup!;
  const kind = n.step.split(".")[0]!;
  const editStep = (run: WorkStep["run"]): WorkStep => ({ id: n.step, workerId: implementer, label: implLabel, run });
  switch (kind) {
    case "setup":
      return setupStep(env, st);
    case "implement":
      return editStep((ctx) =>
        editTurn(ctx, env, st, setup, {
          label: implLabel,
          workerId: implementer,
          siblingWritable: [],
          prompt: [
            "Implement the task below in the repository in your current working directory. Make the changes directly with your file tools.",
            noShell(ctx.config.checks.map((c) => c.name)),
            fs.readFileSync(setup.contextFile, "utf8"),
            `## Task\n\n${promptText(ctx.run.dir)}`,
            "When you are done, reply with a short summary of what you changed and why.",
          ]
            .filter(Boolean)
            .join("\n\n"),
        }),
      );
    case "outcome":
      return {
        id: "outcome",
        async run() {
          return { implementedNothing: true };
        },
        exitCheck: () => ({ ok: false, reason: "the implementation changed no files; there is nothing to review" }),
      };
    case "check":
    case "rcheck":
    case "acheck":
      return { id: n.step, label: implLabel, run: (ctx) => runChecksFor(ctx, env, st, setup.worktrees[implLabel]!, n.track!.head.head) };
    case "fix":
    case "rfix":
    case "afix": {
      const parts = n.step.split(".");
      const i = Number(parts[parts.length - 1]);
      const prefix = kind === "fix" ? "check" : kind === "rfix" ? `rcheck.${parts[1]}` : "acheck";
      const failed = res<CheckStepResult>(st, `${prefix}.${i - 1}`)!;
      return editStep((ctx) =>
        fixTurn(ctx, env, st, setup, { label: implLabel, workerId: implementer, failed, iteration: i, maxFix, sessionId: n.track!.head.sessionId, siblingWritable: [] }),
      );
    }
    case "review":
      return { id: "review", workerId: reviewer, label: revLabel, run: (ctx) => runReview(ctx, env, st, setup, n.track!) };
    case "confirm": {
      const tests = p.review!.findings.filter((f) => f.testFile).map((f) => ({ id: f.id, ...f.testFile! }));
      return { id: "confirm", run: (ctx) => runTests(ctx, env, st, setup, tests, n.track!.head.head) };
    }
    case "respond":
      return editStep((ctx) => runRespond(ctx, env, st, setup, p, n.round!, n.open!));
    case "retest": {
      // Confirmed findings of this round: does their test still fail at the new head?
      const tests = n.open!.flatMap((id) => {
        const f = p.review!.findings.find((x) => x.id === id)!;
        return p.confirm!.results[id]?.status === "confirmed" && f.testFile ? [{ id, ...f.testFile }] : [];
      });
      return { id: n.step, run: (ctx) => runTests(ctx, env, st, setup, tests, n.track!.head.head) };
    }
    case "rebuttal":
      return { id: n.step, workerId: reviewer, label: revLabel, run: (ctx) => runRebuttal(ctx, env, st, setup, p, n.round!, n.open!, n.track!) };
    case "approve": {
      const gate: ApprovalGate = { kind: "approval_gate", id: "approve", items: (s) => disagreementItems(reviewProgress(s)) };
      return gate;
    }
    case "apply":
      return editStep((ctx) => runApply(ctx, env, st, setup, p, n.track!));
    case "report":
      return { id: "report", run: (ctx) => writeReport(ctx, st, p) };
    default:
      throw new Error(`review workflow: no step for '${n.step}'`);
  }
}

function setupStep(env: ReviewEnv, st: RunState): WorkStep {
  return {
    id: "setup",
    async run(ctx) {
      const base = await revParse(st.repo);
      const { implLabel, revLabel } = reviewRoles(st);
      let scratchLabel = randomHex(2);
      while (scratchLabel === implLabel || scratchLabel === revLabel) scratchLabel = randomHex(2);
      const worktrees: Record<string, string> = {};
      for (const label of [implLabel, revLabel, scratchLabel]) {
        worktrees[label] = (await ensureWorktree({ repo: st.repo, dataDir: env.dataDir, runId: st.runId, label, base })).path;
      }
      // Per-repo setup (§8.15) where commands run: checks (implementer) and tests (scratch).
      for (const label of [implLabel, scratchLabel]) await runSetup(worktrees[label]!, ctx.config.setup, path.join(ctx.stepDir, "logs", label), ctx.signal);
      const pc = await loadProjectContext(st.repo, base, ctx.config.contextFiles);
      const contextFile = writeOut(ctx, "context.md", pc.text);
      return {
        base,
        worktrees,
        branches: { [implLabel]: worktreeBranch(st.runId, implLabel) },
        implementerLabel: implLabel,
        reviewerLabel: revLabel,
        scratchLabel,
        contextFile,
        contextFiles: pc.files,
      } satisfies ReviewSetup;
    },
  };
}

// ---- refs ------------------------------------------------------------------------------

/** Resolves refs against a checkout of `sha` (`root`). Unresolvable entries are listed as invalid. */
export function resolveAtHead(refs: readonly string[], root: string, o: { label: string; sha: string }): { resolved: ResolvedRef[]; invalid: string[] } {
  const resolved: ResolvedRef[] = [];
  const invalid: string[] = [];
  for (const text of refs) {
    const found = extractRefs(text);
    if (found.length === 0) invalid.push(text);
    for (const r of found) {
      const v = checkRefs(r.raw, root).valid[0];
      if (!v) {
        invalid.push(r.raw);
        continue;
      }
      if (resolved.some((x) => x.path === v.path && x.line === r.line && x.endLine === r.endLine)) continue;
      resolved.push({
        raw: r.raw,
        path: v.path!,
        line: r.line,
        ...(r.endLine !== undefined ? { endLine: r.endLine } : {}),
        side: "head",
        label: o.label,
        sha: o.sha,
        ambiguous: false,
        chosenBy: "only",
        resolvedIn: ["head"],
      });
    }
  }
  return { resolved, invalid };
}

/** Moves the reviewer's read-only worktree (its own branch) to the implementer's head. */
async function followHead(ctx: StepContext, env: ReviewEnv, st: RunState, setup: ReviewSetup, head: string): Promise<string> {
  const wt = setup.worktrees[setup.reviewerLabel]!;
  await restoreCheckpoint(wt, head, guardCtx(env, st), ctx.config.preserveOnClean);
  return wt;
}

function readOnlyGates(ctx: StepContext, env: ReviewEnv, st: RunState, setup: ReviewSetup) {
  return async <T>(body: () => Promise<T>) =>
    withGates(
      ctx,
      {
        targets: { mainRepo: st.repo, worktrees: setup.worktrees },
        guard: guardCtx(env, st),
        restoreTo: await headsOf(setup.worktrees),
        preserveOnClean: ctx.config.preserveOnClean,
        inputsDir: path.join(ctx.stepDir, "inputs"),
      },
      body,
    );
}

const roots = (env: ReviewEnv, st: RunState, setup: ReviewSetup) => [...Object.values(setup.worktrees), st.repo, env.dataDir];

function testCommandText(cfg: Config): string {
  const tc = cfg.review.testCommand;
  if (!tc) return "No test command is configured for this repository, so do not add test files.";
  return [
    `Where you can, add a testFile: a NEW test file that fails on the current code because of the problem and passes once it is fixed. The orchestrator commits only that file onto the current code in a scratch checkout and runs: ${JSON.stringify(tc.argv)} (${TEST_FILE_PLACEHOLDER} = the file's path).`,
    "A test that fails confirms the finding; a test that passes refutes it. Make it self-contained, deterministic and runnable by that command; omit it if you cannot.",
  ].join(" ");
}

// ---- review ----------------------------------------------------------------------------

async function runReview(ctx: StepContext, env: ReviewEnv, st: RunState, setup: ReviewSetup, track: Track): Promise<ReviewResult> {
  const cfg = ctx.config;
  const { reviewer } = reviewRoles(st);
  const head = track.head.head;
  const cwd = await followHead(ctx, env, st, setup, head);
  const files = {
    task: writeInput(ctx, "task.md", promptText(ctx.run.dir)),
    diff: writeInput(ctx, "diff.patch", await squashedDiff(setup.worktrees[setup.implementerLabel]!, setup.base, head)),
    checks: writeInput(ctx, "checks.md", checksMarkdown(track.check, track.fixes, roots(env, st, setup))),
  };
  const prompt = [
    "You are a code reviewer. An engineer implemented the task below; your working directory is the repository at their latest commit (read-only). Read these files with your read tool:",
    `- task: ${files.task}`,
    `- the change (diff against the base commit): ${files.diff}`,
    `- the project's check results on it: ${files.checks}`,
    "",
    fs.readFileSync(setup.contextFile, "utf8"),
    "Review the change for bugs, risks, design problems and nits. Report only real problems; an empty list is fine. Be specific: say what is wrong, why, and what to do instead.",
    "Every finding needs at least one repo-relative path:line reference into the current code (the file must exist and the line be within it; this is checked).",
    testCommandText(cfg),
  ]
    .filter(Boolean)
    .join("\n");
  const schema = reviewOutputSchema(cfg.review.maxFindings);
  const taskOpts = { cwd, mode: "read-only" as const, stepDir: ctx.stepDir, inputsDir: path.join(ctx.stepDir, "inputs"), timeoutMs: cfg.timeouts.workerMs };
  const label = { label: setup.implementerLabel, sha: head };

  return readOnlyGates(ctx, env, st, setup)(async () => {
    let r = await runStructured(ctx, { workerId: reviewer, schema, name: "review", task: { ...taskOpts, prompt } });
    const resolve = (fs_: ReviewFinding[]): Finding[] =>
      fs_.map((f) => {
        const { resolved, invalid } = resolveAtHead(f.refs, cwd, label);
        return { ...f, resolvedRefs: resolved, invalidRefs: invalid };
      });
    let findings = resolve(r.value.findings);
    let bad = findings.filter((f) => f.resolvedRefs.length === 0);
    if (bad.length > 0) {
      // One repair turn (same session) for findings without a resolving ref.
      r = await runStructured(ctx, {
        workerId: reviewer,
        schema,
        name: "review",
        task: {
          ...taskOpts,
          sessionId: r.done.sessionId,
          prompt: [
            `These findings have no reference that exists in the current code (file must exist, line within it): ${bad.map((f) => `${f.id} (${f.refs.join(", ")})`).join("; ")}.`,
            "Return the complete review again, with at least one valid repo-relative path:line reference for every finding.",
          ].join("\n"),
        },
      });
      findings = resolve(r.value.findings);
      bad = findings.filter((f) => f.resolvedRefs.length === 0);
    }
    if (bad.length > 0) {
      ctx.record({
        type: "warning",
        code: "findings_dropped",
        stepId: ctx.stepId,
        message: `dropped ${bad.length} finding(s) without a reference that resolves at the head, after the repair turn: ${bad.map((f) => f.id).join(", ")}`,
      });
    }
    const kept = findings.filter((f) => f.resolvedRefs.length > 0);
    const reviewFile = writeOut(ctx, "review.json", JSON.stringify({ summary: r.value.summary, head, findings: kept, dropped: bad }, null, 2) + "\n");
    return { sessionId: r.done.sessionId, head, summary: r.value.summary, findings: kept, dropped: bad, reviewFile } satisfies ReviewResult;
  });
}

// ---- test confirmation (no model) ------------------------------------------------------

/** argv with {testFile} replaced by the repo-relative path; appended when there is no placeholder. */
export function testArgv(argv: readonly string[], testPath: string): string[] {
  const rel = testPath.replace(/\\/g, "/");
  return argv.some((a) => a.includes(TEST_FILE_PLACEHOLDER)) ? argv.map((a) => a.split(TEST_FILE_PLACEHOLDER).join(rel)) : [...argv, rel];
}

/** Classifies one test run: exit 0 → refuted, a failure exit code → confirmed, anything else → error. */
export function classifyTest(r: { reason: string; code: number | null }, log: string, testPath: string, tc: Pick<TestCommand, "failExitCodes" | "requireFileInOutput">): { status: TestStatus; reason: string } {
  if (r.reason !== "exit") return { status: "error", reason: `the test command did not complete (${r.reason})` };
  const ran = !tc.requireFileInOutput || log.includes(path.posix.basename(testPath.replace(/\\/g, "/")));
  if (!ran && (r.code === 0 || tc.failExitCodes.includes(r.code ?? NaN))) {
    return { status: "error", reason: `exit ${r.code}, but the output does not mention ${path.posix.basename(testPath)}: the test probably did not run` };
  }
  if (r.code === 0) return { status: "refuted", reason: "the test passes on this code" };
  if (tc.failExitCodes.includes(r.code ?? NaN)) return { status: "confirmed", reason: `the test fails on this code (exit ${r.code})` };
  return { status: "error", reason: `unexpected exit code ${r.code} (failure codes: ${tc.failExitCodes.join(", ")})` };
}

/**
 * Runs reviewer-written test files, one at a time, in the scratch worktree: reset to `head`,
 * write the file, commit it (hook-free), run review.testCommand isolated (§8.18). Nothing ever
 * reaches the implementer's branch. The result is decided by exit code alone.
 */
async function runTests(ctx: StepContext, env: ReviewEnv, st: RunState, setup: ReviewSetup, tests: { id: string; path: string; content: string }[], head: string): Promise<TestsResult> {
  const cfg = ctx.config;
  const tc = cfg.review.testCommand;
  const wt = setup.worktrees[setup.scratchLabel]!;
  const guard = guardCtx(env, st);
  const hooks = dataPaths(env.dataDir).emptyHooks;
  const results: Record<string, TestRun> = {};
  if (tests.length > 0 && !tc) {
    ctx.record({ type: "warning", code: "no_test_command", stepId: ctx.stepId, message: `${tests.length} reviewer test file(s) were not run: review.testCommand is not configured` });
  }
  for (const t of tests) {
    const problem = testPathProblem(t.path);
    if (!tc || problem) {
      results[t.id] = { status: "error", reason: problem ? `invalid test path: ${problem}` : "review.testCommand is not configured", path: t.path, sha: head };
      continue;
    }
    const removed = await restoreCheckpoint(wt, head, guard, cfg.preserveOnClean);
    const logDir = path.join(ctx.stepDir, "tests", t.id);
    if (removed.length > 0) await runSetup(wt, cfg.setup, path.join(logDir, "setup"), ctx.signal);
    const abs = path.resolve(wt, t.path);
    if (!isInside(abs, wt)) {
      results[t.id] = { status: "error", reason: "invalid test path: outside the worktree", path: t.path, sha: head };
      continue;
    }
    const overwrote = fs.existsSync(abs);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, t.content);
    const sha = await commitAll(wt, { emptyHooksDir: hooks, message: `fractory: ${ctx.stepId} test ${t.id}`, allowEmpty: true });
    const argv = testArgv(tc.argv, t.path);
    const out = await runChecksIsolated({
      worktree: wt,
      postStepSha: sha,
      checks: [{ name: `test-${t.id}`, argv: argv as [string, ...string[]], timeoutMs: tc.timeoutMs, ...(tc.env ? { env: tc.env } : {}), artifacts: [] }],
      setup: cfg.setup,
      preserveOnClean: cfg.preserveOnClean,
      guard,
      snapshot: cfg.snapshot,
      stepDir: logDir,
      signal: ctx.signal,
    });
    const r = out.results[0]!;
    // The log starts with the argv line (which names the file): judge only the command's own output.
    const log = fs.readFileSync(r.logFile, "utf8");
    const c = classifyTest(r, log.slice(log.indexOf("\n") + 1), t.path, tc);
    results[t.id] = { ...c, path: t.path, sha, argv, code: r.code, durationMs: r.durationMs, logFile: r.logFile, logTail: relativizePaths(r.logTail, roots(env, st, setup)), overwrote };
  }
  if (tests.length > 0) await restoreCheckpoint(wt, head, guard, cfg.preserveOnClean);
  return { head, results };
}

// ---- respond / rebuttal ----------------------------------------------------------------

const TEST_LABEL: Record<TestStatus, string> = {
  confirmed: "CONFIRMED: the reviewer's test fails on this code",
  refuted: "refuted: the reviewer's test passes on this code",
  error: "not confirmed: the reviewer's test could not be run",
};

function testLine(run: TestRun | undefined): string {
  return run ? `${TEST_LABEL[run.status]} (${run.reason})` : "no test";
}

/** The open findings with everything said about them so far, for the implementer. */
function findingsMarkdown(p: ReviewProgress, ids: readonly string[], round: number): string {
  const out: string[] = [`# Review findings (round ${round})`, ""];
  for (const id of ids) {
    const f = p.review!.findings.find((x) => x.id === id)!;
    const test = p.confirm?.results[id];
    out.push(`## ${f.id} [${f.severity}] ${f.title}`, "", f.explanation, "", `References: ${f.refs.join(", ")}`, `Reviewer confidence: ${f.confidence}`, `Test: ${testLine(test)}`);
    if (f.testFile) out.push("", `Reviewer's test file \`${f.testFile.path}\` (not on your branch):`, "", "```", f.testFile.content, "```");
    if (test?.logTail && test.status !== "refuted") out.push("", "Test output (tail):", "", "```", test.logTail, "```");
    for (const r of p.rounds.filter((x) => x.round < round)) {
      const resp = r.respond?.responses.find((x) => x.id === id);
      const reb = r.rebuttal?.rebuttals.find((x) => x.id === id);
      const re = r.retest?.results[id];
      if (resp) out.push("", `Your round ${r.round} answer: **${resp.action}**: ${resp.reasoning}`);
      if (re) out.push(`Test after your round ${r.round} changes: ${re.status === "confirmed" ? "still FAILS" : re.status === "refuted" ? "passes" : `could not run (${re.reason})`}`);
      if (reb) out.push(`Reviewer's round ${r.round} rebuttal: **${reb.verdict}**${reb.auto ? ` (automatic: ${reb.auto})` : ""}: ${reb.reasoning}${reb.refs.length ? ` (${reb.refs.join(", ")})` : ""}`);
    }
    out.push("");
  }
  return out.join("\n");
}

async function runRespond(ctx: StepContext, env: ReviewEnv, st: RunState, setup: ReviewSetup, p: ReviewProgress, round: number, open: string[]): Promise<RespondResult> {
  const { implementer } = reviewRoles(st);
  const file = writeInput(ctx, "findings.md", findingsMarkdown(p, open, round));
  const prompt = [
    `A reviewer from a different team reviewed your implementation. The findings to answer are in this file (read it with your read tool): ${file}`,
    "For each finding, either fix it by changing the code in this worktree (action: fixed), or reject it with concrete reasoning (action: rejected). Give path:line refs that support your answer (for a fix: where it is).",
    "A finding marked CONFIRMED comes with a test that the orchestrator ran and that fails on your code: treat it as demonstrated unless the test itself is wrong. A rejected confirmed finding is kept as a disagreement for the user to decide.",
    "The reviewer's test files are not on your branch; add a test yourself if you want one. Do not change unrelated code.",
    noShell(ctx.config.checks.map((c) => c.name)),
    `Answer every finding id exactly once: ${open.join(", ")}.`,
  ].join("\n\n");
  const prev = p.track!.head;
  const out = await editTurn(ctx, env, st, setup, {
    label: setup.implementerLabel,
    workerId: implementer,
    prompt,
    sessionId: prev.sessionId,
    siblingWritable: [],
    structured: { schema: respondSchema(open), name: "respond" },
  });
  const wt = setup.worktrees[setup.implementerLabel]!;
  const responses: FindingResponse[] = out.structured.responses.map((r) => {
    const { resolved, invalid } = resolveAtHead(r.refs, wt, { label: setup.implementerLabel, sha: out.head });
    return { ...r, resolvedRefs: resolved, invalidRefs: invalid };
  });
  const fixed = responses.filter((r) => r.action === "fixed").map((r) => r.id);
  if (fixed.length > 0 && (out.stepChangedFiles ?? []).length === 0) {
    ctx.record({ type: "warning", code: "fixed_without_changes", stepId: ctx.stepId, message: `findings answered as fixed, but the step changed no files: ${fixed.join(", ")}` });
  }
  const { structured: _s, ...edit } = out;
  return { ...edit, round, responses } satisfies RespondResult;
}

/** Why a finding is maintained without asking the reviewer, or undefined. */
function autoMaintained(p: ReviewProgress, id: string, respond: RespondResult, retest: TestsResult): string | undefined {
  if (p.confirm?.results[id]?.status !== "confirmed") return undefined;
  const action = respond.responses.find((r) => r.id === id)?.action;
  if (action === "rejected") return "confirmed by a failing test, but rejected";
  if (retest.results[id]?.status === "confirmed") return "answered as fixed, but its test still fails";
  return undefined;
}

async function runRebuttal(ctx: StepContext, env: ReviewEnv, st: RunState, setup: ReviewSetup, p: ReviewProgress, round: number, open: string[], track: Track): Promise<RebuttalResult> {
  const cfg = ctx.config;
  const { reviewer } = reviewRoles(st);
  const r = p.rounds.find((x) => x.round === round)!;
  const respond = r.respond!;
  const retest = r.retest!;
  const head = track.head.head;
  const prevReviewer = p.rounds.filter((x) => x.round < round).at(-1)?.rebuttal ?? { sessionId: p.review!.sessionId, head: p.review!.head };
  const auto = open.flatMap((id) => {
    const why = autoMaintained(p, id, respond, retest);
    return why ? [{ id, why }] : [];
  });
  const ask = open.filter((id) => !auto.some((a) => a.id === id));
  const autoRebuttals: Rebuttal[] = auto.map((a) => ({ id: a.id, verdict: "maintained", reasoning: a.why, refs: [], resolvedRefs: [], invalidRefs: [], auto: a.why }));
  const order = (rs: Rebuttal[]) => open.map((id) => rs.find((x) => x.id === id)!);
  if (ask.length === 0) {
    return { round, sessionId: prevReviewer.sessionId, head, rebuttals: order(autoRebuttals), maintained: [...open] };
  }

  const cwd = await followHead(ctx, env, st, setup, head);
  const implWt = setup.worktrees[setup.implementerLabel]!;
  const lines: string[] = [`# The implementer's answers (round ${round})`, ""];
  for (const id of open) {
    const f = p.review!.findings.find((x) => x.id === id)!;
    const resp = respond.responses.find((x) => x.id === id)!;
    const a = auto.find((x) => x.id === id);
    lines.push(`## ${id} [${f.severity}] ${f.title}${a ? " (maintained automatically, no answer needed)" : ""}`, "");
    lines.push(`Test: ${testLine(p.confirm?.results[id])}`);
    if (retest.results[id]) lines.push(`Test at the new head: ${TEST_LABEL[retest.results[id]!.status]} (${retest.results[id]!.reason})`);
    lines.push(`Answer: **${resp.action}**: ${resp.reasoning}`, `Refs: ${resp.refs.join(", ") || "none"}`);
    if (a) lines.push(`Maintained automatically: ${a.why}.`);
    lines.push("");
  }
  const files = {
    responses: writeInput(ctx, "responses.md", lines.join("\n")),
    diff: writeInput(ctx, "diff.patch", await squashedDiff(implWt, setup.base, head)),
    delta: writeInput(ctx, "delta.patch", await squashedDiff(implWt, prevReviewer.head, head)),
    checks: writeInput(ctx, "checks.md", checksMarkdown(track.check, track.fixes, roots(env, st, setup))),
  };
  const prompt = [
    "The implementer answered your findings and may have changed the code. Your working directory is now at their latest commit (read-only). Read these files with your read tool:",
    `- their answers: ${files.responses}`,
    `- the whole change against the base commit: ${files.diff}`,
    `- what changed since your last look: ${files.delta}`,
    `- the project's check results: ${files.checks}`,
    "",
    `For each of these findings, decide: withdrawn (the fix is adequate, or their reasoning convinces you) or maintained (the problem remains). A maintained finding needs new evidence: at least one repo-relative path:line reference into the current code (checked). Findings: ${ask.join(", ")}.`,
  ].join("\n");
  const schema = rebuttalSchema(ask);
  const taskOpts = { cwd, mode: "read-only" as const, stepDir: ctx.stepDir, inputsDir: path.join(ctx.stepDir, "inputs"), timeoutMs: cfg.timeouts.workerMs };
  const resolve = (v: { id: string; verdict: "withdrawn" | "maintained"; reasoning: string; refs: string[] }[]): Rebuttal[] =>
    v.map((x) => {
      const { resolved, invalid } = resolveAtHead(x.refs, cwd, { label: setup.implementerLabel, sha: head });
      return { ...x, resolvedRefs: resolved, invalidRefs: invalid };
    });

  return readOnlyGates(ctx, env, st, setup)(async () => {
    let out = await runStructured(ctx, { workerId: reviewer, schema, name: "rebuttal", task: { ...taskOpts, prompt, sessionId: prevReviewer.sessionId } });
    let rebuttals = resolve(out.value.rebuttals);
    let bad = rebuttals.filter((x) => x.verdict === "maintained" && x.resolvedRefs.length === 0);
    if (bad.length > 0) {
      out = await runStructured(ctx, {
        workerId: reviewer,
        schema,
        name: "rebuttal",
        task: {
          ...taskOpts,
          sessionId: out.done.sessionId,
          prompt: `These maintained findings have no reference that exists in the current code: ${bad.map((x) => `${x.id} (${x.refs.join(", ")})`).join("; ")}. Return the complete rebuttal again, with valid repo-relative path:line evidence for every maintained finding.`,
        },
      });
      rebuttals = resolve(out.value.rebuttals);
      bad = rebuttals.filter((x) => x.verdict === "maintained" && x.resolvedRefs.length === 0);
    }
    if (bad.length > 0) {
      // Still maintained (the user decides), but flagged: its new evidence did not check out.
      for (const x of bad) x.evidenceInvalid = true;
      ctx.record({ type: "warning", code: "rebuttal_evidence_invalid", stepId: ctx.stepId, message: `maintained without a resolving reference after the repair turn: ${bad.map((x) => x.id).join(", ")}` });
    }
    const all = order([...rebuttals, ...autoRebuttals]);
    return { round, sessionId: out.done.sessionId, head, rebuttals: all, maintained: all.filter((x) => x.verdict === "maintained").map((x) => x.id) } satisfies RebuttalResult;
  });
}

// ---- gate, apply, report ---------------------------------------------------------------

function lastWords(p: ReviewProgress, id: string) {
  const rounds = p.rounds.filter((r) => r.respond?.responses.some((x) => x.id === id));
  const last = rounds.at(-1);
  return { response: last?.respond?.responses.find((x) => x.id === id), rebuttal: last?.rebuttal?.rebuttals.find((x) => x.id === id) };
}

export function disagreementItems(p: ReviewProgress): DisagreementItem[] {
  return p.disagreements.map((id) => {
    const f = p.review!.findings.find((x) => x.id === id)!;
    const { response, rebuttal } = lastWords(p, id);
    const useNew = rebuttal && rebuttal.resolvedRefs.length > 0;
    return {
      id,
      severity: f.severity,
      title: f.title,
      explanation: f.explanation,
      test: p.confirm?.results[id]?.status ?? "none",
      implementer: response ? `${response.action}: ${response.reasoning}` : "",
      reviewer: rebuttal ? `${rebuttal.auto ? "maintained automatically" : "maintained"}: ${rebuttal.reasoning}` : "",
      refs: useNew ? rebuttal.refs : f.refs,
      resolvedRefs: useNew ? rebuttal.resolvedRefs : f.resolvedRefs,
    };
  });
}

async function runApply(ctx: StepContext, env: ReviewEnv, st: RunState, setup: ReviewSetup, p: ReviewProgress, track: Track): Promise<ReviewApplyResult> {
  const { implementer } = reviewRoles(st);
  const items = disagreementItems(p);
  const approved = p.approval!.approvedItemIds;
  const applied = items.filter((_, i) => approved.includes(i + 1));
  const dismissedIds = items.filter((_, i) => !approved.includes(i + 1)).map((x) => x.id);
  if (applied.length === 0) return { skipped: true, appliedIds: [], dismissedIds, head: track.head.head };
  const md = applied
    .map((it) => [`## ${it.id} [${it.severity}] ${it.title}`, "", it.explanation, "", `Refs: ${it.refs.join(", ")}`, `Test: ${it.test}`, `Your last answer: ${it.implementer}`, `Reviewer: ${it.reviewer}`].join("\n"))
    .join("\n\n");
  const file = writeInput(ctx, "apply.md", `# Findings the user decided to apply\n\n${md}\n`);
  const prompt = [
    `The user reviewed the remaining disagreements between you and the reviewer and decided that these findings must be addressed. Read this file with your read tool: ${file}`,
    "Fix each of them in this worktree. Do not change unrelated code.",
    noShell(ctx.config.checks.map((c) => c.name)),
    "Reply with a short summary of what you changed.",
  ].join("\n\n");
  const r = await editTurn(ctx, env, st, setup, { label: setup.implementerLabel, workerId: implementer, prompt, sessionId: track.head.sessionId, siblingWritable: [] });
  return { ...r, skipped: false, appliedIds: applied.map((x) => x.id), dismissedIds };
}

/** Final per-finding record (report.md and `fractory stats`). */
export interface FindingOutcome {
  id: string;
  severity: Severity;
  title: string;
  confidence: number;
  test: TestStatus | "none";
  /** The implementer's last answer. */
  action?: "fixed" | "rejected";
  /** withdrawn / maintained by the reviewer (after the last round), or dropped (no valid ref). */
  final: "withdrawn" | "maintained" | "dropped";
  autoMaintained: boolean;
  /** The user's decision on a maintained disagreement. */
  decision?: "apply" | "dismiss";
  rounds: number;
}

export function reviewOutcomes(p: ReviewProgress): FindingOutcome[] {
  const out: FindingOutcome[] = [];
  for (const f of p.review?.findings ?? []) {
    const { response, rebuttal } = lastWords(p, f.id);
    const final = p.disagreements.includes(f.id) ? "maintained" : "withdrawn";
    out.push({
      id: f.id,
      severity: f.severity,
      title: f.title,
      confidence: f.confidence,
      test: p.confirm?.results[f.id]?.status ?? "none",
      ...(response ? { action: response.action } : {}),
      final,
      autoMaintained: final === "maintained" && !!rebuttal?.auto,
      ...(p.apply?.appliedIds.includes(f.id) ? { decision: "apply" as const } : p.apply?.dismissedIds.includes(f.id) ? { decision: "dismiss" as const } : {}),
      rounds: p.rounds.filter((r) => r.respond?.responses.some((x) => x.id === f.id)).length,
    });
  }
  for (const f of p.review?.dropped ?? []) {
    out.push({ id: f.id, severity: f.severity, title: f.title, confidence: f.confidence, test: "none", final: "dropped", autoMaintained: false, rounds: 0 });
  }
  return out;
}

async function writeReport(ctx: StepContext, st: RunState, p: ReviewProgress): Promise<{ reportMd: string; outcomes: FindingOutcome[] }> {
  const setup = p.setup!;
  const { implementer, reviewer, implLabel } = reviewRoles(st);
  const head = p.track!.head.head;
  const branch = setup.branches[implLabel]!;
  const outcomes = reviewOutcomes(p);
  const md = (refs: string[], resolved: ResolvedRef[]) => evidenceMarkdown(refs, resolved, st.labels);
  const lines = [
    `# Review report: ${st.runId}`,
    "",
    `Implementer: ${implementer}. Reviewer: ${reviewer}. Base commit: \`${setup.base}\`.`,
    "",
    `Branch (never merged or pushed): \`${branch}\` → \`${head.slice(0, 10)}\``,
    "",
  ];
  const chk = p.track!.check;
  lines.push(`Checks at the final head: ${!chk || chk.results.length === 0 ? "none configured" : chk.allPassed ? "pass" : `FAIL (${chk.failures.map((f) => f.name).join(", ")})`}`, "");
  lines.push("## Review", "", p.review!.summary || "(no summary)", "");
  if (outcomes.length === 0) lines.push("The reviewer reported no findings.", "");
  else {
    lines.push("| id | severity | title | test | implementer | outcome |", "|---|---|---|---|---|---|");
    for (const o of outcomes) {
      const outcome = o.final === "maintained" ? `maintained${o.autoMaintained ? " (auto)" : ""}${o.decision ? ` → ${o.decision}` : ""}` : o.final;
      lines.push(`| ${o.id} | ${o.severity} | ${o.title.replace(/\|/g, "\\|")} | ${o.test} | ${o.action ?? ""} | ${outcome} |`);
    }
    lines.push("");
  }
  for (const f of p.review!.findings) {
    const test = p.confirm?.results[f.id];
    lines.push(`### ${f.id} [${f.severity}] ${f.title}`, "", f.explanation, "", `Refs: ${md(f.refs, f.resolvedRefs)}. Confidence: ${f.confidence}.`);
    if (f.testFile) lines.push(`Test \`${f.testFile.path}\`: **${test?.status ?? "not run"}** (${test?.reason ?? ""})`);
    for (const r of p.rounds) {
      const resp = r.respond?.responses.find((x) => x.id === f.id);
      if (!resp) continue;
      lines.push("", `Round ${r.round}: implementer **${resp.action}**: ${resp.reasoning}${resp.refs.length ? ` (${md(resp.refs, resp.resolvedRefs)})` : ""}`);
      const re = r.retest?.results[f.id];
      if (re) lines.push(`Test after round ${r.round}: ${re.status} (${re.reason})`);
      const reb = r.rebuttal?.rebuttals.find((x) => x.id === f.id);
      if (reb) lines.push(`Reviewer **${reb.verdict}**${reb.auto ? " (automatic)" : ""}: ${reb.reasoning}${reb.refs.length ? ` (${md(reb.refs, reb.resolvedRefs)})` : ""}${reb.evidenceInvalid ? " (its new evidence did not resolve)" : ""}`);
    }
    const o = outcomes.find((x) => x.id === f.id)!;
    if (o.decision) lines.push("", `User decision: **${o.decision}**`);
    lines.push("");
  }
  if (p.review!.dropped.length) {
    lines.push("## Dropped findings (no reference resolved at the head)", "", ...p.review!.dropped.map((f) => `- ${f.id} [${f.severity}] ${f.title} (${f.refs.join(", ")})`), "");
  }
  if (p.apply && !p.apply.skipped) {
    lines.push("## Apply", "", `${implementer} applied ${p.apply.appliedIds.join(", ")}; dismissed: ${p.apply.dismissedIds.join(", ") || "none"}.`, "", fs.readFileSync(p.apply.summaryFile!, "utf8").trim(), "");
  } else if (p.apply) {
    lines.push("## Apply", "", `All disagreements dismissed (${p.apply.dismissedIds.join(", ")}); nothing applied.`, "");
  }
  lines.push("Inspect: `git log` / `git diff` on the branch above, in your repository. fractory never merges or pushes.");
  if (p.review!.findings.some((f) => f.testFile) && !ctx.config.review.testCommand) {
    lines.push("", "Note: review.testCommand is not configured, so the reviewer's test files were not run.");
  }
  return { reportMd: writeOut(ctx, "report.md", lines.join("\n") + "\n"), outcomes };
}
