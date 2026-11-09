import * as fs from "node:fs";
import * as path from "node:path";
import { findRefs } from "@fractory/shared/refs";
import { isInside, normCase, toPosix } from "../util/pathx.js";

/**
 * `path:line` references in model prose (spec: consensus exit check). Accepted forms:
 * `src/a.ts:42`, `src/a.ts:42-50`, `src\a.ts:42`, `C:\…\repo\src\a.ts:42` (absolute, mapped to
 * repo-relative via the known roots) and markdown `src/a.ts#L42`.
 */
export interface Ref {
  /** As written. */
  raw: string;
  /** Repo-relative posix path (null if it could not be mapped). */
  path: string | null;
  line: number;
  endLine?: number;
}

export interface CheckedRefs {
  valid: Ref[];
  invalid: Ref[];
}

/** Refs as written (the extractor lives in @fractory/shared, also used by the GUI). */
export function extractRefs(text: string): (Omit<Ref, "path"> & { written: string })[] {
  return findRefs(text).map((r) => ({ raw: r.raw, written: r.path, line: r.line, ...(r.endLine !== undefined ? { endLine: r.endLine } : {}) }));
}

/** Maps a written path to repo-relative posix, using `roots` for absolute paths. */
export function toRepoRelative(written: string, roots: readonly string[]): string | null {
  const p = written.replace(/\\/g, "/");
  if (path.isAbsolute(written) || /^[A-Za-z]:\//.test(p)) {
    const abs = path.resolve(written);
    for (const r of roots) {
      if (isInside(abs, r)) {
        // Compare case-folded, but keep the original spelling of the tail.
        const relLen = path.relative(normCase(path.resolve(r)), normCase(abs)).length;
        return relLen === 0 ? null : toPosix(abs.slice(abs.length - relLen));
      }
    }
    return null;
  }
  const norm = path.posix.normalize(p.replace(/^\.\//, ""));
  if (norm.startsWith("../") || norm === "..") return null;
  return norm;
}

const lineCounts = new Map<string, number>();

function countLines(file: string): number | null {
  const key = file;
  const hit = lineCounts.get(key);
  if (hit !== undefined) return hit;
  try {
    const st = fs.statSync(file);
    if (!st.isFile()) return null;
    const text = fs.readFileSync(file, "utf8");
    const n = text === "" ? 0 : text.split("\n").length - (text.endsWith("\n") ? 1 : 0);
    if (lineCounts.size > 5000) lineCounts.clear();
    lineCounts.set(key, n);
    return n;
  } catch {
    return null;
  }
}

/**
 * Validates refs against a checkout (`root`, a worktree at the base commit). A ref is valid if
 * its file exists under root and its lines are within the file. Unique by path:line.
 */
export function checkRefs(text: string, root: string, extraRoots: readonly string[] = []): CheckedRefs {
  lineCounts.clear();
  const roots = [root, ...extraRoots];
  const seen = new Set<string>();
  const valid: Ref[] = [];
  const invalid: Ref[] = [];
  for (const r of extractRefs(text)) {
    const rel = toRepoRelative(r.written, roots);
    const { written: _w, ...rest } = r;
    const ref: Ref = { ...rest, path: rel };
    const key = `${rel ?? r.raw}:${r.line}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const n = rel === null ? null : countLines(path.join(root, rel));
    const last = r.endLine ?? r.line;
    if (n !== null && r.line >= 1 && last >= r.line && last <= n && isInside(path.resolve(root, rel!), root)) valid.push(ref);
    else invalid.push(ref);
  }
  return { valid, invalid };
}
