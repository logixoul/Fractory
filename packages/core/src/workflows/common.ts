import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import type { StepContext } from "../engine/types.js";
import type { RunState } from "../state/reducer.js";
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
