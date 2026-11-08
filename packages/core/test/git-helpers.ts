import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { tmpDir } from "./helpers.js";

/** Synchronous git for test setup only (the code under test uses the async runner). */
export function g(cwd: string, ...args: string[]): string {
  const r = spawnSync("git", ["-c", "user.name=test", "-c", "user.email=test@test", "-c", "commit.gpgsign=false", ...args], {
    cwd,
    encoding: "utf8",
  });
  if (r.status !== 0) throw new Error(`git ${args.join(" ")}: ${r.stderr}`);
  return r.stdout;
}

/** A repo with one commit, LF line endings regardless of the machine's autocrlf. */
export function initRepo(files: Record<string, string> = { "math.js": "export const add = (a, b) => a + b;\n" }): string {
  const repo = fs.realpathSync.native(tmpDir("fractory-repo-"));
  g(repo, "init", "-q", "-b", "main");
  g(repo, "config", "core.autocrlf", "false");
  for (const [p, c] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(repo, p)), { recursive: true });
    fs.writeFileSync(path.join(repo, p), c);
  }
  g(repo, "add", "-A");
  g(repo, "commit", "-q", "-m", "init");
  return repo;
}

export function dataDir(): string {
  const d = fs.realpathSync.native(tmpDir("fractory-data-"));
  fs.mkdirSync(path.join(d, "worktrees"), { recursive: true });
  return d;
}
