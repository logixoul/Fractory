import * as fs from "node:fs";
import * as path from "node:path";
import { normCase } from "../util/pathx.js";
import { git, gitText, revParse } from "./git.js";

/** Neutral names (§8.16): the label→worker mapping lives only in run state. */
export function worktreePath(dataDir: string, runId: string, label: string): string {
  return path.join(dataDir, "worktrees", runId, label);
}

export function worktreeBranch(runId: string, label: string): string {
  return `fractory/${runId}/${label}`;
}

export interface WorktreeInfo {
  path: string;
  branch: string;
  /** HEAD sha after creation (= base for a fresh worktree). */
  head: string;
}

interface ListedWorktree {
  path: string;
  head?: string;
  branch?: string;
}

export async function listWorktrees(repo: string): Promise<ListedWorktree[]> {
  const out = await gitText(["worktree", "list", "--porcelain", "-z"], { cwd: repo });
  const result: ListedWorktree[] = [];
  let cur: ListedWorktree | undefined;
  for (const field of out.split("\0")) {
    if (field === "") {
      if (cur) result.push(cur);
      cur = undefined;
      continue;
    }
    const sp = field.indexOf(" ");
    const key = sp < 0 ? field : field.slice(0, sp);
    const val = sp < 0 ? "" : field.slice(sp + 1);
    if (key === "worktree") cur = { path: path.resolve(val) };
    else if (cur && key === "HEAD") cur.head = val;
    else if (cur && key === "branch") cur.branch = val.replace(/^refs\/heads\//, "");
  }
  if (cur) result.push(cur);
  return result;
}

/**
 * Creates (or, on resume, reuses) the worktree <dataDir>/worktrees/<run>/<label> on branch
 * fractory/<run>/<label> starting at `base`. Idempotent: an existing worktree on the
 * expected branch is returned as is.
 */
export async function ensureWorktree(o: { repo: string; dataDir: string; runId: string; label: string; base: string }): Promise<WorktreeInfo> {
  const wt = worktreePath(o.dataDir, o.runId, o.label);
  const branch = worktreeBranch(o.runId, o.label);
  const existing = (await listWorktrees(o.repo)).find((w) => fs.existsSync(w.path) && normCase(fs.realpathSync.native(w.path)) === normCase(realOrSelf(wt)));
  if (existing) {
    if (existing.branch !== branch) throw new Error(`worktree ${wt} exists on branch ${existing.branch ?? "(detached)"}, expected ${branch}`);
    return { path: wt, branch, head: await revParse(wt) };
  }
  if (fs.existsSync(wt) && fs.readdirSync(wt).length > 0) throw new Error(`${wt} exists and is not a worktree of ${o.repo}`);
  fs.mkdirSync(path.dirname(wt), { recursive: true });
  const hasBranch = (await git(["rev-parse", "--verify", "--quiet", `refs/heads/${branch}`], { cwd: o.repo, allowFail: true })).code === 0;
  const args = hasBranch ? ["worktree", "add", wt, branch] : ["worktree", "add", "-b", branch, wt, o.base];
  try {
    await git(args, { cwd: o.repo });
  } catch (e) {
    // A stale registration (directory deleted behind git's back) is recovered by one prune + retry.
    await git(["worktree", "prune"], { cwd: o.repo });
    try {
      await git(args, { cwd: o.repo });
    } catch {
      throw e;
    }
  }
  // Only a freshly created branch is known to sit at `base`; an existing branch may have advanced.
  return { path: wt, branch, head: hasBranch ? await revParse(wt) : o.base };
}

function realOrSelf(p: string): string {
  try {
    return fs.realpathSync.native(p);
  } catch {
    return path.resolve(p);
  }
}
