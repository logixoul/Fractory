import * as fs from "node:fs";
import { runProcess, tail, type RunResult } from "../util/proc.js";

const DEFAULT_TIMEOUT_MS = 5 * 60_000;

/** Flags on every git call: long paths on Windows, unquoted UTF-8 paths, no pager/colour. */
const BASE_FLAGS = ["-c", "core.longpaths=true", "-c", "core.quotepath=false", "-c", "color.ui=false", "--no-pager"];

export class GitError extends Error {
  constructor(
    readonly args: readonly string[],
    readonly result: RunResult,
  ) {
    super(
      `git ${args.join(" ")} failed (code ${result.code}, ${result.reason}): ${tail(result.stderr.toString("utf8").trim() || result.stdout.toString("utf8").trim(), 2000)}`,
    );
    this.name = "GitError";
  }
}

export interface GitOptions {
  cwd: string;
  stdin?: string | Buffer;
  timeoutMs?: number;
  signal?: AbortSignal;
  /** Return the result instead of throwing on a non-zero exit. */
  allowFail?: boolean;
  env?: NodeJS.ProcessEnv;
}

export function gitEnv(base: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  return {
    ...base,
    GIT_TERMINAL_PROMPT: "0",
    // `git status` must not rewrite the index: snapshots would otherwise perturb the repo.
    GIT_OPTIONAL_LOCKS: "0",
    LC_ALL: "C",
  };
}

/** Subcommands that can change the index or the set of worktrees (conservative allowlist). */
const INDEX_MUTATORS = new Set([
  "add", "commit", "reset", "clean", "checkout", "switch", "restore", "rm", "mv", "merge", "rebase",
  "cherry-pick", "revert", "stash", "apply", "am", "pull", "read-tree", "update-index", "worktree",
]);

let mutationEpoch = 0;

/** Bumps whenever fractory itself runs a git command that may change a tree's tracked files. */
export function gitMutationEpoch(): number {
  return mutationEpoch;
}

function firstSubcommand(args: readonly string[]): string | undefined {
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "-c") i++;
    else if (!args[i]!.startsWith("-")) return args[i];
  }
  return undefined;
}

export async function git(args: readonly string[], o: GitOptions): Promise<RunResult> {
  const sub = firstSubcommand(args);
  const mutates = sub !== undefined && INDEX_MUTATORS.has(sub);
  if (mutates) mutationEpoch++;
  try {
    return await gitInner(args, o);
  } finally {
    if (mutates) mutationEpoch++;
  }
}

async function gitInner(args: readonly string[], o: GitOptions): Promise<RunResult> {
  const r = await runProcess({
    command: "git",
    args: [...BASE_FLAGS, ...args],
    cwd: o.cwd,
    env: gitEnv(o.env),
    timeoutMs: o.timeoutMs ?? DEFAULT_TIMEOUT_MS,
    ...(o.stdin !== undefined ? { stdin: o.stdin } : {}),
    ...(o.signal ? { signal: o.signal } : {}),
  });
  if (!o.allowFail && (r.reason !== "exit" || r.code !== 0)) throw new GitError(args, r);
  return r;
}

export async function gitText(args: readonly string[], o: GitOptions): Promise<string> {
  return (await git(args, o)).stdout.toString("utf8");
}

export async function revParse(cwd: string, rev = "HEAD"): Promise<string> {
  return (await gitText(["rev-parse", "--verify", `${rev}^{commit}`], { cwd })).trim();
}

export async function toplevel(cwd: string): Promise<string> {
  return fs.realpathSync.native((await gitText(["rev-parse", "--show-toplevel"], { cwd })).trim());
}

export async function isRepoRoot(dir: string): Promise<boolean> {
  try {
    return (await toplevel(dir)) === fs.realpathSync.native(dir);
  } catch {
    return false;
  }
}

/**
 * Hook- and signing-free orchestrator commit (§8.17). Always `git add -A` first.
 * Returns the new HEAD sha.
 */
export async function commitAll(
  worktree: string,
  o: { emptyHooksDir: string; message: string; allowEmpty?: boolean },
): Promise<string> {
  fs.mkdirSync(o.emptyHooksDir, { recursive: true });
  await git(["add", "-A"], { cwd: worktree });
  await git(
    [
      "-c",
      `core.hooksPath=${o.emptyHooksDir}`,
      "-c",
      "commit.gpgsign=false",
      "-c",
      "user.name=fractory",
      "-c",
      "user.email=fractory@localhost",
      "commit",
      "--no-verify",
      "--no-gpg-sign",
      "--quiet",
      ...(o.allowEmpty ? ["--allow-empty"] : []),
      "-m",
      o.message,
    ],
    {
      cwd: worktree,
      // Author and committer are both fractory, whatever the user's env says.
      env: {
        ...process.env,
        GIT_AUTHOR_NAME: "fractory",
        GIT_AUTHOR_EMAIL: "fractory@localhost",
        GIT_COMMITTER_NAME: "fractory",
        GIT_COMMITTER_EMAIL: "fractory@localhost",
      },
    },
  );
  return revParse(worktree);
}

/**
 * Squashed diff of a worker branch against the base (judge/report input, §8 minor).
 * CRLF never produces whole-file diffs; binaries show as "Binary files … differ".
 */
export async function squashedDiff(worktree: string, base: string, head = "HEAD"): Promise<string> {
  return gitText(
    ["-c", "core.autocrlf=false", "diff", "--no-ext-diff", "--no-textconv", "--ignore-cr-at-eol", "--find-renames", `${base}..${head}`],
    { cwd: worktree },
  );
}

/** Repo-relative paths changed between base and head. */
export async function changedFiles(worktree: string, base: string, head = "HEAD"): Promise<string[]> {
  const out = await gitText(["-c", "core.autocrlf=false", "diff", "--name-only", "-z", `${base}..${head}`], { cwd: worktree });
  return out.split("\0").filter(Boolean);
}
