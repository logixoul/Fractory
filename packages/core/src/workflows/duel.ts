import * as fs from "node:fs";
import * as path from "node:path";
import { runChecksIsolated, runSetup, type CommandResult } from "../checks/runner.js";
import { StepFailure } from "../engine/errors.js";
import { withGates } from "../engine/gated.js";
import { runStructured } from "../engine/structured.js";
import type { ApprovalGate, StepContext, StepDef, WorkStep, WorkflowDef } from "../engine/types.js";
import { checkpoint, commitStepResult, restoreCheckpoint } from "../git/checkpoint.js";
import { changedFiles, revParse, squashedDiff } from "../git/git.js";
import { ensureWorktree, worktreeBranch } from "../git/worktree.js";
import { dataPaths } from "../paths.js";
import { DuelVerdict } from "../schemas/outputs.js";
import type { RunState } from "../state/reducer.js";
import { leakCheck, relativizePaths } from "../text/anonymize.js";
import { loadProjectContext } from "../text/context.js";
import { checkRefs } from "../text/refs.js";
import { randomHex, seededShuffle } from "../util/random.js";
import { identityTokenWarning, judgeScrubber, labelsOf, promptText, res, runSwapPass, writeInput, writeOut } from "./common.js";

/**
 * Duel workflow (spec "Workflow 2"):
 *   setup (worktrees + per-repo setup) → per contestant, in parallel:
 *     implement → check.0 → [fix.1 → check.1 → … ≤ maxFixIterations, until checks pass]
 *     (an implementation without changes forfeits: no checks, no judge for it)
 *   → judge (squashed diffs + check results, anonymized, seeded A/B; optional swapped pass)
 *   → approve (human gate) → apply (resume the apply worker's session with approved items and
 *   the other diff's excerpts) → recheck.0 → [refix.1 → recheck.1 → …] → report.
 *   One forfeit: skip judge/apply, report the other branch. Both forfeit: the run fails.
 * Never merges or pushes; the branches are left for the user.
 * Every edit step is checkpointed (§8.8) and gated (§8.2/§8.14); every check run is isolated (§8.18).
 */
export interface DuelEnv {
  dataDir: string;
}

export interface DuelSetup {
  base: string;
  worktrees: Record<string, string>;
  branches: Record<string, string>;
  judgeLabel: string;
  contextFile: string;
  contextFiles: { path: string; sha256: string; bytes: number; truncated: boolean }[];
}

export interface EditResult {
  sessionId: string;
  checkpoint: string;
  head: string;
  summaryFile: string;
  changedFiles: string[];
}

export interface CheckStepResult {
  sha: string;
  allPassed: boolean;
  results: Omit<CommandResult, "logTail">[];
  /** Log tails of failed checks only (fed back to the worker). */
  failures: { name: string; argv: string[]; code: number | null; reason: string; logTail: string }[];
  artifacts: string[];
}

export interface JudgeItem {
  aspect: string;
  betterSide: "A" | "B";
  betterLabel: string;
  betterWorker: string;
  evidence: string[];
  recommendation: string;
  risk: string;
}

export interface DuelJudgeResult {
  verdictFile: string;
  summary: string;
  sides: Record<"A" | "B", { label: string; workerId: string }>;
  items: JudgeItem[];
  invalidEvidence: string[];
  /** Items the swapped-order pass disagreed with (judge.swapOrderPass). */
  droppedBySwapPass: JudgeItem[];
  /** No point survived the swapped-order pass: the verdict is empty (nothing to approve). */
  noRobustPreferences: boolean;
  /** Each contestant's head commit as judged (path:line evidence refers to these). */
  heads: Record<string, string>;
}

export interface ApplyResult extends Partial<EditResult> {
  skipped: boolean;
  approvedItemIds: number[];
  head: string;
}

const configOf = (st: RunState) =>
  st.config as {
    duel: { maxFixIterations: number; applyWorker?: string };
    checks: unknown[];
  };

export function applyWorkerOf(st: RunState): { workerId: string; label: string } {
  const workerId = configOf(st).duel.applyWorker ?? st.roles.contestants[0];
  const label = Object.entries(st.labels).find(([, w]) => w === workerId)?.[0];
  if (!label) throw new Error(`apply worker '${workerId}' has no label in this run`);
  return { workerId, label };
}

export interface Loop {
  /** Next step of the loop, if it is not finished. */
  next?: string;
  finalCheck?: CheckStepResult;
  /** Latest edit (the loop's head). */
  head?: EditResult;
  sessionId?: string;
  fixes: number;
}

/** A check → fix loop after an edit step: check.0 → [fix.1 → check.1 → …] until pass or maxFix. */
function checkFixLoop(st: RunState, first: EditResult, ids: { check: (i: number) => string; fix: (i: number) => string }, maxFix: number): Loop {
  let head = first;
  for (let i = 0; ; i++) {
    const chk = res<CheckStepResult>(st, ids.check(i));
    if (!chk) return { next: ids.check(i), head, sessionId: head.sessionId, fixes: i };
    if (chk.allPassed || i >= maxFix) return { finalCheck: chk, head, sessionId: head.sessionId, fixes: i };
    const fix = res<EditResult>(st, ids.fix(i + 1));
    if (!fix) return { next: ids.fix(i + 1), head, sessionId: head.sessionId, fixes: i };
    head = fix;
  }
}

export interface Chain extends Loop {
  forfeited: boolean;
}

/** Where a contestant's implement → check/fix chain stands. */
export function chainOf(st: RunState, label: string, maxFix: number): Chain {
  const impl = res<EditResult>(st, `implement.${label}`);
  if (!impl) return { next: `implement.${label}`, forfeited: false, fixes: 0 };
  if (impl.changedFiles.length === 0) return { head: impl, sessionId: impl.sessionId, forfeited: true, fixes: 0 };
  return { ...checkFixLoop(st, impl, { check: (i) => `check.${i}.${label}`, fix: (i) => `fix.${i}.${label}` }, maxFix), forfeited: false };
}

/** The post-apply check → fix loop (recheck.0 → [refix.1 → recheck.1 → …]). */
export function applyLoopOf(st: RunState, apply: ApplyResult, maxFix: number): Loop | undefined {
  if (apply.skipped) return undefined;
  return checkFixLoop(st, apply as EditResult, { check: (i) => `recheck.${i}`, fix: (i) => `refix.${i}` }, maxFix);
}

export function duelWorkflow(env: DuelEnv): WorkflowDef {
  return {
    name: "duel",
    next(st) {
      const maxFix = configOf(st).duel.maxFixIterations;
      const labels = Object.keys(st.labels).sort();
      const setup = res<DuelSetup>(st, "setup");
      if (!setup) return { kind: "stage", steps: [setupStep(env, st)] };

      const chains = labels.map((l) => ({ label: l, ...chainOf(st, l, maxFix) }));
      const pending = chains.filter((c) => c.next);
      if (pending.length > 0) {
        const steps: StepDef[] = pending.map((c) => chainStep(env, st, setup, c.label, c.next!, labels, pending.length > 1));
        return { kind: "stage", steps };
      }

      const forfeited = chains.filter((c) => c.forfeited).map((c) => c.label);
      if (forfeited.length === labels.length) {
        // Both forfeit: a machine-checked dead end (rule 6), recorded as a failing step.
        return { kind: "stage", steps: [bothForfeitStep(st)] };
      }
      if (forfeited.length === 0) {
        const judge = res<DuelJudgeResult>(st, "judge");
        if (!judge) return { kind: "stage", steps: [judgeStep(env, st, setup, maxFix)] };
        const approval = res<{ approvedItemIds: number[] }>(st, "approve");
        if (!approval) {
          const gate: ApprovalGate = { kind: "approval_gate", id: "approve", items: (s) => res<DuelJudgeResult>(s, "judge")!.items };
          return { kind: "stage", steps: [gate] };
        }
        const apply = res<ApplyResult>(st, "apply");
        if (!apply) return { kind: "stage", steps: [applyStep(env, st, setup, judge, approval.approvedItemIds, maxFix)] };
        const loop = applyLoopOf(st, apply, maxFix);
        if (loop?.next) return { kind: "stage", steps: [applyLoopStep(env, st, setup, loop)] };
      }
      const report = res<{ reportMd: string }>(st, "report");
      if (!report) return { kind: "stage", steps: [reportStep(st, setup, maxFix)] };
      const winner = forfeited.length === 1 ? labels.find((l) => !forfeited.includes(l)) : undefined;
      return {
        kind: "done",
        result: { reportMd: report.reportMd, branches: setup.branches, forfeited, ...(winner ? { winner: { label: winner, workerId: st.labels[winner], branch: setup.branches[winner] } } : {}) },
      };
    },
  };
}

function bothForfeitStep(st: RunState): WorkStep {
  return {
    id: "outcome",
    async run() {
      return { forfeited: Object.keys(st.labels).sort() };
    },
    exitCheck: () => ({ ok: false, reason: "both contestants forfeited: neither implementation changed any file" }),
  };
}

function setupStep(env: DuelEnv, st: RunState): WorkStep {
  return {
    id: "setup",
    async run(ctx) {
      const base = await revParse(st.repo);
      const contestants = Object.keys(st.labels).sort();
      let judgeLabel = randomHex(2);
      while (contestants.includes(judgeLabel)) judgeLabel = randomHex(2);
      const worktrees: Record<string, string> = {};
      const branches: Record<string, string> = {};
      for (const label of [...contestants, judgeLabel]) {
        const wt = await ensureWorktree({ repo: st.repo, dataDir: env.dataDir, runId: st.runId, label, base });
        worktrees[label] = wt.path;
        if (contestants.includes(label)) branches[label] = worktreeBranch(st.runId, label);
      }
      // Per-repo setup (§8.15) in the worktrees that will run checks. Failure = env_error.
      for (const label of contestants) await runSetup(worktrees[label]!, ctx.config.setup, path.join(ctx.stepDir, "logs", label), ctx.signal);
      const pc = await loadProjectContext(st.repo, base, ctx.config.contextFiles);
      const contextFile = writeOut(ctx, "context.md", pc.text);
      return { base, worktrees, branches, judgeLabel, contextFile, contextFiles: pc.files } satisfies DuelSetup;
    },
  };
}

function guardCtx(env: DuelEnv, st: RunState) {
  return { dataDir: env.dataDir, mainRepo: st.repo };
}

async function headsOf(worktrees: Record<string, string>): Promise<Record<string, string>> {
  const out: Record<string, string> = {};
  for (const [l, p] of Object.entries(worktrees)) out[l] = await revParse(p);
  return out;
}

/**
 * One checkpointed, gated edit turn (§8.8): checkpoint (or restore the previous attempt's
 * checkpoint), run the worker in edit mode in its own worktree, commit the result.
 */
async function editTurn(
  ctx: StepContext,
  env: DuelEnv,
  st: RunState,
  setup: DuelSetup,
  o: { label: string; workerId: string; prompt: string; sessionId?: string; siblingWritable: string[] },
): Promise<EditResult> {
  const wt = setup.worktrees[o.label]!;
  const hooks = dataPaths(env.dataDir).emptyHooks;
  const guard = guardCtx(env, st);
  const prev = ctx.state().steps[ctx.stepId]?.checkpoint;
  let cp: string;
  if (prev) {
    const removed = await restoreCheckpoint(wt, prev, guard, ctx.config.preserveOnClean);
    if (removed.length > 0) await runSetup(wt, ctx.config.setup, path.join(ctx.stepDir, "logs", "setup"), ctx.signal);
    cp = prev;
  } else {
    cp = await checkpoint(wt, ctx.stepId, hooks);
    ctx.record({ type: "checkpoint_created", stepId: ctx.stepId, label: o.label, sha: cp });
  }
  const inputsDir = path.join(ctx.stepDir, "inputs");
  const restoreTo = { ...(await headsOf(setup.worktrees)), [o.label]: cp };
  const done = await withGates(
    ctx,
    {
      targets: { mainRepo: st.repo, worktrees: setup.worktrees },
      guard,
      restoreTo,
      preserveOnClean: ctx.config.preserveOnClean,
      writableLabel: o.label,
      siblingWritable: o.siblingWritable,
      inputsDir,
    },
    () =>
      ctx.runWorker(o.workerId, {
        prompt: o.prompt,
        cwd: wt,
        mode: "edit",
        stepDir: ctx.stepDir,
        inputsDir,
        ...(o.sessionId ? { sessionId: o.sessionId } : {}),
      }),
  );
  const head = await commitStepResult(wt, ctx.stepId, hooks);
  return {
    sessionId: done.sessionId,
    checkpoint: cp,
    head,
    summaryFile: writeOut(ctx, "summary.md", done.finalText),
    changedFiles: await changedFiles(wt, setup.base, head),
  };
}

const noShell = (checkNames: string[]) =>
  `You have no shell. The orchestrator runs the project's checks after you finish${checkNames.length ? ` (${checkNames.join(", ")})` : ""} and reports failures back to you.`;

/** A fix turn: resume the session with the failed check output as an input file. */
function fixStep(env: DuelEnv, st: RunState, setup: DuelSetup, o: { id: string; label: string; failed: CheckStepResult; iteration: number; sessionId: string; siblingWritable: string[] }): WorkStep {
  const workerId = st.labels[o.label]!;
  const maxFix = configOf(st).duel.maxFixIterations;
  return {
    id: o.id,
    workerId,
    label: o.label,
    async run(ctx) {
      const roots = [...Object.values(setup.worktrees), env.dataDir];
      const report = o.failed.failures
        .map((f) => `## ${f.name} (exit ${f.code ?? "none"}, ${f.reason})\n\n\`${JSON.stringify(f.argv)}\`\n\n\`\`\`\n${relativizePaths(f.logTail, roots)}\n\`\`\``)
        .join("\n\n");
      const file = writeInput(ctx, "check-failures.md", `# Failed checks (fix iteration ${o.iteration} of ${maxFix})\n\n${report}\n`);
      const prompt = [
        `The orchestrator ran the project's checks on your changes and some failed. The output is in this file (read it with your read tool): ${file}`,
        "Fix the code in this worktree so the checks pass, without weakening or deleting the checks themselves.",
        noShell(ctx.config.checks.map((c) => c.name)),
        "Reply with a short summary of the fix.",
      ].join("\n\n");
      return editTurn(ctx, env, st, setup, { label: o.label, workerId, prompt, sessionId: o.sessionId, siblingWritable: o.siblingWritable });
    },
  };
}

function chainStep(env: DuelEnv, st: RunState, setup: DuelSetup, label: string, stepId: string, labels: string[], parallel: boolean): WorkStep {
  const workerId = st.labels[label]!;
  const sibling = parallel ? labels.filter((l) => l !== label) : [];
  const kind = stepId.split(".")[0];
  const maxFix = configOf(st).duel.maxFixIterations;
  const chain = chainOf(st, label, maxFix);

  if (kind === "implement") {
    return {
      id: stepId,
      workerId,
      label,
      async run(ctx) {
        const prompt = [
          "You are one of two engineers independently implementing the task below in the repository in your current working directory. Make the changes directly with your file tools.",
          noShell(ctx.config.checks.map((c) => c.name)),
          fs.readFileSync(setup.contextFile, "utf8"),
          `## Task\n\n${promptText(ctx.run.dir)}`,
          "When you are done, reply with a short summary of what you changed and why.",
        ]
          .filter(Boolean)
          .join("\n\n");
        return editTurn(ctx, env, st, setup, { label, workerId, prompt, siblingWritable: sibling });
      },
      // No exit check: an implementation without changes is a forfeit (handled by the workflow).
    };
  }
  if (kind === "fix") {
    const i = Number(stepId.split(".")[1]);
    return fixStep(env, st, setup, {
      id: stepId,
      label,
      failed: res<CheckStepResult>(st, `check.${i - 1}.${label}`)!,
      iteration: i,
      sessionId: chain.sessionId!,
      siblingWritable: sibling,
    });
  }
  return checkStep(env, st, setup, label, stepId, chain.head!.head);
}

/** The next step of the post-apply loop: a recheck, or a refix resuming the apply session. */
function applyLoopStep(env: DuelEnv, st: RunState, setup: DuelSetup, loop: Loop): WorkStep {
  const { label } = applyWorkerOf(st);
  const id = loop.next!;
  if (id.startsWith("recheck.")) return checkStep(env, st, setup, label, id, loop.head!.head);
  const i = Number(id.split(".")[1]);
  return fixStep(env, st, setup, { id, label, failed: res<CheckStepResult>(st, `recheck.${i - 1}`)!, iteration: i, sessionId: loop.sessionId!, siblingWritable: [] });
}

function checkStep(env: DuelEnv, st: RunState, setup: DuelSetup, label: string, stepId: string, sha: string): WorkStep {
  return {
    id: stepId,
    label,
    async run(ctx) {
      return runChecksFor(ctx, env, st, setup.worktrees[label]!, sha);
    },
  };
}

async function runChecksFor(ctx: StepContext, env: DuelEnv, st: RunState, wt: string, sha: string): Promise<CheckStepResult> {
  const cfg = ctx.config;
  if (cfg.checks.length === 0) return { sha, allPassed: true, results: [], failures: [], artifacts: [] };
  const guard = guardCtx(env, st);
  if (ctx.attempt > 1) {
    // A previous attempt may have been interrupted mid-check: start from the post-step commit.
    const removed = await restoreCheckpoint(wt, sha, guard, cfg.preserveOnClean);
    if (removed.length > 0) await runSetup(wt, cfg.setup, path.join(ctx.stepDir, "logs", "setup"), ctx.signal);
  }
  const out = await runChecksIsolated({
    worktree: wt,
    postStepSha: sha,
    checks: cfg.checks,
    setup: cfg.setup,
    preserveOnClean: cfg.preserveOnClean,
    guard,
    snapshot: cfg.snapshot,
    stepDir: ctx.stepDir,
    signal: ctx.signal,
  });
  return {
    sha,
    allPassed: out.allPassed,
    results: out.results.map(({ logTail: _t, ...r }) => r),
    failures: out.results.filter((r) => !r.passed).map((r) => ({ name: r.name, argv: r.argv, code: r.code, reason: r.reason, logTail: r.logTail })),
    artifacts: out.artifacts,
  };
}

function checksMarkdown(c: CheckStepResult | undefined, fixes: number, roots: string[]): string {
  if (!c || c.results.length === 0) return "No checks are configured for this repository.\n";
  const lines = [`Fix iterations used: ${fixes}`, "", "| check | result | exit | duration |", "|---|---|---|---|"];
  for (const r of c.results) lines.push(`| ${r.name} | ${r.passed ? "pass" : "FAIL"} | ${r.code ?? r.reason} | ${(r.durationMs / 1000).toFixed(1)}s |`);
  for (const f of c.failures) lines.push("", `### ${f.name} output (tail)`, "", "```", relativizePaths(f.logTail, roots), "```");
  return lines.join("\n") + "\n";
}

function judgeStep(env: DuelEnv, st: RunState, setup: DuelSetup, maxFix: number): WorkStep {
  const judgeId = st.roles.judge;
  return {
    id: "judge",
    workerId: judgeId,
    label: setup.judgeLabel,
    async run(ctx) {
      const cfg = ctx.config;
      const labels = Object.keys(st.labels).sort();
      const [la, lb] = seededShuffle(labels, st.seed) as [string, string];
      const sides = { A: { label: la, workerId: st.labels[la]! }, B: { label: lb, workerId: st.labels[lb]! } };
      const roots = [...Object.values(setup.worktrees), st.repo, env.dataDir];
      const scrubber = judgeScrubber(ctx, st);
      const chains = { [la]: chainOf(st, la, maxFix), [lb]: chainOf(st, lb, maxFix) };

      // Diffs are passed verbatim (code is never rewritten, §8.16); paths in git diffs are repo-relative.
      const diffs = {
        [la]: await squashedDiff(setup.worktrees[la]!, setup.base, chains[la]!.head!.head),
        [lb]: await squashedDiff(setup.worktrees[lb]!, setup.base, chains[lb]!.head!.head),
      };
      // The user's own task text is exempt from scrub and leak check.
      const taskFile = writeInput(ctx, "task.md", promptText(ctx.run.dir));
      const sideFiles = (prefix: string, a: string, b: string) => ({
        diffA: writeInput(ctx, `${prefix}diff-A.patch`, diffs[a]!),
        diffB: writeInput(ctx, `${prefix}diff-B.patch`, diffs[b]!),
        checksA: writeInput(ctx, `${prefix}checks-A.md`, checksMarkdown(chains[a]!.finalCheck, chains[a]!.fixes, roots)),
        checksB: writeInput(ctx, `${prefix}checks-B.md`, checksMarkdown(chains[b]!.finalCheck, chains[b]!.fixes, roots)),
      });
      const files = sideFiles("", la, lb);
      // Swap pass inputs must exist before the step's inputs/ baseline is taken (§8.19).
      const swapped = cfg.judge.swapOrderPass ? sideFiles("swap/", lb, la) : undefined;
      // Tool output (check logs) gets the path leak check only.
      const forbidden = [env.dataDir, ...Object.values(setup.worktrees)];
      const leaks = [files.checksA, files.checksB].flatMap((f) => leakCheck(fs.readFileSync(f, "utf8"), { patterns: [], replacement: "" }, forbidden));
      if (leaks.length > 0) throw new StepFailure("integrity", `anonymization leak check failed for judge inputs (${leaks.length} hit(s))`);
      // Code in diffs is never rewritten; identity tokens in it only produce a warning.
      identityTokenWarning(ctx, scrubber, { "diff-A.patch": diffs[la]!, "diff-B.patch": diffs[lb]! });

      const fileList = (f: ReturnType<typeof sideFiles>) =>
        [
          `- task: ${taskFile}`,
          `- diff of A against the base commit: ${f.diffA}`,
          `- diff of B against the base commit: ${f.diffB}`,
          `- check results of A: ${f.checksA}`,
          `- check results of B: ${f.checksB}`,
        ].join("\n");
      const cwd = setup.worktrees[setup.judgeLabel]!;
      const prompt = [
        "You are the judge. Two anonymous engineers, A and B, independently implemented the task below. Read these files with your read tool:",
        fileList(files),
        "",
        "Your working directory holds the base commit (read-only), for context. The order of A and B is random and carries no meaning.",
        "Compare the implementations aspect by aspect (correctness, completeness, tests, design, risk). For each aspect give the better side, path:line evidence (repo-relative, as the file is in that side's version or in the base), a concrete recommendation for the final implementation, and the risk of adopting it.",
      ].join("\n");
      const taskOpts = { cwd, mode: "read-only" as const, stepDir: ctx.stepDir, inputsDir: path.join(ctx.stepDir, "inputs"), timeoutMs: cfg.timeouts.judgeMs };
      const evidenceRoots = [setup.worktrees[la]!, setup.worktrees[lb]!];

      return withGates(
        ctx,
        {
          targets: { mainRepo: st.repo, worktrees: setup.worktrees },
          guard: guardCtx(env, st),
          restoreTo: await headsOf(setup.worktrees),
          preserveOnClean: cfg.preserveOnClean,
          inputsDir: taskOpts.inputsDir,
        },
        async () => {
          let r = await runStructured(ctx, { workerId: judgeId, schema: DuelVerdict, name: "verdict", task: { ...taskOpts, prompt } });
          let bad = duelEvidence(r.value, cwd, evidenceRoots);
          if (bad.unsupported.length > 0) {
            r = await runStructured(ctx, {
              workerId: judgeId,
              schema: DuelVerdict,
              name: "verdict",
              task: {
                ...taskOpts,
                sessionId: r.done.sessionId,
                prompt: `These items have no evidence reference that exists in either implementation or the base (file must exist, line within the file): ${bad.unsupported.join("; ")}. Return the complete verdict again with valid path:line evidence for every item.`,
              },
            });
            bad = duelEvidence(r.value, cwd, evidenceRoots);
          }
          if (bad.unsupported.length > 0) throw new StepFailure("exit_check", `judge items without valid evidence: ${bad.unsupported.join("; ")}`);
          let items: JudgeItem[] = r.value.items.map((it) => ({ ...it, betterLabel: sides[it.betterSide].label, betterWorker: sides[it.betterSide].workerId }));
          let dropped: JudgeItem[] = [];
          if (swapped) {
            const ratings = await runSwapPass(ctx, {
              judgeId,
              cwd,
              timeoutMs: cfg.timeouts.judgeMs,
              fileList: fileList(swapped),
              points: items.map((it, i) => ({ index: i + 1, text: `${it.aspect}: ${it.recommendation}` })),
            });
            const agreed = items.filter((it, i) => {
              const second = ratings.get(i + 1);
              return second !== undefined && labelsOf(second, lb, la).join() === it.betterLabel;
            });
            dropped = items.filter((it) => !agreed.includes(it));
            if (agreed.length === 0) {
              // Not a failure: there are no order-robust preferences. Continue with an empty verdict.
              ctx.record({ type: "warning", code: "no_robust_preferences", stepId: ctx.stepId, message: "the swapped-order judge pass agreed with none of the first pass's items; there is nothing to approve" });
            }
            items = agreed;
          }
          const noRobustPreferences = !!swapped && items.length === 0;
          const heads = { [la]: chains[la]!.head!.head, [lb]: chains[lb]!.head!.head };
          const verdictFile = writeOut(
            ctx,
            "verdict.json",
            JSON.stringify({ verdict: r.value, sides, heads, items, invalidEvidence: bad.invalid, droppedBySwapPass: dropped, noRobustPreferences }, null, 2) + "\n",
          );
          return { verdictFile, summary: r.value.summary, sides, items, invalidEvidence: bad.invalid, droppedBySwapPass: dropped, noRobustPreferences, heads } satisfies DuelJudgeResult;
        },
      );
    },
  };
}

/** An item's evidence is valid if it resolves in either side's final worktree (or the base). */
function duelEvidence(v: DuelVerdict, baseRoot: string, sideRoots: string[]) {
  const invalid: string[] = [];
  const unsupported: string[] = [];
  for (const it of v.items) {
    const text = it.evidence.join("\n");
    const ok = [baseRoot, ...sideRoots].some((root) => checkRefs(text, root).valid.length > 0);
    if (!ok) unsupported.push(it.aspect);
    const all = checkRefs(text, baseRoot).invalid.map((r) => r.raw);
    invalid.push(...all.filter((raw) => !sideRoots.some((root) => checkRefs(raw, root).valid.length > 0)));
  }
  return { invalid, unsupported };
}

/** Diff sections of `diff` for the given repo-relative files (all of it if none match). */
export function diffExcerpt(diff: string, files: readonly string[]): string {
  const sections = diff.split(/^(?=diff --git )/m).filter(Boolean);
  const want = new Set(files);
  const picked = sections.filter((s) => {
    const m = /^diff --git a\/(.+?) b\/(.+)$/m.exec(s);
    return m && (want.has(m[1]!) || want.has(m[2]!));
  });
  return (picked.length > 0 ? picked : sections).join("");
}

function applyStep(env: DuelEnv, st: RunState, setup: DuelSetup, judge: DuelJudgeResult, approved: number[], maxFix: number): WorkStep {
  const { workerId, label } = applyWorkerOf(st);
  const otherLabel = Object.keys(st.labels).find((l) => l !== label)!;
  return {
    id: "apply",
    workerId,
    label,
    async run(ctx) {
      const mine = chainOf(st, label, maxFix);
      if (approved.length === 0) return { skipped: true, approvedItemIds: [], head: mine.head!.head } satisfies ApplyResult;
      const items = approved.map((n) => ({ n, ...judge.items[n - 1]! }));
      const rel = (it: JudgeItem) => (it.betterLabel === label ? "yours" : "the other implementation");
      const itemsMd = items
        .map((it) => [`### ${it.n}. ${it.aspect}`, `Better: ${rel(it)}`, `Recommendation: ${it.recommendation}`, `Risk: ${it.risk}`, `Evidence: ${it.evidence.join(", ")}`].join("\n"))
        .join("\n\n");
      const other = chainOf(st, otherLabel, maxFix);
      const otherDiff = await squashedDiff(setup.worktrees[otherLabel]!, setup.base, other.head!.head);
      const evidenceFiles = items
        .filter((it) => it.betterLabel !== label)
        .flatMap((it) => checkRefs(it.evidence.join("\n"), setup.worktrees[otherLabel]!).valid.map((r) => r.path!));
      const files = {
        items: writeInput(ctx, "approved-items.md", `# Approved items\n\n${itemsMd}\n`),
        diff: writeInput(ctx, "other-diff.patch", diffExcerpt(otherDiff, evidenceFiles)),
      };
      const prompt = [
        "A judge compared your implementation with an independent implementation of the same task, and the human approved these items to incorporate. Read with your read tool:",
        `- approved items: ${files.items}`,
        `- relevant excerpts of the other implementation's diff against the base: ${files.diff}`,
        "",
        "Apply the approved recommendations to your implementation in this worktree. Where an item says yours is better, keep your version. Do not change unrelated code.",
        noShell(ctx.config.checks.map((c) => c.name)),
        "Reply with a short summary of what you changed.",
      ].join("\n");
      const r = await editTurn(ctx, env, st, setup, { label, workerId, prompt, sessionId: mine.sessionId!, siblingWritable: [] });
      return { ...r, skipped: false, approvedItemIds: approved } satisfies ApplyResult;
    },
  };
}

function reportStep(st: RunState, setup: DuelSetup, maxFix: number): WorkStep {
  return {
    id: "report",
    async run(ctx) {
      const labels = Object.keys(st.labels).sort();
      const judge = res<DuelJudgeResult>(st, "judge");
      const apply = res<ApplyResult>(st, "apply");
      const lines = [`# Duel report: ${st.runId}`, "", `Base commit: \`${setup.base}\``, "", "## Branches (never merged or pushed)", ""];
      for (const l of labels) {
        const c = chainOf(st, l, maxFix);
        if (c.forfeited) {
          lines.push(`- \`${setup.branches[l]}\` (${st.labels[l]}): **forfeited**, the implementation changed no files`);
          continue;
        }
        const checks = c.finalCheck?.results.length ? (c.finalCheck.allPassed ? "checks pass" : "checks FAIL") : "no checks";
        lines.push(`- \`${setup.branches[l]}\` (${st.labels[l]}): head \`${c.head!.head.slice(0, 10)}\`, ${c.head!.changedFiles.length} file(s) changed, ${c.fixes} fix iteration(s), ${checks}`);
      }
      const forfeited = labels.filter((l) => chainOf(st, l, maxFix).forfeited);
      if (forfeited.length === 1) {
        const w = labels.find((l) => !forfeited.includes(l))!;
        lines.push("", "## Result", "", `${st.labels[forfeited[0]!]} forfeited, so there was no judge or apply step. The result is \`${setup.branches[w]}\` (${st.labels[w]}).`);
      }
      if (judge) {
        lines.push("", "## Judge", "", judge.summary, "", `Sides: A = ${judge.sides.A.workerId}, B = ${judge.sides.B.workerId}.`, "");
        if (judge.noRobustPreferences) lines.push("No robust preferences: with A and B swapped, the judge agreed with none of its first-pass items, so there was nothing to approve.", "");
        judge.items.forEach((it, i) => {
          const mark = apply?.approvedItemIds.includes(i + 1) ? "[x]" : "[ ]";
          lines.push(`${mark} **${i + 1}. ${it.aspect}**: better ${it.betterSide} (${it.betterWorker}). ${it.recommendation} *Risk:* ${it.risk || "none stated"}. Evidence: ${it.evidence.map((e) => `\`${e}\``).join(", ")}`);
        });
        if (judge.droppedBySwapPass.length) {
          lines.push("", "Dropped by the swapped-order pass:", ...judge.droppedBySwapPass.map((it) => `- ${it.aspect}: ${it.recommendation}`));
        }
      }
      if (apply) {
        const { workerId, label } = applyWorkerOf(st);
        lines.push("", "## Apply", "");
        if (apply.skipped) lines.push("No items approved; nothing applied.");
        else {
          const loop = applyLoopOf(st, apply, maxFix)!;
          lines.push(`${workerId} applied items ${apply.approvedItemIds.join(", ")} on \`${setup.branches[label]}\` → \`${loop.head!.head.slice(0, 10)}\` (${loop.fixes} fix iteration(s) after apply).`, "");
          lines.push(fs.readFileSync(apply.summaryFile!, "utf8").trim());
          const rc = loop.finalCheck!;
          lines.push("", "### Checks after apply", "", rc.results.length ? rc.results.map((r) => `- ${r.name}: ${r.passed ? "pass" : "FAIL"}`).join("\n") : "No checks configured.");
        }
      }
      lines.push("", "Inspect: `git log` / `git diff` on the branches above, in your repository. fractory never merges or pushes.");
      return { reportMd: writeOut(ctx, "report.md", lines.join("\n") + "\n") };
    },
  };
}
