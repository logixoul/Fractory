import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import type { FileChange } from "../schemas/run-events.js";
import { normCase, toPosix } from "../util/pathx.js";
import { diffSnapshots, escapingLinks, takeSnapshot, type Snapshot, type SnapshotCache, type SnapshotOptions } from "./snapshot.js";

/**
 * Per-step gates (§8.2, §8.4, §8.14, §8.19). Before a step: snapshot the main repo and every
 * worktree of the run, and hash the step's inputs/. After it: compare.
 *   - main repo changed            → needs_attention (the step's result stands)
 *   - any worktree changed, except the step's own worktree in an edit step → hard failure
 *   - inputs/ changed              → hard failure
 */
export interface GateTargets {
  mainRepo: string;
  /** label → worktree path, for every worktree of the run. */
  worktrees: Record<string, string>;
}

export interface GatePolicy {
  /** Label of the worktree this step may change (edit steps only). */
  writableLabel?: string;
}

export interface GateBaseline {
  main: Snapshot;
  worktrees: Record<string, Snapshot>;
  inputs?: InputsHash;
}

export interface GateVerdict {
  /** Main-repo changes (→ needs_attention). */
  attention: FileChange[];
  /** Forbidden worktree changes per label (→ hard failure + guarded restore). */
  violations: Record<string, FileChange[]>;
  /** Changes in the writable worktree (allowed; informational). */
  allowed: FileChange[];
  inputsChanged: FileChange[];
}

export async function takeBaseline(t: GateTargets, o: SnapshotOptions, inputsDir?: string, cache?: SnapshotCache): Promise<GateBaseline> {
  const worktrees: Record<string, Snapshot> = {};
  const [main, ...wts] = await Promise.all([
    takeSnapshot(t.mainRepo, o),
    ...Object.values(t.worktrees).map((p) => takeSnapshot(p, o, cache)),
  ]);
  Object.keys(t.worktrees).forEach((label, i) => (worktrees[label] = wts[i]!));
  return { main: main!, worktrees, ...(inputsDir ? { inputs: hashInputs(inputsDir) } : {}) };
}

/** Labels whose worktree contains a symlink/junction escaping it (the step must not start). */
export function escapingLinksByLabel(b: GateBaseline): Record<string, string[]> {
  const out: Record<string, string[]> = {};
  for (const [label, s] of Object.entries(b.worktrees)) {
    const bad = escapingLinks(s);
    if (bad.length > 0) out[label] = bad.map((l) => `${l.path} -> ${l.target}`);
  }
  return out;
}

export async function evaluateGates(
  before: GateBaseline,
  t: GateTargets,
  o: SnapshotOptions,
  policy: GatePolicy,
  inputsDir?: string,
  cache?: SnapshotCache,
): Promise<GateVerdict> {
  const after = await takeBaseline(t, o, inputsDir, cache);
  const verdict: GateVerdict = { attention: diffSnapshots(before.main, after.main), violations: {}, allowed: [], inputsChanged: [] };
  for (const label of Object.keys(t.worktrees)) {
    const changes = diffSnapshots(before.worktrees[label]!, after.worktrees[label]!);
    if (changes.length === 0) continue;
    if (label === policy.writableLabel) verdict.allowed.push(...changes);
    else verdict.violations[label] = changes;
  }
  if (before.inputs && after.inputs) verdict.inputsChanged = diffInputs(before.inputs, after.inputs);
  return verdict;
}

export function gatesPassed(v: GateVerdict): boolean {
  return Object.keys(v.violations).length === 0 && v.inputsChanged.length === 0;
}

/** Sorted relative path → sha256 of every file under a directory (§8.19). */
export type InputsHash = Record<string, string>;

export function hashInputs(dir: string): InputsHash {
  const out: InputsHash = {};
  const walk = (abs: string) => {
    for (const d of fs.readdirSync(abs, { withFileTypes: true })) {
      const p = path.join(abs, d.name);
      const rel = toPosix(path.relative(dir, p));
      if (d.isDirectory()) walk(p);
      else if (d.isSymbolicLink()) out[rel] = `link:${fs.readlinkSync(p)}`;
      else out[rel] = createHash("sha256").update(fs.readFileSync(p)).digest("hex");
    }
  };
  if (fs.existsSync(dir)) walk(dir);
  return Object.fromEntries(Object.entries(out).sort(([a], [b]) => (normCase(a) < normCase(b) ? -1 : 1)));
}

export function diffInputs(a: InputsHash, b: InputsHash): FileChange[] {
  const keys = [...new Set([...Object.keys(a), ...Object.keys(b)])].sort();
  return keys.filter((k) => a[k] !== b[k]).map((k) => ({ path: k, before: a[k] ?? null, after: b[k] ?? null }));
}
