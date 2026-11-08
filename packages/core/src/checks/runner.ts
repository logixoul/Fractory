import * as fs from "node:fs";
import * as path from "node:path";
import type { z } from "zod";
import { StepFailure } from "../engine/errors.js";
import { guardedRestore, type GuardContext } from "../git/guard.js";
import { diffSnapshots, takeSnapshot, type SnapshotOptions } from "../git/snapshot.js";
import type { CheckCommand, SetupCommand } from "../schemas/config.js";
import { withEnv, withoutEnv } from "../util/env.js";
import { isInside } from "../util/pathx.js";
import { runProcess, tail } from "../util/proc.js";
import { SECRET_ENV_NAME_RE } from "../util/redact.js";

type Setup = z.infer<typeof SetupCommand>;
type Check = z.infer<typeof CheckCommand>;

const LOG_TAIL_CHARS = 8000;

/** Env for setup/check commands: no secrets (worker API keys never reach repo scripts). */
export function commandEnv(extra: Record<string, string> = {}, base: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const stripped = withoutEnv(base, Object.keys(base).filter((k) => SECRET_ENV_NAME_RE.test(k)));
  return withEnv(stripped, extra);
}

const safeName = (s: string) => s.replace(/[^A-Za-z0-9._-]+/g, "_");

export interface CommandResult {
  name: string;
  argv: string[];
  code: number | null;
  reason: string;
  durationMs: number;
  passed: boolean;
  logFile: string;
  logTail: string;
}

async function runOne(name: string, argv: string[], cwd: string, timeoutMs: number, env: Record<string, string> | undefined, logFile: string, signal?: AbortSignal): Promise<CommandResult> {
  fs.mkdirSync(path.dirname(logFile), { recursive: true });
  fs.writeFileSync(logFile, `$ ${JSON.stringify(argv)}\n`);
  const r = await runProcess({
    command: argv[0]!,
    args: argv.slice(1),
    cwd,
    env: commandEnv(env),
    timeoutMs,
    logFile,
    maxBufferBytes: 1024 * 1024,
    ...(signal ? { signal } : {}),
  });
  const log = fs.readFileSync(logFile, "utf8");
  return {
    name,
    argv,
    code: r.code,
    reason: r.reason === "spawn_error" ? `spawn_error: ${r.error}` : r.reason,
    durationMs: r.durationMs,
    passed: r.reason === "exit" && r.code === 0,
    logFile,
    logTail: tail(log, LOG_TAIL_CHARS),
  };
}

/**
 * Per-repo setup (§8.15), e.g. `npm ci`, run in a worktree after creation and after every
 * guarded clean. A failure is an environment error: never fed to a worker.
 */
export async function runSetup(worktree: string, setup: readonly Setup[], logDir: string, signal?: AbortSignal): Promise<CommandResult[]> {
  const results: CommandResult[] = [];
  for (const [i, s] of setup.entries()) {
    const r = await runOne(`setup-${i + 1}`, s.argv, worktree, s.timeoutMs, s.env, path.join(logDir, `setup-${i + 1}.log`), signal);
    results.push(r);
    if (signal?.aborted) throw new StepFailure("cancelled", "setup cancelled");
    if (!r.passed) throw new StepFailure("env_error", `setup ${JSON.stringify(s.argv)} failed (${r.reason}, code ${r.code}):\n${r.logTail}`);
  }
  return results;
}

export interface ChecksOutcome {
  results: CommandResult[];
  allPassed: boolean;
  /** Files copied into artifacts/ (relative to it). */
  artifacts: string[];
  /** Paths `git clean` removed after the checks. */
  cleaned: string[];
  setupRerun: boolean;
}

export interface ChecksOptions {
  worktree: string;
  /** Commit the worktree is restored to after the checks (the post-step commit, §8.18). */
  postStepSha: string;
  checks: readonly Check[];
  setup: readonly Setup[];
  preserveOnClean: readonly string[];
  guard: GuardContext;
  snapshot: SnapshotOptions;
  /** steps/<id>/ — logs go to logs/, artifacts to artifacts/<check>/ */
  stepDir: string;
  signal?: AbortSignal;
}

/**
 * Runs the configured checks in a worktree, keeps their outputs only as step artifacts, then
 * restores the worktree to the post-step commit (guarded reset + clean, setup if anything was
 * removed) and verifies the tree equals its pre-check snapshot (§8.18). Check failures are
 * results (fed back to the worker); setup failures and integrity mismatches throw.
 */
export async function runChecksIsolated(o: ChecksOptions): Promise<ChecksOutcome> {
  const before = await takeSnapshot(o.worktree, o.snapshot);
  const results: CommandResult[] = [];
  const artifacts: string[] = [];
  const artifactsDir = path.join(o.stepDir, "artifacts");
  const logs = path.join(o.stepDir, "logs");
  let cleaned: string[] = [];
  try {
    for (const c of o.checks) {
      const r = await runOne(c.name, c.argv, o.worktree, c.timeoutMs, c.env, path.join(logs, `check-${safeName(c.name)}.log`), o.signal);
      results.push(r);
      if (o.signal?.aborted) throw new StepFailure("cancelled", "checks cancelled");
      artifacts.push(...copyArtifacts(o.worktree, c.artifacts, path.join(artifactsDir, safeName(c.name))));
    }
  } finally {
    // Always restore, also on cancel: checks must never leave anything on the branch.
    cleaned = await guardedRestore(o.worktree, o.postStepSha, o.guard, o.preserveOnClean);
  }
  let setupRerun = false;
  if (cleaned.length > 0 && o.setup.length > 0) {
    await runSetup(o.worktree, o.setup, logs, o.signal);
    setupRerun = true;
  }
  const after = await takeSnapshot(o.worktree, o.snapshot);
  const drift = diffSnapshots(before, after);
  if (drift.length > 0) {
    throw new StepFailure(
      "integrity",
      `worktree differs from its post-step snapshot after checks + restore: ${drift
        .slice(0, 20)
        .map((d) => d.path)
        .join(", ")}`,
    );
  }
  return { results, allPassed: results.every((r) => r.passed), artifacts, cleaned, setupRerun };
}

/** Copies files matching the globs (relative to the worktree) into dest, keeping relative paths. */
export function copyArtifacts(worktree: string, globs: readonly string[], dest: string): string[] {
  const copied: string[] = [];
  for (const g of globs) {
    for (const rel of fs.globSync(g, { cwd: worktree })) {
      const src = path.join(worktree, rel);
      if (!isInside(path.resolve(src), path.resolve(worktree))) continue;
      let st: fs.Stats;
      try {
        st = fs.lstatSync(src);
      } catch {
        continue;
      }
      if (!st.isFile()) continue;
      const to = path.join(dest, rel);
      fs.mkdirSync(path.dirname(to), { recursive: true });
      fs.copyFileSync(src, to);
      copied.push(path.relative(path.dirname(dest), to).split(path.sep).join("/"));
    }
  }
  return copied;
}
