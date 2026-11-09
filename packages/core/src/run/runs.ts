import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import { FRACTORY_VERSION } from "../version.js";
import { drive, type DriveOptions } from "../engine/drive.js";
import type { WorkflowDef } from "../engine/types.js";
import { toplevel } from "../git/git.js";
import { dataPaths } from "../paths.js";
import { Config } from "../schemas/config.js";
import type { Workflow } from "../schemas/run-events.js";
import type { RunState } from "../state/reducer.js";
import type { RunHandle, RunStore } from "../store/run-store.js";
import { newLabels, randomSeed } from "../util/random.js";
import type { Worker } from "../workers/types.js";
import { consensusWorkflow } from "../workflows/consensus.js";

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
    labels: newLabels(o.config.roles.contestants),
    roles: o.config.roles,
    seed: randomSeed(),
    config: JSON.parse(JSON.stringify(o.config)),
    fractoryVersion: FRACTORY_VERSION,
  });
  fs.writeFileSync(path.join(run.dir, "prompt.md"), prompt);
  return run;
}

/** The config a run was created with (resume never re-reads config files). */
export function runConfig(st: RunState): Config {
  return Config.parse(st.config);
}

export function workflowFor(st: RunState, dataDir: string): WorkflowDef {
  switch (st.workflow) {
    case "consensus":
      return consensusWorkflow({ dataDir });
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
