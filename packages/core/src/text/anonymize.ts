import { normCase } from "../util/pathx.js";

/**
 * Judge-input anonymization (§8.16). Prose only: proposals, critiques, revisions, commit
 * messages. Code inside diffs is never passed through here.
 */
export interface Scrubber {
  patterns: RegExp[];
  replacement: string;
}

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** Configured patterns plus every model id (requested and resolved), longest literal first. */
export function buildScrubber(patterns: readonly string[], modelIds: readonly string[], replacement: string): Scrubber {
  const ids = [...new Set(modelIds.filter((m) => m.length >= 3))].sort((a, b) => b.length - a.length);
  const literal = ids.map((id) => new RegExp(`(?<![\\w-])${escapeRe(id)}(?![\\w-])`, "gi"));
  return { patterns: [...literal, ...patterns.map((p) => new RegExp(p, "gi"))], replacement };
}

export function scrubProse(text: string, s: Scrubber): { text: string; replacements: number } {
  let out = text;
  let n = 0;
  for (const re of s.patterns) {
    out = out.replace(re, () => {
      n++;
      return s.replacement;
    });
  }
  return { text: out, replacements: n };
}

/** Pattern hits (and forbidden literal strings, e.g. data-dir paths) still present after scrubbing. */
export function leakCheck(text: string, s: Scrubber, forbidden: readonly string[] = []): string[] {
  const hits: string[] = [];
  for (const re of s.patterns) {
    re.lastIndex = 0;
    if (re.test(text)) hits.push(re.source);
    re.lastIndex = 0;
  }
  const t = normCase(text.replace(/\\/g, "/"));
  for (const f of forbidden) if (f && t.includes(normCase(f.replace(/\\/g, "/")))) hits.push(`literal:${f}`);
  return hits;
}

/**
 * Rewrites absolute paths under any of `roots` to repo-relative (both separator styles,
 * case-insensitive where the filesystem is), so no worktree path (label, data-dir layout)
 * reaches the judge.
 */
export function relativizePaths(text: string, roots: readonly string[]): string {
  let out = text;
  for (const root of [...roots].sort((a, b) => b.length - a.length)) {
    for (const variant of new Set([root, root.replace(/\\/g, "/"), root.replace(/\//g, "\\")])) {
      const re = new RegExp(`${escapeRe(variant)}[\\\\/]`, process.platform === "linux" ? "g" : "gi");
      out = out.replace(re, "");
    }
  }
  return out;
}
