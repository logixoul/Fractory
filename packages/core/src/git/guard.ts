import * as fs from "node:fs";
import * as path from "node:path";
import { isStrictlyInside as strictlyInside, normCase as norm } from "../util/pathx.js";
import { git, toplevel } from "./git.js";

/**
 * The only way fractory runs destructive git (§8.3): `reset --hard`, `clean -fdx` and
 * `worktree remove` go through these functions, which assert the realpath of the target is
 * strictly inside <dataDir>/worktrees/, is not the main repo or one of its ancestors, and is
 * the top level of a git worktree.
 */
export class GuardError extends Error {
  constructor(message: string) {
    super(`guarded git refused: ${message}`);
    this.name = "GuardError";
  }
}

export interface GuardContext {
  dataDir: string;
  /** The user's repository (never touched destructively). */
  mainRepo: string;
}

function realpathOrThrow(p: string, what: string): string {
  try {
    return fs.realpathSync.native(p);
  } catch {
    throw new GuardError(`${what} does not exist: ${p}`);
  }
}

/** Returns the canonical target if it is a legal destructive-git target; throws otherwise. */
export function assertWorktreeTarget(target: string, ctx: GuardContext): string {
  const t = realpathOrThrow(path.resolve(target), "target");
  const root = realpathOrThrow(path.join(ctx.dataDir, "worktrees"), "worktrees root");
  if (!strictlyInside(t, root)) throw new GuardError(`${t} is not strictly inside ${root}`);
  let repo: string | undefined;
  try {
    repo = fs.realpathSync.native(ctx.mainRepo);
  } catch {
    repo = path.resolve(ctx.mainRepo);
  }
  if (norm(t) === norm(repo)) throw new GuardError(`${t} is the main repository`);
  if (strictlyInside(repo, t)) throw new GuardError(`${t} is an ancestor of the main repository`);
  return t;
}

async function assertWorktreeTop(t: string): Promise<void> {
  let top: string;
  try {
    top = await toplevel(t);
  } catch {
    throw new GuardError(`${t} is not a git worktree`);
  }
  if (norm(top) !== norm(t)) throw new GuardError(`${t} is not the top level of its worktree (${top})`);
}

export async function guardedResetHard(target: string, sha: string, ctx: GuardContext): Promise<void> {
  const t = assertWorktreeTarget(target, ctx);
  await assertWorktreeTop(t);
  if (!/^[0-9a-f]{7,64}$/i.test(sha)) throw new GuardError(`not a commit sha: ${sha}`);
  await git(["reset", "--hard", "--quiet", sha], { cwd: t });
}

/** `git clean -fdx`, keeping `preserve` patterns (§8.15 preserveOnClean). Returns the removed paths. */
export async function guardedClean(target: string, ctx: GuardContext, preserve: readonly string[] = []): Promise<string[]> {
  const t = assertWorktreeTarget(target, ctx);
  await assertWorktreeTop(t);
  const excludes = preserve.flatMap((p) => ["-e", p]);
  const out = (await git(["clean", "-fdx", ...excludes], { cwd: t })).stdout.toString("utf8");
  return out
    .split("\n")
    .map((l) => l.replace(/^Removing /, "").trim())
    .filter(Boolean);
}

/** Reset + clean back to `sha`. Returns the paths the clean removed. */
export async function guardedRestore(target: string, sha: string, ctx: GuardContext, preserve: readonly string[] = []): Promise<string[]> {
  await guardedResetHard(target, sha, ctx);
  return guardedClean(target, ctx, preserve);
}

export async function guardedWorktreeRemove(target: string, ctx: GuardContext): Promise<void> {
  const t = assertWorktreeTarget(target, ctx);
  await git(["worktree", "remove", "--force", t], { cwd: ctx.mainRepo });
}
