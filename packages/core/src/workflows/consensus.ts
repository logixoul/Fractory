import * as fs from "node:fs";
import * as path from "node:path";
import { z } from "zod";
import { withGates, type GateSpec } from "../engine/gated.js";
import { StepFailure } from "../engine/errors.js";
import { runStructured } from "../engine/structured.js";
import type { StepContext, StepDef, WorkStep, WorkflowDef } from "../engine/types.js";
import { revParse } from "../git/git.js";
import { ensureWorktree } from "../git/worktree.js";
import { ConsensusVerdict, ReviseResult } from "../schemas/outputs.js";
import type { RunState } from "../state/reducer.js";
import { leakCheck, relativizePaths, scrubProse } from "../text/anonymize.js";
import { loadProjectContext } from "../text/context.js";
import { checkRefs } from "../text/refs.js";
import { randomHex, seededShuffle } from "../util/random.js";
import { copyInput, judgeScrubber, labelsOf, promptText, res, runConsensusSwapPass, sha256, writeInput, writeOut } from "./common.js";

const sameLabels = (a: string[], b: string[]) => a.length === b.length && a.every((x, i) => x === b[i]);

/** The judge's verdict after the swap pass: decisions may carry `attributionUnstable`. */
export type DecisionVerdict = Omit<ConsensusVerdict, "decisions"> & {
  decisions: (ConsensusVerdict["decisions"][number] & { attributionUnstable?: boolean })[];
};

/**
 * Consensus workflow (spec "Workflow 1"), all phases read-only:
 *   setup → propose.<l> ∥ → critique.<l> ∥ → revise.r<n>.<l> ∥ (≤ maxRounds, early stop when
 *   both report noChanges) → judge (anonymized A/B, seeded order) → done.
 * Each contestant works in its own worktree (neutral label) at the base commit and keeps
 * one session across its steps. The workflow is a pure function of run state (rule 1).
 */
export interface ConsensusEnv {
  dataDir: string;
}

export interface SetupResult {
  base: string;
  /** label → worktree path (contestants + judge). */
  worktrees: Record<string, string>;
  judgeLabel: string;
  contextFile: string;
  contextFiles: { path: string; sha256: string; bytes: number; truncated: boolean }[];
}

export interface TextStepResult {
  sessionId: string;
  /** The worker's current proposal (or this step's critique) file. */
  file: string;
  sha256: string;
  validRefs: number;
  invalidRefs: string[];
}

export interface ReviseStepResult extends TextStepResult {
  noChanges: boolean;
  changeSummary: string;
}

export interface JudgeResult {
  decisionJson: string;
  decisionMd: string;
  sides: Record<"A" | "B", { label: string; workerId: string }>;
  scrubReplacements: number;
  invalidEvidence: string[];
  /** No decision survived the swapped-order pass: the verdict has no decisions. */
  noRobustPreferences?: boolean;
}

export function consensusWorkflow(env: ConsensusEnv): WorkflowDef {
  return {
    name: "consensus",
    next(st) {
      const cfg = st.config as { consensus: { maxRounds: number; minRefs: number } };
      const labels = Object.keys(st.labels).sort();
      const other = (l: string) => labels.find((x) => x !== l)!;
      const setup = res<SetupResult>(st, "setup");
      if (!setup) return { kind: "stage", steps: [setupStep(env, st)] };

      const stage = (ids: string[], mk: (l: string) => WorkStep): StepDef[] | null =>
        ids.some((id) => !res(st, id)) ? labels.map(mk) : null;

      const s1 = stage(labels.map((l) => `propose.${l}`), (l) => proposeStep(env, st, setup, l));
      if (s1) return { kind: "stage", steps: s1 };
      const s2 = stage(labels.map((l) => `critique.${l}`), (l) => critiqueStep(env, st, setup, l, other(l)));
      if (s2) return { kind: "stage", steps: s2 };

      for (let n = 1; n <= cfg.consensus.maxRounds; n++) {
        if (n > 1 && labels.every((l) => res<ReviseStepResult>(st, `revise.r${n - 1}.${l}`)?.noChanges)) break;
        const sn = stage(labels.map((l) => `revise.r${n}.${l}`), (l) => reviseStep(env, st, setup, l, other(l), n));
        if (sn) return { kind: "stage", steps: sn };
      }

      const judge = res<JudgeResult>(st, "judge");
      if (!judge) return { kind: "stage", steps: [judgeStep(env, st, setup)] };
      return { kind: "done", result: { decisionMd: judge.decisionMd, decisionJson: judge.decisionJson, sides: judge.sides } };
    },
  };
}

/** Latest proposal of a label: last completed revision that changed something, else the original. */
/** A label's revision rounds so far, in order. */
export function revisionHistory(st: RunState, label: string): { round: number; noChanges: boolean; changeSummary: string }[] {
  const out: { round: number; noChanges: boolean; changeSummary: string }[] = [];
  for (let n = 1; ; n++) {
    const r = res<ReviseStepResult>(st, `revise.r${n}.${label}`);
    if (!r) return out;
    out.push({ round: n, noChanges: r.noChanges, changeSummary: r.changeSummary });
  }
}

/** Which draft a label's current proposal is: the original, or the revision of round n. */
export function draftName(history: { round: number; noChanges: boolean }[]): string {
  const last = [...history].reverse().find((h) => !h.noChanges);
  return last ? `revised in round ${last.round} of ${history.length}` : history.length ? `the original, unchanged through ${history.length} revision round(s)` : "the original (no revision rounds ran)";
}

export function renderRevisions(side: "A" | "B", history: { round: number; noChanges: boolean; changeSummary: string }[]): string {
  const out = [`# Revisions of proposal ${side}`, ""];
  if (history.length === 0) out.push("No revision rounds ran: the proposal is the original draft.");
  for (const h of history) {
    const summary = h.changeSummary.trim() || "(no summary given)";
    out.push(`## Round ${h.round}: ${h.noChanges ? "no changes" : "revised"}`, "", summary, "");
  }
  return out.join("\n").trimEnd() + "\n";
}

interface JudgeFiles {
  task: string;
  A: string;
  B: string;
  revA: string;
  revB: string;
  critA: string;
  critB: string;
  draftA: string;
  draftB: string;
}

/** The judge's (and swap pass's) file list; each critique is labelled with the draft it targets. */
function judgeFileList(f: JudgeFiles): string {
  return [
    `- task: ${f.task}`,
    `- proposal A (final version: ${f.draftA}): ${f.A}`,
    `- proposal B (final version: ${f.draftB}): ${f.B}`,
    `- A's revision summaries (what A changed after the critiques): ${f.revA}`,
    `- B's revision summaries (what B changed after the critiques): ${f.revB}`,
    `- A's critique of B, targeting B's ORIGINAL proposal (before any revision): ${f.critA}`,
    `- B's critique of A, targeting A's ORIGINAL proposal (before any revision): ${f.critB}`,
  ].join("\n");
}

export function currentProposal(st: RunState, label: string): TextStepResult {
  let cur = res<TextStepResult>(st, `propose.${label}`)!;
  for (let n = 1; ; n++) {
    const r = res<ReviseStepResult>(st, `revise.r${n}.${label}`);
    if (!r) return cur;
    if (!r.noChanges) cur = r;
  }
}

/** Session to resume for a label: from its latest completed step. */
function sessionOf(st: RunState, label: string): string {
  let s = res<TextStepResult>(st, `critique.${label}`)?.sessionId ?? res<TextStepResult>(st, `propose.${label}`)!.sessionId;
  for (let n = 1; ; n++) {
    const r = res<ReviseStepResult>(st, `revise.r${n}.${label}`);
    if (!r) return s;
    s = r.sessionId;
  }
}

function setupStep(env: ConsensusEnv, st: RunState): WorkStep {
  return {
    id: "setup",
    async run(ctx) {
      const base = await revParse(st.repo);
      const worktrees: Record<string, string> = {};
      const used = new Set(Object.keys(st.labels));
      let judgeLabel = randomHex(2);
      while (used.has(judgeLabel)) judgeLabel = randomHex(2);
      for (const label of [...Object.keys(st.labels).sort(), judgeLabel]) {
        const wt = await ensureWorktree({ repo: st.repo, dataDir: env.dataDir, runId: st.runId, label, base });
        worktrees[label] = wt.path;
      }
      const pc = await loadProjectContext(st.repo, base, ctx.config.contextFiles);
      const contextFile = writeOut(ctx, "context.md", pc.text);
      return { base, worktrees, judgeLabel, contextFile, contextFiles: pc.files } satisfies SetupResult;
    },
    async exitCheck(_ctx, r) {
      const s = r as SetupResult;
      for (const p of Object.values(s.worktrees)) {
        if (!fs.existsSync(p) || (await revParse(p)) !== s.base) return { ok: false, reason: `worktree ${p} is not at base ${s.base}` };
      }
      return { ok: true };
    },
  };
}

/** Every consensus step is read-only: any worktree change is restored to base and fails the step. */
function guardFor(env: ConsensusEnv, st: RunState, setup: SetupResult, ctx: StepContext): GateSpec {
  return {
    targets: { mainRepo: st.repo, worktrees: setup.worktrees },
    guard: { dataDir: env.dataDir, mainRepo: st.repo },
    restoreTo: Object.fromEntries(Object.keys(setup.worktrees).map((l) => [l, setup.base])),
    preserveOnClean: ctx.config.preserveOnClean,
    inputsDir: path.join(ctx.stepDir, "inputs"),
  };
}

const refsRule = (min: number) =>
  `Ground every claim in the code: cite at least ${min} references as \`path/to/file.ext:LINE\` (repo-relative paths, real line numbers of the files as they are now).`;

/** One worker turn producing markdown, with one resume-repair if too few refs validate. */
async function textTurn(
  ctx: StepContext,
  o: { workerId: string; cwd: string; sessionId?: string; prompt: string; minRefs: number; outName: string; roots: string[] },
): Promise<TextStepResult> {
  const task = { cwd: o.cwd, mode: "read-only" as const, stepDir: ctx.stepDir, inputsDir: path.join(ctx.stepDir, "inputs") };
  let done = await ctx.runWorker(o.workerId, { ...task, prompt: o.prompt, ...(o.sessionId ? { sessionId: o.sessionId } : {}) });
  let refs = checkRefs(done.finalText, o.cwd, o.roots);
  if (done.finalText.trim() && refs.valid.length < o.minRefs) {
    const bad = refs.invalid.slice(0, 20).map((r) => r.raw);
    done = await ctx.runWorker(o.workerId, {
      ...task,
      sessionId: done.sessionId,
      prompt: `The orchestrator could validate only ${refs.valid.length} of the at least ${o.minRefs} required path:line references (file must exist, line must be within the file).${bad.length ? ` Invalid: ${bad.join(", ")}.` : ""} Reply with the complete corrected text, citing at least ${o.minRefs} valid references.`,
    });
    refs = checkRefs(done.finalText, o.cwd, o.roots);
  }
  const file = writeOut(ctx, o.outName, done.finalText);
  return { sessionId: done.sessionId, file, sha256: sha256(done.finalText), validRefs: refs.valid.length, invalidRefs: refs.invalid.map((r) => r.raw) };
}

function textExit(min: number) {
  return (_ctx: StepContext, r: unknown) => {
    const t = r as TextStepResult;
    const text = fs.readFileSync(t.file, "utf8");
    if (!text.trim()) return { ok: false, reason: "empty output" };
    if (t.validRefs < min) return { ok: false, reason: `only ${t.validRefs} valid path:line references (need ${min})` };
    return { ok: true };
  };
}

function proposeStep(env: ConsensusEnv, st: RunState, setup: SetupResult, label: string): WorkStep {
  const workerId = st.labels[label]!;
  const min = (st.config as { consensus: { minRefs: number } }).consensus.minRefs;
  return {
    id: `propose.${label}`,
    workerId,
    label,
    async run(ctx) {
      const prompt = [
        "You are one of two engineers independently writing a proposal for the task below. The repository in your current working directory is the code base; it is read-only for you: do not modify any file.",
        fs.readFileSync(setup.contextFile, "utf8"),
        `## Task\n\n${promptText(ctx.run.dir)}`,
        `## Requirements\n\n- Markdown. Cover: approach, concrete changes per file, risks, open questions.\n- ${refsRule(min)}\n- Reply with the proposal only.`,
      ]
        .filter(Boolean)
        .join("\n\n");
      return withGates(ctx, guardFor(env, st, setup, ctx), () =>
        textTurn(ctx, { workerId, cwd: setup.worktrees[label]!, prompt, minRefs: min, outName: "proposal.md", roots: [st.repo] }),
      );
    },
    exitCheck: textExit(min),
  };
}

function critiqueStep(env: ConsensusEnv, st: RunState, setup: SetupResult, label: string, otherLabel: string): WorkStep {
  const workerId = st.labels[label]!;
  return {
    id: `critique.${label}`,
    workerId,
    label,
    async run(ctx) {
      const theirs = copyInput(ctx, "other-proposal.md", currentProposal(st, otherLabel).file);
      const prompt = [
        `Another engineer independently wrote a proposal for the same task. Read it with your read tool: ${theirs}`,
        "Critique it against the actual code in your working directory:",
        "- what is wrong, missing or risky (with path:line evidence)",
        "- what it does better than your own proposal",
        "Be specific and concise. Reply with the critique in markdown only.",
      ].join("\n");
      return withGates(ctx, guardFor(env, st, setup, ctx), () =>
        textTurn(ctx, { workerId, cwd: setup.worktrees[label]!, sessionId: sessionOf(st, label), prompt, minRefs: 0, outName: "critique.md", roots: [st.repo] }),
      );
    },
    exitCheck: textExit(0),
  };
}

function reviseStep(env: ConsensusEnv, st: RunState, setup: SetupResult, label: string, otherLabel: string, round: number): WorkStep {
  const workerId = st.labels[label]!;
  const cfg = st.config as { consensus: { minRefs: number; maxRounds: number } };
  const min = cfg.consensus.minRefs;
  return {
    id: `revise.r${round}.${label}`,
    workerId,
    label,
    async run(ctx) {
      const mine = currentProposal(st, label);
      const crit = copyInput(ctx, "critique-of-yours.md", res<TextStepResult>(st, `critique.${otherLabel}`)!.file);
      const theirs = copyInput(ctx, "other-proposal.md", currentProposal(st, otherLabel).file);
      const yours = copyInput(ctx, "your-proposal.md", mine.file);
      const cwd = setup.worktrees[label]!;
      const base = [
        `Revision round ${round} of at most ${cfg.consensus.maxRounds}. Read these files with your read tool:`,
        `- the other engineer's critique of your proposal: ${crit}`,
        `- their current proposal: ${theirs}`,
        `- your current proposal: ${yours}`,
        "",
        "Revise your proposal where the critique or their proposal is right; keep what you can defend with evidence from the code.",
        "If you keep your proposal exactly as it is, set noChanges=true and leave proposal empty.",
        `Otherwise set noChanges=false and put the complete revised proposal (not a diff) in proposal. ${refsRule(min)}`,
      ].join("\n");
      return withGates(ctx, guardFor(env, st, setup, ctx), async () => {
        const task = { cwd, mode: "read-only" as const, stepDir: ctx.stepDir, inputsDir: path.join(ctx.stepDir, "inputs") };
        let r = await runStructured(ctx, { workerId, schema: ReviseResult, name: "revise", task: { ...task, prompt: base, sessionId: sessionOf(st, label) } });
        let refs = checkRefs(r.value.proposal, cwd, [st.repo]);
        if (!r.value.noChanges && refs.valid.length < min) {
          r = await runStructured(ctx, {
            workerId,
            schema: ReviseResult,
            name: "revise",
            task: {
              ...task,
              sessionId: r.done.sessionId,
              prompt: `Only ${refs.valid.length} of the at least ${min} required path:line references in your revised proposal validate. Return the complete answer again with at least ${min} valid references.`,
            },
          });
          refs = checkRefs(r.value.proposal, cwd, [st.repo]);
        }
        if (r.value.noChanges) {
          return { ...mine, sessionId: r.done.sessionId, noChanges: true, changeSummary: r.value.changeSummary } satisfies ReviseStepResult;
        }
        const file = writeOut(ctx, "proposal.md", r.value.proposal);
        return {
          sessionId: r.done.sessionId,
          file,
          sha256: sha256(r.value.proposal),
          validRefs: refs.valid.length,
          invalidRefs: refs.invalid.map((x) => x.raw),
          noChanges: false,
          changeSummary: r.value.changeSummary,
        } satisfies ReviseStepResult;
      });
    },
    exitCheck: (ctx, r) => {
      const v = r as ReviseStepResult;
      return v.noChanges ? { ok: true } : textExit(min)(ctx, r);
    },
  };
}

function judgeStep(env: ConsensusEnv, st: RunState, setup: SetupResult): WorkStep {
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

      const scrubber = judgeScrubber(ctx, st);
      const roots = [...Object.values(setup.worktrees), st.repo];
      let replacements = 0;
      const clean = (text: string) => {
        const s = scrubProse(relativizePaths(text, roots), scrubber);
        replacements += s.replacements;
        return s.text;
      };
      // The user's own task text is passed verbatim: exempt from scrub and leak check.
      const taskFile = copyInput(ctx, "task.md", path.join(ctx.run.dir, "prompt.md"));
      const sideFiles = (prefix: string, a: string, b: string): JudgeFiles => ({
        task: taskFile,
        A: copyInput(ctx, `${prefix}proposal-A.md`, currentProposal(st, a).file, clean),
        B: copyInput(ctx, `${prefix}proposal-B.md`, currentProposal(st, b).file, clean),
        revA: writeInput(ctx, `${prefix}revisions-A.md`, clean(renderRevisions("A", revisionHistory(st, a)))),
        revB: writeInput(ctx, `${prefix}revisions-B.md`, clean(renderRevisions("B", revisionHistory(st, b)))),
        critA: copyInput(ctx, `${prefix}critique-by-A.md`, res<TextStepResult>(st, `critique.${a}`)!.file, clean),
        critB: copyInput(ctx, `${prefix}critique-by-B.md`, res<TextStepResult>(st, `critique.${b}`)!.file, clean),
        draftA: draftName(revisionHistory(st, a)),
        draftB: draftName(revisionHistory(st, b)),
      });
      const files = sideFiles("", la, lb);
      // Swap pass inputs must exist before the step's inputs/ baseline is taken (§8.19).
      const swapped = cfg.judge.swapOrderPass ? sideFiles("swap/", lb, la) : undefined;
      const forbidden = [env.dataDir, ...roots];
      const scanned = (f: JudgeFiles) => [f.A, f.B, f.revA, f.revB, f.critA, f.critB];
      for (const f of [...scanned(files), ...(swapped ? scanned(swapped) : [])]) {
        const hits = leakCheck(fs.readFileSync(f, "utf8"), scrubber, forbidden);
        if (hits.length > 0) throw new StepFailure("integrity", `anonymization leak check failed for ${path.basename(f)}: ${hits.length} pattern(s) still match`);
      }

      const cwd = setup.worktrees[setup.judgeLabel]!;
      const prompt = [
        "You are the judge. Two anonymous engineers, A and B, independently wrote proposals for the task below and critiqued each other's proposal. Read these files with your read tool:",
        judgeFileList(files),
        "",
        "Each critique was written against the other side's ORIGINAL proposal, before any revision; the revision summaries say what each side changed afterwards, so a criticised point may already be addressed in the final proposal.",
        "",
        "The repository in your working directory is the code they refer to (read-only). Verify claims against the code before relying on them; the order of A and B is random and carries no meaning.",
        "Produce: a summary of the recommended plan; decisions (each with its rationale, which side it is based on, and path:line evidence you verified); and an explicit list of unresolved disagreements the evidence does not settle.",
      ].join("\n");
      const task = { cwd, mode: "read-only" as const, stepDir: ctx.stepDir, inputsDir: path.join(ctx.stepDir, "inputs"), timeoutMs: cfg.timeouts.judgeMs };

      return withGates(ctx, guardFor(env, st, setup, ctx), async () => {
        let r = await runStructured(ctx, { workerId: judgeId, schema: ConsensusVerdict, name: "decision", task: { ...task, prompt } });
        let bad = invalidEvidence(r.value, cwd, roots);
        if (bad.undecided.length > 0) {
          r = await runStructured(ctx, {
            workerId: judgeId,
            schema: ConsensusVerdict,
            name: "decision",
            task: {
              ...task,
              sessionId: r.done.sessionId,
              prompt: `These decisions have no evidence reference that exists in the repository (file must exist, line within the file): ${bad.undecided.join("; ")}. Invalid references: ${bad.invalid.slice(0, 20).join(", ")}. Return the complete verdict again with verified path:line evidence for every decision.`,
            },
          });
          bad = invalidEvidence(r.value, cwd, roots);
        }
        if (bad.undecided.length > 0) throw new StepFailure("exit_check", `judge decisions without valid evidence: ${bad.undecided.join("; ")}`);
        let verdict: DecisionVerdict = r.value;
        let dropped: ConsensusVerdict["decisions"] = [];
        if (swapped) {
          // Second pass with A/B swapped (fresh session). It checks the decision, not who gets the
          // credit: a decision survives if that pass adopts it too (any attribution). An adopted
          // decision whose attribution maps to different contestants is kept, marked attributionUnstable.
          const second = await runConsensusSwapPass(ctx, {
            judgeId,
            cwd,
            timeoutMs: cfg.timeouts.judgeMs,
            fileList: judgeFileList(swapped),
            decisions: verdict.decisions.map((d, i) => ({ index: i + 1, text: `${d.topic}: ${d.decision}` })),
          });
          const keep: DecisionVerdict["decisions"] = [];
          verdict.decisions.forEach((d, i) => {
            const s = second.get(i + 1);
            if (!s?.adopt) return dropped.push(d);
            const stable = sameLabels(labelsOf(d.basedOn, la, lb), labelsOf(s.side, lb, la));
            keep.push(stable ? d : { ...d, attributionUnstable: true });
          });
          const unstable = keep.filter((d) => d.attributionUnstable).length;
          if (unstable > 0) {
            ctx.record({
              type: "warning",
              code: "attribution_unstable",
              stepId: ctx.stepId,
              message: `${unstable} decision(s) were adopted in both passes but credited to different sides; kept and marked attribution-unstable`,
            });
          }
          if (keep.length === 0) {
            // Not a failure: no decision is order-robust. Continue with an empty verdict.
            ctx.record({ type: "warning", code: "no_robust_preferences", stepId: ctx.stepId, message: "the swapped-order judge pass adopted none of the first pass's decisions; the verdict has no decisions" });
          }
          verdict = { ...verdict, decisions: keep };
        }
        const noRobustPreferences = !!swapped && verdict.decisions.length === 0;
        const decisionJson = writeOut(ctx, "decision.json", JSON.stringify({ verdict, sides, invalidEvidence: bad.invalid, droppedBySwapPass: dropped, noRobustPreferences }, null, 2) + "\n");
        const decisionMd = writeOut(ctx, "decision.md", renderDecision(verdict, sides, bad.invalid, dropped));
        return { decisionJson, decisionMd, sides, scrubReplacements: replacements, invalidEvidence: bad.invalid, noRobustPreferences } satisfies JudgeResult;
      });
    },
    exitCheck: (_ctx, r) => {
      const j = r as JudgeResult;
      const saved = JSON.parse(fs.readFileSync(j.decisionJson, "utf8")) as { verdict: unknown; noRobustPreferences?: boolean };
      // An empty verdict is valid only as the recorded outcome of the swapped-order pass.
      // Saved decisions are the judge's plus the orchestrator's optional attributionUnstable mark.
      const decision = ConsensusVerdict.shape.decisions.element.extend({ attributionUnstable: z.boolean().optional() });
      const schema = ConsensusVerdict.extend({ decisions: saved.noRobustPreferences ? z.array(decision).length(0) : z.array(decision).min(1) });
      const ok = fs.existsSync(j.decisionMd) && schema.safeParse(saved.verdict).success;
      return ok ? { ok: true } : { ok: false, reason: "decision.md/decision.json missing or invalid" };
    },
  };
}

function invalidEvidence(v: ConsensusVerdict, root: string, roots: string[]) {
  const invalid: string[] = [];
  const undecided: string[] = [];
  for (const d of v.decisions) {
    const checked = checkRefs(d.evidence.join("\n"), root, roots);
    invalid.push(...checked.invalid.map((r) => r.raw));
    if (checked.valid.length === 0) undecided.push(d.topic);
  }
  return { invalid, undecided };
}

export function renderDecision(v: DecisionVerdict, sides: JudgeResult["sides"], invalid: string[], dropped: ConsensusVerdict["decisions"] = []): string {
  const side = (s: string) => (s === "A" || s === "B" ? `${s} (${sides[s].workerId})` : s);
  const out = [
    "# Decision",
    "",
    v.summary,
    "",
    `Sides: A = ${sides.A.workerId} (${sides.A.label}), B = ${sides.B.workerId} (${sides.B.label}). The judge saw only A/B.`,
    "",
    "## Decisions",
    "",
  ];
  if (v.decisions.length === 0) {
    out.push("No robust preferences: with A and B swapped, the judge adopted none of its first-pass decisions.", "");
  }
  v.decisions.forEach((d, i) => {
    out.push(`### ${i + 1}. ${d.topic}`, "", d.decision, "", `*Rationale:* ${d.rationale}`, "", `*Based on:* ${side(d.basedOn)}${d.attributionUnstable ? " (attribution unstable: with A and B swapped, the judge adopted this decision but credited it differently)" : ""}`, "", `*Evidence:* ${d.evidence.map((e) => `\`${e}\``).join(", ")}`, "");
  });
  out.push("## Unresolved disagreements", "");
  if (v.unresolved.length === 0) out.push("None.", "");
  for (const u of v.unresolved) out.push(`- **${u.topic}**: A: ${u.positionA} / B: ${u.positionB}. ${u.whyUnresolved}`);
  if (dropped.length) {
    out.push("", "## Dropped by the swapped-order pass", "", "With A and B swapped, the judge did not adopt these, so they are not decisions:", "");
    for (const d of dropped) out.push(`- **${d.topic}**: ${d.decision}`);
  }
  if (invalid.length) out.push("", `> ${invalid.length} cited reference(s) could not be validated: ${invalid.slice(0, 30).map((e) => `\`${e}\``).join(", ")}`);
  return out.join("\n") + "\n";
}
