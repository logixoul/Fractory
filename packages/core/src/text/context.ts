import { createHash } from "node:crypto";
import { git } from "../git/git.js";

/**
 * Project-context parity (§6): both harnesses load no project context themselves; the
 * orchestrator injects the same text into every prompt. Files are read from the base commit
 * (not the working tree), so both workers see identical bytes.
 */
export interface ProjectContext {
  text: string;
  files: { path: string; sha256: string; bytes: number; truncated: boolean }[];
}

const MAX_FILE_BYTES = 64 * 1024;

export async function loadProjectContext(repo: string, base: string, files: readonly string[]): Promise<ProjectContext> {
  const parts: string[] = [];
  const meta: ProjectContext["files"] = [];
  for (const f of files) {
    const r = await git(["show", `${base}:${f.replace(/\\/g, "/")}`], { cwd: repo, allowFail: true });
    if (r.code !== 0) continue;
    const buf = r.stdout;
    const truncated = buf.length > MAX_FILE_BYTES;
    const body = buf.subarray(0, MAX_FILE_BYTES).toString("utf8");
    meta.push({ path: f, sha256: createHash("sha256").update(buf).digest("hex"), bytes: buf.length, truncated });
    parts.push(`### ${f}\n\n${body}${truncated ? "\n\n[truncated by the orchestrator]" : ""}`);
  }
  const text = parts.length
    ? `## Project guidelines\n\nThe repository's own guideline files, provided by the orchestrator:\n\n${parts.join("\n\n")}\n`
    : "";
  return { text, files: meta };
}
