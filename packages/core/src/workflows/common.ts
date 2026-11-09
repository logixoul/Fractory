import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import type { StepContext } from "../engine/types.js";
import type { RunState } from "../state/reducer.js";
import { runStructured } from "../engine/structured.js";
import { ConsensusSwapCheck, SwapCheck } from "../schemas/outputs.js";
import { buildScrubber, type Scrubber } from "../text/anonymize.js";

/** Result of a completed step, or undefined. */
export const res = <T>(st: RunState, id: string): T | undefined =>
  st.steps[id]?.status === "completed" ? (st.steps[id]!.result as T) : undefined;

export const sha256 = (s: string | Buffer) => createHash("sha256").update(s).digest("hex");

export function writeOut(ctx: StepContext, name: string, text: string): string {
  const f = path.join(ctx.stepDir, "out", name);
  fs.mkdirSync(path.dirname(f), { recursive: true });
  fs.writeFileSync(f, text);
  return f;
}

export function writeInput(ctx: StepContext, name: string, text: string): string {
  const f = path.join(ctx.stepDir, "inputs", name);
  fs.mkdirSync(path.dirname(f), { recursive: true });
  fs.writeFileSync(f, text);
  return f;
}

export function copyInput(ctx: StepContext, name: string, from: string, transform?: (s: string) => string): string {
  const text = fs.readFileSync(from, "utf8");
  return writeInput(ctx, name, transform ? transform(text) : text);
}

export function promptText(runDir: string): string {
  return fs.readFileSync(path.join(runDir, "prompt.md"), "utf8");
}

/** Scrubber for judge inputs: configured patterns + worker ids + configured and observed model ids (§8.16). */
export function judgeScrubber(ctx: StepContext, st: RunState): Scrubber {
  const cfg = ctx.config;
  const modelIds = [
    ...Object.keys(cfg.workers),
    ...Object.values(cfg.workers).flatMap((w) => ("model" in w ? [w.model] : [])),
    ...Object.values(st.steps).flatMap((s) => s.resolvedModels ?? []),
  ];
  return buildScrubber(cfg.anonymize.patterns, modelIds, cfg.anonymize.replacement);
}

export type SideRating = "A" | "B" | "both" | "neither";

/** Contestant labels a rating refers to, given which label is A and which is B in that pass. */
export function labelsOf(side: SideRating, a: string, b: string): string[] {
  return side === "A" ? [a] : side === "B" ? [b] : side === "both" ? [a, b].sort() : [];
}

/**
 * The swap pass itself (fresh session, sides swapped in the input files it is given). Returns
 * index → rating. The caller keeps only points whose mapped labels agree across both passes.
 */
export async function runSwapPass(
  ctx: StepContext,
  o: { judgeId: string; cwd: string; timeoutMs: number; fileList: string; points: { index: number; text: string }[] },
): Promise<Map<number, SideRating>> {
  const prompt = [
    "You are the judge. Two anonymous engineers, A and B, worked on the same task. Read these files with your read tool:",
    o.fileList,
    "",
    "The repository in your working directory is the code they refer to (read-only). The order of A and B is random and carries no meaning.",
    "For each numbered point below, decide which side it favours: A, B, both, or neither. Letters A/B inside the point texts are from an earlier, independent labelling and carry no meaning here: judge only from the files.",
    "",
    ...o.points.map((p) => `${p.index}. ${p.text}`),
  ].join("\n");
  const r = await runStructured(ctx, {
    workerId: o.judgeId,
    schema: SwapCheck,
    name: "swap",
    task: { cwd: o.cwd, mode: "read-only", stepDir: ctx.stepDir, inputsDir: path.join(ctx.stepDir, "inputs"), timeoutMs: o.timeoutMs, prompt },
  });
  return new Map(r.value.verdicts.map((v) => [v.index, v.side]));
}

/**
 * Consensus swap pass (fresh session, sides swapped): per decision of the first pass, would the
 * judge adopt it too, and which side is it based on. Returns index → { adopt, side }.
 */
export async function runConsensusSwapPass(
  ctx: StepContext,
  o: { judgeId: string; cwd: string; timeoutMs: number; fileList: string; decisions: { index: number; text: string }[] },
): Promise<Map<number, { adopt: boolean; side: SideRating }>> {
  const prompt = [
    "You are the judge. Two anonymous engineers, A and B, independently wrote proposals for the same task and critiqued each other's proposal. Read these files with your read tool:",
    o.fileList,
    "",
    "The repository in your working directory is the code they refer to (read-only). The order of A and B is random and carries no meaning.",
    "Below are candidate decisions for the recommended plan. For each numbered decision: set adopt=true if you, judging from the files and the code, would make it part of the recommended plan, else false; and set side to the proposal it is based on (A, B, both, or neither). Letters A/B inside the decision texts are from an earlier, independent labelling and carry no meaning here.",
    "",
    ...o.decisions.map((d) => `${d.index}. ${d.text}`),
  ].join("\n");
  const r = await runStructured(ctx, {
    workerId: o.judgeId,
    schema: ConsensusSwapCheck,
    name: "swap",
    task: { cwd: o.cwd, mode: "read-only", stepDir: ctx.stepDir, inputsDir: path.join(ctx.stepDir, "inputs"), timeoutMs: o.timeoutMs, prompt },
  });
  return new Map(r.value.verdicts.map((v) => [v.index, { adopt: v.adopt, side: v.side }]));
}

/** Warning-only scan (never rewrites code): identity tokens in diffs handed to the judge. */
export function identityTokenWarning(ctx: StepContext, scrubber: Scrubber, files: Record<string, string>): void {
  const hits = Object.entries(files).filter(([, text]) => scrubber.patterns.some((re) => ((re.lastIndex = 0), re.test(text))));
  for (const re of scrubber.patterns) re.lastIndex = 0;
  if (hits.length > 0) {
    ctx.record({
      type: "warning",
      code: "identity_in_diff",
      stepId: ctx.stepId,
      message: `judge input ${hits.map(([n]) => n).join(", ")} contains worker identity tokens in code (diffs are never rewritten)`,
    });
  }
}
