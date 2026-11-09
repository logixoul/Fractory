import * as path from "node:path";
import type { z } from "zod";
import { runChecksIsolated, runSetup, type CommandResult } from "../checks/runner.js";
import { withGates } from "../engine/gated.js";
import { runStructured } from "../engine/structured.js";
import type { StepContext } from "../engine/types.js";
import { checkpoint, commitStepResult, restoreCheckpoint } from "../git/checkpoint.js";
import { changedFiles, revParse } from "../git/git.js";
import { dataPaths } from "../paths.js";
import type { RunState } from "../state/reducer.js";
import { relativizePaths } from "../text/anonymize.js";
import { res, writeInput, writeOut } from "./common.js";

/**
 * Edit turns and check → fix loops shared by the duel and review workflows. Every edit turn is
 * checkpointed (§8.8) and gated (§8.2/§8.14); every check run is isolated (§8.18).
 */
export interface EditEnv {
  dataDir: string;
}

/** What an edit turn needs from a workflow's setup result. */
export interface WorktreeSetup {
  base: string;
  /** label → worktree path; every one of them is snapshot-gated. */
  worktrees: Record<string, string>;
}

export interface EditResult {
  sessionId: string;
  checkpoint: string;
  head: string;
  summaryFile: string;
  /** Changed files of the branch against the base. */
  changedFiles: string[];
  /** Files this step changed (checkpoint..head). Absent in runs recorded before it existed. */
  stepChangedFiles?: string[];
}

export interface CheckStepResult {
  sha: string;
  allPassed: boolean;
  results: Omit<CommandResult, "logTail">[];
  /** Log tails of failed checks only (fed back to the worker). */
  failures: { name: string; argv: string[]; code: number | null; reason: string; logTail: string }[];
  artifacts: string[];
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

/** A check → fix loop after an edit step: check(0) → [fix(1) → check(1) → …] until pass or maxFix. */
export function checkFixLoop(st: RunState, first: EditResult, ids: { check: (i: number) => string; fix: (i: number) => string }, maxFix: number): Loop {
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

export function guardCtx(env: EditEnv, st: RunState) {
  return { dataDir: env.dataDir, mainRepo: st.repo };
}

export async function headsOf(worktrees: Record<string, string>): Promise<Record<string, string>> {
  const out: Record<string, string> = {};
  for (const [l, p] of Object.entries(worktrees)) out[l] = await revParse(p);
  return out;
}

export const noShell = (checkNames: string[]) =>
  `You have no shell. The orchestrator runs the project's checks after you finish${checkNames.length ? ` (${checkNames.join(", ")})` : ""} and reports failures back to you.`;

export interface EditTurnOptions<S extends z.ZodType | undefined = undefined> {
  label: string;
  workerId: string;
  prompt: string;
  sessionId?: string;
  /** Worktrees a parallel sibling step may change (ignored by this step's gate). */
  siblingWritable: string[];
  /** Structured output of the turn (runStructured: one repair attempt, same session). */
  structured?: S extends z.ZodType ? { schema: S; name: string } : undefined;
}

export type EditTurnResult<S> = EditResult & (S extends z.ZodType ? { structured: z.infer<S> } : object);

/**
 * One checkpointed, gated edit turn (§8.8): checkpoint (or restore the previous attempt's
 * checkpoint), run the worker in edit mode in its own worktree, commit the result.
 */
export async function editTurn<S extends z.ZodType | undefined = undefined>(
  ctx: StepContext,
  env: EditEnv,
  st: RunState,
  setup: WorktreeSetup,
  o: EditTurnOptions<S>,
): Promise<EditTurnResult<S>> {
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
  const task = {
    prompt: o.prompt,
    cwd: wt,
    mode: "edit" as const,
    stepDir: ctx.stepDir,
    inputsDir,
    ...(o.sessionId ? { sessionId: o.sessionId } : {}),
  };
  const out = await withGates(
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
    async () => {
      if (!o.structured) return { done: await ctx.runWorker(o.workerId, task), structured: undefined };
      const s = o.structured as { schema: z.ZodType; name: string };
      const r = await runStructured(ctx, { workerId: o.workerId, schema: s.schema, name: s.name, task });
      return { done: r.done, structured: r.value as unknown };
    },
  );
  const head = await commitStepResult(wt, ctx.stepId, hooks);
  const result: EditResult = {
    sessionId: out.done.sessionId,
    checkpoint: cp,
    head,
    summaryFile: writeOut(ctx, "summary.md", out.done.finalText),
    changedFiles: await changedFiles(wt, setup.base, head),
    stepChangedFiles: await changedFiles(wt, cp, head),
  };
  return (o.structured ? { ...result, structured: out.structured } : result) as EditTurnResult<S>;
}

/** A fix turn: resume the session with the failed check output as an input file. */
export function fixTurn(
  ctx: StepContext,
  env: EditEnv,
  st: RunState,
  setup: WorktreeSetup,
  o: { label: string; workerId: string; failed: CheckStepResult; iteration: number; maxFix: number; sessionId: string; siblingWritable: string[] },
): Promise<EditResult> {
  const roots = [...Object.values(setup.worktrees), env.dataDir];
  const report = o.failed.failures
    .map((f) => `## ${f.name} (exit ${f.code ?? "none"}, ${f.reason})\n\n\`${JSON.stringify(f.argv)}\`\n\n\`\`\`\n${relativizePaths(f.logTail, roots)}\n\`\`\``)
    .join("\n\n");
  const file = writeInput(ctx, "check-failures.md", `# Failed checks (fix iteration ${o.iteration} of ${o.maxFix})\n\n${report}\n`);
  const prompt = [
    `The orchestrator ran the project's checks on your changes and some failed. The output is in this file (read it with your read tool): ${file}`,
    "Fix the code in this worktree so the checks pass, without weakening or deleting the checks themselves.",
    noShell(ctx.config.checks.map((c) => c.name)),
    "Reply with a short summary of the fix.",
  ].join("\n\n");
  return editTurn(ctx, env, st, setup, { label: o.label, workerId: o.workerId, prompt, sessionId: o.sessionId, siblingWritable: o.siblingWritable });
}

export async function runChecksFor(ctx: StepContext, env: EditEnv, st: RunState, wt: string, sha: string): Promise<CheckStepResult> {
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

export function checksMarkdown(c: CheckStepResult | undefined, fixes: number, roots: string[]): string {
  if (!c || c.results.length === 0) return "No checks are configured for this repository.\n";
  const lines = [`Fix iterations used: ${fixes}`, "", "| check | result | exit | duration |", "|---|---|---|---|"];
  for (const r of c.results) lines.push(`| ${r.name} | ${r.passed ? "pass" : "FAIL"} | ${r.code ?? r.reason} | ${(r.durationMs / 1000).toFixed(1)}s |`);
  for (const f of c.failures) lines.push("", `### ${f.name} output (tail)`, "", "```", relativizePaths(f.logTail, roots), "```");
  return lines.join("\n") + "\n";
}
