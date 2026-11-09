import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import { FRACTORY_VERSION } from "../version.js";
import { drive, type DriveOptions } from "../engine/drive.js";
import type { WorkflowDef } from "../engine/types.js";
import { git, toplevel } from "../git/git.js";
import { assertWorktreeTarget, guardedWorktreeRemove } from "../git/guard.js";
import { ResumeRefusedError } from "../engine/errors.js";
import { dataPaths } from "../paths.js";
import { Config } from "../schemas/config.js";
import type { Workflow } from "../schemas/run-events.js";
import { TERMINAL_STATUSES, type RunState } from "../state/reducer.js";
import type { RunHandle, RunStore } from "../store/run-store.js";
import { newLabels, randomSeed } from "../util/random.js";
import type { Worker } from "../workers/types.js";
import { consensusWorkflow } from "../workflows/consensus.js";
import { duelWorkflow } from "../workflows/duel.js";
import { reviewWorkflow } from "../workflows/review.js";

export interface CreateRunOptions {
  workflow: Exclude<Workflow, "test">;
  repo: string;
  promptFile: string;
  config: Config;
}

/**
 * Creates a run: validates the repo, snapshots the prompt (runs/<id>/prompt.md) and the full
 * resolved config into run_created, and assigns neutral labels and the A/B seed (§8.16).
 */
export async function createRun(store: RunStore, o: CreateRunOptions): Promise<RunHandle> {
  let repo: string;
  try {
    repo = await toplevel(o.repo);
  } catch {
    throw new Error(`${o.repo} is not inside a git repository`);
  }
  const prompt = fs.readFileSync(o.promptFile);
  if (prompt.toString("utf8").trim() === "") throw new Error(`prompt file ${o.promptFile} is empty`);
  const run = store.create({
    workflow: o.workflow,
    repo,
    promptFile: path.resolve(o.promptFile),
    promptSha256: createHash("sha256").update(prompt).digest("hex"),
    labels: newLabels(o.workflow === "review" ? [o.config.roles.implementer, o.config.roles.reviewer] : o.config.roles.contestants),
    roles: o.config.roles,
    seed: randomSeed(),
    config: JSON.parse(JSON.stringify(o.config)),
    fractoryVersion: FRACTORY_VERSION,
  });
  fs.writeFileSync(path.join(run.dir, "prompt.md"), prompt);
  // Workers only ever see the base commit (HEAD). Uncommitted work is invisible to them: warn, don't block.
  const dirty = (await git(["status", "--porcelain=v1", "--untracked-files=normal"], { cwd: repo })).stdout.toString("utf8").trim();
  if (dirty !== "") {
    const n = dirty.split("\n").length;
    const release = run.acquireWriter();
    try {
      run.append({
        type: "warning",
        code: "dirty_repo",
        message: `the repository has ${n} uncommitted change(s); workers see only the HEAD commit, not your working tree`,
      });
    } finally {
      release();
    }
  }
  return run;
}

/**
 * fractory clean: removes a finished run's worktree directories through the guarded function
 * (§8.3). Branches are kept (never deleted, merged or pushed). Returns the removed paths.
 */
export async function cleanRun(run: RunHandle, dataDir: string): Promise<string[]> {
  const st = run.state();
  if (!TERMINAL_STATUSES.has(st.status)) {
    throw new ResumeRefusedError(`run ${st.runId} is ${st.status}; only finished runs can be cleaned (cancel it first)`);
  }
  const root = path.join(dataDir, "worktrees", st.runId);
  const removed: string[] = [];
  if (fs.existsSync(root)) {
    for (const label of fs.readdirSync(root)) {
      const wt = path.join(root, label);
      await guardedWorktreeRemove(wt, { dataDir, mainRepo: st.repo }).catch(async (e: unknown) => {
        // Not a registered worktree any more (e.g. pruned): remove the leftover directory, still via the guard.
        if (!fs.existsSync(wt)) return;
        assertWorktreeTarget(wt, { dataDir, mainRepo: st.repo });
        if (fs.existsSync(path.join(wt, ".git"))) throw e;
        fs.rmSync(wt, { recursive: true, force: true });
      });
      removed.push(wt);
    }
    try {
      fs.rmdirSync(root); // empty now
    } catch {
      /* something else is left in it: keep */
    }
    await git(["worktree", "prune"], { cwd: st.repo, allowFail: true });
  }
  const release = run.acquireWriter();
  try {
    run.append({ type: "worktrees_cleaned", paths: removed });
  } finally {
    release();
  }
  return removed;
}

/** fractory gc: cleans every finished, not yet cleaned run last updated more than `olderThanDays` ago. */
export async function gcRuns(store: RunStore, o: { dataDir: string; olderThanDays: number; now?: number }): Promise<{ runId: string; removed: string[] }[]> {
  const cutoff = (o.now ?? Date.now()) - o.olderThanDays * 86_400_000;
  const out: { runId: string; removed: string[] }[] = [];
  for (const r of store.list()) {
    const st = r.state;
    if (!st || !TERMINAL_STATUSES.has(st.status) || st.cleaned) continue;
    if (Date.parse(st.updatedAt) > cutoff) continue;
    out.push({ runId: r.runId, removed: await cleanRun(store.open(r.runId), o.dataDir) });
  }
  return out;
}

/** The config a run was created with (resume never re-reads config files). */
export function runConfig(st: RunState): Config {
  return Config.parse(st.config);
}

export function workflowFor(st: RunState, dataDir: string): WorkflowDef {
  switch (st.workflow) {
    case "consensus":
      return consensusWorkflow({ dataDir });
    case "duel":
      return duelWorkflow({ dataDir });
    case "review":
      return reviewWorkflow({ dataDir });
    default:
      throw new Error(`workflow '${st.workflow}' is not available yet`);
  }
}

export interface DriveRunOptions extends DriveOptions {
  dataDir: string;
  workers: Record<string, Worker>;
}

/** Drives (or resumes) a run with its own recorded config. */
export function driveRun(run: RunHandle, o: DriveRunOptions): Promise<RunState> {
  const st = run.state();
  const config = runConfig(st);
  fs.mkdirSync(dataPaths(o.dataDir).worktrees, { recursive: true });
  return drive(run, workflowFor(st, o.dataDir), { workers: o.workers, config, quotaFile: dataPaths(o.dataDir).quotaFile }, o);
}
