import { escapingLinksByLabel, evaluateGates, takeBaseline, type GateTargets, type GateVerdict } from "../git/gates.js";
import { guardedRestore, type GuardContext } from "../git/guard.js";
import { StepFailure } from "./errors.js";
import type { StepContext } from "./types.js";

/**
 * Wraps the worker part of a step in the snapshot gates (§8.2, §8.4, §8.14, §8.19):
 *  - refuses to start if a worktree holds a link escaping it
 *  - main-repo changes → needs_attention (the step result stands)
 *  - forbidden worktree changes → guarded restore of that worktree to `restoreTo[label]`, hard failure
 *  - inputs/ changes → hard failure
 * Also applied when the body throws, so a failed attempt never leaves a dirty worktree behind.
 */
export interface GateSpec {
  targets: GateTargets;
  guard: GuardContext;
  /** label → commit each worktree is restored to on a violation (checkpoint or base). */
  restoreTo: Record<string, string>;
  preserveOnClean: readonly string[];
  /** Worktree this step may change (edit steps). */
  writableLabel?: string;
  /** Worktrees a parallel sibling step may change; ignored by this step's gate. */
  siblingWritable?: readonly string[];
  inputsDir?: string;
}

export async function withGates<T>(ctx: StepContext, g: GateSpec, body: () => Promise<T>): Promise<T> {
  const snap = ctx.config.snapshot;
  const sibling = new Set(g.siblingWritable ?? []);
  const targets: GateTargets = {
    mainRepo: g.targets.mainRepo,
    worktrees: Object.fromEntries(Object.entries(g.targets.worktrees).filter(([l]) => !sibling.has(l))),
  };
  const before = await takeBaseline(targets, snap, g.inputsDir);
  const links = escapingLinksByLabel(before);
  if (Object.keys(links).length > 0) {
    throw new StepFailure("integrity", `worktree links escape their worktree; refusing to start: ${JSON.stringify(links)}`);
  }

  let result: T;
  try {
    result = await body();
  } catch (e) {
    const v = await evaluateGates(before, targets, snap, g.writableLabel !== undefined ? { writableLabel: g.writableLabel } : {}, g.inputsDir).catch(() => undefined);
    if (v) await restoreViolations(v, g);
    throw e;
  }
  const v = await evaluateGates(before, targets, snap, g.writableLabel !== undefined ? { writableLabel: g.writableLabel } : {}, g.inputsDir);
  if (v.inputsChanged.length > 0) {
    throw new StepFailure("integrity", `step inputs/ changed during the step: ${v.inputsChanged.map((c) => c.path).join(", ")}`);
  }
  const violated = await restoreViolations(v, g);
  if (violated.length > 0) {
    throw new StepFailure(
      "integrity",
      `unexpected worktree changes (restored): ${violated
        .map(([label, ch]) => `${label}: ${ch.slice(0, 10).map((c) => c.path).join(", ")}`)
        .join("; ")}`,
    );
  }
  if (v.attention.length > 0) ctx.flagAttention(v.attention);
  return result;
}

async function restoreViolations(v: GateVerdict, g: GateSpec) {
  const violated = Object.entries(v.violations);
  for (const [label] of violated) {
    const sha = g.restoreTo[label];
    const wt = g.targets.worktrees[label];
    if (sha && wt) await guardedRestore(wt, sha, g.guard, g.preserveOnClean);
  }
  return violated;
}
