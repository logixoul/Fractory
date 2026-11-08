import * as fs from "node:fs";
import * as path from "node:path";
import type { FileChange } from "../schemas/run-events.js";
import { isInside } from "../util/pathx.js";
import { git, gitText } from "./git.js";

/**
 * Content-aware snapshot of a working tree (§8.13): every path `git status` reports
 * (modified, untracked, ignored) with its XY code and a content hash. Equality of two
 * snapshots is the read-only gate (§8.4) and the out-of-worktree write detector (§8.2).
 *
 * Blind spots (documented): changes inside `excludeDirs`, and same-size same-mtime changes
 * to ignored files larger than `maxIgnoredFileBytes`.
 */
export interface SnapshotOptions {
  maxIgnoredFileBytes: number;
  excludeDirs: readonly string[];
}

export interface SnapshotLink {
  path: string;
  target: string;
  /** Resolved target is outside the snapshot root. */
  outside: boolean;
}

export interface Snapshot {
  root: string;
  /** repo-relative posix path → "<XY> <content>" where content is a hash, "deleted", "dir", or "size:<n>:mtime:<ms>". */
  entries: Record<string, string>;
  links: SnapshotLink[];
}

interface StatusEntry {
  xy: string;
  path: string;
}

/** Parses `git status --porcelain=v1 -z`. Renames/copies carry the original path as an extra field. */
export function parsePorcelainZ(out: string): StatusEntry[] {
  const fields = out.split("\0");
  const result: StatusEntry[] = [];
  for (let i = 0; i < fields.length; i++) {
    const f = fields[i]!;
    if (f.length < 4) continue;
    const xy = f.slice(0, 2);
    result.push({ xy, path: f.slice(3) });
    if (xy[0] === "R" || xy[0] === "C") i++; // skip the original path
  }
  return result;
}

const HASH_BATCH = 500;

async function hashFiles(root: string, rels: string[]): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  for (let i = 0; i < rels.length; i += HASH_BATCH) {
    const batch = rels.slice(i, i + HASH_BATCH);
    const text = await gitText(["hash-object", "--no-filters", "--stdin-paths"], { cwd: root, stdin: batch.join("\n") + "\n" });
    const hashes = text.split("\n").filter(Boolean);
    if (hashes.length !== batch.length) throw new Error(`git hash-object returned ${hashes.length} hashes for ${batch.length} paths`);
    batch.forEach((p, j) => out.set(p, hashes[j]!));
  }
  return out;
}

function linkInfo(root: string, rel: string): SnapshotLink | undefined {
  const abs = path.join(root, rel);
  let st: fs.Stats;
  try {
    st = fs.lstatSync(abs);
  } catch {
    return undefined;
  }
  if (!st.isSymbolicLink()) return undefined;
  let target: string;
  try {
    target = fs.realpathSync.native(abs);
  } catch {
    target = path.resolve(path.dirname(abs), fs.readlinkSync(abs));
  }
  return { path: rel, target, outside: !isInside(target, fs.realpathSync.native(root)) };
}

export async function takeSnapshot(dir: string, o: SnapshotOptions): Promise<Snapshot> {
  const root = fs.realpathSync.native(dir);
  const status = await gitText(["status", "--porcelain=v1", "-z", "--ignored=matching", "--untracked-files=all"], { cwd: root });
  const entries: Record<string, string> = {};
  const toHash: { rel: string; xy: string }[] = [];
  const links = new Map<string, SnapshotLink>();
  const excluded = new Set(o.excludeDirs);
  const isExcluded = (rel: string) => rel.split("/").some((seg) => excluded.has(seg));

  const addFile = (rel: string, xy: string, st: fs.Stats) => {
    if (xy === "!!" && st.size > o.maxIgnoredFileBytes) entries[rel] = `${xy} size:${st.size}:mtime:${Math.trunc(st.mtimeMs)}`;
    else toHash.push({ rel, xy });
  };

  const walkIgnoredDir = (relDir: string) => {
    for (const d of fs.readdirSync(path.join(root, relDir), { withFileTypes: true })) {
      const rel = `${relDir}/${d.name}`;
      if (d.isSymbolicLink()) {
        const l = linkInfo(root, rel);
        if (l) links.set(rel, l);
        entries[rel] = `!! link:${l?.target ?? "?"}`;
      } else if (d.isDirectory()) {
        if (excluded.has(d.name)) entries[`${rel}/`] = "!! dir";
        else walkIgnoredDir(rel);
      } else if (d.isFile()) {
        addFile(rel, "!!", fs.statSync(path.join(root, rel)));
      }
    }
  };

  for (const e of parsePorcelainZ(status)) {
    const rel = e.path;
    const isDir = rel.endsWith("/");
    const clean = isDir ? rel.slice(0, -1) : rel;
    const link = linkInfo(root, clean);
    if (link) {
      links.set(clean, link);
      entries[clean] = `${e.xy} link:${link.target}`;
      continue;
    }
    if (isDir) {
      if (e.xy === "!!" && !isExcluded(clean)) walkIgnoredDir(clean);
      else entries[rel] = `${e.xy} dir`;
      continue;
    }
    let st: fs.Stats | undefined;
    try {
      st = fs.statSync(path.join(root, rel));
    } catch {
      st = undefined;
    }
    if (!st) entries[rel] = `${e.xy} deleted`;
    else if (st.isDirectory()) entries[rel] = `${e.xy} dir`; // e.g. a nested repo / submodule
    else addFile(rel, e.xy, st);
  }

  const hashes = await hashFiles(root, toHash.map((t) => t.rel));
  for (const t of toHash) entries[t.rel] = `${t.xy} ${hashes.get(t.rel)}`;

  // Tracked symlinks never appear in status when unchanged; list them too (§2 residual).
  const ls = await gitText(["ls-files", "-s", "-z"], { cwd: root });
  for (const rec of ls.split("\0")) {
    if (!rec.startsWith("120000 ")) continue;
    const rel = rec.slice(rec.indexOf("\t") + 1);
    const l = linkInfo(root, rel);
    if (l) links.set(rel, l);
  }
  return { root, entries: sortKeys(entries), links: [...links.values()].sort((a, b) => a.path.localeCompare(b.path)) };
}

function sortKeys(r: Record<string, string>): Record<string, string> {
  return Object.fromEntries(Object.entries(r).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)));
}

/** Differences between two snapshots of the same tree (empty = equal). */
export function diffSnapshots(before: Snapshot, after: Snapshot): FileChange[] {
  const keys = new Set([...Object.keys(before.entries), ...Object.keys(after.entries)]);
  const out: FileChange[] = [];
  for (const k of [...keys].sort()) {
    const a = before.entries[k] ?? null;
    const b = after.entries[k] ?? null;
    if (a !== b) out.push({ path: k, before: a, after: b });
  }
  return out;
}

/** Symlinks/junctions in a worktree that point outside it: a step must not start (§2 residual). */
export function escapingLinks(s: Snapshot): SnapshotLink[] {
  return s.links.filter((l) => l.outside);
}

/** True if the tree has no tracked or untracked changes against HEAD (ignored files allowed). */
export async function isClean(dir: string): Promise<boolean> {
  return (await git(["status", "--porcelain=v1", "-z", "--untracked-files=all"], { cwd: dir })).stdout.length === 0;
}
