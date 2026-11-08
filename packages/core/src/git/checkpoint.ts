import { commitAll } from "./git.js";
import { guardedRestore, type GuardContext } from "./guard.js";

/**
 * Edit-step checkpoints (§8.8). At step start the worktree state is committed (allow-empty)
 * and the sha recorded in a checkpoint_created event; a retry restores it via the guard.
 * Messages carry only the neutral step id, never a worker identity (§8.16).
 */
export function checkpoint(worktree: string, stepId: string, emptyHooksDir: string): Promise<string> {
  return commitAll(worktree, { emptyHooksDir, message: `fractory: checkpoint ${stepId}`, allowEmpty: true });
}

export function commitStepResult(worktree: string, stepId: string, emptyHooksDir: string): Promise<string> {
  return commitAll(worktree, { emptyHooksDir, message: `fractory: ${stepId} result`, allowEmpty: true });
}

/** Retry/violation path: back to the checkpoint, untracked and ignored files removed (except preserved). */
export function restoreCheckpoint(worktree: string, sha: string, ctx: GuardContext, preserve: readonly string[] = []): Promise<string[]> {
  return guardedRestore(worktree, sha, ctx, preserve);
}
